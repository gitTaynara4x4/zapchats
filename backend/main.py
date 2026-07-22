from __future__ import annotations

import os
import re
import secrets
import asyncio
import time
from urllib.parse import quote_plus, urlsplit, urlunsplit, parse_qsl, urlencode
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, Request, Depends, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, RedirectResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.exception_handlers import http_exception_handler as fastapi_http_exception_handler

from starlette.responses import Response as StarletteResponse
from starlette.middleware.gzip import GZipMiddleware
from starlette.middleware.trustedhost import TrustedHostMiddleware
from starlette.exceptions import HTTPException as StarletteHTTPException

from sqlalchemy.orm import Session
from sqlalchemy import text

# Routers
from backend.routers.seo_landing import router as seo_landing_router
from backend.routers.email import router as email_router
from backend.routers.disparos import router as disparos_router
from backend.routers import chatbot_setores as chatbot_setores_router
from backend.routers.atendimento_conversas import router as atendimento_conversas_router
from backend.routers import internal_chat as internal_chat_router
from backend.websocket_manager import router as ws_router, conexoes_ativas
from backend.routers import atendimentoia as atendimento_ia_router
from backend.routers import atendimento_chat as atendimento_chat_router
from backend.routers.clients_central import router as clients_central_router
from backend.routers import (
    auth,
    usuarios,
    clientes,
    atendimento,
    cliente_onboarding,
    empresa,
    atendimento_busca,
)
from backend.routers import dashboard as dashboard_router
from backend.routers.colaboradores import router as colaboradores_router
from backend.routers.permissoes import router as permissoes_router
from backend.routers.admin_assinaturas import router as admin_assinaturas_router

# ⚠️ DOIS routers de mídias (prefixos distintos)
from backend.routers.atendimento_midias import router as atendimento_midias_router
from backend.routers.midias import router as midias_router

from backend.routers.atendimento_send import router as atendimento_send_router
from backend.routers import departamentos as departamentos_router
from backend.routers import chatbot_config as chatbot_config_router
from backend.routers import admin_planos
from backend.routers.perfil import router as perfil_router
from backend.routers.meu_plano import router as meu_plano_router
from backend.routers.integracoes_valora import router as integracoes_valora_router

# ✅ Router de filas
from backend.routers import filas as filas_router

# DB
from backend.database import Base, engine, SessionLocal
from backend import models
from backend.migrations.atendimento_claim_state import normalize_atendimento_claim_state

# Integrações Evolution
from backend.integrations.evolution.api.remove_instance import router as remove_instance_router
from backend.integrations.evolution.api.router import router as evolution_router
from backend.integrations.evolution.transport.rabbit_consumer import start_rabbit_consumer
from backend.integrations.evolution.transport.ws_listener import start_evo_ws_listener
from backend.routers.atendimento_transferencia import router as atendimento_transferencia_router

# IMPORTANTE:
# este import dispara o __init__ do pacote de handlers e registra os módulos
# no registry compartilhado.
from backend.integrations.evolution import handlers as _evolution_handlers  # noqa: F401
from backend.integrations.evolution.handlers.shared import HANDLERS, EvoEvent

import backend.routers.auth as auth_router
from backend.routers.auth import get_current_user

# Plans / billing
from backend.utils.plans import is_billing_locked
from backend.routers.billing_asaas import router as billing_asaas_router


# =======================================
# Config & utils
# =======================================
load_dotenv()


def LOG(*args):
    print("[MAIN]", *args)


def _env_bool(name: str, default: bool = False) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return bool(default)

    s = str(raw).strip().lower()
    if s in ("1", "true", "yes", "y", "on", "sim"):
        return True
    if s in ("0", "false", "no", "n", "off", "nao", "não", ""):
        return False

    return bool(default)


ENV = (os.getenv("ENV", "dev") or "dev").lower()

# =========================================================
# Versão do build
# =========================================================
BUILD_ID = os.getenv("BUILD_ID") or datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")

# Caminhos do frontend
BASE_DIR = Path(__file__).resolve().parent.parent
FRONTEND_DIR = BASE_DIR / "frontend"

# ✅ uploads: caminho absoluto + cria se faltar
UPLOADS_DIR = BASE_DIR / "uploads"
UPLOADS_DIR.mkdir(parents=True, exist_ok=True)


# =========================================================
# Cache bust automático para frontend
# =========================================================
CACHE_BUST_EXTS = (
    ".js",
    ".mjs",
    ".css",
    ".map",
    ".json",
    ".png",
    ".jpg",
    ".jpeg",
    ".webp",
    ".svg",
    ".ico",
    ".woff",
    ".woff2",
    ".ttf",
)

CACHE_BUST_PREFIXES = (
    "/frontend/",
    "/static/",
    "/assets/",
    "/img/",
    "/favicon",
    "/manifest",
)

_ASSET_ATTR_RE = re.compile(
    r'(?P<attr>\b(?:src|href)\s*=\s*)(?P<quote>["\'])(?P<url>[^"\']+)(?P=quote)',
    re.IGNORECASE,
)


def _is_cache_bustable_url(url: str) -> bool:
    u = (url or "").strip()
    if not u:
        return False

    lower = u.lower()

    if lower.startswith(
        (
            "http://",
            "https://",
            "data:",
            "blob:",
            "mailto:",
            "tel:",
            "#",
            "javascript:",
        )
    ):
        return False

    clean = lower.split("#", 1)[0].split("?", 1)[0]

    if clean.startswith(CACHE_BUST_PREFIXES):
        return True

    return clean.endswith(CACHE_BUST_EXTS)


def _url_with_build_id(url: str) -> str:
    try:
        parts = urlsplit(url)

        query_items = [
            (k, v)
            for k, v in parse_qsl(parts.query, keep_blank_values=True)
            if k.lower() != "v"
        ]
        query_items.append(("v", BUILD_ID))

        new_query = urlencode(query_items)

        return urlunsplit(
            (
                parts.scheme,
                parts.netloc,
                parts.path,
                new_query,
                parts.fragment,
            )
        )
    except Exception:
        sep = "&" if "?" in url else "?"
        return f"{url}{sep}v={BUILD_ID}"


