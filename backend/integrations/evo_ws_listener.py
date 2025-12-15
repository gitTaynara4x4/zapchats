# backend/integrations/evo_ws_listener.py
from __future__ import annotations

import os
import asyncio
from typing import Any, Optional, Tuple, Dict, Callable

import socketio  # python-socketio (client)


# =========================
# Helpers de ambiente
# =========================
def _env(k: str, d: str = "") -> str:
    return os.getenv(k, d)


# =========================
# Extração de nome da instância do payload
# =========================
def _extract_instance(payload, default: Optional[str] = None) -> Optional[str]:
    def _pick(d: dict | None):
        if not isinstance(d, dict):
            return None
        for k in ("instance", "instanceName", "instanceId"):
            v = d.get(k)
            if isinstance(v, str) and v.strip():
                return v.strip()
        return None

    v = _pick(payload if isinstance(payload, dict) else None)
    if v:
        return v

    if isinstance(payload, dict) and isinstance(payload.get("qrcode"), dict):
        v = _pick(payload["qrcode"])
        if v:
            return v

    data = payload.get("data") if isinstance(payload, dict) else None
    if isinstance(data, dict):
        v = _pick(data)
        if v:
            return v
        if isinstance(data.get("qrcode"), dict):
            v = _pick(data["qrcode"])
            if v:
                return v
    elif isinstance(data, list):
        for item in data:
            v = _pick(item if isinstance(item, dict) else None)
            if v:
                return v
            if isinstance(item, dict) and isinstance(item.get("qrcode"), dict):
                v = _pick(item["qrcode"])
                if v:
                    return v
    return default


# =========================
# Bootstrap do listener
# =========================
async def start(loop: asyncio.AbstractEventLoop, HANDLERS: Dict[Any, Callable], EvoEvent: Any) -> Tuple[Optional[asyncio.Task], Optional[Callable[[], asyncio.Future]]]:
    """
    Sobe o cliente Socket.IO do Evolution em background.
    Retorna (task, stop) — onde stop() encerra a task e desconecta o socket.
    Não bloqueia o loop principal.
    """
    # Flag global (pode desligar em .env sem mexer em código)
    if _env("EVOLUTION_WS_SUBSCRIBE", "false").lower() != "true":
        print("[EVO-WS] EVOLUTION_WS_SUBSCRIBE=false -> listener desabilitado.")
        return (None, None)

    evo_url = _env("EVOLUTION_URL")  # IMPORTANTE: HTTP/HTTPS (o cliente força ws)
    apikey = _env("EVOLUTION_APIKEY") or _env("EVOLUTION_KEY")
    if not evo_url or not apikey:
        print("[EVO-WS] EVOLUTION_URL/APIKEY ausentes; WS não iniciado.")
        return (None, None)

    headers = {"apikey": apikey}

    sio = socketio.AsyncClient(
        reconnection=True,
        reconnection_attempts=0,   # infinito
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
        print("[EVO-WS] Desconectado; tentando reconectar…")

    async def _dispatch(evt_name: str, data):
        """
        Converte nome do evento recebido em constante do Enum (EvoEvent),
        encontra o handler em HANDLERS e chama com payload normalizado.
        """
        key = evt_name.replace(".", "_").replace("-", "_").upper()
        evt = getattr(EvoEvent, key, None)
        if not evt:
            return
        h = HANDLERS.get(evt)
        if not h:
            return

        inst = _extract_instance(data, default=None)

        # normaliza payload p/ formato {"instance": "...", "data": ...}
        if not (isinstance(data, dict) and "data" in data):
            data = {"instance": inst or "", "data": data}

        try:
            coro = h(inst or "", data)
            if asyncio.iscoroutine(coro):
                await coro
        except Exception as e:
            print(f"[EVO-WS] Erro handler {key}: {e}")

    def _bind(event_upper: str):
        """
        Faz o bind em UPPER_CASE e em dotted.lower() para cobrir variações do servidor.
        """
        dotted = event_upper.lower().replace("_", ".")
        async def _h_upper(d): await _dispatch(event_upper, d)
        async def _h_lower(d): await _dispatch(event_upper, d)
        sio.on(event_upper)(_h_upper)
        sio.on(dotted)(_h_lower)

    # Eventos que nos interessam
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
        "LOGOUT_INSTANCE"
    ]:
        _bind(ev)

    stop_evt = asyncio.Event()

    async def _runner():
        """
        Loop de conexão com reconexão infinita.
        Usa apenas transporte websocket (sem polling), o que evita
        o erro comum 'packet queue is empty, aborting' do engineio.
        """
        while not stop_evt.is_set():
            try:
                await sio.connect(
                    evo_url.rstrip("/"),
                    headers=headers,
                    transports=["websocket"],  # força WS
                    wait=False,                # não bloquear o connect
                )
                await sio.wait()  # aguarda até desconectar
            except asyncio.CancelledError:
                try:
                    await sio.disconnect()
                except Exception:
                    pass
                break
            except Exception as e:
                # queda comum do engineio; só reconecta silenciosamente
                if "packet queue is empty" not in str(e).lower():
                    print("[EVO-WS] Falha ao conectar:", e)
                await asyncio.sleep(3)

    task = loop.create_task(_runner())

    async def _stop():
        """
        Encerra o runner e desconecta o client.
        """
        stop_evt.set()
        try:
            await sio.disconnect()
        except Exception:
            pass
        try:
            task.cancel()
        except Exception:
            pass
        # dá chance do cancelamento propagar
        try:
            await asyncio.sleep(0)
        except Exception:
            pass

    return (task, _stop)


# Wrapper assíncrono para o main.py
async def start_evo_ws_listener(loop: asyncio.AbstractEventLoop, HANDLERS: Dict[Any, Callable], EvoEvent: Any):
    """
    Use no startup do FastAPI:
        evo_ret = await start_evo_ws_listener(loop, HANDLERS, EvoEvent)
        if isinstance(evo_ret, tuple) and len(evo_ret) == 2 and evo_ret[0] is not None:
            app.state.evo_task, app.state.evo_stop = evo_ret
    """
    return await start(loop, HANDLERS, EvoEvent)
