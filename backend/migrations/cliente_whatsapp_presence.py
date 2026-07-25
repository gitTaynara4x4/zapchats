from __future__ import annotations

from sqlalchemy import text
from sqlalchemy.engine import Engine


def ensure_cliente_whatsapp_presence(engine: Engine, log=print) -> None:
    """Cria, de forma idempotente, os campos de presença do contato."""
    try:
        with engine.begin() as conn:
            conn.execute(
                text(
                    "SELECT pg_advisory_xact_lock("
                    "hashtext('zapchats_cliente_whatsapp_presence_v1'))"
                )
            )

            exists = conn.execute(text("SELECT to_regclass('public.clientes')")).scalar()
            if exists is None:
                return

            conn.execute(text("""
                ALTER TABLE clientes
                    ADD COLUMN IF NOT EXISTS whatsapp_presence VARCHAR(32),
                    ADD COLUMN IF NOT EXISTS whatsapp_online BOOLEAN NOT NULL DEFAULT FALSE,
                    ADD COLUMN IF NOT EXISTS whatsapp_last_seen TIMESTAMPTZ,
                    ADD COLUMN IF NOT EXISTS whatsapp_presence_updated_at TIMESTAMPTZ
            """))

            conn.execute(text("""
                CREATE INDEX IF NOT EXISTS ix_clientes_whatsapp_presence_updated
                    ON clientes (empresa_id, whatsapp_presence_updated_at DESC)
                 WHERE whatsapp_presence_updated_at IS NOT NULL
            """))

        try:
            log("[STARTUP][PRESENCA] Campos de presença dos clientes garantidos.")
        except Exception:
            pass
    except Exception as exc:
        try:
            log(f"[STARTUP][PRESENCA] Falha ao criar campos de presença: {exc}")
        except Exception:
            pass
        raise
