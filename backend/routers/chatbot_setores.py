from __future__ import annotations

import asyncio
import hashlib
import os
import re
import unicodedata
from datetime import datetime, timezone, timedelta
from typing import Any, Dict, List, Optional, Tuple
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from sqlalchemy import and_, select, text
from sqlalchemy.orm import Session

import backend.models as models
from backend.database import get_db

from backend.routers.atendimento_send import _evo_post
from backend.utils.plans import (
    has_feature as plan_has_feature,
    is_billing_locked,
    effective_plan,
)
from backend.integrations.evolution.repositories.atendimentos_repo import (
    update_open_atendimento_departamento_repo,
)
from backend.services.atendimento_claim_state import (
    set_waiting_department,
)

router = APIRouter(prefix="/api", tags=["Chatbot (Triagem Setores)"])

TRIAGEM_TTL_HOURS = int(os.getenv("TRIAGEM_TTL_HOURS", "6"))
AUTO_MESSAGE_DEDUP_MINUTES = int(os.getenv("AUTO_MESSAGE_DEDUP_MINUTES", "60"))

# Enquanto a triagem está aguardando escolha, não reenvia o mesmo menu
# repetidamente para o cliente. Isso evita spam quando chegam mensagens repetidas
# ou quando algum backlog antigo tenta processar de novo.
CHATBOT_MENU_REPEAT_BLOCK_MINUTES = int(
    os.getenv("CHATBOT_MENU_REPEAT_BLOCK_MINUTES", str(max(60, TRIAGEM_TTL_HOURS * 60)))
)


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _as_aware_utc(dt: Optional[datetime]) -> Optional[datetime]:
    if dt is None:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _digits(s: str) -> str:
    return re.sub(r"\D", "", s or "")


def _norm_txt(s: str) -> str:
    s = (s or "").strip().lower()
    s = unicodedata.normalize("NFD", s)
    s = "".join(ch for ch in s if unicodedata.category(ch) != "Mn")
    return s


def _normalize_chatbot_config_aliases(cfg: Dict[str, Any]) -> Dict[str, Any]:
    """Aceita configs antigas salvas como auto_messages_filas."""
    if not isinstance(cfg, dict):
        return {}

    out: Dict[str, Any] = dict(cfg)
    features_in = out.get("features") or {}
    if not isinstance(features_in, dict):
        out["features"] = {}
        return out

    features = dict(features_in)
    old = features.get("auto_messages_filas")
    new = features.get("auto_messages_departments")
    if not isinstance(new, dict) and isinstance(old, dict):
        features["auto_messages_departments"] = old

    features.pop("auto_messages_filas", None)
    out["features"] = features
    return out


def _ensure_br_country(d: str) -> str:
    d = _digits(d)
    if len(d) == 11 and not d.startswith("55"):
        return "55" + d
    return d


def _remote_jid_from_payload(numero_digits: str, jid: str | None) -> str:
    jid = (jid or "").strip()
    if jid:
        return jid
    e164 = _ensure_br_country(numero_digits)
    return f"{e164}@s.whatsapp.net"


def _resolve_emp_inst_from_instance_name(db: Session, instance_name: str) -> Tuple[int, int]:
    row = db.execute(
        text(
            """
            SELECT id, empresa_id
            FROM empresas_instancias
            WHERE instance_name = :instance_name
            LIMIT 1
            """
        ),
        {"instance_name": instance_name},
    ).mappings().first()
    if not row:
        return 0, 0
    return int(row["id"]), int(row["empresa_id"])


def _get_empresa(db: Session, empresa_id: int) -> Optional[models.Empresa]:
    if not empresa_id:
        return None
    try:
        return db.get(models.Empresa, empresa_id)
    except Exception:
        return None


def _runtime_feature_allowed(
    db: Session,
    *,
    empresa_id: int,
    feature_key: str,
) -> Tuple[bool, str, Optional[str]]:
    emp = _get_empresa(db, empresa_id)
    if not emp:
        return False, "empresa_not_found", None

    plan_code = effective_plan(emp)

    if is_billing_locked(emp):
        return False, "billing_locked", plan_code

    if not plan_has_feature(emp, feature_key):
        return False, "feature_missing", plan_code

    return True, "ok", plan_code


def _find_cliente(
    db: Session, *, empresa_id: int, telefone_digits: str, instancia_id: Optional[int]
) -> Optional[models.Cliente]:
    tel = _digits(telefone_digits)
    cands = {tel}
    if tel.startswith("55") and len(tel) >= 12:
        cands.add(tel[2:])

    q = (
        db.query(models.Cliente)
        .filter(models.Cliente.empresa_id == empresa_id)
        .filter(models.Cliente.telefone_norm.in_(list(cands)))
    )
    rows = q.all()
    if not rows:
        return None

    if instancia_id:
        for r in rows:
            if r.instancia_id == instancia_id:
                return r
    return rows[0]


def _get_or_create_cliente(
    db: Session,
    *,
    empresa_id: int,
    instancia_id: int,
    telefone_digits: str,
) -> models.Cliente:
    cli = _find_cliente(db, empresa_id=empresa_id, telefone_digits=telefone_digits, instancia_id=instancia_id)
    if cli:
        if telefone_digits:
            cli.telefone = _ensure_br_country(telefone_digits)
        if instancia_id and (cli.instancia_id != instancia_id):
            cli.instancia_id = instancia_id
        return cli

    cli = models.Cliente(
        empresa_id=empresa_id,
        instancia_id=instancia_id,
        telefone=_ensure_br_country(telefone_digits) or telefone_digits,
        nome="Cliente",
    )
    db.add(cli)
    db.flush()
    return cli


def _fetch_empresa_instancia_info(db: Session, *, empresa_id: int, instancia_id: int) -> Tuple[str, str]:
    row = db.execute(
        text(
            """
            SELECT
              ei.instance_name AS instancia,
              e.nome AS empresa_nome
            FROM empresas_instancias ei
            JOIN empresas e ON e.id = ei.empresa_id
            WHERE ei.id = :instancia_id
              AND ei.empresa_id = :empresa_id
            LIMIT 1
            """
        ),
        {"empresa_id": empresa_id, "instancia_id": instancia_id},
    ).mappings().first()

    instancia = (row or {}).get("instancia") or ""
    empresa_nome = (row or {}).get("empresa_nome") or ""
    return str(instancia), str(empresa_nome)


