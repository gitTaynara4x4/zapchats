# backend/integrations/evolution/handlers/shared.py

from __future__ import annotations

import asyncio
import inspect
import os
import re
import unicodedata
from datetime import datetime, timezone
from typing import Any, Callable, Optional

from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from backend import models
from backend.database import SessionLocal
from backend.routers.chatbot_setores import triagem_handle_inbound

try:
    from backend.routers.chatbot_setores import auto_messages_handle_inbound
except ImportError:
    auto_messages_handle_inbound = None

from ..parsers.media_parser import _b64_to_bytes, normalize_mimetype
from ..repositories.atendimentos_repo import (
    get_or_open_atendimento_repo,
    has_mensagem_atendimento_field,
)
from ..repositories.clientes_repo import get_cliente_by_id, upsert_cliente_repo
from ..repositories.grupos_repo import (
    get_or_create_grupo_by_remote,
    upsert_grupos_from_chats as _repo_upsert_grupos_from_chats,
)
from ..services.media_service import (
    _save_midia_db,
    save_media_for_group_message_with_db,
    save_media_for_message_11_with_db,
)
from ..transport.evolution_http_client import EvolutionHttpClient
from ..utils.cache_utils import invalidate_emp_cache
from ..utils.jid_utils import is_lid_jid, jid_strip_device
from ..utils.log_utils import LOG, _log_ctx, _short
from ..utils.phone_utils import _resolve_counterparty_num_1to1, formatar_telefone_br, remote_to_num
from ..utils.time_utils import _int_unix, _iso_utc, _now_utc, _server_ts_ms


# Segurança do chatbot contra replay/backlog:
# quando o servidor ficou desligado, a Evolution/Rabbit pode entregar mensagens antigas.
# Essas mensagens antigas podem ser salvas no histórico, mas NÃO devem disparar bot/menu.
def _env_int_chatbot(name: str, default: int) -> int:
    try:
        return int(float(str(os.getenv(name, default)).strip()))
    except Exception:
        return int(default)


CHATBOT_MAX_INBOUND_AGE_SECONDS = max(0, _env_int_chatbot("CHATBOT_MAX_INBOUND_AGE_SECONDS", 600))


def _as_aware_utc_chatbot(value: Any) -> Optional[datetime]:
    if value is None:
        return None
    try:
        if isinstance(value, datetime):
            if value.tzinfo is None:
                return value.replace(tzinfo=timezone.utc)
            return value.astimezone(timezone.utc)
        raw = str(value).strip()
        if not raw:
            return None
        if raw.replace('.', '', 1).isdigit():
            return datetime.fromtimestamp(float(raw), tz=timezone.utc)
    except Exception:
        return None
    return None


def _chatbot_should_skip_stale_inbound(*, message_ts: Any = None) -> tuple[bool, float]:
    if CHATBOT_MAX_INBOUND_AGE_SECONDS <= 0:
        return False, 0.0
    ts = _as_aware_utc_chatbot(message_ts)
    if ts is None:
        return False, 0.0
    try:
        age = (datetime.now(timezone.utc) - ts).total_seconds()
    except Exception:
        return False, 0.0
    return age > float(CHATBOT_MAX_INBOUND_AGE_SECONDS), float(age)

HANDLERS: dict[str, Callable[..., Any]] = {}


class EvoEvent:
    APPLICATION_STARTUP = "APPLICATION_STARTUP"
    INSTANCE_CREATE = "INSTANCE_CREATE"
    QRCODE_UPDATED = "QRCODE_UPDATED"
    CONNECTION_UPDATE = "CONNECTION_UPDATE"
    MESSAGES_SET = "MESSAGES_SET"
    MESSAGES_UPSERT = "MESSAGES_UPSERT"
    MESSAGES_UPDATE = "MESSAGES_UPDATE"
    MESSAGES_DELETE = "MESSAGES_DELETE"
    MESSAGES_EDITED = "MESSAGES_EDITED"
    SEND_MESSAGE = "SEND_MESSAGE"

    CHATS_SET = "CHATS_SET"
    CHATS_UPSERT = "CHATS_UPSERT"
    CHATS_UPDATE = "CHATS_UPDATE"
    CHATS_DELETE = "CHATS_DELETE"

    CONTACTS_SET = "CONTACTS_SET"
    CONTACTS_UPSERT = "CONTACTS_UPSERT"
    CONTACTS_UPDATE = "CONTACTS_UPDATE"
    GROUPS_UPSERT = "GROUPS_UPSERT"
    GROUPS_UPDATE = "GROUPS_UPDATE"
    GROUP_UPDATE = "GROUP_UPDATE"
    GROUP_PARTICIPANTS_UPDATE = "GROUP_PARTICIPANTS_UPDATE"
    LABELS_EDIT = "LABELS_EDIT"
    LABELS_ASSOCIATION = "LABELS_ASSOCIATION"
    LABELS_UPDATE = "LABELS_UPDATE"
    NEW_TOKEN = "NEW_TOKEN"
    CALL = "CALL"
    LOGOUT_INSTANCE = "LOGOUT_INSTANCE"
    INSTANCE_DELETE = "INSTANCE_DELETE"
    REMOVE_INSTANCE = "REMOVE_INSTANCE"


def _normalize_event_names(names: tuple[Any, ...]) -> list[str]:
    out: list[str] = []
    for item in names:
        if isinstance(item, (list, tuple, set)):
            for sub in item:
                s = str(sub or "").strip()
                if s:
                    out.append(s.replace(".", "_").replace("-", "_").upper())
        else:
            s = str(item or "").strip()
            if s:
                out.append(s.replace(".", "_").replace("-", "_").upper())
    return out


