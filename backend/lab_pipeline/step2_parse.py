"""Step 2 — deterministic parsing + channel classification.

Zero DB access. Pure functions so they can be unit-tested cheaply.

What each function does:
  * :func:`infer_direction`     — inflow / outflow from the perspective
                                  of the account the row belongs to,
                                  handling credit-card sign convention.
  * :func:`parse_bank_desc`     — Bank-of-America ACH descriptor
                                  parser: originator / DES / ID / INDN
                                  / CO ID. INDN is the accountholder,
                                  never a counterparty. Other-bank
                                  formats: stored unparsed with a
                                  ``format_tag`` for later coverage
                                  reports.
  * :func:`parse_paypal_boa`    — the BofA PayPal INST XFER row: ID =
                                  "CREDIT REPAYMEN" → credit account
                                  payment; other outflow ID → merchant
                                  name (~15 char).
  * :func:`classify_channel`    — routes each row into a canonical
                                  channel enum used by the downstream
                                  steps.
"""
from __future__ import annotations
import re
from typing import Optional, TypedDict


# ---------- direction ---------------------------------------------------

def infer_direction(*, amount: float | int | None,
                    account_type: str | None) -> str:
    """Return ``"in"`` or ``"out"`` from the account's perspective.

    Live txns store the raw signed amount from Plaid, which uses:
      * Depository / cash accounts: positive = money leaving (outflow),
        negative = money arriving (inflow).
      * Credit accounts (liabilities): positive = charge (outflow from
        the business's perspective — increases the liability); negative
        = payment (inflow to the card, reduces liability).
    We fold both into a single "in" / "out" from the business's
    cash-flow perspective.
    """
    amt = float(amount or 0)
    a_type = (account_type or "").strip().lower()
    if a_type in ("credit", "credit card", "liability", "credit_card"):
        # Charges push liability up (business's cash goes out later);
        # payments push it back down.
        return "out" if amt > 0 else "in"
    # Depository / bank accounts. Plaid convention:
    # positive amount = money leaving the account.
    return "out" if amt > 0 else "in"


# ---------- BofA-style ACH descriptor parser ---------------------------

class ParsedBankDesc(TypedDict, total=False):
    format:       str          # "boa_ach" | "unknown"
    originator:   str          # e.g. "PAYPAL", "CITI CARD ONLINE"
    des:          str          # descriptor code after DES:
    id_value:     str          # ID: value (truncated)
    indn:         str          # INDN: accountholder name
    co_id:        str          # CO ID: value
    payment_channel: str       # "WEB" | "PPD" | "CCD" | "TEL"
    unparsed:     bool         # True when we couldn't extract
    format_tag:   str          # short label for coverage reports


_BOA_ACH_RX = re.compile(
    r"^(?P<orig>[A-Z][A-Z0-9 &.,'\-/]{1,40}?)"
    r"\s*DES\s*:\s*(?P<des>[A-Z0-9 &.,'\-/]{1,25}?)"
    r"\s+ID\s*:\s*(?P<id>[A-Z0-9 &.,'\-/]{1,25}?)"
    r"\s+INDN\s*:\s*(?P<indn>[A-Z][A-Z0-9 &.,'\-]{0,60}?)"
    r"\s+CO\s*ID\s*:\s*(?P<coid>[A-Z0-9]+)"
    r"(?:\s+(?P<pchan>WEB|PPD|CCD|TEL|ARC))?\s*$",
    re.IGNORECASE,
)


def parse_bank_desc(description: str | None) -> ParsedBankDesc:
    """Parse a Bank-of-America ACH descriptor. Returns
    ``{"unparsed": True, "format_tag": ...}`` when it doesn't match —
    the caller can still use the row, just without structured fields.
    """
    d = (description or "").strip()
    if not d:
        return {"unparsed": True, "format_tag": "empty"}
    m = _BOA_ACH_RX.match(d)
    if not m:
        # Some other-bank formats to tag for coverage report only.
        low = d.lower()
        tag = "wells_fargo_ifi" if "wells fargo ifi" in low else (
            "wells_fargo"       if "wells fargo"      in low else (
            "chase"             if "chase " in low    else (
            "citi"              if low.startswith("citi") else "unknown"
        )))
        return {"unparsed": True, "format_tag": tag}
    return {
        "format":         "boa_ach",
        "originator":     _clean(m.group("orig")),
        "des":            _clean(m.group("des")),
        "id_value":       _clean(m.group("id")),
        "indn":           _clean(m.group("indn")).title(),
        "co_id":          _clean(m.group("coid")),
        "payment_channel": (m.group("pchan") or "").upper() or None,
        "unparsed":       False,
        "format_tag":     "boa_ach",
    }


def _clean(s: str | None) -> str:
    return re.sub(r"\s+", " ", (s or "").strip())


# ---------- PayPal BoA-format handler ---------------------------------

CREDIT_REPAYMENT_TOKENS = frozenset({
    "credit repaymen", "credit repayment", "credit repay",
})


