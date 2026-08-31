"""Veryfi document OCR client — bank statement processing."""
from __future__ import annotations
import os
import io
import re
import httpx
from datetime import date as _date, timedelta
from typing import Any


def _parse_iso_date(s: str | None) -> _date | None:
    """Parse a 'YYYY-MM-DD' (or longer) string into a date. None on failure."""
    if not s:
        return None
    try:
        return _date.fromisoformat(str(s)[:10])
    except Exception:  # noqa: BLE001
        return None


def _correct_year_wrap(txn_dates: list[str], closing_date: _date | None) -> list[str]:
    """Fix Veryfi's year-assignment bug on statements that span a year boundary.

    Symptom: for a credit-card statement covering e.g. Dec 26, 2025 → Jan 25,
    2026, Veryfi sometimes stamps ALL transactions with the closing year
    (2026), producing "2026-12-25" for December charges that are really from
    2025. Since a real statement can never contain a transaction dated
    substantially AFTER its closing date, any txn_date > closing_date + 30
    day buffer must be from the prior year and gets rolled back by 12
    months.

    A 30-day buffer (rather than a few days) ensures we ONLY correct the
    year-wrap symptom and never touch legitimate post-close pending dates,
    which settle within a week at most.
    """
    if not closing_date:
        return txn_dates
    cutoff = closing_date + timedelta(days=30)
    corrected: list[str] = []
    for ds in txn_dates:
        d = _parse_iso_date(ds)
        if d and d > cutoff:
            try:
                d = d.replace(year=d.year - 1)
                corrected.append(d.isoformat())
                continue
            except ValueError:
                # Feb 29 on a non-leap prior year — rare on statements
                corrected.append(ds)
                continue
        corrected.append(ds)
    return corrected

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
BANK_STMT_SET_PATH = "/api/v8/partner/bank-statements-set"
DOCS_PATH = "/api/v8/partner/documents/"

_CLIENT_ID = os.environ["VERYFI_CLIENT_ID"]
_USERNAME = os.environ["VERYFI_USERNAME"]
_API_KEY = os.environ["VERYFI_API_KEY"]
_CLIENT_SECRET = os.environ.get("VERYFI_CLIENT_SECRET", "")


def _headers() -> dict:
    return {
        "CLIENT-ID": _CLIENT_ID,
        "Authorization": f"apikey {_USERNAME}:{_API_KEY}",
        "Accept": "application/json",
    }


async def process_bank_statement(file_bytes: bytes, filename: str, content_type: str) -> dict:
    """Upload a bank statement file to Veryfi and return the parsed JSON.

    Sends our curated `categories` list (see `veryfi_categories.py`)
    on every request. When Veryfi's Bank Statements categorization
    feature is enabled on our account (currently OFF — pending
    support@veryfi.com opt-in), each returned transaction will carry
    a `category` string from this list and, for card purchases, a
    `vendor.name` cleaned by their AI. Until that flag is flipped
    the request field is silently ignored server-side and every row
    falls through to our regex scrub + memo-prefix mini-PFC, so
    shipping this today costs nothing and lights up automatically
    the day the account is upgraded.
    """
    from veryfi_categories import BANK_STATEMENT_CATEGORIES
    url = f"{VERYFI_BASE}{BANK_STMT_PATH}"
    files = {"file": (filename, io.BytesIO(file_bytes), content_type)}
    # `categories` must be sent as a repeated multipart field or as a
    # JSON-encoded array in the body. Veryfi's Python SDK JSON-encodes
    # into the `data` dict; the raw REST endpoint accepts the same.
    import json as _json
    data = {"categories": _json.dumps(BANK_STATEMENT_CATEGORIES)}
    async with httpx.AsyncClient(timeout=120.0) as client:
        r = await client.post(url, headers=_headers(), files=files, data=data)
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


