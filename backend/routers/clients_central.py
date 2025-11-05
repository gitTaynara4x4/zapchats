from __future__ import annotations

from datetime import datetime, timezone, timedelta
from math import ceil
from typing import Any, Dict, Optional, List

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, text
from sqlalchemy.orm import Session, aliased

# ---- seu infra / modelos ----
from backend.database import get_db
from backend.models import (
    Empresa, EmpresaInstancia, Cliente, Usuario, Colaborador,
    Departamento, Setor, Grupo, Mensagem, Midia, Atendimento,
    ChatbotConfig, StatusAtendimento, PlanoAssinatura,
    DepartamentoMembro, DepartamentoACL
)
from backend.utils.plans import PLAN_LIMITS  # ex.: {"FREE":0,"PRATA":1,...}
from backend.routers.auth import require_admin

# Router apenas para ADMIN CENTRAL
# dependencies garantem que apenas identity.is_admin == True acesse
router = APIRouter(dependencies=[Depends(require_admin)])  # manter paths absolutos (sem prefixo global)


# ============================== helpers ==============================
def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def digits_only(s: str) -> str:
    return "".join(ch for ch in (s or "") if ch.isdigit())


def iso(dt: Optional[datetime]) -> Optional[str]:
    return dt.astimezone(timezone.utc).isoformat() if dt else None


def plan_limit(tier: Optional[str]) -> int:
    return PLAN_LIMITS.get((tier or "FREE").upper(), 0)


def serialize_empresa(emp: Empresa) -> Dict[str, Any]:
    return {
        "id": emp.id,
        "nome": emp.nome,
        "telefone": emp.telefone,
        "assinatura": (emp.assinatura or "FREE").upper(),
        "trial_tier": (emp.trial_tier or "").upper() if emp.trial_tier else None,
        "trial_expires_at": iso(emp.trial_expires_at),
        "plano_expira_em": iso(emp.plano_expira_em),
        "quantidade_instancias": emp.quantidade_instancias or 0,
        "avatar_url": emp.avatar_url,
        "status_numero": emp.status_numero,
        "created_at": iso(emp.created_at),
        "nome_adm": emp.nome_adm,
        "cnpj_cpf": emp.cnpj_cpf,
        "effective_tier": emp.effective_tier,
    }


def serialize_inst(i: EmpresaInstancia) -> Dict[str, Any]:
    return {
        "id": i.id,
        "instance_name": i.instance_name,
        "apelido": i.apelido,
        "numero_instancia": i.numero_instancia,
        "connected": bool(i.connected),
        "last_seen": iso(i.last_seen),
        "historico_restaurar": i.historico_restaurar or "none",
    }


def serialize_bot(b: ChatbotConfig) -> Dict[str, Any]:
    return {
        "id": b.id,
        "instancia_id": b.instancia_id,
        "ativo": bool(b.ativo),
        "tz": b.tz,
        "welcome_enabled": bool(b.welcome_enabled),
        "welcome_start": b.welcome_start.isoformat() if b.welcome_start else None,
        "welcome_end": b.welcome_end.isoformat() if b.welcome_end else None,
        "off_enabled": bool(b.off_enabled),
        "off_start": b.off_start.isoformat() if b.off_start else None,
        "off_end": b.off_end.isoformat() if b.off_end else None,
    }


def empresa_status_payload(emp: Empresa, insts: List[EmpresaInstancia]) -> Dict[str, Any]:
    eff = emp.effective_tier
    # se houver quantidade_instancias configurada na empresa, usa como limite; senão cai no plano
    limite_cfg = (emp.quantidade_instancias or 0)
    limite = limite_cfg if limite_cfg > 0 else plan_limit(eff)

    qtd_con = sum(1 for i in insts if i.connected)

    tri_active = emp.trial_active
    days_left = 0
    if tri_active and emp.trial_expires_at:
        delta = emp.trial_expires_at - now_utc()
        days_left = max(0, ceil(delta.total_seconds() / 86400))

    return {
        "effective_tier": eff,
        "limite_instancias": limite,
        "quantidade_instancias": qtd_con,
        "trial": {
            "active": tri_active,
            "tier": (emp.trial_tier or "").upper() if emp.trial_tier else None,
            "expires_at": iso(emp.trial_expires_at),
            "days_left": days_left,
        },
        "instancias": [serialize_inst(i) for i in insts],
    }


