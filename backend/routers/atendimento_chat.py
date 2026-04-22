# backend/routers/atendimento_chat.py
from __future__ import annotations

from typing import Optional, Tuple
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from backend.database import get_db
from backend import models
from backend.routers.auth import get_current_identity
from backend.websocket_manager import conexoes_ativas
from backend.integrations.evolution.utils.phone_utils import (
    formatar_telefone_br as formatar_telefone_br_phone_utils,
    normalize_phone_for_db,
    normalize_phone_for_send,
)
from backend.security.atendimento_acl import (
    ensure_perm,
    assert_same_company,
    resolve_acl_context,
    assert_instancia_allowed,
    assert_cliente_access,
)

# =========================================================
# Router
# =========================================================
router = APIRouter(prefix="", tags=["Atendimento – Chat"])


# =========================================================
# Utils locais
# =========================================================
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


def _normalize_phone(numero: Optional[str]) -> Optional[str]:
    """
    Compat local: agora usa a normalização central do backend.
    Retorna o formato canônico de banco (sem 55, com 9 quando aplicável).
    """
    return normalize_phone_for_db(numero)


def _format_phone_br(numero: Optional[str]) -> str:
    """
    Formata o telefone no padrão BR a partir da normalização central.
    """
    if not numero:
        return "—"

    send_e164 = normalize_phone_for_send(numero)
    if not send_e164:
        return "—"

    formatted = formatar_telefone_br_phone_utils(send_e164)
    return formatted or "—"


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
    ensure_perm(identity, "atendimento.ver")

    empresa_id_eff = assert_same_company(identity, empresa_id)
    acl_ctx = resolve_acl_context(db, identity=identity, empresa_id=empresa_id_eff)
    allowed_instancias = acl_ctx["allowed_instancias"]

    resolved_inst_id, resolved_inst_name = _resolve_instancia_id(
        db,
        empresa_id=empresa_id_eff,
        instancia_id=instancia_id,
        instance=instance,
    )

    if (instancia_id is not None or instance) and resolved_inst_id is None:
        raise HTTPException(status_code=404, detail="Instância não encontrada para a empresa.")

    if resolved_inst_id is not None:
        assert_instancia_allowed(
            allowed_instancias=allowed_instancias,
            instancia_id=resolved_inst_id,
        )

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
        cliente_acl, atendimento_acl = assert_cliente_access(
            db,
            identity=identity,
            empresa_id=empresa_id_eff,
            cliente_id=int(cliente_id),
            instancia_id=resolved_inst_id,
            allow_unassigned_department=False,
        )

        instancia_filters = []
        if resolved_inst_id is not None:
            instancia_filters.append(models.Mensagem.instancia_id == int(resolved_inst_id))
        else:
            if allowed_instancias is not None:
                if not allowed_instancias:
                    return {"conversa": None, "items": [], "mensagens": []}
                instancia_filters.append(models.Mensagem.instancia_id.in_([int(x) for x in allowed_instancias]))

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

        telefone_br = _format_phone_br(getattr(cliente_acl, "telefone", None))
        telefone_norm = _normalize_phone(getattr(cliente_acl, "telefone", None))

        conversa = {
            "id": int(cliente_acl.id),
            "is_group": False,
            "telefone": getattr(cliente_acl, "telefone", None),
            "telefone_norm": telefone_norm,
            "telefone_fmt": telefone_br,
            "nome": getattr(cliente_acl, "nome", None),
            "push_name": getattr(cliente_acl, "nome_whatsapp", None),
            "avatar_url": _public_avatar_url(
                kind="cliente",
                conversation_id=int(cliente_acl.id),
                raw_avatar_url=getattr(cliente_acl, "avatar_url", None),
            ),
            "instancia_id": resolved_inst_id,
            "instance_name": resolved_inst_name,
            "atendimento_id": getattr(atendimento_acl, "id", None) if atendimento_acl else None,
            "departamento_id": (
                getattr(atendimento_acl, "departamento_id", None)
                if atendimento_acl is not None
                else getattr(cliente_acl, "departamento_id", None)
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

    instancia_filters_g = []
    if resolved_inst_id is not None:
        instancia_filters_g.append(models.MensagemGrupo.instancia_id == int(resolved_inst_id))
    else:
        if allowed_instancias is not None:
            if not allowed_instancias:
                return {"conversa": None, "items": [], "mensagens": []}
            instancia_filters_g.append(models.MensagemGrupo.instancia_id.in_([int(x) for x in allowed_instancias]))

    qg = (
        db.query(
            models.MensagemGrupo.id,
            models.MensagemGrupo.msg_id,
            models.MensagemGrupo.conteudo,
            models.MensagemGrupo.tipo,
            models.MensagemGrupo.ack,
            models.MensagemGrupo.timestamp,
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

    if since_id is not None:
        qg = qg.filter(models.MensagemGrupo.id > int(since_id))

    if since_ts is not None:
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
        "instancia_id": resolved_inst_id,
        "instance_name": resolved_inst_name,
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
    empresa_id_eff = assert_same_company(identity, empresa_id)
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
    empresa_id_eff = assert_same_company(identity, empresa_id)

    perms = set(identity.get("permissoes") or [])
    is_admin = bool(identity.get("is_admin")) or bool(identity.get("admin"))
    if not (is_admin or "atendimento.apagar_mensagens" in perms):
        raise HTTPException(status_code=403, detail="Sem permissão para apagar mensagens de atendimento")

    acl_ctx = resolve_acl_context(db, identity=identity, empresa_id=empresa_id_eff)
    allowed_instancias = acl_ctx["allowed_instancias"]

    # garante ACL de departamento + instância para conversa de cliente
    try:
        assert_cliente_access(
            db,
            identity=identity,
            empresa_id=empresa_id_eff,
            cliente_id=int(cliente_id),
            instancia_id=None,
            allow_unassigned_department=False,
        )
    except HTTPException:
        # se não for cliente 1:1, deixa seguir para tentativa de grupo por instância
        pass

    q = (
        db.query(models.Mensagem)
        .filter(
            models.Mensagem.empresa_id == int(empresa_id_eff),
            models.Mensagem.cliente_id == int(cliente_id),
            models.Mensagem.msg_id == str(msg_id),
        )
    )

    if allowed_instancias is not None:
        if not allowed_instancias:
            raise HTTPException(status_code=404, detail="Mensagem não encontrada")
        q = q.filter(models.Mensagem.instancia_id.in_([int(x) for x in allowed_instancias]))

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