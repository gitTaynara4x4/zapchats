from __future__ import annotations

from sqlalchemy import text
from sqlalchemy.engine import Engine


def normalize_atendimento_claim_state(engine: Engine, log=print) -> None:
    """
    Migração idempotente do modelo de um único responsável por atendimento.

    - fecha atendimentos abertos duplicados, mantendo o mais recente;
    - desativa participantes dos duplicados/fechados;
    - mantém só um participante ativo por atendimento;
    - sincroniza operador/status;
    - cria índices parciais que impedem a inconsistência de voltar.
    """
    try:
        with engine.begin() as conn:
            conn.execute(text("SELECT pg_advisory_xact_lock(hashtext('zapchats_atendimento_claim_state_v1'))"))

            exists = conn.execute(text("SELECT to_regclass('public.atendimento_participantes')")).scalar()
            if exists is None:
                return

            # 1) Mantém um único atendimento aberto por conversa.
            conn.execute(text("""
                WITH ranked AS (
                    SELECT id,
                           ROW_NUMBER() OVER (
                               PARTITION BY empresa_id, cliente_id, instancia_id
                               ORDER BY id DESC
                           ) AS rn
                      FROM atendimentos
                     WHERE status IN ('novo', 'aguardando', 'em_atendimento', 'pausado')
                       AND instancia_id IS NOT NULL
                )
                UPDATE atendimentos a
                   SET status = 'transferido',
                       operador_id = NULL,
                       atualizado_em = NOW()
                  FROM ranked r
                 WHERE a.id = r.id
                   AND r.rn > 1
            """))

            # Participantes de atendimentos já fechados não podem permanecer ativos.
            conn.execute(text("""
                UPDATE atendimento_participantes ap
                   SET is_ativo = FALSE,
                       role = 'participant',
                       saiu_em = COALESCE(ap.saiu_em, NOW()),
                       atualizado_em = NOW()
                  FROM atendimentos a
                 WHERE a.id = ap.atendimento_id
                   AND a.empresa_id = ap.empresa_id
                   AND a.status NOT IN ('novo', 'aguardando', 'em_atendimento', 'pausado')
                   AND ap.is_ativo IS TRUE
            """))

            # Se o índice parcial já existir, primeiro remove qualquer ativo que
            # conflite com operador_id; só depois reativa o operador legado.
            conn.execute(text("""
                UPDATE atendimento_participantes ap
                   SET is_ativo = FALSE,
                       role = 'participant',
                       saiu_em = COALESCE(ap.saiu_em, NOW()),
                       atualizado_em = NOW()
                  FROM atendimentos a
                 WHERE a.id = ap.atendimento_id
                   AND a.empresa_id = ap.empresa_id
                   AND a.operador_id IS NOT NULL
                   AND ap.is_ativo IS TRUE
                   AND ap.colaborador_id <> a.operador_id
                   AND a.status IN ('novo', 'aguardando', 'em_atendimento', 'pausado')
            """))

            # Se há operador legado sem participante ativo, reativa/cria o vínculo.
            conn.execute(text("""
                INSERT INTO atendimento_participantes AS ap
                    (empresa_id, atendimento_id, colaborador_id, role, is_ativo,
                     entrou_em, saiu_em, criado_em, atualizado_em)
                SELECT a.empresa_id, a.id, a.operador_id, 'responsavel', TRUE,
                       NOW(), NULL, NOW(), NOW()
                  FROM atendimentos a
                 WHERE a.operador_id IS NOT NULL
                   AND a.status IN ('novo', 'aguardando', 'em_atendimento', 'pausado')
                ON CONFLICT (empresa_id, atendimento_id, colaborador_id)
                DO UPDATE SET
                    role = 'responsavel',
                    is_ativo = TRUE,
                    saiu_em = NULL,
                    atualizado_em = NOW()
                WHERE ap.is_ativo IS DISTINCT FROM TRUE
                   OR ap.role IS DISTINCT FROM 'responsavel'
                   OR ap.saiu_em IS NOT NULL
            """))

            # Escolhe um único responsável ativo: operador atual vence; depois o mais recente.
            conn.execute(text("""
                WITH ranked AS (
                    SELECT ap.id,
                           ROW_NUMBER() OVER (
                               PARTITION BY ap.empresa_id, ap.atendimento_id
                               ORDER BY
                                   CASE WHEN ap.colaborador_id = a.operador_id THEN 0 ELSE 1 END,
                                   CASE WHEN ap.role = 'responsavel' THEN 0 ELSE 1 END,
                                   ap.entrou_em DESC NULLS LAST,
                                   ap.id DESC
                           ) AS rn
                      FROM atendimento_participantes ap
                      JOIN atendimentos a
                        ON a.id = ap.atendimento_id
                       AND a.empresa_id = ap.empresa_id
                     WHERE ap.is_ativo IS TRUE
                       AND a.status IN ('novo', 'aguardando', 'em_atendimento', 'pausado')
                )
                UPDATE atendimento_participantes ap
                   SET is_ativo = FALSE,
                       role = 'participant',
                       saiu_em = COALESCE(ap.saiu_em, NOW()),
                       atualizado_em = NOW()
                  FROM ranked r
                 WHERE ap.id = r.id
                   AND r.rn > 1
            """))

            conn.execute(text("""
                UPDATE atendimento_participantes ap
                   SET role = 'responsavel',
                       saiu_em = NULL,
                       atualizado_em = NOW()
                 WHERE ap.is_ativo IS TRUE
                   AND (ap.role IS DISTINCT FROM 'responsavel' OR ap.saiu_em IS NOT NULL)
            """))

            # Sincroniza o atendimento com o único participante ativo restante.
            conn.execute(text("""
                WITH chosen AS (
                    SELECT DISTINCT ON (empresa_id, atendimento_id)
                           empresa_id, atendimento_id, colaborador_id
                      FROM atendimento_participantes
                     WHERE is_ativo IS TRUE
                     ORDER BY empresa_id, atendimento_id, id DESC
                )
                UPDATE atendimentos a
                   SET operador_id = c.colaborador_id,
                       status = 'em_atendimento',
                       atualizado_em = NOW()
                  FROM chosen c
                 WHERE a.id = c.atendimento_id
                   AND a.empresa_id = c.empresa_id
                   AND a.status IN ('novo', 'aguardando', 'em_atendimento', 'pausado')
                   AND (a.operador_id IS DISTINCT FROM c.colaborador_id
                        OR a.status IS DISTINCT FROM 'em_atendimento'::statusatendimento)
            """))

            conn.execute(text("""
                UPDATE atendimentos a
                   SET operador_id = NULL,
                       status = CASE WHEN a.departamento_id IS NULL THEN 'novo'::statusatendimento
                                     ELSE 'aguardando'::statusatendimento END,
                       aceito_em = NULL,
                       atualizado_em = NOW()
                 WHERE a.status IN ('novo', 'aguardando', 'em_atendimento', 'pausado')
                   AND NOT EXISTS (
                       SELECT 1
                         FROM atendimento_participantes ap
                        WHERE ap.empresa_id = a.empresa_id
                          AND ap.atendimento_id = a.id
                          AND ap.is_ativo IS TRUE
                   )
                   AND (a.operador_id IS NOT NULL
                        OR a.aceito_em IS NOT NULL
                        OR a.status IS DISTINCT FROM (
                            CASE WHEN a.departamento_id IS NULL THEN 'novo'::statusatendimento
                                 ELSE 'aguardando'::statusatendimento END
                        ))
            """))

            conn.execute(text("""
                CREATE UNIQUE INDEX IF NOT EXISTS uq_atd_participante_um_ativo
                    ON atendimento_participantes (empresa_id, atendimento_id)
                 WHERE is_ativo IS TRUE
            """))

            conn.execute(text("""
                CREATE UNIQUE INDEX IF NOT EXISTS uq_atendimentos_um_aberto_conversa
                    ON atendimentos (empresa_id, cliente_id, instancia_id)
                 WHERE instancia_id IS NOT NULL
                   AND status IN ('novo'::statusatendimento, 'aguardando'::statusatendimento, 'em_atendimento'::statusatendimento, 'pausado'::statusatendimento)
            """))

        try:
            log("[STARTUP][ATENDIMENTO] Estado de responsável normalizado.")
        except Exception:
            pass
    except Exception as exc:
        try:
            log(f"[STARTUP][ATENDIMENTO] Falha ao normalizar responsável: {exc}")
        except Exception:
            pass
        raise
