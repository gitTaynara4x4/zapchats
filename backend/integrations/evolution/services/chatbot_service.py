#backend\integrations\evolution\services\chatbot_service.py

from __future__ import annotations

import os
import time

from backend.database import SessionLocal
from backend.routers.chatbot_setores import triagem_handle_inbound

try:
    from backend.routers.chatbot_setores import auto_messages_handle_inbound
except ImportError:
    auto_messages_handle_inbound = None

from ..utils.log_utils import LOG


_CHATBOT_MSG_SEEN: dict[str, float] = {}
_CHATBOT_MSG_TTL_SECONDS = float(os.getenv("CHATBOT_MSG_TTL_SECONDS", "120"))


def chatbot_seen_key(empresa_id: int, instancia_id: int, msg_id: str) -> str:
    return f"{int(empresa_id)}:{int(instancia_id)}:{str(msg_id).strip()}"


def _cleanup_chatbot_seen_cache() -> None:
    now_ts = time.time()
    for k, ts in list(_CHATBOT_MSG_SEEN.items()):
        if (now_ts - float(ts)) > _CHATBOT_MSG_TTL_SECONDS:
            _CHATBOT_MSG_SEEN.pop(k, None)


def chatbot_should_process_msg(empresa_id: int, instancia_id: int, msg_id: str | None) -> bool:
    raw = str(msg_id or "").strip()
    if not raw:
        return True

    _cleanup_chatbot_seen_cache()

    key = chatbot_seen_key(empresa_id, instancia_id, raw)
    if key in _CHATBOT_MSG_SEEN:
        return False

    _CHATBOT_MSG_SEEN[key] = time.time()
    return True


def _is_textual_content(conteudo: str | None) -> bool:
    return bool(str(conteudo or "").strip())


async def run_chatbot_for_inbound(
    *,
    empresa_id: int,
    instancia_id: int,
    telefone: str,
    conteudo: str,
    direcao: str,
    remote_jid: str,
):
    if not conteudo or direcao != "entrada" or not _is_textual_content(conteudo):
        return {"ok": False, "reason": "skip_non_textual"}

    with SessionLocal() as db_triagem:
        try:
            auto_res = None

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
                    return auto_res

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
            return triagem_res

        except Exception as e:
            try:
                db_triagem.rollback()
            except Exception:
                pass
            LOG(f"[CHATBOT] erro ao processar inbound do chatbot: {e}")
            return {"ok": False, "error": str(e)}


__all__ = [
    "chatbot_should_process_msg",
    "run_chatbot_for_inbound",
]