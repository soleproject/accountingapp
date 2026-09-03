"""Business-document → journal-entry posting.

Every user-created invoice, bill, payment, and receipt should hit the
ledger as a real journal entry the moment it's saved. This module
provides small, safe helpers that do exactly that.

Design notes
------------
1. **Idempotent** — every helper checks for an existing JE with a
   matching ``source_type`` + ``source_id`` before inserting. Safe to
   re-run from the backfill script and from update endpoints that
   want to reverse-and-repost.
2. **Non-double-counting** — the doc's ``posted: True`` flag is set
   alongside the JE insert. The reports engine's synthesis logic in
   ``_open_ar_ap`` and ``compute_income_statement`` is gated on the
   inverse (only synthesize for ``posted: False``) so newly-posted
   docs drive the numbers via their real JE, not the fabricated one.
3. **Account resolution fallbacks** — Plaid-native / non-QBO ledgers
   often lack ``line.account_qbo_id``. We fall back to the company's
   first ``asset/current_asset/name~=receivable`` (or its A/P equivalent)
   and to a "Sales" or "Uncategorized Income/Expense" default when
   the line has no explicit income/expense mapping.

Feb 28 2026 — closes the day-one bug where create-doc endpoints wrote
the doc but never posted the accrual JE, which caused non-QBO ledgers
to show BS drift equal to the doc's total.
"""
from __future__ import annotations

import re
import uuid
from datetime import datetime, timezone

from db import db


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


async def _resolve_account(
    company_id: str, prefer_id: str | None,
    prefer_name_regex: str, fallback_type: str,
    fallback_name: str,
) -> dict | None:
    """Find an account by id first, then by name-regex, then create one
    with sensible defaults if nothing exists. Returns the account dict
    or None if we couldn't resolve/create.

    Type constraint: the name-regex search is scoped to accounts of
    ``fallback_type`` so we don't accidentally match unrelated accounts
    that happen to share a prefix (e.g. the "Sales" revenue regex was
    silently matching "Sales Tax Payable" — a liability — and JE-crediting
    the wrong account for every invoice posted). Feb 28 2026.
    """
    if prefer_id:
        a = await db.accounts.find_one({"company_id": company_id, "id": prefer_id})
        if a:
            return a
    a = await db.accounts.find_one({
        "company_id": company_id,
        "type": fallback_type,
        "name": {"$regex": prefer_name_regex, "$options": "i"},
    })
    if a:
        return a
    # Second pass — any account of the right type (first by code, then
    # by insertion order) so e.g. a CoA that names revenue accounts
    # "Product Sales" / "Service Revenue" still lands somewhere sensible
    # even when the specific regex misses.
    a = await db.accounts.find_one(
        {"company_id": company_id, "type": fallback_type},
        sort=[("code", 1)],
    )
    if a:
        return a
    # Auto-create so the JE has somewhere to land.
    doc = {
        "id": f"auto-{uuid.uuid4().hex[:12]}",
        "company_id": company_id,
        "name": fallback_name,
        "type": fallback_type,
        "code": "",
        "created_at": _now_iso(),
    }
    await db.accounts.insert_one(doc)
    return doc


async def _resolve_sales_tax_payable(
    company_id: str, prefer_id: str | None = None,
) -> dict | None:
    """Resolve (or auto-create) the Sales Tax Payable liability account.

    Local (non-QBO) invoices with per-line sales tax route the collected
    tax here so the Balance Sheet reflects the CR liability and the
    ledger stays balanced. Callers may pass a rate-specific
    ``payable_account_id`` (from ``db.taxes[i].payable_account_id``)
    which we honor first.
    """
    if prefer_id:
        a = await db.accounts.find_one({"company_id": company_id, "id": prefer_id})
        if a:
            return a
    # Prefer an explicit sales_tax_payable / detail_type match, then a
    # name-regex over liability accounts.
    a = await db.accounts.find_one({
        "company_id": company_id,
        "$or": [
            {"detail_type": "sales_tax_payable"},
            {"raw.AccountSubType": "GlobalTaxPayable"},
            {"name": {"$regex": r"sales\s*tax\s*payable|gst\s*payable|vat\s*payable|hst\s*payable",
                       "$options": "i"}},
        ],
        "type": "liability",
    })
    if a:
        return a
    # Auto-create so the JE has somewhere to land. Standard COA code 2200.
    doc = {
        "id": f"auto-{uuid.uuid4().hex[:12]}",
        "company_id": company_id,
        "name": "Sales Tax Payable",
        "type": "liability",
        "detail_type": "sales_tax_payable",
        "subtype": "current_liability",
        "code": "2200",
        "created_at": _now_iso(),
    }
    await db.accounts.insert_one(doc)
    return doc


