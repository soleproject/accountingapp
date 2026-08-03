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
import re
from calendar import monthrange
from datetime import date, datetime, timedelta, timezone

from db import db, now_iso, insert_je
from plaid_connect import _ensure_account, ensure_opening_balance_equity
from deps import is_period_closed


# ---- CoA scaffolding ----------------------------------------------------

FIXED_ASSETS_PARENT_CODE = "1500"
FIXED_ASSETS_PARENT_NAME = "Fixed Assets"
DEPRECIATION_EXPENSE_CODE = "5900"
DEPRECIATION_EXPENSE_NAME = "Depreciation Expense"
# Two-phase asset creation: when the user creates the asset shell before
# specifying funding, the acquisition JE credits this system-managed
# clearing account. Later `fund_fixed_asset()` calls sweep the balance
# out of Suspense into the real funding accounts (cash, mortgage, owner).
FIXED_ASSET_SUSPENSE_CODE = "2990"
FIXED_ASSET_SUSPENSE_NAME = "Fixed Asset Suspense"


async def _ensure_fixed_asset_suspense(cid: str) -> dict:
    """System-managed clearing liability. Auto-created on first use."""
    a = await db.accounts.find_one({
        "company_id": cid, "code": FIXED_ASSET_SUSPENSE_CODE,
    })
    if a:
        return a
    # Fall back to name-match in case a company already has a suspense
    # under a different code from an older seed.
    a = await db.accounts.find_one({
        "company_id": cid, "type": "liability",
        "name": FIXED_ASSET_SUSPENSE_NAME,
    })
    if a:
        return a
    now = now_iso()
    doc = {
        "id": str(uuid.uuid4()), "company_id": cid,
        "code": FIXED_ASSET_SUSPENSE_CODE,
        "name": FIXED_ASSET_SUSPENSE_NAME,
        "type": "liability", "subtype": "clearing",
        "active": True, "balance": 0.0,
        "parent_account_id": None, "system_managed": True,
        "created_at": now, "updated_at": now,
        "source": "fixed_asset_suspense_auto",
    }
    await db.accounts.insert_one(doc)
    return doc


