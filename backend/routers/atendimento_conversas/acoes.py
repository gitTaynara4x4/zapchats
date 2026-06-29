#backend\routers\atendimento_conversas\acoes.py
from __future__ import annotations

from typing import Optional, Dict, Any

from fastapi import APIRouter, Depends, HTTPException, Body
from sqlalchemy.orm import Session

from backend.database import get_db
from backend import models
from backend.routers.auth import get_current_identity
from backend.security.atendimento_acl import (
    ensure_perm,
    resolve_acl_context,
    assert_instancia_allowed,
)

from .schemas import (
    AceitarConversaIn,
    LiberarConversaIn,
    TransferirColaboradorIn,
)

from .utils import (
    _resolve_instancia_id,
    _status_to_str,
    _to_int,
    _get_atendimento_caps,
    _participant_feature_enabled,
)

from .colaborador_helpers import (
    _resolve_identity_colab_id,
    _cliente_instancia_mais_recente,
    _latest_atendimento_for_cliente_instancia,
    _assert_departamento_acl_for_row,
    _instancia_permitida_para_colaborador,
    _departamento_permitido_para_colaborador,
    _nome_colaborador,
)

from .participantes import (
    _active_participants_snapshot_map,
    _upsert_participante_ativo,
    _sync_atendimento_from_participants,
    _release_participante,
    _response_atendimento_estado,
)

router = APIRouter(tags=["Atendimento – Conversas"])


def _identity_empresa_id(identity) -> Optional[int]:
    try:
        if isinstance(identity, dict):
            v = identity.get("empresa_id")
        else:
            v = getattr(identity, "empresa_id", None)

        if v is None:
            return None

        return int(v)
    except Exception:
        return None


def _empresa_id_segura(identity, empresa_id_payload: Optional[int] = None) -> int:
    """
    Segurança multiempresa:
    - A empresa oficial vem SEMPRE da identidade/token do usuário logado.
    - Se o frontend mandar empresa_id diferente, bloqueia.
    - Se o frontend não mandar empresa_id, usa normalmente a empresa do usuário.
    """
    emp_real = _identity_empresa_id(identity)

    if emp_real is None:
        raise HTTPException(status_code=401, detail="Empresa ausente na sessão")

    if empresa_id_payload is not None:
        try:
            emp_req = int(empresa_id_payload)
        except Exception:
            raise HTTPException(status_code=400, detail="empresa_id inválido")

        if emp_req != emp_real:
            raise HTTPException(status_code=403, detail="Empresa inválida para este usuário")

    return int(emp_real)




def _claim_single_responsavel(db: Session, *, atendimento, colaborador_id: int):
    """
    Modelo por departamento: quem clicar em Atender primeiro assume.
    Mantém no máximo um participante ativo/responsável para esse atendimento.
    """
    if not _participant_feature_enabled(db):
        return None

    AP = models.AtendimentoParticipante
    atendimento_id = int(getattr(atendimento, "id"))
    empresa_id = int(getattr(atendimento, "empresa_id"))

    # Desativa qualquer participante anterior diferente do novo responsável.
    rows = (
        db.query(AP)
        .filter(
            AP.empresa_id == empresa_id,
            AP.atendimento_id == atendimento_id,
        )
        .all()
    )

    for row in rows:
        rid = _to_int(getattr(row, "colaborador_id", None))

        if rid != int(colaborador_id):
            if hasattr(row, "is_ativo"):
                row.is_ativo = False
            if hasattr(row, "is_responsavel"):
                row.is_responsavel = False
            db.add(row)

    row = _upsert_participante_ativo(
        db,
        atendimento=atendimento,
        colaborador_id=int(colaborador_id),
    )

    if row is not None and hasattr(row, "is_responsavel"):
        row.is_responsavel = True
        db.add(row)

    return row


def _department_claim_enabled(atendimento) -> bool:
    try:
        return getattr(atendimento, "departamento_id", None) is not None
    except Exception:
        return False


