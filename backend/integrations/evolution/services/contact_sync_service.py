#backend\integrations\evolution\services\contact_sync_service.py

from __future__ import annotations
import asyncio
from backend import models
from backend.database import SessionLocal
from backend.websocket_manager import conexoes_ativas

from ..parsers.chat_parser import parse_chats_payload
from ..parsers.contact_parser import parse_contacts_payload, filter_real_contacts
from ..repositories.clientes_repo import upsert_cliente_repo
from ..repositories.grupos_repo import upsert_grupos_from_chats
from ..repositories.instancias_repo import (
    get_instancia_by_name,
    get_me_number_by_instancia,
)
from ..transport.evolution_http_client import EvolutionHttpClient
from ..transport.rabbit_consumer import record_rabbit_event
from ..utils.log_utils import LOG
from ..utils.time_utils import _server_ts_ms
from ..utils.cache_utils import invalidate_emp_cache


async def process_contacts_event(first: str, payload: dict | list):
    if isinstance(payload, list):
        norm = {"data": payload, "instance": first}
    elif isinstance(payload, dict):
        norm = payload if "data" in payload else {"data": payload, "instance": first}
    else:
        norm = {"data": [payload], "instance": first}

    inst_id = str(norm.get("instance") or first or "").strip()
    record_rabbit_event("CONTACTS_UPDATE", instance=inst_id)

    contatos = filter_real_contacts(
        parse_contacts_payload(
            norm.get("data"),
            inst_name=inst_id,
        )
    )
    if not contatos:
        return

    with SessionLocal() as db:
        inst = get_instancia_by_name(db, instance_name=inst_id)
        if not inst:
            return

        empresa_id = int(inst.empresa_id)
        me_num = get_me_number_by_instancia(inst)
        mudou = False
        processed = 0

        for c in contatos:
            if not isinstance(c, dict):
                continue

            numero = c.get("telefone")
            if not numero or (me_num and numero == me_num):
                continue

            try:
                cli_id = upsert_cliente_repo(
                    db,
                    empresa_id=empresa_id,
                    instancia_id=inst.id,
                    telefone_raw=numero,
                    nome=c.get("nome_default"),
                    nome_whatsapp=c.get("nome"),
                    avatar_url=c.get("avatar_url"),
                )
                if cli_id:
                    mudou = True
            except Exception as e:
                try:
                    db.rollback()
                except Exception:
                    pass
                LOG(f"[CONTACTS] erro no upsert_cliente: {e}")
                continue

            processed += 1
            if (processed % 500) == 0:
                await asyncio.sleep(0)

        if mudou:
            try:
                db.commit()
            except Exception as e:
                try:
                    db.rollback()
                except Exception:
                    pass
                LOG(f"[CONTACTS] erro no commit: {e}")
                return

            await conexoes_ativas.send_message(
                f"emp:{empresa_id}",
                {"type": "reload_clientes", "serverTimestamp": _server_ts_ms()},
            )
            try:
                invalidate_emp_cache(empresa_id)
            except Exception:
                pass


async def sync_contatos_completos(inst_id: str):
    with SessionLocal() as db:
        inst = get_instancia_by_name(db, instance_name=inst_id)
        if not inst:
            return

        empresa_id = int(inst.empresa_id)
        me_num = get_me_number_by_instancia(inst)
        client = EvolutionHttpClient()

        try:
            js = client.find_contacts(inst_id)
            contatos = filter_real_contacts(
                parse_contacts_payload(
                    js,
                    inst_name=inst_id,
                    empresa_id=empresa_id,
                    instancia_id=inst.id,
                    me_number=me_num,
                )
            )
        except Exception as e:
            LOG(f"[CONTACTS] erro ao buscar: {e}")
            return

        total = len(contatos)
        imported = 0
        mudou = False

        await conexoes_ativas.send_message(
            f"emp:{empresa_id}",
            {"type": "contacts_sync_start", "total": total, "serverTimestamp": _server_ts_ms()},
        )

        for idx, c in enumerate(contatos, start=1):
            numero = c.get("telefone")
            if not numero or (me_num and numero == me_num):
                continue

            cli_id = upsert_cliente_repo(
                db,
                empresa_id=empresa_id,
                instancia_id=inst.id,
                telefone_raw=numero,
                nome=c.get("nome_default"),
                nome_whatsapp=c.get("nome"),
                avatar_url=c.get("avatar_url"),
            )
            if cli_id:
                imported += 1
                mudou = True

            if idx % 25 == 0:
                await conexoes_ativas.send_message(
                    f"emp:{empresa_id}",
                    {
                        "type": "contacts_sync_progress",
                        "total": total,
                        "imported": imported,
                        "serverTimestamp": _server_ts_ms(),
                    },
                )

        if mudou:
            db.commit()

        await conexoes_ativas.send_message(
            f"emp:{empresa_id}",
            {"type": "contacts_sync_done", "total": total, "imported": imported, "serverTimestamp": _server_ts_ms()},
        )
        await conexoes_ativas.send_message(
            f"emp:{empresa_id}", {"type": "reload_clientes", "serverTimestamp": _server_ts_ms()}
        )

        try:
            invalidate_emp_cache(empresa_id)
        except Exception:
            pass


async def sync_chats_completos(inst_id: str):
    with SessionLocal() as db:
        inst = get_instancia_by_name(db, instance_name=inst_id)
        if not inst:
            return

        empresa_id = int(inst.empresa_id)
        client = EvolutionHttpClient()

        try:
            js = client.find_chats(inst_id)
            chats = parse_chats_payload(
                js,
                inst_name=inst_id,
                empresa_id=empresa_id,
                instancia_id=inst.id,
            )
        except Exception as e:
            LOG(f"[CHATS] erro ao buscar: {e}")
            return

        if not chats:
            return

        before = db.query(models.Grupo).filter(models.Grupo.empresa_id == empresa_id).count()
        upsert_grupos_from_chats(db, empresa_id=empresa_id, chats=[c["raw"] for c in chats], inst=inst)
        db.commit()
        after = db.query(models.Grupo).filter(models.Grupo.empresa_id == empresa_id).count()

        if after != before:
            await conexoes_ativas.send_message(
                f"emp:{empresa_id}",
                {"type": "reload_grupos", "total": after, "serverTimestamp": _server_ts_ms()},
            )

        try:
            invalidate_emp_cache(empresa_id)
        except Exception:
            pass


__all__ = [
    "process_contacts_event",
    "sync_contatos_completos",
    "sync_chats_completos",
]
