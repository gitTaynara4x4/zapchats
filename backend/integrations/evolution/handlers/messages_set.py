# backend/integrations/evolution/handlers/messages_set.py

from __future__ import annotations

import asyncio
import os
from datetime import timedelta

from sqlalchemy import text

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
from ._state import _HISTORY_DONE_AT
from .shared import (
    EvoEvent,
    _carimbar_inst,
    _get_inst_row,
    _lid_map_set,
    _me_number_by_inst,
    _retry_deadlock,
    avatar_from_contact_like,
    find_existing_mensagem_11_id,
    grupo_row_by_remote,
    handler,
    is_nome_grupo_ruim,
    evo_get_group_subject,
    upsert_cliente,
)

ENABLE_MESSAGES_SET = (os.getenv("ENABLE_MESSAGES_SET", "true").lower() == "true")
HISTORY_LIMIT_HOURS = int(os.getenv("HISTORY_LIMIT_HOURS", "0") or "0")
HISTORY_IGNORE_AFTER_DONE_MIN = int(os.getenv("HISTORY_IGNORE_AFTER_DONE_MIN", "15") or "15")
ALLOW_HISTORY_7D = (os.getenv("ALLOW_HISTORY_7D", "false").lower() == "true")
HISTORY_MAX_IMPORT = int(os.getenv("HISTORY_MAX_IMPORT", "3000") or "3000")
HISTORY_BATCH_COMMIT = int(os.getenv("HISTORY_BATCH_COMMIT", "250") or "250")
HISTORY_SLEEP_EVERY = int(os.getenv("HISTORY_SLEEP_EVERY", "500") or "500")
DISABLE_MEDIA_ON_HISTORY = (os.getenv("DISABLE_MEDIA_ON_HISTORY", "true").lower() == "true")


def _is_deadlock_error(e: Exception) -> bool:
    base = getattr(e, "orig", e)
    msg = str(base).lower()
    return "deadlock detected" in msg


def _try_acquire_hist_lock(db, empresa_id: int, instancia_id: int) -> bool:
    try:
        return bool(
            db.execute(
                text("SELECT pg_try_advisory_lock(:a, :b)"),
                {"a": int(empresa_id), "b": int(instancia_id)},
            ).scalar()
        )
    except Exception:
        return True


def _release_hist_lock(db, empresa_id: int, instancia_id: int) -> None:
    try:
        db.execute(
            text("SELECT pg_advisory_unlock(:a, :b)"),
            {"a": int(empresa_id), "b": int(instancia_id)},
        )
    except Exception:
        pass


