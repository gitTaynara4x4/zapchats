# backend/routers/mensagens.py
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from backend.database import get_db
from backend import models
from backend.routers.auth import get_current_user

router = APIRouter()


@router.get("/por-telefone/{telefone}")
def get_mensagens_por_telefone(
    telefone: str,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    """
    Busca mensagens por telefone, SEM deixar vazar entre empresas.

    - Só procura cliente cujo telefone seja o informado E que pertença
      à mesma empresa do usuário logado.
    - Se não achar, devolve estrutura vazia e não revela se existe cliente
      em outra empresa com o mesmo número.
    """
    cliente = (
        db.query(models.Cliente)
        .filter(models.Cliente.telefone == telefone)
        .filter(models.Cliente.empresa_id == current_user.empresa_id)
        .first()
    )

    if not cliente:
        return {
            "cliente_id": None,
            "mensagens": [],
        }

    mensagens = (
        db.query(models.Mensagem)
        .filter(models.Mensagem.cliente_id == cliente.id)
        .filter(models.Mensagem.empresa_id == current_user.empresa_id)
        .order_by(models.Mensagem.id.asc())
        .all()
    )

    return {
        "cliente_id": cliente.id,
        "mensagens": [
            {
                "id": m.id,
                "conteudo": m.conteudo,
                "tipo": m.tipo,
            }
            for m in mensagens
        ],
    }


@router.get("/mensagens/{cliente_id}")
def get_mensagens(
    cliente_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    """
    Lista mensagens de um cliente específico, validando empresa.

    - Primeiro carrega o Cliente e verifica se ele pertence à empresa do usuário.
    - Se não pertencer, retorna 404 (como se não existisse).
    - Depois filtra Mensagem por cliente_id E empresa_id.
    """
    cliente = db.query(models.Cliente).get(cliente_id)
    if not cliente or cliente.empresa_id != current_user.empresa_id:
        raise HTTPException(status_code=404, detail="Cliente não encontrado")

    mensagens = (
        db.query(models.Mensagem)
        .filter(models.Mensagem.cliente_id == cliente_id)
        .filter(models.Mensagem.empresa_id == current_user.empresa_id)
        .order_by(models.Mensagem.id.asc())
        .all()
    )

    return mensagens
