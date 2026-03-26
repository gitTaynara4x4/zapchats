from datetime import datetime, timedelta
import os
import time
import smtplib
from email.mime.text import MIMEText
import base64
import re
import secrets
from typing import Optional

import jwt
from fastapi import (
    APIRouter,
    Depends,
    HTTPException,
    Response,
    Request,
    Header,
    status,
)
from fastapi.security import OAuth2PasswordBearer
from pydantic import BaseModel, EmailStr
from sqlalchemy.orm import Session
from sqlalchemy import text, func
from dotenv import load_dotenv
import pytz

from backend.database import get_db_session
import backend.models as models
from backend.utils.plans import (
    PLAN_FREE,
    PLAN_START,
    normalize_plan,
    start_start_trial,
)

# Throttle de login
from backend.security.login_throttle import (
    norm_email,
    client_ip_from_headers,
    is_locked,
    apply_lock,
    inc_fail,
    reset_fail,
    should_lock,
    ACCOUNT_LOCK_SEC,
)

# Senhas (bcrypt com truncamento seguro a 72 bytes)
from backend.security.passwords import hash_pwd, verify_pwd

# ───────────────────────── Configurações ─────────────────────────
load_dotenv()

EMAIL_REMETENTE = os.getenv("EMAIL_REMETENTE", "recuperazapchats@gmail.com")
EMAIL_SENHA = os.getenv("EMAIL_SENHA", "qrwfnzukgfk221opifr")

JWT_SECRET = os.getenv("JWT_SECRET", "troque-me")
JWT_EXP_MINUTES = int(os.getenv("JWT_EXP_MINUTES", str(60 * 24)))  # fallback 24h
ALGORITHM = "HS256"

TRIAL_DAYS = int(os.getenv("TRIAL_DAYS", "7"))  # 7 por padrão

# Cookies/CSRF (devem bater com main.py)
ACCESS_COOKIE_NAME = os.getenv("ACCESS_COOKIE_NAME", "access_token")
COOKIE_SECURE = (
    os.getenv("COOKIE_SECURE", "false").strip().lower()
    in ("1", "true", "yes", "on")
)
COOKIE_SAMESITE = os.getenv("COOKIE_SAMESITE", "lax").strip().lower()
CSRF_COOKIE_NAME = os.getenv("CSRF_COOKIE_NAME", "csrf_token")
COOKIE_DOMAIN: Optional[str] = (os.getenv("COOKIE_DOMAIN") or "").strip() or None

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth/login")
router = APIRouter(prefix="/auth", tags=["Auth"])

# data URL: data:image/webp;base64,AAAA...
DATA_URL_RE = re.compile(r"^data:(?P<mime>[^;]+);base64,(?P<data>.+)$")

# Timezone Brasilia
TZ_BR = pytz.timezone("America/Sao_Paulo")

# ───────────────────────── Reset de senha: código curto + limites ─────────────────────────
RESET_CODE_TTL_MIN = int(os.getenv("RESET_CODE_TTL_MIN", "15"))
FORGOT_MAX_REQ = int(os.getenv("FORGOT_MAX_REQ", "3"))
FORGOT_WINDOW_SEC = int(os.getenv("FORGOT_WINDOW_SEC", "900"))

RESET_MAX_ATTEMPTS = int(os.getenv("RESET_MAX_ATTEMPTS", "5"))
RESET_ATTEMPT_WINDOW_SEC = int(os.getenv("RESET_ATTEMPT_WINDOW_SEC", "900"))

# Memória local
_forgot_rate: dict[str, list[float]] = {}
_reset_attempts: dict[str, list[float]] = {}


def _rate_take(store: dict, key: str, limit: int, window_sec: int) -> bool:
    now = time.time()
    rec = store.get(key)
    if not rec or rec[0] < now:
        store[key] = [now + window_sec, 1]
        return True
    if rec[1] >= limit:
        return False
    rec[1] += 1
    return True


def _rate_remaining(store: dict, key: str) -> int:
    now = time.time()
    rec = store.get(key)
    if not rec:
        return 0
    exp = rec[0]
    if exp < now:
        return 0
    return int(exp - now)


def _safe_email_key(email: str) -> str:
    return (email or "").strip().lower()


def _client_ip(request: Request) -> str:
    try:
        return client_ip_from_headers(
            request.headers,
            request.client.host if request.client else None
        ) or "0.0.0.0"
    except Exception:
        return request.client.host if request.client else "0.0.0.0"


