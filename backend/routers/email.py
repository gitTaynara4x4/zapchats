# backend/routers/email.py
from __future__ import annotations

from typing import Optional, List
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, Body, Response
from fastapi.responses import StreamingResponse, PlainTextResponse, JSONResponse
from pydantic import BaseModel, EmailStr, ConfigDict
from sqlalchemy import select, func, and_, or_
from sqlalchemy.orm import Session
from sqlalchemy.exc import IntegrityError

from backend.database import get_db
from backend import models
from backend.routers.auth import get_current_user  # precisa existir no seu projeto

router = APIRouter(prefix="/api/email", tags=["Email"])

# =========================
# Schemas (Pydantic v2)
# =========================
class EmailAccountCreate(BaseModel):
    provider: str = "gmail"
    email_address: EmailStr
    refresh_token_enc: str
    access_token: Optional[str] = None
    token_expiry: Optional[datetime] = None
    status: str = "active"  # 'active' conta na cota
    colaborador_id: Optional[int] = None


class EmailAccountUpdate(BaseModel):
    provider: Optional[str] = None
    status: Optional[str] = None  # 'active' | 'disabled' | 'deleted'
    access_token: Optional[str] = None
    token_expiry: Optional[datetime] = None
    colaborador_id: Optional[int] = None


class EmailAccountOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    provider: str
    email_address: str
    status: str
    created_at: datetime
    colaborador_id: Optional[int] = None


class EmailAccountListOut(BaseModel):
    items: List[EmailAccountOut]


class EmailQuotaOut(BaseModel):
    allowed_accounts: int
    used_accounts: int
    remaining_accounts: int


class EmailMessageOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    account_id: int
    subject: Optional[str] = None
    snippet: Optional[str] = None
    from_addr: Optional[str] = None
    to_addrs: Optional[str] = None
    cc_addrs: Optional[str] = None
    bcc_addrs: Optional[str] = None
    received_at: datetime
    size_bytes: int
    has_attachments: bool


class EmailMessageDetailOut(EmailMessageOut):
    # usado pelo modal de leitura (email.js → openMessage)
    body_text: Optional[str] = None
    body_html: Optional[str] = None


class EmailMessageListOut(BaseModel):
    items: List[EmailMessageOut]
    total_count: int


class EmailAttachmentOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    message_id: int
    filename: Optional[str] = None
    mimetype: Optional[str] = None
    size_bytes: int
    storage_url: Optional[str] = None
    # não trazemos data (bytea) no list


class EmailSendIn(BaseModel):
    account_id: int
    to: List[str]
    cc: Optional[List[str]] = None
    bcc: Optional[List[str]] = None
    subject: Optional[str] = None
    body_text: Optional[str] = None


# =========================
# Helpers
# =========================
def _empresa_or_404(db: Session, user) -> models.Empresa:
    emp = db.get(models.Empresa, user.empresa_id)
    if not emp:
        raise HTTPException(status_code=404, detail="Empresa não encontrada")
    return emp


def _friendly_integrity_error(e: IntegrityError) -> HTTPException:
    msg = str(e.orig) if getattr(e, "orig", None) else str(e)
    if "Limite de contas de e-mail atingido" in msg or "23514" in msg or "P0001" in msg:
        return HTTPException(
            status_code=400,
            detail="Limite de contas de e-mail atingido para a sua empresa.",
        )
    if "uq_email_account_emp_provider_email" in msg or (
        "email_accounts" in msg and "already exists" in msg
    ):
        return HTTPException(
            status_code=409,
            detail="Já existe uma conta com este e-mail/provedor na empresa.",
        )
    return HTTPException(
        status_code=400,
        detail="Não foi possível salvar. Erro de integridade.",
    )


def _compute_allowed_accounts(emp: models.Empresa) -> int:
    # Usa a propriedade já definida no model (pago > trial > 0, com override numérico se presente)
    return int(emp.email_quota_effective or 0)


