#backend\routers\atendimento_conversas\colaborador_helpers.py
from __future__ import annotations

from typing import Optional, List, Any

from fastapi import HTTPException
from sqlalchemy.orm import Session
from sqlalchemy import func
from sqlalchemy.exc import IntegrityError

from backend import models

from .utils import (
    _table_exists,
    _to_int,
    _id_get,
)


def _get_colab_id(identity: Any) -> Optional[int]:
    """
    Retorna SOMENTE ids explícitos de colaborador.

    Importante:
    não usa mais o campo genérico `id`, porque no login admin
    esse `id` normalmente é o id do usuário/admin e não o id da
    tabela `colaboradores`.
    """
    for key in ("id_colab", "colaborador_id", "id_colaborador", "colab_id", "cid"):
        cid = _to_int(_id_get(identity, key))
        if cid:
            return cid

    sub = str(_id_get(identity, "sub") or "").strip().lower()
    if sub.startswith("colab-"):
        try:
            return int(sub.split("-", 1)[1])
        except Exception:
            return None

    return None


def _get_user_id(identity: Any) -> Optional[int]:
    """
    Resolve ids de usuário/admin.
    """
    for key in ("usuario_id", "user_id", "id_usuario", "uid", "userId", "usuarioId"):
        uid = _to_int(_id_get(identity, key))
        if uid:
            return uid

    sub = str(_id_get(identity, "sub") or "").strip().lower()
    if sub and not sub.startswith("colab-"):
        maybe = _to_int(sub)
        if maybe:
            return maybe

    kind = str(_id_get(identity, "kind") or "").strip().lower()
    if kind == "usuario":
        maybe = _to_int(_id_get(identity, "id"))
        if maybe:
            return maybe

    is_admin = bool(_id_get(identity, "is_admin"))
    role = str(_id_get(identity, "role") or "").strip().lower()
    if is_admin or role == "admin":
        maybe = _to_int(_id_get(identity, "id"))
        if maybe:
            return maybe

    return None


def _is_admin_identity(identity: Any) -> bool:
    if bool(_id_get(identity, "is_admin")):
        return True

    role = str(_id_get(identity, "role") or "").strip().lower()
    if role == "admin":
        return True

    kind = str(_id_get(identity, "kind") or "").strip().lower()
    if kind == "usuario":
        return True

    sub = str(_id_get(identity, "sub") or "").strip().lower()
    if sub and not sub.startswith("colab-"):
        maybe = _to_int(sub)
        if maybe:
            return True

    return False


def _identity_email_candidates(identity: Any) -> List[str]:
    out: List[str] = []

    for key in (
        "email",
        "preferred_username",
        "username",
        "login",
        "usuario_email",
        "user_email",
    ):
        raw = _id_get(identity, key)
        if not raw:
            continue

        email = str(raw).strip().lower()
        if email and email not in out:
            out.append(email)

    return out


def _colaborador_exists(
    db: Session,
    *,
    empresa_id: int,
    colaborador_id: Optional[int],
) -> bool:
    if colaborador_id is None:
        return False

    row = (
        db.query(models.Colaborador.id)
        .filter(
            models.Colaborador.empresa_id == int(empresa_id),
            models.Colaborador.id == int(colaborador_id),
        )
        .first()
    )

    return bool(row)


def _find_identity_usuario(
    db: Session,
    *,
    identity: Any,
    empresa_id: int,
):
    if not hasattr(models, "Usuario"):
        return None

    user_id = _get_user_id(identity)

    if user_id:
        row = (
            db.query(models.Usuario)
            .filter(
                models.Usuario.empresa_id == int(empresa_id),
                models.Usuario.id == int(user_id),
            )
            .first()
        )
        if row:
            return row

    email_candidates = _identity_email_candidates(identity)

    for email in email_candidates:
        row = (
            db.query(models.Usuario)
            .filter(
                models.Usuario.empresa_id == int(empresa_id),
                func.lower(models.Usuario.email) == email,
            )
            .first()
        )
        if row:
            return row

    return None


