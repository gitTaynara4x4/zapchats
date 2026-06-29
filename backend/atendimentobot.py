# backend/atendimentobot.py
from __future__ import annotations

import os
import re
from typing import Any, Dict

from dotenv import load_dotenv
from fastapi import HTTPException

from backend import models

load_dotenv()

# Mantido apenas para não quebrar imports antigos.
# Não use este arquivo para disparar chatbot novo.
EVOLUTION_URL = os.getenv("EVOLUTION_URL")
EVOLUTION_APIKEY = os.getenv("EVOLUTION_APIKEY")
HEADERS = {"apikey": EVOLUTION_APIKEY, "Content-Type": "application/json"} if EVOLUTION_APIKEY else {}

MENU_SETORES = "*Atendimento ZapsChat 🤖*\nDigite o número do setor desejado:\n\n"


def _digits(s: str) -> str:
    return re.sub(r"\D", "", s or "")


def _remote_jid_from_cliente(cliente) -> str:
    tel = _digits(str(getattr(cliente, "telefone", "") or ""))
    if len(tel) == 11 and not tel.startswith("55"):
        tel = "55" + tel
    return f"{tel}@s.whatsapp.net" if tel else ""


def _resolve_instancia_id(db, empresa, cliente) -> int:
    try:
        if getattr(cliente, "instancia_id", None):
            return int(cliente.instancia_id)
    except Exception:
        pass

    instance_name = str(
        getattr(empresa, "instance_name", None)
        or getattr(empresa, "instancia_nome", None)
        or ""
    ).strip()

    if not instance_name:
        return 0

    try:
        from backend.routers.chatbot_setores import _resolve_emp_inst_from_instance_name

        inst_id, emp_id = _resolve_emp_inst_from_instance_name(db, instance_name)
        if int(emp_id or 0) == int(getattr(empresa, "id", 0) or 0):
            return int(inst_id or 0)
    except Exception:
        return 0

    return 0


async def enviar_menu_se_novo_ou_24h(db, empresa, cliente, conexoes_ativas=None, HEADERS=None, EVOLUTION_URL=None):
    """
    Compatibilidade com código antigo.

    Antes esta função enviava menu direto pela Evolution sem olhar a tela do chatbot.
    Agora ela delega para o runtime novo, que só envia se chatbot_configs.ativo=True
    e se o modo por departamento estiver realmente ligado para a instância.
    """
    try:
        from backend.routers.chatbot_setores import triagem_handle_inbound
    except Exception:
        return {"ok": True, "action": "noop_legacy_runtime_unavailable"}

    empresa_id = int(getattr(empresa, "id", 0) or 0)
    instancia_id = _resolve_instancia_id(db, empresa, cliente)
    telefone = _digits(str(getattr(cliente, "telefone", "") or ""))

    if not empresa_id or not instancia_id or not telefone:
        return {"ok": True, "action": "noop_legacy_invalid"}

    return triagem_handle_inbound(
        db,
        empresa_id=empresa_id,
        instancia_id=instancia_id,
        telefone_digits=telefone,
        texto="oi",
        direction="entrada",
        remote_jid=_remote_jid_from_cliente(cliente),
    )


async def redirecionar_para_atendente(db, empresa, cliente, setor_id, conexoes_ativas=None):
    """
    Compatibilidade com fluxo velho de setores.
    O fluxo novo usa departamentos/filas pelo backend.routers.chatbot_setores.
    """
    setor = db.query(models.Setor).filter_by(id=setor_id, empresa_id=empresa.id).first()
    if not setor:
        raise HTTPException(status_code=404, detail="Setor não encontrado")

    colaborador = db.query(models.Colaborador).filter_by(setor_id=setor.id).first()
    if not colaborador:
        raise HTTPException(status_code=404, detail="Colaborador não encontrado para o setor.")

    # Não envia mensagem pela Evolution aqui. Evita disparo fantasma do bot antigo.
    return {
        "ok": True,
        "action": "legacy_redirect_no_send",
        "setor_id": int(setor.id),
        "colaborador_id": int(colaborador.id),
    }
