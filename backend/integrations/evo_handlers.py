# backend/integrations/evo_handlers.py
from __future__ import annotations

import os
import re
import asyncio
import requests
from datetime import timedelta

from sqlalchemy.orm import Session
from sqlalchemy import text, bindparam
from sqlalchemy.exc import IntegrityError

from backend.database import SessionLocal
from backend import models
from backend.websocket_manager import conexoes_ativas
from backend.integrations.qrcode import qr_force_lock_acquire

from .evo_handlers_extract import (
    extract_text_from_baileys,
    extract_media_meta,
    extract_messages_any_shape,
    extract_contacts_any_shape,
    extract_chats_any_shape,
    normalize_mimetype,
)

from .evo_handlers_utils import (
    # registry
    EvoEvent,
    HANDLERS,
    handler,

    # env/config
    EVOLUTION_URL,
    HEADERS,
    SYNC_CONTACTS_ON_CONNECT,
    SYNC_CHATS_ON_CONNECT,
    ENABLE_MESSAGES_SET,
    EVOLUTION_FORCE_QR_ON_WS,
    HISTORY_LIMIT_HOURS,
    HISTORY_IGNORE_AFTER_DONE_MIN,
    ALLOW_HISTORY_7D,
    HISTORY_MAX_IMPORT,
    HISTORY_BATCH_COMMIT,
    HISTORY_SLEEP_EVERY,
    DISABLE_MEDIA_ON_HISTORY,
    N8N_MESSAGES_UPSERT_PATH,
    _n8n_url,

    # log/debug
    LOG,
    _short,
    _log_ctx,
    _log_skip,

    # rabbit monitor
    record_rabbit_event,
    get_rabbit_monitor,
    RABBIT_MONITOR,

    # time helpers
    _now_utc,
    _server_ts_ms,
    _to_dt_utc,
    _iso_utc,
    _int_unix,

    # cache
    _invalidate_emp_cache,

    # ack + phone/lid
    ACK_READ,
    _ack_from_status,
    _jid_strip_device,
    _is_lid_jid,
    _remote_to_num,
    _resolve_counterparty_num_1to1,
    formatar_telefone_br,
    _resolve_remote_jid,
    _lid_map_get,
    _lid_map_set,

    # db helpers
    upsert_cliente,
    _fetch_cliente,
    _HAS_MSG_ATD_FIELD,
    _get_or_open_atendimento,

    # inst helpers
    _inst_from,
    _get_inst_row,
    _empresa_id_by_inst,
    _me_number_by_inst,
    _carimbar_inst,

    # qr + expand
    _emit_qr,
    _extract_qr_fields,
    _evo_expand_websocket,
    _evo_expand_rabbit,

    # evo connect/media
    _evo_connect,
    _evo_get_base64_media,
    _download_media_bytes,
    _save_midia_db,

    # deadlock
    _retry_deadlock,
    _is_deadlock_error,
    _try_acquire_hist_lock,
    _release_hist_lock,

    # chatbot
    _notify_n8n_chatbot,
    _is_textual_content,

    # onboarding
    cancel_auto_cleanup,
)

# =========================
# CONFIG EXTRA (SYNC APÓS QR)
# =========================
SYNC_ON_CONNECT_AFTER_QR = (os.getenv("SYNC_ON_CONNECT_AFTER_QR", "true").lower() == "true")
QR_CONNECT_SYNC_WINDOW_MIN = int(os.getenv("QR_CONNECT_SYNC_WINDOW_MIN", "30") or "30")

# In-memory guards (avoid repeated heavy sync/expand spam). These reset on process restart.
INSTANCIAS_SYNC: set[str] = set()
QR_RECENT: dict[str, int] = {}  # instance -> unix seconds when a QR was last emitted

# ============================================================
# ✅ Grupo: buscar subject via Evolution (findGroupInfos) + cache
# ============================================================
_GROUP_INFO_CACHE: dict[tuple[str, str], tuple[str, int]] = {}
_GROUP_INFO_TTL = 60 * 60  # 1h

def _is_nome_grupo_ruim(nome: str | None) -> bool:
    if not nome:
        return True
    n = str(nome).strip().lower()
    return (n == "") or (n in {"grupo", "group", "grupo do whatsapp", "whatsapp group"})

def _evo_get_group_subject(instance_name: str, group_jid: str) -> str | None:
    """
    Chama: /group/findGroupInfos/{instance}?groupJid=...
    Retorna o subject (nome do grupo) quando disponível.
    """
    if not (EVOLUTION_URL and instance_name and group_jid):
        return None

    key = (instance_name, group_jid)
    now = _int_unix(_now_utc())

    cached = _GROUP_INFO_CACHE.get(key)
    if cached:
        subject_cached, ts_cached = cached
        if (now - ts_cached) < _GROUP_INFO_TTL:
            return subject_cached

    try:
        url = f"{EVOLUTION_URL.rstrip('/')}/group/findGroupInfos/{instance_name}"
        r = requests.get(url, headers=HEADERS, params={"groupJid": group_jid}, timeout=10)
        if not r.ok:
            return None
        js = r.json() or {}
        subject = js.get("subject")
        if isinstance(subject, str) and subject.strip():
            subject = subject.strip()
            _GROUP_INFO_CACHE[key] = (subject, now)
            return subject
        return None
    except Exception:
        return None


# =========================
# HANDLERS / HELPERS LOCAIS
# =========================
def _grupo_row_by_remote(
    db: Session,
    empresa_id: int,
    remote_jid: str,
    instancia_id: int | None = None,
    inst_obj: models.EmpresaInstancia | None = None,
) -> models.Grupo:
    g = (
        db.query(models.Grupo)
        .filter(models.Grupo.empresa_id == empresa_id, models.Grupo.remote_jid == remote_jid)
        .first()
    )
    if g:
        if instancia_id and g.instancia_id is None:
            g.instancia_id = instancia_id
        if inst_obj and hasattr(g, "instance_name") and not getattr(g, "instance_name", None):
            g.instance_name = inst_obj.instance_name
        return g

    g = models.Grupo(empresa_id=empresa_id, remote_jid=remote_jid, nome="Grupo", instancia_id=instancia_id)
    if inst_obj and hasattr(g, "instance_name"):
        g.instance_name = inst_obj.instance_name
    db.add(g)
    db.flush()
    return g


def _name_from_contact_like(c: dict) -> str | None:
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


def _avatar_from_contact_like(c: dict) -> str | None:
    return (
        c.get("profilePicUrl")
        or (c.get("profilePicThumbObj") or {}).get("eurl")
        or c.get("thumbnailUrl")
        or c.get("imageUrl")
        or c.get("pictureUrl")
        or None
    )


def _upsert_grupos_from_chats(db: Session, empresa_id: int, chats: list[dict], inst: models.EmpresaInstancia) -> int:
    imported = 0
    for ch in chats:
        jid = (ch.get("id") or ch.get("remoteJid") or ch.get("jid") or ch.get("wid") or "")
        if not isinstance(jid, str) or not jid.endswith("@g.us"):
            continue
        jid = _jid_strip_device(jid)

        nome = _name_from_contact_like(ch) or "Grupo"
        avatar = _avatar_from_contact_like(ch)

        g = (
            db.query(models.Grupo)
            .filter(models.Grupo.empresa_id == empresa_id, models.Grupo.remote_jid == jid)
            .first()
        )
        if not g:
            g = models.Grupo(
                empresa_id=empresa_id,
                remote_jid=jid,
                nome=nome,
                avatar_url=avatar,
                instancia_id=inst.id,
            )
            db.add(g)
            imported += 1
        else:
            changed = False
            if g.instancia_id is None:
                g.instancia_id = inst.id
                changed = True
            if hasattr(g, "instance_name") and not getattr(g, "instance_name", None):
                g.instance_name = getattr(inst, "instance_name", None)
                changed = True
            if nome and (g.nome or "") != nome:
                g.nome = nome
                changed = True
            if avatar and (g.avatar_url or "") != avatar:
                g.avatar_url = avatar
                changed = True
            if changed:
                imported += 1

    if imported:
        db.flush()
    return imported


