"""SmartBooks — Enterprise consolidated billing scheduler (Phase D).

Every month on the 5th (at ~01:00 America/New_York), every enterprise
that has at least one `billing_payer="enterprise"` company gets ONE
Stripe invoice covering all of its enterprise-paid companies for the
prior calendar month.

Design decisions
================
* **One Stripe Customer per Enterprise** — auto-created on first billing
  run using the enterprise's `owner_user_id` (or the first Pro attached
  to it if the enterprise has no explicit owner). The `cus_...` id is
  persisted onto the enterprise row so subsequent months reuse it.
* **One InvoiceItem per company** — each enterprise-paid company adds a
  line for its (product, discount) price ID. If any company's price
  isn't configured, the row is skipped with a warning (never blocks
  the rest of the enterprise's invoice).
* **Idempotency** — a `(enterprise_id, month_key)` unique index on the
  `enterprise_invoices` collection guarantees we never double-bill even
  if the scheduler retries.
* **Dry-run** — when `STRIPE_SECRET_KEY` is unset (preview environments)
  the run returns the "would-invoice" summary without hitting Stripe,
  so we can smoke-test the aggregation logic without live keys.
* **Graceful failure** — Stripe errors on ONE enterprise never block the
  next one. Each failure is recorded on the `enterprise_invoices` row
  with the error string for post-mortem.

The scheduler co-exists with the existing per-user Stripe subscription
flow — this module ONLY creates invoices for enterprises; the
per-company `billing_payer="client_card"`/`"client_email"` flows still
go through their own Checkout Sessions.
"""
from __future__ import annotations

import asyncio
import logging
import os
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional
from zoneinfo import ZoneInfo

import stripe

from db import db, now_iso

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
BILLING_TZ = ZoneInfo(os.environ.get("BILLING_TZ", "America/New_York"))
BILL_DAY_OF_MONTH = int(os.environ.get("ENTERPRISE_BILL_DAY", "5"))
# Cadence — the loop wakes up every 6 hours and checks whether today is
# the billing day AND the current enterprise still needs an invoice for
# the prior month. Idempotent, so multiple ticks in the same day just
# short-circuit on the unique index.
LOOP_INTERVAL_S = int(os.environ.get("ENTERPRISE_BILL_LOOP_S", "21600"))  # 6h

_STRIPE_KEY = os.environ.get("STRIPE_SECRET_KEY", "")
if _STRIPE_KEY:
    stripe.api_key = _STRIPE_KEY


def _prior_month_key(now_local: datetime) -> str:
    """Return the 'YYYY-MM' key for the month PRECEDING the given date.
    We bill on the 5th for the prior month's usage."""
    first = now_local.replace(day=1)
    prior_last = first - timedelta(days=1)
    return prior_last.strftime("%Y-%m")


def _bill_price_id(product: str, discount: bool) -> Optional[str]:
    """Same env-var convention as routes/stripe_billing.py::_price_id.
    Duplicated here so we don't import a FastAPI router at cold-start."""
    tier = "DISCOUNT" if discount else "REGULAR"
    key = f"STRIPE_PRICE_{product.upper()}_{tier}"
    pid = os.environ.get(key)
    if pid:
        return pid
    # Backwards-compat with the existing prod env keys for Simple Start.
    if product == "simple_start" and not discount:
        return os.environ.get("STRIPE_PRICE_SIMPLE_START_MONTHLY_38")
    if product == "simple_start" and discount:
        return os.environ.get("STRIPE_PRICE_SIMPLE_START_MONTHLY_19")
    return None


# ---------------------------------------------------------------------------
# Stripe Customer for the Enterprise
# ---------------------------------------------------------------------------

async def _resolve_enterprise_customer_id(ent: dict) -> Optional[str]:
    """Return a Stripe customer id for the enterprise. Auto-creates one
    the first time. `None` is only returned when Stripe isn't configured
    (dry-run mode) or the enterprise has no owner + no Pros — in either
    case the caller should skip billing this enterprise."""
    cust_id = ent.get("stripe_customer_id")
    if cust_id:
        return cust_id
    if not _STRIPE_KEY:
        return None  # dry-run — no real customer

    # Pick a billing-contact email: enterprise.owner_user_id preferred,
    # else the first Pro attached to the enterprise.
    contact = None
    if ent.get("owner_user_id"):
        contact = await db.users.find_one({"id": ent["owner_user_id"]})
    if not contact:
        contact = await db.users.find_one({"enterprise_id": ent["id"], "role": "pro"})
    if not contact or not contact.get("email"):
        logger.warning("Enterprise %s has no billing contact", ent.get("id"))
        return None

    try:
        customer = stripe.Customer.create(
            email=contact["email"],
            name=ent.get("name") or contact.get("name") or contact["email"],
            metadata={"enterprise_id": ent["id"], "enterprise_slug": ent.get("slug") or ""},
        )
    except stripe.error.StripeError as e:
        logger.exception("Failed to create Stripe customer for enterprise %s: %s", ent["id"], e)
        return None

    await db.enterprises.update_one(
        {"id": ent["id"]},
        {"$set": {"stripe_customer_id": customer.id, "updated_at": now_iso()}},
    )
    return customer.id


