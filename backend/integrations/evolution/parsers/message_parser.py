#backend\integrations\evolution\parsers\message_parser.py

from __future__ import annotations
from typing import Any
from ..repositories.lid_map_repo import resolve_lid_or_fallback
from ..utils.ack_utils import ack_from_status
from ..utils.jid_utils import is_group_jid, is_lid_jid, jid_strip_device
from ..utils.phone_utils import (
    _resolve_counterparty_num_1to1,
    formatar_telefone_br,
    remote_to_num,
)
from ..utils.time_utils import to_dt_utc
from .base_extractors import (
    extract_media_meta,
    extract_messages_any_shape,
    extract_text_from_baileys,
)


def _as_dict(v: Any) -> dict:
    return v if isinstance(v, dict) else {}


def _safe_str(v: Any) -> str:
    if v is None:
        return ""
    return str(v).strip()


def _extract_key(m: dict) -> dict:
    key = m.get("key")
    return key if isinstance(key, dict) else {}


def _extract_raw_remote(m: dict) -> str:
    key = _extract_key(m)
    return _safe_str(
        key.get("remoteJid")
        or key.get("remote_jid")
        or m.get("remoteJid")
        or m.get("remote_jid")
        or m.get("jid")
        or m.get("chatId")
        or ""
    )


def _extract_alt_remote(m: dict) -> str:
    key = _extract_key(m)
    return _safe_str(
        key.get("remoteJidAlt")
        or key.get("remote_jid_alt")
        or m.get("remoteJidAlt")
        or m.get("remote_jid_alt")
        or ""
    )


def _extract_participant(m: dict) -> str:
    key = _extract_key(m)
    return _safe_str(
        key.get("participant")
        or m.get("participant")
        or m.get("sender")
        or m.get("participantJid")
        or ""
    )


def _extract_push_name(m: dict) -> str | None:
    for k in ("pushName", "senderName", "notifyName", "verifiedName", "name"):
        v = m.get(k)
        if isinstance(v, str) and v.strip():
            return v.strip()
    return None


def _extract_msg_id(m: dict) -> str | None:
    key = _extract_key(m)
    v = key.get("id") or m.get("id") or m.get("messageId")
    s = _safe_str(v)
    return s or None


def _extract_timestamp_raw(m: dict) -> Any:
    return (
        m.get("messageTimestamp")
        or m.get("timestamp")
        or m.get("message_time")
        or m.get("ts")
        or 0
    )


def _resolve_lid_jid(
    *,
    empresa_id: int | None,
    instancia_id: int | None,
    lid_jid: str,
    alt_remote: str | None = None,
) -> str | None:
    lid_norm = jid_strip_device(lid_jid)
    alt_norm = jid_strip_device(alt_remote) if alt_remote else ""

    if alt_norm and "@" in alt_norm:
        return alt_norm

    if empresa_id and instancia_id:
        mapped = resolve_lid_or_fallback(
            empresa_id=int(empresa_id),
            instancia_id=int(instancia_id),
            lid_jid=lid_norm,
            fallback_jid=None,
        )
        if mapped:
            return jid_strip_device(mapped)

    return None


def _normalize_remote_with_lid(
    *,
    inst_name: str,
    empresa_id: int | None,
    instancia_id: int | None,
    raw_remote: str,
    alt_remote: str,
    message_item: dict,
    me_number: str | None,
) -> dict:
    _ = inst_name  # mantido por compatibilidade de assinatura
    original_raw = jid_strip_device(raw_remote or "")
    alt_remote = jid_strip_device(alt_remote or "")
    resolved = None
    used_alt = False
    lid_fallback_phone = None
    needs_mapping = False

    if not original_raw:
        return {
            "original_remote_jid": "",
            "resolved_remote_jid": "",
            "alt_remote_jid": alt_remote or None,
            "lid_original_jid": None,
            "used_lid_alt": False,
            "lid_fallback_phone": None,
            "needs_lid_mapping": False,
        }

    if is_lid_jid(original_raw):
        resolved = _resolve_lid_jid(
            empresa_id=empresa_id,
            instancia_id=instancia_id,
            lid_jid=original_raw,
            alt_remote=alt_remote,
        )
        used_alt = bool(resolved and alt_remote and resolved == alt_remote)

        if not resolved:
            tel_fallback, alt = _resolve_counterparty_num_1to1(message_item, me_number)
            lid_fallback_phone = tel_fallback

            if isinstance(alt, str) and "@" in alt:
                resolved = jid_strip_device(alt)
            elif tel_fallback and not str(tel_fallback).startswith("LID-"):
                resolved = f"{tel_fallback}@s.whatsapp.net"
            else:
                resolved = original_raw
                needs_mapping = True

        return {
            "original_remote_jid": original_raw,
            "resolved_remote_jid": jid_strip_device(resolved or original_raw),
            "alt_remote_jid": alt_remote or None,
            "lid_original_jid": original_raw,
            "used_lid_alt": used_alt,
            "lid_fallback_phone": lid_fallback_phone,
            "needs_lid_mapping": needs_mapping,
        }

    resolved = jid_strip_device(original_raw)
    return {
        "original_remote_jid": original_raw,
        "resolved_remote_jid": resolved,
        "alt_remote_jid": alt_remote or None,
        "lid_original_jid": None,
        "used_lid_alt": False,
        "lid_fallback_phone": None,
        "needs_lid_mapping": False,
    }


