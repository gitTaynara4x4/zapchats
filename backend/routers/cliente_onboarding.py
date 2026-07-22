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
from fastapi import APIRouter, Depends, HTTPException, Body, Query
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

# O histórico inicial é entregue exclusivamente ao n8n.
# A URL é obrigatória no ambiente; não existe fallback fixo dentro do código.
EVOLUTION_HISTORY_OWNER = (os.getenv("EVOLUTION_HISTORY_OWNER") or "n8n").strip().lower()
EVOLUTION_HISTORY_WEBHOOK_URL = (os.getenv("EVOLUTION_HISTORY_WEBHOOK_URL") or "").strip()
EVOLUTION_HISTORY_WEBHOOK_SECRET = (os.getenv("EVOLUTION_HISTORY_WEBHOOK_SECRET") or "").strip()
_HISTORY_WEBHOOK_EVENTS = ["MESSAGES_SET"]


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


class RefreshQRPayload(BaseModel):
    # QR Code não precisa de número.
    # Código de pareamento precisa do número com DDI/DDD.
    whatsapp_numero: Optional[str] = ""
    use_pairing: bool = False


class SaudeNumeroPayload(BaseModel):
    empresa_id: int = Field(..., gt=0)
    limite_mensagens: int = Field(200, ge=50, le=1000)
    janela_horas: int = Field(24, ge=1, le=168)
    forcar_recalculo: bool = True


class AtualizarApelidoInstanciaPayload(BaseModel):
    empresa_id: int = Field(..., gt=0)
    apelido: str = Field(..., min_length=1, max_length=80)


class ImportarHistoricoInstanciaPayload(BaseModel):
    empresa_id: int = Field(..., gt=0)
    # Importação manual só aceita as opções exibidas no painel.
    historico_restaurar: Literal["24h", "7d", "30d"] = "24h"


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


def _looks_like_pairing_code(value: str | None) -> bool:
    raw = str(value or "").strip().replace("-", "").replace(" ", "")
    return bool(raw) and len(raw) <= 12 and raw.isalnum()


def _first_non_empty(*values):
    for value in values:
        if value is None:
            continue
        s = str(value).strip()
        if s:
            return s
    return ""


def _extract_qr_payload(js: dict | None, *, prefer_pairing: bool = False) -> dict:
    """
    Normaliza a resposta de /instance/connect.

    Algumas versões da Evolution devolvem, na mesma resposta, `base64`, `code`
    e `pairingCode`. Quando o usuário escolheu código no telefone, o código de
    pareamento deve ter prioridade absoluta e nenhuma imagem QR deve ser
    devolvida ao front.
    """
    if not isinstance(js, dict):
        return {}

    candidates: list[dict] = []
    seen: set[int] = set()

    def add_candidate(value: Any) -> None:
        if not isinstance(value, dict):
            return
        ident = id(value)
        if ident in seen:
            return
        seen.add(ident)
        candidates.append(value)

    # Procura tanto no nível principal quanto em `data`, `qrcode` e `qr`.
    # O pairingCode frequentemente vem no topo enquanto o base64 vem aninhado.
    add_candidate(js)
    data = js.get("data")
    add_candidate(data)

    for container in tuple(candidates):
        add_candidate(container.get("qrcode"))
        add_candidate(container.get("qr"))

    limit = ""
    for item in reversed(candidates):
        limit = _first_non_empty(
            item.get("limit"),
            item.get("timeout"),
            item.get("count"),
            item.get("qr_limit"),
        )
        if limit:
            break

    def first_from(keys: tuple[str, ...]) -> str:
        for item in reversed(candidates):
            value = _first_non_empty(*(item.get(key) for key in keys))
            if value:
                return value
        return ""

    explicit_pairing = first_from(("pairingCode", "pairing_code", "pairing"))

    if prefer_pairing:
        if explicit_pairing:
            return {"pairingCode": explicit_pairing, "limit": limit or None}

        # Em algumas versões, o código de pareamento vem apenas em `code`.
        # Só aceitamos valores curtos para não confundir o texto longo do QR.
        for item in reversed(candidates):
            for key in ("code", "qrCode", "qr_code", "qrText", "qr_text", "qr"):
                value = _first_non_empty(item.get(key))
                if value and _looks_like_pairing_code(value):
                    return {"pairingCode": value, "limit": limit or None}

        # O modo escolhido foi pairing: nunca devolve base64/QR como fallback.
        return {}

    b64 = first_from(("base64", "image", "codeBase64", "qrBase64"))
    if b64:
        return {"base64": b64, "limit": limit or None}

    code = first_from(("qrText", "qr_text", "qrCode", "qr_code", "qr", "code"))
    if code:
        return {"code": code, "qrText": code, "limit": limit or None}

    # Mantém compatibilidade caso a Evolution devolva apenas pairingCode.
    if explicit_pairing:
        return {"pairingCode": explicit_pairing, "limit": limit or None}

    return {}


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


