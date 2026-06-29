# backend/routers/departamentos.py
from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, List, Optional, Set
import re
from urllib.parse import quote

from fastapi import APIRouter, Depends, Header, HTTPException, Query, status
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import func
from sqlalchemy.orm import Session

from backend import models
from backend.database import get_db
from backend.routers.auth import get_current_identity
from backend.utils.entitlements import enforce_quota
from backend.utils.usage import usage_counts


# ==========================================================
# Router oficial
# Montado no main.py com prefix="/api"
# Final:
# /api/atendimento/clientes/departamentos
# ==========================================================
router = APIRouter(
    prefix="/atendimento/clientes/departamentos",
    tags=["Departamentos"],
)


# ==========================================================
# Schemas
# ==========================================================
class DepartamentoIn(BaseModel):
    nome: str = Field(min_length=1, max_length=80)
    descricao: Optional[str] = Field(default=None, max_length=300)

    parent_id: Optional[int] = Field(default=None)
    codigo: Optional[str] = Field(default=None, max_length=64)
    ativo: Optional[bool] = Field(default=True)

    # IDs das instâncias permitidas para o departamento.
    # None = não mexe.
    # [] = limpa todas.
    whatsapp_instancias: Optional[List[int]] = Field(default=None)

    # Expediente padrão do departamento
    hora_login_inicio_padrao: Optional[str] = Field(default=None, description="HH:MM")
    hora_login_fim_padrao: Optional[str] = Field(default=None, description="HH:MM")

    model_config = ConfigDict(extra="ignore")

    @field_validator("nome", mode="before")
    @classmethod
    def strip_nome(cls, v):
        return v.strip() if isinstance(v, str) else v

    @field_validator("descricao", mode="before")
    @classmethod
    def strip_descricao(cls, v):
        if v is None:
            return None
        if isinstance(v, str):
            v = v.strip()
            return v or None
        return v

    @field_validator("codigo", mode="before")
    @classmethod
    def strip_codigo(cls, v):
        if v is None:
            return None
        if isinstance(v, str):
            v = v.strip()
            return v or None
        return v


class DepartamentoOut(BaseModel):
    id: int
    nome: str
    descricao: str | None = None
    empresa_id: int
    created_at: datetime | None = None

    parent_id: int | None = None
    codigo: str | None = None
    ativo: bool | None = None
    path: List[str] | None = None

    hora_login_inicio_padrao: str | None = None
    hora_login_fim_padrao: str | None = None

    # O frontend usa isso para marcar as instâncias no editar.
    whatsapp_instancias: List[int] = Field(default_factory=list)

    model_config = ConfigDict(from_attributes=True)


class MoveIn(BaseModel):
    new_parent_id: int | None = Field(default=None)


class DepartamentoMembroOut(BaseModel):
    id: int
    nome: str
    email: str | None = None
    telefone: str | None = None
    cargo: str | None = None
    avatar_url: str | None = None
    role: str = "member"
    is_primary: bool = False


class DepartamentoMembrosUpdate(BaseModel):
    colaboradores_ids: List[int] = Field(default_factory=list)


# ==========================================================
# Helpers gerais
# ==========================================================
HORA_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")