def _fetch_chatbot_config(db: Session, *, empresa_id: int, instancia_id: int) -> Dict[str, Any]:
    row = db.execute(
        select(models.ChatbotConfig).where(
            and_(
                models.ChatbotConfig.empresa_id == empresa_id,
                models.ChatbotConfig.instancia_id == instancia_id,
                models.ChatbotConfig.ativo.is_(True),
            )
        )
    ).scalar_one_or_none()

    if not row:
        return {}

    cfg = row.config or {}
    return _normalize_chatbot_config_aliases(cfg if isinstance(cfg, dict) else {})


def _fetch_departamentos(db: Session, *, empresa_id: int, instancia_id: int) -> List[Dict[str, Any]]:
    # A tela de configuração permite selecionar qualquer departamento ativo
    # da empresa. O envio real do menu precisa aplicar a mesma regra; caso
    # contrário, o preview mostra departamentos que são removidos no runtime
    # apenas por não estarem em departamentos_instancias para esta instância.
    #
    # instancia_id permanece na assinatura para compatibilidade com as chamadas
    # existentes e para futuras regras, mas não limita a lista neste fluxo.
    rows = db.execute(
        text(
            """
            SELECT d.id, d.nome
            FROM departamentos d
            WHERE d.empresa_id = :empresa_id
              AND d.ativo IS TRUE
            ORDER BY d.nome ASC, d.id ASC
            """
        ),
        {"empresa_id": empresa_id},
    ).mappings().all()

    deps: List[Dict[str, Any]] = []
    for idx, r in enumerate(rows, start=1):
        deps.append(
            {
                "idx": idx,
                "id": int(r["id"]),
                "nome": str(r["nome"] or "").strip(),
            }
        )
    return deps


def _get_triage_cfg_parts(cfg: Dict[str, Any]) -> Tuple[Dict[str, Any], Dict[str, Any], Dict[str, Any]]:
    features = cfg.get("features") or {}
    ad = features.get("auto_messages_departments") or {}
    welcome = ad.get("welcome") or {}
    items = ad.get("items") or {}
    if not isinstance(ad, dict):
        ad = {}
    if not isinstance(welcome, dict):
        welcome = {}
    if not isinstance(items, dict):
        items = {}
    return ad, welcome, items


def _get_auto_cfg_parts(cfg: Dict[str, Any]) -> Tuple[Dict[str, Any], Dict[str, Any], Dict[str, Any]]:
    features = cfg.get("features") or {}
    auto = features.get("auto_messages") or {}
    welcome = auto.get("welcome") or {}
    off_hours = auto.get("off_hours") or {}
    if not isinstance(auto, dict):
        auto = {}
    if not isinstance(welcome, dict):
        welcome = {}
    if not isinstance(off_hours, dict):
        off_hours = {}
    return auto, welcome, off_hours


def _triage_mode_is_active(cfg: Dict[str, Any]) -> bool:
    ad_cfg, welcome_cfg, _ = _get_triage_cfg_parts(cfg)
    return bool(ad_cfg.get("enabled", False)) and bool(welcome_cfg.get("enabled", False))


def _lock_chatbot_instance(db: Session, *, empresa_id: int, instancia_id: int) -> None:
    """Evita corrida entre um disparo e o desligamento do botão geral."""
    db.execute(
        text("SELECT pg_advisory_xact_lock(:empresa_id, :instancia_id)"),
        {"empresa_id": int(empresa_id), "instancia_id": int(instancia_id)},
    )


def _fetch_triage_departamentos(
    db: Session,
    *,
    empresa_id: int,
    instancia_id: int,
    cfg: Dict[str, Any],
) -> List[Dict[str, Any]]:
    deps_raw = _fetch_departamentos(db, empresa_id=empresa_id, instancia_id=instancia_id)
    _, _, items_cfg = _get_triage_cfg_parts(cfg)

    if not items_cfg:
        deps: List[Dict[str, Any]] = []
        for idx, d in enumerate(deps_raw, start=1):
            deps.append(
                {
                    "idx": idx,
                    "id": int(d["id"]),
                    "nome": str(d["nome"] or "").strip(),
                    "label": str(d["nome"] or "").strip(),
                    "keywords": [],
                    "text": "",
                }
            )
        return deps

    deps: List[Dict[str, Any]] = []
    for d in deps_raw:
        did = str(d["id"])
        item = items_cfg.get(did) or {}
        if not isinstance(item, dict):
            item = {}

        enabled = bool(item.get("enabled", False))
        if not enabled:
            continue

        label = str(item.get("label") or d["nome"] or "").strip()
        text_msg = str(item.get("text") or "").strip()

        kws_raw = item.get("keywords") or []
        if isinstance(kws_raw, list):
            keywords = [str(x).strip() for x in kws_raw if str(x).strip()]
        elif isinstance(kws_raw, str):
            keywords = [s.strip() for s in kws_raw.split(",") if s.strip()]
        else:
            keywords = []

        deps.append(
            {
                "id": int(d["id"]),
                "nome": str(d["nome"] or "").strip(),
                "label": label or str(d["nome"] or "").strip(),
                "keywords": keywords,
                "text": text_msg,
            }
        )

    for idx, d in enumerate(deps, start=1):
        d["idx"] = idx

    return deps


def _parse_departamento_choice(
    texto: str, deps: List[Dict[str, Any]]
) -> Tuple[Optional[int], Optional[int], Optional[str], Optional[Dict[str, Any]]]:
    t = _norm_txt(texto)
    if not t:
        return None, None, None, None

    m = re.fullmatch(r"dep:(\d+)", t)
    if m:
        dep_id = int(m.group(1))
        dep = next((d for d in deps if d["id"] == dep_id), None)
        return dep_id, (dep["idx"] if dep else None), (dep["label"] if dep else None), dep

    m = re.match(r"^(\d{1,2})\b", t)
    if m:
        opt = int(m.group(1))
        dep = next((d for d in deps if d["idx"] == opt), None)
        if dep:
            return int(dep["id"]), int(dep["idx"]), str(dep["label"]), dep

    if len(t) >= 2:
        for d in deps:
            aliases = [str(d.get("label") or ""), str(d.get("nome") or "")]
            aliases.extend(d.get("keywords") or [])
            aliases_norm = [_norm_txt(x) for x in aliases if str(x).strip()]

            for alias in aliases_norm:
                if not alias:
                    continue
                if alias == t:
                    return int(d["id"]), int(d["idx"]), str(d["label"]), d
                if re.search(rf"\b{re.escape(alias)}\b", t):
                    return int(d["id"]), int(d["idx"]), str(d["label"]), d

    return None, None, None, None


