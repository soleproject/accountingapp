"""Lab comparison API — read-only endpoints for the compare page.

  * ``POST  /api/companies/{cid}/lab/pipeline/run``  — runs Phase 1
  * ``GET   /api/companies/{cid}/lab/compare``       — paginated live-vs-lab
  * ``POST  /api/companies/{cid}/lab/feedback``      — CPA feedback (lab_feedback)
  * ``GET   /api/companies/{cid}/lab/summary``       — top-of-page counts

Never writes to live collections.
"""
from __future__ import annotations
import logging
import uuid
from datetime import datetime, timezone
from typing import Optional
from fastapi import APIRouter, Body, Depends, HTTPException, Query
from auth import get_current_user
from deps import require_company
from db import db
from lab_pipeline.collections import (
    LAB_TRANSACTIONS, LAB_FEEDBACK, LAB_COMPANY_ACCOUNTS,
)
from lab_pipeline.settings import is_lab_enabled
from lab_pipeline.runner import run_phase1

log = logging.getLogger("axiom.lab.api")

router = APIRouter(prefix="/api", tags=["lab-compare"])


async def _require_lab(cid: str, user: dict) -> None:
    await require_company(user, cid)
    if not await is_lab_enabled(cid):
        raise HTTPException(403, "lab_pipeline_v3 feature flag is OFF for this company")


@router.post("/companies/{cid}/lab/pipeline/run")
async def lab_run(cid: str, user: dict = Depends(get_current_user)):
    await _require_lab(cid, user)
    return await run_phase1(cid)


@router.get("/companies/{cid}/lab/compare")
async def lab_compare(
    cid: str,
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    only_differences: bool = False,
    movement_type: Optional[str] = None,
    channel: Optional[str] = None,
    difference_type: Optional[str] = None,  # "transfer_gained" | "transfer_lost"
    user: dict = Depends(get_current_user),
):
    """Paginated live-vs-lab view. Phase 1 columns only."""
    await _require_lab(cid, user)

    q: dict = {"company_id": cid}
    if movement_type:
        q["movement_type"] = movement_type
    if channel:
        q["channel"] = channel

    # only_differences (phase 1 signal: movement diff vs live transfer_pair_id)
    if only_differences or difference_type:
        if difference_type == "transfer_gained":
            q["movement_type"] = "internal_transfer"
            q["transfer_pair_id_live"] = None
        elif difference_type == "transfer_lost":
            q["movement_type"] = {"$in": [None, "unpaired_transfer",
                                             "outside_transfer"]}
            q["transfer_pair_id_live"] = {"$ne": None}
        else:
            q["$or"] = [
                {"movement_type": "internal_transfer",
                 "transfer_pair_id_live": None},
                {"movement_type": {"$in": [None, "unpaired_transfer",
                                             "outside_transfer"]},
                 "transfer_pair_id_live": {"$ne": None}},
            ]

    total = await db[LAB_TRANSACTIONS].count_documents(q)
    cursor = (db[LAB_TRANSACTIONS].find(q, {"_id": 0})
              .sort("date", -1)
              .skip((page - 1) * page_size)
              .limit(page_size))

    # Resolve account + contact names for display.
    acct_names: dict[str, str] = {
        a["id"]: (a.get("name") or "")
        async for a in db.accounts.find({"company_id": cid}, {"id": 1, "name": 1})
    }
    contact_names: dict[str, str] = {
        c["id"]: (c.get("name") or "")
        async for c in db.contacts.find({"company_id": cid}, {"id": 1, "name": 1})
    }

    rows = []
    async for r in cursor:
        movement = r.get("movement_type")
        # Phase 1 "lab status" — movement-driven only. Contact/category
        # columns are placeholders here; they're filled in Phase 2/3.
        lab_status = None
        if movement == "internal_transfer":
            lab_status = ("verified", "matched_transfer"
                          + (" (low-confidence pair)"
                             if r.get("movement_confidence") == "low" else ""))
        elif movement == "card_payment":
            lab_status = ("verified", "matched_card_payment")
        elif movement == "credit_line_payment":
            lab_status = ("review", "credit_line_payment")
        elif movement == "outside_transfer":
            lab_status = ("review", "outside_transfer_needs_ack")
        elif movement == "payment_app_transfer":
            lab_status = ("review", "payment_app_needs_context")
        elif movement == "unpaired_transfer":
            lab_status = ("review", "unpaired_transfer")

        cat_id = r.get("category_account_id_live")
        rows.append({
            "txn_id":      r.get("txn_id"),
            "date":        r.get("date"),
            "amount":      r.get("amount"),
            "account":     acct_names.get(r.get("bank_account_id"), ""),
            "description": r.get("description_live"),
            "merchant":    r.get("merchant_live"),
            "live": {
                "contact":   contact_names.get(r.get("contact_id_live"), "") or r.get("contact_name_live"),
                "category":  acct_names.get(cat_id, ""),
                "transfer_pair_id": r.get("transfer_pair_id_live"),
            },
            "lab": {
                # Phase 1: contact/category unchanged from live — later
                # phases will populate. Movement is the Phase 1 signal.
                "contact":       None,
                "category":      None,
                "movement_type": movement,
                "movement_reason":     r.get("movement_reason"),
                "movement_confidence": r.get("movement_confidence"),
                "movement_pair_id":    r.get("movement_pair_id"),
                "linked_lab_account":  r.get("linked_lab_account"),
                "status":        lab_status[0] if lab_status else None,
                "status_reason": lab_status[1] if lab_status else None,
            },
            "raw":         r.get("raw"),
            "channel":     r.get("channel"),
            "parsed":      r.get("parsed"),
            "paypal":      r.get("paypal"),
            "direction":   r.get("direction"),
            "raw_overwrites": r.get("raw_overwrites") or [],
            "diff": {
                "movement_gained_transfer": (movement == "internal_transfer"
                                              and not r.get("transfer_pair_id_live")),
                "movement_lost_transfer":   (bool(r.get("transfer_pair_id_live"))
                                              and movement != "internal_transfer"),
            },
        })
    return {
        "total":      total,
        "page":       page,
        "page_size":  page_size,
        "rows":       rows,
    }


