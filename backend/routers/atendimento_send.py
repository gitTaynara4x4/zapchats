# backend/routers/atendimento_send.py
from __future__ import annotations

import os
import json
import mimetypes
import re
import time
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

import requests
from fastapi import APIRouter, Depends, HTTPException, Path, Body
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session
from sqlalchemy import text, or_

from backend.database import get_db
from backend import models
from backend.services.chatbot_claim_policy import (
    department_claim_required,
    department_chatbot_active_for_department,
)
from backend.websocket_manager import conexoes_ativas
from backend.routers.auth import get_current_identity

from backend.integrations.evolution.utils.phone_utils import (
    formatar_telefone_br,
    normalize_phone_for_db,
    normalize_phone_for_send,
)
from backend.integrations.evolution.repositories.clientes_repo import (
    upsert_cliente_repo,
    get_cliente_by_id,
)
from backend.integrations.evolution.repositories.atendimentos_repo import (
    get_or_open_atendimento_repo,
)
from backend.services.atendimento_claim_state import claim_if_available
from backend.security.atendimento_acl import (
    ensure_perm,
    assert_same_company,
    resolve_acl_context,
    assert_instancia_allowed,
    assert_cliente_access,
)

router = APIRouter(tags=["Atendimento – Envio"])

EVOLUTION_URL = os.getenv("EVOLUTION_URL", "").rstrip("/")
EVOLUTION_KEY = os.getenv("EVOLUTION_APIKEY") or os.getenv("EVOLUTION_KEY")
HEADERS = {"Content-Type": "application/json", "apikey": EVOLUTION_KEY} if EVOLUTION_KEY else {}

DEBUG_ATENDIMENTO_SEND = os.getenv("DEBUG_ATENDIMENTO_SEND", "1").strip().lower() in ("1", "true", "yes", "on")


def _dbg(*args):
    if DEBUG_ATENDIMENTO_SEND:
        try:
            print("[SEND_DEBUG]", *args)
        except Exception:
            pass


def _dbg_json(label: str, obj: Any):
    if DEBUG_ATENDIMENTO_SEND:
        try:
            print("[SEND_DEBUG]", label, json.dumps(obj, ensure_ascii=False, indent=2, default=str))
        except Exception:
            print("[SEND_DEBUG]", label, obj)


def _public_avatar_url(*, kind: str, conversation_id: int, raw_avatar_url: Optional[str]) -> Optional[str]:
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
# Helpers base
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


def _assert_empresa_resolvida(empresa_do_token: int, empresa_resolvida_id: int) -> None:
    if int(empresa_resolvida_id) != int(empresa_do_token):
        raise HTTPException(403, "Instância/empresa não pertence ao seu contexto")


def _id_get(obj: Any, key: str, default: Any = None) -> Any:
    if obj is None:
        return default
    if isinstance(obj, dict):
        return obj.get(key, default)
    return getattr(obj, key, default)


def _current_operador_id(identity: Any) -> Optional[int]:
    if identity is None:
        return None

    for key in ("id_colab", "colaborador_id", "id_colaborador", "colab_id", "cid"):
        cid = _to_int(_id_get(identity, key))
        if cid:
            return cid

    sub = str(_id_get(identity, "sub", "") or "").strip().lower()
    if sub.startswith("colab-"):
        return _to_int(sub.split("-", 1)[1])

    return None


def _is_admin_identity(identity: Any) -> bool:
    """Retorna True somente para o administrador real da empresa."""
    if identity is None:
        return False

    if bool(_id_get(identity, "is_admin")) or bool(_id_get(identity, "admin")):
        return True

    role = str(_id_get(identity, "role", "") or "").strip().lower()
    if role in {"admin", "administrador", "owner", "dono", "root"}:
        return True

    return False


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


def _status_norm(value: Any) -> str:
    return str(value or "").split(".")[-1].strip().lower()


def _is_department_claim_atendimento(
    db: Session,
    *,
    atendimento: Optional[models.Atendimento],
    cliente: Optional[models.Cliente] = None,
) -> bool:
    """Usa a mesma política da rota /meta e da configuração do chatbot."""
    return department_claim_required(
        db,
        atendimento=atendimento,
        cliente=cliente,
    )


def _atendimento_exige_aceite(
    db: Session,
    *,
    atendimento: Optional[models.Atendimento],
    cliente: Optional[models.Cliente] = None,
) -> bool:
    """
    Exige aceite quando:
    - atendimento tem fila e a fila exige aceite; ou
    - atendimento foi encaminhado pelo menu/chatbot para um departamento.

    Departamento normal no cadastro do cliente não bloqueia envio.
    """
    if atendimento is None:
        return False

    if _is_department_claim_atendimento(db, atendimento=atendimento, cliente=cliente):
        return True

    fila_id = _to_int(getattr(atendimento, "fila_id", None))
    if fila_id is None:
        return False

    empresa_id = _to_int(getattr(atendimento, "empresa_id", None))
    instancia_id = _to_int(getattr(atendimento, "instancia_id", None))
    departamento_id = _to_int(getattr(atendimento, "departamento_id", None))
    if (
        empresa_id is None
        or instancia_id is None
        or departamento_id is None
        or not department_chatbot_active_for_department(
            db,
            empresa_id=int(empresa_id),
            instancia_id=int(instancia_id),
            departamento_id=int(departamento_id),
        )
    ):
        return False

    if not _fila_feature_enabled(db):
        return False

    fila = (
        db.query(models.FilaAtendimento)
        .filter(
            models.FilaAtendimento.id == int(fila_id),
            models.FilaAtendimento.empresa_id == int(getattr(atendimento, "empresa_id")),
        )
        .first()
    )

    if not fila:
        return False

    return bool(getattr(fila, "exigir_aceite", False))


def normalizar_telefone(numero: str | None) -> str | None:
    """
    Compat legado deste router:
    agora devolve SEMPRE o formato canônico de envio (E164 com 55).
    """
    return normalize_phone_for_send(numero)


def _remote_to_num(remote_jid: str | None) -> str | None:
    if not remote_jid:
        return None
    user = str(remote_jid).split("@", 1)[0].split(":", 1)[0]
    return normalize_phone_for_db(user)


def _destino_e_numero_norm(raw: str | None) -> tuple[str | None, str | None, bool]:
    """
    Retorna:
      destino_evolution, numero_db_norm, is_group

    - 1:1 => destino sempre no formato de envio (55...)
        ou JID normalizado se vier @s.whatsapp.net
    - grupo => preserva JID de grupo
    """
    if not raw:
        return None, None, False

    s = str(raw).strip()
    if not s:
        return None, None, False

    s_lower = s.lower()

    if s_lower.endswith("@g.us"):
        return s, None, True

    if s_lower.endswith("@s.whatsapp.net"):
        base = s_lower.replace("@s.whatsapp.net", "")
        num_send = normalize_phone_for_send(base)
        num_db = normalize_phone_for_db(base)
        return (f"{num_send}@s.whatsapp.net" if num_send else s), num_db, False

    if "-" in s:
        left, right = s.split("-", 1)
        left_digits = re.sub(r"\D", "", left or "")
        right_digits = re.sub(r"\D", "", right or "")
        if left_digits and right_digits:
            return f"{left_digits}-{right_digits}@g.us", None, True
        digits = re.sub(r"\D", "", s)
        if digits:
            return f"{s}@g.us", None, True

    digits_only = re.sub(r"\D", "", s)
    if digits_only.startswith("120") and len(digits_only) >= 16:
        return f"{digits_only}@g.us", None, True
    if len(digits_only) >= 18:
        return f"{digits_only}@g.us", None, True

    num_send = normalize_phone_for_send(s)
    num_db = normalize_phone_for_db(s)
    if not num_send:
        return s, num_db, False

    return num_send, num_db, False


def _now_sp() -> datetime:
    return datetime.now(timezone.utc)


def _ensure_auth():
    if not EVOLUTION_KEY:
        raise HTTPException(500, "EVOLUTION_APIKEY/EVOLUTION_KEY não configurada no ambiente.")
    if not EVOLUTION_URL:
        raise HTTPException(500, "EVOLUTION_URL não configurada no ambiente.")


def _evo_post(path: str, instance: str, payload: Dict[str, Any], timeout: int = 30) -> Dict[str, Any]:
    _ensure_auth()
    url = f"{EVOLUTION_URL}{path}/{instance}"

    _dbg("EVOLUTION POST url=", url)
    _dbg_json("EVOLUTION payload=", payload)

    r = requests.post(url, headers=HEADERS, data=json.dumps(payload), timeout=timeout)

    _dbg("EVOLUTION status=", r.status_code)
    try:
        _dbg_json("EVOLUTION response=", r.json())
    except Exception:
        _dbg("EVOLUTION response(raw)=", (r.text or "")[:600])

    if r.status_code >= 400:
        try:
            j = r.json()
            raise HTTPException(
                r.status_code,
                {"error": "evolution_error", "status": r.status_code, "response": j},
            )
        except HTTPException:
            raise
        except Exception:
            raise HTTPException(r.status_code, f"Evolution error {r.status_code}: {r.text}")

    try:
        return r.json()
    except Exception:
        return {"raw": r.text}


def _resolve_empresa_e_instancia(
    db: Session,
    *,
    empresa_id: int,
    instance: Optional[str],
    instancia_id: Optional[int],
    allowed_inst_ids: Optional[List[int]],
) -> Tuple[models.Empresa, str, int]:
    emp = db.query(models.Empresa).filter(models.Empresa.id == int(empresa_id)).first()
    if not emp:
        raise HTTPException(404, f"Empresa id={empresa_id} não encontrada.")

    if instance:
        q = (
            db.query(models.EmpresaInstancia)
            .filter(
                models.EmpresaInstancia.empresa_id == int(empresa_id),
                models.EmpresaInstancia.instance_name == str(instance),
            )
        )
        row = q.first()
        if not row:
            raise HTTPException(404, f"Instância '{instance}' não encontrada.")
        assert_instancia_allowed(allowed_instancias=allowed_inst_ids, instancia_id=int(row.id))
        return emp, row.instance_name, int(row.id)

    if instancia_id is not None:
        q = (
            db.query(models.EmpresaInstancia)
            .filter(
                models.EmpresaInstancia.empresa_id == int(empresa_id),
                models.EmpresaInstancia.id == int(instancia_id),
            )
        )
        row = q.first()
        if not row:
            raise HTTPException(404, f"Instância id={instancia_id} não encontrada.")
        assert_instancia_allowed(allowed_instancias=allowed_inst_ids, instancia_id=int(row.id))
        return emp, row.instance_name, int(row.id)

    q = db.query(models.EmpresaInstancia).filter(models.EmpresaInstancia.empresa_id == int(empresa_id))
    if allowed_inst_ids is not None:
        if not allowed_inst_ids:
            raise HTTPException(403, "Nenhuma instância permitida para este usuário.")
        q = q.filter(models.EmpresaInstancia.id.in_([int(x) for x in allowed_inst_ids]))

    insts = q.order_by(models.EmpresaInstancia.id.asc()).all()
    if len(insts) == 1:
        row = insts[0]
        return emp, row.instance_name, int(row.id)

    opts = [{"id": int(r.id), "instance_name": r.instance_name} for r in insts]
    raise HTTPException(
        400,
        {
            "error": "empresa_tem_varias_instancias",
            "message": "Informe 'instance', 'instancia_id' ou envie o conversation_id/conversation_key completo da conversa.",
            "opcoes": opts,
        },
    )


