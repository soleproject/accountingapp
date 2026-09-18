"""Step 3 — company account context.

Discovers every account the CPA will eventually be asked about:
  1. Connected ledger accounts (bank + credit) with their ``last4`` and
     ``type``. Read from the live ``accounts`` collection.
  2. Outside accounts referenced in transfer-language descriptions
     but not connected to this book (e.g., ``CHK ···6278``).
  3. Payment-app + credit-line accounts referenced across the txn set
     (PayPal, Venmo, Cash App, PayPal Credit, Zelle host).

Everything else lives on ``lab_company_accounts`` keyed by
``account_key`` (a stable identifier so re-runs are idempotent).
Status starts at ``unknown``; the stage-1 card in Phase 4 flips it to
``connected`` or ``outside`` or ``payment_app`` after the CPA answers.
"""
from __future__ import annotations
import logging
import re
from datetime import datetime, timezone
from db import db
from .collections import LAB_COMPANY_ACCOUNTS
from .step2_parse import extract_dest_last4, has_transfer_language

log = logging.getLogger("axiom.lab.step3")

_PAYMENT_APPS = {
    "paypal":   "payment_app_paypal",
    "venmo":    "payment_app_venmo",
    "cash app": "payment_app_cashapp",
    "cashapp":  "payment_app_cashapp",
    "zelle":    "payment_app_zelle",
}
_CREDIT_LINE_TAGS = {
    "paypal credit": "credit_line_paypal_credit",
    "paypal cred":   "credit_line_paypal_credit",
    "credit repaymen": "credit_line_paypal_credit",
}


async def load_connected_accounts(company_id: str) -> list[dict]:
    """Return a list of {account_id, name, last4, type, subtype}.
    Read-only from live ``accounts``."""
    out = []
    async for a in db.accounts.find({"company_id": company_id}):
        # Only banks / cards are relevant. Skip income/expense.
        a_type = (a.get("type") or "").lower()
        if a_type not in ("bank", "credit", "asset", "other-asset",
                          "liability", "other-liability"):
            continue
        out.append({
            "account_id":   a.get("id"),
            "name":         a.get("name"),
            "last4":        a.get("bank_last4") or a.get("last4"),
            "type":         a_type,
            "subtype":      a.get("subtype"),
            "plaid_id":     a.get("plaid_account_id"),
            "active":       a.get("active", True),
        })
    return out


async def upsert_lab_account(
    company_id: str, *, account_key: str, kind: str, detected_from: str,
    display_name: str | None, last4: str | None,
    linked_account_id: str | None = None,
) -> None:
    """Idempotent upsert of a lab_company_accounts row."""
    now = datetime.now(timezone.utc).isoformat()
    await db[LAB_COMPANY_ACCOUNTS].update_one(
        {"company_id": company_id, "account_key": account_key},
        {"$setOnInsert": {
            "created_at":    now,
            "status":        "unknown",
            "used_for_personal": False,
        }, "$set": {
            "kind":          kind,
            "detected_from": detected_from,
            "display_name":  display_name,
            "last4":         last4,
            "linked_account_id": linked_account_id,
            "last_seen_at":  now,
        }, "$inc": {"detected_row_count": 1}},
        upsert=True,
    )


async def scan_and_register(
    company_id: str, txns: list[dict],
    connected: list[dict],
) -> dict:
    """Walk the txn batch, detecting outside accounts + payment apps
    + credit lines. Registers each into ``lab_company_accounts``.
    Returns a summary for the report."""
    # Precompute the set of connected last-4s so we can tell outside
    # accounts apart from internal ones.
    connected_last4s = {(a.get("last4") or "").strip()
                         for a in connected if a.get("last4")}
    outside_counts: dict[str, int] = {}
    payment_apps_seen: dict[str, int] = {}
    credit_lines_seen: dict[str, int] = {}

    for t in txns:
        desc = t.get("description") or ""
        low  = desc.lower()

        # Outside accounts referenced by "CHK 6278" etc. — ONLY on
        # rows with actual transfer language, else we'd pick up
        # "CHECKCARD 0805 …" date fragments as account last-4s.
        if has_transfer_language(desc):
            last4 = extract_dest_last4(desc)
            if last4 and last4 not in connected_last4s:
                key = f"outside_chk_{last4}"
                outside_counts[key] = outside_counts.get(key, 0) + 1

        # Payment apps + Zelle
        for token, key in _PAYMENT_APPS.items():
            if token in low:
                payment_apps_seen[key] = payment_apps_seen.get(key, 0) + 1
                break  # a row has one primary payment app

        # Credit line tags
        for token, key in _CREDIT_LINE_TAGS.items():
            if token in low:
                credit_lines_seen[key] = credit_lines_seen.get(key, 0) + 1
                break

    # Register connected accounts (idempotent).
    for a in connected:
        await upsert_lab_account(
            company_id,
            account_key=f"connected_{a['account_id']}",
            kind=("credit_card" if a["type"] == "credit"
                   else "bank"),
            detected_from="live_accounts",
            display_name=a.get("name"),
            last4=a.get("last4"),
            linked_account_id=a["account_id"],
        )

    # Register outside accounts.
    for key, count in outside_counts.items():
        last4 = key.split("_")[-1]
        await upsert_lab_account(
            company_id,
            account_key=key,
            kind="outside_bank",
            detected_from="transfer_language",
            display_name=f"External account ···{last4}",
            last4=last4,
        )

    # Register payment apps.
    for key, count in payment_apps_seen.items():
        name = key.replace("payment_app_", "").replace("_", " ").title()
        await upsert_lab_account(
            company_id,
            account_key=key,
            kind="payment_app",
            detected_from="descriptor_scan",
            display_name=name,
            last4=None,
        )

    # Register credit lines.
    for key, count in credit_lines_seen.items():
        await upsert_lab_account(
            company_id,
            account_key=key,
            kind="credit_line",
            detected_from="descriptor_scan",
            display_name=key.replace("credit_line_", "").replace("_", " ").title(),
            last4=None,
        )

    log.info("lab.step3: %s connected=%d outside=%d payment_apps=%d credit_lines=%d",
             company_id, len(connected), len(outside_counts),
             len(payment_apps_seen), len(credit_lines_seen))
    return {
        "connected":       len(connected),
        "outside":         outside_counts,
        "payment_apps":    payment_apps_seen,
        "credit_lines":    credit_lines_seen,
    }
