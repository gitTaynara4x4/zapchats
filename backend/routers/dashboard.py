# backend/routers/dashboard.py
from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone
from typing import Optional, Tuple, Dict, List

from fastapi import APIRouter, Depends, Query, HTTPException
from sqlalchemy.orm import Session
from sqlalchemy import func, and_, desc

from backend.database import get_db
from backend import models
from backend.routers.auth import get_current_identity

# Evolution (consulta direta, sem persistir)
try:
    from backend.integrations.evolution.api.router import EvolutionClient
except Exception:
    EvolutionClient = None  # type: ignore

router = APIRouter()


# ------------ helpers ------------
def _parse_date(date_str: Optional[str]) -> Tuple[Optional[datetime], Optional[datetime]]:
    if not date_str:
        return None, None
    try:
        d0 = datetime.strptime(date_str, "%Y-%m-%d")
        d1 = d0 + timedelta(days=1)
        return d0, d1
    except Exception:
        return None, None


def _daterange_filter(col, d0: Optional[datetime], d1: Optional[datetime]):
    if d0 and d1:
        return and_(col >= d0, col < d1)
    return True


def _today_range():
    t0 = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
    return t0, t0 + timedelta(days=1)


def _maybe_inst(col, instancia_id: Optional[int]):
    return (col == instancia_id) if instancia_id is not None else True


# ========== Evolution live helpers (sem gravar no BD) ==========
def _evo_enabled() -> bool:
    return bool(os.getenv("EVOLUTION_URL") and (os.getenv("EVOLUTION_APIKEY") or os.getenv("EVOLUTION_KEY")))


def _connected_from_state(state: str | None) -> bool:
    s = (state or "").strip().lower()
    return s in {"open", "connected", "online", "ready"}


def _evo_fetch_state(instance_name: str) -> Optional[Dict]:
    """
    Consulta GET /instance/connectionState/{instance} na Evolution e
    devolve {"connected": bool, "state": str, "instance_name": str}.
    Não persiste nada em lugar algum.
    """
    if not instance_name or not _evo_enabled() or not EvolutionClient:
        return None

    try:
        evo = EvolutionClient()  # usa ENV (EVOLUTION_URL + APIKEY)
        js = evo.get_connection_state(instance_name)
        data = js.get("instance") if isinstance(js, dict) else None
        state = str((data or {}).get("state") or js.get("state") or "").strip()
        return {
            "connected": _connected_from_state(state),
            "state": state,
            "instance_name": instance_name,
        }
    except Exception:
        return None


def _assert_empresa_match(empresa_id: int, identity) -> int:
    """
    Garante que o empresa_id da query é o mesmo do usuário logado
    (funciona tanto para usuário quanto para colaborador).
    """
    try:
        emp_user = getattr(identity, "empresa_id", None) or getattr(identity, "empresa", None)
    except Exception:
        emp_user = None

    if emp_user is not None and int(emp_user) != int(empresa_id):
        raise HTTPException(status_code=403, detail="Empresa não permitida")
    return int(empresa_id)


