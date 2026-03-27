from __future__ import annotations

from typing import Optional, List
import re
import json
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
from pydantic import BaseModel, EmailStr, ConfigDict, Field
from sqlalchemy import or_, func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, joinedload

from passlib.hash import bcrypt

from backend.database import get_db
from backend import models
from backend.routers.auth import get_current_user

from backend.utils.entitlements import enforce_quota
from backend.utils.usage import usage_counts

router = APIRouter(prefix="/colaboradores", tags=["Colaboradores"])


def _assert_mesma_empresa(a: int, b: int) -> None:
    if a != b:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Empresa inválida para este recurso",
        )


def normalize_phone_e164_br(raw: Optional[str]) -> Optional[str]:
    if not raw:
        return None
    d = re.sub(r"\D+", "", str(raw))
    if not d:
        return None
    if d.startswith("55"):
        return "+" + d
    if len(d) in (10, 11):
        return "+55" + d
    return "+" + d


HORA_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")


def _norm_hora(h: Optional[str]) -> Optional[str]:
    if h is None:
        return None
    h = str(h).strip()
    if not h:
        return None
    if len(h) >= 5 and h[2] == ":":
        h = h[:5]
    if not HORA_RE.match(h):
        return None
    return h


HORARIO_MODO_VALUES = ("departamento", "personalizado", "livre")


def _norm_horario_modo(v: Optional[str], *, default: Optional[str] = None) -> Optional[str]:
    if v is None:
        return default
    s = str(v).strip().lower()
    if not s:
        return default
    if s in ("dept", "depto", "padrao", "padrão", "departamento_padrao", "departamento-padrao"):
        return "departamento"
    if s in ("custom", "personalizado", "pessoal", "individual"):
        return "personalizado"
    if s in ("livre", "sem restricao", "sem_restricao", "semrestricao", "none", "off"):
        return "livre"
    if s in HORARIO_MODO_VALUES:
        return s
    return default


def build_avatar_url(nome: Optional[str], email: Optional[str]) -> str:
    seed = (nome or email or "Colaborador").strip() or "Colaborador"
    return (
        "https://api.dicebear.com/7.x/initials/svg"
        f"?seed={quote(seed)}&radius=12&scale=100"
    )


def _resolve_setor_or_departamento(
    db: Session, empresa_id: int, maybe_id: Optional[int]
) -> Optional[models.Setor]:
    if not maybe_id:
        return None

    s = (
        db.query(models.Setor)
        .filter_by(id=maybe_id, empresa_id=empresa_id)
        .first()
    )
    if s:
        return s

    dep = (
        db.query(models.Departamento)
        .filter(
            models.Departamento.id == maybe_id,
            models.Departamento.empresa_id == empresa_id,
        )
        .first()
    )
    if not dep:
        return None

    s = (
        db.query(models.Setor)
        .filter(models.Setor.empresa_id == empresa_id, models.Setor.nome == dep.nome)
        .first()
    )
    if s:
        return s

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
    return [p for p in re.split(r"[\s,;]+", s) if p]


def _safe_int(value, default: int = 0) -> int:
    try:
        return int(value)
    except Exception:
        return default


def _usage_pick(counts: dict, *keys: str, default: int = 0) -> int:
    for key in keys:
        if key in counts:
            return _safe_int(counts.get(key), default)
    return default


class ColaboradorOut(BaseModel):
    id: int
    empresa_id: int
    setor_id: Optional[int]
    usuario_id: Optional[int]
    nome: str
    email: EmailStr
    telefone: Optional[str]
    cargo: Optional[str]

    hora_login_inicio: Optional[str] = None
    hora_login_fim: Optional[str] = None
    horario_modo: Optional[str] = None

    instancias_ids: list[int] = Field(default_factory=list)

    setor_nome: Optional[str] = None
    tem_usuario: bool = False
    avatar_url: Optional[str] = None
    is_admin: bool = False

    model_config = ConfigDict(from_attributes=True)


class ColaboradorUpdate(BaseModel):
    nome: Optional[str] = None
    email: Optional[EmailStr] = None
    setor_id: Optional[int] = None
    telefone: Optional[str] = None
    cargo: Optional[str] = None

    hora_login_inicio: Optional[str] = None
    hora_login_fim: Optional[str] = None
    horario_modo: Optional[str] = None

    senha: Optional[str] = None
    atualizar_usuario: Optional[bool] = False
    permissoes: Optional[List[str]] = None
    instancias_ids: Optional[List[int]] = None


