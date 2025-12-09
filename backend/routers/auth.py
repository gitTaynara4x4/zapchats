# backend/routers/auth.py
from datetime import datetime, timedelta
import os
from uuid import uuid4
import smtplib
from email.mime.text import MIMEText
import base64
import re
import secrets  # compare_digest
from typing import Optional

import jwt
from fastapi import (
    APIRouter, Depends, HTTPException, Response, Request, Header, status
)
from fastapi.security import OAuth2PasswordBearer
from pydantic import BaseModel, EmailStr
from sqlalchemy.orm import Session
from sqlalchemy import text
from dotenv import load_dotenv
import pytz

from backend.database import get_db_session
import backend.models as models

# Throttle de login
from backend.security.login_throttle import (
    norm_email, client_ip_from_headers, is_locked, apply_lock,
    inc_fail, reset_fail, should_lock, ACCOUNT_LOCK_SEC
)

# Senhas (bcrypt com truncamento seguro a 72 bytes)
from backend.security.passwords import hash_pwd, verify_pwd

# ───────────────────────── Configurações ─────────────────────────
load_dotenv()

EMAIL_REMETENTE = os.getenv("EMAIL_REMETENTE", "recuperazapchats@gmail.com")
EMAIL_SENHA     = os.getenv("EMAIL_SENHA", "qrwfnzukgfkopifr")

JWT_SECRET      = os.getenv("JWT_SECRET", "troque-me")
JWT_EXP_MINUTES = int(os.getenv("JWT_EXP_MINUTES", str(60 * 24)))  # fallback 24h
ALGORITHM       = "HS256"

TRIAL_DAYS = int(os.getenv("TRIAL_DAYS", "7"))  # 7 por padrão

# Cookies/CSRF (devem bater com main.py)
ACCESS_COOKIE_NAME = os.getenv("ACCESS_COOKIE_NAME", "access_token")
# Mantidos por compat (não usados diretamente; lógica de Secure/SameSite é automática):
COOKIE_SECURE     = (os.getenv("COOKIE_SECURE", "false").strip().lower() in ("1","true","yes","on"))
COOKIE_SAMESITE   = os.getenv("COOKIE_SAMESITE", "lax").strip().lower()  # "lax" | "strict" | "none"
CSRF_COOKIE_NAME  = os.getenv("CSRF_COOKIE_NAME", "csrf_token")
COOKIE_DOMAIN: Optional[str] = (os.getenv("COOKIE_DOMAIN") or "").strip() or None

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth/login")
router = APIRouter(prefix="/auth", tags=["Auth"])

# data URL: data:image/webp;base64,AAAA...
DATA_URL_RE = re.compile(r"^data:(?P<mime>[^;]+);base64,(?P<data>.+)$")

# ───────────────────────── Helpers de Cookie (auto HTTP/HTTPS) ─────────────────────────
def _is_https(request: Request) -> bool:
    """Detecta HTTPS atrás de proxy (Traefik/Nginx/EasyPanel) ou direto."""
    proto = (request.headers.get("x-forwarded-proto") or request.url.scheme or "").lower()
    return proto == "https"

def _cookie_base(request: Request, max_age: Optional[int] = None) -> dict:
    """
    Define flags de cookie:
      - Secure: True só quando a requisição chega via HTTPS
      - SameSite: Lax por padrão (ou None se COOKIE_SAMESITE=none)
      - Domain: opcional via COOKIE_DOMAIN (útil para compartilhar entre apex e www)
    """
    params = {
        "secure": _is_https(request),
        "samesite": "none" if COOKIE_SAMESITE == "none" else "lax",
        "path": "/",
        "domain": COOKIE_DOMAIN or None,
    }
    if max_age is not None:
        params["max_age"] = max_age
    return params

def set_auth_cookies(response: Response, request: Request, *, token: str, empresa_id: int, max_age: int):
    base = _cookie_base(request, max_age=max_age)
    # Token httpOnly
    response.set_cookie(
        key=ACCESS_COOKIE_NAME,
        value=token,
        httponly=True,
        **base
    )
    # Empresa legível pelo front
    response.set_cookie(
        key="empresa_id",
        value=str(empresa_id),
        httponly=False,
        **base
    )

