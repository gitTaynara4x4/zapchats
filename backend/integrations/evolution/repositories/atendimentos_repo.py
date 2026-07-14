# backend/integrations/evolution/repositories/atendimentos_repo.py

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, List, Optional

from sqlalchemy import text
from sqlalchemy.orm import Session

from backend import models
from backend.services.atendimento_claim_state import (
    claim_exclusive_operator,
    claim_if_available,
    deactivate_all_participants,
    ensure_open_atendimento_locked,
    release_to_queue,
    set_waiting_department,
)


def has_mensagem_atendimento_field() -> bool:
    return hasattr(models.Mensagem, "atendimento_id")


def _get_atendimento_model():
    return getattr(models, "Atendimento", None)


def _get_participante_model():
    return getattr(models, "AtendimentoParticipante", None)


def has_atendimento_participante_model() -> bool:
    return _get_participante_model() is not None


def _safe_rollback(db: Session) -> None:
    try:
        db.rollback()
    except Exception:
        pass


def _to_int(v) -> int | None:
    try:
        if v is None:
            return None

        s = str(v).strip()
        if not s:
            return None

        return int(s)
    except Exception:
        return None


def _now_utc():
    return datetime.now(timezone.utc)


def _table_exists(db: Session, table_name: str) -> bool:
    try:
        name = str(table_name or "").strip()
        if not name.replace("_", "").isalnum():
            return False

        reg = db.execute(
            text("SELECT to_regclass(:table_name)"),
            {"table_name": f"public.{name}"},
        ).scalar()

        return reg is not None
    except Exception:
        return False


def _participant_feature_enabled(db: Session) -> bool:
    return has_atendimento_participante_model() and _table_exists(db, "atendimento_participantes")


def _cliente_exists_for_empresa(
    db: Session,
    *,
    empresa_id: int,
    cliente_id: int | None,
) -> bool:
    cid = _to_int(cliente_id)
    if cid is None:
        return False

    try:
        row = db.execute(
            text(
                """
                SELECT 1
                  FROM clientes
                 WHERE id = :cliente_id
                   AND empresa_id = :empresa_id
                 LIMIT 1
                """
            ),
            {
                "cliente_id": int(cid),
                "empresa_id": int(empresa_id),
            },
        ).first()

        return bool(row)

    except Exception:
        _safe_rollback(db)
        return False


def _instancia_exists_for_empresa(
    db: Session,
    *,
    empresa_id: int,
    instancia_id: int | None,
) -> bool:
    iid = _to_int(instancia_id)
    if iid is None:
        return False

    try:
        row = db.execute(
            text(
                """
                SELECT 1
                  FROM empresa_instancias
                 WHERE id = :instancia_id
                   AND empresa_id = :empresa_id
                 LIMIT 1
                """
            ),
            {
                "instancia_id": int(iid),
                "empresa_id": int(empresa_id),
            },
        ).first()

        return bool(row)

    except Exception:
        # compat caso a tabela no seu banco esteja com outro nome/modelo;
        # não bloqueia atendimento por falha de introspecção.
        try:
            row = (
                db.query(models.EmpresaInstancia.id)
                .filter(
                    models.EmpresaInstancia.id == int(iid),
                    models.EmpresaInstancia.empresa_id == int(empresa_id),
                )
                .first()
            )
            return bool(row and row[0] is not None)
        except Exception:
            _safe_rollback(db)
            return False


def _atendimento_context_ok(
    atendimento,
    *,
    empresa_id: int,
    instancia_id: int,
    cliente_id: int,
) -> bool:
    if atendimento is None:
        return False

    if hasattr(atendimento, "empresa_id"):
        emp = _to_int(getattr(atendimento, "empresa_id", None))
        if emp is not None and emp != int(empresa_id):
            return False

    if hasattr(atendimento, "cliente_id"):
        cid = _to_int(getattr(atendimento, "cliente_id", None))
        if cid is not None and cid != int(cliente_id):
            return False

    if hasattr(atendimento, "instancia_id"):
        iid = _to_int(getattr(atendimento, "instancia_id", None))
        if iid is not None and iid != int(instancia_id):
            return False

    return True


