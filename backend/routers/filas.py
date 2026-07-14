# backend/routers/filas.py
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Path
from pydantic import BaseModel, Field
from sqlalchemy import or_, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from backend import models
from backend.database import get_db
from backend.services.atendimento_claim_state import set_waiting_department
from backend.routers.auth import get_current_identity
from backend.security.atendimento_acl import (
    assert_same_company,
    resolve_acl_context,
    assert_instancia_allowed,
)


router = APIRouter(tags=["Filas de Atendimento"])


# =========================================================
# Helpers base
# =========================================================
def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _to_int(v: Any) -> Optional[int]:
    try:
        if v is None:
            return None
        s = str(v).strip()
        if not s:
            return None
        return int(s)
    except Exception:
        return None


def _id_get(obj: Any, key: str, default: Any = None) -> Any:
    if obj is None:
        return default
    if isinstance(obj, dict):
        return obj.get(key, default)
    return getattr(obj, key, default)


def _identity_perms(identity: Any) -> set[str]:
    try:
        raw = (
            _id_get(identity, "permissoes")
            or _id_get(identity, "permissions")
            or []
        )

        if isinstance(raw, dict):
            return {str(k) for k, v in raw.items() if v}

        if isinstance(raw, (list, tuple, set)):
            return {str(x) for x in raw}

        return set()
    except Exception:
        return set()


def _is_admin_identity(identity: Any) -> bool:
    try:
        if bool(_id_get(identity, "is_admin")) or bool(_id_get(identity, "admin")):
            return True

        role = str(_id_get(identity, "role") or _id_get(identity, "cargo") or "").lower().strip()
        if role in ("admin", "administrador", "owner", "dono", "root"):
            return True

        perms = _identity_perms(identity)
        return bool({"admin", "root", "atendimento.gerenciar"} & perms)
    except Exception:
        return False


def _ensure_any_perm(identity: Any, *perms: str) -> None:
    """
    Mais flexível que ensure_perm:
    - admin passa
    - se tiver qualquer uma das permissões informadas, passa
    """
    if _is_admin_identity(identity):
        return

    have = _identity_perms(identity)
    wanted = {str(p) for p in perms if p}

    if wanted and have.intersection(wanted):
        return

    raise HTTPException(
        status_code=403,
        detail=f"Sem permissão ({' ou '.join(sorted(wanted))})",
    )


def _safe_rollback(db: Session) -> None:
    try:
        db.rollback()
    except Exception:
        pass


def _table_exists(db: Session, table_name: str) -> bool:
    try:
        reg = db.execute(text(f"SELECT to_regclass('public.{table_name}')")).scalar()
        return reg is not None
    except Exception:
        return False


def _status_atendimento_value(attr: str, fallback: str):
    enum_cls = getattr(models, "StatusAtendimento", None)
    if enum_cls is not None and hasattr(enum_cls, attr):
        try:
            return getattr(enum_cls, attr)
        except Exception:
            pass
    return fallback


def _status_abertos() -> list[Any]:
    vals: list[Any] = []

    for attr, fallback in (
        ("NOVO", "novo"),
        ("AGUARDANDO", "aguardando"),
        ("EM_ATENDIMENTO", "em_atendimento"),
        ("PAUSADO", "pausado"),
    ):
        vals.append(_status_atendimento_value(attr, fallback))
        vals.append(fallback)

    out = []
    seen = set()
    for v in vals:
        key = str(getattr(v, "value", v))
        if key in seen:
            continue
        seen.add(key)
        out.append(v)

    return out


def _norm_prioridade(v: Optional[str]) -> str:
    s = str(v or "normal").strip().lower()
    allowed = {"baixa", "normal", "alta", "urgente"}
    return s if s in allowed else "normal"


def _clean_str(v: Optional[str]) -> Optional[str]:
    if v is None:
        return None
    s = str(v).strip()
    return s or None


def _clean_color(v: Optional[str]) -> Optional[str]:
    s = _clean_str(v)
    if not s:
        return None

    if len(s) > 20:
        s = s[:20]

    return s


def _assert_models_ok() -> None:
    if not hasattr(models, "FilaAtendimento"):
        raise HTTPException(
            status_code=500,
            detail="Model FilaAtendimento não encontrado. Atualize o backend/models.py.",
        )

    if not hasattr(models, "FilaInstancia"):
        raise HTTPException(
            status_code=500,
            detail="Model FilaInstancia não encontrado. Atualize o backend/models.py.",
        )


