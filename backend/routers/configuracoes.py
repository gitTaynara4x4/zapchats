# backend/routers/configuracoes.py
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel
from backend.database import get_db
from backend.routers.auth import get_current_user
from backend import models

router = APIRouter(prefix="/api/empresas", tags=["Configurações"])

class EmpresaConfigIn(BaseModel):
    empresa: dict | None = None
    horario: dict | None = None
    mensagens: dict | None = None
    notificacoes: dict | None = None
    privacidade: dict | None = None

@router.get("/{empresa_id}/configuracoes")
def get_config(empresa_id: int,
               db: Session = Depends(get_db),
               user=Depends(get_current_user)):
    # (Opcional) valide que o user pertence à empresa_id
    cfg = db.query(models.EmpresaConfig).get(empresa_id)
    if not cfg:
        # retorna defaults
        return {
            "empresa": {"nome": None, "departamento_padrao": None, "logo_url": None},
            "horario": {"ativo": False, "dias": {}, "inicio": None, "fim": None},
            "mensagens": {"saudacao": None, "ausencia": None, "boas_vindas": None, "fora_horario": None},
            "notificacoes": {"email": False, "push": False, "som": False},
            "privacidade": {"recibo_leitura": True, "status_online": True},
        }
    return cfg.data  # onde data é um JSON com a estrutura acima

@router.put("/{empresa_id}/configuracoes")
def put_config(empresa_id: int,
               payload: EmpresaConfigIn,
               db: Session = Depends(get_db),
               user=Depends(get_current_user)):
    cfg = db.query(models.EmpresaConfig).get(empresa_id)
    if not cfg:
        cfg = models.EmpresaConfig(empresa_id=empresa_id, data={})
        db.add(cfg)
    cfg.data = payload.model_dump(exclude_none=True)
    db.commit()
    db.refresh(cfg)
    return cfg.data
