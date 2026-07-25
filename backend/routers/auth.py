from datetime import datetime, timedelta
import os
import time
import smtplib
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from email.utils import formataddr
import base64
import re
import secrets
from typing import Any, Optional

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
from sqlalchemy import text, func, or_, and_
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

ENV = (os.getenv("ENV") or os.getenv("APP_ENV") or "dev").strip().lower()
IS_PROD = ENV in ("prod", "production")

# Conta usada pelos fluxos de recuperação de senha/login.
# As variáveis antigas continuam como fallback para não quebrar instalações existentes.
EMAIL_RECUPERACAO_REMETENTE = (
    os.getenv("EMAIL_RECUPERACAO_REMETENTE")
    or os.getenv("EMAIL_REMETENTE")
    or "recuperaZapsChat@gmail.com"
).strip()
EMAIL_RECUPERACAO_SENHA = (
    os.getenv("EMAIL_RECUPERACAO_SENHA")
    or os.getenv("EMAIL_SENHA")
    or ""
).strip()
EMAIL_RECUPERACAO_NOME_REMETENTE = (
    os.getenv("EMAIL_RECUPERACAO_NOME_REMETENTE")
    or os.getenv("EMAIL_NOME_REMETENTE")
    or "ZapsChat"
).strip()

# Aliases legados usados internamente pelo fluxo de recuperação.
EMAIL_REMETENTE = EMAIL_RECUPERACAO_REMETENTE
EMAIL_SENHA = EMAIL_RECUPERACAO_SENHA
EMAIL_NOME_REMETENTE = EMAIL_RECUPERACAO_NOME_REMETENTE

SMTP_HOST = os.getenv("SMTP_HOST", "smtp.gmail.com").strip() or "smtp.gmail.com"
SMTP_PORT = int(os.getenv("SMTP_PORT", "465"))
SMTP_TIMEOUT = int(os.getenv("SMTP_TIMEOUT", "20"))
SMTP_USE_SSL = (
    os.getenv("SMTP_USE_SSL", "true").strip().lower()
    in ("1", "true", "yes", "on")
)
SMTP_STARTTLS = (
    os.getenv("SMTP_STARTTLS", "false").strip().lower()
    in ("1", "true", "yes", "on")
)

JWT_SECRET = os.getenv("JWT_SECRET", "").strip()
if not JWT_SECRET:
    if IS_PROD:
        raise RuntimeError("JWT_SECRET não configurado em produção.")
    JWT_SECRET = "dev-insecure-change-me"

JWT_EXP_MINUTES = int(os.getenv("JWT_EXP_MINUTES", str(60 * 24)))  # fallback 24h
ALGORITHM = "HS256"

TRIAL_DAYS = int(os.getenv("TRIAL_DAYS", "14"))  # 14 por padrão

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
FORCE_PASSWORD_CHANGE_MARKER = "FORCE_PASS_CHANGE"

# Memória local
_forgot_rate: dict[str, list[float]] = {}
_reset_attempts: dict[str, list[float]] = {}


# ───────────────────────── Helpers gerais ─────────────────────────
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
            request.client.host if request.client else None,
        ) or "0.0.0.0"
    except Exception:
        return request.client.host if request.client else "0.0.0.0"


def _get_attr(obj: Any, *names: str, default: Any = None) -> Any:
    for name in names:
        try:
            if isinstance(obj, dict) and obj.get(name) is not None:
                return obj.get(name)
        except Exception:
            pass

        try:
            value = getattr(obj, name, None)
            if value is not None:
                return value
        except Exception:
            pass

    return default


def _bool_attr(obj: Any, *names: str, default: bool = True) -> bool:
    for name in names:
        if hasattr(obj, name):
            try:
                return bool(getattr(obj, name))
            except Exception:
                return default
    return default


def _is_active_obj(obj: Any) -> bool:
    if obj is None:
        return False

    for attr in ("is_active", "ativo", "active"):
        if hasattr(obj, attr):
            try:
                return bool(getattr(obj, attr))
            except Exception:
                return True

    if hasattr(obj, "status"):
        try:
            s = str(getattr(obj, "status") or "").strip().lower()
            if s in ("inativo", "inactive", "bloqueado", "blocked", "cancelado", "cancelled"):
                return False
        except Exception:
            return True

    return True




def _usuario_is_admin(user: Any) -> bool:
    """Retorna True somente para usuários administrativos reais.

    Importante: colaborador criado em /colaboradores também pode ter registro
    em usuarios para login, mas deve continuar is_admin=False.
    """
    try:
        return bool(getattr(user, "is_admin", False))
    except Exception:
        return False

def _mask_secret(v: str | None) -> str:
    if not v:
        return ""
    s = str(v)
    if len(s) <= 8:
        return "***"
    return s[:4] + "..." + s[-4:]


