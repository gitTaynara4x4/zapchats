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

USE_DB_CASCADE_DEFAULT = os.getenv("USE_DB_CASCADE", "true").lower() == "true"
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
        (
            "mensagens",
            """
            SELECT 1
            FROM mensagens
            WHERE instancia_id = :iid
            LIMIT 1
            """,
        ),
        (
            "midias",
            """
            SELECT 1
            FROM midias
            WHERE instancia_id = :iid
            LIMIT 1
            """,
        ),
        (
            "clientes",
            """
            SELECT 1
            FROM clientes
            WHERE instancia_id = :iid
            LIMIT 1
            """,
        ),
        (
            "grupos",
            """
            SELECT 1
            FROM grupos
            WHERE instancia_id = :iid
            LIMIT 1
            """,
        ),
        (
            "atendimentos",
            """
            SELECT 1
            FROM atendimentos
            WHERE instancia_id = :iid
            LIMIT 1
            """,
        ),
        (
            "chatbot_configs",
            """
            SELECT 1
            FROM chatbot_configs
            WHERE instancia_id = :iid
            LIMIT 1
            """,
        ),
        (
            "mensagens_grupo",
            """
            SELECT 1
            FROM mensagens_grupo
            WHERE instancia_id = :iid
            LIMIT 1
            """,
        ),
        (
            "departamentos_instancias",
            """
            SELECT 1
            FROM departamentos_instancias
            WHERE instancia_id = :iid
            LIMIT 1
            """,
        ),
        (
            "filas_instancias",
            """
            SELECT 1
            FROM filas_instancias
            WHERE instancia_id = :iid
            LIMIT 1
            """,
        ),
        (
            "atendimento_pinned_conversas",
            """
            SELECT 1
            FROM atendimento_pinned_conversas
            WHERE instancia_id = :iid
            LIMIT 1
            """,
        ),
        (
            "disparos",
            """
            SELECT 1
            FROM disparos
            WHERE instancia_id = :iid
            LIMIT 1
            """,
        ),
    ]

    for _, sql in checks:
        row = db.execute(text(sql), {"iid": iid}).first()
        if row:
            return True

    # Mensagens ligadas aos clientes da instância,
    # mesmo quando mensagens.instancia_id está NULL ou diferente.
    row = db.execute(
        text(
            """
            SELECT 1
            FROM mensagens
            WHERE cliente_id IN (
                SELECT id
                FROM clientes
                WHERE instancia_id = :iid
            )
            LIMIT 1
            """
        ),
        {"iid": iid},
    ).first()
    if row:
        return True

    # Mídias ligadas aos clientes da instância.
    row = db.execute(
        text(
            """
            SELECT 1
            FROM midias
            WHERE cliente_id IN (
                SELECT id
                FROM clientes
                WHERE instancia_id = :iid
            )
            LIMIT 1
            """
        ),
        {"iid": iid},
    ).first()
    if row:
        return True

    # Mídias ligadas às mensagens dos clientes da instância.
    row = db.execute(
        text(
            """
            SELECT 1
            FROM midias
            WHERE mensagem_id IN (
                SELECT id
                FROM mensagens
                WHERE instancia_id = :iid
                   OR cliente_id IN (
                        SELECT id
                        FROM clientes
                        WHERE instancia_id = :iid
                   )
            )
            LIMIT 1
            """
        ),
        {"iid": iid},
    ).first()
    if row:
        return True

    # Mensagens de grupo ligadas aos grupos da instância.
    row = db.execute(
        text(
            """
            SELECT 1
            FROM mensagens_grupo
            WHERE grupo_id IN (
                SELECT id
                FROM grupos
                WHERE instancia_id = :iid
            )
            LIMIT 1
            """
        ),
        {"iid": iid},
    ).first()
    if row:
        return True

    # Mídias ligadas aos grupos da instância.
    row = db.execute(
        text(
            """
            SELECT 1
            FROM midias
            WHERE grupo_id IN (
                SELECT id
                FROM grupos
                WHERE instancia_id = :iid
            )
            LIMIT 1
            """
        ),
        {"iid": iid},
    ).first()
    if row:
        return True

    # Mídias ligadas às mensagens de grupo da instância.
    row = db.execute(
        text(
            """
            SELECT 1
            FROM midias
            WHERE mensagem_grupo_id IN (
                SELECT id
                FROM mensagens_grupo
                WHERE instancia_id = :iid
                   OR grupo_id IN (
                        SELECT id
                        FROM grupos
                        WHERE instancia_id = :iid
                   )
            )
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


def _delete_local_bound_data(
    db: Session,
    *,
    empresa_id: int,
    instancia_id: int,
) -> None:
    """
    Remove todos os dados locais vinculados à instância.

    Ordem segura baseada no models.py:

    - atendimento_pinned_conversas depende de clientes/atendimentos/instância
    - atendimento_participantes depende de atendimentos
    - midias depende de clientes/mensagens/grupos/mensagens_grupo/instância
    - mensagens depende de clientes/atendimentos/instância
    - mensagens_grupo depende de grupos/instância
    - atendimentos depende de clientes/instância
    - grupos depende de instância
    - clientes depende de empresa/instância
    - pivôs dependem da instância
    """

    params = {
        "empresa_id": int(empresa_id),
        "instancia_id": int(instancia_id),
    }

    # ==========================================================
    # DISPAROS
    #
    # Mantém o histórico de disparos, mas solta vínculos com a
    # instância e com mídias que serão removidas.
    # ==========================================================
    db.execute(
        text(
            """
            UPDATE disparos
            SET midia_id = NULL
            WHERE midia_id IN (
                SELECT id
                FROM midias
                WHERE empresa_id = :empresa_id
                  AND (
                        instancia_id = :instancia_id
                        OR cliente_id IN (
                            SELECT id
                            FROM clientes
                            WHERE empresa_id = :empresa_id
                              AND instancia_id = :instancia_id
                        )
                        OR grupo_id IN (
                            SELECT id
                            FROM grupos
                            WHERE empresa_id = :empresa_id
                              AND instancia_id = :instancia_id
                        )
                        OR mensagem_id IN (
                            SELECT id
                            FROM mensagens
                            WHERE empresa_id = :empresa_id
                              AND (
                                    instancia_id = :instancia_id
                                    OR cliente_id IN (
                                        SELECT id
                                        FROM clientes
                                        WHERE empresa_id = :empresa_id
                                          AND instancia_id = :instancia_id
                                    )
                              )
                        )
                        OR mensagem_grupo_id IN (
                            SELECT id
                            FROM mensagens_grupo
                            WHERE empresa_id = :empresa_id
                              AND (
                                    instancia_id = :instancia_id
                                    OR grupo_id IN (
                                        SELECT id
                                        FROM grupos
                                        WHERE empresa_id = :empresa_id
                                          AND instancia_id = :instancia_id
                                    )
                              )
                        )
                  )
            )
            """
        ),
        params,
    )

    db.execute(
        text(
            """
            UPDATE disparos
            SET instancia_id = NULL
            WHERE empresa_id = :empresa_id
              AND instancia_id = :instancia_id
            """
        ),
        params,
    )

    # ==========================================================
    # PINS DE CONVERSA
    # ==========================================================
    db.execute(
        text(
            """
            DELETE FROM atendimento_pinned_conversas
            WHERE empresa_id = :empresa_id
              AND (
                    instancia_id = :instancia_id
                    OR conversa_id IN (
                        SELECT id
                        FROM clientes
                        WHERE empresa_id = :empresa_id
                          AND instancia_id = :instancia_id
                    )
                    OR atendimento_id IN (
                        SELECT id
                        FROM atendimentos
                        WHERE empresa_id = :empresa_id
                          AND (
                                instancia_id = :instancia_id
                                OR cliente_id IN (
                                    SELECT id
                                    FROM clientes
                                    WHERE empresa_id = :empresa_id
                                      AND instancia_id = :instancia_id
                                )
                          )
                    )
              )
            """
        ),
        params,
    )

    # ==========================================================
    # PARTICIPANTES DE ATENDIMENTO
    # ==========================================================
    db.execute(
        text(
            """
            DELETE FROM atendimento_participantes
            WHERE empresa_id = :empresa_id
              AND atendimento_id IN (
                    SELECT id
                    FROM atendimentos
                    WHERE empresa_id = :empresa_id
                      AND (
                            instancia_id = :instancia_id
                            OR cliente_id IN (
                                SELECT id
                                FROM clientes
                                WHERE empresa_id = :empresa_id
                                  AND instancia_id = :instancia_id
                            )
                      )
              )
            """
        ),
        params,
    )

    # ==========================================================
    # CHATBOT CONFIGS DA INSTÂNCIA
    # ==========================================================
    db.execute(
        text(
            """
            DELETE FROM chatbot_configs
            WHERE empresa_id = :empresa_id
              AND instancia_id = :instancia_id
            """
        ),
        params,
    )

    # ==========================================================
    # PIVÔS DE DEPARTAMENTO/INSTÂNCIA
    # ==========================================================
    db.execute(
        text(
            """
            DELETE FROM departamentos_instancias
            WHERE empresa_id = :empresa_id
              AND instancia_id = :instancia_id
            """
        ),
        params,
    )

    # ==========================================================
    # PIVÔS DE FILA/INSTÂNCIA
    # ==========================================================
    db.execute(
        text(
            """
            DELETE FROM filas_instancias
            WHERE empresa_id = :empresa_id
              AND instancia_id = :instancia_id
            """
        ),
        params,
    )

    # ==========================================================
    # REMOVE A INSTÂNCIA DO ARRAY colaboradores.instancias_ver
    # ==========================================================
    db.execute(
        text(
            """
            UPDATE colaboradores
            SET instancias_ver = array_remove(instancias_ver, :instancia_id)
            WHERE empresa_id = :empresa_id
              AND instancias_ver IS NOT NULL
            """
        ),
        params,
    )

    # ==========================================================
    # MÍDIAS VINCULADAS A MENSAGENS 1:1 / CLIENTES / INSTÂNCIA
    #
    # Precisa vir antes de apagar mensagens e clientes.
    # ==========================================================
    db.execute(
        text(
            """
            DELETE FROM midias
            WHERE empresa_id = :empresa_id
              AND (
                    instancia_id = :instancia_id
                    OR cliente_id IN (
                        SELECT id
                        FROM clientes
                        WHERE empresa_id = :empresa_id
                          AND instancia_id = :instancia_id
                    )
                    OR mensagem_id IN (
                        SELECT id
                        FROM mensagens
                        WHERE empresa_id = :empresa_id
                          AND (
                                instancia_id = :instancia_id
                                OR cliente_id IN (
                                    SELECT id
                                    FROM clientes
                                    WHERE empresa_id = :empresa_id
                                      AND instancia_id = :instancia_id
                                )
                                OR atendimento_id IN (
                                    SELECT id
                                    FROM atendimentos
                                    WHERE empresa_id = :empresa_id
                                      AND (
                                            instancia_id = :instancia_id
                                            OR cliente_id IN (
                                                SELECT id
                                                FROM clientes
                                                WHERE empresa_id = :empresa_id
                                                  AND instancia_id = :instancia_id
                                            )
                                      )
                                )
                          )
                    )
              )
            """
        ),
        params,
    )

    # ==========================================================
    # MÍDIAS VINCULADAS A GRUPOS / MENSAGENS DE GRUPO
    #
    # Corrige FK fk_midias_grupo:
    # midias.grupo_id -> grupos.id
    # ==========================================================
    db.execute(
        text(
            """
            DELETE FROM midias
            WHERE empresa_id = :empresa_id
              AND (
                    grupo_id IN (
                        SELECT id
                        FROM grupos
                        WHERE empresa_id = :empresa_id
                          AND instancia_id = :instancia_id
                    )
                    OR mensagem_grupo_id IN (
                        SELECT id
                        FROM mensagens_grupo
                        WHERE empresa_id = :empresa_id
                          AND (
                                instancia_id = :instancia_id
                                OR grupo_id IN (
                                    SELECT id
                                    FROM grupos
                                    WHERE empresa_id = :empresa_id
                                      AND instancia_id = :instancia_id
                                )
                          )
                    )
              )
            """
        ),
        params,
    )

    # ==========================================================
    # MENSAGENS 1:1
    #
    # Corrige FK mensagens_cliente_id_fkey:
    # mensagens.cliente_id -> clientes.id
    #
    # Apaga por:
    # - mensagens.instancia_id
    # - mensagens.cliente_id dos clientes da instância
    # - mensagens.atendimento_id dos atendimentos da instância/cliente
    # ==========================================================
    db.execute(
        text(
            """
            DELETE FROM mensagens
            WHERE empresa_id = :empresa_id
              AND (
                    instancia_id = :instancia_id
                    OR cliente_id IN (
                        SELECT id
                        FROM clientes
                        WHERE empresa_id = :empresa_id
                          AND instancia_id = :instancia_id
                    )
                    OR atendimento_id IN (
                        SELECT id
                        FROM atendimentos
                        WHERE empresa_id = :empresa_id
                          AND (
                                instancia_id = :instancia_id
                                OR cliente_id IN (
                                    SELECT id
                                    FROM clientes
                                    WHERE empresa_id = :empresa_id
                                      AND instancia_id = :instancia_id
                                )
                          )
                    )
              )
            """
        ),
        params,
    )

    # ==========================================================
    # MENSAGENS DE GRUPO
    #
    # Precisa vir antes de apagar grupos.
    # ==========================================================
    db.execute(
        text(
            """
            DELETE FROM mensagens_grupo
            WHERE empresa_id = :empresa_id
              AND (
                    instancia_id = :instancia_id
                    OR grupo_id IN (
                        SELECT id
                        FROM grupos
                        WHERE empresa_id = :empresa_id
                          AND instancia_id = :instancia_id
                    )
              )
            """
        ),
        params,
    )

    # ==========================================================
    # ATENDIMENTOS
    #
    # Precisa vir antes de apagar clientes.
    # ==========================================================
    db.execute(
        text(
            """
            DELETE FROM atendimentos
            WHERE empresa_id = :empresa_id
              AND (
                    instancia_id = :instancia_id
                    OR cliente_id IN (
                        SELECT id
                        FROM clientes
                        WHERE empresa_id = :empresa_id
                          AND instancia_id = :instancia_id
                    )
              )
            """
        ),
        params,
    )

    # ==========================================================
    # GRUPOS
    #
    # Agora pode apagar, porque midias e mensagens_grupo
    # já foram apagadas.
    # ==========================================================
    db.execute(
        text(
            """
            DELETE FROM grupos
            WHERE empresa_id = :empresa_id
              AND instancia_id = :instancia_id
            """
        ),
        params,
    )

    # ==========================================================
    # CLIENTES
    #
    # Agora pode apagar, porque mensagens, mídias, atendimentos
    # e pins já foram apagados.
    # ==========================================================
    db.execute(
        text(
            """
            DELETE FROM clientes
            WHERE empresa_id = :empresa_id
              AND instancia_id = :instancia_id
            """
        ),
        params,
    )


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

    # Guarda antes do delete/commit.
    # Depois do db.delete/db.commit, não é seguro depender do objeto ORM.
    instance_name = str(inst.instance_name or "")

    if _has_bound_data(db, instancia_id) and not force:
        raise HTTPException(
            status_code=409,
            detail=(
                "Instância possui dados vinculados "
                "(mensagens, mídias, clientes, grupos, atendimentos ou configurações). "
                "Use force=1 para remover mesmo assim."
            ),
        )

    try:
        # Mesmo se cascade=True, quando force=True fazemos limpeza manual.
        # Isso protege contra FK antiga no banco sem ON DELETE CASCADE real.
        if force:
            _delete_local_bound_data(
                db,
                empresa_id=empresa_id,
                instancia_id=instancia_id,
            )

        elif not cascade:
            _delete_local_bound_data(
                db,
                empresa_id=empresa_id,
                instancia_id=instancia_id,
            )

        db.delete(inst)
        db.flush()

        restantes = _recalc_empresa_counter(db, empresa_id)

        db.commit()

        if delete_remote and instance_name:
            try:
                _delete_remote_evolution(instance_name)
            except Exception:
                pass

        return {
            "ok": True,
            "apagado": True,
            "restantes": restantes,
            "instancia_id": instancia_id,
            "instance_name": instance_name,
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