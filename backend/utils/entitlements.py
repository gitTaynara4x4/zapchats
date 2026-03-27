from __future__ import annotations

from typing import Any, Optional, Dict, Tuple
from fastapi import HTTPException
from sqlalchemy.orm import Session

import backend.models as models
from backend.utils.plans import (
    plan_limits,
    plan_features,
    has_feature as _plan_has_feature,
    effective_plan,
    is_paid_active,
    is_paid_expired,
    is_trial_active,
    is_billing_locked,
    configured_paid_plan_code,
    paid_days_left,
    paid_expires_at,
    trial_days_left,
    trial_due_alert_level,
    paid_due_alert_level,
    plan_status_payload,
)
from backend.utils.usage import usage_counts


# ============================================================
# Helpers internos
# ============================================================
def _safe_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except Exception:
        return default


def _looks_like_session(value: Any) -> bool:
    return isinstance(value, Session) or (
        hasattr(value, "query") and hasattr(value, "execute")
    )


def _extract_db_and_emp_ref(*args) -> Tuple[Optional[Session], Any]:
    """
    Resolve padrões aceitos:

    - (empresa_obj,)
    - (empresa_id,)
    - (db, empresa_obj)
    - (db, empresa_id)
    """
    if not args:
        raise HTTPException(status_code=500, detail="Argumentos insuficientes para resolver empresa.")

    if len(args) == 1:
        return None, args[0]

    first = args[0]
    second = args[1]

    if _looks_like_session(first):
        return first, second

    return None, first


def _resolve_empresa(db: Optional[Session], emp_or_id: Any) -> Any:
    """
    Aceita:
    - objeto empresa
    - empresa_id (int/str numérico), desde que db seja fornecido
    """
    if emp_or_id is None:
        raise HTTPException(status_code=400, detail="Empresa não informada.")

    if hasattr(emp_or_id, "assinatura") or hasattr(emp_or_id, "id"):
        return emp_or_id

    emp_id = None
    try:
        emp_id = int(emp_or_id)
    except Exception:
        pass

    if emp_id is None:
        raise HTTPException(status_code=400, detail="Empresa inválida.")

    if db is None:
        raise HTTPException(
            status_code=500,
            detail="Sessão do banco é obrigatória para resolver empresa por ID.",
        )

    emp = db.query(models.Empresa).filter(models.Empresa.id == emp_id).first()
    if not emp:
        raise HTTPException(status_code=404, detail="Empresa não encontrada.")

    return emp


def _usage_aliases_for_key(key: str) -> tuple[str, ...]:
    mapping = {
        "whatsapp_instances_max": ("whatsapp_instances_max", "whatsapp_instances", "instancias"),
        "users_max": ("users_max", "users", "usuarios"),
        "departments_max": ("departments_max", "departments", "departamentos"),
        "contacts_max": ("contacts_max", "contacts", "clientes"),
        "automation_rules_max": ("automation_rules_max", "automation_rules"),
        "broadcasts_per_month_max": ("broadcasts_per_month_max", "broadcasts_month"),
        "active_campaigns_max": ("active_campaigns_max", "active_campaigns"),
    }
    return mapping.get(key, (key,))


def _usage_current_for_key(db: Session, emp: Any, key: str) -> int:
    usage = usage_counts(db, emp.id) or {}
    for alias in _usage_aliases_for_key(key):
        if alias in usage:
            return _safe_int(usage.get(alias), 0)
    return 0


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


# ============================================================
# Billing / vencimento
# ============================================================
def billing_status(*args) -> Dict[str, Any]:
    """
    Suporta:
      billing_status(emp)
      billing_status(db, emp_ou_id)
    """
    db, emp_ref = _extract_db_and_emp_ref(*args)
    emp = _resolve_empresa(db, emp_ref)

    paid_code = configured_paid_plan_code(emp)
    expires_at = paid_expires_at(emp)

    return {
        "plan": effective_plan(emp),
        "configured_paid_plan": paid_code,
        "paid_active": is_paid_active(emp),
        "paid_expired": is_paid_expired(emp),
        "trial_active": is_trial_active(emp),
        "billing_locked": is_billing_locked(emp),
        "paid_days_left": paid_days_left(emp),
        "paid_expires_at": expires_at.isoformat() if expires_at else None,
        "trial_days_left": trial_days_left(emp),
        "paid_alert_level": paid_due_alert_level(emp),
        "trial_alert_level": trial_due_alert_level(emp),
    }


