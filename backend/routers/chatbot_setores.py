# backend/routers/chatbot_setores.py
from __future__ import annotations

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

# Reusa o client Evolution já pronto no send
from backend.routers.atendimento_send import _evo_post  # type: ignore


router = APIRouter(prefix="/api", tags=["Chatbot (Triagem Setores)"])

TRIAGEM_TTL_HOURS = int(os.getenv("TRIAGEM_TTL_HOURS", "6"))
AUTO_MESSAGE_DEDUP_MINUTES = int(os.getenv("AUTO_MESSAGE_DEDUP_MINUTES", "60"))


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
    return int(row["empresa_id"]), int(row["id"])


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
    return cfg if isinstance(cfg, dict) else {}


def _fetch_departamentos(db: Session, *, empresa_id: int, instancia_id: int) -> List[Dict[str, Any]]:
    rows = db.execute(
        text(
            """
            SELECT d.id, d.nome
            FROM departamentos d
            WHERE d.empresa_id = :empresa_id
              AND d.ativo IS TRUE
              AND (
                EXISTS (
                  SELECT 1
                  FROM departamentos_instancias di
                  WHERE di.departamento_id = d.id
                    AND di.empresa_id = :empresa_id
                    AND di.instancia_id = :instancia_id
                )
                OR NOT EXISTS (
                  SELECT 1
                  FROM departamentos_instancias di2
                  WHERE di2.empresa_id = :empresa_id
                    AND di2.instancia_id = :instancia_id
                )
              )
            ORDER BY d.id ASC
            """
        ),
        {"empresa_id": empresa_id, "instancia_id": instancia_id},
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
    """
    Aceita:
      - "2" ou "2 - financeiro"
      - "dep:12"
      - "financeiro"
      - palavras-chave configuradas
    """
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


def _send_text(db: Session, *, instancia_nome: str, remote_jid: str, text_msg: str) -> None:
    if not instancia_nome or not remote_jid or not text_msg:
        return

    jid = str(remote_jid).strip()

    if jid.endswith("@g.us"):
        destino = jid
    else:
        numero = jid.split("@", 1)[0].split(":", 1)[0]
        numero = _ensure_br_country(numero)
        destino = f"{numero}@s.whatsapp.net"

    payload = {
        "number": destino,
        "text": text_msg,
    }

    _evo_post("/message/sendText", instancia_nome, payload)


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


def _safe_zoneinfo(name: str | None) -> ZoneInfo:
    try:
        return ZoneInfo(str(name or "").strip() or "America/Sao_Paulo")
    except Exception:
        return ZoneInfo("America/Sao_Paulo")


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


def _fetch_last_inbound_message_time(
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
              AND tipo = 'entrada'
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

    # LIMIT 2 porque a mensagem atual já foi salva antes do hook.
    # Queremos a anterior à atual, quando existir.
    if len(row) >= 2:
        return _as_aware_utc(row[1].get("timestamp"))

    return _as_aware_utc(row[0].get("timestamp"))


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
    """
    Mensagens automáticas simples:
      - welcome: envia dentro da janela configurada
      - off_hours: envia fora da janela configurada
    Regras:
      - só processa ENTRADA
      - respeita chatbot_configs.config.features.auto_messages
      - evita reenvio em sequência usando dedup por última msg de entrada
    """
    if (direction or "").lower() == "saida":
        return {"ok": True, "action": "ignore_saida"}

    telefone_digits = _digits(telefone_digits)
    texto = (texto or "").strip()

    if not empresa_id or not instancia_id or not telefone_digits or not texto:
        return {"ok": True, "action": "noop_invalid"}

    instancia_nome, empresa_nome = _fetch_empresa_instancia_info(
        db, empresa_id=empresa_id, instancia_id=instancia_id
    )
    cfg = _fetch_chatbot_config(db, empresa_id=empresa_id, instancia_id=instancia_id)
    auto_cfg, welcome_cfg, off_cfg = _get_auto_cfg_parts(cfg)

    if not bool(auto_cfg.get("enabled", False)):
        return {"ok": True, "action": "noop_auto_disabled"}

    cliente = _get_or_create_cliente(
        db,
        empresa_id=empresa_id,
        instancia_id=instancia_id,
        telefone_digits=telefone_digits,
    )

    last_prev_inbound = _fetch_last_inbound_message_time(
        db,
        empresa_id=empresa_id,
        cliente_id=int(cliente.id),
        instancia_id=instancia_id,
    )
    if last_prev_inbound:
        delta = _now_utc() - last_prev_inbound
        if delta <= timedelta(minutes=max(1, AUTO_MESSAGE_DEDUP_MINUTES)):
            return {
                "ok": True,
                "action": "noop_already_sent_recently",
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
        _send_text(db, instancia_nome=instancia_nome, remote_jid=remote_jid, text_msg=text_msg)
        return {
            "ok": True,
            "action": "sent_welcome",
            "timezone": tz_name,
            "now_local": now_local.isoformat(),
        }

    if off_enabled and off_in_window:
        text_msg = _replace_auto_tokens(str(off_cfg.get("text") or "").strip(), empresa_nome=empresa_nome)
        db.commit()
        _send_text(db, instancia_nome=instancia_nome, remote_jid=remote_jid, text_msg=text_msg)
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
    """
    Regra:
      - Chegou msg ENTRADA:
          - Se ficou > ttl_hours sem falar: limpa departamento_id/colaborador_id e liga triagem_ativa
          - Atualiza triagem_ultima_msg_em = agora
          - Se precisa de triagem: manda menu ou aceita escolha e salva departamento_id
          - Respeita config salva em chatbot_configs.config.features.auto_messages_departments
      - Se o TTL expirou, a PRIMEIRA mensagem após expirar sempre mostra o menu
        e não tenta interpretar o texto como escolha de setor.
    """
    if (direction or "").lower() == "saida":
        return {"ok": True, "action": "ignore_saida"}

    telefone_digits = _digits(telefone_digits)
    texto = (texto or "").strip()

    if not empresa_id or not instancia_id or not telefone_digits or not texto:
        return {"ok": True, "action": "noop_invalid"}

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
        db.commit()
        return {"ok": True, "action": "noop_has_departamento"}

    if not cliente.triagem_iniciada_em:
        cliente.triagem_iniciada_em = now

    deps = _fetch_triage_departamentos(db, empresa_id=empresa_id, instancia_id=instancia_id, cfg=cfg)
    if not deps:
        cliente.triagem_ativa = False
        db.commit()
        return {"ok": True, "action": "noop_no_deps_enabled"}

    # Se o TTL expirou, a primeira mensagem após isso só reabre o menu
    if ttl_expired:
        cliente.triagem_ativa = True
        cliente.triagem_tentativas = 1

        menu = _build_menu_message(empresa_nome=empresa_nome, deps=deps, cfg=cfg)
        db.commit()

        _send_text(db, instancia_nome=instancia_nome, remote_jid=remote_jid, text_msg=menu)
        return {
            "ok": True,
            "action": "send_menu_ttl_reset",
            "options": len(deps),
            "attempts": int(cliente.triagem_tentativas or 0),
        }

    dep_id, dep_idx, dep_nome, dep_obj = _parse_departamento_choice(texto, deps)

    if dep_id:
        cliente.departamento_id = dep_id
        cliente.triagem_ativa = False
        cliente.triagem_tentativas = int(cliente.triagem_tentativas or 0) + 1

        primary = _fetch_primary_colab_id(db, empresa_id=empresa_id, departamento_id=dep_id)
        if primary:
            cliente.colaborador_id = primary

        db.commit()

        ack = _build_assign_ack(empresa_nome=empresa_nome, dep=dep_obj)
        _send_text(db, instancia_nome=instancia_nome, remote_jid=remote_jid, text_msg=ack)
        return {
            "ok": True,
            "action": "assign",
            "departamento_id": dep_id,
            "departamento_idx": dep_idx,
            "departamento_nome": dep_nome,
        }

    tentativas_antes = int(cliente.triagem_tentativas or 0)

    cliente.triagem_ativa = True
    cliente.triagem_tentativas = tentativas_antes + 1

    max_attempts = 0
    try:
        max_attempts = int(ad_cfg.get("max_attempts") or 0)
    except Exception:
        max_attempts = 0

    if max_attempts > 0 and int(cliente.triagem_tentativas or 0) >= max_attempts:
        cliente.triagem_ativa = False
        db.commit()

        fallback_msg = _build_fallback_message(empresa_nome=empresa_nome, cfg=cfg)
        _send_text(db, instancia_nome=instancia_nome, remote_jid=remote_jid, text_msg=fallback_msg)
        return {
            "ok": True,
            "action": "fallback",
            "attempts": int(cliente.triagem_tentativas or 0),
            "max_attempts": max_attempts,
        }

    if tentativas_antes == 0:
        menu = _build_menu_message(empresa_nome=empresa_nome, deps=deps, cfg=cfg)
    else:
        menu = _build_invalid_choice_message(empresa_nome=empresa_nome, deps=deps, cfg=cfg)

    db.commit()

    _send_text(db, instancia_nome=instancia_nome, remote_jid=remote_jid, text_msg=menu)
    return {
        "ok": True,
        "action": "send_menu",
        "options": len(deps),
        "attempts": int(cliente.triagem_tentativas or 0),
    }


@router.post("/chatbot/setores")
def webhook_chatbot_setores(payload: Dict[str, Any], db: Session = Depends(get_db)):
    """
    Webhook (substitui seu n8n nesse fluxo).

    Aceita:
      {
        "empresa_id": 7,
        "instancia_id": 12,
        "instancia": "minha-instancia",
        "numero": "5531986419237" ou "31986419237",
        "texto": "2",
        "direction": "entrada"|"saida",
        "jid": "5531986419237@s.whatsapp.net"
      }
    """
    empresa_id = int(payload.get("empresa_id") or 0)
    instancia_id = int(payload.get("instancia_id") or 0)

    instancia_nome_in = str(payload.get("instancia") or payload.get("instance_name") or "").strip()
    if (not empresa_id or not instancia_id) and instancia_nome_in:
        emp2, inst2 = _resolve_emp_inst_from_instance_name(db, instancia_nome_in)
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