"""Statement-account resolver — matches a Veryfi bank-statement's institution
+ account-number to an existing Chart-of-Accounts entry, or auto-creates a
new asset (bank) account when none matches.

Ported from Rocketsuite's `resolve-statement-coa.ts` pattern, adapted for
Axiom's flat CoA (no `subtype` complexity — we key off `type='asset'` and
name-substring match on the last 4 digits).

Match heuristic (best → worst):
  1. Existing asset account name contains the statement's last-4 digits
     (most specific — e.g. "Bank of America Checking ···6084").
  2. Fuzzy: existing asset account with "bank"/"cash"/"checking"/"savings"
     in name AND the institution name is a substring — but ONLY if exactly
     one such candidate exists (avoids ambiguity).
  3. Otherwise: create a new asset account with a Rocketsuite-style name
     ("Bank of America Adv Relationship Banking ···6084"), following the
     CoA numbering convention (next free number starting at 1010).

Rationale: the user's mental model is "each statement should live under its
matching bank account like a subaccount". This resolver enforces exactly
that — one bank statement PDF → one CoA asset row (existing or new).
"""
from __future__ import annotations
import re
import uuid
from typing import Any

from db import db, now_iso


BANK_KEYWORDS = re.compile(r"bank|cash|checking|savings|credit|loan|mortgage|heloc|line[- ]of[- ]credit|note[- ]payable", re.IGNORECASE)


# Any of these substrings in `account_type` / `bank_name` / statement title
# means the statement belongs on the LIABILITY side of the balance sheet
# (credit card, line of credit, term loan, mortgage, HELOC, note payable).
# Widened from a lone "credit" check so business LOCs, SBA loans, and
# mortgage/HELOC statements auto-book to a 2100-range CoA row instead of
# silently landing under Cash & Bank at 1010.
LIABILITY_HINT_RE = re.compile(
    r"credit[\s_-]?card"
    r"|credit[\s_-]?line"
    r"|line[\s_-]?of[\s_-]?credit"
    r"|\bloc\b"
    r"|\bloan\b"
    r"|mortgage"
    r"|heloc"
    r"|note[\s_-]?payable"
    r"|\bcredit\b",  # keep the original bare "credit" as a fallback
    re.IGNORECASE,
)


def _looks_liability(*hints: str | None) -> bool:
    """True when any provided string looks like a credit-card / loan
    / line-of-credit / mortgage statement. Used by both auto-detect and
    the fuzzy fallback when Veryfi returns an empty `account_type`.
    """
    for h in hints:
        if h and LIABILITY_HINT_RE.search(h):
            return True
    return False


def _last4(s: str | None) -> str | None:
    if not s:
        return None
    digits = re.sub(r"\D", "", s)
    if not digits:
        return None
    return digits[-4:] if len(digits) >= 4 else digits


def _normalize(s: str | None) -> str:
    if not s:
        return ""
    return re.sub(r"[^a-z0-9]", "", s.lower())


def _base_detail_from_type(t: str | None, is_liability: bool = False) -> str:
    v = (t or "").lower()
    if "saving" in v:
        return "Savings"
    if "money" in v:
        return "Money Market"
    if "cd" in v or "certificate" in v:
        return "CD"
    if "heloc" in v:
        return "HELOC"
    if "mortgage" in v:
        return "Mortgage"
    if "line" in v and "credit" in v:
        return "Line of Credit"
    if "loan" in v:
        return "Loan"
    if "credit" in v:
        return "Credit Card"
    # When Veryfi returns an ambiguous / empty `account_type` (common on
    # business credit cards where they report the marketing card name like
    # "Blue Business Cash" instead of a category) we default to a name
    # that matches the account TYPE we're about to book against. Asset →
    # "Checking" (existing behaviour), liability → "Credit Card". Without
    # this, credit-card imports were mis-labelled "Amex Checking …1004"
    # even though they were correctly typed as `liability` in the CoA.
    return "Credit Card" if is_liability else "Checking"


async def _pick_parent_account(company_id: str, detail: str, is_liability: bool) -> str | None:
    """Return the parent CoA row this new bank/credit account should nest
    under so the Chart of Accounts renders it as an indented sub-account
    (matching the Citi Card → Credit Card Payable pattern in the UI).

    Priority:
      - Credit cards → "Credit Card Payable" (code 2100)
      - Savings      → "Business Savings"   (code 1020)
      - Money Market → "Business Savings"   (code 1020) if it exists
      - Checking / everything else → "Business Checking" (code 1010)
      - Fallback: the parent group ("Cash and Bank" 1000)

    Returns the parent's `id` or None if we couldn't find a suitable parent
    (the account will render at the top level then, which is still fine).
    """
    if is_liability:
        candidates = ["2100"]
    elif detail == "Savings" or detail == "Money Market":
        candidates = ["1020", "1000"]
    else:
        candidates = ["1010", "1000"]
    for code in candidates:
        row = await db.accounts.find_one({
            "company_id": company_id, "code": code, "active": True,
        })
        if row:
            return row["id"]
    return None


