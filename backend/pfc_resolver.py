"""PFC → account_id resolver (Python port of Rocketbooks'
`lib/accounting/resolve-pfc-coa.ts`).

Resolution order (strict precedence):
  0. no/unknown PFC                 → returns None (defer to merchant rules / LLM)
  1. pfc_org_overrides (per-org)    → short-circuits everything → source='override'
  2. Primary slot (org's default COA account for the mapped code) → source='primary'
  3. Uncategorized fallback (direction-aware) → source='fallback_uncategorized'
  4. Unmapped (org missing even uncategorized) → source='unmapped', category_id=None

Additional invariants (mirrored from source):
  - Never resolve a category to the bank account being categorized (would create
    a self-cancelling JE).
  - Never resolve a category to any bank asset account — those are the contra
    leg of a transfer, not a category. Falls through to review instead.
  - If the resolved COA row's name matches /uncategori[sz]ed/, force
    reviewed=false regardless of PFC classification confidence.
"""
from __future__ import annotations
from typing import Optional, TypedDict
import re

from db import db
import pfc_mapping
from pfc_mapping import PfcMapping


class ResolvedPfc(TypedDict):
    category_account_id: Optional[str]
    category_account_code: Optional[str]
    category_account_name: Optional[str]
    classification: str
    reviewed_by_default: bool
    mapping: PfcMapping
    source: str  # override | primary | fallback_uncategorized | unmapped


_UNCAT_NAME_RX = re.compile(r"uncategori[sz]ed", re.I)


def _is_uncategorized_account(name: Optional[str]) -> bool:
    return bool(name) and bool(_UNCAT_NAME_RX.search(name))


def _is_bank_account(acct: dict) -> bool:
    """A bank/cash-flavored asset account — either the 1000-1099 code range
    (per seed convention) OR `1100 Undeposited Funds` (Feb 17, 2026: added
    to the guard because TRANSFER_IN_DEPOSIT used to auto-route to 1100 and
    produced impossible negative balances there). Extended: any account with
    subtype='Bank' (resolver-created rows like `1011 BofA Checking ···6084`).
    """
    code = str(acct.get("code") or "")
    if code.startswith("10") and len(code) == 4:  # 1000-1099
        return True
    if code == "1100":
        return True
    if (acct.get("subtype") or "").lower() == "bank":
        return True
    return False


