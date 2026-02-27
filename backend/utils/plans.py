# backend/utils/plans.py
from __future__ import annotations

from datetime import datetime, timedelta, timezone
import os
from typing import Optional, Dict, Any, Union

# ============================================================
# Config
# ============================================================
DEFAULT_TRIAL_DAYS = int(os.getenv("TRIAL_DAYS", "7"))  # 7 por padrão

# ✅ Planos oficiais (novos)
PLAN_FREE = "FREE"
PLAN_START = "START"
PLAN_BUSINESS = "BUSINESS"
PLAN_ENTERPRISE = "ENTERPRISE"

# ✅ Compatibilidade com tiers antigos (se já existir no banco)
LEGACY_TIER_MAP: Dict[str, str] = {
    "PRATA": PLAN_START,
    "OURO": PLAN_BUSINESS,
    "PLATINA": PLAN_BUSINESS,
    "DIAMANTE": PLAN_ENTERPRISE,
    "ASCENDENTE": PLAN_ENTERPRISE,
    "IMORTAL": PLAN_ENTERPRISE,
    "RADIANTE": PLAN_ENTERPRISE,

    # já novos:
    "FREE": PLAN_FREE,
    "START": PLAN_START,
    "BUSINESS": PLAN_BUSINESS,
    "ENTERPRISE": PLAN_ENTERPRISE,
}

def normalize_plan(tier: Optional[str]) -> str:
    """
    Normaliza o plano/tier para os nomes oficiais.
    Se vier tier antigo (PRATA/OURO/DIAMANTE), converte via LEGACY_TIER_MAP.
    """
    t = (tier or PLAN_FREE).strip().upper()
    return LEGACY_TIER_MAP.get(t, PLAN_FREE)

# ============================================================
# Matriz oficial de limites e features (fonte única)
# - FREE = igual START (como você pediu)
# ============================================================
PLAN_ENTITLEMENTS: Dict[str, Dict[str, Dict[str, Any]]] = {
    PLAN_FREE: {  # igual START
        "limits": {
            "whatsapp_instances_max": 2,
            "users_max": 3,
            "departments_max": 3,
            "contacts_max": 2000,
            "broadcasts_per_month_max": 2000,
            "active_campaigns_max": 1,
            "automation_rules_max": 10,
        },
        "features": {
            "feature_automation": True,
            "feature_advanced_automation": False,
            "feature_reports_basic": True,
            "feature_reports_advanced": False,
            "feature_api_webhooks": False,
            "feature_audit_log": False,
            "feature_export": False,
        },
    },

    PLAN_START: {
        "limits": {
            "whatsapp_instances_max": 2,
            "users_max": 3,
            "departments_max": 3,
            "contacts_max": 2000,
            "broadcasts_per_month_max": 2000,
            "active_campaigns_max": 1,
            "automation_rules_max": 10,
        },
        "features": {
            "feature_automation": True,
            "feature_advanced_automation": False,
            "feature_reports_basic": True,
            "feature_reports_advanced": False,
            "feature_api_webhooks": False,
            "feature_audit_log": False,
            "feature_export": False,
        },
    },

    PLAN_BUSINESS: {
        "limits": {
            "whatsapp_instances_max": 4,
            "users_max": 10,
            "departments_max": 10,
            "contacts_max": 10000,
            "broadcasts_per_month_max": 30000,
            "active_campaigns_max": 3,
            "automation_rules_max": 50,
        },
        "features": {
            "feature_automation": True,
            "feature_advanced_automation": True,
            "feature_reports_basic": True,
            "feature_reports_advanced": True,
            "feature_api_webhooks": True,
            "feature_audit_log": False,
            "feature_export": True,
        },
    },

    PLAN_ENTERPRISE: {
        "limits": {
            "whatsapp_instances_max": 10,
            "users_max": 50,
            "departments_max": 50,
            "contacts_max": 100000,
            "broadcasts_per_month_max": 200000,
            "active_campaigns_max": 10,
            "automation_rules_max": 300,
        },
        "features": {
            "feature_automation": True,
            "feature_advanced_automation": True,
            "feature_reports_basic": True,
            "feature_reports_advanced": True,
            "feature_api_webhooks": True,
            "feature_audit_log": True,
            "feature_export": True,
        },
    },
}

PLAN_LIMITS: Dict[str, Dict[str, Any]] = {
    tier: data.get("limits", {})
    for tier, data in PLAN_ENTITLEMENTS.items()
}

# ============================================================
# Tempo
# ============================================================
def now_utc() -> datetime:
    return datetime.now(timezone.utc)

# ============================================================
# Trial
# ============================================================
def start_start_trial(empresa, days: Optional[int] = None) -> None:
    """
    Marca a empresa como FREE com trial START por N dias.
    (Como FREE = START, na prática é o mesmo conjunto de permissões)
    """
    days = int(days or DEFAULT_TRIAL_DAYS)
    empresa.assinatura = PLAN_FREE
    empresa.trial_tier = PLAN_START
    empresa.trial_expires_at = now_utc() + timedelta(days=days)

