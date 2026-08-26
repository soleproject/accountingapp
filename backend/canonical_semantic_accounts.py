"""GAAP-canonical semantic → account library.

Purpose
    When the Global Contact Directory identifies a merchant and the
    tenant's CoA has no account matching that semantic, we auto-create
    the account from this canonical library instead of force-fitting
    or dumping to Uncategorized. Chevron ends up in a real "Fuel &
    Vehicle Expense" account, not Legal Fees.

Design
    One canonical entry per semantic key in our 31-key allowlist. Each
    entry carries: GAAP-clean name, type/subtype/detail_type
    (QBO-compatible taxonomy), recommended code per industry template,
    and a Schedule C / 1120S tax-line mapping so year-end filings
    stay mechanical.

Insertion policy
    * Idempotent: never duplicates. If ANY name pattern for the
      semantic already exists on the CoA, that account is returned.
    * Auto-create is enabled by default (feature-flagged via the
      company doc's `disable_canonical_auto_create` field).
    * Every auto-created account is stamped with `created_via:
      "canonical_semantic"` + `linked_semantic: <sem>` for traceability.
"""
from __future__ import annotations
import uuid
from typing import Optional

from db import now_iso


# ---------------------------------------------------------------------------
# Canonical library — one entry per semantic in the 31-key allowlist
# ---------------------------------------------------------------------------
# Fields:
#   name         proper display name (GAAP-clean)
#   type         asset | liability | equity | income | expense
#   subtype      operating_expense | cost_of_goods_sold | ...
#   detail_type  QBO detail type — must match QBO API vocabulary
#   code_by_template  code number per industry template; falls back to `generic`
#   tax_line     Schedule C default line reference (for year-end mapping)
CANONICAL_SEMANTIC_ACCOUNTS: dict[str, dict] = {
    # ---- Expenses ------------------------------------------------------
    "meals": {
        "name": "Meals & Entertainment", "type": "expense",
        "subtype": "operating_expense", "detail_type": "entertainment_meals",
        "code_by_template": {"generic": "6400", "professional_services": "6400", "restaurant": "6400", "construction": "6400", "ecommerce": "6400"},
        "tax_line": "sched_c_24b_meals",
    },
    "office_supplies": {
        "name": "Office Supplies", "type": "expense",
        "subtype": "operating_expense", "detail_type": "office_general_administrative_expenses",
        "code_by_template": {"generic": "6600", "professional_services": "6600", "restaurant": "6600", "construction": "6600", "ecommerce": "6600"},
        "tax_line": "sched_c_22_supplies",
    },
    "software_saas": {
        "name": "Software & SaaS", "type": "expense",
        "subtype": "operating_expense", "detail_type": "dues_subscriptions",
        "code_by_template": {"generic": "6300", "professional_services": "6300", "restaurant": "6300", "construction": "6300", "ecommerce": "6300"},
        "tax_line": "sched_c_27a_other",
    },
    "travel": {
        "name": "Travel", "type": "expense",
        "subtype": "operating_expense", "detail_type": "travel",
        "code_by_template": {"generic": "6500", "professional_services": "6500", "restaurant": "6500", "construction": "6500", "ecommerce": "6500"},
        "tax_line": "sched_c_24a_travel",
    },
    "transportation": {
        "name": "Transportation & Delivery", "type": "expense",
        "subtype": "operating_expense", "detail_type": "auto_expenses",
        "code_by_template": {"generic": "6360", "professional_services": "6360", "restaurant": "6360", "construction": "6360", "ecommerce": "6360"},
        "tax_line": "sched_c_9_car_and_truck",
    },
    "fuel": {
        "name": "Fuel & Vehicle Expense", "type": "expense",
        "subtype": "operating_expense", "detail_type": "auto_expenses",
        "code_by_template": {"generic": "6350", "professional_services": "6350", "restaurant": "6355", "construction": "6350", "ecommerce": "6350"},
        "tax_line": "sched_c_9_car_and_truck",
    },
    "utilities": {
        "name": "Utilities", "type": "expense",
        "subtype": "operating_expense", "detail_type": "utilities",
        "code_by_template": {"generic": "6210", "professional_services": "6210", "restaurant": "6210", "construction": "6210", "ecommerce": "6210"},
        "tax_line": "sched_c_25_utilities",
    },
    "telecom": {
        "name": "Telephone & Internet", "type": "expense",
        "subtype": "operating_expense", "detail_type": "utilities",
        "code_by_template": {"generic": "6220", "professional_services": "6220", "restaurant": "6220", "construction": "6220", "ecommerce": "6220"},
        "tax_line": "sched_c_25_utilities",
    },
    "rent": {
        "name": "Rent or Lease", "type": "expense",
        "subtype": "operating_expense", "detail_type": "rent_or_lease_of_buildings",
        "code_by_template": {"generic": "6200", "professional_services": "6200", "restaurant": "6200", "construction": "6200", "ecommerce": "6200"},
        "tax_line": "sched_c_20b_rent_other",
    },
    "insurance": {
        "name": "Insurance", "type": "expense",
        "subtype": "operating_expense", "detail_type": "insurance_general_liability",
        "code_by_template": {"generic": "6900", "professional_services": "6900", "restaurant": "6900", "construction": "6900", "ecommerce": "6900"},
        "tax_line": "sched_c_15_insurance",
    },
    "bank_fees": {
        "name": "Bank & Merchant Fees", "type": "expense",
        "subtype": "operating_expense", "detail_type": "bank_charges",
        "code_by_template": {"generic": "6800", "professional_services": "6800", "restaurant": "6800", "construction": "6800", "ecommerce": "6800"},
        "tax_line": "sched_c_27a_other",
    },
    "marketing": {
        "name": "Marketing & Advertising", "type": "expense",
        "subtype": "operating_expense", "detail_type": "advertising_promotional",
        "code_by_template": {"generic": "6700", "professional_services": "6700", "restaurant": "6700", "construction": "6700", "ecommerce": "6700"},
        "tax_line": "sched_c_8_advertising",
    },
    "marketplace_ads": {
        "name": "Marketplace & Platform Ads", "type": "expense",
        "subtype": "operating_expense", "detail_type": "advertising_promotional",
        "code_by_template": {"generic": "6710", "professional_services": "6710", "restaurant": "6710", "construction": "6710", "ecommerce": "6710"},
        "tax_line": "sched_c_8_advertising",
    },
    "repairs_maintenance": {
        "name": "Repairs & Maintenance", "type": "expense",
        "subtype": "operating_expense", "detail_type": "repair_maintenance",
        "code_by_template": {"generic": "6250", "professional_services": "6250", "restaurant": "6250", "construction": "6250", "ecommerce": "6250"},
        "tax_line": "sched_c_21_repairs",
    },
    "licenses_permits": {
        "name": "Licenses & Permits", "type": "expense",
        "subtype": "operating_expense", "detail_type": "taxes_paid",
        "code_by_template": {"generic": "6850", "professional_services": "6850", "restaurant": "6850", "construction": "6850", "ecommerce": "6850"},
        "tax_line": "sched_c_23_taxes_licenses",
    },
    "professional_fees": {
        "name": "Legal & Professional Fees", "type": "expense",
        "subtype": "operating_expense", "detail_type": "legal_professional_fees",
        "code_by_template": {"generic": "6000", "professional_services": "6000", "restaurant": "6000", "construction": "6000", "ecommerce": "6000"},
        "tax_line": "sched_c_17_legal",
    },
    "payment_processing_fees": {
        "name": "Payment Processing Fees", "type": "expense",
        "subtype": "operating_expense", "detail_type": "bank_charges",
        "code_by_template": {"generic": "6810", "professional_services": "6810", "restaurant": "6810", "construction": "6810", "ecommerce": "6810"},
        "tax_line": "sched_c_27a_other",
    },
    "payroll_expense": {
        "name": "Salaries & Wages", "type": "expense",
        "subtype": "operating_expense", "detail_type": "payroll_expenses",
        "code_by_template": {"generic": "6100", "professional_services": "6100", "restaurant": "6100", "construction": "6100", "ecommerce": "6100"},
        "tax_line": "sched_c_26_wages",
    },
    "payroll_service_fee": {
        "name": "Payroll Service Fees", "type": "expense",
        "subtype": "operating_expense", "detail_type": "dues_subscriptions",
        "code_by_template": {"generic": "6120", "professional_services": "6120", "restaurant": "6120", "construction": "6120", "ecommerce": "6120"},
        "tax_line": "sched_c_27a_other",
    },
    "delivery_platform_fees": {
        "name": "Delivery Platform Fees", "type": "expense",
        "subtype": "operating_expense", "detail_type": "commissions",
        "code_by_template": {"generic": "6720", "professional_services": "6720", "restaurant": "6400", "construction": "6720", "ecommerce": "6720"},
        "tax_line": "sched_c_10_commissions",
    },
    # ---- COGS ---------------------------------------------------------
    "food_cogs": {
        "name": "Food Cost (COGS)", "type": "expense",
        "subtype": "cost_of_goods_sold", "detail_type": "cost_of_labor_cos",
        "code_by_template": {"generic": "5000", "professional_services": "5000", "restaurant": "5000", "construction": "5000", "ecommerce": "5000"},
        "tax_line": "sched_c_4_cogs",
    },
    "beverage_cogs": {
        "name": "Beverage Cost (COGS)", "type": "expense",
        "subtype": "cost_of_goods_sold", "detail_type": "cost_of_labor_cos",
        "code_by_template": {"generic": "5100", "professional_services": "5100", "restaurant": "5100", "construction": "5100", "ecommerce": "5100"},
        "tax_line": "sched_c_4_cogs",
    },
    "supplies_cogs": {
        "name": "Supplies (COGS)", "type": "expense",
        "subtype": "cost_of_goods_sold", "detail_type": "cost_of_labor_cos",
        "code_by_template": {"generic": "5200", "professional_services": "5200", "restaurant": "5200", "construction": "5200", "ecommerce": "5200"},
        "tax_line": "sched_c_4_cogs",
    },
    "shipping_cogs": {
        "name": "Shipping & Freight (COGS)", "type": "expense",
        "subtype": "cost_of_goods_sold", "detail_type": "shipping_freight_delivery_cos",
        "code_by_template": {"generic": "5300", "professional_services": "5300", "restaurant": "5300", "construction": "5300", "ecommerce": "5300"},
        "tax_line": "sched_c_4_cogs",
    },
    # ---- Cash flow / Liability / Equity -------------------------------
    "owner_draw": {
        "name": "Owner's Draw", "type": "equity",
        "subtype": "owners_equity", "detail_type": "partner_distributions",
        "code_by_template": {"generic": "3100", "professional_services": "3100", "restaurant": "3100", "construction": "3100", "ecommerce": "3100"},
        "tax_line": None,
    },
    "credit_card_payment": {
        "name": "Credit Card Payment (Contra)", "type": "liability",
        "subtype": "current_liability", "detail_type": "credit_card",
        "code_by_template": {"generic": "2100", "professional_services": "2100", "restaurant": "2100", "construction": "2100", "ecommerce": "2100"},
        "tax_line": None,
    },
    "loan_payment": {
        "name": "Loans Payable", "type": "liability",
        "subtype": "long_term_liability", "detail_type": "notes_payable",
        "code_by_template": {"generic": "2300", "professional_services": "2300", "restaurant": "2300", "construction": "2300", "ecommerce": "2300"},
        "tax_line": None,
    },
    "sales_tax_payment": {
        "name": "Sales Tax Payable", "type": "liability",
        "subtype": "current_liability", "detail_type": "sales_tax_payable",
        "code_by_template": {"generic": "2200", "professional_services": "2200", "restaurant": "2200", "construction": "2200", "ecommerce": "2200"},
        "tax_line": None,
    },
    "inter_account_transfer": {
        "name": "Inter-Account Transfer (Clearing)", "type": "asset",
        "subtype": "other_current_asset", "detail_type": "other_current_assets",
        "code_by_template": {"generic": "1900", "professional_services": "1900", "restaurant": "1900", "construction": "1900", "ecommerce": "1900"},
        "tax_line": None,
    },
    # ---- Revenue ------------------------------------------------------
    "revenue_generic": {
        "name": "Sales Revenue", "type": "income",
        "subtype": "income", "detail_type": "sales_of_product_income",
        "code_by_template": {"generic": "4000", "professional_services": "4000", "restaurant": "4000", "construction": "4000", "ecommerce": "4000"},
        "tax_line": "sched_c_1_gross_receipts",
    },
    "interest_income": {
        "name": "Interest Income", "type": "income",
        "subtype": "income", "detail_type": "interest_earned",
        "code_by_template": {"generic": "4900", "professional_services": "4900", "restaurant": "4900", "construction": "4900", "ecommerce": "4900"},
        "tax_line": "sched_c_1_gross_receipts",
    },
}


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

