# backend/routers/atendimento_busca.py
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Body, Query, Response, Path
import os
import re
import unicodedata
import requests
from urllib.parse import quote
from typing import Any, Dict, List, Optional, Tuple
from datetime import datetime, timezone

from pydantic import BaseModel
from sqlalchemy.orm import Session
from sqlalchemy import or_, func
from sqlalchemy.exc import ProgrammingError

from backend.database import get_db
from backend import models
from backend.routers.auth import get_current_identity
from backend.integrations.evolution.utils.phone_utils import (
    formatar_telefone_br,
    normalize_phone_for_db,
    normalize_phone_for_send,
)
from backend.security.atendimento_acl import (
    ensure_perm,
    assert_same_company,
    resolve_acl_context,
    assert_instancia_allowed,
    assert_cliente_access,
)

router = APIRouter(tags=["Atendimento – Perfil / Evolution & Busca/Arquivo"])


# =========================================================
# Evolution config
# =========================================================
EVOLUTION_URL = (os.getenv("EVOLUTION_URL", "").rstrip("/"))
EVOLUTION_KEY = os.getenv("EVOLUTION_APIKEY") or os.getenv("EVOLUTION_KEY")
HEADERS = {"apikey": EVOLUTION_KEY, "Content-Type": "application/json"} if EVOLUTION_KEY else {}


# =========================================================
# Utils ACL/cache
# =========================================================
def _cliente_acl_ok(
    db: Session,
    *,
    identity,
    empresa_id: int,
    cliente_id: int,
    instancia_id: int | None = None,
    cache: dict[int, bool] | None = None,
) -> bool:
    key = int(cliente_id)
    if cache is not None and key in cache:
        return bool(cache[key])

    try:
        assert_cliente_access(
            db,
            identity=identity,
            empresa_id=int(empresa_id),
            cliente_id=int(cliente_id),
            instancia_id=instancia_id,
            allow_unassigned_department=True,
        )
        ok = True
    except HTTPException:
        ok = False

    if cache is not None:
        cache[key] = ok
    return ok


def _resolve_instancia_id(
    db: Session,
    *,
    empresa_id: int,
    instancia_id: Optional[int],
    instance: Optional[str],
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
                models.EmpresaInstancia.instance_name == instance,
            )
            .first()
        )
        if row:
            return int(row.id), row.instance_name
        return None, None

    return None, None


def _to_int(v) -> Optional[int]:
    try:
        if v is None:
            return None
        return int(v)
    except Exception:
        return None


# =========================================================
# Schemas
# =========================================================
class FetchProfileIn(BaseModel):
    number: str
    empresa_id: int | None = None
    instancia_id: int | None = None
    instance: str | None = None


class SaveProfileIn(BaseModel):
    avatar_url: str | None = None
    is_business: bool | None = None
    status_text: str | None = None
    email: str | None = None
    description: str | None = None
    website: str | None = None
    sobre_cliente: str | None = None

    name: str | None = None
    isBusiness: bool | None = None
    picture: str | None = None
    status: dict | None = None


class SaveCustomIn(BaseModel):
    nome_completo: str | None = None
    cpf_cnpj: str | None = None
    rg: str | None = None
    email: str | None = None
    cep: str | None = None
    endereco: str | None = None
    numero: str | None = None
    complemento: str | None = None
    bairro: str | None = None
    cidade: str | None = None
    estado: str | None = None
    data_nascimento: str | None = None
    genero: str | None = None


# =========================================================
# Helpers gerais
# =========================================================
def _pick_instance_name(
    db: Session,
    empresa_id_eff: int,
    allowed: Optional[List[int]],
    instance: str | None = None,
    instancia_id: int | None = None,
) -> str:
    q = db.query(models.EmpresaInstancia).filter(models.EmpresaInstancia.empresa_id == int(empresa_id_eff))

    if allowed is not None:
        if not allowed:
            raise HTTPException(403, "Nenhuma instância permitida para este usuário.")
        q = q.filter(models.EmpresaInstancia.id.in_([int(x) for x in allowed]))

    if instance:
        row = q.filter(models.EmpresaInstancia.instance_name == instance).first()
        if not row:
            raise HTTPException(404, "Instância não encontrada para a empresa.")
        return row.instance_name

    if instancia_id is not None:
        row = q.filter(models.EmpresaInstancia.id == int(instancia_id)).first()
        if row:
            return row.instance_name
        raise HTTPException(404, "Instância (id) não encontrada para a empresa.")

    row = q.order_by(
        models.EmpresaInstancia.connected.desc(),
        models.EmpresaInstancia.last_seen.desc().nullslast(),
        models.EmpresaInstancia.id.asc(),
    ).first()

    if not row:
        raise HTTPException(400, "Empresa sem instância configurada.")

    return row.instance_name


def _norm_str(v: str | None) -> str | None:
    if v is None:
        return None
    v = str(v).strip()
    return v or None


def _clean(v):
    if isinstance(v, str):
        v = v.strip()
        return v or None
    return v


def _normalize_text(s: Optional[str]) -> str:
    if not s:
        return ""
    s = unicodedata.normalize("NFD", str(s))
    s = "".join(ch for ch in s if unicodedata.category(ch) != "Mn")
    return s.lower().strip()


def _parse_date_any(v):
    if v is None:
        return None

    s = str(v).strip()
    if not s:
        return None

    m = re.match(r"^(\d{2})/(\d{2})/(\d{4})$", s)
    if m:
        dd, mm, yy = map(int, m.groups())
        try:
            return datetime(yy, mm, dd, tzinfo=timezone.utc)
        except ValueError:
            return None

    try:
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        dt = datetime.fromisoformat(s)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except Exception:
        pass

    m = re.match(r"^(\d{4})-(\d{2})-(\d{2})$", s)
    if m:
        yy, mm, dd = map(int, m.groups())
        try:
            return datetime(yy, mm, dd, tzinfo=timezone.utc)
        except ValueError:
            return None

    return None


def _only_digits(s: str | None) -> str:
    return re.sub(r"\D+", "", str(s or ""))


def _normalize_lookup_number(raw: str | None) -> tuple[str | None, str | None]:
    return normalize_phone_for_db(raw), normalize_phone_for_send(raw)


def _telefone_match_clause(raw: str | None):
    numero_db_norm, numero_send_norm = _normalize_lookup_number(raw)
    clauses = []

    if numero_db_norm:
        clauses.append(models.Cliente.telefone_norm == numero_db_norm)
        clauses.append(func.right(models.Cliente.telefone_norm, len(numero_db_norm)) == numero_db_norm)

    if numero_send_norm:
        telefone_digits = func.regexp_replace(func.coalesce(models.Cliente.telefone, ""), r"\D", "", "g")
        clauses.append(telefone_digits == numero_send_norm)

        if numero_db_norm:
            clauses.append(func.right(telefone_digits, len(numero_db_norm)) == numero_db_norm)

    if not clauses:
        return None

    return or_(*clauses)


def _find_cliente_by_phone(
    db: Session,
    *,
    empresa_id: int,
    raw_number: str | None,
):
    clause = _telefone_match_clause(raw_number)
    if clause is None:
        return None

    try:
        return (
            db.query(models.Cliente)
            .filter(models.Cliente.empresa_id == int(empresa_id))
            .filter(clause)
            .order_by(models.Cliente.id.desc())
            .first()
        )
    except Exception:
        return None


def _set_if_changed(row, field: str, value) -> bool:
    if not hasattr(row, field):
        return False
    if value is None or value == "":
        return False

    old = getattr(row, field)
    if old != value:
        setattr(row, field, value)
        return True

    return False


def _set_nullable_if_changed(row, field: str, value) -> bool:
    if not hasattr(row, field):
        return False

    old = getattr(row, field)
    if old != value:
        setattr(row, field, value)
        return True

    return False


def _avatar_proxy_url(cliente_id: int) -> str:
    return f"/api/atendimento/avatar/{int(cliente_id)}"


def _avatar_proxy_url_kind(conversation_id: int, kind: str) -> str:
    kind_norm = str(kind or "cliente").strip().lower()
    if kind_norm in {"grupo", "group", "g"}:
        return f"/api/atendimento/avatar/{int(conversation_id)}?kind=grupo"
    return f"/api/atendimento/avatar/{int(conversation_id)}?kind=cliente"


def _safe_json(resp: requests.Response) -> dict:
    try:
        data = resp.json()
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _extract_picture_url(data: dict) -> Optional[str]:
    if not isinstance(data, dict):
        return None

    candidates = [
        data.get("picture"),
        data.get("profilePictureUrl"),
        data.get("profilePicUrl"),
        data.get("pictureUrl"),
        data.get("imgUrl"),
        data.get("avatar"),
        data.get("avatarUrl"),
        data.get("url"),
    ]

    status_obj = data.get("status")
    if isinstance(status_obj, dict):
        candidates.extend([
            status_obj.get("picture"),
            status_obj.get("profilePictureUrl"),
            status_obj.get("profilePicUrl"),
            status_obj.get("pictureUrl"),
        ])

    group_obj = data.get("group")
    if isinstance(group_obj, dict):
        candidates.extend([
            group_obj.get("picture"),
            group_obj.get("profilePictureUrl"),
            group_obj.get("profilePicUrl"),
            group_obj.get("pictureUrl"),
            group_obj.get("imgUrl"),
            group_obj.get("avatar"),
            group_obj.get("avatarUrl"),
        ])

    for v in candidates:
        if isinstance(v, str):
            s = v.strip()
            if s and not re.match(r"^(null|undefined)$", s, re.I):
                return s

    return None


