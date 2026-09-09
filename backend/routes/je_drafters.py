"""SmartBooks — AI JE Drafters for the Adjust phase.

Depreciation is already auto-posted at asset creation via `asset_service`
(future-dated JEs filtered by as_of). This module fills the *other* two
gaps every close needs but nobody wants to do manually:

  • **Prepaid amortization** — sweep balances out of prepaid accounts
    (rent, insurance, subscriptions) into the correct expense on a
    linear schedule.
  • **Recurring accruals** — detect bills that hit every month but
    haven't posted in the close month yet (rent, payroll, utilities).

Both drafters write to a new `je_drafts` collection. Approve → promote
to `journal_entries` via `insert_je`. Reject → soft-delete.
"""
from __future__ import annotations
import uuid
from calendar import monthrange
from collections import defaultdict
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from db import db, now_iso, insert_je, coerce
from auth import require_role
from deps import require_company, is_period_closed

router = APIRouter(prefix="/api", tags=["je-drafters"])


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _month_bounds(year: int, month: int) -> tuple[str, str]:
    last = monthrange(year, month)[1]
    return f"{year:04d}-{month:02d}-01", f"{year:04d}-{month:02d}-{last:02d}"


def _parse_ym(ym: str) -> tuple[int, int]:
    try:
        y, m = ym.split("-")
        return int(y), int(m)
    except Exception:
        raise HTTPException(400, "Period must be YYYY-MM")


def _shift_ym(year: int, month: int, delta: int) -> tuple[int, int]:
    total = year * 12 + (month - 1) + delta
    return total // 12, (total % 12) + 1


async def _account_balance(cid: str, account_id: str, as_of_iso: str) -> float:
    """Balance = sum(debits) - sum(credits) on lines through as_of."""
    cursor = db.journal_entries.aggregate([
        {"$match": {"company_id": cid, "date": {"$lte": as_of_iso}}},
        {"$unwind": "$lines"},
        {"$match": {"lines.account_id": account_id}},
        {"$group": {
            "_id": None,
            "d": {"$sum": {"$ifNull": ["$lines.debit", 0]}},
            "c": {"$sum": {"$ifNull": ["$lines.credit", 0]}},
        }},
    ])
    async for doc in cursor:
        return round(float(doc["d"] or 0) - float(doc["c"] or 0), 2)
    return 0.0


# ---------------------------------------------------------------------------
# Prepaid amortization detector
# ---------------------------------------------------------------------------

_PREPAID_NAME_HINTS = ("prepaid", "unamortized", "advance to")


def _guess_expense_account_name(prepaid_name: str) -> Optional[str]:
    """From 'Prepaid Rent' guess 'Rent Expense'. Heuristic only —
    caller can override."""
    n = (prepaid_name or "").lower()
    for hint in _PREPAID_NAME_HINTS:
        if hint in n:
            stripped = n.replace(hint, "").strip()
            if stripped:
                return f"{stripped.title()} Expense"
    return None


async def _find_prepaid_accounts(cid: str) -> list[dict]:
    """Any active asset account whose name mentions 'prepaid'."""
    docs = await db.accounts.find({
        "company_id": cid, "active": True,
        "$or": [
            {"subtype": "prepaid"},
            {"name": {"$regex": "prepaid", "$options": "i"}},
        ],
    }).to_list(200)
    # Only true asset accounts qualify.
    return [d for d in docs if (d.get("type") or "").lower() in ("asset", "current_asset", "other_current_asset")]


