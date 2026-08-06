from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional, List

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.orm import Session

from backend import models
from backend.database import get_db
from backend.routers.auth import get_current_identity
from backend.websocket_manager import conexoes_ativas
from backend.services.atendimento_claim_state import (
    claim_exclusive_operator,
    claim_if_available,
    ensure_open_atendimento_locked,
    get_open_atendimento_locked,
    release_to_queue,
    repair_single_responsible,
)
from backend.security.atendimento_acl import (
    ensure_perm,
    assert_same_company,
    resolve_acl_context,
    assert_instancia_allowed,
    assert_cliente_access,
)

router = APIRouter(tags=["Atendimento – Transferência de Departamento"])


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


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
        if vals:
            return vals

    return ["novo", "aguardando", "em_atendimento", "pausado"]


def _fetch_primary_colab_id(
    db: Session,
    *,
    empresa_id: int,
    departamento_id: int,
) -> Optional[int]:
    row = db.execute(
        text(
            """
            SELECT colaborador_id
            FROM departamentos_membros
            WHERE empresa_id = :empresa_id
              AND departamento_id = :departamento_id
              AND is_primary IS TRUE
            ORDER BY id ASC
            LIMIT 1
            """
        ),
        {
            "empresa_id": int(empresa_id),
            "departamento_id": int(departamento_id),
        },
    ).mappings().first()

    if not row:
        return None

    try:
        return int(row["colaborador_id"])
    except Exception:
        return None


def _departamento_permitido_na_instancia(
    db: Session,
    *,
    empresa_id: int,
    departamento_id: int,
    instancia_id: Optional[int],
) -> bool:
    """
    Modelo 2:

    Departamento NÃO controla mais quais WhatsApps pode usar.

    Agora:
    - Departamento = setor/roteamento/estrutura.
    - Colaborador = controla quais departamentos atende.
    - Colaborador = controla quais instâncias/WhatsApps pode acessar.

    Por isso, na transferência, qualquer departamento ativo da empresa
    pode receber uma conversa.
    """
    return True


def _listar_departamentos_transferiveis(
    db: Session,
    *,
    empresa_id: int,
    instancia_id: Optional[int],
) -> List[models.Departamento]:
    q = (
        db.query(models.Departamento)
        .filter(
            models.Departamento.empresa_id == int(empresa_id),
            models.Departamento.ativo.is_(True),
        )
        .order_by(models.Departamento.nome.asc())
    )

    deps = q.all()
    out: List[models.Departamento] = []

    for dep in deps:
        if _departamento_permitido_na_instancia(
            db,
            empresa_id=int(empresa_id),
            departamento_id=int(dep.id),
            instancia_id=instancia_id,
        ):
            out.append(dep)

    return out


class TransferirDepartamentoIn(BaseModel):
    empresa_id: Optional[int] = None
    instancia_id: Optional[int] = None
    departamento_id: int
    atribuir_responsavel_primario: bool = True
    limpar_operador_atual: bool = True


@router.get("/api/atendimento/departamentos-transferiveis")
def listar_departamentos_transferiveis(
    cliente_id: int = Query(...),
    empresa_id: Optional[int] = Query(None),
    instancia_id: Optional[int] = Query(None),
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
):
    ensure_perm(identity, "atendimento.transferir")

    empresa_id_eff = assert_same_company(identity, empresa_id)

    acl_ctx = resolve_acl_context(
        db,
        identity=identity,
        empresa_id=int(empresa_id_eff),
    )

    allowed_instancias = acl_ctx["allowed_instancias"]

    if instancia_id is not None:
        assert_instancia_allowed(
            allowed_instancias=allowed_instancias,
            instancia_id=int(instancia_id),
        )

    cliente, atendimento = assert_cliente_access(
        db,
        identity=identity,
        empresa_id=int(empresa_id_eff),
        cliente_id=int(cliente_id),
        instancia_id=instancia_id,
        allow_unassigned_department=False,
    )

    inst_id_eff = (
        int(instancia_id)
        if instancia_id is not None
        else (
            int(getattr(atendimento, "instancia_id", 0))
            if atendimento is not None and getattr(atendimento, "instancia_id", None) is not None
            else (
                int(getattr(cliente, "instancia_id", 0))
                if getattr(cliente, "instancia_id", None) is not None
                else None
            )
        )
    )

    deps = _listar_departamentos_transferiveis(
        db,
        empresa_id=int(empresa_id_eff),
        instancia_id=inst_id_eff,
    )

    current_dep_id = (
        getattr(atendimento, "departamento_id", None)
        if atendimento is not None and getattr(atendimento, "departamento_id", None) is not None
        else getattr(cliente, "departamento_id", None)
    )

    items = [
        {
            "id": int(dep.id),
            "nome": dep.nome,
            "descricao": dep.descricao,
            "is_current": bool(current_dep_id == dep.id),
        }
        for dep in deps
    ]

    return {
        "ok": True,
        "cliente_id": int(cliente.id),
        "instancia_id": inst_id_eff,
        "current_departamento_id": current_dep_id,
        "items": items,
    }


