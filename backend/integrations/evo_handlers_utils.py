# backend/integrations/evo_handlers_utils.py
from __future__ import annotations

import os, re, json, asyncio, mimetypes, requests, random
from enum import StrEnum, auto
from typing import Callable, Awaitable, Any
from datetime import datetime, timedelta, timezone

from sqlalchemy.orm import Session
from sqlalchemy import text, func, String
from sqlalchemy.exc import IntegrityError

from backend.database import SessionLocal
from backend import models
from backend.integrations.qrcode import qr_sign, qr_should_emit
from backend.websocket_manager import conexoes_ativas
from backend.models import StatusAtendimento
from backend.routers.cliente_onboarding import cancel_auto_cleanup

from .evo_handlers_extract import _b64_to_bytes, normalize_mimetype


# =========================
# Config / ENV
# =========================
EVOLUTION_URL = (os.getenv("EVOLUTION_URL") or "").rstrip("/")
EVOLUTION_KEY = os.getenv("EVOLUTION_APIKEY") or os.getenv("EVOLUTION_KEY")
HEADERS = {"apikey": EVOLUTION_KEY, "Content-Type": "application/json"} if EVOLUTION_KEY else {}

SYNC_CONTACTS_ON_CONNECT = (os.getenv("SYNC_CONTACTS_ON_CONNECT", "true").lower() == "true")
SYNC_CHATS_ON_CONNECT    = (os.getenv("SYNC_CHATS_ON_CONNECT", "true").lower() == "true")
ENABLE_MESSAGES_SET      = (os.getenv("ENABLE_MESSAGES_SET", "true").lower() == "true")

EVOLUTION_FORCE_QR_ON_WS = (os.getenv("EVOLUTION_FORCE_QR_ON_WS", "true").lower() == "true")

HISTORY_LIMIT_HOURS           = int(os.getenv("HISTORY_LIMIT_HOURS", "0") or "0")
HISTORY_IGNORE_AFTER_DONE_MIN = int(os.getenv("HISTORY_IGNORE_AFTER_DONE_MIN", "15") or "15")

APP_TZ_NAME = os.getenv("APP_TZ") or os.getenv("TZ") or "America/Sao_Paulo"
try:
    from zoneinfo import ZoneInfo
    APP_TZ = ZoneInfo(APP_TZ_NAME)
except Exception:
    APP_TZ = timezone.utc

ALLOW_HISTORY_7D          = (os.getenv("ALLOW_HISTORY_7D", "false").lower() == "true")
HISTORY_MAX_IMPORT        = int(os.getenv("HISTORY_MAX_IMPORT", "3000") or "3000")
HISTORY_BATCH_COMMIT      = int(os.getenv("HISTORY_BATCH_COMMIT", "250") or "250")
HISTORY_SLEEP_EVERY       = int(os.getenv("HISTORY_SLEEP_EVERY", "500") or "500")
DISABLE_MEDIA_ON_HISTORY  = (os.getenv("DISABLE_MEDIA_ON_HISTORY", "true").lower() == "true")

FULL_EVENTS_WS = [
    "QRCODE_UPDATED",
    "CONNECTION_UPDATE",
]

FULL_EVENTS_RABBIT = [
    "MESSAGES_SET",
    "MESSAGES_UPSERT",
    "MESSAGES_UPDATE",
    "MESSAGES_DELETE",
    "SEND_MESSAGE",
    "PRESENCE_UPDATE",
    "GROUPS_UPSERT",
    "GROUPS_UPDATE",
    "GROUP_PARTICIPANTS_UPDATE",
    "CONTACTS_SET",
    "CONTACTS_UPSERT",
    "CONTACTS_UPDATE",
    "NEW_TOKEN",
    "LOGOUT_INSTANCE",
    "INSTANCE_DELETE",
    "REMOVE_INSTANCE",
]

RABBIT_EXCHANGE = os.getenv("RABBITMQ_EXCHANGE_NAME", "evolution_exchange")
RABBIT_BINDINGS = [b.strip() for b in (os.getenv("RABBITMQ_BINDINGS", "#") or "#").split(",") if b.strip()]

# =========================
# N8N webhook config
# =========================
N8N_WEBHOOK_BASE_URL = (
    os.getenv("N8N_WEBHOOK_BASE_URL")
    or os.getenv("N8N_CHATBOT_WEBHOOK_URL")
    or ""
).strip()

N8N_CHATBOT_GERAL_PATH   = (os.getenv("N8N_CHATBOT_GERAL_PATH")   or "chatbot-zapchats-geral").strip().strip("/")
N8N_CHATBOT_SETORES_PATH = (os.getenv("N8N_CHATBOT_SETORES_PATH") or "chatbot-zapchats-setores").strip().strip("/")
N8N_MESSAGES_UPSERT_PATH = (os.getenv("N8N_MESSAGES_UPSERT_PATH") or "chatbot-zapchats").strip().strip("/")


def _n8n_url(base_or_full: str, *, path: str) -> str:
    v = (base_or_full or "").strip()
    if not v:
        return ""
    v = v.rstrip("/")
    if v.lower().endswith("/webhook"):
        return f"{v}/{path.lstrip('/')}"
    return v


