"""Chart of Accounts field normalization — single source of truth for
`subtype` / `detail_type` shape across every write path.

Why this exists
---------------
The CoA renderer in `frontend/src/pages/ChartOfAccounts.jsx` groups rows
by `detail_type`, using the canonical Wave section keys defined in
`DETAIL_SECTIONS_BY_TYPE`. Any account whose `detail_type` is set to a
value OUTSIDE that list (e.g. legacy `"current_asset"`, QBO-vocabulary
`"entertainment_meals"`, or empty) silently disappears from the CoA UI.

Multiple backend writers historically wrote non-canonical values:
* `canonical_semantic_accounts.py` used QBO API vocab
* `payroll_service.py`, `inventory_service.py` used legacy sub-type strings
* `routes/onboarding.py` AI-CoA insert paths omitted `detail_type` entirely
* The PATCH endpoint's "safety net" blindly mirrored `subtype`→`detail_type`,
  which propagates a stale legacy subtype (e.g. `current_asset`) into
  `detail_type` and hides the row.

This module centralizes the fix: call `normalize_account_fields()` on
every insert/update payload. It snaps `detail_type` to a canonical
Wave key using name-based inference when the caller-supplied value
isn't in the allow-list.
"""
from __future__ import annotations
from typing import Optional


# Canonical Wave-style `detail_type` keys per account type.
# MUST stay in sync with frontend `DETAIL_SECTIONS_BY_TYPE` in
# /app/frontend/src/pages/ChartOfAccounts.jsx.
KNOWN_DETAIL_TYPES: dict[str, set[str]] = {
    "asset": {
        "cash_and_bank",
        "money_in_transit",
        "expected_payments_from_customers",
        "inventory",
        "property_plant_equipment",
        "depreciation_and_amortization",
        "vendor_prepayments",
        "other_short_term_asset",
        "other_long_term_asset",
    },
    "liability": {
        "credit_card",
        "loan_and_line_of_credit",
        "sales_tax_payable",
        "expected_payments_to_vendors",
        "due_for_payroll",
        "customer_prepayments",
        "due_to_owners",
        "other_short_term_liability",
        "other_long_term_liability",
    },
    "equity": {
        "retained_earnings",
        "owner_contribution_drawing",
        "other_equity",
        "opening_balance_equity",
    },
    "revenue": {
        "income",
        "discount",
        "other_income",
    },
    "cogs": {
        "cost_of_goods_sold",
    },
    "expense": {
        "operating_expense",
        "payroll_expense",
        "payment_processing_fee",
        "other_expense",
    },
}

# Explicit remaps for common legacy / QBO-vocab values so we don't
# have to run the name-based inference (which can be wrong for
# ambiguous names). Keys are lowercased; values are canonical.
_LEGACY_REMAP: dict[str, str] = {
    # legacy subtype-as-detail-type (asset side)
    "current_asset": "other_short_term_asset",
    "fixed_asset": "property_plant_equipment",
    "long_term_asset": "other_long_term_asset",
    "accumulated_depreciation": "depreciation_and_amortization",
    "clearing": "money_in_transit",
    "transfer": "money_in_transit",
    # legacy liability
    "current_liability": "other_short_term_liability",
    "long_term_liability": "other_long_term_liability",
    "other_current_liability": "other_short_term_liability",
    "accounts_payable": "expected_payments_to_vendors",
    "credit_card_liability": "credit_card",
    # QBO API vocab that leaks in from canonical_semantic_accounts
    "entertainment_meals": "operating_expense",
    "office_general_administrative_expenses": "operating_expense",
    "dues_subscriptions": "operating_expense",
    "travel": "operating_expense",
    "auto_expenses": "operating_expense",
    "utilities": "operating_expense",
    "rent_or_lease_of_buildings": "operating_expense",
    "insurance_general_liability": "operating_expense",
    "supplies_materials": "operating_expense",
    "supplies_materials_cogs": "cost_of_goods_sold",
    "interest_paid": "other_expense",
    "bank_charges": "operating_expense",
    "discounts_refunds_given": "discount",
    "owners_equity": "owner_contribution_drawing",
    # legacy revenue / cogs / expense
    "operating_revenue": "income",
    "inventory_adjustment": "other_expense",
}