async def _line_tax_payable_map(company_id: str) -> dict[str, str]:
    """{tax_id → payable_account_id} for local tax rates that have a
    linked payable. Missing entries fall back to the default payable.
    """
    out: dict[str, str] = {}
    async for t in db.taxes.find({"company_id": company_id,
                                    "payable_account_id": {"$exists": True, "$ne": None}}):
        aid = t.get("payable_account_id")
        if aid:
            out[t["id"]] = aid
    return out


async def post_invoice_je(company_id: str, invoice: dict) -> str | None:
    """DR Accounts Receivable / CR Income for each line. Idempotent.

    Returns the JE id, or None if the invoice can't be posted (missing
    lines, zero total). Callers should also set ``invoices.posted=True``
    when this returns a truthy value so the reports engine's synthesis
    logic knows to skip the doc.
    """
    inv_id = invoice.get("id")
    if not inv_id:
        return None
    # QBO-sourced invoices are handled by the legacy report synthesis
    # path (`_open_ar_ap` + payment cash roll-in). Posting a local JE
    # would double-count. Feb 28 2026.
    if invoice.get("source") == "qbo":
        return None
    # Idempotent — return existing if we've already posted.
    existing = await db.journal_entries.find_one({
        "company_id": company_id,
        "source_type": "invoice",
        "source_id": inv_id,
    })
    if existing:
        return existing.get("id")

    lines_in = invoice.get("line_items") or invoice.get("lines") or []
    if not lines_in:
        return None
    subtotal = sum(float(l.get("amount", 0) or 0) for l in lines_in)
    # Doc-level tax on disk is the ROLLED-UP figure (line tax + doc-
    # level tax). Peel line tax off to get the doc-level residual so
    # we CR it separately below.
    line_tax_total = round(
        sum(float(l.get("tax_amount") or 0) for l in lines_in), 2,
    )
    total_tax = round(float(invoice.get("tax") or 0), 2)
    doc_level_tax = round(total_tax - line_tax_total, 2)
    # Discount + shipping affect A/R (customer really owes total).
    discount_amount = round(float(invoice.get("discount_amount") or 0), 2)
    shipping = round(float(invoice.get("shipping") or 0), 2)
    ar_amount = round(subtotal - discount_amount + shipping + total_tax, 2)
    if abs(ar_amount) < 0.005:
        return None

    ar = await _resolve_account(
        company_id, prefer_id=None,
        prefer_name_regex=r"^accounts\s*receivable|^a/?r\b",
        fallback_type="asset", fallback_name="Accounts Receivable",
    )
    if not ar:
        return None

    je_lines = []
    # DR — one A/R line for the FULL amount owed (subtotal - disc + ship + tax).
    je_lines.append({
        "account_id": ar["id"], "account_name": ar["name"],
        "debit": ar_amount, "credit": 0.0,
    })
    # CR — income per line, split by explicit income account or fallback.
    for l in lines_in:
        amt = float(l.get("amount", 0) or 0)
        if not amt:
            continue
        inc = await _resolve_account(
            company_id,
            prefer_id=l.get("account_id") or l.get("income_account_id"),
            prefer_name_regex=r"^sales\b|^service\s+revenue|^revenue\b",
            fallback_type="revenue", fallback_name="Sales",
        )
        if not inc:
            continue
        je_lines.append({
            "account_id": inc["id"], "account_name": inc["name"],
            "debit": 0.0, "credit": round(amt, 2),
        })
    # DR contra-revenue for the discount (keeps revenue at gross and
    # discounts visible on the P&L). Only if there's an actual discount.
    if discount_amount > 0.005:
        disc = await _resolve_account(
            company_id, prefer_id=None,
            prefer_name_regex=r"^sales\s+discount|^discount\b",
            fallback_type="revenue", fallback_name="Sales Discounts",
        )
        if disc:
            je_lines.append({
                "account_id": disc["id"], "account_name": disc["name"],
                "debit": discount_amount, "credit": 0.0,
            })
    # CR — shipping income (charged to customer separately). Kept as
    # revenue for QBO parity.
    if shipping > 0.005:
        ship_acct = await _resolve_account(
            company_id, prefer_id=None,
            prefer_name_regex=r"^shipping\s+income|^shipping\b|^freight",
            fallback_type="revenue", fallback_name="Shipping Income",
        )
        if ship_acct:
            je_lines.append({
                "account_id": ship_acct["id"], "account_name": ship_acct["name"],
                "debit": 0.0, "credit": shipping,
            })
    # CR — Sales Tax Payable. Route by per-line `tax_id → payable_account_id`
    # map (falls back to the canonical Sales Tax Payable). Aggregate by
    # payable account so a single-agency multi-line invoice produces one
    # CR line rather than many. Feb 2026 — closes local-invoice parity gap.
    if line_tax_total > 0.005 or doc_level_tax > 0.005:
        rate_map = await _line_tax_payable_map(company_id)
        default_payable = await _resolve_sales_tax_payable(company_id)
        payable_totals: dict[str, float] = {}
        for l in lines_in:
            ta = round(float(l.get("tax_amount") or 0), 2)
            if ta <= 0.005:
                continue
            aid = rate_map.get(l.get("tax_id")) or (default_payable or {}).get("id")
            if not aid:
                continue
            payable_totals[aid] = payable_totals.get(aid, 0.0) + ta
        if doc_level_tax > 0.005 and default_payable:
            aid = default_payable["id"]
            payable_totals[aid] = payable_totals.get(aid, 0.0) + doc_level_tax
        # Emit one CR per payable account. Look up the account name once
        # (may not be the default if the rate has a custom payable).
        for aid, amt in payable_totals.items():
            acct = await db.accounts.find_one(
                {"company_id": company_id, "id": aid},
                {"_id": 0, "id": 1, "name": 1},
            )
            je_lines.append({
                "account_id": aid,
                "account_name": (acct or {}).get("name") or "Sales Tax Payable",
                "debit": 0.0, "credit": round(amt, 2),
            })

    je_id = str(uuid.uuid4())
    await db.journal_entries.insert_one({
        "id": je_id,
        "company_id": company_id,
        "date": invoice.get("date") or invoice.get("issue_date") or _now_iso()[:10],
        "memo": f"Invoice {invoice.get('number') or inv_id}",
        "source_type": "invoice",
        "source_id": inv_id,
        "lines": je_lines,
        "created_at": _now_iso(),
        "posted_by": "auto_accrual",
    })
    await db.invoices.update_one(
        {"id": inv_id, "company_id": company_id},
        {"$set": {"posted": True, "posted_je_id": je_id}},
    )
    return je_id


