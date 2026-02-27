# backend/utils/entitlements.py
from __future__ import annotations

from typing import Any, Optional, Dict
from fastapi import HTTPException
from sqlalchemy.orm import Session

from backend.utils.plans import plan_limits, has_feature, effective_plan
from backend.utils.usage import usage_counts


def _limit_for(emp: Any, key: str) -> Optional[int]:
    limits = plan_limits(emp)
    v = limits.get(key, None)
    if v is None:
        return None
    try:
        return int(v)
    except Exception:
        return None


def enforce_feature(emp: Any, feature_key: str, *, message: Optional[str] = None) -> None:
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
    Ex.: ao criar 1 novo colaborador: enforce_quota(emp, "users_max", current_users, delta=1)
    """
    limit = _limit_for(emp, key)
    if limit is None:
        return  # sem limite (caso você use None no futuro)
    if (int(current) + int(delta)) > int(limit):
        raise HTTPException(
            status_code=403,
            detail=message or f"Limite do plano atingido para '{key}' ({current}/{limit}).",
        )


def enforce_quotas_bulk(emp: Any, counts: Dict[str, int]) -> Dict[str, Dict[str, int]]:
    """
    Útil pro front: retorna {key: {current, limit}} para exibir "x de y".
    """
    out: Dict[str, Dict[str, int]] = {}
    limits = plan_limits(emp)
    for key, current in counts.items():
        lim = limits.get(key)
        if lim is None:
            continue
        try:
            out[key] = {"current": int(current), "limit": int(lim)}
        except Exception:
            pass
    return out


def entitlements_payload(db: Session, emp: Any) -> Dict[str, Any]:
    """
    Payload único para o front e para decisões de UI:
      - plan: plano efetivo
      - limits: dicionário de limites do plano (quota)
      - features: flags liga/desliga por plano
      - usage: contagens atuais no banco (current)
      - quotas: {key: {current, limit}} pronto pra mostrar "x de y"
    """
    plan = effective_plan(emp)

    limits = plan_limits(emp)

    # Monta features a partir do has_feature para não depender de estrutura interna do plans.py
    # (Se você tiver uma lista fixa de features, coloque aqui.)
    feature_keys = [
        "feature_automation",
        "feature_advanced_automation",
        "feature_reports_basic",
        "feature_reports_advanced",
        "feature_api_webhooks",
        "feature_audit_log",
        "feature_export",
    ]
    features = {k: bool(has_feature(emp, k)) for k in feature_keys}

    # Uso atual (counts)
    usage = usage_counts(db, emp.id)

    # Quotas bonitinhas (current/limit)
    quotas = enforce_quotas_bulk(emp, usage)

    return {
        "plan": plan,
        "limits": limits,
        "features": features,
        "usage": usage,
        "quotas": quotas,
    }