def _chatbot_mode_from_db(*, empresa_id: int, instancia_id: int | None) -> str:
    if not instancia_id:
        return "geral"
    try:
        with SessionLocal() as db:
            row = db.execute(
                text(
                    """
                    SELECT
                      COALESCE((config->'features'->'auto_messages_departments'->>'enabled')::boolean, FALSE) AS dep_enabled
                    FROM chatbot_configs
                    WHERE empresa_id=:emp AND instancia_id=:inst AND ativo=TRUE
                    ORDER BY atualizado_em DESC
                    LIMIT 1
                    """
                ),
                {"emp": int(empresa_id), "inst": int(instancia_id)},
            ).mappings().first()
        if row and bool(row.get("dep_enabled")):
            return "setores"
    except Exception:
        pass
    return "geral"


def _notify_n8n_chatbot(*, empresa_id: int, instancia_id: int, jid: str, numero: str, texto: str, direcao: str):
    base = N8N_WEBHOOK_BASE_URL
    if not base:
        return

    modo = _chatbot_mode_from_db(empresa_id=empresa_id, instancia_id=instancia_id)
    path = N8N_CHATBOT_SETORES_PATH if modo == "setores" else N8N_CHATBOT_GERAL_PATH
    url = _n8n_url(base, path=path)
    if not url:
        return

    payload = {
        "empresa_id": empresa_id,
        "instancia_id": instancia_id,
        "jid": jid,
        "numero": numero,
        "texto": texto,
        "direction": direcao,
        "modo": modo,
    }

    try:
        requests.post(url, json=payload, timeout=5)
    except Exception as e:
        try:
            LOG(f"[N8N][chatbot] erro ao chamar {url}: {e}")
        except Exception:
            pass


# =========================
# Deadlock/timeout helpers
# =========================
try:
    from psycopg2.errors import DeadlockDetected as _PGDeadlock, QueryCanceled as _PGQueryCanceled
except Exception:
    _PGDeadlock = None
    _PGQueryCanceled = None


def _is_deadlock_error(e: Exception) -> bool:
    base = getattr(e, "orig", e)
    msg = str(base).lower()

    if _PGDeadlock and isinstance(base, _PGDeadlock):
        return True
    if _PGQueryCanceled and isinstance(base, _PGQueryCanceled):
        return True

    return (
        "deadlock detected" in msg
        or "statement timeout" in msg
        or "canceling statement due to statement timeout" in msg
    )


def _try_acquire_hist_lock(db: Session, empresa_id: int, instancia_id: int) -> bool:
    try:
        return bool(
            db.execute(
                text("SELECT pg_try_advisory_lock(:a, :b)"),
                {"a": int(empresa_id), "b": int(instancia_id)},
            ).scalar()
        )
    except Exception:
        return True


def _release_hist_lock(db: Session, empresa_id: int, instancia_id: int) -> None:
    try:
        db.execute(
            text("SELECT pg_advisory_unlock(:a, :b)"),
            {"a": int(empresa_id), "b": int(instancia_id)},
        )
    except Exception:
        pass


async def _retry_deadlock(db: Session, func, *, attempts: int = 5, base_delay: float = 0.02):
    for i in range(attempts):
        try:
            return func()
        except Exception as e:
            if _is_deadlock_error(e):
                try:
                    db.rollback()
                except Exception:
                    pass
                wait = base_delay * (2 ** i) + random.random() * 0.01
                await asyncio.sleep(wait)
                continue
            raise


# =========================
# Log util (prefix fixo)
# =========================
def LOG(*args): print("[EVO]", *args)


# =========================
# Datas / Horários helpers
# =========================
def _now_utc() -> datetime:
    return datetime.now(timezone.utc)

def _server_ts_ms() -> int:
    return int(_now_utc().timestamp() * 1000)

def _to_dt_utc(ts_like) -> datetime:
    if ts_like is None:
        return _now_utc()
    try:
        s = str(ts_like).strip()
        if not s:
            return _now_utc()
        if "." in s:
            val = float(s)
        else:
            val = int(s)
        if isinstance(val, float):
            secs = val
        else:
            if val > 10**14:
                secs = val / 1_000_000
            elif val > 10**11:
                secs = val / 1_000
            else:
                secs = float(val)
        return datetime.fromtimestamp(secs, tz=timezone.utc)
    except Exception:
        return _now_utc()

def _iso_utc(dt: datetime) -> str:
    try:
        return dt.astimezone(timezone.utc).isoformat(timespec="microseconds")
    except Exception:
        return dt.replace(tzinfo=timezone.utc).isoformat(timespec="microseconds")

def _iso_local(dt: datetime) -> str:
    try:
        return dt.astimezone(APP_TZ).isoformat(timespec="microseconds")
    except Exception:
        return _iso_utc(dt)

def _int_unix(dt: datetime) -> int:
    try:
        return int(dt.timestamp())
    except Exception:
        return int(_now_utc().timestamp())


