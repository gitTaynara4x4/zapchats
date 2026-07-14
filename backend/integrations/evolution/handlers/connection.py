# backend/integrations/evolution/handlers/connection.py

from __future__ import annotations

import asyncio
import os
import re
import threading
from datetime import datetime, timezone
from typing import Any

import requests

from backend.database import SessionLocal
from backend import models
from backend.websocket_manager import conexoes_ativas
from backend.routers.cliente_onboarding import cancel_auto_cleanup

from .shared import EvoEvent, HANDLERS, handler
from ._state import (
    INSTANCIAS_SYNC,
    QR_RECENT,
    history_clear_messages_set_state,
    history_messages_set_started_at,
    history_messages_set_count,
    history_messages_set_last_total,
)
from ..utils.log_utils import LOG
from ..utils.time_utils import _now_utc, _server_ts_ms
from ..utils.cache_utils import invalidate_emp_cache
from ..repositories.instancias_repo import get_instancia_by_name


SYNC_CONTACTS_ON_CONNECT = (os.getenv("SYNC_CONTACTS_ON_CONNECT", "true").lower() == "true")
SYNC_CHATS_ON_CONNECT = (os.getenv("SYNC_CHATS_ON_CONNECT", "true").lower() == "true")
SYNC_ON_CONNECT_AFTER_QR = (os.getenv("SYNC_ON_CONNECT_AFTER_QR", "true").lower() == "true")
QR_CONNECT_SYNC_WINDOW_MIN = int(os.getenv("QR_CONNECT_SYNC_WINDOW_MIN", "30") or "30")


def _bool_env_value(name: str, default: bool = False) -> bool:
    raw = os.getenv(name)

    if raw is None:
        return bool(default)

    value = str(raw).strip().lower()

    if value in {"1", "true", "yes", "sim", "on"}:
        return True

    if value in {"0", "false", "no", "nao", "não", "off"}:
        return False

    return bool(default)


ENABLE_MESSAGES_SET = _bool_env_value("ENABLE_MESSAGES_SET", False)


def _float_env_value(name: str, default: float) -> float:
    try:
        raw = os.getenv(name)
        if raw is None or str(raw).strip() == "":
            return float(default)
        return float(raw)
    except Exception:
        return float(default)


def _int_env_value(name: str, default: int) -> int:
    try:
        raw = os.getenv(name)
        if raw is None or str(raw).strip() == "":
            return int(default)
        return int(raw)
    except Exception:
        return int(default)


# Reaplica settings depois do connection.open.
# Esse é o ponto crítico para a Evolution/Baileys gerar MESSAGES_SET.
HISTORY_REAPPLY_SETTINGS_AFTER_OPEN = _bool_env_value(
    "EVO_HISTORY_REAPPLY_SETTINGS_AFTER_OPEN",
    True,
)
HISTORY_SETTINGS_RETRY = _int_env_value("EVO_HISTORY_SETTINGS_RETRY", 3)
HISTORY_SETTINGS_RETRY_DELAY_SEC = _float_env_value("EVO_HISTORY_SETTINGS_RETRY_DELAY_SEC", 1.2)

# Watchdog:
# Se depois do force-open a Evolution não entregar MESSAGES_SET válido,
# reaplica rabbit/settings de novo algumas vezes.
HISTORY_WATCHDOG_ENABLED = _bool_env_value("EVO_HISTORY_WATCHDOG_ENABLED", True)
HISTORY_WATCHDOG_WAIT_SEC = max(1.0, _float_env_value("EVO_HISTORY_WATCHDOG_WAIT_SEC", 20.0))
HISTORY_WATCHDOG_REAPPLIES = max(0, _int_env_value("EVO_HISTORY_WATCHDOG_REAPPLIES", 2))

# Fallback quando a Evolution sincroniza contatos/chats, mas não emite MESSAGES_SET.
# Nesse caso buscamos mensagens já persistidas pela própria Evolution em /chat/findMessages
# e enviamos para o mesmo handler do MESSAGES_SET.
HISTORY_FINDMESSAGES_FALLBACK_ENABLED = _bool_env_value(
    "EVO_HISTORY_FINDMESSAGES_FALLBACK_ENABLED",
    True,
)
HISTORY_FINDMESSAGES_FALLBACK_LIMIT = max(1, _int_env_value("EVO_HISTORY_FINDMESSAGES_FALLBACK_LIMIT", 500))
HISTORY_FINDMESSAGES_FALLBACK_TIMEOUT_SEC = max(5, _int_env_value("EVO_HISTORY_FINDMESSAGES_FALLBACK_TIMEOUT_SEC", 60))
HISTORY_MANUAL_FALLBACK_DELAY_SEC = max(0.0, _float_env_value("EVO_HISTORY_MANUAL_FALLBACK_DELAY_SEC", 8.0))

# Segurança contra avalanche depois de rebuild/restart da Evolution:
# Por padrão, instância antiga que já estava conectada NÃO reconfigura Rabbit/WS de novo
# e NÃO dispara sync pesado.
RECONFIGURE_ALREADY_CONNECTED_ON_UPDATE = _bool_env_value(
    "RECONFIGURE_ALREADY_CONNECTED_ON_UPDATE",
    False,
)

# Janela para considerar uma instância como "primeiro login/QR recém-criado".
HISTORY_PENDING_FIRST_LOGIN_MAX_AGE_MIN = _int_env_value(
    "HISTORY_PENDING_FIRST_LOGIN_MAX_AGE_MIN",
    180,
)

# Corrige lixo legado no banco:
# se uma instância antiga já tinha numero_instancia salvo e ficou com
# historico_restaurar=24h/7d/30d/all preso, o connection.open limpa para none
# em vez de disparar MESSAGES_SET em reconexão normal.
AUTO_CLEAR_STALE_HISTORY_ON_CONNECT = _bool_env_value(
    "EVO_AUTO_CLEAR_STALE_HISTORY_ON_CONNECT",
    True,
)

EVOLUTION_URL = (os.getenv("EVOLUTION_URL") or "").rstrip("/")
EVOLUTION_KEY = os.getenv("EVOLUTION_APIKEY") or os.getenv("EVOLUTION_KEY") or ""
HEADERS = {"apikey": EVOLUTION_KEY, "Content-Type": "application/json"} if EVOLUTION_KEY else {}

FULL_EVENTS_WS = [
    "QRCODE_UPDATED",
    "CONNECTION_UPDATE",
]

# IMPORTANTE:
# Não usar GROUPS_UPDATE aqui.
# A Evolution aceita GROUP_UPDATE, sem "S".
# Se mandar GROUPS_UPDATE, /rabbitmq/set retorna 400 e o histórico MESSAGES_SET não chega.
FULL_EVENTS_RABBIT = [
    "MESSAGES_SET",
    "MESSAGES_UPSERT",
    "MESSAGES_UPDATE",
    "MESSAGES_DELETE",
    "SEND_MESSAGE",

    "CONTACTS_SET",
    "CONTACTS_UPSERT",
    "CONTACTS_UPDATE",

    "PRESENCE_UPDATE",

    "GROUPS_UPSERT",
    "GROUP_UPDATE",
    "GROUP_PARTICIPANTS_UPDATE",
]