def _rewrite_html_cache_bust(html: str, inject_build_script: bool = True) -> str:
    def repl(match: re.Match) -> str:
        attr = match.group("attr")
        quote = match.group("quote")
        url = match.group("url")

        if not _is_cache_bustable_url(url):
            return match.group(0)

        return f"{attr}{quote}{_url_with_build_id(url)}{quote}"

    out = _ASSET_ATTR_RE.sub(repl, html)

    if inject_build_script:
        safe_build = str(BUILD_ID).replace("\\", "\\\\").replace('"', '\\"')

        build_script = f"""
<meta name="zc-build-id" content="{safe_build}">
<script>
  window.ZC_BUILD_ID = "{safe_build}";

  (function () {{
    try {{
      var BUILD = window.ZC_BUILD_ID;
      var KEY = "zc:build_id";
      var old = localStorage.getItem(KEY);

      if (old && old !== BUILD) {{
        localStorage.setItem(KEY, BUILD);

        try {{
          if ("serviceWorker" in navigator) {{
            navigator.serviceWorker.getRegistrations()
              .then(function (regs) {{
                regs.forEach(function (reg) {{
                  try {{ reg.unregister(); }} catch (e) {{}}
                }});
              }})
              .catch(function () {{}});
          }}
        }} catch (e) {{}}

        try {{
          if (window.caches && caches.keys) {{
            caches.keys()
              .then(function (keys) {{
                return Promise.all(keys.map(function (k) {{
                  return caches.delete(k);
                }}));
              }})
              .catch(function () {{}});
          }}
        }} catch (e) {{}}

        // Antes este trecho fazia window.location.replace(...?v=BUILD).
        // Isso derrubava o WebSocket com CLOSE 1001 e parecia que o atendimento "caía".
        // Os assets já recebem ?v=BUILD pelo rewrite do backend, então não precisamos
        // recarregar a página inteira só porque o build mudou.
        // Mantém apenas a limpeza de caches/service worker acima.
      }}

      localStorage.setItem(KEY, BUILD);
    }} catch (e) {{}}
  }})();
</script>
"""

        lower = out.lower()
        idx = lower.find("</head>")
        if idx >= 0 and "zc-build-id" not in lower:
            out = out[:idx] + build_script + out[idx:]

    return out


def _html_response_from_file(
    path: Path,
    status_code: int = 200,
    inject_build_script: bool = True,
):
    html = path.read_text(encoding="utf-8")
    html = _rewrite_html_cache_bust(html, inject_build_script=inject_build_script)

    return HTMLResponse(
        content=html,
        status_code=status_code,
        headers={
            "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
            "Pragma": "no-cache",
            "Expires": "0",
            "X-ZC-Build": str(BUILD_ID),
        },
    )


DEV_ORIGINS = [
    "http://127.0.0.1:8000",
    "http://localhost:8000",
    "http://127.0.0.1:8001",
    "http://localhost:8001",
    "http://127.0.0.1:5500",
    "http://localhost:5500",
]
PROD_ORIGINS = [
    "https://zapschat.com.br",
    "https://www.zapschat.com.br",
    "https://ZapsChat.com.br",
    "https://www.ZapsChat.com.br",
]
ALLOW_ORIGINS = DEV_ORIGINS if ENV == "dev" else PROD_ORIGINS

# ---- Flags de integração Evolution/Rabbit ----
RABBIT_ENABLED_BY_ENV = _env_bool("USE_RABBIT", True)
RABBIT_CONSUME_ENABLED = _env_bool("RABBITMQ_CONSUME_ENABLED", True)
USE_RABBIT = (
    RABBIT_ENABLED_BY_ENV
    and RABBIT_CONSUME_ENABLED
    and any(
        os.getenv(k)
        for k in ("RABBITMQ_URI", "RABBITMQ_URL", "AMQP_URL")
    )
)
USE_EVO_WS = _env_bool("EVOLUTION_WS_SUBSCRIBE", True)

# Cookies / CSRF
ACCESS_COOKIE_NAME = os.getenv("ACCESS_COOKIE_NAME", "access_token")

COOKIE_SAMESITE = (os.getenv("COOKIE_SAMESITE", "lax") or "lax").lower()
if COOKIE_SAMESITE not in ("lax", "strict", "none"):
    COOKIE_SAMESITE = "lax"

CSRF_COOKIE_NAME = os.getenv("CSRF_COOKIE_NAME", "csrf_token")
CSRF_COOKIE_PATH = os.getenv("CSRF_COOKIE_PATH", "/api/auth/refresh")
CSRF_COOKIE_MAX_AGE = int(os.getenv("CSRF_COOKIE_MAX_AGE", str(60 * 60 * 24 * 30)))

# Mesmo domínio usado pelo auth.py.
# Importante para conseguir apagar cookies antigos em produção.
COOKIE_DOMAIN = (os.getenv("COOKIE_DOMAIN") or "").strip() or None

# =======================================
# Trusted hosts
# =======================================
ALLOWED_HOSTS_RAW = os.getenv(
    "ALLOWED_HOSTS",
    "localhost,127.0.0.1,zapschat.com.br,www.zapschat.com.br,ZapsChat.com.br,www.ZapsChat.com.br,*.easypanel.host,82.25.74.157",
) or ""

ALLOWED_HOSTS = [
    h.strip()
    for h in ALLOWED_HOSTS_RAW.split(",")
    if h.strip()
]

if ENV == "dev" and "*" not in ALLOWED_HOSTS:
    ALLOWED_HOSTS.append("*")


# Billing: páginas premium para redirecionar quando vencido
BILLING_BLOCKED_HTML_PATHS = {
    "/conectar",
    "/disparos",
    "/chatbot",
    "/email",
}

BILLING_ALLOWED_WHEN_LOCKED = {
    "/dashboard",
    "/clientes",
    "/atendimentos",
    "/filas",
    "/meu-plano",
    "/perfil",
    "/configuracoes",
    "/planos",
}


