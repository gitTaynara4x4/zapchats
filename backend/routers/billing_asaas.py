from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import time
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo
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

PLAN_CYCLE_DAYS = int(os.getenv("PLAN_CYCLE_DAYS", "30") or "30")

PAID_EVENTS = {
    "PAYMENT_RECEIVED",
    "PAYMENT_CONFIRMED",
    "PAYMENT_RECEIVED_IN_CASH",
}
PAID_STATUSES = {"RECEIVED", "CONFIRMED", "RECEIVED_IN_CASH"}
OVERDUE_EVENTS = {"PAYMENT_OVERDUE", "PAYMENT_BANK_SLIP_CANCELLED"}
PENDING_EVENTS = {
    "PAYMENT_CREATED",
    "PAYMENT_UPDATED",
    "PAYMENT_AWAITING_RISK_ANALYSIS",
    "PAYMENT_APPROVED_BY_RISK_ANALYSIS",
    "PAYMENT_AUTHORIZED",
}
REFUSED_EVENTS = {
    "PAYMENT_REPROVED_BY_RISK_ANALYSIS",
    "PAYMENT_CREDIT_CARD_CAPTURE_REFUSED",
}
REVERSAL_EVENTS = {
    "PAYMENT_REFUNDED",
    "PAYMENT_CHARGEBACK_REQUESTED",
    "PAYMENT_CHARGEBACK_DISPUTE",
    "PAYMENT_RECEIVED_IN_CASH_UNDONE",
}
ATTENTION_EVENTS = {
    "PAYMENT_DELETED",
    "PAYMENT_REFUND_IN_PROGRESS",
    "PAYMENT_PARTIALLY_REFUNDED",
    "PAYMENT_AWAITING_CHARGEBACK_REVERSAL",
}
WEBHOOK_EVENTS = sorted(
    PAID_EVENTS
    | OVERDUE_EVENTS
    | PENDING_EVENTS
    | REFUSED_EVENTS
    | REVERSAL_EVENTS
    | ATTENTION_EVENTS
)


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
    timezone_name = (os.getenv("APP_TZ") or "America/Sao_Paulo").strip()
    try:
        local_tz = ZoneInfo(timezone_name)
    except Exception:
        local_tz = timezone.utc
    return datetime.now(local_tz).date().isoformat()


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
def _lock_empresa_billing(db: Session, empresa_id: int) -> None:
    """Serializa alterações de cobrança da mesma empresa no PostgreSQL."""
    db.execute(
        text("SELECT pg_advisory_xact_lock(:lock_key)"),
        {"lock_key": 8_000_000_000 + int(empresa_id)},
    )


