"""Milestones A–G — end-to-end demo seeder.

Creates one realistic example per batch item type (1..9) under
`Sales Tax Tester LLC`, forces `client_email = michael@bigsaas.ai`,
mints a `client_review_batches` doc, and dispatches the email so the
user can walk through the entire flow (batch email → magic link →
per-item chat → follow-ups → deferrals → completion).

Idempotent-ish: closes any existing open batches for this company
before seeding, cleans up its own prior demo rows on each run, and
resets the pro's `client_review_batch` email preference to ON so the
dispatcher can't quietly skip.

Usage
-----
    cd /app/backend && python scripts/seed_e2e_batch_demo.py

The script prints the review URL + email dispatch result at the end.
"""
from __future__ import annotations
import asyncio
import uuid
from datetime import datetime, timezone, timedelta

from deps import db
import client_review as cr


COMPANY_NAME  = "Sales Tax Tester LLC"
CLIENT_EMAIL  = "michael@bigsaas.ai"
PRO_EMAIL     = "pro@axiom.ai"
DEMO_TAG      = "seed_e2e_batch_demo_v1"


def _iso_days_ago(days: int) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()


def _iso_days_ago_naive(days: int) -> str:
    """ISO without timezone — matches how earlier ingest rows were
    written in this DB. The `cr` module compares as strings, so we
    stay consistent with existing rows."""
    d = datetime.now(timezone.utc) - timedelta(days=days)
    return d.replace(tzinfo=None).isoformat()


async def _cleanup_prior_demo(cid: str) -> None:
    """Remove anything this seeder created on a prior run so we can
    rerun freely.
    """
    await db.transactions.delete_many({"company_id": cid, "demo_tag": DEMO_TAG})
    await db.agent_findings.delete_many({"company_id": cid, "demo_tag": DEMO_TAG})
    await db.contacts.delete_many({"company_id": cid, "demo_tag": DEMO_TAG})
    # Any open/scheduled batches from an earlier run — mark expired so
    # cadence gate lets us open a fresh one.
    await db.client_review_batches.update_many(
        {"company_id": cid, "status": {"$in": ["open", "scheduled"]}},
        {"$set": {"status": "expired",
                  "expired_at": datetime.now(timezone.utc).isoformat(),
                  "expire_reason": "reseed"}},
    )
    # Release batch_id stamps on findings/txns so `should_fire_batch`
    # doesn't run into the cadence gate and the aggregator doesn't
    # skip rows that still carry a batch_id from an earlier run.
    await db.agent_findings.update_many(
        {"company_id": cid}, {"$unset": {"batch_id": ""}},
    )
    await db.transactions.update_many(
        {"company_id": cid}, {"$unset": {"batch_id": ""}},
    )
    # Reset the last-email-sent cadence so the 5-day-between-batches
    # gate doesn't fire when we reseed within the same week.
    await db.client_review_batches.update_many(
        {"company_id": cid},
        {"$set": {"email_sent_at": None}},
    )


async def _ensure_pro_pref_on(pro_id: str) -> None:
    """Make sure `client_review_batch` is ON for the pro. Legacy
    accounts sometimes come pre-baked with False."""
    await db.comms_prefs.update_one(
        {"user_id": pro_id},
        {"$set": {"client_review_batch": True,
                  "updated_at": datetime.now(timezone.utc).isoformat()}},
        upsert=True,
    )


