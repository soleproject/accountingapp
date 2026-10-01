"""Multi-item batch demo for Michael Co LLC and Michael Co 2, LLC.

Mirrors the Test 519 LLC demo, bumped to 15 items:
  * Uncategorized × 5
  * Missing receipts × 2
  * Ambiguous transfer × 1
  * New recurring × 1
  * W-9 collection × 3
  * Liability split × 3  (Wells Fargo mortgage per attached statement,
                          Toyota auto loan, Chase credit card)

Run with:
  PYTHONPATH=/app/backend python scripts/seed_michael_qci_demo.py
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


DEMO_TAG = "seed_michael_qci_v1"

TARGETS = [
    {
        "company_name":  "Michael Co LLC",
        "client_email":  "michael+test@bigsaas.ai",
    },
    {
        "company_name":  "Michael Co 2, LLC",
        "client_email":  "michael+preview@bigsaas.ai",
    },
]


def _now():       return datetime.now(timezone.utc)
def _iso(dt):     return dt.isoformat()
def _days_ago(n): return _iso(_now() - timedelta(days=n))


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
                    bank_name, category_id=None, contact_id=None,
                    needs_review=True):
    tid = f"demoqci-{uuid.uuid4()}"
    created = _now() - timedelta(days=days_ago)
    doc = {
        "id":                   tid,
        "company_id":           cid,
        "date":                 created.date().isoformat(),
        "amount":               amount,
        "merchant":             merchant,
        "description":          description,
        "bank_account_id":      bank_id,
        "bank_account_name":    bank_name,
        "category_account_id":  category_id,
        "contact_id":           contact_id,
        "needs_review":         needs_review,
        "human_reviewed":       False,
        "posted":               True,
        "client_question_id":   None,
        "created_at":           _iso(created),
        "updated_at":           _iso(created),
        "demo_tag":             DEMO_TAG,
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
        "kind":             kind,
        "title":            title,
        "detail":           detail,
        "severity":         severity,
        "meta":             meta or {},
        "contact_id":       contact_id,
        "action_label":     action_label,
        "status":           "open",
        "created_at":       _days_ago(days_ago),
        "updated_at":       _days_ago(days_ago),
        "demo_tag":         DEMO_TAG,
    }
    await db.agent_findings.insert_one(doc)
    return doc


async def _cleanup(cid, client_email):
    await db.agent_findings.delete_many({"company_id": cid, "demo_tag": DEMO_TAG})
    await db.transactions.delete_many({"company_id": cid, "demo_tag": DEMO_TAG})
    await db.client_review_batches.delete_many(
        {"company_id": cid, "client_email": client_email, "demo_tag": DEMO_TAG},
    )
    await db.contacts.delete_many({"company_id": cid, "demo_tag": DEMO_TAG})


async def _pick_bank(cid):
    """Prefer 'Business Checking' then any asset."""
    bank = await db.accounts.find_one(
        {"company_id": cid, "type": "asset", "name": "Business Checking"},
        {"id": 1, "name": 1},
    )
    if not bank:
        bank = await db.accounts.find_one(
            {"company_id": cid, "type": "asset"},
            {"id": 1, "name": 1},
        )
    return bank


async def seed_company(company_name: str, client_email: str) -> int:
    co = await db.companies.find_one({"name": company_name})
    if not co:
        print(f"FATAL: {company_name!r} not found in DB.")
        return 2
    cid = co["id"]
    print(f"\n>>> Seeding {company_name} ({cid}) — client {client_email}")

    # `_collect_aged_uncategorized` requires txns created > company+24h
    # AND > 7 days ago. Backdate created_at if company is young.
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
        print(f"  (backdated {company_name} created_at → {backdated})")

    await _cleanup(cid, client_email)

    bank = await _pick_bank(cid)
    if not bank:
        print(f"FATAL: no asset account on {company_name}")
        return 3
    bank_id   = bank["id"]
    bank_name = bank.get("name") or "Business Checking"

    # ------- 5 uncategorized txns (>7d old, within 14-day audit window) -----
    uncat_seeds = [
        {"amount": -483.29,  "merchant": "The Home Depot",
         "desc":   "HOME DEPOT #6234 RENO NV",         "days": 8},
        {"amount": -184.55,  "merchant": "Costco Wholesale",
         "desc":   "COSTCO WHSE #0472 SPARKS NV",      "days": 9},
        {"amount": -63.87,   "merchant": "Amazon.com",
         "desc":   "AMZN MKTP US*RT4KL8",              "days": 10},
        {"amount": -1240.00, "merchant": "IntelliJ IDEA",
         "desc":   "JETBRAINS SUBSCRIPTION",           "days": 11},
        {"amount": -318.42,  "merchant": "Office Depot",
         "desc":   "OFFICE DEPOT #482 RENO NV",        "days": 12},
    ]
    for u in uncat_seeds:
        t = await _seed_txn(
            cid,
            amount=u["amount"],
            merchant=u["merchant"],
            description=u["desc"],
            days_ago=u["days"],
            bank_id=bank_id,
            bank_name=bank_name,
        )
        await _seed_finding(
            cid, kind="uncategorized",
            title=f"How should we categorize this {abs(u['amount']):.2f} charge?",
            detail=f"{u['merchant']} — {u['desc']} — no rule matched, "
                   "AI wasn't confident enough to auto-post.",
            severity="amber",
            meta={"txn_amount": u["amount"], "txn_desc": u["desc"],
                  "txn_date":   t["date"], "txn_id": t["id"]},
            action_label="Categorize",
            days_ago=u["days"] - 1,
        )

    # ------- 2 missing receipts ---------------------------------------------
    for mr in [
        {"amount": -2847.00, "merchant": "Best Buy",
         "desc":   "BEST BUY #1024 RENO NV",           "days": 4},
        {"amount": -3210.55, "merchant": "Delta Airlines",
         "desc":   "DELTA AIR LINES 8721",             "days": 6},
    ]:
        await _seed_finding(
            cid, kind="missing_receipt",
            title=f"Missing receipt: ${abs(mr['amount']):.2f} {mr['merchant']}",
            detail=f"Charges over $2,500 need a receipt for the audit "
                   f"trail. {mr['merchant']} — {mr['desc']}.",
            severity="amber",
            meta={"txn_amount": mr["amount"], "txn_desc": mr["desc"],
                  "txn_date":   _days_ago(mr["days"])[:10]},
            action_label="Upload receipt",
            days_ago=mr["days"] - 1,
        )

    # ------- 1 Owner's Draw check (type 11) ---------------------------------
    await _seed_finding(
        cid, kind="owner_draw_check",
        title="Was this $8,500 wire really a personal draw?",
        detail="An $8,500 wire went out 4 days ago with no vendor "
               "memo. If this was money moved to your personal account, "
               "we'll book it as Owner's Draw — otherwise we need the "
               "right expense category.",
        severity="amber",
        meta={"txn_amount": -8500.00,
              "txn_desc":   "WIRE TRANSFER OUT — SEE MEMO",
              "txn_date":   _days_ago(4)[:10]},
        action_label="Clarify",
        days_ago=3,
    )

    # ------- 1 Deposit review (type 12) -------------------------------------
    await _seed_finding(
        cid, kind="deposit_check",
        title="What was this $12,400 deposit?",
        detail="A $12,400 deposit landed 3 days ago from an unnamed "
               "source. Is this customer revenue, an owner contribution, "
               "a loan draw, or a refund we should net against an expense?",
        severity="amber",
        meta={"txn_amount": 12400.00,
              "txn_desc":   "INCOMING ACH — UNNAMED",
              "txn_date":   _days_ago(3)[:10]},
        action_label="Classify",
        days_ago=2,
    )

    # ------- 3 W-9 collection cases -----------------------------------------
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
            meta={"contact_id":   contact["id"], "ytd_paid": ytd,
                  "contact_name": name},
            action_label="Send W-9 request",
            days_ago=1,
        )

    # ------- 3 liability payment splits -------------------------------------
    # The Wells Fargo entry mirrors the attached monthly statement:
    #   Principal $812.45  +  Interest $1,104.22  +  Escrow $210.00
    #   + Late/Other fees $19.00  =  $2,145.67 total,  loan #0421-889302
    for label, amount, desc, days, extra in [
        ("mortgage",   -2145.67, "WELLS FARGO HOME MTG PMT",  4,
         {"principal": 812.45, "interest": 1104.22,
          "escrow":    210.00, "fees":       19.00,
          "loan_number": "0421-889302",
          "statement_date": "2026-09-01",
          "lender": "Wells Fargo Home Mortgage"}),
        ("auto loan",  -689.10,  "TOYOTA FIN SVCS PMT",       6,  {}),
        ("credit card", -1872.44,"CHASE CARD AUTOPAY",        5,  {}),
    ]:
        meta = {"txn_amount": amount, "txn_desc": desc,
                "txn_date":   _days_ago(days)[:10],
                "liability_kind": label}
        meta.update(extra)
        await _seed_finding(
            cid, kind="liability_split_needed",
            title=f"Split the ${abs(amount):.2f} {label} payment",
            detail=f"Your {label} payment on {_days_ago(days)[:10]} "
                   "typically splits across principal, interest, escrow "
                   "and fees. Upload the statement and I'll do the math.",
            severity="amber",
            meta=meta,
            action_label="Upload statement",
            days_ago=days - 1,
        )

    # ------- Build the batch -------------------------------------------------
    items = await cr.collect_batch_items(cid)
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
        print(f"FATAL: collect_batch_items returned nothing for {company_name}.")
        return 4

    batch = await cr.create_batch(cid, client_email, items)
    await db.client_review_batches.update_one(
        {"id": batch["id"]},
        {"$set": {"demo_tag": DEMO_TAG}},
    )

    from email_dispatcher import public_base_url
    base = public_base_url()
    review_url = f"{base}/client-review/{batch['client_token']}"

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
        10: "Meals",
        11: "Owner's Draw",
        12: "Deposits",
        13: "Checks w/out Payee",
        14: "Travel & Lodging",
    }
    from collections import Counter
    counts = Counter(i["item_type"] for i in items)

    print("=" * 72)
    print(f"MULTI-ITEM DEMO BATCH — {company_name}")
    print("=" * 72)
    print(f"  batch_id:      {batch['id']}")
    print(f"  items:         {len(items)}")
    for it, c in sorted(counts.items()):
        print(f"    · {LABELS.get(it, it):24}  {c}")
    print(f"  review URL:    {review_url}")
    print("=" * 72)
    return 0


async def main():
    rc_total = 0
    for t in TARGETS:
        rc = await seed_company(t["company_name"], t["client_email"])
        rc_total |= rc
    return rc_total


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
