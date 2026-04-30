from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
from datetime import date, datetime, timedelta, timezone
from typing import Any, Dict, Optional, Tuple

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.orm import Session

from backend.database import get_db_session
import backend.models as models
from backend.routers.auth import get_current_user
from backend.services.asaas_client import AsaasAPIError, AsaasClient
from backend.utils.plans import (
    PLAN_BUSINESS,
    PLAN_ENTERPRISE,
    PLAN_FREE,
    PLAN_START,
    normalize_plan,
)

router = APIRouter(prefix="/api/billing/asaas", tags=["Billing / Asaas"])


# =========================
# Schemas
# =========================
class CreditCardIn(BaseModel):
    holderName: str
    number: str
    expiryMonth: str
    expiryYear: str
    ccv: str


class CreditCardHolderInfoIn(BaseModel):
    name: str
    email: str
    cpfCnpj: str
    postalCode: str
    addressNumber: str
    phone: str
    mobilePhone: Optional[str] = None
    addressComplement: Optional[str] = None


class SubscribeIn(BaseModel):
    plan: str = Field(..., description="START, BUSINESS ou ENTERPRISE")
    billing_type: str = Field(..., description="PIX, BOLETO ou CREDIT_CARD")

    creditCard: Optional[CreditCardIn] = None
    creditCardHolderInfo: Optional[CreditCardHolderInfoIn] = None


# =========================
# Helpers gerais
# =========================
def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _digits_only(value: Any) -> str:
    return re.sub(r"\D+", "", str(value or ""))


def _id_get(obj: Any, key: str, default: Any = None) -> Any:
    if obj is None:
        return default

    if isinstance(obj, dict):
        return obj.get(key, default)

    return getattr(obj, key, default)


def _to_int(value: Any) -> Optional[int]:
    try:
        if value is None:
            return None
        s = str(value).strip()
        if not s:
            return None
        return int(s)
    except Exception:
        return None


def _require_empresa_id(identity: Any) -> int:
    empresa_id = _to_int(_id_get(identity, "empresa_id"))

    if not empresa_id:
        raise HTTPException(status_code=401, detail="empresa_id ausente na sessão.")

    return int(empresa_id)


def _asaas_enabled() -> bool:
    return str(os.getenv("ASAAS_ENABLED", "true")).strip().lower() not in {
        "0",
        "false",
        "no",
        "off",
    }


def _require_asaas_enabled() -> None:
    if not _asaas_enabled():
        raise HTTPException(status_code=503, detail="Integração Asaas desativada.")


def _normalize_paid_plan(plan: str) -> str:
    p = normalize_plan(plan)

    if p not in {PLAN_START, PLAN_BUSINESS, PLAN_ENTERPRISE}:
        raise HTTPException(
            status_code=400,
            detail="Plano inválido. Use START, BUSINESS ou ENTERPRISE.",
        )

    return p


def _normalize_billing_type(value: str) -> str:
    b = str(value or "").strip().upper()

    if b not in {"PIX", "BOLETO", "CREDIT_CARD"}:
        raise HTTPException(
            status_code=400,
            detail="Forma de pagamento inválida. Use PIX, BOLETO ou CREDIT_CARD.",
        )

    return b


def _plan_amount(plan: str) -> float:
    plan = _normalize_paid_plan(plan)

    env_map = {
        PLAN_START: "ZAPSCHAT_PRICE_START",
        PLAN_BUSINESS: "ZAPSCHAT_PRICE_BUSINESS",
        PLAN_ENTERPRISE: "ZAPSCHAT_PRICE_ENTERPRISE",
    }

    default_map = {
        PLAN_START: 97.0,
        PLAN_BUSINESS: 197.0,
        PLAN_ENTERPRISE: 497.0,
    }

    raw = os.getenv(env_map[plan])

    if raw:
        try:
            return float(str(raw).replace(",", "."))
        except Exception:
            pass

    return float(default_map[plan])


def _plan_name(plan: str) -> str:
    plan = _normalize_paid_plan(plan)

    return {
        PLAN_START: "Start",
        PLAN_BUSINESS: "Business",
        PLAN_ENTERPRISE: "Enterprise",
    }.get(plan, plan)