def handler(*event_names: str):
    names = _normalize_event_names(event_names)

    def decorator(func: Callable[..., Any]):
        for name in names:
            existing = HANDLERS.get(name)
            if existing is None or existing is func:
                HANDLERS[name] = func
                continue

            async def _fanout(*args, _existing=existing, _func=func, **kwargs):
                results = []

                r1 = _existing(*args, **kwargs)
                if inspect.isawaitable(r1):
                    r1 = await r1
                results.append(r1)

                r2 = _func(*args, **kwargs)
                if inspect.isawaitable(r2):
                    r2 = await r2
                results.append(r2)

                return results

            HANDLERS[name] = _fanout

        return func

    return decorator


_GROUP_INFO_CACHE: dict[tuple[str, str], tuple[str, int]] = {}
_GROUP_INFO_TTL = 60 * 60

# Mapa em memória rápido.
# O mapa definitivo fica também na tabela contatos_whatsapp_identidades.
_LID_MAP: dict[tuple[int, int, str], str] = {}


def _to_int(v) -> int | None:
    try:
        if v is None:
            return None
        return int(v)
    except Exception:
        return None


def _only_digits(raw: Any) -> str:
    return re.sub(r"\D+", "", str(raw or ""))


def _clean_text(raw: Any) -> str | None:
    s = str(raw or "").strip()
    return s or None


def normalize_contact_name(raw: Any) -> str | None:
    """
    Normaliza nome para comparação:
    - remove acento
    - lower
    - remove excesso de espaço
    """
    s = str(raw or "").strip()
    if not s:
        return None

    s = unicodedata.normalize("NFKD", s)
    s = "".join(ch for ch in s if not unicodedata.combining(ch))
    s = re.sub(r"\s+", " ", s).strip().lower()

    return s or None


def _is_bad_push_name(name: Any) -> bool:
    """
    Nome ruim/falso que NÃO pode ser gravado como push_name real.

    Isso resolve o bug:
    messages.set criava identidade com push_name='Contato do WhatsApp',
    depois o backfill achava que esse era o nome real e não corrigia direito.
    """
    s = str(name or "").strip()
    if not s:
        return True

    low = s.lower().strip()
    low_norm = normalize_contact_name(low) or low

    if low_norm in {
        "voce",
        "você",
        "you",
        "cliente",
        "contato",
        "unknown",
        "desconhecido",
        "0",
        "contato do whatsapp",
        "contato whatsapp",
        "whatsapp",
    }:
        return True

    if low_norm.startswith("contato do whatsapp"):
        return True

    if low_norm.startswith("contato lid"):
        return True

    if low_norm.startswith("lid "):
        return True

    digits = _only_digits(s)

    # pushName igual número gigante/LID geralmente não é nome real.
    if digits and digits == s and len(digits) >= 13:
        return True

    # nomes tipo "147 377 658 822 877"
    if digits and len(digits) >= 13 and len(digits) >= max(1, len(s.replace(" ", "")) - 3):
        return True

    return False


def _jid_tipo(remote_jid: str | None) -> str:
    jid = jid_strip_device(remote_jid or "")
    low = jid.lower()

    if not jid:
        return "unknown"

    if low.endswith("@lid"):
        return "lid"

    if low.endswith("@s.whatsapp.net"):
        return "whatsapp"

    if low.endswith("@c.us"):
        return "cus"

    if low.endswith("@g.us"):
        return "grupo"

    return "unknown"


def _real_jid_from_remote(remote_jid: str | None) -> str | None:
    jid = jid_strip_device(remote_jid or "")
    if not jid:
        return None

    tipo = _jid_tipo(jid)

    if tipo == "whatsapp":
        return jid

    if tipo == "cus":
        tel = remote_to_num(jid)
        if tel:
            return f"{tel}@s.whatsapp.net"

    return None


def _telefone_norm_from_remote(remote_jid: str | None) -> str | None:
    real = _real_jid_from_remote(remote_jid)
    if real:
        tel = remote_to_num(real)
        if tel:
            return _only_digits(tel) or None

    jid = jid_strip_device(remote_jid or "")
    if not jid:
        return None

    if "@" not in jid:
        digits = _only_digits(jid)
        if 10 <= len(digits) <= 15:
            return digits

    return None


def _payload_safe(payload: Any) -> Any:
    """
    Mantém payload pequeno o suficiente para debug sem entupir banco.
    """
    if payload is None:
        return None

    if isinstance(payload, dict):
        out = {}
        for k, v in payload.items():
            if k in {"message", "contextInfo"}:
                continue
            if isinstance(v, (str, int, float, bool)) or v is None:
                out[k] = v
            elif isinstance(v, dict):
                out[k] = {
                    kk: vv
                    for kk, vv in v.items()
                    if isinstance(vv, (str, int, float, bool)) or vv is None
                }
            else:
                out[k] = str(type(v).__name__)
        return out

    return {"raw_type": type(payload).__name__, "raw": str(payload)[:1000]}


def _carimbar_inst(obj, inst) -> None:
    if obj is None or inst is None:
        return

    if hasattr(obj, "instancia_id") and getattr(obj, "instancia_id", None) is None:
        setattr(obj, "instancia_id", getattr(inst, "id", None))

    if hasattr(obj, "instance_name") and not getattr(obj, "instance_name", None):
        setattr(obj, "instance_name", getattr(inst, "instance_name", None))


def _get_inst_row(db: Session, instance_name: str | None) -> models.EmpresaInstancia | None:
    raw = str(instance_name or "").strip()
    if not raw:
        return None

    return (
        db.query(models.EmpresaInstancia)
        .filter(models.EmpresaInstancia.instance_name == raw)
        .first()
    )


def _me_number_by_inst(inst: models.EmpresaInstancia | None) -> str | None:
    if not inst:
        return None

    raw = getattr(inst, "numero_instancia", None)
    if not raw:
        return None

    digits = re.sub(r"\D+", "", str(raw))
    return digits or None


