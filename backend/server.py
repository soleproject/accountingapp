"""Axiom Ledger — Enterprise AI Accounting SaaS backend."""
from __future__ import annotations
import os
import uuid
import json
import random
from datetime import datetime, timezone, timedelta
from typing import Optional, Any, List
from pathlib import Path

from fastapi import FastAPI, APIRouter, Depends, HTTPException, Query, UploadFile, File, Form
from fastapi.responses import StreamingResponse, Response
from starlette.middleware.cors import CORSMiddleware
from pydantic import BaseModel, EmailStr, Field
from dotenv import load_dotenv

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / ".env")

from db import db, now_iso, coerce  # noqa: E402
from auth import (  # noqa: E402
    hash_password, verify_password, create_token,
    get_current_user, require_role,
)
from ai_service import (  # noqa: E402
    categorize_transaction, chat_stream, suggest_chart_of_accounts,
)
import reports as R  # noqa: E402
import plaid_service  # noqa: E402
import veryfi_service  # noqa: E402

app = FastAPI(title="Axiom Ledger API")
api = APIRouter(prefix="/api")


# ----------------------- Models -----------------------

class LoginIn(BaseModel):
    email: EmailStr
    password: str


class SignupIn(BaseModel):
    email: EmailStr
    password: str
    name: str
    role: str = "client"


class CompanyCreate(BaseModel):
    name: str
    business_type: str = ""
    business_description: str = ""
    reporting_basis: str = "accrual"


class TransactionUpdate(BaseModel):
    category_account_id: Optional[str] = None
    description: Optional[str] = None
    amount: Optional[float] = None
    date: Optional[str] = None
    needs_review: Optional[bool] = None
    human_reviewed: Optional[bool] = None
    posted: Optional[bool] = None
    splits: Optional[list] = None
    linked_invoice_id: Optional[str] = None
    linked_bill_id: Optional[str] = None
    tags: Optional[list] = None


class TransactionCreate(BaseModel):
    date: str
    description: str
    amount: float
    merchant: Optional[str] = ""
    bank_account_id: Optional[str] = None
    category_account_id: Optional[str] = None
    auto_categorize: bool = True


class SplitIn(BaseModel):
    splits: list  # [{amount, category_account_id, description}]


class RuleCreate(BaseModel):
    match_type: str = "merchant_contains"
    match_value: str
    account_code: str
    account_name: Optional[str] = None
    apply_to_existing: bool = True


class InvoiceCreate(BaseModel):
    number: Optional[str] = None
    contact_id: Optional[str] = None
    contact_name: Optional[str] = ""
    issue_date: str
    due_date: str
    line_items: list
    tax: float = 0.0
    notes: Optional[str] = ""
    status: str = "draft"


class BillCreate(BaseModel):
    number: Optional[str] = None
    contact_id: Optional[str] = None
    contact_name: Optional[str] = ""
    issue_date: str
    due_date: str
    line_items: list
    tax: float = 0.0
    status: str = "open"


class ContactCreate(BaseModel):
    name: str
    type: str = "customer"
    email: Optional[str] = ""
    phone: Optional[str] = ""
    address: Optional[str] = ""


class AccountCreate(BaseModel):
    code: str
    name: str
    type: str
    subtype: str = ""


class JECreate(BaseModel):
    date: str
    memo: Optional[str] = ""
    lines: list  # [{account_id, debit, credit, description}]


class ChatIn(BaseModel):
    company_id: str
    session_id: Optional[str] = None
    message: str
    focused_transaction_id: Optional[str] = None


class OnboardingUpdate(BaseModel):
    step: Optional[int] = None
    answers: Optional[dict] = None
    complete: Optional[bool] = None


class PaymentCreate(BaseModel):
    date: str
    amount: float
    contact_id: Optional[str] = None
    contact_name: Optional[str] = ""
    method: str = "check"
    linked_invoice_id: Optional[str] = None
    linked_bill_id: Optional[str] = None
    bank_account_id: Optional[str] = None
    memo: Optional[str] = ""


class ReceiptCreate(BaseModel):
    date: str
    amount: float
    merchant: str
    category_account_id: Optional[str] = None
    notes: Optional[str] = ""


class GenericCreate(BaseModel):
    data: dict


# ----------------------- Access helpers -----------------------

async def _company_ids_for_user(user: dict) -> list[str]:
    if user["role"] == "superadmin":
        docs = await db.companies.find({}).to_list(1000)
        return [d["id"] for d in docs]
    ms = await db.memberships.find({"user_id": user["id"]}).to_list(1000)
    return [m["company_id"] for m in ms]


async def _require_company(user: dict, company_id: str) -> dict:
    ids = await _company_ids_for_user(user)
    if company_id not in ids:
        raise HTTPException(403, "No access to this company")
    c = await db.companies.find_one({"id": company_id})
    if not c:
        raise HTTPException(404, "Company not found")
    return coerce(c)


async def _log_ai(company_id: str, kind: str, count: int = 1):
    existing = await db.ai_activity.find_one({"company_id": company_id, "type": kind})
    if existing:
        await db.ai_activity.update_one(
            {"id": existing["id"]},
            {"$inc": {"count": count}, "$set": {"updated_at": now_iso()}},
        )
    else:
        await db.ai_activity.insert_one({
            "id": str(uuid.uuid4()), "company_id": company_id, "type": kind,
            "count": count, "created_at": now_iso(),
        })


async def _is_period_closed(company_id: str, date_str: str) -> bool:
    """True if the given ISO date falls within a closed period for the company."""
    if not date_str:
        return False
    doc = await db.close_periods.find_one({
        "company_id": company_id, "status": "closed",
        "period_start": {"$lte": date_str},
        "period_end": {"$gte": date_str},
    })
    return doc is not None


async def _assert_open(company_id: str, date_str: str):
    if await _is_period_closed(company_id, date_str):
        raise HTTPException(423, f"Period covering {date_str} is closed. Reopen it to edit.")


async def _sync_and_import(cid: str, item: dict, selected_account_ids: list[str] | None = None) -> int:
    """Shared helper: run Plaid transactions_sync for a company's item and AI-categorize each new txn."""
    try:
        synced = plaid_service.sync_transactions(item["access_token"], item.get("cursor"))
    except Exception:
        return 0
    await db.plaid_items.update_one({"id": item["id"]}, {"$set": {
        "cursor": synced["next_cursor"], "updated_at": now_iso(),
    }})
    accts = await db.accounts.find({"company_id": cid}).to_list(2000)
    coa = [{"code": a["code"], "name": a["name"], "type": a["type"]} for a in accts]
    checking = next((a for a in accts if a["code"] == "1010"), None)
    if not checking:
        return 0
    imported = 0
    now = now_iso()
    for t in synced["added"]:
        if selected_account_ids and t["account_id"] not in selected_account_ids:
            continue
        if await db.transactions.find_one({"company_id": cid, "plaid_transaction_id": t["transaction_id"]}):
            continue
        if await _is_period_closed(cid, t["date"]):
            continue  # skip closed-period activity
        merchant = t.get("merchant_name") or t.get("name") or "Unknown"
        result = await categorize_transaction(merchant, t["amount"], t["name"], coa)
        acct = next((a for a in accts if a["code"] == result["account_code"]), None) or checking
        await db.transactions.insert_one({
            "id": str(uuid.uuid4()), "company_id": cid, "date": t["date"],
            "description": t["name"], "merchant": merchant, "amount": t["amount"],
            "bank_account_id": checking["id"], "bank_account_name": checking["name"],
            "category_account_id": acct["id"], "category_account_code": acct["code"],
            "category_account_name": acct["name"],
            "ai_confidence": round(result["confidence"], 2), "ai_reasoning": result["reasoning"],
            "needs_review": result["confidence"] < 0.80, "human_reviewed": False,
            "posted": result["confidence"] >= 0.80, "source": "plaid",
            "plaid_transaction_id": t["transaction_id"], "plaid_account_id": t["account_id"],
            "pending": t["pending"], "splits": [], "linked_invoice_id": None,
            "linked_bill_id": None, "linked_payment_id": None, "tags": [],
            "created_at": now, "updated_at": now,
        })
        imported += 1
    if imported:
        await _log_ai(cid, "categorize", imported)
        await _log_ai(cid, "webhook_sync", imported)
    return imported


# ----------------------- Auth endpoints -----------------------

