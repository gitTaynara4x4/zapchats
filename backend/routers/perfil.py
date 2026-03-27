from __future__ import annotations

import base64
from typing import Optional, Tuple

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from pydantic import BaseModel, EmailStr
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from passlib.context import CryptContext

from backend.database import get_db
from backend.routers.auth import get_current_identity
from backend import models

router = APIRouter(prefix="/api/perfil", tags=["Perfil"])

pwd_context = CryptContext(schemes=["pbkdf2_sha256"], deprecated="auto")

ALLOWED_IMAGE_MIMES = {
    "image/jpeg",
    "image/jpg",
    "image/png",
    "image/webp",
    "image/gif",
}
MAX_AVATAR_BYTES = 4 * 1024 * 1024  # 4 MB


class PerfilOut(BaseModel):
    id: int
    tipo: str
    nome: str
    email: Optional[EmailStr] = None
    telefone: Optional[str] = None
    cargo: Optional[str] = None
    avatar_url: Optional[str] = None

    class Config:
        from_attributes = True
        orm_mode = True


class PerfilUpdate(BaseModel):
    nome: str
    email: EmailStr
    telefone: Optional[str] = None
    cargo: Optional[str] = None


class SenhaUpdate(BaseModel):
    senha_atual: str
    nova_senha: str
    confirma_senha: str


def _clean_str(value) -> Optional[str]:
    if value is None:
        return None
    value = str(value).strip()
    return value or None


def _detect_image_mime(data: bytes) -> Optional[str]:
    if not data:
        return None

    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    if data.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"

    return None


def _avatar_to_data_url(actor) -> Optional[str]:
    avatar_data = getattr(actor, "avatar_data", None)
    avatar_mime = _clean_str(getattr(actor, "avatar_mime", None))

    if not avatar_data:
        return None

    if not isinstance(avatar_data, (bytes, bytearray)):
        return None

    if not avatar_mime or not avatar_mime.startswith("image/"):
        avatar_mime = _detect_image_mime(bytes(avatar_data))

    if not avatar_mime or avatar_mime not in ALLOWED_IMAGE_MIMES:
        return None

    b64 = base64.b64encode(bytes(avatar_data)).decode("ascii")
    return f"data:{avatar_mime};base64,{b64}"


def _verify_password(raw_password: str, stored_password: Optional[str]) -> bool:
    stored_password = _clean_str(stored_password)
    if not stored_password:
        return False

    try:
        identified = pwd_context.identify(stored_password)
        if identified:
            return pwd_context.verify(raw_password, stored_password)
    except Exception:
        pass

    # fallback legado/dev
    return raw_password == stored_password


def _hash_password(new_password: str) -> str:
    return pwd_context.hash(new_password)


def _get_actor(identity, db: Session) -> Tuple[str, object]:
    if not identity:
        raise HTTPException(status_code=401, detail="Não autenticado.")

    kind = identity.get("kind")
    actor_id = identity.get("id")

    if not actor_id:
        raise HTTPException(status_code=401, detail="Não autenticado.")

    try:
        actor_id = int(actor_id)
    except (TypeError, ValueError):
        raise HTTPException(status_code=401, detail="Sessão inválida.")

    if kind == "usuario":
        actor = db.get(models.Usuario, actor_id)
        if not actor:
            raise HTTPException(status_code=404, detail="Usuário não encontrado.")
        return kind, actor

    if kind == "colaborador":
        actor = db.get(models.Colaborador, actor_id)
        if not actor:
            raise HTTPException(status_code=404, detail="Colaborador não encontrado.")
        return kind, actor

    raise HTTPException(status_code=401, detail="Não autenticado.")


def _perfil_payload(kind: str, actor) -> dict:
    return {
        "id": actor.id,
        "tipo": kind,
        "nome": _clean_str(getattr(actor, "nome", None)) or "",
        "email": _clean_str(getattr(actor, "email", None)),
        "telefone": _clean_str(getattr(actor, "telefone", None)) if hasattr(actor, "telefone") else None,
        "cargo": _clean_str(getattr(actor, "cargo", None)) if hasattr(actor, "cargo") else None,
        "avatar_url": _avatar_to_data_url(actor),
    }


def _email_em_uso(db: Session, email: str, kind: str, actor_id: int) -> bool:
    email = email.strip().lower()

    q_usuario = db.query(models.Usuario).filter(models.Usuario.email == email)
    if kind == "usuario":
        q_usuario = q_usuario.filter(models.Usuario.id != actor_id)
    if q_usuario.first():
        return True

    q_colab = db.query(models.Colaborador).filter(models.Colaborador.email == email)
    if kind == "colaborador":
        q_colab = q_colab.filter(models.Colaborador.id != actor_id)
    if q_colab.first():
        return True

    return False


def _get_stored_password(actor) -> Optional[str]:
    if hasattr(actor, "senha_hash"):
        return _clean_str(actor.senha_hash)
    if hasattr(actor, "senha"):
        return _clean_str(actor.senha)
    return None


def _set_new_password(actor, new_hash: str) -> None:
    if hasattr(actor, "senha_hash"):
        actor.senha_hash = new_hash
        return

    if hasattr(actor, "senha"):
        actor.senha = new_hash
        return

    raise HTTPException(status_code=500, detail="Campo de senha não encontrado no modelo.")


