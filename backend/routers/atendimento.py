# backend/routers/atendimento.py
from __future__ import annotations

import os
import json
import asyncio
from typing import Optional, Dict, List, Tuple, Any, Iterable
from datetime import datetime

from dateutil import parser
from fastapi import APIRouter, Depends, HTTPException, Query, Body, Header
from sqlalchemy import func, or_
from sqlalchemy.orm import Session
from pydantic import BaseModel

from backend import models
from backend.database import get_db
from backend.websocket_manager import conexoes_ativas
from backend.routers.auth import get_current_user

# =========================================================
# Redis (opcional) – cache leve para /conversas e /clientes
# =========================================================
REDIS_URL = os.getenv("REDIS_URL")
REDIS_PREFIX = os.getenv("REDIS_PREFIX", "zap")
REDIS_TTL_S = int(os.getenv("REDIS_TTL_SECONDS", "120"))

_redis = None
if REDIS_URL:
    try:
        import redis  # type: ignore
        _redis = redis.Redis.from_url(REDIS_URL, decode_responses=True)
    except Exception:
        _redis = None  # se não tiver lib ou falhar, segue sem cache


def _k(*parts: str) -> str:
    # monta chave do cache com prefixo
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
    """
    Deleta por SCAN um conjunto de chaves que começam com 'prefix'.
    Ex.: prefix='zap:conv:list:emp:12' -> apaga todas as variações.
    """
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


# =========================================================
# Helpers: flags de conversa (pin/labels/deleted) e admin
# =========================================================
def _k_pin(empresa_id: int) -> str:
    # (usado só como fallback quando não houver tabela de PINs)
    return _k("conv", "pin", "emp", str(int(empresa_id)))


def _k_pin_user(empresa_id: int, user_id: int) -> str:
    # pins por usuário (cache Redis)
    return _k("conv", "pin", "emp", str(int(empresa_id)), "user", str(int(user_id)))


def _k_deleted(empresa_id: int) -> str:
    return _k("conv", "deleted", "emp", str(int(empresa_id)))


def _k_labels(empresa_id: int, cliente_id: int) -> str:
    return _k("conv", "labels", "emp", str(int(empresa_id)), "cli", str(int(cliente_id)))


def _ensure_list(x):
    return x if isinstance(x, list) else (list(x) if isinstance(x, (set, tuple)) else [])


def _is_admin(user) -> bool:
    """
    Considera admin se: user.is_admin == True  OU  permissões conterem:
    'admin', 'root', 'clientes.gerenciar' ou 'atendimento.gerenciar'.
    Fallback seguro: se não achar nada, retorna False.
    """
    try:
        if getattr(user, "is_admin", False):
            return True
        perms = getattr(user, "permissoes", None) or getattr(user, "permissions", None) or []
        if isinstance(perms, dict):
            perms = [k for k, v in perms.items() if v]
        perms = set(str(p).lower() for p in (perms or []))
        return any(p in perms for p in ("admin", "root", "clientes.gerenciar", "atendimento.gerenciar"))
    except Exception:
        return False


# ------- Helpers: empresa do usuário / validação -------
def _empresa_do_user(user) -> Optional[int]:
    return getattr(user, "empresa_id", None) or getattr(user, "empresa", None)


def _assert_empresa_user(user, empresa_id: int) -> int:
    emp = _empresa_do_user(user)
    if emp is not None and int(emp) != int(empresa_id):
        raise HTTPException(status_code=403, detail="Empresa inválida para este usuário")
    return int(empresa_id)


# ------- Helpers: PIN por usuário em DB (com fallback) -------
def _has_model_pinned() -> bool:
    return hasattr(models, "AtendimentoPinnedConversa")


def _pinned_set_db(db: Session, empresa_id: int, user_id: int) -> set[int]:
    """
    Lê no banco os 'pinned' do usuário. Se a tabela não existir,
    retorna set() e o chamador pode cair no fallback de Redis/antigo.
    """
    if not _has_model_pinned():
        return set()
    rows = (
        db.query(models.AtendimentoPinnedConversa.conversa_id)
        .filter(
            models.AtendimentoPinnedConversa.empresa_id == int(empresa_id),
            models.AtendimentoPinnedConversa.user_id == int(user_id),
        )
        .all()
    )
    return set(int(r[0]) for r in rows)


def _pins_get_cached(db: Session, empresa_id: int, user_id: int) -> set[int]:
    c = _cache_get_json(_k_pin_user(empresa_id, user_id))
    if c is not None:
        try:
            return set(int(x) for x in c)
        except Exception:
            pass
    s = _pinned_set_db(db, empresa_id, user_id)
    _cache_set_json(_k_pin_user(empresa_id, user_id), sorted(s), ttl=30 * 24 * 3600)
    return s


