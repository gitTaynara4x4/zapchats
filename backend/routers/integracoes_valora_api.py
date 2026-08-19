from __future__ import annotations

import hashlib
import json
import os
import re
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from fastapi import APIRouter, Body, Depends, Header, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.orm import Session

from backend import models
from backend.database import get_db
from backend.routers.auth import get_current_identity
from backend.routers.atendimento_send import SendTextReq, send_text
from backend.utils.plans import is_billing_locked

router = APIRouter(prefix="/api/integracoes/valora", tags=["Integrações - Valora API"])

_PAIR_MINUTES = 10
_PROCESSING_STALE_MINUTES = 2


class ParearValoraIn(BaseModel):
    codigo: str = Field(min_length=6, max_length=20)
    valora_empresa_id: int = Field(gt=0)
    valora_empresa_nome: str = Field(min_length=2, max_length=180)


class EnviarTextoValoraIn(BaseModel):
    instancia_id: int = Field(gt=0)
    number: str = Field(min_length=8, max_length=40)
    text: str = Field(min_length=1, max_length=10000)
    idempotency_key: str = Field(min_length=8, max_length=180)
    valora_empresa_id: Optional[int] = None
    valora_cliente_id: Optional[int] = None
    valora_lancamento_id: Optional[int] = None
    valora_envio_id: Optional[int] = None


def _to_int(value: Any) -> Optional[int]:
    try:
        n = int(value)
    except Exception:
        return None
    return n if n > 0 else None


def _empresa_id(identity: dict[str, Any]) -> int:
    empresa_id = _to_int(identity.get("empresa_id"))
    if not empresa_id:
        raise HTTPException(status_code=401, detail="Empresa inválida na sessão.")
    return empresa_id


def _is_admin(identity: dict[str, Any]) -> bool:
    if bool(identity.get("is_admin") or identity.get("admin")):
        return True
    role = str(identity.get("role") or identity.get("cargo") or "").strip().lower()
    return role in {"admin", "administrador", "owner", "dono", "root"}


def _require_admin(identity: dict[str, Any]) -> int:
    if not _is_admin(identity):
        raise HTTPException(status_code=403, detail="Somente o administrador pode configurar a integração com o Valora.")
    return _empresa_id(identity)


def _pepper() -> str:
    return str(os.getenv("VALORA_INTEGRATION_PEPPER") or os.getenv("JWT_SECRET") or "dev-valora-integration").strip()


def _pair_hash(code: str) -> str:
    clean = re.sub(r"\D+", "", str(code or ""))
    return hashlib.sha256(f"{_pepper()}:{clean}".encode("utf-8")).hexdigest()


def _token_hash(token: str) -> str:
    return hashlib.sha256(str(token or "").encode("utf-8")).hexdigest()


def _bearer(authorization: Optional[str]) -> str:
    raw = str(authorization or "").strip()
    if not raw.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Token da integração Valora ausente.")
    token = raw.split(" ", 1)[1].strip()
    if not token:
        raise HTTPException(status_code=401, detail="Token da integração Valora inválido.")
    return token


def _integration_row(db: Session, authorization: Optional[str]):
    token = _bearer(authorization)
    row = db.execute(
        text(
            """
            SELECT iv.*, e.nome AS empresa_nome
            FROM integracoes_valora iv
            JOIN empresas e ON e.id=iv.empresa_id
            WHERE iv.token_hash=:token_hash AND iv.ativo=TRUE
            LIMIT 1
            """
        ),
        {"token_hash": _token_hash(token)},
    ).first()
    if not row:
        raise HTTPException(status_code=401, detail="Integração Valora inválida ou revogada.")
    db.execute(
        text("UPDATE integracoes_valora SET ultimo_uso_em=NOW(), atualizado_em=NOW() WHERE id=:id"),
        {"id": int(row._mapping["id"])},
    )
    db.commit()
    return row


def _iso(value: Any) -> Optional[str]:
    if not value:
        return None
    try:
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc).isoformat()
    except Exception:
        return str(value)


