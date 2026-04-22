#backend\integrations\evolution\utils\ack_utils.py

from __future__ import annotations
from typing import Any


ACK_PENDING = 0
ACK_SERVER = 1
ACK_DELIVERED = 2
ACK_READ = 3


_STATUS_TO_ACK = {
    "PENDING": ACK_PENDING,
    "ERROR": ACK_PENDING,
    "SERVER_ACK": ACK_SERVER,
    "SENT": ACK_SERVER,
    "DELIVERY_ACK": ACK_DELIVERED,
    "DELIVERED": ACK_DELIVERED,
    "READ": ACK_READ,
    "READ_ACK": ACK_READ,
    "PLAYED": ACK_READ,
}


def ack_from_status(status: Any) -> int:
    if status is None:
        return ACK_PENDING

    if isinstance(status, (int, float)):
        try:
            n = int(status)
            if n < ACK_PENDING:
                return ACK_PENDING
            if n > ACK_READ:
                return ACK_READ
            return n
        except Exception:
            return ACK_PENDING

    raw = str(status).strip().upper()
    if not raw:
        return ACK_PENDING

    return _STATUS_TO_ACK.get(raw, ACK_PENDING)


def _ack_from_status(status: Any) -> int:
    return ack_from_status(status)


def ack_label(ack: Any) -> str:
    n = ack_from_status(ack)
    if n == ACK_SERVER:
        return "server"
    if n == ACK_DELIVERED:
        return "delivered"
    if n == ACK_READ:
        return "read"
    return "pending"


def is_ack_progression(old_ack: Any, new_ack: Any) -> bool:
    return ack_from_status(new_ack) > ack_from_status(old_ack)


__all__ = [
    "ACK_PENDING",
    "ACK_SERVER",
    "ACK_DELIVERED",
    "ACK_READ",
    "ack_from_status",
    "_ack_from_status",
    "ack_label",
    "is_ack_progression",
]