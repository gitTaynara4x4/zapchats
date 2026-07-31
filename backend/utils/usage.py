# backend/utils/usage.py
from __future__ import annotations

from datetime import datetime, timezone
from typing import Dict

from sqlalchemy import func
from sqlalchemy.orm import Session

from backend.models import (
    EmpresaInstancia,
    Colaborador,
    Usuario,
    Departamento,
    Cliente,
    Disparo,
    ChatbotConfig,
)

def month_start_utc() -> datetime:
    now = datetime.now(timezone.utc)
    return now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)

def usage_counts(db: Session, empresa_id: int) -> Dict[str, int]:
    """
    Retorna o USO atual (current) para comparar com LIMITES do plano.
    Ajuste aqui se quiser contar Usuario + Colaborador, ou só um.
    """
    # instâncias WhatsApp
    whatsapp_instances = db.query(func.count(EmpresaInstancia.id)).filter(
        EmpresaInstancia.empresa_id == empresa_id
    ).scalar() or 0

    # colaboradores (recomendado pro plano)
    collaborators = db.query(func.count(Colaborador.id)).filter(
        Colaborador.empresa_id == empresa_id
    ).scalar() or 0

    # (opcional) usuários admin
    admin_users = db.query(func.count(Usuario.id)).filter(
        Usuario.empresa_id == empresa_id
    ).scalar() or 0

    # departamentos
    departments = db.query(func.count(Departamento.id)).filter(
        Departamento.empresa_id == empresa_id
    ).scalar() or 0

    # contatos
    contacts = db.query(func.count(Cliente.id)).filter(
        Cliente.empresa_id == empresa_id
    ).scalar() or 0

    # regras/configs de chatbot (se você for limitar)
    automation_rules = db.query(func.count(ChatbotConfig.id)).filter(
        ChatbotConfig.empresa_id == empresa_id
    ).scalar() or 0

    # mensagens agendadas em campanhas no mês
    ms = month_start_utc()
    broadcasts_reserved = db.query(
        func.coalesce(func.sum(Disparo.total_destinatarios), 0)
    ).filter(
        Disparo.empresa_id == empresa_id,
        Disparo.criado_em >= ms,
        Disparo.status != "cancelado",
    ).scalar() or 0

    broadcasts_cancelled_processed = db.query(
        func.coalesce(
            func.sum(
                func.coalesce(Disparo.enviados_sucesso, 0)
                + func.coalesce(Disparo.enviados_erro, 0)
            ),
            0,
        )
    ).filter(
        Disparo.empresa_id == empresa_id,
        Disparo.criado_em >= ms,
        Disparo.status == "cancelado",
    ).scalar() or 0

    broadcasts_this_month = int(broadcasts_reserved) + int(broadcasts_cancelled_processed)

    active_campaigns = db.query(func.count(Disparo.id)).filter(
        Disparo.empresa_id == empresa_id,
        Disparo.status.in_(("pendente", "processando")),
    ).scalar() or 0

    return {
        "whatsapp_instances_max": int(whatsapp_instances),  # usage
        "users_max": int(collaborators),                    # usage (principal)
        # "admin_users": int(admin_users),                  # se quiser expor no front
        "departments_max": int(departments),                # usage
        "contacts_max": int(contacts),                      # usage
        "automation_rules_max": int(automation_rules),      # usage
        "broadcasts_per_month_max": int(broadcasts_this_month),  # mensagens no mês
        "active_campaigns_max": int(active_campaigns),          # campanhas ativas
    }