async def ensure_semantic_account(
    db, company_id: str, semantic: str, template: str = "generic",
) -> Optional[dict]:
    """Idempotently ensure a canonical account exists for `semantic` on
    the given company's CoA.  Returns the account dict (existing or
    newly-created) or None if the semantic isn't in the canonical
    library or the company opted out.

    Safe to call from ingest hot paths — one query to check the opt-out
    flag, one to look for existing name match, one insert if creation is
    needed.  Returns the account so the caller can post immediately.
    """
    spec = CANONICAL_SEMANTIC_ACCOUNTS.get(semantic)
    if not spec:
        return None

    # Opt-out gate — the company can disable auto-creation entirely.
    company = await db.companies.find_one(
        {"id": company_id},
        projection={"disable_canonical_auto_create": 1},
    )
    if company and company.get("disable_canonical_auto_create"):
        return None

    # Idempotent: if any existing account name contains any of the
    # semantic's name patterns, reuse it. We call in from the resolver
    # AFTER its own name-pattern match has already tried, so this is
    # usually a genuine miss — but defensive check keeps duplicates out.
    import global_vendor_rules
    accounts = await db.accounts.find({"company_id": company_id}).to_list(500)
    existing = global_vendor_rules.resolve_semantic_to_account(
        semantic, accounts, template,
    )
    if existing:
        return existing

    # Also check for an account name COLLISION on the canonical name
    # itself (some CoAs already have "Fuel & Vehicle Expense" typed by
    # hand). Case-insensitive exact match.
    canonical_name = spec["name"]
    canonical_lower = canonical_name.lower()
    for a in accounts:
        if (a.get("name") or "").lower() == canonical_lower:
            return a

    # Pick the code by template with generic fallback.
    code = spec["code_by_template"].get(template) or spec["code_by_template"]["generic"]
    # If the code is already taken by another account on this CoA, bump
    # into an "auto-created" range (9xxx) to avoid ledger reference
    # collisions on QBO sync. This is rare — the templates were designed
    # to be non-colliding — but companies with custom CoAs can hit this.
    if any(a.get("code") == code for a in accounts):
        base = int(code) if code.isdigit() else 9000
        for bump in range(1, 100):
            candidate = str(base + bump)
            if not any(a.get("code") == candidate for a in accounts):
                code = candidate
                break

    new_account = {
        "id": str(uuid.uuid4()),
        "company_id": company_id,
        "code": code,
        "name": canonical_name,
        "type": spec["type"],
        "subtype": spec["subtype"],
        "detail_type": spec["detail_type"],
        "active": True,
        "balance": 0.0,
        # Traceability metadata so the CPA / audit log knows this was
        # auto-created and by which semantic.
        "created_via": "canonical_semantic",
        "linked_semantic": semantic,
        "tax_line": spec.get("tax_line"),
        "created_at": now_iso(),
        "updated_at": now_iso(),
    }
    await db.accounts.insert_one(new_account)
    return new_account


def is_supported(semantic: str) -> bool:
    """Cheap check — does the canonical library have an entry for this
    semantic? Used by callers to decide whether to attempt auto-create
    without hitting the DB."""
    return semantic in CANONICAL_SEMANTIC_ACCOUNTS
