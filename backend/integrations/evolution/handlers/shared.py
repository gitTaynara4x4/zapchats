# backend/integrations/evolution/handlers/shared.py

from __future__ import annotations

import asyncio
import inspect
import re
from typing import Any, Callable

from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from backend import models
from backend.database import SessionLocal
from backend.routers.chatbot_setores import triagem_handle_inbound

try:
    from backend.routers.chatbot_setores import auto_messages_handle_inbound
except ImportError:
    auto_messages_handle_inbound = None

from ..parsers.media_parser import _b64_to_bytes, normalize_mimetype
from ..repositories.atendimentos_repo import (
    get_or_open_atendimento_repo,
    has_mensagem_atendimento_field,
)
from ..repositories.clientes_repo import get_cliente_by_id, upsert_cliente_repo
from ..repositories.grupos_repo import (
    get_or_create_grupo_by_remote,
    upsert_grupos_from_chats as _repo_upsert_grupos_from_chats,
)
from ..services.media_service import (
    _save_midia_db,
    save_media_for_group_message_with_db,
    save_media_for_message_11_with_db,
)
from ..transport.evolution_http_client import EvolutionHttpClient
from ..utils.cache_utils import invalidate_emp_cache
from ..utils.jid_utils import is_lid_jid, jid_strip_device
from ..utils.log_utils import LOG, _log_ctx, _short
from ..utils.phone_utils import _resolve_counterparty_num_1to1, formatar_telefone_br, remote_to_num
from ..utils.time_utils import _int_unix, _iso_utc, _now_utc, _server_ts_ms

HANDLERS: dict[str, Callable[..., Any]] = {}


class EvoEvent:
    APPLICATION_STARTUP = "APPLICATION_STARTUP"
    QRCODE_UPDATED = "QRCODE_UPDATED"
    CONNECTION_UPDATE = "CONNECTION_UPDATE"
    MESSAGES_SET = "MESSAGES_SET"
    MESSAGES_UPSERT = "MESSAGES_UPSERT"
    MESSAGES_UPDATE = "MESSAGES_UPDATE"
    MESSAGES_DELETE = "MESSAGES_DELETE"
    SEND_MESSAGE = "SEND_MESSAGE"
    CONTACTS_SET = "CONTACTS_SET"
    CONTACTS_UPSERT = "CONTACTS_UPSERT"
    CONTACTS_UPDATE = "CONTACTS_UPDATE"
    PRESENCE_UPDATE = "PRESENCE_UPDATE"
    GROUPS_UPSERT = "GROUPS_UPSERT"
    GROUPS_UPDATE = "GROUPS_UPDATE"
    GROUP_UPDATE = "GROUP_UPDATE"
    GROUP_PARTICIPANTS_UPDATE = "GROUP_PARTICIPANTS_UPDATE"
    NEW_TOKEN = "NEW_TOKEN"
    CALL = "CALL"
    LOGOUT_INSTANCE = "LOGOUT_INSTANCE"
    INSTANCE_DELETE = "INSTANCE_DELETE"
    REMOVE_INSTANCE = "REMOVE_INSTANCE"


def _normalize_event_names(names: tuple[Any, ...]) -> list[str]:
    out: list[str] = []
    for item in names:
        if isinstance(item, (list, tuple, set)):
            for sub in item:
                s = str(sub or "").strip()
                if s:
                    out.append(s.replace(".", "_").replace("-", "_").upper())
        else:
            s = str(item or "").strip()
            if s:
                out.append(s.replace(".", "_").replace("-", "_").upper())
    return out


def handler(*event_names: str):
    names = _normalize_event_names(event_names)

    def decorator(func: Callable[..., Any]):
        for name in names:
            existing = HANDLERS.get(name)
            if existing is None or existing is func:
                HANDLERS[name] = func
                continue

            async def _fanout(*args, _existing=existing, _func=func, **kwargs):
                results = []

                r1 = _existing(*args, **kwargs)
                if inspect.isawaitable(r1):
                    r1 = await r1
                results.append(r1)

                r2 = _func(*args, **kwargs)
                if inspect.isawaitable(r2):
                    r2 = await r2
                results.append(r2)

                return results

            HANDLERS[name] = _fanout

        return func

    return decorator


_GROUP_INFO_CACHE: dict[tuple[str, str], tuple[str, int]] = {}
_GROUP_INFO_TTL = 60 * 60

