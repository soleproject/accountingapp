"""SmartBooks — Stripe billing & webhook routes (Feb 2026).

Owns three responsibilities:

1. **Webhook receiver** at ``POST /api/stripe/webhook`` — verifies the
   Stripe signature (``STRIPE_WEBHOOK_SECRET``), fans out on event type,
   and mutates our own collections idempotently.

   Events handled:
     * ``checkout.session.completed`` — first payment. Auto-creates a
       user account if the payer's email is new, mints a magic-link
       password-set token, sends the welcome email. Attaches
       ``stripe_customer_id`` and (for subscriptions) ``stripe_subscription_id``
       to the user row. If Stripe's ``client_reference_id`` matches one
       of our affiliate slugs, sets ``referred_by_user_id`` — the field
       downstream revenue-share reads from.
     * ``invoice.paid`` — logs the payment to ``platform_payments`` and,
       if the payer has a ``referred_by_user_id``, credits 20% of the
       gross to ``referral_earnings`` for that referrer.
     * ``customer.subscription.deleted`` — marks the user's subscription
       as canceled so the UI can nudge them to resubscribe.

   Idempotency: every event id is written to ``stripe_webhook_events``
   before we act. Duplicate deliveries (Stripe retries aggressively) are
   short-circuited on the id lookup.

2. **Client "My Billing"** — ``GET /api/billing/me`` returns the current
   user's plan, next-invoice preview, and paid invoices.

3. **Pro / Superadmin views** — ``GET /api/billing/pro/clients`` and
   ``GET /api/billing/superadmin`` roll up the same ``platform_payments``
   ledger from different vantage points, and expose per-referrer credit
   balances that back the "Refer & earn" dashboard.

The affiliate share is 20% (see ``AFFILIATE_SHARE_BPS``). Tracked only —
no automatic Stripe Connect payout in this iteration.
"""
from __future__ import annotations
import os
import uuid
import logging
from datetime import datetime, timezone
from typing import Optional

import stripe
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from db import db, now_iso, coerce
from auth import get_current_user, create_token, hash_password
import secrets as _secrets

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api")

# Configure the stripe SDK from env at import time. If the key is missing
# (fresh local checkout) we still register the routes so callers get a
# 500 with a clear message rather than a boot failure.
_STRIPE_KEY = os.environ.get("STRIPE_SECRET_KEY", "")
if _STRIPE_KEY:
    stripe.api_key = _STRIPE_KEY

_WEBHOOK_SECRET = os.environ.get("STRIPE_WEBHOOK_SECRET", "")

# 20% of gross, stored in basis points so it's precise + audit-friendly
# when the admin dashboard renders it.
AFFILIATE_SHARE_BPS = int(os.environ.get("AFFILIATE_SHARE_BPS", "2000"))


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------

async def _find_or_create_user_from_stripe(
    *,
    email: str,
    name: Optional[str],
    stripe_customer_id: Optional[str],
    ref_slug: Optional[str],
) -> tuple[dict, bool]:
    """Look up a user by email; if missing, create a fresh client account
    with a random password (they'll set their real one via magic link).

    Returns ``(user_doc, is_new)``.
    """
    email = email.lower().strip()
    existing = await db.users.find_one({"email": email})
    if existing:
        # Link the Stripe customer id if we haven't seen it before.
        if stripe_customer_id and existing.get("stripe_customer_id") != stripe_customer_id:
            await db.users.update_one(
                {"id": existing["id"]},
                {"$set": {
                    "stripe_customer_id": stripe_customer_id,
                    "updated_at": now_iso(),
                }},
            )
            existing["stripe_customer_id"] = stripe_customer_id
        return existing, False

    uid = str(uuid.uuid4())
    now = now_iso()
    # Random password — user never sees it. They'll set a real one via
    # the /set-password magic link. If they ignore the link, they can
    # always hit /forgot-password to recover.
    filler_password = _secrets.token_urlsafe(24)
    doc = {
        "id": uid,
        "email": email,
        "name": name or email.split("@")[0],
        "password": hash_password(filler_password),
        "role": "client",
        "stripe_customer_id": stripe_customer_id,
        "created_at": now,
        "updated_at": now,
    }
    if ref_slug:
        from referral_util import resolve_referrer_id
        referrer_id = await resolve_referrer_id(ref_slug)
        if referrer_id:
            doc["referred_by_user_id"] = referrer_id
    await db.users.insert_one(doc)
    return doc, True


