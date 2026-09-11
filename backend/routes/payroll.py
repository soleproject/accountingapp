"""SmartBooks — Payroll HTTP routes (Phase 1).

Endpoints (all under `/api/companies/{cid}/payroll`):
  GET    /runs                  — list runs, newest first
  POST   /runs                  — create draft run
  GET    /runs/{id}             — run + its stubs
  PATCH  /runs/{id}             — edit meta (dates, memo) while draft
  DELETE /runs/{id}             — delete a draft run + its stubs
  POST   /runs/{id}/stubs       — upsert a stub
  DELETE /runs/{id}/stubs/{sid} — remove a stub
  POST   /runs/{id}/finalize    — post the JE, create Print Check rows
  POST   /auto-match            — sweep unmatched ACH stubs → bank txns
  GET    /employees/{eid}/history — stub history for an employee
  GET    /summary               — dashboard rollup (this month + YTD)
"""

from __future__ import annotations

from typing import Optional, List
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel

from db import db, now_iso
from routes.auth import get_current_user, require_company
import payroll_service as ps


router = APIRouter(prefix="/api", tags=["payroll"])


# ── Pydantic models ────────────────────────────────────────────────

class RunIn(BaseModel):
    period_start: str
    period_end: str
    pay_date: str
    memo: Optional[str] = ""


class RunPatch(BaseModel):
    period_start: Optional[str] = None
    period_end: Optional[str] = None
    pay_date: Optional[str] = None
    memo: Optional[str] = None


class StubLine(BaseModel):
    kind: str       # earning | ee_tax | ee_deduction | er_tax | er_benefit
    label: str
    amount: float


class StubIn(BaseModel):
    id: Optional[str] = None
    employee_id: Optional[str] = None
    employee_name: str
    contact_id: Optional[str] = None
    kind: str = "w2"
    mode: str = "simple"
    payment_method: str = "ach"
    check_number: Optional[int] = None
    gross: Optional[float] = None
    net: Optional[float] = None
    lines: Optional[List[StubLine]] = None
    memo: Optional[str] = ""


class FinalizeIn(BaseModel):
    bank_account_id: str


class LiabilityPayIn(BaseModel):
    run_id: str
    bank_account_id: str
    ee_tax: float = 0.0
    er_tax: float = 0.0
    er_ben: float = 0.0
    ee_ded: float = 0.0
    date: Optional[str] = None
    agency: Optional[str] = ""
    memo: Optional[str] = ""
    code_payments: Optional[List[dict]] = None


# ── Helpers ────────────────────────────────────────────────────────

def _strip(obj: dict) -> dict:
    return {k: v for k, v in obj.items() if k != "_id"}


async def _stubs_for(cid: str, run_id: str) -> list[dict]:
    rows = await db.payroll_stubs.find(
        {"company_id": cid, "run_id": run_id}
    ).sort("employee_name", 1).to_list(500)
    return [_strip(r) for r in rows]


# ── Routes ─────────────────────────────────────────────────────────

