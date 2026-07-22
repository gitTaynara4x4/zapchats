# backend/integrations/evolution/transport/rabbit_consumer.py
from __future__ import annotations

import asyncio
import json
import os
import time
import traceback
import threading
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
    "total_messages": 0,
    "total_dispatched": 0,
    "total_errors": 0,
    "last_raw_size": None,
    "last_payload_shape": None,
}


def get_rabbit_monitor() -> dict[str, Any]:
    return dict(RABBIT_MONITOR)


def record_rabbit_event(event_name: str, **extra) -> None:
    RABBIT_MONITOR["last_event"] = str(event_name or "").strip() or None
    RABBIT_MONITOR["last_event_at"] = time.time()
    RABBIT_MONITOR["last_event_meta"] = dict(extra) if extra else None


def _monitor_set(**kwargs) -> None:
    RABBIT_MONITOR.update(kwargs)


def _monitor_inc(key: str, amount: int = 1) -> None:
    try:
        RABBIT_MONITOR[key] = int(RABBIT_MONITOR.get(key) or 0) + int(amount)
    except Exception:
        RABBIT_MONITOR[key] = amount


def _env(k: str, d: str = "") -> str:
    return os.getenv(k, d)


def _bool_env(*names: str, default: bool = False) -> bool:
    for name in names:
        raw = os.getenv(name)
        if raw is None:
            continue

        value = str(raw).strip().lower()

        if value in {"1", "true", "yes", "sim", "on"}:
            return True

        if value in {"0", "false", "no", "nao", "não", "off"}:
            return False

    return default


def _trace_history_enabled() -> bool:
    return _bool_env("EVO_TRACE_HISTORY", "RABBIT_TRACE_HISTORY", default=False)


def _history_managed_externally() -> bool:
    owner = (_env("EVOLUTION_HISTORY_OWNER", "n8n") or "n8n").strip().lower()
    return owner in {"n8n", "external", "webhook"}


def _trace_all_enabled() -> bool:
    return _bool_env("EVO_TRACE_RABBIT_ALL", "RABBIT_TRACE_ALL", default=False)


def _rabbit_enabled() -> bool:
    use_rabbit = _bool_env("USE_RABBIT", default=True)
    consume_enabled = _bool_env("RABBITMQ_CONSUME_ENABLED", default=True)

    if not use_rabbit or not consume_enabled:
        return False

    return bool(_env("RABBITMQ_URI") or _env("RABBITMQ_URL") or _env("AMQP_URL"))


def _rabbit_url() -> str:
    return (
        _env("RABBITMQ_URI")
        or _env("RABBITMQ_URL")
        or _env("AMQP_URL")
        or "amqp://guest:guest@localhost:5672/"
    )


def _safe_rabbit_url(url: str) -> str:
    """
    Remove senha do log.
    """
    try:
        if "://" not in url or "@" not in url:
            return url

        prefix, rest = url.split("://", 1)
        auth, host = rest.split("@", 1)

        if ":" in auth:
            user = auth.split(":", 1)[0]
            return f"{prefix}://{user}:******@{host}"

        return f"{prefix}://******@{host}"
    except Exception:
        return "***"


def _queue_name() -> str:
    return (
        _env("RABBITMQ_QUEUE_NAME")
        or _env("RABBITMQ_QUEUE")
        or "ZapsChats.backend"
    )


def _exchange_name() -> str:
    return (
        _env("RABBITMQ_EXCHANGE_NAME")
        or _env("RABBITMQ_EXCHANGE")
        or ""
    ).strip()


def _routing_key(queue_name: str) -> str:
    # Compatibilidade com código antigo: retorna a primeira binding efetiva.
    keys = _routing_keys(queue_name)
    return keys[0] if keys else "#"


