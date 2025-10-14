from __future__ import annotations
from typing import Any, Dict, Optional

from datetime import time as dtime
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select, and_
from sqlalchemy.orm import Session
from sqlalchemy.exc import IntegrityError

from backend.database import get_db
from backend import models
import os
import uuid
import json
import time as _time
import logging

router = APIRouter(prefix="/api/chatbot", tags=["ChatBot – Config"])

# =========================
# logging
# =========================
_LOGLEVEL = os.getenv("CHATBOT_CONFIG_LOGLEVEL", "INFO").upper()
logger = logging.getLogger("chatbot_config")
if not logger.handlers:
    logging.basicConfig(
        level=getattr(logging, _LOGLEVEL, logging.INFO),
        format="%(asctime)s | %(levelname)s | %(name)s | %(message)s",
    )
logger.setLevel(getattr(logging, _LOGLEVEL, logging.INFO))


def _ctx_str(**k) -> str:
    safe = []
    for key, val in k.items():
        if key in ("empresa_id", "instancia_id", "cid"):
            safe.append(f"{key}={val}")
        else:
            # não poluir log com tudo
            try:
                s = str(val)
                if len(s) > 64:
                    s = s[:61] + "..."
                safe.append(f"{key}={s}")
            except Exception:
                safe.append(f"{key}=?")
    return " | " + " ".join(safe)


def _json_preview(obj: Any, limit: int = 1200) -> str:
    try:
        s = json.dumps(obj, ensure_ascii=False)
        return s if len(s) <= limit else (s[:limit] + "…")
    except Exception:
        return "<json-fail>"


# =========================
# helpers (gerais)
# =========================
def _exclusive_server_guard(cfg: Dict[str, Any]) -> None:
    """
    Garante exclusividade entre:
      - features.auto_messages.enabled
      - features.auto_messages_departments.enabled
    Se ambos True, prioriza auto_messages.
    """
    f = cfg.setdefault("features", {})
    au = f.setdefault("auto_messages", {})
    dp = f.setdefault("auto_messages_departments", {})

    au_enabled = bool(au.get("enabled"))
    dp_enabled = bool(dp.get("enabled"))

    if au_enabled and dp_enabled:
        logger.info(
            "EXCLUSIVE guard: auto_messages priorizado; desabilitando auto_messages_departments%s",
            _ctx_str(),
        )
        dp["enabled"] = False


def _prune_for_storage(cfg: Dict[str, Any]) -> Dict[str, Any]:
    """
    Mantém só o que está ON.
    - Se auto_messages.enabled == False -> remove auto_messages
    - Se auto_messages_departments.enabled == False -> remove esse bloco
    - 'setores' só vai junto se auto_messages_departments estiver ON
    - Fora isso, só guarda campos-raiz que foram enviados E fazem sentido (ex.: ativo)
    """
    data: Dict[str, Any] = {}

    # raiz: só guarda 'ativo' se vier
    if "ativo" in cfg:
        data["ativo"] = bool(cfg["ativo"])

    f_in = cfg.get("features", {}) or {}
    features: Dict[str, Any] = {}

    # auto_messages (se ON)
    am = f_in.get("auto_messages") or {}
    if bool(am.get("enabled")):
        am_store: Dict[str, Any] = {"enabled": True}

        if "welcome" in am and isinstance(am["welcome"], dict) and am["welcome"].get("enabled") is True:
            w = am["welcome"]
            w_out = {}
            for k in ["enabled", "text", "start", "end", "use_department_buttons"]:
                if k in w:
                    w_out[k] = w[k]
            if w_out:
                am_store["welcome"] = w_out

        if "off_hours" in am and isinstance(am["off_hours"], dict) and am["off_hours"].get("enabled") is True:
            o = am["off_hours"]
            o_out = {}
            for k in ["enabled", "text", "start", "end"]:
                if k in o:
                    o_out[k] = o[k]
            if o_out:
                am_store["off_hours"] = o_out

        # só guarda auto_messages se tiver algo útil (enabled True já é útil)
        features["auto_messages"] = am_store

    # auto_messages_departments (se ON)
    ad = f_in.get("auto_messages_departments") or {}
    ad_enabled = bool(ad.get("enabled"))
    if ad_enabled:
        ad_store: Dict[str, Any] = {"enabled": True}
        if "items" in ad and isinstance(ad["items"], dict):
            items_out = {}
            for did, item in ad["items"].items():
                if not isinstance(item, dict):
                    continue
                tmp = {}
                if "enabled" in item:
                    tmp["enabled"] = bool(item["enabled"])
                if "text" in item and str(item["text"]).strip():
                    tmp["text"] = str(item["text"])
                if tmp:
                    items_out[did] = tmp
            if items_out:
                ad_store["items"] = items_out
        features["auto_messages_departments"] = ad_store

    if features:
        data["features"] = features

    # 'setores' SÓ vai se departamentos estiverem ON
    if ad_enabled and "setores" in cfg:
        data["setores"] = cfg["setores"]

    logger.debug("PRUNE result=%s", _json_preview(data))
    return data


