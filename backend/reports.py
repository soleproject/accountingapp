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
import os
import logging
from io import BytesIO
from collections import defaultdict
from reportlab.lib.pagesizes import LETTER
from reportlab.lib import colors
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle

from db import db

log = logging.getLogger(__name__)


# ────────────────────────────────────────────────────────────────
# Custom font registration
# ────────────────────────────────────────────────────────────────

# TTF families bundled at `backend/fonts/`. Each has a Regular + Bold
# static file (variable fonts were instanced at build time via
# `scripts/download_fonts.py`). Registered lazily on first import so a
# single process pays the load cost once; every subsequent PDF render
# hits ReportLab's in-memory glyph cache.
FONTS_DIR = os.path.join(os.path.dirname(__file__), "fonts")
_BUNDLED_FONTS = [
    "Inter", "Roboto", "OpenSans", "Nunito", "Poppins", "Lato",
    "PlayfairDisplay", "Lora", "LibreBaskerville", "PTSerif",
    "JetBrainsMono", "IBMPlexMono",
]


def _register_bundled_fonts() -> set[str]:
    """Register every bundled TTF with ReportLab. Returns the set of
    families that loaded successfully so the resolver can fall back to
    Helvetica if a file is ever missing at runtime."""
    ok: set[str] = set()
    for fam in _BUNDLED_FONTS:
        reg = os.path.join(FONTS_DIR, f"{fam}-Regular.ttf")
        bold = os.path.join(FONTS_DIR, f"{fam}-Bold.ttf")
        if not (os.path.isfile(reg) and os.path.isfile(bold)):
            log.warning("Report font %s missing (%s / %s) — skipping", fam, reg, bold)
            continue
        try:
            pdfmetrics.registerFont(TTFont(fam, reg))
            pdfmetrics.registerFont(TTFont(f"{fam}-Bold", bold))
            ok.add(fam)
        except Exception as e:  # noqa: BLE001 — TTF corruption shouldn't crash the app
            log.warning("Report font %s failed to load: %s", fam, e)
    return ok


