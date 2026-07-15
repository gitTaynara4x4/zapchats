from __future__ import annotations

from typing import Any, Dict, Optional
from datetime import time as dtime
import os
import logging
import traceback

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from sqlalchemy import select, and_, text
from sqlalchemy.orm import Session
from sqlalchemy.exc import IntegrityError

from backend.database import get_db
from backend import models
from backend.routers.auth import get_current_user
from backend.utils.entitlements import enforce_feature
from backend.websocket_manager import conexoes_ativas
from backend.services.chatbot_claim_policy import release_unassigned_department_claims

router = APIRouter(prefix="/api/chatbot", tags=["ChatBot – Config"])


def _queue_released_conversations_ws(
    background_tasks: BackgroundTasks,
    *,
    empresa_id: int,
    released: list[dict[str, Any]],
) -> None:
    """Atualiza atendimentos abertos sem exigir F5 após desligar o menu."""
    for item in released or []:
        payload = dict(item)
        payload.update(
            {
                "type": "atendimento_claim_updated",
                "action": "chatbot_disabled_release",
                "conversation_key": f"c:{int(item['cliente_id'])}:{int(item['instancia_id'])}",
                "conversation_id": f"c:{int(item['cliente_id'])}:{int(item['instancia_id'])}",
                "origin": "chatbot_config",
            }
        )
        background_tasks.add_task(
            conexoes_ativas.send_message,
            f"emp:{int(empresa_id)}",
            payload,
        )

    if released:
        background_tasks.add_task(
            conexoes_ativas.send_message,
            f"emp:{int(empresa_id)}",
            {
                "type": "reload_clientes",
                "reason": "chatbot_department_disabled",
            },
        )

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


def _lock_chatbot_instance(db: Session, *, empresa_id: int, instancia_id: int) -> None:
    """Serializa o envio do bot e a alteração do botão geral nesta instância."""
    db.execute(
        text("SELECT pg_advisory_xact_lock(:empresa_id, :instancia_id)"),
        {"empresa_id": int(empresa_id), "instancia_id": int(instancia_id)},
    )


def _normalize_config_aliases(cfg: Dict[str, Any]) -> Dict[str, Any]:
    """
    Compatibilidade com o frontend antigo, que salvava o menu como
    features.auto_messages_filas. O padrão oficial agora é
    features.auto_messages_departments.
    """
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

    # Nunca persiste/devolve o alias antigo para não manter dois contratos ativos.
    features.pop("auto_messages_filas", None)
    out["features"] = features
    return out


def _prune_for_storage(cfg: Dict[str, Any]) -> Dict[str, Any]:
    cfg = _normalize_config_aliases(cfg)
    data: Dict[str, Any] = {}

    if "ativo" in cfg:
        data["ativo"] = bool(cfg["ativo"])

    f_in = cfg.get("features", {}) or {}
    features: Dict[str, Any] = {}

    am = f_in.get("auto_messages") or {}
    if isinstance(am, dict) and (("enabled" in am) or ("welcome" in am) or ("off_hours" in am) or am):
        am_store: Dict[str, Any] = {"enabled": bool(am.get("enabled", False))}

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

        if "timezone" in am:
            am_store["timezone"] = str(am.get("timezone") or "")

        features["auto_messages"] = am_store

    ad = f_in.get("auto_messages_departments") or {}
    if isinstance(ad, dict) and (("enabled" in ad) or ("welcome" in ad) or ("items" in ad) or ad):
        ad_store: Dict[str, Any] = {"enabled": bool(ad.get("enabled", False))}

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
                        tmp["keywords"] = [s.strip() for s in kws.split(",") if s.strip()]

                if tmp:
                    items_out[did_s] = tmp

            if items_out:
                ad_store["items"] = items_out

        if "max_attempts" in ad:
            try:
                ad_store["max_attempts"] = int(ad.get("max_attempts") or 0)
            except Exception:
                pass
        if "fallback_text" in ad:
            ad_store["fallback_text"] = str(ad.get("fallback_text") or "")

        features["auto_messages_departments"] = ad_store

    if features:
        data["features"] = features

    if "timezone" in cfg:
        data["timezone"] = str(cfg.get("timezone") or "")

    return data


def _mode_is_active(features: Dict[str, Any], mode: str) -> bool:
    if not isinstance(features, dict):
        return False

    if mode == "auto":
        auto = (features.get("auto_messages") or {}) if isinstance(features, dict) else {}
        return bool(
            isinstance(auto, dict)
            and auto.get("enabled", False)
            and (
                bool((auto.get("welcome") or {}).get("enabled", False))
                or bool((auto.get("off_hours") or {}).get("enabled", False))
            )
        )

    if mode == "dept":
        dept = (features.get("auto_messages_departments") or features.get("auto_messages_filas") or {}) if isinstance(features, dict) else {}
        return bool(
            isinstance(dept, dict)
            and dept.get("enabled", False)
            and bool((dept.get("welcome") or {}).get("enabled", False))
        )

    return False


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
    fields = _extract_auto_fields(cfg_in)

    row.tz = (fields["tz"] or getattr(row, "tz", None) or "America/Sao_Paulo")

    row.welcome_enabled = bool(fields["welcome_enabled"])
    if row.welcome_enabled:
        row.welcome_start = fields["welcome_start"] or dtime(8, 0)
        row.welcome_end = fields["welcome_end"] or dtime(18, 0)
    else:
        row.welcome_start = None
        row.welcome_end = None

    row.off_enabled = bool(fields["off_enabled"])
    if row.off_enabled:
        row.off_start = fields["off_start"] or dtime(18, 0)
        row.off_end = fields["off_end"] or dtime(8, 0)
    else:
        row.off_start = None
        row.off_end = None


