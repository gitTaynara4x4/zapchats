from __future__ import annotations

from datetime import timezone
from typing import Optional, Dict, Any, List

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from backend.database import get_db
from backend import models
from backend.utils.plans import (
    plan_status_payload,
    effective_plan,
    plan_limit,
    normalize_plan,
)
from backend.routers.auth import get_current_identity

router = APIRouter(prefix="/api/empresas", tags=["Empresas"])


# =========================
# Utils simples
# =========================
def _iso(dt):
    if not dt:
        return None
    try:
        return dt.astimezone(timezone.utc).isoformat()
    except Exception:
        try:
            return dt.isoformat()
        except Exception:
            return None


def _only_digits(s: Optional[str]) -> str:
    return "".join(ch for ch in (s or "") if ch.isdigit())


def _norm_instance_name(s: Optional[str]) -> Optional[str]:
    s = (s or "").strip()
    return s or None


def _norm_instance_number(s: Optional[str]) -> Optional[str]:
    """
    Normaliza para numérico puro (ex.: '5531999999999').
    Não adiciona DDI/DDD — apenas remove não-dígitos.
    """
    d = _only_digits(s)
    return d or None


def _identity_empresa_id(identity) -> Optional[int]:
    """
    Compatível com identity em dict ou objeto.
    """
    if isinstance(identity, dict):
        value = identity.get("empresa_id")
    else:
        value = getattr(identity, "empresa_id", None)

    try:
        return int(value) if value is not None else None
    except Exception:
        return None


def _assert_empresa_access(empresa_id: int, identity) -> int:
    """
    Garante que o usuário só acesse a própria empresa.
    Funciona tanto para usuário quanto para colaborador.
    """
    emp_user = _identity_empresa_id(identity)
    if emp_user is not None and int(emp_user) != int(empresa_id):
        raise HTTPException(status_code=403, detail="Empresa não permitida")
    return int(empresa_id)


# =========================
# Resolução de instância
# =========================
def resolve_instancia_id(
    db: Session,
    *,
    empresa_id: int,
    instancia_id: Optional[int] = None,
    instance_name: Optional[str] = None,
    numero_instancia: Optional[str] = None,
) -> Optional[int]:
    """
    Resolve o id de empresas_instancias para a empresa dada.

    1) Se instancia_id pertencer à empresa -> retorna.
    2) Senão, tenta por instance_name.
    3) Senão, tenta por numero_instancia.

    Retorna None se não encontrar.
    """
    q = db.query(models.EmpresaInstancia).filter(
        models.EmpresaInstancia.empresa_id == int(empresa_id)
    )

    if instancia_id:
        inst = q.filter(models.EmpresaInstancia.id == int(instancia_id)).first()
        if inst:
            return int(inst.id)

    name = _norm_instance_name(instance_name)
    if name:
        inst = q.filter(models.EmpresaInstancia.instance_name == name).first()
        if inst:
            return int(inst.id)

    num = _norm_instance_number(numero_instancia)
    if num:
        inst = q.filter(models.EmpresaInstancia.numero_instancia == num).first()
        if inst:
            return int(inst.id)

    return None


def resolve_instancia_id_from_event(
    db: Session,
    *,
    empresa_id: int,
    event: Dict[str, Any],
) -> Optional[int]:
    """
    Conveniência para eventos (Evolution/Webhook/Rabbit).
    """
    inst_id = event.get("instancia_id") or event.get("instanceId")
    try:
        inst_id = int(inst_id) if inst_id is not None else None
    except Exception:
        inst_id = None

    name = event.get("instance_name") or event.get("instanceName")
    number = (
        event.get("instance_number")
        or event.get("instanceNumber")
        or event.get("numero_instancia")
    )

    return resolve_instancia_id(
        db,
        empresa_id=empresa_id,
        instancia_id=inst_id,
        instance_name=name,
        numero_instancia=number,
    )


# =========================
# Schemas
# =========================
class UpdateApelidoIn(BaseModel):
    apelido: Optional[str] = None


class EmpresaLoginConfigIn(BaseModel):
    """
    Configuração simples de login da empresa.
    """
    requer_token_login: bool = False


