# backend/integrations/evolution/handlers/contacts.py

from __future__ import annotations

import asyncio
import os
import re
import time
from typing import Any

from sqlalchemy import text

from backend.database import SessionLocal
from backend.websocket_manager import conexoes_ativas

from .shared import (
    EvoEvent,
    handler,
    _get_inst_row,
    upsert_whatsapp_identities_from_contacts,
)
from ..services.contact_sync_service import (
    process_contacts_event,
    sync_contatos_completos,
    sync_chats_completos,
)
from ..utils.cache_utils import invalidate_emp_cache
from ..utils.log_utils import LOG
from ..utils.time_utils import _server_ts_ms


# =============================================================================
# CONTATOS READY
# =============================================================================
#
# Objetivo:
# - Quando chegar contacts.upsert/update grande após leitura do QR Code,
#   marcamos a instância como "contacts_ready".
#
# Importante:
# - Isso é em memória por processo.
# - Não substitui banco.
# - Serve para ordenar eventos durante a conexão do QR Code.
#
# Regra nova:
# - contacts.py NÃO cria cliente novo só porque recebeu @lid.
# - @lid sozinho serve para identidade/mapa/backfill.
# - Cliente visível só deve nascer com telefone real.
# =============================================================================

_CONTACTS_READY_BY_INST_ID: dict[tuple[int, int], dict[str, Any]] = {}
_CONTACTS_READY_BY_INST_NAME: dict[str, dict[str, Any]] = {}


def _env_int(name: str, default: int) -> int:
    try:
        raw = os.getenv(name)
        if raw is None or str(raw).strip() == "":
            return int(default)
        return int(raw)
    except Exception:
        return int(default)


def _contacts_ready_min_total() -> int:
    # Pacote grande de contacts normalmente vem 10, 20, 40, 50...
    # Evento unitário vem 1 e NÃO deve marcar ready.
    return max(2, _env_int("EVO_CONTACTS_READY_MIN_TOTAL", 10))


def _contacts_ready_min_named() -> int:
    # Exige pelo menos alguns nomes reais válidos.
    return max(1, _env_int("EVO_CONTACTS_READY_MIN_NAMED", 3))


def _contacts_ready_ttl_sec() -> int:
    # Quanto tempo consideramos "contacts pronto" para ordenar messages.set.
    return max(30, _env_int("EVO_CONTACTS_READY_TTL_SEC", 15 * 60))


def _contacts_ready_now() -> float:
    return time.time()


def _contacts_ready_key(empresa_id: int, instancia_id: int) -> tuple[int, int]:
    return (int(empresa_id), int(instancia_id))


def _contacts_event_stats(contatos: list[dict]) -> dict[str, int]:
    total = 0
    total_lid = 0
    total_real = 0
    named = 0
    lid_named = 0
    real_named = 0

    for c in contatos or []:
        if not isinstance(c, dict):
            continue

        total += 1

        remote = (
            c.get("remoteJid")
            or c.get("remote_jid")
            or c.get("jid")
            or c.get("id")
        )
        remote = _jid_strip_device_local(remote)

        is_lid = _is_lid_jid_local(remote)
        is_real = bool(remote and remote.endswith("@s.whatsapp.net"))

        if is_lid:
            total_lid += 1

        if is_real:
            total_real += 1

        nome = _valid_contact_name(c)
        if nome:
            named += 1
            if is_lid:
                lid_named += 1
            if is_real:
                real_named += 1

    return {
        "total": total,
        "total_lid": total_lid,
        "total_real": total_real,
        "named": named,
        "lid_named": lid_named,
        "real_named": real_named,
    }


def _should_mark_contacts_ready(contatos: list[dict]) -> tuple[bool, dict[str, int]]:
    stats = _contacts_event_stats(contatos)

    total = int(stats.get("total") or 0)
    named = int(stats.get("named") or 0)
    lid_named = int(stats.get("lid_named") or 0)

    min_total = _contacts_ready_min_total()
    min_named = _contacts_ready_min_named()

    # Regra principal:
    # pacote grande + alguns nomes reais.
    if total >= min_total and named >= min_named:
        return True, stats

    # Regra alternativa:
    # às vezes pacote não é enorme, mas já trouxe vários LIDs nomeados.
    if lid_named >= min_named and total >= min_named:
        return True, stats

    return False, stats


