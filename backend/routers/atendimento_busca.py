from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Body, Query, Response, Path
import mimetypes
import os
import re
import unicodedata
import requests
from typing import Dict, List, Optional, Tuple
from datetime import datetime, timezone

from pydantic import BaseModel
from sqlalchemy.orm import Session
from sqlalchemy import or_, func, text
from sqlalchemy.exc import ProgrammingError

from backend.database import get_db
from backend import models
from backend.routers.auth import get_current_identity

router = APIRouter(tags=["Atendimento – Perfil / Evolution & Busca/Arquivo"])

# ===== Evolution config =====
EVOLUTION_URL = (os.getenv("EVOLUTION_URL", "").rstrip("/"))
EVOLUTION_KEY = os.getenv("EVOLUTION_APIKEY") or os.getenv("EVOLUTION_KEY")
HEADERS = {"apikey": EVOLUTION_KEY, "Content-Type": "application/json"} if EVOLUTION_KEY else {}

# =========================================================
# ACL / Permissões (mesmo padrão do "novo atendimento")
# =========================================================
def _to_int(v) -> Optional[int]:
    try:
        if v is None:
            return None
        s = str(v).strip()
        if not s:
            return None
        return int(s)
    except Exception:
        return None


def _is_admin(identity: dict) -> bool:
    try:
        if identity.get("is_admin") or identity.get("admin"):
            return True
        perms = identity.get("permissoes") or identity.get("permissions") or []
        if isinstance(perms, dict):
            perms = [k for k, v in perms.items() if v]
        perms = set(str(p).lower() for p in (perms or []))
        return any(p in perms for p in ("admin", "root", "clientes.gerenciar", "atendimento.gerenciar"))
    except Exception:
        return False


def _ensure_perm(identity: dict, perm: str) -> None:
    if _is_admin(identity):
        return
    perms = set(identity.get("permissoes") or [])
    if perm not in perms:
        raise HTTPException(status_code=403, detail=f"Sem permissão ({perm})")


def _infer_kind(identity: dict) -> str:
    k = (identity.get("kind") or identity.get("tipo") or "").lower().strip()
    if k in ("colaborador", "usuario", "admin"):
        return "colaborador" if k == "colaborador" else "usuario"
    sub = str(identity.get("sub") or "").strip().lower()
    role = str(identity.get("role") or "").strip().lower()
    if sub.startswith("colab-") or "colab" in role or "colaborador" in role:
        return "colaborador"
    return "usuario"


def _get_colab_id(identity: dict) -> Optional[int]:
    for key in ("id_colab", "colaborador_id", "id_colaborador", "colab_id", "cid"):
        cid = _to_int(identity.get(key))
        if cid:
            return cid
    sub = str(identity.get("sub") or "").strip().lower()
    if sub.startswith("colab-"):
        cid = _to_int(sub.split("-", 1)[1])
        if cid:
            return cid
    return _to_int(identity.get("id"))


def _table_exists(db: Session, table_name: str) -> bool:
    try:
        reg = db.execute(text(f"SELECT to_regclass('public.{table_name}')")).scalar()
        return reg is not None
    except Exception:
        return False


def _allowed_instancia_ids(db: Session, identity: dict, empresa_id: int) -> Optional[List[int]]:
    """
    Retorna:
      - None => sem restrição (admin/usuario master OU tabela inexistente)
      - []   => colaborador sem instâncias permitidas (nega tudo)
      - [..] => lista de instâncias permitidas
    """
    if _is_admin(identity):
        return None

    if _infer_kind(identity) != "colaborador":
        return None

    if not _table_exists(db, "colaboradores_instancias"):
        return None  # legado: não restringe

    cid = _get_colab_id(identity)
    if not cid:
        return []

    rows = db.execute(
        text(
            """
            SELECT instancia_id
            FROM colaboradores_instancias
            WHERE empresa_id = :emp
              AND colaborador_id = :cid
            """
        ),
        {"emp": int(empresa_id), "cid": int(cid)},
    ).fetchall()

    ids = [int(r[0]) for r in rows if r and r[0] is not None]
    return ids


def _assert_instancia_allowed(allowed: Optional[List[int]], instancia_id: Optional[int]) -> None:
    if instancia_id is None:
        return
    if allowed is None:
        return
    if int(instancia_id) not in set(int(x) for x in allowed):
        raise HTTPException(status_code=403, detail="Instância não permitida para este usuário")


