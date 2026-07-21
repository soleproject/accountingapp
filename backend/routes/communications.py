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
import uuid
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
    ai_ask_client:       Optional[bool] = None
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
        "flow_type": "pro_ask_client",
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
        "flow_type": "pro_ask_client",
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
        "txn": tx_list[0] if tx_list else None,
        "txns": tx_list,
        "chat_messages": q.get("chat_messages") or [],
    }


class AnswerIn(BaseModel):
    answer: str


class ChatIn(BaseModel):
    message: str


@router.post("/q/{token}/chat")
async def public_chat_turn(token: str, inp: ChatIn):
    """One turn of the client-side chat. Public — auth is the token itself.
    Persists the transcript on the client_questions doc and finalizes the
    question (running the interpreter + stamping the proposal) as soon as
    the AI emits a `[[DONE:...]]` marker."""
    q = await db.client_questions.find_one({"id": token})
    if not q:
        raise HTTPException(404, "Question not found.")
    if q.get("status") == "answered":
        raise HTTPException(400, "This conversation is already closed.")
    expires = q.get("expires_at")
    if expires and expires < now_iso():
        await db.client_questions.update_one({"id": token}, {"$set": {"status": "expired"}})
        raise HTTPException(410, "This link has expired.")

    client_msg = (inp.message or "").strip()
    if not client_msg:
        raise HTTPException(400, "Message is required.")

    tx_ids = q.get("txn_ids") or ([q["txn_id"]] if q.get("txn_id") else [])
    txns = await db.transactions.find({"id": {"$in": tx_ids}}).sort("date", 1).to_list(200) if tx_ids else []
    company = await db.companies.find_one({"id": q.get("company_id")}) or {}
    coa = await db.accounts.find({"company_id": q.get("company_id")}).to_list(500)

    history = list(q.get("chat_messages") or [])
    now = now_iso()
    history.append({"role": "client", "content": client_msg, "at": now})

    from ai_service import client_chat_reply
    ai_reply = await client_chat_reply(
        question=q.get("question") or "",
        counterparty=q.get("counterparty_label") or "",
        company_name=company.get("name") or "",
        txns=txns,
        history=history,
        coa=coa,
    )
    history.append({"role": "ai", "content": ai_reply, "at": now_iso()})
    await db.client_questions.update_one(
        {"id": token},
        {"$set": {"chat_messages": history, "updated_at": now_iso()}},
    )

    # Two markers the AI can emit:
    #   [[DONE:{json}]] — high-confidence fast path, auto-apply immediately
    #   [[PLAN:{json}]] — needs confirmation, render a green card client-side
    import re as _re, json as _json
    plan_match = _re.search(r"\[\[PLAN:(\{.+?\})\s*\]\]", ai_reply, flags=_re.S)
    done_match = _re.search(r"\[\[DONE:(\{.+?\})\s*\]\]", ai_reply, flags=_re.S)
    display_reply = _re.sub(r"\[\[(?:PLAN|DONE):.+?\]\]", "", ai_reply, flags=_re.S).strip()

    plan = None
    finalize = False
    if done_match:
        try:
            plan = _json.loads(done_match.group(1))
        except _json.JSONDecodeError:
            plan = None
        if plan:
            # Fast path — apply immediately, close the question.
            await _apply_client_plan(
                token=token, q_doc=q, plan=plan, client_msg=client_msg, coa=coa,
            )
            finalize = True
    elif plan_match:
        try:
            plan = _json.loads(plan_match.group(1))
        except _json.JSONDecodeError:
            plan = None
        # Do NOT auto-apply — the client will click Yes or No on the card.

    return {
        "reply": display_reply,
        "finalize": finalize,           # True only on fast-path DONE
        "plan": plan if plan_match else None,  # Only PLAN cards go to frontend
        "history": history,
    }


