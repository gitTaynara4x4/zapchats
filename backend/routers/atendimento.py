# backend/routers/atendimento.py
from __future__ import annotations

import os
import re
import json
import asyncio
from typing import Optional, Dict, List, Tuple, Any, Iterable
from datetime import datetime

from dateutil import parser
from fastapi import APIRouter, Depends, HTTPException, Query, Body, Header
from sqlalchemy import func, text
from sqlalchemy.orm import Session
from pydantic import BaseModel

from backend import models
from backend.database import get_db
from backend.websocket_manager import conexoes_ativas
from backend.routers.auth import get_current_identity

REDIS_URL = os.getenv("REDIS_URL")
REDIS_PREFIX = os.getenv("REDIS_PREFIX", "zap")
REDIS_TTL_S = int(os.getenv("REDIS_TTL_SECONDS", "120"))

# Bump para não servir cache antigo.
# IMPORTANTE:
# A versão fica depois de emp no cache_key para permitir limpar com:
# _cache_del_pattern(_k("conv", "list", "emp", str(empresa_id)))
LIST_CACHE_VERSION = "nome-oficial-v15-unread-badge"

_redis = None
if REDIS_URL:
    try:
        import redis
        _redis = redis.Redis.from_url(REDIS_URL, decode_responses=True)
    except Exception:
        _redis = None


def _k(*parts: str) -> str:
    return ":".join([REDIS_PREFIX, *[p for p in parts if p is not None and p != ""]])


def _cache_get_json(key: str):
    if not _redis:
        return None
    try:
        v = _redis.get(key)
        return json.loads(v) if v else None
    except Exception:
        return None


def _cache_set_json(key: str, obj, ttl: int = REDIS_TTL_S):
    if not _redis:
        return
    try:
        _redis.set(key, json.dumps(obj, ensure_ascii=False), ex=ttl)
    except Exception:
        pass


def _cache_del(*keys: str):
    if not _redis:
        return
    try:
        if keys:
            _redis.delete(*keys)
    except Exception:
        pass


def _cache_del_pattern(prefix: str):
    if not _redis:
        return
    try:
        to_del = []
        for k in _redis.scan_iter(match=f"{prefix}*"):
            to_del.append(k)
            if len(to_del) >= 500:
                _redis.delete(*to_del)
                to_del = []
        if to_del:
            _redis.delete(*to_del)
    except Exception:
        pass


def _invalidate_conversas_cache(empresa_id: int) -> None:
    """
    Limpa todas as listas de conversa da empresa.
    Agora funciona com o cache_key no formato:
    zap:conv:list:emp:<empresa>:<versao>:...
    """
    _cache_del_pattern(_k("conv", "list", "emp", str(int(empresa_id))))


def _nome_oficial_cliente(c: models.Cliente | Any) -> str:
    """
    Regra oficial:
    - nome = nome do sistema / nome manual / nome congelado do cliente
    - nome_whatsapp = apenas fallback
    """
    nome = str(getattr(c, "nome", "") or "").strip()
    nome_whatsapp = str(getattr(c, "nome_whatsapp", "") or "").strip()

    if nome and nome.lower() not in {"null", "undefined", "nan"}:
        return nome

    if nome_whatsapp and nome_whatsapp.lower() not in {"null", "undefined", "nan"}:
        return nome_whatsapp

    return "Cliente"


def _k_pin(empresa_id: int) -> str:
    return _k("conv", "pin", "emp", str(int(empresa_id)))


def _k_pin_user(empresa_id: int, user_id: int, instancia_id: Optional[int] = None) -> str:
    if instancia_id is None:
        return _k("conv", "pin", "emp", str(int(empresa_id)), "user", str(int(user_id)))

    return _k(
        "conv",
        "pin",
        "emp",
        str(int(empresa_id)),
        "user",
        str(int(user_id)),
        "inst",
        str(int(instancia_id)),
    )


def _k_deleted(empresa_id: int) -> str:
    return _k("conv", "deleted", "emp", str(int(empresa_id)))


def _k_labels(empresa_id: int, cliente_id: int) -> str:
    return _k("conv", "labels", "emp", str(int(empresa_id)), "cli", str(int(cliente_id)))


def _ensure_list(x):
    return x if isinstance(x, list) else (list(x) if isinstance(x, (set, tuple)) else [])


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


def _conversation_key_cliente(cliente_id: int, instancia_id: Optional[int]) -> str:
    return f"c:{int(cliente_id)}:{int(instancia_id or 0)}"


def _parse_cliente_inst_from_item(item: dict) -> Tuple[Optional[int], Optional[int]]:
    """
    Extrai cliente_id e instancia_id de item normal ou item antigo do cache.
    Aceita:
    - cliente_id / instancia_id
    - conversation_key = c:<cliente_id>:<instancia_id>
    - id = c:<cliente_id>:<instancia_id>
    """
    cid = _to_int(
        item.get("cliente_id")
        or item.get("cliente_base_id")
        or item.get("backend_id")
        or item.get("api_id")
    )

    iid = _to_int(
        item.get("instancia_id")
        or item.get("instancia")
        or item.get("instance_id")
    )

    raw_key = (
        item.get("conversation_key")
        or item.get("conversation_id")
        or item.get("id")
        or ""
    )

    m = re.match(r"^c:(\d+):(\d+)$", str(raw_key or "").strip(), re.I)
    if m:
        if cid is None:
            cid = int(m.group(1))
        if iid is None:
            iid = int(m.group(2))

    return cid, iid


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


def _is_admin(user) -> bool:
    try:
        if isinstance(user, dict):
            if user.get("is_admin") or user.get("admin"):
                return True
            perms = user.get("permissoes") or user.get("permissions") or []
            cargo = str(user.get("cargo") or user.get("role") or "").lower().strip()
            if cargo in ("admin", "administrador", "owner", "dono"):
                return True
        else:
            if getattr(user, "is_admin", False):
                return True
            perms = getattr(user, "permissoes", None) or getattr(user, "permissions", None) or []

        if isinstance(perms, dict):
            perms = [k for k, v in perms.items() if v]

        perms = set(str(p).lower() for p in (perms or []))

        return any(
            p in perms
            for p in (
                "admin",
                "root",
                "clientes.gerenciar",
                "atendimento.gerenciar",
                "atendimento.apagar",
                "atendimento.apagar_conversas",
                "conversas.apagar",
            )
        )
    except Exception:
        return False


def _empresa_do_user(user) -> Optional[int]:
    if isinstance(user, dict):
        return user.get("empresa_id")

    emp = getattr(user, "empresa_id", None)
    if emp is not None:
        return emp

    empresa = getattr(user, "empresa", None)
    if empresa is not None:
        return getattr(empresa, "id", None)

    return None


def _assert_empresa_user(user, empresa_id: Optional[int] = None) -> int:
    emp = _empresa_do_user(user)

    if emp is None:
        raise HTTPException(status_code=401, detail="Empresa ausente na sessão")

    try:
        emp_real = int(emp)
    except Exception:
        raise HTTPException(status_code=401, detail="Empresa inválida na sessão")

    if empresa_id is not None:
        try:
            emp_request = int(empresa_id)
        except Exception:
            raise HTTPException(status_code=400, detail="empresa_id inválido")

        if emp_request != emp_real:
            raise HTTPException(status_code=403, detail="Empresa inválida para este usuário")

    return emp_real


