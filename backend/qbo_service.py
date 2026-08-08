"""QuickBooks Online integration — OAuth2 + Accounting API v3 client.

Design notes (see `/app/memory/PRD.md` for full playbook):

* One-way, resumable bulk import per company. `realm_id` is the QBO
  company identifier; we store one QBO connection doc per internal
  `company_id`. Tokens are encrypted at rest (Fernet via crypto_service).
* Access tokens live 60 min; refresh tokens rotate with a 100-day rolling
  expiry, 5-year hard cap. Refresh is serialised per-connection to avoid
  the two-workers-refresh-with-the-same-refresh-token bug.
* Query pagination: MAXRESULTS=1000, advance by rows returned.
* Rate limits: 500 req/min/realm, 10 concurrent/second/realm. We cap the
  in-process semaphore at 8 and back off exponentially on 429/5xx.
* Entity dependency order matters — Accounts before anything else,
  Customers/Vendors/Items before transactional records.
"""
from __future__ import annotations
import os
import asyncio
import inspect
import random
import logging
from datetime import datetime, timezone, timedelta
from typing import Any, AsyncIterator, Optional

import httpx
from intuitlib.client import AuthClient
from intuitlib.enums import Scopes

from db import db, now_iso
from crypto_service import encrypt, decrypt

logger = logging.getLogger(__name__)

QBO_ENV = os.environ.get("QBO_ENV", "sandbox")
QBO_CLIENT_ID = os.environ.get("QBO_CLIENT_ID")
QBO_CLIENT_SECRET = os.environ.get("QBO_CLIENT_SECRET")
QBO_REDIRECT_URI = os.environ.get("QBO_REDIRECT_URI")
QBO_MINOR_VERSION = os.environ.get("QBO_MINOR_VERSION", "75")

QBO_APP_URL = os.environ.get("QBO_APP_URL", "https://app.smartbookssoftware.ai")
API_BASE = ("https://sandbox-quickbooks.api.intuit.com/v3"
            if QBO_ENV == "sandbox"
            else "https://quickbooks.api.intuit.com/v3")

# Deploy canary — bumped every time the mapper contract changes. The
# diagnostics endpoint echoes this back so we can verify at a glance
# which version Railway is actually running (vs. what's in git). If a
# migration fails and this is NOT the string below, Railway is on stale
# code and the fix is not in production yet.
MAPPER_VERSION = "v4-2026-02-08-capital-Id-null-safe-per-row-isolation"


def _auth_client() -> AuthClient:
    return AuthClient(
        client_id=QBO_CLIENT_ID,
        client_secret=QBO_CLIENT_SECRET,
        redirect_uri=QBO_REDIRECT_URI,
        environment=QBO_ENV,
    )


# ------------------------------------------------------------------
# OAuth: URL, callback exchange, refresh, revoke
# ------------------------------------------------------------------

def authorization_url(state: str) -> str:
    """Return the Intuit consent URL. `state` is a CSRF token bound to
    the caller's company_id, stored in db.qbo_oauth_states with a 10-min
    expiry and consumed exactly once on callback."""
    c = _auth_client()
    return c.get_authorization_url([Scopes.ACCOUNTING], state_token=state)


async def exchange_code(code: str, realm_id: str) -> dict[str, Any]:
    """Exchange an OAuth `code` for tokens. Wraps the sync SDK call in
    `run_in_executor` since it's blocking."""
    def _blocking() -> dict[str, Any]:
        c = _auth_client()
        c.get_bearer_token(code, realm_id=realm_id)
        return {
            "access_token": c.access_token,
            "refresh_token": c.refresh_token,
            "expires_in": c.expires_in or 3600,
            "x_refresh_token_expires_in": c.x_refresh_token_expires_in or 8640000,
        }
    return await asyncio.get_event_loop().run_in_executor(None, _blocking)


# Per-connection refresh serialization. Multiple concurrent import
# workers on the same realm must not race a refresh; we use an
# in-process asyncio.Lock keyed by company_id. For multi-worker
# deployments this must be swapped for a distributed lock (Redis).
_refresh_locks: dict[str, asyncio.Lock] = {}


def _lock_for(company_id: str) -> asyncio.Lock:
    lk = _refresh_locks.get(company_id)
    if not lk:
        lk = asyncio.Lock()
        _refresh_locks[company_id] = lk
    return lk


async def _refresh(company_id: str, refresh_token: str) -> dict[str, Any]:
    def _blocking() -> dict[str, Any]:
        c = _auth_client()
        c.refresh(refresh_token=refresh_token)
        return {
            "access_token": c.access_token,
            "refresh_token": c.refresh_token,
            "expires_in": c.expires_in or 3600,
        }
    return await asyncio.get_event_loop().run_in_executor(None, _blocking)


async def revoke(refresh_token: str) -> None:
    def _blocking():
        c = _auth_client()
        try:
            c.revoke(token=refresh_token)
        except Exception as e:  # noqa: BLE001
            logger.warning("QBO revoke failed: %s", e)
    await asyncio.get_event_loop().run_in_executor(None, _blocking)


# ------------------------------------------------------------------
# Connection persistence
# ------------------------------------------------------------------

