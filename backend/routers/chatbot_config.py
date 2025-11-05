from __future__ import annotations
from typing import Any, Dict, Optional
from datetime import time as dtime
import os
import logging
import traceback

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select, and_
from sqlalchemy.orm import Session
from sqlalchemy.exc import IntegrityError

from backend.database import get_db
from backend import models
from backend.routers.auth import get_current_user

router = APIRouter(prefix="/api/chatbot", tags=["ChatBot – Config"])

# ========= logging =========
_LOGLEVEL = os.getenv("CHATBOT_CFG_LOGLEVEL", "INFO").upper()
logger = logging.getLogger("chatbot_config")
if not logger.handlers:
    logging.basicConfig(
        level=getattr(logging, _LOGLEVEL, logging.INFO),
        format="%(asctime)s | %(levelname)s | %(name)s | %(message)s",
    )
logger.setLevel(getattr(logging, _LOGLEVEL, logging.INFO))


def _trace(e: Exception) -> str:
    try:
        return "".join(traceback.format_exception(type(e), e, e.__traceback__))
    except Exception:
        return f"{e.__class__.__name__}: {e}"


# ========= helpers (gerais) =========
def _exclusive_server_guard(cfg: Dict[str, Any]) -> None:
    f = cfg.setdefault("features", {})
    au = f.setdefault("auto_messages", {})
    dp = f.setdefault("auto_messages_departments", {})

    if bool(au.get("enabled")) and bool(dp.get("enabled")):
        # prioridade: auto_messages
        dp["enabled"] = False


def _prune_for_storage(cfg: Dict[str, Any]) -> Dict[str, Any]:
    data: Dict[str, Any] = {}
    if "ativo" in cfg:
        data["ativo"] = bool(cfg["ativo"])

    f_in = cfg.get("features", {}) or {}
    features: Dict[str, Any] = {}

    am = f_in.get("auto_messages") or {}
    if bool(am.get("enabled")):
        am_store: Dict[str, Any] = {"enabled": True}

        if isinstance(am.get("welcome"), dict) and am["welcome"].get("enabled") is True:
            w = am["welcome"]
            am_store["welcome"] = {
                k: w[k] for k in ["enabled", "text", "start", "end"] if k in w
            }

        if isinstance(am.get("off_hours"), dict) and am["off_hours"].get("enabled") is True:
            o = am["off_hours"]
            am_store["off_hours"] = {
                k: o[k] for k in ["enabled", "text", "start", "end"] if k in o
            }

        features["auto_messages"] = am_store

    ad = f_in.get("auto_messages_departments") or {}
    ad_enabled = bool(ad.get("enabled"))
    if ad_enabled:
        ad_store: Dict[str, Any] = {"enabled": True}
        if "items" in ad and isinstance(ad["items"], dict):
            items_out = {}
            for did, item in ad["items"].items():
                if isinstance(item, dict):
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

    if ad_enabled and "setores" in cfg:
        data["setores"] = cfg["setores"]

    return data


def _safe_select_chatbot_config(db: Session, empresa_id: int, instancia_id: int):
    try:
        return db.execute(
            select(models.ChatbotConfig).where(
                and_(
                    models.ChatbotConfig.empresa_id == empresa_id,
                    models.ChatbotConfig.instancia_id == instancia_id,
                )
            )
        ).scalar_one_or_none()
    except Exception as e:
        logger.warning("select ChatbotConfig falhou: %s", _trace(e))
        return None


# ========= helpers (colunas ↔ JSON) =========
def _parse_hhmm(val: Optional[str]) -> Optional[dtime]:
    if val is None:
        return None
    s = str(val).strip()
    if not s:
        return None
    try:
        h, m = map(int, s.split(":", 1))
        if 0 <= h <= 23 and 0 <= m <= 59:
            return dtime(h, m)
        return None
    except Exception:
        return None