async def _send_welcome_magic_link(user: dict, *, source: str = "stripe_signup") -> None:
    """Mint a password-set token and email the magic link. Failures are
    logged, never raised — the webhook must always ack 200 to Stripe."""
    try:
        from routes.auth import mint_password_set_token
        from email_dispatcher import dispatch, public_base_url
        import email_templates as _tmpl
        token = await mint_password_set_token(user["id"], purpose="welcome", ttl_days=14)
        magic_url = f"{public_base_url()}/set-password/{token}"
        subject, html = _tmpl.stripe_welcome(
            name=user.get("name") or user["email"].split("@")[0],
            magic_url=magic_url,
        )
        await dispatch(
            kind="stripe_welcome",
            to=user["email"],
            subject=subject,
            html=html,
            initiating_user_id=user["id"],
            related={"source": source},
        )
    except Exception:  # noqa: BLE001
        logger.exception("Failed to send Stripe welcome to %s", user.get("email"))


async def _record_payment(
    *,
    invoice: dict,
    user_id: Optional[str],
    stripe_customer_id: Optional[str],
) -> Optional[str]:
    """Insert a single row into ``platform_payments``. Idempotent on the
    Stripe invoice id — a retried webhook won't double-insert."""
    inv_id = invoice.get("id")
    if not inv_id:
        return None
    existing = await db.platform_payments.find_one({"stripe_invoice_id": inv_id})
    if existing:
        return existing["id"]
    pid = str(uuid.uuid4())
    now = now_iso()
    amount_cents = int(invoice.get("amount_paid") or invoice.get("amount_due") or 0)
    doc = {
        "id": pid,
        "stripe_invoice_id": inv_id,
        "stripe_customer_id": stripe_customer_id,
        "stripe_subscription_id": invoice.get("subscription"),
        "user_id": user_id,
        "amount_cents": amount_cents,
        "currency": (invoice.get("currency") or "usd").lower(),
        "hosted_invoice_url": invoice.get("hosted_invoice_url"),
        "invoice_pdf": invoice.get("invoice_pdf"),
        "period_start": invoice.get("period_start"),
        "period_end": invoice.get("period_end"),
        "paid_at": now,
        "created_at": now,
        "updated_at": now,
    }
    await db.platform_payments.insert_one(doc)
    return pid


async def _credit_referral_share(
    *,
    payment_id: str,
    invoice: dict,
    payer_user: dict,
) -> None:
    """If the payer has a ``referred_by_user_id``, credit 20% of the
    payment to that referrer's earnings ledger. Idempotent on the
    (payment_id, referrer_id) pair.
    """
    referrer_id = payer_user.get("referred_by_user_id")
    if not referrer_id:
        return
    gross_cents = int(invoice.get("amount_paid") or 0)
    if gross_cents <= 0:
        return
    share_cents = (gross_cents * AFFILIATE_SHARE_BPS) // 10_000
    # Idempotency guard — one earnings row per (payment, referrer).
    dup = await db.referral_earnings.find_one({
        "platform_payment_id": payment_id, "referrer_user_id": referrer_id,
    })
    if dup:
        return
    await db.referral_earnings.insert_one({
        "id": str(uuid.uuid4()),
        "platform_payment_id": payment_id,
        "stripe_invoice_id": invoice.get("id"),
        "referrer_user_id": referrer_id,
        "referred_user_id": payer_user["id"],
        "gross_cents": gross_cents,
        "share_bps": AFFILIATE_SHARE_BPS,
        "share_cents": share_cents,
        "currency": (invoice.get("currency") or "usd").lower(),
        # "accrued" until an admin marks it paid_out. No Stripe Connect
        # automation yet — this is a manual reconciliation ledger.
        "status": "accrued",
        "created_at": now_iso(),
    })


# --------------------------------------------------------------------------
# Webhook
# --------------------------------------------------------------------------