def clear_auth_cookies(response: Response, request: Request):
    base = _cookie_base(request, max_age=0)
    response.delete_cookie(key=ACCESS_COOKIE_NAME, path="/", domain=base.get("domain"))
    response.delete_cookie(key="empresa_id", path="/", domain=base.get("domain"))

# ───────────────────────── Feature flags p/ bloquear escrita ─────────────────────────
def _envflag(name: str, default: str = "false") -> bool:
    return (os.getenv(name, default) or "").strip().lower() in ("1", "true", "yes", "on")

READONLY_MODE               = _envflag("READONLY_MODE")                # trava geral (manutenção)
DISABLE_REGISTER            = _envflag("DISABLE_REGISTER")             # trava apenas /register
DISABLE_PASSWORD_RECOVERY   = _envflag("DISABLE_PASSWORD_RECOVERY")    # trava forgot/reset

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
        try:
            db.rollback()
        except Exception:
            pass
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Somente leitura (manutenção).")
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
    remember: bool | None = None  # para “lembrar de mim”

class RegisterIn(BaseModel):
    nome: str
    telefone: str
    email_admin: EmailStr
    senha_admin: str
    nome_adm: str | None = None
    avatar_url: str | None = None
    doc: str | None = None  # CPF/CNPJ opcional

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

# ───────────────────────── E-mail reset ─────────────────────────
def enviar_email_reset(email_destino: str, token: str):
    assunto = "[ZapChats] Instruções para redefinição de senha"
    link_reset = f"https://www.zapschat.com.br/esqueci_senha.html?token={token}"

    corpo = f"""
Olá,

Recebemos uma solicitação para redefinir a senha da conta ZapChats associada a este e-mail.

1) Acesse o link seguro:
   {link_reset}

2) Ou use este código na página "Esqueci minha senha":
   {token}

Por motivos de segurança, este código e o link são válidos por um período limitado.
Se você não fez esta solicitação, pode ignorar este e-mail.

Atenciosamente,
Equipe ZapChats
"""

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



# ───────────────────────── Util de data URL ─────────────────────────
DATA_URL_RE = re.compile(r"^data:(?P<mime>[^;]+);base64,(?P<data>.+)$")

def data_url_to_bytes(data_url: str) -> tuple[str, bytes]:
    m = DATA_URL_RE.match(data_url)
    if not m:
        raise ValueError("Data URL inválida")
    mime = m.group("mime")
    raw  = base64.b64decode(m.group("data"))
    return mime, raw

# ─────────── Identidade atual (admin/colaborador) + compat wrapper ───────────
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

    # ───── Colaborador ─────
    if isinstance(sub, str) and sub.startswith("colab-"):
        try:
            colab_id = int(sub.split("colab-", 1)[1])
        except Exception:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Token inválido")

        colab = db.query(models.Colaborador).filter(models.Colaborador.id == colab_id).first()
        if not colab:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Usuário não encontrado")

        is_admin = (role == "admin") or ((colab.cargo or "").lower() == "admin")

        # Carregar permissões do colaborador
        perms: list[str] = []
        try:
            # Se tiver relacionamento ORM, usa ele
            rel = getattr(colab, "permissoes", None)
            if rel is not None:
                for p in rel:
                    pid = getattr(p, "id", None) or getattr(p, "token", None)
                    if pid:
                        perms.append(pid)
            else:
                # Fallback direto no join table
                rows = db.execute(text("""
                    SELECT permissao_id
                    FROM colaboradores_permissoes
                    WHERE colaborador_id = :cid
                """), {"cid": colab.id}).fetchall()
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

    # ───── Usuario (admin) ─────
    user = db.query(models.Usuario).filter(models.Usuario.id == int(sub)).first()
    if not user:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Usuário não encontrado")

    # Admin normalmente tem tudo: pega todas as permissões cadastradas
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



def require_admin(identity = Depends(get_current_identity)):
    if not identity.get("is_admin"):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Apenas administradores")
    return identity