# =========================================================
# Evolution: perfil contato
# =========================================================
def _evo_fetch_profile_picture_url(instance_name: str, numero_send_norm: str) -> Optional[str]:
    if not EVOLUTION_URL or not instance_name or not numero_send_norm:
        return None

    url = f"{EVOLUTION_URL}/chat/fetchProfilePictureUrl/{instance_name}"

    payloads = [
        {"number": numero_send_norm},
        {"number": f"{numero_send_norm}@s.whatsapp.net"},
        {"number": f"{numero_send_norm}@c.us"},
    ]

    for body in payloads:
        try:
            r = requests.post(url, headers=HEADERS, json=body, timeout=20)
        except requests.RequestException:
            continue

        if r.status_code != 200:
            continue

        data = _safe_json(r)
        pic = _extract_picture_url(data)
        if pic:
            return pic

    return None


def _evo_fetch_profile(instance_name: str, numero_send_norm: str) -> Dict[str, Any]:
    if not EVOLUTION_URL or not instance_name or not numero_send_norm:
        return {}

    url = f"{EVOLUTION_URL}/chat/fetchProfile/{instance_name}"

    payloads = [
        {"number": numero_send_norm},
        {"number": f"{numero_send_norm}@s.whatsapp.net"},
        {"number": f"{numero_send_norm}@c.us"},
    ]

    for body in payloads:
        try:
            r = requests.post(url, headers=HEADERS, json=body, timeout=25)
        except requests.RequestException:
            continue

        if r.status_code != 200:
            continue

        data = _safe_json(r)
        if data:
            return data

    return {}


# =========================================================
# Evolution: perfil grupo
# =========================================================
def _evo_fetch_group_infos(instance_name: str, group_jid: str) -> Dict[str, Any]:
    if not EVOLUTION_URL or not instance_name or not group_jid:
        return {}

    url = f"{EVOLUTION_URL}/group/findGroupInfos/{instance_name}"

    param_candidates = [
        {"groupJid": group_jid},
        {"remoteJid": group_jid},
        {"jid": group_jid},
    ]

    for params in param_candidates:
        try:
            r = requests.get(url, headers=HEADERS, params=params, timeout=25)
        except requests.RequestException:
            continue

        if r.status_code != 200:
            continue

        data = _safe_json(r)
        if data:
            return data

    body_candidates = [
        {"groupJid": group_jid},
        {"remoteJid": group_jid},
        {"jid": group_jid},
    ]

    for body in body_candidates:
        try:
            r = requests.post(url, headers=HEADERS, json=body, timeout=25)
        except requests.RequestException:
            continue

        if r.status_code != 200:
            continue

        data = _safe_json(r)
        if data:
            return data

    return {}


def _evo_fetch_profile_picture_url_any_jid(instance_name: str, jid: str) -> Optional[str]:
    if not EVOLUTION_URL or not instance_name or not jid:
        return None

    url = f"{EVOLUTION_URL}/chat/fetchProfilePictureUrl/{instance_name}"

    payloads = [
        {"number": jid},
        {"remoteJid": jid},
        {"jid": jid},
        {"groupJid": jid},
    ]

    for body in payloads:
        try:
            r = requests.post(url, headers=HEADERS, json=body, timeout=20)
        except requests.RequestException:
            continue

        if r.status_code != 200:
            continue

        data = _safe_json(r)
        pic = _extract_picture_url(data)
        if pic:
            return pic

    return None


def _evo_fetch_group_picture_url(instance_name: str, group_jid: str) -> Optional[str]:
    infos = _evo_fetch_group_infos(instance_name, group_jid)
    pic = _extract_picture_url(infos)
    if pic:
        return pic

    return _evo_fetch_profile_picture_url_any_jid(instance_name, group_jid)


# =========================================================
# Resolução de instância para refresh
# =========================================================
def _resolve_instance_name_for_cliente(
    db: Session,
    *,
    empresa_id: int,
    cliente_id: int,
    allowed: Optional[List[int]],
) -> Optional[str]:
    q = (
        db.query(
            models.EmpresaInstancia.instance_name,
            models.Mensagem.instancia_id,
        )
        .join(models.EmpresaInstancia, models.EmpresaInstancia.id == models.Mensagem.instancia_id)
        .filter(
            models.Mensagem.empresa_id == int(empresa_id),
            models.Mensagem.cliente_id == int(cliente_id),
            models.Mensagem.instancia_id.isnot(None),
        )
    )

    if allowed is not None:
        if not allowed:
            return None
        q = q.filter(models.Mensagem.instancia_id.in_([int(x) for x in allowed]))

    row = q.order_by(models.Mensagem.timestamp.desc(), models.Mensagem.id.desc()).first()
    if row and row[0]:
        return str(row[0])

    q2 = db.query(models.EmpresaInstancia).filter(models.EmpresaInstancia.empresa_id == int(empresa_id))

    if allowed is not None:
        if not allowed:
            return None
        q2 = q2.filter(models.EmpresaInstancia.id.in_([int(x) for x in allowed]))

    row2 = q2.order_by(
        models.EmpresaInstancia.connected.desc(),
        models.EmpresaInstancia.last_seen.desc().nullslast(),
        models.EmpresaInstancia.id.asc(),
    ).first()

    return row2.instance_name if row2 else None


def _resolve_instance_name_for_grupo(
    db: Session,
    *,
    empresa_id: int,
    grupo,
    allowed: Optional[List[int]],
) -> Optional[str]:
    grupo_inst_id = _to_int(getattr(grupo, "instancia_id", None))

    if grupo_inst_id is not None:
        q = db.query(models.EmpresaInstancia).filter(
            models.EmpresaInstancia.empresa_id == int(empresa_id),
            models.EmpresaInstancia.id == int(grupo_inst_id),
        )

        if allowed is not None:
            if not allowed:
                return None
            q = q.filter(models.EmpresaInstancia.id.in_([int(x) for x in allowed]))

        row = q.first()
        if row:
            return row.instance_name

    try:
        q_msg = (
            db.query(
                models.EmpresaInstancia.instance_name,
                models.MensagemGrupo.instancia_id,
            )
            .join(models.EmpresaInstancia, models.EmpresaInstancia.id == models.MensagemGrupo.instancia_id)
            .filter(
                models.MensagemGrupo.empresa_id == int(empresa_id),
                models.MensagemGrupo.grupo_id == int(grupo.id),
                models.MensagemGrupo.instancia_id.isnot(None),
            )
        )

        if allowed is not None:
            if not allowed:
                return None
            q_msg = q_msg.filter(models.MensagemGrupo.instancia_id.in_([int(x) for x in allowed]))

        row_msg = q_msg.order_by(models.MensagemGrupo.id.desc()).first()
        if row_msg and row_msg[0]:
            return str(row_msg[0])
    except Exception:
        pass

    q2 = db.query(models.EmpresaInstancia).filter(models.EmpresaInstancia.empresa_id == int(empresa_id))

    if allowed is not None:
        if not allowed:
            return None
        q2 = q2.filter(models.EmpresaInstancia.id.in_([int(x) for x in allowed]))

    row2 = q2.order_by(
        models.EmpresaInstancia.connected.desc(),
        models.EmpresaInstancia.last_seen.desc().nullslast(),
        models.EmpresaInstancia.id.asc(),
    ).first()

    return row2.instance_name if row2 else None


# =========================================================
# Download/avatar
# =========================================================
def _download_avatar_binary(url: str) -> Optional[Tuple[bytes, str]]:
    if not url:
        return None

    headers = {}

    if EVOLUTION_URL and url.startswith(EVOLUTION_URL) and EVOLUTION_KEY:
        headers = {"apikey": EVOLUTION_KEY}

    try:
        r = requests.get(url, headers=headers, timeout=15, allow_redirects=True)
    except Exception:
        return None

    if r.status_code != 200 or not r.content:
        return None

    content_type = r.headers.get("content-type") or "image/jpeg"

    if not str(content_type).lower().startswith("image/"):
        return None

    return r.content, content_type


def _avatar_response_from_url(raw_url: str | None):
    raw = (raw_url or "").strip()
    if not raw:
        return None

    downloaded = _download_avatar_binary(raw)
    if not downloaded:
        return None

    content, content_type = downloaded
    resp = Response(content=content, media_type=content_type)
    resp.headers["Cache-Control"] = "private, max-age=3600"
    return resp


def _refresh_profile_for_grupo(
    db: Session,
    *,
    grupo,
    empresa_id: int,
    allowed: Optional[List[int]],
) -> Dict[str, Any]:
    remote_jid = (getattr(grupo, "remote_jid", None) or "").strip()
    if not remote_jid:
        return {}

    instance_name = _resolve_instance_name_for_grupo(
        db,
        empresa_id=int(empresa_id),
        grupo=grupo,
        allowed=allowed,
    )
    if not instance_name:
        return {}

    picture_url = _evo_fetch_group_picture_url(instance_name, remote_jid)
    if not picture_url:
        return {}

    changed = False

    if hasattr(grupo, "avatar_url"):
        old = (getattr(grupo, "avatar_url", None) or "").strip()
        if old != picture_url:
            grupo.avatar_url = picture_url
            changed = True

    try:
        infos = _evo_fetch_group_infos(instance_name, remote_jid)
        subject = (
            infos.get("subject")
            or infos.get("name")
            or infos.get("pushName")
            or ((infos.get("group") or {}).get("subject") if isinstance(infos.get("group"), dict) else None)
        )

        if subject and hasattr(grupo, "nome"):
            if (getattr(grupo, "nome", None) or "").strip() != str(subject).strip():
                grupo.nome = str(subject).strip()
                changed = True
    except Exception:
        pass

    if changed:
        try:
            db.commit()
            db.refresh(grupo)
        except Exception:
            db.rollback()

    return {
        "remote_jid": remote_jid,
        "instance_name": instance_name,
        "picture": picture_url,
        "profilePictureUrl": picture_url,
    }


