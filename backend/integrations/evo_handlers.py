# backend/integrations/evo_handlers.py
from __future__ import annotations
import os, re, json, base64, asyncio, mimetypes, requests
from enum import StrEnum, auto
from typing import Callable, Awaitable, Any, Iterable
from datetime import datetime, timedelta, timezone
from sqlalchemy.orm import Session
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError  # ← NEW
from backend.database import SessionLocal
from backend import models
from backend.integrations.qrcode import qr_sign, qr_should_emit, qr_force_lock_acquire
from backend.websocket_manager import conexoes_ativas
from backend.models import StatusAtendimento  # ← NEW
# 🔹 importa o cancel_auto_cleanup do onboarding (pra cancelar o timer ao conectar)
from backend.routers.cliente_onboarding import cancel_auto_cleanup

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

# Fuso horário local opcional para exibir em WS (UTC é sempre usado para persistir)
APP_TZ_NAME = os.getenv("APP_TZ") or os.getenv("TZ") or "America/Sao_Paulo"
try:
    from zoneinfo import ZoneInfo
    APP_TZ = ZoneInfo(APP_TZ_NAME)
except Exception:
    # fallback: se zoneinfo não estiver disponível, usa UTC
    APP_TZ = timezone.utc

# ======= Histórico – limites e flags =======
ALLOW_HISTORY_7D          = (os.getenv("ALLOW_HISTORY_7D", "false").lower() == "true")
HISTORY_MAX_IMPORT        = int(os.getenv("HISTORY_MAX_IMPORT", "3000") or "3000")    # CAP por rodada
HISTORY_BATCH_COMMIT      = int(os.getenv("HISTORY_BATCH_COMMIT", "250") or "250")    # commit a cada N
HISTORY_SLEEP_EVERY       = int(os.getenv("HISTORY_SLEEP_EVERY", "500") or "500")     # ceder loop a cada N
DISABLE_MEDIA_ON_HISTORY  = (os.getenv("DISABLE_MEDIA_ON_HISTORY", "true").lower() == "true")

# ======= Listas de eventos completos (ligados só após CONNECTED) =======
# Evolution WebSocket: só coisas leves (sem mensagens)
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
    "GROUP_UPDATE",
    "GROUP_PARTICIPANTS_UPDATE",
]


RABBIT_EXCHANGE = os.getenv("RABBITMQ_EXCHANGE_NAME", "evolution_exchange")
RABBIT_BINDINGS = [b.strip() for b in (os.getenv("RABBITMQ_BINDINGS", "#") or "#").split(",") if b.strip()]

import random
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
        return bool(db.execute(
            text("SELECT pg_try_advisory_lock(:a, :b)"),
            {"a": int(empresa_id), "b": int(instancia_id)}
        ).scalar())
    except Exception:
        return True

def _release_hist_lock(db: Session, empresa_id: int, instancia_id: int) -> None:
    try:
        db.execute(text("SELECT pg_advisory_unlock(:a, :b)"),
                   {"a": int(empresa_id), "b": int(instancia_id)})
    except Exception:
        pass


async def _retry_deadlock(db: Session, func, *, attempts: int = 5, base_delay: float = 0.02):
    """
    Tenta executar `func` algumas vezes se detectar deadlock/timeout no Postgres.

    Agora é assíncrona e usa asyncio.sleep para não travar o event loop.
    - `func` deve ser uma função síncrona que faz a operação no DB.
    - Em caso de deadlock/timeout, faz rollback, espera com backoff exponencial e tenta de novo.
    """
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
            # se não for deadlock, propaga
            raise

# =========================
# Log util (prefix fixo)
# =========================
def LOG(*args): print("[EVO]", *args)


def _is_textual_content(s: str | None) -> bool:
    if not s:
        return False
    t = s.strip()
    # placeholders do Baileys/Evolution geralmente são [Coisa]
    if t.startswith("[") and t.endswith("]"):
        return False
    return True

def _log_msg_event(*, telefone: str | None, from_me: bool, conteudo: str | None,
                   ack: int | None, lida: bool | None, ts: datetime | None, msg_id: str | None):
    num_fmt = formatar_telefone_br(telefone) if telefone else "-"
    eu_str = "sim" if from_me else "não"

    # regra: saída usa ACK; entrada usa flag lida
    is_read = (ack or 0) >= ACK_READ if from_me else bool(lida)
    lido_str = "sim" if is_read else "não"

    ts_str = _iso_utc(ts or _now_utc())

    base = f'[MSG] numero="{num_fmt}" eu={eu_str} lido={lido_str} id={msg_id or "-"} ts={ts_str}'

    if _is_textual_content(conteudo):
        txt = (conteudo or "").replace("\n", " ").strip()
        if len(txt) > 200:
            txt = txt[:200] + "…"
        base += f' conteudo="{txt}"'

    print(base, flush=True)


# =========================
# Datas / Horários helpers (unificação)
# =========================
def _now_utc() -> datetime:
    return datetime.now(timezone.utc)

def _server_ts_ms() -> int:
    return int(_now_utc().timestamp() * 1000)

def _to_dt_utc(ts_like) -> datetime:
    """
    Converte diversos formatos de timestamp para datetime timezone-aware (UTC).
    Aceita: int/float/string (segundos, ms ou µs desde epoch).
    """
    if ts_like is None:
        return _now_utc()
    try:
        s = str(ts_like).strip()
        if not s:
            return _now_utc()
        # remove decimal se vier "xxxx.xx"
        if "." in s:
            val = float(s)
        else:
            val = int(s)
        # heurística: > 10^14 ≈ microsegundos; > 10^11 ≈ milissegundos
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
    if instance: _RABBIT_MONITOR["last_by_instance"][instance] = ts

def get_rabbit_monitor() -> dict:
    return _RABBIT_MONITOR

# alias público para o main.py
RABBIT_MONITOR = _RABBIT_MONITOR

# =========================
# Cache (Redis) – helpers (compat com seu redis_client.py)
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
    # fallback no-op pra não quebrar se Redis não estiver presente
    def _rk(*parts: str) -> str:
        return ":".join([str(p) for p in parts if p is not None and p != ""])
    def _rget(_): return None
    def _rset(*_a, **_k): pass
    def _rdel(*_a, **_k): pass
    def _rdelpat(*_a, **_k): pass

def _invalidate_emp_cache(emp_id: int):
    """
    Apaga caches de listas impactadas para a empresa:
    - /conversas (todas as variações de inst/cursor/limit)
    - /clientes (lista legado)
    """
    try:
        # /conversas (prefixo amplo)
        _rdelpat(_rk("conv", "list", "emp", str(emp_id)))
        # /clientes (chave exata do legado sem departamento)
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
# Phone helpers
# =========================

# === [DEBUG / LOG HELPERS] ====================================================
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

# ==============================================================================

def _jid_strip_device(j: str | None) -> str:
    if not j: return ""
    base = str(j)
    if "@" in base:
        user, host = base.split("@", 1)
        user = user.split(":")[0]
        return f"{user}@{host}"
    return base.split(":")[0]

def normalizar_telefone(n: str) -> str | None:
    if not n: return None
    n = re.sub(r"\D", "", n)
    if n.startswith("0"): n = n[1:]
    if not n.startswith("55"): n = "55" + n
    ddd, restante = n[2:4], n[4:]
    if len(restante) == 8 and not restante.startswith("9"):
        restante = "9" + restante
    return f"55{ddd}{restante}"

def _remote_to_num(remote_jid: str | None) -> str | None:
    if not remote_jid: return None
    if remote_jid.endswith("@g.us"):  # grupo
        return None
    # não tentar converter @lid diretamente
    if remote_jid.endswith("@lid"):
        return None
    user = _jid_strip_device(remote_jid).split("@")[0]
    user = re.sub(r"\D", "", user or "")
    if not user: return None
    if user.startswith("0"): user = user[1:]
    if not user.startswith("55"): user = "55" + user
    ddd = user[2:4]; restante = user[4:]
    if len(restante) == 8 and not restante.startswith("9"):
        restante = "9" + restante
    return f"55{ddd}{restante}"

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

    # 1) tenta pelo remote_jid
    tel = _num_of(remote_jid)
    if tel and (not me_num or tel != me_num):
        return tel, remote_jid

    # 2) alternativos: string **ou dict** (Evolution às vezes manda objetos aqui)
    alt_fields = ("senderPn", "senderpn", "participant", "author", "from", "sender", "user")

    def _first_str_from_obj(o: dict) -> str | None:
        for k2 in ("id","jid","wid","user","from","peer","participant","phone","phoneNumber","number"):
            v2 = o.get(k2)
            if isinstance(v2, str) and v2.strip():
                return v2
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

    # se veio só DDD+local (10/11), assume Brasil e prefixa 55 só para exibir
    if len(d) in (10, 11):
        d = "55" + d

    if len(d) == 13:  # 55 + DDD(2) + 9 + xxxx(8)
        return f"+{d[:2]} {d[2:4]} {d[4:9]}-{d[9:]}"
    if len(d) == 12:  # 55 + DDD(2) + xxxx(8)
        return f"+{d[:2]} {d[2:4]} {d[4:8]}-{d[8:]}"
    return f"+{d}" if d else ""

# ========= normalização p/ decidir UPSERT + SQL de UPSERT =========
def _br_tel_norm_for_upsert(raw: str | None) -> str | None:
    if not raw:
        return None
    s = str(raw)
    if "@" in s:  # qualquer JID -> não criar cliente
        return None

    d = re.sub(r"\D", "", s)

    # tira zeros à esquerda
    d = d.lstrip("0")

    # tira DDI 55 repetidamente enquanto estiver maior que 11 e ainda começar com 55
    while d.startswith("55") and len(d) > 11:
        d = d[2:]

    # se ainda estiver maior que 11, fica com os últimos 11 (DDD+9+8)
    if len(d) > 11:
        d = d[-11:]

    # agora valida (10 = fixo, 11 = móvel)
    if len(d) in (10, 11):
        return d

    return None


