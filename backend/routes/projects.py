"""Projects CRUD (Phase 3 — Feb 2026).

Mirrors the Classes shape but adds a required `contact_id` (the
customer the project is for), lifecycle status, and estimated_revenue
for the profitability report.

Routes:
    GET    /api/companies/{cid}/projects
    POST   /api/companies/{cid}/projects
    PATCH  /api/companies/{cid}/projects/{project_id}
    DELETE /api/companies/{cid}/projects/{project_id}
    GET    /api/companies/{cid}/reports/project-profitability
"""
from __future__ import annotations

import uuid
from collections import defaultdict
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query

from auth import get_current_user
from db import db, now_iso
from deps import require_company

router = APIRouter(prefix="/api")

_VALID_STATUS = {"planning", "in_progress", "on_hold",
                  "completed", "cancelled"}


def _clean(doc: dict) -> dict:
    if not doc:
        return doc
    doc.pop("_id", None)
    return doc


async def _project_in_use(cid: str, project_id: str) -> bool:
    if await db.transactions.count_documents(
        {"company_id": cid, "project_id": project_id}, limit=1,
    ):
        return True
    if await db.journal_entries.count_documents(
        {"company_id": cid, "lines.project_id": project_id}, limit=1,
    ):
        return True
    for coll in ("invoices", "bills", "payments", "receipts", "estimates"):
        if await db[coll].count_documents(
            {"company_id": cid, "project_id": project_id}, limit=1,
        ):
            return True
    return False


# ------------------------- CRUD -------------------------
@router.get("/companies/{cid}/projects")
async def list_projects(
    cid: str,
    status: Optional[str] = None,
    contact_id: Optional[str] = None,
    include_inactive: int = Query(0),
    user: dict = Depends(get_current_user),
) -> dict:
    await require_company(user, cid)
    q: dict[str, Any] = {"company_id": cid}
    if status:
        q["status"] = status
    if contact_id:
        q["contact_id"] = contact_id
    if not include_inactive:
        q["status"] = q.get("status") or {"$nin": ["cancelled"]}
    rows = await db.projects.find(q).sort("name", 1).to_list(2000)
    return {"projects": [_clean(r) for r in rows]}


@router.post("/companies/{cid}/projects")
async def create_project(
    cid: str, payload: dict,
    user: dict = Depends(get_current_user),
) -> dict:
    await require_company(user, cid)
    name = (payload.get("name") or "").strip()
    if not name:
        raise HTTPException(400, "Project name is required")
    contact_id = payload.get("contact_id")
    if not contact_id:
        raise HTTPException(400, "A customer (contact_id) is required")
    contact = await db.contacts.find_one(
        {"company_id": cid, "id": contact_id})
    if not contact:
        raise HTTPException(404, "Customer not found in this company")
    # Uniqueness: same name + same customer conflicts (matches QBO —
    # a customer can have "Kitchen Remodel 2024" and "Kitchen Remodel
    # 2025", but not two identical names).
    dup = await db.projects.find_one({
        "company_id": cid,
        "contact_id": contact_id,
        "name": {"$regex": f"^{name}$", "$options": "i"},
    })
    if dup:
        raise HTTPException(
            409, f'"{name}" already exists for this customer')
    status = payload.get("status") or "in_progress"
    if status not in _VALID_STATUS:
        raise HTTPException(400, f"status must be one of {sorted(_VALID_STATUS)}")

    now = now_iso()
    doc = {
        "id": str(uuid.uuid4()),
        "company_id": cid,
        "name": name,
        "contact_id": contact_id,
        "contact_name": contact.get("name"),
        "status": status,
        "start_date": payload.get("start_date"),
        "end_date": payload.get("end_date"),
        "estimated_revenue": (float(payload["estimated_revenue"])
                                if payload.get("estimated_revenue") is not None
                                else None),
        "hourly_cost_rate": (float(payload["hourly_cost_rate"])
                              if payload.get("hourly_cost_rate") is not None
                              else None),
        "notes": (payload.get("notes") or "").strip(),
        "created_at": now,
        "updated_at": now,
    }
    await db.projects.insert_one(doc)
    return {"ok": True, "project": _clean(dict(doc))}


