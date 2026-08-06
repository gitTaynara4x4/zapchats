from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional, Any

from sqlalchemy.orm import Session

from backend import models


RESPONSAVEL_ROLE = "responsavel"
PARTICIPANTE_ROLE = "participant"


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _to_int(value: Any) -> Optional[int]:
    try:
        if value is None:
            return None
        return int(value)
    except Exception:
        return None


def open_status_values() -> list[Any]:
    enum_cls = getattr(models, "StatusAtendimento", None)
    if enum_cls is not None:
        values: list[Any] = []
        for name in ("NOVO", "AGUARDANDO", "EM_ATENDIMENTO", "PAUSADO"):
            if hasattr(enum_cls, name):
                values.append(getattr(enum_cls, name))
        if values:
            return values
    return ["novo", "aguardando", "em_atendimento", "pausado"]


def _status_novo() -> Any:
    enum_cls = getattr(models, "StatusAtendimento", None)
    return getattr(enum_cls, "NOVO", "novo") if enum_cls is not None else "novo"


def _status_aguardando() -> Any:
    enum_cls = getattr(models, "StatusAtendimento", None)
    return getattr(enum_cls, "AGUARDANDO", "aguardando") if enum_cls is not None else "aguardando"


def _status_em_atendimento() -> Any:
    enum_cls = getattr(models, "StatusAtendimento", None)
    return getattr(enum_cls, "EM_ATENDIMENTO", "em_atendimento") if enum_cls is not None else "em_atendimento"


def lock_cliente(
    db: Session,
    *,
    empresa_id: int,
    cliente_id: int,
):
    """Serializa qualquer mudança de estado da mesma conversa pelo cliente."""
    return (
        db.query(models.Cliente)
        .filter(
            models.Cliente.empresa_id == int(empresa_id),
            models.Cliente.id == int(cliente_id),
        )
        .with_for_update()
        .first()
    )


def get_open_atendimento_locked(
    db: Session,
    *,
    empresa_id: int,
    cliente_id: int,
    instancia_id: int,
):
    """Retorna o único atendimento aberto mais recente e bloqueia a linha."""
    return (
        db.query(models.Atendimento)
        .filter(
            models.Atendimento.empresa_id == int(empresa_id),
            models.Atendimento.cliente_id == int(cliente_id),
            models.Atendimento.instancia_id == int(instancia_id),
            models.Atendimento.status.in_(open_status_values()),
        )
        .order_by(models.Atendimento.id.desc())
        .with_for_update()
        .first()
    )


def ensure_open_atendimento_locked(
    db: Session,
    *,
    empresa_id: int,
    cliente_id: int,
    instancia_id: int,
    departamento_id: Optional[int] = None,
    ts_dt: Optional[datetime] = None,
    initial_status: Any = None,
):
    """
    Garante um atendimento aberto por empresa + cliente + instância.

    O bloqueio do cliente vem antes da consulta/criação. Isso impede duas rotas
    concorrentes (chatbot, recebimento, envio ou botão Atender) de criarem dois
    atendimentos abertos para a mesma conversa.
    """
    cliente = lock_cliente(
        db,
        empresa_id=int(empresa_id),
        cliente_id=int(cliente_id),
    )
    if cliente is None:
        return None

    atendimento = get_open_atendimento_locked(
        db,
        empresa_id=int(empresa_id),
        cliente_id=int(cliente_id),
        instancia_id=int(instancia_id),
    )

    now = ts_dt or _now_utc()

    if atendimento is None:
        atendimento = models.Atendimento(
            empresa_id=int(empresa_id),
            cliente_id=int(cliente_id),
            instancia_id=int(instancia_id),
            departamento_id=(int(departamento_id) if departamento_id is not None else None),
            operador_id=None,
            status=initial_status if initial_status is not None else _status_novo(),
            criado_em=now,
            atualizado_em=now,
        )
        db.add(atendimento)
        db.flush()
        # A linha recém-criada já pertence à transação atual.
    else:
        if departamento_id is not None:
            atendimento.departamento_id = int(departamento_id)
        atendimento.instancia_id = int(instancia_id)
        if hasattr(atendimento, "atualizado_em"):
            atendimento.atualizado_em = now
        db.add(atendimento)
        db.flush()

    return atendimento


def _lock_all_participants(db: Session, *, atendimento_id: int, empresa_id: int):
    AP = getattr(models, "AtendimentoParticipante", None)
    if AP is None:
        return []

    try:
        return (
            db.query(AP)
            .filter(
                AP.empresa_id == int(empresa_id),
                AP.atendimento_id == int(atendimento_id),
            )
            .order_by(AP.id.asc())
            .with_for_update()
            .all()
        )
    except Exception:
        return []


