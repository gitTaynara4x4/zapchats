from __future__ import annotations

import os
import json
import mimetypes
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

import requests
from fastapi import APIRouter, Depends, HTTPException, Path
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from backend.database import get_db
from backend import models
from backend.websocket_manager import conexoes_ativas
from backend.routers.auth import get_current_user

router = APIRouter(tags=["Atendimento – Envio"])

# ========= ENV Evolution =========
EVOLUTION_URL = os.getenv("EVOLUTION_URL", "").rstrip("/")
EVOLUTION_KEY = os.getenv("EVOLUTION_APIKEY") or os.getenv("EVOLUTION_KEY")
HEADERS = {"Content-Type": "application/json", "apikey": EVOLUTION_KEY} if EVOLUTION_KEY else {}

# ========= Helpers =========
def _assert_mesma_empresa(empresa_do_token: int, empresa_da_query: int | None) -> int:
    """
    Retorna o empresa_id efetivo. Se foi informado na query/body, valida que
    é igual ao do token. Caso contrário, usa o do token.
    """
    if empresa_da_query is None:
        return empresa_do_token
    if empresa_da_query != empresa_do_token:
        raise HTTPException(403, "Empresa inválida para este token")
    return empresa_da_query


def _assert_empresa_resolvida(empresa_do_token: int, empresa_resolvida_id: int) -> None:
    """
    Garante que a empresa derivada da instância (ou da busca) pertence ao token.
    """
    if empresa_resolvida_id != empresa_do_token:
        raise HTTPException(403, "Instância/empresa não pertence ao seu contexto")


def normalizar_telefone(numero: str | None) -> str | None:
    if not numero:
        return None
    import re as _re
    numero = _re.sub(r"\D", "", numero)
    if numero.startswith("0"):
        numero = numero[1:]
    if not numero.startswith("55"):
        numero = "55" + numero
    ddd = numero[2:4]
    restante = numero[4:]
    if len(restante) == 8 and not restante.startswith("9"):
        restante = "9" + restante
    return f"55{ddd}{restante}"


def _remote_to_num(remote_jid: str | None) -> str | None:
    """Recebe '5511999999999@s.whatsapp.net' (com ou sem :device) e devolve 55DDDN..."""
    if not remote_jid:
        return None
    user = str(remote_jid).split("@", 1)[0].split(":", 1)[0]
    return normalizar_telefone(user)


def formatar_telefone_br(numero: str) -> str:
    numero = "".join(filter(str.isdigit, numero))
    if len(numero) == 13:
        return f"+{numero[:2]} {numero[2:4]} {numero[4:9]}-{numero[9:]}"
    if len(numero) == 12:
        return f"+{numero[:2]} {numero[2:4]} {numero[4:8]}-{numero[8:]}"
    return f"+{numero[:2]} {numero[2:]}"


def _now_sp() -> datetime:
    """
    Retorna **UTC com timezone** (tz-aware).
    O modelo usa TIMESTAMP(timezone=True), então manter tudo em UTC evita deslocamentos -3h.
    O front converte para America/Sao_Paulo.
    """
    return datetime.now(timezone.utc)


def _ensure_auth():
    if not EVOLUTION_KEY:
        raise HTTPException(500, "EVOLUTION_APIKEY/EVOLUTION_KEY não configurada no ambiente.")
    if not EVOLUTION_URL:
        raise HTTPException(500, "EVOLUTION_URL não configurada no ambiente.")


def _evo_post(path: str, instance: str, payload: Dict[str, Any], timeout: int = 30) -> Dict[str, Any]:
    _ensure_auth()
    url = f"{EVOLUTION_URL}{path}/{instance}"
    r = requests.post(url, headers=HEADERS, data=json.dumps(payload), timeout=timeout)
    if r.status_code >= 400:
        raise HTTPException(r.status_code, f"Evolution error {r.status_code}: {r.text}")
    try:
        return r.json()
    except Exception:
        return {"raw": r.text}


