from __future__ import annotations

from datetime import datetime, timedelta, timezone
from math import ceil
import os
from typing import Optional, Dict, Any, Union

# ============================================================
# Config
# ============================================================
DEFAULT_TRIAL_DAYS = int(os.getenv("TRIAL_DAYS", "7") or "7")
DEFAULT_PLAN_CYCLE_DAYS = int(os.getenv("PLAN_CYCLE_DAYS", "30") or "30")
PLAN_DUE_WARNING_DAYS = int(os.getenv("PLAN_DUE_WARNING_DAYS", "5") or "5")

# ============================================================
# Planos oficiais
# ============================================================
PLAN_FREE = "FREE"
PLAN_START = "START"
PLAN_BUSINESS = "BUSINESS"
PLAN_ENTERPRISE = "ENTERPRISE"

PLAN_CODES = (
    PLAN_FREE,
    PLAN_START,
    PLAN_BUSINESS,
    PLAN_ENTERPRISE,
)

PAID_PLANS = (
    PLAN_START,
    PLAN_BUSINESS,
    PLAN_ENTERPRISE,
)

# ============================================================
# Compatibilidade com tiers legados no banco
# ============================================================
LEGACY_TIER_MAP: Dict[str, str] = {
    # legado antigo
    "PRATA": PLAN_START,
    "OURO": PLAN_BUSINESS,
    "PLATINA": PLAN_BUSINESS,
    "DIAMANTE": PLAN_ENTERPRISE,
    "ASCENDENTE": PLAN_ENTERPRISE,
    "IMORTAL": PLAN_ENTERPRISE,
    "RADIANTE": PLAN_ENTERPRISE,

    # oficiais atuais
    "FREE": PLAN_FREE,
    "START": PLAN_START,
    "BUSINESS": PLAN_BUSINESS,
    "ENTERPRISE": PLAN_ENTERPRISE,
}

# ============================================================
# Catálogo oficial
# Fonte única de verdade
# ============================================================
PLAN_CATALOG: Dict[str, Dict[str, Any]] = {
    PLAN_FREE: {
        "code": PLAN_FREE,
        "name": "Free",
        "public_name": "Free",
        "public": False,
        "price_monthly": 0,
        "trial_days": 0,
        "billing_cycle_days": 0,
        "limits": {
            "whatsapp_instances_max": 0,
            "users_max": 1,
            "departments_max": 1,
            "contacts_max": 100,
            "broadcasts_per_month_max": 0,
            "active_campaigns_max": 0,
            "automation_rules_max": 0,
        },
        "features": {
            "feature_automation": False,
            "feature_advanced_automation": False,
            "feature_reports_basic": False,
            "feature_reports_advanced": False,
            "feature_api_webhooks": False,
            "feature_audit_log": False,
            "feature_import": False,
            "feature_export": False,
            "feature_broadcasts": False,
        },
    },

    PLAN_START: {
        "code": PLAN_START,
        "name": "Start",
        "public_name": "Start",
        "public": True,
        "price_monthly": 97,
        "trial_days": DEFAULT_TRIAL_DAYS,
        "billing_cycle_days": DEFAULT_PLAN_CYCLE_DAYS,
        "limits": {
            "whatsapp_instances_max": 2,
            "users_max": 10,
            "departments_max": 10,
            "contacts_max": 5000,
            "broadcasts_per_month_max": 5000,
            "active_campaigns_max": 1,
            "automation_rules_max": 20,
        },
        "features": {
            "feature_automation": True,
            "feature_advanced_automation": False,
            "feature_reports_basic": True,
            "feature_reports_advanced": False,
            "feature_api_webhooks": False,
            "feature_audit_log": False,
            "feature_import": False,
            "feature_export": False,
            "feature_broadcasts": True,
        },
    },

    PLAN_BUSINESS: {
        "code": PLAN_BUSINESS,
        "name": "Business",
        "public_name": "Business",
        "public": True,
        "price_monthly": 197,
        "trial_days": DEFAULT_TRIAL_DAYS,
        "billing_cycle_days": DEFAULT_PLAN_CYCLE_DAYS,
        "limits": {
            "whatsapp_instances_max": 4,
            "users_max": 30,
            "departments_max": 30,
            "contacts_max": 30000,
            "broadcasts_per_month_max": 30000,
            "active_campaigns_max": 3,
            "automation_rules_max": 100,
        },
        "features": {
            "feature_automation": True,
            "feature_advanced_automation": True,
            "feature_reports_basic": True,
            "feature_reports_advanced": True,
            "feature_api_webhooks": False,
            "feature_audit_log": False,
            "feature_import": True,
            "feature_export": True,
            "feature_broadcasts": True,
        },
    },

    PLAN_ENTERPRISE: {
        "code": PLAN_ENTERPRISE,
        "name": "Enterprise",
        "public_name": "Enterprise",
        "public": True,
        "price_monthly": 347,
        "trial_days": DEFAULT_TRIAL_DAYS,
        "billing_cycle_days": DEFAULT_PLAN_CYCLE_DAYS,
        "limits": {
            "whatsapp_instances_max": 10,
            "users_max": 100,
            "departments_max": 100,
            "contacts_max": 200000,
            "broadcasts_per_month_max": 200000,
            "active_campaigns_max": 10,
            "automation_rules_max": 500,
        },
        "features": {
            "feature_automation": True,
            "feature_advanced_automation": True,
            "feature_reports_basic": True,
            "feature_reports_advanced": True,
            "feature_api_webhooks": True,
            "feature_audit_log": True,
            "feature_import": True,
            "feature_export": True,
            "feature_broadcasts": True,
        },
    },
}

