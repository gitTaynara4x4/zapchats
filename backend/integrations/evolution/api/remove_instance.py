# backend/integrations/evolution/api/remove_instance.py
from __future__ import annotations

import logging
import os

import backend.models as models
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from backend.database import get_db_session
from backend.routers.auth import get_current_identity

log = logging.getLogger(__name__)

router = APIRouter(prefix="/empresas", tags=["WhatsApp / Instâncias"])

USE_DB_CASCADE_DEFAULT = (os.getenv("USE_DB_CASCADE", "true").lower() == "true")
EVOLUTION_URL = (os.getenv("EVOLUTION_URL") or "").rstrip("/")
EVOLUTION_KEY = os.getenv("EVOLUTION_APIKEY") or os.getenv("EVOLUTION_KEY")


def _ensure_same_company(identity: dict, empresa_id: int) -> None:
    if int(identity.get("empresa_id")) != int(empresa_id):
        raise HTTPException(status_code=403, detail="Proibido")


def _lock_instance_for_update(
    db: Session,
    *,
    by_id: int | None = None,
    by_slug: str | None = None,
) -> models.EmpresaInstancia:
    if by_id is not None:
        stmt = (
            select(models.EmpresaInstancia)
            .where(models.EmpresaInstancia.id == int(by_id))
            .with_for_update()
        )
    elif by_slug is not None:
        stmt = (
            select(models.EmpresaInstancia)
            .where(models.EmpresaInstancia.instance_name == str(by_slug))
            .with_for_update()
        )
    else:
        raise HTTPException(status_code=400, detail="Parâmetro inválido")

    inst = db.execute(stmt).scalars().first()
    if not inst:
        raise HTTPException(status_code=404, detail="Instância não encontrada")
    return inst


def _has_bound_data(db: Session, instancia_id: int) -> bool:
    iid = int(instancia_id)

    checks = [
        ("mensagens", "SELECT 1 FROM mensagens WHERE instancia_id = :iid LIMIT 1"),
        ("midias", "SELECT 1 FROM midias WHERE instancia_id = :iid LIMIT 1"),
        ("clientes", "SELECT 1 FROM clientes WHERE instancia_id = :iid LIMIT 1"),
        ("grupos", "SELECT 1 FROM grupos WHERE instancia_id = :iid LIMIT 1"),
        ("atendimentos", "SELECT 1 FROM atendimentos WHERE instancia_id = :iid LIMIT 1"),
        ("chatbot_configs", "SELECT 1 FROM chatbot_configs WHERE instancia_id = :iid LIMIT 1"),
        ("mensagens_grupo", "SELECT 1 FROM mensagens_grupo WHERE instancia_id = :iid LIMIT 1"),
    ]
    for _, sql in checks:
        row = db.execute(text(sql), {"iid": iid}).first()
        if row:
            return True

    row = db.execute(
        text(
            """
            SELECT 1
            FROM mensagens_grupo
            WHERE grupo_id IN (SELECT id FROM grupos WHERE instancia_id = :iid)
            LIMIT 1
            """
        ),
        {"iid": iid},
    ).first()
    if row:
        return True

    row = db.execute(
        text(
            """
            SELECT 1
            FROM midias
            WHERE mensagem_id IN (SELECT id FROM mensagens WHERE instancia_id = :iid)
            LIMIT 1
            """
        ),
        {"iid": iid},
    ).first()
    return bool(row)


def _delete_remote_evolution(instance_name: str) -> None:
    if not (EVOLUTION_URL and EVOLUTION_KEY and instance_name):
        return

    try:
        import requests
    except Exception:
        return

    headers = {"apikey": EVOLUTION_KEY, "Content-Type": "application/json"}
    sess = requests.Session()
    sess.headers.update(headers)

    attempts = [
        ("DELETE", f"{EVOLUTION_URL}/instance/delete/{instance_name}", None),
        ("DELETE", f"{EVOLUTION_URL}/instances/delete/{instance_name}", None),
        ("POST", f"{EVOLUTION_URL}/instance/delete/{instance_name}", None),
        ("POST", f"{EVOLUTION_URL}/instance/delete", {"instanceName": instance_name}),
        ("POST", f"{EVOLUTION_URL}/instances/delete", {"instance": instance_name}),
    ]

    for method, url, body in attempts:
        try:
            if method == "DELETE":
                resp = sess.delete(url, timeout=15)
            else:
                resp = sess.post(url, json=body, timeout=15)

            if resp.status_code in (200, 202, 204, 404):
                return
        except Exception:
            pass


def _recalc_empresa_counter(db: Session, empresa_id: int) -> int:
    total_restantes = (
        db.query(models.EmpresaInstancia)
        .filter(models.EmpresaInstancia.empresa_id == int(empresa_id))
        .count()
    )
    emp = db.query(models.Empresa).filter(models.Empresa.id == int(empresa_id)).first()
    if emp and hasattr(emp, "quantidade_instancias"):
        emp.quantidade_instancias = total_restantes
    return total_restantes


