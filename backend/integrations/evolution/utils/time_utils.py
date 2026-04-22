#backend\integrations\evolution\utils\time_utils.py

from __future__ import annotations
from datetime import datetime, timezone
from typing import Any

UTC = timezone.utc


def now_utc() -> datetime:
    return datetime.now(UTC)


def _now_utc() -> datetime:
    return now_utc()


def server_ts_ms() -> int:
    return int(now_utc().timestamp() * 1000)


def _server_ts_ms() -> int:
    return server_ts_ms()


def int_unix(value: Any) -> int:
    try:
        if isinstance(value, datetime):
            dt = value if value.tzinfo else value.replace(tzinfo=UTC)
            return int(dt.timestamp())
        if value is None:
            return 0
        return int(float(value))
    except Exception:
        return 0


def _int_unix(value: Any) -> int:
    return int_unix(value)


def to_dt_utc(value: Any) -> datetime:
    """
    Converte segundos/ms/iso/datetime para datetime UTC.
    """
    if isinstance(value, datetime):
        return value.astimezone(UTC) if value.tzinfo else value.replace(tzinfo=UTC)

    if value is None or value == "":
        return now_utc()

    if isinstance(value, (int, float)):
        n = float(value)
        # heurística: milissegundos
        if n > 10_000_000_000:
            n = n / 1000.0
        return datetime.fromtimestamp(n, tz=UTC)

    s = str(value).strip()
    if not s:
        return now_utc()

    # número em string
    try:
        n = float(s)
        if n > 10_000_000_000:
            n = n / 1000.0
        return datetime.fromtimestamp(n, tz=UTC)
    except Exception:
        pass

    # ISO
    s = s.replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(s)
        return dt.astimezone(UTC) if dt.tzinfo else dt.replace(tzinfo=UTC)
    except Exception:
        pass

    # fallback simples
    for fmt in (
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%d %H:%M:%S.%f",
        "%d/%m/%Y %H:%M:%S",
        "%d/%m/%Y %H:%M",
    ):
        try:
            return datetime.strptime(s, fmt).replace(tzinfo=UTC)
        except Exception:
            continue

    return now_utc()


def _to_dt_utc(value: Any) -> datetime:
    return to_dt_utc(value)


def iso_utc(value: Any) -> str:
    try:
        return to_dt_utc(value).isoformat()
    except Exception:
        return now_utc().isoformat()


def _iso_utc(value: Any) -> str:
    return iso_utc(value)


def to_unix_ms(value: Any) -> int:
    try:
        return int(to_dt_utc(value).timestamp() * 1000)
    except Exception:
        return server_ts_ms()


def safe_age_seconds(dt_a: Any, dt_b: Any) -> int:
    try:
        a = to_dt_utc(dt_a)
        b = to_dt_utc(dt_b)
        return int(abs((a - b).total_seconds()))
    except Exception:
        return 0


__all__ = [
    "UTC",
    "now_utc",
    "_now_utc",
    "server_ts_ms",
    "_server_ts_ms",
    "int_unix",
    "_int_unix",
    "to_dt_utc",
    "_to_dt_utc",
    "iso_utc",
    "_iso_utc",
    "to_unix_ms",
    "safe_age_seconds",
]