async def _apply_client_plan(*, token: str, q_doc: dict, plan: dict, client_msg: str, coa: list[dict]) -> None:
    """Shared finalization logic used by both the fast-path DONE marker
    and the client's 'Yes, apply' button on a PLAN card. Idempotent."""
    cid = q_doc.get("company_id")
    tx_ids = q_doc.get("txn_ids") or ([q_doc["txn_id"]] if q_doc.get("txn_id") else [])
    account_code = plan.get("account_code")
    acct = next((a for a in coa if a.get("code") == account_code), None)
    if not acct:
        # Unknown code — fall back to the plain-text interpreter path so the
        # pro still gets *something* actionable rather than nothing.
        await public_answer_question(
            token,
            AnswerIn(answer=f"{plan.get('summary') or ''}\n\nClient's own words: {client_msg}"),
        )
        return
    now = now_iso()
    # Directly categorize every txn — skip needs_review since the client
    # confirmed. Also stamp the proposal for the audit trail.
    proposal_doc = {
        "account_code": acct["code"],
        "account_id": acct["id"],
        "account_name": acct["name"],
        "confidence": float(plan.get("confidence") or 0.9),
        "reasoning": plan.get("summary") or "",
        "applies_to_all": True,
        "requires_split": False,
        "proposed_at": now,
        "source_question_id": token,
        "auto_applied": True,
    }
    existing = await db.transactions.find(
        {"id": {"$in": tx_ids}, "company_id": cid}
    ).to_list(200)
    for t in existing:
        ai_comment = (t.get("ai_comment") or "") + (
            f"\n[Client chat {now[:10]}] {plan.get('summary') or ''}"
            f"\n[Auto-applied → {acct['code']} {acct['name']}]"
        )
        await db.transactions.update_one(
            {"id": t["id"]},
            {"$set": {
                "category_account_id": acct["id"],
                "category_account_name": acct["name"],
                "category_account_code": acct["code"],
                "needs_review": False,
                "human_reviewed": True,
                "human_reviewed_at": now,
                "human_reviewed_by": "client_chat",
                "client_answer": plan.get("summary") or client_msg,
                "client_answered_at": now,
                "ai_comment": ai_comment,
                "updated_at": now,
            }},
        )
    # Optionally spawn a rule so future txns from this counterparty
    # auto-categorize without ever asking.
    if plan.get("create_rule") and plan.get("rule_pattern"):
        rule_pattern = str(plan["rule_pattern"]).strip().upper()
        if rule_pattern:
            existing_rule = await db.rules.find_one({
                "company_id": cid, "match_type": "description_contains",
                "match_value": rule_pattern,
            })
            if not existing_rule:
                await db.rules.insert_one({
                    "id": str(uuid.uuid4()), "company_id": cid,
                    "match_type": "description_contains",
                    "match_value": rule_pattern,
                    "account_code": acct["code"], "account_name": acct["name"],
                    "created_by": "client_chat", "hits": len(existing),
                    "created_at": now, "updated_at": now,
                })
    # Close the question.
    await db.client_questions.update_one(
        {"id": token},
        {"$set": {
            "status": "answered",
            "answer": plan.get("summary") or client_msg,
            "answered_at": now,
            "ai_proposal": proposal_doc,
        }},
    )


class PlanApplyIn(BaseModel):
    plan: dict