def _row_is_active(row) -> bool:
    if hasattr(row, "is_ativo"):
        return bool(getattr(row, "is_ativo", False))
    if hasattr(row, "saiu_em"):
        return getattr(row, "saiu_em", None) is None
    return True


def _deactivate_row(row, *, now: datetime) -> None:
    if hasattr(row, "is_ativo"):
        row.is_ativo = False
    if hasattr(row, "role"):
        row.role = PARTICIPANTE_ROLE
    if hasattr(row, "saiu_em"):
        row.saiu_em = now
    if hasattr(row, "atualizado_em"):
        row.atualizado_em = now


def deactivate_all_participants(db: Session, *, atendimento) -> None:
    atendimento_id = _to_int(getattr(atendimento, "id", None))
    empresa_id = _to_int(getattr(atendimento, "empresa_id", None))
    if atendimento_id is None or empresa_id is None:
        return

    now = _now_utc()
    for row in _lock_all_participants(
        db,
        atendimento_id=int(atendimento_id),
        empresa_id=int(empresa_id),
    ):
        if not _row_is_active(row):
            continue
        _deactivate_row(row, now=now)
        db.add(row)
    db.flush()


def _activate_participant(
    db: Session,
    *,
    atendimento,
    colaborador_id: int,
    responsavel: bool = False,
):
    """Ativa um colaborador sem remover os demais participantes.

    O atendimento pode ter vários participantes ativos, mas somente um deles
    permanece com role=responsavel e espelha atendimentos.operador_id.
    """
    AP = getattr(models, "AtendimentoParticipante", None)
    if AP is None:
        return None

    atendimento_id = int(atendimento.id)
    empresa_id = int(atendimento.empresa_id)
    colaborador_id = int(colaborador_id)
    now = _now_utc()

    rows = _lock_all_participants(
        db,
        atendimento_id=atendimento_id,
        empresa_id=empresa_id,
    )

    target = None
    for row in rows:
        if _to_int(getattr(row, "colaborador_id", None)) == colaborador_id:
            target = row
            continue

        if responsavel and _row_is_active(row) and str(getattr(row, "role", "") or "").lower() == RESPONSAVEL_ROLE:
            row.role = PARTICIPANTE_ROLE
            if hasattr(row, "atualizado_em"):
                row.atualizado_em = now
            db.add(row)

    was_active = bool(target is not None and _row_is_active(target))
    if target is None:
        target = AP(
            empresa_id=empresa_id,
            atendimento_id=atendimento_id,
            colaborador_id=colaborador_id,
        )
        db.add(target)
        db.flush()

    if hasattr(target, "is_ativo"):
        target.is_ativo = True
    if hasattr(target, "role"):
        target.role = RESPONSAVEL_ROLE if responsavel else PARTICIPANTE_ROLE
    if hasattr(target, "entrou_em") and (not was_active or getattr(target, "entrou_em", None) is None):
        target.entrou_em = now
    if hasattr(target, "saiu_em"):
        target.saiu_em = None
    if hasattr(target, "atualizado_em"):
        target.atualizado_em = now

    db.add(target)
    db.flush()
    return target


def claim_exclusive_operator(
    db: Session,
    *,
    atendimento,
    colaborador_id: int,
):
    """Define o responsável principal preservando participantes ativos.

    O nome da função é mantido por compatibilidade com callers antigos. A
    exclusividade agora vale somente para o papel de responsável, não para a
    participação na conversa.
    """
    locked = (
        db.query(models.Atendimento)
        .filter(
            models.Atendimento.id == int(atendimento.id),
            models.Atendimento.empresa_id == int(atendimento.empresa_id),
        )
        .with_for_update()
        .first()
    )
    if locked is None:
        return None

    _activate_participant(
        db,
        atendimento=locked,
        colaborador_id=int(colaborador_id),
        responsavel=True,
    )

    now = _now_utc()
    locked.operador_id = int(colaborador_id)
    locked.status = _status_em_atendimento()
    if hasattr(locked, "aceito_em"):
        locked.aceito_em = getattr(locked, "aceito_em", None) or now
    if hasattr(locked, "atualizado_em"):
        locked.atualizado_em = now
    db.add(locked)
    db.flush()
    return locked


def join_participant(
    db: Session,
    *,
    atendimento,
    colaborador_id: int,
):
    """Entra no atendimento sem tomar a responsabilidade de outra pessoa.

    Se a conversa ainda não possui responsável, quem entra primeiro vira o
    responsável principal. Caso contrário, entra apenas como participante.
    """
    locked = (
        db.query(models.Atendimento)
        .filter(
            models.Atendimento.id == int(atendimento.id),
            models.Atendimento.empresa_id == int(atendimento.empresa_id),
        )
        .with_for_update()
        .first()
    )
    if locked is None:
        return None

    current = _to_int(getattr(locked, "operador_id", None))
    become_responsavel = current is None or current == int(colaborador_id)

    _activate_participant(
        db,
        atendimento=locked,
        colaborador_id=int(colaborador_id),
        responsavel=bool(become_responsavel),
    )

    now = _now_utc()
    if current is None:
        locked.operador_id = int(colaborador_id)
        if hasattr(locked, "aceito_em"):
            locked.aceito_em = now
    locked.status = _status_em_atendimento()
    if hasattr(locked, "atualizado_em"):
        locked.atualizado_em = now
    db.add(locked)
    db.flush()
    return locked


