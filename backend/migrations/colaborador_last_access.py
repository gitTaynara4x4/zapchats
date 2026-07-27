from __future__ import annotations

from sqlalchemy import text
from sqlalchemy.engine import Engine


def ensure_colaborador_last_access(engine: Engine, log=print) -> None:
    """Cria, de forma idempotente, o campo de último acesso ao ZapsChat."""
    try:
        with engine.begin() as conn:
            conn.execute(
                text(
                    "SELECT pg_advisory_xact_lock("
                    "hashtext('zapchats_colaborador_last_access_v1'))"
                )
            )

            exists = conn.execute(text("SELECT to_regclass('public.colaboradores')")).scalar()
            if exists is None:
                return

            conn.execute(
                text(
                    """
                    ALTER TABLE colaboradores
                        ADD COLUMN IF NOT EXISTS last_access_at TIMESTAMPTZ
                    """
                )
            )

            conn.execute(
                text(
                    """
                    CREATE INDEX IF NOT EXISTS ix_colaboradores_empresa_last_access
                        ON colaboradores (empresa_id, last_access_at DESC)
                     WHERE last_access_at IS NOT NULL
                    """
                )
            )

        try:
            log("[STARTUP][ULTIMO_ACESSO] Campo dos colaboradores garantido.")
        except Exception:
            pass
    except Exception as exc:
        try:
            log(f"[STARTUP][ULTIMO_ACESSO] Falha ao criar campo: {exc}")
        except Exception:
            pass
        raise
