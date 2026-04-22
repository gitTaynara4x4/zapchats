# backend/evo_db.py
from __future__ import annotations
import os
from typing import Optional
from sqlalchemy import create_engine, text

# Exemplo de DSN – ajuste senha/host se precisar
# coloque isso no .env:
# EVOLUTION_DB_DSN=postgresql+psycopg2://postgres:SENHA@zapschat_evolution-api-db:5432/zapschat
EVOLUTION_DB_DSN = os.getenv("EVOLUTION_DB_DSN")

evo_engine = create_engine(
    EVOLUTION_DB_DSN,
    pool_pre_ping=True,
    future=True,
) if EVOLUTION_DB_DSN else None


def get_instance_profile_pic(instance_name: str) -> Optional[str]:
    """
    Busca a foto de perfil da instância na tabela public."Instance"
    coluna "profilePicUrl".
    """
    if not evo_engine or not instance_name:
        return None

    with evo_engine.connect() as conn:
        row = conn.execute(
            text('SELECT "profilePicUrl" FROM public."Instance" WHERE "name" = :name ORDER BY "id" DESC LIMIT 1'),
            {"name": instance_name},
        ).first()
        if not row:
            return None
        return row[0] or None