UPSERT_CLIENTE_SQL = text("""
  INSERT INTO public.clientes (empresa_id, instancia_id, telefone, nome, nome_whatsapp, avatar_url)
  VALUES (:empresa_id, :instancia_id, :telefone, :nome, :nome_whatsapp, :avatar_url)
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
    nome: str | None,
    nome_whatsapp: str | None,
    avatar_url: str | None
) -> int | None:
    """Cria/mescla cliente por (empresa_id, telefone_norm). Ignora grupos/JIDs."""
    tel_norm = _br_tel_norm_for_upsert(telefone_raw)
    if not tel_norm:
        return None

    row = db.execute(
        UPSERT_CLIENTE_SQL,
        {
            "empresa_id":   int(empresa_id),
            "instancia_id": int(instancia_id) if instancia_id is not None else None,
            "telefone":     telefone_raw or tel_norm,
            "nome":         nome,
            "nome_whatsapp":nome_whatsapp,
            "avatar_url":   avatar_url,
        }
    ).first()
    return int(row[0]) if row else None


def _fetch_cliente(db: Session, cliente_id: int) -> models.Cliente | None:
    try:
        return db.query(models.Cliente).filter(models.Cliente.id == cliente_id).first()
    except Exception:
        return None

# =========================
# 🔸 Atendimento helpers (responsável por conversa/sessão)
# =========================
def _mensagem_tem_campo_atendimento() -> bool:
    try:
        return hasattr(models.Mensagem, "atendimento_id")
    except Exception:
        return False

_HAS_MSG_ATD_FIELD = _mensagem_tem_campo_atendimento()

def _get_or_open_atendimento(
    db: Session, *,
    empresa_id: int,
    instancia_id: int,
    cliente_id: int,
    direcao: str,                     # 'entrada' | 'saida'
    ts_dt: datetime | None = None,
    operador_id: int | None = None
):
    """
    Busca um atendimento aberto (status != RESOLVIDO) para (cliente_id, instancia_id).
    Se não existir, cria um novo. Usa o Enum StatusAtendimento diretamente.
    """
    ts_dt = ts_dt or _now_utc()

    q = db.query(models.Atendimento).filter(
        models.Atendimento.cliente_id == cliente_id,
        models.Atendimento.instancia_id == instancia_id,
        models.Atendimento.status != StatusAtendimento.RESOLVIDO,
    ).order_by(models.Atendimento.criado_em.desc())

    a = q.first()
    if not a:
        status_ini = StatusAtendimento.EM_ATENDIMENTO if direcao == "saida" else StatusAtendimento.NOVO
        a = models.Atendimento(
            cliente_id=cliente_id,
            instancia_id=instancia_id,
            operador_id=(operador_id if direcao == "saida" else None),
            status=status_ini,
            criado_em=ts_dt,
        )
        db.add(a)
        try:
            db.flush()
        except IntegrityError:
            # corrida: alguém criou entre o select e o insert
            db.rollback()
            a = q.first()
            if not a:
                a = models.Atendimento(
                    cliente_id=cliente_id,
                    instancia_id=instancia_id,
                    operador_id=(operador_id if direcao == "saida" else None),
                    status=status_ini,
                    criado_em=ts_dt,
                )
                db.add(a); db.flush()

    if direcao == "saida":
        try:
            if getattr(a, "status", None) != StatusAtendimento.EM_ATENDIMENTO:
                a.status = StatusAtendimento.EM_ATENDIMENTO
            if operador_id and not a.operador_id:
                a.operador_id = operador_id
        except Exception:
            pass

    return a


def _status_token(val) -> str | None:
    """Converte Enum/str para o token esperado no DB (minúsculos)."""
    if val is None:
        return None
    raw = getattr(val, "value", val)  # aceita Enum ou str
    return str(raw).lower()


# =========================
# LID resolver/cache + pendentes
# =========================
_LID_CACHE: dict[str, dict[str, str]] = {}  # in-memory: inst -> {lid_jid: wa_jid}
_LID_REDIS_TTL = 172800  # 2 dias

def _is_lid_jid(j: str | None) -> bool:
    return isinstance(j, str) and j.endswith("@lid")

def _lid_map_key(emp_id: int, inst_db_id: int, lid: str) -> str:
    return _rk("lidmap", "emp", str(emp_id), "inst", str(inst_db_id), lid)

def _lid_pend_key(emp_id: int, inst_db_id: int, lid: str) -> str:
    return _rk("lidpend", "emp", str(emp_id), "inst", str(inst_db_id), lid)

def _lid_map_get(emp_id: int, inst_db_id: int, lid: str) -> str | None:
    v = _rget(_lid_map_key(emp_id, inst_db_id, lid))
    return v if isinstance(v, str) else None

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
    # limpa
    _rset(key, [], ttl=_LID_REDIS_TTL)
    return cur

def _resolve_remote_jid(inst_id: str, raw_remote: str | None) -> str | None:
    """
    Resolve '@lid' → '@s.whatsapp.net' usando:
      - cache de memória (_LID_CACHE)
      - cache Redis (por empresa/instância)
      - Evolution /chat/findChats (com filtro por id e geral)
      - Evolution /chat/findContacts
    Retorna:
      - o mesmo JID se já ser '@s.whatsapp.net' ou '@g.us'
      - o mapeado se houver cache/descoberta
      - None se não conseguir mapear '@lid'
    """
    s = _jid_strip_device(raw_remote or "")
    if not s:
        return None
    if s.endswith("@s.whatsapp.net") or s.endswith("@g.us"):
        return s
    if not s.endswith("@lid"):
        return s

    # cache memória
    mapped = _LID_CACHE.get(inst_id, {}).get(s)
    if mapped:
        return mapped

    # tenta popular cache a partir do Evolution
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
                for k in ("id","remoteJid","jid","wid","chatId"):
                    v = ch.get(k)
                    if isinstance(v, str):
                        vals.append(_jid_strip_device(v))
                lid = next((x for x in vals if isinstance(x, str) and x.endswith("@lid")), None)
                wa  = next((x for x in vals if isinstance(x, str) and x.endswith("@s.whatsapp.net")), None)
                if lid and wa:
                    _LID_CACHE.setdefault(inst_id, {})[lid] = wa

        # 1) findChats filtrando pelo próprio LID
        try:
            r = sess.post(f"{EVOLUTION_URL}/chat/findChats/{inst_id}", json={"where": {"id": s}}, timeout=20)
            if r.ok:
                js = r.json()
                items = []
                if isinstance(js, list): items = js
                elif isinstance(js, dict):
                    for k in ("chats","items","data","result","rows","list","payload","store"):
                        v = js.get(k)
                        if isinstance(v, list): items = v; break
                    if not items: items = [js]
                _collect_map(items)
        except Exception:
            pass

        # 2) findChats geral
        if not _LID_CACHE.get(inst_id, {}).get(s):
            try:
                r = sess.post(f"{EVOLUTION_URL}/chat/findChats/{inst_id}", json={"where": {}}, timeout=20)
                if r.ok:
                    js = r.json()
                    items = []
                    if isinstance(js, list): items = js
                    elif isinstance(js, dict):
                        for k in ("chats","items","data","result","rows","list","payload","store"):
                            v = js.get(k)
                            if isinstance(v, list): items = v; break
                        if not items: items = [js]
                    _collect_map(items)
            except Exception:
                pass

        # 3) findContacts (alguns providers mapeiam aqui)
        if not _LID_CACHE.get(inst_id, {}).get(s):
            try:
                r = sess.post(f"{EVOLUTION_URL}/chat/findContacts/{inst_id}", json={"where": {}}, timeout=20)
                if r.ok:
                    js = r.json()
                    items = []
                    if isinstance(js, list): items = js
                    elif isinstance(js, dict):
                        for k in ("contacts","items","data","result","rows","list","payload","store"):
                            v = js.get(k)
                            if isinstance(v, list): items = v; break
                        if not items: items = [js]
                    _collect_map(items)
            except Exception:
                pass

        return _LID_CACHE.get(inst_id, {}).get(s)
    except Exception as e:
        LOG(f"[LID] resolver falhou: {e}")
        return None

# =========================
# Message/media helpers
# =========================
def _unwrap_baileys_layers(obj: dict) -> dict:
    m = obj if isinstance(obj, dict) else {}
    while True:
        if "ephemeralMessage" in m: m = m["ephemeralMessage"].get("message", {})
        elif "viewOnceMessage" in m: m = m["viewOnceMessage"].get("message", {})
        elif "viewOnceMessageV2" in m: m = m["viewOnceMessageV2"].get("message", {})
        elif "viewOnceMessageV2Extension" in m: m = m["viewOnceMessageV2Extension"].get("message", {})
        elif "deviceSentMessage" in m: m = m["deviceSentMessage"].get("message", {})
        else: break
    return m.get("message") if "message" in m else m

def extract_text_from_baileys(obj: dict) -> str:
    if not isinstance(obj, dict): return ""
    m = _unwrap_baileys_layers(obj)
    if not isinstance(m, dict): return ""
    if "conversation" in m: return m["conversation"] or ""
    if "extendedTextMessage" in m: return m["extendedTextMessage"].get("text") or ""
    if "buttonsResponseMessage" in m: return m["buttonsResponseMessage"].get("selectedDisplayText") or "[Botão]"
    if "templateButtonReplyMessage" in m: return m["templateButtonReplyMessage"].get("selectedDisplayText") or "[Botão]"
    if "listResponseMessage" in m:
        sel = m["listResponseMessage"].get("title") or (m["listResponseMessage"].get("singleSelectReply") or {}).get("selectedRowId")
        return sel or "[Lista]"
    if "interactiveResponseMessage" in m:
        resp = m["interactiveResponseMessage"].get("nativeFlowResponseMessage") or {}
        text = (resp.get("paramsJson") or "").strip()
        return text or "[Interativo]"
    if "reactionMessage" in m:
        text = m["reactionMessage"].get("text") or ""
        key = m["reactionMessage"].get("key", {})
        reacted_to = key.get("id")
        return f"[Reação] {text} ⇢ {reacted_to}" if text else "[Reação]"
    if "imageMessage" in m:  return m["imageMessage"].get("caption") or "[Imagem]"
    if "videoMessage" in m:  return m["videoMessage"].get("caption") or "[Vídeo]"
    if "audioMessage" in m:  return "[Áudio/ptt]" if m["audioMessage"].get("ptt", False) else "[Áudio]"
    if "stickerMessage" in m: return "[Figurinha]"
    if "documentMessage" in m:
        name = m["documentMessage"].get("fileName"); return f"[Documento] {name}" if name else "[Documento]"
    if "contactMessage" in m: return f"[Contato] {m['contactMessage'].get('displayName') or ''}".strip()
    if "contactsArrayMessage" in m: return f"[Contatos] {len(m['contactsArrayMessage'].get('contacts', []))}"
    if "locationMessage" in m:
        name = m["locationMessage"].get("name") or m["locationMessage"].get("address"); return f"[Localização] {name}" if name else "[Localização]"
    if "protocolMessage" in m: return "[Mensagem apagada]" if m["protocolMessage"].get("type") == 0 else "[Evento]"
    if "orderMessage" in m: return f"[Pedido] {(m['orderMessage'].get('orderTitle') or '').strip()}".strip()
    return "[Mensagem recebida]"

def extract_media_meta(msg_obj: dict) -> dict[str, Any] | None:
    m = _unwrap_baileys_layers(msg_obj or {})
    if not isinstance(m, dict): return None
    if "imageMessage" in m:
        im = m["imageMessage"] or {}
        return {"tipo":"image","mimetype":im.get("mimetype") or "image/jpeg","filename":im.get("fileName") or "image.jpg",
                "url":im.get("url") or im.get("directPath"),"caption":im.get("caption") or None,
                "fileLength":im.get("fileLength"),"base64":im.get("base64") or im.get("fileBase64") or im.get("data") or None}
    if "videoMessage" in m:
        vi = m["videoMessage"] or {}
        return {"tipo":"video","mimetype":vi.get("mimetype") or "video/mp4","filename":vi.get("fileName") or "video.mp4",
                "url":vi.get("url") or vi.get("directPath"),"caption":vi.get("caption") or None,
                "fileLength":vi.get("fileLength"),"base64":vi.get("base64") or vi.get("fileBase64") or vi.get("data") or None}
    if "audioMessage" in m:
        au = m["audioMessage"] or {}
        return {"tipo":"audio","mimetype":au.get("mimetype") or "audio/ogg","filename":"ptt.ogg" if au.get("ptt") else "audio.ogg",
                "url":au.get("url") or au.get("directPath"),"caption":None,"fileLength":au.get("fileLength"),
                "base64":au.get("base64") or au.get("fileBase64") or au.get("data") or None}
    if "documentMessage" in m:
        dm = m["documentMessage"] or {}
        fname = dm.get("fileName") or "document"
        mt = dm.get("mimetype") or mimetypes.guess_type(fname)[0] or "application/octet-stream"
        return {"tipo":"document","mimetype":mt,"filename":fname,"url":dm.get("url") or dm.get("directPath"),
                "caption":None,"fileLength":dm.get("fileLength"),"base64":dm.get("base64") or dm.get("fileBase64") or dm.get("data") or None}
    if "stickerMessage" in m:
        st = m["stickerMessage"] or {}
        return {"tipo":"sticker","mimetype":st.get("mimetype") or "image/webp","filename":"sticker.webp",
                "url":st.get("url") or st.get("directPath"),"fileLength":st.get("fileLength"),
                "base64":st.get("base64") or st.get("fileBase64") or st.get("data") or None}
    return None

def _b64_to_bytes(data_str: str) -> tuple[bytes, str | None]:
    if not data_str: return b"", None
    s = data_str.strip(); mimetype_ = None
    if s.startswith("data:"):
        try:
            header, b64 = s.split(",", 1)
            if header.startswith("data:"):
                mt = header[5:]
                if ";" in mt: mt = mt.split(";", 1)[0]
                mimetype_ = mt or None
            s = b64
        except Exception: pass
    try: return base64.b64decode(s, validate=False), mimetype_
    except Exception: return b"", mimetype_

def _guess_default_mimetype(tipo: str | None, filename: str | None, fallback: str = "application/octet-stream") -> str:
    tipo = (tipo or "").lower()
    if tipo == "image": return "image/jpeg"
    if tipo == "video": return "video/mp4"
    if tipo == "audio": return "audio/ogg"
    if tipo == "sticker": return "image/webp"
    if filename:
        mt = mimetypes.guess_type(filename)[0]
        if mt: return mt
    return fallback

def _normalize_mimetype(tipo: str, filename: str | None, mimetype_: str | None) -> str:
    mt = (mimetype_ or "").strip().lower()
    if (not mt) or ("/" not in mt) or mt in {"application","image","video","audio","sticker","application/octet-stream"}:
        mt = _guess_default_mimetype(tipo, filename, "application/octet-stream")
    return mt

# reexport p/ main
normalize_mimetype = _normalize_mimetype

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
        if v: return v
        v = _pick(payload.get("qrcode") if isinstance(payload.get("qrcode"), dict) else None)
        if v: return v
        data = payload.get("data")
        if isinstance(data, dict):
            v = _pick(data)
            if v: return v
            v = _pick(data.get("qrcode") if isinstance(data.get("qrcode"), dict) else None)
            if v: return v
        elif isinstance(data, list):
            for item in data:
                v = _pick(item if isinstance(item, dict) else None)
                if v: return v
                if isinstance(item, dict) and isinstance(item.get("qrcode"), dict):
                    v = _pick(item.get("qrcode"))
                    if v: return v
    return None

def _get_inst_row(db: Session, inst_name: str) -> models.EmpresaInstancia | None:
    return db.query(models.EmpresaInstancia).filter(models.EmpresaInstancia.instance_name == inst_name).first()

def _empresa_id_by_inst(db: Session, inst_name: str) -> int | None:
    row = _get_inst_row(db, inst_name); return int(row.empresa_id) if row else None

def _me_number_by_inst(row: models.EmpresaInstancia | None) -> str:
    if not row or not row.numero_instancia: return ""
    return normalizar_telefone(row.numero_instancia) or ""

# =========================
# Forçar “carimbo” de instância
# =========================
def _carimbar_inst(obj, inst: models.EmpresaInstancia):
    if hasattr(obj, "instancia_id") and (getattr(obj, "instancia_id", None) is None):
        obj.instancia_id = inst.id
    if isinstance(obj, models.Grupo):
        if hasattr(obj, "instance_name") and not getattr(obj, "instance_name", None):
            obj.instance_name = inst.instance_name

# =========================
# Evolution connect (força QR)
# =========================
def _evo_connect(instance: str) -> dict:
    if not (EVOLUTION_URL and HEADERS and instance): return {}
    try:
        r = requests.get(f"{EVOLUTION_URL}/instance/connect/{instance}", headers=HEADERS, timeout=25)
        if r.ok and "application/json" in (r.headers.get("content-type","")):
            return r.json() or {}
    except Exception:
        pass
    return {}

# =========================
# Media download via Evolution
# =========================
def _evo_get_base64_media(inst_id: str, msg_id: str, *, convert_to_mp4: bool | None = None):
    if not (EVOLUTION_URL and inst_id and msg_id):
        raise RuntimeError("Parâmetros insuficientes para getBase64FromMediaMessage.")
    url = f"{EVOLUTION_URL}/chat/getBase64FromMediaMessage/{inst_id}"
    sess = requests.Session()
    if HEADERS: sess.headers.update(HEADERS)
    payload = {"message": {"key": {"id": msg_id}}}
    if convert_to_mp4 is not None:
        payload["convertToMp4"] = bool(convert_to_mp4)
    r = sess.post(url, json=payload, timeout=60)
    if r.status_code not in (200, 201): raise RuntimeError(f"Evolution getBase64 HTTP {r.status_code}")
    js = r.json()
    b64 = js.get("base64") or js.get("fileBase64") or js.get("data") or js.get("file") or js.get("result")
    if not b64: raise RuntimeError("JSON sem base64.")
    filename = js.get("fileName") or js.get("filename") or js.get("name") or f"{msg_id}.bin"
    mimetype_ = js.get("mimetype") or js.get("mimeType")
    raw, mt_from_dataurl = _b64_to_bytes(b64)
    if not raw: raise RuntimeError("Falha ao decodificar base64 da Evolution.")
    if mt_from_dataurl: mimetype_ = mt_from_dataurl
    return raw, filename, (mimetype_ or "application/octet-stream"), len(raw)

def _download_media_bytes(inst_id: str, msg_id: str | None, _url_hint_ignored: str | None):
    if not msg_id:
        raise RuntimeError("msg_id obrigatório para baixar mídia via Evolution.")
    try:
        return _evo_get_base64_media(inst_id, msg_id, convert_to_mp4=None)
    except Exception:
        sess = requests.Session()
        if HEADERS: sess.headers.update(HEADERS)
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
                    try: cl = int(cl) if cl is not None else None
                    except Exception: cl = None
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

def _save_midia_db(db: Session, *, empresa_id: int, cliente_id: int, mensagem_id: int,
                   tipo: str, filename: str, mimetype_: str, raw: bytes,
                   url_origem: str | None = None, content_length: int | None = None,
                   instancia_id: int | None = None) -> int:
    mimetype_norm = _normalize_mimetype(tipo, filename, mimetype_)
    midia = models.Midia(
        empresa_id=empresa_id, cliente_id=cliente_id, mensagem_id=mensagem_id,
        tipo=tipo, filename=filename or "file", mimetype=mimetype_norm,
        tamanho=content_length or len(raw), data=raw, url=url_origem,
        instancia_id=instancia_id,
    )
    db.add(midia); db.flush(); return midia.id

# =========================
# Robust flatten/normalize
# =========================
def _iter_all_nodes(root) -> Iterable[Any]:
    q = [root]
    while q:
        cur = q.pop(0)
        yield cur
        if isinstance(cur, dict): q.extend(cur.values())
        elif isinstance(cur, list): q.extend(cur)

def _looks_like_message(d: dict) -> bool:
    if not isinstance(d, dict):
        return False
    # válido se for o objeto "completo" (tem cabeçalho)…
    if isinstance(d.get("key"), dict):
        return True
    # …ou se tiver JID em nível superior (alguns providers mandam assim)
    jid = d.get("remoteJid") or d.get("remote_jid") or d.get("jid") or d.get("chatId")
    if isinstance(jid, str) and jid:
        return True
    # NÃO considerar nós internos do campo 'message' (só conversation/caption/etc.)
    return False

def extract_messages_any_shape(data) -> list[dict]:
    """
    Extrai uma lista de mensagens a partir de payloads em formatos variados.
    Deduplica por msg_id considerando **key.id** ou **id** de nível superior
    e mantém a versão mais "rica" (com mais campos/conteúdo).
    Requer _iter_all_nodes(...) e _looks_like_message(...) já definidos.
    """

    def _msg_id_any(m: dict) -> str | None:
        if not isinstance(m, dict):
            return None
        # Locais comuns onde o id pode aparecer
        for path in [
            ("key", "id"),
            ("id",),
            ("keyId",),
            ("message", "key", "id"),
            ("messageId",),
        ]:
            cur = m
            ok = True
            for p in path:
                if isinstance(cur, dict) and p in cur:
                    cur = cur[p]
                else:
                    ok = False
                    break
            if ok and isinstance(cur, str) and cur.strip():
                return cur.strip()
        return None

    def _richness(m: dict) -> int:
        # Heurística simples: número de chaves + bônus por ter "message" e timestamp
        if not isinstance(m, dict):
            return 0
        score = len(m)
        if "message" in m: score += 50
        if "messageTimestamp" in m or "timestamp" in m: score += 5
        # se "message" for dict, adiciona o tamanho dele também
        msg = m.get("message")
        if isinstance(msg, dict):
            score += len(msg)
        return score

    # 1) Casos diretos (lista/objeto com campo-lista)
    if isinstance(data, list) and all(isinstance(x, dict) for x in data):
        candidates = data
    elif isinstance(data, dict):
        found = None
        for k in ("messages","msgs","items","result","rows","data","list","payload","store"):
            v = data.get(k)
            if isinstance(v, list) and v and all(isinstance(x, dict) for x in v):
                found = v; break
        candidates = found if found is not None else []
    else:
        candidates = []

    # 2) Varredura total quando não achou claramente
    if not candidates:
        out = []
        for node in _iter_all_nodes(data):
            if isinstance(node, list) and node and all(isinstance(x, dict) for x in node):
                likes = sum(1 for x in node if _looks_like_message(x))
                if likes >= max(1, len(node)//3):
                    out.extend(node)
            elif isinstance(node, dict) and _looks_like_message(node):
                out.append(node)
        candidates = out

    # 3) Dedup por msg_id (key.id OU id topo), preferindo a versão mais rica
    uniq: dict[str, dict] = {}
    noid_bucket: list[dict] = []
    for m in candidates:
        if not isinstance(m, dict):
            continue
        mid = _msg_id_any(m)
        if mid:
            old = uniq.get(mid)
            if old is None or _richness(m) > _richness(old):
                uniq[mid] = m
        else:
            noid_bucket.append(m)  # mantém mensagens sem id (raras: p.ex. protocolMessage)

    final = list(uniq.values()) + noid_bucket
    return final


def extract_contacts_any_shape(data) -> list[dict]:
    if isinstance(data, list): return [x for x in data if isinstance(x, dict)]
    if isinstance(data, dict):
        for k in ("contacts","items","data","result","rows","list","payload","store"):
            v = data.get(k)
            if isinstance(v, list): return [x for x in v if isinstance(x, dict)]
        return [data]
    return []

def extract_chats_any_shape(data) -> list[dict]:
    def looks(d: dict) -> bool:
        if not isinstance(d, dict): return False
        jid = d.get("id") or d.get("remoteJid") or d.get("jid") or d.get("wid")
        if isinstance(jid, str) and (jid.endswith("@g.us") or jid.endswith("@s.whatsapp.net") or jid.endswith("@lid")):
            return True
        if d.get("isGroup") is True or d.get("subject"): return True
        return False
    if isinstance(data, list):
        return [x for x in data if isinstance(x, dict) and looks(x)]
    if isinstance(data, dict):
        for k in ("chats","items","data","result","rows","list","payload","store"):
            v = data.get(k)
            if isinstance(v, list): return [x for x in v if isinstance(x, dict) and looks(x)]
        return [data] if looks(data) else []
    return [n for n in _iter_all_nodes(data) if isinstance(n, dict) and looks(n)]

# =========================
# ACK helpers
# =========================
ACK_NONE=0; ACK_DELIVERED=1; ACK_READ=2

def _ack_from_status(status_or_ack) -> int:
    """
    Mapeia os códigos/strings do Baileys/Evolution para nossos 3 níveis:
      0 = sem confirmação
      1 = enviado/deliver (server ack OU delivered)
      2 = lido/reproduzido
    """
    if status_or_ack is None:
        return ACK_NONE

    s = str(status_or_ack).strip().upper()

    # pendente/sem confirmação
    if s in {"0", "PENDING"}:
        return ACK_NONE

    # enviado ao servidor OU entregue ao destinatário
    if s in {"1", "SERVER", "SERVER_ACK", "2", "DELIVERED", "DELIVERY_ACK"}:
        return ACK_DELIVERED

    # lido / visto / áudio reproduzido
    if s in {"3", "READ", "READ_RECEIPT", "PLAYED", "VIEWED"}:
        return ACK_READ

    return ACK_NONE

# =========================
# QR helpers
# =========================

async def _emit_qr(inst_id: str, base64_img: str | None, pairing_code: str | None, limit: int | None = None):
    """
    Emite QRCODE_UPDATED para a instância (e também para a empresa),
    com dedup e snapshot em Redis para replay quando o WS conectar depois.
    """
    try:
        # assinatura estável do QR (pairing_code + prefixo do base64)
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

        # TTL do snapshot (converte heurística parecida com o front)
        def _to_secs(lim) -> int:
            try:
                n = int(lim)
            except Exception:
                return 60
            if n > 300:   # provavelmente ms
                return max(30, min(600, n // 1000))
            if n <= 5:    # provavelmente minutos
                return max(30, min(600, n * 60))
            return max(30, min(600, n))

        ttl_sec = _to_secs(limit) + 15  # uma gordurinha

        # Snapshot para REPLAY: salva no Redis
        try:
            _rset(_rk("qr", "last", "inst", inst_id), payload, ttl=ttl_sec)
        except Exception:
            pass

        # WS: instância
        await conexoes_ativas.send_message(f"inst:{inst_id}", payload)

        # WS: também para a empresa (para telas abertas só no tópico da empresa)
        try:
            with SessionLocal() as db:
                inst_row = _get_inst_row(db, inst_id)
                if inst_row:
                    emp_topic = f"emp:{inst_row.empresa_id}"
                    await conexoes_ativas.send_message(emp_topic, payload)
                    # (opcional) snapshot por empresa+instância
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
        if not isinstance(d, dict): return None
        for k in ("count","limit","timeout"):
            v = d.get(k)
            if isinstance(v, (int,float)) and v>0: return int(v)
            if isinstance(v, str) and v.isdigit(): return int(v)
        return None
    if isinstance(q, dict):
        b64 = q.get("base64") or q.get("image")
        pc  = q.get("pairingCode") or q.get("code")
        return b64, pc, _lim(q)
    return (js.get("base64") or js.get("image")), (js.get("pairingCode") or js.get("code")), _lim(js if isinstance(js, dict) else {})

# =========================
# Helpers para expandir eventos (ligar DEPOIS do CONNECTED)
# =========================
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
# HANDLERS
# =========================
@handler(EvoEvent.QRCODE_UPDATED)
async def on_qrcode_updated(first: str, payload: dict):
    inst_id = _inst_from(payload) or first
    record_rabbit_event("QRCODE_UPDATED", inst_id)
    data = (payload.get("data") or payload) if isinstance(payload, dict) else {}
    q = data.get("qrcode") if isinstance(data, dict) and isinstance(data.get("qrcode"), dict) else data
    b64 = (q.get("base64") if isinstance(q, dict) else None) or (q.get("image") if isinstance(q, dict) else None) or ""
    pairing_code = (q.get("pairingCode") if isinstance(q, dict) else None) or (q.get("code") if isinstance(q, dict) else None)

    limit = None
    try:
        limit = q.get("count") or q.get("limit") or q.get("timeout")
        if isinstance(limit, str) and limit.isdigit(): limit = int(limit)
        if isinstance(limit, float): limit = int(limit)
        if not isinstance(limit, int): limit = None
    except Exception: limit = None

    if not (b64 or pairing_code):
        try:
            await conexoes_ativas.send_message(
                f"inst:{inst_id}",
                {"type": "qrcode", "waiting": True, "instance": inst_id, "qr_limit": limit, "serverTimestamp": _server_ts_ms()}
            )
        except Exception as e:
            LOG(f"[QR EVT] Falha ao emitir estado 'waiting' para inst:{inst_id}: {e}")
        return

    await _emit_qr(inst_id, b64, pairing_code, limit)

INSTANCIAS_SYNC: set[str] = set()

@handler(EvoEvent.CONNECTION_UPDATE)
async def on_conn_update(first: str, payload: dict):
    inst_id = _inst_from(payload) or first
    record_rabbit_event("CONNECTION_UPDATE", inst_id)
    data = (payload.get("data") or payload) if isinstance(payload, dict) else {}

    st = str((data.get("state") or data.get("status") or "")).strip().lower()
    conectado = st in ("connected", "open")

    with SessionLocal() as db:
        inst = _get_inst_row(db, inst_id)
        if not inst:
            return

        inst.connected = bool(conectado)

        wuid = (data.get("id") or data.get("wid") or (data.get("me") or {}).get("id")) if isinstance(data, dict) else None
        if isinstance(wuid, str) and wuid.endswith("@s.whatsapp.net"):
            inst.numero_instancia = re.sub(r"\D", "", wuid.split("@", 1)[0])

        inst.last_seen = _now_utc()
        empresa_id = inst.empresa_id

        # pegamos aqui a preferência de histórico para decidir overlay
        historico_opcao = (inst.historico_restaurar or "none").lower()
        db.commit()

    if not conectado and st in ("close","closed","disconnected","logout","loggedout"):
        _mark_disconnected(inst_id)

    if conectado:
        # 0) cancela auto-cleanup do onboarding
        try:
            cancel_auto_cleanup(inst_id)
        except Exception as e:
            LOG(f"[CLEANUP] falha ao cancelar auto cleanup: {e}")

        # 1) mostrar overlay APENAS se vai haver importação de histórico
        if historico_opcao in ("24h", "7d") or (HISTORY_LIMIT_HOURS > 0):
            try:
                await conexoes_ativas.send_message(
                    f"emp:{empresa_id}", {"type": "history_sync_start", "total": 0, "serverTimestamp": _server_ts_ms()}
                )
                await conexoes_ativas.send_message(
                    f"emp:{empresa_id}", {"type": "history_sync_progress", "imported": 0, "total": 0, "serverTimestamp": _server_ts_ms()}
                )
            except Exception as e:
                LOG(f"[SYNC] falha ao emitir start/progress inicial: {e}")

        # 2) EXPANDE ASSINATURAS (anti-tempestade: só agora “abre a torneira”)
        _evo_expand_websocket(inst_id)
        _evo_expand_rabbit(inst_id)

    # eventos de conexão para instância e empresa
    await conexoes_ativas.send_message(
        f"inst:{inst_id}",
        {"type": "connection", "status": "CONNECTED" if conectado else "DISCONNECTED", "serverTimestamp": _server_ts_ms()}
    )
    await conexoes_ativas.send_message(
        f"emp:{empresa_id}",
        {"type": "connection", "inst_status": {"connected": bool(conectado), "instance": inst_id}, "reload_whatsapp": True, "serverTimestamp": _server_ts_ms()}
    )

    # dispara syncs no primeiro CONNECTED
    if conectado and inst_id not in INSTANCIAS_SYNC:
        INSTANCIAS_SYNC.add(inst_id)
        if SYNC_CONTACTS_ON_CONNECT:
            await _sync_contatos_completos(inst_id)
        if SYNC_CHATS_ON_CONNECT:
            await _sync_chats_completos(inst_id)
        if ENABLE_MESSAGES_SET:
            LOG("[MESSAGES_SET] aguardando histórico (none/24h/7d).")

def _mark_disconnected(instance: str):
    if not instance:
        return
    db: Session = SessionLocal()
    try:
        row = db.query(models.EmpresaInstancia).filter(
            models.EmpresaInstancia.instance_name == instance
        ).first()
        if row:
            row.connected = False
            row.last_seen = _now_utc()

            emp = db.query(models.Empresa).filter(models.Empresa.id == row.empresa_id).first()
            if emp and hasattr(emp, "quantidade_instancias"):
                emp.quantidade_instancias = db.query(models.EmpresaInstancia).filter(
                    models.EmpresaInstancia.empresa_id == emp.id,
                    models.EmpresaInstancia.connected.is_(True)
                ).count()
            db.commit()

            try:
                asyncio.create_task(
                    conexoes_ativas.send_message(f"emp:{row.empresa_id}", {"type":"reload_whatsapp", "serverTimestamp": _server_ts_ms()})
                )
            except Exception:
                pass
    finally:
        db.close()

async def on_logout_instance(instance: str, payload: dict):
    _mark_disconnected(instance)

HANDLERS[EvoEvent.LOGOUT_INSTANCE] = on_logout_instance
HANDLERS[EvoEvent.INSTANCE_DELETE] = on_logout_instance
HANDLERS[EvoEvent.REMOVE_INSTANCE] = on_logout_instance

# === [HANDLER: MESSAGES_UPSERT]  =============================================

@handler(EvoEvent.MESSAGES_UPSERT)
async def on_messages_upsert(inst_id: str, data):
    """
    Mensagens novas/atualizadas (1:1).

    Versão simplificada para:
    - sempre garantir INSERT de mensagem nova no BD
    - SEMPRE emitir no WebSocket (tempo real), mesmo se duplicada
    - evitar lógicas muito agressivas que possam travar tudo
    """

    with SessionLocal() as db:
        inst = _get_inst_row(db, inst_id)
        if not inst:
            LOG(f"[UPsert] instância não encontrada: {inst_id}")
            return

        empresa_id = inst.empresa_id
        me_number = _me_number_by_inst(inst)

        mensagens = extract_messages_any_shape(data)
        _log_ctx(
            "[UPsert] batch",
            inst=inst_id,
            empresa_id=empresa_id,
            total=len(mensagens),
            type_data=type(data).__name__,
        )

        if not mensagens:
            LOG("[UPsert] nenhum item reconhecido em payload.")
            return

        novas = 0

        for idx, m in enumerate(mensagens, start=1):
            try:
                if not isinstance(m, dict):
                    _log_skip("m não é dict", idx=idx, type_m=type(m).__name__)
                    continue

                key = m.get("key") or {}

                # 1) remote_jid pode vir em key.* ou no nível da mensagem (m.*)
                raw_remote = (
                    key.get("remoteJid")
                    or key.get("remote_jid")
                    or m.get("remoteJid")
                    or m.get("jid")
                    or m.get("chatId")
                    or ""
                )

                msg_id = key.get("id") or m.get("id")
                ts_raw = m.get("messageTimestamp") or m.get("timestamp") or 0
                status = m.get("status")

                _log_ctx(
                    "[UPsert][in]",
                    idx=idx,
                    msg_id=msg_id,
                    raw_remote=raw_remote,
                    keys=list(m.keys())[:15],
                    ts_raw=ts_raw,
                    status=status,
                )

                if not raw_remote:
                    _log_skip("sem remoteJid", idx=idx, msg_id=msg_id)
                    continue

                # 2) resolver @lid logo no início (Evolution/Redis) + fallback 1:1
                original_jid = raw_remote
                resolved_jid = _resolve_remote_jid(inst_id, raw_remote)
                if _is_lid_jid(original_jid) and not resolved_jid:
                    tel_fallback, alt = _resolve_counterparty_num_1to1(m, me_number)
                    _log_ctx(
                        "[UPsert][lid-fallback]",
                        idx=idx,
                        msg_id=msg_id,
                        tel_fallback=tel_fallback,
                        alt=_short(alt, 64),
                    )
                    if tel_fallback:
                        resolved_jid = f"{tel_fallback}@s.whatsapp.net"
                        _LID_CACHE.setdefault(inst_id, {})[
                            _jid_strip_device(original_jid)
                        ] = resolved_jid
                        try:
                            _lid_map_set(
                                empresa_id,
                                inst.id,
                                _jid_strip_device(original_jid),
                                resolved_jid,
                            )
                        except Exception as e:
                            _log_ctx("[UPsert][lid-cache-fail]", err=str(e))
                    else:
                        _log_skip(
                            "JID @lid sem mapping",
                            idx=idx,
                            msg_id=msg_id,
                            preview=_short(extract_text_from_baileys(m)),
                        )
                        continue

                remote_jid = resolved_jid or original_jid
                if remote_jid.endswith("@g.us"):
                    _log_skip("grupo", idx=idx, msg_id=msg_id, remote_jid=remote_jid)
                    continue

                # 3) extrai telefone; evita eco (meu próprio número)
                telefone = _remote_to_num(remote_jid)
                if not telefone:
                    _log_skip(
                        "telefone inválido",
                        idx=idx,
                        msg_id=msg_id,
                        remote_jid=remote_jid,
                    )
                    continue

                if me_number and telefone == me_number:
                    _log_skip(
                        "eco do meu número",
                        idx=idx,
                        msg_id=msg_id,
                        telefone=telefone,
                    )
                    continue

                # 4) from_me + dados básicos
                from_me = bool(key.get("fromMe", m.get("fromMe", False)))
                push_name = m.get("pushName") or m.get("senderName")
                formatted = formatar_telefone_br(telefone)
                ts_msg = _to_dt_utc(ts_raw)
                conteudo = extract_text_from_baileys(m)

                _log_ctx(
                    "[UPsert][resolved]",
                    idx=idx,
                    msg_id=msg_id,
                    remote_jid=remote_jid,
                    telefone=telefone,
                    from_me=from_me,
                    push_name=_short(push_name, 60),
                    ts=_iso_utc(ts_msg),
                    preview=_short(conteudo),
                )

                # 5) upsert cliente
                def _up():
                    return upsert_cliente(
                        db,
                        empresa_id=empresa_id,
                        instancia_id=inst.id,
                        telefone_raw=telefone,
                        nome=(formatted if from_me else (push_name or formatted)),
                        nome_whatsapp=(formatted if from_me else (push_name or formatted)),
                        avatar_url=None,
                    )

                cli_id = await _retry_deadlock(db, _up)
                if not cli_id:
                    _log_skip(
                        "upsert_cliente retornou None",
                        idx=idx,
                        msg_id=msg_id,
                        telefone=telefone,
                    )
                    continue

                # 6) vê se já existe no BD
                exists = False
                if msg_id:
                    exists = bool(
                        db.query(models.Mensagem.id)
                        .filter_by(cliente_id=cli_id, msg_id=msg_id)
                        .first()
                    )
                    if exists:
                        _log_skip(
                            "duplicada (msg_id)",
                            idx=idx,
                            msg_id=msg_id,
                            cliente_id=cli_id,
                        )

                # 7) ack inicial (apenas saída)
                ack_initial = _ack_from_status(status) if from_me else None

                msg_db_id = None
                if not exists:
                    # INSERT de fato
                    def _ins_msg():
                        msg_model = models.Mensagem(
                            empresa_id=empresa_id,
                            cliente_id=cli_id,
                            conteudo=conteudo,
                            tipo="saida" if from_me else "entrada",
                            lida=from_me,
                            ack=ack_initial,
                            timestamp=ts_msg,
                            msg_id=msg_id,
                            instancia_id=inst.id,
                        )
                        _carimbar_inst(msg_model, inst)
                        db.add(msg_model)
                        db.flush()
                        return msg_model.id

                    msg_db_id = await _retry_deadlock(db, _ins_msg)
                    novas += 1

                    _log_ctx(
                        "[UPsert][saved]",
                        idx=idx,
                        msg_id=msg_id,
                        saved_id=msg_db_id,
                        tipo=("saida" if from_me else "entrada"),
                        ack=ack_initial,
                        ts=_iso_utc(ts_msg),
                        preview=_short(conteudo),
                    )

                # 8) SEMPRE emitir no WS (tempo real), mesmo se exists=True
                try:
                    cliente = _fetch_cliente(db, cli_id)
                    await conexoes_ativas.send_message(
                        f"emp:{empresa_id}",
                        {
                            # contexto / roteamento
                            "empresa_id": empresa_id,
                            "cliente_id": cli_id,
                            "instancia_id": inst.id,
                            "instance_name": getattr(inst, "instance_name", None),

                            # dados para a lista/preview
                            "telefone": formatar_telefone_br(telefone),
                            "avatar_url": getattr(cliente, "avatar_url", None)
                            if cliente
                            else None,
                            "push_name": getattr(cliente, "nome_whatsapp", None)
                            if cliente
                            else None,
                            "nome": getattr(cliente, "nome", None)
                            if cliente
                            else formatted,

                            # conteúdo
                            "mensagem": conteudo,
                            "tipo": ("saida" if from_me else "entrada"),
                            "origem": ("atendente" if from_me else "cliente"),
                            "timestamp": _iso_utc(ts_msg),

                            # chaves de conciliação
                            "msg_id": msg_id or (str(msg_db_id) if msg_db_id else None),
                            "ack": (ack_initial if from_me else None),

                            # relógio do servidor
                            "serverTimestamp": _server_ts_ms(),
                        },
                    )
                except Exception as e:
                    LOG(f"[UPsert][ws] falha ao emitir: {e}")

                # commits periódicos pra não segurar lock demais
                if novas and (novas % max(1, HISTORY_BATCH_COMMIT)) == 0:
                    try:
                        db.commit()
                        _log_ctx("[UPsert][commit]", count=novas)
                    except Exception as e:
                        if _is_deadlock_error(e):
                            try:
                                db.rollback()
                            except Exception:
                                pass
                            _log_ctx(
                                "[UPsert][commit-deadlock-rollback]", err=str(e)
                            )
                        else:
                            raise

                if (novas % 500) == 0:
                    await asyncio.sleep(0)

            except Exception as e:
                if _is_deadlock_error(e):
                    try:
                        db.rollback()
                    except Exception:
                        pass
                    _log_ctx("[UPsert][deadlock-skip]", idx=idx, err=str(e))
                    continue
                LOG(f"[UPsert] erro em mensagem idx={idx}: {e}")

        # final do lote
        try:
            db.commit()
            _log_ctx("[UPsert][commit-final]", novas=novas)
        except Exception as e:
            if _is_deadlock_error(e):
                try:
                    db.rollback()
                except Exception:
                    pass
                _log_ctx("[UPsert][commit-final-deadlock-rollback]", err=str(e))
            else:
                raise

        # invalida cache de /conversas só se realmente teve novas
        try:
            if novas > 0 and empresa_id:
                _invalidate_emp_cache(empresa_id)
        except Exception:
            pass

        LOG(f"[UPsert] inst={inst_id} novas={novas}")



@handler(EvoEvent.CALL)
async def on_call(first: str, payload: dict | list):
    inst_name = _inst_from(payload) or first
    record_rabbit_event("CALL", inst_name)

    with SessionLocal() as db:
        inst_row = _get_inst_row(db, inst_name)
        if not inst_row:
            LOG(f"[CALL] Instância não encontrada no BD: {inst_name}")
            return

        empresa_id = inst_row.empresa_id
        me_num = _me_number_by_inst(inst_row)

        if isinstance(payload, list):
            items = [x for x in payload if isinstance(x, dict)]
        elif isinstance(payload, dict):
            data = payload.get("data")
            if isinstance(data, list):   items = [x for x in data if isinstance(x, dict)]
            elif isinstance(data, dict): items = [data]
            else:                        items = [payload]
        else:
            items = []

        if not items:
            try:
                await conexoes_ativas.send_message(f"emp:{empresa_id}", {"type": "call", "instance": inst_name, "items": [], "raw": None, "serverTimestamp": _server_ts_ms()})
            except Exception as e:
                LOG(f"[CALL] Falha ao emitir WS vazio: {e}")
            return

        def _num_of(s: str | None) -> str | None:
            if not isinstance(s, str):
                return None
            s = _jid_strip_device(s)
            if s.endswith("@s.whatsapp.net"):
                s = s.split("@", 1)[0]
            return normalizar_telefone(s)

        def _fmt_kind(kind: str | None) -> str:
            k = (kind or "").lower()
            if "video" in k: return "vídeo"
            if "screen" in k: return "compartilhar tela"
            if "voice" in k or "audio" in k: return "voz"
            return k or "chamada"

        def _fmt_status(st: str | None) -> str:
            s = (st or "").lower()
            map_ = {"ringing":"chamando","offer":"iniciada","accept":"atendida","accepted":"atendida","active":"em curso",
                    "end":"finalizada","ended":"finalizada","missed":"perdida","declined":"recusada","reject":"recusada",
                    "timeout":"sem resposta","busy":"ocupado"}
            return map_.get(s, s.upper() if s else "—")

        ws_items = []

        for raw in items:
            d = raw if isinstance(raw, dict) else {}
            call = d.get("call") if isinstance(d.get("call"), dict) else d

            call_id  = (call.get("id") or call.get("callId") or call.get("callID") or d.get("id"))
            c_from   = (call.get("from") or call.get("caller") or call.get("jid") or call.get("peer"))
            c_to     = (call.get("to") or call.get("callee"))
            c_type   = (call.get("type") or call.get("callType"))
            c_status = (call.get("status") or call.get("state") or d.get("status"))
            c_ts     = (call.get("timestamp") or call.get("ts") or d.get("timestamp"))

            from_num = _num_of(c_from)
            to_num   = _num_of(c_to)

            tipo_msg = None; other_num = None
            if me_num and from_num == me_num:
                tipo_msg = "saida"; other_num = to_num or from_num
            elif me_num and to_num == me_num:
                tipo_msg = "entrada"; other_num = from_num or to_num
            else:
                if from_num and from_num != me_num:
                    tipo_msg = "entrada"; other_num = from_num
                else:
                    tipo_msg = "saida";   other_num = to_num or from_num

            if not other_num:
                LOG(f"[CALL] Sem número do outro participante; ignorando item (id={call_id}).")
                continue

            nome_padrao = formatar_telefone_br(other_num)
            cli_id = upsert_cliente(
                db,
                empresa_id=empresa_id,
                instancia_id=inst_row.id,
                telefone_raw=other_num,
                nome=nome_padrao,
                nome_whatsapp=None,
                avatar_url=None
            )
            if not cli_id:
                continue
            cliente = _fetch_cliente(db, cli_id)

            msg_id = f"CALL:{call_id}" if call_id else None
            ts_dt = _to_dt_utc(c_ts)

            if msg_id and db.query(models.Mensagem.id).filter_by(cliente_id=cli_id, msg_id=msg_id).first():
                ws_items.append({
                    "id": call_id or None,"from": c_from or None,"from_num": from_num,"to": c_to or None,"to_num": to_num,
                    "timestamp_unix": _int_unix(ts_dt),
                    "timestamp": _iso_utc(ts_dt),
                    "timestamp_local": _iso_local(ts_dt),
                    "status": (c_status or "").upper(),"call_type": (c_type or "").lower() or None,
                    "is_group": bool(call.get("isGroup") or call.get("group") or False),
                })
                continue

            kind_txt = _fmt_kind(c_type)
            status_txt = _fmt_status(c_status)
            dir_txt = "enviada" if tipo_msg == "saida" else "recebida"
            conteudo = f"[Ligação] {kind_txt} – {dir_txt} ({status_txt})"

            m = models.Mensagem(
                empresa_id=empresa_id, cliente_id=cli_id, conteudo=conteudo,
                tipo=tipo_msg, lida=(tipo_msg == "saida"), ack=None,
                timestamp=ts_dt, msg_id=msg_id, instancia_id=inst_row.id,
            )
            _carimbar_inst(m, inst_row)
            db.add(m); db.flush()

            ws_items.append({
                "id": call_id or None,"from": c_from or None,"from_num": from_num,"to": c_to or None,"to_num": to_num,
                "timestamp_unix": _int_unix(ts_dt),
                "timestamp": _iso_utc(ts_dt),
                "timestamp_local": _iso_local(ts_dt),
                "status": (c_status or "").upper(),
                "call_type": (c_type or "").lower() or None,"is_group": bool(call.get("isGroup") or call.get("group") or False),
                "mensagem_id": m.id,"cliente_id": cli_id,
            })

            try:
                await conexoes_ativas.send_message(
                    f"emp:{empresa_id}",
                    {"empresa_id": empresa_id, "cliente_id": cli_id, "telefone": formatar_telefone_br(other_num),
                     "avatar_url": getattr(cliente, "avatar_url", None) if cliente else None,
                     "push_name": getattr(cliente, "nome_whatsapp", None) if cliente else None,
                     "nome": getattr(cliente, "nome", None) if cliente else nome_padrao,
                     "mensagem": conteudo, "tipo": tipo_msg, "origem": "sistema",
                     "timestamp": _iso_utc(ts_dt),
                     "timestamp_local": _iso_local(ts_dt),
                     "msg_id": msg_id or str(m.id),
                     "ack": None, "instancia_id": inst_row.id,
                     "serverTimestamp": _server_ts_ms()}
                )
            except Exception as e:
                LOG(f"[CALL] Falha ao emitir WS (linha mensagem): {e}")

        try:
            db.commit()
        except Exception as e:
            db.rollback()
            LOG(f"[CALL] Erro ao gravar mensagens de chamada: {e}")

        try:
            _invalidate_emp_cache(empresa_id)
        except Exception:
            pass

    try:
        await conexoes_ativas.send_message(f"emp:{empresa_id}", {"type": "call", "instance": inst_name, "items": ws_items, "serverTimestamp": _server_ts_ms()})
    except Exception as e:
        LOG(f"[CALL] Falha ao emitir WS resumo CALL: {e}")

def _grupo_row_by_remote(db: Session, empresa_id: int, remote_jid: str, instancia_id: int | None = None, inst_obj: models.EmpresaInstancia | None = None) -> models.Grupo:
    g = db.query(models.Grupo).filter(models.Grupo.empresa_id==empresa_id, models.Grupo.remote_jid==remote_jid).first()
    if g:
        if instancia_id and g.instancia_id is None:
            g.instancia_id = instancia_id
        if inst_obj and hasattr(g, "instance_name") and not getattr(g, "instance_name", None):
            g.instance_name = inst_obj.instance_name
        return g
    g = models.Grupo(empresa_id=empresa_id, remote_jid=remote_jid, nome="Grupo", instancia_id=instancia_id)
    if inst_obj and hasattr(g, "instance_name"):
        g.instance_name = inst_obj.instance_name
    db.add(g); db.flush()
    return g

def _name_from_contact_like(c: dict) -> str | None:
    for k in ("verifiedName","name","pushName","notifyName","formattedName","shortName","contactName","subject","title","displayName"):
        v = c.get(k)
        if isinstance(v, str) and v.strip(): return v.strip()
    return None

def _avatar_from_contact_like(c: dict) -> str | None:
    return (
        c.get("profilePicUrl")
        or (c.get("profilePicThumbObj") or {}).get("eurl")
        or c.get("thumbnailUrl")
        or c.get("imageUrl")
        or c.get("pictureUrl")
        or None
    )


# -------------------------------------------------------------------------------

@handler(EvoEvent.CONTACTS_UPSERT)
@handler(EvoEvent.CONTACTS_UPDATE)
@handler(EvoEvent.CONTACTS_SET)
async def on_contacts_event(first: str, payload: dict | list):
    # normaliza payload
    if isinstance(payload, list):
        norm = {"data": payload, "instance": first}
    elif isinstance(payload, dict):
        norm = payload if "data" in payload else {"data": payload, "instance": first}
    else:
        norm = {"data": [payload], "instance": first}

    inst_id = (_inst_from(norm) or first)
    record_rabbit_event("CONTACTS_UPDATE", inst_id)

    data = norm.get("data")
    contatos = extract_contacts_any_shape(data)
    if not contatos:
        return

    with SessionLocal() as db:
        inst = _get_inst_row(db, inst_id)
        if not inst:
            return
        empresa_id = inst.empresa_id

        me_num = _me_number_by_inst(inst)
        mudou = False
        processed = 0

        for c in contatos:
            if not isinstance(c, dict):
                continue

            remote = (c.get("remoteJid") or c.get("id") or c.get("wid") or "")

            # resolve @lid → @s.whatsapp.net (cache/Evolution/Redis)
            if isinstance(remote, str) and remote.endswith("@lid"):
                mapped = _resolve_remote_jid(inst_id, remote)
                if mapped:
                    remote = mapped
                else:
                    # tenta Redis (mapeamento aprendido anteriormente)
                    try:
                        rd = _lid_map_get(empresa_id, inst.id, _jid_strip_device(remote))
                        if rd:
                            _LID_CACHE.setdefault(inst_id, {})[_jid_strip_device(remote)] = rd
                            remote = rd
                    except Exception:
                        pass

            numero = _remote_to_num(remote)
            # se não conseguir extrair número válido OU for meu próprio número → ignora
            if not numero or (me_num and numero == me_num):
                continue

            nome_push = _name_from_contact_like(c)
            avatar = _avatar_from_contact_like(c)
            nome_default = nome_push or formatar_telefone_br(numero)

            # 🔒 upsert com retry em caso de deadlock
            try:
                cli_id = await _retry_deadlock(db, lambda: upsert_cliente(
                    db,
                    empresa_id=empresa_id,
                    instancia_id=inst.id,
                    telefone_raw=numero,
                    nome=nome_default,
                    nome_whatsapp=nome_push,
                    avatar_url=avatar
                ))
                if cli_id:
                    mudou = True
            except Exception as e:
                # MUITO IMPORTANTE: rollback para limpar a transação
                try:
                    db.rollback()
                except Exception:
                    pass
                print(f"[CONTACTS] erro no upsert_cliente: {e}")
                continue

            processed += 1
            # cede o loop periodicamente em lotes grandes
            if (processed % 500) == 0:
                await asyncio.sleep(0)

        if mudou:
            try:
                db.commit()
            except Exception as e:
                if _is_deadlock_error(e):
                    try:
                        db.rollback()
                    except Exception:
                        pass
                else:
                    raise

            # avisa o front e invalida caches
            await conexoes_ativas.send_message(f"emp:{empresa_id}", {"type": "reload_clientes", "serverTimestamp": _server_ts_ms()})
            try:
                _invalidate_emp_cache(empresa_id)
            except Exception:
                pass



def _upsert_grupos_from_chats(db: Session, empresa_id: int, chats: list[dict], inst: models.EmpresaInstancia) -> int:
    imported = 0
    for ch in chats:
        jid = (ch.get("id") or ch.get("remoteJid") or ch.get("jid") or ch.get("wid") or "")
        if not isinstance(jid, str) or not jid.endswith("@g.us"): continue
        jid = _jid_strip_device(jid)
        nome = _name_from_contact_like(ch) or "Grupo"
        avatar = _avatar_from_contact_like(ch)
        g = db.query(models.Grupo).filter(models.Grupo.empresa_id==empresa_id, models.Grupo.remote_jid==jid).first()
        if not g:
            g = models.Grupo(empresa_id=empresa_id, remote_jid=jid, nome=nome, avatar_url=avatar,
                             instancia_id=inst.id, )
            db.add(g); imported += 1
        else:
            changed = False
            if g.instancia_id is None:
                g.instancia_id = inst.id; changed = True
            if hasattr(g, "instance_name") and not getattr(g, "instance_name", None):
                g.instance_name = getattr(inst, "instance_name", None); changed = True
            if nome and (g.nome or "") != nome: g.nome = nome; changed = True
            if avatar and (g.avatar_url or "") != avatar: g.avatar_url = avatar; changed = True
            if changed: imported += 1
    if imported: db.flush()
    return imported

_HISTORY_DONE_AT: dict[str, float] = {}

# === [HANDLER: MESSAGES_SET / histórico]  ====================================
@handler(EvoEvent.MESSAGES_SET)
async def on_messages_set(inst_id: str, data):
    """
    Import de histórico com LOG detalhado + overlay.
    NÃO emite cada mensagem no WS (para não lotar), apenas progresso/done.
    >>> Patch: passa a emitir no WS mensagens RECENTES do histórico (<= HISTORY_RECENT_WS_SEC).
    """
    if not ENABLE_MESSAGES_SET:
        LOG("[MESSAGES_SET] Ignorado (ENABLE_MESSAGES_SET=false).")
        return

    now_s = _now_utc().timestamp()
    last = _HISTORY_DONE_AT.get(inst_id)
    if last and (now_s - last) < (HISTORY_IGNORE_AFTER_DONE_MIN * 60):
        LOG(f"[MESSAGES_SET] Ignorado para {inst_id}: já finalizado há {int(now_s - last)}s.")
        return

    PROG_STEP = 100

    with SessionLocal() as db:
        inst = _get_inst_row(db, inst_id)
        if not inst:
            LOG(f"Instância não encontrada: {inst_id}")
            return

        empresa_id = inst.empresa_id
        historico_opcao = (inst.historico_restaurar or "none").lower()

        # downgrade do 7d via env
        if historico_opcao == "7d" and not ALLOW_HISTORY_7D:
            _log_ctx("[HIST] downgrade 7d→24h", inst=inst_id)
            historico_opcao = "24h"

        mensagens = extract_messages_any_shape(data)
        total = len(mensagens)

        _log_ctx("[HIST] start",
                 inst=inst_id, empresa_id=empresa_id,
                 historico_opcao=historico_opcao, total=total,
                 DISABLE_MEDIA_ON_HISTORY=DISABLE_MEDIA_ON_HISTORY,
                 HISTORY_MAX_IMPORT=HISTORY_MAX_IMPORT,
                 HISTORY_BATCH_COMMIT=HISTORY_BATCH_COMMIT)

        try:
            await conexoes_ativas.send_message(
                f"emp:{empresa_id}",
                {"type": "history_sync_start", "total": total, "serverTimestamp": _server_ts_ms()}
            )
        except Exception:
            pass

        if historico_opcao == "none" or not mensagens:
            try:
                await conexoes_ativas.send_message(
                    f"emp:{empresa_id}",
                    {"type": "history_sync_done", "total": total, "imported": 0, "serverTimestamp": _server_ts_ms()}
                )
            except Exception:
                pass
            return

        got_lock = _try_acquire_hist_lock(db, empresa_id, inst.id)
        if not got_lock:
            LOG(f"[MESSAGES_SET] lock ocupado para emp={empresa_id} inst={inst.id} — outro import rodando; saindo.")
            return

        try:
            # limite temporal
            if HISTORY_LIMIT_HOURS > 0:
                limite_tempo = _now_utc() - timedelta(hours=HISTORY_LIMIT_HOURS)
            else:
                dias = 1 if historico_opcao == "24h" else (7 if historico_opcao == "7d" else 0)
                limite_tempo = _now_utc() - timedelta(days=dias)

            novas = 0
            me_num = _me_number_by_inst(inst)
            cap = max(1, int(HISTORY_MAX_IMPORT))

            _log_ctx("[HIST] janela/limites",
                     limite_utc=_iso_utc(limite_tempo),
                     cap=cap)

            # janela para emitir mensagens recentes do histórico no WS
            try:
                RECENT_SEC = int(os.getenv("HISTORY_RECENT_WS_SEC", "120"))
            except Exception:
                RECENT_SEC = 120

            for idx, m in enumerate(mensagens, start=1):
                if novas >= cap:
                    _log_ctx("[HIST] cap atingido", novas=novas, cap=cap)
                    break

                if not isinstance(m, dict):
                    _log_ctx("[HIST][skip] m não é dict", idx=idx, type_m=type(m).__name__)
                    continue

                key = (m.get("key") or {})
                remote_jid = key.get("remoteJid") or key.get("remote_jid") or m.get("remoteJid") or m.get("jid") or m.get("chatId")
                msg_id = key.get("id") or m.get("id")
                ts_raw = m.get("messageTimestamp") or m.get("timestamp") or 0

                try:
                    ts_msg = _to_dt_utc(ts_raw)
                except Exception:
                    _log_ctx("[HIST][skip] ts inválido", idx=idx, msg_id=msg_id, ts_raw=ts_raw)
                    continue

                if ts_msg < limite_tempo:
                    _log_ctx("[HIST][skip] fora da janela", idx=idx, msg_id=msg_id, ts=_iso_utc(ts_msg))
                    continue

                if not remote_jid:
                    _log_ctx("[HIST][skip] sem remoteJid", idx=idx, msg_id=msg_id)
                    continue

                original_jid = remote_jid
                resolved_jid = _resolve_remote_jid(inst_id, remote_jid)
                if _is_lid_jid(original_jid) and not resolved_jid:
                    tel_fallback, _ = _resolve_counterparty_num_1to1(m, me_num)
                    _log_ctx("[HIST][lid-fallback]", idx=idx, msg_id=msg_id, tel_fallback=tel_fallback)
                    if tel_fallback:
                        resolved_jid = f"{tel_fallback}@s.whatsapp.net"
                        _LID_CACHE.setdefault(inst_id, {})[_jid_strip_device(original_jid)] = resolved_jid
                        try:
                            _lid_map_set(empresa_id, inst.id, _jid_strip_device(original_jid), resolved_jid)
                        except Exception as e:
                            _log_ctx("[HIST][lid-cache-fail]", err=str(e))
                    else:
                        _log_ctx("[HIST][skip] @lid sem mapping", idx=idx, msg_id=msg_id)
                        continue

                remote_jid = resolved_jid or original_jid

                # ===== GRUPO =====
                if remote_jid.endswith("@g.us"):
                    from_me   = bool(key.get("fromMe", False))
                    author_j  = key.get("participant") or m.get("participant") or ""
                    conteudo  = extract_text_from_baileys(m)
                    ts_int    = _int_unix(ts_msg)

                    grupo = _grupo_row_by_remote(db, empresa_id, _jid_strip_device(remote_jid), instancia_id=inst.id, inst_obj=inst)
                    name = _name_from_contact_like(m) or m.get("pushName")
                    avatar = _avatar_from_contact_like(m)
                    if name and (grupo.nome or "") != name:
                        grupo.nome = name
                    if avatar and (grupo.avatar_url or "") != avatar:
                        grupo.avatar_url = avatar
                    _carimbar_inst(grupo, inst)

                    if msg_id and db.query(models.MensagemGrupo.id).filter_by(grupo_id=grupo.id, msg_id=msg_id).first():
                        _log_ctx("[HIST][skip] duplicada (grupo)", idx=idx, msg_id=msg_id, grupo_id=grupo.id)
                        continue

                    def _ins_grupo():
                        msgg = models.MensagemGrupo(
                            empresa_id=empresa_id, grupo_id=grupo.id, author_jid=author_j, from_me=from_me,
                            conteudo=conteudo, message_type=m.get("messageType"), lida=from_me,
                            timestamp=ts_int, msg_id=msg_id, ack=_ack_from_status(m.get("status")) if from_me else None,
                            instancia_id=inst.id
                        )
                        _carimbar_inst(msgg, inst)
                        db.add(msgg); db.flush()
                        return msgg.id

                    msgg_id = await _retry_deadlock(db, _ins_grupo)
                    novas += 1
                    _log_ctx("[HIST][saved][grupo]", idx=idx, msg_id=msg_id, saved_id=msgg_id,
                             ts=_iso_utc(ts_msg), preview=_short(conteudo))

                else:
                    # ===== 1:1 =====
                    telefone = _remote_to_num(remote_jid)
                    if not telefone:
                        _log_ctx("[HIST][skip] telefone inválido", idx=idx, msg_id=msg_id, remote_jid=remote_jid)
                        continue

                    from_me   = bool(key.get("fromMe", False))
                    conteudo  = extract_text_from_baileys(m)

                    media_meta = None if DISABLE_MEDIA_ON_HISTORY else extract_media_meta(m)

                    def _up():
                        return upsert_cliente(
                            db,
                            empresa_id=empresa_id,
                            instancia_id=inst.id,
                            telefone_raw=telefone,
                            nome=formatar_telefone_br(telefone),
                            nome_whatsapp=None,
                            avatar_url=None
                        )
                    cli_id = await _retry_deadlock(db, _up)
                    if not cli_id:
                        _log_ctx("[HIST][skip] upsert_cliente None", idx=idx, msg_id=msg_id, telefone=telefone)
                        continue

                    if msg_id and db.query(models.Mensagem.id).filter_by(cliente_id=cli_id, msg_id=msg_id).first():
                        _log_ctx("[HIST][skip] duplicada (1:1)", idx=idx, msg_id=msg_id, cliente_id=cli_id)
                        # (do histórico) não emitimos duplicadas aqui
                        continue

                    ack_initial = _ack_from_status(m.get("status"))
                    ack_initial = ack_initial if from_me else None

                    def _ins_msg():
                        msg_model = models.Mensagem(
                            empresa_id=empresa_id, cliente_id=cli_id, conteudo=conteudo,
                            tipo="saida" if from_me else "entrada", lida=from_me, ack=ack_initial,
                            timestamp=ts_msg, msg_id=msg_id, instancia_id=inst.id
                        )
                        _carimbar_inst(msg_model, inst)
                        db.add(msg_model); db.flush()
                        return msg_model.id

                    msg_db_id = await _retry_deadlock(db, _ins_msg)
                    novas += 1
                    _log_ctx("[HIST][saved][1:1]", idx=idx, msg_id=msg_id, saved_id=msg_db_id,
                             telefone=telefone, ts=_iso_utc(ts_msg), preview=_short(conteudo),
                             media=("off" if DISABLE_MEDIA_ON_HISTORY else ("on" if media_meta else "none")))

                    # >>>>> PATCH WS-LIVE (somente mensagens recentes do histórico) <<<<<
                    try:
                        is_recent = abs((_now_utc() - ts_msg).total_seconds()) <= RECENT_SEC
                    except Exception:
                        is_recent = False
                    if is_recent:
                        try:
                            # mesmos campos que o on_messages_upsert emite (para o front tratar igual)
                            cliente = db.query(models.Cliente).filter_by(id=cli_id).first()
                            await conexoes_ativas.send_message(
                                f"emp:{empresa_id}",
                                {
                                    # contexto / roteamento
                                    "empresa_id":  empresa_id,
                                    "cliente_id":  cli_id,
                                    "instancia_id": inst.id,
                                    "instance_name": getattr(inst, "instance_name", None),

                                    # dados para a lista/preview
                                    "telefone": formatar_telefone_br(telefone),
                                    "avatar_url": getattr(cliente, "avatar_url", None) if cliente else None,
                                    "push_name": getattr(cliente, "nome_whatsapp", None) if cliente else None,
                                    "nome": getattr(cliente, "nome", None) if cliente else formatar_telefone_br(telefone),

                                    # conteúdo que o front espera
                                    "mensagem":  conteudo,
                                    "tipo":      ("saida" if from_me else "entrada"),
                                    "origem":    ("atendente" if from_me else "cliente"),
                                    "timestamp": _iso_utc(ts_msg),

                                    # chaves de conciliação/RT
                                    "msg_id": (msg_id or str(msg_db_id)),
                                    "ack":    (ack_initial if from_me else None),

                                    # para badge de lag
                                    "serverTimestamp": int(_now_utc().timestamp() * 1000),
                                }
                            )
                        except Exception as e:
                            _log_ctx("[HIST][ws-live] falha ao emitir", idx=idx, msg_id=msg_id, err=str(e))

                    # mídia (se habilitada)
                    if media_meta:
                        try:
                            raw = None
                            real_name = media_meta.get("filename") or (f"{msg_id}.bin" if msg_id else "file")
                            real_ct   = media_meta.get("mimetype")
                            real_len  = None

                            if msg_id:
                                try:
                                    conv = True if (media_meta and media_meta.get("tipo") == "video") else None
                                    evo_raw, evo_name, evo_ct, evo_len = _evo_get_base64_media(inst_id, msg_id, convert_to_mp4=conv)
                                    raw, real_len = evo_raw, evo_len
                                    if evo_ct:   real_ct = evo_ct
                                    if evo_name: real_name = evo_name
                                except Exception as e:
                                    _log_ctx("[HIST][midia] base64 falhou", idx=idx, msg_id=msg_id, err=str(e))

                            if raw is None:
                                b64 = media_meta.get("base64")
                                if b64:
                                    raw, mt_from = _b64_to_bytes(b64)
                                    if mt_from: real_ct = mt_from
                                    real_len = len(raw) if raw else None

                            if raw is None and msg_id:
                                try:
                                    dl_bytes, dl_name, dl_ct, dl_len = _download_media_bytes(inst_id, msg_id, None)
                                    raw, real_len = dl_bytes, dl_len
                                    if dl_ct and dl_ct.lower() != "application/octet-stream": real_ct = dl_ct
                                    if dl_name and not dl_name.lower().endswith(".enc"): real_name = dl_name
                                except Exception as e:
                                    _log_ctx("[HIST][midia] download falhou", idx=idx, msg_id=msg_id, err=str(e))

                            if raw:
                                real_ct_norm = _normalize_mimetype(media_meta["tipo"], real_name, real_ct)
                                _save_midia_db(
                                    db, empresa_id=empresa_id, cliente_id=cli_id, mensagem_id=msg_db_id,
                                    tipo=media_meta["tipo"], filename=real_name or "file",
                                    mimetype_=real_ct_norm, raw=raw, url_origem=None, content_length=real_len,
                                    instancia_id=inst.id
                                )
                                _log_ctx("[HIST][midia] salva", idx=idx, msg_id=msg_id, name=real_name, mimetype=real_ct_norm, size=real_len)
                        except Exception as e:
                            _log_ctx("[HIST][midia] erro ao salvar", idx=idx, msg_id=msg_id, err=str(e))

                # progresso/log periódico
                if novas % PROG_STEP == 0:
                    try:
                        await conexoes_ativas.send_message(
                            f"emp:{empresa_id}",
                            {"type": "history_sync_progress", "imported": novas, "total": total, "serverTimestamp": _server_ts_ms()}
                        )
                    except Exception:
                        pass
                    _log_ctx("[HIST] progress", imported=novas, total=total)

                # commits pequenos
                if novas % max(1, HISTORY_BATCH_COMMIT) == 0:
                    try:
                        db.commit()
                        _log_ctx("[HIST] commit", imported=novas)
                    except Exception as e:
                        if _is_deadlock_error(e):
                            try: db.rollback()
                            except Exception: pass
                            await asyncio.sleep(0.1)
                            _log_ctx("[HIST] commit-deadlock-rollback]", err=str(e))
                        else:
                            raise

                if novas % max(1, HISTORY_SLEEP_EVERY) == 0:
                    await asyncio.sleep(0)

            # final
            try:
                db.commit()
                _log_ctx("[HIST] commit-final", imported=novas)
            except Exception as e:
                if _is_deadlock_error(e):
                    try: db.rollback()
                    except Exception: pass
                    _log_ctx("[HIST] commit-final-deadlock-rollback]", err=str(e))
                else:
                    raise

            try:
                await conexoes_ativas.send_message(f"emp:{empresa_id}", {"type": "reload_clientes", "serverTimestamp": _server_ts_ms()})
            except Exception:
                pass
            try:
                await conexoes_ativas.send_message(
                    f"emp:{empresa_id}",
                    {"type": "history_sync_done", "total": total, "imported": novas, "serverTimestamp": _server_ts_ms()}
                )
            except Exception:
                pass

            try:
                _invalidate_emp_cache(empresa_id)
            except Exception:
                pass

            if historico_opcao != "none" and novas > 0:
                _HISTORY_DONE_AT[inst_id] = now_s

        finally:
            # sempre solta o lock
            try:
                _release_hist_lock(db, empresa_id, inst.id)
            except Exception:
                pass



@handler(EvoEvent.MESSAGES_UPDATE)
async def on_messages_update(first: str, payload: dict | list):
    """
    Recebe atualizações de status/ack do Evolution/Baileys.
    Publica WS 'type: ack' (com serverTimestamp) para emp:{empresa} e inst:{inst}.
    """
    raw = payload
    data = raw["data"] if isinstance(raw, dict) and isinstance(raw.get("data"), (dict, list)) else raw
    updates = data if isinstance(data, list) else [data]
    if not updates or (len(updates) == 1 and not isinstance(updates[0], dict)):
        print("[ACK DEBUG] MESSAGES_UPDATE sem updates válidos.")
        return

    emp_id: int | None = None
    inst_name: str | None = None
    params: list[dict] = []
    cli_by_msg: dict[str, int] = {}

    with SessionLocal() as db:
        # --- descobrir empresa pela instância ---
        try:
            inst_name = (payload.get("instance") if isinstance(payload, dict) else None) or first
            if inst_name:
                emp_id = _empresa_id_by_inst(db, inst_name)
        except Exception as e:
            print(f"[ACK DEBUG] Falha resolvendo empresa: {e}")

        # --- normalizar e coletar updates relevantes ---
        for u in updates:
            if not isinstance(u, dict):
                continue
            key_id = (u.get("keyId") or (u.get("key") or {}).get("id") or u.get("messageId"))
            status = u.get("status") or u.get("ack")
            new_ack = _ack_from_status(status)
            if key_id and new_ack > 0:
                p = {"msg_id": str(key_id), "new_ack": int(new_ack)}
                if emp_id:
                    p["emp_id"] = int(emp_id)
                params.append(p)

        if not params:
            return

        # --- UPDATE em lote (só aumenta ack) ---
        where = "msg_id = :msg_id AND tipo = 'saida'"
        if emp_id:
            where += " AND empresa_id = :emp_id"

        try:
            db.execute(
                text(f"""
                    UPDATE mensagens
                       SET ack = CASE
                                   WHEN COALESCE(ack, 0) < :new_ack THEN :new_ack
                                   ELSE ack
                                 END
                     WHERE {where}
                """),
                params,  # executemany
            )
            db.commit()
        except Exception as e:
            print(f"[ACK DEBUG] Erro no UPDATE de ACKs: {e}")
            return

        try:
            if emp_id:
                _invalidate_emp_cache(int(emp_id))
        except Exception:
            pass

        # --- mapear msg_id -> cliente_id para incluir no WS ---
        try:
            from sqlalchemy import bindparam  # import local p/ evitar depender do topo do arquivo
            msg_ids = tuple({p["msg_id"] for p in params})
            if msg_ids:
                base = "SELECT msg_id, cliente_id FROM mensagens WHERE msg_id IN :ids"
                args = {"ids": list(msg_ids)}
                if emp_id:
                    base += " AND empresa_id = :emp_id"
                    args["emp_id"] = int(emp_id)

                q = text(base).bindparams(bindparam("ids", expanding=True))
                rows = db.execute(q, args).fetchall()
                for r in rows or []:
                    try:
                        mid, cid = str(r[0]), int(r[1]) if r[1] is not None else None
                        if mid and cid:
                            cli_by_msg[mid] = cid
                    except Exception:
                        continue
        except Exception as e:
            print(f"[ACK DEBUG] Falha buscando cliente_id por msg_id: {e}")

    # --- enviar no WS (empresa/instância) ---
    targets = []
    if inst_name:
        targets.append(f"inst:{inst_name}")
    if emp_id:
        targets.append(f"emp:{emp_id}")
    if not targets:
        return

    for p in params:
        payload_ws = {
            "type": "ack",
            "msg_id": p["msg_id"],
            "ack": p["new_ack"],
            "cliente_id": cli_by_msg.get(p["msg_id"]),
            "serverTimestamp": _server_ts_ms(),
        }
        for target in targets:
            try:
                await conexoes_ativas.send_message(target, payload_ws)
            except Exception as e:
                print(f"[ACK DEBUG] Falha ao emitir WS para {target}: {e}")



@handler(EvoEvent.PRESENCE_UPDATE)
async def on_presence_update(first: str, payload: dict | list):
    record_rabbit_event("PRESENCE_UPDATE", _inst_from(payload) or first)

# =========================
# Sync helpers (usados no connect)
# =========================
async def _sync_contatos_completos(inst_id: str):
    with SessionLocal() as db:
        inst = _get_inst_row(db, inst_id)
        if not inst: return
        empresa_id = inst.empresa_id

        contatos = []
        try:
            url = f"{EVOLUTION_URL}/chat/findContacts/{inst_id}"
            r = requests.post(url, headers=HEADERS, json={"where": {}}, timeout=60)
            LOG(f"[CONTACTS] POST {url} -> {r.status_code}")
            if r.status_code in (200,201):
                js = r.json()
                contatos = extract_contacts_any_shape(js) or [js] if isinstance(js, dict) else []
        except Exception as e:
            LOG(f"[CONTACTS] erro ao buscar: {e}"); return

        total = len(contatos); imported = 0
        await conexoes_ativas.send_message(f"emp:{empresa_id}", {"type":"contacts_sync_start","total": total, "serverTimestamp": _server_ts_ms()})

        me_num = _me_number_by_inst(inst)
        mudou = False

        for idx, c in enumerate(contatos, start=1):
            remote = (c.get("remoteJid") or c.get("id") or c.get("wid") or "")
            if isinstance(remote, str) and remote.endswith("@lid"):
                mapped = _resolve_remote_jid(inst_id, remote)
                if mapped:
                    remote = mapped
                else:
                    try:
                        rd = _lid_map_get(empresa_id, inst.id, _jid_strip_device(remote))
                        if rd:
                            _LID_CACHE.setdefault(inst_id, {})[_jid_strip_device(remote)] = rd
                            remote = rd
                    except Exception:
                        pass

            numero = _remote_to_num(remote)
            if not numero or (me_num and numero == me_num):
                continue

            nome_push = _name_from_contact_like(c)
            avatar = _avatar_from_contact_like(c)
            nome_default = nome_push or formatar_telefone_br(numero)

            cli_id = upsert_cliente(
                db,
                empresa_id=empresa_id,
                instancia_id=inst.id,
                telefone_raw=numero,
                nome=nome_default,
                nome_whatsapp=nome_push,
                avatar_url=avatar
            )
            if cli_id:
                imported += 1
                mudou = True

            if idx % 25 == 0:
                await conexoes_ativas.send_message(f"emp:{empresa_id}", {"type":"contacts_sync_progress","total": total,"imported": imported, "serverTimestamp": _server_ts_ms()})

        if mudou: db.commit()
        await conexoes_ativas.send_message(f"emp:{empresa_id}", {"type":"contacts_sync_done","total": total,"imported": imported, "serverTimestamp": _server_ts_ms()})
        await conexoes_ativas.send_message(f"emp:{empresa_id}", {"type":"reload_clientes", "serverTimestamp": _server_ts_ms()})

        try:
            _invalidate_emp_cache(empresa_id)
        except Exception:
            pass

async def _sync_chats_completos(inst_id: str):
    with SessionLocal() as db:
        inst = _get_inst_row(db, inst_id)
        if not inst: return
        empresa_id = inst.empresa_id

        chats = []
        try:
            url = f"{EVOLUTION_URL}/chat/findChats/{inst_id}"
            r = requests.post(url, headers=HEADERS, json={"where": {}}, timeout=60)
            LOG(f"[CHATS] POST {url} -> {r.status_code}")
            if r.status_code in (200,201):
                js = r.json()
                chats = extract_chats_any_shape(js)
        except Exception as e:
            LOG(f"[CHATS] erro ao buscar: {e}")

        if not chats: return

        before = db.query(models.Grupo).filter(models.Grupo.empresa_id==empresa_id).count()
        _upsert_grupos_from_chats(db, empresa_id, chats, inst)
        db.commit()
        after = db.query(models.Grupo).filter(models.Grupo.empresa_id==empresa_id).count()
        if after != before:
            await conexoes_ativas.send_message(f"emp:{empresa_id}", {"type":"reload_grupos","total": after, "serverTimestamp": _server_ts_ms()})

# =========================
# Forçar QR no WS (usado pelo main)
# =========================
async def force_qr_now_async(inst_id: str):
    if not EVOLUTION_FORCE_QR_ON_WS:
        return
    # ---- Lock leve para evitar rajadas (reconexões, múltiplas abas)
    if not qr_force_lock_acquire(inst_id, ttl_sec=3):
        LOG(f"[QR WS] force_qr ignorado por lock (inst={inst_id})")
        return
    # ---- segue fluxo atual
    try:
        js = await asyncio.to_thread(_evo_connect, inst_id)
        if isinstance(js, dict):
            b64, pc, limit = _extract_qr_fields(js)
            if b64 or pc:
                await _emit_qr(inst_id, b64, pc, limit)
    except Exception as e:
        LOG(f"[QR WS] falha ao forçar QR: {e}")

async def force_qr_for_instance(inst_id: str):
    return await force_qr_now_async(inst_id)

# =========================
# Rebinds de segurança (export)
# =========================
HANDLERS[EvoEvent.MESSAGES_UPSERT] = on_messages_upsert
HANDLERS[EvoEvent.MESSAGES_UPDATE] = on_messages_update
HANDLERS[EvoEvent.CONTACTS_SET]    = on_contacts_event
HANDLERS[EvoEvent.CONTACTS_UPDATE] = on_contacts_event
HANDLERS[EvoEvent.CONTACTS_UPSERT] = on_contacts_event

__all__ = [
    "HANDLERS", "EvoEvent", "handler",
    "force_qr_for_instance", "normalize_mimetype",
    "RABBIT_MONITOR", "record_rabbit_event", "get_rabbit_monitor",
]
