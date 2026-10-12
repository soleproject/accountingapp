"""Receipt Upload — fold sales tax into the cost of the goods/services.

Scope: ONLY the Receipts page upload/scan flow (routes/payments.py). The
client-review (Q8) receipt flows keep their own tax handling.

Policy: sales tax paid on a purchase is part of the cost of what was
bought ($100 office supplies + $8 tax = $108 Office Supplies). We still
extract tax as its own value for display/audit (`tax_detail`,
`totals.tax`), but the categorized lines — and therefore the JE splits
booked from them — carry tax-inclusive amounts.

Allocation: item-level `tax` when the receipt shows it; otherwise
proportional across taxable lines by amount. Lines marked
`taxable: false` get nothing. Tax lines flagged `recoverable: true`
(VAT/GST input credits) are left as their own line.
"""
from __future__ import annotations

import re

_TAX_DESC = re.compile(r"\b(sales\s*tax|tax(es)?|hst|gst|pst|vat|qst)\b", re.I)
_NOT_TAX = re.compile(r"\b(exempt|tax[-\s]?free|pre[-\s]?tax|after[-\s]?tax|tax\s*credit)\b", re.I)


def is_tax_line(it: dict) -> bool:
    if (it.get("kind") or "").lower() == "tax":
        return True
    hint = (it.get("category_hint") or "").lower()
    if "sales tax" in hint or hint.strip() in ("tax", "use tax", "vat", "gst", "hst"):
        return True
    desc = it.get("description") or ""
    return bool(_TAX_DESC.search(desc)) and not _NOT_TAX.search(desc)


def _cents(x) -> int:
    try:
        return int(round(float(x or 0) * 100))
    except (TypeError, ValueError):
        return 0


def _allocate(total_c: int, weights: list[int]) -> list[int]:
    """Largest-remainder split of `total_c` cents across `weights`."""
    s = sum(weights)
    if s <= 0 or total_c <= 0:
        return [0] * len(weights)
    raw = [total_c * w / s for w in weights]
    out = [int(r) for r in raw]
    rem = total_c - sum(out)
    order = sorted(range(len(weights)), key=lambda i: raw[i] - out[i], reverse=True)
    for i in order[:rem]:
        out[i] += 1
    return out


def fold_sales_tax(arm: dict) -> dict:
    """Mutates + returns `arm` (a categorization result with `line_items`,
    `totals`). Removes non-recoverable tax lines and spreads their amount
    into the taxable goods/services lines. Preserves the original tax
    picture under `tax_detail` for display/audit."""
    lines = arm.get("line_items") or []
    if not lines:
        return arm
    tax_lines = [it for it in lines if is_tax_line(it)]
    goods = [it for it in lines if not is_tax_line(it)]
    if not goods or not tax_lines:
        return arm

    recoverable = [t for t in tax_lines if t.get("recoverable") is True]
    foldable = [t for t in tax_lines if t.get("recoverable") is not True]
    tax_c = sum(_cents(t.get("amount")) for t in foldable)

    # Item-level tax wins when the receipt shows it and it reconciles.
    item_tax_c = [_cents(g.get("tax")) for g in goods]
    if tax_c > 0 and sum(item_tax_c) > 0 and abs(sum(item_tax_c) - tax_c) <= 2:
        alloc = item_tax_c
        method = "item_level"
    else:
        taxable = [g.get("taxable") is not False for g in goods]
        weights = [_cents(g.get("amount")) if tx else 0 for g, tx in zip(goods, taxable)]
        if sum(weights) == 0:  # every line flagged non-taxable — fall back to all
            weights = [_cents(g.get("amount")) for g in goods]
        alloc = _allocate(tax_c, weights)
        method = "proportional"

    allocation = []
    out: list[dict] = []
    for g, a in zip(goods, alloc):
        new = dict(g)
        base_c = _cents(g.get("amount"))
        new["amount"] = round((base_c + a) / 100, 2)
        new["pre_tax_amount"] = round(base_c / 100, 2)
        new["tax_included"] = round(a / 100, 2)
        new.pop("tax", None)
        out.append(new)
        if a:
            allocation.append({"description": g.get("description"), "tax": round(a / 100, 2)})
    out.extend(dict(t) for t in recoverable)

    arm["line_items"] = out
    arm["tax_detail"] = {
        "treatment": "included_in_cost",
        "amount": round(tax_c / 100, 2),
        "method": method,
        "lines": [{"description": t.get("description"), "amount": t.get("amount")} for t in foldable],
        "allocation": allocation,
        "recoverable_kept_separate": round(sum(_cents(t.get("amount")) for t in recoverable) / 100, 2),
    }
    totals = arm.get("totals") if isinstance(arm.get("totals"), dict) else {}
    if tax_c and not totals.get("tax"):
        totals["tax"] = round(tax_c / 100, 2)
    arm["totals"] = totals
    if "suggested_categories" in arm:
        from client_review_engine import rollup_suggested_categories
        arm["suggested_categories"] = rollup_suggested_categories(out)
    return arm


RECEIPT_UPLOAD_TAX_RULES = """

RECEIPT-UPLOAD TAX RULES (override the sales-tax rule above):
* Still emit sales tax as its own line (`category_hint`: "sales tax") and
  fill `totals.tax` — the server records it for audit — but the server
  will FOLD it into the cost of the goods/services, so do NOT worry about
  picking a tax account (account_code/account_name may be null).
* On every goods/services line add `"taxable": true|false`. Use the
  receipt's own tax flags (T/N, *, "TX", "NT", "F" for food, etc.).
  Unprepared groceries, prescriptions and most services are commonly
  non-taxable; when the receipt gives no signal, default to true.
* If the receipt prints tax per item, add `"tax": <amount>` on that line
  (item-level tax beats proportional allocation).
* Mark a tax line `"recoverable": true` ONLY for VAT/GST/HST input-credit
  contexts where the business is registered and the receipt shows a tax
  registration number. US sales tax is never recoverable.
"""
