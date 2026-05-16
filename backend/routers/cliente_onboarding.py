# backend/routers/cliente_onboarding.py

from __future__ import annotations

import os
import re
import time
import threading
import unicodedata
from collections import Counter
from datetime import datetime, timedelta, timezone
from typing import Optional, Literal, List, Dict, Any

import requests
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from backend.database import get_db_session as get_db

try:
    from backend.database import SessionLocal  # p/ cleanup em background
except Exception:
    SessionLocal = None

from backend import models
from backend.utils.plans import plan_limit
from backend.utils.entitlements import enforce_billing_active, enforce_quota
from backend.routers.auth import require_admin

router = APIRouter(tags=["Onboarding"])  # montado como /api/onboarding/...


# =============================
# Helpers de segurança
# =============================
def _empresa_do_user(identity) -> Optional[int]:
    """
    Compatível com identity em dict ou objeto.
    """
    if isinstance(identity, dict):
        value = identity.get("empresa_id")
    else:
        value = getattr(identity, "empresa_id", None) or getattr(identity, "empresa", None)

    try:
        return int(value) if value is not None else None
    except Exception:
        return None


def _assert_empresa_access(identity, empresa_id: int) -> None:
    emp_user = _empresa_do_user(identity)
    if emp_user is not None and int(emp_user) != int(empresa_id):
        raise HTTPException(status_code=403, detail="Empresa inválida para este usuário")


def _get_empresa_or_404(db: Session, empresa_id: int) -> models.Empresa:
    empresa = db.query(models.Empresa).filter(models.Empresa.id == int(empresa_id)).first()
    if not empresa:
        raise HTTPException(status_code=404, detail="Empresa não encontrada.")
    return empresa


def _count_connected_instances(db: Session, empresa_id: int) -> int:
    return (
        db.query(models.EmpresaInstancia)
        .filter(
            models.EmpresaInstancia.empresa_id == int(empresa_id),
            models.EmpresaInstancia.connected.is_(True),
        )
        .count()
    )


# =============================
# Evolution API (ENV)
# =============================
EVOLUTION_URL = (os.getenv("EVOLUTION_URL") or "").rstrip("/")
EVOLUTION_KEY = os.getenv("EVOLUTION_APIKEY") or os.getenv("EVOLUTION_KEY")
HEADERS = {"apikey": EVOLUTION_KEY, "Content-Type": "application/json"} if EVOLUTION_KEY else {}


# =============================
# Helpers de plano
# =============================
def _max_instancias_for_empresa(empresa: models.Empresa) -> int:
    """
    Usa a fonte única do plano efetivo.
    Considera trial automaticamente via plans.py.
    """
    return int(plan_limit(empresa) or 0)


def _enforce_instance_creation_allowed(db: Session, empresa: models.Empresa) -> None:
    """
    Regra central para criação/reconexão operacional de instância.
    """
    enforce_billing_active(
        empresa,
        message="Seu plano está vencido. Renove para conectar ou reativar instâncias.",
    )

    limite = _max_instancias_for_empresa(empresa)
    if limite <= 0:
        raise HTTPException(
            status_code=403,
            detail="Seu plano atual não permite instâncias de WhatsApp.",
        )

    conectadas = _count_connected_instances(db, int(empresa.id))
    enforce_quota(
        empresa,
        "whatsapp_instances_max",
        conectadas,
        delta=1,
        message=f"Limite de instâncias atingido para o plano. Plano permite {limite} instância(s).",
    )


# =============================
# Payloads
# =============================
class ConnectPayload(BaseModel):
    empresa_id: int = Field(..., gt=0)
    empresa_nome: Optional[str] = None

    # QR Code não precisa de número.
    # Pairing Code precisa.
    whatsapp_numero: Optional[str] = ""

    # Opções oficiais do onboarding:
    # none = não restaurar
    # 24h  = últimas 24 horas
    # 7d   = últimos 7 dias
    # 30d  = últimos 30 dias
    historico_restaurar: Literal["none", "24h", "7d", "30d"] = "none"

    instance_name: Optional[str] = None
    use_pairing: bool = False
    apelido: Optional[str] = None


class SaudeNumeroPayload(BaseModel):
    empresa_id: int = Field(..., gt=0)
    limite_mensagens: int = Field(200, ge=50, le=1000)
    janela_horas: int = Field(24, ge=1, le=168)
    forcar_recalculo: bool = True


class AtualizarApelidoInstanciaPayload(BaseModel):
    empresa_id: int = Field(..., gt=0)
    apelido: str = Field(..., min_length=1, max_length=80)


# =============================
# HTTP / Evolution helpers
# =============================
def _http() -> requests.Session:
    s = requests.Session()
    if HEADERS:
        s.headers.update(HEADERS)
    return s


def _only_digits(s: str | None) -> str:
    return re.sub(r"\D", "", s or "")