# =========================================================
# Participantes / aceite compartilhado
# =========================================================
def _active_participant_rows(
    db: Session,
    *,
    empresa_id: int,
    atendimento_id: Optional[int],
):
    if atendimento_id is None:
        return []

    if not _participant_feature_enabled(db):
        return []

    AP = models.AtendimentoParticipante

    q = db.query(AP).filter(
        AP.empresa_id == int(empresa_id),
        AP.atendimento_id == int(atendimento_id),
    )

    if hasattr(AP, "is_ativo"):
        q = q.filter(AP.is_ativo.is_(True))

    if hasattr(AP, "id"):
        q = q.order_by(AP.id.asc())

    return q.all()


def _active_participant_ids(
    db: Session,
    *,
    empresa_id: int,
    atendimento_id: Optional[int],
) -> List[int]:
    rows = _active_participant_rows(
        db,
        empresa_id=empresa_id,
        atendimento_id=atendimento_id,
    )
    out: List[int] = []
    for r in rows:
        cid = _to_int(getattr(r, "colaborador_id", None))
        if cid and cid not in out:
            out.append(cid)
    return out


def _cliente_tem_historico(
    db: Session,
    *,
    empresa_id: int,
    cliente_id: int,
    instancia_id: Optional[int],
) -> bool:
    q = (
        db.query(models.Mensagem.id)
        .filter(
            models.Mensagem.empresa_id == int(empresa_id),
            models.Mensagem.cliente_id == int(cliente_id),
        )
    )

    if instancia_id is not None:
        q = q.filter(models.Mensagem.instancia_id == int(instancia_id))

    return q.first() is not None


def _ensure_sender_can_send_existing_cliente(
    db: Session,
    *,
    identity: Any,
    empresa_id: int,
    cliente_exists_before_send: bool,
    atendimento: Optional[models.Atendimento],
    cliente: Optional[models.Cliente] = None,
):
    """
    Regra corrigida:

    Antes:
      conversa existente + sem aceite => bloqueava envio sempre.

    Agora:
      conversa existente sem fila exigindo aceite => pode responder normal.

      só bloqueia quando:
        atendimento.fila_id existe
        e filas_atendimento.exigir_aceite = true
        e o colaborador atual ainda não aceitou/participa.
    """
    current_colab_id = _current_operador_id(identity)
    is_admin = _is_admin_identity(identity)

    # Identidade sem colaborador operacional passa (admin legado/master).
    if current_colab_id is None:
        return

    # Conversa nova outbound passa.
    if not cliente_exists_before_send:
        return

    # Sem atendimento aberto não tem regra explícita de aceite.
    if atendimento is None:
        return

    departamento_id = _to_int(getattr(atendimento, "departamento_id", None))
    operador_id = _to_int(getattr(atendimento, "operador_id", None))
    status_atd = _status_norm(getattr(atendimento, "status", None))

    # Administrador pode intervir em atendimento já assumido por outra pessoa,
    # sem trocar operador_id e sem "roubar" o atendimento do responsável atual.
    # Se ainda não existe responsável, o admin continua usando o fluxo normal de Atender.
    if is_admin and operador_id is not None:
        return

    exige_aceite = _atendimento_exige_aceite(db, atendimento=atendimento, cliente=cliente)
    if not exige_aceite:
        return

    participant_ids = _active_participant_ids(
        db,
        empresa_id=int(empresa_id),
        atendimento_id=getattr(atendimento, "id", None),
    )
    participating = int(current_colab_id) in set(int(x) for x in participant_ids)

    if departamento_id is not None and _is_department_claim_atendimento(
        db, atendimento=atendimento, cliente=cliente
    ):
        if participating:
            return

        if operador_id is None or status_atd in {"novo", "aguardando", "pendente"}:
            raise HTTPException(409, "Clique em Atender antes de responder.")

        raise HTTPException(
            409,
            "Clique em Participar para responder junto com o responsável atual.",
        )

    # Fila com aceite obrigatório: qualquer participante ativo pode responder.

    if participant_ids:
        if int(current_colab_id) not in set(int(x) for x in participant_ids):
            raise HTTPException(409, "Clique em Participar antes de responder.")
        return

    operador_id = _to_int(getattr(atendimento, "operador_id", None))
    if operador_id is not None:
        if int(operador_id) != int(current_colab_id):
            raise HTTPException(409, "Clique em Participar para responder junto com o responsável atual.")
        return

    raise HTTPException(409, "Aceite a conversa antes de responder.")


def _sync_sender_as_participant_if_needed(
    db: Session,
    *,
    atendimento: Optional[models.Atendimento],
    colaborador_id: Optional[int],
):
    """
    Normaliza o remetente como responsável somente quando o atendimento está
    livre ou já pertence a ele. Participantes secundários permanecem ativos e
    nunca tomam a responsabilidade principal de outro colaborador.
    """
    if atendimento is None or colaborador_id is None:
        return None

    if not _participant_feature_enabled(db):
        return None

    return claim_if_available(
        db,
        atendimento=atendimento,
        colaborador_id=int(colaborador_id),
    )


# =========================================================
# Conversation refs
# =========================================================
def _conv_ref_cliente(cliente_id: int, instancia_id: Optional[int]) -> str:
    return f"c:{int(cliente_id)}:{int(instancia_id or 0)}"


def _conv_ref_grupo(grupo_id: int, instancia_id: Optional[int]) -> str:
    return f"g:{int(grupo_id)}:{int(instancia_id or 0)}"


def _parse_conversation_ref(value: str | None) -> Tuple[Optional[str], Optional[int], Optional[int]]:
    raw = str(value or "").strip()
    if not raw:
        return None, None, None

    m = re.match(r"^(c|g):(\d+):(\d+)$", raw, flags=re.I)
    if not m:
        return None, None, None

    kind = "cliente" if m.group(1).lower() == "c" else "grupo"
    entity_id = int(m.group(2))
    inst_id = int(m.group(3)) or None
    return kind, entity_id, inst_id


def _raw_conversation_ref_from_body(body: Any) -> Optional[str]:
    raw = (
        getattr(body, "conversation_key", None)
        or getattr(body, "conversation_id", None)
        or None
    )
    if raw is None:
        return None
    raw = str(raw).strip()
    return raw or None


def _validate_ref_shape_if_present(raw: Optional[str], field_name: str) -> None:
    if not raw:
        return

    s = str(raw).strip()
    if re.match(r"^[cg]:", s, flags=re.I) and not re.match(r"^[cg]:\d+:\d+$", s, flags=re.I):
        raise HTTPException(
            400,
            {
                "error": "conversation_ref_invalida",
                "field": field_name,
                "message": f"{field_name} inválida. Use o formato c:<cliente_id>:<instancia_id> ou g:<grupo_id>:<instancia_id>.",
            },
        )


def _apply_conversation_hint(body) -> Tuple[Optional[str], Optional[int], Optional[int]]:
    """
    Trava crítica:
    - aceita conversation_key e conversation_id;
    - se vier c:123:39, força cliente_id=123 e instancia_id=39;
    - se vier payload contraditório, bloqueia;
    - se vier instance textual junto, valida depois de resolver a instância.
    """
    raw_key = str(getattr(body, "conversation_key", "") or "").strip()
    raw_id = str(getattr(body, "conversation_id", "") or "").strip()

    _validate_ref_shape_if_present(raw_key, "conversation_key")
    _validate_ref_shape_if_present(raw_id, "conversation_id")

    k_kind, k_entity_id, k_inst_id = _parse_conversation_ref(raw_key)
    i_kind, i_entity_id, i_inst_id = _parse_conversation_ref(raw_id)

    if k_kind and i_kind:
        if (k_kind, k_entity_id, k_inst_id) != (i_kind, i_entity_id, i_inst_id):
            raise HTTPException(
                400,
                {
                    "error": "conversation_ref_conflitante",
                    "message": "conversation_key e conversation_id apontam para conversas diferentes.",
                    "conversation_key": raw_key,
                    "conversation_id": raw_id,
                },
            )

    kind = k_kind or i_kind
    entity_id = k_entity_id if k_entity_id is not None else i_entity_id
    inst_id = k_inst_id if k_inst_id is not None else i_inst_id

    if kind and entity_id is not None:
        current_cliente_id = _to_int(getattr(body, "cliente_id", None))
        if current_cliente_id is not None and int(current_cliente_id) != int(entity_id):
            raise HTTPException(
                400,
                {
                    "error": "cliente_id_conflitante",
                    "message": "cliente_id não bate com a conversation_key/conversation_id enviada.",
                    "cliente_id": current_cliente_id,
                    "conversation_entity_id": entity_id,
                },
            )
        body.cliente_id = int(entity_id)

    if inst_id is not None:
        current_inst_id = _to_int(getattr(body, "instancia_id", None))
        if current_inst_id is not None and int(current_inst_id) != int(inst_id):
            raise HTTPException(
                400,
                {
                    "error": "instancia_id_conflitante",
                    "message": "instancia_id não bate com a conversation_key/conversation_id enviada.",
                    "instancia_id": current_inst_id,
                    "conversation_instancia_id": inst_id,
                },
            )

        # Se vier instance textual, não sobrescreve aqui.
        # Depois que resolvermos a instance para id, validamos contra inst_id.
        if not getattr(body, "instance", None):
            body.instancia_id = int(inst_id)

    return kind, entity_id, inst_id