@api.post("/auth/login")
async def login(inp: LoginIn):
    u = await db.users.find_one({"email": inp.email.lower()})
    if not u or not verify_password(inp.password, u["password"]):
        raise HTTPException(401, "Invalid credentials")
    token = create_token(u["id"], u["role"])
    return {"token": token, "user": {"id": u["id"], "email": u["email"],
            "name": u["name"], "role": u["role"]}}


@api.post("/auth/signup")
async def signup(inp: SignupIn):
    if await db.users.find_one({"email": inp.email.lower()}):
        raise HTTPException(400, "Email already registered")
    uid = str(uuid.uuid4())
    now = now_iso()
    await db.users.insert_one({
        "id": uid, "email": inp.email.lower(), "name": inp.name,
        "password": hash_password(inp.password), "role": inp.role,
        "created_at": now, "updated_at": now,
    })
    token = create_token(uid, inp.role)
    return {"token": token, "user": {"id": uid, "email": inp.email.lower(),
            "name": inp.name, "role": inp.role}}


@api.get("/auth/me")
async def me(user: dict = Depends(get_current_user)):
    return {"user": {k: user[k] for k in ("id", "email", "name", "role")}}


# ----------------------- Superadmin -----------------------

@api.get("/admin/overview")
async def admin_overview(user: dict = Depends(require_role("superadmin"))):
    users = await db.users.find({}, {"password": 0, "_id": 0}).to_list(1000)
    companies = await db.companies.find({}, {"_id": 0}).to_list(1000)
    memberships = await db.memberships.find({}, {"_id": 0}).to_list(2000)
    pros = [u for u in users if u["role"] == "pro"]
    clients = [u for u in users if u["role"] == "client"]
    return {
        "users": users, "companies": companies, "memberships": memberships,
        "stats": {
            "total_users": len(users), "total_pros": len(pros),
            "total_clients": len(clients), "total_companies": len(companies),
        },
    }


# ----------------------- Pro dashboard -----------------------

@api.get("/pro/clients")
async def pro_clients(user: dict = Depends(require_role("pro", "superadmin"))):
    ms = await db.memberships.find({"user_id": user["id"], "role": "pro"}).to_list(1000)
    company_ids = [m["company_id"] for m in ms]
    if user["role"] == "superadmin":
        companies = await db.companies.find({}).to_list(1000)
    else:
        companies = await db.companies.find({"id": {"$in": company_ids}}).to_list(1000)
    result = []
    for c in companies:
        txn_count = await db.transactions.count_documents({"company_id": c["id"]})
        needs_review = await db.transactions.count_documents({"company_id": c["id"], "needs_review": True})
        result.append({
            "id": c["id"], "name": c["name"], "business_type": c.get("business_type", ""),
            "onboarding_complete": c.get("onboarding_complete", False),
            "transactions": txn_count, "needs_review": needs_review,
        })
    return {"clients": result}


# ----------------------- Companies -----------------------

@api.get("/companies")
async def list_companies(user: dict = Depends(get_current_user)):
    ids = await _company_ids_for_user(user)
    docs = await db.companies.find({"id": {"$in": ids}}).to_list(1000)
    return {"companies": [coerce(d) for d in docs]}


@api.post("/companies")
async def create_company(inp: CompanyCreate, user: dict = Depends(get_current_user)):
    cid = str(uuid.uuid4())
    now = now_iso()
    await db.companies.insert_one({
        "id": cid, "name": inp.name, "business_type": inp.business_type,
        "business_description": inp.business_description,
        "reporting_basis": inp.reporting_basis,
        "owner_user_id": user["id"], "onboarding_complete": False,
        "created_at": now, "updated_at": now,
    })
    await db.memberships.insert_one({
        "id": str(uuid.uuid4()), "user_id": user["id"], "company_id": cid,
        "role": "owner", "created_at": now,
    })
    # Auto-provision default CoA
    from seed import DEFAULT_COA
    for code, name, atype, subtype in DEFAULT_COA:
        await db.accounts.insert_one({
            "id": str(uuid.uuid4()), "company_id": cid, "code": code, "name": name,
            "type": atype, "subtype": subtype, "active": True, "balance": 0.0,
            "created_at": now, "updated_at": now,
        })
    await db.onboarding_state.insert_one({
        "id": str(uuid.uuid4()), "company_id": cid, "step": 0, "total_steps": 6,
        "complete": False, "answers": {}, "created_at": now, "updated_at": now,
    })
    return {"company_id": cid}


# ----------------------- Accounts (Chart of Accounts) -----------------------

@api.get("/companies/{cid}/accounts")
async def list_accounts(cid: str, user: dict = Depends(get_current_user)):
    await _require_company(user, cid)
    docs = await db.accounts.find({"company_id": cid}).sort("code", 1).to_list(2000)
    return {"accounts": [coerce(d) for d in docs]}


@api.post("/companies/{cid}/accounts")
async def create_account(cid: str, inp: AccountCreate, user: dict = Depends(get_current_user)):
    await _require_company(user, cid)
    aid = str(uuid.uuid4()); now = now_iso()
    await db.accounts.insert_one({
        "id": aid, "company_id": cid, "code": inp.code, "name": inp.name,
        "type": inp.type, "subtype": inp.subtype, "active": True, "balance": 0.0,
        "created_at": now, "updated_at": now,
    })
    return {"id": aid}


@api.patch("/companies/{cid}/accounts/{aid}")
async def update_account(cid: str, aid: str, payload: dict, user: dict = Depends(get_current_user)):
    await _require_company(user, cid)
    payload["updated_at"] = now_iso()
    await db.accounts.update_one({"id": aid, "company_id": cid}, {"$set": payload})
    return {"ok": True}


@api.delete("/companies/{cid}/accounts/{aid}")
async def delete_account(cid: str, aid: str, user: dict = Depends(get_current_user)):
    await _require_company(user, cid)
    await db.accounts.delete_one({"id": aid, "company_id": cid})
    return {"ok": True}


# ----------------------- Transactions -----------------------

@api.get("/companies/{cid}/transactions")
async def list_transactions(
    cid: str, user: dict = Depends(get_current_user),
    needs_review: Optional[bool] = None, limit: int = 500,
):
    await _require_company(user, cid)
    q = {"company_id": cid}
    if needs_review is not None:
        q["needs_review"] = needs_review
    docs = await db.transactions.find(q).sort("date", -1).to_list(limit)
    return {"transactions": [coerce(d) for d in docs]}


@api.post("/companies/{cid}/transactions")
async def create_transaction(cid: str, inp: TransactionCreate, user: dict = Depends(get_current_user)):
    await _require_company(user, cid)
    await _assert_open(cid, inp.date)
    now = now_iso()
    tid = str(uuid.uuid4())
    accts = await db.accounts.find({"company_id": cid}).to_list(2000)
    accts_by_id = {a["id"]: a for a in accts}
    category_id = inp.category_account_id
    conf = 1.0
    reasoning = "Manually created"
    if inp.auto_categorize and not category_id:
        coa = [{"code": a["code"], "name": a["name"], "type": a["type"]} for a in accts]
        result = await categorize_transaction(inp.merchant or inp.description, inp.amount, inp.description, coa)
        match = next((a for a in accts if a["code"] == result["account_code"]), None)
        if match:
            category_id = match["id"]
        conf = result["confidence"]
        reasoning = result["reasoning"]
        await _log_ai(cid, "categorize", 1)
    acct = accts_by_id.get(category_id) if category_id else None
    bank = accts_by_id.get(inp.bank_account_id) if inp.bank_account_id else None
    doc = {
        "id": tid, "company_id": cid, "date": inp.date,
        "description": inp.description, "merchant": inp.merchant or inp.description,
        "amount": round(inp.amount, 2),
        "bank_account_id": inp.bank_account_id,
        "bank_account_name": bank["name"] if bank else "",
        "category_account_id": category_id,
        "category_account_code": acct["code"] if acct else None,
        "category_account_name": acct["name"] if acct else None,
        "ai_confidence": round(conf, 2),
        "ai_reasoning": reasoning,
        "needs_review": conf < 0.80,
        "human_reviewed": False,
        "posted": conf >= 0.80 or not inp.auto_categorize,
        "source": "manual",
        "splits": [], "linked_invoice_id": None, "linked_bill_id": None,
        "linked_payment_id": None, "tags": [],
        "created_at": now, "updated_at": now,
    }
    if doc["posted"]:
        await _log_ai(cid, "post_je", 1)
    if doc["needs_review"]:
        await _log_ai(cid, "flag_review", 1)
    await db.transactions.insert_one(doc)
    return {"id": tid, "transaction": coerce(doc)}