@router.post("/stripe/webhook")
async def stripe_webhook(request: Request):
    """Stripe webhook receiver. Verifies signature, dedupes on event id,
    and fans out to the per-type handlers. Always returns 200 unless the
    signature is invalid — Stripe retries anything else, which we don't
    want for logic bugs.
    """
    if not _WEBHOOK_SECRET:
        logger.error("STRIPE_WEBHOOK_SECRET is not configured")
        raise HTTPException(500, "Stripe webhook secret not configured")

    payload = await request.body()
    sig = request.headers.get("stripe-signature", "")
    try:
        event = stripe.Webhook.construct_event(payload, sig, _WEBHOOK_SECRET)
    except stripe.error.SignatureVerificationError:
        logger.warning("Stripe webhook signature verification failed")
        raise HTTPException(400, "Invalid signature")
    except Exception as e:  # noqa: BLE001
        logger.exception("Stripe webhook parse failed")
        raise HTTPException(400, f"Malformed webhook: {e}")

    event_id = event.get("id")
    event_type = event.get("type")

    # Idempotency — Stripe retries aggressively. Bail early if we've
    # already processed this event id.
    if event_id:
        dup = await db.stripe_webhook_events.find_one({"id": event_id})
        if dup:
            return {"status": "duplicate", "event_id": event_id}
        await db.stripe_webhook_events.insert_one({
            "id": event_id, "type": event_type,
            "received_at": now_iso(),
        })

    obj = event["data"]["object"]
    try:
        if event_type == "checkout.session.completed":
            await _handle_checkout_completed(obj)
        elif event_type == "invoice.paid":
            await _handle_invoice_paid(obj)
        elif event_type in ("customer.subscription.deleted",
                             "customer.subscription.updated"):
            await _handle_subscription_change(obj)
    except Exception:  # noqa: BLE001
        logger.exception("Stripe webhook handler failed for %s", event_type)
        # We still 200 so Stripe stops retrying — the event is logged in
        # `stripe_webhook_events` for manual replay if needed.
    return {"status": "ok", "type": event_type}


async def _handle_checkout_completed(session: dict) -> None:
    email = (
        (session.get("customer_details") or {}).get("email")
        or session.get("customer_email")
        or ""
    ).lower().strip()
    if not email:
        logger.warning("checkout.session.completed with no email: %s", session.get("id"))
        return

    name = (session.get("customer_details") or {}).get("name")
    stripe_customer_id = session.get("customer")
    stripe_subscription_id = session.get("subscription")

    # Stripe payment-link fields:
    #   - client_reference_id: what we ask referrers to append (?client_reference_id=<slug>)
    #   - metadata.ref: fallback when the link builder uses metadata instead
    ref_slug = (
        session.get("client_reference_id")
        or (session.get("metadata") or {}).get("ref")
    )

    user, is_new = await _find_or_create_user_from_stripe(
        email=email, name=name,
        stripe_customer_id=stripe_customer_id,
        ref_slug=ref_slug,
    )

    # Persist subscription id + plan hint on the user row so the "My
    # Billing" page can render without a Stripe round-trip.
    update: dict = {"updated_at": now_iso()}
    if stripe_subscription_id:
        update["stripe_subscription_id"] = stripe_subscription_id
        update["subscription_status"] = "active"
    if stripe_customer_id and not user.get("stripe_customer_id"):
        update["stripe_customer_id"] = stripe_customer_id
    if update:
        await db.users.update_one({"id": user["id"]}, {"$set": update})

    if is_new:
        await _send_welcome_magic_link(user, source="stripe_signup")


async def _handle_invoice_paid(invoice: dict) -> None:
    stripe_customer_id = invoice.get("customer")
    email = (invoice.get("customer_email") or "").lower().strip()

    # Prefer customer id (stable) — fall back to email.
    user = None
    if stripe_customer_id:
        user = await db.users.find_one({"stripe_customer_id": stripe_customer_id})
    if not user and email:
        user = await db.users.find_one({"email": email})

    if not user and email:
        # Rare: invoice paid for a customer we have no record of. Bootstrap
        # them so the payment isn't orphaned.
        user, _ = await _find_or_create_user_from_stripe(
            email=email, name=invoice.get("customer_name"),
            stripe_customer_id=stripe_customer_id, ref_slug=None,
        )

    pid = await _record_payment(
        invoice=invoice,
        user_id=(user or {}).get("id"),
        stripe_customer_id=stripe_customer_id,
    )
    if pid and user:
        await _credit_referral_share(
            payment_id=pid, invoice=invoice, payer_user=user,
        )


