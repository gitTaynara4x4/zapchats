from __future__ import annotations

from sqlalchemy import text


def ensure_fila_retorno_inatividade(engine, log=print) -> None:
    """Garante colunas usadas pelo retorno automático da fila.

    Idempotente e segura para bancos já existentes. Filas antigas ficam com o
    retorno automático desligado até serem revisadas na tela /filas.
    """
    try:
        with engine.begin() as conn:
            conn.execute(text(
                "ALTER TABLE filas_atendimento "
                "ADD COLUMN IF NOT EXISTS retorno_inatividade_ativo BOOLEAN NOT NULL DEFAULT FALSE"
            ))
            conn.execute(text(
                "ALTER TABLE filas_atendimento "
                "ADD COLUMN IF NOT EXISTS retorno_inatividade_minutos INTEGER NULL"
            ))
            conn.execute(text(
                "UPDATE filas_atendimento "
                "SET retorno_inatividade_ativo = FALSE "
                "WHERE retorno_inatividade_ativo IS NULL"
            ))
        log("[MIGRATION] filas: retorno por inatividade garantido.")
    except Exception as exc:
        log(f"[MIGRATION][filas] falha ao garantir retorno por inatividade: {exc}")
        raise