def _assert_tables_ok(db: Session) -> None:
    missing = []
    for table in ("filas_atendimento", "filas_instancias"):
        if not _table_exists(db, table):
            missing.append(table)

    if missing:
        raise HTTPException(
            status_code=500,
            detail={
                "error": "tabelas_filas_ausentes",
                "message": "Rode a query SQL/migration das filas antes de usar este módulo.",
                "missing": missing,
            },
        )


# =========================================================
# Validadores de empresa/departamento/instância
# =========================================================
def _get_departamento(
    db: Session,
    *,
    empresa_id: int,
    departamento_id: Optional[int],
):
    if departamento_id is None:
        return None

    dep = (
        db.query(models.Departamento)
        .filter(
            models.Departamento.empresa_id == int(empresa_id),
            models.Departamento.id == int(departamento_id),
        )
        .first()
    )

    if not dep:
        raise HTTPException(status_code=404, detail="Departamento não encontrado para esta empresa.")

    return dep


def _get_instancias_empresa(
    db: Session,
    *,
    empresa_id: int,
    instancia_ids: Optional[List[int]],
    allowed_instancias: Optional[List[int]] = None,
) -> list[models.EmpresaInstancia]:
    ids = []
    for x in instancia_ids or []:
        ix = _to_int(x)
        if ix is not None and ix not in ids:
            ids.append(ix)

    if not ids:
        return []

    for iid in ids:
        assert_instancia_allowed(
            allowed_instancias=allowed_instancias,
            instancia_id=int(iid),
        )

    rows = (
        db.query(models.EmpresaInstancia)
        .filter(
            models.EmpresaInstancia.empresa_id == int(empresa_id),
            models.EmpresaInstancia.id.in_(ids),
        )
        .order_by(models.EmpresaInstancia.id.asc())
        .all()
    )

    found = {int(r.id) for r in rows}
    missing = [i for i in ids if int(i) not in found]
    if missing:
        raise HTTPException(
            status_code=404,
            detail={
                "error": "instancias_nao_encontradas",
                "ids": missing,
            },
        )

    return rows


def _fila_tem_vinculos_instancia(db: Session, *, empresa_id: int, fila_id: int) -> bool:
    row = (
        db.query(models.FilaInstancia.id)
        .filter(
            models.FilaInstancia.empresa_id == int(empresa_id),
            models.FilaInstancia.fila_id == int(fila_id),
        )
        .first()
    )
    return bool(row)


def _fila_permitida_na_instancia(
    db: Session,
    *,
    empresa_id: int,
    fila_id: int,
    instancia_id: Optional[int],
) -> bool:
    """
    Regra:
    - Se a fila não tem vínculos em filas_instancias, ela vale para todas as instâncias da empresa.
    - Se tem vínculos, só vale para as instâncias vinculadas.
    """
    if instancia_id is None:
        return True

    has_links = _fila_tem_vinculos_instancia(
        db,
        empresa_id=int(empresa_id),
        fila_id=int(fila_id),
    )

    if not has_links:
        return True

    row = (
        db.query(models.FilaInstancia.id)
        .filter(
            models.FilaInstancia.empresa_id == int(empresa_id),
            models.FilaInstancia.fila_id == int(fila_id),
            models.FilaInstancia.instancia_id == int(instancia_id),
        )
        .first()
    )

    return bool(row)


def _get_fila(
    db: Session,
    *,
    empresa_id: int,
    fila_id: int,
    with_options: bool = True,
):
    q = db.query(models.FilaAtendimento).filter(
        models.FilaAtendimento.empresa_id == int(empresa_id),
        models.FilaAtendimento.id == int(fila_id),
    )

    if with_options:
        q = q.options(
            selectinload(models.FilaAtendimento.instancias).selectinload(models.FilaInstancia.instancia),
            selectinload(models.FilaAtendimento.departamento),
        )

    fila = q.first()
    if not fila:
        raise HTTPException(status_code=404, detail="Fila não encontrada.")

    return fila