async def save_connection(company_id: str, realm_id: str, tokens: dict) -> None:
    now = datetime.now(timezone.utc)
    doc = {
        "company_id": company_id,
        "realm_id": realm_id,
        "environment": QBO_ENV,
        "access_token_enc": encrypt(tokens["access_token"]),
        "refresh_token_enc": encrypt(tokens["refresh_token"]),
        "access_expires_at": (now + timedelta(seconds=int(tokens["expires_in"]))).isoformat(),
        "refresh_expires_at": (now + timedelta(seconds=int(
            tokens.get("x_refresh_token_expires_in", 8640000)))).isoformat(),
        "status": "connected",
        "updated_at": now_iso(),
    }
    await db.qbo_connections.update_one(
        {"company_id": company_id},
        {"$set": doc, "$setOnInsert": {"created_at": now_iso()}},
        upsert=True,
    )


async def get_connection(company_id: str) -> Optional[dict]:
    return await db.qbo_connections.find_one({"company_id": company_id})


async def get_access_token(company_id: str) -> str:
    """Return a valid access token, refreshing if within a 2-min expiry
    window. Serialized per-company."""
    async with _lock_for(company_id):
        conn = await get_connection(company_id)
        if not conn or conn.get("status") != "connected":
            raise RuntimeError("QBO not connected")
        exp = datetime.fromisoformat(conn["access_expires_at"])
        if exp > datetime.now(timezone.utc) + timedelta(minutes=2):
            return decrypt(conn["access_token_enc"])
        # Refresh
        new = await _refresh(company_id, decrypt(conn["refresh_token_enc"]))
        now = datetime.now(timezone.utc)
        await db.qbo_connections.update_one(
            {"company_id": company_id},
            {"$set": {
                "access_token_enc": encrypt(new["access_token"]),
                "refresh_token_enc": encrypt(new["refresh_token"]),
                "access_expires_at": (now + timedelta(seconds=int(new["expires_in"]))).isoformat(),
                "updated_at": now_iso(),
            }},
        )
        return new["access_token"]


# ------------------------------------------------------------------
# HTTP client with pagination + retry
# ------------------------------------------------------------------

_gate = asyncio.Semaphore(8)


async def _get(company_id: str, realm_id: str, path: str, params: dict) -> dict:
    tok = await get_access_token(company_id)
    async with httpx.AsyncClient(timeout=60) as client:
        for attempt in range(6):
            async with _gate:
                r = await client.get(
                    f"{API_BASE}{path}",
                    params={**params, "minorversion": QBO_MINOR_VERSION},
                    headers={
                        "Authorization": f"Bearer {tok}",
                        "Accept": "application/json",
                    },
                )
            if r.status_code == 401 and attempt == 0:
                # Force refresh on next iteration.
                await db.qbo_connections.update_one(
                    {"company_id": company_id},
                    {"$set": {"access_expires_at": now_iso()}},
                )
                tok = await get_access_token(company_id)
                continue
            if r.status_code in (429, 500, 502, 503, 504):
                await asyncio.sleep(min(60, 2 ** attempt + random.random()))
                continue
            r.raise_for_status()
            return r.json()
    raise RuntimeError("QBO unavailable after retries")


async def query_count(company_id: str, realm_id: str, entity: str) -> int:
    """Return total rows for an entity — used by the Preview step."""
    data = await _get(company_id, realm_id, f"/company/{realm_id}/query",
                      {"query": f"SELECT COUNT(*) FROM {entity}"})
    return int(data.get("QueryResponse", {}).get("totalCount", 0) or 0)


async def query_all(company_id: str, realm_id: str, entity: str) -> AsyncIterator[dict]:
    start, page = 1, 1000
    while True:
        q = f"SELECT * FROM {entity} STARTPOSITION {start} MAXRESULTS {page}"
        data = await _get(company_id, realm_id, f"/company/{realm_id}/query", {"query": q})
        rows = data.get("QueryResponse", {}).get(entity, []) or []
        for row in rows:
            yield row
        if len(rows) < page:
            break
        start += len(rows)


async def get_company_info(company_id: str, realm_id: str) -> dict:
    return await _get(company_id, realm_id,
                      f"/company/{realm_id}/companyinfo/{realm_id}", {})


# ------------------------------------------------------------------
# Entity mapping — QBO → our internal schemas
# ------------------------------------------------------------------

# Every migrated doc carries `source: "qbo"` + `qbo_id` + `realm_id`
# so we can idempotently upsert and later reconcile against QBO.

_ACCOUNT_TYPE_MAP = {
    "Bank": "asset", "Other Current Asset": "asset", "Fixed Asset": "asset",
    "Other Asset": "asset", "Accounts Receivable": "asset",
    "Accounts Payable": "liability", "Credit Card": "liability",
    "Other Current Liability": "liability", "Long Term Liability": "liability",
    "Equity": "equity",
    "Income": "revenue", "Other Income": "revenue",
    "Cost of Goods Sold": "cogs",
    "Expense": "expense", "Other Expense": "expense",
}


