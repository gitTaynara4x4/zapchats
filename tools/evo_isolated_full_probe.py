# tools/evo_isolated_full_probe.py
from __future__ import annotations

import asyncio
import base64
import html
import json
import os
import re
import sys
import time
import webbrowser
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

import requests

try:
    import aio_pika
    from aio_pika import ExchangeType, IncomingMessage
except Exception:
    print("ERRO: aio_pika não está instalado. Instale com: pip install aio-pika")
    raise

try:
    import socketio
except Exception:
    socketio = None

try:
    import urllib3
    urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
except Exception:
    pass


ROOT_DIR = Path(__file__).resolve().parents[1]
ENV_PATH = ROOT_DIR / ".env"


def _load_dotenv(path: Path) -> None:
    if not path.exists():
        return

    for raw_line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue

        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")

        if key and key not in os.environ:
            os.environ[key] = value


_load_dotenv(ENV_PATH)


def _env(name: str, default: str = "") -> str:
    return str(os.getenv(name, default) or default).strip()


def _env_bool(name: str, default: bool = False) -> bool:
    raw = _env(name, "true" if default else "false").lower()
    return raw in {"1", "true", "yes", "sim", "on"}


def _safe_url(url: str) -> str:
    return re.sub(r"(amqps?://[^:/\s]+:)([^@\s]+)(@)", r"\1******\3", str(url or ""))


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _ts_to_iso(ts: Any) -> str:
    try:
        if ts is None or ts == "":
            return ""
        val = int(float(ts))
        if val > 10_000_000_000:
            val = int(val / 1000)
        return datetime.fromtimestamp(val, timezone.utc).isoformat()
    except Exception:
        return ""


EVOLUTION_URL = _env("EVOLUTION_URL", "").rstrip("/")
EVOLUTION_APIKEY = _env("EVOLUTION_APIKEY") or _env("EVOLUTION_KEY") or _env("AUTHENTICATION_API_KEY")
VERIFY_SSL = _env_bool("EVO_PROBE_VERIFY_SSL", False)

RABBITMQ_URI = _env("RABBITMQ_URI") or _env("RABBITMQ_URL") or _env("AMQP_URL")
RABBIT_EXCHANGE = _env("RABBITMQ_EXCHANGE_NAME", "evolution_exchange")
RABBIT_EXCHANGE_TYPE = _env("RABBITMQ_EXCHANGE_TYPE", "topic").lower()
RABBIT_BINDING = _env("EVO_PROBE_RABBIT_BINDING") or _env("RABBITMQ_ROUTING_KEY", "#") or "#"

INSTANCE_PREFIX = _env("EVO_PROBE_INSTANCE_PREFIX", "raw-full-zapschat")
INSTANCE_NAME = _env("EVO_PROBE_INSTANCE_NAME") or f"{INSTANCE_PREFIX}-{int(time.time())}"

OUTPUT_DIR = ROOT_DIR / "logs" / "evo_isolated" / INSTANCE_NAME
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

HEADERS = {
    "apikey": EVOLUTION_APIKEY,
    "Content-Type": "application/json",
}

QR_HTML_FILE = OUTPUT_DIR / f"qr_{INSTANCE_NAME}.html"
RAW_CURRENT_JSONL = OUTPUT_DIR / "raw_events_current_instance.jsonl"
RAW_ALL_JSONL = OUTPUT_DIR / "raw_events_all_instances.jsonl"
RAW_CURRENT_TXT = OUTPUT_DIR / "raw_events_current_instance.txt"
RAW_WS_JSONL = OUTPUT_DIR / "raw_ws_current_instance.jsonl"

MESSAGES_TXT = OUTPUT_DIR / "messages_all.txt"
MESSAGES_JSONL = OUTPUT_DIR / "messages_all.jsonl"
CONTACTS_TXT = OUTPUT_DIR / "contacts_all.txt"
CONTACTS_JSONL = OUTPUT_DIR / "contacts_all.jsonl"
CHATS_TXT = OUTPUT_DIR / "chats_all.txt"
CHATS_JSONL = OUTPUT_DIR / "chats_all.jsonl"
SUMMARY_TXT = OUTPUT_DIR / "summary.txt"

FULL_EVENTS = [
    "APPLICATION_STARTUP",
    "INSTANCE_CREATE",
    "INSTANCE_DELETE",
    "QRCODE_UPDATED",
    "CONNECTION_UPDATE",
    "MESSAGES_SET",
    "MESSAGES_UPSERT",
    "MESSAGES_UPDATE",
    "MESSAGES_DELETE",
    "MESSAGES_EDITED",
    "SEND_MESSAGE",
    "CONTACTS_SET",
    "CONTACTS_UPSERT",
    "CONTACTS_UPDATE",
    "CHATS_SET",
    "CHATS_UPSERT",
    "CHATS_UPDATE",
    "CHATS_DELETE",
    "GROUPS_UPSERT",
    "GROUP_UPDATE",
    "GROUP_PARTICIPANTS_UPDATE",
    "LABELS_EDIT",
    "LABELS_ASSOCIATION",
    "PRESENCE_UPDATE",
    "CALL",
]