def _get_departamento_login_window(
    db: Session, colab: "models.Colaborador"
) -> tuple[Optional[str], Optional[str]]:
    try:
        empresa_id = getattr(colab, "empresa_id", None)
        setor_id = getattr(colab, "setor_id", None)
        if not empresa_id or not setor_id:
            return (None, None)

        dept = (
            db.query(models.Departamento)
            .filter(
                models.Departamento.empresa_id == int(empresa_id),
                models.Departamento.id == int(setor_id),
            )
            .first()
        )

        if not dept:
            setor = (
                db.query(models.Setor)
                .filter(
                    models.Setor.empresa_id == int(empresa_id),
                    models.Setor.id == int(setor_id),
                )
                .first()
            )
            if setor and getattr(setor, "nome", None):
                dept = (
                    db.query(models.Departamento)
                    .filter(
                        models.Departamento.empresa_id == int(empresa_id),
                        func.lower(models.Departamento.nome)
                        == func.lower(str(setor.nome)),
                    )
                    .first()
                )

        if not dept:
            return (None, None)

        hi = getattr(dept, "hora_login_inicio_padrao", None)
        hf = getattr(dept, "hora_login_fim_padrao", None)
        return (hi, hf)
    except Exception:
        return (None, None)


def colab_login_allowed_now(db: Session, colab: "models.Colaborador") -> bool:
    modo_raw = getattr(colab, "horario_modo", None)
    modo = (str(modo_raw).strip().lower() if modo_raw is not None else "").strip()

    if not modo:
        hi0 = getattr(colab, "hora_login_inicio", None)
        hf0 = getattr(colab, "hora_login_fim", None)
        if hi0 and hf0:
            modo = "personalizado"
        else:
            modo = "departamento" if getattr(colab, "setor_id", None) else "livre"

    if modo in ("sem restricao", "sem_restricao", "none", "off"):
        modo = "livre"
    if modo in ("padrao", "padrão", "dept", "depto", "departamento_padrao", "departamento-padrao"):
        modo = "departamento"

    if modo == "livre":
        return True

    hi: Optional[str] = None
    hf: Optional[str] = None

    if modo == "departamento":
        hi, hf = _get_departamento_login_window(db, colab)
    else:
        hi = getattr(colab, "hora_login_inicio", None)
        hf = getattr(colab, "hora_login_fim", None)

    if not hi or not hf:
        return True

    try:
        now_br = datetime.now(TZ_BR).time()

        def _parse(s: str):
            s = str(s).strip()
            if len(s) == 5:
                return datetime.strptime(s, "%H:%M").time()
            if len(s) == 8 and s.count(":") == 2:
                return datetime.strptime(s, "%H:%M:%S").time()
            return datetime.strptime(s[:5], "%H:%M").time()

        h_ini = _parse(hi)
        h_fim = _parse(hf)
    except Exception:
        return True

    if h_ini == h_fim:
        return True

    if h_ini < h_fim:
        return h_ini <= now_br < h_fim

    return now_br >= h_ini or now_br < h_fim


# ───────────────────────── Helpers de Cookie ─────────────────────────
def _is_https(request: Request) -> bool:
    proto = (request.headers.get("x-forwarded-proto") or request.url.scheme or "").lower()
    return proto == "https"


def _cookie_base(request: Request, max_age: Optional[int] = None) -> dict:
    params = {
        "secure": _is_https(request),
        "samesite": "none" if COOKIE_SAMESITE == "none" else "lax",
        "path": "/",
        "domain": COOKIE_DOMAIN or None,
    }
    if max_age is not None:
        params["max_age"] = max_age
    return params


def set_auth_cookies(
    response: Response,
    request: Request,
    *,
    token: str,
    empresa_id: int,
    max_age: int,
):
    base = _cookie_base(request, max_age=max_age)
    response.set_cookie(
        key=ACCESS_COOKIE_NAME,
        value=token,
        httponly=True,
        **base,
    )
    response.set_cookie(
        key="empresa_id",
        value=str(empresa_id),
        httponly=False,
        **base,
    )


def clear_auth_cookies(response: Response, request: Request):
    base = _cookie_base(request, max_age=0)
    response.delete_cookie(key=ACCESS_COOKIE_NAME, path="/", domain=base.get("domain"))
    response.delete_cookie(key="empresa_id", path="/", domain=base.get("domain"))