async def _handle_subscription_change(sub: dict) -> None:
    stripe_customer_id = sub.get("customer")
    if not stripe_customer_id:
        return
    status = sub.get("status")  # 'active' | 'canceled' | 'past_due' | ...
    await db.users.update_one(
        {"stripe_customer_id": stripe_customer_id},
        {"$set": {
            "stripe_subscription_id": sub.get("id"),
            "subscription_status": status,
            "subscription_canceled_at": (
                datetime.fromtimestamp(sub["canceled_at"], tz=timezone.utc).isoformat()
                if sub.get("canceled_at") else None
            ),
            "updated_at": now_iso(),
        }},
    )


# --------------------------------------------------------------------------
# Billing views
# --------------------------------------------------------------------------

@router.get("/billing/me")
async def my_billing(user: dict = Depends(get_current_user)):
    """Return the signed-in user's subscription snapshot + invoice history."""
    fresh = await db.users.find_one({"id": user["id"]}) or {}
    payments = await (
        db.platform_payments
          .find({"user_id": user["id"]})
          .sort("paid_at", -1)
          .to_list(200)
    )
    total_cents = sum(int(p.get("amount_cents") or 0) for p in payments)
    return {
        "subscription": {
            "status": fresh.get("subscription_status"),
            "stripe_customer_id": fresh.get("stripe_customer_id"),
            "stripe_subscription_id": fresh.get("stripe_subscription_id"),
            "canceled_at": fresh.get("subscription_canceled_at"),
        },
        "payments": [coerce(p) for p in payments],
        "total_paid_cents": total_cents,
    }


@router.get("/billing/pro/clients")
async def pro_client_billing(user: dict = Depends(get_current_user)):
    """Pro view — every client this pro touches (owner of a company the
    pro has membership in) with their billing status + total paid."""
    if user["role"] not in ("pro", "superadmin"):
        raise HTTPException(403, "Only pros can view client billing")

    # Companies the pro has access to.
    if user["role"] == "superadmin":
        companies = await db.companies.find({}).to_list(2000)
    else:
        ms = await db.memberships.find({"user_id": user["id"]}).to_list(2000)
        cids = [m["company_id"] for m in ms]
        companies = await db.companies.find({"id": {"$in": cids}}).to_list(2000)

    owner_ids = list({c["owner_user_id"] for c in companies if c.get("owner_user_id")})
    if not owner_ids:
        return {"clients": []}
    owners = await db.users.find({"id": {"$in": owner_ids}}).to_list(2000)
    payments = await db.platform_payments.find({"user_id": {"$in": owner_ids}}).to_list(5000)

    totals: dict[str, int] = {}
    counts: dict[str, int] = {}
    for p in payments:
        uid = p.get("user_id")
        if not uid:
            continue
        totals[uid] = totals.get(uid, 0) + int(p.get("amount_cents") or 0)
        counts[uid] = counts.get(uid, 0) + 1

    rows = []
    for o in owners:
        rows.append({
            "id": o["id"],
            "email": o["email"],
            "name": o.get("name"),
            "subscription_status": o.get("subscription_status"),
            "stripe_customer_id": o.get("stripe_customer_id"),
            "total_paid_cents": totals.get(o["id"], 0),
            "invoice_count": counts.get(o["id"], 0),
        })
    rows.sort(key=lambda r: r["total_paid_cents"], reverse=True)
    return {"clients": rows}