def counts_for_empresa(db: Session, empresa_id: int) -> Dict[str, Any]:
    q = lambda Model: db.query(func.count(Model.id)).filter(
        getattr(Model, "empresa_id") == empresa_id
    ).scalar() or 0

    counts = {
        "clientes": q(Cliente),
        "usuarios": q(Usuario),
        "colaboradores": q(Colaborador),
        "departamentos": q(Departamento),
        "setores": q(Setor),
        "grupos": q(Grupo),
        "mensagens": q(Mensagem),
        "midias": q(Midia),
        "instancias": q(EmpresaInstancia),
    }

    # atendimentos por empresa (via join pela instancia)
    total_open = (
        db.query(func.count(Atendimento.id))
        .join(EmpresaInstancia, Atendimento.instancia_id == EmpresaInstancia.id)
        .filter(EmpresaInstancia.empresa_id == empresa_id)
        .filter(Atendimento.status != StatusAtendimento.RESOLVIDO)
        .scalar()
        or 0
    )
    counts["atendimentos_abertos"] = total_open

    rows = (
        db.query(Atendimento.status, func.count(Atendimento.id))
        .join(EmpresaInstancia, Atendimento.instancia_id == EmpresaInstancia.id)
        .filter(EmpresaInstancia.empresa_id == empresa_id)
        .group_by(Atendimento.status)
        .all()
    )
    counts["atendimentos_por_status"] = {
        (k.value if hasattr(k, "value") else str(k)): int(v) for k, v in rows
    }
    return counts


# ======================= 1) CONSULTA POR CPF/CNPJ =======================
@router.get("/api/admin/empresas/by-cnpj")
def admin_buscar_por_cnpj(
    cnpj: str = Query(..., description="CPF ou CNPJ (com ou sem máscara)"),
    db: Session = Depends(get_db),
):
    """
    Resolve a empresa pelo documento e retorna:
      - empresa (serialize_empresa)
      - status (tier efetivo, limite, trial, instâncias resumidas)

    Protegido por require_admin (router-level).
    """
    doc = digits_only(cnpj)
    if not doc:
        raise HTTPException(status_code=400, detail="Informe CPF ou CNPJ.")

    # normaliza a coluna no Postgres removendo não-dígitos; fallback simples se regex não estiver disponível
    try:
        norm_col = func.regexp_replace(Empresa.cnpj_cpf, r"[^0-9]", "", "g")
        emp: Optional[Empresa] = db.query(Empresa).filter(norm_col == doc).first()
    except Exception:
        emp = db.query(Empresa).filter(Empresa.cnpj_cpf == doc).first()

    if not emp:
        raise HTTPException(status_code=404, detail="Empresa não encontrada.")

    insts = db.query(EmpresaInstancia).filter(EmpresaInstancia.empresa_id == emp.id).all()
    return {
        "ok": True,
        "empresa": serialize_empresa(emp),
        "status": empresa_status_payload(emp, insts),
    }


# ======================= 2) EMPRESA BÁSICA (compat) =======================
@router.get("/api/empresas/{empresa_id}")
def empresa_by_id(empresa_id: int, db: Session = Depends(get_db)):
    """
    Compat: detalhes básicos da empresa.
    Acesso restrito a administradores (require_admin).
    """
    emp = db.query(Empresa).filter(Empresa.id == empresa_id).first()
    if not emp:
        raise HTTPException(status_code=404, detail="Empresa não encontrada.")
    return serialize_empresa(emp)


# ======================= 3) STATUS/WHATSAPP (compat) =======================
@router.get("/api/empresas/{empresa_id}/whatsapp")
def empresa_whatsapp_status(empresa_id: int, db: Session = Depends(get_db)):
    """
    Compat: status geral das instâncias WhatsApp.
    Acesso restrito a administradores (require_admin).
    """
    emp = db.query(Empresa).filter(Empresa.id == empresa_id).first()
    if not emp:
        raise HTTPException(status_code=404, detail="Empresa não encontrada.")
    insts = db.query(EmpresaInstancia).filter(EmpresaInstancia.empresa_id == empresa_id).all()
    return empresa_status_payload(emp, insts)


