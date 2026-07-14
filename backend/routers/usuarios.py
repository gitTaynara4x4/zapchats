from __future__ import annotations

from typing import Optional, Tuple, Literal, Any

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Response, status
from pydantic import BaseModel
from sqlalchemy.orm import Session

import backend.models as models
from backend.database import get_db
from backend.routers.auth import get_current_identity

router = APIRouter(prefix="/usuarios", tags=["usuarios"])


# =========================
# Schemas
# =========================
class UsuarioOut(BaseModel):
    id: int
    empresa_id: int
    nome: Optional[str] = None
    email: Optional[str] = None
    cargo: Optional[str] = None
    departamento_id: Optional[int] = None
    is_admin: bool = False

    class Config:
        from_attributes = True


class UsuarioUpdateMe(BaseModel):
    nome: Optional[str] = None
    cargo: Optional[str] = None
    departamento_id: Optional[int] = None


# =========================
# Helpers
# =========================
MAX_AVATAR_BYTES = 2 * 1024 * 1024  # 2MB


def _identity_get(identity: Any, key: str, default=None):
    if isinstance(identity, dict):
        return identity.get(key, default)
    return getattr(identity, key, default)


def _identity_kind(identity: Any) -> str:
    kind = str(_identity_get(identity, "kind", "") or "").strip().lower()
    if kind in ("usuario", "colaborador"):
        return kind

    sub = str(_identity_get(identity, "sub", "") or "").strip().lower()
    if sub.startswith("colab-"):
        return "colaborador"

    return "usuario"


def _identity_id(identity: Any) -> Optional[int]:
    try:
        value = _identity_get(identity, "id")
        return int(value) if value is not None else None
    except Exception:
        return None


def _identity_empresa_id(identity: Any) -> Optional[int]:
    try:
        value = _identity_get(identity, "empresa_id")
        return int(value) if value is not None else None
    except Exception:
        return None


def _identity_is_admin(identity: Any) -> bool:
    try:
        return bool(_identity_get(identity, "is_admin", False))
    except Exception:
        return False


def _assert_mesma_empresa(empresa_id: int, identity: Any):
    emp_identity = _identity_empresa_id(identity)
    if emp_identity is None:
        raise HTTPException(status_code=403, detail="Empresa não identificada na sessão.")
    if int(empresa_id) != int(emp_identity):
        raise HTTPException(status_code=403, detail="Acesso negado (empresa)")


def _sync_avatar_with_linked_profile(
    db: Session,
    *,
    kind: str,
    actor: Any,
    data: bytes,
    mime: str,
) -> None:
    """Mantém Usuario e Colaborador com a mesma foto quando estão vinculados."""
    if kind == "usuario":
        linked = (
            db.query(models.Colaborador)
            .filter(
                models.Colaborador.usuario_id == int(actor.id),
                models.Colaborador.empresa_id == int(actor.empresa_id),
            )
            .first()
        )
    else:
        usuario_id = getattr(actor, "usuario_id", None)
        linked = (
            db.query(models.Usuario)
            .filter(
                models.Usuario.id == int(usuario_id),
                models.Usuario.empresa_id == int(actor.empresa_id),
            )
            .first()
            if usuario_id
            else None
        )

    if linked is None:
        return

    if hasattr(linked, "avatar_data"):
        linked.avatar_data = data
    if hasattr(linked, "avatar_mime"):
        linked.avatar_mime = mime
    db.add(linked)


async def _pick_upload(
    avatar: Optional[UploadFile],
    file: Optional[UploadFile],
    upload: Optional[UploadFile],
) -> UploadFile:
    up = avatar or file or upload
    if not up:
        raise HTTPException(
            status_code=422,
            detail="Envie um arquivo de imagem em 'file' (ou 'avatar'/'upload').",
        )
    return up


