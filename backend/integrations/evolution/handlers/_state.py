# backend/integrations/evolution/handlers/_state.py
from __future__ import annotations

import os
import time

# =========================
# Runtime flags in-memory
# =========================

# Instâncias que já estão com sync pós-conexão em andamento.
INSTANCIAS_SYNC: set[str] = set()

# instance -> unix seconds when a QR was last emitted.
QR_RECENT: dict[str, int] = {}


def remember_qr_emitted(inst_id: str, ts: int | None = None) -> None:
    """Marca que um QR/pairing code foi gerado para esta instância.

    O CONNECTION_UPDATE usa isso para diferenciar primeiro login por QR
    de uma reconexão antiga. Se essa marcação ficar em outro módulo,
    o histórico escolhido (24h/7d/30d) pode nunca disparar.
    """
    instance = str(inst_id or "").strip()
    if not instance:
        return

    try:
        QR_RECENT[instance] = int(ts if ts is not None else time.time())
    except Exception:
        QR_RECENT[instance] = int(time.time())


def forget_qr_recent(inst_id: str) -> None:
    instance = str(inst_id or "").strip()
    if not instance:
        return
    QR_RECENT.pop(instance, None)

# instance -> unix timestamp de quando o histórico foi marcado como concluído.
_HISTORY_DONE_AT: dict[str, float] = {}

# ============================================================
# Watchdog do histórico / MESSAGES_SET
# ============================================================
# Usado para saber se a Evolution realmente entregou o evento MESSAGES_SET
# depois do connection.open.
#
# Fluxo:
# connection.py:
#   - força rabbit/settings
#   - espera alguns segundos
#   - consulta HISTORY_MESSAGES_SET_STARTED_AT
#   - se não tiver entrada para a instância, reaplica rabbit/settings
#
# messages_set.py:
#   - assim que entrar no handler on_messages_set, marca a instância aqui.
# ============================================================

# instance -> unix timestamp do último MESSAGES_SET recebido.
HISTORY_MESSAGES_SET_STARTED_AT: dict[str, float] = {}

# instance -> total de mensagens do último pacote MESSAGES_SET.
HISTORY_MESSAGES_SET_LAST_TOTAL: dict[str, int] = {}

# instance -> contador de quantos pacotes MESSAGES_SET chegaram nesta execução.
HISTORY_MESSAGES_SET_COUNT: dict[str, int] = {}


def history_mark_messages_set_started(inst_id: str, total: int | None = None) -> float:
    """
    Marca que o handler MESSAGES_SET começou para uma instância.

    Isso é usado pelo watchdog do connection.py para saber se o histórico chegou.
    """
    instance = str(inst_id or "").strip()
    if not instance:
        return time.time()

    now_ts = time.time()

    HISTORY_MESSAGES_SET_STARTED_AT[instance] = now_ts
    HISTORY_MESSAGES_SET_COUNT[instance] = int(HISTORY_MESSAGES_SET_COUNT.get(instance, 0) or 0) + 1

    if total is not None:
        try:
            HISTORY_MESSAGES_SET_LAST_TOTAL[instance] = int(total)
        except Exception:
            HISTORY_MESSAGES_SET_LAST_TOTAL[instance] = 0

    return now_ts


def history_messages_set_started_at(inst_id: str) -> float | None:
    """
    Retorna quando chegou o último MESSAGES_SET da instância.
    """
    instance = str(inst_id or "").strip()
    if not instance:
        return None

    value = HISTORY_MESSAGES_SET_STARTED_AT.get(instance)
    try:
        return float(value) if value is not None else None
    except Exception:
        return None


def history_messages_set_count(inst_id: str) -> int:
    """
    Retorna quantos pacotes MESSAGES_SET chegaram para a instância nesta execução.
    """
    instance = str(inst_id or "").strip()
    if not instance:
        return 0

    try:
        return int(HISTORY_MESSAGES_SET_COUNT.get(instance, 0) or 0)
    except Exception:
        return 0


def history_messages_set_last_total(inst_id: str) -> int:
    """
    Retorna o total de mensagens do último pacote MESSAGES_SET recebido.
    """
    instance = str(inst_id or "").strip()
    if not instance:
        return 0

    try:
        return int(HISTORY_MESSAGES_SET_LAST_TOTAL.get(instance, 0) or 0)
    except Exception:
        return 0


def history_clear_messages_set_state(inst_id: str) -> None:
    """
    Limpa o estado do MESSAGES_SET de uma instância.

    Usado ao criar/reconectar uma instância nova para o watchdog não confundir
    pacote antigo com pacote novo.
    """
    instance = str(inst_id or "").strip()
    if not instance:
        return

    HISTORY_MESSAGES_SET_STARTED_AT.pop(instance, None)
    HISTORY_MESSAGES_SET_LAST_TOTAL.pop(instance, None)
    HISTORY_MESSAGES_SET_COUNT.pop(instance, None)


# ============================================================
# Dedup global do chatbot por msg_id
# Evita reprocessar o mesmo evento/replay da Evolution.
# ============================================================

_CHATBOT_MSG_SEEN: dict[str, float] = {}
_CHATBOT_MSG_TTL_SECONDS = float(os.getenv("CHATBOT_MSG_TTL_SECONDS", "120"))


def chatbot_seen_key(empresa_id: int, instancia_db_id: int, msg_id: str) -> str:
    return f"{int(empresa_id)}:{int(instancia_db_id)}:{str(msg_id).strip()}"


def chatbot_should_process_msg(empresa_id: int, instancia_db_id: int, msg_id: str | None) -> bool:
    raw = str(msg_id or "").strip()
    if not raw:
        return True

    now_ts = time.time()

    for k, ts in list(_CHATBOT_MSG_SEEN.items()):
        if (now_ts - float(ts)) > _CHATBOT_MSG_TTL_SECONDS:
            _CHATBOT_MSG_SEEN.pop(k, None)

    key = chatbot_seen_key(empresa_id, instancia_db_id, raw)
    if key in _CHATBOT_MSG_SEEN:
        return False

    _CHATBOT_MSG_SEEN[key] = now_ts
    return True


__all__ = [
    "INSTANCIAS_SYNC",
    "QR_RECENT",
    "remember_qr_emitted",
    "forget_qr_recent",
    "_HISTORY_DONE_AT",

    "HISTORY_MESSAGES_SET_STARTED_AT",
    "HISTORY_MESSAGES_SET_LAST_TOTAL",
    "HISTORY_MESSAGES_SET_COUNT",
    "history_mark_messages_set_started",
    "history_messages_set_started_at",
    "history_messages_set_count",
    "history_messages_set_last_total",
    "history_clear_messages_set_state",

    "chatbot_seen_key",
    "chatbot_should_process_msg",
]