async def _ensure_fixed_assets_parent(cid: str) -> dict:
    """Locate (or create) the "Fixed Assets" grouping parent under which
    all per-asset sub-accounts nest.

    Historical bug: this used to fetch by code=1500, but 1500 is used by
    many seed CoAs for "Prepaid Expenses". That silently nested asset
    sub-accounts under Prepaid Expenses, distorting the balance sheet.

    New lookup order:
      1. Existing account named "Fixed Assets" (case-insensitive) — the
         canonical parent whatever code it lives at.
      2. Existing top-level asset with subtype "fixed_asset" and NO
         parent_account_id — reuse it if named appropriately.
      3. Create a fresh "Fixed Assets" parent at the FIRST FREE code in
         the 1500-1899 range (skipping any taken codes like 1500-Prepaid).

    Also performs an idempotent one-time migration: any fixed_asset
    sub-account currently parented under a non-fixed-asset row (e.g.
    Prepaid Expenses because of the historical bug) is re-parented under
    the correct Fixed Assets group.
    """
    parent = None
    # 1) Match by name.
    async for a in db.accounts.find(
        {"company_id": cid, "type": "asset"}
    ):
        if (a.get("name") or "").strip().lower() == FIXED_ASSETS_PARENT_NAME.lower():
            parent = a
            break
    if not parent:
        # 2) Existing top-level fixed_asset group.
        async for a in db.accounts.find(
            {"company_id": cid, "type": "asset", "subtype": "fixed_asset",
             "parent_account_id": None}
        ):
            nm = (a.get("name") or "").strip().lower()
            if "fixed asset" in nm or nm == "fixed_assets":
                parent = a
                break
    if not parent:
        # 3) Create fresh — pick first free code in 1500-1899.
        used = set(await db.accounts.distinct("code", {"company_id": cid}))
        code = None
        for candidate in [FIXED_ASSETS_PARENT_CODE] + [str(n) for n in range(1500, 1900, 10)]:
            if candidate not in used:
                code = candidate
                break
        if code is None:
            code = FIXED_ASSETS_PARENT_CODE
        doc = {
            "id": str(uuid.uuid4()), "company_id": cid,
            "code": code, "name": FIXED_ASSETS_PARENT_NAME,
            "type": "asset", "subtype": "fixed_asset",
            "parent_account_id": None,
            "active": True,
            "created_at": now_iso(), "updated_at": now_iso(),
        }
        await db.accounts.insert_one(doc)
        parent = doc

    # One-time repair: any fixed_asset / accumulated_depreciation
    # sub-account currently parented under a non-fixed-asset row (the
    # old code=1500 lookup bug) is re-homed under the real parent.
    misplaced_ids: list[str] = []
    async for child in db.accounts.find({
        "company_id": cid,
        "subtype": {"$in": ["fixed_asset", "accumulated_depreciation"]},
        "parent_account_id": {"$ne": None},
    }):
        parent_id = child.get("parent_account_id")
        if parent_id == parent["id"]:
            continue
        p = await db.accounts.find_one({"id": parent_id, "company_id": cid})
        if not p:
            continue
        # A "correct" parent is either the canonical Fixed Assets group
        # or another fixed_asset row (grand-nesting is fine). Anything
        # else (Prepaid Expenses, Cash, whatever) → re-home.
        p_name = (p.get("name") or "").strip().lower()
        p_sub = (p.get("subtype") or "").lower()
        if p_sub == "fixed_asset" or "fixed asset" in p_name:
            continue
        misplaced_ids.append(child["id"])
    if misplaced_ids:
        await db.accounts.update_many(
            {"id": {"$in": misplaced_ids}, "company_id": cid},
            {"$set": {"parent_account_id": parent["id"],
                      "updated_at": now_iso()}},
        )
    return parent


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

    We check ALL codes in the company (not just under the given parent)
    so the parent's own code isn't reused by a child. This came up when
    the seeded CoA had 1500=Prepaid Expenses, forcing the auto-created
    "Fixed Assets" parent to land on 1510 — then the first child would
    have collided at 1510 too without this global check.
    """
    existing_codes = set(await db.accounts.distinct(
        "code", {"company_id": cid},
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
    await insert_je({
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
        offsets           : list of `{account_id, amount}` — must sum
                            EXACTLY to cost. Represents how the asset was
                            paid for; supports mixed funding (e.g. cash
                            down + mortgage + trade-in equity). Legacy
                            single `offset_account_id` still accepted —
                            we normalize it to a one-item list internally.
    Optional:
        asset_type        : key from ASSET_TYPES (drives depreciable+years)
        useful_life_years : positive number — required UNLESS asset_type
                            has a preset value or `depreciable=False`
        salvage_value     : number, defaults to 0
    """
    name = (payload.get("name") or "").strip()
    purchase_date = payload.get("purchase_date") or ""
    cost = float(payload.get("cost") or 0)
    salvage = float(payload.get("salvage_value") or 0)
    asset_type_key = payload.get("asset_type") or "other"
    asset_type = _lookup_asset_type(asset_type_key)
    depreciable = bool(asset_type["depreciable"]) if asset_type else True

    # Normalize offsets — accept legacy single field OR the new list.
    # Also accept `funding_sources` as an alias since the LLM occasionally
    # emits that key name instead of `offsets`.
    offsets_raw = payload.get("offsets") or payload.get("funding_sources")
    if not offsets_raw and payload.get("offset_account_id"):
        offsets_raw = [{"account_id": payload["offset_account_id"], "amount": cost}]
    # Two-phase creation: when offsets are absent/empty, book the full
    # cost to the Fixed Asset Suspense clearing account. The user (or AI)
    # later calls `fund_fixed_asset()` to move it into real funding
    # accounts. This lets a CPA see the asset on Fixed Assets + CoA
    # immediately and worry about funding separately.
    pending_funding = not offsets_raw
    if pending_funding:
        if cost <= 0:
            raise ValueError("cost must be positive")
        suspense = await _ensure_fixed_asset_suspense(cid)
        offsets_raw = [{"account_id": suspense["id"], "amount": cost}]
    if not isinstance(offsets_raw, list):
        raise ValueError("offsets is required — provide a list of "
                         "{account_id, amount} entries totaling `cost`")
    # LLM proposals sometimes pass a 4-digit code ("2500") or a name
    # ("Loans Payable") for account_id. Resolve those to real UUIDs here
    # so the strict find_one lookup below doesn't fail.
    import re as _re
    uuid_re = _re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", _re.I)
    offsets: list[dict] = []
    for row in offsets_raw:
        aid = row.get("account_id")
        amt = float(row.get("amount") or 0)
        if not aid or amt <= 0:
            raise ValueError(
                "each offset must have `account_id` and positive `amount`"
            )
        if not uuid_re.match(str(aid)):
            key = str(aid).strip()
            resolved = await db.accounts.find_one({"company_id": cid, "code": key})
            if not resolved:
                key_norm = _re.sub(r"\s+", " ", key).lower()
                async for a in db.accounts.find({"company_id": cid}):
                    if _re.sub(r"\s+", " ", (a.get("name") or "").strip()).lower() == key_norm:
                        resolved = a
                        break
            if resolved:
                aid = resolved["id"]
        offsets.append({"account_id": aid, "amount": round(amt, 2)})
    offset_sum = round(sum(o["amount"] for o in offsets), 2)
    if abs(offset_sum - round(cost, 2)) > 0.005:
        raise ValueError(
            f"offset amounts total ${offset_sum:.2f} but cost is ${cost:.2f} — must match exactly"
        )

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

    if not name or not purchase_date or cost <= 0:
        raise ValueError(
            "name, purchase_date, cost are required and cost must be positive"
        )
    if depreciable and life_years <= 0:
        raise ValueError("useful_life_years must be positive for depreciable assets")
    try:
        purchase_d = date.fromisoformat(purchase_date[:10])
    except ValueError:
        raise ValueError(f"purchase_date must be ISO YYYY-MM-DD, got {purchase_date!r}")

    if await is_period_closed(cid, purchase_date[:10]):
        raise ValueError(f"purchase_date {purchase_date[:10]} falls in a closed period")

    # Resolve every offset account up front so we can build the JE lines
    # atomically without doing N mongo round-trips inside the loop.
    offset_accts: list[dict] = []
    for o in offsets:
        acct = await db.accounts.find_one({"id": o["account_id"], "company_id": cid})
        if not acct:
            raise ValueError(f"offset account {o['account_id']} not found")
        offset_accts.append({"acct": acct, "amount": o["amount"]})

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
        "offsets": offsets,
        # Track two-phase funding state. `funded_amount` climbs from 0 to
        # cost as `fund_fixed_asset` calls sweep Suspense into real
        # accounts. `pending_funding` flips to False when fully swept.
        "pending_funding": pending_funding,
        "funded_amount": 0.0 if pending_funding else round(cost, 2),
        # Keep the legacy singular field populated with the LARGEST
        # offset so old readers (Balance Sheet, reports) don't break.
        "offset_account_id": max(offsets, key=lambda o: o["amount"])["account_id"],
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

    # 3) Acquisition JE — one debit line to the fixed asset, one credit
    # line per offset (supports mixed funding like $20k cash + $80k loan).
    acq_lines = [
        {"account_id": asset_acct["id"], "account_code": asset_acct["code"],
         "account_name": asset_acct["name"],
         "debit": round(cost, 2), "credit": 0.0,
         "description": f"Acquisition of {name}"},
    ]
    for entry in offset_accts:
        oa = entry["acct"]
        acq_lines.append({
            "account_id": oa["id"], "account_code": oa["code"],
            "account_name": oa["name"],
            "debit": 0.0, "credit": round(entry["amount"], 2),
            "description": f"Paid via {oa['name']}",
        })
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
        "offsets": offsets,
        "pending_funding": pending_funding,
        "funded_amount": 0.0 if pending_funding else round(cost, 2),
    }


