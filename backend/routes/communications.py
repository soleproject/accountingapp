"""Communications hub — settings, audit log, and every outbound email flow.

All email sending routes through `email_dispatcher.dispatch()` so:
  • Per-user prefs are always respected.
  • Every attempt (sent / skipped / failed) is auditable at
    `GET /api/companies/{cid}/communications`.
  • Failures surface via a 502 to the caller so the UI can toast.

Public route: `GET /api/q/{token}` + `POST /api/q/{token}/answer` — no
auth, used by the client owner to reply to an "ask-client" question.
"""
from __future__ import annotations

import asyncio
import os
import secrets
from datetime import datetime, timezone, timedelta
from typing import Optional, List

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, EmailStr

from db import db, now_iso, coerce
from auth import get_current_user, require_role

from email_dispatcher import (
    dispatch, get_prefs, set_prefs, public_base_url, DEFAULT_PREFS,
)
import email_templates as tmpl

router = APIRouter(prefix="/api")


# --------------------------------------------------------------------------
# Preferences
# --------------------------------------------------------------------------
class PrefsPatch(BaseModel):
    daily_pro_digest:    Optional[bool] = None
    ask_client:          Optional[bool] = None
    dunning:             Optional[bool] = None
    overdue_bill_client: Optional[bool] = None
    plaid_reauth:        Optional[bool] = None
    onboarding_followup: Optional[bool] = None
    month_close_signoff: Optional[bool] = None
    from_name:           Optional[str]  = None


@router.get("/settings/communications")
async def get_my_prefs(user: dict = Depends(get_current_user)):
    return await get_prefs(user["id"])


@router.put("/settings/communications")
async def update_my_prefs(patch: PrefsPatch, user: dict = Depends(get_current_user)):
    return await set_prefs(user["id"], patch.model_dump(exclude_none=True))


# --------------------------------------------------------------------------
# Audit log (inbox view)
# --------------------------------------------------------------------------
@router.get("/companies/{cid}/communications")
async def list_communications(
    cid: str,
    limit: int = Query(200, ge=1, le=1000),
    kind: Optional[str] = None,
    status: Optional[str] = None,
    user: dict = Depends(get_current_user),
):
    """List sent/failed/skipped emails for a company, newest first."""
    q: dict = {"company_id": cid}
    if kind:   q["kind"]   = kind
    if status: q["status"] = status
    docs = await db.communications.find(q).sort("sent_at", -1).limit(limit).to_list(limit)
    return {"items": [coerce(d) for d in docs]}


@router.get("/communications/mine")
async def list_my_communications(
    limit: int = Query(50, ge=1, le=500),
    user: dict = Depends(get_current_user),
):
    """Cross-company inbox for a user (Pro or admin) — every email they
    triggered across all their clients."""
    docs = await db.communications.find(
        {"user_id": user["id"]}
    ).sort("sent_at", -1).limit(limit).to_list(limit)
    return {"items": [coerce(d) for d in docs]}


# --------------------------------------------------------------------------
# 1. Ask-client-about-a-transaction  (Pro → Client owner, magic-link reply)
# --------------------------------------------------------------------------
class AskClientIn(BaseModel):
    txn_id: str
    question: str
    to: Optional[EmailStr] = None  # override if the txn's contact has no email


class AskClientBatchIn(BaseModel):
    """Ask about MULTIPLE transactions in a single email. Client sees a
    table of the txns on the magic-link page; their answer is applied to
    every listed txn."""
    txn_ids: List[str]
    question: str
    counterparty_label: Optional[str] = None  # for the subject line
    to: Optional[EmailStr] = None


class SuggestBatchIn(BaseModel):
    """Optional filters when generating suggestions."""
    max_groups: int = 8
    min_group_size: int = 1


async def _resolve_client_email(cid: str) -> tuple[Optional[str], str]:
    """Return `(email, display_name)` for the client-owner of a company.
    Falls back to the company's `contact_email` if no owner membership exists."""
    m = await db.memberships.find_one({"company_id": cid, "role": "owner"})
    if m:
        u = await db.users.find_one({"id": m["user_id"]})
        if u:
            return u.get("email"), (u.get("full_name") or u.get("email") or "there")
    c = await db.companies.find_one({"id": cid})
    if c and c.get("contact_email"):
        return c["contact_email"], (c.get("contact_name") or c.get("name") or "there")
    return None, "there"