def _ensure_perm(identity: dict, perm: str) -> None:
    perms = set(identity.get("permissoes") or [])
    if perm not in perms and not _is_admin(identity):
        raise HTTPException(status_code=403, detail=f"Sem permissão ({perm})")


def _public_avatar_url(cliente_id: int, raw_avatar_url: Optional[str]) -> Optional[str]:
    if not cliente_id:
        return None

    raw = (raw_avatar_url or "").strip()
    if not raw:
        return None

    if raw.startswith("/api/atendimento/avatar/"):
        return raw

    if raw.startswith("http://") or raw.startswith("https://"):
        return f"/api/atendimento/avatar/{int(cliente_id)}"

    return f"/api/atendimento/avatar/{int(cliente_id)}"


def _table_exists(db: Session, table_name: str) -> bool:
    try:
        name = str(table_name or "").strip()
        if not re.match(r"^[A-Za-z_][A-Za-z0-9_]*$", name):
            return False

        reg = db.execute(
            text("SELECT to_regclass(:table_name)"),
            {"table_name": f"public.{name}"},
        ).scalar()
        return reg is not None
    except Exception:
        try:
            db.rollback()
        except Exception:
            pass
        return False


def _safe_table_name(model_obj, fallback: str) -> str:
    try:
        name = str(getattr(model_obj, "__tablename__", None) or fallback).strip()
        if re.match(r"^[A-Za-z_][A-Za-z0-9_]*$", name):
            return name
    except Exception:
        pass
    return fallback


def _ensure_pin_table(db: Session) -> bool:
    try:
        if not hasattr(models, "AtendimentoPinnedConversa"):
            return False

        model = getattr(models, "AtendimentoPinnedConversa")
        table_name = _safe_table_name(model, "atendimento_pinned_conversas")

        db.execute(
            text(
                f"""
                CREATE TABLE IF NOT EXISTS {table_name} (
                    empresa_id INTEGER NOT NULL,
                    user_id INTEGER NOT NULL,
                    conversa_id INTEGER NOT NULL,
                    instancia_id INTEGER NOT NULL,
                    pinned_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
                    atendimento_id INTEGER NULL
                )
                """
            )
        )

        db.execute(text(f"ALTER TABLE {table_name} ADD COLUMN IF NOT EXISTS empresa_id INTEGER NOT NULL DEFAULT 0"))
        db.execute(text(f"ALTER TABLE {table_name} ADD COLUMN IF NOT EXISTS user_id INTEGER NOT NULL DEFAULT 0"))
        db.execute(text(f"ALTER TABLE {table_name} ADD COLUMN IF NOT EXISTS conversa_id INTEGER NOT NULL DEFAULT 0"))
        db.execute(text(f"ALTER TABLE {table_name} ADD COLUMN IF NOT EXISTS instancia_id INTEGER"))

        db.execute(
            text(
                f"""
                DELETE FROM {table_name}
                WHERE instancia_id IS NULL
                   OR instancia_id = 0
                """
            )
        )

        db.execute(text(f"ALTER TABLE {table_name} ALTER COLUMN instancia_id SET NOT NULL"))
        db.execute(text(f"ALTER TABLE {table_name} ADD COLUMN IF NOT EXISTS pinned_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()"))
        db.execute(text(f"ALTER TABLE {table_name} ADD COLUMN IF NOT EXISTS atendimento_id INTEGER NULL"))

        db.execute(text(f"ALTER TABLE {table_name} DROP CONSTRAINT IF EXISTS {table_name}_pkey"))
        db.execute(text(f"ALTER TABLE {table_name} DROP CONSTRAINT IF EXISTS pk_pinned_emp_user_conv"))
        db.execute(text(f"ALTER TABLE {table_name} DROP CONSTRAINT IF EXISTS uq_{table_name}_emp_user_conv"))

        db.execute(text(f"DROP INDEX IF EXISTS uq_{table_name}_emp_user_conv"))
        db.execute(text(f"DROP INDEX IF EXISTS uq_pinned_emp_user_conv_inst"))
        db.execute(text(f"DROP INDEX IF EXISTS ix_pinned_user_inst"))
        db.execute(text(f"DROP INDEX IF EXISTS ix_pinned_conv_inst"))

        db.execute(
            text(
                f"""
                ALTER TABLE {table_name}
                ADD CONSTRAINT {table_name}_pkey
                PRIMARY KEY (empresa_id, user_id, conversa_id, instancia_id)
                """
            )
        )

        db.execute(
            text(
                f"""
                CREATE UNIQUE INDEX IF NOT EXISTS uq_pinned_emp_user_conv_inst
                ON {table_name} (empresa_id, user_id, conversa_id, instancia_id)
                """
            )
        )

        db.execute(
            text(
                f"""
                CREATE INDEX IF NOT EXISTS ix_pinned_user_inst
                ON {table_name} (empresa_id, user_id, instancia_id)
                """
            )
        )

        db.execute(
            text(
                f"""
                CREATE INDEX IF NOT EXISTS ix_pinned_conv_inst
                ON {table_name} (empresa_id, conversa_id, instancia_id)
                """
            )
        )

        db.execute(
            text(
                f"""
                CREATE INDEX IF NOT EXISTS ix_{table_name}_atendimento_id
                ON {table_name} (atendimento_id)
                """
            )
        )

        db.commit()
        return True

    except Exception as e:
        try:
            db.rollback()
        except Exception:
            pass
        LOG("[PIN][ensure_table][ERRO]", repr(e))
        return False


def _ensure_labels_table(db: Session) -> bool:
    try:
        if not hasattr(models, "AtendimentoConversaLabel"):
            return False

        model = getattr(models, "AtendimentoConversaLabel")
        table_name = _safe_table_name(model, "atendimento_conversa_labels")

        if _table_exists(db, table_name):
            return True

        db.execute(
            text(
                f"""
                CREATE TABLE IF NOT EXISTS {table_name} (
                    id SERIAL PRIMARY KEY,
                    empresa_id INTEGER NOT NULL,
                    cliente_id INTEGER NOT NULL,
                    name VARCHAR(80) NOT NULL,
                    color_hex VARCHAR(16),
                    created_by INTEGER,
                    created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
                    CONSTRAINT uq_{table_name}_emp_cli_name UNIQUE (empresa_id, cliente_id, name)
                )
                """
            )
        )

        db.execute(
            text(
                f"""
                CREATE INDEX IF NOT EXISTS ix_{table_name}_empresa_cliente
                ON {table_name} (empresa_id, cliente_id)
                """
            )
        )

        db.commit()
        return True
    except Exception as e:
        try:
            db.rollback()
        except Exception:
            pass
        LOG("[LABELS][ensure_table][ERRO]", repr(e))
        return False


def _allowed_instancia_ids(db: Session, identity: dict, empresa_id: int) -> Optional[List[int]]:
    if _is_admin(identity):
        return None

    kind = _infer_kind(identity)
    if kind != "colaborador":
        return None

    if not _table_exists(db, "colaboradores_instancias"):
        return None

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


def _assert_instancia_allowed(
    *,
    allowed: Optional[List[int]],
    instancia_id: Optional[int],
) -> None:
    if instancia_id is None:
        return
    if allowed is None:
        return
    if int(instancia_id) not in set(int(x) for x in allowed):
        raise HTTPException(status_code=403, detail="Instância não permitida para este usuário")