def enforce_billing_active(
    *args,
    message: Optional[str] = None,
) -> None:
    """
    Bloqueia se a empresa estiver vencida e sem trial cobrindo o acesso.

    Suporta:
      enforce_billing_active(emp)
      enforce_billing_active(db, emp_ou_id)
    """
    db, emp_ref = _extract_db_and_emp_ref(*args)
    emp = _resolve_empresa(db, emp_ref)

    if is_billing_locked(emp):
        raise HTTPException(
            status_code=403,
            detail=message or "Seu plano está vencido. Renove para continuar usando este recurso.",
        )


# ============================================================
# Features
# ============================================================
def has_feature(*args) -> bool:
    """
    Compatível com:

      has_feature(emp, "feature_export")
      has_feature(db, emp_ou_id, "feature_export")
    """
    if len(args) == 2:
        db = None
        emp_ref = args[0]
        feature_key = str(args[1])
    elif len(args) == 3:
        db, emp_ref = _extract_db_and_emp_ref(args[0], args[1])
        feature_key = str(args[2])
    else:
        raise HTTPException(status_code=500, detail="Assinatura inválida para has_feature().")

    emp = _resolve_empresa(db, emp_ref)
    return bool(_plan_has_feature(emp, feature_key))


def enforce_feature(
    *args,
    message: Optional[str] = None,
) -> None:
    """
    Formatos aceitos:
      enforce_feature(emp, "feature_export")
      enforce_feature(db, emp_ou_id, "feature_export")
    """
    if len(args) == 2:
        db = None
        emp_ref = args[0]
        feature_key = str(args[1])
    elif len(args) == 3:
        db, emp_ref = _extract_db_and_emp_ref(args[0], args[1])
        feature_key = str(args[2])
    else:
        raise HTTPException(status_code=500, detail="Assinatura inválida para enforce_feature().")

    emp = _resolve_empresa(db, emp_ref)

    # vencido = bloqueia recurso operacional/premium
    enforce_billing_active(
        emp,
        message=message or "Seu plano está vencido. Renove para continuar usando este recurso.",
    )

    if not _plan_has_feature(emp, feature_key):
        raise HTTPException(
            status_code=403,
            detail=message or f"Recurso não disponível no seu plano ({effective_plan(emp)}).",
        )


# ============================================================
# Quotas
# ============================================================
def enforce_quota(
    *args,
    delta: int = 1,
    message: Optional[str] = None,
    current: Optional[int] = None,
) -> None:
    """
    Bloqueia se current + delta ultrapassar o limite do plano.

    Formatos aceitos:
      enforce_quota(emp, "users_max", current_users, delta=1)
      enforce_quota(db, emp_ou_id, "users_max", delta=1)
      enforce_quota(db, emp_ou_id, "users_max", 7, delta=1)
      enforce_quota(db, emp_ou_id, "users_max", current=7, delta=1)
    """
    db: Optional[Session] = None
    emp_ref: Any = None
    key: Optional[str] = None
    current_i: Optional[int] = current

    if len(args) == 3:
        if _looks_like_session(args[0]):
            db, emp_ref = _extract_db_and_emp_ref(args[0], args[1])
            key = str(args[2])
        else:
            db = None
            emp_ref = args[0]
            key = str(args[1])
            current_i = _safe_int(args[2], 0)

    elif len(args) == 4:
        if _looks_like_session(args[0]):
            db, emp_ref = _extract_db_and_emp_ref(args[0], args[1])
            key = str(args[2])
            current_i = _safe_int(args[3], 0)
        else:
            raise HTTPException(status_code=500, detail="Assinatura inválida para enforce_quota().")
    else:
        raise HTTPException(status_code=500, detail="Assinatura inválida para enforce_quota().")

    emp = _resolve_empresa(db, emp_ref)

    # vencido = não cria / não cresce
    enforce_billing_active(
        emp,
        message=message or "Seu plano está vencido. Renove para continuar criando novos itens.",
    )

    limit = _limit_for(emp, key)

    # None = sem limite
    if limit is None:
        return

    if current_i is None:
        if db is None:
            raise HTTPException(
                status_code=500,
                detail="Sessão do banco é obrigatória para calcular quota automaticamente.",
            )
        current_i = _usage_current_for_key(db, emp, key)

    current_i = _safe_int(current_i, 0)
    delta_i = _safe_int(delta, 0)

    if (current_i + delta_i) > limit:
        raise HTTPException(
            status_code=403,
            detail=message or f"Limite do plano atingido para '{key}' ({current_i}/{limit}).",
        )