@router.post("/api/atendimento/conversas/{cliente_id}/transferir-departamento")
async def transferir_conversa_departamento(
    cliente_id: int,
    payload: TransferirDepartamentoIn,
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
):
    ensure_perm(identity, "atendimento.transferir")

    empresa_id_eff = assert_same_company(identity, payload.empresa_id)

    acl_ctx = resolve_acl_context(
        db,
        identity=identity,
        empresa_id=int(empresa_id_eff),
    )

    allowed_instancias = acl_ctx["allowed_instancias"]

    if payload.instancia_id is not None:
        assert_instancia_allowed(
            allowed_instancias=allowed_instancias,
            instancia_id=int(payload.instancia_id),
        )

    cliente, atendimento_atual = assert_cliente_access(
        db,
        identity=identity,
        empresa_id=int(empresa_id_eff),
        cliente_id=int(cliente_id),
        instancia_id=payload.instancia_id,
        allow_unassigned_department=False,
    )

    instancia_id_eff = (
        int(payload.instancia_id)
        if payload.instancia_id is not None
        else (
            int(getattr(atendimento_atual, "instancia_id", 0))
            if atendimento_atual is not None and getattr(atendimento_atual, "instancia_id", None) is not None
            else (
                int(getattr(cliente, "instancia_id", 0))
                if getattr(cliente, "instancia_id", None) is not None
                else None
            )
        )
    )

    dep_destino = (
        db.query(models.Departamento)
        .filter(
            models.Departamento.id == int(payload.departamento_id),
            models.Departamento.empresa_id == int(empresa_id_eff),
            models.Departamento.ativo.is_(True),
        )
        .first()
    )

    if not dep_destino:
        raise HTTPException(status_code=404, detail="Departamento de destino não encontrado")

    if not _departamento_permitido_na_instancia(
        db,
        empresa_id=int(empresa_id_eff),
        departamento_id=int(dep_destino.id),
        instancia_id=instancia_id_eff,
    ):
        raise HTTPException(
            status_code=400,
            detail="Esse departamento não está habilitado para a instância da conversa",
        )

    dep_anterior_id = (
        getattr(atendimento_atual, "departamento_id", None)
        if atendimento_atual is not None and getattr(atendimento_atual, "departamento_id", None) is not None
        else getattr(cliente, "departamento_id", None)
    )

    dep_anterior_nome = None

    if dep_anterior_id:
        dep_old = (
            db.query(models.Departamento)
            .filter(
                models.Departamento.empresa_id == int(empresa_id_eff),
                models.Departamento.id == int(dep_anterior_id),
            )
            .first()
        )
        dep_anterior_nome = getattr(dep_old, "nome", None) if dep_old else None

    primary_colab_id = None

    if payload.atribuir_responsavel_primario:
        primary_colab_id = _fetch_primary_colab_id(
            db,
            empresa_id=int(empresa_id_eff),
            departamento_id=int(dep_destino.id),
        )

    # Bloqueia a conversa antes de alterar departamento/responsável.
    cliente = (
        db.query(models.Cliente)
        .filter(
            models.Cliente.empresa_id == int(empresa_id_eff),
            models.Cliente.id == int(cliente_id),
        )
        .with_for_update()
        .first()
    )
    if cliente is None:
        raise HTTPException(status_code=404, detail="Cliente não encontrado")

    if instancia_id_eff is None:
        raise HTTPException(
            status_code=400,
            detail="Não foi possível identificar o WhatsApp desta conversa.",
        )

    cliente.departamento_id = int(dep_destino.id)
    if hasattr(cliente, "departamento"):
        cliente.departamento = dep_destino.nome

    atd = get_open_atendimento_locked(
        db,
        empresa_id=int(empresa_id_eff),
        cliente_id=int(cliente.id),
        instancia_id=int(instancia_id_eff),
    )
    if atd is None:
        atd = ensure_open_atendimento_locked(
            db,
            empresa_id=int(empresa_id_eff),
            cliente_id=int(cliente.id),
            instancia_id=int(instancia_id_eff),
            departamento_id=int(dep_destino.id),
            initial_status=models.StatusAtendimento.AGUARDANDO,
        )
    if atd is None:
        raise HTTPException(
            status_code=500,
            detail="Não foi possível criar ou atualizar o atendimento.",
        )

    now = _now_utc()
    atd.departamento_id = int(dep_destino.id)
    atd.instancia_id = int(instancia_id_eff)
    atd.fila_id = None
    if hasattr(atd, "fila_escolhida_em"):
        atd.fila_escolhida_em = None

    if payload.limpar_operador_atual:
        # Transferência de departamento é uma troca de contexto: participantes
        # do departamento anterior não devem continuar respondendo por acidente.
        atd = release_to_queue(db, atendimento=atd) or atd
        if primary_colab_id is not None:
            atd = claim_exclusive_operator(
                db,
                atendimento=atd,
                colaborador_id=int(primary_colab_id),
            ) or atd
            cliente.colaborador_id = int(primary_colab_id)
        else:
            cliente.colaborador_id = None
    elif primary_colab_id is not None and getattr(atd, "operador_id", None) is None:
        atd = claim_if_available(
            db,
            atendimento=atd,
            colaborador_id=int(primary_colab_id),
        ) or atd
        if getattr(atd, "operador_id", None) is not None:
            cliente.colaborador_id = int(atd.operador_id)
    else:
        atd = repair_single_responsible(db, atendimento=atd) or atd
        cliente.colaborador_id = (
            int(atd.operador_id) if getattr(atd, "operador_id", None) is not None else None
        )

    atd.atualizado_em = now
    db.add(cliente)
    db.add(atd)
    db.commit()

    conv_key = f"c:{int(cliente.id)}:{int(instancia_id_eff or 0)}"

    try:
        await conexoes_ativas.send_message(
            f"emp:{int(empresa_id_eff)}",
            {
                "type": "conversation_transferred_department",
                "empresa_id": int(empresa_id_eff),
                "cliente_id": int(cliente.id),
                "conversation_id": conv_key,
                "conversation_key": conv_key,
                "instancia_id": instancia_id_eff,
                "departamento_id": int(dep_destino.id),
                "departamento_nome": dep_destino.nome,
                "departamento_anterior_id": dep_anterior_id,
                "departamento_anterior_nome": dep_anterior_nome,
                "colaborador_id": getattr(cliente, "colaborador_id", None),
                "server_ts": now.isoformat(),
            },
        )
    except Exception:
        pass

    try:
        await conexoes_ativas.send_message(
            f"emp:{int(empresa_id_eff)}",
            {
                "type": "reload_conversas",
                "empresa_id": int(empresa_id_eff),
                "server_ts": now.isoformat(),
            },
        )
    except Exception:
        pass

    return {
        "ok": True,
        "cliente_id": int(cliente.id),
        "conversation_id": conv_key,
        "instancia_id": instancia_id_eff,
        "departamento_id": int(dep_destino.id),
        "departamento_nome": dep_destino.nome,
        "departamento_anterior_id": dep_anterior_id,
        "departamento_anterior_nome": dep_anterior_nome,
        "colaborador_id": getattr(cliente, "colaborador_id", None),
        # Esta rota altera exatamente um atendimento aberto por conversa.
        # A variável antiga ``atendimentos_abertos`` não existia e causava
        # NameError depois do commit, fazendo o frontend informar falha mesmo
        # com a transferência já gravada no banco.
        "atendimentos_atualizados": 1,
    }