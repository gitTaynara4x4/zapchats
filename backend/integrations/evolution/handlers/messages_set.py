# backend/integrations/evolution/handlers/messages_set.py

from __future__ import annotations

import asyncio
import os
from datetime import timedelta
from typing import Any

from backend import models
from backend.database import SessionLocal
from backend.websocket_manager import conexoes_ativas

from ..parsers.base_extractors import (
    extract_media_meta,
    extract_messages_any_shape,
    extract_text_from_baileys,
)
from ..services.media_service import (
    save_media_for_group_message_with_db,
    save_media_for_message_11_with_db,
)
from ..utils.ack_utils import _ack_from_status
from ..utils.cache_utils import invalidate_emp_cache
from ..utils.jid_utils import is_lid_jid, jid_strip_device
from ..utils.log_utils import LOG, _log_ctx, _short
from ..utils.phone_utils import _resolve_counterparty_num_1to1, formatar_telefone_br, remote_to_num
from ..utils.time_utils import _iso_utc, _now_utc, _server_ts_ms, _to_dt_utc
from ._state import (
    _HISTORY_DONE_AT,
    history_mark_messages_set_started,
)
from .shared import (
    EvoEvent,
    _carimbar_inst,
    _get_inst_row,
    _lid_map_set,
    _resolve_remote_jid,
    _me_number_by_inst,
    _retry_deadlock,
    avatar_from_contact_like,
    evo_get_group_subject,
    find_existing_mensagem_11_id,
    get_identity_by_remote,
    grupo_row_by_remote,
    handler,
    is_nome_grupo_ruim,
    resolve_lid_identity,
    upsert_cliente,
    upsert_whatsapp_identity,
)


def _bool_env_value(name: str, default: bool = False) -> bool:
    raw = os.getenv(name)

    if raw is None:
        return bool(default)

    value = str(raw).strip().lower()

    if value in {"1", "true", "yes", "sim", "on"}:
        return True

    if value in {"0", "false", "no", "nao", "não", "off"}:
        return False

    return bool(default)


def _float_env_value(name: str, default: float) -> float:
    try:
        raw = os.getenv(name)
        if raw is None or str(raw).strip() == "":
            return float(default)
        return float(raw)
    except Exception:
        return float(default)


ENABLE_MESSAGES_SET = _bool_env_value("ENABLE_MESSAGES_SET", False)

# =============================================================================
# Histórico / janela de importação
# =============================================================================
#
# REGRA NOVA:
# - O período escolhido no painel manda.
# - HISTORY_DISABLE_TIME_FILTER não pode ignorar 24h/7d/30d.
# - Sem filtro só quando historico_restaurar for all/full/tudo/disponivel.
# =============================================================================

HISTORY_LIMIT_HOURS = int(os.getenv("HISTORY_LIMIT_HOURS", "0") or "0")

# Mantido por compatibilidade, mas NÃO desativa filtro quando o usuário escolhe
# 24h, 7d ou 30d.
HISTORY_DISABLE_TIME_FILTER = (
    os.getenv("HISTORY_DISABLE_TIME_FILTER", "false").strip().lower()
    in {"1", "true", "yes", "sim", "on"}
)

HISTORY_IGNORE_AFTER_DONE_MIN = int(os.getenv("HISTORY_IGNORE_AFTER_DONE_MIN", "15") or "15")

# Agora 7d e 30d ficam liberados por padrão porque o front oferece essas opções.
ALLOW_HISTORY_7D = _bool_env_value("ALLOW_HISTORY_7D", True)
ALLOW_HISTORY_30D = _bool_env_value("ALLOW_HISTORY_30D", True)

HISTORY_MAX_IMPORT = int(os.getenv("HISTORY_MAX_IMPORT", "5000") or "5000")
HISTORY_BATCH_COMMIT = int(os.getenv("HISTORY_BATCH_COMMIT", "250") or "250")

# Menor por padrão para o backend respirar mais durante importação.
HISTORY_SLEEP_EVERY = int(os.getenv("HISTORY_SLEEP_EVERY", "50") or "50")

DISABLE_MEDIA_ON_HISTORY = (os.getenv("DISABLE_MEDIA_ON_HISTORY", "true").lower() == "true")

HISTORY_MARK_DONE_IN_DB = (
    os.getenv("HISTORY_MARK_DONE_IN_DB", "true").strip().lower()
    in {"1", "true", "yes", "sim", "on"}
)

CONTACTS_READY_WAIT_ENABLED = _bool_env_value("EVO_WAIT_CONTACTS_BEFORE_HISTORY", True)
CONTACTS_READY_WAIT_SEC = max(0.0, _float_env_value("EVO_CONTACTS_READY_WAIT_SEC", 6.0))
CONTACTS_READY_WAIT_INTERVAL_SEC = max(0.05, _float_env_value("EVO_CONTACTS_READY_WAIT_INTERVAL_SEC", 0.25))

HISTORY_FORCE_BACKFILL_AFTER_IMPORT = _bool_env_value("EVO_HISTORY_FORCE_BACKFILL_AFTER_IMPORT", True)

# REGRA OFICIAL:
# LID sem número real NÃO pode virar cliente visível.
HISTORY_IMPORT_UNRESOLVED_LID = _bool_env_value("EVO_HISTORY_IMPORT_UNRESOLVED_LID", False)

# Log/diagnóstico
# Deixe false em produção para não travar o terminal/sistema com logs demais.
HISTORY_TRACE_ITEMS = (
    os.getenv("HISTORY_TRACE_ITEMS", "false").strip().lower()
    in {"1", "true", "yes", "sim", "on"}
)
HISTORY_TRACE_FIRST_N = int(os.getenv("HISTORY_TRACE_FIRST_N", "20") or "20")
HISTORY_TRACE_EVERY = int(os.getenv("HISTORY_TRACE_EVERY", "100") or "100")

HISTORY_RUNTIME_LOCK_WAIT_SEC = float(os.getenv("HISTORY_RUNTIME_LOCK_WAIT_SEC", "120") or "120")

_HISTORY_RUNTIME_LOCKS: dict[tuple[int, int], asyncio.Lock] = {}

# Guarda a opção usada quando marcamos DONE.
# Serve para o caso de chegar pacote extra logo depois com historico_restaurar já none.
_HISTORY_DONE_OPTION: dict[str, str] = {}


def _is_deadlock_error(e: Exception) -> bool:
    base = getattr(e, "orig", e)
    msg = str(base).lower()
    return "deadlock detected" in msg


def _only_digits(raw: Any) -> str:
    return "".join(ch for ch in str(raw or "") if ch.isdigit())


def _same_phone(a: Any, b: Any) -> bool:
    da = _only_digits(a)
    db = _only_digits(b)

    if not da or not db:
        return False

    return da == db or da.endswith(db) or db.endswith(da)


def _telefone_invalido_para_1to1(telefone: Any) -> bool:
    digits = _only_digits(telefone)

    if not digits:
        return True

    if digits == "0":
        return True

    if len(digits) < 10:
        return True

    if len(digits) > 20:
        return True

    return False


def _normalize_historico_opcao(raw: str | None) -> str:
    h = str(raw or "none").strip().lower()

    if h in {"", "none", "no", "nao", "não", "off", "false", "0"}:
        return "none"

    if h in {"24h", "24", "1d", "1dia", "1_dia", "dia", "ultimas_24h", "últimas_24h"}:
        return "24h"

    if h in {"7d", "7", "7dias", "7_dias", "semana", "1w", "week"}:
        return "7d"

    if h in {
        "30d",
        "30",
        "30dias",
        "30_dias",
        "1m",
        "1mes",
        "1_mes",
        "mes",
        "mês",
        "month",
        "30days",
    }:
        return "30d"

    if h in {"all", "full", "tudo", "disponivel", "disponível", "available"}:
        return "all"

    # Segurança: opção desconhecida não importa tudo.
    return "none"


def _messages_set_deve_processar(historico_opcao: str | None) -> bool:
    """MESSAGES_SET só é importação manual/solicitada.

    Regra do produto: processar apenas quando a instância estiver marcada
    com historico_restaurar = 24h, 7d ou 30d.
    A flag ENABLE_MESSAGES_SET fica apenas informativa/legada e não libera
    importação sem escolha de período.
    """
    h = _normalize_historico_opcao(historico_opcao)
    return h in {"24h", "7d", "30d"}


def _get_runtime_lock(empresa_id: int, instancia_id: int) -> asyncio.Lock:
    key = (int(empresa_id), int(instancia_id))
    lock = _HISTORY_RUNTIME_LOCKS.get(key)
    if lock is None:
        lock = asyncio.Lock()
        _HISTORY_RUNTIME_LOCKS[key] = lock
    return lock


