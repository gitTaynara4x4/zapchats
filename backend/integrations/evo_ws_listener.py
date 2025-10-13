# backend/integrations/evo_ws_listener.py
from __future__ import annotations

import os
import asyncio
import socketio  # python-socketio (client)

def _env(k: str, d: str = "") -> str:
    return os.getenv(k, d)

def _wss_base(url: str) -> str:
    url = (url or "").strip().rstrip("/")
    if url.startswith("http://"):
        return "ws://" + url[len("http://") :]
    if url.startswith("https://"):
        return "wss://" + url[len("https://") :]
    return url

def _extract_instance(payload, default=None):
    def _pick(d: dict | None):
        if not isinstance(d, dict):
            return None
        for k in ("instance", "instanceName", "instanceId"):
            v = d.get(k)
            if isinstance(v, str) and v.strip():
                return v.strip()
        return None

    v = _pick(payload if isinstance(payload, dict) else None)
    if v: return v

    if isinstance(payload, dict) and isinstance(payload.get("qrcode"), dict):
        v = _pick(payload["qrcode"])
        if v: return v

    data = payload.get("data") if isinstance(payload, dict) else None
    if isinstance(data, dict):
        v = _pick(data)
        if v: return v
        if isinstance(data.get("qrcode"), dict):
            v = _pick(data["qrcode"])
            if v: return v
    elif isinstance(data, list):
        for item in data:
            v = _pick(item if isinstance(item, dict) else None)
            if v: return v
            if isinstance(item, dict) and isinstance(item.get("qrcode"), dict):
                v = _pick(item["qrcode"])
                if v: return v
    return default

async def start(loop, HANDLERS, EvoEvent):
    if _env("EVOLUTION_WS_SUBSCRIBE", "false").lower() != "true":
        print("[EVO-WS] EVOLUTION_WS_SUBSCRIBE=false -> listener desabilitado.")
        return

    evo_url = _env("EVOLUTION_URL")
    apikey = _env("EVOLUTION_APIKEY") or _env("EVOLUTION_KEY")
    if not evo_url or not apikey:
        print("[EVO-WS] EVOLUTION_URL/APIKEY ausentes; WS nÃ£o iniciado.")
        return

    base = _wss_base(evo_url)
    headers = {"apikey": apikey}

    sio = socketio.AsyncClient(
        reconnection=True,
        reconnection_attempts=0,
        reconnection_delay=2,
        reconnection_delay_max=10,
        logger=False,
        engineio_logger=False,
    )

    @sio.event
    async def connect():
        print("[EVO-WS] Conectado ao Evolution (global).")

    @sio.event
    async def disconnect():
        print("[EVO-WS] Desconectado; tentando reconectarâ€¦")

    async def _dispatch(evt_name: str, data):
        key = evt_name.replace(".", "_").replace("-", "_").upper()
        evt = getattr(EvoEvent, key, None)
        if not evt:
            return
        h = HANDLERS.get(evt)
        if not h:
            return
        inst = _extract_instance(data, default=None)

        # 🔧 NOVO: normaliza o payload pro formato esperado pelos handlers
        if not (isinstance(data, dict) and "data" in data):
            data = {"instance": inst or "", "data": data}

        try:
            coro = h(inst or "", data)
            if asyncio.iscoroutine(coro):
                await coro
        except Exception as e:
            print(f"[EVO-WS] Erro handler {key}: {e}")


    def _bind(event_upper: str):
        dotted = event_upper.lower().replace("_", ".")
        async def _h_upper(d): await _dispatch(event_upper, d)
        async def _h_lower(d): await _dispatch(event_upper, d)
        sio.on(event_upper)(_h_upper)
        sio.on(dotted)(_h_lower)

    for ev in [
        "QRCODE_UPDATED",
        "CONNECTION_UPDATE",
        "MESSAGES_SET",
        "MESSAGES_UPSERT",
        "MESSAGES_UPDATE",
        "CONTACTS_SET",
        "CONTACTS_UPSERT",
        "CONTACTS_UPDATE",
        "PRESENCE_UPDATE",
        "GROUPS_UPSERT",
        "GROUPS_UPDATE",
        "GROUP_UPDATE",
        "GROUP_PARTICIPANTS_UPDATE",
        "REMOVE_INSTANCE",
        "LOGOUT_INSTANCE",
        "CALL",
    ]:
        _bind(ev)

    async def _runner():
        while True:
            try:
                await sio.connect(base, headers=headers)
                await sio.wait()
            except asyncio.CancelledError:
                try:
                    await sio.disconnect()
                except Exception:
                    pass
                break
            except Exception as e:
                print("[EVO-WS] Falha ao conectar:", e)
                await asyncio.sleep(3)

    loop.create_task(_runner())

def start_evo_ws_listener(loop, HANDLERS, EvoEvent):
    loop.create_task(start(loop, HANDLERS, EvoEvent))