def _norm_hora(h: Optional[str]) -> Optional[str]:
    """
    Aceita:
    - None
    - ""
    - "08:00"
    - "08:00:00"

    Retorna:
    - None
    - "HH:MM"
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


def _safe_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except Exception:
        return default


def _pick_usage_count(counts: Dict[str, Any], *keys: str, default: int = 0) -> int:
    for key in keys:
        if key in counts:
            return _safe_int(counts.get(key), default)
    return default


def _id_get(obj: Any, key: str, default: Any = None) -> Any:
    if obj is None:
        return default

    if isinstance(obj, dict):
        return obj.get(key, default)

    return getattr(obj, key, default)


def has_column(model_or_obj: Any, attr: str) -> bool:
    return hasattr(model_or_obj, attr)


def resolve_empresa_id(
    identity=Depends(get_current_identity),
    x_empresa_id: Optional[int] = Header(default=None, alias="X-Empresa-Id"),
    empresa_id_qs: Optional[int] = Query(default=None, alias="empresa_id"),
) -> int:
    """
    Resolve empresa_id por:
    1. identity.empresa_id
    2. X-Empresa-Id
    3. ?empresa_id=

    Se identity.empresa_id existir, ele precisa bater com o ID pedido.
    """
    base_id = _id_get(identity, "empresa_id")

    empresa_id = x_empresa_id or empresa_id_qs or base_id
    if not empresa_id:
        raise HTTPException(
            status_code=400,
            detail="empresa_id é obrigatório.",
        )

    empresa_id = int(empresa_id)

    if base_id is not None and int(base_id) != empresa_id:
        raise HTTPException(status_code=403, detail="Empresa não permitida")

    return empresa_id


def ensure_empresa_exists(db: Session, empresa_id: int) -> None:
    ok = (
        db.query(models.Empresa.id)
        .filter(models.Empresa.id == int(empresa_id))
        .first()
    )

    if not ok:
        raise HTTPException(status_code=404, detail="Empresa não encontrada")


def ensure_nome_unico(
    db: Session,
    empresa_id: int,
    nome: str,
    ignore_id: Optional[int] = None,
) -> None:
    q = db.query(models.Departamento).filter(
        models.Departamento.empresa_id == int(empresa_id),
        func.lower(models.Departamento.nome) == func.lower(nome),
    )

    if ignore_id:
        q = q.filter(models.Departamento.id != int(ignore_id))

    if db.query(q.exists()).scalar():
        raise HTTPException(
            status_code=409,
            detail="Já existe um departamento com este nome",
        )


def ensure_codigo_unico(
    db: Session,
    empresa_id: int,
    codigo: str | None,
    ignore_id: Optional[int] = None,
) -> None:
    if not codigo:
        return

    if not has_column(models.Departamento, "codigo"):
        return

    q = db.query(models.Departamento).filter(
        models.Departamento.empresa_id == int(empresa_id),
        func.lower(models.Departamento.codigo) == func.lower(codigo),
    )

    if ignore_id:
        q = q.filter(models.Departamento.id != int(ignore_id))

    if db.query(q.exists()).scalar():
        raise HTTPException(
            status_code=409,
            detail="Já existe um departamento com este código",
        )


def get_departamento_or_404(
    db: Session,
    empresa_id: int,
    dept_id: int,
) -> models.Departamento:
    dept = (
        db.query(models.Departamento)
        .filter(
            models.Departamento.id == int(dept_id),
            models.Departamento.empresa_id == int(empresa_id),
        )
        .first()
    )

    if not dept:
        raise HTTPException(status_code=404, detail="Departamento não encontrado")

    return dept


def _validate_parent_same_empresa(
    db: Session,
    empresa_id: int,
    parent_id: Optional[int],
    current_dept_id: Optional[int] = None,
) -> None:
    if parent_id is None:
        return

    parent_id = int(parent_id)

    if current_dept_id is not None and parent_id == int(current_dept_id):
        raise HTTPException(
            status_code=400,
            detail="Não é permitido definir o próprio departamento como superior.",
        )

    parent = (
        db.query(models.Departamento.id)
        .filter(
            models.Departamento.id == parent_id,
            models.Departamento.empresa_id == int(empresa_id),
        )
        .first()
    )

    if not parent:
        raise HTTPException(status_code=404, detail="Superior informado não existe.")


# ==========================================================
# Helpers: path/hierarquia
# Unifica o que antes ficava no departamentos_service.py
# ==========================================================
def _normalizar_nome_path(raw: Any) -> str:
    s = str(raw or "").strip()
    return s or "Departamento"


def _build_paths_dict(rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Calcula path visual por nome:
    Empresa / Financeiro / Cobrança

    Não depende da coluna path do banco.
    """
    by_id = {int(r["id"]): r for r in rows if r.get("id") is not None}
    children: Dict[int | None, List[Dict[str, Any]]] = {}

    for r in rows:
        parent = r.get("parent_id")
        parent_key = int(parent) if parent is not None else None
        children.setdefault(parent_key, []).append(r)

    for lst in children.values():
        lst.sort(key=lambda x: (x.get("nome") or "").lower())

    visited: set[int] = set()

    def dfs(node: Dict[str, Any], acc_names: List[str]) -> None:
        node_id = int(node["id"])
        if node_id in visited:
            return

        visited.add(node_id)

        nome = _normalizar_nome_path(node.get("nome"))
        node["path"] = list(acc_names) + [nome]

        for child in children.get(node_id, []):
            dfs(child, node["path"])

    for root in children.get(None, []):
        dfs(root, [])

    # Se algum departamento ficou órfão por parent_id inválido, trata como raiz.
    for r in rows:
        if int(r["id"]) not in visited:
            r["path"] = [_normalizar_nome_path(r.get("nome"))]
            visited.add(int(r["id"]))

    return rows


