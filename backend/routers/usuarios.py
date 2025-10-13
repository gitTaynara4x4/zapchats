from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, UploadFile, File, HTTPException, Response, status
from pydantic import BaseModel, EmailStr
from sqlalchemy.orm import Session

from backend.database import get_db
from backend.models import Usuario, Departamento, Empresa
from backend.routers.auth import get_current_user  # garante usuário autenticado (admin, no seu wrapper)
from backend.routers.auth import hash_pwd          # mesmo hash usado no auth


router = APIRouter(prefix="/usuarios", tags=["Usuários"])


# =========================
# Schemas
# =========================
class UsuarioIn(BaseModel):
    empresa_id: int
    nome: str
    email: EmailStr
    senha: str
    cargo: Optional[str] = None
    # você pode mandar um dos dois:
    departamento_id: Optional[int] = None
    departamento: Optional[str] = None  # nome do departamento (vamos resolver para id)


# =========================
# Helpers
# =========================
def resolve_departamento_id(
    db: Session, empresa_id: int, departamento_id: Optional[int], departamento_nome: Optional[str]
) -> Optional[int]:
    if departamento_id:
        dep = db.query(Departamento).filter(
            Departamento.id == departamento_id,
            Departamento.empresa_id == empresa_id
        ).first()
        if not dep:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Departamento inválido para esta empresa")
        return dep.id
    if departamento_nome:
        dep = db.query(Departamento).filter(
            Departamento.nome == departamento_nome,
            Departamento.empresa_id == empresa_id
        ).first()
        if not dep:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Departamento não encontrado")
        return dep.id
    return None


# =========================
# Endpoints base
# =========================
@router.post("/", status_code=status.HTTP_201_CREATED)
def criar_usuario(
    u: UsuarioIn,
    db: Session = Depends(get_db),
    _admin: Usuario = Depends(get_current_user),  # garante auth/admin
):
    """Cria um novo usuário (apenas Admin via get_current_user)."""
    emp = db.query(Empresa).filter_by(id=u.empresa_id).first()
    if not emp:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Empresa inexistente")

    if db.query(Usuario).filter_by(email=u.email).first():
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "E-mail já cadastrado")

    dep_id = resolve_departamento_id(db, u.empresa_id, u.departamento_id, u.departamento)

    novo = Usuario(
        empresa_id=u.empresa_id,
        nome=u.nome.strip(),
        email=u.email,
        senha_hash=hash_pwd(u.senha),
        cargo=(u.cargo or None),
        is_admin=(u.cargo or "").lower() == "admin",
        departamento_id=dep_id
    )
    db.add(novo)
    db.commit()
    db.refresh(novo)
    return {"ok": True, "id": novo.id}


@router.get("/me", status_code=status.HTTP_200_OK)
def obter_me(current_user: Usuario = Depends(get_current_user)):
    """Retorna dados do usuário autenticado."""
    return {
        "id": current_user.id,
        "empresa_id": current_user.empresa_id,
        "nome": current_user.nome,
        "email": current_user.email,
        "cargo": current_user.cargo,
        "is_admin": current_user.is_admin,
    }


# =========================
# Avatar do usuário (upload + me + por ID)
# =========================
@router.post(
    "/me/avatar",
    status_code=status.HTTP_201_CREATED,
    summary="Faz upload do avatar do usuário autenticado (grava no DB)"
)
async def upload_avatar(
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    current_user: Usuario = Depends(get_current_user),
):
    """Armazena bytes da imagem no banco e seu MIME type (apenas Admin, via wrapper)."""
    if not file.content_type or not file.content_type.startswith("image/"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Envie um arquivo de imagem")

    data = await file.read()
    MAX_BYTES = 2 * 1024 * 1024  # 2MB
    if len(data) > MAX_BYTES:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "Imagem muito grande (máx 2MB)")

    current_user.avatar_data = data
    current_user.avatar_mime = file.content_type
    db.add(current_user)
    db.commit()
    return {"msg": "Avatar gravado no banco"}


@router.get(
    "/me/avatar",
    summary="Retorna o avatar do usuário autenticado",
    responses={200: {"content": {"image/*": {}}}}
)
def get_avatar_me(current_user: Usuario = Depends(get_current_user)):
    """Retorna a imagem do avatar do usuário (apenas Admin)."""
    if not current_user.avatar_data:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Sem avatar")
    data = current_user.avatar_data.tobytes() if isinstance(current_user.avatar_data, memoryview) else current_user.avatar_data
    return Response(content=data, media_type=current_user.avatar_mime or "application/octet-stream")


@router.get(
    "/{usuario_id}/avatar",
    summary="Retorna o avatar de um usuário por ID",
    responses={200: {"content": {"image/*": {}}}}
)
def get_usuario_avatar_by_id(
    usuario_id: int,
    db: Session = Depends(get_db),
    _me: Usuario = Depends(get_current_user),  # garante auth
):
    u = db.query(Usuario).filter(Usuario.id == usuario_id).first()
    if not u:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Usuário não encontrado")

    if not u.avatar_data:
        # Sem avatar salvo → 204; front usa monograma
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    data = u.avatar_data.tobytes() if isinstance(u.avatar_data, memoryview) else u.avatar_data
    mime = u.avatar_mime or "image/png"
    return Response(content=data, media_type=mime)
