#backend\integrations\evolution\state\sync_locks.py

from __future__ import annotations
import time
from threading import RLock
from typing import Dict


_LOCK = RLock()

_HISTORY_LOCKS: Dict[str, float] = {}
_QR_FORCE_LOCKS: Dict[str, float] = {}
_GENERIC_LOCKS: Dict[str, float] = {}


def _now_s() -> float:
    return time.time()


def _norm_key(key: str | None) -> str:
    return str(key or "").strip()


def _cleanup_expired(bucket: Dict[str, float]) -> None:
    now = _now_s()
    expired = [k for k, exp in bucket.items() if float(exp) <= now]
    for k in expired:
        bucket.pop(k, None)


def _acquire(bucket: Dict[str, float], key: str, ttl_sec: float) -> bool:
    raw = _norm_key(key)
    if not raw:
        return False

    with _LOCK:
        _cleanup_expired(bucket)
        if raw in bucket:
            return False
        bucket[raw] = _now_s() + float(ttl_sec)
        return True


def _release(bucket: Dict[str, float], key: str) -> None:
    raw = _norm_key(key)
    if not raw:
        return
    with _LOCK:
        bucket.pop(raw, None)


def _is_locked(bucket: Dict[str, float], key: str) -> bool:
    raw = _norm_key(key)
    if not raw:
        return False
    with _LOCK:
        _cleanup_expired(bucket)
        return raw in bucket


def history_lock_key(empresa_id: int | None, instancia_id: int | None) -> str:
    return f"{int(empresa_id or 0)}:{int(instancia_id or 0)}"


def qr_force_lock_key(instance_name: str | None) -> str:
    return _norm_key(instance_name)


def acquire_history_lock(empresa_id: int, instancia_id: int, ttl_sec: float = 900.0) -> bool:
    key = history_lock_key(empresa_id, instancia_id)
    return _acquire(_HISTORY_LOCKS, key, ttl_sec)


def release_history_lock(empresa_id: int, instancia_id: int) -> None:
    key = history_lock_key(empresa_id, instancia_id)
    _release(_HISTORY_LOCKS, key)


def is_history_locked(empresa_id: int, instancia_id: int) -> bool:
    key = history_lock_key(empresa_id, instancia_id)
    return _is_locked(_HISTORY_LOCKS, key)


def acquire_qr_force_lock(instance_name: str, ttl_sec: float = 3.0) -> bool:
    key = qr_force_lock_key(instance_name)
    return _acquire(_QR_FORCE_LOCKS, key, ttl_sec)


def release_qr_force_lock(instance_name: str) -> None:
    key = qr_force_lock_key(instance_name)
    _release(_QR_FORCE_LOCKS, key)


def is_qr_force_locked(instance_name: str) -> bool:
    key = qr_force_lock_key(instance_name)
    return _is_locked(_QR_FORCE_LOCKS, key)


def acquire_generic_lock(key: str, ttl_sec: float = 30.0) -> bool:
    return _acquire(_GENERIC_LOCKS, key, ttl_sec)


def release_generic_lock(key: str) -> None:
    _release(_GENERIC_LOCKS, key)


def is_generic_locked(key: str) -> bool:
    return _is_locked(_GENERIC_LOCKS, key)


def _try_acquire_hist_lock(db, empresa_id: int, instancia_id: int, ttl_sec: float = 900.0) -> bool:
    _ = db
    return acquire_history_lock(empresa_id, instancia_id, ttl_sec=ttl_sec)


def _release_hist_lock(db, empresa_id: int, instancia_id: int) -> None:
    _ = db
    release_history_lock(empresa_id, instancia_id)


def qr_force_lock_acquire(instance_name: str, ttl_sec: float = 3.0) -> bool:
    return acquire_qr_force_lock(instance_name, ttl_sec=ttl_sec)


def cleanup_sync_locks() -> None:
    with _LOCK:
        _cleanup_expired(_HISTORY_LOCKS)
        _cleanup_expired(_QR_FORCE_LOCKS)
        _cleanup_expired(_GENERIC_LOCKS)


def clear_all_sync_locks() -> None:
    with _LOCK:
        _HISTORY_LOCKS.clear()
        _QR_FORCE_LOCKS.clear()
        _GENERIC_LOCKS.clear()


def sync_locks_snapshot() -> dict:
    with _LOCK:
        cleanup_sync_locks()
        return {
            "history_locks": list(_HISTORY_LOCKS.keys()),
            "qr_force_locks": list(_QR_FORCE_LOCKS.keys()),
            "generic_locks": list(_GENERIC_LOCKS.keys()),
            "history_count": len(_HISTORY_LOCKS),
            "qr_force_count": len(_QR_FORCE_LOCKS),
            "generic_count": len(_GENERIC_LOCKS),
        }


__all__ = [
    "history_lock_key",
    "qr_force_lock_key",
    "acquire_history_lock",
    "release_history_lock",
    "is_history_locked",
    "acquire_qr_force_lock",
    "release_qr_force_lock",
    "is_qr_force_locked",
    "acquire_generic_lock",
    "release_generic_lock",
    "is_generic_locked",
    "_try_acquire_hist_lock",
    "_release_hist_lock",
    "qr_force_lock_acquire",
    "cleanup_sync_locks",
    "clear_all_sync_locks",
    "sync_locks_snapshot",
]