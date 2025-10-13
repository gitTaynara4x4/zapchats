# backend/main.py
from __future__ import annotations
import os, secrets, asyncio
from typing import Any
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, Depends, APIRouter, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, RedirectResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.responses import Response as StarletteResponse
from starlette.middleware.gzip import GZipMiddleware
from starlette.middleware.trustedhost import TrustedHostMiddleware

from sqlalchemy.orm import Session
from sqlalchemy import text

# Routers / Integrations
from backend.routers import internal_chat as internal_chat_router
from backend.integrations.remove_instance import router as remove_instance_router
from backend.integrations import remove_instance
from backend.database import Base, engine, SessionLocal, get_db
from backend import models
from backend.websocket_manager import conexoes_ativas
from backend.routers import atendimentoia as atendimento_ia_router
from backend.routers import atendimento_chat as atendimento_chat_router

from backend.routers import (
    auth, usuarios, clientes, atendimento,
    cliente_onboarding, empresa, atendimento_busca
)
from backend.routers import dashboard as dashboard_router
from backend.routers.colaboradores import router as colaboradores_router
from backend.routers.permissoes import router as permissoes_router

# ⚠️ Importa os DOIS routers de mídias com nomes distintos
from backend.routers.atendimento_midias import router as atendimento_midias_router  # rotas absolutas /api/atendimento/midias/...
from backend.routers.midias import router as midias_router                          # prefix="/api/midias" (lista/upload/etc)

from backend.routers.atendimento_send import router as atendimento_send_router
from backend.routers import departamentos as departamentos_router
from backend.routers import chatbot_config as chatbot_config_router
from backend.routers import admin_planos
from backend.integrations.rabbit_consumer import start_rabbit_consumer
from backend.integrations.evo_ws_listener import start_evo_ws_listener

# JWT decode para gate de permissão
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

# Cookies / CSRF
COOKIE_SECURE       = (os.getenv("COOKIE_SECURE", "false").lower() in ("1","true","yes","on"))
COOKIE_SAMESITE     = (os.getenv("COOKIE_SAMESITE", "lax").lower())
CSRF_COOKIE_NAME    = os.getenv("CSRF_COOKIE_NAME", "csrf_token")
CSRF_COOKIE_PATH    = os.getenv("CSRF_COOKIE_PATH", "/api/auth/refresh")
CSRF_COOKIE_MAX_AGE = int(os.getenv("CSRF_COOKIE_MAX_AGE", str(60*60*24*30)))

ACCESS_COOKIE_NAME = os.getenv("ACCESS_COOKIE_NAME", "access_token")

# Trusted hosts (Traefik/EasyPanel já define Host; mantenha localhost p/ dev)
ALLOWED_HOSTS = os.getenv("ALLOWED_HOSTS",
                          "localhost,127.0.0.1,zapschat.com.br,www.zapschat.com.br").split(",")

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
    expose_headers=["Retry-After"],
)

# Cookie de CSRF (double-submit) só no /api/auth/refresh
@app.middleware("http")
async def ensure_csrf_cookie(request: Request, call_next):
    needs_csrf = request.url.path.startswith("/api/auth/refresh")
    has_cookie = request.cookies.get(CSRF_COOKIE_NAME)
    resp: StarletteResponse = await call_next(request)
    if needs_csrf and not has_cookie:
        token = secrets.token_urlsafe(32)
        resp.set_cookie(
            key=CSRF_COOKIE_NAME, value=token,
            httponly=False,  # JS lê para enviar no header
            secure=COOKIE_SECURE,
            samesite=COOKIE_SAMESITE,
            max_age=CSRF_COOKIE_MAX_AGE,
            path=CSRF_COOKIE_PATH,
        )
    # HSTS apenas em produção
    if ENV != "dev":
        resp.headers.setdefault("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload")
    resp.headers.setdefault("X-Content-Type-Options", "nosniff")
    resp.headers.setdefault("X-Frame-Options", "SAMEORIGIN")
    return resp

# =======================================
# BLOQUEIO de acesso direto a /frontend/*
# (bloqueia HTML/partials para anônimos; libera JS/CSS/img)
# =======================================
@app.middleware("http")
async def block_direct_frontend(request: Request, call_next):
    p = request.url.path
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
}

