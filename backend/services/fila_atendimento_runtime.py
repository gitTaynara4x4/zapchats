from __future__ import annotations

import asyncio
import os
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Iterable, List, Optional
from uuid import uuid4

from sqlalchemy.orm import Session

from backend import models
from backend.database import SessionLocal
from backend.services.atendimento_claim_state import release_to_queue
from backend.services.chatbot_claim_policy import department_chatbot_active_for_department
from backend.websocket_manager import conexoes_ativas


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _to_int(value: Any) -> Optional[int]:
    try:
        if value is None or str(value).strip() == "":
            return None
        return int(value)
    except Exception:
        return None


def _department_feature(config: Any) -> Dict[str, Any]:
    if not isinstance(config, dict):
        return {}
    features = config.get("features") or {}
    if not isinstance(features, dict):
        return {}
    feature = features.get("auto_messages_departments") or features.get("auto_messages_filas") or {}
    return feature if isinstance(feature, dict) else {}


def _department_mode_active(row: Any) -> bool:
    if row is None or not bool(getattr(row, "ativo", False)):
        return False
    feature = _department_feature(getattr(row, "config", None))
    welcome = feature.get("welcome") or {}
    return bool(
        feature.get("enabled", False)
        and isinstance(welcome, dict)
        and welcome.get("enabled", False)
    )


def _enabled_department_ids_for_config(
    db: Session,
    *,
    empresa_id: int,
    row: models.ChatbotConfig,
) -> List[int]:
    """Replica a regra do chatbot: sem items explícitos, todos os deps ativos entram."""
    deps = (
        db.query(models.Departamento.id)
        .filter(
            models.Departamento.empresa_id == int(empresa_id),
            models.Departamento.ativo.is_(True),
        )
        .order_by(models.Departamento.nome.asc(), models.Departamento.id.asc())
        .all()
    )
    available = [int(r[0]) for r in deps]

    feature = _department_feature(getattr(row, "config", None))
    items = feature.get("items")
    if not isinstance(items, dict) or not items:
        return available

    enabled: List[int] = []
    for did in available:
        item = items.get(str(did)) or items.get(did) or {}
        if isinstance(item, dict) and bool(item.get("enabled", False)):
            enabled.append(int(did))
    return enabled


def chatbot_queue_context(db: Session, *, empresa_id: int) -> Dict[str, Any]:
    rows = (
        db.query(models.ChatbotConfig)
        .filter(models.ChatbotConfig.empresa_id == int(empresa_id))
        .order_by(models.ChatbotConfig.instancia_id.asc())
        .all()
    )

    dep_rows = (
        db.query(models.Departamento)
        .filter(
            models.Departamento.empresa_id == int(empresa_id),
            models.Departamento.ativo.is_(True),
        )
        .order_by(models.Departamento.nome.asc(), models.Departamento.id.asc())
        .all()
    )
    dep_by_id = {int(d.id): d for d in dep_rows}

    inst_ids = [int(r.instancia_id) for r in rows if getattr(r, "instancia_id", None) is not None]
    inst_rows = []
    if inst_ids:
        inst_rows = (
            db.query(models.EmpresaInstancia)
            .filter(
                models.EmpresaInstancia.empresa_id == int(empresa_id),
                models.EmpresaInstancia.id.in_(inst_ids),
            )
            .all()
        )
    inst_by_id = {int(i.id): i for i in inst_rows}

    instances: List[Dict[str, Any]] = []
    dep_instances: Dict[int, List[int]] = {}

    for row in rows:
        iid = _to_int(getattr(row, "instancia_id", None))
        if iid is None or not _department_mode_active(row):
            continue

        enabled_ids = _enabled_department_ids_for_config(
            db,
            empresa_id=int(empresa_id),
            row=row,
        )
        departments = []
        for did in enabled_ids:
            dep = dep_by_id.get(int(did))
            if dep is None:
                continue
            departments.append({"id": int(dep.id), "nome": str(dep.nome or "Departamento")})
            dep_instances.setdefault(int(dep.id), []).append(int(iid))

        inst = inst_by_id.get(int(iid))
        instances.append(
            {
                "id": int(iid),
                "nome": (
                    getattr(inst, "apelido", None)
                    or getattr(inst, "instance_name", None)
                    or getattr(row, "instancia_nome", None)
                    or f"WhatsApp {iid}"
                ),
                "departamentos": departments,
            }
        )

    departments_out = []
    for did, iids in sorted(dep_instances.items(), key=lambda item: str(getattr(dep_by_id.get(item[0]), "nome", ""))):
        dep = dep_by_id.get(int(did))
        if dep is None:
            continue
        departments_out.append(
            {
                "id": int(did),
                "nome": str(dep.nome or "Departamento"),
                "instancia_ids": sorted(set(int(x) for x in iids)),
            }
        )

    return {
        "chatbot_ativo": bool(instances and departments_out),
        "instances": instances,
        "departments": departments_out,
    }


