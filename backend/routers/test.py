# -*- coding: utf-8 -*-
"""
One-shot: corrige a topologia da fila de retry/DLQ para evitar
'precondition_failed: inequivalent arg x-queue-type' no RabbitMQ.

- Garante exchanges: evolution_exchange (topic, durable) e evolution_exchange.dlx
- Recria zapchats.backend.retry como quorum + TTL + DLX de volta pro main exchange
- Garante zapchats.backend.dlq (quorum) + binding na DLX (routing_key='final')
- Mostra resumo ao final.

Requer: pip install requests
"""

import os, sys, json, time, urllib.parse
import requests
import urllib3
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

# --------- CONFIG (ajuste se precisar ou use variáveis de ambiente) ---------
API_BASE   = os.getenv("RABBIT_HTTP_API", "https://zapchats-rabbitmq.9ywrah.easypanel.host/api")
USER       = os.getenv("RABBIT_USER", "zap")
PASS       = os.getenv("RABBIT_PASS", "rabbitdazapchat")
VERIFY_SSL = False  # seu endpoint foi acessado com -k (self-signed)
VHOST      = os.getenv("RABBIT_VHOST", "/")

EXCHANGE_MAIN = os.getenv("RABBIT_EXCHANGE", "evolution_exchange")
EXCHANGE_DLX  = f"{EXCHANGE_MAIN}.dlx"

QUEUE_RETRY = os.getenv("RABBIT_RETRY_QUEUE", "zapchats.backend.retry")
QUEUE_DLQ   = os.getenv("RABBIT_DLQ_NAME",   "zapchats.backend.dlq")

RETRY_TTL_MS = int(os.getenv("RABBIT_RETRY_TTL_MS", "5000"))  # 5s
RETRY_KEY    = os.getenv("RABBIT_RETRY_ROUTING", "retry.5s")
BACK_KEY     = os.getenv("RABBIT_RETRY_BACK_ROUTING", "events")  # volta pro main exchange

WANT_QUORUM  = True  # queremos 'quorum' nas filas auxiliares

# ---------------------------------------------------------------------------

def _vh():
    return urllib.parse.quote(VHOST, safe='')

def _u(path):
    if not path.startswith("/"):
        path = "/" + path
    return API_BASE.rstrip("/") + path

def _req(method, path, json_body=None, ok=(200,201,204)):
    r = requests.request(
        method=method.upper(),
        url=_u(path),
        auth=(USER, PASS),
        json=json_body,
        timeout=20,
        verify=VERIFY_SSL,
    )
    if r.status_code not in ok:
        raise RuntimeError(f"{method} {path} -> {r.status_code} {r.text}")
    return r

def ping():
    r = _req("GET", "/overview")
    ov = r.json()
    ver = ov.get("rabbitmq_version")
    print(f"[✓] HTTP API OK - RabbitMQ {ver}")
    return ov

def ensure_exchange(name, typ="topic", durable=True, auto_delete=False, internal=False, args=None):
    body = {
        "type": typ,
        "durable": bool(durable),
        "auto_delete": bool(auto_delete),
        "internal": bool(internal),
        "arguments": args or {}
    }
    _req("PUT", f"/exchanges/{_vh()}/{urllib.parse.quote(name, safe='')}", json_body=body)
    print(f"[+] exchange garantida: {name}")

def get_queue(name):
    r = requests.get(_u(f"/queues/{_vh()}/{urllib.parse.quote(name, safe='')}"),
                     auth=(USER, PASS), timeout=15, verify=VERIFY_SSL)
    if r.status_code == 200:
        return r.json()
    if r.status_code == 404:
        return None
    raise RuntimeError(f"GET queue {name} -> {r.status_code} {r.text}")

def delete_queue(name):
    _req("DELETE", f"/queues/{_vh()}/{urllib.parse.quote(name, safe='')}", ok=(204, 404))
    print(f"[-] queue deletada (se existia): {name}")

def declare_queue(name, arguments=None, durable=True, auto_delete=False):
    body = {
        "durable": bool(durable),
        "auto_delete": bool(auto_delete),
        "arguments": arguments or {}
    }
    _req("PUT", f"/queues/{_vh()}/{urllib.parse.quote(name, safe='')}", json_body=body)
    print(f"[+] queue garantida: {name} args={arguments or {}}")

