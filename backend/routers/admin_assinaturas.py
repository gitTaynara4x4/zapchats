from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Optional

import jwt
from fastapi import APIRouter, Depends, Header, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import func, text
from sqlalchemy.orm import Session

from backend.database import get_db_session
import backend.models as models
from backend.utils.plans import (
    PLAN_CATALOG,
    PLAN_FREE,
    PLAN_START,
    PLAN_BUSINESS,
    PLAN_ENTERPRISE,
    effective_plan,
    is_trial_active,
    normalize_plan,
    plan_catalog_item,
    plan_limits,
    plan_status_payload,
    start_trial,
    trial_days_left,
)

router = APIRouter(prefix="/api/admin-saas", tags=["Admin SaaS"])

ADMIN_SAAS_PASSWORD = (os.getenv("ADMIN_SAAS_PASSWORD")).strip()
ADMIN_SAAS_JWT_SECRET = (
    os.getenv("ADMIN_SAAS_JWT_SECRET")
    or os.getenv("JWT_SECRET")
    or "troque-me"
).strip()
ADMIN_SAAS_JWT_ALG = "HS256"
ADMIN_SAAS_JWT_HOURS = int((os.getenv("ADMIN_SAAS_JWT_HOURS") or "12").strip())

OVERRIDE_TABLE = "empresa_plan_overrides"
ADMIN_LOGS_TABLE = "empresa_admin_logs"  # <-- NOVA TABELA DE LOGS
ACTIVE_CAMPAIGN_STATUSES = ("pendente", "processando")


class AdminLoginIn(BaseModel):
    password: str


class ApplyPlanIn(BaseModel):
    assinatura: str
    expires_at: Optional[str] = None
    duration_days: Optional[int] = Field(default=30, ge=1, le=3650)


class StartTrialIn(BaseModel):
    tier: str = PLAN_START
    days: int = Field(default=7, ge=1, le=365)


class OverrideLimitsIn(BaseModel):
    whatsapp_instances_max: Optional[int] = Field(default=None, ge=0, le=1000000)
    users_max: Optional[int] = Field(default=None, ge=0, le=1000000)
    departments_max: Optional[int] = Field(default=None, ge=0, le=1000000)
    contacts_max: Optional[int] = Field(default=None, ge=0, le=100000000)
    broadcasts_per_month_max: Optional[int] = Field(default=None, ge=0, le=100000000)
    active_campaigns_max: Optional[int] = Field(default=None, ge=0, le=1000000)
    automation_rules_max: Optional[int] = Field(default=None, ge=0, le=1000000)


class LoginConfigIn(BaseModel):
    requer_token_login: bool


class SearchFilters(BaseModel):
    q: Optional[str] = None
    plan: Optional[str] = None
    status: Optional[str] = None
    page: int = 1
    limit: int = 20


# =========================
# Helpers Base
# =========================
def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _to_iso(dt: Optional[datetime]) -> Optional[str]:
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).isoformat()


def _safe_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except Exception:
        return default


def _require_admin_saas(
    authorization: str | None = Header(default=None, alias="Authorization"),
):
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Token admin ausente.")

    token = authorization.split(" ", 1)[1].strip()
    try:
        payload = jwt.decode(token, ADMIN_SAAS_JWT_SECRET, algorithms=[ADMIN_SAAS_JWT_ALG]) or {}
    except jwt.PyJWTError:
        raise HTTPException(status_code=401, detail="Token admin inválido.")

    if payload.get("scope") != "admin_saas":
        raise HTTPException(status_code=401, detail="Escopo admin inválido.")

    return payload


def _make_admin_token() -> str:
    now = _now_utc()
    payload = {
        "scope": "admin_saas",
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(hours=ADMIN_SAAS_JWT_HOURS)).timestamp()),
    }
    return jwt.encode(payload, ADMIN_SAAS_JWT_SECRET, algorithm=ADMIN_SAAS_JWT_ALG)


# =========================
# Helpers de Logs (NOVO)
# =========================
def _ensure_log_table(db: Session) -> None:
    db.execute(
        text(
            f"""
            CREATE TABLE IF NOT EXISTS {ADMIN_LOGS_TABLE} (
                id SERIAL PRIMARY KEY,
                empresa_id INTEGER NOT NULL,
                acao VARCHAR(255) NOT NULL,
                criado_em TIMESTAMP NOT NULL DEFAULT NOW()
            )
            """
        )
    )
    db.commit()