def map_account(cid: str, realm_id: str, obj: dict) -> dict:
    """QBO Account → our accounts collection shape.
    `name` intentionally uses `Name` (the leaf), NOT
    `FullyQualifiedName` — the colon-nested path (e.g.
    `Landscaping Services:Job Materials:Decks and Patios`) belongs in
    a parent-child tree, not a flat name. `parent_qbo_id` captures the
    QBO parent id; `resolve_account_parents` translates it to a local
    `parent_account_id` in a second pass after the whole page is
    ingested (so children imported before parents still resolve)."""
    return {
        "company_id": cid,
        "source": "qbo",
        "qbo_id": obj["Id"],
        "id": f"qbo-{cid[:8]}-account-{obj['Id']}",   # company-scoped, satisfies `id_uniq`
        "realm_id": realm_id,
        "code": obj.get("AcctNum") or "",
        "name": obj.get("Name") or obj.get("FullyQualifiedName") or "",
        "type": _ACCOUNT_TYPE_MAP.get(obj.get("AccountType") or "", "expense"),
        "subtype": obj.get("AccountSubType") or "",
        "active": bool(obj.get("Active", True)),
        "current_balance": round(float(obj.get("CurrentBalance") or 0), 2),
        "parent_qbo_id": (obj.get("ParentRef") or {}).get("value"),
        "qbo_full_path": obj.get("FullyQualifiedName") or "",
        "qbo_last_updated": (obj.get("MetaData") or {}).get("LastUpdatedTime"),
        "raw": obj,
        "created_at": now_iso(),
        "updated_at": now_iso(),
    }


def map_contact(cid: str, realm_id: str, obj: dict, kind: str) -> dict:
    """QBO Customer/Vendor → our contacts collection shape.
    `kind` is 'customer' or 'vendor'."""
    from contact_resolver import normalize_contact_name
    addr = obj.get("BillAddr") or obj.get("ShipAddr") or {}
    phone = (obj.get("PrimaryPhone") or {}).get("FreeFormNumber")
    email = (obj.get("PrimaryEmailAddr") or {}).get("Address")
    name = obj.get("DisplayName") or obj.get("CompanyName") or ""
    return {
        "company_id": cid,
        "source": "qbo",
        "qbo_id": obj["Id"],
        "qbo_type": kind,
        # Deterministic top-level `id` that satisfies the `id_uniq`
        # unique index on the contacts collection. Include `kind` in the
        # key because Customer #1 and Vendor #1 both come from QBO with
        # the same Id="1" and would otherwise collide.
        "id": f"qbo-{cid[:8]}-{kind}-{obj['Id']}",
        "realm_id": realm_id,
        "name": name,
        "normalized_name": normalize_contact_name(name),
        "type": kind,
        "email": email,
        "phone": phone,
        "address": " ".join(filter(None, [
            addr.get("Line1"), addr.get("City"),
            addr.get("CountrySubDivisionCode"), addr.get("PostalCode"),
        ])) or None,
        "active": bool(obj.get("Active", True)),
        "raw": obj,
        "created_at": now_iso(),
        "updated_at": now_iso(),
    }


def map_item(cid: str, realm_id: str, obj: dict) -> dict:
    inc = (obj.get("IncomeAccountRef") or {}).get("value")
    exp = (obj.get("ExpenseAccountRef") or {}).get("value")
    return {
        "company_id": cid,
        "source": "qbo",
        "qbo_id": obj["Id"],
        "id": f"qbo-{cid[:8]}-item-{obj['Id']}",   # satisfy `id_uniq` on items
        "realm_id": realm_id,
        "name": obj.get("Name") or "",
        "description": obj.get("Description") or "",
        "price": round(float(obj.get("UnitPrice") or 0), 2),
        "cost": round(float(obj.get("PurchaseCost") or 0), 2),
        "usage": "both",
        "item_type": obj.get("Type") or "Service",
        "sku": obj.get("Sku") or "",
        "active": bool(obj.get("Active", True)),
        "income_account_qbo_id": inc,
        "expense_account_qbo_id": exp,
        "raw": obj,
        "created_at": now_iso(),
        "updated_at": now_iso(),
    }


# ------------------------------------------------------------------
# Upsert helpers — idempotent by (company_id, source, qbo_id)
# ------------------------------------------------------------------

async def upsert(coll: str, doc: dict) -> None:
    """Idempotent upsert keyed on the top-level `id` field. Uses `id`
    (not `qbo_id`) because that's the field with the unique index on
    `contacts` / `accounts` / etc. Any second migration for the same
    realm becomes a no-op update instead of a duplicate-key insert."""
    key = {"company_id": doc["company_id"], "id": doc["id"]}
    await db[coll].update_one(key, {"$set": doc}, upsert=True)


# ------------------------------------------------------------------
# Preview (count-only, cheap)
# ------------------------------------------------------------------

PREVIEW_ENTITIES = [
    "Account", "Customer", "Vendor", "Item",
    "Invoice", "Bill", "Payment", "BillPayment",
    "JournalEntry", "Deposit", "Transfer",
    "CreditMemo", "SalesReceipt", "RefundReceipt",
    "Purchase", "Attachable",
]


async def preview_counts(company_id: str) -> dict[str, int]:
    conn = await get_connection(company_id)
    if not conn:
        raise RuntimeError("QBO not connected")
    realm_id = conn["realm_id"]
    out: dict[str, int] = {}
    for e in PREVIEW_ENTITIES:
        try:
            out[e] = await query_count(company_id, realm_id, e)
        except Exception as ex:  # noqa: BLE001
            logger.warning("preview count failed for %s: %s", e, ex)
            out[e] = -1
    return out


