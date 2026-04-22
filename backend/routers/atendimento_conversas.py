# backend/routers/atendimento_conversas.py
from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional, List, Dict, Any, Tuple

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session
from sqlalchemy import func, literal, and_

from backend.database import get_db
from backend import models
from backend.routers.auth import get_current_identity
from backend.security.atendimento_acl import (
    ensure_perm,
    resolve_acl_context,
    assert_instancia_allowed,
)

router = APIRouter(tags=["Atendimento – Conversas"])


# =========================================================
# Utils
# =========================================================
def _resolve_instancia_id(
    db: Session,
    *,
    empresa_id: int,
    instancia_id: Optional[int],
    instance: Optional[str],
) -> Tuple[Optional[int], Optional[str]]:
    if instancia_id is not None:
        row = (
            db.query(models.EmpresaInstancia)
            .filter(
                models.EmpresaInstancia.empresa_id == int(empresa_id),
                models.EmpresaInstancia.id == int(instancia_id),
            )
            .first()
        )
        if row:
            return int(row.id), row.instance_name
        return None, None

    if instance:
        row = (
            db.query(models.EmpresaInstancia)
            .filter(
                models.EmpresaInstancia.empresa_id == int(empresa_id),
                models.EmpresaInstancia.instance_name == str(instance),
            )
            .first()
        )
        if row:
            return int(row.id), row.instance_name
        return None, None

    return None, None


def _iso(ts) -> Optional[str]:
    if ts is None:
        return None
    try:
        if hasattr(ts, "tzinfo") and ts.tzinfo is None:
            ts = ts.replace(tzinfo=timezone.utc)
        return ts.isoformat()
    except Exception:
        try:
            return datetime.fromtimestamp(int(ts), tz=timezone.utc).isoformat()
        except Exception:
            return None


def _public_avatar_url(*, conversation_id: int, raw_avatar_url: Optional[str]) -> Optional[str]:
    if not conversation_id:
        return None

    raw = (raw_avatar_url or "").strip()
    if not raw:
        return None

    if raw.startswith("/api/atendimento/avatar/"):
        return raw

    if raw.startswith("http://") or raw.startswith("https://"):
        return f"/api/atendimento/avatar/{int(conversation_id)}"

    return f"/api/atendimento/avatar/{int(conversation_id)}"


def _conv_ref_cliente(cliente_id: int, instancia_id: Optional[int]) -> str:
    return f"c:{int(cliente_id)}:{int(instancia_id or 0)}"


def _conv_ref_grupo(grupo_id: int, instancia_id: Optional[int]) -> str:
    return f"g:{int(grupo_id)}:{int(instancia_id or 0)}"


def _sort_key(ent: tuple[Optional[datetime], int, Dict[str, Any], bool]):
    ts_dt, msg_id, _payload, _is_cli = ent
    if ts_dt is None:
        return (datetime.min.replace(tzinfo=timezone.utc), msg_id)
    if hasattr(ts_dt, "tzinfo") and ts_dt.tzinfo is None:
        ts_dt = ts_dt.replace(tzinfo=timezone.utc)
    return (ts_dt, msg_id)


def _get_atendimento_caps():
    A = getattr(models, "Atendimento", None)
    if A is None:
        return {
            "model": None,
            "usable": False,
            "has_empresa_id": False,
            "has_departamento_id": False,
        }

    usable = all(hasattr(A, attr) for attr in ("id", "cliente_id", "instancia_id"))
    has_empresa_id = hasattr(A, "empresa_id")
    has_departamento_id = hasattr(A, "departamento_id")

    return {
        "model": A,
        "usable": usable,
        "has_empresa_id": has_empresa_id,
        "has_departamento_id": has_departamento_id,
    }


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
        sub_atd = (
            db.query(
                A.cliente_id.label("cid"),
                A.instancia_id.label("iid"),
                func.max(A.id).label("last_atd_id"),
            )
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
                (
                    A.departamento_id
                    if caps["has_departamento_id"]
                    else literal(None)
                ).label("atendimento_departamento_id"),
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
                acl_dep_expr.label("acl_departamento_id"),
            )
            .join(sub_msg, and_(sub_msg.c.cid == C.id))
            .join(M, M.id == sub_msg.c.last_msg_id)
            .outerjoin(EI, EI.id == M.instancia_id)
            .filter(C.empresa_id == int(empresa_id))
        )

    if allowed_dep_ids is not None:
        if not allowed_dep_ids:
            q = q.filter(literal(False))
        else:
            q = q.filter(acl_dep_expr.in_([int(x) for x in allowed_dep_ids]))

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