# lid map provisório em memória até consolidar repo/state definitivo
_LID_MAP: dict[tuple[int, int, str], str] = {}


def _to_int(v) -> int | None:
    try:
        if v is None:
            return None
        return int(v)
    except Exception:
        return None


def _carimbar_inst(obj, inst) -> None:
    if obj is None or inst is None:
        return

    if hasattr(obj, "instancia_id") and getattr(obj, "instancia_id", None) is None:
        setattr(obj, "instancia_id", getattr(inst, "id", None))

    if hasattr(obj, "instance_name") and not getattr(obj, "instance_name", None):
        setattr(obj, "instance_name", getattr(inst, "instance_name", None))


def _get_inst_row(db: Session, instance_name: str | None) -> models.EmpresaInstancia | None:
    raw = str(instance_name or "").strip()
    if not raw:
        return None

    return (
        db.query(models.EmpresaInstancia)
        .filter(models.EmpresaInstancia.instance_name == raw)
        .first()
    )


def _me_number_by_inst(inst: models.EmpresaInstancia | None) -> str | None:
    if not inst:
        return None

    raw = getattr(inst, "numero_instancia", None)
    if not raw:
        return None

    digits = re.sub(r"\D+", "", str(raw))
    return digits or None


def _fetch_cliente(db: Session, cliente_id: int | None) -> models.Cliente | None:
    if not cliente_id:
        return None
    return get_cliente_by_id(db, int(cliente_id))


def _get_cliente_departamento_id(db: Session, cliente_id: int | None) -> int | None:
    cli = _fetch_cliente(db, cliente_id)
    if not cli:
        return None
    return _to_int(getattr(cli, "departamento_id", None))


def _get_cliente_operador_id(db: Session, cliente_id: int | None) -> int | None:
    cli = _fetch_cliente(db, cliente_id)
    if not cli:
        return None
    return _to_int(getattr(cli, "colaborador_id", None))


def upsert_cliente(
    db: Session,
    *,
    empresa_id: int,
    instancia_id: int | None,
    telefone_raw: str,
    nome: str | None = None,
    nome_whatsapp: str | None = None,
    avatar_url: str | None = None,
) -> int | None:
    return upsert_cliente_repo(
        db,
        empresa_id=int(empresa_id),
        instancia_id=(int(instancia_id) if instancia_id is not None else None),
        telefone_raw=telefone_raw,
        nome=nome,
        nome_whatsapp=nome_whatsapp,
        avatar_url=avatar_url,
    )


_HAS_MSG_ATD_FIELD = has_mensagem_atendimento_field()


def _get_or_open_atendimento(
    db: Session,
    *,
    empresa_id: int,
    instancia_id: int,
    cliente_id: int,
    direcao: str,
    ts_dt,
    departamento_id: int | None = None,
    operador_id: int | None = None,
):
    dep_id = _to_int(departamento_id)
    op_id = _to_int(operador_id)

    # fallback enquanto o restante dos callers vai sendo adaptado:
    # se não vier departamento/operador, tenta puxar do cliente atual
    if dep_id is None:
        dep_id = _get_cliente_departamento_id(db, cliente_id)

    if op_id is None:
        op_id = _get_cliente_operador_id(db, cliente_id)

    return get_or_open_atendimento_repo(
        db,
        empresa_id=int(empresa_id),
        instancia_id=int(instancia_id),
        cliente_id=int(cliente_id),
        direcao=direcao,
        ts_dt=ts_dt,
        departamento_id=dep_id,
        operador_id=op_id,
    )


def _is_deadlock_error(e: Exception) -> bool:
    base = getattr(e, "orig", e)
    msg = str(base).lower()
    return "deadlock detected" in msg


async def _retry_deadlock(db: Session, func, *, attempts: int = 5, base_delay: float = 0.02):
    for i in range(attempts):
        try:
            return func()
        except Exception as e:
            if _is_deadlock_error(e):
                try:
                    db.rollback()
                except Exception:
                    pass
                await asyncio.sleep(base_delay * (2**i))
                continue
            raise


def _invalidate_emp_cache(emp_id: int) -> None:
    invalidate_emp_cache(int(emp_id))


def _lid_map_key(empresa_id: int, instancia_id: int, lid_jid: str | None) -> tuple[int, int, str]:
    return (
        int(empresa_id),
        int(instancia_id),
        jid_strip_device(lid_jid or ""),
    )