def _pins_put_cached(empresa_id: int, user_id: int, s: set[int]):
    _cache_set_json(_k_pin_user(empresa_id, user_id), sorted(int(x) for x in s), ttl=30 * 24 * 3600)


# ------- Helpers: Labels com cor em DB (com fallback) -------
def _has_model_labels() -> bool:
    return hasattr(models, "AtendimentoConversaLabel")


def _normalize_hex(c: Optional[str]) -> Optional[str]:
    if not c:
        return None
    c = str(c).strip()
    if not c:
        return None
    if not c.startswith("#"):
        c = "#" + c
    if len(c) == 4:  # #abc -> #aabbcc
        c = "#" + "".join(ch * 2 for ch in c[1:])
    return c[:7].lower()


def _labels_db_list(db: Session, empresa_id: int, cliente_id: int) -> List[Dict[str, Optional[str]]]:
    if not _has_model_labels():
        return []
    rows = (
        db.query(models.AtendimentoConversaLabel)
        .filter(
            models.AtendimentoConversaLabel.empresa_id == int(empresa_id),
            models.AtendimentoConversaLabel.cliente_id == int(cliente_id),
        )
        .order_by(models.AtendimentoConversaLabel.name.asc())
        .all()
    )
    return [{"name": r.name, "color_hex": r.color_hex} for r in rows]


def _labels_db_upsert(
    db: Session,
    empresa_id: int,
    cliente_id: int,
    name: str,
    color_hex: Optional[str],
    created_by: Optional[int],
) -> None:
    if not _has_model_labels():
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
    db.commit()


def _labels_db_replace_all(
    db: Session,
    empresa_id: int,
    cliente_id: int,
    names: Iterable[str],
    created_by: Optional[int],
) -> None:
    if not _has_model_labels():
        return
    names = [n for n in (names or []) if isinstance(n, str) and n.strip()]
    # apaga os que não estão mais na lista
    db.query(models.AtendimentoConversaLabel).filter(
        models.AtendimentoConversaLabel.empresa_id == int(empresa_id),
        models.AtendimentoConversaLabel.cliente_id == int(cliente_id),
        ~models.AtendimentoConversaLabel.name.in_(names) if names else True,
    ).delete(synchronize_session=False)
    # garante existência de todos os 'names' (sem cor definida)
    for n in names:
        _labels_db_upsert(db, empresa_id, cliente_id, n.strip(), None, created_by)
    db.commit()


router = APIRouter(prefix="", tags=["Atendimento"])


def LOG(*a):
    print("\033[92m[ATENDIMENTO]", *a, "\033[0m")


# =========================================================
# WebSocket broadcast util
# =========================================================
async def _broadcast(payload: dict, *, empresa_id: int | None = None, grupo: str | None = None):
    """
    Envia para:
      - grupo específico (se grupo for passado), OU
      - emp:{empresa_id} (se empresa_id for passado), OU
      - todos os grupos conectados (fallback).
    """
    try:
        if grupo:
            await conexoes_ativas.send_message(grupo, payload)
            return
        if empresa_id is not None:
            await conexoes_ativas.send_message(f"emp:{int(empresa_id)}", payload)
            return

        # broadcast total (todos os grupos)
        for g in list(conexoes_ativas.grupos.keys()):
            await conexoes_ativas.send_message(g, payload)
    except Exception as e:
        print("[ATENDIMENTO][BROADCAST][ERRO]", e)


class BroadcastMensagem(BaseModel):
    empresa_id: int
    cliente_id: int
    mensagem: str
    tipo: str  # "entrada" ou "saida"
    timestamp: str
    msg_id: str
    # opcionais/legados
    midia_url: Optional[str] = None
    mimetype: Optional[str] = None
    lida: bool = False
    # padronizado com o front:
    midias: Optional[List[Dict]] = None
    instancia_id: Optional[int] = None
    instance_name: Optional[str] = None


def _parse_timestamp(val) -> str:
    """
    Aceita ISO, 'YYYY-MM-DD HH:MM:SS', epoch (str/int) e devolve ISO (UTC naive).
    """
    if val is None:
        return datetime.utcnow().isoformat()
    try:
        if isinstance(val, (int, float)) or (isinstance(val, str) and str(val).isdigit()):
            dt = datetime.utcfromtimestamp(int(val))
            return dt.isoformat()
        # trata 'YYYY-MM-DD HH:MM...' trocando espaço por 'T'
        if isinstance(val, str) and "T" not in val and " " in val:
            try:
                return parser.parse(val.replace(" ", "T")).isoformat()
            except Exception:
                pass
        return parser.parse(str(val)).isoformat()
    except Exception:
        return str(val)