def _build_account_name(
    bank: str | None, acct_type: str | None, last4: str | None,
    is_liability: bool = False,
) -> str:
    parts: list[str] = []
    if bank:
        parts.append(bank.strip())
    parts.append(_base_detail_from_type(acct_type, is_liability=is_liability))
    if last4:
        parts.append(f"···{last4}")
    return " ".join(p for p in parts if p) or "Bank Account"


async def _next_account_code(company_id: str, start: int = 1010) -> str:
    """Return the next free numeric code in `type='asset'` land."""
    used = set()
    async for a in db.accounts.find(
        {"company_id": company_id},
        {"code": 1, "_id": 0},
    ):
        used.add(str(a.get("code")))
    for n in range(start, 9999):
        if str(n) not in used:
            return str(n)
    return str(start)


def _statement_fields(veryfi_doc: dict) -> dict:
    """Extract the fields we care about from a Veryfi doc, tolerant of both
    the bank-statement product shape and the fallback documents shape.

    Veryfi's bank-statement product (Feb 2026) puts the primary account under
    `accounts[0]` with fields `{number, beginning_balance, ending_balance,
    summaries, transactions}`. Older docs used top-level `account_number`
    + `starting_balance` — we accept both.
    """
    bank_name = (
        veryfi_doc.get("bank_name")
        or (veryfi_doc.get("vendor") or {}).get("name")
        or ""
    ).strip() or None

    acct = None
    accts = veryfi_doc.get("accounts") or []
    if accts and isinstance(accts, list):
        acct = accts[0] if isinstance(accts[0], dict) else None

    account_number = (
        veryfi_doc.get("account_number")
        or (acct or {}).get("account_number")
        or (acct or {}).get("number")  # current Veryfi shape
        or None
    )
    account_type = (
        (acct or {}).get("account_type")
        or veryfi_doc.get("account_type")
    )

    # `starting_balance` (older shape) OR `beginning_balance` (current shape),
    # checked at both top-level and inside accounts[0].
    starting_balance = (
        veryfi_doc.get("starting_balance")
        or veryfi_doc.get("beginning_balance")
        or (acct or {}).get("starting_balance")
        or (acct or {}).get("beginning_balance")
    )

    # Ending balance mirrors the same shape variance.
    ending_balance = (
        veryfi_doc.get("ending_balance")
        or veryfi_doc.get("closing_balance")
        or (acct or {}).get("ending_balance")
        or (acct or {}).get("closing_balance")
    )

    # Statement period — used to auto-fill the reconciliation date range.
    period_start = (
        veryfi_doc.get("period_start_date")
        or veryfi_doc.get("start_date")
        or veryfi_doc.get("statement_period_start")
    )
    period_end = (
        veryfi_doc.get("period_end_date")
        or veryfi_doc.get("end_date")
        or veryfi_doc.get("statement_period_end")
        or veryfi_doc.get("statement_date")
    )

    return {
        "bank_name": bank_name,
        "account_number": account_number,
        "account_type": account_type,
        "starting_balance": starting_balance,
        "ending_balance": ending_balance,
        "period_start": str(period_start)[:10] if period_start else None,
        "period_end": str(period_end)[:10] if period_end else None,
        "last4": _last4(account_number),
    }