def _has_advanced_automation_usage(cfg: Dict[str, Any]) -> bool:
    """
    Considera 'automação avançada' quando a configuração usa
    o bloco por departamentos.
    """
    features = (cfg.get("features") or {}) if isinstance(cfg, dict) else {}
    dept = (features.get("auto_messages_departments") or features.get("auto_messages_filas") or {}) if isinstance(features, dict) else {}

    if not isinstance(dept, dict):
        return False

    if bool(dept.get("enabled", False)):
        return True

    welcome = dept.get("welcome") or {}
    if isinstance(welcome, dict) and bool(welcome.get("enabled", False)):
        return True

    items = dept.get("items")
    if isinstance(items, dict) and bool(items):
        return True

    return False


@router.get("/config")
def get_config(
    empresa_id: int = Query(..., description="ID da empresa"),
    instancia_id: int = Query(..., description="ID da instância"),
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
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

    row = _safe_select_chatbot_config(db, empresa_id, instancia_id)
    cfg_raw = _normalize_config_aliases(row.config if row and getattr(row, "config", None) else {})

    empresa = db.get(models.Empresa, empresa_id)
    empresa_nome = empresa.nome.strip() if empresa and empresa.nome else None

    deps_rows = []
    try:
        # O chatbot deve permitir escolher qualquer departamento ativo da empresa.
        # O vínculo DepartamentoInstancia controla outras regras da instância, mas
        # não deve esconder departamentos desta tela de configuração.
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
    background_tasks: BackgroundTasks,
    empresa_id: int = Query(..., description="ID da empresa"),
    instancia_id: int = Query(..., description="ID da instância"),
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
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

    cfg_in = _normalize_config_aliases(cfg_in)

    empresa = db.get(models.Empresa, empresa_id)
    if empresa:
        enforce_feature(
            empresa,
            "feature_automation",
            message="Seu plano não permite automações ou está vencido. Renove para continuar.",
        )

        if _has_advanced_automation_usage(cfg_in):
            enforce_feature(
                empresa,
                "feature_advanced_automation",
                message="Seu plano não permite automações avançadas ou está vencido. Renove para continuar.",
            )

    to_store = _prune_for_storage(cfg_in)

    features = (to_store.get("features") or {}) if isinstance(to_store, dict) else {}
    auto_active = _mode_is_active(features, "auto")
    dept_active = _mode_is_active(features, "dept")

    if auto_active and dept_active:
        raise HTTPException(
            status_code=409,
            detail={
                "message": "Mensagens automáticas e triagem por departamento não podem ficar ativas ao mesmo tempo para a mesma instância.",
                "code": "CHATBOT_MODE_CONFLICT",
            },
        )

    computed_ativo = bool(auto_active or dept_active)

    # Usa a mesma trava do disparo do chatbot. Assim, quando o PUT de
    # desligamento terminar, não existe envio antigo ainda atravessando a fila.
    _lock_chatbot_instance(
        db,
        empresa_id=int(empresa_id),
        instancia_id=int(instancia_id),
    )

    row = _safe_select_chatbot_config(db, empresa_id, instancia_id)
    creating = row is None

    if creating:
        row = models.ChatbotConfig(
            empresa_id=empresa_id,
            instancia_id=instancia_id,
            instancia_nome=inst.instance_name,
            config=to_store,
            ativo=computed_ativo,
        )
        _apply_columns_from_config(row, to_store)
        db.add(row)
    else:
        row.config = to_store
        row.ativo = computed_ativo
        row.instancia_nome = inst.instance_name
        _apply_columns_from_config(row, to_store)

    # Chatbot de departamentos desligado: libera atendimentos antigos sem
    # responsável para resposta manual direta, mantendo o departamento.
    released_waiting: list[dict[str, Any]] = []

    try:
        if not dept_active:
            released_waiting = release_unassigned_department_claims(
                db,
                empresa_id=int(empresa_id),
                instancia_id=int(instancia_id),
            )
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

    _queue_released_conversations_ws(
        background_tasks,
        empresa_id=int(empresa_id),
        released=released_waiting,
    )

    logger.info(
        "PUT chatbot/config OK emp=%s inst=%s creating=%s ativo=%s released_waiting=%s",
        empresa_id,
        instancia_id,
        creating,
        row.ativo,
        len(released_waiting),
    )
    return {
        "empresa_id": empresa_id,
        "instancia_id": instancia_id,
        "ativo": bool(row.ativo),
        "department_mode_active": bool(dept_active),
        "released_waiting_count": len(released_waiting),
        "config": row.config or {},
    }
