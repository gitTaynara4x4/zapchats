from __future__ import annotations

from sqlalchemy import text
from sqlalchemy.engine import Engine


def ensure_user_onboarding(engine: Engine, log=print) -> None:
    """Garante o campo que controla a exibição única do guia inicial."""
    try:
        with engine.begin() as conn:
            conn.execute(
                text(
                    "SELECT pg_advisory_xact_lock("
                    "hashtext('zapchats_user_onboarding_v1'))"
                )
            )

            for table_name in ("usuarios", "colaboradores"):
                exists = conn.execute(
                    text("SELECT to_regclass(:table_name)"),
                    {"table_name": f"public.{table_name}"},
                ).scalar()
                if exists is None:
                    continue

                conn.execute(
                    text(
                        f"""
                        ALTER TABLE {table_name}
                            ADD COLUMN IF NOT EXISTS onboarding_completed_at TIMESTAMPTZ
                        """
                    )
                )

        try:
            log("[STARTUP][ONBOARDING] Campos de exibição única garantidos.")
        except Exception:
            pass
    except Exception as exc:
        try:
            log(f"[STARTUP][ONBOARDING] Falha ao criar campos: {exc}")
        except Exception:
            pass
        raise
