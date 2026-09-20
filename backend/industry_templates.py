"""Industry-specific Chart of Accounts templates.

Each template is a curated CoA that maps cleanly to Schedule C / 1120S /
1065 tax lines. Seeded once during onboarding when the CPA picks an
industry. Used by BOTH categorization modes:
  * Standard: constrains the account universe for PFC + Rules + LLM cascade
  * AI-First: same, plus feeds into the LLM prompt as target space

The five foundation templates (professional_services, restaurant,
ecommerce, construction, generic) are hand-authored. The remaining
industries are composed from shared building blocks + a smaller set of
industry-specific accounts to keep the file readable while giving each
industry ~30-40 accounts (QBO-equivalent depth).
"""

# ---------------------------------------------------------------------
# Shared building blocks for composed templates
# ---------------------------------------------------------------------

_COMMON_ASSETS = [
    {"code": "1000", "name": "Cash", "type": "asset", "detail_type": "bank"},
    {"code": "1010", "name": "Cash Clearing", "type": "asset", "detail_type": "bank"},
    {"code": "1100", "name": "Accounts Receivable", "type": "asset", "detail_type": "accounts_receivable"},
    {"code": "1200", "name": "Prepaid Expenses", "type": "asset", "detail_type": "other_current_asset"},
]

_COMMON_LIABILITIES = [
    {"code": "2000", "name": "Accounts Payable", "type": "liability", "detail_type": "accounts_payable"},
    {"code": "2100", "name": "Credit Card Payable", "type": "liability", "detail_type": "credit_card"},
    {"code": "2200", "name": "Sales Tax Payable", "type": "liability", "detail_type": "other_current_liability"},
    {"code": "2210", "name": "Payroll Liabilities", "type": "liability", "detail_type": "other_current_liability"},
]

_COMMON_EQUITY = [
    {"code": "3000", "name": "Owner's Equity", "type": "equity"},
    {"code": "3100", "name": "Owner's Draw", "type": "equity"},
    {"code": "3200", "name": "Retained Earnings", "type": "equity"},
]

_COMMON_PAYROLL_OPEX = [
    {"code": "6100", "name": "Salaries & Wages", "type": "expense", "detail_type": "expense"},
    {"code": "6110", "name": "Payroll Taxes", "type": "expense", "detail_type": "expense"},
    {"code": "6120", "name": "Employee Benefits", "type": "expense", "detail_type": "expense"},
    {"code": "6130", "name": "Contract Labor", "type": "expense", "detail_type": "expense"},
]

_COMMON_FACILITIES_OPEX = [
    {"code": "6200", "name": "Rent", "type": "expense", "detail_type": "expense"},
    {"code": "6210", "name": "Utilities", "type": "expense", "detail_type": "expense"},
    {"code": "6220", "name": "Internet & Phone", "type": "expense", "detail_type": "expense"},
]

_COMMON_ADMIN_OPEX = [
    {"code": "6300", "name": "Software & Subscriptions", "type": "expense", "detail_type": "expense"},
    {"code": "6400", "name": "Meals - Business", "type": "expense", "detail_type": "expense"},
    {"code": "6500", "name": "Travel", "type": "expense", "detail_type": "expense"},
    {"code": "6600", "name": "Office Supplies", "type": "expense", "detail_type": "expense"},
    {"code": "6700", "name": "Marketing & Advertising", "type": "expense", "detail_type": "expense"},
    {"code": "6800", "name": "Bank & Merchant Fees", "type": "expense", "detail_type": "expense"},
    {"code": "6810", "name": "Legal & Professional Fees", "type": "expense", "detail_type": "expense"},
    {"code": "6820", "name": "Accounting Fees", "type": "expense", "detail_type": "expense"},
    {"code": "6900", "name": "Insurance", "type": "expense", "detail_type": "expense"},
    {"code": "6910", "name": "Depreciation", "type": "expense", "detail_type": "expense"},
]

_UNCATEGORIZED_PAIR = [
    {"code": "4999", "name": "Uncategorized Income", "type": "income", "detail_type": "income"},
    {"code": "6999", "name": "Uncategorized Expense", "type": "expense", "detail_type": "expense"},
]


