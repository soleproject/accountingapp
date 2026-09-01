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


# ---------- 8. Full description preserved as merchant (Feb 2026 fix) ----------

def test_merchant_preserves_full_description():
    """User report: 'When transactions come in from Veryfi, we need the
    full description in the merchant/description area.' The old extractor
    took only the first word of the memo as merchant, e.g.
    'COSTCO WHSE #0646 SPARKS NV' -> 'COSTCO'. Both fields must now carry
    the full cleaned string so the Transactions UI (which renders
    `merchant || description`) surfaces the whole memo.
    """
    doc = {"accounts": [{"transactions": [
        {"date": "2026-03-30", "debit_amount": 139.01,
         "description": "COSTCO WHSE #0646 SPARKS NV"},
        {"date": "2026-04-01", "credit_amount": 500.0,
         "description": "ZELLE FROM JOHN SMITH REF#1234"},
    ]}]}
    rows = extract_transactions(doc)
    assert rows[0]["merchant"] == "COSTCO WHSE #0646 SPARKS NV"
    assert rows[0]["description"] == "COSTCO WHSE #0646 SPARKS NV"
    assert rows[1]["merchant"] == "ZELLE FROM JOHN SMITH REF#1234"
    assert rows[1]["description"] == "ZELLE FROM JOHN SMITH REF#1234"


# ---------- 9. Phase 2 — Veryfi native vendor & category (string shape) ---------

def test_veryfi_native_vendor_string_populates_merchant():
    """Simple BankStatement schema returns `vendor` and `category` as
    plain strings (per Veryfi's OpenAPI spec). The extractor must
    surface `vendor` as the merchant, override the memo scrub, and
    stamp the row with `veryfi_category` for the downstream
    Stage 0.4 GAAP mapping.
    """
    doc = {"accounts": [{"transactions": [
        {"date": "2026-03-27",
         "debit_amount": 5.50,
         "description": "POS DEBIT #4231 STARBUCKS SEATTLE WA",
         "vendor": "Starbucks",
         "category": "Meals & Entertainment"},
    ]}]}
    rows = extract_transactions(doc)
    assert len(rows) == 1
    row = rows[0]
    assert row["merchant"] == "Starbucks"               # native vendor wins over scrub
    assert row["veryfi_vendor"] == "Starbucks"
    assert row["veryfi_category"] == "Meals & Entertainment"
    # Raw memo preserved on `description` for audit trail
    assert "STARBUCKS SEATTLE" in row["description"]


# ---------- 10. Phase 2 — Veryfi native vendor & category (detailed dict) -------

def test_veryfi_native_vendor_dict_with_value_populates_merchant():
    """Detailed BankStatement schema returns `vendor`/`category` as
    dicts with `value`, `score`, `bounding_region`, etc. The extractor
    must pull the `value` field."""
    doc = {"accounts": [{"transactions": [
        {"date": "2026-03-27",
         "credit_amount": 1200.00,
         "description": "DIRECT DEP ACME CORP PAYROLL",
         "vendor": {"value": "Acme Corp", "score": 0.98,
                    "bounding_region": [1, 2, 3, 4, 5, 6, 7, 8]},
         "category": {"value": "Income", "score": 0.95}},
    ]}]}
    rows = extract_transactions(doc)
    assert len(rows) == 1
    row = rows[0]
    assert row["merchant"] == "Acme Corp"
    assert row["veryfi_vendor"] == "Acme Corp"
    assert row["veryfi_category"] == "Income"


# ---------- 11. Phase 2 — Legacy `{"name": ...}` shape still works --------------

def test_veryfi_legacy_vendor_name_shape():
    """Older Veryfi payloads used `vendor: {"name": ..., "url": ...}`
    (the receipts endpoint shape). Legacy fallback keeps working so
    an occasional pre-Feb-2026 cached payload doesn't lose its
    vendor info."""
    doc = {"accounts": [{"transactions": [
        {"date": "2026-03-27", "debit_amount": 10.0,
         "description": "PURCHASE APPLE.COM/BILL",
         "vendor": {"name": "Apple"}},
    ]}]}
    rows = extract_transactions(doc)
    assert rows[0]["merchant"] == "Apple"
    assert rows[0]["veryfi_vendor"] == "Apple"


# ---------- 12. Phase 2 — Feature-off (no vendor/category) falls back -----------

def test_no_veryfi_vendor_falls_back_to_scrub():
    """When Veryfi's categorization feature is OFF (or a specific
    row failed to classify) the transaction has neither `vendor`
    nor `category`. Existing scrub + memo pipeline must remain
    the fallback."""
    doc = {"accounts": [{"transactions": [
        {"date": "2026-03-27", "debit_amount": 5.50,
         "description": "PURCHASE 0113 STARBUCKS 800-782-7282 WA"},
    ]}]}
    rows = extract_transactions(doc)
    row = rows[0]
    assert row["veryfi_vendor"] is None
    assert row["veryfi_category"] is None
    # Falls back to `clean_bank_memo` scrub
    assert "STARBUCKS" in row["merchant"]


# ---------- 13. Phase 2 — Corrupt / unexpected shapes never crash --------------

def test_vendor_field_defensive_handling():
    """Bad payloads (empty dict, None, wrong type) must degrade
    gracefully to the memo scrub — never raise."""
    from veryfi_service import _read_veryfi_field
    assert _read_veryfi_field(None) == ""
    assert _read_veryfi_field("") == ""
    assert _read_veryfi_field("   ") == ""       # whitespace-only trims to empty
    assert _read_veryfi_field({}) == ""
    assert _read_veryfi_field({"value": ""}) == ""
    assert _read_veryfi_field({"value": None}) == ""
    assert _read_veryfi_field({"unknown_key": "x"}) == ""
    assert _read_veryfi_field(42) == ""           # int → ""
    assert _read_veryfi_field(["a", "b"]) == ""   # list → ""
    # Legacy `name` key requires opt-in
    assert _read_veryfi_field({"name": "Apple"}) == ""
    assert _read_veryfi_field({"name": "Apple"}, name_key="name") == "Apple"


# ---------- 14. Phase 2 — Vendor takes precedence over the memo scrub ----------

def test_veryfi_vendor_wins_when_scrub_would_produce_something():
    """Even when the memo scrub yields a decent-looking merchant,
    Veryfi's native vendor field is a stronger signal (AI-cleaned
    canonical name) so it wins."""
    doc = {"accounts": [{"transactions": [
        {"date": "2026-03-27", "debit_amount": 45.67,
         "description": "PURCHASE 0113 DOORDASH SAN FRANCISCO CA",
         "vendor": "DoorDash, Inc.",
         "category": "Meals & Entertainment"},
    ]}]}
    rows = extract_transactions(doc)
    assert rows[0]["merchant"] == "DoorDash, Inc."


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"OK: {name}")
    print("\nAll veryfi_service.extract_transactions tests passed.")
