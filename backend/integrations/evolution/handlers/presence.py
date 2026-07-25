# backend/integrations/evolution/handlers/presence.py

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Iterable

from sqlalchemy import or_
from sqlalchemy.orm import Session

from backend import models
from backend.database import SessionLocal

from ..transport.rabbit_consumer import record_rabbit_event
from ..transport.websocket_emitters import emit_to_company
from ..utils.jid_utils import is_group_jid, is_lid_jid, jid_strip_device
from ..utils.phone_utils import normalize_phone_for_db, phone_lookup_variants
from .shared import EvoEvent, _get_inst_row, handler, resolve_lid_identity


_ONLINE_STATES = {"available", "composing", "recording", "paused"}
_OFFLINE_STATES = {"unavailable", "offline"}
_VALID_STATES = _ONLINE_STATES | _OFFLINE_STATES


def _inst_from_payload(first: str, payload: dict | list) -> str:
    if isinstance(payload, dict):
        for key in ("instance", "instanceName", "instanceId"):
            value = payload.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()

        data = payload.get("data")
        if isinstance(data, dict):
            for key in ("instance", "instanceName", "instanceId"):
                value = data.get(key)
                if isinstance(value, str) and value.strip():
                    return value.strip()

    return str(first or "").strip()


def _aware_utc(value: Any) -> datetime | None:
    """Converte timestamps da Evolution/Baileys para UTC."""
    if value is None:
        return None

    if isinstance(value, datetime):
        if value.tzinfo is None:
            return value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc)

    # Long serializado pelo protobuf/JSON.
    if isinstance(value, dict):
        if "low" in value:
            try:
                low = int(value.get("low") or 0) & 0xFFFFFFFF
                high = int(value.get("high") or 0)
                value = (high << 32) + low
            except Exception:
                return None
        else:
            for key in ("timestamp", "seconds", "value", "lastSeen", "last_seen"):
                if key in value:
                    return _aware_utc(value.get(key))
            return None

    try:
        if isinstance(value, (int, float)):
            number = float(value)
        else:
            raw = str(value).strip()
            if not raw:
                return None
            try:
                number = float(raw)
            except ValueError:
                normalized = raw[:-1] + "+00:00" if raw.endswith("Z") else raw
                parsed = datetime.fromisoformat(normalized)
                if parsed.tzinfo is None:
                    parsed = parsed.replace(tzinfo=timezone.utc)
                return parsed.astimezone(timezone.utc)

        if number <= 0:
            return None

        # A Evolution pode enviar segundos ou milissegundos.
        if number > 100_000_000_000:
            number /= 1000.0
        return datetime.fromtimestamp(number, tz=timezone.utc)
    except Exception:
        return None


def _first_datetime(*values: Any) -> datetime:
    for value in values:
        parsed = _aware_utc(value)
        if parsed is not None:
            return parsed
    return datetime.now(timezone.utc)


def _presence_status(raw: Any) -> str | None:
    value = str(raw or "").strip().lower().replace("-", "_")
    aliases = {
        "online": "available",
        "typing": "composing",
        "digitando": "composing",
        "audio": "recording",
        "gravando": "recording",
        "not_available": "unavailable",
    }
    value = aliases.get(value, value)
    return value if value in _VALID_STATES else None


def _dicts(value: Any) -> Iterable[dict[str, Any]]:
    if isinstance(value, dict):
        yield value
    elif isinstance(value, list):
        for item in value:
            if isinstance(item, dict):
                yield item