async def _acquire_runtime_lock(empresa_id: int, instancia_id: int) -> asyncio.Lock | None:
    lock = _get_runtime_lock(empresa_id, instancia_id)
    wait_sec = max(0.0, float(HISTORY_RUNTIME_LOCK_WAIT_SEC or 0))

    if not lock.locked():
        await lock.acquire()
        LOG(f"[HIST][runtime-lock] adquirido emp={empresa_id} inst={instancia_id}")
        return lock

    LOG(
        f"[HIST][runtime-lock] ocupado; aguardando "
        f"emp={empresa_id} inst={instancia_id} wait_sec={wait_sec}"
    )

    try:
        if wait_sec <= 0:
            return None

        await asyncio.wait_for(lock.acquire(), timeout=wait_sec)
        LOG(f"[HIST][runtime-lock] adquirido após espera emp={empresa_id} inst={instancia_id}")
        return lock

    except asyncio.TimeoutError:
        LOG(
            f"[HIST][runtime-lock] timeout aguardando lock; pacote será ignorado sem marcar DONE "
            f"emp={empresa_id} inst={instancia_id}"
        )
        return None


def _release_runtime_lock(lock: asyncio.Lock | None, empresa_id: int, instancia_id: int) -> None:
    if lock is None:
        return

    try:
        if lock.locked():
            lock.release()
            LOG(f"[HIST][runtime-lock] liberado emp={empresa_id} inst={instancia_id}")
    except Exception as e:
        LOG(f"[HIST][runtime-lock] erro ao liberar emp={empresa_id} inst={instancia_id}: {e}")


def _historico_sem_filtro_tempo(historico_opcao: str | None) -> bool:
    h = _normalize_historico_opcao(historico_opcao)

    # Sem filtro somente se o usuário/operação pediu explicitamente tudo.
    if h == "all":
        return True

    # IMPORTANTE:
    # Mesmo se HISTORY_DISABLE_TIME_FILTER=true no .env, não deixamos isso
    # passar por cima de 24h/7d/30d. Essa era a causa de importar tudo.
    return False


def _calcular_limite_tempo(historico_opcao: str | None):
    h = _normalize_historico_opcao(historico_opcao)

    if h == "24h":
        return _now_utc() - timedelta(hours=24)

    if h == "7d":
        return _now_utc() - timedelta(days=7)

    if h == "30d":
        return _now_utc() - timedelta(days=30)

    if _historico_sem_filtro_tempo(h):
        return None

    # Fallback legado somente para opção desconhecida/custom.
    # Como normalizamos opção desconhecida para none, isso praticamente não entra.
    if HISTORY_LIMIT_HOURS > 0 and h not in {"none", "24h", "7d", "30d", "all"}:
        return _now_utc() - timedelta(hours=HISTORY_LIMIT_HOURS)

    return None


def _safe_keys(obj: Any) -> list[str]:
    if isinstance(obj, dict):
        return list(obj.keys())[:30]
    return []


def _trace_item(idx: int, total: int, m: dict, stage: str = "item") -> None:
    if not HISTORY_TRACE_ITEMS:
        return

    if idx <= HISTORY_TRACE_FIRST_N or (HISTORY_TRACE_EVERY > 0 and idx % HISTORY_TRACE_EVERY == 0):
        key = m.get("key") if isinstance(m.get("key"), dict) else {}
        msg_id = key.get("id") or m.get("id")
        remote = key.get("remoteJid") or key.get("remote_jid") or m.get("remoteJid") or m.get("jid") or m.get("chatId")
        from_me = key.get("fromMe")
        ts_raw = m.get("messageTimestamp") or m.get("timestamp")
        LOG(
            f"[HIST][trace][{stage}] idx={idx}/{total} "
            f"msg_id={msg_id} remote={remote} from_me={from_me} "
            f"ts_raw={ts_raw} messageType={m.get('messageType')} "
            f"status={m.get('status')} keys={_safe_keys(m)}"
        )


def _raw_remote_from_history_item(key: dict, message_item: dict) -> str:
    raw_remote = (
        key.get("remoteJid")
        or key.get("remote_jid")
        or message_item.get("remoteJid")
        or message_item.get("remote_jid")
        or message_item.get("jid")
        or message_item.get("chatId")
        or ""
    )
    return jid_strip_device(raw_remote)


def _history_lid_stats(mensagens: list[dict]) -> dict[str, Any]:
    total_items = 0
    total_lids = 0
    first_lid = None
    last_lid = None

    for m in mensagens or []:
        if not isinstance(m, dict):
            continue

        total_items += 1
        key = m.get("key") if isinstance(m.get("key"), dict) else {}
        raw_remote = _raw_remote_from_history_item(key, m)

        if raw_remote and is_lid_jid(raw_remote):
            total_lids += 1
            if first_lid is None:
                first_lid = raw_remote
            last_lid = raw_remote

    return {
        "total_items": total_items,
        "total_lids": total_lids,
        "first_lid": first_lid,
        "last_lid": last_lid,
    }


async def _wait_contacts_ready_before_history(
    *,
    inst_id: str,
    empresa_id: int,
    instancia_id: int,
    mensagens: list[dict],
) -> bool:
    stats = _history_lid_stats(mensagens)

    if int(stats.get("total_lids") or 0) <= 0:
        LOG(
            f"[HIST][contacts-ready] sem LID no pacote; não precisa esperar "
            f"inst={inst_id} empresa_id={empresa_id} instancia_id={instancia_id} "
            f"total_items={stats.get('total_items')}"
        )
        return True

    if not CONTACTS_READY_WAIT_ENABLED:
        LOG(
            f"[HIST][contacts-ready] espera desabilitada por EVO_WAIT_CONTACTS_BEFORE_HISTORY=false; "
            f"inst={inst_id} empresa_id={empresa_id} instancia_id={instancia_id} "
            f"total_lids={stats.get('total_lids')}"
        )
        return False

    try:
        from .contacts import get_contacts_ready_state, wait_contacts_ready
    except Exception as e:
        LOG(
            f"[HIST][contacts-ready][erro] não consegui importar helper de contacts.py; "
            f"inst={inst_id} err={e}; vou seguir sem criar LID visível"
        )
        return False

    try:
        ready_state = get_contacts_ready_state(
            empresa_id=int(empresa_id),
            instancia_id=int(instancia_id),
            inst_name=inst_id,
        )

        if ready_state:
            LOG(
                f"[HIST][contacts-ready] já pronto antes do histórico "
                f"inst={inst_id} empresa_id={empresa_id} instancia_id={instancia_id} "
                f"total_lids={stats.get('total_lids')} state_stats={ready_state.get('stats')}"
            )
            return True

        LOG(
            f"[HIST][contacts-ready] aguardando pacote grande de contacts antes do histórico "
            f"inst={inst_id} empresa_id={empresa_id} instancia_id={instancia_id} "
            f"wait_sec={CONTACTS_READY_WAIT_SEC} total_lids={stats.get('total_lids')} "
            f"first_lid={stats.get('first_lid')} last_lid={stats.get('last_lid')}"
        )

        ok = await wait_contacts_ready(
            empresa_id=int(empresa_id),
            instancia_id=int(instancia_id),
            inst_name=inst_id,
            timeout_sec=float(CONTACTS_READY_WAIT_SEC),
            interval_sec=float(CONTACTS_READY_WAIT_INTERVAL_SEC),
        )

        if ok:
            ready_state = get_contacts_ready_state(
                empresa_id=int(empresa_id),
                instancia_id=int(instancia_id),
                inst_name=inst_id,
            )

            LOG(
                f"[HIST][contacts-ready] pronto após espera; vou importar histórico com mapa "
                f"inst={inst_id} empresa_id={empresa_id} instancia_id={instancia_id} "
                f"total_lids={stats.get('total_lids')} state_stats={ready_state.get('stats') if ready_state else None}"
            )
            return True

        LOG(
            f"[HIST][contacts-ready][timeout] contacts_ready não chegou em {CONTACTS_READY_WAIT_SEC}s; "
            f"NÃO vou criar cliente visível com LID. Mensagens LID sem número real serão ignoradas "
            f"até o contato/número correto chegar pelo contacts.upsert/update. "
            f"inst={inst_id} empresa_id={empresa_id} instancia_id={instancia_id} "
            f"total_lids={stats.get('total_lids')} first_lid={stats.get('first_lid')} last_lid={stats.get('last_lid')}"
        )
        return False

    except Exception as e:
        LOG(
            f"[HIST][contacts-ready][erro] falha aguardando contacts_ready; "
            f"vou seguir sem criar LID visível inst={inst_id} empresa_id={empresa_id} "
            f"instancia_id={instancia_id} err={e}"
        )
        return False


