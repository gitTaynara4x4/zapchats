# backend/routers/auth.py
from datetime import datetime, timedelta
import os, base64, re, secrets
from uuid import uuid4

import jwt
from passlib.hash import bcrypt as passlib_bcrypt
from fastapi import APIRouter, Depends, HTTPException, Response, Request, Header, status
from fastapi.security import OAuth2PasswordBearer
from pydantic import BaseModel, EmailStr
from sqlalchemy.orm import Session
from sqlalchemy import text
from dotenv import load_dotenv
import pytz

from backend.database import get_db_session
import backend.models as models

from backend.security.login_throttle import (
    norm_email, client_ip_from_headers, is_locked, apply_lock,
    inc_fail, reset_fail, should_lock, ACCOUNT_LOCK_SEC
)

# módulo de e-mail separado
from backend.email import send_reset_email

load_dotenv()

JWT_SECRET      = os.getenv("JWT_SECRET", "troque-me")
JWT_EXP_MINUTES = int(os.getenv("JWT_EXP_MINUTES", str(60 * 24)))
ALGORITHM       = "HS256"

TRIAL_DAYS = int(os.getenv("TRIAL_DAYS", "7"))

ACCESS_COOKIE_NAME = os.getenv("ACCESS_COOKIE_NAME", "access_token")
COOKIE_SECURE     = (os.getenv("COOKIE_SECURE", "false").strip().lower() in ("1","true","yes","on"))
COOKIE_SAMESITE   = os.getenv("COOKIE_SAMESITE", "lax").strip().lower()
CSRF_COOKIE_NAME  = os.getenv("CSRF_COOKIE_NAME", "csrf_token")

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth/login")
router = APIRouter(prefix="/auth", tags=["Auth"])

DATA_URL_RE = re.compile(r"^data:(?P<mime>[^;]+);base64,(?P<data>.+)$")

def _envflag(name: str, default: str = "false") -> bool:
    return (os.getenv(name, default) or "").strip().lower() in ("1", "true", "yes", "on")

READONLY_MODE             = _envflag("READONLY_MODE")
DISABLE_REGISTER          = _envflag("DISABLE_REGISTER")
DISABLE_PASSWORD_RECOVERY = _envflag("DISABLE_PASSWORD_RECOVERY")

def guard_writable_all(_: Request):
    if READONLY_MODE:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Sistema em manutenção (somente leitura).")

def guard_writable_register(_: Request):
    if READONLY_MODE or DISABLE_REGISTER:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Cadastro temporariamente desativado.")

def guard_writable_recovery(_: Request):
    if READONLY_MODE or DISABLE_PASSWORD_RECOVERY:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Recuperação de senha temporariamente desativada.")

def commit_or_block(db: Session):
    if READONLY_MODE:
        try: db.rollback()
        except Exception: pass
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Somente leitura (manutenção).")
    db.commit()

# ───────── Schemas ─────────
class ForgotPasswordIn(BaseModel):
    email: EmailStr

class ResetPasswordIn(BaseModel):
    token: str
    nova_senha: str

class LoginIn(BaseModel):
    email: EmailStr
    senha: str
    remember: bool | None = None

class RegisterIn(BaseModel):
    nome: str
    telefone: str
    email_admin: EmailStr
    senha_admin: str
    nome_adm: str | None = None
    avatar_url: str | None = None
    doc: str | None = None

# ───────── Helpers ─────────
def hash_pwd(password: str) -> str:
    return passlib_bcrypt.hash(password)

def verify_pwd(plain: str, hashed: str) -> bool:
    return passlib_bcrypt.verify(plain, hashed)

def create_access_token(data: dict, minutes: int | None = None) -> str:
    to_encode = data.copy()
    exp = datetime.utcnow() + timedelta(minutes=minutes or JWT_EXP_MINUTES)
    to_encode.update({"exp": exp})
    return jwt.encode(to_encode, JWT_SECRET, algorithm=ALGORITHM)