@router.patch("/companies/{cid}/projects/{project_id}")
async def update_project(
    cid: str, project_id: str, payload: dict,
    user: dict = Depends(get_current_user),
) -> dict:
    await require_company(user, cid)
    doc = await db.projects.find_one(
        {"company_id": cid, "id": project_id})
    if not doc:
        raise HTTPException(404, "Project not found")

    update: dict = {}
    if "name" in payload:
        new_name = (payload["name"] or "").strip()
        if not new_name:
            raise HTTPException(400, "Name cannot be empty")
        # Uniqueness scoped to same customer.
        dup = await db.projects.find_one({
            "company_id": cid,
            "contact_id": doc["contact_id"],
            "id": {"$ne": project_id},
            "name": {"$regex": f"^{new_name}$", "$options": "i"},
        })
        if dup:
            raise HTTPException(409, "Another project on this customer already has that name")
        update["name"] = new_name
    if "status" in payload:
        st = payload["status"]
        if st not in _VALID_STATUS:
            raise HTTPException(400, f"status must be one of {sorted(_VALID_STATUS)}")
        update["status"] = st
    for f in ("start_date", "end_date", "notes"):
        if f in payload:
            update[f] = payload[f]
    for f in ("estimated_revenue", "hourly_cost_rate"):
        if f in payload:
            update[f] = (float(payload[f])
                          if payload[f] is not None else None)
    if not update:
        raise HTTPException(400, "No mutable fields in payload")
    update["updated_at"] = now_iso()
    await db.projects.update_one(
        {"company_id": cid, "id": project_id}, {"$set": update})
    fresh = await db.projects.find_one(
        {"company_id": cid, "id": project_id})
    return {"ok": True, "project": _clean(fresh)}


@router.delete("/companies/{cid}/projects/{project_id}")
async def delete_project(
    cid: str, project_id: str,
    hard: int = Query(0),
    user: dict = Depends(get_current_user),
) -> dict:
    """Soft-delete by default (status → cancelled). `hard=1` removes
    the row entirely — only when nothing references it."""
    await require_company(user, cid)
    doc = await db.projects.find_one(
        {"company_id": cid, "id": project_id})
    if not doc:
        raise HTTPException(404, "Project not found")
    if hard:
        if await _project_in_use(cid, project_id):
            raise HTTPException(
                400,
                "Project is referenced by transactions or journal entries — mark cancelled instead")
        await db.projects.delete_one(
            {"company_id": cid, "id": project_id})
        return {"ok": True, "deleted": True, "hard": True}
    await db.projects.update_one(
        {"company_id": cid, "id": project_id},
        {"$set": {"status": "cancelled", "updated_at": now_iso()}},
    )
    return {"ok": True, "deleted": True, "hard": False}


# ------------------------- Reports -------------------------
@router.get("/companies/{cid}/reports/project-profitability")
async def project_profitability(
    cid: str,
    project_id: str,
    start: Optional[str] = None,
    end: Optional[str] = None,
    basis: str = "accrual",
    user: dict = Depends(get_current_user),
) -> dict:
    """Income + expense rollup scoped to a single project.

    Uses the same `_signed_balances(class_id=None, project_id=X)`
    engine that class-slicing does, then splits the returned map
    into revenue / expense / COGS buckets and computes net.

    Also joins the project's `estimated_revenue` so the frontend
    can render "% of estimate consumed" without a second call.
    """
    await require_company(user, cid)
    project = await db.projects.find_one(
        {"company_id": cid, "id": project_id})
    if not project:
        raise HTTPException(404, "Project not found")

    from reports import _signed_balances
    accts = await db.accounts.find(
        {"company_id": cid}).to_list(2000)
    accts_by_id = {a["id"]: a for a in accts}

    # Wide date range if start/end omitted so a project's full
    # history rolls up by default.
    s = start or "2000-01-01"
    e = end or "2099-12-31"
    by = await _signed_balances(
        cid, s, e, basis=basis.capitalize(), project_id=project_id)

    revenue_rows: list[dict] = []
    expense_rows: list[dict] = []
    cogs_rows: list[dict] = []
    total_revenue = 0.0
    total_expense = 0.0
    total_cogs = 0.0

    for aid, bal in by.items():
        a = accts_by_id.get(aid)
        if not a:
            continue
        t = (a.get("type") or "").lower()
        row = {"id": aid, "code": a.get("code"), "name": a.get("name"),
               "amount": round(bal, 2)}
        # Revenue is credit-normal → `by[]` returns debit-positive
        # (negative). Flip for display.
        if t in ("revenue", "income"):
            row["amount"] = round(-bal, 2)
            revenue_rows.append(row)
            total_revenue += row["amount"]
        elif t == "cogs":
            cogs_rows.append(row)
            total_cogs += row["amount"]
        elif t == "expense":
            expense_rows.append(row)
            total_expense += row["amount"]

    net = round(total_revenue - total_cogs - total_expense, 2)
    est = project.get("estimated_revenue")
    return {
        "project": _clean(dict(project)),
        "start": s, "end": e, "basis": basis,
        "revenue":  {"rows": revenue_rows, "total": round(total_revenue, 2)},
        "cogs":     {"rows": cogs_rows,    "total": round(total_cogs, 2)},
        "expenses": {"rows": expense_rows, "total": round(total_expense, 2)},
        "gross_profit": round(total_revenue - total_cogs, 2),
        "net_income": net,
        "estimated_revenue": est,
        "pct_of_estimate": (round((total_revenue / est) * 100, 1)
                              if est and est > 0 else None),
    }