def _remover_instancia_tx(
    db: Session,
    inst: models.EmpresaInstancia,
    *,
    cascade: bool,
    force: bool,
    delete_remote: bool,
):
    empresa_id = int(inst.empresa_id)
    instancia_id = int(inst.id)

    if _has_bound_data(db, instancia_id) and not force:
        raise HTTPException(
            status_code=409,
            detail=(
                "Instância possui dados vinculados (mensagens, mídias, clientes ou grupos). "
                "Use force=1 para remover mesmo assim."
            ),
        )

    try:
        if cascade:
            db.delete(inst)
            restantes = _recalc_empresa_counter(db, empresa_id)
            db.commit()
        else:
            db.execute(
                text(
                    """
                    DELETE FROM midias
                    WHERE mensagem_id IN (
                        SELECT id FROM mensagens WHERE instancia_id = :instancia_id
                    )
                    """
                ),
                {"instancia_id": instancia_id},
            )

            db.execute(
                text("DELETE FROM mensagens WHERE instancia_id = :instancia_id"),
                {"instancia_id": instancia_id},
            )

            db.execute(
                text("DELETE FROM midias WHERE instancia_id = :instancia_id"),
                {"instancia_id": instancia_id},
            )

            db.execute(
                text(
                    """
                    DELETE FROM mensagens_grupo
                    WHERE instancia_id = :instancia_id
                       OR grupo_id IN (
                            SELECT id FROM grupos WHERE instancia_id = :instancia_id
                       )
                    """
                ),
                {"instancia_id": instancia_id},
            )

            db.execute(
                text("DELETE FROM grupos WHERE instancia_id = :instancia_id"),
                {"instancia_id": instancia_id},
            )

            db.execute(
                text("DELETE FROM atendimentos WHERE instancia_id = :instancia_id"),
                {"instancia_id": instancia_id},
            )

            db.execute(
                text(
                    """
                    DELETE FROM chatbot_configs
                    WHERE empresa_id = :empresa_id
                      AND instancia_id = :instancia_id
                    """
                ),
                {"empresa_id": empresa_id, "instancia_id": instancia_id},
            )

            db.execute(
                text(
                    """
                    DELETE FROM clientes
                    WHERE empresa_id = :empresa_id
                      AND instancia_id = :instancia_id
                    """
                ),
                {"empresa_id": empresa_id, "instancia_id": instancia_id},
            )

            db.delete(inst)
            restantes = _recalc_empresa_counter(db, empresa_id)
            db.commit()

        if delete_remote and inst.instance_name:
            try:
                _delete_remote_evolution(inst.instance_name)
            except Exception:
                pass

        return {
            "ok": True,
            "apagado": True,
            "restantes": restantes,
            "instancia_id": instancia_id,
            "instance_name": inst.instance_name,
        }

    except HTTPException:
        try:
            db.rollback()
        except Exception:
            pass
        raise
    except Exception as e:
        try:
            db.rollback()
        except Exception:
            pass
        log.exception("Falha ao remover instância %s", instancia_id)
        raise HTTPException(status_code=500, detail="Falha ao remover") from e


@router.delete("/instancias/{instancia_id}")
def remover_por_id(
    instancia_id: int,
    cascade: bool | None = Query(default=None),
    force: bool = Query(default=False),
    delete_remote: bool = Query(default=False),
    db: Session = Depends(get_db_session),
    identity: dict = Depends(get_current_identity),
):
    inst = _lock_instance_for_update(db, by_id=instancia_id)
    _ensure_same_company(identity, inst.empresa_id)

    cascade_flag = USE_DB_CASCADE_DEFAULT if cascade is None else bool(cascade)
    return _remover_instancia_tx(
        db,
        inst,
        cascade=cascade_flag,
        force=bool(force),
        delete_remote=bool(delete_remote),
    )


@router.delete("/whatsapp/{instance_name}")
def remover_por_slug(
    instance_name: str,
    cascade: bool | None = Query(default=None),
    force: bool = Query(default=False),
    delete_remote: bool = Query(default=False),
    db: Session = Depends(get_db_session),
    identity: dict = Depends(get_current_identity),
):
    inst = _lock_instance_for_update(db, by_slug=instance_name)
    _ensure_same_company(identity, inst.empresa_id)

    cascade_flag = USE_DB_CASCADE_DEFAULT if cascade is None else bool(cascade)
    return _remover_instancia_tx(
        db,
        inst,
        cascade=cascade_flag,
        force=bool(force),
        delete_remote=bool(delete_remote),
    )


__all__ = [
    "router",
]