COUNTERS: dict[str, int] = {
    "raw_current": 0,
    "raw_all": 0,
    "ws_current": 0,
    "messages": 0,
    "contacts": 0,
    "chats": 0,
    "messages_set_packets": 0,
    "messages_upsert_packets": 0,
    "contacts_packets": 0,
    "chats_packets": 0,
}

SEEN_MESSAGES: set[str] = set()
SEEN_CONTACTS: set[str] = set()
SEEN_CHATS: set[str] = set()


def _init_files() -> None:
    MESSAGES_TXT.write_text(
        f"MESSAGES - {INSTANCE_NAME}\nGerado em: {_now_iso()}\nSem filtro de 24h/7d.\n\n",
        encoding="utf-8",
    )
    CONTACTS_TXT.write_text(
        f"CONTACTS - {INSTANCE_NAME}\nGerado em: {_now_iso()}\n\n",
        encoding="utf-8",
    )
    CHATS_TXT.write_text(
        f"CHATS - {INSTANCE_NAME}\nGerado em: {_now_iso()}\n\n",
        encoding="utf-8",
    )
    RAW_CURRENT_TXT.write_text(
        f"RAW EVENTS CURRENT INSTANCE - {INSTANCE_NAME}\nGerado em: {_now_iso()}\n\n",
        encoding="utf-8",
    )
    SUMMARY_TXT.write_text(
        f"SUMMARY - {INSTANCE_NAME}\nGerado em: {_now_iso()}\n\n",
        encoding="utf-8",
    )

    for p in [
        RAW_CURRENT_JSONL,
        RAW_ALL_JSONL,
        RAW_WS_JSONL,
        MESSAGES_JSONL,
        CONTACTS_JSONL,
        CHATS_JSONL,
    ]:
        p.write_text("", encoding="utf-8")


_init_files()


def _append_text(path: Path, text: str) -> None:
    with path.open("a", encoding="utf-8", errors="ignore") as f:
        f.write(text)


def _append_jsonl(path: Path, obj: Any) -> None:
    with path.open("a", encoding="utf-8", errors="ignore") as f:
        f.write(json.dumps(obj, ensure_ascii=False, default=str) + "\n")


def _write_summary() -> None:
    text = [
        f"SUMMARY - {INSTANCE_NAME}",
        f"Atualizado em: {_now_iso()}",
        "",
        f"raw_current={COUNTERS['raw_current']}",
        f"raw_all={COUNTERS['raw_all']}",
        f"ws_current={COUNTERS['ws_current']}",
        f"messages={COUNTERS['messages']}",
        f"contacts={COUNTERS['contacts']}",
        f"chats={COUNTERS['chats']}",
        f"messages_set_packets={COUNTERS['messages_set_packets']}",
        f"messages_upsert_packets={COUNTERS['messages_upsert_packets']}",
        f"contacts_packets={COUNTERS['contacts_packets']}",
        f"chats_packets={COUNTERS['chats_packets']}",
        "",
        f"messages_txt={MESSAGES_TXT}",
        f"contacts_txt={CONTACTS_TXT}",
        f"chats_txt={CHATS_TXT}",
        f"raw_current_jsonl={RAW_CURRENT_JSONL}",
        f"raw_all_jsonl={RAW_ALL_JSONL}",
    ]
    SUMMARY_TXT.write_text("\n".join(text) + "\n", encoding="utf-8")


def _event_key(event_name: Any, routing_key: Any = None) -> str:
    raw = str(event_name or routing_key or "").strip()
    return raw.replace(".", "_").replace("-", "_").upper()


def _data_len(data: Any) -> str:
    if isinstance(data, list):
        return str(len(data))
    if isinstance(data, dict):
        for k in ("messages", "contacts", "chats", "items", "data"):
            v = data.get(k)
            if isinstance(v, list):
                return str(len(v))
        return "dict"
    if data is None:
        return "none"
    return type(data).__name__


def _instance_from_event(body: dict[str, Any]) -> str:
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

    return ""


def _dig(obj: Any, *path: str, default: Any = None) -> Any:
    cur = obj
    for key in path:
        if not isinstance(cur, dict):
            return default
        cur = cur.get(key)
    return cur if cur is not None else default


def _first_non_empty(*values: Any) -> Any:
    for v in values:
        if v is None:
            continue
        if isinstance(v, str) and not v.strip():
            continue
        return v
    return None


