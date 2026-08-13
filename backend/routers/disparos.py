from __future__ import annotations

import asyncio
import hashlib
import os
import re
import time
from datetime import datetime, timezone
from typing import Dict, List, Optional, Set, Tuple

import httpx
from fastapi import APIRouter, Body, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import func, text
from sqlalchemy.orm import Session

from backend import models
from backend.database import SessionLocal, engine, get_db
from backend.routers.auth import get_current_identity
from backend.security.instancias import instancias_visiveis
from backend.utils.entitlements import enforce_billing_active, enforce_quota, has_feature

router = APIRouter(prefix="/api/disparos", tags=["Disparos"])

EVOLUTION_URL = (os.getenv("EVOLUTION_URL") or "").rstrip("/")
EVOLUTION_APIKEY = os.getenv("EVOLUTION_APIKEY") or os.getenv("EVOLUTION_API_KEY")

DISPAROS_MAX_DESTINATARIOS = max(1, int(os.getenv("DISPAROS_MAX_DESTINATARIOS", "5000")))
DISPAROS_MAX_TENTATIVAS = max(1, min(5, int(os.getenv("DISPAROS_MAX_TENTATIVAS", "3"))))
DISPAROS_POLL_SECONDS = max(1.0, float(os.getenv("DISPAROS_POLL_SECONDS", "2")))
_DISPAROS_LOCK_NAMESPACE = 946207
_ACTIVE_STATUSES = ("pendente", "processando")
_FINAL_STATUSES = ("concluido", "parcial", "erro", "cancelado")

_DISPATCHER_TASK: Optional[asyncio.Task] = None
_DISPATCHER_STOP: Optional[asyncio.Event] = None
_DISPATCHER_WAKE: Optional[asyncio.Event] = None
_INSTANCE_TASKS: Dict[int, asyncio.Task] = {}
_INSTANCE_SIGNALS: Dict[int, asyncio.Event] = {}


# =====================================================
# Helpers de permissão / identidade
# =====================================================

def _to_int(v) -> Optional[int]:
    try:
        if v is None:
            return None
        s = str(v).strip()
        if not s:
            return None
        return int(s)
    except Exception:
        return None


def _infer_kind(identity: dict) -> str:
    k = (identity.get("kind") or identity.get("tipo") or "").lower().strip()
    if k in ("colaborador", "usuario", "admin"):
        return "colaborador" if k == "colaborador" else "usuario"

    sub = str(identity.get("sub") or "").strip().lower()
    role = str(identity.get("role") or "").strip().lower()
    if sub.startswith("colab-") or "colab" in role or "colaborador" in role:
        return "colaborador"

    for key in ("id_colab", "colaborador_id", "id_colaborador", "colab_id", "cid"):
        if _to_int(identity.get(key)):
            return "colaborador"
    return "usuario"


def _get_empresa_e_colab(identity: dict | None) -> Tuple[int, Optional[int]]:
    if identity is None:
        raise HTTPException(status_code=401, detail="Não autenticado")

    empresa_id = _to_int(identity.get("empresa_id"))
    if not empresa_id:
        raise HTTPException(status_code=400, detail="Empresa não encontrada no token")

    colab_id: Optional[int] = None
    if _infer_kind(identity) == "colaborador":
        for key in ("id_colab", "colaborador_id", "id_colaborador", "colab_id", "cid"):
            colab_id = _to_int(identity.get(key))
            if colab_id:
                break
        if not colab_id:
            sub = str(identity.get("sub") or "").strip().lower()
            if sub.startswith("colab-"):
                colab_id = _to_int(sub.split("-", 1)[1])
        if not colab_id:
            colab_id = _to_int(identity.get("id"))

    return empresa_id, colab_id


def _get_ids(identity: dict | None) -> Tuple[int, Optional[int], Optional[int]]:
    if identity is None:
        raise HTTPException(status_code=401, detail="Não autenticado")

    empresa_id, colab_id = _get_empresa_e_colab(identity)
    usuario_id: Optional[int] = None
    if _infer_kind(identity) != "colaborador":
        for key in ("usuario_id", "user_id", "id_usuario", "id_user", "uid"):
            usuario_id = _to_int(identity.get(key))
            if usuario_id:
                break
        if not usuario_id:
            usuario_id = _to_int(identity.get("id"))
        if not usuario_id:
            sub = str(identity.get("sub") or "").strip().lower()
            if sub.isdigit():
                usuario_id = int(sub)
            elif sub.startswith("user-"):
                usuario_id = _to_int(sub.split("-", 1)[1])
    return empresa_id, colab_id, usuario_id


def _ensure_perm(identity: dict, db: Session, perm_id: str) -> None:
    empresa_id = _to_int(identity.get("empresa_id"))
    if not empresa_id:
        raise HTTPException(status_code=400, detail="Empresa não encontrada no token")
    if _infer_kind(identity) != "colaborador":
        return

    _, colab_id = _get_empresa_e_colab(identity)
    if not colab_id:
        raise HTTPException(status_code=403, detail="Sem colaborador vinculado.")

    row = db.execute(
        text(
            """
            SELECT 1
              FROM colaboradores_permissoes
             WHERE colaborador_id = :cid
               AND permissao_id = :pid
             LIMIT 1
            """
        ),
        {"cid": colab_id, "pid": perm_id},
    ).first()
    if not row:
        raise HTTPException(status_code=403, detail=f"Você não tem permissão: {perm_id}")