# =========================================================
# Mídias do perfil
# =========================================================
def _midia_categoria(row) -> str:
    tipo = (getattr(row, "tipo", None) or "").strip().lower()
    mime = (getattr(row, "mimetype", None) or "").strip().lower()
    name = (
        getattr(row, "nome_original", None)
        or getattr(row, "filename", None)
        or ""
    ).strip().lower()

    blob = " ".join([tipo, mime, name])

    if any(x in blob for x in ["image/", "imagem", "image", "foto", "jpeg", "jpg", "png", "webp", "gif"]):
        return "imagem"

    if any(x in blob for x in ["video/", "vídeo", "video", "mp4", "mov", "avi", "mkv", "webm"]):
        return "video"

    if any(x in blob for x in ["audio/", "áudio", "audio", "ptt", "ogg", "mp3", "wav", "m4a", "opus"]):
        return "audio"

    return "documento"


def _midia_public_url(midia_id: int) -> str:
    return f"/api/atendimento/midias/{int(midia_id)}"


def _midia_msg_url(msg_id: str | None) -> Optional[str]:
    if not msg_id:
        return None
    return f"/api/atendimento/midias/msg/{quote(str(msg_id), safe='')}"


def _build_media_payload(m) -> Dict[str, Any]:
    categoria = _midia_categoria(m)

    mensagem = getattr(m, "mensagem", None)
    raw_msg_id = getattr(mensagem, "msg_id", None) if mensagem is not None else None

    media_url = (
        (getattr(m, "url", None) or "").strip()
        or _midia_public_url(int(m.id))
    )

    return {
        "id": int(m.id),
        "mensagem_id": int(m.mensagem_id) if getattr(m, "mensagem_id", None) is not None else None,
        "msg_id": raw_msg_id,
        "tipo": getattr(m, "tipo", None),
        "categoria": categoria,
        "filename": getattr(m, "filename", None),
        "nome_original": getattr(m, "nome_original", None),
        "mimetype": getattr(m, "mimetype", None),
        "tamanho": getattr(m, "tamanho", None),
        "page_count": getattr(m, "page_count", None),
        "created_at": getattr(m, "created_at", None).isoformat() if getattr(m, "created_at", None) else None,
        "url": media_url,
        "download_url": _midia_public_url(int(m.id)),
        "message_media_url": _midia_msg_url(raw_msg_id),
        "thumb_url": media_url if categoria in {"imagem", "video"} else None,
    }


def _build_midias_for_cliente(
    db: Session,
    *,
    empresa_id: int,
    cliente_id: int,
    recent_limit: int = 24,
) -> tuple[Dict[str, int], List[Dict[str, Any]]]:
    q_base = (
        db.query(models.Midia)
        .filter(
            models.Midia.empresa_id == int(empresa_id),
            models.Midia.cliente_id == int(cliente_id),
        )
    )

    total = q_base.count()

    imagens = 0
    videos = 0
    audios = 0
    documentos = 0

    all_rows = (
        q_base
        .order_by(models.Midia.created_at.desc().nullslast(), models.Midia.id.desc())
        .all()
    )

    for row in all_rows:
        cat = _midia_categoria(row)
        if cat == "imagem":
            imagens += 1
        elif cat == "video":
            videos += 1
        elif cat == "audio":
            audios += 1
        else:
            documentos += 1

    recent_rows = (
        db.query(models.Midia)
        .filter(
            models.Midia.empresa_id == int(empresa_id),
            models.Midia.cliente_id == int(cliente_id),
        )
        .order_by(models.Midia.created_at.desc().nullslast(), models.Midia.id.desc())
        .limit(int(recent_limit))
        .all()
    )

    recentes = [_build_media_payload(row) for row in recent_rows]

    resumo = {
        "total": int(total or 0),
        "imagens": int(imagens or 0),
        "videos": int(videos or 0),
        "audios": int(audios or 0),
        "documentos": int(documentos or 0),
    }

    return resumo, recentes



def _build_midias_for_grupo(
    db: Session,
    *,
    empresa_id: int,
    grupo_id: int,
    recent_limit: int = 24,
) -> tuple[Dict[str, int], List[Dict[str, Any]]]:
    msg_ids_q = (
        db.query(models.MensagemGrupo.id)
        .filter(
            models.MensagemGrupo.empresa_id == int(empresa_id),
            models.MensagemGrupo.grupo_id == int(grupo_id),
        )
    )

    q_base = (
        db.query(models.Midia)
        .filter(models.Midia.empresa_id == int(empresa_id))
        .filter(
            or_(
                models.Midia.grupo_id == int(grupo_id),
                models.Midia.mensagem_grupo_id.in_(msg_ids_q),
            )
        )
    )

    total = q_base.count()

    imagens = 0
    videos = 0
    audios = 0
    documentos = 0

    all_rows = (
        q_base
        .order_by(models.Midia.created_at.desc().nullslast(), models.Midia.id.desc())
        .all()
    )

    for row in all_rows:
        cat = _midia_categoria(row)
        if cat == "imagem":
            imagens += 1
        elif cat == "video":
            videos += 1
        elif cat == "audio":
            audios += 1
        else:
            documentos += 1

    recent_rows = (
        q_base
        .order_by(models.Midia.created_at.desc().nullslast(), models.Midia.id.desc())
        .limit(int(recent_limit))
        .all()
    )

    recentes = [_build_media_payload(row) for row in recent_rows]

    resumo = {
        "total": int(total or 0),
        "imagens": int(imagens or 0),
        "videos": int(videos or 0),
        "audios": int(audios or 0),
        "documentos": int(documentos or 0),
    }

    return resumo, recentes


def _assert_grupo_profile_access(
    db: Session,
    *,
    identity,
    empresa_id: int,
    grupo_id: int,
):
    grp = (
        db.query(models.Grupo)
        .filter(
            models.Grupo.empresa_id == int(empresa_id),
            models.Grupo.id == int(grupo_id),
        )
        .first()
    )

    if not grp:
        raise HTTPException(404, "Grupo não encontrado")

    acl_ctx = resolve_acl_context(db, identity=identity, empresa_id=int(empresa_id))
    allowed = acl_ctx["allowed_instancias"]

    grp_inst_id = _to_int(getattr(grp, "instancia_id", None))
    if grp_inst_id is not None:
        assert_instancia_allowed(allowed_instancias=allowed, instancia_id=int(grp_inst_id))
    elif allowed is not None and not allowed:
        raise HTTPException(status_code=403, detail="Sem instâncias permitidas para este usuário")

    return grp, allowed


def _build_group_profile_payload(db: Session, grp) -> Dict[str, Any]:
    raw_avatar = (getattr(grp, "avatar_url", None) or "").strip()
    avatar_proxy = _avatar_proxy_url_kind(int(grp.id), "grupo")

    midias_resumo, midias_recentes = _build_midias_for_grupo(
        db,
        empresa_id=int(grp.empresa_id),
        grupo_id=int(grp.id),
        recent_limit=24,
    )

    nome = (getattr(grp, "nome", None) or "").strip() or "Grupo"
    descricao = (getattr(grp, "descricao", None) or "").strip() or None
    remote_jid = (getattr(grp, "remote_jid", None) or "").strip() or None

    return {
        "kind": "grupo",
        "is_group": True,
        "id": int(grp.id),
        "grupo_id": int(grp.id),
        "empresa_id": int(grp.empresa_id),
        "instancia_id": _to_int(getattr(grp, "instancia_id", None)),
        "remote_jid": remote_jid,

        "nome": nome,
        "nome_grupo": nome,
        "nome_whatsapp": nome,
        "nome_completo": nome,

        "telefone": remote_jid,
        "telefone_norm": None,
        "telefone_e164": None,
        "telefone_fmt": "Grupo do WhatsApp",

        "avatar_url": avatar_proxy,
        "avatar_remote_url": raw_avatar or None,

        "is_business": False,
        "status_text": descricao or "Grupo do WhatsApp",
        "description": descricao,
        "sobre_cliente": descricao,
        "descricao": descricao,
        "business_info": None,

        "cpf_cnpj": None,
        "rg": None,
        "email": None,
        "data_nascimento": None,
        "genero": None,
        "cep": None,
        "endereco": None,
        "numero": None,
        "complemento": None,
        "bairro": None,
        "cidade": None,
        "estado": None,
        "departamento_id": None,
        "atendimento_id": None,

        "midias_resumo": midias_resumo,
        "midias_recentes": midias_recentes,
    }


def _build_profile_payload(db: Session, cli, atd) -> Dict[str, Any]:
    raw_avatar = (getattr(cli, "avatar_url", None) or "").strip()
    avatar_proxy = _avatar_proxy_url(int(cli.id)) if raw_avatar else None

    telefone_raw = getattr(cli, "telefone", None)
    telefone_db_norm, telefone_send_norm = _normalize_lookup_number(telefone_raw)

    is_business = bool(getattr(cli, "is_business", False))

    business_info = None
    if is_business:
        business_info = {
            "email": getattr(cli, "email", None),
            "description": getattr(cli, "descricao", None),
            "website": getattr(cli, "website", None),
        }

    midias_resumo, midias_recentes = _build_midias_for_cliente(
        db,
        empresa_id=int(cli.empresa_id),
        cliente_id=int(cli.id),
        recent_limit=24,
    )

    return {
        "id": cli.id,
        "empresa_id": cli.empresa_id,
        "telefone": telefone_raw,
        "telefone_norm": telefone_db_norm,
        "telefone_e164": telefone_send_norm,
        "telefone_fmt": formatar_telefone_br(telefone_send_norm) if telefone_send_norm else None,

        "avatar_url": avatar_proxy,
        "avatar_remote_url": raw_avatar or None,

        "nome": getattr(cli, "nome", None),
        "nome_whatsapp": getattr(cli, "nome_whatsapp", None),
        "nome_completo": getattr(cli, "nome_completo", None),

        "cpf_cnpj": getattr(cli, "cpf_cnpj", None),
        "rg": getattr(cli, "rg", None),

        "email": business_info["email"] if business_info else None,
        "data_nascimento": (
            cli.data_nascimento.date().isoformat() if getattr(cli, "data_nascimento", None) else None
        ),
        "genero": getattr(cli, "genero", None),

        "cep": getattr(cli, "cep", None),
        "endereco": getattr(cli, "endereco", None),
        "numero": getattr(cli, "numero", None),
        "complemento": getattr(cli, "complemento", None),
        "bairro": getattr(cli, "bairro", None),
        "cidade": getattr(cli, "cidade", None),
        "estado": getattr(cli, "estado", None),

        "is_business": is_business,
        "status_text": getattr(cli, "status_whatsapp", None),

        "description": business_info["description"] if business_info else None,
        "website": business_info["website"] if business_info else None,
        "business_info": business_info,

        "sobre_cliente": getattr(cli, "sobre_cliente", None),

        "departamento_id": (
            getattr(atd, "departamento_id", None) if atd is not None else getattr(cli, "departamento_id", None)
        ),
        "atendimento_id": getattr(atd, "id", None) if atd is not None else None,

        "midias_resumo": midias_resumo,
        "midias_recentes": midias_recentes,
    }


