"""Rocketbooks-style deterministic merchant rules.

Precedence in the categorization pipeline:
    1. rules_lookup()          → static dictionary + regex patterns (this file)
    2. merchant_cache.lookup()  → per-org learned cache
    3. LLM categorize          → Claude fallback
    4. Uncategorized bucket    → if confidence < threshold

Rocketbooks' apparent secret sauce is a large curated merchant→category map
that never hits an LLM. We do the same. Every entry here returns confidence
0.95 so it will pass the auto-post threshold on every org.

Also detects internal transfers (bank-to-bank movement) so the pipeline can
route them to a cash-transfer suspense account instead of expense/income —
this is what keeps their transfer count "~300 uncategorized" on 1900 txns.
"""
from __future__ import annotations
import re
from typing import Optional

# ---------------------------------------------------------------------------
# 1. Merchant → account_code dictionary
# ---------------------------------------------------------------------------
# The KEY is the normalized (uppercased, prefix-stripped) merchant token.
# Match is a case-insensitive substring test against the cleaned description.
# Order matters ONLY where two rules could match; more-specific rules must be
# placed above their general parents (checked first).

# Category codes from /app/backend/seed.py DEFAULT_COA:
#   6000 Meals, 6010 Entertainment, 6100 Travel, 6120 Transportation,
#   6200 Advertising, 6250 Dues & Subscriptions, 6300 Office Supplies,
#   6400 Insurance, 6500 Legal & Professional, 6600 Utilities, 6700 Rent,
#   6800 Supplies & Materials, 6900 Repairs & Maintenance,
#   7000 Bank Fees, 7100 Software & SaaS, 7200 Payroll,
#   4000 Service Revenue, 4100 Product Sales, 4200 Interest Income,
#   2100 Credit Card Payable, 2500 Loans Payable.

