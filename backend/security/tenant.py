# /backend/security/tenant.py

from __future__ import annotations

from typing import Any, Optional

from fastapi import Depends, HTTPException, status
from sqlalchemy.orm import Session

from backend.database import get_db
from backend.routers.auth import get_current_user
from backend import models


def _get_attr(obj: Any, *names: str) -> Any:
    for name in names:
        try:
            value = getattr(obj, name, None)
            if value is not None:
                return value
        except Exception:
            pass

        try:
            if isinstance(obj, dict) and obj.get(name) is not None:
                return obj.get(name)
        except Exception:
            pass

    return None


def current_user_id(current_user: Any = Depends(get_current_user)) -> int:
    user_id = _get_attr(current_user, "id", "usuario_id", "sub")
    try:
        return int(user_id)
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Usuário inválido.",
        )


def current_empresa_id(current_user: Any = Depends(get_current_user)) -> int:
    """
    Fonte única e segura da empresa logada.

    Regra:
    - Nunca confiar em empresa_id vindo do frontend.
    - Sempre resolver a empresa pelo usuário autenticado/token.
    """
    empresa_id = _get_attr(
        current_user,
        "empresa_id",
        "empresaId",
        "empresaID",
    )

    try:
        empresa_id = int(empresa_id)
    except Exception:
        empresa_id = 0

    if not empresa_id:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Empresa não encontrada na sessão.",
        )

    return empresa_id


def require_same_empresa(resource_empresa_id: Any, empresa_id: int) -> None:
    try:
        rid = int(resource_empresa_id)
        eid = int(empresa_id)
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Acesso negado.",
        )

    if rid != eid:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Acesso negado.",
        )


def require_cliente_empresa(
    cliente_id: int,
    db: Session,
    empresa_id: int,
) -> models.Cliente:
    cliente = (
        db.query(models.Cliente)
        .filter(
            models.Cliente.id == int(cliente_id),
            models.Cliente.empresa_id == int(empresa_id),
        )
        .first()
    )

    if not cliente:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Cliente não encontrado.",
        )

    return cliente


def require_instancia_empresa(
    instancia_id: int,
    db: Session,
    empresa_id: int,
) -> models.EmpresaInstancia:
    instancia = (
        db.query(models.EmpresaInstancia)
        .filter(
            models.EmpresaInstancia.id == int(instancia_id),
            models.EmpresaInstancia.empresa_id == int(empresa_id),
        )
        .first()
    )

    if not instancia:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Instância não encontrada.",
        )

    return instancia


def require_colaborador_empresa(
    colaborador_id: int,
    db: Session,
    empresa_id: int,
) -> models.Colaborador:
    colaborador = (
        db.query(models.Colaborador)
        .filter(
            models.Colaborador.id == int(colaborador_id),
            models.Colaborador.empresa_id == int(empresa_id),
        )
        .first()
    )

    if not colaborador:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Colaborador não encontrado.",
        )

    return colaborador


def secure_db(db: Session = Depends(get_db)) -> Session:
    return db