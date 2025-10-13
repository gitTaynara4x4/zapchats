# backend/routers/auto_messages.py
# ─────────────────────────────────────────────────────────────────────────────
# Módulo de "auto mensagens" SEM rotas HTTP (webhook). Uso interno por WS/Rabbit.
# Chame:
#   await maybe_send_auto_message_async(
#       empresa_id=..., instancia_id=..., instance_slug=...,
#       cliente_id=..., number=..., is_group=False
#   )
# ─────────────────────────────────────────────────────────────────────────────
from __future__ import annotations

import os
import json
import uuid
import logging
from dataclasses import dataclass, asdict
from datetime import datetime, time, timezone, timedelta
from typing import Any, Optional

from zoneinfo import ZoneInfo

import httpx
from sqlalchemy import select, func, text as sqltext
from sqlalchemy.orm import Session

from backend.database import SessionLocal
from backend import models

# --------------------------------------------------------------------------
# Redis helpers (no-op se não houver Redis)
# --------------------------------------------------------------------------
try:
    from backend.cache.redis_client import (
        k as _rk,
        set_json as _rset,
    )
except Exception:  # fallback seguro
    def _rk(*parts: str) -> str:
        return ":".join(str(p) for p in parts if p is not None and p != "")

    def _rset(*_a, **_k):
        pass

_AUTO_IGNORE_TTL = int(os.getenv("AUTO_IGNORE_NEXT_TTL", "90") or "90")

# --------------------------------------------------------------------------
# Logging
# --------------------------------------------------------------------------
_LOGLEVEL = os.getenv("AUTO_MESSAGES_LOGLEVEL", "INFO").upper()
logger = logging.getLogger("auto_messages")
if not logger.handlers:
    logging.basicConfig(
        level=getattr(logging, _LOGLEVEL, logging.INFO),
        format="%(asctime)s | %(levelname)s | %(name)s | %(message)s",
    )
logger.setLevel(getattr(logging, _LOGLEVEL, logging.INFO))

def _mask_number(n: Optional[str]) -> str:
    if not n:
        return ""
    n = str(n)
    if len(n) <= 6:
        return "***"
    return n[:4] + "****" + n[-2:]

def _ctx_str(**k) -> str:
    safe = []
    for key, val in k.items():
        if key in ("number", "telefone"):
            val = _mask_number(val)
        safe.append(f"{key}={val}")
    return " | " + " ".join(safe)

def _utcnow() -> datetime:
    return datetime.now(timezone.utc)

# --------------------------------------------------------------------------
# Timezone helpers (tolerante a nomes inválidos / Windows)
# --------------------------------------------------------------------------
_TZ_ALIASES = {
    "UTC": "Etc/UTC",
    "Z": "Etc/UTC",
    "GMT": "Etc/GMT",
    "UTC+0": "Etc/UTC",
    "UTC-0": "Etc/UTC",
    "GMT0": "Etc/UTC",
    # Se quiser, adicione "BRT": "America/Sao_Paulo"
}

def _safe_zoneinfo(tzname: Optional[str]):
    name = (tzname or "").strip() or "Etc/UTC"
    name = _TZ_ALIASES.get(name, name)
    try:
        return ZoneInfo(name)
    except Exception:
        logger.warning("timezone '%s' não encontrada; usando UTC", name)
        return timezone.utc

# --------------------------------------------------------------------------
# Evolution (env)
# --------------------------------------------------------------------------
EVOLUTION_URL = os.getenv("EVOLUTION_URL", "").rstrip("/")
EVOLUTION_KEY = os.getenv("EVOLUTION_APIKEY") or os.getenv("EVOLUTION_KEY") or ""

if not EVOLUTION_URL:
    logger.warning("EVOLUTION_URL não definido.")
if not EVOLUTION_KEY:
    logger.warning("EVOLUTION_APIKEY/EVOLUTION_KEY não definido.")

# --------------------------------------------------------------------------
# Modelos (estruturas internas deste módulo)
# --------------------------------------------------------------------------
@dataclass
class Schedule:
    start: str  # "HH:MM" (string vazia quando não houver)
    end: str    # "HH:MM" (string vazia quando não houver)

