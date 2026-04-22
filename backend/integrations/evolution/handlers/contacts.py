# backend/integrations/evolution/handlers/contacts.py

from __future__ import annotations

from .shared import EvoEvent, handler
from ..services.contact_sync_service import (
    process_contacts_event,
    sync_contatos_completos,
    sync_chats_completos,
)


@handler(EvoEvent.CONTACTS_UPSERT)
@handler(EvoEvent.CONTACTS_UPDATE)
@handler(EvoEvent.CONTACTS_SET)
async def on_contacts_event(first: str, payload: dict | list):
    return await process_contacts_event(first, payload)


__all__ = [
    "on_contacts_event",
    "sync_contatos_completos",
    "sync_chats_completos",
]
