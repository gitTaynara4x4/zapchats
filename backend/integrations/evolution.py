# backend/integrations/evolution.py
from __future__ import annotations

import os
import json
from typing import Any, Dict, Optional

import requests
from fastapi import HTTPException


class EvolutionClient:
    """
    Client mínimo para Evolution API v2.

    Rotas comuns (exemplos):
      - POST {EVOLUTION_URL}/message/sendText/{instance}
      - POST {EVOLUTION_URL}/message/sendMedia/{instance}
      - POST {EVOLUTION_URL}/message/sendWhatsAppAudio/{instance}
      - POST {EVOLUTION_URL}/message/sendSticker/{instance}
      - POST {EVOLUTION_URL}/message/sendContact/{instance}
      - POST {EVOLUTION_URL}/message/sendReaction/{instance}
      - POST {EVOLUTION_URL}/chat/getBase64FromMediaMessage/{instance}
      - GET  {EVOLUTION_URL}/instance/connectionState/{instance}   <-- (novo)
      - GET  {EVOLUTION_URL}/instance/connect/{instance}           <-- (opcional)

    As credenciais são lidas de:
      - EVOLUTION_URL
      - EVOLUTION_APIKEY (ou EVOLUTION_KEY)
    """

    def __init__(self, base_url: Optional[str] = None, apikey: Optional[str] = None) -> None:
        self.base_url = (base_url or os.getenv("EVOLUTION_URL", "")).rstrip("/")
        self.apikey = apikey or os.getenv("EVOLUTION_APIKEY") or os.getenv("EVOLUTION_KEY")

        if not self.base_url:
            raise RuntimeError("EVOLUTION_URL não configurada")
        if not self.apikey:
            raise RuntimeError("EVOLUTION_APIKEY/EVOLUTION_KEY não configurada")

        self._headers = {
            "Content-Type": "application/json",
            "apikey": self.apikey,
        }

    # ---------------- core http ----------------
    def _post(self, path: str, instance: str, payload: Dict[str, Any], timeout: int = 40) -> Dict[str, Any]:
        url = f"{self.base_url}{path}/{instance}"
        resp = requests.post(url, headers=self._headers, data=json.dumps(payload), timeout=timeout)
        if resp.status_code >= 400:
            # Deixe a mensagem da Evolution aparecer para facilitar debug
            raise HTTPException(resp.status_code, f"Evolution error {resp.status_code}: {resp.text}")
        try:
            return resp.json()
        except Exception:
            return {"raw": resp.text}

    # === NOVO: GET genérico ===
    def _get(self, path: str, instance: str, timeout: int = 20) -> Dict[str, Any]:
        url = f"{self.base_url}{path}/{instance}"
        resp = requests.get(url, headers=self._headers, timeout=timeout)
        if resp.status_code >= 400:
            raise HTTPException(resp.status_code, f"Evolution error {resp.status_code}: {resp.text}")
        try:
            return resp.json()
        except Exception:
            return {"raw": resp.text}

    # ---------------- envios -------------------
    def send_text(self, instance: str, *, number: str, text: str, **opts) -> Dict[str, Any]:
        body: Dict[str, Any] = {"number": number, "text": text}
        body.update({k: v for k, v in opts.items() if v is not None})
        return self._post("/message/sendText", instance, body)

    def send_media(
        self,
        instance: str,
        *,
        number: str,
        mediatype: str,
        media: str,
        mimetype: Optional[str] = None,
        caption: Optional[str] = None,
        fileName: Optional[str] = None,
        **opts,
    ) -> Dict[str, Any]:
        body: Dict[str, Any] = {
            "number": number,
            "mediatype": mediatype,
            "media": media,
        }
        if mimetype:
            body["mimetype"] = mimetype
        if caption:
            body["caption"] = caption
        if fileName:
            body["fileName"] = fileName
        body.update({k: v for k, v in opts.items() if v is not None})
        return self._post("/message/sendMedia", instance, body)

    def send_audio(self, instance: str, *, number: str, audio: str, **opts) -> Dict[str, Any]:
        # Evolution costuma aceitar "sendWhatsAppAudio" para base64/URL de áudio.
        body: Dict[str, Any] = {"number": number, "audio": audio}
        body.update({k: v for k, v in opts.items() if v is not None})
        return self._post("/message/sendWhatsAppAudio", instance, body)

    def send_sticker(self, instance: str, *, number: str, sticker: str, **opts) -> Dict[str, Any]:
        body: Dict[str, Any] = {"number": number, "sticker": sticker}
        body.update({k: v for k, v in opts.items() if v is not None})
        return self._post("/message/sendSticker", instance, body)

    def send_contact(self, instance: str, *, number: str, contact: list[dict], **opts) -> Dict[str, Any]:
        body: Dict[str, Any] = {"number": number, "contact": contact}
        body.update({k: v for k, v in opts.items() if v is not None})
        return self._post("/message/sendContact", instance, body)

    def send_reaction(self, instance: str, *, key: dict, reaction: str) -> Dict[str, Any]:
        body = {"key": key, "reaction": reaction}
        return self._post("/message/sendReaction", instance, body)

    # -------------- mídias recebidas -----------\
    def get_base64_from_message(self, instance: str, *, message: dict, convert_to_mp4: bool = False) -> Dict[str, Any]:
        """
        message: objeto com "key": { id, remoteJid?, fromMe? } — a Evolution aceita variações.
        convert_to_mp4=True ajuda para áudios/ptt em alguns cenários.
        """
        body = {"message": message, "convertToMp4": bool(convert_to_mp4)}
        return self._post("/chat/getBase64FromMediaMessage", instance, body)

    # -------------- ESTADO / CONEXÃO (NOVOS) --------------
    def get_connection_state(self, instance: str) -> Dict[str, Any]:
        """
        GET /instance/connectionState/{instance}
        Retorna algo como:
          {"instance":{"instanceName":"teste-docs","state":"open"}}
        """
        return self._get("/instance/connectionState", instance)

    def connect(self, instance: str) -> Dict[str, Any]:
        """
        GET /instance/connect/{instance}
        Útil para forçar tentativa de conexão / emitir QR no servidor Evolution.
        """
        return self._get("/instance/connect", instance)