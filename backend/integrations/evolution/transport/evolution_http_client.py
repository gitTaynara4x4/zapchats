#backend\integrations\evolution\transport\evolution_http_client.py
from __future__ import annotations
import base64
import os
from typing import Any

import requests

from ..utils.log_utils import LOG


EVOLUTION_URL = (os.getenv("EVOLUTION_URL") or "").rstrip("/")
EVOLUTION_APIKEY = os.getenv("EVOLUTION_APIKEY") or os.getenv("EVOLUTION_KEY") or ""
HEADERS = {
    "apikey": EVOLUTION_APIKEY,
    "Content-Type": "application/json",
}


class EvolutionHttpClient:
    def __init__(self, base_url: str | None = None, apikey: str | None = None, timeout: int = 60):
        self.base_url = (base_url or EVOLUTION_URL or "").rstrip("/")
        self.apikey = apikey or EVOLUTION_APIKEY or ""
        self.timeout = int(timeout)

    @property
    def headers(self) -> dict[str, str]:
        return {
            "apikey": self.apikey,
            "Content-Type": "application/json",
        }

    def _url(self, path: str) -> str:
        path = str(path or "").lstrip("/")
        return f"{self.base_url}/{path}"

    def get(self, path: str, *, params: dict[str, Any] | None = None, timeout: int | None = None) -> requests.Response:
        return requests.get(
            self._url(path),
            headers=self.headers,
            params=params or {},
            timeout=timeout or self.timeout,
        )

    def post(self, path: str, *, json_body: dict[str, Any] | None = None, timeout: int | None = None) -> requests.Response:
        return requests.post(
            self._url(path),
            headers=self.headers,
            json=json_body or {},
            timeout=timeout or self.timeout,
        )

    def connect_instance(self, instance_name: str) -> dict[str, Any]:
        """
        Tenta GET primeiro e depois POST como fallback.
        """
        errors: list[str] = []

        try:
            r = self.get(f"instance/connect/{instance_name}", timeout=30)
            r.raise_for_status()
            return r.json() or {}
        except Exception as e:
            errors.append(f"GET: {e}")

        try:
            r = self.post(f"instance/connect/{instance_name}", json_body={}, timeout=30)
            r.raise_for_status()
            return r.json() or {}
        except Exception as e:
            errors.append(f"POST: {e}")

        raise RuntimeError(" | ".join(errors) if errors else "Falha ao conectar instância")

    def find_contacts(self, instance_name: str) -> dict[str, Any] | list[Any]:
        r = self.post(f"chat/findContacts/{instance_name}", json_body={"where": {}}, timeout=60)
        r.raise_for_status()
        return r.json()

    def find_chats(self, instance_name: str) -> dict[str, Any] | list[Any]:
        r = self.post(f"chat/findChats/{instance_name}", json_body={"where": {}}, timeout=60)
        r.raise_for_status()
        return r.json()

    def find_group_infos(self, instance_name: str, group_jid: str) -> dict[str, Any]:
        r = self.get(
            f"group/findGroupInfos/{instance_name}",
            params={"groupJid": group_jid},
            timeout=20,
        )
        r.raise_for_status()
        return r.json() or {}

    def get_group_subject(self, instance_name: str, group_jid: str) -> str | None:
        try:
            js = self.find_group_infos(instance_name, group_jid)
            subject = js.get("subject")
            if isinstance(subject, str) and subject.strip():
                return subject.strip()
        except Exception as e:
            LOG(f"[EVO_HTTP][group_subject] inst={instance_name} group={group_jid} err={e}")
        return None

    def get_base64_media(
        self,
        instance_name: str,
        msg_id: str,
        *,
        convert_to_mp4: bool | None = None,
    ) -> tuple[bytes | None, str | None, str | None, int | None]:
        """
        Tenta baixar mídia base64 da Evolution.
        Retorno: (raw_bytes, filename, mimetype, size)
        """
        body: dict[str, Any] = {
            "message": {"key": {"id": str(msg_id)}},
            "convertToMp4": bool(convert_to_mp4) if convert_to_mp4 is not None else False,
        }

        candidates = [
            f"chat/getBase64FromMediaMessage/{instance_name}",
            f"message/getBase64FromMediaMessage/{instance_name}",
        ]

        for path in candidates:
            try:
                r = self.post(path, json_body=body, timeout=120)
                if not r.ok:
                    continue

                js = r.json() or {}
                b64 = (
                    js.get("base64")
                    or js.get("data")
                    or (js.get("message") or {}).get("base64")
                    or (js.get("media") or {}).get("base64")
                )
                if not b64:
                    continue

                raw_b64 = str(b64)
                if "," in raw_b64:
                    raw_b64 = raw_b64.split(",", 1)[1]

                raw = base64.b64decode(raw_b64)
                name = js.get("fileName") or js.get("filename") or f"{msg_id}.bin"
                mimetype = js.get("mimetype") or js.get("mimeType") or js.get("contentType")
                size = len(raw) if raw is not None else None
                return raw, name, mimetype, size
            except Exception:
                continue

        return None, None, None, None

    def download_media_bytes(
        self,
        instance_name: str,
        msg_id: str,
        *,
        timeout: int = 120,
    ) -> tuple[bytes | None, str | None, str | None, int | None]:
        """
        Fallback bruto: tenta endpoints de mídia conhecidos.
        """
        candidates = [
            self._url(f"api/atendimento/midias/msg/{msg_id}"),
            self._url(f"chat/downloadMedia/{instance_name}/{msg_id}"),
            self._url(f"message/downloadMedia/{instance_name}/{msg_id}"),
        ]

        for url in candidates:
            try:
                r = requests.get(
                    url,
                    headers=self.headers,
                    timeout=timeout,
                    stream=False,
                )
                if not r.ok:
                    continue

                raw = r.content
                if not raw:
                    continue

                ctype = r.headers.get("Content-Type")
                dispo = r.headers.get("Content-Disposition") or ""
                filename = None

                if "filename=" in dispo:
                    filename = dispo.split("filename=", 1)[1].strip().strip('"').strip("'")

                return raw, filename or f"{msg_id}.bin", ctype, len(raw)
            except Exception:
                continue

        return None, None, None, None