def _fetch_cliente(db: Session, cliente_id: int | None) -> models.Cliente | None:
    if not cliente_id:
        return None
    return get_cliente_by_id(db, int(cliente_id))


def _get_cliente_departamento_id(db: Session, cliente_id: int | None) -> int | None:
    cli = _fetch_cliente(db, cliente_id)
    if not cli:
        return None
    return _to_int(getattr(cli, "departamento_id", None))


def _get_cliente_operador_id(db: Session, cliente_id: int | None) -> int | None:
    cli = _fetch_cliente(db, cliente_id)
    if not cli:
        return None
    return _to_int(getattr(cli, "colaborador_id", None))


def upsert_cliente(
    db: Session,
    *,
    empresa_id: int,
    instancia_id: int | None,
    telefone_raw: str,
    nome: str | None = None,
    nome_whatsapp: str | None = None,
    avatar_url: str | None = None,
    self_profile_name: str | None = None,
    allow_self_name_repair: bool = False,
) -> int | None:
    return upsert_cliente_repo(
        db,
        empresa_id=int(empresa_id),
        instancia_id=(int(instancia_id) if instancia_id is not None else None),
        telefone_raw=telefone_raw,
        nome=nome,
        nome_whatsapp=nome_whatsapp,
        avatar_url=avatar_url,
        self_profile_name=self_profile_name,
        allow_self_name_repair=bool(allow_self_name_repair),
    )


_HAS_MSG_ATD_FIELD = has_mensagem_atendimento_field()


def _get_or_open_atendimento(
    db: Session,
    *,
    empresa_id: int,
    instancia_id: int,
    cliente_id: int,
    direcao: str,
    ts_dt,
    departamento_id: int | None = None,
    operador_id: int | None = None,
):
    dep_id = _to_int(departamento_id)
    op_id = _to_int(operador_id)

    # fallback enquanto o restante dos callers vai sendo adaptado:
    # se não vier departamento/operador, tenta puxar do cliente atual
    if dep_id is None:
        dep_id = _get_cliente_departamento_id(db, cliente_id)

    if op_id is None:
        op_id = _get_cliente_operador_id(db, cliente_id)

    return get_or_open_atendimento_repo(
        db,
        empresa_id=int(empresa_id),
        instancia_id=int(instancia_id),
        cliente_id=int(cliente_id),
        direcao=direcao,
        ts_dt=ts_dt,
        departamento_id=dep_id,
        operador_id=op_id,
    )


def _is_deadlock_error(e: Exception) -> bool:
    base = getattr(e, "orig", e)
    msg = str(base).lower()
    return "deadlock detected" in msg


async def _retry_deadlock(db: Session, func, *, attempts: int = 5, base_delay: float = 0.02):
    for i in range(attempts):
        try:
            return func()
        except Exception as e:
            if _is_deadlock_error(e):
                try:
                    db.rollback()
                except Exception:
                    pass
                await asyncio.sleep(base_delay * (2**i))
                continue
            raise


def _invalidate_emp_cache(emp_id: int) -> None:
    invalidate_emp_cache(int(emp_id))


# =========================================================
# Identidades WhatsApp / LID
# =========================================================
def _lid_map_key(empresa_id: int, instancia_id: int, lid_jid: str | None) -> tuple[int, int, str]:
    return (
        int(empresa_id),
        int(instancia_id),
        jid_strip_device(lid_jid or ""),
    )


def _lid_map_set(empresa_id: int, instancia_id: int, lid_jid: str, real_jid: str) -> bool:
    lid_norm = jid_strip_device(lid_jid)
    real_norm = jid_strip_device(real_jid)

    if not lid_norm or not real_norm:
        return False

    if not is_lid_jid(lid_norm):
        return False

    real_norm_2 = _real_jid_from_remote(real_norm)
    if not real_norm_2:
        return False

    _LID_MAP[_lid_map_key(empresa_id, instancia_id, lid_norm)] = real_norm_2
    return True


def _lid_map_get(empresa_id: int, instancia_id: int, lid_jid: str | None) -> str | None:
    key = _lid_map_key(empresa_id, instancia_id, lid_jid or "")
    return _LID_MAP.get(key)


