# backend/routers/atendimento_send.py
from __future__ import annotations

import os
import json
import mimetypes
import re
import time
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

import requests
from fastapi import APIRouter, Depends, HTTPException, Path, Body
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session
from sqlalchemy import text

from backend.database import get_db
from backend import models
from backend.websocket_manager import conexoes_ativas
from backend.routers.auth import get_current_identity

router = APIRouter(tags=["Atendimento – Envio"])

# ========= ENV Evolution =========
EVOLUTION_URL = os.getenv("EVOLUTION_URL", "").rstrip("/")
EVOLUTION_KEY = os.getenv("EVOLUTION_APIKEY") or os.getenv("EVOLUTION_KEY")
HEADERS = {"Content-Type": "application/json", "apikey": EVOLUTION_KEY} if EVOLUTION_KEY else {}

# ========= DEBUG =========
DEBUG_ATENDIMENTO_SEND = os.getenv("DEBUG_ATENDIMENTO_SEND", "1").strip().lower() in ("1", "true", "yes", "on")


def _dbg(*args):
    if not DEBUG_ATENDIMENTO_SEND:
        return
    try:
        print("[SEND_DEBUG]", *args)
    except Exception:
        pass


def _dbg_json(label: str, obj: Any):
    if not DEBUG_ATENDIMENTO_SEND:
        return
    try:
        print("[SEND_DEBUG]", label, json.dumps(obj, ensure_ascii=False, indent=2, default=str))
    except Exception:
        print("[SEND_DEBUG]", label, obj)


# =========================================================
# AVATAR: nunca devolver pps.whatsapp.net pro front
# =========================================================
def _public_avatar_url(*, kind: str, conversation_id: int, raw_avatar_url: Optional[str]) -> Optional[str]:
    """
    Força o front a sempre usar um endpoint local (proxy/cache),
    mesmo que o banco tenha guardado https://pps.whatsapp.net/...
    kind: "cliente" | "grupo"
    """
    if not conversation_id:
        return None

    raw = (raw_avatar_url or "").strip()
    if not raw:
        return None

    # já é endpoint nosso
    if raw.startswith("/api/atendimento/avatar/"):
        return raw

    # qualquer URL externa vira proxy local
    if raw.startswith("http://") or raw.startswith("https://"):
        return f"/api/atendimento/avatar/{int(conversation_id)}?kind={kind}"

    # fallback seguro
    return f"/api/atendimento/avatar/{int(conversation_id)}?kind={kind}"


# =========================================================
# ACL / Permissões
# =========================================================
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


def _is_admin(identity: dict) -> bool:
    try:
        if identity.get("is_admin") or identity.get("admin"):
            return True
        perms = identity.get("permissoes") or identity.get("permissions") or []
        if isinstance(perms, dict):
            perms = [k for k, v in perms.items() if v]
        perms = set(str(p).lower() for p in (perms or []))
        return any(p in perms for p in ("admin", "root", "clientes.gerenciar", "atendimento.gerenciar"))
    except Exception:
        return False


def _ensure_perm(identity: dict, perm: str) -> None:
    if _is_admin(identity):
        return
    perms = set(identity.get("permissoes") or [])
    if perm not in perms:
        raise HTTPException(status_code=403, detail=f"Sem permissão ({perm})")


def _infer_kind(identity: dict) -> str:
    k = (identity.get("kind") or identity.get("tipo") or "").lower().strip()
    if k in ("colaborador", "usuario", "admin"):
        return "colaborador" if k == "colaborador" else "usuario"
    sub = str(identity.get("sub") or "").strip().lower()
    role = str(identity.get("role") or "").strip().lower()
    if sub.startswith("colab-") or "colab" in role or "colaborador" in role:
        return "colaborador"
    return "usuario"


def _get_colab_id(identity: dict) -> Optional[int]:
    for key in ("id_colab", "colaborador_id", "id_colaborador", "colab_id", "cid"):
        cid = _to_int(identity.get(key))
        if cid:
            return cid
    sub = str(identity.get("sub") or "").strip().lower()
    if sub.startswith("colab-"):
        cid = _to_int(sub.split("-", 1)[1])
        if cid:
            return cid
    return _to_int(identity.get("id"))


def _table_exists(db: Session, table_name: str) -> bool:
    try:
        reg = db.execute(text(f"SELECT to_regclass('public.{table_name}')")).scalar()
        return reg is not None
    except Exception:
        return False


def _allowed_instancia_ids(db: Session, identity: dict, empresa_id: int) -> Optional[List[int]]:
    """
    Retorna:
      - None => sem restrição (admin/usuario master OU tabela inexistente)
      - []   => colaborador sem instâncias permitidas (nega tudo)
      - [..] => lista de instâncias permitidas
    """
    if _is_admin(identity):
        return None

    if _infer_kind(identity) != "colaborador":
        return None

    if not _table_exists(db, "colaboradores_instancias"):
        return None  # legado

    cid = _get_colab_id(identity)
    if not cid:
        return []

    rows = db.execute(
        text(
            """
            SELECT instancia_id
            FROM colaboradores_instancias
            WHERE empresa_id = :emp
              AND colaborador_id = :cid
            """
        ),
        {"emp": int(empresa_id), "cid": int(cid)},
    ).fetchall()

    ids = [int(r[0]) for r in rows if r and r[0] is not None]
    return ids


def _assert_instancia_allowed(allowed: Optional[List[int]], instancia_id: Optional[int]) -> None:
    if instancia_id is None or allowed is None:
        return
    if int(instancia_id) not in set(int(x) for x in allowed):
        raise HTTPException(status_code=403, detail="Instância não permitida para este usuário")


# ========= Helpers base =========
def _assert_mesma_empresa(empresa_do_token: int, empresa_da_query: int | None) -> int:
    if empresa_da_query is None:
        return int(empresa_do_token)
    if int(empresa_da_query) != int(empresa_do_token):
        raise HTTPException(403, "Empresa inválida para este token")
    return int(empresa_da_query)


def _assert_empresa_resolvida(empresa_do_token: int, empresa_resolvida_id: int) -> None:
    if int(empresa_resolvida_id) != int(empresa_do_token):
        raise HTTPException(403, "Instância/empresa não pertence ao seu contexto")


def normalizar_telefone(numero: str | None) -> str | None:
    if not numero:
        return None
    numero = re.sub(r"\D", "", numero)
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
    if not remote_jid:
        return None
    user = str(remote_jid).split("@", 1)[0].split(":", 1)[0]
    return normalizar_telefone(user)