def _is_https(request: Request) -> bool:
    proto = (request.headers.get("x-forwarded-proto") or request.url.scheme or "").lower()
    return proto == "https"


def _wants_html(req: Request) -> bool:
    p = req.url.path
    if p.endswith(".html"):
        return True
    acc = req.headers.get("accept", "")
    return ("text/html" in acc) or (p == "/")


def _no_cache_html(resp: StarletteResponse):
    try:
        resp.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
        resp.headers["Pragma"] = "no-cache"
        resp.headers["Expires"] = "0"
        resp.headers["X-ZC-Build"] = str(BUILD_ID)
    except Exception:
        pass


def _apply_hsts(resp: StarletteResponse):
    if ENV == "dev":
        return

    mode = (os.getenv("HSTS_MODE", "clear") or "clear").strip().lower()

    if mode in ("off", "0", "false", "no", "disabled"):
        return

    if mode in ("clear", "reset", "0s"):
        resp.headers["Strict-Transport-Security"] = "max-age=0"
        return

    if mode in ("short", "1d", "day"):
        resp.headers["Strict-Transport-Security"] = "max-age=86400"
        return

    resp.headers["Strict-Transport-Security"] = "max-age=63072000; includeSubDomains; preload"


def _cookie_delete_domains(request: Request | None = None) -> list[str | None]:
    """
    Retorna variações de domínio para apagar cookies antigos.

    Por que isso existe:
    - cookie host-only precisa ser apagado sem domain;
    - cookie com COOKIE_DOMAIN precisa ser apagado com domain;
    - cookies antigos podem ter sido salvos em www.zapschat.com.br,
      zapschat.com.br ou .zapschat.com.br.
    """
    domains: list[str | None] = [None]

    def add_domain(d: str | None):
        if not d:
            return

        s = str(d).strip().lower()
        if not s:
            return

        variants = [s]

        if s.startswith("."):
            variants.append(s[1:])
        else:
            variants.append("." + s)

        if s.startswith("www."):
            root = s[4:]
            variants.append(root)
            variants.append("." + root)

        for item in variants:
            if item and item not in domains:
                domains.append(item)

    add_domain(COOKIE_DOMAIN)

    try:
        host = (request.headers.get("host") or "").split(":", 1)[0].strip().lower() if request else ""
        add_domain(host)
    except Exception:
        pass

    # Segurança extra para o domínio público atual.
    add_domain("zapschat.com.br")
    add_domain("www.zapschat.com.br")

    return domains


def _clear_auth_cookies(resp: StarletteResponse, request: Request | None = None):
    """
    Limpa cookies de autenticação quebrados/antigos.

    Importante:
    - se o cookie foi criado com domain, precisa apagar com domain;
    - se foi criado sem domain, precisa apagar sem domain;
    - access_token é httpOnly, então o front não consegue apagar sozinho.
    """
    names = (
        ACCESS_COOKIE_NAME,
        "empresa_id",
        "EMPRESA_ID",
        CSRF_COOKIE_NAME,
    )

    paths = (
        "/",
        CSRF_COOKIE_PATH,
        "/api/auth/refresh",
    )

    for domain in _cookie_delete_domains(request):
        for name in names:
            for path in paths:
                try:
                    resp.delete_cookie(
                        key=name,
                        path=path,
                        domain=domain,
                    )
                except Exception:
                    pass


def _int_or_none(v):
    try:
        if v is None:
            return None
        return int(v)
    except Exception:
        return None


def _billing_locked_for_empresa_id(empresa_id: int | None) -> bool:
    if not empresa_id:
        return False

    db: Session = SessionLocal()
    try:
        emp = db.query(models.Empresa).filter(models.Empresa.id == int(empresa_id)).first()
        if not emp:
            return False
        return bool(is_billing_locked(emp))
    except Exception:
        return False
    finally:
        db.close()


def _html_billing_redirect(path: str, query: str, message: str) -> RedirectResponse:
    next_url = path + (("?" + query) if query else "")
    motivo = quote_plus(message)[:300]
    nxt = quote_plus(next_url)[:1000]
    resp = RedirectResponse(
        url=f"/meu-plano?billing=locked&motivo={motivo}&next={nxt}",
        status_code=302,
    )
    resp.headers["X-Billing-Locked"] = "1"
    resp.headers["Cache-Control"] = "no-store"
    return resp


def _apply_billing_header(resp: StarletteResponse, locked: bool):
    try:
        resp.headers["X-Billing-Locked"] = "1" if locked else "0"
    except Exception:
        pass


# =======================================
# FastAPI app
# =======================================
app = FastAPI()


@app.middleware("http")
async def log_slow_requests(request: Request, call_next):
    """Mostra no terminal qual rota realmente demorou."""
    started = time.perf_counter()
    try:
        return await call_next(request)
    finally:
        elapsed = time.perf_counter() - started
        threshold = float(os.getenv("SLOW_REQUEST_LOG_SEC", "2.0") or "2.0")
        if elapsed >= threshold:
            LOG(
                f"[PERF][SLOW] {request.method} {request.url.path} "
                f"levou {elapsed:.2f}s"
            )

# Middlewares
app.add_middleware(GZipMiddleware, minimum_size=1024)

app.add_middleware(
    TrustedHostMiddleware,
    allowed_hosts=ALLOWED_HOSTS,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOW_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=[
        "Authorization",
        "Content-Type",
        "X-CSRF-Token",
        "X-Empresa-Id",
    ],
    expose_headers=["Retry-After", "X-Auth-Gate", "X-Billing-Locked", "X-ZC-Build"],
)


# =======================================
# Cookie de CSRF + headers básicos
# =======================================
@app.middleware("http")
async def ensure_csrf_cookie(request: Request, call_next):
    needs_csrf = request.url.path.startswith("/api/auth/refresh")
    has_cookie = request.cookies.get(CSRF_COOKIE_NAME)

    resp: StarletteResponse = await call_next(request)

    if needs_csrf and not has_cookie:
        token = secrets.token_urlsafe(32)
        resp.set_cookie(
            key=CSRF_COOKIE_NAME,
            value=token,
            httponly=False,
            secure=_is_https(request),
            samesite=COOKIE_SAMESITE,
            max_age=CSRF_COOKIE_MAX_AGE,
            path=CSRF_COOKIE_PATH,
        )

    _apply_hsts(resp)

    resp.headers.setdefault("X-Content-Type-Options", "nosniff")
    resp.headers.setdefault("X-Frame-Options", "SAMEORIGIN")
    return resp


