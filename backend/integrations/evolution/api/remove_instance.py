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
    """
    Verifica se a instância possui dados vinculados.

    Importante:
    - clientes.instancia_id conta como vínculo, mas NÃO significa que o cliente
      será apagado. Cliente é compartilhado por empresa/telefone.
    - A limpeza segura apenas solta/reatribui o cliente da instância removida.
    """
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

    # Mídias ligadas às mensagens desta instância.
    row = db.execute(
        text(
            """
            SELECT 1
            FROM midias
            WHERE mensagem_id IN (
                SELECT id
                FROM mensagens
                WHERE instancia_id = :iid
            )
            LIMIT 1
            """
        ),
        {"iid": iid},
    ).first()
    if row:
        return True

    # Mensagens de grupo ligadas aos grupos desta instância.
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

    # Mídias ligadas aos grupos desta instância.
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

    # Mídias ligadas às mensagens de grupo desta instância.
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

            # 404 aqui é aceitável: a instância remota já pode ter sido removida.
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


def _reassign_clients_from_removed_instance(
    db: Session,
    *,
    empresa_id: int,
    instancia_id: int,
) -> None:
    """
    Nunca apaga clientes.

    Como cliente é único por empresa/telefone, ele pode ter histórico em várias
    instâncias. Ao remover uma instância:

    1. Se o cliente.instancia_id apontava para a instância removida e ainda há
       mensagens dele em outra instância, reatribui para outra instância.
    2. Se não houver outra instância, seta instancia_id = NULL.
    """

    params = {
        "empresa_id": int(empresa_id),
        "instancia_id": int(instancia_id),
    }

    # Reatribui cliente para outra instância onde ele ainda tenha mensagens.
    db.execute(
        text(
            """
            WITH candidatos AS (
                SELECT
                    m.cliente_id,
                    MAX(m.instancia_id) AS nova_instancia_id
                FROM mensagens m
                JOIN clientes c ON c.id = m.cliente_id
                WHERE c.empresa_id = :empresa_id
                  AND c.instancia_id = :instancia_id
                  AND m.empresa_id = :empresa_id
                  AND m.instancia_id IS NOT NULL
                  AND m.instancia_id <> :instancia_id
                GROUP BY m.cliente_id
            )
            UPDATE clientes c
            SET instancia_id = candidatos.nova_instancia_id
            FROM candidatos
            WHERE c.id = candidatos.cliente_id
              AND c.empresa_id = :empresa_id
              AND c.instancia_id = :instancia_id
            """
        ),
        params,
    )

    # O que sobrou apontando para a instância removida fica sem instância principal.
    db.execute(
        text(
            """
            UPDATE clientes
            SET instancia_id = NULL
            WHERE empresa_id = :empresa_id
              AND instancia_id = :instancia_id
            """
        ),
        params,
    )


def _delete_local_bound_data(
    db: Session,
    *,
    empresa_id: int,
    instancia_id: int,
) -> None:
    """
    Remove dados locais vinculados SOMENTE à instância removida.

    Regra crítica:
    - NÃO apagar clientes.
    - NÃO apagar mensagens/mídias/atendimentos apenas porque o cliente estava com
      clientes.instancia_id apontando para esta instância.
    - Cliente é compartilhado por telefone dentro da empresa.
    - Apagar uma instância nunca pode apagar o histórico do mesmo contato em
      outras instâncias.

    O que pode ser apagado:
    - mensagens.instancia_id = instância removida
    - atendimentos.instancia_id = instância removida
    - grupos.instancia_id = instância removida
    - mensagens_grupo da instância/grupos da instância
    - mídias da instância/mensagens/grupos da instância
    - vínculos de fila/departamento/chatbot/pins da instância
    """

    params = {
        "empresa_id": int(empresa_id),
        "instancia_id": int(instancia_id),
    }

    # ==========================================================
    # DISPAROS
    #
    # Mantém histórico de disparos, mas solta vínculos com a
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
                        OR mensagem_id IN (
                            SELECT id
                            FROM mensagens
                            WHERE empresa_id = :empresa_id
                              AND instancia_id = :instancia_id
                        )
                        OR grupo_id IN (
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
    #
    # Remove apenas pins vinculados diretamente à instância removida
    # ou aos atendimentos da instância removida.
    # Não remove por conversa_id/cliente_id.
    # ==========================================================
    db.execute(
        text(
            """
            DELETE FROM atendimento_pinned_conversas
            WHERE empresa_id = :empresa_id
              AND (
                    instancia_id = :instancia_id
                    OR atendimento_id IN (
                        SELECT id
                        FROM atendimentos
                        WHERE empresa_id = :empresa_id
                          AND instancia_id = :instancia_id
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
                      AND instancia_id = :instancia_id
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
    # MÍDIAS 1:1 DA INSTÂNCIA
    #
    # Apaga:
    # - mídia com midias.instancia_id = instância removida
    # - mídia ligada a mensagem da instância removida
    #
    # NÃO apaga por cliente_id.
    # ==========================================================
    db.execute(
        text(
            """
            DELETE FROM midias
            WHERE empresa_id = :empresa_id
              AND (
                    instancia_id = :instancia_id
                    OR mensagem_id IN (
                        SELECT id
                        FROM mensagens
                        WHERE empresa_id = :empresa_id
                          AND instancia_id = :instancia_id
                    )
              )
            """
        ),
        params,
    )

    # ==========================================================
    # MÍDIAS DE GRUPO DA INSTÂNCIA
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
    # MENSAGENS 1:1 DA INSTÂNCIA
    #
    # NÃO apaga por cliente_id, porque o cliente pode existir em
    # outras instâncias.
    # ==========================================================
    db.execute(
        text(
            """
            DELETE FROM mensagens
            WHERE empresa_id = :empresa_id
              AND instancia_id = :instancia_id
            """
        ),
        params,
    )

    # ==========================================================
    # MENSAGENS DE GRUPO DA INSTÂNCIA
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
    # ATENDIMENTOS DA INSTÂNCIA
    #
    # NÃO apaga por cliente_id.
    # ==========================================================
    db.execute(
        text(
            """
            DELETE FROM atendimentos
            WHERE empresa_id = :empresa_id
              AND instancia_id = :instancia_id
            """
        ),
        params,
    )

    # ==========================================================
    # GRUPOS DA INSTÂNCIA
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
    # Nunca apagar clientes ao remover instância.
    # Apenas reatribuir/soltar o ponteiro clientes.instancia_id.
    # ==========================================================
    _reassign_clients_from_removed_instance(
        db,
        empresa_id=empresa_id,
        instancia_id=instancia_id,
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
        # Mesmo se cascade=True, quando force=True fazemos limpeza manual segura.
        # Isso evita FK antiga no banco e, principalmente, protege clientes
        # compartilhados entre instâncias.
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

        else:
            # Mesmo no modo cascade, precisamos soltar clientes antes de apagar
            # a instância para evitar ON DELETE CASCADE acidental em clientes.
            _reassign_clients_from_removed_instance(
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
            "clientes_preservados": True,
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