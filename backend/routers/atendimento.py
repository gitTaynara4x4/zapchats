from __future__ import annotations

import os
import json
import asyncio
from typing import Optional, Dict, List, Tuple, Any, Iterable
from datetime import datetime

from dateutil import parser
from fastapi import APIRouter, Depends, HTTPException, Query, Body, Header
from sqlalchemy import func, text
from sqlalchemy.orm import Session
from pydantic import BaseModel

from backend import models
from backend.database import get_db
from backend.websocket_manager import conexoes_ativas
from backend.routers.auth import get_current_identity  # <- identity (colab + perms)

# =========================================================
# Redis (opcional) – cache leve para /conversas e /clientes
# =========================================================
REDIS_URL = os.getenv("REDIS_URL")
REDIS_PREFIX = os.getenv("REDIS_PREFIX", "zap")
REDIS_TTL_S = int(os.getenv("REDIS_TTL_SECONDS", "120"))

_redis = None
if REDIS_URL:
    try:
        import redis  # type: ignore
        _redis = redis.Redis.from_url(REDIS_URL, decode_responses=True)
    except Exception:
        _redis = None  # se não tiver lib ou falhar, segue sem cache


def _k(*parts: str) -> str:
    return ":".join([REDIS_PREFIX, *[p for p in parts if p is not None and p != ""]])


def _cache_get_json(key: str):
    if not _redis:
        return None
    try:
        v = _redis.get(key)
        return json.loads(v) if v else None
    except Exception:
        return None


def _cache_set_json(key: str, obj, ttl: int = REDIS_TTL_S):
    if not _redis:
        return
    try:
        _redis.set(key, json.dumps(obj, ensure_ascii=False), ex=ttl)
    except Exception:
        pass


def _cache_del(*keys: str):
    if not _redis:
        return
    try:
        if keys:
            _redis.delete(*keys)
    except Exception:
        pass


def _cache_del_pattern(prefix: str):
    if not _redis:
        return
    try:
        to_del = []
        for k in _redis.scan_iter(match=f"{prefix}*"):
            to_del.append(k)
            if len(to_del) >= 500:
                _redis.delete(*to_del)
                to_del = []
        if to_del:
            _redis.delete(*to_del)
    except Exception:
        pass


# =========================================================
# Helpers: flags de conversa (pin/labels/deleted) e admin
# =========================================================
def _k_pin(empresa_id: int) -> str:
    return _k("conv", "pin", "emp", str(int(empresa_id)))


def _k_pin_user(empresa_id: int, user_id: int) -> str:
    return _k("conv", "pin", "emp", str(int(empresa_id)), "user", str(int(user_id)))


def _k_deleted(empresa_id: int) -> str:
    return _k("conv", "deleted", "emp", str(int(empresa_id)))


def _k_labels(empresa_id: int, cliente_id: int) -> str:
    return _k("conv", "labels", "emp", str(int(empresa_id)), "cli", str(int(cliente_id)))


def _ensure_list(x):
    return x if isinstance(x, list) else (list(x) if isinstance(x, (set, tuple)) else [])


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
    # tenta campos explícitos
    for key in ("id_colab", "colaborador_id", "id_colaborador", "colab_id", "cid"):
        cid = _to_int(identity.get(key))
        if cid:
            return cid

    # tenta sub colab-<id>
    sub = str(identity.get("sub") or "").strip().lower()
    if sub.startswith("colab-"):
        cid = _to_int(sub.split("-", 1)[1])
        if cid:
            return cid

    # fallback comum: identity["id"] = id do colaborador
    return _to_int(identity.get("id"))


def _is_admin(user) -> bool:
    """
    Considera admin se: user.is_admin == True OU permissões conterem:
    'admin', 'root', 'clientes.gerenciar' ou 'atendimento.gerenciar'.
    Suporta identity (dict) e models.Usuario.
    """
    try:
        if isinstance(user, dict):
            if user.get("is_admin"):
                return True
            perms = user.get("permissoes") or user.get("permissions") or []
        else:
            if getattr(user, "is_admin", False):
                return True
            perms = getattr(user, "permissoes", None) or getattr(user, "permissions", None) or []

        if isinstance(perms, dict):
            perms = [k for k, v in perms.items() if v]
        perms = set(str(p).lower() for p in (perms or []))
        return any(p in perms for p in ("admin", "root", "clientes.gerenciar", "atendimento.gerenciar"))
    except Exception:
        return False


def _empresa_do_user(user) -> Optional[int]:
    if isinstance(user, dict):
        return user.get("empresa_id")
    return getattr(user, "empresa_id", None) or getattr(user, "empresa", None)


def _assert_empresa_user(user, empresa_id: int) -> int:
    emp = _empresa_do_user(user)
    if emp is not None and int(emp) != int(empresa_id):
        raise HTTPException(status_code=403, detail="Empresa inválida para este usuário")
    return int(empresa_id)


def _ensure_perm(identity: dict, perm: str) -> None:
    perms = set(identity.get("permissoes") or [])
    if perm not in perms and not _is_admin(identity):
        raise HTTPException(status_code=403, detail=f"Sem permissão ({perm})")