# ---------------------------------------------------------------------------
# Core cycle
# ---------------------------------------------------------------------------

async def _collect_enterprise_lines(enterprise_id: str) -> list[dict]:
    """Return one line-item dict per company that should appear on this
    enterprise's monthly invoice. Only counts companies with
    `billing_payer="enterprise"`. Skips lines whose price isn't
    configured, but records the skip on the returned row so the audit
    trail shows what didn't bill and why."""
    companies = await db.companies.find(
        {"enterprise_id": enterprise_id, "billing_payer": "enterprise"},
        {"_id": 0, "id": 1, "name": 1, "billing_product": 1, "billing_discount": 1},
    ).to_list(2000)
    lines: list[dict] = []
    for c in companies:
        prod = c.get("billing_product") or "simple_start"
        disc = bool(c.get("billing_discount"))
        pid = _bill_price_id(prod, disc)
        lines.append({
            "company_id": c["id"],
            "company_name": c.get("name") or "",
            "product": prod,
            "discount": disc,
            "price_id": pid,
            "skipped": pid is None,
            "skip_reason": (
                None if pid is not None
                else f"Set STRIPE_PRICE_{prod.upper()}_{'DISCOUNT' if disc else 'REGULAR'} in env"
            ),
        })
    return lines


async def bill_enterprise(
    enterprise_id: str,
    *,
    month_key: str,
    dry_run: bool = False,
) -> dict:
    """Create (or dry-run) ONE Stripe invoice for the given enterprise
    covering all its enterprise-paid companies. Idempotent: safe to
    call multiple times for the same `(enterprise_id, month_key)`."""

    # Idempotency short-circuit — the DB unique index also protects, this
    # is just a friendlier no-op response for the API caller.
    existing = await db.enterprise_invoices.find_one({
        "enterprise_id": enterprise_id, "month_key": month_key,
    })
    if existing and existing.get("status") not in (None, "failed"):
        return {"status": "already_billed", "enterprise_invoice_id": existing.get("id"),
                "stripe_invoice_id": existing.get("stripe_invoice_id")}

    ent = await db.enterprises.find_one({"id": enterprise_id})
    if not ent:
        return {"status": "not_found", "enterprise_id": enterprise_id}

    lines = await _collect_enterprise_lines(enterprise_id)
    payable = [ln for ln in lines if not ln["skipped"]]

    # DRY RUN — return the plan without hitting Stripe.
    if dry_run or not _STRIPE_KEY:
        return {
            "status": "dry_run",
            "enterprise_id": enterprise_id,
            "enterprise_name": ent.get("name"),
            "month_key": month_key,
            "lines": lines,
            "payable_count": len(payable),
            "skipped_count": len(lines) - len(payable),
            "stripe_configured": bool(_STRIPE_KEY),
        }

    if not payable:
        # Nothing to bill — record a zero-line stub so we don't retry.
        stub_id = str(uuid.uuid4())
        await db.enterprise_invoices.insert_one({
            "id": stub_id,
            "enterprise_id": enterprise_id,
            "month_key": month_key,
            "status": "empty",
            "lines": lines,
            "line_count": 0,
            "created_at": now_iso(),
        })
        return {"status": "empty", "enterprise_invoice_id": stub_id, "lines": lines}

    customer_id = await _resolve_enterprise_customer_id(ent)
    if not customer_id:
        return {"status": "no_billing_contact", "enterprise_id": enterprise_id}

    # ---- Create Stripe invoice draft, then per-line InvoiceItems ----
    ent_invoice_id = str(uuid.uuid4())
    try:
        invoice = stripe.Invoice.create(
            customer=customer_id,
            collection_method="charge_automatically",
            auto_advance=True,
            description=f"{ent.get('name')} — {month_key} consolidated billing",
            metadata={
                "enterprise_id": enterprise_id,
                "enterprise_invoice_id": ent_invoice_id,
                "month_key": month_key,
            },
        )
        for ln in payable:
            stripe.InvoiceItem.create(
                customer=customer_id,
                invoice=invoice.id,
                price=ln["price_id"],
                quantity=1,
                description=f"{ln['company_name']} · {ln['product']}"
                            + (" · discounted" if ln["discount"] else ""),
                metadata={
                    "enterprise_id": enterprise_id,
                    "company_id": ln["company_id"],
                    "month_key": month_key,
                },
            )
        finalized = stripe.Invoice.finalize_invoice(invoice.id)
    except stripe.error.StripeError as e:
        logger.exception("Stripe invoice failed for enterprise %s / %s", enterprise_id, month_key)
        # Persist failure so the operator can retry via the "Bill now" button.
        try:
            await db.enterprise_invoices.insert_one({
                "id": ent_invoice_id,
                "enterprise_id": enterprise_id,
                "month_key": month_key,
                "status": "failed",
                "error": (getattr(e, "user_message", None) or str(e))[:500],
                "lines": lines,
                "created_at": now_iso(),
            })
        except Exception:
            pass  # unique-index dupe is fine
        return {"status": "failed", "error": str(e)}

    doc = {
        "id": ent_invoice_id,
        "enterprise_id": enterprise_id,
        "month_key": month_key,
        "status": "finalized",  # will be flipped to "paid" by webhook
        "stripe_invoice_id": finalized.id,
        "stripe_customer_id": customer_id,
        "amount_due_cents": int(getattr(finalized, "amount_due", 0) or 0),
        "currency": (getattr(finalized, "currency", "usd") or "usd").lower(),
        "hosted_invoice_url": getattr(finalized, "hosted_invoice_url", None),
        "invoice_pdf": getattr(finalized, "invoice_pdf", None),
        "lines": lines,
        "line_count": len(payable),
        "created_at": now_iso(),
    }
    try:
        await db.enterprise_invoices.insert_one(doc)
    except Exception:
        # Extremely rare — the unique index caught a concurrent run. Log
        # and move on; the other run's row is authoritative.
        logger.warning("Duplicate enterprise_invoices insert for %s / %s", enterprise_id, month_key)

    return {
        "status": "finalized",
        "enterprise_invoice_id": ent_invoice_id,
        "stripe_invoice_id": finalized.id,
        "amount_due_cents": doc["amount_due_cents"],
        "hosted_invoice_url": doc["hosted_invoice_url"],
        "lines": lines,
    }


