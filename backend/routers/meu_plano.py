from __future__ import annotations

import os
from typing import Any, Dict

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session

import backend.models as models
import backend.routers.auth as auth_router
from backend.database import get_db_session
from backend.routers.admin_assinaturas import (
    _counts_for_empresa,
    _get_overrides,
    _merged_limits,
    _plan_status,
    _recent_disparos,
)
from backend.utils.plans import (
    PLAN_CATALOG,
    PLAN_START,
    PLAN_BUSINESS,
    PLAN_ENTERPRISE,
    effective_plan,
    normalize_plan,
    plan_status_payload,
)

router = APIRouter(prefix="/api/meu-plano", tags=["Meu Plano"])

ACCESS_COOKIE_NAME = os.getenv("ACCESS_COOKIE_NAME", "access_token")


def _safe_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except Exception:
        return default


def _resolve_session_payload(request: Request) -> dict:
    token = request.cookies.get(ACCESS_COOKIE_NAME)
    if not token:
        raise HTTPException(status_code=401, detail="Sessão ausente.")

    try:
        payload = auth_router._decode_token(token)
    except Exception:
        raise HTTPException(status_code=401, detail="Sessão inválida.")

    if not isinstance(payload, dict):
        raise HTTPException(status_code=401, detail="Sessão inválida.")

    return payload


def _resolve_empresa_id(request: Request, payload: dict) -> int:
    empresa_id = (
        payload.get("empresa_id")
        or request.cookies.get("empresa_id")
        or request.cookies.get("EMPRESA_ID")
    )

    try:
        empresa_id = int(empresa_id)
    except Exception:
        raise HTTPException(status_code=401, detail="Empresa da sessão não identificada.")

    if empresa_id <= 0:
        raise HTTPException(status_code=401, detail="Empresa da sessão inválida.")

    return empresa_id


def _empresa_or_404(db: Session, empresa_id: int) -> models.Empresa:
    emp = db.query(models.Empresa).filter(models.Empresa.id == int(empresa_id)).first()
    if not emp:
        raise HTTPException(status_code=404, detail="Empresa não encontrada.")
    return emp


def _serialize_company(emp: models.Empresa) -> Dict[str, Any]:
    return {
        "id": int(emp.id),
        "nome": getattr(emp, "nome", None),
        "nome_adm": getattr(emp, "nome_adm", None),
        "telefone": getattr(emp, "telefone", None),
        "cnpj_cpf": getattr(emp, "cnpj_cpf", None),
        "avatar_url": getattr(emp, "avatar_url", None),
        "status_numero": getattr(emp, "status_numero", None),
        "requer_token_login": bool(getattr(emp, "requer_token_login", False)),
    }


def _serialize_instances(db: Session, empresa_id: int) -> list[Dict[str, Any]]:
    rows = (
        db.query(models.EmpresaInstancia)
        .filter(models.EmpresaInstancia.empresa_id == int(empresa_id))
        .order_by(models.EmpresaInstancia.id.desc())
        .limit(20)
        .all()
    )

    items: list[Dict[str, Any]] = []
    for i in rows:
        items.append(
            {
                "id": int(i.id),
                "instance_name": getattr(i, "instance_name", None),
                "apelido": getattr(i, "apelido", None),
                "numero_instancia": getattr(i, "numero_instancia", None),
                "connected": bool(getattr(i, "connected", False)),
                "last_seen": (
                    i.last_seen.isoformat()
                    if getattr(i, "last_seen", None) is not None
                    else None
                ),
            }
        )
    return items


def _serialize_available_plans(current_tier: str) -> list[Dict[str, Any]]:
    current_tier = normalize_plan(current_tier)
    out: list[Dict[str, Any]] = []

    for code in (PLAN_START, PLAN_BUSINESS, PLAN_ENTERPRISE):
        item = dict(PLAN_CATALOG.get(code, {}))
        item["is_current"] = normalize_plan(code) == current_tier
        out.append(item)

    return out


def _has_custom_limits(overrides: dict) -> bool:
    for key in (
        "whatsapp_instances_max",
        "users_max",
        "departments_max",
        "contacts_max",
        "broadcasts_per_month_max",
        "active_campaigns_max",
        "automation_rules_max",
    ):
        if overrides.get(key) is not None:
            return True
    return False


@router.get("")
def get_my_plan(
    request: Request,
    db: Session = Depends(get_db_session),
):
    payload = _resolve_session_payload(request)
    empresa_id = _resolve_empresa_id(request, payload)

    emp = _empresa_or_404(db, empresa_id)

    overrides = _get_overrides(db, empresa_id)
    counts = _counts_for_empresa(db, empresa_id)
    effective_limits = _merged_limits(emp, overrides)

    plan = plan_status_payload(
        emp,
        current_instances=_safe_int(counts.get("whatsapp_instances", 0), 0),
        current_counts=counts,
    ) or {}

    plan["limits"] = effective_limits
    plan["counts"] = counts
    plan["limite_instancias"] = _safe_int(effective_limits.get("whatsapp_instances_max", 0), 0)
    plan["quantidade_instancias"] = _safe_int(counts.get("whatsapp_instances", 0), 0)
    plan["pode_adicionar"] = bool(
        plan["limite_instancias"] > 0
        and plan["quantidade_instancias"] < plan["limite_instancias"]
    )

    plan["usage"] = {
        "whatsapp_instances": _safe_int(counts.get("whatsapp_instances", 0), 0),
        "team_members": _safe_int(counts.get("team_members", 0), 0),
        "departments": _safe_int(counts.get("departments", 0), 0),
        "contacts": _safe_int(counts.get("contacts", 0), 0),
        "broadcasts_month": _safe_int(counts.get("broadcasts_month", 0), 0),
        "active_campaigns": _safe_int(counts.get("active_campaigns", 0), 0),
        "automation_rules": _safe_int(counts.get("automation_rules", 0), 0),
    }

    status = _plan_status(emp, bool(overrides.get("is_suspended", False)))
    current_tier = effective_plan(emp)

    return {
        "ok": True,
        "company": _serialize_company(emp),
        "subscription_status": status,
        "effective_tier": current_tier,
        "custom_limits": _has_custom_limits(overrides),
        "plan": plan,
        "limits_effective": effective_limits,
        "counts": counts,
        "instancias": _serialize_instances(db, empresa_id),
        "recent_disparos": _recent_disparos(db, empresa_id, limit=8),
        "available_plans": _serialize_available_plans(current_tier),
    }