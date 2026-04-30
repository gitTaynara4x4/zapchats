# backend/routers/atendimento_conversas/query_helpers.py
from __future__ import annotations

from typing import Optional, List, Dict, Any

from sqlalchemy.orm import Session
from sqlalchemy import func, literal, and_, or_

from backend import models

from .utils import (
    _get_atendimento_caps,
    _status_to_str,
    _public_avatar_url,
    _conv_ref_cliente,
    _default_fila_state,
)


# =========================================================
# Query helpers
# =========================================================
def _query_clientes_ultima_por_conversa(
    db: Session,
    *,
    empresa_id: int,
    resolved_inst_id: Optional[int],
    allowed_inst_ids: Optional[List[int]],
    allowed_dep_ids: Optional[List[int]],
):
    M = models.Mensagem
    C = models.Cliente
    EI = models.EmpresaInstancia
    CO = models.Colaborador

    sub_msg = (
        db.query(
            M.cliente_id.label("cid"),
            M.instancia_id.label("iid"),
            func.max(M.id).label("last_msg_id"),
        )
        .filter(M.empresa_id == int(empresa_id))
    )

    if resolved_inst_id is not None:
        sub_msg = sub_msg.filter(M.instancia_id == int(resolved_inst_id))

    elif allowed_inst_ids is not None:
        if not allowed_inst_ids:
            sub_msg = sub_msg.filter(literal(False))
        else:
            sub_msg = sub_msg.filter(M.instancia_id.in_([int(x) for x in allowed_inst_ids]))

    sub_msg = sub_msg.group_by(M.cliente_id, M.instancia_id).subquery()

    caps = _get_atendimento_caps()
    A = caps["model"]

    if caps["usable"]:
        sub_atd = db.query(
            A.cliente_id.label("cid"),
            A.instancia_id.label("iid"),
            func.max(A.id).label("last_atd_id"),
        )

        if caps["has_empresa_id"]:
            sub_atd = sub_atd.filter(A.empresa_id == int(empresa_id))

        if resolved_inst_id is not None:
            sub_atd = sub_atd.filter(A.instancia_id == int(resolved_inst_id))

        elif allowed_inst_ids is not None:
            if not allowed_inst_ids:
                sub_atd = sub_atd.filter(literal(False))
            else:
                sub_atd = sub_atd.filter(A.instancia_id.in_([int(x) for x in allowed_inst_ids]))

        sub_atd = sub_atd.group_by(A.cliente_id, A.instancia_id).subquery()

        acl_dep_expr = (
            func.coalesce(A.departamento_id, C.departamento_id)
            if caps["has_departamento_id"]
            else C.departamento_id
        )

        q = (
            db.query(
                C.id.label("cliente_id"),
                C.empresa_id.label("empresa_id"),
                C.nome.label("nome"),
                (C.nome_whatsapp if hasattr(C, "nome_whatsapp") else literal(None)).label("nome_whatsapp"),
                C.telefone.label("telefone"),
                (C.avatar_url if hasattr(C, "avatar_url") else literal(None)).label("avatar_url"),
                C.departamento_id.label("cliente_departamento_id"),
                M.id.label("ultima_msg_id"),
                M.conteudo.label("ultima_mensagem"),
                M.tipo.label("ultima_tipo"),
                M.ack.label("ultima_ack"),
                M.timestamp.label("hora"),
                M.instancia_id.label("instancia_id"),
                (EI.instance_name if hasattr(EI, "instance_name") else literal(None)).label("instance_name"),
                ((C.pinned if hasattr(C, "pinned") else literal(False))).label("pinned"),
                ((C.fixado if hasattr(C, "fixado") else literal(False))).label("fixado"),
                A.id.label("atendimento_id"),
                (A.departamento_id if caps["has_departamento_id"] else literal(None)).label("atendimento_departamento_id"),
                (A.operador_id if caps["has_operador_id"] else literal(None)).label("operador_id"),
                (A.status if caps["has_status"] else literal(None)).label("atendimento_status"),
                CO.nome.label("operador_nome"),
                acl_dep_expr.label("acl_departamento_id"),
            )
            .join(sub_msg, and_(sub_msg.c.cid == C.id))
            .join(M, M.id == sub_msg.c.last_msg_id)
            .outerjoin(
                sub_atd,
                and_(
                    sub_atd.c.cid == C.id,
                    sub_atd.c.iid == M.instancia_id,
                ),
            )
            .outerjoin(A, A.id == sub_atd.c.last_atd_id)
            .outerjoin(CO, CO.id == A.operador_id)
            .outerjoin(EI, EI.id == M.instancia_id)
            .filter(C.empresa_id == int(empresa_id))
        )

    else:
        acl_dep_expr = C.departamento_id

        q = (
            db.query(
                C.id.label("cliente_id"),
                C.empresa_id.label("empresa_id"),
                C.nome.label("nome"),
                (C.nome_whatsapp if hasattr(C, "nome_whatsapp") else literal(None)).label("nome_whatsapp"),
                C.telefone.label("telefone"),
                (C.avatar_url if hasattr(C, "avatar_url") else literal(None)).label("avatar_url"),
                C.departamento_id.label("cliente_departamento_id"),
                M.id.label("ultima_msg_id"),
                M.conteudo.label("ultima_mensagem"),
                M.tipo.label("ultima_tipo"),
                M.ack.label("ultima_ack"),
                M.timestamp.label("hora"),
                M.instancia_id.label("instancia_id"),
                (EI.instance_name if hasattr(EI, "instance_name") else literal(None)).label("instance_name"),
                ((C.pinned if hasattr(C, "pinned") else literal(False))).label("pinned"),
                ((C.fixado if hasattr(C, "fixado") else literal(False))).label("fixado"),
                literal(None).label("atendimento_id"),
                literal(None).label("atendimento_departamento_id"),
                literal(None).label("operador_id"),
                literal(None).label("atendimento_status"),
                literal(None).label("operador_nome"),
                acl_dep_expr.label("acl_departamento_id"),
            )
            .join(sub_msg, and_(sub_msg.c.cid == C.id))
            .join(M, M.id == sub_msg.c.last_msg_id)
            .outerjoin(EI, EI.id == M.instancia_id)
            .filter(C.empresa_id == int(empresa_id))
        )

    if allowed_dep_ids is not None:
        if not allowed_dep_ids:
            q = q.filter(acl_dep_expr.is_(None))
        else:
            q = q.filter(
                or_(
                    acl_dep_expr.in_([int(x) for x in allowed_dep_ids]),
                    acl_dep_expr.is_(None),
                )
            )

    return q