@router.post("/companies/{cid}/transactions/{tid}/ask-client")
async def ask_client_about_txn(
    cid: str, tid: str, inp: AskClientIn,
    user: dict = Depends(require_role("pro", "superadmin")),
):
    if inp.txn_id != tid:
        raise HTTPException(400, "Path txn id does not match body txn_id.")
    txn = await db.transactions.find_one({"id": tid, "company_id": cid})
    if not txn:
        raise HTTPException(404, "Transaction not found.")
    company = await db.companies.find_one({"id": cid})
    if not company:
        raise HTTPException(404, "Company not found.")

    to_email = str(inp.to) if inp.to else None
    if not to_email:
        to_email, _client_name = await _resolve_client_email(cid)
    if not to_email:
        raise HTTPException(400, "No client email on file — set one on the company profile or pass `to`.")

    token = secrets.token_urlsafe(24)
    expires = (datetime.now(timezone.utc) + timedelta(days=30)).isoformat()
    q_doc = {
        "id": token,   # token IS the id, used as the magic-link path
        "company_id": cid, "txn_id": tid,
        "txn_ids": [tid],   # array form for batched flow parity
        "asked_by_user_id": user["id"],
        "asked_by_name": user.get("full_name") or user.get("email"),
        "question": inp.question,
        "status": "pending",
        "answer": None,
        "sent_at": now_iso(),
        "expires_at": expires,
        "to_email": to_email,
    }
    await db.client_questions.insert_one(q_doc)

    # Mark the txn as needs_review with the question inline so the pro sees
    # it in the UI even before the client responds.
    await db.transactions.update_one(
        {"id": tid, "company_id": cid},
        {"$set": {
            "needs_review": True,
            "ai_comment": (txn.get("ai_comment") or "") + f"\n\n[Asked client on {now_iso()[:10]}]: {inp.question}",
            "client_question_id": token,
            "updated_at": now_iso(),
        }},
    )

    _, client_name = await _resolve_client_email(cid)
    magic_url = f"{public_base_url()}/q/{token}"
    subject, html = tmpl.ask_client(
        pro_name=user.get("full_name") or user.get("email") or "Your accountant",
        company_name=company.get("name") or "",
        txn=txn,
        question=inp.question,
        magic_url=magic_url,
    )
    result = await dispatch(
        kind="ask_client",
        to=to_email,
        subject=subject,
        html=html,
        initiating_user_id=user["id"],
        company_id=cid,
        related={"txn_id": tid, "question_id": token},
    )
    if result["status"] == "failed":
        raise HTTPException(502, result.get("error") or "Email send failed")
    return {"status": result["status"], "question_id": token, "communication_id": result["id"]}