def _assert_conversation_hint_matches_kind(
    *,
    explicit_kind: Optional[str],
    is_group_destino: bool,
) -> None:
    if not explicit_kind:
        return

    if explicit_kind == "cliente" and is_group_destino:
        raise HTTPException(
            400,
            {
                "error": "destino_conflitante",
                "message": "conversation_key é de cliente, mas o destino enviado é de grupo.",
            },
        )

    if explicit_kind == "grupo" and not is_group_destino:
        raise HTTPException(
            400,
            {
                "error": "destino_conflitante",
                "message": "conversation_key é de grupo, mas o destino enviado é de cliente.",
            },
        )


def _assert_hint_instancia_matches_resolved(
    *,
    explicit_inst_id: Optional[int],
    resolved_inst_id: Optional[int],
) -> None:
    if explicit_inst_id is None:
        return

    if resolved_inst_id is None or int(explicit_inst_id) != int(resolved_inst_id):
        raise HTTPException(
            400,
            {
                "error": "instancia_conflitante",
                "message": "A instância resolvida não bate com a instância da conversation_key/conversation_id.",
                "conversation_instancia_id": explicit_inst_id,
                "resolved_instancia_id": resolved_inst_id,
            },
        )


def _assert_number_matches_cliente(
    *,
    cliente: models.Cliente,
    numero_db_norm: Optional[str],
    destino: str,
) -> None:
    """
    Bloqueia envio para número diferente do cliente selecionado.

    Importante:
    - só valida cliente 1:1;
    - aceita telefone_norm, telefone formatado, ou normalização do número salvo.
    """
    if not cliente:
        return

    expected_candidates: List[str] = []

    for raw in (
        getattr(cliente, "telefone_norm", None),
        getattr(cliente, "telefone", None),
        getattr(cliente, "whatsapp", None),
        getattr(cliente, "numero", None),
    ):
        n = normalize_phone_for_db(raw)
        if n and n not in expected_candidates:
            expected_candidates.append(n)

    got = normalize_phone_for_db(numero_db_norm or destino)

    if not got:
        raise HTTPException(
            400,
            {
                "error": "destino_invalido",
                "message": "Não foi possível validar o número de destino do cliente.",
            },
        )

    if expected_candidates and got not in expected_candidates:
        raise HTTPException(
            400,
            {
                "error": "destino_nao_bate_com_cliente",
                "message": "O número enviado não pertence ao cliente selecionado.",
                "cliente_id": int(getattr(cliente, "id", 0) or 0),
                "numero_enviado": got,
                "numeros_do_cliente": expected_candidates,
            },
        )


def _assert_destino_matches_grupo(
    *,
    grupo: models.Grupo,
    destino: str,
) -> None:
    if not grupo:
        return

    expected = str(getattr(grupo, "remote_jid", "") or "").strip().lower()
    got = str(destino or "").strip().lower()

    if not expected or not got:
        raise HTTPException(
            400,
            {
                "error": "destino_grupo_invalido",
                "message": "Não foi possível validar o destino do grupo.",
            },
        )

    if expected != got:
        raise HTTPException(
            400,
            {
                "error": "destino_nao_bate_com_grupo",
                "message": "O JID enviado não pertence ao grupo selecionado.",
                "grupo_id": int(getattr(grupo, "id", 0) or 0),
                "remote_jid_grupo": expected,
                "destino_enviado": got,
            },
        )


def _resolve_unique_client_instance(
    db: Session,
    *,
    empresa_id: int,
    cliente_id: int,
    allowed_inst_ids: Optional[List[int]],
) -> Optional[int]:
    q = (
        db.query(models.Mensagem.instancia_id)
        .filter(
            models.Mensagem.empresa_id == int(empresa_id),
            models.Mensagem.cliente_id == int(cliente_id),
            models.Mensagem.instancia_id.isnot(None),
        )
        .distinct()
    )

    if allowed_inst_ids is not None:
        if not allowed_inst_ids:
            raise HTTPException(403, "Nenhuma instância permitida para este usuário.")
        q = q.filter(models.Mensagem.instancia_id.in_([int(x) for x in allowed_inst_ids]))

    insts = [int(r[0]) for r in q.all() if r and r[0] is not None]
    if not insts:
        return None
    if len(insts) == 1:
        return int(insts[0])

    raise HTTPException(
        400,
        "Cliente possui conversa em múltiplas instâncias. Envie 'instancia_id'/'instance' ou 'conversation_id'/'conversation_key'.",
    )


def _resolve_unique_group_instance(
    db: Session,
    *,
    empresa_id: int,
    grupo_id: int,
    allowed_inst_ids: Optional[List[int]],
) -> Optional[int]:
    q = (
        db.query(models.MensagemGrupo.instancia_id)
        .filter(
            models.MensagemGrupo.empresa_id == int(empresa_id),
            models.MensagemGrupo.grupo_id == int(grupo_id),
            models.MensagemGrupo.instancia_id.isnot(None),
        )
        .distinct()
    )

    if allowed_inst_ids is not None:
        if not allowed_inst_ids:
            raise HTTPException(403, "Nenhuma instância permitida para este usuário.")
        q = q.filter(models.MensagemGrupo.instancia_id.in_([int(x) for x in allowed_inst_ids]))

    insts = [int(r[0]) for r in q.all() if r and r[0] is not None]
    if not insts:
        return None
    if len(insts) == 1:
        return int(insts[0])

    raise HTTPException(
        400,
        "Grupo possui conversa em múltiplas instâncias. Envie 'instancia_id'/'instance' ou 'conversation_id'/'conversation_key'.",
    )


# =========================================================
# Persistência
# =========================================================
def _find_cliente_by_phone(
    db: Session,
    *,
    empresa_id: int,
    numero_db_norm: str,
) -> Optional[models.Cliente]:
    if not numero_db_norm:
        return None

    return (
        db.query(models.Cliente)
        .filter(
            models.Cliente.empresa_id == int(empresa_id),
            models.Cliente.telefone_norm == str(numero_db_norm),
        )
        .order_by(models.Cliente.id.desc())
        .first()
    )


def _get_or_create_cliente(
    db: Session,
    empresa: models.Empresa,
    numero_db_norm: str,
    instancia_id: Optional[int],
) -> models.Cliente:
    """
    Usa o mesmo upsert/lookup do fluxo inbound.
    """
    cli_id = upsert_cliente_repo(
        db,
        empresa_id=int(empresa.id),
        instancia_id=(int(instancia_id) if instancia_id is not None else None),
        telefone_raw=numero_db_norm,
        nome=formatar_telefone_br(normalize_phone_for_send(numero_db_norm) or numero_db_norm),
        nome_whatsapp=None,
        avatar_url=None,
    )
    if not cli_id:
        raise HTTPException(500, "Não foi possível resolver/criar o cliente para envio.")
    cli = get_cliente_by_id(db, cli_id)
    if not cli:
        raise HTTPException(500, "Cliente resolvido no envio não pôde ser recarregado.")
    return cli


def _get_latest_atendimento_cliente_inst(
    db: Session,
    *,
    empresa_id: int,
    cliente_id: int,
    instancia_id: Optional[int],
) -> Optional[models.Atendimento]:
    q = (
        db.query(models.Atendimento)
        .filter(
            models.Atendimento.empresa_id == int(empresa_id),
            models.Atendimento.cliente_id == int(cliente_id),
        )
    )
    if instancia_id is not None:
        q = q.filter(models.Atendimento.instancia_id == int(instancia_id))
    return q.order_by(models.Atendimento.id.desc()).first()


def _resolve_atendimento_for_send(
    db: Session,
    *,
    empresa_id: int,
    cliente: models.Cliente,
    instancia_id: Optional[int],
    operador_id: Optional[int],
    ts_dt: datetime,
    atendimento_acl: Optional[models.Atendimento] = None,
) -> Tuple[Optional[models.Atendimento], Optional[int], Optional[int]]:
    latest = atendimento_acl or _get_latest_atendimento_cliente_inst(
        db,
        empresa_id=int(empresa_id),
        cliente_id=int(cliente.id),
        instancia_id=(int(instancia_id) if instancia_id is not None else None),
    )

    departamento_id = None
    if latest is not None:
        departamento_id = getattr(latest, "departamento_id", None)

    if departamento_id is None:
        departamento_id = getattr(cliente, "departamento_id", None)

    if instancia_id is None:
        return latest, getattr(latest, "id", None) if latest else None, departamento_id

    try:
        atd = get_or_open_atendimento_repo(
            db,
            empresa_id=int(empresa_id),
            instancia_id=int(instancia_id),
            cliente_id=int(cliente.id),
            direcao="saida",
            ts_dt=ts_dt,
            departamento_id=departamento_id,
            operador_id=operador_id,
        )
        return atd, (getattr(atd, "id", None) if atd is not None else None), departamento_id
    except Exception:
        return latest, getattr(latest, "id", None) if latest else None, departamento_id


def _insert_msg_saida(
    db: Session,
    *,
    empresa: models.Empresa,
    cliente: models.Cliente,
    conteudo: str,
    msg_id: Optional[str],
    instancia_id: Optional[int],
    atendimento_id: Optional[int],
    colaborador_id: Optional[int] = None,
    ack: int = 0,
    quoted: Optional[Dict[str, Any]] = None,
    quoted_preview: Optional[Dict[str, Any]] = None,
) -> models.Mensagem:
    m = models.Mensagem(
        empresa_id=empresa.id,
        cliente_id=cliente.id,
        conteudo=conteudo,
        tipo="saida",
        lida=True,
        ack=int(ack),
        timestamp=_now_sp(),
        msg_id=msg_id,
        instancia_id=instancia_id,
        atendimento_id=atendimento_id,
        colaborador_id=colaborador_id,
        quoted=quoted,
        quoted_preview=quoted_preview,
    )
    db.add(m)
    db.commit()
    db.refresh(m)
    return m


def _ts_seconds_from_evo(evo: Dict[str, Any]) -> int:
    ts = (evo or {}).get("messageTimestamp")
    try:
        ts = int(ts)
        if ts > 0:
            return ts
    except Exception:
        pass
    return int(time.time())


def _ack_from_send_success() -> int:
    # A Evolution pode responder status=PENDING mesmo com HTTP 201.
    # Para o ZapsChat, HTTP 2xx + key.id significa: enviado para a Evolution.
    # Então o ACK inicial precisa ser 1 para não ficar preso no relógio.
    return 1


