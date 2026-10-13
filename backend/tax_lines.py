"""Tax-line catalog — federal, versioned by tax year, keyed by STABLE
semantic keys (accounts map to keys, never to line numbers). When the
IRS renumbers a form only this file changes.

Slice 1: Schedule C (Form 1040) and Form 1120-S. 1065 / 1120 to follow.
Hybrid refresh policy: mechanical parameters (meals %, mileage, §179,
bonus %) may auto-publish yearly; structural line changes require a
human-approved release.
"""
from __future__ import annotations

FORMS = {"sched_c": "Schedule C (Form 1040)", "1120s": "Form 1120-S", "1065": "Form 1065", "1120": "Form 1120"}

# business_type (canonical, routes/onboarding.py) → form
_BT_FORM = {
    "sole proprietor": "sched_c",
    "llc – partnership": "1065", "llc - partnership": "1065", "limited partnership": "1065",
    "llc – s elected": "1120s", "llc - s elected": "1120s", "s corporation": "1120s", "s-corp": "1120s",
    "llc – c elected": "1120", "llc - c elected": "1120", "c corporation": "1120", "c-corp": "1120",
}


def form_for_business_type(bt: str | None) -> str | None:
    low = (bt or "").strip().lower().replace("“", "").replace("”", "").replace('"', "")
    if not low:
        return None
    if low in _BT_FORM:
        return _BT_FORM[low]
    if "sole" in low or "solo" in low or "self-employed" in low or "single" in low or "disregarded" in low:
        return "sched_c"
    if "s elected" in low or "s corp" in low or "s-corp" in low or "sub s" in low:
        return "1120s"
    if "c elected" in low or "c corp" in low or "c-corp" in low:
        return "1120"
    if "partnership" in low or "llc" in low:
        return "1065"
    return None


# Semantic keys (shared across forms). section: income | cogs | deduction | not_on_return | balance
KEYS: dict[str, dict] = {
    "gross_receipts":      {"label": "Gross receipts or sales", "section": "income"},
    "returns_allowances":  {"label": "Returns and allowances", "section": "income"},
    "other_income":        {"label": "Other income", "section": "income"},
    "interest_income":     {"label": "Interest income", "section": "income"},
    "cogs":                {"label": "Cost of goods sold", "section": "cogs"},
    "advertising":         {"label": "Advertising", "section": "deduction"},
    "car_truck":           {"label": "Car and truck expenses", "section": "deduction"},
    "commissions_fees":    {"label": "Commissions and fees", "section": "deduction"},
    "contract_labor":      {"label": "Contract labor", "section": "deduction"},
    "depreciation":        {"label": "Depreciation and §179", "section": "deduction"},
    "employee_benefits":   {"label": "Employee benefit programs", "section": "deduction"},
    "insurance":           {"label": "Insurance (other than health)", "section": "deduction"},
    "interest_mortgage":   {"label": "Mortgage interest", "section": "deduction"},
    "interest_other":      {"label": "Other interest", "section": "deduction"},
    "legal_professional":  {"label": "Legal and professional services", "section": "deduction"},
    "office_expense":      {"label": "Office expense", "section": "deduction"},
    "pension":             {"label": "Pension and profit-sharing plans", "section": "deduction"},
    "rent_equipment":      {"label": "Rent — vehicles, machinery, equipment", "section": "deduction"},
    "rent_other":          {"label": "Rent — other business property", "section": "deduction"},
    "repairs":             {"label": "Repairs and maintenance", "section": "deduction"},
    "supplies":            {"label": "Supplies", "section": "deduction"},
    "taxes_licenses":      {"label": "Taxes and licenses", "section": "deduction"},
    "travel":              {"label": "Travel", "section": "deduction"},
    "meals":               {"label": "Deductible meals", "section": "deduction", "limit_pct": 50},
    "utilities":           {"label": "Utilities", "section": "deduction"},
    "wages":               {"label": "Wages (less employment credits)", "section": "deduction"},
    "officer_comp":        {"label": "Compensation of officers", "section": "deduction"},
    "bad_debts":           {"label": "Bad debts", "section": "deduction"},
    "charitable":          {"label": "Charitable contributions", "section": "deduction"},
    "other_expenses":      {"label": "Other expenses", "section": "deduction"},
    "not_on_return":       {"label": "Not on return (non-deductible / owner personal)", "section": "not_on_return"},
    "balance_sheet":       {"label": "Balance sheet item (not a P&L line)", "section": "balance"},
}