def _sync_fila_instancias(
    db: Session,
    *,
    fila: models.FilaAtendimento,
    empresa_id: int,
    instancia_ids: Optional[List[int]],
    allowed_instancias: Optional[List[int]] = None,
) -> None:
    """
    Se instancia_ids vier como None, não altera vínculos.
    Se vier lista vazia, remove vínculos e a fila fica global para a empresa.
    """
    if instancia_ids is None:
        return

    rows = _get_instancias_empresa(
        db,
        empresa_id=int(empresa_id),
        instancia_ids=instancia_ids,
        allowed_instancias=allowed_instancias,
    )

    desired = {int(r.id) for r in rows}

    current_rows = (
        db.query(models.FilaInstancia)
        .filter(
            models.FilaInstancia.empresa_id == int(empresa_id),
            models.FilaInstancia.fila_id == int(fila.id),
        )
        .all()
    )

    current = {int(r.instancia_id): r for r in current_rows}

    for iid, row in list(current.items()):
        if iid not in desired:
            db.delete(row)

    for iid in sorted(desired):
        if iid in current:
            continue

        db.add(models.FilaInstancia(
            empresa_id=int(empresa_id),
            fila_id=int(fila.id),
            instancia_id=int(iid),
        ))


def _fila_payload(fila: models.FilaAtendimento) -> Dict[str, Any]:
    instancias = []

    for vinc in getattr(fila, "instancias", []) or []:
        inst = getattr(vinc, "instancia", None)
        instancias.append({
            "id": int(getattr(vinc, "instancia_id")),
            "instance_name": getattr(inst, "instance_name", None) if inst else None,
            "apelido": getattr(inst, "apelido", None) if inst else None,
            "numero_instancia": getattr(inst, "numero_instancia", None) if inst else None,
        })

    dep = getattr(fila, "departamento", None)

    return {
        "id": int(fila.id),
        "empresa_id": int(fila.empresa_id),
        "departamento_id": int(fila.departamento_id) if fila.departamento_id is not None else None,
        "departamento_nome": getattr(dep, "nome", None) if dep else None,

        "nome": fila.nome,
        "descricao": fila.descricao,
        "prioridade": fila.prioridade or "normal",
        "sla_minutos": fila.sla_minutos,
        "cor": fila.cor,
        "mensagem_padrao": fila.mensagem_padrao,

        "ativa": bool(fila.ativa),
        "ordem": int(fila.ordem or 0),

        "exigir_aceite": bool(fila.exigir_aceite),
        "retorno_ao_liberar": bool(fila.retorno_ao_liberar),
        "auto_distribuir": bool(fila.auto_distribuir),

        "instancias": instancias,
        "instancia_ids": [int(x["id"]) for x in instancias],

        "criada_em": fila.criada_em.isoformat() if getattr(fila, "criada_em", None) else None,
        "atualizada_em": fila.atualizada_em.isoformat() if getattr(fila, "atualizada_em", None) else None,
    }


def _fila_publica_payload(fila: models.FilaAtendimento) -> Dict[str, Any]:
    return {
        "id": int(fila.id),
        "nome": fila.nome,
        "descricao": fila.descricao,
        "prioridade": fila.prioridade or "normal",
        "sla_minutos": fila.sla_minutos,
        "cor": fila.cor,
        "mensagem_padrao": fila.mensagem_padrao,
        "departamento_id": int(fila.departamento_id) if fila.departamento_id is not None else None,
        "ordem": int(fila.ordem or 0),
    }


# =========================================================
# Schemas
# =========================================================
class FilaCreateIn(BaseModel):
    empresa_id: Optional[int] = None

    nome: str = Field(..., min_length=1, max_length=80)
    descricao: Optional[str] = None

    departamento_id: Optional[int] = None
    instancia_ids: List[int] = Field(default_factory=list)

    prioridade: str = "normal"
    sla_minutos: Optional[int] = None

    cor: Optional[str] = None
    mensagem_padrao: Optional[str] = None

    ativa: bool = True
    ordem: int = 0

    exigir_aceite: bool = True
    retorno_ao_liberar: bool = True
    auto_distribuir: bool = False


class FilaUpdateIn(BaseModel):
    empresa_id: Optional[int] = None

    nome: Optional[str] = Field(None, min_length=1, max_length=80)
    descricao: Optional[str] = None

    departamento_id: Optional[int] = None
    instancia_ids: Optional[List[int]] = None

    prioridade: Optional[str] = None
    sla_minutos: Optional[int] = None

    cor: Optional[str] = None
    mensagem_padrao: Optional[str] = None

    ativa: Optional[bool] = None
    ordem: Optional[int] = None

    exigir_aceite: Optional[bool] = None
    retorno_ao_liberar: Optional[bool] = None
    auto_distribuir: Optional[bool] = None