# ======================= 4) OVERVIEW COMPLETO (enriquecido) =======================
@router.get("/api/admin/empresas/{empresa_id}/overview")
def empresa_overview(
    empresa_id: int,
    db: Session = Depends(get_db),
    limit: int = Query(50, ge=1, le=500, description="Limite de itens por lista"),
):
    emp = db.query(Empresa).filter(Empresa.id == empresa_id).first()
    if not emp:
        raise HTTPException(status_code=404, detail="Empresa não encontrada.")

    # instâncias e chatbot
    insts = db.query(EmpresaInstancia).filter(EmpresaInstancia.empresa_id == empresa_id).all()
    bots = db.query(ChatbotConfig).filter(ChatbotConfig.empresa_id == empresa_id).all()

    # -------- Usuários (com nome do departamento) --------
    dep_alias = aliased(Departamento)
    total_usuarios = (
        db.query(func.count(Usuario.id))
        .filter(Usuario.empresa_id == empresa_id)
        .scalar()
        or 0
    )
    usuarios_rows = (
        db.query(
            Usuario.id,
            Usuario.nome,
            Usuario.email,
            Usuario.cargo,
            Usuario.is_admin,
            Usuario.departamento_id,
            dep_alias.nome.label("departamento_nome"),
        )
        .outerjoin(dep_alias, Usuario.departamento_id == dep_alias.id)
        .filter(Usuario.empresa_id == empresa_id)
        .order_by(Usuario.nome.asc())
        .limit(limit)
        .all()
    )
    usuarios = {
        "total": total_usuarios,
        "items": [
            {
                "id": r.id,
                "nome": r.nome,
                "email": r.email,
                "cargo": r.cargo,
                "is_admin": bool(r.is_admin),
                "departamento_id": r.departamento_id,
                "departamento_nome": r.departamento_nome,
            }
            for r in usuarios_rows
        ],
    }

    # -------- Colaboradores (setor + contagem de permissões) --------
    set_alias = aliased(Setor)
    total_colabs = (
        db.query(func.count(Colaborador.id))
        .filter(Colaborador.empresa_id == empresa_id)
        .scalar()
        or 0
    )
    colabs_rows = (
        db.query(
            Colaborador.id,
            Colaborador.nome,
            Colaborador.email,
            Colaborador.telefone,
            Colaborador.cargo,
            Colaborador.setor_id,
            Colaborador.usuario_id,
            set_alias.nome.label("setor_nome"),
        )
        .outerjoin(set_alias, Colaborador.setor_id == set_alias.id)
        .filter(Colaborador.empresa_id == empresa_id)
        .order_by(Colaborador.nome.asc())
        .limit(limit)
        .all()
    )
    # contagem de permissões via SQL leve (evita N+1)
    res = db.execute(
        text(
            """
            SELECT cp.colaborador_id AS colaborador_id, COUNT(*) AS c
            FROM colaboradores_permissoes cp
            JOIN colaboradores c ON c.id = cp.colaborador_id
            WHERE c.empresa_id = :emp
            GROUP BY cp.colaborador_id
        """
        ),
        {"emp": empresa_id},
    )
    perms_counts = {row["colaborador_id"]: int(row["c"]) for row in res.mappings()}

    colaboradores = {
        "total": total_colabs,
        "items": [
            {
                "id": r.id,
                "nome": r.nome,
                "email": r.email,
                "telefone": r.telefone,
                "cargo": r.cargo,
                "setor_id": r.setor_id,
                "setor_nome": r.setor_nome,
                "usuario_id": r.usuario_id,
                "permissoes_count": perms_counts.get(r.id, 0),
            }
            for r in colabs_rows
        ],
    }

    # -------- Departamentos (com contagens) --------
    total_deps = (
        db.query(func.count(Departamento.id))
        .filter(Departamento.empresa_id == empresa_id)
        .scalar()
        or 0
    )
    deps = (
        db.query(Departamento)
        .filter(Departamento.empresa_id == empresa_id)
        .order_by(Departamento.nome.asc())
        .limit(limit)
        .all()
    )

    usuarios_por_dep = dict(
        db.query(Usuario.departamento_id, func.count(Usuario.id))
        .filter(Usuario.empresa_id == empresa_id)
        .group_by(Usuario.departamento_id)
        .all()
    )
    membros_por_dep = dict(
        db.query(DepartamentoMembro.departamento_id, func.count(DepartamentoMembro.id))
        .filter(DepartamentoMembro.empresa_id == empresa_id)
        .group_by(DepartamentoMembro.departamento_id)
        .all()
    )
    acls_por_dep = dict(
        db.query(DepartamentoACL.departamento_id, func.count(DepartamentoACL.id))
        .filter(DepartamentoACL.empresa_id == empresa_id)
        .group_by(DepartamentoACL.departamento_id)
        .all()
    )
    departamentos = {
        "total": total_deps,
        "items": [
            {
                "id": d.id,
                "nome": d.nome,
                "codigo": d.codigo,
                "ativo": bool(d.ativo),
                "parent_id": d.parent_id,
                "chefe_id": d.chefe_id,
                "path": d.path,  # array (se existir)
                "usuarios_count": int(usuarios_por_dep.get(d.id, 0)),
                "membros_count": int(membros_por_dep.get(d.id, 0)),
                "acls_count": int(acls_por_dep.get(d.id, 0)),
            }
            for d in deps
        ],
    }

    # -------- Setores (com total de colaboradores) --------
    total_set = (
        db.query(func.count(Setor.id))
        .filter(Setor.empresa_id == empresa_id)
        .scalar()
        or 0
    )
    set_rows = (
        db.query(Setor)
        .filter(Setor.empresa_id == empresa_id)
        .order_by(Setor.nome.asc())
        .limit(limit)
        .all()
    )
    colabs_por_setor = dict(
        db.query(Colaborador.setor_id, func.count(Colaborador.id))
        .filter(Colaborador.empresa_id == empresa_id)
        .group_by(Colaborador.setor_id)
        .all()
    )
    setores = {
        "total": total_set,
        "items": [
            {
                "id": s.id,
                "nome": s.nome,
                "colaboradores_count": int(colabs_por_setor.get(s.id, 0)),
            }
            for s in set_rows
        ],
    }

    return {
        "empresa": serialize_empresa(emp),
        "counts": counts_for_empresa(db, empresa_id),
        "instancias": [serialize_inst(i) for i in insts],
        "chatbot_configs": [serialize_bot(b) for b in bots],
        "status": empresa_status_payload(emp, insts),
        "usuarios": usuarios,
        "colaboradores": colaboradores,
        "departamentos": departamentos,
        "setores": setores,
    }


