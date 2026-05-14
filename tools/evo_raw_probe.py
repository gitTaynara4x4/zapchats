# tools/evo_raw_probe.py
from __future__ import annotations

import asyncio
import json
import os
import re
import sys
import time
import webbrowser
from datetime import datetime
from pathlib import Path
from typing import Any

import aio_pika
import requests
from aio_pika import ExchangeType


# ============================================================
# ENV simples
# ============================================================

def load_dotenv_simple(path: str = ".env") -> None:
    env_path = Path(path)

    if not env_path.exists():
        return

    for line in env_path.read_text(encoding="utf-8", errors="ignore").splitlines():
        line = line.strip()

        if not line or line.startswith("#") or "=" not in line:
            continue

        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")

        if key and key not in os.environ:
            os.environ[key] = value


load_dotenv_simple(".env")


def env(name: str, default: str = "") -> str:
    return os.getenv(name, default)


def bool_env(name: str, default: bool = False) -> bool:
    raw = os.getenv(name)

    if raw is None:
        return default

    value = str(raw).strip().lower()

    if value in {"1", "true", "yes", "sim", "on"}:
        return True

    if value in {"0", "false", "no", "nao", "não", "off"}:
        return False

    return default


def only_digits(value: Any) -> str:
    return re.sub(r"\D", "", str(value or ""))


# ============================================================
# Config
# ============================================================

EVOLUTION_URL = env("EVOLUTION_URL", "").rstrip("/")
EVOLUTION_KEY = env("EVOLUTION_APIKEY") or env("EVOLUTION_KEY") or env("AUTHENTICATION_API_KEY")

RABBIT_URL = (
    env("RABBITMQ_URI")
    or env("RABBITMQ_URL")
    or env("AMQP_URL")
    or ""
)

RABBIT_EXCHANGE = env("RABBITMQ_EXCHANGE_NAME", "evolution_exchange")
RABBIT_EXCHANGE_TYPE = env("RABBITMQ_EXCHANGE_TYPE", "topic").lower().strip()
RABBIT_BINDING = env("RAW_RABBIT_BINDING", "#")

RAW_INSTANCE = env(
    "RAW_INSTANCE",
    f"raw-zapschat-{int(time.time())}",
).strip()

RAW_SAVE_DIR = Path(env("RAW_SAVE_DIR", "logs/raw_evolution"))
RAW_CREATE_INSTANCE = bool_env("RAW_CREATE_INSTANCE", True)
RAW_PRINT_BODY = bool_env("RAW_PRINT_BODY", False)
RAW_OPEN_QR = bool_env("RAW_OPEN_QR", True)

# Como você já teve erro de certificado self-signed em chamadas Python,
# deixei false por padrão para diagnóstico.
EVOLUTION_VERIFY_SSL = bool_env("EVOLUTION_VERIFY_SSL", False)

HEADERS = {
    "apikey": EVOLUTION_KEY or "",
    "Content-Type": "application/json",
}


EVENTS_ALL = [
    "APPLICATION_STARTUP",
    "QRCODE_UPDATED",
    "CONNECTION_UPDATE",

    "MESSAGES_SET",
    "MESSAGES_UPSERT",
    "MESSAGES_UPDATE",
    "MESSAGES_DELETE",
    "SEND_MESSAGE",

    "CONTACTS_SET",
    "CONTACTS_UPSERT",
    "CONTACTS_UPDATE",

    "CHATS_SET",
    "CHATS_UPSERT",
    "CHATS_UPDATE",
    "CHATS_DELETE",

    "PRESENCE_UPDATE",

    "GROUPS_UPSERT",
    "GROUP_UPDATE",
    "GROUP_PARTICIPANTS_UPDATE",
]


# ============================================================
# Utils
# ============================================================

def mask_url(url: str) -> str:
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


def now_iso() -> str:
    return datetime.now().isoformat(timespec="seconds")


def safe_filename(value: str) -> str:
    value = str(value or "").strip().lower()
    value = re.sub(r"[^a-z0-9._-]+", "-", value)
    value = re.sub(r"-{2,}", "-", value).strip("-")
    return value or "raw-instance"


def exchange_type(value: str) -> ExchangeType:
    value = (value or "topic").lower().strip()

    if value == "direct":
        return ExchangeType.DIRECT

    if value == "fanout":
        return ExchangeType.FANOUT

    if value == "headers":
        return ExchangeType.HEADERS

    return ExchangeType.TOPIC


