#backend\routers\atendimento_conversas\acoes.py
from __future__ import annotations

from typing import Optional, Dict, Any
from uuid import uuid4
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Body, BackgroundTasks
from sqlalchemy.orm import Session

from backend.database import get_db
from backend import models
from backend.routers.auth import get_current_identity
from backend.websocket_manager import conexoes_ativas
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
    _participant_feature_enabled,
)

from .colaborador_helpers import (
    _resolve_identity_colab_id,
    _cliente_instancia_mais_recente,
    _assert_departamento_acl_for_row,
    _instancia_permitida_para_colaborador,
    _departamento_permitido_para_colaborador,
    _nome_colaborador,
)

from .participantes import (
    _claim_exclusive_participant,
    _release_all_participants,
    _response_atendimento_estado,
)

from backend.services.atendimento_claim_state import (
    ensure_open_atendimento_locked,
    get_open_atendimento_locked,
)
from backend.services.chatbot_claim_policy import (
    customer_has_department_triage_marker,
    department_chatbot_active,
    department_claim_required,
)

router = APIRouter(tags=["Atendimento – Conversas"])


def _queue_claim_update_ws(
    background_tasks: BackgroundTasks,
    *,
    empresa_id: int,
    action: str,
    response: Dict[str, Any],
) -> None:
    """Notifica todas as abas da empresa após aceitar, liberar ou transferir."""
    try:
        payload = dict(response or {})
        payload.update(
            {
                "type": "atendimento_claim_updated",
                "action": str(action or "updated"),
                "conversation_key": (
                    f"c:{int(payload.get('cliente_id'))}:{int(payload.get('instancia_id'))}"
                    if payload.get("cliente_id") is not None and payload.get("instancia_id") is not None
                    else payload.get("conversation_key")
                ),
                "conversation_id": (
                    f"c:{int(payload.get('cliente_id'))}:{int(payload.get('instancia_id'))}"
                    if payload.get("cliente_id") is not None and payload.get("instancia_id") is not None
                    else payload.get("conversation_id")
                ),
                "origin": "atendimento_conversas",
            }
        )
        background_tasks.add_task(
            conexoes_ativas.send_message,
            f"emp:{int(empresa_id)}",
            payload,
        )
    except Exception:
        # O estado já está confirmado no banco. Falha de WS não pode desfazer a ação.
        return


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






def _nome_departamento(db: Session, departamento_id: Optional[int]) -> Optional[str]:
    did = _to_int(departamento_id)
    if did is None:
        return None

    try:
        row = (
            db.query(models.Departamento)
            .filter(models.Departamento.id == int(did))
            .first()
        )
        return getattr(row, "nome", None) if row else None
    except Exception:
        return None


def _criar_evento_sistema_atendimento(
    db: Session,
    *,
    empresa_id: int,
    cliente_id: int,
    instancia_id: Optional[int],
    atendimento_id: Optional[int],
    texto: str,
) -> Optional[models.Mensagem]:
    """
    Cria um card interno no histórico da conversa.

    Importante:
    - tipo='sistema' não é enviado para o WhatsApp;
    - aparece só no ZapsChat para registrar quem assumiu/liberou/transferiu;
    - msg_id começa com sys: para não confundir com mensagem da Evolution.
    """
    texto = str(texto or "").strip()
    if not texto:
        return None

    agora = datetime.now(timezone.utc)

    msg = models.Mensagem(
        empresa_id=int(empresa_id),
        cliente_id=int(cliente_id),
        instancia_id=int(instancia_id) if instancia_id is not None else None,
        atendimento_id=int(atendimento_id) if atendimento_id is not None else None,
        colaborador_id=None,
        conteudo=texto,
        tipo="sistema",
        lida=True,
        ack=3,
        timestamp=agora,
        msg_id=f"sys:atendimento:{int(atendimento_id or 0)}:{uuid4().hex}",
    )
    db.add(msg)
    return msg


def _payload_evento_sistema(msg: Optional[models.Mensagem]) -> Optional[Dict[str, Any]]:
    """
    Retorno leve para o frontend inserir o card central sem recarregar
    histórico inteiro. O banco continua sendo a verdade.
    """
    if msg is None:
        return None

    ts = getattr(msg, "timestamp", None)
    try:
        ts_out = ts.isoformat() if ts is not None else datetime.now(timezone.utc).isoformat()
    except Exception:
        ts_out = datetime.now(timezone.utc).isoformat()

    return {
        "id": int(getattr(msg, "id", 0) or 0) or None,
        "msg_id": str(getattr(msg, "msg_id", "") or f"sys:front:{uuid4().hex}"),
        "empresa_id": int(getattr(msg, "empresa_id", 0) or 0) or None,
        "cliente_id": int(getattr(msg, "cliente_id", 0) or 0) or None,
        "instancia_id": (
            int(getattr(msg, "instancia_id", 0) or 0)
            if getattr(msg, "instancia_id", None) is not None
            else None
        ),
        "atendimento_id": (
            int(getattr(msg, "atendimento_id", 0) or 0)
            if getattr(msg, "atendimento_id", None) is not None
            else None
        ),
        "conteudo": str(getattr(msg, "conteudo", "") or ""),
        "texto": str(getattr(msg, "conteudo", "") or ""),
        "tipo": "sistema",
        "origem": "sistema",
        "message_type": "system",
        "system_event": True,
        "lida": True,
        "ack": 3,
        "timestamp": ts_out,
        "created_at": ts_out,
    }