def _as_items(data: Any, event_key: str = "") -> list[Any]:
    if data is None:
        return []

    if isinstance(data, list):
        return data

    if isinstance(data, dict):
        for k in ("messages", "contacts", "chats", "items", "list", "records"):
            v = data.get(k)
            if isinstance(v, list):
                return v

        nested = data.get("data")
        if isinstance(nested, list):
            return nested

        return [data]

    return [data]


def _extract_message_text(msg_obj: Any) -> str:
    if not isinstance(msg_obj, dict):
        return ""

    msg = msg_obj.get("message")
    if not isinstance(msg, dict):
        msg = msg_obj

    candidates: list[Any] = [
        msg.get("conversation"),
        _dig(msg, "extendedTextMessage", "text"),
        _dig(msg, "imageMessage", "caption"),
        _dig(msg, "videoMessage", "caption"),
        _dig(msg, "documentMessage", "caption"),
        _dig(msg, "buttonsResponseMessage", "selectedDisplayText"),
        _dig(msg, "buttonsResponseMessage", "selectedButtonId"),
        _dig(msg, "listResponseMessage", "title"),
        _dig(msg, "listResponseMessage", "singleSelectReply", "selectedRowId"),
        _dig(msg, "templateButtonReplyMessage", "selectedDisplayText"),
        _dig(msg, "templateButtonReplyMessage", "selectedId"),
        _dig(msg, "reactionMessage", "text"),
    ]

    for c in candidates:
        if isinstance(c, str) and c.strip():
            return c.strip()

    if "imageMessage" in msg:
        return "[Imagem]"
    if "videoMessage" in msg:
        return "[Vídeo]"
    if "audioMessage" in msg:
        return "[Áudio]"
    if "documentMessage" in msg:
        return "[Documento]"
    if "stickerMessage" in msg:
        return "[Sticker]"
    if "contactMessage" in msg:
        return "[Contato]"
    if "locationMessage" in msg:
        return "[Localização]"

    return ""


def _message_type(item: Any) -> str:
    if not isinstance(item, dict):
        return ""
    direct = item.get("messageType") or item.get("type")
    if isinstance(direct, str) and direct.strip():
        return direct.strip()
    msg = item.get("message")
    if isinstance(msg, dict) and msg:
        return next(iter(msg.keys()))
    return ""


def _message_id(item: Any) -> str:
    if not isinstance(item, dict):
        return ""
    return str(
        _first_non_empty(
            _dig(item, "key", "id"),
            item.get("id"),
            item.get("messageId"),
            item.get("keyId"),
        )
        or ""
    )


def _remote_jid(item: Any) -> str:
    if not isinstance(item, dict):
        return ""
    return str(
        _first_non_empty(
            _dig(item, "key", "remoteJid"),
            item.get("remoteJid"),
            item.get("remote_jid"),
            item.get("jid"),
            item.get("id"),
        )
        or ""
    )


def _from_me(item: Any) -> Any:
    if not isinstance(item, dict):
        return None
    return _first_non_empty(
        _dig(item, "key", "fromMe"),
        item.get("fromMe"),
        item.get("from_me"),
    )


def _msg_timestamp(item: Any) -> Any:
    if not isinstance(item, dict):
        return None
    return _first_non_empty(
        item.get("messageTimestamp"),
        item.get("timestamp"),
        item.get("message_timestamp"),
        item.get("t"),
        _dig(item, "message", "messageTimestamp"),
    )