@app.middleware("http")
async def login_autoredirect(request: Request, call_next):
    p = request.url.path

    if p in ("/login", "/login.html"):
        token = request.cookies.get(ACCESS_COOKIE_NAME)
        emp = request.cookies.get("empresa_id") or request.cookies.get("EMPRESA_ID")

        # Sessão completa: valida token antes de redirecionar.
        if token and emp:
            try:
                auth_router._decode_token(token)
            except Exception as e:
                print("[LOGIN_AUTOREDIRECT] token inválido/quebrado:", repr(e))
                resp = await call_next(request)
                _clear_auth_cookies(resp, request)
                resp.headers["X-Auth-Gate"] = "login-bad-token-cleared"
                return resp

            next_url = request.query_params.get("next") or "/dashboard"
            if not str(next_url).startswith("/") or str(next_url).startswith("//"):
                next_url = "/dashboard"

            return RedirectResponse(url=next_url, status_code=302)

        # Sessão quebrada: tem só um pedaço do cookie.
        # Ex.: empresa_id ficou, access_token sumiu/expirou.
        if token or emp:
            resp = await call_next(request)
            _clear_auth_cookies(resp, request)
            resp.headers["X-Auth-Gate"] = "login-partial-cookie-cleared"
            return resp

    return await call_next(request)


# =======================================
# BLOQUEIO de acesso direto a /frontend/*
# =======================================
PUBLIC_FRONTEND_PARTIALS = {
    "/frontend/partials/loading.html",
    "/frontend/partials/head-base.html",
}


@app.middleware("http")
async def block_direct_frontend(request: Request, call_next):
    p = request.url.path

    if p in PUBLIC_FRONTEND_PARTIALS:
        return await call_next(request)

    if p in (
        "/frontend/admin-planos.html",
        "/frontend/planos.html",
        "/frontend/admin-assinaturas.html",
    ):
        return await call_next(request)

    if p.startswith("/frontend/"):
        is_html = p.endswith(".html") or ("/partials/" in p)
        if is_html:
            token = request.cookies.get(ACCESS_COOKIE_NAME)
            empresa_cookie = request.cookies.get("empresa_id") or request.cookies.get("EMPRESA_ID")

            if token and empresa_cookie:
                try:
                    auth_router._decode_token(token)
                    return await call_next(request)
                except Exception as e:
                    print("[FRONTEND_GATE] token inválido/quebrado:", repr(e))
                    next_url = p + (("?" + request.url.query) if request.url.query else "")
                    resp = RedirectResponse(url=f"/login.html?next={next_url}", status_code=302)
                    resp.headers["X-Auth-Gate"] = "frontend-bad-token"
                    _clear_auth_cookies(resp, request)
                    return resp

            next_url = p + (("?" + request.url.query) if request.url.query else "")
            resp = RedirectResponse(url=f"/login.html?next={next_url}", status_code=302)
            resp.headers["X-Auth-Gate"] = "frontend-missing-cookie"
            _clear_auth_cookies(resp, request)
            return resp

        return await call_next(request)

    return await call_next(request)


# =======================================
# Permissões por página (HTML)
# =======================================
REQUIRED_PERMS = {
    "/dashboard": "dashboard.ver",
    "/clientes": "clientes.ver",
    "/departamentos": "departamentos.gerenciar",
    "/colaboradores": "colaboradores.ver",
    "/colaboradores/novo": "colaboradores.gerenciar",
    "/colaborador-perfil": "colaboradores.gerenciar",
    "/usuarios": "usuarios.gerenciar",
    "/configuracoes": "configuracoes.editar",
    "/chat-interno": "chatinterno.ver",
    "/chatbot": "chatbot.configurar",
    "/atendimentos": "atendimento.ver",
    "/filas": "atendimento.ver",
    "/midias": "arquivos.ver",
    "/email": "email.ver",
    "/disparos": "disparos.ver",
    "/conectar": "integracoes.whatsapp",
}


def _norm_path_for_perm(path: str) -> str:
    p = path.split("?", 1)[0]
    if p.endswith(".html"):
        p = p[:-5]
    return p


def _html_forbidden(msg: str):
    motivo = quote_plus(msg)[:300]
    return RedirectResponse(url=f"/sem-permissao?motivo={motivo}", status_code=302)


def _is_public(path: str) -> bool:
    p = path.split("?", 1)[0].lower()

    PUBLIC_HTML_PATHS = {
        "/",
        "/inicio",
        "/inicio.html",
        "/login",
        "/login.html",
        "/criar-empresa",
        "/criar-empresa.html",
        "/esqueci_senha",
        "/esqueci_senha.html",
        "/admin-planos",
        "/admin-planos.html",
        "/planos",
        "/planos.html",
        "/admin-assinaturas",
        "/admin-assinaturas.html",
        "/frontend/admin-planos.html",
        "/frontend/planos.html",
        "/frontend/admin-assinaturas.html",

        # ✅ Rotas públicas para limpar sessão/cookie antigo.
        # Se não ficarem públicas, o auth_html_gate pode bloquear antes de limpar.
        "/limpar-sessao",
        "/limpar-sessao.html",
        "/sair",
        "/logout",
    }

    PUBLIC_PREFIXES = (
        "/api/auth",
        "/img",
        "/uploads",
        "/static",
        "/assets",
        "/favicon",
        "/robots.txt",
        "/manifest",
        "/ws",
        "/healthz",
        "/ping",
        "/version.json",
        "/__app_alive",
        "/__alive",
    )

    if p in PUBLIC_HTML_PATHS:
        return True

    return any(p.startswith(pref) for pref in PUBLIC_PREFIXES)