def _send_ok_envelope(
    *,
    evolution: Dict[str, Any],
    db_payload: Optional[Dict[str, Any]],
    instance_name: str,
    msg_id: Optional[str],
    ack: int,
    timestamp_iso: Optional[str],
    conversation_key: Optional[str],
    kind: Optional[str],
    entity_id: Optional[int],
    instancia_id: Optional[int],
    is_group: bool,
) -> Dict[str, Any]:
    """
    Resposta padronizada para o front.

    Motivo:
    - A Evolution frequentemente devolve status=PENDING no primeiro retorno,
      mesmo tendo aceitado a mensagem com HTTP 201 e key.id.
    - O front não deve usar esse PENDING da Evolution para manter relógio.
    - O ACK canônico do ZapsChat aqui é ack=1 quando o POST para a Evolution
      foi aceito e a mensagem foi salva/broadcastada.
    """
    final_ack = int(ack or 0)
    final_msg_id = str(msg_id or "").strip() or None

    out = {
        "ok": True,
        "sent": True,
        "pending": final_ack <= 0,
        "ack": final_ack,
        "status": "sent" if final_ack > 0 else "pending",
        "msg_id": final_msg_id,
        "message_id": final_msg_id,
        "wa_msg_id": final_msg_id,
        "timestamp": timestamp_iso,
        "conversation_id": conversation_key,
        "conversation_key": conversation_key,
        "kind": kind,
        "entity_id": entity_id,
        "instancia_id": instancia_id,
        "instance_name": instance_name,
        "is_group": bool(is_group),
        "evolution_status": (evolution or {}).get("status"),
        "evolution": evolution,
        "db": db_payload,
    }

    if db_payload is not None:
        db_payload.setdefault("ack", final_ack)
        db_payload.setdefault("pending", final_ack <= 0)
        db_payload.setdefault("status", "sent" if final_ack > 0 else "pending")
        db_payload.setdefault("msg_id", final_msg_id)
        db_payload.setdefault("message_id", final_msg_id)
        db_payload.setdefault("wa_msg_id", final_msg_id)
        db_payload.setdefault("timestamp", timestamp_iso)

    return out


def _get_or_create_grupo(
    db: Session,
    *,
    empresa: models.Empresa,
    remote_jid: str,
    instancia_id: Optional[int],
) -> models.Grupo:
    grp = (
        db.query(models.Grupo)
        .filter(models.Grupo.empresa_id == int(empresa.id), models.Grupo.remote_jid == str(remote_jid))
        .first()
    )
    if grp:
        try:
            if instancia_id is not None:
                grp.instancia_id = int(instancia_id)
            db.commit()
        except Exception:
            db.rollback()
        return grp

    grp = models.Grupo(
        empresa_id=int(empresa.id),
        remote_jid=str(remote_jid),
        nome=str(remote_jid),
        avatar_url=None,
        descricao=None if hasattr(models.Grupo, "descricao") else None,
        instancia_id=int(instancia_id) if instancia_id is not None else None,
    )
    db.add(grp)
    db.commit()
    db.refresh(grp)
    return grp


def _insert_msg_saida_grupo(
    db: Session,
    *,
    empresa: models.Empresa,
    grupo: models.Grupo,
    conteudo: str,
    msg_id: Optional[str],
    instancia_id: Optional[int],
    ts_seconds: int,
    ack: int,
    message_type: str = "conversation",
    quoted: Optional[Dict[str, Any]] = None,
    quoted_preview: Optional[Dict[str, Any]] = None,
) -> models.MensagemGrupo:
    m = models.MensagemGrupo(
        empresa_id=int(empresa.id),
        grupo_id=int(grupo.id),
        instancia_id=int(instancia_id) if instancia_id is not None else None,
        author_jid=None,
        from_me=True,
        conteudo=conteudo,
        tipo="saida",
        message_type=message_type,
        lida=True,
        timestamp=int(ts_seconds),
        msg_id=str(msg_id) if msg_id else f"local-{int(time.time() * 1000)}",
        ack=int(ack),
        quoted=quoted,
        quoted_preview=quoted_preview,
    )
    db.add(m)

    if instancia_id is not None:
        grupo.instancia_id = int(instancia_id)

    db.commit()
    db.refresh(m)
    return m


def _identity_ctx(identity: Any) -> Tuple[int, Optional[str]]:
    if identity is None:
        raise HTTPException(401, "Sessão inválida ou expirada.")

    empresa_id = _id_get(identity, "empresa_id", None)
    if not empresa_id:
        raise HTTPException(403, "Empresa inválida para este token")
    try:
        empresa_id = int(empresa_id)
    except Exception:
        raise HTTPException(403, "Empresa inválida para este token")

    atendente_nome = (
        _id_get(identity, "nome", None)
        or _id_get(identity, "nome_completo", None)
        or _id_get(identity, "name", None)
    )
    return empresa_id, atendente_nome


def _resolve_sender_display_name(
    db: Session,
    *,
    identity: Any,
    empresa_id: int,
    colaborador_id: Optional[int],
    fallback_nome: Optional[str] = None,
) -> Optional[str]:
    """Nome exibido em cima da bolha de saída.

    Para colaborador, busca no banco para não depender do JWT ter nome.
    Para admin/usuário sem colaborador, usa o nome/e-mail da sessão.
    """
    if colaborador_id is not None:
        try:
            row = (
                db.query(models.Colaborador.nome)
                .filter(
                    models.Colaborador.id == int(colaborador_id),
                    models.Colaborador.empresa_id == int(empresa_id),
                )
                .first()
            )
            if row and row[0]:
                txt = str(row[0]).strip()
                if txt:
                    return txt
        except Exception:
            pass

    for val in (
        fallback_nome,
        _id_get(identity, "nome", None),
        _id_get(identity, "nome_completo", None),
        _id_get(identity, "name", None),
        _id_get(identity, "email", None),
    ):
        txt = str(val or "").strip()
        if txt and txt.lower() not in {"null", "undefined", "nan"}:
            return txt

    return None


# =========================================================
# Broadcast
# =========================================================
async def _broadcast_msg_saida_cliente(
    *,
    empresa: models.Empresa,
    cliente: models.Cliente,
    conteudo: str,
    timestamp_iso: str,
    msg_id: str,
    instancia_id: Optional[int],
    instance_name: Optional[str],
    atendente_nome: Optional[str],
    colaborador_id: Optional[int],
    ack: int,
    atendimento_id: Optional[int],
    departamento_id: Optional[int],
    midias: Optional[List[Dict[str, Any]]] = None,
    quoted: Optional[Dict[str, Any]] = None,
    quoted_preview: Optional[Dict[str, Any]] = None,
):
    conv_ref = _conv_ref_cliente(int(cliente.id), instancia_id)

    payload = {
        "empresa_id": int(empresa.id),
        "cliente_id": int(cliente.id),
        "conversation_id": conv_ref,
        "conversation_key": conv_ref,
        "kind": "c",
        "entity_id": int(cliente.id),
        "is_group": False,
        "telefone": formatar_telefone_br(getattr(cliente, "telefone", None) or ""),
        "avatar_url": _public_avatar_url(
            kind="cliente",
            conversation_id=int(cliente.id),
            raw_avatar_url=getattr(cliente, "avatar_url", None),
        ),
        "push_name": getattr(cliente, "nome_whatsapp", None),
        "nome": getattr(cliente, "nome", None),
        "mensagem": conteudo,
        "tipo": "saida",
        "origem": "atendente",
        "timestamp": timestamp_iso,
        "msg_id": msg_id,
        "ack": int(ack),
        "instancia_id": instancia_id,
        "instance_name": instance_name,
        "atendente_nome": atendente_nome,
        "autor_nome": atendente_nome,
        "enviado_por_nome": atendente_nome,
        "colaborador_nome": atendente_nome,
        "colaborador_id": colaborador_id,
        "atendente_id": colaborador_id,
        "atendimento_id": atendimento_id,
        "departamento_id": departamento_id,
    }
    if midias:
        payload["midias"] = midias
    if quoted:
        payload["quoted"] = quoted
    if quoted_preview:
        payload["quoted_preview"] = quoted_preview

    await conexoes_ativas.send_message(f"emp:{empresa.id}", payload)


async def _broadcast_msg_saida_grupo(
    *,
    empresa: models.Empresa,
    grupo: models.Grupo,
    conteudo: str,
    timestamp_iso: str,
    msg_id: str,
    instancia_id: Optional[int],
    instance_name: Optional[str],
    atendente_nome: Optional[str],
    ack: int,
    midias: Optional[List[Dict[str, Any]]] = None,
    quoted: Optional[Dict[str, Any]] = None,
    quoted_preview: Optional[Dict[str, Any]] = None,
):
    conv_ref = _conv_ref_grupo(int(grupo.id), instancia_id)

    payload = {
        "empresa_id": int(empresa.id),
        "cliente_id": int(grupo.id),
        "grupo_id": int(grupo.id),
        "conversation_id": conv_ref,
        "conversation_key": conv_ref,
        "kind": "g",
        "entity_id": int(grupo.id),
        "is_group": True,
        "remote_jid": getattr(grupo, "remote_jid", None),
        "avatar_url": _public_avatar_url(
            kind="grupo",
            conversation_id=int(grupo.id),
            raw_avatar_url=getattr(grupo, "avatar_url", None),
        ),
        "nome": getattr(grupo, "nome", None),
        "mensagem": conteudo,
        "tipo": "saida",
        "origem": "atendente",
        "timestamp": timestamp_iso,
        "msg_id": msg_id,
        "ack": int(ack),
        "instancia_id": instancia_id,
        "instance_name": instance_name,
        "atendente_nome": atendente_nome,
    }
    if midias:
        payload["midias"] = midias
    if quoted:
        payload["quoted"] = quoted
    if quoted_preview:
        payload["quoted_preview"] = quoted_preview

    await conexoes_ativas.send_message(f"emp:{empresa.id}", payload)


# ========= Schemas =========
class QuoteKey(BaseModel):
    id: str
    remoteJid: Optional[str] = None
    fromMe: Optional[bool] = None
    participant: Optional[str] = None

    class Config:
        extra = "allow"


class Quoted(BaseModel):
    key: QuoteKey
    message: Optional[Dict[str, Any]] = None

    class Config:
        extra = "allow"


class QuotedPreview(BaseModel):
    msg_id: Optional[str] = None
    text: Optional[str] = None
    author: Optional[str] = None
    direction: Optional[str] = None

    class Config:
        extra = "allow"