# =========================================================
# Avatar URL: nunca devolver pps.whatsapp.net pro browser
# -> sempre devolver o proxy do backend (/api/atendimento/avatar/{cliente_id})
# =========================================================
def _public_avatar_url(cliente_id: int, raw_avatar_url: Optional[str]) -> Optional[str]:
    """
    Se o banco tiver avatar_url apontando para pps.whatsapp.net (ou qualquer http externo),
    NÃO mande pro front. Mande o proxy local.

    - Se já vier /api/atendimento/avatar/... mantém.
    - Se não tiver nada, retorna None (front usa fallback).
    """
    if not cliente_id:
        return None

    raw = (raw_avatar_url or "").strip()
    if not raw:
        return None

    # já é nosso proxy/local
    if raw.startswith("/api/atendimento/avatar/"):
        return raw

    # se vier pps.whatsapp.net (ou qualquer URL externa), força proxy
    if raw.startswith("http://") or raw.startswith("https://"):
        return f"/api/atendimento/avatar/{int(cliente_id)}"

    # qualquer outra string estranha -> também força proxy (mais seguro)
    return f"/api/atendimento/avatar/{int(cliente_id)}"


# =========================================================
# ACL por instância do colaborador (privacidade)
# - Usa tabela colaboradores_instancias se existir
# - Se não existir: modo legado (não filtra por instância)
# =========================================================
def _table_exists(db: Session, table_name: str) -> bool:
    """
    Postgres: to_regclass('public.tabela') retorna NULL se não existir.
    Se não for postgres, tenta e falha com try/except (retorna False).
    """
    try:
        reg = db.execute(text(f"SELECT to_regclass('public.{table_name}')")).scalar()
        return reg is not None
    except Exception:
        return False


def _allowed_instancia_ids(db: Session, identity: dict, empresa_id: int) -> Optional[List[int]]:
    """
    Retorna:
      - None  => sem restrição (admin/usuario master OU tabela inexistente)
      - []    => colaborador sem instâncias permitidas (nega tudo)
      - [..]  => lista de instâncias permitidas
    """
    if _is_admin(identity):
        return None

    kind = _infer_kind(identity)
    if kind != "colaborador":
        # usuário/admin do painel: sem restrição por enquanto
        return None

    if not _table_exists(db, "colaboradores_instancias"):
        # legado: sem tabela de ACL, não restringe
        return None

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
    # se tiver tabela mas não tiver vínculos, é nega-tudo (privacidade)
    return ids


def _assert_instancia_allowed(
    *,
    allowed: Optional[List[int]],
    instancia_id: Optional[int],
) -> None:
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
    Garante que o colaborador só consiga mexer em conversa/cliente que tenha
    mensagens em instâncias permitidas.
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


# ------- Helpers: PIN por usuário em DB (com fallback) -------
def _has_model_pinned() -> bool:
    return hasattr(models, "AtendimentoPinnedConversa")


def _pinned_set_db(db: Session, empresa_id: int, user_id: int) -> set[int]:
    if not _has_model_pinned():
        return set()
    rows = (
        db.query(models.AtendimentoPinnedConversa.conversa_id)
        .filter(
            models.AtendimentoPinnedConversa.empresa_id == int(empresa_id),
            models.AtendimentoPinnedConversa.user_id == int(user_id),
        )
        .all()
    )
    return set(int(r[0]) for r in rows)


def _pins_get_cached(db: Session, empresa_id: int, user_id: int) -> set[int]:
    c = _cache_get_json(_k_pin_user(empresa_id, user_id))
    if c is not None:
        try:
            return set(int(x) for x in c)
        except Exception:
            pass
    s = _pinned_set_db(db, empresa_id, user_id)
    _cache_set_json(_k_pin_user(empresa_id, user_id), sorted(s), ttl=30 * 24 * 3600)
    return s


def _pins_put_cached(empresa_id: int, user_id: int, s: set[int]):
    _cache_set_json(_k_pin_user(empresa_id, user_id), sorted(int(x) for x in s), ttl=30 * 24 * 3600)


# ------- Helpers: Labels com cor em DB (com fallback) -------
def _has_model_labels() -> bool:
    return hasattr(models, "AtendimentoConversaLabel")


def _normalize_hex(c: Optional[str]) -> Optional[str]:
    if not c:
        return None
    c = str(c).strip()
    if not c:
        return None
    if not c.startswith("#"):
        c = "#" + c
    if len(c) == 4:
        c = "#" + "".join(ch * 2 for ch in c[1:])
    return c[:7].lower()


def _labels_db_list(db: Session, empresa_id: int, cliente_id: int) -> List[Dict[str, Optional[str]]]:
    if not _has_model_labels():
        return []
    rows = (
        db.query(models.AtendimentoConversaLabel)
        .filter(
            models.AtendimentoConversaLabel.empresa_id == int(empresa_id),
            models.AtendimentoConversaLabel.cliente_id == int(cliente_id),
        )
        .order_by(models.AtendimentoConversaLabel.name.asc())
        .all()
    )
    return [{"name": r.name, "color_hex": r.color_hex} for r in rows]


def _labels_db_upsert(
    db: Session,
    empresa_id: int,
    cliente_id: int,
    name: str,
    color_hex: Optional[str],
    created_by: Optional[int],
) -> None:
    if not _has_model_labels():
        return
    row = (
        db.query(models.AtendimentoConversaLabel)
        .filter(
            models.AtendimentoConversaLabel.empresa_id == int(empresa_id),
            models.AtendimentoConversaLabel.cliente_id == int(cliente_id),
            models.AtendimentoConversaLabel.name == name,
        )
        .first()
    )
    if row:
        row.color_hex = color_hex
    else:
        db.add(
            models.AtendimentoConversaLabel(
                empresa_id=int(empresa_id),
                cliente_id=int(cliente_id),
                name=name,
                color_hex=color_hex,
                created_by=int(created_by) if created_by is not None else None,
            )
        )
    db.commit()