def _assert_cliente_access_by_instancias(
    db: Session,
    *,
    empresa_id: int,
    cliente_id: int,
    allowed: Optional[List[int]],
) -> None:
    if allowed is None:
        return

    if not allowed:
        raise HTTPException(status_code=404, detail="Cliente não encontrado")

    ok = (
        db.query(models.Mensagem.id)
        .filter(
            models.Mensagem.empresa_id == int(empresa_id),
            models.Mensagem.cliente_id == int(cliente_id),
            models.Mensagem.instancia_id.in_([int(x) for x in allowed]),
        )
        .first()
    )

    if not ok:
        raise HTTPException(status_code=404, detail="Cliente não encontrado")


def _resolve_cliente_pk(db: Session, empresa_id: int, cliente_ref: int) -> Optional[int]:
    ref = _to_int(cliente_ref)
    if not ref:
        return None

    cliente = (
        db.query(models.Cliente)
        .filter(
            models.Cliente.empresa_id == int(empresa_id),
            models.Cliente.id == int(ref),
        )
        .first()
    )
    if cliente:
        return int(cliente.id)

    possible_attrs = (
        "api_id",
        "api_cliente_id",
        "apiClienteId",
        "conversa_id",
        "conversation_id",
        "evolution_id",
        "remote_id",
    )

    for attr_name in possible_attrs:
        col = getattr(models.Cliente, attr_name, None)
        if col is None:
            continue

        try:
            cliente = (
                db.query(models.Cliente)
                .filter(
                    models.Cliente.empresa_id == int(empresa_id),
                    col == int(ref),
                )
                .first()
            )
            if cliente:
                return int(cliente.id)
        except Exception:
            try:
                db.rollback()
            except Exception:
                pass

        try:
            cliente = (
                db.query(models.Cliente)
                .filter(
                    models.Cliente.empresa_id == int(empresa_id),
                    col == str(ref),
                )
                .first()
            )
            if cliente:
                return int(cliente.id)
        except Exception:
            try:
                db.rollback()
            except Exception:
                pass

    return None


def _has_model_pinned(db: Optional[Session] = None) -> bool:
    try:
        if not hasattr(models, "AtendimentoPinnedConversa"):
            return False

        if db is None:
            return True

        return _ensure_pin_table(db)
    except Exception:
        return False


def _pinned_set_db(
    db: Session,
    empresa_id: int,
    user_id: int,
    instancia_id: Optional[int] = None,
) -> set[int]:
    if not _has_model_pinned(db):
        return set()

    try:
        q = (
            db.query(models.AtendimentoPinnedConversa.conversa_id)
            .filter(
                models.AtendimentoPinnedConversa.empresa_id == int(empresa_id),
                models.AtendimentoPinnedConversa.user_id == int(user_id),
            )
        )

        if instancia_id is not None:
            q = q.filter(models.AtendimentoPinnedConversa.instancia_id == int(instancia_id))

        rows = q.all()

        return set(int(r[0]) for r in rows if r and r[0] is not None)

    except Exception as e:
        try:
            db.rollback()
        except Exception:
            pass
        LOG("[PIN][DB][ERRO]", repr(e))
        return set()


def _pins_get_cached(
    db: Session,
    empresa_id: int,
    user_id: int,
    instancia_id: Optional[int] = None,
) -> set[int]:
    c = _cache_get_json(_k_pin_user(empresa_id, user_id, instancia_id))

    if c is not None:
        try:
            return set(int(x) for x in c)
        except Exception:
            pass

    s = _pinned_set_db(db, empresa_id, user_id, instancia_id)
    _cache_set_json(_k_pin_user(empresa_id, user_id, instancia_id), sorted(s), ttl=30 * 24 * 3600)

    return s


def _pins_put_cached(
    empresa_id: int,
    user_id: int,
    s: set[int],
    instancia_id: Optional[int] = None,
):
    _cache_set_json(
        _k_pin_user(empresa_id, user_id, instancia_id),
        sorted(int(x) for x in s),
        ttl=30 * 24 * 3600,
    )


def _has_model_labels(db: Optional[Session] = None) -> bool:
    try:
        if not hasattr(models, "AtendimentoConversaLabel"):
            return False

        if db is None:
            return True

        return _ensure_labels_table(db)
    except Exception:
        return False


def _normalize_hex(c: Optional[str]) -> Optional[str]:
    if not c:
        return None

    c = str(c).strip()
    if not c:
        return None

    if not c.startswith("#"):
        c = "#" + c

    if len(c) == 4:
        c = "#" + "".join(ch * 2 for ch in c[1:])

    if not re.match(r"^#[0-9a-fA-F]{6}$", c):
        return None

    return c[:7].lower()


def _labels_db_list(db: Session, empresa_id: int, cliente_id: int) -> List[Dict[str, Optional[str]]]:
    if not _has_model_labels(db):
        return []

    try:
        rows = (
            db.query(models.AtendimentoConversaLabel)
            .filter(
                models.AtendimentoConversaLabel.empresa_id == int(empresa_id),
                models.AtendimentoConversaLabel.cliente_id == int(cliente_id),
            )
            .order_by(models.AtendimentoConversaLabel.name.asc())
            .all()
        )
        return [{"name": r.name, "color_hex": getattr(r, "color_hex", None)} for r in rows]
    except Exception as e:
        try:
            db.rollback()
        except Exception:
            pass
        LOG("[LABELS][DB_LIST][ERRO]", repr(e))
        return []


def _labels_db_upsert(
    db: Session,
    empresa_id: int,
    cliente_id: int,
    name: str,
    color_hex: Optional[str],
    created_by: Optional[int],
    *,
    commit: bool = True,
) -> None:
    if not _has_model_labels(db):
        return

    name = str(name or "").strip()
    if not name:
        return

    row = (
        db.query(models.AtendimentoConversaLabel)
        .filter(
            models.AtendimentoConversaLabel.empresa_id == int(empresa_id),
            models.AtendimentoConversaLabel.cliente_id == int(cliente_id),
            models.AtendimentoConversaLabel.name == name,
        )
        .first()
    )

    if row:
        row.color_hex = color_hex
    else:
        db.add(
            models.AtendimentoConversaLabel(
                empresa_id=int(empresa_id),
                cliente_id=int(cliente_id),
                name=name,
                color_hex=color_hex,
                created_by=int(created_by) if created_by is not None else None,
            )
        )

    if commit:
        db.commit()


def _labels_db_replace_all(
    db: Session,
    empresa_id: int,
    cliente_id: int,
    names: Iterable[str],
    created_by: Optional[int],
) -> None:
    if not _has_model_labels(db):
        return

    clean_names = []
    for n in names or []:
        if isinstance(n, str) and n.strip():
            clean_names.append(n.strip())

    q = db.query(models.AtendimentoConversaLabel).filter(
        models.AtendimentoConversaLabel.empresa_id == int(empresa_id),
        models.AtendimentoConversaLabel.cliente_id == int(cliente_id),
    )

    if clean_names:
        q.filter(~models.AtendimentoConversaLabel.name.in_(clean_names)).delete(synchronize_session=False)
    else:
        q.delete(synchronize_session=False)

    for n in clean_names:
        _labels_db_upsert(db, empresa_id, cliente_id, n, None, created_by, commit=False)

    db.commit()


