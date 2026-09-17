"""Map every Plaid PFC → real CoA UUID for Test 519 LLC.

Steps:
  1. Load Test 519 LLC's current chart of accounts
  2. For every PFC code in the sheet, resolve target CoA account name
     using pfc_coa_defaults.PFC_COA_MAP + Test-519-specific annotation
     overrides (owner's-comp carve-outs, C-corp medical carve-outs,
     entertainment non-deductible bucket)
  3. Auto-create any missing GAAP accounts that we're happy to create
     (from AUTO_CREATE_TARGETS + explicit sub-accounts)
  4. Write pfc_org_overrides docs for Test 519 LLC (upserts, idempotent)
  5. Emit a preview CSV to /tmp/pfc_coa_test519_preview.csv

Idempotent — safe to re-run.
"""
from __future__ import annotations

import asyncio
import csv
import os
import sys
import uuid
from datetime import datetime, timezone

sys.path.insert(0, '/app/backend')

from dotenv import load_dotenv
load_dotenv('/app/backend/.env')

from motor.motor_asyncio import AsyncIOMotorClient
from lab_pipeline.pfc_coa_defaults import PFC_COA_MAP


COMPANY_ID = 'eae0bd47-0545-4f7c-9175-d838f8d1637b'
COMPANY_NAME = 'Test 519 LLC'


# ---------------------------------------------------------------------------
# Sheet-driven annotation carve-outs specific to Test 519 LLC
# (LLC – Solo Proprietor, generic business — so pass-through owner's comp)
# ---------------------------------------------------------------------------
#
# Each key is a PFC detailed code from the client's sheet whose default
# needs to be overridden for THIS entity. Value:
#   ("Account name", "kind", "why note")
#
# "Owner's Compensation" is a real equity account we found in Test 519's CoA
# (subtype=owner_contribution_drawing). We route non-business consumption there.
# "Entertainment" stays for entertainment codes but with a "non-deductible"
# note (Sec 274(a) post-TCJA). CPA can promote to a dedicated
# "Entertainment (Non-Deductible)" sub-account later if desired.
TEST519_OVERRIDES: dict[str, tuple[str, str, str]] = {
    # Entertainment is 100% non-deductible after TCJA 2017. Keep account
    # but memo it. Sheet-driven: row 7 note.
    "ENTERTAINMENT_CASINOS_AND_GAMBLING": (
        "Entertainment", "expense",
        "Non-deductible after TCJA 2017 (IRC §274(a))"),
    "ENTERTAINMENT_MUSIC_AND_AUDIO": (
        "Entertainment", "expense",
        "Non-deductible after TCJA 2017 — unless business-purpose subscription"),
    "ENTERTAINMENT_SPORTING_EVENTS_AMUSEMENT_PARKS_AND_MUSEUMS": (
        "Entertainment", "expense",
        "Non-deductible after TCJA 2017"),
    "ENTERTAINMENT_TV_AND_MOVIES": (
        "Entertainment", "expense",
        "Non-deductible after TCJA 2017 — unless business-purpose subscription"),
    "ENTERTAINMENT_VIDEO_GAMES": (
        "Entertainment", "expense",
        "Non-deductible after TCJA 2017"),
    "ENTERTAINMENT_OTHER_ENTERTAINMENT": (
        "Entertainment", "expense",
        "Non-deductible after TCJA 2017"),

    # Pet supplies → owner's comp for non-pet businesses. Sheet row 30.
    "GENERAL_MERCHANDISE_PET_SUPPLIES": (
        "Owner's Compensation", "equity",
        "Personal — Test 519 LLC is not an animal-related business"),

    # Tobacco & vape → owner's comp unless the business relates. Sheet row 33.
    "GENERAL_MERCHANDISE_TOBACCO_AND_VAPE": (
        "Owner's Compensation", "equity",
        "Personal — unless the business purpose relates"),

    # Childcare → owner's comp unless a written §129 dependent-care plan
    # exists on file. Sheet row 36.
    "GENERAL_SERVICES_CHILDCARE": (
        "Owner's Compensation", "equity",
        "Personal — no written §129 dependent-care plan on file for Test 519"),

    # Student loan → owner's comp unless a written §127 plan exists on file.
    # Sheet row 65.
    "LOAN_PAYMENTS_STUDENT_LOAN_PAYMENT": (
        "Owner's Compensation", "equity",
        "Personal — no written §127 educational-assistance plan on file"),

    # Dental/eye = fringe benefit only if C-corp with §105 plan. Sheet row 66.
    # Test 519 is an LLC solo prop → route to owner's comp.
    "MEDICAL_DENTAL_CARE": (
        "Owner's Compensation", "equity",
        "LLC pass-through — not deductible without §105 plan / C-corp"),
    "MEDICAL_EYE_CARE": (
        "Owner's Compensation", "equity",
        "LLC pass-through — not deductible without §105 plan / C-corp"),

    # Personal care → owner's comp. Sheet row 74.
    "PERSONAL_CARE_GYMS_AND_FITNESS_CENTERS": (
        "Owner's Compensation", "equity",
        "Personal — no employee wellness plan on file"),
    "PERSONAL_CARE_HAIR_AND_BEAUTY": (
        "Owner's Compensation", "equity",
        "Personal"),
    "PERSONAL_CARE_LAUNDRY_AND_DRY_CLEANING": (
        "Owner's Compensation", "equity",
        "Personal — no uniform program on file"),
    "PERSONAL_CARE_OTHER_PERSONAL_CARE": (
        "Owner's Compensation", "equity",
        "Personal"),
}


