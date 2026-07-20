"""One-shot reseed for the "Bright Beans Coffee Co." demo company.

Wipes every existing transaction / contact / rule / AI-activity / journal
entry / receipt / invoice / bill / etc. for Bright Beans, then repopulates
with a rich dataset that exercises every Cleanup Copilot code path:

    * confidently AI-categorized posted rows (Fix now shouldn't touch)
    * `needs_review=True` rows landed on REAL accounts (AT&T → Utilities)
      — should surface in "Approve all AI-ready"
    * `needs_review=True` rows on 6999 Uncategorized Expense (Venmo,
      Kevin Petersen) — should be EXCLUDED from mega-approve
    * contact_in_uncat clusters (Venmo × 12, PSG Spendthrift Trust × 6,
      Larry Brown × 4, Summit Church × 3)
    * contact_split cases (Costco split 6800/6120, Blue Note split
      6250/6200)
    * contact_ai_ready unanimous clusters (AT&T × 8, Adobe × 6)
    * reviewed rows (older, already approved)
    * a couple of invoices, bills, receipts and journal entries

Idempotent — safe to re-run.

Run:
    cd /app/backend && python3 reseed_bright_beans.py
"""
from __future__ import annotations
import asyncio
import random
import uuid
from datetime import datetime, timezone, timedelta

from db import db, now_iso
from contact_resolver import normalize_contact_name


COMPANY_NAME = "Bright Beans Coffee Co."

# Clearbit logo domains for demo contacts. Any contact NOT in this map falls
# back to a colored letter avatar in the UI. Populates `contact.logo_url` so
# every Transactions row can render a merchant logo the way QuickBooks / Ramp
# do it — proves the Plaid `counterparties[].logo_url` + Veryfi `vendor.logo`
# story before the real integrations light up.
LOGO_DOMAIN = {
    "Starbucks": "starbucks.com",
    "Uber": "uber.com",
    "Delta Airlines": "delta.com",
    "AWS": "aws.amazon.com",
    "Google Workspace": "workspace.google.com",
    "Adobe": "adobe.com",
    "WeWork": "wework.com",
    "Comcast Business": "comcast.com",
    "AT&T": "att.com",
    "State Farm": "statefarm.com",
    "Staples": "staples.com",
    "Home Depot": "homedepot.com",
    "Costco": "costco.com",
    "Sysco Food Services": "sysco.com",
    "Peet's Coffee Wholesale": "peets.com",
    "Facebook Ads": "facebook.com",
    "LinkedIn Premium": "linkedin.com",
    "Lincare": "lincare.com",
    "New York Life": "newyorklife.com",
    "McDonald's": "mcdonalds.com",
    "Olive Garden": "olivegarden.com",
    "Venmo": "venmo.com",
    "Zelle Payment": "zellepay.com",
    "Cash App": "cash.app",
}


def _logo_url_for(name: str) -> str | None:
    d = LOGO_DOMAIN.get(name)
    return f"https://logo.clearbit.com/{d}" if d else None


# Contact roster — mix of customers, vendors, and 1099 contractors so the
# UI has real names to render everywhere.
CONTACTS: list[tuple[str, str]] = [
    # Vendors (recurring bills)
    ("Starbucks", "vendor"),
    ("Uber", "vendor"),
    ("Delta Airlines", "vendor"),
    ("AWS", "vendor"),
    ("Google Workspace", "vendor"),
    ("Adobe", "vendor"),
    ("WeWork", "vendor"),
    ("Comcast Business", "vendor"),
    ("AT&T", "vendor"),
    ("State Farm", "vendor"),
    ("Staples", "vendor"),
    ("Home Depot", "vendor"),
    ("Costco", "vendor"),
    ("Blue Note B's Horn Shop", "vendor"),
    ("Sysco Food Services", "vendor"),
    ("Peet's Coffee Wholesale", "vendor"),
    ("Facebook Ads", "vendor"),
    ("LinkedIn Premium", "vendor"),
    ("Lincare", "vendor"),
    ("New York Life", "vendor"),
    ("McDonald's", "vendor"),
    ("Olive Garden", "vendor"),
    ("Sip of Saigon", "vendor"),
    # Payment app noise (should land in Uncategorized until reviewed)
    ("Venmo", "vendor"),
    ("Zelle Payment", "vendor"),
    ("Cash App", "vendor"),
    # Contractors / 1099s (Uncat until reviewed)
    ("PSG Spendthrift Trust", "vendor"),
    ("Larry Brown", "vendor"),
    ("Larry D Brown", "vendor"),
    ("Summit Church Summitnv.org NV", "vendor"),
    ("Jamie Nexxess", "vendor"),
    ("Kevin Petersen", "vendor"),
    ("Michael Giorgi", "customer"),
    # Customers (revenue)
    ("Acme Corp", "customer"),
    ("Widget LLC", "customer"),
    ("Bright Idea Co", "customer"),
    ("Peak Ventures LLC", "customer"),
]