MERCHANT_RULES: list[tuple[str, str, str]] = [
    # -------- Meals & Restaurants (6000) --------
    ("MCDONALD",              "6000", "Fast food"),
    ("BURGER KING",           "6000", "Fast food"),
    ("WENDY",                 "6000", "Fast food"),
    ("TACO BELL",             "6000", "Fast food"),
    ("CHICK-FIL-A",           "6000", "Fast food"),
    ("CHICKFILA",             "6000", "Fast food"),
    ("KFC",                   "6000", "Fast food"),
    ("SUBWAY",                "6000", "Fast food"),
    ("CHIPOTLE",              "6000", "Fast casual"),
    ("PANERA",                "6000", "Fast casual"),
    ("STARBUCKS",             "6000", "Coffee shop"),
    ("DUNKIN",                "6000", "Coffee shop"),
    ("PEET",                  "6000", "Coffee shop"),
    ("DUTCH BROS",            "6000", "Coffee shop"),
    ("OLIVE GARDEN",          "6000", "Restaurant"),
    ("APPLEBEE",              "6000", "Restaurant"),
    ("CHILI'S",               "6000", "Restaurant"),
    ("CHILIS",                "6000", "Restaurant"),
    ("OUTBACK STEAK",         "6000", "Restaurant"),
    ("TEXAS ROADHOUSE",       "6000", "Restaurant"),
    ("CRACKER BARREL",        "6000", "Restaurant"),
    ("DENNY",                 "6000", "Restaurant"),
    ("IHOP",                  "6000", "Restaurant"),
    ("PANDA EXPRESS",         "6000", "Fast casual"),
    ("PIZZA HUT",             "6000", "Pizza"),
    ("DOMINO",                "6000", "Pizza"),
    ("LITTLE CAESAR",         "6000", "Pizza"),
    ("PAPA JOHN",             "6000", "Pizza"),
    ("RAISING CANE",          "6000", "Fast food"),
    ("EINSTEIN BROS",         "6000", "Bagels/breakfast"),
    ("EINSTEIN BAGEL",        "6000", "Bagels/breakfast"),
    ("JACK IN THE BOX",       "6000", "Fast food"),
    ("SONIC",                 "6000", "Fast food"),
    ("NOTHING BUNDT",         "6000", "Bakery"),
    ("DAIRY QUEEN",           "6000", "Fast food"),
    ("BASKIN-ROBBINS",        "6000", "Ice cream"),
    ("BASKIN ROBBINS",        "6000", "Ice cream"),
    ("CHEESECAKE FACTORY",    "6000", "Restaurant"),
    ("BUFFALO WILD WINGS",    "6000", "Restaurant"),
    ("RED LOBSTER",           "6000", "Restaurant"),
    ("BJ'S RESTAURANT",       "6000", "Restaurant"),
    ("TST*",                  "6000", "Toast POS restaurant"),   # POS prefix → restaurant
    ("SQ *",                  "6000", "Square POS restaurant"),  # Common for food carts
    ("SIP OF SAIGON",         "6000", "Restaurant"),
    ("PEGS GLORIFIED",        "6000", "Restaurant"),
    ("KEVA",                  "6000", "Restaurant"),

    # -------- Food delivery (6000) --------
    ("DOORDASH",              "6000", "Food delivery"),
    ("UBER EATS",             "6000", "Food delivery"),
    ("UBEREATS",              "6000", "Food delivery"),
    ("GRUBHUB",               "6000", "Food delivery"),
    ("POSTMATES",             "6000", "Food delivery"),
    ("INSTACART",             "6000", "Grocery delivery"),

    # -------- Travel / Transportation (6100, 6120) --------
    ("UBER TRIP",             "6120", "Rideshare"),
    ("LYFT",                  "6120", "Rideshare"),
    ("UBER *",                "6120", "Rideshare (default)"),
    ("UBER",                  "6120", "Rideshare (default)"),
    ("DELTA AIR",             "6100", "Airline"),
    ("UNITED AIRLINES",       "6100", "Airline"),
    ("SOUTHWEST",             "6100", "Airline"),
    ("AMERICAN AIRLINES",     "6100", "Airline"),
    ("JETBLUE",               "6100", "Airline"),
    ("ALASKA AIR",            "6100", "Airline"),
    ("SPIRIT AIR",            "6100", "Airline"),
    ("FRONTIER AIR",          "6100", "Airline"),
    ("MARRIOTT",              "6100", "Hotel"),
    ("HILTON",                "6100", "Hotel"),
    ("HYATT",                 "6100", "Hotel"),
    ("HOLIDAY INN",           "6100", "Hotel"),
    ("BEST WESTERN",          "6100", "Hotel"),
    ("AIRBNB",                "6100", "Lodging"),
    ("VRBO",                  "6100", "Lodging"),
    ("HERTZ",                 "6100", "Car rental"),
    ("ENTERPRISE RENT",       "6100", "Car rental"),
    ("AVIS",                  "6100", "Car rental"),
    ("BUDGET RENT",           "6100", "Car rental"),
    ("PARKING",               "6120", "Parking"),
    ("PARK ENFORCE",          "6120", "Parking / meter"),

    # -------- Gas stations (6120) --------
    ("SHELL OIL",             "6120", "Fuel"),
    (" SHELL ",               "6120", "Fuel"),
    ("CHEVRON",               "6120", "Fuel"),
    ("EXXON",                 "6120", "Fuel"),
    ("MOBIL OIL",             "6120", "Fuel"),
    (" MOBIL ",               "6120", "Fuel"),
    ("BP GAS",                "6120", "Fuel"),
    ("ARCO",                  "6120", "Fuel"),
    ("CIRCLE K",              "6120", "Convenience / fuel"),
    ("7-ELEVEN",              "6120", "Convenience / fuel"),
    ("COSTCO GAS",            "6120", "Fuel"),
    ("SAMS CLUB GAS",         "6120", "Fuel"),
    ("SAM'S CLUB GAS",        "6120", "Fuel"),
    (" 76 STATION",           "6120", "Fuel"),
    ("DADS QUICK",            "6120", "Convenience / fuel"),

    # -------- Utilities (6600) --------
    ("AT&T",                  "6600", "Wireless / telecom"),
    ("ATT*BILL",              "6600", "Wireless / telecom"),
    ("ATT DES:",              "6600", "Wireless / telecom"),
    ("VERIZON",               "6600", "Wireless / telecom"),
    ("T-MOBILE",              "6600", "Wireless / telecom"),
    ("TMOBILE",               "6600", "Wireless / telecom"),
    ("SPRINT",                "6600", "Wireless / telecom"),
    ("XFINITY",               "6600", "Internet / cable"),
    ("COMCAST",               "6600", "Internet / cable"),
    ("SPECTRUM",              "6600", "Internet / cable"),
    ("COX COMMUNICATION",     "6600", "Internet / cable"),
    ("PG&E",                  "6600", "Electric utility"),
    ("PGANDE",                "6600", "Electric utility"),
    ("NV ENERGY",             "6600", "Electric utility"),
    ("SOUTHWEST GAS",         "6600", "Gas utility"),
    ("SDGE",                  "6600", "Electric utility"),
    ("CON EDISON",            "6600", "Electric utility"),
    ("DUKE ENERGY",           "6600", "Electric utility"),
    ("TRUCKEE MEADOW",        "6600", "Water utility"),
    ("WATER DEPT",            "6600", "Water utility"),
    ("WASTE MANAGEMENT",      "6600", "Trash / waste"),
    ("REPUBLIC SERVICES",     "6600", "Trash / waste"),

    # -------- Insurance (6400) --------
    ("NEW YORK LIFE",         "6400", "Life insurance"),
    ("STATE FARM",            "6400", "Insurance"),
    ("GEICO",                 "6400", "Auto insurance"),
    ("PROGRESSIVE",           "6400", "Auto insurance"),
    ("ALLSTATE",              "6400", "Insurance"),
    ("USAA",                  "6400", "Insurance / bank"),
    ("LIBERTY MUTUAL",        "6400", "Insurance"),
    ("FARMERS INS",           "6400", "Insurance"),
    ("METLIFE",               "6400", "Insurance"),
    ("PRUDENTIAL",            "6400", "Insurance"),
    ("HUMANA",                "6400", "Health insurance"),
    ("BLUE CROSS",            "6400", "Health insurance"),
    ("BLUE SHIELD",           "6400", "Health insurance"),
    ("UNITEDHEALTHCARE",      "6400", "Health insurance"),
    ("AETNA",                 "6400", "Health insurance"),
    ("CIGNA",                 "6400", "Health insurance"),
    ("TRUPANION",             "6400", "Pet insurance"),
    ("HEALTHY PAWS",          "6400", "Pet insurance"),
    ("DENTAL INSURANCE",      "6400", "Dental insurance"),

    # -------- Retail / Supplies & Materials (6800) --------
    ("WALMART",               "6800", "Big-box retail"),
    ("WAL-MART",              "6800", "Big-box retail"),
    ("WM SUPERCENTER",        "6800", "Walmart Supercenter"),
    ("TARGET",                "6800", "Big-box retail"),
    ("COSTCO WHSE",           "6800", "Wholesale club"),
    ("COSTCO WHOLESALE",      "6800", "Wholesale club"),
    ("COSTCO",                "6800", "Wholesale club (bare)"),
    ("SAMS CLUB",             "6800", "Wholesale club"),
    ("SAM'S CLUB",            "6800", "Wholesale club"),
    ("BJ'S WHOLESALE",        "6800", "Wholesale club"),
    ("AMAZON.COM",            "6800", "Online retail"),
    ("AMAZON MKTP",           "6800", "Online retail"),
    ("AMZN MKTP",             "6800", "Online retail"),
    ("AMZN.COM",              "6800", "Online retail"),
    ("AMAZON PRIME",          "6250", "Prime subscription"),
    ("AMAZON ",               "6800", "Online retail"),
    ("FIVE BELOW",            "6800", "Retail"),
    ("DOLLAR TREE",           "6800", "Retail"),
    ("DOLLAR GENERAL",        "6800", "Retail"),
    ("FAMILY DOLLAR",         "6800", "Retail"),
    ("BIG LOTS",              "6800", "Retail"),
    ("MICHAELS",              "6800", "Craft supplies"),
    ("HOBBY LOBBY",           "6800", "Craft supplies"),
    ("JOANN",                 "6800", "Craft supplies"),
    ("KROGER",                "6800", "Grocery"),
    ("SAFEWAY",               "6800", "Grocery"),
    ("ALBERTSONS",            "6800", "Grocery"),
    ("WHOLE FOODS",           "6800", "Grocery"),
    ("TRADER JOE",            "6800", "Grocery"),
    ("PUBLIX",                "6800", "Grocery"),
    ("WINCO FOOD",            "6800", "Grocery"),
    ("RALEY",                 "6800", "Grocery"),
    ("SCHEELS",               "6800", "Sporting goods"),
    ("DICK'S SPORTING",       "6800", "Sporting goods"),
    ("PETSMART",              "6800", "Pet supplies"),
    ("PETCO",                 "6800", "Pet supplies"),
    ("VETSOURCE",             "6800", "Pet supplies"),
    ("VCA ANIMAL",            "6800", "Veterinary"),

    # -------- Repairs / Home Improvement (6900) --------
    ("HOME DEPOT",            "6900", "Home improvement / repair"),
    ("HD SUPPLY",             "6900", "Home improvement / repair"),
    ("LOWE'S",                "6900", "Home improvement / repair"),
    ("LOWES",                 "6900", "Home improvement / repair"),
    ("ACE HARDWARE",          "6900", "Home improvement / repair"),
    ("MENARDS",               "6900", "Home improvement / repair"),

    # -------- Office Supplies (6300) --------
    ("STAPLES",               "6300", "Office supplies"),
    ("OFFICE DEPOT",          "6300", "Office supplies"),
    ("OFFICEMAX",             "6300", "Office supplies"),
    ("BEST BUY",              "6300", "Electronics / office"),
    ("BESTBUY",               "6300", "Electronics / office"),
    ("APPLE STORE",           "6300", "Electronics / office"),
    ("APPLE.COM",             "6300", "Electronics / office"),
    ("MICROSOFT XBOX",        "6300", "Electronics / gaming"),
    ("OCULUS",                "6300", "Electronics / VR"),

    # -------- Software / SaaS / Subscriptions (7100 or 6250) --------
    ("GITHUB",                "7100", "SaaS / dev tools"),
    ("ATLASSIAN",             "7100", "SaaS"),
    ("SLACK",                 "7100", "SaaS"),
    ("ZOOM.US",               "7100", "SaaS"),
    ("ZOOM.COM",              "7100", "SaaS"),
    ("MICROSOFT 365",         "7100", "SaaS"),
    ("MSFT*",                 "7100", "Microsoft SaaS"),
    ("MICROSOFT*",            "7100", "Microsoft SaaS"),
    ("GOOGLE *",              "7100", "Google SaaS"),
    ("GOOGLE*",               "7100", "Google SaaS"),
    ("GSUITE",                "7100", "Google Workspace"),
    ("DROPBOX",               "7100", "SaaS"),
    ("ADOBE",                 "7100", "SaaS"),
    ("AWS",                   "7100", "Cloud infra"),
    ("AMAZON WEB SERVICES",   "7100", "Cloud infra"),
    ("DIGITALOCEAN",          "7100", "Cloud infra"),
    ("STRIPE",                "7100", "Payment processor"),
    ("QUICKBOOKS",            "7100", "Accounting SaaS"),
    ("INTUIT",                "7100", "SaaS"),
    ("SPI*",                  "6250", "Recurring subscription"),
    ("NETFLIX",               "6250", "Streaming subscription"),
    ("SPOTIFY",               "6250", "Streaming subscription"),
    ("HULU",                  "6250", "Streaming subscription"),
    ("DISNEY PLUS",           "6250", "Streaming subscription"),
    ("DISNEYPLUS",            "6250", "Streaming subscription"),
    ("HBO",                   "6250", "Streaming subscription"),
    ("YOUTUBE PREMIUM",       "6250", "Streaming subscription"),
    ("APPLE TV",              "6250", "Streaming subscription"),
    ("PARAMOUNT+",            "6250", "Streaming subscription"),
    ("PEACOCK",               "6250", "Streaming subscription"),
    ("DIRECTV",               "6250", "TV subscription"),
    ("DISH NETWORK",          "6250", "TV subscription"),
    ("SIRIUSXM",              "6250", "Subscription"),
    ("PLANET FITNESS",        "6250", "Gym membership"),
    ("24 HOUR FITNESS",       "6250", "Gym membership"),
    ("LA FITNESS",            "6250", "Gym membership"),
    ("GALAXY THEATRE",        "6250", "Entertainment subscription"),

    # -------- Advertising (6200) --------
    ("FACEBOOK ADS",          "6200", "Advertising"),
    ("FB.ADS",                "6200", "Advertising"),
    ("META PLATFORMS",        "6200", "Advertising"),
    ("GOOGLE ADS",            "6200", "Advertising"),
    ("LINKEDIN ADS",          "6200", "Advertising"),
    ("YELP ADVERTISING",      "6200", "Advertising"),
    ("TWITTER ADS",           "6200", "Advertising"),
    ("TIKTOK ADS",            "6200", "Advertising"),
    ("PINTEREST ADS",         "6200", "Advertising"),

    # -------- Payroll (7200) --------
    ("GUSTO",                 "7200", "Payroll processor"),
    ("ADP PAYROLL",           "7200", "Payroll processor"),
    ("ADP TAX",               "7200", "Payroll processor"),
    ("ADP*",                  "7200", "Payroll processor"),
    ("PAYCHEX",               "7200", "Payroll processor"),
    ("QUICKBOOKS PAYROLL",    "7200", "Payroll processor"),

    # -------- Credit Card paydowns (2100) — liability, not expense --------
    ("CAPITAL ONE DES:MOBILE PMT",    "2100", "CC paydown"),
    ("CAPITAL ONE PMT",               "2100", "CC paydown"),
    ("CITI CARD ONLINE",              "2100", "CC paydown"),
    ("CITI AUTOPAY",                  "2100", "CC paydown"),
    ("CHASE CREDIT",                  "2100", "CC paydown"),
    ("CHASE CARD",                    "2100", "CC paydown"),
    ("CREDIT ONE BANK",               "2100", "CC paydown"),
    ("CONCORA CREDIT",                "2100", "CC paydown"),
    ("DISCOVER DES:E-PAYMENT",        "2100", "CC paydown"),
    ("DISCOVER CARD",                 "2100", "CC paydown"),
    ("SYNCHRONY",                     "2100", "CC paydown"),
    ("BARCLAYCARD",                   "2100", "CC paydown"),
    ("AMEX EPAYMENT",                 "2100", "CC paydown"),
    ("AMERICAN EXPRESS",              "2100", "CC paydown"),

    # -------- Loans / Notes Payable (2500) --------
    ("ROCKET MORTGAGE",       "2500", "Mortgage / loan"),
    ("MR. COOPER",            "2500", "Mortgage / loan"),
    ("MR COOPER",             "2500", "Mortgage / loan"),
    ("WELLS FARGO HOME MTG",  "2500", "Mortgage / loan"),
    ("BANK OF AMERICA MTG",   "2500", "Mortgage / loan"),
    ("MERCEDES-BENZ FIN",     "2500", "Auto loan"),
    ("MERCEDES BENZ FIN",     "2500", "Auto loan"),
    ("AUDI FINCL",            "2500", "Auto loan"),
    ("AUDI FIN",              "2500", "Auto loan"),
    ("BMW FIN",               "2500", "Auto loan"),
    ("TOYOTA FIN",            "2500", "Auto loan"),
    ("HONDA FIN",             "2500", "Auto loan"),
    ("FORD MOTOR CREDIT",     "2500", "Auto loan"),
    ("STONEBROOK WEST",       "2500", "Loan payment"),

    # -------- Rent (6700) --------
    ("KRN VILLAGES",          "6700", "Rent"),

    # -------- Government / Tax --------
    # IRS taxes — books as owner's draw / distribution in personal biz; leave to LLM
    # for now (varies by entity type).

    # -------- Interest income (4200) — positive amount only --------
    # Handled by _regex_rules() (description contains "Interest Earned"/"Interest Paid").

    # -------- Additional merchants found in real-data misses --------
    ("MBFS DES:",             "2500", "Mercedes-Benz Financial Services loan"),
    (" MBFS ",                "2500", "Mercedes-Benz Financial Services loan"),
    ("NSM DBAMR",             "2500", "Mr. Cooper (NSM DBA) loan"),
    ("MR.COOPER",             "2500", "Mr. Cooper loan"),
    ("HUM COMPBEN",           "6400", "Humana health insurance"),
    ("HUMANA COMPBEN",        "6400", "Humana health insurance"),
    ("PRIME VIDEO",           "6250", "Streaming subscription"),
    ("AMAZON PRIME VIDEO",    "6250", "Streaming subscription"),
    ("MICROSOFT* MSBILL",     "7100", "Microsoft billing SaaS"),
    ("MSBILL.INFO",           "7100", "Microsoft billing SaaS"),
    ("QBO PURCHASE",          "7100", "QuickBooks Online"),
    ("QBO*",                  "7100", "QuickBooks Online"),
    ("ROCKET_RESUME",         "7100", "Resume SaaS"),
    ("ROCKET RESUME",         "7100", "Resume SaaS"),
    ("CITY OF ",              "6600", "Municipal utility / service"),
    ("CITY UTILITIES",        "6600", "Municipal utility"),
    ("CITY WATER",            "6600", "Municipal utility"),
    ("ATT* BILL",             "6600", "AT&T wireless (spaced prefix)"),
    ("ATT *BILL",             "6600", "AT&T wireless (spaced prefix)"),
    ("DMV-",                  "6120", "DMV fee (vehicle)"),
    ("DMV ",                  "6120", "DMV fee (vehicle)"),
    ("SBARRO",                "6000", "Fast food"),
    ("EINSTEINBROS",          "6000", "Bagels/breakfast (concat)"),
    ("BJ'SRESTAURANTS",       "6000", "Restaurant (concat)"),
    ("BJSRESTAURANTS",        "6000", "Restaurant (concat)"),
    ("REDEVELOPMENT AGENCY",  "6300", "Municipal admin fee"),
    ("MONARCH MONEY",         "7100", "Finance SaaS"),

    # -------- Generic food/dining keywords (last-mile fallback) --------
    # These are intentionally at the END so more-specific matches (fuel,
    # retail, subs) win when a description contains multiple hints.
    ("RESTAURANT",            "6000", "Generic restaurant"),
    (" DINER",                "6000", "Generic diner"),
    ("BB DINER",              "6000", "Generic diner"),
    ("BAKERY",                "6000", "Bakery"),
    (" CAFE ",                "6000", "Generic cafe"),
    (" GRILL ",               "6000", "Generic grill"),
    ("BISTRO",                "6000", "Bistro"),
    ("SUSHI",                 "6000", "Sushi restaurant"),
    ("STEAKHOUSE",            "6000", "Steakhouse"),
    (" PIZZA",                "6000", "Pizzeria"),
    (" DELI ",                "6000", "Deli"),
    ("KITCHEN",               "6000", "Restaurant kitchen"),
    ("TAQUERIA",              "6000", "Mexican restaurant"),
]