def extract_event(body: Any, routing_key: str | None = None) -> str:
    if isinstance(body, dict):
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

    return str(routing_key or "").strip()


def extract_instance(body: Any) -> str:
    if isinstance(body, dict):
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

    return ""


def get_data_len(body: Any) -> str:
    if not isinstance(body, dict):
        return "-"

    data = body.get("data")

    if isinstance(data, list):
        return str(len(data))

    if isinstance(data, dict):
        for key in ("messages", "chats", "contacts", "items", "data"):
            value = data.get(key)

            if isinstance(value, list):
                return f"{key}:{len(value)}"

        return "dict"

    return type(data).__name__


def safe_keys(obj: Any) -> list[str]:
    if not isinstance(obj, dict):
        return []

    return [str(k) for k in list(obj.keys())[:30]]


def find_qr_string(obj: Any, depth: int = 0) -> str | None:
    if depth > 8:
        return None

    if isinstance(obj, str):
        s = obj.strip()

        if s.startswith("data:image"):
            return s

        # base64 grande provável de QR
        if len(s) > 500 and re.fullmatch(r"[A-Za-z0-9+/=\s]+", s):
            return "data:image/png;base64," + s.replace("\n", "").replace("\r", "")

        return None

    if isinstance(obj, dict):
        priority_keys = [
            "base64",
            "qrcode",
            "qrCode",
            "qr",
            "code",
            "image",
        ]

        for key in priority_keys:
            if key in obj:
                found = find_qr_string(obj.get(key), depth + 1)

                if found:
                    return found

        for value in obj.values():
            found = find_qr_string(value, depth + 1)

            if found:
                return found

    if isinstance(obj, list):
        for item in obj:
            found = find_qr_string(item, depth + 1)

            if found:
                return found

    return None


def save_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(data, ensure_ascii=False, indent=2, default=str),
        encoding="utf-8",
    )


def save_qr_html(path: Path, qr_data_url: str, instance: str) -> None:
    html = f"""<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <title>QR Evolution Raw - {instance}</title>
  <style>
    body {{
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      background: #0b1115;
      color: #e9edef;
      font-family: Arial, sans-serif;
    }}
    .card {{
      background: #111b21;
      border: 1px solid rgba(255,255,255,.12);
      border-radius: 18px;
      padding: 28px;
      text-align: center;
      box-shadow: 0 20px 70px rgba(0,0,0,.35);
    }}
    img {{
      width: 310px;
      height: 310px;
      background: white;
      padding: 14px;
      border-radius: 14px;
    }}
    code {{
      display: block;
      margin-top: 16px;
      color: #25d366;
      word-break: break-all;
    }}
    p {{
      color: #9aa6ad;
      max-width: 480px;
    }}
  </style>
</head>
<body>
  <div class="card">
    <h2>Leia este QR</h2>
    <p>Instância crua de diagnóstico. Deixe o terminal aberto para capturar tudo no Rabbit.</p>
    <img src="{qr_data_url}" alt="QR Code" />
    <code>{instance}</code>
  </div>
</body>
</html>
"""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(html, encoding="utf-8")


# ============================================================
# HTTP Evolution
# ============================================================

def evo_request(method: str, path: str, body: Any = None, timeout: int = 40) -> dict[str, Any]:
    url = f"{EVOLUTION_URL}{path}"

    try:
        r = requests.request(
            method.upper(),
            url,
            headers=HEADERS,
            json=body,
            timeout=timeout,
            verify=EVOLUTION_VERIFY_SSL,
        )

        try:
            js = r.json()
        except Exception:
            js = None

        return {
            "ok": bool(r.ok),
            "status_code": r.status_code,
            "url": url,
            "method": method.upper(),
            "json": js,
            "text": r.text,
        }

    except Exception as e:
        return {
            "ok": False,
            "status_code": None,
            "url": url,
            "method": method.upper(),
            "json": None,
            "text": "",
            "error": str(e),
        }


def configure_instance_rabbit(instance: str, out_dir: Path) -> None:
    payload = {
        "rabbitmq": {
            "enabled": True,
            "exchange": RABBIT_EXCHANGE,
            "bindings": [RABBIT_BINDING],
            "events": EVENTS_ALL,
        }
    }

    resp = evo_request("POST", f"/rabbitmq/set/{instance}", payload, timeout=50)
    save_json(out_dir / "02_rabbit_set_response.json", resp)

    print(
        "[RAW][evolution] rabbitmq/set "
        f"status={resp.get('status_code')} ok={resp.get('ok')}"
    )

    if not resp.get("ok"):
        print("[RAW][evolution] rabbitmq/set erro:", str(resp.get("text") or resp.get("error") or "")[:800])