# ------------------------------------------------------------------
# Migration worker (v1: Foundation entities — Account, Customer,
# Vendor, Item). Larger entities land in follow-ups; the framework
# below is entity-agnostic so adding them is a one-liner in _PIPELINE.
# ------------------------------------------------------------------

async def _run_entity(job_id: str, company_id: str, realm_id: str,
                      entity: str, mapper, target_coll: str) -> None:
    """Import all rows of `entity` from QBO into `target_coll`.

    Per-row exceptions are caught and stashed in `qbo_jobs.entity_errors`
    so a single malformed row (e.g. an Invoice with `TxnTaxDetail: null`
    that broke the mapper) can never abort the entire pipeline. This
    changed after "QBO 4 LLC" (Feb 2026) where one bad Invoice killed
    Invoices → Bills → Payments → JEs → all downstream entities. We
    keep at most 25 error samples per entity to bound the job doc size.
    """
    processed = 0
    failed = 0
    async for obj in query_all(company_id, realm_id, entity):
        try:
            doc = mapper(company_id, realm_id, obj)
            # Defensive: if a future edit accidentally turns a mapper
            # into `async def`, calling it synchronously returns an
            # un-awaited coroutine and `upsert(doc)` crashes on
            # `doc["company_id"]` with "'coroutine' object is not
            # subscriptable". Detect that and await it here so a partial
            # merge-conflict resolution can't silently break the pipeline
            # (this exact bug hit QBO 1 Inc in Feb 2026).
            if inspect.iscoroutine(doc):
                logger.error(
                    "QBO mapper for %s returned a coroutine — mapper "
                    "should be sync. Awaiting defensively.", entity,
                )
                doc = await doc
            await upsert(target_coll, doc)
            processed += 1
        except Exception as e:  # noqa: BLE001
            failed += 1
            logger.warning(
                "QBO %s row failed for cid=%s qbo_id=%s: %s",
                entity, company_id, (obj or {}).get("Id"), e,
            )
            # Stash up to 25 error samples per entity for support triage.
            await db.qbo_jobs.update_one(
                {"job_id": job_id},
                {"$push": {
                    f"entity_errors.{entity}": {
                        "$each": [{
                            "qbo_id": (obj or {}).get("Id"),
                            "error_type": type(e).__name__,
                            "error": str(e)[:400],
                        }],
                        "$slice": -25,
                    }
                }},
            )
        if (processed + failed) % 25 == 0:
            await db.qbo_jobs.update_one(
                {"job_id": job_id},
                {"$set": {"entity": entity, "updated_at": now_iso()},
                 "$inc": {"processed": 25}},
            )
    # Flush tail counter + write final per-entity summary counts so the
    # diagnostics endpoint can show "imported N of M" without recounting.
    tail = (processed + failed) % 25
    update = {
        "$set": {
            "entity": entity,
            "updated_at": now_iso(),
            f"entity_summary.{entity}": {
                "processed": processed,
                "failed": failed,
            },
        },
    }
    if tail:
        update["$inc"] = {"processed": tail}
    await db.qbo_jobs.update_one({"job_id": job_id}, update)


_PIPELINE: list[tuple[str, callable, str]] = [
    # Foundation — MUST run first, transactional records reference these.
    ("Account",  map_account, "accounts"),
    ("Customer", lambda c, r, o: map_contact(c, r, o, "customer"), "contacts"),
    ("Vendor",   lambda c, r, o: map_contact(c, r, o, "vendor"),   "contacts"),
    ("Item",     map_item,    "items"),
    # Transactional — order doesn't matter for correctness, but we do
    # invoices/bills first (largest volume typically) so progress bars
    # feel snappier.
    ("Invoice",       lambda c, r, o: map_invoice(c, r, o),      "invoices"),
    ("Bill",          lambda c, r, o: map_bill(c, r, o),         "bills"),
    ("Payment",       lambda c, r, o: map_payment(c, r, o, "in"),  "payments"),
    ("BillPayment",   lambda c, r, o: map_payment(c, r, o, "out"), "payments"),
    ("JournalEntry",  lambda c, r, o: map_journal_entry(c, r, o), "journal_entries"),
    ("Deposit",       lambda c, r, o: map_generic_txn(c, r, o, "Deposit"),      "transactions"),
    ("Transfer",      lambda c, r, o: map_generic_txn(c, r, o, "Transfer"),     "transactions"),
    ("Purchase",      lambda c, r, o: map_generic_txn(c, r, o, "Purchase"),     "transactions"),
    ("SalesReceipt",  lambda c, r, o: map_generic_txn(c, r, o, "SalesReceipt"), "transactions"),
    ("RefundReceipt", lambda c, r, o: map_generic_txn(c, r, o, "RefundReceipt"),"transactions"),
    ("CreditMemo",    lambda c, r, o: map_generic_txn(c, r, o, "CreditMemo"),   "transactions"),
]


# ------------------------------------------------------------------
# Transactional mappers
# ------------------------------------------------------------------