# Build a "haystack -> (code, why)" fast index. Longer keys first (more specific
# match wins), case-insensitive contains-test.
_RULES_INDEX: list[tuple[str, str, str]] = sorted(
    MERCHANT_RULES, key=lambda t: -len(t[0])
)


# ---------------------------------------------------------------------------
# 2. Regex rules — fees, interest, transfers
# ---------------------------------------------------------------------------

_INTERNAL_TRANSFER_PATTERNS = [
    re.compile(r"\bonline banking transfer\s+(to|from)\b", re.I),
    re.compile(r"\btransfer\s+(to|from)\s+(chk|sav|acct|account)\b", re.I),
    re.compile(r"\bDDA\s+TO\s+DDA\b", re.I),
    re.compile(r"\bTFR\s+(TO|FROM)\b", re.I),
    re.compile(r"\bINTERNAL\s+TRANSFER\b", re.I),
    re.compile(r"\bBOOK\s+TRANSFER\b", re.I),
]

_BANK_FEE_PATTERNS = [
    re.compile(r"\bMONTHLY (MAINTENANCE|SERVICE) (FEE|CHARGE)\b", re.I),
    re.compile(r"\bOVERDRAFT\b", re.I),
    re.compile(r"\bWIRE (TRANSFER )?FEE\b", re.I),
    re.compile(r"\bATM FEE\b", re.I),
    re.compile(r"\bNSF FEE\b", re.I),
    re.compile(r"\bRETURNED ITEM\b", re.I),
    re.compile(r"\bSERVICE CHARGE\b", re.I),
    re.compile(r"\bANNUAL FEE\b", re.I),
]