def _resolve_empresa_e_instancia(
    db: Session,
    *,
    empresa_id: Optional[int],
    instance: Optional[str],
    instancia_id: Optional[int],
    numero_norm: Optional[str] = None,
) -> Tuple[models.Empresa, str, Optional[int]]:
    """
    Regras:
      1) instance (nome) → usa diretamente (checa se existe).
      2) instancia_id → pega em empresas_instancias, volta instance_name.
      3) empresa_id + numero_norm → tenta descobrir pela última mensagem desse cliente (instancia_id);
      4) empresa_id com uma única instância → usa essa;
      5) senão, 400 listando opções.
    Retorna: (empresa, instance_name, instancia_id)
    """
    # 1) pelo nome
    if instance:
        inst_row = (
            db.query(models.EmpresaInstancia)
            .filter(models.EmpresaInstancia.instance_name == instance)
            .first()
        )
        if not inst_row:
            raise HTTPException(404, f"Instância '{instance}' não encontrada.")
        emp = db.query(models.Empresa).filter(models.Empresa.id == inst_row.empresa_id).first()
        if not emp:
            raise HTTPException(404, "Empresa da instância não encontrada.")
        return emp, inst_row.instance_name, inst_row.id

    # 2) pelo id
    if instancia_id is not None:
        inst_row = (
            db.query(models.EmpresaInstancia)
            .filter(models.EmpresaInstancia.id == instancia_id)
            .first()
        )
        if not inst_row:
            raise HTTPException(404, f"Instância id={instancia_id} não encontrada.")
        emp = db.query(models.Empresa).filter(models.Empresa.id == inst_row.empresa_id).first()
        if not emp:
            raise HTTPException(404, "Empresa da instância não encontrada.")
        return emp, inst_row.instance_name, inst_row.id

    # 3) empresa + numero → última instância usada
    if empresa_id and numero_norm:
        emp = db.query(models.Empresa).filter(models.Empresa.id == empresa_id).first()
        if not emp:
            raise HTTPException(404, f"Empresa id={empresa_id} não encontrada.")

        cli = db.query(models.Cliente).filter_by(empresa_id=empresa_id, telefone=numero_norm).first()
        if cli:
            last = (
                db.query(models.Mensagem)
                .filter(
                    models.Mensagem.empresa_id == empresa_id,
                    models.Mensagem.cliente_id == cli.id,
                    models.Mensagem.instancia_id.isnot(None),
                )
                .order_by(models.Mensagem.timestamp.desc(), models.Mensagem.id.desc())
                .first()
            )
            if last and last.instancia_id:
                inst_row = (
                    db.query(models.EmpresaInstancia)
                    .filter(models.EmpresaInstancia.id == last.instancia_id)
                    .first()
                )
                if inst_row:
                    return emp, inst_row.instance_name, inst_row.id

        insts = (
            db.query(models.EmpresaInstancia)
            .filter(models.EmpresaInstancia.empresa_id == empresa_id)
            .all()
        )
        if len(insts) == 1:
            return emp, insts[0].instance_name, insts[0].id

        if insts:
            opts = [{"id": r.id, "instance_name": r.instance_name} for r in insts]
            raise HTTPException(
                400,
                {
                    "error": "empresa_tem_varias_instancias",
                    "message": "Informe 'instance' (nome) ou 'instancia_id' para escolher.",
                    "opcoes": opts,
                },
            )
        raise HTTPException(400, "Empresa sem instâncias cadastradas.")

    # 4) empresa sem número → tenta única instância
    if empresa_id:
        emp = db.query(models.Empresa).filter(models.Empresa.id == empresa_id).first()
        if not emp:
            raise HTTPException(404, f"Empresa id={empresa_id} não encontrada.")
        insts = (
            db.query(models.EmpresaInstancia)
            .filter(models.EmpresaInstancia.empresa_id == empresa_id)
            .all()
        )
        if len(insts) == 1:
            return emp, insts[0].instance_name, insts[0].id
        if insts:
            opts = [{"id": r.id, "instance_name": r.instance_name} for r in insts]
            raise HTTPException(
                400,
                {
                    "error": "empresa_tem_varias_instancias",
                    "message": "Informe 'instance' (nome) ou 'instancia_id'.",
                    "opcoes": opts,
                },
            )
        raise HTTPException(400, "Empresa sem instâncias cadastradas.")

    # 5) faltou parâmetro
    raise HTTPException(400, "Informe 'instance' (nome) ou 'instancia_id'; ou 'empresa_id' + 'number'.")


def _get_or_create_cliente(db: Session, empresa: models.Empresa, numero_norm: str) -> models.Cliente:
    cli = db.query(models.Cliente).filter_by(empresa_id=empresa.id, telefone=numero_norm).first()
    if cli:
        return cli
    cli = models.Cliente(
        empresa_id=empresa.id,
        telefone=numero_norm,
        nome=formatar_telefone_br(numero_norm),
        nome_whatsapp=None,
        avatar_url=None,
    )
    db.add(cli)
    db.commit()
    db.refresh(cli)
    return cli