# ============================================================
# Compat antiga: alguns arquivos usam PLAN_LIMITS.get(plano, 0)
# Aqui continua sendo "limite de instâncias por plano"
# ============================================================
PLAN_LIMITS: Dict[str, int] = {
    plan_code: int((payload.get("limits") or {}).get("whatsapp_instances_max", 0))
    for plan_code, payload in PLAN_CATALOG.items()
}

# ============================================================
# Tempo
# ============================================================
def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _as_aware_utc(dt: Optional[datetime]) -> Optional[datetime]:
    if dt is None:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _days_left_until(dt: Optional[datetime]) -> int:
    dt = _as_aware_utc(dt)
    if not dt:
        return 0
    delta = dt - now_utc()
    if delta.total_seconds() <= 0:
        return 0
    return max(0, int(ceil(delta.total_seconds() / 86400)))


# ============================================================
# Helpers básicos
# ============================================================
def normalize_plan(tier: Optional[str]) -> str:
    t = str(tier or PLAN_FREE).strip().upper()
    return LEGACY_TIER_MAP.get(t, PLAN_FREE)


def is_valid_plan(tier: Optional[str]) -> bool:
    return normalize_plan(tier) in PLAN_CATALOG


def is_paid_plan(tier: Optional[str]) -> bool:
    return normalize_plan(tier) in PAID_PLANS


def plan_name(tier: Optional[str]) -> str:
    plan = normalize_plan(tier)
    return str(PLAN_CATALOG.get(plan, PLAN_CATALOG[PLAN_FREE]).get("name", "Free"))


def plan_price(tier: Optional[str]) -> int:
    plan = normalize_plan(tier)
    return int(PLAN_CATALOG.get(plan, PLAN_CATALOG[PLAN_FREE]).get("price_monthly", 0) or 0)


def plan_trial_days(tier: Optional[str]) -> int:
    plan = normalize_plan(tier)
    return int(PLAN_CATALOG.get(plan, PLAN_CATALOG[PLAN_FREE]).get("trial_days", 0) or 0)


def plan_cycle_days(tier: Optional[str]) -> int:
    plan = normalize_plan(tier)
    return int(
        PLAN_CATALOG.get(plan, PLAN_CATALOG[PLAN_FREE]).get(
            "billing_cycle_days",
            DEFAULT_PLAN_CYCLE_DAYS,
        ) or DEFAULT_PLAN_CYCLE_DAYS
    )


# ============================================================
# Trial
# ============================================================
def start_trial(empresa, tier: Optional[str] = None, days: Optional[int] = None) -> None:
    """
    Inicia trial do plano informado.
    Mantém assinatura como FREE enquanto o trial está ativo.
    """
    trial_plan = normalize_plan(tier or PLAN_START)
    if trial_plan == PLAN_FREE:
        trial_plan = PLAN_START

    trial_days = int(days or plan_trial_days(trial_plan) or DEFAULT_TRIAL_DAYS)

    empresa.assinatura = PLAN_FREE
    empresa.trial_tier = trial_plan
    empresa.trial_expires_at = now_utc() + timedelta(days=trial_days)
    empresa.plano_expira_em = None


