from __future__ import annotations

from sqlalchemy import text


# Serializa esta migração entre processos/workers que subam ao mesmo tempo.
# O valor só precisa ser estável e exclusivo dentro desta aplicação.
_BILLING_SCHEMA_LOCK_KEY = 8_314_159_265


def ensure_billing_asaas_schema(engine, log=print) -> None:
    """Garante o schema usado pela integração Asaas uma única vez no startup.

    DDL não deve rodar dentro de endpoints. No PostgreSQL, ALTER TABLE pode
    adquirir AccessExclusiveLock e duas requisições concorrentes de cobrança
    podem acabar em deadlock. Esta migração usa advisory lock transacional
    para também serializar startups concorrentes de múltiplos workers.
    """
    statements = [
        "ALTER TABLE empresas ADD COLUMN IF NOT EXISTS billing_provider VARCHAR(30)",
        "ALTER TABLE empresas ADD COLUMN IF NOT EXISTS billing_status VARCHAR(40)",
        "ALTER TABLE empresas ADD COLUMN IF NOT EXISTS billing_plan_pending VARCHAR(40)",
        "ALTER TABLE empresas ADD COLUMN IF NOT EXISTS asaas_customer_id VARCHAR(120)",
        "ALTER TABLE empresas ADD COLUMN IF NOT EXISTS asaas_subscription_id VARCHAR(120)",
        "ALTER TABLE empresas ADD COLUMN IF NOT EXISTS asaas_last_payment_id VARCHAR(120)",
        "ALTER TABLE empresas ADD COLUMN IF NOT EXISTS asaas_billing_type VARCHAR(30)",
        "ALTER TABLE empresas ADD COLUMN IF NOT EXISTS billing_updated_at TIMESTAMP WITH TIME ZONE",
        """
        CREATE TABLE IF NOT EXISTS billing_asaas_events (
          id SERIAL PRIMARY KEY,
          event_id VARCHAR(180) NOT NULL,
          empresa_id INTEGER NULL REFERENCES empresas(id) ON DELETE SET NULL,
          event VARCHAR(80) NULL,
          payment_id VARCHAR(120) NULL,
          subscription_id VARCHAR(120) NULL,
          payload JSONB NOT NULL,
          created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
        )
        """,
        """
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1
            FROM pg_constraint
            WHERE conname = 'uq_billing_asaas_event_id'
          ) THEN
            ALTER TABLE billing_asaas_events
            ADD CONSTRAINT uq_billing_asaas_event_id UNIQUE (event_id);
          END IF;
        END $$
        """,
        "CREATE INDEX IF NOT EXISTS ix_billing_asaas_events_empresa ON billing_asaas_events (empresa_id)",
        "CREATE INDEX IF NOT EXISTS ix_billing_asaas_events_payment ON billing_asaas_events (payment_id)",
        "CREATE INDEX IF NOT EXISTS ix_billing_asaas_events_subscription ON billing_asaas_events (subscription_id)",
        """
        CREATE TABLE IF NOT EXISTS billing_asaas_payment_credits (
          id SERIAL PRIMARY KEY,
          payment_id VARCHAR(120) NOT NULL UNIQUE,
          empresa_id INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
          subscription_id VARCHAR(120) NULL,
          plan VARCHAR(40) NOT NULL,
          payment_status VARCHAR(40) NULL,
          event_id VARCHAR(180) NULL,
          credited_days INTEGER NOT NULL DEFAULT 30,
          credited_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          reversed_at TIMESTAMP WITH TIME ZONE NULL,
          reversal_event_id VARCHAR(180) NULL
        )
        """,
        "CREATE INDEX IF NOT EXISTS ix_billing_asaas_credits_empresa ON billing_asaas_payment_credits (empresa_id)",
        "CREATE INDEX IF NOT EXISTS ix_billing_asaas_credits_subscription ON billing_asaas_payment_credits (subscription_id)",
    ]

    try:
        with engine.begin() as conn:
            if str(conn.dialect.name).lower() != "postgresql":
                # O projeto de produção usa PostgreSQL. Em outro dialeto, não
                # executamos DDL PostgreSQL-específico (JSONB/advisory lock).
                return

            conn.execute(
                text("SELECT pg_advisory_xact_lock(:lock_key)"),
                {"lock_key": _BILLING_SCHEMA_LOCK_KEY},
            )

            for stmt in statements:
                conn.execute(text(stmt))

        try:
            log("[MIGRATION] billing Asaas: schema garantido no startup.")
        except Exception:
            pass
    except Exception as exc:
        try:
            log(f"[MIGRATION][billing Asaas] falha ao garantir schema: {exc}")
        except Exception:
            pass
        raise