def _add_log(db: Session, empresa_id: int, acao: str) -> None:
    _ensure_log_table(db)
    db.execute(
        text(f"INSERT INTO {ADMIN_LOGS_TABLE} (empresa_id, acao, criado_em) VALUES (:emp, :acao, :now)"),
        {"emp": int(empresa_id), "acao": acao, "now": _now_utc()},
    )
    db.commit()


def _get_logs(db: Session, empresa_id: int, limit: int = 20) -> list[Dict[str, Any]]:
    _ensure_log_table(db)
    rows = db.execute(
        text(
            f"SELECT acao, criado_em FROM {ADMIN_LOGS_TABLE} WHERE empresa_id = :emp ORDER BY id DESC LIMIT :limit"
        ),
        {"emp": int(empresa_id), "limit": limit},
    ).mappings().all()

    return [{"acao": r["acao"], "criado_em": _to_iso(r["criado_em"])} for r in rows]


# =========================
# Helpers de Overrides e Info
# =========================
def _ensure_override_table(db: Session) -> None:
    db.execute(
        text(
            f"""
            CREATE TABLE IF NOT EXISTS {OVERRIDE_TABLE} (
                empresa_id INTEGER PRIMARY KEY,
                whatsapp_instances_max INTEGER NULL,
                users_max INTEGER NULL,
                departments_max INTEGER NULL,
                contacts_max INTEGER NULL,
                broadcasts_per_month_max INTEGER NULL,
                active_campaigns_max INTEGER NULL,
                automation_rules_max INTEGER NULL,
                updated_at TIMESTAMP NULL
            )
            """
        )
    )
    db.commit()


def _get_overrides(db: Session, empresa_id: int) -> Dict[str, Optional[int]]:
    _ensure_override_table(db)
    row = db.execute(
        text(
            f"""
            SELECT
                whatsapp_instances_max,
                users_max,
                departments_max,
                contacts_max,
                broadcasts_per_month_max,
                active_campaigns_max,
                automation_rules_max,
                updated_at
            FROM {OVERRIDE_TABLE}
            WHERE empresa_id = :empresa_id
            """
        ),
        {"empresa_id": int(empresa_id)},
    ).mappings().first()

    if not row:
        return {
            "whatsapp_instances_max": None,
            "users_max": None,
            "departments_max": None,
            "contacts_max": None,
            "broadcasts_per_month_max": None,
            "active_campaigns_max": None,
            "automation_rules_max": None,
            "updated_at": None,
        }

    return {
        "whatsapp_instances_max": row.get("whatsapp_instances_max"),
        "users_max": row.get("users_max"),
        "departments_max": row.get("departments_max"),
        "contacts_max": row.get("contacts_max"),
        "broadcasts_per_month_max": row.get("broadcasts_per_month_max"),
        "active_campaigns_max": row.get("active_campaigns_max"),
        "automation_rules_max": row.get("automation_rules_max"),
        "updated_at": _to_iso(row.get("updated_at")),
    }


def _save_overrides(db: Session, empresa_id: int, payload: OverrideLimitsIn) -> Dict[str, Optional[int]]:
    _ensure_override_table(db)
    now = _now_utc()
    data = payload.model_dump()

    db.execute(
        text(
            f"""
            INSERT INTO {OVERRIDE_TABLE} (
                empresa_id,
                whatsapp_instances_max,
                users_max,
                departments_max,
                contacts_max,
                broadcasts_per_month_max,
                active_campaigns_max,
                automation_rules_max,
                updated_at
            ) VALUES (
                :empresa_id,
                :whatsapp_instances_max,
                :users_max,
                :departments_max,
                :contacts_max,
                :broadcasts_per_month_max,
                :active_campaigns_max,
                :automation_rules_max,
                :updated_at
            )
            ON CONFLICT (empresa_id)
            DO UPDATE SET
                whatsapp_instances_max = EXCLUDED.whatsapp_instances_max,
                users_max = EXCLUDED.users_max,
                departments_max = EXCLUDED.departments_max,
                contacts_max = EXCLUDED.contacts_max,
                broadcasts_per_month_max = EXCLUDED.broadcasts_per_month_max,
                active_campaigns_max = EXCLUDED.active_campaigns_max,
                automation_rules_max = EXCLUDED.automation_rules_max,
                updated_at = EXCLUDED.updated_at
            """
        ),
        {
            "empresa_id": int(empresa_id),
            **data,
            "updated_at": now,
        },
    )
    db.commit()
    return _get_overrides(db, empresa_id)