def _decode_token(token: str) -> dict:
    try:
        return jwt.decode(token, JWT_SECRET, algorithms=[ALGORITHM])
    except jwt.ExpiredSignatureError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Token expirado")
    except jwt.InvalidTokenError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Token inválido")

def data_url_to_bytes(data_url: str) -> tuple[str, bytes]:
    m = DATA_URL_RE.match(data_url)
    if not m: raise ValueError("Data URL inválida")
    mime = m.group("mime")
    raw  = base64.b64decode(m.group("data"))
    return mime, raw

def _token_from_request(request: Request, authorization: str | None) -> str | None:
    if authorization and authorization.startswith("Bearer "):
        return authorization.split(" ", 1)[1]
    return request.cookies.get(ACCESS_COOKIE_NAME)

def get_current_identity(
    request: Request,
    authorization: str = Header(default=None, alias="Authorization"),
    db: Session = Depends(get_db_session)
):
    token = _token_from_request(request, authorization)
    if not token:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Não autenticado")

    payload    = _decode_token(token)
    sub        = payload.get("sub")
    role       = (payload.get("role") or "").lower()
    empresa_id = payload.get("empresa_id")

    if not sub:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Token inválido")

    if isinstance(sub, str) and sub.startswith("colab-"):
        try:
            colab_id = int(sub.split("colab-", 1)[1])
        except Exception:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Token inválido")

        colab = db.query(models.Colaborador).filter(models.Colaborador.id == colab_id).first()
        if not colab:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Usuário não encontrado")

        is_admin = (role == "admin") or ((colab.cargo or "").lower() == "admin")
        return {
            "kind": "colaborador",
            "id": colab.id,
            "empresa_id": colab.empresa_id,
            "nome": colab.nome,
            "email": colab.email,
            "role": colab.cargo or role or "colaborador",
            "is_admin": is_admin,
        }

    user = db.query(models.Usuario).filter(models.Usuario.id == int(sub)).first()
    if not user:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Usuário não encontrado")

    return {
        "kind": "usuario",
        "id": user.id,
        "empresa_id": user.empresa_id,
        "nome": user.nome,
        "email": user.email,
        "role": role or "admin",
        "is_admin": True,
    }

def get_current_user(
    request: Request,
    authorization: str = Header(default=None, alias="Authorization"),
    db: Session = Depends(get_db_session)
) -> models.Usuario:
    token = _token_from_request(request, authorization)
    if not token: raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Não autenticado")
    payload = _decode_token(token)
    sub     = payload.get("sub")
    if not sub: raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Token inválido")
    if isinstance(sub, str) and sub.startswith("colab-"):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Apenas administradores")
    user = db.query(models.Usuario).filter(models.Usuario.id == int(sub)).first()
    if not user: raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Usuário não encontrado")
    return user

def csrf_protect_refresh(request: Request, csrf_header: str | None = Header(default=None, alias="X-CSRF-Token")):
    cookie_val = request.cookies.get(CSRF_COOKIE_NAME)
    if not cookie_val or not csrf_header or not secrets.compare_digest(cookie_val, csrf_header):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "CSRF token inválido")
    return True

# Base pública a partir do request (proxy-friendly)
def public_base_url(request: Request) -> str:
    h = request.headers
    proto  = (h.get("x-forwarded-proto") or request.url.scheme or "http").split(",")[0].strip()
    host   = (h.get("x-forwarded-host")  or h.get("host") or request.url.netloc).split(",")[0].strip()
    prefix = (h.get("x-forwarded-prefix") or request.scope.get("root_path", "") or "").rstrip("/")
    base   = f"{proto}://{host}{prefix}"
    return base.rstrip("/")

