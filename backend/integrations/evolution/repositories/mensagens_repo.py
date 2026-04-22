#backend\integrations\evolution\repositories\mensagens_repo.py

from __future__ import annotations
from typing import Optional
from sqlalchemy import bindparam, text
from sqlalchemy.orm import Session
from backend import models


def _stamp_inst(obj, instancia) -> None:
    if obj is None or instancia is None:
        return
    if hasattr(obj, "instancia_id") and getattr(obj, "instancia_id", None) is None:
        setattr(obj, "instancia_id", getattr(instancia, "id", None))
    if hasattr(obj, "instance_name") and not getattr(obj, "instance_name", None):
        setattr(obj, "instance_name", getattr(instancia, "instance_name", None))


def is_statement_timeout_error(e: Exception) -> bool:
    base = getattr(e, "orig", e)
    msg = str(base).lower()
    return (
        "statement timeout" in msg
        or "canceling statement due to statement timeout" in msg
        or "querycanceled" in msg
        or "query canceled" in msg
        or "lock timeout" in msg
    )


def is_duplicate_key_error(e: Exception) -> bool:
    base = getattr(e, "orig", e)
    msg = str(base).lower()
    return (
        "duplicate key value violates unique constraint" in msg
        or "unique violation" in msg
        or "uq_mensagens_" in msg
    )


def get_mensagem_11_by_msgid(
    db: Session,
    *,
    instancia_id: int,
    msg_id: str,
) -> Optional[models.Mensagem]:
    raw = str(msg_id or "").strip()
    if not raw:
        return None

    return (
        db.query(models.Mensagem)
        .filter(
            models.Mensagem.instancia_id == int(instancia_id),
            models.Mensagem.msg_id == raw,
        )
        .first()
    )


def find_existing_mensagem_11_id(
    db: Session,
    *,
    empresa_id: int,
    cliente_id: int | None,
    msg_id: str | None,
    instancia_id: int | None,
) -> int | None:
    raw = str(msg_id or "").strip()
    if not raw:
        return None

    if instancia_id is not None:
        row = db.execute(
            text(
                """
                SELECT id
                  FROM mensagens
                 WHERE instancia_id = :instancia_id
                   AND msg_id = :msg_id
                 ORDER BY id DESC
                 LIMIT 1
                """
            ),
            {
                "instancia_id": int(instancia_id),
                "msg_id": raw,
            },
        ).fetchone()
        if row and row[0] is not None:
            return int(row[0])

    if empresa_id is not None and cliente_id is not None:
        row = db.execute(
            text(
                """
                SELECT id
                  FROM mensagens
                 WHERE empresa_id = :empresa_id
                   AND cliente_id = :cliente_id
                   AND msg_id = :msg_id
                 ORDER BY id DESC
                 LIMIT 1
                """
            ),
            {
                "empresa_id": int(empresa_id),
                "cliente_id": int(cliente_id),
                "msg_id": raw,
            },
        ).fetchone()
        if row and row[0] is not None:
            return int(row[0])

    return None


def insert_mensagem_11_on_conflict(
    db: Session,
    *,
    empresa_id: int,
    cliente_id: int,
    conteudo: str,
    tipo: str,
    lida: bool,
    ack: int | None,
    timestamp,
    msg_id: str,
    instancia_id: int,
    atendimento_id: int | None,
) -> tuple[int | None, bool]:
    sql = text(
        """
        INSERT INTO mensagens
            (empresa_id, cliente_id, conteudo, tipo, lida, ack, timestamp, msg_id, instancia_id, atendimento_id)
        VALUES
            (:empresa_id, :cliente_id, :conteudo, :tipo, :lida, :ack, :timestamp, :msg_id, :instancia_id, :atendimento_id)
        ON CONFLICT (instancia_id, msg_id)
        DO NOTHING
        RETURNING id
        """
    )

    params = {
        "empresa_id": int(empresa_id),
        "cliente_id": int(cliente_id),
        "conteudo": conteudo,
        "tipo": tipo,
        "lida": bool(lida),
        "ack": ack,
        "timestamp": timestamp,
        "msg_id": str(msg_id),
        "instancia_id": int(instancia_id),
        "atendimento_id": atendimento_id,
    }

    row = db.execute(sql, params).fetchone()
    if row:
        return int(row[0]), True

    existente_id = find_existing_mensagem_11_id(
        db,
        empresa_id=empresa_id,
        cliente_id=cliente_id,
        msg_id=msg_id,
        instancia_id=instancia_id,
    )
    return existente_id, False


