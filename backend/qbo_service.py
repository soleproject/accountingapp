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

QBO_ENV = os.environ.get("QBO_ENV", "sandbox")  # legacy — sandbox creds
QBO_CLIENT_ID = os.environ.get("QBO_CLIENT_ID")
QBO_CLIENT_SECRET = os.environ.get("QBO_CLIENT_SECRET")
# Production credentials — separate Intuit app (Feb 2026 rollout).
# When a company toggles its `qbo_env` to "production", OAuth + API
# calls resolve against these instead of the sandbox pair above.
QBO_CLIENT_ID_PROD = os.environ.get("QBO_CLIENT_ID_PROD")
QBO_CLIENT_SECRET_PROD = os.environ.get("QBO_CLIENT_SECRET_PROD")
# Platform-wide default for BRAND-NEW companies. Existing companies
# keep whatever env is stamped on their record / their qbo_connection.
QBO_ENV_DEFAULT = os.environ.get("QBO_ENV_DEFAULT", "production").lower()
QBO_REDIRECT_URI = os.environ.get("QBO_REDIRECT_URI")
QBO_MINOR_VERSION = os.environ.get("QBO_MINOR_VERSION", "75")

QBO_APP_URL = os.environ.get("QBO_APP_URL", "https://app.smartbookssoftware.ai")


def _norm_env(env: str | None) -> str:
    """Coerce any env string to `sandbox` | `production`. Anything
    unrecognised falls back to the platform default (production)."""
    e = (env or "").strip().lower()
    if e in ("sandbox", "production"):
        return e
    return QBO_ENV_DEFAULT if QBO_ENV_DEFAULT in ("sandbox", "production") else "production"


def api_base_for(env: str | None) -> str:
    """Return the correct Intuit API base URL for the given env."""
    return ("https://sandbox-quickbooks.api.intuit.com/v3"
            if _norm_env(env) == "sandbox"
            else "https://quickbooks.api.intuit.com/v3")


def _creds_for(env: str | None) -> tuple[str | None, str | None]:
    """Return `(client_id, client_secret)` for the given env. Sandbox
    falls back to the legacy vars so nothing breaks for existing
    connections stamped `sandbox`."""
    if _norm_env(env) == "production":
        return QBO_CLIENT_ID_PROD, QBO_CLIENT_SECRET_PROD
    return QBO_CLIENT_ID, QBO_CLIENT_SECRET


# Legacy alias — kept only so imports elsewhere (`from qbo_service
# import API_BASE`) don't break. Actual routing uses api_base_for(env)
# via _api_base_for_company below. Do not rely on this for new code.
API_BASE = api_base_for(QBO_ENV_DEFAULT)

# Deploy canary — bumped every time the mapper contract changes. The
# diagnostics endpoint echoes this back so we can verify at a glance
# which version Railway is actually running (vs. what's in git). If a
# migration fails and this is NOT the string below, Railway is on stale
# code and the fix is not in production yet.
MAPPER_VERSION = "v4-2026-02-08-capital-Id-null-safe-per-row-isolation"


def _auth_client(redirect_uri: str | None = None,
                 env: str | None = None) -> AuthClient:
    """Build an Intuit AuthClient. `redirect_uri` defaults to the
    platform-wide `QBO_REDIRECT_URI` env for the flagship SmartBooks
    domain, but private-label deployments (Cypher Pro, Proactive
    Books, etc.) pass their own callback URL so the consent flow
    returns the user to the label domain they came from.

    `env` — "sandbox" | "production". Selects which Intuit app's
    client_id/secret to use, and which environment string to pass to
    the SDK (which internally picks the right token endpoint).

    Every URL passed here must ALSO be registered as a Redirect URI on
    the Intuit Developer app for the SELECTED ENV — Intuit does an
    exact-match check both on the outbound auth URL and the
    token-exchange call, per environment."""
    e = _norm_env(env)
    cid, csec = _creds_for(e)
    if not cid or not csec:
        # Fail loud here — otherwise the SDK builds a URL with
        # `client_id=None` and Intuit renders a generic "undefined
        # didn't connect" error page that gives zero indication of
        # the actual misconfiguration. This exception surfaces to
        # /qbo/oauth/start as a 500, at which point the frontend
        # toast tells the user exactly which env var is missing.
        env_label = e.upper()
        missing = []
        if not cid:
            missing.append(f"QBO_CLIENT_ID{'_PROD' if e == 'production' else ''}")
        if not csec:
            missing.append(f"QBO_CLIENT_SECRET{'_PROD' if e == 'production' else ''}")
        raise RuntimeError(
            f"QBO {env_label} credentials not configured — missing "
            f"env var(s): {', '.join(missing)}. Add them to the "
            f"backend deploy and restart."
        )
    return AuthClient(
        client_id=cid,
        client_secret=csec,
        redirect_uri=redirect_uri or QBO_REDIRECT_URI,
        environment=e,
    )


# ------------------------------------------------------------------
# OAuth: URL, callback exchange, refresh, revoke
# ------------------------------------------------------------------

