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
    # Fresh drafts don't carry `public_token`, so the projection can
    # return an empty dict `{}` — which is falsy. Explicit `is None`
    # avoids that gotcha (a real missing invoice still returns None).
    if inv is None:
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
    # Don't mint a share link for an invoice that's already settled,
    # voided, or cancelled — the resulting page is either a
    # "Payment received. Thank you!" confirmation or a $0 form,
    # neither of which the merchant meant to hand to their customer.
    inv = await db.invoices.find_one(
        {"id": iid, "company_id": cid},
        {"_id": 0, "status": 1, "id": 1},
    )
    if inv is None:
        raise HTTPException(404, "Invoice not found.")
    if (inv.get("status") or "").lower() in ("paid", "voided", "cancelled"):
        raise HTTPException(
            409,
            f"This invoice is {inv['status']} — nothing to pay. Duplicate it if you need a new one.",
        )
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
    # Post to the accounting ledger so the invoice UI reflects the
    # payment. This also flips invoice.status to paid/partial and
    # decrements balance_due — no more optimistic-set/UI-disagrees bug.
    nmi_txn_id = result.get("transactionid") or result.get("id") or ""
    await _post_payment_to_ledger(
        cid, inv["id"], gross_amount=amount, method=body.method,
        nmi_transaction_id=nmi_txn_id,
    )
    # Cha-ching! Celebrate the merchant. Fire-and-forget email +
    # in-app bell so the owner learns cash landed without having to
    # go hunt for it.
    try:
        await _notify_merchant_of_payment(
            cid=cid, inv=inv, amount=amount, method=body.method,
            nmi_txn_id=nmi_txn_id, customer_email=(body.customer_email or "").strip(),
        )
    except Exception as e:  # noqa: BLE001
        log.warning("merchant payment notify failed for %s: %s", inv["id"], e)
    # Fire-and-forget receipt to the paying customer. Best-effort —
    # a failed email doesn't roll back the payment.
    to_email = (body.customer_email or inv.get("customer_email") or "").strip()
    if to_email:
        try:
            await _send_receipt_email(
                cid=cid, inv=inv, amount=amount, method=body.method,
                to_email=to_email, nmi_txn_id=nmi_txn_id,
                last4=(result.get("cc_number") or "")[-4:] if result.get("cc_number") else "",
            )
        except Exception as e:  # noqa: BLE001
            log.warning("customer receipt email failed for %s: %s", inv["id"], e)
    return {"ok": True, "transaction_id": nmi_txn_id, "amount": float(amount)}


async def _send_receipt_email(
    *, cid: str, inv: dict, amount: Decimal, method: str,
    to_email: str, nmi_txn_id: str, last4: str = "",
) -> None:
    """Plain receipt email sent after a successful Pay Now sale.
    Kept intentionally lightweight — no HTML template inheritance,
    no MJML, just a legible message the payer can save/forward."""
    from email_service import send_email  # local to avoid boot cycles
    company = await db.companies.find_one({"id": cid}, {"_id": 0, "name": 1}) or {}
    biz = company.get("name") or "your merchant"
    method_label = "Credit / Debit Card" if method == "card" else "Bank Transfer (ACH)"
    card_line = f" ending in <b>…{last4}</b>" if last4 else ""
    inv_no = inv.get("number") or inv.get("id") or ""
    html = f"""
<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;padding:24px;">
  <h1 style="font-size:22px;color:#0f172a;margin:0 0 6px;">Payment received</h1>
  <p style="font-size:14px;color:#334155;margin:0 0 16px;">
    Thanks for your payment to <b>{biz}</b>. Here's your receipt.
  </p>
  <table cellpadding="0" cellspacing="0" style="width:100%;font-size:14px;color:#334155;border-collapse:collapse;">
    <tr><td style="padding:8px 0;border-bottom:1px solid #e2e8f0;">Amount</td>
        <td style="padding:8px 0;border-bottom:1px solid #e2e8f0;text-align:right;font-weight:700;">${amount:.2f}</td></tr>
    <tr><td style="padding:8px 0;border-bottom:1px solid #e2e8f0;">Invoice</td>
        <td style="padding:8px 0;border-bottom:1px solid #e2e8f0;text-align:right;">#{inv_no}</td></tr>
    <tr><td style="padding:8px 0;border-bottom:1px solid #e2e8f0;">Method</td>
        <td style="padding:8px 0;border-bottom:1px solid #e2e8f0;text-align:right;">{method_label}{card_line}</td></tr>
    <tr><td style="padding:8px 0;">Confirmation</td>
        <td style="padding:8px 0;text-align:right;font-family:ui-monospace,monospace;">{nmi_txn_id or "—"}</td></tr>
  </table>
  <p style="font-size:12px;color:#64748b;margin-top:20px;line-height:1.6;">
    Questions? Reply to this email and it'll go straight to <b>{biz}</b>. Keep this receipt for your records.
  </p>
</div>
""".strip()
    await send_email(to=to_email, subject=f"Receipt from {biz} · ${amount:.2f}", html=html)


