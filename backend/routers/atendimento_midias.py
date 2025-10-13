# backend/routers/atendimento_midias.py
# — cache-1x + persistência BD + ETag/304 + multi-instância
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request, Response, Query
from fastapi.responses import FileResponse, RedirectResponse, StreamingResponse
from sqlalchemy.orm import Session
from sqlalchemy import func
from io import BytesIO
import base64, re, os, mimetypes, hashlib, threading, glob
from typing import Optional

from backend.database import get_db
from backend import models
from backend.routers.auth import get_current_user

router = APIRouter(tags=["Atendimento – Mídias"])

# =========================
# Evolution (env)
# =========================
EVOLUTION_URL = (os.getenv("EVOLUTION_URL", "").rstrip("/"))
EVOLUTION_KEY = os.getenv("EVOLUTION_APIKEY") or os.getenv("EVOLUTION_KEY")
HEADERS = {"apikey": EVOLUTION_KEY, "Content-Type": "application/json"} if EVOLUTION_KEY else {}

# =========================
# Cache de arquivos (env)
# =========================
MEDIA_CACHE_DIR = os.getenv("MEDIA_CACHE_DIR", "/var/cache/zapchats/media")
os.makedirs(MEDIA_CACHE_DIR, exist_ok=True)

# trava por msg_id para evitar duplicidade de fetch/escrita
_FETCH_LOCKS: dict[str, threading.Lock] = {}
_FETCH_LOCKS_G = threading.Lock()
def _lock_for(msg_id: str) -> threading.Lock:
    with _FETCH_LOCKS_G:
        if msg_id not in _FETCH_LOCKS:
            _FETCH_LOCKS[msg_id] = threading.Lock()
        return _FETCH_LOCKS[msg_id]

# =========================
# Helpers
# =========================
def _assert_mesma_empresa(empresa_do_token: int, empresa_da_query: int | None) -> int:
    """
    Se empresa_da_query existir, deve ser igual ao do token; senão usa o do token.
    """
    if empresa_da_query is None:
        return empresa_do_token
    if empresa_da_query != empresa_do_token:
        raise HTTPException(403, "Empresa inválida para este recurso")
    return empresa_da_query

def _find_b64(d):
    """Busca recursiva por campos comuns que carregam base64/dataURL."""
    if isinstance(d, dict):
        for k in ("base64", "b64", "fileBase64", "data"):
            v = d.get(k)
            if isinstance(v, str) and v:
                return v
        for v in d.values():
            b = _find_b64(v)
            if b:
                return b
    elif isinstance(d, list):
        for v in d:
            b = _find_b64(v)
            if b:
                return b
    return None

def _sniff_mime(raw: bytes) -> str:
    h = raw[:16]
    if h.startswith(b"\xff\xd8\xff"): return "image/jpeg"
    if h.startswith(b"\x89PNG\r\n\x1a\n"): return "image/png"
    if h[:4] == b"RIFF" and h[8:12] == b"WEBP": return "image/webp"
    if h.startswith(b"OggS"): return "audio/ogg"
    if h.startswith(b"ID3") or (len(h) >= 2 and h[:2] in (b"\xff\xfb", b"\xff\xf3", b"\xff\xf2")): return "audio/mpeg"
    if len(h) >= 12 and h[4:8] == b"ftyp": return "video/mp4"
    if h.startswith(b"%PDF"): return "application/pdf"
    return "application/octet-stream"

def _decode_any(b64: str):
    """Aceita dataURL (data:mime;base64,...) ou base64 puro; tenta adivinhar o MIME."""
    m = re.match(r"^data:([^;]+);base64,(.+)$", b64)
    if m:
        raw = base64.b64decode(m.group(2), validate=False)
        mime = (m.group(1) or "").strip().lower() or _sniff_mime(raw)
        return raw, mime
    raw = base64.b64decode("".join(b64.split()), validate=False)
    return raw, _sniff_mime(raw)

