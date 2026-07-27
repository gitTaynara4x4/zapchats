from __future__ import annotations

import hashlib
import json
import os
import threading
import time
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, Optional

from backend.cache.redis_client import k, r


def _env_int(name: str, default: int) -> int:
    try:
        return int(str(os.getenv(name, default)).strip())
    except Exception:
        return default


PRESENCE_TTL_SECONDS = max(45, _env_int("ZAPSCHAT_PRESENCE_TTL_SECONDS", 90))
PRESENCE_AGGREGATE_TTL_SECONDS = PRESENCE_TTL_SECONDS + 30
VALID_STATES = {"online", "away"}

# Fallback local para desenvolvimento ou indisponibilidade temporária do Redis.
# Em produção, o Redis continua sendo a fonte compartilhada entre processos.
_memory_lock = threading.RLock()
_memory_sessions: Dict[str, Dict[str, Any]] = {}
_memory_aggregates: Dict[str, Dict[str, Any]] = {}


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _normalize_state(value: Any) -> str:
    state = str(value or "online").strip().lower()
    return state if state in VALID_STATES else "online"


def _safe_session_id(value: Any) -> str:
    raw = str(value or "session").strip() or "session"
    return hashlib.sha1(raw.encode("utf-8", "ignore")).hexdigest()[:32]


def _session_prefix(empresa_id: int, colaborador_id: Optional[int] = None) -> str:
    parts = ["presence", "emp", str(int(empresa_id)), "colab"]
    if colaborador_id is not None:
        parts.extend([str(int(colaborador_id)), "session"])
    return k(*parts)


def _session_key(empresa_id: int, colaborador_id: int, session_id: Any) -> str:
    return f"{_session_prefix(empresa_id, colaborador_id)}:{_safe_session_id(session_id)}"


def _aggregate_key(empresa_id: int, colaborador_id: int) -> str:
    return k(
        "presence",
        "emp",
        str(int(empresa_id)),
        "colab",
        str(int(colaborador_id)),
        "aggregate",
    )


def _offline_payload(empresa_id: int, colaborador_id: int, *, at: Optional[datetime] = None) -> Dict[str, Any]:
    when = at or _now()
    return {
        "empresa_id": int(empresa_id),
        "colaborador_id": int(colaborador_id),
        "presence_status": "offline",
        "presence_updated_at": _iso(when),
        "presence_expires_at": None,
        "presence_activity_at": None,
        "presence_session_count": 0,
    }


def _active_payload(
    empresa_id: int,
    colaborador_id: int,
    sessions: Iterable[Dict[str, Any]],
) -> Dict[str, Any]:
    by_session: Dict[str, Dict[str, Any]] = {}
    for index, item in enumerate(sessions):
        if not isinstance(item, dict):
            continue
        session_key = str(item.get("session_id") or f"anonymous-{index}")
        previous = by_session.get(session_key)
        if previous is None or str(item.get("updated_at") or "") >= str(previous.get("updated_at") or ""):
            by_session[session_key] = item

    valid = list(by_session.values())
    if not valid:
        return _offline_payload(empresa_id, colaborador_id)

    online = [s for s in valid if _normalize_state(s.get("state")) == "online"]
    chosen = online if online else valid
    status = "online" if online else "away"

    def _sort_value(item: Dict[str, Any]) -> str:
        return str(item.get("updated_at") or "")

    latest = max(chosen, key=_sort_value)
    expires_values = [str(s.get("expires_at") or "") for s in valid if s.get("expires_at")]
    expires_at = max(expires_values) if expires_values else None
    activity_values = [str(s.get("activity_at") or "") for s in chosen if s.get("activity_at")]
    activity_at = max(activity_values) if activity_values else None

    return {
        "empresa_id": int(empresa_id),
        "colaborador_id": int(colaborador_id),
        "presence_status": status,
        "presence_updated_at": str(latest.get("updated_at") or _iso(_now())),
        "presence_expires_at": expires_at,
        "presence_activity_at": activity_at,
        "presence_session_count": len(valid),
    }


def _decode_json(raw: Any) -> Optional[Dict[str, Any]]:
    if isinstance(raw, dict):
        return raw
    if not raw:
        return None
    try:
        value = json.loads(raw)
        return value if isinstance(value, dict) else None
    except Exception:
        return None


def _redis_get_aggregate(empresa_id: int, colaborador_id: int) -> Optional[Dict[str, Any]]:
    if r is None:
        return None
    try:
        return _decode_json(r.get(_aggregate_key(empresa_id, colaborador_id)))
    except Exception:
        return None