@api.patch("/companies/{cid}/transactions/{tid}")
async def update_transaction(cid: str, tid: str, inp: TransactionUpdate, user: dict = Depends(get_current_user)):
    await _require_company(user, cid)
    existing = await db.transactions.find_one({"id": tid, "company_id": cid})
    if existing:
        await _assert_open(cid, existing.get("date"))
        if inp.date:
            await _assert_open(cid, inp.date)
    upd = {k: v for k, v in inp.model_dump(exclude_unset=True).items() if v is not None}
    if "category_account_id" in upd:
        acct = await db.accounts.find_one({"id": upd["category_account_id"], "company_id": cid})
        if acct:
            upd["category_account_code"] = acct["code"]
            upd["category_account_name"] = acct["name"]
        upd["human_reviewed"] = True
        upd["needs_review"] = False
    upd["updated_at"] = now_iso()
    await db.transactions.update_one({"id": tid, "company_id": cid}, {"$set": upd})
    doc = await db.transactions.find_one({"id": tid, "company_id": cid})
    return {"transaction": coerce(doc)}


@api.post("/companies/{cid}/transactions/{tid}/split")
async def split_transaction(cid: str, tid: str, inp: SplitIn, user: dict = Depends(get_current_user)):
    await _require_company(user, cid)
    txn = await db.transactions.find_one({"id": tid, "company_id": cid})
    if not txn:
        raise HTTPException(404, "Transaction not found")
    await _assert_open(cid, txn.get("date"))
    total = sum(float(s.get("amount", 0)) for s in inp.splits)
    if abs(total - float(txn["amount"])) > 0.01:
        raise HTTPException(400, f"Splits must total {txn['amount']}, got {total}")
    await db.transactions.update_one(
        {"id": tid, "company_id": cid},
        {"$set": {"splits": inp.splits, "human_reviewed": True, "needs_review": False, "updated_at": now_iso()}},
    )
    return {"ok": True}


@api.post("/companies/{cid}/transactions/{tid}/link")
async def link_transaction(
    cid: str, tid: str,
    invoice_id: Optional[str] = None, bill_id: Optional[str] = None, payment_id: Optional[str] = None,
    user: dict = Depends(get_current_user),
):
    await _require_company(user, cid)
    upd = {"updated_at": now_iso()}
    if invoice_id is not None:
        upd["linked_invoice_id"] = invoice_id
    if bill_id is not None:
        upd["linked_bill_id"] = bill_id
    if payment_id is not None:
        upd["linked_payment_id"] = payment_id
    await db.transactions.update_one({"id": tid, "company_id": cid}, {"$set": upd})
    return {"ok": True}


@api.post("/companies/{cid}/transactions/{tid}/approve")
async def approve_transaction(cid: str, tid: str, user: dict = Depends(get_current_user)):
    """Mark human-reviewed & posted."""
    await _require_company(user, cid)
    existing = await db.transactions.find_one({"id": tid, "company_id": cid})
    if existing:
        await _assert_open(cid, existing.get("date"))
    await db.transactions.update_one({"id": tid, "company_id": cid},
        {"$set": {"human_reviewed": True, "needs_review": False, "posted": True, "updated_at": now_iso()}})
    # Track approval count on merchant for rule suggestion
    txn = await db.transactions.find_one({"id": tid, "company_id": cid})
    if txn:
        merch = (txn.get("merchant") or "").strip()
        acct = txn.get("category_account_code")
        if merch and acct:
            key = f"{merch}::{acct}"
            existing = await db.rule_candidates.find_one({"company_id": cid, "key": key})
            if existing:
                await db.rule_candidates.update_one({"id": existing["id"]}, {"$inc": {"approvals": 1}})
            else:
                await db.rule_candidates.insert_one({
                    "id": str(uuid.uuid4()), "company_id": cid, "key": key,
                    "merchant": merch, "account_code": acct,
                    "account_name": txn.get("category_account_name"),
                    "approvals": 1, "created_at": now_iso(),
                })
    return {"ok": True}


@api.post("/companies/{cid}/transactions/bulk-approve")
async def bulk_approve(cid: str, ids: List[str], user: dict = Depends(get_current_user)):
    await _require_company(user, cid)
    await db.transactions.update_many(
        {"id": {"$in": ids}, "company_id": cid},
        {"$set": {"human_reviewed": True, "needs_review": False, "posted": True, "updated_at": now_iso()}},
    )
    return {"ok": True, "count": len(ids)}


@api.delete("/companies/{cid}/transactions/{tid}")
async def delete_transaction(cid: str, tid: str, user: dict = Depends(get_current_user)):
    await _require_company(user, cid)
    existing = await db.transactions.find_one({"id": tid, "company_id": cid})
    if existing:
        await _assert_open(cid, existing.get("date"))
    await db.transactions.delete_one({"id": tid, "company_id": cid})
    return {"ok": True}


# ----------------------- AI: categorize / recategorize / activity -----------------------

@api.post("/companies/{cid}/ai/recategorize/{tid}")
async def ai_recategorize(cid: str, tid: str, user: dict = Depends(get_current_user)):
    await _require_company(user, cid)
    txn = await db.transactions.find_one({"id": tid, "company_id": cid})
    if not txn:
        raise HTTPException(404, "Transaction not found")
    accts = await db.accounts.find({"company_id": cid}).to_list(2000)
    coa = [{"code": a["code"], "name": a["name"], "type": a["type"]} for a in accts]
    result = await categorize_transaction(
        txn.get("merchant", ""), float(txn.get("amount", 0)), txn.get("description", ""), coa,
    )
    match = next((a for a in accts if a["code"] == result["account_code"]), None)
    upd = {
        "ai_confidence": round(result["confidence"], 2),
        "ai_reasoning": result["reasoning"],
        "needs_review": result["confidence"] < 0.80,
        "posted": result["confidence"] >= 0.80,
        "updated_at": now_iso(),
    }
    if match:
        upd["category_account_id"] = match["id"]
        upd["category_account_code"] = match["code"]
        upd["category_account_name"] = match["name"]
    await db.transactions.update_one({"id": tid, "company_id": cid}, {"$set": upd})
    await _log_ai(cid, "categorize", 1)
    doc = await db.transactions.find_one({"id": tid, "company_id": cid})
    return {"transaction": coerce(doc)}


@api.get("/companies/{cid}/ai/activity")
async def ai_activity(cid: str, user: dict = Depends(get_current_user)):
    await _require_company(user, cid)
    docs = await db.ai_activity.find({"company_id": cid}).to_list(100)
    total_txns = await db.transactions.count_documents({"company_id": cid})
    posted = await db.transactions.count_documents({"company_id": cid, "posted": True})
    flagged = await db.transactions.count_documents({"company_id": cid, "needs_review": True})
    rules_count = await db.rules.count_documents({"company_id": cid})
    ai_rules = await db.rules.count_documents({"company_id": cid, "created_by": "ai"})
    return {
        "activity": [coerce(d) for d in docs],
        "totals": {
            "transactions": total_txns, "posted": posted, "flagged": flagged,
            "rules": rules_count, "ai_rules": ai_rules,
            "accuracy": round((posted / max(total_txns, 1)) * 100, 1),
        },
    }


# ----------------------- Rules -----------------------

@api.get("/companies/{cid}/rules")
async def list_rules(cid: str, user: dict = Depends(get_current_user)):
    await _require_company(user, cid)
    docs = await db.rules.find({"company_id": cid}).sort("created_at", -1).to_list(500)
    candidates = await db.rule_candidates.find({"company_id": cid, "approvals": {"$gte": 2}}).to_list(100)
    return {"rules": [coerce(d) for d in docs], "candidates": [coerce(c) for c in candidates]}


