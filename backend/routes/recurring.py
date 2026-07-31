"""Axiom Ledger — Recurring templates (memorized invoices / bills)."""
from __future__ import annotations
from datetime import date

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional

from db import db, coerce
from auth import get_current_user
from deps import require_company
import recurring_service as rsvc

router = APIRouter(prefix="/api")


class RecurringTemplateIn(BaseModel):
    kind: str  # "invoice" | "bill"
    frequency: str  # weekly | monthly | quarterly | annual
    start_date: str
    end_date: Optional[str] = None
    contact_id: Optional[str] = None
    contact_name: Optional[str] = ""
    line_items: list
    tax: float = 0.0
    notes: Optional[str] = ""
    memo: Optional[str] = ""
    net_days: int = 30
    status_on_generate: Optional[str] = "draft"
    paused: bool = False
    created_from_id: Optional[str] = None
    name: Optional[str] = None


class RecurringTemplatePatch(BaseModel):
    frequency: Optional[str] = None
    start_date: Optional[str] = None
    end_date: Optional[str] = None
    contact_id: Optional[str] = None
    contact_name: Optional[str] = None
    line_items: Optional[list] = None
    tax: Optional[float] = None
    notes: Optional[str] = None
    memo: Optional[str] = None
    net_days: Optional[int] = None
    status_on_generate: Optional[str] = None
    paused: Optional[bool] = None
    name: Optional[str] = None


@router.get("/companies/{cid}/recurring")
async def list_recurring(cid: str, kind: Optional[str] = None, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    q: dict = {"company_id": cid}
    if kind in rsvc.KINDS:
        q["kind"] = kind
    docs = await db.recurring_templates.find(q).sort("next_run_date", 1).to_list(500)
    return {"templates": [coerce(d) for d in docs]}


@router.post("/companies/{cid}/recurring")
async def create_recurring(cid: str, inp: RecurringTemplateIn, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    try:
        doc = await rsvc.create_template(cid, user["id"], inp.model_dump())
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"template": doc}


@router.patch("/companies/{cid}/recurring/{tid}")
async def update_recurring(cid: str, tid: str, patch: RecurringTemplatePatch, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    payload = {k: v for k, v in patch.model_dump().items() if v is not None}
    try:
        doc = await rsvc.update_template(cid, tid, payload)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if not doc:
        raise HTTPException(status_code=404, detail="Template not found")
    return {"template": doc}


@router.post("/companies/{cid}/recurring/{tid}/pause")
async def pause_recurring(cid: str, tid: str, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    doc = await rsvc.update_template(cid, tid, {"paused": True})
    if not doc:
        raise HTTPException(status_code=404, detail="Template not found")
    return {"template": doc}


@router.post("/companies/{cid}/recurring/{tid}/resume")
async def resume_recurring(cid: str, tid: str, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    doc = await rsvc.update_template(cid, tid, {"paused": False})
    if not doc:
        raise HTTPException(status_code=404, detail="Template not found")
    return {"template": doc}


@router.post("/companies/{cid}/recurring/{tid}/run-now")
async def run_now(cid: str, tid: str, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    t = await db.recurring_templates.find_one({"id": tid, "company_id": cid})
    if not t:
        raise HTTPException(status_code=404, detail="Template not found")
    new_id = await rsvc.generate_from_template(t, run_date=date.today())
    return {"id": new_id, "kind": t["kind"]}


@router.delete("/companies/{cid}/recurring/{tid}")
async def delete_recurring(cid: str, tid: str, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    await db.recurring_templates.delete_one({"id": tid, "company_id": cid})
    return {"ok": True}