def quota_status(
    *args,
) -> Dict[str, Any]:
    """
    Retorna o estado de uma quota específica.

    Formatos aceitos:
      quota_status(emp, "users_max", current_users)
      quota_status(db, emp_ou_id, "users_max")
      quota_status(db, emp_ou_id, "users_max", current)
    """
    db: Optional[Session] = None
    emp_ref: Any = None
    key: Optional[str] = None
    current_i: Optional[int] = None

    if len(args) == 3:
        if _looks_like_session(args[0]):
            db, emp_ref = _extract_db_and_emp_ref(args[0], args[1])
            key = str(args[2])
        else:
            db = None
            emp_ref = args[0]
            key = str(args[1])
            current_i = _safe_int(args[2], 0)

    elif len(args) == 4:
        if _looks_like_session(args[0]):
            db, emp_ref = _extract_db_and_emp_ref(args[0], args[1])
            key = str(args[2])
            current_i = _safe_int(args[3], 0)
        else:
            raise HTTPException(status_code=500, detail="Assinatura inválida para quota_status().")
    else:
        raise HTTPException(status_code=500, detail="Assinatura inválida para quota_status().")

    emp = _resolve_empresa(db, emp_ref)
    limit = _limit_for(emp, key)

    if current_i is None:
        if db is None:
            raise HTTPException(
                status_code=500,
                detail="Sessão do banco é obrigatória para calcular quota automaticamente.",
            )
        current_i = _usage_current_for_key(db, emp, key)

    current_i = _safe_int(current_i, 0)

    if limit is None:
        return {
            "current": current_i,
            "limit": None,
            "remaining": None,
            "percent": None,
            "blocked": False,
            "billing_locked": is_billing_locked(emp),
        }

    remaining = max(0, limit - current_i)
    percent = 0 if limit <= 0 else round((current_i / limit) * 100, 2)

    return {
        "current": current_i,
        "limit": limit,
        "remaining": remaining,
        "percent": percent,
        "blocked": current_i >= limit,
        "billing_locked": is_billing_locked(emp),
    }


def enforce_quotas_bulk(emp: Any, counts: Dict[str, int]) -> Dict[str, Dict[str, Any]]:
    """
    Retorna snapshot pronto para o front.
    """
    out: Dict[str, Dict[str, Any]] = {}
    limits = plan_limits(emp)

    for key, current in (counts or {}).items():
        if key not in limits:
            continue
        out[key] = quota_status(emp, key, current)

    return out


# ============================================================
# Payload único
# ============================================================
def entitlements_payload(db: Session, emp_or_id: Any) -> Dict[str, Any]:
    """
    Payload único para UI e regras de negócio.
    """
    emp = _resolve_empresa(db, emp_or_id)

    plan = effective_plan(emp)
    limits = plan_limits(emp)
    features = plan_features(emp)

    usage = usage_counts(db, emp.id) or {}
    quotas = enforce_quotas_bulk(emp, usage)

    return {
        "plan": plan,
        "limits": limits,
        "features": features,
        "usage": usage,
        "quotas": quotas,
        "billing": billing_status(emp),
        "status": plan_status_payload(emp, current_counts=usage),
    }