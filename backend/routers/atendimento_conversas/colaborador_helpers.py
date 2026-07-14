# backend/routers/atendimento_conversas/colaborador_helpers.py
from __future__ import annotations

from typing import Optional, List, Any
import re
import unicodedata

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


def _norm_dept_name(value: Any) -> str:
    try:
        txt = str(value or "").strip().lower()
        if not txt:
            return ""
        txt = unicodedata.normalize("NFKD", txt)
        txt = "".join(ch for ch in txt if not unicodedata.combining(ch))
        txt = re.sub(r"^\s*\d+\s*[-–—.:/)]+\s*", "", txt)
        txt = re.sub(r"[^a-z0-9]+", " ", txt)
        txt = re.sub(r"\s+", " ", txt).strip()
        return txt
    except Exception:
        return ""


def _find_departamento_ids_by_fuzzy_name(
    db: Session,
    *,
    empresa_id: int,
    nome: Any,
) -> List[int]:
    alvo = _norm_dept_name(nome)
    if not alvo:
        return []
    try:
        rows = (
            db.query(models.Departamento.id, models.Departamento.nome)
            .filter(models.Departamento.empresa_id == int(empresa_id))
            .all()
        )
    except Exception:
        return []
    out: List[int] = []
    for dep_id, dep_nome in rows:
        dep_norm = _norm_dept_name(dep_nome)
        if dep_norm and (dep_norm == alvo or dep_norm.endswith(" " + alvo) or alvo.endswith(" " + dep_norm)):
            try:
                did = int(dep_id)
                if did not in out:
                    out.append(did)
            except Exception:
                pass
    return out


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

    if bool(_id_get(identity, "admin")):
        return True

    role = str(_id_get(identity, "role") or "").strip().lower()
    if role == "admin":
        return True

    kind = str(_id_get(identity, "kind") or _id_get(identity, "tipo") or "").strip().lower()
    if kind == "usuario":
        return True

    sub = str(_id_get(identity, "sub") or "").strip().lower()
    if sub and not sub.startswith("colab-"):
        maybe = _to_int(sub)
        if maybe:
            return True

    perms = _id_get(identity, "permissoes") or _id_get(identity, "permissions") or []
    if isinstance(perms, dict):
        perms = [k for k, v in perms.items() if v]

    perms_lower = set(str(p).strip().lower() for p in (perms or []))
    if any(
        p in perms_lower
        for p in (
            "admin",
            "root",
            "clientes.gerenciar",
            "atendimento.gerenciar",
        )
    ):
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


def _all_empresa_departamentos_ids(
    db: Session,
    *,
    empresa_id: int,
) -> List[int]:
    if not hasattr(models, "Departamento"):
        return []

    rows = (
        db.query(models.Departamento.id)
        .filter(models.Departamento.empresa_id == int(empresa_id))
        .order_by(models.Departamento.id.asc())
        .all()
    )

    out: List[int] = []

    for row in rows:
        dep_id = _to_int(row[0] if isinstance(row, tuple) else getattr(row, "id", None))
        if dep_id:
            out.append(int(dep_id))

    return out