# =========================
# Handlers
# =========================
@handler(EvoEvent.QRCODE_UPDATED)
async def on_qrcode_updated(first: str, payload: dict):
    inst_id = _inst_from(payload) or first
    record_rabbit_event("QRCODE_UPDATED", inst_id)
    data = (payload.get("data") or payload) if isinstance(payload, dict) else {}

    q = data.get("qrcode") if isinstance(data, dict) and isinstance(data.get("qrcode"), dict) else data
    b64 = (q.get("base64") if isinstance(q, dict) else None) or (q.get("image") if isinstance(q, dict) else None) or ""
    pairing_code = (q.get("pairingCode") if isinstance(q, dict) else None) or (q.get("code") if isinstance(q, dict) else None)

    limit = None
    try:
        limit = q.get("count") or q.get("limit") or q.get("timeout")
        if isinstance(limit, str) and limit.isdigit():
            limit = int(limit)
        if isinstance(limit, float):
            limit = int(limit)
        if not isinstance(limit, int):
            limit = None
    except Exception:
        limit = None

    if not (b64 or pairing_code):
        try:
            await conexoes_ativas.send_message(
                f"inst:{inst_id}",
                {
                    "type": "qrcode",
                    "waiting": True,
                    "instance": inst_id,
                    "qr_limit": limit,
                    "serverTimestamp": _server_ts_ms(),
                },
            )
        except Exception as e:
            LOG(f"[QR EVT] Falha ao emitir estado 'waiting' para inst:{inst_id}: {e}")
        return

    # ✅ marca QR recente para permitir sync no connect (janela)
    try:
        QR_RECENT[inst_id] = _int_unix(_now_utc())
    except Exception:
        pass

    await _emit_qr(inst_id, b64, pairing_code, limit)


@handler(EvoEvent.CONNECTION_UPDATE)
async def on_conn_update(first: str, payload: dict):
    inst_id = _inst_from(payload) or first
    record_rabbit_event("CONNECTION_UPDATE", inst_id)
    data = (payload.get("data") or payload) if isinstance(payload, dict) else {}

    st = str((data.get("state") or data.get("status") or "")).strip().lower()
    conectado = st in ("connected", "open")

    was_connected = False
    empresa_id = None
    historico_opcao = "none"

    with SessionLocal() as db:
        inst = _get_inst_row(db, inst_id)
        if not inst:
            return

        was_connected = bool(getattr(inst, "connected", False))
        inst.connected = bool(conectado)

        wuid = (data.get("id") or data.get("wid") or (data.get("me") or {}).get("id")) if isinstance(data, dict) else None
        if isinstance(wuid, str) and wuid.endswith("@s.whatsapp.net"):
            inst.numero_instancia = re.sub(r"\D", "", wuid.split("@", 1)[0])

        inst.last_seen = _now_utc()
        empresa_id = inst.empresa_id
        historico_opcao = (inst.historico_restaurar or "none").lower()

        db.commit()

    # ✅ quando desconecta/logout: libera sync futuro
    if (not conectado) and (st in ("close", "closed", "disconnected", "logout", "loggedout")):
        INSTANCIAS_SYNC.discard(inst_id)
        QR_RECENT.pop(inst_id, None)
        _mark_disconnected(inst_id)

    # ✅ só roda ações pesadas quando mudou de desconectado -> conectado
    if conectado and not was_connected:
        try:
            cancel_auto_cleanup(inst_id)
        except Exception as e:
            LOG(f"[CLEANUP] falha ao cancelar auto cleanup: {e}")

        if empresa_id is not None and (historico_opcao in ("24h", "7d") or (HISTORY_LIMIT_HOURS > 0)):
            try:
                await conexoes_ativas.send_message(
                    f"emp:{empresa_id}", {"type": "history_sync_start", "total": 0, "serverTimestamp": _server_ts_ms()}
                )
                await conexoes_ativas.send_message(
                    f"emp:{empresa_id}",
                    {"type": "history_sync_progress", "imported": 0, "total": 0, "serverTimestamp": _server_ts_ms()},
                )
            except Exception as e:
                LOG(f"[SYNC] falha ao emitir start/progress inicial: {e}")

        _evo_expand_websocket(inst_id)
        _evo_expand_rabbit(inst_id)

    # WS status
    await conexoes_ativas.send_message(
        f"inst:{inst_id}",
        {"type": "connection", "status": "CONNECTED" if conectado else "DISCONNECTED", "serverTimestamp": _server_ts_ms()},
    )
    if empresa_id is not None:
        await conexoes_ativas.send_message(
            f"emp:{empresa_id}",
            {
                "type": "connection",
                "inst_status": {"connected": bool(conectado), "instance": inst_id},
                "reload_whatsapp": True,
                "serverTimestamp": _server_ts_ms(),
            },
        )

    # ✅ roda sync 1x (e por padrão só depois de QR recente)
    if conectado and inst_id not in INSTANCIAS_SYNC:
        do_sync = True

        if SYNC_ON_CONNECT_AFTER_QR:
            now_s = _int_unix(_now_utc())
            qr_s = QR_RECENT.get(inst_id)
            do_sync = bool(qr_s and (now_s - int(qr_s)) <= (QR_CONNECT_SYNC_WINDOW_MIN * 60))

        if do_sync:
            INSTANCIAS_SYNC.add(inst_id)
            QR_RECENT.pop(inst_id, None)  # consumiu

            if SYNC_CONTACTS_ON_CONNECT:
                await _sync_contatos_completos(inst_id)
            if SYNC_CHATS_ON_CONNECT:
                await _sync_chats_completos(inst_id)

            if ENABLE_MESSAGES_SET:
                LOG("[MESSAGES_SET] aguardando histórico (none/24h/7d).")


async def on_logout_instance(instance: str, payload: dict):
    # ✅ logout/delete/remove liberam sync futuro
    INSTANCIAS_SYNC.discard(instance)
    QR_RECENT.pop(instance, None)
    _mark_disconnected(instance)


# ✅ REGISTRA 1x (sem duplicar mais embaixo)
HANDLERS[EvoEvent.LOGOUT_INSTANCE] = on_logout_instance
HANDLERS[EvoEvent.INSTANCE_DELETE] = on_logout_instance
HANDLERS[EvoEvent.REMOVE_INSTANCE] = on_logout_instance


def _mark_disconnected(instance: str):
    if not instance:
        return

    db: Session = SessionLocal()
    try:
        row = db.query(models.EmpresaInstancia).filter(models.EmpresaInstancia.instance_name == instance).first()
        if row:
            row.connected = False
            row.last_seen = _now_utc()

            emp = db.query(models.Empresa).filter(models.Empresa.id == row.empresa_id).first()
            if emp and hasattr(emp, "quantidade_instancias"):
                emp.quantidade_instancias = (
                    db.query(models.EmpresaInstancia)
                    .filter(
                        models.EmpresaInstancia.empresa_id == emp.id,
                        models.EmpresaInstancia.connected.is_(True),
                    )
                    .count()
                )
            db.commit()

            try:
                asyncio.create_task(
                    conexoes_ativas.send_message(
                        f"emp:{row.empresa_id}",
                        {"type": "reload_whatsapp", "serverTimestamp": _server_ts_ms()},
                    )
                )
            except Exception:
                pass
    finally:
        db.close()