def upsert_whatsapp_identity(
    db: Session,
    *,
    empresa_id: int,
    instancia_id: int | None,
    remote_jid: str,
    push_name: str | None = None,
    profile_pic_url: str | None = None,
    origem: str | None = None,
    cliente_id: int | None = None,
    real_jid: str | None = None,
    confirmado: bool | None = None,
    confianca: int | None = None,
    resolved_by: str | None = None,
    payload: Any = None,
    commit: bool = False,
) -> models.ContatoWhatsappIdentidade | None:
    """
    Salva/atualiza identidade recebida da Evolution.

    Importante:
    - fallback visual como "Contato do WhatsApp" NÃO é salvo como push_name.
    - se já existir push_name fake antigo, limpa.
    """
    remote = jid_strip_device(remote_jid or "")
    if not remote:
        return None

    empresa_id = int(empresa_id)
    inst_id = int(instancia_id) if instancia_id is not None else None

    tipo = _jid_tipo(remote)
    lid_jid = remote if tipo == "lid" else None

    real_from_remote = _real_jid_from_remote(remote)
    real_final = _real_jid_from_remote(real_jid) or real_from_remote

    telefone_norm = _telefone_norm_from_remote(real_final or remote)

    name = _clean_text(push_name)
    name_is_good = bool(name and not _is_bad_push_name(name))
    name_norm = normalize_contact_name(name) if name_is_good else None

    foto = _clean_text(profile_pic_url)

    if confianca is None:
        if confirmado:
            confianca = 100
        elif real_final and lid_jid:
            confianca = 90
        elif real_final:
            confianca = 70
        elif name_is_good and foto:
            confianca = 60
        elif name_is_good:
            confianca = 35
        else:
            confianca = 10

    try:
        row = (
            db.query(models.ContatoWhatsappIdentidade)
            .filter(
                models.ContatoWhatsappIdentidade.empresa_id == empresa_id,
                models.ContatoWhatsappIdentidade.instancia_id == inst_id,
                models.ContatoWhatsappIdentidade.remote_jid == remote,
            )
            .first()
        )

        if not row:
            row = models.ContatoWhatsappIdentidade(
                empresa_id=empresa_id,
                instancia_id=inst_id,
                remote_jid=remote,
                jid_tipo=tipo,
            )
            db.add(row)
            db.flush()

        row.jid_tipo = tipo

        if lid_jid:
            row.lid_jid = lid_jid

        if real_final:
            row.real_jid = real_final
            row.telefone_norm = telefone_norm

        elif telefone_norm and not row.telefone_norm:
            row.telefone_norm = telefone_norm

        if cliente_id is not None:
            row.cliente_id = int(cliente_id)

        # Limpa push_name fake já salvo anteriormente.
        if row.push_name and _is_bad_push_name(row.push_name):
            row.push_name = None
            row.push_name_norm = None
            try:
                row.confianca = min(int(row.confianca or 10), 10)
            except Exception:
                row.confianca = 10

        # Só grava nome se for nome real.
        if name_is_good:
            row.push_name = name
            row.push_name_norm = name_norm

        if foto:
            row.profile_pic_url = foto

        if origem:
            row.origem = str(origem)[:80]

        if confirmado is not None:
            row.confirmado = bool(confirmado)

        if confianca is not None:
            try:
                row.confianca = max(int(getattr(row, "confianca", 0) or 0), int(confianca))
            except Exception:
                row.confianca = int(confianca)

        if resolved_by:
            row.resolved_by = str(resolved_by)[:120]

        safe_payload = _payload_safe(payload)
        if safe_payload is not None:
            row.payload = safe_payload

        row.ultimo_evento_em = _now_utc()
        row.atualizado_em = _now_utc()

        db.add(row)

        if lid_jid and real_final:
            _lid_map_set(empresa_id, inst_id or 0, lid_jid, real_final)

        if commit:
            db.commit()

        return row

    except Exception as e:
        try:
            db.rollback()
        except Exception:
            pass
        LOG(
            f"[IDENTITY][upsert][erro] empresa_id={empresa_id} instancia_id={inst_id} "
            f"remote={remote} err={e}"
        )
        return None


def upsert_whatsapp_identities_from_contacts(
    db: Session,
    *,
    empresa_id: int,
    instancia_id: int | None,
    contatos: list[dict],
    origem: str,
    commit: bool = False,
) -> int:

    total = 0

    for c in contatos or []:
        if not isinstance(c, dict):
            continue

        remote = (
            c.get("remoteJid")
            or c.get("remote_jid")
            or c.get("id")
            or c.get("jid")
        )

        if not remote:
            continue

        nome = name_from_contact_like(c)
        if _is_bad_push_name(nome):
            nome = None

        row = upsert_whatsapp_identity(
            db,
            empresa_id=empresa_id,
            instancia_id=instancia_id,
            remote_jid=str(remote),
            push_name=nome,
            profile_pic_url=avatar_from_contact_like(c),
            origem=origem,
            payload=c,
            commit=False,
        )

        if row:
            total += 1

    try:
        vincular_lids_por_nome_e_foto(
            db,
            empresa_id=empresa_id,
            instancia_id=instancia_id,
        )
    except Exception as e:
        LOG(
            f"[IDENTITY][contacts][vincular-falhou] empresa_id={empresa_id} "
            f"instancia_id={instancia_id} err={e}"
        )

    if commit:
        db.commit()

    LOG(
        f"[IDENTITY][contacts] origem={origem} empresa_id={empresa_id} "
        f"instancia_id={instancia_id} total={total}"
    )

    return total


