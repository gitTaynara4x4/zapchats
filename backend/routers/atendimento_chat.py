# backend/routers/atendimento_chat.py
from __future__ import annotations

from typing import Optional, List, Dict, Any, Tuple
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session
from sqlalchemy import text

from backend.database import get_db
from backend import models
from backend.routers.auth import get_current_identity
from backend.websocket_manager import conexoes_ativas

# =========================================================
# Router
# =========================================================
router = APIRouter(prefix="", tags=["Atendimento – Chat"])


# =========================================================
# ACL / Permissões (mesmo padrão do resto)
# =========================================================
def _to_int(v) -> Optional[int]:
    try:
        if v is None:
            return None
        s = str(v).strip()
        if not s:
            return None
        return int(s)
    except Exception:
        return None


def _is_admin(identity: dict) -> bool:
    try:
        if identity.get("is_admin") or identity.get("admin"):
            return True
        perms = identity.get("permissoes") or identity.get("permissions") or []
        if isinstance(perms, dict):
            perms = [k for k, v in perms.items() if v]
        perms = set(str(p).lower() for p in (perms or []))
        return any(p in perms for p in ("admin", "root", "clientes.gerenciar", "atendimento.gerenciar"))
    except Exception:
        return False


def _ensure_perm(identity: dict, perm: str) -> None:
    if _is_admin(identity):
        return
    perms = set(identity.get("permissoes") or [])
    if perm not in perms:
        raise HTTPException(status_code=403, detail=f"Sem permissão ({perm})")


def _infer_kind(identity: dict) -> str:
    k = (identity.get("kind") or identity.get("tipo") or "").lower().strip()
    if k in ("colaborador", "usuario", "admin"):
        return "colaborador" if k == "colaborador" else "usuario"
    sub = str(identity.get("sub") or "").strip().lower()
    role = str(identity.get("role") or "").strip().lower()
    if sub.startswith("colab-") or "colab" in role or "colaborador" in role:
        return "colaborador"
    return "usuario"


def _get_colab_id(identity: dict) -> Optional[int]:
    for key in ("id_colab", "colaborador_id", "id_colaborador", "colab_id", "cid"):
        cid = _to_int(identity.get(key))
        if cid:
            return cid
    sub = str(identity.get("sub") or "").strip().lower()
    if sub.startswith("colab-"):
        cid = _to_int(sub.split("-", 1)[1])
        if cid:
            return cid
    return _to_int(identity.get("id"))


def _table_exists(db: Session, table_name: str) -> bool:
    try:
        reg = db.execute(text(f"SELECT to_regclass('public.{table_name}')")).scalar()
        return reg is not None
    except Exception:
        return False


def _allowed_instancia_ids(db: Session, identity: dict, empresa_id: int) -> Optional[List[int]]:
    """
    Retorna:
      - None => sem restrição (admin/usuario master OU tabela inexistente)
      - []   => colaborador sem instâncias permitidas (nega tudo)
      - [..] => lista de instâncias permitidas
    """
    if _is_admin(identity):
        return None

    if _infer_kind(identity) != "colaborador":
        return None

    if not _table_exists(db, "colaboradores_instancias"):
        return None  # legado: não restringe

    cid = _get_colab_id(identity)
    if not cid:
        return []

    rows = db.execute(
        text(
            """
            SELECT instancia_id
            FROM colaboradores_instancias
            WHERE empresa_id = :emp
              AND colaborador_id = :cid
            """
        ),
        {"emp": int(empresa_id), "cid": int(cid)},
    ).fetchall()

    ids = [int(r[0]) for r in rows if r and r[0] is not None]
    return ids


def _assert_instancia_allowed(allowed: Optional[List[int]], instancia_id: Optional[int]) -> None:
    if instancia_id is None:
        return
    if allowed is None:
        return
    if int(instancia_id) not in set(int(x) for x in allowed):
        raise HTTPException(status_code=403, detail="Instância não permitida para este usuário")


def _assert_cliente_access_by_instancias(
    db: Session,
    *,
    empresa_id: int,
    cliente_id: int,
    allowed: Optional[List[int]],
) -> None:
    """
    Garante que colaborador só acesse cliente que tenha mensagens em instância permitida.
    Admin/allowed=None => libera.
    """
    if allowed is None:
        return
    if not allowed:
        raise HTTPException(status_code=404, detail="Cliente não encontrado")

    ok = (
        db.query(models.Mensagem.id)
        .filter(
            models.Mensagem.empresa_id == int(empresa_id),
            models.Mensagem.cliente_id == int(cliente_id),
            models.Mensagem.instancia_id.in_([int(x) for x in allowed]),
        )
        .first()
    )
    if not ok:
        raise HTTPException(status_code=404, detail="Cliente não encontrado")