@app.middleware("http")
async def auth_html_gate(request: Request, call_next):
    path = request.url.path

    if request.method != "GET" or not _wants_html(request):
        return await call_next(request)

    if _is_public(path):
        resp = await call_next(request)
        _no_cache_html(resp)
        return resp

    token = request.cookies.get(ACCESS_COOKIE_NAME)
    empresa_cookie = request.cookies.get("empresa_id") or request.cookies.get("EMPRESA_ID")

    if not (token and empresa_cookie):
        next_url = path + (("?" + request.url.query) if request.url.query else "")
        resp = RedirectResponse(url=f"/login.html?next={next_url}", status_code=302)
        resp.headers["X-Auth-Gate"] = "missing-cookie"
        _clear_auth_cookies(resp, request)
        return resp

    try:
        payload = auth_router._decode_token(token)
    except Exception as e:
        print("[AUTH_GATE] token inválido/quebrado:", repr(e))

        next_url = path + (("?" + request.url.query) if request.url.query else "")
        resp = RedirectResponse(url=f"/login.html?next={next_url}", status_code=302)
        resp.headers["X-Auth-Gate"] = "bad-token-or-session-error"
        _clear_auth_cookies(resp, request)
        return resp

    norm = _norm_path_for_perm(path)
    required = REQUIRED_PERMS.get(norm)

    sub = payload.get("sub")
    role = (payload.get("role") or "").lower()
    payload_empresa_id = _int_or_none(payload.get("empresa_id"))
    cookie_empresa_id = _int_or_none(empresa_cookie)
    effective_empresa_id = cookie_empresa_id or payload_empresa_id

    billing_locked = _billing_locked_for_empresa_id(effective_empresa_id)

    if billing_locked and norm in BILLING_BLOCKED_HTML_PATHS and norm not in BILLING_ALLOWED_WHEN_LOCKED:
        return _html_billing_redirect(
            path,
            request.url.query,
            "Seu plano está vencido. Renove para continuar usando este módulo.",
        )

    if not required:
        resp = await call_next(request)
        _no_cache_html(resp)
        _apply_billing_header(resp, billing_locked)
        return resp

    if not (isinstance(sub, str) and sub.startswith("colab-")):
        resp = await call_next(request)
        _no_cache_html(resp)
        _apply_billing_header(resp, billing_locked)
        return resp

    if role == "admin":
        resp = await call_next(request)
        _no_cache_html(resp)
        _apply_billing_header(resp, billing_locked)
        return resp

    try:
        colab_id = int(sub.split("colab-", 1)[1])
    except Exception as e:
        print("[AUTH_GATE] sub inválido:", repr(e), "sub=", repr(sub))
        return _html_forbidden("Identidade inválida no token de sessão.")

    db: Session = SessionLocal()
    try:
        rows = db.execute(
            text(
                """
                SELECT p.id
                  FROM colaboradores_permissoes cp
                  JOIN permissoes p ON p.id = cp.permissao_id
                 WHERE cp.colaborador_id = :cid
                """
            ),
            {"cid": colab_id},
        ).fetchall()
        perms = {r[0] for r in rows}
    except Exception as e:
        print("[AUTH_GATE] erro consultando permissões:", repr(e))
        next_url = path + (("?" + request.url.query) if request.url.query else "")
        resp = RedirectResponse(url=f"/login.html?next={next_url}", status_code=302)
        resp.headers["X-Auth-Gate"] = "permission-query-error"
        _clear_auth_cookies(resp, request)
        return resp
    finally:
        db.close()

    if required not in perms:
        return _html_forbidden(f"Você não tem permissão para acessar esta página ({required}).")

    resp = await call_next(request)
    _no_cache_html(resp)
    _apply_billing_header(resp, billing_locked)
    return resp


# =======================================
# Cache-control para assets
# =======================================
@app.middleware("http")
async def cache_control_assets(request: Request, call_next):
    resp: StarletteResponse = await call_next(request)
    path = request.url.path or ""

    if path.startswith("/api/"):
        return resp

    if resp.status_code in (301, 302, 303, 307, 308):
        resp.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
        resp.headers["Pragma"] = "no-cache"
        resp.headers["Expires"] = "0"
        resp.headers["X-ZC-Build"] = str(BUILD_ID)
        return resp

    if path in (
        "/service-worker.js",
        "/sw.js",
        "/manifest.json",
        "/manifest.webmanifest",
        "/favicon.ico",
        "/favicon.png",
        "/version.json",
    ):
        resp.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
        resp.headers["Pragma"] = "no-cache"
        resp.headers["Expires"] = "0"
        resp.headers["X-ZC-Build"] = str(BUILD_ID)
        return resp

    if path.endswith(".html") or ("/partials/" in path):
        resp.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
        resp.headers["Pragma"] = "no-cache"
        resp.headers["Expires"] = "0"
        resp.headers["X-ZC-Build"] = str(BUILD_ID)
        return resp

    is_front_asset = (
        path.startswith("/frontend/")
        or path.startswith("/static/")
        or path.startswith("/assets/")
        or path.startswith("/img/")
    )

    is_asset_ext = path.lower().endswith(CACHE_BUST_EXTS)

    if is_front_asset and is_asset_ext:
        if request.query_params.get("v") == str(BUILD_ID):
            resp.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        else:
            resp.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"

        resp.headers["Pragma"] = "no-cache"
        resp.headers["Expires"] = "0"
        resp.headers["X-ZC-Build"] = str(BUILD_ID)
        return resp

    return resp