@api.post("/companies/{cid}/rules")
async def create_rule(cid: str, inp: RuleCreate, user: dict = Depends(get_current_user)):
    await _require_company(user, cid)
    acct = await db.accounts.find_one({"company_id": cid, "code": inp.account_code})
    if not acct:
        raise HTTPException(400, "Account code not found")
    rid = str(uuid.uuid4()); now = now_iso()
    await db.rules.insert_one({
        "id": rid, "company_id": cid, "match_type": inp.match_type,
        "match_value": inp.match_value, "account_code": inp.account_code,
        "account_name": acct["name"], "created_by": "human", "hits": 0,
        "created_at": now, "updated_at": now,
    })
    applied = 0
    if inp.apply_to_existing:
        q = {
            "company_id": cid, "human_reviewed": False,
            "merchant": {"$regex": inp.match_value, "$options": "i"},
        }
        docs = await db.transactions.find(q).to_list(5000)
        for t in docs:
            if await _is_period_closed(cid, t.get("date")):
                continue  # rules never edit closed-period activity
            await db.transactions.update_one(
                {"id": t["id"]},
                {"$set": {
                    "category_account_id": acct["id"],
                    "category_account_code": acct["code"],
                    "category_account_name": acct["name"],
                    "ai_confidence": 0.99,
                    "ai_reasoning": f"Auto-applied rule: {inp.match_value} → {acct['name']}",
                    "needs_review": False, "posted": True,
                    "updated_at": now_iso(),
                }},
            )
            applied += 1
        await db.rules.update_one({"id": rid}, {"$set": {"hits": applied}})
    await _log_ai(cid, "rule_created", 1)
    return {"id": rid, "applied": applied}


@api.delete("/companies/{cid}/rules/{rid}")
async def delete_rule(cid: str, rid: str, user: dict = Depends(get_current_user)):
    await _require_company(user, cid)
    await db.rules.delete_one({"id": rid, "company_id": cid})
    return {"ok": True}


# ----------------------- Contacts -----------------------

@api.get("/companies/{cid}/contacts")
async def list_contacts(cid: str, user: dict = Depends(get_current_user)):
    await _require_company(user, cid)
    docs = await db.contacts.find({"company_id": cid}).sort("name", 1).to_list(1000)
    return {"contacts": [coerce(d) for d in docs]}


@api.post("/companies/{cid}/contacts")
async def create_contact(cid: str, inp: ContactCreate, user: dict = Depends(get_current_user)):
    await _require_company(user, cid)
    xid = str(uuid.uuid4()); now = now_iso()
    await db.contacts.insert_one({
        "id": xid, "company_id": cid, **inp.model_dump(),
        "created_at": now, "updated_at": now,
    })
    return {"id": xid}


@api.patch("/companies/{cid}/contacts/{xid}")
async def update_contact(cid: str, xid: str, payload: dict, user: dict = Depends(get_current_user)):
    await _require_company(user, cid)
    payload["updated_at"] = now_iso()
    await db.contacts.update_one({"id": xid, "company_id": cid}, {"$set": payload})
    return {"ok": True}


@api.delete("/companies/{cid}/contacts/{xid}")
async def delete_contact(cid: str, xid: str, user: dict = Depends(get_current_user)):
    await _require_company(user, cid)
    await db.contacts.delete_one({"id": xid, "company_id": cid})
    return {"ok": True}


# ----------------------- Invoices -----------------------

def _sum_lines(lines: list, tax: float = 0.0) -> tuple[float, float, float]:
    subtotal = sum(float(li.get("amount", 0)) for li in lines)
    total = subtotal + float(tax or 0)
    return round(subtotal, 2), round(float(tax or 0), 2), round(total, 2)


@api.get("/companies/{cid}/invoices")
async def list_invoices(cid: str, user: dict = Depends(get_current_user)):
    await _require_company(user, cid)
    docs = await db.invoices.find({"company_id": cid}).sort("issue_date", -1).to_list(1000)
    return {"invoices": [coerce(d) for d in docs]}


@api.post("/companies/{cid}/invoices")
async def create_invoice(cid: str, inp: InvoiceCreate, user: dict = Depends(get_current_user)):
    await _require_company(user, cid)
    iid = str(uuid.uuid4()); now = now_iso()
    subtotal, tax, total = _sum_lines(inp.line_items, inp.tax)
    doc = {
        "id": iid, "company_id": cid,
        "number": inp.number or f"INV-{random.randint(1000, 9999)}",
        "contact_id": inp.contact_id, "contact_name": inp.contact_name,
        "issue_date": inp.issue_date, "due_date": inp.due_date,
        "status": inp.status, "line_items": inp.line_items,
        "subtotal": subtotal, "tax": tax, "total": total, "balance_due": total,
        "notes": inp.notes, "created_at": now, "updated_at": now,
    }
    await db.invoices.insert_one(doc)
    return {"id": iid, "invoice": coerce(doc)}


@api.patch("/companies/{cid}/invoices/{iid}")
async def update_invoice(cid: str, iid: str, payload: dict, user: dict = Depends(get_current_user)):
    await _require_company(user, cid)
    if "line_items" in payload:
        subtotal, tax, total = _sum_lines(payload["line_items"], payload.get("tax", 0))
        payload["subtotal"] = subtotal
        payload["tax"] = tax
        payload["total"] = total
        payload["balance_due"] = total
    payload["updated_at"] = now_iso()
    await db.invoices.update_one({"id": iid, "company_id": cid}, {"$set": payload})
    return {"ok": True}


@api.delete("/companies/{cid}/invoices/{iid}")
async def delete_invoice(cid: str, iid: str, user: dict = Depends(get_current_user)):
    await _require_company(user, cid)
    await db.invoices.delete_one({"id": iid, "company_id": cid})
    return {"ok": True}


# ----------------------- Bills -----------------------

@api.get("/companies/{cid}/bills")
async def list_bills(cid: str, user: dict = Depends(get_current_user)):
    await _require_company(user, cid)
    docs = await db.bills.find({"company_id": cid}).sort("issue_date", -1).to_list(1000)
    return {"bills": [coerce(d) for d in docs]}


@api.post("/companies/{cid}/bills")
async def create_bill(cid: str, inp: BillCreate, user: dict = Depends(get_current_user)):
    await _require_company(user, cid)
    bid = str(uuid.uuid4()); now = now_iso()
    subtotal, tax, total = _sum_lines(inp.line_items, inp.tax)
    doc = {
        "id": bid, "company_id": cid,
        "number": inp.number or f"BILL-{random.randint(100, 999)}",
        "contact_id": inp.contact_id, "contact_name": inp.contact_name,
        "issue_date": inp.issue_date, "due_date": inp.due_date,
        "status": inp.status, "line_items": inp.line_items,
        "subtotal": subtotal, "tax": tax, "total": total, "balance_due": total,
        "created_at": now, "updated_at": now,
    }
    await db.bills.insert_one(doc)
    return {"id": bid, "bill": coerce(doc)}


@api.patch("/companies/{cid}/bills/{bid}")
async def update_bill(cid: str, bid: str, payload: dict, user: dict = Depends(get_current_user)):
    await _require_company(user, cid)
    if "line_items" in payload:
        subtotal, tax, total = _sum_lines(payload["line_items"], payload.get("tax", 0))
        payload["subtotal"] = subtotal
        payload["tax"] = tax
        payload["total"] = total
        payload["balance_due"] = total
    payload["updated_at"] = now_iso()
    await db.bills.update_one({"id": bid, "company_id": cid}, {"$set": payload})
    return {"ok": True}


@api.delete("/companies/{cid}/bills/{bid}")
async def delete_bill(cid: str, bid: str, user: dict = Depends(get_current_user)):
    await _require_company(user, cid)
    await db.bills.delete_one({"id": bid, "company_id": cid})
    return {"ok": True}


# ----------------------- Payments & Receipts -----------------------

@api.get("/companies/{cid}/payments")
async def list_payments(cid: str, user: dict = Depends(get_current_user)):
    await _require_company(user, cid)
    docs = await db.payments.find({"company_id": cid}).sort("date", -1).to_list(1000)
    return {"payments": [coerce(d) for d in docs]}


