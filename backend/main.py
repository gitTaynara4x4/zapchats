from __future__ import annotations
import os, secrets, asyncio
from urllib.parse import quote_plus
from typing import Any
from datetime import datetime, timezone
from pathlib import Path
from backend.routers.email import router as email_router
from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, Depends, APIRouter, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, RedirectResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.responses import Response as StarletteResponse
from starlette.middleware.gzip import GZipMiddleware
from starlette.middleware.trustedhost import TrustedHostMiddleware
from starlette.exceptions import HTTPException as StarletteHTTPException
from fastapi.exception_handlers import http_exception_handler as fastapi_http_exception_handler

from sqlalchemy.orm import Session
from sqlalchemy import text

# Routers / Integration
from backend.routers import atendimento_conversas
from backend.routers import internal_chat as internal_chat_router
from backend.integrations.remove_instance import router as remove_instance_router
from backend.integrations import remove_instance
from backend.database import Base, engine, SessionLocal, get_db
from backend import models
from backend.websocket_manager import router as ws_router
from backend.websocket_manager import conexoes_ativas
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

# ⚠️ Importa os DOIS routers de mídias com nomes distintos
from backend.routers.atendimento_midias import router as atendimento_midias_router  # /api/atendimento/midias/...
from backend.routers.midias import router as midias_router                          # prefix="/api/midias"

from backend.routers.atendimento_send import router as atendimento_send_router
from backend.routers import departamentos as departamentos_router
from backend.routers import chatbot_config as chatbot_config_router
from backend.routers import admin_planos
from backend.integrations.rabbit_consumer import start_rabbit_consumer
from backend.integrations.evo_ws_listener import start_evo_ws_listener

# JWT decode para gate de permissão
from backend.routers.auth import get_current_user
import backend.routers.auth as auth_router

# Evo handlers/registry
from backend.integrations.evo_handlers import (
    HANDLERS, EvoEvent, handler as evo_handler,
    force_qr_for_instance,
    normalize_mimetype,
    RABBIT_MONITOR,
    record_rabbit_event,
)

# =======================================
# Config & utils
# =======================================
def LOG(*args): print("[MAIN]", *args)

load_dotenv()

# === Versão do build (mude BUILD_ID a cada deploy; ou passe pelo ENV) ===
BUILD_ID = os.getenv("BUILD_ID") or datetime.utcnow().strftime("%Y%m%d%H%M%S")

# Caminhos do frontend
BASE_DIR = Path(__file__).resolve().parent.parent
FRONTEND_DIR = BASE_DIR / "frontend"

# ✅ uploads: caminho absoluto + cria se faltar (precisa existir ANTES do mount)
UPLOADS_DIR = BASE_DIR / "uploads"
UPLOADS_DIR.mkdir(parents=True, exist_ok=True)

ENV = os.getenv("ENV", "dev").lower()

DEV_ORIGINS = [
    "http://127.0.0.1:8000",
    "http://localhost:8000",
    "http://127.0.0.1:5500",
    "http://localhost:5500",
]

PROD_ORIGINS = ["https://zapschat.com.br", "https://www.zapschat.com.br"]
ALLOW_ORIGINS = DEV_ORIGINS if ENV == "dev" else PROD_ORIGINS

# ---- Flags de integração Evolution/Rabbit ----
# Se tiver URI de Rabbit, ligamos o consumer (fonte oficial das mensagens)
USE_RABBIT = bool(os.getenv("RABBITMQ_URI"))

# WebSocket da Evolution só liga se essa env for "true"
# (e mesmo assim, com FULL_EVENTS_WS sem MESSAGES_*, ele fica só pra QR/connection)
USE_EVO_WS = os.getenv("EVOLUTION_WS_SUBSCRIBE", "true").lower() == "true"

# Cookies / CSRF
# Obs.: para os cookies de sessão (login) já usamos lógica automática no auth.py.
# Aqui mantemos apenas VARs de CSRF e nome do cookie de sessão para o gate.
ACCESS_COOKIE_NAME = os.getenv("ACCESS_COOKIE_NAME", "access_token")
COOKIE_SAMESITE     = (os.getenv("COOKIE_SAMESITE", "lax").lower())  # "lax" | "strict" | "none"
CSRF_COOKIE_NAME    = os.getenv("CSRF_COOKIE_NAME", "csrf_token")
CSRF_COOKIE_PATH    = os.getenv("CSRF_COOKIE_PATH", "/api/auth/refresh")
CSRF_COOKIE_MAX_AGE = int(os.getenv("CSRF_COOKIE_MAX_AGE", str(60*60*24*30)))