async def resolve_pfc_coa(
    company_id: str,
    pfc_detailed: Optional[str],
    bank_account_id: Optional[str] = None,
) -> Optional[ResolvedPfc]:
    """Resolve a Plaid PFCv2 detailed code to a target COA account on this org.

    Returns None only when pfc_detailed is empty/unknown — signaling the caller
    to defer to merchant rules / vendor memory / LLM. Otherwise always returns
    a dict; category_account_id may still be None (source='unmapped') if the
    org lacks even the uncategorized fallback slots.
    """
    if not pfc_detailed:
        return None
    mapping = pfc_mapping.get_pfc_mapping(pfc_detailed)
    if not mapping:
        return None

    reviewed = pfc_mapping.reviewed_by_default(mapping.classification)

    # Preload this org's COA once (small, ~30-50 rows on default seed).
    accts = await db.accounts.find({"company_id": company_id}).to_list(2000)
    by_id = {a["id"]: a for a in accts}
    by_code = {a["code"]: a for a in accts}

    # ---------------------------------------------------------------
    # Step 1. Per-org override — indexed (org, pfc_detailed) lookup.
    # ---------------------------------------------------------------
    override = await db.pfc_org_overrides.find_one({
        "company_id": company_id, "pfc_detailed": pfc_detailed,
    })
    if override and override.get("category_account_id"):
        acct = by_id.get(override["category_account_id"])
        # Never auto-categorize to the same bank account (self-cancelling JE)
        # or to any other bank/cash asset (transfer contra leg).
        if acct and acct["id"] != bank_account_id and not _is_bank_account(acct):
            uncat = _is_uncategorized_account(acct.get("name"))
            return ResolvedPfc(
                category_account_id=acct["id"],
                category_account_code=acct["code"],
                category_account_name=acct["name"],
                classification=mapping.classification,
                reviewed_by_default=False if uncat else reviewed,
                mapping=mapping,
                source="override",
            )
        # Otherwise fall through to primary slot resolution.

    # ---------------------------------------------------------------
    # Step 2. Primary slot — the seeded account for the mapped code.
    # ---------------------------------------------------------------
    primary = by_code.get(mapping.account_code)
    # Guard: never resolve to the being-categorized bank account or to any bank.
    if primary and primary["id"] != bank_account_id and not _is_bank_account(primary):
        uncat = _is_uncategorized_account(primary.get("name"))
        return ResolvedPfc(
            category_account_id=primary["id"],
            category_account_code=primary["code"],
            category_account_name=primary["name"],
            classification=mapping.classification,
            reviewed_by_default=False if uncat else reviewed,
            mapping=mapping,
            source="primary",
        )

    # ---------------------------------------------------------------
    # Step 3. Uncategorized fallback (direction-aware).
    # ---------------------------------------------------------------
    goes_to_income = (
        mapping.classification == "business_income"
        or mapping.classification == "liability_increase"
        or (mapping.classification == "asset_movement" and mapping.pfc_primary == "TRANSFER_IN")
        or (mapping.classification == "transfer_review" and mapping.pfc_primary == "TRANSFER_IN")
    )
    fallback_code = "4999" if goes_to_income else "6999"
    fallback = by_code.get(fallback_code)
    if fallback:
        return ResolvedPfc(
            category_account_id=fallback["id"],
            category_account_code=fallback["code"],
            category_account_name=fallback["name"],
            classification=mapping.classification,
            reviewed_by_default=False,  # anything hitting uncategorized → review
            mapping=mapping,
            source="fallback_uncategorized",
        )

    # ---------------------------------------------------------------
    # Step 4. Unmapped — org lacks even the uncategorized slot.
    # ---------------------------------------------------------------
    return ResolvedPfc(
        category_account_id=None,
        category_account_code=None,
        category_account_name=None,
        classification=mapping.classification,
        reviewed_by_default=False,
        mapping=mapping,
        source="unmapped",
    )


# ---------------------------------------------------------------------------
# pfc_org_overrides collection helpers
# ---------------------------------------------------------------------------

async def ensure_pfc_override_indexes() -> None:
    """Idempotent unique index on (company_id, pfc_detailed)."""
    try:
        await db.pfc_org_overrides.create_index(
            [("company_id", 1), ("pfc_detailed", 1)],
            unique=True, name="company_pfc_uniq",
        )
    except Exception:  # noqa: BLE001 — already exists w/ same spec
        pass


async def set_pfc_override(
    company_id: str, pfc_detailed: str, category_account_id: str,
    source: str = "user", confidence: Optional[float] = None,
    reasoning: Optional[str] = None, ai_model: Optional[str] = None,
) -> dict:
    """Upsert a per-org PFC pin. `source` ∈ {'user','ai','pinned'}.

    Highest precedence at resolve time — hits step 1 before the primary-slot
    fallback. Used when an org connects QuickBooks and the AI mapper assigns
    each PFC to a specific QB account (Rocketbooks' `finalize-coa-after-qb.ts`
    path), or when a user manually pins a PFC to a specific category.
    """
    from db import now_iso
    doc = {
        "company_id": company_id,
        "pfc_detailed": pfc_detailed,
        "category_account_id": category_account_id,
        "source": source,
        "confidence": confidence,
        "reasoning": reasoning,
        "ai_model": ai_model,
        "updated_at": now_iso(),
    }
    await db.pfc_org_overrides.update_one(
        {"company_id": company_id, "pfc_detailed": pfc_detailed},
        {"$set": doc, "$setOnInsert": {"created_at": now_iso()}},
        upsert=True,
    )
    return doc


__all__ = [
    "ResolvedPfc",
    "resolve_pfc_coa",
    "ensure_pfc_override_indexes",
    "set_pfc_override",
]