_INTEREST_PATTERNS = [
    re.compile(r"\bINTEREST (EARNED|PAID|CREDIT)\b", re.I),
    re.compile(r"\bINTRST (PYMNT|CREDIT)\b", re.I),
    re.compile(r"\bAPY (EARNED|PAID)\b", re.I),
]


def is_internal_transfer(description: str | None) -> bool:
    """True when the description matches a bank-to-bank transfer pattern.
    A transfer should book DR: destination-cash / CR: source-cash — not to
    income or expense. Callers should route these to a suspense/transfer
    account and flag needs_review.
    """
    if not description:
        return False
    return any(p.search(description) for p in _INTERNAL_TRANSFER_PATTERNS)


def _regex_rules(description: str, amount: float) -> Optional[tuple[str, str]]:
    """Return (account_code, reasoning) for regex-based patterns."""
    if not description:
        return None
    for p in _BANK_FEE_PATTERNS:
        if p.search(description):
            return ("7000", f"Bank fee pattern: {p.pattern}")
    for p in _INTEREST_PATTERNS:
        if p.search(description):
            # Interest earned → income; interest paid → expense (bank fees)
            if amount >= 0:
                return ("4200", "Interest income pattern")
            return ("7000", "Interest paid → bank fees")
    return None


# ---------------------------------------------------------------------------
# 3. Public API
# ---------------------------------------------------------------------------