def _lid_map_set(empresa_id: int, instancia_id: int, lid_jid: str, real_jid: str) -> bool:
    lid_norm = jid_strip_device(lid_jid)
    real_norm = jid_strip_device(real_jid)
    if not lid_norm or not real_norm:
        return False
    _LID_MAP[_lid_map_key(empresa_id, instancia_id, lid_norm)] = real_norm
    return True


def _lid_map_get(empresa_id: int, instancia_id: int, lid_jid: str | None) -> str | None:
    key = _lid_map_key(empresa_id, instancia_id, lid_jid or "")
    return _LID_MAP.get(key)


def _resolve_remote_jid(empresa_id: int, instancia_id: int, raw_remote: str | None) -> str | None:
    raw = jid_strip_device(raw_remote)
    if not raw:
        return None
    if not is_lid_jid(raw):
        return raw
    mapped = _lid_map_get(empresa_id, instancia_id, raw)
    return jid_strip_device(mapped) if mapped else None


def is_nome_grupo_ruim(nome: str | None) -> bool:
    if not nome:
        return True
    n = str(nome).strip().lower()
    return (n == "") or (n in {"grupo", "group", "grupo do whatsapp", "whatsapp group"})


def evo_get_group_subject(instance_name: str, group_jid: str) -> str | None:
    if not instance_name or not group_jid:
        return None

    key = (instance_name, group_jid)
    now = _int_unix(_now_utc())

    cached = _GROUP_INFO_CACHE.get(key)
    if cached:
        subject_cached, ts_cached = cached
        if (now - ts_cached) < _GROUP_INFO_TTL:
            return subject_cached

    try:
        subject = EvolutionHttpClient().get_group_subject(instance_name, group_jid)
        if subject:
            _GROUP_INFO_CACHE[key] = (subject, now)
        return subject
    except Exception:
        return None


def is_statement_timeout_error(e: Exception) -> bool:
    base = getattr(e, "orig", e)
    msg = str(base).lower()
    return (
        "statement timeout" in msg
        or "canceling statement due to statement timeout" in msg
        or "querycanceled" in msg
        or "query canceled" in msg
        or "lock timeout" in msg
    )


def is_duplicate_key_error(e: Exception) -> bool:
    base = getattr(e, "orig", e)
    msg = str(base).lower()
    return (
        "duplicate key value violates unique constraint" in msg
        or "unique violation" in msg
        or "uq_mensagens_" in msg
    )


def find_existing_mensagem_11_id(
    db: Session,
    *,
    empresa_id: int,
    cliente_id: int | None,
    msg_id: str | None,
    instancia_id: int | None,
) -> int | None:
    raw = str(msg_id or "").strip()
    if not raw:
        return None

    if instancia_id is not None:
        row = db.execute(
            text(
                """
                SELECT id
                  FROM mensagens
                 WHERE instancia_id = :instancia_id
                   AND msg_id = :msg_id
                 ORDER BY id DESC
                 LIMIT 1
                """
            ),
            {
                "instancia_id": int(instancia_id),
                "msg_id": raw,
            },
        ).fetchone()
        if row and row[0] is not None:
            return int(row[0])

    if empresa_id is not None and cliente_id is not None:
        row = db.execute(
            text(
                """
                SELECT id
                  FROM mensagens
                 WHERE empresa_id = :empresa_id
                   AND cliente_id = :cliente_id
                   AND msg_id = :msg_id
                 ORDER BY id DESC
                 LIMIT 1
                """
            ),
            {
                "empresa_id": int(empresa_id),
                "cliente_id": int(cliente_id),
                "msg_id": raw,
            },
        ).fetchone()
        if row and row[0] is not None:
            return int(row[0])

    return None