# ------------ /api/dashboard/cards ------------
@router.get("/dashboard/cards")
def dashboard_cards(
    empresa_id: int = Query(..., description="ID da empresa"),
    date: Optional[str] = Query(None, description="YYYY-MM-DD"),
    instancia_id: Optional[int] = Query(None, description="Filtrar por ID exato da instância"),
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
):
    """
    Cartões do topo:
      - mensagens_hoje: total de mensagens no dia filtrado
      - abertos: conversas ativas (heurística: última do dia foi 'entrada')
      - clientes_online: clientes com msg nos últimos 5 minutos
      - total_atendimentos: nº de clientes com alguma mensagem no dia
    """
    empresa_id = _assert_empresa_match(empresa_id, identity)
    d0, d1 = _parse_date(date) if date else _today_range()

    msgs_q = (
        db.query(models.Mensagem)
        .filter(models.Mensagem.empresa_id == empresa_id)
        .filter(_daterange_filter(models.Mensagem.timestamp, d0, d1))
        .filter(_maybe_inst(models.Mensagem.instancia_id, instancia_id))
    )
    mensagens_hoje = msgs_q.count()

    total_atendimentos = (
        db.query(models.Mensagem.cliente_id)
        .filter(models.Mensagem.empresa_id == empresa_id)
        .filter(_daterange_filter(models.Mensagem.timestamp, d0, d1))
        .filter(_maybe_inst(models.Mensagem.instancia_id, instancia_id))
        .distinct()
        .count()
    )

    sub_last = (
        db.query(
            models.Mensagem.cliente_id.label("cid"),
            func.max(models.Mensagem.timestamp).label("ts"),
        )
        .filter(models.Mensagem.empresa_id == empresa_id)
        .filter(_daterange_filter(models.Mensagem.timestamp, d0, d1))
        .filter(_maybe_inst(models.Mensagem.instancia_id, instancia_id))
        .group_by(models.Mensagem.cliente_id)
        .subquery()
    )
    last_msgs = (
        db.query(models.Mensagem)
        .join(
            sub_last,
            and_(
                models.Mensagem.cliente_id == sub_last.c.cid,
                models.Mensagem.timestamp == sub_last.c.ts,
            ),
        )
        .filter(_maybe_inst(models.Mensagem.instancia_id, instancia_id))
        .all()
    )
    abertos = sum(1 for m in last_msgs if (m.tipo or "").lower() == "entrada")

    now = datetime.now()
    clientes_online = (
        db.query(models.Mensagem.cliente_id)
        .filter(models.Mensagem.empresa_id == empresa_id)
        .filter(models.Mensagem.timestamp >= now - timedelta(minutes=5))
        .filter(_maybe_inst(models.Mensagem.instancia_id, instancia_id))
        .distinct()
        .count()
    )

    return {
        "mensagens_hoje": mensagens_hoje,
        "abertos": abertos,
        "clientes_online": clientes_online,
        "total_atendimentos": total_atendimentos,
    }


# ------------ /api/dashboard/distribuicao ------------
@router.get("/dashboard/distribuicao")
def dashboard_distribuicao(
    empresa_id: int,
    date: Optional[str] = Query(None, description="YYYY-MM-DD"),
    instancia_id: Optional[int] = Query(None, description="Filtrar por ID exato da instância"),
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
):
    """
    Distribuição por status simples (no dia):
      - 'Novos'            : primeira mensagem do cliente no dia foi 'entrada'
      - 'Em atendimento'   : última no dia é 'entrada'
      - 'Concluídos'       : última no dia é 'saida'
      - 'Sem resposta'     : recebeu 'entrada' no dia mas nenhuma 'saida'
    """
    empresa_id = _assert_empresa_match(empresa_id, identity)
    d0, d1 = _parse_date(date) if date else _today_range()

    sub_last = (
        db.query(
            models.Mensagem.cliente_id.label("cid"),
            func.max(models.Mensagem.timestamp).label("ts"),
        )
        .filter(models.Mensagem.empresa_id == empresa_id)
        .filter(_daterange_filter(models.Mensagem.timestamp, d0, d1))
        .filter(_maybe_inst(models.Mensagem.instancia_id, instancia_id))
        .group_by(models.Mensagem.cliente_id)
        .subquery()
    )
    last_msgs = (
        db.query(models.Mensagem.cliente_id, models.Mensagem.tipo)
        .join(
            sub_last,
            and_(
                models.Mensagem.cliente_id == sub_last.c.cid,
                models.Mensagem.timestamp == sub_last.c.ts,
            ),
        )
        .filter(_maybe_inst(models.Mensagem.instancia_id, instancia_id))
        .all()
    )
    last_by_cli: Dict[int, str] = {cid: (tipo or "").lower() for cid, tipo in last_msgs}

    sub_first = (
        db.query(
            models.Mensagem.cliente_id.label("cid"),
            func.min(models.Mensagem.timestamp).label("ts"),
        )
        .filter(models.Mensagem.empresa_id == empresa_id)
        .filter(_daterange_filter(models.Mensagem.timestamp, d0, d1))
        .filter(_maybe_inst(models.Mensagem.instancia_id, instancia_id))
        .group_by(models.Mensagem.cliente_id)
        .subquery()
    )
    first_msgs = (
        db.query(models.Mensagem.cliente_id, models.Mensagem.tipo)
        .join(
            sub_first,
            and_(
                models.Mensagem.cliente_id == sub_first.c.cid,
                models.Mensagem.timestamp == sub_first.c.ts,
            ),
        )
        .filter(_maybe_inst(models.Mensagem.instancia_id, instancia_id))
        .all()
    )
    first_by_cli: Dict[int, str] = {cid: (tipo or "").lower() for cid, tipo in first_msgs}

    set_in = {
        cid
        for (cid,) in db.query(models.Mensagem.cliente_id)
        .filter(models.Mensagem.empresa_id == empresa_id)
        .filter(_daterange_filter(models.Mensagem.timestamp, d0, d1))
        .filter(_maybe_inst(models.Mensagem.instancia_id, instancia_id))
        .filter(models.Mensagem.tipo == "entrada")
        .distinct()
        .all()
    }
    set_out = {
        cid
        for (cid,) in db.query(models.Mensagem.cliente_id)
        .filter(models.Mensagem.empresa_id == empresa_id)
        .filter(_daterange_filter(models.Mensagem.timestamp, d0, d1))
        .filter(_maybe_inst(models.Mensagem.instancia_id, instancia_id))
        .filter(models.Mensagem.tipo == "saida")
        .distinct()
        .all()
    }

    novos = sum(1 for _, t in first_by_cli.items() if t == "entrada")
    em_atendimento = sum(1 for _, t in last_by_cli.items() if t == "entrada")
    concluidos = sum(1 for _, t in last_by_cli.items() if t == "saida")
    sem_resposta = len(set_in - set_out)

    return {
        "labels": ["Novos", "Em atendimento", "Concluídos", "Sem resposta"],
        "data": [novos, em_atendimento, concluidos, sem_resposta],
    }


