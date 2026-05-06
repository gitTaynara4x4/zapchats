# backend/security/deps.py
from __future__ import annotations

from typing import Any

from fastapi import Depends

from backend.routers.auth import (
    get_current_user as _auth_get_current_user,
    get_current_identity as _auth_get_current_identity,
)


def get_current_user(
    current_user: Any = Depends(_auth_get_current_user),
) -> Any:
    """
    Compatibilidade para módulos antigos que importam:
        from backend.security.deps import get_current_user

    Este arquivo NÃO deve criar outro JWT_SECRET.
    Ele reaproveita o auth oficial do projeto.
    """
    return current_user


def get_current_identity(
    identity: dict = Depends(_auth_get_current_identity),
) -> dict:
    """
    Compatibilidade para módulos que precisam da identidade decodificada.
    """
    return identity


__all__ = [
    "get_current_user",
    "get_current_identity",
]