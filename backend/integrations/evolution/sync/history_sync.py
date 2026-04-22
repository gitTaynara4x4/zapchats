#backend\integrations\evolution\sync\history_sync.py

from __future__ import annotations
import asyncio
import os
from datetime import timedelta
from typing import Any

from sqlalchemy.orm import Session
from sqlalchemy.exc import IntegrityError

from backend.database import SessionLocal
from backend import models

from ..parsers.message_parser import (
    extract_media_meta,
    extract_messages_any_shape,
    extract_text_from_baileys,
)
from ..transport.websocket_emitters import (
    emit_history_sync_done,
    emit_history_sync_progress,
    emit_history_sync_start,
    emit_live_message,
    emit_reload_clientes,
    emit_reload_grupos,
)
from ..transport.evolution_http_client import evo_get_group_subject

try:
    from ..utils.ack_utils import _ack_from_status
except Exception:  # pragma: no cover
    from ..utils.ack_utils import ack_from_status as _ack_from_status

try:
    from ..utils.jid_utils import _jid_strip_device, _is_lid_jid
except Exception:  # pragma: no cover
    from ..utils.jid_utils import jid_strip_device as _jid_strip_device, is_lid_jid as _is_lid_jid

try:
    from ..utils.log_utils import LOG, _log_ctx, _short
except Exception:  # pragma: no cover
    from ..utils.log_utils import LOG, _short

    def _log_ctx(*args, **kwargs):
        return None

try:
    from ..utils.phone_utils import (
        _remote_to_num,
        _resolve_counterparty_num_1to1,
        formatar_telefone_br,
    )
except Exception:  # pragma: no cover
    from ..utils.phone_utils import (
        remote_to_num as _remote_to_num,
        _resolve_counterparty_num_1to1,
        formatar_telefone_br,
    )

try:
    from ..utils.time_utils import _iso_utc, _now_utc, _server_ts_ms, _to_dt_utc
except Exception:  # pragma: no cover
    from ..utils.time_utils import iso_utc as _iso_utc, now_utc as _now_utc, server_ts_ms as _server_ts_ms, to_dt_utc as _to_dt_utc

from ..services.media_service import (
    save_media_for_group_message_with_db,
    save_media_for_message_11_with_db,
)


ENABLE_MESSAGES_SET = os.getenv("ENABLE_MESSAGES_SET", "true").lower() == "true"
ALLOW_HISTORY_7D = os.getenv("ALLOW_HISTORY_7D", "false").lower() == "true"
DISABLE_MEDIA_ON_HISTORY = os.getenv("DISABLE_MEDIA_ON_HISTORY", "true").lower() == "true"
HISTORY_LIMIT_HOURS = int(os.getenv("HISTORY_LIMIT_HOURS", "24") or "24")
HISTORY_MAX_IMPORT = int(os.getenv("HISTORY_MAX_IMPORT", "5000") or "5000")
HISTORY_BATCH_COMMIT = int(os.getenv("HISTORY_BATCH_COMMIT", "100") or "100")
HISTORY_SLEEP_EVERY = int(os.getenv("HISTORY_SLEEP_EVERY", "250") or "250")
HISTORY_IGNORE_AFTER_DONE_MIN = int(os.getenv("HISTORY_IGNORE_AFTER_DONE_MIN", "15") or "15")
HISTORY_RECENT_WS_SEC = int(os.getenv("HISTORY_RECENT_WS_SEC", "120") or "120")

_HISTORY_DONE_AT: dict[str, float] = {}


def _get_inst_row(db: Session, inst_name: str) -> models.EmpresaInstancia | None:
    return (
        db.query(models.EmpresaInstancia)
        .filter(models.EmpresaInstancia.instance_name == inst_name)
        .first()
    )


def _me_number_by_inst(inst: models.EmpresaInstancia | None) -> str | None:
    if not inst:
        return None
    raw = getattr(inst, "numero_instancia", None)
    if not raw:
        return None
    out = "".join(ch for ch in str(raw) if ch.isdigit())
    return out or None