# ✅ compatibilidade: seu código antigo chamava "start_prata_trial"
def start_prata_trial(empresa, days: Optional[int] = None) -> None:
    return start_start_trial(empresa, days=days)

def is_trial_active(empresa) -> bool:
    return bool(
        getattr(empresa, "trial_tier", None)
        and getattr(empresa, "trial_expires_at", None)
        and now_utc() < empresa.trial_expires_at
    )

def effective_tier(empresa) -> str:
    """
    Tier efetivo considerando trial; senão assinatura (ou FREE).
    Mantém nome da função pra não quebrar imports atuais.
    """
    tier = empresa.trial_tier if is_trial_active(empresa) else (empresa.assinatura or PLAN_FREE)
    return normalize_plan(tier)

def effective_plan(empresa) -> str:
    return effective_tier(empresa)

def trial_days_left(empresa) -> int:
    exp = getattr(empresa, "trial_expires_at", None)
    if not exp:
        return 0
    delta = exp - now_utc()
    return max(0, int(delta.total_seconds() // 86400))

# ============================================================
# Entitlements helpers (limits + features)
# ============================================================
def _entitlements_for(tier_or_empresa: Union[str, Any]) -> Dict[str, Dict[str, Any]]:
    """
    Retorna a matriz (limits/features) do plano.
    Aceita string tier OU objeto empresa.
    """
    if hasattr(tier_or_empresa, "assinatura"):
        tier = effective_plan(tier_or_empresa)
    else:
        tier = normalize_plan(str(tier_or_empresa or PLAN_FREE))
    return PLAN_ENTITLEMENTS.get(tier, PLAN_ENTITLEMENTS[PLAN_FREE])

def plan_limits(tier_or_empresa: Union[str, Any]) -> Dict[str, Any]:
    return _entitlements_for(tier_or_empresa)["limits"]

def plan_features(tier_or_empresa: Union[str, Any]) -> Dict[str, bool]:
    return _entitlements_for(tier_or_empresa)["features"]

def limit_value(tier_or_empresa: Union[str, Any], key: str, default: int = 0) -> int:
    v = plan_limits(tier_or_empresa).get(key, default)
    try:
        return int(v)
    except Exception:
        return default

def has_feature(tier_or_empresa: Union[str, Any], feature_key: str) -> bool:
    return bool(plan_features(tier_or_empresa).get(feature_key, False))

# ✅ compatibilidade com seu código antigo: plan_limit() era "limite de instâncias"
def plan_limit(tier_or_empresa: Union[str, Any]) -> int:
    return limit_value(tier_or_empresa, "whatsapp_instances_max", default=0)

# ============================================================
# Payload p/ front (status do plano)
# ============================================================
def plan_status_payload(
    empresa,
    current_instances: int = 0,
    current_counts: Optional[Dict[str, int]] = None,
) -> Dict[str, Any]:
    """
    Status de plano/limites usado no front.
    - Compatível com usage_counts() que retorna CURRENT usando chaves *_max
      (ex.: {"users_max": 3, "departments_max": 2})
    """
    tier = effective_plan(empresa)
    limits = plan_limits(tier)
    features = plan_features(tier)

    counts_raw = dict(current_counts or {})

    inst_current = int(counts_raw.get("whatsapp_instances_max", current_instances or 0))
    inst_limit = int(limits.get("whatsapp_instances_max", 0))

    usage = {
        "whatsapp_instances": inst_current,
        "users": int(counts_raw.get("users_max", 0)),
        "departments": int(counts_raw.get("departments_max", 0)),
        "contacts": int(counts_raw.get("contacts_max", 0)),
        "automation_rules": int(counts_raw.get("automation_rules_max", 0)),
        "broadcasts_month": int(counts_raw.get("broadcasts_per_month_max", 0)),
        "active_campaigns": int(counts_raw.get("active_campaigns_max", 0)),
    }

    return {
        "empresa_id": empresa.id,
        "assinatura": normalize_plan(getattr(empresa, "assinatura", PLAN_FREE)),
        "effective_tier": tier,

        # compat com front atual
        "limite_instancias": inst_limit,
        "quantidade_instancias": inst_current,
        "pode_adicionar": inst_current < inst_limit,

        # matriz completa
        "limits": limits,
        "features": features,

        "counts": counts_raw,
        "usage": usage,

        "trial": {
            "active": is_trial_active(empresa),
            "tier": normalize_plan(getattr(empresa, "trial_tier", None))
                if getattr(empresa, "trial_tier", None) else None,
            "expires_at": getattr(empresa, "trial_expires_at", None).isoformat()
                if getattr(empresa, "trial_expires_at", None) else None,
            "days_left": trial_days_left(empresa),
        },
    }