def _extract_label_payload(body: "LabelsIn") -> Tuple[Optional[str], Optional[str]]:
    name = None
    color = None

    add = body.add

    if isinstance(add, dict):
        name = (
            add.get("name")
            or add.get("nome")
            or add.get("label")
            or add.get("title")
            or ""
        )
        color = (
            add.get("color_hex")
            or add.get("color")
            or add.get("hex")
            or body.color_hex
            or body.color
        )
    elif isinstance(add, str):
        name = add
        color = body.color_hex or body.color

    name = str(name or "").strip()
    color_hex = _normalize_hex(color)

    return (name or None), color_hex


router = APIRouter(prefix="", tags=["Atendimento"])


def LOG(*a):
    print("\033[92m[ATENDIMENTO]", *a, "\033[0m")


async def _broadcast(payload: dict, *, empresa_id: int | None = None, grupo: str | None = None):
    try:
        if grupo:
            await conexoes_ativas.send_message(grupo, payload)
            return
        if empresa_id is not None:
            await conexoes_ativas.send_message(f"emp:{int(empresa_id)}", payload)
            return
        for g in list(conexoes_ativas.grupos.keys()):
            await conexoes_ativas.send_message(g, payload)
    except Exception as e:
        print("[ATENDIMENTO][BROADCAST][ERRO]", e)


class BroadcastMensagem(BaseModel):
    empresa_id: int
    cliente_id: int
    mensagem: str
    tipo: str
    timestamp: str
    msg_id: str
    midia_url: Optional[str] = None
    mimetype: Optional[str] = None
    lida: bool = False
    midias: Optional[List[Dict]] = None
    instancia_id: Optional[int] = None
    instance_name: Optional[str] = None


def _parse_timestamp(val) -> str:
    if val is None:
        return datetime.utcnow().isoformat()
    try:
        if isinstance(val, (int, float)) or (isinstance(val, str) and str(val).isdigit()):
            dt = datetime.utcfromtimestamp(int(val))
            return dt.isoformat()
        if isinstance(val, str) and "T" not in val and " " in val:
            try:
                return parser.parse(val.replace(" ", "T")).isoformat()
            except Exception:
                pass
        return parser.parse(str(val)).isoformat()
    except Exception:
        return str(val)


INTERNAL_BROADCAST_KEY = os.getenv("INTERNAL_BROADCAST_KEY")


@router.post("/broadcast")
async def broadcast_msg(
    dados: dict,
    x_internal_key: Optional[str] = Header(None, alias="X-Internal-Key"),
    db: Session = Depends(get_db),
):
    if INTERNAL_BROADCAST_KEY:
        if not x_internal_key or x_internal_key != INTERNAL_BROADCAST_KEY:
            raise HTTPException(status_code=403, detail="Chave interna inválida para broadcast")

    mensagem = dados.get("mensagem") or dados.get("texto") or dados.get("message") or ""
    tipo = dados.get("tipo") or dados.get("direction") or ""

    is_ack_isolado = dados.get("ack") is not None and not mensagem and not tipo

    ts_bruto = dados.get("timestamp") or dados.get("hora") or dados.get("created_at") or dados.get("ts")
    ts_formatado = _parse_timestamp(ts_bruto)

    if is_ack_isolado:
        empresa_id = dados.get("empresa_id")
        msg_id = dados.get("msg_id")
        ack_raw = dados.get("ack")

        cliente_id = dados.get("cliente_id")

        if cliente_id is None and empresa_id and msg_id:
            try:
                row = (
                    db.query(models.Mensagem.cliente_id)
                    .filter(
                        models.Mensagem.empresa_id == int(empresa_id),
                        models.Mensagem.msg_id == str(msg_id),
                    )
                    .order_by(models.Mensagem.id.desc())
                    .first()
                )
                if row and row[0] is not None:
                    cliente_id = int(row[0])
            except Exception:
                pass

        try:
            new_ack: Optional[int] = None
            if ack_raw is not None:
                try:
                    new_ack = int(ack_raw)
                except Exception:
                    new_ack = None

            if new_ack is not None and new_ack > 0 and empresa_id and msg_id:
                (
                    db.query(models.Mensagem)
                    .filter(
                        models.Mensagem.empresa_id == int(empresa_id),
                        models.Mensagem.msg_id == str(msg_id),
                        models.Mensagem.tipo == "saida",
                    )
                    .filter(func.coalesce(models.Mensagem.ack, 0) < new_ack)
                    .update({"ack": new_ack}, synchronize_session=False)
                )
                db.commit()
        except Exception as e:
            try:
                db.rollback()
            except Exception:
                pass
            print("[BROADCAST][ACK-ONLY][DB-ERROR]", e)

        payload = {
            "type": "ack",
            "empresa_id": empresa_id,
            "msg_id": msg_id,
            "ack": ack_raw,
            "cliente_id": cliente_id,
            "timestamp": ts_formatado,
            "instancia_id": dados.get("instancia_id") or dados.get("instance_id"),
            "instance_name": dados.get("instance_name") or dados.get("instance"),
        }

    else:
        payload = {
            "empresa_id": dados.get("empresa_id"),
            "cliente_id": dados.get("cliente_id"),
            "mensagem": mensagem,
            "tipo": tipo,
            "timestamp": ts_formatado,
            "msg_id": dados.get("msg_id"),
            "ack": dados.get("ack"),
            "novo_cliente": dados.get("novo_cliente", False),
            "instancia_id": dados.get("instancia_id") or dados.get("instance_id"),
            "instance_name": dados.get("instance_name") or dados.get("instance"),
        }

        midias: List[Dict] = []

        if isinstance(dados.get("midias"), list) and dados["midias"]:
            for a in dados["midias"]:
                u = a.get("url") or a.get("url_api") or a.get("link") or a.get("path") or ""
                if not u and a.get("id"):
                    u = f"/api/atendimento/midias/{a['id']}"

                midias.append(
                    {
                        "tipo": (a.get("tipo") or a.get("type") or "").lower(),
                        "mimetype": (a.get("mimetype") or a.get("mime") or ""),
                        "filename": (a.get("filename") or a.get("name") or a.get("nome_original") or ""),
                        "url": u,
                    }
                )

        elif dados.get("midia_url"):
            mt = (dados.get("mimetype") or "").lower()

            def _guess_tipo(m: str) -> str:
                if m == "image/webp":
                    return "sticker"
                if m.startswith("image/"):
                    return "image"
                if m.startswith("video/"):
                    return "video"
                if m.startswith("audio/"):
                    return "audio"
                return "document"

            midias = [
                {
                    "tipo": _guess_tipo(mt),
                    "mimetype": mt or "",
                    "filename": dados.get("filename") or dados.get("name") or "",
                    "url": dados["midia_url"],
                }
            ]

        if midias:
            for m_item in midias:
                if isinstance(m_item.get("url"), str) and m_item["url"].isdigit():
                    m_item["url"] = f"/api/atendimento/midias/{m_item['url']}"
            payload["midias"] = midias

    await _broadcast(payload, empresa_id=dados.get("empresa_id"))

    emp_id = dados.get("empresa_id")
    if emp_id:
        _invalidate_conversas_cache(int(emp_id))
        _cache_del(_k("clientes", LIST_CACHE_VERSION, "emp", str(emp_id), "dep", ""))
        _cache_del(_k("clientes", "emp", str(emp_id), "dep", ""))

    return {"status": "ok"}