def vincular_lids_por_nome_e_foto(
    db: Session,
    *,
    empresa_id: int,
    instancia_id: int | None,
) -> int:
    """
    Tenta confirmar LID -> número real usando os contatos da própria Evolution.

    Regra segura:
    - se LID tem mesmo push_name_norm de exatamente 1 contato real, vincula.
    - se tiver profile_pic_url igual, aumenta confiança.
    - se nome for ruim ou duplicado demais, não chuta.
    """
    empresa_id = int(empresa_id)
    inst_id = int(instancia_id) if instancia_id is not None else None

    lids = (
        db.query(models.ContatoWhatsappIdentidade)
        .filter(
            models.ContatoWhatsappIdentidade.empresa_id == empresa_id,
            models.ContatoWhatsappIdentidade.instancia_id == inst_id,
            models.ContatoWhatsappIdentidade.lid_jid.isnot(None),
        )
        .all()
    )

    vinculados = 0

    for lid_row in lids:
        if lid_row.real_jid:
            continue

        name_norm = normalize_contact_name(getattr(lid_row, "push_name", None))
        if not name_norm:
            continue

        if _is_bad_push_name(getattr(lid_row, "push_name", None)):
            continue

        candidatos_q = (
            db.query(models.ContatoWhatsappIdentidade)
            .filter(
                models.ContatoWhatsappIdentidade.empresa_id == empresa_id,
                models.ContatoWhatsappIdentidade.instancia_id == inst_id,
                models.ContatoWhatsappIdentidade.real_jid.isnot(None),
                models.ContatoWhatsappIdentidade.push_name_norm == name_norm,
            )
        )

        candidatos = candidatos_q.all()

        if not candidatos:
            continue

        # Preferência 1: mesma foto.
        foto_lid = getattr(lid_row, "profile_pic_url", None)
        if foto_lid:
            mesmos_foto = [
                c for c in candidatos
                if getattr(c, "profile_pic_url", None)
                and getattr(c, "profile_pic_url", None) == foto_lid
            ]
            if len(mesmos_foto) == 1:
                cand = mesmos_foto[0]
                lid_row.real_jid = cand.real_jid
                lid_row.telefone_norm = cand.telefone_norm
                lid_row.cliente_id = cand.cliente_id
                lid_row.confirmado = True
                lid_row.confianca = max(int(lid_row.confianca or 0), 95)
                lid_row.resolved_by = "same_push_name_and_photo"
                lid_row.atualizado_em = _now_utc()
                lid_row.ultimo_evento_em = _now_utc()

                _lid_map_set(empresa_id, inst_id or 0, lid_row.lid_jid, cand.real_jid)
                vinculados += 1
                continue

        # Preferência 2: nome único.
        if len(candidatos) == 1:
            cand = candidatos[0]
            lid_row.real_jid = cand.real_jid
            lid_row.telefone_norm = cand.telefone_norm
            lid_row.cliente_id = cand.cliente_id
            lid_row.confirmado = False
            lid_row.confianca = max(int(lid_row.confianca or 0), 75)
            lid_row.resolved_by = "unique_same_push_name"
            lid_row.atualizado_em = _now_utc()
            lid_row.ultimo_evento_em = _now_utc()

            _lid_map_set(empresa_id, inst_id or 0, lid_row.lid_jid, cand.real_jid)
            vinculados += 1

    if vinculados:
        LOG(
            f"[IDENTITY][vincular] empresa_id={empresa_id} instancia_id={inst_id} "
            f"vinculados={vinculados}"
        )

    return vinculados


def get_identity_by_remote(
    db: Session,
    *,
    empresa_id: int,
    instancia_id: int | None,
    remote_jid: str,
) -> models.ContatoWhatsappIdentidade | None:
    remote = jid_strip_device(remote_jid or "")
    if not remote:
        return None

    return (
        db.query(models.ContatoWhatsappIdentidade)
        .filter(
            models.ContatoWhatsappIdentidade.empresa_id == int(empresa_id),
            models.ContatoWhatsappIdentidade.instancia_id == (int(instancia_id) if instancia_id is not None else None),
            models.ContatoWhatsappIdentidade.remote_jid == remote,
        )
        .first()
    )


def resolve_lid_identity(
    db: Session,
    *,
    empresa_id: int,
    instancia_id: int | None,
    lid_jid: str,
) -> dict[str, Any]:
    """
    Resolve uma LID para uso no messages.set/messages.upsert.
    """
    lid = jid_strip_device(lid_jid or "")

    out = {
        "remote_jid": lid,
        "real_jid": None,
        "lid_jid": lid if is_lid_jid(lid) else None,
        "telefone_norm": None,
        "push_name": None,
        "profile_pic_url": None,
        "cliente_id": None,
        "resolved": False,
        "confianca": 0,
        "resolved_by": None,
    }

    if not lid:
        return out

    if not is_lid_jid(lid):
        real = _real_jid_from_remote(lid)
        tel = _telefone_norm_from_remote(real or lid)
        out.update(
            {
                "remote_jid": real or lid,
                "real_jid": real,
                "telefone_norm": tel,
                "resolved": bool(real),
            }
        )
        return out

    empresa_id = int(empresa_id)
    inst_id = int(instancia_id) if instancia_id is not None else None

    mapped_memory = _lid_map_get(empresa_id, inst_id or 0, lid)
    if mapped_memory:
        out["remote_jid"] = mapped_memory
        out["real_jid"] = mapped_memory
        out["telefone_norm"] = _telefone_norm_from_remote(mapped_memory)
        out["resolved"] = True
        out["confianca"] = 100
        out["resolved_by"] = "memory_map"

    row = (
        db.query(models.ContatoWhatsappIdentidade)
        .filter(
            models.ContatoWhatsappIdentidade.empresa_id == empresa_id,
            models.ContatoWhatsappIdentidade.instancia_id == inst_id,
            models.ContatoWhatsappIdentidade.lid_jid == lid,
        )
        .order_by(
            models.ContatoWhatsappIdentidade.confirmado.desc(),
            models.ContatoWhatsappIdentidade.confianca.desc(),
        )
        .first()
    )

    if row:
        if row.real_jid:
            out["remote_jid"] = row.real_jid
            out["real_jid"] = row.real_jid
            out["telefone_norm"] = row.telefone_norm or _telefone_norm_from_remote(row.real_jid)
            out["resolved"] = True
            _lid_map_set(empresa_id, inst_id or 0, lid, row.real_jid)

        push = row.push_name
        if _is_bad_push_name(push):
            push = None

        out["push_name"] = push
        out["profile_pic_url"] = row.profile_pic_url
        out["cliente_id"] = row.cliente_id
        out["confianca"] = max(int(out.get("confianca") or 0), int(row.confianca or 0))
        out["resolved_by"] = row.resolved_by

    return out


def _resolve_remote_jid_db(
    empresa_id: int,
    instancia_id: int,
    raw_remote: str | None,
) -> str | None:
    raw = jid_strip_device(raw_remote or "")
    if not raw or not is_lid_jid(raw):
        return raw or None

    with SessionLocal() as db:
        try:
            resolved = resolve_lid_identity(
                db,
                empresa_id=empresa_id,
                instancia_id=instancia_id,
                lid_jid=raw,
            )
            real = resolved.get("real_jid")
            if real:
                return jid_strip_device(real)
        except Exception as e:
            LOG(
                f"[IDENTITY][resolve-db][erro] empresa_id={empresa_id} "
                f"instancia_id={instancia_id} raw={raw} err={e}"
            )

    return None


