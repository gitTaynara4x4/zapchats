from __future__ import annotations
import os
from passlib.context import CryptContext

# Fator de custo (rounds) — 12 é um bom equilíbrio
_BCRYPT_ROUNDS = int(os.getenv("BCRYPT_ROUNDS", "12"))

# Contexto Passlib para bcrypt
pwd_context = CryptContext(
    schemes=["bcrypt"],
    deprecated="auto",
    bcrypt__rounds=_BCRYPT_ROUNDS,
)

def hash_pwd(password: str) -> str:
    """Gera hash bcrypt (string) para salvar no banco."""
    if password is None:
        raise ValueError("password cannot be None")
    return pwd_context.hash(password)

def verify_pwd(password: str, hashed: str) -> bool:
    """Verifica senha em texto vs hash armazenado."""
    try:
        return pwd_context.verify(password or "", hashed or "")
    except Exception:
        return False

def is_bcrypt_hash(value: str) -> bool:
    """Checa se 'value' parece um hash bcrypt ($2a$/$2b$/$2y$)."""
    if not isinstance(value, (str, bytes)):
        return False
    s = value.decode("utf-8", "ignore") if isinstance(value, (bytes, bytearray)) else value
    return s.startswith("$2a$") or s.startswith("$2b$") or s.startswith("$2y$")

def needs_rehash(hashed: str, target_rounds: int | None = None) -> bool:
    """
    True se o hash precisa ser refeito (ex.: rounds mais altos).
    Usa o contexto atual; opcionalmente compara com target_rounds.
    """
    try:
        if pwd_context.needs_update(hashed):
            return True
        if target_rounds:
            # Ex.: $2b$12$...
            parts = hashed.split("$")
            if len(parts) >= 3 and parts[2].isdigit():
                rounds = int(parts[2])
                return rounds < int(target_rounds)
    except Exception:
        pass
    return False