def _map_lines(qbo_lines: list) -> list[dict]:
    """Flatten QBO SalesItemLineDetail / AccountBasedExpenseLineDetail
    into our unified {description, quantity, rate, amount} shape."""
    out = []
    for ln in qbo_lines or []:
        if ln.get("DetailType") in ("SubTotalLineDetail", None):
            continue
        detail = (ln.get("SalesItemLineDetail")
                  or ln.get("AccountBasedExpenseLineDetail")
                  or ln.get("ItemBasedExpenseLineDetail")
                  or {})
        item_ref = (detail.get("ItemRef") or {})
        acct_ref = (detail.get("AccountRef") or {})
        qty = float(detail.get("Qty") or 1) or 1
        rate = float(detail.get("UnitPrice") or 0)
        amt = float(ln.get("Amount") or 0)
        if not rate and qty:
            rate = round(amt / qty, 4)
        out.append({
            "description": ln.get("Description") or "",
            "quantity": qty,
            "rate": rate,
            "amount": round(amt, 2),
            "item_qbo_id": item_ref.get("value"),
            "item_name": item_ref.get("name"),
            "account_qbo_id": acct_ref.get("value"),
            "account_name": acct_ref.get("name"),
        })
    return out


def map_invoice(cid: str, realm_id: str, obj: dict) -> dict:
    cust = obj.get("CustomerRef") or {}
    # QBO returns TxnTaxDetail as an explicit `null` on non-taxable
    # invoices, so `obj.get("TxnTaxDetail", {})` returns None (not {})
    # and .get() blows up with AttributeError. Use `or {}` fallback.
    tax_detail = obj.get("TxnTaxDetail") or {}
    total = float(obj.get("TotalAmt") or 0)
    tax = float(tax_detail.get("TotalTax") or 0)
    balance = float(obj.get("Balance") or 0)
    return {
        "company_id": cid, "source": "qbo",
        "qbo_id": obj["Id"], "id": f"qbo-{cid[:8]}-invoice-{obj['Id']}",
        "realm_id": realm_id,
        "number": obj.get("DocNumber") or f"INV-{obj['Id']}",
        "contact_qbo_id": cust.get("value"),
        "contact_name": cust.get("name") or "",
        "issue_date": obj.get("TxnDate") or "",
        "due_date": obj.get("DueDate") or "",
        "line_items": _map_lines(obj.get("Line") or []),
        "subtotal": round(total - tax, 2),
        "tax": round(tax, 2),
        "total": round(total, 2),
        "balance": round(balance, 2),
        "status": "paid" if balance == 0 else "sent",
        "currency": (obj.get("CurrencyRef") or {}).get("value", "USD"),
        "raw": obj,
        "created_at": now_iso(), "updated_at": now_iso(),
    }


def map_bill(cid: str, realm_id: str, obj: dict) -> dict:
    vend = obj.get("VendorRef") or {}
    return {
        "company_id": cid, "source": "qbo",
        "qbo_id": obj["Id"], "id": f"qbo-{cid[:8]}-bill-{obj['Id']}",
        "realm_id": realm_id,
        "number": obj.get("DocNumber") or f"BILL-{obj['Id']}",
        "contact_qbo_id": vend.get("value"),
        "contact_name": vend.get("name") or "",
        "issue_date": obj.get("TxnDate") or "",
        "due_date": obj.get("DueDate") or "",
        "line_items": _map_lines(obj.get("Line") or []),
        "total": round(float(obj.get("TotalAmt") or 0), 2),
        "balance": round(float(obj.get("Balance") or 0), 2),
        "status": "paid" if float(obj.get("Balance") or 0) == 0 else "open",
        "currency": (obj.get("CurrencyRef") or {}).get("value", "USD"),
        "raw": obj,
        "created_at": now_iso(), "updated_at": now_iso(),
    }


def map_payment(cid: str, realm_id: str, obj: dict, direction: str) -> dict:
    """QBO Payment (money in) or BillPayment (money out) → payments coll.
    `direction` is 'in' (customer→us) or 'out' (us→vendor)."""
    ref = (obj.get("CustomerRef") if direction == "in"
           else obj.get("VendorRef")) or {}
    method = (obj.get("PaymentMethodRef") or {}).get("name")
    # Flatten LinkedTxn across all Line entries into a single list of
    # {txn_type, txn_qbo_id} tuples. Rewritten as an explicit loop
    # because the previous nested-comprehension shadowed `l` in a way
    # that was correct-but-confusing and easy to break during edits.
    applied_to: list[dict] = []
    for line in (obj.get("Line") or []):
        for linked in (line.get("LinkedTxn") or []):
            applied_to.append({
                "txn_type": linked.get("TxnType"),
                "txn_qbo_id": linked.get("TxnId"),
            })
    deposit_ref = (obj.get("DepositToAccountRef")
                   or obj.get("APAccountRef") or {})
    return {
        "company_id": cid, "source": "qbo",
        "qbo_id": obj["Id"],
        "id": f"qbo-{cid[:8]}-payment-{direction}-{obj['Id']}",
        "realm_id": realm_id,
        "direction": direction,   # 'in' or 'out'
        "contact_qbo_id": ref.get("value"),
        "contact_name": ref.get("name") or "",
        "date": obj.get("TxnDate") or "",
        "amount": round(float(obj.get("TotalAmt") or 0), 2),
        "method": method or ("Check" if direction == "out" else "Cash"),
        "reference": obj.get("PaymentRefNum") or obj.get("DocNumber") or "",
        # Applied-to links — LinkedTxn tells us which invoices/bills
        # this payment settled.
        "applied_to": applied_to,
        "deposit_account_qbo_id": deposit_ref.get("value"),
        "raw": obj,
        "created_at": now_iso(), "updated_at": now_iso(),
    }