@dataclass
class AutoSection:
    enabled: bool
    schedule: Schedule
    text: str

@dataclass
class AutoConfig:
    timezone: str
    welcome: AutoSection
    off_hours: AutoSection
    per_instance: Optional[dict[str, Any]] = None  # Apenas textos/overrides opcionais

# --------------------------------------------------------------------------
# Utilitários de horário
# --------------------------------------------------------------------------
def _parse_hhmm(hhmm: str) -> time:
    hh, mm = map(int, hhmm.split(":"))
    return time(hh, mm)

def is_within(start_hhmm: str, end_hhmm: str, now_dt: datetime) -> bool:
    """
    True se 'now_dt' está entre start e end no dia corrente.
    Suporta janela que cruza meia-noite (ex.: 18:00 -> 08:00).
    Requer strings "HH:MM" válidas.
    """
    start_t = _parse_hhmm(start_hhmm)
    end_t   = _parse_hhmm(end_hhmm)
    now_t   = now_dt.time()
    if start_t <= end_t:
        return start_t <= now_t <= end_t
    else:
        return (now_t >= start_t) or (now_t <= end_t)

def _hms_or_none(v) -> Optional[str]:
    """
    Converte coluna (Time/str) para "HH:MM" ou None.
    - Aceita datetime.time, "HH:MM" ou None/"".
    """
    if v is None:
        return None
    if hasattr(v, "strftime"):
        try:
            return v.strftime("%H:%M")
        except Exception:
            return None
    s = str(v).strip()
    if not s:
        return None
    try:
        hh, mm = map(int, s.split(":"))
        if 0 <= hh <= 23 and 0 <= mm <= 59:
            return f"{hh:02d}:{mm:02d}"
    except Exception:
        pass
    return None

def _sec_has_valid_window(sec: AutoSection) -> bool:
    return bool(
        sec.enabled and (sec.schedule.start or "").strip() and (sec.schedule.end or "").strip()
    )

# --------------------------------------------------------------------------
# Helpers de BD / Regras
# --------------------------------------------------------------------------
def _is_bot_enabled(db: Session, empresa_id: int, instancia_id: int) -> bool:
    row = db.execute(
        select(models.ChatbotConfig)
        .where(
            models.ChatbotConfig.empresa_id == empresa_id,
            models.ChatbotConfig.instancia_id == instancia_id,
            models.ChatbotConfig.ativo == True,  # noqa: E712
        )
        .limit(1)
    ).scalar_one_or_none()
    ok = bool(row)
    logger.debug("check bot_enabled -> %s%s", ok, _ctx_str(empresa_id=empresa_id, instancia_id=instancia_id))
    return ok

def _cliente_exists(db: Session, empresa_id: int, cliente_id: int) -> bool:
    cid = db.execute(
        select(models.Cliente.id)
        .where(models.Cliente.empresa_id == empresa_id,
               models.Cliente.id == cliente_id)
        .limit(1)
    ).scalar_one_or_none()
    ok = cid is not None
    logger.debug("check cliente_exists -> %s%s", ok, _ctx_str(empresa_id=empresa_id, cliente_id=cliente_id))
    return ok

def _inbound_count(db: Session, cliente_id: int) -> int:
    ct = int(db.execute(
        select(func.count(models.Mensagem.id))
        .where(models.Mensagem.cliente_id == cliente_id,
               models.Mensagem.tipo == "entrada")
    ).scalar() or 0)
    logger.debug("inbound_count=%s%s", ct, _ctx_str(cliente_id=cliente_id))
    return ct

# Tolerância: se o seu modelo não tiver Mensagem.atendimento_id, não quebra.
def _has_msg_atd_field() -> bool:
    try:
        return hasattr(models.Mensagem, "atendimento_id")
    except Exception:
        return False

_HAS_MSG_ATD_FIELD = _has_msg_atd_field()

