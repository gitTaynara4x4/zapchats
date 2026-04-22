#backend\integrations\evolution\sync\group_sync.py


from __future__ import annotations
import asyncio
import time

from sqlalchemy.orm import Session

from backend import models

from ..parsers.base_extractors import extract_media_meta, extract_text_from_baileys
from ..repositories.clientes_repo import get_cliente_id_by_phone, upsert_cliente_repo
from ..repositories.grupos_repo import (
    get_or_create_grupo_by_remote,
    insert_group_message,
    upsert_grupos_from_chats as repo_upsert_grupos_from_chats,
)
from ..transport.evolution_http_client import EvolutionHttpClient
from ..utils.log_utils import LOG, _log_ctx, _short

try:
    from ..utils.ack_utils import _ack_from_status
except Exception:  # pragma: no cover
    from ..utils.ack_utils import ack_from_status as _ack_from_status

try:
    from ..utils.jid_utils import _jid_strip_device
except Exception:  # pragma: no cover
    from ..utils.jid_utils import jid_strip_device as _jid_strip_device

try:
    from ..utils.phone_utils import _remote_to_num, formatar_telefone_br
except Exception:  # pragma: no cover
    from ..utils.phone_utils import remote_to_num as _remote_to_num, formatar_telefone_br

try:
    from ..utils.time_utils import _iso_utc, _to_dt_utc
except Exception:  # pragma: no cover
    from ..utils.time_utils import iso_utc as _iso_utc, to_dt_utc as _to_dt_utc

from .media_service import save_media_for_group_message_with_db


_GROUP_INFO_CACHE: dict[tuple[str, str], tuple[str, int]] = {}
_GROUP_INFO_TTL = 60 * 60


def _stamp_inst(obj, inst) -> None:
    if obj is None or inst is None:
        return

    if hasattr(obj, "instancia_id") and getattr(obj, "instancia_id", None) is None:
        setattr(obj, "instancia_id", getattr(inst, "id", None))

    if hasattr(obj, "instance_name") and not getattr(obj, "instance_name", None):
        setattr(obj, "instance_name", getattr(inst, "instance_name", None))


def _is_deadlock_error(e: Exception) -> bool:
    base = getattr(e, "orig", e)
    msg = str(base).lower()
    return "deadlock detected" in msg


async def _retry_deadlock(db: Session, func, *, attempts: int = 5, base_delay: float = 0.02):
    for i in range(attempts):
        try:
            return func()
        except Exception as e:
            if _is_deadlock_error(e):
                try:
                    db.rollback()
                except Exception:
                    pass
                await asyncio.sleep(base_delay * (2 ** i))
                continue
            raise


def is_bad_group_name(nome: str | None) -> bool:
    if not nome:
        return True
    n = str(nome).strip().lower()
    return n in {"", "grupo", "group", "grupo do whatsapp", "whatsapp group"}


def name_from_contact_like(c: dict) -> str | None:
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
        v = c.get(k)
        if isinstance(v, str) and v.strip():
            return v.strip()
    return None


def avatar_from_contact_like(c: dict) -> str | None:
    return (
        c.get("profilePicUrl")
        or (c.get("profilePicThumbObj") or {}).get("eurl")
        or c.get("thumbnailUrl")
        or c.get("imageUrl")
        or c.get("pictureUrl")
        or None
    )


def evo_get_group_subject(instance_name: str, group_jid: str) -> str | None:
    if not (instance_name and group_jid):
        return None

    key = (instance_name, group_jid)
    now = int(time.time())

    cached = _GROUP_INFO_CACHE.get(key)
    if cached:
        subject_cached, ts_cached = cached
        if (now - ts_cached) < _GROUP_INFO_TTL:
            return subject_cached

    try:
        subject = EvolutionHttpClient().get_group_subject(instance_name, group_jid)
        if isinstance(subject, str) and subject.strip():
            subject = subject.strip()
            _GROUP_INFO_CACHE[key] = (subject, now)
            return subject
    except Exception:
        return None

    return None


def grupo_row_by_remote(
    db: Session,
    empresa_id: int,
    remote_jid: str,
    instancia_id: int | None = None,
    inst_obj: models.EmpresaInstancia | None = None,
) -> models.Grupo:
    return get_or_create_grupo_by_remote(
        db,
        empresa_id=int(empresa_id),
        remote_jid=_jid_strip_device(remote_jid),
        instancia_id=instancia_id,
        inst_obj=inst_obj,
        nome_padrao="Grupo",
    )


def upsert_grupos_from_chats(
    db: Session,
    empresa_id: int,
    chats: list[dict],
    inst: models.EmpresaInstancia,
) -> int:
    return repo_upsert_grupos_from_chats(
        db,
        empresa_id=int(empresa_id),
        chats=chats,
        inst=inst,
    )


