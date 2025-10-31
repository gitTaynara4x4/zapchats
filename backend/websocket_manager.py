# backend/websocket_manager.py
from __future__ import annotations

import os
import asyncio
import json
import logging
import uuid
import hashlib
from urllib.parse import urlparse
from collections import defaultdict
from typing import Dict, Mapping, List, Iterable, Any, Optional

from fastapi import APIRouter, WebSocket, WebSocketDisconnect, Query

log = logging.getLogger("ws")

# ========================= Config (env + defaults) =========================
def _get_float(env: str, default: float) -> float:
    try:
        v = float(os.getenv(env, "").strip() or default)
        return float(v)
    except Exception:
        return default

SEND_TIMEOUT = _get_float("WS_SEND_TIMEOUT", 2.5)            # segundos
KEEPALIVE_SEC = _get_float("WS_KEEPALIVE_SEC", 25)           # segundos
SNAPSHOT_MAX_BYTES = int(float(os.getenv("WS_SNAPSHOT_MAX_BYTES", "1048576")))  # 1MB

def _json_default(o: Any) -> str:
    try:
        import datetime as _dt  # type: ignore
        if isinstance(o, (_dt.datetime, _dt.date, _dt.time)):  # type: ignore[attr-defined]
            return o.isoformat()  # type: ignore[no-any-return]
    except Exception:
        pass
    try:
        import uuid as _uuid  # type: ignore
        if isinstance(o, _uuid.UUID):
            return str(o)
    except Exception:
        pass
    return str(o)

def _now_ms() -> int:
    try:
        import time
        return int(time.time() * 1000)
    except Exception:
        return 0

def _inject_server_ts(data: Any) -> Any:
    """Adiciona serverTimestamp (ms) ao payload se for dict; não muta o original."""
    if isinstance(data, dict):
        if "serverTimestamp" not in data:
            # shallow copy
            d = dict(data)
            d["serverTimestamp"] = _now_ms()
            return d
        return data
    # para listas/strings/binary não mexemos (frontend já trata)
    return data

def _stable_auto_cid(ws: WebSocket, topic: str) -> str:
    """
    Gera um cid determinístico p/ clientes que não enviam cid:
    usa topic + ip + user-agent (capado) + path do referer.
    """
    try:
        ua = (ws.headers.get("user-agent") or "")[:160]
        ref = (ws.headers.get("referer") or "")
        try:
            ref_path = urlparse(ref).path or ""
        except Exception:
            ref_path = ""
        ip = (getattr(ws.client, "host", "") or "")[:64]
        raw = f"{topic}|{ip}|{ua}|{ref_path}"
        h = hashlib.sha1(raw.encode("utf-8", "ignore")).hexdigest()[:20]
        return f"auto-{h}"
    except Exception:
        # fallback totalmente aleatório (último caso)
        return f"anon-{uuid.uuid4().hex}"

