#backend\integrations\evolution\parsers\contact_parser.py

from __future__ import annotations

from typing import Any

from ..repositories.lid_map_repo import resolve_lid_or_fallback
from ..utils.jid_utils import is_lid_jid, jid_strip_device
from ..utils.phone_utils import formatar_telefone_br, remote_to_num
from .base_extractors import extract_contacts_any_shape


def _safe_str(v: Any) -> str:
    if v is None:
        return ""
    return str(v).strip()


def _pick_name(c: dict) -> str | None:
    for k in (
        "verifiedName",
        "name",
        "pushName",
        "notifyName",
        "formattedName",
        "shortName",
        "contactName",
        "displayName",
        "fullName",
        "subject",
        "title",
    ):
        v = c.get(k)
        if isinstance(v, str) and v.strip():
            return v.strip()
    return None


def _pick_avatar(c: dict) -> str | None:
    return (
        c.get("profilePicUrl")
        or (c.get("profilePicThumbObj") or {}).get("eurl")
        or c.get("thumbnailUrl")
        or c.get("imageUrl")
        or c.get("pictureUrl")
        or None
    )


def _pick_remote(c: dict) -> str:
    return _safe_str(
        c.get("remoteJid")
        or c.get("id")
        or c.get("jid")
        or c.get("wid")
        or c.get("user")
        or ""
    )


def _resolve_contact_remote(
    *,
    empresa_id: int | None,
    instancia_id: int | None,
    raw_remote: str,
) -> tuple[str | None, bool]:
    raw = jid_strip_device(raw_remote or "")
    if not raw:
        return None, False

    if is_lid_jid(raw):
        mapped = None
        if empresa_id and instancia_id:
            mapped = resolve_lid_or_fallback(
                empresa_id=int(empresa_id),
                instancia_id=int(instancia_id),
                lid_jid=raw,
                fallback_jid=None,
            )
        if mapped:
            return jid_strip_device(mapped), True
        return raw, True

    return raw, False


def parse_contact_item(
    item: dict,
    *,
    inst_name: str,
    empresa_id: int | None = None,
    instancia_id: int | None = None,
    me_number: str | None = None,
) -> dict:
    _ = inst_name
    c = item if isinstance(item, dict) else {}

    raw_remote = _pick_remote(c)
    remote_jid, was_lid = _resolve_contact_remote(
        empresa_id=empresa_id,
        instancia_id=instancia_id,
        raw_remote=raw_remote,
    )
    telefone = remote_to_num(remote_jid) if remote_jid else None
    nome = _pick_name(c)
    avatar_url = _pick_avatar(c)

    is_self = bool(me_number and telefone and str(me_number) == str(telefone))
    is_group = bool(remote_jid and str(remote_jid).endswith("@g.us"))

    return {
        "raw": c,
        "raw_remote_jid": jid_strip_device(raw_remote) if raw_remote else None,
        "remote_jid": remote_jid,
        "telefone": telefone,
        "telefone_formatado": formatar_telefone_br(telefone) if telefone else None,
        "nome": nome,
        "nome_default": nome or (formatar_telefone_br(telefone) if telefone else None),
        "avatar_url": avatar_url,
        "is_lid": was_lid,
        "is_group": is_group,
        "is_self": is_self,
        "instancia_name": inst_name,
        "instancia_id": instancia_id,
        "empresa_id": empresa_id,
    }


def parse_contacts_payload(
    payload: dict | list,
    *,
    inst_name: str,
    empresa_id: int | None = None,
    instancia_id: int | None = None,
    me_number: str | None = None,
) -> list[dict]:
    contatos = extract_contacts_any_shape(payload)
    out: list[dict] = []

    for c in contatos:
        if not isinstance(c, dict):
            continue
        out.append(
            parse_contact_item(
                c,
                inst_name=inst_name,
                empresa_id=empresa_id,
                instancia_id=instancia_id,
                me_number=me_number,
            )
        )

    return out


def filter_real_contacts(items: list[dict]) -> list[dict]:
    out: list[dict] = []
    for item in items or []:
        if not isinstance(item, dict):
            continue
        if item.get("is_group"):
            continue
        if item.get("is_self"):
            continue
        if not item.get("telefone"):
            continue
        out.append(item)
    return out


__all__ = [
    "extract_contacts_any_shape",
    "parse_contact_item",
    "parse_contacts_payload",
    "filter_real_contacts",
]