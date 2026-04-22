from __future__ import annotations

import json
import os
import re
from datetime import datetime, timezone
from typing import Any, Dict, Optional, Tuple

import requests
from fastapi import APIRouter, Body, Header, HTTPException, Query

router = APIRouter(tags=["Evolution"])


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _only_digits(s: Any) -> str:
    return re.sub(r"\D", "", str(s or ""))


def _infer_state(obj: Any) -> str:
    if not isinstance(obj, dict):
        return ""

    inst = obj.get("instance")
    if isinstance(inst, dict):
        st = inst.get("state") or inst.get("status") or inst.get("connectionState")
        if isinstance(st, str):
            return st.strip()

    st2 = obj.get("state") or obj.get("status") or obj.get("connectionState")
    return st2.strip() if isinstance(st2, str) else ""


def _infer_connected(obj: Any) -> Optional[bool]:
    if isinstance(obj, dict):
        if "connected" in obj:
            return bool(obj.get("connected"))

        st = _infer_state(obj).lower()
        if st:
            if st in ("open", "connected", "online", "ready"):
                return True
            if st in ("close", "closed", "disconnected", "offline", "logout", "loggedout"):
                return False

        c = obj.get("connection") or obj.get("connection_state") or obj.get("connectionState")
        if isinstance(c, str):
            cl = c.lower().strip()
            if cl in ("open", "connected"):
                return True
            if cl in ("close", "closed", "disconnected"):
                return False

    return None