def map_journal_entry(cid: str, realm_id: str, obj: dict) -> dict:
    lines = []
    for ln in obj.get("Line") or []:
        d = ln.get("JournalEntryLineDetail") or {}
        acct = (d.get("AccountRef") or {})
        lines.append({
            "account_qbo_id": acct.get("value"),
            "account_name": acct.get("name") or "",
            "debit": round(float(ln.get("Amount") or 0), 2)
                     if d.get("PostingType") == "Debit" else 0.0,
            "credit": round(float(ln.get("Amount") or 0), 2)
                      if d.get("PostingType") == "Credit" else 0.0,
            "description": ln.get("Description") or "",
        })
    return {
        "company_id": cid, "source": "qbo",
        "qbo_id": obj["Id"], "id": f"qbo-{cid[:8]}-je-{obj['Id']}",
        "realm_id": realm_id,
        "number": obj.get("DocNumber") or f"JE-{obj['Id']}",
        "date": obj.get("TxnDate") or "",
        "memo": obj.get("PrivateNote") or "",
        "lines": lines,
        "total_debit": round(sum(l["debit"] for l in lines), 2),
        "total_credit": round(sum(l["credit"] for l in lines), 2),
        "raw": obj,
        "created_at": now_iso(), "updated_at": now_iso(),
    }


def map_generic_txn(cid: str, realm_id: str, obj: dict, txn_type: str) -> dict:
    """Deposit / Transfer / Purchase / SalesReceipt / RefundReceipt /
    CreditMemo — normalized into the shared `transactions` collection
    with a `txn_type` discriminator. Preserves the raw QBO doc so we
    can build type-specific detail views without re-fetching."""
    ref = (obj.get("CustomerRef") or obj.get("VendorRef")
           or obj.get("EntityRef") or {})
    return {
        "company_id": cid, "source": "qbo",
        "qbo_id": obj["Id"],
        "id": f"qbo-{cid[:8]}-{txn_type.lower()}-{obj['Id']}",
        "realm_id": realm_id,
        "txn_type": txn_type,
        "number": obj.get("DocNumber") or f"{txn_type}-{obj['Id']}",
        "date": obj.get("TxnDate") or "",
        "contact_qbo_id": ref.get("value"),
        "contact_name": ref.get("name") or "",
        "amount": round(float(obj.get("TotalAmt") or 0), 2),
        "memo": obj.get("PrivateNote") or "",
        "line_items": _map_lines(obj.get("Line") or []),
        "raw": obj,
        "created_at": now_iso(), "updated_at": now_iso(),
    }


