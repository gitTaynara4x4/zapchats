# backend/integrations/evolution/handlers/presence.py

from __future__ import annotations

from ..transport.rabbit_consumer import record_rabbit_event
from .shared import EvoEvent, handler


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

    return str(first or "").strip()


@handler(EvoEvent.PRESENCE_UPDATE)
async def on_presence_update(first: str, payload: dict | list):
    inst_id = _inst_from_payload(first, payload)
    record_rabbit_event("PRESENCE_UPDATE", instance=inst_id)


__all__ = [
    "on_presence_update",
]