from __future__ import annotations

import os
import re
from datetime import datetime, timedelta, timezone
from typing import Optional, List, Dict, Any

import httpx
from fastapi import APIRouter, HTTPException, Body, Query

from backend.database import SessionLocal
from backend import models

"""
Endpoints:
- POST /api/atendimento/ia/resumo
- POST /api/atendimento/ia/melhorar

Recursos:
- janela_dias / limit para controlar a janela do diálogo (DEFAULT = 3 dias)
- include_dialogo (bool) para enviar ou não o texto bruto ao n8n
- redact (bool) para mascarar PII básico (email, telefone, lat/long)
- max_chars (int) para truncar diálogo longo mantendo cabeçalho e rodapé
- dialogo_override (Body) para enviar o diálogo já coletado do DOM
- draft / prompt_user (Body) no /melhorar
"""

router = APIRouter(prefix="/api/atendimento/ia", tags=["IA"]) 

# URLs separadas para cada workflow do n8n
N8N_URL_RESUMO   = os.getenv("N8N_URL_RESUMO",   "https://zapchats-n8n.9ywrah.easypanel.host/webhook/ia-resumo")
N8N_URL_MELHORAR = os.getenv("N8N_URL_MELHORAR", "https://zapchats-n8n.9ywrah.easypanel.host/webhook/ia-melhorar")
N8N_KEY = os.getenv("N8N_KEY", "")  # opcional: header para validar no n8n
ENV = os.getenv("ENV", "dev").lower()