@router.get("", response_model=PerfilOut)
def obter_meu_perfil(
    identity=Depends(get_current_identity),
    db: Session = Depends(get_db),
):
    kind, actor = _get_actor(identity, db)
    return _perfil_payload(kind, actor)


@router.put("", response_model=PerfilOut)
def atualizar_meu_perfil(
    payload: PerfilUpdate,
    identity=Depends(get_current_identity),
    db: Session = Depends(get_db),
):
    kind, actor = _get_actor(identity, db)

    nome_limpo = (payload.nome or "").strip()
    email_limpo = str(payload.email or "").strip().lower()

    if not nome_limpo:
        raise HTTPException(status_code=400, detail="O nome é obrigatório.")

    if not email_limpo:
        raise HTTPException(status_code=400, detail="O e-mail é obrigatório.")

    email_atual = (_clean_str(getattr(actor, "email", None)) or "").lower()
    if email_limpo != email_atual and _email_em_uso(db, email_limpo, kind, actor.id):
        raise HTTPException(status_code=409, detail="Este e-mail já está em uso por outro usuário.")

    actor.nome = nome_limpo
    actor.email = email_limpo

    if hasattr(actor, "telefone"):
        actor.telefone = _clean_str(payload.telefone)

    if hasattr(actor, "cargo"):
        actor.cargo = _clean_str(payload.cargo)

    try:
        db.commit()
        db.refresh(actor)
        return _perfil_payload(kind, actor)
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=400, detail="Erro ao salvar os dados.")
    except Exception:
        db.rollback()
        raise HTTPException(status_code=400, detail="Erro ao atualizar perfil.")


@router.put("/senha")
def atualizar_minha_senha(
    payload: SenhaUpdate,
    identity=Depends(get_current_identity),
    db: Session = Depends(get_db),
):
    _, actor = _get_actor(identity, db)

    senha_atual = payload.senha_atual or ""
    nova_senha = payload.nova_senha or ""
    confirma_senha = payload.confirma_senha or ""

    senha_salva = _get_stored_password(actor)
    if not senha_salva:
        raise HTTPException(status_code=400, detail="Senha atual não encontrada para este usuário.")

    if not _verify_password(senha_atual, senha_salva):
        raise HTTPException(status_code=401, detail="Senha atual incorreta.")

    if len(nova_senha) < 6:
        raise HTTPException(status_code=400, detail="A nova senha deve ter no mínimo 6 caracteres.")

    if nova_senha != confirma_senha:
        raise HTTPException(status_code=400, detail="As novas senhas não conferem.")

    _set_new_password(actor, _hash_password(nova_senha))

    try:
        db.commit()
    except Exception:
        db.rollback()
        raise HTTPException(status_code=400, detail="Erro ao atualizar a senha.")

    return {"ok": True, "mensagem": "Senha atualizada com sucesso."}


@router.post("/avatar")
async def upload_avatar(
    file: UploadFile = File(...),
    identity=Depends(get_current_identity),
    db: Session = Depends(get_db),
):
    _, actor = _get_actor(identity, db)

    if not file or not file.filename:
        raise HTTPException(status_code=400, detail="Nenhum arquivo enviado.")

    content_type = _clean_str(file.content_type)
    raw = await file.read()

    if not raw:
        raise HTTPException(status_code=400, detail="Arquivo vazio.")

    if len(raw) > MAX_AVATAR_BYTES:
        raise HTTPException(status_code=400, detail="A imagem deve ter no máximo 4 MB.")

    detected_mime = _detect_image_mime(raw)
    final_mime = content_type if content_type in ALLOWED_IMAGE_MIMES else detected_mime

    if not final_mime or final_mime not in ALLOWED_IMAGE_MIMES:
        raise HTTPException(
            status_code=400,
            detail="Formato de imagem inválido. Use JPG, PNG, WEBP ou GIF."
        )

    if not hasattr(actor, "avatar_data") or not hasattr(actor, "avatar_mime"):
        raise HTTPException(
            status_code=500,
            detail="Os campos avatar_data/avatar_mime não existem no modelo."
        )

    actor.avatar_data = raw
    actor.avatar_mime = final_mime

    try:
        db.commit()
        db.refresh(actor)
    except Exception:
        db.rollback()
        raise HTTPException(status_code=400, detail="Erro ao atualizar avatar.")

    return {
        "ok": True,
        "avatar_url": _avatar_to_data_url(actor),
    }


@router.delete("/avatar")
def remover_avatar(
    identity=Depends(get_current_identity),
    db: Session = Depends(get_db),
):
    _, actor = _get_actor(identity, db)

    if not hasattr(actor, "avatar_data") or not hasattr(actor, "avatar_mime"):
        raise HTTPException(
            status_code=500,
            detail="Os campos avatar_data/avatar_mime não existem no modelo."
        )

    actor.avatar_data = None
    actor.avatar_mime = None

    try:
        db.commit()
        db.refresh(actor)
    except Exception:
        db.rollback()
        raise HTTPException(status_code=400, detail="Erro ao remover avatar.")

    return {
        "ok": True,
        "mensagem": "Avatar removido com sucesso.",
        "avatar_url": None,
    }