# Chave de segurança para broadcast externo
INTERNAL_BROADCAST_KEY = os.getenv("INTERNAL_BROADCAST_KEY")


@router.post("/broadcast")
async def broadcast_msg(
    dados: dict,
    x_internal_key: Optional[str] = Header(None, alias="X-Internal-Key"),
):
    """
    Recebe eventos EXTERNOS e propaga via WebSocket.

    ⚠ Segurança:
    - Exige header X-Internal-Key igual à INTERNAL_BROADCAST_KEY (env).
    - Sem chave válida => 403 (não permite que qualquer um mande evento
      para qualquer empresa).

    Comportamento:
    - Para ACK isolado (sem mensagem/tipo), inclui `cliente_id` no payload.
    - Para mensagens, inclui `midias` no mesmo formato usado pelo histórico.
    - Faz pass-through de `instancia_id` e `instance_name`.
    - Invalida cache de conversas/clientes da empresa.
    """
    if INTERNAL_BROADCAST_KEY:
        if not x_internal_key or x_internal_key != INTERNAL_BROADCAST_KEY:
            raise HTTPException(status_code=403, detail="Chave interna inválida para broadcast")

    mensagem = dados.get("mensagem") or dados.get("texto") or dados.get("message") or ""
    tipo = dados.get("tipo") or dados.get("direction") or ""  # "entrada" | "saida"
    is_ack_isolado = dados.get("ack") is not None and not mensagem and not tipo

    ts_bruto = dados.get("timestamp") or dados.get("hora") or dados.get("created_at") or dados.get("ts")
    ts_formatado = _parse_timestamp(ts_bruto)

    if is_ack_isolado:
        # tenta carregar cliente_id do próprio payload
        cliente_id = dados.get("cliente_id")

        payload = {
            "type": "ack",
            "empresa_id": dados.get("empresa_id"),
            "msg_id": dados.get("msg_id"),
            "ack": dados.get("ack"),
            "cliente_id": cliente_id,  # <- ESSENCIAL p/ front atualizar em tempo real
            "timestamp": ts_formatado,
            # pass-through de instância
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
            # pass-through de instância (front usa em ws-empresa.js)
            "instancia_id": dados.get("instancia_id") or dados.get("instance_id"),
            "instance_name": dados.get("instance_name") or dados.get("instance"),
        }

        # --- anexos/mídias no mesmo formato do histórico ---
        midias: List[Dict] = []

        # 1) Já veio uma lista padronizada?
        if isinstance(dados.get("midias"), list) and dados["midias"]:
            for a in dados["midias"]:
                u = (
                    a.get("url")
                    or a.get("url_api")
                    or a.get("link")
                    or a.get("path")
                    or ""
                )
                if not u and a.get("id"):
                    # o front aceita ID numérico (resolve /api/atendimento/midias/:id)
                    u = f"/api/atendimento/midias/{a['id']}"

                midias.append(
                    {
                        "tipo": (a.get("tipo") or a.get("type") or "").lower(),
                        "mimetype": (a.get("mimetype") or a.get("mime") or ""),
                        "filename": a.get("filename")
                        or a.get("name")
                        or a.get("nome_original")
                        or "",
                        "url": u,
                    }
                )

        # 2) Fallback: veio um arquivo "solto" (midia_url/mimetype/filename)
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
                    "url": dados["midia_url"],  # http(s), data: ou caminho local
                }
            ]

        if midias:
            # força usar a rota resolutora quando for um id puro
            for m in midias:
                if isinstance(m.get("url"), str) and m["url"].isdigit():
                    m["url"] = f"/api/atendimento/midias/{m['url']}"
            payload["midias"] = midias

    # dispara para todos os conectados (empresa/instância), conforme sua infra atual
    await _broadcast(payload, empresa_id=dados.get("empresa_id"))

    # ---- Invalidação de cache: convs & clientes da empresa ----
    emp_id = dados.get("empresa_id")
    if emp_id:
        # apaga todas as variações de /conversas da empresa (página 1, cursores, instâncias)
        _cache_del_pattern(_k("conv", "list", "emp", str(emp_id)))
        # apaga lista legado /clientes
        _cache_del(_k("clientes", "emp", str(emp_id), "dep", ""))

    return {"status": "ok"}


