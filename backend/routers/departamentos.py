# backend/routers/departamentos.py
from __future__ import annotations

from datetime import datetime
from typing import List, Optional, Dict, Any, Set
import re

from fastapi import APIRouter, Depends, HTTPException, Header, Query, status
from pydantic import BaseModel, Field, ConfigDict, field_validator
from sqlalchemy import func
from sqlalchemy.orm import Session

from backend.database import get_db
from backend import models

# ✅ identity unificado (usuário OU colaborador)
from backend.routers.auth import get_current_identity

# ✅ Plano/Quota
from backend.utils.entitlements import enforce_quota
from backend.utils.usage import usage_counts


# ==========================================================
# Router "oficial" (fica montado em /api + este prefixo)
# => /api/atendimento/clientes/departamentos
# ==========================================================
router = APIRouter(
    prefix="/atendimento/clientes/departamentos",
    tags=["Departamentos"],
)

# ========= Schemas =========


class DepartamentoIn(BaseModel):
    nome: str = Field(min_length=1, max_length=80)
    descricao: Optional[str] = Field(default=None, max_length=300)
    # campos hierárquicos/extra (opcionais e ignorados se o modelo não tiver as colunas)
    parent_id: Optional[int] = Field(default=None)
    codigo: Optional[str] = Field(default=None, max_length=64)
    ativo: Optional[bool] = Field(default=True)
    # horário padrão de expediente (aplicável aos colaboradores do departamento)
    hora_login_inicio_padrao: Optional[str] = Field(default=None, description="HH:MM")
    hora_login_fim_padrao: Optional[str] = Field(default=None, description="HH:MM")

    @field_validator("nome", mode="before")
    @classmethod
    def strip_nome(cls, v):
        return v.strip() if isinstance(v, str) else v

    @field_validator("descricao", mode="before")
    @classmethod
    def strip_desc(cls, v):
        return v.strip() if isinstance(v, str) else v


class DepartamentoOut(BaseModel):
    id: int
    nome: str
    descricao: str | None = None
    empresa_id: int
    created_at: datetime | None = None

    # horário padrão de expediente (opcional)
    hora_login_inicio_padrao: str | None = None
    hora_login_fim_padrao: str | None = None

    # extras (preenchidos se existirem no modelo)
    parent_id: int | None = None
    codigo: str | None = None
    ativo: bool | None = None
    path: List[str] | None = None

    model_config = ConfigDict(from_attributes=True)


class MoveIn(BaseModel):
    new_parent_id: int | None = Field(default=None)


# ========= Helpers =========

# ---- Horário padrão do departamento (Brasília) ----
HORA_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")


def _norm_hora(h: Optional[str]) -> Optional[str]:
    """
    Normaliza "HH:MM" ou "HH:MM:SS" para "HH:MM".
    Se vier vazio, None ou inválido, retorna None.
    """
    if h is None:
        return None
    h = str(h).strip()
    if not h:
        return None
    if len(h) >= 5 and h[2] == ":":
        h = h[:5]
    if not HORA_RE.match(h):
        return None
    return h


def resolve_empresa_id(
    identity=Depends(get_current_identity),
    x_empresa_id: Optional[int] = Header(default=None, alias="X-Empresa-Id"),
    empresa_id_qs: Optional[int] = Query(default=None, alias="empresa_id"),
) -> int:
    """
    Resolve o empresa_id a partir:
      1) da empresa do login (identity.empresa_id),
      2) opcionalmente header X-Empresa-Id ou ?empresa_id=.

    Se identity.empresa_id estiver preenchido, ele PRECISA bater com o ID pedido.
    """
    base_id = getattr(identity, "empresa_id", None)

    empresa_id = x_empresa_id or empresa_id_qs or base_id
    if not empresa_id:
        raise HTTPException(
            status_code=400,
            detail="empresa_id é obrigatório (header/query ausente e identity sem empresa_id)",
        )

    empresa_id = int(empresa_id)

    if base_id is not None and int(base_id) != empresa_id:
        raise HTTPException(status_code=403, detail="Empresa não permitida")

    return empresa_id