def _refresh_profile_for_cliente(
    db: Session,
    *,
    cli,
    empresa_id: int,
    allowed: Optional[List[int]],
) -> Dict[str, Any]:
    numero_db_norm, numero_send_norm = _normalize_lookup_number(getattr(cli, "telefone", None))
    if not numero_send_norm:
        return {}

    instance_name = _resolve_instance_name_for_cliente(
        db,
        empresa_id=int(empresa_id),
        cliente_id=int(cli.id),
        allowed=allowed,
    )
    if not instance_name:
        return {}

    data = _evo_fetch_profile(instance_name, numero_send_norm)
    if not data:
        return {}

    picture_url = _extract_picture_url(data)
    if not picture_url:
        picture_url = _evo_fetch_profile_picture_url(instance_name, numero_send_norm)

    status_obj = data.get("status") if isinstance(data.get("status"), dict) else {
        "status": data.get("status"),
        "setAt": data.get("statusAt"),
    }

    is_business_raw = data.get("isBusiness")
    if is_business_raw is None:
        is_business_raw = data.get("business")
    if is_business_raw is None:
        is_business_raw = data.get("is_business")
    is_business = bool(is_business_raw)

    changed = False

    changed |= _set_nullable_if_changed(
        cli,
        "nome_whatsapp",
        _clean(data.get("name") or data.get("pushName") or data.get("verifiedName")),
    )
    changed |= _set_nullable_if_changed(cli, "avatar_url", _clean(picture_url))
    changed |= _set_nullable_if_changed(cli, "status_whatsapp", _clean(status_obj.get("status")))
    changed |= _set_nullable_if_changed(cli, "is_business", is_business)

    if is_business:
        changed |= _set_nullable_if_changed(cli, "email", _clean(data.get("email")))
        changed |= _set_nullable_if_changed(cli, "descricao", _clean(data.get("description") or data.get("about")))
        changed |= _set_nullable_if_changed(cli, "website", _clean(data.get("website")))

    if hasattr(cli, "profile_refreshed_at"):
        setattr(cli, "profile_refreshed_at", datetime.now(timezone.utc))
        changed = True

    if changed:
        try:
            db.commit()
            db.refresh(cli)
        except ProgrammingError as e:
            db.rollback()
            if "generated" not in str(e).lower():
                raise
        except Exception:
            db.rollback()

    return {
        "wuid": data.get("wuid") or data.get("wid") or data.get("id"),
        "name": data.get("name") or data.get("pushName") or data.get("verifiedName"),
        "numberExists": data.get("numberExists") if "numberExists" in data else data.get("exists"),
        "picture": picture_url,
        "profilePictureUrl": picture_url,
        "status": status_obj if isinstance(status_obj, dict) else {},
        "isBusiness": is_business,
        "email": data.get("email") if is_business else None,
        "description": (data.get("description") or data.get("about")) if is_business else None,
        "website": data.get("website") if is_business else None,
        "telefone_norm": numero_db_norm,
        "telefone_e164": numero_send_norm,
        "telefone_fmt": formatar_telefone_br(numero_send_norm) if numero_send_norm else None,
    }


UPDATABLE_FIELDS = {
    "avatar_url",
    "wuid",
    "whatsapp_exists",
    "is_business",
    "status_text",
    "status_set_at",
    "email",
    "description",
    "website",
    "nome_completo",
    "cpf_cnpj",
    "rg",
    "data_nascimento",
    "genero",
    "cep",
    "endereco",
    "numero",
    "complemento",
    "bairro",
    "cidade",
    "estado",
    "sobre_cliente",
}

FIELD_MAP = {
    "status_text": "status_whatsapp",
    "description": "descricao",
}


# =========================================================
# ROTAS EVOLUTION: fetchProfile contato
# =========================================================
@router.post("/evolution/fetchProfile")
def evolution_fetch_profile(
    payload: FetchProfileIn,
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
):
    ensure_perm(identity, "atendimento.ver")

    if not EVOLUTION_URL:
        raise HTTPException(500, "EVOLUTION_URL não configurada no servidor.")
    if not payload.number:
        raise HTTPException(400, "Campo 'number' é obrigatório.")

    empresa_id_eff = assert_same_company(identity, payload.empresa_id)

    acl_ctx = resolve_acl_context(db, identity=identity, empresa_id=empresa_id_eff)
    allowed = acl_ctx["allowed_instancias"]

    resolved_inst_id, resolved_inst_name = _resolve_instancia_id(
        db,
        empresa_id=empresa_id_eff,
        instancia_id=payload.instancia_id,
        instance=payload.instance,
    )

    if (payload.instancia_id is not None or payload.instance) and resolved_inst_id is None:
        raise HTTPException(404, "Instância não encontrada para a empresa.")

    if resolved_inst_id is not None:
        assert_instancia_allowed(allowed_instancias=allowed, instancia_id=resolved_inst_id)

    instance_name = _pick_instance_name(
        db,
        empresa_id_eff,
        allowed=allowed,
        instance=resolved_inst_name,
        instancia_id=resolved_inst_id,
    )

    numero_db_norm, numero_send_norm = _normalize_lookup_number(payload.number)
    if not numero_send_norm:
        raise HTTPException(400, "Número inválido.")

    data = _evo_fetch_profile(instance_name, numero_send_norm)

    if not data:
        raise HTTPException(502, "Falha ao buscar perfil no Evolution.")

    picture_url = _extract_picture_url(data)
    if not picture_url:
        picture_url = _evo_fetch_profile_picture_url(instance_name, numero_send_norm)

    normalized = {
        "wuid": data.get("wuid") or data.get("wid") or data.get("id"),
        "name": data.get("name") or data.get("pushName") or data.get("verifiedName"),
        "numberExists": data.get("numberExists") if "numberExists" in data else data.get("exists"),
        "picture": picture_url,
        "profilePictureUrl": picture_url,
        "status": data.get("status") if isinstance(data.get("status"), dict)
        else {"status": data.get("status"), "setAt": data.get("statusAt")},
        "isBusiness": data.get("isBusiness") if "isBusiness" in data else (data.get("business") or data.get("is_business")),
        "email": data.get("email"),
        "description": data.get("description") or data.get("about"),
        "website": data.get("website"),
        "telefone_norm": numero_db_norm,
        "telefone_e164": numero_send_norm,
        "telefone_fmt": formatar_telefone_br(numero_send_norm) if numero_send_norm else None,
    }

    cli = _find_cliente_by_phone(
        db,
        empresa_id=empresa_id_eff,
        raw_number=payload.number,
    )

    changed = False

    if cli:
        assert_cliente_access(
            db,
            identity=identity,
            empresa_id=empresa_id_eff,
            cliente_id=int(cli.id),
            instancia_id=resolved_inst_id,
            allow_unassigned_department=True,
        )

        changed |= _set_if_changed(cli, "is_business", bool(normalized.get("isBusiness")))

        status_obj = normalized.get("status") or {}
        changed |= _set_if_changed(cli, "status_whatsapp", (status_obj.get("status") or None))
        changed |= _set_if_changed(cli, "descricao", normalized.get("description"))
        changed |= _set_if_changed(cli, "website", normalized.get("website"))
        changed |= _set_if_changed(cli, "email", normalized.get("email"))
        changed |= _set_if_changed(cli, "nome_whatsapp", normalized.get("name"))
        changed |= _set_if_changed(cli, "avatar_url", normalized.get("picture"))

        if hasattr(cli, "profile_refreshed_at"):
            setattr(cli, "profile_refreshed_at", datetime.now(timezone.utc))
            changed = True

        if changed:
            try:
                db.commit()
                db.refresh(cli)
            except ProgrammingError as e:
                db.rollback()
                if "generated" not in str(e).lower():
                    raise

        raw_avatar = (getattr(cli, "avatar_url", None) or "").strip()
        normalized["avatar_url"] = _avatar_proxy_url(int(cli.id)) if raw_avatar else None
        normalized["avatar_remote_url"] = raw_avatar or None
        normalized["cliente_id"] = int(cli.id)
    else:
        normalized["avatar_url"] = None
        normalized["avatar_remote_url"] = normalized.get("picture")
        normalized["cliente_id"] = None

    return normalized


# =========================================================
# ROTAS EVOLUTION: perfil da instância conectada
# =========================================================
_INSTANCIA_PROFILE_MEMORY_CACHE: dict[str, Dict[str, Any]] = {}


