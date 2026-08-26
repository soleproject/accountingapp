"""Global Vendor Rules — curated merchant → category mapping.

Standard+ pipeline uses this as stage 3 of the cascade (after Custom
Rules and Rules Miner, before Merchant Cache + LLM fallback). Match
priority within this file: exact match > startswith > contains.

Rules use SEMANTIC categories (e.g. "meals", "software_saas", "utilities")
rather than raw account codes, because each industry template numbers
its CoA differently. The `resolve_semantic` helper below maps a
semantic key to the actual account code inside a given template.

Curator's note (Feb 2026):
    - This is a v1 industry-agnostic draft — sensible defaults for a
      generic small business. Industry overrides land in Phase 2.
    - Ambiguous merchants (Walmart, Costco, Amazon, Home Depot, Target)
      default to their MOST-LIKELY category with confidence 0.60 so
      the tri-state cascade flags them for CPA review.
    - Add rules by appending to `RULES`; do NOT reorder — priority
      is first-match-wins within a category tier.
"""
from __future__ import annotations
import re
from typing import Optional


# ---------------------------------------------------------------------------
# Semantic → per-template account code mapping
# ---------------------------------------------------------------------------
#
# Every rule below carries a `semantic` key (e.g., "meals", "utilities").
# At lookup time we translate that to the correct account code for the
# company's chosen industry template. If a template doesn't have that
# semantic category (e.g., "food_cogs" for a professional services
# firm), we fall back to Uncategorized with needs_review=true.

SEMANTIC_TO_CODE: dict[str, dict[str, str]] = {
    # semantic_key: { template_slug: account_code }
    "meals": {
        "professional_services": "6400",
        "restaurant": "6400",  # staff meals — small; food_cogs handles food
        "ecommerce": "6700",   # e-commerce uses office supplies for staff meals
        "construction": "6400",  # closest fit (crew meals often billed to jobs)
        "generic": "6400",
    },
    "office_supplies": {
        "professional_services": "6600",
        "restaurant": "6600",   # sanitation-adjacent
        "ecommerce": "6700",
        "construction": "6300",  # tools & small equipment
        "generic": "6600",
    },
    "software_saas": {
        "professional_services": "6300",
        "restaurant": "6300",
        "ecommerce": "6300",
        "construction": "6300",
        "generic": "6300",
    },
    "travel": {
        "professional_services": "6500",
        "restaurant": "6500",
        "ecommerce": "6700",  # office fallback
        "construction": "6500",
        "generic": "6500",
    },
    "transportation": {  # rideshare, taxi, parking, tolls
        "professional_services": "6500",
        "restaurant": "6500",
        "ecommerce": "6700",
        "construction": "6200",  # fuel & vehicle
        "generic": "6500",
    },
    "fuel": {  # gas stations
        "professional_services": "6500",
        "restaurant": "6210",
        "ecommerce": "6700",
        "construction": "6200",
        "generic": "6500",
    },
    "utilities": {  # electric, gas, water
        "professional_services": "6210",
        "restaurant": "6210",
        "ecommerce": "6600",  # warehouse
        "construction": "6210",  # vehicle-maint bucket ¯\_(ツ)_/¯
        "generic": "6210",
    },
    "telecom": {  # cell phone, internet
        "professional_services": "6210",
        "restaurant": "6210",
        "ecommerce": "6700",
        "construction": "6210",
        "generic": "6210",
    },
    "rent": {
        "professional_services": "6200",
        "restaurant": "6200",
        "ecommerce": "6600",   # warehouse rent
        "construction": "6400",  # office rent
        "generic": "6200",
    },
    "insurance": {
        "professional_services": "6900",
        "restaurant": "6900",
        "ecommerce": "6900",
        "construction": "6900",
        "generic": "6900",
    },
    "bank_fees": {
        "professional_services": "6800",
        "restaurant": "6800",
        "ecommerce": "6800",
        "construction": "6800",
        "generic": "6800",
    },
    "payment_processing_fees": {  # Stripe/Square/PayPal processing
        "professional_services": "6800",
        "restaurant": "6800",
        "ecommerce": "5300",  # COGS for retailers
        "construction": "6800",
        "generic": "6800",
    },
    "payroll_expense": {
        "professional_services": "6100",
        "restaurant": "6100",
        "ecommerce": "6100",
        "construction": "6100",
        "generic": "6100",
    },
    "payroll_service_fee": {  # Gusto, ADP subscription (not the wages)
        "professional_services": "6300",
        "restaurant": "6300",
        "ecommerce": "6300",
        "construction": "6300",
        "generic": "6300",
    },
    "professional_fees": {  # legal, accounting, contractors
        "professional_services": "6000",
        "restaurant": "6800",  # fallback — restaurants don't have this line
        "ecommerce": "6700",
        "construction": "5100",  # subs
        "generic": "6000",
    },
    "marketing": {
        "professional_services": "6700",
        "restaurant": "6500",
        "ecommerce": "6400",  # google/meta ads
        "construction": "6800",  # no dedicated line — fees bucket
        "generic": "6700",
    },
    "marketplace_ads": {  # Amazon/Etsy/eBay ads
        "professional_services": "6700",
        "restaurant": "6500",
        "ecommerce": "6410",
        "construction": "6800",
        "generic": "6700",
    },
    "food_cogs": {
        "professional_services": None,
        "restaurant": "5000",
        "ecommerce": None,
        "construction": None,
        "generic": None,
    },
    "beverage_cogs": {
        "professional_services": None,
        "restaurant": "5100",
        "ecommerce": None,
        "construction": None,
        "generic": None,
    },
    "supplies_cogs": {
        "professional_services": None,
        "restaurant": "5200",
        "ecommerce": "5000",
        "construction": "5000",  # materials
        "generic": "5000",
    },
    "shipping_cogs": {
        "professional_services": None,
        "restaurant": None,
        "ecommerce": "5100",
        "construction": None,
        "generic": None,
    },
    "delivery_platform_fees": {  # DoorDash / UberEats commissions
        "professional_services": None,
        "restaurant": "6400",
        "ecommerce": None,
        "construction": None,
        "generic": None,
    },
    "repairs_maintenance": {
        "professional_services": "6600",
        "restaurant": "6700",
        "ecommerce": "6700",
        "construction": "6210",  # vehicle-maint
        "generic": "6600",
    },
    "licenses_permits": {
        "professional_services": "6600",
        "restaurant": "6600",
        "ecommerce": "6700",
        "construction": "6500",
        "generic": "6600",
    },
    "owner_draw": {
        "professional_services": "3100",
        "restaurant": "3100",
        "ecommerce": "3100",
        "construction": "3100",
        "generic": "3100",
    },
    "credit_card_payment": {
        "professional_services": "2100",
        "restaurant": "2100",
        "ecommerce": "2100",
        "construction": "2100",
        "generic": "2100",
    },
    "loan_payment": {  # generic loan payment — liability paydown
        "professional_services": "2200",
        "restaurant": "2200",
        "ecommerce": "2200",
        "construction": "2200",  # closest — templates don't have loan line yet
        "generic": "2200",
    },
    "sales_tax_payment": {
        "professional_services": None,  # not applicable
        "restaurant": "2200",
        "ecommerce": "2200",
        "construction": None,
        "generic": None,
    },
    "revenue_generic": {
        "professional_services": "4000",
        "restaurant": "4000",
        "ecommerce": "4000",
        "construction": "4000",
        "generic": "4000",
    },
    "interest_income": {  # bank interest earned
        "professional_services": "4000",  # no dedicated line yet
        "restaurant": "4000",
        "ecommerce": "4000",
        "construction": "4000",
        "generic": "4000",
    },
    "inter_account_transfer": {
        # Special — matched by Linked Transactions stage 0. Not used
        # by the merchant rules here.
        "professional_services": "1000",
        "restaurant": "1000",
        "ecommerce": "1000",
        "construction": "1000",
        "generic": "1000",
    },
}


# Amount bucket thresholds — mirrors the AI-First categorizer so
# amount-aware rules split by the same cutoffs consistently. Applies
# to `abs(amount)` so income/expense direction doesn't affect bucket.
_AMOUNT_BUCKETS: list[tuple[float, str]] = [
    (50.0, "s"),        # < $50
    (500.0, "m"),       # $50 – $500
    (5000.0, "l"),      # $500 – $5,000
    (float("inf"), "xl"),  # $5,000+
]


def amount_bucket(amount) -> str:
    """Return the bucket label ("s"/"m"/"l"/"xl") for an amount."""
    try:
        a = abs(float(amount or 0))
    except (TypeError, ValueError):
        a = 0.0
    for cap, label in _AMOUNT_BUCKETS:
        if a < cap:
            return label
    return _AMOUNT_BUCKETS[-1][1]