@router.get("/companies/{cid}/payroll/runs")
async def list_runs(cid: str, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    rows = await db.payroll_runs.find(
        {"company_id": cid}
    ).sort("pay_date", -1).to_list(500)
    return {"runs": [_strip(r) for r in rows]}


@router.post("/companies/{cid}/payroll/runs")
async def create_run(cid: str, inp: RunIn, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    doc = await ps.create_run(cid, inp.period_start, inp.period_end,
                              inp.pay_date, inp.memo or "")
    return {"ok": True, "run": _strip(doc)}


@router.get("/companies/{cid}/payroll/runs/{run_id}")
async def get_run(cid: str, run_id: str, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    r = await db.payroll_runs.find_one({"id": run_id, "company_id": cid})
    if not r:
        raise HTTPException(404, "Run not found")
    stubs = await _stubs_for(cid, run_id)
    return {"run": _strip(r), "stubs": stubs}


@router.patch("/companies/{cid}/payroll/runs/{run_id}")
async def patch_run(cid: str, run_id: str, inp: RunPatch,
                    user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    r = await db.payroll_runs.find_one({"id": run_id, "company_id": cid})
    if not r:
        raise HTTPException(404, "Run not found")
    if r.get("status") != "draft":
        raise HTTPException(400, "Run is finalized — cannot edit")
    upd = {k: v for k, v in inp.model_dump().items() if v is not None}
    upd["updated_at"] = now_iso()
    await db.payroll_runs.update_one({"id": run_id, "company_id": cid}, {"$set": upd})
    return {"ok": True}


@router.delete("/companies/{cid}/payroll/runs/{run_id}")
async def delete_run(cid: str, run_id: str, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    r = await db.payroll_runs.find_one({"id": run_id, "company_id": cid})
    if not r:
        raise HTTPException(404, "Run not found")
    if r.get("status") != "draft":
        raise HTTPException(400, "Finalized runs cannot be deleted — void instead")
    await db.payroll_stubs.delete_many({"company_id": cid, "run_id": run_id})
    await db.payroll_runs.delete_one({"id": run_id, "company_id": cid})
    return {"ok": True}


@router.post("/companies/{cid}/payroll/runs/{run_id}/stubs")
async def upsert_stub(cid: str, run_id: str, inp: StubIn,
                      user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    payload = inp.model_dump()
    payload["lines"] = [l.model_dump() if hasattr(l, "model_dump") else l
                        for l in (payload.get("lines") or [])]
    try:
        doc = await ps.upsert_stub(cid, run_id, payload)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"ok": True, "stub": _strip(doc)}


@router.delete("/companies/{cid}/payroll/runs/{run_id}/stubs/{sid}")
async def delete_stub(cid: str, run_id: str, sid: str,
                      user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    try:
        await ps.delete_stub(cid, run_id, sid)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"ok": True}


@router.post("/companies/{cid}/payroll/runs/{run_id}/finalize")
async def finalize_run(cid: str, run_id: str, inp: FinalizeIn,
                       user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    try:
        out = await ps.finalize_run(cid, run_id, inp.bank_account_id)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"ok": True, **out}


@router.post("/companies/{cid}/payroll/auto-match")
async def auto_match(cid: str, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    out = await ps.auto_match(cid)
    return {"ok": True, **out}


@router.get("/companies/{cid}/payroll/employees/{eid}/history")
async def employee_history(cid: str, eid: str,
                           user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    return await ps.employee_history(cid, eid)


@router.get("/companies/{cid}/payroll/liabilities")
async def liabilities(cid: str, user: dict = Depends(get_current_user)):
    """Payroll liability aging — one row per finalized run with an
    outstanding balance, plus the running totals across the whole
    company. Mirrors the shape of the Sales Tax aging response so the
    frontend can reuse patterns.
    """
    await require_company(user, cid)
    return await ps.liability_aging(cid)


@router.post("/companies/{cid}/payroll/liabilities/pay")
async def pay_liability(cid: str, inp: LiabilityPayIn,
                        user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    try:
        out = await ps.pay_liability(
            cid, inp.run_id, inp.bank_account_id,
            ee_tax=inp.ee_tax, er_tax=inp.er_tax,
            er_ben=inp.er_ben, ee_ded=inp.ee_ded,
            date=inp.date or "", agency=inp.agency or "",
            memo=inp.memo or "",
            code_payments=inp.code_payments or None,
        )
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"ok": True, **out}


@router.get("/companies/{cid}/payroll/tax-codes")
async def tax_codes(cid: str, state: Optional[str] = None,
                    user: dict = Depends(get_current_user)):
    """Return the curated tax-code catalog scoped by state. `state` is
    two-letter (CA, NY, ...); missing/unknown → Federal only, plus the
    full `all_states` menu so the UI can offer a preset picker."""
    await require_company(user, cid)
    from payroll_tax_codes import catalog
    return catalog(state)


@router.get("/companies/{cid}/payroll/stubs/{sid}/pdf")
async def stub_pdf(cid: str, sid: str,
                   user: dict = Depends(get_current_user)):
    """Render a one-page pay stub PDF. Reuses the SimpleDocTemplate
    plumbing pattern already used for invoice / bill PDFs."""
    from fastapi.responses import Response
    await require_company(user, cid)
    stub = await db.payroll_stubs.find_one({"id": sid, "company_id": cid})
    if not stub:
        raise HTTPException(404, "Stub not found")
    run  = await db.payroll_runs.find_one({"id": stub.get("run_id"), "company_id": cid})
    if not run:
        raise HTTPException(404, "Run not found")
    company = await db.companies.find_one({"id": cid}) or {}
    pdf_bytes = ps.build_stub_pdf(stub=_strip(stub), run=_strip(run),
                                  company=_strip(company))
    fname = f"paystub-{(stub.get('employee_name') or 'employee').replace(' ', '_')}-{run.get('pay_date') or ''}.pdf"
    return Response(content=pdf_bytes, media_type="application/pdf",
                    headers={"Content-Disposition": f'inline; filename="{fname}"'})


@router.get("/companies/{cid}/payroll/summary")
async def summary(cid: str, user: dict = Depends(get_current_user)):
    """Dashboard rollup: current-month totals, unmatched count, YTD."""
    await require_company(user, cid)
    now = datetime.now(timezone.utc)
    month_start = now.strftime("%Y-%m-01")
    year_start  = now.strftime("%Y-01-01")

    runs = await db.payroll_runs.find({"company_id": cid}).to_list(1000)
    finalized = [r for r in runs if r.get("status") == "finalized"]
    drafts    = [r for r in runs if r.get("status") == "draft"]

    def _tot(runs_):
        agg = {"gross": 0.0, "ee_tax": 0.0, "ee_ded": 0.0,
               "er_tax": 0.0, "er_ben": 0.0, "net": 0.0}
        for r in runs_:
            t = r.get("totals") or {}
            for k in agg:
                agg[k] += float(t.get(k) or 0)
        return {k: round(v, 2) for k, v in agg.items()}

    mtd = _tot([r for r in finalized if (r.get("pay_date") or "") >= month_start])
    ytd = _tot([r for r in finalized if (r.get("pay_date") or "") >= year_start])

    unmatched = await db.payroll_stubs.count_documents({
        "company_id": cid,
        "match_txn_id": None,
        "payment_method": "ach",
    })

    return {
        "runs_finalized": len(finalized),
        "runs_draft":     len(drafts),
        "mtd": mtd,
        "ytd": ytd,
        "unmatched_ach_stubs": unmatched,
        "recent_runs": [_strip(r) for r in sorted(
            finalized, key=lambda r: r.get("pay_date") or "", reverse=True
        )[:5]],
    }
