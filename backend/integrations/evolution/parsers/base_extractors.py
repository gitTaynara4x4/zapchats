# backend/integrations/evolution/parsers/base_extractors.py

from __future__ import annotations
import base64
import mimetypes
from typing import Any, Iterable


def _unwrap_baileys_layers(obj: dict) -> dict:
    """
    Baileys costuma embrulhar a mensagem em camadas:
    message -> ephemeralMessage -> message -> viewOnceMessage -> message -> ...
    """
    if not isinstance(obj, dict):
        return {}

    m = obj.get("message") if isinstance(obj.get("message"), dict) else obj
    if not isinstance(m, dict):
        return {}

    wrappers = (
        "ephemeralMessage",
        "viewOnceMessage",
        "viewOnceMessageV2",
        "viewOnceMessageV2Extension",
        "editedMessage",
        "documentWithCaptionMessage",
    )

    for _ in range(10):
        progressed = False

        for key in wrappers:
            if key in m and isinstance(m.get(key), dict):
                inner = m.get(key) or {}
                if isinstance(inner.get("message"), dict):
                    m = inner["message"]
                    progressed = True
                    break
                m = inner
                progressed = True
                break

        if not progressed and isinstance(m.get("message"), dict):
            m = m["message"]
            progressed = True

        if not progressed:
            break

        if not isinstance(m, dict):
            return {}

    return m if isinstance(m, dict) else {}


def extract_text_from_baileys(obj: dict) -> str:
    if not isinstance(obj, dict):
        return ""

    m = _unwrap_baileys_layers(obj)
    if not isinstance(m, dict):
        return ""

    if "conversation" in m:
        return m["conversation"] or ""

    if "extendedTextMessage" in m:
        return (m["extendedTextMessage"] or {}).get("text") or ""

    if "buttonsResponseMessage" in m:
        brm = m.get("buttonsResponseMessage") or {}
        return brm.get("selectedDisplayText") or brm.get("selectedButtonId") or "[Botão]"

    if "templateButtonReplyMessage" in m:
        tbr = m.get("templateButtonReplyMessage") or {}
        return tbr.get("selectedDisplayText") or tbr.get("selectedId") or "[Botão]"

    if "listResponseMessage" in m:
        lrm = m.get("listResponseMessage") or {}
        ss = lrm.get("singleSelectReply") or {}
        selected = ss.get("selectedRowId") or lrm.get("selectedRowId") or lrm.get("title")
        return selected or "[Lista]"

    if "interactiveResponseMessage" in m:
        irm = m.get("interactiveResponseMessage") or {}
        resp = irm.get("nativeFlowResponseMessage") or {}
        text = (resp.get("paramsJson") or "").strip()
        return text or "[Interativo]"

    if "reactionMessage" in m:
        rm = m.get("reactionMessage") or {}
        text = str(rm.get("text") or "").strip()
        # Não mostrar key/id técnico da mensagem reagida no chat.
        # A key continua no payload bruto/metadata quando necessário; o texto visual fica limpo.
        return f"[Reação] {text}" if text else "[Reação]"

    if "imageMessage" in m:
        return (m["imageMessage"] or {}).get("caption") or "[Imagem]"

    if "videoMessage" in m:
        return (m["videoMessage"] or {}).get("caption") or "[Vídeo]"

    if "audioMessage" in m:
        am = m.get("audioMessage") or {}
        return "[Áudio/ptt]" if am.get("ptt", False) else "[Áudio]"

    if "stickerMessage" in m:
        return "[Figurinha]"

    if "documentMessage" in m:
        dm = m.get("documentMessage") or {}
        name = dm.get("fileName")
        return f"[Documento] {name}" if name else "[Documento]"

    if "contactMessage" in m:
        cm = m.get("contactMessage") or {}
        return f"[Contato] {cm.get('displayName') or ''}".strip()

    if "contactsArrayMessage" in m:
        cam = m.get("contactsArrayMessage") or {}
        return f"[Contatos] {len(cam.get('contacts', []))}"

    if "locationMessage" in m:
        lm = m.get("locationMessage") or {}
        name = lm.get("name") or lm.get("address")
        return f"[Localização] {name}" if name else "[Localização]"

    if "protocolMessage" in m:
        pm = m.get("protocolMessage") or {}
        return "[Mensagem apagada]" if pm.get("type") == 0 else "[Evento]"

    if "orderMessage" in m:
        om = m.get("orderMessage") or {}
        return f"[Pedido] {(om.get('orderTitle') or '').strip()}".strip()

    return "[Mensagem recebida]"