# ───────────────────────── Feature flags p/ bloquear escrita ─────────────────────────
def _envflag(name: str, default: str = "false") -> bool:
    return (os.getenv(name, default) or "").strip().lower() in (
        "1",
        "true",
        "yes",
        "on",
    )


READONLY_MODE = _envflag("READONLY_MODE")
DISABLE_REGISTER = _envflag("DISABLE_REGISTER")
DISABLE_PASSWORD_RECOVERY = _envflag("DISABLE_PASSWORD_RECOVERY")


def guard_writable_all(_: Request):
    if READONLY_MODE:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "Sistema em manutenção (somente leitura).",
        )


def guard_writable_register(_: Request):
    if READONLY_MODE or DISABLE_REGISTER:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "Cadastro temporariamente desativado.",
        )


def guard_writable_recovery(_: Request):
    if READONLY_MODE or DISABLE_PASSWORD_RECOVERY:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "Recuperação de senha temporariamente desativada.",
        )


def commit_or_block(db: Session):
    if READONLY_MODE:
        try:
            db.rollback()
        except Exception:
            pass
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE, "Somente leitura (manutenção)."
        )
    db.commit()


# ───────────────────────── Schemas ─────────────────────────
class ForgotPasswordIn(BaseModel):
    email: EmailStr


class ResetPasswordIn(BaseModel):
    token: str
    nova_senha: str


class LoginIn(BaseModel):
    email: EmailStr
    senha: str
    remember: bool | None = None


class LoginTokenIn(BaseModel):
    email: EmailStr
    token: str
    remember: bool | None = None


class RegisterIn(BaseModel):
    nome: str
    telefone: str
    email_admin: EmailStr
    senha_admin: str
    nome_adm: str | None = None
    avatar_url: str | None = None
    doc: str | None = None


# ───────────────────────── JWT Helpers ─────────────────────────
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


# ───────────────────────── E-mails auxiliares ─────────────────────────
def _smtp_send(email_destino: str, assunto: str, corpo: str):
    msg = MIMEText(corpo)
    msg["Subject"] = assunto
    msg["From"] = EMAIL_REMETENTE
    msg["To"] = email_destino

    try:
        print("[EMAIL] Conectando em smtp.gmail.com:465...")
        with smtplib.SMTP_SSL("smtp.gmail.com", 465) as server:
            server.login(EMAIL_REMETENTE, EMAIL_SENHA)
            server.sendmail(EMAIL_REMETENTE, email_destino, msg.as_string())
        print(f"[EMAIL] Enviado com sucesso para {email_destino}")
    except Exception as e:
        import traceback
        print("[ERRO EMAIL]", repr(e))
        traceback.print_exc()


def gerar_codigo_reset_5d() -> str:
    return f"{secrets.randbelow(90000) + 10000:05d}"


def enviar_email_reset(email_destino: str, token: str):
    assunto = "[ZapChats] Código para redefinir sua senha"
    corpo = f"""
Olá,

Recebemos uma solicitação para redefinir a senha da conta ZapChats associada a este e-mail.

Seu código de redefinição é:

    {token}

Por motivos de segurança, este código é válido por um período limitado.
Se você não fez esta solicitação, pode ignorar este e-mail.

Atenciosamente,
Equipe ZapChats
"""
    _smtp_send(email_destino, assunto, corpo)


def gerar_codigo_login() -> str:
    return f"{secrets.randbelow(900000) + 100000:06d}"


def enviar_email_login_token(
    email_destino: str, codigo: str, nome_empresa: Optional[str] = None
):
    prefixo = f"[{nome_empresa}] " if nome_empresa else ""
    assunto = f"{prefixo}Código de acesso ao ZapChats"

    corpo = f"""
Olá,

Seu código de acesso é:

    {codigo}

Digite esse código na tela de login do ZapChats para concluir o acesso.
Por segurança, este código expira em poucos minutos e só deve ser usado por você.

Se você não está tentando acessar o sistema, ignore este e-mail.

Atenciosamente,
Equipe ZapChats
"""
    _smtp_send(email_destino, assunto, corpo)


# ───────────────────────── Util de data URL ─────────────────────────
def data_url_to_bytes(data_url: str) -> tuple[str, bytes]:
    m = DATA_URL_RE.match(data_url)
    if not m:
        raise ValueError("Data URL inválida")
    mime = m.group("mime")
    raw = base64.b64decode(m.group("data"))
    return mime, raw


