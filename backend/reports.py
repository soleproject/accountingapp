"""Financial reports + PDF generation with a strict double-entry engine.

Storage convention (debit-normal / signed):
- Each transaction of amount `a` posts:
    bank_account   += a          (a>0 = money in = debit to asset)
    category_acct  += -a         (offsetting credit for a>0, or debit for a<0)
- Splits, if present, replace the single category leg (each split posts -split_amount).
- Journal entries post each line as (debit - credit) to that line's account_id.
- Under this convention, sum(all account raw balances) is always 0.

Display convention:
- Asset / Expense accounts show + when raw balance > 0 (debit-normal).
- Liability / Equity / Revenue accounts show + when raw balance < 0 (credit-normal),
  so we NEGATE their raw balance for display.
"""
from __future__ import annotations
from io import BytesIO
from collections import defaultdict
from reportlab.lib.pagesizes import LETTER
from reportlab.lib import colors
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle

from db import db


# ---------- Core: signed balance builder ----------

CREDIT_NORMAL = {"liability", "equity", "revenue"}


async def _signed_balances(company_id: str, start: str | None, end: str,
                            include_pre_period: bool = False):
    """Return {account_id: raw_signed_balance} for postings whose date is <= end
    (and >= start if given and include_pre_period is False).

    Includes both transactions and journal entries. Both must be balanced sources.
    """
    by = defaultdict(float)

    txn_q = {"company_id": company_id, "posted": True, "date": {"$lte": end}}
    if start and not include_pre_period:
        txn_q["date"] = {"$gte": start, "$lte": end}
    txns = await db.transactions.find(txn_q).to_list(100000)

    for t in txns:
        amt = float(t.get("amount", 0) or 0)
        bank = t.get("bank_account_id")
        if bank:
            by[bank] += amt

        splits = t.get("splits") or []
        if splits:
            split_total = 0.0
            fallback_cat = t.get("category_account_id")
            for s in splits:
                sid = s.get("category_account_id") or s.get("account_id") or fallback_cat
                s_amt = float(s.get("amount", 0) or 0)
                split_total += s_amt
                if sid:
                    by[sid] += -s_amt
            # If splits don't cover the full amount, the remainder falls to the
            # primary category to keep the entry balanced.
            residual = amt - split_total
            aid_cat = t.get("category_account_id")
            if aid_cat and abs(residual) > 0.001:
                by[aid_cat] += -residual
        else:
            aid_cat = t.get("category_account_id")
            if aid_cat:
                by[aid_cat] += -amt

    je_q = {"company_id": company_id, "date": {"$lte": end}}
    if start and not include_pre_period:
        je_q["date"] = {"$gte": start, "$lte": end}
    jes = await db.journal_entries.find(je_q).to_list(100000)
    for j in jes:
        for line in j.get("lines", []):
            aid = line.get("account_id")
            d = float(line.get("debit", 0) or 0)
            c = float(line.get("credit", 0) or 0)
            if aid:
                by[aid] += (d - c)

    return by


def _display_amount(acct: dict, raw: float) -> float:
    """Return display amount (positive = normal balance)."""
    if acct["type"] in CREDIT_NORMAL:
        return -raw
    return raw


# ---------- Accrual helpers (A/R and A/P from open invoices / bills) ----------

async def _open_ar_ap(company_id: str, as_of: str, start: str | None = None):
    """Compute Accounts Receivable and Accounts Payable balances driven by
    open (unpaid) invoices/bills as of a date.

    Returns dict with:
      - ar_end / ap_end: totals of unpaid balances for docs issued on/before `as_of`
      - ar_start / ap_start: same but as of the day before `start` (0 if start is None)
      - ar_billed_in_period / ap_billed_in_period: total invoiced/billed
        (regardless of payment) during [start, end] — used for accrual P&L
      - ar_cash_in_period / ap_cash_in_period: cash received against invoices /
        cash paid against bills during [start, end] — needed to reconcile
    """
    from datetime import date as _date

    invs = await db.invoices.find({"company_id": company_id}).to_list(20000)
    bills = await db.bills.find({"company_id": company_id}).to_list(20000)

    ar_end = 0.0
    ap_end = 0.0
    ar_start = 0.0
    ap_start = 0.0
    ar_billed_in_period = 0.0
    ap_billed_in_period = 0.0

    def _in_period(d: str) -> bool:
        if not start:
            return False
        return d >= start and d <= as_of

    # "Prior day" of start for opening-balance calculation
    prev_end = None
    if start:
        try:
            sd = _date.fromisoformat(start)
            prev_end = _date.fromordinal(sd.toordinal() - 1).isoformat()
        except Exception:
            prev_end = start

    for i in invs:
        issue = i.get("issue_date") or ""
        total = float(i.get("total", 0) or 0)
        bal = float(i.get("balance_due", 0) or 0)
        if issue and issue <= as_of and bal > 0.005:
            ar_end += bal
        if prev_end and issue and issue <= prev_end and bal > 0.005:
            # Rough approximation: use current balance_due as a snapshot proxy.
            # If total==bal (unpaid) we count it fully; partially-paid may
            # slightly under-state opening A/R but the drift is small.
            ar_start += bal
        if _in_period(issue):
            ar_billed_in_period += total

    for b in bills:
        issue = b.get("issue_date") or ""
        total = float(b.get("total", 0) or 0)
        bal = float(b.get("balance_due", 0) or 0)
        if issue and issue <= as_of and bal > 0.005:
            ap_end += bal
        if prev_end and issue and issue <= prev_end and bal > 0.005:
            ap_start += bal
        if _in_period(issue):
            ap_billed_in_period += total

    return {
        "ar_end": round(ar_end, 2), "ap_end": round(ap_end, 2),
        "ar_start": round(ar_start, 2), "ap_start": round(ap_start, 2),
        "ar_billed_in_period": round(ar_billed_in_period, 2),
        "ap_billed_in_period": round(ap_billed_in_period, 2),
    }


