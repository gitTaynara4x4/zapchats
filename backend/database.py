# backend/database.py
from __future__ import annotations

import os
from typing import Generator
from dotenv import load_dotenv
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, Session, declarative_base

# 🔹 Carrega variáveis de ambiente (.env), se existirem
load_dotenv()

# 🔹 URL do banco (ex.: postgresql+psycopg2://user:pass@host:5432/dbname
DATABASE_URL = os.getenv("DATABASE_URL")
if not DATABASE_URL:
    raise RuntimeError("DATABASE_URL não definido nas variáveis de ambiente.")

# =========================
# Defaults seguros (sem precisar mexer no .env)
# =========================
DEFAULTS = {
    "DB_POOL_RECYCLE_SECONDS": 1800,   # 30 min
    "DB_POOL_TIMEOUT_SECONDS": 30,     # espera do pool
    "DB_POOL_SIZE": 12,                # conexões no pool
    "DB_MAX_OVERFLOW": 24,             # estouro do pool
    "DB_KEEPALIVES_IDLE": 30,          # TCP keepalive (idle)
    "DB_KEEPALIVES_INTERVAL": 10,      # TCP keepalive (interval)
    "DB_KEEPALIVES_COUNT": 5,          # TCP keepalive (retries)
    "DB_STATEMENT_TIMEOUT_MS": 60000,  # 60s por statement (anti-lock eterno)
}

def _env_int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, str(default)))
    except Exception:
        return default

# =========================
# Pool resiliente (Postgres)
# =========================
engine = create_engine(
    DATABASE_URL,
    pool_pre_ping=True,
    pool_recycle=_env_int("DB_POOL_RECYCLE_SECONDS", DEFAULTS["DB_POOL_RECYCLE_SECONDS"]),
    pool_timeout=_env_int("DB_POOL_TIMEOUT_SECONDS", DEFAULTS["DB_POOL_TIMEOUT_SECONDS"]),
    pool_size=_env_int("DB_POOL_SIZE", DEFAULTS["DB_POOL_SIZE"]),
    max_overflow=_env_int("DB_MAX_OVERFLOW", DEFAULTS["DB_MAX_OVERFLOW"]),
    connect_args={
        # TCP keepalive (psycopg2)
        "keepalives": 1,
        "keepalives_idle": _env_int("DB_KEEPALIVES_IDLE", DEFAULTS["DB_KEEPALIVES_IDLE"]),
        "keepalives_interval": _env_int("DB_KEEPALIVES_INTERVAL", DEFAULTS["DB_KEEPALIVES_INTERVAL"]),
        "keepalives_count": _env_int("DB_KEEPALIVES_COUNT", DEFAULTS["DB_KEEPALIVES_COUNT"]),
        # 🔹 Limita statements presos em lock/espera
        "options": f"-c statement_timeout={_env_int('DB_STATEMENT_TIMEOUT_MS', DEFAULTS['DB_STATEMENT_TIMEOUT_MS'])}",
    },
)

# 🔹 Session factory
SessionLocal = sessionmaker(
    autocommit=False,
    autoflush=False,
    expire_on_commit=False,  # evita expirar objetos imediatamente após commit
    bind=engine,
)

# 🔹 Base declarativa
Base = declarative_base()

# =========================
# Helpers de sessão
# =========================
def get_db() -> Generator[Session, None, None]:
    """
    Dependency padrão (FastAPI): abre uma sessão por request,
    faz rollback se der exceção e fecha SEMPRE no finally.
    """
    db: Session = SessionLocal()
    try:
        yield db
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()

def get_db_session() -> Generator[Session, None, None]:
    """
    Compatibilidade com nome antigo. Idêntico ao get_db.
    """
    db: Session = SessionLocal()
    try:
        yield db
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()