# =========================
# Health
# =========================
@router.get("/health")
def health():
    return {"ok": True, "module": "email"}


# =========================
# LIMITS (para o front habilitar/desabilitar botões)
# =========================
@router.get("/limits")
def email_limits(
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    emp = _empresa_or_404(db, user)

    allowed = _compute_allowed_accounts(emp)
    used = (
        db.scalar(
            select(func.count(models.EmailAccount.id))
            .where(models.EmailAccount.empresa_id == emp.id)
            .where(models.EmailAccount.status == "active")
        )
        or 0
    )

    remaining = max(allowed - used, 0)
    can_compose = used > 0

    return {
        "allowed": allowed,
        "used": used,
        "remaining": remaining,
        "can_connect": remaining > 0,
        "can_compose": can_compose,
        "tier_effective": emp.effective_tier,
        "email_plan_paid_active": emp.email_paid_active,
        "email_trial_active": emp.email_trial_active,
    }


# =========================
# QUOTA (forma resumida)
# =========================
@router.get("/quota", response_model=EmailQuotaOut)
def get_quota(
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    emp = _empresa_or_404(db, user)

    allowed = _compute_allowed_accounts(emp)
    used = (
        db.scalar(
            select(func.count(models.EmailAccount.id)).where(
                and_(
                    models.EmailAccount.empresa_id == emp.id,
                    models.EmailAccount.status == "active",
                )
            )
        )
        or 0
    )
    remaining = max(0, allowed - used)

    return EmailQuotaOut(
        allowed_accounts=allowed,
        used_accounts=used,
        remaining_accounts=remaining,
    )


# =========================
# ACCOUNTS
# =========================
@router.get("/accounts", response_model=EmailAccountListOut)
def list_accounts(
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
    status: Optional[str] = Query(None, description="Filtrar por status (ex.: active)"),
):
    """
    Casa com: email.js → const resp = await jfetch('/api/email/accounts');
                accounts = resp?.items || [];
    """
    emp = _empresa_or_404(db, user)
    q = select(models.EmailAccount).where(models.EmailAccount.empresa_id == emp.id)
    if status:
        q = q.where(models.EmailAccount.status == status)
    q = q.order_by(models.EmailAccount.created_at.desc())
    items = [EmailAccountOut.model_validate(acc) for acc in db.scalars(q).all()]
    return EmailAccountListOut(items=items)


@router.post("/accounts", response_model=EmailAccountOut, status_code=201)
def create_account(
    payload: EmailAccountCreate,
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    emp = _empresa_or_404(db, user)

    # Checagem pró-ativa de cota (DB ainda é a autoridade se houver trigger)
    if (payload.status or "active") == "active":
        allowed = _compute_allowed_accounts(emp)
        used = (
            db.scalar(
                select(func.count(models.EmailAccount.id)).where(
                    and_(
                        models.EmailAccount.empresa_id == emp.id,
                        models.EmailAccount.status == "active",
                    )
                )
            )
            or 0
        )
        if used >= allowed:
            raise HTTPException(
                status_code=400,
                detail="Sua cota de contas de e-mail já está completa.",
            )

    acc = models.EmailAccount(
        empresa_id=emp.id,
        provider=payload.provider,
        email_address=str(payload.email_address),
        refresh_token_enc=payload.refresh_token_enc,
        access_token=payload.access_token,
        token_expiry=payload.token_expiry,
        status=payload.status or "active",
        colaborador_id=payload.colaborador_id,
    )
    db.add(acc)
    try:
        db.commit()
    except IntegrityError as e:
        db.rollback()
        raise _friendly_integrity_error(e)
    db.refresh(acc)
    return EmailAccountOut.model_validate(acc)


@router.patch("/accounts/{account_id}", response_model=EmailAccountOut)
def update_account(
    account_id: int,
    payload: EmailAccountUpdate,
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    emp = _empresa_or_404(db, user)
    acc = db.get(models.EmailAccount, account_id)
    if not acc or acc.empresa_id != emp.id:
        raise HTTPException(status_code=404, detail="Conta não encontrada")

    # Se for reativar, faz precheck de cota
    if payload.status == "active":
        allowed = _compute_allowed_accounts(emp)
        used = (
            db.scalar(
                select(func.count(models.EmailAccount.id)).where(
                    and_(
                        models.EmailAccount.empresa_id == emp.id,
                        models.EmailAccount.status == "active",
                        models.EmailAccount.id != acc.id,
                    )
                )
            )
            or 0
        )
        if used >= allowed:
            raise HTTPException(
                status_code=400,
                detail="Sua cota de contas de e-mail já está completa.",
            )

    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(acc, field, value)

    try:
        db.commit()
    except IntegrityError as e:
        db.rollback()
        raise _friendly_integrity_error(e)
    db.refresh(acc)
    return EmailAccountOut.model_validate(acc)


@router.delete("/accounts/{account_id}", status_code=204)
def delete_account(
    account_id: int,
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    emp = _empresa_or_404(db, user)
    acc = db.get(models.EmailAccount, account_id)
    if not acc or acc.empresa_id != emp.id:
        raise HTTPException(status_code=404, detail="Conta não encontrada")

    db.delete(acc)
    try:
        db.commit()
    except IntegrityError as e:
        db.rollback()
        raise _friendly_integrity_error(e)
    return Response(status_code=204)


# =========================
# MENSAGENS
# =========================
@router.get("/messages", response_model=EmailMessageListOut)
def list_messages(
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
    account_id: Optional[int] = Query(None),
    q: Optional[str] = Query(None, description="Busca em subject/snippet/from"),
    status: Optional[str] = Query(
        None, description="Status: unread | read | has_attachments"
    ),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
):
    """
    Casa com: email.js → const resp = await jfetch(`/api/email/messages?...`);
                const { items=[], total_count=0 } = resp || {};
    """
    emp = _empresa_or_404(db, user)

    conds = [models.EmailMessage.empresa_id == emp.id]

    if account_id:
        acc = db.get(models.EmailAccount, account_id)
        if not acc or acc.empresa_id != emp.id:
            raise HTTPException(status_code=404, detail="Conta não encontrada")
        conds.append(models.EmailMessage.account_id == account_id)

    if q:
        like = f"%{q}%"
        conds.append(
            or_(
                models.EmailMessage.subject.ilike(like),
                models.EmailMessage.snippet.ilike(like),
                models.EmailMessage.from_addr.ilike(like),
            )
        )

    # Filtro básico por status (has_attachments).
    # unread/read só vão funcionar se existir coluna correspondente no model.
    if status == "has_attachments":
        conds.append(models.EmailMessage.has_attachments.is_(True))
    # Exemplo se você tiver coluna is_read:
    # elif status == "unread" and hasattr(models.EmailMessage, "is_read"):
    #     conds.append(models.EmailMessage.is_read.is_(False))
    # elif status == "read" and hasattr(models.EmailMessage, "is_read"):
    #     conds.append(models.EmailMessage.is_read.is_(True))

    # total_count (antes de limit/offset)
    total_count = (
        db.scalar(
            select(func.count(models.EmailMessage.id)).where(*conds)
        ) or 0
    )

    query = (
        select(models.EmailMessage)
        .where(*conds)
        .order_by(models.EmailMessage.received_at.desc())
        .limit(limit)
        .offset(offset)
    )

    items_db = db.scalars(query).all()
    items = [EmailMessageOut.model_validate(m) for m in items_db]

    return EmailMessageListOut(items=items, total_count=total_count)


@router.get("/messages/{message_id}", response_model=EmailMessageDetailOut)
def get_message(
    message_id: int,
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    """
    Usado pelo modal de leitura no email.js (precisa de body_html/body_text).
    """
    emp = _empresa_or_404(db, user)
    m = db.get(models.EmailMessage, message_id)
    if not m or m.empresa_id != emp.id:
        raise HTTPException(status_code=404, detail="Mensagem não encontrada")
    return EmailMessageDetailOut.model_validate(m)


@router.get(
    "/messages/{message_id}/attachments", response_model=List[EmailAttachmentOut]
)
def list_message_attachments(
    message_id: int,
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    emp = _empresa_or_404(db, user)
    m = db.get(models.EmailMessage, message_id)
    if not m or m.empresa_id != emp.id:
        raise HTTPException(status_code=404, detail="Mensagem não encontrada")

    q = (
        select(models.EmailAttachment)
        .where(
            models.EmailAttachment.message_id == m.id,
            models.EmailAttachment.empresa_id == emp.id,
        )
        .order_by(models.EmailAttachment.id.asc())
    )

    return [EmailAttachmentOut.model_validate(a) for a in db.scalars(q).all()]


@router.get("/attachments/{attachment_id}/download")
def download_attachment(
    attachment_id: int,
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    emp = _empresa_or_404(db, user)
    att = db.get(models.EmailAttachment, attachment_id)
    if not att or att.empresa_id != emp.id:
        raise HTTPException(status_code=404, detail="Anexo não encontrado")

    if getattr(att, "data", None):
        mime = att.mimetype or "application/octet-stream"
        filename = att.filename or "anexo.bin"
        return StreamingResponse(
            iter([att.data]),
            media_type=mime,
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )

    if att.storage_url:
        return PlainTextResponse(att.storage_url)

    raise HTTPException(status_code=404, detail="Anexo sem dados disponíveis")


# =========================
# COMPOSE / SEND (mínimo viável)
# =========================
@router.post("/send")
def send_email(
    payload: EmailSendIn,
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    """
    MVP de envio: valida conta, persiste uma mensagem de saída na tabela.
    Integração real com Gmail/SMTP pode ser plugada aqui (fila/worker).
    """
    emp = _empresa_or_404(db, user)

    acc = db.get(models.EmailAccount, payload.account_id)
    if not acc or acc.empresa_id != emp.id:
        raise HTTPException(status_code=404, detail="Conta não encontrada")

    if not payload.to:
        raise HTTPException(
            status_code=400, detail="Informe pelo menos um destinatário."
        )

    body = (payload.body_text or "").strip()
    snippet = (
        body[:180] + ("…" if len(body) > 180 else "")
        if body
        else None
    )

    # Persistimos como "mensagem" para o histórico (tipo OUTBOX conceitual)
    msg = models.EmailMessage(
        empresa_id=emp.id,
        account_id=acc.id,
        external_id=None,  # preencher quando enviar de fato via provedor
        subject=(payload.subject or "").strip() or None,
        snippet=snippet,
        from_addr=acc.email_address,
        to_addrs="; ".join([s.strip() for s in payload.to if s.strip()]) or None,
        cc_addrs="; ".join([s.strip() for s in (payload.cc or []) if s.strip()]) or None,
        bcc_addrs="; ".join([s.strip() for s in (payload.bcc or []) if s.strip()]) or None,
        received_at=datetime.now(timezone.utc),  # para ordenação imediata
        size_bytes=len(body.encode("utf-8")) if body else 0,
        has_attachments=False,
        body_text=body or None,
        body_html=None,
    )
    db.add(msg)
    db.commit()

    # Aqui você poderia enfileirar para um worker fazer o envio real.
    return {"ok": True, "queued": True, "message_id": msg.id}


# =========================
# OAuth (placeholder)
# =========================
@router.get("/oauth/google/start")
def oauth_google_start():
    """
    Endpoint placeholder para iniciar OAuth com Google.
    Substitua por um RedirectResponse para a URL real do consent screen.
    """
    return JSONResponse(
        {"ok": True, "message": "OAuth Google não configurado ainda."},
        status_code=501,
    )