def _normalize_historico_opcao(raw: str | None) -> str:
    """
    Normaliza a opção de histórico vinda do front/banco.

    O onboarding público aceita:
    - none
    - 24h
    - 7d
    - 30d

    Outras opções como all/full ficam reservadas para uso interno, mas aqui não são aceitas
    pelo ConnectPayload.
    """
    h = str(raw or "none").strip().lower()

    if h in {"", "none", "no", "nao", "não", "off", "false", "0"}:
        return "none"

    if h in {"24h", "24", "1d", "1dia", "1_dia", "dia", "ultimas_24h", "últimas_24h"}:
        return "24h"

    if h in {"7d", "7", "7dias", "7_dias", "semana", "1w", "week"}:
        return "7d"

    if h in {
        "30d",
        "30",
        "30dias",
        "30_dias",
        "1m",
        "1mes",
        "1_mes",
        "mes",
        "mês",
        "month",
        "30days",
    }:
        return "30d"

    # Segurança: opção desconhecida não dispara restauração.
    return "none"


def _slug(
    s: str | None,
    *,
    default: str = "empresa",
    max_len: int | None = None,
) -> str:
    raw = str(s or "").strip()

    if raw:
        raw = unicodedata.normalize("NFKD", raw)
        raw = raw.encode("ascii", "ignore").decode("ascii")

    slug = re.sub(r"[^a-zA-Z0-9]+", "-", raw).strip("-").lower()
    slug = re.sub(r"-{2,}", "-", slug).strip("-")

    if not slug:
        slug = default

    if max_len and max_len > 0 and len(slug) > max_len:
        slug = slug[:max_len].strip("-") or default

    return slug


def _gen_instance_name(
    empresa: models.Empresa,
    phone_e164: str | None,
    *,
    apelido: str | None = None,
) -> str:
    """
    Nome novo e legível para novas instâncias.

    Com número conhecido:
        emp5-comercial-5512991865418

    Sem número no QR:
        emp5-comercial-auto-123456

    Importante:
    - Não renomeia instâncias antigas.
    - Não renomeia depois que conecta, porque a Evolution usa esse instance_name.
    - O número real é salvo em numero_instancia pelo handler de CONNECTION_UPDATE.
    """
    digits = _only_digits(phone_e164 or "")

    if digits:
        phone_part = digits[-13:] if len(digits) > 13 else digits
    else:
        # QR Code: o número real ainda não existe antes da leitura.
        # Usa marcador técnico único. Depois a tela mostra numero_instancia real.
        phone_part = f"auto-{int(time.time())}"

    empresa_id = getattr(empresa, "id", None)
    try:
        empresa_id_i = int(empresa_id) if empresa_id is not None else None
    except Exception:
        empresa_id_i = None

    emp_part = f"emp{empresa_id_i}" if empresa_id_i else "emp"

    label_raw = (
        str(apelido or "").strip()
        or str(getattr(empresa, "nome", "") or "").strip()
        or "whatsapp"
    )
    label = _slug(label_raw, default="whatsapp", max_len=32)

    return _slug(
        f"{emp_part}-{label}-{phone_part}",
        default=f"{emp_part}-{phone_part}",
        max_len=90,
    )


def _evo_wait_instance_ready(sess: requests.Session, instance: str, timeout_s: int = 8) -> bool:
    if not EVOLUTION_URL:
        return False

    url = f"{EVOLUTION_URL}/instances"
    t0 = time.time()

    while time.time() - t0 < timeout_s:
        try:
            r = sess.get(url, timeout=10)
            if r.ok:
                arr = r.json() if (r.headers.get("content-type") or "").startswith("application/json") else []
                if isinstance(arr, list) and any(
                    (i.get("instance") or i.get("instanceName")) == instance for i in arr
                ):
                    return True
        except Exception:
            pass

        time.sleep(0.4)

    return False


def _should_sync_full_history(historico_restaurar: str | None) -> bool:
    """
    Liga Sync Full History quando o usuário pediu restauração.

    Importante:
    - Isso autoriza a Evolution/Baileys a gerar MESSAGES_SET.
    - O filtro real por período fica no messages_set.py:
      24h, 7d ou 30d.
    """
    h = _normalize_historico_opcao(historico_restaurar)
    return h in {"24h", "7d", "30d"}


def _settings_payload(sync_full_history: bool) -> dict:
    """
    Payload tolerante para /settings/set/{instance}.

    Mantemos opções conservadoras para não alterar comportamento do cliente.
    O ponto essencial aqui é syncFullHistory.
    """
    return {
        "rejectCall": False,
        "msgCall": "",
        "groupsIgnore": False,
        "alwaysOnline": False,
        "readMessages": False,
        "readStatus": False,
        "syncFullHistory": bool(sync_full_history),
    }


