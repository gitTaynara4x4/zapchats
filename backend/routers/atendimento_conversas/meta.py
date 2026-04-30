#backend\routers\atendimento_conversas\meta.py
from __future__ import annotations

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
)

from .participantes import (
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

    departamento_acl = (
        getattr(atd, "departamento_id", None)
        if atd is not None and hasattr(atd, "departamento_id")
        else getattr(cliente, "departamento_id", None)
    )

    _assert_departamento_acl_for_row(
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

    return {
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

    departamento_acl = (
        getattr(atd, "departamento_id", None)
        if atd is not None and hasattr(atd, "departamento_id")
        else getattr(cliente, "departamento_id", None)
    )

    _assert_departamento_acl_for_row(
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