def _fetch_primary_colab_id(db: Session, *, empresa_id: int, departamento_id: int) -> Optional[int]:
    row = db.execute(
        text(
            """
            SELECT colaborador_id
            FROM departamentos_membros
            WHERE empresa_id = :empresa_id
              AND departamento_id = :departamento_id
              AND is_primary IS TRUE
            LIMIT 1
            """
        ),
        {"empresa_id": empresa_id, "departamento_id": departamento_id},
    ).mappings().first()
    if not row:
        return None
    try:
        return int(row["colaborador_id"])
    except Exception:
        return None


def _evolution_send_number(*, remote_jid: str, telefone_digits: str = "") -> str:
    """Monta o destino aceito pelo endpoint /message/sendText da Evolution.

    Para conversas individuais, o campo ``number`` deve receber somente o
    telefone com DDI, sem o sufixo ``@s.whatsapp.net``. Sempre que disponível,
    prioriza o telefone original do cliente porque o JID canônico do WhatsApp
    pode remover o nono dígito de números brasileiros.
    """
    jid = str(remote_jid or "").strip()

    # Grupos continuam usando o identificador completo.
    if jid.endswith("@g.us"):
        return jid

    numero = _ensure_br_country(telefone_digits)
    if numero:
        return numero

    numero_jid = jid.split("@", 1)[0].split(":", 1)[0]
    return _ensure_br_country(numero_jid)


def _send_text(
    db: Session,
    *,
    instancia_nome: str,
    remote_jid: str,
    text_msg: str,
    telefone_digits: str = "",
) -> Optional[Dict[str, Any]]:
    if not instancia_nome or not text_msg:
        return None

    destino = _evolution_send_number(
        remote_jid=remote_jid,
        telefone_digits=telefone_digits,
    )
    if not destino:
        return None

    payload = {
        "number": destino,
        "text": text_msg,
    }

    return _evo_post("/message/sendText", instancia_nome, payload)


def _evo_message_id(evo: Optional[Dict[str, Any]]) -> Optional[str]:
    try:
        mid = ((evo or {}).get("key") or {}).get("id")
        mid = str(mid or "").strip()
        return mid or None
    except Exception:
        return None


def _evo_timestamp_dt(evo: Optional[Dict[str, Any]], fallback: Optional[datetime] = None) -> datetime:
    raw = None
    try:
        raw = (evo or {}).get("messageTimestamp")
    except Exception:
        raw = None

    try:
        if isinstance(raw, dict):
            raw = raw.get("low") or raw.get("seconds") or raw.get("value")
        if raw is not None and str(raw).strip():
            return datetime.fromtimestamp(int(raw), tz=timezone.utc)
    except Exception:
        pass

    return _as_aware_utc(fallback) or _now_utc()


def _bot_msg_id(*, empresa_id: int, instancia_id: int, cliente_id: int, text_msg: str, ts_dt: datetime) -> str:
    base = f"{int(empresa_id)}:{int(instancia_id)}:{int(cliente_id)}:{ts_dt.timestamp()}:{text_msg}"
    safe = hashlib.sha1(base.encode("utf-8", errors="ignore")).hexdigest()[:24]
    return f"bot:{int(instancia_id)}:{int(cliente_id)}:{safe}"


def _latest_open_atendimento_id(
    db: Session,
    *,
    empresa_id: int,
    instancia_id: int,
    cliente_id: int,
) -> Optional[int]:
    Atendimento = getattr(models, "Atendimento", None)
    if Atendimento is None:
        return None

    try:
        q = db.query(Atendimento.id).filter(
            Atendimento.empresa_id == int(empresa_id),
            Atendimento.cliente_id == int(cliente_id),
        )
        if hasattr(Atendimento, "instancia_id"):
            q = q.filter(Atendimento.instancia_id == int(instancia_id))
        if hasattr(Atendimento, "status"):
            try:
                q = q.filter(Atendimento.status.in_(_open_status_values()))
            except Exception:
                pass
        row = q.order_by(Atendimento.id.desc()).first()
        return int(row.id) if row and row.id is not None else None
    except Exception:
        return None


def _persist_bot_saida_message(
    db: Session,
    *,
    empresa_id: int,
    instancia_id: int,
    cliente_id: int,
    text_msg: str,
    evo: Optional[Dict[str, Any]] = None,
    ts_dt: Optional[datetime] = None,
) -> Optional[models.Mensagem]:
    """Salva mensagem automática do chatbot no histórico do atendimento.

    Sem isso o cliente recebe o menu/ack no WhatsApp, mas o operador não vê
    a mensagem dentro do ZapsChat. Mensagens do bot ficam como saída, sem
    colaborador_id, e com msg_id prefixado quando a Evolution não retornar id.
    """
    if not empresa_id or not instancia_id or not cliente_id or not str(text_msg or "").strip():
        return None

    try:
        ts = _evo_timestamp_dt(evo, fallback=ts_dt)
        msg_id = _evo_message_id(evo) or _bot_msg_id(
            empresa_id=int(empresa_id),
            instancia_id=int(instancia_id),
            cliente_id=int(cliente_id),
            text_msg=str(text_msg),
            ts_dt=ts,
        )

        existing = None
        if msg_id:
            existing = (
                db.query(models.Mensagem)
                .filter(
                    models.Mensagem.empresa_id == int(empresa_id),
                    models.Mensagem.cliente_id == int(cliente_id),
                    models.Mensagem.msg_id == str(msg_id),
                )
                .first()
            )

        atendimento_id = _latest_open_atendimento_id(
            db,
            empresa_id=int(empresa_id),
            instancia_id=int(instancia_id),
            cliente_id=int(cliente_id),
        )

        if existing is not None:
            existing.conteudo = str(text_msg)
            existing.tipo = "saida"
            existing.ack = int(existing.ack or 1)
            existing.lida = True
            existing.instancia_id = int(instancia_id)
            if atendimento_id and hasattr(existing, "atendimento_id"):
                existing.atendimento_id = int(atendimento_id)
            db.add(existing)
            db.commit()
            return existing

        msg = models.Mensagem(
            empresa_id=int(empresa_id),
            cliente_id=int(cliente_id),
            instancia_id=int(instancia_id),
            atendimento_id=atendimento_id,
            colaborador_id=None,
            conteudo=str(text_msg),
            tipo="saida",
            lida=True,
            timestamp=ts,
            msg_id=str(msg_id) if msg_id else None,
            ack=1,
        )
        db.add(msg)
        db.commit()
        return msg
    except Exception as exc:
        try:
            print("[CHATBOT][persist-bot-msg][erro]", repr(exc))
        except Exception:
            pass
        try:
            db.rollback()
        except Exception:
            pass
        return None