def _rebuild_db_paths_for_empresa(db: Session, empresa_id: int) -> None:
    """
    Atualiza a coluna departamentos.path, se ela existir.

    Importante:
    - Não faz commit aqui.
    - A rota decide quando dar commit.
    """
    if not has_column(models.Departamento, "path"):
        return

    deps = (
        db.query(models.Departamento)
        .filter(models.Departamento.empresa_id == int(empresa_id))
        .all()
    )

    rows = [dept_to_dict(dep, db=None, include_instancias=False) for dep in deps]
    rows = _build_paths_dict(rows)
    path_by_id = {int(r["id"]): list(r.get("path") or []) for r in rows}

    for dep in deps:
        dep.path = path_by_id.get(int(dep.id), [_normalizar_nome_path(dep.nome)])


def assert_no_cycle(
    moving_id: int,
    new_parent_id: Optional[int],
    rows: List[Dict[str, Any]],
) -> None:
    if new_parent_id is None:
        return

    moving_id = int(moving_id)
    new_parent_id = int(new_parent_id)

    by_id = {int(r["id"]): r for r in rows}
    cur = by_id.get(new_parent_id)
    visited: Set[int] = set()

    while cur:
        cur_id = int(cur["id"])

        if cur_id in visited:
            break

        visited.add(cur_id)

        if cur_id == moving_id:
            raise HTTPException(
                status_code=400,
                detail="Não é permitido mover um departamento para dentro de si mesmo ou de um descendente.",
            )

        pid = cur.get("parent_id")
        cur = by_id.get(int(pid)) if pid is not None else None


# ==========================================================
# Helpers: instâncias do departamento
# ==========================================================
def _normalize_instancia_ids(values: Any) -> list[int]:
    if values is None:
        return []

    if not isinstance(values, (list, tuple, set)):
        values = [values]

    out: list[int] = []
    seen: set[int] = set()

    for raw in values:
        try:
            val = int(raw)
        except Exception:
            continue

        if val <= 0:
            continue

        if val in seen:
            continue

        seen.add(val)
        out.append(val)

    return out


def _get_departamento_instancia_ids(
    db: Session,
    *,
    empresa_id: int,
    departamento_id: int,
) -> list[int]:
    if not hasattr(models, "DepartamentoInstancia"):
        return []

    rows = (
        db.query(models.DepartamentoInstancia.instancia_id)
        .filter(
            models.DepartamentoInstancia.empresa_id == int(empresa_id),
            models.DepartamentoInstancia.departamento_id == int(departamento_id),
        )
        .order_by(models.DepartamentoInstancia.instancia_id.asc())
        .all()
    )

    return [int(r[0]) for r in rows if r and r[0] is not None]


def _sync_departamento_instancias(
    db: Session,
    *,
    empresa_id: int,
    departamento_id: int,
    instancia_ids: list[int] | None,
) -> None:
    """
    Sincroniza tabela pivô:

    departamentos_instancias:
    - empresa_id
    - departamento_id
    - instancia_id

    Não faz commit aqui.
    """
    if not hasattr(models, "DepartamentoInstancia"):
        raise HTTPException(
            status_code=500,
            detail="Model DepartamentoInstancia não encontrado.",
        )

    ids = _normalize_instancia_ids(instancia_ids)

    if ids:
        rows = (
            db.query(models.EmpresaInstancia.id)
            .filter(
                models.EmpresaInstancia.empresa_id == int(empresa_id),
                models.EmpresaInstancia.id.in_(ids),
            )
            .all()
        )

        valid_ids = {int(r[0]) for r in rows if r and r[0] is not None}
        invalidos = [i for i in ids if i not in valid_ids]

        if invalidos:
            raise HTTPException(
                status_code=400,
                detail=f"Instância(s) não pertencem à empresa ou não existem: {invalidos}",
            )

    (
        db.query(models.DepartamentoInstancia)
        .filter(
            models.DepartamentoInstancia.empresa_id == int(empresa_id),
            models.DepartamentoInstancia.departamento_id == int(departamento_id),
        )
        .delete(synchronize_session=False)
    )

    for instancia_id in ids:
        db.add(
            models.DepartamentoInstancia(
                empresa_id=int(empresa_id),
                departamento_id=int(departamento_id),
                instancia_id=int(instancia_id),
            )
        )


