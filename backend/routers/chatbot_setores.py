# backend/routers/chatbot_setores.py
from __future__ import annotations

import os
import re
import unicodedata
from datetime import datetime, timezone, timedelta
from typing import Any, Dict, List, Optional, Tuple

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session
from sqlalchemy import text

from backend.database import get_db
import backend.models as models

# Reusa o client Evolution já pronto no send
from backend.routers.atendimento_send import _evo_post  # type: ignore


router = APIRouter(prefix="/api", tags=["Chatbot (Triagem Setores)"])

TRIAGEM_TTL_HOURS = int(os.getenv("TRIAGEM_TTL_HOURS", "6"))  # após X horas sem falar, volta a pedir setor


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _digits(s: str) -> str:
    return re.sub(r"\D", "", s or "")


def _norm_txt(s: str) -> str:
    s = (s or "").strip().lower()
    s = unicodedata.normalize("NFD", s)
    s = "".join(ch for ch in s if unicodedata.category(ch) != "Mn")
    return s


def _ensure_br_country(d: str) -> str:
    """Se vier só com DDD+número (11 dígitos no BR), prefixa 55."""
    d = _digits(d)
    if len(d) == 11 and not d.startswith("55"):
        return "55" + d
    return d


def _remote_jid_from_payload(numero_digits: str, jid: str | None) -> str:
    jid = (jid or "").strip()
    if jid:
        # já vem algo tipo 5531...@s.whatsapp.net
        return jid
    e164 = _ensure_br_country(numero_digits)
    return f"{e164}@s.whatsapp.net"


def _resolve_emp_inst_from_instance_name(db: Session, instance_name: str) -> Tuple[int, int]:
    row = db.execute(
        text(
            """
            SELECT id, empresa_id
            FROM empresas_instancias
            WHERE instance_name = :instance_name
            LIMIT 1
            """
        ),
        {"instance_name": instance_name},
    ).mappings().first()
    if not row:
        return 0, 0
    return int(row["empresa_id"]), int(row["id"])


def _find_cliente(
    db: Session, *, empresa_id: int, telefone_digits: str, instancia_id: Optional[int]
) -> Optional[models.Cliente]:
    """
    Seu banco parece salvar:
      telefone (raw) = 5531...
      telefone_norm  = 319...
    Então procuramos por 2 candidatos: com e sem 55.
    """
    tel = _digits(telefone_digits)
    cands = {tel}
    if tel.startswith("55") and len(tel) >= 12:
        cands.add(tel[2:])

    q = (
        db.query(models.Cliente)
        .filter(models.Cliente.empresa_id == empresa_id)
        .filter(models.Cliente.telefone_norm.in_(list(cands)))
    )
    rows = q.all()
    if not rows:
        return None

    # se tiver mais de um (raro), prefere o que bate a instância atual
    if instancia_id:
        for r in rows:
            if r.instancia_id == instancia_id:
                return r
    return rows[0]


def _get_or_create_cliente(
    db: Session,
    *,
    empresa_id: int,
    instancia_id: int,
    telefone_digits: str,
) -> models.Cliente:
    cli = _find_cliente(db, empresa_id=empresa_id, telefone_digits=telefone_digits, instancia_id=instancia_id)
    if cli:
        # mantém telefone raw atualizado (se quiser)
        if telefone_digits:
            cli.telefone = _ensure_br_country(telefone_digits)
        if instancia_id and (cli.instancia_id != instancia_id):
            cli.instancia_id = instancia_id
        return cli

    # cria
    cli = models.Cliente(
        empresa_id=empresa_id,
        instancia_id=instancia_id,
        telefone=_ensure_br_country(telefone_digits) or telefone_digits,
        nome="Cliente",
    )
    db.add(cli)
    db.flush()  # pega cli.id
    return cli


def _fetch_empresa_instancia_info(db: Session, *, empresa_id: int, instancia_id: int) -> Tuple[str, str]:
    row = db.execute(
        text(
            """
            SELECT
              ei.instance_name AS instancia,
              e.nome AS empresa_nome
            FROM empresas_instancias ei
            JOIN empresas e ON e.id = ei.empresa_id
            WHERE ei.id = :instancia_id
              AND ei.empresa_id = :empresa_id
            LIMIT 1
            """
        ),
        {"empresa_id": empresa_id, "instancia_id": instancia_id},
    ).mappings().first()

    instancia = (row or {}).get("instancia") or ""
    empresa_nome = (row or {}).get("empresa_nome") or ""
    return str(instancia), str(empresa_nome)