def _recent_bot_menu_sent(
    db: Session,
    *,
    empresa_id: int,
    instancia_id: int,
    cliente_id: int,
    now: Optional[datetime] = None,
    block_minutes: Optional[int] = None,
) -> bool:
    """Retorna True se o menu da triagem já foi enviado recentemente.

    O menu automático tem que aparecer no histórico, mas não pode ser disparado
    várias vezes para o cliente quando o servidor volta e recebe backlog/replay.
    """
    try:
        minutes = int(block_minutes if block_minutes is not None else CHATBOT_MENU_REPEAT_BLOCK_MINUTES)
    except Exception:
        minutes = CHATBOT_MENU_REPEAT_BLOCK_MINUTES

    if minutes <= 0:
        return False

    try:
        since = (_as_aware_utc(now) or _now_utc()) - timedelta(minutes=minutes)
        q = (
            db.query(models.Mensagem.id)
            .filter(
                models.Mensagem.empresa_id == int(empresa_id),
                models.Mensagem.cliente_id == int(cliente_id),
                models.Mensagem.instancia_id == int(instancia_id),
                models.Mensagem.tipo == "saida",
                models.Mensagem.timestamp >= since,
                models.Mensagem.conteudo.ilike("%Digite apenas o número da opção desejada%"),
            )
        )

        if hasattr(models.Mensagem, "colaborador_id"):
            q = q.filter(models.Mensagem.colaborador_id.is_(None))

        return q.order_by(models.Mensagem.id.desc()).first() is not None
    except Exception:
        return False


def _send_and_persist_bot_message(
    db: Session,
    *,
    empresa_id: int,
    instancia_id: int,
    cliente_id: int,
    instancia_nome: str,
    remote_jid: str,
    text_msg: str,
    telefone_digits: str = "",
    ts_dt: Optional[datetime] = None,
) -> Optional[Dict[str, Any]]:
    evo = _send_text(
        db,
        instancia_nome=instancia_nome,
        remote_jid=remote_jid,
        text_msg=text_msg,
        telefone_digits=telefone_digits,
    )

    # Se algum helper anterior deixou a sessão em estado abortado, limpa antes
    # de salvar o registro da mensagem do Bot. As chamadas atuais chegam aqui
    # depois de commit, então esse rollback não desfaz dados bons.
    try:
        if hasattr(db, "is_active") and not db.is_active:
            db.rollback()
    except Exception:
        try:
            db.rollback()
        except Exception:
            pass

    _persist_bot_saida_message(
        db,
        empresa_id=int(empresa_id),
        instancia_id=int(instancia_id),
        cliente_id=int(cliente_id),
        text_msg=text_msg,
        evo=evo,
        ts_dt=ts_dt,
    )
    return evo


def _send_and_persist_triage_message(
    db: Session,
    *,
    empresa_id: int,
    instancia_id: int,
    cliente_id: int,
    instancia_nome: str,
    remote_jid: str,
    text_msg: str,
    telefone_digits: str = "",
    ts_dt: Optional[datetime] = None,
) -> Optional[Dict[str, Any]]:
    """Última barreira antes de qualquer mensagem do menu por departamentos.

    A trava é compartilhada com o PUT da configuração. Se o usuário desligar
    o botão geral, o backend conclui o desligamento antes de permitir outro
    disparo; depois a configuração é relida e o envio é barrado.
    """
    _lock_chatbot_instance(
        db,
        empresa_id=int(empresa_id),
        instancia_id=int(instancia_id),
    )

    cfg_now = _fetch_chatbot_config(
        db,
        empresa_id=int(empresa_id),
        instancia_id=int(instancia_id),
    )

    if not _triage_mode_is_active(cfg_now):
        # Libera imediatamente a trava da transação sem enviar nem persistir.
        db.commit()
        return None

    return _send_and_persist_bot_message(
        db,
        empresa_id=int(empresa_id),
        instancia_id=int(instancia_id),
        cliente_id=int(cliente_id),
        instancia_nome=instancia_nome,
        remote_jid=remote_jid,
        text_msg=text_msg,
        telefone_digits=telefone_digits,
        ts_dt=ts_dt,
    )


def _replace_tokens(template: str, *, empresa_nome: str, menu_departamentos: str) -> str:
    text_msg = str(template or "").strip()

    if not text_msg:
        text_msg = (
            "Olá! 👋\n"
            "Bem-vindo(a) à {empresa}.\n\n"
            "Para direcionar seu atendimento, escolha uma opção abaixo:\n\n"
            "{menu_departamentos}\n\n"
            "Digite apenas o número da opção desejada."
        )

    text_msg = re.sub(r"\{empresa\}", empresa_nome or "empresa", text_msg, flags=re.I)
    text_msg = re.sub(r"\{menu_departamentos\}", menu_departamentos, text_msg, flags=re.I)
    return text_msg


def _replace_auto_tokens(template: str, *, empresa_nome: str) -> str:
    text_msg = str(template or "").strip()
    if not text_msg:
        text_msg = "Olá! 👋 Como posso ajudar?"
    text_msg = re.sub(r"\{empresa\}", empresa_nome or "empresa", text_msg, flags=re.I)
    return text_msg


def _clean_menu_label(s: str) -> str:
    s = str(s or "").strip()
    s = re.sub(r"^\s*\d+\s*[-–—.)]\s*", "", s)
    return s.strip()


def _build_menu_message(
    *,
    empresa_nome: str,
    deps: List[Dict[str, Any]],
    cfg: Dict[str, Any],
) -> str:
    _, welcome_cfg, _ = _get_triage_cfg_parts(cfg)
    template = str(welcome_cfg.get("text") or "").strip()
    linhas = "\n".join([f'{d["idx"]} - {_clean_menu_label(d["label"])}' for d in deps])
    return _replace_tokens(template, empresa_nome=empresa_nome or "empresa", menu_departamentos=linhas)