def _labels_db_replace_all(
    db: Session,
    empresa_id: int,
    cliente_id: int,
    names: Iterable[str],
    created_by: Optional[int],
) -> None:
    if not _has_model_labels():
        return
    names = [n for n in (names or []) if isinstance(n, str) and n.strip()]
    db.query(models.AtendimentoConversaLabel).filter(
        models.AtendimentoConversaLabel.empresa_id == int(empresa_id),
        models.AtendimentoConversaLabel.cliente_id == int(cliente_id),
        ~models.AtendimentoConversaLabel.name.in_(names) if names else True,
    ).delete(synchronize_session=False)
    for n in names:
        _labels_db_upsert(db, empresa_id, cliente_id, n.strip(), None, created_by)
    db.commit()


router = APIRouter(prefix="", tags=["Atendimento"])


def LOG(*a):
    print("\033[92m[ATENDIMENTO]", *a, "\033[0m")


# =========================================================
# WebSocket broadcast util
# =========================================================
async def _broadcast(payload: dict, *, empresa_id: int | None = None, grupo: str | None = None):
    try:
        if grupo:
            await conexoes_ativas.send_message(grupo, payload)
            return
        if empresa_id is not None:
            await conexoes_ativas.send_message(f"emp:{int(empresa_id)}", payload)
            return
        for g in list(conexoes_ativas.grupos.keys()):
            await conexoes_ativas.send_message(g, payload)
    except Exception as e:
        print("[ATENDIMENTO][BROADCAST][ERRO]", e)


class BroadcastMensagem(BaseModel):
    empresa_id: int
    cliente_id: int
    mensagem: str
    tipo: str
    timestamp: str
    msg_id: str
    midia_url: Optional[str] = None
    mimetype: Optional[str] = None
    lida: bool = False
    midias: Optional[List[Dict]] = None
    instancia_id: Optional[int] = None
    instance_name: Optional[str] = None


def _parse_timestamp(val) -> str:
    if val is None:
        return datetime.utcnow().isoformat()
    try:
        if isinstance(val, (int, float)) or (isinstance(val, str) and str(val).isdigit()):
            dt = datetime.utcfromtimestamp(int(val))
            return dt.isoformat()
        if isinstance(val, str) and "T" not in val and " " in val:
            try:
                return parser.parse(val.replace(" ", "T")).isoformat()
            except Exception:
                pass
        return parser.parse(str(val)).isoformat()
    except Exception:
        return str(val)


INTERNAL_BROADCAST_KEY = os.getenv("INTERNAL_BROADCAST_KEY")


@router.post("/broadcast")
async def broadcast_msg(
    dados: dict,
    x_internal_key: Optional[str] = Header(None, alias="X-Internal-Key"),
    db: Session = Depends(get_db),
):
    if INTERNAL_BROADCAST_KEY:
        if not x_internal_key or x_internal_key != INTERNAL_BROADCAST_KEY:
            raise HTTPException(status_code=403, detail="Chave interna inválida para broadcast")

    mensagem = dados.get("mensagem") or dados.get("texto") or dados.get("message") or ""
    tipo = dados.get("tipo") or dados.get("direction") or ""

    is_ack_isolado = dados.get("ack") is not None and not mensagem and not tipo

    ts_bruto = dados.get("timestamp") or dados.get("hora") or dados.get("created_at") or dados.get("ts")
    ts_formatado = _parse_timestamp(ts_bruto)

    if is_ack_isolado:
        empresa_id = dados.get("empresa_id")
        msg_id = dados.get("msg_id")
        ack_raw = dados.get("ack")

        cliente_id = dados.get("cliente_id")

        if cliente_id is None and empresa_id and msg_id:
            try:
                row = (
                    db.query(models.Mensagem.cliente_id)
                    .filter(
                        models.Mensagem.empresa_id == int(empresa_id),
                        models.Mensagem.msg_id == str(msg_id),
                    )
                    .order_by(models.Mensagem.id.desc())
                    .first()
                )
                if row and row[0] is not None:
                    cliente_id = int(row[0])
            except Exception:
                pass

        try:
            new_ack: Optional[int] = None
            if ack_raw is not None:
                try:
                    new_ack = int(ack_raw)
                except Exception:
                    new_ack = None

            if new_ack is not None and new_ack > 0 and empresa_id and msg_id:
                (
                    db.query(models.Mensagem)
                    .filter(
                        models.Mensagem.empresa_id == int(empresa_id),
                        models.Mensagem.msg_id == str(msg_id),
                        models.Mensagem.tipo == "saida",
                    )
                    .filter(func.coalesce(models.Mensagem.ack, 0) < new_ack)
                    .update({"ack": new_ack}, synchronize_session=False)
                )
                db.commit()
        except Exception as e:
            try:
                db.rollback()
            except Exception:
                pass
            print("[BROADCAST][ACK-ONLY][DB-ERROR]", e)

        payload = {
            "type": "ack",
            "empresa_id": empresa_id,
            "msg_id": msg_id,
            "ack": ack_raw,
            "cliente_id": cliente_id,
            "timestamp": ts_formatado,
            "instancia_id": dados.get("instancia_id") or dados.get("instance_id"),
            "instance_name": dados.get("instance_name") or dados.get("instance"),
        }

    else:
        payload = {
            "empresa_id": dados.get("empresa_id"),
            "cliente_id": dados.get("cliente_id"),
            "mensagem": mensagem,
            "tipo": tipo,
            "timestamp": ts_formatado,
            "msg_id": dados.get("msg_id"),
            "ack": dados.get("ack"),
            "novo_cliente": dados.get("novo_cliente", False),
            "instancia_id": dados.get("instancia_id") or dados.get("instance_id"),
            "instance_name": dados.get("instance_name") or dados.get("instance"),
        }

        midias: List[Dict] = []

        if isinstance(dados.get("midias"), list) and dados["midias"]:
            for a in dados["midias"]:
                u = a.get("url") or a.get("url_api") or a.get("link") or a.get("path") or ""
                if not u and a.get("id"):
                    u = f"/api/atendimento/midias/{a['id']}"
                midias.append(
                    {
                        "tipo": (a.get("tipo") or a.get("type") or "").lower(),
                        "mimetype": (a.get("mimetype") or a.get("mime") or ""),
                        "filename": (a.get("filename") or a.get("name") or a.get("nome_original") or ""),
                        "url": u,
                    }
                )

        elif dados.get("midia_url"):
            mt = (dados.get("mimetype") or "").lower()

            def _guess_tipo(m: str) -> str:
                if m == "image/webp":
                    return "sticker"
                if m.startswith("image/"):
                    return "image"
                if m.startswith("video/"):
                    return "video"
                if m.startswith("audio/"):
                    return "audio"
                return "document"

            midias = [
                {
                    "tipo": _guess_tipo(mt),
                    "mimetype": mt or "",
                    "filename": dados.get("filename") or dados.get("name") or "",
                    "url": dados["midia_url"],
                }
            ]

        if midias:
            for m in midias:
                if isinstance(m.get("url"), str) and m["url"].isdigit():
                    m["url"] = f"/api/atendimento/midias/{m['url']}"
            payload["midias"] = midias

    await _broadcast(payload, empresa_id=dados.get("empresa_id"))

    emp_id = dados.get("empresa_id")
    if emp_id:
        _cache_del_pattern(_k("conv", "list", "emp", str(emp_id)))
        _cache_del(_k("clientes", "emp", str(emp_id), "dep", ""))

    return {"status": "ok"}