async def insert_mensagem_11_with_retry(
    db: Session,
    *,
    empresa_id: int,
    cliente_id: int,
    conteudo: str,
    tipo: str,
    lida: bool,
    ack: int | None,
    timestamp,
    msg_id: str,
    instancia_id: int,
    atendimento_id: int | None,
    idx: int,
) -> tuple[int | None, bool]:
    sql = text(
        """
        INSERT INTO mensagens
            (empresa_id, cliente_id, conteudo, tipo, lida, ack, timestamp, msg_id, instancia_id, atendimento_id)
        VALUES
            (:empresa_id, :cliente_id, :conteudo, :tipo, :lida, :ack, :timestamp, :msg_id, :instancia_id, :atendimento_id)
        ON CONFLICT (instancia_id, msg_id)
        DO NOTHING
        RETURNING id
        """
    )

    params = {
        "empresa_id": int(empresa_id),
        "cliente_id": int(cliente_id),
        "conteudo": conteudo,
        "tipo": tipo,
        "lida": bool(lida),
        "ack": ack,
        "timestamp": timestamp,
        "msg_id": str(msg_id),
        "instancia_id": int(instancia_id),
        "atendimento_id": atendimento_id,
    }

    for tentativa in range(3):
        try:
            row = db.execute(sql, params).fetchone()
            if row:
                return int(row[0]), True

            existente_id = find_existing_mensagem_11_id(
                db,
                empresa_id=empresa_id,
                cliente_id=cliente_id,
                msg_id=msg_id,
                instancia_id=instancia_id,
            )
            return existente_id, False

        except IntegrityError as e:
            try:
                db.rollback()
            except Exception:
                pass

            if is_duplicate_key_error(e):
                existente_id = find_existing_mensagem_11_id(
                    db,
                    empresa_id=empresa_id,
                    cliente_id=cliente_id,
                    msg_id=msg_id,
                    instancia_id=instancia_id,
                )
                _log_ctx(
                    "[UPsert][duplicate-tolerated]",
                    idx=idx,
                    msg_id=msg_id,
                    cliente_id=cliente_id,
                    existing_id=existente_id,
                    err=str(e),
                )
                return existente_id, False

            if is_statement_timeout_error(e) and tentativa < 2:
                _log_ctx(
                    "[UPsert][retry-timeout]",
                    idx=idx,
                    msg_id=msg_id,
                    tentativa=(tentativa + 1),
                    err=str(e),
                )
                await asyncio.sleep(0.15 * (tentativa + 1))
                continue
            raise

        except Exception as e:
            try:
                db.rollback()
            except Exception:
                pass

            if is_statement_timeout_error(e) and tentativa < 2:
                _log_ctx(
                    "[UPsert][retry-timeout]",
                    idx=idx,
                    msg_id=msg_id,
                    tentativa=(tentativa + 1),
                    err=str(e),
                )
                await asyncio.sleep(0.15 * (tentativa + 1))
                continue
            raise


def _is_textual_content(conteudo: Any) -> bool:
    return bool(str(conteudo or "").strip())


async def run_triagem_pos_commit(
    *,
    empresa_id: int,
    instancia_id: int,
    telefone: str,
    conteudo: str,
    direcao: str,
    remote_jid: str,
):
    if not conteudo or direcao != "entrada" or not _is_textual_content(conteudo):
        return

    with SessionLocal() as db_triagem:
        try:
            if callable(auto_messages_handle_inbound):
                auto_res = auto_messages_handle_inbound(
                    db_triagem,
                    empresa_id=empresa_id,
                    instancia_id=instancia_id,
                    telefone_digits=telefone,
                    texto=conteudo,
                    direction=direcao,
                    remote_jid=remote_jid,
                )
                LOG(f"[CHATBOT][auto_messages] res={auto_res}")

                auto_action = str((auto_res or {}).get("action") or "")
                if auto_action in {"sent_off_hours", "sent_welcome"}:
                    try:
                        db_triagem.commit()
                    except Exception:
                        try:
                            db_triagem.rollback()
                        except Exception:
                            pass
                    return

            triagem_res = triagem_handle_inbound(
                db_triagem,
                empresa_id=empresa_id,
                instancia_id=instancia_id,
                telefone_digits=telefone,
                texto=conteudo,
                direction=direcao,
                remote_jid=remote_jid,
            )
            try:
                db_triagem.commit()
            except Exception:
                try:
                    db_triagem.rollback()
                except Exception:
                    pass
            LOG(f"[CHATBOT][triagem] res={triagem_res}")
        except Exception as e:
            try:
                db_triagem.rollback()
            except Exception:
                pass
            LOG(f"[CHATBOT] erro ao processar inbound do chatbot: {e}")