@api.post("/companies/{cid}/payments")
async def create_payment(cid: str, inp: PaymentCreate, user: dict = Depends(get_current_user)):
    await _require_company(user, cid)
    pid = str(uuid.uuid4()); now = now_iso()
    await db.payments.insert_one({
        "id": pid, "company_id": cid, **inp.model_dump(),
        "created_at": now, "updated_at": now,
    })
    # If linked to invoice/bill, reduce balance_due
    if inp.linked_invoice_id:
        inv = await db.invoices.find_one({"id": inp.linked_invoice_id, "company_id": cid})
        if inv:
            bal = float(inv.get("balance_due", inv.get("total", 0))) - float(inp.amount)
            status = "paid" if bal <= 0.01 else "partial"
            await db.invoices.update_one({"id": inv["id"]},
                {"$set": {"balance_due": round(bal, 2), "status": status}})
    if inp.linked_bill_id:
        bill = await db.bills.find_one({"id": inp.linked_bill_id, "company_id": cid})
        if bill:
            bal = float(bill.get("balance_due", bill.get("total", 0))) - float(inp.amount)
            status = "paid" if bal <= 0.01 else "partial"
            await db.bills.update_one({"id": bill["id"]},
                {"$set": {"balance_due": round(bal, 2), "status": status}})
    return {"id": pid}


@api.delete("/companies/{cid}/payments/{pid}")
async def delete_payment(cid: str, pid: str, user: dict = Depends(get_current_user)):
    await _require_company(user, cid)
    await db.payments.delete_one({"id": pid, "company_id": cid})
    return {"ok": True}


@api.get("/companies/{cid}/receipts")
async def list_receipts(cid: str, user: dict = Depends(get_current_user)):
    await _require_company(user, cid)
    docs = await db.receipts.find({"company_id": cid}).sort("date", -1).to_list(1000)
    return {"receipts": [coerce(d) for d in docs]}


@api.post("/companies/{cid}/receipts")
async def create_receipt(cid: str, inp: ReceiptCreate, user: dict = Depends(get_current_user)):
    await _require_company(user, cid)
    rid = str(uuid.uuid4()); now = now_iso()
    await db.receipts.insert_one({
        "id": rid, "company_id": cid, **inp.model_dump(),
        "created_at": now, "updated_at": now,
    })
    return {"id": rid}


@api.delete("/companies/{cid}/receipts/{rid}")
async def delete_receipt(cid: str, rid: str, user: dict = Depends(get_current_user)):
    await _require_company(user, cid)
    await db.receipts.delete_one({"id": rid, "company_id": cid})
    return {"ok": True}


# ----------------------- Journal Entries -----------------------

@api.get("/companies/{cid}/journal-entries")
async def list_jes(cid: str, user: dict = Depends(get_current_user)):
    await _require_company(user, cid)
    docs = await db.journal_entries.find({"company_id": cid}).sort("date", -1).to_list(2000)
    return {"entries": [coerce(d) for d in docs]}


@api.post("/companies/{cid}/journal-entries")
async def create_je(cid: str, inp: JECreate, user: dict = Depends(get_current_user)):
    await _require_company(user, cid)
    await _assert_open(cid, inp.date)
    total_d = sum(float(l.get("debit", 0)) for l in inp.lines)
    total_c = sum(float(l.get("credit", 0)) for l in inp.lines)
    if abs(total_d - total_c) > 0.01:
        raise HTTPException(400, f"Debits ({total_d}) must equal credits ({total_c})")
    jid = str(uuid.uuid4()); now = now_iso()
    await db.journal_entries.insert_one({
        "id": jid, "company_id": cid, "date": inp.date, "memo": inp.memo,
        "lines": inp.lines, "total_debit": round(total_d, 2), "total_credit": round(total_c, 2),
        "created_by": user["id"], "created_at": now, "updated_at": now,
    })
    return {"id": jid}


@api.delete("/companies/{cid}/journal-entries/{jid}")
async def delete_je(cid: str, jid: str, user: dict = Depends(get_current_user)):
    await _require_company(user, cid)
    existing = await db.journal_entries.find_one({"id": jid, "company_id": cid})
    if existing:
        await _assert_open(cid, existing.get("date"))
    await db.journal_entries.delete_one({"id": jid, "company_id": cid})
    return {"ok": True}


# ----------------------- Reports -----------------------

def _default_range() -> tuple[str, str]:
    end = datetime.now(timezone.utc).date()
    start = end.replace(month=1, day=1)
    return start.isoformat(), end.isoformat()


@api.get("/companies/{cid}/reports/income-statement")
async def rep_income(cid: str, start: Optional[str] = None, end: Optional[str] = None,
                     basis: str = "accrual", user: dict = Depends(get_current_user)):
    await _require_company(user, cid)
    s, e = _default_range()
    return await R.compute_income_statement(cid, start or s, end or e, basis)


@api.get("/companies/{cid}/reports/income-statement/pdf")
async def rep_income_pdf(cid: str, start: Optional[str] = None, end: Optional[str] = None,
                         basis: str = "accrual", user: dict = Depends(get_current_user)):
    await _require_company(user, cid)
    s, e = _default_range()
    data = await R.compute_income_statement(cid, start or s, end or e, basis)
    pdf = R.build_income_statement_pdf(data)
    return Response(content=pdf, media_type="application/pdf",
                    headers={"Content-Disposition": "attachment; filename=income_statement.pdf"})


@api.get("/companies/{cid}/reports/balance-sheet")
async def rep_bs(cid: str, as_of: Optional[str] = None, basis: str = "accrual",
                 user: dict = Depends(get_current_user)):
    await _require_company(user, cid)
    _, e = _default_range()
    return await R.compute_balance_sheet(cid, as_of or e, basis)


@api.get("/companies/{cid}/reports/balance-sheet/pdf")
async def rep_bs_pdf(cid: str, as_of: Optional[str] = None, basis: str = "accrual",
                     user: dict = Depends(get_current_user)):
    await _require_company(user, cid)
    _, e = _default_range()
    data = await R.compute_balance_sheet(cid, as_of or e, basis)
    return Response(content=R.build_balance_sheet_pdf(data), media_type="application/pdf",
                    headers={"Content-Disposition": "attachment; filename=balance_sheet.pdf"})


@api.get("/companies/{cid}/reports/trial-balance")
async def rep_tb(cid: str, as_of: Optional[str] = None, user: dict = Depends(get_current_user)):
    await _require_company(user, cid)
    _, e = _default_range()
    return await R.compute_trial_balance(cid, as_of or e)


@api.get("/companies/{cid}/reports/trial-balance/pdf")
async def rep_tb_pdf(cid: str, as_of: Optional[str] = None, user: dict = Depends(get_current_user)):
    await _require_company(user, cid)
    _, e = _default_range()
    data = await R.compute_trial_balance(cid, as_of or e)
    return Response(content=R.build_trial_balance_pdf(data), media_type="application/pdf",
                    headers={"Content-Disposition": "attachment; filename=trial_balance.pdf"})


@api.get("/companies/{cid}/reports/general-ledger")
async def rep_gl(cid: str, start: Optional[str] = None, end: Optional[str] = None,
                 user: dict = Depends(get_current_user)):
    await _require_company(user, cid)
    s, e = _default_range()
    return await R.compute_general_ledger(cid, start or s, end or e)


@api.get("/companies/{cid}/reports/general-ledger/pdf")
async def rep_gl_pdf(cid: str, start: Optional[str] = None, end: Optional[str] = None,
                     user: dict = Depends(get_current_user)):
    await _require_company(user, cid)
    s, e = _default_range()
    data = await R.compute_general_ledger(cid, start or s, end or e)
    return Response(content=R.build_general_ledger_pdf(data), media_type="application/pdf",
                    headers={"Content-Disposition": "attachment; filename=general_ledger.pdf"})


@api.get("/companies/{cid}/reports/cash-flow")
async def rep_cf(cid: str, start: Optional[str] = None, end: Optional[str] = None,
                 user: dict = Depends(get_current_user)):
    await _require_company(user, cid)
    s, e = _default_range()
    return await R.compute_cash_flow(cid, start or s, end or e)


@api.get("/companies/{cid}/reports/cash-flow/pdf")
async def rep_cf_pdf(cid: str, start: Optional[str] = None, end: Optional[str] = None,
                     user: dict = Depends(get_current_user)):
    await _require_company(user, cid)
    s, e = _default_range()
    data = await R.compute_cash_flow(cid, start or s, end or e)
    return Response(content=R.build_cash_flow_pdf(data), media_type="application/pdf",
                    headers={"Content-Disposition": "attachment; filename=cash_flow.pdf"})


@api.get("/companies/{cid}/reports/sales-tax")
async def rep_sales_tax(cid: str, start: Optional[str] = None, end: Optional[str] = None,
                        user: dict = Depends(get_current_user)):
    await _require_company(user, cid)
    s, e = _default_range()
    return await R.compute_sales_tax(cid, start or s, end or e)