# ========================= Manager =========================
class WebSocketManager:
    """
    Gerencia conexões por grupo (ex.: 'emp:3', 'inst:4xtec-9237').
    - Dedup por CID
    - Snapshot por grupo (replayed no handshake)
    - Envio com timeout e limpeza de conexões mortas
    """

    def __init__(self) -> None:
        self.grupos: Dict[str, Dict[str, WebSocket]] = defaultdict(dict)
        self._snapshots: Dict[str, Any] = {}
        self._lock = asyncio.Lock()

    @property
    def active_connections(self) -> Mapping[str, Dict[str, WebSocket]]:
        return self.grupos

    async def connect(self, websocket: WebSocket, grupo: str, cid: Optional[str] = None) -> str:
        await websocket.accept()
        cid_eff = (cid.strip() if isinstance(cid, str) and cid.strip() else None) or _stable_auto_cid(websocket, grupo)

        old: Optional[WebSocket] = None
        async with self._lock:
            bucket = self.grupos.setdefault(grupo, {})
            old = bucket.get(cid_eff)
            bucket[cid_eff] = websocket

        if old and old is not websocket:
            try:
                await old.close()
            except Exception:
                pass

        log.debug("WS connected grp=%s cid=%s live=%d", grupo, cid_eff, len(self.grupos.get(grupo, {})))

        # Reenvia snapshot do grupo (se houver)
        try:
            snap = self._snapshots.get(grupo)
            if snap is not None:
                ok = await self._send_one(websocket, _inject_server_ts(snap))
                if not ok:
                    await self.disconnect(websocket, grupo, cid=cid_eff)
                    raise WebSocketDisconnect()
        except Exception as e:
            log.debug("WS snapshot replay falhou grp=%s cid=%s: %s", grupo, cid_eff, e)

        return cid_eff

    async def disconnect(self, websocket: WebSocket, grupo: str, cid: Optional[str] = None) -> None:
        try:
            async with self._lock:
                bucket = self.grupos.get(grupo)
                if bucket:
                    key_to_drop: Optional[str] = None
                    if cid and cid in bucket and bucket.get(cid) is websocket:
                        key_to_drop = cid
                    else:
                        for k, v in list(bucket.items()):
                            if v is websocket:
                                key_to_drop = k
                                break
                    if key_to_drop is not None:
                        bucket.pop(key_to_drop, None)
                        if not bucket:
                            self.grupos.pop(grupo, None)
            try:
                await websocket.close()
            except Exception:
                pass
            log.debug("WS disconnected grp=%s cid=%s", grupo, cid or "-")
        except Exception as e:
            log.debug("WS disconnect erro grp=%s cid=%s: %s", grupo, cid or "-", e)

    def _maybe_store_snapshot(self, grupo: str, data: Any) -> None:
        try:
            s = json.dumps(data, default=_json_default)
            if len(s.encode("utf-8", "ignore")) <= SNAPSHOT_MAX_BYTES:
                self._snapshots[grupo] = data
            else:
                log.debug("WS snapshot ignorado (payload > %dB) grp=%s", SNAPSHOT_MAX_BYTES, grupo)
        except Exception:
            log.debug("WS snapshot ignorado (não serializável) grp=%s", grupo)

    async def _send_one(self, ws: WebSocket, data: Any) -> bool:
        try:
            payload = _inject_server_ts(data)
            try:
                await asyncio.wait_for(ws.send_json(payload), timeout=SEND_TIMEOUT)
                return True
            except (TypeError, ValueError):
                await asyncio.wait_for(ws.send_text(json.dumps(payload, default=_json_default)), timeout=SEND_TIMEOUT)
                return True
        except asyncio.CancelledError:
            try:
                await ws.close()
            except Exception:
                pass
            return False
        except Exception:
            try:
                await ws.close()
            except Exception:
                pass
            return False

    async def send_message(self, grupo: str, data: Any, *, cache_snapshot: bool = True) -> None:
        # snapshot (se solicitado) antes do envio
        if cache_snapshot:
            self._maybe_store_snapshot(grupo, data)

        async with self._lock:
            bucket = dict(self.grupos.get(grupo, {}))

        if not bucket:
            log.debug("WS sem assinantes para grp=%s (payload guardado=%s)", grupo, "sim" if cache_snapshot else "não")
            return

        tasks = {cid: asyncio.create_task(self._send_one(ws, data)) for cid, ws in bucket.items()}
        results = await asyncio.gather(*tasks.values(), return_exceptions=True)

        dead: List[str] = []
        for (cid, _t), ok in zip(tasks.items(), results):
            if ok is not True:
                dead.append(cid)

        if dead:
            async with self._lock:
                live = self.grupos.get(grupo)
                if live:
                    for cid in dead:
                        live.pop(cid, None)
                    if not live:
                        self.grupos.pop(grupo, None)

    async def send_message_many(self, grupos: Iterable[str], data: Any, *, cache_snapshot: bool = True) -> None:
        await asyncio.gather(*(self.send_message(g, data, cache_snapshot=cache_snapshot) for g in grupos))

    async def broadcast_all(self, data: Any, *, cache_snapshot: bool = False) -> None:
        async with self._lock:
            grupos = list(self.grupos.keys())
        await asyncio.gather(*(self.send_message(g, data, cache_snapshot=cache_snapshot) for g in grupos))

    async def broadcast(self, grupo: str, data: Any, *, cache_snapshot: bool = True) -> None:
        await self.send_message(grupo, data, cache_snapshot=cache_snapshot)

    def list_groups(self) -> List[str]:
        return list(self.grupos.keys())

    def count(self, grupo: str) -> int:
        return len(self.grupos.get(grupo, {}))