def _find_usuario_by_email(db: Session, email: str) -> Optional["models.Usuario"]:
    return (
        db.query(models.Usuario)
        .filter(func.lower(models.Usuario.email) == func.lower(email))
        .first()
    )


def _find_colaborador_by_email(db: Session, email: str) -> Optional["models.Colaborador"]:
    return (
        db.query(models.Colaborador)
        .filter(func.lower(models.Colaborador.email) == func.lower(email))
        .first()
    )


def _ensure_empresa_exists_and_active(db: Session, empresa_id: Any) -> "models.Empresa":
    try:
        eid = int(empresa_id)
    except Exception:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Empresa inválida")

    empresa = db.query(models.Empresa).filter(models.Empresa.id == eid).first()
    if not empresa:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Empresa não encontrada")

    if not _is_active_obj(empresa):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Empresa inativa ou bloqueada")

    return empresa


def _get_departamento_login_window(
    db: Session,
    colab: "models.Colaborador",
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
    if modo in (
        "padrao",
        "padrão",
        "dept",
        "depto",
        "departamento_padrao",
        "departamento-padrao",
    ):
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


# ───────────────────────── Helpers admin <-> colaborador ─────────────────────────
def _first_setor_empresa(db: Session, empresa_id: int) -> Optional[int]:
    try:
        row = (
            db.query(models.Setor)
            .filter(models.Setor.empresa_id == int(empresa_id))
            .order_by(models.Setor.id.asc())
            .first()
        )
        return int(row.id) if row else None
    except Exception:
        return None


def _ensure_admin_colaborador(
    db: Session,
    user: "models.Usuario",
) -> Optional["models.Colaborador"]:
    """
    Garante colaborador operacional somente para usuário admin real.

    Colaboradores comuns também podem ter registro em usuarios para login,
    mas NUNCA podem cair neste fluxo, senão viram admin e podem ser recriados
    após exclusão.
    """
    if not user or not getattr(user, "empresa_id", None):
        return None

    if not _usuario_is_admin(user):
        return None

    colab = None

    try:
        if hasattr(models.Colaborador, "usuario_id"):
            colab = (
                db.query(models.Colaborador)
                .filter(models.Colaborador.usuario_id == int(user.id))
                .first()
            )
    except Exception:
        colab = None

    if not colab:
        try:
            colab = (
                db.query(models.Colaborador)
                .filter(
                    models.Colaborador.empresa_id == int(user.empresa_id),
                    func.lower(models.Colaborador.email) == func.lower(str(user.email)),
                )
                .first()
            )
        except Exception:
            colab = None

        if (
            colab
            and hasattr(colab, "usuario_id")
            and getattr(colab, "usuario_id", None) in (None, int(user.id))
        ):
            colab.usuario_id = int(user.id)

    if not colab:
        setor_id = _first_setor_empresa(db, int(user.empresa_id))

        colab_kwargs = {
            "empresa_id": int(user.empresa_id),
            "setor_id": setor_id,
            "nome": (user.nome or "Administrador").strip(),
            "email": (user.email or "").strip().lower(),
            "senha": user.senha_hash,
            "cargo": "Administrador",
            "telefone": None,
        }

        if hasattr(models.Colaborador, "usuario_id"):
            colab_kwargs["usuario_id"] = int(user.id)

        colab = models.Colaborador(**colab_kwargs)
        db.add(colab)
        db.flush()

    changed = False

    nome_user = (user.nome or "Administrador").strip()
    email_user = (user.email or "").strip().lower()

    if getattr(colab, "empresa_id", None) != int(user.empresa_id):
        colab.empresa_id = int(user.empresa_id)
        changed = True

    if hasattr(colab, "usuario_id") and getattr(colab, "usuario_id", None) != int(user.id):
        colab.usuario_id = int(user.id)
        changed = True

    if (getattr(colab, "nome", None) or "").strip() != nome_user:
        colab.nome = nome_user
        changed = True

    if (getattr(colab, "email", None) or "").strip().lower() != email_user:
        colab.email = email_user
        changed = True

    # Mantém um cargo legível no cadastro, mas admin real vem de usuarios.is_admin.
    if (getattr(colab, "cargo", None) or "").strip().lower() in ("", "admin"):
        colab.cargo = "Administrador"
        changed = True

    if getattr(colab, "senha", None) != user.senha_hash:
        colab.senha = user.senha_hash
        changed = True

    if changed:
        db.add(colab)
        db.flush()

    return colab


def _admin_token_payload(db: Session, user: "models.Usuario") -> dict:
    colab = _ensure_admin_colaborador(db, user)
    colab_id = int(colab.id) if colab else None

    return {
        "sub": str(user.id),
        "empresa_id": int(user.empresa_id),
        "role": "admin",
        "usuario_id": int(user.id),
        "colaborador_id": colab_id,
        "id_colab": colab_id,
        "id_colaborador": colab_id,
        "colab_id": colab_id,
        "cid": colab_id,
    }


def _colab_token_payload(colaborador: "models.Colaborador") -> dict:
    colab_id = int(colaborador.id)
    empresa_id = int(colaborador.empresa_id)
    role = (getattr(colaborador, "cargo", None) or "colaborador").strip() or "colaborador"

    # Segurança: cargo textual não pode virar papel administrativo no token.
    if role.lower() in ("admin", "administrador", "owner", "dono", "root"):
        role = "colaborador"

    return {
        "sub": f"colab-{colab_id}",
        "empresa_id": empresa_id,
        "role": role,
        "is_admin": False,
        "usuario_id": getattr(colaborador, "usuario_id", None),
        "colaborador_id": colab_id,
        "id_colab": colab_id,
        "id_colaborador": colab_id,
        "colab_id": colab_id,
        "cid": colab_id,
    }


# ───────────────────────── Helpers de Cookie ─────────────────────────
def _is_https(request: Request) -> bool:
    proto = (request.headers.get("x-forwarded-proto") or request.url.scheme or "").lower()
    return proto == "https"


def _cookie_base(request: Request, max_age: Optional[int] = None) -> dict:
    same_site = "none" if COOKIE_SAMESITE == "none" else "lax"

    secure = COOKIE_SECURE or _is_https(request)
    if same_site == "none":
        secure = True

    params = {
        "secure": secure,
        "samesite": same_site,
        "path": "/",
        "domain": COOKIE_DOMAIN or None,
    }

    if max_age is not None:
        params["max_age"] = max_age

    return params


def _new_csrf_token() -> str:
    return secrets.token_urlsafe(32)


def set_auth_cookies(
    response: Response,
    request: Request,
    *,
    token: str,
    empresa_id: int,
    max_age: int,
) -> str:
    base = _cookie_base(request, max_age=max_age)

    response.set_cookie(
        key=ACCESS_COOKIE_NAME,
        value=token,
        httponly=True,
        **base,
    )

    # Cookie legível pelo front apenas para compatibilidade visual/cliente.
    # Segurança real SEMPRE vem do token/identity no backend.
    response.set_cookie(
        key="empresa_id",
        value=str(empresa_id),
        httponly=False,
        **base,
    )

    csrf_token = _new_csrf_token()
    response.set_cookie(
        key=CSRF_COOKIE_NAME,
        value=csrf_token,
        httponly=False,
        **base,
    )

    return csrf_token


def clear_auth_cookies(response: Response, request: Request):
    base = _cookie_base(request, max_age=0)
    domain = base.get("domain")

    response.delete_cookie(key=ACCESS_COOKIE_NAME, path="/", domain=domain)
    response.delete_cookie(key="empresa_id", path="/", domain=domain)
    response.delete_cookie(key=CSRF_COOKIE_NAME, path="/", domain=domain)


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
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "Somente leitura (manutenção).",
        )
    db.commit()


