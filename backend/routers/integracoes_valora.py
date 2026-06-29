# backend/routers/integracoes_valora.py
from __future__ import annotations

import re
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import desc, or_
from sqlalchemy.orm import Session

from backend import models
from backend.database import get_db
from backend.routers.auth import get_current_identity

router = APIRouter(tags=["Integrações - Valora"])


def _digits(value: Any) -> str:
    return re.sub(r"\D+", "", str(value or ""))


def _phone_candidates(value: Any) -> list[str]:
    raw = _digits(value)
    if not raw:
        return []

    candidates: list[str] = []

    def add(v: str) -> None:
        v = _digits(v)
        if v and v not in candidates:
            candidates.append(v)

    add(raw)

    # Brasil: se vier sem DDI, tenta com 55 também.
    if len(raw) in (10, 11):
        add(f"55{raw}")

    # Se vier com 55, também tenta sem o DDI para bancos antigos.
    if raw.startswith("55") and len(raw) in (12, 13):
        add(raw[2:])

    # Alguns cadastros chegam com zeros/DDI extras. Mantém finais úteis.
    if len(raw) > 11:
        add(raw[-11:])
        add(raw[-10:])

    return candidates


def _empresa_id_from_identity(identity: dict) -> int:
    try:
        emp = int(identity.get("empresa_id") or 0)
    except Exception:
        emp = 0
    if emp <= 0:
        raise HTTPException(status_code=401, detail="Empresa ausente na sessão.")
    return emp


def _is_admin(identity: dict) -> bool:
    role = str(identity.get("role") or identity.get("cargo") or "").lower().strip()
    if role in {"admin", "administrador", "owner", "dono", "root"}:
        return True
    if identity.get("is_admin") or identity.get("admin"):
        return True
    perms = set(str(p).lower() for p in (identity.get("permissoes") or []))
    return bool({"admin", "root"} & perms)


def _ensure_atendimento_perm(identity: dict) -> None:
    if _is_admin(identity):
        return
    perms = set(str(p).lower() for p in (identity.get("permissoes") or []))
    if "atendimento.ver" not in perms:
        raise HTTPException(status_code=403, detail="Sem permissão para acessar atendimentos.")


def _cliente_phone_matches(cliente: models.Cliente, candidates: list[str]) -> bool:
    if not candidates:
        return False

    values = [
        getattr(cliente, "telefone_norm", None),
        getattr(cliente, "telefone", None),
    ]

    for value in values:
        digits = _digits(value)
        if not digits:
            continue
        if digits in candidates:
            return True
        if any(digits.endswith(c[-10:]) or c.endswith(digits[-10:]) for c in candidates if len(c) >= 10):
            return True

    return False


def _last_message_for_cliente(db: Session, empresa_id: int, cliente_id: int):
    return (
        db.query(models.Mensagem)
        .filter(
            models.Mensagem.empresa_id == int(empresa_id),
            models.Mensagem.cliente_id == int(cliente_id),
        )
        .order_by(desc(models.Mensagem.timestamp), desc(models.Mensagem.id))
        .first()
    )


def _conversation_payload(db: Session, empresa_id: int, cliente: models.Cliente) -> dict[str, Any]:
    last_msg = _last_message_for_cliente(db, empresa_id, int(cliente.id))

    instancia_id = (
        getattr(last_msg, "instancia_id", None)
        or getattr(cliente, "instancia_id", None)
        or None
    )

    conv_key = f"c:{int(cliente.id)}:{int(instancia_id or 0)}"

    return {
        "id": conv_key,
        "conversation_key": conv_key,
        "conversation_id": conv_key,
        "kind": "c",
        "entity_id": int(cliente.id),
        "cliente_id": int(cliente.id),
        "cliente_base_id": int(cliente.id),
        "backend_id": int(cliente.id),
        "nome": getattr(cliente, "nome", None) or getattr(cliente, "nome_whatsapp", None) or getattr(cliente, "telefone", None) or "Cliente",
        "nome_whatsapp": getattr(cliente, "nome_whatsapp", None),
        "telefone": getattr(cliente, "telefone", None),
        "telefone_norm": getattr(cliente, "telefone_norm", None),
        "avatar_url": getattr(cliente, "avatar_url", None),
        "instancia_id": int(instancia_id) if instancia_id else None,
        "ultima_msg_id": int(getattr(last_msg, "id", 0) or 0) or None,
        "ultima_mensagem": getattr(last_msg, "conteudo", None) if last_msg else None,
        "last_ts": last_msg.timestamp.isoformat() if getattr(last_msg, "timestamp", None) else None,
        "origem_integracao": "valora",
    }


def _find_cliente_by_phone(db: Session, empresa_id: int, telefone: str) -> Optional[models.Cliente]:
    candidates = _phone_candidates(telefone)
    if not candidates:
        return None

    q = db.query(models.Cliente).filter(models.Cliente.empresa_id == int(empresa_id))

    # 1) Busca direta no telefone normalizado.
    direct = (
        q.filter(models.Cliente.telefone_norm.in_(candidates))
        .order_by(desc(models.Cliente.timestamp), desc(models.Cliente.id))
        .first()
    )
    if direct:
        return direct

    # 2) Fallback por final do número no campo visível.
    tails = sorted({c[-11:] for c in candidates if len(c) >= 10} | {c[-10:] for c in candidates if len(c) >= 10}, key=len, reverse=True)
    filters = [models.Cliente.telefone.ilike(f"%{tail}%") for tail in tails if tail]

    if filters:
        rows = q.filter(or_(*filters)).order_by(desc(models.Cliente.timestamp), desc(models.Cliente.id)).limit(30).all()
        for cliente in rows:
            if _cliente_phone_matches(cliente, candidates):
                return cliente

    return None


@router.get("/integracoes/valora/abrir-conversa")
def resolver_conversa_valora(
    telefone: str = Query(..., min_length=6),
    origem: Optional[str] = Query(default="valora"),
    cliente_id: Optional[str] = Query(default=None),
    db: Session = Depends(get_db),
    identity: dict = Depends(get_current_identity),
):
    """
    Resolve um telefone vindo do Valora para a conversa canônica do ZapChats.
    Não cria cliente nem conversa: só abre se já existir histórico/contato no ZapChats.
    """
    _ensure_atendimento_perm(identity)
    empresa_id = _empresa_id_from_identity(identity)

    candidates = _phone_candidates(telefone)
    if not candidates:
        raise HTTPException(status_code=400, detail="Telefone inválido.")

    cliente = _find_cliente_by_phone(db, empresa_id, telefone)
    if not cliente:
        return {
            "ok": True,
            "found": False,
            "telefone": candidates[0],
            "origem": origem or "valora",
            "valora_cliente_id": cliente_id,
            "detail": "Nenhuma conversa encontrada para este telefone no ZapChats.",
        }

    conversa = _conversation_payload(db, empresa_id, cliente)

    return {
        "ok": True,
        "found": True,
        "telefone": candidates[0],
        "origem": origem or "valora",
        "valora_cliente_id": cliente_id,
        "conversa": conversa,
        "redirect_params": {
            "abrir_conversa": conversa["conversation_key"],
            "abrir_telefone": candidates[0],
            "origem": origem or "valora",
            "valora_cliente_id": cliente_id,
        },
    }
