# backend/routers/departamentos.py
from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import datetime
from typing import List, Optional, Dict, Any, Set

from fastapi import APIRouter, Depends, HTTPException, Header, Query, status
from pydantic import BaseModel, Field, ConfigDict, field_validator
from sqlalchemy import func
from sqlalchemy.orm import Session

from backend.database import get_db
from backend import models
from backend.routers.auth import get_current_user

# ==========================================================
# Router "oficial" (fica montado em /api + este prefixo)
# => /api/atendimento/clientes/departamentos
# ==========================================================
router = APIRouter(
    prefix="/atendimento/clientes/departamentos",
    tags=["Departamentos"],
)

# ==========================================================
# Permissões
# ==========================================================

# mesma nomenclatura do PERMISSOES_CATALOGO em permissoes.py
PERM_DEPT_GERENCIAR = "departamentos.gerenciar"
PERM_CLIENTES_VER   = "clientes.ver"
PERM_ATEND_VER      = "atendimento.ver"

# quem pode LISTAR departamentos (combos dos módulos)
PERM_LIST_ALLOW: Set[str] = {
    PERM_DEPT_GERENCIAR,   # tela de Departamentos
    PERM_CLIENTES_VER,     # tela de Clientes
    PERM_ATEND_VER,        # tela de Atendimentos
}


def _is_admin(user) -> bool:
    """
    Mesma ideia usada em atendimento.py:
    considera admin se user.is_admin == True OU
    se as permissões conterem 'admin', 'root',
    'clientes.gerenciar' ou 'atendimento.gerenciar'.
    """
    try:
        if getattr(user, "is_admin", False):
            return True
        perms = getattr(user, "permissoes", None) or getattr(user, "permissions", None) or []
        if isinstance(perms, dict):
            perms = [k for k, v in perms.items() if v]
        perms = set(str(p).lower() for p in (perms or []))
        return any(
            p in perms
            for p in (
                "admin",
                "root",
                "clientes.gerenciar",
                "atendimento.gerenciar",
            )
        )
    except Exception:
        return False


def _perms_set(user) -> Set[str]:
    perms = getattr(user, "permissoes", None) or getattr(user, "permissions", None) or []
    if isinstance(perms, dict):
        perms = [k for k, v in perms.items() if v]
    return {str(p).lower() for p in (perms or [])}


def _require_any_perm(user, allowed: Set[str], detail: str = "Permissão insuficiente"):
    """
    Libera:
      - admins (is_admin / root / clientes.gerenciar / atendimento.gerenciar)
      - OU colaboradores que tenham pelo menos 1 perm em `allowed`.
    """
    if _is_admin(user):
        return
    perms = _perms_set(user)
    if not perms.intersection({p.lower() for p in allowed}):
        raise HTTPException(status_code=403, detail=detail)


def _require_gerenciar_departamentos(user):
    _require_any_perm(
        user,
        {PERM_DEPT_GERENCIAR},
        detail="Permissão 'departamentos.gerenciar' é obrigatória para alterar departamentos.",
    )


# ========= Schemas =========


class DepartamentoIn(BaseModel):
    nome: str = Field(min_length=1, max_length=80)
    descricao: Optional[str] = Field(default=None, max_length=300)
    # campos hierárquicos/extra (opcionais e ignorados se o modelo não tiver as colunas)
    parent_id: Optional[int] = Field(default=None)
    codigo: Optional[str] = Field(default=None, max_length=64)
    ativo: Optional[bool] = Field(default=True)

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

    # extras (preenchidos se existirem no modelo)
    parent_id: int | None = None
    codigo: str | None = None
    ativo: bool | None = None
    path: List[str] | None = None

    model_config = ConfigDict(from_attributes=True)


class MoveIn(BaseModel):
    new_parent_id: int | None = Field(default=None)


# ========= Helpers =========


def resolve_empresa_id(
    current_user=Depends(get_current_user),
    x_empresa_id: Optional[int] = Header(default=None, alias="X-Empresa-Id"),
    empresa_id_qs: Optional[int] = Query(default=None, alias="empresa_id"),
) -> int:
    """
    Resolve o empresa_id a partir:
      1) do usuário logado (sempre),
      2) opcionalmente header X-Empresa-Id ou ?empresa_id=.

    Se vier header/query diferente da empresa do usuário, bloqueia (403)
    para evitar que uma empresa force ID de outra.
    """
    base_id = current_user.empresa_id
    empresa_id = x_empresa_id or empresa_id_qs or base_id
    if not empresa_id:
        raise HTTPException(
            status_code=400,
            detail="empresa_id é obrigatório (usuário sem empresa ou header/query ausente)",
        )
    empresa_id = int(empresa_id)
    if empresa_id != base_id:
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
            # fallback: só o nome
            r["path"] = [r["nome"]]

    return rows


