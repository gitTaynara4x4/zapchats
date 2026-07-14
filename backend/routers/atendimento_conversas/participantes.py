# backend/routers/atendimento_conversas/participantes.py
from __future__ import annotations

from typing import Optional, List, Dict, Any

from fastapi import HTTPException
from sqlalchemy.orm import Session

from backend import models
from backend.services.atendimento_claim_state import (
    RESPONSAVEL_ROLE,
    PARTICIPANTE_ROLE,
    claim_exclusive_operator,
    deactivate_all_participants,
    release_to_queue,
    repair_single_responsible,
)

from .utils import (
    _participant_feature_enabled,
    _now_utc,
    _iso,
    _to_int,
    _default_fila_state,
    _fila_state_for_atendimento,
)

from .colaborador_helpers import (
    _colaborador_exists,
    _nome_colaborador,
)


# =========================================================
# Participantes / responsável único
# =========================================================
def _role_is_responsavel(value: Any) -> bool:
    return str(value or "").strip().lower() in {
        RESPONSAVEL_ROLE,
        "responsible",
        "owner",
    }


def _list_active_participant_rows(
    db: Session,
    *,
    empresa_id: int,
    atendimento_id: int,
):
    if not _participant_feature_enabled(db):
        return []

    AP = models.AtendimentoParticipante

    q = db.query(AP).filter(
        AP.empresa_id == int(empresa_id),
        AP.atendimento_id == int(atendimento_id),
    )

    if hasattr(AP, "is_ativo"):
        q = q.filter(AP.is_ativo.is_(True))
    elif hasattr(AP, "saiu_em"):
        q = q.filter(AP.saiu_em.is_(None))

    return q.order_by(AP.id.asc()).all()


def _active_participants_snapshot_map(
    db: Session,
    *,
    empresa_id: int,
    atendimento_ids: List[int],
) -> Dict[int, List[Dict[str, Any]]]:
    """
    Snapshot somente do responsável efetivo.

    Bancos antigos podem ter mais de um participante ativo. A tela não deve
    interpretar isso como atendimento compartilhado: operador_id é a fonte de
    verdade e, na ausência dele, escolhemos o vínculo responsável mais recente.
    As ações aceitar/liberar/transferir e a migração de startup normalizam o banco.
    """
    if not atendimento_ids or not _participant_feature_enabled(db):
        return {}

    AP = models.AtendimentoParticipante
    C = models.Colaborador
    A = models.Atendimento

    rows = (
        db.query(
            AP.id.label("participante_id"),
            AP.atendimento_id.label("atendimento_id"),
            AP.colaborador_id.label("colaborador_id"),
            AP.role.label("role"),
            AP.entrou_em.label("entrou_em"),
            C.nome.label("colaborador_nome"),
            A.operador_id.label("operador_id"),
        )
        .join(C, C.id == AP.colaborador_id)
        .join(A, A.id == AP.atendimento_id)
        .filter(
            AP.empresa_id == int(empresa_id),
            AP.atendimento_id.in_([int(x) for x in atendimento_ids]),
            AP.is_ativo.is_(True),
        )
        .all()
    )

    grouped: Dict[int, List[Any]] = {}
    for row in rows:
        grouped.setdefault(int(row.atendimento_id), []).append(row)

    out: Dict[int, List[Dict[str, Any]]] = {}

    for atendimento_id, candidates in grouped.items():
        candidates.sort(
            key=lambda r: (
                0
                if _to_int(getattr(r, "operador_id", None))
                == _to_int(getattr(r, "colaborador_id", None))
                else 1,
                0 if _role_is_responsavel(getattr(r, "role", None)) else 1,
                -int(getattr(r, "participante_id", 0) or 0),
            )
        )
        chosen = candidates[0]
        out[atendimento_id] = [
            {
                "colaborador_id": int(chosen.colaborador_id),
                "nome": chosen.colaborador_nome,
                "aceito_em": _iso(getattr(chosen, "entrou_em", None)),
                "is_responsavel": True,
                "role": RESPONSAVEL_ROLE,
            }
        ]

    return out