def _evo_set_settings_initial(instance: str, *, sync_full_history: bool) -> bool:
    """
    Configura settings antes do /instance/connect.

    Sem isso, MESSAGES_SET pode estar marcado no Rabbit,
    mas a Evolution/Baileys pode não gerar o pacote de histórico.
    """
    if not (EVOLUTION_URL and EVOLUTION_KEY and instance):
        return False

    s = _http()
    body = _settings_payload(sync_full_history)

    urls = [
        f"{EVOLUTION_URL}/settings/set/{instance}",
        f"{EVOLUTION_URL}/instance/settings/{instance}",
    ]

    ok_any = False

    for url in urls:
        try:
            r = s.post(url, json=body, timeout=20)
            if r.ok:
                ok_any = True
                break
        except Exception:
            pass

    return ok_any


# =============================
# Saúde do Número helpers
# =============================
def _norm_text(s: str | None) -> str:
    s = (s or "").strip().lower()
    s = re.sub(r"\s+", " ", s)
    return s


def _score_to_status(score: int) -> str:
    if score >= 80:
        return "critico"
    if score >= 60:
        return "alto_risco"
    if score >= 30:
        return "atencao"
    return "boa"


def _score_to_label(score: int) -> str:
    if score >= 80:
        return "Crítico"
    if score >= 60:
        return "Alto risco"
    if score >= 30:
        return "Atenção"
    return "Boa"


def _analisar_saude_mensagens(msgs: list[models.Mensagem]) -> dict:
    """
    Analisa as últimas mensagens 1:1 da instância e gera score de risco.
    MVP simples, explicável e bom para exibir no modal.
    """
    total = len(msgs)
    if total == 0:
        return {
            "score": 0,
            "status": "boa",
            "label": "Boa",
            "resumo": "Ainda não há mensagens suficientes para analisar esta instância.",
            "motivos": [],
            "metricas": {
                "mensagens_analisadas": 0,
                "saidas": 0,
                "entradas": 0,
                "repeticao_pct": 0,
                "intervalo_medio_seg": None,
                "taxa_sem_resposta_pct": 0,
            },
            "recomendacoes": [
                "Use a instância normalmente por algum tempo e faça uma nova consulta.",
            ],
        }

    saidas = [m for m in msgs if (m.tipo or "").lower() == "saida"]
    entradas = [m for m in msgs if (m.tipo or "").lower() == "entrada"]

    score = 0
    motivos: list[str] = []
    recomendacoes: list[str] = []

    textos_saida = [_norm_text(m.conteudo) for m in saidas if _norm_text(m.conteudo)]
    repeticao_pct = 0

    if textos_saida:
        counts = Counter(textos_saida)
        repetidas = sum(qtd for _, qtd in counts.items() if qtd > 1)
        repeticao_pct = round((repetidas / max(len(textos_saida), 1)) * 100)

        if repeticao_pct >= 70:
            score += 35
            motivos.append("Mensagens muito repetidas")
            recomendacoes.append("Varie mais os textos enviados.")
        elif repeticao_pct >= 40:
            score += 20
            motivos.append("Baixa variação nas mensagens")
            recomendacoes.append("Aumente a variação de abordagem e escrita.")

    intervalo_medio_seg = None
    if len(saidas) >= 2:
        saidas_ord = sorted(
            [m for m in saidas if m.timestamp],
            key=lambda m: m.timestamp,
        )
        diffs = []

        for i in range(1, len(saidas_ord)):
            a = saidas_ord[i - 1].timestamp
            b = saidas_ord[i].timestamp
            if a and b:
                try:
                    diffs.append((b - a).total_seconds())
                except Exception:
                    pass

        if diffs:
            intervalo_medio_seg = round(sum(diffs) / len(diffs), 2)
            if intervalo_medio_seg <= 8:
                score += 25
                motivos.append("Envio muito rápido em sequência")
                recomendacoes.append("Reduza a velocidade entre mensagens.")
            elif intervalo_medio_seg <= 15:
                score += 12
                motivos.append("Velocidade de envio acima do ideal")
                recomendacoes.append("Espalhe melhor os envios ao longo do tempo.")

    saidas_count = len(saidas)
    entradas_count = len(entradas)
    taxa_sem_resposta_pct = 0

    if saidas_count > 0:
        taxa_resposta = entradas_count / saidas_count
        taxa_sem_resposta_pct = round(max(0, (1 - min(taxa_resposta, 1)) * 100))

        if taxa_sem_resposta_pct >= 80 and saidas_count >= 15:
            score += 20
            motivos.append("Muitas mensagens sem resposta")
            recomendacoes.append("Priorize contatos mais engajados e reduza abordagens frias.")
        elif taxa_sem_resposta_pct >= 60 and saidas_count >= 10:
            score += 10
            motivos.append("Baixa taxa de resposta")
            recomendacoes.append("Revise o tom e a segmentação das mensagens.")

    if saidas_count >= 25 and saidas_count > max(entradas_count * 4, 0):
        score += 10
        motivos.append("Volume alto de saídas em comparação com respostas")
        recomendacoes.append("Tente manter conversas mais naturais e menos unilaterais.")

    score = max(0, min(int(score), 100))
    status = _score_to_status(score)
    label = _score_to_label(score)

    if not motivos:
        resumo = "O padrão recente parece saudável e sem sinais fortes de risco."
        recomendacoes = [
            "Continue evitando mensagens muito repetidas.",
            "Mantenha intervalos naturais entre os envios.",
        ]
    else:
        resumo = "O padrão recente desta instância apresenta sinais que podem aumentar o risco de restrição."

    recomendacoes_final = list(dict.fromkeys(recomendacoes))[:4]

    return {
        "score": score,
        "status": status,
        "label": label,
        "resumo": resumo,
        "motivos": motivos[:4],
        "metricas": {
            "mensagens_analisadas": total,
            "saidas": saidas_count,
            "entradas": entradas_count,
            "repeticao_pct": repeticao_pct,
            "intervalo_medio_seg": intervalo_medio_seg,
            "taxa_sem_resposta_pct": taxa_sem_resposta_pct,
        },
        "recomendacoes": recomendacoes_final,
    }


