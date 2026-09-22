"""NMI (Network Merchants Inc.) v5 REST API wrapper.

Each merchant that's been approved by the underwriter (Paul) has their
own row in `db.merchant_payments_credentials`:
    {
      company_id, environment: "sandbox" | "production",
      nmi_security_key: <encrypted>,      # private, server-side only
      nmi_tokenization_key,               # public — safe to hand to browser
      nmi_processor_id: <optional>,
      webhook_secret: <encrypted>,
      surcharge_pct: float,               # dual-pricing default per merchant
      approved_at, approved_by, ...
    }

This module is the single entry point for every NMI call: sale, vault
create, vault charge, refund, void. Callers pass `company_id` and we
handle credential lookup + decryption transparently. If a company has
no credentials configured we raise `NmiNotConfigured` so the route
layer can return a clean 409/503 to the client.

Nothing here logs raw request bodies — payment tokens and vault ids
are treated as sensitive.
"""
from __future__ import annotations

import logging
from decimal import Decimal
from typing import Any, Optional

import httpx

from db import db
import crypto_service as cs

log = logging.getLogger("axiom.nmi")

# ---- Errors -------------------------------------------------------

class NmiError(Exception):
    """Base for anything NMI-related."""

class NmiNotConfigured(NmiError):
    """Merchant has no credentials on file (not approved yet)."""

class NmiRejected(NmiError):
    """NMI returned a non-approval response. `data` holds the body."""
    def __init__(self, message: str, data: dict | None = None):
        super().__init__(message)
        self.data = data or {}


# ---- Credentials --------------------------------------------------

async def get_merchant_credentials(company_id: str) -> dict:
    """Return decrypted NMI credentials for a company, or raise
    `NmiNotConfigured`. Callers must never expose the security_key or
    webhook_secret back to the browser — only the tokenization_key is
    safe for that."""
    doc = await db.merchant_payments_credentials.find_one({"company_id": company_id})
    if not doc:
        raise NmiNotConfigured(f"No payments credentials on file for company {company_id}")
    return {
        "environment":       doc.get("environment") or "sandbox",
        "security_key":      cs.decrypt(doc["nmi_security_key"]),
        "tokenization_key":  doc.get("nmi_tokenization_key") or "",
        "processor_id":      doc.get("nmi_processor_id") or "",
        "webhook_secret":    cs.decrypt(doc["webhook_secret"]) if doc.get("webhook_secret") else "",
        "surcharge_pct":     float(doc.get("surcharge_pct") or 0),
    }


def _base_url(environment: str) -> str:
    return "https://secure.nmi.com" if environment == "production" else "https://sandbox.nmi.com"


async def _post_json(company_id: str, path: str, payload: dict) -> dict:
    """Authenticated JSON POST to NMI v5. Never logs the payload —
    those may contain payment tokens."""
    creds = await get_merchant_credentials(company_id)
    url = f"{_base_url(creds['environment'])}{path}"
    headers = {
        "Authorization": creds["security_key"],
        "Content-Type": "application/json",
    }
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            r = await client.post(url, json=payload, headers=headers)
    except httpx.RequestError as e:
        log.warning("NMI request error for %s %s: %s", company_id, path, e)
        raise NmiError(f"NMI unreachable: {e}") from e
    if r.status_code >= 500:
        raise NmiError(f"NMI 5xx ({r.status_code}) on {path}")
    try:
        data = r.json()
    except Exception:
        raise NmiError(f"NMI returned non-JSON ({r.status_code}) on {path}")
    # NMI v5 uses `response == '1'` OR a `status: approved` field
    # depending on endpoint; callers verify the exact shape.
    return data


# ---- Public API ---------------------------------------------------

async def run_sale(
    company_id: str,
    payment_token: str,
    amount: Decimal | float,
    order_id: str,
    currency: str = "USD",
    customer_email: str = "",
    customer_vault_id: Optional[str] = None,
    save_to_vault: bool = False,
) -> dict:
    """Run a card/ACH/wallet sale.

    Either `payment_token` (from Payment Component) OR
    `customer_vault_id` must be present. If `save_to_vault` is true
    and we're using a payment_token, NMI will store the payment
    method and return `customer_vault_id` on the response — the
    caller stashes it on `contacts.payment_methods`.
    """
    if not payment_token and not customer_vault_id:
        raise NmiError("run_sale: either payment_token or customer_vault_id required")
    payment_details: dict[str, Any] = {}
    if customer_vault_id:
        payment_details["customer_vault_id"] = customer_vault_id
    else:
        payment_details["payment_token"] = payment_token
    payload: dict[str, Any] = {
        "amount":   float(amount),
        "currency": currency,
        "order_id": order_id,
        "payment_details":  payment_details,
        "billing_address": {"email": customer_email},
    }
    if save_to_vault and payment_token:
        payload["add_to_customer_vault"] = True
    data = await _post_json(company_id, "/api/v5/payments/sale", payload)
    approved = str(data.get("response")) == "1" or data.get("status") == "approved"
    if not approved:
        raise NmiRejected(data.get("response_text") or "Payment declined", data)
    return data


async def vault_save(
    company_id: str,
    payment_token: str,
    first_name: str = "",
    last_name: str = "",
    email: str = "",
) -> dict:
    """Store a payment method in the Customer Vault. Returns the raw
    NMI response, whose `id` is the customer_vault_id."""
    payload = {
        "payment_details": {"payment_token": payment_token},
        "billing_address": {
            "first_name": first_name,
            "last_name":  last_name,
            "email":      email,
        },
    }
    return await _post_json(company_id, "/api/v5/customers", payload)


async def vault_delete(company_id: str, customer_vault_id: str) -> dict:
    """DELETE /customers/{id} — NMI returns 204 on success."""
    creds = await get_merchant_credentials(company_id)
    url = f"{_base_url(creds['environment'])}/api/v5/customers/{customer_vault_id}"
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            r = await client.delete(url, headers={"Authorization": creds["security_key"]})
    except httpx.RequestError as e:
        raise NmiError(f"NMI unreachable: {e}") from e
    if r.status_code not in (200, 204):
        raise NmiError(f"vault_delete failed ({r.status_code})")
    return {"deleted": True}


async def refund_payment(
    company_id: str,
    transaction_id: str,
    amount: Optional[Decimal | float] = None,
) -> dict:
    """Refund an already-settled sale. `amount` omitted = full refund."""
    body = {} if amount is None else {"amount": float(amount)}
    data = await _post_json(
        company_id, f"/api/v5/payments/{transaction_id}/refund", body,
    )
    approved = str(data.get("response")) == "1" or data.get("status") in ("approved", "success")
    if not approved:
        raise NmiRejected(data.get("response_text") or "Refund declined", data)
    return data


async def void_payment(company_id: str, transaction_id: str) -> dict:
    """Void a pre-settle sale."""
    data = await _post_json(
        company_id, f"/api/v5/payments/{transaction_id}/void", {},
    )
    approved = str(data.get("response")) == "1" or data.get("status") in ("approved", "success")
    if not approved:
        raise NmiRejected(data.get("response_text") or "Void declined", data)
    return data