# Compat: retorna models.Usuario e bloqueia colaboradores
def get_current_user(
    request: Request,
    authorization: str = Header(default=None, alias="Authorization"),
    db: Session = Depends(get_db_session)
) -> models.Usuario:
    token = _token_from_request(request, authorization)
    if not token:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Não autenticado")

    payload = _decode_token(token)
    sub     = payload.get("sub")
    if not sub:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Token inválido")

    if isinstance(sub, str) and sub.startswith("colab-"):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Apenas administradores")

    user = db.query(models.Usuario).filter(models.Usuario.id == int(sub)).first()
    if not user:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Usuário não encontrado")
    return user

# ───────────────────────── CSRF (double-submit) ─────────────────────────
def csrf_protect_refresh(
    request: Request,
    csrf_header: str | None = Header(default=None, alias="X-CSRF-Token")
):
    cookie_val = request.cookies.get(CSRF_COOKIE_NAME)
    if not cookie_val or not csrf_header or not secrets.compare_digest(cookie_val, csrf_header):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "CSRF token inválido")
    return True

# ───────────────────────── Rotas ─────────────────────────
@router.get("/me")
def me(identity = Depends(get_current_identity)):
    return identity

@router.get("/readonly")
def readonly_status():
    return {
        "readonly": READONLY_MODE,
        "disable_register": DISABLE_REGISTER,
        "disable_password_recovery": DISABLE_PASSWORD_RECOVERY,
    }

@router.post("/login")
def login(form: LoginIn, response: Response, request: Request, db: Session = Depends(get_db_session)):
    email = norm_email(form.email)
    ip    = client_ip_from_headers(request.headers, request.client.host if request.client else None)

    # 0) Lock ativo?
    remain = is_locked(db, email, ip)
    if remain > 0:
        raise HTTPException(
            status_code=429,
            detail="Muitas tentativas. Aguarde para tentar novamente.",
            headers={"Retry-After": str(remain)}
        )

    # 1) Admin
    user = db.query(models.Usuario).filter_by(email=email).first()
    if user and verify_pwd(form.senha, user.senha_hash):
        reset_fail(db, email, ip)
        db.commit()
        token = create_access_token({"sub": str(user.id), "empresa_id": user.empresa_id, "role": "admin"})
        # cookie ttl (lembrar de mim)
        cookie_max_age = JWT_EXP_MINUTES * 60
        if getattr(form, "remember", False):
            cookie_max_age = 60 * 60 * 24 * 30  # 30 dias
        # grava cookies necessários para o gate HTML (auto Secure/SameSite)
        set_auth_cookies(response, request, token=token, empresa_id=user.empresa_id, max_age=cookie_max_age)
        return {"access_token": token, "empresa_id": user.empresa_id, "nome": user.nome, "cargo": "admin", "is_admin": True}

    # 2) Colaborador
    colaborador = db.query(models.Colaborador).filter_by(email=email).first()
    if colaborador and verify_pwd(form.senha, colaborador.senha):
        reset_fail(db, email, ip)
        db.commit()
        token = create_access_token({"sub": f"colab-{colaborador.id}", "empresa_id": colaborador.empresa_id, "role": colaborador.cargo})
        cookie_max_age = JWT_EXP_MINUTES * 60
        if getattr(form, "remember", False):
            cookie_max_age = 60 * 60 * 24 * 30
        set_auth_cookies(response, request, token=token, empresa_id=colaborador.empresa_id, max_age=cookie_max_age)
        return {
            "access_token": token, "empresa_id": colaborador.empresa_id, "nome": colaborador.nome,
            "cargo": colaborador.cargo, "is_admin": (colaborador.cargo or "").lower() == "admin"
        }

    # 3) Falhou → incrementa e, se necessário, aplica lock
    fails, _window_left = inc_fail(db, email, ip)
    if should_lock(fails):
        apply_lock(db, email, ip, ACCOUNT_LOCK_SEC)
        db.commit()
        raise HTTPException(
            status_code=429,
            detail="Muitas tentativas. Sua conta foi temporariamente bloqueada."
        )

    db.commit()
    raise HTTPException(status_code=401, detail="Credenciais inválidas")

@router.post("/logout")
def logout(response: Response, request: Request):
    clear_auth_cookies(response, request)
    return {"msg": "Desconectado com sucesso"}