def _save_messages(event_name: str, instance: str, data: Any, source: str) -> None:
    event_key = _event_key(event_name)
    items = _as_items(data, event_key)

    if event_key == "MESSAGES_SET":
        COUNTERS["messages_set_packets"] += 1
    elif event_key == "MESSAGES_UPSERT":
        COUNTERS["messages_upsert_packets"] += 1

    added = 0
    for item in items:
        if not isinstance(item, dict):
            continue

        msg_id = _message_id(item)
        remote = _remote_jid(item)
        ts_raw = _msg_timestamp(item)
        text = _extract_message_text(item)
        from_me = _from_me(item)
        msg_type = _message_type(item)
        push_name = str(item.get("pushName") or item.get("push_name") or "")
        status = str(item.get("status") or "")

        sig = "|".join([str(event_key), str(msg_id), str(remote), str(ts_raw), str(from_me), text[:80]])
        if sig in SEEN_MESSAGES:
            continue
        SEEN_MESSAGES.add(sig)

        COUNTERS["messages"] += 1
        added += 1
        idx = COUNTERS["messages"]

        compact = {
            "source": source,
            "event": event_name,
            "event_key": event_key,
            "instance": instance,
            "idx": idx,
            "msg_id": msg_id,
            "remote_jid": remote,
            "from_me": from_me,
            "push_name": push_name,
            "status": status,
            "message_type": msg_type,
            "timestamp_raw": ts_raw,
            "timestamp_iso": _ts_to_iso(ts_raw),
            "text": text,
            "item": item,
        }
        _append_jsonl(MESSAGES_JSONL, compact)

        msg_keys = []
        if isinstance(item.get("message"), dict):
            msg_keys = list(item["message"].keys())

        _append_text(
            MESSAGES_TXT,
            "\n" + "-" * 80 + "\n"
            f"source={source}\n"
            f"event={event_name}\n"
            f"event_key={event_key}\n"
            f"instance={instance}\n"
            f"idx={idx}\n"
            f"msg_id={msg_id}\n"
            f"remote_jid={remote}\n"
            f"from_me={from_me}\n"
            f"push_name={push_name}\n"
            f"status={status}\n"
            f"message_type={msg_type}\n"
            f"message_keys={msg_keys}\n"
            f"timestamp_raw={ts_raw}\n"
            f"timestamp_iso={_ts_to_iso(ts_raw)}\n"
            f"text={text}\n",
        )

    if event_key in {"MESSAGES_SET", "MESSAGES_UPSERT"}:
        print(f"[SAVE][messages] source={source} event={event_name} +{added} total={COUNTERS['messages']}")


def _save_contacts(event_name: str, instance: str, data: Any, source: str) -> None:
    event_key = _event_key(event_name)
    items = _as_items(data, event_key)
    COUNTERS["contacts_packets"] += 1

    added = 0
    for item in items:
        if not isinstance(item, dict):
            continue

        jid = str(_first_non_empty(item.get("remoteJid"), item.get("jid"), item.get("id"), item.get("number")) or "")
        name = str(
            _first_non_empty(
                item.get("name"),
                item.get("pushName"),
                item.get("verifiedName"),
                item.get("notify"),
                item.get("shortName"),
            )
            or ""
        )
        profile_pic = str(
            _first_non_empty(item.get("profilePicUrl"), item.get("profilePictureUrl"), item.get("picture")) or ""
        )

        sig = "|".join([jid, name, profile_pic])
        if sig in SEEN_CONTACTS:
            continue
        SEEN_CONTACTS.add(sig)

        COUNTERS["contacts"] += 1
        added += 1
        idx = COUNTERS["contacts"]

        compact = {
            "source": source,
            "event": event_name,
            "event_key": event_key,
            "instance": instance,
            "idx": idx,
            "jid": jid,
            "name": name,
            "profile_pic": profile_pic,
            "item": item,
        }
        _append_jsonl(CONTACTS_JSONL, compact)
        _append_text(
            CONTACTS_TXT,
            "\n" + "-" * 80 + "\n"
            f"source={source}\n"
            f"event={event_name}\n"
            f"instance={instance}\n"
            f"idx={idx}\n"
            f"jid={jid}\n"
            f"name={name}\n"
            f"profile_pic={profile_pic}\n",
        )

    if event_key.startswith("CONTACTS_"):
        print(f"[SAVE][contacts] source={source} event={event_name} +{added} total={COUNTERS['contacts']}")


def _save_chats(event_name: str, instance: str, data: Any, source: str) -> None:
    event_key = _event_key(event_name)
    items = _as_items(data, event_key)
    COUNTERS["chats_packets"] += 1

    added = 0
    for item in items:
        if not isinstance(item, dict):
            continue

        jid = str(_first_non_empty(item.get("remoteJid"), item.get("jid"), item.get("id")) or "")
        name = str(_first_non_empty(item.get("name"), item.get("subject"), item.get("pushName"), item.get("verifiedName")) or "")
        ts_raw = _first_non_empty(item.get("conversationTimestamp"), item.get("timestamp"), item.get("t"))
        unread = _first_non_empty(item.get("unreadCount"), item.get("unread"))
        archived = item.get("archived")
        pinned = item.get("pinned")

        sig = "|".join([jid, name, str(ts_raw), str(unread), str(archived), str(pinned)])
        if sig in SEEN_CHATS:
            continue
        SEEN_CHATS.add(sig)

        COUNTERS["chats"] += 1
        added += 1
        idx = COUNTERS["chats"]

        compact = {
            "source": source,
            "event": event_name,
            "event_key": event_key,
            "instance": instance,
            "idx": idx,
            "jid": jid,
            "name": name,
            "timestamp_raw": ts_raw,
            "timestamp_iso": _ts_to_iso(ts_raw),
            "unread": unread,
            "archived": archived,
            "pinned": pinned,
            "item": item,
        }
        _append_jsonl(CHATS_JSONL, compact)
        _append_text(
            CHATS_TXT,
            "\n" + "-" * 80 + "\n"
            f"source={source}\n"
            f"event={event_name}\n"
            f"instance={instance}\n"
            f"idx={idx}\n"
            f"jid={jid}\n"
            f"name={name}\n"
            f"timestamp_raw={ts_raw}\n"
            f"timestamp_iso={_ts_to_iso(ts_raw)}\n"
            f"unread={unread}\n"
            f"archived={archived}\n"
            f"pinned={pinned}\n",
        )

    if event_key.startswith("CHATS_"):
        print(f"[SAVE][chats] source={source} event={event_name} +{added} total={COUNTERS['chats']}")