# ─────────── Identidade atual (admin/colaborador) + compat wrapper ───────────
def _token_from_request(
    request: Request,
    authorization: str | None,
) -> str | None:
    if authorization and authorization.startswith("Bearer "):
        return authorization.split(" ", 1)[1]
    return request.cookies.get(ACCESS_COOKIE_NAME)


def get_current_identity(
    request: Request,
    authorization: str = Header(default=None, alias="Authorization"),
    db: Session = Depends(get_db_session),
):
    token = _token_from_request(request, authorization)
    if not token:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Não autenticado")

    payload = _decode_token(token)
    sub = payload.get("sub")
    role = (payload.get("role") or "").lower()

    if not sub:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Token inválido")

    if isinstance(sub, str) and sub.startswith("colab-"):
        try:
            colab_id = int(sub.split("colab-", 1)[1])
        except Exception:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Token inválido")

        colab = (
            db.query(models.Colaborador)
            .filter(models.Colaborador.id == colab_id)
            .first()
        )
        if not colab:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Usuário não encontrado")

        if not colab_login_allowed_now(db, colab):
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                "Fora do horário permitido de acesso para este colaborador.",
            )

        is_admin = (role == "admin") or ((colab.cargo or "").lower() == "admin")

        perms: list[str] = []
        try:
            rel = getattr(colab, "permissoes", None)
            if rel is not None:
                for p in rel:
                    pid = getattr(p, "id", None) or getattr(p, "token", None)
                    if pid:
                        perms.append(pid)
            else:
                rows = db.execute(
                    text(
                        """
                    SELECT permissao_id
                    FROM colaboradores_permissoes
                    WHERE colaborador_id = :cid
                """
                    ),
                    {"cid": colab.id},
                ).fetchall()
                perms = [r[0] for r in rows]
        except Exception as e:
            print("[AUTH] WARN ao carregar permissoes do colaborador:", e)
            perms = []

        return {
            "kind": "colaborador",
            "id": colab.id,
            "empresa_id": colab.empresa_id,
            "nome": colab.nome,
            "email": colab.email,
            "role": colab.cargo or role or "colaborador",
            "is_admin": is_admin,
            "permissoes": perms,
        }

    user = db.query(models.Usuario).filter(models.Usuario.id == int(sub)).first()
    if not user:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Usuário não encontrado")

    perms_admin: list[str] = []
    try:
        rows = db.execute(text("SELECT id FROM permissoes")).fetchall()
        perms_admin = [r[0] for r in rows]
    except Exception as e:
        print("[AUTH] WARN ao carregar permissoes admin:", e)
        perms_admin = []

    return {
        "kind": "usuario",
        "id": user.id,
        "empresa_id": user.empresa_id,
        "nome": user.nome,
        "email": user.email,
        "role": role or "admin",
        "is_admin": True,
        "permissoes": perms_admin,
    }


def require_admin(identity=Depends(get_current_identity)):
    if not identity.get("is_admin"):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Apenas administradores")
    return identity


def get_current_user(
    request: Request,
    authorization: str = Header(default=None, alias="Authorization"),
    db: Session = Depends(get_db_session),
) -> models.Usuario:
    token = _token_from_request(request, authorization)
    if not token:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Não autenticado")

    payload = _decode_token(token)
    sub = payload.get("sub")
    if not sub:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Token inválido")

    if isinstance(sub, str) and sub.startswith("colab-"):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Apenas administradores")

    user = (
        db.query(models.Usuario)
        .filter(models.Usuario.id == int(sub))
        .first()
    )
    if not user:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Usuário não encontrado")
    return user


# ───────────────────────── CSRF (double-submit) ─────────────────────────
def csrf_protect_refresh(
    request: Request,
    csrf_header: str | None = Header(default=None, alias="X-CSRF-Token"),
):
    cookie_val = request.cookies.get(CSRF_COOKIE_NAME)
    if (
        not cookie_val
        or not csrf_header
        or not secrets.compare_digest(cookie_val, csrf_header)
    ):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "CSRF token inválido")
    return True


# ───────────────────────── Rotas ─────────────────────────
@router.get("/me")
def me(identity=Depends(get_current_identity)):
    return identity


@router.get("/readonly")
def readonly_status():
    return {
        "readonly": READONLY_MODE,
        "disable_register": DISABLE_REGISTER,
        "disable_password_recovery": DISABLE_PASSWORD_RECOVERY,
    }


