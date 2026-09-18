"""Tests for the Owner's-Comp routing rules (Feb-2026).

Covers:
* Group 1 (always Owner's Comp, no question).
* Group 2 (company flag ON vs OFF).
* Group 3 (learned feedback, business vs owner_comp vs not-yet-answered).
* pfc_group() classification.
"""
from __future__ import annotations
import pytest

from lab_pipeline.owner_comp_rules import (
    BUSINESS_PROFILE_DEFAULTS,
    GROUP_1_ALWAYS_OWNER_COMP,
    GROUP_2_FLAG_ROUTED,
    GROUP_3_PER_TXN_QUESTION,
    OWNER_COMP_ACCOUNT_NAME,
    pfc_group,
    route_owner_comp_row,
)


def _profile(**overrides):
    return {**BUSINESS_PROFILE_DEFAULTS, **overrides}


# ---------------------------------------------------------------------
# Group counts — protect against accidental drift.
# ---------------------------------------------------------------------

def test_group_sizes():
    assert len(GROUP_1_ALWAYS_OWNER_COMP) == 7
    assert len(GROUP_2_FLAG_ROUTED)       == 7
    assert len(GROUP_3_PER_TXN_QUESTION)  == 7


def test_groups_are_disjoint():
    a = set(GROUP_1_ALWAYS_OWNER_COMP)
    b = set(GROUP_2_FLAG_ROUTED)
    c = set(GROUP_3_PER_TXN_QUESTION)
    assert not (a & b), a & b
    assert not (a & c), a & c
    assert not (b & c), b & c


# ---------------------------------------------------------------------
# pfc_group() classifier
# ---------------------------------------------------------------------

@pytest.mark.parametrize("pfc,grp", [
    ("ENTERTAINMENT_CASINOS_AND_GAMBLING",              "g1"),
    ("ENTERTAINMENT_OTHER_ENTERTAINMENT",               "g1"),   # TCJA non-deductible
    ("ENTERTAINMENT_SPORTING_EVENTS_AMUSEMENT_PARKS_AND_MUSEUMS", "g1"),
    ("GENERAL_MERCHANDISE_PET_SUPPLIES",                "g2"),
    ("LOAN_PAYMENTS_STUDENT_LOAN_PAYMENT",              "g2"),
    ("MEDICAL_VETERINARY_SERVICES",                     "g2"),
    ("MEDICAL_DENTAL_CARE",                             "g3"),
    ("MEDICAL_OTHER_MEDICAL",                           "g3"),
    ("PERSONAL_CARE_LAUNDRY_AND_DRY_CLEANING",          "g3"),
    ("FOOD_AND_DRINK_RESTAURANT",                       None),   # not routed here
    (None,                                               None),
    ("",                                                 None),
])
def test_pfc_group(pfc, grp):
    assert pfc_group(pfc) == grp


# ---------------------------------------------------------------------
# Group 1 — always Owner's Comp
# ---------------------------------------------------------------------

@pytest.mark.parametrize("pfc", sorted(GROUP_1_ALWAYS_OWNER_COMP))
def test_group1_always_owner_comp(pfc):
    d = route_owner_comp_row(
        pfc_detailed     = pfc,
        contact_id       = "any",
        business_profile = _profile(),
        feedback_index   = {},
    )
    assert d["target"] == OWNER_COMP_ACCOUNT_NAME
    assert d["source"] == "owner_comp_always"
    assert d["needs_review"] is False
    assert d["question"] is None


# ---------------------------------------------------------------------
# Group 2 — flag off vs on
# ---------------------------------------------------------------------

def test_group2_flag_off_defaults_owner_comp():
    d = route_owner_comp_row(
        pfc_detailed     = "GENERAL_MERCHANDISE_PET_SUPPLIES",
        contact_id       = "petsmart",
        business_profile = _profile(pet_related_business=False),
        feedback_index   = {},
    )
    assert d["target"] == OWNER_COMP_ACCOUNT_NAME
    assert d["source"] == "owner_comp_flag_off"
    assert d["needs_review"] is False
    # Business target is surfaced so the review UI could still offer it.
    assert d["business_target"] == "Supplies & Materials"


def test_group2_flag_on_routes_to_business():
    d = route_owner_comp_row(
        pfc_detailed     = "GENERAL_MERCHANDISE_PET_SUPPLIES",
        contact_id       = "petsmart",
        business_profile = _profile(pet_related_business=True),
        feedback_index   = {},
    )
    assert d["target"] == "Supplies & Materials"
    assert d["source"] == "business_profile_flag"
    assert d["needs_review"] is False