# =========================================================
# Helpers de instância (resolver id/slug)
# =========================================================
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
                models.EmpresaInstancia.empresa_id == empresa_id,
                models.EmpresaInstancia.id == instancia_id,
            )
            .first()
        )
        if row:
            return row.id, row.instance_name
        return None, None

    if instance:
        row = (
            db.query(models.EmpresaInstancia)
            .filter(
                models.EmpresaInstancia.empresa_id == empresa_id,
                models.EmpresaInstancia.instance_name == instance,
            )
            .first()
        )
        if row:
            return row.id, row.instance_name
        return None, None

    return None, None


# =========================================================
# Conversas (lista com paginação) — endpoint canônico p/ UI
# =========================================================
@router.get("/conversas")
def listar_conversas(
    empresa_id: int = Query(...),
    instancia_id: Optional[int] = Query(None),
    instance: Optional[str] = Query(None),
    limit: int = Query(20, ge=1, le=100),
    cursor: Optional[int] = Query(None, description="id da última Mensagem já carregada"),
    cursor_last_msg_id: Optional[int] = Query(None, description="alias legado"),
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
):
    empresa_id = _assert_empresa_user(identity, empresa_id)
    _ensure_perm(identity, "atendimento.ver")

    user_id = int(identity["id"])
    allowed = _allowed_instancia_ids(db, identity, empresa_id)

    try:
        if cursor is None and cursor_last_msg_id is not None:
            cursor = cursor_last_msg_id

        m = models.Mensagem

        resolved_inst_id, resolved_inst_name = _resolve_instancia_id(
            db, empresa_id=empresa_id, instancia_id=instancia_id, instance=instance
        )

        # se o front pediu instância mas não existe, devolve 404 (evita “vazar” tudo)
        if (instancia_id is not None or instance) and resolved_inst_id is None:
            raise HTTPException(status_code=404, detail="Instância não encontrada")

        # aplica ACL: se pediu uma instância específica, valida
        _assert_instancia_allowed(allowed=allowed, instancia_id=resolved_inst_id)

        inst_key = str(resolved_inst_id) if resolved_inst_id is not None else (resolved_inst_name or "0")
        cursor_key = str(cursor) if cursor is not None else "none"

        cache_key = _k(
            "conv",
            "list",
            "emp",
            str(empresa_id),
            "inst",
            inst_key,
            "limit",
            str(limit),
            "cursor",
            cursor_key,
        )
        cached = _cache_get_json(cache_key)
        if cached:
            deleted_set = set(_cache_get_json(_k_deleted(empresa_id)) or [])
            if _has_model_pinned():
                pins_user = _pins_get_cached(db, int(empresa_id), user_id)
            else:
                pins_user = set(_cache_get_json(_k_pin(empresa_id)) or [])

            items = [it for it in cached.get("items", []) if int(it["cliente_id"]) not in deleted_set]
            for it in items:
                it["pinned"] = int(it["cliente_id"]) in pins_user
                # GARANTE: avatar_url sempre proxy local (nunca pps.whatsapp.net)
                it["avatar_url"] = _public_avatar_url(int(it["cliente_id"]), it.get("avatar_url"))

            items_p = [it for it in items if it.get("pinned")]
            items_o = [it for it in items if not it.get("pinned")]
            return {"items": items_p + items_o, "next_cursor": cached.get("next_cursor")}

        filtros = [m.empresa_id == empresa_id]

        # filtro de instância
        if resolved_inst_id is not None:
            filtros.append(m.instancia_id == resolved_inst_id)
        else:
            # se não pediu instância, mas tem ACL, restringe ao conjunto permitido
            if allowed is not None:
                if not allowed:
                    payload = {"items": [], "next_cursor": None}
                    _cache_set_json(cache_key, payload)
                    return payload
                filtros.append(m.instancia_id.in_([int(x) for x in allowed]))

        subq = (
            db.query(
                m.cliente_id.label("cid"),
                func.max(m.id).label("last_msg_id"),
            )
            .filter(*filtros)
            .group_by(m.cliente_id)
            .subquery()
        )

        base = db.query(
            subq.c.cid.label("cliente_id"),
            subq.c.last_msg_id.label("msg_id"),
        )
        if cursor:
            base = base.filter(subq.c.last_msg_id < int(cursor))

        base = base.order_by(subq.c.last_msg_id.desc()).limit(limit)
        pairs = base.all()

        if not pairs:
            payload = {"items": [], "next_cursor": None}
            _cache_set_json(cache_key, payload)
            return payload

        cliente_ids = [int(p[0]) for p in pairs]
        msg_ids = [int(p[1]) for p in pairs]

        clientes = {
            c.id: c
            for c in db.query(models.Cliente)
            .filter(models.Cliente.empresa_id == empresa_id, models.Cliente.id.in_(cliente_ids))
            .all()
        }

        msgs = {mm.id: mm for mm in db.query(m).filter(m.id.in_(msg_ids)).all()}

        novas_map: Dict[int, int] = {}
        if cliente_ids:
            q_novas = (
                db.query(m.cliente_id, func.count(m.id))
                .filter(
                    m.empresa_id == empresa_id,
                    m.cliente_id.in_(cliente_ids),
                    m.tipo == "entrada",
                    m.lida == False,  # noqa: E712
                )
            )

            # mesma restrição de instância na contagem de não lidas
            if resolved_inst_id is not None:
                q_novas = q_novas.filter(m.instancia_id == resolved_inst_id)
            elif allowed is not None:
                q_novas = q_novas.filter(m.instancia_id.in_([int(x) for x in allowed]))

            for cid, cnt in q_novas.group_by(m.cliente_id).all():
                novas_map[int(cid)] = int(cnt)

        deleted_set = set(_cache_get_json(_k_deleted(empresa_id)) or [])
        if _has_model_pinned():
            pins_user = _pins_get_cached(db, int(empresa_id), user_id)
        else:
            pins_user = set(_cache_get_json(_k_pin(empresa_id)) or [])

        items = []
        for cid, mid in pairs:
            if int(cid) in deleted_set:
                continue
            c = clientes.get(int(cid))
            msg = msgs.get(int(mid))
            if not c or not msg:
                continue

            ts_iso = msg.timestamp.isoformat() if msg.timestamp else None

            items.append(
                {
                    "id": c.id,
                    "conversation_id": c.id,
                    "cliente_id": c.id,
                    "nome": getattr(c, "nome_whatsapp", None) or c.nome,
                    "telefone": c.telefone,
                    # AQUI: nunca manda pps.whatsapp.net pro front
                    "avatar_url": _public_avatar_url(int(c.id), getattr(c, "avatar_url", None)),
                    "ultima_msg_id": msg.id,
                    "ultima_mensagem": msg.conteudo or "",
                    "hora": ts_iso,
                    "last_ts": ts_iso,
                    "novas": novas_map.get(int(c.id), 0),
                    "last_tipo": msg.tipo,
                    "last_ack": int(getattr(msg, "ack", 0)) if msg.tipo == "saida" else None,
                    "instancia_id": getattr(msg, "instancia_id", None),
                    "pinned": int(cid) in pins_user,
                }
            )

        items_p = [it for it in items if it.get("pinned")]
        items_o = [it for it in items if not it.get("pinned")]
        items = items_p + items_o

        next_cursor = int(pairs[-1][1]) if pairs else None
        payload = {"items": items, "next_cursor": next_cursor}

        _cache_set_json(cache_key, payload)
        return payload

    except HTTPException:
        raise
    except Exception as e:
        LOG("[/conversas][ERRO]", repr(e))
        raise HTTPException(status_code=500, detail="Falha ao listar conversas")