def _is_group_jid(jid: str | None) -> bool:
    return is_group_jid(jid_strip_device(jid or ""))


def is_textual_content(texto: Any) -> bool:
    return bool(_safe_str(texto))


def parse_message_item(
    item: dict,
    *,
    inst_name: str,
    empresa_id: int | None = None,
    instancia_id: int | None = None,
    me_number: str | None = None,
) -> dict:
    m = _as_dict(item)
    key = _extract_key(m)

    msg_id = _extract_msg_id(m)
    raw_remote = _extract_raw_remote(m)
    alt_remote = _extract_alt_remote(m)
    participant = jid_strip_device(_extract_participant(m))
    push_name = _extract_push_name(m)
    ts_raw = _extract_timestamp_raw(m)
    status = m.get("status")
    from_me = bool(key.get("fromMe", m.get("fromMe", False)))

    remote_info = _normalize_remote_with_lid(
        inst_name=inst_name,
        empresa_id=empresa_id,
        instancia_id=instancia_id,
        raw_remote=raw_remote,
        alt_remote=alt_remote,
        message_item=m,
        me_number=me_number,
    )

    remote_jid = jid_strip_device(remote_info["resolved_remote_jid"] or "")
    telefone = remote_to_num(remote_jid)
    direcao = "saida" if from_me else "entrada"
    conteudo = extract_text_from_baileys(m)
    media_meta = extract_media_meta(m)
    message_type = _safe_str(m.get("messageType")) or None
    source = _safe_str(m.get("source")) or None

    try:
        ts_dt = to_dt_utc(ts_raw)
        timestamp_iso = ts_dt.isoformat() if ts_dt else None
    except Exception:
        ts_dt = None
        timestamp_iso = None

    ack = int(ack_from_status(status) if from_me else 0)

    return {
        "msg_id": msg_id,
        "key": key,
        "raw": m,
        "raw_remote_jid": jid_strip_device(raw_remote) if raw_remote else None,
        "remote_jid": remote_jid or None,
        "remote_jid_original": remote_info["original_remote_jid"] or None,
        "remote_jid_alt": remote_info["alt_remote_jid"],
        "participant_jid": participant or None,
        "is_group": _is_group_jid(remote_jid),
        "from_me": from_me,
        "direcao": direcao,
        "status": status,
        "ack": ack,
        "push_name": push_name,
        "conteudo": conteudo,
        "is_textual": is_textual_content(conteudo),
        "media_meta": media_meta,
        "message_type": message_type,
        "source": source,
        "timestamp_raw": ts_raw,
        "timestamp_dt": ts_dt,
        "timestamp_iso": timestamp_iso,
        "telefone": telefone,
        "telefone_formatado": formatar_telefone_br(telefone) if telefone else None,
        "instancia_name": inst_name,
        "instancia_id": instancia_id,
        "empresa_id": empresa_id,
        "lid_original_jid": remote_info["lid_original_jid"],
        "used_lid_alt": remote_info["used_lid_alt"],
        "lid_fallback_phone": remote_info["lid_fallback_phone"],
        "needs_lid_mapping": remote_info["needs_lid_mapping"],
    }


def parse_messages_payload(
    payload: dict | list,
    *,
    inst_name: str,
    empresa_id: int | None = None,
    instancia_id: int | None = None,
    me_number: str | None = None,
) -> list[dict]:
    items = extract_messages_any_shape(payload)
    out: list[dict] = []

    for item in items:
        if not isinstance(item, dict):
            continue
        out.append(
            parse_message_item(
                item,
                inst_name=inst_name,
                empresa_id=empresa_id,
                instancia_id=instancia_id,
                me_number=me_number,
            )
        )

    return out


def filter_group_messages(items: list[dict]) -> list[dict]:
    return [x for x in (items or []) if x.get("is_group")]


def filter_direct_messages(items: list[dict]) -> list[dict]:
    return [x for x in (items or []) if not x.get("is_group")]


def is_recent_message(parsed: dict, *, now_dt, max_age_seconds: int) -> bool:
    ts_dt = parsed.get("timestamp_dt")
    if not ts_dt or not now_dt:
        return False
    try:
        delta = abs((now_dt - ts_dt).total_seconds())
        return delta <= int(max_age_seconds)
    except Exception:
        return False


__all__ = [
    "extract_messages_any_shape",
    "extract_text_from_baileys",
    "extract_media_meta",
    "parse_message_item",
    "parse_messages_payload",
    "filter_group_messages",
    "filter_direct_messages",
    "is_textual_content",
    "is_recent_message",
]