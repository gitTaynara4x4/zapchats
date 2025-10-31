# backend/rabbit_consumer.py
from __future__ import annotations

"""
RabbitMQ consumer robusto:
- RobustConnection/RobustChannel (reconecta sozinho)
- Backoff para a conexão inicial
- Topologia idempotente (exchange topic, fila principal, retry via DLX+TTL, DLQ final)
- Consumer com ack/nack + retries limitados (x-death)
- Publisher confirms e mandatory nas cópias para DLX final
- Encerramento limpo via stop()

ENV principais:
  RABBITMQ_URI                amqp://user:pass@host:5672/vhost   (prioritário)
  RABBITMQ_DEFAULT_*          (user/pass/host/port/vhost)        (fallback p/ montar a URI)
  RABBITMQ_EXCHANGE_NAME      evolution_exchange
  RABBITMQ_QUEUE_NAME         zapchats.backend
  RABBITMQ_BINDINGS           #  (routing keys separados por vírgula)
  RABBITMQ_HEARTBEAT          15
  RABBITMQ_QOS                64
  RABBITMQ_USE_QUORUM         true
  RABBITMQ_USE_SAC            false   (x-single-active-consumer)
  RABBITMQ_ATTACH_DLX         true    (adiciona x-dead-letter-exchange na fila nova)
  RABBITMQ_MAX_LENGTH         ""      (opcional)
  RABBITMQ_MAX_BYTES          ""      (opcional)
  RABBITMQ_OVERFLOW           ""      (ex.: reject-publish)

  RABBITMQ_RETRY_TTL_MS       5000
  RABBITMQ_RETRY_ROUTING      retry.5s
  RABBITMQ_RETRY_BACK_ROUTING events
  RABBITMQ_RETRY_QUEUE        <queue>.retry
  RABBITMQ_DLQ_NAME           <queue>.dlq
  RABBITMQ_MAX_RETRIES        5
"""

import os
import json
import asyncio
import urllib.parse
from dataclasses import dataclass
from typing import Any, Callable, Coroutine, Optional, Tuple, Dict

import aio_pika
from aio_pika import Message, DeliveryMode
from aio_pika.abc import AbstractChannel, AbstractQueue, AbstractIncomingMessage


# =========================
# Helpers de ENV e URI
# =========================
def _env(name: str, default: str = "") -> str:
    return os.getenv(name, default)


