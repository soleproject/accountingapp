"""Plaid Personal Finance Category (PFC) → semantic-key mapping.

Standard+ Beta uses this as a FALLBACK stage after Global Vendor
Rules. Plaid attaches a PFC to every transaction it returns
(`personal_finance_category.detailed` field) — a fixed taxonomy of
~104 canonical categories. This module maps each PFC to the same
semantic keys used by `global_vendor_rules.SEMANTIC_TO_CODE`, so we
get template-aware resolution for free.

Why not just use Plaid's PFC directly like the existing
`pfc_mapping.py`? Two reasons:
    1. `pfc_mapping.py` hardcodes account codes (6000, 6120, 3300)
       that assume the professional_services / generic template.
       Restaurants, ecommerce, and construction have different code
       schemes — those lookups miss. Semantic indirection fixes it.
    2. We want Standard+ to consult Global Vendor Rules FIRST (they're
       more specific, e.g., "STARBUCKS → meals" beats
       "FOOD_AND_DRINK_COFFEE → meals" only when the merchant string
       matches). Global Rules give us high confidence; PFC gives us
       coverage on unknown merchants.

Confidence tiering (per Plaid docs on PFC confidence_level):
    - Plaid's confidence_level = "VERY_HIGH" | "HIGH" → 0.85
    - Plaid's confidence_level = "MEDIUM"            → 0.70
    - Plaid's confidence_level = "LOW"               → 0.55 (surfaces for review)
    - Plaid's confidence_level missing or unknown    → 0.65

Together with the Standard+ tri-state gate this means:
    - VERY_HIGH/HIGH PFCs auto-apply
    - MEDIUM PFCs apply but flag for review
    - LOW PFCs skip (Standard's answer stands)
"""
from __future__ import annotations
from typing import Optional


# ---------------------------------------------------------------------------
# PFC → semantic-key mapping.
#
# Keys are Plaid's `personal_finance_category.detailed` strings verbatim.
# Values are semantic keys defined in `global_vendor_rules.SEMANTIC_TO_CODE`.
# Missing/None value means "we don't have a confident mapping — skip".