class ColaboradorInstanciasUpdate(BaseModel):
    instancias_ids: List[int] = Field(default_factory=list)


def _to_out(db: Session, c: models.Colaborador) -> ColaboradorOut:
    setor_nome: Optional[str] = None
    if getattr(c, "setor", None) is not None:
        setor_nome = c.setor.nome
    elif c.setor_id:
        s = db.query(models.Setor).filter_by(id=c.setor_id).first()
        if s:
            setor_nome = s.nome
        else:
            dep = (
                db.query(models.Departamento)
                .filter_by(id=c.setor_id, empresa_id=c.empresa_id)
                .first()
            )
            if dep:
                setor_nome = dep.nome

    u = None
    uid = getattr(c, "usuario_id", None)
    need_user = (
        (not c.nome)
        or (not c.email)
        or (not c.telefone)
        or (not c.cargo)
        or (setor_nome is None)
    )
    if need_user and uid:
        try:
            u = db.query(models.Usuario).get(uid)
        except Exception:
            u = None

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
    is_admin_flag = (cargo_plano or "").lower() == "admin"

    modo_raw = getattr(c, "horario_modo", None)
    horario_modo_out = _norm_horario_modo(modo_raw, default=None)
    if not horario_modo_out:
        if c.hora_login_inicio and c.hora_login_fim:
            horario_modo_out = "personalizado"
        else:
            horario_modo_out = "livre"

    return ColaboradorOut(
        id=c.id,
        empresa_id=c.empresa_id,
        setor_id=c.setor_id,
        usuario_id=uid,
        nome=nome_plano or "",
        email=email_plano or "no-reply@local.invalid",
        telefone=telefone_plano,
        cargo=cargo_plano,
        instancias_ids=list(c.instancias_ver or []),
        setor_nome=setor_nome,
        tem_usuario=bool(uid),
        avatar_url=avatar_url,
        is_admin=is_admin_flag,
        hora_login_inicio=c.hora_login_inicio,
        hora_login_fim=c.hora_login_fim,
        horario_modo=horario_modo_out,
    )


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
    nome: Optional[str] = Form(None),
    email: Optional[EmailStr] = Form(None),
    setor_id: Optional[int] = Form(None),
    telefone: Optional[str] = Form(None),
    cargo: Optional[str] = Form(None),
    hora_login_inicio: Optional[str] = Form(None),
    hora_login_fim: Optional[str] = Form(None),
    horario_modo: Optional[str] = Form(None),
    criar_usuario: Optional[bool] = Form(False),
    senha: Optional[str] = Form(None),
    permissoes: Optional[str] = Form(None),
    avatar: Optional[UploadFile] = File(None),
):
    if request.headers.get("content-type", "").startswith("application/json"):
        payload = await request.json()
        if isinstance(payload, dict):
            nome = payload.get("nome", nome)
            email = payload.get("email", email)
            setor_id = payload.get("setor_id", setor_id)
            telefone = payload.get("telefone", telefone)
            cargo = payload.get("cargo", cargo)
            criar_usuario = payload.get("criar_usuario", criar_usuario)
            senha = payload.get("senha", senha)
            permissoes = payload.get("permissoes", permissoes)
            hora_login_inicio = payload.get("hora_login_inicio", hora_login_inicio)
            hora_login_fim = payload.get("hora_login_fim", hora_login_fim)
            horario_modo = payload.get("horario_modo", horario_modo)

    if not nome or not str(nome).strip():
        raise HTTPException(status_code=422, detail="Nome é obrigatório")

    if not email:
        raise HTTPException(status_code=422, detail="E-mail é obrigatório")

    emp = db.query(models.Empresa).get(user.empresa_id)
    if emp:
        counts = usage_counts(db, emp.id) or {}
        current_users = _usage_pick(
            counts,
            "users_max",
            "users",
            "usuarios",
            "colaboradores",
            default=0,
        )
        enforce_quota(
            emp,
            "users_max",
            current_users,
            delta=1,
            message="Seu plano está vencido ou atingiu o limite de colaboradores.",
        )

    setor = (
        _resolve_setor_or_departamento(db, user.empresa_id, setor_id)
        if setor_id
        else None
    )
    if setor_id is not None and not setor:
        raise HTTPException(
            status_code=404, detail="Setor não encontrado para sua empresa"
        )

    telefone_norm = normalize_phone_e164_br(telefone)

    if (
        db.query(models.Colaborador)
        .filter(models.Colaborador.email == str(email).lower())
        .first()
    ):
        raise HTTPException(
            status_code=409, detail="E-mail já cadastrado em colaboradores"
        )

    avatar_bytes = None
    avatar_mime = None
    if avatar is not None:
        avatar_bytes = await avatar.read()
        if avatar_bytes:
            avatar_mime = avatar.content_type or "application/octet-stream"

    usuario_id = None
    if criar_usuario:
        if not senha:
            raise HTTPException(
                status_code=422,
                detail="Senha é obrigatória para criar usuário",
            )

        u = models.Usuario(
            empresa_id=user.empresa_id,
            nome=str(nome).strip(),
            email=str(email).lower(),
            senha_hash=bcrypt.hash(senha),
            cargo=cargo or None,
            is_admin=False,
        )

        if avatar_bytes:
            u.avatar_data = avatar_bytes
            u.avatar_mime = avatar_mime

        try:
            db.add(u)
            db.flush()
            usuario_id = u.id
        except IntegrityError:
            db.rollback()
            raise HTTPException(
                status_code=409, detail="E-mail já cadastrado em usuários"
            )

    senha_colab_hash = bcrypt.hash(senha) if senha else bcrypt.hash("temp@123")

    hi_norm = _norm_hora(hora_login_inicio)
    hf_norm = _norm_hora(hora_login_fim)

    horario_modo_norm = _norm_horario_modo(horario_modo, default=None)
    if not horario_modo_norm:
        if hi_norm or hf_norm:
            horario_modo_norm = "personalizado"
        elif setor is not None:
            horario_modo_norm = "departamento"
        else:
            horario_modo_norm = "livre"

    colab = models.Colaborador(
        empresa_id=user.empresa_id,
        setor_id=(setor.id if setor else None),
        usuario_id=usuario_id,
        nome=str(nome).strip(),
        email=str(email).lower(),
        senha=senha_colab_hash,
        telefone=telefone_norm,
        cargo=(cargo or None),
        hora_login_inicio=hi_norm,
        hora_login_fim=hf_norm,
        avatar_data=avatar_bytes if avatar_bytes else None,
        avatar_mime=avatar_mime if avatar_bytes else None,
    )

    if hasattr(colab, "horario_modo"):
        setattr(colab, "horario_modo", horario_modo_norm)

    perm_ids = _parse_perms(permissoes)
    if perm_ids:
        perms = (
            db.query(models.Permissao)
            .filter(models.Permissao.id.in_(perm_ids))
            .all()
        )
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

    data = payload.model_dump(exclude_unset=True)

    if "nome" in data and data["nome"] is not None:
        colab.nome = data["nome"].strip()
    if "email" in data and data["email"] is not None:
        colab.email = str(data["email"]).lower()
    if "telefone" in data:
        colab.telefone = normalize_phone_e164_br(data["telefone"])
    if "cargo" in data:
        colab.cargo = data["cargo"] or None

    if "setor_id" in data:
        setor_id = data["setor_id"]
        if setor_id is not None:
            setor = _resolve_setor_or_departamento(db, user.empresa_id, setor_id)
            if not setor:
                raise HTTPException(
                    status_code=404, detail="Setor não encontrado para sua empresa"
                )
            colab.setor_id = setor.id
        else:
            colab.setor_id = None

    if "hora_login_inicio" in data:
        colab.hora_login_inicio = _norm_hora(data["hora_login_inicio"])
    if "hora_login_fim" in data:
        colab.hora_login_fim = _norm_hora(data["hora_login_fim"])

    if "horario_modo" in data and hasattr(colab, "horario_modo"):
        colab.horario_modo = _norm_horario_modo(data.get("horario_modo"), default=None) or "livre"

    atualizar_usuario_flag = bool(
        data.get("atualizar_usuario") or payload.atualizar_usuario
    )

    if "senha" in data and data["senha"]:
        nova_senha = data["senha"]
        colab.senha = bcrypt.hash(nova_senha)
        if atualizar_usuario_flag and colab.usuario_id:
            u = db.query(models.Usuario).get(colab.usuario_id)
            if u:
                u.senha_hash = bcrypt.hash(nova_senha)
                db.add(u)

    if atualizar_usuario_flag and colab.usuario_id:
        u = db.query(models.Usuario).get(colab.usuario_id)
        if u:
            if "nome" in data and data["nome"] is not None:
                u.nome = data["nome"].strip()
            if "email" in data and data["email"] is not None:
                u.email = str(data["email"]).lower()
            if "cargo" in data:
                u.cargo = data["cargo"] or None
            db.add(u)

    if "permissoes" in data:
        perm_ids = [str(x) for x in (data["permissoes"] or [])]
        if perm_ids:
            perms = (
                db.query(models.Permissao)
                .filter(models.Permissao.id.in_(perm_ids))
                .all()
            )
        else:
            perms = []
        colab.permissoes = perms

    if "instancias_ids" in data:
        raw = data["instancias_ids"] or []
        norm_ids: list[int] = []
        for x in raw:
            try:
                if x is not None:
                    norm_ids.append(int(x))
            except (TypeError, ValueError):
                continue
        colab.instancias_ver = norm_ids

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