async def process_group_message(
    db: Session,
    *,
    inst_id: str,
    inst: models.EmpresaInstancia,
    empresa_id: int,
    payload: dict,
    idx: int,
    allow_media: bool = True,
) -> dict | None:
    key = payload.get("key") or {}
    msg_id = key.get("id") or payload.get("id")

    raw_remote = (
        key.get("remoteJid")
        or key.get("remote_jid")
        or payload.get("remoteJid")
        or payload.get("jid")
        or payload.get("chatId")
        or ""
    )

    if not raw_remote or not str(raw_remote).endswith("@g.us"):
        return None

    from_me = bool(key.get("fromMe", payload.get("fromMe", False)))
    direcao = "saida" if from_me else "entrada"
    push_name = payload.get("pushName") or payload.get("senderName")
    ts_raw = payload.get("messageTimestamp") or payload.get("timestamp") or 0

    try:
        ts_msg = _to_dt_utc(ts_raw)
    except Exception as e:
        _log_ctx("[GRUPO][ts-invalid]", idx=idx, msg_id=msg_id, err=str(e))
        return None

    if not ts_msg:
        return None

    conteudo = extract_text_from_baileys(payload)
    media_meta = extract_media_meta(payload) if allow_media else None
    ack_value = int(_ack_from_status(payload.get("status")) if from_me else 0)

    grp_remote = _jid_strip_device(str(raw_remote))
    grp = grupo_row_by_remote(
        db,
        empresa_id,
        grp_remote,
        instancia_id=getattr(inst, "id", None),
        inst_obj=inst,
    )

    try:
        if is_bad_group_name(getattr(grp, "nome", None)):
            subject = evo_get_group_subject(getattr(inst, "instance_name", inst_id), grp_remote)
            if subject and (grp.nome or "") != subject:
                grp.nome = subject
    except Exception:
        pass

    participant = (
        key.get("participant")
        or payload.get("participant")
        or payload.get("sender")
        or payload.get("participantJid")
        or ""
    )
    participant = _jid_strip_device(participant) if isinstance(participant, str) else ""

    try:
        avatar = avatar_from_contact_like(payload)
        if isinstance(avatar, str) and avatar.strip():
            if getattr(grp, "avatar_url", None) != avatar.strip():
                grp.avatar_url = avatar.strip()
        _stamp_inst(grp, inst)
    except Exception:
        pass

    cli_autor_id = None
    autor_nome = push_name or participant or None

    try:
        tel_autor = _remote_to_num(participant) if participant else None
        if tel_autor:
            cli_autor_id = get_cliente_id_by_phone(
                db,
                empresa_id=int(empresa_id),
                telefone=tel_autor,
            )

            if not cli_autor_id:
                cli_autor_id = await _retry_deadlock(
                    db,
                    lambda: upsert_cliente_repo(
                        db,
                        empresa_id=int(empresa_id),
                        instancia_id=getattr(inst, "id", None),
                        telefone_raw=tel_autor,
                        nome=(push_name or formatar_telefone_br(tel_autor)),
                        nome_whatsapp=(push_name or formatar_telefone_br(tel_autor)),
                        avatar_url=None,
                    ),
                )
    except Exception as e:
        _log_ctx("[GRUPO][autor-upsert-fail]", idx=idx, msg_id=msg_id, err=str(e))

    gm_id, inserted = insert_group_message(
        db,
        empresa_id=int(empresa_id),
        grupo_id=int(grp.id),
        instancia_id=getattr(inst, "id", None),
        author_jid=(participant or None),
        from_me=bool(from_me),
        conteudo=conteudo,
        tipo=direcao,
        message_type=payload.get("messageType"),
        lida=bool(from_me),
        timestamp_dt=ts_msg,
        msg_id=(str(msg_id) if msg_id else None),
        ack=int(ack_value or 0),
        inst_obj=inst,
    )

    if not inserted:
        _log_ctx(
            "[GRUPO][skip-duplicada]",
            idx=idx,
            msg_id=msg_id,
            grupo_id=grp.id,
            existing_id=gm_id,
        )
        return {
            "inserted": False,
            "grupo_id": grp.id,
            "grupo_nome": getattr(grp, "nome", None),
            "grupo_avatar_url": getattr(grp, "avatar_url", None),
            "mensagem_id": gm_id,
            "msg_id": str(msg_id) if msg_id else None,
            "conteudo": conteudo,
            "tipo": direcao,
            "timestamp": _iso_utc(ts_msg),
            "ack": ack_value if from_me else None,
            "author_jid": participant or None,
            "autor_nome": autor_nome,
            "autor_cliente_id": cli_autor_id,
        }

    if media_meta:
        save_media_for_group_message_with_db(
            db,
            inst_id=inst_id,
            empresa_id=int(empresa_id),
            grupo_id=int(grp.id),
            cliente_id=cli_autor_id,
            msg_id=(str(msg_id) if msg_id else None),
            media_meta=media_meta,
            instancia_id=int(inst.id),
            idx=idx,
        )

    _log_ctx(
        "[GRUPO][saved]",
        idx=idx,
        msg_id=msg_id,
        grupo_id=grp.id,
        saved_id=gm_id,
        ts=_iso_utc(ts_msg),
        preview=_short(conteudo),
    )

    return {
        "inserted": True,
        "grupo_id": grp.id,
        "grupo_nome": getattr(grp, "nome", None),
        "grupo_avatar_url": getattr(grp, "avatar_url", None),
        "mensagem_id": gm_id,
        "msg_id": str(msg_id) if msg_id else None,
        "conteudo": conteudo,
        "tipo": direcao,
        "timestamp": _iso_utc(ts_msg),
        "ack": ack_value if from_me else None,
        "author_jid": participant or None,
        "autor_nome": autor_nome,
        "autor_cliente_id": cli_autor_id,
    }


__all__ = [
    "is_bad_group_name",
    "name_from_contact_like",
    "avatar_from_contact_like",
    "evo_get_group_subject",
    "grupo_row_by_remote",
    "upsert_grupos_from_chats",
    "process_group_message",
]