def _infer_from_name(acct_type: str, name: str) -> str:
    """Delegate to the existing name-based inference in routes.accounts.
    Kept as a function (not a module-level import) to avoid a circular
    import — routes/accounts.py imports models which imports pydantic
    which... etc. Late import is fine because this function is only
    called on the write path, not at module load.
    """
    from routes.accounts import _infer_detail_type, _DT_DEFAULT
    dt = _infer_detail_type(acct_type, name or "", "")
    # `_infer_detail_type` falls back to _DT_DEFAULT; that default is
    # already canonical for every type in _DT_DEFAULT.
    return dt or _DT_DEFAULT.get(acct_type, "other_short_term_asset")


def normalize_account_fields(
    acct_type: str,
    name: str = "",
    subtype: Optional[str] = None,
    detail_type: Optional[str] = None,
) -> tuple[str, str]:
    """Return `(subtype, detail_type)` guaranteed to be canonical.

    Rules:
      1. If `detail_type` is already a known Wave key for this type,
         keep it as-is. This is the fast path — most callers already
         write canonical values.
      2. Else if `detail_type` maps via `_LEGACY_REMAP`, snap it.
      3. Else infer from name (`_infer_detail_type`) — this handles
         accounts imported from QBO/CSV with a blank `detail_type`.
      4. `subtype` is mirrored to match `detail_type` so legacy
         consumers (reports.py, fixed_asset checks) stay in sync.

    The old buggy PATCH-endpoint behavior — `detail_type = subtype`
    — is explicitly NOT reproduced here. If the caller passes a
    legacy `subtype` like `"current_asset"`, we DO NOT copy it into
    `detail_type`; we run inference instead.
    """
    t = (acct_type or "expense").lower()
    if t == "income":  # legacy alias
        t = "revenue"

    allowed = KNOWN_DETAIL_TYPES.get(t, set())
    dt_in = (detail_type or "").strip().lower()
    st_in = (subtype or "").strip().lower()

    # Rule 1 — already canonical
    if dt_in in allowed:
        return dt_in, dt_in

    # Rule 2 — subtype is already a canonical detail_type key.
    if st_in and st_in in allowed:
        return st_in, st_in

    # Rule 3 — infer from name. Runs BEFORE legacy remaps because
    # name is more specific than a generic legacy value
    # (e.g. dt="current_asset" would remap to
    # `other_short_term_asset`, but the name "Business Savings"
    # correctly infers `cash_and_bank`). Only accept the inference
    # if it's NOT the type-default bucket (default means "name
    # gave us no signal" — trust the caller's remap in that case).
    _type_default = {
        "asset":     "other_short_term_asset",
        "liability": "other_short_term_liability",
        "equity":    "other_equity",
        "revenue":   "income",
        "cogs":      "cost_of_goods_sold",
        "expense":   "operating_expense",
    }.get(t, "other_short_term_asset")
    inferred = _infer_from_name(t, name)
    if inferred in allowed and inferred != _type_default:
        return inferred, inferred

    # Rule 4 — legacy remap on detail_type / subtype.
    for candidate in (dt_in, st_in):
        if candidate and candidate in _LEGACY_REMAP:
            remapped = _LEGACY_REMAP[candidate]
            if remapped in allowed:
                return remapped, remapped

    # Rule 5 — inferred value even if it's the type-default (we tried).
    if inferred in allowed:
        return inferred, inferred

    # Last resort — the default bucket for the type. Guaranteed
    # to be in `allowed` for every type we support.
    fallback = {
        "asset":     "other_short_term_asset",
        "liability": "other_short_term_liability",
        "equity":    "other_equity",
        "revenue":   "income",
        "cogs":      "cost_of_goods_sold",
        "expense":   "operating_expense",
    }.get(t, "other_short_term_asset")
    return fallback, fallback


def normalize_account_payload(payload: dict, existing: Optional[dict] = None) -> dict:
    """Convenience wrapper for MongoDB `$set` payloads. Mutates and
    returns `payload` with normalized `subtype`/`detail_type`. Reads
    `type`/`name` from `payload` first, falling back to `existing`
    (the pre-image loaded before an update).

    Only touches the two classification fields — every other key in
    `payload` passes through untouched.
    """
    src = {**(existing or {}), **payload}
    acct_type = src.get("type") or "expense"
    name      = src.get("name") or ""
    st, dt = normalize_account_fields(
        acct_type=acct_type,
        name=name,
        subtype=src.get("subtype"),
        detail_type=src.get("detail_type"),
    )
    payload["subtype"]     = st
    payload["detail_type"] = dt
    return payload
