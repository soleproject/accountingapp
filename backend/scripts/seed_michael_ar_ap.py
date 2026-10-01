"""One-off demo seed: 15 invoices + 15 bills + ~12 contacts per company.

Usage:
    python scripts/seed_michael_ar_ap.py                  # Michael Co LLC
    python scripts/seed_michael_ar_ap.py "Michael Co 2"   # arg = name substring

Spread across Apr–Sep 2026. Mix:
  - 40% paid (status=paid, balance_due=0, + payment JE)
  - 30% open (future / near-term due date)
  - 30% overdue (past due date, status=overdue, balance_due>0)

Account IDs are resolved per-company at run time (by canonical name regex)
so the same script works across any company whose CoA follows the standard
template. Idempotent via a `seed_batch` tag — safe to re-run.
"""
import asyncio
import os
import re
import sys
import uuid
import random
from datetime import date, timedelta, datetime, timezone

from dotenv import load_dotenv
sys.path.insert(0, "/app/backend")
load_dotenv("/app/backend/.env")

from db import db  # noqa: E402
from posting_service import post_invoice_je, post_bill_je, post_payment_je  # noqa: E402

SEED_TAG = "michael-ar-ap-2026-04-09"
NOW = datetime.now(timezone.utc).isoformat()
TODAY = date(2026, 10, 1)

CUSTOMERS = [
    ("Northstar Logistics", "accounts@northstar-log.com"),
    ("Harbor & Vine Restaurant", "ap@harborvine.com"),
    ("Pine Ridge Dental", "office@pineridgedental.com"),
    ("Civitas Legal Group", "billing@civitaslegal.com"),
    ("Luna Marketing Co.", "finance@lunamktg.com"),
    ("Beacon Property Mgmt", "ap@beaconpm.com"),
]
VENDORS = [
    ("Pacific Freight Co.", "ar@pacificfreight.com"),
    ("Blue Mesa Supplies", "billing@bluemesasupplies.com"),
    ("Sierra Office Solutions", "accounts@sierraoffice.com"),
    ("Rowe & Associates CPA", "office@roweassoc.com"),
    ("Everclean Janitorial", "info@everclean.co"),
    ("Thornhill Insurance", "ar@thornhillins.com"),
]


def _norm(name: str) -> str:
    return "".join(ch for ch in name.lower() if ch.isalnum() or ch == " ").strip()


async def _resolve_accounts(cid: str) -> dict:
    """Per-company account id lookup by canonical name regex. Falls back
    to the account `type` if the name regex misses so the seed still
    posts somewhere sensible for custom CoAs.
    """
    accts = await db.accounts.find(
        {"company_id": cid},
        {"_id": 0, "id": 1, "name": 1, "code": 1, "type": 1, "detail_type": 1},
    ).to_list(None)
    def _find(regex: str, type_fallback: str | None = None) -> str | None:
        pat = re.compile(regex, re.I)
        for a in accts:
            if pat.search(a.get("name") or ""):
                return a["id"]
        if type_fallback:
            for a in accts:
                if a.get("type") == type_fallback:
                    return a["id"]
        return None
    revenue_svc = _find(r"service\s*revenue|services?$", "income")
    revenue_prod = _find(r"product\s*sales|sales\s*of\s*product|^sales$", "income") or revenue_svc
    checking = _find(r"^(business\s+)?checking|^cash$|operating", "asset")
    return {
        "ar": _find(r"^accounts\s*receivable|^a/?r\b", "asset"),
        "ap": _find(r"^accounts\s*payable|^a/?p\b", "liability"),
        "checking": checking,
        "revenue": [x for x in [revenue_svc, revenue_prod] if x] or [_find(r".*", "income")],
        "expenses": [x for x in [
            _find(r"office\s*(supplies|equipment|expense)"),
            _find(r"cogs|cost\s*of\s*goods|food\s*cost"),
            _find(r"professional\s*fees|legal\s*fees|accounting\s*fees"),
            _find(r"travel"),
            _find(r"transport|auto"),
            _find(r"meals"),
        ] if x] or [_find(r".*", "expense")],
    }


async def _ensure_contact(cid: str, name: str, email: str, kind: str) -> str:
    existing = await db.contacts.find_one({
        "company_id": cid, "normalized_name": _norm(name),
    })
    if existing:
        return existing["id"]
    doc_id = str(uuid.uuid4())
    await db.contacts.insert_one({
        "id": doc_id,
        "company_id": cid,
        "name": name,
        "normalized_name": _norm(name),
        "type": kind,
        "email": email,
        "source": "seed",
        "entry_source": "seed",
        "created_at": NOW, "updated_at": NOW,
        "seed_batch": SEED_TAG,
    })
    return doc_id