def _instancia_profile_cache_key(empresa_id: int, instancia_id: int) -> str:
    return f"perfil_instancia:{int(empresa_id)}:{int(instancia_id)}"


def _first_clean_text(*values: Any) -> Optional[str]:
    for value in values:
        if value is None:
            continue

        if isinstance(value, dict):
            continue

        s = str(value).strip()
        if not s:
            continue

        if re.match(r"^(null|undefined|nan|none)$", s, re.I):
            continue

        return s

    return None


def _nested_dict(data: dict, *keys: str) -> dict:
    cur: Any = data

    for key in keys:
        if not isinstance(cur, dict):
            return {}
        cur = cur.get(key)

    return cur if isinstance(cur, dict) else {}


def _extract_profile_name(data: dict) -> Optional[str]:
    if not isinstance(data, dict):
        return None

    profile = _nested_dict(data, "profile")
    instance = _nested_dict(data, "instance")
    user = _nested_dict(data, "user")
    me = _nested_dict(data, "me")
    business = _nested_dict(data, "businessProfile")

    return _first_clean_text(
        data.get("name"),
        data.get("pushName"),
        data.get("profileName"),
        data.get("notifyName"),
        data.get("verifiedName"),
        data.get("displayName"),
        profile.get("name"),
        profile.get("pushName"),
        profile.get("profileName"),
        profile.get("displayName"),
        instance.get("profileName"),
        instance.get("profile_name"),
        instance.get("name"),
        user.get("name"),
        user.get("pushName"),
        me.get("name"),
        me.get("pushName"),
        business.get("name"),
        business.get("verifiedName"),
    )


def _extract_profile_about(data: dict) -> Optional[str]:
    if not isinstance(data, dict):
        return None

    profile = _nested_dict(data, "profile")
    status_obj = data.get("status") if isinstance(data.get("status"), dict) else {}
    instance = _nested_dict(data, "instance")
    user = _nested_dict(data, "user")
    me = _nested_dict(data, "me")
    business = _nested_dict(data, "businessProfile")

    status_text = data.get("status") if isinstance(data.get("status"), str) else None

    return _first_clean_text(
        data.get("about"),
        data.get("description"),
        data.get("statusMessage"),
        data.get("status_text"),
        data.get("recado"),
        status_text,
        status_obj.get("status"),
        status_obj.get("text"),
        status_obj.get("message"),
        profile.get("about"),
        profile.get("description"),
        profile.get("status"),
        profile.get("statusMessage"),
        instance.get("about"),
        instance.get("status"),
        user.get("about"),
        user.get("status"),
        me.get("about"),
        me.get("status"),
        business.get("description"),
        business.get("about"),
    )


def _extract_profile_wuid(data: dict) -> Optional[str]:
    if not isinstance(data, dict):
        return None

    profile = _nested_dict(data, "profile")
    instance = _nested_dict(data, "instance")
    user = _nested_dict(data, "user")
    me = _nested_dict(data, "me")

    return _first_clean_text(
        data.get("wuid"),
        data.get("wid"),
        data.get("jid"),
        data.get("id"),
        profile.get("wuid"),
        profile.get("wid"),
        profile.get("jid"),
        profile.get("id"),
        instance.get("wuid"),
        instance.get("wid"),
        instance.get("jid"),
        instance.get("ownerJid"),
        user.get("id"),
        user.get("jid"),
        me.get("id"),
        me.get("jid"),
    )


def _extract_profile_is_business(data: dict) -> bool:
    if not isinstance(data, dict):
        return False

    value = data.get("isBusiness")
    if value is None:
        value = data.get("business")
    if value is None:
        value = data.get("is_business")
    if value is None:
        value = _nested_dict(data, "profile").get("isBusiness")
    if value is None:
        value = bool(_nested_dict(data, "businessProfile"))

    return bool(value)


def _extract_business_info(data: dict, *, is_business: bool) -> Optional[Dict[str, Any]]:
    if not is_business or not isinstance(data, dict):
        return None

    business_profile = _nested_dict(data, "businessProfile")
    profile = _nested_dict(data, "profile")

    email = _first_clean_text(
        data.get("email"),
        business_profile.get("email"),
        profile.get("email"),
    )

    description = _first_clean_text(
        data.get("description"),
        data.get("about"),
        business_profile.get("description"),
        business_profile.get("about"),
        profile.get("description"),
        profile.get("about"),
    )

    website = _first_clean_text(
        data.get("website"),
        data.get("site"),
        business_profile.get("website"),
        business_profile.get("site"),
        profile.get("website"),
    )

    if not any([email, description, website]):
        return None

    return {
        "email": email,
        "description": description,
        "website": website,
    }


def _instancia_profile_has_db_cache(inst) -> bool:
    fields = [
        "perfil_nome_whatsapp",
        "perfil_recado",
        "perfil_avatar_url",
        "perfil_business_email",
        "perfil_business_website",
        "perfil_business_description",
        "perfil_wuid",
        "perfil_atualizado_em",
    ]

    for field in fields:
        if hasattr(inst, field) and getattr(inst, field, None):
            return True

    return False


def _build_instancia_profile_payload(
    inst,
    *,
    source: str = "db",
    profile_source: str = "db",
    message: Optional[str] = None,
    evolution: Optional[Dict[str, Any]] = None,
    evolution_error: Optional[str] = None,
    refreshed: bool = False,
    cache_hit: bool = False,
) -> Dict[str, Any]:
    instance_name = (getattr(inst, "instance_name", None) or "").strip()
    apelido = (getattr(inst, "apelido", None) or "").strip() or None
    connected = bool(getattr(inst, "connected", False))
    last_seen = getattr(inst, "last_seen", None)

    numero_raw = (getattr(inst, "numero_instancia", None) or "").strip() or None
    numero_db_norm, numero_send_norm = _normalize_lookup_number(numero_raw)
    telefone_fmt = formatar_telefone_br(numero_send_norm) if numero_send_norm else None

    perfil_nome = _first_clean_text(getattr(inst, "perfil_nome_whatsapp", None))
    perfil_recado = _first_clean_text(getattr(inst, "perfil_recado", None))
    perfil_avatar = _first_clean_text(getattr(inst, "perfil_avatar_url", None))
    perfil_wuid = _first_clean_text(getattr(inst, "perfil_wuid", None))
    perfil_atualizado_em = getattr(inst, "perfil_atualizado_em", None)

    perfil_is_business = bool(getattr(inst, "perfil_is_business", False))

    business_info = None
    if perfil_is_business:
        business_info = {
            "email": _first_clean_text(getattr(inst, "perfil_business_email", None)),
            "description": _first_clean_text(getattr(inst, "perfil_business_description", None)),
            "website": _first_clean_text(getattr(inst, "perfil_business_website", None)),
        }
        if not any(business_info.values()):
            business_info = None

    profile_name_final = perfil_nome or apelido or instance_name or "Instância"

    payload: Dict[str, Any] = {
        "ok": True,
        "kind": "instancia",
        "source": source,
        "profile_source": profile_source,
        "cache_hit": bool(cache_hit),
        "refreshed": bool(refreshed),

        "id": int(inst.id),
        "instancia_id": int(inst.id),
        "empresa_id": int(inst.empresa_id),
        "instance_name": instance_name,
        "apelido": apelido,

        "connected": connected,
        "last_seen": last_seen.isoformat() if hasattr(last_seen, "isoformat") else None,

        "numero_instancia": numero_raw,
        "numero": numero_send_norm or numero_db_norm or numero_raw,
        "telefone": numero_raw,
        "telefone_norm": numero_db_norm,
        "telefone_e164": numero_send_norm,
        "telefone_fmt": telefone_fmt,

        "nome": profile_name_final,
        "nome_whatsapp": perfil_nome,
        "push_name": perfil_nome,

        "about": perfil_recado,
        "recado": perfil_recado,
        "status_text": perfil_recado,

        "avatar_url": perfil_avatar,
        "avatar_remote_url": perfil_avatar,
        "picture": perfil_avatar,
        "profilePictureUrl": perfil_avatar,

        "is_business": perfil_is_business,
        "business_info": business_info,

        "wuid": perfil_wuid,
        "perfil_atualizado_em": perfil_atualizado_em.isoformat() if hasattr(perfil_atualizado_em, "isoformat") else None,
        "evolution": evolution,
        "evolution_error": evolution_error,
    }

    if message:
        payload["message"] = message

    return payload


def _save_instancia_profile_cache(
    db: Session,
    inst,
    *,
    evo_data: Dict[str, Any],
    picture_url: Optional[str],
    nome_whatsapp: Optional[str],
    about: Optional[str],
    wuid: Optional[str],
    is_business: bool,
    business_info: Optional[Dict[str, Any]],
) -> None:
    now = datetime.now(timezone.utc)

    try:
        if picture_url and hasattr(inst, "perfil_avatar_url"):
            inst.perfil_avatar_url = picture_url

        if nome_whatsapp and hasattr(inst, "perfil_nome_whatsapp"):
            inst.perfil_nome_whatsapp = nome_whatsapp

        if about and hasattr(inst, "perfil_recado"):
            inst.perfil_recado = about

        if hasattr(inst, "perfil_is_business"):
            inst.perfil_is_business = bool(is_business)

        if business_info and isinstance(business_info, dict):
            if hasattr(inst, "perfil_business_email"):
                inst.perfil_business_email = _first_clean_text(business_info.get("email"))
            if hasattr(inst, "perfil_business_website"):
                inst.perfil_business_website = _first_clean_text(business_info.get("website"))
            if hasattr(inst, "perfil_business_description"):
                inst.perfil_business_description = _first_clean_text(business_info.get("description"))
        elif hasattr(inst, "perfil_is_business") and not is_business:
            if hasattr(inst, "perfil_business_email"):
                inst.perfil_business_email = None
            if hasattr(inst, "perfil_business_website"):
                inst.perfil_business_website = None
            if hasattr(inst, "perfil_business_description"):
                inst.perfil_business_description = None

        if wuid and hasattr(inst, "perfil_wuid"):
            inst.perfil_wuid = wuid

        if hasattr(inst, "perfil_raw_json"):
            inst.perfil_raw_json = evo_data or {}

        if hasattr(inst, "perfil_atualizado_em"):
            inst.perfil_atualizado_em = now

        numero_from_wuid = _only_digits(wuid) if wuid else None
        if numero_from_wuid and not (getattr(inst, "numero_instancia", None) or "").strip():
            inst.numero_instancia = numero_from_wuid

        db.commit()
        db.refresh(inst)
    except Exception:
        db.rollback()
        raise


