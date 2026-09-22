"""Payments gateway routes (NMI Payment Component + Vault + webhook).

Three surfaces live here:

1. **Public "Hosted Pay" endpoints** — no auth. Given an invoice's
   `public_token` (generated when the invoice is first surfaced for
   payment), a customer can fetch the invoice summary and run a sale.
   PAN never touches our origin — the Payment Component tokenizes in
   the browser and we only receive a one-time token from NMI.

2. **Authenticated merchant endpoints** — the merchant's own users
   (owner / pro / editor) can refund a paid invoice, void a pending
   one, or delete a saved payment method from the vault.

3. **Webhook** — public but HMAC-verified. NMI POSTs transaction
   status changes here; we auto-reconcile the invoice.

No card data ever lands in our Mongo. Anything sensitive
(security_key, webhook_secret) is decrypted inside `nmi_service.py`
for the duration of a single request and immediately discarded.
"""
from __future__ import annotations
import hmac
import hashlib
import json
import uuid
import logging
from datetime import datetime, timezone
from decimal import Decimal
from typing import Optional
from pydantic import BaseModel, Field

from fastapi import APIRouter, Depends, HTTPException, Request

from db import db
from auth import get_current_user
from deps import require_company
import nmi_service as nmi

log = logging.getLogger("axiom.gateway")
router = APIRouter(prefix="/api")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ---- Helpers ------------------------------------------------------

async def _ensure_public_token(cid: str, iid: str) -> str:
    """Lazily attach a stable `public_token` to an invoice so we can
    hand out a share URL like `/pay/{token}`. The token is random and
    non-guessable, so possession-of-the-link is treated as auth for
    the public pay page."""
    inv = await db.invoices.find_one({"id": iid, "company_id": cid}, {"_id": 0, "public_token": 1})
    if not inv:
        raise HTTPException(404, "Invoice not found")
    tok = inv.get("public_token")
    if tok:
        return tok
    tok = uuid.uuid4().hex
    await db.invoices.update_one(
        {"id": iid, "company_id": cid},
        {"$set": {"public_token": tok, "updated_at": _now()}},
    )
    return tok


def _outstanding_balance(inv: dict) -> Decimal:
    """`balance_due` is the source of truth if present; fall back to
    total minus any linked payments in-flight."""
    if inv.get("balance_due") is not None:
        return Decimal(str(inv["balance_due"]))
    return Decimal(str(inv.get("total") or 0))


# ---- Merchant: get a Pay Now share URL ---------------------------

@router.post("/companies/{cid}/invoices/{iid}/pay-link")
async def create_pay_link(
    cid: str, iid: str, user: dict = Depends(get_current_user),
):
    """Called by the invoice UI's "Copy Pay Now link" / "Send with
    Pay Now button" flow. Ensures the invoice has a public_token and
    returns the URL. Company must be `payments_enabled`."""
    await require_company(user, cid)
    company = await db.companies.find_one({"id": cid}, {"_id": 0, "payments_enabled": 1})
    if not (company or {}).get("payments_enabled"):
        raise HTTPException(409, "Payments aren't enabled for this company yet.")
    tok = await _ensure_public_token(cid, iid)
    return {"public_token": tok, "path": f"/pay/{tok}"}


# ---- Public: hosted pay page bootstrap ---------------------------