def _status_abertos() -> list[object]:
    status_enum = getattr(models, "StatusAtendimento", None)
    vals: list[object] = []

    # Banco atual usa Enum nativo statusatendimento. Strings antigas como
    # "aberto" e "pendente" não existem nesse enum e quebram a transação.
    if status_enum is not None:
        for attr in ("NOVO", "AGUARDANDO", "EM_ATENDIMENTO", "PAUSADO"):
            if hasattr(status_enum, attr):
                try:
                    vals.append(getattr(status_enum, attr))
                except Exception:
                    pass
        if vals:
            return vals

    return ["novo", "aguardando", "em_atendimento", "pausado"]


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


def _set_status_aguardando(atendimento) -> None:
    """Coloca o atendimento na fila compartilhada do departamento."""
    if not hasattr(atendimento, "status"):
        return

    status_enum = getattr(models, "StatusAtendimento", None)
    if status_enum is not None and hasattr(status_enum, "AGUARDANDO"):
        try:
            atendimento.status = status_enum.AGUARDANDO
            return
        except Exception:
            pass

    try:
        atendimento.status = "aguardando"
    except Exception:
        pass


def _set_status_novo(atendimento) -> None:
    """Volta o atendimento para novo quando ainda não existe departamento escolhido."""
    if not hasattr(atendimento, "status"):
        return

    status_enum = getattr(models, "StatusAtendimento", None)
    if status_enum is not None and hasattr(status_enum, "NOVO"):
        try:
            atendimento.status = status_enum.NOVO
            return
        except Exception:
            pass

    try:
        atendimento.status = "novo"
    except Exception:
        pass


def _clear_active_participantes_for_triage(db: Session, *, atendimento) -> None:
    """Chatbot devolve a conversa para a fila sem nenhum responsável ativo."""
    try:
        deactivate_all_participants(db, atendimento=atendimento)
    except Exception:
        return


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

    if not _cliente_exists_for_empresa(
        db,
        empresa_id=int(empresa_id),
        cliente_id=int(cliente_id),
    ):
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
        row = q.order_by(Atendimento.id.desc()).first() if hasattr(Atendimento, "id") else q.first()

        if not _atendimento_context_ok(
            row,
            empresa_id=int(empresa_id),
            instancia_id=int(instancia_id),
            cliente_id=int(cliente_id),
        ):
            return None

        return row

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

    if not _cliente_exists_for_empresa(
        db,
        empresa_id=int(empresa_id),
        cliente_id=int(cliente_id),
    ):
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
        row = q.order_by(Atendimento.id.desc()).first() if hasattr(Atendimento, "id") else q.first()

        if not _atendimento_context_ok(
            row,
            empresa_id=int(empresa_id),
            instancia_id=int(instancia_id),
            cliente_id=int(cliente_id),
        ):
            return None

        return row

    except Exception:
        _safe_rollback(db)
        return None


def _list_active_participantes(
    db: Session,
    *,
    empresa_id: int,
    atendimento_id: int,
):
    AP = _get_participante_model()
    if AP is None or not _participant_feature_enabled(db):
        return []

    q = db.query(AP).filter(
        AP.empresa_id == int(empresa_id),
        AP.atendimento_id == int(atendimento_id),
    )

    if hasattr(AP, "is_ativo"):
        q = q.filter(AP.is_ativo.is_(True))
    elif hasattr(AP, "saiu_em"):
        q = q.filter(AP.saiu_em.is_(None))

    try:
        return q.order_by(AP.id.asc()).all() if hasattr(AP, "id") else q.all()
    except Exception:
        _safe_rollback(db)
        return []