# =========================
# Rabbit monitor (exportado)
# =========================
_RABBIT_MONITOR = {"last_event_at": None, "last_by_event": {}, "last_by_instance": {}}
def _utcnow_iso() -> str: return _now_utc().isoformat()

def record_rabbit_event(event_name: str, instance: str | None):
    ts = _utcnow_iso()
    _RABBIT_MONITOR["last_event_at"] = ts
    _RABBIT_MONITOR["last_by_event"][event_name] = ts
    if instance:
        _RABBIT_MONITOR["last_by_instance"][instance] = ts

def get_rabbit_monitor() -> dict:
    return _RABBIT_MONITOR

RABBIT_MONITOR = _RABBIT_MONITOR


# =========================
# Cache (Redis) – helpers
# =========================
try:
    from backend.cache.redis_client import (
        k as _rk,
        get_json as _rget,
        set_json as _rset,
        delete_key as _rdel,
        delete_prefix as _rdelpat,
    )
except Exception:
    def _rk(*parts: str) -> str:
        return ":".join([str(p) for p in parts if p is not None and p != ""])
    def _rget(_): return None
    def _rset(*_a, **_k): pass
    def _rdel(*_a, **_k): pass
    def _rdelpat(*_a, **_k): pass


def _invalidate_emp_cache(emp_id: int):
    try:
        _rdelpat(_rk("conv", "list", "emp", str(emp_id)))
        _rdel(_rk("clientes", "emp", str(emp_id), "dep", ""))
    except Exception:
        pass


# =========================
# Evolution events registry
# =========================
class EvoEvent(StrEnum):
    APPLICATION_STARTUP = auto()
    QRCODE_UPDATED = auto()
    CONNECTION_UPDATE = auto()
    MESSAGES_SET = auto()
    MESSAGES_UPSERT = auto()
    MESSAGES_UPDATE = auto()
    MESSAGES_DELETE = auto()
    SEND_MESSAGE = auto()
    CONTACTS_SET = auto()
    CONTACTS_UPSERT = auto()
    CONTACTS_UPDATE = auto()
    PRESENCE_UPDATE = auto()
    GROUPS_UPSERT = auto()
    GROUPS_UPDATE = auto()
    GROUP_UPDATE = auto()
    GROUP_PARTICIPANTS_UPDATE = auto()
    NEW_TOKEN = auto()
    CALL = auto()
    LOGOUT_INSTANCE = auto()
    INSTANCE_DELETE = auto()
    REMOVE_INSTANCE = auto()


HANDLERS: dict[EvoEvent, Callable[[str, dict], Awaitable[None]]] = {}

def handler(evt: EvoEvent):
    def deco(fn):
        HANDLERS[evt] = fn
        return fn
    return deco


# =========================
# Debug / Log helpers
# =========================
EVO_DEBUG_MESSAGES = (os.getenv("EVO_DEBUG_MESSAGES", "true").lower() == "true")

def _short(x, n: int = 140) -> str:
    try:
        s = str(x if x is not None else "")
    except Exception:
        s = repr(x)
    return (s[:n] + "…") if len(s) > n else s

def _dbg_enabled() -> bool:
    return EVO_DEBUG_MESSAGES

def _log_ctx(prefix: str, **ctx):
    if not _dbg_enabled():
        return
    parts = []
    for k, v in ctx.items():
        if isinstance(v, (dict, list, tuple, set)):
            parts.append(f"{k}={_short(json.dumps(v, ensure_ascii=False), 160)}")
        else:
            parts.append(f"{k}={_short(v, 160)}")
    LOG(prefix, " | ".join(parts))

def _log_skip(why: str, **ctx):
    if not _dbg_enabled():
        return
    _log_ctx(f"[UPsert][skip] {why}", **ctx)


# =========================
# ACK helpers
# =========================
ACK_NONE=0; ACK_DELIVERED=1; ACK_READ=2

def _ack_from_status(status_or_ack) -> int:
    if status_or_ack is None:
        return ACK_NONE
    s = str(status_or_ack).strip().upper()
    if s in {"0", "PENDING"}:
        return ACK_NONE
    if s in {"1", "SERVER", "SERVER_ACK", "2", "DELIVERED", "DELIVERY_ACK"}:
        return ACK_DELIVERED
    if s in {"3", "READ", "READ_RECEIPT", "PLAYED", "VIEWED"}:
        return ACK_READ
    return ACK_NONE


# =========================
# Phone/JID helpers
# =========================
def _jid_strip_device(j: str | None) -> str:
    if not j:
        return ""
    base = str(j)
    if "@" in base:
        user, host = base.split("@", 1)
        user = user.split(":")[0]
        return f"{user}@{host}"
    return base.split(":")[0]


def normalizar_telefone(n: str) -> str | None:
    if not n:
        return None
    n = re.sub(r"\D", "", n)
    if n.startswith("0"):
        n = n[1:]
    if not n.startswith("55"):
        n = "55" + n
    ddd, restante = n[2:4], n[4:]
    if len(restante) == 8 and not restante.startswith("9"):
        restante = "9" + restante
    return f"55{ddd}{restante}"