@router.get("/admin/status")
def admin_status(
    db: Session = Depends(get_db),
    identity: dict[str, Any] = Depends(get_current_identity),
):
    empresa_id = _require_admin(identity)
    row = db.execute(
        text(
            """
            SELECT iv.*, e.nome AS empresa_nome
            FROM empresas e
            LEFT JOIN integracoes_valora iv ON iv.empresa_id=e.id
            WHERE e.id=:empresa_id
            """
        ),
        {"empresa_id": empresa_id},
    ).first()
    data = dict(row._mapping) if row else {}
    paired = bool(data.get("ativo") and data.get("token_hash"))
    return {
        "ok": True,
        "empresa_id": empresa_id,
        "empresa_nome": data.get("empresa_nome"),
        "pareado": paired,
        "valora_empresa_id": data.get("valora_empresa_id"),
        "valora_empresa_nome": data.get("valora_empresa_nome"),
        "token_prefix": data.get("token_prefix") if paired else None,
        "pareado_em": _iso(data.get("pareado_em")),
        "ultimo_uso_em": _iso(data.get("ultimo_uso_em")),
        "codigo_expira_em": _iso(data.get("codigo_pareamento_expira_em")),
    }


@router.post("/admin/codigo-pareamento")
def gerar_codigo_pareamento(
    db: Session = Depends(get_db),
    identity: dict[str, Any] = Depends(get_current_identity),
):
    empresa_id = _require_admin(identity)
    codigo = f"{secrets.randbelow(100_000_000):08d}"
    expira = datetime.now(timezone.utc) + timedelta(minutes=_PAIR_MINUTES)
    db.execute(
        text(
            """
            INSERT INTO integracoes_valora (
                empresa_id, codigo_pareamento_hash, codigo_pareamento_expira_em,
                ativo, criado_em, atualizado_em
            ) VALUES (
                :empresa_id, :codigo_hash, :expira, FALSE, NOW(), NOW()
            )
            ON CONFLICT (empresa_id) DO UPDATE SET
                codigo_pareamento_hash=EXCLUDED.codigo_pareamento_hash,
                codigo_pareamento_expira_em=EXCLUDED.codigo_pareamento_expira_em,
                atualizado_em=NOW()
            """
        ),
        {"empresa_id": empresa_id, "codigo_hash": _pair_hash(codigo), "expira": expira},
    )
    db.commit()
    return {
        "ok": True,
        "codigo": codigo,
        "expira_em": expira.isoformat(),
        "expira_em_minutos": _PAIR_MINUTES,
        "instrucao": "Cole este código no Valora CRM. Ele expira em 10 minutos e só pode ser usado uma vez.",
    }


@router.delete("/admin/conexao")
def revogar_conexao(
    db: Session = Depends(get_db),
    identity: dict[str, Any] = Depends(get_current_identity),
):
    empresa_id = _require_admin(identity)
    db.execute(
        text(
            """
            UPDATE integracoes_valora
               SET ativo=FALSE, token_hash=NULL, token_prefix=NULL,
                   valora_empresa_id=NULL, valora_empresa_nome=NULL,
                   codigo_pareamento_hash=NULL, codigo_pareamento_expira_em=NULL,
                   atualizado_em=NOW()
             WHERE empresa_id=:empresa_id
            """
        ),
        {"empresa_id": empresa_id},
    )
    db.commit()
    return {"ok": True, "pareado": False}