# ------------ /api/dashboard/funil ------------
@router.get("/dashboard/funil")
def dashboard_funil(
    empresa_id: int,
    date: Optional[str] = Query(None, description="YYYY-MM-DD"),
    instancia_id: Optional[int] = Query(None, description="Filtrar por ID exato da instância"),
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
):
    """
    Funil simples por dia:
      - Recebidas     : nº de 'entrada'
      - Qualificadas  : entradas que receberam alguma 'saida' de resposta
      - Em Progresso  : últimos do dia são 'entrada'
      - Resolvidas    : últimos do dia são 'saida'
    """
    empresa_id = _assert_empresa_match(empresa_id, identity)
    d0, d1 = _parse_date(date) if date else _today_range()

    entradas = {
        cid
        for (cid,) in db.query(models.Mensagem.cliente_id)
        .filter(models.Mensagem.empresa_id == empresa_id)
        .filter(_daterange_filter(models.Mensagem.timestamp, d0, d1))
        .filter(_maybe_inst(models.Mensagem.instancia_id, instancia_id))
        .filter(models.Mensagem.tipo == "entrada")
        .distinct()
        .all()
    }
    saidas = {
        cid
        for (cid,) in db.query(models.Mensagem.cliente_id)
        .filter(models.Mensagem.empresa_id == empresa_id)
        .filter(_daterange_filter(models.Mensagem.timestamp, d0, d1))
        .filter(_maybe_inst(models.Mensagem.instancia_id, instancia_id))
        .filter(models.Mensagem.tipo == "saida")
        .distinct()
        .all()
    }

    sub_last = (
        db.query(
            models.Mensagem.cliente_id.label("cid"),
            func.max(models.Mensagem.timestamp).label("ts"),
        )
        .filter(models.Mensagem.empresa_id == empresa_id)
        .filter(_daterange_filter(models.Mensagem.timestamp, d0, d1))
        .filter(_maybe_inst(models.Mensagem.instancia_id, instancia_id))
        .group_by(models.Mensagem.cliente_id)
        .subquery()
    )
    last_msgs = (
        db.query(models.Mensagem.cliente_id, models.Mensagem.tipo)
        .join(
            sub_last,
            and_(
                models.Mensagem.cliente_id == sub_last.c.cid,
                models.Mensagem.timestamp == sub_last.c.ts,
            ),
        )
        .filter(_maybe_inst(models.Mensagem.instancia_id, instancia_id))
        .all()
    )
    last_tipo = {cid: (tipo or "").lower() for cid, tipo in last_msgs}

    recebidas = len(entradas)
    qualificadas = len(entradas & saidas)
    em_progresso = sum(1 for t in last_tipo.values() if t == "entrada")
    resolvidas = sum(1 for t in last_tipo.values() if t == "saida")

    return {
        "labels": ["Recebidas", "Qualificadas", "Em Progresso", "Resolvidas"],
        "data": [recebidas, qualificadas, em_progresso, resolvidas],
    }


