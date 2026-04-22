# backend/integrations/evolution/transport/rabbit_consumer.py
from __future__ import annotations

import asyncio
import json
import os
import time
from typing import Any, Awaitable, Callable, Dict, Optional, Tuple

import aio_pika
from aio_pika import IncomingMessage, ExchangeType

RABBIT_MONITOR: dict[str, Any] = {
    "enabled": False,
    "connected": False,
    "consumer_started": False,
    "last_error": None,
    "last_message_at": None,
    "last_event": None,
    "last_event_at": None,
    "last_event_meta": None,
    "rabbit_url": None,
    "queue_name": None,
    "prefetch": None,
}


def get_rabbit_monitor() -> dict[str, Any]:
    return dict(RABBIT_MONITOR)


def record_rabbit_event(event_name: str, **extra) -> None:
    RABBIT_MONITOR["last_event"] = str(event_name or "").strip() or None
    RABBIT_MONITOR["last_event_at"] = time.time()
    RABBIT_MONITOR["last_event_meta"] = dict(extra) if extra else None


def _monitor_set(**kwargs) -> None:
    RABBIT_MONITOR.update(kwargs)


def _env(k: str, d: str = "") -> str:
    return os.getenv(k, d)


def _rabbit_enabled() -> bool:
    flag = (_env("USE_RABBIT", "") or _env("RABBITMQ_CONSUME_ENABLED", "")).strip().lower()
    if flag in {"0", "false", "no", "off"}:
        return False
    if flag in {"1", "true", "yes", "on"}:
        return True
    return bool(_env("RABBITMQ_URI") or _env("RABBITMQ_URL") or _env("AMQP_URL"))


def _rabbit_url() -> str:
    return (
        _env("RABBITMQ_URI")
        or _env("RABBITMQ_URL")
        or _env("AMQP_URL")
        or "amqp://guest:guest@localhost:5672/"
    )


def _queue_name() -> str:
    return (
        _env("RABBITMQ_QUEUE_NAME")
        or _env("RABBITMQ_QUEUE")
        or "zapchats.backend"
    )


def _exchange_name() -> str:
    return (
        _env("RABBITMQ_EXCHANGE_NAME")
        or _env("RABBITMQ_EXCHANGE")
        or ""
    ).strip()


def _routing_key(queue_name: str) -> str:
    return (
        _env("RABBITMQ_ROUTING_KEY")
        or _env("RABBITMQ_BINDING_KEY")
        or queue_name
    ).strip()


def _exchange_type() -> str:
    return (_env("RABBITMQ_EXCHANGE_TYPE", "direct") or "direct").strip().lower()


def _heartbeat() -> int:
    raw = _env("RABBITMQ_HEARTBEAT", "15").strip()
    try:
        return max(5, int(raw))
    except Exception:
        return 15


def _extract_event_name(body: dict[str, Any], routing_key: str | None = None) -> str | None:
    event = body.get("event")
    if isinstance(event, str) and event.strip():
        return event.strip()

    evt = body.get("eventName")
    if isinstance(evt, str) and evt.strip():
        return evt.strip()

    rk = str(routing_key or "").strip()
    if rk:
        return rk

    return None


def _extract_instance(body: dict[str, Any], default: str | None = None) -> str | None:
    for k in ("instance", "instanceName", "instanceId"):
        v = body.get(k)
        if isinstance(v, str) and v.strip():
            return v.strip()

    data = body.get("data")
    if isinstance(data, dict):
        for k in ("instance", "instanceName", "instanceId"):
            v = data.get(k)
            if isinstance(v, str) and v.strip():
                return v.strip()

    return default


def _normalize_exchange_type(name: str) -> ExchangeType:
    mapping = {
        "direct": ExchangeType.DIRECT,
        "topic": ExchangeType.TOPIC,
        "fanout": ExchangeType.FANOUT,
        "headers": ExchangeType.HEADERS,
    }
    return mapping.get(name.lower(), ExchangeType.DIRECT)


