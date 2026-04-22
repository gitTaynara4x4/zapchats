# backend/routers/atendimento_midias.py
# — cache-1x + persistência BD + ETag/304 + multi-instância + ACL composta (departamento + instância)

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request, Response, Query
from fastapi.responses import FileResponse, RedirectResponse, StreamingResponse
from sqlalchemy.orm import Session
from sqlalchemy import func
from io import BytesIO
import base64, re, os, mimetypes, hashlib, threading, glob
from typing import Optional, Any, Dict, List, Tuple

from backend.database import get_db
from backend import models
from backend.routers.auth import get_current_identity
from backend.security.atendimento_acl import (
    ensure_perm,
    assert_same_company,
    resolve_acl_context,
    assert_instancia_allowed,
    assert_cliente_access,
)

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
MEDIA_CACHE_DIR = os.getenv("MEDIA_CACHE_DIR", "/var/cache/zapschat/media")
os.makedirs(MEDIA_CACHE_DIR, exist_ok=True)

# ⚠️ mídia é recurso autenticado → evite cache público/proxy
MEDIA_CACHE_CONTROL = "private, max-age=31536000, immutable"


# trava por msg_id para evitar duplicidade de fetch/escrita
_FETCH_LOCKS: dict[str, threading.Lock] = {}
_FETCH_LOCKS_G = threading.Lock()


def _lock_for(key: str) -> threading.Lock:
    with _FETCH_LOCKS_G:
        if key not in _FETCH_LOCKS:
            _FETCH_LOCKS[key] = threading.Lock()
        return _FETCH_LOCKS[key]


# =========================
# Helpers
# =========================
def _resolve_instancia(
    db: Session,
    *,
    empresa_id: int,
    instancia_id: int | None,
    instance: str | None,
) -> Tuple[Optional[int], Optional[str]]:
    """
    Resolve (instancia_id, instance_name) pelo filtro recebido.
    """
    if instancia_id is not None:
        row = (
            db.query(models.EmpresaInstancia)
            .filter(
                models.EmpresaInstancia.empresa_id == int(empresa_id),
                models.EmpresaInstancia.id == int(instancia_id),
            )
            .first()
        )
        if row:
            return int(row.id), row.instance_name
        return None, None

    if instance:
        row = (
            db.query(models.EmpresaInstancia)
            .filter(
                models.EmpresaInstancia.empresa_id == int(empresa_id),
                models.EmpresaInstancia.instance_name == instance,
            )
            .first()
        )
        if row:
            return int(row.id), row.instance_name
        return None, None

    return None, None


def _find_b64(d):
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
    if h.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if h.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if h[:4] == b"RIFF" and h[8:12] == b"WEBP":
        return "image/webp"
    if h.startswith(b"OggS"):
        return "audio/ogg"
    if h.startswith(b"ID3") or (len(h) >= 2 and h[:2] in (b"\xff\xfb", b"\xff\xf3", b"\xff\xf2")):
        return "audio/mpeg"
    if len(h) >= 12 and h[4:8] == b"ftyp":
        return "video/mp4"
    if h.startswith(b"%PDF"):
        return "application/pdf"
    return "application/octet-stream"


def _decode_any(b64: str):
    m = re.match(r"^data:([^;]+);base64,(.+)$", b64)
    if m:
        raw = base64.b64decode(m.group(2), validate=False)
        mime = (m.group(1) or "").strip().lower() or _sniff_mime(raw)
        return raw, mime
    raw = base64.b64decode("".join(b64.split()), validate=False)
    return raw, _sniff_mime(raw)


def _fix_filename(name: str | None, mime: str) -> str:
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


def _etag_from_stat(path: str) -> str:
    try:
        st = os.stat(path)
        return f'W/"{st.st_size}-{int(st.st_mtime)}"'
    except Exception:
        return ""


def _sanitize_cache_key(key: str) -> str:
    # msg_id geralmente é seguro, mas vamos blindar path
    return re.sub(r"[^A-Za-z0-9._-]+", "_", key or "")


def _cache_glob_for(prefix: str):
    prefix = _sanitize_cache_key(prefix)
    pattern = os.path.join(MEDIA_CACHE_DIR, f"{prefix}.*")
    files = [f for f in glob.glob(pattern) if not f.endswith((".etag", ".name", ".tmp"))]
    if not files:
        return None
    # escolhe o mais recente (se existir mais de 1 por algum motivo)
    files.sort(key=lambda p: os.path.getmtime(p), reverse=True)
    return files[0]


