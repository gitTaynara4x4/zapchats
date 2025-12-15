from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional, List, Dict, Any, Tuple

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session
from sqlalchemy import func, literal, and_

from backend.database import get_db
from backend import models
from backend.routers.auth import get_current_identity
from backend.security.instancias import instancias_visiveis

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
    if ts is None:
        return None
    try:
        return ts.isoformat()
    except Exception:
        # fallback: tentar tratar como epoch (segundos)
        try:
            return datetime.fromtimestamp(int(ts), tz=timezone.utc).isoformat()
        except Exception:
            return None


def _query_grupos_ultima_por_grupo(
    db: Session,
    *,
    empresa_id: int,
    resolved_inst_id: Optional[int],
    allowed_inst_ids: Optional[List[int]] = None,
):
    """
    Retorna um query com a ÚLTIMA mensagem de cada grupo dessa empresa/instância.
    (sem paginação; quem chama decide limit/order depois)
    """
    G = models.Grupo
    MG = models.MensagemGrupo
    EI = models.EmpresaInstancia

    # subquery: última mensagem (por id) de cada grupo
    sub = (
        db.query(
            MG.grupo_id.label("gid"),
            func.max(MG.id).label("last_msg_id"),
        )
        .filter(MG.empresa_id == empresa_id)
    )
    if resolved_inst_id is not None:
        sub = sub.filter(MG.instancia_id == resolved_inst_id)
    if allowed_inst_ids is not None:
        sub = sub.filter(MG.instancia_id.in_(allowed_inst_ids))
    sub = sub.group_by(MG.grupo_id).subquery()

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
            func.to_timestamp(MG.timestamp).label("hora"),  # BigInt epoch -> timestamptz

            MG.instancia_id.label("instancia_id"),
            EI.instance_name.label("instance_name"),
        )
        .join(sub, sub.c.gid == G.id)
        .join(MG, MG.id == sub.c.last_msg_id)
        .outerjoin(EI, EI.id == MG.instancia_id)
        .filter(G.empresa_id == empresa_id)
    )

    return q


