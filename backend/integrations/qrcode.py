# backend/integrations/qrcode.py
from __future__ import annotations
import os, time, hashlib, logging
from typing import Optional, Tuple

try:
    # Cliente Redis do seu projeto (decode_responses=True)
    from backend.cache.redis_client import r, k  # r: Redis|None, k: monta chave com prefixo
except Exception:  # fallback se import falhar
    r, k = None, (lambda *parts: ":".join(["zap", *[p for p in parts if p]]))

logger = logging.getLogger(__name__)

# Janela de dedup (ms) – pode ajustar via env EVOLUTION_QR_DEDUP_WINDOW_MS
QR_DEDUP_WINDOW_MS = int(os.getenv("EVOLUTION_QR_DEDUP_WINDOW_MS", "1200"))

# Fallback in-memory (por processo)
_MEM_LAST: dict[str, Tuple[int, str]] = {}

def qr_sign(*, base64_img: Optional[str] = None, pairing_code: Optional[str] = None) -> str:
    """
    Assinatura estável do QR a partir do pairing_code e de um prefixo do base64.
    (usamos só o começo do base64 para não pesar a memória)
    """
    raw = (pairing_code or "") + "|" + ((base64_img or "")[:64])
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()

def qr_should_emit(inst: str, sign: str, window_ms: Optional[int] = None) -> bool:
    """
    Dedup cross-process: usa Redis para suprimir emissão repetida do MESMO QR
    dentro de uma janela curta; fallback em memória se Redis indisponível.
    Retorna True se deve EMITIR (mudou) e False se deve suprimir.
    """
    win_ms = QR_DEDUP_WINDOW_MS if window_ms is None else max(250, int(window_ms))
    ttl_sec = max(1, int(win_ms / 1000))

    # 1) Redis (cross-process)
    if r:
        try:
            key = k("QR_LAST", inst)
            prev = r.get(key)  # str|None (decode_responses=True)
            if prev != sign:
                r.set(key, sign, ex=ttl_sec)
                return True
            return False
        except Exception as e:
            logger.debug("qr_should_emit: Redis falhou (%s), usando fallback.", e)

    # 2) Fallback in-memory (processo atual)
    now = int(time.time() * 1000)
    ts_prev, prev = _MEM_LAST.get(inst, (0, None))
    if prev != sign or (now - ts_prev) > win_ms:
        _MEM_LAST[inst] = (now, sign)
        return True
    return False

def qr_force_lock_acquire(inst: str, ttl_sec: int = 3) -> bool:
    """
    Throttle do 'force_qr' ao abrir WS da instância.
    Se outra chamada ocorrer dentro do TTL, é ignorada.
    """
    # 1) Redis lock leve NX+EX
    if r:
        try:
            key = k("QR_FORCE_LOCK", inst)
            ok = r.set(key, "1", ex=ttl_sec, nx=True)  # só o primeiro obtém o lock
            return bool(ok)
        except Exception as e:
            logger.debug("qr_force_lock_acquire: Redis falhou (%s), fallback.", e)

    # 2) Fallback in-memory
    now = int(time.time())
    mem = getattr(qr_force_lock_acquire, "_mem", {})
    last = mem.get(inst, 0)
    if (now - last) >= ttl_sec:
        mem[inst] = now
        setattr(qr_force_lock_acquire, "_mem", mem)
        return True
    return False
