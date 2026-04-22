#backend\integrations\evolution\state\runtime_flags.py


from __future__ import annotations
import os
import time
from typing import Dict


QR_CONNECT_SYNC_WINDOW_MIN = int(os.getenv("QR_CONNECT_SYNC_WINDOW_MIN", "30") or "30")
HISTORY_IGNORE_AFTER_DONE_MIN = int(os.getenv("HISTORY_IGNORE_AFTER_DONE_MIN", "15") or "15")

INSTANCIAS_SYNC: set[str] = set()
QR_RECENT: Dict[str, int] = {}
_HISTORY_DONE_AT: Dict[str, float] = {}


def _now_s() -> float:
    return time.time()


def _norm_instance(instance_name: str | None) -> str:
    return str(instance_name or "").strip()


def mark_instance_synced(instance_name: str) -> None:
    inst = _norm_instance(instance_name)
    if not inst:
        return
    INSTANCIAS_SYNC.add(inst)


def unmark_instance_synced(instance_name: str) -> None:
    inst = _norm_instance(instance_name)
    if not inst:
        return
    INSTANCIAS_SYNC.discard(inst)


def is_instance_synced(instance_name: str) -> bool:
    inst = _norm_instance(instance_name)
    if not inst:
        return False
    return inst in INSTANCIAS_SYNC


def remember_qr_emitted(instance_name: str, ts: int | None = None) -> None:
    inst = _norm_instance(instance_name)
    if not inst:
        return
    QR_RECENT[inst] = int(ts if ts is not None else _now_s())


def forget_qr(instance_name: str) -> None:
    inst = _norm_instance(instance_name)
    if not inst:
        return
    QR_RECENT.pop(inst, None)


def get_last_qr_ts(instance_name: str) -> int | None:
    inst = _norm_instance(instance_name)
    if not inst:
        return None
    val = QR_RECENT.get(inst)
    return int(val) if val is not None else None


def was_qr_recent(instance_name: str, window_min: int | None = None) -> bool:
    inst = _norm_instance(instance_name)
    if not inst:
        return False

    last = QR_RECENT.get(inst)
    if last is None:
        return False

    win = int(window_min if window_min is not None else QR_CONNECT_SYNC_WINDOW_MIN)
    return (_now_s() - float(last)) <= (win * 60)


def mark_history_done(instance_name: str, ts: float | None = None) -> None:
    inst = _norm_instance(instance_name)
    if not inst:
        return
    _HISTORY_DONE_AT[inst] = float(ts if ts is not None else _now_s())


def forget_history_done(instance_name: str) -> None:
    inst = _norm_instance(instance_name)
    if not inst:
        return
    _HISTORY_DONE_AT.pop(inst, None)


def get_last_history_done_ts(instance_name: str) -> float | None:
    inst = _norm_instance(instance_name)
    if not inst:
        return None
    val = _HISTORY_DONE_AT.get(inst)
    return float(val) if val is not None else None


def should_ignore_history_sync(instance_name: str, window_min: int | None = None) -> bool:
    inst = _norm_instance(instance_name)
    if not inst:
        return False

    last = _HISTORY_DONE_AT.get(inst)
    if last is None:
        return False

    win = int(window_min if window_min is not None else HISTORY_IGNORE_AFTER_DONE_MIN)
    return (_now_s() - float(last)) <= (win * 60)


def clear_runtime_for_instance(instance_name: str) -> None:
    inst = _norm_instance(instance_name)
    if not inst:
        return

    INSTANCIAS_SYNC.discard(inst)
    QR_RECENT.pop(inst, None)
    _HISTORY_DONE_AT.pop(inst, None)


def clear_all_runtime_flags() -> None:
    INSTANCIAS_SYNC.clear()
    QR_RECENT.clear()
    _HISTORY_DONE_AT.clear()


def runtime_flags_snapshot() -> dict:
    return {
        "instancias_sync": sorted(INSTANCIAS_SYNC),
        "qr_recent": dict(QR_RECENT),
        "history_done_at": dict(_HISTORY_DONE_AT),
        "qr_connect_sync_window_min": QR_CONNECT_SYNC_WINDOW_MIN,
        "history_ignore_after_done_min": HISTORY_IGNORE_AFTER_DONE_MIN,
    }


__all__ = [
    "QR_CONNECT_SYNC_WINDOW_MIN",
    "HISTORY_IGNORE_AFTER_DONE_MIN",
    "INSTANCIAS_SYNC",
    "QR_RECENT",
    "mark_instance_synced",
    "unmark_instance_synced",
    "is_instance_synced",
    "remember_qr_emitted",
    "forget_qr",
    "get_last_qr_ts",
    "was_qr_recent",
    "mark_history_done",
    "forget_history_done",
    "get_last_history_done_ts",
    "should_ignore_history_sync",
    "clear_runtime_for_instance",
    "clear_all_runtime_flags",
    "runtime_flags_snapshot",
]