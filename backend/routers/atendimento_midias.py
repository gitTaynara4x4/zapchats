# backend/routers/atendimento_midias.py
# — cache-1x + persistência BD + ETag/304 + multi-instância
# — ACL composta para 1:1: empresa + instância + departamento
# — suporte a grupos: mensagens_grupo + midias.grupo_id + mídia sem mensagem_id

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request, Response, Query
from fastapi.responses import FileResponse, RedirectResponse, StreamingResponse
from sqlalchemy.orm import Session
from sqlalchemy import func, or_
from io import BytesIO
import base64
import re
import os
import mimetypes
import hashlib
import threading
import glob
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
# Evolution env
# =========================
EVOLUTION_URL = (os.getenv("EVOLUTION_URL", "").rstrip("/"))
EVOLUTION_KEY = os.getenv("EVOLUTION_APIKEY") or os.getenv("EVOLUTION_KEY")
HEADERS = {"apikey": EVOLUTION_KEY, "Content-Type": "application/json"} if EVOLUTION_KEY else {}


# =========================
# Cache de arquivos
# =========================
MEDIA_CACHE_DIR = os.getenv("MEDIA_CACHE_DIR", "/var/cache/ZapsChat/media")
os.makedirs(MEDIA_CACHE_DIR, exist_ok=True)

MEDIA_CACHE_CONTROL = "private, max-age=31536000, immutable"

_FETCH_LOCKS: dict[str, threading.Lock] = {}
_FETCH_LOCKS_G = threading.Lock()


def _lock_for(key: str) -> threading.Lock:
    with _FETCH_LOCKS_G:
        if key not in _FETCH_LOCKS:
            _FETCH_LOCKS[key] = threading.Lock()
        return _FETCH_LOCKS[key]


# =========================
# Helpers básicos
# =========================
def _allowed_ints(allowed: Optional[List[int]]) -> Optional[List[int]]:
    if allowed is None:
        return None

    out: List[int] = []

    for x in allowed:
        try:
            out.append(int(x))
        except Exception:
            pass

    return out


def _resolve_instancia(
    db: Session,
    *,
    empresa_id: int,
    instancia_id: int | None,
    instance: str | None,
) -> Tuple[Optional[int], Optional[str]]:
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
                models.EmpresaInstancia.instance_name == str(instance),
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


def _decode_any(b64: str) -> tuple[bytes, str]:
    m = re.match(r"^data:([^;]+);base64,(.+)$", str(b64 or ""))

    if m:
        raw = base64.b64decode(m.group(2), validate=False)
        mime = (m.group(1) or "").strip().lower() or _sniff_mime(raw)
        return raw, mime

    raw = base64.b64decode("".join(str(b64 or "").split()), validate=False)
    return raw, _sniff_mime(raw)


def _fix_filename(name: str | None, mime: str) -> str:
    base = (name or "arquivo").strip() or "arquivo"

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
    return re.sub(r"[^A-Za-z0-9._-]+", "_", key or "")


def _cache_glob_for(prefix: str):
    prefix = _sanitize_cache_key(prefix)
    pattern = os.path.join(MEDIA_CACHE_DIR, f"{prefix}.*")
    files = [f for f in glob.glob(pattern) if not f.endswith((".etag", ".name", ".tmp"))]

    if not files:
        return None

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

    return "document"


def _pdf_page_count(raw: bytes) -> Optional[int]:
    try:
        return raw.count(b"/Type /Page") or None
    except Exception:
        return None


def _set_attr_if_exists(obj, field: str, value) -> None:
    if hasattr(obj, field):
        setattr(obj, field, value)


def _media_model():
    return getattr(models, "Midia", None) or getattr(models, "MensagemMidia", None)