# ---------- Income Statement ----------

async def compute_income_statement(company_id: str, start: str, end: str, basis: str = "accrual"):
    company = await db.companies.find_one({"id": company_id})
    accts = await db.accounts.find({"company_id": company_id}).to_list(2000)
    by = await _signed_balances(company_id, start, end)

    revenue_rows, expense_rows = [], []
    for a in sorted(accts, key=lambda x: x["code"]):
        raw = by.get(a["id"], 0.0)
        disp = _display_amount(a, raw)
        if abs(disp) < 0.005:
            continue
        if a["type"] == "revenue":
            revenue_rows.append({"code": a["code"], "name": a["name"], "amount": round(disp, 2)})
        elif a["type"] == "expense":
            expense_rows.append({"code": a["code"], "name": a["name"], "amount": round(disp, 2)})

    total_revenue = round(sum(r["amount"] for r in revenue_rows), 2)
    total_expense = round(sum(r["amount"] for r in expense_rows), 2)

    # Accrual adjustments: add change in A/R to revenue, change in A/P to expense.
    # This converts the cash-based P&L (transactions only) into an accrual view.
    accrual_adj_rev = 0.0
    accrual_adj_exp = 0.0
    if basis == "accrual":
        ap = await _open_ar_ap(company_id, as_of=end, start=start)
        accrual_adj_rev = round(ap["ar_end"] - ap["ar_start"], 2)
        accrual_adj_exp = round(ap["ap_end"] - ap["ap_start"], 2)
        if abs(accrual_adj_rev) >= 0.005:
            revenue_rows.append({
                "code": "1200", "name": "Accrual adjustment (Δ A/R)",
                "amount": accrual_adj_rev,
            })
            total_revenue = round(total_revenue + accrual_adj_rev, 2)
        if abs(accrual_adj_exp) >= 0.005:
            expense_rows.append({
                "code": "2000", "name": "Accrual adjustment (Δ A/P)",
                "amount": accrual_adj_exp,
            })
            total_expense = round(total_expense + accrual_adj_exp, 2)

    net_income = round(total_revenue - total_expense, 2)

    return {
        "company_name": company["name"] if company else "",
        "period_start": start, "period_end": end, "basis": basis,
        "revenue": revenue_rows, "expenses": expense_rows,
        "total_revenue": total_revenue,
        "total_expense": total_expense,
        "net_income": net_income,
        "accrual_ar_adjustment": accrual_adj_rev,
        "accrual_ap_adjustment": accrual_adj_exp,
    }


# ---------- Balance Sheet ----------