def _claim_mode_payload(part_info: Dict[str, Any], atendimento, current_colab_id: Optional[int]) -> Dict[str, Any]:
    """Campos extras para o front diferenciar fila antiga de Atender por departamento."""
    dep_claim = _department_claim_enabled(atendimento)
    if not dep_claim:
        return {}

    operador_id = _to_int(getattr(atendimento, "operador_id", None))
    colab_id = _to_int(current_colab_id)
    assigned_to_me = bool(operador_id is not None and colab_id is not None and operador_id == colab_id)
    waiting = operador_id is None

    return {
        "claim_mode": "departamento",
        "departamento_claim": True,
        "exigir_aceite": True,
        "aceite_obrigatorio": True,
        "aguardando_aceite": bool(waiting or not assigned_to_me),
        "pode_aceitar": bool(waiting and colab_id is not None),
        "pode_liberar": bool(assigned_to_me),
        "pode_responder": bool(assigned_to_me or colab_id is None),
        "aceita_por_mim": bool(assigned_to_me),
        "accepted_by_me": bool(assigned_to_me),
        "accepted_by_anyone": bool(operador_id is not None),
    }

# =========================================================
# POST /conversas/{cliente_id}/aceitar
# =========================================================
@router.post("/conversas/{cliente_id}/aceitar")
def aceitar_conversa(
    cliente_id: int,
    payload: Optional[AceitarConversaIn] = Body(None),
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
):
    ensure_perm(identity, "atendimento.ver")

    payload = payload or AceitarConversaIn()

    empresa_id_req = _empresa_id_segura(identity, payload.empresa_id)

    acl_ctx = resolve_acl_context(db, identity=identity, empresa_id=empresa_id_req)
    empresa_id = int(acl_ctx["empresa_id"])
    allowed_inst_ids = acl_ctx["allowed_instancias"]
    allowed_dep_ids = acl_ctx["allowed_departamentos"]

    colab_id = _resolve_identity_colab_id(
        db,
        identity=identity,
        empresa_id=int(empresa_id),
        required=True,
    )

    cliente = (
        db.query(models.Cliente)
        .filter(
            models.Cliente.empresa_id == int(empresa_id),
            models.Cliente.id == int(cliente_id),
        )
        .first()
    )

    if not cliente:
        raise HTTPException(status_code=404, detail="Cliente não encontrado")

    resolved_inst_id, _resolved_inst_name = _resolve_instancia_id(
        db,
        empresa_id=empresa_id,
        instancia_id=payload.instancia_id,
        instance=payload.instance,
    )

    if (payload.instancia_id is not None or payload.instance) and resolved_inst_id is None:
        raise HTTPException(status_code=404, detail="Instância não encontrada para a empresa.")

    if resolved_inst_id is None:
        resolved_inst_id = _cliente_instancia_mais_recente(
            db,
            empresa_id=empresa_id,
            cliente_id=int(cliente_id),
            allowed_inst_ids=allowed_inst_ids,
        )

    if resolved_inst_id is None:
        raise HTTPException(
            status_code=400,
            detail="Não foi possível resolver a instância da conversa",
        )

    assert_instancia_allowed(
        allowed_instancias=allowed_inst_ids,
        instancia_id=resolved_inst_id,
    )

    atd = _latest_atendimento_for_cliente_instancia(
        db,
        empresa_id=empresa_id,
        cliente_id=int(cliente_id),
        instancia_id=resolved_inst_id,
    )

    departamento_acl = (
        getattr(atd, "departamento_id", None)
        if atd is not None and hasattr(atd, "departamento_id")
        else getattr(cliente, "departamento_id", None)
    )

    _assert_departamento_acl_for_row(
        allowed_dep_ids=allowed_dep_ids,
        departamento_id=departamento_acl,
    )

    status_enum = getattr(models, "StatusAtendimento", None)

    STATUS_NOVO = (
        getattr(status_enum, "NOVO", "novo")
        if status_enum is not None
        else "novo"
    )

    STATUS_EM_ATENDIMENTO = (
        getattr(status_enum, "EM_ATENDIMENTO", "em_atendimento")
        if status_enum is not None
        else "em_atendimento"
    )

    if atd is None:
        caps = _get_atendimento_caps()
        A = caps["model"]

        if A is None or not caps["usable"]:
            raise HTTPException(
                status_code=500,
                detail="Model Atendimento indisponível para criar aceite da conversa",
            )

        create_data: Dict[str, Any] = {
            "cliente_id": int(cliente_id),
            "instancia_id": int(resolved_inst_id),
        }

        if caps["has_empresa_id"]:
            create_data["empresa_id"] = int(empresa_id)

        if caps["has_departamento_id"]:
            create_data["departamento_id"] = getattr(cliente, "departamento_id", None)

        if caps["has_operador_id"]:
            create_data["operador_id"] = None

        if caps["has_status"]:
            create_data["status"] = STATUS_NOVO

        atd = A(**create_data)
        db.add(atd)
        db.flush()

    if hasattr(atd, "instancia_id"):
        atd.instancia_id = int(resolved_inst_id)

    if (
        hasattr(atd, "departamento_id")
        and getattr(atd, "departamento_id", None) is None
        and getattr(cliente, "departamento_id", None) is not None
    ):
        atd.departamento_id = getattr(cliente, "departamento_id", None)

    operador_atual = (
        getattr(atd, "operador_id", None)
        if hasattr(atd, "operador_id")
        else None
    )

    status_atual = (
        _status_to_str(getattr(atd, "status", None))
        if hasattr(atd, "status")
        else None
    )

    if operador_atual is not None and int(operador_atual) != int(colab_id):
        raise HTTPException(
            status_code=409,
            detail="Esse atendimento já foi assumido por outro colaborador",
        )

    already_accepted = (
        operador_atual is not None
        and int(operador_atual) == int(colab_id)
        and status_atual == "em_atendimento"
    )

    if _participant_feature_enabled(db):
        _claim_single_responsavel(
            db,
            atendimento=atd,
            colaborador_id=int(colab_id),
        )

    if hasattr(atd, "operador_id"):
        atd.operador_id = int(colab_id)

    if hasattr(atd, "status"):
        atd.status = STATUS_EM_ATENDIMENTO

    db.add(atd)
    db.commit()
    db.refresh(atd)

    part_info = _response_atendimento_estado(
        db,
        atendimento=atd,
        current_colab_id=int(colab_id),
    )

    return {
        "ok": True,
        "already_accepted": already_accepted,
        "cliente_id": int(cliente.id),
        "instancia_id": int(resolved_inst_id),
        "atendimento_id": int(atd.id),
        "operador_id": (
            int(atd.operador_id)
            if getattr(atd, "operador_id", None) is not None
            else None
        ),
        "operador_nome": _nome_colaborador(db, getattr(atd, "operador_id", None)),
        "responsavel_id": part_info["responsavel_id"],
        "responsavel_nome": part_info["responsavel_nome"],
        "departamento_id": (
            int(atd.departamento_id)
            if getattr(atd, "departamento_id", None) is not None
            else None
        ),
        "status": _status_to_str(getattr(atd, "status", None)),

        "fila_id": part_info.get("fila_id"),
        "fila_nome": part_info.get("fila_nome"),
        "fila_prioridade": part_info.get("fila_prioridade"),
        "fila_sla_minutos": part_info.get("fila_sla_minutos"),
        "fila_cor": part_info.get("fila_cor"),
        "fila_ativa": part_info.get("fila_ativa", False),
        "fila_exigir_aceite": part_info.get("fila_exigir_aceite", False),
        "fila_escolhida_em": part_info.get("fila_escolhida_em"),
        "exigir_aceite": part_info.get("exigir_aceite", False),
        "aceite_obrigatorio": part_info.get("aceite_obrigatorio", False),
        "aguardando_aceite": part_info.get("aguardando_aceite", False),
        "aguardando_escolha_fila": part_info.get("aguardando_escolha_fila", False),

        "participantes": part_info["participantes"],
        "participantes_ids": part_info["participantes_ids"],
        "aceita_por_mim": part_info["aceita_por_mim"],
        "tem_participantes": part_info["tem_participantes"],
        "pode_aceitar": part_info["pode_aceitar"],
        "pode_liberar": part_info["pode_liberar"],
        "pode_responder": part_info.get("pode_responder", True),
        **_claim_mode_payload(part_info, atd, int(colab_id)),
    }