async def _draft_prepaid_amortizations(cid: str, year: int, month: int) -> list[dict]:
    """Linear 12-month amortization on every prepaid balance > $0.

    MVP heuristic — real prepaids should carry an
    `amortization_schedule` per asset (Phase 3.5 add). Until then:
    balance / 12 hits expense monthly.
    """
    _, end_iso = _month_bounds(year, month)
    prepaid_accounts = await _find_prepaid_accounts(cid)
    drafts = []
    for acc in prepaid_accounts:
        # Balance *before* this month's amortization.
        prev_y, prev_m = _shift_ym(year, month, -1)
        _, prev_end = _month_bounds(prev_y, prev_m)
        balance = await _account_balance(cid, acc["id"], prev_end)
        if balance <= 0.5:  # Nothing meaningful to amortize.
            continue

        # If the CoA row has an explicit schedule config, use it; else
        # 12-month linear.
        cfg = (acc.get("amortization_config") or {}) if isinstance(acc.get("amortization_config"), dict) else {}
        months_total = int(cfg.get("months") or 12)
        monthly = round(balance / max(1, months_total), 2) if balance > 0 else 0
        if monthly < 0.01:
            continue

        # Find or default the target expense account.
        target_acc = None
        if cfg.get("expense_account_id"):
            target_acc = await db.accounts.find_one({"id": cfg["expense_account_id"], "company_id": cid})
        if not target_acc:
            guessed = _guess_expense_account_name(acc.get("name") or "")
            if guessed:
                target_acc = await db.accounts.find_one({
                    "company_id": cid, "active": True, "type": "expense",
                    "name": {"$regex": f"^{guessed}$", "$options": "i"},
                })
        if not target_acc:
            # Fallback: any account with matching name-token.
            token = (acc.get("name") or "").lower().replace("prepaid", "").strip()
            if token:
                target_acc = await db.accounts.find_one({
                    "company_id": cid, "active": True, "type": "expense",
                    "name": {"$regex": token.split()[0] if token else "expense", "$options": "i"},
                })

        drafts.append({
            "id": str(uuid.uuid4()),
            "company_id": cid,
            "period": f"{year:04d}-{month:02d}",
            "drafter_kind": "prepaid_amort",
            "status": "pending",
            "date": end_iso,
            "memo": f"Amortize {acc.get('name')} for {year:04d}-{month:02d}",
            "lines": [
                {
                    "account_id": (target_acc or {}).get("id"),
                    "account_name": (target_acc or {}).get("name") or "(needs expense account)",
                    "debit": monthly,
                    "credit": 0,
                    "memo": f"Amortize {acc.get('name')}",
                },
                {
                    "account_id": acc["id"],
                    "account_name": acc.get("name"),
                    "debit": 0,
                    "credit": monthly,
                    "memo": f"Amortize {acc.get('name')}",
                },
            ],
            "amount": monthly,
            "source": {
                "prepaid_account_id": acc["id"],
                "prepaid_balance_before": balance,
                "months_total": months_total,
                "months_remaining_after": max(0, months_total - 1),
                "target_account_id": (target_acc or {}).get("id"),
                "target_account_guessed": target_acc is None,
            },
            "confidence": 0.7 if target_acc else 0.4,
            "needs_review_reason": None if target_acc else "no expense account guessed",
            "generated_at": now_iso(),
        })
    return drafts


# ---------------------------------------------------------------------------
# Recurring accruals detector
# ---------------------------------------------------------------------------

