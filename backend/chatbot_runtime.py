# backend/chatbot_runtime.py
from __future__ import annotations

import re
from typing import Any, Dict, Optional

from backend.database import SessionLocal
from backend import models

try:
    from backend.routers.chatbot_setores import (
        auto_messages_handle_inbound,
        triagem_handle_inbound,
        _resolve_emp_inst_from_instance_name,
    )
except Exception:  # pragma: no cover
    auto_messages_handle_inbound = None  # type: ignore
    triagem_handle_inbound = None  # type: ignore
    _resolve_emp_inst_from_instance_name = None  # type: ignore


def _digits(s: str) -> str:
    return re.sub(r"\D", "", s or "")


def _resolve_instancia_id(db, *, empresa_id: int, cliente: models.Cliente, payload: Dict[str, Any]) -> int:
    raw = payload.get("instancia_id") or payload.get("instance_id")
    try:
        if raw:
            return int(raw)
    except Exception:
        pass

    try:
        if getattr(cliente, "instancia_id", None):
            return int(cliente.instancia_id)
    except Exception:
        pass

    instance_name = str(payload.get("instancia") or payload.get("instance_name") or "").strip()
    if instance_name and _resolve_emp_inst_from_instance_name:
        try:
            inst_id, emp_id = _resolve_emp_inst_from_instance_name(db, instance_name)
            if int(emp_id or 0) == int(empresa_id or 0):
                return int(inst_id or 0)
        except Exception:
            return 0

    return 0


def _remote_jid(payload: Dict[str, Any], telefone_digits: str) -> str:
    jid = str(payload.get("jid") or payload.get("remote_jid") or "").strip()
    if jid:
        return jid
    tel = _digits(telefone_digits)
    if len(tel) == 11 and not tel.startswith("55"):
        tel = "55" + tel
    return f"{tel}@s.whatsapp.net" if tel else ""


def _should_try_auto_after_triage(action: str) -> bool:
    return action in {
        "noop_triagem_disabled",
        "noop_triagem_welcome_disabled",
        "noop_triage_blocked",
        "noop_invalid",
    }


async def on_incoming(payload: Dict[str, Any]):
    """
    Compatibilidade com o runtime antigo.

    Antes este arquivo montava/enviava menu sozinho e podia ignorar o OFF da tela.
    Agora ele só delega para backend.routers.chatbot_setores, que busca
    chatbot_configs por empresa_id + instancia_id + ativo=True.
    """
    if not payload or not isinstance(payload, dict):
        return

    tipo = str(payload.get("tipo") or payload.get("direction") or "").lower()
    if tipo == "saida":
        return

    empresa_id = int(payload.get("empresa_id") or 0)
    cliente_id = int(payload.get("cliente_id") or 0)
    texto = str(payload.get("texto") or payload.get("mensagem") or "").strip()

    if not empresa_id or not cliente_id or not texto:
        return

    if not triagem_handle_inbound or not auto_messages_handle_inbound:
        return

    with SessionLocal() as db:
        cliente: Optional[models.Cliente] = (
            db.query(models.Cliente)
            .filter_by(id=cliente_id, empresa_id=empresa_id)
            .first()
        )
        if not cliente:
            return

        instancia_id = _resolve_instancia_id(db, empresa_id=empresa_id, cliente=cliente, payload=payload)
        if not instancia_id:
            return

        telefone = _digits(
            str(
                payload.get("numero")
                or payload.get("telefone")
                or getattr(cliente, "telefone", "")
                or ""
            )
        )
        if not telefone:
            return

        remote_jid = _remote_jid(payload, telefone)

        triage_res = triagem_handle_inbound(
            db,
            empresa_id=empresa_id,
            instancia_id=instancia_id,
            telefone_digits=telefone,
            texto=texto,
            direction=tipo,
            remote_jid=remote_jid,
        )

        action = str((triage_res or {}).get("action") or "")
        if _should_try_auto_after_triage(action):
            auto_messages_handle_inbound(
                db,
                empresa_id=empresa_id,
                instancia_id=instancia_id,
                telefone_digits=telefone,
                texto=texto,
                direction=tipo,
                remote_jid=remote_jid,
            )
