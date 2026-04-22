#backend\integrations\evolution\services\history_sync_service.py

from __future__ import annotations
import asyncio
import os
import random
from datetime import timedelta

from sqlalchemy import text
from sqlalchemy.orm import Session

from backend import models
from backend.database import SessionLocal
from backend.websocket_manager import conexoes_ativas

from ..parsers.message_parser import parse_messages_payload
from ..repositories.clientes_repo import get_cliente_by_id, upsert_cliente_repo
from ..repositories.grupos_repo import get_or_create_grupo_by_remote, insert_group_message
from ..repositories.instancias_repo import get_instancia_by_name, get_me_number_by_instancia
from ..services.media_service import (
    save_media_for_group_message_with_db,
    save_media_for_message_11_with_db,
)
from ..utils.ack_utils import ack_from_status
from ..utils.cache_utils import _invalidate_emp_cache
from ..utils.log_utils import LOG, _short, _log_ctx
from ..utils.phone_utils import formatar_telefone_br, remote_to_num
from ..utils.time_utils import _iso_utc, _now_utc, _server_ts_ms
from ..handlers.shared import (
    find_existing_mensagem_11_id,
    is_nome_grupo_ruim,
    evo_get_group_subject,
    avatar_from_contact_like,
)

ENABLE_MESSAGES_SET = (os.getenv("ENABLE_MESSAGES_SET", "true").lower() == "true")
HISTORY_LIMIT_HOURS = int(os.getenv("HISTORY_LIMIT_HOURS", "0") or "0")
HISTORY_IGNORE_AFTER_DONE_MIN = int(os.getenv("HISTORY_IGNORE_AFTER_DONE_MIN", "15") or "15")
ALLOW_HISTORY_7D = (os.getenv("ALLOW_HISTORY_7D", "false").lower() == "true")
HISTORY_MAX_IMPORT = int(os.getenv("HISTORY_MAX_IMPORT", "3000") or "3000")
HISTORY_BATCH_COMMIT = int(os.getenv("HISTORY_BATCH_COMMIT", "250") or "250")
HISTORY_SLEEP_EVERY = int(os.getenv("HISTORY_SLEEP_EVERY", "500") or "500")
DISABLE_MEDIA_ON_HISTORY = (os.getenv("DISABLE_MEDIA_ON_HISTORY", "true").lower() == "true")

_HISTORY_DONE_AT: dict[str, float] = {}


def _stamp_inst(obj, inst) -> None:
    if obj is None or inst is None:
        return
    if hasattr(obj, "instancia_id") and getattr(obj, "instancia_id", None) is None:
        setattr(obj, "instancia_id", getattr(inst, "id", None))
    if hasattr(obj, "instance_name") and not getattr(obj, "instance_name", None):
        setattr(obj, "instance_name", getattr(inst, "instance_name", None))


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
                wait = base_delay * (2 ** i) + random.random() * 0.01
                await asyncio.sleep(wait)
                continue
            raise


def _try_acquire_hist_lock(db: Session, empresa_id: int, instancia_id: int) -> bool:
    try:
        return bool(
            db.execute(
                text("SELECT pg_try_advisory_lock(:a, :b)"),
                {"a": int(empresa_id), "b": int(instancia_id)},
            ).scalar()
        )
    except Exception:
        return True


def _release_hist_lock(db: Session, empresa_id: int, instancia_id: int) -> None:
    try:
        db.execute(
            text("SELECT pg_advisory_unlock(:a, :b)"),
            {"a": int(empresa_id), "b": int(instancia_id)},
        )
    except Exception:
        pass