@router.post("/q/{token}/apply-plan")
async def public_apply_plan(token: str, inp: PlanApplyIn):
    """Client clicked the green button on a PLAN card. Server verifies the
    plan against the CoA (never trusts client-side account codes blindly)
    and runs the same finalization as the fast path."""
    q = await db.client_questions.find_one({"id": token})
    if not q:
        raise HTTPException(404, "Question not found.")
    if q.get("status") == "answered":
        raise HTTPException(400, "This conversation is already closed.")
    coa = await db.accounts.find({"company_id": q.get("company_id")}).to_list(500)
    valid_codes = {a.get("code") for a in coa}
    if inp.plan.get("account_code") not in valid_codes:
        raise HTTPException(400, "Plan references an unknown account code.")
    # Use the last client message as the audit trail if available.
    last_client_msg = ""
    for m in reversed(q.get("chat_messages") or []):
        if m.get("role") == "client":
            last_client_msg = m.get("content") or ""
            break
    await _apply_client_plan(
        token=token, q_doc=q, plan=inp.plan,
        client_msg=last_client_msg, coa=coa,
    )
    return {"status": "answered", "applied": True}


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

        # Fire-and-forget AI interpretation of the answer against the CoA so
        # a proposed category is waiting on the txn when the pro opens it.
        # Any failure here just means no proposal — the answer text is still
        # visible so the pro can categorize manually.
        try:
            from ai_service import interpret_client_answer
            coa = await db.accounts.find(
                {"company_id": q.get("company_id")}
            ).to_list(500)
            proposal = await interpret_client_answer(
                answer=ans, txns=existing, coa=coa,
            )
            if proposal and proposal.get("account_code"):
                acct = next(
                    (a for a in coa if a.get("code") == proposal["account_code"]),
                    None,
                )
                proposal_doc = {
                    "account_code": proposal["account_code"],
                    "account_id": (acct or {}).get("id"),
                    "account_name": (acct or {}).get("name"),
                    "confidence": proposal["confidence"],
                    "reasoning": proposal["reasoning"],
                    "applies_to_all": proposal["applies_to_all"],
                    "requires_split": proposal["requires_split"],
                    "proposed_at": now,
                    "source_question_id": token,
                }
                # Stamp the proposal on every txn in the batch — the pro can
                # accept/dismiss per-row from the Transactions list.
                await db.transactions.update_many(
                    {"id": {"$in": tx_ids}, "company_id": q.get("company_id")},
                    {"$set": {"ai_proposal_from_answer": proposal_doc, "updated_at": now}},
                )
                # Also stash on the question so a review UI can group
                # answered questions and their proposals in one place.
                await db.client_questions.update_one(
                    {"id": token},
                    {"$set": {"ai_proposal": proposal_doc}},
                )
        except Exception:  # noqa: BLE001 — never fail the client's answer submission
            pass
    return {"status": "answered", "txn_count": len(tx_ids)}


# --------------------------------------------------------------------------
# Closed-loop: accept / dismiss the AI's proposed category derived from a
# client's answer. Sits on the communications router because the whole
# thing is driven by the ask-client flow.
# --------------------------------------------------------------------------
@router.get("/companies/{cid}/communications/ai-logs")
async def list_ai_conversation_logs(
    cid: str,
    limit: int = Query(200, ge=1, le=1000),
    user: dict = Depends(get_current_user),
):
    """Every client-chat conversation on this company, newest first, each
    with its full transcript + the transactions it was about + the final
    categorization decision. This is what powers the Communications >
    AI Logs tab."""
    qs = await db.client_questions.find({"company_id": cid}).sort("sent_at", -1).limit(limit).to_list(limit)
    # Collect every txn id we need in one round trip.
    all_ids: set[str] = set()
    for q in qs:
        for x in (q.get("txn_ids") or []):
            all_ids.add(x)
        if q.get("txn_id"):
            all_ids.add(q["txn_id"])
    txn_by_id: dict = {}
    if all_ids:
        rows = await db.transactions.find(
            {"id": {"$in": list(all_ids)}, "company_id": cid},
            {"id": 1, "date": 1, "description": 1, "amount": 1,
             "category_account_name": 1, "category_account_code": 1,
             "human_reviewed": 1},
        ).to_list(2000)
        txn_by_id = {t["id"]: t for t in rows}

    items = []
    for q in qs:
        tx_ids = q.get("txn_ids") or ([q["txn_id"]] if q.get("txn_id") else [])
        linked = [
            {
                "id": t["id"], "date": t.get("date"),
                "description": t.get("description"), "amount": t.get("amount"),
                "category_account_name": t.get("category_account_name"),
                "category_account_code": t.get("category_account_code"),
                "human_reviewed": t.get("human_reviewed", False),
            }
            for t in (txn_by_id.get(x) for x in tx_ids) if t
        ]
        items.append({
            "id": q.get("id"),
            "flow_type": q.get("flow_type") or "pro_ask_client",
            "counterparty_label": q.get("counterparty_label"),
            "question": q.get("question"),
            "asked_by_name": q.get("asked_by_name"),
            "to_email": q.get("to_email"),
            "sent_at": q.get("sent_at"),
            "answered_at": q.get("answered_at"),
            "status": q.get("status"),
            "answer": q.get("answer"),
            "ai_proposal": q.get("ai_proposal"),
            "chat_messages": q.get("chat_messages") or [],
            "linked_txns": linked,
            "txn_count": len(linked),
        })
    return {"items": items}


