from __future__ import annotations

from datetime import datetime, timezone, timedelta
from typing import Any, Dict, Optional, List

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, text
from sqlalchemy.orm import Session, aliased

# ---- seu infra / modelos ----
from backend.database import get_db
from backend.models import (
    Empresa, EmpresaInstancia, Cliente, Usuario, Colaborador,
    Departamento, Setor, Grupo, Mensagem, Midia, Atendimento,
    ChatbotConfig, StatusAtendimento,
    DepartamentoMembro, DepartamentoACL
)

# ✅ sistema unificado de planos
from backend.utils.plans import (
    PLAN_FREE,
    PLAN_START,
    PLAN_BUSINESS,
    PLAN_ENTERPRISE,
    PLAN_CODES,
    PAID_PLANS,
    plan_status_payload,
    effective_plan,
    normalize_plan,
    plan_limits,
    is_trial_active,
    trial_days_left,
)
from backend.routers.auth import require_admin

# Router apenas para ADMIN CENTRAL
router = APIRouter(dependencies=[Depends(require_admin)])


# ============================== helpers ==============================
def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def digits_only(s: str) -> str:
    return "".join(ch for ch in (s or "") if ch.isdigit())


def iso(dt: Optional[datetime]) -> Optional[str]:
    if not dt:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).isoformat()


def parse_iso_datetime(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)
    except Exception:
        raise HTTPException(status_code=400, detail="Data inválida. Use ISO8601.")


def serialize_empresa(emp: Empresa) -> Dict[str, Any]:
    eff = effective_plan(emp)

    return {
        "id": emp.id,
        "nome": emp.nome,
        "telefone": emp.telefone,
        "assinatura": normalize_plan(getattr(emp, "assinatura", None)),
        "trial_tier": (
            normalize_plan(getattr(emp, "trial_tier", None))
            if getattr(emp, "trial_tier", None)
            else None
        ),
        "trial_expires_at": iso(getattr(emp, "trial_expires_at", None)),
        "plano_expira_em": iso(getattr(emp, "plano_expira_em", None)),
        "quantidade_instancias": getattr(emp, "quantidade_instancias", None) or 0,
        "avatar_url": emp.avatar_url,
        "status_numero": emp.status_numero,
        "created_at": iso(emp.created_at),
        "nome_adm": emp.nome_adm,
        "cnpj_cpf": emp.cnpj_cpf,
        "effective_tier": eff,
        "trial_active": is_trial_active(emp),
        "trial_days_left": trial_days_left(emp) if is_trial_active(emp) else 0,
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
    """
    Mantém o payload compatível do admin central,
    mas usa o sistema novo do plans.py como fonte.
    """
    eff = effective_plan(emp)

    limits = plan_limits(eff)
    limite_plano = int(limits.get("whatsapp_instances_max", 0))

    # override manual na empresa, se existir e for > 0
    limite_cfg = int(getattr(emp, "quantidade_instancias", 0) or 0)
    limite = limite_cfg if limite_cfg > 0 else limite_plano

    qtd_conectadas = sum(1 for i in insts if i.connected)

    tri_active = is_trial_active(emp)
    days_left = trial_days_left(emp) if tri_active else 0

    return {
        "effective_tier": eff,
        "limite_instancias": limite,
        "quantidade_instancias": qtd_conectadas,
        "trial": {
            "active": tri_active,
            "tier": (
                normalize_plan(getattr(emp, "trial_tier", None))
                if getattr(emp, "trial_tier", None)
                else None
            ),
            "expires_at": iso(getattr(emp, "trial_expires_at", None)),
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
        (k.value if hasattr(k, "value") else str(k)): int(v)
        for k, v in rows
    }
    return counts


# ======================= 1) CONSULTA POR CPF/CNPJ =======================
@router.get("/api/admin/empresas/by-cnpj")
def admin_buscar_por_cnpj(
    cnpj: str = Query(..., description="CPF ou CNPJ (com ou sem máscara)"),
    db: Session = Depends(get_db),
):
    doc = digits_only(cnpj)
    if not doc:
        raise HTTPException(status_code=400, detail="Informe CPF ou CNPJ.")

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
    emp = db.query(Empresa).filter(Empresa.id == empresa_id).first()
    if not emp:
        raise HTTPException(status_code=404, detail="Empresa não encontrada.")
    return serialize_empresa(emp)


# ======================= 3) STATUS/WHATSAPP (compat) =======================
@router.get("/api/empresas/{empresa_id}/whatsapp")
def empresa_whatsapp_status(empresa_id: int, db: Session = Depends(get_db)):
    emp = db.query(Empresa).filter(Empresa.id == empresa_id).first()
    if not emp:
        raise HTTPException(status_code=404, detail="Empresa não encontrada.")
    insts = db.query(EmpresaInstancia).filter(EmpresaInstancia.empresa_id == empresa_id).all()
    return empresa_status_payload(emp, insts)


# ======================= 4) OVERVIEW COMPLETO =======================
@router.get("/api/admin/empresas/{empresa_id}/overview")
def empresa_overview(
    empresa_id: int,
    db: Session = Depends(get_db),
    limit: int = Query(50, ge=1, le=500, description="Limite de itens por lista"),
):
    emp = db.query(Empresa).filter(Empresa.id == empresa_id).first()
    if not emp:
        raise HTTPException(status_code=404, detail="Empresa não encontrada.")

    insts = db.query(EmpresaInstancia).filter(EmpresaInstancia.empresa_id == empresa_id).all()
    bots = db.query(ChatbotConfig).filter(ChatbotConfig.empresa_id == empresa_id).all()

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
                "path": d.path,
                "usuarios_count": int(usuarios_por_dep.get(d.id, 0)),
                "membros_count": int(membros_por_dep.get(d.id, 0)),
                "acls_count": int(acls_por_dep.get(d.id, 0)),
            }
            for d in deps
        ],
    }

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
    body:
      {
        "assinatura": "FREE|START|BUSINESS|ENTERPRISE",
        "expires_at": "2026-12-31T23:59:59Z",   # opcional
        "duration_days": 30                     # opcional, usado se expires_at não vier
      }

    Regras:
      - plano pago limpa trial
      - FREE remove expiração
    """
    assinatura = normalize_plan(body.get("assinatura") or PLAN_FREE)
    if assinatura not in PLAN_CODES:
        raise HTTPException(status_code=400, detail="Plano inválido.")

    emp = db.query(Empresa).filter(Empresa.id == empresa_id).first()
    if not emp:
        raise HTTPException(status_code=404, detail="Empresa não encontrada.")

    emp.assinatura = assinatura

    if assinatura == PLAN_FREE:
        emp.plano_expira_em = None
    else:
        exp_str = body.get("expires_at")
        duration_days = int(body.get("duration_days") or 30)
        emp.plano_expira_em = (
            parse_iso_datetime(exp_str)
            if exp_str
            else now_utc() + timedelta(days=duration_days)
        )

    # pago/ajuste manual limpa trial
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
        "detail": "Plano aplicado com sucesso.",
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
    body:
      {
        "tier": "START|BUSINESS|ENTERPRISE",
        "days": 7
      }
    """
    tier = normalize_plan(body.get("tier") or PLAN_START)
    days = int(body.get("days") or 7)

    if tier not in PAID_PLANS:
        raise HTTPException(status_code=400, detail="Tier inválido para trial.")

    emp = db.query(Empresa).filter(Empresa.id == empresa_id).first()
    if not emp:
        raise HTTPException(status_code=404, detail="Empresa não encontrada.")

    # trial mantém assinatura atual, só ativa trial_tier temporário
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