def _list_active_participante_ids(
    db: Session,
    *,
    empresa_id: int,
    atendimento_id: int,
) -> List[int]:
    rows = _list_active_participantes(
        db,
        empresa_id=int(empresa_id),
        atendimento_id=int(atendimento_id),
    )

    out: List[int] = []

    for row in rows:
        cid = _to_int(getattr(row, "colaborador_id", None))
        if cid is not None and cid not in out:
            out.append(cid)

    return out


def _upsert_participante(
    db: Session,
    *,
    atendimento,
    colaborador_id: int,
    is_responsavel: Optional[bool] = None,
):
    AP = _get_participante_model()
    if AP is None or not _participant_feature_enabled(db):
        return None

    atendimento_id = _to_int(getattr(atendimento, "id", None))
    empresa_id = _to_int(getattr(atendimento, "empresa_id", None))

    if atendimento_id is None or empresa_id is None:
        return None

    q = db.query(AP).filter(
        AP.empresa_id == int(empresa_id),
        AP.atendimento_id == int(atendimento_id),
        AP.colaborador_id == int(colaborador_id),
    )

    try:
        row = q.order_by(AP.id.desc()).first() if hasattr(AP, "id") else q.first()
    except Exception:
        _safe_rollback(db)
        return None

    now = _now_utc()

    if row is None:
        data = {
            "empresa_id": int(empresa_id),
            "atendimento_id": int(atendimento_id),
            "colaborador_id": int(colaborador_id),
        }

        if hasattr(AP, "aceito_em"):
            data["aceito_em"] = now
        if hasattr(AP, "entrou_em"):
            data["entrou_em"] = now
        if hasattr(AP, "is_ativo"):
            data["is_ativo"] = True
        if hasattr(AP, "saiu_em"):
            data["saiu_em"] = None
        if hasattr(AP, "role"):
            data["role"] = "responsavel" if bool(is_responsavel) else "participant"

        row = AP(**data)
        db.add(row)
        db.flush()
        return row

    if hasattr(row, "is_ativo"):
        row.is_ativo = True
    if hasattr(row, "saiu_em"):
        row.saiu_em = None
    if hasattr(row, "aceito_em") and getattr(row, "aceito_em", None) is None:
        row.aceito_em = now
    if hasattr(row, "entrou_em") and getattr(row, "entrou_em", None) is None:
        row.entrou_em = now
    if hasattr(row, "role") and is_responsavel is not None:
        row.role = "responsavel" if bool(is_responsavel) else "participant"

    db.add(row)
    db.flush()
    return row


def _bootstrap_legacy_operador_as_participante(
    db: Session,
    *,
    atendimento,
) -> None:
    """
    Migração preguiçosa:
    se existe operador_id no atendimento legado e ainda não existe
    participante ativo, cria 1 participante ativo/responsável.
    """
    if atendimento is None or not _participant_feature_enabled(db):
        return

    atendimento_id = _to_int(getattr(atendimento, "id", None))
    empresa_id = _to_int(getattr(atendimento, "empresa_id", None))
    operador_id = _to_int(getattr(atendimento, "operador_id", None))

    if atendimento_id is None or empresa_id is None or operador_id is None:
        return

    active_ids = _list_active_participante_ids(
        db,
        empresa_id=int(empresa_id),
        atendimento_id=int(atendimento_id),
    )
    if active_ids:
        return

    _upsert_participante(
        db,
        atendimento=atendimento,
        colaborador_id=int(operador_id),
        is_responsavel=True,
    )