def test_group2_shared_flag_covers_vet_and_pet_supplies():
    """One flag `pet_related_business` covers both PFCs."""
    prof = _profile(pet_related_business=True)
    d1 = route_owner_comp_row(pfc_detailed="GENERAL_MERCHANDISE_PET_SUPPLIES",
                                contact_id="x", business_profile=prof, feedback_index={})
    d2 = route_owner_comp_row(pfc_detailed="MEDICAL_VETERINARY_SERVICES",
                                contact_id="x", business_profile=prof, feedback_index={})
    assert d1["source"] == "business_profile_flag" and d1["target"] == "Supplies & Materials"
    assert d2["source"] == "business_profile_flag" and d2["target"] == "Veterinary Services"


@pytest.mark.parametrize("pfc,flag,target", [
    ("GENERAL_SERVICES_CHILDCARE",                     "dependent_care_benefit",         "Childcare Expense"),
    ("PERSONAL_CARE_GYMS_AND_FITNESS_CENTERS",         "staff_wellness_plan",            "Dues & Subscriptions"),
    ("LOAN_PAYMENTS_STUDENT_LOAN_PAYMENT",             "employee_student_loan_program",  "Employee Education Assistance"),
    ("ENTERTAINMENT_MUSIC_AND_AUDIO",                  "business_music_service",         "Dues & Subscriptions"),
    ("ENTERTAINMENT_TV_AND_MOVIES",                    "storefront_streaming",           "Dues & Subscriptions"),
])
def test_group2_flag_routing(pfc, flag, target):
    on = route_owner_comp_row(pfc_detailed=pfc, contact_id="x",
                              business_profile=_profile(**{flag: True}),
                              feedback_index={})
    off = route_owner_comp_row(pfc_detailed=pfc, contact_id="x",
                                business_profile=_profile(**{flag: False}),
                                feedback_index={})
    assert on["target"] == target
    assert off["target"] == OWNER_COMP_ACCOUNT_NAME


# ---------------------------------------------------------------------
# Group 3 — feedback learning
# ---------------------------------------------------------------------

def test_group3_no_feedback_needs_review():
    d = route_owner_comp_row(
        pfc_detailed     = "MEDICAL_OTHER_MEDICAL",
        contact_id       = "patientco",
        business_profile = _profile(),
        feedback_index   = {},
    )
    assert d["target"] is None
    assert d["needs_review"] is True
    assert d["source"] == "needs_review"
    assert "employee" in (d["question"] or "").lower()
    assert d["business_target"] == "Medical Expenses"


def test_group3_business_feedback_books_business():
    d = route_owner_comp_row(
        pfc_detailed     = "MEDICAL_OTHER_MEDICAL",
        contact_id       = "patientco",
        business_profile = _profile(),
        feedback_index   = {("patientco", "MEDICAL_OTHER_MEDICAL"): "business"},
    )
    assert d["target"] == "Medical Expenses"
    assert d["source"] == "business_feedback"
    assert d["needs_review"] is False


def test_group3_owner_comp_feedback_books_owner_comp():
    d = route_owner_comp_row(
        pfc_detailed     = "MEDICAL_OTHER_MEDICAL",
        contact_id       = "patientco",
        business_profile = _profile(),
        feedback_index   = {("patientco", "MEDICAL_OTHER_MEDICAL"): "owner_comp"},
    )
    assert d["target"] == OWNER_COMP_ACCOUNT_NAME
    assert d["source"] == "owner_comp_feedback"
    assert d["needs_review"] is False


def test_group3_feedback_scoped_by_contact_plus_pfc():
    """Feedback for (contactA, pfc1) MUST NOT auto-apply to (contactB, pfc1)."""
    idx = {("patientco", "MEDICAL_OTHER_MEDICAL"): "business"}
    same_contact_diff_pfc = route_owner_comp_row(
        pfc_detailed="MEDICAL_DENTAL_CARE", contact_id="patientco",
        business_profile=_profile(), feedback_index=idx,
    )
    diff_contact_same_pfc = route_owner_comp_row(
        pfc_detailed="MEDICAL_OTHER_MEDICAL", contact_id="other",
        business_profile=_profile(), feedback_index=idx,
    )
    assert same_contact_diff_pfc["needs_review"] is True
    assert diff_contact_same_pfc["needs_review"] is True


# ---------------------------------------------------------------------
# Non-routed PFCs (rest of the taxonomy) fall through with no decision.
# ---------------------------------------------------------------------

def test_non_owner_comp_pfc_returns_null_decision():
    d = route_owner_comp_row(
        pfc_detailed     = "FOOD_AND_DRINK_RESTAURANT",
        contact_id       = "starbucks",
        business_profile = _profile(),
        feedback_index   = {},
    )
    assert d["target"] is None
    assert d["source"] is None
    assert d["needs_review"] is False