async def main() -> None:
    company = await db.companies.find_one({"name": COMPANY_NAME})
    if not company:
        print(f"ERROR: no company named {COMPANY_NAME!r} — bailing")
        return
    cid = company["id"]
    print(f"reseeding {COMPANY_NAME} ({cid}) …")

    # ---- Wipe existing per-company data ----
    for col in ("transactions", "contacts", "invoices", "bills", "receipts",
                "journal_entries", "rules", "ai_activity", "reconciliations",
                "book_reviews", "close_periods", "tags", "communications"):
        r = await db[col].delete_many({"company_id": cid})
        print(f"  wiped {col}: {r.deleted_count}")

    # ---- Chart of accounts: ensure the runtime-created uncategorized
    # sinks (6999 expense + 4999 income) exist so the AI can drop rows
    # into them like production would.
    now = now_iso()
    for code, name, typ, sub in (
        ("6999", "Uncategorized Expense", "expense", "operating_expense"),
        ("4999", "Uncategorized Income",  "revenue", "operating_revenue"),
    ):
        existing = await db.accounts.find_one({"company_id": cid, "code": code})
        if not existing:
            await db.accounts.insert_one({
                "id": str(uuid.uuid4()), "company_id": cid,
                "code": code, "name": name, "type": typ, "subtype": sub,
                "active": True, "balance": 0.0,
                "created_at": now, "updated_at": now,
            })

    accts = await db.accounts.find({"company_id": cid}).to_list(1000)
    code_to_acct = {a["code"]: a for a in accts}
    checking = code_to_acct.get("1010")
    if not checking:
        # No default checking account — create one so txns have somewhere
        # to live.
        checking_id = str(uuid.uuid4())
        await db.accounts.insert_one({
            "id": checking_id, "company_id": cid,
            "code": "1010", "name": "Business Checking",
            "type": "asset", "subtype": "current_asset",
            "active": True, "balance": 0.0,
            "created_at": now, "updated_at": now,
        })
        checking = {"id": checking_id, "name": "Business Checking"}

    # ---- Contacts ----
    contact_docs = []
    contact_by_name: dict[str, dict] = {}
    for name, kind in CONTACTS:
        c = {
            "id": str(uuid.uuid4()), "company_id": cid,
            "name": name,
            "normalized_name": normalize_contact_name(name),
            "type": kind,
            "email": f"contact@{name.lower().replace(' ','').replace('&','and').replace(chr(39),'').replace(chr(46),'')[:24]}.com",
            "phone": "", "address": "",
            "logo_url": _logo_url_for(name),
            "created_at": now, "updated_at": now,
        }
        contact_docs.append(c)
        contact_by_name[name] = c
    await db.contacts.insert_many(contact_docs)
    print(f"  inserted {len(contact_docs)} contacts")

    # Small helper to build a single transaction dict.
    def _txn(*, date_str: str, contact_name: str, merchant: str, amount: float,
             acct_code: str, ai_conf: float, needs_review: bool,
             human_reviewed: bool, posted: bool, memo: str | None = None,
             ai_source: str = "pfc_resolver") -> dict:
        acct = code_to_acct.get(acct_code)
        # Safety net if a caller passes an accidentally-missing code.
        if not acct:
            acct = code_to_acct["6999"]
        c = contact_by_name.get(contact_name)
        return {
            "id": str(uuid.uuid4()), "company_id": cid,
            "date": date_str,
            "description": merchant,
            "merchant": merchant,
            "amount": round(amount, 2),
            "bank_account_id": checking["id"],
            "bank_account_name": checking.get("name", "Business Checking"),
            "contact_id": c["id"] if c else None,
            "contact_name": c["name"] if c else None,
            "category_account_id": acct["id"],
            "category_account_code": acct["code"],
            "category_account_name": acct["name"],
            "ai_confidence": round(ai_conf, 2),
            "ai_reasoning": memo or f"Merchant '{merchant}' → {acct['name']} (Bright Beans reseed).",
            "ai_source": ai_source,
            "needs_review": needs_review,
            "human_reviewed": human_reviewed,
            "posted": posted,
            "source": "plaid_mock",
            "splits": [],
            "tags": [],
            "created_at": now, "updated_at": now,
        }

    today = datetime.now(timezone.utc).date()
    def d(offset: int) -> str:
        return (today - timedelta(days=offset)).isoformat()

    txns: list[dict] = []

    # ---------- 1) contact_in_uncat clusters ----------
    # Venmo × 12 uncategorized
    for i in range(12):
        txns.append(_txn(
            date_str=d(i * 3 + 1), contact_name="Venmo", merchant="Venmo",
            amount=-random.choice([50, 100, 200, 300, 400, 500]),
            acct_code="6999", ai_conf=0.42,
            needs_review=True, human_reviewed=False, posted=True,
            memo="Merchant looks like a P2P payment app — needs human context.",
        ))
    # PSG Spendthrift Trust × 6 uncategorized
    for i in range(6):
        txns.append(_txn(
            date_str=d(i * 5 + 2), contact_name="PSG Spendthrift Trust",
            merchant="PSG Spendthrift Trust", amount=-2500.00,
            acct_code="6999", ai_conf=0.38,
            needs_review=True, human_reviewed=False, posted=True,
        ))
    # Larry Brown × 4 uncategorized (possible 1099 contractor)
    for i in range(4):
        txns.append(_txn(
            date_str=d(i * 7 + 3), contact_name="Larry Brown",
            merchant="Larry Brown", amount=-random.choice([800, 1200, 1500]),
            acct_code="6999", ai_conf=0.45,
            needs_review=True, human_reviewed=False, posted=True,
        ))
    # Summit Church × 3 uncategorized
    for i in range(3):
        txns.append(_txn(
            date_str=d(i * 9 + 5), contact_name="Summit Church Summitnv.org NV",
            merchant="Summit Church Summitnv.org NV", amount=-500.00,
            acct_code="6999", ai_conf=0.40,
            needs_review=True, human_reviewed=False, posted=True,
        ))
    # Jamie Nexxess × 5 uncategorized
    for i in range(5):
        txns.append(_txn(
            date_str=d(i * 4 + 7), contact_name="Jamie Nexxess",
            merchant="Jamie Nexxess Payment", amount=-1250.00,
            acct_code="6999", ai_conf=0.44,
            needs_review=True, human_reviewed=False, posted=True,
        ))
    # Kevin Petersen × 1 uncategorized (Zelle) — a single flagged row
    txns.append(_txn(
        date_str=d(2), contact_name="Kevin Petersen",
        merchant="Zelle · Kevin Petersen", amount=-1500.00,
        acct_code="6999", ai_conf=0.35,
        needs_review=True, human_reviewed=False, posted=True,
        memo="Could be loan or expense reimbursement — ask CPA.",
    ))
    # Michael Giorgi × 1 uncategorized INCOME (4999)
    txns.append(_txn(
        date_str=d(6), contact_name="Michael Giorgi",
        merchant="Zelle · Michael Giorgi", amount=1500.00,
        acct_code="4999", ai_conf=0.32,
        needs_review=True, human_reviewed=False, posted=True,
        memo="Inbound Zelle — unclear if customer payment or owner contrib.",
    ))

    # ---------- 2) contact_ai_ready unanimous clusters (mega-approve targets) ----------
    # AT&T × 8 rows, all landing on 6600 Utilities — but 5 flagged needs_review
    # to prove the "needs_review=True + real category" rule.
    for i in range(8):
        txns.append(_txn(
            date_str=d(i * 4 + 4), contact_name="AT&T", merchant="AT&T",
            amount=-round(random.uniform(85, 130), 2),
            acct_code="6600", ai_conf=0.95,
            needs_review=(i < 5), human_reviewed=False, posted=True,
        ))
    # Adobe × 6 rows on 7100 Software & SaaS
    for i in range(6):
        txns.append(_txn(
            date_str=d(i * 6 + 5), contact_name="Adobe", merchant="Adobe Creative Cloud",
            amount=-54.99, acct_code="7100", ai_conf=0.97,
            needs_review=False, human_reviewed=False, posted=True,
        ))
    # LinkedIn Premium × 4 rows on 6250 Dues & Subscriptions
    for i in range(4):
        txns.append(_txn(
            date_str=d(i * 8 + 6), contact_name="LinkedIn Premium",
            merchant="LinkedIn Premium", amount=-59.99, acct_code="6250", ai_conf=0.96,
            needs_review=False, human_reviewed=False, posted=True,
        ))
    # Google Workspace × 3 on 7100
    for i in range(3):
        txns.append(_txn(
            date_str=d(i * 10 + 8), contact_name="Google Workspace",
            merchant="Google Workspace", amount=-18.00, acct_code="7100", ai_conf=0.98,
            needs_review=False, human_reviewed=False, posted=True,
        ))

    # ---------- 3) contact_split cases (mixed AI opinions) ----------
    # Costco split: 6 on 6800 Supplies & Materials + 3 on 6120 Transportation
    for i in range(6):
        txns.append(_txn(
            date_str=d(i * 5 + 3), contact_name="Costco", merchant="Costco",
            amount=-round(random.uniform(180, 500), 2),
            acct_code="6800", ai_conf=0.93,
            needs_review=False, human_reviewed=False, posted=True,
        ))
    for i in range(3):
        txns.append(_txn(
            date_str=d(i * 7 + 4), contact_name="Costco", merchant="Costco Gas Station",
            amount=-round(random.uniform(40, 90), 2),
            acct_code="6120", ai_conf=0.88,
            needs_review=False, human_reviewed=False, posted=True,
        ))
    # Blue Note split: 4 on 6250 Dues & Subs + 2 on 6200 Advertising
    for i in range(4):
        txns.append(_txn(
            date_str=d(i * 9 + 5), contact_name="Blue Note B's Horn Shop",
            merchant="Blue Note B's Horn Shop",
            amount=-40.21, acct_code="6250", ai_conf=0.91,
            needs_review=False, human_reviewed=False, posted=True,
        ))
    for i in range(2):
        txns.append(_txn(
            date_str=d(i * 11 + 8), contact_name="Blue Note B's Horn Shop",
            merchant="Blue Note Sponsored Post",
            amount=-125.00, acct_code="6200", ai_conf=0.85,
            needs_review=False, human_reviewed=False, posted=True,
        ))

    # ---------- 4) Vanilla single-shot confidently-categorized rows ----------
    vanilla = [
        ("Starbucks", 6000, -14.50),
        ("Uber", 6120, -32.10),
        ("Delta Airlines", 6100, -487.00),
        ("AWS", 7100, -412.19),
        ("WeWork", 6700, -1250.00),
        ("Comcast Business", 6600, -189.99),
        ("State Farm", 6400, -285.00),
        ("Staples", 6300, -47.32),
        ("Home Depot", 6900, -128.44),
        ("Facebook Ads", 6200, -650.00),
        ("Lincare", 3300, -137.87),
        ("New York Life", 6400, -237.44),
        ("McDonald's", 6000, -26.99),
        ("Olive Garden", 6000, -180.00),
        ("Sip of Saigon", 6000, -41.57),
        ("Sysco Food Services", 6800, -2400.00),
        ("Peet's Coffee Wholesale", 6800, -1650.00),
    ]
    for i, (m, code, amt) in enumerate(vanilla):
        txns.append(_txn(
            date_str=d(i * 2 + 1), contact_name=m, merchant=m,
            amount=amt, acct_code=str(code), ai_conf=0.95,
            needs_review=False, human_reviewed=False, posted=True,
        ))

    # ---------- 5) Reviewed / already-approved rows (historical) ----------
    for i in range(30):
        m, code, amt = random.choice(vanilla)
        txns.append(_txn(
            date_str=d(60 + i), contact_name=m, merchant=m,
            amount=amt + random.uniform(-5, 5),
            acct_code=str(code), ai_conf=0.96,
            needs_review=False, human_reviewed=True, posted=True,
        ))

    # ---------- 6) Customer revenue (a few big AR-cleared checks) ----------
    for cust, amt in [("Acme Corp", 5400.00), ("Widget LLC", 2200.00),
                       ("Bright Idea Co", 8750.00), ("Peak Ventures LLC", 4200.00)]:
        for i in range(3):
            txns.append(_txn(
                date_str=d(i * 12 + 4), contact_name=cust, merchant=f"{cust} Payment",
                amount=amt + random.uniform(-50, 50), acct_code="4000", ai_conf=0.97,
                needs_review=False, human_reviewed=False, posted=True,
            ))

    # ---------- 7) A single genuinely-orphan row (no contact_id) ----------
    txns.append(_txn(
        date_str=d(1), contact_name="",  # no matching contact → contact_id=None
        merchant="MONTHLY SERVICE CHARGE", amount=-15.00,
        acct_code="7000", ai_conf=0.95,
        needs_review=False, human_reviewed=False, posted=True,
    ))

    await db.transactions.insert_many(txns)
    print(f"  inserted {len(txns)} transactions")

    # ---------- Rules (existing categorization rules) ----------
    await db.rules.insert_many([
        {"id": str(uuid.uuid4()), "company_id": cid, "match_type": "merchant_contains",
         "match_value": "Starbucks", "account_code": "6000", "account_name": "Meals",
         "created_by": "ai", "hits": 12, "created_at": now, "updated_at": now},
        {"id": str(uuid.uuid4()), "company_id": cid, "match_type": "merchant_contains",
         "match_value": "Uber", "account_code": "6120", "account_name": "Transportation",
         "created_by": "ai", "hits": 8, "created_at": now, "updated_at": now},
        {"id": str(uuid.uuid4()), "company_id": cid, "match_type": "merchant_contains",
         "match_value": "AWS", "account_code": "7100", "account_name": "Software & SaaS",
         "created_by": "ai", "hits": 15, "created_at": now, "updated_at": now},
        {"id": str(uuid.uuid4()), "company_id": cid, "match_type": "merchant_contains",
         "match_value": "AT&T", "account_code": "6600", "account_name": "Utilities",
         "created_by": "ai", "hits": 8, "created_at": now, "updated_at": now},
    ])

    # ---------- AI activity summary ----------
    await db.ai_activity.insert_many([
        {"id": str(uuid.uuid4()), "company_id": cid, "type": "categorize",
         "count": sum(1 for t in txns if t["posted"]), "created_at": now},
        {"id": str(uuid.uuid4()), "company_id": cid, "type": "flag_review",
         "count": sum(1 for t in txns if t["needs_review"]), "created_at": now},
        {"id": str(uuid.uuid4()), "company_id": cid, "type": "post_je",
         "count": sum(1 for t in txns if t["posted"]), "created_at": now},
        {"id": str(uuid.uuid4()), "company_id": cid, "type": "rule_created",
         "count": 4, "created_at": now},
    ])

    print(f"✓ Bright Beans reseeded: {len(contact_docs)} contacts, {len(txns)} transactions.")
    # Print a quick category rollup so the operator can eyeball the shape.
    from collections import Counter
    cat = Counter((t["category_account_code"], t["category_account_name"]) for t in txns)
    print("  category rollup:")
    for k, v in sorted(cat.items()):
        print(f"    {v:4}× {k[0]} {k[1]}")


if __name__ == "__main__":
    asyncio.run(main())
