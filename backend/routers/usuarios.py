from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Response, status
from pydantic import BaseModel
from sqlalchemy.orm import Session

import backend.models as models
from backend.database import get_db
from backend.routers.auth import get_current_user

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


def _assert_mesma_empresa(empresa_id: int, me: models.Usuario):
    if int(empresa_id) != int(me.empresa_id):
        raise HTTPException(status_code=403, detail="Acesso negado (empresa)")


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


# =========================
# Me
# =========================
@router.get("/me", response_model=UsuarioOut)
def obter_me(me=Depends(get_current_user)):
    return me


@router.patch("/me", response_model=UsuarioOut)
def atualizar_me(
    payload: UsuarioUpdateMe,
    db: Session = Depends(get_db),
    me=Depends(get_current_user),
):
    u = db.query(models.Usuario).get(me.id)
    if not u:
        raise HTTPException(status_code=404, detail="Usuário não encontrado")

    _assert_mesma_empresa(u.empresa_id, me)

    if payload.nome is not None:
        u.nome = (payload.nome or "").strip() or None
    if payload.cargo is not None:
        u.cargo = (payload.cargo or "").strip() or None
    if payload.departamento_id is not None:
        u.departamento_id = payload.departamento_id

    db.add(u)
    db.commit()
    db.refresh(u)
    return u


# aceita POST e PUT
@router.post("/me/avatar")
@router.put("/me/avatar")
async def upload_avatar_me(
    db: Session = Depends(get_db),
    me=Depends(get_current_user),
    avatar: Optional[UploadFile] = File(None),
    file: Optional[UploadFile] = File(None),
    upload: Optional[UploadFile] = File(None),
):
    up = await _pick_upload(avatar, file, upload)
    data, mime = await _read_and_validate_image(up)

    u = db.query(models.Usuario).get(me.id)
    if not u:
        raise HTTPException(status_code=404, detail="Usuário não encontrado")

    _assert_mesma_empresa(u.empresa_id, me)

    u.avatar_data = data
    u.avatar_mime = mime
    db.add(u)
    db.commit()

    return {
        "ok": True,
        "msg": "Avatar gravado no banco",
        "avatar_url": "/api/usuarios/me/avatar",
    }


@router.get(
    "/me/avatar",
    responses={200: {"content": {"image/*": {}}}},
)
def get_avatar_me(
    db: Session = Depends(get_db),
    me=Depends(get_current_user),
):
    u = db.query(models.Usuario).get(me.id)
    if not u:
        raise HTTPException(status_code=404, detail="Usuário não encontrado")

    _assert_mesma_empresa(u.empresa_id, me)

    if not u.avatar_data:
        return Response(status_code=status.HTTP_204_NO_CONTENT, headers=_no_store_headers())

    data = u.avatar_data.tobytes() if isinstance(u.avatar_data, memoryview) else u.avatar_data
    mime = u.avatar_mime or "image/png"
    return Response(content=data, media_type=mime, headers=_no_store_headers())


# =========================
# Avatar por ID
# =========================
@router.post("/{usuario_id}/avatar")
@router.put("/{usuario_id}/avatar")
async def upload_avatar_by_id(
    usuario_id: int,
    db: Session = Depends(get_db),
    me=Depends(get_current_user),
    avatar: Optional[UploadFile] = File(None),
    file: Optional[UploadFile] = File(None),
    upload: Optional[UploadFile] = File(None),
):
    if not getattr(me, "is_admin", False) and int(usuario_id) != int(me.id):
        raise HTTPException(status_code=403, detail="Sem permissão para alterar avatar de outro usuário.")

    u = db.query(models.Usuario).get(usuario_id)
    if not u:
        raise HTTPException(status_code=404, detail="Usuário não encontrado")

    _assert_mesma_empresa(u.empresa_id, me)

    up = await _pick_upload(avatar, file, upload)
    data, mime = await _read_and_validate_image(up)

    u.avatar_data = data
    u.avatar_mime = mime
    db.add(u)
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
    me=Depends(get_current_user),
):
    u = db.query(models.Usuario).get(usuario_id)
    if not u:
        raise HTTPException(status_code=404, detail="Usuário não encontrado")

    _assert_mesma_empresa(u.empresa_id, me)

    if not u.avatar_data:
        return Response(status_code=status.HTTP_204_NO_CONTENT, headers=_no_store_headers())

    data = u.avatar_data.tobytes() if isinstance(u.avatar_data, memoryview) else u.avatar_data
    mime = u.avatar_mime or "image/png"
    return Response(content=data, media_type=mime, headers=_no_store_headers())