def _assert_cliente_access_by_instancias(
    db: Session,
    *,
    empresa_id: int,
    cliente_id: int,
    allowed: Optional[List[int]],
) -> None:
    """
    Garante que colaborador só acesse cliente que tenha mensagens em instância permitida.
    Admin/allowed=None => libera.
    """
    if allowed is None:
        return
    if not allowed:
        raise HTTPException(status_code=404, detail="Cliente não encontrado")

    ok = (
        db.query(models.Mensagem.id)
        .filter(
            models.Mensagem.empresa_id == int(empresa_id),
            models.Mensagem.cliente_id == int(cliente_id),
            models.Mensagem.instancia_id.in_([int(x) for x in allowed]),
        )
        .first()
    )
    if not ok:
        raise HTTPException(status_code=404, detail="Cliente não encontrado")


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
def _assert_mesma_empresa(empresa_do_token: int, empresa_da_query: int | None) -> int:
    if empresa_da_query is None:
        return empresa_do_token
    if int(empresa_da_query) != int(empresa_do_token):
        raise HTTPException(403, "Empresa inválida para este recurso")
    return int(empresa_da_query)


def _pick_instance_name(
    db: Session,
    empresa_id_eff: int,
    instance: str | None = None,
    instancia_id: int | None = None,
) -> str:
    q = db.query(models.EmpresaInstancia).filter(models.EmpresaInstancia.empresa_id == empresa_id_eff)

    if instance:
        row = q.filter(models.EmpresaInstancia.instance_name == instance).first()
        if not row:
            raise HTTPException(404, "Instância não encontrada para a empresa.")
        return row.instance_name

    if instancia_id is not None:
        row = q.filter(models.EmpresaInstancia.id == instancia_id).first()
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