def _last_activity_at_for_atendimento(db: Session, atendimento_id: int) -> Optional[datetime]:
    last_msg = None
    if _HAS_MSG_ATD_FIELD:
        try:
            last_msg = db.execute(
                select(func.max(models.Mensagem.timestamp))
                .where(models.Mensagem.atendimento_id == atendimento_id)
            ).scalar()
        except Exception:
            last_msg = None

    if last_msg:
        logger.debug("last_activity via mensagem=%s%s", last_msg, _ctx_str(atendimento_id=atendimento_id))
        return last_msg

    base = db.execute(
        select(models.Atendimento.updated_at)
        .where(models.Atendimento.id == atendimento_id)
        .limit(1)
    ).scalar_one_or_none()
    logger.debug("last_activity via atendimento.updated_at=%s%s", base, _ctx_str(atendimento_id=atendimento_id))
    return base

# --------------------------------------------------------------------------
# Carregar config direto do BD (uso interno WS/Rabbit)
#   - Horários e 'enabled' → COLUNAS
#   - Textos → JSON (compat: features.auto_messages.welcome.text / off_hours.text)
#   - Timezone → coluna tz (fallback APP_TZ/TZ/UTC seguro)
# --------------------------------------------------------------------------
def _load_config_from_row(row: models.ChatbotConfig | None) -> AutoConfig:
    cfg_json = (row.config or {}) if row else {}
    am = (cfg_json.get("features") or {}).get("auto_messages", {}) or {}

    def _txt(path1: str, path2: str, default: str) -> str:
        # path1 = "welcome.text", path2="welcome_text"
        val = None
        try:
            if "." in path1:
                p1, p2 = path1.split(".", 1)
                val = ((am.get(p1) or {}).get(p2))
        except Exception:
            pass
        if not val:
            val = am.get(path2)
        return (val or default)

    welcome_text = _txt("welcome.text", "welcome_text", "Olá! 👋 Como posso ajudar?")
    off_text     = _txt(
        "off_hours.text",
        "off_text",
        "Estamos fora do horário. Deixe sua mensagem e responderemos no próximo expediente."
    )

    tzname = (getattr(row, "tz", None) or os.getenv("APP_TZ") or os.getenv("TZ") or "Etc/UTC")

    wel_en = bool(getattr(row, "welcome_enabled", False))
    wel_s  = _hms_or_none(getattr(row, "welcome_start", None))
    wel_e  = _hms_or_none(getattr(row, "welcome_end", None))

    off_en = bool(getattr(row, "off_enabled", False))
    off_s  = _hms_or_none(getattr(row, "off_start", None))
    off_e  = _hms_or_none(getattr(row, "off_end", None))

    return AutoConfig(
        timezone   = tzname,
        welcome    = AutoSection(
            enabled=wel_en,
            schedule=Schedule(start=wel_s or "", end=wel_e or ""),
            text=welcome_text
        ),
        off_hours  = AutoSection(
            enabled=off_en,
            schedule=Schedule(start=off_s or "", end=off_e or ""),
            text=off_text
        ),
        per_instance = am.get("per_instance") or None,
    )

# --------------------------------------------------------------------------
# Escolher mensagem automática
#   - NENHUM default de 08–18.
#   - Se OFF não tiver janela e estiver enabled, e WELCOME for válido → OFF = complemento do WELCOME.
#   - Prioridade OFF > WELCOME.
# --------------------------------------------------------------------------
def pick_auto_message(cfg: AutoConfig, *, now_utc: datetime, instance_name: Optional[str]) -> Optional[str]:
    # Override por instância apenas para texto/timezone (se existir no JSON).
    am_override = (cfg.per_instance or {}).get(instance_name) if (cfg.per_instance and instance_name) else None

    tzname = (am_override.get("timezone") if am_override else None) or cfg.timezone or "Etc/UTC"
    now = now_utc.astimezone(_safe_zoneinfo(tzname))
    logger.debug("pick_auto_message: now_local=%s tz=%s override=%s", now.isoformat(), tzname, bool(am_override))

    wel = cfg.welcome
    off = cfg.off_hours

    wel_valid = _sec_has_valid_window(wel)
    off_valid = _sec_has_valid_window(off)

    within_welcome = False
    if wel_valid:
        within_welcome = is_within(wel.schedule.start, wel.schedule.end, now)

    within_off = False
    if off.enabled:
        if off_valid:
            within_off = is_within(off.schedule.start, off.schedule.end, now)
        elif wel_valid:
            # se OFF habilitado mas sem janela, e WELCOME definido → OFF = complemento
            within_off = not within_welcome

    # PRIORIDADE: OFF > WELCOME
    if within_off:
        msg = ((am_override or {}).get("off_hours", {}) or {}).get("text") or off.text or ""
        msg = msg.strip()
        if msg:
            logger.info("pick_auto_message: chose=off_hours")
            return msg

    if within_welcome:
        msg = ((am_override or {}).get("welcome", {}) or {}).get("text") or wel.text or ""
        msg = msg.strip()
        if msg:
            logger.info("pick_auto_message: chose=welcome")
            return msg

    logger.info("pick_auto_message: chose=None")
    return None