def _is_lid_jid(j: str | None) -> bool:
    return isinstance(j, str) and j.endswith("@lid")


def _remote_to_num(remote_jid: str | None) -> str | None:
    if not remote_jid:
        return None
    base = _jid_strip_device(remote_jid)

    if base.endswith("@g.us"):
        return None
    if base.endswith("@lid"):
        return None

    user = base.split("@", 1)[0]
    return normalizar_telefone(user)


def _resolve_counterparty_num_1to1(data: dict, me_num: str | None) -> tuple[str | None, str | None]:
    if not isinstance(data, dict):
        return None, None

    key = data.get("key") or {}

    remote_jid = (
        key.get("remoteJid") or key.get("remote_jid") or
        data.get("remoteJid") or data.get("jid") or data.get("chatId")
    )

    def _num_of(jid_like: str | None) -> str | None:
        return _remote_to_num(jid_like if isinstance(jid_like, str) else None)

    tel = _num_of(remote_jid)
    if tel and (not me_num or tel != me_num) and not _is_lid_jid(remote_jid):
        return tel, remote_jid

    alt_fields = (
        "remoteJidAlt",
        "remote_jid_alt",
        "senderPn",
        "senderpn",
        "participant",
        "author",
        "from",
        "sender",
        "user",
        "source",
    )

    def _first_str_from_obj(o: dict) -> str | None:
        prefer_keys = ["phone","phoneNumber","number","senderPn","senderpn"]
        jid_like_keys = ["user","from","peer","participant","jid","wid","remoteJid","remote_jid","chatId","chat_id"]
        fallback_keys = ["id"]

        for key_group in (prefer_keys, jid_like_keys, fallback_keys):
            for k2 in key_group:
                v2 = o.get(k2)
                if isinstance(v2, str) and v2.strip():
                    return v2.strip()
        return None

    for field in alt_fields:
        alt = key.get(field) or data.get(field)
        cand = alt if isinstance(alt, str) else (_first_str_from_obj(alt) if isinstance(alt, dict) else None)
        alt_num = _num_of(cand)
        if alt_num and alt_num != me_num:
            return alt_num, cand

    return (tel if tel else None), (remote_jid if isinstance(remote_jid, str) else None)


def formatar_telefone_br(n: str) -> str:
    d = re.sub(r"\D", "", str(n or ""))

    if len(d) in (10, 11):
        d = "55" + d

    if len(d) == 13:
        return f"+{d[:2]} {d[2:4]} {d[4:9]}-{d[9:]}"
    if len(d) == 12:
        return f"+{d[:2]} {d[2:4]} {d[4:8]}-{d[8:]}"
    return f"+{d}" if d else ""


def _br_tel_norm_for_upsert(raw: str | None) -> str | None:
    """
    Retorna telefone_norm em 10/11 dígitos (sem DDI), ex: 11987654321
    (Usado pra chave única (empresa_id, telefone_norm).)
    """
    if not raw:
        return None
    s = str(raw)
    if "@" in s:
        return None

    d = re.sub(r"\D", "", s)
    d = d.lstrip("0")

    while d.startswith("55") and len(d) > 11:
        d = d[2:]

    if len(d) > 11:
        d = d[-11:]

    if len(d) in (10, 11):
        return d

    return None


# =========================
# Cliente UPSERT (FIX)
# =========================
UPSERT_CLIENTE_SQL = text("""
  INSERT INTO public.clientes
    (empresa_id, instancia_id, telefone, nome, nome_whatsapp, avatar_url)
  VALUES
    (:empresa_id, :instancia_id, :telefone, :nome, :nome_whatsapp, :avatar_url)
  ON CONFLICT (empresa_id, telefone_norm) DO UPDATE
  SET
    instancia_id   = COALESCE(public.clientes.instancia_id, EXCLUDED.instancia_id),
    nome_whatsapp  = COALESCE(public.clientes.nome_whatsapp, EXCLUDED.nome_whatsapp),
    nome           = COALESCE(public.clientes.nome,          EXCLUDED.nome),
    avatar_url     = COALESCE(public.clientes.avatar_url,    EXCLUDED.avatar_url)
  RETURNING id;
""")

def upsert_cliente(
    db: Session, *,
    empresa_id: int,
    instancia_id: int | None,
    telefone_raw: str | None,
    nome: str | None = None,
    nome_whatsapp: str | None = None,
    avatar_url: str | None = None
) -> int | None:
    """
    UPSERT seguro com telefone_norm GENERATED:
      - NÃO inserimos telefone_norm (o banco calcula)
      - ainda calculamos tel_norm só pra fallback de lookup
    """
    tel_norm = _br_tel_norm_for_upsert(telefone_raw)
    if not tel_norm:
        return None


def _fetch_cliente(db: Session, cliente_id: int) -> models.Cliente | None:
    try:
        return db.query(models.Cliente).filter(models.Cliente.id == cliente_id).first()
    except Exception:
        return None


# =========================
# Atendimento helpers
# =========================
def _mensagem_tem_campo_atendimento() -> bool:
    try:
        return hasattr(models.Mensagem, "atendimento_id")
    except Exception:
        return False

