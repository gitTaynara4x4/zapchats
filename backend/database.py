# backend/database.py
from __future__ import annotations

import os
from typing import Generator
from dotenv import load_dotenv
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, Session, declarative_base

# 🔹 Carrega variáveis de ambiente (.env
load_dotenv()

# 🔹 URL do banco (ex.: postgresql+psycopg2://user:pass@host:5432/dbname)
DATABASE_URL = os.getenv("DATABASE_URL")
if not DATABASE_URL:
    raise RuntimeError("DATABASE_URL não definido nas variáveis de ambiente.")

# =========================
# Pool resiliente (Postgres)
# =========================
# - pool_pre_ping: testa conexão do pool antes de usar; se morta, reconecta.
# - pool_recycle: recicla conexões periodicamente (evita NAT/firewall matar idle).
# - keepalives*: ativa TCP keepalive no psycopg2 (bom em Windows/NAT).
# - pool_size/max_overflow/pool_timeout: valores seguros; ajuste conforme carga.
engine = create_engine(
    DATABASE_URL,
    pool_pre_ping=True,
    pool_recycle=int(os.getenv("DB_POOL_RECYCLE_SECONDS", "1800")),  # 30min
    pool_timeout=int(os.getenv("DB_POOL_TIMEOUT_SECONDS", "30")),
    pool_size=int(os.getenv("DB_POOL_SIZE", "5")),
    max_overflow=int(os.getenv("DB_MAX_OVERFLOW", "10")),
    connect_args={
        # TCP keepalive (psycopg2)
        "keepalives": 1,
        "keepalives_idle": int(os.getenv("DB_KEEPALIVES_IDLE", "30")),
        "keepalives_interval": int(os.getenv("DB_KEEPALIVES_INTERVAL", "10")),
        "keepalives_count": int(os.getenv("DB_KEEPALIVES_COUNT", "5")),
        # Exemplo (opcional) de statement_timeout por conexão:
        # "options": "-c statement_timeout=60000"
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