def authorization_url(state: str, redirect_uri: str | None = None,
                      env: str | None = None) -> str:
    """Return the Intuit consent URL. `state` is a CSRF token bound to
    the caller's company_id, stored in db.qbo_oauth_states with a 10-min
    expiry and consumed exactly once on callback.

    `redirect_uri` overrides the default when a private-label domain
    kicks off the flow — pass the SAME value here that gets stored on
    the state record so `exchange_code` can send it back verbatim.

    `env` — the target QBO environment for THIS connection. Must be
    persisted on the state row and passed back into `exchange_code`
    so both legs of the OAuth dance hit the same Intuit app."""
    c = _auth_client(redirect_uri, env=env)
    return c.get_authorization_url([Scopes.ACCOUNTING], state_token=state)


async def exchange_code(code: str, realm_id: str,
                        redirect_uri: str | None = None,
                        env: str | None = None) -> dict[str, Any]:
    """Exchange an OAuth `code` for tokens. Wraps the sync SDK call in
    `run_in_executor` since it's blocking.

    `redirect_uri` MUST match the URI sent in the original
    authorization request — Intuit rejects the exchange otherwise
    with `invalid_grant`. Callers persist the URI on the oauth state
    record so this round-trips correctly for every private label.

    `env` MUST match the env used in `authorization_url` — sandbox
    codes cannot be exchanged on the production app and vice versa."""
    def _blocking() -> dict[str, Any]:
        c = _auth_client(redirect_uri, env=env)
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


async def _refresh(company_id: str, refresh_token: str,
                    env: str | None = None) -> dict[str, Any]:
    def _blocking() -> dict[str, Any]:
        c = _auth_client(env=env)
        c.refresh(refresh_token=refresh_token)
        return {
            "access_token": c.access_token,
            "refresh_token": c.refresh_token,
            "expires_in": c.expires_in or 3600,
        }
    return await asyncio.get_event_loop().run_in_executor(None, _blocking)


async def revoke(refresh_token: str, env: str | None = None) -> None:
    def _blocking():
        c = _auth_client(env=env)
        try:
            c.revoke(token=refresh_token)
        except Exception as e:  # noqa: BLE001
            logger.warning("QBO revoke failed: %s", e)
    await asyncio.get_event_loop().run_in_executor(None, _blocking)


# ------------------------------------------------------------------
# Connection persistence
# ------------------------------------------------------------------