class EscolherFilaIn(BaseModel):
    empresa_id: Optional[int] = None
    cliente_id: int
    instancia_id: Optional[int] = None
    fila_id: int


# =========================================================
# Função reutilizável pelo handler da Evolution/chatbot
# =========================================================
def aplicar_escolha_fila_cliente(
    db: Session,
    *,
    empresa_id: int,
    cliente_id: int,
    fila_id: int,
    instancia_id: Optional[int] = None,
) -> Dict[str, Any]:
    """
    Esta função é a regra central.

    O cliente escolheu uma fila no chatbot.
    Então:
    - NÃO marca fila no Cliente.
    - Marca fila no Atendimento aberto.
    - Se não existir atendimento aberto, cria um.
    - Se a fila tiver departamento vinculado, grava departamento_id no Atendimento.
    - Mantém Cliente.departamento_id como compatibilidade com ACL/listagens antigas.
    """

    _assert_models_ok()
    _assert_tables_ok(db)

    empresa_id = int(empresa_id)
    cliente_id = int(cliente_id)
    fila_id = int(fila_id)
    instancia_id_eff = _to_int(instancia_id)

    cliente = (
        db.query(models.Cliente)
        .filter(
            models.Cliente.empresa_id == empresa_id,
            models.Cliente.id == cliente_id,
        )
        .first()
    )

    if not cliente:
        raise HTTPException(status_code=404, detail="Cliente não encontrado.")

    if instancia_id_eff is None:
        instancia_id_eff = _to_int(getattr(cliente, "instancia_id", None))

    if instancia_id_eff is None:
        last_atd = (
            db.query(models.Atendimento.instancia_id)
            .filter(
                models.Atendimento.empresa_id == empresa_id,
                models.Atendimento.cliente_id == cliente_id,
                models.Atendimento.instancia_id.is_not(None),
            )
            .order_by(models.Atendimento.id.desc())
            .first()
        )
        instancia_id_eff = _to_int(last_atd[0]) if last_atd else None

    if instancia_id_eff is None:
        raise HTTPException(
            status_code=400,
            detail="Não foi possível identificar o WhatsApp desta conversa.",
        )

    fila = _get_fila(
        db,
        empresa_id=empresa_id,
        fila_id=fila_id,
        with_options=True,
    )

    if not bool(fila.ativa):
        raise HTTPException(status_code=409, detail="Esta fila está inativa.")

    if not _fila_permitida_na_instancia(
        db,
        empresa_id=empresa_id,
        fila_id=int(fila.id),
        instancia_id=instancia_id_eff,
    ):
        raise HTTPException(
            status_code=403,
            detail="Esta fila não está disponível para a instância desta conversa.",
        )

    departamento_id = _to_int(getattr(fila, "departamento_id", None))
    atendimento = set_waiting_department(
        db,
        empresa_id=empresa_id,
        cliente_id=cliente_id,
        instancia_id=int(instancia_id_eff),
        departamento_id=departamento_id,
        ts_dt=_now_utc(),
    )
    if atendimento is None:
        raise HTTPException(
            status_code=500,
            detail="Não foi possível criar ou atualizar o atendimento da fila.",
        )

    atendimento.fila_id = int(fila.id)
    atendimento.fila_escolhida_em = _now_utc()
    atendimento.instancia_id = int(instancia_id_eff)

    if departamento_id is not None:
        atendimento.departamento_id = int(departamento_id)

        # Compatibilidade com ACL/listagens antigas.
        if hasattr(cliente, "departamento_id"):
            cliente.departamento_id = int(departamento_id)

        if hasattr(cliente, "departamento"):
            dep_nome = getattr(getattr(fila, "departamento", None), "nome", None)
            if dep_nome:
                cliente.departamento = dep_nome

    if hasattr(cliente, "triagem_ativa"):
        cliente.triagem_ativa = False

    if hasattr(cliente, "triagem_ultima_msg_em"):
        cliente.triagem_ultima_msg_em = _now_utc()

    atendimento.atualizado_em = _now_utc()
    db.add(cliente)
    db.add(atendimento)
    db.flush()

    return {
        "ok": True,
        "message": "Fila escolhida com sucesso.",
        "cliente_id": int(cliente.id),
        "atendimento_id": int(atendimento.id),
        "empresa_id": empresa_id,
        "instancia_id": int(instancia_id_eff) if instancia_id_eff is not None else None,
        "fila": _fila_publica_payload(fila),
        "departamento_id": int(fila.departamento_id) if fila.departamento_id is not None else None,
    }


