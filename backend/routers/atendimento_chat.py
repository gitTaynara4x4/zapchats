# backend/routers/atendimento_chat.py
from __future__ import annotations

from typing import Optional, Tuple, Any, Dict, List
from datetime import datetime, timezone, date, time, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session
from sqlalchemy import text, literal

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
# Helpers gerais
# =========================================================
def _table_exists(db: Session, table_name: str) -> bool:
    try:
        reg = db.execute(text(f"SELECT to_regclass('public.{table_name}')")).scalar()
        return reg is not None
    except Exception:
        return False


def _participant_feature_enabled(db: Session) -> bool:
    return getattr(models, "AtendimentoParticipante", None) is not None and _table_exists(
        db, "atendimento_participantes"
    )


def _fila_feature_enabled(db: Session) -> bool:
    return (
        getattr(models, "FilaAtendimento", None) is not None
        and _table_exists(db, "filas_atendimento")
    )


def _to_int(v: Any) -> Optional[int]:
    try:
        if v is None:
            return None
        s = str(v).strip()
        if not s:
            return None
        return int(s)
    except Exception:
        return None


def _id_get(obj: Any, key: str, default: Any = None) -> Any:
    if obj is None:
        return default
    if isinstance(obj, dict):
        return obj.get(key, default)
    return getattr(obj, key, default)


def _get_colab_id(identity: Any) -> Optional[int]:
    for key in ("id_colab", "colaborador_id", "id_colaborador", "colab_id", "cid"):
        cid = _to_int(_id_get(identity, key))
        if cid:
            return cid

    sub = str(_id_get(identity, "sub") or "").strip().lower()
    if sub.startswith("colab-"):
        try:
            return int(sub.split("-", 1)[1])
        except Exception:
            return None

    return _to_int(_id_get(identity, "id"))


def _nome_colaborador(db: Session, colaborador_id: Optional[int]) -> Optional[str]:
    if colaborador_id is None:
        return None

    row = (
        db.query(models.Colaborador)
        .filter(models.Colaborador.id == int(colaborador_id))
        .first()
    )

    return row.nome if row else None


def _iso_utc(ts) -> Optional[str]:
    if ts is None:
        return None

    try:
        if hasattr(ts, "tzinfo") and ts.tzinfo is None:
            return ts.replace(tzinfo=timezone.utc).isoformat(timespec="microseconds")

        if hasattr(ts, "isoformat"):
            return ts.isoformat(timespec="microseconds")

        return str(ts)
    except Exception:
        return str(ts)


def _epoch_from_dt(dt: datetime) -> int:
    try:
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        else:
            dt = dt.astimezone(timezone.utc)

        return int(dt.timestamp())
    except Exception:
        return 0


def _day_bounds_utc(target_date: date) -> Tuple[datetime, datetime]:
    """
    Recebe uma data YYYY-MM-DD e gera o intervalo do dia em UTC.

    Observação:
    - Mensagens 1:1 usam timestamp datetime.
    - Mensagens de grupo usam timestamp epoch.
    """
    start_dt = datetime.combine(target_date, time.min).replace(tzinfo=timezone.utc)
    end_dt = start_dt + timedelta(days=1)
    return start_dt, end_dt


# =========================================================
# Conversation key helpers
# =========================================================
def _conv_ref_cliente(cliente_id: int, instancia_id: Optional[int]) -> str:
    return f"c:{int(cliente_id)}:{int(instancia_id or 0)}"


def _conv_ref_grupo(grupo_id: int, instancia_id: Optional[int]) -> str:
    return f"g:{int(grupo_id)}:{int(instancia_id or 0)}"


def _pick_effective_instancia_from_rows(
    *,
    resolved_inst_id: Optional[int],
    resolved_inst_name: Optional[str],
    rows: List[Any],
    fallback_inst_id: Optional[int] = None,
    fallback_inst_name: Optional[str] = None,
) -> Tuple[Optional[int], Optional[str]]:
    """
    Se a rota recebeu instancia_id/instance, usa ela.
    Se não recebeu, tenta inferir somente quando todas as mensagens retornadas
    pertencem à mesma instância. Se houver múltiplas, mantém None para gerar :0.
    """
    if resolved_inst_id is not None:
        return int(resolved_inst_id), resolved_inst_name

    inst_map: Dict[int, Optional[str]] = {}

    for r in rows or []:
        iid = _to_int(getattr(r, "instancia_id", None))
        if iid is None:
            continue

        if iid not in inst_map:
            inst_map[iid] = getattr(r, "instance_name", None)

    if len(inst_map) == 1:
        iid = next(iter(inst_map.keys()))
        return iid, inst_map.get(iid)

    if fallback_inst_id is not None:
        return int(fallback_inst_id), fallback_inst_name

    return None, None