def _uri() -> str:
    """
    Prioriza RABBITMQ_URI (já com vhost). Senão monta a partir dos DEFAULT_*.
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
    # extras para DLX/Retry
    dlx_ex: Optional[aio_pika.Exchange] = None
    retry_queue_name: Optional[str] = None
    dlq_queue_name: Optional[str] = None
    max_retries: int = 5


# =========================
# Topologia
# =========================
async def _ensure_topology(
    ch: AbstractChannel,
) -> Tuple[aio_pika.Exchange, AbstractQueue, aio_pika.Exchange, Dict[str, str]]:
    """
    Garante exchange/queue/bindings + DLX/Retry/DLQ.
    - Exchange principal: topic, durable
    - DLX (ex_name + ".dlx"): topic, durable
    - Fila principal:
        * PASSIVE se já existir (não muda args → evita PRECONDITION_FAILED)
        * Se não existir, cria com quorum (x-queue-type=quorum), SAC opcional
          e, se configurado, anexa x-dead-letter-exchange para a DLX.
    - Fila de retry: TTL + dead-letter de volta p/ exchange principal
    - DLQ final: recebe mensagens "desistidas"
    """
    ex_name = _env("RABBITMQ_EXCHANGE_NAME", "evolution_exchange")
    queue_name = _env("RABBITMQ_QUEUE_NAME", "zapchats.backend")
    bindings = [s.strip() for s in _env("RABBITMQ_BINDINGS", "#").split(",") if s.strip()]

    # params de retry/DLQ (topologia auxiliar; DLX também pode vir por policy)
    ttl_ms = int(_env("RABBITMQ_RETRY_TTL_MS", "5000") or "5000")
    retry_key = _env("RABBITMQ_RETRY_ROUTING", "retry.5s")
    back_key = _env("RABBITMQ_RETRY_BACK_ROUTING", "events")  # rota de retorno p/ exchange principal
    retry_queue_name = _env("RABBITMQ_RETRY_QUEUE", f"{queue_name}.retry")
    dlq_queue_name = _env("RABBITMQ_DLQ_NAME", f"{queue_name}.dlq")
    use_quorum = (_env("RABBITMQ_USE_QUORUM", "true").lower() == "true")
    use_sac = (_env("RABBITMQ_USE_SAC", "false").lower() == "true")
    attach_dlx = (_env("RABBITMQ_ATTACH_DLX", "true").lower() == "true")

    # limites/overflow (opcionais) – só usados se a fila for criada do zero
    max_len = _env("RABBITMQ_MAX_LENGTH", "")
    max_bytes = _env("RABBITMQ_MAX_BYTES", "")
    overflow = _env("RABBITMQ_OVERFLOW", "")  # ex: reject-publish

    # Exchanges
    main_ex = await ch.declare_exchange(ex_name, aio_pika.ExchangeType.TOPIC, durable=True)
    dlx_ex = await ch.declare_exchange(f"{ex_name}.dlx", aio_pika.ExchangeType.TOPIC, durable=True)

    # Fila principal:
    # 1) tenta PASSIVE (não altera argumentos já existentes)
    try:
        main_q = await ch.declare_queue(queue_name, passive=True)
    except Exception:
        # 2) não existe → cria com quorum e demais limites
        main_args: Dict[str, Any] = {}
        if use_quorum:
            main_args["x-queue-type"] = "quorum"
        if use_sac:
            main_args["x-single-active-consumer"] = True
        if attach_dlx:
            main_args["x-dead-letter-exchange"] = f"{ex_name}.dlx"
            main_args["x-dead-letter-routing-key"] = retry_key
        if max_len:
            main_args["x-max-length"] = int(max_len)
        if max_bytes:
            main_args["x-max-length-bytes"] = int(max_bytes)
        if overflow:
            main_args["x-overflow"] = overflow  # e.g. "reject-publish"

        try:
            main_q = await ch.declare_queue(queue_name, durable=True, arguments=main_args)
        except Exception:
            # fallback ultra-minimalista se o broker rejeitar algum arg
            main_q = await ch.declare_queue(queue_name, durable=True)

    # Bindings (idempotentes na prática)
    for rk in bindings:
        try:
            await main_q.bind(main_ex, routing_key=rk)
        except Exception as e:
            print(f"[RABBIT] Falha ao bind '{rk}': {e}")

    # fila de retry (TTL + DLX de volta p/ a exchange principal)
    retry_args: Dict[str, Any] = {
        "x-message-ttl": ttl_ms,
        "x-dead-letter-exchange": ex_name,
        "x-dead-letter-routing-key": back_key,
    }
    if use_quorum:
        retry_args["x-queue-type"] = "quorum"

    try:
        retry_q = await ch.declare_queue(retry_queue_name, durable=True, arguments=retry_args)
    except Exception:
        retry_args.pop("x-queue-type", None)
        retry_q = await ch.declare_queue(retry_queue_name, durable=True, arguments=retry_args)

    await retry_q.bind(dlx_ex, routing_key=retry_key)

    # DLQ final (mensagens "desistidas")
    dlq_args: Dict[str, Any] = {}
    if use_quorum:
        dlq_args["x-queue-type"] = "quorum"

    try:
        dlq_q = await ch.declare_queue(dlq_queue_name, durable=True, arguments=dlq_args)
    except Exception:
        dlq_q = await ch.declare_queue(dlq_queue_name, durable=True)

    await dlq_q.bind(dlx_ex, routing_key="final")

    topo = {
        "retry_key": retry_key,
        "back_key": back_key,
        "retry_queue": retry_queue_name,
        "dlq_queue": dlq_queue_name,
    }
    return main_ex, main_q, dlx_ex, topo


# =========================
# Helpers de normalização
# =========================
def _norm_event_name(ev: Optional[str]) -> str:
    ev = (ev or "").strip()
    if not ev:
        return ""
    return ev.replace(".", "_").replace("-", "_").upper()


def _find_instance(js: Any) -> str:
    """
    Tenta achar o identificador da instância em diversos formatos
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
# Runner principal (com backoff de conexão)
# =========================
async def _runner(
    state: _RabbitState,
    HANDLERS: Dict[Any, Callable[[str, dict], Coroutine[Any, Any, None]]],
    EvoEvent: Any,
) -> None:
    """
    Conecta, garante topologia, consome e aguarda stop_event.
    Faz shutdown limpo no finally (cancela consume, fecha canal e conexão).
    """
    uri = _uri()
    print("[RABBIT] Conectando em:", uri)

    heartbeat = int(_env("RABBITMQ_HEARTBEAT", "15") or "15")
    qos = int(_env("RABBITMQ_QOS", "64") or "64")

    # ===== conexão inicial com backoff (caso o broker ainda não esteja pronto) =====
    attempt = 0
    while True:
        try:
            state.conn = await aio_pika.connect_robust(uri, heartbeat=heartbeat)
            break
        except Exception as e:
            attempt += 1
            delay = min(30, 1 + attempt * 2)
            print(f"[RABBIT] Falha ao conectar ({e}). Tentando novamente em {delay}s…")
            # se alguém pediu stop durante o backoff, sai
            if state.stop_event and state.stop_event.is_set():
                return
            await asyncio.sleep(delay)

    # Publisher confirms para garantir publicação, e permitir mandatory
    state.channel = await state.conn.channel(publisher_confirms=True)
    await state.channel.set_qos(prefetch_count=qos)

    main_ex, state.queue, state.dlx_ex, topo = await _ensure_topology(state.channel)
    state.retry_queue_name = topo["retry_queue"]
    state.dlq_queue_name = topo["dlq_queue"]
    state.max_retries = int(_env("RABBITMQ_MAX_RETRIES", "5") or "5")

    # aliases comuns para enums
    def _alias(ev_key: str) -> str:
        if ev_key == "GROUPS_UPDATE":
            return "GROUP_UPDATE"
        if ev_key == "MESSAGES_EDITED":
            return "MESSAGES_UPDATE"
        return ev_key

    def _attempts_from_xdeath(msg: AbstractIncomingMessage) -> int:
        """
        Conta tentativas com base no header x-death para a fila de retry.
        """
        try:
            headers = msg.headers or {}
        except Exception:
            return 0
        xdeath = headers.get("x-death")
        total = 0
        if isinstance(xdeath, list):
            for d in xdeath:
                if isinstance(d, dict) and d.get("queue") == state.retry_queue_name:
                    try:
                        total += int(d.get("count", 1))
                    except Exception:
                        total += 1
        return total

    async def _publish_dlx_copy(body: bytes, headers: Dict[str, Any], routing_key: str = "final") -> None:
        """
        Publica cópia na DLX final com confirms + mandatory.
        """
        if not state.dlx_ex:
            return
        msg = Message(
            body or b"",
            headers=headers or {},
            delivery_mode=DeliveryMode.PERSISTENT,
        )
        try:
            await state.dlx_ex.publish(msg, routing_key=routing_key, mandatory=True)
        except Exception as e:
            print("[RABBIT] Unroutable/erro ao publicar na DLX final:", e)

    async def on_message(msg: AbstractIncomingMessage) -> None:
        # processamento manual para decidir ack/nack/publicação na DLQ final
        raw = ""
        js: Any = {}
        try:
            raw = msg.body.decode("utf-8", "ignore") if msg.body else ""
            js = json.loads(raw) if raw else {}
        except Exception as e:
            print("[RABBIT] JSON inválido:", e)
            # mensagem malformada → ack + manda pra DLQ final com contexto
            try:
                await msg.ack()
                await _publish_dlx_copy(
                    msg.body or b"",
                    {**(msg.headers or {}), "reason": "json-parse-error", "error": str(e)},
                )
            except Exception as pe:
                print("[RABBIT] Falha ao publicar em DLQ final:", pe)
            return

        # identifica o evento
        ev_raw = None
        if isinstance(js, dict):
            ev_raw = js.get("event") or js.get("type") or js.get("eventName")
        ev_key = _alias(_norm_event_name(ev_raw or msg.routing_key))

        # resolve Enum
        try:
            evt = EvoEvent[ev_key]
        except Exception:
            # evento desconhecido → apenas ACK para não ciclar
            await msg.ack()
            return

        handler = HANDLERS.get(evt)
        if not handler:
            await msg.ack()
            return

        inst = _find_instance(js)

        # Sempre envelopa como {"instance":..., "data":...}
        payload = {"instance": inst, "data": js}
        first_arg = inst or msg.routing_key or ""

        try:
            coro = handler(first_arg, payload)
            if asyncio.iscoroutine(coro):
                await coro
            await msg.ack()
        except Exception as e:
            # Decide retry (TTL) ou DLQ final
            attempts = _attempts_from_xdeath(msg)
            if attempts < state.max_retries:
                # NACK sem requeue → vai p/ DLX (retry.<ttl>) e volta após TTL
                await msg.reject(requeue=False)
            else:
                # Parou de tentar: ACK e publica uma cópia na DLQ final com contexto
                await msg.ack()
                try:
                    await _publish_dlx_copy(
                        msg.body or b"",
                        {
                            **(msg.headers or {}),
                            "reason": "max-retries",
                            "error": str(e),
                            "event": ev_key,
                            "attempts": attempts,
                        },
                    )
                except Exception as pe:
                    print("[RABBIT] Falha ao publicar em DLQ final:", pe)

    # registrar consumidor e guardar o consumer_tag para cancelar depois
    state.consumer_tag = await state.queue.consume(on_message, no_ack=False)
    print("[RABBIT] Consumindo…")

    # espera até alguém pedir stop()
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
# API pública
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
