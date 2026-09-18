"""Bank of America PayPal descriptor parser (Step 2 lab).

Only handles the exact BoA format the user pinned:

    PAYPAL DES:INST XFER ID:<value> INDN:<name> CO ID:PAYPALSI77 WEB

Semantics:
  • ID = "CREDIT REPAYMEN"  → payment on a PayPal Credit account
                              (a liability payment, not an expense).
                              Stage-1 question about the account.
  • Any other ID value on an OUTFLOW → PayPal-funded purchase; the
                              ID value (truncated ~15 chars) is the
                              merchant. Sent to registry / LLM
                              matching (no hardcoded merchants).
  • Any inflow                → not a purchase; route to review.

Callers should always prefer Plaid enrichment (``counterparties[]``
or ``merchant``) when it names an actual merchant on these rows — this
parser is a fallback and a source of the "distinct PayPal IDs seen"
diagnostic list.
"""
from __future__ import annotations
import re
from typing import Optional, TypedDict


# BoA format anchor. Requires ``CO ID:PAYPALSI77`` (or ``PAYPAL SI77``)
# so we don't accidentally parse other banks' PayPal rows.
_BOA_PAYPAL_RX = re.compile(
    r"\bPAYPAL\b[^\n]*?\bDES\s*:\s*INST\s*XFER\b"
    r"[^\n]*?\bID\s*:\s*(?P<id>[A-Z0-9 &.,'/\-]+?)"
    r"\s+INDN\s*:\s*(?P<indn>[A-Z][A-Z0-9 &.,'\-]{0,60}?)"
    r"\s+CO\s*ID\s*:\s*PAYPAL\s*SI?77\b",
    re.IGNORECASE,
)

# Alternate order some BoA statements use.
_BOA_PAYPAL_ALT_RX = re.compile(
    r"\bPAYPAL\s+DES\s*:\s*INST\s*XFER\s+ID\s*:\s*(?P<id>[A-Z0-9 &.,'/\-]+?)"
    r"\s+INDN\s*:\s*(?P<indn>[A-Z][A-Z0-9 &.,'\-]{0,60}?)"
    r"\s+CO\s*ID\s*:\s*PAYPALSI?77\b",
    re.IGNORECASE,
)

CREDIT_REPAYMENT_TOKENS = frozenset({
    "credit repaymen", "credit repayment", "credit repay",
})

BOA_CO_ID_PAYPAL = "paypalsi77"


class PayPalParse(TypedDict, total=False):
    kind: str            # "credit_repayment" | "purchase" | "inflow"
    id_value: str        # cleaned raw ID (~15 chars)
    id_key: str          # normalized-lowercase ID (registry lookup key)
    indn: str            # accountholder name — NEVER used as contact
    is_boa_format: bool  # True on any successful parse
    reason: str          # short human-readable diagnostic


def _clean_id(raw: str) -> str:
    """Trim + collapse whitespace + upper-case; keep at most 15 chars
    like the bank descriptor field allows."""
    v = re.sub(r"\s+", " ", (raw or "").strip()).upper()
    return v[:15].rstrip(" -.,")


def parse_boa_paypal(description: str | None) -> Optional[PayPalParse]:
    """Return a ``PayPalParse`` if the descriptor matches the BoA
    PayPal INST XFER format, else None.

    Does NOT decide direction on its own — the caller passes amount
    when calling :func:`classify_boa_paypal_row`.
    """
    if not description:
        return None
    m = _BOA_PAYPAL_RX.search(description) or _BOA_PAYPAL_ALT_RX.search(description)
    if not m:
        return None
    id_value = _clean_id(m.group("id"))
    indn     = re.sub(r"\s+", " ", m.group("indn").strip()).title()
    return {
        "kind":          "unknown",  # caller resolves via amount sign
        "id_value":      id_value,
        "id_key":        id_value.lower().strip(),
        "indn":          indn,
        "is_boa_format": True,
        "reason":        "matched BoA PAYPAL INST XFER format",
    }


def classify_boa_paypal_row(
    description: str | None, amount: float | int | None,
) -> Optional[PayPalParse]:
    """Full classifier: parse + branch on amount sign + credit-repayment
    detection. Returns None when the descriptor doesn't look like BoA
    PayPal INST XFER at all.
    """
    p = parse_boa_paypal(description)
    if not p:
        return None
    amt = float(amount or 0)
    id_key = p.get("id_key", "")
    if id_key in CREDIT_REPAYMENT_TOKENS:
        p["kind"] = "credit_repayment"
        p["reason"] = "PayPal Credit account payment — liability payment, ask stage 1"
    elif amt > 0:
        p["kind"] = "inflow"
        p["reason"] = "PayPal inflow — not a purchase; route to review"
    else:
        p["kind"] = "purchase"
        p["reason"] = "PayPal-funded purchase; ID value is the merchant"
    return p


def has_indn(description: str | None) -> bool:
    """Cheap boolean: does the descriptor carry an ACH INDN: field?
    Used by contact_resolver to skip minting a contact from what is
    really the accountholder name (Step 2 rule)."""
    if not description:
        return False
    return bool(re.search(r"\bINDN\s*:\s*[A-Za-z]", description))


def extract_indn(description: str | None) -> str | None:
    """Extract the INDN: name (accountholder), or None. Kept separate
    from :func:`parse_boa_paypal` because non-PayPal ACH rows also
    carry INDN and we still want to log them in shadow mode."""
    if not description:
        return None
    m = re.search(
        r"\bINDN\s*:\s*([A-Za-z][A-Za-z0-9'\-\.\s&,]{1,60}?)"
        r"(?:\s{2,}|\s+(?:CO\s*ID|EED|IND\s*ID|PPD|CCD|WEB|TEL)\b|$)",
        description, re.IGNORECASE,
    )
    return re.sub(r"\s+", " ", m.group(1).strip()).title() if m else None