_HAS_MSG_ATD_FIELD = _mensagem_tem_campo_atendimento()

def _status_token(val) -> str | None:
    if val is None:
        return None
    raw = getattr(val, "value", val)
    return str(raw).lower()

def _get_or_open_atendimento(
    db: Session,
    *,
    empresa_id: int,
    instancia_id: int,
    cliente_id: int,
    direcao: str,
    ts_dt: datetime | None = None,
    operador_id: int | None = None,
):
    ts_dt = ts_dt or _now_utc()

    resolvido_tok = _status_token(StatusAtendimento.RESOLVIDO) or "resolvido"
    em_atd_tok    = _status_token(StatusAtendimento.EM_ATENDIMENTO) or "em_atendimento"
    novo_tok      = _status_token(StatusAtendimento.NOVO) or "novo"

    q = (
        db.query(models.Atendimento)
        .filter(
            models.Atendimento.cliente_id == cliente_id,
            models.Atendimento.instancia_id == instancia_id,
            func.lower(models.Atendimento.status.cast(String)) != resolvido_tok,
        )
    )

    if hasattr(models.Atendimento, "empresa_id"):
        q = q.filter(models.Atendimento.empresa_id == empresa_id)

    q = q.order_by(models.Atendimento.criado_em.desc())
    a = q.first()

    if not a:
        status_ini_tok = em_atd_tok if direcao == "saida" else novo_tok

        base_kwargs: dict[str, Any] = {
            "cliente_id": cliente_id,
            "instancia_id": instancia_id,
            "operador_id": (operador_id if direcao == "saida" else None),
            "status": status_ini_tok,
            "criado_em": ts_dt,
        }
        if hasattr(models.Atendimento, "empresa_id"):
            base_kwargs["empresa_id"] = empresa_id

        a = models.Atendimento(**base_kwargs)
        db.add(a)

        try:
            db.flush()
        except IntegrityError:
            db.rollback()
            a = q.first()
            if not a:
                a = models.Atendimento(**base_kwargs)
                db.add(a)
                db.flush()

    if direcao == "saida":
        try:
            if _status_token(getattr(a, "status", None)) != em_atd_tok:
                a.status = em_atd_tok
            if operador_id and not getattr(a, "operador_id", None):
                a.operador_id = operador_id
        except Exception:
            pass

    return a


# =========================
# LID resolver/cache
# =========================
_LID_CACHE: dict[str, dict[str, str]] = {}
_LID_REDIS_TTL = 172800

def _lid_map_key(emp_id: int, inst_db_id: int, lid: str) -> str:
    return _rk("lidmap", "emp", str(emp_id), "inst", str(inst_db_id), lid)

def _lid_pend_key(emp_id: int, inst_db_id: int, lid: str) -> str:
    return _rk("lidpend", "emp", str(emp_id), "inst", str(inst_db_id), lid)

def _lid_map_get(emp_id: int, inst_db_id: int, lid: str) -> str | None:
    v = _rget(_lid_map_key(emp_id, inst_db_id, lid))
    if not isinstance(v, str):
        return None

    base = _jid_strip_device(v)
    local = base.split("@", 1)[0]
    if local.startswith("LID-"):
        return None

    return v

def _lid_map_set(emp_id: int, inst_db_id: int, lid: str, wa_jid: str) -> None:
    _rset(_lid_map_key(emp_id, inst_db_id, lid), wa_jid, ttl=_LID_REDIS_TTL)

def _lid_pend_append(emp_id: int, inst_db_id: int, lid: str, item: dict) -> None:
    key = _lid_pend_key(emp_id, inst_db_id, lid)
    cur = _rget(key)
    if not isinstance(cur, list):
        cur = []
    cur.append(item)
    _rset(key, cur, ttl=_LID_REDIS_TTL)

def _lid_pend_takeall(emp_id: int, inst_db_id: int, lid: str) -> list[dict]:
    key = _lid_pend_key(emp_id, inst_db_id, lid)
    cur = _rget(key)
    if not isinstance(cur, list):
        cur = []
    _rset(key, [], ttl=_LID_REDIS_TTL)
    return cur