# Trusted hosts (Traefik/EasyPanel já define Host; mantenha localhost p/ dev)
ALLOWED_HOSTS = os.getenv("ALLOWED_HOSTS",
                          "localhost,127.0.0.1,zapschat.com.br,www.zapschat.com.br").split(",")

def _is_https(request: Request) -> bool:
    """Detecta HTTPS atrás de proxy (Traefik/Nginx/EasyPanel) ou direto."""
    proto = (request.headers.get("x-forwarded-proto") or request.url.scheme or "").lower()
    return proto == "https"

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
    allow_methods=["GET","POST","PUT","PATCH","DELETE","OPTIONS"],
    allow_headers=[
        "Authorization","Content-Type","X-CSRF-Token",
        "X-Empresa-Id",
    ],
    expose_headers=["Retry-After", "X-Auth-Gate"],
)

# Cookie de CSRF (double-submit) só no /api/auth/refresh
@app.middleware("http")
async def ensure_csrf_cookie(request: Request, call_next):
    needs_csrf = request.url.path.startswith("/api/auth/refresh")
    has_cookie = request.cookies.get(CSRF_COOKIE_NAME)
    resp: StarletteResponse = await call_next(request)
    if needs_csrf and not has_cookie:
        token = secrets.token_urlsafe(32)
        # Secure = True somente se for HTTPS (auto)
        resp.set_cookie(
            key=CSRF_COOKIE_NAME, value=token,
            httponly=False,  # JS lê para enviar no header
            secure=_is_https(request),
            samesite=("none" if COOKIE_SAMESITE == "none" else "lax"),
            max_age=CSRF_COOKIE_MAX_AGE,
            path=CSRF_COOKIE_PATH,
        )
    # HSTS apenas em produção
    if ENV != "dev":
        resp.headers.setdefault("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload")
    resp.headers.setdefault("X-Content-Type-Options", "nosniff")
    resp.headers.setdefault("X-Frame-Options", "SAMEORIGIN")
    return resp

# ✅ Auto-redirect do /login quando já autenticado
@app.middleware("http")
async def login_autoredirect(request: Request, call_next):
    p = request.url.path
    if p in ("/login", "/login.html"):
        token = request.cookies.get(ACCESS_COOKIE_NAME)
        emp   = request.cookies.get("empresa_id") or request.cookies.get("EMPRESA_ID")
        if token and emp:
            next_url = request.query_params.get("next") or "/dashboard"
            return RedirectResponse(url=next_url, status_code=302)
    return await call_next(request)

# =======================================
# BLOQUEIO de acesso direto a /frontend/*
# (bloqueia HTML/partials para anônimos; libera JS/CSS/img)
# ✅ Allowlist para parciais públicos usados por login/boot
# =======================================
PUBLIC_FRONTEND_PARTIALS = {
    "/frontend/partials/loading.html",
    "/frontend/partials/head-base.html",
}

@app.middleware("http")
async def block_direct_frontend(request: Request, call_next):
    p = request.url.path

    # 🔓 exceção: permitir abrir /frontend/admin-planos.html sem login
    if p == "/frontend/admin-planos.html":
        return await call_next(request)

    if p.startswith("/frontend/"):
        is_html = p.endswith(".html") or "/partials/" in p
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
    "/dashboard":            "dashboard.ver",
    "/clientes":             "clientes.ver",
    "/departamentos":        "departamentos.gerenciar",
    "/colaboradores":        "colaboradores.ver",
    "/colaboradores/novo":   "colaboradores.gerenciar",
    "/colaborador-perfil":   "colaboradores.gerenciar",
    "/usuarios":             "usuarios.gerenciar",
    "/configuracoes":        "config.editar",
    "/chat-interno":         "chatinterno.ver",
    "/chatbot":              "chatbot.configurar",
    "/atendimentos":         "atendimento.ver",
    "/midias":               "arquivos.ver",
    "/email":                "email.ver",

    # 👇 AQUI: Conectar WhatsApp exige integracoes.whatsapp
    "/conectar":             "integracoes.whatsapp",
}


