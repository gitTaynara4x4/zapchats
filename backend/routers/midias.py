# backend/routers/midias.py
from __future__ import annotations

import os
import re
import shutil
import hashlib
from uuid import uuid4
from typing import List, Optional
from datetime import datetime, timezone

from fastapi import (
    APIRouter, Depends, HTTPException, UploadFile, File, Form, Query, Request, Response
)
from fastapi.responses import FileResponse, RedirectResponse
from sqlalchemy.orm import Session
from sqlalchemy import select, desc, asc, or_, and_, func

import jwt

from backend.database import get_db
from backend.models import Midia, Cliente

JWT_SECRET = os.getenv("JWT_SECRET", "troque-me")
JWT_ALG = os.getenv("JWT_ALGORITHM", "HS256")
STORAGE_DIR = os.getenv("MIDIAS_DIR", os.path.join("storage", "midias"))

router = APIRouter(prefix="/api/midias", tags=["Mídias"])


def _decode_token(req: Request) -> dict:
    auth = req.headers.get("Authorization")
    if not auth or not auth.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Token ausente")
    tok = auth.split(" ", 1)[1]
    try:
        return jwt.decode(tok, JWT_SECRET, algorithms=[JWT_ALG]) or {}
    except jwt.PyJWTError:
        raise HTTPException(status_code=401, detail="Token inválido")


def _require_empresa(payload: dict, empresa_id: int):
    emp = payload.get("empresa_id")
    if emp is not None and int(emp) != int(empresa_id):
        raise HTTPException(status_code=403, detail="Empresa divergente do token")


def _has_perm(payload: dict, perm: str) -> bool:
    role = (payload.get("role") or "").lower()
    if role in {"admin", "super"}:
        return True
    perms = payload.get("perms")
    if isinstance(perms, list):
        return perm in perms
    return True


SAFE_CHARS = r"[^A-Za-z0-9\.\-\_\s]"


def safe_filename(name: str) -> str:
    name = re.sub(SAFE_CHARS, "_", (name or "").strip())
    return name or f"arquivo_{uuid4().hex}"


def ensure_dir(path: str):
    os.makedirs(path, exist_ok=True)


def _sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _item_dict(m: Midia, request: Request) -> dict:
    base = str(request.base_url).rstrip("/")
    url = f"{base}/api/midias/file/{m.id}"

    cliente = getattr(m, "cliente", None)
    grupo = getattr(m, "grupo", None)

    return {
        "id": m.id,
        "empresa_id": m.empresa_id,
        "cliente_id": getattr(m, "cliente_id", None),
        "cliente_nome": getattr(cliente, "nome", None) or getattr(cliente, "nome_completo", None),
        "grupo_id": getattr(m, "grupo_id", None),
        "grupo_nome": getattr(grupo, "nome", None),
        "is_group": bool(getattr(m, "grupo_id", None)),
        "nome": m.filename or m.nome_original or f"arquivo_{m.id}",
        "tipo": m.mimetype,
        "tipo_db": m.tipo,
        "tamanho": m.tamanho,
        "timestamp": (m.created_at.astimezone(timezone.utc).isoformat() if m.created_at else None),
        "url": url,
    }


def _ext(name: str) -> str:
    if not name:
        return ""
    a = name.rsplit(".", 1)
    return f".{a[1]}" if len(a) == 2 else ""


DOC_EXTS = {
    ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
    ".txt", ".rtf", ".csv", ".odt", ".ods", ".odp",
    ".zip", ".rar", ".7z", ".tar", ".gz"
}


def guess_tipo(mimetype: str | None, filename: str | None) -> str:
    mt = (mimetype or "").lower()
    ext = (os.path.splitext(filename or "")[1] or "").lower()
    if mt.startswith("image/"):
        return "image"
    if mt.startswith("video/"):
        return "video"
    if mt.startswith("audio/"):
        return "audio"
    if mt == "application/pdf" or ext in DOC_EXTS or mt.startswith("application/") or mt.startswith("text/"):
        return "document"
    return "document"


def _inst_value_param(
    instancia: Optional[str],
    instance: Optional[str],
    inst: Optional[str],
    session: Optional[str],
    sessionName: Optional[str],
    instancia_id: Optional[str],
    whatsapp_id: Optional[str],
) -> Optional[str]:
    for v in (instancia, instance, inst, session, sessionName, instancia_id, whatsapp_id):
        if v:
            return str(v).strip()
    return None


def _inst_filter_if_any(model, value: str):
    if not value:
        return None
    candidates = [
        "instancia_id", "instancia", "instancia_slug",
        "instance_id", "instance", "inst_slug",
        "session", "session_name", "sessionName",
        "whatsapp_id",
    ]
    conds = []
    for col in candidates:
        if hasattr(model, col):
            conds.append(getattr(model, col) == value)
    if not conds:
        return None
    return or_(*conds)