def _resolve_instancia_id(
    db: Session,
    *,
    empresa_id: int,
    instancia_id: Optional[int],
    instance: Optional[str],
) -> Tuple[Optional[int], Optional[str]]:
    if instancia_id is not None:
        row = (
            db.query(models.EmpresaInstancia)
            .filter(
                models.EmpresaInstancia.empresa_id == empresa_id,
                models.EmpresaInstancia.id == instancia_id,
            )
            .first()
        )
        if row:
            return row.id, row.instance_name
        return None, None

    if instance:
        row = (
            db.query(models.EmpresaInstancia)
            .filter(
                models.EmpresaInstancia.empresa_id == empresa_id,
                models.EmpresaInstancia.instance_name == instance,
            )
            .first()
        )
        if row:
            return row.id, row.instance_name
        return None, None

    return None, None


def _recalcular_unread_para_items_cache(
    db: Session,
    *,
    empresa_id: int,
    items: List[dict],
    resolved_inst_id: Optional[int],
    allowed: Optional[List[int]],
) -> None:
    """
    Mesmo quando a lista vem do Redis, o contador de não lidas precisa ser real.
    Foi isso que fazia a API devolver novas=0 com mensagens lida=false no banco.
    """
    m = models.Mensagem

    refs: List[Tuple[int, Optional[int]]] = []
    cliente_ids: set[int] = set()

    for it in items:
        cid, iid = _parse_cliente_inst_from_item(it)
        if cid is None:
            continue
        cliente_ids.add(int(cid))
        refs.append((int(cid), int(iid) if iid is not None else None))

    if not cliente_ids:
        for it in items:
            it["novas"] = 0
            it["unread"] = 0
            it["unread_count"] = 0
            it["nao_lidas"] = 0
        return

    q = (
        db.query(
            m.cliente_id,
            m.instancia_id,
            func.count(m.id),
        )
        .filter(
            m.empresa_id == int(empresa_id),
            m.cliente_id.in_([int(x) for x in cliente_ids]),
            m.tipo == "entrada",
            m.lida.isnot(True),
        )
    )

    if resolved_inst_id is not None:
        q = q.filter(m.instancia_id == int(resolved_inst_id))
    elif allowed is not None:
        if not allowed:
            for it in items:
                it["novas"] = 0
                it["unread"] = 0
                it["unread_count"] = 0
                it["nao_lidas"] = 0
            return
        q = q.filter(m.instancia_id.in_([int(x) for x in allowed]))

    unread_by_pair: Dict[Tuple[int, int], int] = {}
    unread_by_cliente: Dict[int, int] = {}

    for cid, iid, cnt in q.group_by(m.cliente_id, m.instancia_id).all():
        cid_i = int(cid)
        iid_i = int(iid or 0)
        cnt_i = int(cnt or 0)
        unread_by_pair[(cid_i, iid_i)] = cnt_i
        unread_by_cliente[cid_i] = unread_by_cliente.get(cid_i, 0) + cnt_i

    for it in items:
        cid, iid = _parse_cliente_inst_from_item(it)

        if cid is None:
            novas = 0
        elif iid is not None:
            novas = int(unread_by_pair.get((int(cid), int(iid)), 0))
        else:
            novas = int(unread_by_cliente.get(int(cid), 0))

        it["novas"] = novas
        it["unread"] = novas
        it["unread_count"] = novas
        it["nao_lidas"] = novas


# Rota GET /conversas removida deste router.
# Motivo: ela já existe em backend/routers/atendimento_conversas/listagem.py
# e é registrada no main.py com o mesmo prefixo /api/atendimento.
# Manter as duas criava duplicidade em GET /api/atendimento/conversas
# e confundia manutenção/debug do Atendimento.


@router.get("/clientes")
def listar_clientes(
    empresa_id: Optional[int] = Query(None),
    departamento: Optional[str] = None,
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
):
    empresa_id = _assert_empresa_user(identity, empresa_id)
    _ensure_perm(identity, "atendimento.ver")

    allowed = _allowed_instancia_ids(db, identity, empresa_id)

    LOG("[clientes] Listando clientes para empresa_id", empresa_id)

    cache_key = _k("clientes", LIST_CACHE_VERSION, "emp", str(empresa_id), "dep", str(departamento or ""))
    cached = _cache_get_json(cache_key)

    if cached:
        deleted_set = set(_cache_get_json(_k_deleted(empresa_id)) or [])
        if deleted_set:
            cached = [it for it in cached if int(it.get("id")) not in deleted_set]

        for it in cached:
            cid = int(it.get("id") or it.get("cliente_id") or 0)
            it["avatar_url"] = _public_avatar_url(cid, it.get("avatar_url"))

        return cached

    m = models.Mensagem

    subq_q = (
        db.query(
            m.cliente_id,
            func.max(m.timestamp).label("ultima_data"),
        )
        .filter(m.empresa_id == empresa_id)
    )

    if allowed is not None:
        if not allowed:
            _cache_set_json(cache_key, [])
            return []
        subq_q = subq_q.filter(m.instancia_id.in_([int(x) for x in allowed]))

    subq = subq_q.group_by(m.cliente_id).subquery()

    q = (
        db.query(models.Cliente)
        .outerjoin(subq, models.Cliente.id == subq.c.cliente_id)
        .filter(models.Cliente.empresa_id == empresa_id)
        .filter(subq.c.ultima_data.isnot(None))
    )

    if departamento:
        q = q.filter(models.Cliente.departamento == departamento)

    q = q.order_by(subq.c.ultima_data.desc().nullslast())

    deleted_set = set(_cache_get_json(_k_deleted(empresa_id)) or [])

    resultado = []

    for c in q.all():
        if int(c.id) in deleted_set:
            continue

        ultima_q = (
            db.query(m)
            .filter(
                m.cliente_id == c.id,
                m.empresa_id == empresa_id,
            )
        )

        if allowed is not None:
            ultima_q = ultima_q.filter(m.instancia_id.in_([int(x) for x in allowed]))

        ultima = ultima_q.order_by(m.timestamp.desc()).first()

        novas_q = (
            db.query(m)
            .filter(
                m.cliente_id == c.id,
                m.empresa_id == empresa_id,
                m.tipo == "entrada",
                m.lida.isnot(True),
            )
        )

        if allowed is not None:
            novas_q = novas_q.filter(m.instancia_id.in_([int(x) for x in allowed]))

        novas = int(novas_q.count())

        ultima_ts_ms = int(ultima.timestamp.timestamp() * 1000) if (ultima and ultima.timestamp) else None
        ultima_inst = int(getattr(ultima, "instancia_id", 0) or 0) if ultima else 0
        conv_key = _conversation_key_cliente(int(c.id), ultima_inst) if ultima_inst else str(c.id)

        resultado.append(
            {
                "id": conv_key,
                "conversation_id": conv_key,
                "conversation_key": conv_key,
                "cliente_id": int(c.id),
                "cliente_base_id": int(c.id),
                "nome": _nome_oficial_cliente(c),
                "nome_whatsapp": getattr(c, "nome_whatsapp", None),
                "telefone": c.telefone,
                "avatar_url": _public_avatar_url(int(c.id), getattr(c, "avatar_url", None)),
                "ultima_mensagem": (ultima.conteudo or "") if ultima else "",
                "hora": ultima_ts_ms,
                "last_ts": ultima_ts_ms,
                "novas": novas,
                "unread": novas,
                "unread_count": novas,
                "nao_lidas": novas,
                "last_tipo": ultima.tipo if ultima else None,
                "last_ack": int(getattr(ultima, "ack", 0)) if (ultima and ultima.tipo == "saida") else None,
                "instancia_id": ultima_inst or None,
                "is_group": False,
            }
        )

    LOG(f"[clientes] Retornando {len(resultado)} clientes.")

    _cache_set_json(cache_key, resultado)

    return resultado