# =========================================================
# Legado: lista de clientes (sem paginação)
# =========================================================
@router.get("/clientes")
def listar_clientes(
    empresa_id: int,
    departamento: Optional[str] = None,
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
):
    empresa_id = _assert_empresa_user(identity, empresa_id)
    _ensure_perm(identity, "atendimento.ver")

    allowed = _allowed_instancia_ids(db, identity, empresa_id)

    LOG("[clientes] Listando clientes para empresa_id", empresa_id)

    cache_key = _k("clientes", "emp", str(empresa_id), "dep", str(departamento or ""))
    cached = _cache_get_json(cache_key)
    if cached:
        deleted_set = set(_cache_get_json(_k_deleted(empresa_id)) or [])
        if deleted_set:
            cached = [it for it in cached if int(it.get("id")) not in deleted_set]
        # GARANTE: avatar_url sempre proxy local
        for it in cached:
            it["avatar_url"] = _public_avatar_url(int(it.get("id") or it.get("cliente_id") or 0), it.get("avatar_url"))
        return cached

    m = models.Mensagem

    subq_q = (
        db.query(
            m.cliente_id,
            func.max(m.timestamp).label("ultima_data"),
        )
        .filter(m.empresa_id == empresa_id)
    )

    # aplica ACL por instância no legado também
    if allowed is not None:
        if not allowed:
            _cache_set_json(cache_key, [])
            return []
        subq_q = subq_q.filter(m.instancia_id.in_([int(x) for x in allowed]))

    subq = subq_q.group_by(m.cliente_id).subquery()

    q = (
        db.query(models.Cliente)
        .outerjoin(subq, models.Cliente.id == subq.c.cliente_id)
        .filter(models.Cliente.empresa_id == empresa_id)
        .filter(subq.c.ultima_data.isnot(None))
    )
    if departamento:
        q = q.filter(models.Cliente.departamento == departamento)

    q = q.order_by(subq.c.ultima_data.desc().nullslast())

    deleted_set = set(_cache_get_json(_k_deleted(empresa_id)) or [])

    resultado = []
    for c in q.all():
        if int(c.id) in deleted_set:
            continue

        ultima_q = (
            db.query(m)
            .filter(
                m.cliente_id == c.id,
                m.empresa_id == empresa_id,
            )
        )
        if allowed is not None:
            ultima_q = ultima_q.filter(m.instancia_id.in_([int(x) for x in allowed]))

        ultima = ultima_q.order_by(m.timestamp.desc()).first()

        novas_q = (
            db.query(m)
            .filter(
                m.cliente_id == c.id,
                m.empresa_id == empresa_id,
                m.tipo == "entrada",
                m.lida == False,  # noqa: E712
            )
        )
        if allowed is not None:
            novas_q = novas_q.filter(m.instancia_id.in_([int(x) for x in allowed]))
        novas = novas_q.count()

        ultima_ts_ms = int(ultima.timestamp.timestamp() * 1000) if (ultima and ultima.timestamp) else None

        resultado.append(
            {
                "id": c.id,
                "nome": getattr(c, "nome_whatsapp", None) or c.nome,
                "telefone": c.telefone,
                # AQUI: nunca manda pps.whatsapp.net pro front
                "avatar_url": _public_avatar_url(int(c.id), getattr(c, "avatar_url", None)),
                "ultima_mensagem": (ultima.conteudo or "") if ultima else "",
                "hora": ultima_ts_ms,
                "last_ts": ultima_ts_ms,
                "novas": novas,
                "last_tipo": ultima.tipo if ultima else None,
                "last_ack": int(getattr(ultima, "ack", 0)) if (ultima and ultima.tipo == "saida") else None,
            }
        )

    LOG(f"[clientes] Retornando {len(resultado)} clientes.")

    _cache_set_json(cache_key, resultado)
    return resultado


