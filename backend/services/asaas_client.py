from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, Optional


class AsaasAPIError(Exception):
    """
    Erro padronizado para respostas da API do Asaas.
    """

    def __init__(self, status_code: int, message: str, payload: Any = None):
        self.status_code = int(status_code)
        self.payload = payload
        super().__init__(message)


class AsaasClient:
    """
    Cliente simples para API do Asaas.

    Usa somente biblioteca padrão do Python para não depender de requests/httpx.

    ENV necessário:
      ASAAS_ENV=production
      ASAAS_API_KEY=aact_prod_...
      ASAAS_PAYMENTS_PATH=/v3/payments

    Ambientes:
      production -> https://api.asaas.com
      sandbox    -> https://api-sandbox.asaas.com
    """

    def __init__(
        self,
        api_key: Optional[str] = None,
        env: Optional[str] = None,
        timeout: float = 30.0,
    ):
        self.api_key = (api_key or os.getenv("ASAAS_API_KEY") or "").strip()
        self.env = (env or os.getenv("ASAAS_ENV") or "sandbox").strip().lower()
        self.timeout = float(timeout)

        if not self.api_key:
            raise AsaasAPIError(
                500,
                "ASAAS_API_KEY não configurada no ambiente.",
            )

        if self.env in {"prod", "production", "producao", "produção"}:
            self.base_url = "https://api.asaas.com"
        else:
            self.base_url = "https://api-sandbox.asaas.com"

        self.payments_path = (os.getenv("ASAAS_PAYMENTS_PATH") or "/v3/payments").strip()
        if not self.payments_path.startswith("/"):
            self.payments_path = "/" + self.payments_path

    # =========================
    # Base HTTP
    # =========================
    def _url(self, path: str, query: Optional[Dict[str, Any]] = None) -> str:
        if not path.startswith("/"):
            path = "/" + path

        url = self.base_url.rstrip("/") + path

        if query:
            clean = {}
            for k, v in query.items():
                if v is None:
                    continue
                clean[k] = v

            if clean:
                url += "?" + urllib.parse.urlencode(clean)

        return url

    def _request(
        self,
        method: str,
        path: str,
        payload: Optional[Dict[str, Any]] = None,
        query: Optional[Dict[str, Any]] = None,
    ) -> Any:
        method = method.upper().strip()
        url = self._url(path, query=query)

        body: Optional[bytes] = None
        if payload is not None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")

        req = urllib.request.Request(
            url=url,
            data=body,
            method=method,
        )

        req.add_header("Accept", "application/json")
        req.add_header("Content-Type", "application/json")
        req.add_header("User-Agent", "ZapsChat-Connect/1.0")

        # Asaas usa access_token no header.
        req.add_header("access_token", self.api_key)

        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                raw = resp.read().decode("utf-8", "ignore")

                if not raw:
                    return {}

                try:
                    return json.loads(raw)
                except Exception:
                    return {"raw": raw}

        except urllib.error.HTTPError as e:
            raw = e.read().decode("utf-8", "ignore")
            parsed: Any = None
            msg = raw or f"Erro HTTP {e.code} no Asaas."

            try:
                parsed = json.loads(raw)

                if isinstance(parsed, dict):
                    errors = parsed.get("errors")

                    if isinstance(errors, list) and errors:
                        first = errors[0] or {}
                        msg = (
                            first.get("description")
                            or first.get("message")
                            or parsed.get("message")
                            or parsed.get("description")
                            or msg
                        )
                    else:
                        msg = parsed.get("message") or parsed.get("description") or msg

            except Exception:
                parsed = raw

            raise AsaasAPIError(e.code, str(msg), parsed)

        except urllib.error.URLError as e:
            raise AsaasAPIError(
                502,
                f"Falha de conexão com Asaas: {getattr(e, 'reason', e)}",
            )

        except TimeoutError:
            raise AsaasAPIError(
                504,
                "Tempo esgotado ao comunicar com o Asaas.",
            )

    # =========================
    # Customers / Clientes
    # =========================
    def create_customer(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        """
        Cria cliente no Asaas.

        Payload comum:
        {
          "name": "Empresa Teste",
          "cpfCnpj": "12345678900",
          "email": "cliente@email.com",
          "mobilePhone": "11999999999"
        }
        """
        return self._request("POST", "/v3/customers", payload=payload)

    def get_customer(self, customer_id: str) -> Dict[str, Any]:
        return self._request("GET", f"/v3/customers/{customer_id}")

    def update_customer(self, customer_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        return self._request("PUT", f"/v3/customers/{customer_id}", payload=payload)

    def list_customers(
        self,
        name: Optional[str] = None,
        cpf_cnpj: Optional[str] = None,
        email: Optional[str] = None,
        limit: int = 10,
    ) -> Dict[str, Any]:
        query: Dict[str, Any] = {
            "limit": int(limit),
        }

        if name:
            query["name"] = name
        if cpf_cnpj:
            query["cpfCnpj"] = cpf_cnpj
        if email:
            query["email"] = email

        return self._request("GET", "/v3/customers", query=query)

    # =========================
    # Subscriptions / Assinaturas
    # =========================
    def create_subscription(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        """
        Cria assinatura recorrente.

        Payload comum:
        {
          "customer": "cus_...",
          "billingType": "PIX" | "BOLETO" | "CREDIT_CARD",
          "value": 197,
          "nextDueDate": "2026-04-28",
          "cycle": "MONTHLY",
          "description": "ZapsChat Connect - Plano Business",
          "externalReference": "zapschat:empresa:1:plano:BUSINESS"
        }
        """
        return self._request("POST", "/v3/subscriptions", payload=payload)

    def get_subscription(self, subscription_id: str) -> Dict[str, Any]:
        return self._request("GET", f"/v3/subscriptions/{subscription_id}")

    def list_subscriptions(
        self,
        *,
        customer: Optional[str] = None,
        external_reference: Optional[str] = None,
        status: Optional[str] = None,
        limit: int = 20,
        offset: int = 0,
    ) -> Dict[str, Any]:
        query: Dict[str, Any] = {
            "limit": max(1, min(int(limit), 100)),
            "offset": max(0, int(offset)),
        }
        if customer:
            query["customer"] = customer
        if external_reference:
            query["externalReference"] = external_reference
        if status:
            query["status"] = status
        return self._request("GET", "/v3/subscriptions", query=query)

    def update_subscription(self, subscription_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        return self._request("PUT", f"/v3/subscriptions/{subscription_id}", payload=payload)

    def delete_subscription(self, subscription_id: str) -> Dict[str, Any]:
        return self._request("DELETE", f"/v3/subscriptions/{subscription_id}")

    def get_subscription_payments(self, subscription_id: str) -> Dict[str, Any]:
        """
        Lista cobranças geradas por uma assinatura.
        Usamos isso para pegar a primeira cobrança e mostrar Pix/boleto.
        """
        return self._request("GET", f"/v3/subscriptions/{subscription_id}/payments")

    # =========================
    # Payments / Cobranças
    # =========================
    def create_payment(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        """
        Cria cobrança avulsa.
        No ZapsChat a regra principal será assinatura, mas deixei pronto.
        """
        return self._request("POST", self.payments_path, payload=payload)

    def get_payment(self, payment_id: str) -> Dict[str, Any]:
        return self._request("GET", f"{self.payments_path}/{payment_id}")

    def delete_payment(self, payment_id: str) -> Dict[str, Any]:
        return self._request("DELETE", f"{self.payments_path}/{payment_id}")

    def refund_payment(
        self,
        payment_id: str,
        value: Optional[float] = None,
        description: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Solicita estorno/reembolso.
        Não vamos usar agora na primeira etapa, mas fica pronto.
        """
        payload: Dict[str, Any] = {}

        if value is not None:
            payload["value"] = float(value)

        if description:
            payload["description"] = description

        return self._request(
            "POST",
            f"{self.payments_path}/{payment_id}/refund",
            payload=payload,
        )

    # =========================
    # Pix
    # =========================
    def get_payment_pix_qr_code(self, payment_id: str) -> Dict[str, Any]:
        """
        Retorna dados do QR Code Pix da cobrança.

        Normalmente retorna algo como:
        {
          "encodedImage": "base64...",
          "payload": "000201...",
          "expirationDate": "..."
        }
        """
        return self._request(
            "GET",
            f"{self.payments_path}/{payment_id}/pixQrCode",
        )

    # =========================
    # Boleto
    # =========================
    def get_payment_identification_field(self, payment_id: str) -> Dict[str, Any]:
        """
        Retorna linha digitável do boleto.
        """
        return self._request(
            "GET",
            f"{self.payments_path}/{payment_id}/identificationField",
        )

    # =========================
    # Webhooks
    # =========================
    def list_webhooks(self, limit: int = 100, offset: int = 0) -> Dict[str, Any]:
        return self._request(
            "GET",
            "/v3/webhooks",
            query={"limit": max(1, min(int(limit), 100)), "offset": max(0, int(offset))},
        )

    def create_webhook(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        return self._request("POST", "/v3/webhooks", payload=payload)

    def update_webhook(self, webhook_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        return self._request("PUT", f"/v3/webhooks/{webhook_id}", payload=payload)

    # =========================
    # Utilitários
    # =========================
    def healthcheck(self) -> Dict[str, Any]:
        """
        Teste simples para validar chave/ambiente.
        Busca poucos clientes.
        """
        return self.list_customers(limit=1)