# =========================================================
# Helpers de instância (resolver id/slug)
# =========================================================
def _resolve_instancia_id(
    db: Session,
    *,
    empresa_id: int,
    instancia_id: Optional[int],
    instance: Optional[str],
) -> Tuple[Optional[int], Optional[str]]:
    """
    Resolve a instância a partir de instancia_id (numérico) ou instance (slug/nome).
    Retorna (instancia_id_resolvido, instance_name_resolvido)
    """
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


# =========================================================
# Conversas (lista com paginação) — endpoint canônico p/ UI
# =========================================================
@router.get("/conversas")
def listar_conversas(
    empresa_id: int = Query(...),
    instancia_id: Optional[int] = Query(None),
    instance: Optional[str] = Query(None),
    limit: int = Query(20, ge=1, le=100),
    cursor: Optional[int] = Query(None, description="id da última Mensagem já carregada"),
    cursor_last_msg_id: Optional[int] = Query(None, description="alias legado"),
    db: Session = Depends(get_db),
    user=Depends(get_current_user),  # <-- precisamos do usuário para PINS por usuário
):
    """
    Retorna conversas (1/cliente) ordenadas pela última mensagem (desc),
    com paginação por cursor (mensagem.id < cursor).

    Filtro de instância: por `instancia_id` (numérico) OU `instance` (slug/nome).

    Respeita flags:
    - 'deleted' (Redis) oculta
    - 'pinned'  (DB por usuário; fallback Redis se não houver tabela)
    """
    # 🔒 trava empresa
    empresa_id = _assert_empresa_user(user, empresa_id)

    try:
        if cursor is None and cursor_last_msg_id is not None:
            cursor = cursor_last_msg_id

        m = models.Mensagem

        # resolve instância
        resolved_inst_id, resolved_inst_name = _resolve_instancia_id(
            db, empresa_id=empresa_id, instancia_id=instancia_id, instance=instance
        )
        inst_key = str(resolved_inst_id) if resolved_inst_id is not None else (resolved_inst_name or "0")
        cursor_key = str(cursor) if cursor is not None else "none"

        # --------- CACHE (GET) ----------
        cache_key = _k(
            "conv",
            "list",
            "emp",
            str(empresa_id),
            "inst",
            inst_key,
            "limit",
            str(limit),
            "cursor",
            cursor_key,
        )
        cached = _cache_get_json(cache_key)
        if cached:
            deleted_set = set(_cache_get_json(_k_deleted(empresa_id)) or [])
            # pins por usuário (se houver tabela) senão fallback Redis global
            if _has_model_pinned():
                pins_user = _pins_get_cached(db, int(empresa_id), int(user.id))
            else:
                pins_user = set(_cache_get_json(_k_pin(empresa_id)) or [])

            items = [it for it in cached.get("items", []) if int(it["cliente_id"]) not in deleted_set]
            for it in items:
                it["pinned"] = int(it["cliente_id"]) in pins_user

            # reordena: pins no topo (mantendo ordem relativa)
            items_p = [it for it in items if it.get("pinned")]
            items_o = [it for it in items if not it.get("pinned")]
            return {"items": items_p + items_o, "next_cursor": cached.get("next_cursor")}

        # 1) id da última mensagem por cliente
        filtros = [m.empresa_id == empresa_id]
        if resolved_inst_id is not None:
            filtros.append(m.instancia_id == resolved_inst_id)

        subq = (
            db.query(
                m.cliente_id.label("cid"),
                func.max(m.id).label("last_msg_id"),
            )
            .filter(*filtros)
            .group_by(m.cliente_id)
            .subquery()
        )

        base = db.query(
            subq.c.cid.label("cliente_id"),
            subq.c.last_msg_id.label("msg_id"),
        )
        if cursor:
            base = base.filter(subq.c.last_msg_id < int(cursor))

        base = base.order_by(subq.c.last_msg_id.desc()).limit(limit)
        pairs = base.all()  # [(cliente_id, msg_id), ...]

        if not pairs:
            payload = {"items": [], "next_cursor": None}
            _cache_set_json(cache_key, payload)  # cache também o vazio por pouco tempo
            return payload

        cliente_ids = [int(p[0]) for p in pairs]
        msg_ids = [int(p[1]) for p in pairs]

        # 2) carregar clientes e mensagens em lote
        clientes = {
            c.id: c
            for c in db.query(models.Cliente)
            .filter(models.Cliente.empresa_id == empresa_id, models.Cliente.id.in_(cliente_ids))
            .all()
        }

        msgs = {mm.id: mm for mm in db.query(m).filter(m.id.in_(msg_ids)).all()}

        # não lidas por cliente (apenas ENTRADA)
        novas_map: Dict[int, int] = {}
        if cliente_ids:
            for cid, cnt in (
                db.query(m.cliente_id, func.count(m.id))
                .filter(
                    m.empresa_id == empresa_id,
                    m.cliente_id.in_(cliente_ids),
                    m.tipo == "entrada",
                    m.lida == False,  # noqa: E712
                )
                .group_by(m.cliente_id)
                .all()
            ):
                novas_map[int(cid)] = int(cnt)

        # flags
        deleted_set = set(_cache_get_json(_k_deleted(empresa_id)) or [])
        if _has_model_pinned():
            pins_user = _pins_get_cached(db, int(empresa_id), int(user.id))
        else:
            pins_user = set(_cache_get_json(_k_pin(empresa_id)) or [])

        # Monta na mesma ordem do page set
        items = []
        for cid, mid in pairs:
            if int(cid) in deleted_set:
                continue  # oculta deletados
            c = clientes.get(int(cid))
            msg = msgs.get(int(mid))
            if not c or not msg:
                continue

            ts_iso = msg.timestamp.isoformat() if msg.timestamp else None

            items.append(
                {
                    "id": c.id,
                    "conversation_id": c.id,
                    "cliente_id": c.id,
                    "nome": getattr(c, "nome_whatsapp", None) or c.nome,
                    "telefone": c.telefone,
                    "avatar_url": getattr(c, "avatar_url", None),
                    "ultima_msg_id": msg.id,
                    "ultima_mensagem": msg.conteudo or "",
                    "hora": ts_iso,  # front converte para ms
                    "last_ts": ts_iso,
                    "novas": novas_map.get(int(c.id), 0),
                    "last_tipo": msg.tipo,
                    "last_ack": int(getattr(msg, "ack", 0)) if msg.tipo == "saida" else None,
                    "instancia_id": getattr(msg, "instancia_id", None),
                    "pinned": int(cid) in pins_user,
                }
            )

        # reordena: pins no topo (mantendo ordem relativa original)
        items_p = [it for it in items if it.get("pinned")]
        items_o = [it for it in items if not it.get("pinned")]
        items = items_p + items_o

        next_cursor = int(pairs[-1][1]) if pairs else None
        payload = {"items": items, "next_cursor": next_cursor}

        # --------- CACHE (SET) ----------
        _cache_set_json(cache_key, payload)
        return payload

    except Exception as e:
        LOG("[/conversas][ERRO]", repr(e))
        raise HTTPException(status_code=500, detail="Falha ao listar conversas")