def _sync_admin_departamentos_membros(
    db: Session,
    *,
    empresa_id: int,
    colaborador_id: int,
) -> None:
    """
    Para o admin criado automaticamente como colaborador,
    garante vínculo com todos os departamentos.

    Mesmo que admin normalmente tenha bypass, isso ajuda em telas antigas
    que validam direto pelo colaborador_id.
    """
    if not hasattr(models, "DepartamentoMembro"):
        return

    if not _table_exists(db, "departamentos_membros"):
        return

    dep_ids = _all_empresa_departamentos_ids(db, empresa_id=int(empresa_id))
    if not dep_ids:
        return

    existing_rows = (
        db.query(models.DepartamentoMembro.departamento_id)
        .filter(
            models.DepartamentoMembro.empresa_id == int(empresa_id),
            models.DepartamentoMembro.colaborador_id == int(colaborador_id),
        )
        .all()
    )

    existing = {
        int(r[0])
        for r in existing_rows
        if r and r[0] is not None
    }

    first = True

    for dep_id in dep_ids:
        if int(dep_id) in existing:
            continue

        db.add(
            models.DepartamentoMembro(
                empresa_id=int(empresa_id),
                departamento_id=int(dep_id),
                colaborador_id=int(colaborador_id),
                role="member",
                is_primary=bool(first),
            )
        )
        first = False

    try:
        db.flush()
    except Exception:
        pass


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

        _sync_admin_departamentos_membros(
            db,
            empresa_id=int(empresa_id),
            colaborador_id=int(existing.id),
        )

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
        _sync_admin_departamentos_membros(
            db,
            empresa_id=int(empresa_id),
            colaborador_id=int(row.id),
        )
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
            _sync_admin_departamentos_membros(
                db,
                empresa_id=int(empresa_id),
                colaborador_id=int(row.id),
            )
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
    """Prefere o atendimento aberto; usa o último fechado apenas como fallback."""
    base = (
        db.query(models.Atendimento)
        .filter(
            models.Atendimento.empresa_id == int(empresa_id),
            models.Atendimento.cliente_id == int(cliente_id),
        )
    )

    if instancia_id is not None:
        base = base.filter(models.Atendimento.instancia_id == int(instancia_id))

    enum_cls = getattr(models, "StatusAtendimento", None)
    if enum_cls is not None:
        open_values = [
            getattr(enum_cls, name)
            for name in ("NOVO", "AGUARDANDO", "EM_ATENDIMENTO", "PAUSADO")
            if hasattr(enum_cls, name)
        ]
    else:
        open_values = ["novo", "aguardando", "em_atendimento", "pausado"]

    opened = (
        base.filter(models.Atendimento.status.in_(open_values))
        .order_by(models.Atendimento.id.desc())
        .first()
    )
    if opened is not None:
        return opened

    return base.order_by(models.Atendimento.id.desc()).first()


def _expand_departamento_ids_with_descendants(
    db: Session,
    *,
    empresa_id: int,
    departamento_ids: List[int],
) -> List[int]:
    """
    Modelo 2:
    se o colaborador atende um departamento pai, libera também os filhos.
    """
    base: List[int] = []

    for raw in departamento_ids or []:
        dep_id = _to_int(raw)
        if dep_id and dep_id not in base:
            base.append(int(dep_id))

    if not base:
        return []

    if not hasattr(models, "Departamento"):
        return base

    if not hasattr(models.Departamento, "parent_id"):
        return base

    try:
        rows = (
            db.query(models.Departamento.id, models.Departamento.parent_id)
            .filter(models.Departamento.empresa_id == int(empresa_id))
            .all()
        )
    except Exception:
        return base

    children_by_parent: dict[int, list[int]] = {}

    for dep_id_raw, parent_id_raw in rows:
        dep_id = _to_int(dep_id_raw)
        parent_id = _to_int(parent_id_raw)

        if dep_id is None or parent_id is None:
            continue

        children_by_parent.setdefault(int(parent_id), []).append(int(dep_id))

    out: List[int] = []
    queue: List[int] = list(base)

    while queue:
        dep_id = queue.pop(0)

        if dep_id in out:
            continue

        out.append(int(dep_id))

        for child_id in children_by_parent.get(int(dep_id), []):
            if child_id not in out:
                queue.append(int(child_id))

    return out