def _parse_current_event(source: str, event_name: str, instance: str, data: Any) -> None:
    key = _event_key(event_name)

    if key in {"MESSAGES_SET", "MESSAGES_UPSERT"}:
        _save_messages(event_name, instance, data, source)
    elif key in {"CONTACTS_SET", "CONTACTS_UPSERT", "CONTACTS_UPDATE"}:
        _save_contacts(event_name, instance, data, source)
    elif key in {"CHATS_SET", "CHATS_UPSERT", "CHATS_UPDATE", "CHATS_DELETE"}:
        _save_chats(event_name, instance, data, source)

    _write_summary()


def _extract_qr_string(obj: Any, depth: int = 0) -> Optional[str]:
    if depth > 5 or obj is None:
        return None

    if isinstance(obj, str):
        s = obj.strip()
        if not s:
            return None
        if s.startswith("data:image/") or len(s) > 250:
            return s
        return None

    if isinstance(obj, dict):
        priority = [
            "base64",
            "qrcode",
            "qrCode",
            "qr",
            "code",
            "pairingCode",
        ]
        for k in priority:
            if k in obj:
                found = _extract_qr_string(obj.get(k), depth + 1)
                if found:
                    return found
        for v in obj.values():
            found = _extract_qr_string(v, depth + 1)
            if found:
                return found

    if isinstance(obj, list):
        for item in obj:
            found = _extract_qr_string(item, depth + 1)
            if found:
                return found

    return None


def _save_qr_html(qr_value: str, origin: str) -> None:
    qr = str(qr_value or "").strip()
    if not qr:
        return

    img_html = ""
    raw_html = ""

    if qr.startswith("data:image/"):
        img_html = f'<img src="{html.escape(qr)}" alt="QR Code" />'
    else:
        maybe_img = False
        try:
            raw = base64.b64decode(qr[:200] + "===", validate=False)
            maybe_img = bool(raw)
        except Exception:
            maybe_img = False

        if maybe_img and len(qr) > 500:
            img_html = f'<img src="data:image/png;base64,{html.escape(qr)}" alt="QR Code" />'
        else:
            raw_html = f"<pre>{html.escape(qr)}</pre>"

            try:
                import qrcode  # type: ignore

                png_path = OUTPUT_DIR / f"qr_{INSTANCE_NAME}.png"
                img = qrcode.make(qr)
                img.save(png_path)
                img_html = f'<img src="{html.escape(png_path.name)}" alt="QR Code" />'
            except Exception:
                pass

    html_doc = f"""<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>QR Evolution - {html.escape(INSTANCE_NAME)}</title>
  <style>
    body {{
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      background: #07130f;
      color: #eafff3;
      font-family: Arial, sans-serif;
    }}
    .card {{
      width: min(760px, calc(100vw - 32px));
      padding: 28px;
      border-radius: 24px;
      background: #0d1d16;
      box-shadow: 0 18px 60px rgba(0,0,0,.35);
      text-align: center;
      border: 1px solid rgba(70, 255, 146, .18);
    }}
    img {{
      width: min(420px, 86vw);
      height: auto;
      background: white;
      padding: 16px;
      border-radius: 20px;
    }}
    pre {{
      white-space: pre-wrap;
      word-break: break-word;
      text-align: left;
      background: #06100c;
      padding: 16px;
      border-radius: 14px;
      max-height: 320px;
      overflow: auto;
    }}
    .muted {{ color: #a8c7b6; font-size: 14px; }}
    h1 {{ margin: 0 0 8px; font-size: 24px; }}
  </style>
</head>
<body>
  <div class="card">
    <h1>Leia este QR no WhatsApp</h1>
    <p class="muted">Instância: {html.escape(INSTANCE_NAME)}</p>
    <p class="muted">Origem: {html.escape(origin)} | Gerado em: {html.escape(_now_iso())}</p>
    {img_html}
    {raw_html}
    <p class="muted">Depois de ler, deixe o terminal aberto para capturar messages.set, contacts.set e chats.set.</p>
  </div>
</body>
</html>"""

    QR_HTML_FILE.write_text(html_doc, encoding="utf-8")
    print(f"\n[QR] HTML salvo em: {QR_HTML_FILE}")
    print("[QR] Abrindo QR automaticamente no navegador...\n")
    try:
        webbrowser.open(QR_HTML_FILE.resolve().as_uri())
    except Exception as e:
        print(f"[QR] não consegui abrir automático: {e}")


