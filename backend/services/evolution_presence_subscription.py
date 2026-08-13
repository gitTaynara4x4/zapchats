"""Compatibilidade para a antiga assinatura de presença da Evolution.

A presença de contatos foi desativada. As funções públicas continuam existindo
como no-op para não quebrar imports antigos, mas nenhuma chamada é enviada à
Evolution.
"""

from __future__ import annotations

from typing import Any, Iterable


def presence_subscription_enabled() -> bool:
    return False


def presence_subscription_cooldown_seconds() -> int:
    return 0


def select_presence_number(candidates: Iterable[Any]) -> str | None:
    return None


def subscribe_contact_presence(
    *,
    instance_name: str,
    number: str,
    empresa_id: int,
    cliente_id: int,
    instancia_id: int,
) -> dict[str, Any]:
    return {
        "ok": False,
        "skipped": True,
        "reason": "contact_presence_disabled",
    }


__all__ = [
    "presence_subscription_enabled",
    "presence_subscription_cooldown_seconds",
    "select_presence_number",
    "subscribe_contact_presence",
]