async def post_bill_je(company_id: str, bill: dict) -> str | None:
    """DR Expense / CR Accounts Payable for each line. Idempotent.

    Mirror of ``post_invoice_je``. Set ``bills.posted=True`` on success.
    """
    bid = bill.get("id")
    if not bid:
        return None
    if bill.get("source") == "qbo":
        return None
    existing = await db.journal_entries.find_one({
        "company_id": company_id, "source_type": "bill", "source_id": bid,
    })
    if existing:
        return existing.get("id")

    lines_in = bill.get("line_items") or bill.get("lines") or []
    if not lines_in:
        return None
    total = sum(float(l.get("amount", 0) or 0) for l in lines_in)
    if abs(total) < 0.005:
        return None

    ap = await _resolve_account(
        company_id, prefer_id=None,
        prefer_name_regex=r"^accounts\s*payable|^a/?p\b",
        fallback_type="liability", fallback_name="Accounts Payable",
    )
    if not ap:
        return None

    je_lines = []
    # CR — one A/P line for the total.
    je_lines.append({
        "account_id": ap["id"], "account_name": ap["name"],
        "debit": 0.0, "credit": round(total, 2),
    })
    # DR — expense per line.
    for l in lines_in:
        amt = float(l.get("amount", 0) or 0)
        if not amt:
            continue
        exp = await _resolve_account(
            company_id,
            prefer_id=l.get("account_id") or l.get("expense_account_id"),
            prefer_name_regex=r"^uncategorized\s+expense|^office|^operat",
            fallback_type="expense", fallback_name="Uncategorized Expense",
        )
        if not exp:
            continue
        je_lines.append({
            "account_id": exp["id"], "account_name": exp["name"],
            "debit": round(amt, 2), "credit": 0.0,
        })

    je_id = str(uuid.uuid4())
    await db.journal_entries.insert_one({
        "id": je_id,
        "company_id": company_id,
        "date": bill.get("date") or bill.get("bill_date") or _now_iso()[:10],
        "memo": f"Bill {bill.get('number') or bid}",
        "source_type": "bill",
        "source_id": bid,
        "lines": je_lines,
        "created_at": _now_iso(),
        "posted_by": "auto_accrual",
    })
    await db.bills.update_one(
        {"id": bid, "company_id": company_id},
        {"$set": {"posted": True, "posted_je_id": je_id}},
    )
    return je_id


