#backend\routers\atendimento_conversas\utils.py
from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Optional, Dict, Any, Tuple

from sqlalchemy.orm import Session
from sqlalchemy import text

from backend import models


def _table_exists(db: Session, table_name: str) -> bool:
    """
    Verifica tabela no Postgres sem montar SQL dinâmico com f-string.
    """
    try:
        name = str(table_name or "").strip()

        if not re.match(r"^[A-Za-z_][A-Za-z0-9_]*$", name):
            return False

        reg = db.execute(
            text("SELECT to_regclass(:table_name)"),
            {"table_name": f"public.{name}"},
        ).scalar()

        return reg is not None
    except Exception:
        return False


def _participant_feature_enabled(db: Session) -> bool:
    return getattr(models, "AtendimentoParticipante", None) is not None and _table_exists(
        db,
        "atendimento_participantes",
    )


def _fila_feature_enabled(db: Session) -> bool:
    return getattr(models, "FilaAtendimento", None) is not None and _table_exists(
        db,
        "filas_atendimento",
    )


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _resolve_instancia_id(
    db: Session,
    *,
    empresa_id: int,
    instancia_id: Optional[int],
    instance: Optional[str],
) -> Tuple[Optional[int], Optional[str]]:
    if instancia_id is not None:
        row = (
            db.query(models.EmpresaInstancia)
            .filter(
                models.EmpresaInstancia.empresa_id == int(empresa_id),
                models.EmpresaInstancia.id == int(instancia_id),
            )
            .first()
        )
        if row:
            return int(row.id), row.instance_name
        return None, None

    if instance:
        row = (
            db.query(models.EmpresaInstancia)
            .filter(
                models.EmpresaInstancia.empresa_id == int(empresa_id),
                models.EmpresaInstancia.instance_name == str(instance),
            )
            .first()
        )
        if row:
            return int(row.id), row.instance_name
        return None, None

    return None, None


def _iso(ts) -> Optional[str]:
    if ts is None:
        return None

    try:
        if hasattr(ts, "tzinfo") and ts.tzinfo is None:
            ts = ts.replace(tzinfo=timezone.utc)
        return ts.isoformat()
    except Exception:
        try:
            return datetime.fromtimestamp(int(ts), tz=timezone.utc).isoformat()
        except Exception:
            return None


def _public_avatar_url(
    *,
    conversation_id: int,
    raw_avatar_url: Optional[str],
) -> Optional[str]:
    if not conversation_id:
        return None

    raw = (raw_avatar_url or "").strip()
    if not raw:
        return None

    if raw.startswith("/api/atendimento/avatar/"):
        return raw

    if raw.startswith("http://") or raw.startswith("https://"):
        return f"/api/atendimento/avatar/{int(conversation_id)}"

    return f"/api/atendimento/avatar/{int(conversation_id)}"


def _conv_ref_cliente(cliente_id: int, instancia_id: Optional[int]) -> str:
    return f"c:{int(cliente_id)}:{int(instancia_id or 0)}"


def _conv_ref_grupo(grupo_id: int, instancia_id: Optional[int]) -> str:
    return f"g:{int(grupo_id)}:{int(instancia_id or 0)}"


def _sort_key(ent: tuple[Optional[datetime], int, Dict[str, Any], bool]):
    ts_dt, msg_id, _payload, _is_cli = ent

    if ts_dt is None:
        return (datetime.min.replace(tzinfo=timezone.utc), msg_id)

    if hasattr(ts_dt, "tzinfo") and ts_dt.tzinfo is None:
        ts_dt = ts_dt.replace(tzinfo=timezone.utc)

    return (ts_dt, msg_id)


def _status_to_str(v: Any) -> Optional[str]:
    if v is None:
        return None

    if hasattr(v, "value"):
        return str(v.value)

    return str(v)


def _to_int(v: Any) -> Optional[int]:
    try:
        if v is None:
            return None
        return int(v)
    except Exception:
        return None


def _id_get(obj: Any, key: str, default: Any = None) -> Any:
    if obj is None:
        return default

    if isinstance(obj, dict):
        return obj.get(key, default)

    return getattr(obj, key, default)