# =============================
# Listas de eventos
# =============================
def _events_minimal() -> List[str]:
    return [
        "MESSAGES_SET",
        "MESSAGES_UPSERT",
        "MESSAGES_UPDATE",
        "MESSAGES_DELETE",
        "SEND_MESSAGE",
        "CONTACTS_SET",
        "CONTACTS_UPSERT",
        "CONTACTS_UPDATE",
        "PRESENCE_UPDATE",
        "GROUPS_UPSERT",
        "GROUP_UPDATE",
        "GROUP_PARTICIPANTS_UPDATE",
    ]


def _ws_events_initial() -> List[str]:
    return ["QRCODE_UPDATED", "CONNECTION_UPDATE"]


def _rabbit_bindings() -> List[str]:
    return [
        b.strip()
        for b in (os.getenv("RABBITMQ_BINDINGS", "#") or "#").split(",")
        if b.strip()
    ]


# =============================
# Evolution – criação e assinatura inicial
# =============================
def _evo_create_instance(
    instance: str,
    use_pairing: bool,
    *,
    sync_full_history: bool = False,
) -> None:
    """
    Cria a instância já com Rabbit ouvindo os eventos mínimos.

    Também envia syncFullHistory quando o usuário escolhe restaurar histórico.
    Isso é necessário para a Evolution/Baileys gerar o pacote MESSAGES_SET.
    """
    if not (EVOLUTION_URL and EVOLUTION_KEY):
        return

    s = _http()
    payload = {
        "instanceName": instance,
        "integration": "WHATSAPP-BAILEYS",
        "qrcode": (not use_pairing),

        # Essencial para histórico inicial:
        "syncFullHistory": bool(sync_full_history),

        "rabbitmq": {
            "enabled": True,
            "exchange": os.getenv("RABBITMQ_EXCHANGE_NAME", "evolution_exchange"),
            "bindings": _rabbit_bindings(),
            "events": _events_minimal(),
        },
        "websocket": {
            "enabled": True,
            "events": _ws_events_initial(),
        },
        "settings": _settings_payload(sync_full_history),
    }

    try:
        r = s.post(f"{EVOLUTION_URL}/instance/create", json=payload, timeout=25)
        if r.status_code not in (200, 201, 202, 409):
            s.post(f"{EVOLUTION_URL}/instances/create", json=payload, timeout=25)
    except Exception:
        pass

    _evo_wait_instance_ready(s, instance, timeout_s=8)

    # Garante também pelo endpoint de settings, antes de conectar o QR.
    _evo_set_settings_initial(instance, sync_full_history=sync_full_history)


def _evo_set_rabbit_initial(instance: str) -> None:
    """
    Configura o Rabbit antes de chamar /instance/connect.

    Inclui MESSAGES_SET para a restauração chegar pelo Rabbit.
    """
    if not (EVOLUTION_URL and EVOLUTION_KEY):
        return

    s = _http()
    body = {
        "rabbitmq": {
            "enabled": True,
            "exchange": os.getenv("RABBITMQ_EXCHANGE_NAME", "evolution_exchange"),
            "bindings": _rabbit_bindings(),
            "events": _events_minimal(),
        }
    }

    try:
        s.post(f"{EVOLUTION_URL}/rabbitmq/set/{instance}", json=body, timeout=20)
    except Exception:
        pass


def _evo_set_websocket_initial(instance: str) -> None:
    if not (EVOLUTION_URL and EVOLUTION_KEY):
        return

    s = _http()
    body = {"websocket": {"enabled": True, "events": _ws_events_initial()}}

    try:
        s.post(f"{EVOLUTION_URL}/websocket/set/{instance}", json=body, timeout=15)
    except Exception:
        pass