# ─── Payments (customer receipts against invoices, vendor payments
#      against bills) ────────────────────────────────────────────────

_SOURCE_TO_COLL = {
    "invoice": "invoices",
    "bill": "bills",
    "payment": "payments",
    "receipt": "receipts",
}


async def post_payment_je(company_id: str, payment: dict) -> str | None:
    """DR/CR the cash + AR/AP legs of a linked payment. Idempotent.

    Direction handling:
      • ``in`` (customer receipt against an invoice) →
        DR deposit account (bank / Undep) / CR Accounts Receivable
      • ``out`` (vendor payment against a bill) →
        DR Accounts Payable / CR bank account

    Unlinked payments (bare deposits/withdrawals with no invoice/bill
    reference) are intentionally skipped — their offset is ambiguous and
    the ``_signed_balances`` payment cash roll-in already surfaces the
    cash side for those legacy docs.

    A payment paired with a ``source_transaction_id`` is also skipped:
    the paired bank transaction has already booked the cash leg via
    its own transactions-side posting and the linked invoice/bill's
    JE + this posting together would double-count.
    """
    pid = payment.get("id")
    if not pid:
        return None
    if payment.get("source") == "qbo":
        return None
    amt = float(payment.get("amount") or 0)
    if abs(amt) < 0.005:
        return None
    # Bank transactions already own the cash leg for these payments.
    if payment.get("source_transaction_id") and payment.get("source") != "qbo":
        return None

    linked_invoice_id = payment.get("linked_invoice_id")
    linked_bill_id = payment.get("linked_bill_id")
    if not (linked_invoice_id or linked_bill_id):
        # Unlinked payment — see docstring.
        return None

    # Idempotent.
    existing = await db.journal_entries.find_one({
        "company_id": company_id,
        "source_type": "payment",
        "source_id": pid,
    })
    if existing:
        return existing.get("id")

    direction = payment.get("direction") or ("in" if linked_invoice_id else "out")

    # Resolve the cash-side account.
    cash_prefer_id = (
        payment.get("deposit_to_account_id")
        or payment.get("bank_account_id")
    )
    if direction == "in":
        # DR deposit / CR A/R
        cash = await _resolve_account(
            company_id, prefer_id=cash_prefer_id,
            prefer_name_regex=r"^undeposited\s+funds$",
            fallback_type="asset", fallback_name="Undeposited Funds",
        )
        contra = await _resolve_account(
            company_id, prefer_id=None,
            prefer_name_regex=r"^accounts\s*receivable|^a/?r\b",
            fallback_type="asset", fallback_name="Accounts Receivable",
        )
        if not cash or not contra:
            return None
        je_lines = [
            {"account_id": cash["id"], "account_name": cash["name"],
             "debit": round(amt, 2), "credit": 0.0},
            {"account_id": contra["id"], "account_name": contra["name"],
             "debit": 0.0, "credit": round(amt, 2)},
        ]
    else:
        # DR A/P / CR bank
        cash = await _resolve_account(
            company_id, prefer_id=cash_prefer_id,
            prefer_name_regex=r"^checking|^bank\b|^cash\b",
            fallback_type="asset", fallback_name="Cash",
        )
        contra = await _resolve_account(
            company_id, prefer_id=None,
            prefer_name_regex=r"^accounts\s*payable|^a/?p\b",
            fallback_type="liability", fallback_name="Accounts Payable",
        )
        if not cash or not contra:
            return None
        je_lines = [
            {"account_id": contra["id"], "account_name": contra["name"],
             "debit": round(amt, 2), "credit": 0.0},
            {"account_id": cash["id"], "account_name": cash["name"],
             "debit": 0.0, "credit": round(amt, 2)},
        ]

    je_id = str(uuid.uuid4())
    await db.journal_entries.insert_one({
        "id": je_id,
        "company_id": company_id,
        "date": payment.get("date") or _now_iso()[:10],
        "memo": f"Payment {payment.get('memo') or ''}".strip() or f"Payment {pid[:8]}",
        "source_type": "payment",
        "source_id": pid,
        "lines": je_lines,
        "created_at": _now_iso(),
        "posted_by": "auto_accrual",
    })
    await db.payments.update_one(
        {"id": pid, "company_id": company_id},
        {"$set": {"posted": True, "posted_je_id": je_id}},
    )
    return je_id