# =======================================
# 404 bonitinho
# =======================================
@app.exception_handler(StarletteHTTPException)
async def custom_http_exception_handler(request: Request, exc: StarletteHTTPException):
    path = request.url.path

    if (
        exc.status_code == 404
        and _wants_html(request)
        and not path.startswith("/api")
        and not path.startswith("/frontend")
    ):
        return HTMLResponse(
            """<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8"/>
  <title>Página não encontrada • ZapsChat</title>
</head>
<body style="font-family:system-ui;background:#111;color:#eee;display:grid;place-items:center;min-height:100vh;margin:0">
  <main style="max-width:520px;text-align:center;padding:24px">
    <h1>Não conseguimos encontrar essa página</h1>
    <p>Verifique se o endereço está correto ou volte para uma área existente do painel.</p>
    <p>
      <a style="color:#22c55e" href="/dashboard">Ir para o Dashboard</a> ·
      <a style="color:#22c55e" href="/atendimentos">Ir para Atendimentos</a> ·
      <a style="color:#22c55e" href="/login">Login</a>
    </p>
  </main>
</body>
</html>""",
            status_code=404,
            headers={
                "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
                "Pragma": "no-cache",
                "Expires": "0",
                "X-ZC-Build": str(BUILD_ID),
            },
        )

    return await fastapi_http_exception_handler(request, exc)


# =======================================
# Rotas / Routers
# =======================================
app.include_router(seo_landing_router)
app.include_router(auth.router, prefix="/api")
app.include_router(usuarios.router, prefix="/api", tags=["Usuarios"])
app.include_router(clientes.router, prefix="/api", tags=["Clientes"])

app.include_router(atendimento_conversas_router, prefix="/api/atendimento")
app.include_router(atendimento.router, prefix="/api/atendimento", tags=["Atendimento"])
app.include_router(integracoes_valora_router, prefix="/api/atendimento", tags=["Integrações - Valora"])

app.include_router(email_router)
app.include_router(disparos_router)

app.include_router(atendimento_chat_router.router, prefix="/api/atendimento", tags=["Atendimento – Chat"])
app.include_router(ws_router)

app.include_router(cliente_onboarding.router, prefix="/api/onboarding", tags=["Onboarding"])
app.include_router(empresa.router, tags=["Empresas"])
app.include_router(atendimento_busca.router, prefix="/api", tags=["Busca"])

app.include_router(admin_planos.router)
app.include_router(admin_assinaturas_router)
app.include_router(midias_router, tags=["Mídias"])
app.include_router(atendimento_ia_router.router)

app.include_router(atendimento_midias_router, prefix="/api/atendimento", tags=["Atendimento – Mídias"])
app.include_router(atendimento_send_router, prefix="/api/atendimento", tags=["Atendimento – Envio"])

app.include_router(departamentos_router.router, prefix="/api", tags=["Departamentos"])
app.include_router(departamentos_router.compat_router, prefix="/api", tags=["Departamentos"])

# ✅ Filas
app.include_router(filas_router.router, prefix="/api", tags=["Filas"])

app.include_router(permissoes_router)
app.include_router(colaboradores_router, prefix="/api", tags=["Colaboradores"])
app.include_router(dashboard_router.router, prefix="/api", tags=["Dashboard"])

app.include_router(chatbot_config_router.router)
app.include_router(remove_instance_router, prefix="/api")
app.include_router(internal_chat_router.router)
app.include_router(clients_central_router)
app.include_router(chatbot_setores_router.router)
app.include_router(evolution_router)

app.include_router(perfil_router)
app.include_router(meu_plano_router)
app.include_router(atendimento_transferencia_router)
app.include_router(billing_asaas_router)


# =======================================
# Health / Robots / Favicon
# =======================================
@app.get("/healthz")
def healthz():
    return {
        "ok": True,
        "ts": datetime.now(timezone.utc).isoformat(),
        "build": BUILD_ID,
        "allowed_hosts": ALLOWED_HOSTS,
    }


@app.get("/ping")
def ping():
    return {"pong": True, "build": BUILD_ID}


FAVICON_PATH = FRONTEND_DIR / "img" / "fav-icon.png"


@app.get("/favicon.ico")
def favicon():
    if FAVICON_PATH.is_file():
        return FileResponse(
            str(FAVICON_PATH),
            media_type="image/png",
            headers={
                "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
                "Pragma": "no-cache",
                "Expires": "0",
                "X-ZC-Build": str(BUILD_ID),
            },
        )
    raise HTTPException(status_code=404, detail="favicon not found")


@app.get("/favicon.png")
def favicon_png():
    if FAVICON_PATH.is_file():
        return FileResponse(
            str(FAVICON_PATH),
            media_type="image/png",
            headers={
                "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
                "Pragma": "no-cache",
                "Expires": "0",
                "X-ZC-Build": str(BUILD_ID),
            },
        )
    raise HTTPException(status_code=404, detail="favicon not found")


@app.get("/robots.txt", response_class=HTMLResponse, include_in_schema=False)
def robots():
    if ENV == "dev":
        return HTMLResponse(
            "User-agent: *\nDisallow: /\n",
            media_type="text/plain",
            headers={
                "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
                "Pragma": "no-cache",
                "Expires": "0",
                "X-ZC-Build": str(BUILD_ID),
            },
        )

    return HTMLResponse(
        "User-agent: *\nAllow: /\nSitemap: https://zapschat.com.br/sitemap.xml\n",
        media_type="text/plain",
        headers={
            "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
            "Pragma": "no-cache",
            "Expires": "0",
            "X-ZC-Build": str(BUILD_ID),
        },
    )


@app.get("/version.json")
def version_json():
    return JSONResponse(
        {
            "build": BUILD_ID,
            "env": ENV,
            "ts": datetime.now(timezone.utc).isoformat(),
            "allowed_hosts": ALLOWED_HOSTS,
        },
        headers={
            "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
            "Pragma": "no-cache",
            "Expires": "0",
            "X-ZC-Build": str(BUILD_ID),
        },
    )


# =======================================
# Limpeza manual de sessão/cookies antigos
# =======================================
@app.get("/limpar-sessao", include_in_schema=False)
def limpar_sessao(request: Request):
    next_url = request.query_params.get("next") or "/login"

    if not str(next_url).startswith("/") or str(next_url).startswith("//"):
        next_url = "/login"

    resp = RedirectResponse(url=next_url, status_code=302)
    resp.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    resp.headers["Pragma"] = "no-cache"
    resp.headers["Expires"] = "0"
    resp.headers["X-Auth-Gate"] = "manual-session-clear"

    _clear_auth_cookies(resp, request)
    return resp