async def _draft_recurring_accruals(cid: str, year: int, month: int, lookback: int = 6) -> list[dict]:
    """A vendor/expense pair that has posted in ≥5 of the last N months
    but is missing from the close month → draft accrual JE:
      DR expense_account  CR Accrued Expenses.
    """
    _, close_end = _month_bounds(year, month)

    # Build the (contact_id, expense_account_id) history over lookback.
    history: dict = defaultdict(lambda: {"months_seen": set(), "amounts": []})
    for delta in range(1, lookback + 1):
        yy, mm = _shift_ym(year, month, -delta)
        start, end = _month_bounds(yy, mm)
        cursor = db.transactions.find({
            "company_id": cid, "posted": True,
            "date": {"$gte": start, "$lte": end},
            "direction": "out",
            "contact_id": {"$ne": None},
            "account_id": {"$ne": None},
        }).limit(2000)
        async for t in cursor:
            key = (t.get("contact_id"), t.get("account_id"))
            history[key]["months_seen"].add(f"{yy:04d}-{mm:02d}")
            history[key]["amounts"].append(abs(float(t.get("amount") or 0)))

    # Check who posted in ≥5 lookback months.
    start_close, _ = _month_bounds(year, month)
    close_posted_keys: set = set()
    cursor = db.transactions.find({
        "company_id": cid, "posted": True,
        "date": {"$gte": start_close, "$lte": close_end},
        "direction": "out",
        "contact_id": {"$ne": None},
        "account_id": {"$ne": None},
    })
    async for t in cursor:
        close_posted_keys.add((t.get("contact_id"), t.get("account_id")))

    accrued_expenses_acc = await db.accounts.find_one({
        "company_id": cid, "active": True,
        "$or": [
            {"subtype": "accrued_expenses"},
            {"name": {"$regex": "accrued expense", "$options": "i"}},
        ],
    })
    if not accrued_expenses_acc:
        # Fall back to Accounts Payable — legitimate GAAP alternative
        # when there's no dedicated accrued liability account.
        accrued_expenses_acc = await db.accounts.find_one({
            "company_id": cid, "active": True,
            "$or": [
                {"subtype": "accounts_payable"},
                {"name": {"$regex": "accounts payable", "$options": "i"}},
            ],
        })

    _, end_iso = _month_bounds(year, month)
    drafts = []
    for key, h in history.items():
        contact_id, account_id = key
        if len(h["months_seen"]) < 5:
            continue
        if key in close_posted_keys:
            continue

        amts = h["amounts"]
        avg = sum(amts) / max(1, len(amts))
        # Cheap variance filter — accrue only when amounts are stable.
        stable = all(abs(a - avg) < max(avg * 0.25, 10) for a in amts)
        if not stable:
            continue

        contact = await db.contacts.find_one({"id": contact_id, "company_id": cid})
        expense_acc = await db.accounts.find_one({"id": account_id, "company_id": cid})
        if not expense_acc or (expense_acc.get("type") or "").lower() != "expense":
            continue

        drafts.append({
            "id": str(uuid.uuid4()),
            "company_id": cid,
            "period": f"{year:04d}-{month:02d}",
            "drafter_kind": "accrual",
            "status": "pending",
            "date": end_iso,
            "memo": (
                f"Accrue {expense_acc.get('name')} for {contact.get('name') if contact else 'vendor'} "
                f"— {year:04d}-{month:02d} (avg of last {len(h['months_seen'])} months)"
            ),
            "lines": [
                {
                    "account_id": account_id,
                    "account_name": expense_acc.get("name"),
                    "debit": round(avg, 2),
                    "credit": 0,
                    "memo": f"Accrue {(contact or {}).get('name') or 'vendor'}",
                },
                {
                    "account_id": (accrued_expenses_acc or {}).get("id"),
                    "account_name": (accrued_expenses_acc or {}).get("name") or "(needs Accrued Expenses)",
                    "debit": 0,
                    "credit": round(avg, 2),
                    "memo": f"Accrue {(contact or {}).get('name') or 'vendor'}",
                },
            ],
            "amount": round(avg, 2),
            "source": {
                "contact_id": contact_id,
                "contact_name": (contact or {}).get("name"),
                "expense_account_id": account_id,
                "accrual_account_id": (accrued_expenses_acc or {}).get("id"),
                "months_seen": sorted(h["months_seen"]),
                "sample_amounts": amts[-6:],
            },
            "confidence": round(min(0.95, 0.5 + 0.08 * len(h["months_seen"])), 2),
            "needs_review_reason": None if accrued_expenses_acc else "no accrued-expenses account",
            "generated_at": now_iso(),
        })
    return drafts


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

class ScanIn(BaseModel):
    period: str = Field(..., pattern=r"^\d{4}-\d{2}$")
    kinds: Optional[list[str]] = None  # ["prepaid_amort", "accrual"]


@router.post("/companies/{cid}/je-drafters/scan")
async def scan(
    cid: str, inp: ScanIn,
    user: dict = Depends(require_role("pro", "admin", "superadmin", "partner")),
):
    """Run detectors + persist drafts. Idempotent per (cid, period,
    drafter_kind, signature) — re-scan replaces pending drafts."""
    await require_company(user, cid)
    y, m = _parse_ym(inp.period)
    kinds = set(inp.kinds or ["prepaid_amort", "accrual"])

    # Clear stale PENDING drafts for this period + kinds so re-scan is
    # safe. Approved/rejected drafts are preserved.
    await db.je_drafts.delete_many({
        "company_id": cid, "period": inp.period,
        "drafter_kind": {"$in": list(kinds)}, "status": "pending",
    })

    all_drafts: list[dict] = []
    if "prepaid_amort" in kinds:
        all_drafts.extend(await _draft_prepaid_amortizations(cid, y, m))
    if "accrual" in kinds:
        all_drafts.extend(await _draft_recurring_accruals(cid, y, m))

    if all_drafts:
        await db.je_drafts.insert_many(all_drafts)

    return {
        "period": inp.period,
        "count": len(all_drafts),
        "by_kind": {
            k: sum(1 for d in all_drafts if d["drafter_kind"] == k)
            for k in kinds
        },
        "drafts": [coerce(d) for d in all_drafts],
    }


