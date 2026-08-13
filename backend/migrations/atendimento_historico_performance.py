from __future__ import annotations

from sqlalchemy import text


def ensure_atendimento_historico_performance(engine, log=print) -> None:
    """Garante índices usados na abertura/paginação do histórico do Atendimento.

    Base.metadata.create_all() não cria índices novos em tabelas que já existiam,
    então instalações antigas podem ficar sem os índices definidos hoje nos models.
    """
    statements = [
        """
        CREATE INDEX IF NOT EXISTS ix_mensagens_hist_emp_cli_inst_ts_id
        ON mensagens (empresa_id, cliente_id, instancia_id, timestamp DESC, id DESC)
        WHERE apagada_usuario = false
        """,
        """
        CREATE INDEX IF NOT EXISTS ix_mensagens_hist_emp_cli_ts_id
        ON mensagens (empresa_id, cliente_id, timestamp DESC, id DESC)
        WHERE apagada_usuario = false
        """,
        """
        CREATE INDEX IF NOT EXISTS ix_mensagens_hist_emp_cli_inst_id
        ON mensagens (empresa_id, cliente_id, instancia_id, id DESC)
        WHERE apagada_usuario = false
        """,
        """
        CREATE INDEX IF NOT EXISTS ix_msggrupo_hist_emp_grupo_inst_id
        ON mensagens_grupo (empresa_id, grupo_id, instancia_id, id DESC)
        """,
        """
        CREATE INDEX IF NOT EXISTS ix_atendimentos_hist_emp_cli_inst_id
        ON atendimentos (empresa_id, cliente_id, instancia_id, id DESC)
        """,
    ]

    try:
        with engine.begin() as conn:
            if str(conn.dialect.name).lower() != "postgresql":
                return
            for stmt in statements:
                conn.execute(text(stmt))
        try:
            log("[MIGRATION] índices de histórico do Atendimento garantidos.")
        except Exception:
            pass
    except Exception as exc:
        try:
            log(f"[MIGRATION][WARN] índices de histórico não puderam ser garantidos: {exc}")
        except Exception:
            pass