class BaseSend(BaseModel):
    empresa_id: Optional[int] = Field(None, description="ID da empresa")
    instance: Optional[str] = Field(None, description="Nome da instância")
    instancia_id: Optional[int] = Field(None, description="ID da instância")
    cliente_id: Optional[int] = Field(None, description="ID base do cliente/grupo")
    conversation_id: Optional[str] = Field(None, description="conversation_id da lista lateral (ex.: c:123:3)")
    conversation_key: Optional[str] = Field(None, description="conversation_key canônica (ex.: c:123:3)")
    number: str = Field(..., description="Destino: telefone ou JID")


class SendTextReq(BaseSend):
    text: str
    delay: Optional[int] = None
    linkPreview: Optional[bool] = None
    mentionsEveryOne: Optional[bool] = None
    mentioned: Optional[List[str]] = None
    quoted: Optional[Quoted] = None
    quoted_preview: Optional[QuotedPreview] = None


class SendAudioReq(BaseSend):
    audio: str
    delay: Optional[int] = None
    linkPreview: Optional[bool] = None
    mentionsEveryOne: Optional[bool] = None
    mentioned: Optional[List[str]] = None
    quoted: Optional[Quoted] = None
    quoted_preview: Optional[QuotedPreview] = None


class SendMediaReq(BaseSend):
    media: str
    mediatype: str
    mimetype: Optional[str] = None
    caption: Optional[str] = None
    fileName: Optional[str] = None
    delay: Optional[int] = None
    linkPreview: Optional[bool] = None
    mentionsEveryOne: Optional[bool] = None
    mentioned: Optional[List[str]] = None
    quoted: Optional[Quoted] = None
    quoted_preview: Optional[QuotedPreview] = None


class SendStickerReq(BaseSend):
    sticker: str
    delay: Optional[int] = None
    linkPreview: Optional[bool] = None
    mentionsEveryOne: Optional[bool] = None
    mentioned: Optional[List[str]] = None
    quoted: Optional[Quoted] = None
    quoted_preview: Optional[QuotedPreview] = None


class ContactItem(BaseModel):
    fullName: Optional[str] = None
    wuid: Optional[str] = None
    phoneNumber: Optional[str] = None
    organization: Optional[str] = None
    email: Optional[str] = None
    url: Optional[str] = None


class SendContactReq(BaseSend):
    contact: List[ContactItem]


class ReactionKey(BaseModel):
    remoteJid: str
    fromMe: bool = True
    id: str


class SendReactionReq(BaseModel):
    empresa_id: Optional[int] = None
    instance: Optional[str] = None
    instancia_id: Optional[int] = None
    key: ReactionKey
    reaction: str


# =========================================================
# Quoted / responder mensagem
# =========================================================
def _model_dump_compat(obj: Any, **kwargs) -> Dict[str, Any]:
    if obj is None:
        return {}
    if isinstance(obj, dict):
        return dict(obj)
    if hasattr(obj, "model_dump"):
        return obj.model_dump(**kwargs)
    if hasattr(obj, "dict"):
        return obj.dict(**kwargs)
    return {}


def _clean_none_deep(value: Any) -> Any:
    if isinstance(value, dict):
        out: Dict[str, Any] = {}
        for k, v in value.items():
            cleaned = _clean_none_deep(v)
            if cleaned is not None:
                out[k] = cleaned
        return out
    if isinstance(value, list):
        out = []
        for v in value:
            cleaned = _clean_none_deep(v)
            if cleaned is not None:
                out.append(cleaned)
        return out
    return value


def _first_present(*values: Any) -> Any:
    for v in values:
        if v is None:
            continue
        if isinstance(v, str) and not v.strip():
            continue
        return v
    return None


def _truthy_bool(v: Any, fallback: bool = False) -> bool:
    if isinstance(v, bool):
        return v
    if isinstance(v, (int, float)):
        return bool(v)

    s = str(v or "").strip().lower()
    if s in {"1", "true", "sim", "s", "yes", "y", "saida", "out", "sent"}:
        return True
    if s in {"0", "false", "nao", "não", "n", "no", "entrada", "in", "received"}:
        return False
    return bool(fallback)


def _jid_from_cliente(cliente: Optional[models.Cliente]) -> Optional[str]:
    if not cliente:
        return None

    raw = getattr(cliente, "telefone", None) or getattr(cliente, "telefone_norm", None)
    num = normalize_phone_for_send(raw)
    if not num:
        return None
    return f"{num}@s.whatsapp.net"


def _media_label_to_human(txt: str) -> str:
    raw = str(txt or "").strip()
    low = raw.lower()

    media_labels = {
        "[imagem]": "Imagem",
        "[image]": "Imagem",
        "[mídia]": "Mídia",
        "[midia]": "Mídia",
        "[vídeo]": "Vídeo",
        "[video]": "Vídeo",
        "[áudio]": "Áudio",
        "[audio]": "Áudio",
        "[áudio/ptt]": "Áudio",
        "[audio/ptt]": "Áudio",
        "[documento]": "Documento",
        "[figurinha]": "Figurinha",
        "[sticker]": "Figurinha",
        "[contato]": "Contato",
        "[localização]": "Localização",
        "[localizacao]": "Localização",
    }

    return media_labels.get(low, raw)


def _message_dict_for_quote(conteudo: Optional[str], fallback: str = "[mensagem]") -> Dict[str, Any]:
    txt = str(conteudo or "").strip() or fallback
    txt = _media_label_to_human(txt)
    return {"conversation": txt}


def _sanitize_quote_message_for_whatsapp(message: Any) -> Dict[str, Any]:
    """
    Evita mandar para o WhatsApp quote como texto feio tipo '[imagem]'.
    O ideal futuramente é salvar o payload original imageMessage/audioMessage/etc.
    Por enquanto, normaliza para algo mais bonito no WhatsApp do cliente.
    """
    if not isinstance(message, dict) or not message:
        return {"conversation": "Mensagem"}

    out = dict(message)

    conv = out.get("conversation")
    if isinstance(conv, str):
        out["conversation"] = _media_label_to_human(conv) or "Mensagem"
        return out

    ext = out.get("extendedTextMessage")
    if isinstance(ext, dict):
        ext = dict(ext)
        txt = ext.get("text")
        if isinstance(txt, str):
            ext["text"] = _media_label_to_human(txt) or "Mensagem"
            out["extendedTextMessage"] = ext
        return out

    return out


def _find_quote_cliente_msg(
    db: Session,
    *,
    empresa_id: int,
    instancia_id: Optional[int],
    quote_id: str,
) -> Optional[models.Mensagem]:
    if not quote_id:
        return None

    q = db.query(models.Mensagem).filter(models.Mensagem.empresa_id == int(empresa_id))

    if instancia_id is not None:
        q = q.filter(models.Mensagem.instancia_id == int(instancia_id))

    conds = [models.Mensagem.msg_id == str(quote_id)]
    quote_db_id = _to_int(quote_id)
    if quote_db_id is not None:
        conds.append(models.Mensagem.id == int(quote_db_id))

    return (
        q.filter(conds[0] if len(conds) == 1 else or_(*conds))
        .order_by(models.Mensagem.id.desc())
        .first()
    )


def _find_quote_grupo_msg(
    db: Session,
    *,
    empresa_id: int,
    instancia_id: Optional[int],
    quote_id: str,
) -> Optional[models.MensagemGrupo]:
    if not quote_id:
        return None

    q = db.query(models.MensagemGrupo).filter(models.MensagemGrupo.empresa_id == int(empresa_id))

    if instancia_id is not None:
        q = q.filter(models.MensagemGrupo.instancia_id == int(instancia_id))

    conds = [models.MensagemGrupo.msg_id == str(quote_id)]
    quote_db_id = _to_int(quote_id)
    if quote_db_id is not None:
        conds.append(models.MensagemGrupo.id == int(quote_db_id))

    return (
        q.filter(conds[0] if len(conds) == 1 else or_(*conds))
        .order_by(models.MensagemGrupo.id.desc())
        .first()
    )


def _resolve_quoted_for_evolution(
    db: Session,
    *,
    empresa_id: int,
    instancia_id: Optional[int],
    raw_quoted: Any,
    is_group: bool,
    destino: str,
    numero_db_norm: Optional[str],
) -> Optional[Dict[str, Any]]:
    if not raw_quoted:
        return None

    quoted = _model_dump_compat(raw_quoted, exclude_none=True)
    if not isinstance(quoted, dict):
        return None

    key = quoted.get("key") or {}
    if not isinstance(key, dict):
        key = _model_dump_compat(key, exclude_none=True)

    quote_id = str(_first_present(
        key.get("id"),
        quoted.get("id"),
        quoted.get("msg_id"),
        quoted.get("message_id"),
        quoted.get("wa_msg_id"),
    ) or "").strip()

    if not quote_id:
        return None

    original_cliente = None
    original_grupo = None

    if is_group:
        original_grupo = _find_quote_grupo_msg(
            db,
            empresa_id=int(empresa_id),
            instancia_id=instancia_id,
            quote_id=quote_id,
        )
    else:
        original_cliente = _find_quote_cliente_msg(
            db,
            empresa_id=int(empresa_id),
            instancia_id=instancia_id,
            quote_id=quote_id,
        )

    real_id = quote_id
    remote_jid = _first_present(key.get("remoteJid"), quoted.get("remoteJid"))
    participant = _first_present(key.get("participant"), quoted.get("participant"))
    from_me_raw = _first_present(key.get("fromMe"), quoted.get("fromMe"))
    message = quoted.get("message")

    if original_cliente is not None:
        real_id = str(getattr(original_cliente, "msg_id", None) or quote_id)
        from_me_raw = _first_present(
            from_me_raw,
            str(getattr(original_cliente, "tipo", "")).lower() == "saida",
        )

        if not remote_jid:
            cli = (
                db.query(models.Cliente)
                .filter(models.Cliente.id == int(original_cliente.cliente_id))
                .first()
            )
            remote_jid = _jid_from_cliente(cli)

        if not isinstance(message, dict) or not message:
            message = _message_dict_for_quote(getattr(original_cliente, "conteudo", None))

    if original_grupo is not None:
        real_id = str(getattr(original_grupo, "msg_id", None) or quote_id)
        from_me_raw = _first_present(from_me_raw, getattr(original_grupo, "from_me", None))

        if not remote_jid:
            grp = (
                db.query(models.Grupo)
                .filter(models.Grupo.id == int(original_grupo.grupo_id))
                .first()
            )
            remote_jid = getattr(grp, "remote_jid", None) if grp else None

        if not participant:
            participant = getattr(original_grupo, "author_jid", None)

        if not isinstance(message, dict) or not message:
            message = _message_dict_for_quote(getattr(original_grupo, "conteudo", None))

    # Conversa privada: força remoteJid como o destino real da conversa
    # e remove participant. Isso evita o WhatsApp mostrar "Grupo" no quote.
    if not is_group:
        participant = None

        destino_str = str(destino or "").strip()
        if destino_str.endswith("@s.whatsapp.net"):
            remote_jid = destino_str
        elif numero_db_norm:
            num = normalize_phone_for_send(numero_db_norm)
            remote_jid = f"{num}@s.whatsapp.net" if num else remote_jid
        elif destino_str:
            num = normalize_phone_for_send(destino_str)
            remote_jid = f"{num}@s.whatsapp.net" if num else remote_jid

    if not remote_jid:
        if is_group and str(destino or "").endswith("@g.us"):
            remote_jid = destino
        elif str(destino or "").endswith("@s.whatsapp.net"):
            remote_jid = destino
        elif numero_db_norm:
            num = normalize_phone_for_send(numero_db_norm)
            remote_jid = f"{num}@s.whatsapp.net" if num else None

    if not remote_jid:
        return None

    if not isinstance(message, dict) or not message:
        message = _message_dict_for_quote(quoted.get("text") or quoted.get("conteudo") or "[mensagem]")

    message = _sanitize_quote_message_for_whatsapp(message)

    out_key: Dict[str, Any] = {
        "id": str(real_id),
        "remoteJid": str(remote_jid),
        "fromMe": _truthy_bool(from_me_raw, fallback=False),
    }

    # Só grupo deve levar participant.
    # Em conversa privada, participant faz o WhatsApp interpretar estranho e mostrar "Grupo".
    if is_group and participant:
        out_key["participant"] = str(participant)

    out = {
        "key": out_key,
        "message": message,
    }

    return _clean_none_deep(out)