def _plan_status(emp: models.Empresa) -> str:
    if normalize_plan(getattr(emp, "assinatura", None)) != PLAN_FREE:
        exp = getattr(emp, "plano_expira_em", None)
        if exp is not None:
            exp_cmp = exp if exp.tzinfo else exp.replace(tzinfo=timezone.utc)
            if exp_cmp < _now_utc():
                return "past_due"
        return "active"

    if is_trial_active(emp):
        return "trial"

    return "free"


def _empresa_or_404(db: Session, empresa_id: int) -> models.Empresa:
    emp = db.query(models.Empresa).filter(models.Empresa.id == int(empresa_id)).first()
    if not emp:
        raise HTTPException(status_code=404, detail="Empresa não encontrada.")
    return emp


def _counts_for_empresa(db: Session, empresa_id: int) -> Dict[str, int]:
    empresa_id = int(empresa_id)

    clientes = db.query(func.count(models.Cliente.id)).filter(models.Cliente.empresa_id == empresa_id).scalar() or 0
    usuarios = db.query(func.count(models.Usuario.id)).filter(models.Usuario.empresa_id == empresa_id).scalar() or 0
    colaboradores = db.query(func.count(models.Colaborador.id)).filter(models.Colaborador.empresa_id == empresa_id).scalar() or 0
    departamentos = db.query(func.count(models.Departamento.id)).filter(models.Departamento.empresa_id == empresa_id).scalar() or 0
    instancias_total = db.query(func.count(models.EmpresaInstancia.id)).filter(models.EmpresaInstancia.empresa_id == empresa_id).scalar() or 0
    instancias_conectadas = (
        db.query(func.count(models.EmpresaInstancia.id))
        .filter(models.EmpresaInstancia.empresa_id == empresa_id)
        .filter(models.EmpresaInstancia.connected.is_(True))
        .scalar()
        or 0
    )

    now = _now_utc()
    month_start = datetime(now.year, now.month, 1, tzinfo=timezone.utc)
    if now.month == 12:
        month_end = datetime(now.year + 1, 1, 1, tzinfo=timezone.utc)
    else:
        month_end = datetime(now.year, now.month + 1, 1, tzinfo=timezone.utc)

    disparos_mes = (
        db.query(func.count(models.Disparo.id))
        .filter(models.Disparo.empresa_id == empresa_id)
        .filter(models.Disparo.criado_em >= month_start)
        .filter(models.Disparo.criado_em < month_end)
        .scalar()
        or 0
    )

    campanhas_ativas = (
        db.query(func.count(models.Disparo.id))
        .filter(models.Disparo.empresa_id == empresa_id)
        .filter(models.Disparo.status.in_(ACTIVE_CAMPAIGN_STATUSES))
        .scalar()
        or 0
    )

    return {
        "contacts": int(clientes),
        "users": int(usuarios),
        "colaboradores": int(colaboradores),
        "team_members": int(usuarios) + int(colaboradores),
        "departments": int(departamentos),
        "whatsapp_instances": int(instancias_total),
        "whatsapp_instances_connected": int(instancias_conectadas),
        "broadcasts_month": int(disparos_mes),
        "active_campaigns": int(campanhas_ativas),
    }