def bind_queue(exchange, queue, routing_key, arguments=None):
    body = {"routing_key": routing_key, "arguments": arguments or {}}
    _req("POST", f"/bindings/{_vh()}/e/{urllib.parse.quote(exchange, safe='')}/q/{urllib.parse.quote(queue, safe='')}", json_body=body)
    print(f"[+] bind {exchange} -> {queue} (rk='{routing_key}')")

def ensure_retry_quorum():
    q = get_queue(QUEUE_RETRY)
    must_recreate = True
    if q:
        # Checa tipo e TTL/DLX; se não bater, recria
        cur_type = (q.get("arguments") or {}).get("x-queue-type") or q.get("type")
        cur_ttl  = (q.get("arguments") or {}).get("x-message-ttl")
        cur_dlxe = (q.get("arguments") or {}).get("x-dead-letter-exchange")
        cur_dlkr = (q.get("arguments") or {}).get("x-dead-letter-routing-key")
        want_type = "quorum" if WANT_QUORUM else None
        if (cur_type == want_type) and (cur_ttl == RETRY_TTL_MS) and (cur_dlxe == EXCHANGE_MAIN) and (cur_dlkr == BACK_KEY):
            print("[i] retry já ok, não vou recriar.")
            must_recreate = False
        else:
            print(f"[i] retry existe com args diferentes (type={cur_type}, ttl={cur_ttl}, dlx={cur_dlxe}, rk={cur_dlkr}) -> vou recriar.")
    if must_recreate:
        delete_queue(QUEUE_RETRY)
        args = {
            "x-message-ttl": RETRY_TTL_MS,
            "x-dead-letter-exchange": EXCHANGE_MAIN,
            "x-dead-letter-routing-key": BACK_KEY,
        }
        if WANT_QUORUM:
            args["x-queue-type"] = "quorum"
        declare_queue(QUEUE_RETRY, arguments=args)
    # bind DLX -> retry (retry.<ttl>)
    bind_queue(EXCHANGE_DLX, QUEUE_RETRY, RETRY_KEY)

def ensure_dlq_quorum():
    q = get_queue(QUEUE_DLQ)
    must_recreate = False
    if q:
        cur_type = (q.get("arguments") or {}).get("x-queue-type") or q.get("type")
        if WANT_QUORUM and cur_type != "quorum":
            print(f"[i] dlq existe como '{cur_type}', vou recriar como 'quorum'.")
            must_recreate = True
    else:
        must_recreate = True

    if must_recreate:
        delete_queue(QUEUE_DLQ)
        args = {}
        if WANT_QUORUM:
            args["x-queue-type"] = "quorum"
        declare_queue(QUEUE_DLQ, arguments=args)
    # bind DLX -> DLQ (final)
    bind_queue(EXCHANGE_DLX, QUEUE_DLQ, "final")

def main():
    print(f"[i] API: {API_BASE}  vhost: {VHOST!r}")
    ping()
    # Exchanges
    ensure_exchange(EXCHANGE_MAIN, typ="topic", durable=True)
    ensure_exchange(EXCHANGE_DLX,  typ="topic", durable=True)
    # Retry + DLQ
    ensure_retry_quorum()
    ensure_dlq_quorum()

    # Resumo
    rq = get_queue(QUEUE_RETRY) or {}
    dq = get_queue(QUEUE_DLQ) or {}
    print("\n[RESUMO]")
    print("- Retry:", QUEUE_RETRY, "type=", (rq.get("arguments") or {}).get("x-queue-type") or rq.get("type"),
          "args=", rq.get("arguments"))
    print("- DLQ  :", QUEUE_DLQ, "type=", (dq.get("arguments") or {}).get("x-queue-type") or dq.get("type"),
          "args=", dq.get("arguments"))
    print(f"- Bindings: {EXCHANGE_DLX} -> {QUEUE_RETRY} (rk='{RETRY_KEY}'), {EXCHANGE_DLX} -> {QUEUE_DLQ} (rk='final')")
    print("\n[OK] Topologia de retry/DLQ alinhada. Se algum cliente ainda tentar redeclarar com args diferentes, o broker fechará com PRECONDITION_FAILED.\n")

if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print("[ERRO]", e)
        sys.exit(1)
