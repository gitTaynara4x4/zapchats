# backend/routers/chatbot_config.py
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
def _prune_for_storage(cfg: Dict[str, Any]) -> Dict[str, Any]:
    """
    Normaliza e enxuga o JSON que vai pro banco em chatbot_configs.config

    ✅ Importante:
    - Mantém textos (welcome/off/menu) mesmo se disabled, pra não perder.
    - Mantém items de departamentos (enabled/label/keywords/text).
    """
    data: Dict[str, Any] = {}

    # ativo
    if "ativo" in cfg:
        data["ativo"] = bool(cfg["ativo"])

    f_in = cfg.get("features", {}) or {}
    features: Dict[str, Any] = {}

    # ===== auto_messages (simples) =====
    am = f_in.get("auto_messages") or {}
    if isinstance(am, dict) and (("enabled" in am) or ("welcome" in am) or ("off_hours" in am) or am):
        am_store: Dict[str, Any] = {"enabled": bool(am.get("enabled", False))}

        # welcome
        if isinstance(am.get("welcome"), dict):
            w = am["welcome"] or {}
            w_store: Dict[str, Any] = {
                "enabled": bool(w.get("enabled", False)),
            }
            if "text" in w:
                w_store["text"] = str(w.get("text") or "")
            if "start" in w:
                w_store["start"] = str(w.get("start") or "")
            if "end" in w:
                w_store["end"] = str(w.get("end") or "")
            am_store["welcome"] = w_store

        # off_hours
        if isinstance(am.get("off_hours"), dict):
            o = am["off_hours"] or {}
            o_store: Dict[str, Any] = {
                "enabled": bool(o.get("enabled", False)),
            }
            if "text" in o:
                o_store["text"] = str(o.get("text") or "")
            if "start" in o:
                o_store["start"] = str(o.get("start") or "")
            if "end" in o:
                o_store["end"] = str(o.get("end") or "")
            am_store["off_hours"] = o_store

        # timezone opcional dentro do auto_messages
        if "timezone" in am:
            am_store["timezone"] = str(am.get("timezone") or "")

        features["auto_messages"] = am_store

    # ===== auto_messages_departments (triagem/ramal) =====
    ad = f_in.get("auto_messages_departments") or {}
    if isinstance(ad, dict) and (("enabled" in ad) or ("welcome" in ad) or ("items" in ad) or ad):
        ad_store: Dict[str, Any] = {"enabled": bool(ad.get("enabled", False))}

        # welcome (menu/abertura dos departamentos)
        if isinstance(ad.get("welcome"), dict):
            w = ad["welcome"] or {}
            w_store: Dict[str, Any] = {
                "enabled": bool(w.get("enabled", False)),
            }
            if "text" in w:
                w_store["text"] = str(w.get("text") or "")
            if "start" in w:
                w_store["start"] = str(w.get("start") or "")
            if "end" in w:
                w_store["end"] = str(w.get("end") or "")
            ad_store["welcome"] = w_store

        # itens por departamento
        # formato sugerido:
        # items: {
        #   "12": {"enabled": true, "label":"Financeiro", "keywords":["fin","financeiro"], "text":"..."},
        #   "13": {"enabled": true}
        # }
        items_in = ad.get("items")
        if isinstance(items_in, dict):
            items_out: Dict[str, Any] = {}
            for did, item in items_in.items():
                if not isinstance(item, dict):
                    continue
                did_s = str(did)

                tmp: Dict[str, Any] = {}
                if "enabled" in item:
                    tmp["enabled"] = bool(item.get("enabled"))
                if "label" in item:
                    tmp["label"] = str(item.get("label") or "")
                if "text" in item:
                    tmp["text"] = str(item.get("text") or "")
                if "keywords" in item:
                    kws = item.get("keywords")
                    if isinstance(kws, list):
                        tmp["keywords"] = [str(x).strip() for x in kws if str(x).strip()]
                    elif isinstance(kws, str):
                        # aceita "fin, financeiro, cobrança"
                        tmp["keywords"] = [s.strip() for s in kws.split(",") if s.strip()]

                # só salva se tiver algo útil
                if tmp:
                    items_out[did_s] = tmp

            if items_out:
                ad_store["items"] = items_out

        # controles opcionais (triagem)
        # ex: max_attempts, fallback_text
        if "max_attempts" in ad:
            try:
                ad_store["max_attempts"] = int(ad.get("max_attempts") or 0)
            except Exception:
                pass
        if "fallback_text" in ad:
            ad_store["fallback_text"] = str(ad.get("fallback_text") or "")

        features["auto_messages_departments"] = ad_store

    # guarda features se tiver algo
    if features:
        data["features"] = features

    # timezone no topo (se você usar isso no front)
    if "timezone" in cfg:
        data["timezone"] = str(cfg.get("timezone") or "")

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
    # aceita timezone em dois lugares:
    # 1) topo: cfg.timezone
    # 2) cfg.features.auto_messages.timezone
    tz = cfg.get("timezone")
    if tz:
        return str(tz)

    am = (cfg.get("features", {}) or {}).get("auto_messages", {}) or {}
    tz2 = am.get("timezone")
    return str(tz2) if tz2 else None