def _resolve_remote_jid(inst_id: str, raw_remote: str | None) -> str | None:
    s = _jid_strip_device(raw_remote or "")
    if not s:
        return None
    if s.endswith("@s.whatsapp.net") or s.endswith("@g.us"):
        return s
    if not s.endswith("@lid"):
        return s

    mapped = _LID_CACHE.get(inst_id, {}).get(s)
    if mapped:
        return mapped

    try:
        if not (EVOLUTION_URL and inst_id):
            return None

        sess = requests.Session()
        if HEADERS:
            sess.headers.update(HEADERS)

        def _collect_map(items: list[dict]):
            for ch in (items or []):
                if not isinstance(ch, dict):
                    continue
                vals = []
                for k in ("id", "remoteJid", "jid", "wid", "chatId"):
                    v = ch.get(k)
                    if isinstance(v, str):
                        vals.append(_jid_strip_device(v))
                lid = next((x for x in vals if isinstance(x, str) and x.endswith("@lid")), None)
                wa  = next((x for x in vals if isinstance(x, str) and x.endswith("@s.whatsapp.net")), None)
                if lid and wa:
                    _LID_CACHE.setdefault(inst_id, {})[lid] = wa

        try:
            r = sess.post(f"{EVOLUTION_URL}/chat/findChats/{inst_id}", json={"where": {"id": s}}, timeout=20)
            if r.ok:
                js = r.json()
                items = []
                if isinstance(js, list):
                    items = js
                elif isinstance(js, dict):
                    for k in ("chats","items","data","result","rows","list","payload","store"):
                        v = js.get(k)
                        if isinstance(v, list):
                            items = v
                            break
                    if not items:
                        items = [js]
                _collect_map(items)
        except Exception:
            pass

        if not _LID_CACHE.get(inst_id, {}).get(s):
            try:
                r = sess.post(f"{EVOLUTION_URL}/chat/findChats/{inst_id}", json={"where": {}}, timeout=20)
                if r.ok:
                    js = r.json()
                    items = []
                    if isinstance(js, list):
                        items = js
                    elif isinstance(js, dict):
                        for k in ("chats","items","data","result","rows","list","payload","store"):
                            v = js.get(k)
                            if isinstance(v, list):
                                items = v
                                break
                        if not items:
                            items = [js]
                    _collect_map(items)
            except Exception:
                pass

        if not _LID_CACHE.get(inst_id, {}).get(s):
            try:
                r = sess.post(f"{EVOLUTION_URL}/chat/findContacts/{inst_id}", json={"where": {}}, timeout=20)
                if r.ok:
                    js = r.json()
                    items = []
                    if isinstance(js, list):
                        items = js
                    elif isinstance(js, dict):
                        for k in ("contacts","items","data","result","rows","list","payload","store"):
                            v = js.get(k)
                            if isinstance(v, list):
                                items = v
                                break
                        if not items:
                            items = [js]
                    _collect_map(items)
            except Exception:
                pass

        return _LID_CACHE.get(inst_id, {}).get(s)
    except Exception as e:
        LOG(f"[LID] resolver falhou: {e}")
        return None


# =========================
# Instance helpers
# =========================
def _inst_from(payload) -> str | None:
    def _pick(d: dict | None):
        if not isinstance(d, dict):
            return None
        for k in ("instance", "instanceName", "instanceId"):
            v = d.get(k)
            if isinstance(v, str) and v.strip():
                return v.strip()
        return None

    if isinstance(payload, dict):
        v = _pick(payload)
        if v:
            return v
        v = _pick(payload.get("qrcode") if isinstance(payload.get("qrcode"), dict) else None)
        if v:
            return v
        data = payload.get("data")
        if isinstance(data, dict):
            v = _pick(data)
            if v:
                return v
            v = _pick(data.get("qrcode") if isinstance(data.get("qrcode"), dict) else None)
            if v:
                return v
        elif isinstance(data, list):
            for item in data:
                v = _pick(item if isinstance(item, dict) else None)
                if v:
                    return v
                if isinstance(item, dict) and isinstance(item.get("qrcode"), dict):
                    v = _pick(item.get("qrcode"))
                    if v:
                        return v
    return None


def _get_inst_row(db: Session, inst_name: str) -> models.EmpresaInstancia | None:
    return db.query(models.EmpresaInstancia).filter(models.EmpresaInstancia.instance_name == inst_name).first()

def _empresa_id_by_inst(db: Session, inst_name: str) -> int | None:
    row = _get_inst_row(db, inst_name)
    return int(row.empresa_id) if row else None

def _me_number_by_inst(row: models.EmpresaInstancia | None) -> str:
    if not row or not row.numero_instancia:
        return ""
    return normalizar_telefone(row.numero_instancia) or ""


def _carimbar_inst(obj, inst: models.EmpresaInstancia):
    if hasattr(obj, "instancia_id") and (getattr(obj, "instancia_id", None) is None):
        obj.instancia_id = inst.id
    if isinstance(obj, models.Grupo):
        if hasattr(obj, "instance_name") and not getattr(obj, "instance_name", None):
            obj.instance_name = inst.instance_name