def _resolve_colab_by_usuario(db: Session, empresa_id: int, usuario_id: Optional[int]) -> Optional[int]:
    if not usuario_id:
        return None
    try:
        cid = (
            db.query(models.Colaborador.id)
            .filter(
                models.Colaborador.empresa_id == empresa_id,
                models.Colaborador.usuario_id == usuario_id,
            )
            .scalar()
        )
        return int(cid) if cid else None
    except Exception:
        return None


def _get_nome_autor(db: Session, colab_id: Optional[int], usuario_id: Optional[int]) -> Tuple[Optional[str], Optional[str]]:
    if colab_id:
        nome = db.query(models.Colaborador.nome).filter(models.Colaborador.id == colab_id).scalar()
        return (str(nome) if nome else None, "colaborador")
    if usuario_id:
        nome = db.query(models.Usuario.nome).filter(models.Usuario.id == usuario_id).scalar()
        return (str(nome) if nome else None, "usuario")
    return None, None


def _assert_instancia_acl(identity: dict, db: Session, instancia_id: Optional[int]) -> None:
    vis = instancias_visiveis(identity, db)
    if vis is None or instancia_id is None:
        return
    try:
        iid = int(instancia_id)
    except Exception:
        raise HTTPException(status_code=400, detail="instancia_id inválido")
    if iid not in vis:
        raise HTTPException(status_code=403, detail="Sem acesso a esta instância")


def _apply_instancias_filter(identity: dict, db: Session, query):
    vis = instancias_visiveis(identity, db)
    if vis is None:
        return query
    if not vis:
        return query.filter(models.Disparo.id == -1)
    return query.filter(models.Disparo.instancia_id.in_(vis))


def _get_empresa_or_404(db: Session, empresa_id: int) -> models.Empresa:
    empresa = db.query(models.Empresa).filter(models.Empresa.id == empresa_id).first()
    if not empresa:
        raise HTTPException(status_code=404, detail="Empresa não encontrada.")
    return empresa


def _month_start_utc() -> datetime:
    now = datetime.now(timezone.utc)
    return datetime(now.year, now.month, 1, tzinfo=timezone.utc)


def _current_month_messages_count(db: Session, empresa_id: int) -> int:
    month_start = _month_start_utc()
    reserved_or_processed = (
        db.query(func.coalesce(func.sum(models.Disparo.total_destinatarios), 0))
        .filter(
            models.Disparo.empresa_id == empresa_id,
            models.Disparo.criado_em >= month_start,
            models.Disparo.status != "cancelado",
        )
        .scalar()
        or 0
    )
    processed_before_cancel = (
        db.query(
            func.coalesce(
                func.sum(
                    func.coalesce(models.Disparo.enviados_sucesso, 0)
                    + func.coalesce(models.Disparo.enviados_erro, 0)
                ),
                0,
            )
        )
        .filter(
            models.Disparo.empresa_id == empresa_id,
            models.Disparo.criado_em >= month_start,
            models.Disparo.status == "cancelado",
        )
        .scalar()
        or 0
    )
    return int(reserved_or_processed) + int(processed_before_cancel)


def _active_campaigns_count(db: Session, empresa_id: int) -> int:
    return int(
        db.query(func.count(models.Disparo.id))
        .filter(
            models.Disparo.empresa_id == empresa_id,
            models.Disparo.status.in_(_ACTIVE_STATUSES),
        )
        .scalar()
        or 0
    )


def _creation_lock(db: Session, empresa_id: int) -> None:
    db.execute(
        text("SELECT pg_advisory_xact_lock(:ns, :key)"),
        {"ns": _DISPAROS_LOCK_NAMESPACE + 1, "key": int(empresa_id)},
    )


# =====================================================
# Schemas
# =====================================================

class DisparoCreate(BaseModel):
    instancia_id: int = Field(..., gt=0)
    delay_segundos: int = Field(20, ge=5, le=3600)
    tipo_conteudo: str = Field("text", max_length=16)
    mensagem: Optional[str] = Field(None, max_length=4096)
    midia_id: Optional[int] = None
    numeros: List[str] = Field(default_factory=list)
    request_id: Optional[str] = Field(None, min_length=8, max_length=80)
    variar_mensagem: bool = False


class DisparoOut(BaseModel):
    id: int
    mensagem: Optional[str]
    qtd_numeros: int
    instancia_id: Optional[int]
    instancia_nome: Optional[str]
    status: str
    criado_em: datetime
    iniciado_em: Optional[datetime] = None
    finalizado_em: Optional[datetime] = None
    delay_segundos: int
    enviados_sucesso: int = 0
    enviados_erro: int = 0
    pendentes: int = 0
    processados: int = 0
    progresso_pct: int = 0
    pode_cancelar: bool = False
    variar_mensagem: bool = False
    colaborador_id: Optional[int] = None
    usuario_id: Optional[int] = None
    criado_por: Optional[str] = None
    criado_por_tipo: Optional[str] = None

    class Config:
        from_attributes = True


class IAMelhorarDisparoResp(BaseModel):
    original: str
    melhorada: str


# =====================================================
# Normalização / validação
# =====================================================