# ==========================================================
# Serialização
# ==========================================================
def dept_to_dict(
    row: Any,
    db: Session | None = None,
    *,
    include_instancias: bool = True,
) -> Dict[str, Any]:
    out: Dict[str, Any] = {
        "id": int(row.id),
        "empresa_id": int(row.empresa_id),
        "nome": row.nome,
        "descricao": getattr(row, "descricao", None),
        "created_at": getattr(row, "created_at", None),
        "parent_id": getattr(row, "parent_id", None) if has_column(row, "parent_id") else None,
        "codigo": getattr(row, "codigo", None) if has_column(row, "codigo") else None,
        "ativo": getattr(row, "ativo", True) if has_column(row, "ativo") else True,
        "path": getattr(row, "path", None) if has_column(row, "path") else None,
        "hora_login_inicio_padrao": (
            getattr(row, "hora_login_inicio_padrao", None)
            if has_column(row, "hora_login_inicio_padrao")
            else None
        ),
        "hora_login_fim_padrao": (
            getattr(row, "hora_login_fim_padrao", None)
            if has_column(row, "hora_login_fim_padrao")
            else None
        ),
        "whatsapp_instancias": [],
    }

    if include_instancias and db is not None:
        out["whatsapp_instancias"] = _get_departamento_instancia_ids(
            db,
            empresa_id=int(row.empresa_id),
            departamento_id=int(row.id),
        )

    return out


def _rows_departamentos_empresa(db: Session, empresa_id: int) -> list[Dict[str, Any]]:
    itens = (
        db.query(models.Departamento)
        .filter(models.Departamento.empresa_id == int(empresa_id))
        .all()
    )

    rows = [dept_to_dict(it, db) for it in itens]
    rows = _build_paths_dict(rows)
    rows.sort(key=lambda r: " / ".join(r.get("path") or [r.get("nome") or ""]).lower())

    return rows


# ==========================================================
# Helpers: membros do departamento
# ==========================================================
def _avatar_url_colaborador(nome: Optional[str], email: Optional[str]) -> str:
    seed = (nome or email or "Colaborador").strip() or "Colaborador"
    return (
        "https://api.dicebear.com/7.x/initials/svg"
        f"?seed={quote(seed)}&radius=12&scale=100"
    )


def _normalize_int_list(raw: Any) -> list[int]:
    if raw is None:
        return []

    if isinstance(raw, str):
        raw = [p for p in re.split(r"[\s,;]+", raw.strip()) if p]

    if not isinstance(raw, list):
        raw = [raw]

    out: list[int] = []
    seen: set[int] = set()

    for item in raw:
        if isinstance(item, dict):
            item = item.get("id") or item.get("colaborador_id") or item.get("value")

        try:
            n = int(item)
        except Exception:
            continue

        if n <= 0 or n in seen:
            continue

        seen.add(n)
        out.append(n)

    return out


def _validate_colaboradores_ids_empresa(
    db: Session,
    *,
    empresa_id: int,
    colaboradores_ids: list[int],
) -> list[int]:
    ids = _normalize_int_list(colaboradores_ids)

    if not ids:
        return []

    rows = (
        db.query(models.Colaborador.id)
        .filter(
            models.Colaborador.empresa_id == int(empresa_id),
            models.Colaborador.id.in_(ids),
        )
        .all()
    )

    valid_ids = {int(r[0]) for r in rows if r and r[0] is not None}
    invalid = [x for x in ids if x not in valid_ids]

    if invalid:
        raise HTTPException(
            status_code=404,
            detail=f"Colaborador(es) inválido(s) para a empresa: {invalid}",
        )

    return [x for x in ids if x in valid_ids]