def validate_queue_chatbot_scope(
    db: Session,
    *,
    empresa_id: int,
    departamento_id: Optional[int],
    instancia_ids: Iterable[int],
) -> Dict[str, Any]:
    did = _to_int(departamento_id)
    ids = sorted({int(x) for x in instancia_ids if _to_int(x) is not None})
    if did is None:
        raise ValueError("Selecione um departamento configurado no Chatbot.")
    if not ids:
        raise ValueError("Selecione ao menos um WhatsApp com o Chatbot de departamentos ligado.")

    ctx = chatbot_queue_context(db, empresa_id=int(empresa_id))
    dep = next((d for d in ctx["departments"] if int(d["id"]) == int(did)), None)
    if dep is None:
        raise ValueError("Este departamento não está ativo no Chatbot. Configure o Chatbot primeiro.")

    allowed = {int(x) for x in dep.get("instancia_ids") or []}
    invalid = [int(i) for i in ids if int(i) not in allowed]
    if invalid:
        raise ValueError(
            "O departamento selecionado não está habilitado no Chatbot de todos os WhatsApps escolhidos."
        )
    return ctx


def _queue_has_instance_link(db: Session, *, empresa_id: int, fila_id: int, instancia_id: int) -> bool:
    return bool(
        db.query(models.FilaInstancia.id)
        .filter(
            models.FilaInstancia.empresa_id == int(empresa_id),
            models.FilaInstancia.fila_id == int(fila_id),
            models.FilaInstancia.instancia_id == int(instancia_id),
        )
        .first()
    )


def find_active_queue_for_department(
    db: Session,
    *,
    empresa_id: int,
    instancia_id: int,
    departamento_id: int,
) -> Optional[models.FilaAtendimento]:
    if not department_chatbot_active_for_department(
        db,
        empresa_id=int(empresa_id),
        instancia_id=int(instancia_id),
        departamento_id=int(departamento_id),
    ):
        return None

    rows = (
        db.query(models.FilaAtendimento)
        .filter(
            models.FilaAtendimento.empresa_id == int(empresa_id),
            models.FilaAtendimento.departamento_id == int(departamento_id),
            models.FilaAtendimento.ativa.is_(True),
        )
        .order_by(models.FilaAtendimento.ordem.asc(), models.FilaAtendimento.id.asc())
        .all()
    )
    for fila in rows:
        if _queue_has_instance_link(
            db,
            empresa_id=int(empresa_id),
            fila_id=int(fila.id),
            instancia_id=int(instancia_id),
        ):
            return fila
    return None


def attach_queue_for_department_if_configured(
    db: Session,
    *,
    atendimento: Any,
    empresa_id: int,
    instancia_id: int,
    departamento_id: int,
    now: Optional[datetime] = None,
) -> Optional[models.FilaAtendimento]:
    if atendimento is None:
        return None
    fila = find_active_queue_for_department(
        db,
        empresa_id=int(empresa_id),
        instancia_id=int(instancia_id),
        departamento_id=int(departamento_id),
    )
    if fila is None:
        # Se não há fila configurada para este departamento, o fluxo continua
        # como triagem por departamento normal.
        atendimento.fila_id = None
        atendimento.fila_escolhida_em = None
        db.add(atendimento)
        db.flush()
        return None

    atendimento.fila_id = int(fila.id)
    atendimento.fila_escolhida_em = now or _now_utc()
    db.add(atendimento)
    db.flush()
    return fila


def _system_event(
    db: Session,
    *,
    atendimento: models.Atendimento,
    texto: str,
) -> models.Mensagem:
    now = _now_utc()
    msg = models.Mensagem(
        empresa_id=int(atendimento.empresa_id),
        cliente_id=int(atendimento.cliente_id),
        instancia_id=int(atendimento.instancia_id) if atendimento.instancia_id is not None else None,
        atendimento_id=int(atendimento.id),
        colaborador_id=None,
        conteudo=str(texto).strip(),
        tipo="sistema",
        lida=True,
        ack=3,
        timestamp=now,
        msg_id=f"sys:fila-timeout:{int(atendimento.id)}:{uuid4().hex}",
    )
    db.add(msg)
    db.flush()
    return msg