def _normalizar_numero(raw: str) -> Optional[str]:
    digits = "".join(ch for ch in str(raw or "") if ch.isdigit())
    if digits.startswith("00"):
        digits = digits[2:]
    if digits.startswith("55") and len(digits) in (12, 13):
        local = digits[2:]
    elif len(digits) in (10, 11):
        local = digits
    else:
        return None

    ddd = local[:2]
    numero = local[2:]
    if len(ddd) != 2 or ddd[0] == "0" or ddd[1] == "0":
        return None
    if len(numero) == 9 and numero[0] != "9":
        return None
    if len(numero) == 8 and numero[0] not in "2345":
        return None
    return "55" + local


def _normalizar_numeros(raw_numeros: List[str]) -> list[tuple[str, str]]:
    vistos: set[str] = set()
    out: list[tuple[str, str]] = []
    for raw in raw_numeros:
        s = str(raw or "").strip()
        if not s:
            continue
        norm = _normalizar_numero(s)
        if not norm or norm in vistos:
            continue
        vistos.add(norm)
        out.append((s[:64], norm))
    return out


# =====================================================
# Evolution
# =====================================================

class EvolutionSendError(RuntimeError):
    def __init__(self, message: str, *, retryable: bool = False, status_code: Optional[int] = None):
        super().__init__(message)
        self.retryable = retryable
        self.status_code = status_code


async def _evolution_send_text(
    *,
    empresa_id: int,
    instancia_db: models.EmpresaInstancia,
    numero: str,
    texto_msg: str,
) -> None:
    if not EVOLUTION_URL:
        raise EvolutionSendError("EVOLUTION_URL não configurada.")
    if not EVOLUTION_APIKEY:
        raise EvolutionSendError("EVOLUTION_APIKEY não configurada.")

    inst_name = (
        getattr(instancia_db, "instance_name", None)
        or getattr(instancia_db, "instance", None)
        or getattr(instancia_db, "apelido", None)
        or str(instancia_db.id)
    )
    numero_e164 = _normalizar_numero(numero)
    if not numero_e164:
        raise EvolutionSendError("Número inválido.")

    url = f"{EVOLUTION_URL}/message/sendText/{inst_name}"
    payload = {"number": numero_e164, "text": texto_msg}
    headers = {"Content-Type": "application/json", "apikey": EVOLUTION_APIKEY}

    try:
        async with httpx.AsyncClient(timeout=25.0) as client:
            resp = await client.post(url, headers=headers, json=payload)
    except (httpx.ConnectTimeout, httpx.ConnectError, httpx.PoolTimeout) as exc:
        raise EvolutionSendError("Não foi possível conectar à Evolution.", retryable=True) from exc
    except (httpx.ReadTimeout, httpx.WriteTimeout, httpx.RequestError) as exc:
        # Após o envio começar, repetir automaticamente pode duplicar a mensagem.
        raise EvolutionSendError("A comunicação foi interrompida e o resultado do envio não pôde ser confirmado.") from exc

    if resp.status_code >= 400:
        retryable = resp.status_code in (408, 409, 425, 429) or resp.status_code >= 500
        try:
            body = resp.json()
            detail = body.get("message") or body.get("error") or body.get("detail") or ""
        except Exception:
            detail = ""
        safe_detail = str(detail)[:250] if detail else "Falha ao enviar mensagem."
        raise EvolutionSendError(
            f"Evolution HTTP {resp.status_code}: {safe_detail}",
            retryable=retryable,
            status_code=resp.status_code,
        )


# =====================================================
# Variação inteligente local de mensagens
# =====================================================

_VARIACAO_REGRAS = (
    (r"\bOlá!\s*Tudo bem\?", ("Olá! Tudo bem?", "Oi! Tudo bem?", "Olá! Como vai?", "Oi! Espero que esteja tudo bem.")),
    (r"\bPassando para\b", ("Passando para", "Estou passando para", "Estou entrando em contato para", "Quero falar com você para")),
    (r"\bEstou passando para\b", ("Estou passando para", "Passando para", "Estou entrando em contato para", "Quero falar com você para")),
    (r"\bSe quiser\b", ("Se quiser", "Se preferir", "Caso queira", "Se desejar")),
    (r"\bpor aqui\b", ("por aqui", "aqui pelo WhatsApp", "por esta conversa", "por aqui mesmo")),
    (r"\bte enviar\b", ("te enviar", "enviar para você", "te mandar", "mandar para você")),
    (r"\bte passar\b", ("te passar", "passar para você", "te mandar", "enviar para você")),
    (r"\bme responde\b", ("me responde", "pode me responder", "é só me responder", "fale comigo")),
)

_VARIACAO_ABERTURAS = ("Olá!", "Oi!", "Olá, tudo bem?", "Oi, tudo bem?")
_VARIACAO_FECHAMENTOS = (
    "Se precisar, estou por aqui.",
    "Qualquer dúvida, pode me chamar por aqui.",
    "Se precisar de algo, é só me responder.",
    "Fico à disposição por aqui.",
)


def _seed_index(seed: str, chave: str, tamanho: int) -> int:
    if tamanho <= 1:
        return 0
    digest = hashlib.sha256(f"{seed}|{chave}".encode("utf-8", errors="ignore")).digest()
    return int.from_bytes(digest[:8], "big") % tamanho