def extract_media_meta(msg_obj: dict) -> dict[str, Any] | None:
    m = _unwrap_baileys_layers(msg_obj or {})
    if not isinstance(m, dict):
        return None

    if "imageMessage" in m:
        im = m["imageMessage"] or {}
        return {
            "tipo": "image",
            "mimetype": im.get("mimetype") or "image/jpeg",
            "filename": im.get("fileName") or "image.jpg",
            "url": im.get("url") or im.get("directPath"),
            "caption": im.get("caption") or None,
            "fileLength": im.get("fileLength"),
            "base64": im.get("base64") or im.get("fileBase64") or im.get("data") or None,
        }

    if "videoMessage" in m:
        vi = m["videoMessage"] or {}
        return {
            "tipo": "video",
            "mimetype": vi.get("mimetype") or "video/mp4",
            "filename": vi.get("fileName") or "video.mp4",
            "url": vi.get("url") or vi.get("directPath"),
            "caption": vi.get("caption") or None,
            "fileLength": vi.get("fileLength"),
            "base64": vi.get("base64") or vi.get("fileBase64") or vi.get("data") or None,
        }

    if "audioMessage" in m:
        au = m["audioMessage"] or {}
        return {
            "tipo": "audio",
            "mimetype": au.get("mimetype") or "audio/ogg",
            "filename": "ptt.ogg" if au.get("ptt") else "audio.ogg",
            "url": au.get("url") or au.get("directPath"),
            "caption": None,
            "fileLength": au.get("fileLength"),
            "base64": au.get("base64") or au.get("fileBase64") or au.get("data") or None,
        }

    if "documentMessage" in m:
        dm = m["documentMessage"] or {}
        fname = dm.get("fileName") or "document"
        mt = dm.get("mimetype") or mimetypes.guess_type(fname)[0] or "application/octet-stream"
        return {
            "tipo": "document",
            "mimetype": mt,
            "filename": fname,
            "url": dm.get("url") or dm.get("directPath"),
            "caption": None,
            "fileLength": dm.get("fileLength"),
            "base64": dm.get("base64") or dm.get("fileBase64") or dm.get("data") or None,
        }

    if "stickerMessage" in m:
        st = m["stickerMessage"] or {}
        return {
            "tipo": "sticker",
            "mimetype": st.get("mimetype") or "image/webp",
            "filename": "sticker.webp",
            "url": st.get("url") or st.get("directPath"),
            "fileLength": st.get("fileLength"),
            "base64": st.get("base64") or st.get("fileBase64") or st.get("data") or None,
        }

    return None


def _b64_to_bytes(data_str: str) -> tuple[bytes, str | None]:
    if not data_str:
        return b"", None

    s = data_str.strip()
    mimetype_ = None

    if s.startswith("data:"):
        try:
            header, b64 = s.split(",", 1)
            if header.startswith("data:"):
                mt = header[5:]
                if ";" in mt:
                    mt = mt.split(";", 1)[0]
                mimetype_ = mt or None
            s = b64
        except Exception:
            pass

    try:
        return base64.b64decode(s, validate=False), mimetype_
    except Exception:
        return b"", mimetype_


def _guess_default_mimetype(tipo: str | None, filename: str | None, fallback: str = "application/octet-stream") -> str:
    tipo_norm = str(tipo or "").strip().lower()

    if tipo_norm in {"image", "imagem"}:
        return "image/jpeg"
    if tipo_norm == "video":
        return "video/mp4"
    if tipo_norm == "audio":
        return "audio/ogg"
    if tipo_norm == "sticker":
        return "image/webp"
    if tipo_norm in {"document", "documento", "arquivo", "pdf"}:
        if filename:
            guessed = mimetypes.guess_type(filename)[0]
            if guessed:
                return guessed
        return "application/octet-stream"

    if filename:
        guessed = mimetypes.guess_type(filename)[0]
        if guessed:
            return guessed

    return fallback


def normalize_mimetype(tipo: str | None, filename: str | None, mimetype_: str | None) -> str:
    mt = str(mimetype_ or "").strip().lower()
    if (not mt) or ("/" not in mt) or mt in {
        "application",
        "image",
        "video",
        "audio",
        "sticker",
        "application/octet-stream",
    }:
        mt = _guess_default_mimetype(tipo, filename, "application/octet-stream")
    return mt


def _iter_all_nodes(root: Any) -> Iterable[Any]:
    queue = [root]
    while queue:
        cur = queue.pop(0)
        yield cur
        if isinstance(cur, dict):
            queue.extend(cur.values())
        elif isinstance(cur, list):
            queue.extend(cur)


def _looks_like_message(d: dict) -> bool:
    if not isinstance(d, dict):
        return False
    if isinstance(d.get("key"), dict):
        return True
    jid = d.get("remoteJid") or d.get("remote_jid") or d.get("jid") or d.get("chatId")
    if isinstance(jid, str) and jid:
        return True
    return False


def _looks_like_contact(d: dict) -> bool:
    if not isinstance(d, dict):
        return False
    if _looks_like_message(d):
        return False
    has_remote = any(isinstance(d.get(k), str) and d.get(k) for k in ("remoteJid", "id", "jid", "wid", "user"))
    has_nameish = any(
        isinstance(d.get(k), str) and d.get(k)
        for k in (
            "verifiedName",
            "name",
            "pushName",
            "notifyName",
            "formattedName",
            "shortName",
            "contactName",
            "displayName",
            "fullName",
            "subject",
            "title",
        )
    )
    return has_remote and (has_nameish or "profilePicUrl" in d or "profilePicThumbObj" in d)