@router.get("/pay/{token}/config")
async def public_pay_config(token: str):
    """Bootstrap the hosted pay page. Returns invoice + merchant
    display info + the merchant's PUBLIC tokenization key. Nothing
    sensitive — the security_key and webhook_secret never leave the
    server."""
    inv = await db.invoices.find_one({"public_token": token}, {"_id": 0})
    if not inv:
        raise HTTPException(404, "Invoice not found or link expired.")
    cid = inv["company_id"]
    company = await db.companies.find_one({"id": cid}, {"_id": 0, "name": 1, "payments_enabled": 1}) or {}
    if not company.get("payments_enabled"):
        raise HTTPException(409, "Payments aren't enabled for this business yet.")
    cred = await db.merchant_payments_credentials.find_one(
        {"company_id": cid},
        {"_id": 0, "environment": 1, "nmi_tokenization_key": 1, "surcharge_pct": 1},
    )
    if not cred:
        raise HTTPException(503, "Payments not configured yet.")
    balance = _outstanding_balance(inv)
    surcharge_pct = float(cred.get("surcharge_pct") or 0)
    surcharge_amount = float((balance * Decimal(str(surcharge_pct)) / Decimal(100)).quantize(Decimal("0.01")))
    return {
        "invoice": {
            "id":            inv["id"],
            "number":        inv.get("number"),
            "issue_date":    inv.get("issue_date"),
            "due_date":      inv.get("due_date"),
            "contact_name":  inv.get("contact_name"),
            "balance_due":   float(balance),
            "currency":      inv.get("currency") or "USD",
            "status":        inv.get("status"),
        },
        "business_name":     company.get("name"),
        "tokenization_key":  cred["nmi_tokenization_key"],
        "environment":       cred.get("environment") or "sandbox",
        "dual_pricing": {
            "surcharge_pct":    surcharge_pct,
            "surcharge_amount": surcharge_amount,
            "card_total":       float(balance) + surcharge_amount,
            "ach_total":        float(balance),
        },
    }


class PublicSaleIn(BaseModel):
    payment_token: str = Field(..., min_length=4)
    method: str = Field("card", pattern="^(card|ach|apple_pay|google_pay)$")
    save_to_vault: bool = False
    customer_email: str = ""


@router.post("/pay/{token}/sale")
async def public_pay_sale(token: str, body: PublicSaleIn):
    """Run the actual sale using the one-time payment token from NMI.
    We recompute the amount server-side — the browser never dictates
    what to charge. Card sales get the dual-pricing surcharge added;
    ACH does not."""
    inv = await db.invoices.find_one({"public_token": token}, {"_id": 0})
    if not inv:
        raise HTTPException(404, "Invoice not found.")
    if inv.get("status") == "paid":
        raise HTTPException(409, "This invoice is already paid.")
    cid = inv["company_id"]
    balance = _outstanding_balance(inv)
    if balance <= 0:
        raise HTTPException(400, "Nothing to charge on this invoice.")

    cred = await db.merchant_payments_credentials.find_one(
        {"company_id": cid}, {"_id": 0, "surcharge_pct": 1},
    ) or {}
    surcharge_pct = Decimal(str(cred.get("surcharge_pct") or 0))
    amount = balance
    if body.method == "card":
        amount = (balance * (Decimal(1) + surcharge_pct / Decimal(100))).quantize(Decimal("0.01"))

    order_id = f"inv-{inv['id']}"
    try:
        result = await nmi.run_sale(
            company_id     = cid,
            payment_token  = body.payment_token,
            amount         = amount,
            order_id       = order_id,
            currency       = inv.get("currency") or "USD",
            customer_email = body.customer_email or "",
            save_to_vault  = bool(body.save_to_vault),
        )
    except nmi.NmiNotConfigured:
        raise HTTPException(503, "Payments aren't configured for this merchant.")
    except nmi.NmiRejected as e:
        # Persist the failed attempt so the merchant can see it in the
        # transactions audit trail (also helps chargeback disputes).
        await _record_txn(cid, inv["id"], amount, e.data, status="declined", method=body.method)
        raise HTTPException(402, str(e))

    await _record_txn(cid, inv["id"], amount, result, status="approved", method=body.method,
                      save_to_vault=body.save_to_vault)
    # Optimistically mark the invoice paid — the webhook will confirm.
    await db.invoices.update_one(
        {"id": inv["id"], "company_id": cid},
        {"$set": {"status": "paid", "balance_due": 0, "updated_at": _now()}},
    )
    return {"ok": True, "transaction_id": result.get("id"), "amount": float(amount)}


