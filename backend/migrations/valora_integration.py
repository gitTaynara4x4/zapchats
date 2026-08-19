from __future__ import annotations

from sqlalchemy import text
from sqlalchemy.engine import Engine


def ensure_valora_integration_schema(engine: Engine, log=print) -> None:
    """Garante o pareamento seguro Valora <-> ZapsChat e a idempotência de envios."""
    try:
        with engine.begin() as conn:
            conn.execute(text("SELECT pg_advisory_xact_lock(hashtext('zapchats_valora_integration_v1'))"))
            conn.execute(
                text(
                    """
                    CREATE TABLE IF NOT EXISTS integracoes_valora (
                        id BIGSERIAL PRIMARY KEY,
                        empresa_id INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
                        codigo_pareamento_hash VARCHAR(64),
                        codigo_pareamento_expira_em TIMESTAMPTZ,
                        token_hash VARCHAR(64),
                        token_prefix VARCHAR(24),
                        ativo BOOLEAN NOT NULL DEFAULT FALSE,
                        valora_empresa_id BIGINT,
                        valora_empresa_nome VARCHAR(180),
                        pareado_em TIMESTAMPTZ,
                        ultimo_uso_em TIMESTAMPTZ,
                        criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                        atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                        CONSTRAINT uq_integracoes_valora_empresa UNIQUE (empresa_id),
                        CONSTRAINT uq_integracoes_valora_token_hash UNIQUE (token_hash)
                    )
                    """
                )
            )
            conn.execute(
                text(
                    """
                    CREATE INDEX IF NOT EXISTS ix_integracoes_valora_token_ativo
                    ON integracoes_valora (token_hash, ativo)
                    """
                )
            )
            conn.execute(
                text(
                    """
                    CREATE TABLE IF NOT EXISTS integracoes_valora_envios (
                        id BIGSERIAL PRIMARY KEY,
                        empresa_id INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
                        idempotency_key VARCHAR(180) NOT NULL,
                        instancia_id INTEGER REFERENCES empresas_instancias(id) ON DELETE SET NULL,
                        telefone VARCHAR(40),
                        valora_empresa_id BIGINT,
                        valora_cliente_id BIGINT,
                        valora_lancamento_id BIGINT,
                        valora_envio_id BIGINT,
                        status VARCHAR(30) NOT NULL DEFAULT 'processando',
                        zapschat_msg_id VARCHAR(255),
                        resposta_json TEXT,
                        erro TEXT,
                        criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                        atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                        CONSTRAINT uq_integracoes_valora_envio_idem UNIQUE (empresa_id, idempotency_key)
                    )
                    """
                )
            )
            conn.execute(text("ALTER TABLE integracoes_valora_envios ADD COLUMN IF NOT EXISTS valora_empresa_id BIGINT"))
            conn.execute(text("ALTER TABLE integracoes_valora_envios ADD COLUMN IF NOT EXISTS valora_cliente_id BIGINT"))
            conn.execute(text("ALTER TABLE integracoes_valora_envios ADD COLUMN IF NOT EXISTS valora_lancamento_id BIGINT"))
            conn.execute(text("ALTER TABLE integracoes_valora_envios ADD COLUMN IF NOT EXISTS valora_envio_id BIGINT"))
            conn.execute(
                text(
                    """
                    CREATE INDEX IF NOT EXISTS ix_integracoes_valora_envios_status
                    ON integracoes_valora_envios (empresa_id, status, atualizado_em)
                    """
                )
            )
        try:
            log("[STARTUP][VALORA] Estrutura de integração Valora garantida.")
        except Exception:
            pass
    except Exception as exc:
        try:
            log(f"[STARTUP][VALORA] Falha ao garantir integração: {exc}")
        except Exception:
            pass
        raise
