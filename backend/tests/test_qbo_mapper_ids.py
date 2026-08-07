"""Regression tests for the QBO mapper `id` field. Every mapper must
produce a globally-unique `id` that combines company_id + entity kind
+ QBO Id, because the `contacts` / `accounts` / etc. collections have
a global `id_uniq` unique index that spans companies.
"""
import qbo_service as Q


C1 = "aaaaaaaa-1111-2222-3333-000000000001"
C2 = "bbbbbbbb-1111-2222-3333-000000000002"


def _obj(_id: str = "1"):
    return {
        "Id": _id, "Name": "Test", "DisplayName": "Test",
        "AccountType": "Bank", "TotalAmt": 100.0,
        "CustomerRef": {"value": "c1", "name": "Acme"},
        "VendorRef": {"value": "v1", "name": "Uber"},
    }


def test_account_id_is_company_scoped():
    """Two companies importing the SAME QBO account (Id=1) must produce
    distinct top-level `id`s, otherwise the second import hits E11000
    on `id_uniq` and the account silently drops."""
    a1 = Q.map_account(C1, "r", _obj())
    a2 = Q.map_account(C2, "r", _obj())
    assert a1["id"] != a2["id"]
    assert C1[:8] in a1["id"] and C2[:8] in a2["id"]


def test_contact_id_disambiguates_customer_vs_vendor():
    """Customer #1 and Vendor #1 both come from QBO with Id='1' — they
    must NOT collide since they share the contacts collection."""
    cust = Q.map_contact(C1, "r", _obj(), "customer")
    vend = Q.map_contact(C1, "r", _obj(), "vendor")
    assert cust["id"] != vend["id"]


def test_item_and_txn_ids_are_company_scoped():
    """Same rule applies to items, invoices, bills, payments, JEs."""
    itm1 = Q.map_item(C1, "r", _obj())
    itm2 = Q.map_item(C2, "r", _obj())
    assert itm1["id"] != itm2["id"]

    inv1 = Q.map_invoice(C1, "r", _obj())
    inv2 = Q.map_invoice(C2, "r", _obj())
    assert inv1["id"] != inv2["id"]

    bill1 = Q.map_bill(C1, "r", _obj())
    bill2 = Q.map_bill(C2, "r", _obj())
    assert bill1["id"] != bill2["id"]

    pay1 = Q.map_payment(C1, "r", _obj(), "in")
    pay2 = Q.map_payment(C2, "r", _obj(), "in")
    assert pay1["id"] != pay2["id"]


def test_payment_direction_disambiguates():
    """Payment (money-in) vs BillPayment (money-out) share the payments
    collection — their ids must differ even in the same company."""
    p_in = Q.map_payment(C1, "r", _obj(), "in")
    p_out = Q.map_payment(C1, "r", _obj(), "out")
    assert p_in["id"] != p_out["id"]