def _tpl(label: str, icon: str, *sections) -> dict:
    """Compose a template from shared blocks + industry-specific extras.

    Later sections win — but duplicate `code`s from earlier sections are
    kept (first-wins) so the shared blocks anchor code numbering. Each
    section is a plain list of account dicts.
    """
    seen: set[str] = set()
    accounts: list[dict] = []
    for section in sections:
        for a in section:
            if a["code"] in seen:
                continue
            seen.add(a["code"])
            accounts.append(a)
    return {"label": label, "icon": icon, "accounts": accounts}


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
            {"code": "1010", "name": "Payment Processor Clearing", "type": "asset", "detail_type": "bank"},
            {"code": "1100", "name": "Accounts Receivable", "type": "asset", "detail_type": "accounts_receivable"},
            {"code": "1300", "name": "Inventory", "type": "asset", "detail_type": "inventory_asset"},
            {"code": "1500", "name": "Warehouse Equipment", "type": "asset", "detail_type": "fixed_asset"},
            {"code": "2000", "name": "Accounts Payable", "type": "liability", "detail_type": "accounts_payable"},
            {"code": "2100", "name": "Credit Card Payable", "type": "liability", "detail_type": "credit_card"},
            {"code": "2200", "name": "Sales Tax Payable", "type": "liability", "detail_type": "other_current_liability"},
            {"code": "3000", "name": "Owner's Equity", "type": "equity"},
            {"code": "3100", "name": "Owner's Draw", "type": "equity"},
            {"code": "4000", "name": "Product Sales", "type": "income", "detail_type": "income"},
            {"code": "4100", "name": "Shipping Revenue", "type": "income", "detail_type": "income"},
            {"code": "4200", "name": "Wholesale Revenue", "type": "income", "detail_type": "income"},
            {"code": "4300", "name": "Returns & Allowances", "type": "income", "detail_type": "income"},
            {"code": "5000", "name": "Cost of Goods Sold", "type": "expense", "detail_type": "cost_of_goods_sold"},
            {"code": "5100", "name": "Shipping Costs (COGS)", "type": "expense", "detail_type": "cost_of_goods_sold"},
            {"code": "5200", "name": "Payment Processing Fees", "type": "expense", "detail_type": "cost_of_goods_sold"},
            {"code": "6100", "name": "Salaries & Wages", "type": "expense", "detail_type": "expense"},
            {"code": "6110", "name": "Payroll Taxes", "type": "expense", "detail_type": "expense"},
            {"code": "6200", "name": "Rent - Warehouse", "type": "expense", "detail_type": "expense"},
            {"code": "6300", "name": "E-commerce Platform Fees", "type": "expense", "detail_type": "expense"},
            {"code": "6400", "name": "Marketing & Advertising", "type": "expense", "detail_type": "expense"},
            {"code": "6500", "name": "Software & Subscriptions", "type": "expense", "detail_type": "expense"},
            {"code": "6600", "name": "Packaging Supplies", "type": "expense", "detail_type": "expense"},
            {"code": "6700", "name": "Insurance", "type": "expense", "detail_type": "expense"},
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
            {"code": "1150", "name": "Retention Receivable", "type": "asset", "detail_type": "accounts_receivable"},
            {"code": "1300", "name": "Job Materials Inventory", "type": "asset", "detail_type": "inventory_asset"},
            {"code": "1500", "name": "Trucks & Vehicles", "type": "asset", "detail_type": "fixed_asset"},
            {"code": "1510", "name": "Tools & Equipment", "type": "asset", "detail_type": "fixed_asset"},
            {"code": "2000", "name": "Accounts Payable", "type": "liability", "detail_type": "accounts_payable"},
            {"code": "2100", "name": "Credit Card Payable", "type": "liability", "detail_type": "credit_card"},
            {"code": "2200", "name": "Customer Deposits", "type": "liability", "detail_type": "other_current_liability"},
            {"code": "2210", "name": "Payroll Liabilities", "type": "liability", "detail_type": "other_current_liability"},
            {"code": "3000", "name": "Owner's Equity", "type": "equity"},
            {"code": "3100", "name": "Owner's Draw", "type": "equity"},
            {"code": "4000", "name": "Contract Revenue", "type": "income", "detail_type": "income"},
            {"code": "4100", "name": "Change Order Revenue", "type": "income", "detail_type": "income"},
            {"code": "4200", "name": "Service & Repair Revenue", "type": "income", "detail_type": "income"},
            {"code": "5000", "name": "Job Materials (COGS)", "type": "expense", "detail_type": "cost_of_goods_sold"},
            {"code": "5100", "name": "Subcontractor Labor (COGS)", "type": "expense", "detail_type": "cost_of_goods_sold"},
            {"code": "5200", "name": "Direct Job Labor (COGS)", "type": "expense", "detail_type": "cost_of_goods_sold"},
            {"code": "5300", "name": "Equipment Rental (COGS)", "type": "expense", "detail_type": "cost_of_goods_sold"},
            {"code": "6100", "name": "Salaries - Office", "type": "expense", "detail_type": "expense"},
            {"code": "6110", "name": "Payroll Taxes", "type": "expense", "detail_type": "expense"},
            {"code": "6200", "name": "Vehicle Fuel & Maintenance", "type": "expense", "detail_type": "expense"},
            {"code": "6300", "name": "Insurance - Liability & WC", "type": "expense", "detail_type": "expense"},
            {"code": "6400", "name": "Permits & Fees", "type": "expense", "detail_type": "expense"},
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
            {"code": "1200", "name": "Prepaid Expenses", "type": "asset", "detail_type": "other_current_asset"},
            {"code": "1500", "name": "Fixed Assets", "type": "asset", "detail_type": "fixed_asset"},
            {"code": "2000", "name": "Accounts Payable", "type": "liability", "detail_type": "accounts_payable"},
            {"code": "2100", "name": "Credit Card Payable", "type": "liability", "detail_type": "credit_card"},
            {"code": "3000", "name": "Owner's Equity", "type": "equity"},
            {"code": "3100", "name": "Owner's Draw", "type": "equity"},
            {"code": "3200", "name": "Retained Earnings", "type": "equity"},
            {"code": "4000", "name": "Revenue", "type": "income", "detail_type": "income"},
            {"code": "6100", "name": "Salaries & Wages", "type": "expense", "detail_type": "expense"},
            {"code": "6110", "name": "Payroll Taxes", "type": "expense", "detail_type": "expense"},
            {"code": "6200", "name": "Rent", "type": "expense", "detail_type": "expense"},
            {"code": "6210", "name": "Utilities", "type": "expense", "detail_type": "expense"},
            {"code": "6300", "name": "Software & Subscriptions", "type": "expense", "detail_type": "expense"},
            {"code": "6600", "name": "Office Supplies", "type": "expense", "detail_type": "expense"},
            {"code": "6700", "name": "Marketing & Advertising", "type": "expense", "detail_type": "expense"},
            {"code": "6800", "name": "Bank & Merchant Fees", "type": "expense", "detail_type": "expense"},
            {"code": "4999", "name": "Uncategorized Income", "type": "income", "detail_type": "income"},
            {"code": "6999", "name": "Uncategorized Expense", "type": "expense", "detail_type": "expense"},
        ],
    },

    # -----------------------------------------------------------------
    # Composed industry templates (QBO-equivalent depth)
    # -----------------------------------------------------------------

    "advertising": _tpl(
        "Advertising", "📣",
        _COMMON_ASSETS,
        [{"code": "1250", "name": "Prepaid Media Buys", "type": "asset", "detail_type": "other_current_asset"},
         {"code": "1500", "name": "Office Equipment", "type": "asset", "detail_type": "fixed_asset"}],
        _COMMON_LIABILITIES,
        [{"code": "2400", "name": "Deferred Revenue - Retainers", "type": "liability", "detail_type": "other_current_liability"}],
        _COMMON_EQUITY,
        [{"code": "4000", "name": "Media Buying Revenue", "type": "income", "detail_type": "income"},
         {"code": "4100", "name": "Creative Services Revenue", "type": "income", "detail_type": "income"},
         {"code": "4200", "name": "Retainer Revenue", "type": "income", "detail_type": "income"},
         {"code": "4300", "name": "Commissions Earned", "type": "income", "detail_type": "income"},
         {"code": "5000", "name": "Media Pass-through Cost", "type": "expense", "detail_type": "cost_of_goods_sold"},
         {"code": "5100", "name": "Creative Production Cost", "type": "expense", "detail_type": "cost_of_goods_sold"},
         {"code": "5200", "name": "Stock Media Licenses", "type": "expense", "detail_type": "cost_of_goods_sold"}],
        _COMMON_PAYROLL_OPEX, _COMMON_FACILITIES_OPEX, _COMMON_ADMIN_OPEX,
        [{"code": "6420", "name": "Client Entertainment", "type": "expense", "detail_type": "expense"}],
        _UNCATEGORIZED_PAIR,
    ),

    "agriculture": _tpl(
        "Agriculture & Farming", "🌾",
        _COMMON_ASSETS,
        [{"code": "1300", "name": "Crop Inventory", "type": "asset", "detail_type": "inventory_asset"},
         {"code": "1310", "name": "Livestock Inventory", "type": "asset", "detail_type": "inventory_asset"},
         {"code": "1320", "name": "Feed Inventory", "type": "asset", "detail_type": "inventory_asset"},
         {"code": "1330", "name": "Seed & Fertilizer Inventory", "type": "asset", "detail_type": "inventory_asset"},
         {"code": "1500", "name": "Farm Equipment", "type": "asset", "detail_type": "fixed_asset"},
         {"code": "1510", "name": "Farm Vehicles", "type": "asset", "detail_type": "fixed_asset"},
         {"code": "1520", "name": "Land", "type": "asset", "detail_type": "fixed_asset"}],
        _COMMON_LIABILITIES,
        [{"code": "2300", "name": "Farm Loans Payable", "type": "liability", "detail_type": "other_current_liability"}],
        _COMMON_EQUITY,
        [{"code": "4000", "name": "Crop Sales", "type": "income", "detail_type": "income"},
         {"code": "4100", "name": "Livestock Sales", "type": "income", "detail_type": "income"},
         {"code": "4200", "name": "Government Program Payments", "type": "income", "detail_type": "income"},
         {"code": "4300", "name": "Custom Hire Income", "type": "income", "detail_type": "income"},
         {"code": "5000", "name": "Seed Cost (COGS)", "type": "expense", "detail_type": "cost_of_goods_sold"},
         {"code": "5100", "name": "Fertilizer & Chemicals (COGS)", "type": "expense", "detail_type": "cost_of_goods_sold"},
         {"code": "5200", "name": "Feed Cost (COGS)", "type": "expense", "detail_type": "cost_of_goods_sold"},
         {"code": "5300", "name": "Veterinary Supplies (COGS)", "type": "expense", "detail_type": "cost_of_goods_sold"}],
        _COMMON_PAYROLL_OPEX,
        [{"code": "6230", "name": "Fuel - Farm", "type": "expense", "detail_type": "expense"},
         {"code": "6250", "name": "Repairs - Farm Equipment", "type": "expense", "detail_type": "expense"},
         {"code": "6260", "name": "Custom Hire Expense", "type": "expense", "detail_type": "expense"},
         {"code": "6270", "name": "Storage & Warehousing", "type": "expense", "detail_type": "expense"},
         {"code": "6280", "name": "Freight & Trucking", "type": "expense", "detail_type": "expense"}],
        _COMMON_FACILITIES_OPEX, _COMMON_ADMIN_OPEX,
        [{"code": "6920", "name": "Crop / Livestock Insurance", "type": "expense", "detail_type": "expense"}],
        _UNCATEGORIZED_PAIR,
    ),

    "fintech": _tpl(
        "Fintech", "💳",
        _COMMON_ASSETS,
        [{"code": "1150", "name": "Customer Funds Held (Restricted)", "type": "asset", "detail_type": "other_current_asset"},
         {"code": "1500", "name": "Computers & Equipment", "type": "asset", "detail_type": "fixed_asset"},
         {"code": "1550", "name": "Capitalized Software", "type": "asset", "detail_type": "fixed_asset"}],
        _COMMON_LIABILITIES,
        [{"code": "2400", "name": "Customer Funds Payable", "type": "liability", "detail_type": "other_current_liability"},
         {"code": "2500", "name": "Deferred Revenue - Subscriptions", "type": "liability", "detail_type": "other_current_liability"}],
        _COMMON_EQUITY,
        [{"code": "4000", "name": "Transaction Fee Revenue", "type": "income", "detail_type": "income"},
         {"code": "4100", "name": "Subscription Revenue", "type": "income", "detail_type": "income"},
         {"code": "4200", "name": "Interchange Revenue", "type": "income", "detail_type": "income"},
         {"code": "4300", "name": "Interest Income", "type": "income", "detail_type": "income"},
         {"code": "5000", "name": "Payment Processing Costs (COGS)", "type": "expense", "detail_type": "cost_of_goods_sold"},
         {"code": "5100", "name": "Hosting & Infrastructure (COGS)", "type": "expense", "detail_type": "cost_of_goods_sold"},
         {"code": "5200", "name": "Card Issuance Costs (COGS)", "type": "expense", "detail_type": "cost_of_goods_sold"}],
        _COMMON_PAYROLL_OPEX, _COMMON_FACILITIES_OPEX, _COMMON_ADMIN_OPEX,
        [{"code": "6830", "name": "Compliance & Regulatory Fees", "type": "expense", "detail_type": "expense"},
         {"code": "6840", "name": "Fraud Losses", "type": "expense", "detail_type": "expense"}],
        _UNCATEGORIZED_PAIR,
    ),

    "fintech_crypto": _tpl(
        "Fintech — Crypto", "🪙",
        [{"code": "1000", "name": "Fiat Cash", "type": "asset", "detail_type": "bank"},
         {"code": "1010", "name": "Cash Clearing", "type": "asset", "detail_type": "bank"},
         {"code": "1020", "name": "Crypto Assets - BTC", "type": "asset", "detail_type": "other_current_asset"},
         {"code": "1030", "name": "Crypto Assets - ETH", "type": "asset", "detail_type": "other_current_asset"},
         {"code": "1040", "name": "Crypto Assets - Other", "type": "asset", "detail_type": "other_current_asset"},
         {"code": "1050", "name": "Stablecoin Holdings", "type": "asset", "detail_type": "other_current_asset"},
         {"code": "1100", "name": "Accounts Receivable", "type": "asset", "detail_type": "accounts_receivable"},
         {"code": "1150", "name": "Customer Crypto Held (Restricted)", "type": "asset", "detail_type": "other_current_asset"},
         {"code": "1200", "name": "Prepaid Expenses", "type": "asset", "detail_type": "other_current_asset"}],
        _COMMON_LIABILITIES,
        [{"code": "2400", "name": "Customer Crypto Payable", "type": "liability", "detail_type": "other_current_liability"}],
        _COMMON_EQUITY,
        [{"code": "4000", "name": "Trading Revenue", "type": "income", "detail_type": "income"},
         {"code": "4100", "name": "Staking Rewards", "type": "income", "detail_type": "income"},
         {"code": "4200", "name": "Custody / Wallet Fees", "type": "income", "detail_type": "income"},
         {"code": "4300", "name": "Mining Income", "type": "income", "detail_type": "income"},
         {"code": "4400", "name": "Realized Gain on Crypto", "type": "income", "detail_type": "other_income"},
         {"code": "5000", "name": "Trading Fees Paid (COGS)", "type": "expense", "detail_type": "cost_of_goods_sold"},
         {"code": "5100", "name": "Gas / Network Fees (COGS)", "type": "expense", "detail_type": "cost_of_goods_sold"},
         {"code": "5200", "name": "Bridging & Swap Fees (COGS)", "type": "expense", "detail_type": "cost_of_goods_sold"}],
        _COMMON_PAYROLL_OPEX, _COMMON_FACILITIES_OPEX, _COMMON_ADMIN_OPEX,
        [{"code": "6830", "name": "Compliance & Legal - Crypto", "type": "expense", "detail_type": "expense"},
         {"code": "6850", "name": "Realized Loss on Crypto", "type": "expense", "detail_type": "expense"},
         {"code": "6860", "name": "Impairment Loss on Crypto", "type": "expense", "detail_type": "expense"}],
        _UNCATEGORIZED_PAIR,
    ),

    "healthcare": _tpl(
        "Healthcare", "🩺",
        [{"code": "1000", "name": "Cash", "type": "asset", "detail_type": "bank"},
         {"code": "1010", "name": "Cash Clearing", "type": "asset", "detail_type": "bank"},
         {"code": "1100", "name": "AR - Insurance", "type": "asset", "detail_type": "accounts_receivable"},
         {"code": "1110", "name": "AR - Patient", "type": "asset", "detail_type": "accounts_receivable"},
         {"code": "1200", "name": "Prepaid Expenses", "type": "asset", "detail_type": "other_current_asset"},
         {"code": "1300", "name": "Medical Supplies Inventory", "type": "asset", "detail_type": "inventory_asset"},
         {"code": "1310", "name": "Pharmacy Inventory", "type": "asset", "detail_type": "inventory_asset"},
         {"code": "1500", "name": "Medical Equipment", "type": "asset", "detail_type": "fixed_asset"},
         {"code": "1510", "name": "Office Equipment", "type": "asset", "detail_type": "fixed_asset"}],
        _COMMON_LIABILITIES,
        [{"code": "2400", "name": "Patient Credit Balances", "type": "liability", "detail_type": "other_current_liability"}],
        _COMMON_EQUITY,
        [{"code": "4000", "name": "Patient Revenue - Cash Pay", "type": "income", "detail_type": "income"},
         {"code": "4100", "name": "Insurance Reimbursement", "type": "income", "detail_type": "income"},
         {"code": "4200", "name": "Copay & Deductible Income", "type": "income", "detail_type": "income"},
         {"code": "4300", "name": "Ancillary Services Revenue", "type": "income", "detail_type": "income"},
         {"code": "5000", "name": "Medical Supplies (COGS)", "type": "expense", "detail_type": "cost_of_goods_sold"},
         {"code": "5100", "name": "Pharmacy Dispensing Cost (COGS)", "type": "expense", "detail_type": "cost_of_goods_sold"},
         {"code": "5200", "name": "Lab & Diagnostic Costs (COGS)", "type": "expense", "detail_type": "cost_of_goods_sold"}],
        _COMMON_PAYROLL_OPEX, _COMMON_FACILITIES_OPEX, _COMMON_ADMIN_OPEX,
        [{"code": "6920", "name": "Medical Malpractice Insurance", "type": "expense", "detail_type": "expense"},
         {"code": "6930", "name": "Continuing Education", "type": "expense", "detail_type": "expense"},
         {"code": "6940", "name": "Medical Licenses & Dues", "type": "expense", "detail_type": "expense"},
         {"code": "6950", "name": "Biohazard Waste Disposal", "type": "expense", "detail_type": "expense"}],
        _UNCATEGORIZED_PAIR,
    ),

    "home_services": _tpl(
        "Home Services", "🔧",
        _COMMON_ASSETS,
        [{"code": "1300", "name": "Materials Inventory", "type": "asset", "detail_type": "inventory_asset"},
         {"code": "1500", "name": "Service Vehicles", "type": "asset", "detail_type": "fixed_asset"},
         {"code": "1510", "name": "Tools & Equipment", "type": "asset", "detail_type": "fixed_asset"}],
        _COMMON_LIABILITIES,
        [{"code": "2400", "name": "Customer Deposits", "type": "liability", "detail_type": "other_current_liability"}],
        _COMMON_EQUITY,
        [{"code": "4000", "name": "Service Revenue - Residential", "type": "income", "detail_type": "income"},
         {"code": "4100", "name": "Service Revenue - Commercial", "type": "income", "detail_type": "income"},
         {"code": "4200", "name": "Parts & Product Revenue", "type": "income", "detail_type": "income"},
         {"code": "4300", "name": "Warranty & Service Plan Revenue", "type": "income", "detail_type": "income"},
         {"code": "5000", "name": "Materials & Parts (COGS)", "type": "expense", "detail_type": "cost_of_goods_sold"},
         {"code": "5100", "name": "Subcontractor Labor (COGS)", "type": "expense", "detail_type": "cost_of_goods_sold"},
         {"code": "5200", "name": "Vehicle Fuel - Job (COGS)", "type": "expense", "detail_type": "cost_of_goods_sold"}],
        _COMMON_PAYROLL_OPEX, _COMMON_FACILITIES_OPEX, _COMMON_ADMIN_OPEX,
        [{"code": "6440", "name": "Uniforms & Safety Gear", "type": "expense", "detail_type": "expense"},
         {"code": "6450", "name": "Tools & Small Equipment", "type": "expense", "detail_type": "expense"}],
        _UNCATEGORIZED_PAIR,
    ),

    "legal": _tpl(
        "Legal", "⚖️",
        [{"code": "1000", "name": "Cash - Operating", "type": "asset", "detail_type": "bank"},
         {"code": "1005", "name": "Cash - IOLTA / Trust", "type": "asset", "detail_type": "bank"},
         {"code": "1010", "name": "Cash Clearing", "type": "asset", "detail_type": "bank"},
         {"code": "1100", "name": "Accounts Receivable", "type": "asset", "detail_type": "accounts_receivable"},
         {"code": "1150", "name": "Unbilled Work in Progress", "type": "asset", "detail_type": "accounts_receivable"},
         {"code": "1160", "name": "Client Case Advances", "type": "asset", "detail_type": "other_current_asset"},
         {"code": "1200", "name": "Prepaid Expenses", "type": "asset", "detail_type": "other_current_asset"},
         {"code": "1500", "name": "Office Equipment", "type": "asset", "detail_type": "fixed_asset"}],
        _COMMON_LIABILITIES,
        [{"code": "2400", "name": "Client Funds Held (IOLTA)", "type": "liability", "detail_type": "other_current_liability"},
         {"code": "2410", "name": "Retainer Deposits Held", "type": "liability", "detail_type": "customer_prepayments"}],
        _COMMON_EQUITY,
        [{"code": "4000", "name": "Legal Fees - Billable Hours", "type": "income", "detail_type": "income"},
         {"code": "4100", "name": "Contingency Fee Revenue", "type": "income", "detail_type": "income"},
         {"code": "4200", "name": "Flat Fee Revenue", "type": "income", "detail_type": "income"},
         {"code": "4300", "name": "Retainer Draws", "type": "income", "detail_type": "income"}],
        _COMMON_PAYROLL_OPEX, _COMMON_FACILITIES_OPEX, _COMMON_ADMIN_OPEX,
        [{"code": "6830", "name": "Bar Association Dues", "type": "expense", "detail_type": "expense"},
         {"code": "6840", "name": "Continuing Legal Education (CLE)", "type": "expense", "detail_type": "expense"},
         {"code": "6850", "name": "Case Filing Fees", "type": "expense", "detail_type": "expense"},
         {"code": "6860", "name": "Court Reporter Fees", "type": "expense", "detail_type": "expense"},
         {"code": "6870", "name": "Legal Research Subscriptions", "type": "expense", "detail_type": "expense"},
         {"code": "6920", "name": "Malpractice Insurance", "type": "expense", "detail_type": "expense"}],
        _UNCATEGORIZED_PAIR,
    ),

    "manufacturing": _tpl(
        "Manufacturing", "🏭",
        _COMMON_ASSETS,
        [{"code": "1300", "name": "Raw Materials Inventory", "type": "asset", "detail_type": "inventory_asset"},
         {"code": "1310", "name": "Work in Process (WIP)", "type": "asset", "detail_type": "inventory_asset"},
         {"code": "1320", "name": "Finished Goods Inventory", "type": "asset", "detail_type": "inventory_asset"},
         {"code": "1500", "name": "Manufacturing Equipment", "type": "asset", "detail_type": "fixed_asset"},
         {"code": "1510", "name": "Warehouse Equipment", "type": "asset", "detail_type": "fixed_asset"}],
        _COMMON_LIABILITIES,
        [{"code": "2300", "name": "Loans Payable", "type": "liability", "detail_type": "other_current_liability"}],
        _COMMON_EQUITY,
        [{"code": "4000", "name": "Product Sales", "type": "income", "detail_type": "income"},
         {"code": "4100", "name": "Custom Order Revenue", "type": "income", "detail_type": "income"},
         {"code": "4200", "name": "Scrap & Salvage Revenue", "type": "income", "detail_type": "other_income"},
         {"code": "5000", "name": "Raw Materials Used (COGS)", "type": "expense", "detail_type": "cost_of_goods_sold"},
         {"code": "5100", "name": "Direct Labor (COGS)", "type": "expense", "detail_type": "cost_of_goods_sold"},
         {"code": "5200", "name": "Manufacturing Overhead (COGS)", "type": "expense", "detail_type": "cost_of_goods_sold"},
         {"code": "5300", "name": "Freight-in (COGS)", "type": "expense", "detail_type": "cost_of_goods_sold"},
         {"code": "5400", "name": "Freight-out", "type": "expense", "detail_type": "cost_of_goods_sold"}],
        _COMMON_PAYROLL_OPEX, _COMMON_FACILITIES_OPEX, _COMMON_ADMIN_OPEX,
        [{"code": "6230", "name": "Equipment Maintenance", "type": "expense", "detail_type": "expense"},
         {"code": "6440", "name": "Quality Control", "type": "expense", "detail_type": "expense"},
         {"code": "6450", "name": "Certifications & Compliance", "type": "expense", "detail_type": "expense"}],
        _UNCATEGORIZED_PAIR,
    ),

    "media_entertainment": _tpl(
        "Media & Entertainment", "🎬",
        _COMMON_ASSETS,
        [{"code": "1300", "name": "Content Inventory (Capitalized Productions)", "type": "asset", "detail_type": "inventory_asset"},
         {"code": "1500", "name": "Production Equipment", "type": "asset", "detail_type": "fixed_asset"}],
        _COMMON_LIABILITIES,
        [{"code": "2400", "name": "Royalties Payable", "type": "liability", "detail_type": "other_current_liability"},
         {"code": "2410", "name": "Deferred Revenue - Advances", "type": "liability", "detail_type": "customer_prepayments"}],
        _COMMON_EQUITY,
        [{"code": "4000", "name": "Advertising Revenue", "type": "income", "detail_type": "income"},
         {"code": "4100", "name": "Subscription Revenue", "type": "income", "detail_type": "income"},
         {"code": "4200", "name": "Sponsorship Revenue", "type": "income", "detail_type": "income"},
         {"code": "4300", "name": "Licensing Revenue", "type": "income", "detail_type": "income"},
         {"code": "4400", "name": "Merchandise Revenue", "type": "income", "detail_type": "income"},
         {"code": "5000", "name": "Production Cost - Labor (COGS)", "type": "expense", "detail_type": "cost_of_goods_sold"},
         {"code": "5100", "name": "Production Cost - Materials (COGS)", "type": "expense", "detail_type": "cost_of_goods_sold"},
         {"code": "5200", "name": "Content Licensing Paid (COGS)", "type": "expense", "detail_type": "cost_of_goods_sold"},
         {"code": "5300", "name": "Talent Fees (COGS)", "type": "expense", "detail_type": "cost_of_goods_sold"}],
        _COMMON_PAYROLL_OPEX, _COMMON_FACILITIES_OPEX, _COMMON_ADMIN_OPEX,
        [{"code": "6440", "name": "Music & Stock Media Licenses", "type": "expense", "detail_type": "expense"},
         {"code": "6450", "name": "Distribution Platform Fees", "type": "expense", "detail_type": "expense"}],
        _UNCATEGORIZED_PAIR,
    ),

    "retail": _tpl(
        "Retail", "🛍️",
        _COMMON_ASSETS,
        [{"code": "1300", "name": "Merchandise Inventory - Store", "type": "asset", "detail_type": "inventory_asset"},
         {"code": "1310", "name": "Merchandise Inventory - Warehouse", "type": "asset", "detail_type": "inventory_asset"},
         {"code": "1320", "name": "Inventory Reserve - Damaged", "type": "asset", "detail_type": "inventory_asset"},
         {"code": "1500", "name": "POS Equipment", "type": "asset", "detail_type": "fixed_asset"},
         {"code": "1510", "name": "Store Fixtures", "type": "asset", "detail_type": "fixed_asset"}],
        _COMMON_LIABILITIES,
        [{"code": "2400", "name": "Gift Card Liability", "type": "liability", "detail_type": "customer_prepayments"},
         {"code": "2410", "name": "Customer Deposits", "type": "liability", "detail_type": "customer_prepayments"}],
        _COMMON_EQUITY,
        [{"code": "4000", "name": "Retail Sales - Storefront", "type": "income", "detail_type": "income"},
         {"code": "4100", "name": "Retail Sales - Online", "type": "income", "detail_type": "income"},
         {"code": "4200", "name": "Wholesale Revenue", "type": "income", "detail_type": "income"},
         {"code": "4300", "name": "Returns & Allowances", "type": "income", "detail_type": "income"},
         {"code": "5000", "name": "Cost of Goods Sold", "type": "expense", "detail_type": "cost_of_goods_sold"},
         {"code": "5100", "name": "Freight-in (COGS)", "type": "expense", "detail_type": "cost_of_goods_sold"},
         {"code": "5200", "name": "Inventory Shrinkage (COGS)", "type": "expense", "detail_type": "cost_of_goods_sold"}],
        _COMMON_PAYROLL_OPEX, _COMMON_FACILITIES_OPEX, _COMMON_ADMIN_OPEX,
        [{"code": "6440", "name": "POS Software & Subscriptions", "type": "expense", "detail_type": "expense"},
         {"code": "6450", "name": "Store Supplies", "type": "expense", "detail_type": "expense"},
         {"code": "6830", "name": "Credit Card Processing Fees", "type": "expense", "detail_type": "expense"}],
        _UNCATEGORIZED_PAIR,
    ),

    "real_estate": _tpl(
        "Real Estate", "🏘️",
        [{"code": "1000", "name": "Cash - Operating", "type": "asset", "detail_type": "bank"},
         {"code": "1005", "name": "Cash - Security Deposit Trust", "type": "asset", "detail_type": "bank"},
         {"code": "1010", "name": "Cash Clearing", "type": "asset", "detail_type": "bank"},
         {"code": "1100", "name": "AR - Rent", "type": "asset", "detail_type": "accounts_receivable"},
         {"code": "1200", "name": "Prepaid Property Tax & Insurance", "type": "asset", "detail_type": "other_current_asset"},
         {"code": "1500", "name": "Buildings", "type": "asset", "detail_type": "fixed_asset"},
         {"code": "1510", "name": "Land", "type": "asset", "detail_type": "fixed_asset"},
         {"code": "1520", "name": "Furniture & Appliances", "type": "asset", "detail_type": "fixed_asset"}],
        _COMMON_LIABILITIES,
        [{"code": "2400", "name": "Security Deposits Held", "type": "liability", "detail_type": "customer_prepayments"},
         {"code": "2410", "name": "Prepaid Rent Liability", "type": "liability", "detail_type": "customer_prepayments"},
         {"code": "2500", "name": "Mortgages Payable", "type": "liability", "detail_type": "loan_and_line_of_credit"}],
        _COMMON_EQUITY,
        [{"code": "4000", "name": "Rental Income - Residential", "type": "income", "detail_type": "income"},
         {"code": "4100", "name": "Rental Income - Commercial", "type": "income", "detail_type": "income"},
         {"code": "4200", "name": "Late Fees", "type": "income", "detail_type": "income"},
         {"code": "4300", "name": "Application Fees", "type": "income", "detail_type": "income"},
         {"code": "4400", "name": "Property Management Fees Earned", "type": "income", "detail_type": "income"}],
        _COMMON_PAYROLL_OPEX, _COMMON_FACILITIES_OPEX, _COMMON_ADMIN_OPEX,
        [{"code": "6230", "name": "Property Tax", "type": "expense", "detail_type": "expense"},
         {"code": "6240", "name": "HOA Dues", "type": "expense", "detail_type": "expense"},
         {"code": "6250", "name": "Repairs - Property", "type": "expense", "detail_type": "expense"},
         {"code": "6260", "name": "Maintenance - Property", "type": "expense", "detail_type": "expense"},
         {"code": "6270", "name": "Landscaping", "type": "expense", "detail_type": "expense"},
         {"code": "6920", "name": "Property Insurance", "type": "expense", "detail_type": "expense"}],
        _UNCATEGORIZED_PAIR,
    ),

    "saas": _tpl(
        "SaaS", "☁️",
        _COMMON_ASSETS,
        [{"code": "1250", "name": "Deferred Implementation Costs", "type": "asset", "detail_type": "other_current_asset"},
         {"code": "1500", "name": "Computers & Equipment", "type": "asset", "detail_type": "fixed_asset"},
         {"code": "1550", "name": "Capitalized Software (Internal Use)", "type": "asset", "detail_type": "fixed_asset"}],
        _COMMON_LIABILITIES,
        [{"code": "2400", "name": "Deferred Revenue - Subscription", "type": "liability", "detail_type": "customer_prepayments"},
         {"code": "2410", "name": "Deferred Revenue - Setup", "type": "liability", "detail_type": "customer_prepayments"}],
        _COMMON_EQUITY,
        [{"code": "4000", "name": "Subscription Revenue - Monthly", "type": "income", "detail_type": "income"},
         {"code": "4100", "name": "Subscription Revenue - Annual", "type": "income", "detail_type": "income"},
         {"code": "4200", "name": "Setup / Onboarding Fees", "type": "income", "detail_type": "income"},
         {"code": "4300", "name": "Professional Services Revenue", "type": "income", "detail_type": "income"},
         {"code": "4400", "name": "Usage / Overage Revenue", "type": "income", "detail_type": "income"},
         {"code": "5000", "name": "Hosting & Infrastructure (COGS)", "type": "expense", "detail_type": "cost_of_goods_sold"},
         {"code": "5100", "name": "Third-Party API Costs (COGS)", "type": "expense", "detail_type": "cost_of_goods_sold"},
         {"code": "5200", "name": "Customer Success Labor (COGS)", "type": "expense", "detail_type": "cost_of_goods_sold"},
         {"code": "5300", "name": "Payment Processing (COGS)", "type": "expense", "detail_type": "cost_of_goods_sold"}],
        _COMMON_PAYROLL_OPEX, _COMMON_FACILITIES_OPEX, _COMMON_ADMIN_OPEX,
        [{"code": "6440", "name": "Developer Tools & Licenses", "type": "expense", "detail_type": "expense"},
         {"code": "6450", "name": "Sales Commissions", "type": "expense", "detail_type": "expense"}],
        _UNCATEGORIZED_PAIR,
    ),

    "transportation": _tpl(
        "Transportation", "🚚",
        _COMMON_ASSETS,
        [{"code": "1300", "name": "Fuel Inventory", "type": "asset", "detail_type": "inventory_asset"},
         {"code": "1310", "name": "Parts & Tires Inventory", "type": "asset", "detail_type": "inventory_asset"},
         {"code": "1500", "name": "Fleet Vehicles", "type": "asset", "detail_type": "fixed_asset"},
         {"code": "1510", "name": "Trailers", "type": "asset", "detail_type": "fixed_asset"}],
        _COMMON_LIABILITIES,
        [{"code": "2400", "name": "Fuel Card Liability", "type": "liability", "detail_type": "credit_card"},
         {"code": "2500", "name": "Vehicle Loans Payable", "type": "liability", "detail_type": "loan_and_line_of_credit"}],
        _COMMON_EQUITY,
        [{"code": "4000", "name": "Freight Revenue", "type": "income", "detail_type": "income"},
         {"code": "4100", "name": "Passenger / Service Revenue", "type": "income", "detail_type": "income"},
         {"code": "4200", "name": "Detention & Accessorial Revenue", "type": "income", "detail_type": "income"},
         {"code": "4300", "name": "Fuel Surcharge Revenue", "type": "income", "detail_type": "income"},
         {"code": "5000", "name": "Fuel (COGS)", "type": "expense", "detail_type": "cost_of_goods_sold"},
         {"code": "5100", "name": "Driver Wages (COGS)", "type": "expense", "detail_type": "cost_of_goods_sold"},
         {"code": "5200", "name": "Truck Maintenance (COGS)", "type": "expense", "detail_type": "cost_of_goods_sold"},
         {"code": "5300", "name": "Tolls & Permits (COGS)", "type": "expense", "detail_type": "cost_of_goods_sold"},
         {"code": "5400", "name": "Freight Brokerage Fees (COGS)", "type": "expense", "detail_type": "cost_of_goods_sold"}],
        _COMMON_PAYROLL_OPEX, _COMMON_FACILITIES_OPEX, _COMMON_ADMIN_OPEX,
        [{"code": "6440", "name": "DOT Compliance & Inspections", "type": "expense", "detail_type": "expense"},
         {"code": "6450", "name": "Driver Recruiting", "type": "expense", "detail_type": "expense"},
         {"code": "6460", "name": "GPS & Telematics", "type": "expense", "detail_type": "expense"},
         {"code": "6920", "name": "Fleet Insurance", "type": "expense", "detail_type": "expense"}],
        _UNCATEGORIZED_PAIR,
    ),

    "wholesale": _tpl(
        "Wholesale Trade", "📦",
        _COMMON_ASSETS,
        [{"code": "1300", "name": "Inventory - Primary", "type": "asset", "detail_type": "inventory_asset"},
         {"code": "1310", "name": "Inventory - Secondary", "type": "asset", "detail_type": "inventory_asset"},
         {"code": "1320", "name": "Inventory Reserve - Damaged", "type": "asset", "detail_type": "inventory_asset"},
         {"code": "1500", "name": "Warehouse Equipment", "type": "asset", "detail_type": "fixed_asset"}],
        _COMMON_LIABILITIES,
        [{"code": "2400", "name": "Customer Deposits", "type": "liability", "detail_type": "customer_prepayments"}],
        _COMMON_EQUITY,
        [{"code": "4000", "name": "Wholesale Sales", "type": "income", "detail_type": "income"},
         {"code": "4100", "name": "Drop-Ship Revenue", "type": "income", "detail_type": "income"},
         {"code": "4200", "name": "Volume Rebates Earned", "type": "income", "detail_type": "other_income"},
         {"code": "4300", "name": "Returns & Allowances", "type": "income", "detail_type": "income"},
         {"code": "5000", "name": "Cost of Goods Sold", "type": "expense", "detail_type": "cost_of_goods_sold"},
         {"code": "5100", "name": "Freight-in (COGS)", "type": "expense", "detail_type": "cost_of_goods_sold"},
         {"code": "5200", "name": "Import Duties (COGS)", "type": "expense", "detail_type": "cost_of_goods_sold"},
         {"code": "5300", "name": "Inventory Adjustments / Shrinkage (COGS)", "type": "expense", "detail_type": "cost_of_goods_sold"}],
        _COMMON_PAYROLL_OPEX,
        [{"code": "6230", "name": "Warehouse Rent", "type": "expense", "detail_type": "expense"},
         {"code": "6240", "name": "Warehouse Labor", "type": "expense", "detail_type": "expense"}],
        _COMMON_FACILITIES_OPEX, _COMMON_ADMIN_OPEX,
        [{"code": "6440", "name": "Packing & Shipping Supplies", "type": "expense", "detail_type": "expense"},
         {"code": "6450", "name": "Freight-out (Customer Shipping)", "type": "expense", "detail_type": "expense"}],
        _UNCATEGORIZED_PAIR,
    ),

    "virtual_goods": _tpl(
        "Virtual Goods", "🎮",
        _COMMON_ASSETS,
        [{"code": "1250", "name": "Prepaid Platform Fees", "type": "asset", "detail_type": "other_current_asset"},
         {"code": "1500", "name": "Computers & Equipment", "type": "asset", "detail_type": "fixed_asset"},
         {"code": "1550", "name": "Capitalized Game / Content Dev", "type": "asset", "detail_type": "fixed_asset"}],
        _COMMON_LIABILITIES,
        [{"code": "2400", "name": "Platform Payment Holds", "type": "liability", "detail_type": "other_current_liability"},
         {"code": "2410", "name": "Deferred Revenue - Prepaid Credits", "type": "liability", "detail_type": "customer_prepayments"}],
        _COMMON_EQUITY,
        [{"code": "4000", "name": "In-App Purchase Revenue", "type": "income", "detail_type": "income"},
         {"code": "4100", "name": "Virtual Currency Sales", "type": "income", "detail_type": "income"},
         {"code": "4200", "name": "Subscription Revenue", "type": "income", "detail_type": "income"},
         {"code": "4300", "name": "Advertising Revenue", "type": "income", "detail_type": "income"},
         {"code": "4400", "name": "Marketplace Commissions", "type": "income", "detail_type": "income"},
         {"code": "5000", "name": "Platform Fees (Apple/Google/Steam) (COGS)", "type": "expense", "detail_type": "cost_of_goods_sold"},
         {"code": "5100", "name": "Hosting & CDN (COGS)", "type": "expense", "detail_type": "cost_of_goods_sold"},
         {"code": "5200", "name": "Content Creator Payouts (COGS)", "type": "expense", "detail_type": "cost_of_goods_sold"},
         {"code": "5300", "name": "Payment Processing (COGS)", "type": "expense", "detail_type": "cost_of_goods_sold"}],
        _COMMON_PAYROLL_OPEX, _COMMON_FACILITIES_OPEX, _COMMON_ADMIN_OPEX,
        [{"code": "6440", "name": "Community Management", "type": "expense", "detail_type": "expense"},
         {"code": "6450", "name": "Anti-Fraud & Trust Services", "type": "expense", "detail_type": "expense"}],
        _UNCATEGORIZED_PAIR,
    ),
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
