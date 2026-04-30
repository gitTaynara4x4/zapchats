#backend\routers\atendimento_conversas\router.py
from __future__ import annotations

from fastapi import APIRouter

from .listagem import router as listagem_router
from .meta import router as meta_router
from .acoes import router as acoes_router

router = APIRouter()

router.include_router(listagem_router)
router.include_router(meta_router)
router.include_router(acoes_router)