def _pick_group_row(
    db: Session,
    *,
    empresa_id: int,
    instancia_id: int,
    instance_name: str,
    remote_jid: str,
) -> models.Grupo:
    grp = (
        db.query(models.Grupo)
        .filter(
            models.Grupo.empresa_id == int(empresa_id),
            models.Grupo.remote_jid == str(remote_jid),
        )
        .first()
    )
    if grp:
        if getattr(grp, "instancia_id", None) is None:
            grp.instancia_id = int(instancia_id)
        if hasattr(grp, "instance_name") and not getattr(grp, "instance_name", None):
            setattr(grp, "instance_name", instance_name)
        return grp

    grp = models.Grupo(
        empresa_id=int(empresa_id),
        remote_jid=str(remote_jid),
        nome="Grupo",
        instancia_id=int(instancia_id),
    )
    if hasattr(grp, "instance_name"):
        setattr(grp, "instance_name", instance_name)

    db.add(grp)
    db.flush()
    return grp


def _upsert_cliente_local(
    db: Session,
    *,
    empresa_id: int,
    instancia_id: int,
    telefone: str,
    nome: str | None,
    nome_whatsapp: str | None,
    avatar_url: str | None = None,
) -> int | None:
    cli = (
        db.query(models.Cliente)
        .filter(
            models.Cliente.empresa_id == int(empresa_id),
            models.Cliente.telefone == str(telefone),
        )
        .first()
    )

    nome_final = (nome or nome_whatsapp or formatar_telefone_br(telefone)).strip()

    if not cli:
        cli = models.Cliente(
            empresa_id=int(empresa_id),
            telefone=str(telefone),
            nome=nome_final,
            nome_whatsapp=(nome_whatsapp or nome_final),
            avatar_url=avatar_url,
            instancia_id=int(instancia_id),
        )
        db.add(cli)
        db.flush()
        return int(cli.id)

    changed = False

    if getattr(cli, "instancia_id", None) is None:
        cli.instancia_id = int(instancia_id)
        changed = True

    if nome_whatsapp and getattr(cli, "nome_whatsapp", None) != nome_whatsapp:
        cli.nome_whatsapp = nome_whatsapp
        changed = True

    if nome_final and getattr(cli, "nome", None) != nome_final:
        cli.nome = nome_final
        changed = True

    if avatar_url and getattr(cli, "avatar_url", None) != avatar_url:
        cli.avatar_url = avatar_url
        changed = True

    if changed:
        db.flush()

    return int(cli.id)


def _find_existing_msg_11(
    db: Session,
    *,
    instancia_id: int,
    msg_id: str | None,
) -> int | None:
    raw = str(msg_id or "").strip()
    if not raw:
        return None

    row = (
        db.query(models.Mensagem.id)
        .filter(
            models.Mensagem.instancia_id == int(instancia_id),
            models.Mensagem.msg_id == raw,
        )
        .first()
    )
    return int(row[0]) if row and row[0] is not None else None


def _find_existing_group_msg(
    db: Session,
    *,
    grupo_id: int,
    msg_id: str | None,
) -> int | None:
    raw = str(msg_id or "").strip()
    if not raw:
        return None

    row = (
        db.query(models.MensagemGrupo.id)
        .filter(
            models.MensagemGrupo.grupo_id == int(grupo_id),
            models.MensagemGrupo.msg_id == raw,
        )
        .first()
    )
    return int(row[0]) if row and row[0] is not None else None


def _resolve_remote_jid_from_message(m: dict[str, Any], me_number: str | None) -> str | None:
    key = m.get("key") if isinstance(m.get("key"), dict) else {}

    raw_remote = (
        key.get("remoteJid")
        or key.get("remote_jid")
        or m.get("remoteJid")
        or m.get("jid")
        or m.get("chatId")
        or ""
    )
    raw_remote = _jid_strip_device(raw_remote)
    if not raw_remote:
        return None

    alt_jid = (
        key.get("remoteJidAlt")
        or key.get("remote_jid_alt")
        or m.get("remoteJidAlt")
        or m.get("remote_jid_alt")
    )
    if _is_lid_jid(raw_remote) and isinstance(alt_jid, str) and "@" in alt_jid:
        return _jid_strip_device(alt_jid)

    if _is_lid_jid(raw_remote):
        tel_fallback, alt = _resolve_counterparty_num_1to1(m, me_number)
        if isinstance(alt, str) and "@" in alt:
            return _jid_strip_device(alt)
        if tel_fallback:
            return f"{tel_fallback}@s.whatsapp.net"

    return raw_remote


