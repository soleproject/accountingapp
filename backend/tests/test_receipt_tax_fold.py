"""Receipt Upload sales-tax folding (receipt_tax.fold_sales_tax)."""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from receipt_tax import fold_sales_tax, is_tax_line


def _arm(lines, tax=None):
    return {"line_items": lines, "totals": {"grand_total": round(sum(l["amount"] for l in lines), 2), **({"tax": tax} if tax else {})}}


def test_single_category_includes_tax():
    arm = _arm([
        {"description": "Office Supplies", "amount": 100.0, "account_name": "Office Supplies"},
        {"description": "SALES TAX", "amount": 8.0, "category_hint": "sales tax"},
    ])
    fold_sales_tax(arm)
    assert [l["description"] for l in arm["line_items"]] == ["Office Supplies"]
    assert arm["line_items"][0]["amount"] == 108.0
    assert arm["line_items"][0]["tax_included"] == 8.0
    assert arm["tax_detail"]["amount"] == 8.0 and arm["tax_detail"]["treatment"] == "included_in_cost"
    assert arm["totals"]["tax"] == 8.0


def test_proportional_across_taxable_only_sums_to_grand_total():
    arm = _arm([
        {"description": "Lumber", "amount": 200.0, "taxable": True},
        {"description": "Milk (food)", "amount": 50.0, "taxable": False},
        {"description": "Drill", "amount": 100.0, "taxable": True},
        {"description": "Tax", "amount": 24.0, "kind": "tax"},
    ])
    fold_sales_tax(arm)
    by = {l["description"]: l for l in arm["line_items"]}
    assert by["Milk (food)"]["amount"] == 50.0 and by["Milk (food)"]["tax_included"] == 0
    assert by["Lumber"]["amount"] == 216.0 and by["Drill"]["amount"] == 108.0
    assert round(sum(l["amount"] for l in arm["line_items"]), 2) == 374.0
    assert arm["tax_detail"]["method"] == "proportional"


def test_item_level_tax_wins_and_rounding_reconciles():
    arm = _arm([
        {"description": "A", "amount": 33.33, "tax": 2.67},
        {"description": "B", "amount": 33.33, "tax": 2.66},
        {"description": "C", "amount": 33.34, "tax": 2.67},
        {"description": "SALES TAX", "amount": 8.0, "category_hint": "sales tax"},
    ])
    fold_sales_tax(arm)
    assert arm["tax_detail"]["method"] == "item_level"
    assert round(sum(l["amount"] for l in arm["line_items"]), 2) == 108.0
    assert all("tax" not in l for l in arm["line_items"])


def test_recoverable_tax_kept_separate():
    arm = _arm([
        {"description": "Equipment", "amount": 2000.0},
        {"description": "GST", "amount": 100.0, "kind": "tax", "recoverable": True},
        {"description": "PST", "amount": 140.0, "kind": "tax"},
    ])
    fold_sales_tax(arm)
    descs = [l["description"] for l in arm["line_items"]]
    assert descs == ["Equipment", "GST"]
    assert arm["line_items"][0]["amount"] == 2140.0
    assert arm["tax_detail"]["recoverable_kept_separate"] == 100.0


def test_no_tax_line_is_noop():
    arm = _arm([{"description": "Meals", "amount": 200.0}])
    fold_sales_tax(arm)
    assert arm["line_items"][0]["amount"] == 200.0 and "tax_detail" not in arm


def test_tax_line_detection():
    assert is_tax_line({"description": "SALES TAX"})
    assert is_tax_line({"description": "HST 13%"})
    assert is_tax_line({"category_hint": "sales tax", "description": "TX"})
    assert not is_tax_line({"description": "Tax-exempt resale item"})
    assert not is_tax_line({"description": "Lumber 2x4"})
