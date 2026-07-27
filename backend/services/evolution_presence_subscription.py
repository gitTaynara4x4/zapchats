from __future__ import annotations

import os
import re
import threading
import time
from typing import Any, Iterable

import requests

from backend.integrations.evolution.utils.log_utils import LOG, short


_LOCK = threading.Lock()
_LAST_ATTEMPT_BY_KEY: dict[str, float] = {}


def _env_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return bool(default)
    return str(raw).strip().lower() in {"1", "true", "yes", "on", "sim"}


def _env_int(name: str, default: int, *, minimum: int, maximum: int) -> int:
    try:
        value = int(str(os.getenv(name, default)).strip())
    except Exception:
        value = int(default)
    return max(minimum, min(maximum, value))


def presence_subscription_enabled() -> bool:
    return _env_bool("EVO_PRESENCE_SUBSCRIBE_ENABLED", True)


def presence_subscription_cooldown_seconds() -> int:
    return _env_int(
        "EVO_PRESENCE_SUBSCRIBE_COOLDOWN_SECONDS",
        45,
        minimum=10,
        maximum=600,
    )


def _only_digits(value: Any) -> str:
    return re.sub(r"\D", "", str(value or ""))


def select_presence_number(candidates: Iterable[Any]) -> str | None:
    """
    Escolhe um número real para o endpoint /chat/sendPresence.

    A Evolution 2.3.7 pode falhar ao validar identificadores @lid. Por isso,
    priorizamos real_jid / telefone normalizado e ignoramos um LID puro.
    """
    fallback: str | None = None

    for raw in candidates:
        value = str(raw or "").strip()
        if not value:
            continue

        lowered = value.lower()
        if "@lid" in lowered:
            continue

        digits = _only_digits(value.split("@", 1)[0])
        if 8 <= len(digits) <= 20:
            if "@s.whatsapp.net" in lowered or "@c.us" in lowered:
                return digits
            if fallback is None:
                fallback = digits

    return fallback


def _reserve_attempt(key: str) -> tuple[bool, int]:
    cooldown = presence_subscription_cooldown_seconds()
    now = time.monotonic()

    with _LOCK:
        last = _LAST_ATTEMPT_BY_KEY.get(key)
        if last is not None:
            remaining = int(max(0, cooldown - (now - last)))
            if remaining > 0:
                return False, remaining

        _LAST_ATTEMPT_BY_KEY[key] = now

        # Limpeza simples para não manter chaves antigas indefinidamente.
        if len(_LAST_ATTEMPT_BY_KEY) > 5000:
            cutoff = now - max(600, cooldown * 4)
            stale = [item_key for item_key, ts in _LAST_ATTEMPT_BY_KEY.items() if ts < cutoff]
            for item_key in stale[:2500]:
                _LAST_ATTEMPT_BY_KEY.pop(item_key, None)

    return True, 0


def subscribe_contact_presence(
    *,
    instance_name: str,
    number: str,
    empresa_id: int,
    cliente_id: int,
    instancia_id: int,
) -> dict[str, Any]:
    """
    Solicita à Evolution/Baileys a assinatura da presença do contato.

    Na Evolution 2.3.7, /chat/sendPresence chama presenceSubscribe antes de
    atualizar a presença da própria instância. Usamos `paused` e delay mínimo
    para não exibir "digitando" ou "gravando" para o contato.
    """
    if not presence_subscription_enabled():
        return {"ok": False, "skipped": True, "reason": "disabled"}

    instance = str(instance_name or "").strip()
    target = _only_digits(number)
    if not instance or not (8 <= len(target) <= 20):
        return {"ok": False, "skipped": True, "reason": "invalid_target"}

    key = f"{int(empresa_id)}:{int(instancia_id)}:{target}"
    allowed, retry_after = _reserve_attempt(key)
    if not allowed:
        return {
            "ok": True,
            "skipped": True,
            "reason": "cooldown",
            "retry_after_seconds": retry_after,
        }

    body = {
        "number": target,
        "presence": "paused",
        "delay": 1,
    }

    base_url = str(os.getenv("EVOLUTION_URL") or "").rstrip("/")
    api_key = str(os.getenv("EVOLUTION_APIKEY") or os.getenv("EVOLUTION_KEY") or "").strip()
    if not base_url or not api_key:
        return {"ok": False, "skipped": True, "reason": "evolution_not_configured"}

    try:
        response = requests.post(
            f"{base_url}/chat/sendPresence/{instance}",
            headers={
                "apikey": api_key,
                "Content-Type": "application/json",
            },
            json=body,
            timeout=15,
        )

        response_text = short(response.text, 300)
        if not response.ok:
            LOG(
                "[PRESENCA][subscribe][falha] "
                f"empresa={empresa_id} cliente={cliente_id} instancia={instancia_id} "
                f"http={response.status_code} body={response_text}"
            )
            return {
                "ok": False,
                "status_code": int(response.status_code),
                "detail": response_text or "Evolution recusou a assinatura de presença",
            }

        try:
            payload: Any = response.json()
        except Exception:
            payload = {"raw": response_text}

        LOG(
            "[PRESENCA][subscribe][ok] "
            f"empresa={empresa_id} cliente={cliente_id} instancia={instancia_id}"
        )
        return {"ok": True, "status_code": int(response.status_code), "evolution": payload}
    except Exception as exc:
        LOG(
            "[PRESENCA][subscribe][erro] "
            f"empresa={empresa_id} cliente={cliente_id} instancia={instancia_id} "
            f"erro={short(exc, 240)}"
        )
        return {"ok": False, "detail": short(exc, 240)}


__all__ = [
    "presence_subscription_enabled",
    "presence_subscription_cooldown_seconds",
    "select_presence_number",
    "subscribe_contact_presence",
]