# =========================
# Rotas
# =========================
@router.get("/{empresa_id}")
def get_empresa(
    empresa_id: int,
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
):
    _assert_empresa_access(empresa_id, identity)

    emp = db.query(models.Empresa).filter(models.Empresa.id == int(empresa_id)).first()
    if not emp:
        raise HTTPException(status_code=404, detail="Empresa não encontrada")

    tier = effective_plan(emp)
    limite = plan_limit(emp)

    return {
        "id": int(emp.id),
        "nome": emp.nome,
        "telefone": emp.telefone,
        "assinatura": normalize_plan(emp.assinatura),
        "trial_tier": normalize_plan(getattr(emp, "trial_tier", None))
        if getattr(emp, "trial_tier", None)
        else None,
        "trial_expires_at": _iso(getattr(emp, "trial_expires_at", None))
        if getattr(emp, "trial_expires_at", None)
        else None,
        "trial_active": bool(getattr(emp, "trial_active", False)),
        "plano_expira_em": _iso(getattr(emp, "plano_expira_em", None))
        if getattr(emp, "plano_expira_em", None)
        else None,
        "effective_tier": tier,
        "limite_instancias": limite,
        "quantidade_instancias": len(emp.instancias or []),
        "avatar_url": emp.avatar_url,
        "status_numero": emp.status_numero,
        "created_at": _iso(emp.created_at),
        "nome_adm": emp.nome_adm,
        "requer_token_login": bool(getattr(emp, "requer_token_login", False)),
    }


@router.put("/{empresa_id}/login-config")
def update_login_config(
    empresa_id: int,
    payload: EmpresaLoginConfigIn,
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
):
    """
    Atualiza configurações relacionadas ao login da empresa.
    """
    _assert_empresa_access(empresa_id, identity)

    emp = db.query(models.Empresa).filter(models.Empresa.id == int(empresa_id)).first()
    if not emp:
        raise HTTPException(status_code=404, detail="Empresa não encontrada")

    emp.requer_token_login = bool(payload.requer_token_login)

    db.commit()
    db.refresh(emp)

    return {
        "id": int(emp.id),
        "nome": emp.nome,
        "requer_token_login": bool(getattr(emp, "requer_token_login", False)),
    }


@router.get("/{empresa_id}/whatsapp")
def info_whatsapp(
    empresa_id: int,
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
):
    """
    Lista todas as instâncias com seus metadados e devolve
    o status/limite pelo plano para o front travar o botão de adicionar.
    """
    _assert_empresa_access(empresa_id, identity)

    emp = db.query(models.Empresa).filter(models.Empresa.id == int(empresa_id)).first()
    if not emp:
        raise HTTPException(status_code=404, detail="Empresa não encontrada")

    insts: List[Dict[str, Any]] = []
    ativos = 0

    for i in (emp.instancias or []):
        item = {
            "id": int(i.id),
            "instancia_id": int(i.id),
            "apelido": i.apelido,
            "instance_name": i.instance_name,
            "numero_instancia": i.numero_instancia,
            "connected": bool(i.connected),
            "last_seen": _iso(i.last_seen) if i.last_seen else None,
            "historico_restaurar": i.historico_restaurar,

            # saúde do número
            "score": getattr(i, "score", None),
            "score_status": getattr(i, "score_status", None),
            "score_label": getattr(i, "score_label", None),
            "score_resumo": getattr(i, "score_resumo", None),
            "score_motivos": getattr(i, "score_motivos", None) or [],
            "score_metricas": getattr(i, "score_metricas", None) or {},
            "score_recomendacoes": getattr(i, "score_recomendacoes", None) or [],
            "score_atualizado_em": _iso(getattr(i, "score_atualizado_em", None))
            if getattr(i, "score_atualizado_em", None)
            else None,
        }
        insts.append(item)
        if i.connected:
            ativos += 1

    total = len(insts)

    status = plan_status_payload(emp, current_instances=total)
    status.update(
        {
            "ativos": ativos,
            "inativos": total - ativos,
            "instancias": insts,
        }
    )
    return status


@router.patch("/instancias/{instancia_id}/apelido")
def update_apelido(
    instancia_id: int,
    body: UpdateApelidoIn,
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
):
    inst = (
        db.query(models.EmpresaInstancia)
        .filter(models.EmpresaInstancia.id == int(instancia_id))
        .first()
    )
    if not inst:
        raise HTTPException(status_code=404, detail="Instância não encontrada")

    _assert_empresa_access(int(inst.empresa_id), identity)

    apelido = (body.apelido or "").strip()
    inst.apelido = apelido or None

    db.commit()
    db.refresh(inst)

    return {
        "ok": True,
        "id": int(inst.id),
        "apelido": inst.apelido,
    }