_client = EvolutionHttpClient()


def evo_connect(instance_name: str) -> dict[str, Any]:
    return _client.connect_instance(instance_name)


def evo_find_contacts(instance_name: str) -> dict[str, Any] | list[Any]:
    return _client.find_contacts(instance_name)


def evo_find_chats(instance_name: str) -> dict[str, Any] | list[Any]:
    return _client.find_chats(instance_name)


def evo_find_group_infos(instance_name: str, group_jid: str) -> dict[str, Any]:
    return _client.find_group_infos(instance_name, group_jid)


def evo_get_group_subject(instance_name: str, group_jid: str) -> str | None:
    return _client.get_group_subject(instance_name, group_jid)


def evo_get_base64_media(
    instance_name: str,
    msg_id: str,
    *,
    convert_to_mp4: bool | None = None,
) -> tuple[bytes | None, str | None, str | None, int | None]:
    return _client.get_base64_media(instance_name, msg_id, convert_to_mp4=convert_to_mp4)


def evo_download_media_bytes(
    instance_name: str,
    msg_id: str,
    *,
    timeout: int = 120,
) -> tuple[bytes | None, str | None, str | None, int | None]:
    return _client.download_media_bytes(instance_name, msg_id, timeout=timeout)


# compat legado
_evo_connect = evo_connect
_evo_get_base64_media = evo_get_base64_media
_download_media_bytes = evo_download_media_bytes


__all__ = [
    "EVOLUTION_URL",
    "EVOLUTION_APIKEY",
    "HEADERS",
    "EvolutionHttpClient",
    "evo_connect",
    "evo_find_contacts",
    "evo_find_chats",
    "evo_find_group_infos",
    "evo_get_group_subject",
    "evo_get_base64_media",
    "evo_download_media_bytes",
    "_evo_connect",
    "_evo_get_base64_media",
    "_download_media_bytes",
]