async def _record_txn(
    cid: str, invoice_id: str, amount: Decimal, resp: dict, *,
    status: str, method: str, save_to_vault: bool = False,
) -> None:
    """Persist an NMI transaction attempt to `db.nmi_transactions`.
    No PAN, no CVV — just the ID, order, and response metadata."""
    now = _now()
    await db.nmi_transactions.insert_one({
        "id":               str(uuid.uuid4()),
        "company_id":       cid,
        "invoice_id":       invoice_id,
        "nmi_transaction_id": resp.get("id") or resp.get("transactionid"),
        "amount":           float(amount),
        "status":           status,
        "method":           method,
        "response_code":    resp.get("response") or resp.get("response_code"),
        "response_text":    resp.get("response_text") or resp.get("responsetext"),
        "saved_to_vault":   bool(save_to_vault),
        "customer_vault_id": resp.get("customer_vault_id"),
        "created_at":       now,
    })


# ---- Merchant: refund / void -------------------------------------

class RefundIn(BaseModel):
    amount: Optional[float] = None  # None = full refund

@router.post("/companies/{cid}/nmi/transactions/{txn_id}/refund")
async def refund_txn(
    cid: str, txn_id: str, body: RefundIn,
    user: dict = Depends(get_current_user),
):
    await require_company(user, cid)
    txn = await db.nmi_transactions.find_one({
        "company_id": cid, "nmi_transaction_id": txn_id, "status": "approved",
    })
    if not txn:
        raise HTTPException(404, "Transaction not found or not eligible.")
    try:
        result = await nmi.refund_payment(cid, txn_id, amount=body.amount)
    except nmi.NmiNotConfigured:
        raise HTTPException(503, "Payments aren't configured for this merchant.")
    except nmi.NmiRejected as e:
        raise HTTPException(402, str(e))
    await db.nmi_transactions.update_one(
        {"id": txn["id"]},
        {"$set": {"status": "refunded", "refunded_at": _now(),
                  "refund_amount": body.amount or txn["amount"]}},
    )
    return {"ok": True, "refund_id": result.get("id")}


@router.post("/companies/{cid}/nmi/transactions/{txn_id}/void")
async def void_txn(
    cid: str, txn_id: str, user: dict = Depends(get_current_user),
):
    await require_company(user, cid)
    txn = await db.nmi_transactions.find_one({
        "company_id": cid, "nmi_transaction_id": txn_id, "status": "approved",
    })
    if not txn:
        raise HTTPException(404, "Transaction not found or not eligible.")
    try:
        result = await nmi.void_payment(cid, txn_id)
    except nmi.NmiNotConfigured:
        raise HTTPException(503, "Payments aren't configured for this merchant.")
    except nmi.NmiRejected as e:
        raise HTTPException(402, str(e))
    await db.nmi_transactions.update_one(
        {"id": txn["id"]},
        {"$set": {"status": "voided", "voided_at": _now()}},
    )
    return {"ok": True, "void_id": result.get("id")}


# ---- Vault delete (customer requests removal) --------------------

@router.delete("/companies/{cid}/nmi/vault/{vault_id}")
async def vault_delete(
    cid: str, vault_id: str, user: dict = Depends(get_current_user),
):
    await require_company(user, cid)
    try:
        await nmi.vault_delete(cid, vault_id)
    except nmi.NmiNotConfigured:
        raise HTTPException(503, "Payments aren't configured for this merchant.")
    except nmi.NmiError as e:
        raise HTTPException(502, str(e))
    # Remove all references from any contact's payment_methods list.
    await db.contacts.update_many(
        {"company_id": cid, "payment_methods.customer_vault_id": vault_id},
        {"$pull": {"payment_methods": {"customer_vault_id": vault_id}}},
    )
    return {"ok": True}


# ---- Webhook ------------------------------------------------------

