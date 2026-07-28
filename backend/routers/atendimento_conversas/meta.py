#backend\routers\atendimento_conversas\meta.py
from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional, List, Dict, Any

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session
from sqlalchemy import func

from backend.database import get_db
from backend import models
from backend.routers.auth import get_current_identity
from backend.security.atendimento_acl import (
    ensure_perm,
    resolve_acl_context,
    assert_instancia_allowed,
    assert_cliente_conversation_visibility,
)

from .utils import (
    _resolve_instancia_id,
    _status_to_str,
)

from .colaborador_helpers import (
    _resolve_identity_colab_id,
    _cliente_instancia_mais_recente,
    _latest_atendimento_for_cliente_instancia,
    _assert_departamento_acl_for_row,
    _instancia_permitida_para_colaborador,
    _departamento_permitido_para_colaborador,
    _nome_colaborador,
    _is_admin_identity,
)

from .participantes import (
    _response_atendimento_estado,
)

from backend.services.atendimento_claim_state import set_waiting_department
from backend.services.chatbot_claim_policy import (
    customer_has_department_triage_marker,
    department_chatbot_active,
    department_claim_required,
)
from .schemas import EditarNomeClienteIn

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




def _is_status_aberto_para_claim(status: Optional[str]) -> bool:
    st = str(status or "").strip().lower()
    if not st:
        return True
    return st in {"novo", "aguardando", "em_atendimento", "pausado", "aberto", "pendente"}


def _triagem_departamento_do_cliente(cliente, departamento_id: Optional[int]) -> bool:
    return customer_has_department_triage_marker(cliente, departamento_id)


def _status_indica_fluxo_departamento(status: Optional[str]) -> bool:
    st = str(status or "").split(".")[-1].strip().lower()
    return st in {"aguardando", "em_atendimento", "pausado", "pendente"}


def _repair_missing_triage_atendimento(
    db: Session,
    *,
    empresa_id: int,
    cliente,
    instancia_id: Optional[int],
):
    """Repara legados usando a mesma regra transacional do chatbot."""
    if cliente is None or instancia_id is None:
        return None

    departamento_id = getattr(cliente, "departamento_id", None)
    if departamento_id is None:
        return None

    if not _triagem_departamento_do_cliente(cliente, int(departamento_id)):
        return None

    # Chatbot desligado não pode recriar um atendimento aguardando aceite
    # apenas porque o cliente ainda possui marcadores antigos de triagem.
    if not department_chatbot_active(
        db,
        empresa_id=int(empresa_id),
        instancia_id=int(instancia_id),
    ):
        return None

    try:
        atendimento = set_waiting_department(
            db,
            empresa_id=int(empresa_id),
            cliente_id=int(cliente.id),
            instancia_id=int(instancia_id),
            departamento_id=int(departamento_id),
            ts_dt=datetime.now(timezone.utc),
        )
        if atendimento is None:
            return None
        db.commit()
        db.refresh(atendimento)
        return atendimento
    except Exception as exc:
        try:
            db.rollback()
        except Exception:
            pass
        try:
            print(
                "[ATENDIMENTO][meta][repair-triagem][erro]",
                {
                    "empresa_id": int(empresa_id),
                    "cliente_id": int(getattr(cliente, "id", 0) or 0),
                    "instancia_id": int(instancia_id),
                    "erro": repr(exc),
                },
            )
        except Exception:
            pass
        return _latest_atendimento_for_cliente_instancia(
            db,
            empresa_id=int(empresa_id),
            cliente_id=int(cliente.id),
            instancia_id=int(instancia_id),
        )