@router.get("/companies/{cid}/lab/summary")
async def lab_summary(cid: str, user: dict = Depends(get_current_user)):
    """Top-of-page counts for the compare page."""
    await _require_lab(cid, user)
    total = await db[LAB_TRANSACTIONS].count_documents({"company_id": cid})
    by_movement: dict[str, int] = {}
    diffs_movement_gained = 0
    diffs_movement_lost = 0
    async for r in db[LAB_TRANSACTIONS].find(
        {"company_id": cid},
        {"movement_type": 1, "transfer_pair_id_live": 1, "amount": 1},
    ):
        mt = r.get("movement_type")
        by_movement[mt or "none"] = by_movement.get(mt or "none", 0) + 1
        if mt == "internal_transfer" and not r.get("transfer_pair_id_live"):
            diffs_movement_gained += 1
        if r.get("transfer_pair_id_live") and mt != "internal_transfer":
            diffs_movement_lost += 1
    accounts = [a async for a in db[LAB_COMPANY_ACCOUNTS].find({"company_id": cid}, {"_id": 0})]
    return {
        "scanned":                total,
        "by_movement_type":       by_movement,
        "differences": {
            "movement_gained_transfer": diffs_movement_gained,
            "movement_lost_transfer":   diffs_movement_lost,
        },
        "lab_company_accounts":   accounts,
    }


@router.post("/companies/{cid}/lab/feedback")
async def lab_feedback(cid: str, payload: dict = Body(...),
                        user: dict = Depends(get_current_user)):
    """CPA feedback per row: which is right?"""
    await _require_lab(cid, user)
    txn_id = payload.get("txn_id")
    if not txn_id:
        raise HTTPException(400, "txn_id required")
    verdict = payload.get("verdict")
    if verdict not in ("live", "lab", "neither"):
        raise HTTPException(400, "verdict must be live|lab|neither")
    doc = {
        "id":               str(uuid.uuid4()),
        "company_id":       cid,
        "txn_id":           txn_id,
        "verdict":          verdict,
        "correct_category": payload.get("correct_category"),
        "note":             (payload.get("note") or "")[:1000],
        "created_by":       user.get("id"),
        "created_at":       datetime.now(timezone.utc).isoformat(),
    }
    await db[LAB_FEEDBACK].insert_one(doc)
    return {"ok": True, "id": doc["id"]}