@router.put("/{colab_id}/instancias", response_model=ColaboradorOut)
def atualizar_instancias_colaborador(
    colab_id: int,
    payload: ColaboradorInstanciasUpdate = Body(...),
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    colab = (
        db.query(models.Colaborador)
        .options(joinedload(models.Colaborador.setor))
        .get(colab_id)
    )
    if not colab:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Colaborador não encontrado")

    _assert_mesma_empresa(colab.empresa_id, user.empresa_id)

    norm_ids: list[int] = []
    for x in payload.instancias_ids or []:
        try:
            if x is not None:
                norm_ids.append(int(x))
        except (TypeError, ValueError):
            continue

    colab.instancias_ver = norm_ids

    try:
        db.add(colab)
        db.commit()
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
        return
    _assert_mesma_empresa(colab.empresa_id, user.empresa_id)

    try:
        db.delete(colab)
        db.commit()
    except Exception:
        db.rollback()
        raise
    return


@router.put(
    "/{colab_id}/avatar",
    summary="Atualiza avatar do colaborador",
    responses={200: {"description": "Avatar atualizado"}},
)
async def put_colaborador_avatar(
    colab_id: int,
    avatar: UploadFile = File(...),
    db: Session = Depends(get_db),
    me=Depends(get_current_user),
):
    c = db.query(models.Colaborador).get(colab_id)
    if not c:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Colaborador não encontrado")

    _assert_mesma_empresa(c.empresa_id, me.empresa_id)

    data = await avatar.read()
    if not data:
        raise HTTPException(status_code=400, detail="Arquivo de avatar vazio")

    c.avatar_data = data
    c.avatar_mime = avatar.content_type or "application/octet-stream"

    if c.usuario_id:
        u = db.query(models.Usuario).get(c.usuario_id)
        if u:
            u.avatar_data = data
            u.avatar_mime = c.avatar_mime

    db.add(c)
    db.commit()
    return {"ok": True}


@router.get(
    "/{colab_id}/avatar",
    summary="Avatar do colaborador",
    responses={200: {"content": {"image/*": {}}}},
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

    if getattr(c, "avatar_data", None):
        data = c.avatar_data.tobytes() if isinstance(c.avatar_data, memoryview) else c.avatar_data
        mime = c.avatar_mime or "image/png"
        return Response(content=data, media_type=mime)

    if c.usuario_id:
        u = db.query(models.Usuario).get(c.usuario_id)
        if u and u.avatar_data:
            data = (
                u.avatar_data.tobytes()
                if isinstance(u.avatar_data, memoryview)
                else u.avatar_data
            )
            mime = u.avatar_mime or "image/png"
            return Response(content=data, media_type=mime)

    return Response(status_code=status.HTTP_204_NO_CONTENT)