def _merge_department_claim_state(
    db: Session,
    base: Dict[str, Any],
    *,
    atendimento,
    cliente=None,
    departamento_id: Optional[int],
    operador_id: Optional[int],
    operador_nome: Optional[str],
    status_atd: Optional[str],
    current_colab_id: Optional[int],
    admin_can_intervene: bool = False,
) -> Dict[str, Any]:
    """
    Regra inteligente do atendimento por departamento.

    Conversa normal com departamento no cadastro NÃO trava resposta.

    O botão/barra "Atender" aparece quando:
    - é fila com aceite obrigatório; OU
    - é triagem/menu do chatbot por departamento:
      cliente escolheu uma opção, atendimento ficou em aguardando/em_atendimento
      e ainda precisa ser assumido pelo colaborador do departamento.
    """
    out = dict(base or {})

    if departamento_id is None or not _is_status_aberto_para_claim(status_atd):
        out["claim_mode"] = None
        out["departamento_claim"] = False
        out["pode_transferir_departamento"] = False
        out["can_transfer_department"] = False
        out["pode_transferir_colaborador"] = False
        out["can_transfer_collaborator"] = False
        out["pode_transferir"] = False
        out["can_transfer"] = False
        return out

    fila_id = None
    try:
        fila_id = out.get("fila_id")
        if fila_id is None and atendimento is not None:
            fila_id = getattr(atendimento, "fila_id", None)
        fila_id = int(fila_id) if fila_id is not None else None
    except Exception:
        fila_id = None

    fila_exige_aceite = bool(
        out.get("fila_exigir_aceite") is True
        or out.get("exigir_aceite") is True
        or out.get("aceite_obrigatorio") is True
    )

    triagem_por_departamento = department_claim_required(
        db,
        atendimento=atendimento,
        cliente=cliente,
    )

    claim_required = bool((fila_id is not None and fila_exige_aceite) or triagem_por_departamento)

    if not claim_required:
        out["claim_mode"] = None
        out["departamento_claim"] = False
        out["exigir_aceite"] = False
        out["aceite_obrigatorio"] = False
        out["aguardando_aceite"] = False
        out["pode_aceitar"] = False
        out["pode_liberar"] = False
        out["pode_responder"] = True
        out["pode_transferir_departamento"] = False
        out["can_transfer_department"] = False
        out["pode_transferir_colaborador"] = False
        out["can_transfer_collaborator"] = False
        out["pode_transferir"] = False
        out["can_transfer"] = False
        return out

    operador_int = None
    try:
        if operador_id is not None:
            operador_int = int(operador_id)
    except Exception:
        operador_int = None

    colab_int = None
    try:
        if current_colab_id is not None:
            colab_int = int(current_colab_id)
    except Exception:
        colab_int = None

    assigned_to_me = bool(operador_int is not None and colab_int is not None and operador_int == colab_int)
    assigned_to_other = bool(operador_int is not None and not assigned_to_me)
    waiting = bool(operador_int is None)
    admin_intervening = bool(admin_can_intervene and assigned_to_other)

    # Transferência de departamento é exclusiva da triagem do chatbot.
    # Uma fila com aceite obrigatório continua com Atender/Liberar, mas não é
    # marcada como fluxo de departamentos e não exibe essa ação por engano.
    is_department_claim = bool(triagem_por_departamento)
    can_transfer_department = bool(
        is_department_claim
        and (
            assigned_to_me
            or admin_intervening
            or (waiting and (colab_int is not None or admin_can_intervene))
        )
    )
    can_transfer_collaborator = bool(assigned_to_me or admin_intervening)

    out.update({
        "claim_mode": "departamento" if is_department_claim else "fila",
        "departamento_claim": is_department_claim,
        "exigir_aceite": True,
        "aceite_obrigatorio": True,
        "aguardando_aceite": bool(waiting or assigned_to_other),
        "pode_aceitar": bool(colab_int is not None and waiting),
        "pode_liberar": bool(assigned_to_me),
        "pode_responder": bool(assigned_to_me or colab_int is None or admin_intervening),
        "pode_transferir_departamento": can_transfer_department,
        "can_transfer_department": can_transfer_department,
        "pode_transferir_colaborador": can_transfer_collaborator,
        "can_transfer_collaborator": can_transfer_collaborator,
        "pode_transferir": can_transfer_collaborator,
        "can_transfer": can_transfer_collaborator,
        "aceita_por_mim": bool(assigned_to_me),
        "accepted_by_me": bool(assigned_to_me),
        "accepted_by_anyone": bool(operador_int is not None),
        "tem_participantes": bool(operador_int is not None or out.get("tem_participantes")),
        "responsavel_id": operador_int,
        "responsavel_nome": operador_nome or out.get("responsavel_nome"),
        "operador_id": operador_int,
        "operador_nome": operador_nome or out.get("operador_nome"),
        "status": status_atd,
        "admin_can_intervene": bool(admin_can_intervene),
        "admin_intervening": bool(admin_intervening),
    })

    return out


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