async def _notify_merchant_of_payment(
    *, cid: str, inv: dict, amount: Decimal, method: str,
    nmi_txn_id: str, customer_email: str = "",
) -> None:
    """Cha-ching! Tell the merchant one of their customers just paid.

    Fires three channels — celebratory email, in-app bell, and a
    ledger entry the Cockpit activity ribbon can pick up. Dedupes on
    ``nmi_transaction_id`` so the Direct Post response path and the
    webhook ``sale.success`` event don't both notify.
    """
    from email_service import send_email  # local to avoid boot cycles
    from routes.notifications import notify

    # Dedup: mark the txn row as notified atomically. If someone
    # else already did it, bail out — this keeps webhook + response
    # paths from double-firing.
    marked = await db.nmi_transactions.update_one(
        {
            "company_id": cid,
            "nmi_transaction_id": nmi_txn_id,
            "merchant_notified_at": {"$exists": False},
        },
        {"$set": {"merchant_notified_at": _now()}},
    )
    if not marked.modified_count:
        return

    company = await db.companies.find_one({"id": cid}, {"_id": 0, "name": 1}) or {}
    biz = company.get("name") or "your business"
    inv_no = inv.get("number") or inv.get("id") or ""
    invoice_id = inv.get("id")
    cust_name = (inv.get("customer_name") or inv.get("customer_email")
                  or customer_email or "A customer").strip()
    method_label = "card" if method in ("card", "apple_pay", "google_pay") else "ACH"
    method_pretty = "Credit / Debit Card" if method_label == "card" else "Bank Transfer (ACH)"
    link = f"/invoices/{invoice_id}" if invoice_id else "/invoices"

    # ---- In-app bell + web push (each owner + pro on the account) --
    #
    # We include the accountant Pro too — for accounting firms
    # running the books, "money hit the account" is exactly the
    # signal they care about.
    recipients: list[str] = []
    async for m in db.memberships.find(
        {"company_id": cid, "role": {"$in": ["owner", "pro"]}},
        {"_id": 0, "user_id": 1},
    ):
        uid = m.get("user_id")
        if uid and uid not in recipients:
            recipients.append(uid)
    body_short = f"{cust_name} paid ${amount:,.2f} on invoice #{inv_no} via {method_label.upper()}."
    for uid in recipients:
        try:
            await notify(
                company_id=cid, user_id=uid,
                kind="payment_received",
                title=f"💰 You got paid — ${amount:,.2f}",
                body=body_short,
                link=link,
                source={"kind": "nmi_transaction", "id": nmi_txn_id or invoice_id or ""},
            )
        except Exception:  # noqa: BLE001
            log.exception("payment_received bell failed uid=%s", uid)

    # ---- Celebratory email to the business owner ------------------
    owner_email = ""
    owner_name = ""
    om = await db.memberships.find_one(
        {"company_id": cid, "role": "owner"}, {"_id": 0, "user_id": 1},
    )
    if om and om.get("user_id"):
        ou = await db.users.find_one(
            {"id": om["user_id"]}, {"_id": 0, "email": 1, "name": 1},
        )
        if ou:
            owner_email = (ou.get("email") or "").strip()
            owner_name = (ou.get("name") or "").split()[0] if ou.get("name") else ""
    if owner_email:
        greet = f"Hey {owner_name}," if owner_name else "Hey there,"
        html = f"""
<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;padding:28px 24px;background:#0f172a;color:#f8fafc;border-radius:16px;">
  <div style="font-size:12px;letter-spacing:.18em;text-transform:uppercase;color:#34d399;margin-bottom:8px;font-weight:700;">
    Cha-ching! 💰
  </div>
  <h1 style="font-size:30px;line-height:1.15;margin:0 0 10px;color:#f8fafc;font-weight:800;">
    You just got paid&nbsp;<span style="color:#34d399;">${amount:,.2f}</span>
  </h1>
  <p style="font-size:14px;color:#cbd5e1;margin:0 0 22px;line-height:1.5;">
    {greet} <b>{cust_name}</b> just settled invoice&nbsp;<b>#{inv_no}</b>. The
    funds are booked to your ledger and the invoice is marked paid — nothing else to do.
  </p>
  <table cellpadding="0" cellspacing="0" style="width:100%;font-size:14px;color:#e2e8f0;border-collapse:collapse;background:#1e293b;border-radius:12px;overflow:hidden;">
    <tr>
      <td style="padding:12px 16px;border-bottom:1px solid #334155;color:#94a3b8;">Amount</td>
      <td style="padding:12px 16px;border-bottom:1px solid #334155;text-align:right;font-weight:700;color:#f8fafc;">${amount:,.2f}</td>
    </tr>
    <tr>
      <td style="padding:12px 16px;border-bottom:1px solid #334155;color:#94a3b8;">Customer</td>
      <td style="padding:12px 16px;border-bottom:1px solid #334155;text-align:right;">{cust_name}</td>
    </tr>
    <tr>
      <td style="padding:12px 16px;border-bottom:1px solid #334155;color:#94a3b8;">Invoice</td>
      <td style="padding:12px 16px;border-bottom:1px solid #334155;text-align:right;">#{inv_no}</td>
    </tr>
    <tr>
      <td style="padding:12px 16px;border-bottom:1px solid #334155;color:#94a3b8;">Method</td>
      <td style="padding:12px 16px;border-bottom:1px solid #334155;text-align:right;">{method_pretty}</td>
    </tr>
    <tr>
      <td style="padding:12px 16px;color:#94a3b8;">Confirmation</td>
      <td style="padding:12px 16px;text-align:right;font-family:ui-monospace,monospace;color:#94a3b8;font-size:12px;">{nmi_txn_id or "—"}</td>
    </tr>
  </table>
  <div style="text-align:center;margin:24px 0 6px;">
    <a href="{link}" style="display:inline-block;padding:12px 28px;background:#34d399;color:#0f172a;font-weight:700;font-size:14px;text-decoration:none;border-radius:999px;">
      View the invoice →
    </a>
  </div>
  <p style="font-size:12px;color:#64748b;margin-top:22px;line-height:1.6;text-align:center;">
    Sent from <b>{biz}</b>'s accounting workspace. Card settlements typically land in 1–2 business days; ACH in 3–5.
  </p>
</div>
""".strip()
        try:
            await send_email(
                to=owner_email,
                subject=f"💰 You got paid ${amount:,.2f} from {cust_name}",
                html=html,
            )
        except Exception:  # noqa: BLE001
            log.exception("payment_received email to %s failed", owner_email)


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
        "nmi_transaction_id": resp.get("transactionid") or resp.get("id"),
        "amount":           float(amount),
        "status":           status,
        "method":           method,
        "response_code":    resp.get("response") or resp.get("response_code"),
        "response_text":    resp.get("responsetext") or resp.get("response_text"),
        "auth_code":        resp.get("authcode"),
        "saved_to_vault":   bool(save_to_vault),
        "customer_vault_id": resp.get("customer_vault_id"),
        "created_at":       now,
    })