# --------------------------------------------------------------------------
# AI-suggested batching — cluster flagged txns by counterparty so the pro
# sends ONE email per merchant instead of one per transaction.
# --------------------------------------------------------------------------
@router.post("/companies/{cid}/communications/ask-client/suggest")
async def suggest_ask_client_batches(
    cid: str,
    inp: SuggestBatchIn = None,
    user: dict = Depends(require_role("pro", "superadmin")),
):
    """Return clusters of currently-flagged transactions grouped by
    counterparty, each with an AI-drafted question ready to send.

    Skips any txn that already has a pending client_question so the pro
    isn't offered to ask twice about the same charge.
    """
    from collections import defaultdict
    from ai_service import draft_ask_client_question
    inp = inp or SuggestBatchIn()

    # Fetch flagged, still-open txns.
    txns = await db.transactions.find({
        "company_id": cid,
        "$or": [
            {"needs_review": True},
            {"ai_confidence": {"$lt": 0.6}, "human_reviewed": {"$ne": True}},
        ],
        "client_question_id": {"$in": [None, ""]},
    }).sort("date", -1).to_list(500)

    # Also exclude any txn already covered by a pending client_question.
    pending_qs = await db.client_questions.find({
        "company_id": cid, "status": "pending",
    }, {"txn_ids": 1, "txn_id": 1}).to_list(500)
    covered_ids: set[str] = set()
    for q in pending_qs:
        for x in (q.get("txn_ids") or []):
            covered_ids.add(x)
        if q.get("txn_id"):
            covered_ids.add(q["txn_id"])
    txns = [t for t in txns if t["id"] not in covered_ids]

    # Cluster by contact_name if present, else a normalized merchant/description.
    def _key(t: dict) -> str:
        if t.get("contact_name"):
            return t["contact_name"]
        m = (t.get("merchant") or t.get("description") or "").strip()
        return m.split(" ")[0].upper()[:40] if m else "UNKNOWN"

    groups: dict[str, list[dict]] = defaultdict(list)
    for t in txns:
        groups[_key(t)].append(t)

    # Rank groups: bigger clusters first, then bigger absolute totals.
    ranked = sorted(
        groups.items(),
        key=lambda kv: (len(kv[1]), sum(abs(float(x.get("amount") or 0)) for x in kv[1])),
        reverse=True,
    )
    ranked = [(k, v) for k, v in ranked if len(v) >= max(1, inp.min_group_size)]
    ranked = ranked[: max(1, inp.max_groups)]

    company = await db.companies.find_one({"id": cid})
    company_name = (company or {}).get("name") or ""

    # Draft questions in parallel (Claude calls, bounded to `max_groups`).
    async def _draft(k: str, ts: list[dict]) -> dict:
        q = await draft_ask_client_question(
            counterparty=k, txns=ts, company_name=company_name,
        )
        total = round(sum(float(x.get("amount") or 0) for x in ts), 2)
        return {
            "counterparty": k,
            "txn_ids": [t["id"] for t in ts],
            "count": len(ts),
            "total": total,
            "draft_question": q,
            "sample_txns": [
                {
                    "id": t["id"], "date": t.get("date"),
                    "description": t.get("description"),
                    "amount": t.get("amount"),
                }
                for t in ts[:5]
            ],
        }
    suggestions = await asyncio.gather(*[_draft(k, v) for k, v in ranked]) if ranked else []
    return {
        "suggestions": suggestions,
        "flagged_total": len(txns),
        "already_asked_total": len(covered_ids),
    }


@router.post("/companies/{cid}/communications/ask-client/batch")
async def ask_client_batch(
    cid: str, inp: AskClientBatchIn,
    user: dict = Depends(require_role("pro", "superadmin")),
):
    """Send ONE email covering multiple transactions from the same
    counterparty. Client's single reply applies to every listed txn."""
    if not inp.txn_ids:
        raise HTTPException(400, "txn_ids is required.")
    txns = await db.transactions.find(
        {"id": {"$in": inp.txn_ids}, "company_id": cid}
    ).sort("date", 1).to_list(200)
    if not txns:
        raise HTTPException(404, "None of the txns were found.")

    company = await db.companies.find_one({"id": cid})
    to_email = str(inp.to) if inp.to else None
    if not to_email:
        to_email, _ = await _resolve_client_email(cid)
    if not to_email:
        raise HTTPException(400, "No client email on file — set one on the company profile or pass `to`.")

    token = secrets.token_urlsafe(24)
    expires = (datetime.now(timezone.utc) + timedelta(days=30)).isoformat()
    q_doc = {
        "id": token,
        "company_id": cid,
        "txn_id": txns[0]["id"],  # legacy single-value
        "txn_ids": [t["id"] for t in txns],
        "asked_by_user_id": user["id"],
        "asked_by_name": user.get("full_name") or user.get("email"),
        "question": inp.question,
        "status": "pending",
        "answer": None,
        "sent_at": now_iso(),
        "expires_at": expires,
        "to_email": to_email,
        "counterparty_label": inp.counterparty_label or "",
    }
    await db.client_questions.insert_one(q_doc)

    # Stamp every txn with the same question_id + review flag.
    await db.transactions.update_many(
        {"id": {"$in": [t["id"] for t in txns]}, "company_id": cid},
        {"$set": {
            "needs_review": True,
            "client_question_id": token,
            "updated_at": now_iso(),
        }},
    )

    _, client_name = await _resolve_client_email(cid)
    magic_url = f"{public_base_url()}/q/{token}"
    subject, html = tmpl.ask_client_batch(
        pro_name=user.get("full_name") or user.get("email") or "Your accountant",
        company_name=(company or {}).get("name") or "",
        counterparty=inp.counterparty_label or "these transactions",
        txns=txns,
        question=inp.question,
        magic_url=magic_url,
    )
    result = await dispatch(
        kind="ask_client",  # uses the same pref as single-txn ask-client
        to=to_email,
        subject=subject,
        html=html,
        initiating_user_id=user["id"],
        company_id=cid,
        related={"txn_ids": [t["id"] for t in txns], "question_id": token, "batched": True},
    )
    if result["status"] == "failed":
        raise HTTPException(502, result.get("error") or "Email send failed")
    return {
        "status": result["status"], "question_id": token,
        "communication_id": result["id"], "txn_count": len(txns),
    }


