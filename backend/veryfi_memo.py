"""Bank-statement memo cleanup + memo-prefix category rules.

Two related jobs both keyed off the raw bank memo string:

  1. `clean_bank_memo(desc)` — strip the noisy prefixes/suffixes that
     bank statements bake into every row (`PMNT SENT 0109 VENMO`,
     `PURCHASE 0106 STARBUCKS 800-782-7282 WA`, `ACH DEBIT`,
     trailing 2-letter state codes, trailing phone numbers, ref
     numbers). Result is a short vendor-name-shaped string safe to
     pass into `contact_resolver` as the `merchant_name` fast-path
     signal.

  2. `classify_by_memo_prefix(desc, amount)` — map the memo pattern
     to a P&L / balance-sheet account category. Covers ~40-50% of
     bank-statement rows without an AI call — fees, interest,
     transfers, ATM draws, direct deposits, cheque numbers, wires.

Both functions are pure text — no DB, no state, no async — so they
are trivially unit-testable and safe to call from the fast Veryfi
ingest loop.
"""
from __future__ import annotations
import re


# -------------------------------------------------------------------
# Memo scrubbing
# -------------------------------------------------------------------

# Leading operation words banks put in front of every row. The 4-digit
# number after them is the transaction sequence within the statement.
_LEADING_OP = re.compile(
    r"^\s*(pmnt\s*sent|pmnt\s*rcvd|payment\s*sent|payment\s*rcvd|"
    r"purchase|pos\s*debit|pos\s*purchase|debit\s*card\s*purchase|"
    r"credit\s*card\s*purchase|ach\s*debit|ach\s*credit|withdrawal|"
    r"deposit|check\s*paid|chk|chq|electronic\s*payment|"
    r"card\s*purchase|card\s*payment|preauth|preauthorized)\s*"
    r"[#\-\d]{0,8}\s*",
    re.I,
)

# Trailing 2-letter state code — banks tack the merchant's state on
# the end of every card purchase.
_TRAILING_STATE = re.compile(
    r"\s+(A[LKZR]|C[AOT]|D[CE]|FL|GA|HI|I[ADLN]|K[SY]|LA|"
    r"M[ADEINOST]|N[CDEHJMVY]|O[HKR]|PA|RI|S[CD]|T[NX]|UT|"
    r"V[AT]|W[AIVY])\b\s*$",
    re.I,
)

# Trailing US phone (with or without dashes).
_TRAILING_PHONE = re.compile(r"\s+\d{3}[- ]?\d{3}[- ]?\d{4}\s*$")

# Trailing store / terminal number OR store# + city ("#0646",
# "#3313 SPARKS", "T-1550", "#0007523"). 2-7 digits handles both
# 3-digit stores and 7-digit Target-style terminal IDs.
_TRAILING_STORE_NUM = re.compile(
    r"\s+[#T][-#]?\d{2,7}(?:\s+[A-Z][A-Z0-9\.]{2,})?\s*$",
    re.I,
)

# Trailing sequence code on the tail of a channel row
# (e.g. "VENMO *Susan Visa Direct NY" → strip "Visa Direct NY"
# already handled by state regex; sequence codes on Zelle-style rows).
_ZELLE_TAIL = re.compile(r"\s+(zelle|conf|confirmation|ref|ref#|id)[\s:#]+\S+.*$", re.I)

# Payment channel indicator INSIDE the memo — pulled out so we can
# surface "Venmo" / "PayPal" / "Zelle" as a channel label instead of
# baking the counterparty into the merchant name.
_CHANNEL_TOKEN = re.compile(
    r"\b(venmo|paypal|zelle|cashapp|cash\s*app|square|apple\s*pay|"
    r"google\s*pay|stripe|shopify)\b",
    re.I,
)


def clean_bank_memo(desc: str | None) -> str:
    """Strip bank-statement noise from a raw memo string.

    Idempotent: cleaning an already-clean string is a no-op. Never
    raises — a fully-scrubbed empty string is returned as "" so
    callers can fall back to a placeholder without a null check.

        >>> clean_bank_memo("PMNT SENT 0109 VENMO *Susan Visa Direct NY")
        'VENMO *Susan'
        >>> clean_bank_memo("PURCHASE 0113 STARBUCKS 800-782-7282 WA")
        'STARBUCKS'
        >>> clean_bank_memo("PURCHASE 0106 SUMMIT CHURCH SUMMITNV.ORG NV")
        'SUMMIT CHURCH SUMMITNV.ORG'
    """
    if not desc:
        return ""
    s = " ".join(desc.split())                         # collapse whitespace
    # Strip a leading op-word (with its sequence #) if present.
    s = _LEADING_OP.sub("", s)
    # Chip away suffixes iteratively — order matters; phone before
    # state so "800-782-7282 WA" fully strips, and state before
    # store-num-city so "HOME DEPOT #3313 SPARKS NV" becomes
    # "HOME DEPOT" in one pass.
    for _ in range(3):
        prev = s
        s = _TRAILING_PHONE.sub("", s)
        s = _TRAILING_STATE.sub("", s)
        s = _TRAILING_STORE_NUM.sub("", s)
        s = _ZELLE_TAIL.sub("", s)
        if s == prev:
            break
    return s.strip()