HISTORY_SYNC_OPTIONS = {
    "24h",
    "7d",
    "30d",
    "all",
    "full",
    "tudo",
    "disponivel",
    "disponível",
    "available",
}

RABBIT_EXCHANGE = os.getenv("RABBITMQ_EXCHANGE_NAME", "evolution_exchange")


def _env_csv_first(*names: str, default: str = "#") -> list[str]:
    """
    Lê bindings de forma tolerante.

    Ordem:
    1. RABBITMQ_BINDINGS
    2. RABBITMQ_BINDING_KEY
    3. RABBITMQ_ROUTING_KEY
    4. default "#"
    """
    raw = None

    for name in names:
        value = os.getenv(name)
        if value is not None and str(value).strip():
            raw = value
            break

    if raw is None:
        raw = default

    out = [
        b.strip().strip('"').strip("'")
        for b in str(raw or default).split(",")
        if b.strip()
    ]

    return out or [default]


RABBIT_BINDINGS = _env_csv_first(
    "RABBITMQ_BINDINGS",
    "RABBITMQ_BINDING_KEY",
    "RABBITMQ_ROUTING_KEY",
    default="#",
)

# Task viva por instância para não disparar sync duplicada.
_CONNECT_SYNC_TASKS: dict[str, asyncio.Task] = {}


def _only_digits(raw: Any) -> str:
    return re.sub(r"\D", "", str(raw or ""))


def _normalize_historico_opcao(raw: str | None) -> str:
    h = str(raw or "none").strip().lower()

    if h in {"", "none", "no", "nao", "não", "off", "false", "0"}:
        return "none"

    if h in {"24h", "24", "1d", "1dia", "1_dia", "dia", "ultimas_24h", "últimas_24h"}:
        return "24h"

    if h in {"7d", "7", "7dias", "7_dias", "semana", "1w", "week"}:
        return "7d"

    if h in {
        "30d",
        "30",
        "30dias",
        "30_dias",
        "1m",
        "1mes",
        "1_mes",
        "mes",
        "mês",
        "month",
        "30days",
    }:
        return "30d"

    if h in {"all", "full", "tudo", "disponivel", "disponível", "available"}:
        return "all"

    return "none"


def _clean_whatsapp_number(raw: Any) -> str | None:
    """
    Extrai número real de valores comuns da Evolution.

    Aceita:
    - 5512999999999@s.whatsapp.net
    - 5512999999999@c.us
    - 5512999999999
    - +55 12 99999-9999

    Ignora:
    - grupos
    - lid
    - strings muito curtas
    """
    if raw is None:
        return None

    s = str(raw or "").strip()
    if not s:
        return None

    s_lower = s.lower()

    if "@g.us" in s_lower or "@lid" in s_lower:
        return None

    if "@" in s:
        left = s.split("@", 1)[0]
        digits = _only_digits(left)
    else:
        digits = _only_digits(s)

    if len(digits) < 10:
        return None

    if len(digits) > 15:
        return None

    return digits


def _extract_num_from_any(obj: Any, *, depth: int = 0) -> str | None:
    """
    Busca número em estruturas da Evolution.

    Faz busca segura e limitada em dict/list, priorizando campos conhecidos.
    """
    if depth > 4:
        return None

    if obj is None:
        return None

    if isinstance(obj, str):
        return _clean_whatsapp_number(obj)

    if isinstance(obj, (int, float)):
        return _clean_whatsapp_number(obj)

    if isinstance(obj, dict):
        priority_keys = [
            "ownerJid",
            "owner",
            "wuid",
            "wid",
            "jid",
            "remoteJid",
            "remote_jid",
            "number",
            "phone",
            "phoneNumber",
            "phone_number",
            "user",
            "id",
        ]

        for key in priority_keys:
            if key in obj:
                found = _extract_num_from_any(obj.get(key), depth=depth + 1)
                if found:
                    return found

        nested_keys = [
            "me",
            "account",
            "profile",
            "instance",
            "instanceInfo",
            "instance_info",
            "data",
            "connection",
        ]

        for key in nested_keys:
            if key in obj:
                found = _extract_num_from_any(obj.get(key), depth=depth + 1)
                if found:
                    return found

        for value in obj.values():
            found = _extract_num_from_any(value, depth=depth + 1)
            if found:
                return found

        return None

    if isinstance(obj, (list, tuple)):
        for item in obj:
            found = _extract_num_from_any(item, depth=depth + 1)
            if found:
                return found

    return None


def _extract_number_from_connection_payload(payload: dict | list, data: dict) -> str | None:
    found = _extract_num_from_any(data)
    if found:
        return found

    found = _extract_num_from_any(payload)
    if found:
        return found

    return None


def _obj_instance_name(obj: Any) -> str | None:
    if not isinstance(obj, dict):
        return None

    for key in ("instanceName", "instance_name", "instance", "name"):
        val = obj.get(key)
        if isinstance(val, str) and val.strip():
            return val.strip()

    nested = obj.get("instance")
    if isinstance(nested, dict):
        for key in ("instanceName", "instance_name", "instance", "name"):
            val = nested.get(key)
            if isinstance(val, str) and val.strip():
                return val.strip()

    return None


def _find_instance_obj_in_response(obj: Any, instance_name: str, *, depth: int = 0) -> dict | None:
    """
    Procura o objeto da instância dentro do retorno /instances.
    """
    if depth > 5:
        return None

    if isinstance(obj, dict):
        name = _obj_instance_name(obj)
        if name == instance_name:
            return obj

        for value in obj.values():
            found = _find_instance_obj_in_response(value, instance_name, depth=depth + 1)
            if found:
                return found

    elif isinstance(obj, list):
        for item in obj:
            found = _find_instance_obj_in_response(item, instance_name, depth=depth + 1)
            if found:
                return found

    return None


def _evo_fetch_connected_number(instance: str) -> str | None:
    """
    Fallback quando CONNECTION_UPDATE não traz número.

    Consulta a Evolution e tenta achar o ownerJid/number da instância.
    """
    if not (EVOLUTION_URL and HEADERS and instance):
        return None

    endpoints = [
        f"{EVOLUTION_URL}/instances",
        f"{EVOLUTION_URL}/instance/fetchInstances",
        f"{EVOLUTION_URL}/instance/connectionState/{instance}",
    ]

    for url in endpoints:
        try:
            r = requests.get(url, headers=HEADERS, timeout=15)
            if not r.ok:
                continue

            try:
                js = r.json()
            except Exception:
                continue

            if isinstance(js, list):
                inst_obj = _find_instance_obj_in_response(js, instance)
                if inst_obj:
                    num = _extract_num_from_any(inst_obj)
                    if num:
                        LOG(f"[CONNECTION] número encontrado via Evolution /instances inst={instance} numero={num}")
                        return num

            if isinstance(js, dict):
                inst_obj = _find_instance_obj_in_response(js, instance)
                if inst_obj:
                    num = _extract_num_from_any(inst_obj)
                    if num:
                        LOG(f"[CONNECTION] número encontrado via Evolution inst={instance} numero={num}")
                        return num

                num = _extract_num_from_any(js)
                if num:
                    LOG(f"[CONNECTION] número encontrado via Evolution direto inst={instance} numero={num}")
                    return num

        except Exception as e:
            LOG(f"[CONNECTION] falha buscando número na Evolution inst={instance}: {e}")

    return None


