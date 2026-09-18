"""Owner's Compensation routing rules (Feb-2026).

Handles the 21 PFC values that require distinguishing personal /
Owner's Comp use from a deductible business expense. Three groups:

  1. Always Owner's Comp (7 PFCs) — TCJA-non-deductible entertainment,
     gambling, tobacco, hair & beauty, other personal care. Always
     book to the ``Owner's Compensation`` equity account, no CPA
     question.

  2. Company-level flag (7 PFCs) — one-time yes/no per company on
     ``company.lab_settings.business_profile``. When the flag is TRUE
     the row books to the business account (Supplies, Dues, etc.);
     otherwise Owner's Comp.

  3. Per-transaction question (7 PFCs) — needs a CPA/client verdict
     on ``lab_feedback``. Feedback is keyed on
     ``(company_id, contact_id, pfc_detailed)`` so ONE answer
     ("always this way for Home Depot") auto-applies to every future
     row with the same merchant + same PFC. When no feedback exists
     yet, Step 8 flags the row with review reason
     ``taxable_or_business_expense``.

The account name used for the "personal / non-deductible" side is
always ``Owner's Compensation`` — an equity account the pending-
accounts proposer auto-creates if the CoA doesn't have one.
"""
from __future__ import annotations

from db import db

OWNER_COMP_ACCOUNT_NAME = "Owner's Compensation"

# Group 1 — never business, no question, always Owner's Comp.
GROUP_1_ALWAYS_OWNER_COMP = frozenset({
    "ENTERTAINMENT_CASINOS_AND_GAMBLING",
    "ENTERTAINMENT_VIDEO_GAMES",
    "ENTERTAINMENT_OTHER_ENTERTAINMENT",              # TCJA non-deductible
    "ENTERTAINMENT_SPORTING_EVENTS_AMUSEMENT_PARKS_AND_MUSEUMS",  # TCJA non-deductible
    "GENERAL_MERCHANDISE_TOBACCO_AND_VAPE",
    "PERSONAL_CARE_HAIR_AND_BEAUTY",
    "PERSONAL_CARE_OTHER_PERSONAL_CARE",
})

# Group 2 — pfc → (business_profile flag key, business target account).
# When the flag is TRUE the row auto-books to the business target;
# otherwise it books to Owner's Comp.
GROUP_2_FLAG_ROUTED: dict[str, tuple[str, str]] = {
    "GENERAL_MERCHANDISE_PET_SUPPLIES":               ("pet_related_business",       "Supplies & Materials"),
    "MEDICAL_VETERINARY_SERVICES":                    ("pet_related_business",       "Veterinary Services"),
    "GENERAL_SERVICES_CHILDCARE":                     ("dependent_care_benefit",     "Childcare Expense"),
    "PERSONAL_CARE_GYMS_AND_FITNESS_CENTERS":         ("staff_wellness_plan",        "Dues & Subscriptions"),
    "LOAN_PAYMENTS_STUDENT_LOAN_PAYMENT":             ("employee_student_loan_program", "Employee Education Assistance"),
    "ENTERTAINMENT_MUSIC_AND_AUDIO":                  ("business_music_service",     "Dues & Subscriptions"),
    "ENTERTAINMENT_TV_AND_MOVIES":                    ("storefront_streaming",       "Dues & Subscriptions"),
}

# Group 3 — pfc → (client-review question, business target account).
# When feedback['choice'] == 'business' the row books to the target;
# choice == 'owner_comp' books to Owner's Comp. No feedback → review.
GROUP_3_PER_TXN_QUESTION: dict[str, tuple[str, str]] = {
    "MEDICAL_DENTAL_CARE":                    ("Is this covered under an employee benefit plan, or is it for you / your family?", "Employee Health Insurance"),
    "MEDICAL_EYE_CARE":                       ("Is this covered under an employee benefit plan, or is it for you / your family?", "Employee Health Insurance"),
    "MEDICAL_NURSING_CARE":                   ("Is this for an employee under your plan, or personal (self / family)?",              "Medical Expenses"),
    "MEDICAL_OTHER_MEDICAL":                  ("Is this for an employee under your plan, or personal (self / family)?",              "Medical Expenses"),
    "MEDICAL_PRIMARY_CARE":                   ("Is this for an employee under your plan, or personal (self / family)?",              "Medical Expenses"),
    "MEDICAL_PHARMACIES_AND_SUPPLEMENTS":     ("Was this for the office first-aid / medicine cabinet, or personal medication?",       "Supplies & Materials"),
    "PERSONAL_CARE_LAUNDRY_AND_DRY_CLEANING": ("Was this for branded uniforms only (not wearable off-duty), or regular clothing?",     "Uniforms"),
}