def _only_digits(s: str) -> str:
    return re.sub(r"\D+", "", s or "")


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
    # ajuste aqui se seu prefixo real for diferente
    return f"/api/atendimento/avatar/{int(cliente_id)}"


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
    _ensure_perm(identity, "atendimento.ver")

    if not EVOLUTION_URL:
        raise HTTPException(500, "EVOLUTION_URL não configurada no servidor.")
    if not payload.number:
        raise HTTPException(400, "Campo 'number' é obrigatório.")

    empresa_id_token = int(identity["empresa_id"])
    empresa_id_eff = _assert_mesma_empresa(empresa_id_token, payload.empresa_id)

    # ACL instâncias (se colaborador)
    allowed = _allowed_instancia_ids(db, identity, empresa_id_eff)

    # resolve instância solicitada (se vier)
    resolved_inst_id, resolved_inst_name = _resolve_instancia_id(
        db, empresa_id=empresa_id_eff, instancia_id=payload.instancia_id, instance=payload.instance
    )
    if (payload.instancia_id is not None or payload.instance) and resolved_inst_id is None:
        raise HTTPException(404, "Instância não encontrada para a empresa.")

    _assert_instancia_allowed(allowed, resolved_inst_id)

    # se não informarem, escolhe a melhor (como já era)
    instance_name = _pick_instance_name(
        db,
        empresa_id_eff,
        instance=resolved_inst_name,
        instancia_id=resolved_inst_id,
    )

    numero_norm = _only_digits(payload.number)
    url = f"{EVOLUTION_URL}/chat/fetchProfile/{instance_name}"

    try:
        r = requests.post(url, headers=HEADERS, json={"number": numero_norm}, timeout=30)
    except requests.RequestException as e:
        raise HTTPException(502, f"Erro ao contatar Evolution: {e}")

    if r.status_code != 200:
        try:
            raw = r.text
        except Exception:
            raw = ""
        detail = raw
        try:
            j = r.json()
            detail = j.get("detail") or j.get("message") or raw
        except Exception:
            pass

        if "Connection Closed" in str(detail):
            raise HTTPException(503, f"Instância '{instance_name}' desconectada no Evolution.")
        if 500 <= r.status_code < 600:
            raise HTTPException(502, f"Evolution erro {r.status_code}: {detail}")
        raise HTTPException(r.status_code, f"Evolution retornou {r.status_code}: {detail}")

    data = r.json() if (r.headers.get("content-type") or "").startswith("application/json") else {}

    normalized = {
        "wuid": data.get("wuid") or data.get("wid") or data.get("id"),
        "name": data.get("name") or data.get("pushName") or data.get("verifiedName"),
        "numberExists": data.get("numberExists") if "numberExists" in data else data.get("exists"),
        "picture": data.get("picture") or data.get("profilePicUrl") or data.get("imgUrl"),
        "status": data.get("status") if isinstance(data.get("status"), dict)
                   else {"status": data.get("status"), "setAt": data.get("statusAt")},
        "isBusiness": data.get("isBusiness") if "isBusiness" in data else (data.get("business") or data.get("is_business")),
        "email": data.get("email"),
        "description": data.get("description") or data.get("about"),
        "website": data.get("website"),
    }

    # Persistência no BD (SOMENTE ao abrir o perfil)
    tail11 = numero_norm[-11:]

    cli = (
        db.query(models.Cliente)
        .filter(models.Cliente.empresa_id == empresa_id_eff)
        .filter(
            or_(
                getattr(models.Cliente, "telefone_norm", models.Cliente.telefone) == numero_norm,
                models.Cliente.telefone == numero_norm,
            )
        )
        .first()
    )
    if not cli:
        cli = (
            db.query(models.Cliente)
            .filter(models.Cliente.empresa_id == empresa_id_eff)
            .filter(
                or_(
                    models.Cliente.telefone.like(f"%{tail11}"),
                    getattr(models.Cliente, "telefone_norm", models.Cliente.telefone).like(f"%{tail11}"),
                )
            )
            .order_by(models.Cliente.id.desc())
            .first()
        )

    # se for colaborador com ACL, garante que esse cliente está no escopo dele
    if cli:
        _assert_cliente_access_by_instancias(db, empresa_id=empresa_id_eff, cliente_id=int(cli.id), allowed=allowed)

    changed = False
    if cli:
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

        # IMPORTANTE: devolve pro front também a URL proxy (não quebra por CORS/expiração)
        normalized["avatar_url"] = _avatar_proxy_url(int(cli.id))
        normalized["avatar_remote_url"] = getattr(cli, "avatar_url", None)  # opcional p/ debug
    else:
        # se não achou cliente no BD, pelo menos mantém o remote (front pode ignorar)
        normalized["avatar_remote_url"] = normalized.get("picture")

    return normalized


# =========================================================
# AVATAR PROXY (fix pra foto de perfil aparecer pra todos)
# =========================================================
@router.get("/atendimento/avatar/{cliente_id}")
def atendimento_avatar(
    cliente_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
):
    _ensure_perm(identity, "atendimento.ver")

    empresa_id_token = int(identity["empresa_id"])
    allowed = _allowed_instancia_ids(db, identity, empresa_id_token)

    cli = (
        db.query(models.Cliente)
        .filter(models.Cliente.id == int(cliente_id))
        .first()
    )
    if not cli:
        raise HTTPException(status_code=404, detail="Cliente não encontrado")

    if int(getattr(cli, "empresa_id", 0)) != int(empresa_id_token):
        raise HTTPException(status_code=403, detail="Cliente não pertence à sua empresa")

    _assert_cliente_access_by_instancias(
        db,
        empresa_id=int(empresa_id_token),
        cliente_id=int(cliente_id),
        allowed=allowed,
    )

    url = (getattr(cli, "avatar_url", None) or "").strip()
    if not url:
        raise HTTPException(status_code=404, detail="Avatar não encontrado")

    headers = {}
    if EVOLUTION_URL and url.startswith(EVOLUTION_URL) and EVOLUTION_KEY:
        headers = {"apikey": EVOLUTION_KEY}

    try:
        r = requests.get(url, headers=headers, timeout=15, allow_redirects=True)
    except Exception:
        raise HTTPException(status_code=502, detail="Falha ao buscar avatar")

    if r.status_code != 200 or not r.content:
        raise HTTPException(status_code=404, detail="Avatar indisponível")

    content_type = r.headers.get("content-type") or "image/jpeg"
    resp = Response(content=r.content, media_type=content_type)
    resp.headers["Cache-Control"] = "private, max-age=3600"
    return resp