def mark_contacts_ready(
    *,
    empresa_id: int,
    instancia_id: int,
    inst_name: str | None,
    origem: str | None,
    contatos: list[dict],
    extra: dict[str, Any] | None = None,
) -> bool:
    """
    Marca a instância como contacts_ready quando o pacote parece ser o pacote
    grande de contatos do QR Code.

    Retorna True quando marcou.
    """
    ok, stats = _should_mark_contacts_ready(contatos)

    if not ok:
        LOG(
            f"[CONTACTS][READY][skip] inst={inst_name or '-'} "
            f"empresa_id={empresa_id} instancia_id={instancia_id} "
            f"origem={origem or '-'} total={stats.get('total')} "
            f"named={stats.get('named')} lid_named={stats.get('lid_named')} "
            f"min_total={_contacts_ready_min_total()} min_named={_contacts_ready_min_named()}"
        )
        return False

    now = _contacts_ready_now()

    state = {
        "ready": True,
        "empresa_id": int(empresa_id),
        "instancia_id": int(instancia_id),
        "inst_name": str(inst_name or "").strip(),
        "origem": str(origem or "").strip(),
        "ts": now,
        "updated_at": now,
        "stats": stats,
        "extra": dict(extra or {}),
    }

    _CONTACTS_READY_BY_INST_ID[_contacts_ready_key(empresa_id, instancia_id)] = state

    if inst_name:
        _CONTACTS_READY_BY_INST_NAME[str(inst_name).strip()] = state

    LOG(
        f"[CONTACTS][READY] marcado inst={inst_name or '-'} "
        f"empresa_id={empresa_id} instancia_id={instancia_id} "
        f"origem={origem or '-'} total={stats.get('total')} "
        f"named={stats.get('named')} lid_named={stats.get('lid_named')} "
        f"real_named={stats.get('real_named')}"
    )

    return True


def get_contacts_ready_state(
    *,
    empresa_id: int | None = None,
    instancia_id: int | None = None,
    inst_name: str | None = None,
) -> dict[str, Any] | None:
    state: dict[str, Any] | None = None

    if empresa_id is not None and instancia_id is not None:
        state = _CONTACTS_READY_BY_INST_ID.get(_contacts_ready_key(int(empresa_id), int(instancia_id)))

    if not state and inst_name:
        state = _CONTACTS_READY_BY_INST_NAME.get(str(inst_name).strip())

    if not state:
        return None

    ttl = _contacts_ready_ttl_sec()
    ts = float(state.get("ts") or 0)
    age = _contacts_ready_now() - ts

    if age > ttl:
        return None

    return dict(state)


def is_contacts_ready(
    *,
    empresa_id: int | None = None,
    instancia_id: int | None = None,
    inst_name: str | None = None,
) -> bool:
    return bool(
        get_contacts_ready_state(
            empresa_id=empresa_id,
            instancia_id=instancia_id,
            inst_name=inst_name,
        )
    )


async def wait_contacts_ready(
    *,
    empresa_id: int | None = None,
    instancia_id: int | None = None,
    inst_name: str | None = None,
    timeout_sec: float | None = None,
    interval_sec: float = 0.25,
) -> bool:
    """
    Helper para o messages_set.py usar.

    Espera contacts_ready por alguns segundos.
    """
    if timeout_sec is None:
        timeout_sec = float(_env_int("EVO_CONTACTS_READY_WAIT_SEC", 6))

    timeout_sec = max(0.0, float(timeout_sec))
    interval_sec = max(0.05, float(interval_sec))

    started = _contacts_ready_now()

    while True:
        if is_contacts_ready(
            empresa_id=empresa_id,
            instancia_id=instancia_id,
            inst_name=inst_name,
        ):
            return True

        if (_contacts_ready_now() - started) >= timeout_sec:
            return False

        await asyncio.sleep(interval_sec)


# =============================================================================
# EXTRAÇÃO DO PAYLOAD
# =============================================================================


def _inst_from_payload(first: str, payload: dict | list) -> str:
    """
    Descobre o nome da instância vindo do evento da Evolution.

    Formatos comuns:
    {
      "event": "contacts.upsert",
      "instance": "minha-instancia",
      "data": [...]
    }

    Também aceita payload direto/lista dependendo do transport.
    """
    if isinstance(payload, dict):
        for key in ("instance", "instanceName", "instanceId"):
            value = payload.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()

        data = payload.get("data")
        if isinstance(data, dict):
            for key in ("instance", "instanceName", "instanceId"):
                value = data.get(key)
                if isinstance(value, str) and value.strip():
                    return value.strip()

    return str(first or "").strip()