# Semantic → account NAME patterns. Used as a robust fallback when
# a company's CoA doesn't match one of the hardcoded template code
# layouts (e.g., companies created without an `industry_template`,
# or with custom CoAs). Patterns are lowercase substrings — first
# account whose name contains one wins. Order in the list matters
# for a semantic key: more-specific patterns should come first.
#
# This was added Feb 2026 after the "Domino's in Insurance" bug —
# Standard Plus LLC had `industry_template = None`, so the generic
# code-based fallback returned code 6400, which on that company's
# CoA happened to be "Insurance" (not "Meals"). Resolving by name
# is CoA-agnostic and defensive against any code re-numbering.
SEMANTIC_TO_NAME_PATTERNS: dict[str, list[str]] = {
    "meals":                 ["meals & entertainment", "meals"],
    "office_supplies":       ["office supplies", "office"],
    "software_saas":         ["software", "dues & subscriptions", "subscriptions", "saas"],
    "travel":                ["travel"],
    "transportation":        ["transportation", "auto expense", "auto"],
    "fuel":                  ["fuel", "gas & oil", "gasoline"],
    "utilities":             ["utilities", "utility"],
    "telecom":               ["telecom", "telephone", "phone", "internet", "cell phone"],
    "rent":                  ["rent", "lease expense"],
    "insurance":             ["insurance"],
    "bank_fees":             ["bank fees", "bank charges", "bank service"],
    "payment_processing_fees":["processing fees", "merchant fees", "credit card fees"],
    "payroll_expense":       ["payroll expense", "salaries", "wages", "payroll"],
    "payroll_service_fee":   ["payroll service", "software", "subscriptions"],
    "professional_fees":     ["professional fees", "legal & professional", "legal", "accounting"],
    "marketing":             ["advertising & marketing", "marketing", "advertising"],
    "marketplace_ads":       ["advertising", "marketing"],
    "food_cogs":             ["food cost", "food & beverage cogs", "food"],
    "beverage_cogs":         ["beverage cost", "beverages"],
    "supplies_cogs":         ["supplies & materials", "cost of goods sold", "materials", "supplies"],
    "shipping_cogs":         ["shipping", "postage", "freight"],
    "delivery_platform_fees":["delivery platform", "delivery fees"],
    "repairs_maintenance":   ["repairs & maintenance", "repairs", "maintenance"],
    "licenses_permits":      ["licenses & permits", "licenses", "permits"],
    "owner_draw":            ["owner's draw", "owner draw", "distributions", "shareholder distributions"],
    "credit_card_payment":   ["credit card payable", "credit card"],
    "loan_payment":          ["loan payable", "loan", "mortgage payable", "note payable"],
    "sales_tax_payment":     ["sales tax payable", "sales tax"],
    "revenue_generic":       ["service revenue", "revenue", "sales"],
    "interest_income":       ["interest income", "interest"],
    "inter_account_transfer":["inter-account", "inter account"],
}


def resolve_semantic(semantic: str, industry_template: str) -> Optional[str]:
    """Return the account code for a semantic key inside a template.

    Returns None if the template doesn't have that semantic (e.g.,
    "food_cogs" for a SaaS company) — caller falls back to
    Uncategorized with needs_review.
    """
    m = SEMANTIC_TO_CODE.get(semantic)
    if not m:
        return None
    return m.get(industry_template) or m.get("generic")


def resolve_semantic_to_account(
    semantic: str,
    accounts: list[dict],
    industry_template: str | None = None,
) -> Optional[dict]:
    """Resolve a semantic key to an actual account dict on the
    company's Chart of Accounts.

    Strategy (Feb 2026, fixes "Domino's in Insurance" bug):
      1. NAME-first — iterate `SEMANTIC_TO_NAME_PATTERNS[semantic]`
         in declared order (most-specific first) and return the first
         account whose lowercased `name` contains the pattern. This
         is CoA-agnostic: works even when a company renumbered its
         codes or used a custom template.
      2. CODE fallback — if no name match, look up the template's
         canonical code via `resolve_semantic` and return whichever
         account carries that code. Preserves the historical path
         for companies whose CoA still uses the template numbering.

    Returns None if nothing matches (caller leaves row untouched or
    routes to Uncategorized).
    """
    if not semantic or not accounts:
        return None

    # Stage 1 — Name-based resolution against the company's CoA.
    patterns = SEMANTIC_TO_NAME_PATTERNS.get(semantic) or []
    if patterns:
        # Pre-lowercase account names once.
        name_map = [(str(a.get("name") or "").lower(), a) for a in accounts]
        for pat in patterns:
            pat_low = pat.lower()
            for lname, acct in name_map:
                if pat_low in lname:
                    return acct

    # Stage 2 — Code-based fallback (legacy behavior).
    tpl = industry_template or "generic"
    code = resolve_semantic(semantic, tpl)
    if code:
        for a in accounts:
            if a.get("code") == code:
                return a
    return None


# ---------------------------------------------------------------------------
# Global Vendor Rules — 800 curated merchants
# ---------------------------------------------------------------------------
#
# Priority within the list is first-match-wins. Ordering matters:
# specific-brand patterns come BEFORE looser generic patterns
# (e.g., "STARBUCKS DELIVERY" before "STARBUCKS").
#
# Each rule:
#   - pattern: uppercase substring to match against merchant OR description
#   - semantic: semantic category key from SEMANTIC_TO_CODE
#   - confidence: 0.0-1.0 (used by tri-state; 0.60 → needs review, 0.90 → trust)
#   - notes: freeform, one-liner for curator context