# 104 PFC codes from the client's sheet (same order as the file).
SHEET_PFC_CODES: list[str] = [
    "BANK_FEES_ATM_FEES",
    "BANK_FEES_FOREIGN_TRANSACTION_FEES",
    "BANK_FEES_INSUFFICIENT_FUNDS",
    "BANK_FEES_INTEREST_CHARGE",
    "BANK_FEES_OTHER_BANK_FEES",
    "BANK_FEES_OVERDRAFT_FEES",
    "ENTERTAINMENT_CASINOS_AND_GAMBLING",
    "ENTERTAINMENT_MUSIC_AND_AUDIO",
    "ENTERTAINMENT_OTHER_ENTERTAINMENT",
    "ENTERTAINMENT_SPORTING_EVENTS_AMUSEMENT_PARKS_AND_MUSEUMS",
    "ENTERTAINMENT_TV_AND_MOVIES",
    "ENTERTAINMENT_VIDEO_GAMES",
    "FOOD_AND_DRINK_BEER_WINE_AND_LIQUOR",
    "FOOD_AND_DRINK_COFFEE",
    "FOOD_AND_DRINK_FAST_FOOD",
    "FOOD_AND_DRINK_GROCERIES",
    "FOOD_AND_DRINK_OTHER_FOOD_AND_DRINK",
    "FOOD_AND_DRINK_RESTAURANT",
    "FOOD_AND_DRINK_VENDING_MACHINES",
    "GENERAL_MERCHANDISE_BOOKSTORES_AND_NEWSSTANDS",
    "GENERAL_MERCHANDISE_CLOTHING_AND_ACCESSORIES",
    "GENERAL_MERCHANDISE_CONVENIENCE_STORES",
    "GENERAL_MERCHANDISE_DEPARTMENT_STORES",
    "GENERAL_MERCHANDISE_DISCOUNT_STORES",
    "GENERAL_MERCHANDISE_ELECTRONICS",
    "GENERAL_MERCHANDISE_GIFTS_AND_NOVELTIES",
    "GENERAL_MERCHANDISE_OFFICE_SUPPLIES",
    "GENERAL_MERCHANDISE_ONLINE_MARKETPLACES",
    "GENERAL_MERCHANDISE_OTHER_GENERAL_MERCHANDISE",
    "GENERAL_MERCHANDISE_PET_SUPPLIES",
    "GENERAL_MERCHANDISE_SPORTING_GOODS",
    "GENERAL_MERCHANDISE_SUPERSTORES",
    "GENERAL_MERCHANDISE_TOBACCO_AND_VAPE",
    "GENERAL_SERVICES_ACCOUNTING_AND_FINANCIAL_PLANNING",
    "GENERAL_SERVICES_AUTOMOTIVE",
    "GENERAL_SERVICES_CHILDCARE",
    "GENERAL_SERVICES_CONSULTING_AND_LEGAL",
    "GENERAL_SERVICES_EDUCATION",
    "GENERAL_SERVICES_INSURANCE",
    "GENERAL_SERVICES_OTHER_GENERAL_SERVICES",
    "GENERAL_SERVICES_POSTAGE_AND_SHIPPING",
    "GENERAL_SERVICES_STORAGE",
    "GOVERNMENT_AND_NON_PROFIT_DONATIONS",
    "GOVERNMENT_AND_NON_PROFIT_GOVERNMENT_DEPARTMENTS_AND_AGENCIES",
    "GOVERNMENT_AND_NON_PROFIT_OTHER_GOVERNMENT_AND_NON_PROFIT",
    "GOVERNMENT_AND_NON_PROFIT_TAX_PAYMENT",
    "HOME_IMPROVEMENT_FURNITURE",
    "HOME_IMPROVEMENT_HARDWARE",
    "HOME_IMPROVEMENT_OTHER_HOME_IMPROVEMENT",
    "HOME_IMPROVEMENT_REPAIR_AND_MAINTENANCE",
    "HOME_IMPROVEMENT_SECURITY",
    "INCOME_CONTRACTOR",
    "INCOME_DIVIDENDS",
    "INCOME_INTEREST_EARNED",
    "INCOME_OTHER_INCOME",
    "INCOME_RETIREMENT_PENSION",
    "INCOME_TAX_REFUND",
    "INCOME_UNEMPLOYMENT",
    "INCOME_WAGES",
    "LOAN_PAYMENTS_CAR_PAYMENT",
    "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT",
    "LOAN_PAYMENTS_MORTGAGE_PAYMENT",
    "LOAN_PAYMENTS_OTHER_PAYMENT",
    "LOAN_PAYMENTS_PERSONAL_LOAN_PAYMENT",
    "LOAN_PAYMENTS_STUDENT_LOAN_PAYMENT",
    "MEDICAL_DENTAL_CARE",
    "MEDICAL_EYE_CARE",
    "MEDICAL_NURSING_CARE",
    "MEDICAL_OTHER_MEDICAL",
    "MEDICAL_PHARMACIES_AND_SUPPLEMENTS",
    "MEDICAL_PRIMARY_CARE",
    "MEDICAL_VETERINARY_SERVICES",
    "OTHER_OTHER",
    "PERSONAL_CARE_GYMS_AND_FITNESS_CENTERS",
    "PERSONAL_CARE_HAIR_AND_BEAUTY",
    "PERSONAL_CARE_LAUNDRY_AND_DRY_CLEANING",
    "PERSONAL_CARE_OTHER_PERSONAL_CARE",
    "RENT_AND_UTILITIES_GAS_AND_ELECTRICITY",
    "RENT_AND_UTILITIES_INTERNET_AND_CABLE",
    "RENT_AND_UTILITIES_OTHER_UTILITIES",
    "RENT_AND_UTILITIES_RENT",
    "RENT_AND_UTILITIES_SEWAGE_AND_WASTE_MANAGEMENT",
    "RENT_AND_UTILITIES_TELEPHONE",
    "RENT_AND_UTILITIES_WATER",
    "TRANSFER_IN_ACCOUNT_TRANSFER",
    "TRANSFER_IN_CASH_ADVANCES_AND_LOANS",
    "TRANSFER_IN_DEPOSIT",
    "TRANSFER_IN_INVESTMENT_AND_RETIREMENT_FUNDS",
    "TRANSFER_IN_OTHER_TRANSFER_IN",
    "TRANSFER_IN_SAVINGS",
    "TRANSFER_IN_TRANSFER_IN_FROM_APPS",
    "TRANSFER_IN_WIRE",
    "TRANSFER_OUT_ACCOUNT_TRANSFER",
    "TRANSFER_OUT_INVESTMENT_AND_RETIREMENT_FUNDS",
    "TRANSFER_OUT_OTHER_TRANSFER_OUT",
    "TRANSFER_OUT_SAVINGS",
    "TRANSFER_OUT_TRANSFER_OUT_FROM_APPS",
    "TRANSFER_OUT_WITHDRAWAL",
    "TRANSPORTATION_BIKES_AND_SCOOTERS",
    "TRANSPORTATION_GAS",
    "TRANSPORTATION_OTHER_TRANSPORTATION",
    "TRANSPORTATION_PARKING",
    "TRANSPORTATION_PUBLIC_TRANSIT",
    "TRANSPORTATION_TAXIS_AND_RIDE_SHARES",
    "TRANSPORTATION_TOLLS",
    "TRAVEL_FLIGHTS",
    "TRAVEL_LODGING",
    "TRAVEL_OTHER_TRAVEL",
    "TRAVEL_RENTAL_CARS",
]