@router.post("/login")
def login(
    form: LoginIn,
    response: Response,
    request: Request,
    db: Session = Depends(get_db_session),
):
    email = norm_email(form.email)
    ip = client_ip_from_headers(
        request.headers, request.client.host if request.client else None
    )

    remain = is_locked(db, email, ip)
    if remain > 0:
        raise HTTPException(
            status_code=429,
            detail="Muitas tentativas. Aguarde para tentar novamente.",
            headers={"Retry-After": str(remain)},
        )

    user = db.query(models.Usuario).filter_by(email=email).first()
    if user and verify_pwd(form.senha, user.senha_hash):
        reset_fail(db, email, ip)
        db.commit()
        token = create_access_token(
            {"sub": str(user.id), "empresa_id": user.empresa_id, "role": "admin"}
        )
        cookie_max_age = JWT_EXP_MINUTES * 60
        if getattr(form, "remember", False):
            cookie_max_age = 60 * 60 * 24 * 30
        set_auth_cookies(
            response,
            request,
            token=token,
            empresa_id=user.empresa_id,
            max_age=cookie_max_age,
        )
        return {
            "access_token": token,
            "empresa_id": user.empresa_id,
            "nome": user.nome,
            "cargo": "admin",
            "is_admin": True,
        }

    colaborador = db.query(models.Colaborador).filter_by(email=email).first()
    if colaborador and verify_pwd(form.senha, colaborador.senha):
        reset_fail(db, email, ip)

        if not colab_login_allowed_now(db, colaborador):
            db.commit()
            raise HTTPException(
                status_code=403,
                detail="Fora do horário permitido de acesso para este colaborador.",
            )

        empresa = (
            db.query(models.Empresa)
            .filter(models.Empresa.id == colaborador.empresa_id)
            .first()
        )
        requer_token = bool(getattr(empresa, "requer_token_login", False)) if empresa else False

        if requer_token:
            codigo = gerar_codigo_login()
            colaborador.login_token = codigo
            colaborador.login_token_expires_at = datetime.utcnow() + timedelta(minutes=10)
            db.commit()

            try:
                admin_user = (
                    db.query(models.Usuario)
                    .filter(
                        models.Usuario.empresa_id == colaborador.empresa_id,
                        models.Usuario.is_admin == True,
                    )
                    .order_by(models.Usuario.id)
                    .first()
                )
                destino = (admin_user.email if admin_user else None) or colaborador.email
                nome_empresa = getattr(empresa, "nome", None) if empresa else None
                enviar_email_login_token(destino, codigo, nome_empresa)
            except Exception as e:
                print("[LOGIN TOKEN EMAIL] erro ao enviar código:", repr(e))

            return {
                "require_token": True,
                "empresa_id": colaborador.empresa_id,
                "email": colaborador.email,
                "mensagem": (
                    "Seu acesso precisa ser liberado com um código enviado por e-mail. "
                    "Solicite o código ao administrador da sua empresa."
                ),
            }

        db.commit()
        token = create_access_token(
            {
                "sub": f"colab-{colaborador.id}",
                "empresa_id": colaborador.empresa_id,
                "role": colaborador.cargo,
            }
        )
        cookie_max_age = JWT_EXP_MINUTES * 60
        if getattr(form, "remember", False):
            cookie_max_age = 60 * 60 * 24 * 30
        set_auth_cookies(
            response,
            request,
            token=token,
            empresa_id=colaborador.empresa_id,
            max_age=cookie_max_age,
        )
        return {
            "access_token": token,
            "empresa_id": colaborador.empresa_id,
            "nome": colaborador.nome,
            "cargo": colaborador.cargo,
            "is_admin": (colaborador.cargo or "").lower() == "admin",
        }

    fails, _window_left = inc_fail(db, email, ip)
    if should_lock(fails):
        apply_lock(db, email, ip, ACCOUNT_LOCK_SEC)
        db.commit()
        raise HTTPException(
            status_code=429,
            detail="Muitas tentativas. Sua conta foi temporariamente bloqueada.",
        )

    db.commit()
    raise HTTPException(status_code=401, detail="Credenciais inválidas")