def _force_contacts_backfill_after_history(
    *,
    inst_id: str,
    empresa_id: int,
    instancia_id: int,
) -> dict[str, int]:
    result = {
        "cleanup": 0,
        "backfill_clientes": 0,
    }

    if not HISTORY_FORCE_BACKFILL_AFTER_IMPORT:
        LOG(
            f"[HIST][post-backfill] desabilitado por EVO_HISTORY_FORCE_BACKFILL_AFTER_IMPORT=false "
            f"inst={inst_id}"
        )
        return result

    try:
        from .contacts import (
            _backfill_clientes_lid_from_identities,
            _cleanup_fake_identity_names,
        )
    except Exception as e:
        LOG(f"[HIST][post-backfill][erro] não consegui importar contacts.py helpers inst={inst_id} err={e}")
        return result

    with SessionLocal() as db_bf:
        try:
            cleanup_total = _cleanup_fake_identity_names(
                db_bf,
                empresa_id=int(empresa_id),
                instancia_id=int(instancia_id),
            )

            backfill_total = _backfill_clientes_lid_from_identities(
                db_bf,
                empresa_id=int(empresa_id),
                instancia_id=int(instancia_id),
            )

            db_bf.commit()

            result["cleanup"] = int(cleanup_total or 0)
            result["backfill_clientes"] = int(backfill_total or 0)

            LOG(
                f"[HIST][post-backfill] finalizado inst={inst_id} "
                f"empresa_id={empresa_id} instancia_id={instancia_id} "
                f"cleanup={cleanup_total} backfill_clientes={backfill_total}"
            )

            if cleanup_total or backfill_total:
                try:
                    invalidate_emp_cache(int(empresa_id))
                except Exception:
                    pass

            return result

        except Exception as e:
            try:
                db_bf.rollback()
            except Exception:
                pass

            LOG(
                f"[HIST][post-backfill][erro] inst={inst_id} "
                f"empresa_id={empresa_id} instancia_id={instancia_id} err={e}"
            )
            return result


def _normalize_real_jid_candidate(
    value: Any,
    *,
    me_num: str | None,
    raw_lid: str | None,
) -> str | None:
    if value is None:
        return None

    s = str(value or "").strip()
    if not s:
        return None

    s = jid_strip_device(s)
    low = s.lower()

    if raw_lid and s == raw_lid:
        return None

    if "@g.us" in low:
        return None

    if is_lid_jid(s):
        return None

    if "@s.whatsapp.net" in low or "@c.us" in low:
        tel = remote_to_num(s)
        if not tel:
            return None

        if me_num and _same_phone(tel, me_num):
            return None

        return f"{tel}@s.whatsapp.net"

    if "@" in s:
        return None

    digits = _only_digits(s)

    if len(digits) < 10 or len(digits) > 15:
        return None

    if me_num and _same_phone(digits, me_num):
        return None

    return f"{digits}@s.whatsapp.net"


def _iter_candidate_strings(obj: Any, *, depth: int = 0, path: str = "$"):
    if depth > 8:
        return

    candidate_key_parts = (
        "jid",
        "phone",
        "number",
        "user",
        "participant",
        "sender",
        "remote",
        "author",
        "wid",
        "wuid",
        "whatsapp",
        "from",
        "to",
    )

    if isinstance(obj, dict):
        for k, v in obj.items():
            key_low = str(k or "").lower()
            child_path = f"{path}.{k}"

            if isinstance(v, str):
                val = v.strip()
                if not val:
                    continue

                if "@" in val:
                    yield child_path, val
                    continue

                if any(part in key_low for part in candidate_key_parts):
                    yield child_path, val
                    continue

            elif isinstance(v, (dict, list, tuple)):
                yield from _iter_candidate_strings(v, depth=depth + 1, path=child_path)

    elif isinstance(obj, (list, tuple)):
        for i, item in enumerate(obj):
            yield from _iter_candidate_strings(item, depth=depth + 1, path=f"{path}[{i}]")


def _known_alt_values_for_lid(key: dict, message_item: dict) -> list[tuple[str, Any]]:
    out: list[tuple[str, Any]] = []

    known_keys = [
        "remoteJidAlt",
        "remote_jid_alt",
        "participantAlt",
        "participant_alt",
        "senderAlt",
        "sender_alt",
        "authorAlt",
        "author_alt",
        "fromAlt",
        "toAlt",
        "participant",
        "sender",
        "author",
        "from",
        "to",
        "user",
        "wuid",
        "wid",
        "phone",
        "number",
        "phoneNumber",
        "phone_number",
    ]

    for source_name, source in (("key", key), ("item", message_item)):
        if not isinstance(source, dict):
            continue

        for k in known_keys:
            if k in source:
                out.append((f"{source_name}.{k}", source.get(k)))

    context = message_item.get("contextInfo")
    if isinstance(context, dict):
        for k in known_keys:
            if k in context:
                out.append((f"contextInfo.{k}", context.get(k)))

    message = message_item.get("message")
    if isinstance(message, dict):
        for msg_type, msg_body in message.items():
            if isinstance(msg_body, dict):
                ctx = msg_body.get("contextInfo")
                if isinstance(ctx, dict):
                    for k in known_keys:
                        if k in ctx:
                            out.append((f"message.{msg_type}.contextInfo.{k}", ctx.get(k)))

                for k in known_keys:
                    if k in msg_body:
                        out.append((f"message.{msg_type}.{k}", msg_body.get(k)))

    return out


def _register_lid_map(
    *,
    empresa_id: int,
    instancia_id: int,
    raw_lid: str,
    real_jid: str | None,
    source: str,
    local_lid_map: dict[str, str] | None = None,
) -> str | None:
    if not raw_lid or not real_jid:
        return None

    raw_lid = jid_strip_device(raw_lid)
    real_jid = jid_strip_device(real_jid)

    if not is_lid_jid(raw_lid):
        return None

    if is_lid_jid(real_jid):
        return None

    if "@g.us" in real_jid:
        return None

    if not ("@s.whatsapp.net" in real_jid or "@c.us" in real_jid):
        return None

    if "@c.us" in real_jid:
        tel = remote_to_num(real_jid)
        if tel:
            real_jid = f"{tel}@s.whatsapp.net"

    try:
        _lid_map_set(empresa_id, instancia_id, raw_lid, real_jid)
    except Exception as e:
        LOG(f"[HIST][lid-map][warn] falha _lid_map_set raw={raw_lid} real={real_jid}: {e}")

    if local_lid_map is not None:
        local_lid_map[raw_lid] = real_jid

    LOG(
        f"[HIST][lid-map] {raw_lid} -> {real_jid} "
        f"source={source} empresa_id={empresa_id} instancia_id={instancia_id}"
    )

    return real_jid


def _resolve_lid_to_real_from_item(
    *,
    empresa_id: int,
    instancia_id: int,
    raw_lid: str,
    key: dict,
    message_item: dict,
    me_num: str | None,
    local_lid_map: dict[str, str] | None = None,
    log_prefix: str = "[HIST][lid-resolve]",
) -> str | None:
    raw_lid = jid_strip_device(raw_lid)

    if not raw_lid or not is_lid_jid(raw_lid):
        return None

    if local_lid_map is not None:
        mapped_local = local_lid_map.get(raw_lid)
        if mapped_local:
            return mapped_local

    try:
        mapped = _resolve_remote_jid(empresa_id, instancia_id, raw_lid)
        mapped = jid_strip_device(mapped or "")
        if mapped and mapped != raw_lid and not is_lid_jid(mapped):
            real = _normalize_real_jid_candidate(mapped, me_num=me_num, raw_lid=raw_lid)
            if real:
                return _register_lid_map(
                    empresa_id=empresa_id,
                    instancia_id=instancia_id,
                    raw_lid=raw_lid,
                    real_jid=real,
                    source="identity_map",
                    local_lid_map=local_lid_map,
                )
    except Exception as e:
        LOG(f"{log_prefix} falha consultando identity_map raw={raw_lid}: {e}")

    for path, value in _known_alt_values_for_lid(key, message_item):
        real = _normalize_real_jid_candidate(value, me_num=me_num, raw_lid=raw_lid)
        if real:
            return _register_lid_map(
                empresa_id=empresa_id,
                instancia_id=instancia_id,
                raw_lid=raw_lid,
                real_jid=real,
                source=f"known:{path}",
                local_lid_map=local_lid_map,
            )

    try:
        tel_fallback, alt = _resolve_counterparty_num_1to1(message_item, me_num)

        real_alt = _normalize_real_jid_candidate(alt, me_num=me_num, raw_lid=raw_lid)
        if real_alt:
            return _register_lid_map(
                empresa_id=empresa_id,
                instancia_id=instancia_id,
                raw_lid=raw_lid,
                real_jid=real_alt,
                source="counterparty_alt",
                local_lid_map=local_lid_map,
            )

        if tel_fallback and not str(tel_fallback).startswith("LID-"):
            real_tel = _normalize_real_jid_candidate(tel_fallback, me_num=me_num, raw_lid=raw_lid)
            if real_tel:
                return _register_lid_map(
                    empresa_id=empresa_id,
                    instancia_id=instancia_id,
                    raw_lid=raw_lid,
                    real_jid=real_tel,
                    source="counterparty_tel",
                    local_lid_map=local_lid_map,
                )

    except Exception as e:
        LOG(f"{log_prefix} falha counterparty raw={raw_lid}: {e}")

    for path, value in _iter_candidate_strings(message_item):
        real = _normalize_real_jid_candidate(value, me_num=me_num, raw_lid=raw_lid)
        if real:
            return _register_lid_map(
                empresa_id=empresa_id,
                instancia_id=instancia_id,
                raw_lid=raw_lid,
                real_jid=real,
                source=f"deep:{path}",
                local_lid_map=local_lid_map,
            )

    return None