def ensure_empresa_exists(db: Session, empresa_id: int):
    ok = db.query(models.Empresa.id).filter(models.Empresa.id == empresa_id).first()
    if not ok:
        raise HTTPException(status_code=404, detail="Empresa não encontrada")


def ensure_nome_unico(db: Session, empresa_id: int, nome: str, ignore_id: Optional[int] = None):
    q = db.query(models.Departamento).filter(
        models.Departamento.empresa_id == empresa_id,
        func.lower(models.Departamento.nome) == func.lower(nome),
    )
    if ignore_id:
        q = q.filter(models.Departamento.id != ignore_id)
    if db.query(q.exists()).scalar():
        raise HTTPException(status_code=409, detail="Já existe um departamento com este nome")


def get_departamento_or_404(db: Session, empresa_id: int, dept_id: int) -> models.Departamento:
    dept = (
        db.query(models.Departamento)
        .filter(
            models.Departamento.id == dept_id,
            models.Departamento.empresa_id == empresa_id,
        )
        .first()
    )
    if not dept:
        raise HTTPException(status_code=404, detail="Departamento não encontrado")
    return dept


def has_column(model, attr: str) -> bool:
    return hasattr(model, attr)


def dept_to_dict(row: Any) -> Dict[str, Any]:
    """Extrai campos, lidando com projetos que ainda não migraram colunas."""
    out = {
        "id": row.id,
        "empresa_id": row.empresa_id,
        "nome": row.nome,
        "descricao": getattr(row, "descricao", None),
        "created_at": getattr(row, "created_at", None),
    }
    if has_column(row, "parent_id"):
        out["parent_id"] = getattr(row, "parent_id", None)
    else:
        out["parent_id"] = None
    if has_column(row, "codigo"):
        out["codigo"] = getattr(row, "codigo", None)
    else:
        out["codigo"] = None
    if has_column(row, "ativo"):
        out["ativo"] = getattr(row, "ativo", True)
    else:
        out["ativo"] = True
    if has_column(row, "hora_login_inicio_padrao"):
        out["hora_login_inicio_padrao"] = getattr(row, "hora_login_inicio_padrao", None)
    else:
        out["hora_login_inicio_padrao"] = None
    if has_column(row, "hora_login_fim_padrao"):
        out["hora_login_fim_padrao"] = getattr(row, "hora_login_fim_padrao", None)
    else:
        out["hora_login_fim_padrao"] = None
    # path pode ser coluna (ARRAY) — se não for, calculamos na rota /tree
    out["path"] = getattr(row, "path", None)
    return out


