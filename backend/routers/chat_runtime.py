# backend/chatbot_runtime.py
from __future__ import annotations

import re
from typing import Dict, Any, Optional, List
from datetime import datetime, timedelta, timezone

from sqlalchemy.orm import Session

from backend.database import SessionLocal
from backend import models

# Tentamos reutilizar as rotinas já existentes de envio/broadcast
try:
    from backend.routers import atendimento_send  # type: ignore
except Exception:  # pragma: no cover
    atendimento_send = None  # fallback simples adiante


# ====== Configurações do runtime ======
# TTL para reenviar menu para o mesmo cliente (ex.: 24h)
MENU_TTL = timedelta(hours=24)


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _parse_horario(hor: str) -> tuple[int, int]:
    """
    Recebe '08:00 às 18:00' e devolve (8, 18).
    Se a janela for inválida, usa (8, 18).
    """
    try:
        m = re.search(r"(\d{1,2})\s*:\s*\d{2}\s*.*?\s*(\d{1,2})\s*:\s*\d{2}", hor or "")
        if not m:
            return 8, 18
        a, b = int(m.group(1)), int(m.group(2))
        a = max(0, min(a, 23))
        b = max(0, min(b, 23))
        if a == b:
            b = (b + 1) % 24
        return a, b
    except Exception:
        return 8, 18


def _is_online(cfg: Dict[str, Any]) -> bool:
    """
    Verifica se estamos dentro do horário informado (hora local do servidor).
    Aceita janelas que “viram” a meia-noite.
    """
    ini, fim = _parse_horario(cfg.get("horario") or "")
    h = datetime.now().hour
    if ini < fim:
        return ini <= h < fim
    return h >= ini or h < fim


def _load_cfg(db: Session, empresa_id: int) -> Dict[str, Any]:
    row = (
        db.query(models.ChatbotConfig)
        .filter(models.ChatbotConfig.empresa_id == empresa_id)
        .first()
    )
    return (row.config if row and isinstance(row.config, dict) else {}) or {}


def _build_menu_text(cfg: Dict[str, Any]) -> str:
    saudacao = cfg.get("saudacao") or "Olá! 👋"
    msg_off = cfg.get("msgOffline") or "Estamos fora do horário."
    online = _is_online(cfg)
    setores: List[str] = [
        str(s).strip() for s in (cfg.get("setores") or []) if str(s).strip()
    ]

    linhas = [
        saudacao if online else msg_off,
        "",
        "*Digite o número do setor desejado:*",
        "",
    ]
    nums = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣"]
    for i, nome in enumerate(setores[:9], start=1):
        linhas.append(f"{nums[i-1]} {nome}")
    return "\n".join(linhas).strip()


def _last_bot_menu_at(
    db: Session, empresa_id: int, cliente_id: int
) -> Optional[datetime]:
    q = (
        db.query(models.Mensagem)
        .filter(
            models.Mensagem.empresa_id == empresa_id,
            models.Mensagem.cliente_id == cliente_id,
            models.Mensagem.tipo == "saida",
            # usamos 'origem' para identificar mensagens do bot
            getattr(models.Mensagem, "origem") == "bot",  # requer coluna 'origem'
        )
        .order_by(models.Mensagem.timestamp.desc())
        .limit(1)
    )
    m = q.first()
    return getattr(m, "timestamp", None)


def _safe_send_text(db: Session, empresa: models.Empresa, cliente: models.Cliente, texto: str):
    """
    Reuso das rotinas de envio/broadcast (atendimento_send).
    Se não estiver disponível, grava apenas no banco (fallback mínimo).
    """
    if atendimento_send:
        # Grava no banco como 'saida'
        msg = atendimento_send._insert_msg_saida(  # type: ignore[attr-defined]
            db, empresa=empresa, cliente=cliente, conteudo=texto, msg_id=None
        )

        # marca origem do bot, se existir essa coluna
        try:
            msg.origem = "bot"
            db.commit()
        except Exception:
            pass

        # Dispara para Evolution
        try:
            _, instance = atendimento_send._resolve_empresa_e_instancia(  # type: ignore[attr-defined]
                db, empresa_id=empresa.id, instance=None
            )
            atendimento_send._evo_post(  # type: ignore[attr-defined]
                "/message/sendText", instance, {"number": cliente.telefone, "text": texto}
            )
        except Exception:
            # mesmo que falhe Evolution, mantemos no BD e broadcast
            pass

        # Broadcast (WS)
        try:
            import asyncio

            asyncio.create_task(
                atendimento_send._broadcast_msg_saida(  # type: ignore[attr-defined]
                    empresa, cliente, msg, midias=None
                )
            )
        except Exception:
            pass

    else:
        # Fallback mínimo: criar Mensagem 'saida' (sem Evolution)
        msg = models.Mensagem(
            empresa_id=empresa.id,
            cliente_id=cliente.id,
            tipo="saida",
            mensagem=texto,
            timestamp=_now_utc(),
        )
        # se tiver a coluna 'origem'
        if hasattr(msg, "origem"):
            setattr(msg, "origem", "bot")

        db.add(msg)
        db.commit()


