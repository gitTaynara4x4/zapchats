# backend/integrations/evolution/handlers/_state.py
from __future__ import annotations

import os
import time

# =========================
# Runtime flags in-memory
# =========================
INSTANCIAS_SYNC: set[str] = set()
QR_RECENT: dict[str, int] = {}  # instance -> unix seconds when a QR was last emitted
_HISTORY_DONE_AT: dict[str, float] = {}

# ============================================================
# Dedup global do chatbot por msg_id
# Evita reprocessar o mesmo evento/replay da Evolution.
# ============================================================
_CHATBOT_MSG_SEEN: dict[str, float] = {}
_CHATBOT_MSG_TTL_SECONDS = float(os.getenv("CHATBOT_MSG_TTL_SECONDS", "120"))


def chatbot_seen_key(empresa_id: int, instancia_db_id: int, msg_id: str) -> str:
    return f"{int(empresa_id)}:{int(instancia_db_id)}:{str(msg_id).strip()}"


def chatbot_should_process_msg(empresa_id: int, instancia_db_id: int, msg_id: str | None) -> bool:
    raw = str(msg_id or "").strip()
    if not raw:
        return True

    now_ts = time.time()

    for k, ts in list(_CHATBOT_MSG_SEEN.items()):
        if (now_ts - float(ts)) > _CHATBOT_MSG_TTL_SECONDS:
            _CHATBOT_MSG_SEEN.pop(k, None)

    key = chatbot_seen_key(empresa_id, instancia_db_id, raw)
    if key in _CHATBOT_MSG_SEEN:
        return False

    _CHATBOT_MSG_SEEN[key] = now_ts
    return True


__all__ = [
    "INSTANCIAS_SYNC",
    "QR_RECENT",
    "_HISTORY_DONE_AT",
    "chatbot_seen_key",
    "chatbot_should_process_msg",
]