@router.post("/parear", status_code=status.HTTP_201_CREATED)
def parear_valora(payload: ParearValoraIn, db: Session = Depends(get_db)):
    codigo = re.sub(r"\D+", "", payload.codigo or "")
    if len(codigo) != 8:
        raise HTTPException(status_code=422, detail="Código de conexão inválido. Use os 8 dígitos mostrados no ZapsChat.")

    row = db.execute(
        text(
            """
            SELECT iv.id, iv.empresa_id, e.nome AS empresa_nome
            FROM integracoes_valora iv
            JOIN empresas e ON e.id=iv.empresa_id
            WHERE iv.codigo_pareamento_hash=:codigo_hash
              AND iv.codigo_pareamento_expira_em IS NOT NULL
              AND iv.codigo_pareamento_expira_em > NOW()
            LIMIT 1
            """
        ),
        {"codigo_hash": _pair_hash(codigo)},
    ).first()
    if not row:
        raise HTTPException(status_code=401, detail="Código de conexão inválido ou expirado. Gere um novo código no ZapsChat.")

    token = "zcv_" + secrets.token_urlsafe(36)
    token_prefix = token[:12]
    db.execute(
        text(
            """
            UPDATE integracoes_valora
               SET token_hash=:token_hash, token_prefix=:token_prefix, ativo=TRUE,
                   valora_empresa_id=:valora_empresa_id,
                   valora_empresa_nome=:valora_empresa_nome,
                   pareado_em=NOW(), ultimo_uso_em=NULL,
                   codigo_pareamento_hash=NULL, codigo_pareamento_expira_em=NULL,
                   atualizado_em=NOW()
             WHERE id=:id
            """
        ),
        {
            "id": int(row._mapping["id"]),
            "token_hash": _token_hash(token),
            "token_prefix": token_prefix,
            "valora_empresa_id": int(payload.valora_empresa_id),
            "valora_empresa_nome": " ".join(payload.valora_empresa_nome.split())[:180],
        },
    )
    db.commit()

    return {
        "ok": True,
        "token": token,
        "zapschat_empresa_id": int(row._mapping["empresa_id"]),
        "zapschat_empresa_nome": row._mapping["empresa_nome"],
    }