def _event_from_payload(payload: dict | list, fallback: str = "contacts") -> str:
    """
    Retorna origem amigável para gravar na tabela contatos_whatsapp_identidades.
    """
    if isinstance(payload, dict):
        event = payload.get("event") or payload.get("eventName")
        if isinstance(event, str) and event.strip():
            return event.strip()

    return fallback


def _extract_contacts_list(payload: dict | list) -> list[dict]:
    """
    Extrai lista de contatos de vários formatos possíveis da Evolution.

    Formatos observados:
    {
      "event": "contacts.upsert",
      "instance": "...",
      "data": [
        {"remoteJid": "...", "pushName": "..."}
      ]
    }

    Também aceita:
    - payload já sendo lista
    - data sendo dict único
    - data.contacts
    - data.items
    - payload inteiro sendo contato único
    """
    if isinstance(payload, list):
        return [x for x in payload if isinstance(x, dict)]

    if not isinstance(payload, dict):
        return []

    data = payload.get("data")

    if isinstance(data, list):
        return [x for x in data if isinstance(x, dict)]

    if isinstance(data, dict):
        for key in ("contacts", "items", "rows", "results"):
            value = data.get(key)
            if isinstance(value, list):
                return [x for x in value if isinstance(x, dict)]

        if any(k in data for k in ("remoteJid", "remote_jid", "jid", "id", "pushName", "profilePicUrl")):
            return [data]

    if any(k in payload for k in ("remoteJid", "remote_jid", "jid", "id", "pushName", "profilePicUrl")):
        return [payload]

    return []


def _only_digits(value: Any) -> str:
    return re.sub(r"\D+", "", str(value or ""))


def _jid_strip_device_local(jid: Any) -> str:
    raw = str(jid or "").strip()
    if not raw:
        return ""

    if ":" in raw and "@" in raw:
        left, right = raw.split("@", 1)
        left = left.split(":", 1)[0]
        return f"{left}@{right}"

    return raw


def _is_lid_jid_local(jid: Any) -> bool:
    return _jid_strip_device_local(jid).lower().endswith("@lid")


def _is_real_user_jid_local(jid: Any) -> bool:
    return _jid_strip_device_local(jid).lower().endswith("@s.whatsapp.net")


def _lid_digits_from_jid(jid: Any) -> str:
    raw = _jid_strip_device_local(jid)
    if not raw or not _is_lid_jid_local(raw):
        return ""

    return _only_digits(raw.split("@", 1)[0])


def _remote_digits_from_jid(jid: Any) -> str:
    raw = _jid_strip_device_local(jid)
    if not raw or "@" not in raw:
        return _only_digits(raw)

    return _only_digits(raw.split("@", 1)[0])


def _name_from_contact(c: dict) -> str | None:
    for key in (
        "pushName",
        "name",
        "verifiedName",
        "notifyName",
        "formattedName",
        "shortName",
        "contactName",
        "displayName",
        "subject",
        "title",
    ):
        value = c.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()

    return None


def _avatar_from_contact(c: dict) -> str | None:
    value = (
        c.get("profilePicUrl")
        or (c.get("profilePicThumbObj") or {}).get("eurl")
        or c.get("thumbnailUrl")
        or c.get("imageUrl")
        or c.get("pictureUrl")
    )

    if isinstance(value, str) and value.strip():
        return value.strip()

    return None