# =========================================================
# Utils locais
# =========================================================
def _assert_mesma_empresa(empresa_do_token: int, empresa_da_query: int | None) -> int:
    if empresa_da_query is None:
        return int(empresa_do_token)
    if int(empresa_da_query) != int(empresa_do_token):
        raise HTTPException(status_code=403, detail="Empresa inválida para este recurso")
    return int(empresa_da_query)


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
    """
    Resolve a instância a partir de instancia_id (numérico) ou instance (slug/nome).
    Retorna (instancia_id_resolvido, instance_name_resolvido)
    """
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
                models.EmpresaInstancia.instance_name == instance,
            )
            .first()
        )
        if row:
            return int(row.id), row.instance_name
        return None, None

    return None, None


def _iso_utc(ts) -> str:
    try:
        if hasattr(ts, "tzinfo") and ts.tzinfo is None:
            return ts.replace(tzinfo=timezone.utc).isoformat(timespec="microseconds")
        if hasattr(ts, "isoformat"):
            return ts.isoformat(timespec="microseconds")
        return str(ts)
    except Exception:
        return str(ts)


# =========================================================
# AVATAR: nunca devolver pps.whatsapp.net pro front
# =========================================================
def _public_avatar_url(*, kind: str, conversation_id: int, raw_avatar_url: Optional[str]) -> Optional[str]:
    """
    kind: "cliente" | "grupo"
    Retorna SEMPRE um endpoint local /api/atendimento/avatar/{id}?kind=...
    (mesmo que o banco tenha https://pps.whatsapp.net/...)
    """
    if not conversation_id:
        return None

    raw = (raw_avatar_url or "").strip()
    if not raw:
        return None

    # já é endpoint nosso
    if raw.startswith("/api/atendimento/avatar/"):
        return raw

    # qualquer URL externa vira proxy local
    if raw.startswith("http://") or raw.startswith("https://"):
        return f"/api/atendimento/avatar/{int(conversation_id)}?kind={kind}"

    # fallback seguro
    return f"/api/atendimento/avatar/{int(conversation_id)}?kind={kind}"