# =========================================================
# Rotas
# =========================================================
@router.get("/filas")
def listar_filas(
    empresa_id: Optional[int] = Query(None),
    instancia_id: Optional[int] = Query(None),
    ativa: Optional[bool] = Query(None),
    q: Optional[str] = Query(None),
    prioridade: Optional[str] = Query(None),
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
):
    _assert_models_ok()
    _assert_tables_ok(db)

    _ensure_any_perm(
        identity,
        "atendimento.ver",
        "atendimento.gerenciar",
        "chatbot.configurar",
        "departamentos.gerenciar",
    )

    empresa_id_eff = assert_same_company(identity, empresa_id)

    acl_ctx = resolve_acl_context(db, identity=identity, empresa_id=int(empresa_id_eff))
    allowed_instancias = acl_ctx.get("allowed_instancias")

    if instancia_id is not None:
        assert_instancia_allowed(
            allowed_instancias=allowed_instancias,
            instancia_id=int(instancia_id),
        )

    query = (
        db.query(models.FilaAtendimento)
        .options(
            selectinload(models.FilaAtendimento.instancias).selectinload(models.FilaInstancia.instancia),
            selectinload(models.FilaAtendimento.departamento),
        )
        .filter(models.FilaAtendimento.empresa_id == int(empresa_id_eff))
    )

    if ativa is not None:
        query = query.filter(models.FilaAtendimento.ativa.is_(bool(ativa)))

    if prioridade:
        query = query.filter(models.FilaAtendimento.prioridade == _norm_prioridade(prioridade))

    if q:
        like = f"%{str(q).strip()}%"
        query = query.filter(
            or_(
                models.FilaAtendimento.nome.ilike(like),
                models.FilaAtendimento.descricao.ilike(like),
                models.FilaAtendimento.mensagem_padrao.ilike(like),
            )
        )

    filas = (
        query
        .order_by(
            models.FilaAtendimento.ordem.asc(),
            models.FilaAtendimento.nome.asc(),
            models.FilaAtendimento.id.asc(),
        )
        .all()
    )

    if instancia_id is not None:
        filas = [
            f for f in filas
            if _fila_permitida_na_instancia(
                db,
                empresa_id=int(empresa_id_eff),
                fila_id=int(f.id),
                instancia_id=int(instancia_id),
            )
        ]

    return {
        "ok": True,
        "items": [_fila_payload(f) for f in filas],
        "total": len(filas),
    }


@router.post("/filas")
def criar_fila(
    data: FilaCreateIn,
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
):
    _assert_models_ok()
    _assert_tables_ok(db)

    _ensure_any_perm(
        identity,
        "atendimento.gerenciar",
        "chatbot.configurar",
        "departamentos.gerenciar",
        "atendimento.ver",
    )

    empresa_id_eff = assert_same_company(identity, data.empresa_id)

    acl_ctx = resolve_acl_context(db, identity=identity, empresa_id=int(empresa_id_eff))
    allowed_instancias = acl_ctx.get("allowed_instancias")

    nome = _clean_str(data.nome)
    if not nome:
        raise HTTPException(status_code=400, detail="Nome da fila é obrigatório.")

    _get_departamento(
        db,
        empresa_id=int(empresa_id_eff),
        departamento_id=data.departamento_id,
    )

    fila = models.FilaAtendimento(
        empresa_id=int(empresa_id_eff),
        departamento_id=data.departamento_id,
        nome=nome,
        descricao=_clean_str(data.descricao),
        prioridade=_norm_prioridade(data.prioridade),
        sla_minutos=data.sla_minutos if data.sla_minutos is not None else None,
        cor=_clean_color(data.cor),
        mensagem_padrao=_clean_str(data.mensagem_padrao),
        ativa=bool(data.ativa),
        ordem=int(data.ordem or 0),
        exigir_aceite=bool(data.exigir_aceite),
        retorno_ao_liberar=bool(data.retorno_ao_liberar),
        auto_distribuir=bool(data.auto_distribuir),
    )

    db.add(fila)

    try:
        db.flush()

        _sync_fila_instancias(
            db,
            fila=fila,
            empresa_id=int(empresa_id_eff),
            instancia_ids=data.instancia_ids,
            allowed_instancias=allowed_instancias,
        )

        db.commit()
    except IntegrityError:
        _safe_rollback(db)
        raise HTTPException(status_code=409, detail="Já existe uma fila com esse nome nesta empresa.")
    except HTTPException:
        _safe_rollback(db)
        raise
    except Exception as e:
        _safe_rollback(db)
        raise HTTPException(status_code=500, detail=f"Erro ao criar fila: {e}")

    fila = _get_fila(db, empresa_id=int(empresa_id_eff), fila_id=int(fila.id), with_options=True)

    return {
        "ok": True,
        "message": "Fila criada com sucesso.",
        "item": _fila_payload(fila),
    }