def build_paths(rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Garante que cada item tenha 'path' (lista de nomes), mesmo sem coluna no banco."""
    by_id = {r["id"]: r for r in rows}
    children: Dict[int | None, List[Dict[str, Any]]] = {}
    for r in rows:
        parent = r.get("parent_id")
        children.setdefault(parent, []).append(r)

    # ordena filhos por nome para previsibilidade
    for lst in children.values():
        lst.sort(key=lambda x: (x.get("nome") or "").lower())

    # se já veio path da coluna, respeita; senão, calcula nomeando do topo
    def dfs(node: Dict[str, Any], acc_names: List[str]):
        node["path"] = list(acc_names) + [node["nome"]]
        for c in children.get(node["id"], []):
            dfs(c, node["path"])

    # raízes (parent_id is None)
    for root in children.get(None, []):
        if not root.get("path"):
            dfs(root, [])

    # para itens isolados (em teoria não deveria haver)
    for r in rows:
        if not r.get("path"):
            r["path"] = [r["nome"]]

    return rows


def assert_no_cycle(moving_id: int, new_parent_id: Optional[int], rows: List[Dict[str, Any]]):
    """Evita ciclos ao mover (new_parent não pode ser filho do moving)."""
    if new_parent_id is None:
        return
    by_id = {r["id"]: r for r in rows}
    cur = by_id.get(new_parent_id)
    visited: Set[int] = set()
    while cur:
        if cur["id"] in visited:
            break
        visited.add(cur["id"])
        if cur["id"] == moving_id:
            raise HTTPException(
                status_code=400,
                detail="Não é permitido mover um departamento para dentro de si mesmo ou de um descendente.",
            )
        pid = cur.get("parent_id")
        cur = by_id.get(pid)


# ========= Rotas =========


@router.get("", response_model=List[DepartamentoOut])
def listar(
    empresa_id: int = Depends(resolve_empresa_id),
    db: Session = Depends(get_db),
):
    """Lista todos os departamentos da empresa."""
    ensure_empresa_exists(db, empresa_id)
    itens = (
        db.query(models.Departamento)
        .filter(models.Departamento.empresa_id == empresa_id)
        .order_by(func.lower(models.Departamento.nome))
        .all()
    )
    out: List[DepartamentoOut] = []
    for it in itens:
        d = dept_to_dict(it)
        out.append(DepartamentoOut(**d))
    return out


@router.get("/tree", response_model=List[DepartamentoOut])
def tree(
    empresa_id: int = Depends(resolve_empresa_id),
    db: Session = Depends(get_db),
):
    """
    Retorna lista plana com campos suficientes para montar árvore no front.
    Se o banco não tiver 'parent_id'/'path', o 'path' é calculado aqui.
    """
    ensure_empresa_exists(db, empresa_id)
    itens = (
        db.query(models.Departamento)
        .filter(models.Departamento.empresa_id == empresa_id)
        .all()
    )
    rows = [dept_to_dict(it) for it in itens]

    has_parent = any(r.get("parent_id") is not None for r in rows) or has_column(
        models.Departamento, "parent_id"
    )
    if not has_parent:
        for r in rows:
            r["path"] = [r["nome"]]
    else:
        rows = build_paths(rows)

    rows.sort(key=lambda r: " / ".join(r.get("path") or [r["nome"]]).lower())
    return [DepartamentoOut(**r) for r in rows]


@router.get("/{dept_id}", response_model=DepartamentoOut)
def obter(
    dept_id: int,
    empresa_id: int = Depends(resolve_empresa_id),
    db: Session = Depends(get_db),
):
    ensure_empresa_exists(db, empresa_id)
    dept = get_departamento_or_404(db, empresa_id, dept_id)
    return DepartamentoOut(**dept_to_dict(dept))


@router.post("", response_model=DepartamentoOut, status_code=status.HTTP_201_CREATED)
def criar(
    payload: DepartamentoIn,
    empresa_id: int = Depends(resolve_empresa_id),
    db: Session = Depends(get_db),
):
    """Cria um novo departamento (nome único por empresa)."""
    ensure_empresa_exists(db, empresa_id)

    # ✅ QUOTA: bloquear criação se exceder limite do plano
    emp = db.query(models.Empresa).get(empresa_id)
    if emp:
        counts = usage_counts(db, emp.id)
        enforce_quota(
            emp,
            "departments_max",
            int(counts.get("departments_max", 0)),
            delta=1,
            message="Seu plano atingiu o limite de departamentos.",
        )

    nome = payload.nome.strip()
    ensure_nome_unico(db, empresa_id, nome)

    novo = models.Departamento(
        empresa_id=empresa_id,
        nome=nome,
        descricao=payload.descricao or None,
    )

    if has_column(models.Departamento, "parent_id"):
        setattr(novo, "parent_id", payload.parent_id)
    if has_column(models.Departamento, "codigo"):
        setattr(novo, "codigo", (payload.codigo or None))
    if has_column(models.Departamento, "ativo"):
        setattr(novo, "ativo", True if payload.ativo is None else bool(payload.ativo))

    if has_column(models.Departamento, "hora_login_inicio_padrao"):
        setattr(novo, "hora_login_inicio_padrao", _norm_hora(payload.hora_login_inicio_padrao))
    if has_column(models.Departamento, "hora_login_fim_padrao"):
        setattr(novo, "hora_login_fim_padrao", _norm_hora(payload.hora_login_fim_padrao))

    db.add(novo)
    db.commit()
    db.refresh(novo)
    return DepartamentoOut(**dept_to_dict(novo))


@router.put("/{dept_id}", response_model=DepartamentoOut)
def atualizar(
    dept_id: int,
    payload: DepartamentoIn,
    empresa_id: int = Depends(resolve_empresa_id),
    db: Session = Depends(get_db),
):
    """Atualiza dados do departamento (nome/descrição e extras quando existirem)."""
    ensure_empresa_exists(db, empresa_id)
    dept = get_departamento_or_404(db, empresa_id, dept_id)

    nome = payload.nome.strip()
    ensure_nome_unico(db, empresa_id, nome, ignore_id=dept.id)

    dept.nome = nome
    dept.descricao = payload.descricao or None

    if has_column(models.Departamento, "parent_id"):
        setattr(dept, "parent_id", payload.parent_id)
    if has_column(models.Departamento, "codigo"):
        setattr(dept, "codigo", (payload.codigo or None))
    if has_column(models.Departamento, "ativo"):
        setattr(dept, "ativo", True if payload.ativo is None else bool(payload.ativo))

    if has_column(models.Departamento, "hora_login_inicio_padrao"):
        setattr(dept, "hora_login_inicio_padrao", _norm_hora(payload.hora_login_inicio_padrao))
    if has_column(models.Departamento, "hora_login_fim_padrao"):
        setattr(dept, "hora_login_fim_padrao", _norm_hora(payload.hora_login_fim_padrao))

    db.commit()
    db.refresh(dept)
    return DepartamentoOut(**dept_to_dict(dept))


@router.patch("/{dept_id}/move", status_code=status.HTTP_204_NO_CONTENT)
def mover(
    dept_id: int,
    payload: MoveIn,
    empresa_id: int = Depends(resolve_empresa_id),
    db: Session = Depends(get_db),
):
    """
    Move o departamento para um novo superior (new_parent_id).
    Requer a coluna parent_id no modelo. Evita ciclos.
    """
    ensure_empresa_exists(db, empresa_id)
    if not has_column(models.Departamento, "parent_id"):
        raise HTTPException(
            status_code=400,
            detail="Hierarquia não habilitada neste projeto (coluna parent_id ausente).",
        )

    dept = get_departamento_or_404(db, empresa_id, dept_id)
    if payload.new_parent_id == dept.id:
        raise HTTPException(
            status_code=400,
            detail="Não é permitido definir o próprio departamento como superior.",
        )

    itens = (
        db.query(models.Departamento)
        .filter(models.Departamento.empresa_id == empresa_id)
        .all()
    )
    rows = [dept_to_dict(it) for it in itens]
    rows = build_paths(rows)
    assert_no_cycle(dept.id, payload.new_parent_id, rows)

    if payload.new_parent_id is not None:
        _p = (
            db.query(models.Departamento.id)
            .filter(
                models.Departamento.empresa_id == empresa_id,
                models.Departamento.id == payload.new_parent_id,
            )
            .first()
        )
        if not _p:
            raise HTTPException(status_code=404, detail="Superior informado não existe.")

    setattr(dept, "parent_id", payload.new_parent_id)
    db.commit()
    return None


@router.delete("/{dept_id}", status_code=status.HTTP_204_NO_CONTENT)
def excluir(
    dept_id: int,
    empresa_id: int = Depends(resolve_empresa_id),
    db: Session = Depends(get_db),
):
    """Exclui um departamento."""
    ensure_empresa_exists(db, empresa_id)
    dept = get_departamento_or_404(db, empresa_id, dept_id)
    db.delete(dept)
    db.commit()
    return None


# ==========================================================
# Router de COMPATIBILIDADE (mesmas rotas em /api/departamentos)
# => /api/departamentos
# ==========================================================
compat_router = APIRouter(
    prefix="/departamentos",
    tags=["Departamentos (compat)"],
)

compat_router.add_api_route("", listar, methods=["GET"])
compat_router.add_api_route("/tree", tree, methods=["GET"])
compat_router.add_api_route("/{dept_id}", obter, methods=["GET"])
compat_router.add_api_route("", criar, methods=["POST"])
compat_router.add_api_route("/{dept_id}", atualizar, methods=["PUT"])
compat_router.add_api_route("/{dept_id}/move", mover, methods=["PATCH"])
compat_router.add_api_route("/{dept_id}", excluir, methods=["DELETE"])
