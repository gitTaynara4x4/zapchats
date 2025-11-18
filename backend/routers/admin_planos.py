# backend/routers/admin_planos.py
from __future__ import annotations

from typing import Optional, Literal, Dict, Any

from fastapi import APIRouter, Depends, HTTPException, Query, Header, status
from sqlalchemy.orm import Session

from backend.database import get_db_session
import backend.models as models

from backend.utils.plans import (
    plan_status_payload,
    start_prata_trial,
    is_trial_active,
    effective_tier,
)

Tier = Literal["FREE", "PRATA", "OURO", "PLATINA", "DIAMANTE", "ASCENDENTE", "IMORTAL", "RADIANTE"]

router = APIRouter(prefix="/api/admin", tags=["Admin / Planos"])

# ====== Proteção por senha fixa (sem login) ======
ADMIN_PASS = "promessa20"


def _require_promessa20(
    x_admin_pass: str | None = Header(default=None, alias="X-Admin-Pass"),
):
    """
    Protege as rotas deste router usando apenas a senha fixa 'promessa20',
    enviada no header X-Admin-Pass.

    - Se o header estiver ausente ou incorreto -> 401.
    - Não depende de get_current_identity / login normal.
    """
    if x_admin_pass != ADMIN_PASS:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Senha admin inválida.",
        )
    return True


# ====== Helpers internos ======


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


# ====== Endpoints ======


@router.get("/empresas/by-cnpj")
def get_empresa_by_cnpj(
    cnpj: str = Query(..., description="CNPJ exato (apenas dígitos)"),
    db: Session = Depends(get_db_session),
    _: bool = Depends(_require_promessa20),
):
    """
    Busca empresa pelo CNPJ (já normalizado) e retorna payload básico + status de plano.

    Protegido apenas por X-Admin-Pass: promessa20.
    """
    emp = _by_cnpj(db, cnpj)

    # instâncias conectadas atuais
    connected = (
        db.query(models.EmpresaInstancia)
        .filter(
            models.EmpresaInstancia.empresa_id == emp.id,
            models.EmpresaInstancia.connected.is_(True),
        )
        .count()
    )

    status_payload = plan_status_payload(emp, connected)
    return {
        "ok": True,
        "empresa": {
            "id": emp.id,
            "nome": emp.nome,
            "cnpj_cpf": emp.cnpj_cpf,
            "telefone": emp.telefone,
            "assinatura": emp.assinatura,
            "trial_tier": emp.trial_tier,
            "trial_expires_at": emp.trial_expires_at.isoformat()
            if emp.trial_expires_at
            else None,
            "effective_tier": status_payload["effective_tier"],
            "quantidade_instancias": int(emp.quantidade_instancias or 0),
        },
        "status": status_payload,
    }


@router.post("/empresas/{empresa_id}/apply-plan")
def apply_paid_plan(
    empresa_id: int,
    body: Dict[str, Any],
    db: Session = Depends(get_db_session),
    _: bool = Depends(_require_promessa20),
):
    """
    Aplica plano PAGO e limpa qualquer trial.
    body: { "assinatura": "OURO" }

    Protegido apenas por X-Admin-Pass: promessa20.
    """
    new_tier: Optional[str] = (body or {}).get("assinatura")
    if not new_tier:
        raise HTTPException(400, "assinatura obrigatória (ex.: OURO).")

    emp = (
        db.query(models.Empresa)
        .filter(models.Empresa.id == empresa_id)
        .first()
    )
    if not emp:
        raise HTTPException(404, "Empresa não encontrada.")

    emp.assinatura = str(new_tier).upper()
    emp.trial_tier = None
    emp.trial_expires_at = None
    db.commit()

    # recomputa payload
    connected = (
        db.query(models.EmpresaInstancia)
        .filter(
            models.EmpresaInstancia.empresa_id == emp.id,
            models.EmpresaInstancia.connected.is_(True),
        )
        .count()
    )
    return {"ok": True, "status": plan_status_payload(emp, connected)}


@router.post("/empresas/{empresa_id}/cancel-trial")
def cancel_trial(
    empresa_id: int,
    db: Session = Depends(get_db_session),
    _: bool = Depends(_require_promessa20),
):
    """
    Cancela o trial atual da empresa (se houver).

    Protegido apenas por X-Admin-Pass: promessa20.
    """
    emp = (
        db.query(models.Empresa)
        .filter(models.Empresa.id == empresa_id)
        .first()
    )
    if not emp:
        raise HTTPException(404, "Empresa não encontrada.")

    emp.trial_tier = None
    emp.trial_expires_at = None
    db.commit()

    connected = (
        db.query(models.EmpresaInstancia)
        .filter(
            models.EmpresaInstancia.empresa_id == emp.id,
            models.EmpresaInstancia.connected.is_(True),
        )
        .count()
    )
    return {"ok": True, "status": plan_status_payload(emp, connected)}


@router.post("/empresas/{empresa_id}/start-trial")
def start_trial(
    empresa_id: int,
    body: Dict[str, Any] | None = None,
    db: Session = Depends(get_db_session),
    _: bool = Depends(_require_promessa20),
):
    """
    Recomeça trial PRATA (útil p/ exceções/suporte).
    body opcional: {"days": 7}

    Protegido apenas por X-Admin-Pass: promessa20.
    """
    emp = (
        db.query(models.Empresa)
        .filter(models.Empresa.id == empresa_id)
        .first()
    )
    if not emp:
        raise HTTPException(404, "Empresa não encontrada.")

    days: Optional[int] = None
    if body and "days" in body:
        try:
            days = int(body["days"])
        except Exception:
            days = None

    start_prata_trial(emp, days=days)
    db.commit()

    connected = (
        db.query(models.EmpresaInstancia)
        .filter(
            models.EmpresaInstancia.empresa_id == emp.id,
            models.EmpresaInstancia.connected.is_(True),
        )
        .count()
    )
    return {"ok": True, "status": plan_status_payload(emp, connected)}