def create_mensagem_sem_msgid(
    db: Session,
    *,
    empresa_id: int,
    cliente_id: int,
    conteudo: str,
    tipo: str,
    lida: bool,
    ack: int | None,
    timestamp,
    instancia,
    atendimento_id: int | None = None,
) -> models.Mensagem:
    msg = models.Mensagem(
        empresa_id=int(empresa_id),
        cliente_id=int(cliente_id),
        conteudo=conteudo,
        tipo=tipo,
        lida=bool(lida),
        ack=ack,
        timestamp=timestamp,
        msg_id=None,
        instancia_id=getattr(instancia, "id", None),
    )

    if atendimento_id is not None and hasattr(msg, "atendimento_id"):
        setattr(msg, "atendimento_id", atendimento_id)

    _stamp_inst(msg, instancia)

    db.add(msg)
    db.flush()
    return msg


def update_acks_bulk(
    db: Session,
    *,
    params: list[dict],
    empresa_id: int | None = None,
) -> int:
    if not params:
        return 0

    where = "msg_id = :msg_id AND tipo = 'saida'"
    if empresa_id is not None:
        where += " AND empresa_id = :emp_id"

    result = db.execute(
        text(
            f"""
            UPDATE mensagens
               SET ack = CASE
                           WHEN COALESCE(ack, 0) < :new_ack THEN :new_ack
                           ELSE ack
                         END
             WHERE {where}
            """
        ),
        params,
    )

    return int(getattr(result, "rowcount", 0) or 0)


def find_cliente_ids_by_msg_ids(
    db: Session,
    *,
    msg_ids: list[str] | tuple[str, ...],
    empresa_id: int | None = None,
) -> dict[str, int]:
    ids = [str(x).strip() for x in (msg_ids or []) if str(x).strip()]
    if not ids:
        return {}

    base = "SELECT msg_id, cliente_id FROM mensagens WHERE msg_id IN :ids"
    args = {"ids": ids}

    if empresa_id is not None:
        base += " AND empresa_id = :emp_id"
        args["emp_id"] = int(empresa_id)

    q = text(base).bindparams(bindparam("ids", expanding=True))
    rows = db.execute(q, args).fetchall()

    out: dict[str, int] = {}
    for r in rows or []:
        try:
            mid = str(r[0])
            cid = int(r[1]) if r[1] is not None else None
            if mid and cid:
                out[mid] = cid
        except Exception:
            continue

    return out


def apply_delete_flags_to_row(
    row: models.Mensagem,
    *,
    from_me: bool | None = None,
) -> bool:
    tipo = getattr(row, "tipo", None)

    apagou_cliente = False
    apagou_usuario = False

    if tipo == "entrada":
        apagou_cliente = True
    elif tipo == "saida":
        apagou_usuario = True
    else:
        apagou_usuario = bool(from_me)
        apagou_cliente = not bool(from_me)

    changed = False

    if apagou_cliente and not bool(getattr(row, "apagada_cliente", False)):
        row.apagada_cliente = True
        changed = True

    if apagou_usuario and not bool(getattr(row, "apagada_usuario", False)):
        row.apagada_usuario = True
        changed = True

    return changed


def mark_message_deleted(
    db: Session,
    *,
    instancia_id: int,
    msg_id: str,
    from_me: bool | None = None,
) -> dict | None:
    raw = str(msg_id or "").strip()
    if not raw:
        return None

    row = (
        db.query(models.Mensagem)
        .filter(
            models.Mensagem.instancia_id == int(instancia_id),
            models.Mensagem.msg_id == raw,
        )
        .first()
    )
    if not row:
        return None

    changed = apply_delete_flags_to_row(row, from_me=from_me)

    return {
        "changed": changed,
        "cliente_id": getattr(row, "cliente_id", None),
        "msg_id": getattr(row, "msg_id", None),
        "apagada_cliente": bool(getattr(row, "apagada_cliente", False)),
        "apagada_usuario": bool(getattr(row, "apagada_usuario", False)),
        "tipo": getattr(row, "tipo", None),
    }


def bulk_mark_messages_deleted(
    db: Session,
    *,
    instancia_id: int,
    items: list[dict],
) -> list[dict]:
    out: list[dict] = []
    for item in items or []:
        if not isinstance(item, dict):
            continue
        msg_id = str(item.get("msg_id") or item.get("id") or "").strip()
        if not msg_id:
            continue
        result = mark_message_deleted(
            db,
            instancia_id=instancia_id,
            msg_id=msg_id,
            from_me=item.get("from_me"),
        )
        if result:
            out.append(result)
    return out


__all__ = [
    "is_statement_timeout_error",
    "is_duplicate_key_error",
    "get_mensagem_11_by_msgid",
    "find_existing_mensagem_11_id",
    "insert_mensagem_11_on_conflict",
    "create_mensagem_sem_msgid",
    "update_acks_bulk",
    "find_cliente_ids_by_msg_ids",
    "apply_delete_flags_to_row",
    "mark_message_deleted",
    "bulk_mark_messages_deleted",
]