PFC_TO_SEMANTIC: dict[str, Optional[str]] = {
    # ── INCOME ──────────────────────────────────────────────────────────
    "INCOME_CHILD_SUPPORT":          "owner_draw",  # personal — contribution
    "INCOME_CONTRACTOR":             "revenue_generic",
    "INCOME_DIVIDENDS":              "interest_income",
    "INCOME_GIG_ECONOMY":            "revenue_generic",
    "INCOME_INTEREST_EARNED":        "interest_income",
    "INCOME_LONG_TERM_DISABILITY":   "owner_draw",
    "INCOME_MILITARY":               "owner_draw",
    "INCOME_RENTAL":                 "revenue_generic",
    "INCOME_RETIREMENT_PENSION":     "owner_draw",
    "INCOME_SALARY":                 "owner_draw",  # owner-salary deposits
    "INCOME_TAX_REFUND":             "revenue_generic",
    "INCOME_UNEMPLOYMENT":           "owner_draw",
    "INCOME_OTHER":                  None,  # ambiguous — let Standard decide

    # ── LOAN_DISBURSEMENTS ──────────────────────────────────────────────
    # These are cash INTO the account backed by a new liability.
    # Standard's existing pipeline handles these more precisely; we
    # skip them here to avoid overriding.
    "LOAN_DISBURSEMENTS_AUTO":                None,
    "LOAN_DISBURSEMENTS_CASH_ADVANCES":       None,
    "LOAN_DISBURSEMENTS_EWA":                 None,
    "LOAN_DISBURSEMENTS_MORTGAGE":            None,
    "LOAN_DISBURSEMENTS_PERSONAL":            None,
    "LOAN_DISBURSEMENTS_STUDENT":             None,
    "LOAN_DISBURSEMENTS_OTHER_DISBURSEMENT":  None,

    # ── LOAN_PAYMENTS ───────────────────────────────────────────────────
    "LOAN_PAYMENTS_BNPL":                  "loan_payment",
    "LOAN_PAYMENTS_CAR_PAYMENT":           "loan_payment",
    "LOAN_PAYMENTS_CASH_ADVANCES":         "loan_payment",
    "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT":   "credit_card_payment",
    "LOAN_PAYMENTS_EWA":                   "loan_payment",
    "LOAN_PAYMENTS_MORTGAGE_PAYMENT":      "loan_payment",
    "LOAN_PAYMENTS_PERSONAL_LOAN_PAYMENT": "owner_draw",  # personal
    "LOAN_PAYMENTS_STUDENT_LOAN_PAYMENT":  "owner_draw",  # personal
    "LOAN_PAYMENTS_OTHER_PAYMENT":         "loan_payment",

    # ── TRANSFERS (skip — Linked Transactions stage handles these) ─────
    "TRANSFER_IN_ACCOUNT_TRANSFER":                None,
    "TRANSFER_IN_DEPOSIT":                         None,
    "TRANSFER_IN_INVESTMENT_AND_RETIREMENT_FUNDS": None,
    "TRANSFER_IN_SAVINGS":                         None,
    "TRANSFER_IN_TRANSFER_IN_FROM_APPS":           None,
    "TRANSFER_IN_WIRE":                            None,
    "TRANSFER_IN_OTHER_TRANSFER_IN":               None,
    "TRANSFER_OUT_ACCOUNT_TRANSFER":               None,
    "TRANSFER_OUT_CRYPTO":                         "owner_draw",
    "TRANSFER_OUT_INVESTMENT_AND_RETIREMENT_FUNDS":"owner_draw",
    "TRANSFER_OUT_SAVINGS":                        None,
    "TRANSFER_OUT_TRANSFER_OUT_FROM_APPS":         None,
    "TRANSFER_OUT_WIRE":                           None,
    "TRANSFER_OUT_WITHDRAWAL":                     "owner_draw",
    "TRANSFER_OUT_OTHER_TRANSFER_OUT":             None,

    # ── BANK_FEES ───────────────────────────────────────────────────────
    "BANK_FEES_ATM_FEES":                 "bank_fees",
    "BANK_FEES_INSUFFICIENT_FUNDS":       "bank_fees",
    "BANK_FEES_INTEREST_CHARGE":          "bank_fees",
    "BANK_FEES_FOREIGN_TRANSACTION_FEES": "bank_fees",
    "BANK_FEES_OVERDRAFT_FEES":           "bank_fees",
    "BANK_FEES_LATE_FEES":                "bank_fees",
    "BANK_FEES_CASH_ADVANCE":             "bank_fees",
    "BANK_FEES_OTHER_BANK_FEES":          "bank_fees",

    # ── ENTERTAINMENT ───────────────────────────────────────────────────
    "ENTERTAINMENT_CASINOS_AND_GAMBLING":                     "owner_draw",
    "ENTERTAINMENT_MUSIC_AND_AUDIO":                          "software_saas",
    "ENTERTAINMENT_SPORTING_EVENTS_AMUSEMENT_PARKS_AND_MUSEUMS": "office_supplies",  # low conf
    "ENTERTAINMENT_TV_AND_MOVIES":                            "software_saas",
    "ENTERTAINMENT_VIDEO_GAMES":                              "owner_draw",
    "ENTERTAINMENT_OTHER_ENTERTAINMENT":                      "office_supplies",

    # ── FOOD_AND_DRINK ──────────────────────────────────────────────────
    "FOOD_AND_DRINK_BEER_WINE_AND_LIQUOR":    "meals",
    "FOOD_AND_DRINK_COFFEE":                  "meals",
    "FOOD_AND_DRINK_FAST_FOOD":               "meals",
    "FOOD_AND_DRINK_GROCERIES":               "owner_draw",  # personal by default
    "FOOD_AND_DRINK_RESTAURANT":              "meals",
    "FOOD_AND_DRINK_VENDING_MACHINES":        "meals",
    "FOOD_AND_DRINK_OTHER_FOOD_AND_DRINK":    "meals",

    # ── GENERAL_MERCHANDISE ─────────────────────────────────────────────
    "GENERAL_MERCHANDISE_BOOKSTORES_AND_NEWSSTANDS": "office_supplies",
    "GENERAL_MERCHANDISE_CLOTHING_AND_ACCESSORIES":  "owner_draw",
    "GENERAL_MERCHANDISE_CONVENIENCE_STORES":        "office_supplies",
    "GENERAL_MERCHANDISE_DEPARTMENT_STORES":         "office_supplies",
    "GENERAL_MERCHANDISE_DISCOUNT_STORES":           "office_supplies",
    "GENERAL_MERCHANDISE_ELECTRONICS":               "office_supplies",  # could be fixed asset
    "GENERAL_MERCHANDISE_GIFTS_AND_NOVELTIES":       "marketing",  # client gifts
    "GENERAL_MERCHANDISE_OFFICE_SUPPLIES":           "office_supplies",
    "GENERAL_MERCHANDISE_ONLINE_MARKETPLACES":       "office_supplies",
    "GENERAL_MERCHANDISE_PET_SUPPLIES":              "owner_draw",
    "GENERAL_MERCHANDISE_SPORTING_GOODS":            "owner_draw",
    "GENERAL_MERCHANDISE_SUPERSTORES":               "office_supplies",
    "GENERAL_MERCHANDISE_TOBACCO_AND_VAPE":          "owner_draw",
    "GENERAL_MERCHANDISE_OTHER_GENERAL_MERCHANDISE": "office_supplies",

    # ── HOME_IMPROVEMENT (personal by default; construction should override) ─
    "HOME_IMPROVEMENT_FURNITURE":              "owner_draw",
    "HOME_IMPROVEMENT_HARDWARE":               "owner_draw",
    "HOME_IMPROVEMENT_REPAIR_AND_MAINTENANCE": "owner_draw",
    "HOME_IMPROVEMENT_SECURITY":               "owner_draw",
    "HOME_IMPROVEMENT_OTHER_HOME_IMPROVEMENT": "owner_draw",

    # ── MEDICAL (personal on a business account) ────────────────────────
    "MEDICAL_DENTAL_CARE":                "owner_draw",
    "MEDICAL_EYE_CARE":                   "owner_draw",
    "MEDICAL_NURSING_CARE":               "owner_draw",
    "MEDICAL_PHARMACIES_AND_SUPPLEMENTS": "owner_draw",
    "MEDICAL_PRIMARY_CARE":               "owner_draw",
    "MEDICAL_VETERINARY_SERVICES":        "owner_draw",
    "MEDICAL_OTHER_MEDICAL":              "owner_draw",

    # ── PERSONAL_CARE (personal) ────────────────────────────────────────
    "PERSONAL_CARE_GYMS_AND_FITNESS_CENTERS": "owner_draw",
    "PERSONAL_CARE_HAIR_AND_BEAUTY":          "owner_draw",
    "PERSONAL_CARE_LAUNDRY_AND_DRY_CLEANING": "owner_draw",
    "PERSONAL_CARE_OTHER_PERSONAL_CARE":      "owner_draw",

    # ── GENERAL_SERVICES ────────────────────────────────────────────────
    "GENERAL_SERVICES_ACCOUNTING_AND_FINANCIAL_PLANNING": "professional_fees",
    "GENERAL_SERVICES_AUTOMOTIVE":                        "repairs_maintenance",
    "GENERAL_SERVICES_CHILDCARE":                         "owner_draw",
    "GENERAL_SERVICES_CONSULTING_AND_LEGAL":              "professional_fees",
    "GENERAL_SERVICES_EDUCATION":                         "office_supplies",
    "GENERAL_SERVICES_INSURANCE":                         "insurance",
    "GENERAL_SERVICES_POSTAGE_AND_SHIPPING":              "shipping_cogs",
    "GENERAL_SERVICES_STORAGE":                           "rent",
    "GENERAL_SERVICES_OTHER_GENERAL_SERVICES":            "office_supplies",

    # ── GOVERNMENT_AND_NON_PROFIT ──────────────────────────────────────
    "GOVERNMENT_AND_NON_PROFIT_DONATIONS":                        None,
    "GOVERNMENT_AND_NON_PROFIT_GOVERNMENT_DEPARTMENTS_AND_AGENCIES": "licenses_permits",
    "GOVERNMENT_AND_NON_PROFIT_TAX_PAYMENT":                      "owner_draw",
    "GOVERNMENT_AND_NON_PROFIT_OTHER_GOVERNMENT_AND_NON_PROFIT":  "licenses_permits",

    # ── TRANSPORTATION ──────────────────────────────────────────────────
    "TRANSPORTATION_BIKES_AND_SCOOTERS":    "transportation",
    "TRANSPORTATION_GAS":                   "fuel",
    "TRANSPORTATION_PARKING":               "transportation",
    "TRANSPORTATION_PUBLIC_TRANSIT":        "transportation",
    "TRANSPORTATION_TAXIS_AND_RIDE_SHARES": "transportation",
    "TRANSPORTATION_TOLLS":                 "transportation",
    "TRANSPORTATION_OTHER_TRANSPORTATION":  "transportation",

    # ── TRAVEL ──────────────────────────────────────────────────────────
    "TRAVEL_FLIGHTS":      "travel",
    "TRAVEL_LODGING":      "travel",
    "TRAVEL_RENTAL_CARS":  "travel",
    "TRAVEL_OTHER_TRAVEL": "travel",

    # ── RENT_AND_UTILITIES ──────────────────────────────────────────────
    "RENT_AND_UTILITIES_GAS_AND_ELECTRICITY":         "utilities",
    "RENT_AND_UTILITIES_INTERNET_AND_CABLE":          "telecom",
    "RENT_AND_UTILITIES_RENT":                        "rent",
    "RENT_AND_UTILITIES_SEWAGE_AND_WASTE_MANAGEMENT": "utilities",
    "RENT_AND_UTILITIES_TELEPHONE":                   "telecom",
    "RENT_AND_UTILITIES_WATER":                       "utilities",
    "RENT_AND_UTILITIES_OTHER_UTILITIES":             "utilities",

    # ── OTHER ───────────────────────────────────────────────────────────
    "OTHER_OTHER": None,  # skip — Standard/Global Rules already had a chance
}