def _get_departamento_membros(
    db: Session,
    *,
    empresa_id: int,
    departamento_id: int,
) -> list[DepartamentoMembroOut]:
    rows = (
        db.query(models.DepartamentoMembro, models.Colaborador)
        .join(
            models.Colaborador,
            models.Colaborador.id == models.DepartamentoMembro.colaborador_id,
        )
        .filter(
            models.DepartamentoMembro.empresa_id == int(empresa_id),
            models.DepartamentoMembro.departamento_id == int(departamento_id),
            models.Colaborador.empresa_id == int(empresa_id),
        )
        .order_by(
            models.DepartamentoMembro.is_primary.desc(),
            func.lower(models.Colaborador.nome),
        )
        .all()
    )

    out: list[DepartamentoMembroOut] = []

    for membro, colab in rows:
        out.append(
            DepartamentoMembroOut(
                id=int(colab.id),
                nome=colab.nome or "Colaborador",
                email=colab.email,
                telefone=getattr(colab, "telefone", None),
                cargo=getattr(colab, "cargo", None),
                avatar_url=_avatar_url_colaborador(colab.nome, colab.email),
                role=getattr(membro, "role", None) or "member",
                is_primary=bool(getattr(membro, "is_primary", False)),
            )
        )

    return out


def _sync_departamento_membros(
    db: Session,
    *,
    empresa_id: int,
    departamento_id: int,
    colaboradores_ids: list[int],
) -> list[DepartamentoMembroOut]:
    ids = _validate_colaboradores_ids_empresa(
        db,
        empresa_id=int(empresa_id),
        colaboradores_ids=colaboradores_ids,
    )

    (
        db.query(models.DepartamentoMembro)
        .filter(
            models.DepartamentoMembro.empresa_id == int(empresa_id),
            models.DepartamentoMembro.departamento_id == int(departamento_id),
        )
        .delete(synchronize_session=False)
    )

    for idx, colab_id in enumerate(ids):
        db.add(
            models.DepartamentoMembro(
                empresa_id=int(empresa_id),
                departamento_id=int(departamento_id),
                colaborador_id=int(colab_id),
                role="member",
                is_primary=(idx == 0),
            )
        )

    db.flush()
    return _get_departamento_membros(
        db,
        empresa_id=int(empresa_id),
        departamento_id=int(departamento_id),
    )


# ==========================================================
# Rotas
# ==========================================================
@router.get("", response_model=List[DepartamentoOut])
def listar(
    empresa_id: int = Depends(resolve_empresa_id),
    db: Session = Depends(get_db),
):
    ensure_empresa_exists(db, empresa_id)

    itens = (
        db.query(models.Departamento)
        .filter(models.Departamento.empresa_id == int(empresa_id))
        .order_by(func.lower(models.Departamento.nome))
        .all()
    )

    rows = [dept_to_dict(it, db) for it in itens]
    rows = _build_paths_dict(rows)

    return [DepartamentoOut(**r) for r in rows]


@router.get("/tree", response_model=List[DepartamentoOut])
def tree(
    empresa_id: int = Depends(resolve_empresa_id),
    db: Session = Depends(get_db),
):
    ensure_empresa_exists(db, empresa_id)
    rows = _rows_departamentos_empresa(db, empresa_id)
    return [DepartamentoOut(**r) for r in rows]


@router.get("/{dept_id}", response_model=DepartamentoOut)
def obter(
    dept_id: int,
    empresa_id: int = Depends(resolve_empresa_id),
    db: Session = Depends(get_db),
):
    ensure_empresa_exists(db, empresa_id)

    dept = get_departamento_or_404(db, empresa_id, dept_id)

    rows = _rows_departamentos_empresa(db, empresa_id)
    path_by_id = {int(r["id"]): r.get("path") for r in rows}

    out = dept_to_dict(dept, db)
    out["path"] = path_by_id.get(int(dept.id), out.get("path"))

    return DepartamentoOut(**out)


@router.get("/{dept_id}/membros", response_model=List[DepartamentoMembroOut])
def listar_membros(
    dept_id: int,
    empresa_id: int = Depends(resolve_empresa_id),
    db: Session = Depends(get_db),
):
    ensure_empresa_exists(db, empresa_id)
    get_departamento_or_404(db, empresa_id, dept_id)

    return _get_departamento_membros(
        db,
        empresa_id=int(empresa_id),
        departamento_id=int(dept_id),
    )


