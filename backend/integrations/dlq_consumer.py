"""
DLQ Consumer
- Consome a DLQ final (zapchats.backend.dlq por padrão)
- Loga/contabiliza motivos (x-death), opcionalmente envia para webhook
- ACK após processar (evita redelivery infinito da DLQ)

ENV importantes:
  RABBITMQ_URI=amqp://user:pass@host:5672/vhost
  RABBITMQ_EXCHANGE_NAME=evolution_exchange
  RABBITMQ_DLQ_NAME=zapchats.backend.dlq
  DLQ_PREFETCH=16
  DLQ_WEBHOOK_URL= (opcional; POST JSON por mensagem)
  DLQ_WEBHOOK_BEARER= (opcional; Authorization: Bearer <token>)
"""

import os
import json
import asyncio
import urllib.parse
import datetime as dt
from typing import Any, Dict, Optional

import aio_pika

try:
    import aiohttp  # opcional, só se webhook for usado
except Exception:
    aiohttp = None

def _env(name: str, default: str = "") -> str:
    return os.getenv(name, default)

def _uri() -> str:
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

def _now_iso() -> str:
    return dt.datetime.utcnow().replace(tzinfo=dt.timezone.utc).isoformat()

def parse_xdeath(headers: Dict[str, Any]) -> Dict[str, Any]:
    xdeath = headers.get("x-death") if headers else None
    out = {
        "total": 0,
        "reasons": {},
        "last_queue": None,
        "last_reason": None,
    }
    if isinstance(xdeath, list):
        for d in xdeath:
            if not isinstance(d, dict):
                continue
            cnt = int(d.get("count", 1))
            rsn = str(d.get("reason", "unknown"))
            out["total"] += cnt
            out["reasons"][rsn] = out["reasons"].get(rsn, 0) + cnt
            out["last_queue"] = d.get("queue", out["last_queue"])
            out["last_reason"] = rsn
    return out

async def forward_webhook(session, url: str, payload: Dict[str, Any]) -> None:
    if not url or session is None:
        return
    headers = {
        "Content-Type": "application/json; charset=utf-8"
    }
    bearer = _env("DLQ_WEBHOOK_BEARER", "")
    if bearer:
        headers["Authorization"] = f"Bearer {bearer}"
    try:
        async with session.post(url, headers=headers, data=json.dumps(payload), timeout=20) as resp:
            await resp.text()  # consome body p/ liberar conn
    except Exception as e:
        print("[DLQ] webhook falhou:", e)

async def main() -> None:
    uri = _uri()
    ex_name = _env("RABBITMQ_EXCHANGE_NAME", "evolution_exchange")
    dlq_name = _env("RABBITMQ_DLQ_NAME", "zapchats.backend.dlq")
    prefetch = int(_env("DLQ_PREFETCH", "16") or "16")
    heartbeat = int(_env("RABBITMQ_HEARTBEAT", "15") or "15")
    webhook = _env("DLQ_WEBHOOK_URL", "")

    print(f"[DLQ] Conectando {uri} | DLQ={dlq_name}")

    conn = await aio_pika.connect_robust(uri, heartbeat=heartbeat)
    ch = await conn.channel()
    await ch.set_qos(prefetch_count=prefetch)

    # garante que a exchange DLX exista; a DLQ normalmente já existe por policy
    dlx_ex = await ch.declare_exchange(f"{ex_name}.dlx", aio_pika.ExchangeType.TOPIC, durable=True)
    try:
        dlq = await ch.declare_queue(dlq_name, passive=True)
    except Exception:
        # cria se não existe (quorum se disponível)
        try:
            dlq = await ch.declare_queue(dlq_name, durable=True, arguments={"x-queue-type": "quorum"})
        except Exception:
            dlq = await ch.declare_queue(dlq_name, durable=True)
        # garante bind "final"
        try:
            await dlq.bind(dlx_ex, routing_key="final")
        except Exception:
            pass

    session = aiohttp.ClientSession() if (webhook and aiohttp is not None) else None

    async def on_msg(m: aio_pika.abc.AbstractIncomingMessage):
        async with m.process(requeue=False):
            headers = m.headers or {}
            xd = parse_xdeath(headers)
            body = (m.body or b"").decode("utf-8", "ignore")
            js: Optional[Dict[str, Any]] = None
            try:
                js = json.loads(body)
            except Exception:
                pass

            info = {
                "ts": _now_iso(),
                "routing_key": m.routing_key,
                "exchange": f"{ex_name}.dlx",
                "dlq": dlq_name,
                "x_death": xd,
                "headers": headers,
                "body_raw": None if js is not None else body,
                "body_json": js,
            }

            print("[DLQ][MSG]", json.dumps({
                "ts": info["ts"],
                "rk": info["routing_key"],
                "retries": xd["total"],
                "reason": xd["last_reason"],
            }, ensure_ascii=False))

            # envia pro webhook (se configurado)
            await forward_webhook(session, webhook, info)

            # ACK automático pelo context manager .process(requeue=False)

    await dlq.consume(on_msg, no_ack=False)
    print("[DLQ] Consumindo… (Ctrl+C para sair)")
    try:
        while True:
            await asyncio.sleep(3600)
    except (KeyboardInterrupt, asyncio.CancelledError):
        pass
    finally:
        if session:
            try:
                await session.close()
            except Exception:
                pass
        try:
            await ch.close()
        except Exception:
            pass
        try:
            await conn.close()
        except Exception:
            pass

if __name__ == "__main__":
    asyncio.run(main())