def _build_invalid_choice_message(
    *,
    empresa_nome: str,
    deps: List[Dict[str, Any]],
    cfg: Dict[str, Any],
) -> str:
    base = _build_menu_message(empresa_nome=empresa_nome, deps=deps, cfg=cfg)
    return f"Não entendi sua opção.\n\n{base}"


def _build_fallback_message(
    *,
    empresa_nome: str,
    cfg: Dict[str, Any],
) -> str:
    ad, _, _ = _get_triage_cfg_parts(cfg)
    fallback_text = str(ad.get("fallback_text") or "").strip()
    if fallback_text:
        return re.sub(r"\{empresa\}", empresa_nome or "empresa", fallback_text, flags=re.I)

    return (
        f"Não consegui identificar a opção desejada na triagem da *{empresa_nome or 'empresa'}*.\n"
        "Vou encaminhar sua mensagem para atendimento manual. 🙂"
    )


def _build_assign_ack(
    *,
    empresa_nome: str,
    dep: Optional[Dict[str, Any]],
) -> str:
    if dep:
        custom = str(dep.get("text") or "").strip()
        setor_nome = _clean_menu_label(str(dep.get("label") or dep.get("nome") or "").strip())

        if custom:
            custom = re.sub(r"\{empresa\}", empresa_nome or "empresa", custom, flags=re.I)
            custom = re.sub(r"\{setor\}", setor_nome, custom, flags=re.I)
            return custom

        if setor_nome:
            return f"Perfeito! Vou te encaminhar para *{setor_nome}*. Só um instante 🙂"

    return "Perfeito! Só um instante 🙂"


def _safe_zoneinfo(name: str | None):
    try:
        return ZoneInfo(str(name or "").strip() or "America/Sao_Paulo")
    except Exception:
        return timezone.utc


def _parse_hhmm(s: str, default: str) -> Tuple[int, int]:
    raw = str(s or default).strip()
    m = re.fullmatch(r"(\d{2}):(\d{2})", raw)
    if not m:
        raw = default
        m = re.fullmatch(r"(\d{2}):(\d{2})", raw)
    if not m:
        return 8, 0
    hh = max(0, min(23, int(m.group(1))))
    mm = max(0, min(59, int(m.group(2))))
    return hh, mm


def _minutes_of_day(dt: datetime) -> int:
    return dt.hour * 60 + dt.minute


def _window_contains(now_local: datetime, start_hhmm: str, end_hhmm: str) -> bool:
    sh, sm = _parse_hhmm(start_hhmm, "08:00")
    eh, em = _parse_hhmm(end_hhmm, "18:00")

    start_min = sh * 60 + sm
    end_min = eh * 60 + em
    now_min = _minutes_of_day(now_local)

    if start_min == end_min:
        return True

    if start_min < end_min:
        return start_min <= now_min < end_min

    return now_min >= start_min or now_min < end_min


def _fetch_last_conversation_message_time(
    db: Session,
    *,
    empresa_id: int,
    cliente_id: int,
    instancia_id: int,
) -> Optional[datetime]:
    row = db.execute(
        text(
            """
            SELECT timestamp
            FROM mensagens
            WHERE empresa_id = :empresa_id
              AND cliente_id = :cliente_id
              AND instancia_id = :instancia_id
            ORDER BY timestamp DESC
            LIMIT 2
            """
        ),
        {
            "empresa_id": empresa_id,
            "cliente_id": cliente_id,
            "instancia_id": instancia_id,
        },
    ).mappings().all()

    if not row:
        return None

    if len(row) >= 2:
        return _as_aware_utc(row[1].get("timestamp"))

    return None


def _sync_open_atendimento_departamento(
    db: Session,
    *,
    empresa_id: int,
    instancia_id: int,
    cliente_id: int,
    departamento_id: int | None,
    ts_dt: datetime | None,
    operador_id: int | None = None,
    status_aguardando: bool = False,
    clear_operador: bool = False,
    clear_participantes: bool = False,
) -> None:
    try:
        update_open_atendimento_departamento_repo(
            db,
            empresa_id=int(empresa_id),
            instancia_id=int(instancia_id),
            cliente_id=int(cliente_id),
            departamento_id=departamento_id,
            ts_dt=ts_dt,
            operador_id=operador_id,
            status_aguardando=status_aguardando,
            clear_operador=clear_operador,
            clear_participantes=clear_participantes,
        )
    except Exception as exc:
        # Importante: se uma query falhar no Postgres, a transação fica abortada.
        # Sem rollback, a próxima tentativa de salvar a mensagem do Bot também falha
        # com "current transaction is aborted".
        try:
            print("[CHATBOT][sync-atendimento][erro]", repr(exc))
        except Exception:
            pass
        try:
            db.rollback()
        except Exception:
            pass
        return


def _status_aguardando_value():
    status_enum = getattr(models, "StatusAtendimento", None)
    if status_enum is not None and hasattr(status_enum, "AGUARDANDO"):
        try:
            return status_enum.AGUARDANDO
        except Exception:
            pass
    return "aguardando"


def _status_novo_value():
    status_enum = getattr(models, "StatusAtendimento", None)
    if status_enum is not None and hasattr(status_enum, "NOVO"):
        try:
            return status_enum.NOVO
        except Exception:
            pass
    return "novo"


def _open_status_values() -> list[Any]:
    status_enum = getattr(models, "StatusAtendimento", None)
    vals: list[Any] = []

    # Se o model usa Enum nativo do Postgres, NÃO misture strings inválidas
    # como "aberto"/"pendente" na cláusula IN. Isso quebra a transação e,
    # em seguida, impede salvar a mensagem automática do Bot no histórico.
    if status_enum is not None:
        for attr in ("NOVO", "AGUARDANDO", "EM_ATENDIMENTO", "PAUSADO"):
            if hasattr(status_enum, attr):
                try:
                    vals.append(getattr(status_enum, attr))
                except Exception:
                    pass
        if vals:
            return vals

    return ["novo", "aguardando", "em_atendimento", "pausado"]


