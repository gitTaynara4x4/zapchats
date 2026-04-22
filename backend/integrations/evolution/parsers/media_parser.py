#backend\integrations\evolution\parsers\media_parser.py

from __future__ import annotations

from typing import Any

from .base_extractors import _b64_to_bytes, extract_media_meta, normalize_mimetype


def _safe_str(v: Any) -> str:
    if v is None:
        return ""
    return str(v).strip()


def _guess_extension(filename: str | None, mimetype: str | None) -> str | None:
    name = _safe_str(filename).lower()
    mt = _safe_str(mimetype).lower()

    if "." in name:
        return name.rsplit(".", 1)[-1]

    if "image/jpeg" in mt:
        return "jpg"
    if "image/png" in mt:
        return "png"
    if "image/webp" in mt:
        return "webp"
    if "video/mp4" in mt:
        return "mp4"
    if "audio/ogg" in mt:
        return "ogg"
    if "audio/mpeg" in mt:
        return "mp3"
    if "application/pdf" in mt:
        return "pdf"

    return None


def parse_media_meta_from_message(message_item: dict) -> dict | None:
    meta = extract_media_meta(message_item)
    if not meta:
        return None

    tipo = _safe_str(meta.get("tipo")) or None
    filename = _safe_str(meta.get("filename")) or None
    mimetype = _safe_str(meta.get("mimetype")) or None
    base64_data = meta.get("base64")
    caption = _safe_str(meta.get("caption")) or None
    url = _safe_str(meta.get("url")) or None

    normalized_mimetype = normalize_mimetype(tipo, filename, mimetype) if tipo else mimetype
    extension = _guess_extension(filename, normalized_mimetype)

    size_bytes = None
    if base64_data:
        try:
            raw, mt_from = _b64_to_bytes(base64_data)
            if raw is not None:
                size_bytes = len(raw)
            if mt_from and (not normalized_mimetype or normalized_mimetype == "application/octet-stream"):
                normalized_mimetype = mt_from
        except Exception:
            pass

    tipo_norm = _safe_str(tipo).lower()

    return {
        "raw": meta,
        "tipo": tipo,
        "filename": filename,
        "mimetype": normalized_mimetype,
        "extension": extension,
        "caption": caption,
        "base64": base64_data,
        "url": url,
        "size_bytes": size_bytes,
        "has_binary_inline": bool(base64_data),
        "is_image": bool(tipo_norm in {"image", "imagem"}),
        "is_video": bool(tipo_norm == "video"),
        "is_audio": bool(tipo_norm == "audio"),
        "is_document": bool(tipo_norm in {"document", "documento", "arquivo", "pdf"}),
    }


def parse_media_meta(meta: dict | None) -> dict | None:
    if not meta or not isinstance(meta, dict):
        return None

    tipo = _safe_str(meta.get("tipo")) or None
    filename = _safe_str(meta.get("filename")) or None
    mimetype = _safe_str(meta.get("mimetype")) or None
    base64_data = meta.get("base64")
    caption = _safe_str(meta.get("caption")) or None
    url = _safe_str(meta.get("url")) or None

    normalized_mimetype = normalize_mimetype(tipo, filename, mimetype) if tipo else mimetype
    extension = _guess_extension(filename, normalized_mimetype)
    tipo_norm = _safe_str(tipo).lower()

    return {
        "raw": meta,
        "tipo": tipo,
        "filename": filename,
        "mimetype": normalized_mimetype,
        "extension": extension,
        "caption": caption,
        "base64": base64_data,
        "url": url,
        "has_binary_inline": bool(base64_data),
        "is_image": bool(tipo_norm in {"image", "imagem"}),
        "is_video": bool(tipo_norm == "video"),
        "is_audio": bool(tipo_norm == "audio"),
        "is_document": bool(tipo_norm in {"document", "documento", "arquivo", "pdf"}),
    }


def media_requires_download(parsed_media: dict | None) -> bool:
    if not parsed_media:
        return False
    if parsed_media.get("has_binary_inline"):
        return False
    return bool(parsed_media.get("tipo"))


__all__ = [
    "normalize_mimetype",
    "extract_media_meta",
    "_b64_to_bytes",
    "parse_media_meta_from_message",
    "parse_media_meta",
    "media_requires_download",
]