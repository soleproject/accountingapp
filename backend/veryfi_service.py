"""Veryfi document OCR client — bank statement processing."""
from __future__ import annotations
import os
import io
import re
import httpx
from typing import Any

# Matches "PERSON NAME 0-31004" rows Veryfi emits for multi-cardholder
# credit-card statements (Amex, Chase Ink, Cap One Spark). These are
# per-cardholder subtotal rows — NOT real transactions. If they land in
# the ledger the balance is double-counted by the exact sum of the
# underlying charges (each individual charge is *also* extracted). Real
# merchant transactions always carry a location, terminal id, or Amex
# reference number that breaks this bare-name-plus-card-ending shape.
_CARDHOLDER_SUBTOTAL_RE = re.compile(
    r"^([A-Z]+ )+"                     # 1+ ALL-CAPS name tokens (incl. single-letter middle initials like "N")
    r"(?:JR|SR|II|III|IV )?"           # optional generational suffix
    r"[0-9]-3[0-9]{4}\s*$",            # card ending code (Amex: 0-31XXX)
    re.IGNORECASE,
)


def _is_cardholder_subtotal(desc: str, *, card_number: str | None = None) -> bool:
    """True when a Veryfi row is a per-cardholder rollup rather than a real
    transaction. Two signals are checked (either sufficient):

      1. `card_number` is populated on the row AND the description text
         contains no dollar sign, no comma-separated amount, and no
         obvious merchant/city token — i.e. the OCR pulled only the
         cardholder's name next to their card ending. This is the
         cleanest signal per Veryfi's docs (`card_number` is a per-
         transaction field intended to distinguish authorized users on
         multi-cardholder cards).

      2. Description alone matches the "NAME 0-31XXX" bare-cardholder
         pattern. Kept as a fallback for older responses where the OCR
         didn't split `card_number` into its own field.
    """
    if not desc:
        return False
    text = desc.strip()
    # Signal 1 — populated card_number AND essentially just a name in the OCR text.
    if card_number:
        # A real charge line always carries either a $ sign, a decimal
        # amount separator, digits (store #, phone), OR any lowercase
        # letters. If the OCR returned only ALL-CAPS letters + spaces (no
        # digits, no punctuation, no lowercase), it's a cardholder
        # subtotal row with the merchant column empty.
        stripped = text.strip()
        if stripped and not re.search(r"[\d\$\.,]|[a-z]", stripped):
            return True
    # Signal 2 — description-based fallback (works even when card_number is empty).
    return bool(_CARDHOLDER_SUBTOTAL_RE.match(text))

VERYFI_BASE = "https://api.veryfi.com"
BANK_STMT_PATH = "/api/v8/partner/bank-statements/"
DOCS_PATH = "/api/v8/partner/documents/"

_CLIENT_ID = os.environ["VERYFI_CLIENT_ID"]
_USERNAME = os.environ["VERYFI_USERNAME"]
_API_KEY = os.environ["VERYFI_API_KEY"]


def _headers() -> dict:
    return {
        "CLIENT-ID": _CLIENT_ID,
        "Authorization": f"apikey {_USERNAME}:{_API_KEY}",
        "Accept": "application/json",
    }


async def process_bank_statement(file_bytes: bytes, filename: str, content_type: str) -> dict:
    """Upload a bank statement file to Veryfi and return the parsed JSON."""
    url = f"{VERYFI_BASE}{BANK_STMT_PATH}"
    files = {"file": (filename, io.BytesIO(file_bytes), content_type)}
    async with httpx.AsyncClient(timeout=120.0) as client:
        r = await client.post(url, headers=_headers(), files=files)
    if r.status_code >= 400:
        # Fall back to generic documents endpoint (some accounts may not have bank-statement product enabled)
        return await process_generic_document(file_bytes, filename, content_type)
    # Log cost — one document = one billable unit.
    try:
        from ai_usage import record_service
        await record_service(feature="veryfi-bank-statement", service="veryfi_ocr", quantity=1, unit="document")
    except Exception:
        pass
    return r.json()