def claim_if_available(
    db: Session,
    *,
    atendimento,
    colaborador_id: int,
):
    """
    Assume somente se o atendimento estiver livre ou já tiver esse responsável.
    Nunca toma a responsabilidade principal de outro colaborador.
    """
    locked = (
        db.query(models.Atendimento)
        .filter(
            models.Atendimento.id == int(atendimento.id),
            models.Atendimento.empresa_id == int(atendimento.empresa_id),
        )
        .with_for_update()
        .first()
    )
    if locked is None:
        return None

    current = _to_int(getattr(locked, "operador_id", None))
    if current is not None and current != int(colaborador_id):
        return None

    return claim_exclusive_operator(
        db,
        atendimento=locked,
        colaborador_id=int(colaborador_id),
    )


def release_participant(
    db: Session,
    *,
    atendimento,
    colaborador_id: int,
) -> dict[str, Any]:
    """Remove somente um participante e mantém a conversa ativa se possível.

    Se quem sair for o responsável principal, outro participante ativo é
    promovido. A conversa só volta para a fila quando não restar ninguém.
    """
    locked = (
        db.query(models.Atendimento)
        .filter(
            models.Atendimento.id == int(atendimento.id),
            models.Atendimento.empresa_id == int(atendimento.empresa_id),
        )
        .with_for_update()
        .first()
    )
    if locked is None:
        return {
            "atendimento": None,
            "removed": False,
            "released_to_queue": False,
            "promoted_responsavel_id": None,
        }

    rows = _lock_all_participants(
        db,
        atendimento_id=int(locked.id),
        empresa_id=int(locked.empresa_id),
    )
    target = next(
        (
            r
            for r in rows
            if _to_int(getattr(r, "colaborador_id", None)) == int(colaborador_id)
            and _row_is_active(r)
        ),
        None,
    )

    if target is None:
        return {
            "atendimento": locked,
            "removed": False,
            "released_to_queue": getattr(locked, "operador_id", None) is None,
            "promoted_responsavel_id": None,
        }

    now = _now_utc()
    was_responsavel = (
        _to_int(getattr(locked, "operador_id", None)) == int(colaborador_id)
        or str(getattr(target, "role", "") or "").lower() == RESPONSAVEL_ROLE
    )
    _deactivate_row(target, now=now)
    db.add(target)
    db.flush()

    remaining = [
        r
        for r in rows
        if r is not target and _row_is_active(r)
    ]

    promoted_id = None
    if remaining:
        current_operator = _to_int(getattr(locked, "operador_id", None))
        chosen = None
        if not was_responsavel and current_operator is not None:
            chosen = next(
                (r for r in remaining if _to_int(getattr(r, "colaborador_id", None)) == current_operator),
                None,
            )

        if chosen is None:
            chosen = sorted(
                remaining,
                key=lambda r: (
                    0 if str(getattr(r, "role", "") or "").lower() == RESPONSAVEL_ROLE else 1,
                    int(getattr(r, "id", 0) or 0),
                ),
            )[0]

        chosen_colab_id = _to_int(getattr(chosen, "colaborador_id", None))
        for row in remaining:
            if hasattr(row, "role"):
                row.role = RESPONSAVEL_ROLE if row is chosen else PARTICIPANTE_ROLE
            if hasattr(row, "atualizado_em"):
                row.atualizado_em = now
            db.add(row)

        if chosen_colab_id is not None:
            locked.operador_id = int(chosen_colab_id)
            locked.status = _status_em_atendimento()
            if was_responsavel:
                promoted_id = int(chosen_colab_id)
    else:
        locked.operador_id = None
        locked.status = _status_aguardando() if locked.departamento_id is not None else _status_novo()
        if hasattr(locked, "aceito_em"):
            locked.aceito_em = None

    if hasattr(locked, "atualizado_em"):
        locked.atualizado_em = now
    db.add(locked)
    db.flush()

    return {
        "atendimento": locked,
        "removed": True,
        "was_responsavel": bool(was_responsavel),
        "released_to_queue": not bool(remaining),
        "promoted_responsavel_id": promoted_id,
    }