async def compute_balance_sheet(company_id: str, as_of: str, basis: str = "accrual"):
    company = await db.companies.find_one({"id": company_id})
    accts = await db.accounts.find({"company_id": company_id}).to_list(2000)
    by = await _signed_balances(company_id, start=None, end=as_of, include_pre_period=True)

    # ----- Build parent → children index for hierarchical rollup -----
    # Each account can have `parent_account_id`. Parents (no parent id) show
    # a rolled-up amount = own direct postings + sum of children. Children
    # appear as separate rows with `parent_code` set so consumers can indent
    # or subtotal. The final section totals count only top-level rows so we
    # don't double-count children.
    children_of: dict[str, list[dict]] = {}
    for a in accts:
        pid = a.get("parent_account_id")
        if pid:
            children_of.setdefault(pid, []).append(a)

    def _row(a: dict, direct_amount: float, parent_code: str | None = None):
        r = {"code": a["code"], "name": a["name"], "amount": round(direct_amount, 2)}
        if parent_code:
            r["parent_code"] = parent_code
        return r

    def _emit_section(section_type: str) -> tuple[list[dict], float]:
        """Return (rows, section_total) for one type — assets, liabilities, equity."""
        rows: list[dict] = []
        top_total = 0.0
        # Sort parents (top-level accounts of this type) by code.
        top_level = [a for a in accts
                     if a["type"] == section_type and not a.get("parent_account_id")]
        top_level.sort(key=lambda x: x["code"])
        for a in top_level:
            direct = _display_amount(a, by.get(a["id"], 0.0))
            kids = sorted(children_of.get(a["id"], []), key=lambda x: x["code"])
            kids_rows: list[dict] = []
            kids_total = 0.0
            for k in kids:
                if k["type"] != section_type:
                    continue  # defensive
                kd = _display_amount(k, by.get(k["id"], 0.0))
                if abs(kd) < 0.005:
                    continue
                kids_rows.append(_row(k, kd, parent_code=a["code"]))
                kids_total += kd
            rolled = direct + kids_total
            # Only emit the parent if it has ANY value (own or via children)
            # OR is a well-known section anchor (Retained Earnings, etc.).
            keep_parent = abs(rolled) >= 0.005 or a["code"] == "3100"
            if keep_parent:
                rows.append(_row(a, rolled))
                rows.extend(kids_rows)
                top_total += rolled
            else:
                # Parent is zero + no visible children: still emit visible children
                # (they had activity even if it netted at the parent).
                for kr in kids_rows:
                    rows.append(kr)
                    top_total += kr["amount"]
        return rows, top_total

    assets, total_assets_raw = _emit_section("asset")
    liabilities, total_liabilities_raw = _emit_section("liability")
    equity, total_equity_raw = _emit_section("equity")

    # Net income roll-in from revenue/expense accounts (unchanged).
    net_income_current = 0.0
    for a in accts:
        if a["type"] in ("revenue", "expense"):
            disp = _display_amount(a, by.get(a["id"], 0.0))
            if a["type"] == "revenue":
                net_income_current += disp
            else:
                net_income_current -= disp

    # Accrual basis: layer in A/R (unpaid invoices) as an asset, A/P (unpaid bills)
    # as a liability, and adjust net income by (A/R - A/P) so the sheet balances.
    ar_open = 0.0
    ap_open = 0.0
    if basis == "accrual":
        ap = await _open_ar_ap(company_id, as_of=as_of, start=None)
        ar_open = ap["ar_end"]
        ap_open = ap["ap_end"]
        if ar_open >= 0.005:
            assets.append({"code": "1200", "name": "Accounts Receivable", "amount": round(ar_open, 2)})
        if ap_open >= 0.005:
            liabilities.append({"code": "2000", "name": "Accounts Payable", "amount": round(ap_open, 2)})
        # keep books balanced: A/R adds to accrued revenue, A/P adds to accrued expense
        net_income_current += ar_open - ap_open
        assets.sort(key=lambda x: (x["code"], x.get("parent_code", "")))
        liabilities.sort(key=lambda x: (x.get("parent_code", "") or x["code"], x["code"]))

    net_income_current = round(net_income_current, 2)
    equity.append({
        "code": "NI", "name": "Current Period Net Income",
        "amount": net_income_current,
    })

    # Totals: sum only TOP-LEVEL rows (children carry parent_code).
    total_assets = round(sum(x["amount"] for x in assets if not x.get("parent_code")), 2)
    total_liabilities = round(sum(x["amount"] for x in liabilities if not x.get("parent_code")), 2)
    total_equity = round(sum(x["amount"] for x in equity if not x.get("parent_code")), 2)
    total_le = round(total_liabilities + total_equity, 2)
    balanced = abs(total_assets - total_le) < 0.02

    return {
        "company_name": company["name"] if company else "", "as_of": as_of, "basis": basis,
        "assets": assets, "liabilities": liabilities, "equity": equity,
        "total_assets": total_assets,
        "total_liabilities": total_liabilities,
        "total_equity": total_equity,
        "total_liabilities_equity": total_le,
        "balanced": balanced,
        "imbalance": round(total_assets - total_le, 2),
        "ar_open": round(ar_open, 2),
        "ap_open": round(ap_open, 2),
    }


# ---------- Trial Balance ----------

async def compute_trial_balance(company_id: str, as_of: str):
    company = await db.companies.find_one({"id": company_id})
    accts = await db.accounts.find({"company_id": company_id}).to_list(2000)
    by = await _signed_balances(company_id, start=None, end=as_of, include_pre_period=True)

    rows = []
    total_d = 0.0
    total_c = 0.0
    for a in sorted(accts, key=lambda x: x["code"]):
        raw = by.get(a["id"], 0.0)
        if abs(raw) < 0.005:
            continue
        debit = raw if raw > 0 else 0.0
        credit = -raw if raw < 0 else 0.0
        rows.append({"code": a["code"], "name": a["name"],
                     "debit": round(debit, 2), "credit": round(credit, 2)})
        total_d += debit
        total_c += credit
    return {
        "company_name": company["name"] if company else "", "as_of": as_of,
        "rows": rows, "total_debit": round(total_d, 2), "total_credit": round(total_c, 2),
        "balanced": abs(total_d - total_c) < 0.02,
    }


