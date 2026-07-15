from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from sqlalchemy import or_
from sqlalchemy.orm import Session

from backend import models


_DEPARTMENT_FLOW_STATUSES = {
    "aguardando",
    "em_atendimento",
    "pausado",
    "pendente",
}


def _to_int(value: Any) -> Optional[int]:
    try:
        if value is None:
            return None
        return int(value)
    except Exception:
        return None


def _status_norm(value: Any) -> str:
    return str(value or "").split(".")[-1].strip().lower()


def _department_feature(config: Any) -> Dict[str, Any]:
    if not isinstance(config, dict):
        return {}

    features = config.get("features") or {}
    if not isinstance(features, dict):
        return {}

    feature = (
        features.get("auto_messages_departments")
        or features.get("auto_messages_filas")
        or {}
    )
    return feature if isinstance(feature, dict) else {}


def department_chatbot_active(
    db: Session,
    *,
    empresa_id: int,
    instancia_id: Optional[int],
) -> bool:
    """Retorna True somente quando o menu por departamentos está ativo na instância."""
    instancia_id_int = _to_int(instancia_id)
    if instancia_id_int is None:
        return False

    try:
        row = (
            db.query(models.ChatbotConfig)
            .filter(
                models.ChatbotConfig.empresa_id == int(empresa_id),
                models.ChatbotConfig.instancia_id == int(instancia_id_int),
                models.ChatbotConfig.ativo.is_(True),
            )
            .first()
        )
    except Exception:
        return False

    if row is None:
        return False

    feature = _department_feature(getattr(row, "config", None))
    welcome = feature.get("welcome") or {}

    return bool(
        feature.get("enabled", False)
        and isinstance(welcome, dict)
        and welcome.get("enabled", False)
    )


def department_acl_enabled(
    db: Session,
    *,
    empresa_id: int,
    instancia_id: Optional[int],
) -> bool:
    """
    Diz se a ACL por departamento deve ser aplicada naquela instância.

    Diferença importante para ``department_chatbot_active``:
    - para envio de mensagem, falhar deve significar NÃO enviar;
    - para controle de acesso, falhar deve significar manter a restrição.

    Assim, um erro temporário ao consultar a configuração nunca libera
    conversas de outros departamentos por engano.
    """
    instancia_id_int = _to_int(instancia_id)
    if instancia_id_int is None:
        return False

    try:
        row = (
            db.query(models.ChatbotConfig)
            .filter(
                models.ChatbotConfig.empresa_id == int(empresa_id),
                models.ChatbotConfig.instancia_id == int(instancia_id_int),
            )
            .first()
        )
    except Exception:
        return True

    if row is None or not bool(getattr(row, "ativo", False)):
        return False

    feature = _department_feature(getattr(row, "config", None))
    welcome = feature.get("welcome") or {}

    return bool(
        feature.get("enabled", False)
        and isinstance(welcome, dict)
        and welcome.get("enabled", False)
    )


def department_acl_instancia_ids(
    db: Session,
    *,
    empresa_id: int,
    instancia_ids: Optional[List[int]],
) -> List[int]:
    """
    Retorna, entre as instâncias informadas, quais estão com o menu por
    departamentos realmente ligado.

    É usado na listagem/busca para aplicar o filtro por departamento somente
    nas instâncias em que o botão geral do menu está ativo.

    Em erro de consulta, retorna todas as candidatas (fail closed).
    """
    candidates: List[int] = []
    for raw in instancia_ids or []:
        iid = _to_int(raw)
        if iid is not None and int(iid) not in candidates:
            candidates.append(int(iid))

    if not candidates:
        return []

    try:
        rows = (
            db.query(models.ChatbotConfig)
            .filter(
                models.ChatbotConfig.empresa_id == int(empresa_id),
                models.ChatbotConfig.instancia_id.in_(candidates),
            )
            .all()
        )
    except Exception:
        return list(candidates)

    active: List[int] = []

    for row in rows:
        iid = _to_int(getattr(row, "instancia_id", None))
        if iid is None or not bool(getattr(row, "ativo", False)):
            continue

        feature = _department_feature(getattr(row, "config", None))
        welcome = feature.get("welcome") or {}

        if bool(
            feature.get("enabled", False)
            and isinstance(welcome, dict)
            and welcome.get("enabled", False)
        ):
            active.append(int(iid))

    return active


def customer_has_department_triage_marker(
    cliente: Any,
    departamento_id: Optional[int],
) -> bool:
    """Identifica o legado do menu sem confundir departamento cadastral normal."""
    if cliente is None or departamento_id is None:
        return False

    try:
        dep_cliente = _to_int(getattr(cliente, "departamento_id", None))
        if dep_cliente is None or dep_cliente != int(departamento_id):
            return False
    except Exception:
        return False

    try:
        if int(getattr(cliente, "triagem_tentativas", 0) or 0) > 0:
            return True
    except Exception:
        pass

    return bool(
        getattr(cliente, "triagem_iniciada_em", None) is not None
        or getattr(cliente, "triagem_ultima_msg_em", None) is not None
    )


