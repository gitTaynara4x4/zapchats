from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from backend.database import get_db
from backend import models

router = APIRouter()

@router.get("/por-telefone/{telefone}")
def get_mensagens_por_telefone(telefone: str, db: Session = Depends(get_db)):
    cliente = db.query(models.Cliente).filter(models.Cliente.telefone == telefone).first()
    if not cliente:
        return {"mensagens": []}
    
    mensagens = db.query(models.Mensagem)\
        .filter(models.Mensagem.cliente_id == cliente.id)\
        .order_by(models.Mensagem.id.asc())\
        .all()

    return {
        "cliente_id": cliente.id,
        "mensagens": [
            {"id": m.id, "conteudo": m.conteudo, "tipo": m.tipo}
            for m in mensagens
        ]
    }

@router.get("/mensagens/{cliente_id}")
def get_mensagens(cliente_id: int, db: Session = Depends(get_db)):
    mensagens = db.query(models.Mensagem)\
        .filter(models.Mensagem.cliente_id == cliente_id)\
        .order_by(models.Mensagem.id.asc())\
        .all()
    return mensagens
