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


def _safe_rollback(db: Session) -> None:
    try:
        db.rollback()
    except Exception:
        pass


def _to_int(v) -> int | None:
    try:
        if v is None:
            return None

        s = str(v).strip()
        if not s:
            return None

        return int(s)
    except Exception:
        return None


def _clean_str(raw: str | None) -> str | None:
    s = str(raw or "").strip()
    if not s:
        return None

    if s.lower() in {"null", "undefined", "nan", "none"}:
        return None

    return s


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

    Evita variante fraca só com número local (8/9 dígitos),
    porque isso pode misturar contatos diferentes.
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


def _cliente_id_exists(
    db: Session,
    *,
    empresa_id: int | None = None,
    cliente_id: int | None,
) -> bool:
    cid = _to_int(cliente_id)
    if cid is None:
        return False

    try:
        q = db.query(models.Cliente.id).filter(models.Cliente.id == int(cid))

        if empresa_id is not None:
            q = q.filter(models.Cliente.empresa_id == int(empresa_id))

        row = q.first()
        return bool(row and row[0] is not None)

    except Exception:
        return False


def _return_valid_cliente_id(
    db: Session,
    *,
    empresa_id: int,
    cliente_id: int | None,
    telefone_raw: str | None = None,
) -> int | None:
    """
    Nunca devolve cliente_id fantasma.

    Se o ID existe na empresa, retorna.
    Se não existe, tenta achar pelo telefone.
    """
    cid = _to_int(cliente_id)

    if cid is not None and _cliente_id_exists(
        db,
        empresa_id=int(empresa_id),
        cliente_id=int(cid),
    ):
        return int(cid)

    if telefone_raw:
        found = find_cliente_id_by_phone(
            db,
            empresa_id=int(empresa_id),
            telefone_raw=telefone_raw,
        )
        if found and _cliente_id_exists(
            db,
            empresa_id=int(empresa_id),
            cliente_id=int(found),
        ):
            return int(found)

    return None


UPSERT_CLIENTE_SQL = text(
    """
    INSERT INTO public.clientes
        (empresa_id, instancia_id, telefone, nome, nome_whatsapp, avatar_url)
    VALUES
        (:empresa_id, :instancia_id, :telefone, :nome, :nome_whatsapp, :avatar_url)
    ON CONFLICT (empresa_id, telefone_norm) DO UPDATE
    SET
        /*
          Instância:
          - só preenche se ainda estiver vazia.
          - não fica trocando cliente de instância automaticamente.
        */
        instancia_id = COALESCE(public.clientes.instancia_id, EXCLUDED.instancia_id),

        /*
          Telefone:
          - mantém o telefone atual se já existir.
          - preenche apenas se estiver vazio.
        */
        telefone = CASE
            WHEN COALESCE(BTRIM(public.clientes.telefone), '') = ''
                THEN EXCLUDED.telefone
            ELSE public.clientes.telefone
        END,

        /*
          REGRA OFICIAL DO NOME:
          - Cliente novo nasce com pushName/nome da Evolution.
          - Cliente existente NÃO tem nome sobrescrito por pushName novo.
          - Só preenche nome se estiver vazio ou com placeholder.
          - Se alguém editou no painel, esse valor fica preservado.
        */
        nome = CASE
            WHEN
                COALESCE(BTRIM(EXCLUDED.nome), '') <> ''
                AND (
                    COALESCE(BTRIM(public.clientes.nome), '') = ''
                    OR LOWER(BTRIM(public.clientes.nome)) IN (
                        'cliente',
                        'contato',
                        'sem nome',
                        'desconhecido'
                    )
                    OR (
                        regexp_replace(COALESCE(public.clientes.nome, ''), '\\D', '', 'g') <> ''
                        AND regexp_replace(COALESCE(public.clientes.nome, ''), '\\D', '', 'g')
                            = regexp_replace(COALESCE(public.clientes.telefone, ''), '\\D', '', 'g')
                    )
                )
                THEN EXCLUDED.nome
            ELSE public.clientes.nome
        END,

        /*
          nome_whatsapp:
          - guarda o primeiro nome vindo da Evolution.
          - não fica trocando a cada mensagem.
          - só preenche se estiver vazio ou placeholder.
        */
        nome_whatsapp = CASE
            WHEN
                COALESCE(BTRIM(EXCLUDED.nome_whatsapp), '') <> ''
                AND (
                    COALESCE(BTRIM(public.clientes.nome_whatsapp), '') = ''
                    OR LOWER(BTRIM(public.clientes.nome_whatsapp)) IN (
                        'cliente',
                        'contato',
                        'sem nome',
                        'desconhecido'
                    )
                )
                THEN EXCLUDED.nome_whatsapp
            ELSE public.clientes.nome_whatsapp
        END,

        /*
          Avatar:
          - evita trocar avatar toda hora.
          - só preenche se ainda não existir.
        */
        avatar_url = CASE
            WHEN
                COALESCE(BTRIM(public.clientes.avatar_url), '') = ''
                AND COALESCE(BTRIM(EXCLUDED.avatar_url), '') <> ''
                THEN EXCLUDED.avatar_url
            ELSE public.clientes.avatar_url
        END
    RETURNING id
    """
)