def rules_lookup(
    merchant: str | None,
    description: str | None,
    amount: float,
) -> Optional[dict]:
    """Return {account_code, confidence, reasoning, cache_hit=False, source='rule'}
    when a deterministic rule matches; None otherwise.

    Never returns an internal-transfer classification — callers detect those
    upstream with `is_internal_transfer()` (they need special GL handling).
    """
    # Internal transfers get no rule match — caller handles them.
    if is_internal_transfer(description):
        return None

    haystack = f" {merchant or ''} {description or ''} ".upper()
    if not haystack.strip():
        return None

    # 1) Regex rules first (fees, interest — very high signal)
    reg = _regex_rules(description or "", amount)
    if reg:
        code, reason = reg
        return {
            "account_code": code,
            "confidence": 0.95,
            "reasoning": reason,
            "cache_hit": False,
            "source": "rule",
        }

    # 2) Merchant dictionary — longest key first
    for key, code, reason in _RULES_INDEX:
        if key in haystack:
            return {
                "account_code": code,
                "confidence": 0.95,
                "reasoning": f"Merchant rule: '{key}' → {reason}",
                "cache_hit": False,
                "source": "rule",
            }
    return None


__all__ = [
    "MERCHANT_RULES",
    "rules_lookup",
    "is_internal_transfer",
]