@router.post("/login/token")
def confirmar_login_token(
    form: LoginTokenIn,
    response: Response,
    request: Request,
    db: Session = Depends(get_db_session),
):
    email = norm_email(form.email)

    colaborador = db.query(models.Colaborador).filter_by(email=email).first()
    if not colaborador:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Credenciais inválidas")

    empresa = (
        db.query(models.Empresa)
        .filter(models.Empresa.id == colaborador.empresa_id)
        .first()
    )
    requer_token = bool(getattr(empresa, "requer_token_login", False)) if empresa else False
    if not requer_token:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "Esta empresa não exige código de acesso adicional.",
        )

    codigo_salvo = getattr(colaborador, "login_token", None)
    expira_em = getattr(colaborador, "login_token_expires_at", None)
    if not codigo_salvo or not expira_em:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "Código inválido ou expirado. Gere um novo tentando entrar novamente.",
        )

    if expira_em.replace(tzinfo=None) < datetime.utcnow():
        colaborador.login_token = None
        colaborador.login_token_expires_at = None
        db.commit()
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "Código expirado. Gere um novo tentando entrar novamente.",
        )

    codigo_informado = (form.token or "").strip()
    if not secrets.compare_digest(str(codigo_salvo), codigo_informado):
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED,
            "Código incorreto.",
        )

    colaborador.login_token = None
    colaborador.login_token_expires_at = None

    if not colab_login_allowed_now(db, colaborador):
        db.commit()
        raise HTTPException(
            status_code=403,
            detail="Fora do horário permitido de acesso para este colaborador.",
        )

    db.commit()

    token = create_access_token(
        {
            "sub": f"colab-{colaborador.id}",
            "empresa_id": colaborador.empresa_id,
            "role": colaborador.cargo,
        }
    )
    cookie_max_age = JWT_EXP_MINUTES * 60
    if getattr(form, "remember", False):
        cookie_max_age = 60 * 60 * 24 * 30

    set_auth_cookies(
        response,
        request,
        token=token,
        empresa_id=colaborador.empresa_id,
        max_age=cookie_max_age,
    )
    return {
        "access_token": token,
        "empresa_id": colaborador.empresa_id,
        "nome": colaborador.nome,
        "cargo": colaborador.cargo,
        "is_admin": (colaborador.cargo or "").lower() == "admin",
    }


@router.post("/logout")
def logout(response: Response, request: Request):
    clear_auth_cookies(response, request)
    return {"msg": "Desconectado com sucesso"}


@router.post("/refresh", dependencies=[Depends(csrf_protect_refresh)])
def refresh_token(
    request: Request,
    response: Response,
    authorization: str = Header(default=None, alias="Authorization"),
):
    token = _token_from_request(request, authorization)
    if not token:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Não autenticado")

    payload = _decode_token(token)
    sub = payload.get("sub")
    empresa_id = payload.get("empresa_id")
    role = payload.get("role")

    if not sub or not empresa_id:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Token inválido")

    new_token = create_access_token({"sub": sub, "empresa_id": empresa_id, "role": role})
    set_auth_cookies(
        response,
        request,
        token=new_token,
        empresa_id=int(empresa_id),
        max_age=JWT_EXP_MINUTES * 60,
    )
    exp_ts = int((datetime.utcnow() + timedelta(minutes=JWT_EXP_MINUTES)).timestamp())
    return {"access_token": new_token, "exp": exp_ts}


@router.post("/cookieize")
def cookieize(
    request: Request,
    response: Response,
    authorization: str = Header(default=None, alias="Authorization"),
):
    token = _token_from_request(request, authorization)
    if not token:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "Faltou Authorization Bearer ou cookie de token",
        )

    payload = _decode_token(token)
    empresa_id = payload.get("empresa_id")
    if not empresa_id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Token sem empresa_id")

    set_auth_cookies(
        response,
        request,
        token=token,
        empresa_id=int(empresa_id),
        max_age=JWT_EXP_MINUTES * 60,
    )
    return {"ok": True, "empresa_id": empresa_id}


