# backend/routers/internal_chat.py
from __future__ import annotations

import uuid
import asyncio
from typing import List, Optional, TypedDict

import anyio
from fastapi import (
    APIRouter,
    Depends,
    HTTPException,
    Query,
    Body,
    WebSocket,
    WebSocketDisconnect,
)
from sqlalchemy.orm import Session, joinedload
from sqlalchemy import text, func

from backend.database import get_db
from backend.routers.auth import get_current_identity
from backend import models
from backend.websocket_manager import conexoes_ativas  # usa os mesmos grupos do main.py
from backend.services.zapschat_presence import list_company_presence

router = APIRouter(prefix="/api/internal-chat", tags=["Chat Interno"])

# =====================================================================================
# Helpers
# =====================================================================================


def _resolve_colab_id(db: Session, ident: dict) -> int:
    if ident is None:
        raise HTTPException(status_code=401, detail="Não autenticado")

    # se o token já veio com id_colab, ótimo
    if "id_colab" in ident and ident["id_colab"]:
        return int(ident["id_colab"])

    kind = (ident.get("kind") or "").lower()
    if kind == "colaborador":
        return int(ident["id"])

    # senão, resolve via espelho (usuario -> colaborador)
    user_id = int(ident["id"])
    empresa_id = int(ident["empresa_id"])
    colab = (
        db.query(models.Colaborador)
        .filter(
            models.Colaborador.usuario_id == user_id,
            models.Colaborador.empresa_id == empresa_id,
        )
        .first()
    )
    if not colab:
        raise HTTPException(
            status_code=403,
            detail="Colaborador espelho não encontrado para o usuário atual",
        )
    return int(colab.id)


def _assert_participa(
    db: Session,
    empresa_id: int,
    thread_id: str,
    colab_id: int,
) -> None:
    """Verifica se o colaborador participa da thread (via EXISTS/UNNEST)."""
    row = db.execute(
        text(
            """
            SELECT 1
              FROM chat_eventos h
             WHERE h.empresa_id = :emp
               AND h.thread_id  = :tid
               AND h.kind = 'head'
               AND EXISTS (
                     SELECT 1
                       FROM unnest(h.participantes) AS p
                      WHERE p = :uid
               )
             LIMIT 1
        """
        ),
        {"emp": empresa_id, "tid": thread_id, "uid": colab_id},
    ).first()
    if not row:
        raise HTTPException(
            status_code=404,
            detail="Conversa não encontrada ou sem acesso",
        )


def _chat_read_col(db: Session) -> str:
    """
    Compatibilidade segura:
    - versão correta atual do model: chat_read_state.last_read_at
    - banco antigo pode ter sido criado com: chat_read_state.last_read

    Retorna apenas nomes fixos/permitidos para não abrir risco de SQL injection.
    """
    try:
        rows = db.execute(
            text(
                """
                SELECT column_name
                  FROM information_schema.columns
                 WHERE table_name = 'chat_read_state'
                   AND column_name IN ('last_read_at', 'last_read')
                """
            )
        ).scalars().all()
        cols = {str(c) for c in rows}
        if "last_read_at" in cols:
            return "last_read_at"
        if "last_read" in cols:
            return "last_read"
    except Exception:
        pass
    return "last_read_at"


def _new_thread_id() -> str:
    return uuid.uuid4().hex


async def _broadcast_emp_async(emp_id: int, payload: dict):
    """Broadcast via grupo emp:{empresa_id} (mesmo esquema do main.py)."""
    await conexoes_ativas.broadcast(f"emp:{emp_id}", payload)


def _broadcast_emp(emp_id: int, payload: dict):
    """
    Chama o broadcast a partir de handlers síncronos (endpoints def ...).
    Usa anyio.from_thread.run para pular o erro 'no running event loop'.
    """
    try:
        anyio.from_thread.run(_broadcast_emp_async, emp_id, payload)
    except RuntimeError:
        # fallback: se já estiver num loop assíncrono (endpoint async), ignore aqui
        pass


# =====================================================================================
# Schemas
# =====================================================================================


class NewConversationIn(TypedDict, total=False):
    titulo: Optional[str]
    participantes: List[int]


class SendMessageIn(TypedDict):
    texto: str


class RenameIn(TypedDict):
    titulo: str