def _build_lid_map_from_history_batch(
    *,
    empresa_id: int,
    instancia_id: int,
    mensagens: list[dict],
    me_num: str | None,
) -> dict[str, str]:
    lid_map: dict[str, str] = {}
    total_lids = 0
    resolved = 0

    for idx, m in enumerate(mensagens, start=1):
        if not isinstance(m, dict):
            continue

        key = m.get("key") if isinstance(m.get("key"), dict) else {}
        raw_remote = _raw_remote_from_history_item(key, m)

        if not raw_remote or not is_lid_jid(raw_remote):
            continue

        total_lids += 1

        if raw_remote in lid_map:
            continue

        real = _resolve_lid_to_real_from_item(
            empresa_id=empresa_id,
            instancia_id=instancia_id,
            raw_lid=raw_remote,
            key=key,
            message_item=m,
            me_num=me_num,
            local_lid_map=lid_map,
            log_prefix="[HIST][lid-map-build]",
        )

        if real:
            resolved += 1
            LOG(
                f"[HIST][lid-map-build] resolvido idx={idx} "
                f"raw={raw_remote} real={real}"
            )

    LOG(
        f"[HIST][lid-map-build] resumo empresa_id={empresa_id} instancia_id={instancia_id} "
        f"lids_encontrados={total_lids} lids_resolvidos={resolved} mapa={len(lid_map)}"
    )

    return lid_map


def _resolve_remote_jid_history(
    *,
    empresa_id: int,
    instancia_id: int,
    key: dict,
    message_item: dict,
    me_num: str | None,
    local_lid_map: dict[str, str] | None = None,
) -> str | None:
    raw_remote = _raw_remote_from_history_item(key, message_item)

    if not raw_remote:
        return None

    if not is_lid_jid(raw_remote):
        return raw_remote

    real = _resolve_lid_to_real_from_item(
        empresa_id=empresa_id,
        instancia_id=instancia_id,
        raw_lid=raw_remote,
        key=key,
        message_item=message_item,
        me_num=me_num,
        local_lid_map=local_lid_map,
        log_prefix="[HIST][lid-resolve]",
    )

    if real:
        return real

    if HISTORY_IMPORT_UNRESOLVED_LID:
        LOG(
            f"[HIST][lid-fallback][legacy] sem telefone real para {raw_remote}; "
            "EVO_HISTORY_IMPORT_UNRESOLVED_LID=true, então vou importar como LID provisório."
        )
        return raw_remote

    LOG(
        f"[HIST][lid-pending] sem telefone real para {raw_remote}; "
        "não vou criar cliente/conversa visível com LID."
    )
    return None


def _lid_digits_from_jid(raw: str | None) -> str | None:
    s = jid_strip_device(raw or "")
    if not s or not is_lid_jid(s):
        return None

    left = s.split("@", 1)[0]
    digits = "".join(ch for ch in left if ch.isdigit())
    return digits or None


def _same_name_ci(a: Any, b: Any) -> bool:
    sa = str(a or "").strip().casefold()
    sb = str(b or "").strip().casefold()
    return bool(sa and sb and sa == sb)


def _push_name_ruim_para_historico(push_name: Any, *, raw_remote_jid: str | None, telefone: str | None) -> bool:
    push = str(push_name or "").strip()
    if not push:
        return True

    low = push.lower().strip()

    if low in {
        "você",
        "voce",
        "you",
        "cliente",
        "contato",
        "unknown",
        "desconhecido",
        "0",
        "contato whatsapp",
        "whatsapp",
    }:
        return True

    if low.startswith("contato do whatsapp"):
        return True

    if low.startswith("contato whatsapp"):
        return True

    if low.startswith("contato lid"):
        return True

    digits_push = _only_digits(push)
    raw_lid_digits = _lid_digits_from_jid(raw_remote_jid)

    if raw_lid_digits and digits_push and digits_push == raw_lid_digits:
        return True

    if digits_push and len(digits_push) >= 13 and push == digits_push:
        return True

    if telefone and digits_push and _same_phone(digits_push, telefone):
        return True

    return False


def _primeiro_nome_real_para_historico(
    candidatos: list[Any],
    *,
    raw_remote_jid: str | None,
    telefone: str | None,
) -> str | None:
    for candidato in candidatos:
        nome = str(candidato or "").strip()
        if not nome:
            continue

        if not _push_name_ruim_para_historico(nome, raw_remote_jid=raw_remote_jid, telefone=telefone):
            return nome

    return None


def _nome_contato_historico(
    *,
    remote_jid: str,
    raw_remote_jid: str | None,
    telefone: str,
    push_name: Any,
    from_me: bool,
) -> str:
    push = str(push_name or "").strip()

    if not _push_name_ruim_para_historico(push, raw_remote_jid=raw_remote_jid, telefone=telefone):
        return push

    return formatar_telefone_br(telefone) or telefone or "Cliente"


def _identity_hint_for_remote(
    db,
    *,
    empresa_id: int,
    instancia_id: int,
    raw_remote_jid: str | None,
) -> dict[str, Any]:
    raw = jid_strip_device(raw_remote_jid or "")

    out: dict[str, Any] = {
        "remote_jid": raw,
        "real_jid": None,
        "lid_jid": raw if is_lid_jid(raw) else None,
        "telefone_norm": None,
        "push_name": None,
        "profile_pic_url": None,
        "cliente_id": None,
        "resolved": False,
        "confianca": 0,
        "resolved_by": None,
    }

    if not raw:
        return out

    try:
        if is_lid_jid(raw):
            info = resolve_lid_identity(
                db,
                empresa_id=int(empresa_id),
                instancia_id=int(instancia_id),
                lid_jid=raw,
            )
            if isinstance(info, dict):
                out.update(info)

            if _push_name_ruim_para_historico(
                out.get("push_name"),
                raw_remote_jid=raw,
                telefone=out.get("telefone_norm"),
            ):
                out["push_name"] = None

            return out

        row = get_identity_by_remote(
            db,
            empresa_id=int(empresa_id),
            instancia_id=int(instancia_id),
            remote_jid=raw,
        )

        if row:
            out.update(
                {
                    "remote_jid": row.real_jid or row.remote_jid or raw,
                    "real_jid": row.real_jid,
                    "lid_jid": row.lid_jid,
                    "telefone_norm": row.telefone_norm,
                    "push_name": row.push_name,
                    "profile_pic_url": row.profile_pic_url,
                    "cliente_id": row.cliente_id,
                    "resolved": bool(row.real_jid),
                    "confianca": int(row.confianca or 0),
                    "resolved_by": row.resolved_by,
                }
            )

            if _push_name_ruim_para_historico(
                out.get("push_name"),
                raw_remote_jid=raw,
                telefone=out.get("telefone_norm"),
            ):
                out["push_name"] = None

    except Exception as e:
        LOG(
            f"[HIST][identity-hint][erro] empresa_id={empresa_id} "
            f"instancia_id={instancia_id} raw={raw} err={e}"
        )

    return out