async def _read_and_validate_image(up: UploadFile) -> tuple[bytes, str]:
    data = await up.read()
    if not data:
        raise HTTPException(status_code=422, detail="Arquivo vazio.")
    if len(data) > MAX_AVATAR_BYTES:
        raise HTTPException(status_code=413, detail="Avatar muito grande (máx 2MB).")

    mime = (up.content_type or "").strip() or "application/octet-stream"
    if not mime.lower().startswith("image/"):
        raise HTTPException(status_code=415, detail="Arquivo precisa ser uma imagem (image/*).")

    return data, mime


def _no_store_headers() -> dict:
    return {
        "Cache-Control": "no-store, max-age=0",
        "Pragma": "no-cache",
    }


def _to_bytes_if_memoryview(value):
    if isinstance(value, memoryview):
        return value.tobytes()
    return value


def _load_me_actor(
    db: Session,
    identity: Any,
) -> Tuple[Literal["usuario", "colaborador"], Any]:
    kind = _identity_kind(identity)
    actor_id = _identity_id(identity)

    if not actor_id:
        raise HTTPException(status_code=401, detail="Sessão inválida.")

    if kind == "colaborador":
        colab = db.query(models.Colaborador).filter(models.Colaborador.id == int(actor_id)).first()
        if not colab:
            raise HTTPException(status_code=404, detail="Colaborador não encontrado")
        _assert_mesma_empresa(colab.empresa_id, identity)
        return "colaborador", colab

    user = db.query(models.Usuario).filter(models.Usuario.id == int(actor_id)).first()
    if not user:
        raise HTTPException(status_code=404, detail="Usuário não encontrado")
    _assert_mesma_empresa(user.empresa_id, identity)
    return "usuario", user


def _actor_departamento_id(kind: str, actor: Any) -> Optional[int]:
    if kind == "usuario":
        return getattr(actor, "departamento_id", None)

    # colaborador
    usuario_vinculado = getattr(actor, "usuario", None)
    if usuario_vinculado and getattr(usuario_vinculado, "departamento_id", None) is not None:
        return getattr(usuario_vinculado, "departamento_id", None)

    # fallback
    if hasattr(actor, "setor_id"):
        return getattr(actor, "setor_id", None)

    return None


def _actor_to_out(kind: str, actor: Any, identity: Any) -> UsuarioOut:
    return UsuarioOut(
        id=int(actor.id),
        empresa_id=int(actor.empresa_id),
        nome=getattr(actor, "nome", None),
        email=getattr(actor, "email", None),
        cargo=getattr(actor, "cargo", None),
        departamento_id=_actor_departamento_id(kind, actor),
        is_admin=_identity_is_admin(identity),
    )


# =========================
# Me
# =========================
@router.get("/me", response_model=UsuarioOut)
def obter_me(
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
):
    kind, actor = _load_me_actor(db, identity)
    return _actor_to_out(kind, actor, identity)


@router.patch("/me", response_model=UsuarioOut)
def atualizar_me(
    payload: UsuarioUpdateMe,
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
):
    kind, actor = _load_me_actor(db, identity)

    if payload.nome is not None:
        actor.nome = (payload.nome or "").strip() or None

    if payload.cargo is not None:
        actor.cargo = (payload.cargo or "").strip() or None

    if payload.departamento_id is not None:
        if kind == "usuario":
            actor.departamento_id = payload.departamento_id
        else:
            # colaborador: tenta refletir no usuário vinculado; fallback em setor_id
            usuario_vinculado = getattr(actor, "usuario", None)
            if usuario_vinculado is not None and hasattr(usuario_vinculado, "departamento_id"):
                usuario_vinculado.departamento_id = payload.departamento_id
                db.add(usuario_vinculado)
            elif hasattr(actor, "setor_id"):
                actor.setor_id = payload.departamento_id

    db.add(actor)
    db.commit()

    if kind == "usuario":
        db.refresh(actor)
    else:
        db.refresh(actor)
        try:
            if getattr(actor, "usuario", None) is not None:
                db.refresh(actor.usuario)
        except Exception:
            pass

    return _actor_to_out(kind, actor, identity)