# =========================================================
# GET /conversas
# Lista conversas (uma por cliente) + grupos, ordenadas pela última mensagem
# Suporta:
#   • filtro por instância (?instancia_id= / ?instance=)
#   • paginação por cursor (?cursor_last_msg_id=ID)  -> só para clientes
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
          "id": 123, "conversation_id": 123, "cliente_id": 123|null (grupo),
          "nome": "...", "nome_whatsapp": "...",
          "telefone": "55... ou ...@g.us",
          "avatar_url": "http...",
          "ultima_msg_id": 9999,
          "ultima_mensagem": "texto",
          "ultima_tipo": "saida|entrada",
          "ultima_ack": 0|1|2|null,
          "last_tipo": "saida|entrada",
          "last_ack": 0|1|2|null,
          "hora": "2024-01-01T00:00:00Z",
          "last_ts": "2024-01-01T00:00:00Z",
          "instancia_id": 1,
          "instance_name": "minha-inst",
          "novas": 0,
          "pinned": true|false,
          "is_group": true|false
        }
      ],
      "next_cursor": 888   # menor ultima_msg_id de CLIENTE retornado na página (para paginação)
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

    # 3.1) instâncias permitidas para esse login (colaborador)
    allowed_inst_ids = instancias_visiveis(identity, db)
    if allowed_inst_ids is not None and resolved_inst_id is not None:
        # colaborador tentando filtrar numa instância que não é dele
        if resolved_inst_id not in allowed_inst_ids:
            raise HTTPException(status_code=403, detail="Instância não permitida para este colaborador")

    # 4) cursor: se veio cursor_last_msg_id, vamos pegar seu timestamp (APENAS em mensagens de cliente)
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
    if allowed_inst_ids is not None:
        sub = sub.filter(M.instancia_id.in_(allowed_inst_ids))
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

    # 7) paginação por cursor: pega somente itens "mais antigos" que o cursor (somente para clientes)
    #    regra: (timestamp, id) < (cursor_ts, cursor_id)
    if cursor_id is not None and cursor_ts is not None:
        q = q.filter(
            and_(
                (M.timestamp < cursor_ts)
                | ((M.timestamp == cursor_ts) & (M.id < cursor_id))
            )
        )

    # 8) busca de CLIENTES no banco (mantém a lógica antiga)
    #    se for a primeira página (sem cursor), busca um pouco mais para sobrar espaço para misturar grupos
    base_limit = limit
    limit_db = base_limit * 2 if cursor_last_msg_id is None else base_limit

    rows_clientes = (
        q.order_by(M.timestamp.desc(), M.id.desc())
        .limit(limit_db)
        .all()
    )

    # 9) busca de GRUPOS (apenas na primeira página; nas próximas você pagina só clientes mesmo)
    rows_grupos = []
    if cursor_last_msg_id is None:
        qg = _query_grupos_ultima_por_grupo(
            db,
            empresa_id=empresa_id,
            resolved_inst_id=resolved_inst_id,
            allowed_inst_ids=allowed_inst_ids,
        )
        # não deve ter milhares de grupos, mas limit_db dá um teto de segurança
        rows_grupos = (
            qg.order_by(func.to_timestamp(models.MensagemGrupo.timestamp).desc())
            .limit(limit_db)
            .all()
        )

    # 10) montar payload (clientes + grupos) em memória, ordenar, cortar no LIMIT
    entries: List[tuple[Optional[datetime], int, Dict[str, Any], bool]] = []
    # tuple = (ts_datetime, ultima_msg_id, payload_dict, is_cliente_bool)

    # --- clientes ---
    for r in rows_clientes:
        cli_id = int(r.cliente_id)
        msg_id = int(getattr(r, "ultima_msg_id", 0) or 0)
        ts_dt = getattr(r, "hora", None)

        pinned_flag = bool(getattr(r, "pinned", False) or getattr(r, "fixado", False))

        payload: Dict[str, Any] = {
            "id": cli_id,
            "conversation_id": cli_id,
            "cliente_id": cli_id,

            "nome": getattr(r, "nome", None),
            "nome_whatsapp": getattr(r, "nome_whatsapp", None),

            "telefone": getattr(r, "telefone", None),
            "avatar_url": getattr(r, "avatar_url", None),

            "ultima_msg_id": msg_id,
            "ultima_mensagem": getattr(r, "ultima_mensagem", None) or "",
            "ultima_tipo": getattr(r, "ultima_tipo", None),
            "ultima_ack": getattr(r, "ultima_ack", None),

            "last_tipo": getattr(r, "ultima_tipo", None),
            "last_ack": getattr(r, "ultima_ack", None),

            "instancia_id": getattr(r, "instancia_id", None),
            "instance_name": getattr(r, "instance_name", None),

            "novas": 0,           # se você tiver contagem de não lidas, preencha aqui depois
            "pinned": pinned_flag,
            "is_group": False,
        }

        entries.append((ts_dt, msg_id, payload, True))

    # --- grupos (só primeira página) ---
    for g in rows_grupos:
        grp_id = int(getattr(g, "grupo_id", 0) or 0)
        msg_id = int(getattr(g, "ultima_msg_id", 0) or 0)
        ts_dt = getattr(g, "hora", None)

        payload_g: Dict[str, Any] = {
            "id": grp_id,
            "conversation_id": grp_id,
            "cliente_id": None,  # front cai pro id

            "nome": getattr(g, "nome", None),
            "nome_whatsapp": None,

            "telefone": getattr(g, "telefone", None),   # remote_jid: ...@g.us
            "avatar_url": getattr(g, "avatar_url", None),

            "ultima_msg_id": msg_id,
            "ultima_mensagem": getattr(g, "ultima_mensagem", None) or "",
            "ultima_tipo": getattr(g, "ultima_tipo", None),
            "ultima_ack": getattr(g, "ultima_ack", None),

            "last_tipo": getattr(g, "ultima_tipo", None),
            "last_ack": getattr(g, "ultima_ack", None),

            "instancia_id": getattr(g, "instancia_id", None),
            "instance_name": getattr(g, "instance_name", None),

            "novas": 0,
            "pinned": False,
            "is_group": True,
        }

        entries.append((ts_dt, msg_id, payload_g, False))

    # ordenar por (ts, id) DESC
    def _sort_key(ent: tuple[Optional[datetime], int, Dict[str, Any], bool]):
        ts_dt, msg_id, _payload, _is_cli = ent
        if ts_dt is None:
            return (datetime.min.replace(tzinfo=timezone.utc), msg_id)
        return (ts_dt, msg_id)

    entries.sort(key=_sort_key, reverse=True)

    # corta no LIMIT pedido pelo cliente
    entries = entries[:base_limit]

    # 11) converter timestamps para ISO e montar lista final
    items: List[Dict[str, Any]] = []
    cliente_msg_ids_visiveis: List[int] = []

    for ts_dt, msg_id, payload, is_cli in entries:
        ts_iso = _iso(ts_dt)
        payload["hora"] = ts_iso
        payload["last_ts"] = ts_iso
        items.append(payload)

        if is_cli and msg_id:
            cliente_msg_ids_visiveis.append(msg_id)

    # 12) próximo cursor = menor ultima_msg_id de CLIENTE visível na página
    next_cursor = min(cliente_msg_ids_visiveis) if cliente_msg_ids_visiveis else None

    return {"items": items, "next_cursor": next_cursor}
