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
        "id": f"qbo-{cid[:8]}-account-{obj['Id']}",   # company-scoped, satisfies `id_uniq`
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


# ---- Transactional mappers -----------------------------------------
# Every transactional doc carries the raw QBO payload under `raw` so
# downstream users can rebuild schemas without a second migration.
# Money values are rounded to 2dp at map-time. Contact + Account refs
# preserve the QBO ID; we resolve to our internal IDs lazily via helper.

async def _resolve_contact_id(cid: str, qbo_ref_id: str | None) -> str | None:
    if not qbo_ref_id:
        return None
    doc = await db.contacts.find_one(
        {"company_id": cid, "source": "qbo", "qbo_id": str(qbo_ref_id)},
        projection={"id": 1, "_id": 0},
    )
    return doc.get("id") if doc else None


async def _resolve_account_id(cid: str, qbo_ref_id: str | None) -> str | None:
    if not qbo_ref_id:
        return None
    doc = await db.accounts.find_one(
        {"company_id": cid, "source": "qbo", "qbo_id": str(qbo_ref_id)},
        projection={"id": 1, "_id": 0},
    )
    return doc.get("id") if doc else None


def _lines_from_qbo(obj: dict) -> list[dict]:
    """Flatten QBO SalesItemLineDetail / AccountBasedExpenseLineDetail
    into our line_items shape: {description, quantity, rate, amount,
    item_qbo_id, account_qbo_id}. QBO returns SubTotal/DiscountLine rows
    we deliberately skip."""
    out: list[dict] = []
    for ln in (obj.get("Line") or []):
        dtype = ln.get("DetailType") or ""
        if dtype in ("SubTotalLineDetail", "DiscountLineDetail"):
            continue
        detail = (ln.get("SalesItemLineDetail")
                  or ln.get("AccountBasedExpenseLineDetail")
                  or ln.get("ItemBasedExpenseLineDetail")
                  or {})
        qty = float(detail.get("Qty") or 1)
        rate = float(detail.get("UnitPrice") or 0)
        amt = float(ln.get("Amount") or 0)
        out.append({
            "description": ln.get("Description") or "",
            "quantity": qty or 1,
            "rate": round(rate or (amt / (qty or 1)), 2),
            "amount": round(amt, 2),
            "item_qbo_id": (detail.get("ItemRef") or {}).get("value"),
            "account_qbo_id": (detail.get("AccountRef") or {}).get("value"),
            "tax_code_qbo_id": (detail.get("TaxCodeRef") or {}).get("value"),
        })
    return out


async def map_invoice(cid: str, realm_id: str, obj: dict) -> dict:
    return {
        "company_id": cid, "source": "qbo", "qbo_id": obj["Id"],
        "realm_id": realm_id,
        "number": obj.get("DocNumber") or f"QBO-INV-{obj['Id']}",
        "contact_id": await _resolve_contact_id(cid, (obj.get("CustomerRef") or {}).get("value")),
        "contact_name": (obj.get("CustomerRef") or {}).get("name") or "",
        "issue_date": obj.get("TxnDate"),
        "due_date": obj.get("DueDate") or obj.get("TxnDate"),
        "line_items": _lines_from_qbo(obj),
        "subtotal": round(float(obj.get("TotalAmt", 0)) - float((obj.get("TxnTaxDetail") or {}).get("TotalTax", 0) or 0), 2),
        "tax": round(float((obj.get("TxnTaxDetail") or {}).get("TotalTax", 0) or 0), 2),
        "total": round(float(obj.get("TotalAmt") or 0), 2),
        "balance": round(float(obj.get("Balance") or 0), 2),
        "status": "paid" if float(obj.get("Balance") or 0) == 0 else "sent",
        "raw": obj, "created_at": now_iso(), "updated_at": now_iso(),
    }


async def map_bill(cid: str, realm_id: str, obj: dict) -> dict:
    return {
        "company_id": cid, "source": "qbo", "qbo_id": obj["Id"],
        "realm_id": realm_id,
        "number": obj.get("DocNumber") or f"QBO-BILL-{obj['Id']}",
        "contact_id": await _resolve_contact_id(cid, (obj.get("VendorRef") or {}).get("value")),
        "contact_name": (obj.get("VendorRef") or {}).get("name") or "",
        "issue_date": obj.get("TxnDate"),
        "due_date": obj.get("DueDate") or obj.get("TxnDate"),
        "line_items": _lines_from_qbo(obj),
        "total": round(float(obj.get("TotalAmt") or 0), 2),
        "balance": round(float(obj.get("Balance") or 0), 2),
        "status": "paid" if float(obj.get("Balance") or 0) == 0 else "open",
        "raw": obj, "created_at": now_iso(), "updated_at": now_iso(),
    }


