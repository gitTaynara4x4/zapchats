# backend/integrations/evolution/handlers/qrcode.py


from __future__ import annotations

import asyncio
from typing import Any

from ._state import remember_qr_emitted
from ..state.sync_locks import qr_force_lock_acquire
from ..transport.evolution_http_client import evo_connect
from ..transport.websocket_emitters import emit_qrcode
from ..utils.log_utils import LOG
from ..utils.time_utils import _server_ts_ms
from .shared import EvoEvent, handler


EVOLUTION_FORCE_QR_ON_WS = True


def _safe_str(v: Any) -> str:
    if v is None:
        return ""
    return str(v).strip()


def _as_dict(v: Any) -> dict:
    return v if isinstance(v, dict) else {}


def _inst_from_payload(first: str, payload: dict | list) -> str:
    if isinstance(payload, dict):
        for key in ("instance", "instanceName", "instanceId"):
            value = payload.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()

        data = payload.get("data")
        if isinstance(data, dict):
            for key in ("instance", "instanceName", "instanceId"):
                value = data.get(key)
                if isinstance(value, str) and value.strip():
                    return value.strip()

            qrcode = data.get("qrcode")
            if isinstance(qrcode, dict):
                for key in ("instance", "instanceName", "instanceId"):
                    value = qrcode.get(key)
                    if isinstance(value, str) and value.strip():
                        return value.strip()

        elif isinstance(data, list):
            for item in data:
                if not isinstance(item, dict):
                    continue
                for key in ("instance", "instanceName", "instanceId"):
                    value = item.get(key)
                    if isinstance(value, str) and value.strip():
                        return value.strip()

    return str(first or "").strip()


def _extract_qr_fields(payload: Any) -> tuple[str, str | None, int | None]:
    """
    Retorna: (base64, pairing_code, limit)
    """
    data = _as_dict(payload)

    if "data" in data and isinstance(data.get("data"), dict):
        data = _as_dict(data.get("data"))

    q = _as_dict(data.get("qrcode")) if isinstance(data.get("qrcode"), dict) else data

    b64 = (
        _safe_str(q.get("base64"))
        or _safe_str(q.get("image"))
        or _safe_str(q.get("qr"))
        or _safe_str(q.get("codeBase64"))
    )

    pairing_code = (
        _safe_str(q.get("pairingCode"))
        or _safe_str(q.get("code"))
        or _safe_str(q.get("pairing_code"))
        or None
    )

    limit = None
    raw_limit = q.get("count") or q.get("limit") or q.get("timeout")
    try:
        if isinstance(raw_limit, str) and raw_limit.strip().isdigit():
            limit = int(raw_limit.strip())
        elif isinstance(raw_limit, (int, float)):
            limit = int(raw_limit)
    except Exception:
        limit = None

    return b64, pairing_code, limit


async def _emit_qr(inst_id: str, b64: str | None, pairing_code: str | None, limit: int | None) -> None:
    await emit_qrcode(
        inst_id,
        b64,
        pairing_code=pairing_code,
        qr_limit=limit,
    )


@handler(EvoEvent.QRCODE_UPDATED)
async def on_qrcode_updated(first: str, payload: dict):
    inst_id = _inst_from_payload(first, payload)
    b64, pairing_code, limit = _extract_qr_fields(payload)

    if not (b64 or pairing_code):
        try:
            await emit_qrcode(
                inst_id,
                None,
                pairing_code=None,
                qr_limit=limit,
            )
        except Exception as e:
            LOG(f"[QR EVT] Falha ao emitir estado 'waiting' para inst:{inst_id}: {e}")
        return

    try:
        remember_qr_emitted(inst_id)
    except Exception:
        pass

    await _emit_qr(inst_id, b64, pairing_code, limit)


async def force_qr_now_async(inst_id: str):
    if not EVOLUTION_FORCE_QR_ON_WS:
        return

    if not qr_force_lock_acquire(inst_id, ttl_sec=3):
        LOG(f"[QR WS] force_qr ignorado por lock (inst={inst_id})")
        return

    try:
        js = await asyncio.to_thread(evo_connect, inst_id)
        if isinstance(js, dict):
            b64, pairing_code, limit = _extract_qr_fields(js)
            if b64 or pairing_code:
                try:
                    remember_qr_emitted(inst_id)
                except Exception:
                    pass
                await _emit_qr(inst_id, b64, pairing_code, limit)
            else:
                await emit_qrcode(inst_id, None, pairing_code=None, qr_limit=limit)
    except Exception as e:
        LOG(f"[QR WS] falha ao forçar QR: {e}")


async def force_qr_for_instance(inst_id: str):
    return await force_qr_now_async(inst_id)


__all__ = [
    "on_qrcode_updated",
    "force_qr_now_async",
    "force_qr_for_instance",
]