@router.post("/criar-empresa")
def register(
    dados: RegisterIn,
    request: Request,
    response: Response,
    db: Session = Depends(get_db_session),
    _: Depends = Depends(guard_writable_register),
):
    tel_limpo = "".join(c for c in dados.telefone if c.isdigit())
    doc_limpo = "".join(c for c in (dados.doc or "") if c.isdigit())
    try:
        if db.query(models.Usuario).filter_by(email=dados.email_admin).first():
            raise HTTPException(status_code=400, detail="E-mail já está em uso")
        if db.query(models.Empresa).filter_by(telefone=tel_limpo).first():
            raise HTTPException(status_code=400, detail="Telefone já está em uso")

        if doc_limpo and (len(doc_limpo) not in (11, 14)):
            raise HTTPException(
                status_code=400,
                detail="Documento deve ter 11 (CPF) ou 14 (CNPJ) dígitos.",
            )

        if doc_limpo:
            ja = db.query(models.Empresa).filter_by(cnpj_cpf=doc_limpo).first()
            if ja:
                raise HTTPException(
                    status_code=400,
                    detail="Documento já cadastrado para outra empresa.",
                )

        empresa = models.Empresa(
            nome=dados.nome,
            telefone=tel_limpo,
            cnpj_cpf=doc_limpo or None,
        )

        if hasattr(empresa, "assinatura"):
            empresa.assinatura = PLAN_FREE

        if hasattr(empresa, "trial_tier") and hasattr(empresa, "trial_expires_at"):
            start_start_trial(empresa, days=TRIAL_DAYS)
        else:
            if hasattr(empresa, "trial_tier"):
                empresa.trial_tier = PLAN_START
            if hasattr(empresa, "trial_expires_at"):
                empresa.trial_expires_at = datetime.utcnow() + timedelta(days=TRIAL_DAYS)

        db.add(empresa)
        db.flush()

        if hasattr(empresa, "nome_adm") and dados.nome_adm:
            empresa.nome_adm = dados.nome_adm.strip()

        for nome_setor in ["Atendimento", "Comercial", "Financeiro", "Suporte Técnico"]:
            db.add(models.Setor(nome=nome_setor, empresa_id=empresa.id))

        usuario = models.Usuario(
            nome=(dados.nome_adm or "Admin").strip(),
            email=dados.email_admin,
            senha_hash=hash_pwd(dados.senha_admin),
            empresa_id=empresa.id,
            is_admin=True,
        )
        db.add(usuario)
        db.flush()

        if dados.avatar_url:
            try:
                if dados.avatar_url.startswith("data:"):
                    mime, raw = data_url_to_bytes(dados.avatar_url)
                    if len(raw) > 2 * 1024 * 1024:
                        raise ValueError("Imagem muito grande (>2MB)")
                    if hasattr(usuario, "avatar_mime"):
                        usuario.avatar_mime = mime
                    if hasattr(usuario, "avatar_data"):
                        usuario.avatar_data = raw
                elif dados.avatar_url.startswith(("http://", "https://")) and hasattr(empresa, "avatar_url"):
                    empresa.avatar_url = dados.avatar_url
            except Exception as e:
                print("[AVATAR WARN]", e)

        try:
            dep_padrao_nome = "Geral"
            dep_padrao = (
                db.query(models.Departamento)
                .filter_by(empresa_id=empresa.id, nome=dep_padrao_nome)
                .first()
            )
            if not dep_padrao:
                dep_padrao = models.Departamento(
                    empresa_id=empresa.id,
                    nome=dep_padrao_nome,
                    descricao="Departamento padrão criado automaticamente",
                )
                if hasattr(models.Departamento, "ativo"):
                    setattr(dep_padrao, "ativo", True)
                if hasattr(models.Departamento, "codigo"):
                    setattr(dep_padrao, "codigo", "GERAL")
                db.add(dep_padrao)
                db.flush()
        except Exception as e:
            print("[DEPARTAMENTO WARN]", e)

        try:
            from backend.routers.permissoes import _sync_catalog_to_db
            _sync_catalog_to_db(db)
        except Exception as e:
            print("[PERMISSOES WARN]", e)

        commit_or_block(db)

        created_at_formatado = None
        try:
            tz_sp = pytz.timezone("America/Sao_Paulo")
            created_at_formatado = empresa.created_at.astimezone(tz_sp).strftime("%d/%m/%Y %H:%M")
        except Exception:
            try:
                created_at_formatado = empresa.created_at.strftime("%d/%m/%Y %H:%M")
            except Exception:
                created_at_formatado = None

        token = create_access_token({"sub": str(usuario.id), "empresa_id": empresa.id, "role": "admin"})
        set_auth_cookies(
            response,
            request,
            token=token,
            empresa_id=empresa.id,
            max_age=JWT_EXP_MINUTES * 60,
        )
        return {
            "access_token": token,
            "empresa_id": empresa.id,
            "empresa_nome": empresa.nome,
            "nome": usuario.nome,
            "email": usuario.email,
            "is_admin": True,
            "created_at": created_at_formatado,
            "assinatura": normalize_plan(empresa.assinatura),
            "trial_tier": normalize_plan(getattr(empresa, "trial_tier", None))
            if getattr(empresa, "trial_tier", None)
            else None,
            "trial_expires_at": getattr(empresa, "trial_expires_at", None).isoformat()
            if getattr(empresa, "trial_expires_at", None)
            else None,
        }

    except HTTPException:
        raise
    except Exception as e:
        try:
            db.rollback()
        except Exception:
            pass
        raise HTTPException(status_code=500, detail="Erro interno: " + str(e))