@router.get("/companies/{cid}/je-drafters")
async def list_drafts(
    cid: str,
    period: str = Query(...),
    status: Optional[str] = Query("pending"),
    user: dict = Depends(require_role("pro", "admin", "superadmin", "partner")),
):
    await require_company(user, cid)
    q = {"company_id": cid, "period": period}
    if status and status != "all":
        q["status"] = status
    docs = await db.je_drafts.find(q).sort("generated_at", -1).limit(500).to_list(500)
    counts = {"pending": 0, "approved": 0, "rejected": 0}
    for d in docs:
        s = d.get("status", "pending")
        counts[s] = counts.get(s, 0) + 1
    return {"period": period, "drafts": [coerce(d) for d in docs], "counts": counts}


class PatchDraftIn(BaseModel):
    memo: Optional[str] = None
    date: Optional[str] = None
    lines: Optional[list[dict]] = None


@router.patch("/companies/{cid}/je-drafters/{draft_id}")
async def patch_draft(
    cid: str, draft_id: str, inp: PatchDraftIn,
    user: dict = Depends(require_role("pro", "admin", "superadmin", "partner")),
):
    await require_company(user, cid)
    draft = await db.je_drafts.find_one({"id": draft_id, "company_id": cid})
    if not draft:
        raise HTTPException(404, "Draft not found.")
    if draft.get("status") != "pending":
        raise HTTPException(400, "Only pending drafts can be edited.")

    update: dict = {"updated_at": now_iso()}
    if inp.memo is not None:
        update["memo"] = inp.memo
    if inp.date is not None:
        update["date"] = inp.date
    if inp.lines is not None:
        # Re-balance check.
        d = sum(float(l.get("debit") or 0) for l in inp.lines)
        c = sum(float(l.get("credit") or 0) for l in inp.lines)
        if abs(d - c) > 0.01:
            raise HTTPException(400, f"Lines must balance (debits={d} credits={c}).")
        update["lines"] = inp.lines
        update["amount"] = round(d, 2)

    await db.je_drafts.update_one({"id": draft_id}, {"$set": update})
    doc = await db.je_drafts.find_one({"id": draft_id})
    return coerce(doc) if doc else {}


@router.post("/companies/{cid}/je-drafters/{draft_id}/approve")
async def approve_draft(
    cid: str, draft_id: str,
    user: dict = Depends(require_role("pro", "admin", "superadmin", "partner")),
):
    """Promote a pending draft into `journal_entries` via `insert_je`."""
    await require_company(user, cid)
    draft = await db.je_drafts.find_one({"id": draft_id, "company_id": cid})
    if not draft:
        raise HTTPException(404, "Draft not found.")
    if draft.get("status") != "pending":
        raise HTTPException(400, f"Draft is already {draft.get('status')}.")

    # Validate against closed periods.
    if await is_period_closed(cid, draft["date"]):
        raise HTTPException(400, "Cannot post into a closed period.")

    # Validate lines are complete.
    for ln in draft.get("lines") or []:
        if not ln.get("account_id"):
            raise HTTPException(400, f"Line missing account_id: {ln}")

    je_id = await insert_je({
        "id": str(uuid.uuid4()),
        "company_id": cid,
        "date": draft["date"],
        "memo": draft["memo"],
        "lines": draft["lines"],
        "source": "je_drafter",
        "source_drafter_kind": draft["drafter_kind"],
        "source_draft_id": draft_id,
        "posted": True,
    })

    now = now_iso()
    await db.je_drafts.update_one(
        {"id": draft_id},
        {"$set": {
            "status": "approved",
            "approved_at": now,
            "approved_by": user.get("email") or user.get("id"),
            "posted_je_id": je_id,
            "updated_at": now,
        }},
    )
    return {"ok": True, "je_id": je_id}


@router.post("/companies/{cid}/je-drafters/{draft_id}/reject")
async def reject_draft(
    cid: str, draft_id: str,
    user: dict = Depends(require_role("pro", "admin", "superadmin", "partner")),
):
    await require_company(user, cid)
    r = await db.je_drafts.update_one(
        {"id": draft_id, "company_id": cid, "status": "pending"},
        {"$set": {
            "status": "rejected",
            "rejected_at": now_iso(),
            "rejected_by": user.get("email") or user.get("id"),
        }},
    )
    if r.matched_count == 0:
        raise HTTPException(404, "Draft not found or already actioned.")
    return {"ok": True}