def _extract_presence_entries(payload: dict | list) -> list[dict[str, Any]]:
    """
    Normaliza os formatos mais comuns do evento PRESENCE_UPDATE.

    Evolution costuma enviar:
      data.id
      data.presences[jid].lastKnownPresence
      data.presences[jid].lastSeen
    """
    outer = payload if isinstance(payload, dict) else {}
    root: Any = outer.get("data", payload) if isinstance(outer, dict) else payload

    items = list(_dicts(root))
    if not items and isinstance(payload, list):
        items = list(_dicts(payload))

    entries: list[dict[str, Any]] = []

    for item in items:
        default_jid = (
            item.get("id")
            or item.get("jid")
            or item.get("remoteJid")
            or item.get("remote_jid")
            or outer.get("id")
        )

        presences = item.get("presences")
        if isinstance(presences, dict):
            for participant_jid, raw_presence in presences.items():
                values = list(_dicts(raw_presence))
                if not values and isinstance(raw_presence, str):
                    values = [{"lastKnownPresence": raw_presence}]
                if not values:
                    values = [{}]
                for presence in values:
                    status = _presence_status(
                        presence.get("lastKnownPresence")
                        or presence.get("last_known_presence")
                        or presence.get("presence")
                        or presence.get("status")
                    )
                    jid = (
                        presence.get("id")
                        or presence.get("jid")
                        or presence.get("participant")
                        or participant_jid
                        or default_jid
                    )
                    if status and jid:
                        entries.append(
                            {
                                "jid": jid,
                                "status": status,
                                "last_seen": presence.get("lastSeen", presence.get("last_seen")),
                                "observed_at": _first_datetime(
                                    presence.get("timestamp"),
                                    presence.get("updatedAt"),
                                    presence.get("updated_at"),
                                    item.get("date_time"),
                                    item.get("dateTime"),
                                    item.get("timestamp"),
                                    outer.get("date_time"),
                                    outer.get("dateTime"),
                                    outer.get("timestamp"),
                                ),
                            }
                        )
            continue

        # Alguns transportes achatam o objeto de presença diretamente em data.
        status = _presence_status(
            item.get("lastKnownPresence")
            or item.get("last_known_presence")
            or item.get("presence")
            or item.get("status")
        )
        if status and default_jid:
            entries.append(
                {
                    "jid": default_jid,
                    "status": status,
                    "last_seen": item.get("lastSeen", item.get("last_seen")),
                    "observed_at": _first_datetime(
                        item.get("date_time"),
                        item.get("dateTime"),
                        item.get("timestamp"),
                        outer.get("date_time"),
                        outer.get("dateTime"),
                        outer.get("timestamp"),
                    ),
                }
            )

    # Evita processar o mesmo JID/status mais de uma vez no mesmo evento.
    unique: dict[str, dict[str, Any]] = {}
    for entry in entries:
        jid = jid_strip_device(str(entry.get("jid") or ""))
        status = str(entry.get("status") or "")
        if not jid or not status:
            continue
        entry["jid"] = jid
        # Se o mesmo JID vier mais de uma vez, o estado mais ao final do
        # evento é o mais recente e deve prevalecer.
        unique[jid] = entry

    return list(unique.values())


def _resolve_cliente(
    db: Session,
    *,
    empresa_id: int,
    instancia_id: int | None,
    remote_jid: str,
) -> tuple[models.Cliente | None, models.ContatoWhatsappIdentidade | None]:
    remote = jid_strip_device(remote_jid)
    if not remote or is_group_jid(remote):
        return None, None

    identity = (
        db.query(models.ContatoWhatsappIdentidade)
        .filter(
            models.ContatoWhatsappIdentidade.empresa_id == int(empresa_id),
            models.ContatoWhatsappIdentidade.instancia_id
            == (int(instancia_id) if instancia_id is not None else None),
            or_(
                models.ContatoWhatsappIdentidade.remote_jid == remote,
                models.ContatoWhatsappIdentidade.lid_jid == remote,
                models.ContatoWhatsappIdentidade.real_jid == remote,
            ),
        )
        .order_by(
            models.ContatoWhatsappIdentidade.confirmado.desc(),
            models.ContatoWhatsappIdentidade.confianca.desc(),
        )
        .first()
    )

    if identity is not None and identity.cliente_id:
        cliente = (
            db.query(models.Cliente)
            .filter(
                models.Cliente.id == int(identity.cliente_id),
                models.Cliente.empresa_id == int(empresa_id),
            )
            .first()
        )
        if cliente is not None:
            return cliente, identity

    resolved_jid = remote
    telefone_norm = None
    resolved_cliente_id = None

    if is_lid_jid(remote):
        resolved = resolve_lid_identity(
            db,
            empresa_id=int(empresa_id),
            instancia_id=(int(instancia_id) if instancia_id is not None else None),
            lid_jid=remote,
        )
        resolved_jid = jid_strip_device(str(resolved.get("real_jid") or remote))
        telefone_norm = resolved.get("telefone_norm")
        resolved_cliente_id = resolved.get("cliente_id")

    if resolved_cliente_id:
        cliente = (
            db.query(models.Cliente)
            .filter(
                models.Cliente.id == int(resolved_cliente_id),
                models.Cliente.empresa_id == int(empresa_id),
            )
            .first()
        )
        if cliente is not None:
            if identity is not None and not identity.cliente_id:
                identity.cliente_id = int(cliente.id)
            return cliente, identity

    if not telefone_norm:
        telefone_norm = normalize_phone_for_db(remote_jid=resolved_jid)

    variants = tuple(phone_lookup_variants(telefone_norm or None, remote_jid=resolved_jid))
    if telefone_norm and telefone_norm not in variants:
        variants = (str(telefone_norm), *variants)

    if not variants:
        return None, identity

    query = db.query(models.Cliente).filter(
        models.Cliente.empresa_id == int(empresa_id),
        models.Cliente.telefone_norm.in_(variants),
    )

    # Prefere a conversa pertencente à instância que gerou o evento.
    cliente = None
    if instancia_id is not None:
        cliente = query.filter(models.Cliente.instancia_id == int(instancia_id)).first()
    if cliente is None:
        cliente = query.first()

    if cliente is not None and identity is not None and not identity.cliente_id:
        identity.cliente_id = int(cliente.id)

    return cliente, identity