@router.get("/companies/{cid}/communications/pending-proposals")
async def list_pending_proposals(cid: str, user: dict = Depends(get_current_user)):
    """Every transaction currently carrying a client-answer-derived AI
    proposal that hasn't been accepted or dismissed yet."""
    rows = await db.transactions.find({
        "company_id": cid,
        "ai_proposal_from_answer": {"$exists": True, "$ne": None},
    }).sort("client_answered_at", -1).to_list(500)
    return {"items": [coerce(t) for t in rows]}


@router.post("/companies/{cid}/transactions/{tid}/accept-proposal")
async def accept_proposal(cid: str, tid: str, user: dict = Depends(get_current_user)):
    """Apply the AI's client-answer-derived category to a single txn,
    clear the review flag, mark human-reviewed, drop the proposal doc."""
    t = await db.transactions.find_one({"id": tid, "company_id": cid})
    if not t:
        raise HTTPException(404, "Transaction not found.")
    proposal = t.get("ai_proposal_from_answer")
    if not proposal:
        raise HTTPException(400, "No proposal on this transaction.")
    now = now_iso()
    upd = {
        "category_account_id": proposal.get("account_id"),
        "category_account_name": proposal.get("account_name"),
        "category_account_code": proposal.get("account_code"),
        "needs_review": False,
        "human_reviewed": True,
        "human_reviewed_at": now,
        "human_reviewed_by": user.get("email"),
        "ai_comment": (t.get("ai_comment") or "") + f"\n[Accepted client-answer proposal {now[:10]}]: {proposal.get('reasoning')}",
        "updated_at": now,
    }
    await db.transactions.update_one(
        {"id": tid, "company_id": cid},
        {"$set": upd, "$unset": {"ai_proposal_from_answer": ""}},
    )
    return {"accepted": True, "category_account_id": proposal.get("account_id")}


class AcceptAllIn(BaseModel):
    question_id: str


@router.post("/companies/{cid}/communications/accept-proposal-batch")
async def accept_proposal_batch(cid: str, inp: AcceptAllIn, user: dict = Depends(get_current_user)):
    """Accept the client-answer proposal for EVERY txn tied to a given
    question_id in one shot — the pro's "yes, apply that to all 5" button."""
    q = await db.client_questions.find_one({"id": inp.question_id, "company_id": cid})
    if not q:
        raise HTTPException(404, "Question not found.")
    tx_ids = q.get("txn_ids") or ([q["txn_id"]] if q.get("txn_id") else [])
    if not tx_ids:
        raise HTTPException(400, "Question has no linked txns.")
    txns = await db.transactions.find({
        "id": {"$in": tx_ids}, "company_id": cid,
        "ai_proposal_from_answer": {"$exists": True, "$ne": None},
    }).to_list(200)
    if not txns:
        raise HTTPException(400, "None of the linked txns has a pending proposal.")
    now = now_iso()
    accepted_ids: list[str] = []
    for t in txns:
        p = t["ai_proposal_from_answer"]
        upd = {
            "category_account_id": p.get("account_id"),
            "category_account_name": p.get("account_name"),
            "category_account_code": p.get("account_code"),
            "needs_review": False,
            "human_reviewed": True,
            "human_reviewed_at": now,
            "human_reviewed_by": user.get("email"),
            "ai_comment": (t.get("ai_comment") or "") + f"\n[Accepted client-answer proposal {now[:10]}]: {p.get('reasoning')}",
            "updated_at": now,
        }
        await db.transactions.update_one(
            {"id": t["id"]},
            {"$set": upd, "$unset": {"ai_proposal_from_answer": ""}},
        )
        accepted_ids.append(t["id"])
    return {"accepted": len(accepted_ids), "txn_ids": accepted_ids}


