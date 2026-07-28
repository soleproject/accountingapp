"""Fixed asset lifecycle service.

Feb 2026 — replaces the raw CRUD Assets endpoint that stored `{name, cost,
purchased_date, life_years}` in the `assets` collection but never touched
the ledger. Adding a fixed asset now:

  1. Creates a per-asset sub-account under `1500 Fixed Assets` (QBO-style).
  2. Creates a per-asset accumulated-depreciation contra sub-account.
  3. Posts an acquisition JE:  DR fixed-asset  CR offset_account_id.
  4. Generates monthly straight-line depreciation JEs for the full useful
     life. Balance sheet respects `as_of` dates, so future-dated JEs simply
     don't show up until their month arrives — no cron needed.

Delete is symmetric:
  * Wipes every JE tagged `source in {"asset_acquisition","depreciation"}`
    and `asset_id == <this>`.
  * Deletes the sub-accounts (asset + accum depr).
  * Deletes the `assets` row.

Design decisions:
  * `salvage_value` defaults to 0 (straight-line: (cost - salvage) / months).
  * Depreciation months are ALL posted upfront — no scheduled task needed,
    balance sheet already filters by `as_of`.
  * `offset_account_id` is required (payload validated at API layer). We
    hint the caller to Cash / Loan / Owner Contribution / OBE options
    but ultimately trust any active CoA account they pass.
  * Idempotence: creating the same asset twice produces two distinct
    sub-account chains — this is intentional (users may buy TWO identical
    trucks). Dedup is not our job.
  * Closed-period check: the acquisition JE respects closed periods
    (fails fast). Depreciation JEs whose target month is closed are
    SKIPPED silently — the user closed that period on purpose.
"""
from __future__ import annotations
import uuid
from calendar import monthrange
from datetime import date, datetime, timedelta, timezone

from db import db, now_iso
from plaid_connect import _ensure_account, ensure_opening_balance_equity
from deps import is_period_closed


# ---- CoA scaffolding ----------------------------------------------------

FIXED_ASSETS_PARENT_CODE = "1500"
FIXED_ASSETS_PARENT_NAME = "Fixed Assets"
DEPRECIATION_EXPENSE_CODE = "5900"
DEPRECIATION_EXPENSE_NAME = "Depreciation Expense"


async def _ensure_fixed_assets_parent(cid: str) -> dict:
    """Top-level `1500 Fixed Assets` account. All per-asset sub-accounts
    and their accumulated-depreciation contras nest under it."""
    a = await db.accounts.find_one({
        "company_id": cid, "code": FIXED_ASSETS_PARENT_CODE,
    })
    if a:
        return a
    doc = {
        "id": str(uuid.uuid4()), "company_id": cid,
        "code": FIXED_ASSETS_PARENT_CODE, "name": FIXED_ASSETS_PARENT_NAME,
        "type": "asset", "subtype": "fixed_asset",
        "active": True,
        "created_at": now_iso(), "updated_at": now_iso(),
    }
    await db.accounts.insert_one(doc)
    return doc


async def _ensure_depreciation_expense(cid: str) -> dict:
    """Single shared `5900 Depreciation Expense` P&L account (standard —
    per-asset depreciation expense lines would clutter the P&L)."""
    return await _ensure_account(
        cid, DEPRECIATION_EXPENSE_CODE, DEPRECIATION_EXPENSE_NAME,
        "expense", "operating_expense",
    )


async def _next_asset_code(cid: str, parent_id: str) -> tuple[str, str]:
    """Return `(asset_code, contra_code)` — the next unused pair in the
    1510+ block for this company. Numbering scheme:
       * Nth asset: `15{N}0` for the fixed-asset row,
                    `15{N}5` for its accumulated-depreciation contra.
       * Wraps to 3-digit suffixes past N=9 (`15100`, `15105`, ...).
    """
    existing_codes = set(await db.accounts.distinct(
        "code", {"company_id": cid, "parent_account_id": parent_id},
    ))
    n = 1
    while True:
        asset_code = f"15{n}0" if n < 10 else f"15{n:02d}0"
        contra_code = f"15{n}5" if n < 10 else f"15{n:02d}5"
        if asset_code not in existing_codes and contra_code not in existing_codes:
            return asset_code, contra_code
        n += 1
        if n > 999:  # defensive
            raise RuntimeError("Ran out of asset code slots")


