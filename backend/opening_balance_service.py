"""Auto-managed opening balance JEs for bank accounts.

Feb 2026 — replaces the "user must remember to post an Opening Balance
Equity JE" gap that produced negative ledger columns on the Reconciliation
history table. Both bank-data entry points now call the shared helper:

  - `statements.upload_statement` (Connections → Statements tab &
    Onboarding step 6)
  - `plaid_connect.sync_plaid_history_for_account` at initial connect
    (Connections → Plaid tab & Onboarding step 5), gated to at least
    `MIN_PLAID_DAYS_OF_HISTORY` days so partial-history reconnects don't
    fire the JE prematurely.

Design goals:

* **Idempotent** — running the helper twice back-to-back is a no-op the
  second time.
* **Delta-driven** — the JE amount is always
  `earliest_opening - ledger_balance_strictly_before(earliest_period_start,
   excluding our own auto-managed JE)`, so it converges regardless of what
  other JEs / txns exist in the ledger.
* **Out-of-order safe** — when a user uploads a statement OLDER than any
  previously known, the auto-managed JE is re-computed at the new
  earliest date. When a NEWER statement arrives, the JE is untouched.
* **Respects user work** — a manually posted `source: "opening_balance"`
  JE or a Plaid-connect-posted one is always preserved. The helper only
  ever creates / mutates / deletes rows whose `source` equals
  `AUTO_SOURCE` (see below).
* **Closed-period aware** — never touches a JE whose target date falls
  inside a closed period; returns `{ok: False, reason: "closed_period"}`
  so callers can surface a banner.
"""
from __future__ import annotations
import uuid
from datetime import date, timedelta
from typing import Any

from db import db, now_iso
import plaid_connect

# Distinct source string so we can tell auto-managed JEs apart from
# Plaid-connect-posted or user-posted OBE JEs. Never overload — the whole
# convergence proof depends on this.
AUTO_SOURCE = "opening_balance_auto"

# Plaid gate — see module docstring.
MIN_PLAID_DAYS_OF_HISTORY = 30


def _yesterday_iso(iso: str) -> str:
    try:
        return (date.fromisoformat(iso) - timedelta(days=1)).isoformat()
    except Exception:
        return iso


async def _ledger_balance_strictly_before(
    cid: str, bank_account_id: str, cutoff_date: str,
    *, exclude_auto_je: bool = True,
) -> float:
    """Sum every posted txn and every JE line for the ledger account with
    `date < cutoff_date`. Optionally excludes our own auto-managed OBE JE
    so recomputation math converges instead of oscillating.

    Sign convention matches the rest of the codebase:
      - `transactions.amount` is signed (deposits +, withdrawals -), so we
        sum directly.
      - JE lines have separate `debit` / `credit` fields; net = debit -
        credit (positive for asset increases).
    """
    txn_pipeline = [
        {"$match": {
            "company_id": cid, "bank_account_id": bank_account_id,
            "posted": True,
            "date": {"$lt": cutoff_date},
        }},
        {"$group": {"_id": None, "sum": {"$sum": "$amount"}}},
    ]
    txn_total = 0.0
    async for row in db.transactions.aggregate(txn_pipeline):
        txn_total = float(row.get("sum") or 0.0)

    # Journal-entry lines. We match on the line's `account_id` (bank
    # ledger account). Optionally skip the row whose source == AUTO_SOURCE.
    je_match: dict[str, Any] = {
        "company_id": cid,
        "date": {"$lt": cutoff_date},
        "lines.account_id": bank_account_id,
    }
    if exclude_auto_je:
        je_match["source"] = {"$ne": AUTO_SOURCE}

    je_pipeline = [
        {"$match": je_match},
        {"$unwind": "$lines"},
        {"$match": {"lines.account_id": bank_account_id}},
        {"$group": {"_id": None,
                    "debit": {"$sum": "$lines.debit"},
                    "credit": {"$sum": "$lines.credit"}}},
    ]
    je_debit = je_credit = 0.0
    async for row in db.journal_entries.aggregate(je_pipeline):
        je_debit = float(row.get("debit") or 0.0)
        je_credit = float(row.get("credit") or 0.0)

    return round(txn_total + (je_debit - je_credit), 2)


async def _earliest_statement_anchor(
    cid: str, bank_account_id: str,
) -> dict | None:
    """Find the earliest known `{period_start, opening_balance}` anchor
    for a bank account across the `statement_imports` collection.

    Returns None if no completed import carries an opening balance.
    """
    cursor = db.statement_imports.find({
        "company_id": cid,
        "account_id": bank_account_id,
        "status": "completed",
        "period_start": {"$nin": [None, ""]},
        "starting_balance": {"$nin": [None, ""]},
    }).sort("period_start", 1).limit(1)
    doc = None
    async for d in cursor:
        doc = d
        break
    if not doc:
        return None
    try:
        opening = float(doc["starting_balance"])
    except (TypeError, ValueError):
        return None
    return {
        "period_start": str(doc["period_start"])[:10],
        "opening_balance": opening,
        "source_import_id": doc["id"],
    }


async def _is_period_closed(cid: str, iso_date: str) -> bool:
    doc = await db.close_periods.find_one({
        "company_id": cid, "status": "closed",
        "period_start": {"$lte": iso_date},
        "period_end": {"$gte": iso_date},
    })
    return doc is not None


