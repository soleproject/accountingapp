"""PFC (Plaid Personal Finance Category) → CoA account-name mapping.

This is the DEFAULT, opinionated mapping the lab uses when a company
has NOT overridden a PFC in ``db.pfc_org_overrides``. The mapping
targets *account names* (case-insensitive lookup), not IDs, so it
works across companies with different UUIDs but the same CoA layout.

Entries whose target is ``None`` cannot be safely auto-booked and
must fall through to `Uncategorized Expense` (or `Uncategorized
Income` on the revenue side).

Deliberately conservative: personal-care rows never target Owner's
Draw here — the Owner's Draw protection in Step 7 blocks that anyway.
Loan/mortgage/credit-card payments target GENERIC liability accounts
by default; the per-contact routing in Step 5 (`Rocket Mortgage`,
`Audi`, etc.) is what refines them to the specific liability.
"""
from __future__ import annotations

PFC_TAXONOMY_VERSION = "v2"


PFC_COA_MAP: dict[str, dict] = {
    # BANK_FEES
    "BANK_FEES_OTHER_BANK_FEES":                        {"coa": "Bank Fees",               "kind": "expense"},
    "BANK_FEES_OVERDRAFT_FEES":                         {"coa": "Bank Fees",               "kind": "expense"},

    # ENTERTAINMENT
    "ENTERTAINMENT_MUSIC_AND_AUDIO":                    {"coa": "Dues & Subscriptions",    "kind": "expense"},
    "ENTERTAINMENT_OTHER_ENTERTAINMENT":                {"coa": "Entertainment",           "kind": "expense"},
    "ENTERTAINMENT_SPORTING_EVENTS_AMUSEMENT_PARKS_AND_MUSEUMS": {"coa": "Entertainment",  "kind": "expense"},
    "ENTERTAINMENT_TV_AND_MOVIES":                      {"coa": "Dues & Subscriptions",    "kind": "expense"},
    "ENTERTAINMENT_VIDEO_GAMES":                        {"coa": "Entertainment",           "kind": "expense"},

    # FOOD_AND_DRINK
    "FOOD_AND_DRINK_COFFEE":                            {"coa": "Meals",                   "kind": "expense"},
    "FOOD_AND_DRINK_FAST_FOOD":                         {"coa": "Meals",                   "kind": "expense"},
    "FOOD_AND_DRINK_GROCERIES":                         {"coa": "Food Cost (COGS)",        "kind": "expense"},
    "FOOD_AND_DRINK_OTHER_FOOD_AND_DRINK":              {"coa": "Meals",                   "kind": "expense"},
    "FOOD_AND_DRINK_RESTAURANT":                        {"coa": "Meals",                   "kind": "expense"},
    "FOOD_AND_DRINK_VENDING_MACHINES":                  {"coa": "Meals",                   "kind": "expense"},

    # GENERAL_MERCHANDISE
    "GENERAL_MERCHANDISE_CLOTHING_AND_ACCESSORIES":     {"coa": "Office Supplies",         "kind": "expense"},
    "GENERAL_MERCHANDISE_CONVENIENCE_STORES":           {"coa": "Office Supplies",         "kind": "expense"},
    "GENERAL_MERCHANDISE_DEPARTMENT_STORES":            {"coa": "Office Supplies",         "kind": "expense"},
    "GENERAL_MERCHANDISE_DISCOUNT_STORES":              {"coa": "Supplies & Materials",    "kind": "expense"},
    "GENERAL_MERCHANDISE_GIFTS_AND_NOVELTIES":          {"coa": "Advertising & Marketing", "kind": "expense"},
    "GENERAL_MERCHANDISE_ONLINE_MARKETPLACES":          {"coa": "Office Supplies",         "kind": "expense"},
    "GENERAL_MERCHANDISE_OTHER_GENERAL_MERCHANDISE":    {"coa": "Office Supplies",         "kind": "expense"},
    "GENERAL_MERCHANDISE_PET_SUPPLIES":                 {"coa": "Supplies & Materials",    "kind": "expense"},
    "GENERAL_MERCHANDISE_SPORTING_GOODS":               {"coa": "Office Supplies",         "kind": "expense"},
    "GENERAL_MERCHANDISE_SUPERSTORES":                  {"coa": "Supplies & Materials",    "kind": "expense"},

    # GENERAL_SERVICES
    "GENERAL_SERVICES_ACCOUNTING_AND_FINANCIAL_PLANNING": {"coa": "Legal & Professional Fees", "kind": "expense"},
    "GENERAL_SERVICES_AUTOMOTIVE":                      {"coa": "Repairs & Maintenance",   "kind": "expense"},
    "GENERAL_SERVICES_EDUCATION":                       {"coa": "Dues & Subscriptions",    "kind": "expense"},
    "GENERAL_SERVICES_INSURANCE":                       {"coa": "Insurance",               "kind": "expense"},
    "GENERAL_SERVICES_OTHER_GENERAL_SERVICES":          {"coa": "Legal & Professional Fees", "kind": "expense"},
    "GENERAL_SERVICES_POSTAGE_AND_SHIPPING":            {"coa": "Office Supplies",         "kind": "expense"},

    # GOVERNMENT_AND_NON_PROFIT
    "GOVERNMENT_AND_NON_PROFIT_DONATIONS":              {"coa": "Uncategorized Expense",   "kind": "expense",
                                                          "note": "no charitable-contributions account in CoA"},
    "GOVERNMENT_AND_NON_PROFIT_GOVERNMENT_DEPARTMENTS_AND_AGENCIES": {"coa": "Legal & Professional Fees",
                                                          "kind": "expense",
                                                          "note": "permits & filing fees"},
    "GOVERNMENT_AND_NON_PROFIT_TAX_PAYMENT":            {"coa": "Uncategorized Expense",   "kind": "expense",
                                                          "note": "no payroll/income-tax account"},

    # HOME_IMPROVEMENT
    "HOME_IMPROVEMENT_FURNITURE":                       {"coa": "Office Supplies",         "kind": "expense"},
    "HOME_IMPROVEMENT_HARDWARE":                        {"coa": "Repairs & Maintenance",   "kind": "expense"},
    "HOME_IMPROVEMENT_OTHER_HOME_IMPROVEMENT":          {"coa": "Repairs & Maintenance",   "kind": "expense"},

    # INCOME
    "INCOME_CONTRACTOR":                                {"coa": "Service Revenue",         "kind": "revenue"},
    "INCOME_INTEREST_EARNED":                           {"coa": "Interest Income",         "kind": "revenue"},

    # LOAN_PAYMENTS — target GENERIC liability accounts; contact-level
    # routing (Rocket Mortgage / Audi etc.) can override in Step 5.
    "LOAN_PAYMENTS_CAR_PAYMENT":                        {"coa": "Loans Payable",           "kind": "liability",
                                                          "note": "refine by contact (Audi / Mercedes-Benz Financial)"},
    "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT":                {"coa": "Credit Card Payable",     "kind": "liability",
                                                          "note": "refine by card contact"},
    "LOAN_PAYMENTS_MORTGAGE_PAYMENT":                   {"coa": "Loans Payable",           "kind": "liability",
                                                          "note": "refine by contact (Rocket Mortgage / Mr. Cooper)"},
    "LOAN_PAYMENTS_OTHER_PAYMENT":                      {"coa": "Loans Payable",           "kind": "liability"},

    # MEDICAL — expense side (client-paid); vet-services rows for a vet
    # business are treated as inbound revenue by other rules.
    "MEDICAL_OTHER_MEDICAL":                            {"coa": "Uncategorized Expense",   "kind": "expense", "note": "needs review"},
    "MEDICAL_PHARMACIES_AND_SUPPLEMENTS":               {"coa": "Supplies & Materials",    "kind": "expense"},
    "MEDICAL_PRIMARY_CARE":                             {"coa": "Uncategorized Expense",   "kind": "expense",
                                                          "note": "personal vs business — needs review"},
    "MEDICAL_VETERINARY_SERVICES":                      {"coa": "Uncategorized Expense",   "kind": "expense",
                                                          "note": "personal vs business — needs review"},

    # OTHER
    "OTHER_OTHER":                                      {"coa": "Uncategorized Expense",   "kind": "expense"},

    # PERSONAL_CARE
    "PERSONAL_CARE_GYMS_AND_FITNESS_CENTERS":           {"coa": "Dues & Subscriptions",    "kind": "expense"},
    "PERSONAL_CARE_HAIR_AND_BEAUTY":                    {"coa": "Uncategorized Expense",   "kind": "expense",
                                                          "note": "likely personal — Owner's Draw guarded"},

    # RENT_AND_UTILITIES
    "RENT_AND_UTILITIES_GAS_AND_ELECTRICITY":           {"coa": "Utilities",               "kind": "expense"},
    "RENT_AND_UTILITIES_OTHER_UTILITIES":               {"coa": "Utilities",               "kind": "expense"},
    "RENT_AND_UTILITIES_RENT":                          {"coa": "Rent",                    "kind": "expense"},
    "RENT_AND_UTILITIES_SEWAGE_AND_WASTE_MANAGEMENT":   {"coa": "Utilities",               "kind": "expense"},
    "RENT_AND_UTILITIES_TELEPHONE":                     {"coa": "Telephone & Internet",    "kind": "expense"},
    "RENT_AND_UTILITIES_WATER":                         {"coa": "Utilities",               "kind": "expense"},

    # TRANSFER_IN / TRANSFER_OUT — Step 4 handles the paired ones
    # deterministically; unpaired/wire rows fall through to review.
    "TRANSFER_IN_ACCOUNT_TRANSFER":                     {"coa": "Inter-Account Transfer",  "kind": "equity"},
    "TRANSFER_IN_DEPOSIT":                              {"coa": "Uncategorized Income",    "kind": "revenue", "note": "unknown deposit source"},
    "TRANSFER_IN_TRANSFER_IN_FROM_APPS":                {"coa": "Inter-Account Transfer",  "kind": "equity"},
    "TRANSFER_IN_WIRE":                                 {"coa": "Uncategorized Income",    "kind": "revenue",
                                                          "note": "large wires — revenue vs capital review"},
    "TRANSFER_OUT_ACCOUNT_TRANSFER":                    {"coa": "Inter-Account Transfer",  "kind": "equity"},
    "TRANSFER_OUT_TRANSFER_OUT_FROM_APPS":              {"coa": "Inter-Account Transfer",  "kind": "equity"},
    "TRANSFER_OUT_WITHDRAWAL":                          {"coa": "Uncategorized Expense",   "kind": "expense",
                                                          "note": "cash / personal — needs review"},

    # TRANSPORTATION
    "TRANSPORTATION_GAS":                               {"coa": "Fuel & Vehicle Expense",  "kind": "expense"},
    "TRANSPORTATION_PARKING":                           {"coa": "Transportation",          "kind": "expense"},
    "TRANSPORTATION_TOLLS":                             {"coa": "Transportation",          "kind": "expense"},
}


def lookup(pfc_detailed: str | None) -> dict | None:
    """Case-sensitive lookup — Plaid always returns UPPER_SNAKE."""
    if not pfc_detailed:
        return None
    return PFC_COA_MAP.get(pfc_detailed)