def create_instance(instance: str, out_dir: Path) -> None:
    payloads = [
        {
            "instanceName": instance,
            "qrcode": True,
            "integration": "WHATSAPP-BAILEYS",
        },
        {
            "instanceName": instance,
            "qrcode": True,
        },
    ]

    last_resp = None

    for idx, payload in enumerate(payloads, start=1):
        resp = evo_request("POST", "/instance/create", payload, timeout=50)
        save_json(out_dir / f"01_instance_create_response_{idx}.json", resp)
        last_resp = resp

        print(
            "[RAW][evolution] instance/create "
            f"tentativa={idx} status={resp.get('status_code')} ok={resp.get('ok')}"
        )

        if resp.get("ok"):
            return

    if last_resp and not last_resp.get("ok"):
        print(
            "[RAW][evolution] create não confirmou OK. "
            "Vou continuar mesmo assim, caso a instância já exista."
        )
        print(str(last_resp.get("text") or last_resp.get("error") or "")[:800])


def connect_instance(instance: str, out_dir: Path) -> None:
    responses = []

    # Normalmente é GET.
    resp_get = evo_request("GET", f"/instance/connect/{instance}", None, timeout=60)
    responses.append(resp_get)

    # Se não vier QR, tenta POST também.
    qr_get = find_qr_string(resp_get.get("json")) or find_qr_string(resp_get.get("text"))

    if not qr_get:
        resp_post = evo_request("POST", f"/instance/connect/{instance}", {}, timeout=60)
        responses.append(resp_post)

    save_json(out_dir / "03_instance_connect_response.json", responses)

    qr = None

    for resp in responses:
        qr = find_qr_string(resp.get("json")) or find_qr_string(resp.get("text"))

        if qr:
            break

    print("[RAW][evolution] connect responses:")
    for idx, resp in enumerate(responses, start=1):
        print(
            f"  tentativa={idx} method={resp.get('method')} "
            f"status={resp.get('status_code')} ok={resp.get('ok')}"
        )

    if qr:
        qr_path = out_dir / f"qr_{safe_filename(instance)}.html"
        save_qr_html(qr_path, qr, instance)

        print("")
        print(f"[RAW][QR] HTML salvo em: {qr_path.resolve()}")
        print("[RAW][QR] Leia esse QR e deixe este terminal aberto.")
        print("")

        if RAW_OPEN_QR:
            try:
                webbrowser.open(qr_path.resolve().as_uri())
            except Exception:
                pass

    else:
        print("")
        print("[RAW][QR] Não consegui extrair QR automaticamente.")
        print(f"[RAW][QR] Veja o arquivo: {(out_dir / '03_instance_connect_response.json').resolve()}")
        print("")


def run_evolution_flow(instance: str, out_dir: Path) -> None:
    if not EVOLUTION_URL or not EVOLUTION_KEY:
        raise RuntimeError("Faltou EVOLUTION_URL ou EVOLUTION_APIKEY/EVOLUTION_KEY no .env.")

    print("")
    print("[RAW][evolution] URL:", EVOLUTION_URL)
    print("[RAW][evolution] instance:", instance)
    print("[RAW][evolution] verify_ssl:", EVOLUTION_VERIFY_SSL)
    print("")

    if RAW_CREATE_INSTANCE:
        create_instance(instance, out_dir)

    configure_instance_rabbit(instance, out_dir)
    connect_instance(instance, out_dir)


# ============================================================
# Rabbit cru
# ============================================================