def _destino_e_numero_norm(raw: str | None) -> tuple[str | None, str | None, bool]:
    """Retorna (destino, numero_norm, is_group)."""
    if not raw:
        return None, None, False

    s = str(raw).strip()
    if not s:
        return None, None, False

    s_lower = s.lower()

    # 1) Já veio como JID
    if s_lower.endswith("@g.us"):
        return s, None, True
    if s_lower.endswith("@s.whatsapp.net"):
        base = s_lower.replace("@s.whatsapp.net", "")
        num = normalizar_telefone(base)
        return (f"{num}@s.whatsapp.net" if num else s), num, False

    # 2) Heurísticas para identificar grupo SEM sufixo
    if "-" in s:
        left, right = s.split("-", 1)
        left_digits = re.sub(r"\D", "", left or "")
        right_digits = re.sub(r"\D", "", right or "")
        if left_digits and right_digits:
            return f"{left_digits}-{right_digits}@g.us", None, True
        digits = re.sub(r"\D", "", s)
        if digits:
            return f"{s}@g.us", None, True

    digits_only = re.sub(r"\D", "", s)
    if digits_only.startswith("120") and len(digits_only) >= 16:
        return f"{digits_only}@g.us", None, True
    if len(digits_only) >= 18:
        return f"{digits_only}@g.us", None, True

    # 3) Caso padrão: conversa 1:1 por telefone
    num = normalizar_telefone(s)
    if not num:
        return s, None, False
    return num, num, False


def formatar_telefone_br(numero: str) -> str:
    numero = "".join(filter(str.isdigit, numero))
    if len(numero) == 13:
        return f"+{numero[:2]} {numero[2:4]} {numero[4:9]}-{numero[9:]}"
    if len(numero) == 12:
        return f"+{numero[:2]} {numero[2:4]} {numero[4:8]}-{numero[8:]}"
    return f"+{numero[:2]} {numero[2:]}"


def _now_sp() -> datetime:
    return datetime.now(timezone.utc)


def _ensure_auth():
    if not EVOLUTION_KEY:
        raise HTTPException(500, "EVOLUTION_APIKEY/EVOLUTION_KEY não configurada no ambiente.")
    if not EVOLUTION_URL:
        raise HTTPException(500, "EVOLUTION_URL não configurada no ambiente.")


def _evo_post(path: str, instance: str, payload: Dict[str, Any], timeout: int = 30) -> Dict[str, Any]:
    _ensure_auth()
    url = f"{EVOLUTION_URL}{path}/{instance}"

    _dbg("EVOLUTION POST url=", url)
    _dbg_json("EVOLUTION payload=", payload)

    r = requests.post(url, headers=HEADERS, data=json.dumps(payload), timeout=timeout)

    _dbg("EVOLUTION status=", r.status_code)
    try:
        _dbg_json("EVOLUTION response=", r.json())
    except Exception:
        _dbg("EVOLUTION response(raw)=", (r.text or "")[:600])

    if r.status_code >= 400:
        try:
            j = r.json()
            raise HTTPException(
                r.status_code,
                {"error": "evolution_error", "status": r.status_code, "response": j},
            )
        except Exception:
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
    allowed_inst_ids: Optional[List[int]] = None,
) -> Tuple[models.Empresa, str, Optional[int]]:
    """
    Regras com ACL por instância:
      1) instance (nome)
      2) instancia_id
      3) empresa_id + numero_norm -> última instância (respeita ACL)
      4) empresa_id com 1 instância (ou 1 permitida)
      5) senão 400 com opções
    Retorna: (empresa, instance_name, instancia_id)
    """

    def _list_instancias(emp_id: int) -> List[models.EmpresaInstancia]:
        q = db.query(models.EmpresaInstancia).filter(models.EmpresaInstancia.empresa_id == int(emp_id))
        if allowed_inst_ids is not None:
            if not allowed_inst_ids:
                return []
            q = q.filter(models.EmpresaInstancia.id.in_([int(x) for x in allowed_inst_ids]))
        return q.order_by(models.EmpresaInstancia.id.asc()).all()

    if instance:
        q = db.query(models.EmpresaInstancia).filter(models.EmpresaInstancia.instance_name == instance)
        if empresa_id:
            q = q.filter(models.EmpresaInstancia.empresa_id == int(empresa_id))
        inst_row = q.first()
        if not inst_row:
            raise HTTPException(404, f"Instância '{instance}' não encontrada (ou não pertence à empresa).")

        _assert_instancia_allowed(allowed_inst_ids, int(inst_row.id))

        emp = db.query(models.Empresa).filter(models.Empresa.id == int(inst_row.empresa_id)).first()
        if not emp:
            raise HTTPException(404, "Empresa da instância não encontrada.")
        return emp, inst_row.instance_name, int(inst_row.id)

    if instancia_id is not None:
        q = db.query(models.EmpresaInstancia).filter(models.EmpresaInstancia.id == int(instancia_id))
        if empresa_id:
            q = q.filter(models.EmpresaInstancia.empresa_id == int(empresa_id))
        inst_row = q.first()
        if not inst_row:
            raise HTTPException(404, f"Instância id={instancia_id} não encontrada (ou não pertence à empresa).")

        _assert_instancia_allowed(allowed_inst_ids, int(inst_row.id))

        emp = db.query(models.Empresa).filter(models.Empresa.id == int(inst_row.empresa_id)).first()
        if not emp:
            raise HTTPException(404, "Empresa da instância não encontrada.")
        return emp, inst_row.instance_name, int(inst_row.id)

    if not empresa_id:
        raise HTTPException(400, "Informe 'instance' (nome) ou 'instancia_id'; ou 'empresa_id' + 'number'.")

    emp = db.query(models.Empresa).filter(models.Empresa.id == int(empresa_id)).first()
    if not emp:
        raise HTTPException(404, f"Empresa id={empresa_id} não encontrada.")

    if numero_norm:
        cli = db.query(models.Cliente).filter_by(empresa_id=int(empresa_id), telefone=numero_norm).first()
        if cli:
            mq = (
                db.query(models.Mensagem)
                .filter(
                    models.Mensagem.empresa_id == int(empresa_id),
                    models.Mensagem.cliente_id == int(cli.id),
                    models.Mensagem.instancia_id.isnot(None),
                )
            )
            if allowed_inst_ids is not None:
                if not allowed_inst_ids:
                    mq = None
                else:
                    mq = mq.filter(models.Mensagem.instancia_id.in_([int(x) for x in allowed_inst_ids]))

            if mq is not None:
                last = mq.order_by(models.Mensagem.timestamp.desc(), models.Mensagem.id.desc()).first()
                if last and last.instancia_id:
                    inst_row = (
                        db.query(models.EmpresaInstancia)
                        .filter(models.EmpresaInstancia.id == int(last.instancia_id))
                        .first()
                    )
                    if inst_row:
                        _assert_instancia_allowed(allowed_inst_ids, int(inst_row.id))
                        return emp, inst_row.instance_name, int(inst_row.id)

    insts = _list_instancias(int(empresa_id))
    if len(insts) == 1:
        return emp, insts[0].instance_name, int(insts[0].id)

    if insts:
        opts = [{"id": int(r.id), "instance_name": r.instance_name} for r in insts]
        raise HTTPException(
            400,
            {
                "error": "empresa_tem_varias_instancias",
                "message": "Informe 'instance' (nome) ou 'instancia_id' para escolher.",
                "opcoes": opts,
            },
        )

    if allowed_inst_ids is not None:
        raise HTTPException(403, "Nenhuma instância permitida para este usuário.")
    raise HTTPException(400, "Empresa sem instâncias cadastradas.")


