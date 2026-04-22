# backend/integrations/evolution/utils/phone_utils.py

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Iterable

from .jid_utils import jid_strip_device, is_group_jid, is_lid_jid


BRAZIL_CC = "55"


def only_digits(v: Any) -> str:
    return re.sub(r"\D+", "", str(v or ""))


def _uniq_keep_order(items: Iterable[str | None]) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()

    for item in items:
        s = str(item or "").strip()
        if not s:
            continue
        if s in seen:
            continue
        seen.add(s)
        out.append(s)

    return out


def _strip_country_code_br(digits: str) -> str:
    d = only_digits(digits)
    if d.startswith(BRAZIL_CC) and len(d) >= 12:
        return d[2:]
    return d


def _split_br_parts(digits: str) -> tuple[str, str]:
    """
    Retorna (ddd, local)
    Ex:
      31986419237 -> ('31', '986419237')
      3186419237  -> ('31', '86419237')
    """
    d = _strip_country_code_br(digits)
    if len(d) < 10:
        return "", d
    return d[:2], d[2:]


def _with_mobile_nine_br(digits: str) -> str:
    """
    Se vier BR com 10 dígitos (DDD + 8), assume celular faltando 9.
    """
    d = _strip_country_code_br(digits)
    if len(d) == 10:
        ddd = d[:2]
        local = d[2:]
        return f"{ddd}9{local}"
    return d


def _without_mobile_nine_br(digits: str) -> str:
    """
    Se vier BR com 11 dígitos (DDD + 9 + 8), remove o 9.
    """
    d = _strip_country_code_br(digits)
    if len(d) == 11 and d[2] == "9":
        ddd = d[:2]
        local = d[3:]
        return f"{ddd}{local}"
    return d


@dataclass(frozen=True)
class PhoneIdentity:
    raw: str
    digits: str
    remote_jid: str | None
    is_group: bool
    is_lid: bool

    # canônico para banco
    db_norm: str | None

    # canônico para envio (Evolution)
    send_e164: str | None

    # variantes aceitáveis para lookup
    variants: tuple[str, ...]

    @property
    def lookup_variants(self) -> tuple[str, ...]:
        return self.variants


def build_phone_identity(
    phone: Any | None = None,
    *,
    remote_jid: str | None = None,
    resolved_remote_jid: str | None = None,
) -> PhoneIdentity:
    """
    Regras:
    - grupo => não vira telefone de cliente 1:1
    - lid => não é telefone real; só entra como remote, não como base final
    - db_norm => BR sem 55 e preferindo 9 quando aplicável
    - send_e164 => BR com 55 e preferindo 9 quando aplicável
    - variants => com/sem 55, com/sem 9, sempre priorizando formatos fortes
    """
    best_remote = (
        str(resolved_remote_jid or "").strip()
        or str(remote_jid or "").strip()
        or None
    )

    cleaned_remote = jid_strip_device(best_remote) if best_remote else None
    is_group = bool(cleaned_remote and is_group_jid(cleaned_remote))
    is_lid = bool(cleaned_remote and is_lid_jid(cleaned_remote))

    raw_source = ""

    if cleaned_remote and not is_group and not is_lid:
        if "@" in cleaned_remote:
            raw_source = cleaned_remote.split("@", 1)[0]
        else:
            raw_source = cleaned_remote
    elif phone is not None:
        raw_source = str(phone)

    digits = only_digits(raw_source)

    if not digits:
        return PhoneIdentity(
            raw=str(phone or remote_jid or resolved_remote_jid or ""),
            digits="",
            remote_jid=cleaned_remote,
            is_group=is_group,
            is_lid=is_lid,
            db_norm=None,
            send_e164=None,
            variants=tuple(),
        )

    if is_group:
        return PhoneIdentity(
            raw=str(phone or remote_jid or resolved_remote_jid or ""),
            digits=digits,
            remote_jid=cleaned_remote,
            is_group=True,
            is_lid=is_lid,
            db_norm=None,
            send_e164=None,
            variants=tuple(_uniq_keep_order([digits])),
        )

    national = _strip_country_code_br(digits)
    national_with_9 = _with_mobile_nine_br(national)
    national_without_9 = _without_mobile_nine_br(national)

    variants = _uniq_keep_order([
        digits,
        national,
        national_with_9,
        national_without_9,
        f"{BRAZIL_CC}{national}",
        f"{BRAZIL_CC}{national_with_9}",
        f"{BRAZIL_CC}{national_without_9}",
    ])

    # canônico do banco
    if len(national) == 11:
        db_norm = national
    elif len(national) == 10:
        db_norm = national_with_9
    else:
        db_norm = national or digits

    # canônico do envio
    if db_norm and len(db_norm) in (10, 11):
        send_e164 = f"{BRAZIL_CC}{db_norm}"
    elif digits.startswith(BRAZIL_CC):
        send_e164 = digits
    else:
        send_e164 = digits

    return PhoneIdentity(
        raw=str(phone or remote_jid or resolved_remote_jid or ""),
        digits=digits,
        remote_jid=cleaned_remote,
        is_group=False,
        is_lid=is_lid,
        db_norm=db_norm,
        send_e164=send_e164,
        variants=tuple(variants),
    )