@router.post("/forgot-password")
def forgot_password(
    dados: ForgotPasswordIn,
    request: Request,
    db: Session = Depends(get_db_session),
    _: Depends = Depends(guard_writable_recovery),
):
    email_norm = norm_email(dados.email)
    ip = _client_ip(request)

    k1 = f"forgot:email:{_safe_email_key(email_norm)}"
    k2 = f"forgot:ip:{ip}"
    if not _rate_take(_forgot_rate, k1, FORGOT_MAX_REQ, FORGOT_WINDOW_SEC) or not _rate_take(_forgot_rate, k2, FORGOT_MAX_REQ, FORGOT_WINDOW_SEC):
        wait = max(_rate_remaining(_forgot_rate, k1), _rate_remaining(_forgot_rate, k2))
        raise HTTPException(
            status_code=429,
            detail="Muitas solicitações de recuperação. Aguarde alguns minutos e tente novamente.",
            headers={"Retry-After": str(wait)},
        )

    print(f"[LOG] Requisição forgot-password recebida: {email_norm}")
    usuario = db.query(models.Usuario).filter_by(email=email_norm).first()
    if not usuario:
        print("[LOG] Usuário não encontrado para:", email_norm)
        raise HTTPException(status_code=404, detail="Usuário não encontrado")

    token = None
    for _ in range(10):
        c = gerar_codigo_reset_5d()
        existe = db.query(models.Usuario).filter_by(reset_token=c).first()
        if not existe:
            token = c
            break
    if not token:
        raise HTTPException(status_code=500, detail="Erro ao gerar código. Tente novamente.")

    usuario.reset_token = token
    usuario.reset_token_expira = datetime.utcnow() + timedelta(minutes=RESET_CODE_TTL_MIN)
    commit_or_block(db)

    print(f"[LOG] Token gerado (5 dígitos): {token} (expira em {RESET_CODE_TTL_MIN} min)")
    enviar_email_reset(email_norm, token)

    return {"detail": "Token enviado para o e-mail informado."}


@router.post("/reset-password")
def reset_password(
    dados: ResetPasswordIn,
    request: Request,
    db: Session = Depends(get_db_session),
    _: Depends = Depends(guard_writable_recovery),
):
    token_in = (dados.token or "").strip()
    ip = _client_ip(request)

    k_ip = f"reset:ip:{ip}"
    k_tok = f"reset:tok:{token_in}"
    if not _rate_take(_reset_attempts, k_ip, RESET_MAX_ATTEMPTS, RESET_ATTEMPT_WINDOW_SEC) or not _rate_take(_reset_attempts, k_tok, RESET_MAX_ATTEMPTS, RESET_ATTEMPT_WINDOW_SEC):
        wait = max(_rate_remaining(_reset_attempts, k_ip), _rate_remaining(_reset_attempts, k_tok))
        raise HTTPException(
            status_code=429,
            detail="Muitas tentativas de redefinição. Aguarde alguns minutos e tente novamente.",
            headers={"Retry-After": str(wait)},
        )

    print(f"[LOG] Requisição reset-password recebida: token={token_in}")

    usuario = db.query(models.Usuario).filter_by(reset_token=token_in).first()
    if not usuario:
        print("[LOG] Token não encontrado")
        raise HTTPException(status_code=400, detail="Token inválido ou expirado")

    expira = getattr(usuario, "reset_token_expira", None)
    if not expira or expira.replace(tzinfo=None) < datetime.utcnow():
        print("[LOG] Token expirado")
        raise HTTPException(status_code=400, detail="Token inválido ou expirado")

    usuario.senha_hash = hash_pwd(dados.nova_senha)
    usuario.reset_token = None
    usuario.reset_token_expira = None
    commit_or_block(db)

    print(f"[LOG] Senha redefinida com sucesso para usuário ID={usuario.id}")
    return {"detail": "Senha redefinida com sucesso!"}