def _cache_write(prefix: str, raw: bytes, mime: str, name: str | None):
    prefix = _sanitize_cache_key(prefix)
    ext = mimetypes.guess_extension(mime or "") or ""
    if ext == ".jpe":
        ext = ".jpg"
    safe_name = _fix_filename(name, mime)

    path = os.path.join(MEDIA_CACHE_DIR, f"{prefix}{ext}")
    tmp = path + ".tmp"
    with open(tmp, "wb") as f:
        f.write(raw)
    os.replace(tmp, path)

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


def _sanitize_cd_filename(name: str) -> str:
    n = (name or "arquivo").replace("\r", "").replace("\n", "").replace('"', "")
    return n or "arquivo"


def _if_none_match_hits(inm: str | None, etag: str) -> bool:
    if not inm or not etag:
        return False
    # Pode vir: W/"..." ou lista: W/"...", W/"..."
    return etag in inm


def _serve_cached(path: str, request: Request):
    etag = None
    name = None
    try:
        with open(path + ".etag", "r") as f:
            etag = (f.read() or "").strip() or None
    except Exception:
        etag = None

    try:
        with open(path + ".name", "r", encoding="utf-8") as f:
            name = (f.read() or "").strip() or None
    except Exception:
        name = None

    if not name:
        name = os.path.basename(path)
    name = _sanitize_cd_filename(name)

    mime = mimetypes.guess_type(path)[0]
    if not mime:
        try:
            with open(path, "rb") as f:
                mime = _sniff_mime(f.read(16))
        except Exception:
            mime = "application/octet-stream"

    headers = {
        "Cache-Control": MEDIA_CACHE_CONTROL,
        "Content-Disposition": f'inline; filename="{name}"',
        "Accept-Ranges": "bytes",
    }
    if etag:
        headers["ETag"] = etag

    inm = request.headers.get("if-none-match")
    has_range = bool(request.headers.get("range"))

    if etag and _if_none_match_hits(inm, etag) and not has_range:
        return Response(status_code=304, headers=headers)

    return FileResponse(path, media_type=mime, headers=headers)


def _inline(raw: bytes, mime: str | None, name: str | None, request: Request | None = None):
    mime = (mime or "application/octet-stream").strip().lower() or "application/octet-stream"
    etag = _etag_from_raw(raw)
    safe_name = _sanitize_cd_filename(_fix_filename(name, mime))

    headers = {
        "Content-Disposition": f'inline; filename="{safe_name}"',
        "Cache-Control": MEDIA_CACHE_CONTROL,
        "ETag": etag,
    }

    if request:
        inm = request.headers.get("if-none-match")
        has_range = bool(request.headers.get("range"))
        if _if_none_match_hits(inm, etag) and not has_range:
            return Response(status_code=304, headers=headers)

    return StreamingResponse(BytesIO(raw), media_type=mime, headers=headers)


def _bucket_for(mime: str, media_type: str | None = None) -> str:
    m = (mime or "").lower()
    mt = (media_type or "").lower()
    if "sticker" in mt:
        return "sticker"
    if m.startswith("image/"):
        if m == "image/webp" and "sticker" in mt:
            return "sticker"
        return "image"
    if m.startswith("video/"):
        return "video"
    if m.startswith("audio/"):
        return "audio"
    if m.startswith("application/"):
        return "document"
    return "document"


def _pdf_page_count(raw: bytes) -> Optional[int]:
    try:
        return raw.count(b"/Type /Page") or None
    except Exception:
        return None


def _assert_midia_acl(
    db: Session,
    *,
    identity,
    empresa_id: int,
    cliente_id: int,
    instancia_id: int | None,
) -> None:
    """
    ACL final da mídia 1:1:
      - empresa
      - instância
      - departamento (via atendimento/cliente)
    """
    assert_cliente_access(
        db,
        identity=identity,
        empresa_id=int(empresa_id),
        cliente_id=int(cliente_id),
        instancia_id=(int(instancia_id) if instancia_id is not None else None),
        allow_unassigned_department=False,
    )