def _attach_numero_instancia_safely(db, inst, numero: str | None) -> str | None:
    """
    Salva numero_instancia evitando conflito com linha antiga da mesma empresa.
    """
    numero_digits = _clean_whatsapp_number(numero)
    if not numero_digits:
        return None

    try:
        inst_id = int(getattr(inst, "id", 0) or 0)
        empresa_id = int(getattr(inst, "empresa_id", 0) or 0)
    except Exception:
        inst_id = 0
        empresa_id = 0

    try:
        conflito = (
            db.query(models.EmpresaInstancia)
            .filter(
                models.EmpresaInstancia.empresa_id == empresa_id,
                models.EmpresaInstancia.numero_instancia == numero_digits,
                models.EmpresaInstancia.id != inst_id,
            )
            .first()
        )

        if conflito:
            LOG(
                "[CONNECTION] número já estava em outra instância da mesma empresa; "
                f"limpando conflito antigo atual={getattr(inst, 'instance_name', None)} "
                f"conflito={getattr(conflito, 'instance_name', None)} "
                f"numero={numero_digits}"
            )

            conflito.connected = False
            conflito.numero_instancia = None
            conflito.last_seen = _now_utc()
            db.add(conflito)

    except Exception as e:
        LOG(f"[CONNECTION] falha ao checar conflito de número: {e}")

    try:
        inst.numero_instancia = numero_digits
        db.add(inst)
        return numero_digits
    except Exception as e:
        LOG(f"[CONNECTION] falha ao setar numero_instancia: {e}")
        return None


def _inst_from_payload(first: str, payload: dict | list) -> str:
    if isinstance(payload, dict):
        for key in ("instance", "instanceName", "instanceId"):
            value = payload.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()

        data = payload.get("data")
        if isinstance(data, dict):
            for key in ("instance", "instanceName", "instanceId"):
                value = data.get(key)
                if isinstance(value, str) and value.strip():
                    return value.strip()

    return str(first or "").strip()


def _get_inst_row(db, instance: str):
    return get_instancia_by_name(db, instance_name=instance)


def _historico_pede_sync(historico_opcao: str | None) -> bool:
    h = _normalize_historico_opcao(historico_opcao)
    return h in {"24h", "7d", "30d"}


def _messages_set_deve_rodar(historico_opcao: str | None = None) -> bool:
    """MESSAGES_SET só roda quando existe importação pendente.

    A flag ENABLE_MESSAGES_SET é legada/informativa; ela não deve fazer o
    backend aceitar histórico sem o usuário escolher 24h, 7d ou 30d.
    """
    return _historico_pede_sync(historico_opcao)


def _fallback_message_count(payload: Any) -> int:
    try:
        from ..parsers.base_extractors import extract_messages_any_shape

        return len(extract_messages_any_shape(payload))
    except Exception:
        return 0


def _evo_findmessages_body_candidates(*, limit: int) -> list[dict[str, Any]]:
    # A Evolution mudou o formato aceito em algumas versões.
    # Por isso tentamos variações seguras, sempre com limite/cap.
    lim = max(1, int(limit or 500))
    return [
        {
            "where": {},
            "take": lim,
            "skip": 0,
            "orderBy": {"messageTimestamp": "desc"},
        },
        {
            "where": {},
            "take": lim,
            "skip": 0,
            "orderBy": {"createdAt": "desc"},
        },
        {
            "where": {},
            "limit": lim,
            "offset": 0,
            "orderBy": {"messageTimestamp": "desc"},
        },
        {
            "where": {},
            "page": 1,
            "limit": lim,
        },
        {
            "where": {},
            "page": 1,
            "offset": lim,
        },
        {
            "where": {},
            "take": lim,
        },
    ]


def _evo_fetch_findmessages_fallback_sync(instance: str, *, historico_opcao: str) -> tuple[Any | None, int, str]:
    if not (EVOLUTION_URL and HEADERS and instance):
        return None, 0, "missing_config"

    limit = max(1, int(HISTORY_FINDMESSAGES_FALLBACK_LIMIT or 500))
    timeout = max(5, int(HISTORY_FINDMESSAGES_FALLBACK_TIMEOUT_SEC or 60))

    endpoints = [
        f"{EVOLUTION_URL}/chat/findMessages/{instance}",
        f"{EVOLUTION_URL}/message/findMessages/{instance}",
    ]

    last_error = ""

    for url in endpoints:
        for body in _evo_findmessages_body_candidates(limit=limit):
            try:
                r = requests.post(
                    url,
                    headers=HEADERS,
                    json=body,
                    timeout=timeout,
                )

                if not r.ok:
                    last_error = f"{url} status={r.status_code} body={str(r.text or '')[:300]}"
                    continue

                try:
                    payload = r.json()
                except Exception:
                    last_error = f"{url} resposta_sem_json"
                    continue

                total = _fallback_message_count(payload)
                LOG(
                    f"[HISTORY][fallback-findMessages] resposta inst={instance} "
                    f"historico={historico_opcao} endpoint={url} total={total} "
                    f"body_keys={list(body.keys())}"
                )

                if total > 0:
                    return payload, total, "ok"

                # Guarda resposta vazia como fallback, mas continua tentando outros formatos.
                if last_error == "":
                    last_error = f"{url} ok_mas_total_0"

            except Exception as e:
                last_error = f"{url} erro={e}"

    return None, 0, last_error or "empty"


