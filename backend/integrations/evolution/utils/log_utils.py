#backend\integrations\evolution\utils\log_utils.py


from __future__ import annotations
import os
from typing import Any


EVO_LOG_ENABLED = os.getenv("EVO_LOG_ENABLED", "true").lower() == "true"
EVO_LOG_PREFIX = os.getenv("EVO_LOG_PREFIX", "[EVO]")


def short(value: Any, limit: int = 120) -> str:
    if value is None:
        return ""
    s = str(value).replace("\n", " ").replace("\r", " ").strip()
    if len(s) <= limit:
        return s
    return s[: max(0, limit - 1)] + "…"


def _short(value: Any, limit: int = 120) -> str:
    return short(value, limit)


def _fmt_kv(kwargs: dict[str, Any]) -> str:
    if not kwargs:
        return ""
    parts: list[str] = []
    for k, v in kwargs.items():
        try:
            if isinstance(v, str):
                parts.append(f"{k}={v}")
            else:
                parts.append(f"{k}={repr(v)}")
        except Exception:
            parts.append(f"{k}=<unprintable>")
    return " | " + " | ".join(parts)


def LOG(message: str) -> None:
    if not EVO_LOG_ENABLED:
        return
    try:
        print(f"{EVO_LOG_PREFIX} {message}")
    except Exception:
        pass


def log(message: str) -> None:
    LOG(message)


def log_ctx(message: str, /, **kwargs: Any) -> None:
    if not EVO_LOG_ENABLED:
        return
    LOG(f"{message}{_fmt_kv(kwargs)}")


def _log_ctx(message: str, /, **kwargs: Any) -> None:
    log_ctx(message, **kwargs)


def log_skip(reason: str, /, **kwargs: Any) -> None:
    if not EVO_LOG_ENABLED:
        return
    log_ctx("[skip] " + str(reason), **kwargs)


def _log_skip(reason: str, /, **kwargs: Any) -> None:
    log_skip(reason, **kwargs)


def log_error(message: str, exc: Exception | None = None, /, **kwargs: Any) -> None:
    if exc is not None:
        kwargs = {**kwargs, "err": str(exc)}
    log_ctx("[erro] " + str(message), **kwargs)


__all__ = [
    "EVO_LOG_ENABLED",
    "EVO_LOG_PREFIX",
    "LOG",
    "log",
    "short",
    "_short",
    "log_ctx",
    "_log_ctx",
    "log_skip",
    "_log_skip",
    "log_error",
]