def _resolve_remote_jid(empresa_id: int, instancia_id: int, raw_remote: str | None) -> str | None:
    raw = jid_strip_device(raw_remote)
    if not raw:
        return None

    if not is_lid_jid(raw):
        return raw

    mapped = _lid_map_get(empresa_id, instancia_id, raw)
    if mapped:
        return jid_strip_device(mapped)

    mapped_db = _resolve_remote_jid_db(empresa_id, instancia_id, raw)
    if mapped_db:
        return jid_strip_device(mapped_db)

    return None


def merge_lid_cliente_into_real_cliente(
    db: Session,
    *,
    empresa_id: int,
    instancia_id: int | None,
    lid_cliente_id: int | None,
    real_cliente_id: int | None,
    lid_jid: str | None = None,
    real_jid: str | None = None,
) -> bool:
    """
    Mescla histórico salvo provisoriamente no cliente LID para o cliente real.
    """
    if not lid_cliente_id or not real_cliente_id:
        return False

    lid_cliente_id = int(lid_cliente_id)
    real_cliente_id = int(real_cliente_id)

    if lid_cliente_id == real_cliente_id:
        return False

    empresa_id = int(empresa_id)
    inst_id = int(instancia_id) if instancia_id is not None else None

    try:
        db.execute(
            text(
                """
                UPDATE mensagens
                   SET cliente_id = :real_cliente_id
                 WHERE empresa_id = :empresa_id
                   AND cliente_id = :lid_cliente_id
                   AND (:instancia_id IS NULL OR instancia_id = :instancia_id)
                """
            ),
            {
                "empresa_id": empresa_id,
                "instancia_id": inst_id,
                "lid_cliente_id": lid_cliente_id,
                "real_cliente_id": real_cliente_id,
            },
        )

        db.execute(
            text(
                """
                UPDATE midias
                   SET cliente_id = :real_cliente_id
                 WHERE empresa_id = :empresa_id
                   AND cliente_id = :lid_cliente_id
                   AND (:instancia_id IS NULL OR instancia_id = :instancia_id)
                """
            ),
            {
                "empresa_id": empresa_id,
                "instancia_id": inst_id,
                "lid_cliente_id": lid_cliente_id,
                "real_cliente_id": real_cliente_id,
            },
        )

        db.execute(
            text(
                """
                UPDATE atendimentos
                   SET cliente_id = :real_cliente_id
                 WHERE empresa_id = :empresa_id
                   AND cliente_id = :lid_cliente_id
                   AND (:instancia_id IS NULL OR instancia_id = :instancia_id)
                """
            ),
            {
                "empresa_id": empresa_id,
                "instancia_id": inst_id,
                "lid_cliente_id": lid_cliente_id,
                "real_cliente_id": real_cliente_id,
            },
        )

        db.execute(
            text(
                """
                UPDATE contatos_whatsapp_identidades
                   SET cliente_id = :real_cliente_id,
                       real_jid = COALESCE(real_jid, :real_jid),
                       confirmado = CASE WHEN :real_jid IS NOT NULL THEN true ELSE confirmado END,
                       confianca = GREATEST(confianca, 95),
                       resolved_by = COALESCE(resolved_by, 'merge_lid_cliente_into_real_cliente'),
                       atualizado_em = NOW(),
                       ultimo_evento_em = NOW()
                 WHERE empresa_id = :empresa_id
                   AND (:instancia_id IS NULL OR instancia_id = :instancia_id)
                   AND (
                        cliente_id = :lid_cliente_id
                        OR lid_jid = :lid_jid
                   )
                """
            ),
            {
                "empresa_id": empresa_id,
                "instancia_id": inst_id,
                "lid_cliente_id": lid_cliente_id,
                "real_cliente_id": real_cliente_id,
                "lid_jid": jid_strip_device(lid_jid or "") or None,
                "real_jid": _real_jid_from_remote(real_jid) if real_jid else None,
            },
        )

        if lid_jid and real_jid:
            _lid_map_set(empresa_id, inst_id or 0, lid_jid, real_jid)

        LOG(
            f"[IDENTITY][merge] emp={empresa_id} inst={inst_id} "
            f"lid_cliente={lid_cliente_id} real_cliente={real_cliente_id} "
            f"lid_jid={lid_jid} real_jid={real_jid}"
        )

        return True

    except Exception as e:
        try:
            db.rollback()
        except Exception:
            pass
        LOG(
            f"[IDENTITY][merge][erro] emp={empresa_id} inst={inst_id} "
            f"lid_cliente={lid_cliente_id} real_cliente={real_cliente_id} err={e}"
        )
        return False


def is_nome_grupo_ruim(nome: str | None) -> bool:
    if not nome:
        return True
    n = str(nome).strip().lower()
    return (n == "") or (n in {"grupo", "group", "grupo do whatsapp", "whatsapp group"})


def evo_get_group_subject(instance_name: str, group_jid: str) -> str | None:
    if not instance_name or not group_jid:
        return None

    key = (instance_name, group_jid)
    now = _int_unix(_now_utc())

    cached = _GROUP_INFO_CACHE.get(key)
    if cached:
        subject_cached, ts_cached = cached
        if (now - ts_cached) < _GROUP_INFO_TTL:
            return subject_cached

    try:
        subject = EvolutionHttpClient().get_group_subject(instance_name, group_jid)
        if subject:
            _GROUP_INFO_CACHE[key] = (subject, now)
        return subject
    except Exception:
        return None


def is_statement_timeout_error(e: Exception) -> bool:
    base = getattr(e, "orig", e)
    msg = str(base).lower()
    return (
        "statement timeout" in msg
        or "canceling statement due to statement timeout" in msg
        or "querycanceled" in msg
        or "query canceled" in msg
        or "lock timeout" in msg
    )


