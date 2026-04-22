#backend\integrations\evolution\sync\chats_sync.py


from __future__ import annotations
import asyncio
import os
from typing import Any
from sqlalchemy.orm import Session
from backend.database import SessionLocal
from backend import models
from ..parsers.chat_parser import extract_chats_any_shape
from ..transport.evolution_http_client import evo_find_chats, evo_get_group_subject
from ..transport.websocket_emitters import emit_reload_grupos

try:
    from ..utils.jid_utils import _jid_strip_device
except Exception:  # pragma: no cover
    from ..utils.jid_utils import jid_strip_device as _jid_strip_device

try:
    from ..utils.log_utils import LOG, _log_ctx
except Exception:  # pragma: no cover
    from ..utils.log_utils import LOG

    def _log_ctx(*args, **kwargs):
        return None


GROUP_SUBJECT_REFRESH = os.getenv("GROUP_SUBJECT_REFRESH", "true").lower() == "true"


def _get_inst_row(db: Session, inst_name: str) -> models.EmpresaInstancia | None:
    return (
        db.query(models.EmpresaInstancia)
        .filter(models.EmpresaInstancia.instance_name == inst_name)
        .first()
    )


def _pick_group_name(c: dict[str, Any]) -> str | None:
    for key in (
        "subject",
        "name",
        "pushName",
        "notifyName",
        "formattedName",
        "title",
        "displayName",
    ):
        val = c.get(key)
        if isinstance(val, str) and val.strip():
            return val.strip()
    return None


def _pick_group_avatar(c: dict[str, Any]) -> str | None:
    return (
        c.get("profilePicUrl")
        or (c.get("profilePicThumbObj") or {}).get("eurl")
        or c.get("thumbnailUrl")
        or c.get("imageUrl")
        or c.get("pictureUrl")
        or None
    )


def _resolve_group_jid(c: dict[str, Any]) -> str:
    raw = (
        c.get("id")
        or c.get("remoteJid")
        or c.get("jid")
        or c.get("wid")
        or ""
    )
    raw = _jid_strip_device(raw)
    return raw if raw.endswith("@g.us") else ""


def _upsert_group_local(
    db: Session,
    *,
    empresa_id: int,
    instancia_id: int,
    instance_name: str,
    remote_jid: str,
    nome: str,
    avatar_url: str | None,
) -> int | None:
    grp = (
        db.query(models.Grupo)
        .filter(
            models.Grupo.empresa_id == int(empresa_id),
            models.Grupo.remote_jid == str(remote_jid),
        )
        .first()
    )

    if not grp:
        grp = models.Grupo(
            empresa_id=int(empresa_id),
            remote_jid=str(remote_jid),
            nome=str(nome or "Grupo"),
            avatar_url=avatar_url,
            instancia_id=int(instancia_id),
        )
        if hasattr(grp, "instance_name"):
            setattr(grp, "instance_name", instance_name)
        db.add(grp)
        db.flush()
        return int(grp.id)

    changed = False

    if getattr(grp, "instancia_id", None) is None:
        grp.instancia_id = int(instancia_id)
        changed = True

    if hasattr(grp, "instance_name") and not getattr(grp, "instance_name", None):
        setattr(grp, "instance_name", instance_name)
        changed = True

    if nome and getattr(grp, "nome", None) != nome:
        grp.nome = nome
        changed = True

    if avatar_url and getattr(grp, "avatar_url", None) != avatar_url:
        grp.avatar_url = avatar_url
        changed = True

    if changed:
        db.flush()

    return int(grp.id)


async def sync_chats_full(inst_name: str) -> int:
    """
    Sincronização pesada de chats/grupos da Evolution.
    """
    with SessionLocal() as db:
        inst = _get_inst_row(db, inst_name)
        if not inst:
            LOG(f"[CHATS_SYNC] instância não encontrada: {inst_name}")
            return 0
        empresa_id = int(inst.empresa_id)
        instancia_id = int(inst.id)
        instance_name = str(inst.instance_name)

    try:
        raw = await asyncio.to_thread(evo_find_chats, inst_name)
        chats = extract_chats_any_shape(raw)
    except Exception as e:
        LOG(f"[CHATS_SYNC] erro buscando chats: {e}")
        return 0

    if not chats:
        return 0

    changed = 0

    with SessionLocal() as db:
        inst = _get_inst_row(db, inst_name)
        if not inst:
            return 0

        for idx, ch in enumerate(chats, start=1):
            try:
                if not isinstance(ch, dict):
                    continue

                group_jid = _resolve_group_jid(ch)
                if not group_jid:
                    continue

                nome = _pick_group_name(ch) or "Grupo"
                avatar = _pick_group_avatar(ch)

                if GROUP_SUBJECT_REFRESH:
                    try:
                        subject = await asyncio.to_thread(evo_get_group_subject, inst_name, group_jid)
                        if subject and subject.strip():
                            nome = subject.strip()
                    except Exception:
                        pass

                gid = _upsert_group_local(
                    db,
                    empresa_id=empresa_id,
                    instancia_id=instancia_id,
                    instance_name=instance_name,
                    remote_jid=group_jid,
                    nome=nome,
                    avatar_url=avatar,
                )
                if gid:
                    changed += 1

                if idx % 25 == 0:
                    try:
                        db.commit()
                    except Exception:
                        db.rollback()

            except Exception as e:
                db.rollback()
                _log_ctx("[CHATS_SYNC][erro_item]", idx=idx, err=str(e))
                continue

        try:
            db.commit()
        except Exception:
            db.rollback()

    if changed:
        await emit_reload_grupos(empresa_id, total=changed)

    LOG(f"[CHATS_SYNC] inst={inst_name} changed={changed}")
    return changed


__all__ = [
    "sync_chats_full",
]