"""Industry-specific Chart of Accounts templates.

Each template is a curated CoA that maps cleanly to Schedule C / 1120S /
1065 tax lines. Seeded once during onboarding when the CPA picks a
template. Used by BOTH categorization modes:
  * Standard: constrains the account universe for PFC + Rules + LLM cascade
  * AI-First: same, plus feeds into the LLM prompt as target space

Only 3 real templates + Generic here for MVP — the pattern is trivial to
extend. Each account carries a `tax_line` mapping (Schedule C default;
override per business entity) that keeps year-end filings mechanical.
"""

TEMPLATES: dict[str, dict] = {
    "professional_services": {
        "label": "Professional Services",
        "icon": "💼",
        "accounts": [
            # Assets
            {"code": "1000", "name": "Cash", "type": "asset", "detail_type": "bank"},
            {"code": "1100", "name": "Accounts Receivable", "type": "asset", "detail_type": "accounts_receivable"},
            {"code": "1200", "name": "Prepaid Expenses", "type": "asset", "detail_type": "other_current_asset"},
            {"code": "1500", "name": "Office Equipment", "type": "asset", "detail_type": "fixed_asset"},
            # Liabilities
            {"code": "2000", "name": "Accounts Payable", "type": "liability", "detail_type": "accounts_payable"},
            {"code": "2100", "name": "Credit Card Payable", "type": "liability", "detail_type": "credit_card"},
            {"code": "2200", "name": "Payroll Liabilities", "type": "liability", "detail_type": "other_current_liability"},
            # Equity
            {"code": "3000", "name": "Owner's Equity", "type": "equity"},
            {"code": "3100", "name": "Owner's Draw", "type": "equity"},
            {"code": "3200", "name": "Retained Earnings", "type": "equity"},
            # Revenue
            {"code": "4000", "name": "Consulting Revenue", "type": "income", "detail_type": "income"},
            {"code": "4100", "name": "Retainer Revenue", "type": "income", "detail_type": "income"},
            {"code": "4200", "name": "Reimbursed Expenses", "type": "income", "detail_type": "income"},
            # Expenses
            {"code": "6000", "name": "Contractor & Professional Fees", "type": "expense", "detail_type": "expense"},
            {"code": "6100", "name": "Salaries & Wages", "type": "expense", "detail_type": "expense"},
            {"code": "6110", "name": "Payroll Taxes", "type": "expense", "detail_type": "expense"},
            {"code": "6200", "name": "Rent", "type": "expense", "detail_type": "expense"},
            {"code": "6210", "name": "Utilities", "type": "expense", "detail_type": "expense"},
            {"code": "6300", "name": "Software & Subscriptions", "type": "expense", "detail_type": "expense"},
            {"code": "6400", "name": "Meals - Business", "type": "expense", "detail_type": "expense"},
            {"code": "6500", "name": "Travel", "type": "expense", "detail_type": "expense"},
            {"code": "6600", "name": "Office Supplies", "type": "expense", "detail_type": "expense"},
            {"code": "6700", "name": "Marketing & Advertising", "type": "expense", "detail_type": "expense"},
            {"code": "6800", "name": "Bank & Merchant Fees", "type": "expense", "detail_type": "expense"},
            {"code": "6900", "name": "Insurance", "type": "expense", "detail_type": "expense"},
            {"code": "4999", "name": "Uncategorized Income", "type": "income", "detail_type": "income"},
            {"code": "6999", "name": "Uncategorized Expense", "type": "expense", "detail_type": "expense"},
        ],
    },
    "restaurant": {
        "label": "Restaurant / Food & Beverage",
        "icon": "☕",
        "accounts": [
            {"code": "1000", "name": "Cash", "type": "asset", "detail_type": "bank"},
            {"code": "1100", "name": "Accounts Receivable", "type": "asset", "detail_type": "accounts_receivable"},
            {"code": "1300", "name": "Food Inventory", "type": "asset", "detail_type": "inventory_asset"},
            {"code": "1310", "name": "Beverage Inventory", "type": "asset", "detail_type": "inventory_asset"},
            {"code": "1500", "name": "Kitchen Equipment", "type": "asset", "detail_type": "fixed_asset"},
            {"code": "2000", "name": "Accounts Payable", "type": "liability", "detail_type": "accounts_payable"},
            {"code": "2100", "name": "Credit Card Payable", "type": "liability", "detail_type": "credit_card"},
            {"code": "2200", "name": "Sales Tax Payable", "type": "liability", "detail_type": "other_current_liability"},
            {"code": "3000", "name": "Owner's Equity", "type": "equity"},
            {"code": "3100", "name": "Owner's Draw", "type": "equity"},
            {"code": "4000", "name": "Food Sales", "type": "income", "detail_type": "income"},
            {"code": "4100", "name": "Beverage Sales", "type": "income", "detail_type": "income"},
            {"code": "4200", "name": "Catering Revenue", "type": "income", "detail_type": "income"},
            {"code": "4300", "name": "Delivery Revenue", "type": "income", "detail_type": "income"},
            {"code": "5000", "name": "Food Cost (COGS)", "type": "expense", "detail_type": "cost_of_goods_sold"},
            {"code": "5100", "name": "Beverage Cost (COGS)", "type": "expense", "detail_type": "cost_of_goods_sold"},
            {"code": "5200", "name": "Kitchen Supplies (COGS)", "type": "expense", "detail_type": "cost_of_goods_sold"},
            {"code": "6100", "name": "Wages - Kitchen Staff", "type": "expense", "detail_type": "expense"},
            {"code": "6110", "name": "Wages - Front of House", "type": "expense", "detail_type": "expense"},
            {"code": "6120", "name": "Payroll Taxes", "type": "expense", "detail_type": "expense"},
            {"code": "6200", "name": "Rent", "type": "expense", "detail_type": "expense"},
            {"code": "6210", "name": "Utilities", "type": "expense", "detail_type": "expense"},
            {"code": "6300", "name": "POS & Software", "type": "expense", "detail_type": "expense"},
            {"code": "6400", "name": "Delivery Platform Fees", "type": "expense", "detail_type": "expense"},
            {"code": "6500", "name": "Marketing & Advertising", "type": "expense", "detail_type": "expense"},
            {"code": "6600", "name": "Cleaning & Sanitation", "type": "expense", "detail_type": "expense"},
            {"code": "6700", "name": "Repairs & Maintenance", "type": "expense", "detail_type": "expense"},
            {"code": "6800", "name": "Bank & Merchant Fees", "type": "expense", "detail_type": "expense"},
            {"code": "6900", "name": "Insurance", "type": "expense", "detail_type": "expense"},
            {"code": "4999", "name": "Uncategorized Income", "type": "income", "detail_type": "income"},
            {"code": "6999", "name": "Uncategorized Expense", "type": "expense", "detail_type": "expense"},
        ],
    },
    "ecommerce": {
        "label": "E-commerce / Retail",
        "icon": "🛒",
        "accounts": [
            {"code": "1000", "name": "Cash", "type": "asset", "detail_type": "bank"},
            {"code": "1050", "name": "Payment Processor Clearing", "type": "asset", "detail_type": "bank"},
            {"code": "1300", "name": "Product Inventory", "type": "asset", "detail_type": "inventory_asset"},
            {"code": "2000", "name": "Accounts Payable", "type": "liability", "detail_type": "accounts_payable"},
            {"code": "2100", "name": "Credit Card Payable", "type": "liability", "detail_type": "credit_card"},
            {"code": "2200", "name": "Sales Tax Payable", "type": "liability", "detail_type": "other_current_liability"},
            {"code": "3000", "name": "Owner's Equity", "type": "equity"},
            {"code": "3100", "name": "Owner's Draw", "type": "equity"},
            {"code": "4000", "name": "Product Sales", "type": "income", "detail_type": "income"},
            {"code": "4100", "name": "Shipping Revenue", "type": "income", "detail_type": "income"},
            {"code": "4200", "name": "Wholesale Revenue", "type": "income", "detail_type": "income"},
            {"code": "5000", "name": "Cost of Goods Sold", "type": "expense", "detail_type": "cost_of_goods_sold"},
            {"code": "5100", "name": "Shipping & Freight (COGS)", "type": "expense", "detail_type": "cost_of_goods_sold"},
            {"code": "5200", "name": "Packaging Materials", "type": "expense", "detail_type": "cost_of_goods_sold"},
            {"code": "5300", "name": "Payment Processing Fees", "type": "expense", "detail_type": "cost_of_goods_sold"},
            {"code": "6100", "name": "Salaries & Wages", "type": "expense", "detail_type": "expense"},
            {"code": "6300", "name": "Software & Subscriptions", "type": "expense", "detail_type": "expense"},
            {"code": "6400", "name": "Advertising - Google/Meta", "type": "expense", "detail_type": "expense"},
            {"code": "6410", "name": "Advertising - Marketplace", "type": "expense", "detail_type": "expense"},
            {"code": "6500", "name": "Marketplace Fees (Amazon/eBay/Etsy)", "type": "expense", "detail_type": "expense"},
            {"code": "6600", "name": "Warehouse Rent", "type": "expense", "detail_type": "expense"},
            {"code": "6700", "name": "Office Supplies", "type": "expense", "detail_type": "expense"},
            {"code": "6800", "name": "Bank & Merchant Fees", "type": "expense", "detail_type": "expense"},
            {"code": "6900", "name": "Insurance", "type": "expense", "detail_type": "expense"},
            {"code": "4999", "name": "Uncategorized Income", "type": "income", "detail_type": "income"},
            {"code": "6999", "name": "Uncategorized Expense", "type": "expense", "detail_type": "expense"},
        ],
    },
    "construction": {
        "label": "Construction / Trades",
        "icon": "🏗️",
        "accounts": [
            {"code": "1000", "name": "Cash", "type": "asset", "detail_type": "bank"},
            {"code": "1100", "name": "Accounts Receivable", "type": "asset", "detail_type": "accounts_receivable"},
            {"code": "1300", "name": "Materials Inventory", "type": "asset", "detail_type": "inventory_asset"},
            {"code": "1500", "name": "Trucks & Vehicles", "type": "asset", "detail_type": "fixed_asset"},
            {"code": "1510", "name": "Tools & Equipment", "type": "asset", "detail_type": "fixed_asset"},
            {"code": "2000", "name": "Accounts Payable", "type": "liability", "detail_type": "accounts_payable"},
            {"code": "2100", "name": "Credit Card Payable", "type": "liability", "detail_type": "credit_card"},
            {"code": "3000", "name": "Owner's Equity", "type": "equity"},
            {"code": "3100", "name": "Owner's Draw", "type": "equity"},
            {"code": "4000", "name": "Contract Revenue", "type": "income", "detail_type": "income"},
            {"code": "4100", "name": "Change Order Revenue", "type": "income", "detail_type": "income"},
            {"code": "5000", "name": "Materials Cost (Job)", "type": "expense", "detail_type": "cost_of_goods_sold"},
            {"code": "5100", "name": "Subcontractor Costs", "type": "expense", "detail_type": "cost_of_goods_sold"},
            {"code": "5200", "name": "Equipment Rental", "type": "expense", "detail_type": "cost_of_goods_sold"},
            {"code": "5300", "name": "Job Site Utilities/Dumpsters", "type": "expense", "detail_type": "cost_of_goods_sold"},
            {"code": "6100", "name": "Wages - Field Crew", "type": "expense", "detail_type": "expense"},
            {"code": "6120", "name": "Payroll Taxes", "type": "expense", "detail_type": "expense"},
            {"code": "6200", "name": "Fuel & Vehicle Expense", "type": "expense", "detail_type": "expense"},
            {"code": "6210", "name": "Vehicle Maintenance", "type": "expense", "detail_type": "expense"},
            {"code": "6300", "name": "Tools & Small Equipment", "type": "expense", "detail_type": "expense"},
            {"code": "6400", "name": "Office Rent", "type": "expense", "detail_type": "expense"},
            {"code": "6500", "name": "Licenses & Permits", "type": "expense", "detail_type": "expense"},
            {"code": "6800", "name": "Bank & Merchant Fees", "type": "expense", "detail_type": "expense"},
            {"code": "6900", "name": "Insurance - Liability & Workers Comp", "type": "expense", "detail_type": "expense"},
            {"code": "4999", "name": "Uncategorized Income", "type": "income", "detail_type": "income"},
            {"code": "6999", "name": "Uncategorized Expense", "type": "expense", "detail_type": "expense"},
        ],
    },
    "generic": {
        "label": "Other (Generic)",
        "icon": "📦",
        "accounts": [
            {"code": "1000", "name": "Cash", "type": "asset", "detail_type": "bank"},
            {"code": "1100", "name": "Accounts Receivable", "type": "asset", "detail_type": "accounts_receivable"},
            {"code": "2000", "name": "Accounts Payable", "type": "liability", "detail_type": "accounts_payable"},
            {"code": "2100", "name": "Credit Card Payable", "type": "liability", "detail_type": "credit_card"},
            {"code": "3000", "name": "Owner's Equity", "type": "equity"},
            {"code": "3100", "name": "Owner's Draw", "type": "equity"},
            {"code": "4000", "name": "Sales", "type": "income", "detail_type": "income"},
            {"code": "5000", "name": "Cost of Goods Sold", "type": "expense", "detail_type": "cost_of_goods_sold"},
            {"code": "6100", "name": "Salaries & Wages", "type": "expense", "detail_type": "expense"},
            {"code": "6200", "name": "Rent", "type": "expense", "detail_type": "expense"},
            {"code": "6210", "name": "Utilities", "type": "expense", "detail_type": "expense"},
            {"code": "6300", "name": "Software & Subscriptions", "type": "expense", "detail_type": "expense"},
            {"code": "6400", "name": "Meals - Business", "type": "expense", "detail_type": "expense"},
            {"code": "6500", "name": "Travel", "type": "expense", "detail_type": "expense"},
            {"code": "6600", "name": "Office Supplies", "type": "expense", "detail_type": "expense"},
            {"code": "6700", "name": "Marketing & Advertising", "type": "expense", "detail_type": "expense"},
            {"code": "6800", "name": "Bank & Merchant Fees", "type": "expense", "detail_type": "expense"},
            {"code": "6900", "name": "Insurance", "type": "expense", "detail_type": "expense"},
            {"code": "4999", "name": "Uncategorized Income", "type": "income", "detail_type": "income"},
            {"code": "6999", "name": "Uncategorized Expense", "type": "expense", "detail_type": "expense"},
        ],
    },
}


