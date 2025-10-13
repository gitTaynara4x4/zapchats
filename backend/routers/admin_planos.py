# backend/routers/admin_planos.py
from __future__ import annotations
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session
from typing import Optional, Literal, Dict, Any

from backend.database import get_db_session
import backend.models as models
from backend.routers.auth import get_current_identity

from backend.utils.plans import (
    plan_status_payload,
    start_prata_trial,
    is_trial_active,
    effective_tier,
)

Tier = Literal["FREE","PRATA","OURO","PLATINA","DIAMANTE","ASCENDENTE","IMORTAL","RADIANTE"]

router = APIRouter(prefix="/api/admin", tags=["Admin / Planos"])

def _require_admin(identity: dict):
    # ajuste conforme seu payload de identidade
    is_admin = bool(identity.get("is_admin") or identity.get("admin"))
    if not is_admin:
        raise HTTPException(status_code=403, detail="Acesso restrito a administradores.")

def _by_cnpj(db: Session, cnpj: str) -> models.Empresa:
    if not cnpj:
        raise HTTPException(400, "CNPJ obrigatório.")
    emp = (
        db.query(models.Empresa)
        .filter(models.Empresa.cnpj_cpf == cnpj)
        .first()
    )
    if not emp:
        raise HTTPException(404, "Empresa não encontrada pelo CNPJ.")
    return emp

@router.get("/empresas/by-cnpj")
def get_empresa_by_cnpj(
    cnpj: str = Query(..., description="CNPJ exato"),
    db: Session = Depends(get_db_session),
    identity: dict = Depends(get_current_identity),
):
    _require_admin(identity)
    emp = _by_cnpj(db, cnpj)

    # instâncias conectadas atuais
    connected = db.query(models.EmpresaInstancia).filter(
        models.EmpresaInstancia.empresa_id == emp.id,
        models.EmpresaInstancia.connected.is_(True),
    ).count()

    status = plan_status_payload(emp, connected)
    return {
        "ok": True,
        "empresa": {
            "id": emp.id,
            "nome": emp.nome,
            "cnpj_cpf": emp.cnpj_cpf,
            "telefone": emp.telefone,
            "assinatura": emp.assinatura,
            "trial_tier": emp.trial_tier,
            "trial_expires_at": emp.trial_expires_at.isoformat() if emp.trial_expires_at else None,
            "effective_tier": status["effective_tier"],
            "quantidade_instancias": int(emp.quantidade_instancias or 0),
        },
        "status": status,
    }

@router.post("/empresas/{empresa_id}/apply-plan")
def apply_paid_plan(
    empresa_id: int,
    body: Dict[str, Any],
    db: Session = Depends(get_db_session),
    identity: dict = Depends(get_current_identity),
):
    """
    Aplica plano PAGO e limpa qualquer trial.
    body: { "assinatura": "OURO" }
    """
    _require_admin(identity)
    new_tier: Optional[str] = (body or {}).get("assinatura")
    if not new_tier:
        raise HTTPException(400, "assinatura obrigatória (ex.: OURO).")

    emp = db.query(models.Empresa).filter(models.Empresa.id == empresa_id).first()
    if not emp:
        raise HTTPException(404, "Empresa não encontrada.")

    emp.assinatura = str(new_tier).upper()
    emp.trial_tier = None
    emp.trial_expires_at = None
    db.commit()

    # recomputa payload
    connected = db.query(models.EmpresaInstancia).filter(
        models.EmpresaInstancia.empresa_id == emp.id,
        models.EmpresaInstancia.connected.is_(True),
    ).count()
    return {"ok": True, "status": plan_status_payload(emp, connected)}

@router.post("/empresas/{empresa_id}/cancel-trial")
def cancel_trial(
    empresa_id: int,
    db: Session = Depends(get_db_session),
    identity: dict = Depends(get_current_identity),
):
    _require_admin(identity)
    emp = db.query(models.Empresa).filter(models.Empresa.id == empresa_id).first()
    if not emp:
        raise HTTPException(404, "Empresa não encontrada.")
    emp.trial_tier = None
    emp.trial_expires_at = None
    db.commit()

    connected = db.query(models.EmpresaInstancia).filter(
        models.EmpresaInstancia.empresa_id == emp.id,
        models.EmpresaInstancia.connected.is_(True),
    ).count()
    return {"ok": True, "status": plan_status_payload(emp, connected)}

@router.post("/empresas/{empresa_id}/start-trial")
def start_trial(
    empresa_id: int,
    body: Dict[str, Any] | None = None,
    db: Session = Depends(get_db_session),
    identity: dict = Depends(get_current_identity),
):
    """
    Recomeça trial PRATA (útil p/ exceções/suporte).
    body opcional: {"days": 7}
    """
    _require_admin(identity)
    emp = db.query(models.Empresa).filter(models.Empresa.id == empresa_id).first()
    if not emp:
        raise HTTPException(404, "Empresa não encontrada.")
    days = None
    if body and "days" in body:
        try:
            days = int(body["days"])
        except Exception:
            pass
    start_prata_trial(emp, days=days)
    db.commit()

    connected = db.query(models.EmpresaInstancia).filter(
        models.EmpresaInstancia.empresa_id == emp.id,
        models.EmpresaInstancia.connected.is_(True),
    ).count()
    return {"ok": True, "status": plan_status_payload(emp, connected)}