async def run_migration(job_id: str, company_id: str) -> None:
    """Background migration entry point. Updates the qbo_jobs doc as
    it progresses; the frontend polls that doc for status."""
    conn = await get_connection(company_id)
    if not conn:
        await db.qbo_jobs.update_one(
            {"job_id": job_id},
            {"$set": {"status": "failed", "error": "QBO not connected"}},
        )
        return
    realm_id = conn["realm_id"]
    try:
        for (entity, mapper, coll) in _PIPELINE:
            await db.qbo_jobs.update_one(
                {"job_id": job_id},
                {"$set": {"phase": "import", "entity": entity,
                          "status": "running", "updated_at": now_iso()}},
            )
            await _run_entity(job_id, company_id, realm_id, entity, mapper, coll)
        # Post-import: resolve payment→invoice/bill links from each
        # payment's `applied_to` array (QBO LinkedTxn data). This runs
        # AFTER Invoices/Bills are all imported so the qbo_id → local
        # id lookups succeed. Direct writes (no PATCH cascade) since
        # QBO already gave us the correct balance on each doc.
        linked = await resolve_payment_links(company_id)
        # Post-import: translate each QBO account's `parent_qbo_id` into
        # our internal `parent_account_id` so the CoA sidebar can render
        # nested trees. Also unflattens any pre-existing colon-joined
        # names (e.g. "Landscaping Services:Job Materials" → leaf
        # "Job Materials" with parent link) — this covers older
        # migrations that ran before the mapper was fixed.
        parents_linked = await resolve_account_parents(company_id)
        # Post-import: promote each transaction's line-item AccountRef
        # to a top-level `category_account_id` so the Transactions UI
        # doesn't show "pick a category" for imports QBO already
        # classified. Must run AFTER Account import (needs qbo_id →
        # local id lookups).
        categorized = await resolve_transaction_categories(company_id)
        # Post-import: auto-build the Plaid PFC → account map so Plaid
        # transactions land on QBO accounts (not our seeded ones) from
        # day one. AI does a best-effort pass at medium+ confidence.
        # Wrapped in try/except so an LLM hiccup can't fail the whole
        # migration — user can always click "Build with AI" later on
        # the settings page. QBO 15 LLC (Feb 2026) got 58/127 mapped
        # in the first auto-run.
        pfc_mapped = 0
        try:
            from pfc_ai_builder import plan_pfc_map, apply_pfc_map
            # Claude Sonnet is non-deterministic — a single pass on the
            # same COA typically maps 60-75% of PFCs at medium+
            # confidence; a second pass fills in the rows Claude was
            # uncertain about the first time. Two passes closes the
            # gap between the initial auto-run and what the user
            # would get by clicking "Build with AI" once manually.
            # We keep the HIGHEST-confidence proposal per PFC across
            # runs — a "high" mapping never gets overwritten by a
            # later "low" one.
            rank = {"high": 3, "medium": 2, "low": 1, "none": 0}
            best: dict[str, dict] = {}
            for _ in range(2):
                plan = await plan_pfc_map(company_id)
                for p in plan.get("proposals") or []:
                    key = p.get("pfc_detailed") or ""
                    if not key:
                        continue
                    prev = best.get(key)
                    if (not prev
                            or rank.get(p.get("confidence"), 0)
                            > rank.get(prev.get("confidence"), 0)):
                        best[key] = p
            r = await apply_pfc_map(company_id, list(best.values()),
                                    min_confidence="medium")
            pfc_mapped = r.get("written", 0)
        except Exception as e:  # noqa: BLE001
            logger.warning("PFC auto-map failed for %s: %s — user can "
                           "run manually on the settings page.",
                           company_id, e)
        await db.qbo_jobs.update_one(
            {"job_id": job_id},
            {"$set": {"status": "done", "phase": "done",
                      "finished_at": now_iso(), "percent": 100,
                      "payments_linked": linked,
                      "parents_linked": parents_linked,
                      "transactions_categorized": categorized,
                      "pfc_mapped": pfc_mapped}},
        )
    except Exception as e:  # noqa: BLE001
        logger.exception("QBO migration failed for %s", company_id)
        await db.qbo_jobs.update_one(
            {"job_id": job_id},
            {"$set": {"status": "failed", "error": str(e),
                      "finished_at": now_iso()}},
        )


async def resolve_payment_links(company_id: str) -> int:
    """Populate `linked_invoice_id` / `linked_bill_id` on QBO-imported
    payments by resolving each `applied_to[i].txn_qbo_id` against our
    local invoices/bills collections. Idempotent — payments already
    linked keep their values; payments with no applied_to entries are
    skipped. Returns the number of payments updated.

    Direct write (bypasses the PATCH cascade) — the mapped invoice/bill
    already carries QBO's authoritative `balance`, so re-applying the
    payment impact via `_reverse_payment_impact` would double-count.
    """
    # Prefetch qbo_id → local id maps to avoid N+1 lookups.
    inv_map = {}
    async for inv in db.invoices.find(
        {"company_id": company_id, "source": "qbo"},
        {"id": 1, "qbo_id": 1},
    ):
        if inv.get("qbo_id"):
            inv_map[str(inv["qbo_id"])] = inv["id"]

    bill_map = {}
    async for b in db.bills.find(
        {"company_id": company_id, "source": "qbo"},
        {"id": 1, "qbo_id": 1},
    ):
        if b.get("qbo_id"):
            bill_map[str(b["qbo_id"])] = b["id"]

    updated = 0
    async for pay in db.payments.find(
        {"company_id": company_id, "source": "qbo"},
        {"id": 1, "applied_to": 1,
         "linked_invoice_id": 1, "linked_bill_id": 1},
    ):
        applied = pay.get("applied_to") or []
        if not applied:
            continue
        set_fields = {}
        for link in applied:
            ttype = link.get("txn_type")
            tqid = link.get("txn_qbo_id")
            if not tqid:
                continue
            tqid = str(tqid)
            if ttype == "Invoice" and not pay.get("linked_invoice_id") \
                    and "linked_invoice_id" not in set_fields \
                    and tqid in inv_map:
                set_fields["linked_invoice_id"] = inv_map[tqid]
            elif ttype == "Bill" and not pay.get("linked_bill_id") \
                    and "linked_bill_id" not in set_fields \
                    and tqid in bill_map:
                set_fields["linked_bill_id"] = bill_map[tqid]
        if set_fields:
            set_fields["updated_at"] = now_iso()
            await db.payments.update_one(
                {"id": pay["id"]}, {"$set": set_fields},
            )
            updated += 1
    return updated