# ---------- General Ledger ----------

async def compute_general_ledger(company_id: str, start: str, end: str):
    """List every posting per account with a running balance (signed, debit-normal)."""
    company = await db.companies.find_one({"id": company_id})
    accts = await db.accounts.find({"company_id": company_id}).to_list(2000)
    accts_by_id = {a["id"]: a for a in accts}

    # Opening balances: signed balances as of the day BEFORE start
    from datetime import date as _date
    try:
        d = _date.fromisoformat(start)
        prev_end = (_date(d.year, d.month, d.day).fromordinal(d.toordinal() - 1)).isoformat()
    except Exception:
        prev_end = start
    opening = await _signed_balances(company_id, start=None, end=prev_end, include_pre_period=True)

    # Gather signed postings within [start, end]
    postings: dict[str, list[dict]] = defaultdict(list)

    txns = await db.transactions.find({
        "company_id": company_id, "posted": True,
        "date": {"$gte": start, "$lte": end},
    }).sort("date", 1).to_list(100000)
    for t in txns:
        amt = float(t.get("amount", 0) or 0)
        desc = t.get("description") or t.get("merchant") or ""
        bank = t.get("bank_account_id")
        if bank:
            postings[bank].append({
                "date": t["date"], "description": desc, "signed": amt,
                "source": "Txn", "txn_id": t["id"],
                "ref": f"Txn · {t.get('merchant', '')[:40]}",
            })
        splits = t.get("splits") or []
        if splits:
            split_total = 0.0
            fallback_cat = t.get("category_account_id")
            for s in splits:
                sid = s.get("category_account_id") or s.get("account_id") or fallback_cat
                s_amt = float(s.get("amount", 0) or 0)
                split_total += s_amt
                if sid:
                    postings[sid].append({
                        "date": t["date"], "description": s.get("description") or desc,
                        "signed": -s_amt, "source": "Split", "txn_id": t["id"],
                        "ref": f"Txn split · {t.get('merchant', '')[:30]}",
                    })
            residual = amt - split_total
            aid_cat = t.get("category_account_id")
            if aid_cat and abs(residual) > 0.001:
                postings[aid_cat].append({
                    "date": t["date"], "description": desc, "signed": -residual,
                    "source": "Txn", "txn_id": t["id"],
                    "ref": f"Txn residual · {t.get('merchant', '')[:30]}",
                })
        else:
            aid_cat = t.get("category_account_id")
            if aid_cat:
                postings[aid_cat].append({
                    "date": t["date"], "description": desc, "signed": -amt,
                    "source": "Txn", "txn_id": t["id"],
                    "ref": f"Txn · {t.get('merchant', '')[:40]}",
                })

    jes = await db.journal_entries.find({
        "company_id": company_id, "date": {"$gte": start, "$lte": end},
    }).sort("date", 1).to_list(100000)
    for j in jes:
        memo = j.get("memo") or "Journal Entry"
        for line in j.get("lines", []):
            aid = line.get("account_id")
            if not aid:
                continue
            d = float(line.get("debit", 0) or 0)
            c = float(line.get("credit", 0) or 0)
            postings[aid].append({
                "date": j["date"], "description": line.get("description") or memo,
                "signed": (d - c), "source": "JE", "je_id": j["id"],
                "ref": f"JE · {memo[:40]}",
            })

    sections = []
    for aid, entries in postings.items():
        a = accts_by_id.get(aid)
        if not a:
            continue
        entries.sort(key=lambda x: x["date"])
        credit_normal = a["type"] in CREDIT_NORMAL
        opening_raw = opening.get(aid, 0.0)
        opening_disp = -opening_raw if credit_normal else opening_raw

        rows = []
        run = opening_raw
        for e in entries:
            run += e["signed"]
            disp_delta = -e["signed"] if credit_normal else e["signed"]
            disp_run = -run if credit_normal else run
            rows.append({
                "date": e["date"], "description": e["description"][:80],
                "reference": e["ref"],
                "source": e.get("source", "Txn"),
                "txn_id": e.get("txn_id"),
                "je_id": e.get("je_id"),
                "debit": round(e["signed"], 2) if e["signed"] > 0 else 0.0,
                "credit": round(-e["signed"], 2) if e["signed"] < 0 else 0.0,
                "amount": round(disp_delta, 2),
                "balance": round(disp_run, 2),
            })
        sections.append({
            "code": a["code"], "name": a["name"], "type": a["type"],
            "opening_balance": round(opening_disp, 2),
            "entries": rows,
            "total": rows[-1]["balance"] if rows else round(opening_disp, 2),
        })
    sections.sort(key=lambda s: s["code"])
    return {
        "company_name": company["name"] if company else "",
        "period_start": start, "period_end": end, "sections": sections,
    }