def _fix_filename(name: str | None, mime: str) -> str:
    """
    Normaliza o nome para bater com o MIME:
    - remove .enc
    - substitui/define a extensão pela extensão do MIME (ex.: *.oga → *.mp3)
    """
    base = (name or "arquivo")
    if base.lower().endswith(".enc"):
        base = base[:-4]

    ext_from_mime = (mimetypes.guess_extension((mime or "").lower()) or "").lower()
    if ext_from_mime == ".jpe":
        ext_from_mime = ".jpg"
    if not ext_from_mime:
        return base

    if "." in base:
        root = ".".join(base.split(".")[:-1]) or "arquivo"
        cur_ext = "." + base.split(".")[-1].lower()
        if cur_ext != ext_from_mime:
            return root + ext_from_mime
        return base
    else:
        return base + ext_from_mime

def _etag_from_raw(raw: bytes) -> str:
    h = hashlib.md5(raw).hexdigest()[:16]
    return f'W/"{len(raw)}-{h}"'

def _cache_glob_for(prefix: str):
    # arquivos salvos como: <MEDIA_CACHE_DIR>/<prefix>.<ext>
    pattern = os.path.join(MEDIA_CACHE_DIR, f"{prefix}.*")
    files = glob.glob(pattern)
    return files[0] if files else None

def _cache_write(prefix: str, raw: bytes, mime: str, name: str | None):
    ext = mimetypes.guess_extension(mime or "") or ""
    if ext == ".jpe": ext = ".jpg"
    safe_name = _fix_filename(name, mime)
    path = os.path.join(MEDIA_CACHE_DIR, f"{prefix}{ext}")
    tmp = path + ".tmp"
    with open(tmp, "wb") as f:
        f.write(raw)
    os.replace(tmp, path)

    # sidecars: etag + original name (para Content-Disposition)
    try:
        with open(path + ".etag", "w") as f:
            f.write(_etag_from_raw(raw))
    except Exception:
        pass
    try:
        with open(path + ".name", "w", encoding="utf-8") as f:
            f.write(safe_name)
    except Exception:
        pass
    return path

def _serve_cached(path: str, request: Request):
    etag = None
    name = None
    try:
        with open(path + ".etag", "r") as f:
            etag = f.read().strip()
    except Exception:
        pass
    try:
        with open(path + ".name", "r", encoding="utf-8") as f:
            name = f.read().strip()
    except Exception:
        name = os.path.basename(path)

    # 304 se ETag casar
    if etag and request.headers.get("if-none-match") == etag:
        return Response(status_code=304)

    mime = mimetypes.guess_type(path)[0]
    if not mime:
        try:
            with open(path, "rb") as f:
                mime = _sniff_mime(f.read(16))
        except Exception:
            mime = "application/octet-stream"

    headers = {
        "Cache-Control": "public, max-age=31536000, immutable",
        "Content-Disposition": f'inline; filename="{name.replace(chr(34), "")}"',
    }
    if etag:
        headers["ETag"] = etag

    return FileResponse(path, media_type=mime, headers=headers)

def _inline(raw: bytes, mime: str | None, name: str | None, request: Request = None):
    """Fallback: stream em memória (evitar; preferimos _serve_cached)."""
    mime = mime or "application/octet-stream"
    etag = _etag_from_raw(raw)
    if request and request.headers.get("if-none-match") == etag:
        return Response(status_code=304)
    headers = {
        "Content-Disposition": f'inline; filename="{(name or "arquivo").replace(chr(34), "")}"',
        "Cache-Control": "public, max-age=31536000, immutable",
        "ETag": etag,
    }
    return StreamingResponse(BytesIO(raw), media_type=mime, headers=headers)