# ───────────────────────── Schemas ─────────────────────────
class ForgotPasswordIn(BaseModel):
    email: EmailStr


class ResetPasswordIn(BaseModel):
    token: str
    nova_senha: str
    email: EmailStr | None = None


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
class EmailDeliveryError(RuntimeError):
    """Falha de configuração, autenticação ou entrega do e-mail."""

    def __init__(self, public_message: str, *, code: str = "email_delivery_failed"):
        super().__init__(public_message)
        self.public_message = public_message
        self.code = code


def _smtp_password(
    password_value: Optional[str] = None,
    smtp_host: Optional[str] = None,
) -> str:
    password = str(
        EMAIL_SENHA if password_value is None else password_value
    ).strip()
    host = str(smtp_host or SMTP_HOST or "").strip().lower()

    # O Google exibe senhas de app em quatro blocos. Se ela tiver sido copiada
    # com espaços, o login SMTP falha mesmo que a senha esteja correta.
    if host.endswith("gmail.com"):
        compact = re.sub(r"\s+", "", password)
        if len(compact) == 16 and compact.isalnum():
            return compact

    return password


def _smtp_send(
    email_destino: str,
    assunto: str,
    corpo: str,
    *,
    remetente: Optional[str] = None,
    senha: Optional[str] = None,
    nome_remetente: Optional[str] = None,
    corpo_html: Optional[str] = None,
) -> None:
    destino = str(email_destino or "").strip()
    remetente_final = str(
        EMAIL_REMETENTE if remetente is None else remetente
    ).strip()
    senha_final = _smtp_password(
        EMAIL_SENHA if senha is None else senha,
        SMTP_HOST,
    )
    nome_remetente_final = str(
        EMAIL_NOME_REMETENTE if nome_remetente is None else nome_remetente
    ).strip() or "ZapsChat"

    if not destino:
        raise EmailDeliveryError(
            "O e-mail do destinatário não foi informado.",
            code="missing_recipient",
        )

    if not remetente_final or not senha_final:
        raise EmailDeliveryError(
            "O envio de e-mails ainda não está configurado no servidor.",
            code="email_not_configured",
        )

    if corpo_html:
        # multipart/alternative mantém uma versão simples para clientes antigos
        # e entrega o layout HTML nos clientes modernos, como Gmail e Outlook.
        msg = MIMEMultipart("alternative")
        msg.attach(MIMEText(corpo, "plain", "utf-8"))
        msg.attach(MIMEText(corpo_html, "html", "utf-8"))
    else:
        msg = MIMEText(corpo, "plain", "utf-8")

    msg["Subject"] = assunto
    msg["From"] = formataddr((nome_remetente_final, remetente_final))
    msg["To"] = destino

    try:
        print(f"[EMAIL] Conectando em {SMTP_HOST}:{SMTP_PORT}...")

        if SMTP_USE_SSL:
            server_ctx = smtplib.SMTP_SSL(
                SMTP_HOST,
                SMTP_PORT,
                timeout=SMTP_TIMEOUT,
            )
        else:
            server_ctx = smtplib.SMTP(
                SMTP_HOST,
                SMTP_PORT,
                timeout=SMTP_TIMEOUT,
            )

        with server_ctx as server:
            if SMTP_STARTTLS and not SMTP_USE_SSL:
                server.ehlo()
                server.starttls()
                server.ehlo()

            server.login(remetente_final, senha_final)
            recusados = server.sendmail(
                remetente_final,
                [destino],
                msg.as_string(),
            )

            if recusados:
                raise EmailDeliveryError(
                    "O servidor de e-mail recusou o destinatário informado.",
                    code="recipient_rejected",
                )

        print(f"[EMAIL] Enviado com sucesso para {destino}")
    except EmailDeliveryError:
        raise
    except smtplib.SMTPAuthenticationError as exc:
        print("[ERRO EMAIL] Falha de autenticação SMTP:", repr(exc))
        raise EmailDeliveryError(
            "O servidor recusou o login do e-mail remetente. Confira a senha de aplicativo configurada.",
            code="smtp_auth_failed",
        ) from exc
    except smtplib.SMTPRecipientsRefused as exc:
        print("[ERRO EMAIL] Destinatário recusado:", repr(exc))
        raise EmailDeliveryError(
            "O servidor de e-mail recusou o endereço do colaborador.",
            code="recipient_rejected",
        ) from exc
    except (smtplib.SMTPException, OSError, TimeoutError) as exc:
        import traceback

        print("[ERRO EMAIL]", repr(exc))
        traceback.print_exc()
        raise EmailDeliveryError(
            "Não foi possível conectar ao servidor de e-mail. Tente novamente em alguns instantes.",
            code="smtp_unavailable",
        ) from exc