@router.post("/clientes/{cliente_id}/seen")
async def marcar_lidas(
    cliente_id: int,
    empresa_id: Optional[int] = Query(None),
    instancia_id: Optional[int] = Query(None),
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
):
    """
    Marca mensagens de entrada como lidas.

    Importante:
    - Essa rota é chamada em segundo plano pelo front ao abrir a conversa.
    - Ela NÃO deve quebrar a tela se não conseguir resolver o cliente.
    - Se o cliente/conversa não existir para o usuário atual, retorna ok=True e marcadas=0.
    - Continua respeitando empresa, permissão e instâncias permitidas.
    """
    empresa_id = _assert_empresa_user(identity, empresa_id)
    _ensure_perm(identity, "atendimento.ver")

    cliente_pk = _resolve_cliente_pk(db, int(empresa_id), int(cliente_id))
    if not cliente_pk:
        return {
            "ok": True,
            "marcadas": 0,
            "cliente_id": int(cliente_id),
            "motivo": "cliente_nao_encontrado",
        }

    allowed = _allowed_instancia_ids(db, identity, empresa_id)

    if allowed is not None:
        allowed_set = {int(x) for x in allowed if x is not None}

        if not allowed_set:
            return {
                "ok": True,
                "marcadas": 0,
                "cliente_id": int(cliente_pk),
                "motivo": "sem_instancias_permitidas",
            }

        if instancia_id is not None:
            try:
                inst_req = int(instancia_id)
            except Exception:
                inst_req = None

            if inst_req is not None and inst_req not in allowed_set:
                return {
                    "ok": True,
                    "marcadas": 0,
                    "cliente_id": int(cliente_pk),
                    "instancia_id": inst_req,
                    "motivo": "instancia_nao_permitida",
                }

    q = (
        db.query(models.Mensagem)
        .filter(
            models.Mensagem.cliente_id == int(cliente_pk),
            models.Mensagem.empresa_id == int(empresa_id),
            models.Mensagem.tipo == "entrada",
            models.Mensagem.lida.isnot(True),
        )
    )

    if instancia_id is not None:
        try:
            q = q.filter(models.Mensagem.instancia_id == int(instancia_id))
        except Exception:
            pass
    elif allowed is not None:
        q = q.filter(models.Mensagem.instancia_id.in_([int(x) for x in allowed]))

    try:
        total = q.update({models.Mensagem.lida: True}, synchronize_session=False)
        db.commit()
    except Exception as e:
        try:
            db.rollback()
        except Exception:
            pass

        LOG("[/clientes/{cliente_id}/seen][ERRO]", repr(e))
        return {
            "ok": True,
            "marcadas": 0,
            "cliente_id": int(cliente_pk),
            "motivo": "erro_ao_marcar_lidas",
        }

    total_int = int(total or 0)

    if total_int > 0:
        _cache_del(_k("clientes", LIST_CACHE_VERSION, "emp", str(empresa_id), "dep", ""))
        _cache_del(_k("clientes", "emp", str(empresa_id), "dep", ""))
        _invalidate_conversas_cache(int(empresa_id))

        # IMPORTANTE - correção v10:
        # Marcar mensagem como lida não pode mandar reload_clientes global.
        # Esse evento estava derrubando/recarregando a tela inteira depois de mensagem recebida,
        # mesmo com WS_EMIT_MESSAGES=false. O front já consegue atualizar o estado localmente.
        if str(os.getenv("WS_EMIT_SEEN_RELOAD_CLIENTES", "false")).strip().lower() in {"1", "true", "yes", "on"}:
            try:
                await conexoes_ativas.send_message(
                    f"emp:{empresa_id}",
                    {
                        "type": "reload_clientes",
                        "cliente_id": int(cliente_pk),
                        "instancia_id": int(instancia_id) if instancia_id is not None else None,
                        "source": "seen",
                    },
                )
            except Exception:
                pass
        else:
            try:
                LOG(f"[/clientes/{{cliente_id}}/seen][ws-skip] reload_clientes desativado cliente_id={int(cliente_pk)}")
            except Exception:
                pass

    return {
        "ok": True,
        "marcadas": total_int,
        "cliente_id": int(cliente_pk),
        "instancia_id": int(instancia_id) if instancia_id is not None else None,
    }

@router.get("/conversas/pin")
def listar_pins(
    empresa_id: Optional[int] = Query(None),
    instancia_id: Optional[int] = Query(None),
    instance: Optional[str] = Query(None),
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
):
    empresa_id = _assert_empresa_user(identity, empresa_id)
    _ensure_perm(identity, "atendimento.ver")

    user_id = int(identity["id"])

    resolved_inst_id, _resolved_inst_name = _resolve_instancia_id(
        db,
        empresa_id=int(empresa_id),
        instancia_id=instancia_id,
        instance=instance,
    )

    if (instancia_id is not None or instance) and resolved_inst_id is None:
        raise HTTPException(status_code=404, detail="Instância não encontrada")

    if _has_model_pinned(db):
        pinned = _pins_get_cached(
            db,
            empresa_id=int(empresa_id),
            user_id=int(user_id),
            instancia_id=int(resolved_inst_id) if resolved_inst_id is not None else None,
        )
        return {"pinned": sorted(pinned)}

    pinned = _cache_get_json(_k_pin(empresa_id)) or []

    return {"pinned": _ensure_list(pinned)}