def _remember_qr_recent_for_history(instance: str | None) -> None:
    """Marca QR/pairing gerado para liberar histórico no CONNECTION_UPDATE.

    O QR também pode ser retornado direto por /instance/connect, sem passar antes
    pelo evento QRCODE_UPDATED. Por isso marcamos aqui também.
    """
    inst = str(instance or "").strip()
    if not inst:
        return

    try:
        from backend.integrations.evolution.handlers._state import remember_qr_emitted
        remember_qr_emitted(inst)
    except Exception:
        pass


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
    - O evento é entregue exclusivamente ao webhook do n8n.
    - O n8n fará posteriormente o filtro real por 24h, 7d ou 30d.
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


def _history_webhook_payloads() -> list[dict]:
    """Payloads compatíveis com versões diferentes da Evolution API.

    A versão exibida no painel usa o objeto ``webhook`` com ``byEvents`` e
    ``base64``. Algumas versões antigas aceitam o corpo sem o wrapper e usam
    nomes diferentes para os mesmos campos. Todos os payloads ativam somente
    MESSAGES_SET e mantêm Base64/Webhook by Events desligados.
    """
    config = {
        "enabled": True,
        "url": EVOLUTION_HISTORY_WEBHOOK_URL,
        "byEvents": False,
        "base64": False,
        "events": list(_HISTORY_WEBHOOK_EVENTS),
    }

    if EVOLUTION_HISTORY_WEBHOOK_SECRET:
        config["headers"] = {
            "X-ZapsChat-History-Secret": EVOLUTION_HISTORY_WEBHOOK_SECRET,
        }

    legacy_camel = {
        "enabled": True,
        "url": EVOLUTION_HISTORY_WEBHOOK_URL,
        "webhookByEvents": False,
        "webhookBase64": False,
        "events": list(_HISTORY_WEBHOOK_EVENTS),
    }
    legacy_snake = {
        "enabled": True,
        "url": EVOLUTION_HISTORY_WEBHOOK_URL,
        "webhook_by_events": False,
        "webhook_base64": False,
        "events": list(_HISTORY_WEBHOOK_EVENTS),
    }
    if EVOLUTION_HISTORY_WEBHOOK_SECRET:
        legacy_camel["headers"] = dict(config["headers"])
        legacy_snake["headers"] = dict(config["headers"])

    return [
        {"webhook": dict(config)},
        dict(config),
        legacy_camel,
        legacy_snake,
    ]


def _evo_set_history_webhook_initial(instance: str) -> bool:
    """Configura o webhook do n8n antes da geração do QR Code.

    A função só retorna ``True`` após a Evolution aceitar um payload com HTTP
    2xx. O fluxo de conexão com restauração de histórico não segue para o QR se
    esta etapa falhar, evitando conectar o WhatsApp sem destino para o
    MESSAGES_SET.
    """
    if not (EVOLUTION_URL and EVOLUTION_KEY and instance and EVOLUTION_HISTORY_WEBHOOK_URL):
        return False

    if not re.match(r"^https?://", EVOLUTION_HISTORY_WEBHOOK_URL, flags=re.IGNORECASE):
        return False

    s = _http()
    url = f"{EVOLUTION_URL}/webhook/set/{instance}"

    for body in _history_webhook_payloads():
        try:
            r = s.post(url, json=body, timeout=20)
            if r.ok:
                return True
        except Exception:
            continue

    return False


