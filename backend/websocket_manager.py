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

import backend.routers.auth as auth_router  # 🔒 para validar token

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

# IMPORTANTE:
# Antes o manager guardava o último payload enviado ao grupo e reenviava
# automaticamente quando o navegador reconectava. Isso é perigoso para a
# tela de atendimentos: um evento antigo de mensagem era reenviado no meio
# do boot do frontend, fechava/reabria o WS e deixava a lista em loading.
# Snapshot agora fica desligado por padrão. Só ligue com WS_SNAPSHOT_ENABLED=true
# se for um canal que realmente precisa de replay.
def _env_bool(name: str, default: bool = False) -> bool:
    v = os.getenv(name)
    if v is None:
        return default
    return str(v).strip().lower() in {"1", "true", "yes", "on", "sim"}

WS_SNAPSHOT_ENABLED = _env_bool("WS_SNAPSHOT_ENABLED", False)
WS_SNAPSHOT_ALLOW_TYPES = {
    t.strip().lower()
    for t in os.getenv("WS_SNAPSHOT_ALLOW_TYPES", "qrcode,connection").split(",")
    if t.strip()
}
WS_SNAPSHOT_DENY_TYPES = {
    "message",
    "mensagem",
    "ack",
    "msg_deleted",
    "messages_delete",
    "reload_clientes",
    "reload_grupos",
    "contacts_sync_start",
    "contacts_sync_progress",
    "contacts_sync_done",
    "history_sync_start",
    "history_sync_progress",
    "history_sync_done",
}

# mesmo nome de cookie usado em main.py
ACCESS_COOKIE_NAME = os.getenv("ACCESS_COOKIE_NAME", "access_token")


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
            d = dict(data)
            d["serverTimestamp"] = _now_ms()
            return d
        return data

    return data


def _first_non_empty(*values: Any) -> Optional[str]:
    for v in values:
        if v is None:
            continue

        s = str(v).strip()

        if s:
            return s

    return None


def _stable_auto_cid(ws: WebSocket, topic: str) -> str:
    """
    Gera um cid determinístico p/ clientes que não enviam cid:
    usa topic + ip + user-agent (capado) + path do referer.
    """
    try:
        ua = (ws.headers.get("user-agent") or "")[:160]
        ref = ws.headers.get("referer") or ""

        try:
            ref_path = urlparse(ref).path or ""
        except Exception:
            ref_path = ""

        ip = (getattr(ws.client, "host", "") or "")[:64]
        raw = f"{topic}|{ip}|{ua}|{ref_path}"
        h = hashlib.sha1(raw.encode("utf-8", "ignore")).hexdigest()[:20]

        return f"auto-{h}"
    except Exception:
        return f"anon-{uuid.uuid4().hex}"


def _decode_token_safe(token: str | None) -> Optional[dict]:
    if not token:
        return None

    try:
        decoded = auth_router._decode_token(token)

        if isinstance(decoded, dict):
            return decoded

        return {}
    except Exception:
        return None


def _empresa_id_from_token(decoded: dict | None) -> Optional[int]:
    if not isinstance(decoded, dict):
        return None

    for key in (
        "empresa_id",
        "empresaId",
        "empresa",
        "eid",
    ):
        try:
            value = decoded.get(key)

            if value is None:
                continue

            return int(value)
        except Exception:
            continue

    return None


def _parse_topic_empresa(topic: str) -> Optional[int]:
    try:
        if not str(topic or "").startswith("emp:"):
            return None

        raw = str(topic).split("emp:", 1)[1].strip()

        if not raw:
            return None

        return int(raw)
    except Exception:
        return None


# ========================= Manager =========================