# ------------ /api/atendimentos/ultimos ------------
@router.get("/atendimentos/ultimos")
def atendimentos_ultimos(
    empresa_id: int,
    date: Optional[str] = Query(None, description="YYYY-MM-DD"),
    limit: int = Query(20, ge=1, le=200),
    instancia_id: Optional[int] = Query(None, description="Filtrar por ID exato da instância"),
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
):
    """
    Últimas conversas do dia (uma linha por cliente, pela última mensagem do dia).
    """
    empresa_id = _assert_empresa_match(empresa_id, identity)
    d0, d1 = _parse_date(date) if date else _today_range()

    sub_last = (
        db.query(
            models.Mensagem.cliente_id.label("cid"),
            func.max(models.Mensagem.timestamp).label("ts"),
        )
        .filter(models.Mensagem.empresa_id == empresa_id)
        .filter(_daterange_filter(models.Mensagem.timestamp, d0, d1))
        .filter(_maybe_inst(models.Mensagem.instancia_id, instancia_id))
        .group_by(models.Mensagem.cliente_id)
        .subquery()
    )

    q = (
        db.query(models.Mensagem, models.Cliente)
        .join(
            sub_last,
            and_(
                models.Mensagem.cliente_id == sub_last.c.cid,
                models.Mensagem.timestamp == sub_last.c.ts,
            ),
        )
        .filter(_maybe_inst(models.Mensagem.instancia_id, instancia_id))
        .join(models.Cliente, models.Cliente.id == models.Mensagem.cliente_id)
        .order_by(desc(models.Mensagem.timestamp))
        .limit(limit)
    )

    rows = []
    for msg, cli in q.all():
        rows.append(
            {
                "nome": cli.nome or cli.nome_whatsapp or "-",
                "telefone": cli.telefone or "-",
                "status": "Finalizado"
                if (msg.tipo or "").lower() == "saida"
                else "Em atendimento",
                "horario": msg.timestamp.strftime("%H:%M"),
                "data": msg.timestamp.strftime("%Y-%m-%d"),
            }
        )
    return rows


# ------------ /api/dashboard (consolidado) ------------
@router.get("/dashboard")
def dashboard_consolidado(
    empresa_id: int,
    date: Optional[str] = Query(None, description="YYYY-MM-DD"),
    instancia_id: Optional[int] = Query(None, description="Filtrar por ID exato da instância"),
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
):
    """
    Retorna num payload só: cards, distrib, funil e ultimos.
    O JS tenta este endpoint primeiro e, se der erro, chama os separados.
    """
    empresa_id = _assert_empresa_match(empresa_id, identity)

    cards = dashboard_cards(
        empresa_id=empresa_id,
        date=date,
        instancia_id=instancia_id,
        db=db,
        identity=identity,
    )
    distrib = dashboard_distribuicao(
        empresa_id=empresa_id,
        date=date,
        instancia_id=instancia_id,
        db=db,
        identity=identity,
    )
    funil = dashboard_funil(
        empresa_id=empresa_id,
        date=date,
        instancia_id=instancia_id,
        db=db,
        identity=identity,
    )
    ultimos = atendimentos_ultimos(
        empresa_id=empresa_id,
        date=date,
        instancia_id=instancia_id,
        limit=20,
        db=db,
        identity=identity,
    )

    return {
        "cards": cards,
        "distrib": distrib,
        "funil": funil,
        "ultimos": ultimos,
        "total_atendimentos": cards.get("total_atendimentos", 0),
        "mensagens_hoje": cards.get("mensagens_hoje", 0),
        "abertos": cards.get("abertos", 0),
        "clientes_online": cards.get("clientes_online", 0),
    }