@handler(EvoEvent.MESSAGES_UPSERT)
async def on_messages_upsert(inst_id: str, data):
    async def _send_to_n8n_raw(inst: str, raw_data):
        url = (os.getenv("N8N_MESSAGES_UPSERT_URL") or os.getenv("N8N_WEBHOOK_URL") or "").strip()
        if not url:
            return
        url = _n8n_url(url, path=N8N_MESSAGES_UPSERT_PATH) or url

        def _sanitize(obj):
            if isinstance(obj, (bytes, bytearray)):
                try:
                    return obj.decode("utf-8", "replace")
                except Exception:
                    return repr(obj)
            if isinstance(obj, dict):
                return {k: _sanitize(v) for k, v in obj.items()}
            if isinstance(obj, list):
                return [_sanitize(v) for v in obj]
            if isinstance(obj, tuple):
                return tuple(_sanitize(v) for v in obj)
            return obj

        safe_payload = {"event": "MESSAGES_UPSERT", "instance": inst, "payload": _sanitize(raw_data)}

        def _post():
            try:
                requests.post(url, json=safe_payload, timeout=5)
            except Exception as e:
                LOG(f"[N8N] erro ao enviar MESSAGES_UPSERT: {e}")

        await asyncio.to_thread(_post)

    try:
        asyncio.create_task(_send_to_n8n_raw(inst_id, data))
    except Exception as e:
        LOG(f"[N8N] falha ao agendar envio MESSAGES_UPSERT: {e}")

    with SessionLocal() as db:
        inst = _get_inst_row(db, inst_id)
        if not inst:
            LOG(f"[UPsert] instância não encontrada: {inst_id}")
            return

        empresa_id = inst.empresa_id
        me_number = _me_number_by_inst(inst)

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

        novas = 0  # conta inserts (direto + grupo)

        for idx, m in enumerate(mensagens, start=1):
            try:
                if not isinstance(m, dict):
                    _log_skip("m não é dict", idx=idx, type_m=type(m).__name__)
                    continue

                key = m.get("key") or {}
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

                alt_jid = (
                    key.get("remoteJidAlt")
                    or key.get("remote_jid_alt")
                    or m.get("remoteJidAlt")
                    or m.get("remote_jid_alt")
                )

                # -------- resolve LID via alt --------
                if _is_lid_jid(raw_remote) and isinstance(alt_jid, str) and "@" in alt_jid:
                    original_lid = _jid_strip_device(raw_remote)
                    real_jid = _jid_strip_device(alt_jid)

                    _log_ctx(
                        "[UPsert][lid-alt-resolve]",
                        idx=idx,
                        msg_id=msg_id,
                        lid=original_lid,
                        real_jid=real_jid,
                    )

                    raw_remote = real_jid
                    try:
                        if empresa_id and getattr(inst, "id", None):
                            _lid_map_set(empresa_id, inst.id, original_lid, real_jid)
                    except Exception as e:
                        _log_ctx("[UPsert][lid-alt-cache-fail]", idx=idx, msg_id=msg_id, err=str(e))

                original_jid = raw_remote
                resolved_jid = _resolve_remote_jid(inst_id, raw_remote)

                # -------- fallback LID (1:1) --------
                if _is_lid_jid(original_jid) and not resolved_jid:
                    tel_fallback, alt = _resolve_counterparty_num_1to1(m, me_number)
                    _log_ctx(
                        "[UPsert][lid-fallback]",
                        idx=idx,
                        msg_id=msg_id,
                        tel_fallback=tel_fallback,
                        alt=_short(alt, 64),
                    )

                    jid_from_alt: str | None = None
                    if isinstance(alt, str) and "@" in alt:
                        jid_from_alt = _jid_strip_device(alt)

                    if jid_from_alt:
                        resolved_jid = jid_from_alt
                        try:
                            _lid_map_set(empresa_id, inst.id, _jid_strip_device(original_jid), resolved_jid)
                        except Exception as e:
                            _log_ctx("[UPsert][lid-cache-fail]", err=str(e))

                    elif tel_fallback and not str(tel_fallback).startswith("LID-"):
                        resolved_jid = f"{tel_fallback}@s.whatsapp.net"
                        try:
                            _lid_map_set(empresa_id, inst.id, _jid_strip_device(original_jid), resolved_jid)
                        except Exception as e:
                            _log_ctx("[UPsert][lid-cache-fail]", err=str(e))
                    else:
                        _log_skip(
                            "JID @lid sem mapping (usando fallback sintético)",
                            idx=idx,
                            msg_id=msg_id,
                            preview=_short(extract_text_from_baileys(m)),
                        )
                        resolved_jid = original_jid

                remote_jid = resolved_jid or original_jid
                remote_jid = _jid_strip_device(remote_jid)

                from_me = bool(key.get("fromMe", m.get("fromMe", False)))
                direcao = "saida" if from_me else "entrada"
                push_name = m.get("pushName") or m.get("senderName")
                ts_msg = _to_dt_utc(ts_raw)
                conteudo = extract_text_from_baileys(m)

                # ✅ FIX 1: ack nunca pode ser NULL (coluna ack é NOT NULL)
                # - saída: calcula pelo status
                # - entrada: 0
                ack_value = int(_ack_from_status(status) if from_me else 0)

                # (mantém para logs/compat, mas NÃO use no INSERT)
                ack_initial = ack_value

                # =====================================================================
                # ✅ GRUPOS: idempotente + commit imediato (evita lock/timeout do UNIQUE)
                # =====================================================================
                if remote_jid.endswith("@g.us"):
                    if not msg_id:
                        _log_skip("grupo sem msg_id", idx=idx, remote_jid=remote_jid)
                        continue

                    grp_remote = _jid_strip_device(remote_jid)

                    try:
                        grp = _grupo_row_by_remote(
                            db,
                            empresa_id,
                            grp_remote,
                            instancia_id=getattr(inst, "id", None),
                            inst_obj=inst,
                        )
                    except Exception as e:
                        grp = None
                        LOG(f"[UPsert][grupo] falha criando/buscando grupo: {e}")

                    if grp is None:
                        _log_skip("grupo sem grp-row", idx=idx, msg_id=msg_id, remote_jid=grp_remote)
                        continue

                    # ✅ Se o grupo ainda não tem nome bom, resolve via findGroupInfos (cache)
                    try:
                        if _is_nome_grupo_ruim(getattr(grp, "nome", None)):
                            subject = _evo_get_group_subject(getattr(inst, "instance_name", inst_id), grp_remote)
                            if subject and (grp.nome or "") != subject:
                                grp.nome = subject
                    except Exception:
                        pass

                    participant = (
                        (key or {}).get("participant")
                        or m.get("participant")
                        or m.get("sender")
                        or m.get("participantJid")
                        or ""
                    )
                    participant = _jid_strip_device(participant) if isinstance(participant, str) else ""

                    # ⚠️ pushName aqui é do remetente, NÃO do grupo.
                    # Só atualiza nome/avatar do grupo se vier de fonte confiável.
                    try:
                        avatar = _avatar_from_contact_like(m)
                        if isinstance(avatar, str) and avatar.strip():
                            if getattr(grp, "avatar_url", None) != avatar.strip():
                                grp.avatar_url = avatar.strip()
                        _carimbar_inst(grp, inst)
                    except Exception:
                        pass

                    inserted = False

                    try:
                        ts_int = _int_unix(ts_msg)  # epoch
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
                        db.flush()   # valida UNIQUE
                        db.commit()  # ✅ solta o lock do u_msg_grupo_msgid imediatamente

                        novas += 1
                        inserted = True

                        _log_ctx(
                            "[UPsert][grupo-saved]",
                            idx=idx,
                            msg_id=msg_id,
                            grupo_id=grp.id,
                            saved_id=getattr(gm, "id", None),
                            from_me=from_me,
                            participant=_short(participant, 60),
                            ts=_iso_utc(ts_msg),
                            preview=_short(conteudo),
                        )

                    except IntegrityError:
                        # ✅ duplicada por msg_id (UNIQUE) → ignora sem travar
                        try:
                            db.rollback()
                        except Exception:
                            pass
                        _log_skip("duplicada grupo (msg_id)", idx=idx, msg_id=msg_id, grupo_id=grp.id)
                        inserted = False

                    except Exception as e:
                        LOG(f"[UPsert][grupo][erro ao salvar] idx={idx} msg_id={msg_id} err={e}")
                        try:
                            db.rollback()
                        except Exception:
                            pass
                        continue

                    # ✅ Só emite WS live se realmente inseriu (evita duplicar no front)
                    if inserted:
                        try:
                            ws_payload_grupo = {
                                "empresa_id": empresa_id,
                                "cliente_id": grp.id,          # compatibilidade
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
                                "autor_nome": (push_name or participant or None),
                                "serverTimestamp": _server_ts_ms(),
                            }
                            await conexoes_ativas.send_message(f"emp:{empresa_id}", ws_payload_grupo)
                        except Exception as e:
                            LOG(f"[UPsert][grupo][ws-live] falha ao emitir: {e}")

                        # lista/preview
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

                # =====================================================================
                # 1:1 (normal)
                # =====================================================================
                telefone = _remote_to_num(remote_jid)
                if not telefone:
                    _log_skip("telefone inválido", idx=idx, msg_id=msg_id, remote_jid=remote_jid)
                    continue

                if me_number and telefone == me_number:
                    _log_skip("eco do meu número", idx=idx, msg_id=msg_id, telefone=telefone)
                    continue

                formatted = formatar_telefone_br(telefone)

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

                # n8n chatbot (só texto)
                try:
                    if _is_textual_content(conteudo):
                        _notify_n8n_chatbot(
                            empresa_id=empresa_id,
                            instancia_id=inst.id,
                            jid=remote_jid,
                            numero=telefone,
                            texto=conteudo,
                            direcao=direcao,
                        )
                except Exception as e:
                    LOG(f"[N8N][chatbot] erro ao enviar msg simples: {e}")

                # cliente
                try:
                    cli_id = (
                        db.query(models.Cliente.id)
                        .filter(models.Cliente.empresa_id == empresa_id, models.Cliente.telefone == telefone)
                        .scalar()
                    )
                except Exception as e:
                    LOG(f"[UPsert][erro select_cliente] idx={idx} msg_id={msg_id} err={e}")
                    try:
                        db.rollback()
                    except Exception:
                        pass
                    continue

                if not cli_id:
                    try:
                        cli_id = await _retry_deadlock(
                            db,
                            lambda: upsert_cliente(
                                db,
                                empresa_id=empresa_id,
                                instancia_id=inst.id,
                                telefone_raw=telefone,
                                nome=(formatted if from_me else (push_name or formatted)),
                                nome_whatsapp=(formatted if from_me else (push_name or formatted)),
                                avatar_url=None,
                            ),
                        )
                    except Exception as e:
                        LOG(f"[UPsert][erro upsert_cliente] idx={idx} msg_id={msg_id} err={e}")
                        try:
                            db.rollback()
                        except Exception:
                            pass
                        continue

                if not cli_id:
                    _log_skip("cli_id vazio (select+upsert)", idx=idx, msg_id=msg_id, telefone=telefone)
                    continue

                atendimento = None
                if _HAS_MSG_ATD_FIELD:
                    try:
                        atendimento = _get_or_open_atendimento(
                            db,
                            empresa_id=empresa_id,
                            instancia_id=inst.id,
                            cliente_id=cli_id,
                            direcao=direcao,
                            ts_dt=ts_msg,
                            operador_id=None,
                        )
                    except Exception as e:
                        LOG(f"[UPsert][erro_atendimento] idx={idx} msg_id={msg_id} err={e}")
                        try:
                            db.rollback()
                        except Exception:
                            pass
                        atendimento = None

                # ✅ 1:1 blindado: UPSERT ON CONFLICT DO NOTHING (sem select exists)
                msg_db_id = None
                inserted_11 = False

                if msg_id:
                    try:
                        sql = text(
                            """
                            INSERT INTO mensagens
                                (empresa_id, cliente_id, conteudo, tipo, lida, ack, timestamp, msg_id, instancia_id, atendimento_id)
                            VALUES
                                (:empresa_id, :cliente_id, :conteudo, :tipo, :lida, :ack, :timestamp, :msg_id, :instancia_id, :atendimento_id)
                            ON CONFLICT (empresa_id, cliente_id, msg_id)
                            WHERE msg_id IS NOT NULL
                            DO NOTHING
                            RETURNING id
                            """
                        )

                        row = db.execute(
                            sql,
                            {
                                "empresa_id": empresa_id,
                                "cliente_id": cli_id,
                                "conteudo": conteudo,
                                "tipo": direcao,
                                "lida": bool(from_me),
                                "ack": ack_value,  # ✅ FIX: nunca NULL
                                "timestamp": ts_msg,
                                "msg_id": str(msg_id),
                                "instancia_id": inst.id,
                                "atendimento_id": getattr(atendimento, "id", None),
                            },
                        ).fetchone()

                        if row:
                            msg_db_id = int(row[0])
                            novas += 1
                            inserted_11 = True

                            _log_ctx(
                                "[UPsert][saved-upsert]",
                                idx=idx,
                                msg_id=msg_id,
                                saved_id=msg_db_id,
                                tipo=direcao,
                                ack=ack_value,
                                ts=_iso_utc(ts_msg),
                                preview=_short(conteudo),
                            )
                        else:
                            _log_skip("duplicada (upsert)", idx=idx, msg_id=msg_id, cliente_id=cli_id)

                    except Exception as e:
                        LOG(f"[UPsert][erro upsert mensagem] idx={idx} msg_id={msg_id} err={e}")
                        try:
                            db.rollback()
                        except Exception:
                            pass
                        continue

                else:
                    # msg_id vazio → não tem como garantir dedup; salva normal
                    try:
                        msg_model = models.Mensagem(
                            empresa_id=empresa_id,
                            cliente_id=cli_id,
                            conteudo=conteudo,
                            tipo=direcao,
                            lida=from_me,
                            ack=ack_value,  # ✅ FIX: nunca NULL
                            timestamp=ts_msg,
                            msg_id=None,
                            instancia_id=inst.id,
                        )
                        if atendimento is not None and _HAS_MSG_ATD_FIELD:
                            setattr(msg_model, "atendimento_id", atendimento.id)

                        _carimbar_inst(msg_model, inst)
                        db.add(msg_model)
                        db.flush()
                        msg_db_id = msg_model.id
                        novas += 1
                        inserted_11 = True

                        _log_ctx(
                            "[UPsert][saved-nomsgid]",
                            idx=idx,
                            saved_id=msg_db_id,
                            tipo=direcao,
                            ts=_iso_utc(ts_msg),
                            preview=_short(conteudo),
                        )

                    except Exception as e:
                        LOG(f"[UPsert][erro ao salvar mensagem sem msg_id] idx={idx} err={e}")
                        try:
                            db.rollback()
                        except Exception:
                            pass
                        continue

                # WS (1:1) — emite só se inserted_11=True (evita duplicar no front)
                if inserted_11:
                    try:
                        cliente = _fetch_cliente(db, cli_id)

                        ws_payload = {
                            "empresa_id": empresa_id,
                            "cliente_id": cli_id,
                            "instancia_id": inst.id,
                            "instance_name": getattr(inst, "instance_name", None),
                            "atendimento_id": getattr(atendimento, "id", None),
                            "telefone": formatar_telefone_br(telefone),
                            "avatar_url": getattr(cliente, "avatar_url", None) if cliente else None,
                            "push_name": getattr(cliente, "nome_whatsapp", None) if cliente else None,
                            "nome": getattr(cliente, "nome", None) if cliente else formatted,
                            "mensagem": conteudo,
                            "tipo": direcao,
                            "origem": ("atendente" if from_me else "cliente"),
                            "timestamp": _iso_utc(ts_msg),
                            "msg_id": str(msg_id) if msg_id else (str(msg_db_id) if msg_db_id else None),
                            "ack": (ack_value if from_me else None),
                            "serverTimestamp": _server_ts_ms(),
                        }

                        await conexoes_ativas.send_message(f"emp:{empresa_id}", ws_payload)
                    except Exception as e:
                        LOG(f"[UPsert][ws] falha ao emitir: {e}")

                # commit por batch
                if novas and (novas % max(1, HISTORY_BATCH_COMMIT)) == 0:
                    try:
                        db.commit()
                        _log_ctx("[UPsert][commit]", count=novas)
                    except Exception as e:
                        try:
                            db.rollback()
                        except Exception:
                            pass
                        LOG(f"[UPsert][commit-erro] {e}")

                if (novas % 500) == 0:
                    await asyncio.sleep(0)

            except Exception as e:
                LOG(f"[UPsert] erro em mensagem idx={idx}: {e}")
                try:
                    db.rollback()
                except Exception:
                    pass
                continue

        try:
            db.commit()
            _log_ctx("[UPsert][commit-final]", novas=novas)
        except Exception as e:
            try:
                db.rollback()
            except Exception:
                pass
            LOG(f"[UPsert][commit-final-erro] {e}")

        try:
            if novas > 0 and empresa_id:
                _invalidate_emp_cache(empresa_id)
        except Exception:
            pass

        LOG(f"[UPsert] inst={inst_id} novas={novas}")