def is_duplicate_key_error(e: Exception) -> bool:
    base = getattr(e, "orig", e)
    msg = str(base).lower()
    return (
        "duplicate key value violates unique constraint" in msg
        or "unique violation" in msg
        or "uq_mensagens_" in msg
    )


def find_existing_mensagem_11_id(
    db: Session,
    *,
    empresa_id: int,
    cliente_id: int | None,
    msg_id: str | None,
    instancia_id: int | None,
) -> int | None:
    raw = str(msg_id or "").strip()
    if not raw:
        return None

    if instancia_id is not None:
        row = db.execute(
            text(
                """
                SELECT id
                  FROM mensagens
                 WHERE instancia_id = :instancia_id
                   AND msg_id = :msg_id
                 ORDER BY id DESC
                 LIMIT 1
                """
            ),
            {
                "instancia_id": int(instancia_id),
                "msg_id": raw,
            },
        ).fetchone()
        if row and row[0] is not None:
            return int(row[0])

    if empresa_id is not None and cliente_id is not None:
        row = db.execute(
            text(
                """
                SELECT id
                  FROM mensagens
                 WHERE empresa_id = :empresa_id
                   AND cliente_id = :cliente_id
                   AND msg_id = :msg_id
                 ORDER BY id DESC
                 LIMIT 1
                """
            ),
            {
                "empresa_id": int(empresa_id),
                "cliente_id": int(cliente_id),
                "msg_id": raw,
            },
        ).fetchone()
        if row and row[0] is not None:
            return int(row[0])

    return None


async def insert_mensagem_11_with_retry(
    db: Session,
    *,
    empresa_id: int,
    cliente_id: int,
    conteudo: str,
    tipo: str,
    lida: bool,
    ack: int | None,
    timestamp,
    msg_id: str,
    instancia_id: int,
    atendimento_id: int | None,
    idx: int,
) -> tuple[int | None, bool]:
    sql = text(
        """
        INSERT INTO mensagens
            (empresa_id, cliente_id, conteudo, tipo, lida, ack, timestamp, msg_id, instancia_id, atendimento_id)
        VALUES
            (:empresa_id, :cliente_id, :conteudo, :tipo, :lida, :ack, :timestamp, :msg_id, :instancia_id, :atendimento_id)
        ON CONFLICT (instancia_id, msg_id)
        DO NOTHING
        RETURNING id
        """
    )

    params = {
        "empresa_id": int(empresa_id),
        "cliente_id": int(cliente_id),
        "conteudo": conteudo,
        "tipo": tipo,
        "lida": bool(lida),
        "ack": ack,
        "timestamp": timestamp,
        "msg_id": str(msg_id),
        "instancia_id": int(instancia_id),
        "atendimento_id": atendimento_id,
    }

    for tentativa in range(3):
        try:
            row = db.execute(sql, params).fetchone()
            if row:
                return int(row[0]), True

            existente_id = find_existing_mensagem_11_id(
                db,
                empresa_id=empresa_id,
                cliente_id=cliente_id,
                msg_id=msg_id,
                instancia_id=instancia_id,
            )
            return existente_id, False

        except IntegrityError as e:
            try:
                db.rollback()
            except Exception:
                pass

            if is_duplicate_key_error(e):
                existente_id = find_existing_mensagem_11_id(
                    db,
                    empresa_id=empresa_id,
                    cliente_id=cliente_id,
                    msg_id=msg_id,
                    instancia_id=instancia_id,
                )
                _log_ctx(
                    "[UPsert][duplicate-tolerated]",
                    idx=idx,
                    msg_id=msg_id,
                    cliente_id=cliente_id,
                    existing_id=existente_id,
                    err=str(e),
                )
                return existente_id, False

            if is_statement_timeout_error(e) and tentativa < 2:
                _log_ctx(
                    "[UPsert][retry-timeout]",
                    idx=idx,
                    msg_id=msg_id,
                    tentativa=(tentativa + 1),
                    err=str(e),
                )
                await asyncio.sleep(0.15 * (tentativa + 1))
                continue
            raise

        except Exception as e:
            try:
                db.rollback()
            except Exception:
                pass

            if is_statement_timeout_error(e) and tentativa < 2:
                _log_ctx(
                    "[UPsert][retry-timeout]",
                    idx=idx,
                    msg_id=msg_id,
                    tentativa=(tentativa + 1),
                    err=str(e),
                )
                await asyncio.sleep(0.15 * (tentativa + 1))
                continue
            raise


def _is_textual_content(conteudo: Any) -> bool:
    return bool(str(conteudo or "").strip())


async def run_triagem_pos_commit(
    *,
    empresa_id: int,
    instancia_id: int,
    telefone: str,
    conteudo: str,
    direcao: str,
    remote_jid: str,
    message_ts: Any = None,
):
    if not conteudo or direcao != "entrada" or not _is_textual_content(conteudo):
        return

    skip_stale, age_seconds = _chatbot_should_skip_stale_inbound(message_ts=message_ts)
    if skip_stale:
        LOG(
            f"[CHATBOT][skip-stale] emp={empresa_id} inst={instancia_id} "
            f"telefone={telefone} age_s={int(age_seconds)} "
            f"max_s={CHATBOT_MAX_INBOUND_AGE_SECONDS}"
        )
        return

    with SessionLocal() as db_triagem:
        try:
            if callable(auto_messages_handle_inbound):
                auto_res = auto_messages_handle_inbound(
                    db_triagem,
                    empresa_id=empresa_id,
                    instancia_id=instancia_id,
                    telefone_digits=telefone,
                    texto=conteudo,
                    direction=direcao,
                    remote_jid=remote_jid,
                )
                LOG(f"[CHATBOT][auto_messages] res={auto_res}")

                auto_action = str((auto_res or {}).get("action") or "")
                if auto_action in {"sent_off_hours", "sent_welcome"}:
                    try:
                        db_triagem.commit()
                    except Exception:
                        try:
                            db_triagem.rollback()
                        except Exception:
                            pass
                    return

            triagem_res = triagem_handle_inbound(
                db_triagem,
                empresa_id=empresa_id,
                instancia_id=instancia_id,
                telefone_digits=telefone,
                texto=conteudo,
                direction=direcao,
                remote_jid=remote_jid,
            )
            try:
                db_triagem.commit()
            except Exception:
                try:
                    db_triagem.rollback()
                except Exception:
                    pass
            LOG(f"[CHATBOT][triagem] res={triagem_res}")
        except Exception as e:
            try:
                db_triagem.rollback()
            except Exception:
                pass
            LOG(f"[CHATBOT] erro ao processar inbound do chatbot: {e}")