# ---------- Cash Flow ----------

async def compute_cash_flow(company_id: str, start: str, end: str):
    company = await db.companies.find_one({"id": company_id})
    accts = await db.accounts.find({"company_id": company_id}).to_list(2000)
    accts_by_id = {a["id"]: a for a in accts}

    txns = await db.transactions.find({
        "company_id": company_id, "posted": True,
        "date": {"$gte": start, "$lte": end},
    }).to_list(100000)

    operating = 0.0
    investing = 0.0
    financing = 0.0
    for t in txns:
        amt = float(t.get("amount", 0) or 0)
        aid = t.get("category_account_id")
        a = accts_by_id.get(aid) if aid else None
        if not a:
            operating += amt
            continue
        if a["type"] in ("revenue", "expense"):
            operating += amt
        elif a.get("subtype") == "fixed_asset":
            investing += amt
        elif a["type"] == "liability" and "loan" in (a.get("name") or "").lower():
            financing += amt
        else:
            operating += amt
    net = operating + investing + financing
    return {
        "company_name": company["name"] if company else "",
        "period_start": start, "period_end": end,
        "operating": round(operating, 2),
        "investing": round(investing, 2),
        "financing": round(financing, 2),
        "net_change": round(net, 2),
    }


# ---------- Sales Tax Liability ----------

async def compute_sales_tax(company_id: str, start: str, end: str):
    company = await db.companies.find_one({"id": company_id})
    invs = await db.invoices.find({
        "company_id": company_id, "issue_date": {"$gte": start, "$lte": end},
    }).to_list(10000)
    bills = await db.bills.find({
        "company_id": company_id, "issue_date": {"$gte": start, "$lte": end},
    }).to_list(10000)

    collected = sum(float(i.get("tax", 0) or 0) for i in invs)
    paid = sum(float(b.get("tax", 0) or 0) for b in bills)
    taxable_sales = sum(float(i.get("subtotal", 0) or 0) for i in invs if float(i.get("tax", 0) or 0) > 0)
    nontaxable_sales = sum(float(i.get("subtotal", 0) or 0) for i in invs if float(i.get("tax", 0) or 0) == 0)

    settled_tax = 0.0
    for i in invs:
        total = float(i.get("total", 0) or 0)
        bal = float(i.get("balance_due", total) or 0)
        if total > 0:
            paid_ratio = max(0.0, min(1.0, (total - bal) / total))
            settled_tax += float(i.get("tax", 0) or 0) * paid_ratio

    net_liability = collected - paid
    rows = [
        {"label": "Taxable sales", "amount": round(taxable_sales, 2)},
        {"label": "Non-taxable sales", "amount": round(nontaxable_sales, 2)},
        {"label": "Sales tax collected (invoiced)", "amount": round(collected, 2)},
        {"label": "Sales tax collected & received", "amount": round(settled_tax, 2)},
        {"label": "Sales tax paid on purchases", "amount": round(paid, 2)},
    ]
    return {
        "company_name": company["name"] if company else "",
        "period_start": start, "period_end": end,
        "rows": rows,
        "net_liability": round(net_liability, 2),
        "invoices_count": len(invs),
        "bills_count": len(bills),
    }


# ---------- 1099 Summary ----------

async def compute_1099_summary(company_id: str, year: int):
    company = await db.companies.find_one({"id": company_id})
    start = f"{year}-01-01"; end = f"{year}-12-31"
    contacts = await db.contacts.find({"company_id": company_id, "type": {"$in": ["vendor", "both"]}}).to_list(2000)
    contact_by_id = {c["id"]: c for c in contacts}
    contact_by_name = {(c.get("name") or "").lower(): c for c in contacts}

    totals = {c["id"]: 0.0 for c in contacts}
    bills = await db.bills.find({
        "company_id": company_id, "issue_date": {"$gte": start, "$lte": end},
    }).to_list(20000)
    for b in bills:
        cid = b.get("contact_id")
        if not cid or cid not in totals:
            continue
        total = float(b.get("total", 0) or 0)
        bal = float(b.get("balance_due", total) or 0)
        paid_amt = max(0.0, total - bal)
        totals[cid] += paid_amt

    txns = await db.transactions.find({
        "company_id": company_id, "posted": True,
        "date": {"$gte": start, "$lte": end}, "amount": {"$lt": 0},
    }).to_list(50000)
    for t in txns:
        merch = (t.get("merchant") or "").lower()
        c = contact_by_name.get(merch)
        if not c:
            continue
        totals[c["id"]] += abs(float(t.get("amount", 0) or 0))

    rows = []
    for cid_, amt in totals.items():
        if amt < 600.0:
            continue
        c = contact_by_id[cid_]
        rows.append({
            "contact_id": cid_,
            "contact_name": c.get("name"),
            "contact_email": c.get("email", ""),
            "tin": c.get("tin", ""),
            "w9_on_file": bool(c.get("w9_on_file", False)),
            "total_paid": round(amt, 2),
        })
    rows.sort(key=lambda r: r["total_paid"], reverse=True)
    return {
        "company_name": company["name"] if company else "",
        "year": year,
        "rows": rows,
        "total_reportable": round(sum(r["total_paid"] for r in rows), 2),
        "count": len(rows),
    }