class EvolutionClient:
    """
    Client mínimo para rotas HTTP da Evolution.
    Mantido aqui para substituir o antigo evolution.py/evolution_router.py.
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

    def get_connection_state(self, instance: str) -> Dict[str, Any]:
        return self._get("/instance/connectionState", instance)

    def connect(self, instance: str) -> Dict[str, Any]:
        return self._get("/instance/connect", instance)

    def set_presence(self, instance: str, *, presence: str = "available", **extra) -> Dict[str, Any]:
        body: Dict[str, Any] = {}
        if presence:
            body["presence"] = presence
        body.update({k: v for k, v in extra.items() if v is not None})
        return self._post("/instance/setPresence", instance, body, timeout=20)


def _resolve_connected_from_calls(
    evo: EvolutionClient,
    instance: str,
    presence: str,
) -> Tuple[bool, str, Dict[str, Any], Optional[Dict[str, Any]]]:
    js_presence = evo.set_presence(instance, presence=presence)

    st1 = _infer_state(js_presence)
    c1 = _infer_connected(js_presence)

    js_state: Optional[Dict[str, Any]] = None
    st2 = ""
    c2: Optional[bool] = None

    try:
        js_state = evo.get_connection_state(instance)
        st2 = _infer_state(js_state)
        c2 = _infer_connected(js_state)
    except Exception:
        js_state = None

    if c2 is not None:
        connected = bool(c2)
        state = st2 or st1
    elif c1 is not None:
        connected = bool(c1)
        state = st1 or st2
    else:
        connected = False
        state = st2 or st1 or ""

    return connected, state, js_presence, js_state


@router.get("/instance/connectionState/{instance}")
def connection_state(instance: str):
    evo = EvolutionClient()
    js = evo.get_connection_state(instance)
    return {
        "ok": True,
        "instance": instance,
        "connected": _infer_connected(js),
        "state": _infer_state(js),
        "evolution": js,
        "server_time": _now_utc().isoformat(),
    }


@router.get("/instance/connect/{instance}")
def connect_instance(instance: str):
    evo = EvolutionClient()
    js = evo.connect(instance)
    return {
        "ok": True,
        "instance": instance,
        "connected": _infer_connected(js),
        "state": _infer_state(js),
        "evolution": js,
        "server_time": _now_utc().isoformat(),
    }


@router.post("/instance/setPresence/{instance}")
def set_presence(
    instance: str,
    presence: str = Query("available"),
    body: Dict[str, Any] = Body(default_factory=dict),
    x_empresa_id: Optional[str] = Header(default=None, alias="X-Empresa-Id"),
):
    _ = x_empresa_id
    evo = EvolutionClient()

    connected, state, js_presence, js_state = _resolve_connected_from_calls(evo, instance, presence)

    me_number = None
    try:
        wid = None
        if isinstance(js_state, dict):
            inst = js_state.get("instance")
            if isinstance(inst, dict):
                wid = inst.get("id") or inst.get("wid")
        if isinstance(wid, str):
            me_number = _only_digits(wid.split("@", 1)[0])
    except Exception:
        me_number = None

    return {
        "ok": True,
        "instance": instance,
        "presence": presence,
        "connected": connected,
        "state": state,
        "me_number": me_number or None,
        "request_body": body or {},
        "evolution_presence": js_presence,
        "evolution_state": js_state,
        "server_time": _now_utc().isoformat(),
    }


@router.post("/message/sendText/{instance}")
def send_text(instance: str, body: Dict[str, Any] = Body(...)):
    number = str(body.get("number") or "").strip()
    text = str(body.get("text") or "").strip()
    if not number or not text:
        raise HTTPException(status_code=400, detail="number e text são obrigatórios")

    evo = EvolutionClient()
    js = evo.send_text(instance, number=number, text=text)
    return {"ok": True, "instance": instance, "evolution": js}


@router.post("/message/sendMedia/{instance}")
def send_media(instance: str, body: Dict[str, Any] = Body(...)):
    number = str(body.get("number") or "").strip()
    mediatype = str(body.get("mediatype") or "").strip()
    media = str(body.get("media") or "").strip()

    if not number or not mediatype or not media:
        raise HTTPException(status_code=400, detail="number, mediatype e media são obrigatórios")

    evo = EvolutionClient()
    js = evo.send_media(
        instance,
        number=number,
        mediatype=mediatype,
        media=media,
        mimetype=body.get("mimetype"),
        caption=body.get("caption"),
        fileName=body.get("fileName"),
    )
    return {"ok": True, "instance": instance, "evolution": js}


@router.post("/message/sendWhatsAppAudio/{instance}")
def send_audio(instance: str, body: Dict[str, Any] = Body(...)):
    number = str(body.get("number") or "").strip()
    audio = str(body.get("audio") or "").strip()
    if not number or not audio:
        raise HTTPException(status_code=400, detail="number e audio são obrigatórios")

    evo = EvolutionClient()
    js = evo.send_audio(instance, number=number, audio=audio)
    return {"ok": True, "instance": instance, "evolution": js}


@router.post("/message/sendSticker/{instance}")
def send_sticker(instance: str, body: Dict[str, Any] = Body(...)):
    number = str(body.get("number") or "").strip()
    sticker = str(body.get("sticker") or "").strip()
    if not number or not sticker:
        raise HTTPException(status_code=400, detail="number e sticker são obrigatórios")

    evo = EvolutionClient()
    js = evo.send_sticker(instance, number=number, sticker=sticker)
    return {"ok": True, "instance": instance, "evolution": js}


@router.post("/message/sendContact/{instance}")
def send_contact(instance: str, body: Dict[str, Any] = Body(...)):
    number = str(body.get("number") or "").strip()
    contact = body.get("contact")
    if not number or not isinstance(contact, list) or not contact:
        raise HTTPException(status_code=400, detail="number e contact[] são obrigatórios")

    evo = EvolutionClient()
    js = evo.send_contact(instance, number=number, contact=contact)
    return {"ok": True, "instance": instance, "evolution": js}


@router.post("/message/sendReaction/{instance}")
def send_reaction(instance: str, body: Dict[str, Any] = Body(...)):
    key = body.get("key")
    reaction = str(body.get("reaction") or "").strip()
    if not isinstance(key, dict) or not reaction:
        raise HTTPException(status_code=400, detail="key{} e reaction são obrigatórios")

    evo = EvolutionClient()
    js = evo.send_reaction(instance, key=key, reaction=reaction)
    return {"ok": True, "instance": instance, "evolution": js}


@router.post("/chat/getBase64FromMediaMessage/{instance}")
def get_base64_from_media_message(instance: str, body: Dict[str, Any] = Body(...)):
    message = body.get("message")
    convert_to_mp4 = bool(body.get("convertToMp4", False))
    if not isinstance(message, dict):
        raise HTTPException(status_code=400, detail="message{} é obrigatório")

    evo = EvolutionClient()
    js = evo.get_base64_from_message(instance, message=message, convert_to_mp4=convert_to_mp4)
    return {"ok": True, "instance": instance, "evolution": js}


__all__ = [
    "router",
    "EvolutionClient",
]