class ParticipantsIn(TypedDict, total=False):
    add: Optional[List[int]]
    remove: Optional[List[int]]


class ChatColabOut(TypedDict, total=False):
    id: int
    nome: str
    nome_completo: Optional[str]
    setor_nome: Optional[str]
    email: Optional[str]
    telefone: Optional[str]
    cargo: Optional[str]
    created_at: Optional[str]
    last_access_at: Optional[str]
    presence_status: Optional[str]
    presence_updated_at: Optional[str]
    presence_expires_at: Optional[str]
    presence_activity_at: Optional[str]
    avatar_url: Optional[str]


# =====================================================================================
# Endpoints REST
# =====================================================================================


@router.get("/me")
def who_am_i(
    ident=Depends(get_current_identity),
    db: Session = Depends(get_db),
):
    """Retorna o colab_id do usuário atual (usado pelo front para alinhar bolhas)."""
    emp_id = int(ident["empresa_id"])
    colab_id = _resolve_colab_id(db, ident)
    return {"empresa_id": emp_id, "colab_id": colab_id}


@router.get("/roster")
def chat_roster(
    ident=Depends(get_current_identity),
    db: Session = Depends(get_db),
) -> List[ChatColabOut]:
    """
    Lista básica de colaboradores da mesma empresa para o chat interno.

    Não depende de permissão 'colaboradores.ver', só de estar autenticado
    na empresa. É usado só pra montar nome/foto no chat interno.
    """
    emp_id = int(ident["empresa_id"])
    Colab = models.Colaborador

    # Só colaboradores da empresa logada, ordenados por nome (case-insensitive)
    rows = (
        db.query(Colab)
        .options(joinedload(Colab.setor))
        .filter(Colab.empresa_id == emp_id)
        .order_by(func.lower(Colab.nome))
        .all()
    )

    presence_map = list_company_presence(
        emp_id,
        [int(c.id) for c in rows],
        include_offline=True,
    )

    out: List[ChatColabOut] = []
    for c in rows:
        setor_nome: Optional[str] = None

        # Se tiver relação .setor, usa
        if getattr(c, "setor", None) is not None:
            setor_nome = c.setor.nome
        # senão tenta resolver por setor_id / departamento_id
        elif getattr(c, "setor_id", None):
            s = db.query(models.Setor).filter_by(id=c.setor_id).first()
            if s:
                setor_nome = s.nome
            else:
                dep = (
                    db.query(models.Departamento)
                    .filter_by(id=c.setor_id, empresa_id=c.empresa_id)
                    .first()
                )
                if dep:
                    setor_nome = dep.nome

        created_at = getattr(c, "created_at", None) or getattr(c, "timestamp", None)
        out.append(
            {
                "id": int(c.id),
                "nome": c.nome,
                "nome_completo": getattr(c, "nome_completo", None) or c.nome,
                "setor_nome": setor_nome,
                "email": getattr(c, "email", None),
                "telefone": getattr(c, "telefone", None),
                "cargo": getattr(c, "cargo", None),
                "created_at": created_at.isoformat() if hasattr(created_at, "isoformat") else None,
                "last_access_at": (
                    c.last_access_at.isoformat()
                    if hasattr(getattr(c, "last_access_at", None), "isoformat")
                    else None
                ),
                "presence_status": str(
                    presence_map.get(int(c.id), {}).get("presence_status") or "offline"
                ),
                "presence_updated_at": presence_map.get(int(c.id), {}).get("presence_updated_at"),
                "presence_expires_at": presence_map.get(int(c.id), {}).get("presence_expires_at"),
                "presence_activity_at": presence_map.get(int(c.id), {}).get("presence_activity_at"),
                "avatar_url": f"/api/colaboradores/{int(c.id)}/avatar",
            }
        )

    return out