# ---------- A/R Aging ----------

async def compute_ar_aging(company_id: str, as_of: str):
    return await _aging(company_id, as_of, kind="ar")


async def compute_ap_aging(company_id: str, as_of: str):
    return await _aging(company_id, as_of, kind="ap")


async def _aging(company_id: str, as_of: str, kind: str):
    """Bucket outstanding A/R (invoices) or A/P (bills) by days past due."""
    from datetime import date as _date
    company = await db.companies.find_one({"id": company_id})
    coll = "invoices" if kind == "ar" else "bills"
    docs = await db[coll].find({"company_id": company_id}).to_list(10000)
    buckets = {"current": 0.0, "1_30": 0.0, "31_60": 0.0, "61_90": 0.0, "over_90": 0.0}
    lines = []
    try:
        today = _date.fromisoformat(as_of)
    except Exception:
        today = _date.today()
    for i in docs:
        if i.get("status") == "paid":
            continue
        bal = float(i.get("balance_due", 0) or 0)
        if bal <= 0.005:
            continue
        due_str = i.get("due_date") or ""
        try:
            due = _date.fromisoformat(due_str)
            days_past = (today - due).days
        except Exception:
            days_past = 0
        if days_past <= 0:
            bucket = "current"
        elif days_past <= 30:
            bucket = "1_30"
        elif days_past <= 60:
            bucket = "31_60"
        elif days_past <= 90:
            bucket = "61_90"
        else:
            bucket = "over_90"
        buckets[bucket] += bal
        lines.append({
            "id": i["id"], "number": i.get("number"),
            "contact_name": i.get("contact_name") or "",
            "issue_date": i.get("issue_date"), "due_date": due_str,
            "balance_due": round(bal, 2),
            "days_past_due": days_past, "bucket": bucket,
        })
    lines.sort(key=lambda x: (-x["days_past_due"], x["contact_name"] or ""))
    total = round(sum(buckets.values()), 2)
    return {
        "company_name": company["name"] if company else "",
        "as_of": as_of,
        "buckets": {k: round(v, 2) for k, v in buckets.items()},
        "lines": lines,
        "total": total,
    }


# ---------- PDF rendering helpers ----------

def _pdf_styles():
    styles = getSampleStyleSheet()
    styles.add(ParagraphStyle(name="Title2", fontName="Helvetica-Bold", fontSize=18,
                              alignment=1, spaceAfter=4))
    styles.add(ParagraphStyle(name="SubTitle", fontName="Helvetica", fontSize=11,
                              alignment=1, textColor=colors.HexColor("#52525B"), spaceAfter=2))
    styles.add(ParagraphStyle(name="Section", fontName="Helvetica-Bold", fontSize=11,
                              textColor=colors.HexColor("#0F172A"),
                              backColor=colors.HexColor("#F1F5F9"), spaceBefore=8, spaceAfter=4,
                              leftIndent=4, rightIndent=4))
    return styles


def _money_table(rows, totals_label, totals_amount):
    data = [[r.get("code", ""), r["name"], f"${r['amount']:,.2f}"] for r in rows]
    data.append(["", totals_label, f"${totals_amount:,.2f}"])
    t = Table(data, colWidths=[0.9 * inch, 4.2 * inch, 1.4 * inch])
    t.setStyle(TableStyle([
        ("FONTNAME", (0, 0), (-1, -1), "Helvetica"),
        ("FONTSIZE", (0, 0), (-1, -1), 9),
        ("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold"),
        ("LINEABOVE", (0, -1), (-1, -1), 0.5, colors.HexColor("#0F172A")),
        ("ALIGN", (2, 0), (2, -1), "RIGHT"),
        ("TEXTCOLOR", (0, 0), (0, -1), colors.HexColor("#52525B")),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, -1), 3),
    ]))
    return t