def _merged_limits(emp: models.Empresa, overrides: Dict[str, Optional[int]]) -> Dict[str, int]:
    base = dict(plan_limits(emp))

    if overrides.get("whatsapp_instances_max") is not None:
        base["whatsapp_instances_max"] = _safe_int(overrides["whatsapp_instances_max"], 0)
    if overrides.get("users_max") is not None:
        base["users_max"] = _safe_int(overrides["users_max"], 0)
    if overrides.get("departments_max") is not None:
        base["departments_max"] = _safe_int(overrides["departments_max"], 0)
    if overrides.get("contacts_max") is not None:
        base["contacts_max"] = _safe_int(overrides["contacts_max"], 0)
    if overrides.get("broadcasts_per_month_max") is not None:
        base["broadcasts_per_month_max"] = _safe_int(overrides["broadcasts_per_month_max"], 0)
    if overrides.get("active_campaigns_max") is not None:
        base["active_campaigns_max"] = _safe_int(overrides["active_campaigns_max"], 0)
    if overrides.get("automation_rules_max") is not None:
        base["automation_rules_max"] = _safe_int(overrides["automation_rules_max"], 0)

    quantidade_instancias = _safe_int(getattr(emp, "quantidade_instancias", 0), 0)
    if quantidade_instancias > 0:
        base["whatsapp_instances_max"] = quantidade_instancias

    return {k: _safe_int(v, 0) for k, v in base.items()}


def _serialize_empresa_summary(db: Session, emp: models.Empresa) -> Dict[str, Any]:
    overrides = _get_overrides(db, emp.id)
    limits = _merged_limits(emp, overrides)
    counts = _counts_for_empresa(db, emp.id)
    catalog = plan_catalog_item(emp)
    status_payload = plan_status_payload(emp, current_instances=counts["whatsapp_instances_connected"]) or {}

    return {
        "id": int(emp.id),
        "nome": emp.nome,
        "telefone": emp.telefone,
        "cnpj_cpf": getattr(emp, "cnpj_cpf", None),
        "nome_adm": getattr(emp, "nome_adm", None),
        "created_at": _to_iso(getattr(emp, "created_at", None)),
        "assinatura": normalize_plan(getattr(emp, "assinatura", None)),
        "effective_tier": effective_plan(emp),
        "plan_name": catalog.get("name"),
        "price_monthly": catalog.get("price_monthly"),
        "subscription_status": _plan_status(emp),
        "trial": {
            "active": is_trial_active(emp),
            "tier": normalize_plan(getattr(emp, "trial_tier", None)) if getattr(emp, "trial_tier", None) else None,
            "expires_at": _to_iso(getattr(emp, "trial_expires_at", None)),
            "days_left": trial_days_left(emp),
        },
        "plano_expira_em": _to_iso(getattr(emp, "plano_expira_em", None)),
        "requer_token_login": bool(getattr(emp, "requer_token_login", False)),
        "avatar_url": getattr(emp, "avatar_url", None),
        "status_numero": getattr(emp, "status_numero", None),
        "counts": counts,
        "limits": limits,
        "overrides": overrides,
        "plan_status": status_payload,
    }


def _recent_disparos(db: Session, empresa_id: int, limit: int = 10) -> list[Dict[str, Any]]:
    rows = (
        db.query(models.Disparo)
        .filter(models.Disparo.empresa_id == int(empresa_id))
        .order_by(models.Disparo.criado_em.desc())
        .limit(limit)
        .all()
    )
    out: list[Dict[str, Any]] = []
    for row in rows:
        out.append(
            {
                "id": int(row.id),
                "mensagem": (row.mensagem or "")[:180],
                "status": row.status,
                "criado_em": _to_iso(row.criado_em),
                "total_destinatarios": _safe_int(row.total_destinatarios, 0),
                "enviados_sucesso": _safe_int(row.enviados_sucesso, 0),
                "enviados_erro": _safe_int(row.enviados_erro, 0),
                "instancia_id": row.instancia_id,
            }
        )
    return out


# =========================
# Auth
# =========================
@router.post("/auth/login")
def admin_saas_login(body: AdminLoginIn):
    senha = (body.password or "").strip()

    if not senha:
        raise HTTPException(status_code=400, detail="Informe a senha.")

    if senha != ADMIN_SAAS_PASSWORD:
        raise HTTPException(status_code=401, detail="Senha inválida.")

    token = _make_admin_token()
    return {
        "ok": True,
        "token": token,
        "expires_in_hours": ADMIN_SAAS_JWT_HOURS,
    }

@router.get("/session")
def admin_saas_session(_: dict = Depends(_require_admin_saas)):
    return {"ok": True}