def _limpar_texto_variacao(texto_msg: str) -> str:
    linhas = []
    for linha in str(texto_msg or "").replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        linhas.append(re.sub(r"[ \t]+", " ", linha).strip())
    return "\n".join(linhas).strip()


def _gerar_variacao_local(texto_msg: str, *, seed: str) -> str:
    """Gera uma variação textual visível e conservadora sem serviço externo.

    O seed torna a saída estável para cada destinatário, o que é importante
    para retries: a mesma pessoa recebe a mesma versão da mensagem.
    """
    original = _limpar_texto_variacao(texto_msg)
    if not original:
        return ""

    resultado = original
    alteracoes = 0
    for idx, (pattern, opcoes) in enumerate(_VARIACAO_REGRAS):
        match = re.search(pattern, resultado, flags=re.IGNORECASE)
        if not match:
            continue
        escolha = opcoes[_seed_index(seed, f"regra-{idx}", len(opcoes))]
        if escolha.casefold() == match.group(0).casefold() and len(opcoes) > 1:
            escolha = opcoes[(_seed_index(seed, f"regra-{idx}-alt", len(opcoes) - 1) + 1) % len(opcoes)]
        novo = re.sub(pattern, escolha, resultado, count=1, flags=re.IGNORECASE)
        if novo != resultado:
            resultado = novo
            alteracoes += 1
        if alteracoes >= 3:
            break

    # Mensagens sem frases reconhecidas ainda recebem uma variação natural,
    # sempre visível ao usuário e sem caracteres ocultos.
    if alteracoes == 0:
        modo = _seed_index(seed, "fallback-modo", 3)
        lower = resultado.lstrip().casefold()
        ja_tem_saudacao = lower.startswith(("olá", "ola", "oi", "bom dia", "boa tarde", "boa noite", "prezado", "prezada"))
        if modo in (0, 1) and not ja_tem_saudacao:
            abertura = _VARIACAO_ABERTURAS[_seed_index(seed, "abertura", len(_VARIACAO_ABERTURAS))]
            resultado = f"{abertura} {resultado}"
        else:
            fechamento = _VARIACAO_FECHAMENTOS[_seed_index(seed, "fechamento", len(_VARIACAO_FECHAMENTOS))]
            resultado = f"{resultado}\n\n{fechamento}"

    resultado = resultado.strip()
    return resultado if len(resultado) <= 4096 else original


def _campanha_usa_variacao(disparo: models.Disparo) -> bool:
    meta = disparo.meta if isinstance(disparo.meta, dict) else {}
    return bool(meta.get("variar_mensagem"))


def _mensagem_destinatario(disparo: models.Disparo, dest: models.DisparoDestinatario) -> str:
    texto_msg = (disparo.mensagem or "").strip()
    if not texto_msg or not _campanha_usa_variacao(disparo):
        return texto_msg
    seed = f"campanha:{disparo.id}|destinatario:{dest.id}|numero:{dest.numero_normalizado}"
    return _gerar_variacao_local(texto_msg, seed=seed)


# =====================================================
# Fila persistente por instância
# =====================================================

def _instance_signal(instancia_id: int) -> asyncio.Event:
    event = _INSTANCE_SIGNALS.get(int(instancia_id))
    if event is None:
        event = asyncio.Event()
        _INSTANCE_SIGNALS[int(instancia_id)] = event
    return event


def wake_disparos_dispatcher(instancia_id: Optional[int] = None, *, interrupt: bool = False) -> None:
    try:
        if _DISPATCHER_WAKE is not None:
            _DISPATCHER_WAKE.set()
        if interrupt and instancia_id:
            _instance_signal(int(instancia_id)).set()
    except RuntimeError:
        pass


def _sync_disparo_counts(db: Session, disparo: models.Disparo) -> tuple[int, int, int]:
    rows = (
        db.query(models.DisparoDestinatario.status, func.count(models.DisparoDestinatario.id))
        .filter(models.DisparoDestinatario.disparo_id == disparo.id)
        .group_by(models.DisparoDestinatario.status)
        .all()
    )
    counts = {str(status): int(total or 0) for status, total in rows}
    sucesso = counts.get("enviado", 0)
    erro = counts.get("erro", 0)
    pendentes = counts.get("pendente", 0) + counts.get("enviando", 0)
    disparo.enviados_sucesso = sucesso
    disparo.enviados_erro = erro
    return sucesso, erro, pendentes


def _finalizar_disparo(db: Session, disparo: models.Disparo) -> None:
    sucesso, erro, _ = _sync_disparo_counts(db, disparo)
    total = int(disparo.total_destinatarios or 0)
    if total > 0 and sucesso == total:
        disparo.status = "concluido"
    elif sucesso > 0 and erro > 0:
        disparo.status = "parcial"
    elif erro > 0 and sucesso == 0:
        disparo.status = "erro"
    else:
        disparo.status = "erro"
    disparo.finalizado_em = datetime.now(timezone.utc)
    db.commit()


async def _sleep_interval(instancia_id: int, seconds: int) -> None:
    deadline = time.monotonic() + max(0, int(seconds))
    signal = _instance_signal(instancia_id)
    while time.monotonic() < deadline:
        if _DISPATCHER_STOP is not None and _DISPATCHER_STOP.is_set():
            return
        remaining = max(0.0, deadline - time.monotonic())
        try:
            await asyncio.wait_for(signal.wait(), timeout=min(1.0, remaining))
            signal.clear()
            return
        except asyncio.TimeoutError:
            continue