def start_start_trial(empresa, days: Optional[int] = None) -> None:
    start_trial(empresa, tier=PLAN_START, days=days)


def start_business_trial(empresa, days: Optional[int] = None) -> None:
    start_trial(empresa, tier=PLAN_BUSINESS, days=days)


def start_enterprise_trial(empresa, days: Optional[int] = None) -> None:
    start_trial(empresa, tier=PLAN_ENTERPRISE, days=days)


# compat legado
def start_prata_trial(empresa, days: Optional[int] = None) -> None:
    start_start_trial(empresa, days=days)


def is_trial_active(empresa) -> bool:
    trial_tier = getattr(empresa, "trial_tier", None)
    trial_expires_at = _as_aware_utc(getattr(empresa, "trial_expires_at", None))
    if not trial_tier or not trial_expires_at:
        return False
    return now_utc() < trial_expires_at


def trial_days_left(empresa) -> int:
    return _days_left_until(getattr(empresa, "trial_expires_at", None))


# ============================================================
# Plano pago / vencimento
# ============================================================
def clear_paid_plan(empresa) -> None:
    empresa.assinatura = PLAN_FREE
    empresa.plano_expira_em = None


def start_paid_plan(
    empresa,
    tier: Optional[str] = None,
    days: Optional[int] = None,
    clear_trial: bool = True,
) -> None:
    """
    Ativa plano pago a partir de AGORA e define novo vencimento.
    """
    paid_plan = normalize_plan(tier or getattr(empresa, "assinatura", None) or PLAN_START)
    if paid_plan not in PAID_PLANS:
        paid_plan = PLAN_START

    cycle_days = int(days or plan_cycle_days(paid_plan) or DEFAULT_PLAN_CYCLE_DAYS)

    empresa.assinatura = paid_plan
    empresa.plano_expira_em = now_utc() + timedelta(days=cycle_days)

    if clear_trial:
        empresa.trial_tier = None
        empresa.trial_expires_at = None


def restart_paid_cycle(empresa, days: Optional[int] = None) -> None:
    """
    Reinicia o ciclo do plano atual a partir de hoje.
    """
    current_paid = normalize_plan(getattr(empresa, "assinatura", None))
    if current_paid not in PAID_PLANS:
        return

    cycle_days = int(days or plan_cycle_days(current_paid) or DEFAULT_PLAN_CYCLE_DAYS)
    empresa.plano_expira_em = now_utc() + timedelta(days=cycle_days)


def configured_paid_plan_code(empresa) -> Optional[str]:
    """
    Retorna o plano pago configurado na empresa, mesmo que esteja vencido.
    """
    assinatura = normalize_plan(getattr(empresa, "assinatura", None))
    return assinatura if assinatura in PAID_PLANS else None


def paid_expires_at(empresa) -> Optional[datetime]:
    return _as_aware_utc(getattr(empresa, "plano_expira_em", None))


def is_paid_expired(empresa) -> bool:
    assinatura = configured_paid_plan_code(empresa)
    if not assinatura:
        return False

    plano_expira_em = paid_expires_at(empresa)
    if plano_expira_em is None:
        return False

    return now_utc() >= plano_expira_em


def is_paid_active(empresa) -> bool:
    assinatura = configured_paid_plan_code(empresa)
    if not assinatura:
        return False

    plano_expira_em = paid_expires_at(empresa)
    if plano_expira_em is None:
        return True

    return now_utc() < plano_expira_em


def paid_days_left(empresa) -> Optional[int]:
    assinatura = configured_paid_plan_code(empresa)
    if not assinatura:
        return None

    plano_expira_em = paid_expires_at(empresa)
    if plano_expira_em is None:
        return None

    return _days_left_until(plano_expira_em)


def is_paid_expiring_soon(empresa, warning_days: Optional[int] = None) -> bool:
    if not is_paid_active(empresa):
        return False

    left = paid_days_left(empresa)
    if left is None:
        return False

    warn = int(warning_days or PLAN_DUE_WARNING_DAYS)
    return 0 < left <= warn


def _alert_level_from_days_left(days_left: Optional[int], warning_days: int) -> Optional[str]:
    if days_left is None:
        return None
    if days_left <= 0:
        return "expired"
    if days_left == 1:
        return "danger"
    if days_left <= max(1, int(warning_days)):
        return "warning"
    return None