def _request(method: str, url: str, **kwargs) -> requests.Response:
    kwargs.setdefault("headers", HEADERS)
    kwargs.setdefault("timeout", 30)
    kwargs.setdefault("verify", VERIFY_SSL)
    return requests.request(method, url, **kwargs)


def _try_json(resp: requests.Response) -> Any:
    try:
        return resp.json()
    except Exception:
        return {"text": resp.text[:2000]}


def _create_instance() -> Any:
    if not EVOLUTION_URL or not EVOLUTION_APIKEY:
        raise RuntimeError("EVOLUTION_URL ou EVOLUTION_APIKEY/EVOLUTION_KEY não encontrado. Confira o .env.")

    print(f"\n[EVOLUTION] URL: {EVOLUTION_URL}")
    print(f"[EVOLUTION] instance: {INSTANCE_NAME}")
    print(f"[EVOLUTION] verify_ssl: {VERIFY_SSL}")
    print("[EVOLUTION] NÃO chama setPresence.\n")

    payloads = [
        {
            "instanceName": INSTANCE_NAME,
            "qrcode": True,
            "integration": "WHATSAPP-BAILEYS",
        },
        {
            "instanceName": INSTANCE_NAME,
            "qrcode": True,
        },
    ]

    last_js = None
    for i, payload in enumerate(payloads, start=1):
        try:
            resp = _request("POST", f"{EVOLUTION_URL}/instance/create", json=payload, timeout=45)
            js = _try_json(resp)
            last_js = js
            print(f"[EVOLUTION] instance/create tentativa={i} status={resp.status_code} ok={resp.ok}")

            qr = _extract_qr_string(js)
            if qr:
                _save_qr_html(qr, "instance/create")

            if resp.ok or resp.status_code in {200, 201, 409}:
                return js
        except Exception as e:
            print(f"[EVOLUTION] instance/create tentativa={i} erro={e}")

    return last_js


def _configure_rabbit() -> None:
    body = {
        "rabbitmq": {
            "enabled": True,
            "exchange": RABBIT_EXCHANGE,
            "bindings": [RABBIT_BINDING],
            "events": FULL_EVENTS,
        }
    }

    try:
        resp = _request("POST", f"{EVOLUTION_URL}/rabbitmq/set/{INSTANCE_NAME}", json=body, timeout=30)
        print(f"[EVOLUTION] rabbitmq/set status={resp.status_code} ok={resp.ok}")
        if not resp.ok:
            print(f"[EVOLUTION] rabbitmq/set body={resp.text[:800]}")
    except Exception as e:
        print(f"[EVOLUTION] rabbitmq/set erro={e}")


def _configure_websocket() -> None:
    body = {
        "websocket": {
            "enabled": True,
            "events": FULL_EVENTS,
        }
    }

    try:
        resp = _request("POST", f"{EVOLUTION_URL}/websocket/set/{INSTANCE_NAME}", json=body, timeout=30)
        print(f"[EVOLUTION] websocket/set status={resp.status_code} ok={resp.ok}")
        if not resp.ok:
            print(f"[EVOLUTION] websocket/set body={resp.text[:800]}")
    except Exception as e:
        print(f"[EVOLUTION] websocket/set erro={e}")


def _connect_instance() -> None:
    print("\n[EVOLUTION] chamando connect...")

    calls = [
        ("GET", f"{EVOLUTION_URL}/instance/connect/{INSTANCE_NAME}"),
        ("POST", f"{EVOLUTION_URL}/instance/connect/{INSTANCE_NAME}"),
    ]

    for i, (method, url) in enumerate(calls, start=1):
        try:
            resp = _request(method, url, timeout=45)
            js = _try_json(resp)
            print(f"[EVOLUTION] connect tentativa={i} method={method} status={resp.status_code} ok={resp.ok}")

            qr = _extract_qr_string(js)
            if qr:
                _save_qr_html(qr, f"connect/{method}")

            if resp.ok:
                return
        except Exception as e:
            print(f"[EVOLUTION] connect tentativa={i} erro={e}")


def _normalize_exchange_type(name: str) -> ExchangeType:
    m = {
        "direct": ExchangeType.DIRECT,
        "topic": ExchangeType.TOPIC,
        "fanout": ExchangeType.FANOUT,
        "headers": ExchangeType.HEADERS,
    }
    return m.get(str(name or "topic").lower(), ExchangeType.TOPIC)