def _clear_active_participants_safe(db: Session, *, empresa_id: int, atendimento_id: int) -> None:
    """Compatibilidade: usa somente as colunas reais do modelo atual."""
    AP = getattr(models, "AtendimentoParticipante", None)
    if AP is None:
        return

    try:
        now = _now_utc()
        rows = (
            db.query(AP)
            .filter(
                AP.empresa_id == int(empresa_id),
                AP.atendimento_id == int(atendimento_id),
                AP.is_ativo.is_(True),
            )
            .with_for_update()
            .all()
        )
        for row in rows:
            row.is_ativo = False
            row.role = "participant"
            row.saiu_em = now
            row.atualizado_em = now
            db.add(row)
        db.flush()
    except Exception as exc:
        try:
            print("[CHATBOT][triagem][participantes-skip]", repr(exc))
        except Exception:
            pass


def _schedule_reload_clientes(empresa_id: int) -> None:
    """Agenda uma atualização da lista sem bloquear o processamento do chatbot."""
    try:
        from backend.integrations.evolution.transport.websocket_emitters import (
            emit_reload_clientes,
        )

        loop = asyncio.get_running_loop()
        loop.create_task(emit_reload_clientes(int(empresa_id)))
    except RuntimeError:
        # O webhook legado também pode chamar este fluxo fora de um event loop.
        # Nesse cenário, a próxima consulta da tela ainda encontra o banco correto.
        return
    except Exception as exc:
        try:
            print("[CHATBOT][triagem][reload-clientes][erro]", repr(exc))
        except Exception:
            pass


def _ensure_waiting_atendimento_for_triage(
    db: Session,
    *,
    empresa_id: int,
    instancia_id: int,
    cliente_id: int,
    departamento_id: int,
    ts_dt: datetime | None,
) -> Any | None:
    """Cria/atualiza o atendimento no estado aguardando sem responsável."""
    try:
        return set_waiting_department(
            db,
            empresa_id=int(empresa_id),
            cliente_id=int(cliente_id),
            instancia_id=int(instancia_id),
            departamento_id=int(departamento_id),
            ts_dt=ts_dt,
        )
    except Exception as exc:
        try:
            print("[CHATBOT][triagem][persist-atendimento][erro]", repr(exc))
        except Exception:
            pass
        try:
            db.rollback()
        except Exception:
            pass
        return None


def _commit_cliente_departamento_triagem(
    db: Session,
    *,
    cliente: models.Cliente,
    departamento_id: int,
    now: datetime,
) -> None:
    """Grava a escolha do departamento antes de qualquer helper legado poder dar rollback."""
    cliente.departamento_id = int(departamento_id)
    cliente.colaborador_id = None
    cliente.triagem_ativa = False
    cliente.triagem_tentativas = int(cliente.triagem_tentativas or 0) + 1
    cliente.triagem_ultima_msg_em = now
    db.add(cliente)
    db.flush()
    db.commit()


def auto_messages_handle_inbound(
    db: Session,
    *,
    empresa_id: int,
    instancia_id: int,
    telefone_digits: str,
    texto: str,
    direction: str = "",
    remote_jid: str = "",
) -> Dict[str, Any]:
    if (direction or "").lower() == "saida":
        return {"ok": True, "action": "ignore_saida"}

    telefone_digits = _digits(telefone_digits)
    texto = (texto or "").strip()

    if not empresa_id or not instancia_id or not telefone_digits or not texto:
        return {"ok": True, "action": "noop_invalid"}

    allowed, reason, plan_code = _runtime_feature_allowed(
        db,
        empresa_id=empresa_id,
        feature_key="feature_automation",
    )
    if not allowed:
        return {
            "ok": True,
            "action": "noop_automation_blocked",
            "reason": reason,
            "plan": plan_code,
            "feature": "feature_automation",
        }

    instancia_nome, empresa_nome = _fetch_empresa_instancia_info(
        db, empresa_id=empresa_id, instancia_id=instancia_id
    )
    cfg = _fetch_chatbot_config(db, empresa_id=empresa_id, instancia_id=instancia_id)
    auto_cfg, welcome_cfg, off_cfg = _get_auto_cfg_parts(cfg)

    if _triage_mode_is_active(cfg):
        return {
            "ok": True,
            "action": "noop_auto_skipped_by_triage",
        }

    if not bool(auto_cfg.get("enabled", False)):
        return {"ok": True, "action": "noop_auto_disabled"}

    cliente = _get_or_create_cliente(
        db,
        empresa_id=empresa_id,
        instancia_id=instancia_id,
        telefone_digits=telefone_digits,
    )

    last_conversation_msg = _fetch_last_conversation_message_time(
        db,
        empresa_id=empresa_id,
        cliente_id=int(cliente.id),
        instancia_id=instancia_id,
    )
    if last_conversation_msg:
        delta = _now_utc() - last_conversation_msg
        if delta <= timedelta(minutes=max(1, AUTO_MESSAGE_DEDUP_MINUTES)):
            return {
                "ok": True,
                "action": "noop_recent_conversation",
                "dedup_minutes": int(AUTO_MESSAGE_DEDUP_MINUTES),
            }

    tz_name = str(cfg.get("timezone") or "America/Sao_Paulo").strip() or "America/Sao_Paulo"
    tz = _safe_zoneinfo(tz_name)
    now_local = _now_utc().astimezone(tz)

    welcome_enabled = bool(welcome_cfg.get("enabled", False))
    off_enabled = bool(off_cfg.get("enabled", False))

    welcome_start = str(welcome_cfg.get("start") or "08:00")
    welcome_end = str(welcome_cfg.get("end") or "18:00")
    off_start = str(off_cfg.get("start") or "18:00")
    off_end = str(off_cfg.get("end") or "08:00")

    welcome_in_window = _window_contains(now_local, welcome_start, welcome_end) if welcome_enabled else False
    off_in_window = _window_contains(now_local, off_start, off_end) if off_enabled else False

    if welcome_enabled and welcome_in_window:
        text_msg = _replace_auto_tokens(str(welcome_cfg.get("text") or "").strip(), empresa_nome=empresa_nome)
        db.commit()
        _send_and_persist_bot_message(
            db,
            empresa_id=empresa_id,
            instancia_id=instancia_id,
            cliente_id=int(cliente.id),
            instancia_nome=instancia_nome,
            remote_jid=remote_jid,
            telefone_digits=telefone_digits,
            text_msg=text_msg,
            ts_dt=_now_utc(),
        )
        return {
            "ok": True,
            "action": "sent_welcome",
            "timezone": tz_name,
            "now_local": now_local.isoformat(),
        }

    if off_enabled and off_in_window:
        text_msg = _replace_auto_tokens(str(off_cfg.get("text") or "").strip(), empresa_nome=empresa_nome)
        db.commit()
        _send_and_persist_bot_message(
            db,
            empresa_id=empresa_id,
            instancia_id=instancia_id,
            cliente_id=int(cliente.id),
            instancia_nome=instancia_nome,
            remote_jid=remote_jid,
            telefone_digits=telefone_digits,
            text_msg=text_msg,
            ts_dt=_now_utc(),
        )
        return {
            "ok": True,
            "action": "sent_off_hours",
            "timezone": tz_name,
            "now_local": now_local.isoformat(),
        }

    return {
        "ok": True,
        "action": "noop_outside_window",
        "timezone": tz_name,
        "now_local": now_local.isoformat(),
        "welcome_enabled": welcome_enabled,
        "welcome_in_window": welcome_in_window,
        "off_enabled": off_enabled,
        "off_in_window": off_in_window,
    }


