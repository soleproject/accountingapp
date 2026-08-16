"""Regression tests — QBO invoice / bill mapper emits `balance_due`.

Pre-fix (before Feb 26 2026), `map_invoice` and `map_bill` stored the
remaining open amount in a field called `balance`. Every other consumer
in the codebase — `_open_ar_ap`, the invoice/bill UI routes, the AR/AP
aging reports, the accrual layer of the balance sheet — reads
`balance_due`. Result: on any QBO-migrated company, AR and AP both
computed as $0 no matter how many open invoices/bills existed, and
the accrual balance-sheet layer silently under-reported total assets
+ liabilities.

The mapper now writes both keys (canonical `balance_due` plus an alias
`balance` for any legacy consumers). It also derives a `partial` status
when part of the amount was collected — previously the mapper only
knew `paid` vs `sent`/`open`, so partially-paid invoices rendered as
"just emailed" in the UI.
"""
from __future__ import annotations

import sys

sys.path.insert(0, "/app/backend")

from qbo_service import map_invoice, map_bill  # noqa: E402


def _make_qbo_invoice(total: float, balance: float, num: str = "1021") -> dict:
    return {
        "Id": "99",
        "DocNumber": num,
        "TxnDate": "2026-06-20",
        "DueDate": "2026-07-20",
        "CustomerRef": {"value": "1", "name": "Amy's Bird Sanctuary"},
        "TotalAmt": total,
        "Balance": balance,
        "TxnTaxDetail": None,
        "Line": [],
        "CurrencyRef": {"value": "USD"},
    }


def _make_qbo_bill(total: float, balance: float, num: str = "B-101") -> dict:
    return {
        "Id": "77",
        "DocNumber": num,
        "TxnDate": "2026-06-15",
        "DueDate": "2026-07-15",
        "VendorRef": {"value": "42", "name": "Bob's Burger Joint"},
        "TotalAmt": total,
        "Balance": balance,
        "Line": [],
        "CurrencyRef": {"value": "USD"},
    }


def test_invoice_mapper_writes_balance_due_field():
    """Field name must be `balance_due` — the rest of the app reads
    this exact key. `balance` is kept as an alias for compatibility."""
    row = map_invoice("cid-1", "realm-1",
                       _make_qbo_invoice(total=459.0, balance=239.0))
    assert row.get("balance_due") == 239.0, (
        f"expected balance_due=239.0, got {row.get('balance_due')!r}. "
        f"Field-name divergence from `_open_ar_ap` — AR will silently "
        f"compute as $0 on every QBO-migrated company."
    )
    # Alias retained.
    assert row.get("balance") == 239.0


def test_bill_mapper_writes_balance_due_field():
    row = map_bill("cid-1", "realm-1",
                   _make_qbo_bill(total=850.0, balance=350.0))
    assert row.get("balance_due") == 350.0, (
        f"expected balance_due=350.0, got {row.get('balance_due')!r}. "
        f"Field-name divergence from `_open_ar_ap` — AP will silently "
        f"compute as $0 on every QBO-migrated company."
    )
    assert row.get("balance") == 350.0


def test_invoice_mapper_partial_status():
    """0 < balance < total → status must be `partial`, not `sent`."""
    row = map_invoice("cid-1", "realm-1",
                       _make_qbo_invoice(total=459.0, balance=239.0))
    assert row["status"] == "partial", row["status"]


def test_invoice_mapper_paid_status():
    row = map_invoice("cid-1", "realm-1",
                       _make_qbo_invoice(total=459.0, balance=0.0))
    assert row["status"] == "paid"


def test_invoice_mapper_unpaid_status():
    row = map_invoice("cid-1", "realm-1",
                       _make_qbo_invoice(total=459.0, balance=459.0))
    assert row["status"] == "sent"


def test_bill_mapper_partial_status():
    row = map_bill("cid-1", "realm-1",
                   _make_qbo_bill(total=850.0, balance=350.0))
    assert row["status"] == "partial"


def test_bill_mapper_paid_status():
    row = map_bill("cid-1", "realm-1",
                   _make_qbo_bill(total=850.0, balance=0.0))
    assert row["status"] == "paid"


def test_bill_mapper_open_status():
    """Bills use `open` (not `sent`) for fully-unpaid — matches the
    manual-bill UI expectation."""
    row = map_bill("cid-1", "realm-1",
                   _make_qbo_bill(total=850.0, balance=850.0))
    assert row["status"] == "open"