# ========================= FastAPI Router =========================
conexoes_ativas = WebSocketManager()
router = APIRouter()

@router.websocket("/ws/{topic:path}")
async def ws_topic(
    ws: WebSocket,
    topic: str,
    cid: Optional[str] = Query(None, description="UUID/cookie do cliente p/ deduplicar"),
    want_qr: bool = Query(False, description="Se True, disparamos force_qr no handshake"),
):
    """
    Endpoint WS genérico.
    Tópicos previstos:
      - emp:{empresa_id}
      - inst:{instance_key ou instancia_id}

    Query:
      - cid     : identificador estável por aba/cliente (evita conexões duplicadas)
      - want_qr : apenas para inst:, força emissão de QR no handshake quando True
    """
    # Conecta (dedupe por cid; se não vier, geramos determinístico)
    cid_eff = await conexoes_ativas.connect(ws, topic, cid=cid)

    # Só força QR quando o cliente pedir explicitamente
    if topic.startswith("inst:") and want_qr:
        inst_id = topic.split("inst:", 1)[1]
        if inst_id:
            try:
                from backend.integrations.evo_handlers import force_qr_for_instance  # lazy import
                asyncio.create_task(force_qr_for_instance(inst_id))
            except Exception as e:
                log.debug("WS inst:%s force_qr_for_instance skip: %s", inst_id, e)

    # Keepalive (ping) — o cliente responde com 'pong'
    stop_keepalive = asyncio.Event()

    async def _keepalive():
        try:
            while not stop_keepalive.is_set():
                await asyncio.wait_for(stop_keepalive.wait(), timeout=KEEPALIVE_SEC)
                if stop_keepalive.is_set():
                    break
                try:
                    await ws.send_text("ping")
                except Exception:
                    break
        except asyncio.CancelledError:
            pass
        except Exception as e:
            log.debug("WS keepalive erro topic=%s cid=%s: %s", topic, cid_eff, e)

    ka_task = asyncio.create_task(_keepalive())

    try:
        while True:
            try:
                msg = await ws.receive()
            except WebSocketDisconnect:
                break
            except asyncio.CancelledError:
                break
            except Exception as e:
                log.debug("WS receive erro topic=%s cid=%s: %s", topic, cid_eff, e)
                break

            # Tipos que o Starlette/FastAPI podem entregar:
            # {'type': 'websocket.receive', 'text': '...'} | {'type': 'websocket.disconnect', ...}
            if isinstance(msg, dict) and msg.get("type") == "websocket.disconnect":
                break

            txt = msg.get("text") if isinstance(msg, dict) else None
            if isinstance(txt, str) and txt.strip().lower() == "ping":
                try:
                    await ws.send_text("pong")
                except Exception:
                    break
            # (Se quiser, trate aqui mensagens do cliente -> servidor)
    except Exception as e:
        log.warning("WS error topic=%s cid=%s: %s", topic, cid_eff, e)
    finally:
        try:
            stop_keepalive.set()
            try:
                ka_task.cancel()
            except Exception:
                pass
            await conexoes_ativas.disconnect(ws, topic, cid=cid_eff)
        except Exception:
            pass