def _upsert_participante_ativo(
    db: Session,
    *,
    atendimento,
    colaborador_id: int,
    responsavel: bool = True,
):
    """
    Compatibilidade com callers antigos.

    No modelo atual, participante ativo é sempre o responsável único. Quando
    responsavel=False, apenas reativa o vínculo sem alterar operador, uso raro.
    """
    if not _participant_feature_enabled(db):
        return None

    if not _colaborador_exists(
        db,
        empresa_id=int(atendimento.empresa_id),
        colaborador_id=int(colaborador_id),
    ):
        raise HTTPException(
            status_code=409,
            detail=(
                "O colaborador autenticado não existe mais na tabela de colaboradores "
                "desta empresa. Atualize o vínculo do usuário com o colaborador."
            ),
        )

    if responsavel:
        locked = claim_exclusive_operator(
            db,
            atendimento=atendimento,
            colaborador_id=int(colaborador_id),
        )
        if locked is None:
            return None

        return (
            db.query(models.AtendimentoParticipante)
            .filter(
                models.AtendimentoParticipante.empresa_id == int(locked.empresa_id),
                models.AtendimentoParticipante.atendimento_id == int(locked.id),
                models.AtendimentoParticipante.colaborador_id == int(colaborador_id),
            )
            .first()
        )

    AP = models.AtendimentoParticipante
    row = (
        db.query(AP)
        .filter(
            AP.empresa_id == int(atendimento.empresa_id),
            AP.atendimento_id == int(atendimento.id),
            AP.colaborador_id == int(colaborador_id),
        )
        .with_for_update()
        .first()
    )
    now = _now_utc()
    if row is None:
        row = AP(
            empresa_id=int(atendimento.empresa_id),
            atendimento_id=int(atendimento.id),
            colaborador_id=int(colaborador_id),
        )
    row.is_ativo = True
    row.role = PARTICIPANTE_ROLE
    row.entrou_em = now
    row.saiu_em = None
    row.atualizado_em = now
    db.add(row)
    db.flush()
    return row


def _claim_exclusive_participant(
    db: Session,
    *,
    atendimento,
    colaborador_id: int,
):
    if not _participant_feature_enabled(db):
        atendimento.operador_id = int(colaborador_id)
        atendimento.status = models.StatusAtendimento.EM_ATENDIMENTO
        db.add(atendimento)
        db.flush()
        return atendimento

    return claim_exclusive_operator(
        db,
        atendimento=atendimento,
        colaborador_id=int(colaborador_id),
    )


def _release_all_participants(db: Session, *, atendimento):
    if not _participant_feature_enabled(db):
        atendimento.operador_id = None
        atendimento.status = (
            models.StatusAtendimento.AGUARDANDO
            if getattr(atendimento, "departamento_id", None) is not None
            else models.StatusAtendimento.NOVO
        )
        db.add(atendimento)
        db.flush()
        return atendimento

    return release_to_queue(db, atendimento=atendimento)


def _release_participante(
    db: Session,
    *,
    atendimento,
    colaborador_id: int,
) -> bool:
    """Compatibilidade: a liberação agora limpa todos os vínculos ativos."""
    operador_id = _to_int(getattr(atendimento, "operador_id", None))
    if operador_id is not None and operador_id != int(colaborador_id):
        return False
    _release_all_participants(db, atendimento=atendimento)
    return True


def _sync_atendimento_from_participants(
    db: Session,
    *,
    atendimento,
    preferred_responsavel_id: Optional[int] = None,
) -> List[int]:
    """
    Repara legados para a regra de um único responsável.

    preferred_responsavel_id, quando informado, vence e assume de forma
    exclusiva. Sem preferência, operador_id vence; se não houver operador,
    o vínculo ativo mais apropriado é mantido.
    """
    if preferred_responsavel_id is not None:
        locked = _claim_exclusive_participant(
            db,
            atendimento=atendimento,
            colaborador_id=int(preferred_responsavel_id),
        )
    else:
        locked = repair_single_responsible(db, atendimento=atendimento)

    if locked is None or getattr(locked, "operador_id", None) is None:
        return []
    return [int(locked.operador_id)]