def _query_grupos_ultima_por_conversa(
    db: Session,
    *,
    empresa_id: int,
    resolved_inst_id: Optional[int],
    allowed_inst_ids: Optional[List[int]],
):
    G = models.Grupo
    MG = models.MensagemGrupo
    EI = models.EmpresaInstancia

    sub = (
        db.query(
            MG.grupo_id.label("gid"),
            MG.instancia_id.label("iid"),
            func.max(MG.id).label("last_msg_id"),
        )
        .filter(MG.empresa_id == int(empresa_id))
    )

    if resolved_inst_id is not None:
        sub = sub.filter(MG.instancia_id == int(resolved_inst_id))

    elif allowed_inst_ids is not None:
        if not allowed_inst_ids:
            sub = sub.filter(literal(False))
        else:
            sub = sub.filter(MG.instancia_id.in_([int(x) for x in allowed_inst_ids]))

    sub = sub.group_by(MG.grupo_id, MG.instancia_id).subquery()

    q = (
        db.query(
            G.id.label("grupo_id"),
            G.nome.label("nome"),
            G.remote_jid.label("telefone"),
            G.avatar_url.label("avatar_url"),
            MG.id.label("ultima_msg_id"),
            MG.conteudo.label("ultima_mensagem"),
            MG.tipo.label("ultima_tipo"),
            MG.ack.label("ultima_ack"),
            func.to_timestamp(MG.timestamp).label("hora"),
            MG.instancia_id.label("instancia_id"),
            EI.instance_name.label("instance_name"),
        )
        .join(sub, sub.c.gid == G.id)
        .join(MG, MG.id == sub.c.last_msg_id)
        .outerjoin(EI, EI.id == MG.instancia_id)
        .filter(G.empresa_id == int(empresa_id))
    )

    return q


def _safe_int(v, default: int = 0) -> int:
    try:
        if v is None:
            return default
        return int(v)
    except Exception:
        return default


def _build_cliente_payload_from_row(r) -> Dict[str, Any]:
    cli_id = int(r.cliente_id)
    inst_id = int(r.instancia_id) if r.instancia_id is not None else None
    conv_ref = _conv_ref_cliente(cli_id, inst_id)
    msg_id = int(getattr(r, "ultima_msg_id", 0) or 0)
    pinned_flag = bool(getattr(r, "pinned", False) or getattr(r, "fixado", False))

    departamento_id = (
        int(getattr(r, "atendimento_departamento_id", 0))
        if getattr(r, "atendimento_departamento_id", None) is not None
        else (
            int(getattr(r, "cliente_departamento_id", 0))
            if getattr(r, "cliente_departamento_id", None) is not None
            else None
        )
    )

    operador_id = (
        int(getattr(r, "operador_id", 0))
        if getattr(r, "operador_id", None) is not None
        else None
    )

    status_atd = _status_to_str(getattr(r, "atendimento_status", None))

    novas = _safe_int(getattr(r, "novas", 0), 0)

    return {
        "id": conv_ref,
        "conversation_id": conv_ref,
        "conversation_key": conv_ref,
        "cliente_id": cli_id,
        "cliente_base_id": cli_id,
        "nome": getattr(r, "nome", None),
        "nome_whatsapp": getattr(r, "nome_whatsapp", None),
        "telefone": getattr(r, "telefone", None),
        "avatar_url": _public_avatar_url(
            conversation_id=cli_id,
            raw_avatar_url=getattr(r, "avatar_url", None),
        ),
        "ultima_msg_id": msg_id,
        "ultima_mensagem": getattr(r, "ultima_mensagem", None) or "",
        "ultima_tipo": getattr(r, "ultima_tipo", None),
        "ultima_ack": getattr(r, "ultima_ack", None),
        "last_tipo": getattr(r, "ultima_tipo", None),
        "last_ack": getattr(r, "ultima_ack", None),
        "instancia_id": inst_id,
        "instance_name": getattr(r, "instance_name", None),
        "atendimento_id": (
            int(getattr(r, "atendimento_id", 0))
            if getattr(r, "atendimento_id", None) is not None
            else None
        ),
        "departamento_id": departamento_id,
        "operador_id": operador_id,
        "operador_nome": getattr(r, "operador_nome", None),
        "responsavel_id": operador_id,
        "responsavel_nome": getattr(r, "operador_nome", None),
        "status": status_atd,
        **_default_fila_state(),
        "novas": novas,
        "unread": novas,
        "unread_count": novas,
        "nao_lidas": novas,
        "naoLidas": novas,
        "qtd_nao_lidas": novas,
        "qtdNaoLidas": novas,
        "pinned": pinned_flag,
        "is_group": False,
        "participantes": [],
        "participantes_ids": [],
        "aceita_por_mim": False,
        "tem_participantes": False,
        "pode_aceitar": False,
        "pode_liberar": False,
        "pode_responder": True,
        "aguardando_aceite": False,
    }