def _cache_instancia_payload(payload: Dict[str, Any]) -> Dict[str, Any]:
    try:
        empresa_id = int(payload.get("empresa_id"))
        instancia_id = int(payload.get("instancia_id"))
        _INSTANCIA_PROFILE_MEMORY_CACHE[_instancia_profile_cache_key(empresa_id, instancia_id)] = dict(payload)
    except Exception:
        pass
    return payload


def _evo_fetch_instance_profile_by_number(instance_name: str, numero_send_norm: str) -> Dict[str, Any]:
    """
    Busca o perfil do próprio WhatsApp conectado usando o número salvo da instância.

    A Evolution não deve receber instância fixa aqui. Sempre usamos o instance_name
    vindo de empresas_instancias.
    """
    if not EVOLUTION_URL or not instance_name or not numero_send_norm:
        return {}

    data = _evo_fetch_profile(instance_name, numero_send_norm)
    picture_url = _extract_picture_url(data) if data else None

    if not picture_url:
        picture_url = _evo_fetch_profile_picture_url(instance_name, numero_send_norm)

    if not data:
        data = {}

    if picture_url:
        data = dict(data)
        data["profilePictureUrl"] = picture_url
        data["picture"] = data.get("picture") or picture_url

    return data


@router.get("/atendimento/instancias/{instancia_id}/perfil")
def get_instancia_whatsapp_profile(
    instancia_id: int = Path(..., ge=1),
    empresa_id: int | None = Query(None),
    refresh: bool = Query(False, description="Se true, força consultar Evolution e atualizar o cache do banco."),
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
):
    """
    Perfil do WhatsApp conectado em uma instância específica.

    Regra:
    - Sem refresh: primeiro tenta cache de memória, depois banco.
    - Se não tiver cache salvo no banco, consulta Evolution uma vez e salva.
    - Com ?refresh=1: força Evolution, atualiza banco e cache de memória.
    - Este endpoint NÃO resolve "Todos". O frontend deve tratar "Todos" sem chamar esta rota.
    """
    ensure_perm(identity, "atendimento.ver")

    empresa_id_eff = assert_same_company(identity, empresa_id)

    acl_ctx = resolve_acl_context(db, identity=identity, empresa_id=int(empresa_id_eff))
    allowed = acl_ctx["allowed_instancias"]

    assert_instancia_allowed(
        allowed_instancias=allowed,
        instancia_id=int(instancia_id),
    )

    inst = (
        db.query(models.EmpresaInstancia)
        .filter(
            models.EmpresaInstancia.empresa_id == int(empresa_id_eff),
            models.EmpresaInstancia.id == int(instancia_id),
        )
        .first()
    )

    if not inst:
        raise HTTPException(status_code=404, detail="Instância não encontrada para a empresa.")

    instance_name = (getattr(inst, "instance_name", None) or "").strip()
    connected = bool(getattr(inst, "connected", False))
    numero_raw = (getattr(inst, "numero_instancia", None) or "").strip() or None
    _numero_db_norm, numero_send_norm = _normalize_lookup_number(numero_raw)

    if not instance_name:
        return _build_instancia_profile_payload(
            inst,
            source="db",
            profile_source="db_missing_instance_name",
            message="Instância sem instance_name configurado.",
        ) | {"ok": False}

    cache_key = _instancia_profile_cache_key(int(empresa_id_eff), int(instancia_id))

    # 1) Cache rápido em memória: só usa quando não for refresh e já existir.
    if not refresh:
        cached = _INSTANCIA_PROFILE_MEMORY_CACHE.get(cache_key)
        if isinstance(cached, dict) and cached:
            cached = dict(cached)
            cached["cache_hit"] = True
            cached["source"] = cached.get("source") or "memory"
            cached["profile_source"] = cached.get("profile_source") or "memory"
            cached["connected"] = connected
            return cached

    # 2) Banco: se já tem cache salvo e não é refresh, NÃO chama Evolution.
    if not refresh and _instancia_profile_has_db_cache(inst):
        payload = _build_instancia_profile_payload(
            inst,
            source="db_cache",
            profile_source="db_cache",
            message="Perfil carregado do banco. Use refresh=1 para atualizar pela Evolution.",
            cache_hit=True,
        )
        return _cache_instancia_payload(payload)

    # 3) Se não tem cache salvo e está desconectada, não tem como chamar Evolution.
    if not connected:
        if _instancia_profile_has_db_cache(inst):
            payload = _build_instancia_profile_payload(
                inst,
                source="db_cache",
                profile_source="db_cache_disconnected",
                message="Instância desconectada. Mostrando último perfil salvo no banco.",
                cache_hit=True,
            )
            return _cache_instancia_payload(payload)

        return _build_instancia_profile_payload(
            inst,
            source="disconnected",
            profile_source="disconnected",
            message="Instância desconectada. Conecte o WhatsApp para carregar foto, nome e recado.",
        )

    # 4) Para primeira carga ou refresh=1, precisa de Evolution configurada e número salvo.
    if not EVOLUTION_URL:
        if _instancia_profile_has_db_cache(inst):
            payload = _build_instancia_profile_payload(
                inst,
                source="db_cache",
                profile_source="db_cache_evolution_url_missing",
                message="EVOLUTION_URL não configurada. Mostrando último perfil salvo no banco.",
                evolution_error="EVOLUTION_URL não configurada no servidor.",
                cache_hit=True,
            )
            return _cache_instancia_payload(payload)

        return _build_instancia_profile_payload(
            inst,
            source="db",
            profile_source="db_evolution_url_missing",
            message="EVOLUTION_URL não configurada no servidor.",
            evolution_error="EVOLUTION_URL não configurada no servidor.",
        )

    if not numero_send_norm:
        if _instancia_profile_has_db_cache(inst):
            payload = _build_instancia_profile_payload(
                inst,
                source="db_cache",
                profile_source="db_cache_missing_number",
                message="Número da instância não identificado. Mostrando último perfil salvo no banco.",
                cache_hit=True,
            )
            return _cache_instancia_payload(payload)

        return _build_instancia_profile_payload(
            inst,
            source="db",
            profile_source="db_missing_number",
            message="Número da instância ainda não foi identificado. Reconecte a instância ou aguarde o connection.update.",
        )

    # 5) Chama Evolution somente na primeira carga sem cache ou quando refresh=1.
    evolution_error = None
    try:
        evo_data = _evo_fetch_instance_profile_by_number(instance_name, numero_send_norm)
    except Exception as e:
        evo_data = {}
        evolution_error = str(e)

    if not evo_data:
        if _instancia_profile_has_db_cache(inst):
            payload = _build_instancia_profile_payload(
                inst,
                source="db_cache",
                profile_source="db_cache_evolution_empty",
                message="A Evolution não retornou perfil. Mostrando último perfil salvo no banco.",
                evolution_error=evolution_error,
                cache_hit=True,
            )
            return _cache_instancia_payload(payload)

        return _build_instancia_profile_payload(
            inst,
            source="evolution_empty",
            profile_source="evolution_empty",
            message="A Evolution não retornou perfil para esta instância.",
            evolution_error=evolution_error,
        )

    picture_url = _extract_picture_url(evo_data)
    nome_whatsapp = _extract_profile_name(evo_data)
    about = _extract_profile_about(evo_data)
    wuid = _extract_profile_wuid(evo_data)
    is_business = _extract_profile_is_business(evo_data)
    business_info = _extract_business_info(evo_data, is_business=is_business)

    try:
        _save_instancia_profile_cache(
            db,
            inst,
            evo_data=evo_data,
            picture_url=picture_url,
            nome_whatsapp=nome_whatsapp,
            about=about,
            wuid=wuid,
            is_business=bool(is_business),
            business_info=business_info,
        )
    except Exception as e:
        evolution_error = evolution_error or str(e)

    evolution_summary = {
        "numberExists": evo_data.get("numberExists") if "numberExists" in evo_data else evo_data.get("exists"),
        "status": evo_data.get("status"),
        "raw_keys": sorted([str(k) for k in evo_data.keys()])[:80],
    }

    payload = _build_instancia_profile_payload(
        inst,
        source="evolution",
        profile_source="evolution",
        message="Perfil atualizado pela Evolution e salvo no banco.",
        evolution=evolution_summary,
        evolution_error=evolution_error,
        refreshed=True,
        cache_hit=False,
    )

    return _cache_instancia_payload(payload)