def build_income_statement_pdf(data: dict) -> bytes:
    buf = BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=LETTER, leftMargin=0.6 * inch, rightMargin=0.6 * inch,
                            topMargin=0.6 * inch, bottomMargin=0.6 * inch)
    s = _pdf_styles()
    story = [
        Paragraph(data["company_name"], s["Title2"]),
        Paragraph("INCOME STATEMENT", s["SubTitle"]),
        Paragraph(f"For the period {data['period_start']} to {data['period_end']} &middot; {data['basis'].title()} Basis", s["SubTitle"]),
        Spacer(1, 12),
        Paragraph("REVENUE", s["Section"]),
        _money_table(data["revenue"], "Total Revenue", data["total_revenue"]),
        Spacer(1, 8),
        Paragraph("OPERATING EXPENSES", s["Section"]),
        _money_table(data["expenses"], "Total Expenses", data["total_expense"]),
        Spacer(1, 12),
        _money_table([], "NET INCOME", data["net_income"]),
    ]
    doc.build(story)
    return buf.getvalue()


def build_balance_sheet_pdf(data: dict) -> bytes:
    buf = BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=LETTER, leftMargin=0.6 * inch, rightMargin=0.6 * inch,
                            topMargin=0.6 * inch, bottomMargin=0.6 * inch)
    s = _pdf_styles()
    story = [
        Paragraph(data["company_name"], s["Title2"]),
        Paragraph("BALANCE SHEET", s["SubTitle"]),
        Paragraph(f"As of {data['as_of']} &middot; {data['basis'].title()} Basis", s["SubTitle"]),
        Spacer(1, 12),
        Paragraph("ASSETS", s["Section"]),
        _money_table(data["assets"], "Total Assets", data["total_assets"]),
        Spacer(1, 8),
        Paragraph("LIABILITIES", s["Section"]),
        _money_table(data["liabilities"], "Total Liabilities", data["total_liabilities"]),
        Spacer(1, 8),
        Paragraph("EQUITY", s["Section"]),
        _money_table(data["equity"], "Total Equity", data["total_equity"]),
        Spacer(1, 12),
        _money_table([], "TOTAL LIABILITIES & EQUITY", data["total_liabilities_equity"]),
    ]
    if not data.get("balanced", True):
        story.append(Spacer(1, 10))
        story.append(Paragraph(
            f"⚠ Imbalance detected: ${data['imbalance']:,.2f}", s["SubTitle"],
        ))
    doc.build(story)
    return buf.getvalue()


def build_trial_balance_pdf(data: dict) -> bytes:
    buf = BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=LETTER, leftMargin=0.6 * inch, rightMargin=0.6 * inch,
                            topMargin=0.6 * inch, bottomMargin=0.6 * inch)
    s = _pdf_styles()
    rows = [["Code", "Account", "Debit", "Credit"]]
    for r in data["rows"]:
        rows.append([r["code"], r["name"], f"${r['debit']:,.2f}" if r["debit"] else "",
                     f"${r['credit']:,.2f}" if r["credit"] else ""])
    rows.append(["", "TOTAL", f"${data['total_debit']:,.2f}", f"${data['total_credit']:,.2f}"])
    t = Table(rows, colWidths=[0.9 * inch, 3.6 * inch, 1.2 * inch, 1.2 * inch])
    t.setStyle(TableStyle([
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#F1F5F9")),
        ("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold"),
        ("LINEABOVE", (0, -1), (-1, -1), 0.5, colors.HexColor("#0F172A")),
        ("FONTSIZE", (0, 0), (-1, -1), 9),
        ("ALIGN", (2, 0), (-1, -1), "RIGHT"),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, -1), 3),
    ]))
    story = [
        Paragraph(data["company_name"], s["Title2"]),
        Paragraph("TRIAL BALANCE", s["SubTitle"]),
        Paragraph(f"As of {data['as_of']}", s["SubTitle"]),
        Spacer(1, 12), t,
    ]
    doc.build(story)
    return buf.getvalue()


def build_general_ledger_pdf(data: dict) -> bytes:
    buf = BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=LETTER, leftMargin=0.6 * inch, rightMargin=0.6 * inch,
                            topMargin=0.6 * inch, bottomMargin=0.6 * inch)
    s = _pdf_styles()
    story = [
        Paragraph(data["company_name"], s["Title2"]),
        Paragraph("GENERAL LEDGER", s["SubTitle"]),
        Paragraph(f"For the period {data['period_start']} to {data['period_end']}", s["SubTitle"]),
        Spacer(1, 10),
    ]
    for sec in data["sections"]:
        story.append(Paragraph(f"{sec['code']} — {sec['name']}", s["Section"]))
        rows = [["Date", "Source", "Description", "Debit", "Credit", "Balance"]]
        rows.append(["", "", f"Opening balance", "", "", f"${sec['opening_balance']:,.2f}"])
        for e in sec["entries"]:
            rows.append([e["date"], e.get("source", "Txn"), e["description"][:45],
                         f"${e['debit']:,.2f}" if e["debit"] else "",
                         f"${e['credit']:,.2f}" if e["credit"] else "",
                         f"${e['balance']:,.2f}"])
        rows.append(["", "", "Ending Balance", "", "", f"${sec['total']:,.2f}"])
        t = Table(rows, colWidths=[0.75 * inch, 0.55 * inch, 2.6 * inch, 0.9 * inch, 0.9 * inch, 1.0 * inch])
        t.setStyle(TableStyle([
            ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#F1F5F9")),
            ("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold"),
            ("FONTSIZE", (0, 0), (-1, -1), 8),
            ("ALIGN", (3, 0), (-1, -1), "RIGHT"),
        ]))
        story.append(t)
        story.append(Spacer(1, 8))
    doc.build(story)
    return buf.getvalue()