# =========================================================
# Marcar mensagens de ENTRADA como lidas + avisar UIs
# =========================================================
@router.post("/clientes/{cliente_id}/seen")
async def marcar_lidas(
    cliente_id: int,
    empresa_id: int = Query(...),
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
):
    empresa_id = _assert_empresa_user(identity, empresa_id)
    _ensure_perm(identity, "atendimento.ver")

    allowed = _allowed_instancia_ids(db, identity, empresa_id)
    _assert_cliente_access_by_instancias(db, empresa_id=empresa_id, cliente_id=cliente_id, allowed=allowed)

    q = (
        db.query(models.Mensagem)
        .filter(
            models.Mensagem.cliente_id == cliente_id,
            models.Mensagem.empresa_id == empresa_id,
            models.Mensagem.tipo == "entrada",
            models.Mensagem.lida == False,  # noqa: E712
        )
    )
    if allowed is not None:
        q = q.filter(models.Mensagem.instancia_id.in_([int(x) for x in allowed]))

    total = q.update({models.Mensagem.lida: True}, synchronize_session=False)
    db.commit()

    _cache_del(_k("clientes", "emp", str(empresa_id), "dep", ""))
    _cache_del_pattern(_k("conv", "list", "emp", str(empresa_id)))

    await conexoes_ativas.send_message(f"emp:{empresa_id}", {"type": "reload_clientes"})
    return {"ok": True, "marcadas": int(total)}


# =========================================================
# Conversas: pins / labels / delete
# =========================================================

@router.get("/conversas/pin")
def listar_pins(
    empresa_id: int = Query(...),
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
):
    empresa_id = _assert_empresa_user(identity, empresa_id)
    _ensure_perm(identity, "atendimento.ver")

    if _has_model_pinned():
        pinned = _pins_get_cached(db, empresa_id=int(empresa_id), user_id=int(identity["id"]))
        return {"pinned": sorted(pinned)}

    pinned = _cache_get_json(_k_pin(empresa_id)) or []
    return {"pinned": _ensure_list(pinned)}