# ---- Perfil completo (ler do BD) ----
@router.get("/atendimento/clientes/{cliente_id}/profile")
def get_cliente_profile(
    cliente_id: int,
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
):
    _ensure_perm(identity, "atendimento.ver")

    cli = db.query(models.Cliente).filter(models.Cliente.id == cliente_id).first()
    if not cli:
        raise HTTPException(status_code=404, detail="Cliente não encontrado")

    empresa_id_token = int(identity["empresa_id"])
    if int(cli.empresa_id) != empresa_id_token:
        raise HTTPException(403, "Cliente não pertence à sua empresa")

    allowed = _allowed_instancia_ids(db, identity, empresa_id_token)
    _assert_cliente_access_by_instancias(db, empresa_id=empresa_id_token, cliente_id=int(cliente_id), allowed=allowed)

    # devolve SEMPRE proxy, e mantém o remote separado (se quiser)
    return {
        "id": cli.id,
        "empresa_id": cli.empresa_id,
        "telefone": cli.telefone,
        "avatar_url": _avatar_proxy_url(int(cli.id)),
        "avatar_remote_url": getattr(cli, "avatar_url", None),
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
    }


# ---- Merge não-destrutivo (NÃO permite atualizar 'nome') ----
@router.patch("/atendimento/clientes/{cliente_id}/profile")
@router.put("/atendimento/clientes/{cliente_id}/profile")
def merge_cliente_profile(
    cliente_id: int,
    payload: dict = Body(...),
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
):
    _ensure_perm(identity, "atendimento.ver")

    cli = db.query(models.Cliente).filter(models.Cliente.id == cliente_id).first()
    if not cli:
        raise HTTPException(status_code=404, detail="Cliente não encontrado")

    empresa_id_token = int(identity["empresa_id"])
    if int(cli.empresa_id) != empresa_id_token:
        raise HTTPException(403, "Cliente não pertence à sua empresa")

    allowed = _allowed_instancia_ids(db, identity, empresa_id_token)
    _assert_cliente_access_by_instancias(db, empresa_id=empresa_id_token, cliente_id=int(cliente_id), allowed=allowed)

    norm = dict(payload or {})
    norm.pop("nome", None)  # proteção extra

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
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
):
    _ensure_perm(identity, "atendimento.ver")

    cli = db.query(models.Cliente).filter(models.Cliente.id == cliente_id).first()
    if not cli:
        raise HTTPException(404, "Cliente não encontrado.")

    empresa_id_token = int(identity["empresa_id"])
    if int(cli.empresa_id) != empresa_id_token:
        raise HTTPException(403, "Cliente não pertence à sua empresa")

    allowed = _allowed_instancia_ids(db, identity, empresa_id_token)
    _assert_cliente_access_by_instancias(db, empresa_id=empresa_id_token, cliente_id=int(cliente_id), allowed=allowed)

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
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
):
    _ensure_perm(identity, "atendimento.ver")

    cli = db.query(models.Cliente).filter(models.Cliente.id == cliente_id).first()
    if not cli:
        raise HTTPException(404, "Cliente não encontrado.")

    empresa_id_token = int(identity["empresa_id"])
    if int(cli.empresa_id) != empresa_id_token:
        raise HTTPException(403, "Cliente não pertence à sua empresa")

    allowed = _allowed_instancia_ids(db, identity, empresa_id_token)
    _assert_cliente_access_by_instancias(db, empresa_id=empresa_id_token, cliente_id=int(cliente_id), allowed=allowed)

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


# ---- Util pra acertar Content-Type de mídias ----
def _smart_mimetype(tipo: str | None, mt_db: str | None, filename: str | None) -> str:
    if mt_db and mt_db.lower() != "application/octet-stream":
        return mt_db

    t = (tipo or "").lower()
    if t == "image":
        return "image/jpeg"
    if t == "video":
        return "video/mp4"
    if t == "audio":
        return "audio/ogg"
    if t == "sticker":
        return "image/webp"

    if filename:
        guess = mimetypes.guess_type(filename)[0]
        if guess:
            return guess
    return "application/octet-stream"


_RANGE_RE = re.compile(r"bytes=(\d*)-(\d*)")