# --------------------------------------------------------------------------
# Enviar via Evolution
# --------------------------------------------------------------------------
async def evolution_send_text(*, instance: str, number: str, text: str) -> dict[str, Any]:
    if not EVOLUTION_URL or not EVOLUTION_KEY:
        logger.error("evolution_send_text: EVOLUTION_URL/KEY ausentes")
        raise Exception("Evolution não configurado (EVOLUTION_URL/EVOLUTION_APIKEY).")

    url = f"{EVOLUTION_URL}/message/sendText/{instance}"
    payload = {"number": number, "text": text}
    logger.info("evolution_send_text: POST %s%s", url, _ctx_str(instance=instance, number=number, text_len=len(text)))

    async with httpx.AsyncClient(timeout=15.0) as client:
        r = await client.post(url, json=payload, headers={"apikey": EVOLUTION_KEY})

    logger.info("evolution_send_text: status=%s", r.status_code)
    if r.status_code >= 400:
        logger.error("evolution_send_text: erro status=%s body=%s", r.status_code, r.text)
        raise Exception(f"Evolution erro: {r.text}")

    ctype = r.headers.get("content-type", "")
    if ctype.startswith("application/json"):
        try:
            body = r.json()
        except Exception:
            body = {"_raw": r.text[:500]}
        logger.debug("evolution_send_text: resp=%s", json.dumps(body, ensure_ascii=False)[:1000])
        return body
    else:
        logger.debug("evolution_send_text: resp_non_json=%s", r.text[:500])
        return {"ok": True, "text": text}

