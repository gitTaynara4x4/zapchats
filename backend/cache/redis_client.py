# backend/cache/redis_client.py
import os, json, time
import redis

REDIS_URL   = os.getenv("REDIS_URL")
REDIS_PREF  = os.getenv("REDIS_PREFIX", "zap")
REDIS_TTL_S = int(os.getenv("REDIS_TTL_SECONDS", "120"))

r = None
if REDIS_URL:
    try:
        r = redis.Redis.from_url(REDIS_URL, decode_responses=True)
    except Exception:
        r = None

def k(*parts: str) -> str:
    return ":".join([REDIS_PREF, *[p for p in parts if p is not None and p != ""]])

def ping(timeout_ms: int = 500) -> bool:
    if not r: return False
    t0 = time.time()
    try:
        ok = (r.ping() is True)
        return ok and ((time.time() - t0) * 1000.0) < timeout_ms * 10  # folga
    except Exception:
        return False

def get_json(key: str):
    if not r: return None
    try:
        v = r.get(key)
        return json.loads(v) if v else None
    except Exception:
        return None

def set_json(key: str, obj, ttl: int | None = None):
    if not r: return
    try:
        r.set(key, json.dumps(obj, ensure_ascii=False), ex= ttl if ttl is not None else REDIS_TTL_S)
    except Exception:
        pass

def delete_key(key: str):
    if not r: return
    try:
        r.delete(key)
    except Exception:
        pass

def delete_prefix(prefix: str):
    if not r: return
    try:
        buf = []
        for key in r.scan_iter(match=f"{prefix}*"):
            buf.append(key)
            if len(buf) >= 500:
                r.delete(*buf)
                buf = []
        if buf:
            r.delete(*buf)
    except Exception:
        pass