@router.get("/conversations")
def list_conversations(
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    q: Optional[str] = Query(None),
    ident=Depends(get_current_identity),
    db: Session = Depends(get_db),
):
    """Lista conversas em que o usuário participa, com último evento e contagem de não lidas."""
    emp_id = int(ident["empresa_id"])
    uid = _resolve_colab_id(db, ident)

    read_col = _chat_read_col(db)
    sql = text(
        f"""
        WITH my_heads AS (
            SELECT h.thread_id,
                   h.titulo,
                   h.participantes,
                   h.created_at AS head_created_at,
                   CASE
                     WHEN cardinality(COALESCE(h.participantes, ARRAY[]::integer[])) = 2 THEN (
                       SELECT string_agg(p::text, ':' ORDER BY p)
                         FROM unnest(h.participantes) AS p
                     )
                     ELSE h.thread_id::text
                   END AS conv_key
              FROM chat_eventos h
             WHERE h.empresa_id = :emp
               AND h.kind = 'head'
               AND EXISTS (
                     SELECT 1
                       FROM unnest(COALESCE(h.participantes, ARRAY[]::integer[])) AS p
                      WHERE p = :uid
               )
        ),
        last_msg AS (
            SELECT DISTINCT ON (e.thread_id)
                   e.thread_id,
                   e.texto AS last_texto,
                   e.kind AS last_kind,
                   e.created_at AS last_created_at
              FROM chat_eventos e
              JOIN my_heads t ON t.thread_id = e.thread_id
             WHERE e.empresa_id = :emp
               AND e.deleted_at IS NULL
             ORDER BY e.thread_id, e.created_at DESC
        ),
        ranked_heads AS (
            SELECT h.thread_id,
                   h.titulo,
                   h.participantes,
                   h.conv_key,
                   lm.last_texto,
                   lm.last_kind,
                   lm.last_created_at,
                   ROW_NUMBER() OVER (
                     PARTITION BY h.conv_key
                     ORDER BY
                       CASE WHEN lm.last_kind = 'msg' THEN 0 ELSE 1 END,
                       lm.last_created_at DESC NULLS LAST,
                       h.head_created_at DESC NULLS LAST
                   ) AS rn
              FROM my_heads h
              JOIN last_msg lm ON lm.thread_id = h.thread_id
        ),
        chosen AS (
            SELECT *
              FROM ranked_heads
             WHERE rn = 1
        ),
        unread AS (
            SELECT e.thread_id, COUNT(*) AS unread_count
              FROM chat_eventos e
              JOIN chosen t ON t.thread_id = e.thread_id
              LEFT JOIN chat_read_state rs
                     ON rs.empresa_id = :emp
                    AND rs.thread_id  = e.thread_id
                    AND rs.user_id    = :uid
             WHERE e.empresa_id = :emp
               AND e.deleted_at IS NULL
               AND e.kind IN ('msg','system')
               AND e.created_at > COALESCE(rs.{read_col}, 'epoch'::timestamptz)
             GROUP BY e.thread_id
        )
        SELECT h.thread_id,
               h.titulo,
               h.participantes,
               h.last_texto,
               h.last_kind,
               h.last_created_at,
               COALESCE(u.unread_count, 0) AS unread_count
          FROM chosen h
     LEFT JOIN unread u ON u.thread_id = h.thread_id
         WHERE (:q IS NULL
                OR h.titulo ILIKE '%' || :q || '%'
                OR EXISTS (
                     SELECT 1 FROM chat_eventos e2
                      WHERE e2.thread_id = h.thread_id
                        AND e2.empresa_id = :emp
                        AND e2.deleted_at IS NULL
                        AND e2.kind IN ('msg','system')
                        AND e2.texto ILIKE '%' || :q || '%'
                ))
         ORDER BY h.last_created_at DESC NULLS LAST
         LIMIT :limit OFFSET :offset
    """
    )

    rows = db.execute(
        sql,
        {
            "emp": emp_id,
            "uid": uid,
            "q": (q or None),
            "limit": limit,
            "offset": offset,
        },
    ).mappings().all()

    return [dict(r) for r in rows]



