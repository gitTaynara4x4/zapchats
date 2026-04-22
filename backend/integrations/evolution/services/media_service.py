#backend\integrations\evolution\services\media_service.py


from __future__ import annotations
from sqlalchemy.orm import Session
from backend import models
from backend.database import SessionLocal

from ..parsers.media_parser import normalize_mimetype, _b64_to_bytes
from ..transport.evolution_http_client import evo_download_media_bytes, evo_get_base64_media
from ..utils.log_utils import LOG, _log_ctx


def _save_midia_db(
    db: Session,
    *,
    empresa_id: int,
    cliente_id: int | None,
    mensagem_id: int | None,
    tipo: str,
    filename: str,
    mimetype_: str,
    raw: bytes,
    url_origem: str | None = None,
    content_length: int | None = None,
    instancia_id: int | None = None,
    grupo_id: int | None = None,
):
    midia = models.Midia(
        empresa_id=empresa_id,
        cliente_id=cliente_id,
        grupo_id=grupo_id,
        mensagem_id=mensagem_id,
        tipo=tipo,
        filename=filename,
        mimetype=mimetype_,
        data=raw,
        tamanho=content_length,
        instancia_id=instancia_id,
    )
    db.add(midia)
    db.flush()
    return midia


def _resolve_media_bytes(
    *,
    inst_id: str,
    msg_id: str | None,
    media_meta: dict,
    idx: int,
):
    raw = None
    real_name = media_meta.get("filename") or (f"{msg_id}.bin" if msg_id else "file")
    real_ct = media_meta.get("mimetype")
    real_len = None

    if msg_id:
        try:
            convert_to_mp4 = True if (media_meta.get("tipo") == "video") else None
            evo_raw, evo_name, evo_ct, evo_len = evo_get_base64_media(
                inst_id,
                msg_id,
                convert_to_mp4=convert_to_mp4,
            )
            raw, real_len = evo_raw, evo_len
            if evo_ct:
                real_ct = evo_ct
            if evo_name:
                real_name = evo_name
        except Exception as e:
            _log_ctx("[MEDIA] base64 falhou", idx=idx, msg_id=msg_id, err=str(e))

    if raw is None:
        b64 = media_meta.get("base64")
        if b64:
            try:
                raw, mt_from = _b64_to_bytes(b64)
                if mt_from:
                    real_ct = mt_from
                real_len = len(raw) if raw else None
            except Exception as e:
                _log_ctx("[MEDIA] b64 inline falhou", idx=idx, msg_id=msg_id, err=str(e))

    if raw is None and msg_id:
        try:
            dl_bytes, dl_name, dl_ct, dl_len = evo_download_media_bytes(inst_id, msg_id, timeout=120)
            raw, real_len = dl_bytes, dl_len
            if dl_ct and dl_ct.lower() != "application/octet-stream":
                real_ct = dl_ct
            if dl_name and not dl_name.lower().endswith(".enc"):
                real_name = dl_name
        except Exception as e:
            _log_ctx("[MEDIA] download falhou", idx=idx, msg_id=msg_id, err=str(e))

    return raw, real_name, real_ct, real_len


def save_media_for_message_11_with_db(
    db: Session,
    *,
    inst_id: str,
    empresa_id: int,
    cliente_id: int,
    mensagem_id: int,
    msg_id: str | None,
    media_meta: dict,
    instancia_id: int,
    idx: int = 0,
) -> bool:
    try:
        raw, real_name, real_ct, real_len = _resolve_media_bytes(
            inst_id=inst_id,
            msg_id=msg_id,
            media_meta=media_meta,
            idx=idx,
        )

        if not raw:
            return False

        real_ct_norm = normalize_mimetype(media_meta["tipo"], real_name, real_ct)

        _save_midia_db(
            db,
            empresa_id=empresa_id,
            cliente_id=cliente_id,
            mensagem_id=mensagem_id,
            tipo=media_meta["tipo"],
            filename=real_name or "file",
            mimetype_=real_ct_norm,
            raw=raw,
            url_origem=None,
            content_length=real_len,
            instancia_id=instancia_id,
        )

        _log_ctx(
            "[MEDIA][1:1] salva",
            idx=idx,
            msg_id=msg_id,
            mensagem_id=mensagem_id,
            tipo=media_meta["tipo"],
            name=real_name,
            mimetype=real_ct_norm,
            size=real_len,
            instancia_id=instancia_id,
        )
        return True

    except Exception as e:
        LOG(f"[MEDIA][1:1] erro ao salvar: {e}")
        return False


