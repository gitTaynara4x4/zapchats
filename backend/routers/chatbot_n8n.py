# backend/routers/chatbot_n8n.py
from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session

from backend.database import get_db
from backend import models

router = APIRouter(prefix="/api/chatbot-n8n", tags=["Chatbot / N8N"])


class ChatbotN8NIn(BaseModel):
    instancia: str
    telefone: str
    texto: str


class ChatbotN8NOut(BaseModel):
    responder: bool
    mensagem: str | None = None


@router.post("/decidir-resposta", response_model=ChatbotN8NOut)
def decidir_resposta(payload: ChatbotN8NIn, db: Session = Depends(get_db)):
    """
    Aqui você usa O QUE JÁ TEM no BD do chatbot:
    - tabela/configuração que alimenta essa tela de boas-vindas
    - horários de atendimento, etc.
    """
    # Exemplo: achar instância -> empresa_id
    inst = (
        db.query(models.InstanciaWhatsapp)
        .filter(models.InstanciaWhatsapp.instance_name == payload.instancia)
        .first()
    )
    if not inst:
        return ChatbotN8NOut(responder=False, mensagem=None)

    empresa_id = inst.empresa_id

    # EXEMPLO genérico de onde buscar as mensagens.
    # Troca "ChatbotConfig" e campos pelos que você já tem.
    cfg = (
        db.query(models.ChatbotConfig)
        .filter(
            models.ChatbotConfig.empresa_id == empresa_id,
            models.ChatbotConfig.instancia_id == inst.id,
        )
        .first()
    )
    if not cfg or not cfg.habilitado:
        return ChatbotN8NOut(responder=False, mensagem=None)

    # Aqui entra sua regra real:
    # - se estiver fora de horário -> cfg.msg_fora_horario
    # - se for primeira mensagem -> cfg.msg_boas_vindas
    # - se digitou 1, 2, 3 -> msg de cada setor
    # Vou colocar só um exemplo simplificado:
    resposta = cfg.msg_boas_vindas

    return ChatbotN8NOut(responder=True, mensagem=resposta)
