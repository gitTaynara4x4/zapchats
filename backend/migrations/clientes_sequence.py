from __future__ import annotations

from sqlalchemy import text
from sqlalchemy.engine import Engine


_SEQUENCE_LOCK_SQL = text(
    "SELECT pg_advisory_xact_lock(hashtext('zapchats_clientes_id_sequence_v1'))"
)

_SEQUENCE_SYNC_SQL = text(
    """
    DO $$
    DECLARE
        seq_name TEXT;
        max_id BIGINT;
        seq_last BIGINT;
        seq_called BOOLEAN;
    BEGIN
        IF to_regclass('public.clientes') IS NULL THEN
            RETURN;
        END IF;

        seq_name := pg_get_serial_sequence('public.clientes', 'id');
        IF seq_name IS NULL THEN
            RETURN;
        END IF;

        SELECT COALESCE(MAX(id), 0)
          INTO max_id
          FROM public.clientes;

        EXECUTE format('SELECT last_value, is_called FROM %s', seq_name)
           INTO seq_last, seq_called;

        -- Nunca retrocede a sequência. Só corrige quando ela está atrás do
        -- maior ID já existente ou quando ainda devolveria um ID ocupado.
        IF max_id > seq_last
           OR (max_id = seq_last AND max_id > 0 AND seq_called IS FALSE) THEN
            PERFORM setval(seq_name::regclass, max_id, TRUE);
        END IF;
    END
    $$;
    """
)


def sync_clientes_id_sequence(bind) -> None:
    """Alinha a sequência de clientes com o maior ID existente, sem retroceder."""
    bind.execute(_SEQUENCE_LOCK_SQL)
    bind.execute(_SEQUENCE_SYNC_SQL)


def ensure_clientes_id_sequence(engine: Engine, log=print) -> None:
    """Executa no startup uma correção idempotente da sequência clientes.id."""
    try:
        with engine.begin() as conn:
            sync_clientes_id_sequence(conn)

        try:
            log("[STARTUP][CLIENTES] Sequência de IDs verificada.")
        except Exception:
            pass
    except Exception as exc:
        try:
            log(f"[STARTUP][CLIENTES] Falha ao verificar sequência: {exc}")
        except Exception:
            pass
        raise