async def process_generic_document(file_bytes: bytes, filename: str, content_type: str) -> dict:
    """Fallback: use Veryfi's general documents endpoint (works on receipts + statements)."""
    url = f"{VERYFI_BASE}{DOCS_PATH}"
    files = {"file": (filename, io.BytesIO(file_bytes), content_type)}
    async with httpx.AsyncClient(timeout=120.0) as client:
        r = await client.post(url, headers=_headers(), files=files)
    r.raise_for_status()
    try:
        from ai_usage import record_service
        await record_service(feature="veryfi-document", service="veryfi_ocr", quantity=1, unit="document")
    except Exception:
        pass
    return r.json()


def extract_transactions(veryfi_data: dict) -> list[dict]:
    """Normalize Veryfi output → list of {date, description, amount, merchant} rows.

    Handles all three Veryfi response shapes we've observed in production:
      1. Top-level `transactions[]` (older bank-statement shape).
      2. `accounts[i].transactions[]` (current bank-statement shape — Feb 2026;
         Veryfi's new product returns one accounts[] entry per account with
         nested transactions. Empty top-level transactions[] is normal here).
      3. `line_items[]` (fallback documents endpoint for receipts).
    """
    result: list[dict] = []

    def _add_from_txn_shape(t: dict) -> None:
        date = t.get("date") or t.get("date_of_transaction") or t.get("posted_date") or ""
        desc = (t.get("description") or t.get("description_text")
                or t.get("line_item_as_text") or t.get("text") or "").strip()
        credit = t.get("credit_amount") or t.get("credit")
        debit = t.get("debit_amount") or t.get("debit")
        try:
            if credit is not None and float(credit) != 0:
                amt = float(credit)
            elif debit is not None and float(debit) != 0:
                amt = -abs(float(debit))
            else:
                amt = float(t.get("amount") or 0)
        except Exception:  # noqa: BLE001
            amt = 0.0
        if not desc and amt == 0:
            return
        # Collapse Veryfi's `text` field which sometimes has tabs + newlines
        clean = " ".join(desc.split())
        # Drop cardholder-subtotal rows using both the description regex
        # and Veryfi's per-transaction `card_number` signal (see docstring
        # on `_is_cardholder_subtotal` for the two-signal logic).
        if _is_cardholder_subtotal(clean, card_number=t.get("card_number")):
            return
        # Bank-statement rows have no separate "vendor" field — the full
        # cleaned memo IS the best merchant string we have. Previously we
        # took only the first token (e.g. "COSTCO WHSE #0646 SPARKS NV"
        # → "COSTCO"), which dropped location codes, check numbers, and
        # Zelle recipient names from the UI. Downstream `contact_resolver`
        # already handles long/noisy merchant strings via its AI path.
        result.append({
            "date": str(date)[:10],
            "description": clean,
            "merchant": clean or "Statement Line",
            "amount": round(amt, 2),
        })

    # Shape 1: top-level transactions
    for t in (veryfi_data.get("transactions") or []):
        _add_from_txn_shape(t)

    # Shape 2: nested inside each account
    for acct in (veryfi_data.get("accounts") or []):
        if not isinstance(acct, dict):
            continue
        for t in (acct.get("transactions") or []):
            _add_from_txn_shape(t)

    # Shape 3: documents-endpoint line_items fallback
    for li in (veryfi_data.get("line_items") or []):
        try:
            amt = -abs(float(li.get("total") or 0))
        except Exception:  # noqa: BLE001
            amt = 0.0
        desc = li.get("description") or li.get("full_description") or ""
        if not desc and amt == 0:
            continue
        result.append({
            "date": (veryfi_data.get("date") or "")[:10],
            "description": desc.strip(),
            "merchant": (veryfi_data.get("vendor") or {}).get("name")
                        or (desc.split()[0] if desc else "Vendor"),
            "amount": round(amt, 2),
        })
    return result
