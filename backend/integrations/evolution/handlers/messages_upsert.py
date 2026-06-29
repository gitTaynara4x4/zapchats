# backend/integrations/evolution/handlers/messages_upsert.py

from __future__ import annotations

import asyncio
import os

from sqlalchemy import func
from sqlalchemy.exc import IntegrityError

from backend import models
from backend.database import SessionLocal
from backend.websocket_manager import conexoes_ativas

from ..parsers.base_extractors import (
    extract_media_meta,
    extract_messages_any_shape,
    extract_text_from_baileys,
)
from ..utils.ack_utils import _ack_from_status
from ..utils.cache_utils import invalidate_emp_cache
from ..utils.jid_utils import is_lid_jid, jid_strip_device
from ..utils.log_utils import LOG, _log_ctx, _log_skip, _short
from ..utils.phone_utils import (
    _resolve_counterparty_num_1to1,
    formatar_telefone_br,
    normalize_phone_for_db,
    normalize_phone_for_send,
    remote_to_num,
)
from ..utils.time_utils import _iso_utc, _server_ts_ms, _to_dt_utc
from ._state import chatbot_should_process_msg
from .shared import (
    EvoEvent,
    HANDLERS,
    _HAS_MSG_ATD_FIELD,
    _carimbar_inst,
    _fetch_cliente,
    _get_inst_row,
    _get_or_open_atendimento,
    _invalidate_emp_cache,
    _lid_map_set,
    _me_number_by_inst,
    _retry_deadlock,
    avatar_from_contact_like,
    find_existing_mensagem_11_id,
    grupo_row_by_remote,
    handler,
    insert_mensagem_11_with_retry,
    is_nome_grupo_ruim,
    evo_get_group_subject,
    merge_lid_cliente_into_real_cliente,
    resolve_lid_identity,
    run_triagem_pos_commit,
    save_group_media_with_db,
    save_media_pos_commit_11,
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


# REGRA OFICIAL DO ZAPSCHAT:
# LID sem número real NÃO pode virar cliente visível.
# Deixe false em produção.
# Se colocar true, volta o comportamento antigo de importar LID como telefone provisório.
UPSERT_IMPORT_UNRESOLVED_LID = _bool_env_value("EVO_UPSERT_IMPORT_UNRESOLVED_LID", False)


def _int_env_value(name: str, default: int = 0) -> int:
    raw = os.getenv(name)
    if raw is None:
        return int(default)
    try:
        return int(float(str(raw).strip()))
    except Exception:
        return int(default)


# Anti-enxurrada: se o cliente mandar várias mensagens seguidas, o chatbot/triagem
# roda uma vez só depois que a enxurrada parar. 0 desliga e volta ao comportamento antigo.
EVO_CHATBOT_BURST_DEBOUNCE_MS = max(
    0,
    _int_env_value("EVO_CHATBOT_BURST_DEBOUNCE_MS", 2200),
)

# V23 modo seguro:
# O log mostrou que a mensagem salva no banco, mas o navegador trava exatamente
# depois do backend empurrar o payload pelo WebSocket.
# Por padrão, corta o PUSH ao vivo de mensagens para não congelar a tela.
# As mensagens continuam salvando normalmente no banco.
# Para reativar o tempo real depois que o front estiver estabilizado:
# WS_EMIT_MESSAGES=true
WS_EMIT_MESSAGES = _bool_env_value("WS_EMIT_MESSAGES", False)

# V11: o log mostrou atraso entre [ws-live][skip] e [commit-final].
# O ponto nessa janela é invalidate_emp_cache(), que pode fazer scan/delete em Redis remoto
# e travar a finalização do processamento. Por padrão, NÃO invalida cache no fluxo
# de mensagem recebida. Para reativar manualmente: EVO_INVALIDATE_CACHE_ON_MESSAGE=true
EVO_INVALIDATE_CACHE_ON_MESSAGE = _bool_env_value("EVO_INVALIDATE_CACHE_ON_MESSAGE", False)

def _should_invalidate_cache_on_message() -> bool:
    return bool(EVO_INVALIDATE_CACHE_ON_MESSAGE)

def _invalidate_emp_cache_after_message_safe(empresa_id: int, *, where: str = "") -> None:
    if not _should_invalidate_cache_on_message():
        try:
            LOG(f"[UPsert][cache][skip] EVO_INVALIDATE_CACHE_ON_MESSAGE=false where={where} emp={empresa_id}")
        except Exception:
            pass
        return
    try:
        invalidate_emp_cache(empresa_id)
    except Exception as e:
        try:
            LOG(f"[UPsert][cache][erro] where={where} emp={empresa_id} err={e}")
        except Exception:
            pass

def _ws_emit_messages_enabled() -> bool:
    return bool(WS_EMIT_MESSAGES)

_CHATBOT_BURST_TASKS: dict[tuple[int, int, str], asyncio.Task] = {}


async def _run_or_schedule_triagem_pos_commit(
    *,
    empresa_id: int,
    instancia_id: int,
    telefone: str,
    conteudo: str,
    direcao: str,
    remote_jid: str,
) -> None:
    if EVO_CHATBOT_BURST_DEBOUNCE_MS <= 0:
        await run_triagem_pos_commit(
            empresa_id=empresa_id,
            instancia_id=instancia_id,
            telefone=telefone,
            conteudo=conteudo,
            direcao=direcao,
            remote_jid=remote_jid,
        )
        return

    key = (int(empresa_id), int(instancia_id), str(telefone or ""))
    delay = EVO_CHATBOT_BURST_DEBOUNCE_MS / 1000.0

    old_task = _CHATBOT_BURST_TASKS.get(key)
    if old_task and not old_task.done():
        old_task.cancel()

    async def _runner():
        try:
            await asyncio.sleep(delay)
            await run_triagem_pos_commit(
                empresa_id=empresa_id,
                instancia_id=instancia_id,
                telefone=telefone,
                conteudo=conteudo,
                direcao=direcao,
                remote_jid=remote_jid,
            )
        except asyncio.CancelledError:
            return
        except Exception as e:
            LOG(
                f"[CHATBOT][burst-debounce][erro] emp={empresa_id} "
                f"inst={instancia_id} telefone={telefone} err={e}"
            )
        finally:
            if _CHATBOT_BURST_TASKS.get(key) is task:
                _CHATBOT_BURST_TASKS.pop(key, None)

    task = asyncio.create_task(_runner())
    _CHATBOT_BURST_TASKS[key] = task
    LOG(
        f"[CHATBOT][burst-debounce] agendado emp={empresa_id} inst={instancia_id} "
        f"telefone={telefone} delay_ms={EVO_CHATBOT_BURST_DEBOUNCE_MS}"
    )


def _safe_rollback(db) -> None:
    try:
        db.rollback()
    except Exception:
        pass


def _only_digits(raw) -> str:
    return "".join(ch for ch in str(raw or "") if ch.isdigit())


def _same_phone(a, b) -> bool:
    da = _only_digits(a)
    db = _only_digits(b)

    if not da or not db:
        return False

    return da == db or da.endswith(db) or db.endswith(da)



def _int_or_none(value) -> int | None:
    try:
        if value is None:
            return None
        raw = str(value).strip()
        if not raw:
            return None
        return int(raw)
    except Exception:
        return None


def _ack_from_status_safe_for_upsert(status, *, from_me: bool) -> int:
    """
    ACK seguro para messages.upsert.

    Problema que corrigimos:
    - A Evolution pode devolver/enviar status="PENDING" para uma mensagem fromMe.
    - _ack_from_status("PENDING") normalmente vira 0.
    - Se esse 0 entra no banco/WS, o front mostra relógio mesmo depois do envio ter dado 201.

    Regra do ZapsChat:
    - mensagem from_me recebida via upsert já foi aceita pela Evolution;
    - portanto o mínimo visual deve ser ack=1;
    - nunca usamos messages.upsert para rebaixar ACK.
    """
    if not from_me:
        return 0

    try:
        ack = int(_ack_from_status(status) or 0)
    except Exception:
        ack = 0

    if ack <= 0:
        ack = 1

    if ack > 3:
        ack = 3

    return int(ack)


def _raise_ack_on_model_if_newer(row, ack_value: int | None) -> int:
    """
    Atualiza ACK somente para frente.
    Retorna o ACK final que deve ser usado no payload.
    """
    new_ack = _int_or_none(ack_value) or 0
    old_ack = _int_or_none(getattr(row, "ack", None)) or 0

    final_ack = max(old_ack, new_ack)

    if row is not None and final_ack > old_ack:
        try:
            setattr(row, "ack", int(final_ack))
            if hasattr(row, "lida") and final_ack > 0:
                setattr(row, "lida", True)
        except Exception:
            pass

    return int(final_ack)


def _raise_ack_existing_mensagem_11(
    db,
    *,
    empresa_id: int,
    cliente_id: int | None,
    instancia_id: int | None,
    msg_id: str | None,
    mensagem_id: int | None,
    ack_value: int,
) -> int:
    """
    Quando messages.upsert chega duplicado para uma mensagem já salva pelo send,
    não deve criar outra bolha e também não deve rebaixar ACK.
    Se o ACK novo for maior, atualiza o registro existente.
    """
    if not ack_value:
        return 0

    try:
        q = db.query(models.Mensagem)

        if mensagem_id:
            q = q.filter(models.Mensagem.id == int(mensagem_id))
        else:
            if not msg_id:
                return int(ack_value)
            q = q.filter(
                models.Mensagem.empresa_id == int(empresa_id),
                models.Mensagem.msg_id == str(msg_id),
            )
            if cliente_id is not None:
                q = q.filter(models.Mensagem.cliente_id == int(cliente_id))
            if instancia_id is not None:
                q = q.filter(models.Mensagem.instancia_id == int(instancia_id))

        row = q.order_by(models.Mensagem.id.desc()).first()
        if not row:
            return int(ack_value)

        final_ack = _raise_ack_on_model_if_newer(row, int(ack_value))
        db.flush()
        return int(final_ack)

    except Exception as e:
        LOG(f"[UPsert][ack-safe][cliente] falha ao preservar ACK msg_id={msg_id} err={e}")
        _safe_rollback(db)
        return int(ack_value)


def _raise_ack_existing_mensagem_grupo(
    db,
    *,
    empresa_id: int,
    grupo_id: int | None,
    instancia_id: int | None,
    msg_id: str | None,
    mensagem_grupo_id: int | None,
    ack_value: int,
) -> int:
    """
    Mesma regra para grupos: ACK só anda para frente.
    """
    if not ack_value:
        return 0

    try:
        q = db.query(models.MensagemGrupo)

        if mensagem_grupo_id:
            q = q.filter(models.MensagemGrupo.id == int(mensagem_grupo_id))
        else:
            if not msg_id:
                return int(ack_value)
            q = q.filter(
                models.MensagemGrupo.empresa_id == int(empresa_id),
                models.MensagemGrupo.msg_id == str(msg_id),
            )
            if grupo_id is not None:
                q = q.filter(models.MensagemGrupo.grupo_id == int(grupo_id))
            if instancia_id is not None:
                q = q.filter(models.MensagemGrupo.instancia_id == int(instancia_id))

        row = q.order_by(models.MensagemGrupo.id.desc()).first()
        if not row:
            return int(ack_value)

        final_ack = _raise_ack_on_model_if_newer(row, int(ack_value))
        db.flush()
        return int(final_ack)

    except Exception as e:
        LOG(f"[UPsert][ack-safe][grupo] falha ao preservar ACK msg_id={msg_id} err={e}")
        _safe_rollback(db)
        return int(ack_value)


def _is_cliente_fk_error(e: Exception) -> bool:
    base = getattr(e, "orig", e)
    msg = str(base).lower()
    return (
        "mensagens_cliente_id_fkey" in msg
        or (
            "key (cliente_id)=" in msg
            and 'is not present in table "clientes"' in msg
        )
        or ("foreignkeyviolation" in msg and "cliente_id" in msg)
    )


def _cliente_exists(db, cliente_id: int | None, empresa_id: int | None = None) -> bool:
    if not cliente_id:
        return False

    try:
        q = db.query(models.Cliente.id).filter(models.Cliente.id == int(cliente_id))

        if empresa_id is not None:
            q = q.filter(models.Cliente.empresa_id == int(empresa_id))

        row = q.first()
        return bool(row and row[0] is not None)
    except Exception:
        return False


def _find_cliente_id_by_phone(
    db,
    *,
    empresa_id: int,
    instancia_id: int,
    telefone: str,
) -> int | None:
    telefone_db = normalize_phone_for_db(telefone)
    if not telefone_db:
        return None

    try:
        row = (
            db.query(models.Cliente.id)
            .filter(
                models.Cliente.empresa_id == int(empresa_id),
                models.Cliente.telefone_norm == telefone_db,
                models.Cliente.instancia_id == int(instancia_id),
            )
            .order_by(models.Cliente.id.desc())
            .first()
        )
        if row and row[0] is not None:
            return int(row[0])
    except Exception:
        _safe_rollback(db)

    try:
        row = (
            db.query(models.Cliente.id)
            .filter(
                models.Cliente.empresa_id == int(empresa_id),
                models.Cliente.telefone_norm == telefone_db,
            )
            .order_by(models.Cliente.id.desc())
            .first()
        )
        if row and row[0] is not None:
            return int(row[0])
    except Exception:
        _safe_rollback(db)

    return None


async def _ensure_cliente_id(
    db,
    *,
    empresa_id: int,
    instancia_id: int,
    telefone: str,
    nome: str | None,
    nome_whatsapp: str | None,
    avatar_url: str | None = None,
) -> int | None:
    telefone_db = normalize_phone_for_db(telefone)
    if not telefone_db:
        return None

    try:
        return await _retry_deadlock(
            db,
            lambda: upsert_cliente(
                db,
                empresa_id=empresa_id,
                instancia_id=instancia_id,
                telefone_raw=telefone_db,
                nome=nome,
                nome_whatsapp=nome_whatsapp,
                avatar_url=avatar_url,
            ),
        )
    except Exception:
        _safe_rollback(db)
        return None


async def _ensure_cliente_id_fk_safe(
    db,
    *,
    empresa_id: int,
    instancia_id: int,
    telefone: str,
    nome: str | None,
    nome_whatsapp: str | None,
    avatar_url: str | None = None,
    current_cliente_id: int | None = None,
) -> int | None:
    """
    Garante um cliente_id realmente existente na tabela clientes.

    Resolve:
    - cliente_id antigo após rollback;
    - retorno fantasma de upsert;
    - cliente criado e apagado por rollback antes da mensagem;
    - fallback por telefone_norm dentro da empresa.
    """
    if current_cliente_id and _cliente_exists(db, current_cliente_id, empresa_id=empresa_id):
        return int(current_cliente_id)

    found = _find_cliente_id_by_phone(
        db,
        empresa_id=empresa_id,
        instancia_id=instancia_id,
        telefone=telefone,
    )
    if found and _cliente_exists(db, found, empresa_id=empresa_id):
        return int(found)

    cli_id = await _ensure_cliente_id(
        db,
        empresa_id=empresa_id,
        instancia_id=instancia_id,
        telefone=telefone,
        nome=nome,
        nome_whatsapp=nome_whatsapp,
        avatar_url=avatar_url,
    )
    if cli_id and _cliente_exists(db, cli_id, empresa_id=empresa_id):
        return int(cli_id)

    found = _find_cliente_id_by_phone(
        db,
        empresa_id=empresa_id,
        instancia_id=instancia_id,
        telefone=telefone,
    )
    if found and _cliente_exists(db, found, empresa_id=empresa_id):
        return int(found)

    return None


def _safe_atendimento_id_for_cliente(
    db,
    *,
    empresa_id: int,
    instancia_id: int,
    cliente_id: int | None,
    atendimento_id: int | None,
) -> int | None:
    """
    Garante que o atendimento_id pertence ao mesmo cliente/empresa/instância.
    """
    if not _HAS_MSG_ATD_FIELD:
        return None

    if not atendimento_id or not cliente_id:
        return None

    Atendimento = getattr(models, "Atendimento", None)
    if Atendimento is None:
        return None

    try:
        q = db.query(Atendimento.id).filter(
            Atendimento.id == int(atendimento_id),
        )

        if hasattr(Atendimento, "empresa_id"):
            q = q.filter(Atendimento.empresa_id == int(empresa_id))

        if hasattr(Atendimento, "cliente_id"):
            q = q.filter(Atendimento.cliente_id == int(cliente_id))

        if hasattr(Atendimento, "instancia_id"):
            q = q.filter(Atendimento.instancia_id == int(instancia_id))

        row = q.first()
        return int(row[0]) if row and row[0] is not None else None

    except Exception:
        _safe_rollback(db)
        return None


def _resolve_atendimento_id_safe(
    db,
    *,
    empresa_id: int,
    instancia_id: int,
    cliente_id: int,
    direcao: str,
    ts_dt,
) -> int | None:
    """
    Resolve o atendimento usando o cliente final já validado no banco.
    """
    if not _HAS_MSG_ATD_FIELD:
        return None

    if not _cliente_exists(db, cliente_id, empresa_id=empresa_id):
        return None

    try:
        if hasattr(db, "is_active") and not db.is_active:
            _safe_rollback(db)

        atendimento = _get_or_open_atendimento(
            db,
            empresa_id=empresa_id,
            instancia_id=instancia_id,
            cliente_id=cliente_id,
            direcao=direcao,
            ts_dt=ts_dt,
            operador_id=None,
        )

        atendimento_id = getattr(atendimento, "id", None) if atendimento is not None else None

        return _safe_atendimento_id_for_cliente(
            db,
            empresa_id=empresa_id,
            instancia_id=instancia_id,
            cliente_id=cliente_id,
            atendimento_id=atendimento_id,
        )

    except Exception as e:
        LOG(f"[UPsert][erro_atendimento] cli={cliente_id} err={e}")
        _safe_rollback(db)
        return None


async def _insert_mensagem_11_fk_safe(
    db,
    *,
    empresa_id: int,
    cliente_id: int,
    conteudo: str,
    tipo: str,
    lida: bool,
    ack: int,
    timestamp,
    msg_id: str,
    instancia_id: int,
    atendimento_id: int | None,
    idx: int,
    telefone: str,
    nome: str | None,
    nome_whatsapp: str | None,
    avatar_url: str | None = None,
):
    """
    Tenta inserir a mensagem.

    Antes do insert:
    - valida se cliente_id existe;
    - valida se atendimento_id pertence ao cliente.

    Se mesmo assim estourar FK:
    - faz rollback;
    - recria/reobtém cliente;
    - salva a mensagem sem atendimento_id antigo.
    """
    cliente_id = await _ensure_cliente_id_fk_safe(
        db,
        empresa_id=empresa_id,
        instancia_id=instancia_id,
        telefone=telefone,
        nome=nome,
        nome_whatsapp=nome_whatsapp,
        avatar_url=avatar_url,
        current_cliente_id=cliente_id,
    )

    if not cliente_id:
        raise RuntimeError(f"cliente_id inválido antes do insert msg_id={msg_id} telefone={telefone}")

    atendimento_id = _safe_atendimento_id_for_cliente(
        db,
        empresa_id=empresa_id,
        instancia_id=instancia_id,
        cliente_id=cliente_id,
        atendimento_id=atendimento_id,
    )

    try:
        msg_db_id, inserted_11 = await insert_mensagem_11_with_retry(
            db,
            empresa_id=empresa_id,
            cliente_id=cliente_id,
            conteudo=conteudo,
            tipo=tipo,
            lida=lida,
            ack=ack,
            timestamp=timestamp,
            msg_id=msg_id,
            instancia_id=instancia_id,
            atendimento_id=atendimento_id,
            idx=idx,
        )
        return msg_db_id, inserted_11, int(cliente_id), atendimento_id

    except Exception as e:
        if not _is_cliente_fk_error(e):
            raise

        _log_ctx(
            "[UPsert][cliente-fk-retry]",
            idx=idx,
            msg_id=msg_id,
            cliente_id=cliente_id,
            err=str(e),
        )
        _safe_rollback(db)

        cli_retry = await _ensure_cliente_id_fk_safe(
            db,
            empresa_id=empresa_id,
            instancia_id=instancia_id,
            telefone=telefone,
            nome=nome,
            nome_whatsapp=nome_whatsapp,
            avatar_url=avatar_url,
            current_cliente_id=None,
        )
        if not cli_retry:
            raise RuntimeError(
                f"cliente_id inválido após retry FK msg_id={msg_id} telefone={telefone}"
            )

        msg_db_id, inserted_11 = await insert_mensagem_11_with_retry(
            db,
            empresa_id=empresa_id,
            cliente_id=cli_retry,
            conteudo=conteudo,
            tipo=tipo,
            lida=lida,
            ack=ack,
            timestamp=timestamp,
            msg_id=msg_id,
            instancia_id=instancia_id,
            atendimento_id=None,
            idx=idx,
        )
        return msg_db_id, inserted_11, int(cli_retry), None


async def _insert_mensagem_no_msgid_fk_safe(
    db,
    *,
    empresa_id: int,
    cliente_id: int,
    conteudo: str,
    tipo: str,
    lida: bool,
    ack: int,
    timestamp,
    instancia_id: int,
    atendimento_id: int | None,
    idx: int,
    telefone: str,
    nome: str | None,
    nome_whatsapp: str | None,
    inst,
    avatar_url: str | None = None,
):
    cliente_id = await _ensure_cliente_id_fk_safe(
        db,
        empresa_id=empresa_id,
        instancia_id=instancia_id,
        telefone=telefone,
        nome=nome,
        nome_whatsapp=nome_whatsapp,
        avatar_url=avatar_url,
        current_cliente_id=cliente_id,
    )

    if not cliente_id:
        raise RuntimeError(f"cliente_id inválido antes do insert sem msg_id telefone={telefone}")

    atendimento_id = _safe_atendimento_id_for_cliente(
        db,
        empresa_id=empresa_id,
        instancia_id=instancia_id,
        cliente_id=cliente_id,
        atendimento_id=atendimento_id,
    )

    def _build_model(cli_id: int, atd_id: int | None):
        msg_model = models.Mensagem(
            empresa_id=empresa_id,
            cliente_id=cli_id,
            conteudo=conteudo,
            tipo=tipo,
            lida=lida,
            ack=ack,
            timestamp=timestamp,
            msg_id=None,
            instancia_id=instancia_id,
        )
        if atd_id is not None and _HAS_MSG_ATD_FIELD:
            setattr(msg_model, "atendimento_id", atd_id)
        _carimbar_inst(msg_model, inst)
        return msg_model

    try:
        msg_model = _build_model(int(cliente_id), atendimento_id)
        db.add(msg_model)
        db.flush()
        return int(msg_model.id), True, int(cliente_id), atendimento_id

    except Exception as e:
        if not _is_cliente_fk_error(e):
            raise

        _log_ctx(
            "[UPsert][cliente-fk-retry-nomsgid]",
            idx=idx,
            cliente_id=cliente_id,
            err=str(e),
        )
        _safe_rollback(db)

        cli_retry = await _ensure_cliente_id_fk_safe(
            db,
            empresa_id=empresa_id,
            instancia_id=instancia_id,
            telefone=telefone,
            nome=nome,
            nome_whatsapp=nome_whatsapp,
            avatar_url=avatar_url,
            current_cliente_id=None,
        )
        if not cli_retry:
            raise RuntimeError(
                f"cliente_id inválido após retry FK sem msg_id telefone={telefone}"
            )

        msg_model = _build_model(int(cli_retry), None)
        db.add(msg_model)
        db.flush()
        return int(msg_model.id), True, int(cli_retry), None


def _lid_digits_from_jid(raw: str | None) -> str | None:
    s = jid_strip_device(raw or "")
    if not s or not is_lid_jid(s):
        return None

    left = s.split("@", 1)[0]
    digits = _only_digits(left)
    return digits or None


def _bad_push_name(name: str | None, *, raw_lid: str | None = None, telefone: str | None = None) -> bool:
    s = str(name or "").strip()
    if not s:
        return True

    low = s.lower().strip()

    if low in {
        "você",
        "voce",
        "you",
        "cliente",
        "contato",
        "unknown",
        "desconhecido",
        "0",
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

    digits = _only_digits(s)
    lid_digits = _lid_digits_from_jid(raw_lid)

    if lid_digits and digits and digits == lid_digits:
        return True

    if telefone and digits and _same_phone(digits, telefone):
        return True

    if digits and digits == s and len(digits) >= 13:
        return True

    compact = "".join(str(s).split())
    if digits and len(digits) >= 13 and digits == compact:
        return True

    return False


def _real_jid_candidate(value, *, me_number: str | None = None, raw_lid: str | None = None) -> str | None:
    if value is None:
        return None

    raw = jid_strip_device(str(value or "").strip())
    if not raw:
        return None

    if raw_lid and raw == jid_strip_device(raw_lid):
        return None

    low = raw.lower()

    if is_lid_jid(raw):
        return None

    if low.endswith("@g.us"):
        return None

    if low.endswith("@s.whatsapp.net") or low.endswith("@c.us"):
        tel = remote_to_num(raw)
        if not tel:
            return None

        if me_number and _same_phone(tel, me_number):
            return None

        return f"{tel}@s.whatsapp.net"

    if "@" in raw:
        return None

    digits = _only_digits(raw)
    if len(digits) < 10 or len(digits) > 15:
        return None

    if me_number and _same_phone(digits, me_number):
        return None

    send_e164 = normalize_phone_for_send(digits)
    if send_e164:
        return f"{send_e164}@s.whatsapp.net"

    return f"{digits}@s.whatsapp.net"


def _identity_hint_for_remote(
    db,
    *,
    empresa_id: int,
    instancia_id: int,
    remote_jid: str | None,
) -> dict:
    raw = jid_strip_device(remote_jid or "")
    out = {
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

            if _bad_push_name(
                out.get("push_name"),
                raw_lid=raw,
                telefone=out.get("telefone_norm"),
            ):
                out["push_name"] = None

            return out

        row = (
            db.query(models.ContatoWhatsappIdentidade)
            .filter(
                models.ContatoWhatsappIdentidade.empresa_id == int(empresa_id),
                models.ContatoWhatsappIdentidade.instancia_id == int(instancia_id),
                models.ContatoWhatsappIdentidade.remote_jid == raw,
            )
            .first()
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

            if _bad_push_name(
                out.get("push_name"),
                raw_lid=raw,
                telefone=out.get("telefone_norm"),
            ):
                out["push_name"] = None

    except Exception as e:
        LOG(
            f"[UPsert][identity-hint][erro] empresa_id={empresa_id} "
            f"instancia_id={instancia_id} remote={raw} err={e}"
        )
        _safe_rollback(db)

    return out


def _find_lid_cliente_id_for_merge(
    db,
    *,
    empresa_id: int,
    instancia_id: int,
    lid_jid: str,
    real_cliente_id: int,
) -> int | None:
    """
    Mantido apenas para corrigir sujeira antiga.
    Depois da correção, cliente LID novo não deve mais ser criado.
    """
    lid = jid_strip_device(lid_jid or "")
    if not lid or not is_lid_jid(lid):
        return None

    try:
        row = (
            db.query(models.ContatoWhatsappIdentidade.cliente_id)
            .filter(
                models.ContatoWhatsappIdentidade.empresa_id == int(empresa_id),
                models.ContatoWhatsappIdentidade.instancia_id == int(instancia_id),
                models.ContatoWhatsappIdentidade.lid_jid == lid,
                models.ContatoWhatsappIdentidade.cliente_id.isnot(None),
            )
            .order_by(models.ContatoWhatsappIdentidade.confianca.desc())
            .first()
        )
        if row and row[0] and int(row[0]) != int(real_cliente_id):
            return int(row[0])
    except Exception:
        _safe_rollback(db)

    lid_digits = _lid_digits_from_jid(lid)
    if not lid_digits:
        return None

    tel_norm = normalize_phone_for_db(lid_digits) or lid_digits

    try:
        row = (
            db.query(models.Cliente.id)
            .filter(
                models.Cliente.empresa_id == int(empresa_id),
                models.Cliente.instancia_id == int(instancia_id),
                models.Cliente.telefone_norm == tel_norm,
                models.Cliente.id != int(real_cliente_id),
            )
            .order_by(models.Cliente.id.desc())
            .first()
        )
        if row and row[0]:
            return int(row[0])
    except Exception:
        _safe_rollback(db)

    try:
        row = (
            db.query(models.Cliente.id)
            .filter(
                models.Cliente.empresa_id == int(empresa_id),
                models.Cliente.telefone_norm == tel_norm,
                models.Cliente.id != int(real_cliente_id),
            )
            .order_by(models.Cliente.id.desc())
            .first()
        )
        if row and row[0]:
            return int(row[0])
    except Exception:
        _safe_rollback(db)

    return None


def _merge_lid_history_with_new_session(
    *,
    empresa_id: int,
    instancia_id: int,
    lid_jid: str | None,
    real_jid: str | None,
    real_cliente_id: int | None,
) -> bool:
    if not lid_jid or not real_jid or not real_cliente_id:
        return False

    lid = jid_strip_device(lid_jid)
    real = jid_strip_device(real_jid)

    if not is_lid_jid(lid):
        return False

    if not real or is_lid_jid(real):
        return False

    with SessionLocal() as db_merge:
        try:
            lid_cliente_id = _find_lid_cliente_id_for_merge(
                db_merge,
                empresa_id=int(empresa_id),
                instancia_id=int(instancia_id),
                lid_jid=lid,
                real_cliente_id=int(real_cliente_id),
            )

            if not lid_cliente_id:
                return False

            ok = merge_lid_cliente_into_real_cliente(
                db_merge,
                empresa_id=int(empresa_id),
                instancia_id=int(instancia_id),
                lid_cliente_id=int(lid_cliente_id),
                real_cliente_id=int(real_cliente_id),
                lid_jid=lid,
                real_jid=real,
            )

            if ok:
                db_merge.commit()
                LOG(
                    f"[UPsert][identity-merge-ok] emp={empresa_id} inst={instancia_id} "
                    f"lid={lid} real={real} lid_cliente={lid_cliente_id} real_cliente={real_cliente_id}"
                )
                return True

            db_merge.rollback()
            return False

        except Exception as e:
            try:
                db_merge.rollback()
            except Exception:
                pass
            LOG(
                f"[UPsert][identity-merge-erro] emp={empresa_id} inst={instancia_id} "
                f"lid={lid} real={real} real_cliente={real_cliente_id} err={e}"
            )
            return False


def _resolve_remote_jid_upsert(
    db,
    *,
    empresa_id: int,
    instancia_id: int,
    key: dict,
    message_item: dict,
    me_number: str | None,
) -> str | None:
    raw_remote = (
        key.get("remoteJid")
        or key.get("remote_jid")
        or message_item.get("remoteJid")
        or message_item.get("jid")
        or message_item.get("chatId")
        or ""
    )
    raw_remote = jid_strip_device(raw_remote)
    if not raw_remote:
        return None

    if not is_lid_jid(raw_remote):
        return raw_remote

    # 1. Primeiro tenta a tabela alimentada por contacts.upsert/update.
    try:
        ident = resolve_lid_identity(
            db,
            empresa_id=int(empresa_id),
            instancia_id=int(instancia_id),
            lid_jid=raw_remote,
        )
        real_from_identity = jid_strip_device((ident or {}).get("real_jid") or "")
        if real_from_identity and not is_lid_jid(real_from_identity):
            _lid_map_set(empresa_id, instancia_id, raw_remote, real_from_identity)
            return real_from_identity
    except Exception as e:
        LOG(
            f"[UPsert][identity-resolve][erro] emp={empresa_id} "
            f"inst={instancia_id} raw={raw_remote} err={e}"
        )
        _safe_rollback(db)

    # 2. Campos alternativos diretos.
    alt_jid = (
        key.get("remoteJidAlt")
        or key.get("remote_jid_alt")
        or message_item.get("remoteJidAlt")
        or message_item.get("remote_jid_alt")
    )

    real_alt = _real_jid_candidate(alt_jid, me_number=me_number, raw_lid=raw_remote)
    if real_alt:
        _lid_map_set(empresa_id, instancia_id, raw_remote, real_alt)
        return real_alt

    # 3. Mesmo raciocínio antigo do upsert: tenta resolver contraparte.
    tel_fallback, alt = _resolve_counterparty_num_1to1(message_item, me_number)

    real_alt = _real_jid_candidate(alt, me_number=me_number, raw_lid=raw_remote)
    if real_alt:
        _lid_map_set(empresa_id, instancia_id, raw_remote, real_alt)
        return real_alt

    if tel_fallback and not str(tel_fallback).startswith("LID-"):
        real_tel = _real_jid_candidate(tel_fallback, me_number=me_number, raw_lid=raw_remote)
        if real_tel:
            _lid_map_set(empresa_id, instancia_id, raw_remote, real_tel)
            return real_tel

    if UPSERT_IMPORT_UNRESOLVED_LID:
        LOG(
            f"[UPsert][lid-fallback][legacy] sem telefone real para {raw_remote}; "
            "EVO_UPSERT_IMPORT_UNRESOLVED_LID=true, então vou manter LID."
        )
        return raw_remote

    LOG(
        f"[UPsert][lid-pending] sem telefone real para {raw_remote}; "
        "não vou criar cliente/conversa visível com LID."
    )
    return None


def _save_identity_for_1to1(
    db,
    *,
    empresa_id: int,
    instancia_id: int,
    raw_remote: str | None,
    remote_jid: str,
    telefone: str,
    cli_id: int,
    push_name: str | None,
    avatar_url: str | None,
) -> tuple[str | None, str | None]:
    """
    Atualiza a tabela contatos_whatsapp_identidades quando chega mensagem nova.

    Se raw_remote era @lid e remote_jid foi resolvido para @s.whatsapp.net,
    grava:
    LID -> real_jid -> cliente_id
    """
    raw_norm = jid_strip_device(raw_remote or "")
    remote_norm = jid_strip_device(remote_jid or "")

    lid_for_merge = raw_norm if is_lid_jid(raw_norm) else None
    real_for_merge = remote_norm if remote_norm and not is_lid_jid(remote_norm) else None

    safe_push_name = None if _bad_push_name(push_name, raw_lid=raw_norm, telefone=telefone) else push_name

    try:
        if raw_norm:
            upsert_whatsapp_identity(
                db,
                empresa_id=int(empresa_id),
                instancia_id=int(instancia_id),
                remote_jid=raw_norm,
                push_name=safe_push_name,
                profile_pic_url=avatar_url,
                origem="messages.upsert",
                cliente_id=int(cli_id),
                real_jid=real_for_merge if lid_for_merge else None,
                confirmado=bool(lid_for_merge and real_for_merge),
                confianca=(100 if lid_for_merge and real_for_merge else 70),
                resolved_by=("messages_upsert_resolved" if lid_for_merge and real_for_merge else "messages_upsert_seen"),
                payload=None,
                commit=False,
            )

        if remote_norm and remote_norm != raw_norm and not is_lid_jid(remote_norm):
            upsert_whatsapp_identity(
                db,
                empresa_id=int(empresa_id),
                instancia_id=int(instancia_id),
                remote_jid=remote_norm,
                push_name=safe_push_name,
                profile_pic_url=avatar_url,
                origem="messages.upsert",
                cliente_id=int(cli_id),
                confirmado=True,
                confianca=100,
                resolved_by="messages_upsert_real_jid",
                payload=None,
                commit=False,
            )

        if lid_for_merge and real_for_merge:
            _lid_map_set(empresa_id, instancia_id, lid_for_merge, real_for_merge)

    except Exception as e:
        LOG(
            f"[UPsert][identity-save][erro] emp={empresa_id} inst={instancia_id} "
            f"raw={raw_norm} remote={remote_norm} cli={cli_id} err={e}"
        )

    return lid_for_merge, real_for_merge


@handler(EvoEvent.MESSAGES_UPSERT)
async def on_messages_upsert(inst_id: str, data):
    with SessionLocal() as db:
        inst = _get_inst_row(db, inst_id)
        if not inst:
            LOG(f"[UPsert] instância não encontrada: {inst_id}")
            return

        empresa_id = int(inst.empresa_id)
        instancia_id = int(inst.id)
        me_number_raw = _me_number_by_inst(inst)
        me_number_db = normalize_phone_for_db(me_number_raw)

        mensagens = extract_messages_any_shape(data)
        _log_ctx(
            "[UPsert] batch",
            inst=inst_id,
            empresa_id=empresa_id,
            instancia_id=instancia_id,
            total=len(mensagens),
            type_data=type(data).__name__,
            UPSERT_IMPORT_UNRESOLVED_LID=UPSERT_IMPORT_UNRESOLVED_LID,
        )

        if not mensagens:
            LOG("[UPsert] nenhum item reconhecido em payload.")
            return

        novas = 0
        chatbot_replay_batch_seen: set[tuple[int, str]] = set()

        for idx, m in enumerate(mensagens, start=1):
            try:
                if not isinstance(m, dict):
                    _log_skip("m não é dict", idx=idx, type_m=type(m).__name__)
                    continue

                key = m.get("key") if isinstance(m.get("key"), dict) else {}
                raw_remote = (
                    key.get("remoteJid")
                    or key.get("remote_jid")
                    or m.get("remoteJid")
                    or m.get("jid")
                    or m.get("chatId")
                    or ""
                )
                raw_remote = jid_strip_device(raw_remote)

                msg_id = key.get("id") or m.get("id")
                ts_raw = m.get("messageTimestamp") or m.get("timestamp") or 0
                status = m.get("status")

                _log_ctx(
                    "[UPsert][in]",
                    idx=idx,
                    msg_id=msg_id,
                    raw_remote=raw_remote,
                    keys=list(m.keys())[:15],
                    ts_raw=ts_raw,
                    status=status,
                )

                if not raw_remote:
                    _log_skip("sem remoteJid", idx=idx, msg_id=msg_id)
                    continue

                remote_jid = _resolve_remote_jid_upsert(
                    db,
                    empresa_id=empresa_id,
                    instancia_id=instancia_id,
                    key=key,
                    message_item=m,
                    me_number=me_number_raw,
                )

                remote_jid = jid_strip_device(remote_jid or "")

                if not remote_jid:
                    _log_skip(
                        "remote_jid real não resolvido; não cria cliente visível",
                        idx=idx,
                        msg_id=msg_id,
                        raw_remote=raw_remote,
                    )
                    continue

                from_me = bool(key.get("fromMe", m.get("fromMe", False)))
                direcao = "saida" if from_me else "entrada"
                push_name_raw = m.get("pushName") or m.get("senderName")
                ts_msg = _to_dt_utc(ts_raw)
                conteudo = extract_text_from_baileys(m)
                media_meta = extract_media_meta(m)

                ack_value = _ack_from_status_safe_for_upsert(status, from_me=bool(from_me))

                # =========================
                # GRUPO
                # =========================
                if remote_jid.endswith("@g.us"):
                    if not msg_id:
                        _log_skip("grupo sem msg_id", idx=idx, remote_jid=remote_jid)
                        continue

                    grp_remote = jid_strip_device(remote_jid)

                    try:
                        grp = grupo_row_by_remote(
                            db,
                            empresa_id,
                            grp_remote,
                            instancia_id=getattr(inst, "id", None),
                            inst_obj=inst,
                        )
                    except Exception as e:
                        grp = None
                        LOG(f"[UPsert][grupo] falha criando/buscando grupo: {e}")
                        _safe_rollback(db)

                    if grp is None:
                        _log_skip("grupo sem grp-row", idx=idx, msg_id=msg_id, remote_jid=grp_remote)
                        continue

                    try:
                        if is_nome_grupo_ruim(getattr(grp, "nome", None)):
                            subject = evo_get_group_subject(getattr(inst, "instance_name", inst_id), grp_remote)
                            if subject and (grp.nome or "") != subject:
                                grp.nome = subject
                    except Exception:
                        pass

                    participant = (
                        key.get("participant")
                        or m.get("participant")
                        or m.get("sender")
                        or m.get("participantJid")
                        or ""
                    )
                    participant = jid_strip_device(participant) if isinstance(participant, str) else ""

                    try:
                        avatar = avatar_from_contact_like(m)
                        if isinstance(avatar, str) and avatar.strip():
                            if getattr(grp, "avatar_url", None) != avatar.strip():
                                grp.avatar_url = avatar.strip()
                        _carimbar_inst(grp, inst)
                    except Exception:
                        pass

                    cli_autor_id = None
                    autor_nome = push_name_raw or participant or None

                    try:
                        tel_autor = remote_to_num(participant) if participant else None
                        if tel_autor and (not me_number_db or tel_autor != me_number_db):
                            nome_autor = push_name_raw if not _bad_push_name(push_name_raw, telefone=tel_autor) else formatar_telefone_br(tel_autor)
                            cli_autor_id = await _ensure_cliente_id_fk_safe(
                                db,
                                empresa_id=empresa_id,
                                instancia_id=inst.id,
                                telefone=tel_autor,
                                nome=nome_autor,
                                nome_whatsapp=(nome_autor if nome_autor != formatar_telefone_br(tel_autor) else None),
                                avatar_url=None,
                                current_cliente_id=None,
                            )
                    except Exception as e:
                        _log_ctx("[UPsert][grupo][autor-upsert-fail]", idx=idx, msg_id=msg_id, err=str(e))
                        _safe_rollback(db)

                    inserted = False
                    gm_id = None

                    try:
                        ts_int = int(ts_msg.timestamp())
                        gm = models.MensagemGrupo(
                            empresa_id=empresa_id,
                            grupo_id=grp.id,
                            instancia_id=getattr(inst, "id", None),
                            author_jid=(participant or None),
                            from_me=bool(from_me),
                            conteudo=conteudo,
                            tipo=direcao,
                            message_type=m.get("messageType"),
                            lida=bool(from_me),
                            timestamp=ts_int,
                            msg_id=str(msg_id),
                            ack=int(ack_value or 0),
                        )
                        _carimbar_inst(gm, inst)
                        db.add(gm)
                        db.flush()

                        gm_id = getattr(gm, "id", None)
                        novas += 1
                        inserted = True

                        _log_ctx(
                            "[UPsert][grupo-saved]",
                            idx=idx,
                            msg_id=msg_id,
                            grupo_id=grp.id,
                            saved_id=gm_id,
                            from_me=from_me,
                            participant=_short(participant, 60),
                            ts=_iso_utc(ts_msg),
                            preview=_short(conteudo),
                        )

                    except IntegrityError:
                        grupo_id_safe = getattr(grp, "id", None)
                        _safe_rollback(db)

                        _log_skip("duplicada grupo (msg_id)", idx=idx, msg_id=msg_id, grupo_id=grupo_id_safe)
                        inserted = False

                        try:
                            if grupo_id_safe:
                                gm_exist = (
                                    db.query(models.MensagemGrupo)
                                    .filter(
                                        models.MensagemGrupo.empresa_id == int(empresa_id),
                                        models.MensagemGrupo.grupo_id == int(grupo_id_safe),
                                        models.MensagemGrupo.msg_id == str(msg_id),
                                    )
                                    .order_by(models.MensagemGrupo.id.desc())
                                    .first()
                                )
                                gm_id = getattr(gm_exist, "id", None) if gm_exist else None

                                if from_me and gm_id:
                                    ack_value = _raise_ack_existing_mensagem_grupo(
                                        db,
                                        empresa_id=int(empresa_id),
                                        grupo_id=int(grupo_id_safe),
                                        instancia_id=int(getattr(inst, "id", 0) or 0),
                                        msg_id=str(msg_id),
                                        mensagem_grupo_id=int(gm_id),
                                        ack_value=int(ack_value),
                                    )
                                    _log_ctx(
                                        "[UPsert][grupo][ack-safe]",
                                        idx=idx,
                                        msg_id=msg_id,
                                        grupo_id=grupo_id_safe,
                                        ack=ack_value,
                                    )
                        except Exception as e:
                            gm_id = None
                            _log_ctx("[UPsert][grupo][dup][buscar-msg] falhou", idx=idx, msg_id=msg_id, err=str(e))
                            _safe_rollback(db)

                    except Exception as e:
                        LOG(f"[UPsert][grupo][erro ao salvar] idx={idx} msg_id={msg_id} err={e}")
                        _safe_rollback(db)
                        continue

                    if media_meta and (inserted or gm_id):
                        try:
                            ok = save_group_media_with_db(
                                db,
                                inst_id=inst_id,
                                empresa_id=empresa_id,
                                grupo_id=grp.id,
                                cliente_id=cli_autor_id,
                                msg_id=(str(msg_id) if msg_id else None),
                                media_meta=media_meta,
                                instancia_db_id=inst.id,
                                idx=idx,
                            )
                            if ok:
                                _log_ctx(
                                    "[UPsert][grupo][midia] salva",
                                    idx=idx,
                                    msg_id=msg_id,
                                    grupo_id=grp.id,
                                    cliente_id=cli_autor_id,
                                    tipo=media_meta.get("tipo"),
                                    instancia_id=inst.id,
                                )
                        except Exception as e:
                            _log_ctx("[UPsert][grupo][midia] erro ao salvar", idx=idx, msg_id=msg_id, err=str(e))
                            _safe_rollback(db)

                    if inserted:
                        try:
                            conv_key_grupo = f"g:{int(grp.id)}:{int(inst.id or 0)}"

                            ws_payload_grupo = {
                                "type": "message",
                                "event": "message",

                                "empresa_id": int(empresa_id),

                                "conversation_key": conv_key_grupo,
                                "conversation_id": conv_key_grupo,
                                "kind": "g",
                                "entity_id": int(grp.id),
                                "grupo_id": int(grp.id),
                                "is_group": True,

                                "cliente_id": None,

                                "instancia_id": int(inst.id),
                                "instance_name": getattr(inst, "instance_name", None),

                                "telefone": getattr(grp, "remote_jid", grp_remote),
                                "remote_jid": getattr(grp, "remote_jid", grp_remote),

                                "avatar_url": getattr(grp, "avatar_url", None),
                                "push_name": getattr(grp, "nome", None),
                                "nome": getattr(grp, "nome", None) or "Grupo",

                                "mensagem": conteudo,
                                "texto": conteudo,
                                "conteudo": conteudo,

                                "tipo": direcao,
                                "origem": ("atendente" if from_me else "cliente"),
                                "from_me": bool(from_me),

                                "timestamp": _iso_utc(ts_msg),
                                "msg_id": str(msg_id),
                                "ack": (ack_value if from_me else None),

                                "author_jid": (participant or None),
                                "autor_nome": autor_nome,
                                "autor_cliente_id": cli_autor_id,

                                "midias": [],
                                "serverTimestamp": _server_ts_ms(),
                            }

                            if _ws_emit_messages_enabled():
                                await conexoes_ativas.send_message(f"emp:{empresa_id}", ws_payload_grupo)
                            else:
                                LOG(f"[UPsert][grupo][ws-live][skip] WS_EMIT_MESSAGES=false msg_id={msg_id}")
                        except Exception as e:
                            LOG(f"[UPsert][grupo][ws-live] falha ao emitir: {e}")

                        try:
                            await conexoes_ativas.send_message(
                                f"emp:{empresa_id}",
                                {"type": "reload_grupos", "serverTimestamp": _server_ts_ms()},
                            )
                        except Exception as e:
                            LOG(f"[UPsert][grupo][ws] falha reload_grupos: {e}")

                    if (novas % 500) == 0:
                        await asyncio.sleep(0)

                    continue

                # =========================
                # 1:1
                # =========================
                identity_info = _identity_hint_for_remote(
                    db,
                    empresa_id=empresa_id,
                    instancia_id=instancia_id,
                    remote_jid=raw_remote,
                )

                identity_real_jid = jid_strip_device(identity_info.get("real_jid") or "")
                identity_push_name = identity_info.get("push_name")
                identity_avatar_url = identity_info.get("profile_pic_url")

                if is_lid_jid(remote_jid) and identity_real_jid and not is_lid_jid(identity_real_jid):
                    remote_jid = identity_real_jid

                if is_lid_jid(remote_jid):
                    _log_skip(
                        "LID sem número real; não cria cliente visível",
                        idx=idx,
                        msg_id=msg_id,
                        remote_jid=remote_jid,
                        raw_remote=raw_remote,
                    )
                    continue

                telefone = remote_to_num(remote_jid)
                if not telefone:
                    _log_skip("telefone inválido", idx=idx, msg_id=msg_id, remote_jid=remote_jid, raw_remote=raw_remote)
                    continue

                if me_number_db and telefone == me_number_db:
                    _log_skip("eco do meu número", idx=idx, msg_id=msg_id, telefone=telefone)
                    continue

                formatted = formatar_telefone_br(telefone)

                push_name_ok = None
                if not _bad_push_name(push_name_raw, raw_lid=raw_remote, telefone=telefone):
                    push_name_ok = str(push_name_raw).strip()

                identity_name_ok = None
                if not _bad_push_name(identity_push_name, raw_lid=raw_remote, telefone=telefone):
                    identity_name_ok = str(identity_push_name).strip()

                nome_final = push_name_ok or identity_name_ok or formatted
                avatar_final = identity_avatar_url or avatar_from_contact_like(m)

                nome_cliente = nome_final
                nome_whatsapp = (push_name_ok or identity_name_ok)

                _log_ctx(
                    "[UPsert][resolved]",
                    idx=idx,
                    msg_id=msg_id,
                    raw_remote=raw_remote,
                    remote_jid=remote_jid,
                    telefone=telefone,
                    from_me=from_me,
                    push_name=_short(push_name_raw, 60),
                    identity_name=_short(identity_push_name, 60),
                    identity_real=identity_real_jid or None,
                    ts=_iso_utc(ts_msg),
                    preview=_short(conteudo),
                )

                cli_id = await _ensure_cliente_id_fk_safe(
                    db,
                    empresa_id=empresa_id,
                    instancia_id=inst.id,
                    telefone=telefone,
                    nome=nome_cliente,
                    nome_whatsapp=nome_whatsapp,
                    avatar_url=avatar_final,
                    current_cliente_id=None,
                )

                if not cli_id:
                    _log_skip("cli_id vazio/fk-inválido (upsert)", idx=idx, msg_id=msg_id, telefone=telefone)
                    continue

                pending_lid_merge: tuple[str, str, int] | None = None

                try:
                    lid_for_merge, real_for_merge = _save_identity_for_1to1(
                        db,
                        empresa_id=empresa_id,
                        instancia_id=instancia_id,
                        raw_remote=raw_remote,
                        remote_jid=remote_jid,
                        telefone=telefone,
                        cli_id=int(cli_id),
                        push_name=nome_whatsapp,
                        avatar_url=avatar_final,
                    )

                    if lid_for_merge and real_for_merge:
                        pending_lid_merge = (lid_for_merge, real_for_merge, int(cli_id))

                except Exception as e:
                    LOG(
                        f"[UPsert][identity][erro] idx={idx} msg_id={msg_id} "
                        f"raw={raw_remote} remote={remote_jid} cli={cli_id} err={e}"
                    )

                replay_existing_msg_id = None

                if msg_id:
                    try:
                        msg_existente_id = find_existing_mensagem_11_id(
                            db,
                            empresa_id=empresa_id,
                            cliente_id=cli_id,
                            msg_id=str(msg_id),
                            instancia_id=inst.id,
                        )
                    except Exception as e:
                        LOG(f"[UPsert][erro precheck-msgid] idx={idx} msg_id={msg_id} err={e}")
                        _safe_rollback(db)
                        continue

                    if msg_existente_id:
                        replay_existing_msg_id = int(msg_existente_id)

                        if from_me:
                            ack_value = _raise_ack_existing_mensagem_11(
                                db,
                                empresa_id=int(empresa_id),
                                cliente_id=int(cli_id),
                                instancia_id=int(inst.id),
                                msg_id=str(msg_id),
                                mensagem_id=int(replay_existing_msg_id),
                                ack_value=int(ack_value),
                            )

                        _log_ctx(
                            "[UPsert][skip-replay-existing-msgid]",
                            idx=idx,
                            msg_id=msg_id,
                            cliente_id=cli_id,
                            existing_id=replay_existing_msg_id,
                            status=status,
                            from_me=from_me,
                            ack=ack_value,
                        )

                atendimento_id = None

                if _HAS_MSG_ATD_FIELD:
                    atendimento_id = _resolve_atendimento_id_safe(
                        db,
                        empresa_id=empresa_id,
                        instancia_id=inst.id,
                        cliente_id=cli_id,
                        direcao=direcao,
                        ts_dt=ts_msg,
                    )

                cli_id = await _ensure_cliente_id_fk_safe(
                    db,
                    empresa_id=empresa_id,
                    instancia_id=inst.id,
                    telefone=telefone,
                    nome=nome_cliente,
                    nome_whatsapp=nome_whatsapp,
                    avatar_url=avatar_final,
                    current_cliente_id=cli_id,
                )
                if not cli_id:
                    _log_skip(
                        "cliente inexistente antes do insert da mensagem",
                        idx=idx,
                        msg_id=msg_id,
                        telefone=telefone,
                    )
                    continue

                if pending_lid_merge:
                    pending_lid_merge = (pending_lid_merge[0], pending_lid_merge[1], int(cli_id))

                if _HAS_MSG_ATD_FIELD:
                    atendimento_id = _resolve_atendimento_id_safe(
                        db,
                        empresa_id=empresa_id,
                        instancia_id=inst.id,
                        cliente_id=cli_id,
                        direcao=direcao,
                        ts_dt=ts_msg,
                    )

                    atendimento_id = _safe_atendimento_id_for_cliente(
                        db,
                        empresa_id=empresa_id,
                        instancia_id=inst.id,
                        cliente_id=cli_id,
                        atendimento_id=atendimento_id,
                    )

                msg_db_id = None
                inserted_11 = False

                if msg_id:
                    if replay_existing_msg_id:
                        msg_db_id = int(replay_existing_msg_id)
                        inserted_11 = False
                        _log_skip(
                            "duplicada exata por msg_id (precheck)",
                            idx=idx,
                            msg_id=msg_id,
                            cliente_id=cli_id,
                            existing_id=replay_existing_msg_id,
                            instancia_id=inst.id,
                        )

                        if pending_lid_merge:
                            try:
                                db.commit()
                            except Exception:
                                _safe_rollback(db)

                            _merge_lid_history_with_new_session(
                                empresa_id=empresa_id,
                                instancia_id=instancia_id,
                                lid_jid=pending_lid_merge[0],
                                real_jid=pending_lid_merge[1],
                                real_cliente_id=pending_lid_merge[2],
                            )

                    else:
                        try:
                            msg_db_id, inserted_11, cli_id, atendimento_id = await _insert_mensagem_11_fk_safe(
                                db,
                                empresa_id=empresa_id,
                                cliente_id=cli_id,
                                conteudo=conteudo,
                                tipo=direcao,
                                lida=bool(from_me),
                                ack=ack_value,
                                timestamp=ts_msg,
                                msg_id=str(msg_id),
                                instancia_id=inst.id,
                                atendimento_id=atendimento_id,
                                idx=idx,
                                telefone=telefone,
                                nome=nome_cliente,
                                nome_whatsapp=nome_whatsapp,
                                avatar_url=avatar_final,
                            )

                            atendimento_id = _safe_atendimento_id_for_cliente(
                                db,
                                empresa_id=empresa_id,
                                instancia_id=inst.id,
                                cliente_id=cli_id,
                                atendimento_id=atendimento_id,
                            )

                            if inserted_11 and msg_db_id:
                                try:
                                    db.commit()
                                except Exception as e:
                                    _safe_rollback(db)
                                    LOG(f"[UPsert][commit-msg-erro] idx={idx} msg_id={msg_id} err={e}")
                                    continue

                                if pending_lid_merge:
                                    _merge_lid_history_with_new_session(
                                        empresa_id=empresa_id,
                                        instancia_id=instancia_id,
                                        lid_jid=pending_lid_merge[0],
                                        real_jid=pending_lid_merge[1],
                                        real_cliente_id=int(cli_id),
                                    )

                                novas += 1
                                _log_ctx(
                                    "[UPsert][saved-upsert]",
                                    idx=idx,
                                    msg_id=msg_id,
                                    saved_id=msg_db_id,
                                    cliente_id=cli_id,
                                    tipo=direcao,
                                    ack=ack_value,
                                    atendimento_id=atendimento_id,
                                    ts=_iso_utc(ts_msg),
                                    preview=_short(conteudo),
                                )
                            else:
                                if msg_db_id:
                                    replay_existing_msg_id = int(msg_db_id)

                                if from_me and replay_existing_msg_id:
                                    ack_value = _raise_ack_existing_mensagem_11(
                                        db,
                                        empresa_id=int(empresa_id),
                                        cliente_id=int(cli_id),
                                        instancia_id=int(inst.id),
                                        msg_id=str(msg_id),
                                        mensagem_id=int(replay_existing_msg_id),
                                        ack_value=int(ack_value),
                                    )

                                _log_skip(
                                    "duplicada (upsert)",
                                    idx=idx,
                                    msg_id=msg_id,
                                    cliente_id=cli_id,
                                    existing_id=replay_existing_msg_id,
                                    instancia_id=inst.id,
                                    ack=ack_value,
                                )

                                if pending_lid_merge:
                                    try:
                                        db.commit()
                                    except Exception:
                                        _safe_rollback(db)

                                    _merge_lid_history_with_new_session(
                                        empresa_id=empresa_id,
                                        instancia_id=instancia_id,
                                        lid_jid=pending_lid_merge[0],
                                        real_jid=pending_lid_merge[1],
                                        real_cliente_id=int(cli_id),
                                    )

                        except Exception as e:
                            LOG(f"[UPsert][erro upsert mensagem] idx={idx} msg_id={msg_id} err={e}")
                            _safe_rollback(db)
                            continue

                else:
                    try:
                        msg_db_id, inserted_11, cli_id, atendimento_id = await _insert_mensagem_no_msgid_fk_safe(
                            db,
                            empresa_id=empresa_id,
                            cliente_id=cli_id,
                            conteudo=conteudo,
                            tipo=direcao,
                            lida=bool(from_me),
                            ack=ack_value,
                            timestamp=ts_msg,
                            instancia_id=inst.id,
                            atendimento_id=atendimento_id,
                            idx=idx,
                            telefone=telefone,
                            nome=nome_cliente,
                            nome_whatsapp=nome_whatsapp,
                            inst=inst,
                            avatar_url=avatar_final,
                        )

                        atendimento_id = _safe_atendimento_id_for_cliente(
                            db,
                            empresa_id=empresa_id,
                            instancia_id=inst.id,
                            cliente_id=cli_id,
                            atendimento_id=atendimento_id,
                        )

                        try:
                            db.commit()
                        except Exception as e:
                            _safe_rollback(db)
                            LOG(f"[UPsert][commit-msg-sem-id-erro] idx={idx} err={e}")
                            continue

                        if pending_lid_merge:
                            _merge_lid_history_with_new_session(
                                empresa_id=empresa_id,
                                instancia_id=instancia_id,
                                lid_jid=pending_lid_merge[0],
                                real_jid=pending_lid_merge[1],
                                real_cliente_id=int(cli_id),
                            )

                        novas += 1
                        inserted_11 = True

                        _log_ctx(
                            "[UPsert][saved-nomsgid]",
                            idx=idx,
                            saved_id=msg_db_id,
                            cliente_id=cli_id,
                            atendimento_id=atendimento_id,
                            tipo=direcao,
                            ts=_iso_utc(ts_msg),
                            preview=_short(conteudo),
                        )

                    except Exception as e:
                        LOG(f"[UPsert][erro ao salvar mensagem sem msg_id] idx={idx} err={e}")
                        _safe_rollback(db)
                        continue

                should_run_chatbot = False

                if (not from_me) and direcao == "entrada" and conteudo:
                    if msg_id:
                        if chatbot_should_process_msg(empresa_id, inst.id, str(msg_id)):
                            if inserted_11 and msg_db_id:
                                should_run_chatbot = True
                            elif replay_existing_msg_id:
                                replay_key = (int(replay_existing_msg_id), str(msg_id))
                                if replay_key not in chatbot_replay_batch_seen:
                                    chatbot_replay_batch_seen.add(replay_key)
                                    msg_db_id = int(replay_existing_msg_id)
                                    should_run_chatbot = True
                                    _log_ctx(
                                        "[UPsert][chatbot-replay-rescue]",
                                        idx=idx,
                                        msg_id=msg_id,
                                        cliente_id=cli_id,
                                        existing_id=msg_db_id,
                                        status=status,
                                    )
                        else:
                            _log_ctx(
                                "[UPsert][chatbot-skip-global-ttl]",
                                idx=idx,
                                msg_id=msg_id,
                                cliente_id=cli_id,
                                existing_id=(replay_existing_msg_id or msg_db_id),
                                status=status,
                            )
                            should_run_chatbot = False
                    else:
                        if inserted_11 and msg_db_id:
                            should_run_chatbot = True

                if should_run_chatbot:
                    await _run_or_schedule_triagem_pos_commit(
                        empresa_id=empresa_id,
                        instancia_id=inst.id,
                        telefone=telefone,
                        conteudo=conteudo,
                        direcao=direcao,
                        remote_jid=remote_jid,
                    )

                    if _HAS_MSG_ATD_FIELD and cli_id:
                        atendimento_id = _resolve_atendimento_id_safe(
                            db,
                            empresa_id=empresa_id,
                            instancia_id=inst.id,
                            cliente_id=cli_id,
                            direcao=direcao,
                            ts_dt=ts_msg,
                        )

                        atendimento_id = _safe_atendimento_id_for_cliente(
                            db,
                            empresa_id=empresa_id,
                            instancia_id=inst.id,
                            cliente_id=cli_id,
                            atendimento_id=atendimento_id,
                        )

                if inserted_11 and msg_db_id:
                    if media_meta:
                        await save_media_pos_commit_11(
                            inst_id=inst_id,
                            empresa_id=empresa_id,
                            cli_id=cli_id,
                            msg_db_id=msg_db_id,
                            msg_id=(str(msg_id) if msg_id else None),
                            media_meta=media_meta,
                            instancia_db_id=inst.id,
                            idx=idx,
                        )

                    try:
                        # V16: contador da bolha verde no tempo real.
                        #
                        # Problema observado:
                        # - a mensagem nova chegava no front;
                        # - o preview da conversa atualizava;
                        # - mas a bolha não subia de 2 para 3.
                        #
                        # Regra:
                        # - mensagem de saída nunca aumenta bolha;
                        # - mensagem de entrada envia contador explícito do banco;
                        # - se o contador falhar por sessão/cache/transação, envia unreadDelta=1
                        #   para o front conseguir somar no contador atual da lista.
                        cliente = None
                        unread_count_live = 0

                        try:
                            with SessionLocal() as db_ws:
                                cliente = _fetch_cliente(db_ws, cli_id)

                                if not from_me:
                                    unread_count_live = int(
                                        db_ws.query(func.count(models.Mensagem.id))
                                        .filter(
                                            models.Mensagem.empresa_id == int(empresa_id),
                                            models.Mensagem.cliente_id == int(cli_id),
                                            models.Mensagem.instancia_id == int(inst.id),
                                            models.Mensagem.tipo == "entrada",
                                            models.Mensagem.lida.isnot(True),
                                        )
                                        .scalar()
                                        or 0
                                    )
                        except Exception as e:
                            LOG(
                                f"[UPsert][ws][unread-count-session-erro] "
                                f"emp={empresa_id} cli={cli_id} inst={getattr(inst, 'id', None)} err={e}"
                            )

                        if not from_me and unread_count_live <= 0:
                            try:
                                # Fallback usando a sessão principal.
                                # Normalmente a mensagem já foi commitada antes deste bloco,
                                # mas esse fallback evita bolha zerada se a sessão nova falhar.
                                unread_count_live = int(
                                    db.query(func.count(models.Mensagem.id))
                                    .filter(
                                        models.Mensagem.empresa_id == int(empresa_id),
                                        models.Mensagem.cliente_id == int(cli_id),
                                        models.Mensagem.instancia_id == int(inst.id),
                                        models.Mensagem.tipo == "entrada",
                                        models.Mensagem.lida.isnot(True),
                                    )
                                    .scalar()
                                    or 0
                                )
                            except Exception as e:
                                LOG(
                                    f"[UPsert][ws][unread-count-main-erro] "
                                    f"emp={empresa_id} cli={cli_id} inst={getattr(inst, 'id', None)} err={e}"
                                )

                        if not from_me and unread_count_live <= 0:
                            # Última proteção: como entrou uma mensagem recebida agora,
                            # o front pelo menos precisa somar +1.
                            unread_count_live = 1

                        unread_payload = 0 if from_me else int(unread_count_live or 1)
                        unread_delta_payload = 0 if from_me else 1

                        conv_key_cliente = f"c:{int(cli_id)}:{int(inst.id or 0)}"

                        ws_payload = {
                            "type": "message",
                            "event": "message",

                            "empresa_id": int(empresa_id),

                            "conversation_key": conv_key_cliente,
                            "conversation_id": conv_key_cliente,
                            "kind": "c",
                            "entity_id": int(cli_id),
                            "cliente_id": int(cli_id),
                            "is_group": False,

                            "instancia_id": int(inst.id),
                            "instance_name": getattr(inst, "instance_name", None),

                            "atendimento_id": atendimento_id,
                            "departamento_id": (getattr(cliente, "departamento_id", None) if cliente else None),
                            "colaborador_id": (getattr(cliente, "colaborador_id", None) if cliente else None),

                            "telefone": formatar_telefone_br(telefone),
                            "telefone_norm": telefone,

                            "avatar_url": getattr(cliente, "avatar_url", None) if cliente else avatar_final,
                            "push_name": getattr(cliente, "nome_whatsapp", None) if cliente else nome_whatsapp,
                            "nome": getattr(cliente, "nome", None) if cliente else nome_cliente,

                            "mensagem": conteudo,
                            "texto": conteudo,
                            "conteudo": conteudo,

                            "tipo": direcao,
                            "origem": ("atendente" if from_me else "cliente"),
                            "from_me": bool(from_me),

                            "timestamp": _iso_utc(ts_msg),
                            "msg_id": (str(msg_id) if msg_id else (str(msg_db_id) if msg_db_id else None)),
                            "ack": (ack_value if from_me else None),

                            # Contador explícito para a bolha verde.
                            "novas": unread_payload,
                            "unread": unread_payload,
                            "unread_count": unread_payload,
                            "nao_lidas": unread_payload,
                            "naoLidas": unread_payload,
                            "qtd_nao_lidas": unread_payload,
                            "qtdNaoLidas": unread_payload,

                            # Fallback para o front: se algum handler ignorar o contador
                            # explícito, ele ainda consegue somar +1 no valor atual.
                            "unreadDelta": unread_delta_payload,
                            "unread_delta": unread_delta_payload,
                            "unreadIncrement": unread_delta_payload,

                            "midias": [],
                            "serverTimestamp": _server_ts_ms(),
                        }

                        LOG(
                            f"[UPsert][ws][payload] emp={empresa_id} cli={cli_id} "
                            f"inst={getattr(inst, 'id', None)} from_me={from_me} "
                            f"unread={unread_payload} delta={unread_delta_payload} msg_id={msg_id}"
                        )

                        if _ws_emit_messages_enabled():
                            await conexoes_ativas.send_message(f"emp:{empresa_id}", ws_payload)
                        else:
                            LOG(f"[UPsert][ws-live][skip] WS_EMIT_MESSAGES=false msg_id={msg_id}")
                    except Exception as e:
                        LOG(f"[UPsert][ws] falha ao emitir: {e}")

                    _invalidate_emp_cache_after_message_safe(empresa_id, where="after-ws")

                if (novas % 500) == 0:
                    await asyncio.sleep(0)

            except Exception as e:
                LOG(f"[UPsert] erro em mensagem idx={idx}: {e}")
                _safe_rollback(db)
                continue

        try:
            db.commit()
            _log_ctx("[UPsert][commit-final]", novas=novas)
        except Exception as e:
            _safe_rollback(db)
            LOG(f"[UPsert][commit-final-erro] {e}")

        if novas > 0 and empresa_id:
            _invalidate_emp_cache_after_message_safe(empresa_id, where="final")

        LOG(f"[UPsert] inst={inst_id} novas={novas}")


HANDLERS[EvoEvent.MESSAGES_UPSERT] = on_messages_upsert

__all__ = [
    "on_messages_upsert",
]