# =========================================================
# AVATAR PROXY: cliente ou grupo
# =========================================================
@router.get("/atendimento/avatar/{conversation_id}")
def atendimento_avatar(
    conversation_id: int = Path(..., ge=1),
    kind: str = Query("cliente", description="cliente ou grupo"),
    empresa_id: int | None = Query(None),
    instancia_id: int | None = Query(None),
    instance: str | None = Query(None),
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
):
    ensure_perm(identity, "atendimento.ver")

    empresa_id_eff = assert_same_company(identity, empresa_id)
    kind_norm = str(kind or "cliente").strip().lower()

    acl_ctx = resolve_acl_context(
        db,
        identity=identity,
        empresa_id=int(empresa_id_eff),
    )
    allowed = acl_ctx["allowed_instancias"]

    resolved_inst_id, _resolved_inst_name = _resolve_instancia_id(
        db,
        empresa_id=int(empresa_id_eff),
        instancia_id=instancia_id,
        instance=instance,
    )

    if (instancia_id is not None or instance) and resolved_inst_id is None:
        raise HTTPException(404, "Instância não encontrada para a empresa.")

    if resolved_inst_id is not None:
        assert_instancia_allowed(allowed_instancias=allowed, instancia_id=resolved_inst_id)

    # =====================================================
    # GRUPO
    # =====================================================
    if kind_norm in {"grupo", "group", "g"}:
        grp = (
            db.query(models.Grupo)
            .filter(
                models.Grupo.id == int(conversation_id),
                models.Grupo.empresa_id == int(empresa_id_eff),
            )
            .first()
        )

        if not grp:
            raise HTTPException(status_code=404, detail="Grupo não encontrado")

        grp_inst_id = _to_int(getattr(grp, "instancia_id", None))

        if resolved_inst_id is not None and grp_inst_id is not None and int(grp_inst_id) != int(resolved_inst_id):
            raise HTTPException(status_code=404, detail="Grupo não encontrado nesta instância")

        if grp_inst_id is not None:
            assert_instancia_allowed(allowed_instancias=allowed, instancia_id=int(grp_inst_id))
        elif allowed is not None and not allowed:
            raise HTTPException(status_code=403, detail="Sem instâncias permitidas para este usuário")

        raw_url = (getattr(grp, "avatar_url", None) or "").strip()
        resp = _avatar_response_from_url(raw_url)
        if resp is not None:
            return resp

        try:
            evo_data = _refresh_profile_for_grupo(
                db,
                grupo=grp,
                empresa_id=int(empresa_id_eff),
                allowed=allowed,
            )

            try:
                db.refresh(grp)
            except Exception:
                pass

            raw_url = (getattr(grp, "avatar_url", None) or "").strip()
            resp = _avatar_response_from_url(raw_url)
            if resp is not None:
                return resp

            if isinstance(evo_data, dict):
                fallback_url = (
                    evo_data.get("profilePictureUrl")
                    or evo_data.get("picture")
                    or evo_data.get("profilePicUrl")
                    or evo_data.get("avatar_url")
                )
                resp = _avatar_response_from_url(fallback_url)
                if resp is not None:
                    return resp

        except HTTPException:
            raise
        except Exception as e:
            try:
                print("[ATENDIMENTO][AVATAR_GRUPO][ERRO_REFRESH]", e)
            except Exception:
                pass

        raise HTTPException(status_code=404, detail="Avatar do grupo não encontrado")

    # =====================================================
    # CLIENTE
    # =====================================================
    cli, _atd = assert_cliente_access(
        db,
        identity=identity,
        empresa_id=int(empresa_id_eff),
        cliente_id=int(conversation_id),
        instancia_id=resolved_inst_id,
        allow_unassigned_department=True,
    )

    raw_url = (getattr(cli, "avatar_url", None) or "").strip()
    resp = _avatar_response_from_url(raw_url)
    if resp is not None:
        return resp

    try:
        evo_data = _refresh_profile_for_cliente(
            db,
            cli=cli,
            empresa_id=int(empresa_id_eff),
            allowed=allowed,
        )

        try:
            db.refresh(cli)
        except Exception:
            pass

        raw_url = (getattr(cli, "avatar_url", None) or "").strip()
        resp = _avatar_response_from_url(raw_url)
        if resp is not None:
            return resp

        if isinstance(evo_data, dict):
            fallback_url = (
                evo_data.get("profilePictureUrl")
                or evo_data.get("picture")
                or evo_data.get("profilePicUrl")
                or evo_data.get("avatar_url")
            )
            resp = _avatar_response_from_url(fallback_url)
            if resp is not None:
                return resp

    except HTTPException:
        raise
    except Exception as e:
        try:
            print("[ATENDIMENTO][AVATAR_CLIENTE][ERRO_REFRESH]", e)
        except Exception:
            pass

    raise HTTPException(status_code=404, detail="Avatar não encontrado")


# =========================================================
# Perfil completo cliente
# =========================================================
@router.get("/atendimento/clientes/{cliente_id}/profile")
def get_cliente_profile(
    cliente_id: int,
    empresa_id: int | None = Query(None),
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
):
    ensure_perm(identity, "atendimento.ver")

    empresa_id_eff = assert_same_company(identity, empresa_id)

    cli, atd = assert_cliente_access(
        db,
        identity=identity,
        empresa_id=empresa_id_eff,
        cliente_id=int(cliente_id),
        instancia_id=None,
        allow_unassigned_department=True,
    )

    return _build_profile_payload(db, cli, atd)


@router.post("/atendimento/clientes/{cliente_id}/profile/refresh")
def refresh_cliente_profile(
    cliente_id: int,
    empresa_id: int | None = Query(None),
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
):
    ensure_perm(identity, "atendimento.ver")

    if not EVOLUTION_URL:
        raise HTTPException(500, "EVOLUTION_URL não configurada no servidor.")

    empresa_id_eff = assert_same_company(identity, empresa_id)

    cli, atd = assert_cliente_access(
        db,
        identity=identity,
        empresa_id=empresa_id_eff,
        cliente_id=int(cliente_id),
        instancia_id=None,
        allow_unassigned_department=True,
    )

    acl_ctx = resolve_acl_context(db, identity=identity, empresa_id=empresa_id_eff)
    allowed = acl_ctx["allowed_instancias"]

    evo_data = _refresh_profile_for_cliente(
        db,
        cli=cli,
        empresa_id=int(empresa_id_eff),
        allowed=allowed,
    )

    try:
        db.refresh(cli)
    except Exception:
        pass

    payload = _build_profile_payload(db, cli, atd)
    payload["refreshed"] = bool(evo_data)
    payload["refresh_source"] = "evolution" if evo_data else "db"
    payload["evolution"] = evo_data or None

    return payload


@router.patch("/atendimento/clientes/{cliente_id}/profile")
@router.put("/atendimento/clientes/{cliente_id}/profile")
def merge_cliente_profile(
    cliente_id: int,
    payload: dict = Body(...),
    empresa_id: int | None = Query(None),
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
):
    ensure_perm(identity, "atendimento.ver")

    empresa_id_eff = assert_same_company(identity, empresa_id)

    cli, _atd = assert_cliente_access(
        db,
        identity=identity,
        empresa_id=empresa_id_eff,
        cliente_id=int(cliente_id),
        instancia_id=None,
        allow_unassigned_department=True,
    )

    norm = dict(payload or {})
    norm.pop("nome", None)

    if "genero" not in norm and "sexo" in norm:
        norm["genero"] = norm.get("sexo")

    dob_raw = norm.get("data_nascimento") or norm.get("nascimento") or norm.get("dataNascimento")
    if dob_raw is not None:
        dob_dt = _parse_date_any(dob_raw)
        if dob_dt is not None:
            norm["data_nascimento"] = dob_dt

    changed = False

    for k, v in (norm or {}).items():
        if k not in UPDATABLE_FIELDS:
            continue

        v2 = _clean(v)
        if v2 is None:
            continue

        dest = FIELD_MAP.get(k, k)

        if not hasattr(cli, dest):
            continue

        if getattr(cli, dest, None) != v2:
            setattr(cli, dest, v2)
            changed = True

    if changed:
        db.commit()
        db.refresh(cli)

    return {"ok": True, "changed": changed}


# =========================================================
# Perfil completo grupo
# =========================================================
@router.get("/atendimento/grupos/{grupo_id}/profile")
def get_grupo_profile(
    grupo_id: int,
    empresa_id: int | None = Query(None),
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
):
    ensure_perm(identity, "atendimento.ver")

    empresa_id_eff = assert_same_company(identity, empresa_id)

    grp, _allowed = _assert_grupo_profile_access(
        db,
        identity=identity,
        empresa_id=int(empresa_id_eff),
        grupo_id=int(grupo_id),
    )

    return _build_group_profile_payload(db, grp)


@router.post("/atendimento/grupos/{grupo_id}/profile/refresh")
def refresh_grupo_profile(
    grupo_id: int,
    empresa_id: int | None = Query(None),
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
):
    ensure_perm(identity, "atendimento.ver")

    if not EVOLUTION_URL:
        raise HTTPException(500, "EVOLUTION_URL não configurada no servidor.")

    empresa_id_eff = assert_same_company(identity, empresa_id)

    grp, allowed = _assert_grupo_profile_access(
        db,
        identity=identity,
        empresa_id=int(empresa_id_eff),
        grupo_id=int(grupo_id),
    )

    evo_data = _refresh_profile_for_grupo(
        db,
        grupo=grp,
        empresa_id=int(empresa_id_eff),
        allowed=allowed,
    )

    try:
        db.refresh(grp)
    except Exception:
        pass

    payload = _build_group_profile_payload(db, grp)
    payload["refreshed"] = bool(evo_data)
    payload["refresh_source"] = "evolution" if evo_data else "db"
    payload["evolution"] = evo_data or None

    return payload