# ---- Ledger integration ------------------------------------------
#
# NMI is the payment rail; `db.payments` is our accounting ledger.
# Every successful gateway sale must land in BOTH places or the
# invoice UI (which sums `db.payments.amount`) will silently disagree
# with the payment page (which reads `invoice.status`). Void /
# full-refund reverse the ledger; partial refund posts a negative
# payment row so the balance restores by exactly the refund amount.

_METHOD_TO_LEDGER = {
    "card":       "credit_card",
    "ach":        "ach",
    "apple_pay":  "credit_card",
    "google_pay": "credit_card",
}


async def _post_payment_to_ledger(
    cid: str, invoice_id: str, gross_amount: Decimal | float,
    method: str, nmi_transaction_id: str,
) -> None:
    """Create a `payments` row against the invoice for `gross_amount`
    (the net cash actually collected — includes the card surcharge)
    and shrink the invoice's balance_due by the invoice's *original*
    portion of that money. If balance_due hits zero, the invoice
    flips to `paid`.

    Note: only the invoice-side portion counts against balance_due —
    surcharge is customer-paid processor fees, not part of the sale.
    """
    from db import ledger_transaction
    now = _now()
    async with ledger_transaction() as _s:
        inv = await db.invoices.find_one(
            {"id": invoice_id, "company_id": cid}, session=_s,
        )
        if not inv:
            return
        # Applied amount = min(gross, current balance) — the surcharge
        # component doesn't reduce AR, it's pass-through revenue-to-
        # processor.
        current_balance = float(inv.get("balance_due", inv.get("total", 0)) or 0)
        applied = round(min(float(gross_amount), current_balance), 2)
        new_balance = round(current_balance - applied, 2)
        await db.payments.insert_one({
            "id":                    str(uuid.uuid4()),
            "company_id":            cid,
            "date":                  now[:10],
            "amount":                applied,
            "method":                _METHOD_TO_LEDGER.get(method, "other"),
            "reference":             nmi_transaction_id,
            "notes":                 f"Card & ACH payment (NMI txn {nmi_transaction_id})",
            "linked_invoice_id":     invoice_id,
            "linked_bill_id":        None,
            "direction":             "in",
            "contact_id":            inv.get("contact_id"),
            "nmi_transaction_id":    nmi_transaction_id,   # reverse link for void/refund
            "created_at":            now,
            "updated_at":            now,
        }, session=_s)
        await db.invoices.update_one(
            {"id": invoice_id, "company_id": cid},
            {"$set": {
                "balance_due": new_balance,
                "status": "paid" if new_balance <= 0.005 else "partial",
                "updated_at": now,
            }},
            session=_s,
        )