async def _wait_global_interval(db: Session, instancia_id: int) -> None:
    last = (
        db.query(
            models.DisparoDestinatario.enviado_em,
            models.DisparoDestinatario.ultima_tentativa_em,
            models.Disparo.delay_segundos,
        )
        .join(models.Disparo, models.Disparo.id == models.DisparoDestinatario.disparo_id)
        .filter(
            models.Disparo.instancia_id == int(instancia_id),
            models.DisparoDestinatario.status.in_(("enviado", "erro")),
        )
        .order_by(
            func.coalesce(
                models.DisparoDestinatario.enviado_em,
                models.DisparoDestinatario.ultima_tentativa_em,
            ).desc()
        )
        .first()
    )
    if not last:
        return
    last_at = last.enviado_em or last.ultima_tentativa_em
    if not last_at:
        return
    now = datetime.now(timezone.utc)
    if last_at.tzinfo is None:
        last_at = last_at.replace(tzinfo=timezone.utc)
    remaining = max(0.0, float(last.delay_segundos or 20) - (now - last_at).total_seconds())
    if remaining > 0:
        await _sleep_interval(instancia_id, int(remaining + 0.999))


async def _enviar_destinatario(db: Session, disparo: models.Disparo, dest: models.DisparoDestinatario) -> None:
    instancia = db.query(models.EmpresaInstancia).filter(models.EmpresaInstancia.id == disparo.instancia_id).first()
    if instancia is None:
        raise EvolutionSendError("Instância não encontrada.")
    if not bool(instancia.connected):
        raise EvolutionSendError("WhatsApp desconectado.", retryable=True)

    tipo = (disparo.tipo_conteudo or "text").lower()
    if tipo != "text":
        raise EvolutionSendError("Tipo de conteúdo não suportado neste disparo.")
    texto_msg = _mensagem_destinatario(disparo, dest)
    if not texto_msg:
        raise EvolutionSendError("Mensagem vazia.")

    last_error: Optional[EvolutionSendError] = None
    for attempt in range(1, DISPAROS_MAX_TENTATIVAS + 1):
        dest.status = "enviando"
        dest.tentativas = int(dest.tentativas or 0) + 1
        dest.ultima_tentativa_em = datetime.now(timezone.utc)
        dest.erro_msg = None
        db.commit()

        try:
            await _evolution_send_text(
                empresa_id=disparo.empresa_id,
                instancia_db=instancia,
                numero=dest.numero_normalizado,
                texto_msg=texto_msg,
            )
            return
        except EvolutionSendError as exc:
            last_error = exc
            if not exc.retryable or attempt >= DISPAROS_MAX_TENTATIVAS:
                break
            await _sleep_interval(
                int(disparo.instancia_id),
                max(5, int(disparo.delay_segundos or 20)),
            )
            if _DISPATCHER_STOP is not None and _DISPATCHER_STOP.is_set():
                raise asyncio.CancelledError

    raise last_error or EvolutionSendError("Falha ao enviar mensagem.")