async def resolve_transaction_categories(company_id: str) -> int:
    """Translate each QBO-imported transaction's line-item AccountRef
    into a top-level `category_account_id` so the Transactions UI can
    render the category instead of showing "pick a category". Also
    populates the display fields (`category_account_code`,
    `category_account_name`) so filters/exports work.

    Resolution order per line:
      1. Direct `account_qbo_id` (AccountBasedExpenseLineDetail) — the
         common case for Purchases, Deposits, Transfers.
      2. Fallback via `item_qbo_id` — SalesItemLineDetail /
         ItemBasedExpenseLineDetail use an Item reference; the account
         lives on the Item (`income_account_qbo_id` for inbound txn
         types, `expense_account_qbo_id` for outbound).

    Skips transactions that already have a category assigned (idempotent).
    Returns the number of transactions updated.
    """
    # qbo_id -> local account for THIS company (one-shot lookup).
    qbo_to_local: dict[str, dict] = {}
    async for a in db.accounts.find(
        {"company_id": company_id, "source": "qbo"},
        {"id": 1, "qbo_id": 1, "code": 1, "name": 1, "_id": 0},
    ):
        if a.get("qbo_id"):
            qbo_to_local[str(a["qbo_id"])] = a

    if not qbo_to_local:
        return 0

    # qbo_id -> item's income+expense qbo account ids, so we can resolve
    # item-based lines without a per-line DB round-trip.
    item_to_accts: dict[str, tuple[str, str]] = {}
    async for it in db.items.find(
        {"company_id": company_id, "source": "qbo"},
        {"qbo_id": 1, "income_account_qbo_id": 1,
         "expense_account_qbo_id": 1, "_id": 0},
    ):
        if it.get("qbo_id"):
            item_to_accts[str(it["qbo_id"])] = (
                str(it.get("income_account_qbo_id") or ""),
                str(it.get("expense_account_qbo_id") or ""),
            )

    # Inbound QBO txn types post to the item's income account; outbound
    # post to the expense account. Everything else defaults to income
    # (safest — the fallback resolver still lets user re-pick).
    _OUTBOUND = {"Purchase", "Bill", "BillPayment", "RefundReceipt",
                 "VendorCredit"}

    updated = 0
    async for t in db.transactions.find(
        {"company_id": company_id, "source": "qbo",
         "$or": [{"category_account_id": {"$in": [None, ""]}},
                 {"category_account_id": {"$exists": False}}]},
        {"id": 1, "line_items": 1, "txn_type": 1},
    ):
        txn_type = t.get("txn_type") or ""
        outbound = txn_type in _OUTBOUND
        picked = None
        for ln in t.get("line_items") or []:
            # 1. Direct account ref
            aqid = ln.get("account_qbo_id")
            if aqid:
                local = qbo_to_local.get(str(aqid))
                if local:
                    picked = local
                    break
            # 2. Item ref → item's income/expense account
            iqid = ln.get("item_qbo_id")
            if iqid:
                inc, exp = item_to_accts.get(str(iqid), ("", ""))
                candidate_qid = exp if outbound else inc
                # If the "correct-direction" account is missing, fall
                # back to the other side (some QBO items only carry
                # one of the two — e.g. inventory items skip the
                # income account on service-only companies).
                if not candidate_qid:
                    candidate_qid = inc or exp
                if candidate_qid:
                    local = qbo_to_local.get(candidate_qid)
                    if local:
                        picked = local
                        break
        if not picked:
            continue
        await db.transactions.update_one(
            {"id": t["id"]},
            {"$set": {
                "category_account_id": picked["id"],
                "category_account_code": picked.get("code") or "",
                "category_account_name": picked.get("name") or "",
                "updated_at": now_iso(),
            }},
        )
        updated += 1
    return updated




async def resolve_account_parents(company_id: str) -> int:
    """Second-pass QBO account normalization. Two jobs:

    1. Translate `parent_qbo_id` → local `parent_account_id` so the CoA
       renders a proper nested tree (Landscaping Services > Job
       Materials > Decks and Patios).
    2. Unflatten legacy colon-joined names (e.g. name =
       `Job Expenses:Cost of Labor:Installation`) that pre-date the
       leaf-only mapper — reset name to the last segment. Only touches
       QBO accounts whose current `name` still contains a `:`.

    Idempotent: rerunning has no effect once every account has a
    correct `parent_account_id` and no leftover colon-name. Returns the
    number of accounts updated. Safe on companies with a partial QBO
    footprint — accounts without a parent_qbo_id are skipped.
    """
    # Build qbo_id -> local id map for THIS company's QBO accounts.
    qbo_to_local: dict[str, str] = {}
    async for a in db.accounts.find(
        {"company_id": company_id, "source": "qbo"},
        {"id": 1, "qbo_id": 1},
    ):
        if a.get("qbo_id"):
            qbo_to_local[str(a["qbo_id"])] = a["id"]

    updated = 0
    async for a in db.accounts.find(
        {"company_id": company_id, "source": "qbo"},
        {"id": 1, "name": 1, "parent_qbo_id": 1, "parent_account_id": 1,
         "qbo_full_path": 1},
    ):
        set_fields: dict = {}

        # 1) Parent link
        pqid = a.get("parent_qbo_id")
        if pqid and not a.get("parent_account_id"):
            local_pid = qbo_to_local.get(str(pqid))
            if local_pid:
                set_fields["parent_account_id"] = local_pid

        # 2) Unflatten colon-joined names
        nm = a.get("name") or ""
        if ":" in nm:
            leaf = nm.rsplit(":", 1)[-1].strip()
            if leaf and leaf != nm:
                set_fields["name"] = leaf
                if not a.get("qbo_full_path"):
                    set_fields["qbo_full_path"] = nm

        if set_fields:
            set_fields["updated_at"] = now_iso()
            await db.accounts.update_one(
                {"id": a["id"]}, {"$set": set_fields},
            )
            updated += 1
    return updated