def _evo_prepare_instance_before_connect(instance: str, *, sync_full_history: bool) -> None:
    """
    Ordem importante antes de gerar/conectar QR:
    1. Settings com syncFullHistory
    2. Rabbit com MESSAGES_SET
    3. WebSocket básico para QR/conexão
    """
    _evo_set_settings_initial(instance, sync_full_history=sync_full_history)
    _evo_set_rabbit_initial(instance)
    _evo_set_websocket_initial(instance)


def _evo_connect(instance: str, number_digits: str | None) -> dict:
    if not (EVOLUTION_URL and EVOLUTION_KEY):
        return {}

    s = _http()
    url = f"{EVOLUTION_URL}/instance/connect/{instance}"

    # Pairing Code usa número. QR Code não precisa.
    if number_digits:
        url += f"?number={_only_digits(number_digits)}"

    try:
        r = s.get(url, timeout=25)
        if r.ok and "application/json" in (r.headers.get("content-type") or "").lower():
            return r.json() or {}
    except Exception:
        pass

    return {}


def _evo_try_refresh_qr(instance: str, *, sync_full_history: bool = False) -> dict:
    _evo_prepare_instance_before_connect(instance, sync_full_history=sync_full_history)
    return _evo_connect(instance, None)


def _evo_delete_instance(instance: str) -> None:
    if not (EVOLUTION_URL and EVOLUTION_KEY and instance):
        return

    s = _http()
    attempts = [
        ("DELETE", f"{EVOLUTION_URL}/instance/delete/{instance}", None),
        ("DELETE", f"{EVOLUTION_URL}/instances/delete/{instance}", None),
        ("POST", f"{EVOLUTION_URL}/instance/delete/{instance}", None),
        ("POST", f"{EVOLUTION_URL}/instance/delete", {"instanceName": instance}),
        ("POST", f"{EVOLUTION_URL}/instances/delete", {"instance": instance}),
    ]

    for method, url, body in attempts:
        try:
            r = s.delete(url, timeout=15) if method == "DELETE" else s.post(url, json=body, timeout=15)
            if r.status_code in (200, 202, 204, 404):
                return
        except Exception:
            pass


# =============================
# Auto-cleanup (apenas BD)
# =============================
_CLEANUP_TIMERS: Dict[str, threading.Timer] = {}
_CLEANUP_SECONDS = int(os.getenv("ONBOARDING_CLEANUP_SECONDS", "120"))


def _cleanup_if_still_disconnected(instance: str):
    if SessionLocal is not None:
        try:
            db: Session = SessionLocal()  # type: ignore
            try:
                row = db.query(models.EmpresaInstancia).filter(
                    models.EmpresaInstancia.instance_name == instance
                ).first()

                if not row:
                    return

                if bool(getattr(row, "connected", False)):
                    return

                instancia_id = int(row.id)

                has_data = False
                checks = [
                    "SELECT 1 FROM mensagens WHERE instancia_id = :iid LIMIT 1",
                    "SELECT 1 FROM midias WHERE instancia_id = :iid LIMIT 1",
                    "SELECT 1 FROM clientes WHERE instancia_id = :iid LIMIT 1",
                    "SELECT 1 FROM grupos WHERE instancia_id = :iid LIMIT 1",
                    "SELECT 1 FROM atendimentos WHERE instancia_id = :iid LIMIT 1",
                    "SELECT 1 FROM chatbot_configs WHERE instancia_id = :iid LIMIT 1",
                    "SELECT 1 FROM mensagens_grupo WHERE instancia_id = :iid LIMIT 1",
                    """
                    SELECT 1 FROM mensagens_grupo
                    WHERE grupo_id IN (SELECT id FROM grupos WHERE instancia_id = :iid)
                    LIMIT 1
                    """,
                    """
                    SELECT 1 FROM midias
                    WHERE mensagem_id IN (SELECT id FROM mensagens WHERE instancia_id = :iid)
                    LIMIT 1
                    """,
                ]

                for sql in checks:
                    if db.execute(text(sql), {"iid": instancia_id}).first():
                        has_data = True
                        break

                if has_data:
                    return

                if not bool(getattr(row, "connected", False)):
                    db.delete(row)
                    db.commit()
            finally:
                db.close()
        except Exception:
            pass

    _CLEANUP_TIMERS.pop(instance, None)


def _schedule_cleanup(instance: str):
    if _CLEANUP_SECONDS <= 0:
        return

    t = _CLEANUP_TIMERS.get(instance)
    if t:
        try:
            t.cancel()
        except Exception:
            pass

    timer = threading.Timer(_CLEANUP_SECONDS, _cleanup_if_still_disconnected, args=(instance,))
    timer.daemon = True
    _CLEANUP_TIMERS[instance] = timer
    timer.start()


def cancel_auto_cleanup(instance: str):
    t = _CLEANUP_TIMERS.pop(instance, None)
    if t:
        try:
            t.cancel()
        except Exception:
            pass