def _norm_path_for_perm(path: str) -> str:
    p = path.split("?", 1)[0]
    if p.endswith(".html"):
        p = p[:-5]
    return p


def _html_forbidden(msg: str):
    """
    Em vez de desenhar a tela aqui, só redireciona para /sem-permissao,
    opcionalmente passando o motivo na querystring (?motivo=...)
    """
    motivo = quote_plus(msg)[:300]  # só pra não ficar gigante
    return RedirectResponse(
        url=f"/sem-permissao?motivo={motivo}",
        status_code=302
    )

def _is_public(path: str) -> bool:
    PUBLIC_HTML_PATHS = {
        "/",
        "/login", "/login.html",
        "/criar-empresa", "/criar-empresa.html",
        "/esqueci_senha", "/esqueci_senha.html",

        # 🔓 Admin • Planos acessível sem login
        "/admin-planos", 
        "/admin-planos.html",
        "/frontend/admin-planos.html",  # caso você acesse direto pelo caminho do arquivo
    }
    PUBLIC_PREFIXES = (
        "/api/auth",
        "/img", "/uploads",
        "/static", "/assets",
        "/favicon", "/robots.txt", "/manifest",
        "/ws",
        "/healthz", "/ping",
    )
    if path in PUBLIC_HTML_PATHS:
        return True
    return any(path.startswith(p) for p in PUBLIC_PREFIXES)

def _wants_html(req: Request) -> bool:
    p = req.url.path
    if p.endswith(".html"):
        return True
    acc = req.headers.get("accept", "")
    return "text/html" in acc or p == "/"

def _no_cache_html(resp: StarletteResponse):
    try:
        resp.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
        resp.headers["Pragma"] = "no-cache"
        resp.headers["Expires"] = "0"
    except Exception:
        pass