def _media_match_condition(MediaModel, msg_id: str):
    like = f"%{str(msg_id or '').strip()}%"
    conditions = []

    for field in ("msg_id", "wa_msg_id", "message_id"):
        if hasattr(MediaModel, field):
            conditions.append(func.lower(getattr(MediaModel, field)) == str(msg_id).lower())

    for field in ("filename", "name", "nome_original", "url", "local_path", "path_local", "caminho"):
        if hasattr(MediaModel, field):
            conditions.append(getattr(MediaModel, field).ilike(like))

    if not conditions:
        return None

    return or_(*conditions)


def _serve_midia_model(md: Any, request: Request | None = None) -> Response:
    mimetype = (
        getattr(md, "mimetype", None)
        or getattr(md, "mime", None)
        or "application/octet-stream"
    )

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
# ACL
# =========================
def _assert_midia_acl_cliente(
    db: Session,
    *,
    identity,
    empresa_id: int,
    cliente_id: int,
    instancia_id: int | None,
) -> None:
    """
    Modelo 2:
    - Departamento não controla mais WhatsApp.
    - Se a conversa ainda estiver sem departamento, não bloqueia mídia/avatar.
    - Se tiver departamento, segue validando departamentos_membros pelo ACL central.
    """
    assert_cliente_access(
        db,
        identity=identity,
        empresa_id=int(empresa_id),
        cliente_id=int(cliente_id),
        instancia_id=(int(instancia_id) if instancia_id is not None else None),
        allow_unassigned_department=False,
    )


def _assert_grupo_acl(
    *,
    grupo: models.Grupo,
    empresa_id: int,
    allowed_instancias: Optional[List[int]],
) -> None:
    if int(grupo.empresa_id) != int(empresa_id):
        raise HTTPException(403, "Grupo não pertence à sua empresa")

    gid_inst = getattr(grupo, "instancia_id", None)

    if gid_inst is not None:
        assert_instancia_allowed(
            allowed_instancias=allowed_instancias,
            instancia_id=int(gid_inst),
        )


# =========================
# Evolution fetch 1:1
# =========================
def _evo_payloads_for_cliente(
    msg: models.Mensagem,
    cli: models.Cliente,
):
    jid = (cli.telefone or "").strip()

    if jid:
        jid = "".join(ch for ch in jid if ch.isdigit())

        if jid and not jid.startswith("55"):
            jid = "55" + jid

        jid = f"{jid}@s.whatsapp.net" if jid else None
    else:
        jid = None

    payloads = [{"key": {"id": msg.msg_id}}]

    if jid:
        from_me = (msg.tipo == "saida")
        payloads += [
            {"key": {"id": msg.msg_id, "remoteJid": jid, "fromMe": from_me}},
            {"key": {"id": msg.msg_id, "remoteJid": jid, "fromMe": (not from_me)}},
        ]

    return payloads


def _evo_payloads_for_grupo(
    msg: models.MensagemGrupo,
    grp: models.Grupo,
):
    remote_jid = getattr(grp, "remote_jid", None)
    from_me = bool(getattr(msg, "from_me", False))
    participant = getattr(msg, "author_jid", None)

    payloads = [{"key": {"id": msg.msg_id}}]

    if remote_jid:
        base = {
            "id": str(msg.msg_id),
            "remoteJid": str(remote_jid),
            "fromMe": from_me,
        }

        if participant and not from_me:
            base["participant"] = str(participant)

        payloads.append({"key": dict(base)})

        alt = dict(base)
        alt["fromMe"] = not from_me
        payloads.append({"key": alt})

        if participant:
            no_part = dict(base)
            no_part.pop("participant", None)
            payloads.append({"key": no_part})

    return payloads