def iter_statement_accounts(veryfi_data: dict) -> list[dict]:
    """Split a Veryfi bank-statement JSON into a list of per-account
    "sub-docs", one entry per real account on the statement.

    Returns ``[{"account_ref": {...}, "lines": [...]}]`` where
    ``account_ref`` mirrors the fields
    :func:`statement_account_resolver._statement_fields` looks at (so it
    can be passed straight through as a synthetic single-account doc),
    and ``lines`` are the normalized transaction rows for that account
    only.

    Handles three cases:

    * ``accounts[]`` with 2+ entries → true multi-account combined
      statement (Wells Fargo Combined, Amex Blue + Gold on one PDF,
      Chase Total Checking + Savings, etc.). Each entry becomes its own
      sub-doc with its own beginning/ending balance, summaries, and
      transactions. Downstream code (resolver, OCR guards, reconcile,
      OBE) then runs per-account.
    * ``accounts[]`` with exactly 1 entry → routed as a single-account
      list of length 1. Preserves the current single-statement code
      path unchanged.
    * No ``accounts[]`` at all → falls back to the top-level fields +
      :func:`extract_transactions` output (older bank-statement shape
      and the ``line_items[]`` documents-endpoint fallback).
    """
    accts = veryfi_data.get("accounts") or []
    # No `accounts[]` → single implicit account, use existing extractor.
    if not accts or not isinstance(accts, list):
        return [{
            "account_ref": veryfi_data,
            "lines": extract_transactions(veryfi_data),
        }]
    top_bank = (
        veryfi_data.get("bank_name")
        or (veryfi_data.get("vendor") or {}).get("name")
    )
    top_period_start = (
        veryfi_data.get("period_start_date")
        or veryfi_data.get("start_date")
    )
    top_period_end = (
        veryfi_data.get("period_end_date")
        or veryfi_data.get("end_date")
        or veryfi_data.get("statement_date")
    )
    groups: list[dict] = []
    for i, acct in enumerate(accts):
        if not isinstance(acct, dict):
            continue
        # Build a synthetic "sub-doc" that looks like a single-account
        # Veryfi response — `_statement_fields` will pick it up correctly.
        sub_doc = {
            **veryfi_data,
            "accounts": [acct],
            # Prefer per-account bank_name if Veryfi ever emits it,
            # otherwise fall back to the statement-level bank name.
            "bank_name": acct.get("bank_name") or top_bank,
            # Roll balances up to top-level too so any callsite that
            # reads them without going through `_statement_fields` still
            # sees the per-account values (not `accounts[0]`).
            "starting_balance": (
                acct.get("beginning_balance")
                or acct.get("starting_balance")
            ),
            "ending_balance": (
                acct.get("ending_balance")
                or acct.get("closing_balance")
            ),
            # Period is a statement-level attribute on combined statements
            # (all accounts share the same billing period), so re-project
            # the top-level dates onto the sub-doc.
            "period_start_date": top_period_start,
            "period_end_date": top_period_end,
            "_multi_account_index": i,
            "_multi_account_total": len(accts),
        }
        # Extract lines for THIS account only.
        sub_lines: list[dict] = []
        for t in (acct.get("transactions") or []):
            # Re-use `extract_transactions` on a single-txn sub-doc so
            # cardholder-subtotal filtering + year-wrap correction still
            # fire per-transaction.
            micro = {"transactions": [t],
                     "statement_date": veryfi_data.get("statement_date")
                                       or top_period_end}
            sub_lines.extend(extract_transactions(micro))
        groups.append({"account_ref": sub_doc, "lines": sub_lines})
    return groups


async def process_bank_statement_set(
    file_bytes: bytes, filename: str, content_type: str,
) -> dict:
    """Upload a multi-statement PDF (or a .zip of statements) to Veryfi's
    ``bank-statements-set`` splitter endpoint. Returns immediately with a
    JSON body containing ``id`` (the document-set id) and ``status``
    (typically ``'split_in_progress'``). The actual per-statement OCR
    results arrive later via the Veryfi webhook, handled in
    :func:`routes.veryfi_webhooks.bank_statement_set`.
    """
    url = f"{VERYFI_BASE}{BANK_STMT_SET_PATH}"
    files = {"file": (filename, io.BytesIO(file_bytes), content_type)}
    async with httpx.AsyncClient(timeout=60.0) as client:
        r = await client.post(url, headers=_headers(), files=files)
    if r.status_code >= 400:
        raise RuntimeError(
            f"Veryfi splitter returned {r.status_code}: {r.text[:400]}"
        )
    try:
        from ai_usage import record_service
        # Splitter is charged per resulting statement, but we don't know
        # the count yet — we log a placeholder of 1 here and the webhook
        # handler will log the true per-child count. Kept conservative
        # to avoid double-billing internal telemetry.
        await record_service(
            feature="veryfi-bank-statement-set", service="veryfi_ocr",
            quantity=1, unit="document_set",
        )
    except Exception:
        pass
    return r.json()