async def save_media_pos_commit_11(
    *,
    inst_id: str,
    empresa_id: int,
    cli_id: int,
    msg_db_id: int,
    msg_id: str | None,
    media_meta: dict,
    instancia_db_id: int,
    idx: int,
):
    with SessionLocal() as db_media:
        try:
            ok = save_media_for_message_11_with_db(
                db_media,
                inst_id=inst_id,
                empresa_id=int(empresa_id),
                cliente_id=int(cli_id),
                mensagem_id=int(msg_db_id),
                msg_id=(str(msg_id) if msg_id else None),
                media_meta=media_meta,
                instancia_id=int(instancia_db_id),
                idx=idx,
            )
            if ok:
                db_media.commit()
            else:
                db_media.rollback()
        except Exception as e:
            try:
                db_media.rollback()
            except Exception:
                pass
            _log_ctx("[UPsert][midia] erro ao salvar", idx=idx, msg_id=msg_id, err=str(e))


def save_group_media_with_db(
    db: Session,
    *,
    inst_id: str,
    empresa_id: int,
    grupo_id: int,
    cliente_id: int | None,
    msg_id: str | None,
    media_meta: dict,
    instancia_db_id: int,
    idx: int = 0,
) -> bool:
    return save_media_for_group_message_with_db(
        db,
        inst_id=inst_id,
        empresa_id=int(empresa_id),
        grupo_id=int(grupo_id),
        cliente_id=(int(cliente_id) if cliente_id is not None else None),
        msg_id=(str(msg_id) if msg_id else None),
        media_meta=media_meta,
        instancia_id=int(instancia_db_id),
        idx=idx,
    )


def grupo_row_by_remote(
    db: Session,
    empresa_id: int,
    remote_jid: str,
    instancia_id: int | None = None,
    inst_obj: models.EmpresaInstancia | None = None,
) -> models.Grupo:
    return get_or_create_grupo_by_remote(
        db,
        empresa_id=int(empresa_id),
        remote_jid=jid_strip_device(remote_jid),
        instancia_id=(int(instancia_id) if instancia_id is not None else None),
        inst_obj=inst_obj,
        nome_padrao="Grupo",
    )


def name_from_contact_like(c: dict) -> str | None:
    for k in (
        "verifiedName",
        "name",
        "pushName",
        "notifyName",
        "formattedName",
        "shortName",
        "contactName",
        "subject",
        "title",
        "displayName",
    ):
        v = c.get(k)
        if isinstance(v, str) and v.strip():
            return v.strip()
    return None


def avatar_from_contact_like(c: dict) -> str | None:
    return (
        c.get("profilePicUrl")
        or (c.get("profilePicThumbObj") or {}).get("eurl")
        or c.get("thumbnailUrl")
        or c.get("imageUrl")
        or c.get("pictureUrl")
        or None
    )


def upsert_grupos_from_chats(db: Session, empresa_id: int, chats: list[dict], inst: models.EmpresaInstancia) -> int:
    return _repo_upsert_grupos_from_chats(
        db,
        empresa_id=int(empresa_id),
        chats=chats,
        inst=inst,
    )


__all__ = [
    "HANDLERS",
    "EvoEvent",
    "handler",
    "_carimbar_inst",
    "_get_inst_row",
    "_me_number_by_inst",
    "_fetch_cliente",
    "_get_cliente_departamento_id",
    "_get_cliente_operador_id",
    "_HAS_MSG_ATD_FIELD",
    "_get_or_open_atendimento",
    "_retry_deadlock",
    "_invalidate_emp_cache",
    "_lid_map_set",
    "_lid_map_get",
    "_resolve_remote_jid",
    "upsert_cliente",
    "is_statement_timeout_error",
    "is_duplicate_key_error",
    "find_existing_mensagem_11_id",
    "insert_mensagem_11_with_retry",
    "run_triagem_pos_commit",
    "save_media_pos_commit_11",
    "save_group_media_with_db",
    "is_nome_grupo_ruim",
    "evo_get_group_subject",
    "grupo_row_by_remote",
    "name_from_contact_like",
    "avatar_from_contact_like",
    "upsert_grupos_from_chats",
    "_save_midia_db",
    "_b64_to_bytes",
    "normalize_mimetype",
    "remote_to_num",
    "formatar_telefone_br",
    "_resolve_counterparty_num_1to1",
    "jid_strip_device",
    "is_lid_jid",
    "_now_utc",
    "_server_ts_ms",
    "_iso_utc",
    "_int_unix",
]