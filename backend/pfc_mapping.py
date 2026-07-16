"""Plaid PFCv2 → Chart-of-Accounts mapping (Python port of Rocketbooks'
`lib/accounting/pfc-coa-mapping.ts`).

Every Plaid transaction includes a `personal_finance_category.detailed` code
(e.g. `FOOD_AND_DRINK_RESTAURANT`, `GENERAL_MERCHANDISE_ELECTRONICS`). This
module maps every PFCv2 detailed code to a canonical target on our chart of
accounts, plus a `classification` that drives downstream review/posting
behavior.

Mapping principles (unchanged from source):
  1. Map by GAAP — each PFC lands on one of our seeded account codes.
  2. Anything that doesn't fit GAAP cleanly:
     - Clearly personal (medical, gym, groceries, casinos, etc. on a business
       account) → equity / Owner's Draw or Owner's Contribution. Never P&L.
     - Genuinely unclassifiable → Uncategorized Expense / Income.
  3. PFCv1 + PFCv2 descriptions are retained on each entry — used later to
     template clarifying questions (e.g. "Was this a personal Venmo or a
     customer payment?").
"""
from __future__ import annotations
from dataclasses import dataclass
from typing import Optional


# Classification drives downstream behavior:
#   - business_expense       : expense P&L impact
#   - business_income        : revenue P&L impact
#   - personal               : owner draw / contribution (equity, no P&L)
#   - liability_paydown      : reducing a liability
#   - liability_increase     : new borrowing
#   - asset_movement         : bank→bank transfer (no P&L)
#   - transfer_review        : ambiguous transfer, force user review
#   - uncategorized          : catch-all
PfcClassification = str


@dataclass(frozen=True)
class PfcMapping:
    pfc_primary: str          # e.g. "FOOD_AND_DRINK"
    pfc_detailed: str         # e.g. "FOOD_AND_DRINK_RESTAURANT" — the lookup key
    account_code: str         # our COA code, e.g. "6000" (may be None for personal — see equity_kind)
    classification: PfcClassification
    description_v2: str
    description_v1: Optional[str] = None
    note: Optional[str] = None
    # For classification=='personal', which equity account? "draw" (money out) or
    # "contribution" (money in). Set explicitly on each personal row.
    equity_kind: Optional[str] = None  # "draw" | "contribution" | None


def _M(pfc_primary: str, pfc_detailed: str, account_code: str,
       classification: PfcClassification,
       description_v2: str, description_v1: Optional[str] = None,
       note: Optional[str] = None, equity_kind: Optional[str] = None) -> PfcMapping:
    return PfcMapping(
        pfc_primary=pfc_primary, pfc_detailed=pfc_detailed,
        account_code=account_code, classification=classification,
        description_v2=description_v2, description_v1=description_v1,
        note=note, equity_kind=equity_kind,
    )


# ---------------------------------------------------------------------------
# COA code map (our default seed, from backend/seed.py):
#   6000 Meals              (Rocketbooks: expenses/entertainment_meals + travel_meals)
#   6010 Entertainment      (Rocketbooks: expenses/entertainment)
#   6100 Travel             (Rocketbooks: expenses/travel + travel_lodging)
#   6120 Transportation     (Rocketbooks: expenses/travel_transportation)
#   6200 Advertising & Mkt  (Rocketbooks: expenses/advertising_promotional)
#   6250 Dues & Subs        (Rocketbooks: expenses/dues_and_subscriptions)
#   6300 Office Supplies    (Rocketbooks: expenses/office_general_admin)
#   6400 Insurance
#   6500 Legal & Prof Fees
#   6600 Utilities
#   6700 Rent
#   6800 Supplies & Materials
#   6900 Repairs & Maint
#   7000 Bank Fees          (Rocketbooks: expenses/bank_charges)
#   7100 Software & SaaS
#   7200 Payroll
#   4000 Service Revenue
#   4100 Product Sales
#   4200 Interest Income
#   2100 Credit Card Payable
#   2500 Loans Payable
#   1010 Business Checking
#   1020 Business Savings
#   1100 Undeposited Funds    (auto-created; see accounting_extras.py)
#   3300 Owner's Draw         (auto-created; equity)
#   3400 Owner's Contribution (auto-created; equity)
#   6999 Uncategorized Expense
#   4999 Uncategorized Income


