"""Shared dependencies + private helpers for route modules.

These functions were previously module-level in `server.py`. They're used
across almost every route module (auth checks, period-close guards, the
categorize-and-insert pipeline, Plaid sync), so they live here to keep
each `routes/*.py` file focused on HTTP handlers only.
"""
from __future__ import annotations
import uuid
from fastapi import HTTPException
from db import db, now_iso, coerce
import contact_resolver

# Global TTL for Dashboard endpoints. Short enough that stale reads clear
# within one poll interval, long enough that ~200 tabs on the same company
# collapse into a single Mongo hit.
DASH_CACHE_TTL = 15


async def company_ids_for_user(user: dict) -> list[str]:
    if user["role"] == "superadmin":
        docs = await db.companies.find({}).to_list(1000)
        return [d["id"] for d in docs]
    ms = await db.memberships.find({"user_id": user["id"]}).to_list(1000)
    return [m["company_id"] for m in ms]


async def require_company(user: dict, company_id: str) -> dict:
    ids = await company_ids_for_user(user)
    if company_id not in ids:
        raise HTTPException(403, "No access to this company")
    c = await db.companies.find_one({"id": company_id})
    if not c:
        raise HTTPException(404, "Company not found")
    # Attach company id to the request-scoped ai_usage context so every
    # LLM / Veryfi / Resend call made inside this handler gets tagged
    # with the right company for cost attribution. Non-fatal if the
    # tracker isn't importable in some slim test envs.
    try:
        from ai_usage import set_request_context
        set_request_context(user_id=user["id"], company_id=company_id)
    except Exception:
        pass
    return coerce(c)


# --------------------------------------------------------------------------
# Role-based write guards (Feb 2026 — Feature #3 enforcement).
#
# Roles: viewer < reviewer < editor < owner/pro/superadmin
#   * viewer   — read-only
#   * reviewer — read + approve/reject; NO create/update/delete
#   * editor   — read + review + full write on transactions/JEs/etc.
#   * owner/pro/superadmin — everything
#
# The guards accept `user` and `company_id` positional args to match the
# ergonomics of the existing `require_company` helper, and return the
# same company doc so callers can use it directly.
# --------------------------------------------------------------------------

# Strictly-increasing privilege ladder. "owner" / "pro" / "superadmin"
# are absolute — they always pass every guard.
_WRITE_ROLES  = {"owner", "pro", "editor"}
_REVIEW_ROLES = {"owner", "pro", "editor", "reviewer"}


async def _role_at_company(user: dict, company_id: str) -> str | None:
    """Return the user's effective role at ``company_id`` — falling back to
    the global user.role for superadmins. ``None`` means no membership."""
    if user["role"] == "superadmin":
        return "superadmin"
    m = await db.memberships.find_one({"user_id": user["id"], "company_id": company_id})
    return (m or {}).get("role")


async def require_company_write(user: dict, company_id: str) -> dict:
    """Same as ``require_company`` but additionally forbids
    reviewer/viewer memberships from write operations (returns 403)."""
    company = await require_company(user, company_id)
    role = await _role_at_company(user, company_id)
    if role and role not in _WRITE_ROLES and user["role"] != "superadmin":
        raise HTTPException(
            403,
            f"Your role on this company ({role}) is read-only for this action. "
            "Ask an owner or editor to make the change.",
        )
    return company


async def require_company_review(user: dict, company_id: str) -> dict:
    """Same as ``require_company`` but forbids ``viewer`` from taking
    approve/reject actions. Reviewers ARE allowed here (that's the point
    of the reviewer role)."""
    company = await require_company(user, company_id)
    role = await _role_at_company(user, company_id)
    if role and role not in _REVIEW_ROLES and user["role"] != "superadmin":
        raise HTTPException(
            403,
            f"Your role on this company ({role}) is read-only. "
            "Only reviewers and above can approve or reject.",
        )
    return company


async def log_ai(company_id: str, kind: str, count: int = 1):
    existing = await db.ai_activity.find_one({"company_id": company_id, "type": kind})
    if existing:
        await db.ai_activity.update_one(
            {"id": existing["id"]},
            {"$inc": {"count": count}, "$set": {"updated_at": now_iso()}},
        )
    else:
        await db.ai_activity.insert_one({
            "id": str(uuid.uuid4()), "company_id": company_id, "type": kind,
            "count": count, "created_at": now_iso(),
        })


async def is_period_closed(company_id: str, date_str: str) -> bool:
    """True if the given ISO date falls within a closed period for the company."""
    if not date_str:
        return False
    doc = await db.close_periods.find_one({
        "company_id": company_id, "status": "closed",
        "period_start": {"$lte": date_str},
        "period_end": {"$gte": date_str},
    })
    return doc is not None


async def assert_open(company_id: str, date_str: str):
    if await is_period_closed(company_id, date_str):
        raise HTTPException(423, f"Period covering {date_str} is closed. Reopen it to edit.")