def _routing_keys(queue_name: str) -> list[str]:
    """Lista de bindings do consumer.

    Prioridade: RABBITMQ_BINDINGS > RABBITMQ_BINDING_KEY > RABBITMQ_ROUTING_KEY.
    Isso corrige o caso em que RABBITMQ_BINDINGS tem vários eventos, mas o
    consumer só bindava messages.set.
    """
    raw = (
        _env("RABBITMQ_BINDINGS")
        or _env("RABBITMQ_BINDING_KEY")
        or _env("RABBITMQ_ROUTING_KEY")
        or "#"
    )

    out: list[str] = []
    for part in str(raw or "#").split(","):
        key = part.strip().strip('"').strip("'")
        if key and key not in out:
            out.append(key)

    if not out:
        out = ["#"]

    # Se tiver wildcard total, não precisa bindar o resto.
    if "#" in out:
        return ["#"]

    return out


def _exchange_type() -> str:
    return (_env("RABBITMQ_EXCHANGE_TYPE", "topic") or "topic").strip().lower()


def _heartbeat() -> int:
    raw = _env("RABBITMQ_HEARTBEAT", "15").strip()

    try:
        return max(5, int(raw))
    except Exception:
        return 15


def _normalize_event_key(evt_name: str | None) -> str:
    return (
        str(evt_name or "")
        .strip()
        .replace(".", "_")
        .replace("-", "_")
        .replace(" ", "_")
        .upper()
    )


def _is_history_event(evt_name: str | None) -> bool:
    key = _normalize_event_key(evt_name)

    return key in {
        "MESSAGES_SET",
        "MESSAGES_UPSERT",
        "MESSAGES_UPDATE",
        "MESSAGES_DELETE",
        "MESSAGES_EDITED",
        "SEND_MESSAGE",
        "SEND_MESSAGE_UPDATE",
        "CHATS_SET",
        "CHATS_UPSERT",
        "CHATS_UPDATE",
        "CHATS_DELETE",
        "CONTACTS_SET",
        "CONTACTS_UPSERT",
        "CONTACTS_UPDATE",
        "CONNECTION_UPDATE",
        "QRCODE_UPDATED",
    }


def _should_trace(evt_name: str | None = None) -> bool:
    if _trace_all_enabled():
        return True

    if _trace_history_enabled() and _is_history_event(evt_name):
        return True

    return False


def _log_trace(msg: str, evt_name: str | None = None) -> None:
    if _should_trace(evt_name):
        print(msg)


def _short(value: Any, limit: int = 300) -> str:
    try:
        s = str(value)
    except Exception:
        return ""

    s = s.replace("\r", "\\r").replace("\n", "\\n")

    if len(s) > limit:
        return s[:limit] + "..."

    return s


def _safe_keys(obj: Any, limit: int = 30) -> list[str]:
    if not isinstance(obj, dict):
        return []

    out = []

    for key in obj.keys():
        out.append(str(key))
        if len(out) >= limit:
            break

    return out


def _json_size_bytes(raw: str | bytes | None) -> int:
    if raw is None:
        return 0

    if isinstance(raw, bytes):
        return len(raw)

    try:
        return len(raw.encode("utf-8", errors="ignore"))
    except Exception:
        return len(str(raw))


def _extract_event_name(body: dict[str, Any], routing_key: str | None = None) -> str | None:
    """
    Tenta descobrir o evento da Evolution.

    Exemplos:
    - event: "messages.set"
    - event: "MESSAGES_SET"
    - eventName: "MESSAGES_SET"
    - type: "messages.set"
    - data.event: "messages.set"
    - fallback pelo routing_key
    """
    for key in ("event", "eventName", "event_name", "type"):
        value = body.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()

    data = body.get("data")
    if isinstance(data, dict):
        for key in ("event", "eventName", "event_name", "type"):
            value = data.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()

    rk = str(routing_key or "").strip()

    if rk:
        return rk

    return None