@router.put("/{dept_id}/membros", response_model=List[DepartamentoMembroOut])
def atualizar_membros(
    dept_id: int,
    payload: DepartamentoMembrosUpdate,
    empresa_id: int = Depends(resolve_empresa_id),
    db: Session = Depends(get_db),
):
    ensure_empresa_exists(db, empresa_id)
    get_departamento_or_404(db, empresa_id, dept_id)

    try:
        membros = _sync_departamento_membros(
            db,
            empresa_id=int(empresa_id),
            departamento_id=int(dept_id),
            colaboradores_ids=_normalize_int_list(payload.colaboradores_ids),
        )
        db.commit()
        return membros
    except HTTPException:
        db.rollback()
        raise
    except Exception:
        db.rollback()
        raise


@router.post("", response_model=DepartamentoOut, status_code=status.HTTP_201_CREATED)
def criar(
    payload: DepartamentoIn,
    empresa_id: int = Depends(resolve_empresa_id),
    db: Session = Depends(get_db),
):
    ensure_empresa_exists(db, empresa_id)

    emp = db.get(models.Empresa, int(empresa_id))
    if emp:
        counts = usage_counts(db, emp.id) or {}
        current_departments = _pick_usage_count(
            counts,
            "departments_max",
            "departments",
            "departamentos",
            default=0,
        )

        enforce_quota(
            emp,
            "departments_max",
            current_departments,
            delta=1,
            message="Seu plano está vencido ou atingiu o limite de departamentos.",
        )

    nome = payload.nome.strip()
    codigo = payload.codigo.strip() if isinstance(payload.codigo, str) and payload.codigo.strip() else None

    ensure_nome_unico(db, empresa_id, nome)
    ensure_codigo_unico(db, empresa_id, codigo)

    if has_column(models.Departamento, "parent_id"):
        _validate_parent_same_empresa(db, empresa_id, payload.parent_id)

    novo = models.Departamento(
        empresa_id=int(empresa_id),
        nome=nome,
        descricao=payload.descricao or None,
    )

    if has_column(models.Departamento, "parent_id"):
        setattr(novo, "parent_id", payload.parent_id)

    if has_column(models.Departamento, "codigo"):
        setattr(novo, "codigo", codigo)

    if has_column(models.Departamento, "ativo"):
        setattr(novo, "ativo", True if payload.ativo is None else bool(payload.ativo))

    if has_column(models.Departamento, "hora_login_inicio_padrao"):
        setattr(novo, "hora_login_inicio_padrao", _norm_hora(payload.hora_login_inicio_padrao))

    if has_column(models.Departamento, "hora_login_fim_padrao"):
        setattr(novo, "hora_login_fim_padrao", _norm_hora(payload.hora_login_fim_padrao))

    db.add(novo)
    db.flush()

    if payload.whatsapp_instancias is not None:
        _sync_departamento_instancias(
            db,
            empresa_id=int(empresa_id),
            departamento_id=int(novo.id),
            instancia_ids=payload.whatsapp_instancias,
        )

    _rebuild_db_paths_for_empresa(db, int(empresa_id))

    db.commit()
    db.refresh(novo)

    return obter(novo.id, empresa_id=empresa_id, db=db)


@router.put("/{dept_id}", response_model=DepartamentoOut)
def atualizar(
    dept_id: int,
    payload: DepartamentoIn,
    empresa_id: int = Depends(resolve_empresa_id),
    db: Session = Depends(get_db),
):
    ensure_empresa_exists(db, empresa_id)

    dept = get_departamento_or_404(db, empresa_id, dept_id)

    nome = payload.nome.strip()
    codigo = payload.codigo.strip() if isinstance(payload.codigo, str) and payload.codigo.strip() else None

    ensure_nome_unico(db, empresa_id, nome, ignore_id=dept.id)
    ensure_codigo_unico(db, empresa_id, codigo, ignore_id=dept.id)

    if has_column(models.Departamento, "parent_id"):
        _validate_parent_same_empresa(
            db,
            empresa_id,
            payload.parent_id,
            current_dept_id=dept.id,
        )

        rows = _rows_departamentos_empresa(db, empresa_id)
        assert_no_cycle(dept.id, payload.parent_id, rows)

    dept.nome = nome
    dept.descricao = payload.descricao or None

    if has_column(models.Departamento, "parent_id"):
        setattr(dept, "parent_id", payload.parent_id)

    if has_column(models.Departamento, "codigo"):
        setattr(dept, "codigo", codigo)

    if has_column(models.Departamento, "ativo"):
        setattr(dept, "ativo", True if payload.ativo is None else bool(payload.ativo))

    if has_column(models.Departamento, "hora_login_inicio_padrao"):
        setattr(dept, "hora_login_inicio_padrao", _norm_hora(payload.hora_login_inicio_padrao))

    if has_column(models.Departamento, "hora_login_fim_padrao"):
        setattr(dept, "hora_login_fim_padrao", _norm_hora(payload.hora_login_fim_padrao))

    if payload.whatsapp_instancias is not None:
        _sync_departamento_instancias(
            db,
            empresa_id=int(empresa_id),
            departamento_id=int(dept.id),
            instancia_ids=payload.whatsapp_instancias,
        )

    _rebuild_db_paths_for_empresa(db, int(empresa_id))

    db.commit()
    db.refresh(dept)

    return obter(dept.id, empresa_id=empresa_id, db=db)


