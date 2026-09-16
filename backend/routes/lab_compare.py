"""Lab comparison API — read-only endpoints for the compare page.

  * ``POST  /api/companies/{cid}/lab/pipeline/run``          — sync (phase 1/2 quick)
  * ``POST  /api/companies/{cid}/lab/pipeline/run-async``    — background (phase 3)
  * ``GET   /api/companies/{cid}/lab/pipeline/status``       — polling
  * ``GET   /api/companies/{cid}/lab/compare``               — paginated live-vs-lab
  * ``POST  /api/companies/{cid}/lab/feedback``              — CPA feedback (lab_feedback)
  * ``GET   /api/companies/{cid}/lab/summary``               — top-of-page counts
  * ``GET   /api/companies/{cid}/lab/pfc-coa-mapping.csv``   — downloadable PFC→CoA map

Never writes to live collections.
"""
from __future__ import annotations
import asyncio
import csv
import io
import logging
import uuid
from datetime import datetime, timezone
from typing import Optional
from fastapi import APIRouter, Body, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from auth import get_current_user
from deps import require_company
from db import db
from lab_pipeline.collections import (
    LAB_TRANSACTIONS, LAB_FEEDBACK, LAB_COMPANY_ACCOUNTS,
    LAB_CONTACTS, LAB_MERGE_SUGGESTIONS, LAB_PENDING_ACCOUNTS,
)
from lab_pipeline.settings import is_lab_enabled
from lab_pipeline.runner import run_phase1, run_phase2, run_phase3
from lab_pipeline.pfc_coa_defaults import PFC_COA_MAP, PFC_TAXONOMY_VERSION

log = logging.getLogger("axiom.lab.api")

router = APIRouter(prefix="/api", tags=["lab-compare"])


async def _require_lab(cid: str, user: dict) -> None:
    await require_company(user, cid)
    if not await is_lab_enabled(cid):
        raise HTTPException(403, "lab_pipeline_v3 feature flag is OFF for this company")


@router.post("/companies/{cid}/lab/pipeline/run")
async def lab_run(cid: str, phase: int = Query(1, ge=1, le=3),
                   run_llm: bool = Query(True),
                   user: dict = Depends(get_current_user)):
    await _require_lab(cid, user)
    if phase == 1:
        return await run_phase1(cid)
    if phase == 2:
        return await run_phase2(cid, run_llm=run_llm)
    return await run_phase3(cid, run_llm=run_llm)


# --- Async job dispatch for long Phase 3 runs -------------------------------
# The synchronous /run endpoint is fine for a warm-cache Phase 3 (< 30s), but
# a cold-cache Phase 3 makes many Claude Haiku calls and blows past the 60s
# ingress timeout. This trio (dispatch / status) fixes it without introducing
# a full queue dependency.

_JOBS: dict[str, dict] = {}


async def _run_job(job_id: str, cid: str, phase: int, run_llm: bool) -> None:
    _JOBS[job_id]["status"] = "running"
    _JOBS[job_id]["started_at"] = datetime.now(timezone.utc).isoformat()
    try:
        if phase == 1:
            result = await run_phase1(cid)
        elif phase == 2:
            result = await run_phase2(cid, run_llm=run_llm)
        else:
            result = await run_phase3(cid, run_llm=run_llm)
        _JOBS[job_id]["status"] = "done"
        _JOBS[job_id]["result"] = result
    except Exception as ex:                              # noqa: BLE001
        log.exception("lab job %s failed", job_id)
        _JOBS[job_id]["status"] = "error"
        _JOBS[job_id]["error"]  = f"{type(ex).__name__}: {ex}"
    finally:
        _JOBS[job_id]["finished_at"] = datetime.now(timezone.utc).isoformat()


