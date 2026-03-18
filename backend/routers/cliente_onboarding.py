# backend/routers/cliente_onboarding.py
from __future__ import annotations

import os
import re
import time
import threading
import requests
from collections import Counter
from datetime import datetime, timedelta, timezone
from typing import Optional, Literal, List, Dict

from sqlalchemy import text
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session
from sqlalchemy.exc import IntegrityError  # nº duplicado

# 👉 use o mesmo helper do resto do projeto
from backend.database import get_db_session as get_db
try:
    from backend.database import SessionLocal  # p/ cleanup em background
except Exception:
    SessionLocal = None

from backend import models
# ✅ usa fonte única de plano/limite
from backend.utils.plans import PLAN_LIMITS, effective_tier as plans_effective_tier

# 🔒 auth para travar empresa
from backend.routers.auth import get_current_user

router = APIRouter(tags=["Onboarding"])  # montado como /api/onboarding/...

# =============================
# Helpers de segurança
# =============================
def _empresa_do_user(user) -> Optional[int]:
    """
    Tenta extrair empresa_id do usuário.
    Se não tiver (ex.: super admin), devolve None e não trava por empresa.
    """
    return getattr(user, "empresa_id", None) or getattr(user, "empresa", None)


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
    Usa a fonte única do tier (considera trial automaticamente) e
    fallback 0 para não liberar instância por engano.
    """
    plano = plans_effective_tier(empresa)  # "FREE", "PRATA", "OURO", ...
    return PLAN_LIMITS.get(str(plano).upper(), 0)


# =============================
# Payloads
# =============================
class ConnectPayload(BaseModel):
    empresa_id: int = Field(..., gt=0)
    empresa_nome: Optional[str] = None
    whatsapp_numero: str
    historico_restaurar: Literal["none", "24h", "7d"] = "none"
    instance_name: Optional[str] = None
    use_pairing: bool = False
    apelido: Optional[str] = None


class SaudeNumeroPayload(BaseModel):
    empresa_id: int = Field(..., gt=0)
    limite_mensagens: int = Field(200, ge=50, le=1000)
    janela_horas: int = Field(24, ge=1, le=168)
    forcar_recalculo: bool = True


# =============================
# HTTP / Evolution helpers
# =============================
def _http() -> requests.Session:
    s = requests.Session()
    if HEADERS:
        s.headers.update(HEADERS)
    return s


def _only_digits(s: str) -> str:
    return re.sub(r"\D", "", s or "")


def _slug(s: str) -> str:
    s = re.sub(r"[^a-zA-Z0-9]+", "-", s or "").strip("-")
    return s.lower() or "empresa"


def _gen_instance_name(empresa: models.Empresa, phone_e164: str | None) -> str:
    suffix = _only_digits(phone_e164 or "")
    suffix = suffix[-4:] if suffix else "0000"
    base = _slug(getattr(empresa, "nome", None) or "empresa")
    return f"{base}-{suffix}"


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
                if isinstance(arr, list) and any((i.get("instance") or i.get("instanceName")) == instance for i in arr):
                    return True
        except Exception:
            pass
        time.sleep(0.4)
    return False


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
        score = 0
        return {
            "score": score,
            "status": _score_to_status(score),
            "label": _score_to_label(score),
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

    # 1) Repetição de conteúdo nas saídas
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

    # 2) Velocidade média entre saídas
    intervalo_medio_seg = None
    if len(saidas) >= 2:
        saidas_ord = sorted(
            [m for m in saidas if m.timestamp],
            key=lambda m: m.timestamp
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

    # 3) Taxa simples de pouca resposta
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

    # 4) Volume de saídas dominante
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
    # ← lista "normal" que você usa no dia-a-dia
    return [
        "MESSAGES_SET", "MESSAGES_UPSERT", "MESSAGES_UPDATE", "MESSAGES_DELETE",
        "SEND_MESSAGE",
        "CONTACTS_SET", "CONTACTS_UPSERT", "CONTACTS_UPDATE",
        "PRESENCE_UPDATE",
        "GROUPS_UPSERT", "GROUP_UPDATE", "GROUP_PARTICIPANTS_UPDATE",
    ]


def _ws_events_initial() -> List[str]:
    # ← durante o onboarding, PARA NÃO TRAVAR:
    #    WebSocket só com QR e estado de conexão
    return ["QRCODE_UPDATED", "CONNECTION_UPDATE"]


# =============================
# Evolution – criação e assinatura inicial (anti-tempestade)
# =============================
def _evo_create_instance(instance: str, use_pairing: bool) -> None:
    if not (EVOLUTION_URL and EVOLUTION_KEY):
        return
    s = _http()
    payload = {
        "instanceName": instance,
        "integration": "WHATSAPP-BAILEYS",
        "qrcode": (not use_pairing),
        # Rabbit começa SEM eventos (evita tsunami ao ler QR)
        "rabbitmq": {
            "enabled": True,
            "exchange": os.getenv("RABBITMQ_EXCHANGE_NAME", "evolution_exchange"),
            "bindings": [b.strip() for b in (os.getenv("RABBITMQ_BINDINGS", "#") or "#").split(",") if b.strip()],
            "events": [],
        },
        # WS começa só com QR/CONNECTION (evita chuva)
        "websocket": {
            "enabled": True,
            "events": _ws_events_initial(),
        },
    }
    try:
        r = s.post(f"{EVOLUTION_URL}/instance/create", json=payload, timeout=25)
        if r.status_code not in (200, 201, 202, 409):
            s.post(f"{EVOLUTION_URL}/instances/create", json=payload, timeout=25)
    except Exception:
        pass
    _evo_wait_instance_ready(s, instance, timeout_s=8)


def _evo_set_rabbit_initial(instance: str) -> None:
    # durante o onboarding: rabbit SEM eventos
    if not (EVOLUTION_URL and EVOLUTION_KEY):
        return
    s = _http()
    body = {
        "rabbitmq": {
            "enabled": True,
            "exchange": os.getenv("RABBITMQ_EXCHANGE_NAME", "evolution_exchange"),
            "bindings": [b.strip() for b in (os.getenv("RABBITMQ_BINDINGS", "#") or "#").split(",") if b.strip()],
            "events": [],
        }
    }
    try:
        s.post(f"{EVOLUTION_URL}/rabbitmq/set/{instance}", json=body, timeout=20)
    except Exception:
        pass


def _evo_set_websocket_initial(instance: str) -> None:
    # durante o onboarding: ws só com QR/CONNECTION
    if not (EVOLUTION_URL and EVOLUTION_KEY):
        return
    s = _http()
    body = {"websocket": {"enabled": True, "events": _ws_events_initial()}}
    try:
        s.post(f"{EVOLUTION_URL}/websocket/set/{instance}", json=body, timeout=15)
    except Exception:
        pass


def _evo_connect(instance: str, number_digits: str | None) -> dict:
    """Passa número só-dígitos na query."""
    if not (EVOLUTION_URL and EVOLUTION_KEY):
        return {}
    s = _http()
    url = f"{EVOLUTION_URL}/instance/connect/{instance}"
    if number_digits:
        url += f"?number={_only_digits(number_digits)}"
    try:
        r = s.get(url, timeout=25)
        if r.ok and "application/json" in (r.headers.get("content-type") or "").lower():
            return r.json() or {}
    except Exception:
        pass
    return {}


def _evo_try_refresh_qr(instance: str) -> dict:
    return _evo_connect(instance, None)


# ========= NÃO deletar a instância na Evolution no cleanup =========
def _evo_delete_instance(instance: str) -> None:
    if not (EVOLUTION_URL and EVOLUTION_KEY and instance):
        return
    s = _http()
    attempts = [
        ("DELETE", f"{EVOLUTION_URL}/instance/delete/{instance}", None),
        ("DELETE", f"{EVOLUTION_URL}/instances/delete/{instance}", None),
        ("POST",   f"{EVOLUTION_URL}/instance/delete/{instance}", None),
        ("POST",   f"{EVOLUTION_URL}/instance/delete", {"instanceName": instance}),
        ("POST",   f"{EVOLUTION_URL}/instances/delete", {"instance": instance}),
    ]
    for method, url, body in attempts:
        try:
            r = s.delete(url, timeout=15) if method == "DELETE" else s.post(url, json=body, timeout=15)
            if r.status_code in (200, 202, 204, 404):
                return
        except Exception:
            pass


# =============================
# Auto-cleanup (apenas BD) — BLINDADO
# =============================
_CLEANUP_TIMERS: Dict[str, threading.Timer] = {}
_CLEANUP_SECONDS = int(os.getenv("ONBOARDING_CLEANUP_SECONDS", "120"))


def _has_bound_data(db: Session, inst_row: models.EmpresaInstancia) -> bool:
    """Há qualquer dado vinculando esta instância? (mensagens, clientes, grupos, mídias)"""
    iid = int(inst_row.id)
    if db.query(models.Mensagem.id).filter_by(instancia_id=iid).limit(1).first():
        return True
    if db.query(models.Cliente.id).filter_by(instancia_id=iid).limit(1).first():
        return True
    if db.query(models.Grupo.id).filter_by(instancia_id=iid).limit(1).first():
        return True
    if db.query(models.Midia.id).filter_by(instancia_id=iid).limit(1).first():
        return True
    return False


def _was_ever_connected(inst_row: models.EmpresaInstancia) -> bool:
    """Algum sinal de conexão prévia / pareamento?"""
    return bool(inst_row.connected or inst_row.numero_instancia or inst_row.last_seen)


def _cleanup_if_still_disconnected(instance: str):
    """
    Só apaga se:
      - a instância ainda existir,
      - estiver desconectada,
      - E NÃO houver qualquer dado vinculado (mensagens, mídias, clientes, grupos, etc.).
    Caso contrário, não faz nada.
    """
    if SessionLocal is not None:
        try:
            db: Session = SessionLocal()  # type: ignore
            try:
                row = db.query(models.EmpresaInstancia).filter(
                    models.EmpresaInstancia.instance_name == instance
                ).first()

                if not row:
                    return

                # Se já conectou alguma vez, NUNCA apagar em cleanup
                if bool(getattr(row, "connected", False)):
                    return

                instancia_id = int(row.id)

                # Verifica dados vinculados
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

                # Ainda desconectada e sem dados → pode excluir com segurança
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
    user=Depends(get_current_user),
):
    """
    Fluxo:
      1) Checa limite (conta apenas connected=True).
      2) Reaproveita pendente do mesmo número (somente dígitos).
      3) Garante Evolution (Rabbit/WS) — MODO INICIAL ENXUTO.
      4) Cria/atualiza row (connected=False).
      5) Connect → QR (WS manda QRCODE_UPDATED também).
      6) Agenda cleanup (apenas BD, blindado).
    """
    if not EVOLUTION_URL or not EVOLUTION_KEY:
        raise HTTPException(500, "Evolution API não configurada (EVOLUTION_URL/KEY).")

    emp_user = _empresa_do_user(user)
    if emp_user is not None and int(emp_user) != int(payload.empresa_id):
        raise HTTPException(status_code=403, detail="Empresa inválida para este usuário")

    empresa = db.query(models.Empresa).filter(models.Empresa.id == payload.empresa_id).first()
    if not empresa:
        raise HTTPException(404, "Empresa não encontrada.")

    limite = _max_instancias_for_empresa(empresa)
    conectadas = db.query(models.EmpresaInstancia).filter(
        models.EmpresaInstancia.empresa_id == empresa.id,
        models.EmpresaInstancia.connected.is_(True),
    ).count()
    if conectadas >= limite:
        raise HTTPException(
            403,
            f"Limite de instâncias atingido para o plano. Plano permite {limite} instância(s).",
        )

    number_digits = _only_digits(payload.whatsapp_numero)
    if not number_digits:
        raise HTTPException(400, "Número de WhatsApp inválido.")

    pendente = db.query(models.EmpresaInstancia).filter(
        models.EmpresaInstancia.empresa_id == empresa.id,
        models.EmpresaInstancia.numero_instancia == number_digits,
        models.EmpresaInstancia.connected.is_(False),
    ).first()
    if pendente:
        if payload.apelido:
            pendente.apelido = payload.apelido
        pendente.historico_restaurar = payload.historico_restaurar
        db.commit()

        _evo_set_rabbit_initial(pendente.instance_name)
        _evo_set_websocket_initial(pendente.instance_name)
        conn_json = _evo_connect(pendente.instance_name, number_digits)
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
            "instancia_id": pendente.id,
            "qrcode": qr or None,
            "numero": pendente.numero_instancia,
        }

    numero_con = db.query(models.EmpresaInstancia).filter(
        models.EmpresaInstancia.numero_instancia == number_digits,
        models.EmpresaInstancia.connected.is_(True),
    ).first()
    if numero_con:
        raise HTTPException(409, "Este número já está conectado em outra instância.")

    inst = (payload.instance_name or _gen_instance_name(empresa, number_digits)).strip()
    if not inst:
        raise HTTPException(400, "instance_name inválido.")

    exists_name = db.query(models.EmpresaInstancia).filter(
        models.EmpresaInstancia.instance_name == inst
    ).first()
    if exists_name:
        if exists_name.empresa_id != empresa.id:
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

    _evo_create_instance(inst, payload.use_pairing)
    _evo_set_rabbit_initial(inst)
    _evo_set_websocket_initial(inst)

    inst_row = db.query(models.EmpresaInstancia).filter(
        models.EmpresaInstancia.instance_name == inst
    ).first()
    try:
        if not inst_row:
            inst_row = models.EmpresaInstancia(
                empresa_id=empresa.id,
                instance_name=inst,
                connected=False,
                numero_instancia=number_digits,
                apelido=(payload.apelido or None),
                historico_restaurar=payload.historico_restaurar,
            )
            db.add(inst_row)
            db.flush()
        else:
            if not getattr(inst_row, "numero_instancia", None):
                inst_row.numero_instancia = number_digits
            if payload.apelido:
                inst_row.apelido = payload.apelido
            inst_row.historico_restaurar = payload.historico_restaurar

        if hasattr(empresa, "quantidade_instancias"):
            empresa.quantidade_instancias = db.query(models.EmpresaInstancia).filter(
                models.EmpresaInstancia.empresa_id == empresa.id,
                models.EmpresaInstancia.connected.is_(True),
            ).count()

        db.commit()
    except IntegrityError:
        db.rollback()
        conflito = db.query(models.EmpresaInstancia).filter(
            models.EmpresaInstancia.numero_instancia == number_digits
        ).first()
        if conflito and not conflito.connected and conflito.empresa_id == empresa.id:
            if payload.apelido:
                conflito.apelido = payload.apelido
            conflito.historico_restaurar = payload.historico_restaurar
            db.commit()

            _evo_set_rabbit_initial(conflito.instance_name)
            _evo_set_websocket_initial(conflito.instance_name)
            conn_json = _evo_connect(conflito.instance_name, number_digits)
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
                "instancia_id": conflito.id,
                "qrcode": qr or None,
                "numero": conflito.numero_instancia,
            }
        raise HTTPException(409, "Este número já está cadastrado em uma instância.")

    conn_json = _evo_connect(inst, number_digits)
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
        "instancia_id": inst_row.id,
        "qrcode": qr or None,
        "numero": inst_row.numero_instancia,
    }


@router.post("/empresas/qr/refresh/{instance}")
def refresh_qr(
    instance: str,
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    if not instance:
        raise HTTPException(400, "instance inválida.")

    row = db.query(models.EmpresaInstancia).filter(
        models.EmpresaInstancia.instance_name == instance
    ).first()
    if not row:
        raise HTTPException(status_code=404, detail="Instância não encontrada.")

    emp_user = _empresa_do_user(user)
    if emp_user is not None and int(emp_user) != int(row.empresa_id):
        raise HTTPException(status_code=403, detail="Instância não pertence à sua empresa")

    js = _evo_try_refresh_qr(instance)

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
    return {"ok": True, "instance": instance, "qrcode": (qr or None)}


@router.post("/empresas/instancias/{instancia_id}/saude")
def consultar_saude_numero(
    instancia_id: int,
    payload: SaudeNumeroPayload,
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    """
    Consulta sob demanda a saúde do número:
    - busca últimas mensagens da instância
    - calcula score de risco
    - salva em empresas_instancias.score
    - devolve resumo para o modal do front
    """
    emp_user = _empresa_do_user(user)
    if emp_user is not None and int(emp_user) != int(payload.empresa_id):
        raise HTTPException(status_code=403, detail="Empresa inválida para este usuário")

    inst = db.query(models.EmpresaInstancia).filter(
        models.EmpresaInstancia.id == instancia_id,
        models.EmpresaInstancia.empresa_id == payload.empresa_id,
    ).first()
    if not inst:
        raise HTTPException(status_code=404, detail="Instância não encontrada.")

    dt_min = datetime.now(timezone.utc) - timedelta(hours=int(payload.janela_horas))

    msgs = db.query(models.Mensagem).filter(
        models.Mensagem.empresa_id == payload.empresa_id,
        models.Mensagem.instancia_id == inst.id,
        models.Mensagem.timestamp >= dt_min,
        models.Mensagem.conteudo.isnot(None),
        models.Mensagem.conteudo != "",
    ).order_by(
        models.Mensagem.timestamp.desc()
    ).limit(
        int(payload.limite_mensagens)
    ).all()

    analise = _analisar_saude_mensagens(msgs)

    inst.score = int(analise["score"])
    db.add(inst)
    db.commit()
    db.refresh(inst)

    return {
        "ok": True,
        "instancia_id": inst.id,
        "instance": inst.instance_name,
        "apelido": inst.apelido,
        "numero": inst.numero_instancia,
        "score": inst.score,
        "saude": {
            **analise,
            "consultado_em": datetime.now(timezone.utc).isoformat(),
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
            emp.quantidade_instancias = db.query(models.EmpresaInstancia).filter(
                models.EmpresaInstancia.empresa_id == emp.id,
                models.EmpresaInstancia.connected.is_(True),
            ).count()
        db.commit()
    cancel_auto_cleanup(instance)