def _fetch_from_evolution_payloads(
    *,
    instance_name: str,
    payloads: List[Dict[str, Any]],
):
    if not EVOLUTION_KEY:
        raise RuntimeError("Evolution KEY ausente")

    if not EVOLUTION_URL:
        raise RuntimeError("Evolution URL ausente")

    if not instance_name:
        raise RuntimeError("instance_name ausente para a mensagem")

    import requests

    urls = [
        f"{EVOLUTION_URL}/chat/getBase64FromMediaMessage/{instance_name}",
        f"{EVOLUTION_URL}/message/getBase64FromMediaMessage/{instance_name}",
    ]

    last_err = None

    def _post(url: str, payload_msg: Dict[str, Any], convert: bool):
        body = {
            "message": payload_msg,
            "convertToMp4": bool(convert),
        }

        r = requests.post(url, headers=HEADERS, json=body, timeout=60)

        if r.status_code not in (200, 201):
            raise RuntimeError(f"HTTP {r.status_code} {r.text[:180]}")

        j = r.json() or {}
        b64 = j.get("base64") or _find_b64(j)

        if not b64:
            raise RuntimeError("retorno sem base64")

        raw, sniff = _decode_any(b64)
        mime = (j.get("mimetype") or j.get("mimeType") or sniff or _sniff_mime(raw)).lower()

        name = (
            j.get("fileName")
            or j.get("filename")
            or j.get("name")
            or None
        )

        meta = {
            "mediaType": j.get("mediaType") or j.get("messageType") or j.get("type"),
            "caption": j.get("caption"),
            "size": j.get("size") or {},
        }

        return raw, mime, name, meta

    for url in urls:
        for payload in payloads:
            for convert in (False, True):
                try:
                    return _post(url, payload, convert)
                except Exception as e:
                    last_err = str(e)
                    continue

    raise RuntimeError(last_err or "falha Evolution")


def _fetch_from_evolution_cliente(
    msg: models.Mensagem,
    cli: models.Cliente,
    inst: models.EmpresaInstancia | None,
):
    instance_name = getattr(inst, "instance_name", None)
    payloads = _evo_payloads_for_cliente(msg, cli)
    return _fetch_from_evolution_payloads(instance_name=instance_name, payloads=payloads)


def _fetch_from_evolution_grupo(
    msg: models.MensagemGrupo,
    grp: models.Grupo,
    inst: models.EmpresaInstancia | None,
):
    instance_name = getattr(inst, "instance_name", None)
    payloads = _evo_payloads_for_grupo(msg, grp)
    return _fetch_from_evolution_payloads(instance_name=instance_name, payloads=payloads)


# =========================
# Persistência Midia
# =========================
def _persist_midia_cliente(
    db: Session,
    msg: models.Mensagem,
    raw: bytes,
    mime: str,
    filename: str | None,
    meta: dict | None = None,
    local_path: str | None = None,
):
    MediaModel = _media_model()

    if MediaModel is None:
        return None

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
    _set_attr_if_exists(midia, "grupo_id", None)
    _set_attr_if_exists(midia, "instancia_id", msg.instancia_id)

    _set_attr_if_exists(midia, "mimetype", mime or "application/octet-stream")
    _set_attr_if_exists(midia, "mime", mime or "application/octet-stream")

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