def paid_due_alert_level(empresa, warning_days: Optional[int] = None) -> Optional[str]:
    if is_paid_expired(empresa):
        return "expired"
    if not is_paid_active(empresa):
        return None
    return _alert_level_from_days_left(
        paid_days_left(empresa),
        int(warning_days or PLAN_DUE_WARNING_DAYS),
    )


def trial_due_alert_level(empresa, warning_days: Optional[int] = None) -> Optional[str]:
    if not is_trial_active(empresa):
        return None
    return _alert_level_from_days_left(
        trial_days_left(empresa),
        int(warning_days or PLAN_DUE_WARNING_DAYS),
    )


def is_billing_locked(empresa) -> bool:
    """
    Regra prática com o schema atual:
    - FREE puro: não bloqueia por billing
    - trial ativo: não bloqueia
    - plano pago ativo: não bloqueia
    - plano pago vencido e sem trial ativo: bloqueia
    """
    if is_trial_active(empresa):
        return False

    if is_paid_active(empresa):
        return False

    paid_code = configured_paid_plan_code(empresa)
    if paid_code and is_paid_expired(empresa):
        return True

    return False


def effective_tier(empresa) -> str:
    """
    Prioridade:
      1) plano pago ativo
      2) trial ativo
      3) FREE
    """
    if is_paid_active(empresa):
        return normalize_plan(getattr(empresa, "assinatura", None))

    if is_trial_active(empresa):
        return normalize_plan(getattr(empresa, "trial_tier", None))

    return PLAN_FREE


def effective_plan(empresa) -> str:
    return effective_tier(empresa)


# ============================================================
# Entitlements helpers
# ============================================================
def _plan_code_from_input(tier_or_empresa: Union[str, Any]) -> str:
    if hasattr(tier_or_empresa, "assinatura") or hasattr(tier_or_empresa, "trial_tier"):
        return effective_plan(tier_or_empresa)
    return normalize_plan(str(tier_or_empresa or PLAN_FREE))


def _catalog_entry(tier_or_empresa: Union[str, Any]) -> Dict[str, Any]:
    code = _plan_code_from_input(tier_or_empresa)
    return PLAN_CATALOG.get(code, PLAN_CATALOG[PLAN_FREE])


def plan_catalog_item(tier_or_empresa: Union[str, Any]) -> Dict[str, Any]:
    return dict(_catalog_entry(tier_or_empresa))


def plan_limits(tier_or_empresa: Union[str, Any]) -> Dict[str, Any]:
    return dict(_catalog_entry(tier_or_empresa).get("limits", {}))


def plan_features(tier_or_empresa: Union[str, Any]) -> Dict[str, bool]:
    return dict(_catalog_entry(tier_or_empresa).get("features", {}))


def limit_value(tier_or_empresa: Union[str, Any], key: str, default: int = 0) -> int:
    try:
        return int(plan_limits(tier_or_empresa).get(key, default))
    except Exception:
        return int(default)


def has_feature(tier_or_empresa: Union[str, Any], feature_key: str) -> bool:
    return bool(plan_features(tier_or_empresa).get(feature_key, False))


# compat legado: "plan_limit" = limite de instâncias
def plan_limit(tier_or_empresa: Union[str, Any]) -> int:
    return limit_value(tier_or_empresa, "whatsapp_instances_max", default=0)


# ============================================================
# Payload p/ front
# ============================================================
def _safe_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except Exception:
        return default


def _pick_count(counts: Dict[str, Any], *keys: str, default: int = 0) -> int:
    for key in keys:
        if key in counts:
            return _safe_int(counts.get(key), default)
    return default


