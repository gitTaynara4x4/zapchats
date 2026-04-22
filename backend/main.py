from __future__ import annotations

import os
import secrets
import asyncio
from urllib.parse import quote_plus
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
from backend.routers.email import router as email_router
from backend.routers.disparos import router as disparos_router
from backend.routers import chatbot_setores as chatbot_setores_router
from backend.routers import atendimento_conversas
from backend.routers import internal_chat as internal_chat_router
from backend.websocket_manager import router as ws_router
from backend.routers import atendimentoia as atendimento_ia_router
from backend.routers import atendimento_chat as atendimento_chat_router
from backend.routers.clients_central import router as clients_central_router
from backend.routers import (
    auth, usuarios, clientes, atendimento,
    cliente_onboarding, empresa, atendimento_busca
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

# DB
from backend.database import Base, engine, SessionLocal
from backend import models

# Integrações Evolution (NOVO pacote)
from backend.integrations.evolution.api.remove_instance import router as remove_instance_router
from backend.integrations.evolution.api.router import router as evolution_router
from backend.integrations.evolution.transport.rabbit_consumer import start_rabbit_consumer
from backend.integrations.evolution.transport.ws_listener import start_evo_ws_listener

# IMPORTANTE:
# este import dispara o __init__ do pacote de handlers e registra os módulos
# no registry compartilhado.
from backend.integrations.evolution import handlers as _evolution_handlers  # noqa: F401
from backend.integrations.evolution.handlers.shared import HANDLERS, EvoEvent

import backend.routers.auth as auth_router
from backend.routers.auth import get_current_user

# Plans / billing
from backend.utils.plans import is_billing_locked

# =======================================
# Config & utils
# =======================================
def LOG(*args):
    print("[MAIN]", *args)


load_dotenv()

ENV = (os.getenv("ENV", "dev") or "dev").lower()

# === Versão do build (cache-buster) ===
BUILD_ID = os.getenv("BUILD_ID") or datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")

# Caminhos do frontend
BASE_DIR = Path(__file__).resolve().parent.parent
FRONTEND_DIR = BASE_DIR / "frontend"

# ✅ uploads: caminho absoluto + cria se faltar
UPLOADS_DIR = BASE_DIR / "uploads"
UPLOADS_DIR.mkdir(parents=True, exist_ok=True)

DEV_ORIGINS = [
    "http://127.0.0.1:8000",
    "http://localhost:8000",
    "http://127.0.0.1:5500",
    "http://localhost:5500",
]
PROD_ORIGINS = ["https://zapschat.com.br", "https://www.zapschat.com.br"]
ALLOW_ORIGINS = DEV_ORIGINS if ENV == "dev" else PROD_ORIGINS

# ---- Flags de integração Evolution/Rabbit ----
USE_RABBIT = any(
    os.getenv(k)
    for k in ("RABBITMQ_URI", "RABBITMQ_URL", "AMQP_URL")
)
USE_EVO_WS = (os.getenv("EVOLUTION_WS_SUBSCRIBE", "true").lower() == "true")

# Cookies / CSRF
ACCESS_COOKIE_NAME = os.getenv("ACCESS_COOKIE_NAME", "access_token")

COOKIE_SAMESITE = (os.getenv("COOKIE_SAMESITE", "lax") or "lax").lower()
if COOKIE_SAMESITE not in ("lax", "strict", "none"):
    COOKIE_SAMESITE = "lax"

CSRF_COOKIE_NAME = os.getenv("CSRF_COOKIE_NAME", "csrf_token")
CSRF_COOKIE_PATH = os.getenv("CSRF_COOKIE_PATH", "/api/auth/refresh")
CSRF_COOKIE_MAX_AGE = int(os.getenv("CSRF_COOKIE_MAX_AGE", str(60 * 60 * 24 * 30)))

# Trusted hosts
ALLOWED_HOSTS = (os.getenv(
    "ALLOWED_HOSTS",
    "localhost,127.0.0.1,zapschat.com.br,www.zapschat.com.br"
) or "").split(",")

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


def _clear_auth_cookies(resp: StarletteResponse):
    try:
        resp.delete_cookie(ACCESS_COOKIE_NAME, path="/")
    except Exception:
        pass

    for k in ("empresa_id", "EMPRESA_ID"):
        try:
            resp.delete_cookie(k, path="/")
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

# Middlewares
app.add_middleware(GZipMiddleware, minimum_size=1024)
app.add_middleware(
    TrustedHostMiddleware,
    allowed_hosts=[h.strip() for h in ALLOWED_HOSTS if h.strip()]
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOW_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=[
        "Authorization", "Content-Type", "X-CSRF-Token",
        "X-Empresa-Id",
    ],
    expose_headers=["Retry-After", "X-Auth-Gate", "X-Billing-Locked"],
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

        if token and emp:
            try:
                auth_router._decode_token(token)
            except Exception:
                resp = await call_next(request)
                _clear_auth_cookies(resp)
                return resp

            next_url = request.query_params.get("next") or "/dashboard"
            return RedirectResponse(url=next_url, status_code=302)

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
                return await call_next(request)

            next_url = p + (("?" + request.url.query) if request.url.query else "")
            return RedirectResponse(url=f"/login.html?next={next_url}", status_code=302)

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
    "/configuracoes": "config.editar",
    "/chat-interno": "chatinterno.ver",
    "/chatbot": "chatbot.configurar",
    "/atendimentos": "atendimento.ver",
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
        "/inicio", "/inicio.html",
        "/login", "/login.html",
        "/criar-empresa", "/criar-empresa.html",
        "/esqueci_senha", "/esqueci_senha.html",

        "/admin-planos", "/admin-planos.html",
        "/planos", "/planos.html",
        "/admin-assinaturas", "/admin-assinaturas.html",

        "/frontend/admin-planos.html",
        "/frontend/planos.html",
        "/frontend/admin-assinaturas.html",
    }

    PUBLIC_PREFIXES = (
        "/api/auth",
        "/img", "/uploads",
        "/static", "/assets",
        "/favicon", "/robots.txt", "/manifest",
        "/ws",
        "/healthz", "/ping",
        "/version.json",
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
        return resp

    try:
        payload = auth_router._decode_token(token)
    except HTTPException:
        next_url = path + (("?" + request.url.query) if request.url.query else "")
        resp = RedirectResponse(url=f"/login.html?next={next_url}", status_code=302)
        resp.headers["X-Auth-Gate"] = "bad-token"
        _clear_auth_cookies(resp)
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
    except Exception:
        return _html_forbidden("Identidade inválida no token de sessão.")

    db: Session = SessionLocal()
    try:
        rows = db.execute(text("""
            SELECT p.id
              FROM colaboradores_permissoes cp
              JOIN permissoes p ON p.id = cp.permissao_id
             WHERE cp.colaborador_id = :cid
        """), {"cid": colab_id}).fetchall()
        perms = {r[0] for r in rows}
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
        resp.headers.setdefault("Cache-Control", "no-store")
        resp.headers.setdefault("Pragma", "no-cache")
        resp.headers.setdefault("Expires", "0")
        return resp

    if path in ("/service-worker.js", "/sw.js", "/manifest.json", "/manifest.webmanifest"):
        resp.headers["Cache-Control"] = "no-cache, max-age=0, must-revalidate"
        resp.headers["Pragma"] = "no-cache"
        resp.headers["Expires"] = "0"
        return resp

    if path.endswith(".html") or ("/partials/" in path):
        resp.headers.setdefault("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        resp.headers.setdefault("Pragma", "no-cache")
        resp.headers.setdefault("Expires", "0")
        return resp

    if path.endswith((".js", ".mjs", ".css", ".map", ".json")) and (
        path.startswith("/static/") or path.startswith("/assets/") or path.startswith("/frontend/")
    ):
        resp.headers["Cache-Control"] = "no-cache, max-age=0, must-revalidate"
        resp.headers["Pragma"] = "no-cache"
        resp.headers["Expires"] = "0"
        return resp

    if path.endswith((".png", ".jpg", ".jpeg", ".webp", ".svg", ".ico", ".woff", ".woff2", ".ttf")):
        resp.headers.setdefault("Cache-Control", "public, max-age=86400")

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
        html = """<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8"/>
  <title>Página não encontrada • zapschat</title>
  <style>
    :root{--topbar-h:44px;--card:#161617;--border:#27272a;--fg:#e5e7eb;--muted:#9ca3af;}
    html:not(.dark){--card:#fff;--border:#e5e7eb;--fg:#1f2937;--muted:#6b7280;}
    html, body{margin:0;padding:0;border:0;}
    html{
      background:linear-gradient(90deg,#22c55e 0%, #16a34a 50%, #10b981 100%) 0 0 / 100% 6px no-repeat,
                 var(--card);
      background-attachment:fixed;
    }
    html:not(.dark){
      background:linear-gradient(90deg,#22c55e 0%, #16a34a 50%, #10b981 100%) 0 0 / 100% 6px no-repeat,#fff;
    }
    body{
      font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;
      color:var(--fg);
      min-height:100vh;
      display:flex;
      align-items:center;
      justify-content:center;
      padding:calc(var(--topbar-h) + 24px) 24px 24px;
      box-sizing:border-box;
    }
    .topline-bar{
      position:fixed;top:0;left:0;right:0;height:var(--topbar-h);
      display:flex;align-items:center;justify-content:flex-end;gap:.75rem;
      padding:6px 14px 0;background:transparent;z-index:60;
    }
    .theme-toggle{
      --w:78px;--h:34px;--p:3px;--k:28px;
      --dx: calc(var(--w) - var(--k) - var(--p)*2);
      position:relative;width:var(--w);height:var(--h);padding:var(--p);
      border-radius:999px;cursor:pointer;outline:none;border:1px solid;
      display:inline-block;isolation:isolate;background:#eceff3;border-color:#d5d9e0;
      box-shadow:inset 0 2px 4px rgba(0,0,0,.06), inset 0 -1px 2px rgba(0,0,0,.05);
      transition:background .3s ease,border-color .3s ease,box-shadow .3s ease;
      line-height:0;
    }
    html.dark .theme-toggle{
      background:#2f323a;border-color:#3a3e46;
      box-shadow:inset 0 2px 5px rgba(0,0,0,.35), inset 0 -1px 2px rgba(255,255,255,.03);
    }
    .theme-toggle .slot{position:absolute;top:50%;transform:translateY(-50%);width:28px;height:28px;display:grid;place-items:center;pointer-events:none;opacity:.75;}
    .theme-toggle .slot.left{left:8px;}
    .theme-toggle .slot.right{right:8px;}
    .theme-toggle .slot svg{width:18px;height:18px;display:block;}
    .theme-toggle .slot svg *{stroke:#9ca3af;}
    html.dark .theme-toggle .slot svg *{stroke:#8a93a1;}
    .theme-toggle .thumb{
      position:absolute;left:var(--p);top:50%;width:var(--k);height:var(--k);border-radius:999px;
      transform:translate(0,-50%);
      transition:transform .38s cubic-bezier(.28,1.2,.43,1),box-shadow .2s ease,background .3s ease;
      display:grid;place-items:center;overflow:hidden;
      background:radial-gradient(120% 120% at 30% 30%, rgba(255,255,255,.7), rgba(255,255,255,.25) 45%, rgba(255,255,255,.08) 65%),
               linear-gradient(180deg,#f8c266,#f59e0b);
      box-shadow:0 4px 8px rgba(0,0,0,.18), inset 0 0 0 1px rgba(255,255,255,.25);
    }
    html.dark .theme-toggle .thumb{
      transform:translate(var(--dx), -50%) !important;
      background:radial-gradient(120% 120% at 30% 30%, rgba(255,255,255,.7), rgba(255,255,255,.25) 45%, rgba(255,255,255,.08) 65%),
               linear-gradient(180deg,#6ba6ff,#2563eb) !important;
      box-shadow:0 6px 10px rgba(0,0,0,.35), inset 0 0 0 1px rgba(255,255,255,.22);
    }
    main.wrap{max-width:520px;width:100%;text-align:center;}
    .icon{font-size:32px;margin-bottom:10px;width:clamp(260px, 34vw, 340px);height:clamp(260px, 34vw, 340px);margin-left:auto;margin-right:auto;}
    h1{font-size:22px;margin-bottom:8px;}
    p{font-size:14px;line-height:1.6;color:var(--muted);margin-bottom:6px;}
    .actions{margin-top:16px;display:flex;flex-wrap:wrap;gap:8px;justify-content:center;}
    a.btn{display:inline-flex;align-items:center;justify-content:center;padding:8px 14px;border-radius:999px;font-size:14px;text-decoration:none;border:1px solid var(--border);background:var(--card);color:var(--fg);}
  </style>
</head>
<body>
  <div class="topline-bar">
    <button id="themeSwitch" class="theme-toggle" aria-label="Alternar tema" aria-pressed="false">
      <span class="slot left" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="3.5" fill="none"/>
          <line x1="12" y1="2" x2="12" y2="5"/><line x1="12" y1="19" x2="12" y2="22"/>
          <line x1="2" y1="12" x2="5" y2="12"/><line x1="19" y1="12" x2="22" y2="12"/>
          <line x1="4.22" y1="4.22" x2="6.34" y2="6.34"/><line x1="17.66" y1="17.66" x2="19.78" y2="19.78"/>
          <line x1="4.22" y1="19.78" x2="6.34" y2="17.66"/><line x1="17.66" y1="6.34" x2="19.78" y2="4.22"/>
        </svg>
      </span>
      <span class="slot right" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 1 0 9.8 9.8z" fill="none"/>
        </svg>
      </span>
      <span class="thumb" aria-hidden="true"></span>
    </button>
  </div>

  <main class="wrap">
    <div id="lottie404" class="icon"></div>
    <h1>Não conseguimos encontrar essa página</h1>
    <p>Não encontramos a página que você tentou acessar.</p>
    <p>Verifique se o endereço está correto ou volte para uma área existente do painel.</p>
    <div class="actions">
      <a href="/dashboard" class="btn">Ir para o Dashboard</a>
      <a href="/atendimentos" class="btn">Ir para Atendimentos</a>
      <a href="/login" class="btn">Voltar para o login</a>
    </div>
  </main>

  <script>
  (function(){
    var html = document.documentElement;
    try{
      var saved = localStorage.getItem('theme');
      if (saved){ html.classList.toggle('dark', saved === 'dark'); }
    }catch(e){}

    var btn = document.getElementById('themeSwitch');
    if (!btn) return;

    function syncPressed(){
      btn.setAttribute('aria-pressed', String(html.classList.contains('dark')));
    }
    syncPressed();

    btn.addEventListener('click', function(){
      var willDark = !html.classList.contains('dark');
      html.classList.toggle('dark', willDark);
      try{ localStorage.setItem('theme', willDark ? 'dark' : 'light'); }catch(e){}
      syncPressed();
    });
  })();
  </script>

  <script src="https://cdnjs.cloudflare.com/ajax/libs/bodymovin/5.12.2/lottie.min.js"
          crossorigin="anonymous" referrerpolicy="no-referrer"></script>
  <script>
  (async function () {
    var container = document.getElementById('lottie404');
    if (!container) return;
    try {
      var res = await fetch('/frontend/js/404.json', { cache: 'no-store' });
      if (!res.ok) return;
      var data = await res.json();
      var lottiePlayer = window.lottie || window.bodymovin;
      if (!lottiePlayer || !lottiePlayer.loadAnimation) return;
      lottiePlayer.loadAnimation({
        container: container,
        renderer: 'svg',
        loop: true,
        autoplay: true,
        animationData: data
      });
    } catch (e) {}
  })();
  </script>
</body>
</html>"""
        return HTMLResponse(html, status_code=404)

    return await fastapi_http_exception_handler(request, exc)


# =======================================
# Rotas / Routers
# =======================================
app.include_router(auth.router, prefix="/api")
app.include_router(usuarios.router, prefix="/api", tags=["Usuarios"])
app.include_router(clientes.router, prefix="/api", tags=["Clientes"])

app.include_router(atendimento_conversas.router, prefix="/api/atendimento")
app.include_router(atendimento.router, prefix="/api/atendimento", tags=["Atendimento"])

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
# Health / Robots / Favicon
# =======================================
@app.get("/healthz")
def healthz():
    return {"ok": True, "ts": datetime.now(timezone.utc).isoformat()}


@app.get("/ping")
def ping():
    return {"pong": True}


FAVICON_PATH = FRONTEND_DIR / "img" / "fav-icon.png"


@app.get("/favicon.ico")
def favicon():
    if FAVICON_PATH.is_file():
        return FileResponse(str(FAVICON_PATH), media_type="image/png")
    raise HTTPException(status_code=404, detail="favicon not found")


@app.get("/favicon.png")
def favicon_png():
    if FAVICON_PATH.is_file():
        return FileResponse(str(FAVICON_PATH), media_type="image/png")
    raise HTTPException(status_code=404, detail="favicon not found")


@app.get("/robots.txt", response_class=HTMLResponse, include_in_schema=False)
def robots():
    if ENV == "dev":
        return HTMLResponse("User-agent: *\nDisallow: /\n", media_type="text/plain")
    return HTMLResponse(
        "User-agent: *\nAllow: /\nSitemap: https://zapschat.com.br/sitemap.xml\n",
        media_type="text/plain"
    )


@app.get("/version.json")
def version_json():
    return JSONResponse({"build": BUILD_ID}, headers={"Cache-Control": "no-store"})


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
def evolution_env():
    return JSONResponse({
        "apiUrl": os.getenv("EVOLUTION_URL", ""),
        "apiKey": os.getenv("EVOLUTION_APIKEY", ""),
        "defaultInstance": os.getenv("EVOLUTION_DEFAULT_INSTANCE", "")
    })


# =======================================
# Rotas “limpas” (sem .html)
# =======================================
def _page_file(name: str) -> Path:
    return FRONTEND_DIR / f"{name}.html"


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
        return RedirectResponse(url="/dashboard", status_code=302)

    f = _page_file("inicio")
    if f.is_file():
        return FileResponse(str(f))

    target = "login" if "login" in PAGES else ("index" if "index" in PAGES else None)
    if target and _page_file(target).is_file():
        return FileResponse(str(_page_file(target)))

    return {"ok": True, "msg": "Backend zapschat API (front não encontrado)."}


@app.get("/dashboard", include_in_schema=False)
def dashboard():
    f = _page_file("dashboard")
    if f.is_file():
        return FileResponse(str(f))
    raise HTTPException(status_code=404)


def _make_handler(name: str):
    async def _handler(_name=name):
        return FileResponse(str(_page_file(_name)))
    return _handler


RESERVED_PAGES = {"dashboard"}

for _name in PAGES:
    if _name in RESERVED_PAGES:
        continue
    f = _page_file(_name)
    if f.is_file():
        app.add_api_route(f"/{_name}", endpoint=_make_handler(_name), methods=["GET"], include_in_schema=False)


@app.get("/{page_name}.html", response_class=HTMLResponse, include_in_schema=False)
async def legacy_html(page_name: str):
    if page_name.lower().startswith("api"):
        raise HTTPException(status_code=404)

    if page_name in PAGES and _page_file(page_name).is_file():
        return RedirectResponse(url=f"/{page_name}", status_code=307)
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

    for i in range(10):
        try:
            with engine.begin() as conn:
                conn.exec_driver_sql("SELECT 1")
                Base.metadata.create_all(bind=conn)
            LOG("[STARTUP] DB ok e tabelas garantidas.")
            break
        except Exception as e:
            LOG(f"[STARTUP][DB] tentativa {i+1}/10 falhou: {e}")
            time.sleep(2)

    loop = asyncio.get_running_loop()
    app.state.loop = loop

    if USE_RABBIT:
        try:
            rabbit_task, rabbit_stop = await start_rabbit_consumer(loop, HANDLERS, EvoEvent)
            app.state.rabbit_task = rabbit_task
            app.state.rabbit_stop = rabbit_stop
            LOG("[STARTUP] RabbitMQ consumer ligado.")
        except Exception as e:
            LOG(f"[STARTUP][Rabbit] falha ao iniciar consumer: {e}")
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


@app.on_event("shutdown")
async def _stop_integrations():
    stop = getattr(app.state, "rabbit_stop", None)
    if stop:
        try:
            await stop()
        except Exception:
            pass

    task = getattr(app.state, "rabbit_task", None)
    if task:
        try:
            await asyncio.wait_for(task, timeout=3)
        except Exception:
            try:
                task.cancel()
            except Exception:
                pass

    evo_stop = getattr(app.state, "evo_stop", None)
    if evo_stop:
        try:
            await evo_stop()
        except Exception:
            pass

    evo_task = getattr(app.state, "evo_task", None)
    if evo_task:
        try:
            await asyncio.wait_for(evo_task, timeout=3)
        except Exception:
            try:
                evo_task.cancel()
            except Exception:
                pass


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

    return FileResponse(str(target), media_type="text/html; charset=utf-8")