def get_cliente_by_id(
    db: Session,
    cliente_id: int | None,
    *,
    empresa_id: int | None = None,
) -> models.Cliente | None:
    cid = _to_int(cliente_id)
    if cid is None:
        return None

    try:
        q = db.query(models.Cliente).filter(models.Cliente.id == int(cid))

        if empresa_id is not None:
            q = q.filter(models.Cliente.empresa_id == int(empresa_id))

        return q.first()

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
            .order_by(models.Cliente.id.desc())
            .first()
        )

        if row and row[0]:
            cid = int(row[0])
            if _cliente_id_exists(db, empresa_id=int(empresa_id), cliente_id=cid):
                return cid

    except Exception:
        pass

    try:
        row = (
            db.query(models.Cliente.id)
            .filter(
                models.Cliente.empresa_id == int(empresa_id),
                func.regexp_replace(
                    func.coalesce(models.Cliente.telefone, ""),
                    r"\D",
                    "",
                    "g",
                ).in_(variants),
            )
            .order_by(models.Cliente.id.desc())
            .first()
        )

        if row and row[0]:
            cid = int(row[0])
            if _cliente_id_exists(db, empresa_id=int(empresa_id), cliente_id=cid):
                return cid

    except Exception:
        pass

    return None


def _create_cliente_orm_fallback(
    db: Session,
    *,
    empresa_id: int,
    instancia_id: int | None,
    telefone_raw: str | None,
    telefone_fmt: str,
    telefone_norm: str,
    nome_final: str,
    nome_wa_final: str,
    avatar_clean: str | None,
) -> int | None:
    """
    Última tentativa se o UPSERT SQL não retornar ID.

    Importante:
    - Primeiro procura de novo pelo telefone.
    - Depois cria via ORM.
    - Se der corrida/unique, dá rollback e procura de novo.
    """
    found = find_cliente_id_by_phone(
        db,
        empresa_id=int(empresa_id),
        telefone_raw=telefone_raw or telefone_norm,
    )
    if found:
        return found

    try:
        cli = models.Cliente(
            empresa_id=int(empresa_id),
            telefone=telefone_fmt,
            nome=nome_final,
            nome_whatsapp=nome_wa_final,
            avatar_url=avatar_clean,
            instancia_id=(int(instancia_id) if instancia_id is not None else None),
        )

        if hasattr(cli, "telefone_norm"):
            try:
                setattr(cli, "telefone_norm", telefone_norm)
            except Exception:
                pass

        db.add(cli)
        db.flush()

        cid = _to_int(getattr(cli, "id", None))
        if cid is not None and _cliente_id_exists(
            db,
            empresa_id=int(empresa_id),
            cliente_id=int(cid),
        ):
            return int(cid)

    except Exception:
        _safe_rollback(db)

        found = find_cliente_id_by_phone(
            db,
            empresa_id=int(empresa_id),
            telefone_raw=telefone_raw or telefone_norm,
        )
        if found:
            return found

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

    REGRA OFICIAL:
    - Cliente novo:
        usa pushName/nome recebido da Evolution uma única vez.

    - Cliente existente:
        NÃO sobrescreve clientes.nome com pushName novo.
        NÃO sobrescreve clientes.nome_whatsapp se já existir.
        Só preenche nome/nome_whatsapp se estiver vazio ou placeholder.

    Segurança:
    - Nunca retorna cliente_id fantasma.
    - Se o INSERT/UPSERT falhar, tenta recuperar pelo telefone.
    - Se não recuperar, tenta criar por ORM como fallback.
    """
    empresa_id_i = int(empresa_id)
    instancia_id_i = int(instancia_id) if instancia_id is not None else None

    tel_norm = _telefone_norm(telefone_raw)
    if not tel_norm:
        return None

    telefone_fmt = _format_telefone_br(telefone_raw or tel_norm) or f"+55 {tel_norm}"

    nome_clean = _clean_str(nome)
    nome_wa_clean = _clean_str(nome_whatsapp)

    nome_final = (
        nome_clean
        or nome_wa_clean
        or telefone_fmt
        or "Cliente"
    )

    nome_wa_final = (
        nome_wa_clean
        or nome_clean
        or telefone_fmt
        or "Cliente"
    )

    avatar_clean = _clean_str(avatar_url)

    # 1) UPSERT SQL principal
    try:
        row = db.execute(
            UPSERT_CLIENTE_SQL,
            {
                "empresa_id": empresa_id_i,
                "instancia_id": instancia_id_i,
                "telefone": telefone_fmt,
                "nome": nome_final,
                "nome_whatsapp": nome_wa_final,
                "avatar_url": avatar_clean,
            },
        ).first()

        if row and row[0]:
            valid = _return_valid_cliente_id(
                db,
                empresa_id=empresa_id_i,
                cliente_id=int(row[0]),
                telefone_raw=telefone_raw or tel_norm,
            )
            if valid:
                return int(valid)

    except Exception:
        _safe_rollback(db)

    # 2) Fallback por telefone
    found = find_cliente_id_by_phone(
        db,
        empresa_id=empresa_id_i,
        telefone_raw=telefone_raw or tel_norm,
    )
    if found:
        valid = _return_valid_cliente_id(
            db,
            empresa_id=empresa_id_i,
            cliente_id=found,
            telefone_raw=telefone_raw or tel_norm,
        )
        if valid:
            return int(valid)

    # 3) Último fallback via ORM
    return _create_cliente_orm_fallback(
        db,
        empresa_id=empresa_id_i,
        instancia_id=instancia_id_i,
        telefone_raw=telefone_raw or tel_norm,
        telefone_fmt=telefone_fmt,
        telefone_norm=tel_norm,
        nome_final=nome_final,
        nome_wa_final=nome_wa_final,
        avatar_clean=avatar_clean,
    )


__all__ = [
    "get_cliente_by_id",
    "find_cliente_id_by_phone",
    "upsert_cliente_repo",
]