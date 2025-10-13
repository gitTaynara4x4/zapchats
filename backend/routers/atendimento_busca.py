# backend/routers/atendimento_busca.py
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Body, Query
import mimetypes
import os
import re
import unicodedata
import requests
from typing import Dict, List, Optional, Tuple
from datetime import datetime, timezone

from pydantic import BaseModel
from sqlalchemy.orm import Session
from sqlalchemy import or_, func
from sqlalchemy.exc import ProgrammingError

from backend.database import get_db
from backend import models
from backend.routers.auth import get_current_user

router = APIRouter(tags=["Atendimento – Perfil / Evolution & Busca/Arquivo"])

# ===== Evolution config =====
EVOLUTION_URL = (os.getenv("EVOLUTION_URL", "").rstrip("/"))
EVOLUTION_KEY = os.getenv("EVOLUTION_APIKEY") or os.getenv("EVOLUTION_KEY")
HEADERS = {"apikey": EVOLUTION_KEY, "Content-Type": "application/json"} if EVOLUTION_KEY else {}


# ===== Schemas =====
class FetchProfileIn(BaseModel):
    number: str
    empresa_id: int | None = None     # opcional; se não vier, usamos a do token
    instancia_id: int | None = None   # opcional: id da instância
    instance: str | None = None       # opcional: nome da instância (instance_name)


class SaveProfileIn(BaseModel):
    """
    Aceita tanto o shape 'normalizado' quanto o shape Evolution.
    Só persistimos colunas existentes em models.Cliente.
    """
    # shape normalizado (campos que o front envie se quiser fazer merge)
    avatar_url: str | None = None
    # nome: removido de updates automáticos
    is_business: bool | None = None
    status_text: str | None = None     # -> status_whatsapp
    email: str | None = None
    description: str | None = None     # -> descricao
    website: str | None = None
    sobre_cliente: str | None = None   # notas (drawer)

    # shape bruto do Evolution (opcional)
    name: str | None = None
    isBusiness: bool | None = None
    picture: str | None = None
    status: dict | None = None         # {"status": "...", "setAt": "..."}


class SaveCustomIn(BaseModel):
    """Campos custom do drawer (formulário de endereço/documentos)."""
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
    # novos (compat opcional)
    data_nascimento: str | None = None
    genero: str | None = None


# ===== Helpers =====
def _assert_mesma_empresa(empresa_do_token: int, empresa_da_query: int | None) -> int:
    if empresa_da_query is None:
        return empresa_do_token
    if empresa_da_query != empresa_do_token:
        raise HTTPException(403, "Empresa inválida para este recurso")
    return empresa_da_query


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

    m = re.match(r"^(\d{2})/(\d{2})/(\d{4})$", s)  # BR
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


# Campos permitidos para merge no profile (NÃO inclui 'nome')
UPDATABLE_FIELDS = {
    # básicos / visual
    "avatar_url",
    # evolution / status
    "wuid", "whatsapp_exists", "is_business", "status_text", "status_set_at",
    # contato extra
    "email", "description", "website",
    # custom
    "nome_completo", "cpf_cnpj", "rg",
    "data_nascimento", "genero",
    "cep", "endereco", "numero", "complemento", "bairro", "cidade", "estado",
    # notas
    "sobre_cliente",
}

# Mapeamento de campos normalizados -> colunas reais
FIELD_MAP = {
    "status_text": "status_whatsapp",
    "description": "descricao",
}