@router.patch("/{dept_id}", status_code=status.HTTP_204_NO_CONTENT)
@router.patch("/{dept_id}/move", status_code=status.HTTP_204_NO_CONTENT)
def mover(
    dept_id: int,
    payload: MoveIn,
    empresa_id: int = Depends(resolve_empresa_id),
    db: Session = Depends(get_db),
):
    ensure_empresa_exists(db, empresa_id)

    if not has_column(models.Departamento, "parent_id"):
        raise HTTPException(
            status_code=400,
            detail="Hierarquia não habilitada neste projeto.",
        )

    dept = get_departamento_or_404(db, empresa_id, dept_id)

    if payload.new_parent_id == dept.id:
        raise HTTPException(
            status_code=400,
            detail="Não é permitido definir o próprio departamento como superior.",
        )

    if payload.new_parent_id is not None:
        _validate_parent_same_empresa(
            db,
            empresa_id,
            payload.new_parent_id,
            current_dept_id=dept.id,
        )

    rows = _rows_departamentos_empresa(db, empresa_id)
    assert_no_cycle(dept.id, payload.new_parent_id, rows)

    setattr(dept, "parent_id", payload.new_parent_id)

    _rebuild_db_paths_for_empresa(db, int(empresa_id))

    db.commit()

    return None


def _cleanup_departamento_references_before_delete(
    db: Session,
    *,
    empresa_id: int,
    dept_id: int,
    parent_id: Optional[int],
) -> None:
    """
    Prepara o departamento para exclusão sem quebrar FK.

    Faz:
    - filhos sobem um nível;
    - vínculos/pivôs são removidos;
    - registros de negócio que aceitam NULL ficam sem departamento;
    - se existir FK obrigatória em tabela de negócio, retorna 409 claro em vez de 500.
    """
    dept_id = int(dept_id)
    empresa_id = int(empresa_id)
    new_parent_id = int(parent_id) if parent_id else None

    if new_parent_id == dept_id:
        new_parent_id = None

    # 1) Filhos do departamento sobem para o superior do departamento removido.
    if has_column(models.Departamento, "parent_id"):
        q_children = db.query(models.Departamento).filter(
            models.Departamento.empresa_id == empresa_id,
            models.Departamento.parent_id == dept_id,
        )
        q_children.update(
            {"parent_id": new_parent_id},
            synchronize_session=False,
        )

    # 2) Remove vínculo com instâncias/WhatsApps, se existir.
    if hasattr(models, "DepartamentoInstancia"):
        q_inst = db.query(models.DepartamentoInstancia).filter(
            models.DepartamentoInstancia.departamento_id == dept_id,
        )

        if has_column(models.DepartamentoInstancia, "empresa_id"):
            q_inst = q_inst.filter(models.DepartamentoInstancia.empresa_id == empresa_id)

        q_inst.delete(synchronize_session=False)

    # 3) Varre os models e resolve FKs que apontam para Departamento.
    dept_table = getattr(models.Departamento, "__table__", None)
    dept_table_name = getattr(dept_table, "name", "departamentos")

    seen_tables: set[str] = set()

    for model in vars(models).values():
        table = getattr(model, "__table__", None)

        if table is None or model is models.Departamento:
            continue

        table_name = str(getattr(table, "name", "") or "")
        if not table_name or table_name in seen_tables:
            continue

        seen_tables.add(table_name)

        for col in table.columns:
            col_name = str(getattr(col, "name", "") or "")
            if not col_name:
                continue

            refs_departamento = any(
                getattr(getattr(fk.column, "table", None), "name", None) == dept_table_name
                and getattr(fk.column, "name", None) == "id"
                for fk in getattr(col, "foreign_keys", set())
            )

            # fallback para projetos onde a FK não está declarada no SQLAlchemy,
            # mas a coluna segue o nome padrão.
            if not refs_departamento and col_name != "departamento_id":
                continue

            attr = getattr(model, col_name, None)
            if attr is None:
                continue

            q = db.query(model).filter(attr == dept_id)

            if hasattr(model, "empresa_id"):
                q = q.filter(getattr(model, "empresa_id") == empresa_id)

            # Tabela pivô/associação: pode apagar o vínculo.
            table_lower = table_name.lower()
            is_pivot_or_link = (
                "departamento" in table_lower
                and any(
                    k in table_lower
                    for k in (
                        "instancia",
                        "usuario",
                        "user",
                        "whatsapp",
                        "setor",
                        "permiss",
                        "membro",
                        "member",
                        "colaborador",
                    )
                )
            )

            if is_pivot_or_link:
                q.delete(synchronize_session=False)
                continue

            # Tabela de negócio: não apaga o registro, apenas remove o setor.
            if getattr(col, "nullable", True):
                q.update({col_name: None}, synchronize_session=False)
                continue

            # FK obrigatória: melhor mostrar erro claro do que 500.
            if q.first():
                raise HTTPException(
                    status_code=409,
                    detail=(
                        f"Não dá para remover este departamento porque ele ainda está em uso "
                        f"na tabela '{table_name}'. Primeiro remova/troque o departamento desses registros."
                    ),
                )


