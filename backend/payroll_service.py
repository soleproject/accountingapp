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


# ── Liability aging + pay ────────────────────────────────────────────

async def liability_aging(cid: str) -> dict:
    """Roll up outstanding payroll liabilities by run and by account.

    For each finalized run we compute:
      liability_owed = ee_tax + er_tax + er_ben + ee_ded   (as originally credited)
      liability_paid = sum of payments already made against this run
      outstanding    = owed - paid

    Runs with `outstanding > 0` show up on the aging screen. This is
    intentionally simpler than a true agency-level aging (which would
    require breaking each stub's `ee_tax` line into Fed/FICA/State/
    Medicare buckets) — pros can pick which category to pay when they
    hit the Pay button. Phase 1B keeps the granularity at "the run".
    """
    runs = await db.payroll_runs.find(
        {"company_id": cid, "status": "finalized"}
    ).sort("pay_date", 1).to_list(500)
    pays = await db.payroll_liability_payments.find(
        {"company_id": cid}
    ).to_list(2000)
    paid_by_run: dict[str, dict] = {}
    for p in pays:
        rid = p.get("run_id")
        if not rid:
            continue
        b = paid_by_run.setdefault(rid, {"ee_tax": 0.0, "er_tax": 0.0,
                                         "er_ben": 0.0, "ee_ded": 0.0,
                                         "total": 0.0, "payments": []})
        for k in ("ee_tax", "er_tax", "er_ben", "ee_ded"):
            b[k] += float(p.get(k) or 0)
        b["total"] += float(p.get("total") or 0)
        b["payments"].append({k: v for k, v in p.items() if k != "_id"})

    aging: list[dict] = []
    totals = {"owed": 0.0, "paid": 0.0, "outstanding": 0.0}
    for r in runs:
        t = r.get("totals") or {}
        owed = {k: float(t.get(k) or 0) for k in ("ee_tax", "er_tax",
                                                   "er_ben", "ee_ded")}
        owed_total = round(sum(owed.values()), 2)
        paid = paid_by_run.get(r["id"]) or {
            "ee_tax": 0.0, "er_tax": 0.0, "er_ben": 0.0, "ee_ded": 0.0,
            "total": 0.0, "payments": []
        }
        out = {k: round(owed[k] - float(paid.get(k) or 0), 2) for k in owed}
        out_total = round(owed_total - float(paid.get("total") or 0), 2)
        if out_total > 0.005 or owed_total > 0.005:
            aging.append({
                "run_id": r["id"],
                "pay_date": r.get("pay_date"),
                "period_start": r.get("period_start"),
                "period_end":   r.get("period_end"),
                "owed":  {**owed, "total": owed_total},
                "paid":  {k: round(float(paid.get(k) or 0), 2)
                          for k in ("ee_tax", "er_tax", "er_ben",
                                    "ee_ded", "total")},
                "outstanding": {**out, "total": out_total},
                "payments": paid.get("payments") or [],
            })
        totals["owed"]        += owed_total
        totals["paid"]        += float(paid.get("total") or 0)
        totals["outstanding"] += out_total
    return {"rows": aging,
            "totals": {k: round(v, 2) for k, v in totals.items()}}


