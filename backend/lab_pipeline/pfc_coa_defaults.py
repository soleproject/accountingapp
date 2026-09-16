"""PFC (Plaid Personal Finance Category) → CoA account-name mapping.

Full 104-entry v2 taxonomy mapping (fetched from
https://plaid.com/documents/transactions-personal-finance-category-taxonomy.csv).

The mapping targets *account names* (case-insensitive lookup), not
IDs, so it works across companies with different UUIDs but the same
CoA layout.

The ``kind`` field drives Step 7 rule 3b's auto-create fallback:
    * ``expense`` / ``revenue`` / ``equity`` → if the CoA doesn't have
      the target account, propose it in ``lab_pending_accounts`` and
      the row auto-books to the pending account.
    * ``liability``                          → NEVER auto-created here.
      Handled by the specific-issuer sub-account proposer in Step 7
      rule 1 (Best Buy Card / Rocket Mortgage etc.).
    * Target starts with ``"Uncategorized"`` → the row deliberately
      falls through to the LLM / review; the pipeline is telling the
      CPA "I can't tell without more context." Common on personal-vs-
      business calls (dental, gyms, hair & beauty, groceries for a
      non-restaurant business).
"""
from __future__ import annotations

PFC_TAXONOMY_VERSION = "v2"

# GAAP-aligned target names that we're happy to auto-create when
# missing. Reused elsewhere for docs / test assertions.
AUTO_CREATE_TARGETS = frozenset({
    "Charitable Contributions",
    "Tax Payments",
    "Medical Expenses",
    "Veterinary Services",
    "Postage & Shipping",
    "Storage Rent",
    "Continuing Education",
    "Childcare Expense",
    "Employee Health Insurance",
    "Uniforms",
    "Security Services",
    "Furniture & Equipment",
    "Computer & Software Expense",
    "Dividend Income",
    "Tax Refunds",
    "Notes Payable Draws",
})