@router.post("/companies/{cid}/lab/pipeline/run-async")
async def lab_run_async(cid: str, phase: int = Query(3, ge=1, le=3),
                         run_llm: bool = Query(True),
                         user: dict = Depends(get_current_user)):
    """Fire-and-forget runner. Returns a job_id immediately; poll status."""
    await _require_lab(cid, user)
    job_id = str(uuid.uuid4())
    _JOBS[job_id] = {
        "job_id":     job_id,
        "company_id": cid,
        "phase":      phase,
        "run_llm":    run_llm,
        "status":     "queued",
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    asyncio.create_task(_run_job(job_id, cid, phase, run_llm))
    return {"ok": True, "job_id": job_id, "status": "queued"}


@router.get("/companies/{cid}/lab/pipeline/status/{job_id}")
async def lab_run_status(cid: str, job_id: str,
                          user: dict = Depends(get_current_user)):
    await _require_lab(cid, user)
    job = _JOBS.get(job_id)
    if not job or job.get("company_id") != cid:
        raise HTTPException(404, "job not found")
    return job


@router.get("/companies/{cid}/lab/compare")
async def lab_compare(
    cid: str,
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    only_differences: bool = False,
    movement_type: Optional[str] = None,
    channel: Optional[str] = None,
    contact_source: Optional[str] = None,
    contact_changed: bool = False,
    review_reason: Optional[str] = None,
    verified: Optional[bool] = None,
    q: Optional[str] = Query(None, description="Search description / merchant / contact"),
    difference_type: Optional[str] = None,  # "transfer_gained" | "transfer_lost"
    user: dict = Depends(get_current_user),
):
    """Paginated live-vs-lab view. Phase 1 + Phase 2 + Phase 3 columns."""
    await _require_lab(cid, user)

    q_filter: dict = {"company_id": cid}
    if movement_type:
        q_filter["movement_type"] = movement_type
    if channel:
        q_filter["channel"] = channel
    if contact_source:
        q_filter["contact_source"] = contact_source
    if review_reason:
        q_filter["review_reason"] = review_reason
    if verified is not None:
        q_filter["verified"] = verified
    if q:
        # Case-insensitive contains across the four text fields the
        # user might type into. Escape regex metacharacters to keep
        # queries literal.
        import re as _re
        safe = _re.escape(q.strip())
        if safe:
            q_filter["$or"] = [
                {"description_live":  {"$regex": safe, "$options": "i"}},
                {"merchant_live":     {"$regex": safe, "$options": "i"}},
                {"contact":           {"$regex": safe, "$options": "i"}},
                {"contact_name_live": {"$regex": safe, "$options": "i"}},
            ]
    q = q_filter                                                # backwards-compat downstream

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

    # `contact_changed` filter is applied post-fetch because it depends
    # on the live/lab name comparison (case- and whitespace-insensitive).
    cursor = (db[LAB_TRANSACTIONS].find(q, {"_id": 0})
              .sort("date", -1)
              .skip(0 if contact_changed else (page - 1) * page_size)
              .limit(0 if contact_changed else page_size))

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
        live_contact_name = contact_names.get(r.get("contact_id_live"), "") or r.get("contact_name_live")
        lab_contact_name  = r.get("contact")
        contact_diff = (live_contact_name or "").strip().lower() != (lab_contact_name or "").strip().lower()

        rows.append({
            "txn_id":      r.get("txn_id"),
            "date":        r.get("date"),
            "amount":      r.get("amount"),
            "account":     acct_names.get(r.get("bank_account_id"), ""),
            "description": r.get("description_live"),
            "merchant":    r.get("merchant_live"),
            "live": {
                "contact":   live_contact_name,
                "category":  acct_names.get(cat_id, ""),
                "transfer_pair_id": r.get("transfer_pair_id_live"),
            },
            "lab": {
                "contact":         lab_contact_name,
                "contact_source":  r.get("contact_source"),
                "contact_reason":  r.get("contact_reason"),
                "contact_id":      r.get("contact_id_lab"),
                "contact_new":     bool(r.get("lab_contact_new")),
                "merchant_type":   r.get("merchant_type"),
                "category":        r.get("category"),
                "category_source": r.get("category_source"),
                "verified":        r.get("verified"),
                "review_reason":   r.get("review_reason"),
                "review_card_key": r.get("review_card_key"),
                "movement_type":   movement,
                "movement_reason":     r.get("movement_reason"),
                "movement_confidence": r.get("movement_confidence"),
                "movement_pair_id":    r.get("movement_pair_id"),
                "linked_lab_account":  r.get("linked_lab_account"),
                "enrich_cache_key":    r.get("enrich_cache_key"),
                "enrich_source":       r.get("enrich_source"),
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
                "contact_changed":          contact_diff,
            },
        })

    # Post-filter for contact_changed (applied here because it depends on
    # live-vs-lab name comparison, not a stored field).
    if contact_changed:
        rows = [r for r in rows if r["diff"]["contact_changed"]]
        total = len(rows)
        rows = rows[(page - 1) * page_size: page * page_size]
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
    by_contact_source: dict[str, int] = {}
    by_merchant_type: dict[str, int] = {}
    by_review_reason: dict[str, int] = {}
    by_category_source: dict[str, int] = {}
    verified_count = 0
    review_count = 0
    diffs_movement_gained = 0
    diffs_movement_lost = 0
    contact_changed_rows = 0
    indn_skipped_rows = 0

    # Cache live contact names for the diff check.
    contact_names: dict[str, str] = {
        c["id"]: (c.get("name") or "")
        async for c in db.contacts.find({"company_id": cid}, {"id": 1, "name": 1})
    }

    async for r in db[LAB_TRANSACTIONS].find(
        {"company_id": cid},
        {"movement_type": 1, "transfer_pair_id_live": 1, "amount": 1,
         "contact_source": 1, "contact": 1, "contact_id_live": 1,
         "contact_name_live": 1, "parsed": 1, "description_live": 1,
         "merchant_type": 1, "verified": 1, "review_reason": 1,
         "category_source": 1},
    ):
        mt = r.get("movement_type")
        by_movement[mt or "none"] = by_movement.get(mt or "none", 0) + 1
        src = r.get("contact_source") or "none"
        by_contact_source[src] = by_contact_source.get(src, 0) + 1
        m = r.get("merchant_type") or "none"
        by_merchant_type[m] = by_merchant_type.get(m, 0) + 1
        rr = r.get("review_reason")
        if rr:
            by_review_reason[rr] = by_review_reason.get(rr, 0) + 1
        cs = r.get("category_source") or "none"
        by_category_source[cs] = by_category_source.get(cs, 0) + 1
        if r.get("verified") is True:
            verified_count += 1
        elif rr:
            review_count += 1

        if mt == "internal_transfer" and not r.get("transfer_pair_id_live"):
            diffs_movement_gained += 1
        if r.get("transfer_pair_id_live") and mt != "internal_transfer":
            diffs_movement_lost += 1

        live_name = (contact_names.get(r.get("contact_id_live"), "")
                     or r.get("contact_name_live") or "")
        lab_name = r.get("contact") or ""
        if (live_name.strip().lower() != lab_name.strip().lower()):
            contact_changed_rows += 1

        # INDN-derived-live-contact detector: live has a contact, lab
        # skipped/blanked it, and the description had "INDN:<live_name>".
        parsed = r.get("parsed") or {}
        indn = (parsed.get("indn") or "").strip().lower()
        if indn and live_name and not lab_name:
            if indn == live_name.lower():
                indn_skipped_rows += 1

    lab_new = await db[LAB_CONTACTS].count_documents({"company_id": cid})
    merges  = await db[LAB_MERGE_SUGGESTIONS].count_documents({"company_id": cid})
    accounts = [a async for a in db[LAB_COMPANY_ACCOUNTS].find({"company_id": cid}, {"_id": 0})]
    pending_accts = [
        a async for a in db[LAB_PENDING_ACCOUNTS].find(
            {"company_id": cid, "status": "proposed"},
            {"_id": 0},
        ).sort("code", 1)
    ]
    return {
        "scanned":                total,
        "by_movement_type":       by_movement,
        "by_contact_source":      by_contact_source,
        "by_merchant_type":       by_merchant_type,
        "by_review_reason":       by_review_reason,
        "by_category_source":     by_category_source,
        "verified":               verified_count,
        "review":                 review_count,
        "auto_book_pct":          round(100.0 * verified_count / total, 2) if total else 0,
        "differences": {
            "movement_gained_transfer": diffs_movement_gained,
            "movement_lost_transfer":   diffs_movement_lost,
            "contact_changed":          contact_changed_rows,
            "indn_derived_live_skipped": indn_skipped_rows,
        },
        "lab_new_contacts":       lab_new,
        "merge_suggestions":      merges,
        "lab_company_accounts":   accounts,
        "pending_accounts":       pending_accts,
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



# --------------------------------------------------------------------------
# PFC → CoA mapping download
# --------------------------------------------------------------------------

@router.get("/companies/{cid}/lab/pfc-coa-mapping.csv")
async def lab_pfc_coa_mapping_csv(cid: str,
                                    user: dict = Depends(get_current_user)):
    """Downloadable CSV joining THIS company's actual PFCs (with row
    counts + $ sums) against the default PFC→CoA mapping AND resolving
    the target account name to a real CoA id when it exists in the
    company's active accounts. Read-only.
    """
    await _require_lab(cid, user)

    # 1. Live count + sum per pfc_detailed (only rows this company has).
    seen: dict[str, dict] = {}
    async for r in db.transactions.aggregate([
        {"$match": {"company_id": cid}},
        {"$group": {
            "_id":     "$pfc_detailed",
            "count":   {"$sum": 1},
            "sum_abs": {"$sum": {"$abs": "$amount"}},
        }},
    ]):
        seen[r["_id"]] = {"count": r["count"], "sum_abs": round(r["sum_abs"], 2)}

    # 2. Load CoA (active only) so we can resolve name → id.
    coa_by_name: dict[str, dict] = {}
    async for a in db.accounts.find(
        {"company_id": cid, "is_active": {"$ne": False}},
        {"_id": 0, "id": 1, "name": 1, "type": 1},
    ):
        n = (a.get("name") or "").strip().lower()
        if n:
            # first wins so a subsequent duplicate ("Utilities" appears
            # twice in Test 519 LLC) doesn't overwrite the primary.
            coa_by_name.setdefault(n, a)

    # 3. Per-company PFC overrides (read-only) so the CSV shows what
    # the lab would ACTUALLY use for this company today.
    org_over: dict[str, str] = {}
    async for r in db.pfc_org_overrides.find(
        {"company_id": cid},
        {"pfc_detailed": 1, "category_account_id": 1},
    ):
        if r.get("pfc_detailed") and r.get("category_account_id"):
            org_over[r["pfc_detailed"]] = r["category_account_id"]

    # 4. Build the row set = union of (seen ∪ default map keys) so the
    # CSV documents every PFC the lab knows about, not just the ones
    # this company happens to have hit. Drop nulls.
    keys = sorted(k for k in (set(seen) | set(PFC_COA_MAP)) if k)

    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow([
        "pfc_detailed",
        "in_this_company_count",
        "in_this_company_sum_abs",
        "default_coa_target",
        "default_coa_kind",
        "coa_match_found",
        "matched_account_id",
        "matched_account_type",
        "override_active",
        "override_account_id",
        "note",
    ])
    for k in keys:
        if not k:
            continue
        default = PFC_COA_MAP.get(k, {})
        target  = default.get("coa")
        kind    = default.get("kind") or ""
        note    = default.get("note") or ""
        match   = coa_by_name.get((target or "").strip().lower()) if target else None
        s       = seen.get(k) or {}
        w.writerow([
            k,
            s.get("count", 0),
            s.get("sum_abs", 0),
            target or "",
            kind,
            "yes" if match else "no",
            match.get("id") if match else "",
            match.get("type") if match else "",
            "yes" if k in org_over else "no",
            org_over.get(k, ""),
            note,
        ])

    buf.seek(0)
    filename = f"pfc-coa-mapping_{cid[:8]}_v{PFC_TAXONOMY_VERSION}.csv"
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