def release_to_queue(db: Session, *, atendimento):
    """Remove todos os participantes e devolve a conversa para a fila."""
    locked = (
        db.query(models.Atendimento)
        .filter(
            models.Atendimento.id == int(atendimento.id),
            models.Atendimento.empresa_id == int(atendimento.empresa_id),
        )
        .with_for_update()
        .first()
    )
    if locked is None:
        return None

    deactivate_all_participants(db, atendimento=locked)

    now = _now_utc()
    locked.operador_id = None
    locked.status = _status_aguardando() if locked.departamento_id is not None else _status_novo()
    if hasattr(locked, "aceito_em"):
        locked.aceito_em = None
    if hasattr(locked, "atualizado_em"):
        locked.atualizado_em = now
    db.add(locked)
    db.flush()
    return locked


def set_waiting_department(
    db: Session,
    *,
    empresa_id: int,
    cliente_id: int,
    instancia_id: int,
    departamento_id: Optional[int],
    ts_dt: Optional[datetime] = None,
):
    """Estado usado pelo chatbot: departamento escolhido, ninguém assumiu."""
    atendimento = ensure_open_atendimento_locked(
        db,
        empresa_id=int(empresa_id),
        cliente_id=int(cliente_id),
        instancia_id=int(instancia_id),
        departamento_id=(int(departamento_id) if departamento_id is not None else None),
        ts_dt=ts_dt,
        initial_status=_status_aguardando() if departamento_id is not None else _status_novo(),
    )
    if atendimento is None:
        return None

    atendimento.departamento_id = int(departamento_id) if departamento_id is not None else None
    atendimento.fila_id = None
    if hasattr(atendimento, "fila_escolhida_em"):
        atendimento.fila_escolhida_em = None

    atendimento = release_to_queue(db, atendimento=atendimento)
    if atendimento is not None and departamento_id is None:
        atendimento.status = _status_novo()
        db.add(atendimento)
        db.flush()
    return atendimento


def repair_single_responsible(db: Session, *, atendimento):
    """Repara a responsabilidade sem apagar participantes válidos.

    - operador_id existente vence e vira o único role=responsavel;
    - sem operador, escolhe um participante ativo para ser responsável;
    - os demais continuam ativos como participant;
    - sem participantes, a conversa volta para aguardando/novo.
    """
    locked = (
        db.query(models.Atendimento)
        .filter(
            models.Atendimento.id == int(atendimento.id),
            models.Atendimento.empresa_id == int(atendimento.empresa_id),
        )
        .with_for_update()
        .first()
    )
    if locked is None:
        return None

    rows = _lock_all_participants(
        db,
        atendimento_id=int(locked.id),
        empresa_id=int(locked.empresa_id),
    )
    active = [r for r in rows if _row_is_active(r)]
    operador_id = _to_int(getattr(locked, "operador_id", None))

    chosen = None
    if operador_id is not None:
        chosen = next(
            (r for r in rows if _to_int(getattr(r, "colaborador_id", None)) == operador_id),
            None,
        )
        if chosen is None:
            AP = getattr(models, "AtendimentoParticipante", None)
            if AP is not None:
                chosen = AP(
                    empresa_id=int(locked.empresa_id),
                    atendimento_id=int(locked.id),
                    colaborador_id=int(operador_id),
                )
                db.add(chosen)
                db.flush()
                rows.append(chosen)
        if chosen is not None and chosen not in active:
            active.append(chosen)
    elif active:
        chosen = sorted(
            active,
            key=lambda r: (
                0 if str(getattr(r, "role", "") or "").lower() == RESPONSAVEL_ROLE else 1,
                -int(getattr(r, "id", 0) or 0),
            ),
        )[0]
        operador_id = _to_int(getattr(chosen, "colaborador_id", None))

    now = _now_utc()

    if chosen is not None and operador_id is not None:
        if hasattr(chosen, "is_ativo"):
            chosen.is_ativo = True
        if hasattr(chosen, "saiu_em"):
            chosen.saiu_em = None
        if hasattr(chosen, "entrou_em") and getattr(chosen, "entrou_em", None) is None:
            chosen.entrou_em = now

        for row in rows:
            if not _row_is_active(row) and row is not chosen:
                continue
            if hasattr(row, "role"):
                row.role = RESPONSAVEL_ROLE if row is chosen else PARTICIPANTE_ROLE
            if hasattr(row, "atualizado_em"):
                row.atualizado_em = now
            db.add(row)

        locked.operador_id = int(operador_id)
        locked.status = _status_em_atendimento()
        if hasattr(locked, "aceito_em"):
            locked.aceito_em = getattr(locked, "aceito_em", None) or now
    else:
        locked.operador_id = None
        locked.status = _status_aguardando() if locked.departamento_id is not None else _status_novo()
        if hasattr(locked, "aceito_em"):
            locked.aceito_em = None

    if hasattr(locked, "atualizado_em"):
        locked.atualizado_em = now
    db.add(locked)
    db.flush()
    return locked