async def save_connection(company_id: str, realm_id: str, tokens: dict,
                          env: str | None = None) -> None:
    """Persist a QBO connection. `env` stamps the row so every future
    refresh/API call resolves against the same Intuit app the token
    was minted on. Existing sandbox connections keep their env after
    the Feb 2026 backfill; new prod connections stamp "production"."""
    now = datetime.now(timezone.utc)
    resolved_env = _norm_env(env)
    doc = {
        "company_id": company_id,
        "realm_id": realm_id,
        "environment": resolved_env,
        "env": resolved_env,
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


def env_from_connection(conn: Optional[dict]) -> str:
    """Extract the env from a connection doc, defaulting to sandbox
    for any legacy row that predates the Feb 2026 dual-env rollout
    (so those rows keep hitting the sandbox API — see the startup
    backfill in server.py)."""
    if not conn:
        return QBO_ENV_DEFAULT if QBO_ENV_DEFAULT in ("sandbox", "production") else "production"
    return _norm_env(conn.get("env") or conn.get("environment") or "sandbox")


async def _api_base_for_company(company_id: str) -> str:
    """Look up the connection's env and return the matching API base."""
    conn = await get_connection(company_id)
    return api_base_for(env_from_connection(conn))


async def get_access_token(company_id: str) -> str:
    """Return a valid access token, refreshing if within a 2-min expiry
    window. Serialized per-company. Uses the env stamped on the
    connection row so sandbox tokens refresh against the sandbox app
    even after the platform's default flips to production."""
    async with _lock_for(company_id):
        conn = await get_connection(company_id)
        if not conn or conn.get("status") != "connected":
            raise RuntimeError("QBO not connected")
        exp = datetime.fromisoformat(conn["access_expires_at"])
        if exp > datetime.now(timezone.utc) + timedelta(minutes=2):
            return decrypt(conn["access_token_enc"])
        # Refresh against the SAME env the connection was minted on.
        conn_env = env_from_connection(conn)
        new = await _refresh(company_id, decrypt(conn["refresh_token_enc"]),
                             env=conn_env)
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
    base = await _api_base_for_company(company_id)
    async with httpx.AsyncClient(timeout=60) as client:
        for attempt in range(6):
            async with _gate:
                r = await client.get(
                    f"{base}{path}",
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
    ingested (so children imported before parents still resolve).

    `detail_type` is inferred from name+subtype using the same Wave-style
    heuristic the CSV import uses — QBO's `AccountSubType` vocabulary
    ("CashOnHand", "AccountsReceivable", "Inventory", "CreditCard",
    "FixedAsset", "Prepayments", etc.) doesn't line up 1:1 with our
    frontend's DETAIL_SECTIONS_BY_TYPE keys, so name-based inference
    gives us cleaner results than a verbatim copy. Ensures QBO-imported
    companies land with proper GAAP sub-section grouping instead of the
    "89 accounts missing a sub-type" amber banner.
    """
    from routes.accounts import _infer_detail_type
    name = obj.get("Name") or obj.get("FullyQualifiedName") or ""
    acct_type = _ACCOUNT_TYPE_MAP.get(obj.get("AccountType") or "", "expense")
    subtype = obj.get("AccountSubType") or ""
    return {
        "company_id": cid,
        "source": "qbo",
        "qbo_id": obj["Id"],
        "id": f"qbo-{cid[:8]}-account-{obj['Id']}",   # company-scoped, satisfies `id_uniq`
        "realm_id": realm_id,
        "code": obj.get("AcctNum") or "",
        "name": name,
        "type": acct_type,
        "subtype": subtype,
        "detail_type": _infer_detail_type(acct_type, name, subtype),
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
    asset = (obj.get("AssetAccountRef") or {}).get("value")
    # Inventory-specific fields. QBO only populates these when the
    # item's Type is "Inventory" — service/non-inventory items leave
    # them undefined. We store the raw values so the migration can
    # post an opening-inventory JE (see qbo_service.run_migration).
    qbo_type_raw = (obj.get("Type") or "Service")
    qbo_type_lower = qbo_type_raw.lower()
    is_inventory = qbo_type_lower == "inventory"
    qty_on_hand = float(obj.get("QtyOnHand") or 0)
    # App-native `type` field (used by the frontend Items page + the
    # local inventory tables) uses lowercase values: 'service' /
    # 'inventory' / 'product' (for non-inventory physical goods).
    # QBO's Type enum maps: Inventory→inventory, NonInventory→product,
    # Service→service, Group/Bundle/Category→service (closest fit).
    native_type = ("inventory" if is_inventory
                    else "product" if qbo_type_lower == "noninventory"
                    else "service")
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
        # Both fields kept — `type` for the app-native UI/services,
        # `item_type` preserves QBO's original enum so we can round-
        # trip an item back to QBO with the correct Type value.
        "type": native_type,
        "item_type": qbo_type_raw,
        "sku": obj.get("Sku") or "",
        "active": bool(obj.get("Active", True)),
        "income_account_qbo_id": inc,
        "expense_account_qbo_id": exp,
        # Inventory tracking — only meaningful for Type=Inventory rows
        # but stored on every row so downstream code doesn't have to
        # special-case shape.
        "track_qty_on_hand": bool(obj.get("TrackQtyOnHand", is_inventory)),
        "qty_on_hand": qty_on_hand,
        # App-native alias — Items.jsx and inventory_service.py both
        # read `quantity_on_hand`. Keep both stamped so a single
        # renamer sweep isn't needed later.
        "quantity_on_hand": qty_on_hand,
        "reorder_point": float(obj.get("ReorderPoint") or 0),
        "inv_start_date": obj.get("InvStartDate") or None,
        "asset_account_qbo_id": asset,
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
    "Purchase",
    # New Feb 20, 2026 — surfaces inventory-adjustment volume in the
    # preview scope tile grid so CPAs know upfront whether inventory
    # history is part of the migration. We don't pull adjustments
    # yet, but the count itself is diagnostic (a big number means
    # "review your inventory strategy before migrating").
    "InventoryAdjustment",
    "Attachable",
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
# Migration worker
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
    # QBO uses different fields depending on direction and pay-type:
    #   Payment (in)  → `DepositToAccountRef` (bank or Undeposited Funds)
    #   BillPayment (out, check)       → `CheckPayment.BankAccountRef`
    #   BillPayment (out, credit-card) → `CreditCardPayment.CCAccountRef`
    # Fall through all three so the local `deposit_account_qbo_id` is
    # populated for every payment we import — the reports layer relies
    # on it to post the cash-side movement to `_signed_balances`.
    deposit_ref = obj.get("DepositToAccountRef") or {}
    if not deposit_ref.get("value"):
        cp = obj.get("CheckPayment") or {}
        cc = obj.get("CreditCardPayment") or {}
        deposit_ref = (cp.get("BankAccountRef")
                       or cc.get("CCAccountRef")
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


def map_inventory_adjustment(cid: str, realm_id: str, obj: dict) -> dict:
    """Shape a QBO `InventoryAdjustment` into a local `journal_entries`
    row so the audit trail lives alongside other JEs and rolls up into
    the same reports.

    QBO's shape:
      obj["AdjustAccountRef"]     — usually `5300 Inventory Shrinkage`
                                     or `5900 Other Expenses`; this
                                     account absorbs the P&L / equity
                                     side of the adjustment.
      obj["Line"][i]              — one line per item adjusted, with
                                     `ItemAdjustmentLineDetail.QtyDiff`
                                     (positive = increase on-hand,
                                     negative = decrease) and
                                     `ItemRef`. QBO does NOT include
                                     the cost — we compute value at
                                     import time using the item's
                                     `cost` field (already migrated).

    Ledger convention:
      QtyDiff × item.cost = valuation delta.
        Positive delta  → Dr 1300 Inventory Asset / Cr AdjustAccount
        Negative delta  → Cr 1300 Inventory Asset / Dr AdjustAccount
    """
    lines_raw = obj.get("Line") or []
    line_items: list[dict] = []
    net_value = 0.0
    for ln in lines_raw:
        d = ln.get("ItemAdjustmentLineDetail") or {}
        item_ref = (d.get("ItemRef") or {})
        qty_diff = float(d.get("QtyDiff") or 0)
        line_items.append({
            "item_qbo_id": item_ref.get("value"),
            "item_name": item_ref.get("name") or "",
            "qty_diff": qty_diff,
            "description": ln.get("Description") or "",
        })
        # `net_value` is computed downstream once we can resolve
        # item cost from the local items collection — here we just
        # preserve QBO's raw shape.
    adjust_ref = (obj.get("AdjustAccountRef") or {})
    return {
        "company_id": cid, "source": "qbo_inv_adj",
        "qbo_id": obj["Id"], "id": f"qbo-{cid[:8]}-invadj-{obj['Id']}",
        "realm_id": realm_id,
        "number": obj.get("DocNumber") or f"INVADJ-{obj['Id']}",
        "date": obj.get("TxnDate") or "",
        "memo": obj.get("PrivateNote") or "",
        # We store the raw line shape + a placeholder empty `lines`
        # array — the pull step (which has access to the items
        # collection) is responsible for computing the priced
        # debit/credit legs and writing them into `lines`.
        "inventory_adjustment_lines": line_items,
        "adjust_account_qbo_id": adjust_ref.get("value"),
        "adjust_account_name": adjust_ref.get("name") or "",
        "lines": [],  # populated by pull step once cost is resolved
        "total_debit": 0.0, "total_credit": 0.0,
        "raw": obj,
        "created_at": now_iso(), "updated_at": now_iso(),
    }




# Direction convention: positive `amount` = money INTO the bank/asset,
# negative = money OUT. QBO returns TotalAmt as a magnitude, so we
# sign it here based on the txn_type. Kept as a module-level constant
# so the backfill resolver can reuse the exact same rules.
_OUTFLOW_TXN_TYPES = {"Purchase", "RefundReceipt", "CreditMemo"}
_INFLOW_TXN_TYPES = {"Deposit", "SalesReceipt"}
# Transfer is signless at the top level — it's a wash between two
# asset accounts; the debit/credit legs carry the direction. Leave
# `amount` positive and expose direction='transfer' so the UI can
# render an appropriate icon.


def _signed_amount(txn_type: str, magnitude: float) -> float:
    if txn_type in _OUTFLOW_TXN_TYPES:
        return -abs(magnitude)
    return abs(magnitude)


def _direction_for(txn_type: str) -> str:
    if txn_type in _OUTFLOW_TXN_TYPES:
        return "out"
    if txn_type in _INFLOW_TXN_TYPES:
        return "in"
    return "transfer"


def _bank_account_qbo_id(obj: dict, txn_type: str) -> str | None:
    """Extract QBO's bank/asset account id from the transaction based
    on `txn_type`. Different QBO doc shapes stash the payment source
    under different keys:

      Purchase        → `AccountRef` (top-level bank/CC/asset)
      Deposit         → `DepositToAccountRef` (destination bank)
      SalesReceipt    → `DepositToAccountRef` (destination bank)
      RefundReceipt   → `DepositToAccountRef` (source bank)
      Transfer        → `FromAccountRef` (outbound leg)
      CreditMemo      → `ARAccountRef` (AR side)
    """
    key = {
        "Purchase":       "AccountRef",
        "Deposit":        "DepositToAccountRef",
        "SalesReceipt":   "DepositToAccountRef",
        "RefundReceipt":  "DepositToAccountRef",
        "Transfer":       "FromAccountRef",
        "CreditMemo":     "ARAccountRef",
    }.get(txn_type)
    if not key:
        return None
    ref = obj.get(key) or {}
    return ref.get("value") or None


def map_generic_txn(cid: str, realm_id: str, obj: dict, txn_type: str) -> dict:
    """Deposit / Transfer / Purchase / SalesReceipt / RefundReceipt /
    CreditMemo — normalized into the shared `transactions` collection
    with a `txn_type` discriminator. Preserves the raw QBO doc so we
    can build type-specific detail views without re-fetching."""
    ref = (obj.get("CustomerRef") or obj.get("VendorRef")
           or obj.get("EntityRef") or {})
    magnitude = round(float(obj.get("TotalAmt") or 0), 2)
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
        "amount": _signed_amount(txn_type, magnitude),
        "direction": _direction_for(txn_type),
        # QBO id of the bank/asset account this transaction moved money
        # in or out of. Translated to a local `bank_account_id` by
        # `resolve_transaction_banks` post-migration (once Account
        # entities are in the DB).
        "bank_account_qbo_id": _bank_account_qbo_id(obj, txn_type),
        # QBO transactions are already committed/finalized on Intuit's
        # side — they're not drafts. Marking `posted=True` lets our
        # reports (`_signed_balances`, Income Statement, Balance Sheet,
        # General Ledger, Cash Flow) pick them up immediately.
        # `needs_review=True` keeps them visible in the "To do" tab so
        # the CPA can still verify/reclassify.
        "posted": True,
        "needs_review": True,
        "memo": obj.get("PrivateNote") or "",
        "line_items": _map_lines(obj.get("Line") or []),
        "raw": obj,
        "created_at": now_iso(), "updated_at": now_iso(),
    }


async def _notify_migration_result(
    job_id: str, company_id: str, *, ok: bool, error: str | None = None,
) -> None:
    """Send the branded "migration complete" (or failed) email to the
    user who kicked off the migration. Best-effort — any exception is
    swallowed so the background task can still finalise the job doc.

    Branding cascades automatically: `email_dispatcher.dispatch()`
    reads the initiating user's `branding.firm_name` and drops the
    "SmartBooks" footer in favor of the white-label firm name. For
    partners / enterprises, that gives the client an email that looks
    like it came from THEIR accountant, not us.
    """
    try:
        # Job doc is the source of truth for "who started this" — we
        # stamp `initiating_user_id` on job creation in the route.
        job = await db.qbo_jobs.find_one({"job_id": job_id}) or {}
        uid = job.get("initiating_user_id")
        if not uid:
            # This is diagnostic INFO not silent — helps distinguish
            # "no email because we never captured a user" from
            # "no email because dispatch failed" in production logs.
            logger.info(
                "QBO migration email SKIPPED for job=%s cid=%s — "
                "no initiating_user_id on job doc (likely a legacy "
                "job created before the notify feature landed).",
                job_id, company_id,
            )
            return
        user = await db.users.find_one({"id": uid})
        if not user or not user.get("email"):
            logger.info(
                "QBO migration email SKIPPED for job=%s cid=%s uid=%s "
                "— user missing or has no email address.",
                job_id, company_id, uid,
            )
            return
        company = await db.companies.find_one({"id": company_id}) or {}
        company_name = company.get("name") or "your company"
        brand_name = ((user.get("branding") or {}).get("firm_name") or "").strip() or None
        # Build a landing URL the user can click straight from the
        # email. Use the initiating user's private-label host if they
        # have one; else the platform default.
        from email_dispatcher import public_base_url, dispatch
        base = public_base_url((user.get("branding") or {}).get("subdomain"))
        dashboard_url = f"{base}/connections/qbo"

        import email_templates as _et
        if ok:
            stats_keys = (
                "transactions_posted", "transactions_categorized",
                "payments_linked", "mirror_estimates_pulled",
                "mirror_pos_pulled", "mirror_inv_adj_pulled",
                "opening_inventory_value",
            )
            stats = {k: job.get(k) for k in stats_keys}
            subject, html = _et.qbo_migration_complete(
                name=user.get("name") or "there",
                company_name=company_name,
                dashboard_url=dashboard_url,
                stats=stats,
                brand_name=brand_name,
            )
            kind = "qbo_migration_complete"
        else:
            subject, html = _et.qbo_migration_failed(
                name=user.get("name") or "there",
                company_name=company_name,
                error=error or "unknown error",
                dashboard_url=dashboard_url,
                brand_name=brand_name,
            )
            kind = "qbo_migration_failed"

        resp = await dispatch(
            kind=kind,
            to=user["email"], subject=subject, html=html,
            initiating_user_id=uid, company_id=company_id,
            related={"job_id": job_id, "ok": ok},
        )
        # Log the dispatch outcome so `journalctl | grep "QBO migration
        # email"` gives an at-a-glance history in production. Resend
        # ID lets support cross-reference with the Resend dashboard.
        logger.info(
            "QBO migration email %s for job=%s cid=%s to=%s "
            "resend_id=%s status=%s",
            kind, job_id, company_id, user["email"],
            resp.get("resend_id"), resp.get("status"),
        )
    except Exception as e:  # noqa: BLE001
        # Use .exception() so the full traceback lands in Railway
        # logs. Historically .warning() dropped the frame info,
        # making it impossible to tell WHICH line raised.
        logger.exception(
            "QBO migration email FAILED for job=%s cid=%s: %s",
            job_id, company_id, e,
        )
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


async def run_migration(job_id: str, company_id: str) -> None:
    """Background migration entry point. Updates the qbo_jobs doc as
    it progresses; the frontend polls that doc for status."""
    conn = await get_connection(company_id)
    if not conn:
        await db.qbo_jobs.update_one(
            {"job_id": job_id},
            {"$set": {"status": "failed", "error": "QBO not connected"}},
        )
        await _notify_migration_result(job_id, company_id, ok=False,
                                        error="QBO not connected")
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
        # Post-import: sign each QBO transaction's `amount` based on
        # txn_type so Purchases show as outflows (negative) and
        # Deposits/SalesReceipts as inflows (positive). Also stamps a
        # `direction` field so the UI can render the appropriate icon.
        signed = await resolve_transaction_signs(company_id)
        # Post-import: translate each transaction's `bank_account_qbo_id`
        # (Business Checking, Credit Card, etc.) into a local
        # `bank_account_id` so the Account column stops falling back to
        # the company default.
        banks_resolved = await resolve_transaction_banks(company_id)
        # Post-import: translate each transaction's `contact_qbo_id`
        # into a local `contact_id` so the Contact column resolves
        # Vendor/Customer names instead of showing the "?" placeholder.
        # Only fills contacts where QBO actually attached an entity —
        # bank-feed records with no EntityRef stay unassigned (handled
        # separately by the AI Cleanup Review pass).
        contacts_resolved = await resolve_transaction_contacts(company_id)
        # Post-import: flip `posted=True` on every QBO transaction so
        # they immediately populate the P&L, Balance Sheet, and General
        # Ledger. QBO already committed these on Intuit's side.
        posted_count = await resolve_transaction_posted(company_id)
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
        # Auto-cleanup: deactivate every seeded account that isn't
        # referenced by any ledger doc and isn't a structural
        # fallback. Without this, freshly-migrated QBO companies
        # show up in the Mirror dry-run with dozens of local-only
        # seeded accounts wanting to be pushed to QBO (creating
        # duplicates in the CoA). Idempotent — the button on the
        # Cleanup Duplicates page runs the same function.
        seeded_deactivated = 0
        try:
            from pfc_ai_builder import apply_cleanup_all_seeded
            r = await apply_cleanup_all_seeded(company_id)
            seeded_deactivated = (r or {}).get("deactivated", 0)
        except Exception as e:  # noqa: BLE001
            logger.warning(
                "Seeded-cleanup after migration failed for %s: %s — "
                "user can run 'Deactivate ALL seeded' manually.",
                company_id, e)
        # Estimates + Purchase Orders have no `map_*` mapper in the
        # migration entity list (they were added post-launch as
        # mirror-only entities). Pull them via the mirror engine so
        # a freshly-migrated company doesn't end up with dozens of
        # `pull_from_qbo` records in the dry-run.
        mirror_pulled = {"estimates": 0, "purchase_orders": 0,
                          "inventory_adjustments": 0}
        skipped_dupkey = 0
        try:
            from qbo_mirror.pull import run_pull
            pr = await run_pull(company_id, "migration",
                                 entities=["estimates", "purchase_orders",
                                             "inventory_adjustments"])
            for k in mirror_pulled:
                r = (pr or {}).get(k) or {}
                mirror_pulled[k] = (r.get("inserted", 0)
                                     + r.get("updated", 0))
                skipped_dupkey += r.get("skipped_dupkey", 0)
            # Diagnostic — surface inventory_adjustment skip reasons
            # to the migration log so we can see WHY the tile shows 0
            # despite the preview count being > 0.
            inv_adj_stats = (pr or {}).get("inventory_adjustments") or {}
            if inv_adj_stats.get("skipped"):
                logger.info(
                    "InventoryAdjustment pull: seen=%d inserted=%d "
                    "skipped=%d reasons=%s",
                    inv_adj_stats.get("seen", 0),
                    inv_adj_stats.get("inserted", 0),
                    inv_adj_stats.get("skipped", 0),
                    inv_adj_stats.get("skip_reasons", {}))
        except Exception as e:  # noqa: BLE001
            logger.warning(
                "Post-migration mirror pull failed for %s: %s — "
                "user can hit Pull manually on the Mirror page.",
                company_id, e)

        # Opening Inventory JE — post a single journal entry that
        # brings the Inventory Asset account to its QBO opening
        # value (sum of item.qty_on_hand × item.cost across every
        # inventory item). Without this, reports show correct item
        # counts but $0 in `1300 Inventory Asset`, and the Balance
        # Sheet won't tie to QBO. Idempotent: rewrites the same
        # bookmarked JE on re-migration instead of double-posting.
        opening_inv_value = 0.0
        try:
            opening_inv_value = await _post_opening_inventory_je(company_id)
        except Exception as e:  # noqa: BLE001
            logger.warning(
                "Opening inventory JE failed for %s: %s — CPA can "
                "post the opening balance manually if needed.",
                company_id, e)

        await db.qbo_jobs.update_one(
            {"job_id": job_id},
            {"$set": {"status": "done", "phase": "done",
                      "finished_at": now_iso(), "percent": 100,
                      "payments_linked": linked,
                      "parents_linked": parents_linked,
                      "transactions_categorized": categorized,
                      "transactions_signed": signed,
                      "transactions_banks_resolved": banks_resolved,
                      "transactions_contacts_resolved": contacts_resolved,
                      "transactions_posted": posted_count,
                      "pfc_mapped": pfc_mapped,
                      "seeded_deactivated": seeded_deactivated,
                      "mirror_estimates_pulled": mirror_pulled["estimates"],
                      "mirror_pos_pulled": mirror_pulled["purchase_orders"],
                      "mirror_inv_adj_pulled": mirror_pulled["inventory_adjustments"],
                      "skipped_dupkey": skipped_dupkey,
                      "opening_inventory_value": opening_inv_value}},
        )
        # Fire the branded "migration complete" email. Runs after the
        # done write so the email body can pull the finalised stats.
        await _notify_migration_result(job_id, company_id, ok=True)
    except Exception as e:  # noqa: BLE001
        logger.exception("QBO migration failed for %s", company_id)
        await db.qbo_jobs.update_one(
            {"job_id": job_id},
            {"$set": {"status": "failed", "error": str(e),
                      "finished_at": now_iso()}},
        )
        await _notify_migration_result(job_id, company_id, ok=False,
                                        error=str(e))


async def _post_opening_inventory_je(company_id: str) -> float:
    """Post a single Opening Inventory JE that brings the local
    Inventory Asset account into agreement with QBO's on-hand value
    as of migration time.

    For every migrated inventory item with `qty_on_hand > 0` and a
    positive `cost`, add `qty × cost` to the debit side of Inventory
    Asset. The credit leg goes to `3900 Opening Balance Equity` (or
    the equity clearing account we already auto-create). Zero-value
    items are skipped — QBO doesn't distinguish "0 units" from
    "untracked", so we conservatively ignore them rather than post
    a $0 JE that would clutter the ledger.

    Idempotent: rewrites the previously-posted `qbo-opening-inv-<cid>`
    JE on re-migration instead of stacking a second one. Returns the
    total dollar value posted (or 0.0 if there was nothing to post).
    """
    from datetime import date
    # Gather inventory items with real on-hand value.
    total = 0.0
    lines: list[dict] = []
    inv_asset = await db.accounts.find_one(
        {"company_id": company_id, "code": "1300"})
    if not inv_asset:
        # No 1300 Inventory Asset seeded — nothing to post to.
        return 0.0
    # Collect valuation lines first — short-circuits the whole function
    # for service-only companies (no equity lookup, no JE upsert).
    async for it in db.items.find({
        "company_id": company_id, "source": "qbo",
        "track_qty_on_hand": True,
        "qty_on_hand": {"$gt": 0},
    }):
        qty = float(it.get("qty_on_hand") or 0)
        cost = float(it.get("cost") or 0)
        if qty <= 0 or cost <= 0:
            continue
        value = round(qty * cost, 2)
        total += value
        lines.append({
            "description": f"{it.get('name', 'Item')} — {qty:g} @ {cost:.2f}",
            "amount": value,
            "item_id": it["id"],
        })
    if total <= 0 or not lines:
        return 0.0
    # Only now — knowing we have a real JE to post — look up (or auto-
    # create) the equity contra account.
    opening_eq = await db.accounts.find_one(
        {"company_id": company_id,
          "$or": [{"code": "3900"},
                   {"name": {"$regex": "^Opening Balance Equity$",
                              "$options": "i"}}]})
    if not opening_eq:
        # Fall back to the transfer clearing equity account created
        # by pfc_resolver — same purpose (equity holding pen) and
        # already auto-created when needed.
        from pfc_resolver import _ensure_transfer_clearing_account
        opening_eq = await _ensure_transfer_clearing_account(company_id)
    if not opening_eq:
        return 0.0
    # Deterministic id so a re-run rewrites rather than duplicates.
    je_id = f"qbo-opening-inv-{company_id[:8]}"
    now = now_iso()
    je_doc = {
        "id": je_id,
        "company_id": company_id,
        "date": date.today().isoformat(),
        "description": "QBO migration — opening inventory balance",
        "source": "qbo_migration",
        "posted": True,
        "human_reviewed": True,
        "lines": [
            {"account_id": inv_asset["id"],
              "account_code": inv_asset.get("code"),
              "account_name": inv_asset.get("name"),
              "debit": total, "credit": 0,
              "description": f"Opening inventory ({len(lines)} items)"},
            {"account_id": opening_eq["id"],
              "account_code": opening_eq.get("code"),
              "account_name": opening_eq.get("name"),
              "debit": 0, "credit": total,
              "description": "Contra to opening inventory"},
        ],
        "total": total,
        "opening_inventory_lines": lines,
        "created_at": now, "updated_at": now,
    }
    await db.journal_entries.update_one(
        {"id": je_id, "company_id": company_id},
        {"$set": je_doc}, upsert=True,
    )
    return total




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

async def resolve_transaction_posted(company_id: str) -> int:
    """Mark every QBO-imported transaction as `posted=True` so the
    Income Statement, Balance Sheet, General Ledger, and Cash Flow
    pick them up. QBO already finalized these on Intuit's side —
    they are the ledger. Idempotent: only touches rows that don't
    already have `posted=True`."""
    r = await db.transactions.update_many(
        {"company_id": company_id, "source": "qbo",
         "posted": {"$ne": True}},
        {"$set": {"posted": True, "updated_at": now_iso()}},
    )
    return r.modified_count


async def resolve_transaction_banks(company_id: str) -> int:
    """Translate each QBO transaction's `bank_account_qbo_id` into a
    local `bank_account_id` so the Transactions UI's Account column
    picks up Business Checking / Savings / Credit Card automatically
    instead of falling back to the company-wide default. Idempotent:
    skips docs that already have `bank_account_id` set."""
    qbo_to_local: dict[str, str] = {}
    async for a in db.accounts.find(
        {"company_id": company_id, "source": "qbo"},
        {"id": 1, "qbo_id": 1, "_id": 0},
    ):
        if a.get("qbo_id"):
            qbo_to_local[str(a["qbo_id"])] = a["id"]

    if not qbo_to_local:
        return 0

    updated = 0
    # Two flavors of unresolved doc:
    #   1. Newly imported — has `bank_account_qbo_id` populated by the
    #      mapper, but not yet translated to a local id.
    #   2. Pre-fix imports — has neither `bank_account_qbo_id` nor
    #      `bank_account_id`; we recover from `raw` using the same
    #      key-per-txn_type lookup the mapper uses at write time.
    async for t in db.transactions.find(
        {"company_id": company_id, "source": "qbo",
         "$or": [{"bank_account_id": {"$in": [None, ""]}},
                 {"bank_account_id": {"$exists": False}}]},
        {"id": 1, "txn_type": 1, "bank_account_qbo_id": 1, "raw": 1},
    ):
        aqid = t.get("bank_account_qbo_id")
        if not aqid:
            aqid = _bank_account_qbo_id(t.get("raw") or {}, t.get("txn_type") or "")
        if not aqid:
            continue
        local_id = qbo_to_local.get(str(aqid))
        if not local_id:
            continue
        # Also stamp `bank_account_qbo_id` on legacy rows so future
        # resolvers can skip the raw-doc dive.
        await db.transactions.update_one(
            {"id": t["id"]},
            {"$set": {"bank_account_id": local_id,
                      "bank_account_qbo_id": str(aqid),
                      "updated_at": now_iso()}},
        )
        updated += 1
    return updated



async def resolve_transaction_contacts(company_id: str) -> int:
    """Translate each QBO transaction's `contact_qbo_id` into a local
    `contact_id` so the Transactions UI's Contact column resolves the
    Vendor/Customer/Employee name automatically instead of showing the
    "?" placeholder.

    Only touches docs where `contact_qbo_id` is populated but
    `contact_id` is still empty — this is the class of Purchase /
    Deposit / Transfer / SalesReceipt / RefundReceipt records that were
    imported via `map_generic_txn`, where the mapper stored the QBO id
    but the resolve step was previously missing.

    Idempotent — safe to re-run and returns the number of transactions
    that got a `contact_id` on this pass.
    """
    qbo_to_local: dict[str, str] = {}
    async for c in db.contacts.find(
        {"company_id": company_id, "qbo_id": {"$exists": True, "$ne": None}},
        {"id": 1, "qbo_id": 1, "_id": 0},
    ):
        qid = c.get("qbo_id")
        if qid:
            qbo_to_local[str(qid)] = c["id"]

    if not qbo_to_local:
        return 0

    updated = 0
    async for t in db.transactions.find(
        {"company_id": company_id, "source": "qbo",
         "contact_qbo_id": {"$exists": True, "$ne": None},
         "$or": [{"contact_id": {"$in": [None, ""]}},
                 {"contact_id": {"$exists": False}}]},
        {"id": 1, "contact_qbo_id": 1},
    ):
        cqid = t.get("contact_qbo_id")
        if not cqid:
            continue
        local_id = qbo_to_local.get(str(cqid))
        if not local_id:
            continue
        await db.transactions.update_one(
            {"id": t["id"]},
            {"$set": {"contact_id": local_id, "updated_at": now_iso()}},
        )
        updated += 1
    return updated




async def resolve_transaction_signs(company_id: str) -> int:
    """Backfill for QBO-imported transactions saved with the older
    always-positive amount. Re-signs `amount` and adds `direction`
    per the `_signed_amount` / `_direction_for` rules. Idempotent —
    once a doc has `direction` set, it's skipped."""
    updated = 0
    async for t in db.transactions.find(
        {"company_id": company_id, "source": "qbo",
         "direction": {"$exists": False}},
        {"id": 1, "txn_type": 1, "amount": 1},
    ):
        txn_type = t.get("txn_type") or ""
        mag = abs(float(t.get("amount") or 0))
        signed = _signed_amount(txn_type, mag)
        direction = _direction_for(txn_type)
        await db.transactions.update_one(
            {"id": t["id"]},
            {"$set": {"amount": signed, "direction": direction,
                      "updated_at": now_iso()}},
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
        {"id": 1, "qbo_id": 1, "code": 1, "name": 1, "type": 1, "_id": 0},
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
    # post to the expense account. `CreditMemo` is included here so its
    # Uncategorized fallback lands in Uncategorized Expense (a customer
    # credit reduces revenue, effectively an expense flow).
    _OUTBOUND = {"Purchase", "Bill", "BillPayment", "RefundReceipt",
                 "VendorCredit", "CreditMemo"}

    # Last-resort Uncategorized fallbacks — used when a transaction's
    # lines carry neither an AccountRef nor an Item that maps back to a
    # local account (rare, but happens for QBO docs with only a memo
    # line or a non-taxable "description-only" line). Prefer the QBO-
    # imported Uncategorized accounts if the company has them; fall
    # back to the seeded 6999 / 4999 slots that are always kept.
    def _uncat(direction: str) -> dict | None:
        want_type = "revenue" if direction == "in" else "expense"
        for a in qbo_to_local.values():
            if a.get("type") != want_type:
                continue
            nm = (a.get("name") or "").strip().lower()
            if "uncategorized" in nm:
                return a
        # Fall through to seeded fallbacks (`Deactivate ALL seeded`
        # preserves 6999 & 4999 specifically for this purpose).
        code = "4999" if direction == "in" else "6999"
        return seeded_fallback.get(code)

    # Preload seeded 6999 / 4999 (only two candidates so a `find` is
    # overkill; still one round trip).
    seeded_fallback: dict[str, dict] = {}
    async for a in db.accounts.find(
        {"company_id": company_id, "source": {"$ne": "qbo"},
         "code": {"$in": ["6999", "4999"]}},
        {"id": 1, "code": 1, "name": 1, "_id": 0},
    ):
        if a.get("code"):
            seeded_fallback[a["code"]] = a

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
            # No line-level AccountRef or Item resolution — drop the
            # transaction into Uncategorized Expense/Income keyed by
            # direction so the row stops showing "pick a category" and
            # the user can re-classify later from the Transactions
            # page.
            direction = "out" if outbound else "in"
            picked = _uncat(direction)
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