async def _create_asset_subaccounts(
    cid: str, name: str, *, include_contra: bool = True,
) -> tuple[dict, dict | None]:
    """Create the per-asset pair: fixed-asset ledger row + optional
    accumulated-depreciation contra row. Land assets (`include_contra=
    False`) get only the ledger row since they never depreciate."""
    parent = await _ensure_fixed_assets_parent(cid)
    asset_code, contra_code = await _next_asset_code(cid, parent["id"])
    now = now_iso()
    asset_doc = {
        "id": str(uuid.uuid4()), "company_id": cid,
        "code": asset_code, "name": name,
        "type": "asset", "subtype": "fixed_asset",
        "parent_account_id": parent["id"],
        "active": True, "created_at": now, "updated_at": now,
    }
    if not include_contra:
        await db.accounts.insert_one(asset_doc)
        return asset_doc, None
    contra_doc = {
        "id": str(uuid.uuid4()), "company_id": cid,
        "code": contra_code, "name": f"{name} — Accumulated Depreciation",
        "type": "asset", "subtype": "accumulated_depreciation",
        "parent_account_id": parent["id"],
        "active": True, "created_at": now, "updated_at": now,
    }
    await db.accounts.insert_many([asset_doc, contra_doc])
    return asset_doc, contra_doc


# ---- JE helpers ----------------------------------------------------------

async def _post_je(
    cid: str, *, date_iso: str, memo: str, source: str, asset_id: str,
    lines: list[dict], auto_generated: bool = True,
) -> str:
    je_id = str(uuid.uuid4())
    await db.journal_entries.insert_one({
        "id": je_id, "company_id": cid,
        "date": date_iso, "memo": memo, "lines": lines,
        "source": source, "asset_id": asset_id,
        "auto_generated": auto_generated,
        "created_at": now_iso(), "updated_at": now_iso(),
    })
    return je_id


def _straight_line_monthly(cost: float, salvage: float, life_years: float) -> float:
    """(cost - salvage) / (life_years * 12), rounded to 2 decimals.
    The last month is truncated later to eliminate rounding drift."""
    months = max(1, int(round(life_years * 12)))
    return round((cost - salvage) / months, 2)


def _iter_month_ends(start: date, months: int):
    """Yield the last calendar day of each month starting from the month
    containing `start`, for `months` iterations."""
    y, m = start.year, start.month
    for _ in range(months):
        d = date(y, m, monthrange(y, m)[1])
        yield d
        m += 1
        if m == 13:
            y, m = y + 1, 1


# ---- Public API ----------------------------------------------------------