@router.post("/nmi/webhook/{company_id}")
async def nmi_webhook(company_id: str, request: Request):
    """NMI POSTs transaction events here. We verify HMAC-SHA256 over
    the raw body against the merchant's webhook_secret, then apply
    the state change to our transaction + invoice records
    idempotently by `event_id`."""
    raw = await request.body()
    signature = request.headers.get("Signature", "") or request.headers.get("signature", "")
    try:
        creds = await nmi.get_merchant_credentials(company_id)
    except nmi.NmiNotConfigured:
        raise HTTPException(404, "Unknown merchant")
    secret = creds.get("webhook_secret") or ""
    if secret:
        expected = hmac.new(secret.encode("utf-8"), raw, hashlib.sha256).hexdigest()
        if not hmac.compare_digest(expected, signature):
            log.warning("NMI webhook: bad signature for %s", company_id)
            raise HTTPException(401, "Invalid signature")
    try:
        event = json.loads(raw)
    except Exception:
        raise HTTPException(400, "Malformed webhook body")

    event_id = event.get("event_id") or event.get("id") or ""
    if not event_id:
        raise HTTPException(400, "Missing event_id")

    # Idempotency
    dupe = await db.nmi_events.find_one({"company_id": company_id, "event_id": event_id})
    if dupe:
        return {"ok": True, "duplicate": True}
    await db.nmi_events.insert_one({
        "id":          str(uuid.uuid4()),
        "company_id":  company_id,
        "event_id":    event_id,
        "event_type":  event.get("event_type") or event.get("type") or "",
        "payload":     event,
        "received_at": _now(),
    })
    await _apply_event(company_id, event)
    return {"ok": True}


async def _apply_event(cid: str, event: dict) -> None:
    """Best-effort local state update for NMI event types we care
    about. Missing/unknown event types are logged but don't fail."""
    et = (event.get("event_type") or event.get("type") or "").lower()
    body = event.get("data") or event
    txn_id = body.get("transaction_id") or body.get("transactionid") or body.get("id")
    if not txn_id:
        return
    now = _now()
    if et in ("transaction.sale.success", "sale.success"):
        await db.nmi_transactions.update_one(
            {"company_id": cid, "nmi_transaction_id": txn_id},
            {"$set": {"status": "settled", "settled_at": now}},
        )
    elif et in ("transaction.sale.failure", "sale.failure"):
        await db.nmi_transactions.update_one(
            {"company_id": cid, "nmi_transaction_id": txn_id},
            {"$set": {"status": "failed", "failed_at": now}},
        )
    elif et in ("transaction.refund.success", "refund.success"):
        await db.nmi_transactions.update_one(
            {"company_id": cid, "nmi_transaction_id": txn_id},
            {"$set": {"status": "refunded", "refunded_at": now}},
        )
    elif et in ("transaction.void.success", "void.success"):
        await db.nmi_transactions.update_one(
            {"company_id": cid, "nmi_transaction_id": txn_id},
            {"$set": {"status": "voided", "voided_at": now}},
        )
    elif et.startswith("ach.return") or "chargeback" in et:
        await db.nmi_transactions.update_one(
            {"company_id": cid, "nmi_transaction_id": txn_id},
            {"$set": {"status": "disputed", "disputed_at": now,
                      "dispute_kind": et}},
        )
        # Reopen the invoice — the money we thought we had is gone.
        txn = await db.nmi_transactions.find_one(
            {"company_id": cid, "nmi_transaction_id": txn_id},
            {"_id": 0, "invoice_id": 1, "amount": 1},
        )
        if txn and txn.get("invoice_id"):
            await db.invoices.update_one(
                {"id": txn["invoice_id"], "company_id": cid},
                {"$set": {"status": "unpaid", "balance_due": txn.get("amount") or 0,
                          "updated_at": now}},
            )


# ---- Merchant: list transactions --------------------------------

@router.get("/companies/{cid}/nmi/transactions")
async def list_txns(cid: str, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    docs = await db.nmi_transactions.find(
        {"company_id": cid}, {"_id": 0},
    ).sort("created_at", -1).to_list(500)
    return {"items": docs}
