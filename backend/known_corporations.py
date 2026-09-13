"""Known corporations — Tier 1 fast-path exclusion for the 1099
vendor classifier.

Purpose
    Cheap, zero-latency exclusion of vendors that are obviously
    corporations, payment rails, banks, utilities, airlines, telcos,
    or common SaaS/retail chains — none of which ever need a 1099-NEC
    from the client. Catches the ~60% of vendor volume on a typical
    book without a single LLM call.

Match strategy
    Aliases are RESOLVED-CONTACT-NAME matchers, not raw-memo matchers.
    The upstream contact_resolver already strips payment-rail prefixes
    like "SQ *", "PAYPAL *", "VENMO*" and hands us the real merchant —
    so we deliberately don't include those prefixes here. Doing so
    would cause "SQ *ANNIE'S DINER" to be classified as a corporation
    when Annie's Diner may in fact be a 1099 contractor paid via
    Square.

    We normalize the incoming name (lower, strip punctuation, collapse
    whitespace) and check whether any alias occurs as a substring —
    forgiving enough to match "SHELL #4432 LOS ANGELES" against
    "shell" without a database of every branch code.

    Aliases themselves are also normalized at module load so the two
    sides always speak the same string.

When to escalate
    Anything not caught here → Tier 2 (the semantic LLM classifier
    living in `contact_auditor.py`). Every unknown vendor pays one
    Haiku call, cached forever on the contact.
"""
from __future__ import annotations
import re

# Raw alias list — entries are contact-name substrings we want to
# recognize. Normalized at load time via `_normalize` below.
_RAW_ALIASES: tuple[str, ...] = (
    # -- Big-box retail / warehouse clubs / grocery ---------------------
    "walmart", "wal-mart", "wal mart", "target", "costco", "sams club",
    "sam's club", "amazon", "amzn", "amazon.com", "home depot", "homedepot",
    "lowes", "lowe's", "best buy", "bestbuy", "kohls", "kohl's", "macys",
    "macy's", "nordstrom", "ikea", "whole foods", "wholefoods", "kroger",
    "trader joes", "trader joe's", "publix", "wegmans", "aldi", "safeway",
    "albertsons", "meijer", "sprouts", "harris teeter", "food lion",
    "stop & shop", "shoprite", "winco", "tj maxx", "tjmaxx", "marshalls",
    "homegoods", "ross stores", "ross dress",  "burlington", "big lots",
    "dollar general", "dollar tree", "family dollar", "five below",
    "office depot", "office max", "staples", "petsmart", "petco",
    "walgreens", "cvs", "rite aid", "duane reade", "michaels", "hobby lobby",
    "bed bath", "bed bath & beyond", "container store", "world market",

    # -- Payment rails (1099-K covers, never 1099-NEC) ------------------
    "zelle", "venmo", "paypal", "cash app", "cashapp",
    "stripe", "square inc", "braintree", "adyen", "wise",
    "revolut", "chime",

    # -- Banks / brokerages / credit unions -----------------------------
    "chase", "jpmorgan", "j.p. morgan", "bank of america", "bofa",
    "wells fargo", "citi", "citibank", "capital one", "us bank",
    "u.s. bank", "td bank", "pnc bank", "truist", "usaa", "ally",
    "discover bank", "discover card", "american express", "amex",
    "charles schwab", "fidelity", "vanguard", "e*trade", "etrade",
    "morgan stanley", "goldman sachs", "hsbc", "santander", "regions bank",
    "fifth third", "citizens bank", "keybank", "m&t bank", "huntington",
    "navy federal", "penfed", "alliant credit",

    # -- Airlines ------------------------------------------------------
    "american airlines", "united airlines", "delta air", "southwest",
    "jetblue", "alaska airlines", "spirit airlines", "frontier airlines",
    "hawaiian airlines", "allegiant", "sun country",

    # -- Hotels / lodging chains ---------------------------------------
    "marriott", "hilton", "hyatt", "ihg", "intercontinental",
    "wyndham", "choice hotels", "best western", "la quinta", "motel 6",
    "residence inn", "hampton inn", "holiday inn", "courtyard by",
    "airbnb", "vrbo", "expedia", "booking.com", "hotels.com",

    # -- Telcos / ISPs / cable ------------------------------------------
    "verizon", "at&t", "at & t", "att uverse", "att.com", "t-mobile",
    "t mobile", "tmobile", "sprint", "comcast", "xfinity", "spectrum",
    "cox communications", "centurylink", "frontier communications",
    "dish network", "directv", "google fi", "mint mobile", "cricket wireless",
    "boost mobile",

    # -- Utilities (electric/gas/water — commonly single-provider) -----
    "pg&e", "pge.com", "con ed", "coned", "consolidated edison",
    "duke energy", "national grid", "dominion energy", "southern company",
    "exelon", "xcel energy", "nextera", "sce ", "so cal edison",
    "socalgas", "so cal gas", "pseg", "puget sound energy",

    # -- Insurance carriers (large, corporate) -------------------------
    "state farm", "geico", "allstate", "progressive", "farmers insurance",
    "liberty mutual", "nationwide", "travelers", "usaa insurance",
    "the hartford", "american family",

    # -- Major SaaS / tech / cloud -------------------------------------
    "microsoft", "msft", "msbill.info", "adobe", "adobe.com", "salesforce",
    "zoom", "slack", "dropbox", "docusign", "hubspot", "google",
    "google *", "google svcs", "google workspace", "google cloud",
    "amazon web services", "aws", "cloudflare", "digitalocean", "heroku",
    "atlassian", "jira", "asana", "notion", "monday.com", "airtable",
    "quickbooks", "intuit", "xero", "gusto", "adp", "paychex", "rippling",
    "workday", "sap", "oracle", "netsuite", "shopify", "squarespace",
    "wix.com", "godaddy", "namecheap", "canva", "figma", "linkedin",
    "meta platforms", "facebook ads", "google ads", "youtube",
    "spotify", "netflix", "hulu", "disney plus", "paramount plus",
    "apple.com/bill", "apple services", "itunes", "app store",

    # -- Fuel / gas stations -------------------------------------------
    "shell", "chevron", "exxon", "exxonmobil", "mobil", "bp", "marathon",
    "sunoco", "valero", "speedway", "circle k", "7-eleven", "7 eleven",
    "wawa", "sheetz", "casey's general", "quiktrip", "arco", "76 gas",
    "phillips 66", "conoco", "pilot travel", "flying j", "love's travel",

    # -- Restaurant chains ---------------------------------------------
    "mcdonalds", "mcdonald's", "starbucks", "chipotle", "subway",
    "chick-fil-a", "chick fil a", "chickfila", "panera", "dunkin",
    "wendys", "wendy's", "burger king", "taco bell", "kfc",
    "pizza hut", "dominos", "domino's", "papa johns", "papa john's",
    "little caesars", "olive garden", "outback", "cheesecake factory",
    "chilis", "chili's", "applebees", "applebee's", "red lobster",
    "buffalo wild wings", "in-n-out", "in n out", "five guys",
    "shake shack", "sweetgreen", "cava", "panda express",
    "raising cane's", "raising canes", "jimmy john's", "jimmy johns",
    "jersey mike's", "arby's", "arbys",

    # -- Shipping / mail -----------------------------------------------
    "ups store", "united parcel", "fedex", "usps.com", "usps stamps",
    "dhl express", "stamps.com", "pitney bowes", "endicia",

    # -- Rideshare / delivery apps (also 1099-K rails) -----------------
    "uber", "lyft", "uber eats", "doordash", "grubhub", "instacart",
    "postmates", "seamless",

    # -- Auto / rental / dealerships -----------------------------------
    "hertz", "avis", "enterprise rent", "budget rent", "national car",
    "alamo rent", "sixt", "turo",

    # -- Auto services / parts chains ----------------------------------
    "autozone", "advance auto parts", "o'reilly auto", "oreilly auto",
    "napa auto", "jiffy lube", "midas", "valvoline",

    # -- Big pharmacy / health chains ----------------------------------
    "walgreens.com", "cvs.com", "rite-aid", "riteaid",

    # -- Government / tax rails ----------------------------------------
    "irs.gov", "irs *", "irs treas", "irs usataxpymt", "franchise tax",
    "state of ", "dept of revenue", "department of revenue",
    "us treasury", "u.s. treasury", "social security admin",
    "dept of the treasury",
)