def _bucket_for(mime: str, media_type: str | None = None) -> str:
    """image|video|audio|document|sticker"""
    m = (mime or "").lower()
    mt = (media_type or "").lower()
    if "sticker" in mt:
        return "sticker"
    if m.startswith("image/"):
        if m == "image/webp" and "sticker" in mt:
            return "sticker"
        return "image"
    if m.startswith("video/"): return "video"
    if m.startswith("audio/"): return "audio"
    if m.startswith("application/"): return "document"
    return "document"

def _pdf_page_count(raw: bytes) -> Optional[int]:
    """Heurística simples; se precisar perfeito, trocar por PyPDF2 depois."""
    try:
        return raw.count(b"/Type /Page") or None
    except Exception:
        return None

# =========================
# Core: Evolution + persistência
# =========================
def _evo_payloads_for(msg: models.Mensagem, cli: models.Cliente, inst: models.EmpresaInstancia | None):
    """Monta variações de key (com/sem remoteJid, fromMe true/false) para aumentar chance de hit."""
    jid = (cli.telefone or "").strip()
    if jid:
        jid = "".join(ch for ch in jid if ch.isdigit())
        if not jid.startswith("55"):
            jid = "55" + jid
        jid = f"{jid}@s.whatsapp.net"
    payloads = [{"key": {"id": msg.msg_id}}]
    if jid:
        from_me = (msg.tipo == "saida")
        payloads += [
            {"key": {"id": msg.msg_id, "remoteJid": jid, "fromMe": from_me}},
            {"key": {"id": msg.msg_id, "remoteJid": jid, "fromMe": (not from_me)}},
        ]
    return payloads

def _fetch_from_evolution(
    db: Session,
    msg: models.Mensagem,
    cli: models.Cliente,
    inst: models.EmpresaInstancia | None,
    instancia_id: int | None = None,  # opcional; usamos instance_name da instância
):
    """Busca base64 + metadados na Evolution; tenta convertToMp4=False→True e variações de key."""
    if not EVOLUTION_KEY:
        raise RuntimeError("Evolution KEY ausente")
    if not EVOLUTION_URL:
        raise RuntimeError("Evolution URL ausente")
    if not inst or not getattr(inst, "instance_name", None):
        raise RuntimeError("instance_name ausente para a mensagem")

    url = f"{EVOLUTION_URL}/chat/getBase64FromMediaMessage/{inst.instance_name}"
    last_err = None

    def _post(payload_msg, convert: bool):
        import requests
        body = {"message": payload_msg, "convertToMp4": bool(convert)}
        r = requests.post(url, headers=HEADERS, json=body, timeout=40)
        if r.status_code not in (200, 201):
            raise RuntimeError(f"HTTP {r.status_code} {r.text[:160]}")
        j = r.json() or {}
        b64 = j.get("base64") or _find_b64(j)
        if not b64:
            raise RuntimeError("retorno sem base64")
        raw, sniff = _decode_any(b64)
        mime = (j.get("mimetype") or sniff or _sniff_mime(raw)).lower()
        name = j.get("fileName") or None
        meta = {
            "mediaType": j.get("mediaType"),
            "caption": j.get("caption"),
            "size": j.get("size") or {},
        }
        return raw, mime, name, meta

    # Primeiro tenta o payload simples (igual ao Postman)
    for convert in (False, True):  # True ajuda áudio/ptt
        try:
            return _post({"key": {"id": msg.msg_id}}, convert)
        except Exception as e:
            last_err = str(e)

    # Depois variações com remoteJid/fromMe
    for key in _evo_payloads_for(msg, cli, inst):
        for convert in (False, True):
            try:
                return _post(key, convert)
            except Exception as e:
                last_err = str(e)
                continue

    raise RuntimeError(last_err or "falha Evolution")

