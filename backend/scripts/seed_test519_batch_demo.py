"""Multi-item batch demo for Test 519 LLC — exercises the grouped
progress bar & type-transition arrival lines shipped Sep 2026.

Produces a batch with ~13 items across 5 types:
  * Uncategorized × 4  (biggest volume, appears first)
  * Liability × 2      (mortgage + credit card statements)
  * Missing receipts × 2
  * Ambiguous transfer × 1
  * Recurring × 1
  * W-9 collection × 3

All findings are dated within the last 7 days so a `created_at >= now-7d`
filter picks them up. Cleans up any prior demo rows on Test 519 first.
Run with `PYTHONPATH=/app/backend python scripts/seed_test519_batch_demo.py`.
"""
from __future__ import annotations
import asyncio
import sys
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from deps import db
import client_review as cr


DEMO_TAG      = "seed_test519_multi_demo_v1"
COMPANY_NAME  = "Test 519 LLC"
CLIENT_EMAIL  = "michael+test519@bigsaas.ai"


def _now():         return datetime.now(timezone.utc)
def _iso(dt):       return dt.isoformat()
def _days_ago(n):   return _iso(_now() - timedelta(days=n))


async def _seed_contact(cid, name, *, email=None):
    from contact_resolver import normalize_contact_name
    key = normalize_contact_name(name)
    existing = await db.contacts.find_one(
        {"company_id": cid, "normalized_name": key},
    )
    if existing:
        return existing
    doc = {
        "id":              f"demo-contact-{uuid.uuid4()}",
        "company_id":      cid,
        "name":            name,
        "normalized_name": key,
        "email":           email,
        "created_at":      _days_ago(60),
        "updated_at":      _days_ago(60),
        "demo_tag":        DEMO_TAG,
    }
    await db.contacts.insert_one(doc)
    return doc


async def _seed_txn(cid, *, amount, merchant, description, days_ago, bank_id,
                    bank_name, category_id=None, contact_id=None, needs_review=True):
    tid = f"demo1-{uuid.uuid4()}"
    created = _now() - timedelta(days=days_ago)
    doc = {
        "id":               tid,
        "company_id":       cid,
        "date":             created.date().isoformat(),
        "amount":           amount,
        "merchant":         merchant,
        "description":      description,
        "bank_account_id":  bank_id,
        "bank_account_name": bank_name,
        "category_account_id": category_id,
        "contact_id":       contact_id,
        "needs_review":     needs_review,
        "human_reviewed":   False,
        "posted":           True,
        "client_question_id": None,
        "created_at":       _iso(created),
        "updated_at":       _iso(created),
        "demo_tag":         DEMO_TAG,
    }
    await db.transactions.insert_one(doc)
    return doc


async def _seed_finding(cid, *, kind, title, detail, severity="amber",
                        meta=None, contact_id=None, action_label=None,
                        days_ago=1):
    fid = f"demo-finding-{uuid.uuid4()}"
    doc = {
        "id":              fid,
        "company_id":      cid,
        "kind":            kind,
        "title":           title,
        "detail":          detail,
        "severity":        severity,
        "meta":            meta or {},
        "contact_id":      contact_id,
        "action_label":    action_label,
        "status":          "open",
        "created_at":      _days_ago(days_ago),
        "updated_at":      _days_ago(days_ago),
        "demo_tag":        DEMO_TAG,
    }
    await db.agent_findings.insert_one(doc)
    return doc


async def _cleanup(cid):
    await db.agent_findings.delete_many({"company_id": cid, "demo_tag": DEMO_TAG})
    await db.transactions.delete_many({"company_id": cid, "demo_tag": DEMO_TAG})
    await db.client_review_batches.delete_many(
        {"company_id": cid, "client_email": CLIENT_EMAIL, "demo_tag": DEMO_TAG},
    )