# =======================================
# Handler global de 404 bonitinho (apenas páginas HTML)
# =======================================
@app.exception_handler(StarletteHTTPException)
async def custom_http_exception_handler(request: Request, exc: StarletteHTTPException):
    """
    404 bonito para páginas HTML (/dashboard2, /qualquercoisa, etc).
    Para /api/* e outros casos, mantém o comportamento padrão do FastAPI.
    """
    path = request.url.path

    # Só troca a tela se for 404, for "página" (HTML) e não for /api nem /frontend
    if (
        exc.status_code == 404
        and _wants_html(request)
        and not path.startswith("/api")
        and not path.startswith("/frontend")
    ):
        nice_path = path[:-5] if path.endswith(".html") else path  # (não exibido, só mantido)

        html = """<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8"/>
  <title>Página não encontrada • ZapChats</title>
  <style>
    :root{
      --topbar-h:44px;
      --card:#161617;
      --border:#27272a;
      --fg:#e5e7eb;
      --muted:#9ca3af;
    }
    html:not(.dark){
      --card:#fff;
      --border:#e5e7eb;
      --fg:#1f2937;
      --muted:#6b7280;
    }
    html, body{
      margin:0;
      padding:0;
      border:0;
    }
    html{
      background:
        linear-gradient(90deg,#22c55e 0%, #16a34a 50%, #10b981 100%) 0 0 / 100% 6px no-repeat,
        var(--card);
      background-attachment:fixed;
    }
    html:not(.dark){
      background:
        linear-gradient(90deg,#22c55e 0%, #16a34a 50%, #10b981 100%) 0 0 / 100% 6px no-repeat,
        #fff;
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
      position:fixed;
      top:0;
      left:0;
      right:0;
      height:var(--topbar-h);
      display:flex;
      align-items:center;
      justify-content:flex-end;
      gap:.75rem;
      padding:6px 14px 0;
      background:transparent;
      z-index:60;
      border:0;
      box-shadow:none;
    }

    /* === Toggle de tema (mesmo visual do sidebar) === */
    .theme-toggle{
      --w:78px;
      --h:34px;
      --p:3px;
      --k:28px;
      --dx: calc(var(--w) - var(--k) - var(--p)*2);
      position:relative;
      width:var(--w);
      height:var(--h);
      padding:var(--p);
      border-radius:999px;
      cursor:pointer;
      outline:none;
      border:1px solid;
      display:inline-block;
      isolation:isolate;
      background:#eceff3;
      border-color:#d5d9e0;
      box-shadow:
        inset 0 2px 4px rgba(0,0,0,.06),
        inset 0 -1px 2px rgba(0,0,0,.05);
      transition:
        background .3s ease,
        border-color .3s ease,
        box-shadow .3s ease;
      line-height:0;
    }
    html.dark .theme-toggle{
      background:#2f323a;
      border-color:#3a3e46;
      box-shadow:
        inset 0 2px 5px rgba(0,0,0,.35),
        inset 0 -1px 2px rgba(255,255,255,.03);
    }
    .theme-toggle .slot{
      position:absolute;
      top:50%;
      transform:translateY(-50%);
      width:28px;
      height:28px;
      display:grid;
      place-items:center;
      pointer-events:none;
      opacity:.75;
    }
    .theme-toggle .slot.left{ left:8px; }
    .theme-toggle .slot.right{ right:8px; }
    .theme-toggle .slot svg{
      width:18px;
      height:18px;
      display:block;
    }
    .theme-toggle .slot svg *{
      stroke:#9ca3af;
    }
    html.dark .theme-toggle .slot svg *{
      stroke:#8a93a1;
    }
    .theme-toggle .thumb{
      position:absolute;
      left:var(--p);
      top:50%;
      width:var(--k);
      height:var(--k);
      border-radius:999px;
      transform:translate(0,-50%);
      transition:
        transform .38s cubic-bezier(.28,1.2,.43,1),
        box-shadow .2s ease,
        background .3s ease;
      display:grid;
      place-items:center;
      overflow:hidden;
      background:
        radial-gradient(120% 120% at 30% 30%, rgba(255,255,255,.7), rgba(255,255,255,.25) 45%, rgba(255,255,255,.08) 65%),
        linear-gradient(180deg,#f8c266,#f59e0b);
      box-shadow:
        0 4px 8px rgba(0,0,0,.18),
        inset 0 0 0 1px rgba(255,255,255,.25);
    }
    .theme-toggle .thumb svg{
      width:22px;
      height:22px;
      display:block;
      position:relative;
      z-index:1;
      pointer-events:none;
    }
    .theme-toggle .thumb .thumb-sun{ display:block; }
    .theme-toggle .thumb .thumb-moon{ display:none; }
    html.dark .theme-toggle .thumb{
      transform:translate(var(--dx), -50%) !important;
      background:
        radial-gradient(120% 120% at 30% 30%, rgba(255,255,255,.7), rgba(255,255,255,.25) 45%, rgba(255,255,255,.08) 65%),
        linear-gradient(180deg,#6ba6ff,#2563eb) !important;
      box-shadow:
        0 6px 10px rgba(0,0,0,.35),
        inset 0 0 0 1px rgba(255,255,255,.22);
    }
    html.dark .theme-toggle .thumb .thumb-sun{
      display:none !important;
    }
    html.dark .theme-toggle .thumb .thumb-moon{
      display:block !important;
    }
    .theme-toggle:active .thumb{
      transform: translate(0,-50%) scale(.96);
    }
    html.dark .theme-toggle:active .thumb{
      transform: translate(calc(var(--dx)),-50%) scale(.96);
    }
    .theme-toggle:focus-visible{
      box-shadow:0 0 0 3px rgba(99,102,241,.35);
    }
    .theme-toggle.t-anim::after{
      content:"";
      position:absolute;
      inset:0;
      border-radius:inherit;
      pointer-events:none;
      background:linear-gradient(115deg, transparent 30%, rgba(255,255,255,.45) 50%, transparent 70%);
      animation:sweep .55s ease both;
    }
    @keyframes sweep {
      from{opacity:.0}
      to{opacity:1}
    }

    /* ===== Conteúdo 404 ===== */
    main.wrap{
      max-width:520px;
      width:100%;
      text-align:center;
    }
    .icon{
      font-size:32px;
      margin-bottom:10px;
      width:clamp(260px, 34vw, 340px);
      height:clamp(260px, 34vw, 340px);
      margin-left:auto;
      margin-right:auto;
    }
    h1{
      font-size:22px;
      margin-bottom:8px;
    }
    p{
      font-size:14px;
      line-height:1.6;
      color:var(--muted);
      margin-bottom:6px;
    }
    .actions{
      margin-top:16px;
      display:flex;
      flex-wrap:wrap;
      gap:8px;
      justify-content:center;
    }
    a.btn{
      display:inline-flex;
      align-items:center;
      justify-content:center;
      padding:8px 14px;
      border-radius:999px;
      font-size:14px;
      text-decoration:none;
      border:1px solid var(--border);
      background:var(--card);
      color:var(--fg);
    }
    html:not(.dark) a.btn{
      background:var(--card);
      border-color:var(--border);
      color:var(--fg);
    }
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
      <span class="thumb" aria-hidden="true">
        <svg class="thumb-sun" viewBox="0 0 24 24">
          <defs>
            <radialGradient id="sunGrad-404" cx="30%" cy="30%" r="80%">
              <stop offset="0%" stop-color="#ffd27a"/>
              <stop offset="60%" stop-color="#f8c266"/>
              <stop offset="100%" stop-color="#f59e0b"/>
            </radialGradient>
          </defs>
          <circle cx="12" cy="12" r="6.3" fill="url(#sunGrad-404)"/>
        </svg>
        <svg class="thumb-moon" viewBox="0 0 24 24">
          <defs>
            <radialGradient id="moonGrad-404" cx="30%" cy="30%" r="80%">
              <stop offset="0%" stop-color="#9fc3ff"/>
              <stop offset="60%" stop-color="#6ba6ff"/>
              <stop offset="100%" stop-color="#2563eb"/>
            </radialGradient>
          </defs>
          <circle cx="12" cy="12" r="11" fill="url(#moonGrad-404)"/>
        </svg>
      </span>
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

    // tema inicial (AppTheme global ou localStorage), igual lógica do sidebar
    try{
      if (window.AppTheme && typeof window.AppTheme.current === 'function'){
        html.classList.toggle('dark', window.AppTheme.current() === 'dark');
      } else {
        var saved = localStorage.getItem('theme');
        if (saved){ html.classList.toggle('dark', saved === 'dark'); }
      }
    }catch(e){}

    var btn = document.getElementById('themeSwitch');
    if (!btn) return;

    function syncPressed(){
      btn.setAttribute('aria-pressed', String(html.classList.contains('dark')));
    }
    syncPressed();

    btn.addEventListener('click', function(){
      var willDark = !html.classList.contains('dark');
      try{
        if (window.AppTheme && typeof window.AppTheme.set === 'function'){
          window.AppTheme.set(willDark ? 'dark' : 'light');
        } else {
          html.classList.toggle('dark', willDark);
          localStorage.setItem('theme', willDark ? 'dark' : 'light');
        }
      }catch(e){}

      btn.classList.remove('t-anim');
      void btn.offsetWidth;
      btn.classList.add('t-anim');
      setTimeout(function(){ btn.classList.remove('t-anim'); }, 580);

      syncPressed();
    });

    window.addEventListener('storage', function(e){
      if (e.key === 'theme' && e.newValue){
        html.classList.toggle('dark', e.newValue === 'dark');
        syncPressed();
      }
    });
  })();
  </script>

  <!-- Lottie player -->
  <script src="https://cdnjs.cloudflare.com/ajax/libs/bodymovin/5.12.2/lottie.min.js"
          crossorigin="anonymous" referrerpolicy="no-referrer"></script>

  <!-- Carrega a animação 404.json -->
  <script>
  (async function () {
    var container = document.getElementById('lottie404');
    if (!container) return;

    try {
      var res = await fetch('/frontend/js/404.json', { cache: 'no-store' });
      if (!res.ok) {
        console.warn('404.json não encontrado');
        return;
      }
      var data = await res.json();

      var lottiePlayer = window.lottie || window.bodymovin;
      if (!lottiePlayer || !lottiePlayer.loadAnimation) {
        console.warn('Lottie não disponível');
        return;
      }

      lottiePlayer.loadAnimation({
        container: container,
        renderer: 'svg',
        loop: true,
        autoplay: true,
        animationData: data
      });
    } catch (e) {
      console.error('Erro ao carregar Lottie 404:', e);
    }
  })();
  </script>
</body>
</html>"""
        html = html.replace("{nice_path}", nice_path)
        return HTMLResponse(html, status_code=404)
    # Para qualquer outra coisa (inclui /api), usa handler padrão do FastAPI (JSON etc.)
    return await fastapi_http_exception_handler(request, exc)



