# backend/utils/plans.py
from __future__ import annotations
from datetime import datetime, timedelta, timezone
import os
from typing import Optional, Dict, Any

# =========================
# Config
# =========================
DEFAULT_TRIAL_DAYS = int(os.getenv("TRIAL_DAYS", "7"))  # 7 por padrão

# Limites por plano (fonte única)
PLAN_LIMITS: Dict[str, int] = {
    "FREE": 0,       # FREE pós-trial não mantém instâncias
    "PRATA": 1,
    "OURO": 2,
    "PLATINA": 3,
    "DIAMANTE": 4,
    "ASCENDENTE": 5,
    "IMORTAL": 6,
    "RADIANTE": 7,
}

# =========================
# Tempo
# =========================
def now_utc() -> datetime:
    return datetime.now(timezone.utc)

# =========================
# Trial
# =========================
def start_prata_trial(empresa, days: Optional[int] = None) -> None:
    """Marca a empresa como FREE com trial PRATA por N dias."""
    days = int(days or DEFAULT_TRIAL_DAYS)
    empresa.assinatura = "FREE"
    empresa.trial_tier = "PRATA"
    empresa.trial_expires_at = now_utc() + timedelta(days=days)

def is_trial_active(empresa) -> bool:
    return bool(
        getattr(empresa, "trial_tier", None)
        and getattr(empresa, "trial_expires_at", None)
        and now_utc() < empresa.trial_expires_at
    )

def effective_tier(empresa) -> str:
    """Tier efetivo considerando trial; senão, assinatura (ou FREE)."""
    return (empresa.trial_tier if is_trial_active(empresa) else (empresa.assinatura or "FREE"))

def trial_days_left(empresa) -> int:
    exp = getattr(empresa, "trial_expires_at", None)
    if not exp:
        return 0
    delta = exp - now_utc()
    return max(0, int(delta.total_seconds() // 86400))

# =========================
# Limites e payload p/ front
# =========================
def plan_limit(tier_or_empresa) -> int:
    """Aceita string tier OU o objeto empresa."""
    if hasattr(tier_or_empresa, "assinatura"):
        tier = effective_tier(tier_or_empresa)
    else:
        tier = str(tier_or_empresa or "FREE")
    return PLAN_LIMITS.get(tier.upper(), 0)

def plan_status_payload(empresa, current_instances: int) -> Dict[str, Any]:
    """Status de plano/limite usado no front."""
    tier = effective_tier(empresa)
    limite = plan_limit(tier)
    return {
        "empresa_id": empresa.id,
        "assinatura": empresa.assinatura,
        "effective_tier": tier,
        "limite_instancias": limite,
        "quantidade_instancias": int(current_instances or 0),
        "pode_adicionar": int(current_instances or 0) < limite,
        "trial": {
            "active": is_trial_active(empresa),
            "tier": getattr(empresa, "trial_tier", None),
            "expires_at": getattr(empresa, "trial_expires_at", None).isoformat()
                if getattr(empresa, "trial_expires_at", None) else None,
            "days_left": trial_days_left(empresa),
        },
    }
