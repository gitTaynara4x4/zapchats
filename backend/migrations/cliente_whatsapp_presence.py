"""Compatibilidade: presença de contatos do WhatsApp foi desativada."""

from __future__ import annotations

from sqlalchemy.engine import Engine


def ensure_cliente_whatsapp_presence(engine: Engine, log=print) -> None:
    """Não cria campos de presença; recurso desativado no ZapsChat."""
    return None


__all__ = ["ensure_cliente_whatsapp_presence"]