@router.get("/catalog")
def admin_saas_catalog(_: dict = Depends(_require_admin_saas)):
    public_items = []
    for code in (PLAN_START, PLAN_BUSINESS, PLAN_ENTERPRISE):
        item = dict(PLAN_CATALOG.get(code, {}))
        public_items.append(item)
    return {"ok": True, "plans": public_items}


# =========================
# Empresas / listagem
# =========================
@router.get("/empresas")
def list_empresas(
    q: Optional[str] = Query(default=None),
    plan: Optional[str] = Query(default=None),
    status_filter: Optional[str] = Query(default=None, alias="status"),
    page: int = Query(default=1, ge=1),
    limit: int = Query(default=20, ge=1, le=100),
    db: Session = Depends(get_db_session),
    _: dict = Depends(_require_admin_saas),
):
    query = db.query(models.Empresa)

    if q:
        like = f"%{q.strip()}%"
        query = query.filter(
            (models.Empresa.nome.ilike(like))
            | (models.Empresa.nome_adm.ilike(like))
            | (models.Empresa.telefone.ilike(like))
            | (models.Empresa.cnpj_cpf.ilike(like))
        )

    plan_norm = normalize_plan(plan) if plan else None
    if plan and plan_norm != PLAN_FREE:
        query = query.filter(models.Empresa.assinatura.in_([plan_norm, plan.upper()]))

    total = query.count()
    items = (
        query.order_by(models.Empresa.created_at.desc(), models.Empresa.id.desc())
        .offset((page - 1) * limit)
        .limit(limit)
        .all()
    )

    rows = [_serialize_empresa_summary(db, emp) for emp in items]

    if plan and plan_norm == PLAN_FREE:
        rows = [r for r in rows if r["effective_tier"] == PLAN_FREE]
    if status_filter:
        rows = [r for r in rows if r["subscription_status"] == status_filter]

    mrr = 0
    for row in rows:
        if row["subscription_status"] in {"active", "trial"} and row.get("price_monthly"):
            mrr += _safe_int(row["price_monthly"], 0)

    return {
        "ok": True,
        "page": page,
        "limit": limit,
        "total": total,
        "mrr_visible": mrr,
        "items": rows,
    }


@router.get("/empresas/{empresa_id}")
def get_empresa_detail(
    empresa_id: int,
    db: Session = Depends(get_db_session),
    _: dict = Depends(_require_admin_saas),
):
    emp = _empresa_or_404(db, empresa_id)
    summary = _serialize_empresa_summary(db, emp)

    overview_counts = summary["counts"]
    recent_disparos = _recent_disparos(db, empresa_id, limit=10)
    logs_admin = _get_logs(db, empresa_id) # <-- BUSCA OS LOGS DO HISTÓRICO

    instancias = (
        db.query(models.EmpresaInstancia)
        .filter(models.EmpresaInstancia.empresa_id == int(empresa_id))
        .order_by(models.EmpresaInstancia.id.desc())
        .limit(20)
        .all()
    )

    inst_items = [
        {
            "id": int(i.id),
            "instance_name": getattr(i, "instance_name", None),
            "apelido": getattr(i, "apelido", None),
            "numero_instancia": getattr(i, "numero_instancia", None),
            "connected": bool(getattr(i, "connected", False)),
            "last_seen": _to_iso(getattr(i, "last_seen", None)),
        }
        for i in instancias
    ]

    return {
        "ok": True,
        "empresa": summary,
        "instancias": inst_items,
        "recent_disparos": recent_disparos,
        "counts": overview_counts,
        "logs": logs_admin, # <-- RETORNA PRO FRONT
    }