# =========================
# Avatar do próprio logado
# =========================
@router.post("/me/avatar")
@router.put("/me/avatar")
async def upload_avatar_me(
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
    avatar: Optional[UploadFile] = File(None),
    file: Optional[UploadFile] = File(None),
    upload: Optional[UploadFile] = File(None),
):
    up = await _pick_upload(avatar, file, upload)
    data, mime = await _read_and_validate_image(up)

    kind, actor = _load_me_actor(db, identity)

    if not hasattr(actor, "avatar_data") or not hasattr(actor, "avatar_mime"):
        raise HTTPException(status_code=400, detail="Este perfil não suporta avatar.")

    actor.avatar_data = data
    actor.avatar_mime = mime
    db.add(actor)
    _sync_avatar_with_linked_profile(
        db,
        kind=kind,
        actor=actor,
        data=data,
        mime=mime,
    )
    db.commit()

    return {
        "ok": True,
        "msg": "Avatar gravado no banco",
        "avatar_url": "/api/usuarios/me/avatar",
        "kind": kind,
    }


@router.get(
    "/me/avatar",
    responses={200: {"content": {"image/*": {}}}},
)
def get_avatar_me(
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
):
    _kind, actor = _load_me_actor(db, identity)

    avatar_data = _to_bytes_if_memoryview(getattr(actor, "avatar_data", None))
    avatar_mime = getattr(actor, "avatar_mime", None) or "image/png"

    if not avatar_data:
        return Response(status_code=status.HTTP_204_NO_CONTENT, headers=_no_store_headers())

    return Response(content=avatar_data, media_type=avatar_mime, headers=_no_store_headers())


# =========================
# Avatar por ID (usuários admin)
# =========================
@router.post("/{usuario_id}/avatar")
@router.put("/{usuario_id}/avatar")
async def upload_avatar_by_id(
    usuario_id: int,
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
    avatar: Optional[UploadFile] = File(None),
    file: Optional[UploadFile] = File(None),
    upload: Optional[UploadFile] = File(None),
):
    identity_kind = _identity_kind(identity)
    identity_id = _identity_id(identity)
    is_admin = _identity_is_admin(identity)

    if not is_admin:
        if identity_kind != "usuario" or int(usuario_id) != int(identity_id or 0):
            raise HTTPException(status_code=403, detail="Sem permissão para alterar avatar de outro usuário.")

    u = db.query(models.Usuario).filter(models.Usuario.id == int(usuario_id)).first()
    if not u:
        raise HTTPException(status_code=404, detail="Usuário não encontrado")

    _assert_mesma_empresa(u.empresa_id, identity)

    up = await _pick_upload(avatar, file, upload)
    data, mime = await _read_and_validate_image(up)

    u.avatar_data = data
    u.avatar_mime = mime
    db.add(u)
    _sync_avatar_with_linked_profile(
        db,
        kind="usuario",
        actor=u,
        data=data,
        mime=mime,
    )
    db.commit()

    return {
        "ok": True,
        "msg": "Avatar gravado no banco",
        "avatar_url": f"/api/usuarios/{usuario_id}/avatar",
    }


@router.get(
    "/{usuario_id}/avatar",
    responses={200: {"content": {"image/*": {}}}},
)
def get_avatar_by_id(
    usuario_id: int,
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
):
    u = db.query(models.Usuario).filter(models.Usuario.id == int(usuario_id)).first()
    if not u:
        raise HTTPException(status_code=404, detail="Usuário não encontrado")

    _assert_mesma_empresa(u.empresa_id, identity)

    data = _to_bytes_if_memoryview(getattr(u, "avatar_data", None))
    mime = getattr(u, "avatar_mime", None) or "image/png"

    if not data:
        return Response(status_code=status.HTTP_204_NO_CONTENT, headers=_no_store_headers())

    return Response(content=data, media_type=mime, headers=_no_store_headers())