def department_claim_required(
    db: Session,
    *,
    atendimento: Any,
    cliente: Any,
) -> bool:
    """
    Regra única do aceite vindo do menu por departamentos.

    - Departamento cadastral normal nunca exige aceite.
    - Atendimento já assumido continua exclusivo, mesmo se o chatbot for desligado.
    - Atendimento sem responsável só exige aceite enquanto o menu da instância está ativo.
    - Status ``novo`` representa conversa manual liberada e não volta a travar ao religar o bot.
    """
    if atendimento is None:
        return False

    departamento_id = _to_int(getattr(atendimento, "departamento_id", None))
    if departamento_id is None:
        return False

    # Filas possuem sua própria regra de exigir_aceite e não entram nesta política.
    if _to_int(getattr(atendimento, "fila_id", None)) is not None:
        return False

    status = _status_norm(getattr(atendimento, "status", None))
    if status not in _DEPARTMENT_FLOW_STATUSES:
        return False

    if not customer_has_department_triage_marker(cliente, departamento_id):
        return False

    operador_id = _to_int(getattr(atendimento, "operador_id", None))
    if operador_id is not None:
        # Quem já assumiu permanece responsável mesmo após desligar o chatbot.
        return True

    empresa_id = _to_int(getattr(atendimento, "empresa_id", None))
    instancia_id = _to_int(getattr(atendimento, "instancia_id", None))
    if empresa_id is None or instancia_id is None:
        return False

    return department_chatbot_active(
        db,
        empresa_id=int(empresa_id),
        instancia_id=int(instancia_id),
    )


def _open_status_values() -> List[Any]:
    enum_cls = getattr(models, "StatusAtendimento", None)
    if enum_cls is not None:
        values: List[Any] = []
        for name in ("AGUARDANDO", "EM_ATENDIMENTO", "PAUSADO"):
            if hasattr(enum_cls, name):
                values.append(getattr(enum_cls, name))
        if values:
            return values
    return ["aguardando", "em_atendimento", "pausado"]


def _status_novo() -> Any:
    enum_cls = getattr(models, "StatusAtendimento", None)
    return getattr(enum_cls, "NOVO", "novo") if enum_cls is not None else "novo"


def _deactivate_participants_in_savepoint(
    db: Session,
    *,
    empresa_id: int,
    atendimento_id: int,
    now: datetime,
) -> None:
    AP = getattr(models, "AtendimentoParticipante", None)
    if AP is None:
        return

    try:
        with db.begin_nested():
            rows = (
                db.query(AP)
                .filter(
                    AP.empresa_id == int(empresa_id),
                    AP.atendimento_id == int(atendimento_id),
                    AP.is_ativo.is_(True),
                )
                .with_for_update()
                .all()
            )
            for row in rows:
                row.is_ativo = False
                if hasattr(row, "role"):
                    row.role = "participant"
                if hasattr(row, "saiu_em"):
                    row.saiu_em = now
                if hasattr(row, "atualizado_em"):
                    row.atualizado_em = now
                db.add(row)
            db.flush()
    except Exception:
        # Bancos legados sem a tabela de participantes não podem impedir
        # a desativação do chatbot nem deixar a conversa bloqueada.
        return


def release_unassigned_department_claims(
    db: Session,
    *,
    empresa_id: int,
    instancia_id: int,
) -> List[Dict[str, Any]]:
    """
    Libera conversas antigas do menu quando ele é desligado.

    Mantém departamento e visibilidade, mas muda o atendimento sem responsável
    para ``novo``. Assim pode ser respondido diretamente e não volta a exigir
    aceite quando o chatbot for ligado novamente.
    """
    marker_filter = or_(
        models.Cliente.triagem_tentativas > 0,
        models.Cliente.triagem_iniciada_em.is_not(None),
        models.Cliente.triagem_ultima_msg_em.is_not(None),
    )

    rows = (
        db.query(models.Atendimento, models.Cliente)
        .join(
            models.Cliente,
            models.Cliente.id == models.Atendimento.cliente_id,
        )
        .filter(
            models.Atendimento.empresa_id == int(empresa_id),
            models.Atendimento.instancia_id == int(instancia_id),
            models.Atendimento.operador_id.is_(None),
            models.Atendimento.departamento_id.is_not(None),
            models.Atendimento.fila_id.is_(None),
            models.Atendimento.status.in_(_open_status_values()),
            models.Cliente.empresa_id == int(empresa_id),
            marker_filter,
        )
        .order_by(models.Atendimento.id.asc())
        .with_for_update()
        .all()
    )

    now = datetime.now(timezone.utc)
    released: List[Dict[str, Any]] = []

    for atendimento, cliente in rows:
        departamento_id = _to_int(getattr(atendimento, "departamento_id", None))
        if not customer_has_department_triage_marker(cliente, departamento_id):
            continue

        _deactivate_participants_in_savepoint(
            db,
            empresa_id=int(empresa_id),
            atendimento_id=int(atendimento.id),
            now=now,
        )

        atendimento.operador_id = None
        atendimento.status = _status_novo()
        if hasattr(atendimento, "aceito_em"):
            atendimento.aceito_em = None
        if hasattr(atendimento, "atualizado_em"):
            atendimento.atualizado_em = now
        db.add(atendimento)

        released.append(
            {
                "cliente_id": int(atendimento.cliente_id),
                "instancia_id": int(instancia_id),
                "atendimento_id": int(atendimento.id),
                "departamento_id": departamento_id,
                "operador_id": None,
                "responsavel_id": None,
                "status": "novo",
                "claim_mode": None,
                "departamento_claim": False,
                "exigir_aceite": False,
                "aceite_obrigatorio": False,
                "aguardando_aceite": False,
                "pode_aceitar": False,
                "pode_liberar": False,
                "pode_responder": True,
                "aceita_por_mim": False,
                "participantes": [],
                "participantes_ids": [],
                "tem_participantes": False,
            }
        )

    db.flush()
    return released


__all__ = [
    "customer_has_department_triage_marker",
    "department_acl_enabled",
    "department_acl_instancia_ids",
    "department_chatbot_active",
    "department_claim_required",
    "release_unassigned_department_claims",
]
