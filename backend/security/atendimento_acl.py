from __future__ import annotations

from typing import Any, Optional, List

from fastapi import HTTPException
from sqlalchemy import text
from sqlalchemy.orm import Session

from backend import models


# =========================================================
# Helpers básicos
# =========================================================
def _to_int(v) -> Optional[int]:
    try:
        if v is None:
            return None
        s = str(v).strip()
        if not s:
            return None
        return int(s)
    except Exception:
        return None


def _is_admin(identity: dict | None) -> bool:
    try:
        if not identity:
            return False

        if identity.get("is_admin") or identity.get("admin"):
            return True

        perms = identity.get("permissoes") or identity.get("permissions") or []
        if isinstance(perms, dict):
            perms = [k for k, v in perms.items() if v]

        perms = set(str(p).lower() for p in (perms or []))
        return any(p in perms for p in ("admin", "root", "clientes.gerenciar", "atendimento.gerenciar"))
    except Exception:
        return False


def _infer_kind(identity: dict | None) -> str:
    if not identity:
        return "usuario"

    k = (identity.get("kind") or identity.get("tipo") or "").lower().strip()
    if k in ("colaborador", "usuario", "admin"):
        return "colaborador" if k == "colaborador" else "usuario"

    sub = str(identity.get("sub") or "").strip().lower()
    role = str(identity.get("role") or "").strip().lower()

    if sub.startswith("colab-") or "colab" in role or "colaborador" in role:
        return "colaborador"

    for key in ("id_colab", "colaborador_id", "id_colaborador", "colab_id", "cid"):
        if _to_int(identity.get(key)):
            return "colaborador"

    return "usuario"


def _get_colab_id(identity: dict | None) -> Optional[int]:
    if not identity:
        return None

    for key in ("id_colab", "colaborador_id", "id_colaborador", "colab_id", "cid"):
        cid = _to_int(identity.get(key))
        if cid:
            return cid

    sub = str(identity.get("sub") or "").strip().lower()
    if sub.startswith("colab-"):
        cid = _to_int(sub.split("-", 1)[1])
        if cid:
            return cid

    return _to_int(identity.get("id"))


def _get_empresa_id(identity: dict | None) -> Optional[int]:
    if not identity:
        return None
    return _to_int(identity.get("empresa_id"))


def _table_exists(db: Session, table_name: str) -> bool:
    try:
        reg = db.execute(text(f"SELECT to_regclass('public.{table_name}')")).scalar()
        return reg is not None
    except Exception:
        return False


# =========================================================
# Empresa / permissão base
# =========================================================
def ensure_perm(identity: dict | None, perm: str) -> None:
    if _is_admin(identity):
        return

    perms = set((identity or {}).get("permissoes") or [])
    if perm not in perms:
        raise HTTPException(status_code=403, detail=f"Sem permissão ({perm})")


def assert_same_company(identity: dict | None, empresa_id: int | None) -> int:
    token_emp = _get_empresa_id(identity)
    if token_emp is None:
        raise HTTPException(status_code=401, detail="Empresa não encontrada no token")

    if empresa_id is None:
        return int(token_emp)

    if int(token_emp) != int(empresa_id):
        raise HTTPException(status_code=403, detail="Empresa inválida para este recurso")

    return int(empresa_id)


# =========================================================
# Instâncias permitidas
# =========================================================
def allowed_instancia_ids(
    db: Session,
    *,
    identity: dict | None,
) -> Optional[List[int]]:
    """
    Retorna:
      - None => sem restrição
      - []   => sem acesso
      - [..] => whitelist de instâncias
    """
    try:
        # IMPORT LAZY pra evitar circular import
        from backend.security.instancias import instancias_visiveis

        ids = instancias_visiveis(identity, db)
        if ids is None:
            return None
        return [int(x) for x in ids]
    except Exception:
        return []