# ───────── Rotas essenciais (login/forgot/reset) ─────────
@router.post("/login")
def login(form: LoginIn, response: Response, request: Request, db: Session = Depends(get_db_session)):
    email = norm_email(form.email)
    ip    = client_ip_from_headers(request.headers, request.client.host)

    remain = is_locked(db, email, ip)
    if remain > 0:
        raise HTTPException(status_code=429, detail="Muitas tentativas. Aguarde para tentar novamente.", headers={"Retry-After": str(remain)})

    user = db.query(models.Usuario).filter_by(email=email).first()
    if user and verify_pwd(form.senha, user.senha_hash):
        reset_fail(db, email, ip); db.commit()
        token = create_access_token({"sub": str(user.id), "empresa_id": user.empresa_id, "role": "admin"})
        cookie_max_age = (60 * 60 * 24 * 30) if getattr(form, "remember", False) else JWT_EXP_MINUTES * 60
        response.set_cookie(ACCESS_COOKIE_NAME, token, httponly=True, secure=COOKIE_SECURE, samesite=COOKIE_SAMESITE, max_age=cookie_max_age, path="/")
        response.set_cookie("empresa_id", str(user.empresa_id), httponly=False, secure=COOKIE_SECURE, samesite=COOKIE_SAMESITE, max_age=cookie_max_age, path="/")
        return {"access_token": token, "empresa_id": user.empresa_id, "nome": user.nome, "cargo": "admin", "is_admin": True}

    colab = db.query(models.Colaborador).filter_by(email=email).first()
    if colab and verify_pwd(form.senha, colab.senha):
        reset_fail(db, email, ip); db.commit()
        token = create_access_token({"sub": f"colab-{colab.id}", "empresa_id": colab.empresa_id, "role": colab.cargo})
        cookie_max_age = (60 * 60 * 24 * 30) if getattr(form, "remember", False) else JWT_EXP_MINUTES * 60
        response.set_cookie(ACCESS_COOKIE_NAME, token, httponly=True, secure=COOKIE_SECURE, samesite=COOKIE_SAMESITE, max_age=cookie_max_age, path="/")
        response.set_cookie("empresa_id", str(colab.empresa_id), httponly=False, secure=COOKIE_SECURE, samesite=COOKIE_SAMESITE, max_age=cookie_max_age, path="/")
        return {"access_token": token, "empresa_id": colab.empresa_id, "nome": colab.nome, "cargo": colab.cargo, "is_admin": (colab.cargo or '').lower() == 'admin'}

    fails, _ = inc_fail(db, email, ip)
    if should_lock(fails):
        apply_lock(db, email, ip, ACCOUNT_LOCK_SEC); db.commit()
        raise HTTPException(status_code=429, detail="Muitas tentativas. Sua conta foi temporariamente bloqueada.")
    db.commit()
    raise HTTPException(status_code=401, detail="Credenciais inválidas")

@router.post("/forgot-password")
def forgot_password(dados: ForgotPasswordIn, request: Request, db: Session = Depends(get_db_session), _=Depends(guard_writable_recovery)):
    usuario = db.query(models.Usuario).filter_by(email=dados.email).first()
    if not usuario:
        raise HTTPException(status_code=404, detail="Usuário não encontrado")

    token = str(uuid4())
    usuario.reset_token = token
    usuario.reset_token_expira = datetime.utcnow() + timedelta(hours=1)
    commit_or_block(db)

    base_url = public_base_url(request)
    # troque o path abaixo se sua página for .html
    send_reset_email(
        to_email=dados.email,
        token=token,
        first_name=getattr(usuario, "nome", None),
        base_url=base_url,
        reset_path="/esqueci_senha"
    )
    return {"detail": "Token enviado para o e-mail informado."}

@router.post("/reset-password")
def reset_password(dados: ResetPasswordIn, db: Session = Depends(get_db_session), _=Depends(guard_writable_recovery)):
    usuario = db.query(models.Usuario).filter_by(reset_token=dados.token).first()
    if not usuario or usuario.reset_token_expira.replace(tzinfo=None) < datetime.utcnow():
        raise HTTPException(status_code=400, detail="Token inválido ou expirado")

    usuario.senha_hash = hash_pwd(dados.nova_senha)
    usuario.reset_token = None
    usuario.reset_token_expira = None
    commit_or_block(db)
    return {"detail": "Senha redefinida com sucesso!"}
