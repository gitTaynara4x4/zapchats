# backend/routers/colaboradores.py
from __future__ import annotations

from typing import Optional, List
import re, json
from urllib.parse import quote

from fastapi import (
    APIRouter,
    Depends,
    HTTPException,
    status,
    Form,
    UploadFile,
    File,
    Body,
    Request,
    Response,
)
from pydantic import BaseModel, EmailStr, ConfigDict
from sqlalchemy import or_, func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, joinedload

from backend.database import get_db
from backend import models
from backend.routers.auth import get_current_user
from backend.security.passwords import hash_pwd  # verify_pwd não é necessário aqui

# este router costuma ser montado com prefixo "/api" no main.py
router = APIRouter(prefix="/colaboradores", tags=["Colaboradores"])


# ==========================
# Utilidades / Helpers
# ==========================
def _assert_mesma_empresa(a: int, b: int) -> None:
    if a != b:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Empresa inválida para este recurso")


def normalize_phone_e164_br(raw: Optional[str]) -> Optional[str]:
    if not raw:
        return None
    d = re.sub(r"\D+", "", str(raw))
    if not d:
        return None
    # aceita números BR com/sem 55 e aplica +55
    if d.startswith("55"):
        return "+" + d
    if len(d) in (10, 11):
        return "+55" + d
    return "+" + d


def build_avatar_url(nome: Optional[str], email: Optional[str]) -> str:
    seed = (nome or email or "Colaborador").strip() or "Colaborador"
    return f"https://api.dicebear.com/7.x/initials/svg?seed={quote(seed)}&radius=12&scale=100"


def _resolve_setor_or_departamento(db: Session, empresa_id: int, maybe_id: Optional[int]) -> Optional[models.Setor]:
    """
    Aceita um ID que pode ser de Setor OU de Departamento.
    - Se for Setor da mesma empresa: retorna.
    - Se for Departamento da mesma empresa: tenta reaproveitar Setor com mesmo nome; se não existir, cria e retorna.
    """
    if not maybe_id:
        return None
    # 1) tenta Setor
    s = db.query(models.Setor).filter_by(id=maybe_id, empresa_id=empresa_id).first()
    if s:
        return s
    # 2) tenta Departamento
    dep = (
        db.query(models.Departamento)
        .filter(models.Departamento.id == maybe_id, models.Departamento.empresa_id == empresa_id)
        .first()
    )
    if not dep:
        return None
    # 3) setor com mesmo nome?
    s = (
        db.query(models.Setor)
        .filter(models.Setor.empresa_id == empresa_id, models.Setor.nome == dep.nome)
        .first()
    )
    if s:
        return s
    # 4) cria Setor espelho
    s = models.Setor(empresa_id=empresa_id, nome=dep.nome)
    db.add(s)
    db.flush()
    return s


def _parse_perms(value: Optional[str | list]) -> list[str]:
    if not value:
        return []
    if isinstance(value, list):
        return [str(x) for x in value]
    s = str(value).strip()
    if not s:
        return []
    try:
        data = json.loads(s)
        if isinstance(data, list):
            return [str(x) for x in data]
    except Exception:
        pass
    # fallback: separado por vírgula/whitespace
    return [p for p in re.split(r"[\s,;]+", s) if p]


def _truthy(v) -> bool:
    if isinstance(v, bool):
        return v
    return str(v).strip().lower() in ("1", "true", "on", "yes", "y")


# ==========================
# Pydantic Schemas
# ==========================
class ColaboradorOut(BaseModel):
    id: int
    empresa_id: int
    setor_id: Optional[int]
    usuario_id: Optional[int]
    nome: str
    email: EmailStr
    telefone: Optional[str]
    cargo: Optional[str]
    # extras
    setor_nome: Optional[str] = None
    tem_usuario: bool = False
    avatar_url: Optional[str] = None
    is_admin: bool = False  # campo adicional (se quiser usar)

    model_config = ConfigDict(from_attributes=True)


class ColaboradorUpdate(BaseModel):
    nome: Optional[str] = None
    email: Optional[EmailStr] = None
    setor_id: Optional[int] = None
    telefone: Optional[str] = None
    cargo: Optional[str] = None
    senha: Optional[str] = None
    atualizar_usuario: Optional[bool] = False
    permissoes: Optional[List[str]] = None  # ← permite atualizar permissões junto