@router.get("")
def list_midias(
    request: Request,
    empresa_id: int = Query(...),
    q: Optional[str] = Query(None, description="Busca por nome do arquivo ou nome do cliente"),
    inicio: Optional[str] = Query(None, description="YYYY-MM-DD (UTC)"),
    fim: Optional[str] = Query(None, description="YYYY-MM-DD (UTC)"),
    cliente_id: Optional[int] = Query(None, description="Filtrar por cliente_id"),
    sem_cliente: Optional[bool] = Query(
        None,
        description="true: só pessoais; false (quando presente): exclui pessoais; omitido: traz tudo da empresa/cliente",
    ),
    ordenar: str = Query("recent", description="recent|old|az|za"),
    tipo: Optional[str] = Query(None, description="imagem|video|audio|documento|image|video|audio|document"),
    doc: Optional[str] = Query(None, description="pdf|word|excel|ppt|text|code|zip|all"),
    instancia: Optional[str] = Query(None),
    instance: Optional[str] = Query(None),
    inst: Optional[str] = Query(None),
    session: Optional[str] = Query(None),
    sessionName: Optional[str] = Query(None),
    instancia_id: Optional[str] = Query(None),
    whatsapp_id: Optional[str] = Query(None),
    limit: int = Query(5, ge=1, le=200),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
):
    payload = _decode_token(request)
    _require_empresa(payload, empresa_id)
    if not _has_perm(payload, "arquivos.ver"):
        raise HTTPException(status_code=403, detail="Sem permissão (arquivos.ver)")

    # join com Cliente para permitir busca por nome do cliente
    stmt = (
        select(Midia)
        .outerjoin(Cliente, Midia.cliente_id == Cliente.id)
        .where(Midia.empresa_id == empresa_id)
    )

    if sem_cliente is True:
        if hasattr(Midia, "grupo_id"):
            stmt = stmt.where(
                Midia.cliente_id.is_(None),
                Midia.grupo_id.is_(None),
            )
        else:
            stmt = stmt.where(Midia.cliente_id.is_(None))

    elif sem_cliente is False and "sem_cliente" in request.query_params:
        if hasattr(Midia, "grupo_id"):
            stmt = stmt.where(
                or_(
                    Midia.cliente_id.is_not(None),
                    Midia.grupo_id.is_not(None),
                )
            )
        else:
            stmt = stmt.where(Midia.cliente_id.is_not(None))

    if cliente_id is not None:
        stmt = stmt.where(Midia.cliente_id == cliente_id)

    inst_value = _inst_value_param(instancia, instance, inst, session, sessionName, instancia_id, whatsapp_id)
    inst_filter = _inst_filter_if_any(Midia, inst_value) if inst_value else None
    if inst_filter is not None:
        stmt = stmt.where(inst_filter)

    if q:
        q_clean = q.strip()
        like = f"%{q_clean}%"

        conds = [
            Midia.filename.ilike(like),
            Midia.nome_original.ilike(like),
            Cliente.nome.ilike(like),
            Cliente.nome_completo.ilike(like),
            Cliente.nome_whatsapp.ilike(like),
            Cliente.telefone.ilike(like),
            Cliente.email.ilike(like),
        ]

        # Busca por telefone sem depender da máscara salva no banco.
        # Ex.: usuário digita 12999998888 e o banco está como (12) 99999-8888.
        digits = re.sub(r"\D+", "", q_clean)
        if digits:
            telefone_limpo = Cliente.telefone
            for ch in ("(", ")", "-", " ", ".", "+"):
                telefone_limpo = func.replace(telefone_limpo, ch, "")
            conds.append(telefone_limpo.ilike(f"%{digits}%"))

        stmt = stmt.where(or_(*conds))

    try:
        if inicio:
            i = datetime.fromisoformat(inicio)
            if i.tzinfo is None:
                i = i.replace(tzinfo=timezone.utc)
            stmt = stmt.where(Midia.created_at >= i)

        if fim:
            f = datetime.fromisoformat(fim)
            if f.tzinfo is None:
                f = f.replace(tzinfo=timezone.utc)
            f = f.replace(hour=23, minute=59, second=59, microsecond=999999)
            stmt = stmt.where(Midia.created_at <= f)
    except ValueError:
        pass

    doc_mime_pred = or_(
        Midia.mimetype.ilike("application/pdf"),
        Midia.mimetype.ilike("application/msword"),
        Midia.mimetype.ilike("application/vnd.openxmlformats-officedocument%"),
        Midia.mimetype.ilike("application/vnd.ms-%"),
        Midia.mimetype.ilike("text/%"),
    )

    tipo_map = {"imagem": "image", "documento": "document"}
    t = (tipo or "").strip().lower()
    t = tipo_map.get(t, t)

    if t in {"image", "video", "audio", "document"}:
        if t == "image":
            stmt = stmt.where(
                or_(Midia.tipo == "image", and_(Midia.tipo.is_(None), Midia.mimetype.ilike("image/%")))
            )
        elif t == "video":
            stmt = stmt.where(
                or_(Midia.tipo == "video", and_(Midia.tipo.is_(None), Midia.mimetype.ilike("video/%")))
            )
        elif t == "audio":
            stmt = stmt.where(
                or_(Midia.tipo == "audio", and_(Midia.tipo.is_(None), Midia.mimetype.ilike("audio/%")))
            )
        else:
            stmt = stmt.where(or_(Midia.tipo == "document", and_(Midia.tipo.is_(None), doc_mime_pred)))

            d = (doc or "").strip().lower()
            if d == "pdf":
                stmt = stmt.where(Midia.mimetype.ilike("application/pdf"))
            elif d == "word":
                stmt = stmt.where(
                    or_(
                        Midia.mimetype.ilike("application/msword"),
                        Midia.mimetype.ilike("application/vnd.openxmlformats-officedocument.wordprocessingml%"),
                    )
                )
            elif d == "excel":
                stmt = stmt.where(
                    or_(
                        Midia.mimetype.ilike("application/vnd.ms-excel"),
                        Midia.mimetype.ilike("application/vnd.openxmlformats-officedocument.spreadsheetml%"),
                        Midia.mimetype.ilike("text/csv"),
                    )
                )
            elif d == "ppt":
                stmt = stmt.where(
                    or_(
                        Midia.mimetype.ilike("application/vnd.ms-powerpoint"),
                        Midia.mimetype.ilike("application/vnd.openxmlformats-officedocument.presentationml%"),
                    )
                )
            elif d == "text":
                stmt = stmt.where(
                    or_(
                        Midia.mimetype.ilike("text/%"),
                        Midia.mimetype.ilike("application/json"),
                        Midia.mimetype.ilike("application/xml"),
                    )
                )
            elif d == "code":
                stmt = stmt.where(
                    or_(
                        Midia.mimetype.ilike("application/json"),
                        Midia.mimetype.ilike("application/xml"),
                        Midia.mimetype.ilike("text/html"),
                        Midia.mimetype.ilike("text/markdown"),
                        Midia.mimetype.ilike("application/javascript"),
                    )
                )
            elif d == "zip":
                stmt = stmt.where(
                    or_(
                        Midia.mimetype.ilike("application/zip"),
                        Midia.mimetype.ilike("application/x-7z-compressed"),
                        Midia.mimetype.ilike("application/x-rar-compressed"),
                        Midia.mimetype.ilike("application/x-tar"),
                        Midia.mimetype.ilike("application/gzip"),
                    )
                )
    else:
        stmt = stmt.where(
            or_(
                Midia.tipo.is_(None),
                Midia.tipo != "sticker"
            )
        )

    ord_key = (ordenar or "recent").lower()
    if ord_key == "old":
        stmt = stmt.order_by(asc(Midia.created_at).nulls_last())
    elif ord_key == "az":
        stmt = stmt.order_by(asc(Midia.filename).nulls_last(), asc(Midia.nome_original).nulls_last())
    elif ord_key == "za":
        stmt = stmt.order_by(desc(Midia.filename).nulls_last(), desc(Midia.nome_original).nulls_last())
    else:
        stmt = stmt.order_by(desc(Midia.created_at).nulls_last())

    stmt = stmt.offset(offset).limit(limit)

    rows = db.execute(stmt).scalars().unique().all()
    return [_item_dict(m, request) for m in rows]


