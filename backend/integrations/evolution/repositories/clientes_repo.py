# backend/integrations/evolution/repositories/clientes_repo.py
from __future__ import annotations

from sqlalchemy import func, text
from sqlalchemy.orm import Session

from backend import models
from ..utils.phone_utils import (
    formatar_telefone_br,
    normalize_phone_for_db,
    normalize_phone_for_send,
    phone_lookup_variants,
)


def _telefone_norm(raw: str | None) -> str | None:
    return normalize_phone_for_db(raw)


def _format_telefone_br(raw: str | None) -> str:
    """
    Campo telefone legível para UI/compat.
    Preferimos sempre formatar a versão de envio (+55...).
    """
    send_e164 = normalize_phone_for_send(raw)
    return formatar_telefone_br(send_e164 or raw)


def _lookup_variants_strong(raw: str | None) -> list[str]:
    """
    Variantes fortes apenas:
    - com DDD
    - com/sem 55
    - com/sem 9
    Evita variante fraca só com número local (8/9 dígitos).
    """
    out: list[str] = []

    for v in phone_lookup_variants(raw):
        s = str(v or "").strip()
        if not s:
            continue
        if len(s) < 10:
            continue
        if s not in out:
            out.append(s)

    return out


UPSERT_CLIENTE_SQL = text(
    """
    INSERT INTO public.clientes
        (empresa_id, instancia_id, telefone, nome, nome_whatsapp, avatar_url)
    VALUES
        (:empresa_id, :instancia_id, :telefone, :nome, :nome_whatsapp, :avatar_url)
    ON CONFLICT (empresa_id, telefone_norm) DO UPDATE
    SET
        instancia_id = COALESCE(public.clientes.instancia_id, EXCLUDED.instancia_id),
        nome_whatsapp = CASE
            WHEN COALESCE(public.clientes.nome_whatsapp, '') = '' THEN EXCLUDED.nome_whatsapp
            ELSE public.clientes.nome_whatsapp
        END,
        nome = CASE
            WHEN COALESCE(public.clientes.nome, '') = '' THEN EXCLUDED.nome
            ELSE public.clientes.nome
        END,
        avatar_url = COALESCE(EXCLUDED.avatar_url, public.clientes.avatar_url)
    RETURNING id
    """
)


def get_cliente_by_id(db: Session, cliente_id: int | None) -> models.Cliente | None:
    if not cliente_id:
        return None

    try:
        return db.query(models.Cliente).filter(models.Cliente.id == int(cliente_id)).first()
    except Exception:
        return None


def find_cliente_id_by_phone(
    db: Session,
    *,
    empresa_id: int,
    telefone_raw: str | None,
) -> int | None:
    variants = _lookup_variants_strong(telefone_raw)
    if not variants:
        return None

    try:
        row = (
            db.query(models.Cliente.id)
            .filter(
                models.Cliente.empresa_id == int(empresa_id),
                models.Cliente.telefone_norm.in_(variants),
            )
            .first()
        )
        if row and row[0]:
            return int(row[0])
    except Exception:
        pass

    try:
        row = (
            db.query(models.Cliente.id)
            .filter(
                models.Cliente.empresa_id == int(empresa_id),
                func.regexp_replace(func.coalesce(models.Cliente.telefone, ""), r"\D", "", "g").in_(variants),
            )
            .first()
        )
        if row and row[0]:
            return int(row[0])
    except Exception:
        pass

    return None


def upsert_cliente_repo(
    db: Session,
    *,
    empresa_id: int,
    instancia_id: int | None,
    telefone_raw: str | None,
    nome: str | None = None,
    nome_whatsapp: str | None = None,
    avatar_url: str | None = None,
) -> int | None:
    """
    UPSERT robusto por telefone_norm canônico.
    Importante:
    - sempre usa normalização única
    - sempre dá rollback controlado se o insert falhar
    - sempre tenta reconsultar o cliente depois
    """
    tel_norm = _telefone_norm(telefone_raw)
    if not tel_norm:
        return None

    telefone_fmt = _format_telefone_br(telefone_raw or tel_norm) or f"+55 {tel_norm}"
    nome_final = (nome or nome_whatsapp or telefone_fmt or "Cliente").strip()
    nome_wa_final = (nome_whatsapp or nome or telefone_fmt or "Cliente").strip()

    try:
        row = db.execute(
            UPSERT_CLIENTE_SQL,
            {
                "empresa_id": int(empresa_id),
                "instancia_id": int(instancia_id) if instancia_id is not None else None,
                "telefone": telefone_fmt,
                "nome": nome_final,
                "nome_whatsapp": nome_wa_final,
                "avatar_url": avatar_url,
            },
        ).first()

        if row and row[0]:
            return int(row[0])

    except Exception:
        try:
            db.rollback()
        except Exception:
            pass

    return find_cliente_id_by_phone(
        db,
        empresa_id=int(empresa_id),
        telefone_raw=telefone_raw,
    )


__all__ = [
    "get_cliente_by_id",
    "find_cliente_id_by_phone",
    "upsert_cliente_repo",
]