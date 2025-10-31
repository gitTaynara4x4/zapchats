from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional, Tuple
from sqlalchemy import text
from sqlalchemy.orm import Session

"""
Throttle de login por (email, ip).

- Usa duas tabelas simples:
  - auth_login_fail(email, ip, count, expire_at)   -> janela deslizante p/ contagem de falhas
  - auth_login_lock(email, ip, until)              -> bloqueio temporário quando ultrapassa limite

- As funções **não** fazem commit. Quem chama decide o momento do commit/rollback.
- Funciona em Postgres e SQLite (sem GREATEST, usamos CASE).
"""

# ============ Parâmetros ============
ACCOUNT_FAIL_LIMIT = 5          # máximo de falhas dentro da janela
ACCOUNT_WINDOW_SEC = 5 * 60     # janela (segundos) para contar falhas
ACCOUNT_LOCK_SEC   = 10 * 60    # duração do bloqueio (segundos)

# Tabelas
TBL_FAIL = "auth_login_fail"    # cols: email TEXT PK, ip TEXT PK, count INT, expire_at BIGINT (epoch s)
TBL_LOCK = "auth_login_lock"    # cols: email TEXT PK, ip TEXT PK, until BIGINT (epoch s)

__all__ = [
    "ACCOUNT_FAIL_LIMIT",
    "ACCOUNT_WINDOW_SEC",
    "ACCOUNT_LOCK_SEC",
    "norm_email",
    "client_ip_from_headers",
    "is_locked",
    "apply_lock",
    "reset_fail",
    "inc_fail",
    "should_lock",
    "on_login_failure",
    "on_login_success",
    "cleanup_expired",
]

# --- util tempo ---
def _now_epoch() -> int:
    return int(datetime.now(timezone.utc).timestamp())


# --- normalização / IP ---
def norm_email(email: str) -> str:
    return (email or "").strip().lower()


def client_ip_from_headers(headers, fallback_ip: Optional[str] = None) -> str:
    """
    Extrai IP real respeitando reverse proxy, com fallback.
    """
    try:
        xff = headers.get("x-forwarded-for") or headers.get("X-Forwarded-For")
        if xff:
            return xff.split(",")[0].strip()
        rip = headers.get("x-real-ip") or headers.get("X-Real-IP")
        if rip:
            return rip.strip()
    except Exception:
        pass
    return (fallback_ip or "").strip() or "127.0.0.1"


# --- bootstrap (idempotente) ---
_BOOTSTRAPPED = False
def _bootstrap(db: Session) -> None:
    """
    Cria as tabelas se não existirem. Não dá commit.
    Compatível com SQLite e Postgres.
    """
    global _BOOTSTRAPPED
    if _BOOTSTRAPPED:
        return

    db.execute(text(f"""
        CREATE TABLE IF NOT EXISTS {TBL_FAIL} (
            email     TEXT NOT NULL,
            ip        TEXT NOT NULL,
            count     INTEGER NOT NULL,
            expire_at BIGINT NOT NULL,
            PRIMARY KEY (email, ip)
        );
    """))

    db.execute(text(f"""
        CREATE TABLE IF NOT EXISTS {TBL_LOCK} (
            email TEXT NOT NULL,
            ip    TEXT NOT NULL,
            until BIGINT NOT NULL,
            PRIMARY KEY (email, ip)
        );
    """))

    _BOOTSTRAPPED = True


# ============ API ============
def is_locked(db: Session, email: str, ip: str) -> int:
    """
    Retorna segundos restantes de bloqueio (0 se não bloqueado).
    Também limpa locks expirados.
    """
    _bootstrap(db)
    now = _now_epoch()
    row = db.execute(
        text(f"SELECT until FROM {TBL_LOCK} WHERE email=:e AND ip=:i LIMIT 1"),
        {"e": email, "i": ip},
    ).first()

    if not row:
        return 0

    until = int(row[0] or 0)
    if until <= now:
        db.execute(text(f"DELETE FROM {TBL_LOCK} WHERE email=:e AND ip=:i"), {"e": email, "i": ip})
        return 0

    return max(0, until - now)