def _is_bad_contact_name(name: Any) -> bool:
    """
    Nome ruim/falso que não pode virar nome de cliente nem push_name real.
    """
    raw = str(name or "").strip()
    if not raw:
        return True

    low = raw.lower().strip()
    digits = _only_digits(raw)

    if low in {
        "0",
        "voce",
        "você",
        "you",
        "cliente",
        "contato",
        "unknown",
        "desconhecido",
        "contato do whatsapp",
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

    if low.startswith("lid "):
        return True

    # Nome só numérico gigante normalmente é LID.
    if digits and digits == raw and len(digits) >= 13:
        return True

    # Nome tipo "147 377 658 822 877".
    compact = re.sub(r"\s+", "", raw)
    if digits and len(digits) >= 13 and digits == compact:
        return True

    return False


def _valid_contact_name(c: dict) -> str | None:
    name = _name_from_contact(c)
    if _is_bad_contact_name(name):
        return None
    return str(name).strip()


def _has_lid_contact(contatos: list[dict]) -> bool:
    for c in contatos or []:
        if not isinstance(c, dict):
            continue

        remote = (
            c.get("remoteJid")
            or c.get("remote_jid")
            or c.get("jid")
            or c.get("id")
        )

        if _is_lid_jid_local(remote):
            return True

    return False


# =============================================================================
# LIMPEZA / BACKFILL
# =============================================================================


def _cleanup_fake_identity_names(db, *, empresa_id: int, instancia_id: int) -> int:
    """
    Limpa sujeira criada antes:

    - push_name = 'Contato do WhatsApp'
    - push_name = 'Contato LID ...'
    - push_name = '0'
    - push_name numérico gigante igual LID
    - remote 0@s.whatsapp.net
    - cliente 0

    Não apaga cliente com mensagem vinculada.
    """
    empresa_id = int(empresa_id)
    instancia_id = int(instancia_id)

    total = 0

    r1 = db.execute(
        text(
            """
            UPDATE contatos_whatsapp_identidades
               SET push_name = NULL,
                   push_name_norm = NULL,
                   confianca = LEAST(COALESCE(confianca, 10), 10),
                   resolved_by = CASE
                                    WHEN resolved_by IS NULL OR resolved_by = ''
                                    THEN 'pending_lid_no_contact_name'
                                    ELSE resolved_by
                                  END,
                   atualizado_em = NOW(),
                   ultimo_evento_em = NOW()
             WHERE empresa_id = :empresa_id
               AND instancia_id = :instancia_id
               AND (
                    push_name ILIKE 'Contato do WhatsApp%'
                    OR push_name ILIKE 'Contato Whatsapp%'
                    OR push_name ILIKE 'Contato LID%'
                    OR push_name = '0'
                    OR push_name ~ '^[0-9]{13,}$'
               )
            """
        ),
        {
            "empresa_id": empresa_id,
            "instancia_id": instancia_id,
        },
    )

    r2 = db.execute(
        text(
            """
            DELETE FROM contatos_whatsapp_identidades
             WHERE empresa_id = :empresa_id
               AND instancia_id = :instancia_id
               AND (
                    remote_jid = '0@s.whatsapp.net'
                    OR remote_jid = '0@c.us'
                    OR remote_jid = '0@lid'
                    OR lid_jid = '0@lid'
                    OR real_jid = '0@s.whatsapp.net'
               )
            """
        ),
        {
            "empresa_id": empresa_id,
            "instancia_id": instancia_id,
        },
    )

    r3 = db.execute(
        text(
            """
            DELETE FROM clientes
             WHERE empresa_id = :empresa_id
               AND instancia_id = :instancia_id
               AND (
                    telefone = '0'
                    OR telefone_norm = '0'
                    OR nome = '0'
                    OR nome_whatsapp = '0'
               )
               AND NOT EXISTS (
                    SELECT 1
                      FROM mensagens m
                     WHERE m.cliente_id = clientes.id
                     LIMIT 1
               )
               AND NOT EXISTS (
                    SELECT 1
                      FROM atendimentos a
                     WHERE a.cliente_id = clientes.id
                     LIMIT 1
               )
            """
        ),
        {
            "empresa_id": empresa_id,
            "instancia_id": instancia_id,
        },
    )

    for r in (r1, r2, r3):
        try:
            total += int(r.rowcount or 0)
        except Exception:
            pass

    return total


def _is_cliente_name_provisorio_sql() -> str:
    return """
    (
        c.nome IS NULL
        OR btrim(c.nome) = ''
        OR c.nome = '0'
        OR c.nome ILIKE 'Contato do WhatsApp%'
        OR c.nome ILIKE 'Contato Whatsapp%'
        OR c.nome ILIKE 'Contato LID%'
        OR c.nome = c.telefone
        OR c.nome = c.telefone_norm
        OR regexp_replace(COALESCE(c.nome, ''), '\\D', '', 'g')
           =
           regexp_replace(COALESCE(c.telefone_norm, ''), '\\D', '', 'g')
        OR regexp_replace(COALESCE(c.nome, ''), '\\D', '', 'g')
           =
           regexp_replace(COALESCE(c.telefone, ''), '\\D', '', 'g')
    )
    """


def _backfill_clientes_lid_from_payload(db, *, empresa_id: int, instancia_id: int, contatos: list[dict]) -> int:
    empresa_id = int(empresa_id)
    instancia_id = int(instancia_id)

    total = 0
    vistos: set[tuple[str, str]] = set()

    for c in contatos or []:
        if not isinstance(c, dict):
            continue

        remote = (
            c.get("remoteJid")
            or c.get("remote_jid")
            or c.get("jid")
            or c.get("id")
        )

        remote = _jid_strip_device_local(remote)

        if not remote or not _is_lid_jid_local(remote):
            continue

        lid_digits = _lid_digits_from_jid(remote)
        if not lid_digits or lid_digits == "0":
            continue

        nome = _valid_contact_name(c)
        if not nome:
            continue

        avatar_url = _avatar_from_contact(c)

        dedup_key = (lid_digits, nome)
        if dedup_key in vistos:
            continue
        vistos.add(dedup_key)

        r1 = db.execute(
            text(
                f"""
                UPDATE clientes c
                   SET nome = :nome,
                       nome_whatsapp = :nome,
                       avatar_url = COALESCE(NULLIF(:avatar_url, ''), c.avatar_url)
                 WHERE c.empresa_id = :empresa_id
                   AND c.instancia_id = :instancia_id
                   AND (
                        regexp_replace(COALESCE(c.telefone_norm, ''), '\\D', '', 'g') = :lid_digits
                        OR regexp_replace(COALESCE(c.telefone, ''), '\\D', '', 'g') = :lid_digits
                   )
                   AND {_is_cliente_name_provisorio_sql()}
                """
            ),
            {
                "empresa_id": empresa_id,
                "instancia_id": instancia_id,
                "lid_digits": lid_digits,
                "nome": nome,
                "avatar_url": avatar_url or "",
            },
        )

        r2 = db.execute(
            text(
                """
                UPDATE contatos_whatsapp_identidades cwi
                   SET cliente_id = c.id,
                       atualizado_em = NOW(),
                       ultimo_evento_em = NOW()
                  FROM clientes c
                 WHERE cwi.empresa_id = c.empresa_id
                   AND cwi.instancia_id = c.instancia_id
                   AND cwi.empresa_id = :empresa_id
                   AND cwi.instancia_id = :instancia_id
                   AND cwi.lid_jid = :lid_jid
                   AND (
                        regexp_replace(COALESCE(c.telefone_norm, ''), '\\D', '', 'g') = :lid_digits
                        OR regexp_replace(COALESCE(c.telefone, ''), '\\D', '', 'g') = :lid_digits
                   )
                """
            ),
            {
                "empresa_id": empresa_id,
                "instancia_id": instancia_id,
                "lid_digits": lid_digits,
                "lid_jid": remote,
            },
        )

        try:
            total += int(r1.rowcount or 0)
        except Exception:
            pass

        try:
            total += int(r2.rowcount or 0)
        except Exception:
            pass

    return total


def _backfill_clientes_reais_from_payload(db, *, empresa_id: int, instancia_id: int, contatos: list[dict]) -> int:

    empresa_id = int(empresa_id)
    instancia_id = int(instancia_id)

    total = 0
    vistos: set[tuple[str, str]] = set()

    for c in contatos or []:
        if not isinstance(c, dict):
            continue

        remote = (
            c.get("remoteJid")
            or c.get("remote_jid")
            or c.get("jid")
            or c.get("id")
        )

        remote = _jid_strip_device_local(remote)

        if not remote or not _is_real_user_jid_local(remote):
            continue

        phone_digits = _remote_digits_from_jid(remote)
        if not phone_digits or phone_digits == "0":
            continue

        nome = _valid_contact_name(c)
        if not nome:
            continue

        avatar_url = _avatar_from_contact(c)

        dedup_key = (phone_digits, nome)
        if dedup_key in vistos:
            continue
        vistos.add(dedup_key)

        r = db.execute(
            text(
                f"""
                UPDATE clientes c
                   SET nome = CASE
                                WHEN {_is_cliente_name_provisorio_sql()}
                                THEN :nome
                                ELSE c.nome
                              END,
                       nome_whatsapp = CASE
                                          WHEN c.nome_whatsapp IS NULL
                                            OR btrim(c.nome_whatsapp) = ''
                                            OR c.nome_whatsapp = '0'
                                            OR c.nome_whatsapp ILIKE 'Contato do WhatsApp%%'
                                            OR c.nome_whatsapp ILIKE 'Contato Whatsapp%%'
                                            OR c.nome_whatsapp ILIKE 'Contato LID%%'
                                            OR c.nome_whatsapp ~ '^[0-9]{{10,}}$'
                                          THEN :nome
                                          ELSE c.nome_whatsapp
                                        END,
                       avatar_url = COALESCE(NULLIF(:avatar_url, ''), c.avatar_url)
                 WHERE c.empresa_id = :empresa_id
                   AND (
                        regexp_replace(COALESCE(c.telefone_norm, ''), '\\D', '', 'g') = :phone_digits
                        OR regexp_replace(COALESCE(c.telefone, ''), '\\D', '', 'g') = :phone_digits
                        OR regexp_replace(COALESCE(c.telefone, ''), '\\D', '', 'g') = RIGHT(:phone_digits, 11)
                        OR regexp_replace(COALESCE(c.telefone_norm, ''), '\\D', '', 'g') = RIGHT(:phone_digits, 11)
                   )
                """
            ),
            {
                "empresa_id": empresa_id,
                "instancia_id": instancia_id,
                "phone_digits": phone_digits,
                "nome": nome,
                "avatar_url": avatar_url or "",
            },
        )

        try:
            total += int(r.rowcount or 0)
        except Exception:
            pass

    return total


def _backfill_clientes_lid_from_identities(db, *, empresa_id: int, instancia_id: int) -> int:
    """
    Backfill usando a tabela contatos_whatsapp_identidades.

    Esse é backup do payload direto.
    """
    empresa_id = int(empresa_id)
    instancia_id = int(instancia_id)

    total_updated = 0

    r1 = db.execute(
        text(
            """
            UPDATE contatos_whatsapp_identidades cwi
               SET cliente_id = c.id,
                   atualizado_em = NOW(),
                   ultimo_evento_em = NOW()
              FROM clientes c
             WHERE cwi.empresa_id = c.empresa_id
               AND cwi.instancia_id = c.instancia_id
               AND cwi.lid_jid IS NOT NULL
               AND cwi.empresa_id = :empresa_id
               AND cwi.instancia_id = :instancia_id
               AND cwi.cliente_id IS NULL
               AND (
                    regexp_replace(split_part(cwi.lid_jid, '@', 1), '\\D', '', 'g')
                    =
                    regexp_replace(COALESCE(c.telefone_norm, ''), '\\D', '', 'g')
                    OR
                    regexp_replace(split_part(cwi.lid_jid, '@', 1), '\\D', '', 'g')
                    =
                    regexp_replace(COALESCE(c.telefone, ''), '\\D', '', 'g')
               )
            """
        ),
        {
            "empresa_id": empresa_id,
            "instancia_id": instancia_id,
        },
    )

    r2 = db.execute(
        text(
            f"""
            UPDATE clientes c
               SET nome = cwi.push_name,
                   nome_whatsapp = cwi.push_name,
                   avatar_url = COALESCE(NULLIF(cwi.profile_pic_url, ''), c.avatar_url)
              FROM contatos_whatsapp_identidades cwi
             WHERE cwi.empresa_id = c.empresa_id
               AND cwi.instancia_id = c.instancia_id
               AND cwi.cliente_id = c.id
               AND cwi.empresa_id = :empresa_id
               AND cwi.instancia_id = :instancia_id

               AND cwi.push_name IS NOT NULL
               AND cwi.push_name <> ''
               AND cwi.push_name <> '0'
               AND cwi.push_name NOT ILIKE 'Contato do WhatsApp%'
               AND cwi.push_name NOT ILIKE 'Contato Whatsapp%'
               AND cwi.push_name NOT ILIKE 'Contato LID%'
               AND NOT (cwi.push_name ~ '^[0-9]{{13,}}$')

               AND {_is_cliente_name_provisorio_sql()}
            """
        ),
        {
            "empresa_id": empresa_id,
            "instancia_id": instancia_id,
        },
    )

    r3 = db.execute(
        text(
            f"""
            UPDATE clientes c
               SET nome = cwi.push_name,
                   nome_whatsapp = cwi.push_name,
                   avatar_url = COALESCE(NULLIF(cwi.profile_pic_url, ''), c.avatar_url)
              FROM contatos_whatsapp_identidades cwi
             WHERE cwi.empresa_id = c.empresa_id
               AND cwi.instancia_id = c.instancia_id
               AND cwi.lid_jid IS NOT NULL
               AND cwi.empresa_id = :empresa_id
               AND cwi.instancia_id = :instancia_id

               AND cwi.push_name IS NOT NULL
               AND cwi.push_name <> ''
               AND cwi.push_name <> '0'
               AND cwi.push_name NOT ILIKE 'Contato do WhatsApp%'
               AND cwi.push_name NOT ILIKE 'Contato Whatsapp%'
               AND cwi.push_name NOT ILIKE 'Contato LID%'
               AND NOT (cwi.push_name ~ '^[0-9]{{13,}}$')

               AND (
                    regexp_replace(split_part(cwi.lid_jid, '@', 1), '\\D', '', 'g')
                    =
                    regexp_replace(COALESCE(c.telefone_norm, ''), '\\D', '', 'g')
                    OR
                    regexp_replace(split_part(cwi.lid_jid, '@', 1), '\\D', '', 'g')
                    =
                    regexp_replace(COALESCE(c.telefone, ''), '\\D', '', 'g')
               )

               AND {_is_cliente_name_provisorio_sql()}
            """
        ),
        {
            "empresa_id": empresa_id,
            "instancia_id": instancia_id,
        },
    )

    for r in (r1, r2, r3):
        try:
            total_updated += int(r.rowcount or 0)
        except Exception:
            pass

    return total_updated


async def _emit_reload_clientes_if_needed(empresa_id: int, changed: bool) -> None:
    if not changed:
        return

    try:
        await conexoes_ativas.send_message(
            f"emp:{int(empresa_id)}",
            {
                "type": "reload_clientes",
                "serverTimestamp": _server_ts_ms(),
            },
        )
    except Exception:
        pass


# =============================================================================
# SAVE / HANDLER
# =============================================================================


def _save_contacts_identities(first: str, payload: dict | list) -> dict:
    """
    Salva contacts.upsert/update/set e corrige clientes provisórios.

    Fluxo:
    1. Salva identidades recebidas da Evolution.
    2. Limpa nomes falsos antigos.
    3. Backfill DIRETO pelo payload:
       @lid + pushName -> cliente provisório antigo.
    4. Backfill de contato real:
       @s.whatsapp.net + pushName -> cliente real.
    5. Backfill backup pela tabela de identidades.
    6. Se pacote for grande, marca contacts_ready da instância.
    """
    inst_name = _inst_from_payload(first, payload)
    contatos = _extract_contacts_list(payload)
    origem = _event_from_payload(payload, fallback="contacts")

    result = {
        "ok": False,
        "empresa_id": None,
        "instancia_id": None,
        "inst_name": inst_name,
        "origem": origem,
        "contatos": 0,
        "cleanup": 0,
        "backfill_payload": 0,
        "backfill_real_payload": 0,
        "backfill_clientes": 0,
        "contacts_ready": False,
        "contacts_stats": {},
        "has_lid": False,
        "changed": False,
    }

    if not inst_name:
        LOG("[CONTACTS][IDENTITY] ignorado: instância vazia.")
        return result

    if not contatos:
        LOG(f"[CONTACTS][IDENTITY] sem contatos para salvar inst={inst_name} origem={origem}")
        return result

    with SessionLocal() as db:
        try:
            inst = _get_inst_row(db, inst_name)
            if not inst:
                LOG(f"[CONTACTS][IDENTITY] instância não encontrada no banco inst={inst_name}")
                return result

            empresa_id = int(inst.empresa_id)
            instancia_id = int(inst.id)

            stats = _contacts_event_stats(contatos)

            total = upsert_whatsapp_identities_from_contacts(
                db,
                empresa_id=empresa_id,
                instancia_id=instancia_id,
                contatos=contatos,
                origem=origem,
                commit=False,
            )

            cleanup_total = _cleanup_fake_identity_names(
                db,
                empresa_id=empresa_id,
                instancia_id=instancia_id,
            )

            backfill_payload_total = _backfill_clientes_lid_from_payload(
                db,
                empresa_id=empresa_id,
                instancia_id=instancia_id,
                contatos=contatos,
            )

            backfill_real_payload_total = _backfill_clientes_reais_from_payload(
                db,
                empresa_id=empresa_id,
                instancia_id=instancia_id,
                contatos=contatos,
            )

            backfill_total = _backfill_clientes_lid_from_identities(
                db,
                empresa_id=empresa_id,
                instancia_id=instancia_id,
            )

            db.commit()

            ready = mark_contacts_ready(
                empresa_id=empresa_id,
                instancia_id=instancia_id,
                inst_name=inst_name,
                origem=origem,
                contatos=contatos,
                extra={
                    "saved_identities": int(total or 0),
                    "cleanup": int(cleanup_total or 0),
                    "backfill_payload": int(backfill_payload_total or 0),
                    "backfill_real_payload": int(backfill_real_payload_total or 0),
                    "backfill_clientes": int(backfill_total or 0),
                },
            )

            changed = bool(
                int(cleanup_total or 0)
                or int(backfill_payload_total or 0)
                or int(backfill_real_payload_total or 0)
                or int(backfill_total or 0)
            )

            try:
                invalidate_emp_cache(empresa_id)
            except Exception:
                pass

            result.update(
                {
                    "ok": True,
                    "empresa_id": empresa_id,
                    "instancia_id": instancia_id,
                    "contatos": int(total or 0),
                    "cleanup": int(cleanup_total or 0),
                    "backfill_payload": int(backfill_payload_total or 0),
                    "backfill_real_payload": int(backfill_real_payload_total or 0),
                    "backfill_clientes": int(backfill_total or 0),
                    "contacts_ready": bool(ready),
                    "contacts_stats": stats,
                    "has_lid": _has_lid_contact(contatos),
                    "changed": changed,
                }
            )

            LOG(
                f"[CONTACTS][IDENTITY] salvo origem={origem} "
                f"inst={inst_name} empresa_id={empresa_id} "
                f"instancia_id={instancia_id} contatos={total} "
                f"cleanup={cleanup_total} "
                f"backfill_payload={backfill_payload_total} "
                f"backfill_real_payload={backfill_real_payload_total} "
                f"backfill_clientes={backfill_total} "
                f"contacts_ready={bool(ready)} "
                f"changed={changed} "
                f"stats={stats}"
            )

            return result

        except Exception as e:
            try:
                db.rollback()
            except Exception:
                pass

            LOG(f"[CONTACTS][IDENTITY][erro] inst={inst_name} origem={origem} err={e}")
            return result


@handler(EvoEvent.CONTACTS_UPSERT)
@handler(EvoEvent.CONTACTS_UPDATE)
@handler(EvoEvent.CONTACTS_SET)
async def on_contacts_event(first: str, payload: dict | list):
    """
    Fluxo:

    1. Salva mapa WhatsApp/LID.
    2. Corrige cliente provisório antigo direto pelo payload:
       LID -> pushName.
    3. Corrige cliente real pelo payload:
       número real -> pushName.
    4. Se pacote for grande, marca contacts_ready.
    5. Mantém fluxo antigo do ZapsChat.
    6. Roda backfill de novo depois do fluxo antigo.
    """
    saved = _save_contacts_identities(first, payload)

    result = await process_contacts_event(first, payload)

    changed_post = False

    try:
        if saved.get("ok") and saved.get("empresa_id") and saved.get("instancia_id"):
            contatos = _extract_contacts_list(payload)

            with SessionLocal() as db:
                cleanup_total = _cleanup_fake_identity_names(
                    db,
                    empresa_id=int(saved["empresa_id"]),
                    instancia_id=int(saved["instancia_id"]),
                )

                backfill_payload_total = _backfill_clientes_lid_from_payload(
                    db,
                    empresa_id=int(saved["empresa_id"]),
                    instancia_id=int(saved["instancia_id"]),
                    contatos=contatos,
                )

                backfill_real_payload_total = _backfill_clientes_reais_from_payload(
                    db,
                    empresa_id=int(saved["empresa_id"]),
                    instancia_id=int(saved["instancia_id"]),
                    contatos=contatos,
                )

                backfill_total = _backfill_clientes_lid_from_identities(
                    db,
                    empresa_id=int(saved["empresa_id"]),
                    instancia_id=int(saved["instancia_id"]),
                )

                db.commit()

                changed_post = bool(
                    int(cleanup_total or 0)
                    or int(backfill_payload_total or 0)
                    or int(backfill_real_payload_total or 0)
                    or int(backfill_total or 0)
                )

                if changed_post:
                    LOG(
                        f"[CONTACTS][IDENTITY][post-process] "
                        f"inst={saved.get('inst_name')} "
                        f"cleanup={cleanup_total} "
                        f"backfill_payload={backfill_payload_total} "
                        f"backfill_real_payload={backfill_real_payload_total} "
                        f"backfill_clientes={backfill_total}"
                    )

                    try:
                        invalidate_emp_cache(int(saved["empresa_id"]))
                    except Exception:
                        pass

    except Exception as e:
        LOG(f"[CONTACTS][IDENTITY][post-process][erro] err={e}")

    try:
        empresa_id = saved.get("empresa_id")
        changed = bool(saved.get("changed")) or bool(changed_post)
        if empresa_id:
            await _emit_reload_clientes_if_needed(int(empresa_id), changed)
    except Exception:
        pass

    return result


__all__ = [
    "on_contacts_event",
    "sync_contatos_completos",
    "sync_chats_completos",
    "mark_contacts_ready",
    "get_contacts_ready_state",
    "is_contacts_ready",
    "wait_contacts_ready",
    "_cleanup_fake_identity_names",
    "_backfill_clientes_lid_from_identities",
]