@router.get("/file/{midia_id}")
def get_file(
    midia_id: int,
    request: Request,
    download: bool = Query(False),
    db: Session = Depends(get_db),
):
    m: Midia | None = db.get(Midia, midia_id)
    if not m:
        raise HTTPException(status_code=404, detail="Arquivo não encontrado")

    if m.local_path and os.path.isfile(m.local_path):
        headers = {}
        if download:
            fname = (m.filename or m.nome_original or f"arquivo_{m.id}").replace('"', "_")
            headers["Content-Disposition"] = f'attachment; filename="{fname}"'
        return FileResponse(
            path=m.local_path,
            media_type=m.mimetype or "application/octet-stream",
            headers=headers,
        )

    if m.data:
        headers = {}
        if download:
            fname = (m.filename or m.nome_original or f"arquivo_{m.id}").replace('"', "_")
            headers["Content-Disposition"] = f'attachment; filename="{fname}"'
        return Response(
            content=bytes(m.data),
            media_type=m.mimetype or "application/octet-stream",
            headers=headers,
        )

    if m.url:
        return RedirectResponse(m.url, status_code=307)

    raise HTTPException(status_code=410, detail="Arquivo indisponível")


@router.post("/upload", status_code=201)
async def upload_midias(
    request: Request,
    empresa_id: int = Query(...),
    files: List[UploadFile] = File(...),
    cliente_id: Optional[int] = Form(None),
    mensagem_id: Optional[int] = Form(None),
    instancia: Optional[str] = Form(None),
    instance: Optional[str] = Form(None),
    inst: Optional[str] = Form(None),
    session: Optional[str] = Form(None),
    sessionName: Optional[str] = Form(None),
    instancia_id: Optional[str] = Form(None),
    whatsapp_id: Optional[str] = Form(None),
    db: Session = Depends(get_db),
):
    payload = _decode_token(request)
    _require_empresa(payload, empresa_id)
    if not _has_perm(payload, "midias.criar"):
        raise HTTPException(status_code=403, detail="Sem permissão (midias.criar)")

    saved: list[Midia] = []
    empresa_dir = os.path.join(STORAGE_DIR, str(empresa_id))
    ensure_dir(empresa_dir)

    inst_value = _inst_value_param(instancia, instance, inst, session, sessionName, instancia_id, whatsapp_id)

    for up in files:
        original = up.filename or "arquivo"
        name = safe_filename(original)
        ext = _ext(name)
        uid = uuid4().hex
        final_name = f"{uid}{ext}" if ext else uid
        dest_path = os.path.join(empresa_dir, final_name)

        with open(dest_path, "wb") as f:
            shutil.copyfileobj(up.file, f)
        tamanho = os.path.getsize(dest_path)

        sha = ""
        try:
            sha = _sha256_file(dest_path)
        except Exception:
            pass

        tipo_inferido = guess_tipo(up.content_type, name)

        m = Midia(
            empresa_id=empresa_id,
            cliente_id=cliente_id,
            mensagem_id=mensagem_id,
            tipo=tipo_inferido,
            filename=name,
            mimetype=up.content_type or "application/octet-stream",
            nome_original=original,
            url=None,
            local_path=os.path.abspath(dest_path),
            data=None,
            tamanho=tamanho,
            page_count=None,
            file_sha256=sha or None,
            file_enc_sha256=None,
            created_at=datetime.now(timezone.utc),
        )

        if inst_value:
            for col in (
                "instancia_id", "instancia", "instancia_slug",
                "instance_id", "instance", "inst_slug",
                "session", "session_name", "sessionName",
                "whatsapp_id",
            ):
                if hasattr(Midia, col):
                    setattr(m, col, inst_value)
                    break

        db.add(m)
        saved.append(m)

    db.commit()
    for obj in saved:
        db.refresh(obj)

    return [_item_dict(m, request) for m in saved]