# =============================
# Rotas
# =============================
@router.post("/empresas/conectar")
def conectar(
    payload: ConnectPayload,
    db: Session = Depends(get_db),
    identity=Depends(require_admin),
):
    if not EVOLUTION_URL or not EVOLUTION_KEY:
        raise HTTPException(500, "Evolution API não configurada (EVOLUTION_URL/KEY).")

    _assert_empresa_access(identity, int(payload.empresa_id))

    empresa = _get_empresa_or_404(db, int(payload.empresa_id))

    # trava por vencimento + quota
    _enforce_instance_creation_allowed(db, empresa)

    use_pairing = bool(payload.use_pairing)
    number_digits = _only_digits(payload.whatsapp_numero)
    historico_restaurar = _normalize_historico_opcao(payload.historico_restaurar)
    sync_full_history = _should_sync_full_history(historico_restaurar)

    apelido_clean = str(payload.apelido or "").strip() or None

    if not apelido_clean:
        raise HTTPException(400, "Informe um apelido para identificar esta instância.")

    # Pairing Code precisa de número. QR Code não.
    if use_pairing and not number_digits:
        raise HTTPException(400, "Número de WhatsApp inválido para Pairing Code.")

    # Se veio número, tenta reaproveitar pendente daquele número.
    # Se QR veio sem número, cria nova instância temporária e depois CONNECTION_UPDATE salva o número real.
    pendente = None
    if number_digits:
        pendente = db.query(models.EmpresaInstancia).filter(
            models.EmpresaInstancia.empresa_id == int(empresa.id),
            models.EmpresaInstancia.numero_instancia == number_digits,
            models.EmpresaInstancia.connected.is_(False),
        ).first()

    if pendente:
        pendente.apelido = apelido_clean
        pendente.historico_restaurar = historico_restaurar
        db.commit()

        _evo_prepare_instance_before_connect(
            pendente.instance_name,
            sync_full_history=sync_full_history,
        )

        conn_json = _evo_connect(
            pendente.instance_name,
            number_digits if use_pairing else None,
        )
        _schedule_cleanup(pendente.instance_name)

        qr = {}
        if isinstance(conn_json, dict):
            qrd = conn_json.get("qrcode") or conn_json
            if isinstance(qrd, dict):
                if qrd.get("base64") or qrd.get("image"):
                    qr = {
                        "base64": qrd.get("base64") or qrd.get("image"),
                        "limit": qrd.get("limit") or qrd.get("timeout"),
                    }

                if qrd.get("pairingCode") or qrd.get("code"):
                    qr = {
                        "pairingCode": qrd.get("pairingCode") or qrd.get("code"),
                        "limit": qrd.get("limit") or qrd.get("timeout"),
                    }

        return {
            "ok": True,
            "instance": pendente.instance_name,
            "instancia_id": int(pendente.id),
            "qrcode": qr or None,
            "numero": pendente.numero_instancia,
            "historico_restaurar": pendente.historico_restaurar,
        }

    # Só bloqueia duplicidade por número se o número foi informado.
    # No QR sem número, o número real só aparece depois da leitura.
    if number_digits:
        numero_con = db.query(models.EmpresaInstancia).filter(
            models.EmpresaInstancia.numero_instancia == number_digits,
            models.EmpresaInstancia.connected.is_(True),
        ).first()

        if numero_con:
            raise HTTPException(409, "Este número já está conectado em outra instância.")

    if payload.instance_name:
        inst = _slug(payload.instance_name, default="instancia", max_len=90)
    else:
        inst = _gen_instance_name(
            empresa,
            number_digits if number_digits else None,
            apelido=apelido_clean,
        )

    if not inst:
        raise HTTPException(400, "instance_name inválido.")

    exists_name = db.query(models.EmpresaInstancia).filter(
        models.EmpresaInstancia.instance_name == inst
    ).first()

    if exists_name:
        if int(exists_name.empresa_id) != int(empresa.id):
            raise HTTPException(409, "instance_name já está em uso.")

        base = inst
        i = 2
        while True:
            trial = f"{base}-{i}"
            if not db.query(models.EmpresaInstancia).filter(
                models.EmpresaInstancia.instance_name == trial
            ).first():
                inst = trial
                break
            i += 1

    _evo_create_instance(
        inst,
        use_pairing,
        sync_full_history=sync_full_history,
    )
    _evo_prepare_instance_before_connect(
        inst,
        sync_full_history=sync_full_history,
    )

    inst_row = db.query(models.EmpresaInstancia).filter(
        models.EmpresaInstancia.instance_name == inst
    ).first()

    try:
        if not inst_row:
            inst_row = models.EmpresaInstancia(
                empresa_id=int(empresa.id),
                instance_name=inst,
                connected=False,

                # QR Code sem número: fica None até CONNECTION_UPDATE salvar o número real.
                numero_instancia=(number_digits or None),

                apelido=apelido_clean,
                historico_restaurar=historico_restaurar,
            )
            db.add(inst_row)
            db.flush()
        else:
            if number_digits and not getattr(inst_row, "numero_instancia", None):
                inst_row.numero_instancia = number_digits

            inst_row.apelido = apelido_clean
            inst_row.historico_restaurar = historico_restaurar

        if hasattr(empresa, "quantidade_instancias"):
            empresa.quantidade_instancias = _count_connected_instances(db, int(empresa.id))

        db.commit()

    except IntegrityError:
        db.rollback()

        conflito = None
        if number_digits:
            conflito = db.query(models.EmpresaInstancia).filter(
                models.EmpresaInstancia.numero_instancia == number_digits
            ).first()

        if conflito and not conflito.connected and int(conflito.empresa_id) == int(empresa.id):
            conflito.apelido = apelido_clean
            conflito.historico_restaurar = historico_restaurar
            db.commit()

            _evo_prepare_instance_before_connect(
                conflito.instance_name,
                sync_full_history=sync_full_history,
            )

            conn_json = _evo_connect(
                conflito.instance_name,
                number_digits if use_pairing else None,
            )
            _schedule_cleanup(conflito.instance_name)

            qr = {}
            if isinstance(conn_json, dict):
                qrd = conn_json.get("qrcode") or conn_json
                if isinstance(qrd, dict):
                    if qrd.get("base64") or qrd.get("image"):
                        qr = {
                            "base64": qrd.get("base64") or qrd.get("image"),
                            "limit": qrd.get("limit") or qrd.get("timeout"),
                        }

                    if qrd.get("pairingCode") or qrd.get("code"):
                        qr = {
                            "pairingCode": qrd.get("pairingCode") or qrd.get("code"),
                            "limit": qrd.get("limit") or qrd.get("timeout"),
                        }

            return {
                "ok": True,
                "instance": conflito.instance_name,
                "instancia_id": int(conflito.id),
                "qrcode": qr or None,
                "numero": conflito.numero_instancia,
                "historico_restaurar": conflito.historico_restaurar,
            }

        raise HTTPException(409, "Este número já está cadastrado em uma instância.")

    conn_json = _evo_connect(
        inst,
        number_digits if use_pairing else None,
    )
    _schedule_cleanup(inst)

    qr = {}
    if isinstance(conn_json, dict):
        qrd = conn_json.get("qrcode") or conn_json
        if isinstance(qrd, dict):
            if qrd.get("base64") or qrd.get("image"):
                qr = {
                    "base64": qrd.get("base64") or qrd.get("image"),
                    "limit": qrd.get("limit") or qrd.get("timeout"),
                }

            if qrd.get("pairingCode") or qrd.get("code"):
                qr = {
                    "pairingCode": qrd.get("pairingCode") or qrd.get("code"),
                    "limit": qrd.get("limit") or qrd.get("timeout"),
                }

    return {
        "ok": True,
        "instance": inst,
        "instancia_id": int(inst_row.id),
        "qrcode": qr or None,
        "numero": inst_row.numero_instancia,
        "historico_restaurar": inst_row.historico_restaurar,
    }