async def post_receipt_je(company_id: str, receipt: dict) -> str | None:
    """Sales Receipt — one-shot sale + payment.
    DR bank/CC (payment_account_id) / CR Income (category_account_id).
    Idempotent.
    """
    rid = receipt.get("id")
    if not rid:
        return None
    if receipt.get("source") == "qbo":
        return None
    amt = float(receipt.get("amount") or 0)
    if abs(amt) < 0.005:
        return None

    existing = await db.journal_entries.find_one({
        "company_id": company_id,
        "source_type": "receipt",
        "source_id": rid,
    })
    if existing:
        return existing.get("id")

    cash = await _resolve_account(
        company_id, prefer_id=receipt.get("payment_account_id"),
        prefer_name_regex=r"^checking|^bank\b|^cash\b",
        fallback_type="asset", fallback_name="Cash",
    )
    income = await _resolve_account(
        company_id, prefer_id=receipt.get("category_account_id"),
        prefer_name_regex=r"^sales\b|^service\s+revenue|^revenue\b",
        fallback_type="revenue", fallback_name="Sales",
    )
    if not cash or not income:
        return None

    je_id = str(uuid.uuid4())
    await db.journal_entries.insert_one({
        "id": je_id,
        "company_id": company_id,
        "date": receipt.get("date") or _now_iso()[:10],
        "memo": f"Receipt {receipt.get('merchant') or ''}".strip() or f"Receipt {rid[:8]}",
        "source_type": "receipt",
        "source_id": rid,
        "lines": [
            {"account_id": cash["id"], "account_name": cash["name"],
             "debit": round(amt, 2), "credit": 0.0},
            {"account_id": income["id"], "account_name": income["name"],
             "debit": 0.0, "credit": round(amt, 2)},
        ],
        "created_at": _now_iso(),
        # Sales receipts recognize on BOTH accrual and cash — the sale
        # + payment happen in the same instant, so unlike invoice JEs
        # we tag these `auto_cash` so the cash-basis filter in
        # ``reports._signed_balances`` doesn't strip them.
        "posted_by": "auto_cash",
    })
    await db.receipts.update_one(
        {"id": rid, "company_id": company_id},
        {"$set": {"posted": True, "posted_je_id": je_id}},
    )
    return je_id


async def reverse_document_je(
    company_id: str, source_type: str, source_id: str,
) -> bool:
    """Delete the auto-posted JE for a doc and clear the `posted` flag.

    Used by update endpoints (before repost) and delete endpoints
    (permanent). Returns True if a JE was found and removed.
    """
    if source_type not in _SOURCE_TO_COLL:
        return False
    res = await db.journal_entries.delete_many({
        "company_id": company_id,
        "source_type": source_type,
        "source_id": source_id,
        "posted_by": {"$in": ["auto_accrual", "auto_cash"]},
    })
    coll = _SOURCE_TO_COLL[source_type]
    await db[coll].update_one(
        {"id": source_id, "company_id": company_id},
        {"$unset": {"posted": "", "posted_je_id": ""}},
    )
    return res.deleted_count > 0