def gerar_codigo_reset_5d() -> str:
    return f"{secrets.randbelow(90000) + 10000:05d}"


def _unique_reset_token(db: Session) -> str:
    for _ in range(10):
        token = gerar_codigo_reset_5d()
        exists = db.query(models.Usuario).filter_by(reset_token=token).first()
        if not exists:
            return token

    raise HTTPException(status_code=500, detail="Erro ao gerar código. Tente novamente.")


def _ensure_user_reset_token(db: Session, usuario: "models.Usuario") -> str:
    expira = getattr(usuario, "reset_token_expira", None)
    token_atual = getattr(usuario, "reset_token", None)

    if token_atual and expira and expira.replace(tzinfo=None) > datetime.utcnow():
        return str(token_atual)

    token = _unique_reset_token(db)
    usuario.reset_token = token
    usuario.reset_token_expira = datetime.utcnow() + timedelta(minutes=RESET_CODE_TTL_MIN)
    db.add(usuario)
    db.flush()
    return token


def enviar_email_reset(email_destino: str, token: str):
    assunto = "[ZapsChat] Código para redefinir sua senha"
    corpo = f"""
Olá,

Recebemos uma solicitação para redefinir a senha da conta ZapsChat associada a este e-mail.

Seu código de redefinição é:

    {token}

Por motivos de segurança, este código é válido por um período limitado.
Se você não fez esta solicitação, pode ignorar este e-mail.

Atenciosamente,
Equipe ZapsChat
"""
    _smtp_send(email_destino, assunto, corpo)


def gerar_codigo_login() -> str:
    return f"{secrets.randbelow(900000) + 100000:06d}"