def normalize_phone_for_db(
    phone: Any | None = None,
    *,
    remote_jid: str | None = None,
    resolved_remote_jid: str | None = None,
) -> str | None:
    ident = build_phone_identity(
        phone,
        remote_jid=remote_jid,
        resolved_remote_jid=resolved_remote_jid,
    )
    return ident.db_norm


def normalize_phone_for_send(
    phone: Any | None = None,
    *,
    remote_jid: str | None = None,
    resolved_remote_jid: str | None = None,
) -> str | None:
    ident = build_phone_identity(
        phone,
        remote_jid=remote_jid,
        resolved_remote_jid=resolved_remote_jid,
    )
    return ident.send_e164


def phone_lookup_variants(
    phone: Any | None = None,
    *,
    remote_jid: str | None = None,
    resolved_remote_jid: str | None = None,
) -> tuple[str, ...]:
    ident = build_phone_identity(
        phone,
        remote_jid=remote_jid,
        resolved_remote_jid=resolved_remote_jid,
    )
    return ident.lookup_variants


def normalize_phone_br(phone: Any) -> str:
    """
    Compat antigo:
    agora devolve formato canônico de banco.
    Ex.: 553186419237 -> 31986419237
    """
    return normalize_phone_for_db(phone) or ""


def remote_to_num(remote_jid: str | None) -> str | None:
    """
    Compat antigo:
    agora devolve formato canônico de banco.
    Ex.: 553186419237@s.whatsapp.net -> 31986419237
    """
    raw = jid_strip_device(remote_jid)
    if not raw:
        return None

    if is_group_jid(raw):
        return None

    if is_lid_jid(raw):
        return None

    return normalize_phone_for_db(remote_jid=raw)


def _remote_to_num(remote_jid: str | None) -> str | None:
    return remote_to_num(remote_jid)


def formatar_telefone_br(phone: str | None) -> str:
    d = only_digits(phone)

    if not d:
        return ""

    if d.startswith("55") and len(d) >= 12:
        cc = d[:2]
        d = d[2:]
    else:
        cc = ""

    if len(d) == 11:
        return f"+{cc} ({d[:2]}) {d[2:7]}-{d[7:]}" if cc else f"({d[:2]}) {d[2:7]}-{d[7:]}"
    if len(d) == 10:
        return f"+{cc} ({d[:2]}) {d[2:6]}-{d[6:]}" if cc else f"({d[:2]}) {d[2:6]}-{d[6:]}"
    if cc:
        return f"+{cc} {d}"
    return d


def _resolve_counterparty_num_1to1(
    message_item: dict,
    me_number: str | None = None,
) -> tuple[str | None, str | None]:
    """
    Tenta descobrir o telefone real de mensagem 1:1 quando o remoteJid vier em @lid.
    Retorna: (telefone_db_norm, alt_jid_ou_none)
    """
    m = message_item if isinstance(message_item, dict) else {}
    key = m.get("key") if isinstance(m.get("key"), dict) else {}

    candidates = [
        key.get("remoteJidAlt"),
        key.get("remote_jid_alt"),
        m.get("remoteJidAlt"),
        m.get("remote_jid_alt"),
        m.get("participant"),
        m.get("participantJid"),
        m.get("sender"),
        m.get("senderJid"),
        m.get("chatId"),
        m.get("jid"),
        m.get("remoteJid"),
        key.get("remoteJid"),
    ]

    me_norm = normalize_phone_for_db(me_number) if me_number else None

    for cand in candidates:
        if not cand:
            continue

        cand_str = jid_strip_device(str(cand))
        if not cand_str or is_group_jid(cand_str) or is_lid_jid(cand_str):
            continue

        ident = build_phone_identity(remote_jid=cand_str)
        if ident.db_norm and ident.db_norm != me_norm:
            return ident.db_norm, cand_str

    deep_candidates = [
        m.get("from"),
        m.get("to"),
        m.get("author"),
        m.get("authorJid"),
        m.get("user"),
        m.get("owner"),
    ]

    for cand in deep_candidates:
        if not cand:
            continue

        cand_str = jid_strip_device(str(cand))
        if not cand_str or is_group_jid(cand_str) or is_lid_jid(cand_str):
            continue

        ident = build_phone_identity(remote_jid=cand_str)
        if ident.db_norm and ident.db_norm != me_norm:
            return ident.db_norm, cand_str

    return None, None


def guess_phone_from_text(v: Any) -> str | None:
    return normalize_phone_for_db(v)


__all__ = [
    "PhoneIdentity",
    "only_digits",
    "build_phone_identity",
    "normalize_phone_br",
    "normalize_phone_for_db",
    "normalize_phone_for_send",
    "phone_lookup_variants",
    "remote_to_num",
    "_remote_to_num",
    "formatar_telefone_br",
    "_resolve_counterparty_num_1to1",
    "guess_phone_from_text",
]