def _evo_set_settings_initial(instance: str, *, sync_full_history: bool) -> bool:
    """
    Configura settings antes do /instance/connect.

    Sem isso, a Evolution/Baileys pode não gerar o pacote MESSAGES_SET
    que será entregue ao webhook do n8n.
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
    """Eventos em tempo real enviados ao RabbitMQ do ZapsChat.

    MESSAGES_SET não entra nesta lista: o histórico inicial pertence
    exclusivamente ao webhook do n8n.
    """
    return [
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
    """Cria a instância sem iniciar a sincronização de histórico.

    O parâmetro ``sync_full_history`` é mantido por compatibilidade com as
    chamadas existentes, mas a ativação acontece somente depois que a instância
    estiver pronta e o webhook do n8n tiver sido configurado. Isso evita a
    Evolution gerar MESSAGES_SET antes de existir um destino para o evento.
    """
    if not (EVOLUTION_URL and EVOLUTION_KEY):
        return

    s = _http()
    payload = {
        "instanceName": instance,
        "integration": "WHATSAPP-BAILEYS",
        "qrcode": (not use_pairing),

        # Nunca iniciar histórico durante /instance/create. Primeiro o fluxo
        # configura /webhook/set e só depois ativa syncFullHistory em /settings/set.
        "syncFullHistory": False,

        # A Evolution controla exchange/fila pelo modo global do próprio container.
        # No /instance/create e /rabbitmq/set, mande só enabled/events;
        # campos como exchange/bindings são ignorados ou podem quebrar o DTO em algumas versões.
        "rabbitmq": {
            "enabled": True,
            "events": _events_minimal(),
        },
        "websocket": {
            "enabled": True,
            "events": _ws_events_initial(),
        },
        "settings": _settings_payload(False),
    }

    try:
        r = s.post(f"{EVOLUTION_URL}/instance/create", json=payload, timeout=25)
        if r.status_code not in (200, 201, 202, 409):
            s.post(f"{EVOLUTION_URL}/instances/create", json=payload, timeout=25)
    except Exception:
        pass

    _evo_wait_instance_ready(s, instance, timeout_s=8)

    # Não chama settings aqui de novo. O fluxo de conectar chama
    # _evo_prepare_instance_before_connect uma única vez logo depois.


def _evo_rabbit_payloads() -> list[dict]:
    """Payloads compatíveis com versões diferentes da Evolution.

    Algumas versões esperam {"rabbitmq": {...}}; outras aceitam o corpo flat
    {"enabled": true, "events": [...]}. Em ambos os casos, NÃO mandamos
    exchange/bindings aqui, porque isso pertence ao modo global do container
    Evolution, não ao endpoint por instância.
    """
    events = _events_minimal()
    return [
        {"rabbitmq": {"enabled": True, "events": events}},
        {"enabled": True, "events": events},
    ]


def _evo_set_rabbit_initial(instance: str) -> bool:
    """Configura o Rabbit da instância sem MESSAGES_SET.

    O Rabbit continua responsável pelos eventos em tempo real do ZapsChat.
    O histórico inicial é enviado somente ao webhook do n8n.
    """
    if not (EVOLUTION_URL and EVOLUTION_KEY and instance):
        return False

    s = _http()
    ok_any = False

    for body in _evo_rabbit_payloads():
        try:
            r = s.post(f"{EVOLUTION_URL}/rabbitmq/set/{instance}", json=body, timeout=20)
            if r.ok:
                ok_any = True
                break
        except Exception:
            pass

    return ok_any


def _evo_set_websocket_initial(instance: str) -> None:
    if not (EVOLUTION_URL and EVOLUTION_KEY):
        return

    s = _http()
    body = {"websocket": {"enabled": True, "events": _ws_events_initial()}}

    try:
        s.post(f"{EVOLUTION_URL}/websocket/set/{instance}", json=body, timeout=15)
    except Exception:
        pass


def _evo_prepare_instance_before_connect(instance: str, *, sync_full_history: bool) -> dict:
    """Prepara a instância antes de gerar o QR Code.

    Ordem obrigatória do novo fluxo:
    1. Webhook do n8n com somente MESSAGES_SET;
    2. Settings com syncFullHistory;
    3. Rabbit já utilizado pelo restante do ZapsChat;
    4. WebSocket básico de QR/conexão.

    O webhook é obrigatório para toda instância. Quando o usuário pediu
    histórico, syncFullHistory também é obrigatório. Em caso de falha o QR
    não é gerado.
    """
    webhook_ok = _evo_set_history_webhook_initial(instance)
    if not webhook_ok:
        raise HTTPException(
            status_code=502,
            detail=(
                "Não foi possível configurar o webhook exclusivo de histórico do n8n na Evolution. "
                "O QR Code não foi gerado para evitar que MESSAGES_SET seja perdido."
            ),
        )

    settings_ok = _evo_set_settings_initial(
        instance,
        sync_full_history=sync_full_history,
    )
    if sync_full_history and not settings_ok:
        raise HTTPException(
            status_code=502,
            detail=(
                "Não foi possível ativar syncFullHistory na Evolution. "
                "O QR Code não foi gerado."
            ),
        )

    rabbit_ok = _evo_set_rabbit_initial(instance)
    _evo_set_websocket_initial(instance)

    return {
        "history_webhook": bool(webhook_ok),
        "sync_full_history": bool(settings_ok and sync_full_history),
        "rabbit": bool(rabbit_ok),
    }


def _evo_connect(instance: str, number_digits: str | None) -> dict:
    if not (EVOLUTION_URL and EVOLUTION_KEY):
        return {}

    # Importante para o histórico escolhido no modal funcionar quando o QR for lido.
    # Às vezes a Evolution devolve o QR diretamente nesse endpoint e não dispara
    # QRCODE_UPDATED antes do CONNECTION_UPDATE.
    _remember_qr_recent_for_history(instance)

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


def _evo_extract_connection_state(obj: Any, *, instance: str | None = None, depth: int = 0) -> str | None:
    """
    Extrai o estado de conexão de respostas diferentes da Evolution.
    Versões diferentes podem retornar state/status/connectionStatus em locais diferentes.
    """
    if depth > 5 or obj is None:
        return None

    if isinstance(obj, str):
        raw = obj.strip()
        low = raw.lower()
        if low in {"open", "connected", "close", "closed", "connecting", "disconnected", "logout", "loggedout"}:
            return raw
        return None

    if isinstance(obj, dict):
        inst_ref = str(instance or "").strip()

        # Quando a resposta é uma lista de instâncias transformada em dict, valida pelo nome.
        if inst_ref:
            possible_name = (
                obj.get("instanceName")
                or obj.get("instance_name")
                or obj.get("instance")
                or obj.get("name")
            )
            if isinstance(possible_name, dict):
                possible_name = (
                    possible_name.get("instanceName")
                    or possible_name.get("instance_name")
                    or possible_name.get("instance")
                    or possible_name.get("name")
                )
            if possible_name and str(possible_name) != inst_ref:
                # Ainda pode ser um wrapper com data/instance dentro, então não retorna aqui.
                pass

        for key in ("state", "status", "connectionStatus", "connection", "connection_state"):
            if key in obj:
                found = _evo_extract_connection_state(obj.get(key), instance=instance, depth=depth + 1)
                if found:
                    return found

        for key in ("instance", "data", "response", "result"):
            if key in obj:
                found = _evo_extract_connection_state(obj.get(key), instance=instance, depth=depth + 1)
                if found:
                    return found

        for value in obj.values():
            found = _evo_extract_connection_state(value, instance=instance, depth=depth + 1)
            if found:
                return found

    if isinstance(obj, list):
        inst_ref = str(instance or "").strip()
        for item in obj:
            if isinstance(item, dict) and inst_ref:
                possible_name = (
                    item.get("instanceName")
                    or item.get("instance_name")
                    or item.get("name")
                )
                inst_obj = item.get("instance")
                if isinstance(inst_obj, dict):
                    possible_name = possible_name or inst_obj.get("instanceName") or inst_obj.get("instance_name") or inst_obj.get("name")
                elif isinstance(inst_obj, str):
                    possible_name = possible_name or inst_obj

                if possible_name and str(possible_name) != inst_ref:
                    continue

            found = _evo_extract_connection_state(item, instance=instance, depth=depth + 1)
            if found:
                return found

    return None


def _state_is_connected(raw: Any) -> bool:
    return str(raw or "").strip().lower() in {"open", "connected"}


def _evo_connection_state(instance: str) -> tuple[bool, str | None, Dict[str, Any] | list | None]:
    """
    Consulta a Evolution quando o WebSocket/Rabbit não chega no front a tempo.
    Isso é especialmente útil no Pairing Code: o celular conecta, mas a tela do código fica aberta.
    """
    if not (EVOLUTION_URL and EVOLUTION_KEY and instance):
        return False, None, None

    s = _http()
    urls = [
        f"{EVOLUTION_URL}/instance/connectionState/{instance}",
        f"{EVOLUTION_URL}/instance/fetchInstances?instanceName={instance}",
    ]

    for url in urls:
        try:
            r = s.get(url, timeout=12)
            if not r.ok:
                continue

            data = r.json() if "application/json" in (r.headers.get("content-type") or "").lower() else None
            state = _evo_extract_connection_state(data, instance=instance)
            if state:
                return _state_is_connected(state), str(state), data
        except Exception:
            continue

    return False, None, None


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

        prep = _evo_prepare_instance_before_connect(
            pendente.instance_name,
            sync_full_history=sync_full_history,
        )

        conn_json = _evo_connect(
            pendente.instance_name,
            number_digits if use_pairing else None,
        )
        _schedule_cleanup(pendente.instance_name)

        qr = _extract_qr_payload(conn_json, prefer_pairing=use_pairing)

        return {
            "ok": True,
            "instance": pendente.instance_name,
            "instancia_id": int(pendente.id),
            "qrcode": qr or None,
            "numero": pendente.numero_instancia,
            "historico_restaurar": pendente.historico_restaurar,
            "history_webhook_configured": bool(prep.get("history_webhook")),
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

    try:
        prep = _evo_prepare_instance_before_connect(
            inst,
            sync_full_history=sync_full_history,
        )
    except HTTPException:
        # A instância acabou de ser criada e ainda não foi salva no ZapsChat.
        # Remove a órfã quando a preparação obrigatória do histórico falha.
        _evo_delete_instance(inst)
        raise

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

            prep = _evo_prepare_instance_before_connect(
                conflito.instance_name,
                sync_full_history=sync_full_history,
            )

            conn_json = _evo_connect(
                conflito.instance_name,
                number_digits if use_pairing else None,
            )
            _schedule_cleanup(conflito.instance_name)

            qr = _extract_qr_payload(conn_json, prefer_pairing=use_pairing)

            return {
                "ok": True,
                "instance": conflito.instance_name,
                "instancia_id": int(conflito.id),
                "qrcode": qr or None,
                "numero": conflito.numero_instancia,
                "historico_restaurar": conflito.historico_restaurar,
                "history_webhook_configured": bool(prep.get("history_webhook")),
            }

        raise HTTPException(409, "Este número já está cadastrado em uma instância.")

    conn_json = _evo_connect(
        inst,
        number_digits if use_pairing else None,
    )
    _schedule_cleanup(inst)

    qr = _extract_qr_payload(conn_json, prefer_pairing=use_pairing)

    return {
        "ok": True,
        "instance": inst,
        "instancia_id": int(inst_row.id),
        "qrcode": qr or None,
        "numero": inst_row.numero_instancia,
        "historico_restaurar": inst_row.historico_restaurar,
        "history_webhook_configured": bool(prep.get("history_webhook")),
    }


@router.get("/empresas/connection/status/{instance}")
def connection_status(
    instance: str,
    force_evolution: bool = Query(False),
    db: Session = Depends(get_db),
    identity=Depends(require_admin),
):
    """
    Status usado pelo front enquanto espera QR/Pairing Code.

    Importante: em reconexão o banco pode ainda estar como connected=True,
    mesmo com a Evolution mostrando disconnected. Quando force_evolution=1,
    consulta a Evolution e sincroniza o banco para evitar falso "Conectado agora".
    """
    instance = str(instance or "").strip()
    if not instance:
        raise HTTPException(400, "instance inválida.")

    row = db.query(models.EmpresaInstancia).filter(
        models.EmpresaInstancia.instance_name == instance
    ).first()

    if not row:
        raise HTTPException(status_code=404, detail="Instância não encontrada.")

    _assert_empresa_access(identity, int(row.empresa_id))

    db_connected_before = bool(getattr(row, "connected", False))
    state = "connected" if db_connected_before else None
    evo_connected = False
    checked_evolution = False

    if force_evolution or not db_connected_before:
        checked_evolution = True
        evo_connected, state, _raw = _evo_connection_state(instance)

        try:
            changed = False
            if bool(getattr(row, "connected", False)) != bool(evo_connected):
                row.connected = bool(evo_connected)
                changed = True
            if evo_connected:
                row.last_seen = datetime.now(timezone.utc)
                changed = True

            if changed:
                db.commit()
        except Exception:
            try:
                db.rollback()
            except Exception:
                pass

        if evo_connected:
            try:
                cancel_auto_cleanup(instance)
            except Exception:
                pass

    connected_final = bool(evo_connected if checked_evolution else db_connected_before)

    return {
        "ok": True,
        "instance": instance,
        "connected": connected_final,
        "db_connected": bool(db_connected_before),
        "evolution_connected": bool(evo_connected),
        "checked_evolution": bool(checked_evolution),
        "state": state,
        "numero": getattr(row, "numero_instancia", None),
    }


@router.post("/empresas/qr/refresh/{instance}")
def refresh_qr(
    instance: str,
    payload: Optional[RefreshQRPayload] = Body(default=None),
    db: Session = Depends(get_db),
    identity=Depends(require_admin),
):
    if not instance:
        raise HTTPException(400, "instance inválida.")

    payload = payload or RefreshQRPayload()

    row = db.query(models.EmpresaInstancia).filter(
        models.EmpresaInstancia.instance_name == instance
    ).first()

    if not row:
        raise HTTPException(status_code=404, detail="Instância não encontrada.")

    _assert_empresa_access(identity, int(row.empresa_id))

    empresa = _get_empresa_or_404(db, int(row.empresa_id))
    enforce_billing_active(
        empresa,
        message="Seu plano está vencido. Renove para reativar ou atualizar QR/código de instâncias.",
    )

    use_pairing = bool(payload.use_pairing)
    number_digits = _only_digits(payload.whatsapp_numero) or _only_digits(getattr(row, "numero_instancia", None))

    # Pairing Code precisa de número. QR Code não.
    if use_pairing and not number_digits:
        raise HTTPException(400, "Informe o número do WhatsApp com DDI/DDD para gerar o código.")

    historico_restaurar = _normalize_historico_opcao(getattr(row, "historico_restaurar", None))
    sync_full_history = _should_sync_full_history(historico_restaurar)

    prep = _evo_prepare_instance_before_connect(
        instance,
        sync_full_history=sync_full_history,
    )

    js = _evo_connect(
        instance,
        number_digits if use_pairing else None,
    )

    qr = _extract_qr_payload(js, prefer_pairing=use_pairing)

    if qr:
        # Gerou QR/Pairing Code para reconectar: ainda NÃO está conectado.
        # Evita a tela continuar exibindo "Conectado agora" por valor antigo do banco.
        try:
            row.connected = False
            db.add(row)
            db.commit()
        except Exception:
            try:
                db.rollback()
            except Exception:
                pass

    return {
        "ok": True,
        "instance": instance,
        "qrcode": (qr or None),
        "connected": False if qr else None,
        "method": "pairing" if use_pairing else "qrcode",
        "numero": number_digits or getattr(row, "numero_instancia", None),
        "historico_restaurar": historico_restaurar,
        "history_webhook_configured": bool(prep.get("history_webhook")),
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


@router.post("/empresas/instancias/{instancia_id}/historico/importar")
def importar_historico_instancia(
    instancia_id: int,
    payload: ImportarHistoricoInstanciaPayload,
    db: Session = Depends(get_db),
    identity=Depends(require_admin),
):
    """Solicita ao n8n uma nova entrega de histórico da instância.

    A rota marca o período no banco, configura o webhook exclusivo do n8n e
    ativa syncFullHistory. O ZapsChat não processa MESSAGES_SET localmente.
    """
    _assert_empresa_access(identity, int(payload.empresa_id))

    periodo = _normalize_historico_opcao(payload.historico_restaurar)
    if periodo not in {"24h", "7d", "30d"}:
        raise HTTPException(status_code=400, detail="Período inválido. Use 24h, 7d ou 30d.")

    empresa = _get_empresa_or_404(db, int(payload.empresa_id))
    enforce_billing_active(
        empresa,
        message="Seu plano está vencido. Renove para importar histórico.",
    )

    inst = db.query(models.EmpresaInstancia).filter(
        models.EmpresaInstancia.id == int(instancia_id),
        models.EmpresaInstancia.empresa_id == int(payload.empresa_id),
    ).first()

    if not inst:
        raise HTTPException(status_code=404, detail="Instância não encontrada.")

    instance_name = str(inst.instance_name or "").strip()
    if not instance_name:
        raise HTTPException(status_code=400, detail="Instância sem nome válido.")

    # O histórico manual segue a mesma arquitetura do primeiro QR:
    # webhook do n8n primeiro, período salvo no banco e syncFullHistory depois.
    # Assim o n8n nunca recebe MESSAGES_SET sem conseguir consultar a janela pedida.
    webhook_ok = _evo_set_history_webhook_initial(instance_name)
    if not webhook_ok:
        raise HTTPException(
            status_code=502,
            detail="Não foi possível configurar o webhook de histórico do n8n na Evolution.",
        )

    inst.historico_restaurar = periodo
    for attr in ("historico_status", "history_status"):
        if hasattr(inst, attr):
            try:
                setattr(inst, attr, "pending")
            except Exception:
                pass

    db.add(inst)
    db.commit()
    db.refresh(inst)

    settings_ok = _evo_set_settings_initial(instance_name, sync_full_history=True)
    if not settings_ok:
        raise HTTPException(
            status_code=502,
            detail="Não foi possível ativar syncFullHistory na Evolution.",
        )

    # Mantém os eventos em tempo real do Rabbit, sem MESSAGES_SET.
    rabbit_ok = _evo_set_rabbit_initial(instance_name)

    # Em instância conectada, esta chamada reaplica o estado e pode iniciar a
    # emissão do MESSAGES_SET para o webhook já configurado.
    connect_json = _evo_connect(instance_name, None)
    qr = _extract_qr_payload(connect_json, prefer_pairing=False)

    return {
        "ok": True,
        "instancia_id": int(inst.id),
        "instance": instance_name,
        "numero": inst.numero_instancia,
        "historico_restaurar": periodo,
        "history_owner": "n8n",
        "history_webhook_configured": True,
        "syncFullHistory": True,
        "rabbit_ok": bool(rabbit_ok),
        "settings_ok": True,
        "fallback_findmessages_agendado": False,
        "connected": bool(getattr(inst, "connected", False)),
        "qrcode": qr or None,
        "message": "Importação solicitada. O próximo MESSAGES_SET será entregue exclusivamente ao n8n.",
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