def _make_lines(line_count: int, is_bill: bool, scale: tuple[int, int], accts: dict):
    lines = []
    for _ in range(line_count):
        qty = random.choice([1, 1, 1, 2, 2, 3])
        rate = round(random.uniform(scale[0], scale[1]), 2)
        amount = round(qty * rate, 2)
        if is_bill:
            acct = random.choice(accts["expenses"])
            desc = random.choice([
                "Office supplies", "Monthly service", "Materials",
                "Travel expenses", "Professional services", "Freight",
            ])
        else:
            acct = random.choice(accts["revenue"])
            desc = random.choice([
                "Consulting services", "Product delivery",
                "Monthly retainer", "Project phase",
            ])
        lines.append({
            "description": desc, "quantity": qty, "rate": rate,
            "amount": amount, "account_id": acct,
        })
    return lines


async def seed(target_company_name_filter: str = "Michael Co LLC"):
    # Resolve company by name — exact first, then substring.
    company = await db.companies.find_one({"name": target_company_name_filter})
    if not company:
        company = await db.companies.find_one({"name": {"$regex": re.escape(target_company_name_filter), "$options": "i"}})
    if not company:
        print(f"No company matched '{target_company_name_filter}'")
        return
    CID = company["id"]
    print(f"Seeding into: {company['name']} ({CID})")

    accts = await _resolve_accounts(CID)
    print(f"  AR={accts['ar']}  AP={accts['ap']}  Checking={accts['checking']}")
    print(f"  revenue accts: {len(accts['revenue'])}  expense accts: {len(accts['expenses'])}")

    # Clean prior seed in case re-run.
    inv_del = await db.invoices.delete_many({"company_id": CID, "seed_batch": SEED_TAG})
    bill_del = await db.bills.delete_many({"company_id": CID, "seed_batch": SEED_TAG})
    pay_del = await db.payments.delete_many({"company_id": CID, "seed_batch": SEED_TAG})
    # JEs created by prior seed insertions — scope by source_id tag so we only
    # remove ones linked to deleted invoices/bills/payments.
    print(f"Cleaned prior: {inv_del.deleted_count} invoices, {bill_del.deleted_count} bills, "
          f"{pay_del.deleted_count} payments")

    # Ensure contacts.
    customer_ids = []
    for name, email in CUSTOMERS:
        cid_ = await _ensure_contact(CID, name, email, "customer")
        customer_ids.append((cid_, name))
    vendor_ids = []
    for name, email in VENDORS:
        cid_ = await _ensure_contact(CID, name, email, "vendor")
        vendor_ids.append((cid_, name))
    print(f"Contacts ready: {len(customer_ids)} customers, {len(vendor_ids)} vendors")

    STATUS_PLAN = ["paid"] * 6 + ["open"] * 5 + ["overdue"] * 4

    def _random_issue_date():
        start = date(2026, 4, 1)
        end = date(2026, 9, 30)
        return start + timedelta(days=random.randint(0, (end - start).days))

    random.seed(42)
    random.shuffle(STATUS_PLAN)

    inv_number = 1001
    for status in STATUS_PLAN:
        issue = _random_issue_date()
        if status == "overdue":
            due = issue + timedelta(days=random.choice([15, 30, 45]))
            if due >= TODAY:
                issue = TODAY - timedelta(days=random.randint(40, 90))
                due = issue + timedelta(days=random.choice([15, 30, 45]))
        elif status == "open":
            issue = TODAY - timedelta(days=random.randint(0, 20))
            due = issue + timedelta(days=random.choice([15, 30, 45]))
            if due <= TODAY:
                due = TODAY + timedelta(days=random.randint(5, 25))
        else:
            due = issue + timedelta(days=random.choice([15, 30]))

        lines = _make_lines(random.choice([1, 1, 2, 2, 3]), is_bill=False, scale=(400, 2500), accts=accts)
        subtotal = round(sum(l["amount"] for l in lines), 2)
        total = subtotal
        contact_id, contact_name = random.choice(customer_ids)
        inv_id = str(uuid.uuid4())
        is_paid = status == "paid"
        inv_doc = {
            "id": inv_id, "company_id": CID,
            "number": f"INV-{inv_number}",
            "contact_id": contact_id, "contact_name": contact_name,
            "issue_date": issue.isoformat(), "due_date": due.isoformat(),
            "status": status, "line_items": lines,
            "subtotal": subtotal, "tax": 0.0, "shipping": 0.0, "discount": 0.0,
            "total": total,
            "balance_due": 0.0 if is_paid else total,
            "amount_paid": total if is_paid else 0.0,
            "notes": "", "terms": f"Net {(due - issue).days}",
            "attachments": [],
            "created_at": NOW, "updated_at": NOW,
            "seed_batch": SEED_TAG,
        }
        await db.invoices.insert_one(inv_doc)
        inv_number += 1
        try:
            await post_invoice_je(CID, inv_doc)
        except Exception as e:
            print(f"  invoice JE failed for {inv_doc['number']}: {e}")

        if is_paid:
            pay_date = due - timedelta(days=random.randint(0, 10))
            if pay_date > TODAY:
                pay_date = TODAY - timedelta(days=random.randint(1, 15))
            pay = {
                "id": str(uuid.uuid4()), "company_id": CID,
                "amount": total, "direction": "in",
                "payment_date": pay_date.isoformat(),
                "linked_invoice_id": inv_id,
                "deposit_to_account_id": accts["checking"],
                "bank_account_id": accts["checking"],
                "method": random.choice(["ach", "check", "card"]),
                "contact_id": contact_id, "contact_name": contact_name,
                "source": "seed", "seed_batch": SEED_TAG,
                "created_at": NOW, "updated_at": NOW,
            }
            await db.payments.insert_one(pay)
            try:
                await post_payment_je(CID, pay)
            except Exception as e:
                print(f"  payment JE failed for inv {inv_doc['number']}: {e}")

    random.shuffle(STATUS_PLAN)
    bill_number = 2001
    for status in STATUS_PLAN:
        issue = _random_issue_date()
        if status == "overdue":
            due = issue + timedelta(days=random.choice([15, 30, 45]))
            if due >= TODAY:
                issue = TODAY - timedelta(days=random.randint(40, 90))
                due = issue + timedelta(days=random.choice([15, 30, 45]))
        elif status == "open":
            issue = TODAY - timedelta(days=random.randint(0, 20))
            due = issue + timedelta(days=random.choice([15, 30, 45]))
            if due <= TODAY:
                due = TODAY + timedelta(days=random.randint(5, 25))
        else:
            due = issue + timedelta(days=random.choice([15, 30]))

        lines = _make_lines(random.choice([1, 1, 2, 2]), is_bill=True, scale=(80, 1500), accts=accts)
        subtotal = round(sum(l["amount"] for l in lines), 2)
        total = subtotal
        contact_id, contact_name = random.choice(vendor_ids)
        bill_id = str(uuid.uuid4())
        is_paid = status == "paid"
        bill_doc = {
            "id": bill_id, "company_id": CID,
            "number": f"BILL-{bill_number}",
            "contact_id": contact_id, "contact_name": contact_name,
            "issue_date": issue.isoformat(), "due_date": due.isoformat(),
            "status": status, "line_items": lines,
            "subtotal": subtotal, "tax": 0.0, "shipping": 0.0, "discount": 0.0,
            "total": total,
            "balance_due": 0.0 if is_paid else total,
            "amount_paid": total if is_paid else 0.0,
            "notes": "", "terms": f"Net {(due - issue).days}",
            "attachments": [],
            "created_at": NOW, "updated_at": NOW,
            "seed_batch": SEED_TAG,
        }
        await db.bills.insert_one(bill_doc)
        bill_number += 1
        try:
            await post_bill_je(CID, bill_doc)
        except Exception as e:
            print(f"  bill JE failed for {bill_doc['number']}: {e}")

        if is_paid:
            pay_date = due - timedelta(days=random.randint(0, 10))
            if pay_date > TODAY:
                pay_date = TODAY - timedelta(days=random.randint(1, 15))
            pay = {
                "id": str(uuid.uuid4()), "company_id": CID,
                "amount": total, "direction": "out",
                "payment_date": pay_date.isoformat(),
                "linked_bill_id": bill_id,
                "bank_account_id": accts["checking"],
                "method": random.choice(["ach", "check", "card"]),
                "contact_id": contact_id, "contact_name": contact_name,
                "source": "seed", "seed_batch": SEED_TAG,
                "created_at": NOW, "updated_at": NOW,
            }
            await db.payments.insert_one(pay)
            try:
                await post_payment_je(CID, pay)
            except Exception as e:
                print(f"  payment JE failed for bill {bill_doc['number']}: {e}")

    inv_n = await db.invoices.count_documents({"company_id": CID, "seed_batch": SEED_TAG})
    bill_n = await db.bills.count_documents({"company_id": CID, "seed_batch": SEED_TAG})
    pay_n = await db.payments.count_documents({"company_id": CID, "seed_batch": SEED_TAG})
    print()
    print(f"Seed complete for {company['name']}:")
    print(f"  invoices: {inv_n}  bills: {bill_n}  payments: {pay_n}")
    for status in ("paid", "open", "overdue"):
        ni = await db.invoices.count_documents({"company_id": CID, "seed_batch": SEED_TAG, "status": status})
        nb = await db.bills.count_documents({"company_id": CID, "seed_batch": SEED_TAG, "status": status})
        print(f"  {status}: {ni} invoices, {nb} bills")


if __name__ == "__main__":
    target = sys.argv[1] if len(sys.argv) > 1 else "Michael Co LLC"
    asyncio.run(seed(target))