def _get_atendimento_caps():
    A = getattr(models, "Atendimento", None)

    if A is None:
        return {
            "model": None,
            "usable": False,
            "has_empresa_id": False,
            "has_departamento_id": False,
            "has_operador_id": False,
            "has_status": False,
        }

    usable = all(hasattr(A, attr) for attr in ("id", "cliente_id", "instancia_id"))
    has_empresa_id = hasattr(A, "empresa_id")
    has_departamento_id = hasattr(A, "departamento_id")
    has_operador_id = hasattr(A, "operador_id")
    has_status = hasattr(A, "status")

    return {
        "model": A,
        "usable": usable,
        "has_empresa_id": has_empresa_id,
        "has_departamento_id": has_departamento_id,
        "has_operador_id": has_operador_id,
        "has_status": has_status,
    }


# =========================================================
# Fila / regra de aceite opcional
# =========================================================
def _default_fila_state() -> Dict[str, Any]:
    """
    Estado seguro padrão.

    Regra nova do ZapChats:
    - Sem fila escolhida no atendimento: não exige aceite.
    - Só exige aceite quando atendimento.fila_id existe e a fila exige aceite.
    """
    return {
        "fila_id": None,
        "fila_nome": None,
        "fila_prioridade": None,
        "fila_sla_minutos": None,
        "fila_cor": None,
        "fila_ativa": False,
        "fila_exigir_aceite": False,
        "fila_escolhida_em": None,
        "retorno_inatividade_ativo": False,
        "retorno_inatividade_minutos": None,
        "exigir_aceite": False,
        "aceite_obrigatorio": False,
        "aguardando_aceite": False,
        "aguardando_escolha_fila": False,
        "pode_responder": True,
    }


def _fila_state_for_atendimento(
    db: Session,
    *,
    atendimento,
) -> Dict[str, Any]:
    """
    Calcula o estado de fila/aceite para um atendimento.

    Importante:
    - Não lê Cliente para decidir aceite.
    - Não usa departamento para forçar aceite.
    - Sem atendimento.fila_id => aceite desligado.
    """
    state = _default_fila_state()

    if atendimento is None:
        return state

    fila_id = _to_int(getattr(atendimento, "fila_id", None))
    if fila_id is None:
        return state

    # Fila operacional só existe enquanto o Chatbot de departamentos estiver
    # ligado para o WhatsApp desta conversa. Isso também esconde estados legados
    # sem precisar esperar uma limpeza no banco.
    try:
        from backend.services.chatbot_claim_policy import department_chatbot_active_for_department

        empresa_id = _to_int(getattr(atendimento, "empresa_id", None))
        instancia_id = _to_int(getattr(atendimento, "instancia_id", None))
        departamento_id = _to_int(getattr(atendimento, "departamento_id", None))
        if (
            empresa_id is None
            or instancia_id is None
            or departamento_id is None
            or not department_chatbot_active_for_department(
                db,
                empresa_id=int(empresa_id),
                instancia_id=int(instancia_id),
                departamento_id=int(departamento_id),
            )
        ):
            return state
    except Exception:
        # Fail closed: se não foi possível validar o Chatbot, não exibe fila.
        return state

    state["fila_id"] = int(fila_id)
    state["fila_escolhida_em"] = _iso(getattr(atendimento, "fila_escolhida_em", None))

    if not _fila_feature_enabled(db):
        return state

    try:
        fila = (
            db.query(models.FilaAtendimento)
            .filter(
                models.FilaAtendimento.id == int(fila_id),
                models.FilaAtendimento.empresa_id == int(getattr(atendimento, "empresa_id")),
            )
            .first()
        )
    except Exception:
        return state

    if not fila:
        return state

    exigir = bool(getattr(fila, "exigir_aceite", False))

    state.update(
        {
            "fila_id": int(fila.id),
            "fila_nome": getattr(fila, "nome", None),
            "fila_prioridade": getattr(fila, "prioridade", None),
            "fila_sla_minutos": getattr(fila, "sla_minutos", None),
            "fila_cor": getattr(fila, "cor", None),
            "fila_ativa": bool(getattr(fila, "ativa", False)),
            "fila_exigir_aceite": exigir,
            "retorno_inatividade_ativo": bool(getattr(fila, "retorno_inatividade_ativo", False)),
            "retorno_inatividade_minutos": getattr(fila, "retorno_inatividade_minutos", None),
            "exigir_aceite": exigir,
            "aceite_obrigatorio": exigir,
            "pode_responder": not exigir,
        }
    )

    return state