async def _history_findmessages_fallback(
    *,
    inst_id: str,
    historico_opcao: str,
    empresa_id: int | None,
    reason: str = "watchdog",
) -> bool:
    h = _normalize_historico_opcao(historico_opcao)

    if not HISTORY_FINDMESSAGES_FALLBACK_ENABLED:
        LOG(f"[HISTORY][fallback-findMessages] desabilitado inst={inst_id} reason={reason}")
        return False

    if not _historico_pede_sync(h):
        LOG(f"[HISTORY][fallback-findMessages] ignorado; histórico não pendente inst={inst_id} historico={h}")
        return False

    if _history_messages_set_arrived(inst_id):
        LOG(f"[HISTORY][fallback-findMessages] ignorado; MESSAGES_SET já chegou inst={inst_id}")
        return True

    LOG(
        f"[HISTORY][fallback-findMessages] iniciando inst={inst_id} "
        f"historico={h} reason={reason} limit={HISTORY_FINDMESSAGES_FALLBACK_LIMIT}"
    )

    await _emit_history_watchdog_progress(
        empresa_id,
        inst_id=inst_id,
        historico_opcao=h,
        status="fallback_findmessages_start",
        cycle=0,
        reapply_result={"reason": reason, "limit": HISTORY_FINDMESSAGES_FALLBACK_LIMIT},
    )

    payload, total, status = await asyncio.to_thread(
        _evo_fetch_findmessages_fallback_sync,
        inst_id,
        historico_opcao=h,
    )

    if not payload or total <= 0:
        LOG(
            f"[HISTORY][fallback-findMessages] sem mensagens para processar "
            f"inst={inst_id} historico={h} status={status}"
        )
        await _emit_history_watchdog_progress(
            empresa_id,
            inst_id=inst_id,
            historico_opcao=h,
            status="fallback_findmessages_empty",
            cycle=0,
            reapply_result={"status": status},
        )
        return False

    try:
        from .messages_set import on_messages_set

        LOG(
            f"[HISTORY][fallback-findMessages] chamando handler MESSAGES_SET manualmente "
            f"inst={inst_id} historico={h} total={total}"
        )
        await on_messages_set(inst_id, payload)

        await _emit_history_watchdog_progress(
            empresa_id,
            inst_id=inst_id,
            historico_opcao=h,
            status="fallback_findmessages_processed",
            cycle=0,
            reapply_result={"total": total},
        )
        return True

    except Exception as e:
        LOG(f"[HISTORY][fallback-findMessages] erro ao processar inst={inst_id}: {e}")
        await _emit_history_watchdog_progress(
            empresa_id,
            inst_id=inst_id,
            historico_opcao=h,
            status="fallback_findmessages_error",
            cycle=0,
            reapply_result={"error": str(e)[:300]},
        )
        return False


def trigger_history_findmessages_fallback_later(
    inst_id: str,
    historico_opcao: str,
    *,
    empresa_id: int | None = None,
    delay_sec: float | None = None,
    reason: str = "manual",
) -> bool:
    inst = str(inst_id or "").strip()
    if not inst:
        return False

    delay = HISTORY_MANUAL_FALLBACK_DELAY_SEC if delay_sec is None else max(0.0, float(delay_sec or 0.0))

    async def _runner() -> None:
        try:
            if delay > 0:
                await asyncio.sleep(delay)
            if _history_messages_set_arrived(inst):
                LOG(f"[HISTORY][fallback-findMessages] cancelado; MESSAGES_SET chegou antes inst={inst} reason={reason}")
                return
            await _history_findmessages_fallback(
                inst_id=inst,
                historico_opcao=historico_opcao,
                empresa_id=empresa_id,
                reason=reason,
            )
        except Exception as e:
            LOG(f"[HISTORY][fallback-findMessages] task erro inst={inst}: {e}")

    try:
        loop = asyncio.get_running_loop()
        loop.create_task(_runner())
    except RuntimeError:
        threading.Thread(target=lambda: asyncio.run(_runner()), daemon=True).start()

    LOG(
        f"[HISTORY][fallback-findMessages] agendado inst={inst} "
        f"historico={historico_opcao} delay={delay}s reason={reason}"
    )
    return True


def _qr_recente(inst_id: str) -> bool:
    try:
        now_s = int(_now_utc().timestamp())
        qr_s = QR_RECENT.get(inst_id)
        return bool(qr_s and (now_s - int(qr_s)) <= (QR_CONNECT_SYNC_WINDOW_MIN * 60))
    except Exception:
        return False


def _as_utc_dt(value: Any) -> datetime | None:
    if not value:
        return None

    if isinstance(value, datetime):
        if value.tzinfo is None:
            return value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc)

    try:
        s = str(value or "").strip()
        if not s:
            return None
        s = s.replace("Z", "+00:00")
        dt = datetime.fromisoformat(s)
        if dt.tzinfo is None:
            return dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)
    except Exception:
        return None


def _epoch_suffix_from_instance_name(instance_name: str) -> int | None:
    """
    Extrai timestamp Unix do final do nome:
    emp5-zapschataquinovo-auto-1778277055
    """
    try:
        m = re.search(r"-(\d{10})$", str(instance_name or "").strip())
        if not m:
            return None
        return int(m.group(1))
    except Exception:
        return None


def _inst_created_recent_for_history(inst: Any, inst_id: str) -> bool:
    """
    Define se a instância parece recém-criada.

    Objetivo:
    - permitir histórico no primeiro QR mesmo se was_connected=True no segundo CONNECTION_UPDATE;
    - evitar avalanche em instâncias antigas depois de restart/rebuild da Evolution.
    """
    max_min = max(1, int(HISTORY_PENDING_FIRST_LOGIN_MAX_AGE_MIN or 180))
    now = _now_utc()

    for attr in (
        "created_at",
        "criado_em",
        "data_criacao",
        "createdAt",
        "created_on",
        "inserted_at",
    ):
        try:
            dt = _as_utc_dt(getattr(inst, attr, None))
            if not dt:
                continue

            age_min = abs((now - dt).total_seconds()) / 60.0
            if age_min <= max_min:
                LOG(
                    f"[SYNC][connect] instância recente por {attr} "
                    f"inst={inst_id} age_min={age_min:.1f} max_min={max_min}"
                )
                return True
        except Exception:
            pass

    try:
        epoch = _epoch_suffix_from_instance_name(inst_id)
        if epoch:
            age_min = abs((now.timestamp() - float(epoch))) / 60.0
            if age_min <= max_min:
                LOG(
                    f"[SYNC][connect] instância recente por sufixo unix "
                    f"inst={inst_id} age_min={age_min:.1f} max_min={max_min}"
                )
                return True
    except Exception:
        pass

    return False


def _should_clear_stale_history_on_connect(
    *,
    conectado: bool,
    historico_pendente: bool,
    historico_primeiro_login: bool,
    numero_atual_db: Any,
) -> bool:
    """
    Decide se devemos limpar historico_restaurar antigo preso no banco.

    Regra:
    - Só limpa quando está conectado;
    - Só limpa quando historico_restaurar ainda pede histórico;
    - Nunca limpa se for primeiro login/QR recente;
    - Só limpa quando já existia numero_instancia ANTES desse connection.open.

    Isso evita matar histórico de uma instância recém-criada que acabou de ler QR,
    mas corrige instâncias antigas que ficaram presas com 24h/7d/30d/all.
    """
    if not AUTO_CLEAR_STALE_HISTORY_ON_CONNECT:
        return False

    if not conectado:
        return False

    if not historico_pendente:
        return False

    if historico_primeiro_login:
        return False

    # Ponto de segurança:
    # se já tinha número no banco antes desse evento, não é primeiro QR agora.
    if _clean_whatsapp_number(numero_atual_db):
        return True

    return False