def _quoted_preview_from_body_or_payload(
    body: Any,
    quoted_payload: Optional[Dict[str, Any]],
) -> Optional[Dict[str, Any]]:
    raw = getattr(body, "quoted_preview", None)
    preview = _model_dump_compat(raw, exclude_none=True) if raw else {}

    if preview:
        direction = str(preview.get("direction") or "").lower().strip()
        return _clean_none_deep({
            "msg_id": preview.get("msg_id")
                      or preview.get("id")
                      or ((quoted_payload or {}).get("key") or {}).get("id"),
            "text": preview.get("text")
                    or preview.get("conversation")
                    or "[mensagem]",
            "author": preview.get("author")
                      or ("Você" if direction == "out" else "Contato"),
            "direction": direction or "in",
        })

    if not quoted_payload:
        return None

    key = quoted_payload.get("key") or {}
    msg = quoted_payload.get("message") or {}

    text_preview = (
        msg.get("conversation")
        or (
            (msg.get("extendedTextMessage") or {}).get("text")
            if isinstance(msg.get("extendedTextMessage"), dict)
            else None
        )
        or (
            (msg.get("imageMessage") or {}).get("caption")
            if isinstance(msg.get("imageMessage"), dict)
            else None
        )
        or (
            (msg.get("videoMessage") or {}).get("caption")
            if isinstance(msg.get("videoMessage"), dict)
            else None
        )
        or "[mensagem]"
    )

    from_me = _truthy_bool(key.get("fromMe"), fallback=False)

    return _clean_none_deep({
        "msg_id": key.get("id"),
        "text": text_preview,
        "author": "Você" if from_me else "Contato",
        "direction": "out" if from_me else "in",
    })


# =========================================================
# Contexto de envio
# =========================================================
def _resolve_send_instance(
    db: Session,
    *,
    empresa_id: int,
    body,
    is_group: bool,
    allowed_inst_ids: Optional[List[int]],
) -> Tuple[str, int]:
    if getattr(body, "instance", None) or getattr(body, "instancia_id", None) is not None:
        _, inst_name, inst_id = _resolve_empresa_e_instancia(
            db,
            empresa_id=int(empresa_id),
            instance=getattr(body, "instance", None),
            instancia_id=getattr(body, "instancia_id", None),
            allowed_inst_ids=allowed_inst_ids,
        )
        return inst_name, inst_id

    base_id = getattr(body, "cliente_id", None)
    if base_id is not None:
        if is_group:
            guessed = _resolve_unique_group_instance(
                db,
                empresa_id=int(empresa_id),
                grupo_id=int(base_id),
                allowed_inst_ids=allowed_inst_ids,
            )
        else:
            guessed = _resolve_unique_client_instance(
                db,
                empresa_id=int(empresa_id),
                cliente_id=int(base_id),
                allowed_inst_ids=allowed_inst_ids,
            )

        if guessed is not None:
            _, inst_name, inst_id = _resolve_empresa_e_instancia(
                db,
                empresa_id=int(empresa_id),
                instance=None,
                instancia_id=int(guessed),
                allowed_inst_ids=allowed_inst_ids,
            )
            return inst_name, inst_id

    _, inst_name, inst_id = _resolve_empresa_e_instancia(
        db,
        empresa_id=int(empresa_id),
        instance=None,
        instancia_id=None,
        allowed_inst_ids=allowed_inst_ids,
    )
    return inst_name, inst_id