@router.get("/status")
def status_integracao(
    authorization: Optional[str] = Header(default=None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    row = _integration_row(db, authorization)
    empresa_id = int(row._mapping["empresa_id"])
    total = db.query(models.EmpresaInstancia).filter(models.EmpresaInstancia.empresa_id == empresa_id).count()
    connected = (
        db.query(models.EmpresaInstancia)
        .filter(models.EmpresaInstancia.empresa_id == empresa_id, models.EmpresaInstancia.connected.is_(True))
        .count()
    )
    return {
        "ok": True,
        "zapschat_empresa_id": empresa_id,
        "zapschat_empresa_nome": row._mapping["empresa_nome"],
        "instancias_total": int(total),
        "instancias_conectadas": int(connected),
    }


@router.delete("/conexao")
def revogar_conexao_pela_integracao(
    authorization: Optional[str] = Header(default=None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    """Revoga o próprio token da integração.

    Usado pelo Valora ao clicar em Desconectar. Assim o segredo deixa de ser
    válido também no ZapsChat; não fica uma credencial órfã ativa no servidor.
    """
    row = _integration_row(db, authorization)
    integration_id = int(row._mapping["id"])
    db.execute(
        text(
            """
            UPDATE integracoes_valora
               SET ativo=FALSE, token_hash=NULL, token_prefix=NULL,
                   valora_empresa_id=NULL, valora_empresa_nome=NULL,
                   codigo_pareamento_hash=NULL, codigo_pareamento_expira_em=NULL,
                   atualizado_em=NOW()
             WHERE id=:id
            """
        ),
        {"id": integration_id},
    )
    db.commit()
    return {"ok": True, "pareado": False}


@router.get("/instancias")
def listar_instancias_integracao(
    authorization: Optional[str] = Header(default=None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    row = _integration_row(db, authorization)
    empresa_id = int(row._mapping["empresa_id"])
    instancias = (
        db.query(models.EmpresaInstancia)
        .filter(models.EmpresaInstancia.empresa_id == empresa_id)
        .order_by(models.EmpresaInstancia.apelido.asc().nullslast(), models.EmpresaInstancia.id.asc())
        .all()
    )
    return {
        "ok": True,
        "empresa_id": empresa_id,
        "empresa_nome": row._mapping["empresa_nome"],
        "instancias": [
            {
                "id": int(item.id),
                "apelido": item.apelido or item.instance_name,
                "instance_name": item.instance_name,
                "numero_instancia": item.numero_instancia,
                "connected": bool(item.connected),
                "last_seen": _iso(item.last_seen),
            }
            for item in instancias
        ],
    }


@router.post("/mensagens/texto")
async def enviar_texto_integracao(
    payload: EnviarTextoValoraIn = Body(...),
    authorization: Optional[str] = Header(default=None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    integration = _integration_row(db, authorization)
    empresa_id = int(integration._mapping["empresa_id"])

    empresa = db.query(models.Empresa).filter(models.Empresa.id == empresa_id).first()
    if not empresa:
        raise HTTPException(status_code=404, detail="Empresa da integração não encontrada no ZapsChat.")
    if is_billing_locked(empresa):
        raise HTTPException(
            status_code=402,
            detail="O ZapsChat desta empresa está com o acesso financeiro bloqueado. Regularize o plano antes de enviar novas mensagens.",
        )

    if payload.valora_empresa_id and integration._mapping.get("valora_empresa_id"):
        if int(payload.valora_empresa_id) != int(integration._mapping["valora_empresa_id"]):
            raise HTTPException(status_code=403, detail="A empresa do Valora não corresponde ao pareamento desta integração.")

    instancia = (
        db.query(models.EmpresaInstancia)
        .filter(
            models.EmpresaInstancia.id == int(payload.instancia_id),
            models.EmpresaInstancia.empresa_id == empresa_id,
        )
        .first()
    )
    if not instancia:
        raise HTTPException(status_code=403, detail="A instância selecionada não pertence à empresa integrada.")
    if not bool(instancia.connected):
        raise HTTPException(status_code=409, detail="A instância de cobrança está desconectada no ZapsChat.")

    idem = " ".join((payload.idempotency_key or "").split())[:180]
    # Serializa requisições com a mesma chave antes de consultar/inserir. Isso
    # cobre também dois workers recebendo o mesmo retry no mesmo milissegundo.
    db.execute(
        text("SELECT pg_advisory_xact_lock(hashtext(:lock_key))"),
        {"lock_key": f"valora:{empresa_id}:{idem}"},
    )
    existing = db.execute(
        text(
            """
            SELECT * FROM integracoes_valora_envios
            WHERE empresa_id=:empresa_id AND idempotency_key=:idem
            """
        ),
        {"empresa_id": empresa_id, "idem": idem},
    ).first()
    if existing:
        data = dict(existing._mapping)
        if data.get("status") == "enviado":
            stored = {}
            try:
                stored = json.loads(data.get("resposta_json") or "{}")
            except Exception:
                stored = {}
            return {
                "ok": True,
                "sent": True,
                "duplicate": True,
                "msg_id": data.get("zapschat_msg_id"),
                "message_id": data.get("zapschat_msg_id"),
                "instancia_id": data.get("instancia_id"),
                "stored_response": stored,
            }
        updated_at = data.get("atualizado_em")
        if data.get("status") == "processando" and updated_at:
            try:
                age = datetime.now(timezone.utc) - updated_at.astimezone(timezone.utc)
                if age < timedelta(minutes=_PROCESSING_STALE_MINUTES):
                    raise HTTPException(status_code=409, detail="Este envio já está sendo processado pelo ZapsChat.")
            except HTTPException:
                raise
            except Exception:
                pass
        db.execute(
            text(
                """
                UPDATE integracoes_valora_envios
                   SET status='processando', instancia_id=:instancia_id, telefone=:telefone,
                       valora_empresa_id=:valora_empresa_id, valora_cliente_id=:valora_cliente_id,
                       valora_lancamento_id=:valora_lancamento_id, valora_envio_id=:valora_envio_id,
                       erro=NULL, atualizado_em=NOW()
                 WHERE empresa_id=:empresa_id AND idempotency_key=:idem
                """
            ),
            {
                "empresa_id": empresa_id, "idem": idem, "instancia_id": int(instancia.id), "telefone": payload.number,
                "valora_empresa_id": payload.valora_empresa_id, "valora_cliente_id": payload.valora_cliente_id,
                "valora_lancamento_id": payload.valora_lancamento_id, "valora_envio_id": payload.valora_envio_id,
            },
        )
    else:
        db.execute(
            text(
                """
                INSERT INTO integracoes_valora_envios (
                    empresa_id, idempotency_key, instancia_id, telefone,
                    valora_empresa_id, valora_cliente_id, valora_lancamento_id, valora_envio_id,
                    status, criado_em, atualizado_em
                ) VALUES (
                    :empresa_id, :idem, :instancia_id, :telefone,
                    :valora_empresa_id, :valora_cliente_id, :valora_lancamento_id, :valora_envio_id,
                    'processando', NOW(), NOW()
                )
                """
            ),
            {
                "empresa_id": empresa_id, "idem": idem, "instancia_id": int(instancia.id), "telefone": payload.number,
                "valora_empresa_id": payload.valora_empresa_id, "valora_cliente_id": payload.valora_cliente_id,
                "valora_lancamento_id": payload.valora_lancamento_id, "valora_envio_id": payload.valora_envio_id,
            },
        )
    db.commit()

    identity = {
        "empresa_id": empresa_id,
        "is_admin": True,
        "admin": True,
        "role": "admin",
        "nome": "Valora Financeiro",
        "permissoes": ["atendimento.enviar"],
    }
    body = SendTextReq(
        empresa_id=empresa_id,
        instancia_id=int(instancia.id),
        number=payload.number,
        text=payload.text,
    )

    try:
        result = await send_text(body=body, db=db, identity=identity)
        msg_id = str(result.get("msg_id") or result.get("message_id") or "").strip() or None
        response_json = json.dumps(result, ensure_ascii=False, default=str)[:12000]
        db.execute(
            text(
                """
                UPDATE integracoes_valora_envios
                   SET status='enviado', zapschat_msg_id=:msg_id, resposta_json=:resposta,
                       erro=NULL, atualizado_em=NOW()
                 WHERE empresa_id=:empresa_id AND idempotency_key=:idem
                """
            ),
            {"empresa_id": empresa_id, "idem": idem, "msg_id": msg_id, "resposta": response_json},
        )
        db.commit()
        return {
            "ok": True,
            "sent": True,
            "msg_id": msg_id,
            "message_id": msg_id,
            "instancia_id": int(instancia.id),
            "instance_name": instancia.instance_name,
            "numero_instancia": instancia.numero_instancia,
            "conversation_key": result.get("conversation_key"),
            "status": result.get("status") or "sent",
        }
    except HTTPException as exc:
        db.rollback()
        detail = exc.detail if isinstance(exc.detail, str) else json.dumps(exc.detail, ensure_ascii=False, default=str)
        db.execute(
            text(
                """
                UPDATE integracoes_valora_envios
                   SET status='erro', erro=:erro, atualizado_em=NOW()
                 WHERE empresa_id=:empresa_id AND idempotency_key=:idem
                """
            ),
            {"empresa_id": empresa_id, "idem": idem, "erro": str(detail)[:4000]},
        )
        db.commit()
        raise
    except Exception as exc:
        db.rollback()
        db.execute(
            text(
                """
                UPDATE integracoes_valora_envios
                   SET status='erro', erro=:erro, atualizado_em=NOW()
                 WHERE empresa_id=:empresa_id AND idempotency_key=:idem
                """
            ),
            {"empresa_id": empresa_id, "idem": idem, "erro": str(exc)[:4000]},
        )
        db.commit()
        raise HTTPException(status_code=502, detail=f"Falha ao enviar pelo WhatsApp: {str(exc)[:500]}") from exc