@router.post("/conversas/{cliente_id}/pin")
def fixar_conversa(
    cliente_id: int,
    empresa_id: Optional[int] = Query(None),
    instancia_id: Optional[int] = Query(None),
    instance: Optional[str] = Query(None),
    payload: dict = Body(...),
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
):
    empresa_id = _assert_empresa_user(identity, empresa_id)
    _ensure_perm(identity, "atendimento.ver")

    cliente_pk = _resolve_cliente_pk(db, int(empresa_id), int(cliente_id))
    if not cliente_pk:
        raise HTTPException(status_code=404, detail="Cliente/conversa não encontrado")

    if instancia_id is None and not instance:
        raw_inst_payload = payload.get("instancia_id") or payload.get("instancia")
        raw_instance_payload = payload.get("instance") or payload.get("instance_name")

        inst_payload_int = _to_int(raw_inst_payload)

        if inst_payload_int:
            instancia_id = inst_payload_int
        elif raw_instance_payload:
            instance = str(raw_instance_payload).strip()

    resolved_inst_id, _resolved_inst_name = _resolve_instancia_id(
        db,
        empresa_id=int(empresa_id),
        instancia_id=instancia_id,
        instance=instance,
    )

    if resolved_inst_id is None:
        raise HTTPException(
            status_code=400,
            detail="instancia_id é obrigatório para fixar conversa por instância",
        )

    allowed = _allowed_instancia_ids(db, identity, empresa_id)

    _assert_instancia_allowed(
        allowed=allowed,
        instancia_id=int(resolved_inst_id),
    )

    _assert_cliente_access_by_instancias(
        db,
        empresa_id=int(empresa_id),
        cliente_id=int(cliente_pk),
        allowed=allowed,
    )

    tem_msg_na_instancia = (
        db.query(models.Mensagem.id)
        .filter(
            models.Mensagem.empresa_id == int(empresa_id),
            models.Mensagem.cliente_id == int(cliente_pk),
            models.Mensagem.instancia_id == int(resolved_inst_id),
        )
        .first()
    )

    if not tem_msg_na_instancia:
        raise HTTPException(
            status_code=404,
            detail="Conversa não encontrada nesta instância",
        )

    if not _ensure_pin_table(db):
        raise HTTPException(status_code=500, detail="Tabela de fixados indisponível")

    model = getattr(models, "AtendimentoPinnedConversa")
    table_name = _safe_table_name(model, "atendimento_pinned_conversas")

    want_pin = bool(payload.get("pin", True))
    user_id = int(identity["id"])

    try:
        if want_pin:
            db.execute(
                text(
                    f"""
                    DELETE FROM {table_name}
                    WHERE empresa_id = :emp
                      AND user_id = :uid
                      AND conversa_id = :cid
                      AND instancia_id = :inst
                    """
                ),
                {
                    "emp": int(empresa_id),
                    "uid": int(user_id),
                    "cid": int(cliente_pk),
                    "inst": int(resolved_inst_id),
                },
            )

            db.execute(
                text(
                    f"""
                    INSERT INTO {table_name}
                        (empresa_id, user_id, conversa_id, instancia_id, pinned_at, atendimento_id)
                    VALUES
                        (:emp, :uid, :cid, :inst, NOW(), NULL)
                    """
                ),
                {
                    "emp": int(empresa_id),
                    "uid": int(user_id),
                    "cid": int(cliente_pk),
                    "inst": int(resolved_inst_id),
                },
            )

        else:
            db.execute(
                text(
                    f"""
                    DELETE FROM {table_name}
                    WHERE empresa_id = :emp
                      AND user_id = :uid
                      AND conversa_id = :cid
                      AND instancia_id = :inst
                    """
                ),
                {
                    "emp": int(empresa_id),
                    "uid": int(user_id),
                    "cid": int(cliente_pk),
                    "inst": int(resolved_inst_id),
                },
            )

        db.commit()

        s = _pins_get_cached(
            db,
            int(empresa_id),
            int(user_id),
            int(resolved_inst_id),
        )

        if want_pin:
            s.add(int(cliente_pk))
        else:
            s.discard(int(cliente_pk))

        _pins_put_cached(
            int(empresa_id),
            int(user_id),
            s,
            int(resolved_inst_id),
        )

        _cache_del(_k_pin(int(empresa_id)))
        _cache_del(_k_pin_user(int(empresa_id), int(user_id)))
        _cache_del(_k_pin_user(int(empresa_id), int(user_id), int(resolved_inst_id)))
        _invalidate_conversas_cache(int(empresa_id))

    except Exception as e:
        try:
            db.rollback()
        except Exception:
            pass

        LOG("[/conversas/{cliente_id}/pin][ERRO]", repr(e))
        raise HTTPException(
            status_code=500,
            detail=f"Falha ao fixar/desafixar conversa: {str(e)}",
        )

    try:
        loop = asyncio.get_running_loop()
        loop.create_task(
            _broadcast(
                {
                    "type": "conv.pin",
                    "cliente_id": int(cliente_pk),
                    "instancia_id": int(resolved_inst_id),
                    "pin": want_pin,
                    "user_id": int(user_id),
                },
                empresa_id=int(empresa_id),
            )
        )
    except Exception:
        pass

    return {
        "ok": True,
        "cliente_id": int(cliente_pk),
        "instancia_id": int(resolved_inst_id),
        "pinned": want_pin,
    }


@router.get("/conversas/deleted")
def listar_deletados(
    empresa_id: Optional[int] = Query(None),
    identity=Depends(get_current_identity),
):
    empresa_id = _assert_empresa_user(identity, empresa_id)
    _ensure_perm(identity, "atendimento.ver")

    deleted = _cache_get_json(_k_deleted(empresa_id)) or []

    return {"deleted": _ensure_list(deleted)}


@router.delete("/conversas/{cliente_id}")
def apagar_conversa(
    cliente_id: int,
    empresa_id: Optional[int] = Query(None),
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
):
    empresa_id = _assert_empresa_user(identity, empresa_id)
    _ensure_perm(identity, "atendimento.ver")

    if not _is_admin(identity):
        raise HTTPException(status_code=403, detail="Apenas administradores")

    cliente_pk = _resolve_cliente_pk(db, int(empresa_id), int(cliente_id))
    if not cliente_pk:
        raise HTTPException(status_code=404, detail="Cliente não encontrado")

    cliente = (
        db.query(models.Cliente)
        .filter(
            models.Cliente.id == int(cliente_pk),
            models.Cliente.empresa_id == int(empresa_id),
        )
        .first()
    )

    if not cliente:
        raise HTTPException(status_code=404, detail="Cliente não encontrado")

    allowed = _allowed_instancia_ids(db, identity, empresa_id)
    _assert_cliente_access_by_instancias(
        db,
        empresa_id=empresa_id,
        cliente_id=cliente_pk,
        allowed=allowed,
    )

    deleted = set(_cache_get_json(_k_deleted(empresa_id)) or [])
    deleted.add(int(cliente_pk))
    _cache_set_json(_k_deleted(empresa_id), list(deleted), ttl=7 * 24 * 3600)

    try:
        if _has_model_pinned(db):
            db.query(models.AtendimentoPinnedConversa).filter(
                models.AtendimentoPinnedConversa.empresa_id == int(empresa_id),
                models.AtendimentoPinnedConversa.conversa_id == int(cliente_pk),
            ).delete(synchronize_session=False)
            db.commit()
            _cache_del_pattern(_k("conv", "pin", "emp", str(empresa_id)))
    except Exception:
        try:
            db.rollback()
        except Exception:
            pass

    _invalidate_conversas_cache(int(empresa_id))
    _cache_del(_k("clientes", LIST_CACHE_VERSION, "emp", str(empresa_id), "dep", ""))
    _cache_del(_k("clientes", "emp", str(empresa_id), "dep", ""))

    try:
        asyncio.create_task(_broadcast({"type": "conv.deleted", "cliente_id": int(cliente_pk)}, empresa_id=empresa_id))
    except Exception:
        pass

    return {"ok": True, "deleted": list(deleted)}