async def save_media_for_message_11(
    *,
    inst_id: str,
    empresa_id: int,
    cliente_id: int,
    mensagem_id: int,
    msg_id: str | None,
    media_meta: dict,
    instancia_id: int,
    idx: int = 0,
) -> bool:
    with SessionLocal() as db:
        try:
            ok = save_media_for_message_11_with_db(
                db,
                inst_id=inst_id,
                empresa_id=empresa_id,
                cliente_id=cliente_id,
                mensagem_id=mensagem_id,
                msg_id=msg_id,
                media_meta=media_meta,
                instancia_id=instancia_id,
                idx=idx,
            )
            if ok:
                db.commit()
            else:
                db.rollback()
            return ok
        except Exception:
            try:
                db.rollback()
            except Exception:
                pass
            return False


def save_media_for_group_message_with_db(
    db: Session,
    *,
    inst_id: str,
    empresa_id: int,
    grupo_id: int,
    cliente_id: int | None,
    msg_id: str | None,
    media_meta: dict,
    instancia_id: int,
    idx: int = 0,
) -> bool:
    try:
        raw, real_name, real_ct, real_len = _resolve_media_bytes(
            inst_id=inst_id,
            msg_id=msg_id,
            media_meta=media_meta,
            idx=idx,
        )

        if not raw:
            return False

        real_ct_norm = normalize_mimetype(media_meta["tipo"], real_name, real_ct)

        ja_tem = (
            db.query(models.Midia.id)
            .filter(
                models.Midia.empresa_id == empresa_id,
                models.Midia.grupo_id == grupo_id,
                models.Midia.filename == (real_name or "file"),
                models.Midia.tipo == media_meta["tipo"],
            )
            .first()
        )
        if ja_tem:
            _log_ctx(
                "[MEDIA][GRUPO] já existia",
                idx=idx,
                msg_id=msg_id,
                grupo_id=grupo_id,
                name=real_name,
                tipo=media_meta["tipo"],
            )
            return True

        _save_midia_db(
            db,
            empresa_id=empresa_id,
            cliente_id=cliente_id,
            grupo_id=grupo_id,
            mensagem_id=None,
            tipo=media_meta["tipo"],
            filename=real_name or "file",
            mimetype_=real_ct_norm,
            raw=raw,
            url_origem=None,
            content_length=real_len,
            instancia_id=instancia_id,
        )

        _log_ctx(
            "[MEDIA][GRUPO] salva",
            idx=idx,
            msg_id=msg_id,
            grupo_id=grupo_id,
            cliente_id=cliente_id,
            tipo=media_meta["tipo"],
            name=real_name,
            mimetype=real_ct_norm,
            size=real_len,
            instancia_id=instancia_id,
        )
        return True

    except Exception as e:
        LOG(f"[MEDIA][GRUPO] erro ao salvar: {e}")
        return False


async def save_media_for_group_message(
    *,
    inst_id: str,
    empresa_id: int,
    grupo_id: int,
    cliente_id: int | None,
    msg_id: str | None,
    media_meta: dict,
    instancia_id: int,
    idx: int = 0,
) -> bool:
    with SessionLocal() as db:
        try:
            ok = save_media_for_group_message_with_db(
                db,
                inst_id=inst_id,
                empresa_id=empresa_id,
                grupo_id=grupo_id,
                cliente_id=cliente_id,
                msg_id=msg_id,
                media_meta=media_meta,
                instancia_id=instancia_id,
                idx=idx,
            )
            if ok:
                db.commit()
            else:
                db.rollback()
            return ok
        except Exception:
            try:
                db.rollback()
            except Exception:
                pass
            return False


__all__ = [
    "save_media_for_message_11",
    "save_media_for_message_11_with_db",
    "save_media_for_group_message",
    "save_media_for_group_message_with_db",
]