@router.post("/conversas/{cliente_id}/pin")
def fixar_conversa(
    cliente_id: int,
    empresa_id: int = Query(...),
    payload: dict = Body(...),
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
):
    empresa_id = _assert_empresa_user(identity, empresa_id)
    _ensure_perm(identity, "atendimento.ver")

    allowed = _allowed_instancia_ids(db, identity, empresa_id)
    _assert_cliente_access_by_instancias(db, empresa_id=empresa_id, cliente_id=cliente_id, allowed=allowed)

    want_pin = bool(payload.get("pin", True))
    user_id = int(identity["id"])

    if _has_model_pinned():
        if want_pin:
            exists = (
                db.query(models.AtendimentoPinnedConversa)
                .filter(
                    models.AtendimentoPinnedConversa.empresa_id == int(empresa_id),
                    models.AtendimentoPinnedConversa.user_id == user_id,
                    models.AtendimentoPinnedConversa.conversa_id == int(cliente_id),
                )
                .first()
            )
            if not exists:
                db.add(
                    models.AtendimentoPinnedConversa(
                        empresa_id=int(empresa_id),
                        user_id=user_id,
                        conversa_id=int(cliente_id),
                    )
                )
                db.commit()
            s = _pins_get_cached(db, int(empresa_id), user_id)
            s.add(int(cliente_id))
            _pins_put_cached(int(empresa_id), user_id, s)
        else:
            db.query(models.AtendimentoPinnedConversa).filter(
                models.AtendimentoPinnedConversa.empresa_id == int(empresa_id),
                models.AtendimentoPinnedConversa.user_id == user_id,
                models.AtendimentoPinnedConversa.conversa_id == int(cliente_id),
            ).delete(synchronize_session=False)
            db.commit()
            s = _pins_get_cached(db, int(empresa_id), user_id)
            if int(cliente_id) in s:
                s.discard(int(cliente_id))
                _pins_put_cached(int(empresa_id), user_id, s)

        _cache_del(_k_pin(empresa_id))
    else:
        pinned = set(_cache_get_json(_k_pin(empresa_id)) or [])
        if want_pin:
            pinned.add(int(cliente_id))
        else:
            pinned.discard(int(cliente_id))
        _cache_set_json(_k_pin(empresa_id), list(pinned), ttl=7 * 24 * 3600)

    _cache_del_pattern(_k("conv", "list", "emp", str(empresa_id)))

    try:
        asyncio.create_task(
            _broadcast(
                {"type": "conv.pin", "cliente_id": int(cliente_id), "pin": want_pin, "user_id": user_id},
                empresa_id=empresa_id,
            )
        )
    except Exception:
        pass

    return {"ok": True, "pinned": want_pin}


@router.get("/conversas/deleted")
def listar_deletados(
    empresa_id: int = Query(...),
    identity=Depends(get_current_identity),
):
    empresa_id = _assert_empresa_user(identity, empresa_id)
    _ensure_perm(identity, "atendimento.ver")

    deleted = _cache_get_json(_k_deleted(empresa_id)) or []
    return {"deleted": _ensure_list(deleted)}


@router.delete("/conversas/{cliente_id}")
def apagar_conversa(
    cliente_id: int,
    empresa_id: int = Query(...),
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
):
    empresa_id = _assert_empresa_user(identity, empresa_id)
    _ensure_perm(identity, "atendimento.ver")

    # manter como admin-only como era
    if not _is_admin(identity):
        raise HTTPException(403, "Apenas administradores")

    deleted = set(_cache_get_json(_k_deleted(empresa_id)) or [])
    deleted.add(int(cliente_id))
    _cache_set_json(_k_deleted(empresa_id), list(deleted), ttl=7 * 24 * 3600)

    try:
        if _has_model_pinned():
            db.query(models.AtendimentoPinnedConversa).filter(
                models.AtendimentoPinnedConversa.empresa_id == int(empresa_id),
                models.AtendimentoPinnedConversa.conversa_id == int(cliente_id),
            ).delete(synchronize_session=False)
            db.commit()
            _cache_del_pattern(_k("conv", "pin", "emp", str(empresa_id)))
    except Exception:
        pass

    _cache_del_pattern(_k("conv", "list", "emp", str(empresa_id)))
    _cache_del(_k("clientes", "emp", str(empresa_id), "dep", ""))
    try:
        asyncio.create_task(_broadcast({"type": "conv.deleted", "cliente_id": int(cliente_id)}, empresa_id=empresa_id))
    except Exception:
        pass
    return {"ok": True, "deleted": list(deleted)}


@router.delete("/conversas/{cliente_id}/permanente")
def apagar_conversa_permanente(
    cliente_id: int,
    empresa_id: int = Query(...),
    db: Session = Depends(get_db),
    identity: dict = Depends(get_current_identity),
):
    empresa_id = _assert_empresa_user(identity, empresa_id)

    perms = set(identity.get("permissoes") or [])
    is_admin = bool(identity.get("is_admin") or identity.get("admin"))
    if not (is_admin or "atendimento.apagar_conversas" in perms):
        raise HTTPException(status_code=403, detail="Sem permissão para apagar conversas")

    # ACL por instância: se colaborador, não pode hard delete fora do escopo
    allowed = _allowed_instancia_ids(db, identity, empresa_id)
    _assert_cliente_access_by_instancias(db, empresa_id=empresa_id, cliente_id=cliente_id, allowed=allowed)

    cliente = (
        db.query(models.Cliente)
        .filter(
            models.Cliente.id == cliente_id,
            models.Cliente.empresa_id == empresa_id,
        )
        .first()
    )
    if not cliente:
        raise HTTPException(status_code=404, detail="Cliente não encontrado")

    db.query(models.Midia).filter(
        models.Midia.empresa_id == empresa_id,
        models.Midia.cliente_id == cliente_id,
    ).delete(synchronize_session=False)

    q_msg = db.query(models.Mensagem).filter(
        models.Mensagem.empresa_id == empresa_id,
        models.Mensagem.cliente_id == cliente_id,
    )
    if allowed is not None:
        q_msg = q_msg.filter(models.Mensagem.instancia_id.in_([int(x) for x in allowed]))
    q_msg.delete(synchronize_session=False)

    db.query(models.Atendimento).filter(models.Atendimento.cliente_id == cliente_id).delete(synchronize_session=False)

    try:
        if _has_model_pinned():
            db.query(models.AtendimentoPinnedConversa).filter(
                models.AtendimentoPinnedConversa.empresa_id == int(empresa_id),
                models.AtendimentoPinnedConversa.conversa_id == int(cliente_id),
            ).delete(synchronize_session=False)
    except Exception:
        pass

    db.delete(cliente)
    db.commit()

    try:
        deleted = set(_cache_get_json(_k_deleted(empresa_id)) or [])
        if int(cliente_id) in deleted:
            deleted.discard(int(cliente_id))
            _cache_set_json(_k_deleted(empresa_id), list(deleted), ttl=7 * 24 * 3600)

        _cache_del_pattern(_k("conv", "pin", "emp", str(empresa_id)))
        _cache_del_pattern(_k("conv", "list", "emp", str(empresa_id)))
        _cache_del(_k("clientes", "emp", str(empresa_id), "dep", ""))
    except Exception:
        pass

    try:
        asyncio.create_task(_broadcast({"type": "conv.hard_deleted", "cliente_id": int(cliente_id)}, empresa_id=empresa_id))
    except Exception:
        pass

    return {"ok": True, "deleted_permanente": True}