def _resolve_remote_jid_history(
    *,
    empresa_id: int,
    instancia_id: int,
    key: dict,
    message_item: dict,
    me_num: str | None,
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

    tel_fallback, alt = _resolve_counterparty_num_1to1(message_item, me_num)
    if isinstance(alt, str) and "@" in alt:
        real = jid_strip_device(alt)
        _lid_map_set(empresa_id, instancia_id, raw_remote, real)
        return real

    if tel_fallback:
        real = f"{tel_fallback}@s.whatsapp.net"
        _lid_map_set(empresa_id, instancia_id, raw_remote, real)
        return real

    return None


@handler(EvoEvent.MESSAGES_SET)
async def on_messages_set(inst_id: str, data):
    if not ENABLE_MESSAGES_SET:
        LOG("[MESSAGES_SET] Ignorado (ENABLE_MESSAGES_SET=false).")
        return

    now_s = _now_utc().timestamp()
    last = _HISTORY_DONE_AT.get(inst_id)
    if last and (now_s - last) < (HISTORY_IGNORE_AFTER_DONE_MIN * 60):
        LOG(f"[MESSAGES_SET] Ignorado para {inst_id}: já finalizado há {int(now_s - last)}s.")
        return

    PROG_STEP = 100

    with SessionLocal() as db:
        inst = _get_inst_row(db, inst_id)
        if not inst:
            LOG(f"Instância não encontrada: {inst_id}")
            return

        empresa_id = int(inst.empresa_id)
        historico_opcao = (getattr(inst, "historico_restaurar", None) or "none").lower()

        if historico_opcao == "7d" and not ALLOW_HISTORY_7D:
            _log_ctx("[HIST] downgrade 7d→24h", inst=inst_id)
            historico_opcao = "24h"

        mensagens = extract_messages_any_shape(data)
        total = len(mensagens)

        _log_ctx(
            "[HIST] start",
            inst=inst_id,
            empresa_id=empresa_id,
            historico_opcao=historico_opcao,
            total=total,
            DISABLE_MEDIA_ON_HISTORY=DISABLE_MEDIA_ON_HISTORY,
            HISTORY_MAX_IMPORT=HISTORY_MAX_IMPORT,
            HISTORY_BATCH_COMMIT=HISTORY_BATCH_COMMIT,
        )

        try:
            await conexoes_ativas.send_message(
                f"emp:{empresa_id}",
                {"type": "history_sync_start", "total": total, "serverTimestamp": _server_ts_ms()},
            )
        except Exception:
            pass

        if historico_opcao == "none" or not mensagens:
            try:
                await conexoes_ativas.send_message(
                    f"emp:{empresa_id}",
                    {"type": "history_sync_done", "total": total, "imported": 0, "serverTimestamp": _server_ts_ms()},
                )
            except Exception:
                pass
            return

        got_lock = _try_acquire_hist_lock(db, empresa_id, inst.id)
        if not got_lock:
            LOG(f"[MESSAGES_SET] lock ocupado para emp={empresa_id} inst={inst.id} — outro import rodando; saindo.")
            return

        try:
            if HISTORY_LIMIT_HOURS > 0:
                limite_tempo = _now_utc() - timedelta(hours=HISTORY_LIMIT_HOURS)
            else:
                dias = 1 if historico_opcao == "24h" else (7 if historico_opcao == "7d" else 0)
                limite_tempo = _now_utc() - timedelta(days=dias)

            novas = 0
            me_num = _me_number_by_inst(inst)
            cap = max(1, int(HISTORY_MAX_IMPORT))

            _log_ctx("[HIST] janela/limites", limite_utc=_iso_utc(limite_tempo), cap=cap)

            try:
                RECENT_SEC = int(os.getenv("HISTORY_RECENT_WS_SEC", "120") or "120")
            except Exception:
                RECENT_SEC = 120

            for idx, m in enumerate(mensagens, start=1):
                if novas >= cap:
                    _log_ctx("[HIST] cap atingido", novas=novas, cap=cap)
                    break

                if not isinstance(m, dict):
                    _log_ctx("[HIST][skip] m não é dict", idx=idx, type_m=type(m).__name__)
                    continue

                key = m.get("key") if isinstance(m.get("key"), dict) else {}
                msg_id = key.get("id") or m.get("id")
                ts_raw = m.get("messageTimestamp") or m.get("timestamp") or 0

                try:
                    ts_msg = _to_dt_utc(ts_raw)
                except Exception:
                    _log_ctx("[HIST][skip] ts inválido", idx=idx, msg_id=msg_id, ts_raw=ts_raw)
                    continue

                if ts_msg < limite_tempo:
                    _log_ctx("[HIST][skip] fora da janela", idx=idx, msg_id=msg_id, ts=_iso_utc(ts_msg))
                    continue

                remote_jid = _resolve_remote_jid_history(
                    empresa_id=empresa_id,
                    instancia_id=inst.id,
                    key=key,
                    message_item=m,
                    me_num=me_num,
                )
                if not remote_jid:
                    _log_ctx("[HIST][skip] sem remoteJid resolvido", idx=idx, msg_id=msg_id)
                    continue

                # =========================
                # GRUPO
                # =========================
                if remote_jid.endswith("@g.us"):
                    from_me = bool(key.get("fromMe", False))
                    author_j = (key.get("participant") or m.get("participant") or "")
                    author_j = jid_strip_device(author_j) if isinstance(author_j, str) else ""
                    conteudo = extract_text_from_baileys(m)
                    media_meta = None if DISABLE_MEDIA_ON_HISTORY else extract_media_meta(m)

                    grupo = grupo_row_by_remote(
                        db,
                        empresa_id,
                        remote_jid,
                        instancia_id=inst.id,
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

                    if msg_id and db.query(models.MensagemGrupo.id).filter_by(grupo_id=grupo.id, msg_id=str(msg_id)).first():
                        _log_ctx("[HIST][skip] duplicada (grupo)", idx=idx, msg_id=msg_id, grupo_id=grupo.id)
                        continue

                    cli_autor_id = None
                    try:
                        tel_autor = remote_to_num(author_j) if author_j else None
                        if tel_autor and (not me_num or tel_autor != me_num):
                            cli_autor_id = await _retry_deadlock(
                                db,
                                lambda: upsert_cliente(
                                    db,
                                    empresa_id=empresa_id,
                                    instancia_id=inst.id,
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
                            instancia_id=inst.id,
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
                                instancia_id=inst.id,
                                idx=idx,
                            )
                        except Exception as e:
                            _log_ctx("[HIST][grupo][midia] erro ao salvar", idx=idx, msg_id=msg_id, err=str(e))

                # =========================
                # 1:1
                # =========================
                else:
                    telefone = remote_to_num(remote_jid)
                    if not telefone:
                        _log_ctx("[HIST][skip] telefone inválido", idx=idx, msg_id=msg_id, remote_jid=remote_jid)
                        continue

                    if me_num and telefone == me_num:
                        _log_ctx("[HIST][skip] eco do meu número", idx=idx, msg_id=msg_id, telefone=telefone)
                        continue

                    from_me = bool(key.get("fromMe", False))
                    conteudo = extract_text_from_baileys(m)
                    media_meta = None if DISABLE_MEDIA_ON_HISTORY else extract_media_meta(m)

                    cli_id = await _retry_deadlock(
                        db,
                        lambda: upsert_cliente(
                            db,
                            empresa_id=empresa_id,
                            instancia_id=inst.id,
                            telefone_raw=telefone,
                            nome=(m.get("pushName") or formatar_telefone_br(telefone)),
                            nome_whatsapp=(m.get("pushName") or formatar_telefone_br(telefone)),
                            avatar_url=None,
                        ),
                    )
                    if not cli_id:
                        _log_ctx("[HIST][skip] upsert_cliente None", idx=idx, msg_id=msg_id, telefone=telefone)
                        continue

                    if msg_id:
                        existing = find_existing_mensagem_11_id(
                            db,
                            empresa_id=empresa_id,
                            cliente_id=cli_id,
                            msg_id=str(msg_id),
                            instancia_id=inst.id,
                        )
                        if existing:
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
                            instancia_id=inst.id,
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
                        telefone=telefone,
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
                                    "instancia_id": inst.id,
                                    "instance_name": getattr(inst, "instance_name", None),
                                    "telefone": formatar_telefone_br(telefone),
                                    "avatar_url": getattr(cliente, "avatar_url", None) if cliente else None,
                                    "push_name": getattr(cliente, "nome_whatsapp", None) if cliente else None,
                                    "nome": getattr(cliente, "nome", None) if cliente else formatar_telefone_br(telefone),
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
                                instancia_id=inst.id,
                                idx=idx,
                            )
                        except Exception as e:
                            _log_ctx("[HIST][midia] erro ao salvar", idx=idx, msg_id=msg_id, err=str(e))

                if novas % PROG_STEP == 0:
                    try:
                        await conexoes_ativas.send_message(
                            f"emp:{empresa_id}",
                            {
                                "type": "history_sync_progress",
                                "imported": novas,
                                "total": total,
                                "serverTimestamp": _server_ts_ms(),
                            },
                        )
                    except Exception:
                        pass
                    _log_ctx("[HIST] progress", imported=novas, total=total)

                if novas % max(1, HISTORY_BATCH_COMMIT) == 0:
                    try:
                        db.commit()
                        _log_ctx("[HIST] commit", imported=novas)
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

                if novas % max(1, HISTORY_SLEEP_EVERY) == 0:
                    await asyncio.sleep(0)

            try:
                db.commit()
                _log_ctx("[HIST] commit-final", imported=novas)
            except Exception as e:
                if _is_deadlock_error(e):
                    try:
                        db.rollback()
                    except Exception:
                        pass
                    _log_ctx("[HIST] commit-final-deadlock-rollback", err=str(e))
                else:
                    raise

            try:
                await conexoes_ativas.send_message(
                    f"emp:{empresa_id}",
                    {"type": "reload_clientes", "serverTimestamp": _server_ts_ms()},
                )
            except Exception:
                pass

            try:
                await conexoes_ativas.send_message(
                    f"emp:{empresa_id}",
                    {
                        "type": "history_sync_done",
                        "total": total,
                        "imported": novas,
                        "serverTimestamp": _server_ts_ms(),
                    },
                )
            except Exception:
                pass

            try:
                invalidate_emp_cache(empresa_id)
            except Exception:
                pass

            if historico_opcao != "none" and novas > 0:
                _HISTORY_DONE_AT[inst_id] = now_s

        finally:
            try:
                _release_hist_lock(db, empresa_id, inst.id)
            except Exception:
                pass


__all__ = [
    "on_messages_set",
]