def _history_settings_payload(sync_full_history: bool) -> dict:
    """
    Payload tolerante para settings da Evolution.

    O ponto principal é syncFullHistory.
    """
    return {
        "rejectCall": False,
        "msgCall": "",
        "groupsIgnore": False,
        "alwaysOnline": False,
        "readMessages": False,
        "readStatus": False,
        "syncFullHistory": bool(sync_full_history),
    }


def _evo_set_settings_history(instance: str, *, sync_full_history: bool) -> bool:
    """
    Reaplica settings depois do connection.open.

    Sem isso, o Rabbit pode estar com MESSAGES_SET habilitado,
    mas a Evolution/Baileys pode não gerar o pacote de histórico.
    """
    if not (EVOLUTION_URL and HEADERS and instance):
        LOG(
            f"[HISTORY][settings] não aplicado: EVOLUTION_URL/HEADERS/instance ausente "
            f"inst={instance}"
        )
        return False

    payload = _history_settings_payload(sync_full_history)

    urls = [
        f"{EVOLUTION_URL}/settings/set/{instance}",
        f"{EVOLUTION_URL}/instance/settings/{instance}",
    ]

    ok_any = False
    last_status = None
    last_body = ""

    for url in urls:
        try:
            r = requests.post(
                url,
                headers=HEADERS,
                json=payload,
                timeout=20,
            )

            last_status = r.status_code
            last_body = str(r.text or "")[:500]

            if r.ok:
                ok_any = True
                LOG(
                    f"[HISTORY][settings] syncFullHistory={bool(sync_full_history)} "
                    f"reaplicado após connection.open inst={instance} endpoint={url}"
                )
                break

        except Exception as e:
            last_body = str(e)[:500]

    if not ok_any:
        LOG(
            f"[HISTORY][settings] falha ao reaplicar syncFullHistory={bool(sync_full_history)} "
            f"inst={instance} status={last_status} body={last_body}"
        )

    return ok_any


def _evo_expand_websocket(instance: str) -> bool:
    if not (EVOLUTION_URL and HEADERS and instance):
        return False

    body = {
        "websocket": {
            "enabled": True,
            "events": FULL_EVENTS_WS,
        }
    }

    try:
        r = requests.post(
            f"{EVOLUTION_URL}/websocket/set/{instance}",
            headers=HEADERS,
            json=body,
            timeout=15,
        )

        if not r.ok:
            LOG(
                f"[WS] falha ao expandir inst={instance} "
                f"status={r.status_code} body={str(r.text or '')[:300]}"
            )
            return False

        LOG(f"[WS] expandido para inst={instance} -> {len(FULL_EVENTS_WS)} eventos")
        return True

    except Exception as e:
        LOG(f"[WS] falha ao expandir inst={instance}: {e}")
        return False


def _evo_rabbit_payloads() -> list[dict[str, Any]]:
    events = FULL_EVENTS_RABBIT
    return [
        {"rabbitmq": {"enabled": True, "events": events}},
        {"enabled": True, "events": events},
    ]


def _evo_expand_rabbit(instance: str) -> bool:
    """Reforça o Rabbit na Evolution com MESSAGES_SET ativo.

    Não enviamos exchange/bindings aqui: no endpoint por instância da Evolution
    esses campos não controlam a fila global do ZapsChat e podem quebrar algumas
    versões. O exchange global precisa estar no .env da própria Evolution API.
    """
    if not (EVOLUTION_URL and HEADERS and instance):
        return False

    last_status = None
    last_body = ""

    for body in _evo_rabbit_payloads():
        try:
            r = requests.post(
                f"{EVOLUTION_URL}/rabbitmq/set/{instance}",
                headers=HEADERS,
                json=body,
                timeout=20,
            )

            last_status = r.status_code
            last_body = str(r.text or "")[:500]

            if r.ok:
                LOG(
                    f"[Rabbit] expandido para inst={instance} "
                    f"events={len(FULL_EVENTS_RABBIT)} payload={'wrapper' if 'rabbitmq' in body else 'flat'}"
                )
                return True

        except Exception as e:
            last_body = str(e)[:500]

    LOG(
        f"[Rabbit] falha ao expandir inst={instance} "
        f"status={last_status} body={last_body}"
    )
    return False


async def _evo_force_history_settings_after_open(instance: str, *, historico_opcao: str | None) -> dict[str, Any]:
    """
    Força a ordem correta depois do QR lido:

    connection.open
    -> Rabbit com MESSAGES_SET
    -> settings syncFullHistory=true
    -> Rabbit de novo

    Isso não importa mensagens diretamente; só força a Evolution a emitir MESSAGES_SET.
    """
    h = _normalize_historico_opcao(historico_opcao)
    should_sync = _historico_pede_sync(h)

    result: dict[str, Any] = {
        "should_sync": bool(should_sync),
        "historico": h,
        "rabbit_before": None,
        "settings": None,
        "rabbit_after": None,
        "attempts": 0,
    }

    if not should_sync:
        LOG(f"[HISTORY][force-open] ignorado inst={instance} historico={h}")
        return result

    if not HISTORY_REAPPLY_SETTINGS_AFTER_OPEN:
        LOG(
            f"[HISTORY][force-open] desabilitado por EVO_HISTORY_REAPPLY_SETTINGS_AFTER_OPEN=false "
            f"inst={instance} historico={h}"
        )
        return result

    attempts = max(1, int(HISTORY_SETTINGS_RETRY or 1))
    delay = max(0.0, float(HISTORY_SETTINGS_RETRY_DELAY_SEC or 0.0))

    for attempt in range(1, attempts + 1):
        result["attempts"] = attempt

        rabbit_before = _evo_expand_rabbit(instance)
        settings_ok = _evo_set_settings_history(instance, sync_full_history=True)
        rabbit_after = _evo_expand_rabbit(instance)

        result["rabbit_before"] = bool(rabbit_before)
        result["settings"] = bool(settings_ok)
        result["rabbit_after"] = bool(rabbit_after)

        LOG(
            f"[HISTORY][force-open] tentativa={attempt}/{attempts} "
            f"inst={instance} historico={h} "
            f"rabbit_before={rabbit_before} settings={settings_ok} rabbit_after={rabbit_after}"
        )

        if settings_ok and (rabbit_before or rabbit_after):
            return result

        if attempt < attempts and delay > 0:
            await asyncio.sleep(delay)

    return result


async def _emit_history_watchdog_progress(
    empresa_id: int | None,
    *,
    inst_id: str,
    historico_opcao: str,
    status: str,
    cycle: int,
    reapply_result: dict[str, Any] | None = None,
) -> None:
    if empresa_id is None:
        return

    try:
        await conexoes_ativas.send_message(
            f"emp:{empresa_id}",
            {
                "type": "history_sync_progress",
                "imported": 0,
                "total": 0,
                "watchdog": {
                    "status": status,
                    "instance": inst_id,
                    "historico": historico_opcao,
                    "cycle": cycle,
                    "messages_set_count": history_messages_set_count(inst_id),
                    "messages_set_total": history_messages_set_last_total(inst_id),
                    "reapply_result": reapply_result,
                },
                "serverTimestamp": _server_ts_ms(),
            },
        )
    except Exception:
        pass