@router.get("/mentions")
def list_mentions(
    limit: int = Query(80, ge=1, le=200),
    offset: int = Query(0, ge=0),
    ident=Depends(get_current_identity),
    db: Session = Depends(get_db),
) -> List[ChatMentionOut]:
    """Lista mensagens com @ nas conversas em que o usuário participa."""
    emp_id = int(ident["empresa_id"])
    uid = _resolve_colab_id(db, ident)

    sql = text(
        """
        WITH my_threads AS (
            SELECT h.thread_id, h.titulo, h.participantes
              FROM chat_eventos h
             WHERE h.empresa_id = :emp
               AND h.kind = 'head'
               AND EXISTS (
                     SELECT 1
                       FROM unnest(h.participantes) AS p
                      WHERE p = :uid
               )
        )
        SELECT e.id,
               e.thread_id,
               t.titulo,
               t.participantes,
               e.autor_id,
               e.texto,
               e.created_at
          FROM chat_eventos e
          JOIN my_threads t ON t.thread_id = e.thread_id
         WHERE e.empresa_id = :emp
           AND e.deleted_at IS NULL
           AND e.kind = 'msg'
           AND e.texto ILIKE '%@%'
         ORDER BY e.created_at DESC
         LIMIT :limit OFFSET :offset
        """
    )
    rows = db.execute(
        sql,
        {
            "emp": emp_id,
            "uid": uid,
            "limit": limit,
            "offset": offset,
        },
    ).mappings().all()

    out: List[ChatMentionOut] = []
    for r in rows:
        d = dict(r)
        if hasattr(d.get("created_at"), "isoformat"):
            d["created_at"] = d["created_at"].isoformat()
        out.append(d)
    return out


@router.post("/conversations", status_code=201)
def create_conversation(
    payload: NewConversationIn = Body(...),
    ident=Depends(get_current_identity),
    db: Session = Depends(get_db),
):
    emp_id = int(ident["empresa_id"])
    uid = _resolve_colab_id(db, ident)

    titulo_raw = (payload.get("titulo") or "").strip()
    titulo = titulo_raw or "Conversa"

    # Sempre garante que o próprio usuário entra nos participantes.
    # Também normaliza para evitar [eu, outro] e [outro, eu] virarem conversas diferentes.
    participantes = []
    for p in (payload.get("participantes") or []) + [uid]:
        try:
            n = int(p)
        except Exception:
            continue
        if n > 0 and n not in participantes:
            participantes.append(n)

    # Chat 1x1 não deve duplicar.
    # Se já existe uma conversa direta entre os mesmos 2 colaboradores, reutiliza a thread.
    # Grupos continuam podendo ser criados normalmente.
    if len(participantes) == 2 and not titulo_raw:
        parts_sorted = sorted(participantes)
        existing = (
            db.execute(
                text(
                    """
            SELECT h.thread_id,
                   h.titulo,
                   h.participantes,
                   lm.last_texto,
                   lm.last_kind,
                   lm.last_created_at
              FROM chat_eventos h
         LEFT JOIN LATERAL (
                    SELECT e.texto AS last_texto,
                           e.kind  AS last_kind,
                           e.created_at AS last_created_at
                      FROM chat_eventos e
                     WHERE e.empresa_id = h.empresa_id
                       AND e.thread_id = h.thread_id
                       AND e.deleted_at IS NULL
                     ORDER BY e.created_at DESC
                     LIMIT 1
                 ) lm ON TRUE
             WHERE h.empresa_id = :emp
               AND h.kind = 'head'
               AND cardinality(COALESCE(h.participantes, ARRAY[]::integer[])) = 2
               AND h.participantes @> CAST(:parts AS integer[])
               AND CAST(:parts AS integer[]) @> h.participantes
             ORDER BY
               CASE WHEN lm.last_kind = 'msg' THEN 0 ELSE 1 END,
               lm.last_created_at DESC NULLS LAST,
               h.created_at DESC NULLS LAST
             LIMIT 1
        """
                ),
                {"emp": emp_id, "parts": parts_sorted},
            )
            .mappings()
            .first()
        )
        if existing:
            d = dict(existing)
            if hasattr(d.get("last_created_at"), "isoformat"):
                d["last_created_at"] = d["last_created_at"].isoformat()
            return d

    tid = _new_thread_id()
    db.execute(
        text(
            """
            INSERT INTO chat_eventos (empresa_id, thread_id, kind, autor_id, titulo, participantes, texto)
            VALUES (:emp, :tid, 'head', :uid, :titulo, :parts, NULL)
        """
        ),
        {"emp": emp_id, "tid": tid, "uid": uid, "titulo": titulo, "parts": participantes},
    )
    db.commit()

    # WS
    _broadcast_emp(
        emp_id,
        {
            "type": "thread.created",
            "thread_id": tid,
            "titulo": titulo,
            "participantes": participantes,
        },
    )

    return {"thread_id": tid, "titulo": titulo, "participantes": participantes}