def _mark_history_done_in_db(
    db,
    *,
    inst_id: str,
    empresa_id: int,
    instancia_id: int,
    historico_opcao: str,
    total: int,
    novas: int,
    duplicadas: int,
    skips: int,
    erros: int,
    lid_pending_skips: int,
    time_window_skips: int,
) -> bool:
    """
    Marca histórico como concluído.

    Regras:
    - Se salvou mensagem ou só encontrou duplicadas, pode concluir.
    - Se não salvou nada porque tudo era LID pendente, NÃO conclui.
    - Se não salvou nada porque tudo estava fora da janela escolhida, conclui.
      Exemplo: usuário escolheu 24h e todas as mensagens eram antigas.
    """
    if not HISTORY_MARK_DONE_IN_DB:
        LOG(
            f"[HIST][done-db] desabilitado por HISTORY_MARK_DONE_IN_DB=false "
            f"inst={inst_id}"
        )
        return False

    h = _normalize_historico_opcao(historico_opcao)

    if h == "none":
        return False

    if total <= 0:
        return False

    if erros > 0:
        LOG(
            f"[HIST][done-db] não marquei como concluído porque houve erros "
            f"inst={inst_id} total={total} novas={novas} duplicadas={duplicadas} "
            f"skips={skips} lid_pending_skips={lid_pending_skips} "
            f"time_window_skips={time_window_skips} erros={erros}"
        )
        return False

    if int(novas or 0) <= 0 and int(duplicadas or 0) <= 0:
        if int(lid_pending_skips or 0) > 0:
            LOG(
                f"[HIST][done-db] NÃO marquei como concluído porque não importou nenhuma mensagem "
                f"e houve LID pendente. inst={inst_id} total={total} novas={novas} "
                f"duplicadas={duplicadas} skips={skips} lid_pending_skips={lid_pending_skips} "
                f"time_window_skips={time_window_skips}. "
                "Vou manter historico_restaurar pendente para aceitar pacote maior depois."
            )
            return False

        if int(time_window_skips or 0) > 0 and int(time_window_skips or 0) >= int(skips or 0):
            LOG(
                f"[HIST][done-db] vou marcar como concluído porque o pacote foi processado "
                f"e todas as mensagens estavam fora da janela escolhida. "
                f"inst={inst_id} historico={h} total={total} "
                f"time_window_skips={time_window_skips}"
            )
        else:
            LOG(
                f"[HIST][done-db] NÃO marquei como concluído porque não importou nenhuma mensagem "
                f"inst={inst_id} total={total} novas={novas} duplicadas={duplicadas} "
                f"skips={skips} lid_pending_skips={lid_pending_skips} "
                f"time_window_skips={time_window_skips}."
            )
            return False

    try:
        row = (
            db.query(models.EmpresaInstancia)
            .filter(models.EmpresaInstancia.id == instancia_id)
            .first()
        )

        if not row:
            LOG(
                f"[HIST][done-db] instância não encontrada para marcar concluído "
                f"inst={inst_id} instancia_id={instancia_id}"
            )
            return False

        if hasattr(row, "historico_restaurar"):
            row.historico_restaurar = "none"

        for attr in ("historico_status", "history_status"):
            if hasattr(row, attr):
                try:
                    setattr(row, attr, "done")
                except Exception:
                    pass

        for attr in (
            "historico_finalizado_em",
            "historico_restaurado_em",
            "historico_done_at",
            "history_completed_at",
            "history_done_at",
        ):
            if hasattr(row, attr):
                try:
                    setattr(row, attr, _now_utc())
                except Exception:
                    pass

        db.add(row)
        db.commit()

        LOG(
            f"[HIST][done-db] histórico concluído e historico_restaurar=none "
            f"inst={inst_id} empresa_id={empresa_id} instancia_id={instancia_id} "
            f"historico={h} total={total} novas={novas} duplicadas={duplicadas} "
            f"skips={skips} lid_pending_skips={lid_pending_skips} "
            f"time_window_skips={time_window_skips}"
        )

        return True

    except Exception as e:
        try:
            db.rollback()
        except Exception:
            pass

        LOG(
            f"[HIST][done-db] falha ao marcar histórico concluído "
            f"inst={inst_id} empresa_id={empresa_id} instancia_id={instancia_id}: {e}"
        )
        return False


async def _emit_history_start(empresa_id: int, total: int) -> None:
    try:
        await conexoes_ativas.send_message(
            f"emp:{empresa_id}",
            {
                "type": "history_sync_start",
                "total": total,
                "serverTimestamp": _server_ts_ms(),
            },
        )
    except Exception:
        pass


async def _emit_history_progress(
    empresa_id: int,
    *,
    total: int,
    imported: int,
    lock_busy: bool = False,
) -> None:
    try:
        await conexoes_ativas.send_message(
            f"emp:{empresa_id}",
            {
                "type": "history_sync_progress",
                "total": total,
                "imported": imported,
                "lock_busy": bool(lock_busy),
                "serverTimestamp": _server_ts_ms(),
            },
        )
    except Exception:
        pass


async def _emit_history_done(empresa_id: int, *, total: int, imported: int) -> None:
    try:
        await conexoes_ativas.send_message(
            f"emp:{empresa_id}",
            {
                "type": "history_sync_done",
                "total": total,
                "imported": imported,
                "serverTimestamp": _server_ts_ms(),
            },
        )
    except Exception:
        pass