def _status_norm(value: Any) -> str:
    return str(value or "").split(".")[-1].strip().lower()


def _is_status_aberto_para_department_claim(status: Optional[str]) -> bool:
    st = _status_norm(status)
    if not st:
        return True
    return st in {"novo", "aguardando", "em_atendimento", "pausado", "aberto", "pendente"}


def _triagem_departamento_do_cliente(cliente, departamento_id: Optional[int]) -> bool:
    if cliente is None or departamento_id is None:
        return False

    try:
        dep_cli = getattr(cliente, "departamento_id", None)
        if dep_cli is None or int(dep_cli) != int(departamento_id):
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


def _department_claim_enabled(
    db: Session,
    part_info: Dict[str, Any],
    atendimento,
    cliente=None,
) -> bool:
    """Fila segue sua configuração; menu por departamento segue o estado do chatbot."""
    if atendimento is None:
        return False

    fila_id = getattr(atendimento, "fila_id", None)
    if fila_id is None:
        fila_id = (part_info or {}).get("fila_id")

    if fila_id is not None and bool(
        (part_info or {}).get("fila_exigir_aceite") is True
        or (part_info or {}).get("exigir_aceite") is True
        or (part_info or {}).get("aceite_obrigatorio") is True
    ):
        return True

    return department_claim_required(
        db,
        atendimento=atendimento,
        cliente=cliente,
    )


