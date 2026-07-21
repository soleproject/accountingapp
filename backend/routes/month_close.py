"""Axiom Ledger — Month Close checklist.

A month-close is 5 named checkpoints per calendar month:

  txns_reviewed   auto  All transactions posted in the month are human_reviewed
                          and none of them sit in an Uncategorized account.
  invoices        sign  Outstanding invoices reviewed & signed off (they don't
                          need to be paid — just triaged for month-end).
  bills           sign  Same, for outstanding bills.
  recon           sign  Bank / credit-card accounts reconciled through EOM.
  closed          sign  Period is locked; no further edits allowed. Gated —
                          only allowed once the four above are all green.

Two of the five are computed live (`txns_reviewed`, and the derived counts
for invoices / bills). The remaining sign-offs live in the new
`month_close_signoffs` collection, one document per (company, year, month,
kind). The `closed` sign-off ALSO inserts a `close_periods` doc so the
existing period-lock system continues to see the month as closed.
"""
from __future__ import annotations
import uuid
from datetime import datetime, timezone
from typing import Optional
from calendar import monthrange

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from db import db, now_iso, coerce
from auth import get_current_user
from deps import require_company

router = APIRouter(prefix="/api")


CHECKPOINT_KINDS = {"invoices", "bills", "recon", "closed"}


class CheckpointIn(BaseModel):
    kind: str
    signed: bool


def _month_bounds(year: int, month: int) -> tuple[str, str]:
    """Return ISO date strings for the first/last day of the month."""
    last = monthrange(year, month)[1]
    return (
        f"{year:04d}-{month:02d}-01",
        f"{year:04d}-{month:02d}-{last:02d}",
    )


def _parse_ym(ym: str) -> tuple[int, int]:
    try:
        y, m = ym.split("-")
        yi, mi = int(y), int(m)
        if not (1 <= mi <= 12) or yi < 1900 or yi > 2999:
            raise ValueError
        return yi, mi
    except Exception:
        raise HTTPException(400, "Month must be formatted YYYY-MM (e.g. 2026-02)")


async def _txns_reviewed(cid: str, start: str, end: str) -> dict:
    """Auto-compute: are all posted txns in the window reviewed AND
    categorized? Returns a small status dict for the frontend."""
    base = {"company_id": cid, "posted": True, "date": {"$gte": start, "$lte": end}}
    total = await db.transactions.count_documents(base)
    if total == 0:
        # No transactions in the month → vacuously "reviewed".
        return {"green": True, "total": 0, "uncategorized": 0, "unreviewed": 0}
    uncat_query = {**base, "$or": [
        {"category_account_id": None},
        {"category_account_id": {"$exists": False}},
        {"category_account_code": {"$in": ["9999", "6999", "4999"]}},
    ]}
    uncategorized = await db.transactions.count_documents(uncat_query)
    unreviewed = await db.transactions.count_documents({**base, "human_reviewed": {"$ne": True}})
    return {
        "green": uncategorized == 0 and unreviewed == 0,
        "total": total,
        "uncategorized": uncategorized,
        "unreviewed": unreviewed,
    }


async def _outstanding_count(coll: str, cid: str, end: str) -> int:
    """Invoices / bills with a positive balance_due as of end-of-month."""
    return await db[coll].count_documents({
        "company_id": cid,
        "date": {"$lte": end},
        "balance_due": {"$gt": 0.0001},
    })


async def _signoffs(cid: str, year: int, month: int) -> dict:
    docs = await db.month_close_signoffs.find({
        "company_id": cid, "year": year, "month": month,
    }).to_list(20)
    return {d["kind"]: coerce(d) for d in docs if d.get("kind") in CHECKPOINT_KINDS}