# =========================================================
# GET /conversas
# =========================================================
@router.get("/conversas")
def listar_conversas(
    empresa_id: int = Query(..., description="Empresa (obrigatório)"),
    limit: int = Query(20, ge=1, le=200),
    cursor_last_msg_id: Optional[int] = Query(None, description="Cursor da última mensagem da página anterior"),
    instancia_id: int | None = Query(None, description="(Opcional) id numérico da instância"),
    instance: str | None = Query(None, description="(Opcional) slug/nome da instância"),
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
):
    ensure_perm(identity, "atendimento.ver")

    acl_ctx = resolve_acl_context(db, identity=identity, empresa_id=empresa_id)
    empresa_id = int(acl_ctx["empresa_id"])
    allowed_inst_ids = acl_ctx["allowed_instancias"]
    allowed_dep_ids = acl_ctx["allowed_departamentos"]

    M = models.Mensagem
    MG = models.MensagemGrupo

    resolved_inst_id, _resolved_inst_name = _resolve_instancia_id(
        db,
        empresa_id=empresa_id,
        instancia_id=instancia_id,
        instance=instance,
    )

    if allowed_inst_ids is not None and not allowed_inst_ids:
        return {"items": [], "next_cursor": None}

    if resolved_inst_id is not None:
        assert_instancia_allowed(
            allowed_instancias=allowed_inst_ids,
            instancia_id=resolved_inst_id,
        )

    cursor_ts = None
    cursor_id = None
    if cursor_last_msg_id is not None:
        row_cur = (
            db.query(M.id, M.timestamp)
            .filter(M.empresa_id == int(empresa_id), M.id == int(cursor_last_msg_id))
            .first()
        )
        if row_cur:
            cursor_id = int(row_cur.id)
            cursor_ts = row_cur.timestamp

    q_clientes = _query_clientes_ultima_por_conversa(
        db,
        empresa_id=empresa_id,
        resolved_inst_id=resolved_inst_id,
        allowed_inst_ids=allowed_inst_ids,
        allowed_dep_ids=allowed_dep_ids,
    )

    if cursor_id is not None and cursor_ts is not None:
        q_clientes = q_clientes.filter(
            and_(
                (M.timestamp < cursor_ts)
                | ((M.timestamp == cursor_ts) & (M.id < cursor_id))
            )
        )

    base_limit = limit
    limit_db = base_limit * 2 if cursor_last_msg_id is None else base_limit

    rows_clientes = (
        q_clientes.order_by(M.timestamp.desc(), M.id.desc())
        .limit(limit_db)
        .all()
    )

    rows_grupos = []
    if cursor_last_msg_id is None:
        q_grupos = _query_grupos_ultima_por_conversa(
            db,
            empresa_id=empresa_id,
            resolved_inst_id=resolved_inst_id,
            allowed_inst_ids=allowed_inst_ids,
        )
        rows_grupos = (
            q_grupos.order_by(func.to_timestamp(MG.timestamp).desc(), MG.id.desc())
            .limit(limit_db)
            .all()
        )

    entries: List[tuple[Optional[datetime], int, Dict[str, Any], bool]] = []

    for r in rows_clientes:
        cli_id = int(r.cliente_id)
        inst_id = int(r.instancia_id) if r.instancia_id is not None else None
        conv_ref = _conv_ref_cliente(cli_id, inst_id)
        msg_id = int(getattr(r, "ultima_msg_id", 0) or 0)
        ts_dt = getattr(r, "hora", None)
        pinned_flag = bool(getattr(r, "pinned", False) or getattr(r, "fixado", False))

        payload: Dict[str, Any] = {
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
            "departamento_id": (
                int(getattr(r, "atendimento_departamento_id", 0))
                if getattr(r, "atendimento_departamento_id", None) is not None
                else (
                    int(getattr(r, "cliente_departamento_id", 0))
                    if getattr(r, "cliente_departamento_id", None) is not None
                    else None
                )
            ),
            "novas": 0,
            "pinned": pinned_flag,
            "is_group": False,
        }
        entries.append((ts_dt, msg_id, payload, True))

    for g in rows_grupos:
        grp_id = int(getattr(g, "grupo_id", 0) or 0)
        inst_id = int(getattr(g, "instancia_id", 0) or 0) or None
        conv_ref = _conv_ref_grupo(grp_id, inst_id)
        msg_id = int(getattr(g, "ultima_msg_id", 0) or 0)
        ts_dt = getattr(g, "hora", None)

        payload_g: Dict[str, Any] = {
            "id": conv_ref,
            "conversation_id": conv_ref,
            "conversation_key": conv_ref,
            "cliente_id": None,
            "grupo_id": grp_id,
            "grupo_base_id": grp_id,
            "nome": getattr(g, "nome", None),
            "nome_whatsapp": None,
            "telefone": getattr(g, "telefone", None),
            "avatar_url": _public_avatar_url(
                conversation_id=grp_id,
                raw_avatar_url=getattr(g, "avatar_url", None),
            ),
            "ultima_msg_id": msg_id,
            "ultima_mensagem": getattr(g, "ultima_mensagem", None) or "",
            "ultima_tipo": getattr(g, "ultima_tipo", None),
            "ultima_ack": getattr(g, "ultima_ack", None),
            "last_tipo": getattr(g, "ultima_tipo", None),
            "last_ack": getattr(g, "ultima_ack", None),
            "instancia_id": inst_id,
            "instance_name": getattr(g, "instance_name", None),
            "novas": 0,
            "pinned": False,
            "is_group": True,
        }
        entries.append((ts_dt, msg_id, payload_g, False))

    entries.sort(key=_sort_key, reverse=True)
    entries = entries[:base_limit]

    items: List[Dict[str, Any]] = []
    cliente_msg_ids_visiveis: List[int] = []

    for ts_dt, msg_id, payload, is_cli in entries:
        ts_iso = _iso(ts_dt)
        payload["hora"] = ts_iso
        payload["last_ts"] = ts_iso
        items.append(payload)
        if is_cli and msg_id:
            cliente_msg_ids_visiveis.append(msg_id)

    next_cursor = min(cliente_msg_ids_visiveis) if cliente_msg_ids_visiveis else None
    return {"items": items, "next_cursor": next_cursor}