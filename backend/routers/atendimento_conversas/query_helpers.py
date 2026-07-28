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
    _iso,
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
    department_acl_inst_ids: Optional[List[int]] = None,
    current_colab_id: Optional[int] = None,
    allow_unassigned_department: bool = False,
    only_own_conversations: bool = False,
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

    # Contador oficial das mensagens novas da lista lateral.
    # Antes a conversa subia para o topo pela última mensagem, mas o payload
    # voltava com novas=0; por isso a bolha (1), (2), ... não aparecia.
    sub_novas = (
        db.query(
            M.cliente_id.label("cid"),
            M.instancia_id.label("iid"),
            func.count(M.id).label("novas"),
        )
        .filter(
            M.empresa_id == int(empresa_id),
            M.cliente_id.isnot(None),
            M.instancia_id.isnot(None),
            M.tipo == "entrada",
            M.lida.isnot(True),
        )
    )

    if resolved_inst_id is not None:
        sub_novas = sub_novas.filter(M.instancia_id == int(resolved_inst_id))

    elif allowed_inst_ids is not None:
        if not allowed_inst_ids:
            sub_novas = sub_novas.filter(literal(False))
        else:
            sub_novas = sub_novas.filter(M.instancia_id.in_([int(x) for x in allowed_inst_ids]))

    sub_novas = sub_novas.group_by(M.cliente_id, M.instancia_id).subquery()

    caps = _get_atendimento_caps()
    A = caps["model"]

    FilaModel = getattr(models, "FilaAtendimento", None)

    if caps["usable"]:
        has_fila_id = bool(hasattr(A, "fila_id"))
        has_fila_escolhida_em = bool(hasattr(A, "fila_escolhida_em"))
        fila_model_ok = FilaModel is not None and has_fila_id

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

        fila_id_col = (
            A.fila_id
            if has_fila_id
            else literal(None)
        )

        fila_escolhida_em_col = (
            A.fila_escolhida_em
            if has_fila_escolhida_em
            else literal(None)
        )

        fila_nome_col = (
            FilaModel.nome
            if fila_model_ok and hasattr(FilaModel, "nome")
            else literal(None)
        )

        fila_prioridade_col = (
            FilaModel.prioridade
            if fila_model_ok and hasattr(FilaModel, "prioridade")
            else literal(None)
        )

        fila_sla_minutos_col = (
            FilaModel.sla_minutos
            if fila_model_ok and hasattr(FilaModel, "sla_minutos")
            else literal(None)
        )

        fila_cor_col = (
            FilaModel.cor
            if fila_model_ok and hasattr(FilaModel, "cor")
            else literal(None)
        )

        fila_ativa_col = (
            FilaModel.ativa
            if fila_model_ok and hasattr(FilaModel, "ativa")
            else literal(False)
        )

        fila_exigir_aceite_col = (
            FilaModel.exigir_aceite
            if fila_model_ok and hasattr(FilaModel, "exigir_aceite")
            else literal(False)
        )

        fila_departamento_id_col = (
            FilaModel.departamento_id
            if fila_model_ok and hasattr(FilaModel, "departamento_id")
            else literal(None)
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
                func.coalesce(sub_novas.c.novas, 0).label("novas"),

                (EI.instance_name if hasattr(EI, "instance_name") else literal(None)).label("instance_name"),

                ((C.pinned if hasattr(C, "pinned") else literal(False))).label("pinned"),
                ((C.fixado if hasattr(C, "fixado") else literal(False))).label("fixado"),

                A.id.label("atendimento_id"),
                (A.departamento_id if caps["has_departamento_id"] else literal(None)).label("atendimento_departamento_id"),
                (A.operador_id if caps["has_operador_id"] else literal(None)).label("operador_id"),
                (A.status if caps["has_status"] else literal(None)).label("atendimento_status"),

                fila_id_col.label("fila_id"),
                fila_escolhida_em_col.label("fila_escolhida_em"),
                fila_nome_col.label("fila_nome"),
                fila_prioridade_col.label("fila_prioridade"),
                fila_sla_minutos_col.label("fila_sla_minutos"),
                fila_cor_col.label("fila_cor"),
                fila_ativa_col.label("fila_ativa"),
                fila_exigir_aceite_col.label("fila_exigir_aceite"),
                fila_departamento_id_col.label("fila_departamento_id"),

                CO.nome.label("operador_nome"),
                acl_dep_expr.label("acl_departamento_id"),
            )
            .join(sub_msg, and_(sub_msg.c.cid == C.id))
            .join(M, M.id == sub_msg.c.last_msg_id)
            .outerjoin(
                sub_novas,
                and_(
                    sub_novas.c.cid == C.id,
                    sub_novas.c.iid == M.instancia_id,
                ),
            )
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

        if fila_model_ok:
            q = q.outerjoin(
                FilaModel,
                and_(
                    FilaModel.id == A.fila_id,
                    FilaModel.empresa_id == int(empresa_id),
                ),
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
                func.coalesce(sub_novas.c.novas, 0).label("novas"),

                (EI.instance_name if hasattr(EI, "instance_name") else literal(None)).label("instance_name"),

                ((C.pinned if hasattr(C, "pinned") else literal(False))).label("pinned"),
                ((C.fixado if hasattr(C, "fixado") else literal(False))).label("fixado"),

                literal(None).label("atendimento_id"),
                literal(None).label("atendimento_departamento_id"),
                literal(None).label("operador_id"),
                literal(None).label("atendimento_status"),

                literal(None).label("fila_id"),
                literal(None).label("fila_escolhida_em"),
                literal(None).label("fila_nome"),
                literal(None).label("fila_prioridade"),
                literal(None).label("fila_sla_minutos"),
                literal(None).label("fila_cor"),
                literal(False).label("fila_ativa"),
                literal(False).label("fila_exigir_aceite"),
                literal(None).label("fila_departamento_id"),

                literal(None).label("operador_nome"),
                acl_dep_expr.label("acl_departamento_id"),
            )
            .join(sub_msg, and_(sub_msg.c.cid == C.id))
            .join(M, M.id == sub_msg.c.last_msg_id)
            .outerjoin(
                sub_novas,
                and_(
                    sub_novas.c.cid == C.id,
                    sub_novas.c.iid == M.instancia_id,
                ),
            )
            .outerjoin(EI, EI.id == M.instancia_id)
            .filter(C.empresa_id == int(empresa_id))
        )

    # Escopo opcional "somente minhas conversas". A conversa fica visível
    # quando o colaborador é o operador atual, participante ativo compatível,
    # ou responsável direto pelo cliente antes de existir um atendimento.
    if only_own_conversations:
        if current_colab_id is None:
            q = q.filter(literal(False))
        elif caps["usable"] and caps.get("has_operador_id"):
            own_conditions = [A.operador_id == int(current_colab_id)]

            AP = getattr(models, "AtendimentoParticipante", None)
            if AP is not None:
                active_participant = (
                    db.query(AP.id)
                    .filter(
                        AP.empresa_id == int(empresa_id),
                        AP.atendimento_id == A.id,
                        AP.colaborador_id == int(current_colab_id),
                        AP.is_ativo.is_(True),
                    )
                    .correlate(A)
                    .exists()
                )
                own_conditions.append(active_participant)

            if hasattr(C, "colaborador_id"):
                own_conditions.append(
                    and_(
                        A.id.is_(None),
                        C.colaborador_id == int(current_colab_id),
                    )
                )

            q = q.filter(or_(*own_conditions))
        elif hasattr(C, "colaborador_id"):
            q = q.filter(C.colaborador_id == int(current_colab_id))
        else:
            q = q.filter(literal(False))

    # ACL por departamento na lista de atendimento.
    #
    # Regra do modelo por departamento + assumir atendimento:
    # - Admin/gestor => allowed_dep_ids=None => vê tudo.
    # - Colaborador restrito vê:
    #     1) conversas do(s) departamento(s) dele que ainda NÃO foram assumidas;
    #     2) conversas já atribuídas a ele;
    #     3) sem departamento APENAS se allow_unassigned_department=True.
    #
    # Importante:
    # depois que Amanda assume Financeiro, Luiza também pertence ao Financeiro,
    # mas NÃO deve continuar vendo aquela conversa na fila compartilhada.
    active_department_inst_ids = [
        int(x)
        for x in (department_acl_inst_ids or [])
        if x is not None
    ]

    if allowed_dep_ids is not None and active_department_inst_ids:
        acl_conditions = []

        dep_ids = [int(x) for x in (allowed_dep_ids or []) if x is not None]
        has_operator_acl = bool(caps["usable"] and caps.get("has_operador_id"))

        if has_operator_acl:
            owner_is_empty = A.operador_id.is_(None)
            owner_is_me = literal(False)

            if current_colab_id is not None:
                try:
                    owner_is_me = A.operador_id == int(current_colab_id)
                except Exception:
                    owner_is_me = literal(False)

            if dep_ids:
                acl_conditions.append(
                    and_(
                        acl_dep_expr.in_(dep_ids),
                        or_(owner_is_empty, owner_is_me),
                    )
                )

            if allow_unassigned_department:
                acl_conditions.append(
                    and_(
                        acl_dep_expr.is_(None),
                        owner_is_empty,
                    )
                )

            if current_colab_id is not None:
                try:
                    acl_conditions.append(A.operador_id == int(current_colab_id))
                except Exception:
                    pass

        else:
            if dep_ids:
                acl_conditions.append(acl_dep_expr.in_(dep_ids))

            if allow_unassigned_department:
                acl_conditions.append(acl_dep_expr.is_(None))

        department_scope = M.instancia_id.in_(active_department_inst_ids)
        outside_department_scope = or_(
            M.instancia_id.is_(None),
            M.instancia_id.notin_(active_department_inst_ids),
        )

        if acl_conditions:
            q = q.filter(
                or_(
                    outside_department_scope,
                    and_(department_scope, or_(*acl_conditions)),
                )
            )
        else:
            # Colaborador sem departamento continua vendo normalmente as
            # instâncias cujo menu por departamentos está desligado.
            q = q.filter(outside_department_scope)

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


