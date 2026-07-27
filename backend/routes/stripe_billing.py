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
from auth import get_current_user, create_token, hash_password, require_role
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
# Company-scoped price catalog — Phase C.
#
# Each (product, tier) maps to a Stripe Price ID configured via env var so
# we never hard-code IDs into code. Naming convention:
#     STRIPE_PRICE_<PRODUCT>_<TIER>   (tier = REGULAR | DISCOUNT)
#
# Simple Start is already provisioned in the user's Stripe account:
#   $38/mo regular  → STRIPE_PRICE_SIMPLE_START_REGULAR (falls back to
#                     STRIPE_PRICE_SIMPLE_START_MONTHLY_38 for backwards-
#                     compat with the existing env)
#   $30/mo discount → STRIPE_PRICE_SIMPLE_START_DISCOUNT
# The other 7 (Essentials/Plus/Advanced × regular/discount) are placeholder
# env vars — populate them when you create those prices in Stripe.
def _price_id(product: str, discount: bool) -> Optional[str]:
    tier = "DISCOUNT" if discount else "REGULAR"
    key = f"STRIPE_PRICE_{product.upper()}_{tier}"
    pid = os.environ.get(key)
    if pid:
        return pid
    # Back-compat for the existing prod env keys.
    if product == "simple_start" and not discount:
        return os.environ.get("STRIPE_PRICE_SIMPLE_START_MONTHLY_38")
    if product == "simple_start" and discount:
        return os.environ.get("STRIPE_PRICE_SIMPLE_START_MONTHLY_19")
    return None