# =========================
# Ações
# =========================
@router.post("/empresas/{empresa_id}/apply-plan")
def apply_plan(
    empresa_id: int,
    body: ApplyPlanIn,
    db: Session = Depends(get_db_session),
    _: dict = Depends(_require_admin_saas),
):
    emp = _empresa_or_404(db, empresa_id)
    assinatura = normalize_plan(body.assinatura)

    if assinatura not in {PLAN_FREE, PLAN_START, PLAN_BUSINESS, PLAN_ENTERPRISE}:
        raise HTTPException(status_code=400, detail="Plano inválido.")

    emp.assinatura = assinatura
    emp.trial_tier = None
    emp.trial_expires_at = None

    if assinatura == PLAN_FREE:
        emp.plano_expira_em = None
    else:
        if body.expires_at:
            try:
                emp.plano_expira_em = datetime.fromisoformat(body.expires_at.replace("Z", "+00:00"))
            except Exception:
                raise HTTPException(status_code=400, detail="expires_at inválido. Use ISO 8601.")
        else:
            emp.plano_expira_em = _now_utc() + timedelta(days=int(body.duration_days or 30))

    db.add(emp)
    db.commit()
    db.refresh(emp)

    _add_log(db, empresa_id, f"Alterou assinatura manual para: {assinatura}") # <-- GRAVA LOG

    return {
        "ok": True,
        "detail": "Plano aplicado com sucesso.",
        "empresa": _serialize_empresa_summary(db, emp),
    }


@router.post("/empresas/{empresa_id}/start-trial")
def start_trial_endpoint(
    empresa_id: int,
    body: StartTrialIn,
    db: Session = Depends(get_db_session),
    _: dict = Depends(_require_admin_saas),
):
    emp = _empresa_or_404(db, empresa_id)
    tier = normalize_plan(body.tier)
    if tier == PLAN_FREE:
        tier = PLAN_START

    start_trial(emp, tier=tier, days=int(body.days))
    db.add(emp)
    db.commit()
    db.refresh(emp)

    _add_log(db, empresa_id, f"Iniciou trial de {body.days} dias no plano {tier}") # <-- GRAVA LOG

    return {
        "ok": True,
        "detail": f"Trial iniciado em {tier} por {body.days} dias.",
        "empresa": _serialize_empresa_summary(db, emp),
    }


@router.post("/empresas/{empresa_id}/cancel-trial")
def cancel_trial_endpoint(
    empresa_id: int,
    db: Session = Depends(get_db_session),
    _: dict = Depends(_require_admin_saas),
):
    emp = _empresa_or_404(db, empresa_id)
    emp.trial_tier = None
    emp.trial_expires_at = None
    db.add(emp)
    db.commit()
    db.refresh(emp)

    _add_log(db, empresa_id, "Cancelou o trial manualmente") # <-- GRAVA LOG

    return {
        "ok": True,
        "detail": "Trial cancelado.",
        "empresa": _serialize_empresa_summary(db, emp),
    }


@router.get("/empresas/{empresa_id}/overrides")
def get_overrides(
    empresa_id: int,
    db: Session = Depends(get_db_session),
    _: dict = Depends(_require_admin_saas),
):
    _empresa_or_404(db, empresa_id)
    return {"ok": True, "overrides": _get_overrides(db, empresa_id)}


@router.post("/empresas/{empresa_id}/overrides")
def save_overrides(
    empresa_id: int,
    body: OverrideLimitsIn,
    db: Session = Depends(get_db_session),
    _: dict = Depends(_require_admin_saas),
):
    _empresa_or_404(db, empresa_id)
    data = _save_overrides(db, empresa_id, body)
    emp = _empresa_or_404(db, empresa_id)

    _add_log(db, empresa_id, "Alterou os limites customizados da empresa") # <-- GRAVA LOG

    return {
        "ok": True,
        "detail": "Overrides salvos.",
        "overrides": data,
        "empresa": _serialize_empresa_summary(db, emp),
    }


@router.put("/empresas/{empresa_id}/login-config")
def update_login_config(
    empresa_id: int,
    body: LoginConfigIn,
    db: Session = Depends(get_db_session),
    _: dict = Depends(_require_admin_saas),
):
    emp = _empresa_or_404(db, empresa_id)
    emp.requer_token_login = bool(body.requer_token_login)
    db.add(emp)
    db.commit()
    db.refresh(emp)

    status = "Habilitou" if body.requer_token_login else "Desabilitou"
    _add_log(db, empresa_id, f"{status} a exigência de Token 2FA de Login") # <-- GRAVA LOG

    return {
        "ok": True,
        "detail": "Configuração de login atualizada.",
        "empresa": _serialize_empresa_summary(db, emp),
    }