@handler(EvoEvent.MESSAGES_DELETE)
async def on_messages_delete(inst_id: str, data):
    mensagens = extract_messages_any_shape(data)
    _log_ctx("[DEL] batch", inst=inst_id, total=len(mensagens), type_data=type(data).__name__)

    to_notify: list[dict] = []
    inst_db_id: int | None = None
    empresa_id: int | None = None

    with SessionLocal() as db:
        inst = _get_inst_row(db, inst_id)
        if not inst:
            LOG(f"[DEL] instância não encontrada: {inst_id}")
            return

        inst_db_id = inst.id
        empresa_id = inst.empresa_id

        encontrados = 0
        alterados = 0

        for idx, m in enumerate(mensagens, start=1):
            try:
                if not isinstance(m, dict):
                    _log_ctx("[DEL][skip] m não é dict", idx=idx, type_m=type(m).__name__)
                    continue

                key = m.get("key") or {}
                msg_id = key.get("id") or m.get("id")
                from_me = bool(key.get("fromMe") if "fromMe" in key else (m.get("fromMe") or False))

                _log_ctx("[DEL][in]", idx=idx, msg_id=msg_id, from_me=from_me)

                if not msg_id:
                    _log_ctx("[DEL][skip] sem msg_id", idx=idx)
                    continue

                row = (
                    db.query(models.Mensagem)
                    .filter(models.Mensagem.instancia_id == inst.id, models.Mensagem.msg_id == msg_id)
                    .first()
                )

                if not row:
                    _log_ctx("[DEL][miss]", idx=idx, msg_id=msg_id)
                    continue

                encontrados += 1
                tipo = getattr(row, "tipo", None)

                apagou_cliente = False
                apagou_usuario = False

                if tipo == "entrada":
                    apagou_cliente = True
                elif tipo == "saida":
                    apagou_usuario = True
                else:
                    apagou_usuario = bool(from_me)
                    apagou_cliente = not bool(from_me)

                changed = False

                if apagou_cliente and not bool(getattr(row, "apagada_cliente", False)):
                    row.apagada_cliente = True
                    changed = True

                if apagou_usuario and not bool(getattr(row, "apagada_usuario", False)):
                    row.apagada_usuario = True
                    changed = True

                if changed:
                    alterados += 1
                    to_notify.append(
                        dict(
                            cliente_id=row.cliente_id,
                            msg_id=row.msg_id,
                            apagada_cliente=row.apagada_cliente,
                            apagada_usuario=row.apagada_usuario,
                        )
                    )

                    preview = (getattr(row, "conteudo", None) or getattr(row, "texto", "") or "")[:32]
                    _log_ctx(
                        "[DEL][hit]",
                        idx=idx,
                        msg_id=row.msg_id,
                        tipo=tipo,
                        apagada_cliente=row.apagada_cliente,
                        apagada_usuario=row.apagada_usuario,
                        preview=preview,
                    )
                else:
                    _log_ctx(
                        "[DEL][nochange]",
                        idx=idx,
                        msg_id=row.msg_id,
                        tipo=tipo,
                        apagada_cliente=row.apagada_cliente,
                        apagada_usuario=row.apagada_usuario,
                    )

            except Exception as e:
                _log_ctx("[DEL][err_msg]", idx=idx, exc=str(e))

        try:
            db.commit()
        except Exception as e:
            db.rollback()
            _log_ctx("[DEL][db_err]", exc=str(e))
            try:
                LOG(f"[DEL][db_err] inst={inst_id} exc={e}")
            except Exception:
                pass

    LOG(f"[DEL] concluído batch inst={inst_id} total={len(mensagens)} encontrados={encontrados} alterados={alterados}")

    if not to_notify or not empresa_id:
        return

    for item in to_notify:
        try:
            await conexoes_ativas.send_message(
                f"emp:{empresa_id}",
                {
                    "type": "msg_deleted",
                    "empresa_id": empresa_id,
                    "instancia_id": inst_db_id,
                    "instancia": inst_id,
                    "cliente_id": item["cliente_id"],
                    "msg_id": item["msg_id"],
                    "apagada_cliente": item["apagada_cliente"],
                    "apagada_usuario": item["apagada_usuario"],
                    "serverTimestamp": _server_ts_ms(),
                },
            )
        except Exception as e:
            LOG(f"[DEL][ws] erro ao notificar delete inst={inst_id} msg_id={item.get('msg_id')} err={e}")


