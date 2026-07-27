from __future__ import annotations

import base64
import html
import re
from datetime import datetime
from typing import Optional, Tuple

from fastapi import APIRouter, Depends, File, HTTPException, Response, UploadFile
from passlib.context import CryptContext
from pydantic import BaseModel, EmailStr
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from backend import models
from backend.database import get_db
from backend.routers.auth import get_current_identity
from backend.services.zapschat_presence import get_colaborador_presence

router = APIRouter(prefix="/api/perfil", tags=["Perfil"])

pwd_context = CryptContext(schemes=["pbkdf2_sha256"], deprecated="auto")

ALLOWED_IMAGE_MIMES = {
    "image/jpeg",
    "image/jpg",
    "image/png",
    "image/webp",
    "image/gif",
}
MAX_AVATAR_BYTES = 4 * 1024 * 1024


class PerfilOut(BaseModel):
    id: int
    tipo: str
    nome: str
    email: Optional[EmailStr] = None
    telefone: Optional[str] = None
    cargo: Optional[str] = None
    avatar_url: Optional[str] = None

    empresa_id: Optional[int] = None
    empresa_nome: Optional[str] = None
    colaborador_id: Optional[int] = None
    is_admin: bool = False
    account_label: str = "Colaborador"

    departamento: Optional[str] = None
    setor: Optional[str] = None
    horario_modo: Optional[str] = None
    hora_login_inicio: Optional[str] = None
    hora_login_fim: Optional[str] = None
    permissoes_count: int = 0

    last_access_at: Optional[datetime] = None
    presence_status: str = "offline"
    presence_updated_at: Optional[str] = None
    presence_activity_at: Optional[str] = None
    presence_session_count: int = 0

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
    if actor is None:
        return None

    avatar_data = getattr(actor, "avatar_data", None)
    avatar_mime = _clean_str(getattr(actor, "avatar_mime", None))

    if not avatar_data or not isinstance(avatar_data, (bytes, bytearray)):
        return None

    raw = bytes(avatar_data)
    if not avatar_mime or not avatar_mime.startswith("image/"):
        avatar_mime = _detect_image_mime(raw)
    if not avatar_mime or avatar_mime not in ALLOWED_IMAGE_MIMES:
        return None

    b64 = base64.b64encode(raw).decode("ascii")
    return f"data:{avatar_mime};base64,{b64}"


def _avatar_svg_fallback(actor) -> str:
    nome = (
        _clean_str(getattr(actor, "nome", None))
        or _clean_str(getattr(actor, "email", None))
        or "Usuário"
    )
    parts = [p for p in str(nome).replace("@", " ").replace(".", " ").split() if p]
    if len(parts) >= 2:
        initials = (parts[0][0] + parts[1][0]).upper()
    elif parts:
        initials = parts[0][:2].upper()
    else:
        initials = "US"

    initials = html.escape(initials[:2])
    label = html.escape(str(nome))
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 160 160" role="img" aria-label="{label}">
  <rect width="160" height="160" rx="80" fill="#16a34a"/>
  <text x="50%" y="54%" dominant-baseline="middle" text-anchor="middle"
        font-family="Arial, Helvetica, sans-serif" font-size="58" font-weight="700"
        fill="#ffffff">{initials}</text>