async def _process_body(source: str, body: dict[str, Any], routing_key: str = "", raw_size: int = 0) -> None:
    event_name = str(body.get("event") or body.get("eventName") or routing_key or "").strip()
    key = _event_key(event_name, routing_key)
    instance = _instance_from_event(body)
    data = body.get("data")

    COUNTERS["raw_all"] += 1
    _append_jsonl(
        RAW_ALL_JSONL,
        {
            "source": source,
            "routing_key": routing_key,
            "received_at": _now_iso(),
            "raw_size": raw_size,
            "body": body,
        },
    )

    is_current = instance == INSTANCE_NAME
    if not is_current:
        return

    COUNTERS["raw_current"] += 1
    _append_jsonl(
        RAW_CURRENT_JSONL,
        {
            "source": source,
            "routing_key": routing_key,
            "received_at": _now_iso(),
            "raw_size": raw_size,
            "body": body,
        },
    )
    _append_text(
        RAW_CURRENT_TXT,
        "\n" + "-" * 80 + "\n"
        f"source={source}\n"
        f"routing_key={routing_key}\n"
        f"event={event_name}\n"
        f"event_key={key}\n"
        f"instance={instance}\n"
        f"data_len={_data_len(data)}\n"
        f"raw_size={raw_size}\n"
        f"body_keys={list(body.keys())}\n",
    )

    print(
        f"[RAW][CURRENT] #{COUNTERS['raw_current']} "
        f"source={source} routing_key={routing_key or '-'} "
        f"event={event_name} event_key={key} instance={instance} "
        f"data_len={_data_len(data)} raw_size={raw_size}"
    )

    qr = _extract_qr_string(data)
    if key == "QRCODE_UPDATED" and qr:
        _save_qr_html(qr, f"{source}:{event_name}")

    _parse_current_event(source, event_name, instance, data)


async def rabbit_task(stop_event: asyncio.Event) -> None:
    if not RABBITMQ_URI:
        print("[RABBIT] RABBITMQ_URI/RABBITMQ_URL/AMQP_URL não encontrado no .env.")
        return

    print(f"[RABBIT] conectando: {_safe_url(RABBITMQ_URI)}")
    print(f"[RABBIT] exchange: {RABBIT_EXCHANGE}")
    print(f"[RABBIT] exchange_type: {RABBIT_EXCHANGE_TYPE}")
    print(f"[RABBIT] binding: {RABBIT_BINDING}")
    print(f"[RABBIT] saída: {OUTPUT_DIR}\n")

    while not stop_event.is_set():
        connection = None
        channel = None
        try:
            connection = await aio_pika.connect_robust(RABBITMQ_URI, heartbeat=30)
            channel = await connection.channel()
            await channel.set_qos(prefetch_count=50)

            exchange = await channel.declare_exchange(
                RABBIT_EXCHANGE,
                _normalize_exchange_type(RABBIT_EXCHANGE_TYPE),
                durable=True,
            )

            queue_name = f"raw.full.probe.{INSTANCE_NAME}.{int(time.time())}"
            queue = await channel.declare_queue(
                queue_name,
                durable=False,
                exclusive=True,
                auto_delete=True,
            )
            await queue.bind(exchange, routing_key=RABBIT_BINDING)

            print(f"[RABBIT] fila temporária criada: {queue_name}")
            print("[RABBIT] esperando eventos crus...\n")

            async with queue.iterator() as q:
                async for message in q:  # type: IncomingMessage
                    if stop_event.is_set():
                        break
                    async with message.process(requeue=False):
                        raw = message.body.decode("utf-8", errors="ignore")
                        if not raw.strip():
                            continue
                        try:
                            body = json.loads(raw)
                        except Exception as e:
                            print(f"[RABBIT] JSON inválido: {e}")
                            continue
                        if not isinstance(body, dict):
                            continue
                        await _process_body(
                            "rabbit",
                            body,
                            routing_key=str(message.routing_key or ""),
                            raw_size=len(raw),
                        )

        except asyncio.CancelledError:
            break
        except Exception as e:
            print(f"[RABBIT] erro geral: {e}")
            if not stop_event.is_set():
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


