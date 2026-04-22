#backend\integrations\evolution\utils\cache_utils.py

from __future__ import annotations

try:
    from backend.cache.redis_client import (
        k as _rk,
        delete_key as _rdel,
        delete_prefix as _rdelpat,
    )
except Exception:
    def _rk(*parts: str) -> str:
        return ":".join([str(p) for p in parts if p is not None and p != ""])

    def _rdel(*_a, **_k):
        return None

    def _rdelpat(*_a, **_k):
        return None


def invalidate_emp_cache(emp_id: int) -> None:
    try:
        _rdelpat(_rk("conv", "list", "emp", str(int(emp_id))))
        _rdel(_rk("clientes", "emp", str(int(emp_id)), "dep", ""))
    except Exception:
        pass


def _invalidate_emp_cache(emp_id: int) -> None:
    invalidate_emp_cache(emp_id)


__all__ = [
    "invalidate_emp_cache",
    "_invalidate_emp_cache",
]