_NORM_PATTERN = re.compile(r"[^a-z0-9&' ]+")


def _normalize(name: str) -> str:
    """Lowercase, strip punctuation (keep &, apostrophe, digit),
    collapse whitespace. Same rules used elsewhere in the resolver
    stack — do NOT diverge without also updating the alias entries.
    """
    if not name:
        return ""
    n = name.lower().strip()
    n = _NORM_PATTERN.sub(" ", n)
    n = re.sub(r"\s+", " ", n).strip()
    return n


# Normalize aliases at load time so lookup and alias speak the same
# string. Filter empties in case a raw alias becomes "" after strip.
_EXCLUSION_ALIASES: frozenset[str] = frozenset(
    a for a in (_normalize(x) for x in _RAW_ALIASES) if a
)


def is_known_corporation(vendor_name: str) -> bool:
    """Return True if `vendor_name` matches any known-corporation alias.

    Substring match — "SHELL OIL 12345" and "shell #4432 los angeles"
    both hit "shell". This is the whole point: bank statement memos
    are noisy and we want the fast-path to be forgiving.
    """
    n = _normalize(vendor_name)
    if not n:
        return False
    for alias in _EXCLUSION_ALIASES:
        if alias in n:
            return True
    return False


def classify_tier1(vendor_name: str) -> dict | None:
    """Return a classification dict if Tier 1 catches this vendor,
    else None (caller escalates to Tier 2 / Haiku).

    Shape matches what the semantic classifier returns so downstream
    callers don't branch on tier.
    """
    if is_known_corporation(vendor_name):
        return {
            "class":          "corporation",
            "needs_1099":     False,
            "confidence":     1.0,
            "source":         "known_corporation_list",
        }
    return None


__all__ = ["is_known_corporation", "classify_tier1"]