# --------- Utilitários ---------
def _redact_pii(text: str) -> str:
    """Mascaramento simples de PII comum em atendimento."""
    if not text:
        return text
    # telefone BR (ex: 11 91234-5678, 11912345678, etc)
    text = re.sub(r"\b(?:\+?55\s?)?(?:\(?\d{2}\)?\s?)?\d{4,5}-?\d{4}\b", "(**telefone**)", text)
    # e-mail
    text = re.sub(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b", "(**email**)", text)
    # coordenadas lat,long (simples)
    text = re.sub(r"(-?\d{1,3}\.?\d+)\s*,\s*(-?\d{1,3}\.?\d+)", "(**coordenadas**)", text)
    # documentos simples (CPF/CNPJ — heurísticas)
    text = re.sub(r"\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b", "(**cpf**)", text)
    text = re.sub(r"\b\d{2}\.?\d{3}\.?\d{3}/?\d{4}-?\d{2}\b", "(**cnpj**)", text)
    return text


def _trim_middle(text: str, max_chars: int, head: int = 4000, tail: int = 4000) -> str:
    """Corta mantendo começo e fim do diálogo para não perder contexto final/recente."""
    if max_chars <= 0 or not text:
        return text
    if len(text) <= max_chars:
        return text
    if head + tail > max_chars:
        head = max(max_chars // 2, 1)
        tail = max(max_chars - head - 1, 1)
    return text[:head].rstrip() + "\n…\n" + text[-tail:].lstrip()


def montar_dialogo(empresa_id: int, cliente_id: int, janela_dias: int = 3, limit: int = 400) -> str:
    """Busca mensagens do BD e monta um diálogo 'Cliente:' / 'Agente:' em ordem cronológica."""
    db = SessionLocal()
    try:
        q = db.query(models.Mensagem).filter(
            models.Mensagem.empresa_id == empresa_id,
            models.Mensagem.cliente_id == cliente_id,
        )
        if janela_dias and janela_dias > 0:
            dt_min = datetime.now(timezone.utc) - timedelta(days=janela_dias)
            q = q.filter(models.Mensagem.timestamp >= dt_min)

        msgs: List[models.Mensagem] = (
            q.order_by(models.Mensagem.timestamp.desc()).limit(limit).all()
        )
        msgs = list(reversed(msgs))

        linhas: List[str] = []
        for m in msgs:
            who = "Cliente" if (m.tipo or "").lower() == "entrada" else "Agente"
            txt = (m.conteudo or "").strip()
            if not txt:
                continue
            linhas.append(f"{who}: {txt}")
        return "\n".join(linhas) if linhas else "Sem mensagens relevantes no período."
    finally:
        db.close()


def _raise_http_error(status_code: int, error: str, message: str | Dict[str, Any] | None = None) -> None:
    detail: Dict[str, Any] = {"error": error}
    if message is not None:
        detail["message"] = message
    raise HTTPException(status_code=status_code, detail=detail)


async def _post_n8n(url: str, payload: dict):
    """Encaminha o payload para o n8n e **sempre** garante resposta JSON de erro.

    - Conexão falhou → 502 (n8n_connect_error)
    - Timeout → 504 (n8n_timeout)
    - HTTPError → 502 (n8n_http_error)
    - n8n respondeu >=300 → repassa status + corpo (JSON se houver, senão texto)
    """
    headers = {"Content-Type": "application/json"}
    if N8N_KEY:
        headers["x-n8n-key"] = N8N_KEY

    try:
        async with httpx.AsyncClient(timeout=90) as cli:
            r = await cli.post(url, json=payload, headers=headers)
    except httpx.ConnectError as e:
        # Em dev, opcionalmente devolvemos mock para não travar o fluxo local
        if ENV == "dev":
            return {
                "resumo": {
                    "resumo_curto": "(mock) n8n indisponível em dev.",
                    "pontos_chave": ["verifique N8N_URL_*", "rede/porta", "logs do n8n"],
                    "topico": "mock",
                    "urgencia": "baixa",
                    "confianca": 0.2,
                }
            }
        _raise_http_error(502, "n8n_connect_error", str(e))
    except httpx.ReadTimeout:
        _raise_http_error(504, "n8n_timeout", "n8n não respondeu no tempo limite")
    except httpx.HTTPError as e:
        _raise_http_error(502, "n8n_http_error", str(e))

    if r.status_code >= 300:
        try:
            err_body = r.json()
        except Exception:
            err_body = r.text
        _raise_http_error(r.status_code, "n8n_error", err_body)

    try:
        return r.json()
    except Exception:
        # Se o n8n respondeu texto puro, ainda retornamos algo parseável
        return {"raw": r.text}


def _build_dialogo(
    empresa_id: int,
    cliente_id: int,
    janela_dias: int,
    limit: int,
    include_dialogo: bool,
    redact: bool,
    max_chars: int,
    dialogo_override: Optional[str] = None,
) -> Optional[str]:
    """
    Decide a fonte do diálogo:
      - se dialogo_override vier no Body, usa ele;
      - senão, se include_dialogo=True, monta a partir do BD;
      - senão, não envia.
    Aplica redact/trim se necessário.
    """
    base: Optional[str] = None
    if dialogo_override and str(dialogo_override).strip():
        base = str(dialogo_override).strip()
    elif include_dialogo:
        base = montar_dialogo(empresa_id, cliente_id, janela_dias, limit)

    if base is None:
        return None

    if redact:
        base = _redact_pii(base)
    if max_chars and max_chars > 0:
        base = _trim_middle(base, max_chars=max_chars)
    return base


# --------- Endpoints ---------
@router.post("/resumo")
async def resumo(
    empresa_id: int = Query(...),
    cliente_id: int = Query(...),
    full: bool = Query(False),
    janela_dias: int = Query(3, ge=0),
    limit: int = Query(400, ge=1, le=5000),
    idioma: str = Query("pt-BR"),
    include_dialogo: bool = Query(True),
    redact: bool = Query(True),
    max_chars: int = Query(9000, ge=0),  # 0 = sem truncar
    # Body opcional para sobrescrever o diálogo com o visível no DOM
    dialogo_override: Optional[str] = Body(None, embed=True),
):
    dialogo = _build_dialogo(
        empresa_id, cliente_id, janela_dias, limit, include_dialogo, redact, max_chars, dialogo_override
    )
    payload: Dict[str, Any] = {
        "mode": "resumo",
        "empresa_id": empresa_id,
        "cliente_id": cliente_id,
        "janela_dias": janela_dias,
        "limit": limit,
        "full": full,
        "idioma": idioma,
        "include_dialogo": bool(include_dialogo or bool(dialogo_override)),
        "redacted": bool(redact),
        "max_chars": max_chars,
    }
    if dialogo is not None:
        payload["dialogo"] = dialogo
    return await _post_n8n(N8N_URL_RESUMO, payload)


@router.post("/melhorar")
async def melhorar(
    empresa_id: int = Query(...),
    cliente_id: int = Query(...),
    janela_dias: int = Query(3, ge=0),
    limit: int = Query(200, ge=1, le=5000),
    idioma: str = Query("pt-BR"),
    include_dialogo: bool = Query(True),
    redact: bool = Query(True),
    max_chars: int = Query(9000, ge=0),
    # Body
    draft: Optional[str] = Body(None, embed=True),
    prompt_user: Optional[str] = Body(None, embed=True),
    dialogo_override: Optional[str] = Body(None, embed=True),
):
    dialogo = _build_dialogo(
        empresa_id, cliente_id, janela_dias, limit, include_dialogo, redact, max_chars, dialogo_override
    )
    payload: Dict[str, Any] = {
        "mode": "melhorar",
        "empresa_id": empresa_id,
        "cliente_id": cliente_id,
        "janela_dias": janela_dias,
        "limit": limit,
        "idioma": idioma,
        "include_dialogo": bool(include_dialogo or bool(dialogo_override)),
        "redacted": bool(redact),
        "max_chars": max_chars,
        "draft": draft or None,
        "prompt_user": (prompt_user or None),
    }
    if dialogo is not None:
        payload["dialogo"] = dialogo
    return await _post_n8n(N8N_URL_MELHORAR, payload)