def _persist_midia(
    db: Session,
    msg: models.Mensagem,
    raw: bytes,
    mime: str,
    filename: str | None,
    meta: dict | None = None,
    local_path: str | None = None,
):
    """
    Cria/atualiza Midia da mensagem com campos ricos:
    empresa_id, cliente_id, mensagem_id, mimetype, filename,
    tamanho, tipo (bucket), file_sha256, local_path, data (binário), page_count (PDF).
    """
    media_type = (meta or {}).get("mediaType")
    size_obj   = (meta or {}).get("size") or {}
    file_len   = size_obj.get("fileLength")
    try:
        file_len = int(file_len) if file_len is not None else None
    except Exception:
        file_len = None

    # normaliza filename e bucket
    fname  = _fix_filename(filename, mime)
    bucket = _bucket_for(mime, media_type)

    # calcula tamanho e hash
    real_size = len(raw)
    tamanho   = file_len or real_size
    sha_hex   = hashlib.sha256(raw).hexdigest()

    midia = (
        db.query(models.Midia)
          .filter(models.Midia.mensagem_id == msg.id)
          .first()
    )
    if midia is None:
        midia = models.Midia(mensagem_id=msg.id)
        db.add(midia)

    midia.empresa_id = msg.empresa_id
    midia.cliente_id = msg.cliente_id
    midia.mimetype   = mime or midia.mimetype or "application/octet-stream"
    midia.filename   = fname or midia.filename or "arquivo"
    if filename and filename != fname:
        # guarda o nome vindo da Evolution, se diferente do normalizado
        midia.nome_original = filename

    midia.tipo        = bucket
    midia.tamanho     = tamanho
    midia.file_sha256 = sha_hex
    if local_path:
        midia.local_path = local_path

    # mantém o binário para auditoria/backup:
    midia.data = raw

    # (opcional) page_count em PDF
    if (midia.mimetype or "").lower() == "application/pdf":
        pc = _pdf_page_count(raw)
        if pc:
            midia.page_count = pc

    db.commit()
    db.refresh(midia)
    return midia

# =========================
# Helpers de servir do BD
# =========================
def _serve_midia_model(md: models.Midia) -> Response:
    """Serve a mídia usando os campos do modelo (data/local_path/url)."""
    mimetype = (getattr(md, "mimetype", None) or "application/octet-stream")
    filename = getattr(md, "filename", None) or getattr(md, "nome_original", None) or "arquivo"

    # 1) blob/data
    raw = getattr(md, "data", None) or getattr(md, "conteudo", None)
    if raw:
        headers = {"Content-Disposition": f'inline; filename="{filename}"'}
        return Response(content=bytes(raw), media_type=mimetype, headers=headers)

    # 2) arquivo local
    local_path = getattr(md, "local_path", None) or getattr(md, "path_local", None) or getattr(md, "caminho", None)
    if local_path and os.path.exists(local_path):
        return FileResponse(local_path, media_type=mimetype, filename=filename)

    # 3) url pública (fallback)
    url = getattr(md, "url", None)
    if url:
        return RedirectResponse(url)

    raise HTTPException(404, "Mídia sem conteúdo disponível")