class PayPalRouting(TypedDict, total=False):
    kind:       str    # "credit_account_payment" | "merchant_purchase"
                       # | "inflow_review" | None (not a PayPal row)
    merchant:   str    # cleaned merchant name for purchases
    reason:     str
    id_value:   str


def parse_paypal_boa(parsed: ParsedBankDesc, *, amount: float | int | None) -> Optional[PayPalRouting]:
    """When the parsed BoA ACH row is a PayPal INST XFER, route it
    per the spec: CREDIT REPAYMEN → credit account payment; other
    outflow ID → merchant name; inflow → review."""
    if parsed.get("format") != "boa_ach":
        return None
    orig = (parsed.get("originator") or "").upper()
    coid = (parsed.get("co_id") or "").upper()
    if "PAYPAL" not in orig or not coid.startswith("PAYPAL"):
        return None
    id_val = (parsed.get("id_value") or "").strip()
    id_low = id_val.lower()
    amt = float(amount or 0)
    if id_low in CREDIT_REPAYMENT_TOKENS:
        return {
            "kind":     "credit_account_payment",
            "id_value": id_val,
            "reason":   "PayPal Credit account payment — liability payment (stage 1)",
        }
    if amt < 0:                                   # inflow into the bank
        return {
            "kind":     "inflow_review",
            "id_value": id_val,
            "reason":   "PayPal inflow — route to review",
        }
    # Outflow purchase — the ID value carries the merchant.
    merchant = id_val[:15].strip(" -.,").title() or None
    return {
        "kind":     "merchant_purchase",
        "id_value": id_val,
        "merchant": merchant,
        "reason":   "PayPal-funded purchase; ID value is the merchant",
    }


# ---------- transfer language ------------------------------------------

_TRANSFER_LANG_RX = re.compile(
    r"\b("
    r"DDA\s*TO\s*DDA|DDA\s*FR\s*DDA|"
    r"TRANSFER\s+(?:TO|FROM)|"
    r"ONLINE\s+(?:BANKING\s+)?TRANSFER|"
    r"INTRA[- ]?BANK\s+TRANSFER|INTERNAL\s+TRANSFER|"
    r"BOOK\s+TRANSFER|WIRE\s+TRANSFER|"
    r"ACCT\s+(?:TRANSFER|XFER)|ACCOUNT\s+TRANSFER"
    r")\b",
    re.IGNORECASE,
)

_LAST4_IN_DESC_RX = re.compile(r"(?:CHK|SAV|ACCT|ACCOUNT|CARD)\s*[#·\-\s]*(\d{4,})",
                                re.IGNORECASE)


def has_transfer_language(description: str | None) -> bool:
    return bool(_TRANSFER_LANG_RX.search(description or ""))


def extract_dest_last4(description: str | None) -> Optional[str]:
    """Return the trailing 4 digits of a destination account referenced
    in the description (``transfer to CHK 6278`` → ``6278``)."""
    m = _LAST4_IN_DESC_RX.search(description or "")
    if not m:
        return None
    tail = m.group(1)
    return tail[-4:] if len(tail) >= 4 else None


# ---------- channel classifier ----------------------------------------

CHANNELS = {
    "card_purchase", "ach", "zelle", "wire", "check",
    "payment_app", "transfer_language", "other",
}

_CHECK_RX = re.compile(r"\bCHECK\s*#?\s*\d+\b|\bCHK\s*#?\s*\d+\b", re.IGNORECASE)


def classify_channel(*,
                     description: str | None,
                     merchant: str | None,
                     counterparties: list | None,
                     transaction_code: str | None,
                     payment_channel: str | None,
                     check_number: str | None,
                     parsed: ParsedBankDesc | None) -> str:
    """Deterministic channel enum. Order matters: earlier branches win."""
    desc  = (description or "")
    dlow  = desc.lower()
    tcode = (transaction_code or "").strip().lower()
    pchan = (payment_channel or "").strip().lower()

    if check_number or _CHECK_RX.search(desc):
        return "check"
    if tcode == "wire" or "wire type:" in dlow or "wire transfer" in dlow:
        return "wire"
    if "zelle" in dlow or (merchant or "").strip().lower() == "zelle":
        return "zelle"
    # Payment apps (PayPal, Venmo, Cash App, Square Cash) — the app
    # itself is the wrapper, not the merchant.
    for app in ("paypal", "venmo", "cash app", "cashapp", "square cash"):
        if app in dlow or app in (merchant or "").lower():
            return "payment_app"
    if has_transfer_language(desc):
        return "transfer_language"
    if tcode == "ach" or pchan in {"web", "ppd", "ccd", "tel", "arc"} \
            or (parsed or {}).get("format") == "boa_ach":
        return "ach"
    if tcode in {"place", "special", "atm", "cash"} \
            or "purchase" in dlow or "chkcard" in dlow \
            or "checkcard" in dlow or "pos " in dlow \
            or (merchant and not (parsed or {}).get("indn")):
        return "card_purchase"
    return "other"