# Gate de autenticação + permissão por página (HTML)
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

    # checagem de permissão por página (se houver)
    norm = _norm_path_for_perm(path)
    required = REQUIRED_PERMS.get(norm)
    if not required:
        resp = await call_next(request)
        _no_cache_html(resp)
        return resp

    # decodifica token
    try:
        payload = auth_router._decode_token(token)
    except HTTPException:
        next_url = path + (("?" + request.url.query) if request.url.query else "")
        resp = RedirectResponse(url=f"/login.html?next={next_url}", status_code=302)
        resp.headers["X-Auth-Gate"] = "bad-token"
        return resp

    sub = payload.get("sub")
    role = (payload.get("role") or "").lower()

    # Usuário admin (sub numérico) passa
    if not (isinstance(sub, str) and sub.startswith("colab-")):
        resp = await call_next(request)
        _no_cache_html(resp)
        return resp

    # Colaborador com role admin passa
    if role == "admin":
        resp = await call_next(request)
        _no_cache_html(resp)
        return resp

    # Colaborador comum → buscar permissões no DB
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
    return resp

# =======================================
# Rotas / Routers
# =======================================
app.include_router(auth.router, prefix="/api")
app.include_router(usuarios.router, prefix="/api", tags=["Usuarios"])
app.include_router(clientes.router, prefix="/api", tags=["Clientes"])
app.include_router(atendimento_conversas.router, prefix="/api")
# Atendimento principal
app.include_router(atendimento.router, prefix="/api/atendimento", tags=["Atendimento"])
app.include_router(email_router)
# ✅ Router REST específico do chat (conversas/mensagens)
app.include_router(atendimento_chat_router.router, prefix="/api/atendimento", tags=["Atendimento – Chat"])
app.include_router(ws_router)
app.include_router(cliente_onboarding.router,   prefix="/api/onboarding", tags=["Onboarding"])
app.include_router(empresa.router, tags=["Empresas"])
app.include_router(atendimento_busca.router, prefix="/api", tags=["Busca"])
app.include_router(admin_planos.router)
app.include_router(midias_router, tags=["Mídias"])
app.include_router(atendimento_ia_router.router)
app.include_router(atendimento_midias_router)
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