def assert_instancia_allowed(
    *,
    allowed_instancias: Optional[List[int]],
    instancia_id: Optional[int],
    detail: str = "Instância não permitida para este usuário",
) -> None:
    if allowed_instancias is None:
        return

    if not allowed_instancias:
        raise HTTPException(status_code=403, detail="Sem instâncias permitidas para este colaborador")

    if instancia_id is None:
        raise HTTPException(status_code=403, detail=detail)

    if int(instancia_id) not in set(int(x) for x in allowed_instancias):
        raise HTTPException(status_code=403, detail=detail)


# =========================================================
# Departamentos permitidos
# =========================================================
def allowed_departamento_ids(
    db: Session,
    *,
    identity: dict | None,
    empresa_id: int,
) -> Optional[List[int]]:
    """
    Retorna:
      - None => sem restrição (admin / usuário master)
      - []   => sem departamentos permitidos
      - [..] => departamentos do colaborador
    """
    if _is_admin(identity):
        return None

    if _infer_kind(identity) != "colaborador":
        return None

    if not _table_exists(db, "departamentos_membros"):
        return None

    colab_id = _get_colab_id(identity)
    if not colab_id:
        return []

    rows = db.execute(
        text(
            """
            SELECT departamento_id
            FROM departamentos_membros
            WHERE empresa_id = :emp
              AND colaborador_id = :cid
            """
        ),
        {"emp": int(empresa_id), "cid": int(colab_id)},
    ).fetchall()

    deps = [int(r[0]) for r in rows if r and r[0] is not None]
    return deps


def assert_departamento_allowed(
    *,
    allowed_departamentos: Optional[List[int]],
    departamento_id: Optional[int],
    allow_unassigned: bool = False,
    detail: str = "Departamento não permitido para este usuário",
) -> None:
    if allowed_departamentos is None:
        return

    if not allowed_departamentos:
        raise HTTPException(status_code=403, detail="Sem departamentos permitidos para este colaborador")

    if departamento_id is None:
        if allow_unassigned:
            return
        raise HTTPException(status_code=403, detail=detail)

    if int(departamento_id) not in set(int(x) for x in allowed_departamentos):
        raise HTTPException(status_code=403, detail=detail)


# =========================================================
# ACL composta: departamento + instância
# =========================================================
def assert_atendimento_acl(
    *,
    allowed_instancias: Optional[List[int]],
    allowed_departamentos: Optional[List[int]],
    instancia_id: Optional[int],
    departamento_id: Optional[int],
    allow_unassigned_department: bool = False,
) -> None:
    assert_instancia_allowed(
        allowed_instancias=allowed_instancias,
        instancia_id=instancia_id,
    )
    assert_departamento_allowed(
        allowed_departamentos=allowed_departamentos,
        departamento_id=departamento_id,
        allow_unassigned=allow_unassigned_department,
    )


def resolve_acl_context(
    db: Session,
    *,
    identity: dict | None,
    empresa_id: int,
) -> dict:
    empresa_id = assert_same_company(identity, empresa_id)

    return {
        "empresa_id": int(empresa_id),
        "allowed_instancias": allowed_instancia_ids(db, identity=identity),
        "allowed_departamentos": allowed_departamento_ids(
            db,
            identity=identity,
            empresa_id=int(empresa_id),
        ),
    }


# =========================================================
# Lookups de atendimento / cliente
# =========================================================
def get_atendimento_or_404(
    db: Session,
    *,
    empresa_id: int,
    atendimento_id: int,
):
    row = (
        db.query(models.Atendimento)
        .filter(
            models.Atendimento.empresa_id == int(empresa_id),
            models.Atendimento.id == int(atendimento_id),
        )
        .first()
    )
    if not row:
        raise HTTPException(status_code=404, detail="Atendimento não encontrado")
    return row


def get_latest_atendimento_for_cliente(
    db: Session,
    *,
    empresa_id: int,
    cliente_id: int,
    instancia_id: int | None = None,
):
    q = (
        db.query(models.Atendimento)
        .filter(
            models.Atendimento.empresa_id == int(empresa_id),
            models.Atendimento.cliente_id == int(cliente_id),
        )
    )

    if instancia_id is not None:
        q = q.filter(models.Atendimento.instancia_id == int(instancia_id))

    row = q.order_by(models.Atendimento.id.desc()).first()
    return row