# ==========================
# Transformadores
# ==========================
def _to_out(db: Session, c: models.Colaborador) -> ColaboradorOut:
    """
    Retorna o shape plano esperado no front.
    Fallbacks:
      - setor_nome: tenta Setor -> (se não achar) Departamento com o mesmo ID
      - telefone: tenta colab.telefone -> usuario.telefone/whatsapp/celular/phone
    """
    # ---- setor_nome (Setor OU Departamento) ----
    setor_nome: Optional[str] = None
    if getattr(c, "setor", None) is not None:
        setor_nome = c.setor.nome
    elif c.setor_id:
        s = db.query(models.Setor).filter_by(id=c.setor_id).first()
        if s:
            setor_nome = s.nome
        else:
            dep = db.query(models.Departamento).filter_by(id=c.setor_id, empresa_id=c.empresa_id).first()
            if dep:
                setor_nome = dep.nome

    # ---- usuário (definir sempre para evitar UnboundLocalError) ----
    u = None
    uid = getattr(c, "usuario_id", None)
    need_user = (not c.nome) or (not c.email) or (not c.telefone) or (not c.cargo) or (setor_nome is None)
    if need_user and uid:
        try:
            u = db.query(models.Usuario).get(uid)
        except Exception:
            u = None

    # ---- campos com fallback no usuário ----
    nome_plano = c.nome or getattr(u, "nome", None)
    email_plano = c.email or getattr(u, "email", None)
    telefone_plano = (
        c.telefone
        or getattr(u, "telefone", None)
        or getattr(u, "whatsapp", None)
        or getattr(u, "celular", None)
        or getattr(u, "phone", None)
    )
    cargo_plano = c.cargo or getattr(u, "cargo", None)

    avatar_url = build_avatar_url(nome_plano, email_plano)

    return ColaboradorOut(
        id=c.id,
        empresa_id=c.empresa_id,
        setor_id=c.setor_id,
        usuario_id=uid,
        nome=nome_plano or "",
        email=email_plano or "no-reply@local.invalid",
        telefone=telefone_plano,
        cargo=cargo_plano,
        setor_nome=setor_nome,
        tem_usuario=bool(uid),
        avatar_url=avatar_url,
    )


# ==========================
# Endpoints
# ==========================
@router.get("", response_model=List[ColaboradorOut])
@router.get("/", response_model=List[ColaboradorOut])
def listar_colaboradores(
    q: Optional[str] = None,
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    base = (
        db.query(models.Colaborador)
        .options(joinedload(models.Colaborador.setor))
        .filter(models.Colaborador.empresa_id == user.empresa_id)
    )
    if q:
        like = f"%{q}%"
        base = base.filter(
            or_(
                models.Colaborador.nome.ilike(like),
                models.Colaborador.email.ilike(like),
                models.Colaborador.telefone.ilike(like),
                models.Colaborador.cargo.ilike(like),
            )
        )
    rows = base.order_by(func.lower(models.Colaborador.nome)).all()
    return [_to_out(db, c) for c in rows]


@router.get("/{colab_id}", response_model=ColaboradorOut)
def obter_colaborador(
    colab_id: int,
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    c = (
        db.query(models.Colaborador)
        .options(joinedload(models.Colaborador.setor))
        .get(colab_id)
    )
    if not c:
        raise HTTPException(status_code=404, detail="Colaborador não encontrado")
    _assert_mesma_empresa(c.empresa_id, user.empresa_id)
    return _to_out(db, c)


@router.post("", response_model=ColaboradorOut, status_code=status.HTTP_201_CREATED)
@router.post("/", response_model=ColaboradorOut, status_code=status.HTTP_201_CREATED)
async def criar_colaborador(
    request: Request,
    db: Session = Depends(get_db),
    user=Depends(get_current_user),

    # FormData (compat do front)
    nome: str = Form(...),
    email: EmailStr = Form(...),
    setor_id: Optional[int] = Form(None),
    telefone: Optional[str] = Form(None),
    cargo: Optional[str] = Form(None),
    senha: str = Form(...),                     # ← senha agora é obrigatória
    permissoes: Optional[str] = Form(None),
    avatar: Optional[UploadFile] = File(None),
):
    # Se vier JSON, aceitar também
    if request.headers.get("content-type", "").startswith("application/json"):
        payload = await request.json()
        if isinstance(payload, dict):
            nome = payload.get("nome", nome)
            email = payload.get("email", email)
            setor_id = payload.get("setor_id", setor_id)
            telefone = payload.get("telefone", telefone)
            cargo = payload.get("cargo", cargo)
            senha = payload.get("senha", senha)
            permissoes = payload.get("permissoes", permissoes)

    # valida senha (sempre)
    if not senha or len(senha.encode("utf-8")) > 72 or len(senha) < 6:
        raise HTTPException(status_code=422, detail="Senha deve ter entre 6 e 72 caracteres.")

    setor = _resolve_setor_or_departamento(db, user.empresa_id, setor_id) if setor_id else None
    if setor_id is not None and not setor:
        raise HTTPException(status_code=404, detail="Setor não encontrado para sua empresa")

    telefone_norm = normalize_phone_e164_br(telefone)

    if db.query(models.Colaborador).filter(models.Colaborador.email == str(email).lower()).first():
        raise HTTPException(status_code=409, detail="E-mail já cadastrado em colaboradores")

    # Cria sempre o usuário
    u = models.Usuario(
        empresa_id=user.empresa_id,
        nome=nome.strip(),
        email=str(email).lower(),
        senha_hash=hash_pwd(senha),
        cargo=cargo or None,
        is_admin=False,
    )
    if avatar is not None:
        data = await avatar.read()
        if data:
            u.avatar_data = data
            u.avatar_mime = avatar.content_type or "application/octet-stream"
    try:
        db.add(u)
        db.flush()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail="E-mail já cadastrado em usuários")

    # senha do colaborador (espelho)
    senha_colab_hash = hash_pwd(senha)

    colab = models.Colaborador(
        empresa_id=user.empresa_id,
        setor_id=(setor.id if setor else None),
        usuario_id=u.id,
        nome=nome.strip(),
        email=str(email).lower(),
        senha=senha_colab_hash,
        telefone=telefone_norm,
        cargo=(cargo or None),
    )

    # permissões (se vierem)
    perm_ids = _parse_perms(permissoes)
    if perm_ids:
        perms = db.query(models.Permissao).filter(models.Permissao.id.in_(perm_ids)).all()
        colab.permissoes = perms

    try:
        db.add(colab)
        db.flush()
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail="E-mail já cadastrado")
    except Exception:
        db.rollback()
        raise

    c = (
        db.query(models.Colaborador)
        .options(joinedload(models.Colaborador.setor))
        .get(colab.id)
    )
    return _to_out(db, c)