@router.put("/filas/{fila_id}")
def atualizar_fila(
    data: FilaUpdateIn,
    fila_id: int = Path(...),
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
):
    _assert_models_ok()
    _assert_tables_ok(db)

    _ensure_any_perm(
        identity,
        "atendimento.gerenciar",
        "chatbot.configurar",
        "departamentos.gerenciar",
        "atendimento.ver",
    )

    empresa_id_eff = assert_same_company(identity, data.empresa_id)

    acl_ctx = resolve_acl_context(db, identity=identity, empresa_id=int(empresa_id_eff))
    allowed_instancias = acl_ctx.get("allowed_instancias")

    fila = _get_fila(
        db,
        empresa_id=int(empresa_id_eff),
        fila_id=int(fila_id),
        with_options=True,
    )

    payload = data.dict(exclude_unset=True)

    if "nome" in payload:
        nome = _clean_str(payload.get("nome"))
        if not nome:
            raise HTTPException(status_code=400, detail="Nome da fila é obrigatório.")
        fila.nome = nome

    if "descricao" in payload:
        fila.descricao = _clean_str(payload.get("descricao"))

    if "departamento_id" in payload:
        departamento_id = payload.get("departamento_id")
        _get_departamento(
            db,
            empresa_id=int(empresa_id_eff),
            departamento_id=departamento_id,
        )
        fila.departamento_id = departamento_id

    if "prioridade" in payload:
        fila.prioridade = _norm_prioridade(payload.get("prioridade"))

    if "sla_minutos" in payload:
        fila.sla_minutos = payload.get("sla_minutos")

    if "cor" in payload:
        fila.cor = _clean_color(payload.get("cor"))

    if "mensagem_padrao" in payload:
        fila.mensagem_padrao = _clean_str(payload.get("mensagem_padrao"))

    if "ativa" in payload:
        fila.ativa = bool(payload.get("ativa"))

    if "ordem" in payload:
        fila.ordem = int(payload.get("ordem") or 0)

    if "exigir_aceite" in payload:
        fila.exigir_aceite = bool(payload.get("exigir_aceite"))

    if "retorno_ao_liberar" in payload:
        fila.retorno_ao_liberar = bool(payload.get("retorno_ao_liberar"))

    if "auto_distribuir" in payload:
        fila.auto_distribuir = bool(payload.get("auto_distribuir"))

    if hasattr(fila, "atualizada_em"):
        fila.atualizada_em = _now_utc()

    try:
        _sync_fila_instancias(
            db,
            fila=fila,
            empresa_id=int(empresa_id_eff),
            instancia_ids=payload.get("instancia_ids") if "instancia_ids" in payload else None,
            allowed_instancias=allowed_instancias,
        )

        db.commit()
    except IntegrityError:
        _safe_rollback(db)
        raise HTTPException(status_code=409, detail="Já existe uma fila com esse nome nesta empresa.")
    except HTTPException:
        _safe_rollback(db)
        raise
    except Exception as e:
        _safe_rollback(db)
        raise HTTPException(status_code=500, detail=f"Erro ao atualizar fila: {e}")

    fila = _get_fila(db, empresa_id=int(empresa_id_eff), fila_id=int(fila_id), with_options=True)

    return {
        "ok": True,
        "message": "Fila atualizada com sucesso.",
        "item": _fila_payload(fila),
    }