def _extract_instance(body: dict[str, Any], default: str | None = None) -> str | None:
    for key in ("instance", "instanceName", "instanceId"):
        value = body.get(key)

        if isinstance(value, str) and value.strip():
            return value.strip()

    data = body.get("data")

    if isinstance(data, dict):
        for key in ("instance", "instanceName", "instanceId"):
            value = data.get(key)

            if isinstance(value, str) and value.strip():
                return value.strip()

        qrcode = data.get("qrcode")
        if isinstance(qrcode, dict):
            for key in ("instance", "instanceName", "instanceId"):
                value = qrcode.get(key)
                if isinstance(value, str) and value.strip():
                    return value.strip()

    elif isinstance(data, list):
        for item in data[:5]:
            if not isinstance(item, dict):
                continue

            for key in ("instance", "instanceName", "instanceId"):
                value = item.get(key)
                if isinstance(value, str) and value.strip():
                    return value.strip()

            key_obj = item.get("key")
            if isinstance(key_obj, dict):
                for key in ("instance", "instanceName", "instanceId"):
                    value = key_obj.get(key)
                    if isinstance(value, str) and value.strip():
                        return value.strip()

    return default


def _normalize_exchange_type(name: str) -> ExchangeType:
    mapping = {
        "direct": ExchangeType.DIRECT,
        "topic": ExchangeType.TOPIC,
        "fanout": ExchangeType.FANOUT,
        "headers": ExchangeType.HEADERS,
    }

    return mapping.get(name.lower(), ExchangeType.DIRECT)


def _try_json_loads_maybe(value: Any) -> Any:
    """
    Às vezes algum campo pode vir como string JSON.
    Não força tudo, só tenta quando parece JSON.
    """
    if not isinstance(value, str):
        return value

    s = value.strip()

    if not s:
        return value

    if not (
        (s.startswith("{") and s.endswith("}"))
        or (s.startswith("[") and s.endswith("]"))
    ):
        return value

    try:
        return json.loads(s)
    except Exception:
        return value


def _coerce_payload_shape(body: dict[str, Any]) -> dict[str, Any]:
    """
    Mantém compatibilidade, mas se data vier como string JSON,
    tenta transformar em dict/list para facilitar o parser.
    """
    try:
        if isinstance(body.get("data"), str):
            parsed = _try_json_loads_maybe(body.get("data"))

            if parsed is not body.get("data"):
                new_body = dict(body)
                new_body["data"] = parsed
                return new_body
    except Exception:
        pass

    return body


def _extract_remote_from_item(item: Any) -> str | None:
    if not isinstance(item, dict):
        return None

    key_obj = item.get("key")
    if isinstance(key_obj, dict):
        value = key_obj.get("remoteJid") or key_obj.get("remote_jid") or key_obj.get("jid")
        if isinstance(value, str) and value.strip():
            return value.strip()

    for key in (
        "remoteJid",
        "remote_jid",
        "jid",
        "id",
        "chatId",
        "chat_id",
        "participant",
        "from",
        "to",
    ):
        value = item.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()

    return None


def _extract_push_name_from_item(item: Any) -> str | None:
    if not isinstance(item, dict):
        return None

    for key in (
        "pushName",
        "push_name",
        "name",
        "verifiedName",
        "notifyName",
        "formattedName",
        "shortName",
        "contactName",
        "displayName",
        "subject",
        "title",
    ):
        value = item.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()

    return None


def _extract_data_items(body: dict[str, Any]) -> list[Any]:
    """
    Retorna a lista principal do payload para debug.

    Casos comuns:
    {
      event: "contacts.upsert",
      data: [...]
    }

    Também aceita:
    {
      data: { contacts: [...] }
    }
    """
    data = body.get("data")

    if isinstance(data, list):
        return data

    if isinstance(data, dict):
        for key in (
            "data",
            "contacts",
            "items",
            "rows",
            "results",
            "messages",
            "chats",
        ):
            value = data.get(key)
            if isinstance(value, list):
                return value

    for key in (
        "contacts",
        "items",
        "rows",
        "results",
        "messages",
        "chats",
    ):
        value = body.get(key)
        if isinstance(value, list):
            return value

    return []


