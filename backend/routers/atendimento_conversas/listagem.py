# backend\routers\atendimento_conversas\listagem.py
from __future__ import annotations

from datetime import datetime
from typing import Optional, List, Dict, Any

from fastapi import APIRouter, Depends, Query, HTTPException
from sqlalchemy.orm import Session
from sqlalchemy import func, and_, text

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
    _conv_ref_grupo,
    _iso,
    _sort_key,
)

from .colaborador_helpers import (
    _resolve_identity_colab_id,
)

from .participantes import (
    _attach_participacao_em_payloads,
)

from .query_helpers import (
    _query_clientes_ultima_por_conversa,
    _query_grupos_ultima_por_conversa,
    _build_cliente_payload_from_row,
)

router = APIRouter(tags=["Atendimento – Conversas"])


def _empresa_id_segura(identity, empresa_id: Optional[int] = None) -> int:
    raw_emp = None

    try:
        if isinstance(identity, dict):
            raw_emp = identity.get("empresa_id")
        else:
            raw_emp = getattr(identity, "empresa_id", None)
    except Exception:
        raw_emp = None

    if raw_emp is None:
        raise HTTPException(status_code=401, detail="Empresa ausente na sessão")

    try:
        emp_real = int(raw_emp)
    except Exception:
        raise HTTPException(status_code=401, detail="Empresa inválida na sessão")

    if empresa_id is not None:
        try:
            emp_req = int(empresa_id)
        except Exception:
            raise HTTPException(status_code=400, detail="empresa_id inválido")

        if emp_req != emp_real:
            raise HTTPException(status_code=403, detail="Empresa inválida para este usuário")

    return emp_real


def _as_int(v) -> Optional[int]:
    try:
        if v is None:
            return None

        s = str(v).strip()
        if not s:
            return None

        if s.startswith("colab-"):
            s = s.split("-", 1)[1].strip()

        if not s.isdigit():
            return None

        return int(s)
    except Exception:
        return None


def _identity_user_id(identity) -> Optional[int]:
    try:
        if isinstance(identity, dict):
            return _as_int(
                identity.get("id")
                or identity.get("user_id")
                or identity.get("usuario_id")
                or identity.get("sub")
            )

        return _as_int(
            getattr(identity, "id", None)
            or getattr(identity, "user_id", None)
            or getattr(identity, "usuario_id", None)
            or getattr(identity, "sub", None)
        )
    except Exception:
        return None


def _row_cliente_id(row) -> Optional[int]:
    for attr in ("cliente_id", "id", "cid"):
        val = _as_int(getattr(row, attr, None))
        if val:
            return val
    return None


def _row_msg_id(row) -> Optional[int]:
    for attr in ("ultima_msg_id", "last_msg_id", "msg_id", "id"):
        val = _as_int(getattr(row, attr, None))
        if val:
            return val
    return None


def _group_avatar_proxy_url(grupo_id: int, raw_avatar_url: Optional[str]) -> Optional[str]:
    """
    Avatar de grupo precisa passar kind=grupo.
    Sem isso o endpoint /api/atendimento/avatar/{id} tenta buscar Cliente,
    e grupo com id 14/28 vira 404.
    """
    try:
        gid = int(grupo_id)
    except Exception:
        return None

    raw = str(raw_avatar_url or "").strip()
    if not raw:
        return None

    return f"/api/atendimento/avatar/{gid}?kind=grupo"


def _get_pinned_ids_usuario(
    db: Session,
    *,
    empresa_id: int,
    user_id: Optional[int],
    instancia_id: Optional[int] = None,
) -> set[int]:
    if not user_id:
        return set()

    try:
        PinModel = getattr(models, "AtendimentoPinnedConversa", None)
        if PinModel is None:
            return set()

        params = {
            "emp": int(empresa_id),
            "uid": int(user_id),
        }

        sql = """
            SELECT conversa_id
            FROM atendimento_pinned_conversas
            WHERE empresa_id = :emp
              AND user_id = :uid
        """

        if instancia_id is not None:
            sql += " AND instancia_id = :inst"
            params["inst"] = int(instancia_id)

        rows = db.execute(text(sql), params).fetchall()

        return {
            int(r[0])
            for r in rows
            if r and r[0] is not None
        }

    except Exception:
        try:
            db.rollback()
        except Exception:
            pass
        return set()