def _tz_from_config(cfg: Dict[str, Any]) -> Optional[str]:
    tz = cfg.get("timezone") or (
        cfg.get("features", {}).get("auto_messages", {}) or {}
    ).get("timezone")
    return str(tz) if tz else None


def _extract_auto_fields(cfg_in: Dict[str, Any]) -> dict:
    features = cfg_in.get("features", {}) or {}
    am = features.get("auto_messages", {}) or {}
    w = am.get("welcome", {}) or {}
    o = am.get("off_hours", {}) or {}
    return {
        "tz": _tz_from_config(cfg_in),
        "welcome_enabled": bool(w.get("enabled", False)),
        "welcome_start": _parse_hhmm(w.get("start")),
        "welcome_end": _parse_hhmm(w.get("end")),
        "off_enabled": bool(o.get("enabled", False)),
        "off_start": _parse_hhmm(o.get("start")),
        "off_end": _parse_hhmm(o.get("end")),
    }


def _apply_columns_from_config(row: models.ChatbotConfig, cfg_in: Dict[str, Any]) -> None:
    """
    - Se seção ON e horário inválido: preenche fallback seguro.
    - Se seção OFF: zera horários (None).
    """
    fields = _extract_auto_fields(cfg_in)

    row.tz = fields["tz"]  # se a coluna for NOT NULL, ajuste para fallback fixo aqui.

    # welcome
    row.welcome_enabled = fields["welcome_enabled"]
    if row.welcome_enabled:
        row.welcome_start = fields["welcome_start"] or dtime(8, 0)
        row.welcome_end = fields["welcome_end"] or dtime(18, 0)
    else:
        row.welcome_start = None
        row.welcome_end = None

    # off-hours
    row.off_enabled = fields["off_enabled"]
    if row.off_enabled:
        row.off_start = fields["off_start"] or dtime(18, 0)
        row.off_end = fields["off_end"] or dtime(8, 0)
    else:
        row.off_start = None
        row.off_end = None