def _persist_midia_grupo(
    db: Session,
    msg: models.MensagemGrupo,
    grp: models.Grupo,
    raw: bytes,
    mime: str,
    filename: str | None,
    meta: dict | None = None,
    local_path: str | None = None,
):
    MediaModel = _media_model()

    if MediaModel is None:
        return None

    media_type = (meta or {}).get("mediaType") or getattr(msg, "message_type", None)
    size_obj = (meta or {}).get("size") or {}
    file_len = size_obj.get("fileLength")

    try:
        file_len = int(file_len) if file_len is not None else None
    except Exception:
        file_len = None

    fname = _fix_filename(filename or str(msg.msg_id), mime)
    bucket = _bucket_for(mime, media_type)

    real_size = len(raw)
    tamanho = file_len or real_size
    sha_hex = hashlib.sha256(raw).hexdigest()

    match = _media_match_condition(MediaModel, str(msg.msg_id))

    q = db.query(MediaModel)

    if hasattr(MediaModel, "empresa_id"):
        q = q.filter(getattr(MediaModel, "empresa_id") == int(msg.empresa_id))

    if hasattr(MediaModel, "grupo_id"):
        q = q.filter(getattr(MediaModel, "grupo_id") == int(grp.id))

    if hasattr(MediaModel, "instancia_id") and getattr(msg, "instancia_id", None) is not None:
        q = q.filter(getattr(MediaModel, "instancia_id") == int(msg.instancia_id))

    if match is not None:
        q = q.filter(match)

    midia = q.order_by(getattr(MediaModel, "id").desc()).first()

    if midia is None:
        midia = MediaModel()
        db.add(midia)

    _set_attr_if_exists(midia, "empresa_id", msg.empresa_id)
    _set_attr_if_exists(midia, "cliente_id", None)
    _set_attr_if_exists(midia, "grupo_id", int(grp.id))
    _set_attr_if_exists(midia, "mensagem_id", None)
    _set_attr_if_exists(midia, "instancia_id", msg.instancia_id)

    _set_attr_if_exists(midia, "mimetype", mime or "application/octet-stream")
    _set_attr_if_exists(midia, "mime", mime or "application/octet-stream")

    _set_attr_if_exists(midia, "filename", fname or "arquivo")
    _set_attr_if_exists(midia, "name", fname or "arquivo")
    _set_attr_if_exists(midia, "nome_original", filename or fname or str(msg.msg_id))

    _set_attr_if_exists(midia, "tipo", bucket)
    _set_attr_if_exists(midia, "tamanho", tamanho)
    _set_attr_if_exists(midia, "size", tamanho)

    _set_attr_if_exists(midia, "file_sha256", sha_hex)
    _set_attr_if_exists(midia, "sha256", sha_hex)

    if local_path:
        _set_attr_if_exists(midia, "local_path", local_path)
        _set_attr_if_exists(midia, "path_local", local_path)
        _set_attr_if_exists(midia, "caminho", local_path)

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
# Busca de mídia no BD
# =========================
def _find_midia_cliente_by_msg(
    db: Session,
    *,
    msg: models.Mensagem,
    msg_id: str,
):
    MediaModel = _media_model()

    if MediaModel is None:
        return None

    conditions = []

    if hasattr(MediaModel, "mensagem_id"):
        conditions.append(getattr(MediaModel, "mensagem_id") == int(msg.id))

    match = _media_match_condition(MediaModel, msg_id)

    if match is not None:
        conditions.append(match)

    if not conditions:
        return None

    q = db.query(MediaModel)

    if hasattr(MediaModel, "empresa_id"):
        q = q.filter(getattr(MediaModel, "empresa_id") == int(msg.empresa_id))

    if hasattr(MediaModel, "cliente_id"):
        q = q.filter(getattr(MediaModel, "cliente_id") == int(msg.cliente_id))

    if hasattr(MediaModel, "instancia_id") and getattr(msg, "instancia_id", None) is not None:
        q = q.filter(getattr(MediaModel, "instancia_id") == int(msg.instancia_id))

    q = q.filter(or_(*conditions))

    return q.order_by(getattr(MediaModel, "id").asc()).first()


def _find_midia_grupo_by_msg(
    db: Session,
    *,
    msg: models.MensagemGrupo,
    grp: models.Grupo,
    msg_id: str,
):
    MediaModel = _media_model()

    if MediaModel is None:
        return None

    match = _media_match_condition(MediaModel, msg_id)

    if match is None:
        return None

    q = db.query(MediaModel)

    if hasattr(MediaModel, "empresa_id"):
        q = q.filter(getattr(MediaModel, "empresa_id") == int(msg.empresa_id))

    if hasattr(MediaModel, "grupo_id"):
        q = q.filter(getattr(MediaModel, "grupo_id") == int(grp.id))

    if hasattr(MediaModel, "instancia_id") and getattr(msg, "instancia_id", None) is not None:
        q = q.filter(getattr(MediaModel, "instancia_id") == int(msg.instancia_id))

    q = q.filter(match)

    return q.order_by(getattr(MediaModel, "id").desc()).first()