async def create_fixed_asset(cid: str, payload: dict) -> dict:
    """Create an `assets` row + CoA scaffolding + acquisition JE + full
    depreciation schedule. Returns the diagnostic payload the API layer
    forwards to the frontend.

    Required payload keys:
        name              : str, human label
        purchase_date     : ISO date str
        cost              : positive number
        offset_account_id : CoA row credited on acquisition
    Optional:
        asset_type        : key from ASSET_TYPES (drives depreciable+years)
        useful_life_years : positive number — required UNLESS asset_type
                            has a preset value or `depreciable=False`
        salvage_value     : number, defaults to 0
    """
    name = (payload.get("name") or "").strip()
    purchase_date = payload.get("purchase_date") or ""
    cost = float(payload.get("cost") or 0)
    offset_id = payload.get("offset_account_id")
    salvage = float(payload.get("salvage_value") or 0)
    asset_type_key = payload.get("asset_type") or "other"
    asset_type = _lookup_asset_type(asset_type_key)
    depreciable = bool(asset_type["depreciable"]) if asset_type else True

    # Determine useful life: explicit payload > asset_type preset > error
    payload_years = payload.get("useful_life_years")
    if payload_years is not None and str(payload_years) != "":
        life_years = float(payload_years)
    elif asset_type and asset_type["years"] is not None:
        life_years = float(asset_type["years"])
    elif not depreciable:
        life_years = 0.0
    else:
        raise ValueError("useful_life_years required for depreciable asset types")

    if not name or not purchase_date or cost <= 0 or not offset_id:
        raise ValueError(
            "name, purchase_date, cost, offset_account_id are required "
            "and cost must be positive"
        )
    if depreciable and life_years <= 0:
        raise ValueError("useful_life_years must be positive for depreciable assets")
    try:
        purchase_d = date.fromisoformat(purchase_date[:10])
    except ValueError:
        raise ValueError(f"purchase_date must be ISO YYYY-MM-DD, got {purchase_date!r}")

    if await is_period_closed(cid, purchase_date[:10]):
        raise ValueError(f"purchase_date {purchase_date[:10]} falls in a closed period")

    offset = await db.accounts.find_one({"id": offset_id, "company_id": cid})
    if not offset:
        raise ValueError(f"offset_account_id {offset_id} not found in this company")

    # 1) CoA scaffolding. Land skips the accumulated-depreciation contra
    # since it never depreciates.
    asset_acct, contra_acct = await _create_asset_subaccounts(
        cid, name, include_contra=depreciable,
    )
    dep_expense = await _ensure_depreciation_expense(cid) if depreciable else None

    # 2) `assets` row (with links to the CoA rows we just created).
    asset_id = str(uuid.uuid4())
    now = now_iso()
    if depreciable:
        monthly_dep = _straight_line_monthly(cost, salvage, life_years)
        months = max(1, int(round(life_years * 12)))
    else:
        monthly_dep = 0.0
        months = 0
    asset_row = {
        "id": asset_id, "company_id": cid,
        "name": name, "purchase_date": purchase_date[:10],
        "cost": cost, "salvage_value": salvage,
        "useful_life_years": life_years,
        "asset_type": asset_type_key,
        "depreciable": depreciable,
        "offset_account_id": offset_id,
        "ledger_account_id": asset_acct["id"],
        "ledger_account_code": asset_acct["code"],
        "accumulated_depreciation_account_id": contra_acct["id"] if contra_acct else None,
        "accumulated_depreciation_account_code": contra_acct["code"] if contra_acct else None,
        "depreciation_expense_account_id": dep_expense["id"] if dep_expense else None,
        "monthly_depreciation": monthly_dep,
        "depreciation_months": months,
        "created_at": now, "updated_at": now,
    }
    await db.assets.insert_one(asset_row)

    # 3) Acquisition JE.
    acq_lines = [
        {"account_id": asset_acct["id"], "account_code": asset_acct["code"],
         "account_name": asset_acct["name"],
         "debit": round(cost, 2), "credit": 0.0,
         "description": f"Acquisition of {name}"},
        {"account_id": offset["id"], "account_code": offset["code"],
         "account_name": offset["name"],
         "debit": 0.0, "credit": round(cost, 2),
         "description": f"Paid via {offset['name']}"},
    ]
    acq_je_id = await _post_je(
        cid, date_iso=purchase_date[:10],
        memo=f"Fixed asset acquisition — {name}",
        source="asset_acquisition", asset_id=asset_id, lines=acq_lines,
    )

    # 4) Depreciation schedule (skipped for non-depreciable assets like land).
    dep_je_ids: list[str] = []
    if depreciable and contra_acct and dep_expense:
        running_book = round(cost - salvage, 2)
        for i, me in enumerate(_iter_month_ends(purchase_d, months)):
            amt = running_book if i == months - 1 else monthly_dep
            running_book = round(running_book - amt, 2)
            me_iso = me.isoformat()
            if await is_period_closed(cid, me_iso):
                continue
            dep_lines = [
                {"account_id": dep_expense["id"], "account_code": dep_expense["code"],
                 "account_name": dep_expense["name"],
                 "debit": round(amt, 2), "credit": 0.0,
                 "description": f"Depreciation — {name} (month {i + 1}/{months})"},
                {"account_id": contra_acct["id"], "account_code": contra_acct["code"],
                 "account_name": contra_acct["name"],
                 "debit": 0.0, "credit": round(amt, 2),
                 "description": f"Accumulated depreciation — {name}"},
            ]
            dep_id = await _post_je(
                cid, date_iso=me_iso,
                memo=f"Depreciation — {name} ({me_iso})",
                source="depreciation", asset_id=asset_id, lines=dep_lines,
            )
            dep_je_ids.append(dep_id)

    await db.assets.update_one(
        {"id": asset_id},
        {"$set": {
            "acquisition_je_id": acq_je_id,
            "depreciation_je_ids": dep_je_ids,
            "updated_at": now_iso(),
        }},
    )

    return {
        "id": asset_id,
        "ledger_account": {"id": asset_acct["id"], "code": asset_acct["code"]},
        "accumulated_depreciation_account": (
            {"id": contra_acct["id"], "code": contra_acct["code"]}
            if contra_acct else None
        ),
        "acquisition_je_id": acq_je_id,
        "monthly_depreciation": monthly_dep,
        "depreciation_months": months,
        "depreciation_jes_posted": len(dep_je_ids),
        "depreciable": depreciable,
    }