# Plaid confidence_level → our 0-1 confidence float.
# Used together with the Standard+ tri-state gate:
#   >= 0.75 → apply, no review flag
#   0.50-0.75 → apply + needs_review
#   < 0.50 → skip
_PLAID_CONF_TO_FLOAT: dict[str, float] = {
    "VERY_HIGH": 0.90,
    "HIGH":      0.85,
    "MEDIUM":    0.70,
    "LOW":       0.55,
    "UNKNOWN":   0.65,
}


def resolve_pfc(
    pfc_detailed: Optional[str],
    plaid_confidence: Optional[str] = None,
) -> Optional[dict]:
    """Given a Plaid PFC detailed key + optional confidence_level,
    return a dict with the semantic key and a 0-1 confidence float,
    or None if we should skip (unmapped PFC, or PFC is None).
    """
    if not pfc_detailed:
        return None
    semantic = PFC_TO_SEMANTIC.get(pfc_detailed)
    if not semantic:
        return None
    conf = _PLAID_CONF_TO_FLOAT.get(
        (plaid_confidence or "UNKNOWN").upper(),
        _PLAID_CONF_TO_FLOAT["UNKNOWN"],
    )
    return {"semantic": semantic, "confidence": conf,
            "pfc_detailed": pfc_detailed,
            "plaid_confidence": plaid_confidence or "UNKNOWN"}


def pfc_coverage() -> dict:
    """Summary stats for the /global-vendor-rules/stats endpoint."""
    total = len(PFC_TO_SEMANTIC)
    mapped = sum(1 for v in PFC_TO_SEMANTIC.values() if v is not None)
    return {"total_pfc_categories": total, "mapped": mapped,
            "skipped": total - mapped}