@app.get("/sair", include_in_schema=False)
def sair(request: Request):
    resp = RedirectResponse(url="/login?logout=1", status_code=302)
    resp.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    resp.headers["Pragma"] = "no-cache"
    resp.headers["Expires"] = "0"
    resp.headers["X-Auth-Gate"] = "manual-logout"

    _clear_auth_cookies(resp, request)
    return resp


@app.get("/logout", include_in_schema=False)
def logout_alias(request: Request):
    resp = RedirectResponse(url="/login?logout=1", status_code=302)
    resp.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    resp.headers["Pragma"] = "no-cache"
    resp.headers["Expires"] = "0"
    resp.headers["X-Auth-Gate"] = "manual-logout-alias"

    _clear_auth_cookies(resp, request)
    return resp


# =======================================
# Partials HTML
# =======================================
@app.get("/frontend/partials/{path:path}", include_in_schema=False)
def partial(path: str):
    partials_dir = (FRONTEND_DIR / "partials").resolve()
    target = (partials_dir / path).resolve()

    if not str(target).startswith(str(partials_dir)):
        raise HTTPException(status_code=404)

    if not target.is_file():
        raise HTTPException(status_code=404)

    return _html_response_from_file(target, inject_build_script=False)


# =======================================
# uploads públicos + arquivos estáticos
# =======================================
app.mount("/uploads", StaticFiles(directory=str(UPLOADS_DIR)), name="uploads")

