#backend\routers\atendimento_conversas\participantes.py
from __future__ import annotations

from typing import Optional, List, Dict, Any

from fastapi import HTTPException
from sqlalchemy.orm import Session
from sqlalchemy import literal

from backend import models

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
# Participantes / aceite compartilhado
# =========================================================
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

    return q.order_by(AP.id.asc()).all()


def _active_participants_snapshot_map(
    db: Session,
    *,
    empresa_id: int,
    atendimento_ids: List[int],
) -> Dict[int, List[Dict[str, Any]]]:
    if not atendimento_ids or not _participant_feature_enabled(db):
        return {}

    AP = models.AtendimentoParticipante
    C = models.Colaborador

    cols = [
        AP.atendimento_id.label("atendimento_id"),
        AP.colaborador_id.label("colaborador_id"),
        C.nome.label("colaborador_nome"),
        (AP.aceito_em if hasattr(AP, "aceito_em") else literal(None)).label("aceito_em"),
        (AP.is_responsavel if hasattr(AP, "is_responsavel") else literal(False)).label("is_responsavel"),
    ]

    q = (
        db.query(*cols)
        .join(C, C.id == AP.colaborador_id)
        .filter(
            AP.empresa_id == int(empresa_id),
            AP.atendimento_id.in_([int(x) for x in atendimento_ids]),
        )
    )

    if hasattr(AP, "is_ativo"):
        q = q.filter(AP.is_ativo.is_(True))

    rows = q.all()

    out: Dict[int, List[Dict[str, Any]]] = {}

    for r in rows:
        aid = int(r.atendimento_id)

        out.setdefault(aid, []).append(
            {
                "colaborador_id": int(r.colaborador_id),
                "nome": r.colaborador_nome,
                "aceito_em": _iso(getattr(r, "aceito_em", None)),
                "is_responsavel": bool(getattr(r, "is_responsavel", False)),
            }
        )

    for aid in out.keys():
        out[aid].sort(
            key=lambda x: (
                0 if x.get("is_responsavel") else 1,
                str(x.get("nome") or "").lower(),
                int(x.get("colaborador_id") or 0),
            )
        )

    return out


def _upsert_participante_ativo(
    db: Session,
    *,
    atendimento,
    colaborador_id: int,
):
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

    AP = models.AtendimentoParticipante

    row = (
        db.query(AP)
        .filter(
            AP.empresa_id == int(atendimento.empresa_id),
            AP.atendimento_id == int(atendimento.id),
            AP.colaborador_id == int(colaborador_id),
        )
        .order_by(AP.id.desc())
        .first()
    )

    now = _now_utc()

    if row is None:
        kwargs = {}

        for field, value in (
            ("empresa_id", int(atendimento.empresa_id)),
            ("atendimento_id", int(atendimento.id)),
            (
                "cliente_id",
                int(atendimento.cliente_id)
                if getattr(atendimento, "cliente_id", None) is not None
                else None,
            ),
            (
                "instancia_id",
                int(atendimento.instancia_id)
                if getattr(atendimento, "instancia_id", None) is not None
                else None,
            ),
            (
                "departamento_id",
                int(atendimento.departamento_id)
                if getattr(atendimento, "departamento_id", None) is not None
                else None,
            ),
            ("colaborador_id", int(colaborador_id)),
        ):
            if hasattr(AP, field):
                kwargs[field] = value

        row = AP(**kwargs)
        db.add(row)
        db.flush()

    else:
        for field, value in (
            (
                "cliente_id",
                int(atendimento.cliente_id)
                if getattr(atendimento, "cliente_id", None) is not None
                else None,
            ),
            (
                "instancia_id",
                int(atendimento.instancia_id)
                if getattr(atendimento, "instancia_id", None) is not None
                else None,
            ),
            (
                "departamento_id",
                int(atendimento.departamento_id)
                if getattr(atendimento, "departamento_id", None) is not None
                else None,
            ),
        ):
            if hasattr(row, field):
                setattr(row, field, value)

    if hasattr(row, "is_ativo"):
        row.is_ativo = True

    if hasattr(row, "saiu_em"):
        row.saiu_em = None

    if hasattr(row, "liberado_em"):
        row.liberado_em = None

    if hasattr(row, "aceito_em"):
        row.aceito_em = now

    if hasattr(row, "ultimo_evento_em"):
        row.ultimo_evento_em = now

    if hasattr(row, "ultimo_envio_em") and getattr(row, "ultimo_envio_em", None) is None:
        row.ultimo_envio_em = None

    db.add(row)

    return row