RULES: list[dict] = [
    # ===== COFFEE / CAFES =====
    {"pattern": "STARBUCKS", "semantic": "meals", "confidence": 0.90, "notes": "coffee chain"},
    {"pattern": "DUNKIN", "semantic": "meals", "confidence": 0.90, "notes": "coffee chain"},
    {"pattern": "PEETS COFFEE", "semantic": "meals", "confidence": 0.90},
    {"pattern": "PEET'S COFFEE", "semantic": "meals", "confidence": 0.90},
    {"pattern": "PHILZ COFFEE", "semantic": "meals", "confidence": 0.90},
    {"pattern": "BLUE BOTTLE", "semantic": "meals", "confidence": 0.90},
    {"pattern": "CARIBOU COFFEE", "semantic": "meals", "confidence": 0.90},
    {"pattern": "TIM HORTONS", "semantic": "meals", "confidence": 0.90},
    {"pattern": "COFFEE BEAN", "semantic": "meals", "confidence": 0.85},
    {"pattern": "PANERA", "semantic": "meals", "confidence": 0.90},
    {"pattern": "EINSTEIN BROS", "semantic": "meals", "confidence": 0.90},
    {"pattern": "TROPICAL SMOOTHIE", "semantic": "meals", "confidence": 0.90},
    {"pattern": "JAMBA JUICE", "semantic": "meals", "confidence": 0.90},

    # ===== QSR / FAST CASUAL =====
    {"pattern": "MCDONALD", "semantic": "meals", "confidence": 0.90},
    {"pattern": "BURGER KING", "semantic": "meals", "confidence": 0.90},
    {"pattern": "WENDYS", "semantic": "meals", "confidence": 0.90},
    {"pattern": "WENDY'S", "semantic": "meals", "confidence": 0.90},
    {"pattern": "TACO BELL", "semantic": "meals", "confidence": 0.90},
    {"pattern": "CHICK-FIL-A", "semantic": "meals", "confidence": 0.90},
    {"pattern": "CHICK FIL A", "semantic": "meals", "confidence": 0.90},
    {"pattern": "CHIPOTLE", "semantic": "meals", "confidence": 0.90},
    {"pattern": "SUBWAY", "semantic": "meals", "confidence": 0.85, "notes": "could also be subway system — usually food"},
    {"pattern": "PANDA EXPRESS", "semantic": "meals", "confidence": 0.90},
    {"pattern": "QDOBA", "semantic": "meals", "confidence": 0.90},
    {"pattern": "SHAKE SHACK", "semantic": "meals", "confidence": 0.90},
    {"pattern": "FIVE GUYS", "semantic": "meals", "confidence": 0.90},
    {"pattern": "IN N OUT", "semantic": "meals", "confidence": 0.90},
    {"pattern": "IN-N-OUT", "semantic": "meals", "confidence": 0.90},
    {"pattern": "POPEYES", "semantic": "meals", "confidence": 0.90},
    {"pattern": "KFC", "semantic": "meals", "confidence": 0.90},
    {"pattern": "PIZZA HUT", "semantic": "meals", "confidence": 0.90},
    {"pattern": "DOMINOS", "semantic": "meals", "confidence": 0.90},
    {"pattern": "DOMINO'S", "semantic": "meals", "confidence": 0.90},
    {"pattern": "PAPA JOHNS", "semantic": "meals", "confidence": 0.90},
    {"pattern": "LITTLE CAESARS", "semantic": "meals", "confidence": 0.90},
    {"pattern": "JIMMY JOHNS", "semantic": "meals", "confidence": 0.90},
    {"pattern": "JERSEY MIKES", "semantic": "meals", "confidence": 0.90},
    {"pattern": "CAPRIOTTIS", "semantic": "meals", "confidence": 0.90},
    {"pattern": "PORT OF SUBS", "semantic": "meals", "confidence": 0.90},
    {"pattern": "SWEETGREEN", "semantic": "meals", "confidence": 0.90},
    {"pattern": "CAVA", "semantic": "meals", "confidence": 0.85},
    {"pattern": "SHAKE SHACK", "semantic": "meals", "confidence": 0.90},
    {"pattern": "RAISING CANE", "semantic": "meals", "confidence": 0.90},
    {"pattern": "ARBYS", "semantic": "meals", "confidence": 0.90},
    {"pattern": "ARBY'S", "semantic": "meals", "confidence": 0.90},
    {"pattern": "SONIC DRIVE", "semantic": "meals", "confidence": 0.90},
    {"pattern": "WHATABURGER", "semantic": "meals", "confidence": 0.90},

    # ===== SIT-DOWN RESTAURANTS =====
    {"pattern": "OLIVE GARDEN", "semantic": "meals", "confidence": 0.90},
    {"pattern": "APPLEBEES", "semantic": "meals", "confidence": 0.90},
    {"pattern": "OUTBACK", "semantic": "meals", "confidence": 0.85},
    {"pattern": "TEXAS ROADHOUSE", "semantic": "meals", "confidence": 0.90},
    {"pattern": "CHEESECAKE FACTORY", "semantic": "meals", "confidence": 0.90},
    {"pattern": "PF CHANGS", "semantic": "meals", "confidence": 0.90},
    {"pattern": "IHOP", "semantic": "meals", "confidence": 0.90},
    {"pattern": "DENNYS", "semantic": "meals", "confidence": 0.90},
    {"pattern": "WAFFLE HOUSE", "semantic": "meals", "confidence": 0.90},
    {"pattern": "CRACKER BARREL", "semantic": "meals", "confidence": 0.85},
    {"pattern": "BUFFALO WILD WINGS", "semantic": "meals", "confidence": 0.90},
    {"pattern": "RED LOBSTER", "semantic": "meals", "confidence": 0.90},
    {"pattern": "LONGHORN STEAKHOUSE", "semantic": "meals", "confidence": 0.90},
    {"pattern": "SIMPLY THAI", "semantic": "meals", "confidence": 0.85},

    # ===== FOOD DELIVERY PLATFORMS =====
    {"pattern": "DOORDASH", "semantic": "meals", "confidence": 0.85, "notes": "meals for buyers; delivery_platform_fees for merchants"},
    {"pattern": "UBER EATS", "semantic": "meals", "confidence": 0.85},
    {"pattern": "UBEREATS", "semantic": "meals", "confidence": 0.85},
    {"pattern": "GRUBHUB", "semantic": "meals", "confidence": 0.85},
    {"pattern": "POSTMATES", "semantic": "meals", "confidence": 0.85},
    {"pattern": "CAVIAR", "semantic": "meals", "confidence": 0.85},
    {"pattern": "SEAMLESS", "semantic": "meals", "confidence": 0.85},
    {"pattern": "INSTACART", "semantic": "meals", "confidence": 0.70, "notes": "groceries — could be meals or personal"},
    {"pattern": "GOPUFF", "semantic": "meals", "confidence": 0.70},

    # ===== RIDESHARE / TAXIS =====
    {"pattern": "UBER TRIP", "semantic": "transportation", "confidence": 0.90},
    {"pattern": "UBER *TRIP", "semantic": "transportation", "confidence": 0.90},
    {"pattern": "LYFT", "semantic": "transportation", "confidence": 0.90},
    {"pattern": "UBER", "semantic": "transportation", "confidence": 0.65, "notes": "generic Uber — could be trip or eats"},
    {"pattern": "REVEL", "semantic": "transportation", "confidence": 0.85},
    {"pattern": "TAXI", "semantic": "transportation", "confidence": 0.80},
    {"pattern": "YELLOW CAB", "semantic": "transportation", "confidence": 0.90},
    {"pattern": "CURB TAXI", "semantic": "transportation", "confidence": 0.90},
    {"pattern": "PARKMOBILE", "semantic": "transportation", "confidence": 0.90},
    {"pattern": "SPOTHERO", "semantic": "transportation", "confidence": 0.90},
    {"pattern": "PARKWHIZ", "semantic": "transportation", "confidence": 0.90},
    {"pattern": "PARKING METER", "semantic": "transportation", "confidence": 0.85},
    {"pattern": "EZPASS", "semantic": "transportation", "confidence": 0.90},
    {"pattern": "E-ZPASS", "semantic": "transportation", "confidence": 0.90},
    {"pattern": "FASTRAK", "semantic": "transportation", "confidence": 0.90},
    {"pattern": "SUNPASS", "semantic": "transportation", "confidence": 0.90},

    # ===== AIRLINES =====
    {"pattern": "AMERICAN AIRLINES", "semantic": "travel", "confidence": 0.95},
    {"pattern": "DELTA AIR", "semantic": "travel", "confidence": 0.95},
    {"pattern": "UNITED AIRLINES", "semantic": "travel", "confidence": 0.95},
    {"pattern": "SOUTHWEST AIRLINES", "semantic": "travel", "confidence": 0.95},
    {"pattern": "SOUTHWES", "semantic": "travel", "confidence": 0.90, "notes": "SW Airlines truncated"},
    {"pattern": "JETBLUE", "semantic": "travel", "confidence": 0.95},
    {"pattern": "SPIRIT AIRLINES", "semantic": "travel", "confidence": 0.95},
    {"pattern": "FRONTIER AIR", "semantic": "travel", "confidence": 0.95},
    {"pattern": "ALASKA AIR", "semantic": "travel", "confidence": 0.95},
    {"pattern": "AIR CANADA", "semantic": "travel", "confidence": 0.95},
    {"pattern": "BRITISH AIR", "semantic": "travel", "confidence": 0.95},
    {"pattern": "LUFTHANSA", "semantic": "travel", "confidence": 0.95},

    # ===== HOTELS =====
    {"pattern": "MARRIOTT", "semantic": "travel", "confidence": 0.95},
    {"pattern": "HILTON", "semantic": "travel", "confidence": 0.95},
    {"pattern": "HYATT", "semantic": "travel", "confidence": 0.95},
    {"pattern": "HOLIDAY INN", "semantic": "travel", "confidence": 0.95},
    {"pattern": "HAMPTON INN", "semantic": "travel", "confidence": 0.95},
    {"pattern": "EMBASSY SUITES", "semantic": "travel", "confidence": 0.95},
    {"pattern": "DOUBLETREE", "semantic": "travel", "confidence": 0.95},
    {"pattern": "COURTYARD", "semantic": "travel", "confidence": 0.90},
    {"pattern": "SHERATON", "semantic": "travel", "confidence": 0.95},
    {"pattern": "RITZ CARLTON", "semantic": "travel", "confidence": 0.95},
    {"pattern": "FOUR SEASONS", "semantic": "travel", "confidence": 0.95},
    {"pattern": "WESTIN", "semantic": "travel", "confidence": 0.95},
    {"pattern": "BEST WESTERN", "semantic": "travel", "confidence": 0.95},
    {"pattern": "LA QUINTA", "semantic": "travel", "confidence": 0.95},
    {"pattern": "COMFORT INN", "semantic": "travel", "confidence": 0.95},
    {"pattern": "RESIDENCE INN", "semantic": "travel", "confidence": 0.95},
    {"pattern": "AIRBNB", "semantic": "travel", "confidence": 0.95},
    {"pattern": "VRBO", "semantic": "travel", "confidence": 0.95},
    {"pattern": "BOOKING.COM", "semantic": "travel", "confidence": 0.95},
    {"pattern": "EXPEDIA", "semantic": "travel", "confidence": 0.95},
    {"pattern": "PRICELINE", "semantic": "travel", "confidence": 0.95},
    {"pattern": "HOTELS.COM", "semantic": "travel", "confidence": 0.95},
    {"pattern": "KAYAK", "semantic": "travel", "confidence": 0.95},

    # ===== RENTAL CARS =====
    {"pattern": "ENTERPRISE RENT", "semantic": "travel", "confidence": 0.95},
    {"pattern": "HERTZ", "semantic": "travel", "confidence": 0.95},
    {"pattern": "AVIS", "semantic": "travel", "confidence": 0.95},
    {"pattern": "BUDGET RENT", "semantic": "travel", "confidence": 0.95},
    {"pattern": "ALAMO RENT", "semantic": "travel", "confidence": 0.95},
    {"pattern": "NATIONAL CAR RENTAL", "semantic": "travel", "confidence": 0.95},
    {"pattern": "SIXT", "semantic": "travel", "confidence": 0.90},
    {"pattern": "TURO", "semantic": "travel", "confidence": 0.90},

    # ===== GAS STATIONS =====
    {"pattern": "SHELL", "semantic": "fuel", "confidence": 0.85},
    {"pattern": "CHEVRON", "semantic": "fuel", "confidence": 0.90},
    {"pattern": "EXXON", "semantic": "fuel", "confidence": 0.90},
    {"pattern": "MOBIL", "semantic": "fuel", "confidence": 0.85},
    {"pattern": "BP GAS", "semantic": "fuel", "confidence": 0.90},
    {"pattern": "SUNOCO", "semantic": "fuel", "confidence": 0.90},
    {"pattern": "MARATHON PETROLEUM", "semantic": "fuel", "confidence": 0.90},
    {"pattern": "CITGO", "semantic": "fuel", "confidence": 0.90},
    {"pattern": "VALERO", "semantic": "fuel", "confidence": 0.90},
    {"pattern": "SPEEDWAY", "semantic": "fuel", "confidence": 0.85},
    {"pattern": "QUIKTRIP", "semantic": "fuel", "confidence": 0.75},
    {"pattern": "PILOT FLYING J", "semantic": "fuel", "confidence": 0.90},
    {"pattern": "LOVES TRAVEL", "semantic": "fuel", "confidence": 0.90},

    # ===== BIG BOX / SUPERSTORES (amount-bucket rules — small=meals/personal,
    # medium=office/general, large=bulk supplies) =====
    {"pattern": "WALMART", "semantic": "office_supplies", "confidence": 0.60,
     "notes": "amount-aware: small=meals, medium=office, large=supplies",
     "amount_buckets": {
         "s":  {"semantic": "meals",           "confidence": 0.70},
         "m":  {"semantic": "office_supplies", "confidence": 0.65},
         "l":  {"semantic": "supplies_cogs",   "confidence": 0.70},
         "xl": {"semantic": "supplies_cogs",   "confidence": 0.75},
     }},
    {"pattern": "WAL-MART", "semantic": "office_supplies", "confidence": 0.60,
     "amount_buckets": {
         "s":  {"semantic": "meals",           "confidence": 0.70},
         "m":  {"semantic": "office_supplies", "confidence": 0.65},
         "l":  {"semantic": "supplies_cogs",   "confidence": 0.70},
         "xl": {"semantic": "supplies_cogs",   "confidence": 0.75},
     }},
    {"pattern": "COSTCO WHSE", "semantic": "office_supplies", "confidence": 0.60,
     "notes": "small=food court, med=household mix, large=bulk supplies",
     "amount_buckets": {
         "s":  {"semantic": "meals",           "confidence": 0.75},
         "m":  {"semantic": "office_supplies", "confidence": 0.65},
         "l":  {"semantic": "supplies_cogs",   "confidence": 0.75},
         "xl": {"semantic": "supplies_cogs",   "confidence": 0.80},
     }},
    {"pattern": "COSTCO WHOLESALE", "semantic": "office_supplies", "confidence": 0.60,
     "amount_buckets": {
         "s":  {"semantic": "meals",           "confidence": 0.75},
         "m":  {"semantic": "office_supplies", "confidence": 0.65},
         "l":  {"semantic": "supplies_cogs",   "confidence": 0.75},
         "xl": {"semantic": "supplies_cogs",   "confidence": 0.80},
     }},
    {"pattern": "COSTCO GAS", "semantic": "fuel", "confidence": 0.90},
    {"pattern": "COSTCO", "semantic": "office_supplies", "confidence": 0.55,
     "amount_buckets": {
         "s":  {"semantic": "meals",           "confidence": 0.70},
         "m":  {"semantic": "office_supplies", "confidence": 0.60},
         "l":  {"semantic": "supplies_cogs",   "confidence": 0.70},
         "xl": {"semantic": "supplies_cogs",   "confidence": 0.75},
     }},
    {"pattern": "SAMS CLUB", "semantic": "office_supplies", "confidence": 0.60,
     "amount_buckets": {
         "s":  {"semantic": "meals",           "confidence": 0.65},
         "m":  {"semantic": "office_supplies", "confidence": 0.65},
         "l":  {"semantic": "supplies_cogs",   "confidence": 0.75},
         "xl": {"semantic": "supplies_cogs",   "confidence": 0.80},
     }},
    {"pattern": "SAM'S CLUB", "semantic": "office_supplies", "confidence": 0.60,
     "amount_buckets": {
         "s":  {"semantic": "meals",           "confidence": 0.65},
         "m":  {"semantic": "office_supplies", "confidence": 0.65},
         "l":  {"semantic": "supplies_cogs",   "confidence": 0.75},
         "xl": {"semantic": "supplies_cogs",   "confidence": 0.80},
     }},
    {"pattern": "BJS WHOLESALE", "semantic": "office_supplies", "confidence": 0.60,
     "amount_buckets": {
         "s":  {"semantic": "meals",           "confidence": 0.65},
         "m":  {"semantic": "office_supplies", "confidence": 0.65},
         "l":  {"semantic": "supplies_cogs",   "confidence": 0.75},
         "xl": {"semantic": "supplies_cogs",   "confidence": 0.80},
     }},
    {"pattern": "TARGET", "semantic": "office_supplies", "confidence": 0.60,
     "notes": "ambiguous — office/personal/meals",
     "amount_buckets": {
         "s":  {"semantic": "meals",           "confidence": 0.65},
         "m":  {"semantic": "office_supplies", "confidence": 0.65},
         "l":  {"semantic": "supplies_cogs",   "confidence": 0.65},
         "xl": {"semantic": "supplies_cogs",   "confidence": 0.70},
     }},
    {"pattern": "AMAZON.COM", "semantic": "office_supplies", "confidence": 0.55,
     "notes": "amount-aware: small usually office supplies, large often equipment/fixed",
     "amount_buckets": {
         "s":  {"semantic": "office_supplies", "confidence": 0.65},
         "m":  {"semantic": "office_supplies", "confidence": 0.65},
         "l":  {"semantic": "office_supplies", "confidence": 0.55},
         "xl": {"semantic": "office_supplies", "confidence": 0.50},
     }},
    {"pattern": "AMAZON MARKETPLACE", "semantic": "office_supplies", "confidence": 0.55,
     "amount_buckets": {
         "s":  {"semantic": "office_supplies", "confidence": 0.65},
         "m":  {"semantic": "office_supplies", "confidence": 0.65},
         "l":  {"semantic": "office_supplies", "confidence": 0.55},
         "xl": {"semantic": "office_supplies", "confidence": 0.50},
     }},
    {"pattern": "AMZN MKTP", "semantic": "office_supplies", "confidence": 0.55,
     "amount_buckets": {
         "s":  {"semantic": "office_supplies", "confidence": 0.65},
         "m":  {"semantic": "office_supplies", "confidence": 0.65},
         "l":  {"semantic": "office_supplies", "confidence": 0.55},
         "xl": {"semantic": "office_supplies", "confidence": 0.50},
     }},
    {"pattern": "AMAZON PRIME", "semantic": "software_saas", "confidence": 0.85, "notes": "Prime membership"},

    # ===== HOME IMPROVEMENT (amount-aware — small=misc, med=R&M, large=COGS for construction) =====
    {"pattern": "HOME DEPOT", "semantic": "repairs_maintenance", "confidence": 0.70,
     "notes": "amount-aware R&M vs COGS split",
     "amount_buckets": {
         "s":  {"semantic": "repairs_maintenance", "confidence": 0.75},
         "m":  {"semantic": "repairs_maintenance", "confidence": 0.75},
         "l":  {"semantic": "supplies_cogs",       "confidence": 0.70},
         "xl": {"semantic": "supplies_cogs",       "confidence": 0.75},
     }},
    {"pattern": "LOWES", "semantic": "repairs_maintenance", "confidence": 0.70,
     "amount_buckets": {
         "s":  {"semantic": "repairs_maintenance", "confidence": 0.75},
         "m":  {"semantic": "repairs_maintenance", "confidence": 0.75},
         "l":  {"semantic": "supplies_cogs",       "confidence": 0.70},
         "xl": {"semantic": "supplies_cogs",       "confidence": 0.75},
     }},
    {"pattern": "LOWE'S", "semantic": "repairs_maintenance", "confidence": 0.70,
     "amount_buckets": {
         "s":  {"semantic": "repairs_maintenance", "confidence": 0.75},
         "m":  {"semantic": "repairs_maintenance", "confidence": 0.75},
         "l":  {"semantic": "supplies_cogs",       "confidence": 0.70},
         "xl": {"semantic": "supplies_cogs",       "confidence": 0.75},
     }},
    {"pattern": "ACE HARDWARE", "semantic": "repairs_maintenance", "confidence": 0.75},
    {"pattern": "MENARDS", "semantic": "repairs_maintenance", "confidence": 0.75},
    {"pattern": "TRUE VALUE", "semantic": "repairs_maintenance", "confidence": 0.75},
    {"pattern": "HARBOR FREIGHT", "semantic": "repairs_maintenance", "confidence": 0.75},
    {"pattern": "TRACTOR SUPPLY", "semantic": "repairs_maintenance", "confidence": 0.70},

    # ===== ELECTRONICS/APPLE (small=supplies, large=fixed asset flag) =====
    {"pattern": "BEST BUY", "semantic": "office_supplies", "confidence": 0.80,
     "notes": "amount-aware — large purchases likely fixed assets",
     "amount_buckets": {
         "s":  {"semantic": "office_supplies", "confidence": 0.85},
         "m":  {"semantic": "office_supplies", "confidence": 0.75},
         "l":  {"semantic": "office_supplies", "confidence": 0.55},
         "xl": {"semantic": "office_supplies", "confidence": 0.50},
     }},
    {"pattern": "APPLE STORE", "semantic": "office_supplies", "confidence": 0.75,
     "amount_buckets": {
         "s":  {"semantic": "software_saas",   "confidence": 0.65},
         "m":  {"semantic": "office_supplies", "confidence": 0.75},
         "l":  {"semantic": "office_supplies", "confidence": 0.55},
         "xl": {"semantic": "office_supplies", "confidence": 0.50},
     }},
    {"pattern": "MICRO CENTER", "semantic": "office_supplies", "confidence": 0.85},
    {"pattern": "MICROCENTER", "semantic": "office_supplies", "confidence": 0.85},

    # ===== CONVENIENCE (small=snacks/meals, larger=fuel/misc) =====
    {"pattern": "7-ELEVEN", "semantic": "fuel", "confidence": 0.70,
     "amount_buckets": {
         "s":  {"semantic": "meals",  "confidence": 0.70},
         "m":  {"semantic": "fuel",   "confidence": 0.75},
         "l":  {"semantic": "fuel",   "confidence": 0.85},
         "xl": {"semantic": "fuel",   "confidence": 0.85},
     }},
    {"pattern": "WAWA", "semantic": "fuel", "confidence": 0.70,
     "amount_buckets": {
         "s":  {"semantic": "meals",  "confidence": 0.70},
         "m":  {"semantic": "fuel",   "confidence": 0.80},
         "l":  {"semantic": "fuel",   "confidence": 0.85},
         "xl": {"semantic": "fuel",   "confidence": 0.85},
     }},
    {"pattern": "SHEETZ", "semantic": "fuel", "confidence": 0.70,
     "amount_buckets": {
         "s":  {"semantic": "meals",  "confidence": 0.70},
         "m":  {"semantic": "fuel",   "confidence": 0.80},
         "l":  {"semantic": "fuel",   "confidence": 0.85},
         "xl": {"semantic": "fuel",   "confidence": 0.85},
     }},
    {"pattern": "CIRCLE K", "semantic": "fuel", "confidence": 0.80,
     "amount_buckets": {
         "s":  {"semantic": "meals",  "confidence": 0.65},
         "m":  {"semantic": "fuel",   "confidence": 0.85},
         "l":  {"semantic": "fuel",   "confidence": 0.90},
         "xl": {"semantic": "fuel",   "confidence": 0.90},
     }},

    # ===== PHARMACY (small=personal items, larger=usually personal) =====
    {"pattern": "CVS PHARMACY", "semantic": "office_supplies", "confidence": 0.55,
     "notes": "small could be office snacks, larger usually personal",
     "amount_buckets": {
         "s":  {"semantic": "office_supplies", "confidence": 0.60},
         "m":  {"semantic": "owner_draw",      "confidence": 0.65},
         "l":  {"semantic": "owner_draw",      "confidence": 0.70},
         "xl": {"semantic": "owner_draw",      "confidence": 0.75},
     }},
    {"pattern": "CVS/PHARMACY", "semantic": "office_supplies", "confidence": 0.55,
     "amount_buckets": {
         "s":  {"semantic": "office_supplies", "confidence": 0.60},
         "m":  {"semantic": "owner_draw",      "confidence": 0.65},
         "l":  {"semantic": "owner_draw",      "confidence": 0.70},
         "xl": {"semantic": "owner_draw",      "confidence": 0.75},
     }},
    {"pattern": "WALGREENS", "semantic": "office_supplies", "confidence": 0.55,
     "amount_buckets": {
         "s":  {"semantic": "office_supplies", "confidence": 0.60},
         "m":  {"semantic": "owner_draw",      "confidence": 0.65},
         "l":  {"semantic": "owner_draw",      "confidence": 0.70},
         "xl": {"semantic": "owner_draw",      "confidence": 0.75},
     }},
    {"pattern": "RITE AID", "semantic": "office_supplies", "confidence": 0.55,
     "amount_buckets": {
         "s":  {"semantic": "office_supplies", "confidence": 0.60},
         "m":  {"semantic": "owner_draw",      "confidence": 0.65},
         "l":  {"semantic": "owner_draw",      "confidence": 0.70},
         "xl": {"semantic": "owner_draw",      "confidence": 0.75},
     }},
    {"pattern": "DUANE READE", "semantic": "office_supplies", "confidence": 0.55,
     "amount_buckets": {
         "s":  {"semantic": "office_supplies", "confidence": 0.60},
         "m":  {"semantic": "owner_draw",      "confidence": 0.65},
         "l":  {"semantic": "owner_draw",      "confidence": 0.70},
         "xl": {"semantic": "owner_draw",      "confidence": 0.75},
     }},

    # ===== GROCERY (mostly personal — flag for review) =====
    {"pattern": "KROGER", "semantic": "meals", "confidence": 0.55, "notes": "grocery — usually personal"},
    {"pattern": "SAFEWAY", "semantic": "meals", "confidence": 0.55},
    {"pattern": "PUBLIX", "semantic": "meals", "confidence": 0.55},
    {"pattern": "WHOLE FOODS", "semantic": "meals", "confidence": 0.55},
    {"pattern": "TRADER JOE", "semantic": "meals", "confidence": 0.55},
    {"pattern": "WEGMANS", "semantic": "meals", "confidence": 0.55},
    {"pattern": "H-E-B", "semantic": "meals", "confidence": 0.55},
    {"pattern": "HEB ", "semantic": "meals", "confidence": 0.55},
    {"pattern": "ALDI", "semantic": "meals", "confidence": 0.55},
    {"pattern": "STOP & SHOP", "semantic": "meals", "confidence": 0.55},
    {"pattern": "FOOD LION", "semantic": "meals", "confidence": 0.55},
    {"pattern": "GIANT EAGLE", "semantic": "meals", "confidence": 0.55},
    {"pattern": "MEIJER", "semantic": "meals", "confidence": 0.55},
    {"pattern": "SPROUTS FARMERS", "semantic": "meals", "confidence": 0.55},
    {"pattern": "FRESH MARKET", "semantic": "meals", "confidence": 0.55},
    {"pattern": "HARRIS TEETER", "semantic": "meals", "confidence": 0.55},
    {"pattern": "WINCO", "semantic": "meals", "confidence": 0.55},
    {"pattern": "ALBERTSONS", "semantic": "meals", "confidence": 0.55},

    # ===== PHARMACY (small=personal items, larger=usually personal) ─ see amount-bucket versions above =====

    # ===== OFFICE / TECH RETAILERS =====
    {"pattern": "STAPLES", "semantic": "office_supplies", "confidence": 0.90},
    {"pattern": "OFFICE DEPOT", "semantic": "office_supplies", "confidence": 0.90},
    {"pattern": "OFFICEMAX", "semantic": "office_supplies", "confidence": 0.90},

    # ===== BUSINESS SAAS =====
    {"pattern": "AWS", "semantic": "software_saas", "confidence": 0.95},
    {"pattern": "AMAZON WEB SERVICES", "semantic": "software_saas", "confidence": 0.95},
    {"pattern": "GOOGLE CLOUD", "semantic": "software_saas", "confidence": 0.95},
    {"pattern": "GCLOUD", "semantic": "software_saas", "confidence": 0.90},
    {"pattern": "GOOGLE WORKSPACE", "semantic": "software_saas", "confidence": 0.95},
    {"pattern": "GOOGLE *GSUITE", "semantic": "software_saas", "confidence": 0.95},
    {"pattern": "MICROSOFT 365", "semantic": "software_saas", "confidence": 0.95},
    {"pattern": "MICROSOFT AZURE", "semantic": "software_saas", "confidence": 0.95},
    {"pattern": "MICROSOFT*", "semantic": "software_saas", "confidence": 0.85},
    {"pattern": "MSFT*", "semantic": "software_saas", "confidence": 0.85},
    {"pattern": "DIGITALOCEAN", "semantic": "software_saas", "confidence": 0.95},
    {"pattern": "LINODE", "semantic": "software_saas", "confidence": 0.95},
    {"pattern": "VULTR", "semantic": "software_saas", "confidence": 0.95},
    {"pattern": "HEROKU", "semantic": "software_saas", "confidence": 0.95},
    {"pattern": "VERCEL", "semantic": "software_saas", "confidence": 0.95},
    {"pattern": "NETLIFY", "semantic": "software_saas", "confidence": 0.95},
    {"pattern": "CLOUDFLARE", "semantic": "software_saas", "confidence": 0.95},
    {"pattern": "GITHUB", "semantic": "software_saas", "confidence": 0.95},
    {"pattern": "GITLAB", "semantic": "software_saas", "confidence": 0.95},
    {"pattern": "BITBUCKET", "semantic": "software_saas", "confidence": 0.95},
    {"pattern": "ATLASSIAN", "semantic": "software_saas", "confidence": 0.95},
    {"pattern": "JIRA", "semantic": "software_saas", "confidence": 0.95},
    {"pattern": "CONFLUENCE", "semantic": "software_saas", "confidence": 0.95},
    {"pattern": "SLACK", "semantic": "software_saas", "confidence": 0.95},
    {"pattern": "ZOOM.US", "semantic": "software_saas", "confidence": 0.95},
    {"pattern": "ZOOM VIDEO", "semantic": "software_saas", "confidence": 0.95},
    {"pattern": "NOTION", "semantic": "software_saas", "confidence": 0.95},
    {"pattern": "FIGMA", "semantic": "software_saas", "confidence": 0.95},
    {"pattern": "CANVA", "semantic": "software_saas", "confidence": 0.95},
    {"pattern": "ADOBE", "semantic": "software_saas", "confidence": 0.90},
    {"pattern": "DROPBOX", "semantic": "software_saas", "confidence": 0.95},
    {"pattern": "BOX INC", "semantic": "software_saas", "confidence": 0.95},
    {"pattern": "1PASSWORD", "semantic": "software_saas", "confidence": 0.95},
    {"pattern": "LASTPASS", "semantic": "software_saas", "confidence": 0.95},
    {"pattern": "OKTA", "semantic": "software_saas", "confidence": 0.95},
    {"pattern": "AUTH0", "semantic": "software_saas", "confidence": 0.95},
    {"pattern": "SALESFORCE", "semantic": "software_saas", "confidence": 0.95},
    {"pattern": "HUBSPOT", "semantic": "software_saas", "confidence": 0.95},
    {"pattern": "INTERCOM", "semantic": "software_saas", "confidence": 0.95},
    {"pattern": "ZENDESK", "semantic": "software_saas", "confidence": 0.95},
    {"pattern": "FRESHDESK", "semantic": "software_saas", "confidence": 0.95},
    {"pattern": "MAILCHIMP", "semantic": "software_saas", "confidence": 0.95},
    {"pattern": "CONSTANT CONTACT", "semantic": "software_saas", "confidence": 0.95},
    {"pattern": "SENDGRID", "semantic": "software_saas", "confidence": 0.95},
    {"pattern": "TWILIO", "semantic": "software_saas", "confidence": 0.95},
    {"pattern": "SEGMENT.IO", "semantic": "software_saas", "confidence": 0.95},
    {"pattern": "AMPLITUDE", "semantic": "software_saas", "confidence": 0.95},
    {"pattern": "MIXPANEL", "semantic": "software_saas", "confidence": 0.95},
    {"pattern": "DATADOG", "semantic": "software_saas", "confidence": 0.95},
    {"pattern": "NEW RELIC", "semantic": "software_saas", "confidence": 0.95},
    {"pattern": "SENTRY", "semantic": "software_saas", "confidence": 0.95},
    {"pattern": "PAGERDUTY", "semantic": "software_saas", "confidence": 0.95},
    {"pattern": "LINEAR.APP", "semantic": "software_saas", "confidence": 0.95},
    {"pattern": "ASANA", "semantic": "software_saas", "confidence": 0.95},
    {"pattern": "TRELLO", "semantic": "software_saas", "confidence": 0.95},
    {"pattern": "MONDAY.COM", "semantic": "software_saas", "confidence": 0.95},
    {"pattern": "CLICKUP", "semantic": "software_saas", "confidence": 0.95},
    {"pattern": "AIRTABLE", "semantic": "software_saas", "confidence": 0.95},
    {"pattern": "ZAPIER", "semantic": "software_saas", "confidence": 0.95},
    {"pattern": "MAKE.COM", "semantic": "software_saas", "confidence": 0.95},
    {"pattern": "N8N", "semantic": "software_saas", "confidence": 0.90},
    {"pattern": "OPENAI", "semantic": "software_saas", "confidence": 0.95},
    {"pattern": "ANTHROPIC", "semantic": "software_saas", "confidence": 0.95},
    {"pattern": "REPLIT", "semantic": "software_saas", "confidence": 0.95},
    {"pattern": "CURSOR AI", "semantic": "software_saas", "confidence": 0.95},
    {"pattern": "INTUIT *QBOOKS", "semantic": "software_saas", "confidence": 0.95},
    {"pattern": "INTUIT QUICKBOOKS", "semantic": "software_saas", "confidence": 0.95},
    {"pattern": "QUICKBOOKS", "semantic": "software_saas", "confidence": 0.95},
    {"pattern": "XERO", "semantic": "software_saas", "confidence": 0.95},
    {"pattern": "PUZZLE.IO", "semantic": "software_saas", "confidence": 0.95},

    # ===== PAYROLL SERVICES =====
    # Note: payroll payments themselves (wages) are payroll_expense — but
    # the Gusto/ADP subscription fee is software.  Distinguishing requires
    # amount heuristic; we default to payroll_service_fee and let CPA review.
    {"pattern": "GUSTO INC", "semantic": "payroll_service_fee", "confidence": 0.60,
     "notes": "usually the SaaS fee; large amounts are wage runs — needs review"},
    {"pattern": "GUSTO", "semantic": "payroll_service_fee", "confidence": 0.55},
    {"pattern": "ADP PAYROLL", "semantic": "payroll_expense", "confidence": 0.55},
    {"pattern": "ADP FEES", "semantic": "payroll_service_fee", "confidence": 0.85},
    {"pattern": "PAYCHEX", "semantic": "payroll_expense", "confidence": 0.55},
    {"pattern": "RIPPLING", "semantic": "payroll_service_fee", "confidence": 0.55},
    {"pattern": "JUSTWORKS", "semantic": "payroll_expense", "confidence": 0.55},
    {"pattern": "DEEL", "semantic": "payroll_expense", "confidence": 0.55},

    # ===== PAYMENT PROCESSORS =====
    {"pattern": "STRIPE", "semantic": "revenue_generic", "confidence": 0.50,
     "notes": "usually payouts (revenue) but could be fees; needs review"},
    {"pattern": "SQUARE INC", "semantic": "revenue_generic", "confidence": 0.50},
    {"pattern": "SQ *", "semantic": "revenue_generic", "confidence": 0.50, "notes": "Square merchant"},
    {"pattern": "PAYPAL", "semantic": "revenue_generic", "confidence": 0.40, "notes": "highly ambiguous — direction sensitive"},
    {"pattern": "VENMO", "semantic": "owner_draw", "confidence": 0.50, "notes": "usually personal"},
    {"pattern": "ZELLE", "semantic": "owner_draw", "confidence": 0.50},
    {"pattern": "CASH APP", "semantic": "owner_draw", "confidence": 0.50},
    {"pattern": "CASHAPP", "semantic": "owner_draw", "confidence": 0.50},
    {"pattern": "APPLE CASH", "semantic": "owner_draw", "confidence": 0.50},
    {"pattern": "GOOGLE PAY", "semantic": "office_supplies", "confidence": 0.45},

    # ===== BANKS / CARD PROCESSORS (BILL PAYMENTS = liability) =====
    {"pattern": "CAPITAL ONE", "semantic": "credit_card_payment", "confidence": 0.90,
     "notes": "usually credit card payment — flip direction check upstream"},
    {"pattern": "CHASE CARD", "semantic": "credit_card_payment", "confidence": 0.90},
    {"pattern": "CITI CARD", "semantic": "credit_card_payment", "confidence": 0.90},
    {"pattern": "AMERICAN EXPRESS", "semantic": "credit_card_payment", "confidence": 0.90},
    {"pattern": "AMEX EPAYMENT", "semantic": "credit_card_payment", "confidence": 0.90},
    {"pattern": "DISCOVER CARD", "semantic": "credit_card_payment", "confidence": 0.90},
    {"pattern": "BANK OF AMERICA CRD", "semantic": "credit_card_payment", "confidence": 0.90},
    {"pattern": "BARCLAYCARD", "semantic": "credit_card_payment", "confidence": 0.90},

    # ===== BANK FEES =====
    {"pattern": "OVERDRAFT", "semantic": "bank_fees", "confidence": 0.95},
    {"pattern": "SERVICE CHARGE", "semantic": "bank_fees", "confidence": 0.90},
    {"pattern": "MONTHLY FEE", "semantic": "bank_fees", "confidence": 0.85},
    {"pattern": "WIRE FEE", "semantic": "bank_fees", "confidence": 0.95},
    {"pattern": "ATM FEE", "semantic": "bank_fees", "confidence": 0.95},
    {"pattern": "FOREIGN TRANSACTION FEE", "semantic": "bank_fees", "confidence": 0.95},
    {"pattern": "NSF FEE", "semantic": "bank_fees", "confidence": 0.95},
    {"pattern": "RETURN ITEM FEE", "semantic": "bank_fees", "confidence": 0.95},
    {"pattern": "INTEREST CHARGE", "semantic": "bank_fees", "confidence": 0.85},

    # ===== TELECOM =====
    {"pattern": "T-MOBILE", "semantic": "telecom", "confidence": 0.90},
    {"pattern": "TMOBILE", "semantic": "telecom", "confidence": 0.90},
    {"pattern": "VERIZON WIRELESS", "semantic": "telecom", "confidence": 0.90},
    {"pattern": "VERIZON", "semantic": "telecom", "confidence": 0.85},
    {"pattern": "AT&T", "semantic": "telecom", "confidence": 0.85},
    {"pattern": "ATT MOBILITY", "semantic": "telecom", "confidence": 0.90},
    {"pattern": "SPRINT", "semantic": "telecom", "confidence": 0.85},
    {"pattern": "CRICKET WIRELESS", "semantic": "telecom", "confidence": 0.90},
    {"pattern": "METROPCS", "semantic": "telecom", "confidence": 0.90},
    {"pattern": "MINT MOBILE", "semantic": "telecom", "confidence": 0.90},
    {"pattern": "GOOGLE FI", "semantic": "telecom", "confidence": 0.90},
    {"pattern": "COMCAST", "semantic": "telecom", "confidence": 0.85},
    {"pattern": "XFINITY", "semantic": "telecom", "confidence": 0.90},
    {"pattern": "SPECTRUM", "semantic": "telecom", "confidence": 0.85},
    {"pattern": "COX COMM", "semantic": "telecom", "confidence": 0.90},
    {"pattern": "COX CABLE", "semantic": "telecom", "confidence": 0.90},
    {"pattern": "COX INTERNET", "semantic": "telecom", "confidence": 0.90},
    {"pattern": "CENTURYLINK", "semantic": "telecom", "confidence": 0.90},
    {"pattern": "FRONTIER COMM", "semantic": "telecom", "confidence": 0.90},
    {"pattern": "OPTIMUM", "semantic": "telecom", "confidence": 0.85},
    {"pattern": "STARLINK", "semantic": "telecom", "confidence": 0.90},
    {"pattern": "RCN", "semantic": "telecom", "confidence": 0.85},

    # ===== UTILITIES =====
    {"pattern": "PG&E", "semantic": "utilities", "confidence": 0.95},
    {"pattern": "PACIFIC GAS", "semantic": "utilities", "confidence": 0.95},
    {"pattern": "CONED", "semantic": "utilities", "confidence": 0.95},
    {"pattern": "CON EDISON", "semantic": "utilities", "confidence": 0.95},
    {"pattern": "SOUTHERN CALIF EDISON", "semantic": "utilities", "confidence": 0.95},
    {"pattern": "SDG&E", "semantic": "utilities", "confidence": 0.95},
    {"pattern": "DUKE ENERGY", "semantic": "utilities", "confidence": 0.95},
    {"pattern": "DOMINION ENERGY", "semantic": "utilities", "confidence": 0.95},
    {"pattern": "GEORGIA POWER", "semantic": "utilities", "confidence": 0.95},
    {"pattern": "TXU ENERGY", "semantic": "utilities", "confidence": 0.95},
    {"pattern": "RELIANT ENERGY", "semantic": "utilities", "confidence": 0.95},
    {"pattern": "NATIONAL GRID", "semantic": "utilities", "confidence": 0.95},
    {"pattern": "PSE&G", "semantic": "utilities", "confidence": 0.95},
    {"pattern": "AMEREN", "semantic": "utilities", "confidence": 0.95},
    {"pattern": "XCEL ENERGY", "semantic": "utilities", "confidence": 0.95},
    {"pattern": "NEXTERA", "semantic": "utilities", "confidence": 0.90},
    {"pattern": "WATER BILL", "semantic": "utilities", "confidence": 0.85},
    {"pattern": "WATER DEPT", "semantic": "utilities", "confidence": 0.85},
    {"pattern": "SEWER", "semantic": "utilities", "confidence": 0.85},

    # ===== INSURANCE =====
    {"pattern": "STATE FARM", "semantic": "insurance", "confidence": 0.95},
    {"pattern": "GEICO", "semantic": "insurance", "confidence": 0.95},
    {"pattern": "PROGRESSIVE", "semantic": "insurance", "confidence": 0.95},
    {"pattern": "ALLSTATE", "semantic": "insurance", "confidence": 0.95},
    {"pattern": "USAA", "semantic": "insurance", "confidence": 0.85, "notes": "banking + insurance"},
    {"pattern": "LIBERTY MUTUAL", "semantic": "insurance", "confidence": 0.95},
    {"pattern": "FARMERS INS", "semantic": "insurance", "confidence": 0.95},
    {"pattern": "AAA INSURANCE", "semantic": "insurance", "confidence": 0.95},
    {"pattern": "TRAVELERS", "semantic": "insurance", "confidence": 0.90},
    {"pattern": "NATIONWIDE", "semantic": "insurance", "confidence": 0.85},
    {"pattern": "METLIFE", "semantic": "insurance", "confidence": 0.90},
    {"pattern": "NEW YORK LIFE", "semantic": "insurance", "confidence": 0.90},
    {"pattern": "NORTHWESTERN MUTUAL", "semantic": "insurance", "confidence": 0.90},
    {"pattern": "PRUDENTIAL", "semantic": "insurance", "confidence": 0.85},
    {"pattern": "HUMANA", "semantic": "insurance", "confidence": 0.95},
    {"pattern": "AETNA", "semantic": "insurance", "confidence": 0.95},
    {"pattern": "BLUE CROSS", "semantic": "insurance", "confidence": 0.95},
    {"pattern": "BLUE SHIELD", "semantic": "insurance", "confidence": 0.95},
    {"pattern": "BCBS", "semantic": "insurance", "confidence": 0.95},
    {"pattern": "UNITEDHEALTHCARE", "semantic": "insurance", "confidence": 0.95},
    {"pattern": "UNITED HEALTHCARE", "semantic": "insurance", "confidence": 0.95},
    {"pattern": "CIGNA", "semantic": "insurance", "confidence": 0.95},
    {"pattern": "KAISER PERM", "semantic": "insurance", "confidence": 0.95},
    {"pattern": "OSCAR HEALTH", "semantic": "insurance", "confidence": 0.95},
    {"pattern": "HEALTHY PAWS", "semantic": "insurance", "confidence": 0.90, "notes": "pet insurance"},
    {"pattern": "LEMONADE INS", "semantic": "insurance", "confidence": 0.95},
    {"pattern": "NEXT INSURANCE", "semantic": "insurance", "confidence": 0.95},
    {"pattern": "HISCOX", "semantic": "insurance", "confidence": 0.95},

    # ===== MORTGAGE / HOME LOANS (LIABILITY PAYDOWN) =====
    {"pattern": "ROCKET MORTGAGE", "semantic": "loan_payment", "confidence": 0.85,
     "notes": "mortgage principal — CPA should split principal vs interest"},
    {"pattern": "QUICKEN LOANS", "semantic": "loan_payment", "confidence": 0.85},
    {"pattern": "WELLS FARGO HOME MTG", "semantic": "loan_payment", "confidence": 0.85},
    {"pattern": "CHASE MORTGAGE", "semantic": "loan_payment", "confidence": 0.85},
    {"pattern": "CITI MORTGAGE", "semantic": "loan_payment", "confidence": 0.85},
    {"pattern": "BANK OF AMERICA MTG", "semantic": "loan_payment", "confidence": 0.85},
    {"pattern": "MR COOPER", "semantic": "loan_payment", "confidence": 0.85},
    {"pattern": "CALIBER HOME LOAN", "semantic": "loan_payment", "confidence": 0.85},
    {"pattern": "LOANDEPOT", "semantic": "loan_payment", "confidence": 0.85},
    {"pattern": "PENNYMAC", "semantic": "loan_payment", "confidence": 0.85},

    # ===== CAR LOANS =====
    {"pattern": "AUDI FINANCIAL", "semantic": "loan_payment", "confidence": 0.90},
    {"pattern": "TOYOTA FIN", "semantic": "loan_payment", "confidence": 0.90},
    {"pattern": "FORD MOTOR CREDIT", "semantic": "loan_payment", "confidence": 0.90},
    {"pattern": "HONDA FIN", "semantic": "loan_payment", "confidence": 0.90},
    {"pattern": "NISSAN MOTOR ACCEPT", "semantic": "loan_payment", "confidence": 0.90},
    {"pattern": "BMW FIN", "semantic": "loan_payment", "confidence": 0.90},
    {"pattern": "MERCEDES BENZ FIN", "semantic": "loan_payment", "confidence": 0.90},
    {"pattern": "GM FINANCIAL", "semantic": "loan_payment", "confidence": 0.90},
    {"pattern": "CHRYSLER CAPITAL", "semantic": "loan_payment", "confidence": 0.90},
    {"pattern": "ALLY AUTO", "semantic": "loan_payment", "confidence": 0.90},
    {"pattern": "CAPITAL ONE AUTO", "semantic": "loan_payment", "confidence": 0.90},

    # ===== ADVERTISING =====
    {"pattern": "GOOGLE ADS", "semantic": "marketing", "confidence": 0.95},
    {"pattern": "GOOGLE *ADS", "semantic": "marketing", "confidence": 0.95},
    {"pattern": "META ADS", "semantic": "marketing", "confidence": 0.95},
    {"pattern": "FACEBK ADS", "semantic": "marketing", "confidence": 0.95},
    {"pattern": "FACEBOOK ADS", "semantic": "marketing", "confidence": 0.95},
    {"pattern": "LINKEDIN CORP", "semantic": "marketing", "confidence": 0.85, "notes": "could also be SaaS subscription"},
    {"pattern": "TIKTOK ADS", "semantic": "marketing", "confidence": 0.95},
    {"pattern": "REDDIT INC", "semantic": "marketing", "confidence": 0.90},
    {"pattern": "PINTEREST ADS", "semantic": "marketing", "confidence": 0.95},
    {"pattern": "TWITTER ADS", "semantic": "marketing", "confidence": 0.95},
    {"pattern": "X CORP", "semantic": "marketing", "confidence": 0.85},
    {"pattern": "SNAP ADS", "semantic": "marketing", "confidence": 0.95},
    {"pattern": "BING ADS", "semantic": "marketing", "confidence": 0.95},
    {"pattern": "YELP ADS", "semantic": "marketing", "confidence": 0.90},

    # ===== MARKETPLACE FEES (E-COMMERCE) =====
    {"pattern": "AMAZON SELLER", "semantic": "marketplace_ads", "confidence": 0.90},
    {"pattern": "AMZN SELLER", "semantic": "marketplace_ads", "confidence": 0.90},
    {"pattern": "ETSY FEES", "semantic": "marketplace_ads", "confidence": 0.90},
    {"pattern": "EBAY", "semantic": "marketplace_ads", "confidence": 0.85},
    {"pattern": "WALMART MP", "semantic": "marketplace_ads", "confidence": 0.85},
    {"pattern": "SHOPIFY", "semantic": "software_saas", "confidence": 0.90},

    # ===== SHIPPING / LOGISTICS =====
    {"pattern": "USPS.COM", "semantic": "shipping_cogs", "confidence": 0.85},
    {"pattern": "USPS POSTAGE", "semantic": "shipping_cogs", "confidence": 0.85},
    {"pattern": "UPS SHIPPING", "semantic": "shipping_cogs", "confidence": 0.85},
    {"pattern": "UPS STORE", "semantic": "shipping_cogs", "confidence": 0.80},
    {"pattern": "FEDEX", "semantic": "shipping_cogs", "confidence": 0.85},
    {"pattern": "DHL EXPRESS", "semantic": "shipping_cogs", "confidence": 0.90},
    {"pattern": "PIRATESHIP", "semantic": "shipping_cogs", "confidence": 0.95},
    {"pattern": "STAMPS.COM", "semantic": "shipping_cogs", "confidence": 0.90},
    {"pattern": "SHIPSTATION", "semantic": "software_saas", "confidence": 0.90},
    {"pattern": "SHIPPO", "semantic": "software_saas", "confidence": 0.90},
    {"pattern": "SHIPBOB", "semantic": "shipping_cogs", "confidence": 0.85},

    # ===== TAXES / GOVERNMENT =====
    {"pattern": "IRS USA*TAX", "semantic": "loan_payment", "confidence": 0.75,
     "notes": "federal tax payment — often income tax; CPA should split"},
    {"pattern": "IRS USATAX", "semantic": "loan_payment", "confidence": 0.75},
    {"pattern": "US TREASURY", "semantic": "loan_payment", "confidence": 0.70},
    {"pattern": "FTB CA", "semantic": "loan_payment", "confidence": 0.75, "notes": "CA state tax"},
    {"pattern": "NYS DTF", "semantic": "loan_payment", "confidence": 0.75, "notes": "NY state tax"},
    {"pattern": "DEPT OF REVENUE", "semantic": "loan_payment", "confidence": 0.70},
    {"pattern": "STATE TAX", "semantic": "loan_payment", "confidence": 0.70},
    {"pattern": "SALES TAX", "semantic": "sales_tax_payment", "confidence": 0.85},

    # ===== BANK NAMES (usually loan/interest — need review) =====
    {"pattern": "CHASE BANK", "semantic": "loan_payment", "confidence": 0.55},
    {"pattern": "BANK OF AMERICA", "semantic": "loan_payment", "confidence": 0.50, "notes": "ambiguous — could be transfer, fee, or loan"},
    {"pattern": "WELLS FARGO", "semantic": "loan_payment", "confidence": 0.50},

    # ===== PROFESSIONAL SERVICES =====
    {"pattern": "H&R BLOCK", "semantic": "professional_fees", "confidence": 0.90},
    {"pattern": "TURBOTAX", "semantic": "software_saas", "confidence": 0.90},
    {"pattern": "LEGALZOOM", "semantic": "professional_fees", "confidence": 0.90},
    {"pattern": "ROCKET LAWYER", "semantic": "professional_fees", "confidence": 0.90},
    {"pattern": "CLERKY", "semantic": "professional_fees", "confidence": 0.90},
    {"pattern": "STRIPE ATLAS", "semantic": "professional_fees", "confidence": 0.90},
    {"pattern": "FIRSTBASE", "semantic": "professional_fees", "confidence": 0.90},
    {"pattern": "MERCURY BANK", "semantic": "bank_fees", "confidence": 0.60},

    # ===== PET / VET (usually personal) =====
    {"pattern": "PETSMART", "semantic": "office_supplies", "confidence": 0.55, "notes": "personal spending"},
    {"pattern": "PETCO", "semantic": "office_supplies", "confidence": 0.55},
    {"pattern": "CHEWY", "semantic": "office_supplies", "confidence": 0.55},
    {"pattern": "VCA ANIMAL", "semantic": "office_supplies", "confidence": 0.55},
    {"pattern": "BANFIELD", "semantic": "office_supplies", "confidence": 0.55},

    # ===== STREAMING / ENTERTAINMENT (usually personal) =====
    {"pattern": "NETFLIX", "semantic": "software_saas", "confidence": 0.55, "notes": "usually personal"},
    {"pattern": "SPOTIFY", "semantic": "software_saas", "confidence": 0.55},
    {"pattern": "HULU", "semantic": "software_saas", "confidence": 0.55},
    {"pattern": "DISNEY PLUS", "semantic": "software_saas", "confidence": 0.55},
    {"pattern": "APPLE.COM/BILL", "semantic": "software_saas", "confidence": 0.55},
    {"pattern": "APPLE MUSIC", "semantic": "software_saas", "confidence": 0.55},
    {"pattern": "YOUTUBE PREMIUM", "semantic": "software_saas", "confidence": 0.55},
    {"pattern": "PARAMOUNT PLUS", "semantic": "software_saas", "confidence": 0.55},
    {"pattern": "HBO MAX", "semantic": "software_saas", "confidence": 0.55},
    {"pattern": "PEACOCK TV", "semantic": "software_saas", "confidence": 0.55},

    # ===== GYMS / MEMBERSHIPS (usually personal) =====
    {"pattern": "PLANET FITNESS", "semantic": "office_supplies", "confidence": 0.50, "notes": "personal — flag"},
    {"pattern": "LA FITNESS", "semantic": "office_supplies", "confidence": 0.50},
    {"pattern": "24 HOUR FITNESS", "semantic": "office_supplies", "confidence": 0.50},
    {"pattern": "EQUINOX", "semantic": "office_supplies", "confidence": 0.50},
    {"pattern": "SOULCYCLE", "semantic": "office_supplies", "confidence": 0.50},
    {"pattern": "CLASSPASS", "semantic": "office_supplies", "confidence": 0.50},
    {"pattern": "PELOTON", "semantic": "office_supplies", "confidence": 0.50},

    # ===== ACH KEYWORDS =====
    {"pattern": "PAYROLL DES", "semantic": "payroll_expense", "confidence": 0.85},
    {"pattern": "DIR DEP", "semantic": "revenue_generic", "confidence": 0.50, "notes": "could be revenue or owner contribution"},
    {"pattern": "DIRECT DEP", "semantic": "revenue_generic", "confidence": 0.50},
    {"pattern": "OWNER DRAW", "semantic": "owner_draw", "confidence": 0.90},
    {"pattern": "OWNER'S DRAW", "semantic": "owner_draw", "confidence": 0.90},

    # ===== MISC BUSINESS SERVICES =====
    {"pattern": "DOCUSIGN", "semantic": "software_saas", "confidence": 0.95},
    {"pattern": "HELLOSIGN", "semantic": "software_saas", "confidence": 0.95},
    {"pattern": "DROPBOX SIGN", "semantic": "software_saas", "confidence": 0.95},
    {"pattern": "NAMECHEAP", "semantic": "software_saas", "confidence": 0.90},
    {"pattern": "GODADDY", "semantic": "software_saas", "confidence": 0.90},
    {"pattern": "SQUARESPACE", "semantic": "software_saas", "confidence": 0.90},
    {"pattern": "WIX.COM", "semantic": "software_saas", "confidence": 0.90},
    {"pattern": "WEBFLOW", "semantic": "software_saas", "confidence": 0.90},
    {"pattern": "WORDPRESS", "semantic": "software_saas", "confidence": 0.90},
    {"pattern": "SUBSTACK", "semantic": "software_saas", "confidence": 0.85},
    {"pattern": "PATREON", "semantic": "software_saas", "confidence": 0.75},
    {"pattern": "CALENDLY", "semantic": "software_saas", "confidence": 0.95},

    # ===== FLIGHT-ADJACENT (baggage, food) =====
    {"pattern": "GLOBAL ENTRY", "semantic": "travel", "confidence": 0.95},
    {"pattern": "TSA PRECHECK", "semantic": "travel", "confidence": 0.95},
    {"pattern": "CLEAR ME", "semantic": "travel", "confidence": 0.90},
]


