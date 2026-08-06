from __future__ import annotations

from sqlalchemy import text
from sqlalchemy.engine import Engine


def normalize_atendimento_claim_state(engine: Engine, log=print) -> None:
    """
    Migração idempotente do modelo compartilhado de atendimento.

    - fecha atendimentos abertos duplicados, mantendo o mais recente;
    - desativa participantes de atendimentos fechados;
    - preserva vários participantes ativos;
    - mantém somente um responsável principal por atendimento;
    - sincroniza operador/status;
    - troca o índice antigo de participante único pelo índice de responsável único.
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

            # Remove as restrições de claim durante a normalização. O índice novo
            # é recriado abaixo e limita somente o papel de responsável.
            conn.execute(text("DROP INDEX IF EXISTS uq_atd_participante_um_ativo"))
            conn.execute(text("DROP INDEX IF EXISTS uq_atd_participante_um_responsavel_ativo"))

            # Se há operador legado sem vínculo ativo, reativa/cria o responsável.
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
            """))

            # Quando não há operador_id, escolhe um participante ativo para ser o
            # responsável principal sem desligar os demais participantes.
            conn.execute(text("""
                WITH chosen AS (
                    SELECT DISTINCT ON (ap.empresa_id, ap.atendimento_id)
                           ap.empresa_id, ap.atendimento_id, ap.colaborador_id
                      FROM atendimento_participantes ap
                      JOIN atendimentos a
                        ON a.id = ap.atendimento_id
                       AND a.empresa_id = ap.empresa_id
                     WHERE ap.is_ativo IS TRUE
                       AND a.operador_id IS NULL
                       AND a.status IN ('novo', 'aguardando', 'em_atendimento', 'pausado')
                     ORDER BY ap.empresa_id, ap.atendimento_id,
                              CASE WHEN ap.role = 'responsavel' THEN 0 ELSE 1 END,
                              ap.entrou_em DESC NULLS LAST,
                              ap.id DESC
                )
                UPDATE atendimentos a
                   SET operador_id = c.colaborador_id,
                       status = 'em_atendimento',
                       aceito_em = COALESCE(a.aceito_em, NOW()),
                       atualizado_em = NOW()
                  FROM chosen c
                 WHERE a.id = c.atendimento_id
                   AND a.empresa_id = c.empresa_id
            """))

            # Exatamente um participante ativo recebe role=responsavel: o operador.
            conn.execute(text("""
                UPDATE atendimento_participantes ap
                   SET role = CASE
                                  WHEN ap.colaborador_id = a.operador_id THEN 'responsavel'
                                  ELSE 'participant'
                              END,
                       saiu_em = CASE WHEN ap.is_ativo IS TRUE THEN NULL ELSE ap.saiu_em END,
                       atualizado_em = NOW()
                  FROM atendimentos a
                 WHERE a.id = ap.atendimento_id
                   AND a.empresa_id = ap.empresa_id
                   AND ap.is_ativo IS TRUE
                   AND a.status IN ('novo', 'aguardando', 'em_atendimento', 'pausado')
                   AND ap.role IS DISTINCT FROM (
                       CASE WHEN ap.colaborador_id = a.operador_id THEN 'responsavel' ELSE 'participant' END
                   )
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
                CREATE UNIQUE INDEX IF NOT EXISTS uq_atd_participante_um_responsavel_ativo
                    ON atendimento_participantes (empresa_id, atendimento_id)
                 WHERE is_ativo IS TRUE AND role = 'responsavel'
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