def _insert_msg_saida(
    db: Session,
    *,
    empresa: models.Empresa,
    cliente: models.Cliente,
    conteudo: str,
    msg_id: Optional[str],
    instancia_id: Optional[int],
) -> models.Mensagem:
    m = models.Mensagem(
        empresa_id=empresa.id,
        cliente_id=cliente.id,
        conteudo=conteudo,
        tipo="saida",
        lida=True,
        ack=0,
        timestamp=_now_sp(),  # UTC tz-aware
        msg_id=msg_id,
        instancia_id=instancia_id,
    )
    db.add(m)
    db.commit()
    db.refresh(m)
    return m


# -------- broadcast --------
async def _broadcast_msg_saida(
    empresa: models.Empresa,
    cliente: models.Cliente,
    msg: models.Mensagem,
    midias: Optional[List[Dict[str, Any]]] = None,
    instance_name: Optional[str] = None,
    atendente_nome: Optional[str] = None,  # ⬅️ NOVO: nome do atendente que enviou
):
    payload = {
        "empresa_id": empresa.id,
        "cliente_id": cliente.id,
        "telefone": formatar_telefone_br(cliente.telefone),
        "avatar_url": cliente.avatar_url,
        "push_name": getattr(cliente, "nome_whatsapp", None),
        "nome": cliente.nome,
        "mensagem": msg.conteudo,
        "tipo": "saida",
        "origem": "atendente",
        "timestamp": msg.timestamp.isoformat(timespec="microseconds"),
        "msg_id": msg.msg_id or str(msg.id),
        "ack": 0,
        "instancia_id": msg.instancia_id,
        "instance_name": instance_name,
        "atendente_nome": atendente_nome,  # ⬅️ NOVO: enviado ao front
    }
    if midias:
        payload["midias"] = midias

    await conexoes_ativas.send_message(f"emp:{empresa.id}", payload)


# ========= Schemas =========
class QuoteKey(BaseModel):
    id: str
    remoteJid: Optional[str] = None
    fromMe: Optional[bool] = None


class QuoteMessage(BaseModel):
    conversation: Optional[str] = None


class Quoted(BaseModel):
    key: QuoteKey
    message: Optional[QuoteMessage] = None


class BaseSend(BaseModel):
    empresa_id: Optional[int] = Field(None, description="ID da empresa (ou use 'instance'/'instancia_id')")
    instance: Optional[str] = Field(None, description="Nome da instância (alternativa a empresa_id)")
    instancia_id: Optional[int] = Field(None, description="ID da instância (alternativa a instance)")
    number: str = Field(..., description="Número do cliente (somente dígitos; DDI+DDD+telefone)")


class SendTextReq(BaseSend):
    text: str
    delay: Optional[int] = None
    linkPreview: Optional[bool] = None
    mentionsEveryOne: Optional[bool] = None
    mentioned: Optional[List[str]] = None
    quoted: Optional[Quoted] = None


class SendAudioReq(BaseSend):
    audio: str  # URL http(s) ou base64
    delay: Optional[int] = None
    linkPreview: Optional[bool] = None
    mentionsEveryOne: Optional[bool] = None
    mentioned: Optional[List[str]] = None
    quoted: Optional[Quoted] = None


class SendMediaReq(BaseSend):
    media: str   # URL http(s) ou base64
    mediatype: str  # image|video|document|audio...
    mimetype: Optional[str] = None
    caption: Optional[str] = None
    fileName: Optional[str] = None
    delay: Optional[int] = None
    linkPreview: Optional[bool] = None
    mentionsEveryOne: Optional[bool] = None
    mentioned: Optional[List[str]] = None
    quoted: Optional[Quoted] = None


class SendStickerReq(BaseSend):
    sticker: str  # URL/base64 (webp/png)
    delay: Optional[int] = None
    linkPreview: Optional[bool] = None
    mentionsEveryOne: Optional[bool] = None
    mentioned: Optional[List[str]] = None
    quoted: Optional[Quoted] = None


class ContactItem(BaseModel):
    fullName: Optional[str] = None
    wuid: Optional[str] = None
    phoneNumber: Optional[str] = None
    organization: Optional[str] = None
    email: Optional[str] = None
    url: Optional[str] = None


class SendContactReq(BaseSend):
    contact: List[ContactItem]