async def main():
    co = await db.companies.find_one({"name": COMPANY_NAME})
    if not co:
        print(f"FATAL: {COMPANY_NAME!r} not found in DB.")
        return 2
    cid = co["id"]
    print(f"Using company {co['name']} ({cid})")

    # `_collect_aged_uncategorized` requires txns created > company+24h
    # AND > 7 days ago. On a freshly-created demo company, backdate
    # `created_at` so the filter can find our seeded uncategorized rows.
    from datetime import datetime as _dt
    now = _now()
    created_at = co.get("created_at")
    if isinstance(created_at, str):
        try:
            created_dt = _dt.fromisoformat(created_at.replace("Z", "+00:00"))
        except Exception:
            created_dt = now
    else:
        created_dt = created_at or now
    if (now - created_dt).days < 15:
        backdated = _iso(now - timedelta(days=30))
        await db.companies.update_one(
            {"id": cid}, {"$set": {"created_at": backdated}},
        )
        print(f"  (backdated Test 519 created_at → {backdated} so aged "
              "uncategorized filter has a window)")

    await _cleanup(cid)

    # Bank account
    bank = await db.accounts.find_one(
        {"company_id": cid, "type": "asset"},
        {"id": 1, "name": 1},
    )
    if not bank:
        print("FATAL: no asset account on Test 519 LLC")
        return 3
    bank_id   = bank["id"]
    bank_name = bank.get("name") or "Business Checking"

    # ------- 4 uncategorized txns (>7d old to pass the age filter,
    #         but within the "last 14 days" window the user is auditing) --
    uncat_seeds = [
        {"amount": -742.16, "merchant": "The Home Depot",
         "desc":   "HOME DEPOT #6234 RENO NV",         "days": 8},
        {"amount": -184.55, "merchant": "Costco Wholesale",
         "desc":   "COSTCO WHSE #0472 SPARKS NV",      "days": 9},
        {"amount": -63.87,  "merchant": "Amazon.com",
         "desc":   "AMZN MKTP US*RT4KL8",              "days": 10},
        {"amount": -1240.00, "merchant": "IntelliJ IDEA",
         "desc":   "JETBRAINS SUBSCRIPTION",           "days": 11},
    ]
    for u in uncat_seeds:
        t = await _seed_txn(cid,
                            amount=u["amount"],
                            merchant=u["merchant"],
                            description=u["desc"],
                            days_ago=u["days"],
                            bank_id=bank_id,
                            bank_name=bank_name)
        await _seed_finding(
            cid, kind="uncategorized",
            title=f"How should we categorize this {abs(u['amount']):.2f} charge?",
            detail=f"{u['merchant']} — {u['desc']} — no rule matched, "
                   "AI wasn't confident enough to auto-post.",
            severity="amber",
            meta={"txn_amount": u["amount"], "txn_desc": u["desc"],
                  "txn_date": t["date"], "txn_id": t["id"]},
            action_label="Categorize",
            days_ago=u["days"] - 1,
        )

    # ------- 2 missing receipts --------------------------------------
    for i, mr in enumerate([
        {"amount": -2847.00, "merchant": "Best Buy",
         "desc":   "BEST BUY #1024 RENO NV",           "days": 4},
        {"amount": -3210.55, "merchant": "Delta Airlines",
         "desc":   "DELTA AIR LINES 8721",             "days": 6},
    ]):
        await _seed_finding(
            cid, kind="missing_receipt",
            title=f"Missing receipt: ${abs(mr['amount']):.2f} {mr['merchant']}",
            detail=f"Charges over $2,500 need a receipt for the audit "
                   f"trail. {mr['merchant']} — {mr['desc']}.",
            severity="amber",
            meta={"txn_amount": mr["amount"], "txn_desc": mr["desc"],
                  "txn_date": _days_ago(mr["days"])[:10]},
            action_label="Upload receipt",
            days_ago=mr["days"] - 1,
        )

    # ------- 1 ambiguous transfer ------------------------------------
    await _seed_finding(
        cid, kind="ambiguous_transfer",
        title="What was this $8,500 outgoing wire?",
        detail="An $8,500 wire went out to an unnamed account 4 days "
               "ago. We can't pair it with any incoming transfer or "
               "payable — is this a loan repayment, an owner draw, or "
               "a payment to a vendor?",
        severity="amber",
        meta={"txn_amount": -8500.00,
              "txn_desc":   "WIRE TRANSFER OUT — SEE MEMO",
              "txn_date":   _days_ago(4)[:10]},
        action_label="Clarify",
        days_ago=3,
    )

    # ------- 1 new recurring charge ----------------------------------
    await _seed_finding(
        cid, kind="new_recurring_charge",
        title="New recurring charge: $99/mo Notion",
        detail="Notion started billing $99/month 3 weeks ago — is this "
               "business software (Software Subscriptions) or personal?",
        severity="amber",
        meta={"txn_amount": -99.00,
              "txn_desc":   "NOTION LABS INC",
              "txn_date":   _days_ago(2)[:10],
              "cadence":    "monthly"},
        action_label="Classify",
        days_ago=2,
    )

    # ------- 3 W-9 collection cases ----------------------------------
    for name, ytd, email in [
        ("Copper Creek Landscaping", 2100.00, None),
        ("Bright Marketing Studio",  1420.00, "hi@brightmkt.example.test"),
        ("Northgate Web Design",     3480.00, None),
    ]:
        contact = await _seed_contact(cid, name, email=email)
        await _seed_finding(
            cid, kind="w9_needed",
            title=f"Ask {name} for a W-9",
            detail=f"You've paid {name} ${ytd:,.2f} year-to-date — over "
                   "the $600 1099-NEC threshold. We need their W-9 on "
                   "file before year-end.",
            severity="red" if ytd > 3000 else "amber",
            contact_id=contact["id"],
            meta={"contact_id": contact["id"], "ytd_paid": ytd,
                  "contact_name": name},
            action_label="Send W-9 request",
            days_ago=1,
        )

    # ------- 2 liability payment splits ------------------------------
    for label, amount, desc, days in [
        ("mortgage",     -3421.55, "WELLS FARGO HOME MTG PMT",   4),
        ("auto loan",    -689.10,  "TOYOTA FIN SVCS PMT",        6),
    ]:
        await _seed_finding(
            cid, kind="liability_split_needed",
            title=f"Split the ${abs(amount):.2f} {label} payment",
            detail=f"Your {label} payment on {_days_ago(days)[:10]} "
                   "typically splits across principal, interest, escrow "
                   "and fees. Upload the statement and I'll do the math.",
            severity="amber",
            meta={"txn_amount": amount, "txn_desc": desc,
                  "txn_date": _days_ago(days)[:10],
                  "liability_kind": label},
            action_label="Upload statement",
            days_ago=days - 1,
        )

    # ------- Build the batch -----------------------------------------
    items = await cr.collect_batch_items(cid)
    # Filter to only findings + txns we seeded this run so we don't
    # accidentally sweep in leftover legacy findings on Test 519.
    demo_finding_ids = set()
    async for f in db.agent_findings.find(
        {"company_id": cid, "demo_tag": DEMO_TAG}, {"id": 1},
    ):
        demo_finding_ids.add(f["id"])
    demo_txn_ids = set()
    async for t in db.transactions.find(
        {"company_id": cid, "demo_tag": DEMO_TAG}, {"id": 1},
    ):
        demo_txn_ids.add(t["id"])
    items = [i for i in items
             if i.get("source_id") in demo_finding_ids
             or i.get("source_id") in demo_txn_ids]

    if not items:
        print("FATAL: collect_batch_items returned nothing for Test 519.")
        return 4

    batch = await cr.create_batch(cid, CLIENT_EMAIL, items)
    # Stamp demo_tag so cleanup can find it later.
    await db.client_review_batches.update_one(
        {"id": batch["id"]},
        {"$set": {"demo_tag": DEMO_TAG}},
    )

    from email_dispatcher import public_base_url
    base = public_base_url()
    review_url = f"{base}/client-review/{batch['client_token']}"

    print()
    print("=" * 72)
    print("MULTI-ITEM DEMO BATCH — Test 519 LLC")
    print("=" * 72)
    print(f"  batch_id:      {batch['id']}")
    print(f"  items:         {len(items)}")
    # Group summary — labels inlined (client_review.py doesn't export
    # a Python-side label map; ITEM_TYPE_LABELS lives on the frontend).
    LABELS = {
        1: "Uncategorized",
        2: "Vendor confirmation",
        3: "Missing receipt",
        4: "W-9 collection",
        5: "Ambiguous transfer",
        6: "New recurring",
        7: "Setup detail",
        8: "Split suggested",
        9: "Liability split",
    }
    from collections import Counter
    counts = Counter(i["item_type"] for i in items)
    for it, c in sorted(counts.items()):
        print(f"    · {LABELS.get(it, it):24}  {c}")
    print(f"  review URL:    {review_url}")
    print("=" * 72)
    return 0


try:
    from client_review import ITEM_UNCATEGORIZED  # noqa: F401
except Exception:
    pass


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