# 🔄 Refresh com CSRF double-submit
@router.post("/refresh", dependencies=[Depends(csrf_protect_refresh)])
def refresh_token(
    request: Request,
    response: Response,
    authorization: str = Header(default=None, alias="Authorization"),
):
    """
    Reemite o access_token mantendo as mesmas claims.
    Requer:
      - Cookie 'csrf_token' (setado pelo middleware em /api/auth/refresh)
      - Header 'X-CSRF-Token' com o MESMO valor do cookie
      - Access token válido no cookie 'access_token' ou no Authorization: Bearer
    """
    token = _token_from_request(request, authorization)
    if not token:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Não autenticado")

    payload = _decode_token(token)  # valida exp/assinatura
    sub         = payload.get("sub")
    empresa_id  = payload.get("empresa_id")
    role        = payload.get("role")

    if not sub or not empresa_id:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Token inválido")

    new_token = create_access_token({"sub": sub, "empresa_id": empresa_id, "role": role})
    set_auth_cookies(response, request, token=new_token, empresa_id=int(empresa_id), max_age=JWT_EXP_MINUTES * 60)
    exp_ts = int((datetime.utcnow() + timedelta(minutes=JWT_EXP_MINUTES)).timestamp())
    return {"access_token": new_token, "exp": exp_ts}

@router.post("/cookieize")
def cookieize(
    request: Request,
    response: Response,
    authorization: str = Header(default=None, alias="Authorization"),
):
    """
    Opcional: converte Authorization: Bearer <token> em cookies httpOnly para o gate HTML.
    Útil quando o front ainda trabalha com localStorage.
    """
    token = _token_from_request(request, authorization)
    if not token:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Faltou Authorization Bearer ou cookie de token")

    payload = _decode_token(token)
    empresa_id = payload.get("empresa_id")
    if not empresa_id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Token sem empresa_id")

    # grava cookies como no login (auto Secure/SameSite)
    set_auth_cookies(response, request, token=token, empresa_id=int(empresa_id), max_age=JWT_EXP_MINUTES * 60)
    return {"ok": True, "empresa_id": empresa_id}