@router.delete("/filas/{fila_id}")
def excluir_fila(
    fila_id: int = Path(...),
    empresa_id: Optional[int] = Query(None),
    force: bool = Query(False),
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
):
    _assert_models_ok()
    _assert_tables_ok(db)

    _ensure_any_perm(
        identity,
        "atendimento.gerenciar",
        "chatbot.configurar",
        "departamentos.gerenciar",
        "atendimento.ver",
    )

    empresa_id_eff = assert_same_company(identity, empresa_id)

    fila = _get_fila(
        db,
        empresa_id=int(empresa_id_eff),
        fila_id=int(fila_id),
        with_options=False,
    )

    usado = (
        db.query(models.Atendimento.id)
        .filter(
            models.Atendimento.empresa_id == int(empresa_id_eff),
            models.Atendimento.fila_id == int(fila.id),
        )
        .first()
        is not None
    )

    try:
        if usado and not force:
            fila.ativa = False
            if hasattr(fila, "atualizada_em"):
                fila.atualizada_em = _now_utc()

            db.commit()

            return {
                "ok": True,
                "message": "A fila já possui atendimentos vinculados, então foi apenas desativada.",
                "deleted": False,
                "disabled": True,
            }

        db.delete(fila)
        db.commit()

        return {
            "ok": True,
            "message": "Fila excluída com sucesso.",
            "deleted": True,
            "disabled": False,
        }

    except Exception as e:
        _safe_rollback(db)
        raise HTTPException(status_code=500, detail=f"Erro ao excluir fila: {e}")


@router.get("/filas/publicas")
def listar_filas_publicas(
    empresa_id: int = Query(...),
    instancia_id: Optional[int] = Query(None),
    db: Session = Depends(get_db),
):
    """
    Lista filas ativas que podem aparecer no menu do chatbot.

    Observação:
    - Não altera atendimento.
    - Não marca fila no cliente.
    - Apenas devolve as opções.
    """
    _assert_models_ok()
    _assert_tables_ok(db)

    empresa = (
        db.query(models.Empresa.id)
        .filter(models.Empresa.id == int(empresa_id))
        .first()
    )
    if not empresa:
        raise HTTPException(status_code=404, detail="Empresa não encontrada.")

    if instancia_id is not None:
        inst = (
            db.query(models.EmpresaInstancia.id)
            .filter(
                models.EmpresaInstancia.empresa_id == int(empresa_id),
                models.EmpresaInstancia.id == int(instancia_id),
            )
            .first()
        )
        if not inst:
            raise HTTPException(status_code=404, detail="Instância não encontrada.")

    filas = (
        db.query(models.FilaAtendimento)
        .filter(
            models.FilaAtendimento.empresa_id == int(empresa_id),
            models.FilaAtendimento.ativa.is_(True),
        )
        .order_by(
            models.FilaAtendimento.ordem.asc(),
            models.FilaAtendimento.nome.asc(),
            models.FilaAtendimento.id.asc(),
        )
        .all()
    )

    if instancia_id is not None:
        filas = [
            f for f in filas
            if _fila_permitida_na_instancia(
                db,
                empresa_id=int(empresa_id),
                fila_id=int(f.id),
                instancia_id=int(instancia_id),
            )
        ]

    return {
        "ok": True,
        "items": [_fila_publica_payload(f) for f in filas],
        "total": len(filas),
    }


@router.post("/filas/escolher")
def escolher_fila(
    data: EscolherFilaIn,
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
):
    """
    Rota para teste/manual.

    No fluxo real do WhatsApp, o handler da Evolution pode importar e chamar:
        aplicar_escolha_fila_cliente(...)
    """
    _ensure_any_perm(
        identity,
        "atendimento.ver",
        "atendimento.gerenciar",
        "chatbot.configurar",
    )

    empresa_id_eff = assert_same_company(identity, data.empresa_id)

    acl_ctx = resolve_acl_context(db, identity=identity, empresa_id=int(empresa_id_eff))
    allowed_instancias = acl_ctx.get("allowed_instancias")

    if data.instancia_id is not None:
        assert_instancia_allowed(
            allowed_instancias=allowed_instancias,
            instancia_id=int(data.instancia_id),
        )

    try:
        result = aplicar_escolha_fila_cliente(
            db,
            empresa_id=int(empresa_id_eff),
            cliente_id=int(data.cliente_id),
            fila_id=int(data.fila_id),
            instancia_id=data.instancia_id,
        )

        db.commit()
        return result

    except HTTPException:
        _safe_rollback(db)
        raise
    except Exception as e:
        _safe_rollback(db)
        raise HTTPException(status_code=500, detail=f"Erro ao escolher fila: {e}")