# =========================================================
# REST: listar mensagens da conversa (cliente OU grupo)
# =========================================================
@router.get("/conversas/{cliente_id}/mensagens")
def listar_mensagens(
    cliente_id: int,
    empresa_id: int | None = Query(None, description="(Opcional) Empresa. Se omitido, usa a do token."),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    instancia_id: int | None = Query(None, description="(Opcional) Filtra mensagens por instância (id numérico)"),
    instance: str | None = Query(None, description="(Opcional) Filtra mensagens por instância (slug/nome)"),
    since_ts: datetime | None = Query(None, description="(Opcional) Cursor: traz apenas mensagens com timestamp > since_ts (ISO-8601)."),
    since_id: int | None = Query(None, description="(Opcional) Cursor numérico: traz apenas mensagens com id > since_id."),
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
):
    # permissão
    _ensure_perm(identity, "atendimento.ver")

    # empresa efetiva (valida com token)
    empresa_id_eff = _assert_mesma_empresa(int(identity["empresa_id"]), empresa_id)

    # ACL instâncias (se colaborador)
    allowed = _allowed_instancia_ids(db, identity, empresa_id_eff)

    # resolve instância (id e nome), se vier
    resolved_inst_id, resolved_inst_name = _resolve_instancia_id(
        db,
        empresa_id=empresa_id_eff,
        instancia_id=instancia_id,
        instance=instance,
    )

    # se o usuário pediu instância mas não existe
    if (instancia_id is not None or instance) and resolved_inst_id is None:
        raise HTTPException(status_code=404, detail="Instância não encontrada para a empresa.")

    # se existe ACL, garantir que a instância pedida é permitida
    _assert_instancia_allowed(allowed, resolved_inst_id)

    # ============================================
    # 1) tenta como CLIENTE
    # ============================================
    cli = (
        db.query(models.Cliente)
        .filter(
            models.Cliente.id == int(cliente_id),
            models.Cliente.empresa_id == int(empresa_id_eff),
        )
        .first()
    )

    if cli:
        _assert_cliente_access_by_instancias(db, empresa_id=empresa_id_eff, cliente_id=int(cliente_id), allowed=allowed)

        # filtros efetivos de instância:
        instancia_filters = []
        if resolved_inst_id is not None:
            instancia_filters.append(models.Mensagem.instancia_id == int(resolved_inst_id))
        else:
            if allowed is not None:
                if not allowed:
                    return {"conversa": None, "items": [], "mensagens": []}
                instancia_filters.append(models.Mensagem.instancia_id.in_([int(x) for x in allowed]))

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
                models.Mensagem.empresa_id == int(empresa_id_eff),
                models.Mensagem.cliente_id == int(cliente_id),
                models.Mensagem.apagada_usuario == False,  # noqa: E712
                *instancia_filters,
            )
        )

        # cursor
        if since_id is not None:
            q = q.filter(models.Mensagem.id > int(since_id))
        if since_ts is not None:
            q = q.filter(models.Mensagem.timestamp > since_ts)

        incremental = (since_ts is not None) or (since_id is not None)

        if incremental:
            q = q.order_by(models.Mensagem.timestamp.asc(), models.Mensagem.id.asc()).limit(limit)
        else:
            q = q.order_by(models.Mensagem.timestamp.desc(), models.Mensagem.id.desc()).offset(offset).limit(limit)

        rows = q.all()

        # normaliza saída
        items = []
        for r in rows:
            ts_iso = _iso_utc(r.timestamp) if r.timestamp is not None else None
            items.append(
                {
                    "id": int(r.id),
                    "msg_id": r.msg_id,
                    "conteudo": r.conteudo,
                    "tipo": r.tipo,
                    "ack": r.ack,
                    "timestamp": ts_iso,
                    "instancia_id": r.instancia_id,
                    "instance_name": r.instance_name,
                    "apagada_cliente": bool(r.apagada_cliente),
                    "apagada_usuario": bool(r.apagada_usuario),
                    "is_group": False,
                }
            )

        # ✅ meta da conversa (pra header no front) — avatar SEMPRE local
        conversa = {
            "id": int(cli.id),
            "is_group": False,
            "telefone": getattr(cli, "telefone", None),
            "telefone_fmt": _format_phone_br(getattr(cli, "telefone", None)),
            "nome": getattr(cli, "nome", None),
            "push_name": getattr(cli, "nome_whatsapp", None),
            "avatar_url": _public_avatar_url(
                kind="cliente",
                conversation_id=int(cli.id),
                raw_avatar_url=getattr(cli, "avatar_url", None),
            ),
        }

        return {"conversa": conversa, "items": items, "mensagens": items}

    # ============================================
    # 2) fallback: tenta como GRUPO
    # ============================================
    grp = (
        db.query(models.Grupo)
        .filter(
            models.Grupo.id == int(cliente_id),
            models.Grupo.empresa_id == int(empresa_id_eff),
        )
        .first()
    )
    if not grp:
        raise HTTPException(status_code=404, detail="Conversa não encontrada nessa empresa.")

    # filtros efetivos de instância (para mensagens_grupo)
    instancia_filters_g = []
    if resolved_inst_id is not None:
        instancia_filters_g.append(models.MensagemGrupo.instancia_id == int(resolved_inst_id))
    else:
        if allowed is not None:
            if not allowed:
                return {"conversa": None, "items": [], "mensagens": []}
            instancia_filters_g.append(models.MensagemGrupo.instancia_id.in_([int(x) for x in allowed]))

    qg = (
        db.query(
            models.MensagemGrupo.id,
            models.MensagemGrupo.msg_id,
            models.MensagemGrupo.conteudo,
            models.MensagemGrupo.tipo,
            models.MensagemGrupo.ack,
            models.MensagemGrupo.timestamp,  # epoch
            models.MensagemGrupo.instancia_id,
            models.EmpresaInstancia.instance_name.label("instance_name"),
            models.MensagemGrupo.author_jid,
            models.MensagemGrupo.from_me,
            models.MensagemGrupo.message_type,
        )
        .outerjoin(
            models.EmpresaInstancia,
            models.EmpresaInstancia.id == models.MensagemGrupo.instancia_id,
        )
        .filter(
            models.MensagemGrupo.empresa_id == int(empresa_id_eff),
            models.MensagemGrupo.grupo_id == int(grp.id),
            *instancia_filters_g,
        )
    )

    # cursor (since_id usa o id interno da tabela mensagens_grupo)
    if since_id is not None:
        qg = qg.filter(models.MensagemGrupo.id > int(since_id))

    if since_ts is not None:
        # since_ts vem datetime; mensagens_grupo.timestamp é epoch
        since_epoch = int(since_ts.replace(tzinfo=timezone.utc).timestamp())
        qg = qg.filter(models.MensagemGrupo.timestamp > since_epoch)

    incremental = (since_ts is not None) or (since_id is not None)

    if incremental:
        qg = qg.order_by(models.MensagemGrupo.id.asc()).limit(limit)
    else:
        qg = qg.order_by(models.MensagemGrupo.id.desc()).offset(offset).limit(limit)

    rows_g = qg.all()

    items_g = []
    for r in rows_g:
        try:
            ts_iso = datetime.fromtimestamp(int(r.timestamp or 0), tz=timezone.utc).isoformat(timespec="microseconds")
        except Exception:
            ts_iso = None

        items_g.append(
            {
                "id": int(r.id),
                "msg_id": r.msg_id,
                "conteudo": r.conteudo,
                "tipo": r.tipo,
                "ack": r.ack,
                "timestamp": ts_iso,
                "instancia_id": r.instancia_id,
                "instance_name": r.instance_name,
                "author_jid": r.author_jid,
                "from_me": bool(r.from_me),
                "message_type": r.message_type,
                "apagada_cliente": False,
                "apagada_usuario": False,
                "is_group": True,
                "grupo_id": int(grp.id),
            }
        )

    # ✅ meta da conversa (pra header no front) — avatar SEMPRE local
    conversa_g = {
        "id": int(grp.id),
        "is_group": True,
        "remote_jid": getattr(grp, "remote_jid", None),
        "nome": getattr(grp, "nome", None),
        "avatar_url": _public_avatar_url(
            kind="grupo",
            conversation_id=int(grp.id),
            raw_avatar_url=getattr(grp, "avatar_url", None),
        ),
    }

    return {"conversa": conversa_g, "items": items_g, "mensagens": items_g}


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
    empresa_id_eff = _assert_mesma_empresa(int(identity["empresa_id"]), empresa_id)
    return listar_mensagens(
        cliente_id=cliente_id,
        empresa_id=empresa_id_eff,
        limit=limit,
        offset=offset,
        instancia_id=instancia_id,
        instance=instance,
        since_ts=since_ts,
        since_id=since_id,
        db=db,
        identity=identity,
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
    empresa_id_eff = _assert_mesma_empresa(int(identity["empresa_id"]), empresa_id)

    perms = set(identity.get("permissoes") or [])
    is_admin = bool(identity.get("is_admin")) or _is_admin(identity)
    if not (is_admin or "atendimento.apagar_mensagens" in perms):
        raise HTTPException(status_code=403, detail="Sem permissão para apagar mensagens de atendimento")

    # ACL instâncias (se colaborador)
    allowed = _allowed_instancia_ids(db, identity, empresa_id_eff)

    # Se colaborador com ACL, só pode apagar msg de instância permitida.
    # (Se a tabela não existir => allowed=None => libera)
    if allowed is not None and not allowed:
        raise HTTPException(status_code=404, detail="Mensagem não encontrada")

    q = (
        db.query(models.Mensagem)
        .filter(
            models.Mensagem.empresa_id == int(empresa_id_eff),
            models.Mensagem.cliente_id == int(cliente_id),
            models.Mensagem.msg_id == str(msg_id),
        )
    )

    if allowed is not None:
        q = q.filter(models.Mensagem.instancia_id.in_([int(x) for x in allowed]))

    rows = q.all()
    if not rows:
        raise HTTPException(status_code=404, detail="Mensagem não encontrada")

    for m in rows:
        m.apagada_usuario = True
    db.commit()

    payload = {
        "type": "msg_deleted",
        "empresa_id": int(empresa_id_eff),
        "cliente_id": int(cliente_id),
        "msg_id": str(msg_id),
        "apagada_usuario": True,
    }
    try:
        await conexoes_ativas.send_message(f"emp:{int(empresa_id_eff)}", payload)
    except Exception as e:
        print("[ATENDIMENTO][DELETE_MSG][WS][ERRO]", e)

    return {"ok": True, "msg_id": msg_id, "count": len(rows)}