def _parse_iso_datetime(value: Any) -> Optional[datetime]:
    raw = str(value or '').strip()
    if not raw:
        return None
    try:
        parsed = datetime.fromisoformat(raw.replace('Z', '+00:00'))
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
    except Exception:
        return None


def _normalize_aggregate_payload(
    empresa_id: int,
    colaborador_id: int,
    payload: Optional[Dict[str, Any]],
) -> Dict[str, Any]:
    """Valida o agregado sem varrer as sessões individuais no Redis."""
    if not isinstance(payload, dict):
        return _offline_payload(empresa_id, colaborador_id)

    status = str(payload.get('presence_status') or '').strip().lower()
    if status not in VALID_STATES:
        return _offline_payload(empresa_id, colaborador_id)

    now = _now()
    expires_at = _parse_iso_datetime(payload.get('presence_expires_at'))
    if expires_at is not None and expires_at <= now:
        return _offline_payload(empresa_id, colaborador_id, at=expires_at)

    # Compatibilidade com agregados antigos sem expires_at.
    if expires_at is None:
        updated_at = _parse_iso_datetime(payload.get('presence_updated_at'))
        if updated_at is None or (now - updated_at).total_seconds() > PRESENCE_AGGREGATE_TTL_SECONDS:
            return _offline_payload(empresa_id, colaborador_id)

    return {
        'empresa_id': int(empresa_id),
        'colaborador_id': int(colaborador_id),
        'presence_status': status,
        'presence_updated_at': payload.get('presence_updated_at'),
        'presence_expires_at': payload.get('presence_expires_at'),
        'presence_activity_at': payload.get('presence_activity_at'),
        'presence_session_count': int(payload.get('presence_session_count') or 0),
    }


def _redis_aggregates_for_company(
    empresa_id: int,
    colaborador_ids: Optional[Iterable[int]] = None,
) -> Optional[Dict[int, Dict[str, Any]]]:
    """Lê presença em lote usando MGET.

    A listagem de colaboradores nunca deve usar SCAN nas sessões nem executar um
    GET por usuário. Quando os IDs são conhecidos, esta função faz uma única ida
    ao Redis, independentemente da quantidade de colaboradores.
    """
    if r is None:
        return None

    try:
        if colaborador_ids is None:
            pattern = f"{_session_prefix(int(empresa_id))}:*:aggregate"
            keys = list(r.scan_iter(match=pattern, count=500))
        else:
            ids = sorted({int(cid) for cid in colaborador_ids if cid is not None})
            keys = [_aggregate_key(int(empresa_id), cid) for cid in ids]

        if not keys:
            return {}

        out: Dict[int, Dict[str, Any]] = {}
        batch_size = 500
        for start in range(0, len(keys), batch_size):
            batch = keys[start:start + batch_size]
            values = r.mget(batch)
            for raw in values:
                payload = _decode_json(raw)
                if not payload:
                    continue
                try:
                    cid = int(payload.get('colaborador_id'))
                except Exception:
                    continue
                out[cid] = payload
        return out
    except Exception:
        return None


def _memory_aggregates_for_company(
    empresa_id: int,
    colaborador_ids: Optional[Iterable[int]] = None,
) -> Dict[int, Dict[str, Any]]:
    wanted = None
    if colaborador_ids is not None:
        wanted = {int(cid) for cid in colaborador_ids if cid is not None}

    out: Dict[int, Dict[str, Any]] = {}
    with _memory_lock:
        for payload in _memory_aggregates.values():
            if not isinstance(payload, dict):
                continue
            try:
                emp = int(payload.get('empresa_id'))
                cid = int(payload.get('colaborador_id'))
            except Exception:
                continue
            if emp != int(empresa_id):
                continue
            if wanted is not None and cid not in wanted:
                continue
            out[cid] = dict(payload)
    return out


def _merge_aggregate_maps(
    redis_values: Optional[Dict[int, Dict[str, Any]]],
    memory_values: Dict[int, Dict[str, Any]],
) -> Dict[int, Dict[str, Any]]:
    out = dict(redis_values or {})
    for cid, payload in memory_values.items():
        current = out.get(cid)
        if current is None or str(payload.get('presence_updated_at') or '') >= str(current.get('presence_updated_at') or ''):
            out[cid] = payload
    return out