_HISTORY_DONE_AT: dict[str, float] = {}


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

        empresa_id = inst.empresa_id
        historico_opcao = (inst.historico_restaurar or "none").lower()

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
                dias = (1 if historico_opcao == "24h" else (7 if historico_opcao == "7d" else 0))
                limite_tempo = _now_utc() - timedelta(days=dias)

            novas = 0
            me_num = _me_number_by_inst(inst)
            cap = max(1, int(HISTORY_MAX_IMPORT))

            _log_ctx("[HIST] janela/limites", limite_utc=_iso_utc(limite_tempo), cap=cap)

            try:
                RECENT_SEC = int(os.getenv("HISTORY_RECENT_WS_SEC", "120"))
            except Exception:
                RECENT_SEC = 120

            for idx, m in enumerate(mensagens, start=1):
                if novas >= cap:
                    _log_ctx("[HIST] cap atingido", novas=novas, cap=cap)
                    break

                if not isinstance(m, dict):
                    _log_ctx("[HIST][skip] m não é dict", idx=idx, type_m=type(m).__name__)
                    continue

                key = m.get("key") or {}
                remote_jid = (
                    key.get("remoteJid")
                    or key.get("remote_jid")
                    or m.get("remoteJid")
                    or m.get("jid")
                    or m.get("chatId")
                )
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

                if not remote_jid:
                    _log_ctx("[HIST][skip] sem remoteJid", idx=idx, msg_id=msg_id)
                    continue

                original_jid = remote_jid
                resolved_jid = _resolve_remote_jid(inst_id, remote_jid)

                if _is_lid_jid(original_jid) and not resolved_jid:
                    tel_fallback, _ = _resolve_counterparty_num_1to1(m, me_num)
                    _log_ctx("[HIST][lid-fallback]", idx=idx, msg_id=msg_id, tel_fallback=tel_fallback)
                    if tel_fallback:
                        resolved_jid = f"{tel_fallback}@s.whatsapp.net"
                        try:
                            _lid_map_set(empresa_id, inst.id, _jid_strip_device(original_jid), resolved_jid)
                        except Exception as e:
                            _log_ctx("[HIST][lid-cache-fail]", err=str(e))
                    else:
                        _log_ctx("[HIST][skip] @lid sem mapping", idx=idx, msg_id=msg_id)
                        continue

                remote_jid = resolved_jid or original_jid

                # GRUPO
                if remote_jid.endswith("@g.us"):
                    from_me = bool(key.get("fromMe", False))
                    author_j = (key.get("participant") or m.get("participant") or "")
                    conteudo = extract_text_from_baileys(m)
                    ts_int = _int_unix(ts_msg)

                    grupo = _grupo_row_by_remote(
                        db, empresa_id, _jid_strip_device(remote_jid), instancia_id=inst.id, inst_obj=inst
                    )

                    # ✅ NÃO usar pushName como nome do grupo (pushName é do participante)
                    # Se nome estiver ruim, tenta via findGroupInfos (cache)
                    try:
                        if _is_nome_grupo_ruim(getattr(grupo, "nome", None)):
                            subject = _evo_get_group_subject(getattr(inst, "instance_name", inst_id), _jid_strip_device(remote_jid))
                            if subject and (grupo.nome or "") != subject:
                                grupo.nome = subject
                    except Exception:
                        pass

                    avatar = _avatar_from_contact_like(m)
                    if avatar and (grupo.avatar_url or "") != avatar:
                        grupo.avatar_url = avatar
                    _carimbar_inst(grupo, inst)

                    if msg_id and db.query(models.MensagemGrupo.id).filter_by(grupo_id=grupo.id, msg_id=msg_id).first():
                        _log_ctx("[HIST][skip] duplicada (grupo)", idx=idx, msg_id=msg_id, grupo_id=grupo.id)
                        continue

                    def _ins_grupo():
                        msgg = models.MensagemGrupo(
                            empresa_id=empresa_id,
                            grupo_id=grupo.id,
                            author_jid=author_j,
                            from_me=from_me,
                            conteudo=conteudo,
                            message_type=m.get("messageType"),
                            lida=from_me,
                            timestamp=ts_int,
                            msg_id=msg_id,
                            ack=_ack_from_status(m.get("status")) if from_me else None,
                            instancia_id=inst.id,
                        )
                        _carimbar_inst(msgg, inst)
                        db.add(msgg)
                        db.flush()
                        return msgg.id

                    msgg_id = await _retry_deadlock(db, _ins_grupo)
                    novas += 1
                    _log_ctx(
                        "[HIST][saved][grupo]",
                        idx=idx,
                        msg_id=msg_id,
                        saved_id=msgg_id,
                        ts=_iso_utc(ts_msg),
                        preview=_short(conteudo),
                    )

                else:
                    # 1:1
                    telefone = _remote_to_num(remote_jid)
                    if not telefone:
                        _log_ctx("[HIST][skip] telefone inválido", idx=idx, msg_id=msg_id, remote_jid=remote_jid)
                        continue

                    from_me = bool(key.get("fromMe", False))
                    conteudo = extract_text_from_baileys(m)

                    media_meta = None if DISABLE_MEDIA_ON_HISTORY else extract_media_meta(m)

                    def _up():
                        return upsert_cliente(
                            db,
                            empresa_id=empresa_id,
                            instancia_id=inst.id,
                            telefone_raw=telefone,
                            nome=formatar_telefone_br(telefone),
                            nome_whatsapp=None,
                            avatar_url=None,
                        )

                    cli_id = await _retry_deadlock(db, _up)
                    if not cli_id:
                        _log_ctx("[HIST][skip] upsert_cliente None", idx=idx, msg_id=msg_id, telefone=telefone)
                        continue

                    if msg_id and db.query(models.Mensagem.id).filter_by(cliente_id=cli_id, msg_id=msg_id).first():
                        _log_ctx("[HIST][skip] duplicada (1:1)", idx=idx, msg_id=msg_id, cliente_id=cli_id)
                        continue

                    ack_initial = _ack_from_status(m.get("status"))
                    ack_initial = ack_initial if from_me else None

                    def _ins_msg():
                        msg_model = models.Mensagem(
                            empresa_id=empresa_id,
                            cliente_id=cli_id,
                            conteudo=conteudo,
                            tipo="saida" if from_me else "entrada",
                            lida=from_me,
                            ack=ack_initial,
                            timestamp=ts_msg,
                            msg_id=msg_id,
                            instancia_id=inst.id,
                        )
                        _carimbar_inst(msg_model, inst)
                        db.add(msg_model)
                        db.flush()
                        return msg_model.id

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

                    # WS-LIVE para mensagens recentes
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
                                    "tipo": "saida" if from_me else "entrada",
                                    "origem": "atendente" if from_me else "cliente",
                                    "timestamp": _iso_utc(ts_msg),
                                    "msg_id": (msg_id or str(msg_db_id)),
                                    "ack": (ack_initial if from_me else None),
                                    "serverTimestamp": int(_now_utc().timestamp() * 1000),
                                },
                            )
                        except Exception as e:
                            _log_ctx("[HIST][ws-live] falha ao emitir", idx=idx, msg_id=msg_id, err=str(e))

                    # MÍDIA
                    if media_meta:
                        try:
                            raw = None
                            real_name = media_meta.get("filename") or (f"{msg_id}.bin" if msg_id else "file")
                            real_ct = media_meta.get("mimetype")
                            real_len = None

                            if msg_id:
                                try:
                                    conv = True if (media_meta and media_meta.get("tipo") == "video") else None
                                    evo_raw, evo_name, evo_ct, evo_len = _evo_get_base64_media(
                                        inst_id, msg_id, convert_to_mp4=conv
                                    )
                                    raw, real_len = evo_raw, evo_len
                                    if evo_ct:
                                        real_ct = evo_ct
                                    if evo_name:
                                        real_name = evo_name
                                except Exception as e:
                                    _log_ctx("[HIST][midia] base64 falhou", idx=idx, msg_id=msg_id, err=str(e))

                            if raw is None:
                                b64 = media_meta.get("base64")
                                if b64:
                                    from .evo_handlers_extract import _b64_to_bytes
                                    raw, mt_from = _b64_to_bytes(b64)
                                    if mt_from:
                                        real_ct = mt_from
                                    real_len = len(raw) if raw else None

                            if raw is None and msg_id:
                                try:
                                    dl_bytes, dl_name, dl_ct, dl_len = _download_media_bytes(inst_id, msg_id, None)
                                    raw, real_len = dl_bytes, dl_len
                                    if dl_ct and dl_ct.lower() != "application/octet-stream":
                                        real_ct = dl_ct
                                    if dl_name and not dl_name.lower().endswith(".enc"):
                                        real_name = dl_name
                                except Exception as e:
                                    _log_ctx("[HIST][midia] download falhou", idx=idx, msg_id=msg_id, err=str(e))

                            if raw:
                                real_ct_norm = normalize_mimetype(media_meta["tipo"], real_name, real_ct)
                                _save_midia_db(
                                    db,
                                    empresa_id=empresa_id,
                                    cliente_id=cli_id,
                                    mensagem_id=msg_db_id,
                                    tipo=media_meta["tipo"],
                                    filename=real_name or "file",
                                    mimetype_=real_ct_norm,
                                    raw=raw,
                                    url_origem=None,
                                    content_length=real_len,
                                    instancia_id=inst.id,
                                )
                                _log_ctx(
                                    "[HIST][midia] salva",
                                    idx=idx,
                                    msg_id=msg_id,
                                    name=real_name,
                                    mimetype=real_ct_norm,
                                    size=real_len,
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
                            _log_ctx("[HIST] commit-deadlock-rollback]", err=str(e))
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
                    _log_ctx("[HIST] commit-final-deadlock-rollback]", err=str(e))
                else:
                    raise

            try:
                await conexoes_ativas.send_message(
                    f"emp:{empresa_id}", {"type": "reload_clientes", "serverTimestamp": _server_ts_ms()}
                )
            except Exception:
                pass
            try:
                await conexoes_ativas.send_message(
                    f"emp:{empresa_id}",
                    {"type": "history_sync_done", "total": total, "imported": novas, "serverTimestamp": _server_ts_ms()},
                )
            except Exception:
                pass

            try:
                _invalidate_emp_cache(empresa_id)
            except Exception:
                pass

            if historico_opcao != "none" and novas > 0:
                _HISTORY_DONE_AT[inst_id] = now_s

        finally:
            try:
                _release_hist_lock(db, empresa_id, inst.id)
            except Exception:
                pass


@handler(EvoEvent.MESSAGES_UPDATE)
async def on_messages_update(first: str, payload: dict | list):
    raw = payload
    data = raw["data"] if isinstance(raw, dict) and isinstance(raw.get("data"), (dict, list)) else raw
    updates = data if isinstance(data, list) else [data]
    if not updates or (len(updates) == 1 and not isinstance(updates[0], dict)):
        print("[ACK DEBUG] MESSAGES_UPDATE sem updates válidos.")
        return

    emp_id: int | None = None
    inst_name: str | None = None
    params: list[dict] = []
    cli_by_msg: dict[str, int] = {}

    with SessionLocal() as db:
        try:
            inst_name = (payload.get("instance") if isinstance(payload, dict) else None) or first
            if inst_name:
                emp_id = _empresa_id_by_inst(db, inst_name)
        except Exception as e:
            print(f"[ACK DEBUG] Falha resolvendo empresa: {e}")

        for u in updates:
            if not isinstance(u, dict):
                continue
            key_id = (u.get("keyId") or (u.get("key") or {}).get("id") or u.get("messageId"))
            status = u.get("status") or u.get("ack")
            new_ack = _ack_from_status(status)
            if key_id and new_ack > 0:
                p = {"msg_id": str(key_id), "new_ack": int(new_ack)}
                if emp_id:
                    p["emp_id"] = int(emp_id)
                params.append(p)

        if not params:
            return

        where = "msg_id = :msg_id AND tipo = 'saida'"
        if emp_id:
            where += " AND empresa_id = :emp_id"

        try:
            db.execute(
                text(
                    f"""
                    UPDATE mensagens
                       SET ack = CASE
                                   WHEN COALESCE(ack, 0) < :new_ack THEN :new_ack
                                   ELSE ack
                                 END
                     WHERE {where}
                    """
                ),
                params,
            )
            db.commit()
        except Exception as e:
            print(f"[ACK DEBUG] Erro no UPDATE de ACKs: {e}")
            return

        try:
            if emp_id:
                _invalidate_emp_cache(int(emp_id))
        except Exception:
            pass

        try:
            msg_ids = tuple({p["msg_id"] for p in params})
            if msg_ids:
                base = "SELECT msg_id, cliente_id FROM mensagens WHERE msg_id IN :ids"
                args = {"ids": list(msg_ids)}
                if emp_id:
                    base += " AND empresa_id = :emp_id"
                    args["emp_id"] = int(emp_id)

                q = text(base).bindparams(bindparam("ids", expanding=True))
                rows = db.execute(q, args).fetchall()
                for r in rows or []:
                    try:
                        mid, cid = str(r[0]), int(r[1]) if r[1] is not None else None
                        if mid and cid:
                            cli_by_msg[mid] = cid
                    except Exception:
                        continue
        except Exception as e:
            print(f"[ACK DEBUG] Falha buscando cliente_id por msg_id: {e}")

    targets = []
    if inst_name:
        targets.append(f"inst:{inst_name}")
    if emp_id:
        targets.append(f"emp:{emp_id}")
    if not targets:
        return

    for p in params:
        payload_ws = {
            "type": "ack",
            "msg_id": p["msg_id"],
            "ack": p["new_ack"],
            "cliente_id": cli_by_msg.get(p["msg_id"]),
            "serverTimestamp": _server_ts_ms(),
        }
        for target in targets:
            try:
                await conexoes_ativas.send_message(target, payload_ws)
            except Exception as e:
                print(f"[ACK DEBUG] Falha ao emitir WS para {target}: {e}")


@handler(EvoEvent.PRESENCE_UPDATE)
async def on_presence_update(first: str, payload: dict | list):
    record_rabbit_event("PRESENCE_UPDATE", _inst_from(payload) or first)


@handler(EvoEvent.CONTACTS_UPSERT)
@handler(EvoEvent.CONTACTS_UPDATE)
@handler(EvoEvent.CONTACTS_SET)
async def on_contacts_event(first: str, payload: dict | list):
    if isinstance(payload, list):
        norm = {"data": payload, "instance": first}
    elif isinstance(payload, dict):
        norm = payload if "data" in payload else {"data": payload, "instance": first}
    else:
        norm = {"data": [payload], "instance": first}

    inst_id = (_inst_from(norm) or first)
    record_rabbit_event("CONTACTS_UPDATE", inst_id)

    data = norm.get("data")
    contatos = extract_contacts_any_shape(data)
    if not contatos:
        return

    with SessionLocal() as db:
        inst = _get_inst_row(db, inst_id)
        if not inst:
            return
        empresa_id = inst.empresa_id

        me_num = _me_number_by_inst(inst)
        mudou = False
        processed = 0

        for c in contatos:
            if not isinstance(c, dict):
                continue

            remote = (c.get("remoteJid") or c.get("id") or c.get("wid") or "")

            if isinstance(remote, str) and remote.endswith("@lid"):
                mapped = _resolve_remote_jid(inst_id, remote)
                if mapped:
                    remote = mapped
                else:
                    try:
                        rd = _lid_map_get(empresa_id, inst.id, _jid_strip_device(remote))
                        if rd:
                            remote = rd
                    except Exception:
                        pass

            numero = _remote_to_num(remote)
            if not numero or (me_num and numero == me_num):
                continue

            nome_push = _name_from_contact_like(c)
            avatar = _avatar_from_contact_like(c)
            nome_default = nome_push or formatar_telefone_br(numero)

            try:
                cli_id = await _retry_deadlock(
                    db,
                    lambda: upsert_cliente(
                        db,
                        empresa_id=empresa_id,
                        instancia_id=inst.id,
                        telefone_raw=numero,
                        nome=nome_default,
                        nome_whatsapp=nome_push,
                        avatar_url=avatar,
                    ),
                )
                if cli_id:
                    mudou = True
            except Exception as e:
                try:
                    db.rollback()
                except Exception:
                    pass
                print(f"[CONTACTS] erro no upsert_cliente: {e}")
                continue

            processed += 1
            if (processed % 500) == 0:
                await asyncio.sleep(0)

        if mudou:
            try:
                db.commit()
            except Exception as e:
                if _is_deadlock_error(e):
                    try:
                        db.rollback()
                    except Exception:
                        pass
                else:
                    raise

            await conexoes_ativas.send_message(
                f"emp:{empresa_id}", {"type": "reload_clientes", "serverTimestamp": _server_ts_ms()}
            )
            try:
                _invalidate_emp_cache(empresa_id)
            except Exception:
                pass


async def _sync_contatos_completos(inst_id: str):
    with SessionLocal() as db:
        inst = _get_inst_row(db, inst_id)
        if not inst:
            return
        empresa_id = inst.empresa_id

        contatos = []
        try:
            url = f"{EVOLUTION_URL}/chat/findContacts/{inst_id}"
            r = requests.post(url, headers=HEADERS, json={"where": {}}, timeout=60)
            LOG(f"[CONTACTS] POST {url} -> {r.status_code}")
            if r.status_code in (200, 201):
                js = r.json()
                contatos = extract_contacts_any_shape(js) or ([js] if isinstance(js, dict) else [])
        except Exception as e:
            LOG(f"[CONTACTS] erro ao buscar: {e}")
            return

        total = len(contatos)
        imported = 0
        await conexoes_ativas.send_message(
            f"emp:{empresa_id}",
            {"type": "contacts_sync_start", "total": total, "serverTimestamp": _server_ts_ms()},
        )

        me_num = _me_number_by_inst(inst)
        mudou = False

        for idx, c in enumerate(contatos, start=1):
            remote = (c.get("remoteJid") or c.get("id") or c.get("wid") or "")
            if isinstance(remote, str) and remote.endswith("@lid"):
                mapped = _resolve_remote_jid(inst_id, remote)
                if mapped:
                    remote = mapped
                else:
                    try:
                        rd = _lid_map_get(empresa_id, inst.id, _jid_strip_device(remote))
                        if rd:
                            remote = rd
                    except Exception:
                        pass

            numero = _remote_to_num(remote)
            if not numero or (me_num and numero == me_num):
                continue

            nome_push = _name_from_contact_like(c)
            avatar = _avatar_from_contact_like(c)
            nome_default = nome_push or formatar_telefone_br(numero)

            cli_id = upsert_cliente(
                db,
                empresa_id=empresa_id,
                instancia_id=inst.id,
                telefone_raw=numero,
                nome=nome_default,
                nome_whatsapp=nome_push,
                avatar_url=avatar,
            )
            if cli_id:
                imported += 1
                mudou = True

            if idx % 25 == 0:
                await conexoes_ativas.send_message(
                    f"emp:{empresa_id}",
                    {
                        "type": "contacts_sync_progress",
                        "total": total,
                        "imported": imported,
                        "serverTimestamp": _server_ts_ms(),
                    },
                )

        if mudou:
            db.commit()

        await conexoes_ativas.send_message(
            f"emp:{empresa_id}",
            {"type": "contacts_sync_done", "total": total, "imported": imported, "serverTimestamp": _server_ts_ms()},
        )
        await conexoes_ativas.send_message(
            f"emp:{empresa_id}", {"type": "reload_clientes", "serverTimestamp": _server_ts_ms()}
        )

        try:
            _invalidate_emp_cache(empresa_id)
        except Exception:
            pass


async def _sync_chats_completos(inst_id: str):
    with SessionLocal() as db:
        inst = _get_inst_row(db, inst_id)
        if not inst:
            return
        empresa_id = inst.empresa_id

        chats = []
        try:
            url = f"{EVOLUTION_URL}/chat/findChats/{inst_id}"
            r = requests.post(url, headers=HEADERS, json={"where": {}}, timeout=60)
            LOG(f"[CHATS] POST {url} -> {r.status_code}")
            if r.status_code in (200, 201):
                js = r.json()
                chats = extract_chats_any_shape(js)
        except Exception as e:
            LOG(f"[CHATS] erro ao buscar: {e}")

        if not chats:
            return

        before = db.query(models.Grupo).filter(models.Grupo.empresa_id == empresa_id).count()
        _upsert_grupos_from_chats(db, empresa_id, chats, inst)
        db.commit()
        after = db.query(models.Grupo).filter(models.Grupo.empresa_id == empresa_id).count()
        if after != before:
            await conexoes_ativas.send_message(
                f"emp:{empresa_id}",
                {"type": "reload_grupos", "total": after, "serverTimestamp": _server_ts_ms()},
            )


# =========================
# Forçar QR no WS (usado pelo main)
# =========================
async def force_qr_now_async(inst_id: str):
    if not EVOLUTION_FORCE_QR_ON_WS:
        return
    if not qr_force_lock_acquire(inst_id, ttl_sec=3):
        LOG(f"[QR WS] force_qr ignorado por lock (inst={inst_id})")
        return
    try:
        js = await asyncio.to_thread(_evo_connect, inst_id)
        if isinstance(js, dict):
            b64, pc, limit = _extract_qr_fields(js)
            if b64 or pc:
                try:
                    QR_RECENT[inst_id] = _int_unix(_now_utc())
                except Exception:
                    pass
                await _emit_qr(inst_id, b64, pc, limit)
    except Exception as e:
        LOG(f"[QR WS] falha ao forçar QR: {e}")


async def force_qr_for_instance(inst_id: str):
    return await force_qr_now_async(inst_id)


# =========================
# Rebinds/export
# =========================
HANDLERS[EvoEvent.MESSAGES_UPSERT] = on_messages_upsert
HANDLERS[EvoEvent.MESSAGES_UPDATE] = on_messages_update
HANDLERS[EvoEvent.CONTACTS_SET] = on_contacts_event
HANDLERS[EvoEvent.CONTACTS_UPDATE] = on_contacts_event
HANDLERS[EvoEvent.CONTACTS_UPSERT] = on_contacts_event

__all__ = [
    "HANDLERS",
    "EvoEvent",
    "handler",
    "force_qr_for_instance",
    "normalize_mimetype",
    "RABBIT_MONITOR",
    "record_rabbit_event",
    "get_rabbit_monitor",
]