async def _month_status(cid: str, year: int, month: int) -> dict:
    """One month's rollup — the shape both the list and detail views consume."""
    start, end = _month_bounds(year, month)
    signoffs = await _signoffs(cid, year, month)
    txns = await _txns_reviewed(cid, start, end)
    invoices_open = await _outstanding_count("invoices", cid, end)
    bills_open = await _outstanding_count("bills", cid, end)

    inv_sign = signoffs.get("invoices")
    bill_sign = signoffs.get("bills")
    recon_sign = signoffs.get("recon")
    closed_sign = signoffs.get("closed")

    # When a month has no outstanding invoices / bills there's nothing to
    # review — auto-green the row and expose an `auto` flag so the UI can
    # show the neutral "Auto" pill instead of a sign-off button.
    inv_auto_green = (invoices_open == 0)
    bill_auto_green = (bills_open == 0)

    return {
        "year": year,
        "month": month,
        "period_start": start,
        "period_end": end,
        "checkpoints": {
            "txns_reviewed": {
                "green": txns["green"],
                "auto": True,
                "total": txns["total"],
                "uncategorized": txns["uncategorized"],
                "unreviewed": txns["unreviewed"],
            },
            "invoices": {
                "green": bool(inv_sign) or inv_auto_green,
                "auto": inv_auto_green and not inv_sign,
                "outstanding": invoices_open,
                "signed_at": inv_sign.get("signed_at") if inv_sign else None,
                "signed_by": inv_sign.get("signed_by") if inv_sign else None,
            },
            "bills": {
                "green": bool(bill_sign) or bill_auto_green,
                "auto": bill_auto_green and not bill_sign,
                "outstanding": bills_open,
                "signed_at": bill_sign.get("signed_at") if bill_sign else None,
                "signed_by": bill_sign.get("signed_by") if bill_sign else None,
            },
            "recon": {
                "green": bool(recon_sign),
                "signed_at": recon_sign.get("signed_at") if recon_sign else None,
                "signed_by": recon_sign.get("signed_by") if recon_sign else None,
            },
            "closed": {
                "green": bool(closed_sign),
                "signed_at": closed_sign.get("signed_at") if closed_sign else None,
                "signed_by": closed_sign.get("signed_by") if closed_sign else None,
            },
        },
    }


@router.get("/companies/{cid}/month-close/months")
async def list_month_closes(
    cid: str, count: int = 12, user: dict = Depends(get_current_user),
):
    """Return the last `count` months (capped at 24) ending with the current
    month, each with its 5-checkpoint rollup — powers the list grid."""
    await require_company(user, cid)
    count = max(1, min(int(count or 12), 24))
    now = datetime.now(timezone.utc)
    y, m = now.year, now.month
    months = []
    for _ in range(count):
        months.append(await _month_status(cid, y, m))
        # Step back one calendar month.
        m -= 1
        if m == 0:
            m = 12
            y -= 1
    # Ordered from oldest to newest so the grid reads left-to-right in time.
    return {"months": list(reversed(months))}


@router.get("/companies/{cid}/month-close/{ym}")
async def get_month_close(
    cid: str, ym: str, user: dict = Depends(get_current_user),
):
    await require_company(user, cid)
    y, m = _parse_ym(ym)
    return await _month_status(cid, y, m)


@router.post("/companies/{cid}/month-close/{ym}/checkpoint")
async def sign_checkpoint(
    cid: str, ym: str, inp: CheckpointIn,
    user: dict = Depends(get_current_user),
):
    await require_company(user, cid)
    y, m = _parse_ym(ym)
    if inp.kind not in CHECKPOINT_KINDS:
        raise HTTPException(400, f"Unknown checkpoint kind — must be one of {sorted(CHECKPOINT_KINDS)}")

    # Closing is gated on all four pre-conditions being green so the UI
    # can't accidentally lock a period with open work.
    if inp.kind == "closed" and inp.signed:
        status = await _month_status(cid, y, m)
        cps = status["checkpoints"]
        for pre in ("txns_reviewed", "invoices", "bills", "recon"):
            if not cps[pre]["green"]:
                raise HTTPException(
                    409,
                    f"Cannot close {ym}: '{pre}' is not yet signed off. Complete the checklist first.",
                )

    query = {"company_id": cid, "year": y, "month": m, "kind": inp.kind}
    if inp.signed:
        doc = {
            "id": str(uuid.uuid4()),
            **query,
            "signed_at": now_iso(),
            "signed_by": user.get("email") or user.get("id"),
        }
        await db.month_close_signoffs.update_one(query, {"$set": doc}, upsert=True)
        # For 'closed', also insert a period_lock so the existing engine
        # honours it downstream (block edits to txns in that window).
        if inp.kind == "closed":
            start, end = _month_bounds(y, m)
            lock_query = {"company_id": cid, "period_start": start, "period_end": end, "kind": "month"}
            await db.close_periods.update_one(lock_query, {"$set": {
                "id": str(uuid.uuid4()), **lock_query,
                "status": "closed",
                "closed_at": now_iso(),
                "closed_by": user.get("email") or user.get("id"),
            }}, upsert=True)
    else:
        # Un-sign: reverses the checkpoint. If un-signing 'closed', also
        # drop the matching close_periods row.
        await db.month_close_signoffs.delete_one(query)
        if inp.kind == "closed":
            start, end = _month_bounds(y, m)
            await db.close_periods.delete_many({
                "company_id": cid, "period_start": start, "period_end": end, "kind": "month",
            })
    return await _month_status(cid, y, m)