# ======================= 5) AÇÕES: plano / trial =======================
@router.post("/api/admin/empresas/{empresa_id}/apply-plan")
def aplicar_plano(
    empresa_id: int,
    body: Dict[str, Any],
    db: Session = Depends(get_db),
):
    """
    body: { "assinatura": "PRATA|OURO|...|FREE", "expires_at": "2026-12-31T23:59:59Z" (opcional) }
    - Ao aplicar um plano PAGO, o trial é limpo.
    - Se assinatura = FREE, plano_expira_em fica NULL (sem pago ativo).

    Acesso restrito a administradores (require_admin).
    """
    assinatura = (body.get("assinatura") or "FREE").upper()
    if assinatura not in (["FREE"] + [p.value for p in PlanoAssinatura]):
        raise HTTPException(status_code=400, detail="Plano inválido.")

    emp = db.query(Empresa).filter(Empresa.id == empresa_id).first()
    if not emp:
        raise HTTPException(status_code=404, detail="Empresa não encontrada.")

    emp.assinatura = assinatura

    exp_str = body.get("expires_at")
    emp.plano_expira_em = None
    if assinatura != "FREE" and exp_str:
        try:
            emp.plano_expira_em = datetime.fromisoformat(exp_str.replace("Z", "+00:00"))
        except Exception:
            raise HTTPException(status_code=400, detail="expires_at inválido (ISO8601).")

    # limpar trial quando vira pago
    emp.trial_tier = None
    emp.trial_expires_at = None

    db.add(emp)
    db.commit()
    db.refresh(emp)

    insts = db.query(EmpresaInstancia).filter(EmpresaInstancia.empresa_id == empresa_id).all()
    return {
        "ok": True,
        "empresa": serialize_empresa(emp),
        "status": empresa_status_payload(emp, insts),
        "detail": "Plano aplicado e trial limpo.",
    }


@router.post("/api/admin/empresas/{empresa_id}/cancel-trial")
def cancelar_trial(empresa_id: int, db: Session = Depends(get_db)):
    emp = db.query(Empresa).filter(Empresa.id == empresa_id).first()
    if not emp:
        raise HTTPException(status_code=404, detail="Empresa não encontrada.")
    emp.trial_tier = None
    emp.trial_expires_at = None
    db.add(emp)
    db.commit()
    db.refresh(emp)
    return {
        "ok": True,
        "empresa": serialize_empresa(emp),
        "detail": "Trial cancelado.",
    }


@router.post("/api/admin/empresas/{empresa_id}/start-trial")
def reiniciar_trial(
    empresa_id: int,
    body: Dict[str, Any],
    db: Session = Depends(get_db),
):
    """
    body: { "tier": "PRATA" (default), "days": 7 (default) }

    Acesso restrito a administradores (require_admin).
    """
    tier = (body.get("tier") or "PRATA").upper()
    days = int(body.get("days") or 7)
    if tier not in [p.value for p in PlanoAssinatura]:
        raise HTTPException(status_code=400, detail="Tier inválido.")

    emp = db.query(Empresa).filter(Empresa.id == empresa_id).first()
    if not emp:
        raise HTTPException(status_code=404, detail="Empresa não encontrada.")

    emp.trial_tier = tier
    emp.trial_expires_at = now_utc() + timedelta(days=days)

    db.add(emp)
    db.commit()
    db.refresh(emp)

    insts = db.query(EmpresaInstancia).filter(EmpresaInstancia.empresa_id == empresa_id).all()
    return {
        "ok": True,
        "empresa": serialize_empresa(emp),
        "status": empresa_status_payload(emp, insts),
        "detail": f"Trial iniciado ({tier}, {days}d).",
    }