def _iso(value: datetime | None) -> str | None:
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat()


@handler(EvoEvent.PRESENCE_UPDATE)
async def on_presence_update(first: str, payload: dict | list):
    instance_name = _inst_from_payload(first, payload)
    entries = _extract_presence_entries(payload)

    if not instance_name or not entries:
        record_rabbit_event(
            "PRESENCE_UPDATE",
            instance=instance_name,
            received=len(entries),
            mapped=0,
        )
        return

    outbound: list[tuple[int, dict[str, Any]]] = []
    mapped = 0

    with SessionLocal() as db:
        try:
            inst = _get_inst_row(db, instance_name)
            if inst is None:
                record_rabbit_event(
                    "PRESENCE_UPDATE",
                    instance=instance_name,
                    received=len(entries),
                    mapped=0,
                    reason="instance_not_found",
                )
                return

            empresa_id = int(inst.empresa_id)
            instancia_id = int(inst.id)

            for entry in entries:
                remote_jid = jid_strip_device(str(entry.get("jid") or ""))
                if not remote_jid or is_group_jid(remote_jid):
                    continue

                cliente, _identity = _resolve_cliente(
                    db,
                    empresa_id=empresa_id,
                    instancia_id=instancia_id,
                    remote_jid=remote_jid,
                )
                if cliente is None:
                    continue

                status = str(entry.get("status") or "").strip().lower()
                observed_at = entry.get("observed_at")
                if not isinstance(observed_at, datetime):
                    observed_at = datetime.now(timezone.utc)
                elif observed_at.tzinfo is None:
                    observed_at = observed_at.replace(tzinfo=timezone.utc)
                else:
                    observed_at = observed_at.astimezone(timezone.utc)

                previous_updated = getattr(cliente, "whatsapp_presence_updated_at", None)
                if isinstance(previous_updated, datetime):
                    if previous_updated.tzinfo is None:
                        previous_updated = previous_updated.replace(tzinfo=timezone.utc)
                    else:
                        previous_updated = previous_updated.astimezone(timezone.utc)
                    # Evento velho/reentregue não pode desfazer um estado mais novo.
                    if observed_at < previous_updated:
                        continue

                online = status in _ONLINE_STATES
                official_last_seen = _aware_utc(entry.get("last_seen"))

                last_seen = official_last_seen
                if last_seen is None:
                    # Também guardamos a última observação real. Assim há fallback
                    # quando a privacidade do WhatsApp não fornece lastSeen exato.
                    last_seen = observed_at

                current_last_seen = getattr(cliente, "whatsapp_last_seen", None)
                if isinstance(current_last_seen, datetime):
                    if current_last_seen.tzinfo is None:
                        current_last_seen = current_last_seen.replace(tzinfo=timezone.utc)
                    else:
                        current_last_seen = current_last_seen.astimezone(timezone.utc)
                    if last_seen < current_last_seen:
                        last_seen = current_last_seen

                cliente.whatsapp_presence = status
                cliente.whatsapp_online = bool(online)
                cliente.whatsapp_last_seen = last_seen
                cliente.whatsapp_presence_updated_at = observed_at

                mapped += 1
                outbound.append(
                    (
                        empresa_id,
                        {
                            "type": "presence_update",
                            "empresa_id": empresa_id,
                            "cliente_id": int(cliente.id),
                            "instancia_id": instancia_id,
                            "conversation_key": f"c:{int(cliente.id)}:{instancia_id}",
                            "remote_jid": remote_jid,
                            "presence_status": status,
                            "presence_online": bool(online),
                            "presence_last_seen": _iso(last_seen),
                            "presence_updated_at": _iso(observed_at),
                        },
                    )
                )

            if mapped:
                db.commit()
            else:
                db.rollback()
        except Exception:
            db.rollback()
            raise

    for empresa_id, ws_payload in outbound:
        await emit_to_company(empresa_id, ws_payload)

    record_rabbit_event(
        "PRESENCE_UPDATE",
        instance=instance_name,
        received=len(entries),
        mapped=mapped,
    )


__all__ = [
    "on_presence_update",
]