async def resolve_or_create_bank_account(
    company_id: str,
    *,
    bank_name: str | None,
    account_number: str | None,
    account_type: str | None,
    starting_balance: float | None = None,
    is_liability: bool = False,
    source: str = "auto",
) -> dict:
    """Match or create the CoA row for a bank/credit account, regardless of
    whether the caller is Veryfi (bank statement OCR) or Plaid (live link).

    Match heuristic (best → worst):
      1. Existing account (of the matching `type`) whose name contains the
         statement's last-4 digits.
      2. Fuzzy: existing bank-flavored account with the institution name as
         substring — but only if exactly one candidate exists.
      3. Otherwise: create a new account with a Rocketsuite-style name
         (e.g. "Bank of America Checking ···6084"). Assets number from 1010;
         liabilities (credit cards) number from 2100.

    Returns `{account_id, account_name, account_code, matched, bank_name,
    last4, starting_balance}`. `matched=True` → we linked to an existing
    row; `False` → we just inserted one.
    """
    last4 = _last4(account_number)
    kind_type = "liability" if is_liability else "asset"

    existing: list[dict] = await db.accounts.find({
        "company_id": company_id, "type": kind_type, "active": True,
    }).to_list(1000)

    # 1) Last-4 substring match on the account name OR on the last4
    # column (populated once account_number persistence landed).
    if last4:
        for a in existing:
            if last4 in (a.get("name") or "") or last4 == (a.get("last4") or ""):
                # If the incoming caller has a fuller account_number and
                # the existing row is missing one, backfill it (still
                # encrypted).
                if account_number and not a.get("account_number"):
                    from crypto_service import encrypt as _enc
                    await db.accounts.update_one(
                        {"id": a["id"]},
                        {"$set": {"account_number": _enc(account_number),
                                  "last4": last4,
                                  "updated_at": now_iso()}},
                    )
                return {
                    "account_id": a["id"], "account_name": a["name"],
                    "account_code": a["code"], "matched": True,
                    "bank_name": bank_name, "last4": last4,
                    "starting_balance": starting_balance,
                }

    # 2) Fuzzy: institution-name substring on bank-flavored candidates.
    # Also require the account-type keyword ("checking"/"savings"/"credit"/…)
    # to appear in the candidate name — otherwise a new Chase Savings would
    # wrongly collapse onto an existing Chase Checking row.
    #
    # IMPORTANT: only fall back to fuzzy matching when the caller had NO
    # last-4 to disambiguate on. If a last4 exists and step 1 didn't find
    # it in any existing account name, the account is genuinely new — we
    # must create a dedicated CoA row instead of collapsing it onto a
    # different-mask existing row (previously the second Bank of America
    # Checking ···9917 was being merged into the first ···6084 row).
    if bank_name and not last4:
        bank_norm = _normalize(bank_name)
        detail = _base_detail_from_type(account_type, is_liability=is_liability).lower()
        detail_norm = _normalize(detail)
        candidates = [
            a for a in existing
            if BANK_KEYWORDS.search(a.get("name") or "")
            and bank_norm in _normalize(a.get("name"))
            and detail_norm in _normalize(a.get("name"))
        ]
        if len(candidates) == 1:
            a = candidates[0]
            return {
                "account_id": a["id"], "account_name": a["name"],
                "account_code": a["code"], "matched": True,
                "bank_name": bank_name, "last4": last4,
                "starting_balance": starting_balance,
            }

    # 3) No match — create a new account. Assets number from 1010,
    # liabilities from 2100 (credit-card land).
    name = _build_account_name(bank_name, account_type, last4, is_liability=is_liability)
    code = await _next_account_code(company_id, 2100 if is_liability else 1010)
    account_id = str(uuid.uuid4())
    subtype = ("current_liability" if is_liability
               else ("Bank" if BANK_KEYWORDS.search(name)
                     else "current_asset"))
    parent_id = await _pick_parent_account(
        company_id,
        _base_detail_from_type(account_type, is_liability=is_liability),
        is_liability,
    )
    now = now_iso()
    # `account_number` is AES-256 encrypted per `crypto_service`
    # (SENSITIVE_FIELDS["accounts"]) — the un-encrypted `last4` stays
    # plaintext because reconciliation/statement matching queries it,
    # and last-4 is not sensitive on its own.
    from crypto_service import encrypt as _enc
    await db.accounts.insert_one({
        "id": account_id,
        "company_id": company_id,
        "code": code,
        "name": name,
        "type": kind_type,
        "subtype": subtype,
        "parent_account_id": parent_id,
        "active": True,
        "balance": 0.0,
        "created_by_ai": True,
        "system_generated": True,
        "source": source,
        # Bank-identity fields — encrypted at rest, decrypted only when
        # explicitly needed (rare: exports, audit binders, admin views).
        "account_number": _enc(account_number) if account_number else None,
        "last4": last4,
        "bank_name": bank_name,
        "created_at": now,
        "updated_at": now,
    })
    return {
        "account_id": account_id, "account_name": name,
        "account_code": code, "matched": False,
        "bank_name": bank_name, "last4": last4,
        "starting_balance": starting_balance,
    }


async def resolve_statement_account(
    company_id: str, veryfi_doc: dict,
    account_kind_hint: str | None = None,
) -> dict:
    """Veryfi-facing wrapper — pulls fields from the OCR doc, then delegates
    to `resolve_or_create_bank_account` for the actual match/create logic
    (shared with Plaid).

    ``account_kind_hint`` is an optional user override sent from the
    Import Statements UI when the user knows the statement type ahead of
    OCR (e.g. Veryfi frequently returns an empty ``account_type`` for
    community-bank LOCs and SBA loans, which would otherwise fall through
    to the asset default). Accepted values:

    * ``"liability"`` — force liability branch (creates in 2100-range).
    * ``"asset"``     — force asset branch (creates in 1010-range).
    * ``None`` / ``"auto"`` — auto-detect from Veryfi fields (default).
    """
    fields = _statement_fields(veryfi_doc)
    hint = (account_kind_hint or "").lower().strip() or "auto"
    if hint == "liability":
        is_liability = True
    elif hint == "asset":
        is_liability = False
    else:
        # Auto-detect: widened net covers credit cards, LOCs, term loans,
        # mortgages, and HELOCs — falling back to bank_name when Veryfi
        # left `account_type` blank.
        is_liability = _looks_liability(fields.get("account_type"), fields.get("bank_name"))
    return await resolve_or_create_bank_account(
        company_id,
        bank_name=fields["bank_name"],
        account_number=fields["account_number"],
        account_type=fields["account_type"],
        starting_balance=fields["starting_balance"],
        is_liability=is_liability,
        source="veryfi_statement",
    )


__all__ = ["resolve_statement_account", "resolve_or_create_bank_account"]