# =========================================================
# POST /conversas/{cliente_id}/liberar
# =========================================================
@router.post("/conversas/{cliente_id}/liberar")
def liberar_conversa(
    cliente_id: int,
    payload: Optional[LiberarConversaIn] = Body(None),
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
):
    ensure_perm(identity, "atendimento.ver")

    payload = payload or LiberarConversaIn()

    empresa_id_req = _empresa_id_segura(identity, payload.empresa_id)

    acl_ctx = resolve_acl_context(db, identity=identity, empresa_id=empresa_id_req)
    empresa_id = int(acl_ctx["empresa_id"])
    allowed_inst_ids = acl_ctx["allowed_instancias"]
    allowed_dep_ids = acl_ctx["allowed_departamentos"]

    colab_id = _resolve_identity_colab_id(
        db,
        identity=identity,
        empresa_id=int(empresa_id),
        required=True,
    )

    cliente = (
        db.query(models.Cliente)
        .filter(
            models.Cliente.empresa_id == int(empresa_id),
            models.Cliente.id == int(cliente_id),
        )
        .first()
    )

    if not cliente:
        raise HTTPException(status_code=404, detail="Cliente não encontrado")

    resolved_inst_id, _resolved_inst_name = _resolve_instancia_id(
        db,
        empresa_id=empresa_id,
        instancia_id=payload.instancia_id,
        instance=payload.instance,
    )

    if (payload.instancia_id is not None or payload.instance) and resolved_inst_id is None:
        raise HTTPException(status_code=404, detail="Instância não encontrada para a empresa.")

    if resolved_inst_id is None:
        resolved_inst_id = _cliente_instancia_mais_recente(
            db,
            empresa_id=empresa_id,
            cliente_id=int(cliente_id),
            allowed_inst_ids=allowed_inst_ids,
        )

    if resolved_inst_id is None:
        raise HTTPException(
            status_code=400,
            detail="Não foi possível resolver a instância da conversa",
        )

    assert_instancia_allowed(
        allowed_instancias=allowed_inst_ids,
        instancia_id=resolved_inst_id,
    )

    atd = _latest_atendimento_for_cliente_instancia(
        db,
        empresa_id=empresa_id,
        cliente_id=int(cliente_id),
        instancia_id=resolved_inst_id,
    )

    if atd is None:
        raise HTTPException(
            status_code=404,
            detail="Atendimento não encontrado para essa conversa",
        )

    departamento_acl = getattr(atd, "departamento_id", None)

    _assert_departamento_acl_for_row(
        allowed_dep_ids=allowed_dep_ids,
        departamento_id=departamento_acl,
    )

    if _participant_feature_enabled(db):
        released = _release_participante(
            db,
            atendimento=atd,
            colaborador_id=int(colab_id),
        )

        if not released:
            active_info = _response_atendimento_estado(
                db,
                atendimento=atd,
                current_colab_id=int(colab_id),
            )

            if not active_info["aceita_por_mim"]:
                raise HTTPException(
                    status_code=409,
                    detail="Você não participa dessa conversa",
                )

        _sync_atendimento_from_participants(
            db,
            atendimento=atd,
            preferred_responsavel_id=None,
        )

    else:
        operador_atual = getattr(atd, "operador_id", None)

        if operador_atual is not None and int(operador_atual) != int(colab_id):
            raise HTTPException(
                status_code=409,
                detail="Somente o responsável atual pode liberar a conversa",
            )

        atd.operador_id = None
        atd.status = (
            models.StatusAtendimento.AGUARDANDO
            if getattr(atd, "departamento_id", None) is not None
            else models.StatusAtendimento.NOVO
        )

    db.add(atd)
    db.commit()
    db.refresh(atd)

    part_info = _response_atendimento_estado(
        db,
        atendimento=atd,
        current_colab_id=int(colab_id),
    )

    return {
        "ok": True,
        "cliente_id": int(cliente.id),
        "instancia_id": int(resolved_inst_id),
        "atendimento_id": int(atd.id),
        "operador_id": (
            int(atd.operador_id)
            if getattr(atd, "operador_id", None) is not None
            else None
        ),
        "operador_nome": _nome_colaborador(db, getattr(atd, "operador_id", None)),
        "responsavel_id": part_info["responsavel_id"],
        "responsavel_nome": part_info["responsavel_nome"],
        "departamento_id": (
            int(atd.departamento_id)
            if getattr(atd, "departamento_id", None) is not None
            else None
        ),
        "status": _status_to_str(getattr(atd, "status", None)),

        "fila_id": part_info.get("fila_id"),
        "fila_nome": part_info.get("fila_nome"),
        "fila_prioridade": part_info.get("fila_prioridade"),
        "fila_sla_minutos": part_info.get("fila_sla_minutos"),
        "fila_cor": part_info.get("fila_cor"),
        "fila_ativa": part_info.get("fila_ativa", False),
        "fila_exigir_aceite": part_info.get("fila_exigir_aceite", False),
        "fila_escolhida_em": part_info.get("fila_escolhida_em"),
        "exigir_aceite": part_info.get("exigir_aceite", False),
        "aceite_obrigatorio": part_info.get("aceite_obrigatorio", False),
        "aguardando_aceite": part_info.get("aguardando_aceite", False),
        "aguardando_escolha_fila": part_info.get("aguardando_escolha_fila", False),

        "participantes": part_info["participantes"],
        "participantes_ids": part_info["participantes_ids"],
        "aceita_por_mim": part_info["aceita_por_mim"],
        "tem_participantes": part_info["tem_participantes"],
        "pode_aceitar": part_info["pode_aceitar"],
        "pode_liberar": part_info["pode_liberar"],
        "pode_responder": part_info.get("pode_responder", True),
        **_claim_mode_payload(part_info, atd, int(colab_id)),
    }