def apply_lock(db: Session, email: str, ip: str, seconds: int) -> None:
    """
    Aplica bloqueio por `seconds` a partir de agora. Não faz commit.
    Sem GREATEST (SQLite safe): usamos CASE para escolher o maior.
    """
    _bootstrap(db)
    until = _now_epoch() + max(1, int(seconds or 0))
    db.execute(
        text(f"""
            INSERT INTO {TBL_LOCK} (email, ip, until)
            VALUES (:e, :i, :u)
            ON CONFLICT (email, ip)
            DO UPDATE SET until = CASE
                WHEN EXCLUDED.until > {TBL_LOCK}.until THEN EXCLUDED.until
                ELSE {TBL_LOCK}.until
            END
        """),
        {"e": email, "i": ip, "u": until},
    )


def reset_fail(db: Session, email: str, ip: str) -> None:
    """Zera contador de falhas (não faz commit)."""
    _bootstrap(db)
    db.execute(text(f"DELETE FROM {TBL_FAIL} WHERE email=:e AND ip=:i"), {"e": email, "i": ip})


def inc_fail(db: Session, email: str, ip: str) -> Tuple[int, int]:
    """
    Incrementa falhas respeitando a janela.
    Retorna (count_atual, window_remaining_sec).
    """
    _bootstrap(db)
    now = _now_epoch()

    row = db.execute(
        text(f"SELECT count, expire_at FROM {TBL_FAIL} WHERE email=:e AND ip=:i LIMIT 1"),
        {"e": email, "i": ip},
    ).first()

    # primeira falha
    if not row:
        expire_at = now + ACCOUNT_WINDOW_SEC
        db.execute(
            text(f"INSERT INTO {TBL_FAIL} (email, ip, count, expire_at) VALUES (:e, :i, 1, :x)"),
            {"e": email, "i": ip, "x": expire_at},
        )
        return 1, ACCOUNT_WINDOW_SEC

    count, expire_at = int(row[0] or 0), int(row[1] or 0)

    # janela expirou → reinicia contagem
    if expire_at <= now:
        new_exp = now + ACCOUNT_WINDOW_SEC
        db.execute(
            text(f"UPDATE {TBL_FAIL} SET count=1, expire_at=:x WHERE email=:e AND ip=:i"),
            {"e": email, "i": ip, "x": new_exp},
        )
        return 1, ACCOUNT_WINDOW_SEC

    # ainda dentro da janela → incrementa somente o count
    new_count = count + 1
    db.execute(
        text(f"UPDATE {TBL_FAIL} SET count=:c WHERE email=:e AND ip=:i"),
        {"e": email, "i": ip, "c": new_count},
    )
    remain = max(0, expire_at - now)
    return new_count, remain


def should_lock(fail_count: int) -> bool:
    """True se a contagem atingiu/excedeu o limite."""
    try:
        return int(fail_count) >= int(ACCOUNT_FAIL_LIMIT)
    except Exception:
        return False


# --------- Helpers de alto nível (opcionais) ---------
def on_login_failure(db: Session, email: str, ip: str) -> Tuple[bool, int, int]:
    """
    Chamar quando a senha estiver errada ou o usuário não existir.
    Retorna: (locked_agora, remain_seconds, fail_count)
    """
    count, _window_left = inc_fail(db, email, ip)
    if should_lock(count):
        apply_lock(db, email, ip, ACCOUNT_LOCK_SEC)
        remain = is_locked(db, email, ip)
        return True, remain, count
    return False, 0, count


def on_login_success(db: Session, email: str, ip: str) -> None:
    """Zera falhas e limpa locks expirados."""
    reset_fail(db, email, ip)
    _ = is_locked(db, email, ip)


def cleanup_expired(db: Session) -> None:
    """Remove registros expirados (não faz commit)."""
    _bootstrap(db)
    now = _now_epoch()
    db.execute(text(f"DELETE FROM {TBL_LOCK} WHERE until <= :now"), {"now": now})
    db.execute(text(f"DELETE FROM {TBL_FAIL} WHERE expire_at <= :now"), {"now": now})