# ========= routes =========
@router.get("/config")
def get_config(
    empresa_id: int = Query(..., description="ID da empresa"),
    instancia_id: int = Query(..., description="ID da instância"),
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    """
    Retorna a configuração de chatbot para uma instância específica.

    Segurança multi-empresa:
      - empresa_id deve ser igual a user.empresa_id
      - instancia_id deve pertencer à mesma empresa.
    """
    if int(user.empresa_id) != int(empresa_id):
        raise HTTPException(status_code=403, detail="Empresa não permitida")

    inst = (
        db.query(models.EmpresaInstancia)
        .filter(
            models.EmpresaInstancia.id == instancia_id,
            models.EmpresaInstancia.empresa_id == empresa_id,
        )
        .first()
    )
    if not inst:
        raise HTTPException(
            status_code=404, detail="Instância não encontrada para esta empresa"
        )

    # config atual
    row = _safe_select_chatbot_config(db, empresa_id, instancia_id)
    cfg_raw = row.config if row and getattr(row, "config", None) else {}

    # nome da empresa
    empresa = db.get(models.Empresa, empresa_id)
    empresa_nome = empresa.nome.strip() if empresa and empresa.nome else None

    # departamentos (preferindo vinculados à instância)
    deps_rows = []
    try:
        deps_rows = db.execute(
            select(models.Departamento.id, models.Departamento.nome)
            .join(
                models.DepartamentoInstancia,
                and_(
                    models.DepartamentoInstancia.departamento_id
                    == models.Departamento.id,
                    models.DepartamentoInstancia.empresa_id == empresa_id,
                    models.DepartamentoInstancia.instancia_id == instancia_id,
                ),
            )
            .where(
                models.Departamento.empresa_id == empresa_id,
                models.Departamento.ativo == True,
            )
            .order_by(models.Departamento.nome.asc())
        ).all()

        if not deps_rows:
            deps_rows = db.execute(
                select(models.Departamento.id, models.Departamento.nome)
                .where(
                    models.Departamento.empresa_id == empresa_id,
                    models.Departamento.ativo == True,
                )
                .order_by(models.Departamento.nome.asc())
            ).all()
    except Exception as e:
        logger.warning("GET departamentos falhou: %s", _trace(e))
        deps_rows = []

    departamentos = [{"id": int(r[0]), "nome": str(r[1])} for r in deps_rows]

    logger.info(
        "GET chatbot/config emp=%s inst=%s has_cfg=%s deps=%s",
        empresa_id,
        instancia_id,
        bool(cfg_raw),
        len(departamentos),
    )
    return {
        "empresa_id": empresa_id,
        "instancia_id": instancia_id,
        "empresa_nome": empresa_nome,
        "departamentos": departamentos,
        "config": cfg_raw or {},
    }


@router.put("/config")
def put_config(
    payload: Dict[str, Any],
    empresa_id: int = Query(..., description="ID da empresa"),
    instancia_id: int = Query(..., description="ID da instância"),
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    """
    Atualiza a configuração do chatbot para uma instância específica.

    Segurança multi-empresa:
      - empresa_id deve ser igual a user.empresa_id
      - instancia_id deve pertencer à mesma empresa.
    """
    logger.info("PUT chatbot/config emp=%s inst=%s", empresa_id, instancia_id)

    if int(user.empresa_id) != int(empresa_id):
        raise HTTPException(status_code=403, detail="Empresa não permitida")

    inst = (
        db.query(models.EmpresaInstancia)
        .filter(
            models.EmpresaInstancia.id == instancia_id,
            models.EmpresaInstancia.empresa_id == empresa_id,
        )
        .first()
    )
    if not inst:
        raise HTTPException(
            status_code=404, detail="Instância não encontrada para esta empresa"
        )

    if not isinstance(payload, dict) or "config" not in payload:
        raise HTTPException(status_code=400, detail="Envie { config: {...} }")

    cfg_in = payload.get("config") or {}
    if not isinstance(cfg_in, dict):
        raise HTTPException(status_code=400, detail="Campo 'config' inválido")

    # exclusividade
    _exclusive_server_guard(cfg_in)
    # prune
    to_store = _prune_for_storage(cfg_in)

    row = _safe_select_chatbot_config(db, empresa_id, instancia_id)
    creating = row is None
    if creating:
        row = models.ChatbotConfig(
            empresa_id=empresa_id,
            instancia_id=instancia_id,
            config=to_store,
            ativo=bool(cfg_in.get("ativo", True)),
        )
        _apply_columns_from_config(row, cfg_in)
        db.add(row)
    else:
        row.config = to_store
        row.ativo = bool(cfg_in.get("ativo", row.ativo))
        _apply_columns_from_config(row, cfg_in)

    try:
        db.commit()
    except IntegrityError as e:
        db.rollback()
        logger.error(
            "PUT config IntegrityError emp=%s inst=%s\n%s",
            empresa_id,
            instancia_id,
            _trace(e),
        )
        raise HTTPException(
            status_code=400,
            detail={
                "message": "Falha ao salvar config (violação de integridade).",
                "db_error": str(getattr(e, "orig", e)),
            },
        )
    except Exception as e:
        db.rollback()
        logger.exception(
            "PUT config error emp=%s inst=%s\n%s",
            empresa_id,
            instancia_id,
            _trace(e),
        )
        raise HTTPException(
            status_code=500, detail={"message": "Erro inesperado", "error": str(e)}
        )

    try:
        db.refresh(row)
    except Exception:
        pass

    logger.info(
        "PUT chatbot/config OK emp=%s inst=%s creating=%s",
        empresa_id,
        instancia_id,
        creating,
    )
    return {
        "empresa_id": empresa_id,
        "instancia_id": instancia_id,
        "config": row.config or {},
    }
