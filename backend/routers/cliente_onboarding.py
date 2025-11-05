# backend/routers/cliente_onboarding.py
from __future__ import annotations

import os
import re
import time
import threading
import requests
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
            "events": [],  # 👈 vazio no onboarding
        },
        # WS começa só com QR/CONNECTION (evita chuva)
        "websocket": {
            "enabled": True,
            "events": _ws_events_initial(),  # 👈 só QR + conexão
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
            "events": [],  # 👈 vazio no onboarding
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
                    ("SELECT 1 FROM mensagens WHERE instancia_id = :iid LIMIT 1"),
                    ("SELECT 1 FROM midias WHERE instancia_id = :iid LIMIT 1"),
                    ("SELECT 1 FROM clientes WHERE instancia_id = :iid LIMIT 1"),
                    ("SELECT 1 FROM grupos WHERE instancia_id = :iid LIMIT 1"),
                    ("SELECT 1 FROM atendimentos WHERE instancia_id = :iid LIMIT 1"),
                    ("SELECT 1 FROM chatbot_configs WHERE instancia_id = :iid LIMIT 1"),
                    ("SELECT 1 FROM mensagens_grupo WHERE instancia_id = :iid LIMIT 1"),
                    # mensagens_grupo via grupos desta instância
                    ("""
                      SELECT 1 FROM mensagens_grupo
                      WHERE grupo_id IN (SELECT id FROM grupos WHERE instancia_id = :iid)
                      LIMIT 1
                     """),
                    # mídias de mensagens 1:1 desta instância
                    ("""
                      SELECT 1 FROM midias
                      WHERE mensagem_id IN (SELECT id FROM mensagens WHERE instancia_id = :iid)
                      LIMIT 1
                     """),
                ]
                for sql in checks:
                    if db.execute(text(sql), {"iid": instancia_id}).first():
                        has_data = True
                        break

                if has_data:
                    # Já tem atividade — não apagar
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

    # 🔒 trava empresa: empresa_id do payload precisa pertencer ao usuário (quando houver)
    emp_user = _empresa_do_user(user)
    if emp_user is not None and int(emp_user) != int(payload.empresa_id):
        raise HTTPException(status_code=403, detail="Empresa inválida para este usuário")

    empresa = db.query(models.Empresa).filter(models.Empresa.id == payload.empresa_id).first()
    if not empresa:
        raise HTTPException(404, "Empresa não encontrada.")

    # Limite → só conectadas
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

    # Reaproveitar pendente do mesmo número
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
        # 👇 assinatura inicial enxuta
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

    # Já conectado em qualquer instância?
    numero_con = db.query(models.EmpresaInstancia).filter(
        models.EmpresaInstancia.numero_instancia == number_digits,
        models.EmpresaInstancia.connected.is_(True),
    ).first()
    if numero_con:
        raise HTTPException(409, "Este número já está conectado em outra instância.")

    # Instance name único
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

    # Evolution – criação + assinatura inicial ENXUTA
    _evo_create_instance(inst, payload.use_pairing)
    _evo_set_rabbit_initial(inst)
    _evo_set_websocket_initial(inst)

    # Registro local
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

        # quantidade_instancias -> apenas conectadas
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

    # Connect e cleanup (BD – blindado)
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

    # 🔒 garante que a instância pertence à empresa do usuário
    row = db.query(models.EmpresaInstancia).filter(
        models.EmpresaInstancia.instance_name == instance
    ).first()
    if not row:
        raise HTTPException(status_code=404, detail="Instância não encontrada.")

    emp_user = _empresa_do_user(user)
    if emp_user is not None and int(emp_user) != int(row.empresa_id):
        raise HTTPException(status_code=403, detail="Instância não pertence à sua empresa")

    js = _evo_try_refresh_qr(instance)

    # extrai base64/pairing + limit (mesma lógica do conectar)
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

# ============================================================
# UTIL: listener chama quando CONNECTED (cancela cleanup)
# ============================================================
def marcar_conectado_e_cancelar_cleanup(instance: str, db: Session):
    row = db.query(models.EmpresaInstancia).filter(
        models.EmpresaInstancia.instance_name == instance
    ).first()
    if row:
        row.connected = True
        # atualiza contador se existir na empresa
        emp = db.query(models.Empresa).filter(models.Empresa.id == row.empresa_id).first()
        if emp and hasattr(emp, "quantidade_instancias"):
            emp.quantidade_instancias = db.query(models.EmpresaInstancia).filter(
                models.EmpresaInstancia.empresa_id == emp.id,
                models.EmpresaInstancia.connected.is_(True),
            ).count()
        db.commit()
    cancel_auto_cleanup(instance)
