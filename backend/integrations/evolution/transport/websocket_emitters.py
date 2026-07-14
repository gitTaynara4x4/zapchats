#backend\integrations\evolution\transport\websocket_emitters.py


from __future__ import annotations
from typing import Any
from backend.websocket_manager import conexoes_ativas
from ..utils.log_utils import LOG
from ..utils.time_utils import _server_ts_ms


async def emit_to_company(empresa_id: int, payload: dict[str, Any]) -> None:
    if not empresa_id:
        return
    data = dict(payload or {})
    data.setdefault("serverTimestamp", _server_ts_ms())
    try:
        await conexoes_ativas.send_message(f"emp:{int(empresa_id)}", data)
    except Exception as e:
        LOG(f"[WS_EMIT][company] emp={empresa_id} err={e}")


async def emit_to_instance(instance_key: str, payload: dict[str, Any]) -> None:
    if not instance_key:
        return
    data = dict(payload or {})
    data.setdefault("serverTimestamp", _server_ts_ms())
    try:
        await conexoes_ativas.send_message(f"inst:{instance_key}", data)
    except Exception as e:
        LOG(f"[WS_EMIT][instance] inst={instance_key} err={e}")


async def emit_qrcode(
    instance_key: str,
    base64: str | None,
    pairing_code: str | None = None,
    qr_limit: int | None = None,
    qr_text: str | None = None,
) -> None:
    await emit_to_instance(
        instance_key,
        {
            "type": "qrcode",
            "instance": instance_key,
            "base64": base64,
            "pairingCode": pairing_code,
            "qrText": qr_text,
            "code": qr_text,
            "qr_limit": qr_limit,
            "waiting": False if (base64 or pairing_code or qr_text) else True,
        },
    )


async def emit_connection_update(empresa_id: int | None, instance_key: str, connected: bool) -> None:
    status = "CONNECTED" if connected else "DISCONNECTED"

    await emit_to_instance(
        instance_key,
        {
            "type": "connection",
            "status": status,
        },
    )

    if empresa_id:
        await emit_to_company(
            int(empresa_id),
            {
                "type": "connection",
                "inst_status": {
                    "instance": instance_key,
                    "connected": bool(connected),
                },
                "reload_whatsapp": True,
            },
        )


async def emit_reload_clientes(empresa_id: int) -> None:
    await emit_to_company(
        empresa_id,
        {
            "type": "reload_clientes",
        },
    )


async def emit_reload_grupos(empresa_id: int, total: int = 0) -> None:
    await emit_to_company(
        empresa_id,
        {
            "type": "reload_grupos",
            "total": int(total or 0),
        },
    )


async def emit_contacts_sync_start(empresa_id: int, total: int) -> None:
    await emit_to_company(
        empresa_id,
        {
            "type": "contacts_sync_start",
            "total": int(total or 0),
        },
    )


async def emit_contacts_sync_progress(empresa_id: int, total: int, imported: int) -> None:
    await emit_to_company(
        empresa_id,
        {
            "type": "contacts_sync_progress",
            "total": int(total or 0),
            "imported": int(imported or 0),
        },
    )


async def emit_contacts_sync_done(empresa_id: int, total: int, imported: int) -> None:
    await emit_to_company(
        empresa_id,
        {
            "type": "contacts_sync_done",
            "total": int(total or 0),
            "imported": int(imported or 0),
        },
    )


async def emit_history_sync_start(empresa_id: int, total: int) -> None:
    await emit_to_company(
        empresa_id,
        {
            "type": "history_sync_start",
            "total": int(total or 0),
        },
    )


async def emit_history_sync_progress(empresa_id: int, total: int, imported: int) -> None:
    await emit_to_company(
        empresa_id,
        {
            "type": "history_sync_progress",
            "total": int(total or 0),
            "imported": int(imported or 0),
        },
    )


async def emit_history_sync_done(empresa_id: int, total: int, imported: int) -> None:
    await emit_to_company(
        empresa_id,
        {
            "type": "history_sync_done",
            "total": int(total or 0),
            "imported": int(imported or 0),
        },
    )


async def emit_ack(empresa_id: int | None, instance_key: str | None, *, msg_id: str, ack: int, cliente_id: int | None = None) -> None:
    payload = {
        "type": "ack",
        "msg_id": str(msg_id),
        "ack": int(ack),
        "cliente_id": cliente_id,
    }
    if instance_key:
        await emit_to_instance(instance_key, payload)
    if empresa_id:
        await emit_to_company(int(empresa_id), payload)


async def emit_message_deleted(
    empresa_id: int,
    *,
    instance_key: str | None,
    instancia_id: int | None,
    cliente_id: int | None,
    msg_id: str,
    apagada_cliente: bool,
    apagada_usuario: bool,
) -> None:
    payload = {
        "type": "msg_deleted",
        "empresa_id": int(empresa_id),
        "instancia": instance_key,
        "instancia_id": instancia_id,
        "cliente_id": cliente_id,
        "msg_id": str(msg_id),
        "apagada_cliente": bool(apagada_cliente),
        "apagada_usuario": bool(apagada_usuario),
    }
    if instance_key:
        await emit_to_instance(instance_key, payload)
    await emit_to_company(empresa_id, payload)


async def emit_live_message(empresa_id: int, payload: dict[str, Any]) -> None:
    await emit_to_company(empresa_id, payload or {})


__all__ = [
    "emit_to_company",
    "emit_to_instance",
    "emit_qrcode",
    "emit_connection_update",
    "emit_reload_clientes",
    "emit_reload_grupos",
    "emit_contacts_sync_start",
    "emit_contacts_sync_progress",
    "emit_contacts_sync_done",
    "emit_history_sync_start",
    "emit_history_sync_progress",
    "emit_history_sync_done",
    "emit_ack",
    "emit_message_deleted",
    "emit_live_message",
]