async def map_payment(cid: str, realm_id: str, obj: dict, kind: str) -> dict:
    """Payment (received) OR BillPayment (made). `kind` distinguishes."""
    ref = "CustomerRef" if kind == "payment" else "VendorRef"
    return {
        "company_id": cid, "source": "qbo", "qbo_id": obj["Id"],
        "realm_id": realm_id, "kind": kind,
        "contact_id": await _resolve_contact_id(cid, (obj.get(ref) or {}).get("value")),
        "contact_name": (obj.get(ref) or {}).get("name") or "",
        "date": obj.get("TxnDate"),
        "amount": round(float(obj.get("TotalAmt") or 0), 2),
        "deposit_account_id": await _resolve_account_id(cid, (obj.get("DepositToAccountRef") or {}).get("value")),
        "payment_method": (obj.get("PaymentMethodRef") or {}).get("name") or "",
        "reference": obj.get("PaymentRefNum") or "",
        "applied_to": [{
            "target_qbo_id": (li.get("LinkedTxn") or [{}])[0].get("TxnId") if li.get("LinkedTxn") else None,
            "target_type": (li.get("LinkedTxn") or [{}])[0].get("TxnType") if li.get("LinkedTxn") else None,
            "amount": round(float(li.get("Amount") or 0), 2),
        } for li in (obj.get("Line") or [])],
        "raw": obj, "created_at": now_iso(), "updated_at": now_iso(),
    }


async def map_journal_entry(cid: str, realm_id: str, obj: dict) -> dict:
    lines = []
    for ln in (obj.get("Line") or []):
        d = ln.get("JournalEntryLineDetail") or {}
        posting = d.get("PostingType") or "Debit"
        amt = round(float(ln.get("Amount") or 0), 2)
        lines.append({
            "description": ln.get("Description") or "",
            "account_qbo_id": (d.get("AccountRef") or {}).get("value"),
            "account_id": await _resolve_account_id(cid, (d.get("AccountRef") or {}).get("value")),
            "debit": amt if posting == "Debit" else 0,
            "credit": amt if posting == "Credit" else 0,
            "contact_qbo_id": ((d.get("Entity") or {}).get("EntityRef") or {}).get("value"),
        })
    return {
        "company_id": cid, "source": "qbo", "qbo_id": obj["Id"],
        "realm_id": realm_id,
        "date": obj.get("TxnDate"),
        "number": obj.get("DocNumber") or f"QBO-JE-{obj['Id']}",
        "memo": obj.get("PrivateNote") or "",
        "lines": lines,
        "total_debit": round(sum(l["debit"] for l in lines), 2),
        "total_credit": round(sum(l["credit"] for l in lines), 2),
        "raw": obj, "created_at": now_iso(), "updated_at": now_iso(),
    }


async def map_txn_simple(cid: str, realm_id: str, obj: dict, kind: str) -> dict:
    """Deposit / Transfer / SalesReceipt / RefundReceipt / CreditMemo /
    Purchase → generic transactions row. Sign convention matches our
    ledger (charges negative, deposits positive)."""
    amt = round(float(obj.get("TotalAmt") or 0), 2)
    if kind in ("Purchase", "RefundReceipt"):
        amt = -abs(amt)
    contact_ref = (obj.get("CustomerRef") or obj.get("VendorRef") or obj.get("EntityRef") or {}).get("value")
    bank_ref = (obj.get("AccountRef") or obj.get("DepositToAccountRef") or {}).get("value")
    return {
        "company_id": cid, "source": "qbo", "qbo_id": obj["Id"],
        "realm_id": realm_id, "qbo_type": kind,
        "date": obj.get("TxnDate"),
        "description": obj.get("PrivateNote") or obj.get("Memo") or f"QBO {kind}",
        "amount": amt,
        "contact_id": await _resolve_contact_id(cid, contact_ref),
        "bank_account_id": await _resolve_account_id(cid, bank_ref),
        "raw": obj, "created_at": now_iso(), "updated_at": now_iso(),
    }