# =========================
# Core: Evolution + persistência
# =========================
def _evo_payloads_for(msg: models.Mensagem, cli: models.Cliente, inst: models.EmpresaInstancia | None):
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
):
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

    for convert in (False, True):
        try:
            return _post({"key": {"id": msg.msg_id}}, convert)
        except Exception as e:
            last_err = str(e)

    for key in _evo_payloads_for(msg, cli, inst):
        for convert in (False, True):
            try:
                return _post(key, convert)
            except Exception as e:
                last_err = str(e)
                continue

    raise RuntimeError(last_err or "falha Evolution")


def _set_attr_if_exists(obj, field: str, value) -> None:
    if hasattr(obj, field):
        setattr(obj, field, value)


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
    Suporta dois modelos:
      - models.Midia (novo)
      - models.MensagemMidia (legado)
    """
    MediaModel = getattr(models, "Midia", None) or getattr(models, "MensagemMidia", None)
    if MediaModel is None:
        return None  # não tem tabela de mídia no schema

    media_type = (meta or {}).get("mediaType")
    size_obj = (meta or {}).get("size") or {}
    file_len = size_obj.get("fileLength")

    try:
        file_len = int(file_len) if file_len is not None else None
    except Exception:
        file_len = None

    fname = _fix_filename(filename, mime)
    bucket = _bucket_for(mime, media_type)

    real_size = len(raw)
    tamanho = file_len or real_size
    sha_hex = hashlib.sha256(raw).hexdigest()

    midia = (
        db.query(MediaModel)
        .filter(getattr(MediaModel, "mensagem_id") == msg.id)
        .order_by(getattr(MediaModel, "id").asc())
        .first()
    )
    if midia is None:
        midia = MediaModel(mensagem_id=msg.id)
        db.add(midia)

    _set_attr_if_exists(midia, "empresa_id", msg.empresa_id)
    _set_attr_if_exists(midia, "cliente_id", msg.cliente_id)

    # nomes variam dependendo do modelo
    _set_attr_if_exists(midia, "mimetype", (mime or "application/octet-stream"))
    _set_attr_if_exists(midia, "mime", (mime or "application/octet-stream"))

    _set_attr_if_exists(midia, "filename", fname or "arquivo")
    _set_attr_if_exists(midia, "name", fname or "arquivo")

    if filename and filename != fname:
        _set_attr_if_exists(midia, "nome_original", filename)

    _set_attr_if_exists(midia, "tipo", bucket)
    _set_attr_if_exists(midia, "tamanho", tamanho)
    _set_attr_if_exists(midia, "size", tamanho)

    _set_attr_if_exists(midia, "file_sha256", sha_hex)
    _set_attr_if_exists(midia, "sha256", sha_hex)

    if local_path:
        _set_attr_if_exists(midia, "local_path", local_path)
        _set_attr_if_exists(midia, "path_local", local_path)
        _set_attr_if_exists(midia, "caminho", local_path)

    # blob
    _set_attr_if_exists(midia, "data", raw)
    _set_attr_if_exists(midia, "conteudo", raw)

    if (mime or "").lower() == "application/pdf":
        pc = _pdf_page_count(raw)
        if pc:
            _set_attr_if_exists(midia, "page_count", pc)

    db.commit()
    try:
        db.refresh(midia)
    except Exception:
        pass
    return midia


# =========================
# Helpers de servir do BD
# =========================
def _serve_midia_model(md: Any, request: Request | None = None) -> Response:
    mimetype = (getattr(md, "mimetype", None) or getattr(md, "mime", None) or "application/octet-stream")
    filename = (
        getattr(md, "filename", None)
        or getattr(md, "name", None)
        or getattr(md, "nome_original", None)
        or "arquivo"
    )
    filename = _sanitize_cd_filename(filename)

    raw = getattr(md, "data", None) or getattr(md, "conteudo", None)
    if raw:
        raw_b = bytes(raw)
        return _inline(raw_b, mimetype, filename, request=request)

    local_path = (
        getattr(md, "local_path", None)
        or getattr(md, "path_local", None)
        or getattr(md, "caminho", None)
    )
    if local_path and os.path.exists(local_path):
        etag = _etag_from_stat(local_path)
        headers = {
            "Cache-Control": MEDIA_CACHE_CONTROL,
            "Content-Disposition": f'inline; filename="{filename}"',
            "Accept-Ranges": "bytes",
        }
        if etag:
            headers["ETag"] = etag
            inm = request.headers.get("if-none-match") if request else None
            has_range = bool(request.headers.get("range")) if request else False
            if inm and _if_none_match_hits(inm, etag) and not has_range:
                return Response(status_code=304, headers=headers)

        return FileResponse(local_path, media_type=mimetype, headers=headers)

    url = getattr(md, "url", None)
    if url:
        return RedirectResponse(url)

    raise HTTPException(404, "Mídia sem conteúdo disponível")


# =========================
# Rotas
# =========================
@router.get("/midias/{midia_id}")
def midia_resolve(
    midia_id: int,
    request: Request,
    empresa_id: int | None = Query(None),
    instancia_id: int | None = Query(None),
    instance: str | None = Query(None),
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
):
    """
    Rota legacy por midia_id — resolve msg_id e REDIRECIONA (307) para a rota por msg_id.
    Propaga empresa_id/instancia_id/instance quando informados.
    Garante ACL de empresa + instância + departamento.
    """
    ensure_perm(identity, "atendimento.ver")

    empresa_id_eff = assert_same_company(identity, empresa_id)
    acl_ctx = resolve_acl_context(db, identity=identity, empresa_id=empresa_id_eff)
    allowed_inst = acl_ctx["allowed_instancias"]

    resolved_inst_id, _resolved_name = _resolve_instancia(
        db,
        empresa_id=empresa_id_eff,
        instancia_id=instancia_id,
        instance=instance,
    )

    if resolved_inst_id is not None:
        assert_instancia_allowed(
            allowed_instancias=allowed_inst,
            instancia_id=resolved_inst_id,
        )

    MediaModel = getattr(models, "Midia", None) or getattr(models, "MensagemMidia", None)
    if MediaModel is None:
        raise HTTPException(500, "Modelo de mídia não disponível no schema (Midia/MensagemMidia).")

    row = (
        db.query(MediaModel, models.Mensagem)
        .join(models.Mensagem, models.Mensagem.id == getattr(MediaModel, "mensagem_id"))
        .filter(getattr(MediaModel, "id") == int(midia_id))
        .first()
    )
    if not row:
        raise HTTPException(404, "Mídia não encontrada")

    mid, msg = row
    if not msg or not msg.msg_id:
        raise HTTPException(404, "Mensagem associada não encontrada")

    if int(msg.empresa_id) != int(empresa_id_eff):
        raise HTTPException(403, "Mídia não pertence à sua empresa")

    if getattr(msg, "instancia_id", None) is not None:
        assert_instancia_allowed(
            allowed_instancias=allowed_inst,
            instancia_id=int(msg.instancia_id),
        )

    _assert_midia_acl(
        db,
        identity=identity,
        empresa_id=int(empresa_id_eff),
        cliente_id=int(msg.cliente_id),
        instancia_id=getattr(msg, "instancia_id", None),
    )

    qs = []
    qs.append(f"empresa_id={empresa_id_eff}")
    if instancia_id is not None:
        qs.append(f"instancia_id={int(instancia_id)}")
    if instance:
        qs.append(f"instance={instance}")
    q = ("?" + "&".join(qs)) if qs else ""

    return RedirectResponse(url=f"/api/atendimento/midias/msg/{msg.msg_id}{q}", status_code=307)


@router.get("/midias/msg/{msg_id}")
def midia_por_msg(
    msg_id: str,
    request: Request,
    empresa_id: int | None = Query(None),
    instancia_id: int | None = Query(None),
    instance: str | None = Query(None),
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
):
    """
    Canônico por msg_id:
      0) cache em disco (ETag/304),
      1) resolve Mensagem+Cliente+Instância,
      2) valida ACL composta (empresa + instância + departamento),
      3) tenta servir do BD,
      4) Evolution como fallback, persistindo e cacheando.
    """
    ensure_perm(identity, "atendimento.ver")

    empresa_id_eff = assert_same_company(identity, empresa_id)
    acl_ctx = resolve_acl_context(db, identity=identity, empresa_id=empresa_id_eff)
    allowed_inst = acl_ctx["allowed_instancias"]

    resolved_inst_id, _resolved_name = _resolve_instancia(
        db,
        empresa_id=empresa_id_eff,
        instancia_id=instancia_id,
        instance=instance,
    )

    if resolved_inst_id is not None:
        assert_instancia_allowed(
            allowed_instancias=allowed_inst,
            instancia_id=resolved_inst_id,
        )

    # 0) Cache no disco?
    cached = _cache_glob_for(msg_id)
    if cached:
        # Mesmo servido do cache, a ACL foi validada acima apenas por filtro.
        # Precisamos validar também a conversa real antes de liberar.
        pass

    # 1) Resolve Mensagem + Cliente + Instância
    q = (
        db.query(models.Mensagem, models.Cliente, models.EmpresaInstancia)
        .join(models.Cliente, models.Cliente.id == models.Mensagem.cliente_id)
        .outerjoin(models.EmpresaInstancia, models.EmpresaInstancia.id == models.Mensagem.instancia_id)
        .filter(
            func.lower(models.Mensagem.msg_id) == msg_id.lower(),
            models.Mensagem.empresa_id == int(empresa_id_eff),
        )
    )

    if resolved_inst_id is not None and hasattr(models.Mensagem, "instancia_id"):
        q = q.filter(models.Mensagem.instancia_id == int(resolved_inst_id))
    elif instancia_id is not None and hasattr(models.Mensagem, "instancia_id"):
        # se veio id mas não resolveu, força "não encontrado"
        q = q.filter(models.Mensagem.instancia_id == int(instancia_id))

    if allowed_inst is not None:
        if not allowed_inst:
            raise HTTPException(403, "Sem instâncias permitidas para este colaborador")
        q = q.filter(models.Mensagem.instancia_id.in_(allowed_inst))

    row = q.first()
    if not row:
        raise HTTPException(404, "Mensagem não encontrada para os filtros informados")

    msg, cli, inst = row

    if getattr(msg, "instancia_id", None) is not None:
        assert_instancia_allowed(
            allowed_instancias=allowed_inst,
            instancia_id=int(msg.instancia_id),
        )

    _assert_midia_acl(
        db,
        identity=identity,
        empresa_id=int(empresa_id_eff),
        cliente_id=int(cli.id),
        instancia_id=getattr(msg, "instancia_id", None),
    )

    # agora sim, pode servir cache
    cached = _cache_glob_for(msg_id)
    if cached:
        return _serve_cached(cached, request)

    # 2) Serve do BD primeiro
    MediaModel = getattr(models, "Midia", None) or getattr(models, "MensagemMidia", None)
    mid_db = None
    if MediaModel is not None:
        mid_db = (
            db.query(MediaModel)
            .filter(getattr(MediaModel, "mensagem_id") == msg.id)
            .order_by(getattr(MediaModel, "id").asc())
            .first()
        )

    if mid_db:
        raw = getattr(mid_db, "data", None) or getattr(mid_db, "conteudo", None)
        if raw:
            raw_b = bytes(raw)
            mime = (
                getattr(mid_db, "mimetype", None)
                or getattr(mid_db, "mime", None)
                or "application/octet-stream"
            ).lower()
            safe_name = _fix_filename(
                getattr(mid_db, "filename", None)
                or getattr(mid_db, "name", None)
                or getattr(mid_db, "nome_original", None)
                or "arquivo",
                mime,
            )
            try:
                path = _cache_write(msg_id, raw_b, mime, safe_name)
                return _serve_cached(path, request)
            except Exception:
                return _inline(raw_b, mime, safe_name, request=request)

        try:
            return _serve_midia_model(mid_db, request=request)
        except Exception:
            pass

    # 3) Evolution como fallback (cache-1x com lock)
    lock = _lock_for(_sanitize_cache_key(msg_id))
    with lock:
        cached2 = _cache_glob_for(msg_id)
        if cached2:
            return _serve_cached(cached2, request)

        try:
            raw, mime, evo_name, meta = _fetch_from_evolution(db, msg, cli, inst)
            safe_name = _fix_filename(evo_name, mime)
            path = _cache_write(msg_id, raw, mime, safe_name)
            _persist_midia(db, msg, raw, mime, evo_name, meta=meta, local_path=path)
            return _serve_cached(path, request)

        except Exception as evo_err:
            # fallback final: tentar servir o que houver no BD (local/url)
            if MediaModel is not None:
                mid2 = (
                    db.query(MediaModel)
                    .filter(getattr(MediaModel, "mensagem_id") == msg.id)
                    .order_by(getattr(MediaModel, "id").desc())
                    .first()
                )
                if mid2:
                    try:
                        return _serve_midia_model(mid2, request=request)
                    except Exception:
                        pass

            raise HTTPException(404, f"Não foi possível obter a mídia por msg_id ({evo_err})")