#backend\integrations\evolution\state\dedupe_cache.py


from __future__ import annotations
import os
import time
from threading import RLock
from typing import Dict


CHATBOT_MSG_TTL_SECONDS = float(os.getenv("CHATBOT_MSG_TTL_SECONDS", "120") or "120")
EVENT_MSG_TTL_SECONDS = float(os.getenv("EVENT_MSG_TTL_SECONDS", "30") or "30")
GENERIC_KEY_TTL_SECONDS = float(os.getenv("GENERIC_KEY_TTL_SECONDS", "60") or "60")

_LOCK = RLock()

_CHATBOT_MSG_SEEN: Dict[str, float] = {}
_EVENT_MSG_SEEN: Dict[str, float] = {}
_GENERIC_KEY_SEEN: Dict[str, float] = {}


def _now_s() -> float:
    return time.time()


def _cleanup_map(bucket: Dict[str, float], ttl_seconds: float) -> None:
    now = _now_s()
    expired = [k for k, ts in bucket.items() if (now - float(ts)) > float(ttl_seconds)]
    for k in expired:
        bucket.pop(k, None)


def _remember_once(bucket: Dict[str, float], key: str, ttl_seconds: float) -> bool:
    raw = str(key or "").strip()
    if not raw:
        return True

    with _LOCK:
        _cleanup_map(bucket, ttl_seconds)
        if raw in bucket:
            return False
        bucket[raw] = _now_s()
        return True


def _drop_key(bucket: Dict[str, float], key: str) -> None:
    raw = str(key or "").strip()
    if not raw:
        return
    with _LOCK:
        bucket.pop(raw, None)


def chatbot_seen_key(empresa_id: int, instancia_id: int, msg_id: str | None) -> str:
    raw = str(msg_id or "").strip()
    if not raw:
        return ""
    return f"{int(empresa_id)}:{int(instancia_id)}:{raw}"


def should_process_chatbot_msg(empresa_id: int, instancia_id: int, msg_id: str | None) -> bool:
    key = chatbot_seen_key(empresa_id, instancia_id, msg_id)
    if not key:
        return True
    return _remember_once(_CHATBOT_MSG_SEEN, key, CHATBOT_MSG_TTL_SECONDS)


def forget_chatbot_msg(empresa_id: int, instancia_id: int, msg_id: str | None) -> None:
    key = chatbot_seen_key(empresa_id, instancia_id, msg_id)
    if not key:
        return
    _drop_key(_CHATBOT_MSG_SEEN, key)


def event_seen_key(
    *,
    empresa_id: int | None = None,
    instancia_id: int | None = None,
    instance_name: str | None = None,
    cliente_id: int | str | None = None,
    msg_id: str | None = None,
    event_name: str | None = None,
) -> str:
    return "|".join(
        [
            str(event_name or "").strip(),
            str(empresa_id if empresa_id is not None else "").strip(),
            str(instancia_id if instancia_id is not None else "").strip(),
            str(instance_name or "").strip(),
            str(cliente_id if cliente_id is not None else "").strip(),
            str(msg_id or "").strip(),
        ]
    ).strip("|")


def should_process_event_message(
    *,
    empresa_id: int | None = None,
    instancia_id: int | None = None,
    instance_name: str | None = None,
    cliente_id: int | str | None = None,
    msg_id: str | None = None,
    event_name: str | None = None,
) -> bool:
    key = event_seen_key(
        empresa_id=empresa_id,
        instancia_id=instancia_id,
        instance_name=instance_name,
        cliente_id=cliente_id,
        msg_id=msg_id,
        event_name=event_name,
    )
    if not key:
        return True
    return _remember_once(_EVENT_MSG_SEEN, key, EVENT_MSG_TTL_SECONDS)


def forget_event_message(
    *,
    empresa_id: int | None = None,
    instancia_id: int | None = None,
    instance_name: str | None = None,
    cliente_id: int | str | None = None,
    msg_id: str | None = None,
    event_name: str | None = None,
) -> None:
    key = event_seen_key(
        empresa_id=empresa_id,
        instancia_id=instancia_id,
        instance_name=instance_name,
        cliente_id=cliente_id,
        msg_id=msg_id,
        event_name=event_name,
    )
    if not key:
        return
    _drop_key(_EVENT_MSG_SEEN, key)


def should_process_generic_key(key: str | None, ttl_seconds: float | None = None) -> bool:
    ttl = float(ttl_seconds if ttl_seconds is not None else GENERIC_KEY_TTL_SECONDS)
    return _remember_once(_GENERIC_KEY_SEEN, str(key or ""), ttl)


def forget_generic_key(key: str | None) -> None:
    _drop_key(_GENERIC_KEY_SEEN, str(key or ""))


def cleanup_all_dedupe_caches() -> None:
    with _LOCK:
        _cleanup_map(_CHATBOT_MSG_SEEN, CHATBOT_MSG_TTL_SECONDS)
        _cleanup_map(_EVENT_MSG_SEEN, EVENT_MSG_TTL_SECONDS)
        _cleanup_map(_GENERIC_KEY_SEEN, GENERIC_KEY_TTL_SECONDS)


def clear_all_dedupe_caches() -> None:
    with _LOCK:
        _CHATBOT_MSG_SEEN.clear()
        _EVENT_MSG_SEEN.clear()
        _GENERIC_KEY_SEEN.clear()


def dedupe_cache_snapshot() -> dict:
    with _LOCK:
        cleanup_all_dedupe_caches()
        return {
            "chatbot_seen_count": len(_CHATBOT_MSG_SEEN),
            "event_seen_count": len(_EVENT_MSG_SEEN),
            "generic_seen_count": len(_GENERIC_KEY_SEEN),
            "chatbot_msg_ttl_seconds": CHATBOT_MSG_TTL_SECONDS,
            "event_msg_ttl_seconds": EVENT_MSG_TTL_SECONDS,
            "generic_key_ttl_seconds": GENERIC_KEY_TTL_SECONDS,
        }


__all__ = [
    "CHATBOT_MSG_TTL_SECONDS",
    "EVENT_MSG_TTL_SECONDS",
    "GENERIC_KEY_TTL_SECONDS",
    "chatbot_seen_key",
    "should_process_chatbot_msg",
    "forget_chatbot_msg",
    "event_seen_key",
    "should_process_event_message",
    "forget_event_message",
    "should_process_generic_key",
    "forget_generic_key",
    "cleanup_all_dedupe_caches",
    "clear_all_dedupe_caches",
    "dedupe_cache_snapshot",
]