async def fetch_bank_statement(document_id: int | str) -> dict:
    """GET the parsed JSON for a single Veryfi bank-statement document.

    Used by the async splitter webhook: Veryfi's ``bank_statement_set``
    payload only gives us the child ``document_id``s, so we must fetch
    each one's full JSON before running it through the shared
    :func:`statements._process_veryfi_result` pipeline.
    """
    url = f"{VERYFI_BASE}{BANK_STMT_PATH}{document_id}/"
    async with httpx.AsyncClient(timeout=60.0) as client:
        r = await client.get(url, headers=_headers())
    if r.status_code >= 400:
        raise RuntimeError(
            f"Veryfi GET {document_id} returned {r.status_code}: {r.text[:400]}"
        )
    return r.json()


def verify_webhook_signature(data_payload: dict, signature_header: str) -> bool:
    """Verify a Veryfi webhook signature.

    Veryfi HMACs ``str(data_payload)`` (i.e. Python's ``str()`` of the
    ``data`` sub-object of the webhook JSON) with the ``client_secret``
    as the key, then base64-encodes the result and sends it in the
    ``x-veryfi-signature`` header. Constant-time comparison. Returns
    False (never raises) when the secret isn't configured — the caller
    then decides whether to reject or accept in dev.
    """
    import hmac
    import hashlib
    import base64
    if not _CLIENT_SECRET or not signature_header:
        return False
    try:
        expected = hmac.new(
            _CLIENT_SECRET.encode("utf-8"),
            msg=str(data_payload).encode("utf-8"),
            digestmod=hashlib.sha256,
        ).digest()
        expected_b64 = base64.b64encode(expected).decode("utf-8").strip()
        return hmac.compare_digest(expected_b64, signature_header.strip())
    except Exception:  # noqa: BLE001
        return False


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
        # Bank-statement rows have no separate "vendor" field. Rather
        # than dumping the entire raw memo into `merchant` (which
        # spawned hundreds of pseudo-vendors like "PMNT SENT 0109
        # VENMO *Susan Visa Direct NY"), we now scrub the memo down
        # to a vendor-shaped string via `veryfi_memo.clean_bank_memo`.
        # Downstream `contact_resolver` still gets the fast-path
        # signal it expects; the merchant cache + rule engine start
        # picking up recurring vendors correctly.
        #
        # Phase 2 (Feb 2026): if Veryfi's categorization + vendor
        # extraction is enabled on the account, `t["vendor"]["name"]`
        # will be populated with a clean entity name (e.g.
        # "Starbucks Corporation") and `t["category"]` with one of
        # our curated bucket labels — both far superior signals to
        # the regex scrub. We prefer Veryfi's when present and fall
        # back to the scrub otherwise, so the same code path works
        # whether the feature is on or off.
        from veryfi_memo import clean_bank_memo
        scrubbed = clean_bank_memo(clean)
        veryfi_vendor = ""
        v = t.get("vendor") or {}
        if isinstance(v, dict):
            veryfi_vendor = (v.get("name") or "").strip()
        veryfi_category = (t.get("category") or "").strip() or None
        merchant = veryfi_vendor or scrubbed or clean or "Statement Line"
        result.append({
            "date": str(date)[:10],
            "description": clean,                     # keep the raw memo for audit
            "merchant": merchant,
            "amount": round(amt, 2),
            "veryfi_category": veryfi_category,       # None until Veryfi flag flipped
            "veryfi_vendor": veryfi_vendor or None,
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

    # -------- Year-wrap correction --------
    # Veryfi occasionally stamps every txn on a cross-year statement with
    # the closing year (e.g. Dec 25, 2025 → "2026-12-25"). Roll any date
    # that lands AFTER the statement closing date back one year. See
    # `_correct_year_wrap` docstring for the safety argument.
    closing_date = _parse_iso_date(
        veryfi_data.get("statement_date")
        or veryfi_data.get("period_end_date")
        or veryfi_data.get("end_date")
    )
    if closing_date and result:
        fixed = _correct_year_wrap([r["date"] for r in result], closing_date)
        for r, new_d in zip(result, fixed):
            r["date"] = new_d
    return result
