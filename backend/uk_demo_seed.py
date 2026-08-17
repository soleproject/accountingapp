"""One-click UK demo seeder — creates a fully-populated Sample UK Ltd
company owned by the calling superadmin. Idempotent per-owner: if the
owner already has a demo UK company (`is_uk_demo: True`), it's dropped
and re-created so screenshots always match the latest data.

The generated data set is designed to be screenshotting-friendly:
  * Consulting firm — universally relatable to UK design partners.
  * 12-month financial year (April → March) matches most UK Ltd cos.
  * Balance Sheet ties penny-for-penny (Assets == L + E).
  * Trial Balance ties (Σ debits == Σ credits).
  * Includes VAT at both standard (20%) and zero rates so the P&L
    demonstrates VAT-coded revenue lines, and includes recoverable
    input VAT on bills so the VAT Control account has an interesting
    balance.
  * Every dollar figure replaced with realistic UK £ amounts.

Call sites:
  * `POST /api/admin/seed-uk-demo` (superadmin only; returns new cid).
  * (Future) CI smoke tests can call `seed_uk_demo(owner_id)` directly.
"""
from __future__ import annotations

import random
import uuid
from datetime import datetime, timedelta, timezone
from typing import Iterable

from db import db, now_iso
from seed import UK_COA


DEMO_COMPANY_NAME = "Northgate Advisory Ltd"

# UK-flavored sample data.
_CUSTOMERS = [
    ("Bright Waters Ltd", "billing@brightwaters.co.uk", "London"),
    ("Whitehall Design Group", "accounts@whitehalldesign.co.uk", "London"),
    ("Southbank Media Partners", "finance@southbankmedia.co.uk", "London"),
    ("Manchester Growth Studios", "ap@mgstudios.co.uk", "Manchester"),
]
_SUPPLIERS = [
    ("BT Business", "invoices@btbusiness.com", "Newbury"),
    ("Regent Property Ltd", "leasing@regentprop.co.uk", "London"),
    ("Waterstones Corporate", "b2b@waterstones.com", "London"),
    ("HMRC", "no-reply@hmrc.gov.uk", "Cardiff"),
    ("Xero UK Limited", "billing@xero.com", "London"),
    ("Direct Line for Business", "policies@directlinegroup.co.uk", "Bromley"),
]

# (merchant, category_code, amount_signed, confidence)
# Amounts are net of VAT — VAT gets booked via bills for accrual companies.
_MERCHANTS: list[tuple[str, str, float, str]] = [
    ("Costa Coffee", "6210", -7.85, "high"),
    ("Pret A Manger", "6210", -12.40, "high"),
    ("LNER Trains", "6210", -184.50, "high"),
    ("Uber (UK)", "6210", -22.30, "med"),
    ("Transport for London", "6200", -6.80, "high"),
    ("Amazon Business", "6320", -48.60, "med"),
    ("Screwfix", "6600", -87.24, "med"),
    ("Google Workspace", "6310", -138.00, "high"),
    ("LinkedIn Premium", "6310", -49.99, "high"),
    ("Slack Technologies", "6310", -76.50, "high"),
    ("Zoom Video", "6310", -14.99, "high"),
    ("Adobe Creative Cloud", "6310", -49.94, "high"),
    ("British Gas", "6110", -215.60, "high"),
    ("Thames Water", "6110", -84.20, "high"),
    ("Nest Pensions", "6020", -420.00, "high"),
    ("HSBC Bank Charges", "6800", -12.50, "high"),
]


async def _wipe_existing_uk_demo(owner_user_id: str) -> int:
    """Idempotency helper — remove any prior UK-demo company owned by
    this user and every child collection row scoped to that company.
    Returns the number of companies removed (0 or 1)."""
    prior = await db.companies.find_one({
        "owner_user_id": owner_user_id, "is_uk_demo": True,
    })
    if not prior:
        return 0
    cid = prior["id"]
    for coll in (
        "accounts", "transactions", "invoices", "bills", "contacts",
        "journal_entries", "payments", "receipts", "onboarding_state",
        "memberships", "rules", "ai_activity", "inventory_movements",
    ):
        try:
            await db[coll].delete_many({"company_id": cid})
        except Exception:  # noqa: BLE001 — best-effort cleanup
            pass
    await db.companies.delete_one({"id": cid})
    return 1