# =======================================
# uploads públicos + arquivos estáticos
# =======================================
app.mount("/uploads", StaticFiles(directory=str(UPLOADS_DIR)), name="uploads")

if FRONTEND_DIR.is_dir():
    img_dir = FRONTEND_DIR / "img"
    if img_dir.is_dir():
        app.mount("/img", StaticFiles(directory=str(img_dir)), name="img")

    # Monta /static e /assets se existirem (para JS/CSS)
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

# Favicon (PNG)
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
    # Em produção libera; em dev pode bloquear tudo
    if ENV == "dev":
        return HTMLResponse("User-agent: *\nDisallow: /\n", media_type="text/plain")
    return HTMLResponse("User-agent: *\nAllow: /\nSitemap: https://zapschat.com.br/sitemap.xml\n", media_type="text/plain")

# === Versão do build (cache-buster) ===
@app.get("/version.json")
def version_json():
    # no-store garante que o browser SEMPRE consulte o servidor
    return JSONResponse({"build": BUILD_ID}, headers={"Cache-Control": "no-store"})

# =======================================
# Rotas de mídia (binário direto)
# =======================================
@app.get("/media_bin/{midia_id}")
def serve_media_bin(
    midia_id: int,
    request: Request,
    user=Depends(get_current_user),
):
    """
    Rota LEGACY de mídia. Agora ela apenas redireciona, com segurança,
    para a rota nova de mídias do atendimento, que valida a empresa
    usando o token do usuário.
    """
    # Monta URL da rota protegida
    url = f"/api/atendimento/midias/{midia_id}"
    # Preserva a querystring original (ex.: instancia_id), se houver
    if request.url.query:
        url = f"{url}?{request.url.query}"
    # 307 mantém método e corpo (se algum dia usarmos POST aqui)
    return RedirectResponse(url=url, status_code=307)

@app.get("/api/env/evolution")
def evolution_env():
    """
    Exponha só o que o front precisa para montar as chamadas HTTP.
    (Se você preferir não mandar a apiKey, basta devolver '' e usar localStorage no front.)
    """
    return JSONResponse({
        "apiUrl": os.getenv("EVOLUTION_URL", ""),
        "apiKey": os.getenv("EVOLUTION_APIKEY", ""),
        # pode ficar vazio; o front usa window.INSTANCIA_ATIVA ou localStorage('evo_instance')
        "defaultInstance": os.getenv("EVOLUTION_DEFAULT_INSTANCE", "")
    })