# ---- Public magic-link endpoints (no auth) ------------------------------
@router.get("/q/{token}")
async def public_get_question(token: str):
    q = await db.client_questions.find_one({"id": token})
    if not q:
        raise HTTPException(404, "Question not found or expired.")
    tx_ids = q.get("txn_ids") or ([q["txn_id"]] if q.get("txn_id") else [])
    txns = await db.transactions.find({"id": {"$in": tx_ids}}).sort("date", 1).to_list(200) if tx_ids else []
    company = await db.companies.find_one({"id": q.get("company_id")})
    tx_list = [
        {"id": t.get("id"), "date": t.get("date"),
         "description": t.get("description"), "amount": t.get("amount")}
        for t in txns
    ]
    return {
        "question": q.get("question"),
        "status": q.get("status"),
        "answer": q.get("answer"),
        "asked_by_name": q.get("asked_by_name"),
        "sent_at": q.get("sent_at"),
        "answered_at": q.get("answered_at"),
        "expires_at": q.get("expires_at"),
        "company_name": (company or {}).get("name"),
        "counterparty_label": q.get("counterparty_label"),
        "batched": len(tx_list) > 1,
        # Legacy single-txn key retained for older frontend callers.
        "txn": tx_list[0] if tx_list else None,
        "txns": tx_list,
    }


class AnswerIn(BaseModel):
    answer: str


@router.post("/q/{token}/answer")
async def public_answer_question(token: str, inp: AnswerIn):
    q = await db.client_questions.find_one({"id": token})
    if not q:
        raise HTTPException(404, "Question not found.")
    if q.get("status") == "answered":
        raise HTTPException(400, "This question has already been answered.")
    expires = q.get("expires_at")
    if expires and expires < now_iso():
        await db.client_questions.update_one({"id": token}, {"$set": {"status": "expired"}})
        raise HTTPException(410, "This link has expired.")
    ans = (inp.answer or "").strip()
    if not ans:
        raise HTTPException(400, "Answer is required.")
    now = now_iso()
    await db.client_questions.update_one(
        {"id": token},
        {"$set": {"status": "answered", "answer": ans, "answered_at": now}},
    )
    tx_ids = q.get("txn_ids") or ([q["txn_id"]] if q.get("txn_id") else [])
    if tx_ids:
        # Apply the answer to every txn in the batch. Each txn gets an
        # ai_comment note so the pro sees the audit trail per-row without
        # having to fetch the client_question doc.
        existing = await db.transactions.find(
            {"id": {"$in": tx_ids}, "company_id": q.get("company_id")}
        ).to_list(200)
        for t in existing:
            new_comment = (t.get("ai_comment") or "") + f"\n[Client answered {now[:10]}]: {ans}"
            await db.transactions.update_one(
                {"id": t["id"]},
                {"$set": {
                    "client_answer": ans,
                    "client_answered_at": now,
                    "ai_comment": new_comment,
                    "updated_at": now,
                }},
            )
    return {"status": "answered", "txn_count": len(tx_ids)}


