#backend\routers\atendimento_conversas\schemas.py
from __future__ import annotations

from typing import Optional

from pydantic import BaseModel


class AceitarConversaIn(BaseModel):
    empresa_id: Optional[int] = None
    instancia_id: Optional[int] = None
    instance: Optional[str] = None


class LiberarConversaIn(BaseModel):
    empresa_id: Optional[int] = None
    instancia_id: Optional[int] = None
    instance: Optional[str] = None


class TransferirColaboradorIn(BaseModel):
    empresa_id: Optional[int] = None
    instancia_id: Optional[int] = None
    instance: Optional[str] = None
    colaborador_id: int


class EditarNomeClienteIn(BaseModel):
    empresa_id: Optional[int] = None
    instancia_id: Optional[int] = None
    instance: Optional[str] = None
    nome: str