def _maybe_send_menu(
    db: Session, empresa: models.Empresa, cliente: models.Cliente, cfg: Dict[str, Any]
):
    if not cfg.get("ativo", True):
        return

    # TTL do menu
    try:
        last = _last_bot_menu_at(db, empresa.id, cliente.id)
        if last and (_now_utc() - last) < MENU_TTL:
            return
    except Exception:
        # se der algum erro, ainda assim tentamos enviar
        pass

    text = _build_menu_text(cfg)
    _safe_send_text(db, empresa, cliente, text)


def _pick_setor_id(db: Session, empresa_id: int, nome_cfg: str) -> Optional[int]:
    s = (
        db.query(models.Setor)
        .filter(models.Setor.empresa_id == empresa_id)
        .filter(models.Setor.nome.ilike(f"%{nome_cfg.strip()}%"))
        .first()
    )
    return s.id if s else None


def _maybe_route_to_setor(
    db: Session,
    empresa: models.Empresa,
    cliente: models.Cliente,
    cfg: Dict[str, Any],
    texto: str,
) -> bool:
    """
    Se o usuário respondeu com '1..N' (ou 1️⃣..9️⃣), tenta redirecionar para o setor correspondente.
    """
    # aceita "1", "1)", "1 -", "1️⃣", etc.
    m = re.match(r"\s*([1-9])\D*", (texto or "").strip())
    if not m:
        return False

    idx = int(m.group(1)) - 1
    setores = [str(s).strip() for s in (cfg.get("setores") or []) if str(s).strip()]
    if idx < 0 or idx >= len(setores):
        return False

    nome = setores[idx]
    setor_id = _pick_setor_id(db, empresa.id, nome)

    # Se não tem um setor correspondente, pelo menos confirma escolha
    if not setor_id:
        confirm = f"Você selecionou *{nome}*. Em instantes um atendente irá te responder."
        _safe_send_text(db, empresa, cliente, confirm)
        return True

    # Se existir alguma rotina interna de redirecionamento, chamamos
    try:
        from backend.atendimentobot import redirecionar_para_atendente  # opcional

        import asyncio

        # executa sem bloquear
        asyncio.create_task(
            redirecionar_para_atendente(db, empresa, cliente, setor_id)
        )
        return True
    except Exception:
        # fallback: confirmação simples
        confirm = f"Você foi redirecionado para *{nome}*. Aguarde, por favor."
        _safe_send_text(db, empresa, cliente, confirm)
        return True


async def on_incoming(payload: Dict[str, Any]):
    """
    Handler assíncrono para ser chamado pelo seu endpoint /api/atendimento/broadcast
    quando chegar uma mensagem de ENTRADA.
    """
    if not payload or not isinstance(payload, dict):
        return
    if payload.get("tipo") != "entrada":
        return

    empresa_id = payload.get("empresa_id")
    cliente_id = payload.get("cliente_id")
    texto = (payload.get("mensagem") or "").strip()
    if not empresa_id or not cliente_id:
        return

    with SessionLocal() as db:
        empresa = db.query(models.Empresa).filter_by(id=empresa_id).first()
        if not empresa:
            return

        cliente = (
            db.query(models.Cliente)
            .filter_by(id=cliente_id, empresa_id=empresa.id)
            .first()
        )
        if not cliente:
            return

        cfg = _load_cfg(db, empresa.id)
        if not cfg.get("ativo", True):
            return

        # Se respondeu com número do menu, tenta redirecionar
        if _maybe_route_to_setor(db, empresa, cliente, cfg, texto):
            return

        # Cliente novo? manda menu na hora
        if bool(payload.get("novo_cliente")):
            _maybe_send_menu(db, empresa, cliente, cfg)
            return

        # Para clientes existentes, reenvia menu de tempos em tempos (MENU_TTL)
        _maybe_send_menu(db, empresa, cliente, cfg)
