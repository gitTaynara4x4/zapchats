# backend/integrations/evolution/handlers/__init__.py
from __future__ import annotations

import os

from .shared import HANDLERS, EvoEvent, handler

# importa módulos para registrar decorators/handlers
from . import qrcode  # noqa: F401
from . import connection  # noqa: F401
from . import messages_upsert  # noqa: F401
from . import messages_update  # noqa: F401
# Quando o histórico pertence ao n8n, o backend não registra handler local
# para MESSAGES_SET. Isso impede processamento acidental via Rabbit/WebSocket.
_HISTORY_OWNER = (os.getenv("EVOLUTION_HISTORY_OWNER") or "n8n").strip().lower()
if _HISTORY_OWNER not in {"n8n", "external", "webhook"}:
    from . import messages_set  # noqa: F401
from . import messages_delete  # noqa: F401
from . import contacts  # noqa: F401
from . import presence  # noqa: F401

from .qrcode import force_qr_for_instance

__all__ = [
    "HANDLERS",
    "EvoEvent",
    "handler",
    "force_qr_for_instance",
]