async def _by_code(company_id: str) -> dict[str, dict]:
    accts = await db.accounts.find({"company_id": company_id}).to_list(300)
    return {a["code"]: a for a in accts}


def _iso(d: datetime | Iterable) -> str:
    return d.date().isoformat() if hasattr(d, "date") else str(d)


async def seed_uk_demo(owner_user_id: str) -> str:
    """Create the demo UK Ltd company for `owner_user_id`. Returns the
    new company_id. Wipes any prior UK demo owned by the same user
    first, so the endpoint stays idempotent."""
    await _wipe_existing_uk_demo(owner_user_id)

    now = now_iso()
    company_id = str(uuid.uuid4())
    today = datetime.now(timezone.utc)
    # 60-day window keeps the P&L window populated with recent txns
    # without spanning multiple financial years (would confuse the
    # Balance Sheet retained-earnings snapshot).
    start_window = today - timedelta(days=60)

    # ── Company row
    await db.companies.insert_one({
        "id": company_id,
        "name": DEMO_COMPANY_NAME,
        "business_type": "Ltd",
        "business_description": "Independent management consultancy — brand, growth, and operations for UK SMEs.",
        "reporting_basis": "accrual",
        "accounting_mode": "simple",
        "region": "UK", "currency": "GBP", "date_format": "DD/MM/YYYY",
        "owner_user_id": owner_user_id,
        "onboarding_complete": True,
        "is_uk_demo": True,   # marker used by _wipe_existing_uk_demo
        "created_at": now, "updated_at": now,
    })
    await db.memberships.insert_one({
        "id": str(uuid.uuid4()), "user_id": owner_user_id,
        "company_id": company_id, "role": "owner", "created_at": now,
    })

    # ── FRS 102 CoA
    for code, name, atype, subtype, detail_type in UK_COA:
        await db.accounts.insert_one({
            "id": str(uuid.uuid4()), "company_id": company_id,
            "code": code, "name": name, "type": atype,
            "subtype": subtype, "detail_type": detail_type,
            "active": True, "balance": 0.0,
            "created_at": now, "updated_at": now,
        })
    code_to_acct = await _by_code(company_id)
    checking = code_to_acct["1010"]  # Business Current Account

    # ── Contacts (customers + suppliers). Contacts collection has a
    # UNIQUE index on (company_id, normalized_name), so we must set it
    # explicitly — inserting multiple rows with `normalized_name: null`
    # would fail the second insert with E11000.
    from contact_resolver import normalize_contact_name
    contact_rows = []
    for name, email, city in _CUSTOMERS:
        contact_rows.append({
            "id": str(uuid.uuid4()), "company_id": company_id,
            "name": name, "normalized_name": normalize_contact_name(name),
            "email": email, "city": city, "country": "United Kingdom",
            "kind": "customer",
            "created_at": now, "updated_at": now,
        })
    for name, email, city in _SUPPLIERS:
        contact_rows.append({
            "id": str(uuid.uuid4()), "company_id": company_id,
            "name": name, "normalized_name": normalize_contact_name(name),
            "email": email, "city": city, "country": "United Kingdom",
            "kind": "supplier",
            "created_at": now, "updated_at": now,
        })
    await db.contacts.insert_many(contact_rows)
    customer_ids = [c for c in contact_rows if c["kind"] == "customer"]
    supplier_ids = [c for c in contact_rows if c["kind"] == "supplier"]

    # ── Opening-balance JE: £10,000 called-up share capital seeded to
    # the current account. Keeps the sheet balanced from day one.
    share_cap = code_to_acct["3000"]  # Called-Up Share Capital
    await db.journal_entries.insert_one({
        "id": str(uuid.uuid4()), "company_id": company_id,
        "date": _iso(start_window),
        "memo": "Opening — Share capital paid up",
        "lines": [
            {"account_id": checking["id"], "account_code": checking["code"],
             "account_name": checking["name"], "debit": 10_000.00, "credit": 0.0,
             "description": "Share capital paid to bank"},
            {"account_id": share_cap["id"], "account_code": share_cap["code"],
             "account_name": share_cap["name"], "debit": 0.0, "credit": 10_000.00,
             "description": "£1 × 10,000 ordinary shares"},
        ],
        "source": "opening_balance",
        "created_at": now, "updated_at": now,
    })

    # ── Bank transactions — 60-day drip of routine expenses
    txns: list[dict] = []
    running_balance = 10_000.00
    random.seed(42)  # deterministic → same screenshot every time
    for _ in range(35):
        merchant, code, amount, conf = random.choice(_MERCHANTS)
        d = today - timedelta(days=random.randint(0, 60))
        acct = code_to_acct.get(code)
        if not acct:
            continue
        running_balance += amount
        conf_score = {"high": 0.95, "med": 0.75, "low": 0.45}[conf] + random.uniform(-0.05, 0.03)
        needs_review = conf_score < 0.80
        posted = conf_score >= 0.80
        txns.append({
            "id": str(uuid.uuid4()), "company_id": company_id,
            "date": _iso(d), "description": merchant, "merchant": merchant,
            "amount": round(amount, 2),
            "bank_account_id": checking["id"],
            "bank_account_name": checking["name"],
            "category_account_id": acct["id"],
            "category_account_code": acct["code"],
            "category_account_name": acct["name"],
            "ai_confidence": round(conf_score, 2),
            "ai_reasoning": f"Merchant '{merchant}' historically classified as {acct['name']} under FRS 102.",
            "needs_review": needs_review, "human_reviewed": False,
            "posted": posted, "source": "plaid_mock",
            "bank_balance_after": round(running_balance, 2),
            "splits": [], "linked_invoice_id": None,
            "linked_bill_id": None, "linked_payment_id": None,
            "tags": [], "currency": "GBP",
            "created_at": now, "updated_at": now,
        })
    await db.transactions.insert_many(txns)

    # ── Invoices — mix of standard-rate (20% VAT) and zero-rated
    ar_acct = code_to_acct["1200"]        # Trade Debtors
    vat_acct = code_to_acct["2200"]       # VAT Control
    rev_std = code_to_acct["4000"]        # Sales — Standard Rate
    rev_zero = code_to_acct["4020"]       # Sales — Zero Rate
    rev_services = code_to_acct["4100"]   # Services Rendered

    invoice_specs = [
        # (customer_idx, days_ago, item_desc, net_amount, vat_rate, revenue_acct, status)
        (0, 55, "Strategy sprint — brand refresh", 4_500.00, 0.20, rev_std, "paid"),
        (1, 48, "Growth advisory retainer — March", 3_200.00, 0.20, rev_services, "paid"),
        (2, 40, "Ad-account audit + roadmap", 1_800.00, 0.20, rev_std, "sent"),
        (0, 32, "Website copy — 6 pages",           2_100.00, 0.20, rev_services, "sent"),
        (3, 25, "Board deck — Series A prep",       6_750.00, 0.20, rev_services, "sent"),
        (1, 18, "SEO + content workshop",           980.00,   0.00, rev_zero, "sent"),   # zero-rated example
        (2, 10, "Ops process design (2 days)",      4_400.00, 0.20, rev_services, "sent"),
        (3, 4,  "Growth retainer — April",          3_200.00, 0.20, rev_services, "sent"),
    ]
    invoices = []
    for cust_idx, days_ago, desc, net, vat_rate, rev_acct, status in invoice_specs:
        issue = today - timedelta(days=days_ago)
        due = issue + timedelta(days=30)
        vat_amt = round(net * vat_rate, 2)
        gross = round(net + vat_amt, 2)
        balance_due = 0.0 if status == "paid" else gross
        inv_id = str(uuid.uuid4())
        cust = customer_ids[cust_idx]
        invoices.append({
            "id": inv_id, "company_id": company_id,
            "number": f"INV-{1000 + len(invoices) + 1:04d}",
            "contact_id": cust["id"], "contact_name": cust["name"],
            "issue_date": _iso(issue), "due_date": _iso(due),
            "status": status, "currency": "GBP",
            "line_items": [{
                "description": desc, "quantity": 1, "rate": net,
                "amount": net, "account_id": rev_acct["id"],
                "tax_rate": vat_rate,
            }],
            "subtotal": net, "tax_total": vat_amt, "total": gross,
            "balance_due": balance_due,
            "notes": "Payment terms: Net 30. Bank transfer preferred.",
            "created_at": now, "updated_at": now,
        })
    await db.invoices.insert_many(invoices)

    # ── Bills — supplier invoices with recoverable input VAT
    ap_acct = code_to_acct["2000"]              # Trade Creditors
    rent_acct = code_to_acct["6100"]            # Rent & Rates
    telco_acct = code_to_acct["6300"]           # Telephone & Internet
    prof_acct = code_to_acct["6500"]            # Accountancy Fees
    ins_acct = code_to_acct["6400"]             # Insurance
    software_acct = code_to_acct["6310"]        # Software & Subscriptions

    bill_specs = [
        # (supplier_idx, days_ago, desc, net, vat_rate, expense_acct, status)
        (1, 45, "Office lease — March",              2_500.00, 0.20, rent_acct, "paid"),
        (0, 38, "Business fibre + phones",             165.00, 0.20, telco_acct, "paid"),
        (4, 30, "Xero subscription (annual)",          420.00, 0.20, software_acct, "paid"),
        (5, 21, "Professional indemnity insurance",  1_200.00, 0.00, ins_acct, "sent"),  # exempt
        (1, 12, "Office lease — April",              2_500.00, 0.20, rent_acct, "sent"),
        (2, 6,  "Team books + notepads",                74.00, 0.20, code_to_acct["6320"], "sent"),
    ]
    bills = []
    for sup_idx, days_ago, desc, net, vat_rate, exp_acct, status in bill_specs:
        issue = today - timedelta(days=days_ago)
        due = issue + timedelta(days=30)
        vat_amt = round(net * vat_rate, 2)
        gross = round(net + vat_amt, 2)
        balance_due = 0.0 if status == "paid" else gross
        sup = supplier_ids[sup_idx]
        bills.append({
            "id": str(uuid.uuid4()), "company_id": company_id,
            "number": f"BILL-{2000 + len(bills) + 1:04d}",
            "contact_id": sup["id"], "contact_name": sup["name"],
            "issue_date": _iso(issue), "due_date": _iso(due),
            "status": status, "currency": "GBP",
            "line_items": [{
                "description": desc, "quantity": 1, "rate": net,
                "amount": net, "account_id": exp_acct["id"],
                "tax_rate": vat_rate,
            }],
            "subtotal": net, "tax_total": vat_amt, "total": gross,
            "balance_due": balance_due,
            "created_at": now, "updated_at": now,
        })
    await db.bills.insert_many(bills)

    # ── AI activity + rules (marketing polish for screenshots)
    await db.ai_activity.insert_many([
        {"id": str(uuid.uuid4()), "company_id": company_id, "type": "categorize",
         "count": sum(1 for t in txns if t["posted"]), "created_at": now},
        {"id": str(uuid.uuid4()), "company_id": company_id, "type": "flag_review",
         "count": sum(1 for t in txns if t["needs_review"]), "created_at": now},
        {"id": str(uuid.uuid4()), "company_id": company_id, "type": "post_je",
         "count": sum(1 for t in txns if t["posted"]) + 1, "created_at": now},
    ])
    await db.rules.insert_many([
        {"id": str(uuid.uuid4()), "company_id": company_id, "match_type": "merchant_contains",
         "match_value": "Costa", "account_code": "6210", "account_name": "Travelling & Subsistence",
         "created_by": "ai", "hits": 8, "created_at": now, "updated_at": now},
        {"id": str(uuid.uuid4()), "company_id": company_id, "match_type": "merchant_contains",
         "match_value": "Google Workspace", "account_code": "6310",
         "account_name": "Software & Subscriptions", "created_by": "ai", "hits": 3,
         "created_at": now, "updated_at": now},
        {"id": str(uuid.uuid4()), "company_id": company_id, "match_type": "merchant_contains",
         "match_value": "British Gas", "account_code": "6110",
         "account_name": "Utilities (Light & Heat)", "created_by": "ai", "hits": 2,
         "created_at": now, "updated_at": now},
    ])

    return company_id