def _safe_select_chatbot_config(db: Session, empresa_id: int, instancia_id: int):
    try:
        row = db.execute(
            select(models.ChatbotConfig).where(
                and_(
                    models.ChatbotConfig.empresa_id == empresa_id,
                    models.ChatbotConfig.instancia_id == instancia_id,
                )
            )
        ).scalar_one_or_none()
        logger.debug(
            "SELECT chatbot_config ok%s",
            _ctx_str(empresa_id=empresa_id, instancia_id=instancia_id, has=bool(row)),
        )
        return row
    except Exception as e:
        logger.warning(
            "SELECT chatbot_config falhou%s err=%s",
            _ctx_str(empresa_id=empresa_id, instancia_id=instancia_id),
            repr(e),
        )
        return None


# =========================
# helpers (colunas ↔ JSON)
# =========================
def _parse_hhmm(val: Optional[str]) -> Optional[dtime]:
    if val is None:
        return None
    s = str(val).strip()
    if not s:
        return None
    try:
        h, m = map(int, s.split(":", 1))
        return dtime(h, m)
    except Exception:
        return None


def _tz_from_config(cfg: Dict[str, Any]) -> Optional[str]:
    """
    Pega timezone do topo de config (preferência) ou de features.auto_messages.timezone.
    Se não existir, devolve None para deixar NULL na coluna (ou o app usar APP_TZ).
    """
    tz = cfg.get("timezone")
    if not tz:
        tz = (cfg.get("features", {}).get("auto_messages", {}) or {}).get("timezone")
    if tz:
        return str(tz)
    return None


def _extract_auto_fields(cfg_in: Dict[str, Any]) -> dict:
    """
    Extrai os campos que vão para as colunas da tabela chatbot_configs
    a partir do JSON de entrada (sem prune).
    """
    features = cfg_in.get("features", {}) or {}
    am = features.get("auto_messages", {}) or {}

    w = am.get("welcome", {}) or {}
    o = am.get("off_hours", {}) or {}

    fields = {
        "tz": _tz_from_config(cfg_in),
        "welcome_enabled": bool(w.get("enabled", False)),
        "welcome_start": _parse_hhmm(w.get("start")),
        "welcome_end": _parse_hhmm(w.get("end")),
        "off_enabled": bool(o.get("enabled", False)),
        "off_start": _parse_hhmm(o.get("start")),
        "off_end": _parse_hhmm(o.get("end")),
    }
    logger.debug("EXTRACT columns=%s", fields)
    return fields


def _apply_columns_from_config(row: models.ChatbotConfig, cfg_in: Dict[str, Any]) -> None:
    """
    Aplica os campos extraídos do JSON nas colunas do modelo.
    """
    fields = _extract_auto_fields(cfg_in)

    # timezone (pode ser None se não veio)
    row.tz = fields["tz"]

    # welcome
    row.welcome_enabled = fields["welcome_enabled"]
    row.welcome_start   = fields["welcome_start"]
    row.welcome_end     = fields["welcome_end"]

    # off-hours
    row.off_enabled     = fields["off_enabled"]
    row.off_start       = fields["off_start"]
    row.off_end         = fields["off_end"]


