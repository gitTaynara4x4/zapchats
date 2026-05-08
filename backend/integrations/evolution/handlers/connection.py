# backend/integrations/evolution/handlers/connection.py

from __future__ import annotations

import asyncio
import os
import re

import requests

from backend.database import SessionLocal
from backend import models
from backend.websocket_manager import conexoes_ativas
from backend.routers.cliente_onboarding import cancel_auto_cleanup

from .shared import EvoEvent, HANDLERS, handler
from ._state import INSTANCIAS_SYNC, QR_RECENT
from ..utils.log_utils import LOG
from ..utils.time_utils import _now_utc, _server_ts_ms
from ..utils.cache_utils import invalidate_emp_cache
from ..repositories.instancias_repo import get_instancia_by_name


SYNC_CONTACTS_ON_CONNECT = (os.getenv("SYNC_CONTACTS_ON_CONNECT", "true").lower() == "true")
SYNC_CHATS_ON_CONNECT = (os.getenv("SYNC_CHATS_ON_CONNECT", "true").lower() == "true")
ENABLE_MESSAGES_SET = (os.getenv("ENABLE_MESSAGES_SET", "true").lower() == "true")
SYNC_ON_CONNECT_AFTER_QR = (os.getenv("SYNC_ON_CONNECT_AFTER_QR", "true").lower() == "true")
QR_CONNECT_SYNC_WINDOW_MIN = int(os.getenv("QR_CONNECT_SYNC_WINDOW_MIN", "30") or "30")

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
        b.strip()
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


def _evo_expand_rabbit(instance: str) -> bool:
    """
    Reforça o Rabbit na Evolution com MESSAGES_SET ativo.

    Isso é idempotente:
    pode chamar várias vezes sem problema.
    """
    if not (EVOLUTION_URL and HEADERS and instance):
        return False

    body = {
        "rabbitmq": {
            "enabled": True,
            "exchange": RABBIT_EXCHANGE,
            "bindings": RABBIT_BINDINGS,
            "events": FULL_EVENTS_RABBIT,
        }
    }

    try:
        r = requests.post(
            f"{EVOLUTION_URL}/rabbitmq/set/{instance}",
            headers=HEADERS,
            json=body,
            timeout=20,
        )

        if not r.ok:
            LOG(
                f"[Rabbit] falha ao expandir inst={instance} "
                f"status={r.status_code} body={str(r.text or '')[:500]}"
            )
            return False

        LOG(
            f"[Rabbit] expandido para inst={instance} "
            f"exchange={RABBIT_EXCHANGE} bindings={RABBIT_BINDINGS} "
            f"events={len(FULL_EVENTS_RABBIT)}"
        )
        return True

    except Exception as e:
        LOG(f"[Rabbit] falha ao expandir inst={instance}: {e}")
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


async def _run_connect_sync_safe(inst_id: str) -> None:
    """
    Roda sync pesada após conexão sem travar o handler CONNECTION_UPDATE.
    """
    try:
        from .contacts import sync_contatos_completos, sync_chats_completos

        LOG(
            "[SYNC][connect] início "
            f"inst={inst_id} "
            f"contacts={SYNC_CONTACTS_ON_CONNECT} "
            f"chats={SYNC_CHATS_ON_CONNECT} "
            f"messages_set={ENABLE_MESSAGES_SET}"
        )

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

        if ENABLE_MESSAGES_SET:
            LOG("[MESSAGES_SET] aguardando histórico (none/24h/7d).")

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

    with SessionLocal() as db:
        inst = _get_inst_row(db, inst_id)
        if not inst:
            return

        was_connected = bool(getattr(inst, "connected", False))
        inst.connected = bool(conectado)

        wuid = (
            data.get("id")
            or data.get("wid")
            or (data.get("me") or {}).get("id")
        ) if isinstance(data, dict) else None

        if isinstance(wuid, str) and wuid.endswith("@s.whatsapp.net"):
            inst.numero_instancia = re.sub(r"\D", "", wuid.split("@", 1)[0])

        inst.last_seen = _now_utc()
        empresa_id = inst.empresa_id
        historico_opcao = (inst.historico_restaurar or "none").lower()

        db.commit()

    if (not conectado) and (st in ("close", "closed", "disconnected", "logout", "loggedout")):
        INSTANCIAS_SYNC.discard(inst_id)
        QR_RECENT.pop(inst_id, None)
        _cancel_connect_sync(inst_id)
        _mark_disconnected(inst_id)

    if conectado:
        try:
            cancel_auto_cleanup(inst_id)
        except Exception as e:
            LOG(f"[CLEANUP] falha ao cancelar auto cleanup: {e}")

        # Reforço principal:
        # Mesmo que já estivesse conectado, reconfigura Rabbit/WebSocket.
        # Isso garante MESSAGES_SET ativo para histórico 24h/7d.
        rabbit_ok = _evo_expand_rabbit(inst_id)
        ws_ok = _evo_expand_websocket(inst_id)

        LOG(
            f"[CONNECTION] connected inst={inst_id} "
            f"was_connected={was_connected} "
            f"historico={historico_opcao} "
            f"rabbit_ok={rabbit_ok} "
            f"ws_ok={ws_ok}"
        )

    if conectado and not was_connected:
        if empresa_id is not None and (historico_opcao in ("24h", "7d")):
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

    await conexoes_ativas.send_message(
        f"inst:{inst_id}",
        {
            "type": "connection",
            "status": "CONNECTED" if conectado else "DISCONNECTED",
            "serverTimestamp": _server_ts_ms(),
        },
    )

    if empresa_id is not None:
        await conexoes_ativas.send_message(
            f"emp:{empresa_id}",
            {
                "type": "connection",
                "inst_status": {
                    "connected": bool(conectado),
                    "instance": inst_id,
                },
                "reload_whatsapp": True,
                "serverTimestamp": _server_ts_ms(),
            },
        )

    if conectado and inst_id not in INSTANCIAS_SYNC:
        do_sync = True

        if SYNC_ON_CONNECT_AFTER_QR:
            now_s = int(_now_utc().timestamp())
            qr_s = QR_RECENT.get(inst_id)
            do_sync = bool(qr_s and (now_s - int(qr_s)) <= (QR_CONNECT_SYNC_WINDOW_MIN * 60))

        if do_sync:
            INSTANCIAS_SYNC.add(inst_id)
            QR_RECENT.pop(inst_id, None)

            # Importante:
            # não usar await aqui, senão o evento de conexão fica preso na sync.
            _schedule_connect_sync(inst_id)


async def on_logout_instance(instance: str, payload: dict):
    INSTANCIAS_SYNC.discard(instance)
    QR_RECENT.pop(instance, None)
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