async def _seed_uncategorized_txn(cid: str, *, initial_download_end_iso: str) -> dict:
    """Item 1 — transactions.needs_review=True, aged past the 7d gate,
    but `created_at` must sit AFTER the company's initial-download
    window ends (`company.created_at + 24h`) or the aggregator will
    treat it as an initial-backfill row and skip it.

    Pick `created_at` = max(initial_download_end + 2h, 8d ago) so the
    row always sits in the eligible window regardless of when the
    company was created.
    """
    tid = f"demo1-{uuid.uuid4()}"
    ide = datetime.fromisoformat(initial_download_end_iso.replace("Z", "+00:00"))
    if ide.tzinfo is None:
        ide = ide.replace(tzinfo=timezone.utc)
    eight_days_ago = datetime.now(timezone.utc) - timedelta(days=8)
    two_hours_after_ide = ide + timedelta(hours=2)
    created_dt = max(eight_days_ago, two_hours_after_ide)
    created_iso = created_dt.isoformat()
    # Pin the txn's source Account to 1010 · Business Checking on this
    # company (falls back to any asset if that exact code isn't seeded).
    bank = await db.accounts.find_one(
        {"company_id": cid, "code": "1010"}, {"id": 1, "name": 1},
    ) or await db.accounts.find_one(
        {"company_id": cid, "type": "asset"}, {"id": 1, "name": 1},
    )
    bank_id   = (bank or {}).get("id")
    bank_name = (bank or {}).get("name") or "Business Checking"
    # Anchor the human-readable date to the created_at so the client
    # sees "8 days ago" not a fixed literal.
    doc = {
        "id":                 tid,
        "company_id":         cid,
        "date":               created_dt.date().isoformat(),
        "amount":             -483.29,
        "description":        "HOME DEPOT #6234 RENO NV",
        "merchant":           "The Home Depot",
        "bank_account_id":    bank_id,
        "bank_account_name":  bank_name,
        "posted":             True,
        "needs_review":       True,
        "human_reviewed":     False,
        "ai_source":          "llm",
        "ai_comment":         "AI couldn't confidently pick between "
                              "Repairs & Maintenance vs Office Supplies.",
        "client_question_id": None,
        "batch_id":           None,
        "created_at":         created_iso,
        "updated_at":         created_iso,
        "demo_tag":           DEMO_TAG,
    }
    await db.transactions.insert_one(doc)
    return doc


async def _seed_finding(
    cid: str, *, kind: str, title: str, detail: str,
    meta: dict | None = None, severity: str = "amber",
    action_label: str | None = None, action_route: str | None = None,
    contact_id: str | None = None,
) -> dict:
    fid = f"demo-{kind}-{uuid.uuid4()}"
    doc = {
        "id":           fid,
        "company_id":   cid,
        "kind":         kind,
        "status":       "open",
        "severity":     severity,
        "title":        title,
        "detail":       detail,
        "action_label": action_label or "Review",
        "action_route": action_route or "/cockpit/agents",
        "meta":         meta or {},
        "contact_id":   contact_id,
        "batch_id":     None,
        "created_at":   _iso_days_ago(3),
        "updated_at":   _iso_days_ago(3),
        "demo_tag":     DEMO_TAG,
    }
    await db.agent_findings.insert_one(doc)
    return doc


async def _seed_contact(cid: str, name: str, *, email: str | None = None,
                        is_pseudo: bool = False, w9_on_file: bool = False) -> dict:
    from contact_resolver import normalize_contact_name
    # Idempotent — if a contact with this normalized name already
    # exists on the company (e.g. auto-created earlier by the
    # resolver), reuse it instead of insertng a duplicate.
    key = normalize_contact_name(name)
    existing = await db.contacts.find_one(
        {"company_id": cid, "normalized_name": key},
    )
    if existing:
        return existing
    ctid = f"demo-contact-{uuid.uuid4()}"
    doc = {
        "id":              ctid,
        "company_id":      cid,
        "name":            name,
        "normalized_name": key,
        "email":           email,
        "is_pseudo_contact": is_pseudo,
        "w9_on_file":      w9_on_file,
        "created_at":      _iso_days_ago(45),
        "updated_at":      _iso_days_ago(45),
        "demo_tag":        DEMO_TAG,
    }
    await db.contacts.insert_one(doc)
    return doc


async def _print_summary(*, batch: dict, review_url: str,
                          dispatch_result: dict) -> None:
    print("\n" + "=" * 68)
    print("E2E DEMO BATCH — Sales Tax Tester LLC")
    print("=" * 68)
    print(f"  batch_id:      {batch['id']}")
    print(f"  client_email:  {batch['client_email']}")
    print(f"  items:         {len(batch.get('items') or [])}")
    print(f"  review URL:    {review_url}")
    print(f"  email status:  {dispatch_result.get('status')}"
          f"  resend_id={dispatch_result.get('resend_id')}")
    print("-" * 68)
    for it in batch.get("items") or []:
        print(f"  #{it['item_type']}  {it.get('prompt','')[:100]}")
    print("-" * 68)
    # Public demo fixtures — the tester can download these from the
    # preview URL to feed the vision flows (Q6 receipt + Q7 liability).
    base = review_url.split("/client-review/")[0]
    print("  Demo attachments (download & upload during the review):")
    print(f"    Q1 Home Depot: {base}/home-depot-receipt-demo.png")
    print(f"    Q6 receipt:    {base}/costco-receipt-demo.png")
    print(f"    Q7 mortgage:   {base}/mortgage-statement-demo.png")
    print(f"    Q7 credit crd: {base}/credit-card-statement-demo.png")
    print(f"    Q7 auto loan:  {base}/auto-loan-statement-demo.png")
    print("=" * 68 + "\n")


