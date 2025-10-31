from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session
from backend.database import SessionLocal
from backend import models
from pydantic import BaseModel
from backend.websocket_manager import conexoes_ativas
from starlette.websockets import WebSocketDisconnect
import asyncio

router = APIRouter(prefix="/chatbot", tags=["ChatBot"])

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

class MensagemIn(BaseModel):
    telefone: str
    conteudo: str

@router.post("/mensagem")
async def receber_mensagem(mensagem: MensagemIn, db: Session = Depends(get_db)):
    cliente = db.query(models.Cliente).filter_by(telefone=mensagem.telefone).first()
    if not cliente:
        cliente = models.Cliente(telefone=mensagem.telefone, nome="Desconhecido")
        db.add(cliente)
        db.commit()
        db.refresh(cliente)

    entrada = models.Mensagem(
        cliente_id=cliente.id,
        conteudo=mensagem.conteudo,
        tipo="entrada",
        lida=False
    )
    db.add(entrada)

    conteudo_lower = mensagem.conteudo.lower()
    departamentos = ["financeiro", "suporte", "vendas"]

    if conteudo_lower in departamentos:
        cliente.departamento = conteudo_lower
        resposta_texto = f"Você foi direcionado para o departamento de {conteudo_lower.upper()}!"
    else:
        resposta_texto = f"Olá! Recebemos sua mensagem: '{mensagem.conteudo}'"

    resposta = models.Mensagem(
        cliente_id=cliente.id,
        conteudo=resposta_texto,
        tipo="saida"
    )
    db.add(resposta)
    db.commit()

    # 🔄 Notifica o painel via WebSocket (resposta do bot)
    for conn in conexoes_ativas:
        try:
            await conn.send_json({
                "telefone": cliente.telefone,
                "mensagem": resposta_texto
            })
        except WebSocketDisconnect:
            conexoes_ativas.remove(conn)

    return {"resposta": resposta_texto}