def _history_messages_set_arrived(inst_id: str) -> bool:
    """
    Só considera que o histórico chegou quando o MESSAGES_SET veio com mensagens.

    A Evolution pode mandar primeiro um MESSAGES_SET vazio:
    total=0

    Esse pacote vazio NÃO pode encerrar o watchdog.
    Se encerrar, o sistema para antes do pacote cheio chegar.
    """
    started_at = history_messages_set_started_at(inst_id)

    if started_at is None:
        return False

    try:
        total = int(history_messages_set_last_total(inst_id) or 0)
    except Exception:
        total = 0

    if total <= 0:
        LOG(
            f"[HISTORY][watchdog] MESSAGES_SET vazio recebido, mas ainda não conta como histórico válido "
            f"inst={inst_id} count={history_messages_set_count(inst_id)} last_total={total}"
        )
        return False

    return True


async def _history_watchdog_wait_and_retry(
    *,
    inst_id: str,
    historico_opcao: str,
    empresa_id: int | None,
) -> bool:
    """
    Aguarda o MESSAGES_SET chegar.

    Se não chegar, reaplica Rabbit/settings novamente.
    Isso corrige o caso onde a Evolution conecta, aceita settings,
    mas não entrega MESSAGES_SET válido na primeira tentativa.
    """
    h = _normalize_historico_opcao(historico_opcao)

    if not HISTORY_WATCHDOG_ENABLED:
        LOG(
            f"[HISTORY][watchdog] desabilitado por EVO_HISTORY_WATCHDOG_ENABLED=false "
            f"inst={inst_id} historico={h}"
        )
        return False

    if not _historico_pede_sync(h):
        LOG(f"[HISTORY][watchdog] ignorado; histórico não pendente inst={inst_id} historico={h}")
        return False

    if not _messages_set_deve_rodar(h):
        LOG(f"[HISTORY][watchdog] ignorado; MESSAGES_SET global desligado e sem histórico pendente inst={inst_id}")
        return False

    wait_sec = max(1.0, float(HISTORY_WATCHDOG_WAIT_SEC or 20.0))
    reapplies = max(0, int(HISTORY_WATCHDOG_REAPPLIES or 0))

    LOG(
        f"[HISTORY][watchdog] iniciado inst={inst_id} historico={h} "
        f"wait_sec={wait_sec} reapplies={reapplies}"
    )

    for cycle in range(0, reapplies + 1):
        if _history_messages_set_arrived(inst_id):
            LOG(
                f"[HISTORY][watchdog] MESSAGES_SET válido já chegou antes da espera "
                f"inst={inst_id} count={history_messages_set_count(inst_id)} "
                f"last_total={history_messages_set_last_total(inst_id)}"
            )
            await _emit_history_watchdog_progress(
                empresa_id,
                inst_id=inst_id,
                historico_opcao=h,
                status="arrived",
                cycle=cycle,
            )
            return True

        LOG(
            f"[HISTORY][watchdog] aguardando MESSAGES_SET válido "
            f"inst={inst_id} historico={h} cycle={cycle}/{reapplies} wait_sec={wait_sec}"
        )

        await asyncio.sleep(wait_sec)

        if _history_messages_set_arrived(inst_id):
            LOG(
                f"[HISTORY][watchdog] MESSAGES_SET válido chegou "
                f"inst={inst_id} historico={h} "
                f"count={history_messages_set_count(inst_id)} "
                f"last_total={history_messages_set_last_total(inst_id)}"
            )
            await _emit_history_watchdog_progress(
                empresa_id,
                inst_id=inst_id,
                historico_opcao=h,
                status="arrived",
                cycle=cycle,
            )
            return True

        if cycle < reapplies:
            LOG(
                f"[HISTORY][watchdog] MESSAGES_SET válido não chegou; reaplicando settings/rabbit "
                f"inst={inst_id} historico={h} cycle={cycle + 1}/{reapplies}"
            )

            reapply_result = await _evo_force_history_settings_after_open(
                inst_id,
                historico_opcao=h,
            )

            await _emit_history_watchdog_progress(
                empresa_id,
                inst_id=inst_id,
                historico_opcao=h,
                status="reapplied",
                cycle=cycle + 1,
                reapply_result=reapply_result,
            )

    LOG(
        f"[HISTORY][watchdog] MESSAGES_SET válido não chegou após tentativas "
        f"inst={inst_id} historico={h} reapplies={reapplies} wait_sec={wait_sec} "
        f"count={history_messages_set_count(inst_id)} last_total={history_messages_set_last_total(inst_id)}"
    )

    # Fallback real: algumas versões/configurações da Evolution sincronizam contatos/chats,
    # mas não publicam messages.set. Como o histórico pode já estar no banco da Evolution,
    # buscamos por /chat/findMessages e reaproveitamos o mesmo handler MESSAGES_SET.
    fallback_ok = await _history_findmessages_fallback(
        inst_id=inst_id,
        historico_opcao=h,
        empresa_id=empresa_id,
        reason="watchdog_not_arrived",
    )

    if fallback_ok:
        return True

    await _emit_history_watchdog_progress(
        empresa_id,
        inst_id=inst_id,
        historico_opcao=h,
        status="not_arrived",
        cycle=reapplies,
    )

    return False


def _mark_disconnected(instance: str):
    if not instance:
        return

    db = SessionLocal()
    try:
        row = (
            db.query(models.EmpresaInstancia)
            .filter(models.EmpresaInstancia.instance_name == instance)
            .first()
        )

        if row:
            row.connected = False
            row.last_seen = _now_utc()

            emp = db.query(models.Empresa).filter(models.Empresa.id == row.empresa_id).first()
            if emp and hasattr(emp, "quantidade_instancias"):
                emp.quantidade_instancias = (
                    db.query(models.EmpresaInstancia)
                    .filter(
                        models.EmpresaInstancia.empresa_id == emp.id,
                        models.EmpresaInstancia.connected.is_(True),
                    )
                    .count()
                )

            db.commit()

            try:
                asyncio.create_task(
                    conexoes_ativas.send_message(
                        f"emp:{row.empresa_id}",
                        {
                            "type": "reload_whatsapp",
                            "serverTimestamp": _server_ts_ms(),
                        },
                    )
                )
            except Exception:
                pass

            try:
                invalidate_emp_cache(row.empresa_id)
            except Exception:
                pass

    finally:
        db.close()


def _read_history_option_for_instance(inst_id: str) -> tuple[str, bool, int | None]:
    """
    Lê do banco a opção atual de histórico.

    Retorna:
    - historico_opcao normalizado
    - historico_pendente
    - empresa_id
    """
    with SessionLocal() as db:
        inst = _get_inst_row(db, inst_id)
        if not inst:
            return "none", False, None

        historico = _normalize_historico_opcao(getattr(inst, "historico_restaurar", None))
        empresa_id = getattr(inst, "empresa_id", None)

        try:
            empresa_id = int(empresa_id) if empresa_id is not None else None
        except Exception:
            empresa_id = None

        return historico, _historico_pede_sync(historico), empresa_id


