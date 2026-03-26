# backend/utils/entitlements.py
from __future__ import annotations

from typing import Any, Optional, Dict
from fastapi import HTTPException
from sqlalchemy.orm import Session

from backend.utils.plans import (
    plan_limits,
    plan_features,
    has_feature,
    effective_plan,
)
from backend.utils.usage import usage_counts


def _safe_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except Exception:
        return default


def _limit_for(emp: Any, key: str) -> Optional[int]:
    """
    Retorna o limite configurado para a quota.
    - int => limite numérico
    - None => sem limite
    """
    limits = plan_limits(emp)
    value = limits.get(key, None)

    if value is None:
        return None

    try:
        return int(value)
    except Exception:
        return None


def enforce_feature(
    emp: Any,
    feature_key: str,
    *,
    message: Optional[str] = None,
) -> None:
    """
    Bloqueia acesso a um recurso se o plano não tiver a feature.
    """
    if not has_feature(emp, feature_key):
        raise HTTPException(
            status_code=403,
            detail=message or f"Recurso não disponível no seu plano ({effective_plan(emp)}).",
        )


def enforce_quota(
    emp: Any,
    key: str,
    current: int,
    *,
    delta: int = 1,
    message: Optional[str] = None,
) -> None:
    """
    Bloqueia se current + delta ultrapassar o limite do plano.

    Ex.:
      enforce_quota(emp, "users_max", current_users, delta=1)
    """
    limit = _limit_for(emp, key)

    # None = sem limite
    if limit is None:
        return

    current_i = _safe_int(current, 0)
    delta_i = _safe_int(delta, 0)

    if (current_i + delta_i) > limit:
        raise HTTPException(
            status_code=403,
            detail=message or f"Limite do plano atingido para '{key}' ({current_i}/{limit}).",
        )


def quota_status(
    emp: Any,
    key: str,
    current: int,
) -> Dict[str, Any]:
    """
    Retorna o estado de uma quota específica.
    """
    limit = _limit_for(emp, key)
    current_i = _safe_int(current, 0)

    if limit is None:
        return {
            "current": current_i,
            "limit": None,
            "remaining": None,
            "percent": None,
            "blocked": False,
        }

    remaining = max(0, limit - current_i)
    percent = 0 if limit <= 0 else round((current_i / limit) * 100, 2)

    return {
        "current": current_i,
        "limit": limit,
        "remaining": remaining,
        "percent": percent,
        "blocked": current_i >= limit,
    }


def enforce_quotas_bulk(emp: Any, counts: Dict[str, int]) -> Dict[str, Dict[str, Any]]:
    """
    Retorna um snapshot pronto para o front:

      {
        "users_max": {
          "current": 3,
          "limit": 10,
          "remaining": 7,
          "percent": 30.0,
          "blocked": False
        }
      }
    """
    out: Dict[str, Dict[str, Any]] = {}
    limits = plan_limits(emp)

    for key, current in (counts or {}).items():
        if key not in limits:
            continue
        out[key] = quota_status(emp, key, current)

    return out


def entitlements_payload(db: Session, emp: Any) -> Dict[str, Any]:
    """
    Payload único para UI e regras de negócio:

    {
      "plan": "START",
      "limits": {...},
      "features": {...},
      "usage": {...},
      "quotas": {...}
    }
    """
    plan = effective_plan(emp)
    limits = plan_limits(emp)
    features = plan_features(emp)

    # contagens atuais do banco
    usage = usage_counts(db, emp.id) or {}

    # current/limit/remaining/percent
    quotas = enforce_quotas_bulk(emp, usage)

    return {
        "plan": plan,
        "limits": limits,
        "features": features,
        "usage": usage,
        "quotas": quotas,
    }