@router.post("/criar-empresa")
def register(
    dados: RegisterIn,
    request: Request,  
    response: Response,
    db: Session = Depends(get_db_session),
    _=Depends(guard_writable_register),
):
    tel_limpo = "".join(c for c in dados.telefone if c.isdigit())
    doc_limpo = "".join(c for c in (dados.doc or "") if c.isdigit())
    try:
        # validações
        if db.query(models.Usuario).filter_by(email=dados.email_admin).first():
            raise HTTPException(status_code=400, detail="E-mail já está em uso")
        if db.query(models.Empresa).filter_by(telefone=tel_limpo).first():
            raise HTTPException(status_code=400, detail="Telefone já está em uso")

        # valida documento (opcional, apenas formato)
        if doc_limpo and (len(doc_limpo) not in (11, 14)):
            raise HTTPException(status_code=400, detail="Documento deve ter 11 (CPF) ou 14 (CNPJ) dígitos.")

        # unicidade (se quiser impedir duplicidade)
        if doc_limpo:
            ja = db.query(models.Empresa).filter_by(cnpj_cpf=doc_limpo).first()
            if ja:
                raise HTTPException(status_code=400, detail="Documento já cadastrado para outra empresa.")

        # empresa
        empresa = models.Empresa(
            nome=dados.nome,
            telefone=tel_limpo,
            cnpj_cpf=doc_limpo or None,
        )
        # inicia no FREE por padrão
        if hasattr(empresa, "assinatura"):
            empresa.assinatura = "FREE"
        # trial automático do PRATA por 7 dias (se as colunas existirem)
        if hasattr(empresa, "trial_tier"):
            empresa.trial_tier = "PRATA"
        if hasattr(empresa, "trial_expires_at"):
            empresa.trial_expires_at = datetime.utcnow() + timedelta(days=TRIAL_DAYS)

        db.add(empresa); db.flush()

        if hasattr(empresa, "nome_adm") and dados.nome_adm:
            empresa.nome_adm = dados.nome_adm.strip()

        # setores padrão
        for nome_setor in ["Atendimento", "Comercial", "Financeiro", "Suporte Técnico"]:
            db.add(models.Setor(nome=nome_setor, empresa_id=empresa.id))

        # admin (USUÁRIO) – SEM colaborador-espelho
        usuario = models.Usuario(
            nome=(dados.nome_adm or "Admin").strip(),
            email=dados.email_admin,
            senha_hash=hash_pwd(dados.senha_admin),  # helper central (trunca 72 bytes utf-8)
            empresa_id=empresa.id,
            is_admin=True
        )
        db.add(usuario); db.flush()

        # avatar (admin) / logo (empresa)
        if dados.avatar_url:
            try:
                if dados.avatar_url.startswith("data:"):
                    mime, raw = data_url_to_bytes(dados.avatar_url)
                    if len(raw) > 2 * 1024 * 1024:
                        raise ValueError("Imagem muito grande (>2MB)")
                    if hasattr(usuario, "avatar_mime"): usuario.avatar_mime = mime
                    if hasattr(usuario, "avatar_data"): usuario.avatar_data = raw
                elif dados.avatar_url.startswith(("http://", "https://")) and hasattr(empresa, "avatar_url"):
                    empresa.avatar_url = dados.avatar_url
            except Exception as e:
                print("[AVATAR WARN]", e)

        # --- Departamento padrão (SEM vincular ninguém ainda) ---
        try:
            dep_padrao_nome = "Geral"
            dep_padrao = db.query(models.Departamento).filter_by(
                empresa_id=empresa.id,
                nome=dep_padrao_nome
            ).first()
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
                db.add(dep_padrao); db.flush()
        except Exception as e:
            print("[DEPARTAMENTO WARN]", e)

        # Sincroniza catálogo de permissões (apenas tabela 'permissoes')
        try:
            from backend.routers.permissoes import _sync_catalog_to_db
            _sync_catalog_to_db(db)
        except Exception as e:
            print("[PERMISSOES WARN]", e)

        commit_or_block(db)

        # resposta / cookie
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
        set_auth_cookies(response, request, token=token, empresa_id=empresa.id, max_age=JWT_EXP_MINUTES * 60)
        return {
            "access_token": token,
            "empresa_id": empresa.id,
            "empresa_nome": empresa.nome,
            "nome": usuario.nome,
            "email": usuario.email,
            "is_admin": True,
            "created_at": created_at_formatado,
            "assinatura": empresa.assinatura,
            "trial_tier": getattr(empresa, "trial_tier", None),
            "trial_expires_at": getattr(empresa, "trial_expires_at", None).isoformat()
                if getattr(empresa, "trial_expires_at", None) else None
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
    db: Session = Depends(get_db_session),
    _=Depends(guard_writable_recovery),
):
    print(f"[LOG] Requisição forgot-password recebida: {dados.email}")
    usuario = db.query(models.Usuario).filter_by(email=dados.email).first()
    if not usuario:
        print("[LOG] Usuário não encontrado para:", dados.email)
        raise HTTPException(status_code=404, detail="Usuário não encontrado")

    token = str(uuid4())
    usuario.reset_token = token
    usuario.reset_token_expira = datetime.utcnow() + timedelta(hours=1)
    commit_or_block(db)

    print(f"[LOG] Token gerado: {token}")
    enviar_email_reset(dados.email, token)
    return {"detail": "Token enviado para o e-mail informado."}

@router.post("/reset-password")
def reset_password(
    dados: ResetPasswordIn,
    db: Session = Depends(get_db_session),
    _=Depends(guard_writable_recovery),
):
    print(f"[LOG] Requisição reset-password recebida: token={dados.token}")
    usuario = db.query(models.Usuario).filter_by(reset_token=dados.token).first()
    if not usuario or usuario.reset_token_expira.replace(tzinfo=None) < datetime.utcnow():
        print("[LOG] Token inválido ou expirado")
        raise HTTPException(status_code=400, detail="Token inválido ou expirado")

    usuario.senha_hash = hash_pwd(dados.nova_senha)
    usuario.reset_token = None
    usuario.reset_token_expira = None
    commit_or_block(db)

    print(f"[LOG] Senha redefinida com sucesso para usuário ID={usuario.id}")
    return {"detail": "Senha redefinida com sucesso!"}