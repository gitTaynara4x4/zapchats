#backend\integrations\evolution\repositories\grupos_repo.py

from __future__ import annotations
from typing import Optional
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from backend import models
from ..utils.time_utils import _int_unix


def _stamp_inst(obj, inst) -> None:
    if obj is None or inst is None:
        return
    if hasattr(obj, "instancia_id") and getattr(obj, "instancia_id", None) is None:
        setattr(obj, "instancia_id", getattr(inst, "id", None))
    if hasattr(obj, "instance_name") and not getattr(obj, "instance_name", None):
        setattr(obj, "instance_name", getattr(inst, "instance_name", None))


def _name_from_chat_like(c: dict) -> str | None:
    for k in (
        "verifiedName",
        "name",
        "pushName",
        "notifyName",
        "formattedName",
        "shortName",
        "contactName",
        "subject",
        "title",
        "displayName",
    ):
        v = c.get(k)
        if isinstance(v, str) and v.strip():
            return v.strip()
    return None


def _avatar_from_chat_like(c: dict) -> str | None:
    return (
        c.get("profilePicUrl")
        or (c.get("profilePicThumbObj") or {}).get("eurl")
        or c.get("thumbnailUrl")
        or c.get("imageUrl")
        or c.get("pictureUrl")
        or None
    )


def get_grupo_by_remote(
    db: Session,
    *,
    empresa_id: int,
    remote_jid: str,
) -> Optional[models.Grupo]:
    raw = str(remote_jid or "").strip()
    if not raw:
        return None

    return (
        db.query(models.Grupo)
        .filter(
            models.Grupo.empresa_id == int(empresa_id),
            models.Grupo.remote_jid == raw,
        )
        .first()
    )


def get_or_create_grupo_by_remote(
    db: Session,
    *,
    empresa_id: int,
    remote_jid: str,
    instancia_id: int | None = None,
    inst_obj: models.EmpresaInstancia | None = None,
    nome_padrao: str = "Grupo",
) -> models.Grupo:
    g = get_grupo_by_remote(db, empresa_id=empresa_id, remote_jid=remote_jid)
    if g:
        if instancia_id and getattr(g, "instancia_id", None) is None:
            g.instancia_id = int(instancia_id)
        if inst_obj and hasattr(g, "instance_name") and not getattr(g, "instance_name", None):
            g.instance_name = getattr(inst_obj, "instance_name", None)
        return g

    g = models.Grupo(
        empresa_id=int(empresa_id),
        remote_jid=str(remote_jid),
        nome=nome_padrao,
        instancia_id=(int(instancia_id) if instancia_id is not None else None),
    )
    if inst_obj and hasattr(g, "instance_name"):
        g.instance_name = getattr(inst_obj, "instance_name", None)

    db.add(g)
    db.flush()
    return g


def update_grupo_metadata(
    db: Session,
    *,
    grupo: models.Grupo,
    nome: str | None = None,
    avatar_url: str | None = None,
    inst_obj: models.EmpresaInstancia | None = None,
) -> bool:
    changed = False

    if nome is not None and str(nome).strip() and getattr(grupo, "nome", None) != str(nome).strip():
        grupo.nome = str(nome).strip()
        changed = True

    if avatar_url is not None and getattr(grupo, "avatar_url", None) != avatar_url:
        grupo.avatar_url = avatar_url
        changed = True

    if inst_obj is not None:
        before_instancia = getattr(grupo, "instancia_id", None)
        _stamp_inst(grupo, inst_obj)
        if getattr(grupo, "instancia_id", None) != before_instancia:
            changed = True

    return changed


def find_group_message_by_msgid(
    db: Session,
    *,
    grupo_id: int,
    msg_id: str,
) -> Optional[models.MensagemGrupo]:
    raw = str(msg_id or "").strip()
    if not raw:
        return None

    return (
        db.query(models.MensagemGrupo)
        .filter(
            models.MensagemGrupo.grupo_id == int(grupo_id),
            models.MensagemGrupo.msg_id == raw,
        )
        .first()
    )


def insert_group_message(
    db: Session,
    *,
    empresa_id: int,
    grupo_id: int,
    instancia_id: int | None,
    author_jid: str | None,
    from_me: bool,
    conteudo: str,
    tipo: str,
    message_type: str | None,
    lida: bool,
    timestamp_dt,
    msg_id: str | None,
    ack: int | None,
    inst_obj: models.EmpresaInstancia | None = None,
) -> tuple[int | None, bool]:
    if msg_id:
        existente = find_group_message_by_msgid(db, grupo_id=grupo_id, msg_id=msg_id)
        if existente:
            return getattr(existente, "id", None), False

    gm = models.MensagemGrupo(
        empresa_id=int(empresa_id),
        grupo_id=int(grupo_id),
        instancia_id=(int(instancia_id) if instancia_id is not None else None),
        author_jid=(str(author_jid).strip() if author_jid else None),
        from_me=bool(from_me),
        conteudo=conteudo,
        tipo=tipo,
        message_type=message_type,
        lida=bool(lida),
        timestamp=_int_unix(timestamp_dt),
        msg_id=(str(msg_id).strip() if msg_id else None),
        ack=ack,
    )

    if inst_obj is not None:
        _stamp_inst(gm, inst_obj)

    db.add(gm)

    try:
        db.flush()
        return getattr(gm, "id", None), True
    except IntegrityError:
        try:
            db.rollback()
        except Exception:
            pass

        if msg_id:
            existente = find_group_message_by_msgid(db, grupo_id=grupo_id, msg_id=msg_id)
            if existente:
                return getattr(existente, "id", None), False
        raise


def count_grupos_by_empresa(db: Session, *, empresa_id: int) -> int:
    return (
        db.query(models.Grupo)
        .filter(models.Grupo.empresa_id == int(empresa_id))
        .count()
    )


def upsert_grupos_from_chats(
    db: Session,
    *,
    empresa_id: int,
    chats: list[dict],
    inst: models.EmpresaInstancia,
) -> int:
    imported = 0

    for ch in chats:
        jid = (ch.get("id") or ch.get("remoteJid") or ch.get("jid") or ch.get("wid") or "")
        if not isinstance(jid, str) or not jid.endswith("@g.us"):
            continue

        nome = _name_from_chat_like(ch) or "Grupo"
        avatar = _avatar_from_chat_like(ch)

        g = get_grupo_by_remote(db, empresa_id=empresa_id, remote_jid=jid)
        if not g:
            g = models.Grupo(
                empresa_id=int(empresa_id),
                remote_jid=jid,
                nome=nome,
                avatar_url=avatar,
                instancia_id=getattr(inst, "id", None),
            )
            if hasattr(g, "instance_name"):
                g.instance_name = getattr(inst, "instance_name", None)
            db.add(g)
            imported += 1
        else:
            changed = False
            if getattr(g, "instancia_id", None) is None:
                g.instancia_id = getattr(inst, "id", None)
                changed = True
            if hasattr(g, "instance_name") and not getattr(g, "instance_name", None):
                g.instance_name = getattr(inst, "instance_name", None)
                changed = True
            if nome and (g.nome or "") != nome:
                g.nome = nome
                changed = True
            if avatar and (g.avatar_url or "") != avatar:
                g.avatar_url = avatar
                changed = True
            if changed:
                imported += 1

    if imported:
        db.flush()

    return imported


__all__ = [
    "get_grupo_by_remote",
    "get_or_create_grupo_by_remote",
    "update_grupo_metadata",
    "find_group_message_by_msgid",
    "insert_group_message",
    "count_grupos_by_empresa",
    "upsert_grupos_from_chats",
]
