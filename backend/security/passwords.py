from __future__ import annotations

import os
from typing import Union

import bcrypt

# ---- Config ----
# Fator de custo do bcrypt. 12 é um bom equilíbrio (produção pode usar 12–14).
_BCRYPT_ROUNDS = int(os.getenv("BCRYPT_ROUNDS", "12"))

# Para compat: alguns bancos armazenam TEXT; outros BYTEA. Vamos aceitar ambos.
BytesLike = Union[bytes, bytearray, memoryview]


def _to_bytes(s: Union[str, BytesLike]) -> bytes:
    """Converte para bytes (utf-8, ignore) preservando bytes se já for bytes."""
    if isinstance(s, (bytes, bytearray, memoryview)):
        return bytes(s)
    return str(s).encode("utf-8", "ignore")


def _bcrypt_safe(plain: Union[str, BytesLike]) -> bytes:
    """
    Bcrypt só considera os **primeiros 72 bytes** da senha.
    Fazemos o truncamento explícito para evitar surpresas.
    """
    b = _to_bytes(plain)
    if len(b) > 72:
        b = b[:72]
    return b


def hash_pwd(plain: Union[str, BytesLike]) -> str:
    """
    Gera hash com bcrypt e retorna como string (utf-8) para salvar no banco.
    """
    pw = _bcrypt_safe(plain)
    salt = bcrypt.gensalt(rounds=_BCRYPT_ROUNDS)
    h: bytes = bcrypt.hashpw(pw, salt)
    return h.decode("utf-8")


def verify_pwd(plain: Union[str, BytesLike], hashed: Union[str, BytesLike]) -> bool:
    """
    Verifica senha em texto vs hash armazenado.
    Aceita hash vindo como str (TEXT) ou bytes (BYTEA).
    """
    try:
        pw = _bcrypt_safe(plain)
        hh = _to_bytes(hashed)
        return bcrypt.checkpw(pw, hh)
    except Exception:
        return False


def is_bcrypt_hash(value: Union[str, BytesLike]) -> bool:
    """
    Checagem leve para saber se 'value' parece um hash bcrypt ($2b$...).
    Útil em migrações.
    """
    try:
        s = _to_bytes(value).decode("utf-8", "ignore")
        return s.startswith("$2a$") or s.startswith("$2b$") or s.startswith("$2y$")
    except Exception:
        return False


def needs_rehash(hashed: Union[str, BytesLike], target_rounds: int | None = None) -> bool:
    """
    Retorna True se o hash parece ter custo menor que o desejado (ex.: aumentar fator).
    """
    try:
        s = _to_bytes(hashed).decode("utf-8", "ignore")
        # Formato: $2b$12$<22_salt><31_hash>
        parts = s.split("$")
        if len(parts) >= 3 and parts[2].isdigit():
            rounds = int(parts[2])
            return rounds < (target_rounds or _BCRYPT_ROUNDS)
    except Exception:
        pass
    return False