@router.get("/companies/{cid}/reports/estimates-vs-actuals")
async def estimates_vs_actuals(
    cid: str,
    include_completed: int = Query(1),
    user: dict = Depends(get_current_user),
) -> dict:
    """Per-project rollup of commitment vs paid vs remaining, sourced
    from the project-linked invoices and bills.

    For each project:

        Revenue side (customer-facing):
            estimated       : projects.estimated_revenue (nullable)
            invoiced        : Σ invoices.total  WHERE project_id = p.id
            received        : invoiced - AR_outstanding
                              (uses invoices.balance_due for open AR)
            remaining_est   : max(estimated - invoiced, 0)
            ar_outstanding  : Σ invoices.balance_due
            invoice_count   : COUNT(invoices)

        Cost side (vendor-facing):
            committed       : Σ bills.total  WHERE project_id = p.id
            paid_to_vendors : committed - AP_outstanding
            ap_outstanding  : Σ bills.balance_due
            bill_count      : COUNT(bills)

    Also returns a totals row and each project's contact name so the
    PM view doesn't need a second call.

    NOTE: All numbers come from stored `total` / `balance_due` fields
    on the invoice/bill docs, which are kept in sync by the posting
    engine — so the rollup matches whatever the individual invoice
    and bill pages show. No signed-balance query needed.
    """
    await require_company(user, cid)

    q: dict[str, Any] = {"company_id": cid}
    if not include_completed:
        # Hide finished / cancelled by default when caller passes 0.
        q["status"] = {"$nin": ["completed", "cancelled"]}
    else:
        q["status"] = {"$ne": "cancelled"}
    projects = await db.projects.find(q).sort("name", 1).to_list(2000)

    # Bulk-fetch invoices / bills for these projects in one query
    # each — cheaper than N round-trips.
    proj_ids = [p["id"] for p in projects]
    inv_rows = await db.invoices.find(
        {"company_id": cid, "project_id": {"$in": proj_ids}},
        {"project_id": 1, "total": 1, "balance_due": 1},
    ).to_list(50000)
    bill_rows = await db.bills.find(
        {"company_id": cid, "project_id": {"$in": proj_ids}},
        {"project_id": 1, "total": 1, "balance_due": 1},
    ).to_list(50000)

    inv_by = defaultdict(lambda: {"count": 0, "total": 0.0, "balance": 0.0})
    for r in inv_rows:
        b = inv_by[r["project_id"]]
        b["count"] += 1
        b["total"]   += float(r.get("total") or 0)
        b["balance"] += float(r.get("balance_due") or 0)
    bill_by = defaultdict(lambda: {"count": 0, "total": 0.0, "balance": 0.0})
    for r in bill_rows:
        b = bill_by[r["project_id"]]
        b["count"] += 1
        b["total"]   += float(r.get("total") or 0)
        b["balance"] += float(r.get("balance_due") or 0)

    rows: list[dict] = []
    totals = {
        "estimated": 0.0, "invoiced": 0.0, "received": 0.0,
        "remaining_est": 0.0, "ar_outstanding": 0.0,
        "committed": 0.0, "paid_to_vendors": 0.0, "ap_outstanding": 0.0,
    }
    for p in projects:
        pid = p["id"]
        inv = inv_by.get(pid, {"count": 0, "total": 0.0, "balance": 0.0})
        bl  = bill_by.get(pid, {"count": 0, "total": 0.0, "balance": 0.0})
        est = float(p.get("estimated_revenue") or 0)
        invoiced = round(inv["total"], 2)
        ar_out   = round(inv["balance"], 2)
        received = round(invoiced - ar_out, 2)
        remaining_est = round(max(est - invoiced, 0.0), 2)
        committed = round(bl["total"], 2)
        ap_out    = round(bl["balance"], 2)
        paid_v    = round(committed - ap_out, 2)
        row = {
            "id": pid,
            "name": p.get("name"),
            "status": p.get("status"),
            "contact_id": p.get("contact_id"),
            "contact_name": p.get("contact_name"),
            "estimated": est,
            "invoiced": invoiced,
            "received": received,
            "remaining_est": remaining_est,
            "ar_outstanding": ar_out,
            "invoice_count": inv["count"],
            "committed": committed,
            "paid_to_vendors": paid_v,
            "ap_outstanding": ap_out,
            "bill_count": bl["count"],
            # Convenience metrics.
            "pct_billed": (round((invoiced / est) * 100, 1)
                            if est > 0 else None),
            "pct_collected": (round((received / invoiced) * 100, 1)
                                if invoiced > 0 else None),
            # Net position = money in - money out (received - paid).
            "net_cash": round(received - paid_v, 2),
        }
        rows.append(row)
        for k in totals:
            totals[k] += row[k]

    for k in totals:
        totals[k] = round(totals[k], 2)
    return {"projects": rows, "totals": totals, "project_count": len(rows)}
