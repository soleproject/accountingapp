"""Seed one Quick Check-in item of EACH of the 15 types under 9-24 LLC.

Owner ask: "Do a fake one of each of these in company 9-24 LLC — I want to
go through each of these and make sure I like the format."

This is a review/QA seeder, not the nightly demo. It:
  1. Wipes any prior demo rows tagged `seed_9_24_llc_all_types_v1`.
  2. Expires any still-open batches on the company so a fresh one can mint.
  3. Seeds the underlying rows required by each collector:
       - `transactions.needs_review=True` for item 1
       - `agent_findings` rows for items 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14
       - Check-shaped `transactions` (no contact) for item 13
       - `contact_cleanup_applied` for item 15
  4. Runs `collect_batch_items(cid)` to compile the item list.
  5. Calls `create_batch(cid, client_email, items)` and prints the review URL.

Usage
-----
    cd /app/backend && python scripts/seed_9_24_llc_all_types.py
"""
from __future__ import annotations
import asyncio
import uuid
from datetime import datetime, timezone, timedelta

from deps import db
import client_review as cr


COMPANY_NAME = "9-24 LLC"
CLIENT_EMAIL = "priya-checkin-demo@example.test"
PRO_EMAIL    = "pro@axiom.ai"
DEMO_TAG     = "seed_9_24_llc_all_types_v1"


def _iso_days_ago(days: int) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()


def _date_days_ago(days: int) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=days)).date().isoformat()


async def _cleanup(cid: str) -> None:
    """Purge our prior seed rows and expire any live batches on the
    company so `create_batch` can mint fresh."""
    await db.transactions.delete_many({"company_id": cid, "demo_tag": DEMO_TAG})
    await db.agent_findings.delete_many({"company_id": cid, "demo_tag": DEMO_TAG})
    await db.contacts.delete_many({"company_id": cid, "demo_tag": DEMO_TAG})
    await db.contact_cleanup_applied.delete_many(
        {"company_id": cid, "demo_tag": DEMO_TAG},
    )
    await db.client_review_batches.update_many(
        {"company_id": cid, "status": {"$in": ["open", "scheduled"]}},
        {"$set": {"status": "expired",
                  "expired_at": datetime.now(timezone.utc).isoformat(),
                  "expire_reason": "reseed all-types"}},
    )
    # Release batch_id stamps so aggregators don't skip.
    await db.agent_findings.update_many(
        {"company_id": cid}, {"$unset": {"batch_id": ""}},
    )
    await db.transactions.update_many(
        {"company_id": cid}, {"$unset": {"batch_id": ""}},
    )


async def _seed_contact(cid: str, name: str, **extra) -> dict:
    from contact_resolver import normalize_contact_name
    key = normalize_contact_name(name)
    existing = await db.contacts.find_one(
        {"company_id": cid, "normalized_name": key},
    )
    if existing:
        return existing
    doc = {
        "id":              f"demo-c-{uuid.uuid4()}",
        "company_id":      cid,
        "name":            name,
        "normalized_name": key,
        "is_pseudo_contact": False,
        "w9_on_file":      False,
        "created_at":      _iso_days_ago(60),
        "updated_at":      _iso_days_ago(60),
        "demo_tag":        DEMO_TAG,
        **extra,
    }
    await db.contacts.insert_one(doc)
    return doc


async def _seed_finding(cid: str, *, kind: str, title: str, detail: str,
                        meta: dict | None = None, severity: str = "amber",
                        action_label: str = "Review",
                        contact_id: str | None = None) -> dict:
    doc = {
        "id":           f"demo-f-{uuid.uuid4()}",
        "company_id":   cid,
        "kind":         kind,
        "status":       "open",
        "severity":     severity,
        "title":        title,
        "detail":       detail,
        "action_label": action_label,
        "action_route": "/cockpit/agents",
        "meta":         meta or {},
        "contact_id":   contact_id,
        "batch_id":     None,
        "created_at":   _iso_days_ago(3),
        "updated_at":   _iso_days_ago(3),
        "demo_tag":     DEMO_TAG,
    }
    await db.agent_findings.insert_one(doc)
    return doc


