"""PayPal Orders v2 / Payments v2 client, pinned to the sandbox.

Every write carries a caller-supplied PayPal-Request-Id so a retry with the same key
returns the original result instead of moving money twice. Transport errors and 5xx
responses raise PayPalUnknownOutcome: the caller must retry with the same key or
reconcile with a GET, never send a fresh key.
"""

import base64
import time
from dataclasses import dataclass
from typing import Any

import httpx2 as httpx

from dive_trip.platform.errors import DomainError

SANDBOX_API = "https://api-m.sandbox.paypal.com"


class PayPalError(DomainError):
    """PayPal answered and rejected the request; no money moved for this key."""

    def __init__(self, status: int, issue: str) -> None:
        self.status = status
        self.issue = issue
        super().__init__(f"PAYPAL_{issue}")


class PayPalUnknownOutcome(DomainError):
    """The request may or may not have taken effect."""

    def __init__(self) -> None:
        super().__init__("PAYPAL_OUTCOME_UNKNOWN")


@dataclass(frozen=True)
class SandboxCard:
    number: str
    expiry: str
    securityCode: str
    name: str


@dataclass(frozen=True)
class Authorization:
    orderId: str
    authorizationId: str
    status: str
    amountMinor: int
    expiresAt: str | None


@dataclass(frozen=True)
class Capture:
    captureId: str
    status: str
    amountMinor: int


@dataclass(frozen=True)
class Refund:
    refundId: str
    status: str
    amountMinor: int


def usd(minor: int) -> dict[str, str]:
    if minor < 0:
        raise DomainError("PAYPAL_AMOUNT_NEGATIVE")
    return {"currency_code": "USD", "value": f"{minor // 100}.{minor % 100:02d}"}


def minor_of(amount: dict[str, Any]) -> int:
    if amount.get("currency_code") != "USD":
        raise DomainError("PAYPAL_CURRENCY_UNEXPECTED")
    whole, _, cents = str(amount["value"]).partition(".")
    return int(whole) * 100 + int((cents + "00")[:2])


class PayPalClient:
    def __init__(
        self,
        client_id: str,
        client_secret: str,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
        timeout_seconds: float = 20.0,
    ) -> None:
        self._basic = base64.b64encode(f"{client_id}:{client_secret}".encode()).decode()
        self._http = httpx.AsyncClient(
            base_url=SANDBOX_API, transport=transport, timeout=timeout_seconds
        )
        self._token: str | None = None
        self._token_expires = 0.0

    async def aclose(self) -> None:
        await self._http.aclose()

    async def _access_token(self) -> str:
        if self._token and time.monotonic() < self._token_expires:
            return self._token
        response = await self._send(
            "POST",
            "/v1/oauth2/token",
            headers={"Authorization": f"Basic {self._basic}"},
            data={"grant_type": "client_credentials"},
        )
        body = response.json()
        self._token = str(body["access_token"])
        self._token_expires = time.monotonic() + int(body.get("expires_in", 0)) - 60
        return self._token

    async def _send(self, method: str, path: str, **kwargs: Any) -> httpx.Response:
        try:
            response = await self._http.request(method, path, **kwargs)
        except httpx.TransportError as error:
            raise PayPalUnknownOutcome() from error
        if response.status_code >= 500:
            raise PayPalUnknownOutcome()
        if response.status_code >= 400:
            body = response.json() if response.content else {}
            details = body.get("details") or [{}]
            issue = details[0].get("issue") or body.get("name") or "REJECTED"
            raise PayPalError(response.status_code, str(issue))
        return response

    async def _call(
        self,
        method: str,
        path: str,
        body: dict[str, Any] | None = None,
        request_id: str | None = None,
    ) -> dict[str, Any]:
        headers = {
            "Authorization": f"Bearer {await self._access_token()}",
            "Prefer": "return=representation",
        }
        if request_id:
            headers["PayPal-Request-Id"] = request_id
        response = await self._send(method, path, json=body, headers=headers)
        return response.json() if response.content else {}

    async def create_card_authorization(
        self,
        *,
        invoice_id: str,
        amount_minor: int,
        card: SandboxCard,
        request_id: str,
    ) -> Authorization:
        order = await self._call(
            "POST",
            "/v2/checkout/orders",
            {
                "intent": "AUTHORIZE",
                "purchase_units": [
                    {"invoice_id": invoice_id, "amount": usd(amount_minor)}
                ],
                "payment_source": {
                    "card": {
                        "number": card.number,
                        "expiry": card.expiry,
                        "security_code": card.securityCode,
                        "name": card.name,
                    }
                },
            },
            request_id,
        )
        return authorization_of(order)

    async def capture(
        self,
        authorization_id: str,
        *,
        amount_minor: int,
        final: bool,
        invoice_id: str,
        request_id: str,
    ) -> Capture:
        body = {
            "amount": usd(amount_minor),
            "final_capture": final,
            "invoice_id": invoice_id,
        }
        capture = await self._call(
            "POST",
            f"/v2/payments/authorizations/{authorization_id}/capture",
            body,
            request_id,
        )
        return Capture(
            str(capture["id"]), str(capture["status"]), minor_of(capture["amount"])
        )

    async def void(self, authorization_id: str, *, request_id: str) -> None:
        await self._call(
            "POST",
            f"/v2/payments/authorizations/{authorization_id}/void",
            {},
            request_id,
        )

    async def refund(
        self,
        capture_id: str,
        *,
        amount_minor: int,
        invoice_id: str,
        request_id: str,
    ) -> Refund:
        refund = await self._call(
            "POST",
            f"/v2/payments/captures/{capture_id}/refund",
            {"amount": usd(amount_minor), "invoice_id": invoice_id},
            request_id,
        )
        return Refund(
            str(refund["id"]), str(refund["status"]), minor_of(refund["amount"])
        )

    async def get_authorization(self, authorization_id: str) -> dict[str, Any]:
        return await self._call(
            "GET", f"/v2/payments/authorizations/{authorization_id}"
        )

    async def get_capture(self, capture_id: str) -> dict[str, Any]:
        return await self._call("GET", f"/v2/payments/captures/{capture_id}")


def authorization_of(order: dict[str, Any]) -> Authorization:
    units = order.get("purchase_units") or []
    payments = (units[0].get("payments") or {}) if units else {}
    authorizations = payments.get("authorizations") or []
    if not authorizations:
        raise DomainError("PAYPAL_AUTHORIZATION_MISSING")
    auth = authorizations[0]
    return Authorization(
        orderId=str(order["id"]),
        authorizationId=str(auth["id"]),
        status=str(auth["status"]),
        amountMinor=minor_of(auth["amount"]),
        expiresAt=auth.get("expiration_time"),
    )