# =========================================================
# Persistência: Cliente (1:1)
# =========================================================
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
    ack: int,
) -> models.Mensagem:
    m = models.Mensagem(
        empresa_id=empresa.id,
        cliente_id=cliente.id,
        conteudo=conteudo,
        tipo="saida",
        lida=True,
        ack=int(ack),
        timestamp=_now_sp(),
        msg_id=msg_id,
        instancia_id=instancia_id,
    )
    db.add(m)
    db.commit()
    db.refresh(m)
    return m


# =========================================================
# Persistência: Grupo (@g.us)
# (NÃO salva instance_name no banco)
# =========================================================
def _ts_seconds_from_evo(evo: Dict[str, Any]) -> int:
    ts = (evo or {}).get("messageTimestamp")
    try:
        ts = int(ts)
        if ts > 0:
            return ts
    except Exception:
        pass
    return int(time.time())


def _ack_from_send_success() -> int:
    # ✅ se o POST retornou 200, no mínimo saiu do seu backend e foi aceito pela Evolution.
    # Isso já tira o "relógio" no front.
    return 1


def _get_or_create_grupo(
    db: Session,
    *,
    empresa: models.Empresa,
    remote_jid: str,
    instancia_id: Optional[int],
) -> models.Grupo:
    grp = (
        db.query(models.Grupo)
        .filter(models.Grupo.empresa_id == int(empresa.id), models.Grupo.remote_jid == str(remote_jid))
        .first()
    )
    if grp:
        try:
            if instancia_id is not None:
                grp.instancia_id = int(instancia_id)
            db.commit()
        except Exception:
            db.rollback()
        return grp

    grp = models.Grupo(
        empresa_id=int(empresa.id),
        remote_jid=str(remote_jid),
        nome=str(remote_jid),
        avatar_url=None,
        descricao=None if hasattr(models.Grupo, "descricao") else None,
        instancia_id=int(instancia_id) if instancia_id is not None else None,
    )
    db.add(grp)
    db.commit()
    db.refresh(grp)
    return grp


def _insert_msg_saida_grupo(
    db: Session,
    *,
    empresa: models.Empresa,
    grupo: models.Grupo,
    conteudo: str,
    msg_id: Optional[str],
    instancia_id: Optional[int],
    ts_seconds: int,
    ack: int,
    message_type: str = "conversation",
) -> models.MensagemGrupo:
    m = models.MensagemGrupo(
        empresa_id=int(empresa.id),
        grupo_id=int(grupo.id),
        instancia_id=int(instancia_id) if instancia_id is not None else None,
        author_jid=None,
        from_me=True,
        conteudo=conteudo,
        tipo="saida",
        message_type=message_type,
        lida=True,
        timestamp=int(ts_seconds),
        msg_id=str(msg_id) if msg_id else f"local-{int(time.time() * 1000)}",
        ack=int(ack),
    )
    db.add(m)

    if instancia_id is not None:
        grupo.instancia_id = int(instancia_id)

    db.commit()
    db.refresh(m)
    return m


def _identity_ctx(identity: Any) -> Tuple[int, Optional[str]]:
    if identity is None:
        raise HTTPException(401, "Sessão inválida ou expirada.")

    if isinstance(identity, dict):

        def getter(k, default=None):
            return identity.get(k, default)

    else:

        def getter(k, default=None):
            return getattr(identity, k, default)

    empresa_id = getter("empresa_id", None)
    if not empresa_id:
        raise HTTPException(403, "Empresa inválida para este token")
    try:
        empresa_id = int(empresa_id)
    except Exception:
        raise HTTPException(403, "Empresa inválida para este token")

    atendente_nome = getter("nome", None) or getter("nome_completo", None) or getter("name", None)
    return empresa_id, atendente_nome


# =========================================================
# Broadcast WS
# (pode enviar instance_name pro front, mas NÃO salva no banco)
# =========================================================
async def _broadcast_msg_saida_cliente(
    *,
    empresa: models.Empresa,
    cliente: models.Cliente,
    conteudo: str,
    timestamp_iso: str,
    msg_id: str,
    instancia_id: Optional[int],
    instance_name: Optional[str],
    atendente_nome: Optional[str],
    ack: int,
    midias: Optional[List[Dict[str, Any]]] = None,
):
    payload = {
        "empresa_id": int(empresa.id),
        "cliente_id": int(cliente.id),
        "is_group": False,
        "telefone": formatar_telefone_br(cliente.telefone) if getattr(cliente, "telefone", None) else None,
        # ✅ BLINDADO: nunca mandar URL externa
        "avatar_url": _public_avatar_url(
            kind="cliente",
            conversation_id=int(cliente.id),
            raw_avatar_url=getattr(cliente, "avatar_url", None),
        ),
        "push_name": getattr(cliente, "nome_whatsapp", None),
        "nome": getattr(cliente, "nome", None),
        "mensagem": conteudo,
        "tipo": "saida",
        "origem": "atendente",
        "timestamp": timestamp_iso,
        "msg_id": msg_id,
        "ack": int(ack),
        "instancia_id": instancia_id,
        "instance_name": instance_name,  # apenas no WS
        "atendente_nome": atendente_nome,
    }
    if midias:
        payload["midias"] = midias

    _dbg("WS broadcast channel=", f"emp:{empresa.id}")
    _dbg_json("WS payload=", payload)

    await conexoes_ativas.send_message(f"emp:{empresa.id}", payload)