@router.patch("/atendimento/grupos/{grupo_id}/profile")
@router.put("/atendimento/grupos/{grupo_id}/profile")
def merge_grupo_profile(
    grupo_id: int,
    payload: dict = Body(...),
    empresa_id: int | None = Query(None),
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
):
    ensure_perm(identity, "atendimento.ver")

    empresa_id_eff = assert_same_company(identity, empresa_id)

    grp, _allowed = _assert_grupo_profile_access(
        db,
        identity=identity,
        empresa_id=int(empresa_id_eff),
        grupo_id=int(grupo_id),
    )

    norm = dict(payload or {})

    nome = _clean(
        norm.get("nome_grupo")
        or norm.get("nome")
        or norm.get("nome_completo")
        or norm.get("name")
    )
    descricao = _clean(
        norm.get("descricao")
        or norm.get("description")
        or norm.get("sobre_cliente")
        or norm.get("observacoes")
        or norm.get("notas")
    )

    changed = False

    if nome and hasattr(grp, "nome") and (getattr(grp, "nome", None) or "") != nome:
        grp.nome = nome
        changed = True

    if descricao is not None and hasattr(grp, "descricao") and (getattr(grp, "descricao", None) or "") != descricao:
        grp.descricao = descricao
        changed = True

    if changed:
        db.commit()
        db.refresh(grp)

    return {"ok": True, "changed": changed, "profile": _build_group_profile_payload(db, grp)}


# =========================================================
# Endpoints compat: campos custom do drawer
# =========================================================
@router.get("/clientes/{cliente_id}")
def cliente_get(
    cliente_id: int,
    empresa_id: int | None = Query(None),
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
):
    ensure_perm(identity, "atendimento.ver")

    empresa_id_eff = assert_same_company(identity, empresa_id)

    cli, _atd = assert_cliente_access(
        db,
        identity=identity,
        empresa_id=empresa_id_eff,
        cliente_id=int(cliente_id),
        instancia_id=None,
        allow_unassigned_department=True,
    )

    return {
        "id": cli.id,
        "nome_completo": cli.nome_completo,
        "cpf_cnpj": cli.cpf_cnpj,
        "rg": cli.rg,
        "email": cli.email,
        "data_nascimento": (
            cli.data_nascimento.date().isoformat() if getattr(cli, "data_nascimento", None) else None
        ),
        "genero": cli.genero,
        "cep": cli.cep,
        "endereco": cli.endereco,
        "numero": cli.numero,
        "complemento": cli.complemento,
        "bairro": cli.bairro,
        "cidade": cli.cidade,
        "estado": cli.estado,
    }


@router.put("/clientes/{cliente_id}")
def cliente_put(
    cliente_id: int,
    payload: SaveCustomIn,
    empresa_id: int | None = Query(None),
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
):
    ensure_perm(identity, "atendimento.ver")

    empresa_id_eff = assert_same_company(identity, empresa_id)

    cli, _atd = assert_cliente_access(
        db,
        identity=identity,
        empresa_id=empresa_id_eff,
        cliente_id=int(cliente_id),
        instancia_id=None,
        allow_unassigned_department=True,
    )

    if hasattr(payload, "model_dump"):
        incoming = payload.model_dump(exclude_unset=True)
    else:
        incoming = payload.dict(exclude_unset=True)

    changed = False

    field_names = set(getattr(SaveCustomIn, "model_fields", {}).keys()) or set(getattr(SaveCustomIn, "__fields__", {}).keys())

    for campo, valor in incoming.items():
        if campo not in field_names:
            continue

        if campo == "data_nascimento":
            dt = _parse_date_any(valor)
            if dt is None:
                continue

            if getattr(cli, "data_nascimento", None) != dt:
                setattr(cli, "data_nascimento", dt)
                changed = True

            continue

        v2 = _norm_str(valor)
        if v2 is None:
            continue

        if hasattr(cli, campo) and getattr(cli, campo) != v2:
            setattr(cli, campo, v2)
            changed = True

    if changed:
        db.commit()
        db.refresh(cli)

    return {
        "ok": True,
        "changed": bool(changed),
        "cliente": {
            "id": cli.id,
            "nome_completo": cli.nome_completo,
            "cpf_cnpj": cli.cpf_cnpj,
            "rg": cli.rg,
            "email": cli.email,
            "data_nascimento": (
                cli.data_nascimento.date().isoformat() if getattr(cli, "data_nascimento", None) else None
            ),
            "genero": cli.genero,
            "cep": cli.cep,
            "endereco": cli.endereco,
            "numero": cli.numero,
            "complemento": cli.complemento,
            "bairro": cli.bairro,
            "cidade": cli.cidade,
            "estado": cli.estado,
        },
    }


# =========================================================
# Busca global
# =========================================================
@router.get("/atendimento/search")
def atendimento_search(
    empresa_id: int = Query(...),
    q: str = Query("", description="Texto de busca"),
    limit: int = Query(50, ge=1, le=200),
    instancia_id: int | None = Query(None),
    instance: str | None = Query(None),
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
):
    ensure_perm(identity, "atendimento.ver")

    empresa_id_eff = assert_same_company(identity, empresa_id)

    qn = _normalize_text(q)
    if not qn:
        return {"contatos": [], "mensagens": []}

    acl_ctx = resolve_acl_context(db, identity=identity, empresa_id=empresa_id_eff)
    allowed = acl_ctx["allowed_instancias"]

    resolved_inst_id, _resolved_inst_name = _resolve_instancia_id(
        db,
        empresa_id=empresa_id_eff,
        instancia_id=instancia_id,
        instance=instance,
    )

    if (instancia_id is not None or instance) and resolved_inst_id is None:
        raise HTTPException(404, "Instância não encontrada para a empresa.")

    if resolved_inst_id is not None:
        assert_instancia_allowed(allowed_instancias=allowed, instancia_id=resolved_inst_id)

    m = models.Mensagem
    acl_cache: dict[int, bool] = {}

    filtros_inst = []

    if resolved_inst_id is not None:
        filtros_inst.append(m.instancia_id == int(resolved_inst_id))
    else:
        if allowed is not None:
            if not allowed:
                return {"contatos": [], "mensagens": []}
            filtros_inst.append(m.instancia_id.in_([int(x) for x in allowed]))

    sub_last = (
        db.query(
            m.cliente_id.label("cid"),
            func.max(m.id).label("last_msg_id"),
        )
        .filter(m.empresa_id == empresa_id_eff, *filtros_inst)
        .group_by(m.cliente_id)
        .subquery()
    )

    rows = (
        db.query(
            models.Cliente,
            m.conteudo,
            m.tipo,
            m.ack,
            m.timestamp,
            m.instancia_id,
        )
        .join(sub_last, sub_last.c.cid == models.Cliente.id)
        .join(m, m.id == sub_last.c.last_msg_id)
        .filter(models.Cliente.empresa_id == empresa_id_eff)
        .order_by(m.timestamp.desc())
        .limit(400)
        .all()
    )

    contatos: List[Dict] = []

    for cli, last_txt, last_tipo, last_ack, last_ts, last_instancia_id in rows:
        if not _cliente_acl_ok(
            db,
            identity=identity,
            empresa_id=empresa_id_eff,
            cliente_id=int(cli.id),
            instancia_id=_to_int(last_instancia_id),
            cache=acl_cache,
        ):
            continue

        nome = (getattr(cli, "nome_whatsapp", None) or cli.nome or "").strip()
        tel = (cli.telefone or "").strip()
        last = (last_txt or "").strip()
        raw_avatar = (getattr(cli, "avatar_url", None) or "").strip()

        telefone_db_norm, telefone_send_norm = _normalize_lookup_number(tel)
        telefone_fmt = formatar_telefone_br(telefone_send_norm) if telefone_send_norm else tel

        if qn in _normalize_text(nome) or qn in _normalize_text(tel) or qn in _normalize_text(last):
            ts_iso = last_ts.isoformat() if last_ts else None

            contatos.append({
                "id": cli.id,
                "nome": nome or telefone_fmt,
                "telefone": cli.telefone,
                "telefone_norm": telefone_db_norm,
                "telefone_e164": telefone_send_norm,
                "telefone_fmt": telefone_fmt,
                "avatar_url": _avatar_proxy_url(int(cli.id)) if raw_avatar else None,
                "avatar_remote_url": raw_avatar or None,
                "ultima_mensagem": last,
                "hora": ts_iso,
                "last_ts": ts_iso,
                "last_tipo": last_tipo,
                "last_ack": int(last_ack or 0) if last_tipo == "saida" else None,
            })

            if len(contatos) >= limit:
                break

    like = f"%{q}%"

    msgs_rows = (
        db.query(
            m.cliente_id,
            m.conteudo,
            m.timestamp,
            m.instancia_id,
            models.Cliente.nome,
            models.Cliente.telefone,
            models.Cliente.nome_whatsapp,
        )
        .join(models.Cliente, models.Cliente.id == m.cliente_id)
        .filter(m.empresa_id == empresa_id_eff, *filtros_inst, m.conteudo.ilike(like))
        .order_by(m.timestamp.desc())
        .limit(min(limit * 4, 120))
        .all()
    )

    mensagens: List[Dict] = []

    for cid, txt, ts, msg_instancia_id, cli_nome, cli_tel, cli_nome_whats in msgs_rows:
        if not _cliente_acl_ok(
            db,
            identity=identity,
            empresa_id=empresa_id_eff,
            cliente_id=int(cid),
            instancia_id=_to_int(msg_instancia_id),
            cache=acl_cache,
        ):
            continue

        nome = (cli_nome_whats or cli_nome or "").strip()
        tel = (cli_tel or "").strip()

        telefone_db_norm, telefone_send_norm = _normalize_lookup_number(tel)
        telefone_fmt = formatar_telefone_br(telefone_send_norm) if telefone_send_norm else tel

        mensagens.append(
            {
                "cliente_id": int(cid),
                "cliente_nome": nome or telefone_fmt,
                "cliente_telefone": tel,
                "cliente_telefone_norm": telefone_db_norm,
                "cliente_telefone_e164": telefone_send_norm,
                "cliente_telefone_fmt": telefone_fmt,
                "snippet": (txt or ""),
                "hora": ts.isoformat() if ts else None,
            }
        )

        if len(mensagens) >= limit:
            break

    return {"contatos": contatos, "mensagens": mensagens}