def map_attachable(cid: str, realm_id: str, obj: dict) -> dict:
    """Attachment metadata only — file download deferred (would need
    a signed URL exchange per file + storage backend). Users can still
    view every raw payload via the `raw` field."""
    return {
        "company_id": cid, "source": "qbo", "qbo_id": obj["Id"],
        "realm_id": realm_id,
        "file_name": obj.get("FileName") or "",
        "file_size": obj.get("Size") or 0,
        "content_type": obj.get("ContentType") or "",
        "note": obj.get("Note") or "",
        "attached_to": [{
            "entity_type": ref.get("EntityRef", {}).get("type"),
            "entity_qbo_id": ref.get("EntityRef", {}).get("value"),
        } for ref in (obj.get("AttachableRef") or [])],
        "raw": obj, "created_at": now_iso(), "updated_at": now_iso(),
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
    # Persist so the UI can rehydrate on next page load without re-
    # hitting QBO. Kept on the connection doc alongside the tokens.
    await db.qbo_connections.update_one(
        {"company_id": company_id},
        {"$set": {"preview_counts": out, "preview_at": now_iso()}},
    )
    return out


# ------------------------------------------------------------------
# Migration worker (v1: Foundation entities — Account, Customer,
# Vendor, Item). Larger entities land in follow-ups; the framework
# below is entity-agnostic so adding them is a one-liner in _PIPELINE.
# ------------------------------------------------------------------

async def _run_entity(job_id: str, company_id: str, realm_id: str,
                      entity: str, mapper, target_coll: str) -> None:
    """Iterate every QBO row for `entity`, run `mapper` (sync or async),
    upsert the mapped doc. Progress written every 25 rows so the
    frontend poller has smooth increments.

    Tracks successful upserts and per-row failures separately so a bad
    mapper can't silently show "283 processed" while the DB is empty.
    First 3 error messages per entity get echoed to the job doc for the
    UI to display; every failure hits the logger."""
    import inspect
    is_async = inspect.iscoroutinefunction(mapper)
    processed = 0
    ok_count = 0
    err_count = 0
    sample_errors: list[str] = []
    async for obj in query_all(company_id, realm_id, entity):
        try:
            doc = await mapper(company_id, realm_id, obj) if is_async \
                else mapper(company_id, realm_id, obj)
            # Detect the "sync lambda wrapping an async mapper" bug — if
            # a coroutine leaked out of a lambda wrapper we'd upsert a
            # coroutine object and everything would look fine. Await it.
            if inspect.iscoroutine(doc):
                doc = await doc
            await upsert(target_coll, doc)
            ok_count += 1
        except Exception as e:  # noqa: BLE001
            err_count += 1
            msg = f"{entity} row {obj.get('Id')}: {type(e).__name__}: {e}"
            logger.warning(msg)
            if len(sample_errors) < 3:
                sample_errors.append(msg[:200])
        processed += 1
        if processed % 25 == 0:
            await db.qbo_jobs.update_one(
                {"job_id": job_id},
                {"$inc": {"processed": 25, "imported": ok_count, "failed": err_count},
                 "$set": {"entity": entity, "updated_at": now_iso()}},
            )
            ok_count = 0; err_count = 0
    tail = processed % 25
    if tail:
        await db.qbo_jobs.update_one(
            {"job_id": job_id},
            {"$inc": {"processed": tail, "imported": ok_count, "failed": err_count},
             "$set": {"entity": entity, "updated_at": now_iso()}},
        )
    # Publish the first 3 errors per entity so the UI can show a hint.
    if sample_errors:
        await db.qbo_jobs.update_one(
            {"job_id": job_id},
            {"$push": {"entity_errors": {
                "entity": entity, "samples": sample_errors,
            }}},
        )


_PIPELINE: list[tuple[str, callable, str]] = [
    # Foundation — Accounts, Customers, Vendors, Items — must import
    # first so transactional refs (CustomerRef/AccountRef/ItemRef)
    # resolve against real local IDs.
    ("Account",       map_account, "accounts"),
    ("Customer",      lambda c, r, o: map_contact(c, r, o, "customer"), "contacts"),
    ("Vendor",        lambda c, r, o: map_contact(c, r, o, "vendor"),   "contacts"),
    ("Item",          map_item, "items"),
    # Transactional
    ("Invoice",       map_invoice, "invoices"),
    ("Bill",          map_bill,    "bills"),
    ("Payment",       lambda c, r, o: map_payment(c, r, o, "payment"),      "payments"),
    ("BillPayment",   lambda c, r, o: map_payment(c, r, o, "bill_payment"), "payments"),
    ("JournalEntry",  map_journal_entry, "journal_entries"),
    ("Deposit",       lambda c, r, o: map_txn_simple(c, r, o, "Deposit"),       "transactions"),
    ("Transfer",      lambda c, r, o: map_txn_simple(c, r, o, "Transfer"),      "transactions"),
    ("SalesReceipt",  lambda c, r, o: map_txn_simple(c, r, o, "SalesReceipt"),  "transactions"),
    ("RefundReceipt", lambda c, r, o: map_txn_simple(c, r, o, "RefundReceipt"), "transactions"),
    ("CreditMemo",    lambda c, r, o: map_txn_simple(c, r, o, "CreditMemo"),    "transactions"),
    ("Purchase",      lambda c, r, o: map_txn_simple(c, r, o, "Purchase"),      "transactions"),
    # Attachments — metadata only for v1 (file bytes deferred until we
    # wire an object-storage backend for the downloads).
    ("Attachable",    map_attachable, "qbo_attachments"),
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
        "subtotal": round(float(obj.get("TotalAmt") or 0)
                          - float(obj.get("TxnTaxDetail", {}).get("TotalTax") or 0), 2),
        "tax": round(float(obj.get("TxnTaxDetail", {}).get("TotalTax") or 0), 2),
        "total": round(float(obj.get("TotalAmt") or 0), 2),
        "balance": round(float(obj.get("Balance") or 0), 2),
        "status": "paid" if float(obj.get("Balance") or 0) == 0 else "sent",
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
        "applied_to": [
            {"txn_type": l.get("TxnType"), "txn_qbo_id": l.get("TxnId")}
            for l in (obj.get("Line") or [])
            for l in [ll for ll in (l.get("LinkedTxn") or [])]
        ],
        "deposit_account_qbo_id": ((obj.get("DepositToAccountRef")
                                    or obj.get("APAccountRef") or {}).get("value")),
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