async def update_fixed_asset(cid: str, asset_id: str, payload: dict) -> dict:
    """Edit an existing asset.

    Non-financial edits (`name`, `notes`, `tag_ids`, `metadata`) just
    update the row + rename the linked sub-accounts. Financial edits
    (`cost`, `salvage_value`, `useful_life_years`, `purchase_date`,
    `offset_account_id`, `asset_type`) require re-issuing the acquisition
    JE and the whole depreciation schedule — so we cascade-delete
    everything and re-create with a fresh `create_fixed_asset` call
    under the hood. The row's `id` stays stable across the swap.
    """
    row = await db.assets.find_one({"id": asset_id, "company_id": cid})
    if not row:
        return {"ok": False, "reason": "not_found"}

    financial_fields = {
        "cost", "salvage_value", "useful_life_years", "purchase_date",
        "offset_account_id", "asset_type",
    }
    is_financial_edit = any(
        k in payload and payload[k] != row.get(k) for k in financial_fields
    )

    if not is_financial_edit:
        # Cheap path — rename in place.
        editable = {k: payload[k] for k in ("name", "notes", "tag_ids", "metadata")
                    if k in payload}
        if not editable:
            return {"ok": True, "action": "no_op"}
        editable["updated_at"] = now_iso()
        await db.assets.update_one({"id": asset_id}, {"$set": editable})
        if "name" in editable:
            # Rename the two sub-accounts to keep the CoA readable.
            new_name = editable["name"]
            if row.get("ledger_account_id"):
                await db.accounts.update_one(
                    {"id": row["ledger_account_id"]},
                    {"$set": {"name": new_name, "updated_at": now_iso()}},
                )
            if row.get("accumulated_depreciation_account_id"):
                await db.accounts.update_one(
                    {"id": row["accumulated_depreciation_account_id"]},
                    {"$set": {"name": f"{new_name} — Accumulated Depreciation",
                              "updated_at": now_iso()}},
                )
        return {"ok": True, "action": "renamed"}

    # Financial edit — teardown + recreate. Preserve the row id so any
    # external references remain stable across the swap.
    merged = {**row, **payload}
    # `create_fixed_asset` treats `offset_account_id` as required; leave
    # existing value when caller didn't override.
    merged.setdefault("offset_account_id", row.get("offset_account_id"))
    await delete_fixed_asset(cid, asset_id)
    new_result = await create_fixed_asset(cid, {
        "name": merged.get("name"),
        "purchase_date": merged.get("purchase_date"),
        "cost": merged.get("cost"),
        "salvage_value": merged.get("salvage_value") or 0,
        "useful_life_years": merged.get("useful_life_years"),
        "asset_type": merged.get("asset_type"),
        "offset_account_id": merged.get("offset_account_id"),
    })
    # Rewrite the fresh asset's id back to the original so external
    # references (audit logs, tag joins, etc.) keep resolving.
    await db.assets.update_one(
        {"id": new_result["id"]}, {"$set": {"id": asset_id}},
    )
    await db.journal_entries.update_many(
        {"asset_id": new_result["id"]}, {"$set": {"asset_id": asset_id}},
    )
    new_result["id"] = asset_id
    return {"ok": True, "action": "regenerated", **new_result}