@router.delete("/conversas/{cliente_id}/permanente")
def apagar_conversa_permanente(
    cliente_id: int,
    empresa_id: Optional[int] = Query(None),
    db: Session = Depends(get_db),
    identity: dict = Depends(get_current_identity),
):
    empresa_id = _assert_empresa_user(identity, empresa_id)

    perms = set(identity.get("permissoes") or [])
    is_admin = bool(identity.get("is_admin") or identity.get("admin")) or _is_admin(identity)

    if not (is_admin or "atendimento.apagar_conversas" in perms):
        raise HTTPException(status_code=403, detail="Sem permissão para apagar conversas")

    cliente_pk = _resolve_cliente_pk(db, int(empresa_id), int(cliente_id))
    if not cliente_pk:
        raise HTTPException(status_code=404, detail="Cliente não encontrado")

    allowed = _allowed_instancia_ids(db, identity, empresa_id)
    _assert_cliente_access_by_instancias(db, empresa_id=empresa_id, cliente_id=cliente_pk, allowed=allowed)

    cliente = (
        db.query(models.Cliente)
        .filter(
            models.Cliente.id == cliente_pk,
            models.Cliente.empresa_id == empresa_id,
        )
        .first()
    )

    if not cliente:
        raise HTTPException(status_code=404, detail="Cliente não encontrado")

    db.query(models.Midia).filter(
        models.Midia.empresa_id == empresa_id,
        models.Midia.cliente_id == cliente_pk,
    ).delete(synchronize_session=False)

    q_msg = db.query(models.Mensagem).filter(
        models.Mensagem.empresa_id == empresa_id,
        models.Mensagem.cliente_id == cliente_pk,
    )

    if allowed is not None:
        q_msg = q_msg.filter(models.Mensagem.instancia_id.in_([int(x) for x in allowed]))

    q_msg.delete(synchronize_session=False)

    db.query(models.Atendimento).filter(models.Atendimento.cliente_id == cliente_pk).delete(synchronize_session=False)

    try:
        if _has_model_pinned(db):
            db.query(models.AtendimentoPinnedConversa).filter(
                models.AtendimentoPinnedConversa.empresa_id == int(empresa_id),
                models.AtendimentoPinnedConversa.conversa_id == int(cliente_pk),
            ).delete(synchronize_session=False)
    except Exception:
        pass

    try:
        if _has_model_labels(db):
            db.query(models.AtendimentoConversaLabel).filter(
                models.AtendimentoConversaLabel.empresa_id == int(empresa_id),
                models.AtendimentoConversaLabel.cliente_id == int(cliente_pk),
            ).delete(synchronize_session=False)
    except Exception:
        pass

    db.delete(cliente)
    db.commit()

    try:
        deleted = set(_cache_get_json(_k_deleted(empresa_id)) or [])
        if int(cliente_pk) in deleted:
            deleted.discard(int(cliente_pk))
            _cache_set_json(_k_deleted(empresa_id), list(deleted), ttl=7 * 24 * 3600)

        _cache_del_pattern(_k("conv", "pin", "emp", str(empresa_id)))
        _invalidate_conversas_cache(int(empresa_id))
        _cache_del(_k("clientes", LIST_CACHE_VERSION, "emp", str(empresa_id), "dep", ""))
        _cache_del(_k("clientes", "emp", str(empresa_id), "dep", ""))
    except Exception:
        pass

    try:
        asyncio.create_task(_broadcast({"type": "conv.hard_deleted", "cliente_id": int(cliente_pk)}, empresa_id=empresa_id))
    except Exception:
        pass

    return {"ok": True, "deleted_permanente": True}


class LabelsIn(BaseModel):
    add: Optional[Any] = None
    set: Optional[List[str]] = None
    color: Optional[str] = None
    color_hex: Optional[str] = None


@router.get("/conversas/{cliente_id}/labels")
def obter_etiquetas(
    cliente_id: int,
    empresa_id: Optional[int] = Query(None),
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
):
    empresa_id = _assert_empresa_user(identity, empresa_id)
    _ensure_perm(identity, "atendimento.ver")

    cliente_pk = _resolve_cliente_pk(db, int(empresa_id), int(cliente_id))
    if not cliente_pk:
        raise HTTPException(status_code=404, detail="Cliente não encontrado")

    allowed = _allowed_instancia_ids(db, identity, empresa_id)
    _assert_cliente_access_by_instancias(db, empresa_id=empresa_id, cliente_id=cliente_pk, allowed=allowed)

    if _has_model_labels(db):
        rows = _labels_db_list(db, empresa_id=int(empresa_id), cliente_id=int(cliente_pk))
        labels = [r["name"] for r in rows]
        return {"labels": labels, "labels_ex": rows}

    key = _k_labels(empresa_id, cliente_pk)
    labels = _cache_get_json(key) or []
    labels = _ensure_list(labels)

    return {"labels": labels, "labels_ex": [{"name": s, "color_hex": None} for s in labels]}


@router.post("/conversas/{cliente_id}/labels")
def etiquetar_conversa(
    cliente_id: int,
    empresa_id: Optional[int] = Query(None),
    body: LabelsIn = Body(...),
    db: Session = Depends(get_db),
    identity=Depends(get_current_identity),
):
    empresa_id = _assert_empresa_user(identity, empresa_id)
    _ensure_perm(identity, "atendimento.ver")

    if not _is_admin(identity):
        raise HTTPException(status_code=403, detail="Apenas administradores")

    cliente_pk = _resolve_cliente_pk(db, int(empresa_id), int(cliente_id))
    if not cliente_pk:
        raise HTTPException(status_code=404, detail="Cliente não encontrado")

    allowed = _allowed_instancia_ids(db, identity, empresa_id)
    _assert_cliente_access_by_instancias(db, empresa_id=empresa_id, cliente_id=cliente_pk, allowed=allowed)

    user_id = int(identity["id"])

    if _has_model_labels(db):
        if body.set is not None:
            _labels_db_replace_all(db, int(empresa_id), int(cliente_pk), body.set, user_id)

            rows = _labels_db_list(db, int(empresa_id), int(cliente_pk))

            try:
                asyncio.create_task(
                    _broadcast(
                        {
                            "type": "conv.labels",
                            "cliente_id": int(cliente_pk),
                            "labels": [r["name"] for r in rows],
                            "labels_ex": rows,
                        },
                        empresa_id=empresa_id,
                    )
                )
            except Exception:
                pass

            return {"ok": True, "labels": [r["name"] for r in rows], "labels_ex": rows}

        name, color_hex = _extract_label_payload(body)

        if name:
            try:
                _labels_db_upsert(db, int(empresa_id), int(cliente_pk), name, color_hex, user_id)

                rows = _labels_db_list(db, int(empresa_id), int(cliente_pk))

                try:
                    asyncio.create_task(
                        _broadcast(
                            {
                                "type": "conv.labels",
                                "cliente_id": int(cliente_pk),
                                "labels": [r["name"] for r in rows],
                                "labels_ex": rows,
                            },
                            empresa_id=empresa_id,
                        )
                    )
                except Exception:
                    pass

                return {"ok": True, "labels": [r["name"] for r in rows], "labels_ex": rows}
            except Exception as e:
                try:
                    db.rollback()
                except Exception:
                    pass
                raise HTTPException(status_code=500, detail=f"Falha ao etiquetar conversa: {str(e)}")

        raise HTTPException(status_code=400, detail="Informe 'add' ou 'set'.")

    key = _k_labels(empresa_id, cliente_pk)
    labels = _cache_get_json(key) or []
    labels = [s for s in labels if isinstance(s, str)]

    if body.set is not None:
        labels = [s.strip() for s in (body.set or []) if isinstance(s, str) and s.strip()]
    else:
        name, _color_hex = _extract_label_payload(body)
        if name and name not in labels:
            labels.append(name)
        elif not name:
            raise HTTPException(status_code=400, detail="Informe 'add' ou 'set'.")

    _cache_set_json(key, labels, ttl=30 * 24 * 3600)

    try:
        asyncio.create_task(
            _broadcast(
                {
                    "type": "conv.labels",
                    "cliente_id": int(cliente_pk),
                    "labels": labels,
                    "labels_ex": [{"name": s, "color_hex": None} for s in labels],
                },
                empresa_id=empresa_id,
            )
        )
    except Exception:
        pass

    return {"ok": True, "labels": labels, "labels_ex": [{"name": s, "color_hex": None} for s in labels]}