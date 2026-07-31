from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import func
from sqlalchemy.orm import Session

from backend import models
from backend.database import get_db
from backend.routers.auth import get_current_identity
from backend.utils.plans import effective_plan, normalize_plan

router = APIRouter(prefix="/api/configuracoes", tags=["Configurações"])


class RelatoSuporteIn(BaseModel):
    tipo: Literal["bug", "sugestao"] = "bug"
    titulo: str = Field(min_length=4, max_length=120)
    descricao: str = Field(min_length=10, max_length=4000)
    pagina: str | None = Field(default=None, max_length=255)


class AcessoEmpresaIn(BaseModel):
    requer_token_login: bool = False


def _to_int(value: Any) -> int | None:
    try:
        parsed = int(value)
    except Exception:
        return None
    return parsed if parsed > 0 else None


def _empresa_id(identity: dict[str, Any]) -> int:
    value = _to_int(identity.get("empresa_id"))
    if not value:
        raise HTTPException(status_code=401, detail="Empresa inválida na sessão")
    return value


def _is_admin(identity: dict[str, Any]) -> bool:
    return bool(identity.get("is_admin"))


def _permissions(identity: dict[str, Any]) -> set[str]:
    return {
        str(item).strip().lower()
        for item in (identity.get("permissoes") or [])
        if str(item).strip()
    }


def _ensure_view(identity: dict[str, Any]) -> None:
    if _is_admin(identity):
        return
    perms = _permissions(identity)
    if not ({"configuracoes.ver", "configuracoes.editar"} & perms):
        raise HTTPException(status_code=403, detail="Sem permissão para visualizar configurações")


def _ensure_edit(identity: dict[str, Any]) -> None:
    if _is_admin(identity):
        return
    if "configuracoes.editar" not in _permissions(identity):
        raise HTTPException(status_code=403, detail="Sem permissão para editar configurações")


def _iso(value: Any) -> str | None:
    if not value:
        return None
    try:
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc).isoformat()
    except Exception:
        return str(value)


def _report_payload(row: models.RelatoSuporte) -> dict[str, Any]:
    return {
        "id": int(row.id),
        "tipo": str(row.tipo or "bug"),
        "titulo": row.titulo,
        "descricao": row.descricao,
        "pagina": row.pagina,
        "status": str(row.status or "aberto"),
        "created_at": _iso(row.created_at),
        "updated_at": _iso(row.updated_at),
    }


@router.get("")
def get_configuracoes_resumo(
    db: Session = Depends(get_db),
    identity: dict[str, Any] = Depends(get_current_identity),
):
    _ensure_view(identity)
    empresa_id = _empresa_id(identity)

    empresa = (
        db.query(models.Empresa)
        .filter(models.Empresa.id == empresa_id)
        .first()
    )
    if not empresa:
        raise HTTPException(status_code=404, detail="Empresa não encontrada")

    relatos = (
        db.query(models.RelatoSuporte)
        .filter(models.RelatoSuporte.empresa_id == empresa_id)
        .order_by(models.RelatoSuporte.created_at.desc(), models.RelatoSuporte.id.desc())
        .limit(6)
        .all()
    )

    instancias_total = (
        db.query(func.count(models.EmpresaInstancia.id))
        .filter(models.EmpresaInstancia.empresa_id == empresa_id)
        .scalar()
        or 0
    )
    instancias_conectadas = (
        db.query(func.count(models.EmpresaInstancia.id))
        .filter(
            models.EmpresaInstancia.empresa_id == empresa_id,
            models.EmpresaInstancia.connected.is_(True),
        )
        .scalar()
        or 0
    )

    return {
        "identity": {
            "nome": identity.get("nome"),
            "email": identity.get("email"),
            "is_admin": _is_admin(identity),
            "can_edit": _is_admin(identity)
            or "configuracoes.editar" in _permissions(identity),
            "can_edit_security": _is_admin(identity),
        },
        "empresa": {
            "id": int(empresa.id),
            "nome": empresa.nome,
            "plano": normalize_plan(effective_plan(empresa)),
            "requer_token_login": bool(getattr(empresa, "requer_token_login", False)),
            "instancias_total": int(instancias_total),
            "instancias_conectadas": int(instancias_conectadas),
        },
        "relatos": [_report_payload(item) for item in relatos],
    }


@router.put("/acesso")
def update_acesso_empresa(
    payload: AcessoEmpresaIn,
    db: Session = Depends(get_db),
    identity: dict[str, Any] = Depends(get_current_identity),
):
    if not _is_admin(identity):
        raise HTTPException(
            status_code=403,
            detail="Somente o administrador pode alterar a segurança de acesso",
        )

    empresa_id = _empresa_id(identity)
    empresa = (
        db.query(models.Empresa)
        .filter(models.Empresa.id == empresa_id)
        .first()
    )
    if not empresa:
        raise HTTPException(status_code=404, detail="Empresa não encontrada")

    empresa.requer_token_login = bool(payload.requer_token_login)
    db.commit()
    db.refresh(empresa)

    return {
        "ok": True,
        "requer_token_login": bool(empresa.requer_token_login),
    }


@router.post("/relatos", status_code=status.HTTP_201_CREATED)
def create_relato_suporte(
    payload: RelatoSuporteIn,
    db: Session = Depends(get_db),
    identity: dict[str, Any] = Depends(get_current_identity),
):
    _ensure_edit(identity)
    empresa_id = _empresa_id(identity)

    titulo = " ".join((payload.titulo or "").split()).strip()
    descricao = (payload.descricao or "").strip()
    pagina = " ".join((payload.pagina or "").split()).strip() or None

    if len(titulo) < 4:
        raise HTTPException(status_code=422, detail="Informe um título mais claro")
    if len(descricao) < 10:
        raise HTTPException(status_code=422, detail="Descreva melhor o relato")

    usuario_id = _to_int(identity.get("usuario_id"))
    colaborador_id = _to_int(
        identity.get("colaborador_id")
        or identity.get("id_colab")
        or identity.get("id_colaborador")
        or identity.get("colab_id")
        or identity.get("cid")
    )

    since = datetime.now(timezone.utc) - timedelta(hours=24)
    actor_query = db.query(func.count(models.RelatoSuporte.id)).filter(
        models.RelatoSuporte.empresa_id == empresa_id,
        models.RelatoSuporte.created_at >= since,
    )
    if colaborador_id:
        actor_query = actor_query.filter(models.RelatoSuporte.colaborador_id == colaborador_id)
    elif usuario_id:
        actor_query = actor_query.filter(models.RelatoSuporte.usuario_id == usuario_id)

    if int(actor_query.scalar() or 0) >= 10:
        raise HTTPException(
            status_code=429,
            detail="Limite de 10 relatos por usuário em 24 horas atingido",
        )

    row = models.RelatoSuporte(
        empresa_id=empresa_id,
        usuario_id=usuario_id,
        colaborador_id=colaborador_id,
        tipo=payload.tipo,
        titulo=titulo,
        descricao=descricao,
        pagina=pagina,
        status="aberto",
    )
    db.add(row)
    db.commit()
    db.refresh(row)

    return {"ok": True, "relato": _report_payload(row)}