def _payload_data_debug(body: dict[str, Any]) -> dict[str, Any]:
    """
    Debug resumido do payload cru recebido do Rabbit.

    Objetivo:
    - provar se contacts.upsert/update chegou grande ou pequeno
    - ver primeiro/último remoteJid
    - ver primeiro/último pushName
    """
    data = body.get("data")
    items = _extract_data_items(body)

    first = items[0] if items else None
    last = items[-1] if items else None

    return {
        "data_type": type(data).__name__,
        "data_len": len(items) if items else (len(data) if isinstance(data, list) else None),
        "first_remote": _extract_remote_from_item(first),
        "last_remote": _extract_remote_from_item(last),
        "first_pushName": _extract_push_name_from_item(first),
        "last_pushName": _extract_push_name_from_item(last),
        "first_keys": _safe_keys(first, limit=20) if isinstance(first, dict) else [],
        "last_keys": _safe_keys(last, limit=20) if isinstance(last, dict) else [],
    }


def _count_candidate_lists(obj: Any, *, depth: int = 0, path: str = "$") -> list[dict[str, Any]]:
    """
    Procura listas que podem conter mensagens/contatos.
    Não imprime conteúdo completo, só caminho/tamanho.
    """
    if depth > 6:
        return []

    found: list[dict[str, Any]] = []

    if isinstance(obj, dict):
        for key, value in obj.items():
            key_str = str(key)

            next_path = f"{path}.{key_str}"

            if isinstance(value, list):
                first = value[0] if value else None
                last = value[-1] if value else None

                found.append(
                    {
                        "path": next_path,
                        "len": len(value),
                        "first_type": type(first).__name__ if value else None,
                        "first_keys": _safe_keys(first, limit=15) if isinstance(first, dict) else [],
                        "first_remote": _extract_remote_from_item(first),
                        "last_remote": _extract_remote_from_item(last),
                        "first_pushName": _extract_push_name_from_item(first),
                        "last_pushName": _extract_push_name_from_item(last),
                    }
                )

            if isinstance(value, (dict, list)):
                found.extend(_count_candidate_lists(value, depth=depth + 1, path=next_path))

    elif isinstance(obj, list):
        first = obj[0] if obj else None
        last = obj[-1] if obj else None

        found.append(
            {
                "path": path,
                "len": len(obj),
                "first_type": type(first).__name__ if obj else None,
                "first_keys": _safe_keys(first, limit=15) if isinstance(first, dict) else [],
                "first_remote": _extract_remote_from_item(first),
                "last_remote": _extract_remote_from_item(last),
                "first_pushName": _extract_push_name_from_item(first),
                "last_pushName": _extract_push_name_from_item(last),
            }
        )

        for index, item in enumerate(obj[:3]):
            if isinstance(item, (dict, list)):
                found.extend(_count_candidate_lists(item, depth=depth + 1, path=f"{path}[{index}]"))

    return found


def _payload_shape(body: dict[str, Any]) -> dict[str, Any]:
    data = body.get("data")
    dbg = _payload_data_debug(body)

    shape = {
        "body_type": type(body).__name__,
        "body_keys": _safe_keys(body),
        "data_type": type(data).__name__,
        "data_keys": _safe_keys(data) if isinstance(data, dict) else [],
        "data_len": dbg.get("data_len"),
        "first_remote": dbg.get("first_remote"),
        "last_remote": dbg.get("last_remote"),
        "first_pushName": dbg.get("first_pushName"),
        "last_pushName": dbg.get("last_pushName"),
        "candidate_lists": _count_candidate_lists(body),
    }

    return shape