# =========================================================
# Legado: lista de clientes (sem paginação)
# =========================================================
@router.get("/clientes")
def listar_clientes(
    empresa_id: int,
    departamento: Optional[str] = None,
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    """
    Lista clientes que já possuem conversa (pelo menos uma mensagem),
    trazendo o preview da última mensagem e contagem de não lidas (entradas).
    Ordena por data da última mensagem (mais recente primeiro).

    Respeita 'deleted' (oculta).
    """
    empresa_id = _assert_empresa_user(user, empresa_id)

    LOG("[clientes] Listando clientes para empresa_id", empresa_id)

    # --------- CACHE (GET) ----------
    cache_key = _k("clientes", "emp", str(empresa_id), "dep", str(departamento or ""))
    cached = _cache_get_json(cache_key)
    if cached:
        deleted_set = set(_cache_get_json(_k_deleted(empresa_id)) or [])
        if deleted_set:
            cached = [it for it in cached if int(it.get("id")) not in deleted_set]
        return cached

    # Subquery: última data de mensagem por cliente
    subq = (
        db.query(
            models.Mensagem.cliente_id,
            func.max(models.Mensagem.timestamp).label("ultima_data"),
        )
        .filter(models.Mensagem.empresa_id == empresa_id)
        .group_by(models.Mensagem.cliente_id)
        .subquery()
    )

    # Clientes da empresa que têm conversa
    q = (
        db.query(models.Cliente)
        .outerjoin(subq, models.Cliente.id == subq.c.cliente_id)
        .filter(models.Cliente.empresa_id == empresa_id)
        .filter(subq.c.ultima_data.isnot(None))  # só quem tem conversa
    )
    if departamento:
        q = q.filter(models.Cliente.departamento == departamento)

    # Ordena por última atividade (desc)
    q = q.order_by(subq.c.ultima_data.desc().nullslast())

    deleted_set = set(_cache_get_json(_k_deleted(empresa_id)) or [])

    resultado = []
    for c in q.all():
        if int(c.id) in deleted_set:
            continue

        # Última mensagem desse cliente (na empresa)
        ultima = (
            db.query(models.Mensagem)
            .filter(
                models.Mensagem.cliente_id == c.id,
                models.Mensagem.empresa_id == empresa_id,
            )
            .order_by(models.Mensagem.timestamp.desc())
            .first()
        )

        # Contagem de não lidas de ENTRADA (na empresa)
        novas = (
            db.query(models.Mensagem)
            .filter(
                models.Mensagem.cliente_id == c.id,
                models.Mensagem.empresa_id == empresa_id,
                models.Mensagem.tipo == "entrada",
                models.Mensagem.lida == False,  # noqa: E712
            )
            .count()
        )

        # epoch em ms (o front entende de primeira)
        ultima_ts_ms = int(ultima.timestamp.timestamp() * 1000) if (ultima and ultima.timestamp) else None

        resultado.append(
            {
                "id": c.id,
                "nome": getattr(c, "nome_whatsapp", None) or c.nome,
                "telefone": c.telefone,
                "avatar_url": c.avatar_url,
                "ultima_mensagem": (ultima.conteudo or "") if ultima else "",
                "hora": ultima_ts_ms,  # usado no preview
                "last_ts": ultima_ts_ms,  # alias lido pelo front
                "novas": novas,
                "last_tipo": ultima.tipo if ultima else None,  # decide ✓✓
                "last_ack": int(getattr(ultima, "ack", 0)) if (ultima and ultima.tipo == "saida") else None,
            }
        )

    LOG(f"[clientes] Retornando {len(resultado)} clientes.")

    # --------- CACHE (SET) ----------
    _cache_set_json(cache_key, resultado)
    return resultado


# =========================================================
# Helpers de mídia (para histórico/listagem apenas)
# (mantidos aqui para reuso futuro; não usados nas rotas atuais)
# =========================================================
def _carregar_midias_por_mensagem_ids(db: Session, msg_ids: List[int]) -> Dict[int, List[models.Midia]]:
    if not msg_ids:
        return {}
    anexos = db.query(models.Midia).filter(models.Midia.mensagem_id.in_(msg_ids)).all()
    por_msg: Dict[int, List[models.Midia]] = {}
    for md in anexos:
        por_msg.setdefault(int(md.mensagem_id), []).append(md)
    return por_msg


def _midia_to_dict(md: models.Midia) -> Dict[str, Any]:
    return {
        "id": md.id,
        "tipo": getattr(md, "tipo", None),
        "mimetype": getattr(md, "mimetype", None),
        "tamanho": getattr(md, "tamanho", None),
        "nome_original": getattr(md, "nome_original", None),
        "url_api": f"/api/atendimento/midias/{md.id}",  # rota resolutora (no atendimento_midias.py)
        "filename": getattr(md, "filename", None) or getattr(md, "nome_original", None),
    }


# =========================================================
# Marcar mensagens de ENTRADA como lidas + avisar UIs
# =========================================================
@router.post("/clientes/{cliente_id}/seen")
async def marcar_lidas(
    cliente_id: int,
    empresa_id: int = Query(...),
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    """
    Marca como lidas todas as mensagens de ENTRADA (recebidas) desse cliente.
    É idempotente. Após atualizar, emite 'reload_clientes' para sincronizar UIs.
    Também invalida caches de listas afetadas.
    """
    empresa_id = _assert_empresa_user(user, empresa_id)

    total = (
        db.query(models.Mensagem)
        .filter(
            models.Mensagem.cliente_id == cliente_id,
            models.Mensagem.empresa_id == empresa_id,
            models.Mensagem.tipo == "entrada",
            models.Mensagem.lida == False,  # noqa: E712
        )
        .update({models.Mensagem.lida: True}, synchronize_session=False)
    )
    db.commit()

    # invalida lista legado e conversas (primeiras páginas)
    _cache_del(_k("clientes", "emp", str(empresa_id), "dep", ""))
    _cache_del_pattern(_k("conv", "list", "emp", str(empresa_id)))

    await conexoes_ativas.send_message(f"emp:{empresa_id}", {"type": "reload_clientes"})
    return {"ok": True, "marcadas": int(total)}


# =========================================================
# Conversas: pins / labels / delete
#  - PIN agora é por usuário e persiste no DB (fallback Redis se sem tabela)
#  - LABELS aceitam cor quando houver tabela; fallback Redis mantém compat
# =========================================================

# ---------- PIN ----------
@router.get("/conversas/pin")
def listar_pins(
    empresa_id: int = Query(...),
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    empresa_id = _assert_empresa_user(user, empresa_id)

    if _has_model_pinned():
        pinned = _pins_get_cached(db, empresa_id=int(empresa_id), user_id=int(user.id))
        return {"pinned": sorted(pinned)}

    # fallback legado (global, via Redis)
    pinned = _cache_get_json(_k_pin(empresa_id)) or []
    return {"pinned": _ensure_list(pinned)}


@router.post("/conversas/{cliente_id}/pin")
def fixar_conversa(
    cliente_id: int,
    empresa_id: int = Query(...),
    payload: dict = Body(...),
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    empresa_id = _assert_empresa_user(user, empresa_id)
    want_pin = bool(payload.get("pin", True))

    if _has_model_pinned():
        # por usuário no DB
        if want_pin:
            exists = (
                db.query(models.AtendimentoPinnedConversa)
                .filter(
                    models.AtendimentoPinnedConversa.empresa_id == int(empresa_id),
                    models.AtendimentoPinnedConversa.user_id == int(user.id),
                    models.AtendimentoPinnedConversa.conversa_id == int(cliente_id),
                )
                .first()
            )
            if not exists:
                db.add(
                    models.AtendimentoPinnedConversa(
                        empresa_id=int(empresa_id),
                        user_id=int(user.id),
                        conversa_id=int(cliente_id),
                    )
                )
                db.commit()
            # atualiza cache
            s = _pins_get_cached(db, int(empresa_id), int(user.id))
            s.add(int(cliente_id))
            _pins_put_cached(int(empresa_id), int(user.id), s)
        else:
            db.query(models.AtendimentoPinnedConversa).filter(
                models.AtendimentoPinnedConversa.empresa_id == int(empresa_id),
                models.AtendimentoPinnedConversa.user_id == int(user.id),
                models.AtendimentoPinnedConversa.conversa_id == int(cliente_id),
            ).delete(synchronize_session=False)
            db.commit()
            # atualiza cache
            s = _pins_get_cached(db, int(empresa_id), int(user.id))
            if int(cliente_id) in s:
                s.discard(int(cliente_id))
                _pins_put_cached(int(empresa_id), int(user.id), s)

        # limpa chave global legada para evitar “ressuscitar” pins antigos
        _cache_del(_k_pin(empresa_id))

    else:
        # fallback legado (global, Redis) — mantém compat até criar a tabela
        pinned = set(_cache_get_json(_k_pin(empresa_id)) or [])
        if want_pin:
            pinned.add(int(cliente_id))
        else:
            pinned.discard(int(cliente_id))
        _cache_set_json(_k_pin(empresa_id), list(pinned), ttl=7 * 24 * 3600)

    # invalida listas de conversas para refletir ordenação
    _cache_del_pattern(_k("conv", "list", "emp", str(empresa_id)))

    # avisa UIs conectadas
    try:
        asyncio.create_task(
            _broadcast(
                {"type": "conv.pin", "cliente_id": int(cliente_id), "pin": want_pin, "user_id": int(user.id)},
                empresa_id=empresa_id,
            )
        )
    except Exception:
        pass

    return {"ok": True, "pinned": want_pin}


# ---------- Deleted (permanece em Redis) ----------
@router.get("/conversas/deleted")
def listar_deletados(
    empresa_id: int = Query(...),
    user=Depends(get_current_user),
):
    empresa_id = _assert_empresa_user(user, empresa_id)
    deleted = _cache_get_json(_k_deleted(empresa_id)) or []
    return {"deleted": _ensure_list(deleted)}


@router.delete("/conversas/{cliente_id}")
def apagar_conversa(
    cliente_id: int,
    empresa_id: int = Query(...),
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    empresa_id = _assert_empresa_user(user, empresa_id)

    if not _is_admin(user):
        raise HTTPException(403, "Apenas administradores")

    deleted = set(_cache_get_json(_k_deleted(empresa_id)) or [])
    deleted.add(int(cliente_id))
    _cache_set_json(_k_deleted(empresa_id), list(deleted), ttl=7 * 24 * 3600)

    # opcional: ao esconder conversa, remover pins do BD para todos os usuários
    try:
        if _has_model_pinned():
            db.query(models.AtendimentoPinnedConversa).filter(
                models.AtendimentoPinnedConversa.empresa_id == int(empresa_id),
                models.AtendimentoPinnedConversa.conversa_id == int(cliente_id),
            ).delete(synchronize_session=False)
            db.commit()
            # invalida caches de pins de todos os users da empresa
            _cache_del_pattern(_k("conv", "pin", "emp", str(empresa_id)))
    except Exception:
        pass

    # invalida listas para esconder imediatamente
    _cache_del_pattern(_k("conv", "list", "emp", str(empresa_id)))
    _cache_del(_k("clientes", "emp", str(empresa_id), "dep", ""))
    try:
        asyncio.create_task(
            _broadcast({"type": "conv.deleted", "cliente_id": int(cliente_id)}, empresa_id=empresa_id)
        )
    except Exception:
        pass
    return {"ok": True, "deleted": list(deleted)}


# ---------- Labels (agora com cor quando houver tabela; fallback Redis compat) ----------
class LabelsIn(BaseModel):
    add: Optional[str] = None
    set: Optional[List[str]] = None
    color: Optional[str] = None  # aceita 'color' ou 'color_hex'
    color_hex: Optional[str] = None


@router.get("/conversas/{cliente_id}/labels")
def obter_etiquetas(
    cliente_id: int,
    empresa_id: int = Query(...),
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    empresa_id = _assert_empresa_user(user, empresa_id)

    if _has_model_labels():
        rows = _labels_db_list(db, empresa_id=int(empresa_id), cliente_id=int(cliente_id))
        labels = [r["name"] for r in rows]
        return {"labels": labels, "labels_ex": rows}

    # fallback Redis (lista simples de strings)
    key = _k_labels(empresa_id, cliente_id)
    labels = _cache_get_json(key) or []
    labels = _ensure_list(labels)
    # compat: expõe também labels_ex sem cor
    return {"labels": labels, "labels_ex": [{"name": s, "color_hex": None} for s in labels]}


@router.post("/conversas/{cliente_id}/labels")
def etiquetar_conversa(
    cliente_id: int,
    empresa_id: int = Query(...),
    body: LabelsIn = Body(...),
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    empresa_id = _assert_empresa_user(user, empresa_id)

    # manter exigência de admin (como era no legado) — ajuste se quiser liberar
    if not _is_admin(user):
        raise HTTPException(403, "Apenas administradores")

    if _has_model_labels():
        # DB com cor
        if body.set is not None:
            # substitui o conjunto (sem cor definida nessa operação)
            _labels_db_replace_all(db, int(empresa_id), int(cliente_id), body.set, int(user.id))
            rows = _labels_db_list(db, int(empresa_id), int(cliente_id))
            try:
                asyncio.create_task(
                    _broadcast(
                        {
                            "type": "conv.labels",
                            "cliente_id": int(cliente_id),
                            "labels": [r["name"] for r in rows],
                            "labels_ex": rows,
                        },
                        empresa_id=empresa_id,
                    )
                )
            except Exception:
                pass
            return {
                "ok": True,
                "labels": [r["name"] for r in rows],
                "labels_ex": rows,
            }

        if body.add:
            name = (body.add or "").strip()
            if not name:
                raise HTTPException(400, "Nome de etiqueta inválido")
            color_hex = _normalize_hex(body.color_hex or body.color)
            _labels_db_upsert(db, int(empresa_id), int(cliente_id), name, color_hex, int(user.id))
            rows = _labels_db_list(db, int(empresa_id), int(cliente_id))
            try:
                asyncio.create_task(
                    _broadcast(
                        {
                            "type": "conv.labels",
                            "cliente_id": int(cliente_id),
                            "labels": [r["name"] for r in rows],
                            "labels_ex": rows,
                        },
                        empresa_id=empresa_id,
                    )
                )
            except Exception:
                pass
            return {
                "ok": True,
                "labels": [r["name"] for r in rows],
                "labels_ex": rows,
            }

        raise HTTPException(400, "Informe 'add' ou 'set'.")

    # ---- Fallback Redis (sem cor) ----
    key = _k_labels(empresa_id, cliente_id)
    labels = _cache_get_json(key) or []
    labels = [s for s in labels if isinstance(s, str)]
    if body.set is not None:
        labels = [s for s in (body.set or []) if isinstance(s, str) and s.strip()]
    elif body.add:
        lab = body.add.strip()
        if lab and lab not in labels:
            labels.append(lab)
    else:
        raise HTTPException(400, "Informe 'add' ou 'set'.")

    _cache_set_json(key, labels, ttl=30 * 24 * 3600)
    try:
        asyncio.create_task(
            _broadcast(
                {
                    "type": "conv.labels",
                    "cliente_id": int(cliente_id),
                    "labels": labels,
                    "labels_ex": [{"name": s, "color_hex": None} for s in labels],
                },
                empresa_id=empresa_id,
            )
        )
    except Exception:
        pass
    return {
        "ok": True,
        "labels": labels,
        "labels_ex": [{"name": s, "color_hex": None} for s in labels],
    }
