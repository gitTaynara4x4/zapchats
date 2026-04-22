from __future__ import annotations

import asyncio
import os
from typing import Any, Awaitable, Callable, Dict, Optional, Tuple

try:
    import aiohttp  # noqa
    if not hasattr(aiohttp, "ClientWSTimeout"):
        from aiohttp.client_ws import ClientWSTimeout  # noqa
        aiohttp.ClientWSTimeout = ClientWSTimeout  # type: ignore[attr-defined]
except Exception as _e:
    print("[EVO-WS] Aviso: compat aiohttp.ClientWSTimeout falhou:", _e)

import socketio


def _env(k: str, d: str = "") -> str:
    return os.getenv(k, d)


def _extract_instance(payload: Any, default: Optional[str] = None) -> Optional[str]:
    def _pick(d: dict | None):
        if not isinstance(d, dict):
            return None
        for k in ("instance", "instanceName", "instanceId"):
            v = d.get(k)
            if isinstance(v, str) and v.strip():
                return v.strip()
        return None

    if isinstance(payload, dict):
        v = _pick(payload)
        if v:
            return v

        data = payload.get("data")
        if isinstance(data, dict):
            v = _pick(data)
            if v:
                return v

            qrcode = data.get("qrcode")
            if isinstance(qrcode, dict):
                v = _pick(qrcode)
                if v:
                    return v

        elif isinstance(data, list):
            for item in data:
                if not isinstance(item, dict):
                    continue

                v = _pick(item)
                if v:
                    return v

                qrcode = item.get("qrcode")
                if isinstance(qrcode, dict):
                    v = _pick(qrcode)
                    if v:
                        return v

        qrcode = payload.get("qrcode")
        if isinstance(qrcode, dict):
            v = _pick(qrcode)
            if v:
                return v

    return default


def _normalize_payload(inst: Optional[str], data: Any) -> dict:
    if isinstance(data, dict) and "data" in data:
        payload = dict(data)
        if not payload.get("instance") and inst:
            payload["instance"] = inst
        return payload
    return {
        "instance": inst or "",
        "data": data,
    }


async def start(
    loop: asyncio.AbstractEventLoop,
    HANDLERS: Dict[Any, Callable],
    EvoEvent: Any,
) -> Tuple[Optional[asyncio.Task], Optional[Callable[[], Awaitable[None]]]]:
    """
    Listener global do Evolution via Socket.IO.

    IMPORTANTE:
    - aqui o WS fica APENAS para eventos de QR/conexão
    - mensagens/contatos/grupos NÃO devem entrar aqui,
      para não duplicar com Rabbit/webhook
    """
    if _env("EVOLUTION_WS_SUBSCRIBE", "false").lower() != "true":
        print("[EVO-WS] EVOLUTION_WS_SUBSCRIBE=false -> listener desabilitado.")
        return (None, None)

    evo_url = (_env("EVOLUTION_URL") or "").strip().rstrip("/")
    apikey = (_env("EVOLUTION_APIKEY") or _env("EVOLUTION_KEY") or "").strip()

    if not evo_url or not apikey:
        print("[EVO-WS] EVOLUTION_URL/APIKEY ausentes; WS não iniciado.")
        return (None, None)

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
        print("[EVO-WS] Desconectado; tentando reconectar…")

    async def _dispatch(event_upper: str, data: Any):
        key = event_upper.replace(".", "_").replace("-", "_").upper()
        evt = getattr(EvoEvent, key, None)
        if not evt:
            return

        handler_fn = HANDLERS.get(evt)
        if not handler_fn:
            return

        inst = _extract_instance(data, default=None)
        payload = _normalize_payload(inst, data)

        try:
            result = handler_fn(inst or "", payload)
            if asyncio.iscoroutine(result):
                await result
        except Exception as e:
            print(f"[EVO-WS] Erro handler {key}: {e}")

    def _bind(event_upper: str):
        dotted = event_upper.lower().replace("_", ".")

        async def _on_upper(data):
            await _dispatch(event_upper, data)

        async def _on_dotted(data):
            await _dispatch(event_upper, data)

        sio.on(event_upper)(_on_upper)
        sio.on(dotted)(_on_dotted)

    for ev in (
        "QRCODE_UPDATED",
        "CONNECTION_UPDATE",
    ):
        _bind(ev)

    stop_evt = asyncio.Event()

    async def _runner():
        while not stop_evt.is_set():
            try:
                await sio.connect(
                    evo_url,
                    headers=headers,
                    transports=["websocket"],
                    wait=False,
                )
                await sio.wait()
            except asyncio.CancelledError:
                try:
                    await sio.disconnect()
                except Exception:
                    pass
                break
            except Exception as e:
                msg = str(e).lower()
                if "packet queue is empty" not in msg:
                    print("[EVO-WS] Falha ao conectar:", e)
                await asyncio.sleep(3)

    task = loop.create_task(_runner())

    async def _stop():
        stop_evt.set()

        try:
            await sio.disconnect()
        except Exception:
            pass

        try:
            task.cancel()
        except Exception:
            pass

        try:
            await asyncio.sleep(0)
        except Exception:
            pass

    return (task, _stop)


async def start_evo_ws_listener(
    loop: asyncio.AbstractEventLoop,
    HANDLERS: Dict[Any, Callable],
    EvoEvent: Any,
):
    return await start(loop, HANDLERS, EvoEvent)


__all__ = [
    "start",
    "start_evo_ws_listener",
]