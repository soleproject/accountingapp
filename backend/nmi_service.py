"""NMI (Network Merchants Inc.) gateway wrapper.

Uses NMI's Direct Post / Transaction API (`transact.php`, form-encoded)
for sale / refund / void because that's what standard NMI gateway
accounts are provisioned on today. The newer v5 REST JSON surface is
only enabled for a subset of merchants — sticking with Direct Post
keeps us compatible with every reseller / ISO.

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
import urllib.parse
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
    """NMI returned a non-approval response. `data` holds the parsed body."""
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


# ---- Transport ----------------------------------------------------

_BASE = "https://secure.nmi.com/api/transact.php"


async def _post(company_id: str, params: dict[str, Any]) -> dict:
    """Authenticated form-encoded POST to Direct Post. Response body
    is url-encoded key=value pairs; we parse them into a flat dict.

    We deliberately don't log `params` — they may contain payment
    tokens, card numbers (never touch us in practice, but be safe),
    or customer_vault_ids.
    """
    creds = await get_merchant_credentials(company_id)
    params = {**params, "security_key": creds["security_key"]}
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            r = await client.post(_BASE, data=params)
    except httpx.RequestError as e:
        log.warning("NMI unreachable for %s: %s", company_id, e)
        raise NmiError(f"NMI unreachable: {e}") from e
    if r.status_code >= 500:
        raise NmiError(f"NMI 5xx ({r.status_code})")
    # Direct Post returns: response=1&responsetext=SUCCESS&transactionid=…
    parsed = urllib.parse.parse_qs(r.text or "", keep_blank_values=True)
    # parse_qs values are always lists — flatten to scalars.
    return {k: (v[0] if v else "") for k, v in parsed.items()}


def _approved(data: dict) -> bool:
    """response=1 means approved on Direct Post. 2 = declined, 3 = error."""
    return str(data.get("response", "")) == "1"


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
    params: dict[str, Any] = {
        "type":     "sale",
        "amount":   f"{float(amount):.2f}",
        "currency": currency,
        "orderid":  order_id,
        "email":    customer_email,
    }
    if customer_vault_id:
        params["customer_vault_id"] = customer_vault_id
    else:
        # Payment Component returns a Collect.js-style `payment_token`
        # which Direct Post accepts under the same field name.
        params["payment_token"] = payment_token
    if save_to_vault and payment_token:
        params["customer_vault"] = "add_customer"
    data = await _post(company_id, params)
    if not _approved(data):
        raise NmiRejected(
            data.get("responsetext") or "Payment declined", data,
        )
    return data


async def vault_save(
    company_id: str,
    payment_token: str,
    first_name: str = "",
    last_name: str = "",
    email: str = "",
) -> dict:
    """Store a payment method in the Customer Vault standalone (no
    sale). Returns the raw NMI response; `customer_vault_id` is on
    the response payload."""
    data = await _post(company_id, {
        "customer_vault": "add_customer",
        "payment_token":  payment_token,
        "first_name":     first_name,
        "last_name":      last_name,
        "email":          email,
    })
    if not _approved(data):
        raise NmiRejected(data.get("responsetext") or "Vault save failed", data)
    return data


async def vault_delete(company_id: str, customer_vault_id: str) -> dict:
    """Direct Post: customer_vault=delete_customer&customer_vault_id=…"""
    data = await _post(company_id, {
        "customer_vault":    "delete_customer",
        "customer_vault_id": customer_vault_id,
    })
    if not _approved(data):
        raise NmiRejected(data.get("responsetext") or "Vault delete failed", data)
    return {"deleted": True, **data}


async def refund_payment(
    company_id: str,
    transaction_id: str,
    amount: Optional[Decimal | float] = None,
) -> dict:
    """Refund an already-settled sale. `amount` omitted = full refund."""
    params: dict[str, Any] = {"type": "refund", "transactionid": transaction_id}
    if amount is not None:
        params["amount"] = f"{float(amount):.2f}"
    data = await _post(company_id, params)
    if not _approved(data):
        raise NmiRejected(data.get("responsetext") or "Refund declined", data)
    return data


async def void_payment(company_id: str, transaction_id: str) -> dict:
    """Void a pre-settle sale."""
    data = await _post(company_id, {"type": "void", "transactionid": transaction_id})
    if not _approved(data):
        raise NmiRejected(data.get("responsetext") or "Void declined", data)
    return data