def _platform_base_url() -> str:
    """Return the platform URL to use as origin for success/cancel URLs.
    Order of preference: env override → PUBLIC_BASE_URL → localhost dev."""
    return (
        os.environ.get("STRIPE_RETURN_BASE_URL")
        or os.environ.get("PUBLIC_BASE_URL")
        or "http://localhost:3000"
    ).rstrip("/")


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
    Stripe invoice id — a retried webhook won't double-insert.

    Also stamps ``company_id`` on the row so the client "My Billing"
    page can scope payments to the currently-selected company (a user
    with multiple companies should NOT see aggregated totals under
    each company's Billing tab). Resolution order for company_id:
      1. ``invoice.metadata.company_id`` — set on client-card checkout.
      2. Fall back to looking up the company via
         ``stripe_subscription_id`` (webhook fired for a client-email
         payer where the metadata was on the SESSION, not the invoice).
    """
    inv_id = invoice.get("id")
    if not inv_id:
        return None
    existing = await db.platform_payments.find_one({"stripe_invoice_id": inv_id})
    if existing:
        return existing["id"]
    pid = str(uuid.uuid4())
    now = now_iso()
    amount_cents = int(invoice.get("amount_paid") or invoice.get("amount_due") or 0)
    company_id = (invoice.get("metadata") or {}).get("company_id")
    sub_id = invoice.get("subscription")
    if not company_id and sub_id:
        co = await db.companies.find_one(
            {"stripe_subscription_id": sub_id}, {"id": 1}
        )
        if co:
            company_id = co.get("id")
    doc = {
        "id": pid,
        "stripe_invoice_id": inv_id,
        "stripe_customer_id": stripe_customer_id,
        "stripe_subscription_id": sub_id,
        "user_id": user_id,
        "company_id": company_id,
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
        elif event_type == "invoice.payment_failed":
            await _handle_invoice_payment_failed(obj)
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

    # Phase C — if the checkout was for a specific COMPANY (Add-Client
    # "Pay with client card" flow attached metadata.company_id) then
    # flip that company's billing_state to active and link the
    # subscription so downstream webhooks can find the right row.
    company_id = (session.get("metadata") or {}).get("company_id")
    if company_id and stripe_subscription_id:
        await db.companies.update_one(
            {"id": company_id},
            {"$set": {
                "billing_state": "active",
                "stripe_subscription_id": stripe_subscription_id,
                "stripe_customer_id": stripe_customer_id,
                "updated_at": now_iso(),
            }},
        )


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

    # Phase C — if this invoice is for a company subscription, flip the
    # billing_state to active. Uses the subscription id (stable) as the
    # join key.
    sub_id = invoice.get("subscription")
    if sub_id:
        await db.companies.update_one(
            {"stripe_subscription_id": sub_id},
            {"$set": {"billing_state": "active", "updated_at": now_iso()}},
        )

    # Phase D — consolidated enterprise invoice paid. The scheduler
    # stamped `metadata.enterprise_invoice_id` on the invoice when it
    # created it, so we can join back precisely. Also flip every one of
    # the invoice's line-item companies to `active` since the whole
    # enterprise bill just settled.
    ent_inv_id = ((invoice.get("metadata") or {}).get("enterprise_invoice_id"))
    if ent_inv_id:
        await db.enterprise_invoices.update_one(
            {"id": ent_inv_id},
            {"$set": {
                "status": "paid",
                "paid_at": now_iso(),
                "amount_paid_cents": int(invoice.get("amount_paid") or 0),
            }},
        )
        ent_id = (invoice.get("metadata") or {}).get("enterprise_id")
        if ent_id:
            # Every enterprise-paid company under this enterprise is
            # covered by the month we just settled — mark them active
            # so the blocking modal (if it was up) auto-dismisses.
            await db.companies.update_many(
                {"enterprise_id": ent_id, "billing_payer": "enterprise"},
                {"$set": {"billing_state": "active", "updated_at": now_iso()}},
            )


async def _handle_invoice_payment_failed(invoice: dict) -> None:
    """Company-scoped: flip billing_state to past_due so the blocking
    modal appears on next page load. Also handles the consolidated-
    enterprise invoice case — every enterprise-paid company under the
    enterprise gets flipped to past_due together.

    On top of the state flip we now notify humans:
    * The paying client gets an email with a "Update payment method" CTA
      that deep-links to their /billing page.
    * The company's Pro(s) get an email + an unread alert on their
      /pro Alerts inbox so they can nudge the client personally.
    """
    from pro_alerts import emit_alert
    from email_dispatcher import dispatch

    sub_id = invoice.get("subscription")
    company = None
    if sub_id:
        company = await db.companies.find_one({"stripe_subscription_id": sub_id})
        await db.companies.update_one(
            {"stripe_subscription_id": sub_id},
            {"$set": {"billing_state": "past_due", "updated_at": now_iso()}},
        )

    # ---- Consolidated enterprise-invoice branch ------------------------
    ent_inv_id = ((invoice.get("metadata") or {}).get("enterprise_invoice_id"))
    if ent_inv_id:
        await db.enterprise_invoices.update_one(
            {"id": ent_inv_id},
            {"$set": {"status": "past_due", "updated_at": now_iso()}},
        )
        ent_id = (invoice.get("metadata") or {}).get("enterprise_id")
        if ent_id:
            await db.companies.update_many(
                {"enterprise_id": ent_id, "billing_payer": "enterprise"},
                {"$set": {"billing_state": "past_due", "updated_at": now_iso()}},
            )
        # For enterprise invoices we don't email the individual clients
        # (they aren't the payer). Do notify the enterprise owner Pro.
        if ent_id:
            ent = await db.enterprises.find_one({"id": ent_id})
            owner_uid = (ent or {}).get("owner_user_id")
            if owner_uid:
                amount = (invoice.get("amount_due") or 0) / 100.0
                await emit_alert(
                    pro_user_id=owner_uid,
                    kind="enterprise_payment_failed",
                    company_id=None,
                    message=(
                        f"Enterprise invoice of ${amount:,.2f} failed to charge "
                        f"— update the payment method on file."
                    ),
                    meta={
                        "enterprise_id": ent_id,
                        "stripe_invoice_id": invoice.get("id"),
                        "amount_usd": amount,
                    },
                )
        return

    # ---- Individual company (client-card) branch -----------------------
    if not company:
        return
    amount = (invoice.get("amount_due") or 0) / 100.0
    cid = company.get("id")

    # Notify client owner via email
    owner_uid = company.get("owner_user_id")
    owner = await db.users.find_one({"id": owner_uid}) if owner_uid else None
    base = _platform_base_url().rstrip("/")
    update_url = f"{base}/billing?company={cid}"

    if owner and owner.get("email"):
        try:
            from email_templates import payment_failed_client
            subj, html = payment_failed_client(
                client_name=owner.get("name") or owner["email"].split("@")[0],
                company_name=company.get("name") or "your business",
                amount_usd=amount,
                update_url=update_url,
                brand_name=(owner.get("branding") or {}).get("firm_name"),
            )
            await dispatch(
                kind="payment_failed_client",
                to=owner["email"],
                subject=subj,
                html=html,
                company_id=cid,
                initiating_user_id=None,
                related={"stripe_invoice_id": invoice.get("id")},
            )
        except Exception:  # noqa: BLE001
            logger.exception("payment_failed client email failed for %s", cid)

    # Notify every Pro attached to the company (memberships.role='pro' or
    # 'reviewer'). Also emit an in-app alert so the Pro sees a red dot
    # on the sidebar without opening their inbox.
    pro_memberships = db.memberships.find({
        "company_id": cid,
        "role": {"$in": ["pro", "reviewer", "owner"]},
    })
    seen_pros: set[str] = set()
    async for m in pro_memberships:
        pro_uid = m.get("user_id")
        if not pro_uid or pro_uid in seen_pros:
            continue
        seen_pros.add(pro_uid)
        pro = await db.users.find_one({"id": pro_uid})
        if not pro or pro.get("role") not in ("pro", "superadmin"):
            continue
        try:
            await emit_alert(
                pro_user_id=pro_uid,
                kind="payment_failed",
                company_id=cid,
                message=(
                    f"{company.get('name') or 'A client'} — "
                    f"${amount:,.2f} card declined. Client emailed to update."
                ),
                meta={
                    "stripe_invoice_id": invoice.get("id"),
                    "amount_usd": amount,
                    "client_email": (owner or {}).get("email"),
                },
            )
        except Exception:  # noqa: BLE001
            logger.exception("emit_alert failed for pro=%s cid=%s", pro_uid, cid)
        if pro.get("email"):
            try:
                from email_templates import payment_failed_pro
                subj, html = payment_failed_pro(
                    pro_name=pro.get("name") or pro["email"].split("@")[0],
                    client_name=(owner or {}).get("name") or (owner or {}).get("email", "your client"),
                    company_name=company.get("name") or "a company",
                    amount_usd=amount,
                    app_url=f"{base}/pro/clients",
                    brand_name=(pro.get("branding") or {}).get("firm_name"),
                )
                await dispatch(
                    kind="payment_failed_pro",
                    to=pro["email"],
                    subject=subj,
                    html=html,
                    company_id=cid,
                    initiating_user_id=None,
                    related={"stripe_invoice_id": invoice.get("id")},
                )
            except Exception:  # noqa: BLE001
                logger.exception("payment_failed pro email failed for %s", pro_uid)


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
    # Also flip any Company whose subscription this is — Phase C makes
    # `companies.billing_state` the source-of-truth the blocking modal
    # reads from.
    sub_id = sub.get("id")
    if sub_id:
        state = _sub_status_to_billing_state(status)
        await db.companies.update_one(
            {"stripe_subscription_id": sub_id},
            {"$set": {"billing_state": state, "updated_at": now_iso()}},
        )


def _sub_status_to_billing_state(sub_status: Optional[str]) -> str:
    """Map Stripe subscription.status → our internal company billing_state.

    Stripe values: incomplete | incomplete_expired | trialing | active |
    past_due | canceled | unpaid | paused.
    """
    if sub_status in ("active", "trialing"):
        return "active"
    if sub_status in ("past_due", "unpaid"):
        return "past_due"
    if sub_status in ("canceled", "incomplete_expired"):
        return "canceled"
    return "pending"


# --------------------------------------------------------------------------
# Billing views
# --------------------------------------------------------------------------

@router.get("/billing/me")
async def my_billing(
    company_id: Optional[str] = None,
    user: dict = Depends(get_current_user),
):
    """Return the signed-in user's subscription snapshot + invoice history.

    When ``company_id`` is provided the response is **scoped to that
    company** — subscription state comes from the company row and
    payments are filtered by ``company_id`` (or fall back to
    subscription_id join for legacy rows written before company_id was
    stamped on ``platform_payments``). Without ``company_id`` the
    response aggregates across everything the user has ever paid for
    (legacy behavior — used by `/billing` when no company is selected,
    e.g. by superadmin or a user who has no companies).
    """
    fresh = await db.users.find_one({"id": user["id"]}) or {}

    if company_id:
        # Ownership check: user must be a member of the company.
        m = await db.memberships.find_one({
            "user_id": user["id"], "company_id": company_id,
        })
        if not m and user.get("role") != "superadmin":
            raise HTTPException(404, "Company not found")
        c = await db.companies.find_one({"id": company_id}) or {}
        # Prefer direct company_id filter; fall back to subscription_id
        # for rows written before we stamped company_id on payments.
        sub_id = c.get("stripe_subscription_id")
        query = {"user_id": user["id"], "$or": [
            {"company_id": company_id},
            *([{"stripe_subscription_id": sub_id}] if sub_id else []),
        ]}
        payments = await (
            db.platform_payments.find(query).sort("paid_at", -1).to_list(200)
        )
        total_cents = sum(int(p.get("amount_cents") or 0) for p in payments)
        return {
            "subscription": {
                "status": c.get("billing_state"),
                "stripe_customer_id": c.get("stripe_customer_id"),
                "stripe_subscription_id": sub_id,
                "canceled_at": None,
                "billing_payer": c.get("billing_payer"),
                "billing_product": c.get("billing_product"),
            },
            "payments": [coerce(p) for p in payments],
            "total_paid_cents": total_cents,
            "company_id": company_id,
            "company_name": c.get("name"),
            "scoped": True,
        }

    # Legacy / unscoped: aggregate across the whole user (used when the
    # frontend doesn't have a company context yet — e.g. mid-boot).
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
        "scoped": False,
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


# --------------------------------------------------------------------------
# Phase C — Company-scoped subscription billing.
#
# The Add-Client "Pay with client card" flow (and the future
# "Enterprise pays with card" flow) both POST here to get a Stripe
# Checkout URL. `metadata.company_id` on the session is how the
# webhook attributes the subscription back to the right company row.
# --------------------------------------------------------------------------


class CheckoutSessionIn(BaseModel):
    """Optional overrides — when omitted we read product / discount
    from the company doc (set by the Add-Client modal)."""
    product: Optional[str] = None
    discount: Optional[bool] = None
    origin_url: Optional[str] = None


@router.post("/companies/{cid}/billing/checkout-session")
async def create_company_checkout_session(
    cid: str,
    inp: CheckoutSessionIn,
    user: dict = Depends(get_current_user),
):
    """Create a Stripe Checkout Session for a company subscription.

    Behaviour:
    * The active user must have some access to the company (owner, pro,
      editor, reviewer, viewer). Otherwise 404 (we don't leak whether
      the company exists).
    * Reads product / discount from body if provided, else falls back
      to the company doc's stored values.
    * Session ``metadata.company_id`` = ``cid`` — the webhook uses this
      to link the resulting subscription back to the company row.
    * Returns ``{checkout_url, session_id, mode: "test"|"live"}``.
    """
    # Access check — reuse the memberships table.
    if user.get("role") != "superadmin":
        m = await db.memberships.find_one({"user_id": user["id"], "company_id": cid})
        if not m:
            raise HTTPException(404, "Company not found")

    company = await db.companies.find_one({"id": cid})
    if not company:
        raise HTTPException(404, "Company not found")

    product = (inp.product or company.get("billing_product") or "simple_start").lower()
    discount = bool(inp.discount if inp.discount is not None else company.get("billing_discount") or False)

    price_id = _price_id(product, discount)
    if not price_id:
        expected_var = f"STRIPE_PRICE_{product.upper()}_{'DISCOUNT' if discount else 'REGULAR'}"
        legacy_hint = ""
        if product == "simple_start":
            legacy_hint = (
                " (or the legacy name "
                f"STRIPE_PRICE_SIMPLE_START_{'MONTHLY_19' if discount else 'MONTHLY_38'})"
            )
        raise HTTPException(
            400,
            f"No Stripe Price configured for product={product} discount={discount}. "
            f"Add {expected_var}{legacy_hint} to your Railway env vars (Settings → "
            f"Variables) with the Stripe Price ID (starts with `price_...`) from your "
            f"Stripe Dashboard, then redeploy.",
        )

    if not _STRIPE_KEY:
        raise HTTPException(
            503,
            "Stripe is not configured on this environment. Set STRIPE_SECRET_KEY "
            "(and STRIPE_WEBHOOK_SECRET) then redeploy.",
        )

    base = (inp.origin_url or _platform_base_url()).rstrip("/")
    success_url = f"{base}/billing/success?session_id={{CHECKOUT_SESSION_ID}}&company_id={cid}"
    cancel_url = f"{base}/billing/cancel?company_id={cid}"

    try:
        # Reuse an existing Stripe customer for the owner if we've seen one;
        # otherwise let Checkout create it and we'll attach on webhook.
        owner_uid = company.get("owner_user_id")
        owner = await db.users.find_one({"id": owner_uid}) if owner_uid else None
        customer_kwargs = {}
        if owner and owner.get("stripe_customer_id"):
            customer_kwargs["customer"] = owner["stripe_customer_id"]
        elif owner and owner.get("email"):
            customer_kwargs["customer_email"] = owner["email"]

        session = stripe.checkout.Session.create(
            mode="subscription",
            line_items=[{"price": price_id, "quantity": 1}],
            success_url=success_url,
            cancel_url=cancel_url,
            allow_promotion_codes=True,
            metadata={
                "company_id": cid,
                "company_name": company.get("name") or "",
                "billing_product": product,
                "billing_discount": "true" if discount else "false",
                "initiated_by_user_id": user["id"],
            },
            subscription_data={"metadata": {"company_id": cid}},
            **customer_kwargs,
        )
    except stripe.error.StripeError as e:
        logger.exception("Stripe checkout session failed for company %s", cid)
        raise HTTPException(502, f"Stripe error: {e.user_message or str(e)}")

    # Persist the session id on the company for reconciliation / debug.
    await db.companies.update_one(
        {"id": cid},
        {"$set": {
            "billing_last_session_id": session.id,
            "billing_state": company.get("billing_state") or "pending",
            "updated_at": now_iso(),
        }},
    )
    return {
        "checkout_url": session.url,
        "session_id": session.id,
        "mode": "live" if _STRIPE_KEY.startswith("sk_live_") else "test",
    }


@router.get("/admin/billing/env-check")
async def billing_env_check(user: dict = Depends(require_role("superadmin"))):
    """Diagnostic — returns which Stripe env vars the currently-running
    Python process CAN see, with values masked (length + last 4 chars).
    Use this to quickly confirm a Railway env var actually made it to
    the container. Superadmin-only because it exposes value shapes.
    """
    watched = [
        "STRIPE_SECRET_KEY",
        "STRIPE_WEBHOOK_SECRET",
        "STRIPE_PUBLISHABLE_KEY",
        "STRIPE_RETURN_BASE_URL",
        "PUBLIC_BASE_URL",
        # Phase C — 8 canonical product/tier price IDs
        "STRIPE_PRICE_SIMPLE_START_REGULAR",
        "STRIPE_PRICE_SIMPLE_START_DISCOUNT",
        "STRIPE_PRICE_ESSENTIALS_REGULAR",
        "STRIPE_PRICE_ESSENTIALS_DISCOUNT",
        "STRIPE_PRICE_PLUS_REGULAR",
        "STRIPE_PRICE_PLUS_DISCOUNT",
        "STRIPE_PRICE_ADVANCED_REGULAR",
        "STRIPE_PRICE_ADVANCED_DISCOUNT",
        # Legacy fallbacks
        "STRIPE_PRICE_SIMPLE_START_MONTHLY_38",
        "STRIPE_PRICE_SIMPLE_START_MONTHLY_19",
    ]

    def _mask(v: str) -> dict:
        if v is None:
            return {"set": False}
        if v == "":
            return {"set": True, "empty": True, "length": 0}
        return {
            "set": True,
            "empty": False,
            "length": len(v),
            "prefix": v[:5],
            "suffix": v[-4:] if len(v) > 4 else "***",
        }

    result = {k: _mask(os.environ.get(k)) for k in watched}

    # Also compute the effective resolved price id per (product, tier)
    # so the user sees exactly what `_price_id` will return for each.
    resolved = {}
    for prod in ("simple_start", "essentials", "plus", "advanced"):
        for tier in ("regular", "discount"):
            pid = _price_id(prod, tier == "discount")
            resolved[f"{prod}_{tier}"] = pid or "— unset —"
    return {"env": result, "resolved_prices": resolved}


@router.get("/admin/billing/orphan-payments")
async def list_orphan_payments(
    user: dict = Depends(require_role("superadmin")),
):
    """Diagnostic — dump every ``platform_payments`` row that lacks a
    ``company_id`` so we can see what's on it and figure out how to
    re-attribute it. Returns the sub_id, customer_id, amount, and the
    invoice/payer identifiers so a superadmin can eyeball the state."""
    q = {"$or": [{"company_id": {"$in": [None, ""]}}, {"company_id": {"$exists": False}}]}
    rows = await db.platform_payments.find(q, {"_id": 0}).to_list(500)
    # Enrich each row with the payer email + all candidate companies
    # (owned by that user) so we can see attribution options at a glance.
    out = []
    for p in rows:
        u = await db.users.find_one({"id": p.get("user_id")}, {"_id": 0, "email": 1, "id": 1, "name": 1}) if p.get("user_id") else None
        owned = []
        if u:
            ms = await db.memberships.find({"user_id": u["id"], "role": "owner"}).to_list(50)
            for m in ms:
                c = await db.companies.find_one({"id": m["company_id"]}, {"_id": 0, "id": 1, "name": 1, "billing_state": 1, "stripe_subscription_id": 1})
                if c:
                    owned.append(c)
        out.append({"payment": {k: p.get(k) for k in (
            "id", "stripe_invoice_id", "stripe_subscription_id",
            "stripe_customer_id", "user_id", "amount_cents", "paid_at",
        )}, "payer": u, "owner_of_companies": owned})
    return {"count": len(out), "rows": out}


@router.post("/admin/billing/backfill-payment-company")
async def backfill_payment_company_ids(
    user: dict = Depends(require_role("superadmin")),
):
    """One-time reconcile: stamp ``company_id`` on legacy
    ``platform_payments`` rows written before we started saving it.

    Resolution order per orphan row:
      1. Lookup by ``stripe_subscription_id`` (fast path — new payments).
      2. Lookup by ``stripe_customer_id`` on companies (one client-card
         signup → one customer). If exactly one company matches, use it.
      3. Fallback: the payment's ``user_id`` owns exactly one company
         with a `stripe_subscription_id` populated → attribute to that
         one. This handles the "webhook stored the payment before the
         company row got its subscription id, and the customer_id
         field is empty" edge case that happens on Stripe test-mode
         retries.

    Safe to run repeatedly — only touches rows without ``company_id``.
    """
    # Correct query — `$in: [null]` already matches missing fields in
    # MongoDB, no need to double-count with a separate `$exists: false`.
    orphan_q = {"company_id": {"$in": [None, ""]}}
    total = await db.platform_payments.count_documents({})
    missing_before = await db.platform_payments.count_documents(orphan_q)

    updated = 0
    unattributable_details = []
    async for p in db.platform_payments.find(orphan_q):
        chosen_cid: Optional[str] = None

        # 1. sub_id → company
        sub_id = p.get("stripe_subscription_id")
        if sub_id:
            c = await db.companies.find_one({"stripe_subscription_id": sub_id}, {"id": 1})
            if c:
                chosen_cid = c["id"]

        # 2. customer_id → company (unique)
        if not chosen_cid and p.get("stripe_customer_id"):
            cs = await db.companies.find({"stripe_customer_id": p["stripe_customer_id"]}, {"id": 1}).to_list(3)
            if len(cs) == 1:
                chosen_cid = cs[0]["id"]

        # 3. user_id + exactly one owned company with a subscription id
        if not chosen_cid and p.get("user_id"):
            ms = await db.memberships.find({"user_id": p["user_id"], "role": "owner"}).to_list(50)
            candidates = []
            for m in ms:
                c = await db.companies.find_one(
                    {"id": m["company_id"], "stripe_subscription_id": {"$exists": True, "$ne": None}},
                    {"id": 1},
                )
                if c:
                    candidates.append(c["id"])
            if len(candidates) == 1:
                chosen_cid = candidates[0]

        if chosen_cid:
            await db.platform_payments.update_one({"id": p["id"]}, {"$set": {"company_id": chosen_cid}})
            updated += 1
        else:
            unattributable_details.append({
                "payment_id": p.get("id"),
                "stripe_invoice_id": p.get("stripe_invoice_id"),
                "stripe_subscription_id": p.get("stripe_subscription_id"),
                "stripe_customer_id": p.get("stripe_customer_id"),
                "user_id": p.get("user_id"),
            })

    return {
        "total_platform_payments": total,
        "missing_before": missing_before,
        "updated": updated,
        "unattributable": len(unattributable_details),
        "unattributable_details": unattributable_details,
    }



@router.get("/admin/billing/webhook-status")
async def billing_webhook_status(user: dict = Depends(require_role("superadmin"))):
    """Diagnostic — reports whether Stripe webhooks are landing on this
    deployment. Shows the last 20 events received, aggregate counts, and
    the current state of `platform_payments` and subscribed companies.

    If ``total_events == 0`` and you've just completed a paid checkout,
    the webhook URL / signing secret is wrong on the Stripe Dashboard side.
    """
    from db import db  # local import to avoid cycles
    events = await db.stripe_webhook_events.find({}).sort("received_at", -1).to_list(20)
    total_events = await db.stripe_webhook_events.count_documents({})
    total_payments = await db.platform_payments.count_documents({})
    latest_payment = await db.platform_payments.find({}).sort("paid_at", -1).limit(1).to_list(1)
    subscribed_companies = await db.companies.count_documents({
        "stripe_subscription_id": {"$exists": True, "$ne": None}
    })
    active_billing = await db.companies.count_documents({"billing_state": "active"})
    return {
        "webhook_secret_set": bool(_WEBHOOK_SECRET),
        "webhook_url_expected": f"{_platform_base_url().rstrip('/')}".replace(
            "app.", "api."
        ) + "/api/stripe/webhook",
        "total_events_received": total_events,
        "total_payments_recorded": total_payments,
        "latest_payment_at": (latest_payment[0].get("paid_at") if latest_payment else None),
        "companies_with_subscription": subscribed_companies,
        "companies_billing_active": active_billing,
        "recent_events": [
            {"id": e.get("id"), "type": e.get("type"), "at": e.get("received_at")}
            for e in events
        ],
    }


@router.get("/companies/{cid}/billing/state")
async def get_company_billing_state(
    cid: str,
    user: dict = Depends(get_current_user),
):
    """Return the current company's billing state + product/payer so the
    frontend can decide whether to render the blocking modal.

    Access: any member of the company. Superadmin sees everything.
    """
    if user.get("role") != "superadmin":
        m = await db.memberships.find_one({"user_id": user["id"], "company_id": cid})
        if not m:
            raise HTTPException(404, "Company not found")
    else:
        m = None
    c = await db.companies.find_one({"id": cid})
    if not c:
        raise HTTPException(404, "Company not found")
    state = c.get("billing_state") or "pending"
    payer = c.get("billing_payer")
    # Lock rule:
    #   * past_due / canceled / unpaid → always lock (service interruption
    #     affects everyone equally, including the Pro).
    #   * pending + client_email → lock the CLIENT side only. The Pro
    #     needs to keep working the file (and resending the activation
    #     link if the client lost it) so we let Pros and superadmin
    #     through. `client_card` / `enterprise` / `free_spot` never
    #     need lockout during a pending window.
    is_service_lock = state in ("past_due", "canceled", "unpaid")
    is_pending_activation = state == "pending" and payer == "client_email"
    role_on_company = (m or {}).get("role") if m else None
    is_pro_side = (
        user.get("role") == "superadmin"
        or role_on_company in ("pro", "reviewer")
    )
    locked = is_service_lock or (is_pending_activation and not is_pro_side)
    return {
        "billing_state": state,
        "billing_payer": payer,
        "billing_product": c.get("billing_product"),
        "billing_discount": bool(c.get("billing_discount")),
        "locked": locked,
        "stripe_subscription_id": c.get("stripe_subscription_id"),
        "stripe_customer_id": c.get("stripe_customer_id"),
        "last_session_id": c.get("billing_last_session_id"),
        "stripe_configured": bool(_STRIPE_KEY),
    }