@router.get("/conversations/{thread_id}")
def conversation_detail(
    thread_id: str,
    ident=Depends(get_current_identity),
    db: Session = Depends(get_db),
):
    emp_id = int(ident["empresa_id"])
    uid = _resolve_colab_id(db, ident)
    _assert_participa(db, emp_id, thread_id, uid)

    head = db.execute(
        text(
            """
        SELECT titulo, participantes
          FROM chat_eventos
         WHERE empresa_id = :emp
           AND thread_id  = :tid
           AND kind = 'head'
         ORDER BY created_at ASC
         LIMIT 1
    """
        ),
        {"emp": emp_id, "tid": thread_id},
    ).mappings().first()

    last = db.execute(
        text(
            """
        SELECT texto AS last_texto, kind AS last_kind, created_at AS last_created_at
          FROM chat_eventos
         WHERE empresa_id = :emp
           AND thread_id  = :tid
           AND deleted_at IS NULL
         ORDER BY created_at DESC
         LIMIT 1
    """
        ),
        {"emp": emp_id, "tid": thread_id},
    ).mappings().first()

    return {
        "thread_id": thread_id,
        "titulo": (head or {}).get("titulo"),
        "participantes": (head or {}).get("participantes", []),
        **(last or {}),
    }


@router.get("/conversations/{thread_id}/messages")
def list_messages(
    thread_id: str,
    before: Optional[str] = Query(None, description="ISO 8601 (msg anteriores a)"),
    limit: int = Query(50, ge=1, le=200),
    ident=Depends(get_current_identity),
    db: Session = Depends(get_db),
):
    emp_id = int(ident["empresa_id"])
    uid = _resolve_colab_id(db, ident)
    _assert_participa(db, emp_id, thread_id, uid)

    cond: List[str] = []
    params = {"emp": emp_id, "tid": thread_id, "limit": limit}
    if before:
        cond.append("e.created_at < :before")
        params["before"] = before

    sql = text(
        f"""
        SELECT e.id, e.kind, e.autor_id, e.texto, e.titulo, e.created_at
          FROM chat_eventos e
         WHERE e.empresa_id = :emp
           AND e.thread_id  = :tid
           AND e.deleted_at IS NULL
           {'AND ' + ' AND '.join(cond) if cond else ''}
         ORDER BY e.created_at DESC
         LIMIT :limit
    """
    )
    rows = db.execute(sql, params).mappings().all()
    return [dict(r) for r in rows]


@router.post("/conversations/{thread_id}/messages", status_code=201)
def send_message(
    thread_id: str,
    payload: SendMessageIn = Body(...),
    ident=Depends(get_current_identity),
    db: Session = Depends(get_db),
):
    emp_id = int(ident["empresa_id"])
    uid = _resolve_colab_id(db, ident)
    _assert_participa(db, emp_id, thread_id, uid)

    texto = (payload.get("texto") or "").strip()
    if not texto:
        raise HTTPException(status_code=422, detail="Texto obrigatório")

    row = (
        db.execute(
            text(
                """
        INSERT INTO chat_eventos (empresa_id, thread_id, kind, autor_id, texto)
        VALUES (:emp, :tid, 'msg', :uid, :texto)
        RETURNING id, kind, autor_id, texto, created_at
    """
            ),
            {"emp": emp_id, "tid": thread_id, "uid": uid, "texto": texto},
        )
        .mappings()
        .first()
    )
    db.commit()

    # WS
    _broadcast_emp(
        emp_id,
        {
            "type": "message.created",
            "thread_id": thread_id,
            "id": row["id"],
            "autor_id": uid,
            "texto": row["texto"],
            "created_at": row["created_at"].isoformat(),
        },
    )

    return dict(row)


@router.post("/conversations/{thread_id}/read", status_code=204)
def mark_read(
    thread_id: str,
    ident=Depends(get_current_identity),
    db: Session = Depends(get_db),
):
    """Marca conversa como lida. Compatível com last_read_at e com banco antigo last_read."""
    emp_id = int(ident["empresa_id"])
    uid = _resolve_colab_id(db, ident)
    _assert_participa(db, emp_id, thread_id, uid)

    read_col = _chat_read_col(db)
    row = (
        db.execute(
            text(
                f"""
        INSERT INTO chat_read_state (empresa_id, thread_id, user_id, {read_col})
        VALUES (:emp, :tid, :uid, NOW())
        ON CONFLICT (empresa_id, thread_id, user_id)
        DO UPDATE SET {read_col} = EXCLUDED.{read_col}
        RETURNING {read_col} AS last_read_at
    """
            ),
            {"emp": emp_id, "tid": thread_id, "uid": uid},
        )
        .mappings()
        .first()
    )
    db.commit()

    last_read_at = (row or {}).get("last_read_at")
    _broadcast_emp(
        emp_id,
        {
            "type": "read.updated",
            "thread_id": thread_id,
            "user_id": uid,
            "last_read_at": last_read_at.isoformat() if hasattr(last_read_at, "isoformat") else None,
        },
    )
    return


