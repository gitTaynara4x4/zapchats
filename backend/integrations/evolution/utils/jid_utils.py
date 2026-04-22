#backend\integrations\evolution\utils\jid_utils.py


from __future__ import annotations
import re
from typing import Any


_JID_DEVICE_RE = re.compile(r":\d+(?=@)")
_JID_AGENT_RE = re.compile(r"_[^@]+(?=@)")


def safe_str(v: Any) -> str:
    if v is None:
        return ""
    return str(v).strip()


def jid_strip_device(jid: str | None) -> str:
    """
    Remove sufixos de device/agent do JID.
    Ex:
      5511999999999:12@s.whatsapp.net -> 5511999999999@s.whatsapp.net
    """
    raw = safe_str(jid)
    if not raw:
        return ""

    raw = _JID_DEVICE_RE.sub("", raw)
    raw = _JID_AGENT_RE.sub("", raw)
    return raw.strip()


def _jid_strip_device(jid: str | None) -> str:
    return jid_strip_device(jid)


def is_lid_jid(jid: str | None) -> bool:
    raw = jid_strip_device(jid)
    return raw.endswith("@lid")


def _is_lid_jid(jid: str | None) -> bool:
    return is_lid_jid(jid)


def is_group_jid(jid: str | None) -> bool:
    raw = jid_strip_device(jid)
    return raw.endswith("@g.us")


def _is_group_jid(jid: str | None) -> bool:
    return is_group_jid(jid)


def is_user_jid(jid: str | None) -> bool:
    raw = jid_strip_device(jid)
    return raw.endswith("@s.whatsapp.net")


def normalize_jid(jid: str | None) -> str:
    return jid_strip_device(jid)


def jid_user_part(jid: str | None) -> str:
    raw = jid_strip_device(jid)
    if "@" not in raw:
        return raw
    return raw.split("@", 1)[0].strip()


def jid_server_part(jid: str | None) -> str:
    raw = jid_strip_device(jid)
    if "@" not in raw:
        return ""
    return raw.split("@", 1)[1].strip()


def same_jid(a: str | None, b: str | None) -> bool:
    return jid_strip_device(a) == jid_strip_device(b)


def build_user_jid(phone_digits: str | None) -> str:
    raw = re.sub(r"\D+", "", safe_str(phone_digits))
    return f"{raw}@s.whatsapp.net" if raw else ""


def build_group_jid(group_digits: str | None) -> str:
    raw = re.sub(r"\D+", "", safe_str(group_digits))
    return f"{raw}@g.us" if raw else ""


__all__ = [
    "safe_str",
    "jid_strip_device",
    "_jid_strip_device",
    "is_lid_jid",
    "_is_lid_jid",
    "is_group_jid",
    "_is_group_jid",
    "is_user_jid",
    "normalize_jid",
    "jid_user_part",
    "jid_server_part",
    "same_jid",
    "build_user_jid",
    "build_group_jid",
]