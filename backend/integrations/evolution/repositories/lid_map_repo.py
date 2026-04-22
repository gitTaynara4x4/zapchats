# backend/integrations/evolution/repositories/lid_map_repo.py
from __future__ import annotations

from ..utils.jid_utils import jid_strip_device

_LID_MAP: dict[tuple[int, int, str], str] = {}


def normalize_lid_or_jid(raw: str | None) -> str:
    return jid_strip_device(str(raw or "").strip())


def get_lid_mapping(
    *,
    empresa_id: int,
    instancia_id: int,
    lid_jid: str,
) -> str | None:
    lid_norm = normalize_lid_or_jid(lid_jid)
    if not lid_norm:
        return None
    return _LID_MAP.get((int(empresa_id), int(instancia_id), lid_norm))


def set_lid_mapping(
    *,
    empresa_id: int,
    instancia_id: int,
    lid_jid: str,
    real_jid: str,
) -> bool:
    lid_norm = normalize_lid_or_jid(lid_jid)
    real_norm = normalize_lid_or_jid(real_jid)

    if not lid_norm or not real_norm:
        return False

    _LID_MAP[(int(empresa_id), int(instancia_id), lid_norm)] = real_norm
    return True


def resolve_lid_or_fallback(
    *,
    empresa_id: int,
    instancia_id: int,
    lid_jid: str,
    fallback_jid: str | None = None,
) -> str | None:
    mapped = get_lid_mapping(
        empresa_id=empresa_id,
        instancia_id=instancia_id,
        lid_jid=lid_jid,
    )
    if mapped:
        return mapped

    if fallback_jid:
        fb = normalize_lid_or_jid(fallback_jid)
        return fb or None

    return None


__all__ = [
    "normalize_lid_or_jid",
    "get_lid_mapping",
    "set_lid_mapping",
    "resolve_lid_or_fallback",
]