def _fetch_departamentos(db: Session, *, empresa_id: int, instancia_id: int) -> List[Dict[str, Any]]:
    rows = db.execute(
        text(
            """
            SELECT d.id, d.nome
            FROM departamentos d
            WHERE d.empresa_id = :empresa_id
              AND d.ativo IS TRUE
              AND (
                EXISTS (
                  SELECT 1
                  FROM departamentos_instancias di
                  WHERE di.departamento_id = d.id
                    AND di.empresa_id = :empresa_id
                    AND di.instancia_id = :instancia_id
                )
                OR NOT EXISTS (
                  SELECT 1
                  FROM departamentos_instancias di2
                  WHERE di2.empresa_id = :empresa_id
                    AND di2.instancia_id = :instancia_id
                )
              )
            ORDER BY d.id ASC
            """
        ),
        {"empresa_id": empresa_id, "instancia_id": instancia_id},
    ).mappings().all()

    deps: List[Dict[str, Any]] = []
    for idx, r in enumerate(rows, start=1):
        deps.append({"idx": idx, "id": int(r["id"]), "nome": str(r["nome"] or "").strip()})
    return deps


def _parse_departamento_choice(texto: str, deps: List[Dict[str, Any]]) -> Tuple[Optional[int], Optional[int], Optional[str]]:
    """
    Aceita:
      - "2" ou "2 - financeiro"
      - "dep:12"
      - "financeiro"
    """
    t = _norm_txt(texto)
    if not t:
        return None, None, None

    # dep:ID
    m = re.fullmatch(r"dep:(\d+)", t)
    if m:
        dep_id = int(m.group(1))
        dep = next((d for d in deps if d["id"] == dep_id), None)
        return dep_id, (dep["idx"] if dep else None), (dep["nome"] if dep else None)

    # começa com número
    m = re.match(r"^(\d{1,2})\b", t)
    if m:
        opt = int(m.group(1))
        dep = next((d for d in deps if d["idx"] == opt), None)
        if dep:
            return int(dep["id"]), int(dep["idx"]), str(dep["nome"])

    # por nome (contém)
    if len(t) >= 3:
        for d in deps:
            dn = _norm_txt(d["nome"])
            if dn and (dn in t or t in dn):
                return int(d["id"]), int(d["idx"]), str(d["nome"])

    return None, None, None


def _fetch_primary_colab_id(db: Session, *, empresa_id: int, departamento_id: int) -> Optional[int]:
    row = db.execute(
        text(
            """
            SELECT colaborador_id
            FROM departamentos_membros
            WHERE empresa_id = :empresa_id
              AND departamento_id = :departamento_id
              AND is_primary IS TRUE
            LIMIT 1
            """
        ),
        {"empresa_id": empresa_id, "departamento_id": departamento_id},
    ).mappings().first()
    if not row:
        return None
    try:
        return int(row["colaborador_id"])
    except Exception:
        return None


def _send_text(db: Session, *, instancia_nome: str, remote_jid: str, text_msg: str) -> None:
    if not instancia_nome or not remote_jid or not text_msg:
        return
    payload = {
        "remoteJid": remote_jid,
        "messageText": text_msg,
        "options_message": {},
    }
    _evo_post("/messages/sendText", instancia_nome, payload)