async def main() -> int:
    company = await db.companies.find_one({"name": COMPANY_NAME})
    if not company:
        print(f"FATAL: {COMPANY_NAME!r} not found in DB.")
        return 2
    cid = company["id"]

    pro = await db.users.find_one({"email": PRO_EMAIL})
    if not pro:
        print(f"FATAL: {PRO_EMAIL!r} user not found.")
        return 2

    # Ensure the batch dispatcher can pick this up:
    #   * client_email lands the batch on michael@bigsaas.ai
    #   * primary_pro_id lands firm branding on the email
    #   * pause_review_batches must be false
    await db.companies.update_one(
        {"id": cid},
        {"$set": {"client_email":          CLIENT_EMAIL,
                  "primary_pro_id":        pro["id"],
                  "pause_review_batches":  False,
                  "updated_at":            datetime.now(timezone.utc).isoformat()}},
    )
    await _ensure_pro_pref_on(pro["id"])
    await _cleanup_prior_demo(cid)

    # -------------------------------------------------------------------
    # Item 1 — uncategorized transaction
    # -------------------------------------------------------------------
    # Recompute the initial-download-end window from the company doc so
    # the txn's created_at lands past it.
    from client_review import _hours_after, INITIAL_DOWNLOAD_HOURS
    initial_download_end = _hours_after(company["created_at"], INITIAL_DOWNLOAD_HOURS)
    txn = await _seed_uncategorized_txn(cid, initial_download_end_iso=initial_download_end)

    # -------------------------------------------------------------------
    # Item 2 — missing receipt (was Item 3 pre-Sep-14 2026; Q2 removed
    # because Plaid PayPal/Venmo institution connections handle the
    # descriptor-cleanup problem natively. The descriptor-alias handler
    # + resolver fast-path are left in place, dormant, ready for the
    # future "Merge Contacts" review that will reuse the same slot.)
    # -------------------------------------------------------------------
    await _seed_finding(
        cid, kind="missing_receipt",
        title="Missing receipt: $2,847.00 Best Buy — 8 days ago",
        detail="Charges over $2,500 need a receipt for the audit "
               "trail. Best Buy on Aug 20, 2026. Upload a photo or "
               "PDF of the receipt.",
        severity="amber",
        meta={"txn_amount": -2847.00,
              "txn_desc":   "BEST BUY #1024 RENO NV",
              "txn_date":   _iso_days_ago(8)[:10]},
        action_label="Upload receipt",
    )

    # -------------------------------------------------------------------
    # Item 3 — W-9 needed (1099 watcher)
    # -------------------------------------------------------------------
    landscaper = await _seed_contact(cid, "Copper Creek Landscaping LLC",
                                      email="billing@coppercreeklandscaping.example.test",
                                      w9_on_file=False)
    await _seed_finding(
        cid, kind="w9_needed",
        title=f"W-9 needed for {landscaper['name']}",
        detail="You've paid this contractor $2,100 YTD. To issue a "
               "1099-NEC at year end we need a completed W-9. Options: "
               "upload the W-9 they already sent you, type their info "
               "in, or ask us to email them for it.",
        contact_id=landscaper["id"],
        meta={"contact_id": landscaper["id"], "ytd_paid": 2100.00,
              "contact_name": landscaper["name"]},
        action_label="Collect W-9",
    )

    # -------------------------------------------------------------------
    # Item 4 — ambiguous transfer
    # (Pseudo-contact + no category + amount > threshold. Aggregator
    # picks these up via `ambiguous_transfer` findings.)
    # -------------------------------------------------------------------
    pseudo = await _seed_contact(cid, "Internal Transfer #4291→9876",
                                  is_pseudo=True)
    await _seed_finding(
        cid, kind="ambiguous_transfer",
        title="Is this $5,000 movement a transfer or a payment?",
        detail="A $5,000 debit on Checking-4291 and a matching $5,000 "
               "credit on Savings-9876 look like an internal transfer, "
               "but they landed 2 days apart. Confirm it's an internal "
               "transfer (no P&L impact) or tell us who got paid.",
        contact_id=pseudo["id"],
        meta={"amount": 5000.00,
              "txn_desc":  "TRANSFER TO SAVINGS ····9876",
              "txn_date":  _iso_days_ago(6)[:10],
              "debit_acct": "Business Checking ····4291",
              "credit_acct": "Business Savings ····9876",
              "days_apart": 2},
        action_label="Confirm transfer",
    )

    # -------------------------------------------------------------------
    # Item 5 — new recurring charge classification
    # -------------------------------------------------------------------
    await _seed_finding(
        cid, kind="new_recurring_charge",
        title="New recurring charge: Adobe Creative Cloud · $47.99/mo",
        detail="First appeared 22 days ago on Business Checking. Is "
               "this a business subscription (Software Subscriptions) "
               "or personal — we'll write a rule so future charges "
               "auto-post either way.",
        meta={"amount":   -47.99,
              "vendor":   "Adobe Creative Cloud",
              "txn_desc": "ADOBE *CREATIVE CLD 800-833-6687",
              "txn_date": _iso_days_ago(2)[:10],
              "cadence":  "monthly",
              "first_seen_days_ago": 22},
        action_label="Business or personal",
    )

    # -------------------------------------------------------------------
    # Item 6 — split transaction suggestion (was Item 7 pre-Sep-14 2026;
    # the "Setup detail" item was cut from the demo batch because its
    # handler doesn't yet apply the answer to company config — until
    # the structured settings-write path lands it was only a "flag for
    # the CPA" placeholder. The `setup_missing` finding kind stays
    # in the classifier so real batches can still surface it when the
    # rule fires; this demo just doesn't seed one.)
    # -------------------------------------------------------------------
    await _seed_finding(
        cid, kind="split_suggested",
        title="Split this $1,200 Costco run?",
        detail="AI thinks this Costco charge looks like a mix — "
               "business supplies (~$720) and household groceries "
               "(~$480). Confirm the split percentages or tell us "
               "it's 100% business.",
        meta={"txn_amount": -1200.00,
              "txn_desc":   "COSTCO WHSE #1148 RENO NV",
              "txn_date":   _iso_days_ago(5)[:10],
              "suggested_splits": [
                  {"account_name": "Office Supplies",       "amount": 720.00, "percent": 60},
                  {"account_name": "Owner Personal Draws",  "amount": 480.00, "percent": 40},
              ]},
        action_label="Choose split",
    )

    # -------------------------------------------------------------------
    # Item 7 — liability payment split (mortgage / credit card / auto loan)
    # -------------------------------------------------------------------
    await _seed_finding(
        cid, kind="liability_split_needed",
        title="$2,145 loan payment — how should we split it?",
        detail="This $2,145.67 payment looks like a mortgage / credit card "
               "/ auto-loan bill. Upload the statement (photo or PDF) and "
               "I'll pull out the principal, interest, escrow, and fees so "
               "we can post it to the right accounts.",
        severity="amber",
        meta={"txn_amount": -2145.67,
              "txn_desc":   "WELLS FARGO HOME MTG PMT 4291",
              "txn_date":   _iso_days_ago(1)[:10],
              "expected_buckets": ["Principal", "Interest", "Escrow", "Fees"]},
        action_label="Split liability",
    )

    # -------------------------------------------------------------------
    # Build + dispatch the batch
    # -------------------------------------------------------------------
    items = await cr.collect_batch_items(cid)
    if len(items) < 1:
        print("FATAL: collect_batch_items returned zero — data guards didn't "
              "match. Company timestamps or dedup gates may be stricter than "
              "expected.")
        return 2

    batch = await cr.create_batch(cid, CLIENT_EMAIL, items)
    dispatch_result = await cr.dispatch_batch_email(batch)

    # Public URL for the review page (frontend route).
    import os
    base = (os.environ.get("PUBLIC_APP_URL")
            or os.environ.get("REACT_APP_BACKEND_URL")
            or "").rstrip("/")
    if not base:
        # Preview-env fallback: read frontend .env.
        try:
            with open("/app/frontend/.env") as fh:
                for line in fh:
                    if line.startswith("REACT_APP_BACKEND_URL="):
                        base = line.split("=", 1)[1].strip().rstrip("/")
                        break
        except Exception:
            pass
    review_url = f"{base}/client-review/{batch['client_token']}"

    fresh = await db.client_review_batches.find_one({"id": batch["id"]})
    await _print_summary(batch=fresh, review_url=review_url,
                          dispatch_result=dispatch_result)
    return 0


if __name__ == "__main__":
    import sys
    sys.exit(asyncio.run(main()))
