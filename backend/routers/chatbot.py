from __future__ import annotations

from typing import Generator, List

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session
from starlette.websockets import WebSocketDisconnect

from backend.database import SessionLocal
from backend import models
from backend.websocket_manager import conexoes_ativas

router = APIRouter(prefix="/chatbot", tags=["ChatBot"])


# =========================
# DB
# =========================
def get_db() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


# =========================
# Schemas
# =========================
class MensagemIn(BaseModel):
    telefone: str
    conteudo: str


# =========================
# Utils
# =========================
def _only_digits(value: str | None) -> str:
    return "".join(ch for ch in (value or "") if ch.isdigit())


def _normalizar_telefone(telefone: str) -> str:
    digits = _only_digits(telefone)

    # Se vier com 55 já mantém
    if digits.startswith("55") and len(digits) >= 12:
        return digits

    # Se vier sem DDI, adiciona 55
    if digits:
        return f"55{digits}"

    return ""


async def _notificar_painel(telefone: str, mensagem: str) -> None:
    desconectar: List = []

    for conn in list(conexoes_ativas):
        try:
            await conn.send_json({
                "telefone": telefone,
                "mensagem": mensagem,
            })
        except WebSocketDisconnect:
            desconectar.append(conn)
        except Exception:
            desconectar.append(conn)

    for conn in desconectar:
        try:
            conexoes_ativas.remove(conn)
        except ValueError:
            pass


def _buscar_ou_criar_cliente(db: Session, telefone: str) -> models.Cliente:
    cliente = db.query(models.Cliente).filter_by(telefone=telefone).first()

    if cliente:
        return cliente

    cliente = models.Cliente(
        telefone=telefone,
        nome="Desconhecido",
    )
    db.add(cliente)
    db.commit()
    db.refresh(cliente)
    return cliente


def _registrar_mensagem(
    db: Session,
    *,
    cliente_id: int,
    conteudo: str,
    tipo: str,
    lida: bool | None = None,
) -> models.Mensagem:
    payload = {
        "cliente_id": cliente_id,
        "conteudo": conteudo,
        "tipo": tipo,
    }

    if lida is not None:
        payload["lida"] = lida

    msg = models.Mensagem(**payload)
    db.add(msg)
    db.commit()
    db.refresh(msg)
    return msg


def _gerar_resposta(cliente: models.Cliente, conteudo: str) -> str:
    conteudo_lower = (conteudo or "").strip().lower()

    departamentos = {
        "1": "financeiro",
        "2": "suporte",
        "3": "vendas",
        "financeiro": "financeiro",
        "suporte": "suporte",
        "vendas": "vendas",
    }

    departamento = departamentos.get(conteudo_lower)

    if departamento:
        cliente.departamento = departamento
        return f"Você foi direcionado para o departamento de {departamento.upper()}!"

    return (
        "Olá! 👋 Recebemos sua mensagem.\n\n"
        "Escolha um setor digitando uma opção:\n"
        "1 - Financeiro\n"
        "2 - Suporte\n"
        "3 - Vendas"
    )


# =========================
# Endpoint principal
# =========================
@router.post("/mensagem")
async def receber_mensagem(
    mensagem: MensagemIn,
    db: Session = Depends(get_db),
):
    telefone = _normalizar_telefone(mensagem.telefone)
    conteudo = (mensagem.conteudo or "").strip()

    if not telefone:
        return {
            "ok": False,
            "erro": "Telefone inválido.",
        }

    if not conteudo:
        return {
            "ok": False,
            "erro": "Conteúdo vazio.",
        }

    cliente = _buscar_ou_criar_cliente(db, telefone)

    _registrar_mensagem(
        db,
        cliente_id=cliente.id,
        conteudo=conteudo,
        tipo="entrada",
        lida=False,
    )

    resposta_texto = _gerar_resposta(cliente, conteudo)

    # Salva eventual alteração no cliente, ex.: departamento
    db.add(cliente)
    db.commit()
    db.refresh(cliente)

    _registrar_mensagem(
        db,
        cliente_id=cliente.id,
        conteudo=resposta_texto,
        tipo="saida",
        lida=True,
    )

    await _notificar_painel(cliente.telefone, resposta_texto)

    return {
        "ok": True,
        "telefone": cliente.telefone,
        "resposta": resposta_texto,
        "departamento": getattr(cliente, "departamento", None),
    }