@router.put("/{colab_id}", response_model=ColaboradorOut)
def atualizar_colaborador(
    colab_id: int,
    payload: ColaboradorUpdate = Body(...),
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    colab = (
        db.query(models.Colaborador)
        .options(joinedload(models.Colaborador.setor))
        .get(colab_id)
    )
    if not colab:
        raise HTTPException(status_code=404, detail="Colaborador não encontrado")
    _assert_mesma_empresa(colab.empresa_id, user.empresa_id)

    # --- atualiza campos básicos ---
    if payload.nome is not None:
        colab.nome = payload.nome.strip()
    if payload.email is not None:
        colab.email = str(payload.email).lower()
    if payload.telefone is not None:
        colab.telefone = normalize_phone_e164_br(payload.telefone)
    if payload.cargo is not None:
        colab.cargo = payload.cargo or None

    if payload.setor_id is not None:
        setor = _resolve_setor_or_departamento(db, user.empresa_id, payload.setor_id)
        if not setor:
            raise HTTPException(status_code=404, detail="Setor não encontrado para sua empresa")
        colab.setor_id = setor.id

    # --- senha (e sincroniza com usuário se solicitado) ---
    if payload.senha is not None and payload.senha != "":
        colab.senha = hash_pwd(payload.senha)
        if payload.atualizar_usuario and colab.usuario_id:
            u = db.query(models.Usuario).get(colab.usuario_id)
            if u:
                u.senha_hash = hash_pwd(payload.senha)
                db.add(u)

    # --- sincronização com Usuario (nome/email/cargo) ---
    if payload.atualizar_usuario and colab.usuario_id:
        u = db.query(models.Usuario).get(colab.usuario_id)
        if u:
            if payload.nome is not None:
                u.nome = payload.nome.strip()
            if payload.email is not None:
                u.email = str(payload.email).lower()
            if payload.cargo is not None:
                u.cargo = payload.cargo or None
            db.add(u)

    # --- permissões (substituição do conjunto) ---
    if payload.permissoes is not None:
        perm_ids = [str(x) for x in payload.permissoes]
        perms = db.query(models.Permissao).filter(models.Permissao.id.in_(perm_ids)).all()
        colab.permissoes = perms

    try:
        db.add(colab)
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail="E-mail já cadastrado")
    except Exception:
        db.rollback()
        raise

    c = (
        db.query(models.Colaborador)
        .options(joinedload(models.Colaborador.setor))
        .get(colab.id)
    )
    return _to_out(db, c)


@router.delete("/{colab_id}", status_code=status.HTTP_204_NO_CONTENT)
def excluir_colaborador(
    colab_id: int,
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    colab = db.query(models.Colaborador).get(colab_id)
    if not colab:
        return  # idempotente
    _assert_mesma_empresa(colab.empresa_id, user.empresa_id)

    try:
        db.delete(colab)
        db.commit()
    except Exception:
        db.rollback()
        raise
    return


# ==========================
# Avatar do colaborador
# ==========================
@router.get(
    "/{colab_id}/avatar",
    summary="Avatar do colaborador (usa avatar do usuário vinculado, se houver)",
    responses={200: {"content": {"image/*": {}}}}
)
def get_colaborador_avatar(
    colab_id: int,
    db: Session = Depends(get_db),
    me=Depends(get_current_user),
):
    c = db.query(models.Colaborador).get(colab_id)
    if not c:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Colaborador não encontrado")
    _assert_mesma_empresa(c.empresa_id, me.empresa_id)

    if c.usuario_id:
        u = db.query(models.Usuario).get(c.usuario_id)
        if u and u.avatar_data:
            data = u.avatar_data.tobytes() if isinstance(u.avatar_data, memoryview) else u.avatar_data
            mime = u.avatar_mime or "image/png"
            return Response(content=data, media_type=mime)

    # Sem avatar -> 204; front exibe monograma/iniciais
    return Response(status_code=status.HTTP_204_NO_CONTENT)