async def _processar_fila_instancia(instancia_id: int) -> None:
    connection = engine.connect()
    db = Session(bind=connection, autoflush=False, expire_on_commit=False)
    lock_acquired = False
    try:
        lock_acquired = bool(
            connection.execute(
                text("SELECT pg_try_advisory_lock(:ns, :iid)"),
                {"ns": _DISPAROS_LOCK_NAMESPACE, "iid": int(instancia_id)},
            ).scalar()
        )
        if not lock_acquired:
            connection.rollback()
            return
        connection.commit()
        _instance_signal(instancia_id).clear()

        while _DISPATCHER_STOP is None or not _DISPATCHER_STOP.is_set():
            disparo = (
                db.query(models.Disparo)
                .filter(
                    models.Disparo.instancia_id == int(instancia_id),
                    models.Disparo.status.in_(_ACTIVE_STATUSES),
                )
                .order_by(models.Disparo.criado_em.asc(), models.Disparo.id.asc())
                .first()
            )
            if disparo is None:
                return

            # Um envio interrompido tem resultado incerto. Não reenviamos automaticamente,
            # pois a Evolution pode ter entregue antes da queda e isso causaria duplicidade.
            db.query(models.DisparoDestinatario).filter(
                models.DisparoDestinatario.disparo_id == disparo.id,
                models.DisparoDestinatario.status == "enviando",
            ).update(
                {
                    models.DisparoDestinatario.status: "erro",
                    models.DisparoDestinatario.erro_msg: (
                        "Envio interrompido antes da confirmação; não reenviado para evitar duplicidade."
                    ),
                },
                synchronize_session=False,
            )

            empresa = db.query(models.Empresa).filter(models.Empresa.id == disparo.empresa_id).first()
            if empresa is None:
                disparo.status = "erro"
                disparo.finalizado_em = datetime.now(timezone.utc)
                db.commit()
                continue

            try:
                enforce_billing_active(empresa, message="Plano vencido durante o processamento do disparo.")
            except HTTPException:
                disparo.status = "cancelado"
                disparo.finalizado_em = datetime.now(timezone.utc)
                db.commit()
                continue

            instancia = db.query(models.EmpresaInstancia).filter(models.EmpresaInstancia.id == instancia_id).first()
            if instancia is None:
                disparo.status = "erro"
                disparo.finalizado_em = datetime.now(timezone.utc)
                db.commit()
                continue
            if not bool(instancia.connected):
                disparo.status = "pendente"
                db.commit()
                return

            if disparo.status != "processando":
                disparo.status = "processando"
            if disparo.iniciado_em is None:
                disparo.iniciado_em = datetime.now(timezone.utc)
            db.commit()

            while True:
                db.refresh(disparo)
                if disparo.status == "cancelado":
                    break
                if _DISPATCHER_STOP is not None and _DISPATCHER_STOP.is_set():
                    return

                dest = (
                    db.query(models.DisparoDestinatario)
                    .filter(
                        models.DisparoDestinatario.disparo_id == disparo.id,
                        models.DisparoDestinatario.status == "pendente",
                    )
                    .order_by(models.DisparoDestinatario.id.asc())
                    .first()
                )
                if dest is None:
                    _finalizar_disparo(db, disparo)
                    break

                await _wait_global_interval(db, instancia_id)
                if _DISPATCHER_STOP is not None and _DISPATCHER_STOP.is_set():
                    return
                db.refresh(disparo)
                if disparo.status == "cancelado":
                    break

                try:
                    await _enviar_destinatario(db, disparo, dest)
                except EvolutionSendError as exc:
                    if exc.retryable and "desconectado" in str(exc).lower():
                        dest.status = "pendente"
                        disparo.status = "pendente"
                        db.commit()
                        return
                    dest.status = "erro"
                    dest.erro_msg = str(exc)[:500]
                except Exception:
                    dest.status = "erro"
                    dest.erro_msg = "Falha inesperada no envio."
                else:
                    dest.status = "enviado"
                    dest.enviado_em = datetime.now(timezone.utc)
                    dest.erro_msg = None

                _sync_disparo_counts(db, disparo)
                db.commit()

                remaining = (
                    db.query(func.count(models.DisparoDestinatario.id))
                    .filter(
                        models.DisparoDestinatario.disparo_id == disparo.id,
                        models.DisparoDestinatario.status == "pendente",
                    )
                    .scalar()
                    or 0
                )
                if int(remaining) <= 0:
                    _finalizar_disparo(db, disparo)
                    break

    except asyncio.CancelledError:
        raise
    except Exception as exc:
        try:
            db.rollback()
        except Exception:
            pass
        print(f"[DISPAROS] Falha no worker da instância {instancia_id}: {type(exc).__name__}")
    finally:
        try:
            db.close()
        except Exception:
            pass
        if lock_acquired:
            try:
                connection.execute(
                    text("SELECT pg_advisory_unlock(:ns, :iid)"),
                    {"ns": _DISPAROS_LOCK_NAMESPACE, "iid": int(instancia_id)},
                )
                connection.commit()
            except Exception:
                pass
        connection.close()


async def _dispatcher_loop() -> None:
    assert _DISPATCHER_STOP is not None
    assert _DISPATCHER_WAKE is not None

    while not _DISPATCHER_STOP.is_set():
        for iid, task in list(_INSTANCE_TASKS.items()):
            if task.done():
                try:
                    task.result()
                except asyncio.CancelledError:
                    pass
                except Exception as exc:
                    print(f"[DISPAROS] Worker {iid} finalizou com erro: {type(exc).__name__}")
                _INSTANCE_TASKS.pop(iid, None)

        db = SessionLocal()
        try:
            rows = (
                db.query(models.Disparo.instancia_id)
                .filter(
                    models.Disparo.instancia_id.isnot(None),
                    models.Disparo.status.in_(_ACTIVE_STATUSES),
                )
                .distinct()
                .all()
            )
            instance_ids = [int(row[0]) for row in rows if row and row[0]]
        finally:
            db.close()

        for iid in instance_ids:
            task = _INSTANCE_TASKS.get(iid)
            if task is None or task.done():
                _INSTANCE_TASKS[iid] = asyncio.create_task(
                    _processar_fila_instancia(iid),
                    name=f"disparos-instancia-{iid}",
                )

        _DISPATCHER_WAKE.clear()
        try:
            await asyncio.wait_for(_DISPATCHER_WAKE.wait(), timeout=DISPAROS_POLL_SECONDS)
        except asyncio.TimeoutError:
            pass

    for event in _INSTANCE_SIGNALS.values():
        event.set()
    tasks = list(_INSTANCE_TASKS.values())
    for task in tasks:
        task.cancel()
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)
    _INSTANCE_TASKS.clear()


async def start_disparos_dispatcher() -> asyncio.Task:
    global _DISPATCHER_TASK, _DISPATCHER_STOP, _DISPATCHER_WAKE
    if _DISPATCHER_TASK and not _DISPATCHER_TASK.done():
        return _DISPATCHER_TASK
    _DISPATCHER_STOP = asyncio.Event()
    _DISPATCHER_WAKE = asyncio.Event()
    _DISPATCHER_WAKE.set()
    _DISPATCHER_TASK = asyncio.create_task(_dispatcher_loop(), name="disparos-dispatcher")
    return _DISPATCHER_TASK