async def run_history_sync(inst_name: str, payload: dict | list) -> int:
    if not ENABLE_MESSAGES_SET:
        LOG("[HISTORY_SYNC] ignorado: ENABLE_MESSAGES_SET=false")
        return 0

    now_s = _now_utc().timestamp()
    last = _HISTORY_DONE_AT.get(inst_name)
    if last and (now_s - last) < (HISTORY_IGNORE_AFTER_DONE_MIN * 60):
        LOG(f"[HISTORY_SYNC] ignorado para {inst_name}: já sincronizado recentemente.")
        return 0

    mensagens = extract_messages_any_shape(payload)
    if not mensagens:
        return 0

    with SessionLocal() as db:
        inst = _get_inst_row(db, inst_name)
        if not inst:
            LOG(f"[HISTORY_SYNC] instância não encontrada: {inst_name}")
            return 0

        empresa_id = int(inst.empresa_id)
        instancia_id = int(inst.id)
        me_num = _me_number_by_inst(inst)
        instance_name = str(inst.instance_name)

        total = len(mensagens)
        await emit_history_sync_start(empresa_id, total=total)

        limite_horas = HISTORY_LIMIT_HOURS
        historico_opcao = (getattr(inst, "historico_restaurar", None) or "").lower()
        if historico_opcao == "7d" and ALLOW_HISTORY_7D:
            limite_horas = max(limite_horas, 24 * 7)

        limite_tempo = _now_utc() - timedelta(hours=limite_horas)
        imported = 0
        touched_groups = False

        for idx, m in enumerate(mensagens, start=1):
            try:
                if imported >= max(1, HISTORY_MAX_IMPORT):
                    break

                if not isinstance(m, dict):
                    continue

                key = m.get("key") if isinstance(m.get("key"), dict) else {}
                msg_id = key.get("id") or m.get("id")
                from_me = bool(key.get("fromMe", False))
                status = m.get("status")
                ts_raw = m.get("messageTimestamp") or m.get("timestamp") or 0

                try:
                    ts_msg = _to_dt_utc(ts_raw)
                except Exception:
                    continue

                if not ts_msg or ts_msg < limite_tempo:
                    continue

                remote_jid = _resolve_remote_jid_from_message(m, me_num)
                if not remote_jid:
                    continue

                conteudo = extract_text_from_baileys(m)
                media_meta = None if DISABLE_MEDIA_ON_HISTORY else extract_media_meta(m)

                if remote_jid.endswith("@g.us"):
                    grp = _pick_group_row(
                        db,
                        empresa_id=empresa_id,
                        instancia_id=instancia_id,
                        instance_name=instance_name,
                        remote_jid=remote_jid,
                    )

                    if getattr(grp, "nome", None) in (None, "", "Grupo"):
                        try:
                            subject = await asyncio.to_thread(evo_get_group_subject, inst_name, remote_jid)
                            if subject and subject.strip():
                                grp.nome = subject.strip()
                        except Exception:
                            pass

                    if msg_id and _find_existing_group_msg(db, grupo_id=int(grp.id), msg_id=str(msg_id)):
                        continue

                    participant = (
                        key.get("participant")
                        or m.get("participant")
                        or m.get("sender")
                        or m.get("participantJid")
                        or ""
                    )
                    participant = _jid_strip_device(participant) if participant else ""

                    msgg = models.MensagemGrupo(
                        empresa_id=empresa_id,
                        grupo_id=int(grp.id),
                        author_jid=(participant or None),
                        from_me=bool(from_me),
                        conteudo=conteudo,
                        tipo=("saida" if from_me else "entrada"),
                        message_type=m.get("messageType"),
                        lida=bool(from_me),
                        timestamp=int(ts_msg.timestamp()),
                        msg_id=(str(msg_id) if msg_id else None),
                        ack=(_ack_from_status(status) if from_me else 0),
                        instancia_id=instancia_id,
                    )
                    db.add(msgg)
                    db.flush()

                    if media_meta:
                        try:
                            save_media_for_group_message_with_db(
                                db,
                                inst_id=inst_name,
                                empresa_id=empresa_id,
                                grupo_id=int(grp.id),
                                cliente_id=None,
                                msg_id=(str(msg_id) if msg_id else None),
                                media_meta=media_meta,
                                instancia_id=instancia_id,
                                idx=idx,
                            )
                        except Exception as e:
                            _log_ctx("[HISTORY_SYNC][group_media_err]", idx=idx, msg_id=msg_id, err=str(e))

                    imported += 1
                    touched_groups = True

                else:
                    telefone = _remote_to_num(remote_jid)
                    if not telefone:
                        continue

                    if me_num and telefone == me_num:
                        continue

                    if msg_id and _find_existing_msg_11(db, instancia_id=instancia_id, msg_id=str(msg_id)):
                        continue

                    cli_id = _upsert_cliente_local(
                        db,
                        empresa_id=empresa_id,
                        instancia_id=instancia_id,
                        telefone=telefone,
                        nome=formatar_telefone_br(telefone),
                        nome_whatsapp=(m.get("pushName") or m.get("senderName")),
                        avatar_url=None,
                    )
                    if not cli_id:
                        continue

                    msg_model = models.Mensagem(
                        empresa_id=empresa_id,
                        cliente_id=int(cli_id),
                        conteudo=conteudo,
                        tipo=("saida" if from_me else "entrada"),
                        lida=bool(from_me),
                        ack=(_ack_from_status(status) if from_me else 0),
                        timestamp=ts_msg,
                        msg_id=(str(msg_id) if msg_id else None),
                        instancia_id=instancia_id,
                    )
                    db.add(msg_model)
                    db.flush()

                    if media_meta:
                        try:
                            save_media_for_message_11_with_db(
                                db,
                                inst_id=inst_name,
                                empresa_id=empresa_id,
                                cliente_id=int(cli_id),
                                mensagem_id=int(msg_model.id),
                                msg_id=(str(msg_id) if msg_id else None),
                                media_meta=media_meta,
                                instancia_id=instancia_id,
                                idx=idx,
                            )
                        except Exception as e:
                            _log_ctx("[HISTORY_SYNC][media_err]", idx=idx, msg_id=msg_id, err=str(e))

                    try:
                        is_recent = abs((_now_utc() - ts_msg).total_seconds()) <= HISTORY_RECENT_WS_SEC
                    except Exception:
                        is_recent = False

                    if is_recent:
                        try:
                            cli = (
                                db.query(models.Cliente)
                                .filter(models.Cliente.id == int(cli_id))
                                .first()
                            )

                            await emit_live_message(
                                empresa_id=empresa_id,
                                payload={
                                    "empresa_id": empresa_id,
                                    "cliente_id": int(cli_id),
                                    "instancia_id": instancia_id,
                                    "instance_name": instance_name,
                                    "telefone": formatar_telefone_br(telefone),
                                    "avatar_url": getattr(cli, "avatar_url", None) if cli else None,
                                    "push_name": getattr(cli, "nome_whatsapp", None) if cli else None,
                                    "nome": getattr(cli, "nome", None) if cli else formatar_telefone_br(telefone),
                                    "mensagem": conteudo,
                                    "tipo": ("saida" if from_me else "entrada"),
                                    "origem": ("atendente" if from_me else "cliente"),
                                    "timestamp": _iso_utc(ts_msg),
                                    "msg_id": (str(msg_id) if msg_id else str(msg_model.id)),
                                    "ack": (_ack_from_status(status) if from_me else None),
                                    "serverTimestamp": _server_ts_ms(),
                                },
                            )
                        except Exception as e:
                            _log_ctx("[HISTORY_SYNC][live_emit_err]", idx=idx, err=str(e))

                    imported += 1

                if imported % max(1, HISTORY_BATCH_COMMIT) == 0:
                    try:
                        db.commit()
                    except IntegrityError:
                        db.rollback()
                    except Exception:
                        db.rollback()

                if imported % 100 == 0:
                    await emit_history_sync_progress(empresa_id, imported=imported, total=total)

                if imported % max(1, HISTORY_SLEEP_EVERY) == 0:
                    await asyncio.sleep(0)

            except IntegrityError:
                db.rollback()
                continue
            except Exception as e:
                db.rollback()
                _log_ctx(
                    "[HISTORY_SYNC][item_err]",
                    idx=idx,
                    msg_id=(key.get("id") if isinstance(key, dict) else None),
                    err=str(e),
                    preview=_short(extract_text_from_baileys(m)),
                )
                continue

        try:
            db.commit()
        except Exception:
            db.rollback()

    _HISTORY_DONE_AT[inst_name] = now_s

    await emit_history_sync_done(empresa_id, total=total, imported=imported)
    await emit_reload_clientes(empresa_id)
    if touched_groups:
        await emit_reload_grupos(empresa_id, total=0)

    LOG(f"[HISTORY_SYNC] inst={inst_name} total={total} imported={imported}")
    return imported


async def process_messages_set(inst_name: str, payload: dict | list) -> int:
    return await run_history_sync(inst_name, payload)


__all__ = [
    "process_messages_set",
    "run_history_sync",
]