def _today_due_date() -> str:
    return date.today().isoformat()


def _model_dump(obj: Any) -> Dict[str, Any]:
    if obj is None:
        return {}

    if hasattr(obj, "model_dump"):
        return obj.model_dump(exclude_none=True)

    return obj.dict(exclude_none=True)


def _event_fingerprint(payload: Dict[str, Any]) -> str:
    raw = json.dumps(payload, sort_keys=True, ensure_ascii=False, default=str)
    return hashlib.sha256(raw.encode("utf-8", "ignore")).hexdigest()


def _to_iso(dt: Any) -> Optional[str]:
    if not dt:
        return None

    try:
        if isinstance(dt, str):
            return dt

        if getattr(dt, "tzinfo", None) is None:
            dt = dt.replace(tzinfo=timezone.utc)

        return dt.astimezone(timezone.utc).isoformat()
    except Exception:
        return str(dt)


def _empresa_or_404(db: Session, empresa_id: int) -> models.Empresa:
    emp = (
        db.query(models.Empresa)
        .filter(models.Empresa.id == int(empresa_id))
        .first()
    )

    if not emp:
        raise HTTPException(status_code=404, detail="Empresa não encontrada.")

    return emp


def _owner_email(db: Session, empresa_id: int) -> Optional[str]:
    try:
        user = (
            db.query(models.Usuario)
            .filter(models.Usuario.empresa_id == int(empresa_id))
            .order_by(models.Usuario.is_admin.desc(), models.Usuario.id.asc())
            .first()
        )

        return getattr(user, "email", None) if user else None

    except Exception:
        return None


def _safe_current_instances(db: Session, empresa_id: int) -> int:
    try:
        return (
            db.query(models.EmpresaInstancia)
            .filter(models.EmpresaInstancia.empresa_id == int(empresa_id))
            .count()
            or 0
        )
    except Exception:
        return 0


def _safe_plan_status(emp: models.Empresa, db: Session) -> Dict[str, Any]:
    """
    Evita quebrar caso plan_status_payload tenha assinatura diferente.
    """
    try:
        from backend.utils.plans import plan_status_payload

        current_instances = _safe_current_instances(db, int(emp.id))

        try:
            return plan_status_payload(emp, current_instances)
        except TypeError:
            try:
                return plan_status_payload(emp, connected=current_instances)
            except TypeError:
                try:
                    return plan_status_payload(emp)
                except TypeError:
                    pass
    except Exception:
        pass

    return {
        "effective_tier": getattr(emp, "effective_tier", normalize_plan(getattr(emp, "assinatura", PLAN_FREE))),
        "assinatura": normalize_plan(getattr(emp, "assinatura", PLAN_FREE)),
        "trial_active": bool(getattr(emp, "trial_active", False)),
        "paid_active": bool(getattr(emp, "paid_active", False)),
        "plano_expira_em": _to_iso(getattr(emp, "plano_expira_em", None)),
    }