@handler(EvoEvent.MESSAGES_SET)
async def on_messages_set(inst_id: str, data):
    PROG_STEP = 100

    with SessionLocal() as db:
        inst = _get_inst_row(db, inst_id)
        if not inst:
            LOG(f"[MESSAGES_SET] Instância não encontrada: {inst_id}")
            return

        empresa_id = int(inst.empresa_id)
        instancia_id = int(inst.id)
        historico_original = getattr(inst, "historico_restaurar", None)
        historico_opcao = _normalize_historico_opcao(historico_original)

        if not _messages_set_deve_processar(historico_opcao):
            LOG(
                f"[MESSAGES_SET] Ignorado: ENABLE_MESSAGES_SET=false e sem histórico pendente "
                f"inst={inst_id} historico={historico_opcao}"
            )
            return

        if ENABLE_MESSAGES_SET:
            LOG(
                f"[MESSAGES_SET] ENABLE_MESSAGES_SET=true está no ENV, mas a regra atual "
                f"só processa porque historico_restaurar={historico_opcao} foi escolhido para inst={inst_id}"
            )

        if historico_opcao == "7d" and not ALLOW_HISTORY_7D:
            _log_ctx("[HIST] downgrade 7d→24h", inst=inst_id)
            historico_opcao = "24h"

        if historico_opcao == "30d" and not ALLOW_HISTORY_30D:
            if ALLOW_HISTORY_7D:
                _log_ctx("[HIST] downgrade 30d→7d", inst=inst_id)
                historico_opcao = "7d"
            else:
                _log_ctx("[HIST] downgrade 30d→24h", inst=inst_id)
                historico_opcao = "24h"

        mensagens = extract_messages_any_shape(data)
        total = len(mensagens)

        # ============================================================
        # Watchdog:
        # marca que o MESSAGES_SET chegou para esta instância.
        # O connection.py vai consultar isso para saber se precisa reaplicar
        # syncFullHistory/rabbit quando a Evolution não entrega histórico.
        # ============================================================
        history_mark_messages_set_started(inst_id, total=total)
        LOG(f"[HISTORY][watchdog] MESSAGES_SET recebido inst={inst_id} total={total}")

        _log_ctx(
            "[HIST] start",
            inst=inst_id,
            empresa_id=empresa_id,
            instancia_id=instancia_id,
            historico_original=historico_original,
            historico_opcao=historico_opcao,
            total=total,
            HISTORY_DISABLE_TIME_FILTER=HISTORY_DISABLE_TIME_FILTER,
            HISTORY_LIMIT_HOURS=HISTORY_LIMIT_HOURS,
            ALLOW_HISTORY_7D=ALLOW_HISTORY_7D,
            ALLOW_HISTORY_30D=ALLOW_HISTORY_30D,
            DISABLE_MEDIA_ON_HISTORY=DISABLE_MEDIA_ON_HISTORY,
            HISTORY_MAX_IMPORT=HISTORY_MAX_IMPORT,
            HISTORY_BATCH_COMMIT=HISTORY_BATCH_COMMIT,
            HISTORY_SLEEP_EVERY=HISTORY_SLEEP_EVERY,
            HISTORY_RUNTIME_LOCK_WAIT_SEC=HISTORY_RUNTIME_LOCK_WAIT_SEC,
            HISTORY_MARK_DONE_IN_DB=HISTORY_MARK_DONE_IN_DB,
            CONTACTS_READY_WAIT_ENABLED=CONTACTS_READY_WAIT_ENABLED,
            CONTACTS_READY_WAIT_SEC=CONTACTS_READY_WAIT_SEC,
            HISTORY_FORCE_BACKFILL_AFTER_IMPORT=HISTORY_FORCE_BACKFILL_AFTER_IMPORT,
            HISTORY_IMPORT_UNRESOLVED_LID=HISTORY_IMPORT_UNRESOLVED_LID,
            data_type=type(data).__name__,
        )

        if HISTORY_DISABLE_TIME_FILTER and historico_opcao in {"24h", "7d", "30d"}:
            LOG(
                f"[HIST][janela] HISTORY_DISABLE_TIME_FILTER=true está no env, "
                f"mas será ignorado porque o período escolhido foi {historico_opcao}. "
                "O filtro por data será aplicado normalmente."
            )

        if not mensagens:
            LOG(
                f"[MESSAGES_SET] pacote vazio recebido para {inst_id}; "
                "não marca DONE, não pega lock e aguarda pacote cheio."
            )
            await _emit_history_progress(empresa_id, total=0, imported=0)
            return

        now_s = _now_utc().timestamp()
        last = _HISTORY_DONE_AT.get(inst_id)
        done_recente = bool(last and (now_s - last) < (HISTORY_IGNORE_AFTER_DONE_MIN * 60))

        if done_recente:
            LOG(
                f"[MESSAGES_SET] pacote real chegou mesmo com DONE recente "
                f"inst={inst_id} total={total} done_ha={int(now_s - last)}s; "
                "vou processar e deixar o banco pular duplicadas."
            )

        await _emit_history_start(empresa_id, total)

        if historico_opcao == "none" and not done_recente:
            LOG(
                f"[MESSAGES_SET] historico_restaurar=none; pacote real ignorado "
                f"inst={inst_id} total={total}"
            )
            await _emit_history_done(empresa_id, total=total, imported=0)
            return

        if historico_opcao == "none" and done_recente:
            historico_recente = _normalize_historico_opcao(_HISTORY_DONE_OPTION.get(inst_id) or "24h")
            LOG(
                f"[MESSAGES_SET] historico_restaurar=none, mas DONE é recente; "
                f"vou processar pacote extra usando janela anterior={historico_recente} "
                f"inst={inst_id} total={total}"
            )
            historico_opcao = historico_recente

        await _wait_contacts_ready_before_history(
            inst_id=inst_id,
            empresa_id=empresa_id,
            instancia_id=instancia_id,
            mensagens=mensagens,
        )

        runtime_lock = await _acquire_runtime_lock(empresa_id, instancia_id)

        if runtime_lock is None:
            LOG(
                f"[MESSAGES_SET] não consegui runtime lock; não vou marcar DONE "
                f"inst={inst_id} empresa_id={empresa_id} instancia_id={instancia_id} total={total}"
            )
            await _emit_history_progress(empresa_id, total=total, imported=0, lock_busy=True)
            return

        try:
            limite_tempo = _calcular_limite_tempo(historico_opcao)

            novas = 0
            duplicadas = 0
            skips = 0
            erros = 0
            lid_pending_skips = 0
            time_window_skips = 0
            last_commit_novas = 0
            me_num = _me_number_by_inst(inst)
            cap = max(1, int(HISTORY_MAX_IMPORT))

            local_lid_map = _build_lid_map_from_history_batch(
                empresa_id=empresa_id,
                instancia_id=instancia_id,
                mensagens=mensagens,
                me_num=me_num,
            )

            cliente_cache: dict[str, int] = {}

            if limite_tempo is None:
                _log_ctx(
                    "[HIST] janela/limites",
                    historico=historico_opcao,
                    limite_utc="SEM_FILTRO_DE_TEMPO",
                    cap=cap,
                    detalhe="aceitando tudo que a Evolution mandar",
                )
            else:
                _log_ctx(
                    "[HIST] janela/limites",
                    historico=historico_opcao,
                    limite_utc=_iso_utc(limite_tempo),
                    cap=cap,
                )

            try:
                RECENT_SEC = int(os.getenv("HISTORY_RECENT_WS_SEC", "120") or "120")
            except Exception:
                RECENT_SEC = 120

            for idx, m in enumerate(mensagens, start=1):
                if novas >= cap:
                    _log_ctx("[HIST] cap atingido", novas=novas, cap=cap)
                    break

                if not isinstance(m, dict):
                    skips += 1
                    _log_ctx("[HIST][skip] m não é dict", idx=idx, type_m=type(m).__name__)
                    continue

                _trace_item(idx, total, m, stage="in")

                key = m.get("key") if isinstance(m.get("key"), dict) else {}
                msg_id = key.get("id") or m.get("id")
                ts_raw = m.get("messageTimestamp") or m.get("timestamp") or 0
                raw_remote_jid = _raw_remote_from_history_item(key, m)

                try:
                    ts_msg = _to_dt_utc(ts_raw)
                except Exception:
                    skips += 1
                    _log_ctx("[HIST][skip] ts inválido", idx=idx, msg_id=msg_id, ts_raw=ts_raw)
                    continue

                if limite_tempo is not None and ts_msg < limite_tempo:
                    skips += 1
                    time_window_skips += 1

                    _log_ctx(
                        "[HIST][skip] fora da janela escolhida",
                        idx=idx,
                        msg_id=msg_id,
                        historico=historico_opcao,
                        ts=_iso_utc(ts_msg),
                        limite_utc=_iso_utc(limite_tempo),
                    )
                    continue

                remote_jid = _resolve_remote_jid_history(
                    empresa_id=empresa_id,
                    instancia_id=instancia_id,
                    key=key,
                    message_item=m,
                    me_num=me_num,
                    local_lid_map=local_lid_map,
                )

                if not remote_jid:
                    skips += 1

                    if raw_remote_jid and is_lid_jid(raw_remote_jid):
                        lid_pending_skips += 1

                    _log_ctx(
                        "[HIST][skip] sem remoteJid real resolvido",
                        idx=idx,
                        msg_id=msg_id,
                        raw_remote_jid=raw_remote_jid,
                    )
                    continue

                # =========================
                # GRUPO
                # =========================
                if remote_jid.endswith("@g.us"):
                    try:
                        from_me = bool(key.get("fromMe", False))
                        author_j = (key.get("participant") or m.get("participant") or "")
                        author_j = jid_strip_device(author_j) if isinstance(author_j, str) else ""
                        conteudo = extract_text_from_baileys(m)
                        media_meta = None if DISABLE_MEDIA_ON_HISTORY else extract_media_meta(m)

                        grupo = grupo_row_by_remote(
                            db,
                            empresa_id,
                            remote_jid,
                            instancia_id=instancia_id,
                            inst_obj=inst,
                        )

                        try:
                            if is_nome_grupo_ruim(getattr(grupo, "nome", None)):
                                subject = evo_get_group_subject(
                                    getattr(inst, "instance_name", inst_id),
                                    remote_jid,
                                )
                                if subject and (grupo.nome or "") != subject:
                                    grupo.nome = subject
                        except Exception:
                            pass

                        avatar = avatar_from_contact_like(m)
                        if avatar and (getattr(grupo, "avatar_url", None) or "") != avatar:
                            grupo.avatar_url = avatar

                        _carimbar_inst(grupo, inst)

                        if msg_id and db.query(models.MensagemGrupo.id).filter_by(
                            grupo_id=grupo.id,
                            msg_id=str(msg_id),
                        ).first():
                            duplicadas += 1
                            _log_ctx("[HIST][skip] duplicada (grupo)", idx=idx, msg_id=msg_id, grupo_id=grupo.id)
                            continue

                        cli_autor_id = None

                        try:
                            tel_autor = remote_to_num(author_j) if author_j else None
                            if tel_autor and (not me_num or not _same_phone(tel_autor, me_num)):
                                cli_autor_id = await _retry_deadlock(
                                    db,
                                    lambda: upsert_cliente(
                                        db,
                                        empresa_id=empresa_id,
                                        instancia_id=instancia_id,
                                        telefone_raw=tel_autor,
                                        nome=formatar_telefone_br(tel_autor),
                                        nome_whatsapp=None,
                                        avatar_url=None,
                                    ),
                                )
                        except Exception as e:
                            _log_ctx("[HIST][grupo][autor-upsert-fail]", idx=idx, msg_id=msg_id, err=str(e))

                        def _ins_grupo():
                            msgg = models.MensagemGrupo(
                                empresa_id=empresa_id,
                                grupo_id=grupo.id,
                                author_jid=author_j,
                                from_me=from_me,
                                conteudo=conteudo,
                                message_type=m.get("messageType"),
                                lida=bool(from_me),
                                timestamp=int(ts_msg.timestamp()),
                                msg_id=(str(msg_id) if msg_id else None),
                                ack=(_ack_from_status(m.get("status")) if from_me else 0),
                                instancia_id=instancia_id,
                                tipo=("saida" if from_me else "entrada"),
                            )
                            _carimbar_inst(msgg, inst)
                            db.add(msgg)
                            db.flush()
                            return int(msgg.id)

                        msgg_id = await _retry_deadlock(db, _ins_grupo)
                        novas += 1

                        _log_ctx(
                            "[HIST][saved][grupo]",
                            idx=idx,
                            msg_id=msg_id,
                            saved_id=msgg_id,
                            grupo_id=grupo.id,
                            ts=_iso_utc(ts_msg),
                            preview=_short(conteudo),
                            media=("off" if DISABLE_MEDIA_ON_HISTORY else ("on" if media_meta else "none")),
                        )

                        if media_meta:
                            try:
                                save_media_for_group_message_with_db(
                                    db,
                                    inst_id=inst_id,
                                    empresa_id=empresa_id,
                                    grupo_id=grupo.id,
                                    cliente_id=cli_autor_id,
                                    msg_id=(str(msg_id) if msg_id else None),
                                    media_meta=media_meta,
                                    instancia_id=instancia_id,
                                    idx=idx,
                                )
                            except Exception as e:
                                _log_ctx("[HIST][grupo][midia] erro ao salvar", idx=idx, msg_id=msg_id, err=str(e))

                    except Exception as e:
                        erros += 1
                        try:
                            db.rollback()
                        except Exception:
                            pass
                        _log_ctx("[HIST][grupo][erro]", idx=idx, msg_id=msg_id, err=str(e))
                        continue

                # =========================
                # 1:1
                # =========================
                else:
                    try:
                        identity_info = _identity_hint_for_remote(
                            db,
                            empresa_id=empresa_id,
                            instancia_id=instancia_id,
                            raw_remote_jid=raw_remote_jid or remote_jid,
                        )

                        identity_real_jid = jid_strip_device(identity_info.get("real_jid") or "")
                        identity_push_name = identity_info.get("push_name")
                        identity_avatar_url = identity_info.get("profile_pic_url")
                        identity_cliente_id = identity_info.get("cliente_id")

                        if is_lid_jid(remote_jid) and identity_real_jid and not is_lid_jid(identity_real_jid):
                            remote_jid = identity_real_jid

                        telefone = remote_to_num(remote_jid)
                        is_lid_fallback = False

                        if not telefone and is_lid_jid(remote_jid):
                            if HISTORY_IMPORT_UNRESOLVED_LID:
                                telefone = _lid_digits_from_jid(remote_jid)
                                is_lid_fallback = True
                                LOG(
                                    f"[HIST][lid-fallback][legacy] importando LID como telefone provisório "
                                    f"idx={idx} msg_id={msg_id} remote_jid={remote_jid}"
                                )
                            else:
                                skips += 1
                                lid_pending_skips += 1
                                _log_ctx(
                                    "[HIST][skip] LID sem número real; não cria cliente visível",
                                    idx=idx,
                                    msg_id=msg_id,
                                    raw_remote_jid=raw_remote_jid,
                                    remote_jid=remote_jid,
                                )
                                continue

                        if not telefone or _telefone_invalido_para_1to1(telefone):
                            skips += 1
                            _log_ctx(
                                "[HIST][skip] telefone inválido",
                                idx=idx,
                                msg_id=msg_id,
                                remote_jid=remote_jid,
                                telefone=telefone,
                            )
                            continue

                        if me_num and _same_phone(telefone, me_num):
                            skips += 1
                            _log_ctx("[HIST][skip] eco do meu número", idx=idx, msg_id=msg_id, telefone=telefone)
                            continue

                        from_me = bool(key.get("fromMe", False))
                        self_profile_name = str(getattr(inst, "perfil_nome_whatsapp", None) or "").strip() or None

                        # Em mensagem de saída, pushName/senderName identifica o
                        # próprio WhatsApp conectado. Ele NÃO é nome do cliente.
                        inbound_push_name = None
                        if not from_me:
                            inbound_push_name = m.get("pushName") or m.get("senderName")

                        # Em histórico de SAÍDA não usamos nome vindo da tabela
                        # de identidades. Ela pode carregar um pushName antigo
                        # contaminado pelo próprio WhatsApp e o perfil da instância
                        # pode estar salvo como "Eu". Para saída, telefone é o
                        # fallback seguro; mensagens recebidas enriquecem o nome.
                        identity_name_for_contact = None if from_me else identity_push_name
                        if (
                            identity_name_for_contact
                            and _same_name_ci(identity_name_for_contact, self_profile_name)
                            and not (inbound_push_name and _same_name_ci(inbound_push_name, self_profile_name))
                        ):
                            identity_name_for_contact = None

                        nome_real = _primeiro_nome_real_para_historico(
                            [inbound_push_name, identity_name_for_contact],
                            raw_remote_jid=raw_remote_jid,
                            telefone=telefone,
                        )

                        nome_hist = _nome_contato_historico(
                            remote_jid=remote_jid,
                            raw_remote_jid=raw_remote_jid,
                            telefone=telefone,
                            push_name=nome_real,
                            from_me=from_me,
                        )

                        avatar_hist = identity_avatar_url or avatar_from_contact_like(m)
                        conteudo = extract_text_from_baileys(m)
                        media_meta = None if DISABLE_MEDIA_ON_HISTORY else extract_media_meta(m)

                        if is_lid_fallback or is_lid_jid(remote_jid):
                            cliente_cache_key = f"lid:{jid_strip_device(remote_jid)}"
                        else:
                            cliente_cache_key = f"tel:{_only_digits(telefone)}"

                        cli_id = None

                        if identity_cliente_id:
                            try:
                                cli_id = int(identity_cliente_id)
                            except Exception:
                                cli_id = None

                        if not cli_id:
                            cli_id = cliente_cache.get(cliente_cache_key)

                        if not cli_id:
                            cli_id = await _retry_deadlock(
                                db,
                                lambda: upsert_cliente(
                                    db,
                                    empresa_id=empresa_id,
                                    instancia_id=instancia_id,
                                    telefone_raw=telefone,
                                    nome=nome_hist,
                                    nome_whatsapp=nome_real,
                                    avatar_url=avatar_hist,
                                    self_profile_name=self_profile_name,
                                    allow_self_name_repair=bool((not from_me) and nome_real),
                                ),
                            )

                            if cli_id:
                                cliente_cache[cliente_cache_key] = int(cli_id)

                        # Cliente existente também pode ter sido contaminado por
                        # um pushName de saída antigo. Uma mensagem recebida com
                        # nome confiável repara apenas quando nome + nome_whatsapp
                        # ainda são exatamente o perfil da própria instância.
                        if cli_id and (not from_me) and nome_real:
                            try:
                                repaired_id = await _retry_deadlock(
                                    db,
                                    lambda: upsert_cliente(
                                        db,
                                        empresa_id=empresa_id,
                                        instancia_id=instancia_id,
                                        telefone_raw=telefone,
                                        nome=nome_real,
                                        nome_whatsapp=nome_real,
                                        avatar_url=avatar_hist,
                                        self_profile_name=self_profile_name,
                                        allow_self_name_repair=True,
                                    ),
                                )
                                if repaired_id:
                                    cli_id = int(repaired_id)
                                    cliente_cache[cliente_cache_key] = int(cli_id)
                            except Exception as e:
                                _log_ctx(
                                    "[HIST][cliente-self-name-repair-fail]",
                                    idx=idx,
                                    msg_id=msg_id,
                                    cliente_id=cli_id,
                                    err=str(e),
                                )

                        if not cli_id:
                            skips += 1
                            _log_ctx("[HIST][skip] upsert_cliente None", idx=idx, msg_id=msg_id, telefone=telefone)
                            continue

                        try:
                            if raw_remote_jid:
                                upsert_whatsapp_identity(
                                    db,
                                    empresa_id=empresa_id,
                                    instancia_id=instancia_id,
                                    remote_jid=raw_remote_jid,
                                    push_name=nome_real,
                                    profile_pic_url=avatar_hist,
                                    origem="messages.set",
                                    cliente_id=int(cli_id),
                                    real_jid=(remote_jid if not is_lid_jid(remote_jid) else None),
                                    confirmado=(not is_lid_jid(remote_jid)),
                                    confianca=(95 if not is_lid_jid(remote_jid) else 15),
                                    resolved_by=("messages.set_resolved" if not is_lid_jid(remote_jid) else "messages.set_lid_pending"),
                                    payload=None,
                                    commit=False,
                                )

                            if remote_jid and remote_jid != raw_remote_jid and not is_lid_jid(remote_jid):
                                upsert_whatsapp_identity(
                                    db,
                                    empresa_id=empresa_id,
                                    instancia_id=instancia_id,
                                    remote_jid=remote_jid,
                                    push_name=nome_real,
                                    profile_pic_url=avatar_hist,
                                    origem="messages.set",
                                    cliente_id=int(cli_id),
                                    confirmado=True,
                                    confianca=95,
                                    resolved_by="messages.set_real_jid",
                                    payload=None,
                                    commit=False,
                                )

                        except Exception as e:
                            _log_ctx(
                                "[HIST][identity-update][erro]",
                                idx=idx,
                                msg_id=msg_id,
                                raw_remote=raw_remote_jid,
                                remote_jid=remote_jid,
                                err=str(e),
                            )

                        if msg_id:
                            existing = find_existing_mensagem_11_id(
                                db,
                                empresa_id=empresa_id,
                                cliente_id=cli_id,
                                msg_id=str(msg_id),
                                instancia_id=instancia_id,
                            )
                            if existing:
                                duplicadas += 1
                                _log_ctx(
                                    "[HIST][skip] duplicada (1:1)",
                                    idx=idx,
                                    msg_id=msg_id,
                                    cliente_id=cli_id,
                                    existing_id=existing,
                                )
                                continue

                        ack_initial = _ack_from_status(m.get("status")) if from_me else None

                        def _ins_msg():
                            msg_model = models.Mensagem(
                                empresa_id=empresa_id,
                                cliente_id=cli_id,
                                conteudo=conteudo,
                                tipo=("saida" if from_me else "entrada"),
                                lida=bool(from_me),
                                ack=ack_initial,
                                timestamp=ts_msg,
                                msg_id=(str(msg_id) if msg_id else None),
                                instancia_id=instancia_id,
                            )
                            _carimbar_inst(msg_model, inst)
                            db.add(msg_model)
                            db.flush()
                            return int(msg_model.id)

                        msg_db_id = await _retry_deadlock(db, _ins_msg)
                        novas += 1

                        _log_ctx(
                            "[HIST][saved][1:1]",
                            idx=idx,
                            msg_id=msg_id,
                            saved_id=msg_db_id,
                            cliente_id=cli_id,
                            nome=nome_hist,
                            nome_real=nome_real,
                            telefone=telefone,
                            remote_jid=remote_jid,
                            raw_remote=raw_remote_jid,
                            lid_fallback=is_lid_fallback,
                            identity_resolved=bool(identity_info.get("resolved")),
                            identity_name=identity_push_name,
                            identity_real=identity_real_jid or None,
                            ts=_iso_utc(ts_msg),
                            preview=_short(conteudo),
                            media=("off" if DISABLE_MEDIA_ON_HISTORY else ("on" if media_meta else "none")),
                        )

                        try:
                            is_recent = abs((_now_utc() - ts_msg).total_seconds()) <= RECENT_SEC
                        except Exception:
                            is_recent = False

                        if is_recent:
                            try:
                                cliente = db.query(models.Cliente).filter_by(id=cli_id).first()
                                await conexoes_ativas.send_message(
                                    f"emp:{empresa_id}",
                                    {
                                        "empresa_id": empresa_id,
                                        "cliente_id": cli_id,
                                        "instancia_id": instancia_id,
                                        "instance_name": getattr(inst, "instance_name", None),
                                        "telefone": formatar_telefone_br(telefone),
                                        "avatar_url": getattr(cliente, "avatar_url", None) if cliente else avatar_hist,
                                        "push_name": getattr(cliente, "nome_whatsapp", None) if cliente else nome_real,
                                        "nome": getattr(cliente, "nome", None) if cliente else nome_hist,
                                        "mensagem": conteudo,
                                        "tipo": ("saida" if from_me else "entrada"),
                                        "origem": ("atendente" if from_me else "cliente"),
                                        "timestamp": _iso_utc(ts_msg),
                                        "msg_id": (str(msg_id) if msg_id else str(msg_db_id)),
                                        "ack": (ack_initial if from_me else None),
                                        "serverTimestamp": _server_ts_ms(),
                                    },
                                )
                            except Exception as e:
                                _log_ctx("[HIST][ws-live] falha ao emitir", idx=idx, msg_id=msg_id, err=str(e))

                        if media_meta:
                            try:
                                save_media_for_message_11_with_db(
                                    db,
                                    inst_id=inst_id,
                                    empresa_id=empresa_id,
                                    cliente_id=cli_id,
                                    mensagem_id=msg_db_id,
                                    msg_id=(str(msg_id) if msg_id else None),
                                    media_meta=media_meta,
                                    instancia_id=instancia_id,
                                    idx=idx,
                                )
                            except Exception as e:
                                _log_ctx("[HIST][midia] erro ao salvar", idx=idx, msg_id=msg_id, err=str(e))

                    except Exception as e:
                        erros += 1
                        try:
                            db.rollback()
                        except Exception:
                            pass
                        _log_ctx("[HIST][1:1][erro]", idx=idx, msg_id=msg_id, err=str(e))
                        continue

                if idx % PROG_STEP == 0:
                    await _emit_history_progress(
                        empresa_id,
                        imported=novas,
                        total=total,
                    )
                    _log_ctx(
                        "[HIST] progress",
                        imported=novas,
                        total=total,
                        processed=idx,
                        duplicadas=duplicadas,
                        skips=skips,
                        lid_pending_skips=lid_pending_skips,
                        time_window_skips=time_window_skips,
                        erros=erros,
                    )

                if novas > last_commit_novas and novas % max(1, HISTORY_BATCH_COMMIT) == 0:
                    try:
                        db.commit()
                        last_commit_novas = novas
                        _log_ctx("[HIST] commit", imported=novas, total=total)
                    except Exception as e:
                        if _is_deadlock_error(e):
                            try:
                                db.rollback()
                            except Exception:
                                pass
                            await asyncio.sleep(0.1)
                            _log_ctx("[HIST] commit-deadlock-rollback", err=str(e))
                        else:
                            raise

                if idx % max(1, HISTORY_SLEEP_EVERY) == 0:
                    await asyncio.sleep(0)

            try:
                db.commit()
                _log_ctx(
                    "[HIST] commit-final",
                    imported=novas,
                    total=total,
                    duplicadas=duplicadas,
                    skips=skips,
                    lid_pending_skips=lid_pending_skips,
                    time_window_skips=time_window_skips,
                    erros=erros,
                )
            except Exception as e:
                if _is_deadlock_error(e):
                    try:
                        db.rollback()
                    except Exception:
                        pass
                    _log_ctx("[HIST] commit-final-deadlock-rollback", err=str(e))
                else:
                    raise

            marked_done = _mark_history_done_in_db(
                db,
                inst_id=inst_id,
                empresa_id=empresa_id,
                instancia_id=instancia_id,
                historico_opcao=historico_opcao,
                total=total,
                novas=novas,
                duplicadas=duplicadas,
                skips=skips,
                erros=erros,
                lid_pending_skips=lid_pending_skips,
                time_window_skips=time_window_skips,
            )

            post_backfill = _force_contacts_backfill_after_history(
                inst_id=inst_id,
                empresa_id=empresa_id,
                instancia_id=instancia_id,
            )

            try:
                await conexoes_ativas.send_message(
                    f"emp:{empresa_id}",
                    {"type": "reload_clientes", "serverTimestamp": _server_ts_ms()},
                )
            except Exception:
                pass

            await _emit_history_done(
                empresa_id,
                total=total,
                imported=novas,
            )

            try:
                invalidate_emp_cache(empresa_id)
            except Exception:
                pass

            if marked_done and historico_opcao != "none":
                _HISTORY_DONE_AT[inst_id] = _now_utc().timestamp()
                _HISTORY_DONE_OPTION[inst_id] = historico_opcao

            LOG(
                f"[MESSAGES_SET] finalizado inst={inst_id} "
                f"empresa_id={empresa_id} instancia_id={instancia_id} "
                f"historico={historico_opcao} total={total} novas={novas} "
                f"duplicadas={duplicadas} skips={skips} "
                f"lid_pending_skips={lid_pending_skips} "
                f"time_window_skips={time_window_skips} erros={erros} "
                f"marked_done={marked_done} post_backfill={post_backfill}"
            )

        finally:
            _release_runtime_lock(runtime_lock, empresa_id, instancia_id)


__all__ = [
    "on_messages_set",
]