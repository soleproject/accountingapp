"""Tests for the PFC → CoA mapping table and resolver (mirrors Rocketbooks'
`lib/accounting/pfc-coa-mapping.ts` + `resolve-pfc-coa.ts`).
"""
import pytest
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import pfc_mapping
from pfc_mapping import get_pfc_mapping, reviewed_by_default


# ---------------------------------------------------------------------------
# Mapping table invariants
# ---------------------------------------------------------------------------

def test_no_duplicate_pfc_detailed_keys():
    """Every PFCv2 detailed code appears exactly once — a duplicate would let
    two rows disagree on the mapping and hide the mistake behind whichever
    landed in the dict second.
    """
    seen: dict[str, int] = {}
    for m in pfc_mapping.PFC_COA_MAPPINGS:
        seen[m.pfc_detailed] = seen.get(m.pfc_detailed, 0) + 1
    dupes = {k: v for k, v in seen.items() if v > 1}
    assert not dupes, f"duplicate PFC keys: {dupes}"


def test_every_personal_row_has_equity_kind():
    """`classification=='personal'` must set equity_kind so the caller knows
    whether it's an owner draw (money out) or contribution (money in)."""
    bad = [m.pfc_detailed for m in pfc_mapping.PFC_COA_MAPPINGS
           if m.classification == "personal" and not m.equity_kind]
    assert not bad, f"personal rows missing equity_kind: {bad}"


def test_personal_draws_route_to_3300_or_contributions_to_3400():
    for m in pfc_mapping.PFC_COA_MAPPINGS:
        if m.classification != "personal":
            continue
        if m.equity_kind == "draw":
            assert m.account_code == "3300", (
                f"{m.pfc_detailed}: draw should map to 3300 Owner's Draw, "
                f"got {m.account_code}"
            )
        elif m.equity_kind == "contribution":
            assert m.account_code == "3400", (
                f"{m.pfc_detailed}: contribution should map to 3400 Owner's "
                f"Contribution, got {m.account_code}"
            )


def test_business_expenses_have_expense_code():
    """business_expense rows must map to a 6xxx or 7xxx (expense) code."""
    for m in pfc_mapping.PFC_COA_MAPPINGS:
        if m.classification != "business_expense":
            continue
        assert m.account_code.startswith(("6", "7")), (
            f"{m.pfc_detailed}: business_expense should map to 6xxx/7xxx, "
            f"got {m.account_code}"
        )


def test_liability_paydown_hits_2xxx():
    for m in pfc_mapping.PFC_COA_MAPPINGS:
        if m.classification not in ("liability_paydown", "liability_increase"):
            continue
        assert m.account_code.startswith("2"), (
            f"{m.pfc_detailed}: liability should map to 2xxx, got {m.account_code}"
        )


# ---------------------------------------------------------------------------
# Spot-check Rocketbooks' key mappings survive the port
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("pfc_detailed, expected_code, expected_classification", [
    # Meals — the biggest category
    ("FOOD_AND_DRINK_RESTAURANT",           "6000", "business_expense"),
    ("FOOD_AND_DRINK_FAST_FOOD",            "6000", "business_expense"),
    ("FOOD_AND_DRINK_COFFEE",               "6000", "business_expense"),
    ("FOOD_AND_DRINK_BEER_WINE_AND_LIQUOR", "6000", "business_expense"),
    # Groceries = personal
    ("FOOD_AND_DRINK_GROCERIES",            "3300", "personal"),
    # Utilities
    ("RENT_AND_UTILITIES_GAS_AND_ELECTRICITY", "6600", "business_expense"),
    ("RENT_AND_UTILITIES_INTERNET_AND_CABLE",  "6600", "business_expense"),
    ("RENT_AND_UTILITIES_TELEPHONE",           "6600", "business_expense"),
    ("RENT_AND_UTILITIES_RENT",                "6700", "business_expense"),
    # Transportation
    ("TRANSPORTATION_GAS",                     "6120", "business_expense"),
    ("TRANSPORTATION_TAXIS_AND_RIDE_SHARES",   "6120", "business_expense"),
    ("TRAVEL_FLIGHTS",                         "6100", "business_expense"),
    ("TRAVEL_LODGING",                         "6100", "business_expense"),
    # Liabilities
    ("LOAN_PAYMENTS_CREDIT_CARD_PAYMENT",      "2100", "liability_paydown"),
    ("LOAN_PAYMENTS_MORTGAGE_PAYMENT",         "2500", "liability_paydown"),
    ("LOAN_PAYMENTS_CAR_PAYMENT",              "2500", "liability_paydown"),
    ("LOAN_DISBURSEMENTS_MORTGAGE",            "2500", "liability_increase"),
    # Bank fees / interest
    ("BANK_FEES_OVERDRAFT_FEES",               "7000", "business_expense"),
    ("INCOME_INTEREST_EARNED",                 "4200", "business_income"),
    # Transfers → transfer_review or asset_movement (never P&L)
    ("TRANSFER_IN_TRANSFER_IN_FROM_APPS",      "4999", "transfer_review"),
    ("TRANSFER_OUT_WIRE",                      "6999", "transfer_review"),
    ("TRANSFER_IN_ACCOUNT_TRANSFER",           "1010", "asset_movement"),
    # Personal buckets
    ("MEDICAL_PRIMARY_CARE",                   "3300", "personal"),
    ("PERSONAL_CARE_GYMS_AND_FITNESS_CENTERS", "3300", "personal"),
    ("GENERAL_MERCHANDISE_CLOTHING_AND_ACCESSORIES", "3300", "personal"),
    ("HOME_IMPROVEMENT_HARDWARE",              "3300", "personal"),
    ("ENTERTAINMENT_CASINOS_AND_GAMBLING",     "3300", "personal"),
    # Insurance
    ("GENERAL_SERVICES_INSURANCE",             "6400", "business_expense"),
    # Merchandise = business supplies
    ("GENERAL_MERCHANDISE_SUPERSTORES",        "6800", "business_expense"),
    ("GENERAL_MERCHANDISE_ELECTRONICS",        "6300", "business_expense"),
])
def test_spot_check_mapping(pfc_detailed, expected_code, expected_classification):
    m = get_pfc_mapping(pfc_detailed)
    assert m is not None, f"No mapping for {pfc_detailed}"
    assert m.account_code == expected_code
    assert m.classification == expected_classification


# ---------------------------------------------------------------------------
# reviewed_by_default matches the Rocketbooks spec table
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("classification, expected", [
    ("business_expense",   True),
    ("business_income",    True),
    ("personal",           True),
    ("liability_paydown",  True),
    ("liability_increase", True),
    ("asset_movement",     False),
    ("transfer_review",    False),
    ("uncategorized",      False),
])
def test_reviewed_by_default_split(classification, expected):
    assert reviewed_by_default(classification) is expected


def test_get_pfc_mapping_none_on_unknown():
    assert get_pfc_mapping(None) is None
    assert get_pfc_mapping("") is None
    assert get_pfc_mapping("TOTALLY_MADE_UP_CODE") is None


def test_pfc_question_shape():
    m = get_pfc_mapping("TRANSFER_IN_TRANSFER_IN_FROM_APPS")
    q = pfc_mapping.pfc_question(m)
    assert "customer payment" in q["question"].lower()
    assert q["description"]  # non-empty