async def pay_liability(
    cid: str, run_id: str, bank_account_id: str, *,
    ee_tax: float = 0.0, er_tax: float = 0.0,
    er_ben: float = 0.0, ee_ded: float = 0.0,
    date: str = "", agency: str = "", memo: str = "",
) -> dict:
    """Record a remittance to a tax agency (or vendor for deductions).

    Posts a JE:
      DR Payroll Liabilities        — (ee_tax + er_tax + er_ben)
      DR Payroll Deductions Payable — (ee_ded)
        CR Cash / Bank              — total

    We also insert a `payroll_liability_payments` row so the aging can
    subtract what's been paid. Zero-amount categories are simply not
    added to the JE (still valid because everything else must balance).
    """
    run = await db.payroll_runs.find_one({"id": run_id, "company_id": cid})
    if not run:
        raise ValueError("Run not found")
    bank = await db.accounts.find_one({"id": bank_account_id, "company_id": cid})
    if not bank:
        raise ValueError("Bank account not found")

    amt = {
        "ee_tax": round(float(ee_tax or 0), 2),
        "er_tax": round(float(er_tax or 0), 2),
        "er_ben": round(float(er_ben or 0), 2),
        "ee_ded": round(float(ee_ded or 0), 2),
    }
    total = round(sum(amt.values()), 2)
    if total <= 0:
        raise ValueError("Enter at least one non-zero amount to pay")

    # Guard: can't overpay a given category against the run.
    t = run.get("totals") or {}
    existing = await db.payroll_liability_payments.find(
        {"company_id": cid, "run_id": run_id}
    ).to_list(500)
    prior = {k: sum(float(p.get(k) or 0) for p in existing)
             for k in ("ee_tax", "er_tax", "er_ben", "ee_ded")}
    for k, v in amt.items():
        already = prior[k]
        owed = float(t.get(k) or 0)
        if round(already + v, 2) > round(owed + 0.005, 2):
            raise ValueError(
                f"Overpayment: {k.replace('_', ' ')} owed {owed:.2f}, "
                f"already paid {already:.2f}, trying to pay {v:.2f}"
            )

    acc = await ensure_payroll_accounts(cid)
    liab_dr = round(amt["ee_tax"] + amt["er_tax"] + amt["er_ben"], 2)
    ded_dr  = amt["ee_ded"]

    lines: list[dict] = []
    if liab_dr > 0:
        lines.append({"account_id": acc["liab"]["id"],
                      "account_name": acc["liab"]["name"],
                      "debit": liab_dr, "credit": 0.0,
                      "description": agency or "Payroll tax remittance"})
    if ded_dr > 0:
        lines.append({"account_id": acc["ded"]["id"],
                      "account_name": acc["ded"]["name"],
                      "debit": ded_dr, "credit": 0.0,
                      "description": agency or "Employee deduction remittance"})
    lines.append({"account_id": bank["id"],
                  "account_name": bank.get("name") or "Cash",
                  "debit": 0.0, "credit": total,
                  "description": agency or "Payroll liability payment"})

    je_id = str(uuid.uuid4())
    posted_date = (date or run.get("pay_date") or now_iso()[:10])[:10]
    await insert_je({
        "id": je_id, "company_id": cid,
        "date": posted_date,
        "memo": memo or f"Pay payroll liability · {agency or 'agency'}",
        "source": SOURCE,
        "ref_kind": "payroll_liability_payment",
        "ref_id": run_id,
        "lines": lines,
        "created_at": now_iso(), "updated_at": now_iso(),
    })

    pid = str(uuid.uuid4())
    await db.payroll_liability_payments.insert_one({
        "id": pid,
        "company_id": cid,
        "run_id": run_id,
        "bank_account_id": bank_account_id,
        "agency": agency or "",
        "memo":   memo or "",
        "date":   posted_date,
        "je_id":  je_id,
        "match_txn_id": None,
        **amt,
        "total": total,
        "created_at": now_iso(), "updated_at": now_iso(),
    })
    return {"payment_id": pid, "je_id": je_id, "total": total}


# ── Pay stub PDF ─────────────────────────────────────────────────────

