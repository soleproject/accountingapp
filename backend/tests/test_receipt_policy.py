"""receipt_policy.evaluate — pure rules, no DB/LLM."""
import sys

sys.path.insert(0, "/app/backend")
import receipt_policy as rp  # noqa: E402

SUP = {"id": "a", "type": "expense", "code": "6800", "name": "Supplies & Materials"}
LIAB = {"id": "l", "type": "liability", "code": "2100", "name": "Capital One"}


def _t(**kw):
    base = {"amount": -150.0, "category_account_id": "a", "description": "X", "date": "2026-09-01", "id": "t"}
    base.update(kw)
    return base


def test_floor_and_documentation():
    assert rp.evaluate(_t(amount=-50), SUP, "unknown", "point_of_sale").reason == "below_floor"
    assert rp.evaluate(_t(amount=200), SUP, "unknown", "point_of_sale").reason == "not_outflow"
    for k in ("receipt_id", "matched_receipt_id", "veryfi_receipt_id", "linked_bill_id", "linked_invoice_id"):
        assert rp.evaluate(_t(**{k: "x"}), SUP, "unknown", "point_of_sale").reason == "documented"
    assert rp.evaluate(_t(attachments=[{"id": 1}]), SUP, "unknown", "point_of_sale").reason == "documented"


def test_uncategorized_and_non_expense_skip():
    assert rp.evaluate(_t(category_account_id=None), None, "retail_store", "point_of_sale").reason == "uncategorized_first"
    assert rp.evaluate(_t(category_account_id="l"), LIAB, "retail_store", "point_of_sale").reason == "not_expense"
    unc = {"id": "u", "type": "expense", "code": "6999", "name": "Uncategorized Expense"}
    assert rp.evaluate(_t(category_account_id="u"), unc, "retail_store", "point_of_sale").reason == "uncategorized_first"


def test_bills_transfers_p2p_skip():
    assert not rp.evaluate(_t(description="Zelle payment to Bob"), SUP, "unknown", "point_of_sale").flag
    assert rp.evaluate(_t(description="PURCHASE SPI*DIRECTV RECURRING"), SUP, "unknown", "point_of_sale").reason == "bank_descriptor_bill"
    assert rp.evaluate(_t(description="NEW YORK LIFE DES:INS. PREM."), SUP, "unknown", "point_of_sale").reason == "bank_descriptor_bill"
    assert rp.evaluate(_t(pfc_primary="RENT_AND_UTILITIES"), SUP, "unknown", "point_of_sale").reason == "pfc:RENT_AND_UTILITIES"
    assert rp.evaluate(_t(pfc_primary="LOAN_PAYMENTS"), SUP, "unknown", "point_of_sale").reason == "pfc:LOAN_PAYMENTS"
    assert rp.evaluate(_t(pfc_detailed="GENERAL_SERVICES_INSURANCE", pfc_primary="GENERAL_SERVICES"), SUP, "unknown", "point_of_sale").reason.startswith("pfc:")
    assert rp.evaluate(_t(transfer_pair_id="p"), SUP, "unknown", "point_of_sale").reason == "transfer"


def test_point_of_sale_flags_with_reason():
    assert rp.evaluate(_t(pfc_primary="GENERAL_MERCHANDISE"), SUP, "unknown", "point_of_sale").reason == "pos_retail"
    assert rp.evaluate(_t(pfc_primary="FOOD_AND_DRINK"), SUP, "unknown", "other").reason == "meals"
    assert rp.evaluate(_t(pfc_primary="TRANSPORTATION", pfc_detailed="TRANSPORTATION_GAS"), SUP, "unknown", "other").reason == "fuel"
    assert rp.evaluate(_t(pfc_primary="TRANSPORTATION", pfc_detailed="TRANSPORTATION_PARKING"), SUP, "unknown", "other").reason == "parking_transport"
    assert rp.evaluate(_t(pfc_primary="TRANSFER_OUT", pfc_detailed="TRANSFER_OUT_WITHDRAWAL"), SUP, "unknown", "other").reason == "cash_withdrawal"
    assert rp.evaluate(_t(), SUP, "retail_store", "other").reason == "pos_retail"
    assert rp.evaluate(_t(), SUP, "hardware_supplies", "other").reason == "supplies_equipment"
    d = rp.evaluate(_t(), SUP, "unknown", "point_of_sale")
    assert d.flag and d.reason == "in_person_other" and d.label


def test_online_marketplace_depends_on_account():
    amz = _t(pfc_primary="GENERAL_MERCHANDISE", pfc_detailed="GENERAL_MERCHANDISE_ONLINE_MARKETPLACES")
    assert rp.evaluate(amz, SUP, "unknown", "point_of_sale").reason == "online_unknown_items"
    assert not rp.evaluate(amz, SUP, "unknown", "recurring_bill").flag
    assert rp.evaluate(_t(), SUP, "online_marketplace", "point_of_sale").reason == "online_unknown_items"


def test_merchant_and_account_profiles_skip():
    for p in ("utility_telecom", "insurer", "lender", "saas_subscription", "government_tax", "payroll_provider", "professional_service"):
        assert not rp.evaluate(_t(), SUP, p, "point_of_sale").flag
    for p in ("recurring_bill", "financing", "payroll", "tax", "fees", "professional_services"):
        assert not rp.evaluate(_t(), SUP, "unknown", p).flag
    assert rp.evaluate(_t(), SUP, "unknown", "other").reason == "unknown"