def _redis_write_aggregate(payload: Dict[str, Any]) -> None:
    if r is None:
        return
    try:
        empresa_id = int(payload["empresa_id"])
        colaborador_id = int(payload["colaborador_id"])
        key = _aggregate_key(empresa_id, colaborador_id)
        if payload.get("presence_status") == "offline":
            r.delete(key)
        else:
            r.set(
                key,
                json.dumps(payload, ensure_ascii=False),
                ex=PRESENCE_AGGREGATE_TTL_SECONDS,
            )
    except Exception:
        pass


def _redis_sessions_for_company(empresa_id: int) -> Optional[Dict[int, list[Dict[str, Any]]]]:
    if r is None:
        return None

    grouped: Dict[int, list[Dict[str, Any]]] = {}
    pattern = f"{_session_prefix(empresa_id)}:*:session:*"

    try:
        for key in r.scan_iter(match=pattern, count=250):
            item = _decode_json(r.get(key))
            if not item:
                continue
            try:
                cid = int(item.get("colaborador_id"))
            except Exception:
                continue
            grouped.setdefault(cid, []).append(item)
        return grouped
    except Exception:
        return None




def _redis_sessions_for_colaborador(
    empresa_id: int,
    colaborador_id: int,
) -> Optional[list[Dict[str, Any]]]:
    if r is None:
        return None

    items: list[Dict[str, Any]] = []
    pattern = f"{_session_prefix(empresa_id, colaborador_id)}:*"

    try:
        for key in r.scan_iter(match=pattern, count=20):
            item = _decode_json(r.get(key))
            if item:
                items.append(item)
        return items
    except Exception:
        return None


def _memory_cleanup(now_ts: Optional[float] = None) -> None:
    now_value = float(now_ts if now_ts is not None else time.time())
    expired = [key for key, item in _memory_sessions.items() if float(item.get("expires_ts") or 0) <= now_value]
    for key in expired:
        _memory_sessions.pop(key, None)


def _memory_sessions_for_company(empresa_id: int) -> Dict[int, list[Dict[str, Any]]]:
    grouped: Dict[int, list[Dict[str, Any]]] = {}
    with _memory_lock:
        _memory_cleanup()
        for item in _memory_sessions.values():
            if int(item.get("empresa_id") or 0) != int(empresa_id):
                continue
            try:
                cid = int(item.get("colaborador_id"))
            except Exception:
                continue
            grouped.setdefault(cid, []).append(dict(item))
    return grouped


def _company_sessions(empresa_id: int) -> Dict[int, list[Dict[str, Any]]]:
    redis_value = _redis_sessions_for_company(empresa_id)
    memory_value = _memory_sessions_for_company(empresa_id)

    if redis_value is None:
        return memory_value

    for cid, items in memory_value.items():
        redis_value.setdefault(cid, []).extend(items)
    return redis_value


def list_company_presence(
    empresa_id: int,
    colaborador_ids: Optional[Iterable[int]] = None,
    *,
    include_offline: bool = False,
) -> Dict[int, Dict[str, Any]]:
    """Retorna presença da empresa sem varrer sessões individuais.

    - IDs informados: uma leitura MGET no Redis.
    - Snapshot geral: varre apenas uma chave agregada por colaborador e lê em lote.
    - Redis indisponível: usa o fallback em memória.
    """
    empresa_id = int(empresa_id)
    ids = None
    if colaborador_ids is not None:
        ids = {int(cid) for cid in colaborador_ids if cid is not None}

    redis_values = _redis_aggregates_for_company(empresa_id, ids)
    memory_values = _memory_aggregates_for_company(empresa_id, ids)
    merged = _merge_aggregate_maps(redis_values, memory_values)

    if ids is None:
        selected_ids = set(merged.keys())
    else:
        selected_ids = ids

    out: Dict[int, Dict[str, Any]] = {}
    for cid in selected_ids:
        payload = _normalize_aggregate_payload(
            empresa_id,
            cid,
            merged.get(cid),
        )
        if include_offline or payload['presence_status'] != 'offline':
            out[cid] = payload
    return out


def get_colaborador_presence(empresa_id: int, colaborador_id: int) -> Dict[str, Any]:
    empresa_id = int(empresa_id)
    colaborador_id = int(colaborador_id)

    sessions = _redis_sessions_for_colaborador(empresa_id, colaborador_id)
    memory_sessions = _memory_sessions_for_company(empresa_id).get(colaborador_id, [])
    if sessions is None:
        sessions = memory_sessions
    elif memory_sessions:
        sessions.extend(memory_sessions)

    return _active_payload(empresa_id, colaborador_id, sessions)


