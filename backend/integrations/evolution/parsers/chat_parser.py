
#backend\integrations\evolution\parsers\chat_parser.py

from __future__ import annotations
from typing import Any
from ..utils.jid_utils import jid_strip_device
from ..utils.phone_utils import formatar_telefone_br, remote_to_num
from .base_extractors import extract_chats_any_shape


def _safe_str(v: Any) -> str:
    if v is None:
        return ""
    return str(v).strip()


def _pick_remote(chat: dict) -> str:
    return _safe_str(
        chat.get("id")
        or chat.get("remoteJid")
        or chat.get("jid")
        or chat.get("wid")
        or ""
    )


def _pick_name(chat: dict) -> str | None:
    for k in (
        "verifiedName",
        "name",
        "pushName",
        "notifyName",
        "formattedName",
        "shortName",
        "contactName",
        "subject",
        "title",
        "displayName",
    ):
        v = chat.get(k)
        if isinstance(v, str) and v.strip():
            return v.strip()
    return None


def _pick_avatar(chat: dict) -> str | None:
    return (
        chat.get("profilePicUrl")
        or (chat.get("profilePicThumbObj") or {}).get("eurl")
        or chat.get("thumbnailUrl")
        or chat.get("imageUrl")
        or chat.get("pictureUrl")
        or None
    )


def parse_chat_item(
    item: dict,
    *,
    inst_name: str,
    empresa_id: int | None = None,
    instancia_id: int | None = None,
) -> dict:
    c = item if isinstance(item, dict) else {}

    remote_jid = jid_strip_device(_pick_remote(c))
    is_group = bool(remote_jid and remote_jid.endswith("@g.us"))
    telefone = None if is_group else remote_to_num(remote_jid)
    nome = _pick_name(c)
    avatar_url = _pick_avatar(c)

    unread = c.get("unreadCount")
    try:
        unread = int(unread or 0)
    except Exception:
        unread = 0

    archived = bool(c.get("archived", False))
    pinned = bool(c.get("pinned", False))
    muted = bool(c.get("muteEndTime") or c.get("muted", False))

    return {
        "raw": c,
        "remote_jid": remote_jid or None,
        "is_group": is_group,
        "telefone": telefone,
        "telefone_formatado": formatar_telefone_br(telefone) if telefone else None,
        "nome": nome,
        "nome_default": nome or ("Grupo" if is_group else (formatar_telefone_br(telefone) if telefone else None)),
        "avatar_url": avatar_url,
        "unread_count": unread,
        "archived": archived,
        "pinned": pinned,
        "muted": muted,
        "instancia_name": inst_name,
        "instancia_id": instancia_id,
        "empresa_id": empresa_id,
    }


def parse_chats_payload(
    payload: dict | list,
    *,
    inst_name: str,
    empresa_id: int | None = None,
    instancia_id: int | None = None,
) -> list[dict]:
    chats = extract_chats_any_shape(payload)
    out: list[dict] = []

    for chat in chats:
        if not isinstance(chat, dict):
            continue
        out.append(
            parse_chat_item(
                chat,
                inst_name=inst_name,
                empresa_id=empresa_id,
                instancia_id=instancia_id,
            )
        )

    return out


def filter_group_chats(items: list[dict]) -> list[dict]:
    return [x for x in (items or []) if x.get("is_group")]


def filter_direct_chats(items: list[dict]) -> list[dict]:
    return [x for x in (items or []) if not x.get("is_group")]


__all__ = [
    "extract_chats_any_shape",
    "parse_chat_item",
    "parse_chats_payload",
    "filter_group_chats",
    "filter_direct_chats",
]