# --------------------------------------------------------------------------
# 2. Daily Pro digest — send now for a specific pro (or all of them)
# --------------------------------------------------------------------------
async def _digest_for_pro(pro_user: dict) -> dict:
    """Fetch every company this pro manages, roll up the attention numbers,
    and email the pro the Needs-Attention summary."""
    from routes.ai_ops import _compute_attention
    memberships = await db.memberships.find({"user_id": pro_user["id"]}).to_list(500)
    cids = [m["company_id"] for m in memberships]
    if not cids:
        return {"status": "skipped_no_companies"}
    companies = await db.companies.find({"id": {"$in": cids}}).to_list(500)
    attn = await asyncio.gather(*[_compute_attention(c["id"]) for c in companies])
    per_company = []
    firm_totals = {k: 0 for k in ("flagged_count", "overdue_invoices_count",
                                   "overdue_bills_count", "unreconciled_accounts_count")}
    for c, a in zip(companies, attn):
        row = {"name": c.get("name"), **{k: a.get(k, 0) for k in firm_totals}}
        per_company.append(row)
        for k in firm_totals:
            firm_totals[k] += a.get(k, 0)
    subject, html = tmpl.daily_pro_digest(
        pro_name=pro_user.get("full_name") or pro_user.get("email") or "there",
        companies=per_company,
        firm_totals=firm_totals,
        app_url=public_base_url(),
    )
    return await dispatch(
        kind="daily_pro_digest",
        to=pro_user["email"], subject=subject, html=html,
        initiating_user_id=pro_user["id"],
    )


@router.post("/communications/daily-digest/run")
async def run_daily_digest(
    for_user_id: Optional[str] = Query(None),
    user: dict = Depends(require_role("pro", "superadmin")),
):
    """Send the digest immediately. Pro users get it for themselves;
    superadmins can pass `for_user_id` to target any pro, or omit to blast
    all pros (this is what a scheduled cron would call)."""
    if user["role"] == "pro":
        return await _digest_for_pro(user)
    # Superadmin path
    if for_user_id:
        target = await db.users.find_one({"id": for_user_id})
        if not target:
            raise HTTPException(404, "User not found.")
        return await _digest_for_pro(target)
    pros = await db.users.find({"role": "pro"}).to_list(500)
    results = await asyncio.gather(*[_digest_for_pro(p) for p in pros])
    return {"sent_to_pros": len(pros), "results": results}


# --------------------------------------------------------------------------
# 3-7. Bulk triggers (overdue A/R dunning, overdue A/P client alert,
#      Plaid re-auth, onboarding followup, month-close signoff request).
# One endpoint per flow, targeted to a single object where relevant.
# --------------------------------------------------------------------------
class DunningIn(BaseModel):
    invoice_id: str
    to: Optional[EmailStr] = None


@router.post("/companies/{cid}/communications/dunning")
async def send_dunning(cid: str, inp: DunningIn, user: dict = Depends(require_role("pro", "superadmin"))):
    inv = await db.invoices.find_one({"id": inp.invoice_id, "company_id": cid})
    if not inv:
        raise HTTPException(404, "Invoice not found.")
    contact = None
    if inv.get("contact_id"):
        contact = await db.contacts.find_one({"id": inv["contact_id"], "company_id": cid})
    to_email = str(inp.to) if inp.to else (contact or {}).get("email")
    if not to_email:
        raise HTTPException(400, "No email on the customer contact — pass `to` explicitly.")
    company = await db.companies.find_one({"id": cid})
    due = inv.get("due_date") or ""
    try:
        d_due = datetime.fromisoformat(due).date() if due else datetime.now(timezone.utc).date()
    except ValueError:
        d_due = datetime.now(timezone.utc).date()
    days_late = max(0, (datetime.now(timezone.utc).date() - d_due).days)
    subject, html = tmpl.dunning(
        contact_name=(contact or {}).get("display_name") or "there",
        company_name=(company or {}).get("name") or "",
        invoice=inv, days_late=days_late, app_url=public_base_url(),
    )
    result = await dispatch(
        kind="dunning", to=to_email, subject=subject, html=html,
        initiating_user_id=user["id"], company_id=cid,
        contact_id=(contact or {}).get("id"),
        related={"invoice_id": inp.invoice_id, "days_late": days_late},
    )
    if result["status"] == "failed":
        raise HTTPException(502, result.get("error") or "Send failed")
    return result