def _find_identity_colaborador(
    db: Session,
    *,
    identity: Any,
    empresa_id: int,
):
    # 1) tenta direto pelo id explícito de colaborador no token
    token_colab_id = _get_colab_id(identity)

    if token_colab_id and _colaborador_exists(
        db,
        empresa_id=int(empresa_id),
        colaborador_id=int(token_colab_id),
    ):
        return (
            db.query(models.Colaborador)
            .filter(
                models.Colaborador.empresa_id == int(empresa_id),
                models.Colaborador.id == int(token_colab_id),
            )
            .first()
        )

    # 2) tenta por usuario_id vinculado
    user_id_candidates: List[int] = []
    user_id = _get_user_id(identity)
    if user_id:
        user_id_candidates.append(int(user_id))

    for key in ("usuario_id", "user_id", "id_usuario", "uid", "userId", "usuarioId"):
        v = _to_int(_id_get(identity, key))
        if v and v not in user_id_candidates:
            user_id_candidates.append(int(v))

    for attr_name in ("usuario_id", "user_id", "id_usuario"):
        if not hasattr(models.Colaborador, attr_name):
            continue

        attr = getattr(models.Colaborador, attr_name)

        for uid in user_id_candidates:
            row = (
                db.query(models.Colaborador)
                .filter(
                    models.Colaborador.empresa_id == int(empresa_id),
                    attr == int(uid),
                )
                .first()
            )
            if row:
                return row

    # 3) tenta por email
    email_candidates = _identity_email_candidates(identity)

    if hasattr(models.Colaborador, "email"):
        for email in email_candidates:
            row = (
                db.query(models.Colaborador)
                .filter(
                    models.Colaborador.empresa_id == int(empresa_id),
                    func.lower(models.Colaborador.email) == email,
                )
                .first()
            )
            if row:
                return row

    return None


def _all_empresa_instancias_ids(
    db: Session,
    *,
    empresa_id: int,
) -> List[int]:
    rows = (
        db.query(models.EmpresaInstancia.id)
        .filter(models.EmpresaInstancia.empresa_id == int(empresa_id))
        .order_by(models.EmpresaInstancia.id.asc())
        .all()
    )
    out: List[int] = []
    for row in rows:
        iid = _to_int(row[0] if isinstance(row, tuple) else getattr(row, "id", None))
        if iid:
            out.append(int(iid))
    return out


def _ensure_admin_identity_as_colaborador(
    db: Session,
    *,
    identity: Any,
    empresa_id: int,
):
    """
    Comportamento estilo CRM:
    se o admin dono da empresa ainda não tiver registro em `colaboradores`,
    cria automaticamente um vínculo mínimo para que ele possa participar dos
    atendimentos normalmente.
    """
    if not _is_admin_identity(identity):
        return None

    user = _find_identity_usuario(
        db,
        identity=identity,
        empresa_id=int(empresa_id),
    )
    if not user:
        return None

    # recheck por segurança antes de criar
    existing = _find_identity_colaborador(
        db,
        identity=identity,
        empresa_id=int(empresa_id),
    )
    if existing:
        updated = False

        if hasattr(existing, "usuario_id") and getattr(existing, "usuario_id", None) is None:
            existing.usuario_id = int(user.id)
            updated = True

        if hasattr(existing, "cargo") and not getattr(existing, "cargo", None):
            existing.cargo = "admin"
            updated = True

        if hasattr(existing, "instancias_ver"):
            insts = _all_empresa_instancias_ids(db, empresa_id=int(empresa_id))
            if insts and not getattr(existing, "instancias_ver", None):
                existing.instancias_ver = insts
                updated = True

        if updated:
            db.add(existing)
            try:
                db.flush()
            except Exception:
                pass

        return existing

    nome = (getattr(user, "nome", None) or "Administrador").strip()
    email = (getattr(user, "email", None) or "").strip().lower()
    senha_base = getattr(user, "senha_hash", None) or "__admin_linked__"
    cargo = (getattr(user, "cargo", None) or "admin").strip() or "admin"

    kwargs = {
        "empresa_id": int(empresa_id),
        "nome": nome,
        "email": email,
        "senha": senha_base,
        "cargo": cargo,
    }

    if hasattr(models.Colaborador, "usuario_id"):
        kwargs["usuario_id"] = int(user.id)

    if hasattr(models.Colaborador, "telefone"):
        kwargs["telefone"] = None

    if hasattr(models.Colaborador, "avatar_data") and hasattr(user, "avatar_data"):
        kwargs["avatar_data"] = getattr(user, "avatar_data", None)

    if hasattr(models.Colaborador, "avatar_mime") and hasattr(user, "avatar_mime"):
        kwargs["avatar_mime"] = getattr(user, "avatar_mime", None)

    if hasattr(models.Colaborador, "instancias_ver"):
        kwargs["instancias_ver"] = _all_empresa_instancias_ids(
            db,
            empresa_id=int(empresa_id),
        )

    novo = models.Colaborador(**kwargs)

    try:
        with db.begin_nested():
            db.add(novo)
            db.flush()
    except IntegrityError:
        # concorrência ou já existia por email/usuario_id
        pass

    row = _find_identity_colaborador(
        db,
        identity=identity,
        empresa_id=int(empresa_id),
    )
    if row:
        return row

    # último fallback: tenta achar pelo usuario_id criado
    if hasattr(models.Colaborador, "usuario_id"):
        row = (
            db.query(models.Colaborador)
            .filter(
                models.Colaborador.empresa_id == int(empresa_id),
                models.Colaborador.usuario_id == int(user.id),
            )
            .first()
        )
        if row:
            return row

    return None