def _event_payload(msg: models.Mensagem) -> Dict[str, Any]:
    ts = getattr(msg, "timestamp", None) or _now_utc()
    return {
        "id": int(msg.id) if getattr(msg, "id", None) is not None else None,
        "msg_id": str(msg.msg_id or ""),
        "empresa_id": int(msg.empresa_id),
        "cliente_id": int(msg.cliente_id),
        "instancia_id": int(msg.instancia_id) if msg.instancia_id is not None else None,
        "atendimento_id": int(msg.atendimento_id) if msg.atendimento_id is not None else None,
        "conteudo": str(msg.conteudo or ""),
        "texto": str(msg.conteudo or ""),
        "tipo": "sistema",
        "origem": "sistema",
        "message_type": "system",
        "system_event": True,
        "lida": True,
        "ack": 3,
        "timestamp": ts.isoformat(),
        "created_at": ts.isoformat(),
    }


def process_overdue_queue_claims(db: Session) -> List[Dict[str, Any]]:
    """Devolve para a fila atendimentos aceitos sem nenhuma resposta do responsável."""
    if not hasattr(models.FilaAtendimento, "retorno_inatividade_ativo"):
        return []

    now = _now_utc()
    rows = (
        db.query(models.Atendimento, models.FilaAtendimento)
        .join(models.FilaAtendimento, models.FilaAtendimento.id == models.Atendimento.fila_id)
        .filter(
            models.Atendimento.operador_id.is_not(None),
            models.Atendimento.aceito_em.is_not(None),
            models.Atendimento.status == models.StatusAtendimento.EM_ATENDIMENTO,
            models.FilaAtendimento.ativa.is_(True),
            models.FilaAtendimento.exigir_aceite.is_(True),
            models.FilaAtendimento.retorno_inatividade_ativo.is_(True),
            models.FilaAtendimento.retorno_inatividade_minutos.is_not(None),
            models.FilaAtendimento.retorno_inatividade_minutos > 0,
        )
        .order_by(models.Atendimento.aceito_em.asc())
        .limit(100)
        .all()
    )

    emitted: List[Dict[str, Any]] = []
    for atd, fila in rows:
        iid = _to_int(getattr(atd, "instancia_id", None))
        did = _to_int(getattr(atd, "departamento_id", None))
        operador_id = _to_int(getattr(atd, "operador_id", None))
        minutos = _to_int(getattr(fila, "retorno_inatividade_minutos", None))
        accepted_at = getattr(atd, "aceito_em", None)
        if iid is None or did is None or operador_id is None or minutos is None or accepted_at is None:
            continue
        if accepted_at.tzinfo is None:
            accepted_at = accepted_at.replace(tzinfo=timezone.utc)
        if not department_chatbot_active_for_department(
            db,
            empresa_id=int(atd.empresa_id),
            instancia_id=int(iid),
            departamento_id=int(did),
        ):
            continue

        # O prazo vale sempre que existir uma resposta pendente do atendente:
        # - ao assumir, começa em aceito_em;
        # - depois de uma resposta do atendente, fica parado;
        # - quando o cliente envia uma nova mensagem, começa novamente.
        last_out = (
            db.query(models.Mensagem.timestamp)
            .filter(
                models.Mensagem.empresa_id == int(atd.empresa_id),
                models.Mensagem.atendimento_id == int(atd.id),
                models.Mensagem.colaborador_id == int(operador_id),
                models.Mensagem.tipo == "saida",
                models.Mensagem.timestamp >= accepted_at,
            )
            .order_by(models.Mensagem.timestamp.desc(), models.Mensagem.id.desc())
            .first()
        )

        pending_since = accepted_at
        if last_out and last_out[0] is not None:
            last_out_at = last_out[0]
            if last_out_at.tzinfo is None:
                last_out_at = last_out_at.replace(tzinfo=timezone.utc)
            next_in = (
                db.query(models.Mensagem.timestamp)
                .filter(
                    models.Mensagem.empresa_id == int(atd.empresa_id),
                    models.Mensagem.atendimento_id == int(atd.id),
                    models.Mensagem.tipo == "entrada",
                    models.Mensagem.timestamp > last_out_at,
                )
                .order_by(models.Mensagem.timestamp.asc(), models.Mensagem.id.asc())
                .first()
            )
            if not next_in or next_in[0] is None:
                continue
            pending_since = next_in[0]
            if pending_since.tzinfo is None:
                pending_since = pending_since.replace(tzinfo=timezone.utc)

        if now < pending_since + timedelta(minutes=int(minutos)):
            continue

        locked = (
            db.query(models.Atendimento)
            .filter(models.Atendimento.id == int(atd.id))
            .with_for_update(skip_locked=True)
            .first()
        )
        if locked is None or _to_int(getattr(locked, "operador_id", None)) != int(operador_id):
            continue

        # A resposta pode ter chegado entre a consulta e o lock. Nesse caso não
        # devolve a conversa indevidamente.
        replied_after_deadline_started = (
            db.query(models.Mensagem.id)
            .filter(
                models.Mensagem.empresa_id == int(locked.empresa_id),
                models.Mensagem.atendimento_id == int(locked.id),
                models.Mensagem.colaborador_id == int(operador_id),
                models.Mensagem.tipo == "saida",
                models.Mensagem.timestamp >= pending_since,
            )
            .first()
        )
        if replied_after_deadline_started:
            continue

        colab = db.get(models.Colaborador, int(operador_id))
        dep = db.get(models.Departamento, int(did))
        colab_nome = str(getattr(colab, "nome", None) or "O atendente")
        dep_nome = str(getattr(dep, "nome", None) or "departamento")

        returned = release_to_queue(db, atendimento=locked)
        if returned is None:
            continue
        # release_to_queue preserva fila_id; reforça para bancos/legados.
        returned.fila_id = int(fila.id)
        returned.fila_escolhida_em = getattr(returned, "fila_escolhida_em", None) or now
        db.add(returned)

        msg = _system_event(
            db,
            atendimento=returned,
            texto=(
                f"Conversa devolvida para a fila automaticamente. "
                f"{colab_nome} não respondeu em até {int(minutos)} minutos. "
                f"Ela está disponível novamente para {dep_nome}."
            ),
        )
        db.flush()

        emitted.append(
            {
                "type": "atendimento_claim_updated",
                "empresa_id": int(returned.empresa_id),
                "action": "queue_timeout_return",
                "origin": "fila_timeout_worker",
                "conversation_key": f"c:{int(returned.cliente_id)}:{int(iid)}",
                "conversation_id": f"c:{int(returned.cliente_id)}:{int(iid)}",
                "cliente_id": int(returned.cliente_id),
                "instancia_id": int(iid),
                "atendimento_id": int(returned.id),
                "departamento_id": int(did),
                "operador_id": None,
                "responsavel_id": None,
                "operador_nome": None,
                "responsavel_nome": None,
                "status": "aguardando",
                "fila_id": int(fila.id),
                "fila_nome": str(fila.nome or "Fila"),
                "fila_prioridade": str(fila.prioridade or "normal"),
                "fila_sla_minutos": getattr(fila, "sla_minutos", None),
                "fila_cor": getattr(fila, "cor", None),
                "fila_ativa": True,
                "fila_exigir_aceite": True,
                "exigir_aceite": True,
                "aceite_obrigatorio": True,
                "aguardando_aceite": True,
                "pode_responder": False,
                "retorno_inatividade_ativo": True,
                "retorno_inatividade_minutos": int(minutos),
                "system_event": _event_payload(msg),
            }
        )

    if emitted:
        db.commit()
    return emitted


