# backend/integrations/evolution.py
from __future__ import annotations

import os
import json
import re
from datetime import datetime, timezone
from typing import Any, Dict, Optional, Tuple

import requests
from fastapi import APIRouter, Body, Header, HTTPException, Query


# =========================
# FastAPI Router (NO MESMO ARQUIVO)
# =========================
router = APIRouter(tags=["Evolution"])


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _only_digits(s: Any) -> str:
    return re.sub(r"\D", "", str(s or ""))


def _infer_state(obj: Any) -> str:
    """
    Tenta achar um "state/status" num JSON de retorno da Evolution.
    """
    if not isinstance(obj, dict):
        return ""
    # formatos comuns
    inst = obj.get("instance")
    if isinstance(inst, dict):
        st = inst.get("state") or inst.get("status") or inst.get("connectionState")
        if isinstance(st, str):
            return st.strip()
    st2 = obj.get("state") or obj.get("status") or obj.get("connectionState")
    return st2.strip() if isinstance(st2, str) else ""


def _infer_connected(obj: Any) -> Optional[bool]:
    """
    Decide connected True/False quando possível.
    Retorna None se não dá pra inferir.
    """
    if isinstance(obj, dict):
        # se vier explícito
        if "connected" in obj:
            return bool(obj.get("connected"))

        # state/status
        st = _infer_state(obj).lower()
        if st:
            if st in ("open", "connected", "online", "ready"):
                return True
            if st in ("close", "closed", "disconnected", "offline", "logout", "loggedout"):
                return False

        # alguns retornos mandam algo tipo "connection": "open"
        c = obj.get("connection") or obj.get("connection_state") or obj.get("connectionState")
        if isinstance(c, str):
            cl = c.lower().strip()
            if cl in ("open", "connected"):
                return True
            if cl in ("close", "closed", "disconnected"):
                return False

    return None


# =========================
# Evolution Client
# =========================
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

    Rotas de estado (varia por versão):
      - GET  {EVOLUTION_URL}/instance/connectionState/{instance}
      - GET  {EVOLUTION_URL}/instance/connect/{instance}
      - POST {EVOLUTION_URL}/instance/setPresence/{instance}

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
            raise HTTPException(resp.status_code, f"Evolution error {resp.status_code}: {resp.text}")
        try:
            return resp.json()
        except Exception:
            return {"raw": resp.text}

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

    def get_base64_from_message(self, instance: str, *, message: dict, convert_to_mp4: bool = False) -> Dict[str, Any]:
        body = {"message": message, "convertToMp4": bool(convert_to_mp4)}
        return self._post("/chat/getBase64FromMediaMessage", instance, body)

    # -------------- ESTADO / CONEXÃO --------------
    def get_connection_state(self, instance: str) -> Dict[str, Any]:
        return self._get("/instance/connectionState", instance)

    def connect(self, instance: str) -> Dict[str, Any]:
        return self._get("/instance/connect", instance)

    def set_presence(self, instance: str, *, presence: str = "available", **extra) -> Dict[str, Any]:
        """
        POST /instance/setPresence/{instance}
        Em algumas versões, presence pode ser "available"/"unavailable".
        """
        body: Dict[str, Any] = {}
        if presence:
            body["presence"] = presence
        body.update({k: v for k, v in extra.items() if v is not None})
        return self._post("/instance/setPresence", instance, body, timeout=20)


# =========================
# Endpoints (NO MESMO ARQUIVO)
# =========================
def _resolve_connected_from_calls(
    evo: EvolutionClient,
    instance: str,
    presence: str,
) -> Tuple[bool, str, Dict[str, Any], Optional[Dict[str, Any]]]:
    """
    1) chama setPresence (como você pediu: BASE do status)
    2) tenta connectionState (se existir) pra bater 100% e devolver connected real
    """
    js_presence = evo.set_presence(instance, presence=presence)

    # primeiro chute baseado no retorno do setPresence
    st1 = _infer_state(js_presence)
    c1 = _infer_connected(js_presence)

    js_state: Optional[Dict[str, Any]] = None
    st2 = ""
    c2: Optional[bool] = None

    # tenta confirmar via connectionState (quando existir na sua versão)
    try:
        js_state = evo.get_connection_state(instance)
        st2 = _infer_state(js_state)
        c2 = _infer_connected(js_state)
    except Exception:
        js_state = None

    # decide final
    connected: bool
    state: str

    if c2 is not None:
        connected = bool(c2)
        state = st2 or st1
    elif c1 is not None:
        connected = bool(c1)
        state = st1 or st2
    else:
        # sem inferência clara → considera "não conectado"
        connected = False
        state = st2 or st1 or ""

    return connected, state, js_presence, js_state


@router.post("/instance/setPresence/{instance}")
def api_set_presence(
    instance: str,
    presence: str = Query("available"),
    body: Dict[str, Any] = Body(default_factory=dict),
    x_empresa_id: Optional[str] = Header(None, alias="X-Empresa-Id"),
):
    """
    O FRONT chama EXATAMENTE:
      {{baseUrl}}/instance/setPresence/{instance}

    Esse endpoint:
      - chama a Evolution (setPresence)
      - tenta confirmar state via connectionState
      - devolve { ok, connected, state, ... }
    """
    evo = EvolutionClient()

    # permite passar campos extras no body, mas sem obrigar nada
    extra = body if isinstance(body, dict) else {}

    try:
        connected, state, js_presence, js_state = _resolve_connected_from_calls(
            evo, instance, presence
        )

        # opcional: tenta extrair um número se vier no payload (algumas versões mandam wid/id)
        me_number = ""
        try:
            # alguns retornos podem trazer "me": {"id": "5511...@s.whatsapp.net"} etc
            cand = ""
            if isinstance(js_state, dict):
                inst = js_state.get("instance") if isinstance(js_state.get("instance"), dict) else {}
                cand = (inst.get("id") or inst.get("wid") or inst.get("me"))
                if isinstance(cand, dict):
                    cand = cand.get("id") or ""
            if isinstance(cand, str) and "@s.whatsapp.net" in cand:
                me_number = _only_digits(cand.split("@", 1)[0])
        except Exception:
            me_number = ""

        return {
            "ok": True,
            "instance": instance,
            "connected": bool(connected),
            "state": state,
            "presence": presence,
            "me_number": me_number or None,
            "evolution_presence": js_presence,
            "evolution_state": js_state,
        }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"Falha no setPresence proxy: {e}")


@router.get("/instance/connectionState/{instance}")
def api_connection_state(instance: str):
    """
    Útil pra debug/manual. (Não depende do WS/Rabbit)
    """
    evo = EvolutionClient()
    js = evo.get_connection_state(instance)
    return {
        "ok": True,
        "instance": instance,
        "connected": _infer_connected(js),
        "state": _infer_state(js),
        "evolution": js,
    }


@router.get("/instance/connect/{instance}")
def api_connect(instance: str):
    """
    Útil pra forçar o connect / QR do lado da Evolution.
    """
    evo = EvolutionClient()
    js = evo.connect(instance)
    return {
        "ok": True,
        "instance": instance,
        "evolution": js,
    }


__all__ = ["EvolutionClient", "router"]