class ReactionKey(BaseModel):
    remoteJid: str
    fromMe: bool = True
    id: str


class SendReactionReq(BaseModel):
    empresa_id: Optional[int] = None
    instance: Optional[str] = None
    instancia_id: Optional[int] = None
    key: ReactionKey
    reaction: str


# ========= Rotas (corpo aceita empresa_id/instance/instancia_id) =========
@router.post("/send/text")
async def send_text(
    body: SendTextReq,
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    numero = normalizar_telefone(body.number)
    if not numero:
        raise HTTPException(400, "Número inválido.")

    # valida empresa do token vs body
    efetiva_empresa_id = _assert_mesma_empresa(user.empresa_id, body.empresa_id)

    empresa, inst_name, inst_id = _resolve_empresa_e_instancia(
        db,
        empresa_id=efetiva_empresa_id,
        instance=body.instance,
        instancia_id=body.instancia_id,
        numero_norm=numero,
    )
    _assert_empresa_resolvida(user.empresa_id, empresa.id)

    cliente = _get_or_create_cliente(db, empresa, numero)

    payload = {
        "number": numero,
        "text": body.text,
        "delay": body.delay,
        "linkPreview": body.linkPreview,
        "mentionsEveryOne": body.mentionsEveryOne,
        "mentioned": body.mentioned,
        "quoted": body.quoted.model_dump(exclude_none=True) if body.quoted else None,
    }
    payload = {k: v for k, v in payload.items() if v is not None}

    evo = _evo_post("/message/sendText", inst_name, payload)
    msg_id = ((evo or {}).get("key") or {}).get("id")

    msg = _insert_msg_saida(
        db,
        empresa=empresa,
        cliente=cliente,
        conteudo=body.text,
        msg_id=msg_id,
        instancia_id=inst_id,
    )
    await _broadcast_msg_saida(
        empresa,
        cliente,
        msg,
        instance_name=inst_name,
        atendente_nome=getattr(user, "nome", None),  # ⬅️ NOVO
    )
    return {
        "evolution": evo,
        "db": {"mensagem_id": msg.id, "cliente_id": cliente.id, "instancia_id": inst_id},
        "instance_name": inst_name,
    }


@router.post("/send/audio")
async def send_audio(
    body: SendAudioReq,
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    numero = normalizar_telefone(body.number)
    if not numero:
        raise HTTPException(400, "Número inválido.")

    efetiva_empresa_id = _assert_mesma_empresa(user.empresa_id, body.empresa_id)

    empresa, inst_name, inst_id = _resolve_empresa_e_instancia(
        db,
        empresa_id=efetiva_empresa_id,
        instance=body.instance,
        instancia_id=body.instancia_id,
        numero_norm=numero,
    )
    _assert_empresa_resolvida(user.empresa_id, empresa.id)

    cliente = _get_or_create_cliente(db, empresa, numero)

    payload = {
        "number": numero,
        "audio": body.audio,
        "delay": body.delay,
        "linkPreview": body.linkPreview,
        "mentionsEveryOne": body.mentionsEveryOne,
        "mentioned": body.mentioned,
        "quoted": body.quoted.model_dump(exclude_none=True) if body.quoted else None,
    }
    payload = {k: v for k, v in payload.items() if v is not None}

    evo = _evo_post("/message/sendWhatsAppAudio", inst_name, payload)
    msg_id = ((evo or {}).get("key") or {}).get("id")

    msg = _insert_msg_saida(
        db,
        empresa=empresa,
        cliente=cliente,
        conteudo="[Áudio]",
        msg_id=msg_id,
        instancia_id=inst_id,
    )

    audio_url = body.audio
    if audio_url and not audio_url.startswith("http") and not audio_url.startswith("data:"):
        audio_url = f"data:audio/ogg;base64,{body.audio}"  # ajuste se usar webm/mp3

    await _broadcast_msg_saida(
        empresa,
        cliente,
        msg,
        midias=[{"tipo": "audio", "mimetype": "audio/ogg", "filename": "", "url": audio_url}],
        instance_name=inst_name,
        atendente_nome=getattr(user, "nome", None),  # ⬅️ NOVO
    )
    return {
        "evolution": evo,
        "db": {"mensagem_id": msg.id, "cliente_id": cliente.id, "instancia_id": inst_id},
        "instance_name": inst_name,
    }


@router.post("/send/media")
async def send_media(
    body: SendMediaReq,
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    numero = normalizar_telefone(body.number)
    if not numero:
        raise HTTPException(400, "Número inválido.")

    efetiva_empresa_id = _assert_mesma_empresa(user.empresa_id, body.empresa_id)

    empresa, inst_name, inst_id = _resolve_empresa_e_instancia(
        db,
        empresa_id=efetiva_empresa_id,
        instance=body.instance,
        instancia_id=body.instancia_id,
        numero_norm=numero,
    )
    _assert_empresa_resolvida(user.empresa_id, empresa.id)

    cliente = _get_or_create_cliente(db, empresa, numero)

    mimetype = body.mimetype
    if not mimetype and body.fileName:
        guess = mimetypes.guess_type(body.fileName)[0]
        if guess:
            mimetype = guess

    payload = {
        "number": numero,
        "mediatype": body.mediatype,
        "mimetype": mimetype,
        "caption": body.caption,
        "media": body.media,
        "fileName": body.fileName,
        "delay": body.delay,
        "linkPreview": body.linkPreview,
        "mentionsEveryOne": body.mentionsEveryOne,
        "mentioned": body.mentioned,
        "quoted": body.quoted.model_dump(exclude_none=True) if body.quoted else None,
    }
    payload = {k: v for k, v in payload.items() if v is not None}

    evo = _evo_post("/message/sendMedia", inst_name, payload)
    msg_id = ((evo or {}).get("key") or {}).get("id")
    conteudo = body.caption or "[Mídia]"

    msg = _insert_msg_saida(
        db,
        empresa=empresa,
        cliente=cliente,
        conteudo=conteudo,
        msg_id=msg_id,
        instancia_id=inst_id,
    )

    media_url = body.media
    if media_url and not media_url.startswith("http") and not media_url.startswith("data:"):
        mime = mimetype or "application/octet-stream"
        media_url = f"data:{mime};base64,{body.media}"

    midias = [{
        "tipo": body.mediatype,
        "mimetype": mimetype or "",
        "filename": body.fileName or "",
        "url": media_url,
    }]

    await _broadcast_msg_saida(
        empresa,
        cliente,
        msg,
        midias=midias,
        instance_name=inst_name,
        atendente_nome=getattr(user, "nome", None),  # ⬅️ NOVO
    )
    return {
        "evolution": evo,
        "db": {"mensagem_id": msg.id, "cliente_id": cliente.id, "instancia_id": inst_id},
        "instance_name": inst_name,
    }


@router.post("/send/sticker")
async def send_sticker(
    body: SendStickerReq,
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    numero = normalizar_telefone(body.number)
    if not numero:
        raise HTTPException(400, "Número inválido.")

    efetiva_empresa_id = _assert_mesma_empresa(user.empresa_id, body.empresa_id)

    empresa, inst_name, inst_id = _resolve_empresa_e_instancia(
        db,
        empresa_id=efetiva_empresa_id,
        instance=body.instance,
        instancia_id=body.instancia_id,
        numero_norm=numero,
    )
    _assert_empresa_resolvida(user.empresa_id, empresa.id)

    cliente = _get_or_create_cliente(db, empresa, numero)

    payload = {
        "number": numero,
        "sticker": body.sticker,
        "delay": body.delay,
        "linkPreview": body.linkPreview,
        "mentionsEveryOne": body.mentionsEveryOne,
        "mentioned": body.mentioned,
        "quoted": body.quoted.model_dump(exclude_none=True) if body.quoted else None,
    }
    payload = {k: v for k, v in payload.items() if v is not None}

    evo = _evo_post("/message/sendSticker", inst_name, payload)
    msg_id = ((evo or {}).get("key") or {}).get("id")
    msg = _insert_msg_saida(
        db,
        empresa=empresa,
        cliente=cliente,
        conteudo="[Figurinha]",
        msg_id=msg_id,
        instancia_id=inst_id,
    )
    await _broadcast_msg_saida(
        empresa,
        cliente,
        msg,
        instance_name=inst_name,
        atendente_nome=getattr(user, "nome", None),  # ⬅️ NOVO
    )
    return {
        "evolution": evo,
        "db": {"mensagem_id": msg.id, "cliente_id": cliente.id, "instancia_id": inst_id},
        "instance_name": inst_name,
    }


@router.post("/send/contact")
async def send_contact(
    body: SendContactReq,
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    numero = normalizar_telefone(body.number)
    if not numero:
        raise HTTPException(400, "Número inválido.")

    efetiva_empresa_id = _assert_mesma_empresa(user.empresa_id, body.empresa_id)

    empresa, inst_name, inst_id = _resolve_empresa_e_instancia(
        db,
        empresa_id=efetiva_empresa_id,
        instance=body.instance,
        instancia_id=body.instancia_id,
        numero_norm=numero,
    )
    _assert_empresa_resolvida(user.empresa_id, empresa.id)

    cliente = _get_or_create_cliente(db, empresa, numero)

    payload = {"number": numero, "contact": [c.model_dump(exclude_none=True) for c in body.contact]}
    evo = _evo_post("/message/sendContact", inst_name, payload)
    msg_id = ((evo or {}).get("key") or {}).get("id")
    msg = _insert_msg_saida(
        db,
        empresa=empresa,
        cliente=cliente,
        conteudo="[Contato]",
        msg_id=msg_id,
        instancia_id=inst_id,
    )
    await _broadcast_msg_saida(
        empresa,
        cliente,
        msg,
        instance_name=inst_name,
        atendente_nome=getattr(user, "nome", None),  # ⬅️ NOVO
    )
    return {
        "evolution": evo,
        "db": {"mensagem_id": msg.id, "cliente_id": cliente.id, "instancia_id": inst_id},
        "instance_name": inst_name,
    }


@router.post("/send/reaction")
async def send_reaction(
    body: SendReactionReq,
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    # Para reação, precisamos da instância para chamar a Evolution.
    efetiva_empresa_id = _assert_mesma_empresa(user.empresa_id, body.empresa_id)

    empresa = None
    inst_name = None
    inst_id = None
    if body.instance or body.instancia_id:
        empresa, inst_name, inst_id = _resolve_empresa_e_instancia(
            db,
            empresa_id=efetiva_empresa_id,
            instance=body.instance,
            instancia_id=body.instancia_id,
            numero_norm=None,
        )
        _assert_empresa_resolvida(user.empresa_id, empresa.id)
    elif body.empresa_id:
        # Se veio só empresa, exigir instância explicitamente
        raise HTTPException(400, "Para reação, informe 'instance' (nome) ou 'instancia_id'.")

    payload = {"key": body.key.model_dump(exclude_none=True), "reaction": body.reaction}
    evo = _evo_post("/message/sendReaction", inst_name, payload)

    # refletir no front
    cliente_id: Optional[int] = None
    try:
        if empresa:
            msg = (
                db.query(models.Mensagem)
                .filter(models.Mensagem.empresa_id == empresa.id, models.Mensagem.msg_id == body.key.id)
                .order_by(models.Mensagem.id.desc())
                .first()
            )
            if msg:
                cliente_id = msg.cliente_id
            elif body.key.remoteJid:
                num = _remote_to_num(body.key.remoteJid)
                if num:
                    cli = db.query(models.Cliente).filter_by(empresa_id=empresa.id, telefone=num).first()
                    if cli:
                        cliente_id = cli.id
    except Exception:
        pass

    if cliente_id and empresa:
        await conexoes_ativas.send_message(
            f"emp:{empresa.id}",
            {
                "type": "reaction",
                "cliente_id": cliente_id,
                "msg_id": body.key.id,
                "reaction": body.reaction,
                "remove": False,
                "timestamp": _now_sp().isoformat(timespec="microseconds"),
                "instancia_id": inst_id,
                "instance_name": inst_name,
            },
        )

    return {"evolution": evo, "cliente_id": cliente_id, "instancia_id": inst_id, "instance_name": inst_name}


# ========= Rotas alternativas com instância explícita na URL =========
# Ex.: POST /api/atendimento/instance/{instance}/send/text
@router.post("/instance/{instance}/send/text")
async def send_text_by_instance(
    instance: str = Path(..., description="Nome da instância Evolution"),
    body: SendTextReq = None,
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    # força a instância da URL e reutiliza a validação da rota principal
    data = body or SendTextReq(empresa_id=None, instance=instance, number="", text="")
    data.instance = instance
    return await send_text(data, db, user)


@router.post("/instancia/{instancia_id}/send/text")
async def send_text_by_instancia_id(
    instancia_id: int = Path(..., description="ID da instância (empresas_instancias.id)"),
    body: SendTextReq = None,
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    data = body or SendTextReq(empresa_id=None, instancia_id=instancia_id, number="", text="")
    data.instancia_id = instancia_id
    return await send_text(data, db, user)
