"""Generic company purge — deletes every document scoped to a company
across ALL collections (anything with `company_id == cid`), except
platform ledgers that must survive for billing / audit history."""
from __future__ import annotations

from db import db

# Never swept: cross-company billing + audit ledgers (anonymize-by-orphan is
# acceptable there), plus the two root collections handled explicitly.
KEEP = {
    "companies", "users", "enterprises",
    "audit_events", "audit_logs", "admin_audit_log",
    "platform_payments", "enterprise_invoices", "referral_earnings",
    "referral_payout_batches", "stripe_events", "stripe_webhook_events",
    "ai_spend_daily",
}


async def company_data_preview(cid: str) -> dict[str, int]:
    counts: dict[str, int] = {}
    for name in sorted(await db.list_collection_names()):
        if name in KEEP or name.startswith("system."):
            continue
        try:
            n = await db[name].count_documents({"company_id": cid})
        except Exception:  # noqa: BLE001
            continue
        if n:
            counts[name] = n
    return counts


async def purge_company_data(cid: str) -> dict[str, int]:
    """Delete all company-scoped docs, then the company itself."""
    removed: dict[str, int] = {}
    for name in sorted(await db.list_collection_names()):
        if name in KEEP or name.startswith("system."):
            continue
        try:
            r = await db[name].delete_many({"company_id": cid})
        except Exception:  # noqa: BLE001
            continue
        if r.deleted_count:
            removed[name] = r.deleted_count
    r = await db.companies.delete_one({"id": cid})
    removed["companies"] = r.deleted_count
    return removed