if FRONTEND_DIR.is_dir():
    img_dir = FRONTEND_DIR / "img"
    if img_dir.is_dir():
        app.mount("/img", StaticFiles(directory=str(img_dir)), name="img")

    static_dir = FRONTEND_DIR / "static"
    if static_dir.is_dir():
        app.mount("/static", StaticFiles(directory=str(static_dir)), name="static")

    assets_dir = FRONTEND_DIR / "assets"
    if assets_dir.is_dir():
        app.mount("/assets", StaticFiles(directory=str(assets_dir)), name="assets")

    app.mount("/frontend", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
else:
    LOG("[STATIC] 'frontend' não encontrado — pulando mount.")


# =======================================
# Rotas de mídia (binário direto) – LEGACY
# =======================================
@app.get("/media_bin/{midia_id}")
def serve_media_bin(
    midia_id: int,
    request: Request,
    user=Depends(get_current_user),
):
    url = f"/api/atendimento/midias/{midia_id}"
    if request.url.query:
        url = f"{url}?{request.url.query}"
    return RedirectResponse(url=url, status_code=307)


@app.get("/api/env/evolution")
def evolution_env(identity: dict = Depends(auth_router.get_current_identity)):
    """
    Compatibilidade segura para clientes antigos.

    A URL e a chave da Evolution são segredos exclusivos do backend e nunca
    devem ser entregues ao navegador. A rota também exige sessão válida.
    """
    _ = identity
    configured = bool(
        str(os.getenv("EVOLUTION_URL", "")).strip()
        and str(
            os.getenv("EVOLUTION_APIKEY", "")
            or os.getenv("EVOLUTION_KEY", "")
        ).strip()
    )
    return JSONResponse(
        {
            "configured": configured,
            "directBrowserAccess": False,
        },
        headers={"Cache-Control": "no-store"},
    )


# =======================================
# Rotas “limpas” (sem .html)
# =======================================
def _page_file(name: str) -> Path:
    return FRONTEND_DIR / f"{name}.html"


def _page_response(name: str):
    f = _page_file(name)
    if f.is_file():
        return _html_response_from_file(f)
    raise HTTPException(status_code=404)


def _discover_pages() -> list[str]:
    if not FRONTEND_DIR.is_dir():
        return []

    pages: list[str] = []
    for p in FRONTEND_DIR.glob("*.html"):
        stem = p.stem.strip()
        if stem and not stem.startswith("_"):
            pages.append(stem)

    return sorted(set(pages))


PAGES = _discover_pages()


@app.get("/", response_class=HTMLResponse)
async def root_redirect(request: Request):
    token = request.cookies.get(ACCESS_COOKIE_NAME)
    emp = request.cookies.get("empresa_id") or request.cookies.get("EMPRESA_ID")

    if token and emp:
        try:
            auth_router._decode_token(token)
            return RedirectResponse(url="/dashboard", status_code=302)
        except Exception as e:
            print("[ROOT] token inválido/quebrado:", repr(e))

    f = _page_file("inicio")
    if f.is_file():
        resp = _html_response_from_file(f)
        if token or emp:
            _clear_auth_cookies(resp, request)
            resp.headers["X-Auth-Gate"] = "root-stale-cookie-cleared"
        return resp

    target = "login" if "login" in PAGES else ("index" if "index" in PAGES else None)
    if target and _page_file(target).is_file():
        resp = _html_response_from_file(_page_file(target))
        if token or emp:
            _clear_auth_cookies(resp, request)
            resp.headers["X-Auth-Gate"] = "root-stale-cookie-cleared"
        return resp

    return {
        "ok": True,
        "msg": "Backend ZapsChat API (front não encontrado).",
        "build": BUILD_ID,
    }



@app.get("/zapschat/abrir-conversa", include_in_schema=False)
def zapschat_abrir_conversa(
    telefone: str = "",
    origem: str = "valora",
    cliente_id: str = "",
):
    digits = re.sub(r"\D+", "", str(telefone or ""))

    params = {
        "origem": origem or "valora",
    }

    if digits:
        params["abrir_telefone"] = digits
    else:
        params["abrir_erro"] = "telefone_invalido"

    if cliente_id:
        params["valora_cliente_id"] = str(cliente_id)

    return RedirectResponse(url=f"/atendimentos?{urlencode(params)}", status_code=302)

@app.get("/dashboard", include_in_schema=False)
def dashboard():
    return _page_response("dashboard")


def _make_handler(name: str):
    async def _handler(_name=name):
        return _page_response(_name)

    return _handler


RESERVED_PAGES = {"dashboard"}

for _name in PAGES:
    if _name in RESERVED_PAGES:
        continue

    f = _page_file(_name)
    if f.is_file():
        app.add_api_route(
            f"/{_name}",
            endpoint=_make_handler(_name),
            methods=["GET"],
            include_in_schema=False,
        )


@app.get("/{page_name}.html", response_class=HTMLResponse, include_in_schema=False)
async def legacy_html(page_name: str, request: Request):
    if page_name.lower().startswith("api"):
        raise HTTPException(status_code=404)

    if page_name in PAGES and _page_file(page_name).is_file():
        target = f"/{page_name}"
        if request.url.query:
            target = f"{target}?{request.url.query}"
        return RedirectResponse(url=target, status_code=307)

    raise HTTPException(status_code=404)


# =======================================
# Handlers Evolution/WebSocket
# =======================================
LOG("Handlers Evolution/WebSocket prontos (via registry do pacote backend.integrations.evolution).")


# =======================================
# Startup/Shutdown
# =======================================
@app.on_event("startup")
async def _start_integrations():
    import time

    LOG(f"[STARTUP] ENV={ENV}")
    LOG(f"[STARTUP] BUILD_ID={BUILD_ID}")
    LOG(f"[STARTUP] ALLOWED_HOSTS={ALLOWED_HOSTS}")

    db_ok = False
    for i in range(10):
        try:
            with engine.begin() as conn:
                conn.exec_driver_sql("SELECT 1")
                Base.metadata.create_all(bind=conn)
            normalize_atendimento_claim_state(engine, LOG)
            db_ok = True
            LOG("[STARTUP] DB ok e tabelas garantidas.")
            break
        except Exception as e:
            LOG(f"[STARTUP][DB] tentativa {i + 1}/10 falhou: {e}")
            time.sleep(2)

    if not db_ok:
        raise RuntimeError("DB indisponível após 10 tentativas no startup.")

    loop = asyncio.get_running_loop()
    app.state.loop = loop
    # WebSockets pertencem ao loop principal. O Rabbit dedicado usa a ponte
    # thread-safe do WebSocketManager para emitir sem travar as páginas.
    conexoes_ativas.bind_loop(loop)
    app.state.rabbit_task = None
    app.state.rabbit_stop = None
    app.state.evo_task = None
    app.state.evo_stop = None

    if USE_RABBIT:
        try:
            rabbit_task, rabbit_stop = await start_rabbit_consumer(loop, HANDLERS, EvoEvent)
            app.state.rabbit_task = rabbit_task
            app.state.rabbit_stop = rabbit_stop
            LOG("[STARTUP] RabbitMQ consumer ligado.")
        except Exception as e:
            LOG(f"[STARTUP][Rabbit] falha ao iniciar consumer: {e}")
    else:
        if not RABBIT_ENABLED_BY_ENV:
            LOG("[STARTUP] RabbitMQ desabilitado (USE_RABBIT=false).")
        elif not RABBIT_CONSUME_ENABLED:
            LOG("[STARTUP] RabbitMQ desabilitado (RABBITMQ_CONSUME_ENABLED=false).")
        else:
            LOG("[STARTUP] RabbitMQ desabilitado (sem RABBITMQ_URI/RABBITMQ_URL/AMQP_URL).")

    if USE_EVO_WS:
        try:
            evo_ret = await start_evo_ws_listener(loop, HANDLERS, EvoEvent)
            if isinstance(evo_ret, tuple) and len(evo_ret) == 2:
                app.state.evo_task, app.state.evo_stop = evo_ret
            LOG("[STARTUP] Evolution WS listener ligado.")
        except Exception as e:
            LOG(f"[STARTUP][EvoWS] falha ao iniciar listener: {e}")
    else:
        LOG("[STARTUP] Evolution WS listener desabilitado (EVOLUTION_WS_SUBSCRIBE != 'true').")

    if USE_RABBIT and USE_EVO_WS:
        LOG("⚠ RabbitMQ + Evolution WS ativos. Mensagens ficam no Rabbit; WS só QR/connection.")


async def _stop_named_task(task, *, name: str, timeout: float = 3.0) -> None:
    if not task:
        return

    try:
        if task.done():
            try:
                task.result()
            except asyncio.CancelledError:
                pass
            except Exception as e:
                LOG(f"[SHUTDOWN][{name}] task já finalizada com erro: {e}")
            return

        try:
            await asyncio.wait_for(task, timeout=timeout)
        except asyncio.CancelledError:
            pass
        except asyncio.TimeoutError:
            try:
                task.cancel()
            except Exception:
                pass

            try:
                await asyncio.wait_for(task, timeout=1.0)
            except asyncio.CancelledError:
                pass
            except asyncio.TimeoutError:
                LOG(f"[SHUTDOWN][{name}] task não finalizou após cancelamento.")
            except Exception as e:
                LOG(f"[SHUTDOWN][{name}] erro após cancelamento: {e}")

        except Exception as e:
            LOG(f"[SHUTDOWN][{name}] erro aguardando task: {e}")
            try:
                task.cancel()
            except Exception:
                pass

    except asyncio.CancelledError:
        pass


@app.on_event("shutdown")
async def _stop_integrations():
    LOG("[SHUTDOWN] encerrando integrações...")

    stop = getattr(app.state, "rabbit_stop", None)
    if stop:
        try:
            await stop()
        except asyncio.CancelledError:
            pass
        except Exception as e:
            LOG(f"[SHUTDOWN][Rabbit] erro no stop: {e}")

    task = getattr(app.state, "rabbit_task", None)
    await _stop_named_task(task, name="Rabbit", timeout=3.0)

    evo_stop = getattr(app.state, "evo_stop", None)
    if evo_stop:
        try:
            await evo_stop()
        except asyncio.CancelledError:
            pass
        except Exception as e:
            LOG(f"[SHUTDOWN][EvoWS] erro no stop: {e}")

    evo_task = getattr(app.state, "evo_task", None)
    await _stop_named_task(evo_task, name="EvoWS", timeout=3.0)

    LOG("[SHUTDOWN] integrações encerradas.")