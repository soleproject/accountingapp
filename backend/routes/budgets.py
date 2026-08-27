"""Budgets — Phase 4 advanced feature (Feb 2026).

A Budget is a company-scoped envelope for a fiscal year with monthly
targets per P&L account. Structure follows QBO's budget model so
future QBO Budget import lands cleanly onto the same shape:

    budgets:
        id, company_id, name, fiscal_year (int),
        status ("draft" | "active" | "archived"),
        scope ("company"),        # future: "class" | "project"
        scope_ref_id (nullable),  # (unused for company scope)
        created_at, updated_at

    budget_lines:
        id, company_id, budget_id, account_id, account_code (denorm),
        account_name (denorm), period_key ("YYYY-MM"), amount (float),
        created_at, updated_at
        (unique index on (budget_id, account_id, period_key))

Routes:
    GET    /api/companies/{cid}/budgets              — list
    POST   /api/companies/{cid}/budgets              — create envelope
    GET    /api/companies/{cid}/budgets/{bid}        — envelope + all lines
    PATCH  /api/companies/{cid}/budgets/{bid}        — rename / status
    DELETE /api/companies/{cid}/budgets/{bid}        — hard-delete + cascade lines
    PUT    /api/companies/{cid}/budgets/{bid}/lines  — bulk upsert lines
    POST   /api/companies/{cid}/budgets/{bid}/prefill  — pre-fill amounts from prior-year actuals
    GET    /api/companies/{cid}/reports/budget-vs-actuals?budget_id=X&basis=accrual  — variance report
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

_VALID_STATUS = {"draft", "active", "archived"}
_VALID_SCOPE = {"company", "class", "project"}


async def _resolve_scope(cid: str, scope: str, scope_ref_id: str | None) -> dict:
    """Validate scope + return a denormalized display name for the
    scoped budget so the list UI doesn't need N extra fetches.

    Raises 400 if the scope-flag isn't enabled on the company, 404 if
    the referenced class/project doesn't exist, or 400 if scope needs
    a ref but none was provided.
    """
    if scope == "company":
        return {"scope_ref_name": None}
    if not scope_ref_id:
        raise HTTPException(400, f"scope_ref_id is required for scope '{scope}'")
    from advanced_features import get_features
    features = await get_features(cid)
    if scope == "class":
        if not features.get("classes_enabled"):
            raise HTTPException(400, "Classes are not enabled on this company")
        ref = await db.classes.find_one({"company_id": cid, "id": scope_ref_id})
        if not ref:
            raise HTTPException(404, "Class not found")
        return {"scope_ref_name": ref.get("name")}
    if scope == "project":
        if not features.get("projects_enabled"):
            raise HTTPException(400, "Projects are not enabled on this company")
        ref = await db.projects.find_one({"company_id": cid, "id": scope_ref_id})
        if not ref:
            raise HTTPException(404, "Project not found")
        return {"scope_ref_name": ref.get("name")}
    raise HTTPException(400, f"scope must be one of {sorted(_VALID_SCOPE)}")


def _clean(doc: dict) -> dict:
    if not doc:
        return doc
    doc.pop("_id", None)
    return doc


def _period_keys(fiscal_year: int) -> list[str]:
    """Return ["YYYY-01", …, "YYYY-12"] for the given fiscal year."""
    return [f"{fiscal_year:04d}-{m:02d}" for m in range(1, 13)]


# ─── CRUD ────────────────────────────────────────────────────────

@router.get("/companies/{cid}/budgets")
async def list_budgets(
    cid: str,
    user: dict = Depends(get_current_user),
) -> dict:
    await require_company(user, cid)
    rows = await db.budgets.find(
        {"company_id": cid}).sort("fiscal_year", -1).to_list(500)
    return {"budgets": [_clean(r) for r in rows]}


@router.post("/companies/{cid}/budgets")
async def create_budget(
    cid: str, payload: dict,
    user: dict = Depends(get_current_user),
) -> dict:
    await require_company(user, cid)
    name = (payload.get("name") or "").strip()
    if not name:
        raise HTTPException(400, "Budget name is required")
    fy = payload.get("fiscal_year")
    try:
        fy = int(fy)
    except (TypeError, ValueError):
        raise HTTPException(400, "fiscal_year must be an integer")
    if fy < 1900 or fy > 2200:
        raise HTTPException(400, "fiscal_year out of range")
    status = payload.get("status") or "draft"
    if status not in _VALID_STATUS:
        raise HTTPException(400, f"status must be one of {sorted(_VALID_STATUS)}")

    scope = (payload.get("scope") or "company").lower()
    if scope not in _VALID_SCOPE:
        raise HTTPException(400, f"scope must be one of {sorted(_VALID_SCOPE)}")
    scope_ref_id = payload.get("scope_ref_id") or None
    if scope == "company":
        scope_ref_id = None
    scope_meta = await _resolve_scope(cid, scope, scope_ref_id)

    # Name uniqueness is scoped to (fiscal_year, scope, scope_ref_id) so
    # a shop can have "FY26 Plan" at Company AND "FY26 Plan" for their
    # Marketing class without conflict.
    dup = await db.budgets.find_one({
        "company_id": cid, "fiscal_year": fy,
        "scope": scope, "scope_ref_id": scope_ref_id,
        "name": {"$regex": f"^{name}$", "$options": "i"},
    })
    if dup:
        raise HTTPException(
            409, f'"{name}" already exists at this scope for fiscal year {fy}')

    now = now_iso()
    doc = {
        "id": str(uuid.uuid4()),
        "company_id": cid,
        "name": name,
        "fiscal_year": fy,
        "status": status,
        "scope": scope,
        "scope_ref_id": scope_ref_id,
        "scope_ref_name": scope_meta["scope_ref_name"],
        "created_at": now,
        "updated_at": now,
    }
    await db.budgets.insert_one(doc)
    return {"ok": True, "budget": _clean(dict(doc))}


@router.get("/companies/{cid}/budgets/{budget_id}")
async def get_budget(
    cid: str, budget_id: str,
    user: dict = Depends(get_current_user),
) -> dict:
    """Return the envelope + every stored line for this budget. The
    frontend spreadsheet builder consumes this in one shot.
    """
    await require_company(user, cid)
    doc = await db.budgets.find_one(
        {"company_id": cid, "id": budget_id})
    if not doc:
        raise HTTPException(404, "Budget not found")
    lines = await db.budget_lines.find(
        {"company_id": cid, "budget_id": budget_id},
    ).to_list(20000)
    return {
        "budget": _clean(doc),
        "lines": [_clean(l) for l in lines],
    }


@router.patch("/companies/{cid}/budgets/{budget_id}")
async def update_budget(
    cid: str, budget_id: str, payload: dict,
    user: dict = Depends(get_current_user),
) -> dict:
    await require_company(user, cid)
    doc = await db.budgets.find_one(
        {"company_id": cid, "id": budget_id})
    if not doc:
        raise HTTPException(404, "Budget not found")
    update: dict = {}
    if "name" in payload:
        new_name = (payload["name"] or "").strip()
        if not new_name:
            raise HTTPException(400, "Name cannot be empty")
        dup = await db.budgets.find_one({
            "company_id": cid, "fiscal_year": doc["fiscal_year"],
            "scope": doc.get("scope", "company"),
            "scope_ref_id": doc.get("scope_ref_id"),
            "id": {"$ne": budget_id},
            "name": {"$regex": f"^{new_name}$", "$options": "i"},
        })
        if dup:
            raise HTTPException(409, "Another budget at this scope + fiscal year already has that name")
        update["name"] = new_name
    if "status" in payload:
        st = payload["status"]
        if st not in _VALID_STATUS:
            raise HTTPException(400, f"status must be one of {sorted(_VALID_STATUS)}")
        update["status"] = st
    if not update:
        raise HTTPException(400, "No mutable fields in payload")
    update["updated_at"] = now_iso()
    await db.budgets.update_one(
        {"company_id": cid, "id": budget_id}, {"$set": update})
    fresh = await db.budgets.find_one(
        {"company_id": cid, "id": budget_id})
    return {"ok": True, "budget": _clean(fresh)}


@router.delete("/companies/{cid}/budgets/{budget_id}")
async def delete_budget(
    cid: str, budget_id: str,
    user: dict = Depends(get_current_user),
) -> dict:
    """Hard-delete a budget + all its lines. Budgets are planning docs
    — no ledger tie-in — so deletion is always safe."""
    await require_company(user, cid)
    doc = await db.budgets.find_one(
        {"company_id": cid, "id": budget_id})
    if not doc:
        raise HTTPException(404, "Budget not found")
    await db.budgets.delete_one(
        {"company_id": cid, "id": budget_id})
    await db.budget_lines.delete_many(
        {"company_id": cid, "budget_id": budget_id})
    return {"ok": True, "deleted": True}


# ─── LINES — bulk upsert ─────────────────────────────────────────

@router.put("/companies/{cid}/budgets/{budget_id}/lines")
async def upsert_lines(
    cid: str, budget_id: str, payload: dict,
    user: dict = Depends(get_current_user),
) -> dict:
    """Bulk-upsert budget lines. Payload:
        { "lines": [ { account_id, period_key, amount }, … ] }

    A cell with `amount == 0` is treated as "cleared" — the row is
    deleted. Any (account_id, period_key) pair not in the payload is
    left untouched. This matches QBO's builder UX where blanking a
    cell means "no target".

    Every (account_id, period_key) in the payload gets an upsert with
    denormalized account_code + account_name for cheap rendering.
    Non-P&L accounts are rejected — budgets model income statement
    activity, not balance sheet positions.
    """
    await require_company(user, cid)
    budget = await db.budgets.find_one(
        {"company_id": cid, "id": budget_id})
    if not budget:
        raise HTTPException(404, "Budget not found")

    lines_in = payload.get("lines") or []
    if not isinstance(lines_in, list):
        raise HTTPException(400, "`lines` must be a list")

    # Resolve accounts once — used for denorm + P&L guard.
    accts = await db.accounts.find(
        {"company_id": cid}).to_list(5000)
    accts_by_id = {a["id"]: a for a in accts}
    fy = budget["fiscal_year"]
    valid_periods = set(_period_keys(fy))

    now = now_iso()
    n_upserted = 0
    n_cleared = 0
    for row in lines_in:
        aid = row.get("account_id")
        pk = row.get("period_key")
        if not aid or not pk:
            continue
        if pk not in valid_periods:
            raise HTTPException(
                400, f"period_key {pk} is outside fiscal year {fy}")
        acct = accts_by_id.get(aid)
        if not acct:
            continue  # silently skip — CoA changed under our feet
        t = (acct.get("type") or "").lower()
        if t not in ("revenue", "income", "cogs", "expense"):
            raise HTTPException(
                400,
                f"Only P&L accounts can be budgeted "
                f"(got {acct.get('name')} · {t})")
        try:
            amt = float(row.get("amount") or 0)
        except (TypeError, ValueError):
            amt = 0.0
        if amt == 0:
            # Blank cell → clear the row.
            r = await db.budget_lines.delete_one({
                "company_id": cid, "budget_id": budget_id,
                "account_id": aid, "period_key": pk,
            })
            if r.deleted_count:
                n_cleared += 1
            continue
        await db.budget_lines.update_one(
            {"company_id": cid, "budget_id": budget_id,
             "account_id": aid, "period_key": pk},
            {"$set": {
                "amount": round(amt, 2),
                "account_code": acct.get("code"),
                "account_name": acct.get("name"),
                "updated_at": now,
            },
             "$setOnInsert": {
                 "id": str(uuid.uuid4()),
                 "company_id": cid, "budget_id": budget_id,
                 "account_id": aid, "period_key": pk,
                 "created_at": now,
             }},
            upsert=True,
        )
        n_upserted += 1

    await db.budgets.update_one(
        {"company_id": cid, "id": budget_id},
        {"$set": {"updated_at": now}})
    return {"ok": True, "upserted": n_upserted, "cleared": n_cleared}


# ─── Prior-year pre-fill ─────────────────────────────────────────

@router.post("/companies/{cid}/budgets/{budget_id}/prefill")
async def prefill_prior_year(
    cid: str, budget_id: str, payload: dict | None = None,
    user: dict = Depends(get_current_user),
) -> dict:
    """Populate the budget with prior-year monthly actuals per P&L
    account. Optional payload:

        { "growth_pct": 5 }   → uplifts every value by 5 % (compound)

    Uses the same `_signed_balances` engine that P&L reports use so
    numbers match to the penny. Runs 12 monthly slices for the prior
    fiscal year and upserts each non-zero (account, month) as a
    budget line. Idempotent — re-running overwrites the same rows.

    Returns { seeded: <count> }.
    """
    await require_company(user, cid)
    budget = await db.budgets.find_one(
        {"company_id": cid, "id": budget_id})
    if not budget:
        raise HTTPException(404, "Budget not found")
    fy = int(budget["fiscal_year"])
    prior = fy - 1
    growth = float((payload or {}).get("growth_pct") or 0)
    factor = 1 + (growth / 100.0)

    accts = await db.accounts.find(
        {"company_id": cid}).to_list(5000)
    accts_by_id = {a["id"]: a for a in accts}

    # Scope the actuals pull so class/project-scoped budgets only pre-fill
    # from postings tagged with the matching FK — same engine as P&L
    # class-slicing so numbers match to the penny.
    scope = budget.get("scope") or "company"
    scope_ref = budget.get("scope_ref_id")
    class_id = scope_ref if scope == "class" else None
    project_id = scope_ref if scope == "project" else None

    from reports import _signed_balances
    from calendar import monthrange
    now = now_iso()
    seeded = 0

    for m in range(1, 13):
        start = f"{prior:04d}-{m:02d}-01"
        last_day = monthrange(prior, m)[1]
        end = f"{prior:04d}-{m:02d}-{last_day:02d}"
        by = await _signed_balances(
            cid, start, end, basis="Accrual",
            class_id=class_id, project_id=project_id)
        target_pk = f"{fy:04d}-{m:02d}"
        for aid, bal in by.items():
            a = accts_by_id.get(aid)
            if not a:
                continue
            t = (a.get("type") or "").lower()
            if t not in ("revenue", "income", "cogs", "expense"):
                continue
            # Revenue is credit-normal → `by[]` returns debit-positive
            # (negative). Flip so the budget target reads positive.
            display = -bal if t in ("revenue", "income") else bal
            display = round(display * factor, 2)
            if display == 0:
                continue
            await db.budget_lines.update_one(
                {"company_id": cid, "budget_id": budget_id,
                 "account_id": aid, "period_key": target_pk},
                {"$set": {
                    "amount": display,
                    "account_code": a.get("code"),
                    "account_name": a.get("name"),
                    "updated_at": now,
                 },
                 "$setOnInsert": {
                    "id": str(uuid.uuid4()),
                    "company_id": cid, "budget_id": budget_id,
                    "account_id": aid, "period_key": target_pk,
                    "created_at": now,
                 }},
                upsert=True,
            )
            seeded += 1

    await db.budgets.update_one(
        {"company_id": cid, "id": budget_id},
        {"$set": {"updated_at": now,
                  "prefilled_from_year": prior,
                  "prefilled_growth_pct": growth}})
    return {"ok": True, "seeded": seeded,
            "prior_year": prior, "growth_pct": growth}


# ─── Budget vs Actuals report ────────────────────────────────────

@router.get("/companies/{cid}/reports/budget-vs-actuals")
async def budget_vs_actuals(
    cid: str,
    budget_id: str = Query(..., description="Budget to report against"),
    basis: str = Query("accrual"),
    user: dict = Depends(get_current_user),
) -> dict:
    """Variance report: for the budget's fiscal year, return one row
    per P&L account with 12 monthly triples (budget / actual /
    variance) and a full-year total triple.

    Variance sign convention:
        For revenue → actual - budget  (positive = beat)
        For expense → budget - actual  (positive = under budget)
    This way "positive is good" for every row so the frontend can
    color-code with a single rule.
    """
    await require_company(user, cid)
    if basis.lower() not in ("accrual", "cash"):
        raise HTTPException(400, "basis must be 'accrual' or 'cash'")
    budget = await db.budgets.find_one(
        {"company_id": cid, "id": budget_id})
    if not budget:
        raise HTTPException(404, "Budget not found")
    fy = int(budget["fiscal_year"])
    months = _period_keys(fy)

    # 1. Pull all lines for the budget → nested {account_id: {pk: amt}}.
    budget_map: dict[str, dict[str, float]] = defaultdict(dict)
    lines = await db.budget_lines.find(
        {"company_id": cid, "budget_id": budget_id}).to_list(20000)
    for l in lines:
        budget_map[l["account_id"]][l["period_key"]] = float(l.get("amount") or 0)

    # 2. Pull 12 monthly actuals via _signed_balances. Class/project
    # scope threads into the same filter the P&L class-slice uses so
    # numbers match to the penny.
    scope = budget.get("scope") or "company"
    scope_ref = budget.get("scope_ref_id")
    class_id = scope_ref if scope == "class" else None
    project_id = scope_ref if scope == "project" else None

    from reports import _signed_balances
    from calendar import monthrange
    actual_map: dict[str, dict[str, float]] = defaultdict(dict)
    basis_up = basis.capitalize()
    for m in range(1, 13):
        start = f"{fy:04d}-{m:02d}-01"
        last_day = monthrange(fy, m)[1]
        end = f"{fy:04d}-{m:02d}-{last_day:02d}"
        by = await _signed_balances(
            cid, start, end, basis=basis_up,
            class_id=class_id, project_id=project_id)
        pk = f"{fy:04d}-{m:02d}"
        for aid, bal in by.items():
            actual_map[aid][pk] = float(bal)

    # 3. Union of accounts touched by either budget or actuals.
    aids = set(budget_map.keys()) | set(actual_map.keys())
    accts = await db.accounts.find(
        {"company_id": cid, "id": {"$in": list(aids)}}
    ).to_list(5000) if aids else []
    accts_by_id = {a["id"]: a for a in accts}

    section_bucket = {"revenue": [], "cogs": [], "expenses": []}
    section_totals = {
        s: {"budget": [0.0] * 12, "actual": [0.0] * 12}
        for s in section_bucket
    }

    for aid in aids:
        a = accts_by_id.get(aid)
        if not a:
            continue
        t = (a.get("type") or "").lower()
        if t in ("revenue", "income"):
            section = "revenue"
        elif t == "cogs":
            section = "cogs"
        elif t == "expense":
            section = "expenses"
        else:
            continue  # skip non-P&L accounts

        month_rows = []
        for i, pk in enumerate(months):
            b = round(budget_map.get(aid, {}).get(pk, 0.0), 2)
            raw = actual_map.get(aid, {}).get(pk, 0.0)
            # Actuals: revenue is credit-normal so `by[]` returns
            # negative-for-positive-revenue. Flip so the report reads
            # positive on both sides.
            actual = round(-raw if section == "revenue" else raw, 2)
            if section == "revenue":
                variance = round(actual - b, 2)
            else:
                variance = round(b - actual, 2)
            month_rows.append({
                "period_key": pk, "budget": b,
                "actual": actual, "variance": variance,
            })
            section_totals[section]["budget"][i] += b
            section_totals[section]["actual"][i] += actual

        total_b = round(sum(r["budget"] for r in month_rows), 2)
        total_a = round(sum(r["actual"] for r in month_rows), 2)
        if section == "revenue":
            total_v = round(total_a - total_b, 2)
        else:
            total_v = round(total_b - total_a, 2)
        section_bucket[section].append({
            "account_id": aid,
            "account_code": a.get("code"),
            "account_name": a.get("name"),
            "months": month_rows,
            "total": {"budget": total_b, "actual": total_a, "variance": total_v},
        })

    # Sort rows within each section by code for a clean grouping.
    for s in section_bucket:
        section_bucket[s].sort(
            key=lambda r: str(r.get("account_code") or ""))

    def _totals_block(section: str) -> dict:
        b = section_totals[section]["budget"]
        a = section_totals[section]["actual"]
        months_arr = []
        for i in range(12):
            bv, av = round(b[i], 2), round(a[i], 2)
            if section == "revenue":
                vv = round(av - bv, 2)
            else:
                vv = round(bv - av, 2)
            months_arr.append({
                "period_key": months[i],
                "budget": bv, "actual": av, "variance": vv,
            })
        tb = round(sum(b), 2)
        ta = round(sum(a), 2)
        if section == "revenue":
            tv = round(ta - tb, 2)
        else:
            tv = round(tb - ta, 2)
        return {
            "months": months_arr,
            "total": {"budget": tb, "actual": ta, "variance": tv},
        }

    revenue_totals  = _totals_block("revenue")
    cogs_totals     = _totals_block("cogs")
    expenses_totals = _totals_block("expenses")

    # Net income variance: (revenue_actual - cogs_actual - exp_actual)
    #                     - (revenue_budget - cogs_budget - exp_budget)
    ni_actual = round(
        revenue_totals["total"]["actual"]
        - cogs_totals["total"]["actual"]
        - expenses_totals["total"]["actual"], 2)
    ni_budget = round(
        revenue_totals["total"]["budget"]
        - cogs_totals["total"]["budget"]
        - expenses_totals["total"]["budget"], 2)
    ni_var = round(ni_actual - ni_budget, 2)

    return {
        "budget": _clean(dict(budget)),
        "months": months,
        "basis": basis,
        "revenue":  {"rows": section_bucket["revenue"],  "totals": revenue_totals},
        "cogs":     {"rows": section_bucket["cogs"],     "totals": cogs_totals},
        "expenses": {"rows": section_bucket["expenses"], "totals": expenses_totals},
        "net_income": {
            "budget": ni_budget, "actual": ni_actual, "variance": ni_var,
        },
    }
