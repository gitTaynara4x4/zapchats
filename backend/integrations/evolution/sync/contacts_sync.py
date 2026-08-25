#backend\integrations\evolution\sync\contacts_sync.py


from __future__ import annotations
import asyncio
from typing import Any
from sqlalchemy.orm import Session
from backend.database import SessionLocal
from backend import models
from ..repositories.clientes_repo import upsert_cliente_repo
from ..parsers.contact_parser import extract_contacts_any_shape
from ..transport.evolution_http_client import evo_find_contacts
from ..transport.websocket_emitters import (
    emit_contacts_sync_done,
    emit_contacts_sync_progress,
    emit_contacts_sync_start,
    emit_reload_clientes,
)
from ..services.contact_sync_service import (
    process_contacts_event,
    sync_contatos_completos,
    sync_chats_completos,
)

try:
    from ..utils.jid_utils import _jid_strip_device, _is_lid_jid
except Exception:  # pragma: no cover
    from ..utils.jid_utils import jid_strip_device as _jid_strip_device, is_lid_jid as _is_lid_jid

try:
    from ..utils.log_utils import LOG, _log_ctx
except Exception:  # pragma: no cover
    from ..utils.log_utils import LOG

    def _log_ctx(*args, **kwargs):
        return None

try:
    from ..utils.phone_utils import _remote_to_num, formatar_telefone_br
except Exception:  # pragma: no cover
    from ..utils.phone_utils import remote_to_num as _remote_to_num, formatar_telefone_br


def _get_inst_row(db: Session, inst_name: str) -> models.EmpresaInstancia | None:
    return (
        db.query(models.EmpresaInstancia)
        .filter(models.EmpresaInstancia.instance_name == inst_name)
        .first()
    )


def _me_number_by_inst(inst: models.EmpresaInstancia | None) -> str | None:
    if not inst:
        return None
    raw = getattr(inst, "numero_instancia", None)
    if not raw:
        return None
    return "".join(ch for ch in str(raw) if ch.isdigit()) or None


def _pick_contact_name(c: dict[str, Any]) -> str | None:
    for key in (
        "verifiedName",
        "name",
        "pushName",
        "notifyName",
        "formattedName",
        "shortName",
        "contactName",
        "displayName",
    ):
        val = c.get(key)
        if isinstance(val, str) and val.strip():
            return val.strip()
    return None


def _pick_contact_avatar(c: dict[str, Any]) -> str | None:
    return (
        c.get("profilePicUrl")
        or (c.get("profilePicThumbObj") or {}).get("eurl")
        or c.get("thumbnailUrl")
        or c.get("imageUrl")
        or c.get("pictureUrl")
        or None
    )


def _resolve_remote_from_contact(c: dict[str, Any]) -> str:
    raw = (
        c.get("remoteJid")
        or c.get("jid")
        or c.get("id")
        or c.get("wid")
        or c.get("remote_jid")
        or ""
    )
    return _jid_strip_device(raw)


def _upsert_cliente_local(
    db: Session,
    *,
    empresa_id: int,
    instancia_id: int,
    telefone: str,
    nome: str | None,
    nome_whatsapp: str | None,
    avatar_url: str | None,
    self_profile_name: str | None = None,
) -> int | None:
    return upsert_cliente_repo(
        db,
        empresa_id=int(empresa_id),
        instancia_id=int(instancia_id),
        telefone_raw=telefone,
        nome=nome,
        nome_whatsapp=nome_whatsapp,
        avatar_url=avatar_url,
        self_profile_name=self_profile_name,
        allow_self_name_repair=bool(nome_whatsapp),
    )


async def sync_contacts_full(inst_name: str) -> int:
    """
    Sincronização pesada de contatos via endpoint full da Evolution.
    """
    with SessionLocal() as db:
        inst = _get_inst_row(db, inst_name)
        if not inst:
            LOG(f"[CONTACTS_SYNC] instância não encontrada: {inst_name}")
            return 0

        empresa_id = int(inst.empresa_id)
        me_num = _me_number_by_inst(inst)

    try:
        raw = await asyncio.to_thread(evo_find_contacts, inst_name)
        contatos = extract_contacts_any_shape(raw)
    except Exception as e:
        LOG(f"[CONTACTS_SYNC] erro buscando contatos: {e}")
        return 0

    total = len(contatos)
    imported = 0

    await emit_contacts_sync_start(empresa_id, total=total)

    if not contatos:
        await emit_contacts_sync_done(empresa_id, total=0, imported=0)
        return 0

    with SessionLocal() as db:
        inst = _get_inst_row(db, inst_name)
        if not inst:
            await emit_contacts_sync_done(empresa_id, total=total, imported=0)
            return 0

        for idx, c in enumerate(contatos, start=1):
            try:
                if not isinstance(c, dict):
                    continue

                remote = _resolve_remote_from_contact(c)
                if not remote:
                    continue

                if _is_lid_jid(remote):
                    continue

                telefone = _remote_to_num(remote)
                if not telefone:
                    continue

                if me_num and telefone == me_num:
                    continue

                nome_push = _pick_contact_name(c)
                avatar = _pick_contact_avatar(c)

                cli_id = _upsert_cliente_local(
                    db,
                    empresa_id=empresa_id,
                    instancia_id=int(inst.id),
                    telefone=telefone,
                    nome=(nome_push or formatar_telefone_br(telefone)),
                    nome_whatsapp=nome_push,
                    avatar_url=avatar,
                    self_profile_name=getattr(inst, "perfil_nome_whatsapp", None),
                )
                if cli_id:
                    imported += 1

                if idx % 25 == 0:
                    try:
                        db.commit()
                    except Exception:
                        db.rollback()

                    await emit_contacts_sync_progress(
                        empresa_id,
                        total=total,
                        imported=imported,
                    )

            except Exception as e:
                db.rollback()
                _log_ctx("[CONTACTS_SYNC][erro_item]", idx=idx, err=str(e))
                continue

        try:
            db.commit()
        except Exception:
            db.rollback()

    await emit_contacts_sync_done(empresa_id, total=total, imported=imported)
    await emit_reload_clientes(empresa_id)

    LOG(f"[CONTACTS_SYNC] inst={inst_name} total={total} imported={imported}")
    return imported


__all__ = [
    "process_contacts_event",
    "sync_contatos_completos",
    "sync_chats_completos",
    "sync_contacts_full",
]