def list_templates() -> list[dict]:
    """Return summary metadata for the industry picker UI."""
    return [
        {"slug": slug, "label": t["label"], "icon": t["icon"], "account_count": len(t["accounts"])}
        for slug, t in TEMPLATES.items()
    ]


def get_template(slug: str) -> dict | None:
    return TEMPLATES.get(slug)


# ---------------------------------------------------------------------
# Onboarding-switch cleanup helpers
# ---------------------------------------------------------------------
# When a user changes industries during setup (before any transactions
# exist), we selectively remove CoA accounts that were seeded for the
# old industry but are NOT part of the new one. `generic` is treated
# as the shared baseline — any code that appears in `generic` is
# considered "core GAAP" and never eligible for removal, even when
# it also happens to appear in an industry template.

_BASELINE_SLUG = "generic"


def industry_only_codes(slug: str) -> set[str]:
    """Return the set of account codes that are UNIQUE to the given
    industry template (i.e. in the template but NOT in the generic
    baseline). These are the accounts that make sense to remove when
    switching industries during onboarding.
    """
    tpl = TEMPLATES.get(slug)
    if not tpl:
        return set()
    baseline = {a["code"] for a in TEMPLATES.get(_BASELINE_SLUG, {}).get("accounts", [])}
    return {a["code"] for a in tpl["accounts"]} - baseline


def template_codes(slug: str) -> set[str]:
    """All codes in a given template (including baseline overlap)."""
    tpl = TEMPLATES.get(slug)
    if not tpl:
        return set()
    return {a["code"] for a in tpl["accounts"]}