_WORKER_TASK: Optional[asyncio.Task] = None
_WORKER_STOP: Optional[asyncio.Event] = None


async def _worker_loop(stop_event: asyncio.Event) -> None:
    interval = max(10, int(os.getenv("FILA_TIMEOUT_WORKER_SECONDS", "30") or 30))
    while not stop_event.is_set():
        db = SessionLocal()
        try:
            events = process_overdue_queue_claims(db)
            for payload in events:
                try:
                    await conexoes_ativas.send_message(
                        f"emp:{int(payload['empresa_id'])}",
                        payload,
                    )
                except Exception:
                    pass
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            try:
                db.rollback()
            except Exception:
                pass
            print(f"[FILAS][timeout-worker] erro: {exc}")
        finally:
            db.close()

        try:
            await asyncio.wait_for(stop_event.wait(), timeout=float(interval))
        except asyncio.TimeoutError:
            pass


async def start_fila_timeout_worker() -> Optional[asyncio.Task]:
    global _WORKER_TASK, _WORKER_STOP
    if _WORKER_TASK is not None and not _WORKER_TASK.done():
        return _WORKER_TASK
    _WORKER_STOP = asyncio.Event()
    _WORKER_TASK = asyncio.create_task(_worker_loop(_WORKER_STOP), name="fila-timeout-worker")
    return _WORKER_TASK


async def stop_fila_timeout_worker() -> None:
    global _WORKER_TASK, _WORKER_STOP
    if _WORKER_STOP is not None:
        _WORKER_STOP.set()
    task = _WORKER_TASK
    if task is not None and not task.done():
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
    _WORKER_TASK = None
    _WORKER_STOP = None


__all__ = [
    "attach_queue_for_department_if_configured",
    "chatbot_queue_context",
    "find_active_queue_for_department",
    "process_overdue_queue_claims",
    "start_fila_timeout_worker",
    "stop_fila_timeout_worker",
    "validate_queue_chatbot_scope",
]