def get_cliente_or_404(
    db: Session,
    *,
    empresa_id: int,
    cliente_id: int,
):
    row = (
        db.query(models.Cliente)
        .filter(
            models.Cliente.empresa_id == int(empresa_id),
            models.Cliente.id == int(cliente_id),
        )
        .first()
    )
    if not row:
        raise HTTPException(status_code=404, detail="Cliente não encontrado")
    return row


# =========================================================
# Asserts de acesso prontos para usar nas rotas
# =========================================================
def assert_atendimento_access(
    db: Session,
    *,
    identity: dict | None,
    empresa_id: int,
    atendimento_id: int,
    allow_unassigned_department: bool = False,
):
    ctx = resolve_acl_context(db, identity=identity, empresa_id=empresa_id)
    atendimento = get_atendimento_or_404(
        db,
        empresa_id=int(ctx["empresa_id"]),
        atendimento_id=int(atendimento_id),
    )

    assert_atendimento_acl(
        allowed_instancias=ctx["allowed_instancias"],
        allowed_departamentos=ctx["allowed_departamentos"],
        instancia_id=getattr(atendimento, "instancia_id", None),
        departamento_id=getattr(atendimento, "departamento_id", None),
        allow_unassigned_department=allow_unassigned_department,
    )

    return atendimento


def assert_cliente_access(
    db: Session,
    *,
    identity: dict | None,
    empresa_id: int,
    cliente_id: int,
    instancia_id: int | None = None,
    allow_unassigned_department: bool = False,
):
    ctx = resolve_acl_context(db, identity=identity, empresa_id=empresa_id)

    cliente = get_cliente_or_404(
        db,
        empresa_id=int(ctx["empresa_id"]),
        cliente_id=int(cliente_id),
    )

    atendimento = get_latest_atendimento_for_cliente(
        db,
        empresa_id=int(ctx["empresa_id"]),
        cliente_id=int(cliente_id),
        instancia_id=instancia_id,
    )

    if atendimento is not None:
        assert_atendimento_acl(
            allowed_instancias=ctx["allowed_instancias"],
            allowed_departamentos=ctx["allowed_departamentos"],
            instancia_id=getattr(atendimento, "instancia_id", None),
            departamento_id=getattr(atendimento, "departamento_id", None),
            allow_unassigned_department=allow_unassigned_department,
        )
        return cliente, atendimento

    fallback_instancia_id = instancia_id
    if fallback_instancia_id is None:
        fallback_instancia_id = getattr(cliente, "instancia_id", None)

    fallback_departamento_id = getattr(cliente, "departamento_id", None)

    assert_atendimento_acl(
        allowed_instancias=ctx["allowed_instancias"],
        allowed_departamentos=ctx["allowed_departamentos"],
        instancia_id=fallback_instancia_id,
        departamento_id=fallback_departamento_id,
        allow_unassigned_department=allow_unassigned_department,
    )

    return cliente, None


def build_allowed_filters(
    *,
    allowed_instancias: Optional[List[int]],
    allowed_departamentos: Optional[List[int]],
) -> dict:
    return {
        "instancias": None if allowed_instancias is None else [int(x) for x in allowed_instancias],
        "departamentos": None if allowed_departamentos is None else [int(x) for x in allowed_departamentos],
    }


__all__ = [
    "ensure_perm",
    "assert_same_company",
    "allowed_instancia_ids",
    "allowed_departamento_ids",
    "assert_instancia_allowed",
    "assert_departamento_allowed",
    "assert_atendimento_acl",
    "resolve_acl_context",
    "get_atendimento_or_404",
    "get_latest_atendimento_for_cliente",
    "get_cliente_or_404",
    "assert_atendimento_access",
    "assert_cliente_access",
    "build_allowed_filters",
]