async def _reverse_payment_in_ledger(
    cid: str, nmi_transaction_id: str, refund_amount: Decimal | float | None = None,
) -> None:
    """Undo the ledger side of a sale.

    * If `refund_amount is None` → full reversal: delete the payment
      row entirely, restore invoice balance_due by the original
      applied amount, and re-open the invoice status.
    * Otherwise → partial refund: post a negative `payments` row and
      bump balance_due by `refund_amount`. The invoice stays `paid`
      if balance is still zero, else flips to `partial`.
    """
    from db import ledger_transaction
    now = _now()
    async with ledger_transaction() as _s:
        p = await db.payments.find_one(
            {"company_id": cid, "nmi_transaction_id": nmi_transaction_id,
             "amount": {"$gt": 0}},
            session=_s,
        )
        if not p:
            return
        invoice_id = p.get("linked_invoice_id")
        applied = float(p.get("amount") or 0)
        if refund_amount is None:
            # Full reversal — delete the row.
            await db.payments.delete_one({"id": p["id"]}, session=_s)
            restore = applied
        else:
            # Partial refund — negative twin row for audit trail.
            r = round(float(refund_amount), 2)
            await db.payments.insert_one({
                "id":                 str(uuid.uuid4()),
                "company_id":         cid,
                "date":               now[:10],
                "amount":             -r,
                "method":             p.get("method") or "other",
                "reference":          nmi_transaction_id,
                "notes":              f"Refund of NMI txn {nmi_transaction_id}",
                "linked_invoice_id":  invoice_id,
                "linked_bill_id":     None,
                "direction":          "in",
                "contact_id":         p.get("contact_id"),
                "nmi_transaction_id": nmi_transaction_id,
                "is_refund":          True,
                "created_at":         now,
                "updated_at":         now,
            }, session=_s)
            restore = r
        if invoice_id:
            inv = await db.invoices.find_one(
                {"id": invoice_id, "company_id": cid}, session=_s,
            )
            if inv:
                new_balance = round(float(inv.get("balance_due") or 0) + restore, 2)
                total = float(inv.get("total") or 0)
                # Status: paid iff balance clears, partial iff between,
                # else back to sent so the pay link can be used again.
                status = "paid" if new_balance <= 0.005 else (
                    "partial" if new_balance < total - 0.005 else "sent"
                )
                await db.invoices.update_one(
                    {"id": invoice_id, "company_id": cid},
                    {"$set": {"balance_due": new_balance, "status": status,
                              "updated_at": now}},
                    session=_s,
                )


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
    # Reflect the refund in the accounting ledger — full or partial.
    await _reverse_payment_in_ledger(
        cid, txn_id, refund_amount=body.amount,  # None = full
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
    # Undo the ledger posting so the invoice re-opens for payment.
    await _reverse_payment_in_ledger(cid, txn_id, refund_amount=None)
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
    # FAIL-CLOSED: without a signing secret we cannot trust the
    # payload's authenticity, so we refuse to process it. The
    # merchant's Gateway Keys tab surfaces a persistent warning
    # while this is unset so the underwriter can wire it up.
    if not secret:
        log.warning("NMI webhook: no webhook_secret on file for %s — rejecting", company_id)
        raise HTTPException(
            401,
            "Webhook rejected: no signing secret on file. Set one in the merchant's Gateway Keys tab.",
        )
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
        # If the Direct Post response path didn't already notify
        # (e.g. NMI-portal-initiated sale, or the response never
        # reached us), fire the merchant celebration now. The
        # helper's dedupe flag prevents double-notify.
        txn = await db.nmi_transactions.find_one(
            {"company_id": cid, "nmi_transaction_id": txn_id},
            {"_id": 0, "invoice_id": 1, "amount": 1, "method": 1,
             "merchant_notified_at": 1},
        )
        if txn and not txn.get("merchant_notified_at") and txn.get("invoice_id"):
            inv = await db.invoices.find_one(
                {"id": txn["invoice_id"], "company_id": cid}, {"_id": 0},
            )
            if inv:
                try:
                    await _notify_merchant_of_payment(
                        cid=cid, inv=inv,
                        amount=Decimal(str(txn.get("amount") or 0)),
                        method=(txn.get("method") or "card"),
                        nmi_txn_id=txn_id,
                    )
                except Exception:  # noqa: BLE001
                    log.exception("webhook-driven merchant notify failed")
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