async def _run_connect_sync_safe(inst_id: str) -> None:
    """
    Roda sync pós-conexão sem travar o handler CONNECTION_UPDATE.

    Também força a Evolution a gerar MESSAGES_SET quando histórico está pendente:
    - reaplica Rabbit com MESSAGES_SET;
    - reaplica settings syncFullHistory=true;
    - roda contatos/chats;
    - watchdog aguarda MESSAGES_SET válido e reaplica se não chegar.
    """
    try:
        from .contacts import sync_contatos_completos, sync_chats_completos

        historico_opcao, historico_pendente, empresa_id = _read_history_option_for_instance(inst_id)

        LOG(
            "[SYNC][connect] início "
            f"inst={inst_id} "
            f"contacts={SYNC_CONTACTS_ON_CONNECT} "
            f"chats={SYNC_CHATS_ON_CONNECT} "
            f"messages_set_env={ENABLE_MESSAGES_SET} "
            f"messages_set_effective={_messages_set_deve_rodar(historico_opcao)} "
            f"historico={historico_opcao} "
            f"historico_pendente={historico_pendente} "
            f"watchdog={HISTORY_WATCHDOG_ENABLED}"
        )

        if historico_pendente:
            force_result = await _evo_force_history_settings_after_open(
                inst_id,
                historico_opcao=historico_opcao,
            )

            LOG(
                f"[HISTORY][force-open] resultado inst={inst_id} "
                f"historico={historico_opcao} result={force_result}"
            )

            if empresa_id is not None:
                try:
                    await conexoes_ativas.send_message(
                        f"emp:{empresa_id}",
                        {
                            "type": "history_sync_progress",
                            "imported": 0,
                            "total": 0,
                            "force_open": force_result,
                            "serverTimestamp": _server_ts_ms(),
                        },
                    )
                except Exception:
                    pass

        if SYNC_CONTACTS_ON_CONNECT:
            try:
                await sync_contatos_completos(inst_id)
            except Exception as e:
                LOG(f"[SYNC][connect][contacts] falha inst={inst_id}: {e}")

        if SYNC_CHATS_ON_CONNECT:
            try:
                await sync_chats_completos(inst_id)
            except Exception as e:
                LOG(f"[SYNC][connect][chats] falha inst={inst_id}: {e}")

        if _messages_set_deve_rodar(historico_opcao):
            if historico_pendente:
                LOG(
                    f"[MESSAGES_SET] aguardando histórico após force-open "
                    f"inst={inst_id} historico={historico_opcao}"
                )

                await _history_watchdog_wait_and_retry(
                    inst_id=inst_id,
                    historico_opcao=historico_opcao,
                    empresa_id=empresa_id,
                )

            else:
                LOG(
                    f"[MESSAGES_SET] não aguardando histórico; historico_restaurar={historico_opcao} "
                    f"inst={inst_id}"
                )

        LOG(f"[SYNC][connect] fim inst={inst_id}")

    except asyncio.CancelledError:
        LOG(f"[SYNC][connect] cancelada inst={inst_id}")
        raise

    except Exception as e:
        LOG(f"[SYNC][connect] erro geral inst={inst_id}: {e}")

    finally:
        _CONNECT_SYNC_TASKS.pop(inst_id, None)


def _schedule_connect_sync(inst_id: str) -> None:
    """
    Agenda sync pós-conexão sem bloquear o evento principal.
    Também evita criar duas tasks iguais para a mesma instância.
    """
    if not inst_id:
        return

    old = _CONNECT_SYNC_TASKS.get(inst_id)
    if old and not old.done():
        LOG(f"[SYNC][connect] já existe task ativa inst={inst_id}; ignorando nova.")
        return

    try:
        task = asyncio.create_task(_run_connect_sync_safe(inst_id))
        _CONNECT_SYNC_TASKS[inst_id] = task

        def _done(t: asyncio.Task) -> None:
            try:
                t.result()
            except asyncio.CancelledError:
                pass
            except Exception as e:
                LOG(f"[SYNC][connect] task finalizou com erro inst={inst_id}: {e}")

        task.add_done_callback(_done)

    except Exception as e:
        LOG(f"[SYNC][connect] falha ao criar task inst={inst_id}: {e}")


def _cancel_connect_sync(inst_id: str) -> None:
    task = _CONNECT_SYNC_TASKS.pop(inst_id, None)
    if task and not task.done():
        try:
            task.cancel()
        except Exception:
            pass