async def _broadcast_msg_saida_grupo(
    *,
    empresa: models.Empresa,
    grupo: models.Grupo,
    conteudo: str,
    timestamp_iso: str,
    msg_id: str,
    instancia_id: Optional[int],
    instance_name: Optional[str],
    atendente_nome: Optional[str],
    ack: int,
    midias: Optional[List[Dict[str, Any]]] = None,
):
    payload = {
        "empresa_id": int(empresa.id),
        "cliente_id": int(grupo.id),  # pro front: id da conversa aberta
        "is_group": True,
        "remote_jid": getattr(grupo, "remote_jid", None),
        # ✅ BLINDADO: nunca mandar URL externa
        "avatar_url": _public_avatar_url(
            kind="grupo",
            conversation_id=int(grupo.id),
            raw_avatar_url=getattr(grupo, "avatar_url", None),
        ),
        "nome": getattr(grupo, "nome", None),
        "mensagem": conteudo,
        "tipo": "saida",
        "origem": "atendente",
        "timestamp": timestamp_iso,
        "msg_id": msg_id,
        "ack": int(ack),
        "instancia_id": instancia_id,
        "instance_name": instance_name,  # apenas no WS
        "atendente_nome": atendente_nome,
    }
    if midias:
        payload["midias"] = midias

    _dbg("WS broadcast channel=", f"emp:{empresa.id}")
    _dbg_json("WS payload=", payload)

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
    cliente_id: Optional[int] = Field(None, description="ID da conversa no sistema (opcional; ajuda a forçar conversa)")
    number: str = Field(..., description="Destino: telefone OU JID (ex: ...@s.whatsapp.net / ...@g.us)")


class SendTextReq(BaseSend):
    text: str
    delay: Optional[int] = None
    linkPreview: Optional[bool] = None
    mentionsEveryOne: Optional[bool] = None
    mentioned: Optional[List[str]] = None
    quoted: Optional[Quoted] = None


class SendAudioReq(BaseSend):
    audio: str
    delay: Optional[int] = None
    linkPreview: Optional[bool] = None
    mentionsEveryOne: Optional[bool] = None
    mentioned: Optional[List[str]] = None
    quoted: Optional[Quoted] = None


class SendMediaReq(BaseSend):
    media: str
    mediatype: str
    mimetype: Optional[str] = None
    caption: Optional[str] = None
    fileName: Optional[str] = None
    delay: Optional[int] = None
    linkPreview: Optional[bool] = None
    mentionsEveryOne: Optional[bool] = None
    mentioned: Optional[List[str]] = None
    quoted: Optional[Quoted] = None


class SendStickerReq(BaseSend):
    sticker: str
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