class LabelsIn(BaseModel):
    add: Optional[str] = None
    set: Optional[List[str]] = None
    color: Optional[str] = None
    color_hex: Optional[str] = None


@router.get("/conversas/{cliente_id}/labels")
def obter_etiquetas(
    cliente_id: int,
    empresa_id: int = Query(...),
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
):
    empresa_id = _assert_empresa_user(identity, empresa_id)
    _ensure_perm(identity, "atendimento.ver")

    allowed = _allowed_instancia_ids(db, identity, empresa_id)
    _assert_cliente_access_by_instancias(db, empresa_id=empresa_id, cliente_id=cliente_id, allowed=allowed)

    if _has_model_labels():
        rows = _labels_db_list(db, empresa_id=int(empresa_id), cliente_id=int(cliente_id))
        labels = [r["name"] for r in rows]
        return {"labels": labels, "labels_ex": rows}

    key = _k_labels(empresa_id, cliente_id)
    labels = _cache_get_json(key) or []
    labels = _ensure_list(labels)
    return {"labels": labels, "labels_ex": [{"name": s, "color_hex": None} for s in labels]}


@router.post("/conversas/{cliente_id}/labels")
def etiquetar_conversa(
    cliente_id: int,
    empresa_id: int = Query(...),
    body: LabelsIn = Body(...),
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
):
    empresa_id = _assert_empresa_user(identity, empresa_id)
    _ensure_perm(identity, "atendimento.ver")

    # mantém admin-only (como legado)
    if not _is_admin(identity):
        raise HTTPException(403, "Apenas administradores")

    allowed = _allowed_instancia_ids(db, identity, empresa_id)
    _assert_cliente_access_by_instancias(db, empresa_id=empresa_id, cliente_id=cliente_id, allowed=allowed)

    user_id = int(identity["id"])

    if _has_model_labels():
        if body.set is not None:
            _labels_db_replace_all(db, int(empresa_id), int(cliente_id), body.set, user_id)
            rows = _labels_db_list(db, int(empresa_id), int(cliente_id))
            try:
                asyncio.create_task(
                    _broadcast(
                        {"type": "conv.labels", "cliente_id": int(cliente_id), "labels": [r["name"] for r in rows], "labels_ex": rows},
                        empresa_id=empresa_id,
                    )
                )
            except Exception:
                pass
            return {"ok": True, "labels": [r["name"] for r in rows], "labels_ex": rows}

        if body.add:
            name = (body.add or "").strip()
            if not name:
                raise HTTPException(400, "Nome de etiqueta inválido")
            color_hex = _normalize_hex(body.color_hex or body.color)
            _labels_db_upsert(db, int(empresa_id), int(cliente_id), name, color_hex, user_id)
            rows = _labels_db_list(db, int(empresa_id), int(cliente_id))
            try:
                asyncio.create_task(
                    _broadcast(
                        {"type": "conv.labels", "cliente_id": int(cliente_id), "labels": [r["name"] for r in rows], "labels_ex": rows},
                        empresa_id=empresa_id,
                    )
                )
            except Exception:
                pass
            return {"ok": True, "labels": [r["name"] for r in rows], "labels_ex": rows}

        raise HTTPException(400, "Informe 'add' ou 'set'.")

    key = _k_labels(empresa_id, cliente_id)
    labels = _cache_get_json(key) or []
    labels = [s for s in labels if isinstance(s, str)]
    if body.set is not None:
        labels = [s for s in (body.set or []) if isinstance(s, str) and s.strip()]
    elif body.add:
        lab = body.add.strip()
        if lab and lab not in labels:
            labels.append(lab)
    else:
        raise HTTPException(400, "Informe 'add' ou 'set'.")

    _cache_set_json(key, labels, ttl=30 * 24 * 3600)
    try:
        asyncio.create_task(
            _broadcast(
                {"type": "conv.labels", "cliente_id": int(cliente_id), "labels": labels, "labels_ex": [{"name": s, "color_hex": None} for s in labels]},
                empresa_id=empresa_id,
            )
        )
    except Exception:
        pass
    return {"ok": True, "labels": labels, "labels_ex": [{"name": s, "color_hex": None} for s in labels]}