def touch_presence_session(
    empresa_id: int,
    colaborador_id: int,
    session_id: Any,
    state: Any = "online",
    *,
    activity_at: Optional[str] = None,
) -> Dict[str, Any]:
    empresa_id = int(empresa_id)
    colaborador_id = int(colaborador_id)
    state_norm = _normalize_state(state)
    now = _now()
    expires = now.timestamp() + PRESENCE_TTL_SECONDS
    session_key = _session_key(empresa_id, colaborador_id, session_id)

    previous = _redis_get_aggregate(empresa_id, colaborador_id)
    if previous is None:
        with _memory_lock:
            previous = _memory_aggregates.get(_aggregate_key(empresa_id, colaborador_id))

    item = {
        "empresa_id": empresa_id,
        "colaborador_id": colaborador_id,
        "session_id": _safe_session_id(session_id),
        "state": state_norm,
        "updated_at": _iso(now),
        "expires_at": _iso(datetime.fromtimestamp(expires, tz=timezone.utc)),
        "activity_at": str(activity_at or "") or None,
        "expires_ts": expires,
    }

    wrote_redis = False
    if r is not None:
        try:
            r.set(
                session_key,
                json.dumps(item, ensure_ascii=False),
                ex=PRESENCE_TTL_SECONDS,
            )
            wrote_redis = True
        except Exception:
            wrote_redis = False

    if not wrote_redis:
        with _memory_lock:
            _memory_sessions[session_key] = dict(item)

    current = get_colaborador_presence(empresa_id, colaborador_id)
    current["presence_changed"] = (
        str((previous or {}).get("presence_status") or "offline")
        != str(current.get("presence_status") or "offline")
    )

    _redis_write_aggregate(current)
    with _memory_lock:
        _memory_aggregates[_aggregate_key(empresa_id, colaborador_id)] = dict(current)

    return current


def remove_presence_session(
    empresa_id: int,
    colaborador_id: int,
    session_id: Any,
) -> Dict[str, Any]:
    empresa_id = int(empresa_id)
    colaborador_id = int(colaborador_id)
    session_key = _session_key(empresa_id, colaborador_id, session_id)

    previous = _redis_get_aggregate(empresa_id, colaborador_id)
    if previous is None:
        with _memory_lock:
            previous = _memory_aggregates.get(_aggregate_key(empresa_id, colaborador_id))

    if r is not None:
        try:
            r.delete(session_key)
        except Exception:
            pass

    with _memory_lock:
        _memory_sessions.pop(session_key, None)

    current = get_colaborador_presence(empresa_id, colaborador_id)
    previous_state = str((previous or {}).get("presence_status") or "offline")
    current_state = str(current.get("presence_status") or "offline")
    current["presence_changed"] = previous_state != current_state

    _redis_write_aggregate(current)
    with _memory_lock:
        if current_state == "offline":
            _memory_aggregates.pop(_aggregate_key(empresa_id, colaborador_id), None)
        else:
            _memory_aggregates[_aggregate_key(empresa_id, colaborador_id)] = dict(current)

    if current_state == "offline" and previous_state != "offline":
        _persist_last_access(
            empresa_id,
            colaborador_id,
            current.get("presence_updated_at"),
        )

    return current


def _persist_last_access(empresa_id: int, colaborador_id: int, iso_value: Optional[str]) -> None:
    try:
        from backend.database import SessionLocal
        from backend import models

        when = _now()
        if iso_value:
            try:
                parsed = datetime.fromisoformat(str(iso_value).replace("Z", "+00:00"))
                when = parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
            except Exception:
                pass

        with SessionLocal() as db:
            row = (
                db.query(models.Colaborador)
                .filter(
                    models.Colaborador.id == int(colaborador_id),
                    models.Colaborador.empresa_id == int(empresa_id),
                )
                .first()
            )
            if row is None or not hasattr(row, "last_access_at"):
                return
            row.last_access_at = when.astimezone(timezone.utc)
            db.add(row)
            db.commit()
    except Exception:
        # Presença nunca deve derrubar o WebSocket por falha de auditoria.
        pass


def public_presence_payload(payload: Dict[str, Any]) -> Dict[str, Any]:
    return {
        key: payload.get(key)
        for key in (
            "empresa_id",
            "colaborador_id",
            "presence_status",
            "presence_updated_at",
            "presence_expires_at",
            "presence_activity_at",
            "presence_session_count",
        )
    }