PFC_COA_MAPPINGS: list[PfcMapping] = [
    # ─── INCOME ────────────────────────────────────────────────────────
    _M("INCOME", "INCOME_CHILD_SUPPORT",          "3400", "personal",
       "Court-ordered child-support payments to a parent.", None,
       "Personal — child support is not business income.",
       equity_kind="contribution"),
    _M("INCOME", "INCOME_CONTRACTOR",             "4000", "business_income",
       "Income from freelance or independent contract work."),
    _M("INCOME", "INCOME_DIVIDENDS",              "4999", "business_income",
       "Income from dividends", "Income from dividends"),
    _M("INCOME", "INCOME_GIG_ECONOMY",            "4000", "business_income",
       "Money earned by working in the gig economy (Uber, Lyft, etc.)"),
    _M("INCOME", "INCOME_INTEREST_EARNED",        "4200", "business_income",
       "Income from interest on savings accounts",
       "Income from interest on savings accounts"),
    _M("INCOME", "INCOME_LONG_TERM_DISABILITY",   "3400", "personal",
       "Disability payments (e.g. social security).", None, None,
       equity_kind="contribution"),
    _M("INCOME", "INCOME_MILITARY",               "3400", "personal",
       "Veterans benefits.", None, None, equity_kind="contribution"),
    _M("INCOME", "INCOME_RENTAL",                 "4000", "business_income",
       "Rental income (property, lease, Airbnb/VRBO)."),
    _M("INCOME", "INCOME_RETIREMENT_PENSION",     "3400", "personal",
       "SSA, 401k, pension distributions",
       "Income from pension payments", equity_kind="contribution"),
    _M("INCOME", "INCOME_SALARY",                 "3400", "personal",
       "Income from salaries and wages",
       "Income from salaries, gig work, tips",
       "Owner-salary deposits route to owner contribution.",
       equity_kind="contribution"),
    _M("INCOME", "INCOME_TAX_REFUND",             "4999", "business_income",
       "Government tax refund provided to the user",
       "Income from tax refunds"),
    _M("INCOME", "INCOME_UNEMPLOYMENT",           "3400", "personal",
       "Money earned from unemployment benefits",
       "Unemployment benefits incl. healthcare", equity_kind="contribution"),
    _M("INCOME", "INCOME_OTHER",                  "4999", "uncategorized",
       "Other miscellaneous income"),

    # ─── LOAN_DISBURSEMENTS (incoming loan proceeds) ────────────────────
    _M("LOAN_DISBURSEMENTS", "LOAN_DISBURSEMENTS_AUTO",                "2500", "liability_increase", "Auto loan disbursements"),
    _M("LOAN_DISBURSEMENTS", "LOAN_DISBURSEMENTS_CASH_ADVANCES",       "2500", "liability_increase", "Payday loans and cash advances"),
    _M("LOAN_DISBURSEMENTS", "LOAN_DISBURSEMENTS_EWA",                 "2500", "liability_increase", "Early wage access disbursements"),
    _M("LOAN_DISBURSEMENTS", "LOAN_DISBURSEMENTS_MORTGAGE",            "2500", "liability_increase", "Mortgage loan disbursements"),
    _M("LOAN_DISBURSEMENTS", "LOAN_DISBURSEMENTS_PERSONAL",            "2500", "liability_increase", "Personal loan disbursements"),
    _M("LOAN_DISBURSEMENTS", "LOAN_DISBURSEMENTS_STUDENT",             "3400", "personal",
       "Student loan disbursements.", None,
       "Student loans on a business account are personal.", equity_kind="contribution"),
    _M("LOAN_DISBURSEMENTS", "LOAN_DISBURSEMENTS_OTHER_DISBURSEMENT",  "2500", "liability_increase",
       "Other miscellaneous loan disbursements",
       "Loans/cash advances deposited into a bank account"),

    # ─── LOAN_PAYMENTS (paying down liabilities) ────────────────────────
    _M("LOAN_PAYMENTS", "LOAN_PAYMENTS_BNPL",                  "2500", "liability_paydown", "BNPL loan payments"),
    _M("LOAN_PAYMENTS", "LOAN_PAYMENTS_CAR_PAYMENT",           "2500", "liability_paydown", "Car loan/lease payments"),
    _M("LOAN_PAYMENTS", "LOAN_PAYMENTS_CASH_ADVANCES",         "2500", "liability_paydown", "Cash advance loan payments"),
    _M("LOAN_PAYMENTS", "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT",   "2100", "liability_paydown", "Credit card payment"),
    _M("LOAN_PAYMENTS", "LOAN_PAYMENTS_EWA",                   "2500", "liability_paydown", "EWA loan payments"),
    _M("LOAN_PAYMENTS", "LOAN_PAYMENTS_MORTGAGE_PAYMENT",      "2500", "liability_paydown", "Mortgage payment"),
    _M("LOAN_PAYMENTS", "LOAN_PAYMENTS_PERSONAL_LOAN_PAYMENT", "3300", "personal",
       "Personal loan payments.", None,
       "Personal context — book as owner draw.", equity_kind="draw"),
    _M("LOAN_PAYMENTS", "LOAN_PAYMENTS_STUDENT_LOAN_PAYMENT",  "3300", "personal",
       "Student loan payments.", None, None, equity_kind="draw"),
    _M("LOAN_PAYMENTS", "LOAN_PAYMENTS_OTHER_PAYMENT",         "2500", "liability_paydown",
       "Other miscellaneous debt payments"),

    # ─── TRANSFER_IN ────────────────────────────────────────────────────
    _M("TRANSFER_IN", "TRANSFER_IN_ACCOUNT_TRANSFER",                "1010", "asset_movement",
       "General inbound transfers from another account",
       "General inbound transfers from another account",
       "Bank→bank; resolver's bank-account guard forces this to fallback (review)."),
    _M("TRANSFER_IN", "TRANSFER_IN_DEPOSIT",                         "1100", "asset_movement",
       "Cash/check/ATM deposits into a bank account"),
    _M("TRANSFER_IN", "TRANSFER_IN_INVESTMENT_AND_RETIREMENT_FUNDS", "3400", "personal",
       "Money transferred in from an investment/retirement account",
       equity_kind="contribution"),
    _M("TRANSFER_IN", "TRANSFER_IN_SAVINGS",                         "1020", "asset_movement",
       "Inbound transfers to a savings account"),
    _M("TRANSFER_IN", "TRANSFER_IN_TRANSFER_IN_FROM_APPS",           "4999", "transfer_review",
       "Money transferred in from Venmo/Cashapp/Zelle.", None,
       "Could be customer payment OR personal — flag for review."),
    _M("TRANSFER_IN", "TRANSFER_IN_WIRE",                            "4999", "transfer_review",
       "Wire transfer received from another bank.", None,
       "Wires can be revenue or owner contribution."),
    _M("TRANSFER_IN", "TRANSFER_IN_OTHER_TRANSFER_IN",               "4999", "transfer_review",
       "Other miscellaneous inbound transactions"),

    # ─── TRANSFER_OUT ───────────────────────────────────────────────────
    _M("TRANSFER_OUT", "TRANSFER_OUT_ACCOUNT_TRANSFER",                "1010", "asset_movement",
       "General outbound transfers to another account"),
    _M("TRANSFER_OUT", "TRANSFER_OUT_CRYPTO",                          "3300", "personal",
       "Crypto purchases", None,
       "Crypto on a business account = owner draw.", equity_kind="draw"),
    _M("TRANSFER_OUT", "TRANSFER_OUT_INVESTMENT_AND_RETIREMENT_FUNDS", "3300", "personal",
       "Transfers to an investment/retirement account", None, None, equity_kind="draw"),
    _M("TRANSFER_OUT", "TRANSFER_OUT_SAVINGS",                         "1020", "asset_movement",
       "Outbound transfers to savings accounts"),
    _M("TRANSFER_OUT", "TRANSFER_OUT_TRANSFER_OUT_FROM_APPS",          "6999", "transfer_review",
       "Money transferred out via Venmo/Cashapp/Zelle."),
    _M("TRANSFER_OUT", "TRANSFER_OUT_WIRE",                            "6999", "transfer_review",
       "Wire transfer sent to another bank."),
    _M("TRANSFER_OUT", "TRANSFER_OUT_WITHDRAWAL",                      "3300", "personal",
       "Cash withdrawals from a bank account",
       "Withdrawals from a bank account",
       "Cash withdrawals from a business account = owner draw.",
       equity_kind="draw"),
    _M("TRANSFER_OUT", "TRANSFER_OUT_OTHER_TRANSFER_OUT",              "6999", "transfer_review",
       "Other miscellaneous outbound transactions"),

    # ─── BANK_FEES ──────────────────────────────────────────────────────
    _M("BANK_FEES", "BANK_FEES_ATM_FEES",                 "7000", "business_expense", "Out-of-network ATM fees"),
    _M("BANK_FEES", "BANK_FEES_INSUFFICIENT_FUNDS",       "7000", "business_expense", "Insufficient-funds fees"),
    _M("BANK_FEES", "BANK_FEES_INTEREST_CHARGE",          "7000", "business_expense", "Interest on purchases"),
    _M("BANK_FEES", "BANK_FEES_FOREIGN_TRANSACTION_FEES", "7000", "business_expense", "Non-domestic transaction fees"),
    _M("BANK_FEES", "BANK_FEES_OVERDRAFT_FEES",           "7000", "business_expense", "Overdraft fees"),
    _M("BANK_FEES", "BANK_FEES_LATE_FEES",                "7000", "business_expense", "Late-payment fees"),
    _M("BANK_FEES", "BANK_FEES_CASH_ADVANCE",             "7000", "business_expense", "Cash-advance fees"),
    _M("BANK_FEES", "BANK_FEES_OTHER_BANK_FEES",          "7000", "business_expense", "Other miscellaneous bank fees"),

    # ─── ENTERTAINMENT ──────────────────────────────────────────────────
    _M("ENTERTAINMENT", "ENTERTAINMENT_CASINOS_AND_GAMBLING",                "3300", "personal",
       "Gambling, casinos, sports betting", None,
       "Gambling losses aren't deductible.", equity_kind="draw"),
    _M("ENTERTAINMENT", "ENTERTAINMENT_MUSIC_AND_AUDIO",                     "6250", "business_expense",
       "Digital and in-person music (incl. streaming)"),
    _M("ENTERTAINMENT", "ENTERTAINMENT_SPORTING_EVENTS_AMUSEMENT_PARKS_AND_MUSEUMS", "6010", "business_expense",
       "Sporting events, museums, concerts, amusement parks",
       None, "Could be client entertainment; personal use should reclassify."),
    _M("ENTERTAINMENT", "ENTERTAINMENT_TV_AND_MOVIES",                       "6250", "business_expense",
       "In-home streaming services and movie theaters"),
    _M("ENTERTAINMENT", "ENTERTAINMENT_VIDEO_GAMES",                         "3300", "personal",
       "Digital and in-person video game purchases", None, None, equity_kind="draw"),
    _M("ENTERTAINMENT", "ENTERTAINMENT_OTHER_ENTERTAINMENT",                 "6010", "business_expense",
       "Nightlife and other miscellaneous entertainment"),

    # ─── FOOD_AND_DRINK ─────────────────────────────────────────────────
    _M("FOOD_AND_DRINK", "FOOD_AND_DRINK_BEER_WINE_AND_LIQUOR",    "6000", "business_expense",
       "Beer, wine, and liquor stores."),
    _M("FOOD_AND_DRINK", "FOOD_AND_DRINK_COFFEE",                  "6000", "business_expense",
       "Coffee shops and cafes"),
    _M("FOOD_AND_DRINK", "FOOD_AND_DRINK_FAST_FOOD",               "6000", "business_expense",
       "Fast food chains"),
    _M("FOOD_AND_DRINK", "FOOD_AND_DRINK_GROCERIES",               "3300", "personal",
       "Fresh produce and groceries", None,
       "Groceries on a business card = owner draw by default.",
       equity_kind="draw"),
    _M("FOOD_AND_DRINK", "FOOD_AND_DRINK_RESTAURANT",              "6000", "business_expense",
       "Restaurants, bars, gastropubs, and diners"),
    _M("FOOD_AND_DRINK", "FOOD_AND_DRINK_VENDING_MACHINES",        "6000", "business_expense",
       "Vending-machine operators"),
    _M("FOOD_AND_DRINK", "FOOD_AND_DRINK_OTHER_FOOD_AND_DRINK",    "6000", "business_expense",
       "Other food and drink (delis, juice bars, desserts)"),

    # ─── GENERAL_MERCHANDISE ────────────────────────────────────────────
    _M("GENERAL_MERCHANDISE", "GENERAL_MERCHANDISE_BOOKSTORES_AND_NEWSSTANDS", "6250", "business_expense",
       "Books, magazines, and news"),
    _M("GENERAL_MERCHANDISE", "GENERAL_MERCHANDISE_CLOTHING_AND_ACCESSORIES", "3300", "personal",
       "Apparel, shoes, and jewelry", None,
       "Uniforms may be reclassified to a business account.",
       equity_kind="draw"),
    _M("GENERAL_MERCHANDISE", "GENERAL_MERCHANDISE_CONVENIENCE_STORES",       "6800", "business_expense",
       "Convenience stores"),
    _M("GENERAL_MERCHANDISE", "GENERAL_MERCHANDISE_DEPARTMENT_STORES",        "6800", "business_expense",
       "Department stores"),
    _M("GENERAL_MERCHANDISE", "GENERAL_MERCHANDISE_DISCOUNT_STORES",          "6800", "business_expense",
       "Discount stores"),
    _M("GENERAL_MERCHANDISE", "GENERAL_MERCHANDISE_ELECTRONICS",              "6300", "business_expense",
       "Electronics stores"),
    _M("GENERAL_MERCHANDISE", "GENERAL_MERCHANDISE_GIFTS_AND_NOVELTIES",      "6200", "business_expense",
       "Photo, gifts, cards, floral", None,
       "Client gifts = advertising/promotional."),
    _M("GENERAL_MERCHANDISE", "GENERAL_MERCHANDISE_OFFICE_SUPPLIES",          "6300", "business_expense",
       "Office-goods stores"),
    _M("GENERAL_MERCHANDISE", "GENERAL_MERCHANDISE_ONLINE_MARKETPLACES",      "6800", "business_expense",
       "Etsy, eBay, Amazon"),
    _M("GENERAL_MERCHANDISE", "GENERAL_MERCHANDISE_PET_SUPPLIES",             "3300", "personal",
       "Pet supplies and pet food", None, None, equity_kind="draw"),
    _M("GENERAL_MERCHANDISE", "GENERAL_MERCHANDISE_SPORTING_GOODS",           "3300", "personal",
       "Sporting goods, camping gear", None, None, equity_kind="draw"),
    _M("GENERAL_MERCHANDISE", "GENERAL_MERCHANDISE_SUPERSTORES",              "6800", "business_expense",
       "Superstores (Target, Walmart)"),
    _M("GENERAL_MERCHANDISE", "GENERAL_MERCHANDISE_TOBACCO_AND_VAPE",         "3300", "personal",
       "Tobacco and vaping products", None, None, equity_kind="draw"),
    _M("GENERAL_MERCHANDISE", "GENERAL_MERCHANDISE_OTHER_GENERAL_MERCHANDISE","6800", "business_expense",
       "Other merchandise (toys, arts and crafts)"),

    # ─── HOME_IMPROVEMENT (default personal) ────────────────────────────
    _M("HOME_IMPROVEMENT", "HOME_IMPROVEMENT_FURNITURE",              "3300", "personal",
       "Furniture, bedding, home accessories", None, None, equity_kind="draw"),
    _M("HOME_IMPROVEMENT", "HOME_IMPROVEMENT_HARDWARE",               "3300", "personal",
       "Hardware, paint, wallpaper", None,
       "Construction cos should reclassify to Supplies & Materials.",
       equity_kind="draw"),
    _M("HOME_IMPROVEMENT", "HOME_IMPROVEMENT_REPAIR_AND_MAINTENANCE", "3300", "personal",
       "Plumbing, lighting, gardening, roofing", None, None, equity_kind="draw"),
    _M("HOME_IMPROVEMENT", "HOME_IMPROVEMENT_SECURITY",               "3300", "personal",
       "Home security systems", None, None, equity_kind="draw"),
    _M("HOME_IMPROVEMENT", "HOME_IMPROVEMENT_OTHER_HOME_IMPROVEMENT", "3300", "personal",
       "Pool installation, pest control", None, None, equity_kind="draw"),

    # ─── MEDICAL (always personal on a business account) ───────────────
    _M("MEDICAL", "MEDICAL_DENTAL_CARE",                "3300", "personal", "Dentists", None, None, equity_kind="draw"),
    _M("MEDICAL", "MEDICAL_EYE_CARE",                   "3300", "personal", "Optometrists", None, None, equity_kind="draw"),
    _M("MEDICAL", "MEDICAL_NURSING_CARE",               "3300", "personal", "Nursing care", None, None, equity_kind="draw"),
    _M("MEDICAL", "MEDICAL_PHARMACIES_AND_SUPPLEMENTS", "3300", "personal", "Pharmacies", None, None, equity_kind="draw"),
    _M("MEDICAL", "MEDICAL_PRIMARY_CARE",               "3300", "personal", "Doctors", None, None, equity_kind="draw"),
    _M("MEDICAL", "MEDICAL_VETERINARY_SERVICES",        "3300", "personal", "Veterinary", None, None, equity_kind="draw"),
    _M("MEDICAL", "MEDICAL_OTHER_MEDICAL",              "3300", "personal", "Hospitals, blood work, ambulance", None, None, equity_kind="draw"),

    # ─── PERSONAL_CARE (always personal) ───────────────────────────────
    _M("PERSONAL_CARE", "PERSONAL_CARE_GYMS_AND_FITNESS_CENTERS", "3300", "personal", "Gyms", None, None, equity_kind="draw"),
    _M("PERSONAL_CARE", "PERSONAL_CARE_HAIR_AND_BEAUTY",          "3300", "personal", "Hair/beauty/spa", None, None, equity_kind="draw"),
    _M("PERSONAL_CARE", "PERSONAL_CARE_LAUNDRY_AND_DRY_CLEANING", "3300", "personal", "Wash/fold, dry cleaning", None, None, equity_kind="draw"),
    _M("PERSONAL_CARE", "PERSONAL_CARE_OTHER_PERSONAL_CARE",      "3300", "personal", "Mental health apps, etc.", None, None, equity_kind="draw"),

    # ─── GENERAL_SERVICES ──────────────────────────────────────────────
    _M("GENERAL_SERVICES", "GENERAL_SERVICES_ACCOUNTING_AND_FINANCIAL_PLANNING", "6500", "business_expense",
       "Financial planning, tax, accounting"),
    _M("GENERAL_SERVICES", "GENERAL_SERVICES_AUTOMOTIVE",                        "6900", "business_expense",
       "Oil changes, car washes, repairs, towing"),
    _M("GENERAL_SERVICES", "GENERAL_SERVICES_CHILDCARE",                         "3300", "personal",
       "Babysitters and daycare", None, None, equity_kind="draw"),
    _M("GENERAL_SERVICES", "GENERAL_SERVICES_CONSULTING_AND_LEGAL",              "6500", "business_expense",
       "Consulting and legal services"),
    _M("GENERAL_SERVICES", "GENERAL_SERVICES_EDUCATION",                         "6250", "business_expense",
       "Schools and tuition", None,
       "Personal tuition should reclassify."),
    _M("GENERAL_SERVICES", "GENERAL_SERVICES_INSURANCE",                         "6400", "business_expense",
       "Insurance for auto, home, healthcare"),
    _M("GENERAL_SERVICES", "GENERAL_SERVICES_POSTAGE_AND_SHIPPING",              "6800", "business_expense",
       "Mail, packaging, shipping"),
    _M("GENERAL_SERVICES", "GENERAL_SERVICES_STORAGE",                           "6700", "business_expense",
       "Storage services and facilities"),
    _M("GENERAL_SERVICES", "GENERAL_SERVICES_OTHER_GENERAL_SERVICES",            "6300", "business_expense",
       "Advertising, cloud storage, misc services"),

    # ─── GOVERNMENT_AND_NON_PROFIT ─────────────────────────────────────
    _M("GOVERNMENT_AND_NON_PROFIT", "GOVERNMENT_AND_NON_PROFIT_DONATIONS",                       "6999", "business_expense",
       "Charitable, political, religious donations", None,
       "No charitable-contributions slot in seed; consider adding one."),
    _M("GOVERNMENT_AND_NON_PROFIT", "GOVERNMENT_AND_NON_PROFIT_GOVERNMENT_DEPARTMENTS_AND_AGENCIES", "6300", "business_expense",
       "Government departments/agencies (licensing, DMV, passport)"),
    _M("GOVERNMENT_AND_NON_PROFIT", "GOVERNMENT_AND_NON_PROFIT_TAX_PAYMENT",                      "3300", "personal",
       "Tax payments (income, property)", None,
       "Pass-through LLC: owner tax = personal; C-corp: reclassify to tax expense.",
       equity_kind="draw"),
    _M("GOVERNMENT_AND_NON_PROFIT", "GOVERNMENT_AND_NON_PROFIT_OTHER_GOVERNMENT_AND_NON_PROFIT",  "6300", "business_expense",
       "Other government/non-profit"),

    # ─── TRANSPORTATION ────────────────────────────────────────────────
    _M("TRANSPORTATION", "TRANSPORTATION_BIKES_AND_SCOOTERS",     "6120", "business_expense", "Bike/scooter rentals"),
    _M("TRANSPORTATION", "TRANSPORTATION_GAS",                    "6120", "business_expense", "Gas stations"),
    _M("TRANSPORTATION", "TRANSPORTATION_PARKING",                "6120", "business_expense", "Parking"),
    _M("TRANSPORTATION", "TRANSPORTATION_PUBLIC_TRANSIT",         "6120", "business_expense", "Rail/bus/metro"),
    _M("TRANSPORTATION", "TRANSPORTATION_TAXIS_AND_RIDE_SHARES",  "6120", "business_expense", "Taxi/rideshare"),
    _M("TRANSPORTATION", "TRANSPORTATION_TOLLS",                  "6120", "business_expense", "Tolls"),
    _M("TRANSPORTATION", "TRANSPORTATION_OTHER_TRANSPORTATION",   "6120", "business_expense", "Other transportation"),

    # ─── TRAVEL ────────────────────────────────────────────────────────
    _M("TRAVEL", "TRAVEL_FLIGHTS",       "6100", "business_expense", "Airlines"),
    _M("TRAVEL", "TRAVEL_LODGING",       "6100", "business_expense", "Hotels, Airbnb, motels"),
    _M("TRAVEL", "TRAVEL_RENTAL_CARS",   "6120", "business_expense", "Rental cars, charter buses"),
    _M("TRAVEL", "TRAVEL_OTHER_TRAVEL",  "6100", "business_expense", "Other travel"),

    # ─── RENT_AND_UTILITIES ────────────────────────────────────────────
    _M("RENT_AND_UTILITIES", "RENT_AND_UTILITIES_GAS_AND_ELECTRICITY",        "6600", "business_expense", "Gas/electricity"),
    _M("RENT_AND_UTILITIES", "RENT_AND_UTILITIES_INTERNET_AND_CABLE",         "6600", "business_expense", "Internet/cable"),
    _M("RENT_AND_UTILITIES", "RENT_AND_UTILITIES_RENT",                       "6700", "business_expense", "Rent payment"),
    _M("RENT_AND_UTILITIES", "RENT_AND_UTILITIES_SEWAGE_AND_WASTE_MANAGEMENT","6600", "business_expense", "Sewage/garbage"),
    _M("RENT_AND_UTILITIES", "RENT_AND_UTILITIES_TELEPHONE",                  "6600", "business_expense", "Telephone"),
    _M("RENT_AND_UTILITIES", "RENT_AND_UTILITIES_WATER",                      "6600", "business_expense", "Water"),
    _M("RENT_AND_UTILITIES", "RENT_AND_UTILITIES_OTHER_UTILITIES",            "6600", "business_expense", "Other utility bills"),

    # ─── OTHER ────────────────────────────────────────────────────────
    _M("OTHER", "OTHER_OTHER", "6999", "uncategorized", "Miscellaneous"),
]


