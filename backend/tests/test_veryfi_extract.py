"""Veryfi `extract_transactions` regression tests.

Covers the Feb 17, 2026 fix — Veryfi's bank-statement product returned an
empty top-level `transactions[]` array with the real rows nested inside
`accounts[i].transactions`. The old extractor missed all of them.
"""
from __future__ import annotations
import os
import sys

sys.path.insert(0, "/app/backend")
from dotenv import dotenv_values
_env = dotenv_values("/app/backend/.env")
for k in ("MONGO_URL", "DB_NAME", "VERYFI_CLIENT_ID", "VERYFI_USERNAME", "VERYFI_API_KEY"):
    if k in _env:
        os.environ.setdefault(k, _env[k].strip('"'))

from veryfi_service import extract_transactions  # noqa: E402


# ---------- 1. Nested inside accounts[0].transactions (current shape) ----------

def test_nested_account_transactions():
    doc = {
        "bank_name": "Bank of America",
        "period_start_date": "2026-03-24",
        "period_end_date": "2026-04-22",
        "transactions": [],  # top-level empty — the trap
        "accounts": [{
            "number": "6084",
            "beginning_balance": 1983.24,
            "transactions": [
                {"date": "2026-03-27",
                 "credit_amount": 384.90, "debit_amount": None,
                 "description": "Healthy Paws Pet DES:claimpymt"},
                {"date": "2026-03-28",
                 "credit_amount": None, "debit_amount": 25.00,
                 "description": "Monthly Maintenance Fee"},
                {"date": "2026-03-30",
                 "credit_amount": None, "debit_amount": 139.01,
                 "description": "COSTCO WHSE #0646 SPARKS NV"},
            ],
        }],
    }
    rows = extract_transactions(doc)
    assert len(rows) == 3, f"expected 3, got {len(rows)}"
    assert rows[0]["amount"] == 384.90  # credit → positive
    assert rows[1]["amount"] == -25.00  # debit → negative
    assert rows[2]["amount"] == -139.01
    assert rows[0]["date"] == "2026-03-27"
    assert "Healthy Paws" in rows[0]["description"]


# ---------- 2. Top-level transactions (older shape) still works ----------

def test_top_level_transactions_shape():
    doc = {
        "bank_name": "Chase",
        "transactions": [
            {"date": "2026-05-01", "credit_amount": 100.0, "debit_amount": None,
             "description": "Deposit"},
        ],
    }
    rows = extract_transactions(doc)
    assert len(rows) == 1
    assert rows[0]["amount"] == 100.0


# ---------- 3. Both top-level AND nested (defensive — should combine) ----------

def test_both_shapes_combined():
    doc = {
        "transactions": [
            {"date": "2026-05-01", "credit_amount": 100.0, "description": "Top-level row"},
        ],
        "accounts": [{"transactions": [
            {"date": "2026-05-02", "debit_amount": 50.0, "description": "Nested row"},
        ]}],
    }
    rows = extract_transactions(doc)
    assert len(rows) == 2, [r["description"] for r in rows]
    descs = {r["description"] for r in rows}
    assert descs == {"Top-level row", "Nested row"}


# ---------- 4. Multi-account statement — both accounts flatten together ----------

def test_multi_account_flatten():
    doc = {
        "accounts": [
            {"number": "6084", "transactions": [
                {"date": "2026-05-01", "debit_amount": 10.0, "description": "checking row"},
            ]},
            {"number": "9917", "transactions": [
                {"date": "2026-05-01", "credit_amount": 200.0, "description": "savings row"},
                {"date": "2026-05-02", "debit_amount": 5.0, "description": "savings fee"},
            ]},
        ],
    }
    rows = extract_transactions(doc)
    assert len(rows) == 3


# ---------- 5. Empty everything → empty result, no crash ----------

def test_empty_doc():
    assert extract_transactions({}) == []
    assert extract_transactions({"transactions": [], "accounts": [], "line_items": []}) == []


# ---------- 6. `text` field with tabs/newlines gets collapsed ----------

def test_description_normalization():
    doc = {"accounts": [{"transactions": [
        {"date": "2026-05-01", "credit_amount": 1.0,
         "text": "03/27/26\tHealthy Paws\t\tPet\n0004783218"},
    ]}]}
    rows = extract_transactions(doc)
    assert len(rows) == 1
    assert "\t" not in rows[0]["description"]
    assert "\n" not in rows[0]["description"]
    assert "Healthy Paws" in rows[0]["description"]


# ---------- 7. Documents-endpoint (receipt) fallback still works ----------

def test_line_items_shape():
    doc = {
        "date": "2026-05-01",
        "vendor": {"name": "Starbucks"},
        "line_items": [
            {"description": "Latte", "total": 5.50},
            {"description": "Croissant", "total": 3.25},
        ],
    }
    rows = extract_transactions(doc)
    assert len(rows) == 2
    # line items are treated as expenses (negative)
    assert all(r["amount"] < 0 for r in rows)


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"OK: {name}")
    print("\nAll 7 veryfi_service.extract_transactions tests passed.")
