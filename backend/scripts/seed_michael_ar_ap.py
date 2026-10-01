"""One-off demo seed: 15 invoices + 15 bills + ~12 contacts for Michael Co LLC.

Spread across Apr–Sep 2026. Mix:
  - 40% paid (status=paid, balance_due=0, + payment JE)
  - 30% open (future / near-term due date)
  - 30% overdue (past due date, status=overdue, balance_due>0)

Posts invoice + bill JEs via posting_service so the Balance Sheet A/R and
A/P roll up correctly. Idempotent via a `seed_batch` tag — safe to re-run.
"""
import asyncio
import os
import sys
import uuid
import random
from datetime import date, timedelta, datetime, timezone

from dotenv import load_dotenv
sys.path.insert(0, "/app/backend")
load_dotenv("/app/backend/.env")

from db import db  # noqa: E402
from posting_service import post_invoice_je, post_bill_je, post_payment_je  # noqa: E402

CID = "63f872ac-33be-4f5d-bc78-8b3be5130cbd"  # Michael Co LLC
SEED_TAG = "michael-ar-ap-2026-04-09"
NOW = datetime.now(timezone.utc).isoformat()
TODAY = date(2026, 10, 1)

# Account ids pulled from exploration
AR_ID = "19073a81-5669-401c-96d1-ffd3c149c14c"
AP_ID = "fbf1ee9a-e4f1-44bc-907e-acd5ec78d35c"
REVENUE_SERVICE = "54a66e8e-dd01-43f8-89b3-5533e8b10955"  # Service Revenue
REVENUE_PRODUCT = "7ef3ff6a-80f2-465f-a335-16e4724a0a96"  # Product Sales
EXP_OFFICE = "60495e38-fef6-4ca5-9186-89eed662ca09"
EXP_FOOD_COGS = "ef614f6d-8512-4a19-bf3d-c91cb1e31c69"
EXP_PRO_FEES = "ed11361e-41b5-4722-a6ac-99b8c3c9dc6b"
EXP_TRAVEL = "14d40f34-e898-440d-a728-1ad9dcdc1c64"
EXP_TRANSPORT = "9ecfb72b-6df1-494b-8b67-c1717734a675"
EXP_MEALS = "35ee8db3-d615-4ec4-9104-d206318f3520"
BANK_CHECKING = None  # resolved below from accounts

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


async def _ensure_contact(name: str, email: str, kind: str) -> str:
    existing = await db.contacts.find_one({
        "company_id": CID, "normalized_name": _norm(name),
    })
    if existing:
        return existing["id"]
    cid_doc = str(uuid.uuid4())
    await db.contacts.insert_one({
        "id": cid_doc,
        "company_id": CID,
        "name": name,
        "normalized_name": _norm(name),
        "type": kind,
        "email": email,
        "source": "seed",
        "entry_source": "seed",
        "created_at": NOW, "updated_at": NOW,
        "seed_batch": SEED_TAG,
    })
    return cid_doc


async def _get_bank_checking() -> str:
    row = await db.accounts.find_one(
        {"company_id": CID, "code": "1010"},
        {"_id": 0, "id": 1},
    )
    return row["id"] if row else None


def _make_lines(line_count: int, is_bill: bool, scale: tuple[int, int]):
    lines = []
    for _ in range(line_count):
        qty = random.choice([1, 1, 1, 2, 2, 3])
        rate = round(random.uniform(scale[0], scale[1]), 2)
        amount = round(qty * rate, 2)
        if is_bill:
            acct = random.choice([
                EXP_OFFICE, EXP_FOOD_COGS, EXP_PRO_FEES,
                EXP_TRAVEL, EXP_TRANSPORT, EXP_MEALS,
            ])
            desc = random.choice([
                "Office supplies", "Monthly service", "Materials",
                "Travel expenses", "Professional services", "Freight",
            ])
        else:
            acct = random.choice([REVENUE_SERVICE, REVENUE_PRODUCT])
            desc = random.choice([
                "Consulting services", "Product delivery",
                "Monthly retainer", "Project phase",
            ])
        lines.append({
            "description": desc, "quantity": qty, "rate": rate,
            "amount": amount, "account_id": acct,
        })
    return lines


