# backend/integrations/evolution/handlers/messages_upsert.py

from __future__ import annotations

import asyncio

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
    run_triagem_pos_commit,
    save_group_media_with_db,
    save_media_pos_commit_11,
    upsert_cliente,
)


def _safe_rollback(db) -> None:
    try:
        db.rollback()
    except Exception:
        pass


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


def _cliente_exists(db, cliente_id: int | None) -> bool:
    if not cliente_id:
        return False
    try:
        row = (
            db.query(models.Cliente.id)
            .filter(models.Cliente.id == int(cliente_id))
            .first()
        )
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
    - cli_id antigo após rollback
    - retorno "fantasma" de upsert
    - fallback por telefone_norm
    """
    if current_cliente_id and _cliente_exists(db, current_cliente_id):
        return int(current_cliente_id)

    found = _find_cliente_id_by_phone(
        db,
        empresa_id=empresa_id,
        instancia_id=instancia_id,
        telefone=telefone,
    )
    if found:
        return found

    cli_id = await _ensure_cliente_id(
        db,
        empresa_id=empresa_id,
        instancia_id=instancia_id,
        telefone=telefone,
        nome=nome,
        nome_whatsapp=nome_whatsapp,
        avatar_url=avatar_url,
    )
    if cli_id and _cliente_exists(db, cli_id):
        return int(cli_id)

    found = _find_cliente_id_by_phone(
        db,
        empresa_id=empresa_id,
        instancia_id=instancia_id,
        telefone=telefone,
    )
    if found:
        return found

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
    O helper compartilhado já busca departamento/operador do cliente quando
    eles não forem passados explicitamente.
    """
    if not _HAS_MSG_ATD_FIELD:
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
        return getattr(atendimento, "id", None) if atendimento is not None else None

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
    Se estourar FK de cliente_id, reobtém um cliente_id válido e tenta 1 vez de novo.
    """
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
        return msg_db_id, inserted_11, int(cliente_id)

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
            atendimento_id=None,  # evita reaproveitar atendimento após rollback
            idx=idx,
        )
        return msg_db_id, inserted_11, int(cli_retry)


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
        return int(msg_model.id), True, int(cliente_id)

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
                f"cliente_id inválido após retry FK (sem msg_id) telefone={telefone}"
            )

        msg_model = _build_model(int(cli_retry), None)
        db.add(msg_model)
        db.flush()
        return int(msg_model.id), True, int(cli_retry)


def _resolve_remote_jid_upsert(
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

    alt_jid = (
        key.get("remoteJidAlt")
        or key.get("remote_jid_alt")
        or message_item.get("remoteJidAlt")
        or message_item.get("remote_jid_alt")
    )

    if isinstance(alt_jid, str) and "@" in alt_jid:
        real = jid_strip_device(alt_jid)
        _lid_map_set(empresa_id, instancia_id, raw_remote, real)
        return real

    tel_fallback, alt = _resolve_counterparty_num_1to1(message_item, me_number)
    if isinstance(alt, str) and "@" in alt:
        real = jid_strip_device(alt)
        _lid_map_set(empresa_id, instancia_id, raw_remote, real)
        return real

    if tel_fallback and not str(tel_fallback).startswith("LID-"):
        send_e164 = normalize_phone_for_send(tel_fallback)
        if send_e164:
            real = f"{send_e164}@s.whatsapp.net"
            _lid_map_set(empresa_id, instancia_id, raw_remote, real)
            return real

    return raw_remote


@handler(EvoEvent.MESSAGES_UPSERT)
async def on_messages_upsert(inst_id: str, data):
    with SessionLocal() as db:
        inst = _get_inst_row(db, inst_id)
        if not inst:
            LOG(f"[UPsert] instância não encontrada: {inst_id}")
            return

        empresa_id = int(inst.empresa_id)
        me_number_raw = _me_number_by_inst(inst)
        me_number_db = normalize_phone_for_db(me_number_raw)

        mensagens = extract_messages_any_shape(data)
        _log_ctx(
            "[UPsert] batch",
            inst=inst_id,
            empresa_id=empresa_id,
            total=len(mensagens),
            type_data=type(data).__name__,
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
                    empresa_id=empresa_id,
                    instancia_id=inst.id,
                    key=key,
                    message_item=m,
                    me_number=me_number_raw,
                )
                remote_jid = jid_strip_device(remote_jid)

                from_me = bool(key.get("fromMe", m.get("fromMe", False)))
                direcao = "saida" if from_me else "entrada"
                push_name = m.get("pushName") or m.get("senderName")
                ts_msg = _to_dt_utc(ts_raw)
                conteudo = extract_text_from_baileys(m)
                media_meta = extract_media_meta(m)

                ack_value = int(_ack_from_status(status) if from_me else 0)

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
                    autor_nome = push_name or participant or None

                    try:
                        tel_autor = remote_to_num(participant) if participant else None
                        if tel_autor and (not me_number_db or tel_autor != me_number_db):
                            cli_autor_id = await _ensure_cliente_id_fk_safe(
                                db,
                                empresa_id=empresa_id,
                                instancia_id=inst.id,
                                telefone=tel_autor,
                                nome=(push_name or formatar_telefone_br(tel_autor)),
                                nome_whatsapp=(push_name or formatar_telefone_br(tel_autor)),
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
                        _safe_rollback(db)

                        _log_skip("duplicada grupo (msg_id)", idx=idx, msg_id=msg_id, grupo_id=grp.id)
                        inserted = False

                        try:
                            gm_exist = (
                                db.query(models.MensagemGrupo)
                                .filter(
                                    models.MensagemGrupo.grupo_id == grp.id,
                                    models.MensagemGrupo.msg_id == str(msg_id),
                                )
                                .first()
                            )
                            gm_id = getattr(gm_exist, "id", None) if gm_exist else None
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
                            ws_payload_grupo = {
                                "empresa_id": empresa_id,
                                "cliente_id": grp.id,
                                "conversation_id": grp.id,
                                "grupo_id": grp.id,
                                "is_group": True,
                                "instancia_id": inst.id,
                                "instance_name": getattr(inst, "instance_name", None),
                                "telefone": getattr(grp, "remote_jid", grp_remote),
                                "avatar_url": getattr(grp, "avatar_url", None),
                                "push_name": getattr(grp, "nome", None),
                                "nome": getattr(grp, "nome", None) or "Grupo",
                                "mensagem": conteudo,
                                "tipo": direcao,
                                "origem": ("atendente" if from_me else "cliente"),
                                "timestamp": _iso_utc(ts_msg),
                                "msg_id": str(msg_id),
                                "ack": (ack_value if from_me else None),
                                "author_jid": (participant or None),
                                "autor_nome": autor_nome,
                                "autor_cliente_id": cli_autor_id,
                                "serverTimestamp": _server_ts_ms(),
                            }
                            await conexoes_ativas.send_message(f"emp:{empresa_id}", ws_payload_grupo)
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
                telefone = remote_to_num(remote_jid)
                if not telefone:
                    _log_skip("telefone inválido", idx=idx, msg_id=msg_id, remote_jid=remote_jid)
                    continue

                if me_number_db and telefone == me_number_db:
                    _log_skip("eco do meu número", idx=idx, msg_id=msg_id, telefone=telefone)
                    continue

                formatted = formatar_telefone_br(telefone)
                nome_cliente = (formatted if from_me else (push_name or formatted))
                nome_whatsapp = (formatted if from_me else (push_name or formatted))

                _log_ctx(
                    "[UPsert][resolved]",
                    idx=idx,
                    msg_id=msg_id,
                    remote_jid=remote_jid,
                    telefone=telefone,
                    from_me=from_me,
                    push_name=_short(push_name, 60),
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
                    avatar_url=None,
                    current_cliente_id=None,
                )

                if not cli_id:
                    _log_skip("cli_id vazio/fk-inválido (upsert)", idx=idx, msg_id=msg_id, telefone=telefone)
                    continue

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
                        _log_ctx(
                            "[UPsert][skip-replay-existing-msgid]",
                            idx=idx,
                            msg_id=msg_id,
                            cliente_id=cli_id,
                            existing_id=replay_existing_msg_id,
                            status=status,
                            from_me=from_me,
                        )

                atendimento_id = None

                # 1) tenta abrir/achar atendimento para o cliente atual
                if _HAS_MSG_ATD_FIELD:
                    atendimento_id = _resolve_atendimento_id_safe(
                        db,
                        empresa_id=empresa_id,
                        instancia_id=inst.id,
                        cliente_id=cli_id,
                        direcao=direcao,
                        ts_dt=ts_msg,
                    )

                # 2) garante de novo o cliente após qualquer rollback anterior
                cli_id = await _ensure_cliente_id_fk_safe(
                    db,
                    empresa_id=empresa_id,
                    instancia_id=inst.id,
                    telefone=telefone,
                    nome=nome_cliente,
                    nome_whatsapp=nome_whatsapp,
                    avatar_url=None,
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

                # 3) re-resolve atendimento com o cliente final válido
                if _HAS_MSG_ATD_FIELD:
                    atendimento_id = _resolve_atendimento_id_safe(
                        db,
                        empresa_id=empresa_id,
                        instancia_id=inst.id,
                        cliente_id=cli_id,
                        direcao=direcao,
                        ts_dt=ts_msg,
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
                    else:
                        try:
                            msg_db_id, inserted_11, cli_id = await _insert_mensagem_11_fk_safe(
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
                                avatar_url=None,
                            )

                            if inserted_11 and msg_db_id:
                                try:
                                    db.commit()
                                except Exception as e:
                                    _safe_rollback(db)
                                    LOG(f"[UPsert][commit-msg-erro] idx={idx} msg_id={msg_id} err={e}")
                                    continue

                                novas += 1
                                _log_ctx(
                                    "[UPsert][saved-upsert]",
                                    idx=idx,
                                    msg_id=msg_id,
                                    saved_id=msg_db_id,
                                    tipo=direcao,
                                    ack=ack_value,
                                    atendimento_id=atendimento_id,
                                    ts=_iso_utc(ts_msg),
                                    preview=_short(conteudo),
                                )
                            else:
                                if msg_db_id:
                                    replay_existing_msg_id = int(msg_db_id)

                                _log_skip(
                                    "duplicada (upsert)",
                                    idx=idx,
                                    msg_id=msg_id,
                                    cliente_id=cli_id,
                                    existing_id=replay_existing_msg_id,
                                    instancia_id=inst.id,
                                )

                        except Exception as e:
                            LOG(f"[UPsert][erro upsert mensagem] idx={idx} msg_id={msg_id} err={e}")
                            _safe_rollback(db)
                            continue

                else:
                    try:
                        msg_db_id, inserted_11, cli_id = await _insert_mensagem_no_msgid_fk_safe(
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
                            avatar_url=None,
                        )

                        try:
                            db.commit()
                        except Exception as e:
                            _safe_rollback(db)
                            LOG(f"[UPsert][commit-msg-sem-id-erro] idx={idx} err={e}")
                            continue

                        novas += 1
                        inserted_11 = True

                        _log_ctx(
                            "[UPsert][saved-nomsgid]",
                            idx=idx,
                            saved_id=msg_db_id,
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
                    await run_triagem_pos_commit(
                        empresa_id=empresa_id,
                        instancia_id=inst.id,
                        telefone=telefone,
                        conteudo=conteudo,
                        direcao=direcao,
                        remote_jid=remote_jid,
                    )

                    # Reabre/relê o atendimento após a triagem, porque o departamento
                    # pode ter sido definido agora no atendimento aberto.
                    if _HAS_MSG_ATD_FIELD and cli_id:
                        atendimento_id = _resolve_atendimento_id_safe(
                            db,
                            empresa_id=empresa_id,
                            instancia_id=inst.id,
                            cliente_id=cli_id,
                            direcao=direcao,
                            ts_dt=ts_msg,
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
                        with SessionLocal() as db_ws:
                            cliente = _fetch_cliente(db_ws, cli_id)

                        ws_payload = {
                            "empresa_id": empresa_id,
                            "cliente_id": cli_id,
                            "instancia_id": inst.id,
                            "instance_name": getattr(inst, "instance_name", None),
                            "atendimento_id": atendimento_id,
                            "departamento_id": (getattr(cliente, "departamento_id", None) if cliente else None),
                            "colaborador_id": (getattr(cliente, "colaborador_id", None) if cliente else None),
                            "telefone": formatar_telefone_br(telefone),
                            "avatar_url": getattr(cliente, "avatar_url", None) if cliente else None,
                            "push_name": getattr(cliente, "nome_whatsapp", None) if cliente else None,
                            "nome": getattr(cliente, "nome", None) if cliente else formatted,
                            "mensagem": conteudo,
                            "tipo": direcao,
                            "origem": ("atendente" if from_me else "cliente"),
                            "timestamp": _iso_utc(ts_msg),
                            "msg_id": (str(msg_id) if msg_id else (str(msg_db_id) if msg_db_id else None)),
                            "ack": (ack_value if from_me else None),
                            "serverTimestamp": _server_ts_ms(),
                        }

                        await conexoes_ativas.send_message(f"emp:{empresa_id}", ws_payload)
                    except Exception as e:
                        LOG(f"[UPsert][ws] falha ao emitir: {e}")

                    try:
                        invalidate_emp_cache(empresa_id)
                    except Exception:
                        pass

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

        try:
            if novas > 0 and empresa_id:
                _invalidate_emp_cache(empresa_id)
        except Exception:
            pass

        LOG(f"[UPsert] inst={inst_id} novas={novas}")


HANDLERS[EvoEvent.MESSAGES_UPSERT] = on_messages_upsert

__all__ = [
    "on_messages_upsert",
]