@api.get("/companies/{cid}/reports/sales-tax/pdf")
async def rep_sales_tax_pdf(cid: str, start: Optional[str] = None, end: Optional[str] = None,
                            user: dict = Depends(get_current_user)):
    await _require_company(user, cid)
    s, e = _default_range()
    data = await R.compute_sales_tax(cid, start or s, end or e)
    return Response(content=R.build_sales_tax_pdf(data), media_type="application/pdf",
                    headers={"Content-Disposition": "attachment; filename=sales_tax_liability.pdf"})


@api.get("/companies/{cid}/reports/1099-summary")
async def rep_1099(cid: str, year: Optional[int] = None, user: dict = Depends(get_current_user)):
    await _require_company(user, cid)
    y = year or datetime.now(timezone.utc).year
    return await R.compute_1099_summary(cid, y)


@api.get("/companies/{cid}/reports/1099-summary/pdf")
async def rep_1099_pdf(cid: str, year: Optional[int] = None, user: dict = Depends(get_current_user)):
    await _require_company(user, cid)
    y = year or datetime.now(timezone.utc).year
    data = await R.compute_1099_summary(cid, y)
    return Response(content=R.build_1099_pdf(data), media_type="application/pdf",
                    headers={"Content-Disposition": "attachment; filename=1099_summary.pdf"})


# ----------------------- Onboarding -----------------------

@api.get("/companies/{cid}/onboarding")
async def get_onboarding(cid: str, user: dict = Depends(get_current_user)):
    await _require_company(user, cid)
    doc = await db.onboarding_state.find_one({"company_id": cid})
    if not doc:
        doc = {"id": str(uuid.uuid4()), "company_id": cid, "step": 0, "total_steps": 6,
               "complete": False, "answers": {}, "created_at": now_iso(), "updated_at": now_iso()}
        await db.onboarding_state.insert_one(doc)
    return {"onboarding": coerce(doc)}


@api.patch("/companies/{cid}/onboarding")
async def update_onboarding(cid: str, inp: OnboardingUpdate, user: dict = Depends(get_current_user)):
    await _require_company(user, cid)
    upd = {k: v for k, v in inp.model_dump(exclude_unset=True).items() if v is not None}
    upd["updated_at"] = now_iso()
    await db.onboarding_state.update_one({"company_id": cid}, {"$set": upd}, upsert=True)
    if inp.complete:
        await db.companies.update_one({"id": cid}, {"$set": {"onboarding_complete": True}})
    return {"ok": True}


@api.post("/companies/{cid}/onboarding/generate-coa")
async def generate_coa(cid: str, user: dict = Depends(get_current_user)):
    """AI-suggest additional industry-specific accounts."""
    company = await _require_company(user, cid)
    extras = await suggest_chart_of_accounts(company.get("business_type", ""),
                                             company.get("business_description", ""))
    # Filter out duplicates
    existing = await db.accounts.find({"company_id": cid}).to_list(2000)
    codes = {a["code"] for a in existing}
    added = 0
    for x in extras:
        if x["code"] in codes:
            continue
        await db.accounts.insert_one({
            "id": str(uuid.uuid4()), "company_id": cid, "code": x["code"], "name": x["name"],
            "type": x.get("type", "expense"), "subtype": x.get("subtype", "operating_expense"),
            "active": True, "balance": 0.0, "created_at": now_iso(), "updated_at": now_iso(),
        })
        added += 1
    await _log_ai(cid, "coa_generated", added)
    return {"added": added, "suggestions": extras}


@api.post("/companies/{cid}/onboarding/plaid/link-token")
async def plaid_link_token(cid: str, user: dict = Depends(get_current_user)):
    """Create a Plaid Link token for the user to link a bank account."""
    await _require_company(user, cid)
    # Build the public webhook URL from the backend's own public host if available
    public_base = os.environ.get("PUBLIC_BACKEND_URL", "").rstrip("/")
    webhook_url = f"{public_base}/api/plaid/webhook" if public_base else None
    try:
        token = plaid_service.create_link_token(
            user_id=f"{user['id']}::{cid}",
            client_name="Axiom Ledger",
            webhook_url=webhook_url,
        )
    except Exception as e:
        raise HTTPException(502, f"Plaid error: {e}")
    return {"link_token": token}


@api.post("/companies/{cid}/onboarding/plaid/exchange")
async def plaid_exchange(cid: str, payload: dict, user: dict = Depends(get_current_user)):
    """Exchange the public_token from Plaid Link for an access_token, persist Item, return accounts."""
    await _require_company(user, cid)
    public_token = payload.get("public_token")
    if not public_token:
        raise HTTPException(400, "public_token required")
    try:
        ex = plaid_service.exchange_public_token(public_token)
        accounts = plaid_service.get_accounts(ex["access_token"])
    except Exception as e:
        raise HTTPException(502, f"Plaid error: {e}")
    now = now_iso()
    # Upsert Plaid item per company (single-item MVP: replace prior)
    await db.plaid_items.update_one(
        {"company_id": cid, "user_id": user["id"]},
        {"$set": {
            "id": str(uuid.uuid4()), "company_id": cid, "user_id": user["id"],
            "item_id": ex["item_id"], "access_token": ex["access_token"],
            "cursor": None, "accounts": accounts,
            "created_at": now, "updated_at": now,
        }},
        upsert=True,
    )
    return {"accounts": accounts, "item_id": ex["item_id"]}


@api.post("/companies/{cid}/onboarding/plaid/import")
async def plaid_import(cid: str, payload: dict, user: dict = Depends(get_current_user)):
    """Import transactions for the selected Plaid account IDs via /transactions/sync."""
    await _require_company(user, cid)
    selected: list[str] = payload.get("account_ids") or []
    item = await db.plaid_items.find_one({"company_id": cid})
    if not item:
        raise HTTPException(400, "No linked Plaid item — link first")
    try:
        synced = plaid_service.sync_transactions(item["access_token"], item.get("cursor"))
    except Exception as e:
        raise HTTPException(502, f"Plaid sync error: {e}")
    await db.plaid_items.update_one({"id": item["id"]}, {"$set": {"cursor": synced["next_cursor"], "updated_at": now_iso()}})

    accts = await db.accounts.find({"company_id": cid}).to_list(2000)
    coa = [{"code": a["code"], "name": a["name"], "type": a["type"]} for a in accts]
    checking = next((a for a in accts if a["code"] == "1010"), None)
    if not checking:
        raise HTTPException(400, "Business Checking (1010) account not found")

    now = now_iso()
    imported = 0
    for t in synced["added"]:
        if selected and t["account_id"] not in selected:
            continue
        # Skip if we've already imported this Plaid transaction
        if await db.transactions.find_one({"company_id": cid, "plaid_transaction_id": t["transaction_id"]}):
            continue
        merchant = t.get("merchant_name") or t.get("name") or "Unknown"
        result = await categorize_transaction(merchant, t["amount"], t["name"], coa)
        acct = next((a for a in accts if a["code"] == result["account_code"]), None) or checking
        await db.transactions.insert_one({
            "id": str(uuid.uuid4()), "company_id": cid, "date": t["date"],
            "description": t["name"], "merchant": merchant, "amount": t["amount"],
            "bank_account_id": checking["id"], "bank_account_name": checking["name"],
            "category_account_id": acct["id"], "category_account_code": acct["code"],
            "category_account_name": acct["name"],
            "ai_confidence": round(result["confidence"], 2), "ai_reasoning": result["reasoning"],
            "needs_review": result["confidence"] < 0.80, "human_reviewed": False,
            "posted": result["confidence"] >= 0.80, "source": "plaid",
            "plaid_transaction_id": t["transaction_id"], "plaid_account_id": t["account_id"],
            "pending": t["pending"], "splits": [], "linked_invoice_id": None,
            "linked_bill_id": None, "linked_payment_id": None, "tags": [],
            "created_at": now, "updated_at": now,
        })
        imported += 1
    await _log_ai(cid, "categorize", imported)
    return {"imported": imported}


# ----------------------- Plaid webhook -----------------------