async def websocket_task(stop_event: asyncio.Event) -> None:
    if socketio is None:
        print("[WS] python-socketio não instalado. Pulando WS. Se quiser: pip install python-socketio aiohttp")
        return
    if not EVOLUTION_URL:
        return

    sio = socketio.AsyncClient(
        logger=False,
        engineio_logger=False,
        reconnection=True,
        reconnection_attempts=0,
        reconnection_delay=2,
    )

    @sio.event
    async def connect():
        print("[WS] conectado na Evolution")

    @sio.event
    async def disconnect():
        print("[WS] desconectado da Evolution")

    @sio.on("*")
    async def catch_all(event: str, data: Any = None):
        try:
            if not isinstance(data, dict):
                return

            instance = _instance_from_event(data)
            if instance != INSTANCE_NAME:
                return

            event_name = str(data.get("event") or event or "").strip()
            key = _event_key(event_name)
            payload_data = data.get("data")
            COUNTERS["ws_current"] += 1

            _append_jsonl(
                RAW_WS_JSONL,
                {
                    "source": "ws",
                    "socket_event": event,
                    "received_at": _now_iso(),
                    "body": data,
                },
            )

            print(
                f"[WS][CURRENT] event={event_name} event_key={key} "
                f"inst={instance} data_len={_data_len(payload_data)}"
            )

            qr = _extract_qr_string(payload_data)
            if key == "QRCODE_UPDATED" and qr:
                _save_qr_html(qr, f"ws:{event_name}")

            _parse_current_event("ws", event_name, instance, payload_data)
        except Exception as e:
            print(f"[WS] erro processando evento {event}: {e}")

    try:
        print("[WS] conectando na Evolution global...")
        await sio.connect(
            EVOLUTION_URL,
            headers={"apikey": EVOLUTION_APIKEY} if EVOLUTION_APIKEY else None,
            transports=["websocket"],
            wait_timeout=20,
        )

        while not stop_event.is_set():
            await asyncio.sleep(1)

    except asyncio.CancelledError:
        pass
    except Exception as e:
        print(f"[WS] erro conexão: {e}")
    finally:
        try:
            if sio.connected:
                await sio.disconnect()
        except Exception:
            pass


async def setup_evolution_after_consumers_ready() -> None:
    await asyncio.sleep(1.2)
    await asyncio.to_thread(_create_instance)
    await asyncio.sleep(0.5)
    await asyncio.to_thread(_configure_rabbit)
    await asyncio.sleep(0.5)
    await asyncio.to_thread(_configure_websocket)
    await asyncio.sleep(0.5)
    await asyncio.to_thread(_connect_instance)

    print("\n[OK] Setup feito.")
    print("[AÇÃO] Leia o QR que abriu no navegador e deixe este terminal aberto.")
    print(f"[QR] {QR_HTML_FILE}")
    print("\n[AGUARDANDO] messages.set / contacts.set / chats.set...\n")


async def main() -> None:
    print("\n" + "=" * 60)
    print(" EVOLUTION ISOLATED FULL PROBE")
    print("=" * 60)
    print(f"Instância: {INSTANCE_NAME}")
    print(f"Pasta: {OUTPUT_DIR}")
    print("")
    print("Esse teste NÃO usa o ZapsChat.")
    print("Esse teste NÃO chama setPresence.")
    print("Esse teste NÃO filtra 24h/7d.")
    print("Esse teste salva tudo que a Evolution mandar para essa instância.")
    print("")
    print("O QR vai abrir automaticamente no navegador quando for gerado.")
    print("")
    print("Arquivos principais:")
    print("- messages_all.txt")
    print("- messages_all.jsonl")
    print("- contacts_all.txt")
    print("- contacts_all.jsonl")
    print("- chats_all.txt")
    print("- chats_all.jsonl")
    print("- raw_events_current_instance.jsonl")
    print("- raw_events_all_instances.jsonl")
    print(f"- qr_{INSTANCE_NAME}.html")
    print("")
    print("CTRL+C para parar.")
    print("=" * 60 + "\n")

    if not EVOLUTION_URL:
        print("ERRO: EVOLUTION_URL não encontrado. Confira seu .env.")
        return
    if not EVOLUTION_APIKEY:
        print("ERRO: EVOLUTION_APIKEY/EVOLUTION_KEY não encontrado. Confira seu .env.")
        return
    if not RABBITMQ_URI:
        print("ERRO: RABBITMQ_URI/RABBITMQ_URL/AMQP_URL não encontrado. Confira seu .env.")
        return

    stop_event = asyncio.Event()
    tasks = [
        asyncio.create_task(rabbit_task(stop_event)),
        asyncio.create_task(websocket_task(stop_event)),
        asyncio.create_task(setup_evolution_after_consumers_ready()),
    ]

    try:
        while True:
            await asyncio.sleep(1)
    except KeyboardInterrupt:
        print("\nEncerrando...")
    finally:
        stop_event.set()
        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        _write_summary()
        print("\nEncerrado.")
        print(f"Pasta: {OUTPUT_DIR}")
        print(f"Mensagens: {MESSAGES_TXT}")
        print(f"Contatos: {CONTACTS_TXT}")
        print(f"Conversas: {CHATS_TXT}")


if __name__ == "__main__":
    if sys.platform.startswith("win"):
        try:
            asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())  # type: ignore[attr-defined]
        except Exception:
            pass

    asyncio.run(main())