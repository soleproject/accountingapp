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
    """QBO Account → our accounts collection shape."""
    return {
        "company_id": cid,
        "source": "qbo",
        "qbo_id": obj["Id"],
        "realm_id": realm_id,
        "code": obj.get("AcctNum") or "",
        "name": obj.get("FullyQualifiedName") or obj.get("Name") or "",
        "type": _ACCOUNT_TYPE_MAP.get(obj.get("AccountType") or "", "expense"),
        "subtype": obj.get("AccountSubType") or "",
        "active": bool(obj.get("Active", True)),
        "current_balance": round(float(obj.get("CurrentBalance") or 0), 2),
        "parent_qbo_id": (obj.get("ParentRef") or {}).get("value"),
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
        "realm_id": realm_id,
        "name": name,
        # `normalized_name` matches the unique index on the contacts
        # collection — without it every QBO contact would collide on
        # `(company_id, null)` and only the first would insert.
        "normalized_name": normalize_contact_name(name),
        "type": kind,   # 'customer' or 'vendor'
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
    key = {"company_id": doc["company_id"], "source": "qbo",
           "qbo_id": doc["qbo_id"]}
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
    processed = 0
    async for obj in query_all(company_id, realm_id, entity):
        doc = mapper(company_id, realm_id, obj)
        await upsert(target_coll, doc)
        processed += 1
        if processed % 25 == 0:
            await db.qbo_jobs.update_one(
                {"job_id": job_id},
                {"$inc": {"processed": 25},
                 "$set": {"entity": entity, "updated_at": now_iso()}},
            )
    # Flush tail
    tail = processed % 25
    if tail:
        await db.qbo_jobs.update_one(
            {"job_id": job_id},
            {"$inc": {"processed": tail},
             "$set": {"entity": entity, "updated_at": now_iso()}},
        )


_PIPELINE: list[tuple[str, callable, str]] = [
    ("Account",  map_account, "accounts"),
    ("Customer", lambda c, r, o: map_contact(c, r, o, "customer"), "contacts"),
    ("Vendor",   lambda c, r, o: map_contact(c, r, o, "vendor"),   "contacts"),
    ("Item",     map_item,    "items"),
]


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
        await db.qbo_jobs.update_one(
            {"job_id": job_id},
            {"$set": {"status": "done", "phase": "done",
                      "finished_at": now_iso(), "percent": 100}},
        )
    except Exception as e:  # noqa: BLE001
        logger.exception("QBO migration failed for %s", company_id)
        await db.qbo_jobs.update_one(
            {"job_id": job_id},
            {"$set": {"status": "failed", "error": str(e),
                      "finished_at": now_iso()}},
        )