# ------------ /api/whatsapp/status (Evolution-first, sem persistir) ------------
@router.get("/whatsapp/status")
def whatsapp_status(
    empresa_id: int,
    instancia_id: Optional[int] = Query(None, description="Filtrar por ID exato da instância"),
    instance_name: Optional[str] = Query(None, description="Nome da instância (Evolution)"),
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
):
    """
    Retorna status de conexão:
      1) Tenta consultar a Evolution AO VIVO (sem gravar no BD) usando instance_name.
      2) Se não houver instance_name, mas tiver instancia_id, resolve o nome pelo BD e tenta Evolution.
      3) Se Evolution não estiver configurada/der erro, cai no fallback: lê flags do BD (connected/last_seen).
    """
    empresa_id = _assert_empresa_match(empresa_id, identity)

    if instance_name and _evo_enabled():
        evo = _evo_fetch_state(instance_name)
        if evo is not None:
            detalhes = [
                {
                    "id": instancia_id,
                    "apelido": instance_name,
                    "connected": bool(evo["connected"]),
                    "last_seen": None,
                    "instance_name": instance_name,
                    "state": evo.get("state"),
                }
            ]
            online = any(d["connected"] for d in detalhes)
            return {
                "total_instancias": 1,
                "conectadas": 1 if online else 0,
                "online": online,
                "last_seen": None,
                "detalhes": detalhes,
                "source": "evolution",
            }

    if instancia_id is not None and _evo_enabled():
        inst_row = (
            db.query(models.EmpresaInstancia)
            .filter(
                models.EmpresaInstancia.empresa_id == empresa_id,
                models.EmpresaInstancia.id == instancia_id,
            )
            .first()
        )
        if not inst_row:
            raise HTTPException(status_code=404, detail="Instância não encontrada")

        inst_name = (getattr(inst_row, "instance_name", None) or "").strip()
        if inst_name:
            evo = _evo_fetch_state(inst_name)
            if evo is not None:
                detalhes = [
                    {
                        "id": inst_row.id,
                        "apelido": inst_row.apelido,
                        "connected": bool(evo["connected"]),
                        "last_seen": None,
                        "instance_name": inst_name,
                        "state": evo.get("state"),
                    }
                ]
                online = any(d["connected"] for d in detalhes)
                return {
                    "total_instancias": 1,
                    "conectadas": 1 if online else 0,
                    "online": online,
                    "last_seen": None,
                    "detalhes": detalhes,
                    "source": "evolution",
                }

    if instancia_id is None and _evo_enabled():
        rows: List[models.EmpresaInstancia] = (
            db.query(models.EmpresaInstancia)
            .filter(models.EmpresaInstancia.empresa_id == empresa_id)
            .all()
        )
        if rows:
            detalhes = []
            got_any = False

            for i in rows:
                inst_name = (getattr(i, "instance_name", None) or "").strip()
                evo = _evo_fetch_state(inst_name) if inst_name else None
                if evo is not None:
                    got_any = True
                    detalhes.append(
                        {
                            "id": i.id,
                            "apelido": i.apelido,
                            "connected": bool(evo["connected"]),
                            "last_seen": None,
                            "instance_name": inst_name,
                            "state": evo.get("state"),
                        }
                    )
                else:
                    detalhes.append(
                        {
                            "id": i.id,
                            "apelido": i.apelido,
                            "connected": False,
                            "last_seen": (i.last_seen.isoformat() if i.last_seen else None),
                            "instance_name": inst_name or None,
                            "state": None,
                        }
                    )

            if got_any:
                online = any(d["connected"] for d in detalhes)
                return {
                    "total_instancias": len(detalhes),
                    "conectadas": sum(1 for d in detalhes if d["connected"]),
                    "online": online,
                    "last_seen": None,
                    "detalhes": detalhes,
                    "source": "evolution",
                }

    q = db.query(models.EmpresaInstancia).filter(models.EmpresaInstancia.empresa_id == empresa_id)
    if instancia_id is not None:
        q = q.filter(models.EmpresaInstancia.id == instancia_id)

    insts = q.all()
    if instancia_id is not None and not insts:
        raise HTTPException(status_code=404, detail="Instância não encontrada")

    def _derive_connected(i: models.EmpresaInstancia) -> bool:
        if not i.connected:
            return False
        if i.last_seen:
            try:
                now = datetime.now(timezone.utc) if i.last_seen.tzinfo else datetime.now()
                delta = now - i.last_seen
                if delta > timedelta(minutes=10):
                    return False
            except Exception:
                pass
        return True

    detalhes = [
        {
            "id": i.id,
            "apelido": i.apelido,
            "connected": _derive_connected(i),
            "last_seen": (i.last_seen.isoformat() if i.last_seen else None),
            "instance_name": getattr(i, "instance_name", None),
            "state": None,
        }
        for i in insts
    ]
    online = any(d["connected"] for d in detalhes)
    last_seen = max((i.last_seen for i in insts if i.last_seen), default=None)

    return {
        "total_instancias": len(insts),
        "conectadas": sum(1 for d in detalhes if d["connected"]),
        "online": online,
        "last_seen": (last_seen.isoformat() if last_seen else None),
        "detalhes": detalhes,
        "source": "database",
    }