"""Regression tests for QBO mapper null-safety.

The Feb 2026 "QBO 4 LLC" migration failed because `TxnTaxDetail` came
back as an explicit JSON `null` on non-taxable invoices, and the
previous mapper did `obj.get("TxnTaxDetail", {}).get(...)` — which
returns `None` (not the default `{}`) when the key IS present but its
value is null, then crashes with AttributeError on the second `.get()`.

Foundation entities (Account/Customer/Vendor/Item) had already imported
successfully, so the crash killed only Invoices → Bills → Payments →
JournalEntry → all downstream entities. These tests lock in the
`or {}` fallback pattern for every nested-dict access in the mappers.
"""
import qbo_service as Q

CID = "aaaaaaaa-1111-2222-3333-000000000001"


def test_invoice_handles_null_txn_tax_detail():
    """Non-taxable invoices come back with TxnTaxDetail: null."""
    obj = {
        "Id": "42",
        "TxnDate": "2026-01-15",
        "TotalAmt": 100.0,
        "Balance": 100.0,
        "TxnTaxDetail": None,   # ← the crash case
        "CustomerRef": {"value": "c1", "name": "Acme"},
        "Line": [],
    }
    inv = Q.map_invoice(CID, "r1", obj)
    assert inv["tax"] == 0.0
    assert inv["subtotal"] == 100.0
    assert inv["total"] == 100.0


def test_invoice_handles_missing_txn_tax_detail_key():
    obj = {
        "Id": "43", "TxnDate": "2026-01-15",
        "TotalAmt": 50.0, "Balance": 0.0,
        "CustomerRef": {}, "Line": [],
    }
    inv = Q.map_invoice(CID, "r1", obj)
    assert inv["tax"] == 0.0
    assert inv["status"] == "paid"


def test_invoice_handles_null_customer_ref():
    """Some legacy invoices have CustomerRef: null."""
    obj = {
        "Id": "44", "TotalAmt": 10.0,
        "CustomerRef": None, "Line": [],
    }
    inv = Q.map_invoice(CID, "r1", obj)
    assert inv["contact_qbo_id"] is None
    assert inv["contact_name"] == ""


def test_invoice_handles_null_currency_ref():
    obj = {
        "Id": "45", "TotalAmt": 10.0, "Balance": 0.0,
        "CustomerRef": {}, "Line": [], "CurrencyRef": None,
    }
    inv = Q.map_invoice(CID, "r1", obj)
    assert inv["currency"] == "USD"


def test_bill_handles_null_vendor_ref():
    obj = {
        "Id": "9", "TotalAmt": 200.0, "Balance": 200.0,
        "VendorRef": None, "Line": [],
    }
    bill = Q.map_bill(CID, "r1", obj)
    assert bill["contact_qbo_id"] is None
    assert bill["status"] == "open"


def test_payment_handles_no_linked_txn():
    """Unapplied payment — Line entries have no LinkedTxn."""
    obj = {
        "Id": "7", "TxnDate": "2026-01-01", "TotalAmt": 500.0,
        "CustomerRef": {"value": "c1", "name": "Bob"},
        "Line": [{"Amount": 500.0}],
    }
    pay = Q.map_payment(CID, "r1", obj, "in")
    assert pay["applied_to"] == []
    assert pay["amount"] == 500.0


def test_payment_flattens_multiple_linked_txns():
    """A single payment settling two invoices produces two applied_to
    entries — regression against the shadowed-variable comprehension."""
    obj = {
        "Id": "8", "TotalAmt": 300.0,
        "CustomerRef": {"value": "c1", "name": "Bob"},
        "Line": [{
            "Amount": 300.0,
            "LinkedTxn": [
                {"TxnType": "Invoice", "TxnId": "101"},
                {"TxnType": "Invoice", "TxnId": "102"},
            ],
        }],
    }
    pay = Q.map_payment(CID, "r1", obj, "in")
    assert len(pay["applied_to"]) == 2
    assert {a["txn_qbo_id"] for a in pay["applied_to"]} == {"101", "102"}


def test_payment_handles_null_line():
    obj = {
        "Id": "9", "TotalAmt": 100.0,
        "CustomerRef": {"value": "c1", "name": "X"},
        "Line": None,
    }
    pay = Q.map_payment(CID, "r1", obj, "in")
    assert pay["applied_to"] == []


def test_payment_handles_null_deposit_ref():
    obj = {
        "Id": "10", "TotalAmt": 50.0,
        "CustomerRef": {"value": "c1", "name": "X"},
        "DepositToAccountRef": None, "APAccountRef": None,
    }
    pay = Q.map_payment(CID, "r1", obj, "in")
    assert pay["deposit_account_qbo_id"] is None


def test_bill_handles_missing_optional_fields():
    """QBO bills sometimes omit DueDate, DocNumber, CurrencyRef."""
    obj = {"Id": "50", "TotalAmt": 25.0, "VendorRef": {}, "Line": []}
    bill = Q.map_bill(CID, "r1", obj)
    assert bill["number"] == "BILL-50"
    assert bill["currency"] == "USD"
    assert bill["due_date"] == ""