AVAILABLE_FONTS = _register_bundled_fonts()


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
        # QBO CreditMemos are a special case: their AR-reduction side is
        # tracked implicitly via `invoice.balance_due` (the linked invoice's
        # remaining balance is already reduced by the applied credit).
        # `_open_ar_ap` reads those reduced balances, so the CM's effect on
        # AR is already in NI via the accrual layer. Also posting the CM's
        # DR-to-Revenue line here would double-count the revenue reduction
        # (once via lower AR contribution to NI, once via direct signed
        # balance on the revenue account) and unbalance the BS by exactly
        # the CM total. Skip them here — the entity still shows up in
        # transaction lists / reports that read db.transactions directly.
        # Feb 26 2026 — see CHANGELOG QBO CM double-count fix.
        if t.get("txn_type") == "CreditMemo":
            continue

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

    # ------------------------------------------------------------------
    # QBO Payment / BillPayment cash-side roll-in.
    #
    # Payments live in `db.payments` (not `db.transactions`) and QBO
    # tracks their AR/AP-reduction side implicitly by decrementing the
    # linked invoice/bill's `balance_due`. `_open_ar_ap` reads those
    # reduced balances so the AR/AP asset/liability figure is correct
    # post-payment — but the CASH side was previously never posted to
    # the ledger, so cash accounts under-reported all customer receipts
    # and vendor payouts.
    #
    # We roll payments in here so `_signed_balances` (and every report
    # built on top of it — BS/IS/GL/Cash Flow) sees the cash movement.
    # `compute_balance_sheet` mirrors the same total into Net Income
    # via a "realized-revenue" adjustment so the balance-sheet identity
    # (Assets = L + E) is preserved — see the payments_realized block
    # in compute_balance_sheet.
    # Feb 26 2026.
    # ------------------------------------------------------------------
    pay_q = {"company_id": company_id, "date": {"$lte": end}}
    if start and not include_pre_period:
        pay_q["date"] = {"$gte": start, "$lte": end}
    # Prefetch account-by-qbo_id lookup for fast deposit-account resolution.
    acct_by_qbo_id: dict[str, str] = {}
    async for a in db.accounts.find({"company_id": company_id, "qbo_id": {"$ne": None}}):
        acct_by_qbo_id[str(a["qbo_id"])] = a["id"]

    def _pay_account_id(p: dict) -> str | None:
        """Resolve which local account this payment moves cash on. For
        Payment IN, that's `deposit_account_qbo_id` (Undeposited Funds
        or a bank). For BillPayment OUT the field is often unset in the
        mapper, so fall back to the raw QBO payload's `CheckPayment` /
        `CreditCardPayment` account refs."""
        qid = p.get("deposit_account_qbo_id")
        if not qid:
            raw = p.get("raw") or {}
            cp = raw.get("CheckPayment") or {}
            cc = raw.get("CreditCardPayment") or {}
            qid = ((cp.get("BankAccountRef") or {}).get("value")
                   or (cc.get("CCAccountRef") or {}).get("value"))
        if not qid:
            return None
        return acct_by_qbo_id.get(str(qid))

    async for p in db.payments.find(pay_q):
        amt = float(p.get("amount") or 0)
        if amt <= 0.005:
            continue
        aid = _pay_account_id(p)
        if not aid:
            continue
        direction = p.get("direction") or "in"
        if direction == "in":
            # DR the deposit account (bank/undep) — cash goes up.
            by[aid] += amt
        else:
            # BillPayment OUT: CR the funding account — cash goes down
            # (or, for CC-funded bill payments, the CC liability goes up
            # because raw signed balance on a credit-card LIABILITY
            # account is stored negative; `_display_amount` inverts it).
            by[aid] += -amt

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

    # Inventory-tracked bill lines already sit on the balance sheet
    # via `DR Inventory / CR A/P` journal entries posted by
    # `inventory_service.apply_bill_inventory`. Counting them AGAIN in
    # ap_billed_in_period / ap_end would double-book the same $ against
    # A/P (once from the JE, once from this helper) and drop a phantom
    # -expense into the Income Statement. We total the inventory
    # portion per-bill here and subtract it from the accrual figures
    # below.
    inv_bill_portion: dict[str, float] = {}
    async for je in db.journal_entries.find({
        "company_id": company_id, "source": "bill_inventory",
        "ref_kind": "bill",
    }):
        rid = je.get("ref_id")
        if not rid:
            continue
        # Sum credits to A/P for this bill (belt-and-braces if
        # `inventory_portion` isn't stored on older JEs).
        portion = float(je.get("inventory_portion") or 0.0)
        if not portion:
            portion = sum(float(l.get("credit") or 0) for l in (je.get("lines") or []))
        inv_bill_portion[rid] = inv_bill_portion.get(rid, 0.0) + portion

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
        # Inventory-tracked portion already booked as A/P via JE — pull
        # it out of every accrual figure so we don't count it twice.
        inv_portion = float(inv_bill_portion.get(b.get("id"), 0.0))
        # ap_end/ap_start use balance_due, not total; scale the inv
        # portion by the paid-ratio so a partly-paid bill still nets
        # right (e.g. 50% paid → only 50% of the JE-booked A/P is still
        # open, rest is already relieved by the payment txn).
        open_ratio = (bal / total) if total > 0.005 else 0.0
        open_inv_portion = inv_portion * open_ratio
        if issue and issue <= as_of and bal > 0.005:
            ap_end += max(bal - open_inv_portion, 0.0)
        if prev_end and issue and issue <= prev_end and bal > 0.005:
            ap_start += max(bal - open_inv_portion, 0.0)
        if _in_period(issue):
            ap_billed_in_period += max(total - inv_portion, 0.0)

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

    # Build parent → children index (same pattern used on the balance
    # sheet). Sub-accounts render indented under their parent and the
    # parent shows the rolled-up total (own direct postings + kids).
    children_of: dict[str, list[dict]] = {}
    for a in accts:
        pid = a.get("parent_account_id")
        if pid:
            children_of.setdefault(pid, []).append(a)

    def _emit(section_type: str):
        rows: list[dict] = []
        top_level = [a for a in accts
                     if a["type"] == section_type and not a.get("parent_account_id")]
        # Sort by (detail_type, code) so accounts sharing a Wave-style
        # sub-type end up contiguous — required for the grouped
        # renderer to emit clean sub-type banners in the PDF.
        top_level.sort(key=lambda x: ((x.get("detail_type") or "zzz").lower(), (x.get("code") or "")))
        for a in top_level:
            direct = _display_amount(a, by.get(a["id"], 0.0))
            kids = sorted(children_of.get(a["id"], []), key=lambda x: x["code"])
            kids_rows: list[dict] = []
            kids_total = 0.0
            for k in kids:
                if k["type"] != section_type:
                    continue
                kd = _display_amount(k, by.get(k["id"], 0.0))
                if abs(kd) < 0.005:
                    continue
                kids_rows.append({
                    "id": k["id"], "code": k["code"], "name": k["name"],
                    "amount": round(kd, 2), "parent_code": a["code"],
                    "detail_type": (k.get("detail_type") or "").strip(),
                })
                kids_total += kd
            rolled = direct + kids_total
            if abs(rolled) < 0.005:
                # Nothing to show at parent level, but children with activity
                # still deserve a line — emit them flat.
                for kr in kids_rows:
                    rows.append(kr)
                continue
            rows.append({
                "id": a["id"], "code": a["code"], "name": a["name"],
                "amount": round(rolled, 2),
                "detail_type": (a.get("detail_type") or "").strip(),
            })
            rows.extend(kids_rows)
        return rows

    revenue_rows = _emit("revenue")
    cogs_rows    = _emit("cogs")
    expense_rows = _emit("expense")

    # Section totals — count TOP-LEVEL rows only (parent_code missing).
    total_revenue = round(sum(r["amount"] for r in revenue_rows if not r.get("parent_code")), 2)
    total_cogs    = round(sum(r["amount"] for r in cogs_rows    if not r.get("parent_code")), 2)
    total_expense = round(sum(r["amount"] for r in expense_rows if not r.get("parent_code")), 2)

    # Accrual layer: on QBO's own P&L, revenue is recognized when an
    # invoice is issued (regardless of whether it's been collected).
    # Our raw signed-balances layer only counts direct posts to revenue
    # accounts (SalesReceipts, RefundReceipts, JEs) — invoice-driven
    # revenue lives in `db.invoices`, never touching `_signed_balances`.
    # Same shape for A/P: bills issued in the period are the accrual
    # expense.
    #
    # To match QBO's per-account totals we:
    #   1. Walk each invoice/bill issued in the period
    #   2. Group its line items by the income/expense account each
    #      item points at (via `account_qbo_id` on the mapped line)
    #   3. Fold those amounts into the revenue/expense row for the
    #      matching account, or emit a synthetic bucket row when the
    #      line has no resolvable account (falls back to a single
    #      "Uncategorized Income / Expense" catch-all so totals still
    #      tie).
    #
    # Feb 26 2026 — replaces the earlier flat "Accrual adjustment
    # (Δ A/R)" line which under-counted by `ar_cash_in_period` and
    # prevented per-account reconciliation with QBO.
    accrual_adj_rev = 0.0
    accrual_adj_exp = 0.0
    if basis == "accrual":
        # Build lookup: qbo_id → local account row, keyed for revenue
        # and expense/cogs separately so we route each invoice line to
        # the correct section.
        rev_by_qbo: dict[str, dict] = {}
        exp_by_qbo: dict[str, dict] = {}
        for a in accts:
            if a.get("qbo_id"):
                if a["type"] == "revenue":
                    rev_by_qbo[str(a["qbo_id"])] = a
                elif a["type"] in ("expense", "cogs"):
                    exp_by_qbo[str(a["qbo_id"])] = a
        # Also index the rows we already emitted so we can add to
        # them in place instead of stacking duplicate entries.
        rev_row_by_id = {r["id"]: r for r in revenue_rows if r.get("id")}
        exp_row_by_id = {r["id"]: r for r in expense_rows if r.get("id")}

        # 1) Invoices issued in the period → revenue side.
        rev_uncategorized = 0.0
        async for inv in db.invoices.find({"company_id": company_id}):
            issue = inv.get("issue_date") or ""
            if not (issue and start <= issue <= end):
                continue
            for ln in inv.get("line_items") or []:
                amt = float(ln.get("amount") or 0)
                if abs(amt) < 0.005:
                    continue
                qid = str(ln.get("account_qbo_id") or "")
                # Common pattern: SalesItemLineDetail carries an
                # ItemRef (not AccountRef). Look up the item's income
                # account when we didn't get an AccountRef directly.
                if not qid and ln.get("item_qbo_id"):
                    item = await db.items.find_one({
                        "company_id": company_id,
                        "qbo_id": ln["item_qbo_id"]})
                    if item:
                        qid = str(item.get("income_account_qbo_id") or "")
                acct = rev_by_qbo.get(qid)
                if acct:
                    row = rev_row_by_id.get(acct["id"])
                    if row:
                        row["amount"] = round(row["amount"] + amt, 2)
                    else:
                        new_row = {
                            "id": acct["id"], "code": acct.get("code") or "",
                            "name": acct.get("name") or "",
                            "amount": round(amt, 2),
                            "detail_type": (acct.get("detail_type") or "").strip(),
                        }
                        revenue_rows.append(new_row)
                        rev_row_by_id[acct["id"]] = new_row
                else:
                    rev_uncategorized += amt
                accrual_adj_rev += amt
        if abs(rev_uncategorized) >= 0.005:
            revenue_rows.append({
                "code": "4999",
                "name": "Uncategorized Income (accrual)",
                "amount": round(rev_uncategorized, 2),
            })

        # 2) Bills issued in the period → expense/COGS side.
        exp_uncategorized = 0.0
        async for bill in db.bills.find({"company_id": company_id}):
            issue = bill.get("issue_date") or ""
            if not (issue and start <= issue <= end):
                continue
            for ln in bill.get("line_items") or []:
                amt = float(ln.get("amount") or 0)
                if abs(amt) < 0.005:
                    continue
                qid = str(ln.get("account_qbo_id") or "")
                if not qid and ln.get("item_qbo_id"):
                    item = await db.items.find_one({
                        "company_id": company_id,
                        "qbo_id": ln["item_qbo_id"]})
                    if item:
                        qid = str(item.get("expense_account_qbo_id") or "")
                acct = exp_by_qbo.get(qid)
                if acct:
                    if acct["type"] == "cogs":
                        target_rows = cogs_rows
                    else:
                        target_rows = expense_rows
                    row = next((r for r in target_rows if r.get("id") == acct["id"]), None)
                    if row:
                        row["amount"] = round(row["amount"] + amt, 2)
                    else:
                        target_rows.append({
                            "id": acct["id"], "code": acct.get("code") or "",
                            "name": acct.get("name") or "",
                            "amount": round(amt, 2),
                            "detail_type": (acct.get("detail_type") or "").strip(),
                        })
                else:
                    exp_uncategorized += amt
                accrual_adj_exp += amt
        if abs(exp_uncategorized) >= 0.005:
            expense_rows.append({
                "code": "5999",
                "name": "Uncategorized Expense (accrual)",
                "amount": round(exp_uncategorized, 2),
            })

        # Recompute section totals now that accrual rows have been
        # merged into the per-account rows.
        total_revenue = round(sum(r["amount"] for r in revenue_rows
                                    if not r.get("parent_code")), 2)
        total_cogs    = round(sum(r["amount"] for r in cogs_rows
                                    if not r.get("parent_code")), 2)
        total_expense = round(sum(r["amount"] for r in expense_rows
                                    if not r.get("parent_code")), 2)

    # Gross Profit = Revenue − COGS. Emitted as a subtotal above
    # Operating Expenses whenever there's any COGS activity.
    gross_profit = round(total_revenue - total_cogs, 2)
    net_income   = round(gross_profit - total_expense, 2)

    return {
        "company_name": company["name"] if company else "",
        "period_start": start, "period_end": end, "basis": basis,
        "revenue": revenue_rows,
        "cogs": cogs_rows,
        "expenses": expense_rows,
        "total_revenue": total_revenue,
        "total_cogs": total_cogs,
        "gross_profit": gross_profit,
        "total_expense": total_expense,
        "net_income": net_income,
        "accrual_ar_adjustment": accrual_adj_rev,
        "accrual_ap_adjustment": accrual_adj_exp,
        "report_style": resolve_report_style(company),
        "report_label": resolve_report_label(company, "income-statement"),
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

    def _row(a: dict, direct_amount: float, parent_code: str | None = None,
              parent_id: str | None = None):
        r = {
            "id": a["id"], "code": a["code"], "name": a["name"],
            "amount": round(direct_amount, 2),
            # Carry the Wave-style granular sub-type through so the
            # frontend can group balance-sheet sections into readable
            # sub-headers (Cash and Bank, Property Plant & Equipment,
            # Loan and Line of Credit, etc.).
            "detail_type": (a.get("detail_type") or "").strip(),
            # (Feb 2026 — Phase 1 UK region.) Carry `subtype` too so
            # the UK statutory Balance Sheet renderer can split fixed
            # vs current, and long-term vs short-term creditors. US
            # frontend ignores this field, so the payload stays 100%
            # backward-compatible.
            "subtype": (a.get("subtype") or "").strip(),
        }
        # `parent_code` is optional context for the UI's indentation.
        # `parent_id` (below) is the AUTHORITATIVE child-marker used by
        # the totals loop — some QBO-imported parents have an empty
        # `code`, and using `parent_code` alone caused Original Cost
        # (Truck's child) to lose its is-child flag and get counted a
        # second time toward Total Assets. Feb 26 2026.
        if parent_code:
            r["parent_code"] = parent_code
        if parent_id:
            r["parent_id"] = parent_id
        return r

    def _emit_section(section_type: str) -> tuple[list[dict], float]:
        """Return (rows, section_total) for one type — assets, liabilities, equity."""
        rows: list[dict] = []
        top_total = 0.0
        # Sort parents (top-level accounts of this type) by code.
        top_level = [a for a in accts
                     if a["type"] == section_type and not a.get("parent_account_id")]
        # Sort by (detail_type, code) so accounts sharing a Wave-style
        # sub-type end up contiguous — required for the grouped
        # renderer to emit clean sub-type banners in the PDF.
        top_level.sort(key=lambda x: ((x.get("detail_type") or "zzz").lower(), (x.get("code") or "")))
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
                kids_rows.append(_row(k, kd,
                                       parent_code=a["code"],
                                       parent_id=a["id"]))
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

    # Net income roll-in from revenue/expense/COGS accounts. `cogs` is
    # its own account type (Option B GAAP Income Statement, Feb 2026)
    # but still reduces Net Income exactly like a regular expense —
    # otherwise the BS overstates equity by the period's COGS total
    # and the sheet doesn't balance.
    net_income_current = 0.0
    for a in accts:
        if a["type"] in ("revenue", "expense", "cogs"):
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

    # ------------------------------------------------------------------
    # Payment cash-side offset. `_signed_balances` now rolls QBO
    # Payments (customer receipts) and BillPayments (vendor payouts)
    # into cash accounts, but their AR/AP-reduction side stays in
    # `invoice.balance_due` / `bill.balance_due` (already reflected via
    # `_open_ar_ap` above). To keep Assets = L + E, mirror the cash
    # movement into NI as a "realized" adjustment: money that shifted
    # from AR to Cash on the asset side needs a matching Revenue-side
    # recognition, since `ar_end` alone under-counts total billed by
    # the collected amount. Same idea for BillPayments in reverse.
    # ------------------------------------------------------------------
    pay_in_total = 0.0
    pay_out_total = 0.0
    async for _p in db.payments.find({"company_id": company_id,
                                      "date": {"$lte": as_of}}):
        amt = float(_p.get("amount") or 0)
        if amt <= 0.005:
            continue
        if (_p.get("direction") or "in") == "in":
            pay_in_total += amt
        else:
            pay_out_total += amt
    net_income_current += pay_in_total - pay_out_total

    net_income_current = round(net_income_current, 2)
    equity.append({
        "code": "NI", "name": "Current Period Net Income",
        "amount": net_income_current,
    })

    # Totals: sum only TOP-LEVEL rows. Children carry `parent_id`
    # (authoritative) and/or `parent_code` (may be empty when the
    # parent has no chart code — very common for QBO-imported parents).
    total_assets = round(sum(x["amount"] for x in assets
                              if not x.get("parent_id") and not x.get("parent_code")), 2)
    total_liabilities = round(sum(x["amount"] for x in liabilities
                                   if not x.get("parent_id") and not x.get("parent_code")), 2)
    total_equity = round(sum(x["amount"] for x in equity
                              if not x.get("parent_id") and not x.get("parent_code")), 2)
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
        "report_style": resolve_report_style(company),
        "report_label": resolve_report_label(company, "balance-sheet"),
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
        "report_style": resolve_report_style(company),
        "report_label": resolve_report_label(company, "trial-balance"),
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
    sections.sort(key=lambda s: s["code"] or "")
    return {
        "company_name": company["name"] if company else "",
        "period_start": start, "period_end": end, "sections": sections,
        "report_style": resolve_report_style(company),
        "report_label": resolve_report_label(company, "general-ledger"),
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
    # Per-account breakdown so the frontend can render drillable
    # sub-rows under each bucket. Keyed by account id (nullable
    # placeholder "__uncat__" for txns without a category).
    buckets: dict = {"operating": {}, "investing": {}, "financing": {}}
    UNCAT_KEY = "__uncat__"
    def _bump(bucket_name, key, name, amt):
        b = buckets[bucket_name]
        row = b.get(key)
        if row is None:
            row = {"id": None if key == UNCAT_KEY else key, "code": "", "name": name, "amount": 0.0}
            b[key] = row
        row["amount"] += amt
    for t in txns:
        amt = float(t.get("amount", 0) or 0)
        aid = t.get("category_account_id")
        a = accts_by_id.get(aid) if aid else None
        if not a:
            operating += amt
            _bump("operating", UNCAT_KEY, "Uncategorized", amt)
            continue
        row_key = a["id"]
        row_name = f"{a.get('code','')} · {a['name']}" if a.get("code") else a["name"]
        if a["type"] in ("revenue", "expense"):
            operating += amt
            _bump("operating", row_key, row_name, amt)
        elif a.get("subtype") == "fixed_asset":
            investing += amt
            _bump("investing", row_key, row_name, amt)
        elif a["type"] == "liability" and "loan" in (a.get("name") or "").lower():
            financing += amt
            _bump("financing", row_key, row_name, amt)
        else:
            operating += amt
            _bump("operating", row_key, row_name, amt)
    net = operating + investing + financing
    def _sort_rows(bucket):
        rows = list(bucket.values())
        for r in rows:
            r["amount"] = round(r["amount"], 2)
            r["code"] = (accts_by_id.get(r["id"]) or {}).get("code", "") if r.get("id") else ""
        rows.sort(key=lambda r: abs(r["amount"]), reverse=True)
        return rows
    return {
        "company_name": company["name"] if company else "",
        "period_start": start, "period_end": end,
        "operating": round(operating, 2),
        "investing": round(investing, 2),
        "financing": round(financing, 2),
        "net_change": round(net, 2),
        "operating_rows": _sort_rows(buckets["operating"]),
        "investing_rows": _sort_rows(buckets["investing"]),
        "financing_rows": _sort_rows(buckets["financing"]),
        "report_style": resolve_report_style(company),
        "report_label": resolve_report_label(company, "cash-flow"),
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
        "report_style": resolve_report_style(company),
        "report_label": resolve_report_label(company, "sales-tax"),
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
        "report_style": resolve_report_style(company),
        "report_label": resolve_report_label(company, "1099-summary"),
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

def _pdf_styles(rs: dict | None = None):
    """ReportLab paragraph styles resolved against a per-company
    `report_style` dict (see `resolve_report_style`). Falls back to sane
    Helvetica defaults when nothing is stored yet. Supports built-in
    RL families (Helvetica / Times-Roman / Courier) plus the 12 bundled
    TTFs — see `AVAILABLE_FONTS`. If a stored family isn't available
    (missing TTF, corrupted file, etc.) we silently degrade to
    Helvetica so a broken font doesn't crash the PDF pipeline."""
    rs = rs or resolve_report_style(None)
    fam = rs.get("font_family") or "Helvetica"
    # Built-in ReportLab families use RL's naming convention for Bold.
    builtin_bold_map = {
        "Helvetica":   "Helvetica-Bold",
        "Times-Roman": "Times-Bold",
        "Courier":     "Courier-Bold",
    }
    if fam in builtin_bold_map:
        fam_bold = builtin_bold_map[fam]
    elif fam in AVAILABLE_FONTS:
        fam_bold = f"{fam}-Bold"
    else:
        # Unknown family — fall back to Helvetica so we never crash.
        log.warning("Requested report font %r not registered; falling back to Helvetica", fam)
        fam = "Helvetica"
        fam_bold = "Helvetica-Bold"
    styles = getSampleStyleSheet()
    title_size = float(rs.get("title_font_size") or 18)
    sub_size = float(rs.get("subtitle_font_size") or 11)
    sec_size = float(rs.get("section_font_size") or 11)
    # `leading` sets the paragraph's line box height. Without it,
    # ReportLab uses ~1.2× font size but stacks paragraphs so tightly
    # that an 18pt title's descender overlaps the next 11pt line. Force
    # an explicit leading + spaceAfter to guarantee breathing room.
    styles.add(ParagraphStyle(
        name="Title2", fontName=fam_bold, fontSize=title_size,
        leading=title_size * 1.25,
        alignment=1,
        textColor=colors.HexColor(rs.get("title_color") or "#0F172A"),
        spaceAfter=float(rs.get("title_space_after") or 10),
    ))
    styles.add(ParagraphStyle(
        name="SubTitle", fontName=fam, fontSize=sub_size,
        leading=sub_size * 1.4,
        alignment=1,
        textColor=colors.HexColor(rs.get("subtitle_color") or "#52525B"),
        spaceAfter=float(rs.get("subtitle_space_after") or 3),
    ))
    styles.add(ParagraphStyle(
        name="Section", fontName=fam_bold, fontSize=sec_size,
        leading=sec_size * 1.3,
        textColor=colors.HexColor(rs.get("section_color") or "#0F172A"),
        backColor=colors.HexColor(rs.get("section_bg_color") or "#F1F5F9"),
        spaceBefore=8, spaceAfter=4, leftIndent=4, rightIndent=4,
    ))
    return styles


# ────────────────────────────────────────────────────────────────
# Report styling — per-company overrides for label/font/color/spacing
# ────────────────────────────────────────────────────────────────

# Default report display labels. Keys line up with the URL slugs used by
# `ReportView.jsx` (see the `title` map in that file) so a single
# label-override dictionary drives both the on-screen heading and the
# PDF title.
DEFAULT_REPORT_LABELS = {
    "income-statement":   "Income Statement",
    "balance-sheet":      "Balance Sheet",
    "trial-balance":      "Trial Balance",
    "general-ledger":     "General Ledger",
    "cash-flow":          "Statement of Cash Flows",
    "sales-tax":          "Sales Tax Liability",
    "1099-summary":       "1099 Summary",
    "account-detail":     "Account Detail",
}

# The full defaults applied when a company hasn't customized report
# styling yet (or has customized only a few fields). Keep every knob the
# UI exposes here so front-end and PDF stay in lock-step.
DEFAULT_REPORT_STYLE = {
    "font_family":           "Helvetica",       # Helvetica | Times-Roman | Courier
    "title_font_size":       18,
    "title_color":           "#0F172A",
    "title_space_after":     10,                # pt below the company-name title
    "subtitle_font_size":    11,
    "subtitle_color":        "#52525B",
    "subtitle_space_after":  3,
    "section_font_size":     11,
    "section_color":         "#0F172A",
    "section_bg_color":      "#F1F5F9",
    "labels":                {},                # per-report overrides, see DEFAULT_REPORT_LABELS
}


def resolve_report_style(company: dict | None) -> dict:
    """Merge stored `report_style` overrides onto the app defaults.

    Missing / null / empty-string values fall through to the default so
    the CPA can clear a single field on the settings page without
    zeroing the whole record."""
    stored = ((company or {}).get("report_style")) or {}
    out = dict(DEFAULT_REPORT_STYLE)
    for k, v in stored.items():
        if k == "labels":
            continue
        if v is None or v == "":
            continue
        out[k] = v
    # Labels merge separately — start from defaults, layer overrides.
    labels = dict(DEFAULT_REPORT_LABELS)
    for k, v in (stored.get("labels") or {}).items():
        if v:
            labels[k] = v
    out["labels"] = labels
    return out


def resolve_report_label(company: dict | None, kind: str) -> str:
    """Return the user-facing label for a given report kind."""
    rs = resolve_report_style(company)
    return rs["labels"].get(kind) or DEFAULT_REPORT_LABELS.get(kind, kind)


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


# ── Balance-sheet-specific renderer: injects Wave-style sub-type
# banner rows (Cash and Bank, Property Plant & Equipment, Loan and
# Line of Credit, etc.) before each contiguous run of accounts that
# share a `detail_type`. Falls back to the flat `_money_table` look
# when nothing in the section carries a detail_type.
_DETAIL_PDF_LABELS = {
    "cash_and_bank": "Cash and Bank",
    "money_in_transit": "Money in Transit",
    "expected_payments_from_customers": "Accounts Receivable",
    "inventory": "Inventory",
    "property_plant_equipment": "Property, Plant & Equipment",
    "depreciation_and_amortization": "Depreciation and Amortization",
    "vendor_prepayments": "Vendor Prepayments & Credits",
    "other_short_term_asset": "Other Short-Term Asset",
    "other_long_term_asset": "Other Long-Term Asset",
    "credit_card": "Credit Card",
    "loan_and_line_of_credit": "Loan and Line of Credit",
    "expected_payments_to_vendors": "Accounts Payable",
    "due_for_payroll": "Due For Payroll",
    "due_to_owners": "Due to Owners",
    "customer_prepayments": "Customer Prepayments & Credits",
    "sales_tax_payable": "Sales Tax Payable",
    "other_short_term_liability": "Other Short-Term Liability",
    "other_long_term_liability": "Other Long-Term Liability",
    "owner_contribution_drawing": "Owner Contribution & Drawing",
    "retained_earnings": "Retained Earnings",
    "other_equity": "Other Equity",
}


def _money_table_grouped(rows, totals_label, totals_amount):
    has_any_detail = any(r.get("detail_type") for r in rows)
    if not has_any_detail:
        return _money_table(rows, totals_label, totals_amount)

    data: list[list] = []
    banner_indices: list[int] = []  # row indices where a banner sits
    current_detail = "___INIT___"
    for r in rows:
        dt = (r.get("detail_type") or "").strip()
        if dt != current_detail:
            current_detail = dt
            if dt:
                data.append(["", _DETAIL_PDF_LABELS.get(dt, dt.replace("_", " ").title()), ""])
                banner_indices.append(len(data) - 1)
        data.append([r.get("code", ""), r["name"], f"${r['amount']:,.2f}"])
    data.append(["", totals_label, f"${totals_amount:,.2f}"])

    t = Table(data, colWidths=[0.9 * inch, 4.2 * inch, 1.4 * inch])
    style_cmds = [
        ("FONTNAME", (0, 0), (-1, -1), "Helvetica"),
        ("FONTSIZE", (0, 0), (-1, -1), 9),
        ("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold"),
        ("LINEABOVE", (0, -1), (-1, -1), 0.5, colors.HexColor("#0F172A")),
        ("ALIGN", (2, 0), (2, -1), "RIGHT"),
        ("TEXTCOLOR", (0, 0), (0, -1), colors.HexColor("#52525B")),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, -1), 3),
    ]
    for i in banner_indices:
        style_cmds.extend([
            ("FONTNAME", (0, i), (-1, i), "Helvetica-Bold"),
            ("FONTSIZE", (0, i), (-1, i), 7.5),
            ("TEXTCOLOR", (0, i), (-1, i), colors.HexColor("#64748B")),
            ("BACKGROUND", (0, i), (-1, i), colors.HexColor("#F8FAFC")),
            ("TOPPADDING", (0, i), (-1, i), 6),
            ("BOTTOMPADDING", (0, i), (-1, i), 3),
        ])
    t.setStyle(TableStyle(style_cmds))
    return t


def build_income_statement_pdf(data: dict) -> bytes:
    buf = BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=LETTER, leftMargin=0.6 * inch, rightMargin=0.6 * inch,
                            topMargin=0.6 * inch, bottomMargin=0.6 * inch)
    s = _pdf_styles(data.get("report_style"))
    label = (data.get("report_label") or "Income Statement").upper()
    story = [
        Paragraph(data["company_name"], s["Title2"]),
        Paragraph(label, s["SubTitle"]),
        Paragraph(f"For the period {data['period_start']} to {data['period_end']} &middot; {data['basis'].title()} Basis", s["SubTitle"]),
        Spacer(1, 12),
        Paragraph("REVENUE", s["Section"]),
        _money_table_grouped(data["revenue"], "Total Revenue", data["total_revenue"]),
        Spacer(1, 8),
    ]
    # COGS + Gross Profit only render when there's activity in the
    # cogs bucket. Companies without cost of sales (service, SaaS,
    # condo assocs) keep a clean two-section P&L; inventory / restaurant
    # / retail businesses get a proper GAAP-style Gross Profit line.
    cogs_rows = data.get("cogs") or []
    total_cogs = data.get("total_cogs") or 0
    if cogs_rows or abs(total_cogs) >= 0.005:
        story += [
            Paragraph("COST OF GOODS SOLD", s["Section"]),
            _money_table_grouped(cogs_rows, "Total Cost of Goods Sold", total_cogs),
            Spacer(1, 8),
            _money_table([], "GROSS PROFIT", data.get("gross_profit") or 0),
            Spacer(1, 12),
        ]
    story += [
        Paragraph("OPERATING EXPENSES", s["Section"]),
        _money_table_grouped(data["expenses"], "Total Expenses", data["total_expense"]),
        Spacer(1, 12),
        _money_table([], "NET INCOME", data["net_income"]),
    ]
    doc.build(story)
    return buf.getvalue()