def _release_participante(
    db: Session,
    *,
    atendimento,
    colaborador_id: int,
) -> bool:
    if not _participant_feature_enabled(db):
        return False

    AP = models.AtendimentoParticipante

    row = (
        db.query(AP)
        .filter(
            AP.empresa_id == int(atendimento.empresa_id),
            AP.atendimento_id == int(atendimento.id),
            AP.colaborador_id == int(colaborador_id),
        )
        .order_by(AP.id.desc())
        .first()
    )

    if not row:
        return False

    now = _now_utc()

    if hasattr(row, "is_ativo"):
        row.is_ativo = False

    if hasattr(row, "is_responsavel"):
        row.is_responsavel = False

    if hasattr(row, "liberado_em"):
        row.liberado_em = now

    if hasattr(row, "saiu_em"):
        row.saiu_em = now

    if hasattr(row, "ultimo_evento_em"):
        row.ultimo_evento_em = now

    db.add(row)

    return True


def _sync_atendimento_from_participants(
    db: Session,
    *,
    atendimento,
    preferred_responsavel_id: Optional[int] = None,
) -> List[int]:
    """
    Sincroniza operador_id/status a partir dos participantes ativos.
    """
    if not _participant_feature_enabled(db):
        return []

    rows = _list_active_participant_rows(
        db,
        empresa_id=int(atendimento.empresa_id),
        atendimento_id=int(atendimento.id),
    )

    active_ids: List[int] = []
    chosen_id: Optional[int] = None

    for r in rows:
        cid = _to_int(getattr(r, "colaborador_id", None))

        if cid and cid not in active_ids:
            active_ids.append(cid)

    if not active_ids:
        atendimento.operador_id = None
        atendimento.status = (
            models.StatusAtendimento.AGUARDANDO
            if getattr(atendimento, "departamento_id", None) is not None
            else models.StatusAtendimento.NOVO
        )
        db.add(atendimento)
        return []

    if preferred_responsavel_id is not None and int(preferred_responsavel_id) in set(active_ids):
        chosen_id = int(preferred_responsavel_id)

    if chosen_id is None:
        current_operator = _to_int(getattr(atendimento, "operador_id", None))

        if current_operator is not None and current_operator in set(active_ids):
            chosen_id = current_operator

    if chosen_id is None:
        for r in rows:
            cid = _to_int(getattr(r, "colaborador_id", None))

            if cid and bool(getattr(r, "is_responsavel", False)):
                chosen_id = cid
                break

    if chosen_id is None:
        chosen_id = int(active_ids[0])

    if hasattr(models.AtendimentoParticipante, "is_responsavel"):
        for r in rows:
            cid = _to_int(getattr(r, "colaborador_id", None))
            r.is_responsavel = bool(cid == chosen_id)
            db.add(r)

    atendimento.operador_id = int(chosen_id)
    atendimento.status = models.StatusAtendimento.EM_ATENDIMENTO

    db.add(atendimento)

    return active_ids


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
    participant_ids = [
        int(p["colaborador_id"])
        for p in participants
        if p.get("colaborador_id") is not None
    ]

    aceita_por_mim = (
        current_colab_id is not None
        and int(current_colab_id) in set(participant_ids)
    )

    responsavel = next((p for p in participants if p.get("is_responsavel")), None)

    if responsavel is None and participants:
        responsavel = participants[0]

    legacy_operator_id = _to_int(
        getattr(atendimento, "operador_id", None)
        if atendimento is not None
        else fallback_operador_id
    )

    legacy_operator_nome = (
        _nome_colaborador(db, legacy_operator_id)
        if legacy_operator_id is not None
        else fallback_operador_nome
    )

    exigir_aceite = bool(fila_state.get("exigir_aceite"))

    if not exigir_aceite:
        pode_aceitar = False
        pode_liberar = False
        pode_responder = True
        aguardando_aceite = False
    else:
        pode_aceitar = current_colab_id is not None and not bool(aceita_por_mim)
        pode_liberar = current_colab_id is not None and bool(aceita_por_mim)
        pode_responder = True if current_colab_id is None else bool(aceita_por_mim)
        aguardando_aceite = bool(current_colab_id is not None and not bool(aceita_por_mim))

    return {
        **fila_state,
        "aguardando_aceite": aguardando_aceite,
        "pode_responder": bool(pode_responder),
        "participantes": participants,
        "participantes_ids": participant_ids,
        "aceita_por_mim": bool(aceita_por_mim),
        "tem_participantes": bool(participants),
        "responsavel_id": (
            int(responsavel["colaborador_id"])
            if responsavel and responsavel.get("colaborador_id") is not None
            else legacy_operator_id
        ),
        "responsavel_nome": (
            responsavel.get("nome")
            if responsavel
            else legacy_operator_nome
        ),
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

        # fallback antigo: sem tabela de participantes, sintetiza pelo operador
        if not participants and item.get("operador_id") is not None:
            participants = [
                {
                    "colaborador_id": int(item["operador_id"]),
                    "nome": item.get("operador_nome"),
                    "aceito_em": None,
                    "is_responsavel": True,
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
                "aceito_em": None,
                "is_responsavel": True,
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