# Extra defaults for PFCs not covered by the shared PFC_COA_MAP but present
# in the client's sheet:
EXTRA_DEFAULTS: dict[str, tuple[str, str]] = {
    # TRANSFER_IN_WIRE not in shared map — treat like OTHER_TRANSFER_IN.
    "TRANSFER_IN_WIRE": ("Uncategorized Income", "revenue"),
}


# Account name → default (type, subtype) to use when we have to create it.
CREATE_HINTS: dict[str, tuple[str, str]] = {
    "Interest Expense":            ("expense",   "operating_expense"),
    "Employee Health Insurance":   ("expense",   "operating_expense"),
    "Veterinary Services":         ("expense",   "operating_expense"),
    "Childcare Expense":           ("expense",   "operating_expense"),
    "Security Services":           ("expense",   "operating_expense"),
    "Computer & Software Expense": ("expense",   "operating_expense"),
    "Storage Rent":                ("expense",   "operating_expense"),
    "Dividend Income":             ("revenue",   "other_revenue"),
    "Tax Refunds":                 ("revenue",   "other_revenue"),
    "Notes Payable Draws":         ("liability", "long_term_liability"),
    "Owner's Compensation":        ("equity",    "owner_contribution_drawing"),
    "Entertainment":               ("expense",   "operating_expense"),
    # Everything else already exists.
}