async def _upsert_auto_je(
    cid: str, ledger_bank: dict, needed_amount: float, as_of: str,
    memo: str,
) -> str | None:
    """Create or replace the single auto-managed OBE JE for a bank account.

    Returns the JE id if a row was written, or None if the row was
    deleted (amount ≈ 0) or already correct.
    """
    obe = await plaid_connect.ensure_opening_balance_equity(cid)
    is_asset = ledger_bank["type"] == "asset"
    if is_asset:
        lines = [
            {"account_id": ledger_bank["id"], "account_code": ledger_bank["code"],
             "account_name": ledger_bank["name"],
             "debit": round(needed_amount, 2), "credit": 0.0,
             "description": memo},
            {"account_id": obe["id"], "account_code": obe["code"],
             "account_name": obe["name"],
             "debit": 0.0, "credit": round(needed_amount, 2),
             "description": memo},
        ]
    else:  # liability normal-balance is credit
        lines = [
            {"account_id": obe["id"], "account_code": obe["code"],
             "account_name": obe["name"],
             "debit": round(needed_amount, 2), "credit": 0.0,
             "description": memo},
            {"account_id": ledger_bank["id"], "account_code": ledger_bank["code"],
             "account_name": ledger_bank["name"],
             "debit": 0.0, "credit": round(needed_amount, 2),
             "description": memo},
        ]

    existing = await db.journal_entries.find_one({
        "company_id": cid,
        "source": AUTO_SOURCE,
        "lines.account_id": ledger_bank["id"],
    })

    # If the delta is negligible, nothing needs to exist.
    if abs(needed_amount) < 0.005:
        if existing:
            await db.journal_entries.delete_one({"id": existing["id"]})
        return None

    if existing:
        await db.journal_entries.update_one(
            {"id": existing["id"]},
            {"$set": {"date": as_of, "memo": memo, "lines": lines,
                      "updated_at": now_iso()}},
        )
        return existing["id"]

    je_id = str(uuid.uuid4())
    await db.journal_entries.insert_one({
        "id": je_id, "company_id": cid,
        "date": as_of, "memo": memo, "lines": lines,
        "source": AUTO_SOURCE,
        "created_at": now_iso(), "updated_at": now_iso(),
    })
    return je_id


async def ensure_opening_balance_for_account(
    cid: str, bank_account_id: str,
) -> dict:
    """Idempotent auto-managed OBE JE for a bank ledger account.

    Called after every Veryfi statement upload (and after Plaid syncs
    once we have ≥ 30 days of history). Returns a small diagnostic dict
    the callers can log or surface to the frontend.
    """
    ledger = await db.accounts.find_one({
        "id": bank_account_id, "company_id": cid,
    })
    if not ledger:
        return {"ok": False, "reason": "account_not_found"}

    # Respect manual / Plaid-connect OBE JEs — do not compete.
    manual_obe = await db.journal_entries.find_one({
        "company_id": cid,
        "source": "opening_balance",
        "lines.account_id": bank_account_id,
    })
    if manual_obe:
        return {"ok": False, "reason": "manual_obe_exists",
                "existing_je_id": manual_obe["id"]}

    anchor = await _earliest_statement_anchor(cid, bank_account_id)
    if not anchor:
        return {"ok": False, "reason": "no_statement_anchor"}

    as_of = _yesterday_iso(anchor["period_start"])
    if await _is_period_closed(cid, as_of):
        return {"ok": False, "reason": "closed_period",
                "target_date": as_of}

    balance_before = await _ledger_balance_strictly_before(
        cid, bank_account_id, anchor["period_start"], exclude_auto_je=True,
    )
    needed = round(anchor["opening_balance"] - balance_before, 2)

    memo = (
        f"Opening balance — {ledger['name']} "
        f"(auto-managed from statement uploads)"
    )
    je_id = await _upsert_auto_je(cid, ledger, needed, as_of, memo)
    action = "deleted" if (je_id is None and abs(needed) < 0.005) else (
        "upserted" if je_id else "no_change"
    )
    return {
        "ok": True, "action": action,
        "je_id": je_id, "amount": needed, "as_of": as_of,
        "anchor_period_start": anchor["period_start"],
        "anchor_opening_balance": anchor["opening_balance"],
        "anchor_import_id": anchor["source_import_id"],
        "ledger_balance_before_anchor": balance_before,
    }


async def plaid_history_meets_minimum_days(
    cid: str, plaid_account_id: str, min_days: int = MIN_PLAID_DAYS_OF_HISTORY,
) -> bool:
    """True when Plaid has delivered at least `min_days` of history for
    the given account. Callers use this to gate the initial opening
    balance JE — a Plaid re-authorization can occasionally return < 5
    days on first sync, which would produce a nonsensical opening JE.
    """
    pipeline = [
        {"$match": {"company_id": cid, "plaid_account_id": plaid_account_id}},
        {"$group": {"_id": None,
                    "min": {"$min": "$date"},
                    "max": {"$max": "$date"}}},
    ]
    async for row in db.transactions.aggregate(pipeline):
        lo, hi = row.get("min"), row.get("max")
        if not lo or not hi:
            return False
        try:
            return (date.fromisoformat(hi) - date.fromisoformat(lo)).days >= min_days
        except Exception:
            return False
    return False


__all__ = [
    "AUTO_SOURCE",
    "MIN_PLAID_DAYS_OF_HISTORY",
    "ensure_opening_balance_for_account",
    "plaid_history_meets_minimum_days",
]