# =========================
# Routes
# =========================
@router.get("/config")
def get_config(
    empresa_id: int = Query(..., description="ID da empresa"),
    instancia_id: int = Query(..., description="ID da instância (obrigatório)"),
    db: Session = Depends(get_db),
):
    """
    Retorna exatamente o que está no banco (ou {} se não houver).
    NÃO faz merge com defaults. O front aplica seus próprios defaults.
    """
    cid = str(uuid.uuid4())
    t0 = _time.perf_counter()
    logger.info("GET /api/chatbot/config begin%s", _ctx_str(cid=cid, empresa_id=empresa_id, instancia_id=instancia_id))

    row = _safe_select_chatbot_config(db, empresa_id, instancia_id)
    cfg_raw = row.config if row and getattr(row, "config", None) else {}
    logger.debug("GET config raw=%s%s", _json_preview(cfg_raw), _ctx_str(cid=cid))

    dt = (_time.perf_counter() - t0) * 1000
    logger.info("GET /api/chatbot/config ok in %.1fms%s", dt, _ctx_str(cid=cid))
    return {"empresa_id": empresa_id, "instancia_id": instancia_id, "config": cfg_raw or {}}


@router.put("/config")
def put_config(
    payload: Dict[str, Any],
    empresa_id: int = Query(..., description="ID da empresa"),
    instancia_id: int = Query(..., description="ID da instância (obrigatório)"),
    db: Session = Depends(get_db),
):
    """
    Salva o JSON 'config' (prune do que está OFF) e também REFLETE nas colunas:
      tz, welcome_enabled, welcome_start, welcome_end, off_enabled, off_start, off_end.

    O front continua mandando: { "config": { features: { auto_messages: {...} } } }.
    """
    cid = str(uuid.uuid4())
    t0 = _time.perf_counter()
    logger.info("PUT /api/chatbot/config begin%s", _ctx_str(cid=cid, empresa_id=empresa_id, instancia_id=instancia_id))
    logger.debug("PUT payload=%s%s", _json_preview(payload), _ctx_str(cid=cid))

    if not isinstance(payload, dict) or "config" not in payload:
        logger.warning("PUT invalid payload (sem 'config')%s", _ctx_str(cid=cid))
        raise HTTPException(status_code=400, detail="Envie um objeto { config: {...} }")

    cfg_in = payload.get("config") or {}
    if not isinstance(cfg_in, dict):
        logger.warning("PUT invalid 'config' type%s", _ctx_str(cid=cid))
        raise HTTPException(status_code=400, detail="Campo 'config' inválido")

    # 1) Exclusividade entre blocos
    _exclusive_server_guard(cfg_in)

    # 2) Reduz o que será guardado no JSON
    to_store = _prune_for_storage(cfg_in)
    logger.debug("PUT to_store=%s%s", _json_preview(to_store), _ctx_str(cid=cid))

    # 3) Upsert + refletir colunas
    row = _safe_select_chatbot_config(db, empresa_id, instancia_id)
    creating = row is None

    if creating:
        logger.info("PUT creating row%s", _ctx_str(cid=cid))
        row = models.ChatbotConfig(
            empresa_id=empresa_id,
            instancia_id=instancia_id,
            config=to_store,
            ativo=bool(cfg_in.get("ativo", True)),
        )
        _apply_columns_from_config(row, cfg_in)
        db.add(row)
    else:
        logger.info("PUT updating row%s", _ctx_str(cid=cid))
        row.config = to_store
        row.ativo = bool(cfg_in.get("ativo", row.ativo))
        _apply_columns_from_config(row, cfg_in)

    try:
        db.commit()
    except IntegrityError as e:
        db.rollback()
        logger.error("PUT commit IntegrityError%s err=%s", _ctx_str(cid=cid), repr(e))
        raise HTTPException(status_code=400, detail=f"Falha ao salvar config: {e.orig}")
    except Exception as e:
        db.rollback()
        logger.exception("PUT commit Exception%s", _ctx_str(cid=cid))
        raise HTTPException(status_code=500, detail=f"Erro ao salvar config: {repr(e)}")

    try:
        db.refresh(row)
    except Exception:
        pass

    dt = (_time.perf_counter() - t0) * 1000
    logger.info(
        "PUT /api/chatbot/config ok in %.1fms%s",
        dt,
        _ctx_str(cid=cid, created=creating, ativo=row.ativo, tz=row.tz),
    )
    logger.debug("PUT final config stored=%s%s", _json_preview(row.config or {}), _ctx_str(cid=cid))
    return {"empresa_id": empresa_id, "instancia_id": instancia_id, "config": row.config or {}}
