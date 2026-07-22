"""Seed demo data: superadmin, pro, client, one company, chart of accounts, sample transactions."""
from __future__ import annotations
import asyncio
import uuid
import random
from datetime import datetime, timezone, timedelta
from db import db, now_iso
from auth import hash_password

DEFAULT_COA = [
    # Assets
    ("1000", "Cash and Bank", "asset", "current_asset"),
    ("1010", "Business Checking", "asset", "current_asset"),
    ("1020", "Business Savings", "asset", "current_asset"),
    ("1200", "Accounts Receivable", "asset", "current_asset"),
    ("1300", "Inventory", "asset", "current_asset"),
    ("1500", "Prepaid Expenses", "asset", "current_asset"),
    ("1100", "Undeposited Funds", "asset", "current_asset"),
    ("1600", "Equipment", "asset", "fixed_asset"),
    ("1700", "Accumulated Depreciation", "asset", "fixed_asset"),
    # Liabilities
    ("2000", "Accounts Payable", "liability", "current_liability"),
    ("2100", "Credit Card Payable", "liability", "current_liability"),
    ("2200", "Sales Tax Payable", "liability", "current_liability"),
    ("2500", "Loans Payable", "liability", "long_term_liability"),
    # Equity
    ("3000", "Owner's Equity", "equity", "equity"),
    ("3100", "Retained Earnings", "equity", "equity"),
    ("3300", "Owner's Draw", "equity", "equity"),
    ("3400", "Owner's Contribution", "equity", "equity"),
    # Revenue
    ("4000", "Service Revenue", "revenue", "operating_revenue"),
    ("4100", "Product Sales", "revenue", "operating_revenue"),
    ("4200", "Interest Income", "revenue", "other_revenue"),
    # Expenses
    ("6000", "Meals", "expense", "operating_expense"),
    ("6010", "Entertainment", "expense", "operating_expense"),
    ("6100", "Travel", "expense", "operating_expense"),
    ("6120", "Transportation", "expense", "operating_expense"),
    ("6200", "Advertising & Marketing", "expense", "operating_expense"),
    ("6250", "Dues & Subscriptions", "expense", "operating_expense"),
    ("6300", "Office Supplies", "expense", "operating_expense"),
    ("6400", "Insurance", "expense", "operating_expense"),
    ("6500", "Legal & Professional Fees", "expense", "operating_expense"),
    ("6600", "Utilities", "expense", "operating_expense"),
    ("6700", "Rent", "expense", "operating_expense"),
    ("6800", "Supplies & Materials", "expense", "operating_expense"),
    ("6900", "Repairs & Maintenance", "expense", "operating_expense"),
    ("7000", "Bank Fees", "expense", "operating_expense"),
    ("7100", "Software & SaaS", "expense", "operating_expense"),
    ("7200", "Payroll", "expense", "operating_expense"),
    ("9999", "Uncategorized Expense", "expense", "operating_expense"),
]

SAMPLE_MERCHANTS = [
    ("Starbucks", 6000, -14.50, "high"),
    ("Uber", 6120, -32.10, "high"),
    ("Delta Airlines", 6100, -487.00, "high"),
    ("AWS", 7100, -412.19, "high"),
    ("Google Workspace", 7100, -18.00, "high"),
    ("Adobe", 6250, -54.99, "high"),
    ("WeWork", 6700, -1250.00, "high"),
    ("Comcast Business", 6600, -189.99, "high"),
    ("State Farm", 6400, -285.00, "high"),
    ("Staples", 6300, -47.32, "med"),
    ("Home Depot", 6900, -128.44, "med"),
    ("Costco", 6800, -412.55, "med"),
    ("Facebook Ads", 6200, -650.00, "high"),
    ("LinkedIn Premium", 6250, -59.99, "high"),
    ("Acme Corp Payment", 4000, 5400.00, "high"),
    ("Widget LLC", 4000, 2200.00, "high"),
    ("Bright Idea Co", 4000, 8750.00, "high"),
    ("Unknown Vendor", 9999, -234.12, "low"),
    ("Cash Withdrawal ATM", 9999, -200.00, "low"),
    ("Zelle Payment", 9999, -1200.00, "low"),
]


async def wipe():
    for c in ["users", "companies", "memberships", "accounts", "transactions",
              "invoices", "bills", "payments", "receipts", "contacts",
              "journal_entries", "rules", "ai_activity", "chat_sessions",
              "chat_messages", "connections", "communications", "reconciliations",
              "book_reviews", "close_periods", "inventory_items", "assets",
              "loans", "tags", "onboarding_state"]:
        await db[c].delete_many({})