@api.post("/plaid/webhook")
async def plaid_webhook(payload: dict):
    """Receive Plaid webhook events (TRANSACTIONS: SYNC_UPDATES_AVAILABLE, DEFAULT_UPDATE, etc.).

    Public endpoint (no auth) — Plaid signs with JWT via `Plaid-Verification` header in production;
    for MVP we accept, look up the item_id, and trigger a background sync.
    """
    webhook_type = payload.get("webhook_type", "")
    webhook_code = payload.get("webhook_code", "")
    item_id = payload.get("item_id")
    if webhook_type != "TRANSACTIONS" or not item_id:
        return {"ok": True, "ignored": True}
    item = await db.plaid_items.find_one({"item_id": item_id})
    if not item:
        return {"ok": True, "unknown_item": True}
    if webhook_code in ("SYNC_UPDATES_AVAILABLE", "DEFAULT_UPDATE", "INITIAL_UPDATE", "HISTORICAL_UPDATE"):
        imported = await _sync_and_import(item["company_id"], item)
        return {"ok": True, "imported": imported, "webhook_code": webhook_code}
    if webhook_code == "TRANSACTIONS_REMOVED":
        removed_ids = payload.get("removed_transactions") or []
        for tid in removed_ids:
            await db.transactions.delete_one({
                "company_id": item["company_id"], "plaid_transaction_id": tid,
            })
        return {"ok": True, "removed": len(removed_ids)}
    return {"ok": True, "webhook_code": webhook_code}


@api.post("/companies/{cid}/plaid/manual-sync")
async def plaid_manual_sync(cid: str, user: dict = Depends(get_current_user)):
    """Force a Plaid sync (useful for demoing webhooks locally)."""
    await _require_company(user, cid)
    item = await db.plaid_items.find_one({"company_id": cid})
    if not item:
        raise HTTPException(400, "No Plaid item linked for this company")
    imported = await _sync_and_import(cid, item)
    return {"imported": imported}


@api.post("/companies/{cid}/onboarding/mock-plaid")
async def mock_plaid(cid: str, user: dict = Depends(get_current_user)):
    return {"accounts": [
        {"id": "plaid_1", "name": "Business Checking ...4821", "type": "depository",
         "subtype": "checking", "balance": 18452.30, "institution": "Chase Business"},
        {"id": "plaid_2", "name": "Business Savings ...9911", "type": "depository",
         "subtype": "savings", "balance": 42000.00, "institution": "Chase Business"},
        {"id": "plaid_3", "name": "Business Credit Card ...5533", "type": "credit",
         "subtype": "credit card", "balance": -3410.29, "institution": "Amex"},
    ]}


@api.post("/companies/{cid}/onboarding/import-plaid")
async def import_plaid(cid: str, account_ids: List[str], user: dict = Depends(get_current_user)):
    """Import mocked transactions from selected Plaid accounts, AI-categorize each."""
    await _require_company(user, cid)
    accts = await db.accounts.find({"company_id": cid}).to_list(2000)
    coa = [{"code": a["code"], "name": a["name"], "type": a["type"]} for a in accts]
    checking = next((a for a in accts if a["code"] == "1010"), None)
    if not checking:
        raise HTTPException(400, "Business Checking account not found")
    now = now_iso()
    imported = 0
    today = datetime.now(timezone.utc)
    from seed import SAMPLE_MERCHANTS
    running = 15000.00
    for _ in range(25):
        merchant, code, amount, conf = random.choice(SAMPLE_MERCHANTS)
        d = (today - timedelta(days=random.randint(0, 45))).date().isoformat()
        # Ask AI to categorize
        result = await categorize_transaction(merchant, amount, merchant, coa)
        acct = next((a for a in accts if a["code"] == result["account_code"]), None) or checking
        running += amount
        await db.transactions.insert_one({
            "id": str(uuid.uuid4()), "company_id": cid, "date": d,
            "description": merchant, "merchant": merchant, "amount": round(amount, 2),
            "bank_account_id": checking["id"], "bank_account_name": checking["name"],
            "category_account_id": acct["id"], "category_account_code": acct["code"],
            "category_account_name": acct["name"],
            "ai_confidence": round(result["confidence"], 2), "ai_reasoning": result["reasoning"],
            "needs_review": result["confidence"] < 0.80, "human_reviewed": False,
            "posted": result["confidence"] >= 0.80, "source": "plaid_mock",
            "bank_balance_after": round(running, 2),
            "splits": [], "linked_invoice_id": None, "linked_bill_id": None,
            "linked_payment_id": None, "tags": [],
            "created_at": now, "updated_at": now,
        })
        imported += 1
    await _log_ai(cid, "categorize", imported)
    return {"imported": imported}


@api.post("/companies/{cid}/onboarding/veryfi/upload")
async def veryfi_upload(cid: str, file: UploadFile = File(...), user: dict = Depends(get_current_user)):
    """Upload a bank/credit-card statement to Veryfi, OCR it, AI-categorize each line."""
    await _require_company(user, cid)
    file_bytes = await file.read()
    if len(file_bytes) > 20 * 1024 * 1024:
        raise HTTPException(400, "File too large (max 20MB)")
    try:
        veryfi_data = await veryfi_service.process_bank_statement(
            file_bytes, file.filename or "statement.pdf",
            file.content_type or "application/pdf",
        )
    except Exception as e:
        raise HTTPException(502, f"Veryfi error: {e}")

    lines = veryfi_service.extract_transactions(veryfi_data)
    accts = await db.accounts.find({"company_id": cid}).to_list(2000)
    coa = [{"code": a["code"], "name": a["name"], "type": a["type"]} for a in accts]
    checking = next((a for a in accts if a["code"] == "1010"), None)
    if not checking:
        raise HTTPException(400, "Business Checking (1010) account not found")

    now = now_iso()
    imported = 0
    for ln in lines:
        result = await categorize_transaction(ln["merchant"], ln["amount"], ln["description"], coa)
        acct = next((a for a in accts if a["code"] == result["account_code"]), None) or checking
        await db.transactions.insert_one({
            "id": str(uuid.uuid4()), "company_id": cid, "date": ln["date"] or datetime.now(timezone.utc).date().isoformat(),
            "description": f"{ln['description']} (Veryfi)", "merchant": ln["merchant"],
            "amount": ln["amount"], "bank_account_id": checking["id"],
            "bank_account_name": checking["name"], "category_account_id": acct["id"],
            "category_account_code": acct["code"], "category_account_name": acct["name"],
            "ai_confidence": round(result["confidence"], 2), "ai_reasoning": result["reasoning"],
            "needs_review": result["confidence"] < 0.80, "human_reviewed": False,
            "posted": result["confidence"] >= 0.80, "source": "veryfi",
            "splits": [], "linked_invoice_id": None, "linked_bill_id": None,
            "linked_payment_id": None, "tags": [],
            "created_at": now, "updated_at": now,
        })
        imported += 1
    await _log_ai(cid, "veryfi_ocr", imported)
    return {"imported": imported, "veryfi_document_id": veryfi_data.get("id")}


@api.post("/companies/{cid}/onboarding/mock-veryfi")
async def mock_veryfi(cid: str, user: dict = Depends(get_current_user)):
    """Simulate Veryfi statement upload: returns fake OCR'd transactions."""
    await _require_company(user, cid)
    accts = await db.accounts.find({"company_id": cid}).to_list(2000)
    coa = [{"code": a["code"], "name": a["name"], "type": a["type"]} for a in accts]
    checking = next((a for a in accts if a["code"] == "1010"), None)
    now = now_iso()
    from seed import SAMPLE_MERCHANTS
    imported = 0
    today = datetime.now(timezone.utc)
    for _ in range(8):
        merchant, code, amount, conf = random.choice(SAMPLE_MERCHANTS)
        d = (today - timedelta(days=random.randint(30, 90))).date().isoformat()
        result = await categorize_transaction(merchant, amount, merchant, coa)
        acct = next((a for a in accts if a["code"] == result["account_code"]), None) or checking
        await db.transactions.insert_one({
            "id": str(uuid.uuid4()), "company_id": cid, "date": d,
            "description": f"{merchant} (Veryfi)", "merchant": merchant, "amount": round(amount, 2),
            "bank_account_id": checking["id"] if checking else None,
            "bank_account_name": checking["name"] if checking else "",
            "category_account_id": acct["id"], "category_account_code": acct["code"],
            "category_account_name": acct["name"],
            "ai_confidence": round(result["confidence"], 2), "ai_reasoning": result["reasoning"],
            "needs_review": result["confidence"] < 0.80, "human_reviewed": False,
            "posted": result["confidence"] >= 0.80, "source": "veryfi_mock",
            "splits": [], "linked_invoice_id": None, "linked_bill_id": None,
            "linked_payment_id": None, "tags": [],
            "created_at": now, "updated_at": now,
        })
        imported += 1
    await _log_ai(cid, "veryfi_ocr", imported)
    return {"imported": imported}


