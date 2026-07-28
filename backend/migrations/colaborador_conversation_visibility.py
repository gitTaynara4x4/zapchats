from __future__ import annotations

from sqlalchemy import text
from sqlalchemy.engine import Engine


def ensure_colaborador_conversation_visibility(engine: Engine, log=print) -> None:
    """Garante o escopo de visibilidade das conversas por colaborador."""
    try:
        with engine.begin() as conn:
            conn.execute(
                text(
                    "SELECT pg_advisory_xact_lock("
                    "hashtext('zapchats_colaborador_conversation_visibility_v1'))"
                )
            )

            exists = conn.execute(text("SELECT to_regclass('public.colaboradores')")).scalar()
            if exists is None:
                return

            conn.execute(
                text(
                    """
                    ALTER TABLE colaboradores
                        ADD COLUMN IF NOT EXISTS visibilidade_atendimentos VARCHAR(20)
                        NOT NULL DEFAULT 'todos'
                    """
                )
            )

            conn.execute(
                text(
                    """
                    UPDATE colaboradores
                       SET visibilidade_atendimentos = 'todos'
                     WHERE visibilidade_atendimentos IS NULL
                        OR lower(trim(visibilidade_atendimentos)) NOT IN ('todos', 'proprios')
                    """
                )
            )

        try:
            log("[STARTUP][VISIBILIDADE_ATENDIMENTOS] Campo dos colaboradores garantido.")
        except Exception:
            pass
    except Exception as exc:
        try:
            log(f"[STARTUP][VISIBILIDADE_ATENDIMENTOS] Falha ao criar campo: {exc}")
        except Exception:
            pass
        raise
