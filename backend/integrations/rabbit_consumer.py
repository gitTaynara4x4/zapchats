# backend/integrations/rabbit_consumer.py
from __future__ import annotations

import os
import json
import asyncio
import urllib.parse
from dataclasses import dataclass
from typing import Any, Callable, Coroutine, Optional, Tuple, Dict

import aio_pika
from aio_pika.abc import AbstractChannel, AbstractQueue, AbstractIncomingMessage


# =========================
# Helpers de ENV e URI
# =========================
def _env(name: str, default: str = "") -> str:
    return os.getenv(name, default)


def _uri() -> str:
    """
    Prioriza RABBITMQ_URI (jÃ¡ com vhost). SenÃ£o monta a partir dos DEFAULT_*.
    Aceita vhost "/" (codificado como %2F).
    """
    uri = _env("RABBITMQ_URI")
    if uri:
        return uri

    user = _env("RABBITMQ_DEFAULT_USER", "guest")
    pw = urllib.parse.quote(_env("RABBITMQ_DEFAULT_PASS", "guest"), safe="")
    host = _env("RABBITMQ_HOST", "localhost")
    port = _env("RABBITMQ_PORT", "5672")
    vhost = _env("RABBITMQ_DEFAULT_VHOST", "/")
    vq = "%2F" if vhost == "/" else urllib.parse.quote(vhost, safe="")
    return f"amqp://{user}:{pw}@{host}:{port}/{vq}"


# =========================
# Estado
# =========================
@dataclass
class _RabbitState:
    conn: Optional[aio_pika.RobustConnection] = None
    channel: Optional[AbstractChannel] = None
    queue: Optional[AbstractQueue] = None
    consumer_tag: Optional[str] = None
    stop_event: Optional[asyncio.Event] = None


# =========================
# Topologia
# =========================
async def _ensure_topology(ch: AbstractChannel) -> Tuple[aio_pika.Exchange, AbstractQueue]:
    """
    Garante exchange/queue/bindings.
    - Exchange: topic, durable
    - Queue: durable, quorum (com fallback p/ classic se broker nÃ£o suportar)
    """
    ex_name = _env("RABBITMQ_EXCHANGE_NAME", "evolution_exchange")
    queue_name = _env("RABBITMQ_QUEUE_NAME", "zapchats.backend")
    bindings = [s.strip() for s in _env("RABBITMQ_BINDINGS", "#").split(",") if s.strip()]

    exchange = await ch.declare_exchange(ex_name, aio_pika.ExchangeType.TOPIC, durable=True)

    try:
        queue = await ch.declare_queue(
            queue_name,
            durable=True,
            arguments={"x-queue-type": "quorum"},
        )
    except Exception:
        queue = await ch.declare_queue(queue_name, durable=True)

    for rk in bindings:
        try:
            await queue.bind(exchange, routing_key=rk)
        except Exception as e:
            print(f"[RABBIT] Falha ao bind '{rk}': {e}")

    return exchange, queue


# =========================
# Helpers de normalizaÃ§Ã£o
# =========================
def _norm_event_name(ev: Optional[str]) -> str:
    ev = (ev or "").strip()
    if not ev:
        return ""
    return ev.replace(".", "_").replace("-", "_").upper()


def _find_instance(js: Any) -> str:
    """
    Tenta achar o identificador da instÃ¢ncia em diversos formatos
    (dict raiz, dict em 'data', ou em objetos qrcode etc.).
    """
    if isinstance(js, dict):
        for k in ("instance", "instanceName", "session", "sessionName"):
            v = js.get(k)
            if isinstance(v, str) and v:
                return v

        data = js.get("data")
        if isinstance(data, dict):
            for k in ("instance", "instanceName", "session", "sessionName"):
                v = data.get(k)
                if isinstance(v, str) and v:
                    return v

        qrc = (js.get("data") or {}).get("qrcode")
        if isinstance(qrc, dict):
            v = qrc.get("instance") or qrc.get("instanceName")
            if isinstance(v, str) and v:
                return v

    if isinstance(js, list) and js:
        first = js[0]
        if isinstance(first, dict):
            for k in ("instance", "instanceName", "instanceId", "session", "sessionName"):
                v = first.get(k)
                if isinstance(v, str) and v:
                    return v

    return ""