def triagem_handle_inbound(
    db: Session,
    *,
    empresa_id: int,
    instancia_id: int,
    telefone_digits: str,
    texto: str,
    direction: str = "",
    remote_jid: str = "",
    ttl_hours: int = TRIAGEM_TTL_HOURS,
) -> Dict[str, Any]:
    if (direction or "").lower() == "saida":
        return {"ok": True, "action": "ignore_saida"}

    telefone_digits = _digits(telefone_digits)
    texto = (texto or "").strip()

    if not empresa_id or not instancia_id or not telefone_digits or not texto:
        return {"ok": True, "action": "noop_invalid"}

    allowed, reason, plan_code = _runtime_feature_allowed(
        db,
        empresa_id=empresa_id,
        feature_key="feature_advanced_automation",
    )
    if not allowed:
        return {
            "ok": True,
            "action": "noop_triage_blocked",
            "reason": reason,
            "plan": plan_code,
            "feature": "feature_advanced_automation",
        }

    instancia_nome, empresa_nome = _fetch_empresa_instancia_info(
        db, empresa_id=empresa_id, instancia_id=instancia_id
    )
    cfg = _fetch_chatbot_config(db, empresa_id=empresa_id, instancia_id=instancia_id)
    ad_cfg, welcome_cfg, _ = _get_triage_cfg_parts(cfg)

    if not bool(ad_cfg.get("enabled", False)):
        return {"ok": True, "action": "noop_triagem_disabled"}

    if not bool(welcome_cfg.get("enabled", False)):
        return {"ok": True, "action": "noop_triagem_welcome_disabled"}

    cliente = _get_or_create_cliente(
        db,
        empresa_id=empresa_id,
        instancia_id=instancia_id,
        telefone_digits=telefone_digits,
    )

    now = _now_utc()
    ttl = timedelta(hours=max(1, int(ttl_hours)))
    ttl_expired = False

    last = _as_aware_utc(cliente.triagem_ultima_msg_em)
    if last and (now - last) > ttl:
        cliente.departamento_id = None
        cliente.colaborador_id = None
        cliente.triagem_ativa = True
        cliente.triagem_tentativas = 0
        cliente.triagem_iniciada_em = now
        ttl_expired = True

    cliente.triagem_ultima_msg_em = now

    needs_triage = (cliente.departamento_id is None) or bool(cliente.triagem_ativa)
    if not needs_triage:
        _sync_open_atendimento_departamento(
            db,
            empresa_id=empresa_id,
            instancia_id=instancia_id,
            cliente_id=int(cliente.id),
            departamento_id=int(cliente.departamento_id) if cliente.departamento_id is not None else None,
            ts_dt=now,
            operador_id=None,
        )
        db.commit()
        return {"ok": True, "action": "noop_has_departamento"}

    if not cliente.triagem_iniciada_em:
        cliente.triagem_iniciada_em = now

    deps = _fetch_triage_departamentos(db, empresa_id=empresa_id, instancia_id=instancia_id, cfg=cfg)
    if not deps:
        cliente.triagem_ativa = False
        _sync_open_atendimento_departamento(
            db,
            empresa_id=empresa_id,
            instancia_id=instancia_id,
            cliente_id=int(cliente.id),
            departamento_id=None,
            ts_dt=now,
            operador_id=None,
            clear_operador=True,
            clear_participantes=True,
        )
        db.commit()
        return {"ok": True, "action": "noop_no_deps_enabled"}

    if ttl_expired:
        cliente.triagem_ativa = True
        cliente.triagem_tentativas = 1

        _sync_open_atendimento_departamento(
            db,
            empresa_id=empresa_id,
            instancia_id=instancia_id,
            cliente_id=int(cliente.id),
            departamento_id=None,
            ts_dt=now,
            operador_id=None,
            clear_operador=True,
            clear_participantes=True,
        )

        if _recent_bot_menu_sent(
            db,
            empresa_id=empresa_id,
            instancia_id=instancia_id,
            cliente_id=int(cliente.id),
            now=now,
        ):
            db.commit()
            return {
                "ok": True,
                "action": "noop_menu_already_sent",
                "reason": "recent_menu_block",
                "attempts": int(cliente.triagem_tentativas or 0),
            }

        menu = _build_menu_message(empresa_nome=empresa_nome, deps=deps, cfg=cfg)
        db.commit()

        _send_and_persist_triage_message(
            db,
            empresa_id=empresa_id,
            instancia_id=instancia_id,
            cliente_id=int(cliente.id),
            instancia_nome=instancia_nome,
            remote_jid=remote_jid,
            telefone_digits=telefone_digits,
            text_msg=menu,
            ts_dt=now,
        )
        return {
            "ok": True,
            "action": "send_menu_ttl_reset",
            "options": len(deps),
            "attempts": int(cliente.triagem_tentativas or 0),
        }

    dep_id, dep_idx, dep_nome, dep_obj = _parse_departamento_choice(texto, deps)

    if dep_id:
        # 1) Grava o departamento no cliente primeiro e já commita.
        # Isso é o que a lista lateral usa como fallback: COALESCE(atendimento.departamento_id, cliente.departamento_id).
        # Antes, um rollback interno do helper legado podia desfazer essa alteração e a Amanda ficava sem ver nada.
        _commit_cliente_departamento_triagem(
            db,
            cliente=cliente,
            departamento_id=int(dep_id),
            now=now,
        )

        # 2) Cria ou atualiza o atendimento de forma direta. A triagem só está
        # realmente concluída quando existe um atendimento aguardando, sem operador.
        atendimento = _ensure_waiting_atendimento_for_triage(
            db,
            empresa_id=empresa_id,
            instancia_id=instancia_id,
            cliente_id=int(cliente.id),
            departamento_id=int(dep_id),
            ts_dt=now,
        )

        atendimento_id = None
        if atendimento is not None:
            try:
                atendimento_id = int(getattr(atendimento, "id", 0) or 0) or None
                db.commit()
            except Exception as exc:
                try:
                    print("[CHATBOT][triagem][commit-atendimento][erro]", repr(exc))
                except Exception:
                    pass
                try:
                    db.rollback()
                except Exception:
                    pass
                atendimento = None
                atendimento_id = None

        # Retry limpo: cobre sessão que tenha sido invalidada por algum schema
        # legado e evita deixar novamente cliente com departamento, mas sem atendimento.
        if atendimento is None:
            atendimento = _ensure_waiting_atendimento_for_triage(
                db,
                empresa_id=empresa_id,
                instancia_id=instancia_id,
                cliente_id=int(cliente.id),
                departamento_id=int(dep_id),
                ts_dt=now,
            )
            if atendimento is not None:
                try:
                    atendimento_id = int(getattr(atendimento, "id", 0) or 0) or None
                    db.commit()
                except Exception as exc:
                    try:
                        print("[CHATBOT][triagem][retry-atendimento][erro]", repr(exc))
                    except Exception:
                        pass
                    try:
                        db.rollback()
                    except Exception:
                        pass
                    atendimento = None
                    atendimento_id = None

        if atendimento_id is not None:
            _schedule_reload_clientes(int(empresa_id))
        else:
            try:
                print(
                    "[CHATBOT][triagem][ATENCAO] departamento salvo, mas atendimento não foi persistido",
                    {
                        "empresa_id": int(empresa_id),
                        "instancia_id": int(instancia_id),
                        "cliente_id": int(cliente.id),
                        "departamento_id": int(dep_id),
                    },
                )
            except Exception:
                pass

        ack = _build_assign_ack(empresa_nome=empresa_nome, dep=dep_obj)
        _send_and_persist_triage_message(
            db,
            empresa_id=empresa_id,
            instancia_id=instancia_id,
            cliente_id=int(cliente.id),
            instancia_nome=instancia_nome,
            remote_jid=remote_jid,
            telefone_digits=telefone_digits,
            text_msg=ack,
            ts_dt=now,
        )
        return {
            "ok": True,
            "action": "assign_department_waiting",
            "departamento_id": dep_id,
            "departamento_idx": dep_idx,
            "departamento_nome": dep_nome,
            "status": "aguardando",
            "operador_id": None,
            "atendimento_id": atendimento_id,
            "atendimento_persistido": bool(atendimento_id),
        }

    tentativas_antes = int(cliente.triagem_tentativas or 0)

    cliente.triagem_ativa = True
    cliente.triagem_tentativas = tentativas_antes + 1

    _sync_open_atendimento_departamento(
        db,
        empresa_id=empresa_id,
        instancia_id=instancia_id,
        cliente_id=int(cliente.id),
        departamento_id=None,
        ts_dt=now,
        operador_id=None,
    )

    max_attempts = 0
    try:
        max_attempts = int(ad_cfg.get("max_attempts") or 0)
    except Exception:
        max_attempts = 0

    if max_attempts > 0 and int(cliente.triagem_tentativas or 0) >= max_attempts:
        cliente.triagem_ativa = False
        db.commit()

        fallback_msg = _build_fallback_message(empresa_nome=empresa_nome, cfg=cfg)
        _send_and_persist_triage_message(
            db,
            empresa_id=empresa_id,
            instancia_id=instancia_id,
            cliente_id=int(cliente.id),
            instancia_nome=instancia_nome,
            remote_jid=remote_jid,
            telefone_digits=telefone_digits,
            text_msg=fallback_msg,
            ts_dt=now,
        )
        return {
            "ok": True,
            "action": "fallback",
            "attempts": int(cliente.triagem_tentativas or 0),
            "max_attempts": max_attempts,
        }

    if tentativas_antes == 0:
        if _recent_bot_menu_sent(
            db,
            empresa_id=empresa_id,
            instancia_id=instancia_id,
            cliente_id=int(cliente.id),
            now=now,
        ):
            db.commit()
            return {
                "ok": True,
                "action": "noop_menu_already_sent",
                "reason": "recent_menu_block",
                "attempts": int(cliente.triagem_tentativas or 0),
            }
        menu = _build_menu_message(empresa_nome=empresa_nome, deps=deps, cfg=cfg)
    else:
        menu = _build_invalid_choice_message(empresa_nome=empresa_nome, deps=deps, cfg=cfg)

    db.commit()

    _send_and_persist_triage_message(
        db,
        empresa_id=empresa_id,
        instancia_id=instancia_id,
        cliente_id=int(cliente.id),
        instancia_nome=instancia_nome,
        remote_jid=remote_jid,
        telefone_digits=telefone_digits,
        text_msg=menu,
        ts_dt=now,
    )
    return {
        "ok": True,
        "action": "send_menu",
        "options": len(deps),
        "attempts": int(cliente.triagem_tentativas or 0),
    }


@router.post("/chatbot/setores")
def webhook_chatbot_setores(payload: Dict[str, Any], db: Session = Depends(get_db)):
    empresa_id = int(payload.get("empresa_id") or 0)
    instancia_id = int(payload.get("instancia_id") or 0)

    instancia_nome_in = str(payload.get("instancia") or payload.get("instance_name") or "").strip()
    if (not empresa_id or not instancia_id) and instancia_nome_in:
        inst2, emp2 = _resolve_emp_inst_from_instance_name(db, instancia_nome_in)
        if not empresa_id:
            empresa_id = emp2
        if not instancia_id:
            instancia_id = inst2

    telefone = _digits(str(payload.get("numero") or payload.get("telefone") or ""))
    texto = str(payload.get("texto") or "").strip()
    direction = str(payload.get("direction") or "")
    remote_jid = _remote_jid_from_payload(telefone, str(payload.get("jid") or "").strip())

    res = triagem_handle_inbound(
        db,
        empresa_id=empresa_id,
        instancia_id=instancia_id,
        telefone_digits=telefone,
        texto=texto,
        direction=direction,
        remote_jid=remote_jid,
    )
    return JSONResponse(res)