def _open_local_file(path: str) -> Tuple[int, callable]:
    file_size = os.path.getsize(path)

    def _reader(start=0, end=None, chunk=1024 * 256):
        nonlocal path
        with open(path, "rb") as f:
            f.seek(start)
            remaining = (end - start + 1) if end is not None else None
            while True:
                size = chunk if remaining is None else min(chunk, remaining)
                data = f.read(size)
                if not data:
                    break
                if remaining is not None:
                    remaining -= len(data)
                    if remaining <= 0:
                        yield data
                        break
                yield data

    return file_size, _reader


def _range_from_header(range_header: Optional[str], total: int) -> Tuple[int, Optional[int]]:
    if not range_header:
        return 0, None
    m = _RANGE_RE.match(range_header.strip())
    if not m:
        return 0, None
    start_s, end_s = m.groups()
    if start_s == "" and end_s == "":
        return 0, None
    if start_s == "":
        last_n = int(end_s)
        start = max(0, total - last_n)
        return start, total - 1
    start = int(start_s)
    if end_s == "":
        return start, None
    end = min(int(end_s), total - 1)
    if end < start:
        end = start
    return start, end


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
    _ensure_perm(identity, "atendimento.ver")

    empresa_id_token = int(identity["empresa_id"])
    empresa_id_eff = _assert_mesma_empresa(empresa_id_token, empresa_id)

    qn = _normalize_text(q)
    if not qn:
        return {"contatos": [], "mensagens": []}

    allowed = _allowed_instancia_ids(db, identity, empresa_id_eff)

    # resolve instância pedida (se vier)
    resolved_inst_id, _resolved_inst_name = _resolve_instancia_id(
        db, empresa_id=empresa_id_eff, instancia_id=instancia_id, instance=instance
    )
    if (instancia_id is not None or instance) and resolved_inst_id is None:
        raise HTTPException(404, "Instância não encontrada para a empresa.")
    _assert_instancia_allowed(allowed, resolved_inst_id)

    m = models.Mensagem

    # ----------------- filtros efetivos de instância -----------------
    filtros_inst = []
    if resolved_inst_id is not None:
        filtros_inst.append(m.instancia_id == int(resolved_inst_id))
    else:
        if allowed is not None:
            if not allowed:
                return {"contatos": [], "mensagens": []}
            filtros_inst.append(m.instancia_id.in_([int(x) for x in allowed]))

    # subquery: última msg por cliente (já respeitando instâncias)
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
        )
        .join(sub_last, sub_last.c.cid == models.Cliente.id)
        .join(m, m.id == sub_last.c.last_msg_id)
        .filter(models.Cliente.empresa_id == empresa_id_eff)
        .order_by(m.timestamp.desc())
        .limit(400)
        .all()
    )

    contatos: List[Dict] = []
    for cli, last_txt, last_tipo, last_ack, last_ts in rows:
        nome = (getattr(cli, "nome_whatsapp", None) or cli.nome or "").strip()
        tel = (cli.telefone or "").strip()
        last = (last_txt or "").strip()

        if qn in _normalize_text(nome) or qn in _normalize_text(tel) or qn in _normalize_text(last):
            ts_iso = last_ts.isoformat() if last_ts else None
            contatos.append({
                "id": cli.id,
                "nome": nome or tel,
                "telefone": cli.telefone,
                "avatar_url": _avatar_proxy_url(int(cli.id)),
                "avatar_remote_url": getattr(cli, "avatar_url", None),
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
            models.Cliente.nome,
            models.Cliente.telefone,
            models.Cliente.nome_whatsapp,
        )
        .join(models.Cliente, models.Cliente.id == m.cliente_id)
        .filter(m.empresa_id == empresa_id_eff, *filtros_inst, m.conteudo.ilike(like))
        .order_by(m.timestamp.desc())
        .limit(min(limit, 80))
        .all()
    )

    mensagens: List[Dict] = []
    for cid, txt, ts, cli_nome, cli_tel, cli_nome_whats in msgs_rows:
        nome = (cli_nome_whats or cli_nome or "").strip()
        tel = (cli_tel or "").strip()
        mensagens.append(
            {
                "cliente_id": int(cid),
                "cliente_nome": nome or tel,
                "cliente_telefone": tel,
                "snippet": (txt or ""),
                "hora": ts.isoformat() if ts else None,
            }
        )

    return {"contatos": contatos, "mensagens": mensagens}