# --------------------------------------------------------------------------
# Função interna para WS/Rabbit (sem HTTP)
# --------------------------------------------------------------------------
async def maybe_send_auto_message_async(
    *,
    empresa_id: int,
    instancia_id: int,
    instance_slug: str,
    cliente_id: int,
    number: str,
    is_group: bool = False,
) -> dict:
    """
    Chame ISSO logo após persistir uma MENSAGEM DE ENTRADA 1:1.
    Faz as checagens e, se devido, envia a mensagem automática via Evolution.
    • Envia SOMENTE na primeira mensagem de entrada do cliente (cnt == 1).
    • Após enviar, seta um flag no Redis para o evo_handlers ignorar a
      promoção de status causada por essa auto-mensagem específica.
    """
    corr = str(uuid.uuid4())
    logger.info("MAYBE begin%s", _ctx_str(cid=corr, empresa_id=empresa_id, instancia_id=instancia_id,
                                          instance=instance_slug, cliente_id=cliente_id, number=number, is_group=is_group))

    if is_group:
        logger.info("MAYBE skip: group_chat%s", _ctx_str(cid=corr))
        return {"sent": False, "reason": "group_chat"}

    with SessionLocal() as db:
        # 1) BOT ativo?
        if not _is_bot_enabled(db, empresa_id, instancia_id):
            logger.info("MAYBE bot_disabled%s", _ctx_str(cid=corr))
            return {"sent": False, "reason": "bot_disabled"}

        # 2) cliente existe?
        if not _cliente_exists(db, empresa_id, cliente_id):
            logger.info("MAYBE cliente_not_in_db%s", _ctx_str(cid=corr))
            return {"sent": False, "reason": "cliente_not_in_db"}

        # 3) é a PRIMEIRA mensagem de entrada?
        cnt = _inbound_count(db, cliente_id)
        logger.info("MAYBE inbound_count=%s%s", cnt, _ctx_str(cid=corr))
        if cnt != 1:
            return {"sent": False, "reason": "not_first_inbound", "count": cnt}

        # 4) carregar config direto do BD (colunas + textos do JSON)
        row = db.execute(
            select(models.ChatbotConfig)
            .where(models.ChatbotConfig.empresa_id==empresa_id,
                   models.ChatbotConfig.instancia_id==instancia_id)
            .limit(1)
        ).scalar_one_or_none()
        if not row:
            logger.info("MAYBE no_config%s", _ctx_str(cid=corr))
            return {"sent": False, "reason": "no_config"}

        cfg = _load_config_from_row(row)
        logger.debug("MAYBE cfg%s", _ctx_str(cid=corr, tz=cfg.timezone, welcome=asdict(cfg.welcome), off=asdict(cfg.off_hours)))

        # 5) decidir mensagem
        text = pick_auto_message(cfg, now_utc=_utcnow(), instance_name=instance_slug)
        logger.info("MAYBE decision text=%s%s", bool(text), _ctx_str(cid=corr))
        if not text:
            return {"sent": False, "reason": "no_message_for_now"}

        # 6) enviar
        try:
            result = await evolution_send_text(instance=instance_slug, number=number, text=text)
            logger.info("MAYBE sent ok%s", _ctx_str(cid=corr))

            # 6.1) flag para o evo_handlers ignorar *a próxima* saída automática
            try:
                key = _rk("auto", "ignore_next_outgoing", "emp", str(empresa_id),
                          "inst", str(instancia_id), "cli", str(cliente_id))
                _rset(key, True, ttl=_AUTO_IGNORE_TTL)
                logger.debug("MAYBE set ignore flag ttl=%s%s", _AUTO_IGNORE_TTL, _ctx_str(cid=corr, key=key))
            except Exception:
                logger.debug("MAYBE ignore flag falhou (segue sem bloquear promoção)%s", _ctx_str(cid=corr))

            return {"sent": True, "text": text, "result": result}
        except Exception as e:
            logger.exception("MAYBE send fail%s", _ctx_str(cid=corr))
            return {"sent": False, "reason": "send_fail", "error": repr(e)}

# --------------------------------------------------------------------------
# Fechamento automático (24h) — uso interno por cron/job
# --------------------------------------------------------------------------
STATUS_RESOLVIDO = "resolvido"  # manter minúsculo

def finalize_inactive_atendimentos(
    db: Session,
    *,
    empresa_id: int,
    instancia_id: int,
    hours: int = 24,
) -> int:
    """
    Finaliza atendimentos (status != 'resolvido') cujo 'last activity' < agora - N horas.
    Retorna a quantidade finalizada.
    """
    cutoff = _utcnow() - timedelta(hours=hours)
    logger.info("FINALIZE begin%s", _ctx_str(empresa_id=empresa_id, instancia_id=instancia_id, hours=hours, cutoff=cutoff.isoformat()))

    abertos = db.execute(
        select(models.Atendimento.id)
        .where(
            models.Atendimento.empresa_id == empresa_id,
            models.Atendimento.instancia_id == instancia_id,
            models.Atendimento.status != STATUS_RESOLVIDO,
        )
    ).scalars().all()
    logger.info("FINALIZE open_count=%s%s", len(abertos), _ctx_str(empresa_id=empresa_id, instancia_id=instancia_id))

    n = 0
    for aid in abertos:
        last = _last_activity_at_for_atendimento(db, aid) or _utcnow()
        logger.debug("FINALIZE check aid=%s last=%s cutoff=%s", aid, last, cutoff)
        if last < cutoff:
            logger.info("FINALIZE closing aid=%s", aid)
            db.execute(
                sqltext("UPDATE atendimentos SET status=:st, ended_at=NOW(), updated_at=NOW() WHERE id=:aid"),
                {"st": STATUS_RESOLVIDO, "aid": aid}
            )
            n += 1
    try:
        db.commit()
    except Exception:
        logger.exception("FINALIZE commit failed")
        db.rollback()
        raise

    logger.info("FINALIZE done closed=%s%s", n, _ctx_str(empresa_id=empresa_id, instancia_id=instancia_id))
    return n