def _participacao_payload(
    *,
    db: Session,
    atendimento,
    participants: List[Dict[str, Any]],
    current_colab_id: Optional[int],
    fila_state: Dict[str, Any],
    fallback_operador_id: Optional[int] = None,
    fallback_operador_nome: Optional[str] = None,
) -> Dict[str, Any]:
    operador_id = _to_int(
        getattr(atendimento, "operador_id", None)
        if atendimento is not None
        else fallback_operador_id
    )

    operador_nome = (
        _nome_colaborador(db, operador_id)
        if operador_id is not None
        else fallback_operador_nome
    )

    # Garante que o payload represente somente o responsável efetivo.
    if operador_id is not None:
        matching = [
            p for p in participants
            if _to_int(p.get("colaborador_id")) == int(operador_id)
        ]
        participants = matching or [
            {
                "colaborador_id": int(operador_id),
                "nome": operador_nome,
                "aceito_em": None,
                "is_responsavel": True,
                "role": RESPONSAVEL_ROLE,
            }
        ]
    elif participants:
        participants = [participants[0]]
        operador_id = _to_int(participants[0].get("colaborador_id"))
        operador_nome = participants[0].get("nome")

    participant_ids = [
        int(p["colaborador_id"])
        for p in participants
        if p.get("colaborador_id") is not None
    ]

    current_id = _to_int(current_colab_id)
    aceita_por_mim = bool(
        current_id is not None
        and operador_id is not None
        and int(current_id) == int(operador_id)
    )

    exigir_aceite = bool(fila_state.get("exigir_aceite"))
    waiting = operador_id is None

    if not exigir_aceite:
        pode_aceitar = False
        pode_liberar = False
        pode_responder = True
        aguardando_aceite = False
    else:
        pode_aceitar = bool(current_id is not None and waiting)
        pode_liberar = bool(aceita_por_mim)
        pode_responder = True if current_id is None else bool(aceita_por_mim)
        aguardando_aceite = bool(waiting or not aceita_por_mim)

    return {
        **fila_state,
        "aguardando_aceite": bool(aguardando_aceite),
        "pode_responder": bool(pode_responder),
        "participantes": participants,
        "participantes_ids": participant_ids,
        "aceita_por_mim": bool(aceita_por_mim),
        "tem_participantes": bool(operador_id is not None),
        "responsavel_id": operador_id,
        "responsavel_nome": operador_nome,
        "pode_aceitar": bool(pode_aceitar),
        "pode_liberar": bool(pode_liberar),
    }


def _attach_participacao_em_payloads(
    db: Session,
    *,
    empresa_id: int,
    items: List[Dict[str, Any]],
    current_colab_id: Optional[int],
):
    atendimento_ids = [
        int(x["atendimento_id"])
        for x in items
        if not x.get("is_group") and x.get("atendimento_id") is not None
    ]

    snap_map = _active_participants_snapshot_map(
        db,
        empresa_id=int(empresa_id),
        atendimento_ids=atendimento_ids,
    )

    atd_map: Dict[int, Any] = {}
    if atendimento_ids and hasattr(models, "Atendimento"):
        rows_atd = (
            db.query(models.Atendimento)
            .filter(
                models.Atendimento.empresa_id == int(empresa_id),
                models.Atendimento.id.in_([int(x) for x in atendimento_ids]),
            )
            .all()
        )
        atd_map = {int(a.id): a for a in rows_atd}

    for item in items:
        if item.get("is_group"):
            item.update(_default_fila_state())
            item["participantes"] = []
            item["participantes_ids"] = []
            item["aceita_por_mim"] = False
            item["tem_participantes"] = False
            item["responsavel_id"] = None
            item["responsavel_nome"] = None
            item["pode_aceitar"] = False
            item["pode_liberar"] = False
            item["pode_responder"] = True
            item["aguardando_aceite"] = False
            continue

        atd_id = item.get("atendimento_id")
        atd = atd_map.get(int(atd_id)) if atd_id is not None else None
        participants = snap_map.get(int(atd_id), []) if atd_id is not None else []

        if not participants and item.get("operador_id") is not None:
            participants = [
                {
                    "colaborador_id": int(item["operador_id"]),
                    "nome": item.get("operador_nome"),
                    "aceito_em": None,
                    "is_responsavel": True,
                    "role": RESPONSAVEL_ROLE,
                }
            ]

        fila_state = _fila_state_for_atendimento(db, atendimento=atd)

        item.update(
            _participacao_payload(
                db=db,
                atendimento=atd,
                participants=participants,
                current_colab_id=current_colab_id,
                fila_state=fila_state,
                fallback_operador_id=item.get("operador_id"),
                fallback_operador_nome=item.get("operador_nome"),
            )
        )


def _response_atendimento_estado(
    db: Session,
    *,
    atendimento,
    current_colab_id: Optional[int],
) -> Dict[str, Any]:
    participants: List[Dict[str, Any]] = []

    if atendimento is not None:
        snap_map = _active_participants_snapshot_map(
            db,
            empresa_id=int(atendimento.empresa_id),
            atendimento_ids=[int(atendimento.id)],
        )
        participants = snap_map.get(int(atendimento.id), [])

    if (
        not participants
        and atendimento is not None
        and getattr(atendimento, "operador_id", None) is not None
    ):
        participants = [
            {
                "colaborador_id": int(atendimento.operador_id),
                "nome": _nome_colaborador(db, int(atendimento.operador_id)),
                "aceito_em": _iso(getattr(atendimento, "aceito_em", None)),
                "is_responsavel": True,
                "role": RESPONSAVEL_ROLE,
            }
        ]

    fila_state = _fila_state_for_atendimento(db, atendimento=atendimento)

    return _participacao_payload(
        db=db,
        atendimento=atendimento,
        participants=participants,
        current_colab_id=current_colab_id,
        fila_state=fila_state,
    )