# ============= ROTAS EVOLUTION: fetchProfile (com persistência ao abrir) =============
@router.post("/evolution/fetchProfile")
def evolution_fetch_profile(
    payload: FetchProfileIn,
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    """
    1) Chama Evolution: /chat/fetchProfile/{instance}
    2) Retorna payload normalizado para o front
    3) Atualiza o BD somente ao abrir o perfil:
       - Só dá UPDATE se algum valor mudou (evita writes desnecessários)
       - NÃO atualiza telefone_norm (coluna gerada)
       - **NÃO altera o campo 'nome'**; salva o nome vindo do WA em `nome_whatsapp`.
    """
    if not EVOLUTION_URL:
        raise HTTPException(500, "EVOLUTION_URL não configurada no servidor.")
    if not payload.number:
        raise HTTPException(400, "Campo 'number' é obrigatório.")

    empresa_id_eff = _assert_mesma_empresa(user.empresa_id, payload.empresa_id)
    instance_name = _pick_instance_name(
        db,
        empresa_id_eff,
        instance=payload.instance,
        instancia_id=payload.instancia_id,
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

    changed = False
    if cli:
        # NÃO tocar em telefone_norm e NÃO tocar em 'nome'
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

    return normalized


# ---- Perfil completo (ler do BD) ----
@router.get("/atendimento/clientes/{cliente_id}/profile")
def get_cliente_profile(
    cliente_id: int,
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    cli = db.query(models.Cliente).filter(models.Cliente.id == cliente_id).first()
    if not cli:
        raise HTTPException(status_code=404, detail="Cliente não encontrado")
    if int(cli.empresa_id) != int(user.empresa_id):
        raise HTTPException(403, "Cliente não pertence à sua empresa")

    return {
        "id": cli.id,
        "empresa_id": cli.empresa_id,
        "telefone": cli.telefone,
        "avatar_url": getattr(cli, "avatar_url", None),
        "nome": getattr(cli, "nome", None),
        "nome_whatsapp": getattr(cli, "nome_whatsapp", None),
        # ===== Campos personalizados =====
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
        # Evolution (somente leitura no front)
        "is_business": getattr(cli, "is_business", None),
        "status_text": getattr(cli, "status_whatsapp", None),
        # extras úteis
        "description": getattr(cli, "descricao", None),
        "website": getattr(cli, "website", None),
        # notas
        "sobre_cliente": getattr(cli, "sobre_cliente", None),
    }


# ---- Merge não-destrutivo (NÃO permite atualizar 'nome') ----
@router.patch("/atendimento/clientes/{cliente_id}/profile")
@router.put("/atendimento/clientes/{cliente_id}/profile")
def merge_cliente_profile(
    cliente_id: int,
    payload: dict = Body(...),
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    """
    Atualização NÃO-DESTRUTIVA:
    - Só atualiza campos presentes no payload E com valor não-vazio (após _clean).
    - Campos ausentes são ignorados (não apaga).
    - Suporta aliases: data_nascimento|nascimento|dataNascimento e genero|sexo.
    - **Ignora o campo 'nome' se vier no payload.**
    """
    cli = db.query(models.Cliente).filter(models.Cliente.id == cliente_id).first()
    if not cli:
        raise HTTPException(status_code=404, detail="Cliente não encontrado")
    if int(cli.empresa_id) != int(user.empresa_id):
        raise HTTPException(403, "Cliente não pertence à sua empresa")

    norm = dict(payload or {})
    # proteção extra: remover 'nome' se vier
    if "nome" in norm:
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
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    cli = db.query(models.Cliente).filter(models.Cliente.id == cliente_id).first()
    if not cli:
        raise HTTPException(404, "Cliente não encontrado.")
    if int(cli.empresa_id) != int(user.empresa_id):
        raise HTTPException(403, "Cliente não pertence à sua empresa")

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
    user=Depends(get_current_user),
):
    """
    Atualiza campos custom do cliente (formulário do drawer) de forma NÃO-DESTRUTIVA.
    Usa exclude_unset=True para aplicar somente campos enviados no JSON.
    Strings vazias são ignoradas (não sobrescrevem com NULL).
    """
    cli = db.query(models.Cliente).filter(models.Cliente.id == cliente_id).first()
    if not cli:
        raise HTTPException(404, "Cliente não encontrado.")
    if int(cli.empresa_id) != int(user.empresa_id):
        raise HTTPException(403, "Cliente não pertence à sua empresa")

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
        return "audio/ogg"  # ptt/opus costuma vir .ogg
    if t == "sticker":
        return "image/webp"

    if filename:
        guess = mimetypes.guess_type(filename)[0]
        if guess:
            return guess
    return "application/octet-stream"


# ---- Helpers para servir bytes/local file com suporte a Range ----
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
    user=Depends(get_current_user),
):
    """
    Responde no shape esperado pelo front:
    {
      "contatos": [{ id, nome, telefone, avatar_url, ultima_mensagem, hora, last_ts }, ...],
      "mensagens": [{ cliente_id, snippet, hora }, ...]
    }
    """
    empresa_id_eff = _assert_mesma_empresa(user.empresa_id, empresa_id)

    qn = _normalize_text(q)
    if not qn:
        return {"contatos": [], "mensagens": []}

    m = models.Mensagem
    sub_last = (
        db.query(
            m.cliente_id.label("cid"),
            func.max(m.id).label("last_msg_id"),
        )
        .filter(m.empresa_id == empresa_id_eff)
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
                "avatar_url": getattr(cli, "avatar_url", None),
                "ultima_mensagem": last,
                "hora": ts_iso,
                "last_ts": ts_iso,
                "last_tipo": last_tipo,
                "last_ack": int(last_ack or 0) if last_tipo == "saida" else None,
            })
            if len(contatos) >= limit:
                break

    filtros = [m.empresa_id == empresa_id_eff]
    if instancia_id is not None:
        filtros.append(m.instancia_id == instancia_id)
    if instance:
        inst_row = (
            db.query(models.EmpresaInstancia)
            .filter(models.EmpresaInstancia.empresa_id == empresa_id_eff,
                    models.EmpresaInstancia.instance_name == instance)
            .first()
        )
        if inst_row:
            filtros.append(m.instancia_id == inst_row.id)

    like = f"%{q}%"
    msgs_rows = (
        db.query(m.cliente_id, m.conteudo, m.timestamp)
        .filter(*filtros, m.conteudo.ilike(like))
        .order_by(m.timestamp.desc())
        .limit(min(limit, 80))
        .all()
    )

    mensagens: List[Dict] = [
        {"cliente_id": int(cid), "snippet": (txt or ""), "hora": ts.isoformat() if ts else None}
        for cid, txt, ts in msgs_rows
    ]

    return {"contatos": contatos, "mensagens": mensagens}