def build_balance_sheet_pdf(data: dict) -> bytes:
    buf = BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=LETTER, leftMargin=0.6 * inch, rightMargin=0.6 * inch,
                            topMargin=0.6 * inch, bottomMargin=0.6 * inch)
    s = _pdf_styles(data.get("report_style"))
    label = (data.get("report_label") or "Balance Sheet").upper()
    story = [
        Paragraph(data["company_name"], s["Title2"]),
        Paragraph(label, s["SubTitle"]),
        Paragraph(f"As of {data['as_of']} &middot; {data['basis'].title()} Basis", s["SubTitle"]),
        Spacer(1, 12),
        Paragraph("ASSETS", s["Section"]),
        _money_table_grouped(data["assets"], "Total Assets", data["total_assets"]),
        Spacer(1, 8),
        Paragraph("LIABILITIES", s["Section"]),
        _money_table_grouped(data["liabilities"], "Total Liabilities", data["total_liabilities"]),
        Spacer(1, 8),
        Paragraph("EQUITY", s["Section"]),
        _money_table_grouped(data["equity"], "Total Equity", data["total_equity"]),
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
    s = _pdf_styles(data.get("report_style"))
    label = (data.get("report_label") or "Trial Balance").upper()
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
        Paragraph(label, s["SubTitle"]),
        Paragraph(f"As of {data['as_of']}", s["SubTitle"]),
        Spacer(1, 12), t,
    ]
    doc.build(story)
    return buf.getvalue()