@router.post("/companies/{cid}/transactions/{tid}/dismiss-proposal")
async def dismiss_proposal(cid: str, tid: str, user: dict = Depends(get_current_user)):
    """Drop the proposal without applying it. The client's answer text +
    the ai_comment audit line remain on the row."""
    t = await db.transactions.find_one({"id": tid, "company_id": cid})
    if not t:
        raise HTTPException(404, "Transaction not found.")
    if not t.get("ai_proposal_from_answer"):
        return {"dismissed": False, "reason": "No proposal to dismiss."}
    now = now_iso()
    await db.transactions.update_one(
        {"id": tid, "company_id": cid},
        {"$set": {
            "ai_comment": (t.get("ai_comment") or "") + f"\n[Dismissed client-answer proposal {now[:10]}]",
            "updated_at": now,
        }, "$unset": {"ai_proposal_from_answer": ""}},
    )
    return {"dismissed": True}


# --------------------------------------------------------------------------
# AI Ask Client — manual trigger + client-chat chaining helper
# --------------------------------------------------------------------------
@router.post("/communications/ai-ask-client/run")
async def run_ai_ask_client(
    for_company_id: Optional[str] = Query(None),
    user: dict = Depends(require_role("pro", "superadmin")),
):
    """Fire the autonomous AI-Ask-Client loop now. Pros can trigger their
    own tenants; superadmins can pass ``for_company_id`` to smoke-test one
    company, or omit to run against every company."""
    import ai_ask_client_scheduler as sched
    if for_company_id:
        summary = await sched.process_company(for_company_id)
        return {"companies": 1, "sent": 1 if summary.get("status") == "sent" else 0, "details": [summary]}
    if user["role"] == "pro":
        # Restrict to companies this pro is a member of.
        ms = await db.memberships.find({"user_id": user["id"], "role": "pro"}).to_list(1000)
        cids = [m["company_id"] for m in ms]
        summaries = []
        for cid in cids:
            summaries.append(await sched.process_company(cid))
        return {"companies": len(cids), "sent": sum(1 for s in summaries if s.get("status") == "sent"), "details": summaries}
    return await sched.run_once()


@router.get("/q/{token}/next")
async def public_next_question(token: str):
    """Given an *answered* question token, return the id of the next
    pending AI-initiated question for the same client email (if any) so
    the magic-link chat can chain to it — one txn at a time, only if the
    client volunteers to keep going. Returns ``{next: null}`` when
    nothing else is waiting."""
    q = await db.client_questions.find_one({"id": token})
    if not q:
        raise HTTPException(404, "Question not found.")
    to_email = q.get("to_email")
    if not to_email:
        return {"next": None}
    nxt = await db.client_questions.find_one({
        "to_email": to_email,
        "status": "pending",
        "flow_type": "ai_ask_client",
        "id": {"$ne": token},
    }, sort=[("sent_at", -1)])
    if not nxt:
        return {"next": None}
    return {
        "next": {
            "token": nxt["id"],
            "counterparty_label": nxt.get("counterparty_label"),
            "question": nxt.get("question"),
        }
    }


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