# =========================================================
# Rotas
# =========================================================
@router.post("/send/text")
async def send_text(
    body: SendTextReq,
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
):
    _ensure_perm(identity, "atendimento.enviar")
    _dbg_json("SEND/TEXT body(recebido)=", body.model_dump(exclude_none=True))

    destino, numero_norm, is_group = _destino_e_numero_norm(body.number)
    _dbg("destino=", destino, "numero_norm=", numero_norm, "is_group=", is_group, "cliente_id=", body.cliente_id)
    if not destino:
        raise HTTPException(400, "Número/JID inválido.")

    empresa_do_token, atendente_nome = _identity_ctx(identity)
    allowed = _allowed_instancia_ids(db, identity, empresa_do_token)
    efetiva_empresa_id = _assert_mesma_empresa(empresa_do_token, body.empresa_id)

    empresa, inst_name, inst_id = _resolve_empresa_e_instancia(
        db,
        empresa_id=efetiva_empresa_id,
        instance=body.instance,
        instancia_id=body.instancia_id,
        numero_norm=numero_norm,
        allowed_inst_ids=allowed,
    )
    _assert_empresa_resolvida(empresa_do_token, empresa.id)

    payload = {
        "number": destino,
        "text": body.text,
        "delay": body.delay,
        "linkPreview": body.linkPreview,
        "mentionsEveryOne": body.mentionsEveryOne,
        "mentioned": body.mentioned,
        "quoted": body.quoted.model_dump(exclude_none=True) if body.quoted else None,
    }
    payload = {k: v for k, v in payload.items() if v is not None}

    evo = _evo_post("/message/sendText", inst_name, payload)
    evo_msg_id = ((evo or {}).get("key") or {}).get("id")

    ack_now = _ack_from_send_success()

    # ====== GRUPO ======
    if is_group:
        ts = _ts_seconds_from_evo(evo)
        ts_iso = datetime.fromtimestamp(ts, tz=timezone.utc).isoformat(timespec="microseconds")

        grp = None
        if body.cliente_id is not None:
            try:
                grp = (
                    db.query(models.Grupo)
                    .filter(models.Grupo.empresa_id == int(empresa.id), models.Grupo.id == int(body.cliente_id))
                    .first()
                )
                if grp and str(getattr(grp, "remote_jid", "")).lower() != str(destino).lower():
                    grp = None
            except Exception:
                grp = None

        if not grp:
            grp = _get_or_create_grupo(db, empresa=empresa, remote_jid=destino, instancia_id=inst_id)

        msg_g = _insert_msg_saida_grupo(
            db,
            empresa=empresa,
            grupo=grp,
            conteudo=body.text,
            msg_id=evo_msg_id,
            instancia_id=inst_id,
            ts_seconds=ts,
            ack=ack_now,
            message_type="conversation",
        )

        await _broadcast_msg_saida_grupo(
            empresa=empresa,
            grupo=grp,
            conteudo=body.text,
            timestamp_iso=ts_iso,
            msg_id=evo_msg_id or str(getattr(msg_g, "id", "")),
            instancia_id=inst_id,
            instance_name=inst_name,
            atendente_nome=atendente_nome,
            ack=ack_now,
        )

        return {
            "evolution": evo,
            "db": {
                "mensagem_grupo_id": getattr(msg_g, "id", None),
                "grupo_id": getattr(grp, "id", None),
                "instancia_id": inst_id,
            },
            "instance_name": inst_name,
        }

    # ====== 1:1 ======
    cliente = None
    if body.cliente_id is not None:
        cliente = (
            db.query(models.Cliente)
            .filter(models.Cliente.empresa_id == empresa.id, models.Cliente.id == int(body.cliente_id))
            .first()
        )

    if not cliente and numero_norm:
        cliente = _get_or_create_cliente(db, empresa, numero_norm)

    if not cliente:
        return {"evolution": evo, "db": None, "instance_name": inst_name}

    msg = _insert_msg_saida(
        db,
        empresa=empresa,
        cliente=cliente,
        conteudo=body.text,
        msg_id=evo_msg_id,
        instancia_id=inst_id,
        ack=ack_now,
    )

    await _broadcast_msg_saida_cliente(
        empresa=empresa,
        cliente=cliente,
        conteudo=msg.conteudo,
        timestamp_iso=msg.timestamp.isoformat(timespec="microseconds"),
        msg_id=msg.msg_id or str(msg.id),
        instancia_id=msg.instancia_id,
        instance_name=inst_name,
        atendente_nome=atendente_nome,
        ack=ack_now,
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
    identity=Depends(get_current_identity),
):
    _ensure_perm(identity, "atendimento.enviar")
    _dbg_json("SEND/AUDIO body(recebido)=", body.model_dump(exclude_none=True))

    destino, numero_norm, is_group = _destino_e_numero_norm(body.number)
    if not destino:
        raise HTTPException(400, "Número/JID inválido.")

    empresa_do_token, atendente_nome = _identity_ctx(identity)
    allowed = _allowed_instancia_ids(db, identity, empresa_do_token)
    efetiva_empresa_id = _assert_mesma_empresa(empresa_do_token, body.empresa_id)

    empresa, inst_name, inst_id = _resolve_empresa_e_instancia(
        db,
        empresa_id=efetiva_empresa_id,
        instance=body.instance,
        instancia_id=body.instancia_id,
        numero_norm=numero_norm,
        allowed_inst_ids=allowed,
    )
    _assert_empresa_resolvida(empresa_do_token, empresa.id)

    payload = {
        "number": destino,
        "audio": body.audio,
        "delay": body.delay,
        "linkPreview": body.linkPreview,
        "mentionsEveryOne": body.mentionsEveryOne,
        "mentioned": body.mentioned,
        "quoted": body.quoted.model_dump(exclude_none=True) if body.quoted else None,
    }
    payload = {k: v for k, v in payload.items() if v is not None}

    evo = _evo_post("/message/sendWhatsAppAudio", inst_name, payload)
    evo_msg_id = ((evo or {}).get("key") or {}).get("id")

    ack_now = _ack_from_send_success()

    audio_url = body.audio
    if audio_url and not audio_url.startswith("http") and not audio_url.startswith("data:"):
        audio_url = f"data:audio/ogg;base64,{body.audio}"
    midias = [{"tipo": "audio", "mimetype": "audio/ogg", "filename": "", "url": audio_url}]

    if is_group:
        ts = _ts_seconds_from_evo(evo)
        ts_iso = datetime.fromtimestamp(ts, tz=timezone.utc).isoformat(timespec="microseconds")

        grp = None
        if body.cliente_id is not None:
            try:
                grp = (
                    db.query(models.Grupo)
                    .filter(models.Grupo.empresa_id == int(empresa.id), models.Grupo.id == int(body.cliente_id))
                    .first()
                )
                if grp and str(getattr(grp, "remote_jid", "")).lower() != str(destino).lower():
                    grp = None
            except Exception:
                grp = None

        if not grp:
            grp = _get_or_create_grupo(db, empresa=empresa, remote_jid=destino, instancia_id=inst_id)

        msg_g = _insert_msg_saida_grupo(
            db,
            empresa=empresa,
            grupo=grp,
            conteudo="[Áudio]",
            msg_id=evo_msg_id,
            instancia_id=inst_id,
            ts_seconds=ts,
            ack=ack_now,
            message_type="audio",
        )

        await _broadcast_msg_saida_grupo(
            empresa=empresa,
            grupo=grp,
            conteudo="[Áudio]",
            timestamp_iso=ts_iso,
            msg_id=evo_msg_id or str(getattr(msg_g, "id", "")),
            instancia_id=inst_id,
            instance_name=inst_name,
            atendente_nome=atendente_nome,
            ack=ack_now,
            midias=midias,
        )
        return {
            "evolution": evo,
            "db": {
                "mensagem_grupo_id": getattr(msg_g, "id", None),
                "grupo_id": getattr(grp, "id", None),
                "instancia_id": inst_id,
            },
            "instance_name": inst_name,
        }

    cliente = None
    if body.cliente_id is not None:
        cliente = (
            db.query(models.Cliente)
            .filter(models.Cliente.empresa_id == empresa.id, models.Cliente.id == int(body.cliente_id))
            .first()
        )
    if not cliente and numero_norm:
        cliente = _get_or_create_cliente(db, empresa, numero_norm)
    if not cliente:
        return {"evolution": evo, "db": None, "instance_name": inst_name}

    msg = _insert_msg_saida(
        db,
        empresa=empresa,
        cliente=cliente,
        conteudo="[Áudio]",
        msg_id=evo_msg_id,
        instancia_id=inst_id,
        ack=ack_now,
    )

    await _broadcast_msg_saida_cliente(
        empresa=empresa,
        cliente=cliente,
        conteudo=msg.conteudo,
        timestamp_iso=msg.timestamp.isoformat(timespec="microseconds"),
        msg_id=msg.msg_id or str(msg.id),
        instancia_id=msg.instancia_id,
        instance_name=inst_name,
        atendente_nome=atendente_nome,
        ack=ack_now,
        midias=midias,
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
    identity=Depends(get_current_identity),
):
    _ensure_perm(identity, "atendimento.enviar")
    _dbg_json("SEND/MEDIA body(recebido)=", body.model_dump(exclude_none=True))

    destino, numero_norm, is_group = _destino_e_numero_norm(body.number)
    if not destino:
        raise HTTPException(400, "Número/JID inválido.")

    empresa_do_token, atendente_nome = _identity_ctx(identity)
    allowed = _allowed_instancia_ids(db, identity, empresa_do_token)
    efetiva_empresa_id = _assert_mesma_empresa(empresa_do_token, body.empresa_id)

    empresa, inst_name, inst_id = _resolve_empresa_e_instancia(
        db,
        empresa_id=efetiva_empresa_id,
        instance=body.instance,
        instancia_id=body.instancia_id,
        numero_norm=numero_norm,
        allowed_inst_ids=allowed,
    )
    _assert_empresa_resolvida(empresa_do_token, empresa.id)

    mimetype = body.mimetype
    if not mimetype and body.fileName:
        guess = mimetypes.guess_type(body.fileName)[0]
        if guess:
            mimetype = guess

    payload = {
        "number": destino,
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
    evo_msg_id = ((evo or {}).get("key") or {}).get("id")

    ack_now = _ack_from_send_success()

    conteudo = body.caption or "[Mídia]"

    media_url = body.media
    if media_url and not media_url.startswith("http") and not media_url.startswith("data:"):
        mime = mimetype or "application/octet-stream"
        media_url = f"data:{mime};base64,{body.media}"

    midias = [{"tipo": body.mediatype, "mimetype": mimetype or "", "filename": body.fileName or "", "url": media_url}]

    if is_group:
        ts = _ts_seconds_from_evo(evo)
        ts_iso = datetime.fromtimestamp(ts, tz=timezone.utc).isoformat(timespec="microseconds")

        grp = None
        if body.cliente_id is not None:
            try:
                grp = (
                    db.query(models.Grupo)
                    .filter(models.Grupo.empresa_id == int(empresa.id), models.Grupo.id == int(body.cliente_id))
                    .first()
                )
                if grp and str(getattr(grp, "remote_jid", "")).lower() != str(destino).lower():
                    grp = None
            except Exception:
                grp = None

        if not grp:
            grp = _get_or_create_grupo(db, empresa=empresa, remote_jid=destino, instancia_id=inst_id)

        msg_g = _insert_msg_saida_grupo(
            db,
            empresa=empresa,
            grupo=grp,
            conteudo=conteudo,
            msg_id=evo_msg_id,
            instancia_id=inst_id,
            ts_seconds=ts,
            ack=ack_now,
            message_type=str(body.mediatype or "media"),
        )

        await _broadcast_msg_saida_grupo(
            empresa=empresa,
            grupo=grp,
            conteudo=conteudo,
            timestamp_iso=ts_iso,
            msg_id=evo_msg_id or str(getattr(msg_g, "id", "")),
            instancia_id=inst_id,
            instance_name=inst_name,
            atendente_nome=atendente_nome,
            ack=ack_now,
            midias=midias,
        )
        return {
            "evolution": evo,
            "db": {
                "mensagem_grupo_id": getattr(msg_g, "id", None),
                "grupo_id": getattr(grp, "id", None),
                "instancia_id": inst_id,
            },
            "instance_name": inst_name,
        }

    cliente = None
    if body.cliente_id is not None:
        cliente = (
            db.query(models.Cliente)
            .filter(models.Cliente.empresa_id == empresa.id, models.Cliente.id == int(body.cliente_id))
            .first()
        )
    if not cliente and numero_norm:
        cliente = _get_or_create_cliente(db, empresa, numero_norm)
    if not cliente:
        return {"evolution": evo, "db": None, "instance_name": inst_name}

    msg = _insert_msg_saida(
        db,
        empresa=empresa,
        cliente=cliente,
        conteudo=conteudo,
        msg_id=evo_msg_id,
        instancia_id=inst_id,
        ack=ack_now,
    )

    await _broadcast_msg_saida_cliente(
        empresa=empresa,
        cliente=cliente,
        conteudo=msg.conteudo,
        timestamp_iso=msg.timestamp.isoformat(timespec="microseconds"),
        msg_id=msg.msg_id or str(msg.id),
        instancia_id=msg.instancia_id,
        instance_name=inst_name,
        atendente_nome=atendente_nome,
        ack=ack_now,
        midias=midias,
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
    identity=Depends(get_current_identity),
):
    _ensure_perm(identity, "atendimento.enviar")
    _dbg_json("SEND/STICKER body(recebido)=", body.model_dump(exclude_none=True))

    destino, numero_norm, is_group = _destino_e_numero_norm(body.number)
    if not destino:
        raise HTTPException(400, "Número/JID inválido.")

    empresa_do_token, atendente_nome = _identity_ctx(identity)
    allowed = _allowed_instancia_ids(db, identity, empresa_do_token)
    efetiva_empresa_id = _assert_mesma_empresa(empresa_do_token, body.empresa_id)

    empresa, inst_name, inst_id = _resolve_empresa_e_instancia(
        db,
        empresa_id=efetiva_empresa_id,
        instance=body.instance,
        instancia_id=body.instancia_id,
        numero_norm=numero_norm,
        allowed_inst_ids=allowed,
    )
    _assert_empresa_resolvida(empresa_do_token, empresa.id)

    payload = {
        "number": destino,
        "sticker": body.sticker,
        "delay": body.delay,
        "linkPreview": body.linkPreview,
        "mentionsEveryOne": body.mentionsEveryOne,
        "mentioned": body.mentioned,
        "quoted": body.quoted.model_dump(exclude_none=True) if body.quoted else None,
    }
    payload = {k: v for k, v in payload.items() if v is not None}

    evo = _evo_post("/message/sendSticker", inst_name, payload)
    evo_msg_id = ((evo or {}).get("key") or {}).get("id")

    ack_now = _ack_from_send_success()
    conteudo = "[Figurinha]"

    if is_group:
        ts = _ts_seconds_from_evo(evo)
        ts_iso = datetime.fromtimestamp(ts, tz=timezone.utc).isoformat(timespec="microseconds")

        grp = None
        if body.cliente_id is not None:
            try:
                grp = (
                    db.query(models.Grupo)
                    .filter(models.Grupo.empresa_id == int(empresa.id), models.Grupo.id == int(body.cliente_id))
                    .first()
                )
                if grp and str(getattr(grp, "remote_jid", "")).lower() != str(destino).lower():
                    grp = None
            except Exception:
                grp = None

        if not grp:
            grp = _get_or_create_grupo(db, empresa=empresa, remote_jid=destino, instancia_id=inst_id)

        msg_g = _insert_msg_saida_grupo(
            db,
            empresa=empresa,
            grupo=grp,
            conteudo=conteudo,
            msg_id=evo_msg_id,
            instancia_id=inst_id,
            ts_seconds=ts,
            ack=ack_now,
            message_type="sticker",
        )

        await _broadcast_msg_saida_grupo(
            empresa=empresa,
            grupo=grp,
            conteudo=conteudo,
            timestamp_iso=ts_iso,
            msg_id=evo_msg_id or str(getattr(msg_g, "id", "")),
            instancia_id=inst_id,
            instance_name=inst_name,
            atendente_nome=atendente_nome,
            ack=ack_now,
        )
        return {
            "evolution": evo,
            "db": {
                "mensagem_grupo_id": getattr(msg_g, "id", None),
                "grupo_id": getattr(grp, "id", None),
                "instancia_id": inst_id,
            },
            "instance_name": inst_name,
        }

    cliente = None
    if body.cliente_id is not None:
        cliente = (
            db.query(models.Cliente)
            .filter(models.Cliente.empresa_id == empresa.id, models.Cliente.id == int(body.cliente_id))
            .first()
        )
    if not cliente and numero_norm:
        cliente = _get_or_create_cliente(db, empresa, numero_norm)
    if not cliente:
        return {"evolution": evo, "db": None, "instance_name": inst_name}

    msg = _insert_msg_saida(
        db,
        empresa=empresa,
        cliente=cliente,
        conteudo=conteudo,
        msg_id=evo_msg_id,
        instancia_id=inst_id,
        ack=ack_now,
    )

    await _broadcast_msg_saida_cliente(
        empresa=empresa,
        cliente=cliente,
        conteudo=msg.conteudo,
        timestamp_iso=msg.timestamp.isoformat(timespec="microseconds"),
        msg_id=msg.msg_id or str(msg.id),
        instancia_id=msg.instancia_id,
        instance_name=inst_name,
        atendente_nome=atendente_nome,
        ack=ack_now,
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
    identity=Depends(get_current_identity),
):
    _ensure_perm(identity, "atendimento.enviar")
    _dbg_json("SEND/CONTACT body(recebido)=", body.model_dump(exclude_none=True))

    destino, numero_norm, is_group = _destino_e_numero_norm(body.number)
    if not destino:
        raise HTTPException(400, "Número/JID inválido.")

    empresa_do_token, atendente_nome = _identity_ctx(identity)
    allowed = _allowed_instancia_ids(db, identity, empresa_do_token)
    efetiva_empresa_id = _assert_mesma_empresa(empresa_do_token, body.empresa_id)

    empresa, inst_name, inst_id = _resolve_empresa_e_instancia(
        db,
        empresa_id=efetiva_empresa_id,
        instance=body.instance,
        instancia_id=body.instancia_id,
        numero_norm=numero_norm,
        allowed_inst_ids=allowed,
    )
    _assert_empresa_resolvida(empresa_do_token, empresa.id)

    payload = {"number": destino, "contact": [c.model_dump(exclude_none=True) for c in body.contact]}
    evo = _evo_post("/message/sendContact", inst_name, payload)
    evo_msg_id = ((evo or {}).get("key") or {}).get("id")

    ack_now = _ack_from_send_success()
    conteudo = "[Contato]"

    if is_group:
        ts = _ts_seconds_from_evo(evo)
        ts_iso = datetime.fromtimestamp(ts, tz=timezone.utc).isoformat(timespec="microseconds")

        grp = None
        if body.cliente_id is not None:
            try:
                grp = (
                    db.query(models.Grupo)
                    .filter(models.Grupo.empresa_id == int(empresa.id), models.Grupo.id == int(body.cliente_id))
                    .first()
                )
                if grp and str(getattr(grp, "remote_jid", "")).lower() != str(destino).lower():
                    grp = None
            except Exception:
                grp = None

        if not grp:
            grp = _get_or_create_grupo(db, empresa=empresa, remote_jid=destino, instancia_id=inst_id)

        msg_g = _insert_msg_saida_grupo(
            db,
            empresa=empresa,
            grupo=grp,
            conteudo=conteudo,
            msg_id=evo_msg_id,
            instancia_id=inst_id,
            ts_seconds=ts,
            ack=ack_now,
            message_type="contact",
        )

        await _broadcast_msg_saida_grupo(
            empresa=empresa,
            grupo=grp,
            conteudo=conteudo,
            timestamp_iso=ts_iso,
            msg_id=evo_msg_id or str(getattr(msg_g, "id", "")),
            instancia_id=inst_id,
            instance_name=inst_name,
            atendente_nome=atendente_nome,
            ack=ack_now,
        )
        return {
            "evolution": evo,
            "db": {
                "mensagem_grupo_id": getattr(msg_g, "id", None),
                "grupo_id": getattr(grp, "id", None),
                "instancia_id": inst_id,
            },
            "instance_name": inst_name,
        }

    cliente = None
    if body.cliente_id is not None:
        cliente = (
            db.query(models.Cliente)
            .filter(models.Cliente.empresa_id == empresa.id, models.Cliente.id == int(body.cliente_id))
            .first()
        )
    if not cliente and numero_norm:
        cliente = _get_or_create_cliente(db, empresa, numero_norm)
    if not cliente:
        return {"evolution": evo, "db": None, "instance_name": inst_name}

    msg = _insert_msg_saida(
        db,
        empresa=empresa,
        cliente=cliente,
        conteudo=conteudo,
        msg_id=evo_msg_id,
        instancia_id=inst_id,
        ack=ack_now,
    )

    await _broadcast_msg_saida_cliente(
        empresa=empresa,
        cliente=cliente,
        conteudo=msg.conteudo,
        timestamp_iso=msg.timestamp.isoformat(timespec="microseconds"),
        msg_id=msg.msg_id or str(msg.id),
        instancia_id=msg.instancia_id,
        instance_name=inst_name,
        atendente_nome=atendente_nome,
        ack=ack_now,
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
    identity=Depends(get_current_identity),
):
    _ensure_perm(identity, "atendimento.reagir")
    _dbg_json("SEND/REACTION body(recebido)=", body.model_dump(exclude_none=True))

    empresa_do_token, _ = _identity_ctx(identity)
    allowed = _allowed_instancia_ids(db, identity, empresa_do_token)
    efetiva_empresa_id = _assert_mesma_empresa(empresa_do_token, body.empresa_id)

    if not (body.instance or body.instancia_id):
        raise HTTPException(400, "Para reação, informe 'instance' (nome) ou 'instancia_id'.")

    empresa, inst_name, inst_id = _resolve_empresa_e_instancia(
        db,
        empresa_id=efetiva_empresa_id,
        instance=body.instance,
        instancia_id=body.instancia_id,
        numero_norm=None,
        allowed_inst_ids=allowed,
    )
    _assert_empresa_resolvida(empresa_do_token, empresa.id)

    payload = {"key": body.key.model_dump(exclude_none=True), "reaction": body.reaction}
    evo = _evo_post("/message/sendReaction", inst_name, payload)

    conversa_id: Optional[int] = None
    is_group: bool = False

    try:
        msg = (
            db.query(models.Mensagem)
            .filter(models.Mensagem.empresa_id == int(empresa.id), models.Mensagem.msg_id == body.key.id)
            .order_by(models.Mensagem.id.desc())
            .first()
        )
        if msg:
            if allowed is not None and msg.instancia_id not in set(int(x) for x in (allowed or [])):
                msg = None
            if msg:
                conversa_id = int(msg.cliente_id)
                is_group = False

        if conversa_id is None:
            mg = (
                db.query(models.MensagemGrupo)
                .filter(models.MensagemGrupo.empresa_id == int(empresa.id), models.MensagemGrupo.msg_id == body.key.id)
                .order_by(models.MensagemGrupo.id.desc())
                .first()
            )
            if mg:
                if allowed is not None and getattr(mg, "instancia_id", None) not in set(int(x) for x in (allowed or [])):
                    mg = None
                if mg:
                    conversa_id = int(getattr(mg, "grupo_id", None) or 0) or None
                    is_group = True

        if conversa_id is None and body.key.remoteJid:
            num = _remote_to_num(body.key.remoteJid)
            if num:
                cli = db.query(models.Cliente).filter_by(empresa_id=int(empresa.id), telefone=num).first()
                if cli:
                    conversa_id = int(cli.id)
                    is_group = False
    except Exception:
        pass

    if conversa_id:
        await conexoes_ativas.send_message(
            f"emp:{empresa.id}",
            {
                "type": "reaction",
                "cliente_id": int(conversa_id),
                "is_group": bool(is_group),
                "msg_id": body.key.id,
                "reaction": body.reaction,
                "remove": False,
                "timestamp": _now_sp().isoformat(timespec="microseconds"),
                "instancia_id": inst_id,
                "instance_name": inst_name,
            },
        )

    return {"evolution": evo, "cliente_id": conversa_id, "instancia_id": inst_id, "instance_name": inst_name, "is_group": is_group}


# ========= Rotas alternativas com instância explícita na URL =========
@router.post("/instance/{instance}/send/text")
async def send_text_by_instance(
    instance: str = Path(..., description="Nome da instância Evolution"),
    body: SendTextReq = Body(...),
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
):
    body.instance = instance
    body.instancia_id = None
    return await send_text(body=body, db=db, identity=identity)


@router.post("/instancia/{instancia_id}/send/text")
async def send_text_by_instancia_id(
    instancia_id: int = Path(..., description="ID da instância (empresas_instancias.id)"),
    body: SendTextReq = Body(...),
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
):
    body.instancia_id = instancia_id
    body.instance = None
    return await send_text(body=body, db=db, identity=identity)


@router.post("/instance/{instance}/send/audio")
async def send_audio_by_instance(
    instance: str = Path(..., description="Nome da instância Evolution"),
    body: SendAudioReq = Body(...),
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
):
    body.instance = instance
    body.instancia_id = None
    return await send_audio(body=body, db=db, identity=identity)


@router.post("/instancia/{instancia_id}/send/audio")
async def send_audio_by_instancia_id(
    instancia_id: int = Path(..., description="ID da instância (empresas_instancias.id)"),
    body: SendAudioReq = Body(...),
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
):
    body.instancia_id = instancia_id
    body.instance = None
    return await send_audio(body=body, db=db, identity=identity)


@router.post("/instance/{instance}/send/media")
async def send_media_by_instance(
    instance: str = Path(..., description="Nome da instância Evolution"),
    body: SendMediaReq = Body(...),
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
):
    body.instance = instance
    body.instancia_id = None
    return await send_media(body=body, db=db, identity=identity)


@router.post("/instancia/{instancia_id}/send/media")
async def send_media_by_instancia_id(
    instancia_id: int = Path(..., description="ID da instância (empresas_instancias.id)"),
    body: SendMediaReq = Body(...),
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
):
    body.instancia_id = instancia_id
    body.instance = None
    return await send_media(body=body, db=db, identity=identity)


@router.post("/instance/{instance}/send/sticker")
async def send_sticker_by_instance(
    instance: str = Path(..., description="Nome da instância Evolution"),
    body: SendStickerReq = Body(...),
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
):
    body.instance = instance
    body.instancia_id = None
    return await send_sticker(body=body, db=db, identity=identity)


@router.post("/instancia/{instancia_id}/send/sticker")
async def send_sticker_by_instancia_id(
    instancia_id: int = Path(..., description="ID da instância (empresas_instancias.id)"),
    body: SendStickerReq = Body(...),
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
):
    body.instancia_id = instancia_id
    body.instance = None
    return await send_sticker(body=body, db=db, identity=identity)


@router.post("/instance/{instance}/send/contact")
async def send_contact_by_instance(
    instance: str = Path(..., description="Nome da instância Evolution"),
    body: SendContactReq = Body(...),
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
):
    body.instance = instance
    body.instancia_id = None
    return await send_contact(body=body, db=db, identity=identity)


@router.post("/instancia/{instancia_id}/send/contact")
async def send_contact_by_instancia_id(
    instancia_id: int = Path(..., description="ID da instância (empresas_instancias.id)"),
    body: SendContactReq = Body(...),
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
):
    body.instancia_id = instancia_id
    body.instance = None
    return await send_contact(body=body, db=db, identity=identity)


@router.post("/instance/{instance}/send/reaction")
async def send_reaction_by_instance(
    instance: str = Path(..., description="Nome da instância Evolution"),
    body: SendReactionReq = Body(...),
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
):
    body.instance = instance
    body.instancia_id = None
    return await send_reaction(body=body, db=db, identity=identity)


@router.post("/instancia/{instancia_id}/send/reaction")
async def send_reaction_by_instancia_id(
    instancia_id: int = Path(..., description="ID da instância (empresas_instancias.id)"),
    body: SendReactionReq = Body(...),
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
):
    body.instancia_id = instancia_id
    body.instance = None
    return await send_reaction(body=body, db=db, identity=identity)