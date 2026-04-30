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


def _instancia_tem_vinculos_departamento(
    db: Session,
    *,
    empresa_id: int,
    instancia_id: int,
) -> bool:
    row = db.execute(
        text(
            """
            SELECT 1
            FROM departamentos_instancias
            WHERE empresa_id = :empresa_id
              AND instancia_id = :instancia_id
            LIMIT 1
            """
        ),
        {
            "empresa_id": int(empresa_id),
            "instancia_id": int(instancia_id),
        },
    ).first()
    return bool(row)


def _departamento_permitido_na_instancia(
    db: Session,
    *,
    empresa_id: int,
    departamento_id: int,
    instancia_id: Optional[int],
) -> bool:
    if instancia_id is None:
        return True

    has_links = _instancia_tem_vinculos_departamento(
        db,
        empresa_id=int(empresa_id),
        instancia_id=int(instancia_id),
    )
    if not has_links:
        return True

    row = db.execute(
        text(
            """
            SELECT 1
            FROM departamentos_instancias
            WHERE empresa_id = :empresa_id
              AND departamento_id = :departamento_id
              AND instancia_id = :instancia_id
            LIMIT 1
            """
        ),
        {
            "empresa_id": int(empresa_id),
            "departamento_id": int(departamento_id),
            "instancia_id": int(instancia_id),
        },
    ).first()
    return bool(row)


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
    acl_ctx = resolve_acl_context(db, identity=identity, empresa_id=int(empresa_id_eff))
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
    acl_ctx = resolve_acl_context(db, identity=identity, empresa_id=int(empresa_id_eff))
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
        dep_old = db.query(models.Departamento).filter(models.Departamento.id == int(dep_anterior_id)).first()
        dep_anterior_nome = getattr(dep_old, "nome", None) if dep_old else None

    primary_colab_id = None
    if payload.atribuir_responsavel_primario:
        primary_colab_id = _fetch_primary_colab_id(
            db,
            empresa_id=int(empresa_id_eff),
            departamento_id=int(dep_destino.id),
        )

    cliente.departamento_id = int(dep_destino.id)
    if hasattr(cliente, "departamento"):
        cliente.departamento = dep_destino.nome

    if payload.limpar_operador_atual:
        cliente.colaborador_id = int(primary_colab_id) if primary_colab_id else None
    elif primary_colab_id and not getattr(cliente, "colaborador_id", None):
        cliente.colaborador_id = int(primary_colab_id)

    q_atd = (
        db.query(models.Atendimento)
        .filter(
            models.Atendimento.empresa_id == int(empresa_id_eff),
            models.Atendimento.cliente_id == int(cliente.id),
        )
    )

    if instancia_id_eff is not None:
        q_atd = q_atd.filter(models.Atendimento.instancia_id == int(instancia_id_eff))

    try:
        q_atd = q_atd.filter(models.Atendimento.status.in_(_status_abertos()))
    except Exception:
        pass

    atendimentos_abertos = q_atd.all()
    now = _now_utc()

    for atd in atendimentos_abertos:
        atd.departamento_id = int(dep_destino.id)
        atd.atualizado_em = now

        if payload.limpar_operador_atual:
            atd.operador_id = int(primary_colab_id) if primary_colab_id else None
        elif primary_colab_id and not getattr(atd, "operador_id", None):
            atd.operador_id = int(primary_colab_id)

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
        "atendimentos_atualizados": len(atendimentos_abertos),
    }