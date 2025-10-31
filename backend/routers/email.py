# backend/routers/email.py
from __future__ import annotations

from typing import Optional, List
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, Body, Response
from pydantic import BaseModel, EmailStr, ConfigDict
from sqlalchemy import select, func, and_, or_
from sqlalchemy.orm import Session, joinedload
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
    storage_override_bytes: Optional[int] = None
    status: str = "active"  # 'active' conta na cota

class EmailAccountUpdate(BaseModel):
    provider: Optional[str] = None
    status: Optional[str] = None  # 'active' | 'disabled' | 'deleted'
    access_token: Optional[str] = None
    token_expiry: Optional[datetime] = None
    storage_override_bytes: Optional[int] = None
    colaborador_id: Optional[int] = None

class EmailAccountOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    provider: str
    email_address: str
    status: str
    created_at: datetime
    colaborador_id: Optional[int] = None
    storage_override_bytes: Optional[int] = None

class EmailQuotaOut(BaseModel):
    allowed_accounts: int
    used_accounts: int
    remaining_accounts: int
    company_storage_limit: Optional[int] = None
    account_storage_overrides: int

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

class EmailAttachmentOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    message_id: int
    filename: Optional[str] = None
    mimetype: Optional[str] = None
    size_bytes: int
    storage_url: Optional[str] = None
    # não trazemos data (bytea) no list

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
    # Cotas (trigger): 23514 (check_violation) ou P0001 (raise_exception)
    if "Limite de contas de e-mail atingido" in msg or "23514" in msg or "P0001" in msg:
        return HTTPException(status_code=400, detail="Limite de contas de e-mail atingido para a sua empresa.")
    if "uq_email_account_emp_provider_email" in msg or "email_accounts" in msg and "already exists" in msg:
        return HTTPException(status_code=409, detail="Já existe uma conta com este e-mail/provedor na empresa.")
    return HTTPException(status_code=400, detail="Não foi possível salvar. Erro de integridade.")

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
# QUOTA
# =========================
@router.get("/quota", response_model=EmailQuotaOut)
def get_quota(
    db: Session = Depends(get_db),
    user = Depends(get_current_user),
):
    emp = _empresa_or_404(db, user)

    allowed = _compute_allowed_accounts(emp)
    used = db.scalar(
        select(func.count(models.EmailAccount.id))
        .where(and_(models.EmailAccount.empresa_id == emp.id,
                    models.EmailAccount.status == "active"))
    ) or 0

    overrides = db.scalar(
        select(func.count(models.EmailAccount.id))
        .where(and_(models.EmailAccount.empresa_id == emp.id,
                    models.EmailAccount.storage_override_bytes.isnot(None)))
    ) or 0

    remaining = max(0, allowed - used)
    return EmailQuotaOut(
        allowed_accounts=allowed,
        used_accounts=used,
        remaining_accounts=remaining,
        company_storage_limit=emp.email_storage_override_bytes,
        account_storage_overrides=overrides,
    )

# =========================
# ACCOUNTS
# =========================
@router.get("/accounts", response_model=List[EmailAccountOut])
def list_accounts(
    db: Session = Depends(get_db),
    user = Depends(get_current_user),
    status: Optional[str] = Query(None, description="Filtrar por status (ex.: active)"),
):
    emp = _empresa_or_404(db, user)
    q = select(models.EmailAccount).where(models.EmailAccount.empresa_id == emp.id)
    if status:
        q = q.where(models.EmailAccount.status == status)
    q = q.order_by(models.EmailAccount.created_at.desc())
    return [EmailAccountOut.model_validate(acc) for acc in db.scalars(q).all()]

