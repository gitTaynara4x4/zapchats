# backend/routers/atendimento_chat.py
from __future__ import annotations

from typing import Optional, List, Dict, Any, Tuple
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from backend.database import get_db
from backend import models
from backend.routers.auth import get_current_identity
from backend.websocket_manager import conexoes_ativas

# =========================================================
# Router
# =========================================================
# Mantém as rotas sob /api/atendimento/...
router = APIRouter(prefix="", tags=["Atendimento – Chat"])


# =========================================================
# Utils locais (evitam import circular e centralizam regras)
# =========================================================
def _assert_mesma_empresa(empresa_do_token: int, empresa_da_query: int | None) -> int:
    """Retorna o empresa_id que deve ser usado na query.

    Se empresa_da_query existir, valida que é igual ao do token.
    Caso contrário, usa a do token.
    """
    if empresa_da_query is None:
        return empresa_do_token
    if empresa_da_query != empresa_do_token:
        raise HTTPException(status_code=403, detail="Empresa inválida para este recurso")
    return empresa_da_query


def _normalize_phone(numero: Optional[str]) -> Optional[str]:
    if not numero:
        return None
    s = "".join(ch for ch in str(numero) if ch.isdigit())
    if not s:
        return None
    if s.startswith("0"):
        s = s[1:]
    if not s.startswith("55"):
        s = "55" + s
    if len(s) >= 6:
        ddd = s[2:4]
        restante = s[4:]
        if len(restante) == 8 and not restante.startswith("9"):
            restante = "9" + restante
        s = f"55{ddd}{restante}"
    return s


def _format_phone_br(numero: Optional[str]) -> str:
    if not numero:
        return "—"
    n = "".join(filter(str.isdigit, numero))
    if len(n) == 13:
        return f"+{n[:2]} {n[2:4]} {n[4:9]}-{n[9:]}"
    if len(n) == 12:
        return f"+{n[:2]} {n[2:4]} {n[4:8]}-{n[8:]}"
    return f"+{n[:2]} {n[2:]}" if len(n) > 2 else n


def _display_name_or_phone(
    db: Session,
    empresa_id: int,
    telefone: Optional[str],
    push_name: Optional[str] = None,
    models=None,
) -> str:
    """Hoje não estamos usando aqui, mas deixei utilitário pronto."""
    tel_fmt = _format_phone_br(telefone)
    if not telefone or models is None:
        return push_name or tel_fmt
    cli = (
        db.query(models.Cliente)
        .filter_by(empresa_id=empresa_id, telefone=telefone)
        .first()
    )
    nome = getattr(cli, "nome_whatsapp", None) or getattr(cli, "nome", None) or push_name
    return nome or tel_fmt