@router.patch("/{midia_id}")
def rename_midia(
    midia_id: int,
    request: Request,
    data: dict,
    empresa_id: int = Query(...),
    db: Session = Depends(get_db),
):
    payload = _decode_token(request)
    _require_empresa(payload, empresa_id)
    if not _has_perm(payload, "midias.renomear"):
        raise HTTPException(status_code=403, detail="Sem permissão (midias.renomear)")

    novo = (data or {}).get("nome")
    if not novo:
        raise HTTPException(status_code=422, detail="Campo 'nome' obrigatório")

    m: Midia | None = db.get(Midia, midia_id)
    if not m or int(m.empresa_id) != int(empresa_id):
        raise HTTPException(status_code=404, detail="Item não encontrado")

    def _get_ext(s: str | None) -> str:
        if not s:
            return ""
        a = s.rsplit(".", 1)
        return f".{a[1]}" if len(a) == 2 else ""

    ext_orig = _get_ext(m.filename or m.nome_original)
    base_sanit = safe_filename(novo)
    if "." in base_sanit:
        base_sanit = base_sanit.rsplit(".", 1)[0]

    final_nome = (base_sanit or f"arquivo_{m.id}") + (ext_orig or "")

    m.filename = final_nome
    db.add(m)
    db.commit()
    db.refresh(m)
    return _item_dict(m, request)


@router.delete("/{midia_id}", status_code=204)
def delete_midia(
    midia_id: int,
    request: Request,
    empresa_id: int = Query(...),
    db: Session = Depends(get_db),
):
    payload = _decode_token(request)
    _require_empresa(payload, empresa_id)
    if not _has_perm(payload, "midias.excluir"):
        raise HTTPException(status_code=403, detail="Sem permissão (midias.excluir)")

    m: Midia | None = db.get(Midia, midia_id)
    if not m or int(m.empresa_id) != int(empresa_id):
        raise HTTPException(status_code=404, detail="Item não encontrado")

    try:
        if m.local_path and os.path.isfile(m.local_path):
            os.remove(m.local_path)
    except OSError:
        pass

    db.delete(m)
    db.commit()
    return Response(status_code=204)