def ensure_participante_ativo_repo(
    db: Session,
    *,
    atendimento,
    colaborador_id: int | None,
    preferir_responsavel_se_vazio: bool = True,
):
    """
    Garante o vínculo sem permitir dois responsáveis ativos.

    Se já existe outro operador, o caller não pode roubar o atendimento apenas
    por receber/enviar uma mensagem. Se está livre ou já é do mesmo colaborador,
    o vínculo é normalizado de forma exclusiva.
    """
    if atendimento is None:
        return None

    colaborador_id_i = _to_int(colaborador_id)
    if colaborador_id_i is None:
        return None

    current_operator = _to_int(getattr(atendimento, "operador_id", None))
    if current_operator is not None and current_operator != int(colaborador_id_i):
        return None

    if not preferir_responsavel_se_vazio and current_operator is None:
        return _upsert_participante(
            db,
            atendimento=atendimento,
            colaborador_id=int(colaborador_id_i),
            is_responsavel=False,
        )

    locked = claim_if_available(
        db,
        atendimento=atendimento,
        colaborador_id=int(colaborador_id_i),
    )
    if locked is None:
        return None

    return (
        db.query(models.AtendimentoParticipante)
        .filter(
            models.AtendimentoParticipante.empresa_id == int(locked.empresa_id),
            models.AtendimentoParticipante.atendimento_id == int(locked.id),
            models.AtendimentoParticipante.colaborador_id == int(colaborador_id_i),
        )
        .first()
    )


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

    empresa_id_i = int(empresa_id)
    instancia_id_i = int(instancia_id)
    cliente_id_i = int(cliente_id)
    departamento_id_i = _to_int(departamento_id)
    operador_id_i = _to_int(operador_id)

    if not _instancia_exists_for_empresa(
        db,
        empresa_id=empresa_id_i,
        instancia_id=instancia_id_i,
    ):
        return None

    try:
        atendimento = ensure_open_atendimento_locked(
            db,
            empresa_id=empresa_id_i,
            cliente_id=cliente_id_i,
            instancia_id=instancia_id_i,
            departamento_id=departamento_id_i,
            ts_dt=ts_dt,
        )
        if atendimento is None:
            return None

        if departamento_id_i is not None:
            atendimento.departamento_id = int(departamento_id_i)

        if operador_id_i is not None:
            current_operator = _to_int(getattr(atendimento, "operador_id", None))
            if current_operator is None or current_operator == int(operador_id_i):
                atendimento = claim_if_available(
                    db,
                    atendimento=atendimento,
                    colaborador_id=int(operador_id_i),
                ) or atendimento

        db.add(atendimento)
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


def update_open_atendimento_departamento_repo(
    db: Session,
    *,
    empresa_id: int,
    instancia_id: int,
    cliente_id: int,
    departamento_id: int | None,
    ts_dt=None,
    operador_id: int | None = None,
    status_aguardando: bool = False,
    clear_operador: bool = False,
    clear_participantes: bool = False,
) -> Any | None:
    """Atualiza o atendimento aberto mantendo o invariável de um responsável."""
    empresa_id_i = int(empresa_id)
    instancia_id_i = int(instancia_id)
    cliente_id_i = int(cliente_id)
    departamento_id_i = _to_int(departamento_id)
    operador_id_i = _to_int(operador_id)

    try:
        if status_aguardando or clear_operador or clear_participantes:
            atendimento = set_waiting_department(
                db,
                empresa_id=empresa_id_i,
                cliente_id=cliente_id_i,
                instancia_id=instancia_id_i,
                departamento_id=departamento_id_i,
                ts_dt=ts_dt,
            )
        else:
            atendimento = ensure_open_atendimento_locked(
                db,
                empresa_id=empresa_id_i,
                cliente_id=cliente_id_i,
                instancia_id=instancia_id_i,
                departamento_id=departamento_id_i,
                ts_dt=ts_dt,
            )

        if atendimento is None:
            return None

        if departamento_id_i is not None:
            atendimento.departamento_id = int(departamento_id_i)

        if operador_id_i is not None and not clear_operador:
            current_operator = _to_int(getattr(atendimento, "operador_id", None))
            if current_operator is None or current_operator == int(operador_id_i):
                atendimento = claim_if_available(
                    db,
                    atendimento=atendimento,
                    colaborador_id=int(operador_id_i),
                ) or atendimento

        db.add(atendimento)
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
    "has_atendimento_participante_model",
    "get_or_open_atendimento_repo",
    "get_atendimento_id_repo",
    "update_open_atendimento_departamento_repo",
    "ensure_participante_ativo_repo",
    "attach_atendimento_to_message_if_supported",
]