# =========================
# Rotas
# =========================
@router.get("/api/atendimento/midias/{midia_id}")
def midia_resolve(
    midia_id: int,
    request: Request,
    empresa_id: int | None = Query(None),
    instancia_id: int | None = Query(None),
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    """
    Rota legacy por midia_id — resolve msg_id e REDIRECIONA (307) para a rota por msg_id.
    Propaga empresa_id/instancia_id quando informados (evita 422).
    Garante que a empresa da mídia pertence ao token.
    """
    empresa_id_eff = _assert_mesma_empresa(user.empresa_id, empresa_id)

    row = (
        db.query(models.Midia, models.Mensagem)
          .join(models.Mensagem, models.Mensagem.id == models.Midia.mensagem_id)
          .filter(models.Midia.id == midia_id)
          .first()
    )
    if not row:
        raise HTTPException(404, "Mídia não encontrada")
    mid, msg = row
    if not msg or not msg.msg_id:
        raise HTTPException(404, "Mensagem associada não encontrada")

    if int(msg.empresa_id) != int(empresa_id_eff):
        raise HTTPException(403, "Mídia não pertence à sua empresa")

    qs = []
    if empresa_id_eff is not None: qs.append(f"empresa_id={empresa_id_eff}")
    if instancia_id is not None: qs.append(f"instancia_id={instancia_id}")
    q = ("?" + "&".join(qs)) if qs else ""
    return RedirectResponse(url=f"/api/atendimento/midias/msg/{msg.msg_id}{q}", status_code=307)


@router.get("/api/atendimento/midias/msg/{msg_id}")
def midia_por_msg(
    msg_id: str,
    request: Request,
    empresa_id: int | None = Query(None),
    instancia_id: int | None = Query(None),
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    """
    Canônico por msg_id (multi-instância):
      0) cache em disco (ETag/304),
      1) resolve Mensagem+Cliente+Instância (validando empresa do token),
      2) tenta servir **do BD** (Midia.data/local_path/url),
      3) Evolution como fallback, persistindo e cacheando.
    """
    empresa_id_eff = _assert_mesma_empresa(user.empresa_id, empresa_id)

    # 0) Cache no disco?
    cached = _cache_glob_for(msg_id)
    if cached:
        return _serve_cached(cached, request)

    # 1) Resolve Mensagem + Cliente + Instância (msg_id case-insensitive)
    q = (
        db.query(models.Mensagem, models.Cliente, models.EmpresaInstancia)
          .join(models.Cliente, models.Cliente.id == models.Mensagem.cliente_id)
          .outerjoin(models.EmpresaInstancia, models.EmpresaInstancia.id == models.Mensagem.instancia_id)
          .filter(func.lower(models.Mensagem.msg_id) == msg_id.lower(),
                  models.Mensagem.empresa_id == empresa_id_eff)
    )
    if instancia_id is not None and hasattr(models.Mensagem, "instancia_id"):
        q = q.filter(models.Mensagem.instancia_id == instancia_id)

    row = q.first()
    if not row:
        raise HTTPException(404, "Mensagem não encontrada para os filtros informados")
    msg, cli, inst = row

    # 2) **Serve do BD primeiro**
    mid_db = (
        db.query(models.Midia)
          .filter(models.Midia.mensagem_id == msg.id)
          .order_by(models.Midia.id.asc())
          .first()
    )
    if mid_db:
        try:
            resp = _serve_midia_model(mid_db)
            # se servimos blob, derrama no cache (best-effort)
            raw = getattr(mid_db, "data", None) or getattr(mid_db, "conteudo", None)
            if raw:
                mime = (mid_db.mimetype or "application/octet-stream").lower()
                safe_name = _fix_filename(mid_db.filename or mid_db.nome_original or "arquivo", mime)
                _cache_write(msg_id, raw, mime, safe_name)
            return resp
        except Exception:
            pass  # tenta Evolution

    # 3) Evolution como fallback
    lock = _lock_for(msg_id)
    with lock:
        cached2 = _cache_glob_for(msg_id)
        if cached2:
            return _serve_cached(cached2, request)
        try:
            raw, mime, evo_name, meta = _fetch_from_evolution(db, msg, cli, inst, instancia_id)
            safe_name = _fix_filename(evo_name, mime)
            path = _cache_write(msg_id, raw, mime, safe_name)
            _persist_midia(db, msg, raw, mime, evo_name, meta=meta, local_path=path)
            return _serve_cached(path, request)
        except Exception as evo_err:
            # último fallback: alguma Midia sem data mas com arquivo/url
            mid2 = (
                db.query(models.Midia)
                  .filter(models.Midia.mensagem_id == msg.id)
                  .order_by(models.Midia.id.desc())
                  .first()
            )
            if mid2:
                try:
                    return _serve_midia_model(mid2)
                except Exception:
                    pass
            raise HTTPException(404, f"Não foi possível obter a mídia por msg_id ({evo_err})")