async def categorize_and_insert(
    cid: str, candidates: list[dict], accts: list[dict], coa: list[dict],
    source: str,
) -> int:
    """Shared: resolve contacts + group-categorize + decide posting + bulk insert.
    Each candidate dict must supply at least: plaid_txn(optional), merchant,
    merchant_name(optional), description, amount, date, and optionally pfc / pfc_primary,
    plus bank_account_id + bank_account_name for the ledger side, and any
    source-specific pass-through fields like plaid_transaction_id, plaid_account_id, pending.
    """
    import categorizer
    from ai_service import resolve_contact_ai, categorize_transaction
    if not candidates:
        return 0

    # Contacts (parallel, fast path skips AI)
    contact_res = await contact_resolver.resolve_contacts_batch(
        cid, candidates, ai_fallback_fn=resolve_contact_ai, concurrency=5,
    )
    for c, r in zip(candidates, contact_res):
        c["contact_id"] = r.get("contact_id")
        c["contact_name"] = r.get("contact_name")

    # Categorize (grouped)
    cat_res = await categorizer.categorize_batch_grouped(
        cid, candidates, coa, categorize_transaction, concurrency=10,
    )

    # Uncat + threshold
    uncat_exp, uncat_inc = await categorizer.ensure_uncategorized_accounts(cid)
    accts = await db.accounts.find({"company_id": cid}).to_list(2000)
    threshold = await categorizer.get_auto_post_threshold(cid)

    now = now_iso()
    accts_by_id = {a["id"]: a for a in accts}
    from liability_subaccounts import maybe_route_to_liability_subaccount
    docs = []
    for c, r in zip(candidates, cat_res):
        post = categorizer.decide_posting(r, threshold, uncat_exp, uncat_inc, accts, c["amount"])
        post = await maybe_route_to_liability_subaccount(
            cid, post,
            merchant=c.get("merchant"),
            contact_name=c.get("contact_name"),
            accts_by_id=accts_by_id,
        )
        base = {
            "id": str(uuid.uuid4()), "company_id": cid, "date": c["date"],
            "description": c["description"], "merchant": c["merchant"], "amount": c["amount"],
            "bank_account_id": c["bank_account_id"], "bank_account_name": c["bank_account_name"],
            "contact_id": c.get("contact_id"), "contact_name": c.get("contact_name"),
            **post, "human_reviewed": False, "source": source,
            "splits": [], "linked_invoice_id": None, "linked_bill_id": None,
            "linked_payment_id": None, "tags": [],
            "cache_hit": r.get("cache_hit", False),
            "created_at": now, "updated_at": now,
        }
        for k in ("plaid_transaction_id", "plaid_account_id", "pending"):
            if k in c:
                base[k] = c[k]
        docs.append(base)
    if docs:
        try:
            await db.transactions.insert_many(docs, ordered=False)
        except Exception as e:  # noqa: BLE001
            written = getattr(e, "details", {}).get("nInserted", 0) if hasattr(e, "details") else 0
            app_log = __import__("logging").getLogger("axiom.app")
            app_log.info(f"insert_many partial: wrote {written}/{len(docs)} (dedup)")
        await log_ai(cid, "categorize", len(docs))
    return len(docs)


async def sync_and_import(cid: str, item: dict, selected_account_ids: list[str] | None = None) -> int:
    """Run Plaid transactions_sync + route each new txn through the PFC pipeline.
    Used by both the Plaid webhook handler and the manual-sync endpoint.
    """
    import plaid_service
    import plaid_connect
    from ai_service import categorize_transaction as _cat
    try:
        synced = plaid_service.sync_transactions(item["access_token"], item.get("cursor"))
    except Exception:
        return 0
    await db.plaid_items.update_one({"id": item["id"]}, {"$set": {
        "cursor": synced["next_cursor"], "updated_at": now_iso(),
    }})
    await plaid_connect._apply_sync_balance_snapshot(item, synced.get("accounts") or [])
    item = await db.plaid_items.find_one({"id": item["id"]}) or item

    for rt in synced.get("removed") or []:
        rid = rt.get("transaction_id") if isinstance(rt, dict) else rt
        if rid:
            await db.transactions.delete_one({
                "company_id": cid, "plaid_transaction_id": rid,
            })

    accts = await db.accounts.find({"company_id": cid}).to_list(2000)
    coa = [{"code": a["code"], "name": a["name"], "type": a["type"]} for a in accts]
    fallback_bank = next((a for a in accts if a["code"] == "1010"), None)
    if not fallback_bank:
        return 0
    mappings = item.get("account_mappings") or {}

    by_bank: dict[str, list[dict]] = {}
    for t in synced["added"]:
        if selected_account_ids and t["account_id"] not in selected_account_ids:
            continue
        mapping = mappings.get(t["account_id"])
        ledger_bank = (
            next((a for a in accts if a["id"] == mapping["ledger_account_id"]), fallback_bank)
            if mapping else fallback_bank
        )
        by_bank.setdefault(ledger_bank["id"], []).append(t)

    imported = 0
    for bank_id, txns in by_bank.items():
        ledger_bank = next(a for a in accts if a["id"] == bank_id)
        inserted, _skipped = await plaid_connect.categorize_and_insert_plaid_txns(
            cid, txns, ledger_bank, coa, accts,
            categorize_fn=_cat, is_period_closed_fn=is_period_closed,
        )
        imported += len(inserted)
    if imported:
        await log_ai(cid, "webhook_sync", imported)
    return imported