async def delete_fixed_asset(cid: str, asset_id: str) -> dict:
    """Cascade delete an asset: wipe every JE it produced, remove its
    two sub-accounts, then remove the `assets` row. Idempotent-ish —
    a repeat call on the same id returns `not_found`."""
    row = await db.assets.find_one({"id": asset_id, "company_id": cid})
    if not row:
        return {"ok": False, "reason": "not_found"}

    # Delete all JEs we posted for this asset (acquisition + depreciation).
    r = await db.journal_entries.delete_many({
        "company_id": cid, "asset_id": asset_id,
        "source": {"$in": ["asset_acquisition", "depreciation"]},
    })
    je_deleted = r.deleted_count

    # Delete the two CoA sub-accounts (never touch the shared
    # `1500 Fixed Assets` parent or `5900 Depreciation Expense`).
    coa_ids = [
        row.get("ledger_account_id"),
        row.get("accumulated_depreciation_account_id"),
    ]
    coa_ids = [x for x in coa_ids if x]
    if coa_ids:
        await db.accounts.delete_many({
            "company_id": cid, "id": {"$in": coa_ids},
        })

    await db.assets.delete_one({"id": asset_id, "company_id": cid})
    return {
        "ok": True, "asset_id": asset_id,
        "journal_entries_deleted": je_deleted,
        "accounts_deleted": len(coa_ids),
    }


__all__ = [
    "create_fixed_asset",
    "update_fixed_asset",
    "delete_fixed_asset",
    "ASSET_TYPES",
    "FIXED_ASSETS_PARENT_CODE",
]


# ---- Asset-type catalog --------------------------------------------------
# Maps a friendly picker value to the standard IRS/GAAP useful life so the
# frontend can auto-fill the years field. `depreciable=False` means land
# (or land-like intangibles) — the create path posts the acquisition JE
# but skips the schedule and skips creating the contra-asset row.
ASSET_TYPES = [
    {"key": "residential_real_estate",  "label": "Residential Real Estate",
     "years": 27.5, "depreciable": True},
    {"key": "commercial_real_estate",   "label": "Commercial Real Estate",
     "years": 39,   "depreciable": True},
    {"key": "land_improvements",        "label": "Land Improvements",
     "years": 15,   "depreciable": True},
    {"key": "building_improvements",    "label": "Building Improvements",
     "years": 15,   "depreciable": True},
    {"key": "leasehold_improvements",   "label": "Leasehold Improvements",
     "years": 15,   "depreciable": True},
    {"key": "vehicle",                  "label": "Vehicle / Light Truck",
     "years": 5,    "depreciable": True},
    {"key": "machinery_equipment",      "label": "Machinery / Equipment",
     "years": 7,    "depreciable": True},
    {"key": "office_furniture",         "label": "Office Furniture / Fixtures",
     "years": 7,    "depreciable": True},
    {"key": "computer_equipment",       "label": "Computer Equipment",
     "years": 5,    "depreciable": True},
    {"key": "land",                     "label": "Land (non-depreciable)",
     "years": 0,    "depreciable": False},
    {"key": "other",                    "label": "Other (custom life)",
     "years": None, "depreciable": True},
]


def _lookup_asset_type(key: str | None) -> dict | None:
    if not key:
        return None
    for row in ASSET_TYPES:
        if row["key"] == key:
            return row
    return None