def build_stub_pdf(*, stub: dict, run: dict, company: dict | None = None) -> bytes:
    """Compact, one-page pay stub. Kept in this module so callers only
    have to import `payroll_service`.

    Structure:
      • Header — company name + PAY STUB label + pay date
      • Employee block + Pay period block (two columns)
      • Earnings & deductions grid
      • Totals row (Gross / Total taxes / Total deductions / Net pay)
      • Legal footer disclaimer
    """
    from io import BytesIO
    from reportlab.lib.pagesizes import LETTER
    from reportlab.lib import colors
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.lib.units import inch
    from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle

    def _m(v):
        try: return f"${float(v):,.2f}"
        except Exception: return "$0.00"

    buf = BytesIO()
    pdf = SimpleDocTemplate(
        buf, pagesize=LETTER,
        leftMargin=0.6 * inch, rightMargin=0.6 * inch,
        topMargin=0.5 * inch, bottomMargin=0.5 * inch,
    )
    styles = getSampleStyleSheet()
    subtle = ParagraphStyle("s", parent=styles["Normal"], fontSize=9, textColor=colors.HexColor("#64748B"))
    label  = ParagraphStyle("l", parent=styles["Normal"], fontSize=8,
                            textColor=colors.HexColor("#64748B"), spaceAfter=2)
    val    = ParagraphStyle("v", parent=styles["Normal"], fontSize=11, textColor=colors.HexColor("#0F172A"))

    story: list = []

    company = company or {}
    firm = company.get("name") or "Employer"
    heading = ParagraphStyle("h", parent=styles["Heading1"], fontSize=22, spaceAfter=4,
                             textColor=colors.HexColor("#0F172A"))
    story.append(Paragraph(f"<b>{firm}</b>", heading))
    story.append(Paragraph(f"PAY STUB · {run.get('pay_date') or ''}", subtle))
    story.append(Spacer(1, 0.15 * inch))

    # Employee + period two-column block.
    left_cells = [
        [Paragraph("EMPLOYEE", label)],
        [Paragraph(f"<b>{stub.get('employee_name') or 'Employee'}</b>", val)],
        [Paragraph(f"Kind: {(stub.get('kind') or 'w2').upper()}<br/>"
                   f"Payment: {(stub.get('payment_method') or 'ach').upper()}"
                   + (f" · Check #{stub.get('check_number')}" if stub.get('check_number') else ""),
                   subtle)],
    ]
    right_cells = [
        [Paragraph("PAY PERIOD", label)],
        [Paragraph(f"<b>{run.get('period_start') or ''} → {run.get('period_end') or ''}</b>", val)],
        [Paragraph(f"Pay date: {run.get('pay_date') or ''}", subtle)],
    ]
    two_col = Table(
        [[Table(left_cells, colWidths=[3.4 * inch]),
          Table(right_cells, colWidths=[3.4 * inch])]],
        colWidths=[3.6 * inch, 3.6 * inch],
    )
    two_col.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
    ]))
    story.append(two_col)
    story.append(Spacer(1, 0.2 * inch))

    # Lines table. In simple mode we synthesise a single earnings row +
    # (for W-2) a single implicit-withholding row so the PDF is still
    # useful without asking the user to fully itemise.
    mode = stub.get("mode") or "simple"
    kind = stub.get("kind") or "w2"
    lines = stub.get("lines") or []
    display: list[tuple[str, str, str]] = []  # (bucket, label, amount)

    if mode == "simple" or kind == "1099":
        gross = float(stub.get("gross") or 0)
        display.append(("Earnings", "Gross wages", _m(gross)))
        if kind == "w2":
            implicit = round(gross - float(stub.get("net") or 0), 2)
            if implicit > 0:
                display.append(("Taxes & deductions", "Withholding (implicit)", _m(implicit)))
    else:
        bucket_map = {
            "earning":       "Earnings",
            "ee_tax":        "Taxes & deductions",
            "ee_deduction":  "Taxes & deductions",
            "er_tax":        "Employer contributions",
            "er_benefit":    "Employer contributions",
        }
        for l in lines:
            bucket = bucket_map.get(l.get("kind") or "", "Other")
            display.append((bucket, l.get("label") or l.get("kind") or "—",
                            _m(l.get("amount") or 0)))

    data = [[Paragraph("<b>Type</b>", subtle),
             Paragraph("<b>Description</b>", subtle),
             Paragraph("<b>Amount</b>", subtle)]]
    for row in display:
        data.append([Paragraph(row[0], subtle),
                     Paragraph(row[1], val),
                     Paragraph(row[2], ParagraphStyle("r", parent=val, alignment=2))])
    tbl = Table(data, colWidths=[1.7 * inch, 4.0 * inch, 1.5 * inch])
    tbl.setStyle(TableStyle([
        ("LINEBELOW", (0, 0), (-1, 0), 0.8, colors.HexColor("#CBD5E1")),
        ("LINEBELOW", (0, -1), (-1, -1), 0.8, colors.HexColor("#CBD5E1")),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1),
         [colors.white, colors.HexColor("#F8FAFC")]),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING",    (0, 0), (-1, -1), 4),
    ]))
    story.append(tbl)
    story.append(Spacer(1, 0.15 * inch))

    # Totals strip.
    totals = [
        ["Gross",           _m(stub.get("gross"))],
        ["Total taxes",     _m(stub.get("ee_tax"))],
        ["Total deductions",_m(stub.get("ee_ded"))],
        ["Net pay",         _m(stub.get("net"))],
    ]
    t_tbl = Table(totals, colWidths=[4.0 * inch, 3.2 * inch])
    t_tbl.setStyle(TableStyle([
        ("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold"),
        ("BACKGROUND", (0, -1), (-1, -1), colors.HexColor("#ECFDF5")),
        ("TEXTCOLOR",  (0, -1), (-1, -1), colors.HexColor("#065F46")),
        ("ALIGN", (1, 0), (1, -1), "RIGHT"),
        ("BOX",   (0, 0), (-1, -1), 0.5, colors.HexColor("#CBD5E1")),
        ("INNERGRID", (0, 0), (-1, -1), 0.25, colors.HexColor("#E2E8F0")),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING",    (0, 0), (-1, -1), 6),
    ]))
    story.append(t_tbl)
    story.append(Spacer(1, 0.2 * inch))
    story.append(Paragraph(
        "This stub is a record of pay only. Tax filings are handled separately.",
        subtle,
    ))

    pdf.build(story)
    return buf.getvalue()


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