PFC_COA_MAP: dict[str, dict] = {
    # ------------------------------------------------------------------
    # BANK_FEES (6)
    # ------------------------------------------------------------------
    "BANK_FEES_ATM_FEES":                               {"coa": "Bank Fees",                "kind": "expense"},
    "BANK_FEES_FOREIGN_TRANSACTION_FEES":               {"coa": "Bank Fees",                "kind": "expense"},
    "BANK_FEES_INSUFFICIENT_FUNDS":                     {"coa": "Bank Fees",                "kind": "expense"},
    "BANK_FEES_INTEREST_CHARGE":                        {"coa": "Interest Expense",         "kind": "expense",
                                                          "note": "auto-create if missing"},
    "BANK_FEES_OVERDRAFT_FEES":                         {"coa": "Bank Fees",                "kind": "expense"},
    "BANK_FEES_OTHER_BANK_FEES":                        {"coa": "Bank Fees",                "kind": "expense"},

    # ------------------------------------------------------------------
    # ENTERTAINMENT (6)
    # ------------------------------------------------------------------
    "ENTERTAINMENT_CASINOS_AND_GAMBLING":               {"coa": "Uncategorized Expense",   "kind": "expense",
                                                          "note": "personal — needs review"},
    "ENTERTAINMENT_MUSIC_AND_AUDIO":                    {"coa": "Dues & Subscriptions",    "kind": "expense"},
    "ENTERTAINMENT_SPORTING_EVENTS_AMUSEMENT_PARKS_AND_MUSEUMS": {"coa": "Entertainment",  "kind": "expense"},
    "ENTERTAINMENT_TV_AND_MOVIES":                      {"coa": "Dues & Subscriptions",    "kind": "expense"},
    "ENTERTAINMENT_VIDEO_GAMES":                        {"coa": "Uncategorized Expense",   "kind": "expense",
                                                          "note": "likely personal"},
    "ENTERTAINMENT_OTHER_ENTERTAINMENT":                {"coa": "Entertainment",           "kind": "expense"},

    # ------------------------------------------------------------------
    # FOOD_AND_DRINK (7)
    # ------------------------------------------------------------------
    "FOOD_AND_DRINK_BEER_WINE_AND_LIQUOR":              {"coa": "Uncategorized Expense",   "kind": "expense",
                                                          "note": "personal vs COGS for bar/restaurant — needs review"},
    "FOOD_AND_DRINK_COFFEE":                            {"coa": "Meals",                   "kind": "expense"},
    "FOOD_AND_DRINK_FAST_FOOD":                         {"coa": "Meals",                   "kind": "expense"},
    "FOOD_AND_DRINK_GROCERIES":                         {"coa": "Uncategorized Expense",   "kind": "expense",
                                                          "note": "COGS for restaurants / personal for others — needs review"},
    "FOOD_AND_DRINK_RESTAURANT":                        {"coa": "Meals",                   "kind": "expense"},
    "FOOD_AND_DRINK_VENDING_MACHINES":                  {"coa": "Meals",                   "kind": "expense"},
    "FOOD_AND_DRINK_OTHER_FOOD_AND_DRINK":              {"coa": "Meals",                   "kind": "expense"},

    # ------------------------------------------------------------------
    # GENERAL_MERCHANDISE (14)
    # ------------------------------------------------------------------
    "GENERAL_MERCHANDISE_BOOKSTORES_AND_NEWSSTANDS":    {"coa": "Dues & Subscriptions",    "kind": "expense"},
    "GENERAL_MERCHANDISE_CLOTHING_AND_ACCESSORIES":     {"coa": "Uniforms",                "kind": "expense",
                                                          "note": "auto-create if missing"},
    "GENERAL_MERCHANDISE_CONVENIENCE_STORES":           {"coa": "Office Supplies",         "kind": "expense"},
    "GENERAL_MERCHANDISE_DEPARTMENT_STORES":            {"coa": "Office Supplies",         "kind": "expense"},
    "GENERAL_MERCHANDISE_DISCOUNT_STORES":              {"coa": "Supplies & Materials",    "kind": "expense"},
    "GENERAL_MERCHANDISE_ELECTRONICS":                  {"coa": "Computer & Software Expense", "kind": "expense",
                                                          "note": "auto-create if missing"},
    "GENERAL_MERCHANDISE_GIFTS_AND_NOVELTIES":          {"coa": "Advertising & Marketing", "kind": "expense",
                                                          "note": "client gifts / marketing swag"},
    "GENERAL_MERCHANDISE_OFFICE_SUPPLIES":              {"coa": "Office Supplies",         "kind": "expense"},
    "GENERAL_MERCHANDISE_ONLINE_MARKETPLACES":          {"coa": "Office Supplies",         "kind": "expense",
                                                          "note": "Amazon/eBay/Etsy — mixed use, defaults to office"},
    "GENERAL_MERCHANDISE_PET_SUPPLIES":                 {"coa": "Supplies & Materials",    "kind": "expense",
                                                          "note": "COGS for vet/pet-store businesses"},
    "GENERAL_MERCHANDISE_SPORTING_GOODS":               {"coa": "Office Supplies",         "kind": "expense"},
    "GENERAL_MERCHANDISE_SUPERSTORES":                  {"coa": "Supplies & Materials",    "kind": "expense",
                                                          "note": "Walmart/Target/Costco — mixed use"},
    "GENERAL_MERCHANDISE_TOBACCO_AND_VAPE":             {"coa": "Uncategorized Expense",   "kind": "expense",
                                                          "note": "personal — needs review"},
    "GENERAL_MERCHANDISE_OTHER_GENERAL_MERCHANDISE":    {"coa": "Office Supplies",         "kind": "expense"},

    # ------------------------------------------------------------------
    # GENERAL_SERVICES (9)
    # ------------------------------------------------------------------
    "GENERAL_SERVICES_ACCOUNTING_AND_FINANCIAL_PLANNING": {"coa": "Legal & Professional Fees", "kind": "expense"},
    "GENERAL_SERVICES_AUTOMOTIVE":                      {"coa": "Repairs & Maintenance",   "kind": "expense"},
    "GENERAL_SERVICES_CHILDCARE":                       {"coa": "Childcare Expense",       "kind": "expense",
                                                          "note": "auto-create if missing — dependent-care benefit"},
    "GENERAL_SERVICES_CONSULTING_AND_LEGAL":            {"coa": "Legal & Professional Fees", "kind": "expense"},
    "GENERAL_SERVICES_EDUCATION":                       {"coa": "Continuing Education",    "kind": "expense",
                                                          "note": "auto-create if missing"},
    "GENERAL_SERVICES_INSURANCE":                       {"coa": "Insurance",               "kind": "expense"},
    "GENERAL_SERVICES_POSTAGE_AND_SHIPPING":            {"coa": "Postage & Shipping",      "kind": "expense",
                                                          "note": "auto-create if missing"},
    "GENERAL_SERVICES_STORAGE":                         {"coa": "Storage Rent",            "kind": "expense",
                                                          "note": "auto-create if missing"},
    "GENERAL_SERVICES_OTHER_GENERAL_SERVICES":          {"coa": "Legal & Professional Fees", "kind": "expense"},

    # ------------------------------------------------------------------
    # GOVERNMENT_AND_NON_PROFIT (4)
    # ------------------------------------------------------------------
    "GOVERNMENT_AND_NON_PROFIT_DONATIONS":              {"coa": "Charitable Contributions", "kind": "expense",
                                                          "note": "auto-create if missing"},
    "GOVERNMENT_AND_NON_PROFIT_GOVERNMENT_DEPARTMENTS_AND_AGENCIES": {"coa": "Legal & Professional Fees",
                                                          "kind": "expense",
                                                          "note": "permits & filing fees"},
    "GOVERNMENT_AND_NON_PROFIT_TAX_PAYMENT":            {"coa": "Tax Payments",             "kind": "expense",
                                                          "note": "auto-create if missing"},
    "GOVERNMENT_AND_NON_PROFIT_OTHER_GOVERNMENT_AND_NON_PROFIT": {"coa": "Legal & Professional Fees",
                                                          "kind": "expense"},

    # ------------------------------------------------------------------
    # HOME_IMPROVEMENT (5)
    # ------------------------------------------------------------------
    "HOME_IMPROVEMENT_FURNITURE":                       {"coa": "Furniture & Equipment",   "kind": "expense",
                                                          "note": "auto-create if missing — capitalize if > cap threshold"},
    "HOME_IMPROVEMENT_HARDWARE":                        {"coa": "Repairs & Maintenance",   "kind": "expense"},
    "HOME_IMPROVEMENT_REPAIR_AND_MAINTENANCE":          {"coa": "Repairs & Maintenance",   "kind": "expense"},
    "HOME_IMPROVEMENT_SECURITY":                        {"coa": "Security Services",       "kind": "expense",
                                                          "note": "auto-create if missing"},
    "HOME_IMPROVEMENT_OTHER_HOME_IMPROVEMENT":          {"coa": "Repairs & Maintenance",   "kind": "expense"},

    # ------------------------------------------------------------------
    # INCOME (7) — revenue-side; auto-book when the CoA has it, propose
    # it (revenue) when missing. Personal-shaped inflows fall through.
    # ------------------------------------------------------------------
    "INCOME_DIVIDENDS":                                 {"coa": "Dividend Income",         "kind": "revenue",
                                                          "note": "auto-create if missing"},
    "INCOME_INTEREST_EARNED":                           {"coa": "Interest Income",         "kind": "revenue"},
    "INCOME_RETIREMENT_PENSION":                        {"coa": "Uncategorized Income",    "kind": "revenue",
                                                          "note": "personal — needs review"},
    "INCOME_TAX_REFUND":                                {"coa": "Tax Refunds",             "kind": "revenue",
                                                          "note": "auto-create if missing"},
    "INCOME_UNEMPLOYMENT":                              {"coa": "Uncategorized Income",    "kind": "revenue",
                                                          "note": "personal — needs review"},
    "INCOME_WAGES":                                     {"coa": "Uncategorized Income",    "kind": "revenue",
                                                          "note": "owner's W-2 vs business revenue — needs review"},
    "INCOME_OTHER_INCOME":                              {"coa": "Uncategorized Income",    "kind": "revenue"},

    # ------------------------------------------------------------------
    # LOAN_PAYMENTS (6) — Liability. Step 4 stamps these as
    # ``credit_line_payment`` and Step 7's rule 1 (sub-account
    # proposer) refines them to the specific issuer (Best Buy Card /
    # Rocket Mortgage / Audi). Rule 3b never auto-creates liabilities.
    # ------------------------------------------------------------------
    "LOAN_PAYMENTS_CAR_PAYMENT":                        {"coa": "Loans Payable",           "kind": "liability",
                                                          "note": "refined by contact (Audi / Mercedes-Benz Financial)"},
    "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT":                {"coa": "Credit Card Payable",     "kind": "liability",
                                                          "note": "refined by card contact"},
    "LOAN_PAYMENTS_PERSONAL_LOAN_PAYMENT":              {"coa": "Loans Payable",           "kind": "liability",
                                                          "note": "BNPL / personal loans — refined by contact"},
    "LOAN_PAYMENTS_MORTGAGE_PAYMENT":                   {"coa": "Loans Payable",           "kind": "liability",
                                                          "note": "refined by contact (Rocket Mortgage / Mr. Cooper)"},
    "LOAN_PAYMENTS_STUDENT_LOAN_PAYMENT":               {"coa": "Loans Payable",           "kind": "liability",
                                                          "note": "personal for owners — needs review"},
    "LOAN_PAYMENTS_OTHER_PAYMENT":                      {"coa": "Loans Payable",           "kind": "liability"},

    # ------------------------------------------------------------------
    # MEDICAL (7)
    # ------------------------------------------------------------------
    "MEDICAL_DENTAL_CARE":                              {"coa": "Employee Health Insurance", "kind": "expense",
                                                          "note": "auto-create if missing — owner vs employee needs review"},
    "MEDICAL_EYE_CARE":                                 {"coa": "Employee Health Insurance", "kind": "expense",
                                                          "note": "auto-create if missing — owner vs employee needs review"},
    "MEDICAL_NURSING_CARE":                             {"coa": "Medical Expenses",        "kind": "expense",
                                                          "note": "auto-create if missing"},
    "MEDICAL_PHARMACIES_AND_SUPPLEMENTS":               {"coa": "Supplies & Materials",    "kind": "expense"},
    "MEDICAL_PRIMARY_CARE":                             {"coa": "Medical Expenses",        "kind": "expense",
                                                          "note": "auto-create if missing"},
    "MEDICAL_VETERINARY_SERVICES":                      {"coa": "Veterinary Services",     "kind": "expense",
                                                          "note": "auto-create if missing"},
    "MEDICAL_OTHER_MEDICAL":                            {"coa": "Medical Expenses",        "kind": "expense",
                                                          "note": "auto-create if missing"},

    # ------------------------------------------------------------------
    # PERSONAL_CARE (4)
    # ------------------------------------------------------------------
    "PERSONAL_CARE_GYMS_AND_FITNESS_CENTERS":           {"coa": "Dues & Subscriptions",    "kind": "expense",
                                                          "note": "wellness benefit for employees"},
    "PERSONAL_CARE_HAIR_AND_BEAUTY":                    {"coa": "Uncategorized Expense",   "kind": "expense",
                                                          "note": "likely personal — Owner's Draw guarded"},
    "PERSONAL_CARE_LAUNDRY_AND_DRY_CLEANING":           {"coa": "Uniforms",                "kind": "expense",
                                                          "note": "auto-create if missing — uniform cleaning"},
    "PERSONAL_CARE_OTHER_PERSONAL_CARE":                {"coa": "Uncategorized Expense",   "kind": "expense",
                                                          "note": "likely personal"},

    # ------------------------------------------------------------------
    # RENT_AND_UTILITIES (7)
    # ------------------------------------------------------------------
    "RENT_AND_UTILITIES_GAS_AND_ELECTRICITY":           {"coa": "Utilities",               "kind": "expense"},
    "RENT_AND_UTILITIES_INTERNET_AND_CABLE":            {"coa": "Telephone & Internet",    "kind": "expense"},
    "RENT_AND_UTILITIES_RENT":                          {"coa": "Rent",                    "kind": "expense"},
    "RENT_AND_UTILITIES_SEWAGE_AND_WASTE_MANAGEMENT":   {"coa": "Utilities",               "kind": "expense"},
    "RENT_AND_UTILITIES_TELEPHONE":                     {"coa": "Telephone & Internet",    "kind": "expense"},
    "RENT_AND_UTILITIES_WATER":                         {"coa": "Utilities",               "kind": "expense"},
    "RENT_AND_UTILITIES_OTHER_UTILITIES":               {"coa": "Utilities",               "kind": "expense"},

    # ------------------------------------------------------------------
    # TRANSFER_IN (6)
    # ------------------------------------------------------------------
    "TRANSFER_IN_CASH_ADVANCES_AND_LOANS":              {"coa": "Notes Payable Draws",     "kind": "liability",
                                                          "note": "new borrowing — capital account, refined by lender"},
    "TRANSFER_IN_DEPOSIT":                              {"coa": "Uncategorized Income",    "kind": "revenue",
                                                          "note": "unknown deposit source — needs review"},
    "TRANSFER_IN_INVESTMENT_AND_RETIREMENT_FUNDS":      {"coa": "Inter-Account Transfer",  "kind": "equity"},
    "TRANSFER_IN_SAVINGS":                              {"coa": "Inter-Account Transfer",  "kind": "equity"},
    "TRANSFER_IN_ACCOUNT_TRANSFER":                     {"coa": "Inter-Account Transfer",  "kind": "equity"},
    "TRANSFER_IN_OTHER_TRANSFER_IN":                    {"coa": "Uncategorized Income",    "kind": "revenue",
                                                          "note": "unknown inbound — needs review"},

    # ------------------------------------------------------------------
    # TRANSFER_OUT (5)
    # ------------------------------------------------------------------
    "TRANSFER_OUT_INVESTMENT_AND_RETIREMENT_FUNDS":     {"coa": "Inter-Account Transfer",  "kind": "equity"},
    "TRANSFER_OUT_SAVINGS":                             {"coa": "Inter-Account Transfer",  "kind": "equity"},
    "TRANSFER_OUT_WITHDRAWAL":                          {"coa": "Uncategorized Expense",   "kind": "expense",
                                                          "note": "cash / personal — needs review"},
    "TRANSFER_OUT_ACCOUNT_TRANSFER":                    {"coa": "Inter-Account Transfer",  "kind": "equity"},
    "TRANSFER_OUT_OTHER_TRANSFER_OUT":                  {"coa": "Uncategorized Expense",   "kind": "expense",
                                                          "note": "unknown outbound — needs review"},

    # ------------------------------------------------------------------
    # TRANSPORTATION (7)
    # ------------------------------------------------------------------
    "TRANSPORTATION_BIKES_AND_SCOOTERS":                {"coa": "Transportation",          "kind": "expense"},
    "TRANSPORTATION_GAS":                               {"coa": "Fuel & Vehicle Expense",  "kind": "expense"},
    "TRANSPORTATION_PARKING":                           {"coa": "Transportation",          "kind": "expense"},
    "TRANSPORTATION_PUBLIC_TRANSIT":                    {"coa": "Transportation",          "kind": "expense"},
    "TRANSPORTATION_TAXIS_AND_RIDE_SHARES":             {"coa": "Transportation",          "kind": "expense"},
    "TRANSPORTATION_TOLLS":                             {"coa": "Transportation",          "kind": "expense"},
    "TRANSPORTATION_OTHER_TRANSPORTATION":              {"coa": "Transportation",          "kind": "expense"},

    # ------------------------------------------------------------------
    # TRAVEL (4)
    # ------------------------------------------------------------------
    "TRAVEL_FLIGHTS":                                   {"coa": "Travel",                  "kind": "expense"},
    "TRAVEL_LODGING":                                   {"coa": "Travel",                  "kind": "expense"},
    "TRAVEL_RENTAL_CARS":                               {"coa": "Travel",                  "kind": "expense"},
    "TRAVEL_OTHER_TRAVEL":                              {"coa": "Travel",                  "kind": "expense"},

    # ------------------------------------------------------------------
    # LEGACY / EXTENDED — values Plaid still returns in real transaction
    # data that are NOT in the current v2 taxonomy CSV (probably from
    # pre-v2 backfills or an unpublished superset). Kept mapped so the
    # pipeline doesn't drop them into review just because the docs
    # forgot them.
    # ------------------------------------------------------------------
    "TRANSFER_IN_TRANSFER_IN_FROM_APPS":                {"coa": "Inter-Account Transfer",  "kind": "equity",
                                                          "note": "legacy — Venmo/PayPal/Cash App inbound"},
    "TRANSFER_OUT_TRANSFER_OUT_FROM_APPS":              {"coa": "Inter-Account Transfer",  "kind": "equity",
                                                          "note": "legacy — Venmo/PayPal/Cash App outbound"},
    "INCOME_CONTRACTOR":                                {"coa": "Service Revenue",         "kind": "revenue",
                                                          "note": "legacy — 1099-NEC contractor income"},
    "OTHER_OTHER":                                      {"coa": "Uncategorized Expense",   "kind": "expense",
                                                          "note": "legacy — Plaid's catch-all"},
}


def lookup(pfc_detailed: str | None) -> dict | None:
    """Case-sensitive lookup — Plaid always returns UPPER_SNAKE."""
    if not pfc_detailed:
        return None
    return PFC_COA_MAP.get(pfc_detailed)


def is_auto_create_target(pfc_detailed: str | None) -> bool:
    """True when the PFC's default target would be auto-created by
    Step 7 rule 3b if the CoA doesn't already have it. Used by the
    downloadable CSV to flag auto-create fate."""
    entry = lookup(pfc_detailed)
    if not entry:
        return False
    target = (entry.get("coa") or "")
    kind   = (entry.get("kind") or "").lower()
    if not target or target.lower().startswith("uncategorized"):
        return False
    return kind in ("expense", "revenue", "equity")