@router.post("/empresas/qr/refresh/{instance}")
def refresh_qr(
    instance: str,
    db: Session = Depends(get_db),
    identity=Depends(require_admin),
):
    if not instance:
        raise HTTPException(400, "instance inválida.")

    row = db.query(models.EmpresaInstancia).filter(
        models.EmpresaInstancia.instance_name == instance
    ).first()

    if not row:
        raise HTTPException(status_code=404, detail="Instância não encontrada.")

    _assert_empresa_access(identity, int(row.empresa_id))

    empresa = _get_empresa_or_404(db, int(row.empresa_id))
    enforce_billing_active(
        empresa,
        message="Seu plano está vencido. Renove para reativar ou atualizar QR de instâncias.",
    )

    historico_restaurar = _normalize_historico_opcao(getattr(row, "historico_restaurar", None))
    sync_full_history = _should_sync_full_history(historico_restaurar)

    _evo_prepare_instance_before_connect(
        instance,
        sync_full_history=sync_full_history,
    )

    js = _evo_try_refresh_qr(
        instance,
        sync_full_history=sync_full_history,
    )

    qr = {}
    if isinstance(js, dict):
        qrd = js.get("qrcode") or js
        if isinstance(qrd, dict):
            if qrd.get("base64") or qrd.get("image"):
                qr = {
                    "base64": qrd.get("base64") or qrd.get("image"),
                    "limit": qrd.get("limit") or qrd.get("timeout"),
                }

            if qrd.get("pairingCode") or qrd.get("code"):
                qr = {
                    "pairingCode": qrd.get("pairingCode") or qrd.get("code"),
                    "limit": qrd.get("limit") or qrd.get("timeout"),
                }

    return {
        "ok": True,
        "instance": instance,
        "qrcode": (qr or None),
        "historico_restaurar": historico_restaurar,
    }