async def fund_fixed_asset(cid: str, asset_id: str, sources: list[dict]) -> dict:
    """Two-phase funding: sweep balance out of the Fixed Asset Suspense
    clearing account into the real funding sources.

    Each entry in `sources` is `{account_id, amount}`. The sum of the
    sources cannot exceed the remaining unfunded balance. On each call
    we post ONE journal entry:
        DR Fixed Asset Suspense   (total funded amount this call)
        CR each funding source    (their respective amounts)
    Net effect after full funding: Suspense zeros out and the original
    acquisition JE (DR Asset / CR Suspense) has been transformed into
    (DR Asset / CR real funding accounts).

    Also accepts non-UUID `account_id` (code or name) — mirrors the LLM
    tolerance we built into `create_fixed_asset`.
    """
    row = await db.assets.find_one({"id": asset_id, "company_id": cid})
    if not row:
        raise ValueError(f"asset {asset_id} not found")
    if not sources or not isinstance(sources, list):
        raise ValueError("sources must be a non-empty list of {account_id, amount}")

    cost = float(row.get("cost") or 0)
    funded = float(row.get("funded_amount") or 0)
    remaining = round(cost - funded, 2)
    if remaining <= 0:
        raise ValueError(f"{row.get('name')} is already fully funded")

    # Resolve account ids (code/name → UUID) and validate amounts.
    import re as _re
    uuid_re = _re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", _re.I)
    resolved: list[dict] = []
    for row_in in sources:
        aid = row_in.get("account_id")
        amt = float(row_in.get("amount") or 0)
        if not aid or amt <= 0:
            raise ValueError("each source needs account_id and positive amount")
        if not uuid_re.match(str(aid)):
            key = str(aid).strip()
            acct = await db.accounts.find_one({"company_id": cid, "code": key})
            if not acct:
                key_norm = _re.sub(r"\s+", " ", key).lower()
                async for a in db.accounts.find({"company_id": cid}):
                    if _re.sub(r"\s+", " ", (a.get("name") or "").strip()).lower() == key_norm:
                        acct = a
                        break
            if not acct:
                raise ValueError(f"funding account {aid} not found")
            aid = acct["id"]
        else:
            acct = await db.accounts.find_one({"id": aid, "company_id": cid})
            if not acct:
                raise ValueError(f"funding account {aid} not found")
        resolved.append({"acct": acct, "amount": round(amt, 2)})

    total_this_call = round(sum(r["amount"] for r in resolved), 2)
    if total_this_call > remaining + 0.005:
        raise ValueError(
            f"funding total ${total_this_call:.2f} exceeds remaining ${remaining:.2f}"
        )

    suspense = await _ensure_fixed_asset_suspense(cid)
    today_iso = date.today().isoformat()
    if await is_period_closed(cid, today_iso):
        raise ValueError(f"today ({today_iso}) falls in a closed period")

    lines = [{
        "account_id": suspense["id"], "account_code": suspense["code"],
        "account_name": suspense["name"],
        "debit": total_this_call, "credit": 0.0,
        "description": f"Clear Fixed Asset Suspense — {row.get('name')}",
    }]
    for r in resolved:
        a = r["acct"]
        lines.append({
            "account_id": a["id"], "account_code": a["code"],
            "account_name": a["name"],
            "debit": 0.0, "credit": r["amount"],
            "description": f"Fund {row.get('name')} via {a['name']}",
        })
    je_id = await _post_je(
        cid, date_iso=today_iso,
        memo=f"Fund fixed asset — {row.get('name')}",
        source="asset_funding", asset_id=asset_id, lines=lines,
    )

    # Update the assets row: append to offsets, bump funded_amount,
    # clear pending_funding when fully funded.
    new_funded = round(funded + total_this_call, 2)
    still_pending = new_funded < cost - 0.005
    prior_offsets = list(row.get("offsets") or [])
    # Strip the suspense placeholder offset if we're finishing funding.
    if not still_pending:
        prior_offsets = [
            o for o in prior_offsets if o.get("account_id") != suspense["id"]
        ]
    for r in resolved:
        prior_offsets.append({
            "account_id": r["acct"]["id"], "amount": r["amount"],
        })
    await db.assets.update_one(
        {"id": asset_id},
        {"$set": {
            "offsets": prior_offsets,
            "funded_amount": new_funded,
            "pending_funding": still_pending,
            "funding_je_ids": (row.get("funding_je_ids") or []) + [je_id],
            "updated_at": now_iso(),
        }},
    )

    return {
        "id": asset_id,
        "je_id": je_id,
        "funded_amount": new_funded,
        "remaining": round(cost - new_funded, 2),
        "pending_funding": still_pending,
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
        "offset_account_id", "offsets", "asset_type",
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
    # `create_fixed_asset` treats `offsets` as required. If the payload
    # didn't override it, fall back to the row's existing offsets — or
    # synthesize a single-item list from the legacy `offset_account_id`.
    if "offsets" not in merged and merged.get("offset_account_id"):
        merged["offsets"] = [{
            "account_id": merged["offset_account_id"],
            "amount": float(row.get("cost") or 0),
        }]
    # If cost changed but offsets didn't, scale offsets pro-rata so the
    # new totals still match cost. Users editing only the cost expect
    # their previous funding-source split to survive.
    if ("cost" in payload and "offsets" not in payload
            and merged.get("offsets")):
        old_cost = float(row.get("cost") or 0)
        new_cost = float(merged["cost"])
        if old_cost > 0 and abs(new_cost - old_cost) > 0.005:
            merged["offsets"] = [
                {"account_id": o["account_id"],
                 "amount": round(o["amount"] * new_cost / old_cost, 2)}
                for o in merged["offsets"]
            ]
            # Fix any lingering rounding drift by pushing it into the
            # largest offset (guaranteed to be at least $0.01).
            drift = round(new_cost - sum(o["amount"] for o in merged["offsets"]), 2)
            if abs(drift) >= 0.01:
                biggest = max(merged["offsets"], key=lambda o: o["amount"])
                biggest["amount"] = round(biggest["amount"] + drift, 2)
    await delete_fixed_asset(cid, asset_id)
    new_result = await create_fixed_asset(cid, {
        "name": merged.get("name"),
        "purchase_date": merged.get("purchase_date"),
        "cost": merged.get("cost"),
        "salvage_value": merged.get("salvage_value") or 0,
        "useful_life_years": merged.get("useful_life_years"),
        "asset_type": merged.get("asset_type"),
        "offsets": merged.get("offsets"),
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
    """Forgiving asset-type lookup. Accepts any of:
      * exact key: "residential_real_estate"
      * lowercase/spaced variant: "residential real estate"
      * label: "Residential Real Estate"
      * mixed case with punctuation stripped
    """
    if not key:
        return None
    raw = str(key).strip()
    if not raw:
        return None
    # Try exact match first (fast path).
    for row in ASSET_TYPES:
        if row["key"] == raw:
            return row
    # Normalize: lowercase, collapse whitespace, hyphens → underscores.
    norm = re.sub(r"[\s\-]+", "_", raw.strip().lower())
    norm = re.sub(r"[^a-z0-9_]", "", norm)
    for row in ASSET_TYPES:
        if row["key"] == norm:
            return row
        if re.sub(r"[\s\-]+", "_", row["label"].lower()) == norm:
            return row
        # Match by simplified label (spaces/underscores/hyphens all collapsed).
        row_label_norm = re.sub(r"[^a-z0-9]", "", row["label"].lower())
        if re.sub(r"[^a-z0-9]", "", norm) == row_label_norm:
            return row
    return None