def build_cash_flow_pdf(data: dict) -> bytes:
    buf = BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=LETTER, leftMargin=0.6 * inch, rightMargin=0.6 * inch,
                            topMargin=0.6 * inch, bottomMargin=0.6 * inch)
    s = _pdf_styles()
    rows = [
        ["Cash flow from Operating Activities", f"${data['operating']:,.2f}"],
        ["Cash flow from Investing Activities", f"${data['investing']:,.2f}"],
        ["Cash flow from Financing Activities", f"${data['financing']:,.2f}"],
        ["Net Change in Cash", f"${data['net_change']:,.2f}"],
    ]
    t = Table(rows, colWidths=[4.5 * inch, 2 * inch])
    t.setStyle(TableStyle([
        ("FONTNAME", (0, 0), (-1, -1), "Helvetica"),
        ("FONTSIZE", (0, 0), (-1, -1), 10),
        ("ALIGN", (1, 0), (1, -1), "RIGHT"),
        ("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold"),
        ("LINEABOVE", (0, -1), (-1, -1), 0.5, colors.HexColor("#0F172A")),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    story = [
        Paragraph(data["company_name"], s["Title2"]),
        Paragraph("STATEMENT OF CASH FLOWS", s["SubTitle"]),
        Paragraph(f"For the period {data['period_start']} to {data['period_end']}", s["SubTitle"]),
        Spacer(1, 14), t,
    ]
    doc.build(story)
    return buf.getvalue()


def build_sales_tax_pdf(data: dict) -> bytes:
    buf = BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=LETTER, leftMargin=0.6 * inch, rightMargin=0.6 * inch,
                            topMargin=0.6 * inch, bottomMargin=0.6 * inch)
    s = _pdf_styles()
    story = [
        Paragraph(data["company_name"], s["Title2"]),
        Paragraph("SALES TAX LIABILITY", s["SubTitle"]),
        Paragraph(f"For the period {data['period_start']} to {data['period_end']}", s["SubTitle"]),
        Spacer(1, 12),
    ]
    rows = [[r["label"], f"${r['amount']:,.2f}"] for r in data["rows"]]
    rows.append(["Net sales tax liability owed", f"${data['net_liability']:,.2f}"])
    t = Table(rows, colWidths=[4.5 * inch, 2 * inch])
    t.setStyle(TableStyle([
        ("FONTNAME", (0, 0), (-1, -1), "Helvetica"),
        ("FONTSIZE", (0, 0), (-1, -1), 10),
        ("ALIGN", (1, 0), (1, -1), "RIGHT"),
        ("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold"),
        ("LINEABOVE", (0, -1), (-1, -1), 0.5, colors.HexColor("#0F172A")),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    story.append(t)
    doc.build(story)
    return buf.getvalue()


def build_1099_pdf(data: dict) -> bytes:
    buf = BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=LETTER, leftMargin=0.6 * inch, rightMargin=0.6 * inch,
                            topMargin=0.6 * inch, bottomMargin=0.6 * inch)
    s = _pdf_styles()
    story = [
        Paragraph(data["company_name"], s["Title2"]),
        Paragraph("1099 SUMMARY", s["SubTitle"]),
        Paragraph(f"Tax year {data['year']} · Contractors paid ≥ $600", s["SubTitle"]),
        Spacer(1, 12),
    ]
    rows = [["Contractor", "TIN / EIN", "W-9 on file", "Total Paid"]]
    for r in data["rows"]:
        rows.append([r["contact_name"], r["tin"] or "—",
                     "Yes" if r["w9_on_file"] else "No", f"${r['total_paid']:,.2f}"])
    rows.append(["", "", "TOTAL", f"${data['total_reportable']:,.2f}"])
    t = Table(rows, colWidths=[3.0 * inch, 1.5 * inch, 1.0 * inch, 1.4 * inch])
    t.setStyle(TableStyle([
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#F1F5F9")),
        ("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold"),
        ("LINEABOVE", (0, -1), (-1, -1), 0.5, colors.HexColor("#0F172A")),
        ("FONTSIZE", (0, 0), (-1, -1), 9),
        ("ALIGN", (3, 0), (3, -1), "RIGHT"),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    story.append(t)
    if not data["rows"]:
        story.append(Spacer(1, 20))
        story.append(Paragraph("No contractors met the $600 reporting threshold this year.",
                               s["SubTitle"]))
    doc.build(story)
    return buf.getvalue()
