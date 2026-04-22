# backend/integrations/evolution/repositories/atendimentos_repo.py
from __future__ import annotations

from typing import Any

from sqlalchemy.orm import Session

from backend import models


def has_mensagem_atendimento_field() -> bool:
    return hasattr(models.Mensagem, "atendimento_id")


def _get_atendimento_model():
    return getattr(models, "Atendimento", None)


def _safe_rollback(db: Session) -> None:
    try:
        db.rollback()
    except Exception:
        pass


def _to_int(v) -> int | None:
    try:
        if v is None:
            return None
        return int(v)
    except Exception:
        return None


def _status_abertos() -> list[object]:
    status_enum = getattr(models, "StatusAtendimento", None)
    vals: list[object] = []

    if status_enum is not None:
        for attr in ("NOVO", "AGUARDANDO", "EM_ATENDIMENTO", "PAUSADO"):
            if hasattr(status_enum, attr):
                try:
                    vals.append(getattr(status_enum, attr))
                except Exception:
                    pass

    # compat legado
    vals.extend(["novo", "aguardando", "em_atendimento", "pausado", "aberto", "pendente"])

    out = []
    seen = set()
    for v in vals:
        key = str(v)
        if key in seen:
            continue
        seen.add(key)
        out.append(v)
    return out


def _set_status_inicial(novo) -> None:
    if not hasattr(novo, "status"):
        return

    status_enum = getattr(models, "StatusAtendimento", None)
    if status_enum is not None and hasattr(status_enum, "NOVO"):
        try:
            novo.status = status_enum.NOVO
            return
        except Exception:
            pass

    try:
        novo.status = "novo"
    except Exception:
        pass


def _query_open_atendimento(
    db: Session,
    *,
    empresa_id: int,
    instancia_id: int,
    cliente_id: int,
    departamento_id: int | None = None,
):
    Atendimento = _get_atendimento_model()
    if Atendimento is None:
        return None

    q = db.query(Atendimento)

    if hasattr(Atendimento, "empresa_id"):
        q = q.filter(Atendimento.empresa_id == int(empresa_id))

    if hasattr(Atendimento, "cliente_id"):
        q = q.filter(Atendimento.cliente_id == int(cliente_id))

    if hasattr(Atendimento, "instancia_id"):
        q = q.filter(Atendimento.instancia_id == int(instancia_id))

    if hasattr(Atendimento, "departamento_id"):
        if departamento_id is None:
            q = q.filter(Atendimento.departamento_id.is_(None))
        else:
            q = q.filter(Atendimento.departamento_id == int(departamento_id))

    if hasattr(Atendimento, "status"):
        try:
            q = q.filter(Atendimento.status.in_(_status_abertos()))
        except Exception:
            pass

    try:
        if hasattr(Atendimento, "id"):
            return q.order_by(Atendimento.id.desc()).first()
        return q.first()
    except Exception:
        _safe_rollback(db)
        return None


def _query_latest_open_atendimento_any_department(
    db: Session,
    *,
    empresa_id: int,
    instancia_id: int,
    cliente_id: int,
):
    Atendimento = _get_atendimento_model()
    if Atendimento is None:
        return None

    q = db.query(Atendimento)

    if hasattr(Atendimento, "empresa_id"):
        q = q.filter(Atendimento.empresa_id == int(empresa_id))

    if hasattr(Atendimento, "cliente_id"):
        q = q.filter(Atendimento.cliente_id == int(cliente_id))

    if hasattr(Atendimento, "instancia_id"):
        q = q.filter(Atendimento.instancia_id == int(instancia_id))

    if hasattr(Atendimento, "status"):
        try:
            q = q.filter(Atendimento.status.in_(_status_abertos()))
        except Exception:
            pass

    try:
        if hasattr(Atendimento, "id"):
            return q.order_by(Atendimento.id.desc()).first()
        return q.first()
    except Exception:
        _safe_rollback(db)
        return None