def _conversation_payload_fields(
    *,
    kind: str,
    entity_id: int,
    instancia_id: Optional[int],
) -> Dict[str, Any]:
    if kind == "g":
        key = _conv_ref_grupo(int(entity_id), instancia_id)
        return {
            "conversation_key": key,
            "conversation_id": key,
            "kind": "g",
            "entity_id": int(entity_id),
            "grupo_id": int(entity_id),
        }

    key = _conv_ref_cliente(int(entity_id), instancia_id)
    return {
        "conversation_key": key,
        "conversation_id": key,
        "kind": "c",
        "entity_id": int(entity_id),
        "cliente_id": int(entity_id),
    }


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
    Resolve a instância a partir de instancia_id numérico ou instance slug/nome.
    Retorna (instancia_id_resolvido, instance_name_resolvido).
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
    Retorna o formato canônico de banco.
    """
    return normalize_phone_for_db(numero)


def _format_phone_br(numero: Optional[str]) -> str:
    """
    Formata telefone no padrão BR.
    """
    if not numero:
        return "—"

    send_e164 = normalize_phone_for_send(numero)
    if not send_e164:
        return "—"

    formatted = formatar_telefone_br_phone_utils(send_e164)
    return formatted or "—"


# =========================================================
# AVATAR: nunca devolver pps.whatsapp.net pro front
# =========================================================
def _public_avatar_url(*, kind: str, conversation_id: int, raw_avatar_url: Optional[str]) -> Optional[str]:
    """
    kind: "cliente" | "grupo"
    Retorna SEMPRE endpoint local /api/atendimento/avatar/{id}?kind=...
    """
    if not conversation_id:
        return None

    raw = (raw_avatar_url or "").strip()
    if not raw:
        return None

    if raw.startswith("/api/atendimento/avatar/"):
        return raw

    if raw.startswith("http://") or raw.startswith("https://"):
        return f"/api/atendimento/avatar/{int(conversation_id)}?kind={kind}"

    return f"/api/atendimento/avatar/{int(conversation_id)}?kind={kind}"


# =========================================================
# Fila / regra de aceite
# =========================================================
def _default_fila_state() -> Dict[str, Any]:
    return {
        "fila_id": None,
        "fila_nome": None,
        "fila_prioridade": None,
        "fila_sla_minutos": None,
        "fila_cor": None,
        "fila_ativa": False,
        "fila_exigir_aceite": False,
        "fila_escolhida_em": None,

        # aliases diretos para o front
        "exigir_aceite": False,
        "aceite_obrigatorio": False,
        "aguardando_aceite": False,

        # por enquanto só vamos marcar true quando a próxima etapa do chatbot/handler
        # detectar explicitamente que a conversa está aguardando escolha de fila.
        "aguardando_escolha_fila": False,
    }


def _fila_state_for_atendimento(
    db: Session,
    *,
    atendimento,
) -> Dict[str, Any]:
    """
    Regra nova:
    - Sem fila_id no atendimento => NÃO exige aceite.
    - Com fila_id => usa filas_atendimento.exigir_aceite.
    """
    state = _default_fila_state()

    if atendimento is None:
        return state

    fila_id = _to_int(getattr(atendimento, "fila_id", None))
    if fila_id is None:
        return state

    state["fila_id"] = int(fila_id)
    state["fila_escolhida_em"] = _iso_utc(getattr(atendimento, "fila_escolhida_em", None))

    if not _fila_feature_enabled(db):
        return state

    fila = (
        db.query(models.FilaAtendimento)
        .filter(
            models.FilaAtendimento.id == int(fila_id),
            models.FilaAtendimento.empresa_id == int(getattr(atendimento, "empresa_id")),
        )
        .first()
    )

    if not fila:
        return state

    exigir = bool(getattr(fila, "exigir_aceite", False))

    state.update(
        {
            "fila_id": int(fila.id),
            "fila_nome": getattr(fila, "nome", None),
            "fila_prioridade": getattr(fila, "prioridade", None),
            "fila_sla_minutos": getattr(fila, "sla_minutos", None),
            "fila_cor": getattr(fila, "cor", None),
            "fila_ativa": bool(getattr(fila, "ativa", False)),
            "fila_exigir_aceite": exigir,
            "exigir_aceite": exigir,
            "aceite_obrigatorio": exigir,
        }
    )

    return state


# =========================================================
# Participantes / aceite compartilhado
# =========================================================
def _active_participants_snapshot(
    db: Session,
    *,
    empresa_id: int,
    atendimento_id: Optional[int],
) -> List[Dict[str, Any]]:
    if atendimento_id is None:
        return []

    if not _participant_feature_enabled(db):
        return []

    AP = models.AtendimentoParticipante
    C = models.Colaborador

    aceito_col = (
        AP.aceito_em.label("aceito_em")
        if hasattr(AP, "aceito_em")
        else literal(None).label("aceito_em")
    )

    responsavel_col = (
        AP.is_responsavel.label("is_responsavel")
        if hasattr(AP, "is_responsavel")
        else literal(False).label("is_responsavel")
    )

    q = (
        db.query(
            AP.colaborador_id.label("colaborador_id"),
            C.nome.label("colaborador_nome"),
            aceito_col,
            responsavel_col,
        )
        .join(C, C.id == AP.colaborador_id)
        .filter(
            AP.empresa_id == int(empresa_id),
            AP.atendimento_id == int(atendimento_id),
        )
    )

    if hasattr(AP, "is_ativo"):
        q = q.filter(AP.is_ativo.is_(True))

    rows = q.all()
    out: List[Dict[str, Any]] = []

    for r in rows:
        out.append(
            {
                "colaborador_id": int(r.colaborador_id),
                "nome": r.colaborador_nome,
                "aceito_em": _iso_utc(r.aceito_em) if getattr(r, "aceito_em", None) is not None else None,
                "is_responsavel": bool(getattr(r, "is_responsavel", False)),
            }
        )

    out.sort(
        key=lambda x: (
            0 if x.get("is_responsavel") else 1,
            str(x.get("nome") or "").lower(),
            int(x.get("colaborador_id") or 0),
        )
    )

    return out


def _build_participacao_state(
    db: Session,
    *,
    atendimento,
    current_colab_id: Optional[int],
    is_group: bool = False,
    exigir_aceite: bool = False,
) -> Dict[str, Any]:
    """
    Regra importante:

    Antes:
      sem operador/participante => bloqueava e mostrava "Conversa aguardando aceite"

    Agora:
      só bloqueia/mostra aceite quando exigir_aceite=True.

    exigir_aceite=True vem da fila escolhida pelo cliente:
      atendimento.fila_id existe
      filas_atendimento.exigir_aceite=True
    """
    if is_group:
        return {
            "participantes": [],
            "participantes_ids": [],
            "aceita_por_mim": False,
            "tem_participantes": False,
            "responsavel_id": None,
            "responsavel_nome": None,
            "pode_aceitar": False,
            "pode_liberar": False,
            "pode_responder": True,
            "modo_aceite_compartilhado": False,
            "exigir_aceite": False,
            "aceite_obrigatorio": False,
            "aguardando_aceite": False,
        }

    # Sem atendimento e sem regra explícita de aceite:
    # deixa responder normal e não mostra banner de aceite.
    if atendimento is None:
        return {
            "participantes": [],
            "participantes_ids": [],
            "aceita_por_mim": False,
            "tem_participantes": False,
            "responsavel_id": None,
            "responsavel_nome": None,
            "pode_aceitar": bool(current_colab_id is not None and exigir_aceite),
            "pode_liberar": False,
            "pode_responder": True if not exigir_aceite else False,
            "modo_aceite_compartilhado": _participant_feature_enabled(db),
            "exigir_aceite": bool(exigir_aceite),
            "aceite_obrigatorio": bool(exigir_aceite),
            "aguardando_aceite": bool(exigir_aceite and current_colab_id is not None),
        }

    participants = _active_participants_snapshot(
        db,
        empresa_id=int(atendimento.empresa_id),
        atendimento_id=int(atendimento.id),
    )

    # fallback legado: se ainda não tiver tabela de participantes,
    # sintetiza com operador_id
    if not participants and getattr(atendimento, "operador_id", None) is not None:
        participants = [
            {
                "colaborador_id": int(atendimento.operador_id),
                "nome": _nome_colaborador(db, int(atendimento.operador_id)),
                "aceito_em": None,
                "is_responsavel": True,
            }
        ]

    participant_ids = [
        int(p["colaborador_id"])
        for p in participants
        if p.get("colaborador_id") is not None
    ]

    aceita_por_mim = (
        current_colab_id is not None
        and int(current_colab_id) in set(participant_ids)
    )

    responsavel = next((p for p in participants if p.get("is_responsavel")), None)

    if responsavel is None and participants:
        responsavel = participants[0]

    legacy_operator_id = _to_int(getattr(atendimento, "operador_id", None))

    if not exigir_aceite:
        # Ponto principal da correção:
        # se a conversa não veio de uma fila que exige aceite,
        # não trava composer e não mostra botão/banner de aceite.
        return {
            "participantes": participants,
            "participantes_ids": participant_ids,
            "aceita_por_mim": bool(aceita_por_mim),
            "tem_participantes": bool(participants),
            "responsavel_id": (
                int(responsavel["colaborador_id"])
                if responsavel and responsavel.get("colaborador_id") is not None
                else legacy_operator_id
            ),
            "responsavel_nome": (
                responsavel.get("nome")
                if responsavel
                else _nome_colaborador(db, legacy_operator_id)
            ),
            "pode_aceitar": False,
            "pode_liberar": False,
            "pode_responder": True,
            "modo_aceite_compartilhado": _participant_feature_enabled(db),
            "exigir_aceite": False,
            "aceite_obrigatorio": False,
            "aguardando_aceite": False,
        }

    # Daqui para baixo: fila exige aceite.
    if current_colab_id is None:
        pode_responder = True
    else:
        if participant_ids:
            pode_responder = aceita_por_mim
        else:
            if legacy_operator_id is not None:
                pode_responder = int(legacy_operator_id) == int(current_colab_id)
                aceita_por_mim = pode_responder
            else:
                pode_responder = False

    aguardando_aceite = bool(
        exigir_aceite
        and current_colab_id is not None
        and not bool(aceita_por_mim)
    )

    return {
        "participantes": participants,
        "participantes_ids": participant_ids,
        "aceita_por_mim": bool(aceita_por_mim),
        "tem_participantes": bool(participants),
        "responsavel_id": (
            int(responsavel["colaborador_id"])
            if responsavel and responsavel.get("colaborador_id") is not None
            else legacy_operator_id
        ),
        "responsavel_nome": (
            responsavel.get("nome")
            if responsavel
            else _nome_colaborador(db, legacy_operator_id)
        ),
        "pode_aceitar": current_colab_id is not None and not bool(aceita_por_mim),
        "pode_liberar": current_colab_id is not None and bool(aceita_por_mim),
        "pode_responder": bool(pode_responder),
        "modo_aceite_compartilhado": _participant_feature_enabled(db),
        "exigir_aceite": True,
        "aceite_obrigatorio": True,
        "aguardando_aceite": aguardando_aceite,
    }


# =========================================================
# REST: buscar mensagens por data
# =========================================================
@router.get("/conversas/{cliente_id}/mensagens/por-data")
def listar_mensagens_por_data(
    cliente_id: int,
    data: date = Query(..., description="Data no formato YYYY-MM-DD."),
    empresa_id: int | None = Query(None, description="(Opcional) Empresa. Se omitido, usa a do token."),
    limit: int = Query(200, ge=1, le=500),
    instancia_id: int | None = Query(None, description="(Opcional) Filtra mensagens por instância id numérico"),
    instance: str | None = Query(None, description="(Opcional) Filtra mensagens por instância slug/nome"),
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
):
    """
    Busca mensagens de uma conversa em uma data específica.

    Usado pelo front para o botão:
      "Ir para uma data"

    Retorna:
      - Cliente 1:1 quando cliente_id existir em clientes.
      - Grupo quando o mesmo id existir em grupos.
    """
    ensure_perm(identity, "atendimento.ver")

    empresa_id_eff = assert_same_company(identity, empresa_id)
    acl_ctx = resolve_acl_context(db, identity=identity, empresa_id=empresa_id_eff)
    allowed_instancias = acl_ctx["allowed_instancias"]
    current_colab_id = _get_colab_id(identity)

    start_dt, end_dt = _day_bounds_utc(data)
    start_epoch = _epoch_from_dt(start_dt)
    end_epoch = _epoch_from_dt(end_dt)

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
            allow_unassigned_department=True,
        )

        instancia_filters = []

        if resolved_inst_id is not None:
            instancia_filters.append(models.Mensagem.instancia_id == int(resolved_inst_id))
        else:
            if allowed_instancias is not None:
                if not allowed_instancias:
                    return {
                        "ok": True,
                        "found": False,
                        "target_date": data.isoformat(),
                        "conversa": None,
                        "items": [],
                        "mensagens": [],
                    }

                instancia_filters.append(
                    models.Mensagem.instancia_id.in_([int(x) for x in allowed_instancias])
                )

        q = (
            db.query(
                models.Mensagem.id,
                models.Mensagem.msg_id,
                models.Mensagem.conteudo,
                models.Mensagem.tipo,
                models.Mensagem.ack,
                models.Mensagem.timestamp,
                models.Mensagem.instancia_id,
                models.Mensagem.quoted,
                models.Mensagem.quoted_preview,
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
                models.Mensagem.timestamp >= start_dt,
                models.Mensagem.timestamp < end_dt,
                *instancia_filters,
            )
            .order_by(models.Mensagem.timestamp.asc(), models.Mensagem.id.asc())
            .limit(int(limit))
        )

        rows = q.all()

        effective_inst_id, effective_inst_name = _pick_effective_instancia_from_rows(
            resolved_inst_id=resolved_inst_id,
            resolved_inst_name=resolved_inst_name,
            rows=list(rows),
            fallback_inst_id=(
                _to_int(getattr(atendimento_acl, "instancia_id", None))
                if atendimento_acl is not None
                else _to_int(getattr(cliente_acl, "instancia_id", None))
            ),
            fallback_inst_name=resolved_inst_name,
        )

        conv_fields = _conversation_payload_fields(
            kind="c",
            entity_id=int(cliente_acl.id),
            instancia_id=effective_inst_id,
        )

        items = []

        for r in rows:
            ts_iso = _iso_utc(r.timestamp) if r.timestamp is not None else None
            row_conv_key = _conv_ref_cliente(int(cliente_acl.id), r.instancia_id or effective_inst_id)

            items.append(
                {
                    "id": int(r.id),
                    "db_id": int(r.id),
                    "mensagem_id": int(r.id),
                    "msg_id": r.msg_id,
                    "conteudo": r.conteudo,
                    "tipo": r.tipo,
                    "ack": r.ack,
                    "timestamp": ts_iso,
                    "instancia_id": r.instancia_id,
                    "instance_name": r.instance_name,
                    "quoted": r.quoted,
                    "quoted_preview": r.quoted_preview,
                    "apagada_cliente": bool(r.apagada_cliente),
                    "apagada_usuario": bool(r.apagada_usuario),
                    "is_group": False,
                    "conversation_key": row_conv_key,
                    "conversation_id": row_conv_key,
                    "kind": "c",
                    "entity_id": int(cliente_acl.id),
                    "cliente_id": int(cliente_acl.id),
                }
            )

        telefone_br = _format_phone_br(getattr(cliente_acl, "telefone", None))
        telefone_norm = _normalize_phone(getattr(cliente_acl, "telefone", None))

        operador_id = getattr(atendimento_acl, "operador_id", None) if atendimento_acl is not None else None
        operador_nome = _nome_colaborador(db, operador_id) if operador_id is not None else None
        status_atd = getattr(atendimento_acl, "status", None) if atendimento_acl is not None else None

        fila_state = _fila_state_for_atendimento(
            db,
            atendimento=atendimento_acl,
        )

        part_state = _build_participacao_state(
            db,
            atendimento=atendimento_acl,
            current_colab_id=current_colab_id,
            is_group=False,
            exigir_aceite=bool(fila_state.get("exigir_aceite")),
        )

        conversa = {
            "id": int(cliente_acl.id),
            **conv_fields,
            "is_group": False,
            "telefone": getattr(cliente_acl, "telefone", None),
            "telefone_norm": telefone_norm,
            "telefone_fmt": telefone_br,
            "nome": getattr(cliente_acl, "nome", None),
            "push_name": getattr(cliente_acl, "nome_whatsapp", None),
            "nome_whatsapp": getattr(cliente_acl, "nome_whatsapp", None),
            "avatar_url": _public_avatar_url(
                kind="cliente",
                conversation_id=int(cliente_acl.id),
                raw_avatar_url=getattr(cliente_acl, "avatar_url", None),
            ),
            "instancia_id": effective_inst_id,
            "instance_name": effective_inst_name,
            "atendimento_id": getattr(atendimento_acl, "id", None) if atendimento_acl else None,
            "departamento_id": (
                getattr(atendimento_acl, "departamento_id", None)
                if atendimento_acl is not None
                else getattr(cliente_acl, "departamento_id", None)
            ),
            "operador_id": operador_id,
            "operador_nome": operador_nome,
            "status": status_atd.value if hasattr(status_atd, "value") else status_atd,
            **fila_state,
            **part_state,
        }

        return {
            "ok": True,
            "found": bool(items),
            "target_date": data.isoformat(),
            "start_ts": _iso_utc(start_dt),
            "end_ts": _iso_utc(end_dt),
            "conversa": conversa,
            "items": items,
            "mensagens": items,
        }

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
                return {
                    "ok": True,
                    "found": False,
                    "target_date": data.isoformat(),
                    "conversa": None,
                    "items": [],
                    "mensagens": [],
                }

            instancia_filters_g.append(
                models.MensagemGrupo.instancia_id.in_([int(x) for x in allowed_instancias])
            )

    qg = (
        db.query(
            models.MensagemGrupo.id,
            models.MensagemGrupo.msg_id,
            models.MensagemGrupo.conteudo,
            models.MensagemGrupo.tipo,
            models.MensagemGrupo.ack,
            models.MensagemGrupo.timestamp,
            models.MensagemGrupo.instancia_id,
            models.MensagemGrupo.quoted,
            models.MensagemGrupo.quoted_preview,
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
            models.MensagemGrupo.timestamp >= int(start_epoch),
            models.MensagemGrupo.timestamp < int(end_epoch),
            *instancia_filters_g,
        )
        .order_by(models.MensagemGrupo.id.asc())
        .limit(int(limit))
    )

    rows_g = qg.all()

    effective_inst_id_g, effective_inst_name_g = _pick_effective_instancia_from_rows(
        resolved_inst_id=resolved_inst_id,
        resolved_inst_name=resolved_inst_name,
        rows=list(rows_g),
        fallback_inst_id=_to_int(getattr(grp, "instancia_id", None)),
        fallback_inst_name=resolved_inst_name,
    )

    conv_fields_g = _conversation_payload_fields(
        kind="g",
        entity_id=int(grp.id),
        instancia_id=effective_inst_id_g,
    )

    items_g = []

    for r in rows_g:
        try:
            ts_iso = datetime.fromtimestamp(int(r.timestamp or 0), tz=timezone.utc).isoformat(timespec="microseconds")
        except Exception:
            ts_iso = None

        row_conv_key = _conv_ref_grupo(int(grp.id), r.instancia_id or effective_inst_id_g)

        items_g.append(
            {
                "id": int(r.id),
                "db_id": int(r.id),
                "mensagem_id": int(r.id),
                "msg_id": r.msg_id,
                "conteudo": r.conteudo,
                "tipo": r.tipo,
                "ack": r.ack,
                "timestamp": ts_iso,
                "instancia_id": r.instancia_id,
                "instance_name": r.instance_name,
                "quoted": r.quoted,
                "quoted_preview": r.quoted_preview,
                "author_jid": r.author_jid,
                "from_me": bool(r.from_me),
                "message_type": r.message_type,
                "apagada_cliente": False,
                "apagada_usuario": False,
                "is_group": True,
                "grupo_id": int(grp.id),
                "conversation_key": row_conv_key,
                "conversation_id": row_conv_key,
                "kind": "g",
                "entity_id": int(grp.id),
            }
        )

    part_state_g = _build_participacao_state(
        db,
        atendimento=None,
        current_colab_id=current_colab_id,
        is_group=True,
        exigir_aceite=False,
    )

    conversa_g = {
        "id": int(grp.id),
        **conv_fields_g,
        "is_group": True,
        "remote_jid": getattr(grp, "remote_jid", None),
        "nome": getattr(grp, "nome", None),
        "avatar_url": _public_avatar_url(
            kind="grupo",
            conversation_id=int(grp.id),
            raw_avatar_url=getattr(grp, "avatar_url", None),
        ),
        "instancia_id": effective_inst_id_g,
        "instance_name": effective_inst_name_g,
        **_default_fila_state(),
        **part_state_g,
    }

    return {
        "ok": True,
        "found": bool(items_g),
        "target_date": data.isoformat(),
        "start_ts": _iso_utc(start_dt),
        "end_ts": _iso_utc(end_dt),
        "conversa": conversa_g,
        "items": items_g,
        "mensagens": items_g,
    }


# =========================================================
# REST: listar mensagens da conversa cliente OU grupo
# =========================================================
@router.get("/conversas/{cliente_id}/mensagens")
def listar_mensagens(
    cliente_id: int,
    empresa_id: int | None = Query(None, description="(Opcional) Empresa. Se omitido, usa a do token."),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    before_id: int | None = Query(None, ge=1, description="(Opcional) Cursor: mensagens mais antigas que este id."),
    instancia_id: int | None = Query(None, description="(Opcional) Filtra mensagens por instância id numérico"),
    instance: str | None = Query(None, description="(Opcional) Filtra mensagens por instância slug/nome"),
    since_ts: datetime | None = Query(None, description="(Opcional) Cursor: mensagens com timestamp > since_ts ISO."),
    since_id: int | None = Query(None, description="(Opcional) Cursor: mensagens com id > since_id."),
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
):
    ensure_perm(identity, "atendimento.ver")

    empresa_id_eff = assert_same_company(identity, empresa_id)
    acl_ctx = resolve_acl_context(db, identity=identity, empresa_id=empresa_id_eff)
    allowed_instancias = acl_ctx["allowed_instancias"]
    current_colab_id = _get_colab_id(identity)

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
            allow_unassigned_department=True,
        )

        instancia_filters = []

        if resolved_inst_id is not None:
            instancia_filters.append(models.Mensagem.instancia_id == int(resolved_inst_id))
        else:
            if allowed_instancias is not None:
                if not allowed_instancias:
                    return {"conversa": None, "items": [], "mensagens": []}

                instancia_filters.append(
                    models.Mensagem.instancia_id.in_([int(x) for x in allowed_instancias])
                )

        q = (
            db.query(
                models.Mensagem.id,
                models.Mensagem.msg_id,
                models.Mensagem.conteudo,
                models.Mensagem.tipo,
                models.Mensagem.ack,
                models.Mensagem.timestamp,
                models.Mensagem.instancia_id,
                models.Mensagem.quoted,
                models.Mensagem.quoted_preview,
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

        if before_id is not None and since_id is None and since_ts is None:
            q = q.filter(models.Mensagem.id < int(before_id))

        incremental = (since_ts is not None) or (since_id is not None)
        cursor_old = before_id is not None and not incremental

        if incremental:
            q = q.order_by(models.Mensagem.timestamp.asc(), models.Mensagem.id.asc()).limit(limit)
        elif cursor_old:
            q = q.order_by(models.Mensagem.id.desc()).limit(limit)
        else:
            q = q.order_by(models.Mensagem.timestamp.desc(), models.Mensagem.id.desc()).offset(offset).limit(limit)

        rows = q.all()

        effective_inst_id, effective_inst_name = _pick_effective_instancia_from_rows(
            resolved_inst_id=resolved_inst_id,
            resolved_inst_name=resolved_inst_name,
            rows=list(rows),
            fallback_inst_id=(
                _to_int(getattr(atendimento_acl, "instancia_id", None))
                if atendimento_acl is not None
                else _to_int(getattr(cliente_acl, "instancia_id", None))
            ),
            fallback_inst_name=resolved_inst_name,
        )

        conv_fields = _conversation_payload_fields(
            kind="c",
            entity_id=int(cliente_acl.id),
            instancia_id=effective_inst_id,
        )

        items = []

        for r in rows:
            ts_iso = _iso_utc(r.timestamp) if r.timestamp is not None else None
            row_conv_key = _conv_ref_cliente(int(cliente_acl.id), r.instancia_id or effective_inst_id)

            items.append(
                {
                    "id": int(r.id),
                    "db_id": int(r.id),
                    "mensagem_id": int(r.id),
                    "msg_id": r.msg_id,
                    "conteudo": r.conteudo,
                    "tipo": r.tipo,
                    "ack": r.ack,
                    "timestamp": ts_iso,
                    "instancia_id": r.instancia_id,
                    "instance_name": r.instance_name,
                    "quoted": r.quoted,
                    "quoted_preview": r.quoted_preview,
                    "apagada_cliente": bool(r.apagada_cliente),
                    "apagada_usuario": bool(r.apagada_usuario),
                    "is_group": False,
                    "conversation_key": row_conv_key,
                    "conversation_id": row_conv_key,
                    "kind": "c",
                    "entity_id": int(cliente_acl.id),
                    "cliente_id": int(cliente_acl.id),
                }
            )

        telefone_br = _format_phone_br(getattr(cliente_acl, "telefone", None))
        telefone_norm = _normalize_phone(getattr(cliente_acl, "telefone", None))

        operador_id = getattr(atendimento_acl, "operador_id", None) if atendimento_acl is not None else None
        operador_nome = _nome_colaborador(db, operador_id) if operador_id is not None else None
        status_atd = getattr(atendimento_acl, "status", None) if atendimento_acl is not None else None

        fila_state = _fila_state_for_atendimento(
            db,
            atendimento=atendimento_acl,
        )

        part_state = _build_participacao_state(
            db,
            atendimento=atendimento_acl,
            current_colab_id=current_colab_id,
            is_group=False,
            exigir_aceite=bool(fila_state.get("exigir_aceite")),
        )

        conversa = {
            "id": int(cliente_acl.id),
            **conv_fields,
            "is_group": False,
            "telefone": getattr(cliente_acl, "telefone", None),
            "telefone_norm": telefone_norm,
            "telefone_fmt": telefone_br,
            "nome": getattr(cliente_acl, "nome", None),
            "push_name": getattr(cliente_acl, "nome_whatsapp", None),
            "nome_whatsapp": getattr(cliente_acl, "nome_whatsapp", None),
            "avatar_url": _public_avatar_url(
                kind="cliente",
                conversation_id=int(cliente_acl.id),
                raw_avatar_url=getattr(cliente_acl, "avatar_url", None),
            ),
            "instancia_id": effective_inst_id,
            "instance_name": effective_inst_name,
            "atendimento_id": getattr(atendimento_acl, "id", None) if atendimento_acl else None,
            "departamento_id": (
                getattr(atendimento_acl, "departamento_id", None)
                if atendimento_acl is not None
                else getattr(cliente_acl, "departamento_id", None)
            ),
            "operador_id": operador_id,
            "operador_nome": operador_nome,
            "status": status_atd.value if hasattr(status_atd, "value") else status_atd,

            # primeiro estado de fila
            **fila_state,

            # depois estado de aceite calculado com base na fila
            **part_state,
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

            instancia_filters_g.append(
                models.MensagemGrupo.instancia_id.in_([int(x) for x in allowed_instancias])
            )

    qg = (
        db.query(
            models.MensagemGrupo.id,
            models.MensagemGrupo.msg_id,
            models.MensagemGrupo.conteudo,
            models.MensagemGrupo.tipo,
            models.MensagemGrupo.ack,
            models.MensagemGrupo.timestamp,
            models.MensagemGrupo.instancia_id,
            models.MensagemGrupo.quoted,
            models.MensagemGrupo.quoted_preview,
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
        since_epoch = _epoch_from_dt(since_ts)
        qg = qg.filter(models.MensagemGrupo.timestamp > since_epoch)

    if before_id is not None and since_id is None and since_ts is None:
        qg = qg.filter(models.MensagemGrupo.id < int(before_id))

    incremental = (since_ts is not None) or (since_id is not None)
    cursor_old = before_id is not None and not incremental

    if incremental:
        qg = qg.order_by(models.MensagemGrupo.id.asc()).limit(limit)
    elif cursor_old:
        qg = qg.order_by(models.MensagemGrupo.id.desc()).limit(limit)
    else:
        qg = qg.order_by(models.MensagemGrupo.id.desc()).offset(offset).limit(limit)

    rows_g = qg.all()

    effective_inst_id_g, effective_inst_name_g = _pick_effective_instancia_from_rows(
        resolved_inst_id=resolved_inst_id,
        resolved_inst_name=resolved_inst_name,
        rows=list(rows_g),
        fallback_inst_id=_to_int(getattr(grp, "instancia_id", None)),
        fallback_inst_name=resolved_inst_name,
    )

    conv_fields_g = _conversation_payload_fields(
        kind="g",
        entity_id=int(grp.id),
        instancia_id=effective_inst_id_g,
    )

    items_g = []

    for r in rows_g:
        try:
            ts_iso = datetime.fromtimestamp(int(r.timestamp or 0), tz=timezone.utc).isoformat(timespec="microseconds")
        except Exception:
            ts_iso = None

        row_conv_key = _conv_ref_grupo(int(grp.id), r.instancia_id or effective_inst_id_g)

        items_g.append(
            {
                "id": int(r.id),
                "db_id": int(r.id),
                "mensagem_id": int(r.id),
                "msg_id": r.msg_id,
                "conteudo": r.conteudo,
                "tipo": r.tipo,
                "ack": r.ack,
                "timestamp": ts_iso,
                "instancia_id": r.instancia_id,
                "instance_name": r.instance_name,
                "quoted": r.quoted,
                "quoted_preview": r.quoted_preview,
                "author_jid": r.author_jid,
                "from_me": bool(r.from_me),
                "message_type": r.message_type,
                "apagada_cliente": False,
                "apagada_usuario": False,
                "is_group": True,
                "grupo_id": int(grp.id),
                "conversation_key": row_conv_key,
                "conversation_id": row_conv_key,
                "kind": "g",
                "entity_id": int(grp.id),
            }
        )

    part_state_g = _build_participacao_state(
        db,
        atendimento=None,
        current_colab_id=current_colab_id,
        is_group=True,
        exigir_aceite=False,
    )

    conversa_g = {
        "id": int(grp.id),
        **conv_fields_g,
        "is_group": True,
        "remote_jid": getattr(grp, "remote_jid", None),
        "nome": getattr(grp, "nome", None),
        "avatar_url": _public_avatar_url(
            kind="grupo",
            conversation_id=int(grp.id),
            raw_avatar_url=getattr(grp, "avatar_url", None),
        ),
        "instancia_id": effective_inst_id_g,
        "instance_name": effective_inst_name_g,
        **_default_fila_state(),
        **part_state_g,
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
    before_id: int | None = Query(None, ge=1),
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
        before_id=before_id,
        instancia_id=instancia_id,
        instance=instance,
        since_ts=since_ts,
        since_id=since_id,
        db=db,
        identity=identity,
    )


# =========================================================
# DELETE de mensagem soft delete: marca apagada_usuario=True
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

    perms = set(_id_get(identity, "permissoes") or [])
    is_admin = bool(_id_get(identity, "is_admin")) or bool(_id_get(identity, "admin"))

    if not (is_admin or "atendimento.apagar_mensagens" in perms):
        raise HTTPException(status_code=403, detail="Sem permissão para apagar mensagens de atendimento")

    acl_ctx = resolve_acl_context(db, identity=identity, empresa_id=empresa_id_eff)
    allowed_instancias = acl_ctx["allowed_instancias"]

    try:
        assert_cliente_access(
            db,
            identity=identity,
            empresa_id=empresa_id_eff,
            cliente_id=int(cliente_id),
            instancia_id=None,
            allow_unassigned_department=True,
        )
    except HTTPException:
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

    first_inst_id = getattr(rows[0], "instancia_id", None) if rows else None
    conv_key = _conv_ref_cliente(int(cliente_id), first_inst_id)

    payload = {
        "type": "msg_deleted",
        "empresa_id": int(empresa_id_eff),
        "cliente_id": int(cliente_id),
        "conversation_id": conv_key,
        "conversation_key": conv_key,
        "kind": "c",
        "entity_id": int(cliente_id),
        "msg_id": str(msg_id),
        "apagada_usuario": True,
        "instancia_id": first_inst_id,
    }

    try:
        await conexoes_ativas.send_message(f"emp:{int(empresa_id_eff)}", payload)
    except Exception as e:
        print("[ATENDIMENTO][DELETE_MSG][WS][ERRO]", e)

    return {"ok": True, "msg_id": msg_id, "count": len(rows)}