@router.post("/companies/{cid}/communications/overdue-bills-client")
async def send_overdue_bills_client(cid: str, user: dict = Depends(require_role("pro", "superadmin"))):
    today = datetime.now(timezone.utc).date().isoformat()
    bills = await db.bills.find({
        "company_id": cid, "status": {"$ne": "paid"},
        "due_date": {"$lt": today, "$ne": None},
    }).to_list(200)
    if not bills:
        return {"status": "skipped_no_overdue"}
    to_email, client_name = await _resolve_client_email(cid)
    if not to_email:
        raise HTTPException(400, "No client email on file for this company.")
    company = await db.companies.find_one({"id": cid})
    subject, html = tmpl.overdue_bill_client(
        client_name=client_name, company_name=(company or {}).get("name") or "",
        bills=bills, app_url=public_base_url(),
    )
    result = await dispatch(
        kind="overdue_bill_client", to=to_email, subject=subject, html=html,
        initiating_user_id=user["id"], company_id=cid,
        related={"bill_ids": [b["id"] for b in bills], "count": len(bills)},
    )
    if result["status"] == "failed":
        raise HTTPException(502, result.get("error") or "Send failed")
    return result


class PlaidReauthIn(BaseModel):
    plaid_item_id: str


@router.post("/companies/{cid}/communications/plaid-reauth")
async def send_plaid_reauth(cid: str, inp: PlaidReauthIn, user: dict = Depends(require_role("pro", "superadmin"))):
    item = await db.plaid_items.find_one({"id": inp.plaid_item_id, "company_id": cid})
    if not item:
        raise HTTPException(404, "Plaid item not found.")
    to_email, client_name = await _resolve_client_email(cid)
    if not to_email:
        raise HTTPException(400, "No client email on file for this company.")
    company = await db.companies.find_one({"id": cid})
    subject, html = tmpl.plaid_reauth(
        client_name=client_name, company_name=(company or {}).get("name") or "",
        institution=item.get("institution_name") or "your bank",
        app_url=public_base_url(),
    )
    result = await dispatch(
        kind="plaid_reauth", to=to_email, subject=subject, html=html,
        initiating_user_id=user["id"], company_id=cid,
        related={"plaid_item_id": inp.plaid_item_id},
    )
    if result["status"] == "failed":
        raise HTTPException(502, result.get("error") or "Send failed")
    return result


class OnboardingFollowupIn(BaseModel):
    next_step_label: Optional[str] = None


@router.post("/companies/{cid}/communications/onboarding-followup")
async def send_onboarding_followup(cid: str, inp: OnboardingFollowupIn, user: dict = Depends(require_role("pro", "superadmin"))):
    to_email, client_name = await _resolve_client_email(cid)
    if not to_email:
        raise HTTPException(400, "No client email on file for this company.")
    company = await db.companies.find_one({"id": cid})
    # Pull the next incomplete step from onboarding_state if available.
    step = inp.next_step_label
    if not step:
        ob = await db.onboarding_state.find_one({"company_id": cid})
        if ob and (ob.get("steps") or []):
            first_incomplete = next((s for s in ob["steps"] if not s.get("done")), None)
            step = (first_incomplete or {}).get("label") or "Complete your onboarding"
    subject, html = tmpl.onboarding_followup(
        client_name=client_name, company_name=(company or {}).get("name") or "",
        next_step_label=step or "Complete your onboarding",
        app_url=public_base_url(),
    )
    result = await dispatch(
        kind="onboarding_followup", to=to_email, subject=subject, html=html,
        initiating_user_id=user["id"], company_id=cid,
        related={"next_step": step},
    )
    if result["status"] == "failed":
        raise HTTPException(502, result.get("error") or "Send failed")
    return result


class SignoffIn(BaseModel):
    ym: str  # "2026-07"


@router.post("/companies/{cid}/communications/month-close-signoff")
async def send_month_close_signoff(cid: str, inp: SignoffIn, user: dict = Depends(require_role("pro", "superadmin"))):
    to_email, client_name = await _resolve_client_email(cid)
    if not to_email:
        raise HTTPException(400, "No client email on file for this company.")
    company = await db.companies.find_one({"id": cid})
    try:
        y, m = inp.ym.split("-")
        month_label = datetime(int(y), int(m), 1).strftime("%B %Y")
    except Exception:
        month_label = inp.ym
    subject, html = tmpl.month_close_signoff(
        client_name=client_name, company_name=(company or {}).get("name") or "",
        month_label=month_label, app_url=public_base_url(),
    )
    result = await dispatch(
        kind="month_close_signoff", to=to_email, subject=subject, html=html,
        initiating_user_id=user["id"], company_id=cid,
        related={"ym": inp.ym},
    )
    if result["status"] == "failed":
        raise HTTPException(502, result.get("error") or "Send failed")
    return result
