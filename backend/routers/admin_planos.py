from __future__ import annotations

import os
from datetime import datetime, timezone, timedelta
from typing import Optional, Dict, Any

from fastapi import APIRouter, Depends, HTTPException, Query, Header, status
from sqlalchemy.orm import Session
from sqlalchemy import func

from backend.database import get_db_session
import backend.models as models

from backend.utils.plans import (
    PLAN_FREE,
    PLAN_START,
    PLAN_BUSINESS,
    PLAN_ENTERPRISE,
    PLAN_CODES,
    PAID_PLANS,
    normalize_plan,
    plan_status_payload,
    start_trial,
)


router = APIRouter(prefix="/api/admin", tags=["Admin / Planos"])

# ====== Proteção por senha fixa (sem login) ======
ADMIN_PASS = (os.getenv("ADMIN_PLANOS_PASS") or "promessa20").strip()


def _require_promessa20(
    x_admin_pass: str | None = Header(default=None, alias="X-Admin-Pass"),
):
    """
    Protege as rotas deste router usando senha fixa enviada no header X-Admin-Pass.
    """
    if (x_admin_pass or "").strip() != ADMIN_PASS:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Senha admin inválida.",
        )
    return True


# ====== Helpers internos ======
def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _parse_iso_datetime(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)
    except Exception:
        raise HTTPException(
            status_code=400,
            detail="expires_at inválido. Use ISO8601, ex.: 2026-12-31T23:59:59Z",
        )


def _digits_only(s: str) -> str:
    return "".join(ch for ch in (s or "") if ch.isdigit())


def _by_cnpj(db: Session, cnpj: str) -> models.Empresa:
    doc = _digits_only(cnpj)
    if not doc:
        raise HTTPException(status_code=400, detail="CNPJ obrigatório.")

    try:
        emp = (
            db.query(models.Empresa)
            .filter(func.regexp_replace(models.Empresa.cnpj_cpf, r"[^0-9]", "", "g") == doc)
            .first()
        )
    except Exception:
        emp = (
            db.query(models.Empresa)
            .filter(models.Empresa.cnpj_cpf == doc)
            .first()
        )

    if not emp:
        raise HTTPException(status_code=404, detail="Empresa não encontrada pelo CNPJ.")
    return emp


def _connected_instances_count(db: Session, empresa_id: int) -> int:
    return (
        db.query(models.EmpresaInstancia)
        .filter(
            models.EmpresaInstancia.empresa_id == empresa_id,
            models.EmpresaInstancia.connected.is_(True),
        )
        .count()
    )


def _empresa_payload(emp: models.Empresa, connected: int) -> Dict[str, Any]:
    status_payload = plan_status_payload(emp, connected)
    return {
        "id": emp.id,
        "nome": emp.nome,
        "cnpj_cpf": emp.cnpj_cpf,
        "telefone": emp.telefone,
        "assinatura": normalize_plan(getattr(emp, "assinatura", None)),
        "trial_tier": (
            normalize_plan(getattr(emp, "trial_tier", None))
            if getattr(emp, "trial_tier", None)
            else None
        ),
        "trial_expires_at": (
            emp.trial_expires_at.isoformat()
            if getattr(emp, "trial_expires_at", None)
            else None
        ),
        "plano_expira_em": (
            emp.plano_expira_em.isoformat()
            if getattr(emp, "plano_expira_em", None)
            else None
        ),
        "effective_tier": status_payload["effective_tier"],
        "quantidade_instancias": int(getattr(emp, "quantidade_instancias", 0) or 0),
    }


# ====== Endpoints ======
@router.get("/empresas/by-cnpj")
def get_empresa_by_cnpj(
    cnpj: str = Query(..., description="CNPJ/CPF com ou sem máscara"),
    db: Session = Depends(get_db_session),
    _: bool = Depends(_require_promessa20),
):
    emp = _by_cnpj(db, cnpj)
    connected = _connected_instances_count(db, emp.id)

    return {
        "ok": True,
        "empresa": _empresa_payload(emp, connected),
        "status": plan_status_payload(emp, connected),
    }