# =========================
# Resolução de mensagem
# =========================
def _resolve_msg_cliente(
    db: Session,
    *,
    msg_id: str,
    empresa_id: int,
    resolved_inst_id: Optional[int],
    allowed_inst: Optional[List[int]],
):
    q = (
        db.query(models.Mensagem, models.Cliente, models.EmpresaInstancia)
        .join(models.Cliente, models.Cliente.id == models.Mensagem.cliente_id)
        .outerjoin(models.EmpresaInstancia, models.EmpresaInstancia.id == models.Mensagem.instancia_id)
        .filter(
            func.lower(models.Mensagem.msg_id) == str(msg_id).lower(),
            models.Mensagem.empresa_id == int(empresa_id),
        )
    )

    if resolved_inst_id is not None:
        q = q.filter(models.Mensagem.instancia_id == int(resolved_inst_id))

    allowed_int = _allowed_ints(allowed_inst)

    if allowed_int is not None:
        if not allowed_int:
            raise HTTPException(403, "Sem instâncias permitidas para este colaborador")

        q = q.filter(models.Mensagem.instancia_id.in_(allowed_int))

    return q.first()


def _resolve_msg_grupo(
    db: Session,
    *,
    msg_id: str,
    empresa_id: int,
    resolved_inst_id: Optional[int],
    allowed_inst: Optional[List[int]],
):
    q = (
        db.query(models.MensagemGrupo, models.Grupo, models.EmpresaInstancia)
        .join(models.Grupo, models.Grupo.id == models.MensagemGrupo.grupo_id)
        .outerjoin(models.EmpresaInstancia, models.EmpresaInstancia.id == models.MensagemGrupo.instancia_id)
        .filter(
            func.lower(models.MensagemGrupo.msg_id) == str(msg_id).lower(),
            models.MensagemGrupo.empresa_id == int(empresa_id),
        )
    )

    if resolved_inst_id is not None:
        q = q.filter(models.MensagemGrupo.instancia_id == int(resolved_inst_id))

    allowed_int = _allowed_ints(allowed_inst)

    if allowed_int is not None:
        if not allowed_int:
            raise HTTPException(403, "Sem instâncias permitidas para este colaborador")

        q = q.filter(models.MensagemGrupo.instancia_id.in_(allowed_int))

    return q.first()


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
    Rota por midia_id.

    1:1:
      - valida ACL do cliente
      - se tiver msg_id, redireciona para /midias/msg/{msg_id}

    Grupo:
      - valida empresa + instância
      - serve direto a mídia, porque midias.mensagem_id pode ser NULL
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

    if (instancia_id is not None or instance) and resolved_inst_id is None:
        raise HTTPException(404, "Instância não encontrada para a empresa.")

    if resolved_inst_id is not None:
        assert_instancia_allowed(
            allowed_instancias=allowed_inst,
            instancia_id=resolved_inst_id,
        )

    MediaModel = _media_model()

    if MediaModel is None:
        raise HTTPException(500, "Modelo de mídia não disponível no schema.")

    mid = (
        db.query(MediaModel)
        .filter(getattr(MediaModel, "id") == int(midia_id))
        .first()
    )

    if not mid:
        raise HTTPException(404, "Mídia não encontrada")

    mid_empresa_id = getattr(mid, "empresa_id", None)

    if mid_empresa_id is not None and int(mid_empresa_id) != int(empresa_id_eff):
        raise HTTPException(403, "Mídia não pertence à sua empresa")

    mid_instancia_id = getattr(mid, "instancia_id", None)

    if mid_instancia_id is not None:
        assert_instancia_allowed(
            allowed_instancias=allowed_inst,
            instancia_id=int(mid_instancia_id),
        )

        if resolved_inst_id is not None and int(mid_instancia_id) != int(resolved_inst_id):
            raise HTTPException(404, "Mídia não encontrada nessa instância")

    mid_cliente_id = getattr(mid, "cliente_id", None)
    mid_grupo_id = getattr(mid, "grupo_id", None)
    mid_mensagem_id = getattr(mid, "mensagem_id", None)

    if mid_cliente_id is not None:
        _assert_midia_acl_cliente(
            db,
            identity=identity,
            empresa_id=int(empresa_id_eff),
            cliente_id=int(mid_cliente_id),
            instancia_id=mid_instancia_id,
        )

        if mid_mensagem_id is not None:
            msg = (
                db.query(models.Mensagem)
                .filter(
                    models.Mensagem.id == int(mid_mensagem_id),
                    models.Mensagem.empresa_id == int(empresa_id_eff),
                )
                .first()
            )

            if msg and msg.msg_id:
                qs = [f"empresa_id={empresa_id_eff}"]

                if instancia_id is not None:
                    qs.append(f"instancia_id={int(instancia_id)}")

                if instance:
                    qs.append(f"instance={instance}")

                q = "?" + "&".join(qs)

                return RedirectResponse(
                    url=f"/api/atendimento/midias/msg/{msg.msg_id}{q}",
                    status_code=307,
                )

        return _serve_midia_model(mid, request=request)

    if mid_grupo_id is not None:
        grp = (
            db.query(models.Grupo)
            .filter(
                models.Grupo.id == int(mid_grupo_id),
                models.Grupo.empresa_id == int(empresa_id_eff),
            )
            .first()
        )

        if not grp:
            raise HTTPException(404, "Grupo da mídia não encontrado")

        _assert_grupo_acl(
            grupo=grp,
            empresa_id=int(empresa_id_eff),
            allowed_instancias=allowed_inst,
        )

        return _serve_midia_model(mid, request=request)

    return _serve_midia_model(mid, request=request)


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
    Canônico por msg_id.

    Suporta:
      - mensagens 1:1 em models.Mensagem
      - mensagens de grupo em models.MensagemGrupo
      - mídia de grupo salva em midias.grupo_id com mensagem_id NULL
      - cache em disco
      - fallback Evolution
    """
    ensure_perm(identity, "atendimento.ver")

    msg_id = str(msg_id or "").strip()

    if not msg_id:
        raise HTTPException(400, "msg_id inválido")

    empresa_id_eff = assert_same_company(identity, empresa_id)
    acl_ctx = resolve_acl_context(db, identity=identity, empresa_id=empresa_id_eff)
    allowed_inst = acl_ctx["allowed_instancias"]

    resolved_inst_id, _resolved_name = _resolve_instancia(
        db,
        empresa_id=empresa_id_eff,
        instancia_id=instancia_id,
        instance=instance,
    )

    if (instancia_id is not None or instance) and resolved_inst_id is None:
        raise HTTPException(404, "Instância não encontrada para a empresa.")

    if resolved_inst_id is not None:
        assert_instancia_allowed(
            allowed_instancias=allowed_inst,
            instancia_id=resolved_inst_id,
        )

    # =====================================================
    # 1) tenta resolver como mensagem 1:1
    # =====================================================
    row_cli = _resolve_msg_cliente(
        db,
        msg_id=msg_id,
        empresa_id=int(empresa_id_eff),
        resolved_inst_id=resolved_inst_id,
        allowed_inst=allowed_inst,
    )

    if row_cli:
        msg, cli, inst = row_cli

        if getattr(msg, "instancia_id", None) is not None:
            assert_instancia_allowed(
                allowed_instancias=allowed_inst,
                instancia_id=int(msg.instancia_id),
            )

        _assert_midia_acl_cliente(
            db,
            identity=identity,
            empresa_id=int(empresa_id_eff),
            cliente_id=int(cli.id),
            instancia_id=getattr(msg, "instancia_id", None),
        )

        cached = _cache_glob_for(msg_id)

        if cached:
            return _serve_cached(cached, request)

        mid_db = _find_midia_cliente_by_msg(
            db,
            msg=msg,
            msg_id=msg_id,
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
                    or f"{msg_id}.bin",
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

        lock = _lock_for(_sanitize_cache_key(msg_id))

        with lock:
            cached2 = _cache_glob_for(msg_id)

            if cached2:
                return _serve_cached(cached2, request)

            try:
                raw, mime, evo_name, meta = _fetch_from_evolution_cliente(msg, cli, inst)
                safe_name = _fix_filename(evo_name or str(msg_id), mime)
                path = _cache_write(msg_id, raw, mime, safe_name)

                _persist_midia_cliente(
                    db,
                    msg,
                    raw,
                    mime,
                    evo_name or safe_name,
                    meta=meta,
                    local_path=path,
                )

                return _serve_cached(path, request)

            except Exception as evo_err:
                mid2 = _find_midia_cliente_by_msg(
                    db,
                    msg=msg,
                    msg_id=msg_id,
                )

                if mid2:
                    try:
                        return _serve_midia_model(mid2, request=request)
                    except Exception:
                        pass

                raise HTTPException(
                    404,
                    f"Não foi possível obter a mídia 1:1 por msg_id ({evo_err})",
                )

    # =====================================================
    # 2) tenta resolver como mensagem de GRUPO
    # =====================================================
    row_grp = _resolve_msg_grupo(
        db,
        msg_id=msg_id,
        empresa_id=int(empresa_id_eff),
        resolved_inst_id=resolved_inst_id,
        allowed_inst=allowed_inst,
    )

    if not row_grp:
        raise HTTPException(404, "Mensagem não encontrada para os filtros informados")

    msg_g, grp, inst_g = row_grp

    if getattr(msg_g, "instancia_id", None) is not None:
        assert_instancia_allowed(
            allowed_instancias=allowed_inst,
            instancia_id=int(msg_g.instancia_id),
        )

    _assert_grupo_acl(
        grupo=grp,
        empresa_id=int(empresa_id_eff),
        allowed_instancias=allowed_inst,
    )

    cached = _cache_glob_for(msg_id)

    if cached:
        return _serve_cached(cached, request)

    mid_g = _find_midia_grupo_by_msg(
        db,
        msg=msg_g,
        grp=grp,
        msg_id=msg_id,
    )

    if mid_g:
        raw = getattr(mid_g, "data", None) or getattr(mid_g, "conteudo", None)

        if raw:
            raw_b = bytes(raw)

            mime = (
                getattr(mid_g, "mimetype", None)
                or getattr(mid_g, "mime", None)
                or "application/octet-stream"
            ).lower()

            safe_name = _fix_filename(
                getattr(mid_g, "filename", None)
                or getattr(mid_g, "name", None)
                or getattr(mid_g, "nome_original", None)
                or f"{msg_id}.bin",
                mime,
            )

            try:
                path = _cache_write(msg_id, raw_b, mime, safe_name)
                return _serve_cached(path, request)
            except Exception:
                return _inline(raw_b, mime, safe_name, request=request)

        try:
            return _serve_midia_model(mid_g, request=request)
        except Exception:
            pass

    lock = _lock_for(_sanitize_cache_key(msg_id))

    with lock:
        cached2 = _cache_glob_for(msg_id)

        if cached2:
            return _serve_cached(cached2, request)

        try:
            raw, mime, evo_name, meta = _fetch_from_evolution_grupo(msg_g, grp, inst_g)
            safe_name = _fix_filename(evo_name or str(msg_id), mime)
            path = _cache_write(msg_id, raw, mime, safe_name)

            _persist_midia_grupo(
                db,
                msg_g,
                grp,
                raw,
                mime,
                evo_name or safe_name,
                meta=meta,
                local_path=path,
            )

            return _serve_cached(path, request)

        except Exception as evo_err:
            mid2 = _find_midia_grupo_by_msg(
                db,
                msg=msg_g,
                grp=grp,
                msg_id=msg_id,
            )

            if mid2:
                try:
                    return _serve_midia_model(mid2, request=request)
                except Exception:
                    pass

            raise HTTPException(
                404,
                f"Não foi possível obter a mídia de grupo por msg_id ({evo_err})",
            )