async def run_monthly_cycle(*, month_key: Optional[str] = None, dry_run: bool = False) -> dict:
    """Iterate every enterprise and bill it. Called by the scheduler on
    the 5th, and by the `POST /admin/enterprises/{eid}/bill-now` endpoint
    (which passes a single-enterprise scope via `bill_enterprise` directly).
    """
    if not month_key:
        month_key = _prior_month_key(datetime.now(BILLING_TZ))

    enterprises = await db.enterprises.find({}, {"_id": 0}).to_list(500)
    results = []
    for ent in enterprises:
        # Skip enterprises with no enterprise-paid companies — cheap query.
        n = await db.companies.count_documents({
            "enterprise_id": ent["id"], "billing_payer": "enterprise",
        })
        if not n:
            continue
        res = await bill_enterprise(ent["id"], month_key=month_key, dry_run=dry_run)
        res["enterprise_id"] = ent["id"]
        res["enterprise_name"] = ent.get("name")
        results.append(res)
    return {"month_key": month_key, "results": results}


# ---------------------------------------------------------------------------
# Scheduler
# ---------------------------------------------------------------------------

_task: Optional[asyncio.Task] = None


async def _loop() -> None:
    """Sleep in ~6h chunks and, when today is the 5th of the month in
    the billing TZ AND we haven't already billed for the prior month,
    run the cycle. Multiple ticks in the same day are idempotent thanks
    to the unique index on `enterprise_invoices`."""
    while True:
        try:
            now_local = datetime.now(BILLING_TZ)
            if now_local.day == BILL_DAY_OF_MONTH:
                mk = _prior_month_key(now_local)
                logger.info("Enterprise billing tick — running cycle for %s", mk)
                await run_monthly_cycle(month_key=mk, dry_run=False)
        except Exception:  # noqa: BLE001 — a bug in one enterprise must not kill the loop
            logger.exception("Enterprise billing loop iteration failed")
        await asyncio.sleep(LOOP_INTERVAL_S)


def start_scheduler() -> None:
    global _task
    if _task and not _task.done():
        return
    _task = asyncio.create_task(_loop())
    logger.info(
        "Enterprise billing scheduler started (interval=%ss, TZ=%s, day=%s)",
        LOOP_INTERVAL_S, BILLING_TZ.key, BILL_DAY_OF_MONTH,
    )


async def ensure_indexes() -> None:
    # Prevents double-billing under any race condition.
    await db.enterprise_invoices.create_index(
        [("enterprise_id", 1), ("month_key", 1)],
        unique=True,
        name="enterprise_invoices_month_uniq",
    )
    await db.enterprise_invoices.create_index("stripe_invoice_id", sparse=True)