# Default profile — every flag defaults to FALSE (conservative).
BUSINESS_PROFILE_DEFAULTS: dict[str, bool] = {
    "pet_related_business":          False,
    "dependent_care_benefit":        False,
    "staff_wellness_plan":           False,
    "employee_student_loan_program": False,
    "business_music_service":        False,
    "storefront_streaming":          False,
}


def pfc_group(pfc_detailed: str | None) -> str | None:
    """Returns "g1" / "g2" / "g3" / None."""
    if not pfc_detailed:
        return None
    if pfc_detailed in GROUP_1_ALWAYS_OWNER_COMP:
        return "g1"
    if pfc_detailed in GROUP_2_FLAG_ROUTED:
        return "g2"
    if pfc_detailed in GROUP_3_PER_TXN_QUESTION:
        return "g3"
    return None


async def load_business_profile(company_id: str) -> dict[str, bool]:
    """Merge live company.lab_settings.business_profile with defaults."""
    c = await db.companies.find_one(
        {"id": company_id}, {"lab_settings": 1}) or {}
    profile = ((c.get("lab_settings") or {}).get("business_profile") or {})
    return {**BUSINESS_PROFILE_DEFAULTS, **profile}


async def load_owner_comp_feedback(company_id: str) -> dict[tuple[str, str], str]:
    """Return ``{(contact_id, pfc_detailed) → "business" | "owner_comp"}``
    for every learn-scoped verdict this company has recorded. Only reads
    docs where ``learn == True`` — one-off row-only verdicts don't
    auto-apply to sibling rows."""
    idx: dict[tuple[str, str], str] = {}
    async for f in db.lab_feedback.find({
        "company_id":   company_id,
        "scope":        "owner_comp",
        "learn":        True,
    }, {"contact_id": 1, "pfc_detailed": 1, "choice": 1}):
        cid = f.get("contact_id") or ""
        pfc = f.get("pfc_detailed") or ""
        choice = f.get("choice")
        if pfc and choice in ("business", "owner_comp"):
            idx[(cid, pfc)] = choice
    return idx


def route_owner_comp_row(
    *,
    pfc_detailed: str,
    contact_id: str | None,
    business_profile: dict[str, bool],
    feedback_index: dict[tuple[str, str], str],
) -> dict:
    """Given a row's PFC + contact + this company's flags + learned
    feedback, return the routing decision:

        {"target": "Owner's Compensation" | <business_target>,
         "source": "owner_comp_always" | "owner_comp_flag_off" |
                   "business_profile_flag" | "owner_comp_feedback" |
                   "business_feedback" | "needs_review",
         "reason": <human string>,
         "needs_review": bool,
         "question":     str | None,     # for review UI
         "business_target": str | None}  # for the "book as business" branch
    """
    grp = pfc_group(pfc_detailed)
    if grp == "g1":
        return {
            "target":          OWNER_COMP_ACCOUNT_NAME,
            "source":          "owner_comp_always",
            "reason":          f"{pfc_detailed} → always Owner's Comp (personal / TCJA non-deductible)",
            "needs_review":    False,
            "question":        None,
            "business_target": None,
        }
    if grp == "g2":
        flag_key, biz_target = GROUP_2_FLAG_ROUTED[pfc_detailed]
        if business_profile.get(flag_key):
            return {
                "target":          biz_target,
                "source":          "business_profile_flag",
                "reason":          f"business_profile.{flag_key}=True → book as {biz_target}",
                "needs_review":    False,
                "question":        None,
                "business_target": biz_target,
            }
        return {
            "target":          OWNER_COMP_ACCOUNT_NAME,
            "source":          "owner_comp_flag_off",
            "reason":          f"business_profile.{flag_key}=False → Owner's Comp",
            "needs_review":    False,
            "question":        None,
            "business_target": biz_target,
        }
    if grp == "g3":
        question, biz_target = GROUP_3_PER_TXN_QUESTION[pfc_detailed]
        key = (contact_id or "", pfc_detailed)
        learned = feedback_index.get(key)
        if learned == "business":
            return {
                "target":          biz_target,
                "source":          "business_feedback",
                "reason":          f"feedback learned: {pfc_detailed} @ contact → business",
                "needs_review":    False,
                "question":        question,
                "business_target": biz_target,
            }
        if learned == "owner_comp":
            return {
                "target":          OWNER_COMP_ACCOUNT_NAME,
                "source":          "owner_comp_feedback",
                "reason":          f"feedback learned: {pfc_detailed} @ contact → Owner's Comp",
                "needs_review":    False,
                "question":        question,
                "business_target": biz_target,
            }
        # No learned answer — needs client review.
        return {
            "target":          None,
            "source":          "needs_review",
            "reason":          f"{pfc_detailed} — awaiting owner-comp-vs-business verdict",
            "needs_review":    True,
            "question":        question,
            "business_target": biz_target,
        }
    return {"target": None, "source": None, "reason": None,
            "needs_review": False, "question": None, "business_target": None}