def _message_sample_preview(body: dict[str, Any]) -> dict[str, Any] | None:
    """
    Pega uma amostra segura do primeiro item encontrado em alguma lista.
    Não loga base64 nem mídia pesada.
    """
    def _walk(obj: Any, depth: int = 0) -> dict[str, Any] | None:
        if depth > 6:
            return None

        if isinstance(obj, list) and obj:
            first = obj[0]

            if isinstance(first, dict):
                key_obj = first.get("key") if isinstance(first.get("key"), dict) else {}
                msg_obj = first.get("message") if isinstance(first.get("message"), dict) else {}

                preview = {
                    "item_keys": _safe_keys(first, limit=25),
                    "key_keys": _safe_keys(key_obj, limit=20),
                    "msg_id": key_obj.get("id") or first.get("id"),
                    "remoteJid": _extract_remote_from_item(first),
                    "fromMe": key_obj.get("fromMe"),
                    "pushName": _extract_push_name_from_item(first),
                    "messageType": first.get("messageType"),
                    "timestamp": first.get("messageTimestamp") or first.get("timestamp"),
                    "message_keys": _safe_keys(msg_obj, limit=20),
                }

                return preview

            return {"first_type": type(first).__name__}

        if isinstance(obj, dict):
            priority_keys = [
                "messages",
                "message",
                "data",
                "items",
                "chats",
                "contacts",
            ]

            for key in priority_keys:
                if key in obj:
                    out = _walk(obj.get(key), depth + 1)

                    if out:
                        return out

            for value in obj.values():
                out = _walk(value, depth + 1)

                if out:
                    return out

        return None

    return _walk(body)