@router.patch("/conversations/{thread_id}", status_code=204)
def rename_conversation(
    thread_id: str,
    payload: RenameIn = Body(...),
    ident=Depends(get_current_identity),
    db: Session = Depends(get_db),
):
    emp_id = int(ident["empresa_id"])
    uid = _resolve_colab_id(db, ident)
    _assert_participa(db, emp_id, thread_id, uid)

    titulo = (payload.get("titulo") or "").strip()
    if not titulo:
        raise HTTPException(status_code=422, detail="Título obrigatório")

    with db.begin():
        db.execute(
            text(
                """
            INSERT INTO chat_eventos (empresa_id, thread_id, kind, autor_id, texto)
            VALUES (:emp, :tid, 'system', :uid, :texto)
        """
            ),
            {
                "emp": emp_id,
                "tid": thread_id,
                "uid": uid,
                "texto": f"Título alterado para: {titulo}",
            },
        )

        db.execute(
            text(
                """
            UPDATE chat_eventos
               SET titulo = :titulo
             WHERE id = (
                SELECT id
                  FROM chat_eventos
                 WHERE empresa_id = :emp
                   AND thread_id  = :tid
                   AND kind = 'head'
                 ORDER BY created_at DESC
                 LIMIT 1
             )
        """
            ),
            {"emp": emp_id, "tid": thread_id, "titulo": titulo},
        )

    # WS
    _broadcast_emp(
        emp_id,
        {
            "type": "thread.renamed",
            "thread_id": thread_id,
            "titulo": titulo,
        },
    )
    return


@router.post("/conversations/{thread_id}/participants", status_code=204)
def update_participants(
    thread_id: str,
    payload: ParticipantsIn = Body(...),
    ident=Depends(get_current_identity),
    db: Session = Depends(get_db),
):
    emp_id = int(ident["empresa_id"])
    uid = _resolve_colab_id(db, ident)
    _assert_participa(db, emp_id, thread_id, uid)

    add = list(dict.fromkeys(payload.get("add") or []))
    rmv = set(payload.get("remove") or [])

    head = db.execute(
        text(
            """
        SELECT id, participantes
          FROM chat_eventos
         WHERE empresa_id = :emp
           AND thread_id  = :tid
           AND kind = 'head'
         ORDER BY created_at DESC
         LIMIT 1
    """
        ),
        {"emp": emp_id, "tid": thread_id},
    ).mappings().first()
    if not head:
        raise HTTPException(status_code=404, detail="HEAD não encontrado")

    parts: List[int] = list(head["participantes"] or [])
    parts = [p for p in parts if p not in rmv]
    for p in add:
        if p not in parts:
            parts.append(p)

    db.execute(
        text(
            """
        UPDATE chat_eventos
           SET participantes = :parts
         WHERE id = :id
    """
        ),
        {"parts": parts, "id": head["id"]},
    )
    db.commit()

    # WS
    _broadcast_emp(
        emp_id,
        {
            "type": "participants.updated",
            "thread_id": thread_id,
            "participantes": parts,
        },
    )
    return


# =====================================================================================
# WebSocket de compatibilidade (mesmo grupo do main: emp:{empresa_id})
# =====================================================================================


@router.websocket("/ws/{empresa_id}")
async def ws_internal_chat(websocket: WebSocket, empresa_id: int):
    """
    Compatível com o front que usa /api/internal-chat/ws/{empresa_id}.
    Encaminha para o mesmo grupo 'emp:{empresa_id}' do main.py.

    (A validação de qual empresa o usuário realmente pertence
     precisa estar no fluxo de autenticação WebSocket/global.)
    """
    group = f"emp:{empresa_id}"
    await conexoes_ativas.connect(websocket, group)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        await conexoes_ativas.disconnect(websocket, group)