# =======================================
# /dashboard -> dashboard.html
# =======================================
@app.get("/dashboard", include_in_schema=False)
def dashboard():
    return FileResponse(FRONTEND_DIR / "dashboard.html")

# =======================================
# Rotas finais – páginas "limpas" (sem .html)
# =======================================
def _page_file(name: str) -> Path:
    return FRONTEND_DIR / f"{name}.html"

def _discover_pages() -> list[str]:
    if not FRONTEND_DIR.is_dir():
        return []
    pages = []
    for p in FRONTEND_DIR.glob("*.html"):
        stem = p.stem.strip()
        if stem and not stem.startswith("_"):
            pages.append(stem)
    return sorted(set(pages))

PAGES = _discover_pages()

@app.get("/", response_class=HTMLResponse)
async def root_redirect():
    target = "login" if "login" in PAGES else ("index" if "index" in PAGES else None)
    if target and _page_file(target).is_file():
        return FileResponse(str(_page_file(target)))
    return {"ok": True, "msg": "Backend ZapChats API (front não encontrado)."}

def _make_handler(name: str):
    async def _handler(_name=name):
        return FileResponse(str(_page_file(_name)))
    return _handler

for _name in PAGES:
    if _page_file(_name).is_file():
        app.add_api_route(f"/{_name}", endpoint=_make_handler(_name), methods=["GET"])

@app.get("/{page_name}.html", response_class=HTMLResponse)
async def legacy_html(page_name: str):
    if page_name.startswith("api/"):
        raise HTTPException(status_code=404)
    if page_name in PAGES and _page_file(page_name).is_file():
        return RedirectResponse(url=f"/{page_name}", status_code=307)
    raise HTTPException(status_code=404)

# =======================================
# Handlers Evolution/WebSocket
# =======================================
# Já expostos via HANDLERS, consumidos pelo Rabbit e pelo WS listener
LOG("Handlers Evolution/WebSocket prontos (via HANDLERS do evo_handlers).")

# =======================================
# Startup/Shutdown
# =======================================
@app.on_event("startup")
async def _start_integrations():
    import time
    # 1) Garante DB de pé
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

    # 2) RabbitMQ = fonte oficial das mensagens
    if USE_RABBIT:
        try:
            rabbit_task, rabbit_stop = start_rabbit_consumer(loop, HANDLERS, EvoEvent)
            app.state.rabbit_task = rabbit_task
            app.state.rabbit_stop = rabbit_stop
            LOG("[STARTUP] RabbitMQ consumer ligado.")
        except Exception as e:
            LOG(f"[STARTUP][Rabbit] falha ao iniciar consumer: {e}")
    else:
        LOG("[STARTUP] RabbitMQ desabilitado (sem RABBITMQ_URI).")

    # 3) WebSocket da Evolution = opcional (QR / connection)
    if USE_EVO_WS:
        try:
            evo_ret = await start_evo_ws_listener(loop, HANDLERS, EvoEvent)
            if isinstance(evo_ret, tuple) and len(evo_ret) == 2 and evo_ret[0] is not None:
                app.state.evo_task, app.state.evo_stop = evo_ret
            LOG("[STARTUP] Evolution WS listener ligado.")
        except Exception as e:
            LOG(f"[STARTUP][EvoWS] falha ao iniciar listener: {e}")
    else:
        LOG("[STARTUP] Evolution WS listener desabilitado (EVOLUTION_WS_SUBSCRIBE != 'true').")

    # 4) Aviso se os dois estiverem ativos ao mesmo tempo
    if USE_RABBIT and USE_EVO_WS:
        LOG("⚠ RabbitMQ + Evolution WS ativos. "
            "Mensagens já estão limitadas ao Rabbit; WS fica só para QR/connection.")



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
# Partials HTML (respeita bloqueios via middleware)
# =======================================
@app.get("/frontend/partials/{path:path}")
def partial(path: str):
    # ⚠️ Se o arquivo estiver na allowlist PUBLIC_FRONTEND_PARTIALS,
    # o middleware já permitiu o acesso sem cookie.
    return FileResponse(
        FRONTEND_DIR / "partials" / path,
        media_type="text/html; charset=utf-8"
    )
