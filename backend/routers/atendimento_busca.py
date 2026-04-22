# backend/routers/atendimento_busca.py
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Body, Query, Response, Path
import os
import re
import unicodedata
import requests
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

# ===== Evolution config =====
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
            allow_unassigned_department=False,
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


# ===== Schemas =====
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

    # shape bruto do Evolution (opcional)
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


# ===== Helpers =====
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
    """
    Retorna:
      - numero_db_norm  => padrão do banco (10/11 dígitos sem 55)
      - numero_send_norm => padrão de envio (55 + número)
    """
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


def _avatar_proxy_url(cliente_id: int) -> str:
    return f"/api/atendimento/avatar/{int(cliente_id)}"


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
    ]

    status_obj = data.get("status")
    if isinstance(status_obj, dict):
        candidates.extend([
            status_obj.get("picture"),
            status_obj.get("profilePictureUrl"),
            status_obj.get("profilePicUrl"),
        ])

    for v in candidates:
        if isinstance(v, str):
            s = v.strip()
            if s and not re.match(r"^(null|undefined)$", s, re.I):
                return s

    return None


def _evo_fetch_profile_picture_url(instance_name: str, numero_send_norm: str) -> Optional[str]:
    """
    Fallback para versões da Evolution que só devolvem a foto
    em /chat/fetchProfilePictureUrl/{instance}
    """
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
    return r.content, content_type


def _refresh_avatar_for_cliente(
    db: Session,
    *,
    cli,
    empresa_id: int,
    allowed: Optional[List[int]],
) -> Optional[str]:
    numero_db_norm, numero_send_norm = _normalize_lookup_number(getattr(cli, "telefone", None))
    if not numero_send_norm:
        return None

    instance_name = _resolve_instance_name_for_cliente(
        db,
        empresa_id=int(empresa_id),
        cliente_id=int(cli.id),
        allowed=allowed,
    )
    if not instance_name:
        return None

    data = _evo_fetch_profile(instance_name, numero_send_norm)
    pic = _extract_picture_url(data)

    if not pic:
        pic = _evo_fetch_profile_picture_url(instance_name, numero_send_norm)

    if not pic:
        return None

    old = (getattr(cli, "avatar_url", None) or "").strip()
    changed = False

    if old != pic:
        setattr(cli, "avatar_url", pic)
        changed = True

    name = (
        data.get("name")
        or data.get("pushName")
        or data.get("verifiedName")
        or None
    )
    if name and hasattr(cli, "nome_whatsapp") and getattr(cli, "nome_whatsapp", None) != name:
        setattr(cli, "nome_whatsapp", name)
        changed = True

    if hasattr(cli, "profile_refreshed_at"):
        setattr(cli, "profile_refreshed_at", datetime.now(timezone.utc))
        changed = True

    if changed:
        try:
            db.commit()
            db.refresh(cli)
        except Exception:
            db.rollback()

    return pic


UPDATABLE_FIELDS = {
    "avatar_url",
    "wuid", "whatsapp_exists", "is_business", "status_text", "status_set_at",
    "email", "description", "website",
    "nome_completo", "cpf_cnpj", "rg",
    "data_nascimento", "genero",
    "cep", "endereco", "numero", "complemento", "bairro", "cidade", "estado",
    "sobre_cliente",
}

FIELD_MAP = {
    "status_text": "status_whatsapp",
    "description": "descricao",
}


# ============= ROTAS EVOLUTION: fetchProfile =============
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
        db, empresa_id=empresa_id_eff, instancia_id=payload.instancia_id, instance=payload.instance
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
        # ACL composta: departamento + instância
        assert_cliente_access(
            db,
            identity=identity,
            empresa_id=empresa_id_eff,
            cliente_id=int(cli.id),
            instancia_id=resolved_inst_id,
            allow_unassigned_department=False,
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
# AVATAR PROXY
# =========================================================
@router.get("/atendimento/avatar/{cliente_id}")
def atendimento_avatar(
    cliente_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
):
    ensure_perm(identity, "atendimento.ver")

    empresa_id_token = int(identity["empresa_id"])
    acl_ctx = resolve_acl_context(db, identity=identity, empresa_id=empresa_id_token)
    allowed = acl_ctx["allowed_instancias"]

    cli, _atd = assert_cliente_access(
        db,
        identity=identity,
        empresa_id=empresa_id_token,
        cliente_id=int(cliente_id),
        instancia_id=None,
        allow_unassigned_department=False,
    )

    raw_url = (getattr(cli, "avatar_url", None) or "").strip()
    if raw_url:
        downloaded = _download_avatar_binary(raw_url)
        if downloaded:
            content, content_type = downloaded
            resp = Response(content=content, media_type=content_type)
            resp.headers["Cache-Control"] = "private, max-age=3600"
            return resp

    fresh_url = _refresh_avatar_for_cliente(
        db,
        cli=cli,
        empresa_id=int(empresa_id_token),
        allowed=allowed,
    )

    if fresh_url:
        downloaded = _download_avatar_binary(fresh_url)
        if downloaded:
            content, content_type = downloaded
            resp = Response(content=content, media_type=content_type)
            resp.headers["Cache-Control"] = "private, max-age=3600"
            return resp

    raise HTTPException(status_code=404, detail="Avatar não encontrado")


# ---- Perfil completo (ler do BD) ----
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
        allow_unassigned_department=False,
    )

    raw_avatar = (getattr(cli, "avatar_url", None) or "").strip()
    avatar_proxy = _avatar_proxy_url(int(cli.id)) if raw_avatar else None

    telefone_raw = getattr(cli, "telefone", None)
    telefone_db_norm, telefone_send_norm = _normalize_lookup_number(telefone_raw)

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
        "email": getattr(cli, "email", None),
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
        "is_business": getattr(cli, "is_business", None),
        "status_text": getattr(cli, "status_whatsapp", None),
        "description": getattr(cli, "descricao", None),
        "website": getattr(cli, "website", None),
        "sobre_cliente": getattr(cli, "sobre_cliente", None),
        "departamento_id": (
            getattr(atd, "departamento_id", None) if atd is not None else getattr(cli, "departamento_id", None)
        ),
        "atendimento_id": getattr(atd, "id", None) if atd is not None else None,
    }


# ---- Merge não-destrutivo (NÃO permite atualizar 'nome') ----
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
        allow_unassigned_department=False,
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


# ===== Endpoints para CAMPOS CUSTOM do drawer (compat) =====
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
        allow_unassigned_department=False,
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
        allow_unassigned_department=False,
    )

    incoming = payload.model_dump(exclude_unset=True)
    changed = False

    for campo, valor in incoming.items():
        if campo not in SaveCustomIn.model_fields:
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


# ============= BUSCA GLOBAL (contatos + mensagens) =============
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
        db, empresa_id=empresa_id_eff, instancia_id=instancia_id, instance=instance
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


def _to_int(v) -> Optional[int]:
    try:
        if v is None:
            return None
        return int(v)
    except Exception:
        return None