def _looks_like_chat(d: dict) -> bool:
    if not isinstance(d, dict):
        return False
    has_remote = any(isinstance(d.get(k), str) and d.get(k) for k in ("remoteJid", "id", "jid", "wid"))
    has_chat_markers = any(k in d for k in ("unreadCount", "archived", "pinned", "muteEndTime", "muted"))
    return has_remote and has_chat_markers


def _collect_direct_list(data: Any, keys: tuple[str, ...]) -> list[dict]:
    if isinstance(data, list) and all(isinstance(x, dict) for x in data):
        return data

    if isinstance(data, dict):
        for key in keys:
            value = data.get(key)
            if isinstance(value, list) and value and all(isinstance(x, dict) for x in value):
                return value
    return []


def extract_messages_any_shape(data: Any) -> list[dict]:
    def _msg_id_any(m: dict) -> str | None:
        if not isinstance(m, dict):
            return None

        paths = [
            ("key", "id"),
            ("id",),
            ("keyId",),
            ("message", "key", "id"),
            ("messageId",),
        ]

        for path in paths:
            cur: Any = m
            ok = True
            for part in path:
                if isinstance(cur, dict) and part in cur:
                    cur = cur[part]
                else:
                    ok = False
                    break
            if ok and isinstance(cur, str) and cur.strip():
                return cur.strip()

        return None

    def _richness(m: dict) -> int:
        if not isinstance(m, dict):
            return 0
        score = len(m)
        if "message" in m:
            score += 50
        if "messageTimestamp" in m or "timestamp" in m:
            score += 5
        inner = m.get("message")
        if isinstance(inner, dict):
            score += len(inner)
        return score

    candidates = _collect_direct_list(data, ("messages", "msgs", "items", "result", "rows", "data", "list", "payload", "store"))

    if not candidates:
        out: list[dict] = []
        for node in _iter_all_nodes(data):
            if isinstance(node, list) and node and all(isinstance(x, dict) for x in node):
                likes = sum(1 for x in node if _looks_like_message(x))
                if likes >= max(1, len(node) // 3):
                    out.extend(node)
            elif isinstance(node, dict) and _looks_like_message(node):
                out.append(node)
        candidates = out

    uniq: dict[str, dict] = {}
    noid_bucket: list[dict] = []

    for m in candidates:
        if not isinstance(m, dict):
            continue

        mid = _msg_id_any(m)
        if mid:
            old = uniq.get(mid)
            if old is None or _richness(m) > _richness(old):
                uniq[mid] = m
        else:
            noid_bucket.append(m)

    return list(uniq.values()) + noid_bucket


def extract_contacts_any_shape(data: Any) -> list[dict]:
    candidates = _collect_direct_list(
        data,
        ("contacts", "items", "result", "rows", "data", "list", "payload", "store"),
    )

    if not candidates:
        out: list[dict] = []
        for node in _iter_all_nodes(data):
            if isinstance(node, list) and node and all(isinstance(x, dict) for x in node):
                likes = sum(1 for x in node if _looks_like_contact(x))
                if likes >= max(1, len(node) // 3):
                    out.extend(node)
            elif isinstance(node, dict) and _looks_like_contact(node):
                out.append(node)
        candidates = out

    seen: set[str] = set()
    result: list[dict] = []

    for c in candidates:
        if not isinstance(c, dict):
            continue
        key = str(
            c.get("remoteJid")
            or c.get("id")
            or c.get("jid")
            or c.get("wid")
            or c.get("user")
            or ""
        ).strip()
        if key and key in seen:
            continue
        if key:
            seen.add(key)
        result.append(c)

    return result


def extract_chats_any_shape(data: Any) -> list[dict]:
    candidates = _collect_direct_list(
        data,
        ("chats", "items", "result", "rows", "data", "list", "payload", "store"),
    )

    if not candidates:
        out: list[dict] = []
        for node in _iter_all_nodes(data):
            if isinstance(node, list) and node and all(isinstance(x, dict) for x in node):
                likes = sum(1 for x in node if _looks_like_chat(x))
                if likes >= max(1, len(node) // 3):
                    out.extend(node)
            elif isinstance(node, dict) and _looks_like_chat(node):
                out.append(node)
        candidates = out

    seen: set[str] = set()
    result: list[dict] = []

    for c in candidates:
        if not isinstance(c, dict):
            continue
        key = str(
            c.get("id")
            or c.get("remoteJid")
            or c.get("jid")
            or c.get("wid")
            or ""
        ).strip()
        if key and key in seen:
            continue
        if key:
            seen.add(key)
        result.append(c)

    return result


__all__ = [
    "_b64_to_bytes",
    "normalize_mimetype",
    "extract_text_from_baileys",
    "extract_media_meta",
    "extract_messages_any_shape",
    "extract_contacts_any_shape",
    "extract_chats_any_shape",
]