class WebSocketManager:
    """
    Gerencia conexões por grupo (ex.: 'emp:3', 'inst:4xtec-9237').

    - Dedup por CID.
    - Snapshot por grupo.
    - Envio com timeout.
    - Limpeza de conexões mortas.
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

        cid_eff = (
            cid.strip()
            if isinstance(cid, str) and cid.strip()
            else None
        ) or _stable_auto_cid(websocket, grupo)

        old: Optional[WebSocket] = None

        async with self._lock:
            bucket = self.grupos.setdefault(grupo, {})
            old = bucket.get(cid_eff)
            bucket[cid_eff] = websocket

        # Fecha conexão antiga com o mesmo cid.
        if old and old is not websocket:
            try:
                await old.close()
            except Exception:
                pass

        log.info(
            "WS connected grp=%s cid=%s live=%d",
            grupo,
            cid_eff,
            len(self.grupos.get(grupo, {})),
        )

        # v8: não faz replay de payload antigo no reconnect.
        # Mensagem de atendimento precisa chegar apenas em tempo real; se reconectar,
        # a tela busca o estado atual pela API.

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

            log.info("WS disconnected grp=%s cid=%s", grupo, cid or "-")
        except Exception as e:
            log.debug("WS disconnect erro grp=%s cid=%s: %s", grupo, cid or "-", e)

    def _maybe_store_snapshot(self, grupo: str, data: Any) -> None:
        # Replay/snapshot desligado por padrão. O antigo comportamento reenviava
        # a última mensagem ao reconectar e era a causa do loop/loading no atendimento.
        if not WS_SNAPSHOT_ENABLED:
            return

        try:
            typ = ""
            if isinstance(data, dict):
                typ = str(data.get("type") or data.get("event") or "").strip().lower()

            if typ and typ in WS_SNAPSHOT_DENY_TYPES:
                return

            if WS_SNAPSHOT_ALLOW_TYPES and typ and typ not in WS_SNAPSHOT_ALLOW_TYPES:
                return

            s = json.dumps(data, default=_json_default)

            if len(s.encode("utf-8", "ignore")) <= SNAPSHOT_MAX_BYTES:
                self._snapshots[grupo] = data
            else:
                log.debug("WS snapshot ignorado payload > %dB grp=%s", SNAPSHOT_MAX_BYTES, grupo)
        except Exception:
            log.debug("WS snapshot ignorado não serializável grp=%s", grupo)

    async def _send_one(self, ws: WebSocket, data: Any) -> bool:
        try:
            payload = _inject_server_ts(data)

            try:
                await asyncio.wait_for(ws.send_json(payload), timeout=SEND_TIMEOUT)
                return True
            except (TypeError, ValueError):
                await asyncio.wait_for(
                    ws.send_text(json.dumps(payload, default=_json_default)),
                    timeout=SEND_TIMEOUT,
                )
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

    async def send_message(self, grupo: str, data: Any, *, cache_snapshot: bool = False) -> None:
        if cache_snapshot:
            self._maybe_store_snapshot(grupo, data)

        async with self._lock:
            bucket = dict(self.grupos.get(grupo, {}))

        if not bucket:
            log.warning(
                "WS sem assinantes para grp=%s payload_guardado=%s",
                grupo,
                "sim" if (cache_snapshot and WS_SNAPSHOT_ENABLED) else "não",
            )
            return

        log.info("WS emit grp=%s assinantes=%d", grupo, len(bucket))

        tasks = {
            cid: asyncio.create_task(self._send_one(ws, data))
            for cid, ws in bucket.items()
        }

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

    async def send_message_many(self, grupos: Iterable[str], data: Any, *, cache_snapshot: bool = False) -> None:
        await asyncio.gather(
            *(self.send_message(g, data, cache_snapshot=cache_snapshot) for g in grupos)
        )

    async def broadcast_all(self, data: Any, *, cache_snapshot: bool = False) -> None:
        async with self._lock:
            grupos = list(self.grupos.keys())

        await asyncio.gather(
            *(self.send_message(g, data, cache_snapshot=cache_snapshot) for g in grupos)
        )

    async def broadcast(self, grupo: str, data: Any, *, cache_snapshot: bool = False) -> None:
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

    # ✅ NOVO:
    # O navegador nem sempre chega com cookies no WS.
    # Então aceitamos fallback por query também.
    token: Optional[str] = Query(None, description="JWT fallback quando cookie não vier no WebSocket"),
    access_token: Optional[str] = Query(None, description="Alias de token JWT"),
    empresa_id: Optional[str] = Query(None, description="Empresa fallback quando cookie não vier no WebSocket"),
    empresaId: Optional[str] = Query(None, description="Alias de empresa_id"),
):
    """
    Endpoint WS genérico.

    Tópicos previstos:
      - emp:{empresa_id}
      - inst:{instance_key ou instancia_id}

    Query:
      - cid
      - want_qr
      - token / access_token
      - empresa_id / empresaId

    Regra nova:
      - Para emp:{empresa_id}, aceita autenticação por cookie OU query.
      - Isso resolve o caso do front abrir /ws/emp%3A5?empresa_id=5&token=...
    """

    # =========================
    # Autenticação para canal da empresa
    # =========================
    if topic.startswith("emp:"):
        emp_from_topic = _parse_topic_empresa(topic)

        if not emp_from_topic:
            await ws.close(code=4403)
            return

        token_eff = _first_non_empty(
            ws.cookies.get(ACCESS_COOKIE_NAME),
            ws.cookies.get("access_token"),
            token,
            access_token,
        )

        empresa_eff = _first_non_empty(
            ws.cookies.get("empresa_id"),
            ws.cookies.get("EMPRESA_ID"),
            empresa_id,
            empresaId,
        )

        if not token_eff:
            log.warning("WS auth fail topic=%s motivo=sem_token", topic)
            await ws.close(code=4401)
            return

        decoded = _decode_token_safe(token_eff)

        if decoded is None:
            log.warning("WS auth fail topic=%s motivo=token_invalido", topic)
            await ws.close(code=4401)
            return

        try:
            emp_from_param = int(empresa_eff) if empresa_eff is not None else None
        except Exception:
            emp_from_param = None

        emp_from_token = _empresa_id_from_token(decoded)

        # Segurança:
        # - tópico precisa bater com query/cookie quando existir;
        # - tópico também precisa bater com empresa_id do token quando existir.
        if emp_from_param is not None and int(emp_from_param) != int(emp_from_topic):
            log.warning(
                "WS auth fail topic=%s motivo=empresa_param_diferente param=%s",
                topic,
                emp_from_param,
            )
            await ws.close(code=4403)
            return

        if emp_from_token is not None and int(emp_from_token) != int(emp_from_topic):
            log.warning(
                "WS auth fail topic=%s motivo=empresa_token_diferente token_emp=%s",
                topic,
                emp_from_token,
            )
            await ws.close(code=4403)
            return

        # Se token não tem empresa_id, exige pelo menos cookie/query.
        if emp_from_token is None and emp_from_param is None:
            log.warning("WS auth fail topic=%s motivo=sem_empresa", topic)
            await ws.close(code=4403)
            return

    # Conecta.
    cid_eff = await conexoes_ativas.connect(ws, topic, cid=cid)

    # Só força QR quando o cliente pedir explicitamente.
    if topic.startswith("inst:") and want_qr:
        inst_id = topic.split("inst:", 1)[1]

        if inst_id:
            try:
                from backend.integrations.evo_handlers import force_qr_for_instance  # lazy import
                asyncio.create_task(force_qr_for_instance(inst_id))
            except Exception as e:
                log.debug("WS inst:%s force_qr_for_instance skip: %s", inst_id, e)

    # Keepalive.
    stop_keepalive = asyncio.Event()

    async def _keepalive() -> None:
        if KEEPALIVE_SEC <= 0:
            return

        try:
            while not stop_keepalive.is_set():
                try:
                    await asyncio.wait_for(stop_keepalive.wait(), timeout=KEEPALIVE_SEC)
                    break
                except asyncio.TimeoutError:
                    try:
                        await ws.send_text("ping")
                    except Exception:
                        break
        except asyncio.CancelledError:
            pass
        except Exception as e:
            log.debug("WS keepalive erro topic=%s cid=%s: %s", topic, cid_eff, e)

    ka_task: Optional[asyncio.Task] = None

    if KEEPALIVE_SEC > 0:
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

            if isinstance(msg, dict) and msg.get("type") == "websocket.disconnect":
                break

            txt = msg.get("text") if isinstance(msg, dict) else None

            if isinstance(txt, str):
                txt_l = txt.strip().lower()

                if txt_l == "ping":
                    try:
                        await ws.send_text("pong")
                    except Exception:
                        break

                elif txt_l == "pong":
                    pass

    except Exception as e:
        log.warning("WS error topic=%s cid=%s: %s", topic, cid_eff, e)

    finally:
        try:
            stop_keepalive.set()

            if ka_task is not None:
                try:
                    ka_task.cancel()
                except Exception:
                    pass

            await conexoes_ativas.disconnect(ws, topic, cid=cid_eff)
        except Exception:
            pass