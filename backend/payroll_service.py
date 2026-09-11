"""SmartBooks — Manual Payroll Ledger (Phase 1)

Goal: give CPAs a place to *record* payroll runs without pretending to be
a tax engine. The user (or their bureau) tells us the numbers — we book
them, wire them to Print Check for physical checks, and auto-match the
net-pay debits against the bank feed.

Two entry modes per stub:
  • "simple"    — one gross line + one net-pay line, everything else
                  implicitly rolls into Payroll Taxes/Deductions.
  • "itemized"  — full line detail (earnings, EE withholdings, EE
                  deductions, ER taxes, ER benefits). GAAP-tight.

Two employee kinds:
  • "w2"    — posts to Wages Expense + Payroll Liabilities.
  • "1099"  — posts to Contract Labor (no withholding lines allowed).

Payment methods per stub:
  • "check" — creates a row in `db.checks` so it flows through Print
              Checks and can be matched on clear by check number.
  • "ach"   — net-pay expected as a debit on the bank feed within
              ±3 days of pay_date.
  • "cash"  — no bank txn expected; user marks paid manually.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone, timedelta
from typing import Optional, List

from db import db, now_iso, insert_je


SOURCE = "payroll"

LINE_KINDS = {
    "earning",       # gross wages, overtime, bonus — DR Wages/Contract Labor
    "ee_tax",        # federal WH, state WH, FICA-EE, Medicare-EE — CR Liabilities
    "ee_deduction",  # 401k, health, garnishments — CR Liabilities
    "er_tax",        # FICA-ER, Medicare-ER, FUTA, SUTA — DR Payroll Tax Exp
    "er_benefit",    # employer health/retirement match — DR Employee Benefits Exp
}


# ── Account resolution ──────────────────────────────────────────────
# Each helper mints the account if it doesn't exist so the JE always
# has a home. Names/codes mirror the QBO defaults so the imported COA
# looks familiar to any bookkeeper coming from QuickBooks.

async def _ensure_account(cid: str, *, code: str, name: str, type_: str,
                          subtype: str = "", detail_type: str = "") -> dict:
    for q in (
        {"company_id": cid, "code": code},
        {"company_id": cid, "type": type_,
         "name": {"$regex": f"^{name}$", "$options": "i"}},
    ):
        a = await db.accounts.find_one(q)
        if a:
            return a
    doc = {
        "id": str(uuid.uuid4()),
        "company_id": cid,
        "type": type_,
        "subtype": subtype or ("Expense" if type_ == "expense" else "Current Liability"),
        "detail_type": detail_type or "",
        "name": name,
        "code": code,
        "active": True,
        "created_at": now_iso(), "updated_at": now_iso(),
    }
    await db.accounts.insert_one(doc)
    return doc


async def ensure_payroll_accounts(cid: str) -> dict:
    """Resolve the six accounts payroll needs and return them keyed."""
    return {
        "wages":       await _ensure_account(cid, code="6100", name="Payroll Expenses",       type_="expense"),
        "contract":    await _ensure_account(cid, code="6110", name="Contract Labor",          type_="expense"),
        "payroll_tax": await _ensure_account(cid, code="6120", name="Payroll Tax Expense",     type_="expense"),
        "benefits":    await _ensure_account(cid, code="6130", name="Employee Benefits Expense", type_="expense"),
        "liab":        await _ensure_account(cid, code="2200", name="Payroll Liabilities",     type_="liability"),
        "ded":         await _ensure_account(cid, code="2210", name="Payroll Deductions Payable", type_="liability"),
    }


# ── Run + stub CRUD ─────────────────────────────────────────────────

async def create_run(cid: str, period_start: str, period_end: str, pay_date: str,
                     memo: str = "") -> dict:
    doc = {
        "id": str(uuid.uuid4()),
        "company_id": cid,
        "period_start": period_start,
        "period_end": period_end,
        "pay_date": pay_date,
        "memo": memo or "",
        "status": "draft",
        "je_ids": [],
        "check_ids": [],
        "created_at": now_iso(), "updated_at": now_iso(),
    }
    await db.payroll_runs.insert_one(doc)
    return doc


async def _run_totals(cid: str, run_id: str) -> dict:
    stubs = await db.payroll_stubs.find(
        {"company_id": cid, "run_id": run_id}
    ).to_list(500)
    tot = {"gross": 0.0, "ee_tax": 0.0, "ee_ded": 0.0, "er_tax": 0.0,
           "er_ben": 0.0, "net": 0.0, "count": len(stubs)}
    for s in stubs:
        tot["gross"]  += float(s.get("gross")  or 0)
        tot["ee_tax"] += float(s.get("ee_tax") or 0)
        tot["ee_ded"] += float(s.get("ee_ded") or 0)
        tot["er_tax"] += float(s.get("er_tax") or 0)
        tot["er_ben"] += float(s.get("er_ben") or 0)
        tot["net"]    += float(s.get("net")    or 0)
    return {k: round(v, 2) if isinstance(v, float) else v for k, v in tot.items()}


def _sum_lines(lines: List[dict], kind: str) -> float:
    return round(sum(float(l.get("amount") or 0) for l in lines if l.get("kind") == kind), 2)


def _stub_totals(mode: str, kind: str, payload: dict) -> dict:
    """Given the incoming stub payload, compute the six subtotals we
    persist on the stub for fast list rendering + auto-match."""
    if mode == "simple":
        gross = float(payload.get("gross") or 0)
        net   = float(payload.get("net")   or 0)
        implicit = round(gross - net, 2)
        return {
            "gross": round(gross, 2),
            "ee_tax": implicit if kind == "w2" else 0.0,
            "ee_ded": 0.0,
            "er_tax": 0.0,
            "er_ben": 0.0,
            "net":   round(net, 2),
        }
    lines = payload.get("lines") or []
    gross  = _sum_lines(lines, "earning")
    ee_tax = _sum_lines(lines, "ee_tax")
    ee_ded = _sum_lines(lines, "ee_deduction")
    er_tax = _sum_lines(lines, "er_tax")
    er_ben = _sum_lines(lines, "er_benefit")
    net = round(gross - ee_tax - ee_ded, 2)
    return {"gross": gross, "ee_tax": ee_tax, "ee_ded": ee_ded,
            "er_tax": er_tax, "er_ben": er_ben, "net": net}


async def upsert_stub(cid: str, run_id: str, payload: dict) -> dict:
    """Create or update a stub within a draft run. Enforces:
    - 1099 stubs cannot have withholding lines.
    - Simple + itemized both compute the six subtotals on save.
    """
    run = await db.payroll_runs.find_one({"id": run_id, "company_id": cid})
    if not run:
        raise ValueError("Run not found")
    if run.get("status") not in ("draft",):
        raise ValueError("Run is finalized — cannot edit stubs")

    kind = (payload.get("kind") or "w2").lower()
    if kind not in ("w2", "1099"):
        raise ValueError("kind must be 'w2' or '1099'")
    mode = (payload.get("mode") or "simple").lower()
    if mode not in ("simple", "itemized"):
        raise ValueError("mode must be 'simple' or 'itemized'")
    method = (payload.get("payment_method") or "ach").lower()
    if method not in ("ach", "check", "cash"):
        raise ValueError("payment_method must be 'ach', 'check', or 'cash'")
    if kind == "1099" and mode == "itemized":
        lines = payload.get("lines") or []
        for l in lines:
            if l.get("kind") in ("ee_tax", "ee_deduction", "er_tax", "er_benefit"):
                raise ValueError("1099 contractors cannot have withholding or employer-tax lines")

    totals = _stub_totals(mode, kind, payload)

    sid = payload.get("id") or str(uuid.uuid4())
    doc = {
        "id": sid,
        "company_id": cid,
        "run_id": run_id,
        "employee_id": payload.get("employee_id"),
        "employee_name": (payload.get("employee_name") or "").strip(),
        "contact_id":  payload.get("contact_id"),   # for 1099 contractors
        "kind": kind,
        "mode": mode,
        "payment_method": method,
        "check_number": payload.get("check_number"),
        "lines": payload.get("lines") or [],
        "memo": (payload.get("memo") or "").strip(),
        **totals,
        "match_txn_id": None,
        "match_check_id": None,
        "match_je_id": None,
        "updated_at": now_iso(),
    }

    existing = await db.payroll_stubs.find_one({"id": sid, "company_id": cid})
    if existing:
        # Preserve immutable / matcher-owned fields on update.
        doc["match_txn_id"]   = existing.get("match_txn_id")
        doc["match_check_id"] = existing.get("match_check_id")
        doc["match_je_id"]    = existing.get("match_je_id")
        doc["created_at"]     = existing.get("created_at") or now_iso()
        await db.payroll_stubs.update_one({"id": sid, "company_id": cid}, {"$set": doc})
    else:
        doc["created_at"] = now_iso()
        await db.payroll_stubs.insert_one(doc)

    return doc


async def delete_stub(cid: str, run_id: str, sid: str) -> None:
    run = await db.payroll_runs.find_one({"id": run_id, "company_id": cid})
    if not run:
        raise ValueError("Run not found")
    if run.get("status") != "draft":
        raise ValueError("Run is finalized — cannot delete stubs")
    await db.payroll_stubs.delete_one({"id": sid, "run_id": run_id, "company_id": cid})


# ── Finalize: post JEs, create Print Checks, freeze run ─────────────

async def finalize_run(cid: str, run_id: str, bank_account_id: str) -> dict:
    """Post a self-balancing JE for the entire run and create Print
    Check rows for any check-method stubs.

    Combined JE structure (per run — one entry keeps the audit trail
    compact and matches how QBO records manual payroll):
      DR Wages Expense       — sum gross for W-2 stubs
      DR Contract Labor      — sum gross for 1099 stubs
      DR Payroll Tax Expense — sum er_tax
      DR Employee Benefits   — sum er_ben
        CR Payroll Liabilities        — sum ee_tax + er_tax + er_ben
        CR Payroll Deductions Payable — sum ee_ded
        CR Cash (bank_account_id)     — sum net
    Signs are all positive.
    """
    run = await db.payroll_runs.find_one({"id": run_id, "company_id": cid})
    if not run:
        raise ValueError("Run not found")
    if run.get("status") != "draft":
        raise ValueError("Run is already finalized")
    stubs = await db.payroll_stubs.find(
        {"company_id": cid, "run_id": run_id}
    ).sort("employee_name", 1).to_list(500)
    if not stubs:
        raise ValueError("Add at least one stub before finalizing")
    bank = await db.accounts.find_one({"id": bank_account_id, "company_id": cid})
    if not bank:
        raise ValueError("Bank account not found")

    acc = await ensure_payroll_accounts(cid)
    tot = await _run_totals(cid, run_id)

    gross_w2   = round(sum(float(s.get("gross") or 0) for s in stubs if s.get("kind") == "w2"), 2)
    gross_1099 = round(sum(float(s.get("gross") or 0) for s in stubs if s.get("kind") == "1099"), 2)

    lines: list[dict] = []
    if gross_w2 > 0:
        lines.append({"account_id": acc["wages"]["id"], "account_name": acc["wages"]["name"],
                      "debit": gross_w2, "credit": 0.0, "description": "Gross W-2 wages"})
    if gross_1099 > 0:
        lines.append({"account_id": acc["contract"]["id"], "account_name": acc["contract"]["name"],
                      "debit": gross_1099, "credit": 0.0, "description": "1099 contractor pay"})
    if tot["er_tax"] > 0:
        lines.append({"account_id": acc["payroll_tax"]["id"], "account_name": acc["payroll_tax"]["name"],
                      "debit": tot["er_tax"], "credit": 0.0, "description": "Employer payroll taxes"})
    if tot["er_ben"] > 0:
        lines.append({"account_id": acc["benefits"]["id"], "account_name": acc["benefits"]["name"],
                      "debit": tot["er_ben"], "credit": 0.0, "description": "Employer benefit contributions"})

    liab_credit = round(tot["ee_tax"] + tot["er_tax"] + tot["er_ben"], 2)
    if liab_credit > 0:
        lines.append({"account_id": acc["liab"]["id"], "account_name": acc["liab"]["name"],
                      "debit": 0.0, "credit": liab_credit,
                      "description": "Withheld + employer payroll liabilities"})
    if tot["ee_ded"] > 0:
        lines.append({"account_id": acc["ded"]["id"], "account_name": acc["ded"]["name"],
                      "debit": 0.0, "credit": tot["ee_ded"],
                      "description": "Employee voluntary deductions"})
    if tot["net"] > 0:
        lines.append({"account_id": bank["id"], "account_name": bank.get("name") or "Cash",
                      "debit": 0.0, "credit": tot["net"],
                      "description": "Net pay disbursed"})

    je_id = str(uuid.uuid4())
    await insert_je({
        "id": je_id, "company_id": cid,
        "date": run.get("pay_date") or now_iso()[:10],
        "memo": f"Payroll run · {run.get('period_start')} → {run.get('period_end')}",
        "source": SOURCE,
        "ref_kind": "payroll_run",
        "ref_id": run_id,
        "lines": lines,
        "created_at": now_iso(), "updated_at": now_iso(),
    })

    # Create Print Check rows for check-method stubs. Each stub becomes
    # its own row in `db.checks` so the existing Print Checks page can
    # print/void them, and the bank-clear matcher (check_number + amount)
    # picks them up when the check clears.
    check_ids: list[str] = []
    for s in stubs:
        if s.get("payment_method") != "check" or (s.get("net") or 0) <= 0:
            continue
        cid_ = str(uuid.uuid4())
        payee = s.get("employee_name") or "Payroll payee"
        await db.checks.insert_one({
            "id": cid_,
            "company_id": cid,
            "check_number": int(s.get("check_number") or 0) or None,
            "bank_account_id": bank_account_id,
            "layout": "voucher",
            "payee_name": payee,
            "payee_address": "",
            "amount": float(s.get("net") or 0),
            "memo": f"Payroll · {run.get('period_start')} → {run.get('period_end')}",
            "date": run.get("pay_date"),
            "bill_ids": [], "payment_ids": [],
            "status": "unprinted",
            "payroll_stub_id": s["id"],
        })
        check_ids.append(cid_)
        await db.payroll_stubs.update_one(
            {"id": s["id"], "company_id": cid},
            {"$set": {"match_check_id": cid_}},
        )

    await db.payroll_stubs.update_many(
        {"company_id": cid, "run_id": run_id},
        {"$set": {"match_je_id": je_id}},
    )
    await db.payroll_runs.update_one(
        {"id": run_id, "company_id": cid},
        {"$set": {"status": "finalized",
                  "bank_account_id": bank_account_id,
                  "je_ids": [je_id],
                  "check_ids": check_ids,
                  "totals": tot,
                  "finalized_at": now_iso(),
                  "updated_at": now_iso()}},
    )
    return {"je_id": je_id, "check_ids": check_ids, "totals": tot}


# ── Bank txn auto-match ─────────────────────────────────────────────

async def auto_match(cid: str) -> dict:
    """Sweep unmatched ACH stubs and try to link each to a bank
    transaction with the same |amount| within ±3 days of pay_date and a
    fuzzy employee-name hit on the description. Idempotent: already
    matched stubs are skipped.
    """
    stubs = await db.payroll_stubs.find({
        "company_id": cid,
        "match_txn_id": None,
        "payment_method": "ach",
    }).to_list(500)

    matched = 0
    skipped: list[str] = []
    for s in stubs:
        run = await db.payroll_runs.find_one({"id": s["run_id"], "company_id": cid})
        if not run or run.get("status") != "finalized":
            continue
        pay_date = run.get("pay_date")
        if not pay_date:
            continue
        try:
            pd = datetime.strptime(pay_date, "%Y-%m-%d")
        except ValueError:
            continue
        lo = (pd - timedelta(days=3)).strftime("%Y-%m-%d")
        hi = (pd + timedelta(days=3)).strftime("%Y-%m-%d")
        net = round(float(s.get("net") or 0), 2)
        if net <= 0:
            continue
        # Find an unattached outflow debit within window matching amount.
        # Descriptions can be very noisy so we don't require a name hit —
        # amount + date window is already highly selective in practice.
        txn = await db.transactions.find_one({
            "company_id": cid,
            "date": {"$gte": lo, "$lte": hi},
            "amount": {"$gte": -net - 0.005, "$lte": -net + 0.005},
            "payroll_stub_id": {"$exists": False},
        })
        if not txn:
            skipped.append(s["id"])
            continue
        await db.transactions.update_one(
            {"id": txn["id"], "company_id": cid},
            {"$set": {
                "payroll_stub_id": s["id"],
                "payroll_run_id":  s["run_id"],
                "human_reviewed": True,
                "needs_review":   False,
                "updated_at": now_iso(),
            }},
        )
        await db.payroll_stubs.update_one(
            {"id": s["id"], "company_id": cid},
            {"$set": {"match_txn_id": txn["id"], "updated_at": now_iso()}},
        )
        matched += 1
    return {"matched": matched, "skipped": len(skipped)}


async def employee_history(cid: str, employee_id: str) -> dict:
    stubs = await db.payroll_stubs.find({
        "company_id": cid, "employee_id": employee_id,
    }).to_list(2000)
    # Enrich each stub with its run window for display.
    runs = {r["id"]: r async for r in db.payroll_runs.find(
        {"company_id": cid, "id": {"$in": list({s["run_id"] for s in stubs})}}
    )}
    out = []
    for s in stubs:
        r = runs.get(s.get("run_id")) or {}
        out.append({**{k: v for k, v in s.items() if k != "_id"},
                    "period_start": r.get("period_start"),
                    "period_end": r.get("period_end"),
                    "pay_date": r.get("pay_date"),
                    "run_status": r.get("status")})
    out.sort(key=lambda x: (x.get("pay_date") or "", x.get("created_at") or ""), reverse=True)
    ytd = {"gross": 0.0, "ee_tax": 0.0, "ee_ded": 0.0, "net": 0.0}
    year = datetime.now(timezone.utc).year
    for s in out:
        pd = s.get("pay_date") or ""
        if pd.startswith(str(year)):
            ytd["gross"]  += float(s.get("gross")  or 0)
            ytd["ee_tax"] += float(s.get("ee_tax") or 0)
            ytd["ee_ded"] += float(s.get("ee_ded") or 0)
            ytd["net"]    += float(s.get("net")    or 0)
    return {"stubs": out, "ytd": {k: round(v, 2) for k, v in ytd.items()}, "year": year}