# =========================
# QR helpers
# =========================
async def _emit_qr(inst_id: str, base64_img: str | None, pairing_code: str | None, limit: int | None = None):
    try:
        sign = qr_sign(base64_img=base64_img, pairing_code=pairing_code)
        if not qr_should_emit(inst_id, sign):
            LOG(f"[QR] dedup suprimido inst={inst_id}")
            return

        payload = {
            "type": "qrcode",
            "base64": base64_img or "",
            "pairingCode": pairing_code,
            "instance": inst_id,
            "qr_limit": limit,
            "serverTimestamp": _server_ts_ms(),
        }

        def _to_secs(lim) -> int:
            try:
                n = int(lim)
            except Exception:
                return 60
            if n > 300:
                return max(30, min(600, n // 1000))
            if n <= 5:
                return max(30, min(600, n * 60))
            return max(30, min(600, n))

        ttl_sec = _to_secs(limit) + 15

        try:
            _rset(_rk("qr", "last", "inst", inst_id), payload, ttl=ttl_sec)
        except Exception:
            pass

        await conexoes_ativas.send_message(f"inst:{inst_id}", payload)

        try:
            with SessionLocal() as db:
                inst_row = _get_inst_row(db, inst_id)
                if inst_row:
                    emp_topic = f"emp:{inst_row.empresa_id}"
                    await conexoes_ativas.send_message(emp_topic, payload)
                    try:
                        _rset(_rk("qr", "last", "emp", str(inst_row.empresa_id), "inst", inst_id), payload, ttl=ttl_sec)
                    except Exception:
                        pass
        except Exception as e:
            LOG(f"[QR] falha ao emitir para empresa: {e}")

        size = 0
        try:
            if base64_img:
                size = len((base64_img.split(",", 1)[-1]) if "," in base64_img else base64_img)
        except Exception:
            pass

        LOG(f"[QR] emitido inst={inst_id} img={'yes' if base64_img else 'no'} code={'yes' if pairing_code else 'no'} (size={size})")
    except Exception as e:
        LOG(f"[QR] erro ao emitir: {e}")


def _extract_qr_fields(js: dict) -> tuple[str | None, str | None, int | None]:
    q = js.get("qrcode") if isinstance(js, dict) else None

    def _lim(d: dict) -> int | None:
        if not isinstance(d, dict):
            return None
        for k in ("count", "limit", "timeout"):
            v = d.get(k)
            if isinstance(v, (int, float)) and v > 0:
                return int(v)
            if isinstance(v, str) and v.isdigit():
                return int(v)
        return None

    if isinstance(q, dict):
        b64 = q.get("base64") or q.get("image")
        pc  = q.get("pairingCode") or q.get("code")
        return b64, pc, _lim(q)

    return (
        (js.get("base64") or js.get("image")),
        (js.get("pairingCode") or js.get("code")),
        _lim(js if isinstance(js, dict) else {}),
    )


def _evo_expand_websocket(instance: str) -> None:
    if not (EVOLUTION_URL and EVOLUTION_KEY and instance):
        return
    body = {"websocket": {"enabled": True, "events": FULL_EVENTS_WS}}
    try:
        requests.post(f"{EVOLUTION_URL}/websocket/set/{instance}", headers=HEADERS, json=body, timeout=15)
        LOG(f"[WS] expandido para inst={instance} -> {len(FULL_EVENTS_WS)} eventos")
    except Exception as e:
        LOG(f"[WS] falha ao expandir: {e}")


def _evo_expand_rabbit(instance: str) -> None:
    if not (EVOLUTION_URL and EVOLUTION_KEY and instance):
        return
    body = {
        "rabbitmq": {
            "enabled": True,
            "exchange": RABBIT_EXCHANGE,
            "bindings": RABBIT_BINDINGS,
            "events": FULL_EVENTS_RABBIT,
        }
    }
    try:
        requests.post(f"{EVOLUTION_URL}/rabbitmq/set/{instance}", headers=HEADERS, json=body, timeout=20)
        LOG(f"[Rabbit] expandido para inst={instance} -> {len(FULL_EVENTS_RABBIT)} eventos")
    except Exception as e:
        LOG(f"[Rabbit] falha ao expandir: {e}")


# =========================
# Evolution connect + media download
# =========================
def _evo_connect(instance: str) -> dict:
    if not (EVOLUTION_URL and HEADERS and instance):
        return {}
    try:
        r = requests.get(f"{EVOLUTION_URL}/instance/connect/{instance}", headers=HEADERS, timeout=25)
        if r.ok and "application/json" in (r.headers.get("content-type","")):
            return r.json() or {}
    except Exception:
        pass
    return {}


def _evo_get_base64_media(inst_id: str, msg_id: str, *, convert_to_mp4: bool | None = None):
    if not (EVOLUTION_URL and inst_id and msg_id):
        raise RuntimeError("Parâmetros insuficientes para getBase64FromMediaMessage.")
    url = f"{EVOLUTION_URL}/chat/getBase64FromMediaMessage/{inst_id}"
    sess = requests.Session()
    if HEADERS:
        sess.headers.update(HEADERS)
    payload = {"message": {"key": {"id": msg_id}}}
    if convert_to_mp4 is not None:
        payload["convertToMp4"] = bool(convert_to_mp4)
    r = sess.post(url, json=payload, timeout=60)
    if r.status_code not in (200, 201):
        raise RuntimeError(f"Evolution getBase64 HTTP {r.status_code}")
    js = r.json()
    b64 = js.get("base64") or js.get("fileBase64") or js.get("data") or js.get("file") or js.get("result")
    if not b64:
        raise RuntimeError("JSON sem base64.")
    filename = js.get("fileName") or js.get("filename") or js.get("name") or f"{msg_id}.bin"
    mimetype_ = js.get("mimetype") or js.get("mimeType")
    raw, mt_from_dataurl = _b64_to_bytes(b64)
    if not raw:
        raise RuntimeError("Falha ao decodificar base64 da Evolution.")
    if mt_from_dataurl:
        mimetype_ = mt_from_dataurl
    return raw, filename, (mimetype_ or "application/octet-stream"), len(raw)


def _download_media_bytes(inst_id: str, msg_id: str | None, _url_hint_ignored: str | None):
    if not msg_id:
        raise RuntimeError("msg_id obrigatório para baixar mídia via Evolution.")
    try:
        return _evo_get_base64_media(inst_id, msg_id, convert_to_mp4=None)
    except Exception:
        sess = requests.Session()
        if HEADERS:
            sess.headers.update(HEADERS)
        for tmpl in [
            f"{EVOLUTION_URL}/message/download/{inst_id}/{msg_id}",
            f"{EVOLUTION_URL}/messages/download/{inst_id}/{msg_id}",
            f"{EVOLUTION_URL}/chat/downloadMediaMessage/{inst_id}/{msg_id}",
        ]:
            try:
                r = sess.get(tmpl, timeout=60)
                if r.status_code == 200:
                    ct = r.headers.get("Content-Type") or "application/octet-stream"
                    cl = r.headers.get("Content-Length")
                    try:
                        cl = int(cl) if cl is not None else None
                    except Exception:
                        cl = None
                    dispo = r.headers.get("Content-Disposition") or ""
                    if "filename=" in dispo:
                        filename = dispo.split("filename=")[-1].strip('"').strip("'")
                    else:
                        ext = mimetypes.guess_extension(ct) or ""
                        filename = f"{msg_id}{ext}"
                    return r.content, filename, ct, cl
            except Exception:
                continue
        raise RuntimeError("Não foi possível baixar a mídia.")


def _save_midia_db(
    db: Session, *, empresa_id: int, cliente_id: int, mensagem_id: int,
    tipo: str, filename: str, mimetype_: str, raw: bytes,
    url_origem: str | None = None, content_length: int | None = None,
    instancia_id: int | None = None
) -> int:
    mimetype_norm = normalize_mimetype(tipo, filename, mimetype_)
    midia = models.Midia(
        empresa_id=empresa_id,
        cliente_id=cliente_id,
        mensagem_id=mensagem_id,
        tipo=tipo,
        filename=filename or "file",
        mimetype=mimetype_norm,
        tamanho=content_length or len(raw),
        data=raw,
        url=url_origem,
        instancia_id=instancia_id,
    )
    db.add(midia)
    db.flush()
    return midia.id


# =========================
# Texto "mastigado" (chatbot)
# =========================
def _is_textual_content(s: str | None) -> bool:
    if not s:
        return False
    t = s.strip()
    if t.startswith("[") and t.endswith("]"):
        return False
    return True


# =========================
# Exports úteis p/ handlers
# =========================
__all__ = [
    "EVOLUTION_URL","EVOLUTION_KEY","HEADERS",
    "SYNC_CONTACTS_ON_CONNECT","SYNC_CHATS_ON_CONNECT","ENABLE_MESSAGES_SET",
    "EVOLUTION_FORCE_QR_ON_WS",
    "HISTORY_LIMIT_HOURS","HISTORY_IGNORE_AFTER_DONE_MIN",
    "ALLOW_HISTORY_7D","HISTORY_MAX_IMPORT","HISTORY_BATCH_COMMIT","HISTORY_SLEEP_EVERY","DISABLE_MEDIA_ON_HISTORY",
    "FULL_EVENTS_WS","FULL_EVENTS_RABBIT","RABBIT_EXCHANGE","RABBIT_BINDINGS",
    "N8N_WEBHOOK_BASE_URL","N8N_CHATBOT_GERAL_PATH","N8N_CHATBOT_SETORES_PATH","N8N_MESSAGES_UPSERT_PATH","_n8n_url",
    "LOG","_short","_log_ctx","_log_skip",
    "record_rabbit_event","get_rabbit_monitor","RABBIT_MONITOR",
    "EvoEvent","HANDLERS","handler",
    "_now_utc","_server_ts_ms","_to_dt_utc","_iso_utc","_iso_local","_int_unix",
    "_invalidate_emp_cache",
    "ACK_NONE","ACK_DELIVERED","ACK_READ","_ack_from_status",
    "_jid_strip_device","_is_lid_jid","normalizar_telefone","_remote_to_num","_resolve_counterparty_num_1to1","formatar_telefone_br",
    "_lid_map_get","_lid_map_set","_lid_pend_append","_lid_pend_takeall","_resolve_remote_jid",
    "_try_acquire_hist_lock","_release_hist_lock","_retry_deadlock","_is_deadlock_error",
    "upsert_cliente","_fetch_cliente",
    "_HAS_MSG_ATD_FIELD","_get_or_open_atendimento","_status_token",
    "_inst_from","_get_inst_row","_empresa_id_by_inst","_me_number_by_inst","_carimbar_inst",
    "_emit_qr","_extract_qr_fields","_evo_expand_websocket","_evo_expand_rabbit",
    "_evo_connect","_evo_get_base64_media","_download_media_bytes","_save_midia_db",
    "_notify_n8n_chatbot","_is_textual_content",
    "cancel_auto_cleanup",
]