def _norm_path_for_perm(path: str) -> str:
    p = path.split("?", 1)[0]
    if p.endswith(".html"):
        p = p[:-5]
    return p

def _html_forbidden(msg: str) -> HTMLResponse:
    return HTMLResponse(
        f"""<!doctype html>
<html><head><meta charset="utf-8"><title>Sem permissão</title>
<style>body{{font-family:system-ui,Segoe UI,Roboto,Arial,sans-serif;background:#0b0f14;color:#e2e8f0}}
.card{{max-width:680px;margin:12vh auto;padding:24px;background:#111827;border:1px solid #1f2937;border-radius:12px}}
h1{{margin:0 0 8px 0;font-size:20px}}p{{opacity:.9;line-height:1.5}}</style></head>
<body><div class="card"><h1>Você não tem permissão</h1>
<p>{msg}</p><p><a href="/dashboard">Voltar ao Dashboard</a></p></div></body></html>""",
        status_code=403
    )

def _is_public(path: str) -> bool:
    PUBLIC_HTML_PATHS = {
        "/",
        "/login", "/login.html",
        "/criar-empresa", "/criar-empresa.html",
        "/esqueci_senha", "/esqueci_senha.html",
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
        return RedirectResponse(url=f"/login.html?next={next_url}", status_code=302)

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
        return RedirectResponse(url=f"/login.html?next={next_url}", status_code=302)

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

# Atendimento principal
app.include_router(atendimento.router, prefix="/api/atendimento", tags=["Atendimento"])

# ✅ Router REST específico do chat (conversas/mensagens)
app.include_router(atendimento_chat_router.router, prefix="/api/atendimento", tags=["Atendimento – Chat"])

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

# =======================================
# Rotas de mídia (binário direto)
# =======================================
@app.get("/media_bin/{midia_id}")
def serve_media_bin(midia_id: int, db: Session = Depends(get_db)):
    midia = db.query(models.Midia).filter_by(id=midia_id).first()
    if not midia:
        raise HTTPException(404)
    mt = normalize_mimetype(midia.tipo, midia.filename, midia.mimetype)
    return StarletteResponse(
        content=midia.data,
        media_type=mt,
        headers={
            "Content-Disposition": f'inline; filename="{midia.filename or "file"}"',
            "Content-Length": str(len(midia.data)),
            "Accept-Ranges": "bytes",
        },
    )

# =======================================
# WebSockets internos
# =======================================
@app.websocket("/ws/emp:{empresa_id}")
async def ws_empresa(websocket: WebSocket, empresa_id: int):
    group = f"emp:{empresa_id}"
    await conexoes_ativas.connect(websocket, group)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        await conexoes_ativas.disconnect(websocket, group)

@app.websocket("/ws/inst:{inst_id}")
async def instancia_ws(websocket: WebSocket, inst_id: str):
    group = f"inst:{inst_id}"
    await conexoes_ativas.connect(websocket, group)

    # força QR assim que o WS da instância abre
    try:
        asyncio.create_task(force_qr_for_instance(inst_id))
    except Exception as e:
        print(f"[QR WS] falha ao acionar force_qr_now_async: {e}")

    try:
        while True:
            _ = await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        await conexoes_ativas.disconnect(websocket, group)

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
    for i in range(10):
        try:
            with engine.begin() as conn:
                conn.exec_driver_sql("SELECT 1")
                Base.metadata.create_all(bind=conn)
            LOG("[STARTUP] DB ok e tabelas garantidas."); break
        except Exception as e:
            LOG(f"[STARTUP][DB] tentativa {i+1}/10 falhou: {e}"); time.sleep(2)

    loop = asyncio.get_running_loop()
    app.state.loop = loop

    rabbit_task, rabbit_stop = start_rabbit_consumer(loop, HANDLERS, EvoEvent)
    app.state.rabbit_task = rabbit_task
    app.state.rabbit_stop = rabbit_stop

    evo_ret = start_evo_ws_listener(loop, HANDLERS, EvoEvent)
    if isinstance(evo_ret, tuple) and len(evo_ret) == 2:
        app.state.evo_task, app.state.evo_stop = evo_ret

    LOG("[STARTUP] RabbitMQ consumer + Evo WS listener ligados.")

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
    return FileResponse(
        FRONTEND_DIR / "partials" / path,
        media_type="text/html; charset=utf-8"
    )