async def main() -> None:
    cli = AsyncIOMotorClient(os.environ['MONGO_URL'])
    db = cli[os.environ['DB_NAME']]

    # ---- Load live CoA -----------------------------------------------------
    coa_by_name: dict[str, dict] = {}
    async for a in db.accounts.find(
        {"company_id": COMPANY_ID, "is_active": {"$ne": False}},
        {"_id": 0, "id": 1, "name": 1, "type": 1, "subtype": 1},
    ):
        key = (a.get("name") or "").strip().lower()
        # First occurrence wins (system-seeded rows come earlier).
        coa_by_name.setdefault(key, a)
    print(f"Loaded {len(coa_by_name)} live CoA accounts for {COMPANY_NAME}.")

    async def ensure_account(name: str) -> dict:
        """Return the live account row for `name`, creating it if missing."""
        key = name.strip().lower()
        if key in coa_by_name:
            return coa_by_name[key]
        hint = CREATE_HINTS.get(name)
        if not hint:
            raise RuntimeError(f"No CoA hint for auto-creating: {name}")
        typ, sub = hint
        new_doc = {
            "id": str(uuid.uuid4()),
            "company_id": COMPANY_ID,
            "name": name,
            "type": typ,
            "subtype": sub,
            "is_active": True,
            "created_by": "pfc_coa_test519_seed",
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        await db.accounts.insert_one(new_doc)
        coa_by_name[key] = {"id": new_doc["id"], "name": name,
                             "type": typ, "subtype": sub}
        print(f"  + created account '{name}' ({typ}/{sub}) -> {new_doc['id']}")
        return coa_by_name[key]

    # ---- Resolve every PFC in the sheet ------------------------------------
    now = datetime.now(timezone.utc).isoformat()
    rows_for_csv: list[dict] = []
    upserts = 0

    for pfc in SHEET_PFC_CODES:
        # 1) start from the shared default (or EXTRA_DEFAULTS).
        default = PFC_COA_MAP.get(pfc)
        if default:
            coa_name = default["coa"]
            kind = default["kind"]
            base_note = default.get("note", "")
        elif pfc in EXTRA_DEFAULTS:
            coa_name, kind = EXTRA_DEFAULTS[pfc]
            base_note = "sheet-only PFC — default fallback"
        else:
            coa_name, kind = "Uncategorized Expense", "expense"
            base_note = "unknown PFC"

        # 2) apply Test-519 sheet-driven overrides.
        override = TEST519_OVERRIDES.get(pfc)
        if override:
            coa_name, kind, note = override
            source = "test519_override"
        else:
            note = base_note
            source = "pfc_default"

        # 3) resolve to a real CoA UUID (create if we're allowed to).
        acct = await ensure_account(coa_name)

        # 4) upsert pfc_org_overrides.
        await db.pfc_org_overrides.update_one(
            {"company_id": COMPANY_ID, "pfc_detailed": pfc},
            {"$set": {
                "company_id": COMPANY_ID,
                "pfc_detailed": pfc,
                "category_account_id": acct["id"],
                "coa_name": acct["name"],
                "coa_type": acct.get("type"),
                "coa_subtype": acct.get("subtype"),
                "kind": kind,
                "note": note,
                "source": source,
                "updated_at": now,
                "updated_by": "pfc_coa_test519_seed",
            }},
            upsert=True,
        )
        upserts += 1
        rows_for_csv.append({
            "pfc_detailed": pfc,
            "primary": pfc.split("_", 1)[0] if "_" in pfc else pfc,
            "coa_name": acct["name"],
            "coa_type": acct.get("type"),
            "coa_subtype": acct.get("subtype"),
            "category_account_id": acct["id"],
            "kind": kind,
            "source": source,
            "note": note,
        })

    # ---- Preview CSV -------------------------------------------------------
    out_path = "/tmp/pfc_coa_test519_preview.csv"
    with open(out_path, "w", newline="") as fp:
        writer = csv.DictWriter(fp, fieldnames=[
            "pfc_detailed", "primary", "coa_name", "coa_type",
            "coa_subtype", "category_account_id", "kind", "source", "note",
        ])
        writer.writeheader()
        writer.writerows(rows_for_csv)

    print(f"\nUpserted {upserts} pfc_org_overrides rows for {COMPANY_NAME}.")
    print(f"Preview CSV: {out_path}")
    # Quick summary counts by target CoA
    from collections import Counter
    ct = Counter(r["coa_name"] for r in rows_for_csv)
    print("\nRows by target CoA:")
    for name, n in sorted(ct.items(), key=lambda x: (-x[1], x[0])):
        print(f"  {n:3d}  {name}")


if __name__ == "__main__":
    asyncio.run(main())