async def _seed_uncategorized_txn(cid: str) -> dict:
    """Item 1 — needs_review=True, aged past 7-day gate, past the
    initial-download window."""
    from client_review import _hours_after, INITIAL_DOWNLOAD_HOURS
    company = await db.companies.find_one({"id": cid})
    ide = _hours_after(company["created_at"], INITIAL_DOWNLOAD_HOURS)
    ide_dt = datetime.fromisoformat(ide.replace("Z", "+00:00"))
    if ide_dt.tzinfo is None:
        ide_dt = ide_dt.replace(tzinfo=timezone.utc)
    created_dt = max(datetime.now(timezone.utc) - timedelta(days=8),
                     ide_dt + timedelta(hours=2))
    bank = await db.accounts.find_one(
        {"company_id": cid, "code": "1010"}, {"id": 1, "name": 1},
    ) or await db.accounts.find_one(
        {"company_id": cid, "type": "asset"}, {"id": 1, "name": 1},
    )
    doc = {
        "id":                 f"demo-t1-{uuid.uuid4()}",
        "company_id":         cid,
        "date":               created_dt.date().isoformat(),
        "amount":             -483.29,
        "description":        "HOME DEPOT #6234 RENO NV",
        "merchant":           "The Home Depot",
        "bank_account_id":    (bank or {}).get("id"),
        "bank_account_name":  (bank or {}).get("name") or "Business Checking",
        "posted":             True,
        "needs_review":       True,
        "human_reviewed":     False,
        "ai_source":          "llm",
        "ai_comment":         "AI couldn't confidently pick between "
                              "Repairs & Maintenance vs Office Supplies.",
        "client_question_id": None,
        "batch_id":           None,
        "created_at":         created_dt.isoformat(),
        "updated_at":         created_dt.isoformat(),
        "demo_tag":           DEMO_TAG,
    }
    await db.transactions.insert_one(doc)
    return doc


async def _seed_check_no_contact(cid: str) -> list[dict]:
    """Item 13 — check-shaped transactions with no contact. Uses the
    same `is_check_transaction` detector the real collector calls."""
    bank = await db.accounts.find_one(
        {"company_id": cid, "code": "1010"}, {"id": 1, "name": 1},
    ) or await db.accounts.find_one(
        {"company_id": cid, "type": "asset"}, {"id": 1, "name": 1},
    )
    checks = []
    for i, (num, amt, memo) in enumerate([
        ("1042", 250.00, "Landscaping — front yard"),
        ("1043",  95.00, "Notary fees — closing docs"),
    ]):
        d = datetime.now(timezone.utc) - timedelta(days=6 - i)
        doc = {
            "id":                 f"demo-t13-{uuid.uuid4()}",
            "company_id":         cid,
            "date":               d.date().isoformat(),
            "amount":             -amt,
            "description":        f"CHECK #{num}",
            "check_number":       num,
            "number":             num,
            "memo":               memo,
            "merchant":           "",
            "contact_id":         None,
            "contact_name":       None,
            "bank_account_id":    (bank or {}).get("id"),
            "bank_account_name":  (bank or {}).get("name") or "Business Checking",
            "posted":             True,
            "needs_review":       False,
            "human_reviewed":     False,
            "not_a_check_reviewed": False,
            "batch_id":           None,
            "created_at":         d.isoformat(),
            "updated_at":         d.isoformat(),
            "demo_tag":           DEMO_TAG,
        }
        await db.transactions.insert_one(doc)
        checks.append(doc)
    return checks


async def _seed_ai_cleanup(cid: str) -> dict:
    """Item 15 — `contact_cleanup_applied` doc + its underlying txns."""
    vendor = await _seed_contact(cid, "Adobe Systems Inc.")
    bank = await db.accounts.find_one(
        {"company_id": cid, "code": "1010"}, {"id": 1, "name": 1},
    ) or await db.accounts.find_one(
        {"company_id": cid, "type": "asset"}, {"id": 1, "name": 1},
    )
    txn_ids = []
    for i in range(4):
        d = datetime.now(timezone.utc) - timedelta(days=30 * (i + 1))
        tid = f"demo-t15-{uuid.uuid4()}"
        await db.transactions.insert_one({
            "id":                 tid,
            "company_id":         cid,
            "date":               d.date().isoformat(),
            "amount":             -47.99,
            "description":        "ADOBE *CREATIVE CLD 800-833-6687",
            "original_description": "ADOBE *CREATIVE CLD 800-833-6687",
            "merchant":           "Adobe Creative Cloud",
            "contact_id":         vendor["id"],
            "contact_name":       vendor["name"],
            "bank_account_id":    (bank or {}).get("id"),
            "bank_account_name":  (bank or {}).get("name") or "Business Checking",
            "posted":             True,
            "needs_review":       False,
            "batch_id":           None,
            "created_at":         d.isoformat(),
            "updated_at":         d.isoformat(),
            "demo_tag":           DEMO_TAG,
        })
        txn_ids.append(tid)
    doc = {
        "id":                 f"demo-cca-{uuid.uuid4()}",
        "company_id":         cid,
        "status":             "applied",
        "contact_id":         vendor["id"],
        "contact_name":       vendor["name"],
        "descriptor_key":     "adobe-creative-cld",
        "sample_description": "ADOBE *CREATIVE CLD 800-833-6687",
        "before_labels":      ["Uncategorized", "Software"],
        "count":              len(txn_ids),
        "txn_ids":            txn_ids,
        "applied_at":         _iso_days_ago(1),
        "created_at":         _iso_days_ago(1),
        "demo_tag":           DEMO_TAG,
    }
    await db.contact_cleanup_applied.insert_one(doc)
    return doc