# =========================================================
# GET /conversas/{cliente_id}/meta
# =========================================================
@router.get("/conversas/{cliente_id}/meta")
def obter_meta_conversa(
    cliente_id: int,
    empresa_id: Optional[int] = Query(None),
    instancia_id: int | None = Query(None),
    instance: str | None = Query(None),
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
):
    ensure_perm(identity, "atendimento.ver")

    empresa_id_req = _empresa_id_segura(identity, empresa_id)

    acl_ctx = resolve_acl_context(db, identity=identity, empresa_id=empresa_id_req)
    empresa_id = int(acl_ctx["empresa_id"])
    allowed_inst_ids = acl_ctx["allowed_instancias"]
    allowed_dep_ids = acl_ctx["allowed_departamentos"]

    current_colab_id = _resolve_identity_colab_id(
        db,
        identity=identity,
        empresa_id=int(empresa_id),
        required=False,
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
        instancia_id=instancia_id,
        instance=instance,
    )

    if (instancia_id is not None or instance) and resolved_inst_id is None:
        raise HTTPException(status_code=404, detail="Instância não encontrada para a empresa.")

    if resolved_inst_id is None:
        resolved_inst_id = _cliente_instancia_mais_recente(
            db,
            empresa_id=empresa_id,
            cliente_id=int(cliente_id),
            allowed_inst_ids=allowed_inst_ids,
        )

    if resolved_inst_id is not None:
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

    # Auto-reparo de registros antigos afetados pelo bug do chatbot: o cliente
    # já estava no departamento, mas não existia atendimento para ser aceito.
    if atd is None:
        atd = _repair_missing_triage_atendimento(
            db,
            empresa_id=int(empresa_id),
            cliente=cliente,
            instancia_id=resolved_inst_id,
        )

    assert_cliente_conversation_visibility(
        db,
        identity=identity,
        empresa_id=int(empresa_id),
        cliente=cliente,
        atendimento=atd,
    )

    departamento_acl = (
        getattr(atd, "departamento_id", None)
        if atd is not None and hasattr(atd, "departamento_id")
        else getattr(cliente, "departamento_id", None)
    )

    _assert_departamento_acl_for_row(
        db,
        empresa_id=int(empresa_id),
        instancia_id=resolved_inst_id,
        allowed_dep_ids=allowed_dep_ids,
        departamento_id=departamento_acl,
    )

    operador_id = getattr(atd, "operador_id", None) if atd is not None else None
    status_atd = _status_to_str(getattr(atd, "status", None)) if atd is not None else None
    operador_nome = _nome_colaborador(db, operador_id) if operador_id is not None else None

    part_info = _response_atendimento_estado(
        db,
        atendimento=atd,
        current_colab_id=current_colab_id,
    )

    meta_payload = {
        "cliente_id": int(cliente.id),
        "instancia_id": int(resolved_inst_id) if resolved_inst_id is not None else None,
        "atendimento_id": int(atd.id) if atd is not None else None,
        "departamento_id": int(departamento_acl) if departamento_acl is not None else None,
        "operador_id": int(operador_id) if operador_id is not None else None,
        "operador_nome": operador_nome,
        "responsavel_id": part_info["responsavel_id"],
        "responsavel_nome": part_info["responsavel_nome"],
        "status": status_atd,

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

        "pode_aceitar": part_info["pode_aceitar"],
        "pode_liberar": part_info["pode_liberar"],
        "pode_responder": part_info.get("pode_responder", True),
        "aceita_por_mim": part_info["aceita_por_mim"],
        "participantes": part_info["participantes"],
        "participantes_ids": part_info["participantes_ids"],
        "tem_participantes": part_info["tem_participantes"],
        "is_group": False,
    }
    return _merge_department_claim_state(
        db,
        meta_payload,
        atendimento=atd,
        cliente=cliente,
        departamento_id=(int(departamento_acl) if departamento_acl is not None else None),
        operador_id=(int(operador_id) if operador_id is not None else None),
        operador_nome=operador_nome,
        status_atd=status_atd,
        current_colab_id=current_colab_id,
        admin_can_intervene=_is_admin_identity(identity),
    )