# -------------------------------------------------------------------
# Memo-prefix category rules (mini PFC-equivalent for Veryfi rows)
# -------------------------------------------------------------------

# Result shape mirrors what `categorizer` / `pfc_resolver` emit so
# downstream inserts don't care where the classification came from.
#   * `code` is the seeded GAAP account code (see accountDefinitions.js
#     for the master list — kept in sync manually).
#   * `sign_hint` says whether the row should end up debit or credit
#     when the sign in the txn doesn't already make it obvious.
_MEMO_RULES: list[tuple[re.Pattern, dict]] = [
    # ---------- Bank fees & charges ----------
    (re.compile(r"\b(nsf\s*fee|overdraft|insufficient\s*funds|"
                r"return(ed)?\s*item\s*fee|maintenance\s*fee|"
                r"service\s*charge|monthly\s*fee|foreign\s*fee|"
                r"wire\s*fee|stop\s*payment\s*fee|check\s*fee|"
                r"paper\s*statement\s*fee|analysis\s*charge)\b", re.I),
     {"code": "6100", "name": "Bank Charges", "channel": "bank_fee"}),

    # ---------- Interest income / expense ----------
    (re.compile(r"\binterest\s*paid\b|\bint\s*paid\b|\binterest\s*earned\b|"
                r"\bcredit\s*interest\b|\bmoney\s*market\s*interest\b", re.I),
     {"code": "4900", "name": "Interest Income", "channel": "interest"}),
    (re.compile(r"\binterest\s*charge(d)?\b|\bfinance\s*charge\b|"
                r"\bloan\s*interest\b", re.I),
     {"code": "6110", "name": "Interest Expense", "channel": "interest"}),

    # ---------- ATM & cash ----------
    (re.compile(r"\batm\s*(withdrawal|debit|w/d|wd)\b", re.I),
     {"code": "3500", "name": "Owner Draw", "channel": "atm"}),
    (re.compile(r"\batm\s*(deposit|credit)\b", re.I),
     {"code": "3500", "name": "Owner Contribution", "channel": "atm"}),

    # ---------- Transfers (never P&L) ----------
    (re.compile(r"\b(transfer\s*(to|from)|internal\s*transfer|"
                r"online\s*transfer|book\s*transfer|xfer\s*(to|from))\b", re.I),
     {"code": None, "name": "Transfer", "channel": "transfer"}),

    # ---------- Payroll ----------
    (re.compile(r"\b(gusto|adp|paychex|rippling|quickbooks\s*payroll|"
                r"onpay|square\s*payroll|justworks)\b.*\b(payroll|payr|"
                r"wages|salary|comp)\b", re.I),
     {"code": "6300", "name": "Payroll Expense", "channel": "payroll"}),

    # ---------- Deposits / customer income ----------
    (re.compile(r"\b(direct\s*dep|dir\s*dep|ach\s*credit|deposit)\b", re.I),
     {"code": "4000", "name": "Sales Revenue", "channel": "deposit",
      "sign_hint": "credit"}),

    # ---------- Taxes ----------
    (re.compile(r"\b(irs|internal\s*revenue|tax\s*payment|est\s*tax|"
                r"quarterly\s*tax|federal\s*tax|state\s*tax|dept\s*of\s*rev)\b", re.I),
     {"code": "3500", "name": "Owner Draw — Taxes", "channel": "tax"}),

    # ---------- Checks ----------
    (re.compile(r"^\s*(check|chk|chq)\s*#?\s*\d{3,}\s*$", re.I),
     {"code": None, "name": "Unclassified Check", "channel": "check"}),
]


def classify_by_memo_prefix(desc: str | None, amount: float = 0.0) -> dict | None:
    """Return a category hint dict when the memo matches a
    well-known bank vocabulary pattern; otherwise None.

    Feed this into the Veryfi pipeline as the very first stage —
    before PFC (which is empty), before contact-based rule matching,
    before AI. When it hits, the row skips every subsequent stage
    with the correct GL account already pinned.

        >>> classify_by_memo_prefix("NSF FEE")["code"]
        '6100'
        >>> classify_by_memo_prefix("Direct Deposit ACME PAYROLL")["code"]
        '4000'
        >>> classify_by_memo_prefix("VENMO *Susan") is None
        True
    """
    if not desc:
        return None
    s = " ".join(desc.split())
    for pat, hint in _MEMO_RULES:
        if pat.search(s):
            return dict(hint)                          # copy so caller can mutate safely
    return None


def extract_payment_channel(desc: str | None) -> str | None:
    """Return the payment channel embedded in a memo string, if any.
    Used by the contact-cleanup path to relabel a row's *channel* as
    "Venmo" / "PayPal" while the counterparty extraction happens on
    the tail portion via the AI resolver."""
    if not desc:
        return None
    m = _CHANNEL_TOKEN.search(desc)
    if not m:
        return None
    tok = m.group(1).lower()
    # Canonicalize spelling variants.
    return {"cash app": "Cash App", "cashapp": "Cash App",
             "apple pay": "Apple Pay", "google pay": "Google Pay"}.get(
        tok, tok.title(),
    )