async def main() -> int:
    company = await db.companies.find_one({"name": COMPANY_NAME})
    if not company:
        print(f"FATAL: {COMPANY_NAME!r} not found.")
        return 2
    cid = company["id"]

    pro = await db.users.find_one({"email": PRO_EMAIL})
    if not pro:
        print(f"FATAL: {PRO_EMAIL!r} not found.")
        return 2

    # Wire the company so the check-in flow can compile a batch.
    await db.companies.update_one(
        {"id": cid},
        {"$set": {"client_email":          CLIENT_EMAIL,
                  "primary_pro_id":        pro["id"],
                  "pause_review_batches":  False,
                  "updated_at":            datetime.now(timezone.utc).isoformat()}},
    )
    await _cleanup(cid)

    # 1. Uncategorized transaction
    await _seed_uncategorized_txn(cid)

    # 2. Vendor confirmation (`contact_mismatch`)
    ct = await _seed_contact(cid, "Reno Business Supply")
    await _seed_finding(
        cid, kind="contact_mismatch",
        title="Confirm vendor: Reno Business Supply",
        detail="We're seeing 3 charges labeled 'RBS RENO' — is this the same "
               "vendor as 'Reno Business Supply' from your contact list? "
               "Confirm and we'll auto-map future charges.",
        meta={"contact_name": ct["name"], "contact_id": ct["id"],
              "descriptor": "RBS RENO", "sample_count": 3,
              "txn_amount": -284.10},
        contact_id=ct["id"], action_label="Confirm binding",
    )

    # 3. Missing receipt
    await _seed_finding(
        cid, kind="missing_receipt",
        title="Missing receipt: $2,847.00 Best Buy — 8 days ago",
        detail="Charges over $2,500 need a receipt for the audit trail. "
               "Best Buy on " + _date_days_ago(8) + ". Upload a photo or PDF.",
        meta={"txn_amount": -2847.00,
              "txn_desc":   "BEST BUY #1024 RENO NV",
              "txn_date":   _date_days_ago(8)},
        action_label="Upload receipt",
    )

    # 4. W-9 collection
    landscaper = await _seed_contact(
        cid, "Copper Creek Landscaping LLC",
        email="billing@coppercreeklandscaping.example.test",
    )
    await _seed_finding(
        cid, kind="w9_needed",
        title=f"W-9 needed for {landscaper['name']}",
        detail=f"You've paid this contractor $2,100 YTD. To issue a "
               f"1099-NEC at year end we need a completed W-9.",
        contact_id=landscaper["id"],
        meta={"contact_id": landscaper["id"], "ytd_paid": 2100.00,
              "contact_name": landscaper["name"]},
        action_label="Collect W-9",
    )

    # 5. Ambiguous transfer
    pseudo = await _seed_contact(cid, "Internal Transfer #4291-9876",
                                  is_pseudo_contact=True)
    await _seed_finding(
        cid, kind="ambiguous_transfer",
        title="Is this $5,000 movement a transfer or a payment?",
        detail="A $5,000 debit on Checking-4291 and matching credit on "
               "Savings-9876 look like an internal transfer, but landed "
               "2 days apart. Confirm.",
        contact_id=pseudo["id"],
        meta={"amount": 5000.00, "txn_amount": -5000.00,
              "txn_desc":  "TRANSFER TO SAVINGS ····9876",
              "txn_date":  _date_days_ago(6),
              "debit_acct": "Business Checking ····4291",
              "credit_acct": "Business Savings ····9876",
              "days_apart": 2},
        action_label="Confirm transfer",
    )

    # 6. Recurring charge
    await _seed_finding(
        cid, kind="new_recurring_charge",
        title="New recurring charge: Adobe Creative Cloud · $47.99/mo",
        detail="First appeared 22 days ago. Business or personal — we'll "
               "write a rule for future charges either way.",
        meta={"amount":   -47.99, "txn_amount": -47.99,
              "vendor":   "Adobe Creative Cloud",
              "txn_desc": "ADOBE *CREATIVE CLD 800-833-6687",
              "txn_date": _date_days_ago(2),
              "cadence":  "monthly",
              "first_seen_days_ago": 22},
        action_label="Business or personal",
    )

    # 7. Setup detail
    await _seed_finding(
        cid, kind="setup_missing",
        title="Set up sales-tax rate for Nevada",
        detail="You've had 4 invoices this month with tax lines but no "
               "default sales-tax rate configured for Nevada. Set it now "
               "so future invoices auto-populate.",
        meta={"state": "NV", "affected_invoices": 4,
              "txn_amount": None},
        action_label="Configure tax",
    )

    # 8. Split transaction
    await _seed_finding(
        cid, kind="split_suggested",
        title="Split this $1,200 Costco run?",
        detail="AI thinks this Costco charge is a mix — supplies (~$720) "
               "and groceries (~$480). Confirm the split or say 100% biz.",
        meta={"txn_amount": -1200.00,
              "txn_desc":   "COSTCO WHSE #1148 RENO NV",
              "txn_date":   _date_days_ago(5),
              "suggested_splits": [
                  {"account_name": "Office Supplies",      "amount": 720.00, "percent": 60},
                  {"account_name": "Owner Personal Draws", "amount": 480.00, "percent": 40},
              ]},
        action_label="Choose split",
    )

    # 9. Liability payment split
    await _seed_finding(
        cid, kind="liability_split_needed",
        title="$2,145 loan payment — how should we split it?",
        detail="Looks like a mortgage / credit card / auto-loan bill. "
               "Upload the statement and I'll pull out principal, "
               "interest, escrow, and fees.",
        meta={"txn_amount": -2145.67,
              "txn_desc":   "WELLS FARGO HOME MTG PMT 4291",
              "txn_date":   _date_days_ago(1),
              "expected_buckets": ["Principal", "Interest", "Escrow", "Fees"]},
        action_label="Split liability",
    )

    # 10. IRS Meals & Entertainment §274
    await _seed_finding(
        cid, kind="meals_compliance",
        title="Business purpose needed: $184 Cheesecake Factory",
        detail="For meals we need attendees + business purpose on file. "
               "Amounts over $75 also need a receipt (IRS §274).",
        meta={"txn_amount": -184.00,
              "txn_desc":   "CHEESECAKE FACTORY RENO NV",
              "txn_date":   _date_days_ago(4),
              "receipt_required": True,
              "irs_section": "274"},
        action_label="Add attendees + purpose",
    )

    # 11. Owner's Draw check
    await _seed_finding(
        cid, kind="owner_draw_check",
        title="Owner's Draw: check #1055 for $3,500 — right label?",
        detail="This looks like a personal transfer to the owner. "
               "Confirm it's an Owner's Draw (equity), not an expense.",
        meta={"txn_amount": -3500.00,
              "txn_desc":   "CHECK #1055 — PRIYA PATEL",
              "txn_date":   _date_days_ago(3),
              "check_number": "1055"},
        action_label="Confirm draw",
    )

    # 12. Deposit
    await _seed_finding(
        cid, kind="deposit_check",
        title="Deposit of $12,400 — customer payment or something else?",
        detail="A $12,400 deposit landed on " + _date_days_ago(2) +
               ". Is this a customer payment (revenue), an owner contribution, "
               "or a loan? Different books treatment for each.",
        meta={"txn_amount": 12400.00,
              "txn_desc":   "DEPOSIT — BATCH #DEP-2809",
              "txn_date":   _date_days_ago(2)},
        action_label="Categorize deposit",
    )

    # 13. Checks without payee — seed underlying txns; the batch collector
    # explicitly sweeps these via `is_check_transaction` inside our
    # custom compile step below.
    check_txns = await _seed_check_no_contact(cid)

    # 14. IRS Travel & Lodging §274
    await _seed_finding(
        cid, kind="travel_compliance",
        title="Business travel purpose needed: $612 Delta + Marriott",
        detail="Two travel charges (Delta $412, Marriott $200) — we need "
               "destination + business purpose + trip dates for the "
               "IRS §274 substantiation.",
        meta={"txn_amount": -612.00,
              "txn_desc":   "DELTA AIR 006-2298 + MARRIOTT SFO",
              "txn_date":   _date_days_ago(7),
              "irs_section": "274",
              "trip_dates": [_date_days_ago(9), _date_days_ago(7)]},
        action_label="Substantiate travel",
    )

    # 15. AI auto-cleanup confirmation
    await _seed_ai_cleanup(cid)

    # ------------------------------------------------------------------
    # Compile items via the real aggregator so per-type shapes match
    # exactly what the UI expects, then splice items the aggregator's
    # guards would otherwise reject on a young company (item 1 needs
    # 8+ days of company age; item 13 is a special "checks aggregate"
    # not routed through _collect_agent_findings).
    # ------------------------------------------------------------------
    items = await cr.collect_batch_items(cid)

    # Item 1 — force-append a matching entry so the review page has one
    # even when `company.created_at` is younger than the 8-day gate.
    uncat = await db.transactions.find_one(
        {"company_id": cid, "demo_tag": DEMO_TAG, "needs_review": True},
    )
    if uncat and not any(it.get("item_type") == cr.ITEM_UNCATEGORIZED for it in items):
        items.insert(0, {
            "item_id":           str(uuid.uuid4()),
            "item_type":         cr.ITEM_UNCATEGORIZED,
            "source_id":         uncat["id"],
            "source_collection": "transactions",
            "prompt": (f"Could you tell us what this ${abs(uncat['amount']):,.2f} "
                       f"transaction on {uncat['date']} to "
                       f"{uncat.get('merchant') or 'an unknown vendor'} was for?"),
            "context": {
                "date":        uncat.get("date"),
                "amount":      uncat.get("amount"),
                "description": uncat.get("description"),
                "merchant":    uncat.get("merchant"),
                "account":     uncat.get("bank_account_name"),
            },
            "answered_at": None, "answer": None,
            "deferred":    False, "action_taken": None,
        })

    if check_txns:
        items.append({
            "item_id":           str(uuid.uuid4()),
            "item_type":         cr.ITEM_CHECK_NO_CONTACT,
            "source_id":         f"checks-collection-{uuid.uuid4()}",
            "source_collection": "batch",
            "prompt": (f"You've written {len(check_txns)} check"
                       f"{'s' if len(check_txns) != 1 else ''} that we "
                       "can't match to a payee. Would you fill in who "
                       "each one was for?"),
            "context": {
                "checks": [
                    {"id": t["id"], "date": t["date"],
                     "number": t.get("check_number") or t.get("number") or "",
                     "amount": t["amount"], "memo": t.get("memo") or "",
                     "description": t.get("description") or ""}
                    for t in check_txns
                ],
                "count": len(check_txns),
                "total_amount": round(sum(abs(t["amount"]) for t in check_txns), 2),
            },
            "resolved_txn_ids": [],
            "answered_at":  None, "answer": None,
            "deferred":     False, "action_taken": None,
        })

    if len(items) < 1:
        print("FATAL: no items compiled. Data guards likely rejected "
              "the seed rows.")
        return 2

    batch = await cr.create_batch(cid, CLIENT_EMAIL, items)

    # Build the client-facing URL so the CPA can inspect.
    import os
    base = (os.environ.get("PUBLIC_APP_URL")
            or os.environ.get("REACT_APP_BACKEND_URL")
            or "")
    if not base:
        try:
            with open("/app/frontend/.env") as fh:
                for line in fh:
                    if line.startswith("REACT_APP_BACKEND_URL="):
                        base = line.split("=", 1)[1].strip()
                        break
        except Exception:
            pass
    base = base.rstrip("/")
    review_url = f"{base}/client-review/{batch['client_token']}"

    fresh = await db.client_review_batches.find_one({"id": batch["id"]})
    print("\n" + "=" * 72)
    print(f"  9-24 LLC — ALL 15 CHECK-IN ITEM TYPES SEEDED")
    print("=" * 72)
    print(f"  batch_id:     {batch['id']}")
    print(f"  client_email: {CLIENT_EMAIL}")
    print(f"  items:        {len(fresh.get('items') or [])}")
    print(f"  review URL:   {review_url}")
    print("-" * 72)
    seen_types = set()
    for it in fresh.get("items") or []:
        seen_types.add(it["item_type"])
        prompt = (it.get("prompt") or "")[:90]
        print(f"  type={it['item_type']:>2}  {prompt}")
    missing = sorted(set(range(1, 16)) - seen_types)
    print("-" * 72)
    print(f"  types seen:   {sorted(seen_types)}")
    if missing:
        print(f"  MISSING:      {missing}")
    print("=" * 72 + "\n")
    return 0


if __name__ == "__main__":
    import sys
    sys.exit(asyncio.run(main()))