def _safe_bool(v, default: bool = False) -> bool:
    try:
        if v is None:
            return default

        if isinstance(v, bool):
            return bool(v)

        s = str(v).strip().lower()

        if s in ("1", "true", "t", "sim", "yes", "y", "on"):
            return True

        if s in ("0", "false", "f", "nao", "não", "no", "n", "off"):
            return False

        return bool(v)
    except Exception:
        return default


def _fila_state_from_row(r) -> Dict[str, Any]:
    """
    Estado de fila vindo da listagem.

    Regra:
    - Sem atendimento.fila_id => fila vazia.
    - Com atendimento.fila_id => envia dados de fila para o front.
    - Badge no front só deve aparecer se tiver fila_id + fila_nome.
    """
    state = _default_fila_state()

    fila_id = getattr(r, "fila_id", None)

    if fila_id is None:
        return state

    try:
        fila_id_int = int(fila_id)
    except Exception:
        return state

    fila_nome = getattr(r, "fila_nome", None)
    fila_exigir = _safe_bool(getattr(r, "fila_exigir_aceite", False), False)

    state.update(
        {
            "fila_id": fila_id_int,
            "fila_nome": fila_nome,
            "fila_prioridade": getattr(r, "fila_prioridade", None),
            "fila_sla_minutos": getattr(r, "fila_sla_minutos", None),
            "fila_cor": getattr(r, "fila_cor", None),
            "fila_ativa": _safe_bool(getattr(r, "fila_ativa", False), False),
            "fila_exigir_aceite": fila_exigir,
            "fila_escolhida_em": _iso(getattr(r, "fila_escolhida_em", None)),
            "fila_departamento_id": (
                int(getattr(r, "fila_departamento_id"))
                if getattr(r, "fila_departamento_id", None) is not None
                else None
            ),

            # aliases diretos para front
            "exigir_aceite": fila_exigir,
            "aceite_obrigatorio": fila_exigir,
        }
    )

    return state


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

    fila_state = _fila_state_from_row(r)

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

        # Dados reais de fila para a lista lateral.
        # Se não tiver fila_id, isso vem zerado pelo _default_fila_state().
        **fila_state,

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

        # Mantém comportamento antigo da lista.
        # O bloqueio real de resposta continua vindo do /meta e do envio.
        "pode_responder": True,
        "aguardando_aceite": False,
    }