def assert_no_cycle(moving_id: int, new_parent_id: Optional[int], rows: List[Dict[str, Any]]):
    """Evita ciclos ao mover (new_parent não pode ser filho do moving)."""
    if new_parent_id is None:
        return
    by_id = {r["id"]: r for r in rows}
    # sobe ancestrais do target até raiz; se encontrar moving_id, é ciclo
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
    user=Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    Lista todos os departamentos da empresa.

    Permissão:
      - admin/root/clientes.gerenciar/atendimento.gerenciar
      - OU qualquer colaborador com pelo menos uma destas:
        * departamentos.gerenciar
        * clientes.ver
        * atendimento.ver
    Isso permite que a tela de Clientes/Atendimentos carregue os combos
    de setores sem precisar dar permissão total de gerenciamento.
    """
    _require_any_perm(user, PERM_LIST_ALLOW)
    ensure_empresa_exists(db, empresa_id)
    itens = (
        db.query(models.Departamento)
        .filter(models.Departamento.empresa_id == empresa_id)
        .order_by(func.lower(models.Departamento.nome))
        .all()
    )
    # mapeia para incluir extras quando existirem
    out: List[DepartamentoOut] = []
    for it in itens:
        d = dept_to_dict(it)
        out.append(DepartamentoOut(**d))
    return out


@router.get("/tree", response_model=List[DepartamentoOut])
def tree(
    empresa_id: int = Depends(resolve_empresa_id),
    user=Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    Retorna lista plana com campos suficientes para montar árvore no front.
    Mesma regra de permissão de `listar`.
    """
    _require_any_perm(user, PERM_LIST_ALLOW)
    ensure_empresa_exists(db, empresa_id)
    itens = (
        db.query(models.Departamento)
        .filter(models.Departamento.empresa_id == empresa_id)
        .all()
    )
    rows = [dept_to_dict(it) for it in itens]

    # calcula path em memória quando necessário
    has_parent = any(r.get("parent_id") is not None for r in rows) or has_column(
        models.Departamento, "parent_id"
    )
    if not has_parent:
        # sem hierarquia: path é só [nome]
        for r in rows:
            r["path"] = [r["nome"]]
    else:
        rows = build_paths(rows)

    # ordena por path (estável) para exibição
    rows.sort(key=lambda r: " / ".join(r.get("path") or [r["nome"]]).lower())
    return [DepartamentoOut(**r) for r in rows]


@router.get("/{dept_id}", response_model=DepartamentoOut)
def obter(
    dept_id: int,
    empresa_id: int = Depends(resolve_empresa_id),
    user=Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _require_any_perm(user, PERM_LIST_ALLOW)
    ensure_empresa_exists(db, empresa_id)
    dept = get_departamento_or_404(db, empresa_id, dept_id)
    return DepartamentoOut(**dept_to_dict(dept))


@router.post("", response_model=DepartamentoOut, status_code=status.HTTP_201_CREATED)
def criar(
    payload: DepartamentoIn,
    empresa_id: int = Depends(resolve_empresa_id),
    user=Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Cria um novo departamento (nome único por empresa)."""
    _require_gerenciar_departamentos(user)
    ensure_empresa_exists(db, empresa_id)
    nome = payload.nome.strip()
    ensure_nome_unico(db, empresa_id, nome)

    novo = models.Departamento(
        empresa_id=empresa_id,
        nome=nome,
        descricao=payload.descricao or None,
    )

    # escreve extras se o modelo tiver essas colunas
    if has_column(models.Departamento, "parent_id"):
        setattr(novo, "parent_id", payload.parent_id)
    if has_column(models.Departamento, "codigo"):
        setattr(novo, "codigo", (payload.codigo or None))
    if has_column(models.Departamento, "ativo"):
        setattr(novo, "ativo", True if payload.ativo is None else bool(payload.ativo))

    db.add(novo)
    db.commit()
    db.refresh(novo)
    return DepartamentoOut(**dept_to_dict(novo))


@router.put("/{dept_id}", response_model=DepartamentoOut)
def atualizar(
    dept_id: int,
    payload: DepartamentoIn,
    empresa_id: int = Depends(resolve_empresa_id),
    user=Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Atualiza dados do departamento (nome/descrição e extras quando existirem)."""
    _require_gerenciar_departamentos(user)
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

    db.commit()
    db.refresh(dept)
    return DepartamentoOut(**dept_to_dict(dept))


@router.patch("/{dept_id}/move", status_code=status.HTTP_204_NO_CONTENT)
def mover(
    dept_id: int,
    payload: MoveIn,
    empresa_id: int = Depends(resolve_empresa_id),
    user=Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    Move o departamento para um novo superior (new_parent_id).
    Requer a coluna parent_id no modelo. Evita ciclos.
    """
    _require_gerenciar_departamentos(user)
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

    # carrega todos para verificar ciclo
    itens = (
        db.query(models.Departamento)
        .filter(models.Departamento.empresa_id == empresa_id)
        .all()
    )
    rows = [dept_to_dict(it) for it in itens]
    rows = build_paths(rows)
    assert_no_cycle(dept.id, payload.new_parent_id, rows)

    # verifica se o novo parent existe (ou None)
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
    user=Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Exclui um departamento."""
    _require_gerenciar_departamentos(user)
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