@router.get("/billing/superadmin")
async def superadmin_billing(user: dict = Depends(get_current_user)):
    """Platform-wide revenue view. Requires superadmin.

    Returns three roll-ups:
      * totals — lifetime revenue, active subscribers, referral payouts owed
      * recent_payments — last 100 payments across the platform
      * top_affiliates — top referrers by pending payout amount
    """
    if user["role"] != "superadmin":
        raise HTTPException(403, "Superadmin only")

    all_payments = await (
        db.platform_payments.find({}).sort("paid_at", -1).to_list(5000)
    )
    total_cents = sum(int(p.get("amount_cents") or 0) for p in all_payments)

    active_subs = await db.users.count_documents({"subscription_status": "active"})
    canceled_subs = await db.users.count_documents({"subscription_status": "canceled"})

    earnings = await db.referral_earnings.find({}).to_list(5000)
    accrued_cents = sum(int(e.get("share_cents") or 0) for e in earnings if e.get("status") == "accrued")
    paid_out_cents = sum(int(e.get("share_cents") or 0) for e in earnings if e.get("status") == "paid_out")

    # Top affiliates.
    per_ref: dict[str, dict] = {}
    for e in earnings:
        rid = e.get("referrer_user_id")
        if not rid:
            continue
        row = per_ref.setdefault(rid, {"referrer_user_id": rid, "accrued_cents": 0, "paid_out_cents": 0, "count": 0})
        row["count"] += 1
        if e.get("status") == "paid_out":
            row["paid_out_cents"] += int(e.get("share_cents") or 0)
        else:
            row["accrued_cents"] += int(e.get("share_cents") or 0)
    ref_ids = list(per_ref.keys())
    ref_users = await db.users.find({"id": {"$in": ref_ids}}).to_list(2000) if ref_ids else []
    ref_users_by_id = {u["id"]: u for u in ref_users}
    top = list(per_ref.values())
    for row in top:
        u = ref_users_by_id.get(row["referrer_user_id"], {})
        row["email"] = u.get("email")
        row["name"] = u.get("name")
    top.sort(key=lambda r: r["accrued_cents"] + r["paid_out_cents"], reverse=True)

    return {
        "totals": {
            "gross_revenue_cents": total_cents,
            "active_subscribers": active_subs,
            "canceled_subscribers": canceled_subs,
            "referral_accrued_cents": accrued_cents,
            "referral_paid_out_cents": paid_out_cents,
            "net_revenue_cents": total_cents - accrued_cents - paid_out_cents,
        },
        "recent_payments": [coerce(p) for p in all_payments[:100]],
        "top_affiliates": top[:50],
    }


# --------------------------------------------------------------------------
# Affiliate earnings breakdown — used by /share dashboard.
# --------------------------------------------------------------------------

@router.get("/billing/affiliate/me")
async def my_affiliate_earnings(user: dict = Depends(get_current_user)):
    """Earnings roll-up for the signed-in referrer. Powers the numbers on
    the /share page. Splits accrued (owed to them) vs paid_out."""
    earnings = await (
        db.referral_earnings.find({"referrer_user_id": user["id"]})
          .sort("created_at", -1)
          .to_list(1000)
    )
    accrued = sum(int(e.get("share_cents") or 0) for e in earnings if e.get("status") == "accrued")
    paid_out = sum(int(e.get("share_cents") or 0) for e in earnings if e.get("status") == "paid_out")

    referred_users = await db.users.count_documents({"referred_by_user_id": user["id"]})
    paying_ids = list({e.get("referred_user_id") for e in earnings if e.get("referred_user_id")})
    return {
        "referred_count": referred_users,
        "paying_count": len(paying_ids),
        "accrued_cents": accrued,
        "paid_out_cents": paid_out,
        "earnings": [coerce(e) for e in earnings[:200]],
    }


# --------------------------------------------------------------------------
# Superadmin — mark referral earnings as paid_out.
# --------------------------------------------------------------------------

class MarkPaidIn(BaseModel):
    earning_ids: list[str]


@router.post("/billing/superadmin/mark-paid")
async def mark_paid_out(inp: MarkPaidIn, user: dict = Depends(get_current_user)):
    """Bulk-mark referral earnings as paid_out (e.g. after cutting a
    Stripe payout or manual bank transfer). Superadmin only."""
    if user["role"] != "superadmin":
        raise HTTPException(403, "Superadmin only")
    if not inp.earning_ids:
        return {"updated": 0}
    res = await db.referral_earnings.update_many(
        {"id": {"$in": inp.earning_ids}, "status": "accrued"},
        {"$set": {
            "status": "paid_out",
            "paid_out_at": now_iso(),
            "paid_out_by": user["id"],
        }},
    )
    return {"updated": res.modified_count}