# =========================================================
# POST /conversas/{cliente_id}/transferir-colaborador
# =========================================================
@router.post("/conversas/{cliente_id}/transferir-colaborador")
def transferir_colaborador(
    cliente_id: int,
    payload: TransferirColaboradorIn = Body(...),
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
):
    ensure_perm(identity, "atendimento.ver")

    empresa_id_req = _empresa_id_segura(identity, payload.empresa_id)

    acl_ctx = resolve_acl_context(db, identity=identity, empresa_id=empresa_id_req)
    empresa_id = int(acl_ctx["empresa_id"])
    allowed_inst_ids = acl_ctx["allowed_instancias"]
    allowed_dep_ids = acl_ctx["allowed_departamentos"]

    cliente = (
        db.query(models.Cliente)
        .filter(
            models.Cliente.empresa_id == int(empresa_id),
            models.Cliente.id == int(cliente_id),
        )
        .first()
    )

    if not cliente:
        raise HTTPException(status_code=404, detail="Cliente não encontrado")

    resolved_inst_id, _resolved_inst_name = _resolve_instancia_id(
        db,
        empresa_id=empresa_id,
        instancia_id=payload.instancia_id,
        instance=payload.instance,
    )

    if (payload.instancia_id is not None or payload.instance) and resolved_inst_id is None:
        raise HTTPException(status_code=404, detail="Instância não encontrada para a empresa.")

    if resolved_inst_id is None:
        resolved_inst_id = _cliente_instancia_mais_recente(
            db,
            empresa_id=empresa_id,
            cliente_id=int(cliente_id),
            allowed_inst_ids=allowed_inst_ids,
        )

    if resolved_inst_id is None:
        raise HTTPException(
            status_code=400,
            detail="Não foi possível resolver a instância da conversa",
        )

    assert_instancia_allowed(
        allowed_instancias=allowed_inst_ids,
        instancia_id=resolved_inst_id,
    )

    atd = _latest_atendimento_for_cliente_instancia(
        db,
        empresa_id=empresa_id,
        cliente_id=int(cliente_id),
        instancia_id=resolved_inst_id,
    )

    if atd is None:
        atd = models.Atendimento(
            empresa_id=int(empresa_id),
            cliente_id=int(cliente_id),
            instancia_id=int(resolved_inst_id),
            departamento_id=getattr(cliente, "departamento_id", None),
            operador_id=None,
            status=models.StatusAtendimento.NOVO,
        )
        db.add(atd)
        db.flush()

    departamento_acl = (
        getattr(atd, "departamento_id", None)
        if atd is not None and hasattr(atd, "departamento_id")
        else getattr(cliente, "departamento_id", None)
    )

    _assert_departamento_acl_for_row(
        allowed_dep_ids=allowed_dep_ids,
        departamento_id=departamento_acl,
    )

    target = (
        db.query(models.Colaborador)
        .filter(
            models.Colaborador.empresa_id == int(empresa_id),
            models.Colaborador.id == int(payload.colaborador_id),
        )
        .first()
    )

    if not target:
        raise HTTPException(status_code=404, detail="Colaborador não encontrado")

    if not _instancia_permitida_para_colaborador(
        db,
        colaborador_id=int(target.id),
        empresa_id=int(empresa_id),
        instancia_id=int(resolved_inst_id),
    ):
        raise HTTPException(
            status_code=409,
            detail="Esse colaborador não pode atender essa instância",
        )

    if not _departamento_permitido_para_colaborador(
        db,
        colaborador_id=int(target.id),
        empresa_id=int(empresa_id),
        departamento_id=departamento_acl,
    ):
        raise HTTPException(
            status_code=409,
            detail="Esse colaborador não pertence ao departamento da conversa",
        )

    atd.instancia_id = int(resolved_inst_id)

    if (
        getattr(atd, "departamento_id", None) is None
        and getattr(cliente, "departamento_id", None) is not None
    ):
        atd.departamento_id = getattr(cliente, "departamento_id", None)

    if _participant_feature_enabled(db):
        _upsert_participante_ativo(
            db,
            atendimento=atd,
            colaborador_id=int(target.id),
        )

        _sync_atendimento_from_participants(
            db,
            atendimento=atd,
            preferred_responsavel_id=int(target.id),
        )

    else:
        atd.operador_id = int(target.id)
        atd.status = models.StatusAtendimento.EM_ATENDIMENTO

    db.add(atd)
    db.commit()
    db.refresh(atd)

    current_colab_id = _resolve_identity_colab_id(
        db,
        identity=identity,
        empresa_id=int(empresa_id),
        required=False,
    )

    part_info = _response_atendimento_estado(
        db,
        atendimento=atd,
        current_colab_id=current_colab_id,
    )

    return {
        "ok": True,
        "cliente_id": int(cliente.id),
        "instancia_id": int(resolved_inst_id),
        "atendimento_id": int(atd.id),
        "operador_id": (
            int(atd.operador_id)
            if getattr(atd, "operador_id", None) is not None
            else None
        ),
        "operador_nome": _nome_colaborador(db, getattr(atd, "operador_id", None)),
        "responsavel_id": part_info["responsavel_id"],
        "responsavel_nome": part_info["responsavel_nome"],
        "departamento_id": (
            int(atd.departamento_id)
            if getattr(atd, "departamento_id", None) is not None
            else None
        ),
        "status": _status_to_str(getattr(atd, "status", None)),

        "fila_id": part_info.get("fila_id"),
        "fila_nome": part_info.get("fila_nome"),
        "fila_prioridade": part_info.get("fila_prioridade"),
        "fila_sla_minutos": part_info.get("fila_sla_minutos"),
        "fila_cor": part_info.get("fila_cor"),
        "fila_ativa": part_info.get("fila_ativa", False),
        "fila_exigir_aceite": part_info.get("fila_exigir_aceite", False),
        "fila_escolhida_em": part_info.get("fila_escolhida_em"),
        "exigir_aceite": part_info.get("exigir_aceite", False),
        "aceite_obrigatorio": part_info.get("aceite_obrigatorio", False),
        "aguardando_aceite": part_info.get("aguardando_aceite", False),
        "aguardando_escolha_fila": part_info.get("aguardando_escolha_fila", False),

        "participantes": part_info["participantes"],
        "participantes_ids": part_info["participantes_ids"],
        "aceita_por_mim": part_info["aceita_por_mim"],
        "tem_participantes": part_info["tem_participantes"],
        "pode_aceitar": part_info["pode_aceitar"],
        "pode_liberar": part_info["pode_liberar"],
        "pode_responder": part_info.get("pode_responder", True),
        **_claim_mode_payload(part_info, atd, current_colab_id),
    }