async def save_media_pos_commit_11(
    *,
    inst_id: str,
    empresa_id: int,
    cli_id: int,
    msg_db_id: int,
    msg_id: str | None,
    media_meta: dict,
    instancia_db_id: int,
    idx: int,
):
    with SessionLocal() as db_media:
        try:
            ok = save_media_for_message_11_with_db(
                db_media,
                inst_id=inst_id,
                empresa_id=int(empresa_id),
                cliente_id=int(cli_id),
                mensagem_id=int(msg_db_id),
                msg_id=(str(msg_id) if msg_id else None),
                media_meta=media_meta,
                instancia_id=int(instancia_db_id),
                idx=idx,
            )
            if ok:
                db_media.commit()
            else:
                db_media.rollback()
        except Exception as e:
            try:
                db_media.rollback()
            except Exception:
                pass
            _log_ctx("[UPsert][midia] erro ao salvar", idx=idx, msg_id=msg_id, err=str(e))


def save_group_media_with_db(
    db: Session,
    *,
    inst_id: str,
    empresa_id: int,
    grupo_id: int,
    cliente_id: int | None,
    msg_id: str | None,
    media_meta: dict,
    instancia_db_id: int,
    idx: int = 0,
) -> bool:
    return save_media_for_group_message_with_db(
        db,
        inst_id=inst_id,
        empresa_id=int(empresa_id),
        grupo_id=int(grupo_id),
        cliente_id=(int(cliente_id) if cliente_id is not None else None),
        msg_id=(str(msg_id) if msg_id else None),
        media_meta=media_meta,
        instancia_id=int(instancia_db_id),
        idx=idx,
    )


def grupo_row_by_remote(
    db: Session,
    empresa_id: int,
    remote_jid: str,
    instancia_id: int | None = None,
    inst_obj: models.EmpresaInstancia | None = None,
) -> models.Grupo:
    return get_or_create_grupo_by_remote(
        db,
        empresa_id=int(empresa_id),
        remote_jid=jid_strip_device(remote_jid),
        instancia_id=(int(instancia_id) if instancia_id is not None else None),
        inst_obj=inst_obj,
        nome_padrao="Grupo",
    )


def name_from_contact_like(c: dict) -> str | None:
    for k in (
        "verifiedName",
        "name",
        "pushName",
        "notifyName",
        "formattedName",
        "shortName",
        "contactName",
        "subject",
        "title",
        "displayName",
    ):
        v = c.get(k)
        if isinstance(v, str) and v.strip():
            return v.strip()
    return None


def avatar_from_contact_like(c: dict) -> str | None:
    return (
        c.get("profilePicUrl")
        or (c.get("profilePicThumbObj") or {}).get("eurl")
        or c.get("thumbnailUrl")
        or c.get("imageUrl")
        or c.get("pictureUrl")
        or None
    )


def upsert_grupos_from_chats(db: Session, empresa_id: int, chats: list[dict], inst: models.EmpresaInstancia) -> int:
    return _repo_upsert_grupos_from_chats(
        db,
        empresa_id=int(empresa_id),
        chats=chats,
        inst=inst,
    )


__all__ = [
    "HANDLERS",
    "EvoEvent",
    "handler",
    "_carimbar_inst",
    "_get_inst_row",
    "_me_number_by_inst",
    "_fetch_cliente",
    "_get_cliente_departamento_id",
    "_get_cliente_operador_id",
    "_HAS_MSG_ATD_FIELD",
    "_get_or_open_atendimento",
    "_retry_deadlock",
    "_invalidate_emp_cache",

    "_lid_map_set",
    "_lid_map_get",
    "_resolve_remote_jid",
    "upsert_whatsapp_identity",
    "upsert_whatsapp_identities_from_contacts",
    "vincular_lids_por_nome_e_foto",
    "get_identity_by_remote",
    "resolve_lid_identity",
    "merge_lid_cliente_into_real_cliente",
    "normalize_contact_name",

    "upsert_cliente",
    "is_statement_timeout_error",
    "is_duplicate_key_error",
    "find_existing_mensagem_11_id",
    "insert_mensagem_11_with_retry",
    "run_triagem_pos_commit",
    "save_media_pos_commit_11",
    "save_group_media_with_db",
    "is_nome_grupo_ruim",
    "evo_get_group_subject",
    "grupo_row_by_remote",
    "name_from_contact_like",
    "avatar_from_contact_like",
    "upsert_grupos_from_chats",
    "_save_midia_db",
    "_b64_to_bytes",
    "normalize_mimetype",
    "remote_to_num",
    "formatar_telefone_br",
    "_resolve_counterparty_num_1to1",
    "jid_strip_device",
    "is_lid_jid",
    "_now_utc",
    "_server_ts_ms",
    "_iso_utc",
    "_int_unix",
]