async def start(
    loop: asyncio.AbstractEventLoop,
    HANDLERS: Dict[Any, Callable],
    EvoEvent: Any,
) -> Tuple[Optional[asyncio.Task], Optional[Callable[[], Awaitable[None]]]]:
    enabled = _rabbit_enabled()
    rabbit_url = _rabbit_url()
    queue_name = _queue_name()
    exchange_name = _exchange_name()
    routing_keys = _routing_keys(queue_name)
    routing_key = routing_keys[0] if routing_keys else "#"
    exchange_type = _exchange_type()

    try:
        prefetch = int(_env("RABBITMQ_QOS", _env("RABBITMQ_PREFETCH", "25")) or "25")
    except Exception:
        prefetch = 25

    ephemeral_queue = _bool_env("RABBITMQ_EPHEMERAL_QUEUE", default=False)
    queue_auto_delete = _bool_env(
        "RABBITMQ_QUEUE_AUTO_DELETE",
        default=ephemeral_queue,
    )
    queue_exclusive = _bool_env(
        "RABBITMQ_QUEUE_EXCLUSIVE",
        default=ephemeral_queue,
    )
    delete_stale_dev_queue = _bool_env(
        "RABBITMQ_DELETE_STALE_DEV_QUEUE_ON_START",
        default=False,
    )

    durable = (_env("RABBITMQ_QUEUE_DURABLE", "true").lower() == "true")
    if ephemeral_queue:
        durable = False
        queue_auto_delete = True
        queue_exclusive = True

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
        rabbit_url=_safe_rabbit_url(rabbit_url),
        queue_name=queue_name,
        prefetch=prefetch,
        total_messages=0,
        total_dispatched=0,
        total_errors=0,
        last_raw_size=None,
        last_payload_shape=None,
    )

    if not enabled:
        print("[RABBIT] consumo desabilitado por env.")
        return (None, None)

    async def _dispatch(evt_name: str, body: dict[str, Any], *, message_meta: dict[str, Any] | None = None):
        started_at = time.perf_counter()

        key = _normalize_event_key(evt_name)

        # Defesa adicional: mesmo que uma fila antiga ainda esteja bindada em
        # messages.set, o ZapsChat não processa o histórico quando o n8n é o
        # responsável exclusivo por ele.
        if key == "MESSAGES_SET" and _history_managed_externally():
            if _should_trace(evt_name):
                print(
                    "[RABBIT][TRACE][dispatch-skip] "
                    "motivo=history_owned_by_n8n evt_key=MESSAGES_SET"
                )
            return

        inst = _extract_instance(body, default=None)
        shape = _payload_shape(body)
        data_debug = _payload_data_debug(body)
        sample = _message_sample_preview(body)

        _monitor_set(
            last_payload_shape=shape,
        )

        if _should_trace(evt_name):
            print(
                "[RABBIT][TRACE][dispatch-in] "
                f"evt_raw={evt_name} "
                f"evt_key={key} "
                f"inst={inst or '-'} "
                f"body_keys={shape.get('body_keys')} "
                f"data_type={shape.get('data_type')} "
                f"data_len={data_debug.get('data_len')} "
                f"first_remote={data_debug.get('first_remote') or '-'} "
                f"last_remote={data_debug.get('last_remote') or '-'} "
                f"first_pushName={data_debug.get('first_pushName') or '-'} "
                f"last_pushName={data_debug.get('last_pushName') or '-'} "
                f"data_keys={shape.get('data_keys')} "
                f"candidate_lists={shape.get('candidate_lists')} "
                f"meta={message_meta or {}}"
            )

            if sample:
                print(f"[RABBIT][TRACE][sample] evt_key={key} inst={inst or '-'} sample={sample}")

        evt = getattr(EvoEvent, key, None)

        if not evt:
            if _should_trace(evt_name):
                print(
                    "[RABBIT][TRACE][dispatch-skip] "
                    f"motivo=evento_sem_enum evt_raw={evt_name} evt_key={key} inst={inst or '-'}"
                )
            return

        handler_fn = HANDLERS.get(evt)

        if not handler_fn:
            if _should_trace(evt_name):
                print(
                    "[RABBIT][TRACE][dispatch-skip] "
                    f"motivo=handler_nao_encontrado evt_raw={evt_name} evt_key={key} inst={inst or '-'}"
                )
            return

        payload = body if "data" in body else {"instance": inst or "", "data": body}

        try:
            if _should_trace(evt_name):
                print(
                    "[RABBIT][TRACE][handler-call] "
                    f"evt_key={key} "
                    f"inst={inst or '-'} "
                    f"data_len={data_debug.get('data_len')} "
                    f"first_remote={data_debug.get('first_remote') or '-'} "
                    f"last_remote={data_debug.get('last_remote') or '-'} "
                    f"handler={getattr(handler_fn, '__name__', str(handler_fn))}"
                )

            out = handler_fn(inst or "", payload)

            if asyncio.iscoroutine(out):
                await out

            elapsed_ms = round((time.perf_counter() - started_at) * 1000, 2)
            _monitor_inc("total_dispatched", 1)

            if _should_trace(evt_name):
                print(
                    "[RABBIT][TRACE][handler-ok] "
                    f"evt_key={key} "
                    f"inst={inst or '-'} "
                    f"data_len={data_debug.get('data_len')} "
                    f"elapsed_ms={elapsed_ms}"
                )

        except Exception as e:
            elapsed_ms = round((time.perf_counter() - started_at) * 1000, 2)
            err = str(e)
            tb = traceback.format_exc(limit=10)

            print(
                "[RABBIT][ERROR][handler] "
                f"evt_key={key} inst={inst or '-'} elapsed_ms={elapsed_ms} err={err}"
            )
            print(f"[RABBIT][ERROR][handler-trace]\n{tb}")

            _monitor_inc("total_errors", 1)
            _monitor_set(last_error=err)

    stop_evt = asyncio.Event()

    async def _handle_message(message: IncomingMessage):
        raw_bytes = message.body or b""
        raw_size = _json_size_bytes(raw_bytes)

        _monitor_inc("total_messages", 1)
        _monitor_set(
            last_message_at=time.time(),
            last_raw_size=raw_size,
        )

        raw = raw_bytes.decode("utf-8", errors="ignore").strip()

        if not raw:
            if _trace_all_enabled():
                print("[RABBIT][TRACE][empty] mensagem vazia recebida.")
            return

        message_meta = {
            "routing_key": message.routing_key,
            "exchange": message.exchange,
            "delivery_tag": getattr(message, "delivery_tag", None),
            "content_type": getattr(message, "content_type", None),
            "headers": dict(getattr(message, "headers", None) or {}),
            "raw_size": raw_size,
        }

        try:
            body_any = json.loads(raw)
        except Exception as e:
            err = f"JSON inválido: {e}"
            print(f"[RABBIT] {err} raw_preview={_short(raw, 500)}")
            _monitor_inc("total_errors", 1)
            _monitor_set(last_error=err)
            return

        if not isinstance(body_any, dict):
            if _trace_all_enabled():
                print(
                    "[RABBIT][TRACE][skip] body não é dict "
                    f"type={type(body_any).__name__} raw_preview={_short(raw, 300)}"
                )
            return

        body = _coerce_payload_shape(body_any)

        evt_name = _extract_event_name(body, routing_key=message.routing_key)

        if not evt_name:
            if _trace_all_enabled() or _trace_history_enabled():
                print(
                    "[RABBIT][TRACE][skip] sem evento detectado "
                    f"routing_key={message.routing_key} "
                    f"body_keys={_safe_keys(body)} "
                    f"raw_size={raw_size}"
                )
            return

        inst = _extract_instance(body, default=None)
        key = _normalize_event_key(evt_name)
        shape = _payload_shape(body)
        data_debug = _payload_data_debug(body)

        record_rabbit_event(
            evt_name,
            routing_key=message.routing_key,
            event_key=key,
            instance=inst,
            raw_size=raw_size,
            data_type=data_debug.get("data_type"),
            data_len=data_debug.get("data_len"),
            first_remote=data_debug.get("first_remote"),
            last_remote=data_debug.get("last_remote"),
            first_pushName=data_debug.get("first_pushName"),
            last_pushName=data_debug.get("last_pushName"),
            candidate_lists=shape.get("candidate_lists"),
        )

        if _should_trace(evt_name):
            print(
                "[RABBIT][TRACE][received] "
                f"evt_raw={evt_name} "
                f"evt_key={key} "
                f"inst={inst or '-'} "
                f"routing_key={message.routing_key} "
                f"raw_size={raw_size} "
                f"body_keys={shape.get('body_keys')} "
                f"data_type={shape.get('data_type')} "
                f"data_len={data_debug.get('data_len')} "
                f"first_remote={data_debug.get('first_remote') or '-'} "
                f"last_remote={data_debug.get('last_remote') or '-'} "
                f"first_pushName={data_debug.get('first_pushName') or '-'} "
                f"last_pushName={data_debug.get('last_pushName') or '-'} "
                f"data_keys={shape.get('data_keys')} "
                f"candidate_lists={shape.get('candidate_lists')}"
            )

        await _dispatch(evt_name, body, message_meta=message_meta)

    async def _runner():
        while not stop_evt.is_set():
            safe_url = _safe_rabbit_url(rabbit_url)
            print(f"[RABBIT] Conectando em: {safe_url}")

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

                # A fila local antiga era não-durável, porém não era auto-delete.
                # Assim ela continuava acumulando mensagens enquanto o PC estava desligado.
                # Só removemos automaticamente nomes claramente de desenvolvimento.
                if (
                    ephemeral_queue
                    and delete_stale_dev_queue
                    and queue_name
                    and ".dev." in queue_name.lower()
                ):
                    try:
                        stale_queue = await channel.get_queue(queue_name, ensure=False)
                        await stale_queue.delete(if_unused=False, if_empty=False)
                        print(f"[RABBIT] fila local antiga removida: {queue_name}")
                    except Exception:
                        pass

                requested_queue_name = "" if ephemeral_queue else queue_name
                queue = await channel.declare_queue(
                    requested_queue_name,
                    durable=durable,
                    auto_delete=queue_auto_delete,
                    exclusive=queue_exclusive,
                )
                active_queue_name = str(queue.name or queue_name)
                _monitor_set(queue_name=active_queue_name)

                if exchange_name:
                    exchange = await channel.declare_exchange(
                        exchange_name,
                        _normalize_exchange_type(exchange_type),
                        durable=True,
                    )
                    for rk in routing_keys:
                        await queue.bind(exchange, routing_key=rk)

                    print(
                        f"[RABBIT] Fila '{active_queue_name}' bindada na exchange "
                        f"'{exchange_name}' com routing_keys {routing_keys}"
                    )
                else:
                    print(
                        f"[RABBIT] Sem exchange configurada; consumindo fila direta '{active_queue_name}'."
                    )

                _monitor_set(
                    connected=True,
                    last_error=None,
                )

                print(
                    f"[RABBIT] Consumindo fila: {active_queue_name} "
                    f"prefetch={prefetch} heartbeat={heartbeat} durable={durable} "
                    f"auto_delete={queue_auto_delete} exclusive={queue_exclusive} "
                    f"trace_history={_trace_history_enabled()} trace_all={_trace_all_enabled()}"
                )

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
                                err = str(e)
                                tb = traceback.format_exc(limit=10)

                                print(f"[RABBIT] erro processando mensagem: {err}")
                                print(f"[RABBIT][ERROR][process-trace]\n{tb}")

                                _monitor_inc("total_errors", 1)
                                _monitor_set(last_error=err)

            except asyncio.CancelledError:
                _monitor_set(connected=False)
                raise

            except Exception as e:
                err = str(e)
                tb = traceback.format_exc(limit=10)

                print(f"[RABBIT] falha geral: {err}")

                if _trace_history_enabled() or _trace_all_enabled():
                    print(f"[RABBIT][ERROR][runner-trace]\n{tb}")

                _monitor_inc("total_errors", 1)
                _monitor_set(
                    connected=False,
                    last_error=err,
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
    use_thread = _bool_env("RABBITMQ_DEDICATED_THREAD", default=True)

    if not use_thread:
        print("[RABBIT] modo antigo: consumer no event loop principal do FastAPI.")
        return await start(loop, HANDLERS, EvoEvent)

    stop_flag = threading.Event()
    ready_flag = threading.Event()
    holder: dict[str, Any] = {
        "loop": None,
        "task": None,
        "stop": None,
        "error": None,
    }

    def _thread_main() -> None:
        thread_loop = asyncio.new_event_loop()
        asyncio.set_event_loop(thread_loop)
        holder["loop"] = thread_loop

        async def _boot_and_wait():
            try:
                task, inner_stop = await start(thread_loop, HANDLERS, EvoEvent)
                holder["task"] = task
                holder["stop"] = inner_stop
                ready_flag.set()

                while not stop_flag.is_set():
                    await asyncio.sleep(0.25)

                if inner_stop:
                    await inner_stop()

                if task:
                    try:
                        await asyncio.wait_for(task, timeout=3.0)
                    except asyncio.CancelledError:
                        pass
                    except asyncio.TimeoutError:
                        try:
                            task.cancel()
                        except Exception:
                            pass
                    except Exception as e:
                        print(f"[RABBIT][thread] erro ao encerrar task: {e}")

            except Exception as e:
                holder["error"] = e
                ready_flag.set()
                print(f"[RABBIT][thread] falha no consumer dedicado: {e}")
                raise

        try:
            thread_loop.run_until_complete(_boot_and_wait())
        finally:
            try:
                pending = [t for t in asyncio.all_tasks(thread_loop) if not t.done()]
                for t in pending:
                    t.cancel()
                if pending:
                    thread_loop.run_until_complete(
                        asyncio.gather(*pending, return_exceptions=True)
                    )
            except Exception:
                pass

            try:
                thread_loop.close()
            except Exception:
                pass

    thread = threading.Thread(
        target=_thread_main,
        name="zapschat-rabbit-consumer",
        daemon=True,
    )
    thread.start()
    ready_flag.wait(timeout=8.0)

    if holder.get("error"):
        raise holder["error"]

    print("[RABBIT] consumer isolado em thread dedicada ligado.")

    async def _stop_thread():
        stop_flag.set()

        thread_loop = holder.get("loop")
        if thread_loop and not thread_loop.is_closed():
            try:
                thread_loop.call_soon_threadsafe(lambda: None)
            except Exception:
                pass

        if thread.is_alive():
            try:
                await asyncio.to_thread(thread.join, 3.0)
            except Exception:
                pass

    # Não devolvemos a task interna porque ela pertence a outro event loop/thread.
    # O shutdown usa rabbit_stop para encerrar.
    return (None, _stop_thread)


__all__ = [
    "RABBIT_MONITOR",
    "get_rabbit_monitor",
    "record_rabbit_event",
    "start",
    "start_rabbit_consumer",
]
