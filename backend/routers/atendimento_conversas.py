from __future__ import annotations

from typing import Optional, List, Dict, Any, Tuple

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session
from sqlalchemy import func, literal, and_

from backend.database import get_db
from backend import models
from backend.routers.auth import get_current_identity  # <- troca aqui

# =========================================================
# Router
# (deixe sem prefix, pois o include_router do app já usa "/api/atendimento")
# =========================================================
router = APIRouter(tags=["Atendimento – Conversas"])


# =========================================================
# Utils
# =========================================================
def _assert_mesma_empresa(empresa_do_token: int, empresa_da_query: int | None) -> int:
    if empresa_da_query is None:
        return empresa_do_token
    if empresa_da_query != empresa_do_token:
        raise HTTPException(status_code=403, detail="Empresa inválida para este recurso")
    return empresa_da_query


def _resolve_instancia_id(
    db: Session,
    *,
    empresa_id: int,
    instancia_id: Optional[int],
    instance: Optional[str],
) -> Tuple[Optional[int], Optional[str]]:
    """
    Resolve a instância a partir de instancia_id (numérico) ou instance (slug/nome).
    Retorna (instancia_id_resolvido, instance_name_resolvido).
    """
    if instancia_id is not None:
        row = (
            db.query(models.EmpresaInstancia)
            .filter(
                models.EmpresaInstancia.empresa_id == empresa_id,
                models.EmpresaInstancia.id == instancia_id,
            )
            .first()
        )
        if row:
            return row.id, row.instance_name
        return None, None

    if instance:
        row = (
            db.query(models.EmpresaInstancia)
            .filter(
                models.EmpresaInstancia.empresa_id == empresa_id,
                models.EmpresaInstancia.instance_name == instance,
            )
            .first()
        )
        if row:
            return row.id, row.instance_name
        return None, None

    return None, None


def _iso(ts) -> Optional[str]:
    try:
        return ts.isoformat()
    except Exception:
        return None