def triagem_handle_inbound(
    db: Session,
    *,
    empresa_id: int,
    instancia_id: int,
    telefone_digits: str,
    texto: str,
    direction: str = "",
    remote_jid: str = "",
    ttl_hours: int = TRIAGEM_TTL_HOURS,
) -> Dict[str, Any]:
    """
    Regra:
      - Chegou msg ENTRADA:
          - Se ficou > ttl_hours sem falar: limpa departamento_id/colaborador_id e liga triagem_ativa
          - Atualiza triagem_ultima_msg_em = agora
          - Se precisa de triagem: manda menu ou aceita escolha e salva departamento_id
    """
    # não responde msg enviada por você
    if (direction or "").lower() == "saida":
        return {"ok": True, "action": "ignore_saida"}

    telefone_digits = _digits(telefone_digits)
    texto = (texto or "").strip()

    if not empresa_id or not instancia_id or not telefone_digits or not texto:
        return {"ok": True, "action": "noop_invalid"}

    instancia_nome, empresa_nome = _fetch_empresa_instancia_info(db, empresa_id=empresa_id, instancia_id=instancia_id)

    # garante cliente
    cliente = _get_or_create_cliente(
        db,
        empresa_id=empresa_id,
        instancia_id=instancia_id,
        telefone_digits=telefone_digits,
    )

    now = _now_utc()
    ttl = timedelta(hours=max(1, int(ttl_hours)))

    # 1) regra do "voltou depois de horas" -> reseta
    last = cliente.triagem_ultima_msg_em
    if last and (now - last) > ttl:
        cliente.departamento_id = None
        cliente.colaborador_id = None
        cliente.triagem_ativa = True
        cliente.triagem_tentativas = 0
        cliente.triagem_iniciada_em = now

    # 2) sempre atualiza última msg do cliente
    cliente.triagem_ultima_msg_em = now

    # 3) precisa triagem?
    needs_triage = (cliente.departamento_id is None) or bool(cliente.triagem_ativa)

    if not needs_triage:
        db.commit()
        return {"ok": True, "action": "noop_has_departamento"}

    # Se entrou em triagem agora e ainda não tem iniciada_em, seta
    if not cliente.triagem_iniciada_em:
        cliente.triagem_iniciada_em = now

    deps = _fetch_departamentos(db, empresa_id=empresa_id, instancia_id=instancia_id)

    if not deps:
        cliente.triagem_ativa = False
        db.commit()
        return {"ok": True, "action": "noop_no_deps"}

    dep_id, dep_idx, dep_nome = _parse_departamento_choice(texto, deps)

    if dep_id:
        # escolheu certo -> salva e para triagem
        cliente.departamento_id = dep_id
        cliente.triagem_ativa = False
        cliente.triagem_tentativas = int(cliente.triagem_tentativas or 0) + 1

        # atribui colab primário (se existir)
        primary = _fetch_primary_colab_id(db, empresa_id=empresa_id, departamento_id=dep_id)
        if primary:
            cliente.colaborador_id = primary

        db.commit()

        ack = f"Perfeito! Vou te encaminhar para *{dep_nome}*. Só um instante 🙂" if dep_nome else "Perfeito! Só um instante 🙂"
        _send_text(db, instancia_nome=instancia_nome, remote_jid=remote_jid, text_msg=ack)
        return {"ok": True, "action": "assign", "departamento_id": dep_id, "departamento_idx": dep_idx}

    # não escolheu (ou digitou algo diferente) -> manda menu
    linhas = "\n".join([f'{d["idx"]}) {d["nome"]}' for d in deps])
    menu = (
        f"Olá! Somos da *{empresa_nome or 'empresa'}* 🙂\n"
        f"Qual setor você quer falar?\n\n"
        f"{linhas}\n\n"
        f"Responda com o *número* (ex: 1) ou escreva o *nome do setor*."
    )

    cliente.triagem_ativa = True
    cliente.triagem_tentativas = int(cliente.triagem_tentativas or 0) + 1
    db.commit()

    _send_text(db, instancia_nome=instancia_nome, remote_jid=remote_jid, text_msg=menu)
    return {"ok": True, "action": "send_menu", "options": len(deps)}


@router.post("/chatbot/setores")
def webhook_chatbot_setores(payload: Dict[str, Any], db: Session = Depends(get_db)):
    """
    Webhook (substitui seu n8n nesse fluxo).

    Aceita:
      {
        "empresa_id": 7,                # opcional se mandar "instancia"/"instance_name"
        "instancia_id": 12,             # opcional se mandar "instancia"/"instance_name"
        "instancia": "minha-instancia", # opcional
        "numero": "5531986419237" ou "31986419237",
        "texto": "2",
        "direction": "entrada"|"saida",
        "jid": "5531986419237@s.whatsapp.net"
      }
    """
    empresa_id = int(payload.get("empresa_id") or 0)
    instancia_id = int(payload.get("instancia_id") or 0)

    instancia_nome_in = str(payload.get("instancia") or payload.get("instance_name") or "").strip()
    if (not empresa_id or not instancia_id) and instancia_nome_in:
        emp2, inst2 = _resolve_emp_inst_from_instance_name(db, instancia_nome_in)
        if not empresa_id:
            empresa_id = emp2
        if not instancia_id:
            instancia_id = inst2

    telefone = _digits(str(payload.get("numero") or payload.get("telefone") or ""))
    texto = str(payload.get("texto") or "").strip()
    direction = str(payload.get("direction") or "")
    remote_jid = _remote_jid_from_payload(telefone, str(payload.get("jid") or "").strip())

    res = triagem_handle_inbound(
        db,
        empresa_id=empresa_id,
        instancia_id=instancia_id,
        telefone_digits=telefone,
        texto=texto,
        direction=direction,
        remote_jid=remote_jid,
    )
    return JSONResponse(res)