def _claim_mode_payload(
    db: Session,
    part_info: Dict[str, Any],
    atendimento,
    current_colab_id: Optional[int],
    cliente=None,
) -> Dict[str, Any]:
    """Campos extras para o front diferenciar fila antiga de Atender por departamento."""
    dep_claim = _department_claim_enabled(db, part_info, atendimento, cliente=cliente)
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
    background_tasks: BackgroundTasks,
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
        .with_for_update()
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

    atd = get_open_atendimento_locked(
        db,
        empresa_id=empresa_id,
        cliente_id=int(cliente_id),
        instancia_id=int(resolved_inst_id),
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

    if atd is None:
        atd = ensure_open_atendimento_locked(
            db,
            empresa_id=int(empresa_id),
            cliente_id=int(cliente_id),
            instancia_id=int(resolved_inst_id),
            departamento_id=getattr(cliente, "departamento_id", None),
            initial_status=models.StatusAtendimento.NOVO,
        )
        if atd is None:
            raise HTTPException(
                status_code=500,
                detail="Não foi possível criar o atendimento da conversa",
            )

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

    atd = _claim_exclusive_participant(
        db,
        atendimento=atd,
        colaborador_id=int(colab_id),
    )
    if atd is None:
        raise HTTPException(status_code=404, detail="Atendimento não encontrado")

    db.add(atd)

    evento_sistema = None

    if not already_accepted:
        colab_nome = _nome_colaborador(db, int(colab_id)) or "Atendente"
        evento_sistema = _criar_evento_sistema_atendimento(
            db,
            empresa_id=int(empresa_id),
            cliente_id=int(cliente.id),
            instancia_id=int(resolved_inst_id),
            atendimento_id=int(getattr(atd, "id", 0) or 0),
            texto=f"{colab_nome} assumiu este atendimento.",
        )
        db.flush()

    db.commit()
    db.refresh(atd)

    part_info = _response_atendimento_estado(
        db,
        atendimento=atd,
        current_colab_id=int(colab_id),
    )

    response = {
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
        "system_event": _payload_evento_sistema(evento_sistema),
        **_claim_mode_payload(db, part_info, atd, int(colab_id), cliente=cliente),
    }

    _queue_claim_update_ws(
        background_tasks,
        empresa_id=int(empresa_id),
        action="accepted",
        response=response,
    )
    return response


# =========================================================
# POST /conversas/{cliente_id}/liberar
# =========================================================
@router.post("/conversas/{cliente_id}/liberar")
def liberar_conversa(
    cliente_id: int,
    background_tasks: BackgroundTasks,
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
        .with_for_update()
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

    atd = get_open_atendimento_locked(
        db,
        empresa_id=empresa_id,
        cliente_id=int(cliente_id),
        instancia_id=int(resolved_inst_id),
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

    operador_atual_inicial = _to_int(getattr(atd, "operador_id", None))
    liberado_de_verdade = False
    ja_estava_liberado = False

    if _participant_feature_enabled(db):
        active_info_before = _response_atendimento_estado(
            db,
            atendimento=atd,
            current_colab_id=int(colab_id),
        )

        aceita_por_mim_antes = bool(active_info_before.get("aceita_por_mim"))
        sou_operador_atual = bool(
            operador_atual_inicial is not None
            and int(operador_atual_inicial) == int(colab_id)
        )

        if operador_atual_inicial is not None and not sou_operador_atual:
            raise HTTPException(
                status_code=409,
                detail="Somente o responsável atual pode liberar a conversa",
            )

        if operador_atual_inicial is None and not aceita_por_mim_antes:
            ja_estava_liberado = True
        else:
            liberado_de_verdade = True

        atd = _release_all_participants(db, atendimento=atd)
        if atd is None:
            raise HTTPException(status_code=404, detail="Atendimento não encontrado")

    else:
        operador_atual = operador_atual_inicial

        if operador_atual is None:
            ja_estava_liberado = True
        elif int(operador_atual) != int(colab_id):
            raise HTTPException(
                status_code=409,
                detail="Somente o responsável atual pode liberar a conversa",
            )
        else:
            liberado_de_verdade = True

        atd.operador_id = None
        atd.status = (
            models.StatusAtendimento.AGUARDANDO
            if getattr(atd, "departamento_id", None) is not None
            else models.StatusAtendimento.NOVO
        )
        if hasattr(atd, "aceito_em"):
            atd.aceito_em = None

    # Se o menu de departamentos está desligado, liberar significa devolver
    # a conversa ao atendimento manual, não colocá-la novamente em aceite.
    if (
        getattr(atd, "fila_id", None) is None
        and customer_has_department_triage_marker(
            cliente, getattr(atd, "departamento_id", None)
        )
        and not department_chatbot_active(
            db,
            empresa_id=int(empresa_id),
            instancia_id=int(resolved_inst_id),
        )
    ):
        atd.status = models.StatusAtendimento.NOVO

    db.add(atd)

    evento_sistema = None

    if liberado_de_verdade and not ja_estava_liberado:
        colab_nome = _nome_colaborador(db, int(colab_id)) or "Atendente"
        dep_nome = _nome_departamento(db, getattr(atd, "departamento_id", None)) or "o departamento"
        evento_sistema = _criar_evento_sistema_atendimento(
            db,
            empresa_id=int(empresa_id),
            cliente_id=int(cliente.id),
            instancia_id=int(resolved_inst_id),
            atendimento_id=int(getattr(atd, "id", 0) or 0),
            texto=f"{colab_nome} liberou este atendimento para {dep_nome}.",
        )
        db.flush()

    db.commit()
    db.refresh(atd)

    part_info = _response_atendimento_estado(
        db,
        atendimento=atd,
        current_colab_id=int(colab_id),
    )

    response = {
        "ok": True,
        "already_released": bool(ja_estava_liberado),
        "released": bool(liberado_de_verdade),
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
        "system_event": _payload_evento_sistema(evento_sistema),
        **_claim_mode_payload(db, part_info, atd, int(colab_id), cliente=cliente),
    }

    _queue_claim_update_ws(
        background_tasks,
        empresa_id=int(empresa_id),
        action="released",
        response=response,
    )
    return response


# =========================================================
# POST /conversas/{cliente_id}/transferir-colaborador
# =========================================================
@router.post("/conversas/{cliente_id}/transferir-colaborador")
def transferir_colaborador(
    cliente_id: int,
    background_tasks: BackgroundTasks,
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
        .with_for_update()
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

    atd = get_open_atendimento_locked(
        db,
        empresa_id=empresa_id,
        cliente_id=int(cliente_id),
        instancia_id=int(resolved_inst_id),
    )

    if atd is None:
        atd = ensure_open_atendimento_locked(
            db,
            empresa_id=int(empresa_id),
            cliente_id=int(cliente_id),
            instancia_id=int(resolved_inst_id),
            departamento_id=getattr(cliente, "departamento_id", None),
            initial_status=models.StatusAtendimento.NOVO,
        )
        if atd is None:
            raise HTTPException(
                status_code=500,
                detail="Não foi possível criar o atendimento da conversa",
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

    atd = _claim_exclusive_participant(
        db,
        atendimento=atd,
        colaborador_id=int(target.id),
    )
    if atd is None:
        raise HTTPException(status_code=404, detail="Atendimento não encontrado")

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

    response = {
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
        **_claim_mode_payload(db, part_info, atd, current_colab_id, cliente=cliente),
    }

    _queue_claim_update_ws(
        background_tasks,
        empresa_id=int(empresa_id),
        action="transferred",
        response=response,
    )
    return response