_BY_DETAILED: dict[str, PfcMapping] = {m.pfc_detailed: m for m in PFC_COA_MAPPINGS}


def get_pfc_mapping(pfc_detailed: Optional[str]) -> Optional[PfcMapping]:
    """Look up the PFC mapping, or None if pfc_detailed is empty/unknown."""
    if not pfc_detailed:
        return None
    return _BY_DETAILED.get(pfc_detailed)


def reviewed_by_default(classification: PfcClassification) -> bool:
    """Confidently-classified rows auto-clear review; transfers + uncategorized
    always land in the review queue.
    """
    if classification in ("business_expense", "business_income",
                          "personal", "liability_paydown", "liability_increase"):
        return True
    # asset_movement, transfer_review, uncategorized
    return False


def pfc_detailed_by_classification(classification: PfcClassification) -> list[str]:
    return [m.pfc_detailed for m in PFC_COA_MAPPINGS if m.classification == classification]


def pfc_question(mapping: PfcMapping) -> dict:
    """Clarifying-question template per PFC. Used in the review queue UI."""
    q_map = {
        "transfer_review":    "Was this a customer payment or a personal transfer?",
        "asset_movement":     "Internal transfer between your own accounts — pick the other side, or recategorize.",
        "personal":           "Personal expense (owner draw). Confirm or move to a business account?",
        "uncategorized":      "Plaid couldn't classify this. What is it?",
        "business_expense":   "Business expense — pick the right category.",
        "business_income":    "Business income — confirm the revenue category.",
        "liability_paydown":  "Pick the loan or credit card being paid down.",
        "liability_increase": "Confirm this loan disbursement and pick the liability account.",
    }
    examples = (mapping.description_v1
                if mapping.description_v1 and mapping.description_v1 != mapping.description_v2
                else None)
    return {
        "question": q_map.get(mapping.classification, "Confirm the category."),
        "description": mapping.description_v2,
        "examples": examples,
    }


__all__ = [
    "PfcMapping",
    "PFC_COA_MAPPINGS",
    "get_pfc_mapping",
    "reviewed_by_default",
    "pfc_detailed_by_classification",
    "pfc_question",
]