def enviar_email_login_token(
    email_destino: str,
    codigo: str,
    nome_empresa: Optional[str] = None,
):
    prefixo = f"[{nome_empresa}] " if nome_empresa else ""
    assunto = f"{prefixo}Código de acesso ao ZapsChat"

    corpo = f"""
Olá,

Seu código de acesso é:

    {codigo}

Digite esse código na tela de login do ZapsChat para concluir o acesso.
Por segurança, este código expira em poucos minutos e só deve ser usado por você.

Se você não está tentando acessar o sistema, ignore este e-mail.

Atenciosamente,
Equipe ZapsChat
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

        if not _is_active_obj(colab):
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Colaborador inativo ou bloqueado")

        _ensure_empresa_exists_and_active(db, colab.empresa_id)

        if not colab_login_allowed_now(db, colab):
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                "Fora do horário permitido de acesso para este colaborador.",
            )

        is_admin = False
        role_safe = (colab.cargo or role or "colaborador").strip() or "colaborador"
        if role_safe.lower() in ("admin", "administrador", "owner", "dono", "root"):
            role_safe = "colaborador"

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
            "id_colab": colab.id,
            "colaborador_id": colab.id,
            "id_colaborador": colab.id,
            "colab_id": colab.id,
            "cid": colab.id,
            "usuario_id": getattr(colab, "usuario_id", None),
            "empresa_id": colab.empresa_id,
            "nome": colab.nome,
            "email": colab.email,
            "role": role_safe,
            "is_admin": is_admin,
            "permissoes": perms,
        }

    try:
        user_id = int(sub)
    except Exception:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Token inválido")

    user = db.query(models.Usuario).filter(models.Usuario.id == user_id).first()
    if not user:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Usuário não encontrado")

    if not _is_active_obj(user):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Usuário inativo ou bloqueado")

    if not _usuario_is_admin(user):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Este usuário não é administrador. Faça login como colaborador.")

    _ensure_empresa_exists_and_active(db, user.empresa_id)

    try:
        admin_colab = _ensure_admin_colaborador(db, user)
        db.commit()
    except Exception as e:
        try:
            db.rollback()
        except Exception:
            pass
        print("[AUTH] ERRO ao garantir colaborador do admin:", repr(e))
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "Seu login admin não conseguiu ser vinculado ao colaborador operacional desta empresa.",
        )

    perms_admin: list[str] = []
    try:
        rows = db.execute(text("SELECT id FROM permissoes")).fetchall()
        perms_admin = [r[0] for r in rows]
    except Exception as e:
        print("[AUTH] WARN ao carregar permissoes admin:", e)
        perms_admin = []

    colab_id = int(admin_colab.id) if admin_colab else None

    return {
        "kind": "usuario",
        "id": user.id,
        "usuario_id": user.id,
        "id_colab": colab_id,
        "colaborador_id": colab_id,
        "id_colaborador": colab_id,
        "colab_id": colab_id,
        "cid": colab_id,
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


def get_empresa_id(identity=Depends(get_current_identity)) -> int:
    """
    Helper seguro para rotas multiempresa.

    Use isto nas rotas em vez de confiar no empresa_id vindo do frontend.
    """
    empresa_id = identity.get("empresa_id")
    try:
        empresa_id = int(empresa_id)
    except Exception:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Empresa inválida na sessão")

    if empresa_id <= 0:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Empresa inválida na sessão")

    return empresa_id


def get_colaborador_id(identity=Depends(get_current_identity)) -> Optional[int]:
    cid = (
        identity.get("colaborador_id")
        or identity.get("id_colab")
        or identity.get("id_colaborador")
        or identity.get("colab_id")
        or identity.get("cid")
    )
    try:
        return int(cid) if cid is not None else None
    except Exception:
        return None


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

    try:
        user_id = int(sub)
    except Exception:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Token inválido")

    user = db.query(models.Usuario).filter(models.Usuario.id == user_id).first()
    if not user:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Usuário não encontrado")

    if not _is_active_obj(user):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Usuário inativo ou bloqueado")

    if not _usuario_is_admin(user):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Apenas administradores")

    _ensure_empresa_exists_and_active(db, user.empresa_id)

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
        request.headers,
        request.client.host if request.client else None,
    )

    remain = is_locked(db, email, ip)
    if remain > 0:
        raise HTTPException(
            status_code=429,
            detail="Muitas tentativas. Aguarde para tentar novamente.",
            headers={"Retry-After": str(remain)},
        )

    user = _find_usuario_by_email(db, email)
    if user and _usuario_is_admin(user) and _is_active_obj(user) and verify_pwd(form.senha, user.senha_hash):
        reset_fail(db, email, ip)

        _ensure_empresa_exists_and_active(db, user.empresa_id)

        try:
            admin_colab = _ensure_admin_colaborador(db, user)
        except Exception as e:
            try:
                db.rollback()
            except Exception:
                pass
            print("[LOGIN ADMIN] erro ao garantir colaborador:", repr(e))
            raise HTTPException(
                status_code=409,
                detail="Não foi possível vincular seu login admin ao colaborador operacional da empresa.",
            )

        db.commit()

        token = create_access_token(_admin_token_payload(db, user))
        cookie_max_age = JWT_EXP_MINUTES * 60
        if getattr(form, "remember", False):
            cookie_max_age = 60 * 60 * 24 * 30

        csrf_token = set_auth_cookies(
            response,
            request,
            token=token,
            empresa_id=user.empresa_id,
            max_age=cookie_max_age,
        )
        return {
            "access_token": token,
            "csrf_token": csrf_token,
            "empresa_id": user.empresa_id,
            "nome": user.nome,
            "cargo": "Administrador",
            "is_admin": True,
            "colaborador_id": int(admin_colab.id) if admin_colab else None,
        }

    colaborador = _find_colaborador_by_email(db, email)
    if colaborador and _is_active_obj(colaborador) and verify_pwd(form.senha, colaborador.senha):
        reset_fail(db, email, ip)

        _ensure_empresa_exists_and_active(db, colaborador.empresa_id)

        if str(getattr(colaborador, "login_token", "") or "") == FORCE_PASSWORD_CHANGE_MARKER:
            usuario_vinculado = None

            if getattr(colaborador, "usuario_id", None):
                usuario_vinculado = (
                    db.query(models.Usuario)
                    .filter(models.Usuario.id == int(colaborador.usuario_id))
                    .first()
                )

            if not usuario_vinculado:
                usuario_vinculado = (
                    db.query(models.Usuario)
                    .filter(
                        models.Usuario.empresa_id == int(colaborador.empresa_id),
                        func.lower(models.Usuario.email) == func.lower(str(colaborador.email)),
                    )
                    .first()
                )

            if usuario_vinculado:
                token_reset = _ensure_user_reset_token(db, usuario_vinculado)
                db.commit()
                try:
                    enviar_email_reset(
                        str(getattr(usuario_vinculado, "email", None) or colaborador.email).lower().strip(),
                        token_reset,
                    )
                except Exception as e:
                    print("[LOGIN FORCE CHANGE EMAIL] erro ao enviar código:", repr(e))
            else:
                db.commit()

            raise HTTPException(
                status_code=403,
                detail={
                    "force_password_change": True,
                    "message": "Por segurança, troque sua senha inicial antes de acessar.",
                    "email": colaborador.email,
                },
            )

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
                        models.Usuario.is_admin == True,  # noqa: E712
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

        token = create_access_token(_colab_token_payload(colaborador))
        cookie_max_age = JWT_EXP_MINUTES * 60
        if getattr(form, "remember", False):
            cookie_max_age = 60 * 60 * 24 * 30

        csrf_token = set_auth_cookies(
            response,
            request,
            token=token,
            empresa_id=colaborador.empresa_id,
            max_age=cookie_max_age,
        )
        return {
            "access_token": token,
            "csrf_token": csrf_token,
            "empresa_id": colaborador.empresa_id,
            "nome": colaborador.nome,
            "cargo": colaborador.cargo,
            "is_admin": False,
            "colaborador_id": colaborador.id,
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

    colaborador = _find_colaborador_by_email(db, email)
    if not colaborador or not _is_active_obj(colaborador):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Credenciais inválidas")

    _ensure_empresa_exists_and_active(db, colaborador.empresa_id)

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

    token = create_access_token(_colab_token_payload(colaborador))
    cookie_max_age = JWT_EXP_MINUTES * 60
    if getattr(form, "remember", False):
        cookie_max_age = 60 * 60 * 24 * 30

    csrf_token = set_auth_cookies(
        response,
        request,
        token=token,
        empresa_id=colaborador.empresa_id,
        max_age=cookie_max_age,
    )
    return {
        "access_token": token,
        "csrf_token": csrf_token,
        "empresa_id": colaborador.empresa_id,
        "nome": colaborador.nome,
        "cargo": colaborador.cargo,
        "is_admin": False,
        "colaborador_id": colaborador.id,
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
    db: Session = Depends(get_db_session),
):
    token = _token_from_request(request, authorization)
    if not token:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Não autenticado")

    payload = _decode_token(token)
    sub = payload.get("sub")

    if not sub:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Token inválido")

    if isinstance(sub, str) and sub.startswith("colab-"):
        try:
            colab_id = int(sub.split("colab-", 1)[1])
        except Exception:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Token inválido")

        colaborador = (
            db.query(models.Colaborador)
            .filter(models.Colaborador.id == colab_id)
            .first()
        )
        if not colaborador or not _is_active_obj(colaborador):
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Usuário não encontrado")

        _ensure_empresa_exists_and_active(db, colaborador.empresa_id)

        if str(getattr(colaborador, "login_token", "") or "") == FORCE_PASSWORD_CHANGE_MARKER:
            usuario_vinculado = None

            if getattr(colaborador, "usuario_id", None):
                usuario_vinculado = (
                    db.query(models.Usuario)
                    .filter(models.Usuario.id == int(colaborador.usuario_id))
                    .first()
                )

            if not usuario_vinculado:
                usuario_vinculado = (
                    db.query(models.Usuario)
                    .filter(
                        models.Usuario.empresa_id == int(colaborador.empresa_id),
                        func.lower(models.Usuario.email) == func.lower(str(colaborador.email)),
                    )
                    .first()
                )

            if usuario_vinculado:
                token_reset = _ensure_user_reset_token(db, usuario_vinculado)
                db.commit()
                try:
                    enviar_email_reset(
                        str(getattr(usuario_vinculado, "email", None) or colaborador.email).lower().strip(),
                        token_reset,
                    )
                except Exception as e:
                    print("[LOGIN FORCE CHANGE EMAIL] erro ao enviar código:", repr(e))
            else:
                db.commit()

            raise HTTPException(
                status_code=403,
                detail={
                    "force_password_change": True,
                    "message": "Por segurança, troque sua senha inicial antes de acessar.",
                    "email": colaborador.email,
                },
            )

        if not colab_login_allowed_now(db, colaborador):
            raise HTTPException(
                status_code=403,
                detail="Fora do horário permitido de acesso para este colaborador.",
            )

        new_payload = _colab_token_payload(colaborador)
        empresa_id = int(colaborador.empresa_id)
    else:
        try:
            user_id = int(sub)
        except Exception:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Token inválido")

        user = db.query(models.Usuario).filter(models.Usuario.id == user_id).first()
        if not user or not _is_active_obj(user):
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Usuário não encontrado")

        if not _usuario_is_admin(user):
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Este usuário não é administrador. Faça login como colaborador.")

        _ensure_empresa_exists_and_active(db, user.empresa_id)

        try:
            _ensure_admin_colaborador(db, user)
            db.commit()
        except Exception as e:
            try:
                db.rollback()
            except Exception:
                pass
            print("[REFRESH ADMIN] erro ao garantir colaborador:", repr(e))
            raise HTTPException(
                status_code=409,
                detail="Não foi possível sincronizar o colaborador operacional do admin.",
            )

        new_payload = _admin_token_payload(db, user)
        empresa_id = int(user.empresa_id)

    new_token = create_access_token(new_payload)
    csrf_token = set_auth_cookies(
        response,
        request,
        token=new_token,
        empresa_id=empresa_id,
        max_age=JWT_EXP_MINUTES * 60,
    )
    exp_ts = int((datetime.utcnow() + timedelta(minutes=JWT_EXP_MINUTES)).timestamp())
    return {"access_token": new_token, "csrf_token": csrf_token, "exp": exp_ts}


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

    csrf_token = set_auth_cookies(
        response,
        request,
        token=token,
        empresa_id=int(empresa_id),
        max_age=JWT_EXP_MINUTES * 60,
    )
    return {"ok": True, "empresa_id": empresa_id, "csrf_token": csrf_token}


@router.post("/criar-empresa")
def register(
    dados: RegisterIn,
    request: Request,
    response: Response,
    db: Session = Depends(get_db_session),
    _writable: None = Depends(guard_writable_register),
):
    tel_limpo = "".join(c for c in dados.telefone if c.isdigit())
    doc_limpo = "".join(c for c in (dados.doc or "") if c.isdigit())
    email_admin = norm_email(dados.email_admin)

    try:
        if _find_usuario_by_email(db, email_admin):
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
            email=email_admin,
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

        dep_padrao = None
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

            if getattr(usuario, "departamento_id", None) is None and dep_padrao is not None:
                usuario.departamento_id = dep_padrao.id
                db.add(usuario)
                db.flush()
        except Exception as e:
            print("[DEPARTAMENTO WARN]", e)

        try:
            from backend.routers.permissoes import _sync_catalog_to_db
            _sync_catalog_to_db(db)
        except Exception as e:
            print("[PERMISSOES WARN]", e)

        # garante o colaborador operacional do admin já no cadastro
        admin_colab = _ensure_admin_colaborador(db, usuario)

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

        token = create_access_token(_admin_token_payload(db, usuario))
        csrf_token = set_auth_cookies(
            response,
            request,
            token=token,
            empresa_id=empresa.id,
            max_age=JWT_EXP_MINUTES * 60,
        )
        return {
            "access_token": token,
            "csrf_token": csrf_token,
            "empresa_id": empresa.id,
            "empresa_nome": empresa.nome,
            "nome": usuario.nome,
            "email": usuario.email,
            "is_admin": True,
            "colaborador_id": int(admin_colab.id) if admin_colab else None,
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
    _writable: None = Depends(guard_writable_recovery),
):
    email_norm = norm_email(dados.email)
    ip = _client_ip(request)

    k1 = f"forgot:email:{_safe_email_key(email_norm)}"
    k2 = f"forgot:ip:{ip}"
    if not _rate_take(_forgot_rate, k1, FORGOT_MAX_REQ, FORGOT_WINDOW_SEC) or not _rate_take(
        _forgot_rate,
        k2,
        FORGOT_MAX_REQ,
        FORGOT_WINDOW_SEC,
    ):
        wait = max(_rate_remaining(_forgot_rate, k1), _rate_remaining(_forgot_rate, k2))
        raise HTTPException(
            status_code=429,
            detail="Muitas solicitações de recuperação. Aguarde alguns minutos e tente novamente.",
            headers={"Retry-After": str(wait)},
        )

    # Não revelar se o e-mail existe ou não.
    usuario = _find_usuario_by_email(db, email_norm)
    if not usuario:
        print("[AUTH] forgot-password solicitado para e-mail não encontrado:", email_norm)
        return {"detail": "Se o e-mail estiver cadastrado, enviaremos um código de recuperação."}

    token = _unique_reset_token(db)

    usuario.reset_token = token
    usuario.reset_token_expira = datetime.utcnow() + timedelta(minutes=RESET_CODE_TTL_MIN)
    commit_or_block(db)

    print(f"[AUTH] Código de reset gerado para usuário ID={usuario.id} expira em {RESET_CODE_TTL_MIN} min")
    try:
        enviar_email_reset(email_norm, token)
    except EmailDeliveryError as exc:
        raise HTTPException(
            status_code=502,
            detail=exc.public_message,
        ) from exc

    return {"detail": "Se o e-mail estiver cadastrado, enviaremos um código de recuperação."}


@router.post("/reset-password")
def reset_password(
    dados: ResetPasswordIn,
    request: Request,
    db: Session = Depends(get_db_session),
    _writable: None = Depends(guard_writable_recovery),
):
    token_in = (dados.token or "").strip()
    ip = _client_ip(request)

    k_ip = f"reset:ip:{ip}"
    k_tok = f"reset:tok:{token_in}"
    if not _rate_take(_reset_attempts, k_ip, RESET_MAX_ATTEMPTS, RESET_ATTEMPT_WINDOW_SEC) or not _rate_take(
        _reset_attempts,
        k_tok,
        RESET_MAX_ATTEMPTS,
        RESET_ATTEMPT_WINDOW_SEC,
    ):
        wait = max(_rate_remaining(_reset_attempts, k_ip), _rate_remaining(_reset_attempts, k_tok))
        raise HTTPException(
            status_code=429,
            detail="Muitas tentativas de redefinição. Aguarde alguns minutos e tente novamente.",
            headers={"Retry-After": str(wait)},
        )

    erro_invalido = "Link inválido ou expirado" if dados.email else "Código inválido ou expirado"

    usuario = db.query(models.Usuario).filter_by(reset_token=token_in).first()
    if not usuario:
        print("[AUTH] reset-password com token inválido")
        raise HTTPException(status_code=400, detail=erro_invalido)

    # Nos convites de colaborador, o link leva token e e-mail. Validar os dois
    # impede que um endereço alterado manualmente seja aceito por engano.
    if dados.email and norm_email(str(dados.email)) != norm_email(str(usuario.email or "")):
        print("[AUTH] reset-password com e-mail diferente do token")
        raise HTTPException(status_code=400, detail=erro_invalido)

    expira = getattr(usuario, "reset_token_expira", None)
    if not expira or expira.replace(tzinfo=None) < datetime.utcnow():
        print("[AUTH] reset-password com token expirado para usuário ID=", getattr(usuario, "id", None))
        raise HTTPException(status_code=400, detail=erro_invalido)

    nova_hash = hash_pwd(dados.nova_senha)

    usuario.senha_hash = nova_hash
    usuario.reset_token = None
    usuario.reset_token_expira = None

    try:
        colab = _ensure_admin_colaborador(db, usuario)
        if colab:
            colab.senha = nova_hash
            db.add(colab)
    except Exception as e:
        print("[RESET WARN] não foi possível sincronizar colaborador do admin:", repr(e))

    try:
        linked_colabs = (
            db.query(models.Colaborador)
            .filter(
                or_(
                    models.Colaborador.usuario_id == int(usuario.id),
                    and_(
                        models.Colaborador.empresa_id == int(usuario.empresa_id),
                        func.lower(models.Colaborador.email) == func.lower(str(usuario.email)),
                    ),
                )
            )
            .all()
        )

        for colab in linked_colabs:
            colab.senha = nova_hash

            if str(getattr(colab, "login_token", "") or "") == FORCE_PASSWORD_CHANGE_MARKER:
                colab.login_token = None
                colab.login_token_expires_at = None

            if getattr(colab, "usuario_id", None) is None:
                colab.usuario_id = int(usuario.id)

            db.add(colab)
    except Exception as e:
        print("[RESET WARN] não foi possível sincronizar colaborador comum:", repr(e))

    commit_or_block(db)

    print(f"[AUTH] Senha redefinida com sucesso para usuário ID={usuario.id}")
    return {"detail": "Senha redefinida com sucesso!"}