# ----------------------- Reconciliation / Book Review / Close periods -----------------------

@api.get("/companies/{cid}/reconciliations")
async def list_recs(cid: str, user: dict = Depends(get_current_user)):
    await _require_company(user, cid)
    docs = await db.reconciliations.find({"company_id": cid}).sort("as_of", -1).to_list(500)
    return {"reconciliations": [coerce(d) for d in docs]}


@api.post("/companies/{cid}/reconciliations")
async def create_rec(cid: str, payload: dict, user: dict = Depends(get_current_user)):
    await _require_company(user, cid)
    rid = str(uuid.uuid4()); now = now_iso()
    doc = {"id": rid, "company_id": cid, **payload, "created_at": now, "updated_at": now}
    await db.reconciliations.insert_one(doc)
    return {"id": rid}


@api.get("/companies/{cid}/book-reviews")
async def list_reviews(cid: str, user: dict = Depends(get_current_user)):
    await _require_company(user, cid)
    docs = await db.book_reviews.find({"company_id": cid}).sort("period", -1).to_list(500)
    return {"reviews": [coerce(d) for d in docs]}


@api.post("/companies/{cid}/book-reviews")
async def create_review(cid: str, payload: dict, user: dict = Depends(get_current_user)):
    await _require_company(user, cid)
    rid = str(uuid.uuid4()); now = now_iso()
    await db.book_reviews.insert_one({"id": rid, "company_id": cid, **payload,
                                       "created_at": now, "updated_at": now})
    return {"id": rid}


@api.get("/companies/{cid}/close-periods")
async def list_close(cid: str, user: dict = Depends(get_current_user)):
    await _require_company(user, cid)
    docs = await db.close_periods.find({"company_id": cid}).sort("period_end", -1).to_list(500)
    return {"periods": [coerce(d) for d in docs]}


@api.post("/companies/{cid}/close-periods")
async def create_close(cid: str, payload: dict, user: dict = Depends(get_current_user)):
    await _require_company(user, cid)
    rid = str(uuid.uuid4()); now = now_iso()
    await db.close_periods.insert_one({"id": rid, "company_id": cid, **payload,
                                        "kind": payload.get("kind", "month"),
                                        "created_at": now, "updated_at": now})
    return {"id": rid}


# ----------------------- Inventory / Assets / Loans / Tags -----------------------

def _make_crud(collection_name: str, path_prefix: str):
    @api.get(f"/companies/{{cid}}/{path_prefix}")
    async def _list(cid: str, user: dict = Depends(get_current_user)):
        await _require_company(user, cid)
        docs = await db[collection_name].find({"company_id": cid}).to_list(1000)
        return {"items": [coerce(d) for d in docs]}

    @api.post(f"/companies/{{cid}}/{path_prefix}")
    async def _create(cid: str, payload: dict, user: dict = Depends(get_current_user)):
        await _require_company(user, cid)
        xid = str(uuid.uuid4()); now = now_iso()
        await db[collection_name].insert_one({"id": xid, "company_id": cid, **payload,
                                               "created_at": now, "updated_at": now})
        return {"id": xid}

    @api.patch(f"/companies/{{cid}}/{path_prefix}/{{xid}}")
    async def _update(cid: str, xid: str, payload: dict, user: dict = Depends(get_current_user)):
        await _require_company(user, cid)
        payload["updated_at"] = now_iso()
        await db[collection_name].update_one({"id": xid, "company_id": cid}, {"$set": payload})
        return {"ok": True}

    @api.delete(f"/companies/{{cid}}/{path_prefix}/{{xid}}")
    async def _delete(cid: str, xid: str, user: dict = Depends(get_current_user)):
        await _require_company(user, cid)
        await db[collection_name].delete_one({"id": xid, "company_id": cid})
        return {"ok": True}


_make_crud("inventory_items", "inventory")
_make_crud("assets", "assets")
_make_crud("loans", "loans")
_make_crud("tags", "tags")
_make_crud("communications", "communications")
_make_crud("connections", "connections")


# ----------------------- AI Chat (SSE) -----------------------

@api.post("/ai/chat/stream")
async def ai_chat_stream(inp: ChatIn, user: dict = Depends(get_current_user)):
    await _require_company(user, inp.company_id)
    session_id = inp.session_id or f"chat-{inp.company_id}-{user['id']}"
    now = now_iso()
    # persist user message
    await db.chat_messages.insert_one({
        "id": str(uuid.uuid4()), "session_id": session_id, "company_id": inp.company_id,
        "role": "user", "content": inp.message, "created_at": now,
    })
    context = None
    if inp.focused_transaction_id:
        t = await db.transactions.find_one({"id": inp.focused_transaction_id, "company_id": inp.company_id})
        if t:
            context = {
                "date": t.get("date"), "merchant": t.get("merchant"),
                "amount": t.get("amount"), "current_category": t.get("category_account_name"),
                "confidence": t.get("ai_confidence"), "needs_review": t.get("needs_review"),
            }

    # Always inject a snapshot of the books so the AI can answer real questions
    company = await db.companies.find_one({"id": inp.company_id})
    today = datetime.now(timezone.utc).date()
    ytd_start = today.replace(month=1, day=1).isoformat()
    ytd_end = today.isoformat()
    inc = await R.compute_income_statement(inp.company_id, ytd_start, ytd_end,
                                            company.get("reporting_basis", "accrual"))
    bs = await R.compute_balance_sheet(inp.company_id, ytd_end,
                                        company.get("reporting_basis", "accrual"))
    txn_count = await db.transactions.count_documents({"company_id": inp.company_id})
    flagged = await db.transactions.count_documents({"company_id": inp.company_id, "needs_review": True})
    book_context = {
        "company": company.get("name") if company else "",
        "business_type": company.get("business_type") if company else "",
        "reporting_basis": company.get("reporting_basis", "accrual") if company else "accrual",
        "period": f"{ytd_start} to {ytd_end}",
        "total_revenue_ytd": inc["total_revenue"],
        "total_expenses_ytd": inc["total_expense"],
        "net_income_ytd": inc["net_income"],
        "total_assets": bs["total_assets"],
        "total_liabilities": bs["total_liabilities"],
        "total_equity": bs["total_equity"],
        "transactions": txn_count,
        "needs_review": flagged,
    }
    combined_context = {"books": book_context}
    if context:
        combined_context["focused_transaction"] = context

    full_reply = {"text": ""}

    async def event_gen():
        async for chunk in chat_stream(session_id, inp.message, combined_context):
            full_reply["text"] += chunk
            yield f"data: {json.dumps({'delta': chunk})}\n\n"
        # save assistant msg
        await db.chat_messages.insert_one({
            "id": str(uuid.uuid4()), "session_id": session_id, "company_id": inp.company_id,
            "role": "assistant", "content": full_reply["text"], "created_at": now_iso(),
        })
        yield f"data: {json.dumps({'done': True})}\n\n"

    return StreamingResponse(event_gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@api.get("/ai/chat/history")
async def chat_history(company_id: str, session_id: Optional[str] = None,
                       user: dict = Depends(get_current_user)):
    await _require_company(user, company_id)
    sid = session_id or f"chat-{company_id}-{user['id']}"
    docs = await db.chat_messages.find({"session_id": sid}).sort("created_at", 1).to_list(200)
    return {"messages": [coerce(d) for d in docs], "session_id": sid}


# ----------------------- Health -----------------------

@api.get("/")
async def root():
    return {"service": "Axiom Ledger", "status": "ok"}


# ----------------------- CORS -----------------------

app.include_router(api)
app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=os.environ.get("CORS_ORIGINS", "*").split(","),
    allow_methods=["*"], allow_headers=["*"],
)


import logging
logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s")


@app.on_event("startup")
async def startup():
    # Ensure indexes
    await db.users.create_index("email", unique=True)
    await db.transactions.create_index([("company_id", 1), ("date", -1)])
    await db.accounts.create_index([("company_id", 1), ("code", 1)])


@app.on_event("shutdown")
async def shutdown():
    pass