# =========================================================
# Rota core reutilizável
# =========================================================
async def _send_core(
    *,
    body,
    db: Session,
    identity,
    evo_path: str,
    evo_payload: Dict[str, Any],
    conteudo_persistido: str,
    group_message_type: str,
    midias: Optional[List[Dict[str, Any]]] = None,
):
    ensure_perm(identity, "atendimento.enviar")
    _dbg_json("SEND body(recebido)=", _model_dump_compat(body, exclude_none=True))

    destino, numero_db_norm, is_group = _destino_e_numero_norm(body.number)
    if not destino:
        raise HTTPException(400, "Número/JID inválido.")

    explicit_kind, explicit_entity_id, explicit_inst_id = _apply_conversation_hint(body)
    _assert_conversation_hint_matches_kind(
        explicit_kind=explicit_kind,
        is_group_destino=bool(is_group),
    )

    empresa_do_token, atendente_nome = _identity_ctx(identity)
    acl_ctx = resolve_acl_context(db, identity=identity, empresa_id=empresa_do_token)
    allowed = acl_ctx["allowed_instancias"]

    efetiva_empresa_id = assert_same_company(identity, body.empresa_id)

    inst_name, inst_id = _resolve_send_instance(
        db,
        empresa_id=int(efetiva_empresa_id),
        body=body,
        is_group=is_group,
        allowed_inst_ids=allowed,
    )

    empresa, _inst_name_checked, inst_id_checked = _resolve_empresa_e_instancia(
        db,
        empresa_id=efetiva_empresa_id,
        instance=inst_name,
        instancia_id=inst_id,
        allowed_inst_ids=allowed,
    )
    _assert_empresa_resolvida(empresa_do_token, empresa.id)

    _assert_hint_instancia_matches_resolved(
        explicit_inst_id=explicit_inst_id,
        resolved_inst_id=inst_id_checked,
    )

    quoted_payload = _resolve_quoted_for_evolution(
        db,
        empresa_id=int(empresa.id),
        instancia_id=int(inst_id_checked) if inst_id_checked is not None else None,
        raw_quoted=getattr(body, "quoted", None),
        is_group=bool(is_group),
        destino=str(destino),
        numero_db_norm=numero_db_norm,
    )

    evo_payload = dict(evo_payload or {})
    if quoted_payload:
        evo_payload["quoted"] = quoted_payload
    else:
        evo_payload.pop("quoted", None)

    quoted_preview_payload = _quoted_preview_from_body_or_payload(body, quoted_payload)

    operador_id = _current_operador_id(identity)
    atendente_nome = _resolve_sender_display_name(
        db,
        identity=identity,
        empresa_id=int(empresa.id),
        colaborador_id=operador_id,
        fallback_nome=atendente_nome,
    )

    cliente_acl = None
    atendimento_acl = None

    if not is_group and body.cliente_id is not None:
        cliente_acl, atendimento_acl = assert_cliente_access(
            db,
            identity=identity,
            empresa_id=int(empresa.id),
            cliente_id=int(body.cliente_id),
            instancia_id=int(inst_id_checked),
            allow_unassigned_department=False,
            allow_unowned_if_no_history=True,
        )

        _assert_number_matches_cliente(
            cliente=cliente_acl,
            numero_db_norm=numero_db_norm,
            destino=str(destino),
        )

    cliente_existing_by_number = None
    if not is_group and body.cliente_id is None and numero_db_norm:
        cliente_existing_by_number = _find_cliente_by_phone(
            db,
            empresa_id=int(empresa.id),
            numero_db_norm=str(numero_db_norm),
        )
        if cliente_existing_by_number is not None:
            cliente_acl, atendimento_acl = assert_cliente_access(
                db,
                identity=identity,
                empresa_id=int(empresa.id),
                cliente_id=int(cliente_existing_by_number.id),
                instancia_id=int(inst_id_checked),
                allow_unassigned_department=False,
            allow_unowned_if_no_history=True,
            )

    cliente_para_regra = cliente_acl or cliente_existing_by_number
    cliente_exists_before_send = False
    if not is_group and cliente_para_regra is not None:
        cliente_exists_before_send = _cliente_tem_historico(
            db,
            empresa_id=int(empresa.id),
            cliente_id=int(cliente_para_regra.id),
            instancia_id=int(inst_id_checked) if inst_id_checked is not None else None,
        )

    if not is_group:
        _ensure_sender_can_send_existing_cliente(
            db,
            identity=identity,
            empresa_id=int(empresa.id),
            cliente_exists_before_send=bool(cliente_exists_before_send),
            atendimento=atendimento_acl,
            cliente=cliente_para_regra,
        )

    evo = _evo_post(evo_path, inst_name, evo_payload)
    evo_msg_id = ((evo or {}).get("key") or {}).get("id")
    ack_now = _ack_from_send_success()

    if is_group:
        grp = None

        if body.cliente_id is not None:
            grp = (
                db.query(models.Grupo)
                .filter(models.Grupo.empresa_id == int(empresa.id), models.Grupo.id == int(body.cliente_id))
                .first()
            )

            if not grp:
                raise HTTPException(
                    404,
                    {
                        "error": "grupo_nao_encontrado",
                        "message": "Grupo da conversation_key/conversation_id não encontrado.",
                        "grupo_id": body.cliente_id,
                    },
                )

            _assert_destino_matches_grupo(grupo=grp, destino=str(destino))

            if getattr(grp, "instancia_id", None) is not None and inst_id_checked is not None:
                if int(getattr(grp, "instancia_id")) != int(inst_id_checked):
                    raise HTTPException(
                        400,
                        {
                            "error": "grupo_instancia_conflitante",
                            "message": "A instância resolvida não bate com a instância cadastrada do grupo.",
                            "grupo_id": int(grp.id),
                            "grupo_instancia_id": int(getattr(grp, "instancia_id")),
                            "resolved_instancia_id": int(inst_id_checked),
                        },
                    )

        if not grp:
            grp = _get_or_create_grupo(db, empresa=empresa, remote_jid=destino, instancia_id=inst_id_checked)

        ts = _ts_seconds_from_evo(evo)
        ts_iso = datetime.fromtimestamp(ts, tz=timezone.utc).isoformat(timespec="microseconds")

        msg_g = _insert_msg_saida_grupo(
            db,
            empresa=empresa,
            grupo=grp,
            conteudo=conteudo_persistido,
            msg_id=evo_msg_id,
            instancia_id=inst_id_checked,
            ts_seconds=ts,
            ack=ack_now,
            message_type=group_message_type,
            quoted=quoted_payload,
            quoted_preview=quoted_preview_payload,
        )

        conv_ref = _conv_ref_grupo(int(grp.id), inst_id_checked)

        await _broadcast_msg_saida_grupo(
            empresa=empresa,
            grupo=grp,
            conteudo=conteudo_persistido,
            timestamp_iso=ts_iso,
            msg_id=evo_msg_id or str(getattr(msg_g, "id", "")),
            instancia_id=inst_id_checked,
            instance_name=inst_name,
            atendente_nome=atendente_nome,
            ack=ack_now,
            midias=midias,
            quoted=quoted_payload,
            quoted_preview=quoted_preview_payload,
        )

        msg_id_final = evo_msg_id or str(getattr(msg_g, "msg_id", None) or getattr(msg_g, "id", "") or "")

        db_payload = {
            "mensagem_grupo_id": getattr(msg_g, "id", None),
            "grupo_id": getattr(grp, "id", None),
            "conversation_id": conv_ref,
            "conversation_key": conv_ref,
            "kind": "g",
            "entity_id": int(getattr(grp, "id", 0) or 0),
            "instancia_id": inst_id_checked,
            "msg_id": msg_id_final,
            "message_id": msg_id_final,
            "wa_msg_id": msg_id_final,
            "ack": ack_now,
            "pending": False,
            "status": "sent",
            "timestamp": ts_iso,
            "quoted": quoted_payload,
            "quoted_preview": quoted_preview_payload,
        }

        return _send_ok_envelope(
            evolution=evo,
            db_payload=db_payload,
            instance_name=inst_name,
            msg_id=msg_id_final,
            ack=ack_now,
            timestamp_iso=ts_iso,
            conversation_key=conv_ref,
            kind="g",
            entity_id=int(getattr(grp, "id", 0) or 0),
            instancia_id=inst_id_checked,
            is_group=True,
        )

    cliente = cliente_acl
    if not cliente and cliente_existing_by_number is not None:
        cliente = cliente_existing_by_number

    if not cliente and numero_db_norm:
        cliente = _get_or_create_cliente(db, empresa, numero_db_norm, inst_id_checked)

    if not cliente:
        msg_id_final = str(evo_msg_id or "").strip() or None
        return _send_ok_envelope(
            evolution=evo,
            db_payload=None,
            instance_name=inst_name,
            msg_id=msg_id_final,
            ack=ack_now,
            timestamp_iso=datetime.fromtimestamp(_ts_seconds_from_evo(evo), tz=timezone.utc).isoformat(timespec="microseconds"),
            conversation_key=None,
            kind="c",
            entity_id=None,
            instancia_id=inst_id_checked,
            is_group=False,
        )

    # Se veio conversation_key/conversation_id de cliente, o cliente final precisa ser o mesmo.
    if explicit_kind == "cliente" and explicit_entity_id is not None:
        if int(cliente.id) != int(explicit_entity_id):
            raise HTTPException(
                400,
                {
                    "error": "cliente_resolvido_conflitante",
                    "message": "O cliente resolvido pelo envio não bate com a conversation_key/conversation_id.",
                    "conversation_cliente_id": explicit_entity_id,
                    "resolved_cliente_id": int(cliente.id),
                },
            )

    _assert_number_matches_cliente(
        cliente=cliente,
        numero_db_norm=numero_db_norm,
        destino=str(destino),
    )

    responsavel_antes_do_envio = (
        _to_int(getattr(atendimento_acl, "operador_id", None))
        if atendimento_acl is not None
        else None
    )
    admin_intervencao_preexistente = bool(
        _is_admin_identity(identity)
        and responsavel_antes_do_envio is not None
        and operador_id is not None
        and int(responsavel_antes_do_envio) != int(operador_id)
    )

    atd_obj, atendimento_id, departamento_id = _resolve_atendimento_for_send(
        db,
        empresa_id=int(empresa.id),
        cliente=cliente,
        instancia_id=inst_id_checked,
        operador_id=(None if admin_intervencao_preexistente else operador_id),
        ts_dt=_now_sp(),
        atendimento_acl=atendimento_acl,
    )

    # Antes isso sempre criava/sincronizava participante ao enviar.
    # Agora só faz isso se a conversa realmente exigir aceite.
    # Assim uma conversa normal não vira "aceita" artificialmente.
    responsavel_atual_id = _to_int(getattr(atd_obj, "operador_id", None)) if atd_obj is not None else None
    admin_intervindo = bool(
        _is_admin_identity(identity)
        and responsavel_atual_id is not None
        and operador_id is not None
        and int(responsavel_atual_id) != int(operador_id)
    )

    if (
        _atendimento_exige_aceite(db, atendimento=atd_obj, cliente=cliente)
        and not admin_intervindo
    ):
        _sync_sender_as_participant_if_needed(
            db,
            atendimento=atd_obj,
            colaborador_id=operador_id,
        )

    msg = _insert_msg_saida(
        db,
        empresa=empresa,
        cliente=cliente,
        conteudo=conteudo_persistido,
        msg_id=evo_msg_id,
        instancia_id=inst_id_checked,
        atendimento_id=atendimento_id,
        colaborador_id=operador_id,
        ack=ack_now,
        quoted=quoted_payload,
        quoted_preview=quoted_preview_payload,
    )

    conv_ref = _conv_ref_cliente(int(cliente.id), msg.instancia_id)

    await _broadcast_msg_saida_cliente(
        empresa=empresa,
        cliente=cliente,
        conteudo=msg.conteudo,
        timestamp_iso=msg.timestamp.isoformat(timespec="microseconds"),
        msg_id=msg.msg_id or str(msg.id),
        instancia_id=msg.instancia_id,
        instance_name=inst_name,
        atendente_nome=atendente_nome,
        colaborador_id=operador_id,
        ack=ack_now,
        atendimento_id=atendimento_id,
        departamento_id=departamento_id,
        midias=midias,
        quoted=quoted_payload,
        quoted_preview=quoted_preview_payload,
    )

    msg_id_final = msg.msg_id or evo_msg_id or str(msg.id)
    timestamp_iso = msg.timestamp.isoformat(timespec="microseconds")

    db_payload = {
        "mensagem_id": msg.id,
        "cliente_id": cliente.id,
        "atendimento_id": atendimento_id,
        "departamento_id": departamento_id,
        "colaborador_id": operador_id,
        "atendente_id": operador_id,
        "colaborador_nome": atendente_nome,
        "atendente_nome": atendente_nome,
        "autor_nome": atendente_nome,
        "enviado_por_nome": atendente_nome,
        "conversation_id": conv_ref,
        "conversation_key": conv_ref,
        "kind": "c",
        "entity_id": int(cliente.id),
        "instancia_id": inst_id_checked,
        "msg_id": msg_id_final,
        "message_id": msg_id_final,
        "wa_msg_id": msg_id_final,
        "ack": int(msg.ack or ack_now),
        "pending": False,
        "status": "sent",
        "timestamp": timestamp_iso,
        "quoted": quoted_payload,
        "quoted_preview": quoted_preview_payload,
    }

    return _send_ok_envelope(
        evolution=evo,
        db_payload=db_payload,
        instance_name=inst_name,
        msg_id=msg_id_final,
        ack=int(msg.ack or ack_now),
        timestamp_iso=timestamp_iso,
        conversation_key=conv_ref,
        kind="c",
        entity_id=int(cliente.id),
        instancia_id=inst_id_checked,
        is_group=False,
    )


# =========================================================
# Rotas
# =========================================================
@router.post("/send/text")
async def send_text(
    body: SendTextReq,
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
):
    destino = _destino_e_numero_norm(body.number)[0]
    payload = {
        "number": destino,
        "text": body.text,
        "delay": body.delay,
        "linkPreview": body.linkPreview,
        "mentionsEveryOne": body.mentionsEveryOne,
        "mentioned": body.mentioned,
        "quoted": _model_dump_compat(body.quoted, exclude_none=True) if body.quoted else None,
    }
    payload = {k: v for k, v in payload.items() if v is not None}

    return await _send_core(
        body=body,
        db=db,
        identity=identity,
        evo_path="/message/sendText",
        evo_payload=payload,
        conteudo_persistido=body.text,
        group_message_type="conversation",
        midias=None,
    )


@router.post("/send/audio")
async def send_audio(
    body: SendAudioReq,
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
):
    destino = _destino_e_numero_norm(body.number)[0]
    payload = {
        "number": destino,
        "audio": body.audio,
        "delay": body.delay,
        "linkPreview": body.linkPreview,
        "mentionsEveryOne": body.mentionsEveryOne,
        "mentioned": body.mentioned,
        "quoted": _model_dump_compat(body.quoted, exclude_none=True) if body.quoted else None,
    }
    payload = {k: v for k, v in payload.items() if v is not None}

    audio_url = body.audio
    if audio_url and not audio_url.startswith("http") and not audio_url.startswith("data:"):
        audio_url = f"data:audio/ogg;base64,{body.audio}"
    midias = [{"tipo": "audio", "mimetype": "audio/ogg", "filename": "", "url": audio_url}]

    return await _send_core(
        body=body,
        db=db,
        identity=identity,
        evo_path="/message/sendWhatsAppAudio",
        evo_payload=payload,
        conteudo_persistido="[Áudio]",
        group_message_type="audio",
        midias=midias,
    )