@router.delete("/{dept_id}", status_code=status.HTTP_204_NO_CONTENT)
def excluir(
    dept_id: int,
    empresa_id: int = Depends(resolve_empresa_id),
    db: Session = Depends(get_db),
):
    ensure_empresa_exists(db, empresa_id)

    dept = get_departamento_or_404(db, empresa_id, dept_id)

    try:
        _cleanup_departamento_references_before_delete(
            db,
            empresa_id=int(empresa_id),
            dept_id=int(dept.id),
            parent_id=getattr(dept, "parent_id", None),
        )

        db.delete(dept)
        db.flush()

        _rebuild_db_paths_for_empresa(db, int(empresa_id))

        db.commit()
        return None

    except HTTPException:
        db.rollback()
        raise

    except Exception as exc:
        db.rollback()
        raise HTTPException(
            status_code=500,
            detail=f"Erro ao remover departamento: {exc}",
        )


# ==========================================================
# Router de compatibilidade
# Montado no main.py com prefix="/api"
# Final:
# /api/departamentos
# ==========================================================
compat_router = APIRouter(
    prefix="/departamentos",
    tags=["Departamentos (compat)"],
)

compat_router.add_api_route("", listar, methods=["GET"], response_model=List[DepartamentoOut])
compat_router.add_api_route("/tree", tree, methods=["GET"], response_model=List[DepartamentoOut])
compat_router.add_api_route("/{dept_id}", obter, methods=["GET"], response_model=DepartamentoOut)
compat_router.add_api_route("/{dept_id}/membros", listar_membros, methods=["GET"], response_model=List[DepartamentoMembroOut])
compat_router.add_api_route("/{dept_id}/membros", atualizar_membros, methods=["PUT"], response_model=List[DepartamentoMembroOut])
compat_router.add_api_route("", criar, methods=["POST"], response_model=DepartamentoOut, status_code=status.HTTP_201_CREATED)
compat_router.add_api_route("/{dept_id}", atualizar, methods=["PUT"], response_model=DepartamentoOut)
compat_router.add_api_route("/{dept_id}", mover, methods=["PATCH"], status_code=status.HTTP_204_NO_CONTENT)
compat_router.add_api_route("/{dept_id}/move", mover, methods=["PATCH"], status_code=status.HTTP_204_NO_CONTENT)
compat_router.add_api_route("/{dept_id}", excluir, methods=["DELETE"], status_code=status.HTTP_204_NO_CONTENT)