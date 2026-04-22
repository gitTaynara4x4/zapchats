
#backend\integrations\evolution\services\ack_service.py

from __future__ import annotations
from backend.database import SessionLocal
from ..repositories.instancias_repo import get_empresa_id_by_instance_name
from ..repositories.mensagens_repo import (
    find_cliente_ids_by_msg_ids,
    update_acks_bulk,
)
from ..transport.websocket_emitters import emit_ack
from ..utils.ack_utils import ack_from_status
from ..utils.cache_utils import invalidate_emp_cache


async def process_messages_update_ack(first: str, payload: dict | list):
    raw = payload
    data = raw["data"] if isinstance(raw, dict) and isinstance(raw.get("data"), (dict, list)) else raw
    updates = data if isinstance(data, list) else [data]

    if not updates or (len(updates) == 1 and not isinstance(updates[0], dict)):
        print("[ACK DEBUG] MESSAGES_UPDATE sem updates válidos.")
        return

    emp_id: int | None = None
    inst_name: str | None = None
    params: list[dict] = []
    cli_by_msg: dict[str, int] = {}

    with SessionLocal() as db:
        try:
            inst_name = (payload.get("instance") if isinstance(payload, dict) else None) or first
            if inst_name:
                emp_id = get_empresa_id_by_instance_name(db, instance_name=inst_name)
        except Exception as e:
            print(f"[ACK DEBUG] Falha resolvendo empresa: {e}")

        for u in updates:
            if not isinstance(u, dict):
                continue
            key_id = (u.get("keyId") or (u.get("key") or {}).get("id") or u.get("messageId"))
            status = u.get("status") or u.get("ack")
            new_ack = ack_from_status(status)
            if key_id and new_ack > 0:
                p = {"msg_id": str(key_id), "new_ack": int(new_ack)}
                if emp_id:
                    p["emp_id"] = int(emp_id)
                params.append(p)

        if not params:
            return

        try:
            update_acks_bulk(db, params=params, empresa_id=emp_id)
            db.commit()
        except Exception as e:
            print(f"[ACK DEBUG] Erro no UPDATE de ACKs: {e}")
            return

        try:
            if emp_id:
                invalidate_emp_cache(int(emp_id))
        except Exception:
            pass

        try:
            msg_ids = tuple({p["msg_id"] for p in params})
            if msg_ids:
                cli_by_msg = find_cliente_ids_by_msg_ids(
                    db,
                    msg_ids=msg_ids,
                    empresa_id=emp_id,
                )
        except Exception as e:
            print(f"[ACK DEBUG] Falha buscando cliente_id por msg_id: {e}")

    for p in params:
        await emit_ack(
            emp_id,
            inst_name,
            msg_id=p["msg_id"],
            ack=p["new_ack"],
            cliente_id=cli_by_msg.get(p["msg_id"]),
        )


__all__ = [
    "process_messages_update_ack",
]
