from __future__ import annotations

from sqlalchemy import text
from sqlalchemy.engine import Engine


def ensure_colaboradores_list_performance(engine: Engine, log=print) -> None:
    """Garante índices usados pela listagem da equipe.

    A função é idempotente e protegida por advisory lock para suportar mais de
    uma réplica da aplicação iniciando ao mesmo tempo.
    """
    try:
        with engine.begin() as conn:
            conn.execute(
                text(
                    "SELECT pg_advisory_xact_lock("
                    "hashtext('zapchats_colaboradores_list_performance_v1'))"
                )
            )

            colaboradores_exists = conn.execute(
                text("SELECT to_regclass('public.colaboradores')")
            ).scalar()
            if colaboradores_exists is not None:
                conn.execute(
                    text(
                        """
                        CREATE INDEX IF NOT EXISTS ix_colaboradores_empresa_nome_lower
                            ON colaboradores (empresa_id, lower(nome))
                        """
                    )
                )
                conn.execute(
                    text(
                        """
                        CREATE INDEX IF NOT EXISTS ix_colaboradores_empresa_setor
                            ON colaboradores (empresa_id, setor_id)
                         WHERE setor_id IS NOT NULL
                        """
                    )
                )

            membros_exists = conn.execute(
                text("SELECT to_regclass('public.departamentos_membros')")
            ).scalar()
            if membros_exists is not None:
                conn.execute(
                    text(
                        """
                        CREATE INDEX IF NOT EXISTS ix_dep_membros_empresa_colaborador_ord
                            ON departamentos_membros (
                                empresa_id,
                                colaborador_id,
                                is_primary DESC,
                                departamento_id
                            )
                        """
                    )
                )

        try:
            log('[STARTUP][COLABORADORES] Índices da listagem garantidos.')
        except Exception:
            pass
    except Exception as exc:
        try:
            log(f'[STARTUP][COLABORADORES] Falha ao criar índices: {exc}')
        except Exception:
            pass
        raise