@router.get("/conversas")
def listar_conversas(
    empresa_id: Optional[int] = Query(None, description="Empresa opcional; backend usa a empresa da sessão"),
    limit: int = Query(20, ge=1, le=200),
    cursor_last_msg_id: Optional[int] = Query(None, description="Cursor da última mensagem da página anterior"),
    instancia_id: int | None = Query(None, description="(Opcional) id numérico da instância"),
    instance: str | None = Query(None, description="(Opcional) slug/nome da instância"),
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
):
    ensure_perm(identity, "atendimento.ver")

    empresa_id_real = _empresa_id_segura(identity, empresa_id)

    acl_ctx = resolve_acl_context(db, identity=identity, empresa_id=empresa_id_real)
    empresa_id = int(acl_ctx["empresa_id"])
    allowed_inst_ids = acl_ctx["allowed_instancias"]
    allowed_dep_ids = acl_ctx["allowed_departamentos"]

    user_id = _identity_user_id(identity)

    current_colab_id = _resolve_identity_colab_id(
        db,
        identity=identity,
        empresa_id=int(empresa_id),
        required=False,
    )

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

    pinned_ids = _get_pinned_ids_usuario(
        db,
        empresa_id=int(empresa_id),
        user_id=user_id,
        instancia_id=resolved_inst_id,
    )

    cursor_ts = None
    cursor_id = None

    if cursor_last_msg_id is not None:
        row_cur = (
            db.query(M.id, M.timestamp)
            .filter(
                M.empresa_id == int(empresa_id),
                M.id == int(cursor_last_msg_id),
            )
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

    if cursor_last_msg_id is not None and pinned_ids:
        try:
            q_clientes = q_clientes.filter(~M.cliente_id.in_([int(x) for x in pinned_ids]))
        except Exception:
            pass

    base_limit = limit
    limit_db = base_limit * 2 if cursor_last_msg_id is None else base_limit

    rows_clientes_base = (
        q_clientes.order_by(M.timestamp.desc(), M.id.desc())
        .limit(limit_db)
        .all()
    )

    rows_clientes = list(rows_clientes_base)

    if cursor_last_msg_id is None and pinned_ids:
        base_cliente_ids = {
            cid
            for cid in (_row_cliente_id(r) for r in rows_clientes_base)
            if cid
        }

        missing_pinned_ids = [
            int(cid)
            for cid in pinned_ids
            if int(cid) not in base_cliente_ids
        ]

        if missing_pinned_ids:
            try:
                rows_pinned_extra = (
                    q_clientes
                    .filter(M.cliente_id.in_(missing_pinned_ids))
                    .order_by(M.timestamp.desc(), M.id.desc())
                    .all()
                )

                rows_clientes.extend(rows_pinned_extra)
            except Exception:
                try:
                    db.rollback()
                except Exception:
                    pass

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

    seen_cliente_ids: set[int] = set()

    for r in rows_clientes:
        cid = _row_cliente_id(r)
        if not cid:
            continue

        if cid in seen_cliente_ids:
            continue

        seen_cliente_ids.add(cid)

        ts_dt = getattr(r, "hora", None)
        payload = _build_cliente_payload_from_row(r)
        msg_id = _row_msg_id(r) or int(getattr(r, "ultima_msg_id", 0) or 0)

        is_pinned = int(cid) in pinned_ids

        payload["pinned"] = is_pinned
        payload["fixado"] = is_pinned

        entries.append((ts_dt, int(msg_id or 0), payload, True))

    for g in rows_grupos:
        grp_id = int(getattr(g, "grupo_id", 0) or 0)
        inst_id = int(getattr(g, "instancia_id", 0) or 0) or None
        conv_ref = _conv_ref_grupo(grp_id, inst_id)
        msg_id = int(getattr(g, "ultima_msg_id", 0) or 0)
        ts_dt = getattr(g, "hora", None)

        raw_avatar_url = getattr(g, "avatar_url", None)

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

            # IMPORTANTE:
            # Grupo usa o mesmo endpoint de avatar, mas precisa de ?kind=grupo.
            # Sem isso, o endpoint tenta procurar Cliente com esse ID e retorna 404.
            "avatar_url": _group_avatar_proxy_url(grp_id, raw_avatar_url),

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
            "fixado": False,
            "is_group": True,
            "participantes": [],
            "participantes_ids": [],
            "aceita_por_mim": False,
            "tem_participantes": False,
            "pode_aceitar": False,
            "pode_liberar": False,
            "responsavel_id": None,
            "responsavel_nome": None,
        }

        entries.append((ts_dt, msg_id, payload_g, False))

    entries_pinned = [e for e in entries if bool(e[2].get("pinned"))]
    entries_normal = [e for e in entries if not bool(e[2].get("pinned"))]

    entries_pinned.sort(key=_sort_key, reverse=True)
    entries_normal.sort(key=_sort_key, reverse=True)

    if cursor_last_msg_id is None:
        entries = entries_pinned + entries_normal[:base_limit]
    else:
        entries = entries_normal[:base_limit]

    items: List[Dict[str, Any]] = []
    cliente_msg_ids_visiveis_normais: List[int] = []

    for ts_dt, msg_id, payload, is_cli in entries:
        ts_iso = _iso(ts_dt)

        payload["hora"] = ts_iso
        payload["last_ts"] = ts_iso

        items.append(payload)

        if is_cli and msg_id and not bool(payload.get("pinned")):
            cliente_msg_ids_visiveis_normais.append(int(msg_id))

    _attach_participacao_em_payloads(
        db,
        empresa_id=int(empresa_id),
        items=items,
        current_colab_id=current_colab_id,
    )

    next_cursor = min(cliente_msg_ids_visiveis_normais) if cliente_msg_ids_visiveis_normais else None

    return {
        "items": items,
        "next_cursor": next_cursor,
    }