@router.post("/empresas/{empresa_id}/apply-plan")
def apply_paid_plan(
    empresa_id: int,
    body: Dict[str, Any],
    db: Session = Depends(get_db_session),
    _: bool = Depends(_require_promessa20),
):
    """
    Aplica plano pago ou FREE.
    body:
      {
        "assinatura": "FREE|START|BUSINESS|ENTERPRISE",
        "expires_at": "2026-12-31T23:59:59Z",   # opcional
        "duration_days": 30                     # opcional, usado se expires_at não vier
      }

    Regras:
      - ao aplicar qualquer plano, limpa trial
      - FREE remove plano_expira_em
    """
    assinatura = normalize_plan((body or {}).get("assinatura") or PLAN_FREE)
    if assinatura not in PLAN_CODES:
        raise HTTPException(
            status_code=400,
            detail="Plano inválido. Use FREE, START, BUSINESS ou ENTERPRISE.",
        )

    emp = (
        db.query(models.Empresa)
        .filter(models.Empresa.id == empresa_id)
        .first()
    )
    if not emp:
        raise HTTPException(status_code=404, detail="Empresa não encontrada.")

    emp.assinatura = assinatura

    if assinatura == PLAN_FREE:
        emp.plano_expira_em = None
    else:
        expires_at = _parse_iso_datetime((body or {}).get("expires_at"))
        duration_days = int((body or {}).get("duration_days") or 30)
        emp.plano_expira_em = expires_at or (now_utc() + timedelta(days=duration_days))

    emp.trial_tier = None
    emp.trial_expires_at = None

    db.add(emp)
    db.commit()
    db.refresh(emp)

    connected = _connected_instances_count(db, emp.id)
    return {
        "ok": True,
        "empresa": _empresa_payload(emp, connected),
        "status": plan_status_payload(emp, connected),
        "detail": "Plano aplicado com sucesso.",
    }


@router.post("/empresas/{empresa_id}/cancel-trial")
def cancel_trial(
    empresa_id: int,
    db: Session = Depends(get_db_session),
    _: bool = Depends(_require_promessa20),
):
    emp = (
        db.query(models.Empresa)
        .filter(models.Empresa.id == empresa_id)
        .first()
    )
    if not emp:
        raise HTTPException(status_code=404, detail="Empresa não encontrada.")

    emp.trial_tier = None
    emp.trial_expires_at = None
    db.add(emp)
    db.commit()
    db.refresh(emp)

    connected = _connected_instances_count(db, emp.id)
    return {
        "ok": True,
        "empresa": _empresa_payload(emp, connected),
        "status": plan_status_payload(emp, connected),
        "detail": "Trial cancelado.",
    }


@router.post("/empresas/{empresa_id}/start-trial")
def restart_trial(
    empresa_id: int,
    body: Dict[str, Any] | None = None,
    db: Session = Depends(get_db_session),
    _: bool = Depends(_require_promessa20),
):
    """
    Reinicia trial.
    body opcional:
      {
        "tier": "START|BUSINESS|ENTERPRISE",
        "days": 7
      }
    """
    payload = body or {}
    tier = normalize_plan(payload.get("tier") or PLAN_START)
    if tier not in PAID_PLANS:
        raise HTTPException(
            status_code=400,
            detail="Tier inválido para trial. Use START, BUSINESS ou ENTERPRISE.",
        )

    days: Optional[int] = None
    if "days" in payload and payload.get("days") is not None:
        try:
            days = int(payload["days"])
        except Exception:
            raise HTTPException(status_code=400, detail="days inválido.")
        if days <= 0:
            raise HTTPException(status_code=400, detail="days deve ser maior que zero.")

    emp = (
        db.query(models.Empresa)
        .filter(models.Empresa.id == empresa_id)
        .first()
    )
    if not emp:
        raise HTTPException(status_code=404, detail="Empresa não encontrada.")

    start_trial(emp, tier=tier, days=days)
    db.add(emp)
    db.commit()
    db.refresh(emp)

    connected = _connected_instances_count(db, emp.id)
    return {
        "ok": True,
        "empresa": _empresa_payload(emp, connected),
        "status": plan_status_payload(emp, connected),
        "detail": f"Trial iniciado ({tier}, {days or 'padrão'} dias).",
    }