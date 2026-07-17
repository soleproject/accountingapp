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


BANK_KEYWORDS = re.compile(r"bank|cash|checking|savings|credit", re.IGNORECASE)


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


def _base_detail_from_type(t: str | None) -> str:
    v = (t or "").lower()
    if "saving" in v:
        return "Savings"
    if "money" in v:
        return "Money Market"
    if "cd" in v or "certificate" in v:
        return "CD"
    if "credit" in v:
        return "Credit Card"
    return "Checking"


def _build_account_name(bank: str | None, acct_type: str | None, last4: str | None) -> str:
    parts: list[str] = []
    if bank:
        parts.append(bank.strip())
    parts.append(_base_detail_from_type(acct_type))
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

    return {
        "bank_name": bank_name,
        "account_number": account_number,
        "account_type": account_type,
        "starting_balance": starting_balance,
        "last4": _last4(account_number),
    }


async def resolve_statement_account(
    company_id: str, veryfi_doc: dict,
) -> dict:
    """Match or create the CoA row for the account this statement belongs to.

    Returns `{account_id, account_name, account_code, matched, bank_name,
    last4, starting_balance}`. `matched=True` means we found an existing
    account; `False` means we created a new one.
    """
    fields = _statement_fields(veryfi_doc)
    last4 = fields["last4"]
    bank_name = fields["bank_name"]

    # Pull all active asset accounts in one query.
    assets: list[dict] = await db.accounts.find({
        "company_id": company_id, "type": "asset", "active": True,
    }).to_list(1000)

    # 1) Match on last-4 substring in the name — most specific.
    if last4:
        for a in assets:
            if last4 in (a.get("name") or ""):
                return {
                    "account_id": a["id"],
                    "account_name": a["name"],
                    "account_code": a["code"],
                    "matched": True,
                    "bank_name": bank_name,
                    "last4": last4,
                    "starting_balance": fields["starting_balance"],
                }

    # 2) Fuzzy: bank name substring, only if exactly one bank-flavored match.
    if bank_name:
        bank_norm = _normalize(bank_name)
        candidates = [
            a for a in assets
            if BANK_KEYWORDS.search(a.get("name") or "")
            and bank_norm in _normalize(a.get("name"))
        ]
        if len(candidates) == 1:
            a = candidates[0]
            return {
                "account_id": a["id"],
                "account_name": a["name"],
                "account_code": a["code"],
                "matched": True,
                "bank_name": bank_name,
                "last4": last4,
                "starting_balance": fields["starting_balance"],
            }

    # 3) No match → create a new asset account.
    name = _build_account_name(bank_name, fields["account_type"], last4)
    code = await _next_account_code(company_id)
    account_id = str(uuid.uuid4())
    now = now_iso()
    await db.accounts.insert_one({
        "id": account_id,
        "company_id": company_id,
        "code": code,
        "name": name,
        "type": "asset",
        "subtype": "Bank",
        "active": True,
        "balance": 0.0,
        "created_by_ai": True,
        "system_generated": True,
        "source": "veryfi_statement",
        "created_at": now,
        "updated_at": now,
    })
    return {
        "account_id": account_id,
        "account_name": name,
        "account_code": code,
        "matched": False,
        "bank_name": bank_name,
        "last4": last4,
        "starting_balance": fields["starting_balance"],
    }


__all__ = ["resolve_statement_account"]