# key → line per form, per tax year. None = key not applicable (falls to other_*).
CATALOG: dict[int, dict[str, dict[str, str | None]]] = {
    2026: {
        "sched_c": {
            "gross_receipts": "1", "returns_allowances": "2", "cogs": "4", "other_income": "6", "interest_income": "6",
            "advertising": "8", "car_truck": "9", "commissions_fees": "10", "contract_labor": "11", "depreciation": "13",
            "employee_benefits": "14", "insurance": "15", "interest_mortgage": "16a", "interest_other": "16b",
            "legal_professional": "17", "office_expense": "18", "pension": "19", "rent_equipment": "20a", "rent_other": "20b",
            "repairs": "21", "supplies": "22", "taxes_licenses": "23", "travel": "24a", "meals": "24b", "utilities": "25",
            "wages": "26", "other_expenses": "27a", "officer_comp": "26", "bad_debts": "27a",
            "charitable": None, "not_on_return": None, "balance_sheet": None,
        },
        "1120s": {
            "gross_receipts": "1a", "returns_allowances": "1b", "cogs": "2", "other_income": "5", "interest_income": "Sch K 4",
            "officer_comp": "7", "wages": "8", "repairs": "9", "bad_debts": "10", "rent_equipment": "11", "rent_other": "11",
            "taxes_licenses": "12", "interest_other": "13", "interest_mortgage": "13", "depreciation": "14",
            "advertising": "16", "pension": "17", "employee_benefits": "18", "other_expenses": "19",
            "car_truck": "19", "commissions_fees": "19", "contract_labor": "19", "insurance": "19", "legal_professional": "19",
            "office_expense": "19", "supplies": "19", "travel": "19", "meals": "19", "utilities": "19",
            "charitable": "Sch K 12a", "not_on_return": None, "balance_sheet": None,
        },
    },
}
PARAMS: dict[int, dict] = {2026: {"meals_pct": 50, "mileage_rate": 0.70, "sec179_cap": 1_250_000, "bonus_pct": 40,
                                  "verified_on": "2026-01-15", "status": "verified"}}
SUPPORTED_FORMS = ("sched_c", "1120s")


def catalog_year(tax_year: int) -> int:
    years = sorted(CATALOG)
    return max([y for y in years if y <= tax_year] or [years[0]])


def lines_for(form: str, tax_year: int) -> list[dict]:
    y = catalog_year(tax_year)
    table = CATALOG[y].get(form) or {}
    out = []
    for key, meta in KEYS.items():
        line = table.get(key)
        out.append({"key": key, "label": meta["label"], "section": meta["section"], "line": line,
                    "limit_pct": meta.get("limit_pct"), "on_return": line is not None})
    return out


# ---- rule-based suggestion (deterministic, high confidence only) ----
_RULES: list[tuple[str, str]] = [
    (r"not[\s-]?on[\s-]?return|non[\s-]?deductible|penalt|\bfines?\b|political|lobby|entertain", "not_on_return"),
    (r"owner'?s? (draw|comp|distribution)|distributions?|dividends?|retained", "not_on_return"),
    (r"charit|donation", "charitable"),
    (r"officer|shareholder[- ]employee", "officer_comp"),
    (r"\bwages?\b|salar|payroll(?! tax)", "wages"),
    (r"payroll tax|\bfica\b|futa|suta|licen|property tax|taxes? & lic|franchise tax|sales tax paid", "taxes_licenses"),
    (r"\bmeals?\b|dining|subsistence", "meals"),
    (r"travel|lodging|airfare|hotel", "travel"),
    (r"advertis|marketing|promotion", "advertising"),
    (r"\bauto\b|vehicle|fuel|gas(oline)?|mileage|car |truck|parking|tolls", "car_truck"),
    (r"commission|referral fee|merchant fee|bank fee|processing fee|payment fee", "commissions_fees"),
    (r"contract(or)? labor|subcontract|1099|freelanc", "contract_labor"),
    (r"depreciat|amortiz|§ ?179", "depreciation"),
    (r"health insurance|benefit|401|retirement|pension|profit[- ]sharing", "employee_benefits"),
    (r"insurance", "insurance"),
    (r"mortgage interest", "interest_mortgage"),
    (r"interest (expense|paid)|loan interest|finance charge", "interest_other"),
    (r"legal|professional fee|accounting fee|bookkeep|consult(ing|ant) fee|cpa", "legal_professional"),
    (r"office (supplies|expense)|postage|printing|stationery|software|subscription|internet|phone|telephone|dues", "office_expense"),
    (r"equipment (rent|lease)|vehicle (rent|lease)|machinery", "rent_equipment"),
    (r"\brent\b|lease", "rent_other"),
    (r"repair|maintenance", "repairs"),
    (r"suppl(y|ies)|materials|small tools", "supplies"),
    (r"utilit|electric|water|gas bill|trash|waste", "utilities"),
    (r"bad debt|uncollect", "bad_debts"),
    (r"interest income|dividend income", "interest_income"),
    (r"cost of (goods|sales)|cogs|food cost|materials cost|direct labor|purchases", "cogs"),
    (r"returns|allowances|discounts given|refunds", "returns_allowances"),
    (r"other income|misc income|rebate|gain on", "other_income"),
    (r"revenue|sales|income|fees earned", "gross_receipts"),
]


def rule_suggest(acct: dict) -> str | None:
    import re
    t = (acct.get("type") or "").lower()
    if t in ("asset", "liability", "equity", "bank", "credit_card"):
        return "balance_sheet"
    dt = (acct.get("detail_type") or acct.get("subtype") or "").lower()
    name = (acct.get("name") or "").lower()
    if t == "expense" and "cost_of_goods" in dt:
        return "cogs"
    if acct.get("deductible_pct") == 0:
        return "not_on_return"
    for pat, key in _RULES:
        if re.search(pat, name):
            if key in ("gross_receipts", "other_income", "interest_income", "returns_allowances") and t == "expense":
                continue
            if key not in ("gross_receipts", "other_income", "interest_income", "returns_allowances", "cogs") and t in ("revenue", "income"):
                continue
            return key
    if t in ("revenue", "income"):
        return "gross_receipts" if "operating" in dt else None
    return None