def get_or_open_atendimento_repo(
    db: Session,
    *,
    empresa_id: int,
    instancia_id: int,
    cliente_id: int,
    direcao: str,
    ts_dt,
    departamento_id: int | None = None,
    operador_id: int | None = None,
) -> Any | None:
    if not has_mensagem_atendimento_field():
        return None

    Atendimento = _get_atendimento_model()
    if Atendimento is None:
        return None

    empresa_id_i = int(empresa_id)
    instancia_id_i = int(instancia_id)
    cliente_id_i = int(cliente_id)
    departamento_id_i = _to_int(departamento_id)
    operador_id_i = _to_int(operador_id)

    # Se a sessão estiver em estado inválido, saneia primeiro
    try:
        if hasattr(db, "is_active") and not db.is_active:
            _safe_rollback(db)
    except Exception:
        _safe_rollback(db)

    atendimento = _query_open_atendimento(
        db,
        empresa_id=empresa_id_i,
        instancia_id=instancia_id_i,
        cliente_id=cliente_id_i,
        departamento_id=departamento_id_i,
    )
    if atendimento is not None:
        return atendimento

    try:
        novo = Atendimento()
    except Exception:
        return None

    try:
        if hasattr(novo, "empresa_id"):
            novo.empresa_id = empresa_id_i

        if hasattr(novo, "cliente_id"):
            novo.cliente_id = cliente_id_i

        if hasattr(novo, "instancia_id"):
            novo.instancia_id = instancia_id_i

        if hasattr(novo, "departamento_id"):
            novo.departamento_id = departamento_id_i

        _set_status_inicial(novo)

        if hasattr(novo, "tipo"):
            novo.tipo = direcao

        if hasattr(novo, "direcao"):
            novo.direcao = direcao

        if hasattr(novo, "operador_id") and operador_id_i is not None:
            novo.operador_id = operador_id_i

        if hasattr(novo, "criado_em") and ts_dt is not None:
            novo.criado_em = ts_dt

        if hasattr(novo, "created_at") and ts_dt is not None:
            novo.created_at = ts_dt

        if hasattr(novo, "atualizado_em") and ts_dt is not None:
            novo.atualizado_em = ts_dt

        if hasattr(novo, "updated_at") and ts_dt is not None:
            novo.updated_at = ts_dt

        db.add(novo)
        db.flush()
        return novo

    except Exception:
        _safe_rollback(db)

        # tenta buscar de novo depois do rollback
        return _query_open_atendimento(
            db,
            empresa_id=empresa_id_i,
            instancia_id=instancia_id_i,
            cliente_id=cliente_id_i,
            departamento_id=departamento_id_i,
        )


def update_open_atendimento_departamento_repo(
    db: Session,
    *,
    empresa_id: int,
    instancia_id: int,
    cliente_id: int,
    departamento_id: int | None,
    ts_dt=None,
    operador_id: int | None = None,
) -> Any | None:
    """
    Atualiza o atendimento aberto mais recente da conversa para o departamento informado.
    Se não existir atendimento aberto, cria um já no departamento correto.
    """
    if not has_mensagem_atendimento_field():
        return None

    Atendimento = _get_atendimento_model()
    if Atendimento is None:
        return None

    empresa_id_i = int(empresa_id)
    instancia_id_i = int(instancia_id)
    cliente_id_i = int(cliente_id)
    departamento_id_i = _to_int(departamento_id)
    operador_id_i = _to_int(operador_id)

    try:
        if hasattr(db, "is_active") and not db.is_active:
            _safe_rollback(db)
    except Exception:
        _safe_rollback(db)

    atendimento = _query_latest_open_atendimento_any_department(
        db,
        empresa_id=empresa_id_i,
        instancia_id=instancia_id_i,
        cliente_id=cliente_id_i,
    )

    if atendimento is None:
        return get_or_open_atendimento_repo(
            db,
            empresa_id=empresa_id_i,
            instancia_id=instancia_id_i,
            cliente_id=cliente_id_i,
            direcao="entrada",
            ts_dt=ts_dt,
            departamento_id=departamento_id_i,
            operador_id=operador_id_i,
        )

    try:
        changed = False

        if hasattr(atendimento, "departamento_id"):
            atual_dep = _to_int(getattr(atendimento, "departamento_id", None))
            if atual_dep != departamento_id_i:
                atendimento.departamento_id = departamento_id_i
                changed = True

        if hasattr(atendimento, "operador_id") and operador_id_i is not None:
            atual_operador = _to_int(getattr(atendimento, "operador_id", None))
            if atual_operador is None:
                atendimento.operador_id = operador_id_i
                changed = True

        if ts_dt is not None:
            if hasattr(atendimento, "atualizado_em"):
                atendimento.atualizado_em = ts_dt
                changed = True
            elif hasattr(atendimento, "updated_at"):
                atendimento.updated_at = ts_dt
                changed = True

        if changed:
            db.flush()

        return atendimento

    except Exception:
        _safe_rollback(db)
        return _query_open_atendimento(
            db,
            empresa_id=empresa_id_i,
            instancia_id=instancia_id_i,
            cliente_id=cliente_id_i,
            departamento_id=departamento_id_i,
        )


def get_atendimento_id_repo(
    db: Session,
    *,
    empresa_id: int,
    instancia_id: int,
    cliente_id: int,
    direcao: str,
    ts_dt,
    departamento_id: int | None = None,
    operador_id: int | None = None,
) -> int | None:
    atendimento = get_or_open_atendimento_repo(
        db,
        empresa_id=empresa_id,
        instancia_id=instancia_id,
        cliente_id=cliente_id,
        direcao=direcao,
        ts_dt=ts_dt,
        departamento_id=departamento_id,
        operador_id=operador_id,
    )
    if atendimento is None:
        return None

    att_id = getattr(atendimento, "id", None)
    return int(att_id) if att_id is not None else None


def attach_atendimento_to_message_if_supported(msg_model, atendimento_id: int | None):
    if not has_mensagem_atendimento_field():
        return msg_model
    if atendimento_id is None:
        return msg_model
    if hasattr(msg_model, "atendimento_id"):
        setattr(msg_model, "atendimento_id", int(atendimento_id))
    return msg_model


__all__ = [
    "has_mensagem_atendimento_field",
    "get_or_open_atendimento_repo",
    "get_atendimento_id_repo",
    "update_open_atendimento_departamento_repo",
    "attach_atendimento_to_message_if_supported",
]