@router.post("/send/media")
async def send_media(
    body: SendMediaReq,
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
):
    mimetype = body.mimetype
    if not mimetype and body.fileName:
        guess = mimetypes.guess_type(body.fileName)[0]
        if guess:
            mimetype = guess

    destino = _destino_e_numero_norm(body.number)[0]
    payload = {
        "number": destino,
        "mediatype": body.mediatype,
        "mimetype": mimetype,
        "caption": body.caption,
        "media": body.media,
        "fileName": body.fileName,
        "delay": body.delay,
        "linkPreview": body.linkPreview,
        "mentionsEveryOne": body.mentionsEveryOne,
        "mentioned": body.mentioned,
        "quoted": _model_dump_compat(body.quoted, exclude_none=True) if body.quoted else None,
    }
    payload = {k: v for k, v in payload.items() if v is not None}

    media_url = body.media
    if media_url and not media_url.startswith("http") and not media_url.startswith("data:"):
        mime = mimetype or "application/octet-stream"
        media_url = f"data:{mime};base64,{body.media}"

    midias = [{
        "tipo": body.mediatype,
        "mimetype": mimetype or "",
        "filename": body.fileName or "",
        "url": media_url,
    }]

    return await _send_core(
        body=body,
        db=db,
        identity=identity,
        evo_path="/message/sendMedia",
        evo_payload=payload,
        conteudo_persistido=(body.caption or "[Mídia]"),
        group_message_type=str(body.mediatype or "media"),
        midias=midias,
    )


@router.post("/send/sticker")
async def send_sticker(
    body: SendStickerReq,
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
):
    destino = _destino_e_numero_norm(body.number)[0]
    payload = {
        "number": destino,
        "sticker": body.sticker,
        "delay": body.delay,
        "linkPreview": body.linkPreview,
        "mentionsEveryOne": body.mentionsEveryOne,
        "mentioned": body.mentioned,
        "quoted": _model_dump_compat(body.quoted, exclude_none=True) if body.quoted else None,
    }
    payload = {k: v for k, v in payload.items() if v is not None}

    return await _send_core(
        body=body,
        db=db,
        identity=identity,
        evo_path="/message/sendSticker",
        evo_payload=payload,
        conteudo_persistido="[Figurinha]",
        group_message_type="sticker",
        midias=None,
    )


@router.post("/send/contact")
async def send_contact(
    body: SendContactReq,
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
):
    destino = _destino_e_numero_norm(body.number)[0]
    payload = {
        "number": destino,
        "contact": [_model_dump_compat(c, exclude_none=True) for c in body.contact],
    }

    return await _send_core(
        body=body,
        db=db,
        identity=identity,
        evo_path="/message/sendContact",
        evo_payload=payload,
        conteudo_persistido="[Contato]",
        group_message_type="contact",
        midias=None,
    )


@router.post("/send/reaction")
async def send_reaction(
    body: SendReactionReq,
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
):
    ensure_perm(identity, "atendimento.reagir")
    _dbg_json("SEND/REACTION body(recebido)=", _model_dump_compat(body, exclude_none=True))

    empresa_do_token, _ = _identity_ctx(identity)
    acl_ctx = resolve_acl_context(db, identity=identity, empresa_id=empresa_do_token)
    allowed = acl_ctx["allowed_instancias"]
    efetiva_empresa_id = assert_same_company(identity, body.empresa_id)

    if not (body.instance or body.instancia_id):
        raise HTTPException(400, "Para reação, informe 'instance' ou 'instancia_id'.")

    empresa, inst_name, inst_id = _resolve_empresa_e_instancia(
        db,
        empresa_id=efetiva_empresa_id,
        instance=body.instance,
        instancia_id=body.instancia_id,
        allowed_inst_ids=allowed,
    )
    _assert_empresa_resolvida(empresa_do_token, empresa.id)

    payload = {"key": _model_dump_compat(body.key, exclude_none=True), "reaction": body.reaction}
    evo = _evo_post("/message/sendReaction", inst_name, payload)

    conversa_id: Optional[int] = None
    is_group: bool = False
    conversation_key: Optional[str] = None

    try:
        msg = (
            db.query(models.Mensagem)
            .filter(models.Mensagem.empresa_id == int(empresa.id), models.Mensagem.msg_id == body.key.id)
            .order_by(models.Mensagem.id.desc())
            .first()
        )
        if msg:
            if allowed is not None and msg.instancia_id not in set(int(x) for x in (allowed or [])):
                msg = None
            if msg:
                try:
                    assert_cliente_access(
                        db,
                        identity=identity,
                        empresa_id=int(empresa.id),
                        cliente_id=int(msg.cliente_id),
                        instancia_id=getattr(msg, "instancia_id", None),
                        allow_unassigned_department=False,
                    )
                except HTTPException:
                    msg = None

            if msg:
                conversa_id = int(msg.cliente_id)
                is_group = False
                conversation_key = _conv_ref_cliente(int(msg.cliente_id), getattr(msg, "instancia_id", None))

        if conversa_id is None:
            mg = (
                db.query(models.MensagemGrupo)
                .filter(models.MensagemGrupo.empresa_id == int(empresa.id), models.MensagemGrupo.msg_id == body.key.id)
                .order_by(models.MensagemGrupo.id.desc())
                .first()
            )
            if mg:
                if allowed is not None and getattr(mg, "instancia_id", None) not in set(int(x) for x in (allowed or [])):
                    mg = None
                if mg:
                    conversa_id = int(getattr(mg, "grupo_id", None) or 0) or None
                    is_group = True
                    conversation_key = _conv_ref_grupo(int(conversa_id), getattr(mg, "instancia_id", None))
    except Exception:
        pass

    if conversa_id:
        await conexoes_ativas.send_message(
            f"emp:{empresa.id}",
            {
                "type": "reaction",
                "cliente_id": int(conversa_id),
                "conversation_id": conversation_key,
                "conversation_key": conversation_key,
                "kind": "g" if is_group else "c",
                "entity_id": int(conversa_id),
                "is_group": bool(is_group),
                "msg_id": body.key.id,
                "reaction": body.reaction,
                "remove": False,
                "timestamp": _now_sp().isoformat(timespec="microseconds"),
                "instancia_id": inst_id,
                "instance_name": inst_name,
            },
        )

    return {
        "evolution": evo,
        "cliente_id": conversa_id,
        "conversation_id": conversation_key,
        "conversation_key": conversation_key,
        "kind": "g" if is_group else "c",
        "entity_id": conversa_id,
        "instancia_id": inst_id,
        "instance_name": inst_name,
        "is_group": is_group,
    }


# ========= Rotas alternativas =========
@router.post("/instance/{instance}/send/text")
async def send_text_by_instance(
    instance: str = Path(...),
    body: SendTextReq = Body(...),
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
):
    body.instance = instance
    body.instancia_id = None
    return await send_text(body=body, db=db, identity=identity)


@router.post("/instancia/{instancia_id}/send/text")
async def send_text_by_instancia_id(
    instancia_id: int = Path(...),
    body: SendTextReq = Body(...),
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
):
    body.instancia_id = instancia_id
    body.instance = None
    return await send_text(body=body, db=db, identity=identity)


@router.post("/instance/{instance}/send/audio")
async def send_audio_by_instance(
    instance: str = Path(...),
    body: SendAudioReq = Body(...),
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
):
    body.instance = instance
    body.instancia_id = None
    return await send_audio(body=body, db=db, identity=identity)


@router.post("/instancia/{instancia_id}/send/audio")
async def send_audio_by_instancia_id(
    instancia_id: int = Path(...),
    body: SendAudioReq = Body(...),
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
):
    body.instancia_id = instancia_id
    body.instance = None
    return await send_audio(body=body, db=db, identity=identity)


@router.post("/instance/{instance}/send/media")
async def send_media_by_instance(
    instance: str = Path(...),
    body: SendMediaReq = Body(...),
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
):
    body.instance = instance
    body.instancia_id = None
    return await send_media(body=body, db=db, identity=identity)


@router.post("/instancia/{instancia_id}/send/media")
async def send_media_by_instancia_id(
    instancia_id: int = Path(...),
    body: SendMediaReq = Body(...),
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
):
    body.instancia_id = instancia_id
    body.instance = None
    return await send_media(body=body, db=db, identity=identity)


@router.post("/instance/{instance}/send/sticker")
async def send_sticker_by_instance(
    instance: str = Path(...),
    body: SendStickerReq = Body(...),
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
):
    body.instance = instance
    body.instancia_id = None
    return await send_sticker(body=body, db=db, identity=identity)


@router.post("/instancia/{instancia_id}/send/sticker")
async def send_sticker_by_instancia_id(
    instancia_id: int = Path(...),
    body: SendStickerReq = Body(...),
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
):
    body.instancia_id = instancia_id
    body.instance = None
    return await send_sticker(body=body, db=db, identity=identity)


@router.post("/instance/{instance}/send/contact")
async def send_contact_by_instance(
    instance: str = Path(...),
    body: SendContactReq = Body(...),
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
):
    body.instance = instance
    body.instancia_id = None
    return await send_contact(body=body, db=db, identity=identity)


@router.post("/instancia/{instancia_id}/send/contact")
async def send_contact_by_instancia_id(
    instancia_id: int = Path(...),
    body: SendContactReq = Body(...),
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
):
    body.instancia_id = instancia_id
    body.instance = None
    return await send_contact(body=body, db=db, identity=identity)


@router.post("/instance/{instance}/send/reaction")
async def send_reaction_by_instance(
    instance: str = Path(...),
    body: SendReactionReq = Body(...),
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
):
    body.instance = instance
    body.instancia_id = None
    return await send_reaction(body=body, db=db, identity=identity)


@router.post("/instancia/{instancia_id}/send/reaction")
async def send_reaction_by_instancia_id(
    instancia_id: int = Path(...),
    body: SendReactionReq = Body(...),
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
):
    body.instancia_id = instancia_id
    body.instance = None
    return await send_reaction(body=body, db=db, identity=identity)