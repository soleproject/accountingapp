"""Income Statement — Cost of Goods Sold + Gross Profit reporting.

Regression: pre-Feb 25 2026 `compute_income_statement` only emitted
`revenue` and `expense` rows — any account with `type=cogs` was silently
DROPPED from the P&L (dollars invisible, Net Income unaffected). This
was a data-integrity bug that landed when the QBO importer mapped
`AccountType: "Cost of Goods Sold"` → `type: "cogs"` and the reports
code never caught up.
"""
from __future__ import annotations

import sys
import uuid
from datetime import datetime, timezone

sys.path.insert(0, "/app/backend")

from db import db  # noqa: E402
from reports import compute_income_statement  # noqa: E402
from tests._shared_loop import run as _run  # noqa: E402


async def _seed_je_ledger(je_lines):
    """Seed a company + accounts + one balanced journal entry per test.

    `je_lines` items: {account_id, name, type, subtype, detail_type,
    debit, credit}. Debits/credits map to `_signed_balances` (debit +,
    credit −). Revenue accounts posted as CREDIT (positive display).
    """
    cid = str(uuid.uuid4())
    await db.companies.insert_one({
        "id": cid, "name": "COGS Test Co",
        "reporting_basis": "accrual",
    })
    now = datetime.now(timezone.utc).isoformat()
    seen = set()
    for r in je_lines:
        aid = r["account_id"]
        if aid not in seen:
            await db.accounts.insert_one({
                "id": aid, "company_id": cid,
                "code": aid[-4:], "name": r["name"],
                "type": r["type"], "subtype": r["subtype"],
                "detail_type": r["detail_type"],
                "active": True, "balance": 0.0,
                "created_at": now, "updated_at": now,
            })
            seen.add(aid)
    # One JE with all lines (must balance overall for realistic test).
    await db.journal_entries.insert_one({
        "id": str(uuid.uuid4()), "company_id": cid,
        "date": "2026-01-15", "description": "COGS test JE",
        "lines": [
            {"account_id": r["account_id"],
             "debit":  r.get("debit", 0),
             "credit": r.get("credit", 0)}
            for r in je_lines
        ],
        "created_at": now, "updated_at": now,
    })
    return cid


async def _cleanup(cid: str):
    await db.journal_entries.delete_many({"company_id": cid})
    await db.accounts.delete_many({"company_id": cid})
    await db.companies.delete_one({"id": cid})


def test_income_statement_emits_cogs_and_gross_profit():
    """P&L with COGS activity should return cogs rows, total_cogs, and
    gross_profit alongside the usual revenue/expense fields."""
    async def _t():
        # Balanced JE: Rev $10k credit; COGS $3k debit; OpEx $2k debit;
        # plug via cash $5k debit (bank asset — not on P&L).
        cid = await _seed_je_ledger([
            {"account_id": "cash1", "name": "Cash",
             "type": "asset", "subtype": "current_asset",
             "detail_type": "cash_and_bank",
             "debit": 5000.0},
            {"account_id": "rev1", "name": "Service Revenue",
             "type": "revenue", "subtype": "operating_revenue",
             "detail_type": "income",
             "credit": 10000.0},
            {"account_id": "cogs1", "name": "Materials",
             "type": "cogs", "subtype": "cost_of_goods_sold",
             "detail_type": "cost_of_goods_sold",
             "debit": 3000.0},
            {"account_id": "exp1", "name": "Rent",
             "type": "expense", "subtype": "operating_expense",
             "detail_type": "operating_expense",
             "debit": 2000.0},
        ])
        try:
            data = await compute_income_statement(
                cid, "2026-01-01", "2026-01-31", basis="cash",
            )
            # Contract fields present
            assert "cogs" in data
            assert "total_cogs" in data
            assert "gross_profit" in data
            # COGS section has the Materials row
            assert len(data["cogs"]) == 1
            assert data["cogs"][0]["name"] == "Materials"
            # Totals
            assert abs(data["total_revenue"] - 10000.0) < 0.01
            assert abs(data["total_cogs"] - 3000.0) < 0.01
            assert abs(data["gross_profit"] - 7000.0) < 0.01, \
                f"expected 7000, got {data['gross_profit']}"
            assert abs(data["total_expense"] - 2000.0) < 0.01
            assert abs(data["net_income"] - 5000.0) < 0.01, \
                f"expected 5000, got {data['net_income']}"
        finally:
            await _cleanup(cid)
    _run(_t())


def test_income_statement_backwards_compatible_no_cogs():
    """Companies with no COGS activity get identical output to pre-fix:
    total_cogs=0, gross_profit=total_revenue, net_income unchanged."""
    async def _t():
        cid = await _seed_je_ledger([
            {"account_id": "cash1", "name": "Cash",
             "type": "asset", "subtype": "current_asset",
             "detail_type": "cash_and_bank",
             "debit": 8000.0},
            {"account_id": "rev1", "name": "Service Revenue",
             "type": "revenue", "subtype": "operating_revenue",
             "detail_type": "income",
             "credit": 10000.0},
            {"account_id": "exp1", "name": "Rent",
             "type": "expense", "subtype": "operating_expense",
             "detail_type": "operating_expense",
             "debit": 2000.0},
        ])
        try:
            data = await compute_income_statement(
                cid, "2026-01-01", "2026-01-31", basis="cash",
            )
            assert data["total_cogs"] == 0
            assert data["cogs"] == []
            assert abs(data["gross_profit"] - data["total_revenue"]) < 0.01
            assert abs(data["net_income"] - 8000.0) < 0.01
        finally:
            await _cleanup(cid)
    _run(_t())


def test_income_statement_pdf_builds_with_cogs_activity():
    """PDF renderer must not KeyError on the new total_cogs/gross_profit
    fields when the company has COGS activity."""
    async def _t():
        cid = await _seed_je_ledger([
            {"account_id": "cash1", "name": "Cash",
             "type": "asset", "subtype": "current_asset",
             "detail_type": "cash_and_bank",
             "debit": 7000.0},
            {"account_id": "rev1", "name": "Sales",
             "type": "revenue", "subtype": "operating_revenue",
             "detail_type": "income",
             "credit": 10000.0},
            {"account_id": "cogs1", "name": "Materials",
             "type": "cogs", "subtype": "cost_of_goods_sold",
             "detail_type": "cost_of_goods_sold",
             "debit": 3000.0},
        ])
        try:
            from reports import build_income_statement_pdf
            data = await compute_income_statement(
                cid, "2026-01-01", "2026-01-31", basis="cash",
            )
            pdf_bytes = build_income_statement_pdf(data)
            assert isinstance(pdf_bytes, bytes)
            assert len(pdf_bytes) > 1000
        finally:
            await _cleanup(cid)
    _run(_t())