# =========================================================
# GET /conversas
# Lista conversas (uma por cliente) ordenadas pela última mensagem
# Suporta:
#   • filtro por instância (?instancia_id= / ?instance=)
#   • paginação por cursor (?cursor_last_msg_id=ID)
#   • limit (1..200)
# =========================================================
@router.get("/conversas")
def listar_conversas(
    empresa_id: int = Query(..., description="Empresa (obrigatório)"),
    limit: int = Query(20, ge=1, le=200),
    cursor_last_msg_id: Optional[int] = Query(
        None, description="Cursor da última mensagem (id) da página anterior"
    ),
    instancia_id: int | None = Query(None, description="(Opcional) id numérico da instância"),
    instance: str | None = Query(None, description="(Opcional) slug/nome da instância"),
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
):
    """
    Retorna:
    {
      "items": [
        {
          "id": 123, "conversation_id": 123, "cliente_id": 123,
          "nome": "...", "nome_whatsapp": "...",
          "telefone": "55...",
          "avatar_url": "http...",
          "ultima_msg_id": 9999,
          "ultima_mensagem": "texto",
          "last_tipo": "saida|entrada",
          "last_ack": 0|1|2|null,
          "hora": "2024-01-01T00:00:00Z",
          "last_ts": "2024-01-01T00:00:00Z",
          "instancia_id": 1,
          "instance_name": "minha-inst",
          "pinned": true|false
        }
      ],
      "next_cursor": 888   # menor last_msg_id retornado na página (para paginação)
    }
    """
    # 1) valida empresa (token vs query)
    empresa_id = _assert_mesma_empresa(identity["empresa_id"], empresa_id)

    # 2) checa permissão de atendimento
    perms = set(identity.get("permissoes") or [])
    if "atendimento.ver" not in perms:
        raise HTTPException(status_code=403, detail="Sem permissão para ver atendimentos")

    C = models.Cliente
    M = models.Mensagem
    EI = models.EmpresaInstancia

    # 3) resolve instância (se houver filtro)
    resolved_inst_id, _resolved_inst_name = _resolve_instancia_id(
        db,
        empresa_id=empresa_id,
        instancia_id=instancia_id,
        instance=instance,
    )

    # 4) cursor: se veio cursor_last_msg_id, vamos pegar seu timestamp
    cursor_ts = None
    cursor_id = None
    if cursor_last_msg_id is not None:
        row_cur = (
            db.query(M.id, M.timestamp)
            .filter(M.empresa_id == empresa_id, M.id == int(cursor_last_msg_id))
            .first()
        )
        if row_cur:
            cursor_id = int(row_cur.id)
            cursor_ts = row_cur.timestamp

    # 5) subquery: última mensagem por cliente (com filtro de instância quando informado)
    sub = (
        db.query(
            M.cliente_id.label("cid"),
            func.max(M.id).label("last_msg_id"),  # id geralmente cresce no tempo
        )
        .filter(M.empresa_id == empresa_id)
    )
    if resolved_inst_id is not None:
        sub = sub.filter(M.instancia_id == resolved_inst_id)
    sub = sub.group_by(M.cliente_id).subquery()

    # 6) query principal: cliente + última mensagem + instância
    #    ATENÇÃO: colunas opcionais (pinned/fixado) caem para literal(False)
    cols = [
        C.id.label("cliente_id"),
        C.empresa_id.label("empresa_id"),
        C.nome.label("nome"),
        (C.nome_whatsapp if hasattr(C, "nome_whatsapp") else literal(None)).label("nome_whatsapp"),
        C.telefone.label("telefone"),
        (C.avatar_url if hasattr(C, "avatar_url") else literal(None)).label("avatar_url"),

        M.id.label("ultima_msg_id"),
        M.conteudo.label("ultima_mensagem"),
        M.tipo.label("ultima_tipo"),
        M.ack.label("ultima_ack"),
        M.timestamp.label("hora"),
        M.instancia_id.label("instancia_id"),
        (EI.instance_name if hasattr(EI, "instance_name") else literal(None)).label("instance_name"),

        # flags opcionais
        ((C.pinned if hasattr(C, "pinned") else literal(False))).label("pinned"),
        ((C.fixado if hasattr(C, "fixado") else literal(False))).label("fixado"),
    ]

    q = (
        db.query(*cols)
        .join(sub, sub.c.cid == C.id)
        .join(M, M.id == sub.c.last_msg_id)
        .outerjoin(EI, EI.id == M.instancia_id)
        .filter(C.empresa_id == empresa_id)
    )

    # 7) paginação por cursor: pega somente itens "mais antigos" que o cursor
    #    regra: (timestamp, id) < (cursor_ts, cursor_id)
    if cursor_id is not None and cursor_ts is not None:
        q = q.filter(
            and_(
                (M.timestamp < cursor_ts)
                | ((M.timestamp == cursor_ts) & (M.id < cursor_id))
            )
        )

    # 8) ordenação (mais recentes primeiro), limit e fetch
    rows = (
        q.order_by(M.timestamp.desc(), M.id.desc())
        .limit(limit)
        .all()
    )

    # 9) montar payload
    items: List[Dict[str, Any]] = []
    for r in rows:
        # pinned/coalesce
        pinned_flag = bool(getattr(r, "pinned", False) or getattr(r, "fixado", False))
        ts_iso = _iso(getattr(r, "hora", None))

        items.append({
            "id": int(r.cliente_id),
            "conversation_id": int(r.cliente_id),
            "cliente_id": int(r.cliente_id),

            "nome": getattr(r, "nome", None),
            "nome_whatsapp": getattr(r, "nome_whatsapp", None),

            "telefone": getattr(r, "telefone", None),
            "avatar_url": getattr(r, "avatar_url", None),

            "ultima_msg_id": int(getattr(r, "ultima_msg_id", 0) or 0),
            "ultima_mensagem": getattr(r, "ultima_mensagem", None) or "",
            "last_tipo": getattr(r, "ultima_tipo", None),
            "last_ack": getattr(r, "ultima_ack", None),

            "hora": ts_iso,
            "last_ts": ts_iso,

            "instancia_id": getattr(r, "instancia_id", None),
            "instance_name": getattr(r, "instance_name", None),

            "novas": 0,          # se você tiver contagem de não lidas, preencha aqui
            "pinned": pinned_flag,
        })

    # 10) próximo cursor = menor ultima_msg_id da página atual
    next_cursor = min((it["ultima_msg_id"] for it in items), default=None)

    return {"items": items, "next_cursor": next_cursor}