async def rabbit_raw_consumer(instance: str, out_dir: Path) -> None:
    if not RABBIT_URL:
        raise RuntimeError("Faltou RABBITMQ_URI/RABBITMQ_URL/AMQP_URL no .env.")

    out_dir.mkdir(parents=True, exist_ok=True)

    raw_jsonl = out_dir / "raw_rabbit_events.jsonl"
    raw_txt = out_dir / "raw_rabbit_payloads.txt"

    print("")
    print("[RAW][rabbit] conectando:", mask_url(RABBIT_URL))
    print("[RAW][rabbit] exchange:", RABBIT_EXCHANGE)
    print("[RAW][rabbit] exchange_type:", RABBIT_EXCHANGE_TYPE)
    print("[RAW][rabbit] binding:", RABBIT_BINDING)
    print("[RAW][rabbit] jsonl:", raw_jsonl.resolve())
    print("[RAW][rabbit] txt:", raw_txt.resolve())
    print("")

    connection = await aio_pika.connect_robust(RABBIT_URL, heartbeat=30)
    channel = await connection.channel()
    await channel.set_qos(prefetch_count=50)

    exchange = await channel.declare_exchange(
        RABBIT_EXCHANGE,
        exchange_type(RABBIT_EXCHANGE_TYPE),
        durable=True,
    )

    queue_name = f"raw.probe.{safe_filename(instance)}.{int(time.time())}"

    queue = await channel.declare_queue(
        queue_name,
        durable=False,
        auto_delete=True,
        exclusive=True,
    )

    await queue.bind(exchange, routing_key=RABBIT_BINDING)

    print(f"[RAW][rabbit] fila temporária criada: {queue_name}")
    print("[RAW][rabbit] esperando eventos crus...")
    print("")

    total = 0

    async with queue.iterator() as queue_iter:
        async for message in queue_iter:
            total += 1

            raw_bytes = message.body or b""
            raw_text = raw_bytes.decode("utf-8", errors="replace")

            try:
                body = json.loads(raw_text)
            except Exception:
                body = None

            if isinstance(body, dict):
                evt = extract_event(body, message.routing_key)
                inst = extract_instance(body)
                data_len = get_data_len(body)
                keys = safe_keys(body)
            else:
                evt = str(message.routing_key or "")
                inst = ""
                data_len = "-"
                keys = []

            envelope = {
                "captured_at": now_iso(),
                "total": total,
                "routing_key": message.routing_key,
                "exchange": message.exchange,
                "event": evt,
                "instance": inst,
                "data_len": data_len,
                "body_keys": keys,
                "raw_size": len(raw_bytes),
                "json": body,
                "raw_text": None if body is not None else raw_text,
            }

            with raw_jsonl.open("a", encoding="utf-8") as f:
                f.write(json.dumps(envelope, ensure_ascii=False, default=str) + "\n")

            with raw_txt.open("a", encoding="utf-8") as f:
                f.write("\n\n")
                f.write("=" * 120)
                f.write(f"\n#{total} {now_iso()} routing_key={message.routing_key} event={evt} instance={inst} data_len={data_len}\n")
                f.write("=" * 120)
                f.write("\n")
                f.write(raw_text)

            print(
                "[RAW][event] "
                f"#{total} "
                f"routing_key={message.routing_key} "
                f"event={evt or '-'} "
                f"instance={inst or '-'} "
                f"data_len={data_len} "
                f"raw_size={len(raw_bytes)} "
                f"keys={keys}"
            )

            if RAW_PRINT_BODY:
                print("[RAW][body]")
                print(raw_text)
                print("[RAW][/body]")


async def main() -> None:
    if not EVOLUTION_URL:
        print("[ERRO] Faltou EVOLUTION_URL no .env.")
        sys.exit(1)

    if not EVOLUTION_KEY:
        print("[ERRO] Faltou EVOLUTION_APIKEY ou EVOLUTION_KEY no .env.")
        sys.exit(1)

    if not RABBIT_URL:
        print("[ERRO] Faltou RABBITMQ_URI no .env.")
        sys.exit(1)

    out_dir = RAW_SAVE_DIR / safe_filename(RAW_INSTANCE)
    out_dir.mkdir(parents=True, exist_ok=True)

    print("")
    print("============================================================")
    print(" EVOLUTION RAW PROBE")
    print("============================================================")
    print("Instância:", RAW_INSTANCE)
    print("Pasta:", out_dir.resolve())
    print("Não chama setPresence.")
    print("Não usa parser do ZapsChat.")
    print("Tudo que chegar no Rabbit será salvo cru.")
    print("CTRL+C para parar.")
    print("============================================================")
    print("")

    consumer_task = asyncio.create_task(rabbit_raw_consumer(RAW_INSTANCE, out_dir))

    # Dá tempo para a fila temporária bindar antes de criar/conectar a instância.
    await asyncio.sleep(2)

    await asyncio.to_thread(run_evolution_flow, RAW_INSTANCE, out_dir)

    try:
        await consumer_task
    except asyncio.CancelledError:
        pass


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("")
        print("[RAW] encerrado pelo usuário.")