# backend/integrations/evo_handlers.py
from __future__ import annotations

"""
Camada de compatibilidade.

Este arquivo existe para não quebrar imports antigos como:
    from backend.integrations.evo_handlers import HANDLERS, EvoEvent

Toda a lógica real da Evolution agora mora em:
    backend.integrations.evolution/
"""

# ============================================================
# Registro principal de handlers
# ============================================================
from backend.integrations.evolution.handlers.shared import (
    EvoEvent,
    HANDLERS,
    handler,
)

# importa o init para garantir que todos os handlers sejam registrados
import backend.integrations.evolution.handlers as _handlers_init  # noqa: F401

# ============================================================
# APIs públicas reutilizadas em outros pontos do sistema
# ============================================================
from backend.integrations.evolution.handlers.qrcode import (
    force_qr_for_instance,
)

from backend.integrations.evolution.parsers.media_parser import (
    normalize_mimetype,
)

from backend.integrations.evolution.transport.rabbit_consumer import (
    RABBIT_MONITOR,
    record_rabbit_event,
    get_rabbit_monitor,
)


__all__ = [
    "HANDLERS",
    "EvoEvent",
    "handler",
    "force_qr_for_instance",
    "normalize_mimetype",
    "RABBIT_MONITOR",
    "record_rabbit_event",
    "get_rabbit_monitor",
]