async def stop_disparos_dispatcher() -> None:
    if _DISPATCHER_STOP is not None:
        _DISPATCHER_STOP.set()
    if _DISPATCHER_WAKE is not None:
        _DISPATCHER_WAKE.set()
    for event in _INSTANCE_SIGNALS.values():
        event.set()


# =====================================================
# Serialização
# =====================================================

def _disparo_out(
    db: Session,
    disparo: models.Disparo,
    *,
    colab_map: Optional[Dict[int, str]] = None,
    user_map: Optional[Dict[int, str]] = None,
) -> DisparoOut:
    total = int(disparo.total_destinatarios or 0)
    sucesso = int(disparo.enviados_sucesso or 0)
    erro = int(disparo.enviados_erro or 0)
    processados = min(total, sucesso + erro)
    pendentes = max(0, total - processados)
    pct = int(round((processados / total) * 100)) if total > 0 else 0

    instancia_nome = None
    if disparo.instancia:
        instancia_nome = disparo.instancia.apelido or disparo.instancia.instance_name

    criado_por = None
    criado_por_tipo = None
    if disparo.colaborador_id:
        criado_por = (colab_map or {}).get(int(disparo.colaborador_id))
        criado_por_tipo = "colaborador"
    elif disparo.usuario_id:
        criado_por = (user_map or {}).get(int(disparo.usuario_id))
        criado_por_tipo = "usuario"
    if criado_por is None:
        criado_por, criado_por_tipo = _get_nome_autor(db, disparo.colaborador_id, disparo.usuario_id)

    return DisparoOut(
        id=disparo.id,
        mensagem=disparo.mensagem,
        qtd_numeros=total,
        instancia_id=disparo.instancia_id,
        instancia_nome=instancia_nome,
        status=disparo.status,
        criado_em=disparo.criado_em,
        iniciado_em=disparo.iniciado_em,
        finalizado_em=disparo.finalizado_em,
        delay_segundos=int(disparo.delay_segundos or 20),
        enviados_sucesso=sucesso,
        enviados_erro=erro,
        pendentes=pendentes,
        processados=processados,
        progresso_pct=max(0, min(100, pct)),
        pode_cancelar=disparo.status in _ACTIVE_STATUSES,
        variar_mensagem=_campanha_usa_variacao(disparo),
        colaborador_id=disparo.colaborador_id,
        usuario_id=disparo.usuario_id,
        criado_por=criado_por,
        criado_por_tipo=criado_por_tipo,
    )


# =====================================================
# Endpoints
# =====================================================

@router.post("/ia-melhorar", response_model=IAMelhorarDisparoResp)
async def ia_melhorar_disparo(
    body: dict = Body(...),
    db: Session = Depends(get_db),
    identity: dict = Depends(get_current_identity),
):
    _ensure_perm(identity, db, "disparos.enviar")
    empresa_id, _, _ = _get_ids(identity)
    empresa = _get_empresa_or_404(db, empresa_id)
    enforce_billing_active(empresa, message="Seu plano está vencido. Renove para usar a IA de disparos.")
    if not has_feature(empresa, "feature_broadcasts"):
        raise HTTPException(status_code=403, detail="Seu plano não permite recursos de disparo.")

    raw = (body.get("mensagem") or body.get("draft") or "") if isinstance(body, dict) else ""
    texto_msg = str(raw or "").strip()
    if not texto_msg:
        raise HTTPException(status_code=400, detail="Mensagem vazia.")

    variacao = body.get("variacao") if isinstance(body, dict) else None
    seed = f"preview:{empresa_id}:{variacao if variacao is not None else time.time_ns()}"
    melhorada = _gerar_variacao_local(texto_msg, seed=seed)
    return IAMelhorarDisparoResp(original=texto_msg, melhorada=(melhorada or texto_msg).strip())