def _ensure_billing_schema(db: Session) -> None:
    db.execute(text("ALTER TABLE empresas ADD COLUMN IF NOT EXISTS billing_provider VARCHAR(30)"))
    db.execute(text("ALTER TABLE empresas ADD COLUMN IF NOT EXISTS billing_status VARCHAR(40)"))
    db.execute(text("ALTER TABLE empresas ADD COLUMN IF NOT EXISTS billing_plan_pending VARCHAR(40)"))
    db.execute(text("ALTER TABLE empresas ADD COLUMN IF NOT EXISTS asaas_customer_id VARCHAR(120)"))
    db.execute(text("ALTER TABLE empresas ADD COLUMN IF NOT EXISTS asaas_subscription_id VARCHAR(120)"))
    db.execute(text("ALTER TABLE empresas ADD COLUMN IF NOT EXISTS asaas_last_payment_id VARCHAR(120)"))
    db.execute(text("ALTER TABLE empresas ADD COLUMN IF NOT EXISTS asaas_billing_type VARCHAR(30)"))
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

    db.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS billing_asaas_payment_credits (
              id SERIAL PRIMARY KEY,
              payment_id VARCHAR(120) NOT NULL UNIQUE,
              empresa_id INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
              subscription_id VARCHAR(120) NULL,
              plan VARCHAR(40) NOT NULL,
              payment_status VARCHAR(40) NULL,
              event_id VARCHAR(180) NULL,
              credited_days INTEGER NOT NULL DEFAULT 30,
              credited_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
              reversed_at TIMESTAMP WITH TIME ZONE NULL,
              reversal_event_id VARCHAR(180) NULL
            )
            """
        )
    )
    db.execute(text("CREATE INDEX IF NOT EXISTS ix_billing_asaas_credits_empresa ON billing_asaas_payment_credits (empresa_id)"))
    db.execute(text("CREATE INDEX IF NOT EXISTS ix_billing_asaas_credits_subscription ON billing_asaas_payment_credits (subscription_id)"))


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
              asaas_billing_type,
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
        "asaas_billing_type",
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

    lookup_queries = []
    if cpf_cnpj:
        lookup_queries.append({"cpf_cnpj": cpf_cnpj})
    if email:
        lookup_queries.append({"email": email})

    for query in lookup_queries:
        listed = client.list_customers(limit=20, **query)
        items = listed.get("data") if isinstance(listed, dict) else None
        if not isinstance(items, list):
            continue
        for item in items:
            if not isinstance(item, dict) or not item.get("id"):
                continue
            same_document = cpf_cnpj and _digits_only(item.get("cpfCnpj")) == cpf_cnpj
            same_email = email and str(item.get("email") or "").strip().lower() == str(email).strip().lower()
            if same_document or (not cpf_cnpj and same_email):
                customer_id = str(item["id"])
                _update_billing_fields(
                    db,
                    int(emp.id),
                    billing_provider="asaas",
                    asaas_customer_id=customer_id,
                    billing_status="customer_created",
                )
                db.flush()
                return customer_id

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


def _find_active_subscription(
    client: AsaasClient,
    *,
    customer_id: str,
    external_reference: str,
) -> Optional[Dict[str, Any]]:
    result = client.list_subscriptions(
        customer=customer_id,
        external_reference=external_reference,
        status="ACTIVE",
        limit=20,
    )
    items = result.get("data") if isinstance(result, dict) else None
    if not isinstance(items, list):
        return None
    rows = [item for item in items if isinstance(item, dict) and item.get("id")]
    rows.sort(
        key=lambda item: (
            str(item.get("dateCreated") or ""),
            str(item.get("id") or ""),
        ),
        reverse=True,
    )
    return rows[0] if rows else None


def _payment_sort_key(payment: Dict[str, Any]) -> Tuple[str, str, str]:
    return (
        str(payment.get("dueDate") or ""),
        str(payment.get("dateCreated") or payment.get("clientPaymentDate") or ""),
        str(payment.get("id") or ""),
    )


def _subscription_payments(
    client: AsaasClient,
    subscription_id: str,
) -> list[Dict[str, Any]]:
    result = client.get_subscription_payments(subscription_id)
    data = result.get("data") if isinstance(result, dict) else None
    if not isinstance(data, list):
        return []
    rows = [item for item in data if isinstance(item, dict)]
    rows.sort(key=_payment_sort_key, reverse=True)
    return rows


def _current_payment_from_subscription(
    client: AsaasClient,
    subscription_id: str,
    attempts: int = 1,
) -> Optional[Dict[str, Any]]:
    attempts = max(1, min(int(attempts or 1), 5))
    for attempt in range(attempts):
        try:
            rows = _subscription_payments(client, subscription_id)
            if rows:
                return _oldest_open_payment(rows) or rows[0]
        except Exception:
            if attempt >= attempts - 1:
                return None

        if attempt < attempts - 1:
            time.sleep(0.35 * (attempt + 1))

    return None


def _payment_is_paid(payment: Optional[Dict[str, Any]]) -> bool:
    return bool(payment) and str(payment.get("status") or "").upper() in PAID_STATUSES


def _latest_paid_payment(payments: list[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    return next((item for item in payments if _payment_is_paid(item)), None)


def _oldest_open_payment(payments: list[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    ignored = PAID_STATUSES | {"REFUNDED", "DELETED", "RECEIVED_IN_CASH_UNDONE"}
    open_rows = [
        item for item in payments
        if str(item.get("status") or "").upper() not in ignored
    ]
    if not open_rows:
        return None
    return sorted(open_rows, key=_payment_sort_key)[0]


def _has_unexpired_paid_access(emp: models.Empresa) -> bool:
    plan = normalize_plan(getattr(emp, "assinatura", None))
    if plan not in {PLAN_START, PLAN_BUSINESS, PLAN_ENTERPRISE}:
        return False
    expires_at = getattr(emp, "plano_expira_em", None)
    if not expires_at:
        return False
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    return expires_at > _now_utc()


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


def _env_enabled(name: str, default: str = "false") -> bool:
    return str(os.getenv(name, default)).strip().lower() not in {"0", "false", "no", "off"}


def _public_webhook_url(request: Request) -> str:
    configured = (os.getenv("PUBLIC_BASE_URL") or os.getenv("ZAPSCHAT_PUBLIC_URL") or "").strip()
    if configured and "127.0.0.1" not in configured and "localhost" not in configured:
        base = configured.rstrip("/")
    else:
        proto = (request.headers.get("x-forwarded-proto") or request.url.scheme or "https").split(",", 1)[0].strip()
        host = (request.headers.get("x-forwarded-host") or request.headers.get("host") or request.url.netloc).split(",", 1)[0].strip()
        base = f"{proto}://{host}".rstrip("/")
    return f"{base}/api/billing/asaas/webhook"


def _ensure_asaas_webhook(request: Request, client: AsaasClient, email: Optional[str]) -> Dict[str, Any]:
    if not _env_enabled("ASAAS_AUTO_CONFIGURE_WEBHOOK", "true"):
        return {"configured": False, "reason": "disabled"}

    token = (os.getenv("ASAAS_WEBHOOK_TOKEN") or "").strip()
    if len(token) < 32:
        raise HTTPException(status_code=500, detail="ASAAS_WEBHOOK_TOKEN deve possuir pelo menos 32 caracteres.")

    url = _public_webhook_url(request)
    payload: Dict[str, Any] = {
        "name": "ZapsChat Billing",
        "url": url,
        "enabled": True,
        "interrupted": False,
        "authToken": token,
        "sendType": "SEQUENTIALLY",
        "events": WEBHOOK_EVENTS,
    }
    alert_email = (os.getenv("ASAAS_WEBHOOK_EMAIL") or email or "").strip()
    if alert_email:
        payload["email"] = alert_email

    try:
        listed = client.list_webhooks()
        items = listed.get("data") if isinstance(listed, dict) else None
        items = items if isinstance(items, list) else []
        existing = next(
            (item for item in items if isinstance(item, dict) and str(item.get("url") or "").rstrip("/") == url.rstrip("/")),
            None,
        )
        if existing and existing.get("id"):
            updated = client.update_webhook(str(existing["id"]), payload)
            return {"configured": True, "created": False, "id": existing.get("id"), "url": url, "webhook": updated}

        created = client.create_webhook(payload)
        return {"configured": True, "created": True, "id": created.get("id"), "url": url, "webhook": created}
    except AsaasAPIError as exc:
        if _env_enabled("ASAAS_REQUIRE_WEBHOOK", "true"):
            raise HTTPException(
                status_code=502,
                detail={"message": "Não foi possível configurar o webhook do Asaas. Nenhuma cobrança foi criada.", "asaas_status": exc.status_code, "asaas_payload": exc.payload},
            )
        return {"configured": False, "url": url, "error": str(exc)}


def _claim_payment_credit(
    db: Session,
    *,
    payment_id: str,
    empresa_id: int,
    subscription_id: Optional[str],
    plan: str,
    payment_status: Optional[str],
    event_id: Optional[str],
    days: int = PLAN_CYCLE_DAYS,
) -> bool:
    row = db.execute(
        text(
            """
            INSERT INTO billing_asaas_payment_credits (
              payment_id, empresa_id, subscription_id, plan, payment_status, event_id, credited_days, credited_at
            ) VALUES (
              :payment_id, :empresa_id, :subscription_id, :plan, :payment_status, :event_id, :credited_days, :credited_at
            )
            ON CONFLICT (payment_id) DO NOTHING
            RETURNING id
            """
        ),
        {
            "payment_id": payment_id,
            "empresa_id": int(empresa_id),
            "subscription_id": subscription_id,
            "plan": _normalize_paid_plan(plan),
            "payment_status": payment_status,
            "event_id": event_id,
            "credited_days": int(days),
            "credited_at": _now_utc(),
        },
    ).first()
    return bool(row)


def _activate_payment_once(
    db: Session,
    emp: models.Empresa,
    plan: str,
    payment_id: Optional[str],
    subscription_id: Optional[str],
    payment_status: Optional[str],
    event_id: Optional[str],
) -> Tuple[bool, Optional[datetime]]:
    if not payment_id:
        raise HTTPException(status_code=400, detail="Pagamento confirmado sem identificador do Asaas.")

    credited = _claim_payment_credit(
        db,
        payment_id=str(payment_id),
        empresa_id=int(emp.id),
        subscription_id=subscription_id,
        plan=plan,
        payment_status=payment_status,
        event_id=event_id,
        days=PLAN_CYCLE_DAYS,
    )

    expires_at = (
        _extend_plan(emp, plan, days=PLAN_CYCLE_DAYS)
        if credited
        else getattr(emp, "plano_expira_em", None)
    )
    return credited, expires_at


def _reverse_payment_credit(
    db: Session,
    emp: models.Empresa,
    payment_id: Optional[str],
    reversal_event_id: Optional[str],
) -> bool:
    if not payment_id:
        return False
    row = db.execute(
        text(
            """
            UPDATE billing_asaas_payment_credits
               SET reversed_at = :reversed_at, reversal_event_id = :reversal_event_id
             WHERE payment_id = :payment_id
               AND reversed_at IS NULL
            RETURNING credited_days
            """
        ),
        {"payment_id": payment_id, "reversed_at": _now_utc(), "reversal_event_id": reversal_event_id},
    ).mappings().first()
    if not row:
        return False

    current = getattr(emp, "plano_expira_em", None)
    if current is not None:
        if current.tzinfo is None:
            current = current.replace(tzinfo=timezone.utc)
        emp.plano_expira_em = current - timedelta(days=int(row.get("credited_days") or PLAN_CYCLE_DAYS))
    return True


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
    """Grava o evento uma única vez e informa se ele era novo."""
    row = db.execute(
        text(
            """
            INSERT INTO billing_asaas_events (
              event_id, empresa_id, event, payment_id, subscription_id, payload, created_at
            ) VALUES (
              :event_id, :empresa_id, :event, :payment_id, :subscription_id,
              CAST(:payload AS JSONB), :created_at
            )
            ON CONFLICT (event_id) DO NOTHING
            RETURNING id
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
    ).first()
    return bool(row)


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
        if _env_enabled("ASAAS_ALLOW_UNSIGNED_WEBHOOK", "false"):
            return
        raise HTTPException(status_code=503, detail="ASAAS_WEBHOOK_TOKEN não configurado.")

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
def _status_response(db: Session, emp: models.Empresa) -> Dict[str, Any]:
    return {
        "ok": True,
        "empresa_id": int(emp.id),
        "assinatura": normalize_plan(getattr(emp, "assinatura", PLAN_FREE)),
        "plano_expira_em": _to_iso(getattr(emp, "plano_expira_em", None)),
        "trial_tier": getattr(emp, "trial_tier", None),
        "trial_expires_at": _to_iso(getattr(emp, "trial_expires_at", None)),
        "billing": _billing_row(db, int(emp.id)),
        "plan_status": _safe_plan_status(emp, db),
        "trial_days": int(os.getenv("TRIAL_DAYS", "14") or "14"),
        "cycle_days": PLAN_CYCLE_DAYS,
        "asaas_enabled": _asaas_enabled(),
    }


