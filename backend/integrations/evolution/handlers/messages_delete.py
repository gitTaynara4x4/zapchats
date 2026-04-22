# backend/integrations/evolution/handlers/messages_delete.py


from __future__ import annotations

from backend.database import SessionLocal
from backend import models
from backend.websocket_manager import conexoes_ativas

from ..parsers.base_extractors import extract_messages_any_shape
from ..repositories.instancias_repo import get_instancia_by_name
from ..utils.log_utils import LOG, _log_ctx
from ..utils.time_utils import _server_ts_ms
from .shared import EvoEvent, handler


@handler(EvoEvent.MESSAGES_DELETE)
async def on_messages_delete(inst_id: str, data):
    mensagens = extract_messages_any_shape(data)
    _log_ctx("[DEL] batch", inst=inst_id, total=len(mensagens), type_data=type(data).__name__)

    to_notify: list[dict] = []
    empresa_id: int | None = None

    with SessionLocal() as db:
        inst = get_instancia_by_name(db, instance_name=inst_id)
        if not inst:
            LOG(f"[DEL] instância não encontrada: {inst_id}")
            return

        empresa_id = int(inst.empresa_id)

        encontrados = 0
        alterados = 0

        for idx, m in enumerate(mensagens, start=1):
            try:
                if not isinstance(m, dict):
                    _log_ctx("[DEL][skip] m não é dict", idx=idx, type_m=type(m).__name__)
                    continue

                key_id = ((m.get("key") or {}).get("id")) or m.get("id") or m.get("messageId")
                from_me = bool(((m.get("key") or {}).get("fromMe")) if "key" in m else (m.get("fromMe") or False))

                _log_ctx("[DEL][in]", idx=idx, msg_id=key_id, from_me=from_me)

                if not key_id:
                    _log_ctx("[DEL][skip] sem msg_id", idx=idx)
                    continue

                row = (
                    db.query(models.Mensagem)
                    .filter(models.Mensagem.instancia_id == inst.id, models.Mensagem.msg_id == key_id)
                    .first()
                )

                if not row:
                    _log_ctx("[DEL][miss]", idx=idx, msg_id=key_id)
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
            return

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
                    "cliente_id": item["cliente_id"],
                    "msg_id": item["msg_id"],
                    "apagada_cliente": item["apagada_cliente"],
                    "apagada_usuario": item["apagada_usuario"],
                    "serverTimestamp": _server_ts_ms(),
                },
            )
        except Exception as e:
            _log_ctx("[DEL][ws_err]", msg_id=item.get("msg_id"), exc=str(e))


__all__ = [
    "on_messages_delete",
]