@router.post("/simples", response_model=DisparoOut)
async def criar_disparo_simples(
    payload: DisparoCreate = Body(...),
    db: Session = Depends(get_db),
    identity: dict = Depends(get_current_identity),
):
    _ensure_perm(identity, db, "disparos.enviar")
    empresa_id, colab_id, usuario_id = _get_ids(identity)
    empresa = _get_empresa_or_404(db, empresa_id)
    enforce_billing_active(empresa, message="Seu plano está vencido. Renove para criar disparos.")
    if not has_feature(empresa, "feature_broadcasts"):
        raise HTTPException(status_code=403, detail="Seu plano não permite disparos.")
    _assert_instancia_acl(identity, db, payload.instancia_id)

    if (payload.tipo_conteudo or "text").lower() != "text":
        raise HTTPException(status_code=400, detail="No momento, disparos aceitam apenas mensagens de texto.")
    mensagem = (payload.mensagem or "").strip()
    if not mensagem:
        raise HTTPException(status_code=400, detail="Digite a mensagem do disparo.")

    if usuario_id and not colab_id:
        colab_id = _resolve_colab_by_usuario(db, empresa_id, usuario_id)

    instancia = (
        db.query(models.EmpresaInstancia)
        .filter(
            models.EmpresaInstancia.id == payload.instancia_id,
            models.EmpresaInstancia.empresa_id == empresa_id,
        )
        .first()
    )
    if not instancia:
        raise HTTPException(status_code=404, detail="Instância não encontrada para esta empresa.")
    if not bool(instancia.connected):
        raise HTTPException(status_code=409, detail="Este WhatsApp está desconectado. Reconecte antes de iniciar o disparo.")

    nums_norm = _normalizar_numeros(payload.numeros)
    if not nums_norm:
        raise HTTPException(status_code=400, detail="Nenhum número brasileiro válido informado.")
    if len(nums_norm) > DISPAROS_MAX_DESTINATARIOS:
        raise HTTPException(
            status_code=400,
            detail=f"O limite por campanha é de {DISPAROS_MAX_DESTINATARIOS} contatos.",
        )

    _creation_lock(db, empresa_id)

    request_id = (payload.request_id or "").strip()
    if request_id:
        existing = (
            db.query(models.Disparo)
            .filter(
                models.Disparo.empresa_id == empresa_id,
                models.Disparo.meta["request_id"].astext == request_id,
            )
            .first()
        )
        if existing:
            return _disparo_out(db, existing)

    enforce_quota(
        empresa,
        "broadcasts_per_month_max",
        _current_month_messages_count(db, empresa_id),
        delta=len(nums_norm),
        message="O total de mensagens desta campanha ultrapassa o limite mensal do seu plano.",
    )
    enforce_quota(
        empresa,
        "active_campaigns_max",
        _active_campaigns_count(db, empresa_id),
        delta=1,
        message="O limite de campanhas ativas do seu plano foi atingido. Aguarde ou cancele uma campanha.",
    )

    disparo = models.Disparo(
        empresa_id=empresa_id,
        instancia_id=payload.instancia_id,
        colaborador_id=colab_id,
        usuario_id=usuario_id,
        tipo_conteudo="text",
        mensagem=mensagem,
        midia_id=None,
        delay_segundos=payload.delay_segundos,
        total_destinatarios=len(nums_norm),
        enviados_sucesso=0,
        enviados_erro=0,
        status="pendente",
        meta={
            **({"request_id": request_id} if request_id else {}),
            "variar_mensagem": bool(payload.variar_mensagem),
            "motor_variacao": "local-v1" if payload.variar_mensagem else None,
        },
    )
    db.add(disparo)
    db.flush()

    for raw, norm in nums_norm:
        db.add(
            models.DisparoDestinatario(
                disparo_id=disparo.id,
                numero_raw=raw,
                numero_normalizado=norm,
                nome=None,
                status="pendente",
            )
        )

    db.commit()
    db.refresh(disparo)
    wake_disparos_dispatcher(disparo.instancia_id)
    return _disparo_out(db, disparo)


@router.get("", response_model=List[DisparoOut])
def listar_disparos(
    empresa_id: int = Query(..., description="ID da empresa"),
    instancia_id: Optional[int] = Query(None),
    limit: int = Query(50, ge=1, le=200),
    db: Session = Depends(get_db),
    identity: dict = Depends(get_current_identity),
):
    _ensure_perm(identity, db, "disparos.ver")
    ident_empresa_id = _to_int(identity.get("empresa_id"))
    if ident_empresa_id and int(ident_empresa_id) != int(empresa_id):
        raise HTTPException(status_code=403, detail="Empresa inválida para o usuário logado.")
    if instancia_id is not None:
        _assert_instancia_acl(identity, db, instancia_id)

    q = (
        db.query(models.Disparo)
        .filter(models.Disparo.empresa_id == empresa_id)
        .order_by(models.Disparo.id.desc())
    )
    q = _apply_instancias_filter(identity, db, q)
    if instancia_id:
        q = q.filter(models.Disparo.instancia_id == instancia_id)
    itens = q.limit(limit).all()

    colab_ids: Set[int] = {int(d.colaborador_id) for d in itens if d.colaborador_id}
    user_ids: Set[int] = {int(d.usuario_id) for d in itens if d.usuario_id}
    colab_map = {
        int(cid): str(nome or "")
        for cid, nome in db.query(models.Colaborador.id, models.Colaborador.nome).filter(models.Colaborador.id.in_(colab_ids)).all()
    } if colab_ids else {}
    user_map = {
        int(uid): str(nome or "")
        for uid, nome in db.query(models.Usuario.id, models.Usuario.nome).filter(models.Usuario.id.in_(user_ids)).all()
    } if user_ids else {}

    return [_disparo_out(db, item, colab_map=colab_map, user_map=user_map) for item in itens]


@router.post("/{disparo_id}/cancelar")
def cancelar_disparo(
    disparo_id: int,
    db: Session = Depends(get_db),
    identity: dict = Depends(get_current_identity),
):
    _ensure_perm(identity, db, "disparos.configurar")
    empresa_id, _ = _get_empresa_e_colab(identity)
    disparo = (
        db.query(models.Disparo)
        .filter(models.Disparo.id == disparo_id, models.Disparo.empresa_id == empresa_id)
        .first()
    )
    if not disparo:
        raise HTTPException(status_code=404, detail="Disparo não encontrado.")
    _assert_instancia_acl(identity, db, disparo.instancia_id)

    if disparo.status in _FINAL_STATUSES:
        return {"ok": True, "status": disparo.status}

    disparo.status = "cancelado"
    disparo.finalizado_em = datetime.now(timezone.utc)
    db.commit()
    wake_disparos_dispatcher(disparo.instancia_id)
    return {"ok": True, "status": disparo.status}
