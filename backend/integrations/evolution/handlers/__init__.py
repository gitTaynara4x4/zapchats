# backend/integrations/evolution/handlers/__init__.py
from __future__ import annotations

from .shared import HANDLERS, EvoEvent, handler

# importa módulos para registrar decorators/handlers
from . import qrcode  # noqa: F401
from . import connection  # noqa: F401
from . import messages_upsert  # noqa: F401
from . import messages_update  # noqa: F401
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