</svg>'''


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
    return raw_password == stored_password


def _hash_password(new_password: str) -> str:
    return pwd_context.hash(new_password)


def _get_actor(identity, db: Session) -> Tuple[str, object]:
    if not identity:
        raise HTTPException(status_code=401, detail="Não autenticado.")

    kind = identity.get("kind")
    actor_id = identity.get("id")
    try:
        actor_id = int(actor_id)
    except (TypeError, ValueError):
        raise HTTPException(status_code=401, detail="Sessão inválida.")

    if kind == "usuario":
        actor = db.get(models.Usuario, actor_id)
    elif kind == "colaborador":
        actor = db.get(models.Colaborador, actor_id)
    else:
        actor = None

    if not actor:
        raise HTTPException(status_code=404, detail="Usuário não encontrado.")
    return kind, actor


def _linked_colaborador(kind: str, actor, identity, db: Session):
    if kind == "colaborador":
        return actor

    linked = getattr(actor, "colaborador", None)
    if linked is not None:
        return linked

    raw_id = (
        identity.get("colaborador_id")
        or identity.get("id_colab")
        or identity.get("id_colaborador")
        or identity.get("colab_id")
        or identity.get("cid")
    )
    try:
        cid = int(raw_id)
    except (TypeError, ValueError):
        cid = 0

    if cid > 0:
        return (
            db.query(models.Colaborador)
            .filter(
                models.Colaborador.id == cid,
                models.Colaborador.empresa_id == int(identity.get("empresa_id") or 0),
            )
            .first()
        )
    return None


def _email_em_uso(
    db: Session,
    email: str,
    *,
    usuario_ids_ignorar: set[int],
    colaborador_ids_ignorar: set[int],
) -> bool:
    email = email.strip().lower()

    q_usuario = db.query(models.Usuario).filter(models.Usuario.email == email)
    if usuario_ids_ignorar:
        q_usuario = q_usuario.filter(~models.Usuario.id.in_(usuario_ids_ignorar))
    if q_usuario.first():
        return True

    q_colab = db.query(models.Colaborador).filter(models.Colaborador.email == email)
    if colaborador_ids_ignorar:
        q_colab = q_colab.filter(~models.Colaborador.id.in_(colaborador_ids_ignorar))
    return q_colab.first() is not None


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


def _perfil_payload(kind: str, actor, identity, db: Session) -> dict:
    linked = _linked_colaborador(kind, actor, identity, db)
    empresa_id = int(identity.get("empresa_id") or getattr(actor, "empresa_id", 0) or 0)
    empresa = db.get(models.Empresa, empresa_id) if empresa_id > 0 else None

    presence = {
        "presence_status": "offline",
        "presence_updated_at": None,
        "presence_activity_at": None,
        "presence_session_count": 0,
    }
    if linked is not None and empresa_id > 0:
        try:
            presence = get_colaborador_presence(empresa_id, int(linked.id))
        except Exception:
            pass

    departamento = None
    setor = None
    if kind == "usuario":
        departamento = _clean_str(getattr(getattr(actor, "departamento", None), "nome", None))
    if linked is not None:
        setor = _clean_str(getattr(getattr(linked, "setor", None), "nome", None))

    telefone = _clean_str(getattr(actor, "telefone", None))
    if not telefone and linked is not None:
        telefone = _clean_str(getattr(linked, "telefone", None))

    cargo = _clean_str(getattr(actor, "cargo", None))
    if not cargo and linked is not None:
        cargo = _clean_str(getattr(linked, "cargo", None))

    has_avatar = bool(getattr(actor, "avatar_data", None)) or bool(getattr(linked, "avatar_data", None))
    avatar_url = "/api/perfil/avatar" if has_avatar else None
    is_admin = bool(identity.get("is_admin"))

    return {
        "id": int(actor.id),
        "tipo": kind,
        "nome": _clean_str(getattr(actor, "nome", None)) or "",
        "email": _clean_str(getattr(actor, "email", None)),
        "telefone": telefone,
        "cargo": cargo,
        "avatar_url": avatar_url,
        "empresa_id": empresa_id or None,
        "empresa_nome": _clean_str(getattr(empresa, "nome", None)),
        "colaborador_id": int(linked.id) if linked is not None else None,
        "is_admin": is_admin,
        "account_label": "Administrador" if is_admin else "Colaborador",
        "departamento": departamento,
        "setor": setor,
        "horario_modo": _clean_str(getattr(linked, "horario_modo", None)) if linked else None,
        "hora_login_inicio": _clean_str(getattr(linked, "hora_login_inicio", None)) if linked else None,
        "hora_login_fim": _clean_str(getattr(linked, "hora_login_fim", None)) if linked else None,
        "permissoes_count": len(identity.get("permissoes") or []),
        "last_access_at": getattr(linked, "last_access_at", None) if linked else None,
        "presence_status": str(presence.get("presence_status") or "offline"),
        "presence_updated_at": presence.get("presence_updated_at"),
        "presence_activity_at": presence.get("presence_activity_at"),
        "presence_session_count": int(presence.get("presence_session_count") or 0),
    }


def _sync_avatar(target, source) -> None:
    if target is None or source is None or target is source:
        return
    if hasattr(target, "avatar_data") and hasattr(target, "avatar_mime"):
        target.avatar_data = getattr(source, "avatar_data", None)
        target.avatar_mime = getattr(source, "avatar_mime", None)


@router.get("", response_model=PerfilOut)
def obter_meu_perfil(
    identity=Depends(get_current_identity),
    db: Session = Depends(get_db),
):
    kind, actor = _get_actor(identity, db)
    return _perfil_payload(kind, actor, identity, db)


@router.put("", response_model=PerfilOut)
def atualizar_meu_perfil(
    payload: PerfilUpdate,
    identity=Depends(get_current_identity),
    db: Session = Depends(get_db),
):
    kind, actor = _get_actor(identity, db)
    linked = _linked_colaborador(kind, actor, identity, db)

    nome_limpo = (payload.nome or "").strip()
    email_limpo = str(payload.email or "").strip().lower()
    telefone_limpo = _clean_str(payload.telefone)
    cargo_limpo = _clean_str(payload.cargo)

    if len(nome_limpo) < 2:
        raise HTTPException(status_code=400, detail="Informe um nome válido.")
    if not email_limpo:
        raise HTTPException(status_code=400, detail="O e-mail é obrigatório.")

    usuario_ids_ignorar: set[int] = set()
    colaborador_ids_ignorar: set[int] = set()
    if kind == "usuario":
        usuario_ids_ignorar.add(int(actor.id))
    else:
        colaborador_ids_ignorar.add(int(actor.id))

    if linked is not None:
        colaborador_ids_ignorar.add(int(linked.id))
        linked_user_id = getattr(linked, "usuario_id", None)
        if linked_user_id:
            usuario_ids_ignorar.add(int(linked_user_id))

    email_atual = (_clean_str(getattr(actor, "email", None)) or "").lower()
    if email_limpo != email_atual and _email_em_uso(
        db,
        email_limpo,
        usuario_ids_ignorar=usuario_ids_ignorar,
        colaborador_ids_ignorar=colaborador_ids_ignorar,
    ):
        raise HTTPException(status_code=409, detail="Este e-mail já está em uso por outra conta.")

    actor.nome = nome_limpo
    actor.email = email_limpo
    if hasattr(actor, "telefone"):
        actor.telefone = telefone_limpo
    if hasattr(actor, "cargo"):
        actor.cargo = cargo_limpo

    # O administrador também possui um colaborador operacional usado em presença,
    # chat interno e atribuição de atendimentos. Mantemos os dois perfis sincronizados.
    if linked is not None and linked is not actor:
        linked.nome = nome_limpo
        linked.email = email_limpo
        linked.telefone = telefone_limpo
        linked.cargo = cargo_limpo

    try:
        db.commit()
        db.refresh(actor)
        if linked is not None and linked is not actor:
            db.refresh(linked)
        return _perfil_payload(kind, actor, identity, db)
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail="Nome ou e-mail já utilizado por outra conta.")
    except HTTPException:
        db.rollback()
        raise
    except Exception:
        db.rollback()
        raise HTTPException(status_code=400, detail="Erro ao atualizar o perfil.")


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
        raise HTTPException(status_code=400, detail="Senha atual não encontrada para esta conta.")
    if not _verify_password(senha_atual, senha_salva):
        raise HTTPException(status_code=401, detail="Senha atual incorreta.")
    if len(nova_senha) < 8:
        raise HTTPException(status_code=400, detail="A nova senha deve ter no mínimo 8 caracteres.")
    if not re.search(r"[A-Za-zÀ-ÿ]", nova_senha) or not re.search(r"\d", nova_senha):
        raise HTTPException(status_code=400, detail="Use pelo menos uma letra e um número na nova senha.")
    if nova_senha != confirma_senha:
        raise HTTPException(status_code=400, detail="As novas senhas não conferem.")
    if _verify_password(nova_senha, senha_salva):
        raise HTTPException(status_code=400, detail="A nova senha deve ser diferente da senha atual.")

    _set_new_password(actor, _hash_password(nova_senha))
    try:
        db.commit()
    except Exception:
        db.rollback()
        raise HTTPException(status_code=400, detail="Erro ao atualizar a senha.")

    return {"ok": True, "mensagem": "Senha atualizada com sucesso."}


@router.get("/avatar")
def obter_avatar(
    identity=Depends(get_current_identity),
    db: Session = Depends(get_db),
):
    kind, actor = _get_actor(identity, db)
    linked = _linked_colaborador(kind, actor, identity, db)
    source = actor if getattr(actor, "avatar_data", None) else linked or actor

    avatar_data = getattr(source, "avatar_data", None)
    avatar_mime = _clean_str(getattr(source, "avatar_mime", None))

    if avatar_data and isinstance(avatar_data, (bytes, bytearray)):
        raw = bytes(avatar_data)
        if not avatar_mime or not avatar_mime.startswith("image/"):
            avatar_mime = _detect_image_mime(raw)
        if avatar_mime in ALLOWED_IMAGE_MIMES:
            return Response(
                content=raw,
                media_type=avatar_mime,
                headers={
                    "Cache-Control": "private, no-store, max-age=0",
                    "X-Content-Type-Options": "nosniff",
                },
            )

    svg = _avatar_svg_fallback(actor)
    return Response(
        content=svg.encode("utf-8"),
        media_type="image/svg+xml",
        headers={
            "Cache-Control": "private, no-store, max-age=0",
            "X-Content-Type-Options": "nosniff",
        },
    )


@router.post("/avatar")
async def upload_avatar(
    file: UploadFile = File(...),
    identity=Depends(get_current_identity),
    db: Session = Depends(get_db),
):
    kind, actor = _get_actor(identity, db)
    linked = _linked_colaborador(kind, actor, identity, db)

    if not file or not file.filename:
        raise HTTPException(status_code=400, detail="Nenhum arquivo enviado.")

    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="Arquivo vazio.")
    if len(raw) > MAX_AVATAR_BYTES:
        raise HTTPException(status_code=400, detail="A imagem deve ter no máximo 4 MB.")

    content_type = _clean_str(file.content_type)
    detected_mime = _detect_image_mime(raw)
    final_mime = content_type if content_type in ALLOWED_IMAGE_MIMES else detected_mime
    if not final_mime or final_mime not in ALLOWED_IMAGE_MIMES:
        raise HTTPException(status_code=400, detail="Formato inválido. Use JPG, PNG, WEBP ou GIF.")

    if not hasattr(actor, "avatar_data") or not hasattr(actor, "avatar_mime"):
        raise HTTPException(status_code=500, detail="Esta conta não suporta foto de perfil.")

    actor.avatar_data = raw
    actor.avatar_mime = final_mime
    _sync_avatar(linked, actor)

    try:
        db.commit()
        db.refresh(actor)
    except Exception:
        db.rollback()
        raise HTTPException(status_code=400, detail="Erro ao atualizar a foto.")

    return {"ok": True, "avatar_url": "/api/perfil/avatar"}


@router.delete("/avatar")
def remover_avatar(
    identity=Depends(get_current_identity),
    db: Session = Depends(get_db),
):
    kind, actor = _get_actor(identity, db)
    linked = _linked_colaborador(kind, actor, identity, db)

    if not hasattr(actor, "avatar_data") or not hasattr(actor, "avatar_mime"):
        raise HTTPException(status_code=500, detail="Esta conta não suporta foto de perfil.")

    actor.avatar_data = None
    actor.avatar_mime = None
    _sync_avatar(linked, actor)

    try:
        db.commit()
        db.refresh(actor)
    except Exception:
        db.rollback()
        raise HTTPException(status_code=400, detail="Erro ao remover a foto.")

    return {"ok": True, "mensagem": "Foto removida com sucesso.", "avatar_url": None}