async def process_messages_set(inst_id: str, data) -> int:
    if not ENABLE_MESSAGES_SET:
        LOG("[MESSAGES_SET] Ignorado (ENABLE_MESSAGES_SET=false).")
        return 0

    now_s = _now_utc().timestamp()
    last = _HISTORY_DONE_AT.get(inst_id)
    if last and (now_s - last) < (HISTORY_IGNORE_AFTER_DONE_MIN * 60):
        LOG(f"[MESSAGES_SET] Ignorado para {inst_id}: já finalizado há {int(now_s - last)}s.")
        return 0

    with SessionLocal() as db:
        inst = get_instancia_by_name(db, instance_name=inst_id)
        if not inst:
            LOG(f"Instância não encontrada: {inst_id}")
            return 0

        empresa_id = int(inst.empresa_id)
        historico_opcao = (getattr(inst, "historico_restaurar", None) or "none").lower()

        if historico_opcao == "7d" and not ALLOW_HISTORY_7D:
            _log_ctx("[HIST] downgrade 7d→24h", inst=inst_id)
            historico_opcao = "24h"

        mensagens = parse_messages_payload(
            data,
            inst_name=inst_id,
            empresa_id=empresa_id,
            instancia_id=inst.id,
            me_number=get_me_number_by_instancia(inst),
        )
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
            return 0

        got_lock = _try_acquire_hist_lock(db, empresa_id, inst.id)
        if not got_lock:
            LOG(f"[MESSAGES_SET] lock ocupado para emp={empresa_id} inst={inst.id}; saindo.")
            return 0

        try:
            if HISTORY_LIMIT_HOURS > 0:
                limite_tempo = _now_utc() - timedelta(hours=HISTORY_LIMIT_HOURS)
            else:
                dias = 1 if historico_opcao == "24h" else (7 if historico_opcao == "7d" else 0)
                limite_tempo = _now_utc() - timedelta(days=dias)

            novas = 0
            me_num = get_me_number_by_instancia(inst)
            recent_sec = int(os.getenv("HISTORY_RECENT_WS_SEC", "120") or "120")

            for idx, parsed in enumerate(mensagens, start=1):
                if novas >= max(1, int(HISTORY_MAX_IMPORT)):
                    _log_ctx("[HIST] cap atingido", novas=novas, cap=HISTORY_MAX_IMPORT)
                    break

                ts_msg = parsed.get("timestamp_dt")
                if not ts_msg:
                    _log_ctx("[HIST][skip] ts inválido", idx=idx, msg_id=parsed.get("msg_id"))
                    continue

                if ts_msg < limite_tempo:
                    _log_ctx("[HIST][skip] fora da janela", idx=idx, msg_id=parsed.get("msg_id"), ts=_iso_utc(ts_msg))
                    continue

                msg_id = parsed.get("msg_id")
                conteudo = parsed.get("conteudo") or ""
                media_meta = parsed.get("media_meta") if not DISABLE_MEDIA_ON_HISTORY else None
                from_me = bool(parsed.get("from_me"))
                direcao = parsed.get("direcao") or ("saida" if from_me else "entrada")

                if parsed.get("is_group"):
                    if not msg_id:
                        _log_ctx("[HIST][skip] grupo sem msg_id", idx=idx, remote_jid=parsed.get("remote_jid"))
                        continue

                    grupo = get_or_create_grupo_by_remote(
                        db,
                        empresa_id=empresa_id,
                        remote_jid=str(parsed.get("remote_jid")),
                        instancia_id=inst.id,
                        inst_obj=inst,
                        nome_padrao="Grupo",
                    )

                    try:
                        if is_nome_grupo_ruim(getattr(grupo, "nome", None)):
                            subject = evo_get_group_subject(getattr(inst, "instance_name", inst_id), str(parsed.get("remote_jid")))
                            if subject and (grupo.nome or "") != subject:
                                grupo.nome = subject
                    except Exception:
                        pass

                    avatar = avatar_from_contact_like(parsed.get("raw") or {})
                    if avatar and (getattr(grupo, "avatar_url", None) or "") != avatar:
                        grupo.avatar_url = avatar
                    _stamp_inst(grupo, inst)

                    participant = parsed.get("participant_jid")
                    cli_autor_id = None
                    tel_autor = remote_to_num(participant) if participant else None
                    if tel_autor and (not me_num or tel_autor != me_num):
                        cli_autor_id = await _retry_deadlock(
                            db,
                            lambda: upsert_cliente_repo(
                                db,
                                empresa_id=empresa_id,
                                instancia_id=inst.id,
                                telefone_raw=tel_autor,
                                nome=formatar_telefone_br(tel_autor),
                                nome_whatsapp=None,
                                avatar_url=None,
                            ),
                        )

                    gm_id, inserted = insert_group_message(
                        db,
                        empresa_id=empresa_id,
                        grupo_id=grupo.id,
                        instancia_id=inst.id,
                        author_jid=participant,
                        from_me=from_me,
                        conteudo=conteudo,
                        tipo=direcao,
                        message_type=parsed.get("message_type"),
                        lida=bool(from_me),
                        timestamp_dt=ts_msg,
                        msg_id=str(msg_id),
                        ack=int(parsed.get("ack") or 0),
                        inst_obj=inst,
                    )
                    if not inserted:
                        _log_ctx("[HIST][skip] duplicada (grupo)", idx=idx, msg_id=msg_id, grupo_id=grupo.id)
                        continue

                    novas += 1
                    _log_ctx(
                        "[HIST][saved][grupo]",
                        idx=idx,
                        msg_id=msg_id,
                        saved_id=gm_id,
                        ts=_iso_utc(ts_msg),
                        preview=_short(conteudo),
                    )

                    if media_meta:
                        save_media_for_group_message_with_db(
                            db,
                            inst_id=inst_id,
                            empresa_id=empresa_id,
                            grupo_id=grupo.id,
                            cliente_id=cli_autor_id,
                            msg_id=str(msg_id),
                            media_meta=media_meta,
                            instancia_id=inst.id,
                            idx=idx,
                        )

                else:
                    telefone = parsed.get("telefone")
                    if not telefone or (me_num and telefone == me_num):
                        _log_ctx("[HIST][skip] telefone inválido/eco", idx=idx, msg_id=msg_id, telefone=telefone)
                        continue

                    cli_id = await _retry_deadlock(
                        db,
                        lambda: upsert_cliente_repo(
                            db,
                            empresa_id=empresa_id,
                            instancia_id=inst.id,
                            telefone_raw=telefone,
                            nome=(parsed.get("push_name") or formatar_telefone_br(telefone)),
                            nome_whatsapp=(parsed.get("push_name") or formatar_telefone_br(telefone)),
                            avatar_url=None,
                        ),
                    )
                    if not cli_id:
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
                            _log_ctx("[HIST][skip] duplicada (1:1)", idx=idx, msg_id=msg_id, existing_id=existing)
                            continue

                    ack_initial = ack_from_status(parsed.get("status")) if from_me else None

                    msg_model = models.Mensagem(
                        empresa_id=empresa_id,
                        cliente_id=cli_id,
                        conteudo=conteudo,
                        tipo=direcao,
                        lida=bool(from_me),
                        ack=ack_initial,
                        timestamp=ts_msg,
                        msg_id=str(msg_id) if msg_id else None,
                        instancia_id=inst.id,
                    )
                    _stamp_inst(msg_model, inst)
                    db.add(msg_model)
                    db.flush()

                    msg_db_id = int(msg_model.id)
                    novas += 1

                    _log_ctx(
                        "[HIST][saved][1:1]",
                        idx=idx,
                        msg_id=msg_id,
                        saved_id=msg_db_id,
                        telefone=telefone,
                        ts=_iso_utc(ts_msg),
                        preview=_short(conteudo),
                    )

                    try:
                        is_recent = abs((_now_utc() - ts_msg).total_seconds()) <= recent_sec
                    except Exception:
                        is_recent = False

                    if is_recent:
                        try:
                            cliente = get_cliente_by_id(db, cli_id)
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
                                    "tipo": direcao,
                                    "origem": "atendente" if from_me else "cliente",
                                    "timestamp": _iso_utc(ts_msg),
                                    "msg_id": (str(msg_id) if msg_id else str(msg_db_id)),
                                    "ack": (ack_initial if from_me else None),
                                    "serverTimestamp": _server_ts_ms(),
                                },
                            )
                        except Exception as e:
                            _log_ctx("[HIST][ws-live] falha ao emitir", idx=idx, msg_id=msg_id, err=str(e))

                    if media_meta:
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

                if idx % max(1, int(HISTORY_BATCH_COMMIT)) == 0:
                    db.commit()
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

                if idx % max(1, int(HISTORY_SLEEP_EVERY)) == 0:
                    await asyncio.sleep(0)

            db.commit()
            _HISTORY_DONE_AT[inst_id] = _now_utc().timestamp()

            try:
                _invalidate_emp_cache(empresa_id)
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

            return novas

        finally:
            _release_hist_lock(db, empresa_id, inst.id)


async def run_history_sync(inst_name: str, payload: dict | list) -> int:
    return await process_messages_set(inst_name, payload)


__all__ = [
    "process_messages_set",
    "run_history_sync",
]