# =========================
# Runner principal
# =========================
async def _runner(
    state: _RabbitState,
    HANDLERS: Dict[Any, Callable[[str, dict], Coroutine[Any, Any, None]]],
    EvoEvent: Any,
) -> None:
    """
    Conecta, garante topologia, consome e aguarda stop_event.
    Faz shutdown limpo no finally (cancela consume, fecha canal e conexÃ£o).
    """
    uri = _uri()
    print("[RABBIT] Conectando em:", uri)

    state.conn = await aio_pika.connect_robust(uri)
    state.channel = await state.conn.channel()

    prefetch = int(_env("RABBITMQ_QOS", "50") or "50")
    await state.channel.set_qos(prefetch_count=prefetch)

    _, state.queue = await _ensure_topology(state.channel)

    # Alguns brokers/instalaÃ§Ãµes usam nomes com pequenas variaÃ§Ãµes;
    # mapeamos aliases comuns para os enums do backend.
    def _alias(ev_key: str) -> str:
        if ev_key == "GROUPS_UPDATE":
            return "GROUP_UPDATE"
        if ev_key == "MESSAGES_EDITED":
            return "MESSAGES_UPDATE"
        return ev_key

    async def on_message(msg: AbstractIncomingMessage) -> None:
        async with msg.process(requeue=False):
            raw = ""
            js: Any = {}
            try:
                raw = msg.body.decode("utf-8", "ignore") if msg.body else ""
                js = json.loads(raw) if raw else {}
            except Exception as e:
                print("[RABBIT] JSON invÃ¡lido:", e)
                return

            # identifica o evento
            ev_raw = None
            if isinstance(js, dict):
                ev_raw = js.get("event") or js.get("type") or js.get("eventName")
            ev_key = _norm_event_name(ev_raw or msg.routing_key)
            ev_key = _alias(ev_key)

            # resolve Enum
            try:
                evt = EvoEvent[ev_key]
            except Exception:
                # evento desconhecido
                return

            handler = HANDLERS.get(evt)
            if not handler:
                return

            inst = _find_instance(js)

            # >>> ENVELOPA SEMPRE (mesmo se jÃ¡ for dict) <<<
            # Isso evita "AttributeError: 'list' object has no attribute 'get'"
            # em handlers que esperam sempre um payload dict com chave "data".
            payload = {"instance": inst, "data": js}

            first_arg = inst or msg.routing_key or ""

            try:
                coro = handler(first_arg, payload)
                if asyncio.iscoroutine(coro):
                    await coro
            except Exception as e:
                print(f"[RABBIT] Erro no handler {ev_key}: {e}")

    # registrar consumidor e guardar o consumer_tag para cancelar depois
    state.consumer_tag = await state.queue.consume(on_message, no_ack=False)
    print("[RABBIT] Consumindoâ€¦")

    # espera atÃ© alguÃ©m pedir stop()
    state.stop_event = state.stop_event or asyncio.Event()
    try:
        await state.stop_event.wait()
    except asyncio.CancelledError:
        pass
    finally:
        # tenta encerrar limpo
        try:
            if state.queue and state.consumer_tag:
                await state.queue.cancel(state.consumer_tag)
        except Exception:
            pass
        try:
            if state.channel and not state.channel.is_closed:
                await state.channel.close()
        except Exception:
            pass
        try:
            if state.conn and not state.conn.is_closed:
                await state.conn.close()
        except Exception:
            pass


# =========================
# API pÃºblica
# =========================
def start_rabbit_consumer(
    loop: asyncio.AbstractEventLoop,
    HANDLERS: Dict[Any, Callable[[str, dict], Coroutine[Any, Any, None]]],
    EvoEvent: Any,
) -> Tuple[asyncio.Task, Callable[[], Coroutine[Any, Any, None]]]:
    """
    Inicia o consumidor como uma task e retorna:
      (task, stop) onde stop() sinaliza o encerramento limpo.
    """
    state = _RabbitState(stop_event=asyncio.Event())

    async def _stop():
        if state.stop_event and not state.stop_event.is_set():
            state.stop_event.set()
        await asyncio.sleep(0)

    task = loop.create_task(_runner(state, HANDLERS, EvoEvent), name="rabbit-consumer")
    return task, _stop