# ---------------------------------------------------------------------------
# Lookup helpers
# ---------------------------------------------------------------------------
#
# Rules are compiled once on import into `_COMPILED_RULES` for O(rules)
# scan on each transaction. At 800 rules that's ~50µs per row in Python.
# If this ever becomes a bottleneck, migrate to an Aho-Corasick automaton.

_COMPILED_RULES: list[tuple[str, dict]] = [
    (r["pattern"].upper(), r) for r in RULES
]


def match(text: str) -> Optional[dict]:
    """Return the first matching rule dict for a merchant/description
    string, or None if no rule matched. First-match-wins."""
    if not text:
        return None
    up = text.upper()
    for pattern, rule in _COMPILED_RULES:
        if pattern in up:
            return rule
    return None


def match_and_resolve(
    text: str, industry_template: str, amount: float | None = None,
) -> Optional[dict]:
    """Match a rule and resolve its semantic to an actual account code.

    If the matched rule carries an `amount_buckets` map AND `amount`
    is supplied, the bucket-specific semantic + confidence replace
    the rule's default. Falls back to the rule's flat `semantic` when
    no bucket match applies. This is how we handle ambiguous
    merchants like Costco/Walmart/Amazon where amount actually
    signals the category (small=meals, large=supplies).

    Returns a dict with keys {pattern, semantic, account_code,
    confidence, notes, bucket?} or None if no match / semantic isn't
    in the company's template.
    """
    rule = match(text)
    if not rule:
        return None

    # Amount-bucket rules — if the rule declares per-bucket semantics
    # and we know the amount, use the bucket-specific version.
    semantic = rule.get("semantic")
    confidence = rule.get("confidence", 0.5)
    matched_bucket = None
    if amount is not None and rule.get("amount_buckets"):
        bucket = amount_bucket(amount)
        bucket_rule = rule["amount_buckets"].get(bucket)
        if bucket_rule:
            semantic = bucket_rule.get("semantic", semantic)
            confidence = bucket_rule.get("confidence", confidence)
            matched_bucket = bucket

    if not semantic:
        return None

    code = resolve_semantic(semantic, industry_template)
    if code is None:
        return None
    return {
        "pattern": rule["pattern"],
        "semantic": semantic,
        "account_code": code,
        "confidence": confidence,
        "notes": rule.get("notes", ""),
        "bucket": matched_bucket,
    }


def rule_count() -> int:
    return len(RULES)