# =========================================================
# PATCH /conversas/{cliente_id}/nome
# =========================================================
@router.patch("/conversas/{cliente_id}/nome")
def editar_nome_cliente_conversa(
    cliente_id: int,
    payload: EditarNomeClienteIn,
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
):
    """
    Edita apenas o nome exibido do contato dentro do atendimento.

    Segurança:
    - usa a empresa da sessão como verdade;
    - respeita ACL de instância e departamento;
    - não altera telefone/JID;
    - funciona para atendente que tem acesso ao atendimento.
    """
    ensure_perm(identity, "atendimento.ver")

    empresa_id_req = _empresa_id_segura(identity, payload.empresa_id)

    acl_ctx = resolve_acl_context(db, identity=identity, empresa_id=empresa_id_req)
    empresa_id = int(acl_ctx["empresa_id"])
    allowed_inst_ids = acl_ctx["allowed_instancias"]
    allowed_dep_ids = acl_ctx["allowed_departamentos"]

    nome = (payload.nome or "").replace("\r", " ").replace("\n", " ").strip()
    nome = " ".join(nome.split())

    if not nome:
        raise HTTPException(status_code=400, detail="Informe um nome para o cliente.")

    if len(nome) > 140:
        raise HTTPException(status_code=400, detail="Nome muito longo. Use até 140 caracteres.")

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
        resolved_inst_id = getattr(cliente, "instancia_id", None)

    if resolved_inst_id is not None:
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

    assert_cliente_conversation_visibility(
        db,
        identity=identity,
        empresa_id=int(empresa_id),
        cliente=cliente,
        atendimento=atd,
    )

    departamento_acl = (
        getattr(atd, "departamento_id", None)
        if atd is not None and hasattr(atd, "departamento_id")
        else getattr(cliente, "departamento_id", None)
    )

    _assert_departamento_acl_for_row(
        db,
        empresa_id=int(empresa_id),
        instancia_id=resolved_inst_id,
        allowed_dep_ids=allowed_dep_ids,
        departamento_id=departamento_acl,
    )

    cliente.nome = nome

    try:
        db.add(cliente)
        db.commit()
        db.refresh(cliente)
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Não foi possível salvar o nome do cliente: {exc}")

    conv_key = f"c:{int(cliente.id)}:{int(resolved_inst_id or 0)}"

    return {
        "ok": True,
        "cliente_id": int(cliente.id),
        "entity_id": int(cliente.id),
        "conversation_key": conv_key,
        "conversation_id": conv_key,
        "instancia_id": int(resolved_inst_id) if resolved_inst_id is not None else None,
        "nome": cliente.nome,
        "nome_whatsapp": getattr(cliente, "nome_whatsapp", None),
        "telefone": getattr(cliente, "telefone", None),
    }


# =========================================================
# GET /conversas/{cliente_id}/colaboradores-transferiveis
# =========================================================
@router.get("/conversas/{cliente_id}/colaboradores-transferiveis")
def listar_colaboradores_transferiveis(
    cliente_id: int,
    empresa_id: Optional[int] = Query(None),
    instancia_id: int | None = Query(None),
    instance: str | None = Query(None),
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
):
    ensure_perm(identity, "atendimento.ver")

    empresa_id_req = _empresa_id_segura(identity, empresa_id)

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
        instancia_id=instancia_id,
        instance=instance,
    )

    if (instancia_id is not None or instance) and resolved_inst_id is None:
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

    assert_cliente_conversation_visibility(
        db,
        identity=identity,
        empresa_id=int(empresa_id),
        cliente=cliente,
        atendimento=atd,
    )

    departamento_acl = (
        getattr(atd, "departamento_id", None)
        if atd is not None and hasattr(atd, "departamento_id")
        else getattr(cliente, "departamento_id", None)
    )

    _assert_departamento_acl_for_row(
        db,
        empresa_id=int(empresa_id),
        instancia_id=resolved_inst_id,
        allowed_dep_ids=allowed_dep_ids,
        departamento_id=departamento_acl,
    )

    colaboradores = (
        db.query(models.Colaborador)
        .filter(models.Colaborador.empresa_id == int(empresa_id))
        .order_by(func.lower(models.Colaborador.nome))
        .all()
    )

    items: List[Dict[str, Any]] = []
    current_operador_id = getattr(atd, "operador_id", None) if atd is not None else None

    for c in colaboradores:
        if not _instancia_permitida_para_colaborador(
            db,
            colaborador_id=int(c.id),
            empresa_id=int(empresa_id),
            instancia_id=int(resolved_inst_id),
        ):
            continue

        if not _departamento_permitido_para_colaborador(
            db,
            colaborador_id=int(c.id),
            empresa_id=int(empresa_id),
            instancia_id=int(resolved_inst_id),
            departamento_id=departamento_acl,
        ):
            continue

        items.append(
            {
                "id": int(c.id),
                "nome": c.nome,
                "email": c.email,
                "cargo": c.cargo,
                "is_current": (
                    current_operador_id is not None
                    and int(current_operador_id) == int(c.id)
                ),
            }
        )

    return {
        "items": items,
        "current_colaborador_id": (
            int(current_operador_id)
            if current_operador_id is not None
            else None
        ),
        "departamento_id": (
            int(departamento_acl)
            if departamento_acl is not None
            else None
        ),
        "instancia_id": int(resolved_inst_id),
    }