def _resolve_instancia_id(
    db: Session,
    *,
    empresa_id: int,
    instancia_id: Optional[int],
    instance: Optional[str],
) -> Tuple[Optional[int], Optional[str]]:
    """Resolve a instância a partir de instancia_id (numérico) ou instance (slug/nome).

    Retorna (instancia_id_resolvido, instance_name_resolvido)
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
        # se não existir, tratamos como "sem instância"
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


def _iso_utc(ts) -> str:
    """Garante retorno ISO-8601 com timezone."""
    try:
        if hasattr(ts, "tzinfo") and ts.tzinfo is None:
            return ts.replace(tzinfo=timezone.utc).isoformat(timespec="microseconds")
        if hasattr(ts, "isoformat"):
            return ts.isoformat(timespec="microseconds")
        return str(ts)
    except Exception:
        return str(ts)


# =========================================================
# REST: listar mensagens da conversa (com filtro de instância + cursor)
# =========================================================
@router.get("/conversas/{cliente_id}/mensagens")
def listar_mensagens(
    cliente_id: int,
    empresa_id: int | None = Query(
        None,
        description="(Opcional) Empresa. Se omitido, usa a do token.",
    ),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    instancia_id: int | None = Query(
        None,
        description="(Opcional) Filtra mensagens por instância (id numérico)",
    ),
    instance: str | None = Query(
        None,
        description="(Opcional) Filtra mensagens por instância (slug/nome)",
    ),
    since_ts: datetime | None = Query(
        None,
        description="(Opcional) Cursor: traz apenas mensagens com timestamp > since_ts (ISO-8601).",
    ),
    since_id: int | None = Query(
        None,
        description="(Opcional) Cursor numérico: traz apenas mensagens com id > since_id.",
    ),
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
):
    """Devolve o histórico de mensagens de um cliente.

    • Suporta filtro de instância via ?instancia_id=ID ou ?instance=SLUG
    • Aceita paginação via ?limit & ?offset (modo "histórico antigo")
    • Aceita cursor incremental via ?since_ts=... e/ou ?since_id=...
      - Quando since_ts/since_id vem, ignora offset e traz somente o delta (mensagens novas)
      - Resultado sempre em ORDEM CRONOLÓGICA ASC (front só append)
    • Formato esperado pelo front:
      {
        "items": [
          {
            "msg_id": "...",
            "conteudo": "...",
            "tipo": "saida"|"entrada",
            "ack": 0|1|2|null,
            "timestamp": "...",
            "instancia_id": 1,
            "instance_name": "minha-inst",
            "midias": [{ "id": 123, "mimetype": "...", "filename": "...", "size": 12345 }],
            "apagada_cliente": false,
            "apagada_usuario": false
          }
        ]
      }
    • Mantém compat: inclui também "mensagens": items
    """
    # empresa efetiva (valida com token)
    empresa_id = _assert_mesma_empresa(identity["empresa_id"], empresa_id)

    # checa permissão de ver atendimentos/mensagens
    perms = set(identity.get("permissoes") or [])
    if "atendimento.ver" not in perms:
        raise HTTPException(status_code=403, detail="Sem permissão para ver mensagens de atendimento")

    # valida cliente/empresa
    cli = (
        db.query(models.Cliente)
        .filter(
            models.Cliente.id == cliente_id,
            models.Cliente.empresa_id == empresa_id,
        )
        .first()
    )
    if not cli:
        raise HTTPException(status_code=404, detail="Cliente não encontrado nessa empresa.")

    # resolve instância (id e nome), se vier
    resolved_inst_id, resolved_inst_name = _resolve_instancia_id(
        db,
        empresa_id=empresa_id,
        instancia_id=instancia_id,
        instance=instance,
    )

    # base sem ordenação (ordem será aplicada depois, dependendo do modo)
    q = (
        db.query(
            models.Mensagem.id,
            models.Mensagem.msg_id,
            models.Mensagem.conteudo,
            models.Mensagem.tipo,
            models.Mensagem.ack,
            models.Mensagem.timestamp,
            models.Mensagem.instancia_id,
            models.EmpresaInstancia.instance_name.label("instance_name"),
            models.Mensagem.apagada_cliente,
            models.Mensagem.apagada_usuario,
        )
        .outerjoin(
            models.EmpresaInstancia,
            models.EmpresaInstancia.id == models.Mensagem.instancia_id,
        )
        .filter(
            models.Mensagem.empresa_id == empresa_id,
            models.Mensagem.cliente_id == cliente_id,
            models.Mensagem.apagada_usuario == False,  # soft delete (lado atendente)
        )
    )

    if resolved_inst_id is not None:
        q = q.filter(models.Mensagem.instancia_id == resolved_inst_id)

    # -------------------------
    #   FILTROS DE CURSOR
    # -------------------------
    if since_id is not None:
        q = q.filter(models.Mensagem.id > since_id)

    if since_ts is not None:
        q = q.filter(models.Mensagem.timestamp > since_ts)

    incremental = (since_ts is not None) or (since_id is not None)

    # -------------------------
    #   ORDEM / LIMIT / OFFSET
    # -------------------------
    if incremental:
        # Modo "delta": traz APENAS o que é mais novo, ascendente (para o front só append)
        q = q.order_by(models.Mensagem.timestamp.asc(), models.Mensagem.id.asc())
        rows = q.limit(limit).all()
    else:
        # Modo antigo: paginação por offset, mais recentes primeiro (eficiente)
        q = q.order_by(models.Mensagem.timestamp.desc(), models.Mensagem.id.desc())
        rows = q.limit(limit).offset(offset).all()

    # --------- mídias por mensagem (batch) ---------
    midias_by_msg: Dict[int, List[Dict[str, Any]]] = {}
    try:
        msg_ids = [r.id for r in rows]
        if msg_ids:
            mids = (
                db.query(models.MensagemMidia)
                .filter(
                    models.MensagemMidia.empresa_id == empresa_id,
                    models.MensagemMidia.cliente_id == cliente_id,
                    models.MensagemMidia.mensagem_id.in_(msg_ids),
                )
                .all()
            )
            for mm in mids or []:
                midias_by_msg.setdefault(mm.mensagem_id, []).append(
                    {
                        "id": getattr(mm, "id", None),
                        "mimetype": getattr(mm, "mimetype", None) or getattr(mm, "mime", None),
                        "filename": getattr(mm, "filename", None) or getattr(mm, "name", None),
                        "size": getattr(mm, "size", None) or getattr(mm, "bytes", None),
                    }
                )
    except Exception:
        # Fallback: se houver relação ORM Mensagem.midias
        try:
            for r in rows:
                arr = []
                for a in getattr(r, "midias", []) or []:
                    arr.append(
                        {
                            "id": getattr(a, "id", None),
                            "mimetype": getattr(a, "mimetype", None) or getattr(a, "mime", None),
                            "filename": getattr(a, "filename", None) or getattr(a, "name", None),
                            "size": getattr(a, "size", None) or getattr(a, "bytes", None),
                        }
                    )
                if arr:
                    midias_by_msg[r.id] = arr
        except Exception:
            pass
    # -----------------------------------------------

    mensagens: List[Dict[str, Any]] = []
    for r in rows:
        mensagens.append(
            {
                "id": r.id,
                "msg_id": r.msg_id,
                "conteudo": r.conteudo,
                "tipo": r.tipo,
                "ack": r.ack,
                "timestamp": _iso_utc(r.timestamp),
                "instancia_id": r.instancia_id,
                "instance_name": r.instance_name,
                "midias": midias_by_msg.get(r.id, []),
                "apagada_cliente": getattr(r, "apagada_cliente", False),
                "apagada_usuario": getattr(r, "apagada_usuario", False),
            }
        )

    # No modo "histórico" (sem cursor), a query veio DESC → inverter para ASC pro front
    if not incremental:
        mensagens = list(reversed(mensagens))

    # log útil para ver o filtro de instância + cursor aplicado
    print(
        f"[ATENDIMENTO] [/conversas/{cliente_id}/mensagens] "
        f"emp={empresa_id} inst={resolved_inst_id or instancia_id or instance} "
        f"limit={limit} offset={offset} incremental={incremental} "
        f"since_ts={since_ts} since_id={since_id}"
    )

    # compat + novo formato
    return {
        "items": mensagens,
        "mensagens": mensagens,  # compat legado
    }


# =========================================================
# ALIAS compatível: /historico/{cliente_id}
# =========================================================
@router.get("/historico/{cliente_id}")
def listar_mensagens_alias_historico(
    cliente_id: int,
    empresa_id: int | None = Query(None),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    instancia_id: int | None = Query(None),
    instance: str | None = Query(None),
    since_ts: datetime | None = Query(None),
    since_id: int | None = Query(None),
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
):
    """Alias para o endpoint principal de mensagens.

    Mantido por compatibilidade com o front (scroll-up).
    Permite também uso de cursor (?since_ts / ?since_id).
    """
    empresa_id = _assert_mesma_empresa(identity["empresa_id"], empresa_id)
    return listar_mensagens(
        cliente_id=cliente_id,
        empresa_id=empresa_id,
        limit=limit,
        offset=offset,
        instancia_id=instancia_id,
        instance=instance,
        since_ts=since_ts,
        since_id=since_id,
        db=db,
        identity=identity,  # repassa a identidade (já validada)
    )


# =========================================================
# DELETE de mensagem (soft delete: marca apagada_usuario=True)
# =========================================================
@router.delete("/conversas/{cliente_id}/mensagens/{msg_id}")
async def apagar_mensagem_atendimento(
    cliente_id: int,
    msg_id: str,
    empresa_id: int | None = Query(None),
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
):
    """Apaga (soft delete) uma mensagem do atendimento.

    • Só ADMIN ou quem tiver 'atendimento.apagar_mensagens'
    • Marca apagada_usuario=True no banco
    • Dispara WebSocket 'msg_deleted' (compatível com ws-empresa.js, depois ajustar lá)
    """
    empresa_id = _assert_mesma_empresa(identity["empresa_id"], empresa_id)

    perms = set(identity.get("permissoes") or [])
    is_admin = bool(identity.get("is_admin"))
    if not (is_admin or "atendimento.apagar_mensagens" in perms):
        raise HTTPException(
            status_code=403,
            detail="Sem permissão para apagar mensagens de atendimento",
        )

    # Busca mensagens por empresa + cliente + msg_id (eventual duplicado)
    q = (
        db.query(models.Mensagem)
        .filter(
            models.Mensagem.empresa_id == empresa_id,
            models.Mensagem.cliente_id == cliente_id,
            models.Mensagem.msg_id == msg_id,
        )
    )

    rows = q.all()
    if not rows:
        raise HTTPException(status_code=404, detail="Mensagem não encontrada")

    # Soft delete: marca apagada pelo usuário (lado atendente)
    for m in rows:
        m.apagada_usuario = True
    db.commit()

    # Notifica via WebSocket (grupo da empresa)
    payload = {
        "type": "msg_deleted",
        "empresa_id": empresa_id,
        "cliente_id": cliente_id,
        "msg_id": msg_id,
        "apagada_usuario": True,
    }
    try:
        await conexoes_ativas.send_message(f"emp:{int(empresa_id)}", payload)
    except Exception as e:
        # Se der erro no WS, não quebra o DELETE (a mensagem já está marcada no banco)
        print("[ATENDIMENTO][DELETE_MSG][WS][ERRO]", e)

    return {"ok": True, "msg_id": msg_id, "count": len(rows)}