def _fallback_departamentos_do_colaborador_por_setor(
    db: Session,
    *,
    empresa_id: int,
    colaborador_id: int,
) -> List[int]:
    """
    Compatibilidade com dados antigos.

    Antes do Modelo 2, muitos colaboradores tinham apenas setor_id.
    Agora o correto é departamentos_membros.
    """
    colab = (
        db.query(models.Colaborador)
        .filter(
            models.Colaborador.empresa_id == int(empresa_id),
            models.Colaborador.id == int(colaborador_id),
        )
        .first()
    )

    if not colab:
        return []

    setor_id = _to_int(getattr(colab, "setor_id", None))
    if not setor_id:
        return []

    out: List[int] = []

    dep_direct = (
        db.query(models.Departamento.id)
        .filter(
            models.Departamento.empresa_id == int(empresa_id),
            models.Departamento.id == int(setor_id),
        )
        .first()
    )

    if dep_direct and dep_direct[0] is not None:
        out.append(int(dep_direct[0]))

    setor_nome = None

    if hasattr(models, "Setor"):
        try:
            setor = (
                db.query(models.Setor)
                .filter(
                    models.Setor.empresa_id == int(empresa_id),
                    models.Setor.id == int(setor_id),
                )
                .first()
            )
            setor_nome = getattr(setor, "nome", None) if setor else None
        except Exception:
            setor_nome = None

    if setor_nome:
        for dep_id in _find_departamento_ids_by_fuzzy_name(
            db,
            empresa_id=int(empresa_id),
            nome=setor_nome,
        ):
            if dep_id not in out:
                out.append(dep_id)

        if not out:
            dep_by_name = (
                db.query(models.Departamento.id)
                .filter(
                    models.Departamento.empresa_id == int(empresa_id),
                    func.lower(func.trim(models.Departamento.nome)) == func.lower(func.trim(str(setor_nome))),
                )
                .first()
            )

            if dep_by_name and dep_by_name[0] is not None:
                dep_id = int(dep_by_name[0])
                if dep_id not in out:
                    out.append(dep_id)

    return out


def _departamentos_permitidos_para_colaborador(
    db: Session,
    *,
    colaborador_id: int,
    empresa_id: int,
) -> List[int]:
    """
    Retorna departamentos do colaborador pelo Modelo 2.

    Fonte principal:
      departamentos_membros

    Fallback:
      colaboradores.setor_id
    """
    if not hasattr(models, "DepartamentoMembro"):
        return []

    if not _table_exists(db, "departamentos_membros"):
        return []

    rows = (
        db.query(models.DepartamentoMembro.departamento_id)
        .filter(
            models.DepartamentoMembro.empresa_id == int(empresa_id),
            models.DepartamentoMembro.colaborador_id == int(colaborador_id),
        )
        .order_by(
            models.DepartamentoMembro.is_primary.desc(),
            models.DepartamentoMembro.departamento_id.asc(),
        )
        .all()
    )

    deps: List[int] = []

    for row in rows:
        dep_id = _to_int(row[0] if isinstance(row, tuple) else getattr(row, "departamento_id", None))
        if dep_id and dep_id not in deps:
            deps.append(int(dep_id))

    if not deps:
        deps = _fallback_departamentos_do_colaborador_por_setor(
            db,
            empresa_id=int(empresa_id),
            colaborador_id=int(colaborador_id),
        )

    return _expand_departamento_ids_with_descendants(
        db,
        empresa_id=int(empresa_id),
        departamento_ids=deps,
    )


def _assert_departamento_acl_for_row(
    *,
    allowed_dep_ids: Optional[List[int]],
    departamento_id: Optional[int],
) -> None:
    """
    Modelo 2:

    - None => admin/usuário master -> sem filtro
    - []   => colaborador sem departamento permitido
    - [..] => departamentos permitidos

    Conversa SEM departamento não bloqueia aqui.
    Se tiver departamento, precisa estar permitido.
    """
    if allowed_dep_ids is None:
        return

    if departamento_id is None:
        return

    if not allowed_dep_ids:
        raise HTTPException(
            status_code=403,
            detail="Sem departamentos permitidos para este colaborador",
        )

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

    # Colaborador admin/dono local passa.
    cargo = str(getattr(colab, "cargo", "") or "").strip().lower()
    if cargo == "admin":
        return True

    raw = getattr(colab, "instancias_ver", None)

    # Regra atual do seu sistema:
    # sem instancias_ver = sem acesso específico.
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
    """
    Modelo 2:
    - departamento_id None => permitido.
    - departamento preenchido => precisa existir em departamentos_membros.
    - departamento pai libera filhos.
    - fallback por setor_id antigo.
    """
    if departamento_id is None:
        return True

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

    cargo = str(getattr(colab, "cargo", "") or "").strip().lower()
    if cargo == "admin":
        return True

    allowed = _departamentos_permitidos_para_colaborador(
        db,
        colaborador_id=int(colaborador_id),
        empresa_id=int(empresa_id),
    )

    if not allowed:
        return False

    return int(departamento_id) in set(int(x) for x in allowed)


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