async def seed():
    global BANK_CHECKING
    BANK_CHECKING = await _get_bank_checking()
    print(f"BANK_CHECKING: {BANK_CHECKING}")

    # Clean prior seed in case re-run.
    inv_del = await db.invoices.delete_many({"company_id": CID, "seed_batch": SEED_TAG})
    bill_del = await db.bills.delete_many({"company_id": CID, "seed_batch": SEED_TAG})
    pay_del = await db.payments.delete_many({"company_id": CID, "seed_batch": SEED_TAG})
    je_del = await db.journal_entries.delete_many({"company_id": CID, "seed_batch": SEED_TAG})
    print(f"Cleaned prior: {inv_del.deleted_count} invoices, {bill_del.deleted_count} bills, "
          f"{pay_del.deleted_count} payments, {je_del.deleted_count} JEs")

    # Ensure contacts.
    customer_ids = []
    for name, email in CUSTOMERS:
        cid_ = await _ensure_contact(name, email, "customer")
        customer_ids.append((cid_, name))
    vendor_ids = []
    for name, email in VENDORS:
        cid_ = await _ensure_contact(name, email, "vendor")
        vendor_ids.append((cid_, name))
    print(f"Contacts ready: {len(customer_ids)} customers, {len(vendor_ids)} vendors")

    # Generate 15 invoices + 15 bills with 40/30/30 paid/open/overdue mix.
    # Status plan: 6 paid, 5 open (future due), 4 overdue (past due, unpaid).
    STATUS_PLAN = ["paid"] * 6 + ["open"] * 5 + ["overdue"] * 4
    random.shuffle(STATUS_PLAN)

    # Spread issue dates Apr–Sep 2026.
    def _random_issue_date():
        # Apr 1 → Sep 30 2026
        start = date(2026, 4, 1)
        end = date(2026, 9, 30)
        delta = (end - start).days
        return start + timedelta(days=random.randint(0, delta))

    rng = random.Random(42)
    random.seed(42)

    inv_number = 1001
    for i, status in enumerate(STATUS_PLAN):
        issue = _random_issue_date()
        # Due date: for overdue → 30-120 days ago; open → in future; paid → past but doesn't matter.
        if status == "overdue":
            # due date must be in the past and NET 30-ish
            due = issue + timedelta(days=random.choice([15, 30, 45]))
            # bump issue earlier if needed so due is in the past
            if due >= TODAY:
                issue = TODAY - timedelta(days=random.randint(40, 90))
                due = issue + timedelta(days=random.choice([15, 30, 45]))
        elif status == "open":
            # due date in the future, net 15/30/45 terms
            issue = TODAY - timedelta(days=random.randint(0, 20))
            due = issue + timedelta(days=random.choice([15, 30, 45]))
            if due <= TODAY:
                due = TODAY + timedelta(days=random.randint(5, 25))
        else:  # paid
            due = issue + timedelta(days=random.choice([15, 30]))

        lines = _make_lines(random.choice([1, 1, 2, 2, 3]), is_bill=False, scale=(400, 2500))
        subtotal = round(sum(l["amount"] for l in lines), 2)
        total = subtotal
        contact_id, contact_name = random.choice(customer_ids)
        inv_id = str(uuid.uuid4())
        is_paid = status == "paid"
        inv_doc = {
            "id": inv_id,
            "company_id": CID,
            "number": f"INV-{inv_number}",
            "contact_id": contact_id,
            "contact_name": contact_name,
            "issue_date": issue.isoformat(),
            "due_date": due.isoformat(),
            "status": status,
            "line_items": lines,
            "subtotal": subtotal,
            "tax": 0.0, "shipping": 0.0, "discount": 0.0,
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

        # Paid: also create payment + payment JE.
        if is_paid:
            pay_date = due - timedelta(days=random.randint(0, 10))
            if pay_date > TODAY:
                pay_date = TODAY - timedelta(days=random.randint(1, 15))
            pay = {
                "id": str(uuid.uuid4()),
                "company_id": CID,
                "amount": total,
                "direction": "in",
                "payment_date": pay_date.isoformat(),
                "linked_invoice_id": inv_id,
                "deposit_to_account_id": BANK_CHECKING,
                "bank_account_id": BANK_CHECKING,
                "method": random.choice(["ach", "check", "card"]),
                "contact_id": contact_id,
                "contact_name": contact_name,
                "source": "seed",
                "created_at": NOW, "updated_at": NOW,
                "seed_batch": SEED_TAG,
            }
            await db.payments.insert_one(pay)
            try:
                await post_payment_je(CID, pay)
            except Exception as e:
                print(f"  payment JE failed for inv {inv_doc['number']}: {e}")

    # Bills same shape, 15 of them, same status mix.
    random.shuffle(STATUS_PLAN)
    bill_number = 2001
    for i, status in enumerate(STATUS_PLAN):
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

        lines = _make_lines(random.choice([1, 1, 2, 2]), is_bill=True, scale=(80, 1500))
        subtotal = round(sum(l["amount"] for l in lines), 2)
        total = subtotal
        contact_id, contact_name = random.choice(vendor_ids)
        bill_id = str(uuid.uuid4())
        is_paid = status == "paid"
        bill_doc = {
            "id": bill_id,
            "company_id": CID,
            "number": f"BILL-{bill_number}",
            "contact_id": contact_id,
            "contact_name": contact_name,
            "issue_date": issue.isoformat(),
            "due_date": due.isoformat(),
            "status": status,
            "line_items": lines,
            "subtotal": subtotal,
            "tax": 0.0, "shipping": 0.0, "discount": 0.0,
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
                "id": str(uuid.uuid4()),
                "company_id": CID,
                "amount": total,
                "direction": "out",
                "payment_date": pay_date.isoformat(),
                "linked_bill_id": bill_id,
                "bank_account_id": BANK_CHECKING,
                "method": random.choice(["ach", "check", "card"]),
                "contact_id": contact_id,
                "contact_name": contact_name,
                "source": "seed",
                "created_at": NOW, "updated_at": NOW,
                "seed_batch": SEED_TAG,
            }
            await db.payments.insert_one(pay)
            try:
                await post_payment_je(CID, pay)
            except Exception as e:
                print(f"  payment JE failed for bill {bill_doc['number']}: {e}")

    # Summary.
    inv_n = await db.invoices.count_documents({"company_id": CID, "seed_batch": SEED_TAG})
    bill_n = await db.bills.count_documents({"company_id": CID, "seed_batch": SEED_TAG})
    pay_n = await db.payments.count_documents({"company_id": CID, "seed_batch": SEED_TAG})
    je_n = await db.journal_entries.count_documents({"company_id": CID, "source_type": {"$in": ["invoice", "bill", "payment"]}})
    print()
    print(f"Seed complete:")
    print(f"  invoices: {inv_n}")
    print(f"  bills: {bill_n}")
    print(f"  payments: {pay_n}")
    print(f"  JEs (invoice+bill+payment): {je_n}")
    # Status breakdown
    for status in ("paid", "open", "overdue"):
        ni = await db.invoices.count_documents({"company_id": CID, "seed_batch": SEED_TAG, "status": status})
        nb = await db.bills.count_documents({"company_id": CID, "seed_batch": SEED_TAG, "status": status})
        print(f"  {status}: {ni} invoices, {nb} bills")


if __name__ == "__main__":
    asyncio.run(seed())