# =========================
# Schema defensivo no banco
# =========================
def _ensure_billing_schema(db: Session) -> None:
    db.execute(text("ALTER TABLE empresas ADD COLUMN IF NOT EXISTS billing_provider VARCHAR(30)"))
    db.execute(text("ALTER TABLE empresas ADD COLUMN IF NOT EXISTS billing_status VARCHAR(40)"))
    db.execute(text("ALTER TABLE empresas ADD COLUMN IF NOT EXISTS billing_plan_pending VARCHAR(40)"))
    db.execute(text("ALTER TABLE empresas ADD COLUMN IF NOT EXISTS asaas_customer_id VARCHAR(120)"))
    db.execute(text("ALTER TABLE empresas ADD COLUMN IF NOT EXISTS asaas_subscription_id VARCHAR(120)"))
    db.execute(text("ALTER TABLE empresas ADD COLUMN IF NOT EXISTS asaas_last_payment_id VARCHAR(120)"))
    db.execute(text("ALTER TABLE empresas ADD COLUMN IF NOT EXISTS billing_updated_at TIMESTAMP WITH TIME ZONE"))

    db.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS billing_asaas_events (
              id SERIAL PRIMARY KEY,
              event_id VARCHAR(180) NOT NULL,
              empresa_id INTEGER NULL REFERENCES empresas(id) ON DELETE SET NULL,
              event VARCHAR(80) NULL,
              payment_id VARCHAR(120) NULL,
              subscription_id VARCHAR(120) NULL,
              payload JSONB NOT NULL,
              created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
            )
            """
        )
    )

    db.execute(
        text(
            """
            DO $$
            BEGIN
              IF NOT EXISTS (
                SELECT 1
                FROM pg_constraint
                WHERE conname = 'uq_billing_asaas_event_id'
              ) THEN
                ALTER TABLE billing_asaas_events
                ADD CONSTRAINT uq_billing_asaas_event_id UNIQUE (event_id);
              END IF;
            END $$
            """
        )
    )

    db.execute(text("CREATE INDEX IF NOT EXISTS ix_billing_asaas_events_empresa ON billing_asaas_events (empresa_id)"))
    db.execute(text("CREATE INDEX IF NOT EXISTS ix_billing_asaas_events_payment ON billing_asaas_events (payment_id)"))
    db.execute(text("CREATE INDEX IF NOT EXISTS ix_billing_asaas_events_subscription ON billing_asaas_events (subscription_id)"))


def _billing_row(db: Session, empresa_id: int) -> Dict[str, Any]:
    _ensure_billing_schema(db)

    row = db.execute(
        text(
            """
            SELECT
              billing_provider,
              billing_status,
              billing_plan_pending,
              asaas_customer_id,
              asaas_subscription_id,
              asaas_last_payment_id,
              billing_updated_at
            FROM empresas
            WHERE id = :empresa_id
            """
        ),
        {"empresa_id": int(empresa_id)},
    ).mappings().first()

    return dict(row or {})


def _update_billing_fields(db: Session, empresa_id: int, **fields: Any) -> None:
    if not fields:
        return

    allowed = {
        "billing_provider",
        "billing_status",
        "billing_plan_pending",
        "asaas_customer_id",
        "asaas_subscription_id",
        "asaas_last_payment_id",
        "billing_updated_at",
    }

    clean = {k: v for k, v in fields.items() if k in allowed}

    if not clean:
        return

    clean["billing_updated_at"] = clean.get("billing_updated_at") or _now_utc()

    sets = ", ".join([f"{k} = :{k}" for k in clean.keys()])
    clean["empresa_id"] = int(empresa_id)

    db.execute(
        text(f"UPDATE empresas SET {sets} WHERE id = :empresa_id"),
        clean,
    )


# =========================
# Asaas helpers
# =========================
def _ensure_asaas_customer(db: Session, emp: models.Empresa, client: AsaasClient) -> str:
    row = _billing_row(db, int(emp.id))
    existing = str(row.get("asaas_customer_id") or "").strip()

    if existing:
        return existing

    cpf_cnpj = _digits_only(getattr(emp, "cnpj_cpf", None))
    phone = _digits_only(getattr(emp, "telefone", None))
    email = _owner_email(db, int(emp.id))

    payload: Dict[str, Any] = {
        "name": getattr(emp, "nome", None) or f"Empresa {emp.id}",
    }

    if cpf_cnpj:
        payload["cpfCnpj"] = cpf_cnpj

    if phone:
        payload["mobilePhone"] = phone

    if email:
        payload["email"] = email

    created = client.create_customer(payload)
    customer_id = created.get("id")

    if not customer_id:
        raise HTTPException(
            status_code=502,
            detail="Asaas não retornou ID do cliente.",
        )

    _update_billing_fields(
        db,
        int(emp.id),
        billing_provider="asaas",
        asaas_customer_id=str(customer_id),
        billing_status="customer_created",
    )

    db.flush()

    return str(customer_id)


def _first_payment_from_subscription(
    client: AsaasClient,
    subscription_id: str,
) -> Optional[Dict[str, Any]]:
    try:
        result = client.get_subscription_payments(subscription_id)
        data = result.get("data")

        if isinstance(data, list) and data:
            return data[0]

    except Exception:
        return None

    return None


def _payment_extras(
    client: AsaasClient,
    billing_type: str,
    payment_id: Optional[str],
) -> Dict[str, Any]:
    if not payment_id:
        return {}

    out: Dict[str, Any] = {}

    if billing_type == "PIX":
        try:
            out["pix"] = client.get_payment_pix_qr_code(payment_id)
        except Exception as e:
            out["pix_error"] = str(e)

    if billing_type == "BOLETO":
        try:
            out["boleto"] = client.get_payment_identification_field(payment_id)
        except Exception as e:
            out["boleto_error"] = str(e)

    return out


# =========================
# Webhook helpers
# =========================
def _extract_payment_from_payload(payload: Dict[str, Any]) -> Dict[str, Any]:
    payment = payload.get("payment")

    if isinstance(payment, dict):
        return payment

    data = payload.get("data")

    if isinstance(data, dict):
        return data

    return {}


def _find_empresa_by_billing(
    db: Session,
    payment: Dict[str, Any],
) -> Tuple[Optional[models.Empresa], Optional[str]]:
    external_ref = str(payment.get("externalReference") or "").strip()
    subscription_id = str(payment.get("subscription") or "").strip()
    customer_id = str(payment.get("customer") or "").strip()
    payment_id = str(payment.get("id") or "").strip()

    empresa_id: Optional[int] = None
    plan: Optional[str] = None

    # Formato criado pelo ZapsChat:
    # zapschat:empresa:123:plano:BUSINESS
    m = re.search(r"empresa:(\d+):plano:([A-Z_]+)", external_ref)

    if m:
        empresa_id = int(m.group(1))
        try:
            plan = _normalize_paid_plan(m.group(2))
        except Exception:
            plan = None

    if not empresa_id and payment_id:
        row = db.execute(
            text(
                """
                SELECT id, billing_plan_pending
                FROM empresas
                WHERE asaas_last_payment_id = :payment_id
                LIMIT 1
                """
            ),
            {"payment_id": payment_id},
        ).mappings().first()

        if row:
            empresa_id = int(row["id"])
            plan = row.get("billing_plan_pending") or plan

    if not empresa_id and subscription_id:
        row = db.execute(
            text(
                """
                SELECT id, billing_plan_pending
                FROM empresas
                WHERE asaas_subscription_id = :subscription_id
                LIMIT 1
                """
            ),
            {"subscription_id": subscription_id},
        ).mappings().first()

        if row:
            empresa_id = int(row["id"])
            plan = row.get("billing_plan_pending") or plan

    if not empresa_id and customer_id:
        row = db.execute(
            text(
                """
                SELECT id, billing_plan_pending
                FROM empresas
                WHERE asaas_customer_id = :customer_id
                LIMIT 1
                """
            ),
            {"customer_id": customer_id},
        ).mappings().first()

        if row:
            empresa_id = int(row["id"])
            plan = row.get("billing_plan_pending") or plan

    if not empresa_id:
        return None, None

    emp = (
        db.query(models.Empresa)
        .filter(models.Empresa.id == int(empresa_id))
        .first()
    )

    if plan:
        try:
            plan = _normalize_paid_plan(plan)
        except Exception:
            plan = None

    return emp, plan


def _record_webhook_event(
    db: Session,
    event_id: str,
    event: str,
    payload: Dict[str, Any],
    empresa_id: Optional[int],
    payment_id: Optional[str],
    subscription_id: Optional[str],
) -> bool:
    """
    Retorna True se gravou agora.
    Retorna False se era duplicado.
    """
    try:
        db.execute(
            text(
                """
                INSERT INTO billing_asaas_events (
                  event_id,
                  empresa_id,
                  event,
                  payment_id,
                  subscription_id,
                  payload,
                  created_at
                )
                VALUES (
                  :event_id,
                  :empresa_id,
                  :event,
                  :payment_id,
                  :subscription_id,
                  CAST(:payload AS JSONB),
                  :created_at
                )
                """
            ),
            {
                "event_id": event_id,
                "empresa_id": empresa_id,
                "event": event,
                "payment_id": payment_id,
                "subscription_id": subscription_id,
                "payload": json.dumps(payload, ensure_ascii=False, default=str),
                "created_at": _now_utc(),
            },
        )
        return True

    except Exception:
        db.rollback()
        return False


def _extend_plan(emp: models.Empresa, plan: str, days: int = 30) -> datetime:
    now = _now_utc()

    current = getattr(emp, "plano_expira_em", None)

    if current is not None:
        if current.tzinfo is None:
            current = current.replace(tzinfo=timezone.utc)
        base = current if current > now else now
    else:
        base = now

    new_exp = base + timedelta(days=int(days))

    emp.assinatura = _normalize_paid_plan(plan)
    emp.trial_tier = None
    emp.trial_expires_at = None
    emp.plano_expira_em = new_exp

    return new_exp


def _verify_webhook_token(
    token_query: Optional[str],
    authorization: Optional[str],
    asaas_access_token: Optional[str],
    x_asaas_webhook_token: Optional[str],
    x_asaas_token: Optional[str],
) -> None:
    expected = (os.getenv("ASAAS_WEBHOOK_TOKEN") or "").strip()

    if not expected:
        return

    candidates = []

    if token_query:
        candidates.append(str(token_query).strip())

    if asaas_access_token:
        candidates.append(str(asaas_access_token).strip())

    if x_asaas_webhook_token:
        candidates.append(str(x_asaas_webhook_token).strip())

    if x_asaas_token:
        candidates.append(str(x_asaas_token).strip())

    if authorization:
        auth = str(authorization).strip()

        if auth.lower().startswith("bearer "):
            candidates.append(auth.split(" ", 1)[1].strip())
        else:
            candidates.append(auth)

    for candidate in candidates:
        if candidate and hmac.compare_digest(candidate, expected):
            return

    raise HTTPException(status_code=401, detail="Webhook Asaas não autorizado.")


# =========================
# Rotas privadas
# =========================
@router.get("/status")
def billing_status(
    db: Session = Depends(get_db_session),
    identity: Any = Depends(get_current_user),
):
    empresa_id = _require_empresa_id(identity)
    _ensure_billing_schema(db)

    emp = _empresa_or_404(db, empresa_id)
    row = _billing_row(db, empresa_id)

    return {
        "ok": True,
        "empresa_id": int(emp.id),
        "assinatura": normalize_plan(getattr(emp, "assinatura", PLAN_FREE)),
        "plano_expira_em": _to_iso(getattr(emp, "plano_expira_em", None)),
        "trial_tier": getattr(emp, "trial_tier", None),
        "trial_expires_at": _to_iso(getattr(emp, "trial_expires_at", None)),
        "billing": row,
        "plan_status": _safe_plan_status(emp, db),
    }


@router.post("/subscribe")
def create_subscription(
    body: SubscribeIn,
    request: Request,
    db: Session = Depends(get_db_session),
    identity: Any = Depends(get_current_user),
):
    _require_asaas_enabled()
    _ensure_billing_schema(db)

    empresa_id = _require_empresa_id(identity)
    emp = _empresa_or_404(db, empresa_id)

    plan = _normalize_paid_plan(body.plan)
    billing_type = _normalize_billing_type(body.billing_type)

    if billing_type == "CREDIT_CARD":
        if not body.creditCard or not body.creditCardHolderInfo:
            raise HTTPException(
                status_code=400,
                detail="Para cartão, envie creditCard e creditCardHolderInfo.",
            )

    row = _billing_row(db, empresa_id)

    # Evita clique duplicado criando várias assinaturas iguais pendentes.
    if (
        row.get("asaas_subscription_id")
        and row.get("billing_status") in {"pending", "created", "customer_created"}
        and row.get("billing_plan_pending") == plan
    ):
        subscription_id = str(row.get("asaas_subscription_id"))

        client = AsaasClient()

        first_payment = _first_payment_from_subscription(client, subscription_id)
        payment_id = first_payment.get("id") if isinstance(first_payment, dict) else None

        extras = _payment_extras(client, billing_type, payment_id)

        return {
            "ok": True,
            "reused": True,
            "message": "Já existe uma assinatura pendente para este plano.",
            "empresa_id": empresa_id,
            "plan": plan,
            "plan_name": _plan_name(plan),
            "billing_type": billing_type,
            "subscription_id": subscription_id,
            "payment": first_payment,
            **extras,
        }

    client = AsaasClient()
    customer_id = _ensure_asaas_customer(db, emp, client)

    amount = _plan_amount(plan)
    external_ref = f"zapschat:empresa:{empresa_id}:plano:{plan}"

    payload: Dict[str, Any] = {
        "customer": customer_id,
        "billingType": billing_type,
        "value": amount,
        "nextDueDate": _today_due_date(),
        "cycle": "MONTHLY",
        "description": f"ZapsChat Connect - Plano {_plan_name(plan)}",
        "externalReference": external_ref,
    }

    if billing_type == "CREDIT_CARD":
        payload["creditCard"] = _model_dump(body.creditCard)
        payload["creditCardHolderInfo"] = _model_dump(body.creditCardHolderInfo)

        try:
            payload["remoteIp"] = request.client.host if request.client else None
        except Exception:
            payload["remoteIp"] = None

    try:
        subscription = client.create_subscription(payload)

    except AsaasAPIError as e:
        raise HTTPException(
            status_code=400 if e.status_code < 500 else 502,
            detail={
                "message": str(e),
                "asaas_status": e.status_code,
                "asaas_payload": e.payload,
            },
        )

    subscription_id = subscription.get("id")

    if not subscription_id:
        raise HTTPException(
            status_code=502,
            detail="Asaas não retornou ID da assinatura.",
        )

    first_payment = _first_payment_from_subscription(client, str(subscription_id))
    payment_id = first_payment.get("id") if isinstance(first_payment, dict) else None

    _update_billing_fields(
        db,
        empresa_id,
        billing_provider="asaas",
        billing_status="pending",
        billing_plan_pending=plan,
        asaas_customer_id=customer_id,
        asaas_subscription_id=str(subscription_id),
        asaas_last_payment_id=payment_id,
    )

    db.commit()

    extras = _payment_extras(client, billing_type, payment_id)

    return {
        "ok": True,
        "message": "Assinatura criada. Aguarde a confirmação do pagamento.",
        "empresa_id": empresa_id,
        "plan": plan,
        "plan_name": _plan_name(plan),
        "amount": amount,
        "billing_type": billing_type,
        "customer_id": customer_id,
        "subscription_id": subscription_id,
        "payment": first_payment,
        "subscription": subscription,
        **extras,
    }


# =========================
# Webhook público do Asaas
# =========================
@router.post("/webhook")
async def asaas_webhook(
    request: Request,
    token: Optional[str] = Query(default=None),
    authorization: Optional[str] = Header(default=None, alias="Authorization"),
    asaas_access_token: Optional[str] = Header(default=None, alias="asaas-access-token"),
    x_asaas_webhook_token: Optional[str] = Header(default=None, alias="X-Asaas-Webhook-Token"),
    x_asaas_token: Optional[str] = Header(default=None, alias="X-Asaas-Token"),
    db: Session = Depends(get_db_session),
):
    _ensure_billing_schema(db)

    _verify_webhook_token(
        token_query=token,
        authorization=authorization,
        asaas_access_token=asaas_access_token,
        x_asaas_webhook_token=x_asaas_webhook_token,
        x_asaas_token=x_asaas_token,
    )

    try:
        payload = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="JSON inválido.")

    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="Payload inválido.")

    event = str(payload.get("event") or payload.get("type") or "").strip().upper()
    payment = _extract_payment_from_payload(payload)

    payment_id = str(payment.get("id") or "").strip() or None
    subscription_id = str(payment.get("subscription") or "").strip() or None
    status = str(payment.get("status") or "").strip().upper()

    event_id = str(payload.get("id") or "").strip()

    if not event_id:
        event_id = f"{event}:{payment_id or '-'}:{status}:{_event_fingerprint(payload)}"

    emp, plan = _find_empresa_by_billing(db, payment)
    empresa_id = int(emp.id) if emp else None

    inserted = _record_webhook_event(
        db=db,
        event_id=event_id,
        event=event,
        payload=payload,
        empresa_id=empresa_id,
        payment_id=payment_id,
        subscription_id=subscription_id,
    )

    if not inserted:
        return {
            "ok": True,
            "duplicate": True,
            "event": event,
            "payment_id": payment_id,
        }

    paid_events = {
        "PAYMENT_RECEIVED",
        "PAYMENT_CONFIRMED",
        "PAYMENT_RECEIVED_IN_CASH",
    }

    overdue_events = {
        "PAYMENT_OVERDUE",
    }

    pending_events = {
        "PAYMENT_CREATED",
        "PAYMENT_UPDATED",
        "PAYMENT_AWAITING_RISK_ANALYSIS",
        "PAYMENT_AUTHORIZED",
    }

    refused_events = {
        "PAYMENT_REPROVED_BY_RISK_ANALYSIS",
        "PAYMENT_CREDIT_CARD_CAPTURE_REFUSED",
        "PAYMENT_BANK_SLIP_CANCELLED",
    }

    negative_events = {
        "PAYMENT_DELETED",
        "PAYMENT_REFUNDED",
        "PAYMENT_REFUND_IN_PROGRESS",
        "PAYMENT_PARTIALLY_REFUNDED",
        "PAYMENT_CHARGEBACK_REQUESTED",
        "PAYMENT_CHARGEBACK_DISPUTE",
        "PAYMENT_AWAITING_CHARGEBACK_REVERSAL",
    }

    if emp and plan and event in paid_events:
        new_exp = _extend_plan(emp, plan, days=30)
        db.add(emp)

        existing_row = _billing_row(db, int(emp.id))

        _update_billing_fields(
            db,
            int(emp.id),
            billing_provider="asaas",
            billing_status="active",
            billing_plan_pending=plan,
            asaas_last_payment_id=payment_id,
            asaas_subscription_id=subscription_id or existing_row.get("asaas_subscription_id"),
        )

        db.commit()

        return {
            "ok": True,
            "processed": "plan_activated",
            "empresa_id": int(emp.id),
            "plan": plan,
            "plano_expira_em": new_exp.isoformat(),
        }

    if emp and event in overdue_events:
        existing_row = _billing_row(db, int(emp.id))

        _update_billing_fields(
            db,
            int(emp.id),
            billing_provider="asaas",
            billing_status="past_due",
            asaas_last_payment_id=payment_id,
            asaas_subscription_id=subscription_id or existing_row.get("asaas_subscription_id"),
        )

        db.commit()

        return {
            "ok": True,
            "processed": "payment_overdue",
            "empresa_id": int(emp.id),
        }

    if emp and event in pending_events:
        existing_row = _billing_row(db, int(emp.id))

        _update_billing_fields(
            db,
            int(emp.id),
            billing_provider="asaas",
            billing_status="pending",
            asaas_last_payment_id=payment_id,
            asaas_subscription_id=subscription_id or existing_row.get("asaas_subscription_id"),
        )

        db.commit()

        return {
            "ok": True,
            "processed": "payment_pending",
            "empresa_id": int(emp.id),
        }

    if emp and event in refused_events:
        existing_row = _billing_row(db, int(emp.id))

        _update_billing_fields(
            db,
            int(emp.id),
            billing_provider="asaas",
            billing_status="refused",
            asaas_last_payment_id=payment_id,
            asaas_subscription_id=subscription_id or existing_row.get("asaas_subscription_id"),
        )

        db.commit()

        return {
            "ok": True,
            "processed": "payment_refused",
            "empresa_id": int(emp.id),
        }

    if emp and event in negative_events:
        existing_row = _billing_row(db, int(emp.id))

        _update_billing_fields(
            db,
            int(emp.id),
            billing_provider="asaas",
            billing_status="attention",
            asaas_last_payment_id=payment_id,
            asaas_subscription_id=subscription_id or existing_row.get("asaas_subscription_id"),
        )

        db.commit()

        return {
            "ok": True,
            "processed": "payment_attention",
            "empresa_id": int(emp.id),
        }

    db.commit()

    return {
        "ok": True,
        "processed": "ignored",
        "event": event,
        "payment_id": payment_id,
        "subscription_id": subscription_id,
        "empresa_id": empresa_id,
    }