@router.post("/empresas/instancias/{instancia_id}/apelido")
def atualizar_apelido_instancia(
    instancia_id: int,
    payload: AtualizarApelidoInstanciaPayload,
    db: Session = Depends(get_db),
    identity=Depends(require_admin),
):
    """
    Atualiza somente o apelido interno da instância no ZapsChat.

    Importante:
    - Não renomeia a instância na Evolution.
    - Não altera instance_name.
    - Não desconecta o WhatsApp.
    """
    _assert_empresa_access(identity, int(payload.empresa_id))

    apelido_clean = re.sub(r"\s+", " ", str(payload.apelido or "").strip())

    if not apelido_clean:
        raise HTTPException(status_code=400, detail="Informe um apelido para a instância.")

    if len(apelido_clean) > 80:
        raise HTTPException(status_code=400, detail="O apelido pode ter no máximo 80 caracteres.")

    inst = db.query(models.EmpresaInstancia).filter(
        models.EmpresaInstancia.id == int(instancia_id),
        models.EmpresaInstancia.empresa_id == int(payload.empresa_id),
    ).first()

    if not inst:
        raise HTTPException(status_code=404, detail="Instância não encontrada.")

    inst.apelido = apelido_clean

    db.add(inst)
    db.commit()
    db.refresh(inst)

    return {
        "ok": True,
        "instancia_id": int(inst.id),
        "instance": inst.instance_name,
        "apelido": inst.apelido,
        "numero": inst.numero_instancia,
    }


@router.post("/empresas/instancias/{instancia_id}/saude")
def consultar_saude_numero(
    instancia_id: int,
    payload: SaudeNumeroPayload,
    db: Session = Depends(get_db),
    identity=Depends(require_admin),
):
    """
    Consulta sob demanda a saúde do número:
    - busca últimas mensagens da instância
    - calcula score de risco
    - salva o resultado completo na instância
    - devolve resumo para o modal do front
    """
    _assert_empresa_access(identity, int(payload.empresa_id))

    empresa = _get_empresa_or_404(db, int(payload.empresa_id))
    enforce_billing_active(
        empresa,
        message="Seu plano está vencido. Renove para consultar a saúde das instâncias.",
    )

    inst = db.query(models.EmpresaInstancia).filter(
        models.EmpresaInstancia.id == int(instancia_id),
        models.EmpresaInstancia.empresa_id == int(payload.empresa_id),
    ).first()

    if not inst:
        raise HTTPException(status_code=404, detail="Instância não encontrada.")

    dt_min = datetime.now(timezone.utc) - timedelta(hours=int(payload.janela_horas))

    msgs = db.query(models.Mensagem).filter(
        models.Mensagem.empresa_id == int(payload.empresa_id),
        models.Mensagem.instancia_id == int(inst.id),
        models.Mensagem.timestamp >= dt_min,
        models.Mensagem.conteudo.isnot(None),
        models.Mensagem.conteudo != "",
    ).order_by(
        models.Mensagem.timestamp.desc()
    ).limit(
        int(payload.limite_mensagens)
    ).all()

    analise = _analisar_saude_mensagens(msgs)
    agora = datetime.now(timezone.utc)

    inst.score = analise["score"]
    inst.score_status = analise["status"]
    inst.score_label = analise["label"]
    inst.score_resumo = analise["resumo"]
    inst.score_motivos = analise["motivos"]
    inst.score_metricas = analise["metricas"]
    inst.score_recomendacoes = analise["recomendacoes"]
    inst.score_atualizado_em = agora

    db.add(inst)
    db.commit()
    db.refresh(inst)

    return {
        "ok": True,
        "instancia_id": int(inst.id),
        "instance": inst.instance_name,
        "apelido": inst.apelido,
        "numero": inst.numero_instancia,
        "score": inst.score,
        "score_status": inst.score_status,
        "score_label": inst.score_label,
        "score_resumo": inst.score_resumo,
        "score_motivos": inst.score_motivos,
        "score_metricas": inst.score_metricas,
        "score_recomendacoes": inst.score_recomendacoes,
        "score_atualizado_em": inst.score_atualizado_em.isoformat() if inst.score_atualizado_em else None,
        "saude": {
            **analise,
            "consultado_em": agora.isoformat(),
        },
    }


# ============================================================
# UTIL: listener chama quando CONNECTED (cancela cleanup)
# ============================================================
def marcar_conectado_e_cancelar_cleanup(instance: str, db: Session):
    row = db.query(models.EmpresaInstancia).filter(
        models.EmpresaInstancia.instance_name == instance
    ).first()

    if row:
        row.connected = True

        emp = db.query(models.Empresa).filter(models.Empresa.id == row.empresa_id).first()
        if emp and hasattr(emp, "quantidade_instancias"):
            emp.quantidade_instancias = _count_connected_instances(db, int(emp.id))

        db.commit()

    cancel_auto_cleanup(instance)