@router.post("/accounts", response_model=EmailAccountOut, status_code=201)
def create_account(
    payload: EmailAccountCreate,
    db: Session = Depends(get_db),
    user = Depends(get_current_user),
):
    emp = _empresa_or_404(db, user)

    # Checagem pró-ativa de cota (DB ainda é a autoridade via trigger)
    if payload.status == "active":
        allowed = _compute_allowed_accounts(emp)
        used = db.scalar(
            select(func.count(models.EmailAccount.id))
            .where(and_(models.EmailAccount.empresa_id == emp.id,
                        models.EmailAccount.status == "active"))
        ) or 0
        if used >= allowed:
            raise HTTPException(status_code=400, detail="Sua cota de contas de e-mail já está completa.")

    acc = models.EmailAccount(
        empresa_id=emp.id,
        provider=payload.provider,
        email_address=str(payload.email_address),
        refresh_token_enc=payload.refresh_token_enc,
        access_token=payload.access_token,
        token_expiry=payload.token_expiry,
        status=payload.status or "active",
        storage_override_bytes=payload.storage_override_bytes,
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
    user = Depends(get_current_user),
):
    emp = _empresa_or_404(db, user)
    acc = db.get(models.EmailAccount, account_id)
    if not acc or acc.empresa_id != emp.id:
        raise HTTPException(status_code=404, detail="Conta não encontrada")

    # Se for reativar, faz precheck de cota
    if payload.status == "active":
        allowed = _compute_allowed_accounts(emp)
        used = db.scalar(
            select(func.count(models.EmailAccount.id))
            .where(and_(models.EmailAccount.empresa_id == emp.id,
                        models.EmailAccount.status == "active",
                        models.EmailAccount.id != acc.id))
        ) or 0
        if used >= allowed:
            raise HTTPException(status_code=400, detail="Sua cota de contas de e-mail já está completa.")

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
    user = Depends(get_current_user),
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
@router.get("/messages", response_model=List[EmailMessageOut])
def list_messages(
    db: Session = Depends(get_db),
    user = Depends(get_current_user),
    account_id: Optional[int] = Query(None),
    q: Optional[str] = Query(None, description="Busca em subject/snippet/from"),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
):
    emp = _empresa_or_404(db, user)

    query = select(models.EmailMessage)\
        .where(models.EmailMessage.empresa_id == emp.id)

    if account_id:
        # valida a conta
        acc = db.get(models.EmailAccount, account_id)
        if not acc or acc.empresa_id != emp.id:
            raise HTTPException(status_code=404, detail="Conta não encontrada")
        query = query.where(models.EmailMessage.account_id == account_id)

    if q:
        like = f"%{q}%"
        query = query.where(
            or_(
                models.EmailMessage.subject.ilike(like),
                models.EmailMessage.snippet.ilike(like),
                models.EmailMessage.from_addr.ilike(like),
            )
        )

    query = query.order_by(models.EmailMessage.received_at.desc())\
                 .limit(limit).offset(offset)

    items = db.scalars(query).all()
    return [EmailMessageOut.model_validate(m) for m in items]

@router.get("/messages/{message_id}", response_model=EmailMessageOut)
def get_message(
    message_id: int,
    db: Session = Depends(get_db),
    user = Depends(get_current_user),
):
    emp = _empresa_or_404(db, user)
    m = db.get(models.EmailMessage, message_id)
    if not m or m.empresa_id != emp.id:
        raise HTTPException(status_code=404, detail="Mensagem não encontrada")
    return EmailMessageOut.model_validate(m)

@router.get("/messages/{message_id}/attachments", response_model=List[EmailAttachmentOut])
def list_message_attachments(
    message_id: int,
    db: Session = Depends(get_db),
    user = Depends(get_current_user),
):
    emp = _empresa_or_404(db, user)
    m = db.get(models.EmailMessage, message_id)
    if not m or m.empresa_id != emp.id:
        raise HTTPException(status_code=404, detail="Mensagem não encontrada")

    q = select(models.EmailAttachment).where(
        models.EmailAttachment.message_id == m.id,
        models.EmailAttachment.empresa_id == emp.id
    ).order_by(models.EmailAttachment.id.asc())

    return [EmailAttachmentOut.model_validate(a) for a in db.scalars(q).all()]

# (opcional) download binário — só se você estiver gravando em bytea.
# Caso use storage_url para S3/Local, sirva via nginx/static e só retorne o link.
from fastapi.responses import StreamingResponse, PlainTextResponse

@router.get("/attachments/{attachment_id}/download")
def download_attachment(
    attachment_id: int,
    db: Session = Depends(get_db),
    user = Depends(get_current_user),
):
    emp = _empresa_or_404(db, user)
    att = db.get(models.EmailAttachment, attachment_id)
    if not att or att.empresa_id != emp.id:
        raise HTTPException(status_code=404, detail="Anexo não encontrado")

    if att.data:
        mime = att.mimetype or "application/octet-stream"
        filename = att.filename or "anexo.bin"
        return StreamingResponse(
            iter([att.data]),
            media_type=mime,
            headers={"Content-Disposition": f'attachment; filename="{filename}"'}
        )

    if att.storage_url:
        # Retorne o link bruto ou faça proxy; aqui devolvemos a URL (texto)
        return PlainTextResponse(att.storage_url)

    raise HTTPException(status_code=404, detail="Anexo sem dados disponíveis")