def plan_status_payload(
    empresa,
    current_instances: int = 0,
    current_counts: Optional[Dict[str, int]] = None,
) -> Dict[str, Any]:
    tier = effective_plan(empresa)
    catalog = plan_catalog_item(tier)
    limits = plan_limits(tier)
    features = plan_features(tier)

    counts_raw = dict(current_counts or {})

    inst_current = _pick_count(
        counts_raw,
        "whatsapp_instances_max",
        "whatsapp_instances",
        "instancias",
        default=current_instances or 0,
    )
    inst_limit = _safe_int(limits.get("whatsapp_instances_max", 0), 0)

    usage = {
        "whatsapp_instances": inst_current,
        "users": _pick_count(counts_raw, "users_max", "users", "usuarios"),
        "departments": _pick_count(counts_raw, "departments_max", "departments", "departamentos"),
        "contacts": _pick_count(counts_raw, "contacts_max", "contacts", "clientes"),
        "automation_rules": _pick_count(counts_raw, "automation_rules_max", "automation_rules"),
        "broadcasts_month": _pick_count(counts_raw, "broadcasts_per_month_max", "broadcasts_month"),
        "active_campaigns": _pick_count(counts_raw, "active_campaigns_max", "active_campaigns"),
    }

    trial_expires_at = _as_aware_utc(getattr(empresa, "trial_expires_at", None))
    plano_expira_em = paid_expires_at(empresa)

    assinatura_norm = normalize_plan(getattr(empresa, "assinatura", PLAN_FREE))
    paid_plan_code = configured_paid_plan_code(empresa)
    paid_plan_catalog = PLAN_CATALOG.get(paid_plan_code, {}) if paid_plan_code else {}

    paid_left = paid_days_left(empresa)
    paid_active = is_paid_active(empresa)
    paid_expired = is_paid_expired(empresa)
    paid_warning = is_paid_expiring_soon(empresa)

    return {
        "empresa_id": getattr(empresa, "id", None),

        # base
        "assinatura": assinatura_norm,
        "effective_tier": tier,
        "plan_code": tier,
        "plan_name": catalog.get("name"),
        "price_monthly": _safe_int(catalog.get("price_monthly", 0), 0),
        "public": bool(catalog.get("public", False)),

        # compat front atual
        "limite_instancias": inst_limit,
        "quantidade_instancias": inst_current,
        "pode_adicionar": inst_current < inst_limit if inst_limit > 0 else False,

        # catálogo
        "limits": limits,
        "features": features,

        # uso
        "counts": counts_raw,
        "usage": usage,

        # billing / lock
        "billing_locked": is_billing_locked(empresa),
        "configured_paid_plan": paid_plan_code,

        # trial
        "trial": {
            "active": is_trial_active(empresa),
            "tier": normalize_plan(getattr(empresa, "trial_tier", None))
            if getattr(empresa, "trial_tier", None)
            else None,
            "expires_at": trial_expires_at.isoformat() if trial_expires_at else None,
            "days_left": trial_days_left(empresa),
            "alert_level": trial_due_alert_level(empresa),
        },

        # pago
        "paid": {
            "plan_code": paid_plan_code,
            "plan_name": paid_plan_catalog.get("name"),
            "price_monthly": _safe_int(paid_plan_catalog.get("price_monthly", 0), 0),
            "active": paid_active,
            "expired": paid_expired,
            "expires_at": plano_expira_em.isoformat() if plano_expira_em else None,
            "days_left": paid_left,
            "warning_days": PLAN_DUE_WARNING_DAYS,
            "expiring_soon": paid_warning,
            "show_due_alert": bool(paid_warning or paid_expired),
            "alert_level": paid_due_alert_level(empresa),
        },
    }


__all__ = [
    "DEFAULT_TRIAL_DAYS",
    "DEFAULT_PLAN_CYCLE_DAYS",
    "PLAN_DUE_WARNING_DAYS",

    "PLAN_FREE",
    "PLAN_START",
    "PLAN_BUSINESS",
    "PLAN_ENTERPRISE",
    "PLAN_CODES",
    "PAID_PLANS",

    "LEGACY_TIER_MAP",
    "PLAN_CATALOG",
    "PLAN_LIMITS",

    "now_utc",
    "normalize_plan",
    "is_valid_plan",
    "is_paid_plan",
    "plan_name",
    "plan_price",
    "plan_trial_days",
    "plan_cycle_days",

    "start_trial",
    "start_start_trial",
    "start_business_trial",
    "start_enterprise_trial",
    "start_prata_trial",

    "clear_paid_plan",
    "start_paid_plan",
    "restart_paid_cycle",
    "configured_paid_plan_code",
    "paid_expires_at",
    "paid_days_left",
    "is_paid_expired",
    "is_paid_expiring_soon",
    "paid_due_alert_level",
    "trial_due_alert_level",
    "is_billing_locked",

    "is_trial_active",
    "is_paid_active",
    "effective_tier",
    "effective_plan",
    "trial_days_left",

    "plan_catalog_item",
    "plan_limits",
    "plan_features",
    "limit_value",
    "has_feature",
    "plan_limit",

    "plan_status_payload",
]