@handler(EvoEvent.CONNECTION_UPDATE)
async def on_conn_update(first: str, payload: dict):
    inst_id = _inst_from_payload(first, payload)
    data = (payload.get("data") or payload) if isinstance(payload, dict) else {}

    st = str((data.get("state") or data.get("status") or "")).strip().lower()
    conectado = st in ("connected", "open")

    was_connected = False
    empresa_id = None
    historico_opcao = "none"
    historico_pendente = False
    historico_primeiro_login = False
    numero_instancia = None
    numero_atual_db = None

    with SessionLocal() as db:
        inst = _get_inst_row(db, inst_id)
        if not inst:
            return

        was_connected = bool(getattr(inst, "connected", False))
        numero_atual_db = getattr(inst, "numero_instancia", None)

        inst.connected = bool(conectado)

        if conectado:
            numero_payload = _extract_number_from_connection_payload(payload, data)

            if not numero_payload and (not was_connected or not numero_atual_db):
                numero_payload = _evo_fetch_connected_number(inst_id)

            if numero_payload:
                numero_instancia = _attach_numero_instancia_safely(db, inst, numero_payload)
                if numero_instancia:
                    LOG(f"[CONNECTION] numero_instancia salvo inst={inst_id} numero={numero_instancia}")
            else:
                numero_instancia = _clean_whatsapp_number(numero_atual_db)
                if not numero_instancia:
                    LOG(f"[CONNECTION] conectado mas sem número detectado inst={inst_id}")

        inst.last_seen = _now_utc()
        empresa_id = inst.empresa_id

        historico_opcao = _normalize_historico_opcao(getattr(inst, "historico_restaurar", None))
        historico_pendente = _historico_pede_sync(historico_opcao)

        historico_primeiro_login = bool(
            historico_pendente
            and (
                _qr_recente(inst_id)
                or _inst_created_recent_for_history(inst, inst_id)
            )
        )

        if _should_clear_stale_history_on_connect(
            conectado=bool(conectado),
            historico_pendente=bool(historico_pendente),
            historico_primeiro_login=bool(historico_primeiro_login),
            numero_atual_db=numero_atual_db,
        ):
            LOG(
                f"[SYNC][connect] limpando historico_restaurar antigo preso "
                f"inst={inst_id} historico={historico_opcao} "
                f"was_connected={was_connected} primeiro_login={historico_primeiro_login} "
                f"numero_atual_db={_clean_whatsapp_number(numero_atual_db) or '-'}"
            )

            try:
                inst.historico_restaurar = "none"
                historico_opcao = "none"
                historico_pendente = False
                historico_primeiro_login = False
            except Exception as e:
                LOG(f"[SYNC][connect] falha ao limpar historico_restaurar antigo inst={inst_id}: {e}")

        try:
            db.commit()
        except Exception as e:
            try:
                db.rollback()
            except Exception:
                pass
            LOG(f"[CONNECTION] falha ao salvar conexão inst={inst_id}: {e}")
            return

    if (not conectado) and (st in ("close", "closed", "disconnected", "logout", "loggedout")):
        INSTANCIAS_SYNC.discard(inst_id)
        QR_RECENT.pop(inst_id, None)
        history_clear_messages_set_state(inst_id)
        _cancel_connect_sync(inst_id)
        _mark_disconnected(inst_id)

    if conectado:
        try:
            cancel_auto_cleanup(inst_id)
        except Exception as e:
            LOG(f"[CLEANUP] falha ao cancelar auto cleanup: {e}")

        should_reconfigure = (
            (not was_connected)
            or RECONFIGURE_ALREADY_CONNECTED_ON_UPDATE
            or historico_primeiro_login
        )

        if should_reconfigure:
            rabbit_ok = _evo_expand_rabbit(inst_id)
            ws_ok = _evo_expand_websocket(inst_id)

            if historico_primeiro_login and was_connected:
                LOG(
                    f"[CONNECTION] reconfig permitida por histórico pendente/primeiro login "
                    f"inst={inst_id} historico={historico_opcao}"
                )
        else:
            rabbit_ok = None
            ws_ok = None

            if was_connected:
                if historico_pendente:
                    LOG(
                        f"[CONNECTION] reconfig ignorada inst={inst_id}: "
                        f"já estava conectado e histórico pendente não parece primeiro login "
                        f"(historico={historico_opcao})."
                    )
                else:
                    LOG(
                        f"[CONNECTION] reconfig ignorada inst={inst_id}: "
                        "já estava conectado (was_connected=True)."
                    )

        LOG(
            f"[CONNECTION] connected inst={inst_id} "
            f"was_connected={was_connected} "
            f"historico={historico_opcao} "
            f"historico_pendente={historico_pendente} "
            f"historico_primeiro_login={historico_primeiro_login} "
            f"numero={numero_instancia or '-'} "
            f"rabbit_ok={rabbit_ok} "
            f"ws_ok={ws_ok}"
        )

    if conectado and empresa_id is not None and historico_pendente and historico_primeiro_login:
        try:
            await conexoes_ativas.send_message(
                f"emp:{empresa_id}",
                {
                    "type": "history_sync_start",
                    "total": 0,
                    "serverTimestamp": _server_ts_ms(),
                },
            )
            await conexoes_ativas.send_message(
                f"emp:{empresa_id}",
                {
                    "type": "history_sync_progress",
                    "imported": 0,
                    "total": 0,
                    "serverTimestamp": _server_ts_ms(),
                },
            )
        except Exception as e:
            LOG(f"[SYNC] falha ao emitir start/progress inicial: {e}")

    try:
        await conexoes_ativas.send_message(
            f"inst:{inst_id}",
            {
                "type": "connection",
                "status": "CONNECTED" if conectado else "DISCONNECTED",
                "serverTimestamp": _server_ts_ms(),
            },
        )
    except Exception as e:
        LOG(f"[CONNECTION] falha ao emitir WS inst={inst_id}: {e}")

    if empresa_id is not None:
        try:
            await conexoes_ativas.send_message(
                f"emp:{empresa_id}",
                {
                    "type": "connection",
                    "inst_status": {
                        "connected": bool(conectado),
                        "instance": inst_id,
                        "numero_instancia": numero_instancia,
                    },
                    "reload_whatsapp": True,
                    "serverTimestamp": _server_ts_ms(),
                },
            )
        except Exception as e:
            LOG(f"[CONNECTION] falha ao emitir WS emp={empresa_id} inst={inst_id}: {e}")

    # =========================
    # SYNC PÓS-CONEXÃO
    # =========================
    # Regra correta:
    # - Reconexão normal antiga: NÃO dispara histórico.
    # - Primeiro QR/histórico pendente: dispara, mesmo se was_connected=True no segundo update.
    if conectado and inst_id not in INSTANCIAS_SYNC:
        do_sync = False

        if historico_pendente and historico_primeiro_login:
            do_sync = True
            LOG(
                f"[SYNC][connect] permitido por histórico pendente de primeiro login "
                f"historico={historico_opcao} inst={inst_id} "
                f"was_connected={was_connected} primeiro_login={historico_primeiro_login}"
            )

        elif historico_pendente:
            LOG(
                f"[SYNC][connect] ignorado: histórico pendente antigo/não confirmado por QR "
                f"inst={inst_id} historico={historico_opcao} "
                f"was_connected={was_connected} primeiro_login={historico_primeiro_login}. "
                "Não vou aguardar MESSAGES_SET em reconexão comum."
            )

        elif was_connected:
            LOG(
                f"[SYNC][connect] ignorado inst={inst_id}: "
                f"reconexão normal/antiga was_connected=True, historico={historico_opcao}, "
                f"primeiro_login={historico_primeiro_login}."
            )

        elif SYNC_ON_CONNECT_AFTER_QR:
            do_sync = _qr_recente(inst_id)

            if do_sync:
                LOG(
                    f"[SYNC][connect] permitido por QR recente "
                    f"inst={inst_id} window_min={QR_CONNECT_SYNC_WINDOW_MIN}"
                )
            else:
                LOG(
                    f"[SYNC][connect] ignorado: fora da janela QR "
                    f"inst={inst_id} window_min={QR_CONNECT_SYNC_WINDOW_MIN}"
                )

        if do_sync:
            INSTANCIAS_SYNC.add(inst_id)
            QR_RECENT.pop(inst_id, None)

            # Importante:
            # limpa o estado anterior antes de começar o novo ciclo.
            # Assim o watchdog não confunde MESSAGES_SET antigo com o atual.
            history_clear_messages_set_state(inst_id)

            _schedule_connect_sync(inst_id)


async def on_logout_instance(instance: str, payload: dict):
    INSTANCIAS_SYNC.discard(instance)
    QR_RECENT.pop(instance, None)
    history_clear_messages_set_state(instance)
    _cancel_connect_sync(instance)
    _mark_disconnected(instance)


HANDLERS[EvoEvent.LOGOUT_INSTANCE] = on_logout_instance
HANDLERS[EvoEvent.REMOVE_INSTANCE] = on_logout_instance

if hasattr(EvoEvent, "INSTANCE_DELETE"):
    HANDLERS[getattr(EvoEvent, "INSTANCE_DELETE")] = on_logout_instance


__all__ = [
    "on_conn_update",
    "on_logout_instance",
]