def build_general_ledger_pdf(data: dict) -> bytes:
    buf = BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=LETTER, leftMargin=0.6 * inch, rightMargin=0.6 * inch,
                            topMargin=0.6 * inch, bottomMargin=0.6 * inch)
    s = _pdf_styles(data.get("report_style"))
    label = (data.get("report_label") or "General Ledger").upper()
    story = [
        Paragraph(data["company_name"], s["Title2"]),
        Paragraph(label, s["SubTitle"]),
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
    s = _pdf_styles(data.get("report_style"))
    label = (data.get("report_label") or "Statement of Cash Flows").upper()
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
        Paragraph(label, s["SubTitle"]),
        Paragraph(f"For the period {data['period_start']} to {data['period_end']}", s["SubTitle"]),
        Spacer(1, 14), t,
    ]
    doc.build(story)
    return buf.getvalue()


def build_sales_tax_pdf(data: dict) -> bytes:
    buf = BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=LETTER, leftMargin=0.6 * inch, rightMargin=0.6 * inch,
                            topMargin=0.6 * inch, bottomMargin=0.6 * inch)
    s = _pdf_styles(data.get("report_style"))
    label = (data.get("report_label") or "Sales Tax Liability").upper()
    story = [
        Paragraph(data["company_name"], s["Title2"]),
        Paragraph(label, s["SubTitle"]),
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
    s = _pdf_styles(data.get("report_style"))
    label = (data.get("report_label") or "1099 Summary").upper()
    story = [
        Paragraph(data["company_name"], s["Title2"]),
        Paragraph(label, s["SubTitle"]),
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


# =========================================================================
#                        Account Detail (transaction report)
# =========================================================================
# A per-account transaction listing (used when the user drills into a
# balance-sheet row). Same visual grammar as trial balance / general ledger
# so it fits naturally alongside the other reports.

async def compute_account_detail(company_id: str, account_id: str,
                                 start: str | None = None, end: str | None = None,
                                 q: str | None = None,
                                 contact_id: str | None = None,
                                 min_amount: float | None = None,
                                 max_amount: float | None = None):
    company = await db.companies.find_one({"id": company_id})
    # Support both single-account drill (from CoA row click) and
    # sub-type drill (from Balance Sheet banner click). When multiple
    # comma-separated account IDs come in, we aggregate transactions
    # across all of them so pros can eyeball an entire sub-type (e.g.
    # every Cash and Bank movement) in one view.
    account_ids = [x for x in (account_id or "").split(",") if x.strip()]
    if not account_ids:
        return {
            "company_name": company["name"] if company else "",
            "account": None, "rows": [], "count": 0, "sum_amount": 0.0, "balance": 0.0,
            "report_style": resolve_report_style(company),
            "report_label": resolve_report_label(company, "account-detail"),
        }
    account_docs = await db.accounts.find(
        {"id": {"$in": account_ids}, "company_id": company_id}
    ).to_list(500)
    if not account_docs:
        return {
            "company_name": company["name"] if company else "",
            "account": None, "rows": [], "count": 0, "sum_amount": 0.0, "balance": 0.0,
            "report_style": resolve_report_style(company),
            "report_label": resolve_report_label(company, "account-detail"),
        }
    is_multi = len(account_docs) > 1
    # Present the aggregated account as a synthetic "account" so the
    # frontend header shows something meaningful ("Cash and Bank · 3
    # accounts" rather than a single row's name).
    if is_multi:
        agg_name = f"{len(account_docs)} accounts · " + ", ".join(a.get("name", "") for a in account_docs[:3])
        if len(account_docs) > 3:
            agg_name += f" +{len(account_docs) - 3} more"
        account = {"id": ",".join(a["id"] for a in account_docs), "name": agg_name, "code": "", "type": account_docs[0].get("type")}
    else:
        account = account_docs[0]

    # The Account Detail page has two personalities depending on what you
    # click on the Balance Sheet or Income Statement:
    #
    #   • Bank / Cash / Credit-Card row  → you want to see MOVEMENTS through
    #     that account (deposits + withdrawals). Those rows carry the account
    #     in `bank_account_id` (Plaid/manual imports) or `account_id` (legacy).
    #
    #   • Expense / Revenue / Liability payment row → you want to see
    #     transactions categorised AS that account. Those rows carry it in
    #     `category_account_id` (or inside `splits[].category_account_id`).
    #
    # Previously the query only matched `category_account_id` + `account_id`,
    # so any bank/asset account whose transactions posted via `bank_account_id`
    # (the standard field used by `_signed_balances` for the BS balance) came
    # back empty even though the Balance Sheet clearly showed a non-zero
    # balance. Now we match on all three fields plus the splits array so
    # every account type drills correctly. Duplicate hits (a transaction that
    # references the same account on both sides — e.g. an internal transfer)
    # collapse naturally because Mongo returns each doc once.
    acct_id_list = [a["id"] for a in account_docs]
    # Match `_signed_balances`: only count `posted=True` transactions so the
    # drill-down running balance ties to the Balance Sheet / Income Statement
    # figure the user clicked on. Unposted (needs-review) rows are excluded
    # because they aren't in the BS balance either.
    mongo_q: dict = {
        "company_id": company_id,
        "posted": True,
        "$or": [
            {"category_account_id": {"$in": acct_id_list}},
            {"account_id": {"$in": acct_id_list}},
            {"bank_account_id": {"$in": acct_id_list}},
            {"splits.category_account_id": {"$in": acct_id_list}},
            {"splits.account_id": {"$in": acct_id_list}},
        ],
    }
    if start:
        mongo_q.setdefault("date", {})["$gte"] = start
    if end:
        mongo_q.setdefault("date", {})["$lte"] = end
    if contact_id:
        mongo_q["contact_id"] = contact_id

    txns = await db.transactions.find(mongo_q).sort([("date", 1), ("_id", 1)]).to_list(5000)

    # Post-filter for free-text search (merchant / description / contact_name)
    # and amount range. Kept in Python to keep index usage tight and to support
    # case-insensitive matching without regex escaping surprises.
    needle = (q or "").strip().lower()

    def _match(t: dict) -> bool:
        if needle:
            hay = " ".join([
                str(t.get("merchant") or ""),
                str(t.get("description") or ""),
                str(t.get("contact_name") or ""),
            ]).lower()
            if needle not in hay:
                return False
        amt = float(t.get("amount") or 0.0)
        if min_amount is not None and abs(amt) < float(min_amount) - 0.001:
            return False
        if max_amount is not None and abs(amt) > float(max_amount) + 0.001:
            return False
        return True

    filtered = [t for t in txns if _match(t)]

    acct_id_set = set(acct_id_list)

    # Also pull JE lines that hit this account — `_signed_balances` includes
    # them in the Balance Sheet figure, so the drill-down needs to as well
    # (opening balances, transfers, manual/adjusting JEs, GL import, etc.).
    je_q: dict = {"company_id": company_id, "lines.account_id": {"$in": acct_id_list}}
    je_date_filter: dict = {}
    if start:
        je_date_filter["$gte"] = start
    if end:
        je_date_filter["$lte"] = end
    if je_date_filter:
        je_q["date"] = je_date_filter
    jes = await db.journal_entries.find(je_q).to_list(5000)

    je_rows: list[dict] = []
    for j in jes:
        for line in j.get("lines", []):
            if line.get("account_id") not in acct_id_set:
                continue
            d = float(line.get("debit", 0) or 0)
            c = float(line.get("credit", 0) or 0)
            memo = line.get("description") or line.get("memo") or j.get("memo") or j.get("reference") or "Journal Entry"
            if needle and needle not in memo.lower():
                continue
            amt = d - c  # signed raw ledger amount (debit +, credit -)
            if min_amount is not None and abs(amt) < float(min_amount) - 0.001:
                continue
            if max_amount is not None and abs(amt) > float(max_amount) + 0.001:
                continue
            je_rows.append({
                "id": j.get("id"),
                "je_id": j.get("id"),
                "date": j.get("date"),
                "merchant": memo,
                "description": memo,
                "contact_name": "",
                "amount": round(amt, 2),
                # Raw delta already carries the right sign for the ledger; same
                # convention as `_signed_balances` (debit +, credit −).
                "_je_delta": amt,
                "source": "JE",
            })

    # Delta convention:
    #   • For a bank/asset account row → the account is on the `bank_account_id`
    #     side, so the movement equals the transaction amount directly
    #     (deposit +$100 raises the balance by $100).
    #   • For a category row (expense/revenue/liability/equity) → the account
    #     is on the `category_account_id` (or `splits[]`) side, so the
    #     movement is `-amount` (an expense transaction of -$100 raises the
    #     expense balance by $100).
    #   • For split lines that reference the account, use the split's own
    #     amount with the same sign flip.

    def _row_delta(t: dict) -> float:
        amt = float(t.get("amount") or 0.0)
        # Bank-side match?
        if (t.get("bank_account_id") in acct_id_set) or (t.get("account_id") in acct_id_set):
            return amt
        # Split-line match?
        for s in (t.get("splits") or []):
            sid = s.get("category_account_id") or s.get("account_id")
            if sid in acct_id_set:
                return -float(s.get("amount") or 0.0)
        # Category-side match (default).
        return -amt

    # Merge txn rows + JE rows, sort oldest → newest so the running balance
    # accumulates in ledger order.
    all_rows: list[dict] = []
    for t in filtered:
        delta = _row_delta(t)
        all_rows.append({
            "id": t.get("id"),
            "date": t.get("date"),
            "merchant": t.get("merchant") or t.get("contact_name") or t.get("description"),
            "description": t.get("description"),
            "contact_name": t.get("contact_name") or "",
            "amount": round(t.get("amount") or 0.0, 2),
            "_delta": delta,
            "needs_review": bool(t.get("needs_review")),
            "source": "Txn",
        })
    for jr in je_rows:
        all_rows.append({
            "id": jr["id"],
            "je_id": jr["je_id"],
            "date": jr["date"],
            "merchant": jr["merchant"],
            "description": jr["description"],
            "contact_name": jr["contact_name"],
            "amount": jr["amount"],
            "_delta": jr["_je_delta"],
            "needs_review": False,
            "source": "JE",
        })
    all_rows.sort(key=lambda r: (r.get("date") or "", r.get("id") or ""))

    running = 0.0
    rows: list[dict] = []
    for r in all_rows:
        delta = float(r.pop("_delta"))
        running += delta
        r["delta"] = round(delta, 2)
        r["running"] = round(running, 2)
        rows.append(r)
    # Newest → oldest for display.
    rows.reverse()

    return {
        "company_name": company["name"] if company else "",
        "account": {
            "id": account["id"], "code": account["code"], "name": account["name"],
            "type": account["type"], "parent_account_id": account.get("parent_account_id"),
        },
        "rows": rows,
        "count": len(rows),
        "sum_amount": round(sum(r.get("amount") or 0.0 for r in rows), 2),
        "balance": round(running, 2),
        "period_start": start,
        "period_end": end,
        "report_style": resolve_report_style(company),
        "report_label": resolve_report_label(company, "account-detail"),
    }


def build_account_detail_pdf(data: dict) -> bytes:
    buf = BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=LETTER, leftMargin=0.6 * inch, rightMargin=0.6 * inch,
                            topMargin=0.6 * inch, bottomMargin=0.6 * inch)
    s = _pdf_styles(data.get("report_style"))
    a = data["account"] or {}
    label = (data.get("report_label") or "Account Detail").upper()
    subtitle = f"{label} &middot; {a.get('code', '')} {a.get('name', '')}"
    story = [
        Paragraph(data["company_name"], s["Title2"]),
        Paragraph(subtitle, s["SubTitle"]),
        Paragraph(
            f"{data['count']} transaction{'' if data['count'] == 1 else 's'} "
            f"&middot; running balance ${data['balance']:,.2f}",
            s["SubTitle"],
        ),
        Spacer(1, 12),
    ]
    rows = [["Date", "Merchant / Description", "Amount", "Running Balance"]]
    for r in data["rows"]:
        rows.append([
            r.get("date") or "",
            (r.get("merchant") or r.get("description") or "")[:60],
            f"${r['amount']:,.2f}",
            f"${r['running']:,.2f}",
        ])
    rows.append(["", "TOTAL", f"${data['sum_amount']:,.2f}", f"${data['balance']:,.2f}"])
    t = Table(rows, colWidths=[1.0 * inch, 3.7 * inch, 1.1 * inch, 1.4 * inch])
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
    story.append(t)
    if not data["rows"]:
        story.append(Spacer(1, 20))
        story.append(Paragraph("No transactions have posted to this account.", s["SubTitle"]))
    doc.build(story)
    return buf.getvalue()