@router.get("/status")
def billing_status(
    db: Session = Depends(get_db_session),
    identity: Any = Depends(get_current_user),
):
    empresa_id = _require_empresa_id(identity)
    _ensure_billing_schema(db)
    emp = _empresa_or_404(db, empresa_id)
    return _status_response(db, emp)


@router.post("/sync")
def sync_payment_status(
    db: Session = Depends(get_db_session),
    identity: Any = Depends(get_current_user),
):
    """Conciliação manual de segurança quando o webhook atrasar ou falhar."""
    _require_asaas_enabled()
    _ensure_billing_schema(db)

    empresa_id = _require_empresa_id(identity)
    emp = _empresa_or_404(db, empresa_id)
    row = _billing_row(db, empresa_id)
    subscription_id = str(row.get("asaas_subscription_id") or "").strip()

    if not subscription_id:
        return {
            **_status_response(db, emp),
            "synchronized": False,
            "message": "Nenhuma assinatura Asaas vinculada.",
        }

    client = AsaasClient()
    try:
        payments = _subscription_payments(client, subscription_id)
    except AsaasAPIError as exc:
        raise HTTPException(
            status_code=502,
            detail={
                "message": "Não foi possível consultar as cobranças no Asaas.",
                "asaas_status": exc.status_code,
                "asaas_payload": exc.payload,
            },
        )

    if not payments:
        return {
            **_status_response(db, emp),
            "synchronized": False,
            "message": "A cobrança ainda não foi disponibilizada pelo Asaas.",
        }

    latest_paid = _latest_paid_payment(payments)
    open_payment = _oldest_open_payment(payments)
    display_payment = open_payment or latest_paid or payments[0]
    display_payment_id = str((display_payment or {}).get("id") or "").strip() or None
    billing_type = str(
        (display_payment or {}).get("billingType")
        or row.get("asaas_billing_type")
        or ""
    ).strip().upper() or None
    plan_raw = row.get("billing_plan_pending") or getattr(emp, "assinatura", None)
    plan = normalize_plan(plan_raw)
    credited = False
    reversed_credit = False

    if latest_paid and plan in {PLAN_START, PLAN_BUSINESS, PLAN_ENTERPRISE}:
        paid_id = str(latest_paid.get("id") or "").strip() or None
        paid_status = str(latest_paid.get("status") or "").strip().upper()
        credited, _ = _activate_payment_once(
            db, emp, plan, paid_id, subscription_id, paid_status,
            f"sync:{paid_id}:{paid_status}",
        )
        db.add(emp)

    display_status = str((display_payment or {}).get("status") or "").strip().upper()
    if display_status in {"REFUNDED", "CHARGEBACK_REQUESTED", "CHARGEBACK_DISPUTE", "RECEIVED_IN_CASH_UNDONE"}:
        reversed_credit = _reverse_payment_credit(
            db, emp, display_payment_id, f"sync:{display_payment_id}:{display_status}"
        )
        db.add(emp)

    if _has_unexpired_paid_access(emp):
        billing_status_value = "active"
    elif display_status in {"OVERDUE", "BANK_SLIP_CANCELLED"}:
        billing_status_value = "past_due"
    elif display_status in {"REFUNDED", "CHARGEBACK_REQUESTED", "CHARGEBACK_DISPUTE", "RECEIVED_IN_CASH_UNDONE"}:
        billing_status_value = "attention"
    elif display_status in {"REPROVED_BY_RISK_ANALYSIS", "CREDIT_CARD_CAPTURE_REFUSED"}:
        billing_status_value = "refused"
    else:
        billing_status_value = "pending"

    _update_billing_fields(
        db, empresa_id,
        billing_provider="asaas",
        billing_status=billing_status_value,
        asaas_last_payment_id=display_payment_id,
        asaas_subscription_id=subscription_id,
        asaas_billing_type=billing_type,
    )
    db.commit()
    db.refresh(emp)

    extras = _payment_extras(client, billing_type or "", display_payment_id)
    return {
        **_status_response(db, emp),
        "synchronized": True,
        "credited": credited,
        "reversed_credit": reversed_credit,
        "payment": display_payment,
        "last_paid_payment": latest_paid,
        **extras,
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
    _lock_empresa_billing(db, empresa_id)
    plan = _normalize_paid_plan(body.plan)
    billing_type = _normalize_billing_type(body.billing_type)

    if billing_type == "CREDIT_CARD" and (not body.creditCard or not body.creditCardHolderInfo):
        raise HTTPException(status_code=400, detail="Para cartão, envie creditCard e creditCardHolderInfo.")

    client = AsaasClient()
    webhook_info = _ensure_asaas_webhook(request, client, _owner_email(db, empresa_id))
    row = _billing_row(db, empresa_id)
    existing_subscription_id = str(row.get("asaas_subscription_id") or "").strip()

    if existing_subscription_id:
        existing_payment = _current_payment_from_subscription(client, existing_subscription_id, attempts=2)
        existing_payment_status = str((existing_payment or {}).get("status") or "").upper()
        existing_type = str(
            row.get("asaas_billing_type")
            or (existing_payment or {}).get("billingType")
            or ""
        ).upper()
        same_plan = normalize_plan(row.get("billing_plan_pending")) == plan
        same_type = not existing_type or existing_type == billing_type
        current_billing_status = str(row.get("billing_status") or "").lower()

        if same_plan and _has_unexpired_paid_access(emp):
            return {
                "ok": True, "already_active": True,
                "message": "Sua assinatura já está ativa e será renovada automaticamente a cada pagamento mensal.",
                "empresa_id": empresa_id, "plan": plan, "plan_name": _plan_name(plan),
                "billing_type": existing_type or billing_type,
                "subscription_id": existing_subscription_id,
                "payment": existing_payment,
                "webhook": {k: webhook_info.get(k) for k in ("configured", "created", "id", "url")},
            }

        reusable_statuses = {"pending", "past_due", "created", "customer_created", "active", "refused"}
        if (
            same_plan
            and same_type
            and existing_payment
            and not _payment_is_paid(existing_payment)
            and current_billing_status in reusable_statuses
        ):
            payment_id = str((existing_payment or {}).get("id") or "").strip() or None
            _update_billing_fields(
                db, empresa_id,
                asaas_last_payment_id=payment_id,
                asaas_billing_type=existing_type or billing_type,
            )
            db.commit()
            extras = _payment_extras(client, existing_type or billing_type, payment_id)
            return {
                "ok": True, "reused": True,
                "message": "A cobrança pendente foi recuperada. Pague esta cobrança para liberar o plano.",
                "empresa_id": empresa_id, "plan": plan, "plan_name": _plan_name(plan),
                "amount": _plan_amount(plan), "billing_type": existing_type or billing_type,
                "subscription_id": existing_subscription_id, "payment": existing_payment,
                "webhook": {k: webhook_info.get(k) for k in ("configured", "created", "id", "url")},
                **extras,
            }

        try:
            client.delete_subscription(existing_subscription_id)
        except AsaasAPIError as exc:
            raise HTTPException(
                status_code=502,
                detail={
                    "message": "Não foi possível cancelar a assinatura anterior. A nova cobrança não foi criada para evitar cobrança duplicada.",
                    "asaas_status": exc.status_code, "asaas_payload": exc.payload,
                },
            )

        _update_billing_fields(
            db, empresa_id,
            asaas_subscription_id=None,
            asaas_last_payment_id=None,
            asaas_billing_type=None,
            billing_status="cancelled",
        )
        db.flush()

    customer_id = _ensure_asaas_customer(db, emp, client)
    amount = _plan_amount(plan)
    external_ref = f"zapschat:empresa:{empresa_id}:plano:{plan}"

    recovered_subscription = _find_active_subscription(
        client,
        customer_id=customer_id,
        external_reference=external_ref,
    )
    if recovered_subscription:
        recovered_id = str(recovered_subscription.get("id") or "").strip()
        payments = _subscription_payments(client, recovered_id) if recovered_id else []
        latest_paid = _latest_paid_payment(payments)
        open_payment = _oldest_open_payment(payments)
        display_payment = open_payment or latest_paid or (payments[0] if payments else None)
        display_payment_id = str((display_payment or {}).get("id") or "").strip() or None
        recovered_type = str(
            recovered_subscription.get("billingType")
            or (display_payment or {}).get("billingType")
            or billing_type
        ).upper()
        credited = False
        if latest_paid:
            paid_id = str(latest_paid.get("id") or "").strip() or None
            paid_status = str(latest_paid.get("status") or "").strip().upper()
            credited, _ = _activate_payment_once(
                db, emp, plan, paid_id, recovered_id, paid_status,
                f"recover:{paid_id}:{paid_status}",
            )
            db.add(emp)
        recovered_status = "active" if _has_unexpired_paid_access(emp) else "pending"
        _update_billing_fields(
            db, empresa_id,
            billing_provider="asaas",
            billing_status=recovered_status,
            billing_plan_pending=plan,
            asaas_customer_id=customer_id,
            asaas_subscription_id=recovered_id,
            asaas_last_payment_id=display_payment_id,
            asaas_billing_type=recovered_type,
        )
        db.commit()
        extras = _payment_extras(client, recovered_type, display_payment_id)
        return {
            "ok": True,
            "recovered": True,
            "credited": credited,
            "message": (
                "Pagamento confirmado e plano liberado."
                if credited
                else "A assinatura existente foi recuperada. Pague a cobrança para liberar o plano."
            ),
            "empresa_id": empresa_id,
            "plan": plan,
            "plan_name": _plan_name(plan),
            "amount": amount,
            "billing_type": recovered_type,
            "subscription_id": recovered_id,
            "payment": display_payment,
            "subscription": recovered_subscription,
            "webhook": {k: webhook_info.get(k) for k in ("configured", "created", "id", "url")},
            **extras,
        }

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
    except AsaasAPIError as exc:
        db.rollback()
        raise HTTPException(
            status_code=400 if exc.status_code < 500 else 502,
            detail={"message": str(exc), "asaas_status": exc.status_code, "asaas_payload": exc.payload},
        )

    subscription_id = str(subscription.get("id") or "").strip()
    if not subscription_id:
        db.rollback()
        raise HTTPException(status_code=502, detail="Asaas não retornou ID da assinatura.")

    first_payment = _current_payment_from_subscription(client, subscription_id, attempts=4)
    payment_id = str((first_payment or {}).get("id") or "").strip() or None
    payment_status = str((first_payment or {}).get("status") or "").strip().upper()

    _update_billing_fields(
        db, empresa_id,
        billing_provider="asaas",
        billing_status="pending",
        billing_plan_pending=plan,
        asaas_customer_id=customer_id,
        asaas_subscription_id=subscription_id,
        asaas_last_payment_id=payment_id,
        asaas_billing_type=billing_type,
    )

    credited = False
    if first_payment and payment_status in PAID_STATUSES:
        db.refresh(emp)
        credited, _ = _activate_payment_once(
            db, emp, plan, payment_id, subscription_id, payment_status, f"subscribe:{payment_id}:{payment_status}"
        )
        db.add(emp)
        _update_billing_fields(db, empresa_id, billing_status="active")

    db.commit()
    extras = _payment_extras(client, billing_type, payment_id)

    return {
        "ok": True,
        "message": "Pagamento confirmado e plano liberado." if credited else "Assinatura criada. Após o pagamento, o plano será liberado automaticamente.",
        "empresa_id": empresa_id, "plan": plan, "plan_name": _plan_name(plan),
        "amount": amount, "billing_type": billing_type, "customer_id": customer_id,
        "subscription_id": subscription_id, "payment": first_payment, "subscription": subscription,
        "credited": credited,
        "webhook": {k: webhook_info.get(k) for k in ("configured", "created", "id", "url")},
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

    billing_type = str(payment.get("billingType") or "").strip().upper() or None

    if emp and plan and event in PAID_EVENTS:
        credited, new_exp = _activate_payment_once(
            db, emp, plan, payment_id, subscription_id, status, event_id
        )
        db.add(emp)
        existing_row = _billing_row(db, int(emp.id))
        _update_billing_fields(
            db, int(emp.id),
            billing_provider="asaas",
            billing_status="active",
            billing_plan_pending=plan,
            asaas_last_payment_id=payment_id,
            asaas_subscription_id=subscription_id or existing_row.get("asaas_subscription_id"),
            asaas_billing_type=billing_type or existing_row.get("asaas_billing_type"),
        )
        db.commit()
        return {
            "ok": True,
            "processed": "plan_activated" if credited else "payment_already_credited",
            "credited": credited,
            "empresa_id": int(emp.id),
            "plan": plan,
            "plano_expira_em": _to_iso(new_exp),
        }

    if emp and event in OVERDUE_EVENTS:
        existing_row = _billing_row(db, int(emp.id))
        _update_billing_fields(
            db, int(emp.id),
            billing_provider="asaas",
            billing_status="past_due",
            asaas_last_payment_id=payment_id,
            asaas_subscription_id=subscription_id or existing_row.get("asaas_subscription_id"),
            asaas_billing_type=billing_type or existing_row.get("asaas_billing_type"),
        )
        db.commit()
        return {"ok": True, "processed": "payment_overdue", "empresa_id": int(emp.id)}

    if emp and event in PENDING_EVENTS:
        existing_row = _billing_row(db, int(emp.id))
        next_status = "active" if _has_unexpired_paid_access(emp) else "pending"
        _update_billing_fields(
            db, int(emp.id),
            billing_provider="asaas",
            billing_status=next_status,
            asaas_last_payment_id=payment_id,
            asaas_subscription_id=subscription_id or existing_row.get("asaas_subscription_id"),
            asaas_billing_type=billing_type or existing_row.get("asaas_billing_type"),
        )
        db.commit()
        return {"ok": True, "processed": "payment_pending", "empresa_id": int(emp.id)}

    if emp and event in REFUSED_EVENTS:
        existing_row = _billing_row(db, int(emp.id))
        _update_billing_fields(
            db, int(emp.id),
            billing_provider="asaas",
            billing_status="refused",
            asaas_last_payment_id=payment_id,
            asaas_subscription_id=subscription_id or existing_row.get("asaas_subscription_id"),
            asaas_billing_type=billing_type or existing_row.get("asaas_billing_type"),
        )
        db.commit()
        return {"ok": True, "processed": "payment_refused", "empresa_id": int(emp.id)}

    if emp and event in REVERSAL_EVENTS:
        reversed_credit = _reverse_payment_credit(db, emp, payment_id, event_id)
        db.add(emp)
        existing_row = _billing_row(db, int(emp.id))
        _update_billing_fields(
            db, int(emp.id),
            billing_provider="asaas",
            billing_status="attention",
            asaas_last_payment_id=payment_id,
            asaas_subscription_id=subscription_id or existing_row.get("asaas_subscription_id"),
            asaas_billing_type=billing_type or existing_row.get("asaas_billing_type"),
        )
        db.commit()
        return {
            "ok": True, "processed": "payment_reversed",
            "reversed_credit": reversed_credit, "empresa_id": int(emp.id),
            "plano_expira_em": _to_iso(getattr(emp, "plano_expira_em", None)),
        }

    if emp and event in ATTENTION_EVENTS:
        existing_row = _billing_row(db, int(emp.id))
        _update_billing_fields(
            db, int(emp.id),
            billing_provider="asaas",
            billing_status="attention",
            asaas_last_payment_id=payment_id,
            asaas_subscription_id=subscription_id or existing_row.get("asaas_subscription_id"),
            asaas_billing_type=billing_type or existing_row.get("asaas_billing_type"),
        )
        db.commit()
        return {"ok": True, "processed": "payment_attention", "empresa_id": int(emp.id)}

    db.commit()

    return {
        "ok": True,
        "processed": "ignored",
        "event": event,
        "payment_id": payment_id,
        "subscription_id": subscription_id,
        "empresa_id": empresa_id,
    }