def _resolve_identity_colab_id(
    db: Session,
    *,
    identity: Any,
    empresa_id: int,
    required: bool = False,
) -> Optional[int]:
    row = _find_identity_colaborador(
        db,
        identity=identity,
        empresa_id=int(empresa_id),
    )

    if not row:
        row = _ensure_admin_identity_as_colaborador(
            db,
            identity=identity,
            empresa_id=int(empresa_id),
        )

    if row:
        return int(row.id)

    if required:
        raise HTTPException(
            status_code=409,
            detail=(
                "Seu login não está vinculado a um colaborador válido desta empresa. "
                "Faça login novamente ou confira o cadastro do colaborador."
            ),
        )

    return None


def _cliente_instancia_mais_recente(
    db: Session,
    *,
    empresa_id: int,
    cliente_id: int,
    allowed_inst_ids: Optional[List[int]],
) -> Optional[int]:
    q = (
        db.query(models.Mensagem.instancia_id)
        .filter(
            models.Mensagem.empresa_id == int(empresa_id),
            models.Mensagem.cliente_id == int(cliente_id),
            models.Mensagem.instancia_id.isnot(None),
        )
        .order_by(models.Mensagem.timestamp.desc(), models.Mensagem.id.desc())
    )

    if allowed_inst_ids is not None:
        if not allowed_inst_ids:
            return None

        q = q.filter(models.Mensagem.instancia_id.in_([int(x) for x in allowed_inst_ids]))

    row = q.first()

    if row and row[0] is not None:
        return int(row[0])

    return None


def _latest_atendimento_for_cliente_instancia(
    db: Session,
    *,
    empresa_id: int,
    cliente_id: int,
    instancia_id: Optional[int],
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

    return q.order_by(models.Atendimento.id.desc()).first()


def _assert_departamento_acl_for_row(
    *,
    allowed_dep_ids: Optional[List[int]],
    departamento_id: Optional[int],
) -> None:
    """
    Regras:
    - None => admin/usuario master -> sem filtro
    - []   => colaborador sem membership -> só pode ver SEM departamento
    - [..] => pode ver depto dele + SEM departamento
    """
    if allowed_dep_ids is None:
        return

    if not allowed_dep_ids:
        if departamento_id is None:
            return

        raise HTTPException(
            status_code=403,
            detail="Departamento não permitido para este colaborador",
        )

    if departamento_id is None:
        return

    if int(departamento_id) not in set(int(x) for x in allowed_dep_ids):
        raise HTTPException(
            status_code=403,
            detail="Departamento não permitido para este colaborador",
        )


def _instancia_permitida_para_colaborador(
    db: Session,
    *,
    colaborador_id: int,
    empresa_id: int,
    instancia_id: int,
) -> bool:
    colab = (
        db.query(models.Colaborador)
        .filter(
            models.Colaborador.id == int(colaborador_id),
            models.Colaborador.empresa_id == int(empresa_id),
        )
        .first()
    )

    if not colab:
        return False

    raw = getattr(colab, "instancias_ver", None)

    if not raw:
        return False

    try:
        norm = [int(x) for x in raw if x is not None]
    except Exception:
        norm = []

    return int(instancia_id) in set(norm)


def _departamento_permitido_para_colaborador(
    db: Session,
    *,
    colaborador_id: int,
    empresa_id: int,
    departamento_id: Optional[int],
) -> bool:
    if departamento_id is None:
        return True

    if not _table_exists(db, "departamentos_membros"):
        return True

    row = (
        db.query(models.DepartamentoMembro.id)
        .filter(
            models.DepartamentoMembro.empresa_id == int(empresa_id),
            models.DepartamentoMembro.colaborador_id == int(colaborador_id),
            models.DepartamentoMembro.departamento_id == int(departamento_id),
        )
        .first()
    )

    return bool(row)


def _nome_colaborador(
    db: Session,
    colaborador_id: Optional[int],
) -> Optional[str]:
    if colaborador_id is None:
        return None

    row = (
        db.query(models.Colaborador)
        .filter(models.Colaborador.id == int(colaborador_id))
        .first()
    )

    return row.nome if row else None