async def start(
    loop: asyncio.AbstractEventLoop,
    HANDLERS: Dict[Any, Callable],
    EvoEvent: Any,
) -> Tuple[Optional[asyncio.Task], Optional[Callable[[], Awaitable[None]]]]:
    enabled = _rabbit_enabled()
    rabbit_url = _rabbit_url()
    queue_name = _queue_name()
    exchange_name = _exchange_name()
    routing_key = _routing_key(queue_name)
    exchange_type = _exchange_type()
    prefetch = int(_env("RABBITMQ_QOS", _env("RABBITMQ_PREFETCH", "25")) or "25")
    durable = (_env("RABBITMQ_QUEUE_DURABLE", "true").lower() == "true")
    heartbeat = _heartbeat()

    _monitor_set(
        enabled=enabled,
        connected=False,
        consumer_started=False,
        last_error=None,
        last_message_at=None,
        last_event=None,
        last_event_at=None,
        last_event_meta=None,
        rabbit_url=rabbit_url,
        queue_name=queue_name,
        prefetch=prefetch,
    )

    if not enabled:
        print("[RABBIT] consumo desabilitado por env.")
        return (None, None)

    async def _dispatch(evt_name: str, body: dict[str, Any]):
        key = evt_name.replace(".", "_").replace("-", "_").upper()
        evt = getattr(EvoEvent, key, None)
        if not evt:
            return

        handler_fn = HANDLERS.get(evt)
        if not handler_fn:
            return

        inst = _extract_instance(body, default=None)
        payload = body if "data" in body else {"instance": inst or "", "data": body}

        try:
            out = handler_fn(inst or "", payload)
            if asyncio.iscoroutine(out):
                await out
        except Exception as e:
            print(f"[RABBIT] erro handler {key}: {e}")
            _monitor_set(last_error=str(e))

    stop_evt = asyncio.Event()

    async def _handle_message(message: IncomingMessage):
        raw = message.body.decode("utf-8", errors="ignore").strip()
        if not raw:
            return

        try:
            body = json.loads(raw)
        except Exception as e:
            print(f"[RABBIT] JSON inválido: {e}")
            _monitor_set(last_error=f"JSON inválido: {e}")
            return

        if not isinstance(body, dict):
            return

        evt_name = _extract_event_name(body, routing_key=message.routing_key)
        if not evt_name:
            return

        record_rabbit_event(evt_name, routing_key=message.routing_key)
        await _dispatch(evt_name, body)

    async def _runner():
        while not stop_evt.is_set():
            print(f"[RABBIT] Conectando em: {rabbit_url}")
            connection: aio_pika.RobustConnection | None = None
            channel: aio_pika.abc.AbstractChannel | None = None

            try:
                _monitor_set(
                    consumer_started=True,
                    connected=False,
                    last_error=None,
                )

                connection = await aio_pika.connect_robust(rabbit_url, heartbeat=heartbeat)
                channel = await connection.channel()
                await channel.set_qos(prefetch_count=prefetch)

                # Cria a fila se não existir
                queue = await channel.declare_queue(
                    queue_name,
                    durable=durable,
                )

                # Se houver exchange configurada, declara e faz bind
                if exchange_name:
                    exchange = await channel.declare_exchange(
                        exchange_name,
                        _normalize_exchange_type(exchange_type),
                        durable=True,
                    )
                    await queue.bind(exchange, routing_key=routing_key)
                    print(
                        f"[RABBIT] Fila '{queue_name}' bindada na exchange "
                        f"'{exchange_name}' com routing_key '{routing_key}'"
                    )

                _monitor_set(
                    connected=True,
                    last_error=None,
                )

                print(f"[RABBIT] Consumindo fila: {queue_name}")

                async with queue.iterator() as queue_iter:
                    async for message in queue_iter:
                        if stop_evt.is_set():
                            break

                        async with message.process(requeue=False):
                            try:
                                await _handle_message(message)
                                _monitor_set(
                                    connected=True,
                                    last_message_at=time.time(),
                                )
                            except Exception as e:
                                print(f"[RABBIT] erro processando mensagem: {e}")
                                _monitor_set(last_error=str(e))

            except asyncio.CancelledError:
                _monitor_set(connected=False)
                raise
            except Exception as e:
                print(f"[RABBIT] falha geral: {e}")
                _monitor_set(
                    connected=False,
                    last_error=str(e),
                )
                if not stop_evt.is_set():
                    await asyncio.sleep(3)
            finally:
                try:
                    if channel and not channel.is_closed:
                        await channel.close()
                except Exception:
                    pass

                try:
                    if connection and not connection.is_closed:
                        await connection.close()
                except Exception:
                    pass

                _monitor_set(connected=False)

    task = loop.create_task(_runner())

    async def _stop():
        stop_evt.set()
        _monitor_set(connected=False)

        try:
            task.cancel()
        except Exception:
            pass

        try:
            await asyncio.sleep(0)
        except Exception:
            pass

    return (task, _stop)


async def start_rabbit_consumer(
    loop: asyncio.AbstractEventLoop,
    HANDLERS: Dict[Any, Callable],
    EvoEvent: Any,
):
    return await start(loop, HANDLERS, EvoEvent)


__all__ = [
    "RABBIT_MONITOR",
    "get_rabbit_monitor",
    "record_rabbit_event",
    "start",
    "start_rabbit_consumer",
]