async def seed():
    await wipe()
    now = now_iso()

    # Users
    superadmin_id = str(uuid.uuid4())
    pro_id = str(uuid.uuid4())
    client_id = str(uuid.uuid4())

    await db.users.insert_many([
        {
            "id": superadmin_id, "email": "admin@axiom.ai", "name": "Alex Admin",
            "password": hash_password("admin123"), "role": "superadmin",
            "created_at": now, "updated_at": now,
        },
        {
            "id": pro_id, "email": "pro@axiom.ai", "name": "Priya Patel, CPA",
            "password": hash_password("pro123"), "role": "pro",
            "firm_name": "Northgate Advisory", "created_at": now, "updated_at": now,
        },
        {
            "id": client_id, "email": "client@axiom.ai", "name": "Michael Chen",
            "password": hash_password("client123"), "role": "client",
            "created_at": now, "updated_at": now,
        },
    ])

    # Company (owned by client, managed by pro)
    company_id = str(uuid.uuid4())
    await db.companies.insert_one({
        "id": company_id, "name": "Skyward Sparks, LLC",
        "business_type": "Marketing Agency",
        "business_description": "Full-service digital marketing agency serving SMBs.",
        "ein": "88-1234567", "fiscal_year_end": "12-31",
        "reporting_basis": "accrual",
        "owner_user_id": client_id, "pro_user_id": pro_id,
        "onboarding_complete": True,
        "created_at": now, "updated_at": now,
    })

    # Second company for pro to have multiple clients
    company2_id = str(uuid.uuid4())
    client2_id = str(uuid.uuid4())
    await db.users.insert_one({
        "id": client2_id, "email": "client2@axiom.ai", "name": "Sarah Kim",
        "password": hash_password("client123"), "role": "client",
        "created_at": now, "updated_at": now,
    })
    await db.companies.insert_one({
        "id": company2_id, "name": "Bright Beans Coffee Co.",
        "business_type": "Retail / F&B",
        "business_description": "Specialty coffee roaster with 3 retail locations.",
        "ein": "87-7654321", "fiscal_year_end": "12-31",
        "reporting_basis": "accrual",
        "owner_user_id": client2_id, "pro_user_id": pro_id,
        "onboarding_complete": False,
        "created_at": now, "updated_at": now,
    })

    # Memberships (which users can access which companies)
    await db.memberships.insert_many([
        {"id": str(uuid.uuid4()), "user_id": client_id, "company_id": company_id, "role": "owner", "created_at": now},
        {"id": str(uuid.uuid4()), "user_id": pro_id, "company_id": company_id, "role": "pro", "created_at": now},
        {"id": str(uuid.uuid4()), "user_id": client2_id, "company_id": company2_id, "role": "owner", "created_at": now},
        {"id": str(uuid.uuid4()), "user_id": pro_id, "company_id": company2_id, "role": "pro", "created_at": now},
    ])

    # Chart of accounts for both companies
    for cid in (company_id, company2_id):
        for code, name, atype, subtype in DEFAULT_COA:
            await db.accounts.insert_one({
                "id": str(uuid.uuid4()), "company_id": cid,
                "code": code, "name": name, "type": atype, "subtype": subtype,
                "active": True, "balance": 0.0,
                "created_at": now, "updated_at": now,
            })

    # Contacts
    from contact_resolver import normalize_contact_name
    contacts = []
    for name, kind in [
        ("Acme Corp", "customer"), ("Widget LLC", "customer"), ("Bright Idea Co", "customer"),
        ("Starbucks", "vendor"), ("AWS", "vendor"), ("WeWork", "vendor"),
        ("State Farm", "vendor"), ("Delta Airlines", "vendor"),
    ]:
        cid = str(uuid.uuid4())
        contacts.append({
            "id": cid, "company_id": company_id, "name": name, "type": kind,
            "normalized_name": normalize_contact_name(name),
            "email": f"contact@{name.lower().replace(' ', '')}.com",
            "phone": "", "address": "", "created_at": now, "updated_at": now,
        })
    await db.contacts.insert_many(contacts)

    # Load accounts for lookup
    accts = await db.accounts.find({"company_id": company_id}).to_list(1000)
    code_to_acct = {a["code"]: a for a in accts}
    checking = code_to_acct["1010"]

    # Transactions (last 60 days)
    txns = []
    today = datetime.now(timezone.utc)
    running_balance = 25000.00
    for i in range(90):
        merchant, code, amount, conf = random.choice(SAMPLE_MERCHANTS)
        d = today - timedelta(days=random.randint(0, 60))
        acct = code_to_acct.get(str(code))
        if not acct:
            continue
        running_balance += amount
        confidence_score = {"high": 0.95, "med": 0.72, "low": 0.42}[conf] + random.uniform(-0.05, 0.03)
        needs_review = confidence_score < 0.80
        posted = confidence_score >= 0.80
        tid = str(uuid.uuid4())
        txns.append({
            "id": tid, "company_id": company_id,
            "date": d.date().isoformat(),
            "description": merchant,
            "merchant": merchant,
            "amount": round(amount, 2),
            "bank_account_id": checking["id"],
            "bank_account_name": "Business Checking",
            "category_account_id": acct["id"],
            "category_account_code": acct["code"],
            "category_account_name": acct["name"],
            "ai_confidence": round(confidence_score, 2),
            "ai_reasoning": f"Merchant '{merchant}' historically classified as {acct['name']} under GAAP.",
            "needs_review": needs_review,
            "human_reviewed": False,
            "posted": posted,
            "source": "plaid_mock",
            "bank_balance_after": round(running_balance, 2),
            "splits": [],
            "linked_invoice_id": None,
            "linked_bill_id": None,
            "linked_payment_id": None,
            "tags": [],
            "created_at": now, "updated_at": now,
        })
    await db.transactions.insert_many(txns)

    # AI activity
    await db.ai_activity.insert_many([
        {"id": str(uuid.uuid4()), "company_id": company_id, "type": "categorize", "count": sum(1 for t in txns if t["posted"]), "created_at": now},
        {"id": str(uuid.uuid4()), "company_id": company_id, "type": "flag_review", "count": sum(1 for t in txns if t["needs_review"]), "created_at": now},
        {"id": str(uuid.uuid4()), "company_id": company_id, "type": "post_je", "count": sum(1 for t in txns if t["posted"]), "created_at": now},
        {"id": str(uuid.uuid4()), "company_id": company_id, "type": "rule_created", "count": 4, "created_at": now},
    ])

    # Rules
    await db.rules.insert_many([
        {"id": str(uuid.uuid4()), "company_id": company_id, "match_type": "merchant_contains",
         "match_value": "Starbucks", "account_code": "6000", "account_name": "Meals",
         "created_by": "ai", "hits": 12, "created_at": now, "updated_at": now},
        {"id": str(uuid.uuid4()), "company_id": company_id, "match_type": "merchant_contains",
         "match_value": "Uber", "account_code": "6120", "account_name": "Transportation",
         "created_by": "ai", "hits": 8, "created_at": now, "updated_at": now},
        {"id": str(uuid.uuid4()), "company_id": company_id, "match_type": "merchant_contains",
         "match_value": "AWS", "account_code": "7100", "account_name": "Software & SaaS",
         "created_by": "ai", "hits": 15, "created_at": now, "updated_at": now},
        {"id": str(uuid.uuid4()), "company_id": company_id, "match_type": "merchant_contains",
         "match_value": "WeWork", "account_code": "6700", "account_name": "Rent",
         "created_by": "human", "hits": 4, "created_at": now, "updated_at": now},
    ])

    # Sample invoice + bill
    ar_acct = code_to_acct["1200"]
    rev_acct = code_to_acct["4000"]
    inv_id = str(uuid.uuid4())
    await db.invoices.insert_one({
        "id": inv_id, "company_id": company_id,
        "number": "INV-1001", "contact_id": contacts[0]["id"],
        "contact_name": contacts[0]["name"],
        "issue_date": (today - timedelta(days=10)).date().isoformat(),
        "due_date": (today + timedelta(days=20)).date().isoformat(),
        "status": "sent",
        "line_items": [
            {"description": "Q4 Campaign Strategy", "quantity": 1, "rate": 4500.00, "amount": 4500.00, "account_id": rev_acct["id"]},
            {"description": "Ad Spend Management", "quantity": 20, "rate": 45.00, "amount": 900.00, "account_id": rev_acct["id"]},
        ],
        "subtotal": 5400.00, "tax": 0.0, "total": 5400.00, "balance_due": 5400.00,
        "notes": "Net 30",
        "created_at": now, "updated_at": now,
    })

    ap_acct = code_to_acct["2000"]
    exp_acct = code_to_acct["6700"]
    bill_id = str(uuid.uuid4())
    await db.bills.insert_one({
        "id": bill_id, "company_id": company_id,
        "number": "BILL-501", "contact_id": contacts[5]["id"],
        "contact_name": contacts[5]["name"],
        "issue_date": (today - timedelta(days=5)).date().isoformat(),
        "due_date": (today + timedelta(days=25)).date().isoformat(),
        "status": "open",
        "line_items": [
            {"description": "Coworking Space - Monthly", "quantity": 1, "rate": 1250.00, "amount": 1250.00, "account_id": exp_acct["id"]},
        ],
        "subtotal": 1250.00, "tax": 0.0, "total": 1250.00, "balance_due": 1250.00,
        "created_at": now, "updated_at": now,
    })

    # Onboarding state for company 2 (in progress)
    await db.onboarding_state.insert_one({
        "id": str(uuid.uuid4()), "company_id": company2_id,
        "step": 1, "total_steps": 6, "complete": False,
        "answers": {}, "created_at": now, "updated_at": now,
    })

    print("Seeded successfully.")
    print("Superadmin: admin@axiom.ai / admin123")
    print("Pro:        pro@axiom.ai / pro123")
    print("Client:     client@axiom.ai / client123")


if __name__ == "__main__":
    asyncio.run(seed())