def _extract_auto_fields(cfg_in: Dict[str, Any]) -> dict:
    features = cfg_in.get("features", {}) or {}
    am = features.get("auto_messages", {}) or {}
    w = am.get("welcome", {}) or {}
    o = am.get("off_hours", {}) or {}

    return {
        "tz": _tz_from_config(cfg_in),
        "welcome_enabled": bool((w or {}).get("enabled", False)),
        "welcome_start": _parse_hhmm((w or {}).get("start")),
        "welcome_end": _parse_hhmm((w or {}).get("end")),
        "off_enabled": bool((o or {}).get("enabled", False)),
        "off_start": _parse_hhmm((o or {}).get("start")),
        "off_end": _parse_hhmm((o or {}).get("end")),
    }


def _apply_columns_from_config(row: models.ChatbotConfig, cfg_in: Dict[str, Any]) -> None:
    """
    Preenche colunas auxiliares (tz + janelas), com fallback seguro.
    """
    fields = _extract_auto_fields(cfg_in)

    # tz NUNCA NULL (coluna é NOT NULL no seu model)
    row.tz = (fields["tz"] or getattr(row, "tz", None) or "America/Sao_Paulo")

    # welcome
    row.welcome_enabled = bool(fields["welcome_enabled"])
    if row.welcome_enabled:
        row.welcome_start = fields["welcome_start"] or dtime(8, 0)
        row.welcome_end = fields["welcome_end"] or dtime(18, 0)
    else:
        row.welcome_start = None
        row.welcome_end = None

    # off-hours
    row.off_enabled = bool(fields["off_enabled"])
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
        raise HTTPException(status_code=404, detail="Instância não encontrada para esta empresa")

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
                    models.DepartamentoInstancia.departamento_id == models.Departamento.id,
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
        "instancia_nome": inst.instance_name,
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
        raise HTTPException(status_code=404, detail="Instância não encontrada para esta empresa")

    if not isinstance(payload, dict) or "config" not in payload:
        raise HTTPException(status_code=400, detail="Envie { config: {...} }")

    cfg_in = payload.get("config") or {}
    if not isinstance(cfg_in, dict):
        raise HTTPException(status_code=400, detail="Campo 'config' inválido")

    # prune (normaliza/limpa)
    to_store = _prune_for_storage(cfg_in)

    row = _safe_select_chatbot_config(db, empresa_id, instancia_id)
    creating = row is None

    if creating:
        row = models.ChatbotConfig(
            empresa_id=empresa_id,
            instancia_id=instancia_id,
            instancia_nome=inst.instance_name,  # ✅ espelha
            config=to_store,
            ativo=bool(cfg_in.get("ativo", True)),
        )
        _apply_columns_from_config(row, cfg_in)
        db.add(row)
    else:
        row.config = to_store
        row.ativo = bool(cfg_in.get("ativo", row.ativo))

        # ✅ mantém instancia_nome atualizado
        row.instancia_nome = inst.instance_name

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
        logger.exception("PUT config error emp=%s inst=%s\n%s", empresa_id, instancia_id, _trace(e))
        raise HTTPException(status_code=500, detail={"message": "Erro inesperado", "error": str(e)})

    try:
        db.refresh(row)
    except Exception:
        pass

    logger.info("PUT chatbot/config OK emp=%s inst=%s creating=%s", empresa_id, instancia_id, creating)
    return {
        "empresa_id": empresa_id,
        "instancia_id": instancia_id,
        "config": row.config or {},
    }
