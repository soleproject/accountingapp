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
from contextvars import ContextVar
from datetime import datetime, timezone, timedelta
from typing import Any, AsyncIterator, Optional

import httpx
from intuitlib.client import AuthClient
from intuitlib.enums import Scopes

from db import db, now_iso
from crypto_service import encrypt, decrypt


# ContextVar for connection-collection swap. Test QBO sets this to
# `"qbo_test_connections"` for the duration of a request so its
# OAuth/refresh/API calls persist against an isolated table and NEVER
# touch the production `qbo_connections` collection.
_conn_coll_var: ContextVar[str] = ContextVar(
    "qbo_conn_coll", default="qbo_connections")


def _conn_coll():
    """Return the currently-active connection collection (production
    by default; `qbo_test_connections` when the Test QBO ContextVar
    is set on the request). Any function that previously reached into
    `db.qbo_connections` directly must route through this helper."""
    return getattr(db, _conn_coll_var.get())

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
    the Feb 2026 backfill; new prod connections stamp "production".

    Honors `qbo_conn_coll` ContextVar so Test QBO can persist into an
    isolated `qbo_test_connections` collection without touching prod.
    """
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
    await _conn_coll().update_one(
        {"company_id": company_id},
        {"$set": doc, "$setOnInsert": {"created_at": now_iso()}},
        upsert=True,
    )


async def get_connection(company_id: str) -> Optional[dict]:
    return await _conn_coll().find_one({"company_id": company_id})


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
        await _conn_coll().update_one(
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
                await _conn_coll().update_one(
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
    # QBO's default `SELECT *` filters out `Active=false` rows. That's
    # normally fine, but deleted/inactive Accounts still appear as
    # `AccountRef` values on historical JournalEntry, Purchase, and
    # Bill lines. If we don't pull them here they never make it into
    # our `accounts` collection, `_signed_balances` can't map those
    # JE lines to a local account, and their ledger impact vanishes
    # from the Balance Sheet — showing up as a phantom L+E imbalance.
    # BM QBO 2 LLC (Feb 27 2026) had two such accounts, "Partners
    # Clearing for Capital (deleted)" and "Payment Clearing Account
    # (deleted)", carrying $44,904.31 of unmapped JE activity.
    where = " WHERE Active IN (true, false)" if entity == "Account" else ""
    start, page = 1, 1000
    while True:
        q = f"SELECT * FROM {entity}{where} STARTPOSITION {start} MAXRESULTS {page}"
        data = await _get(company_id, realm_id, f"/company/{realm_id}/query", {"query": q})
        rows = data.get("QueryResponse", {}).get(entity, []) or []
        for row in rows:
            yield row
        if len(rows) < page:
            break
        start += len(rows)


async def fetch_report(
    company_id: str, realm_id: str, report_name: str,
    params: dict | None = None,
) -> dict:
    """Fetch a canonical QBO report as structured JSON.

    ``report_name`` is one of QBO's report codes — the three we care
    about for reconciliation are ``ProfitAndLoss``, ``BalanceSheet``,
    and ``TransactionList``. ``params`` accepts QBO's standard report
    query args: ``start_date``, ``end_date``, ``date_macro``,
    ``accounting_method`` (``Accrual`` / ``Cash``), etc.

    Returned payload is QBO's ``Header`` + ``Columns`` + ``Rows`` tree —
    the same data QBO's own UI uses to render the report — so storing
    it verbatim gives us a canonical reference to reconcile our
    recomputed reports against.
    """
    path = f"/company/{realm_id}/reports/{report_name}"
    return await _get(company_id, realm_id, path, params or {})


async def snapshot_reports(
    company_id: str, realm_id: str,
    start_date: str | None = None, end_date: str | None = None,
    accounting_method: str = "Accrual",
) -> dict:
    """Fetch P&L, BS, and Transaction List from QBO and persist the
    payloads to ``qbo_report_snapshots``.

    One document per snapshot — we keep every snapshot so we can
    reconcile against any historical point-in-time comparison. Returns
    a summary of what was captured.
    """
    reports = [
        ("ProfitAndLoss",   {"start_date": start_date, "end_date": end_date,
                             "accounting_method": accounting_method}),
        ("BalanceSheet",    {"end_date": end_date,
                             "accounting_method": accounting_method}),
        ("TransactionList", {"start_date": start_date, "end_date": end_date,
                             "accounting_method": accounting_method}),
    ]
    captured = []
    for name, params in reports:
        params = {k: v for k, v in params.items() if v is not None}
        try:
            payload = await fetch_report(company_id, realm_id, name, params)
        except Exception as e:  # noqa: BLE001
            captured.append({"report": name, "ok": False, "error": str(e)[:400]})
            continue
        doc = {
            "id": f"snap-{company_id[:8]}-{name}-{now_iso()}",
            "company_id": company_id,
            "realm_id": realm_id,
            "report_name": name,
            "accounting_method": accounting_method,
            "start_date": start_date,
            "end_date": end_date,
            "snapshot_at": now_iso(),
            "payload": payload,
        }
        await db.qbo_report_snapshots.insert_one(doc)
        captured.append({
            "report": name, "ok": True,
            "snapshot_id": doc["id"],
            "rows": len((payload.get("Rows") or {}).get("Row", []) or []),
        })
    return {"captured": captured}



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
    # Aug 22 2026 — Closing enterprise BS drift ($1M+ on Perfect Synovus)
    # caused by these two categories previously being un-imported.
    ("VendorCredit",       lambda c, r, o: map_generic_txn(c, r, o, "VendorCredit"),       "transactions"),
    ("CreditCardPayment",  lambda c, r, o: map_generic_txn(c, r, o, "CreditCardPayment"),  "transactions"),
    # Aug 22 2026 — Complete GL parity + non-posting round-trip.
    # InventoryAdjustment has REAL GL impact (DR/CR Inventory Asset)
    # and was the last posting entity missing from production.
    # Estimate / PurchaseOrder / RecurringTransaction are non-posting
    # (marked `posted=False` in the mapper so `_signed_balances`
    # ignores them) — pulled so the existing Estimates / Purchase
    # Orders / Recurring pages have data.
    ("InventoryAdjustment", lambda c, r, o: map_inventory_adjustment_txn(c, r, o), "transactions"),
    ("Estimate",            lambda c, r, o: map_non_posting_txn(c, r, o, "Estimate"),            "transactions"),
    ("PurchaseOrder",       lambda c, r, o: map_non_posting_txn(c, r, o, "PurchaseOrder"),       "transactions"),
    ("RecurringTransaction",lambda c, r, o: map_non_posting_txn(c, r, o, "RecurringTransaction"),"transactions"),
]


# ------------------------------------------------------------------
# Transactional mappers
# ------------------------------------------------------------------

def _map_lines(qbo_lines: list) -> list[dict]:
    """Flatten QBO SalesItemLineDetail / AccountBasedExpenseLineDetail
    / DepositLineDetail into our unified {description, quantity, rate,
    amount} shape.

    Deposit lines are structured differently from invoice/expense lines:
      - Direct-income deposits carry `DepositLineDetail.AccountRef`
        (e.g. an interest deposit landing straight to Interest Income).
      - Payment-sweep deposits carry only `LinkedTxn` (a Payment or
        SalesReceipt originally deposited to Undeposited Funds — the
        Deposit sweeps that money out to the destination bank). No
        explicit AccountRef because QBO knows the source is Undep.

    We capture both forms so the post-import resolver can populate
    the transaction's `splits[]` with proper credit-side legs (was:
    silently dropped, leaving Deposits with no offset → Checking +
    Undep both inflated on the BS by the total swept amount).
    """
    out = []
    for ln in qbo_lines or []:
        dtype = ln.get("DetailType")
        if dtype == "SubTotalLineDetail":
            continue

        # QBO discount lines carry their own detail type with a
        # `DiscountAccountRef` (typically the "Discounts given" contra-
        # revenue account). Their Amount is stored POSITIVE — we sign
        # it negative here so it reduces revenue on the P&L, matching
        # QBO's own report where the discount line brings the net
        # SalesReceipt total below the sub-total. Without this the
        # SalesReceipt header total ($78.75) didn't reconcile with
        # the sum of the item lines ($87.50). Feb 26 2026.
        if dtype == "DiscountLineDetail":
            ddet = ln.get("DiscountLineDetail") or {}
            acct_ref = ddet.get("DiscountAccountRef") or {}
            damt = float(ln.get("Amount") or 0)
            if abs(damt) < 0.005:
                continue
            out.append({
                "description": ln.get("Description") or "Discount",
                "quantity": 1,
                "rate": -round(damt, 2),
                "amount": -round(damt, 2),
                "item_qbo_id": None, "item_name": None,
                "account_qbo_id": acct_ref.get("value"),
                "account_name": acct_ref.get("name"),
                "linked_txns": [],
                "is_discount": True,
            })
            continue

        detail = (ln.get("SalesItemLineDetail")
                  or ln.get("AccountBasedExpenseLineDetail")
                  or ln.get("ItemBasedExpenseLineDetail")
                  or ln.get("DepositLineDetail")
                  or {})
        item_ref = (detail.get("ItemRef") or {})
        acct_ref = (detail.get("AccountRef") or {})
        qty = float(detail.get("Qty") or 1) or 1
        rate = float(detail.get("UnitPrice") or 0)
        amt = float(ln.get("Amount") or 0)
        # A LinkedTxn-only Deposit line has no DetailType and no
        # AccountRef but DOES have an amount + LinkedTxn reference.
        # Preserve it so the deposit-splits resolver can attribute it
        # to Undeposited Funds later. Same for MISSING amount lines —
        # skip only if the line is completely empty (no amount AND no
        # linked txn reference AND no detail).
        linked = ln.get("LinkedTxn") or []
        if dtype is None and not detail and not linked and amt == 0:
            continue
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
            # LinkedTxn refs — carried through for post-migration
            # resolvers (Deposit split attribution to Undep, invoice
            # apply-link resolution, etc.). Empty list is fine.
            "linked_txns": linked,
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
    # Status resolution: fully-paid → paid, partial payment → partial,
    # nothing collected yet → sent. Prior versions collapsed partial
    # into 'sent', which downstream reports read as "still unpaid"
    # but the UI misrendered as "just emailed".
    if balance <= 0.005:
        status = "paid"
    elif balance + 0.005 < total:
        status = "partial"
    else:
        status = "sent"
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
        # `balance_due` is the canonical field the rest of the app reads
        # (routes/invoices.py, reports._open_ar_ap, AR aging, dashboards).
        # `balance` kept as an alias for any legacy consumers.
        "balance_due": round(balance, 2),
        "balance": round(balance, 2),
        "status": status,
        "currency": (obj.get("CurrencyRef") or {}).get("value", "USD"),
        "raw": obj,
        "created_at": now_iso(), "updated_at": now_iso(),
    }


def map_bill(cid: str, realm_id: str, obj: dict) -> dict:
    vend = obj.get("VendorRef") or {}
    total = float(obj.get("TotalAmt") or 0)
    balance = float(obj.get("Balance") or 0)
    if balance <= 0.005:
        status = "paid"
    elif balance + 0.005 < total:
        status = "partial"
    else:
        status = "open"
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
        "total": round(total, 2),
        # Canonical name is `balance_due` — matches invoices, matches
        # `_open_ar_ap`'s AP calculation. `balance` retained as alias.
        "balance_due": round(balance, 2),
        "balance": round(balance, 2),
        "status": status,
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
_OUTFLOW_TXN_TYPES = {"Purchase", "RefundReceipt", "CreditMemo",
                       # Aug 22 2026 — CC payments are outflows from
                       # the funding bank; Vendor Credits reduce A/P
                       # (net outflow of AP recognition).
                       "CreditCardPayment", "VendorCredit"}
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
        "Purchase":          "AccountRef",
        "Deposit":           "DepositToAccountRef",
        "SalesReceipt":      "DepositToAccountRef",
        "RefundReceipt":     "DepositToAccountRef",
        "Transfer":          "FromAccountRef",
        "CreditMemo":        "ARAccountRef",
        # New Aug 22 2026 — production parity for enterprise drift.
        # CreditCardPayment: source of funds (Bank) → `BankAccountRef`,
        # target is CreditCardAccountRef (handled below in lines mapping).
        "CreditCardPayment": "BankAccountRef",
        # VendorCredit: A/P side → `APAccountRef` (falls back to the
        # vendor's default A/P when missing). Same shape as Bill.
        "VendorCredit":      "APAccountRef",
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
    # QBO's `Purchase` object doubles as both a normal expense (Credit
    # missing / false) AND a "Credit Card Credit" refund back to the
    # source account (Credit=true, PaymentType=CreditCard). In the
    # refund case the money flow reverses — Mastercard is CREDITED (CC
    # balance goes down), Checking / expense is DEBITED — so we flip
    # the signed amount from outflow to inflow. Without this, the
    # $900 CC-Credit on Craig's sample data DR'd Checking AND DR'd
    # Mastercard, over-stating both by $900. Feb 26 2026.
    signed = _signed_amount(txn_type, magnitude)
    direction = _direction_for(txn_type)
    if txn_type == "Purchase" and obj.get("Credit"):
        signed = -signed
        direction = "in" if direction == "out" else "out"

    # Synthesize a category-side split so both legs of the double
    # entry land on the ledger for entities that don't carry a `Line`
    # array with `AccountBasedExpenseLineDetail`.
    synth_lines: list[dict] = []
    if txn_type == "CreditCardPayment":
        # DR the target Credit-Card liability by TotalAmt. The bank
        # side (CR) is already captured via `bank_account_qbo_id`
        # (BankAccountRef) — see `_bank_account_qbo_id` above.
        cc_ref = obj.get("CreditCardAccountRef") or {}
        cc_qid = cc_ref.get("value")
        if cc_qid:
            synth_lines = [{
                "description": "Credit Card Payment",
                "amount": magnitude,
                "account_qbo_id": cc_qid,
                "account_name": cc_ref.get("name") or "",
            }]
    elif txn_type == "VendorCredit":
        # A/P side captured via `bank_account_qbo_id` (APAccountRef).
        # Expense/COGS side lives in the QBO Line array, same shape
        # as Bill — reuse the standard `_map_lines` output later.
        pass
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
        "amount": signed,
        "direction": direction,
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
        "line_items": _map_lines(obj.get("Line") or []) or synth_lines,
        "raw": obj,
        "created_at": now_iso(), "updated_at": now_iso(),
    }


def map_inventory_adjustment_txn(cid: str, realm_id: str, obj: dict) -> dict:
    """InventoryAdjustment maps DR/CR of Inventory Asset against the
    `AdjustAccountRef` (typically Inventory Shrinkage / Adjustments
    Expense). Each `Line` carries `ItemAdjustmentLineDetail` with an
    `AmountDiff` (positive = write-up, negative = write-down); we sum
    them to derive the net inventory-asset movement. The bank side of
    `_signed_balances` sees this via `bank_account_qbo_id` (adjust
    account) and the offset via a synthetic split line pointing at
    Inventory Asset (resolved from `AccountRef`).

    Supersedes the older `map_inventory_adjustment` (which produced a
    journal_entries doc with empty lines and required a separate cost-
    resolution step). This one produces a fully-formed transaction
    record ready for `_signed_balances`. Aug 22 2026.
    """
    adj_ref  = obj.get("AdjustAccountRef") or {}
    inv_ref  = obj.get("AccountRef") or {}  # Inventory Asset account
    lines = obj.get("Line") or []
    net_amount = 0.0
    synth_lines: list[dict] = []
    for ln in lines:
        detail = ln.get("ItemAdjustmentLineDetail") or {}
        amt_diff = float(detail.get("AmountDiff") or 0)
        qty_diff = float(detail.get("QtyDiff") or 0)
        net_amount += amt_diff
        item_ref = detail.get("ItemRef") or {}
        synth_lines.append({
            "description": item_ref.get("name") or "Inventory Adjustment",
            "quantity": qty_diff,
            "amount": amt_diff,
            "item_qbo_id": item_ref.get("value"),
            "account_qbo_id": inv_ref.get("value"),
            "account_name": inv_ref.get("name") or "Inventory Asset",
        })
    magnitude = round(abs(net_amount), 2)
    return {
        "company_id": cid, "source": "qbo",
        "qbo_id": obj["Id"],
        "id": f"qbo-{cid[:8]}-inventoryadjustment-{obj['Id']}",
        "realm_id": realm_id,
        "txn_type": "InventoryAdjustment",
        "number": obj.get("DocNumber") or f"IA-{obj['Id']}",
        "date": obj.get("TxnDate") or "",
        # `amount` is signed: positive net_amount = inventory write-up
        # (DR Inventory Asset / CR Adjust account), negative = write-
        # down (opposite). `bank_account_qbo_id` points at the ADJUST
        # account so `_signed_balances` posts the offsetting side.
        "amount": round(net_amount, 2),
        "direction": "in" if net_amount >= 0 else "out",
        "bank_account_qbo_id": adj_ref.get("value"),
        "posted": True,
        "needs_review": True,
        "memo": obj.get("PrivateNote") or "",
        "line_items": synth_lines,
        "raw": obj,
        "created_at": now_iso(), "updated_at": now_iso(),
    }


def map_non_posting_txn(cid: str, realm_id: str, obj: dict,
                         txn_type: str) -> dict:
    """Estimate / PurchaseOrder / RecurringTransaction — pulled for
    UI round-trip but flagged `posted=False` so `_signed_balances`
    ignores them (they never touch the GL). Standard shape otherwise
    so existing entity list pages (`/estimates`, `/purchase-orders`,
    `/recurring`) can render them unchanged.
    """
    ref = (obj.get("CustomerRef") or obj.get("VendorRef") or {})
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
        "direction": "in" if txn_type == "Estimate" else "out",
        # Critical — `posted=False` keeps these out of the ledger
        # aggregations (`_signed_balances`, IS, BS, GL). They exist
        # purely as UI records.
        "posted": False,
        "needs_review": False,
        "memo": obj.get("PrivateNote") or obj.get("CustomerMemo", {}).get("value") or "",
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
        # Post-import: resolve item account refs and flip
        # `track_inventory=True` on real Inventory items so they
        # appear on the Inventory Management page. Idempotent.
        try:
            items_resolved = await resolve_item_accounts_and_tracking(company_id)
        except Exception:  # noqa: BLE001
            items_resolved = {"items_resolved": 0,
                              "error": "resolver_failed"}
        # Post-import: for Payment IN docs where QBO omitted
        # `DepositToAccountRef` (customer payments held in Undeposited
        # Funds pending a Bank Deposit sweep), stamp the local UF
        # account's qbo_id so the Balance Sheet asset column reflects
        # the held cash. Idempotent, safe to re-run.
        # Feb 28 2026 — QBO Undeposited Funds two-step workflow.
        undep_stamped = await resolve_payment_undeposited(company_id)
        # Fetch QBO TaxRate + TaxAgency so `compute_balance_sheet`
        # can route sales-tax lines to the correct payable account.
        try:
            tax_rates_stats = await resolve_tax_rates(company_id)
        except Exception:  # noqa: BLE001
            tax_rates_stats = {"rates_upserted": 0,
                                "error": "resolver_failed"}
        # Synthesize QBO Sales Tax Payment postings (not exposed by
        # the REST endpoints, only by the GL report). Fixes both the
        # Checking over-count and the residual sales-tax-payable
        # inflation on migrations. Feb 28 2026.
        try:
            tax_pay_stats = await resolve_qbo_sales_tax_payments(company_id)
        except Exception:  # noqa: BLE001
            tax_pay_stats = {"lines_added": 0, "error": "resolver_failed"}
        # Post-import: build the Deposit `splits[]` so multi-source
        # deposits credit their line sources (Undep sweeps or direct
        # income accounts) instead of only DR-ing the bank. Without
        # this, every LinkedTxn Deposit leaves Undep + destination
        # bank both inflated on the BS. Must run AFTER Account import.
        deposit_splits_stats = await resolve_deposit_splits(company_id)
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
        # Post-import: backfill `journal_entries.lines[i].account_id`
        # from `account_qbo_id`. Must run AFTER Account import.
        # `_signed_balances` reads `line.account_id`, so without this
        # every migrated JE line's ledger impact is silently dropped.
        # Feb 27 2026 — BM QBO 2 LLC parity fix.
        je_lines_resolved = await resolve_journal_entry_line_accounts(company_id)
        # Post-import: use QBO's General Ledger as source-of-truth to
        # stamp `account_qbo_id` on invoice / bill / SR / RR lines
        # whose current Item mapping disagrees with what QBO actually
        # posted. Historical items get reassigned to new accounts over
        # time; without this, per-account P&L totals diverge from
        # QBO's own report by the amount of any re-mapped item's
        # historical activity. Feb 28 2026 — Phase 2 QBO parity.
        try:
            gl_stamped = await resolve_qbo_gl_line_accounts(company_id)
        except Exception:  # noqa: BLE001
            # QBO's GeneralLedger endpoint can be slow or rate-limited
            # on large books — a failure here shouldn't block the
            # whole migration. Operator can re-run via
            # POST /companies/{cid}/qbo/resolve-gl-line-accounts.
            gl_stamped = {"lines_stamped": 0, "error": "gl_resolver_failed"}
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

        # General opening-balance JE for Fixed Assets, Long-Term
        # Liabilities, and other accounts QBO carries a `CurrentBalance`
        # on but whose activity isn't surfaced through Invoice / Bill /
        # Payment / Purchase entities. Runs AFTER the inventory-specific
        # opener above so it can see the inventory JE's ledger effect
        # and skip Inventory Asset.
        opening_bal_stats: dict = {}
        try:
            opening_bal_stats = await _post_opening_balances_je(company_id)
        except Exception as e:  # noqa: BLE001
            logger.warning(
                "Opening balances JE failed for %s: %s — Truck / Notes "
                "Payable / etc. will read $0 on the BS until backfilled.",
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
                      "opening_inventory_value": opening_inv_value,
                      "opening_balances_je": opening_bal_stats,
                      "deposit_splits": deposit_splits_stats}},
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

    Yields to `_post_opening_balances_je` when QBO already carries a
    non-zero `CurrentBalance` on its own Inventory Asset account — the
    general opener will post that authoritative balance directly, and
    running both would double-count inventory (once from the QBO
    balance, once from items × qty). Feb 26 2026.
    """
    from datetime import date

    # Yield to the general opener when QBO's Inventory Asset carries
    # its own CurrentBalance. Delete any prior version of this JE so
    # a re-run cleanly hands ownership over.
    je_id = f"qbo-opening-inv-{company_id[:8]}"
    async for qbo_inv in db.accounts.find({"company_id": company_id,
                                             "source": "qbo",
                                             "detail_type": "inventory"}):
        raw = qbo_inv.get("raw") or {}
        if abs(float(raw.get("CurrentBalance") or 0)) > 0.005:
            await db.journal_entries.delete_many(
                {"id": je_id, "company_id": company_id})
            return 0.0

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


async def _post_opening_balances_je(company_id: str) -> dict:
    """Post opening-balance journal entries for QBO accounts whose
    `CurrentBalance` at migration time is non-zero but which have no
    imported transaction activity establishing that balance.

    Why this exists
    ---------------
    QBO auto-generates hidden "opening balance" system entries when a
    user first sets a balance on a Fixed Asset, Long-Term Liability, or
    similar account. Those entries are NOT surfaced through the standard
    JournalEntry endpoint, so a straight-through migration of Invoices +
    Bills + Payments + Purchases leaves Truck, Notes Payable, Loan
    Payable, etc. at $0 on our books. QBO's own Balance Sheet reports
    them via the account's stored `CurrentBalance`, and the offsetting
    side is inside `Opening Balance Equity`.

    We reproduce that here: for every account with a non-zero QBO
    CurrentBalance and zero ledger activity, post a single JE dated
    2000-01-01 (well before any imported txn) that DR/CRs the account
    for its opening amount, offset by Opening Balance Equity. This is
    the industry-standard "QBD → QBO" opening-balance migration
    pattern and produces the same OBE plug QBO itself carries.

    We deliberately DO NOT touch accounts that already have ledger
    activity — a mismatch between QBO's `CurrentBalance` and our
    computed balance on Checking / Undep / etc. points to an import gap
    (Deposit lines lost, SalesReceipt discount lines dropped, etc.),
    not a missing opening balance. Those get fixed at the mapper level.

    We also skip Accounts Receivable and Accounts Payable — those are
    computed accrual-side from `db.invoices` / `db.bills` open balances
    (see `_open_ar_ap`), not from the ledger, and their QBO balance is
    already reflected in the reports layer.

    Idempotent: writes one JE per company keyed by a deterministic id.
    Re-running the migration replaces the row instead of stacking.

    Returns {"posted_je_id", "line_count", "gross_debits", "gross_credits"}
    or {"posted_je_id": None, ...} when there was nothing to post.
    """
    import reports as _R

    # Bookmark id — used to both write and pre-clear any prior version
    # of this JE before we recompute `_signed_balances`. Without the
    # pre-clear the second run sees Truck / Notes Payable / etc. as
    # "already has ledger activity" (from the previous opening JE) and
    # skips them, leaving the second-run JE incomplete.
    je_id = f"qbo-opening-balances-{company_id[:8]}"
    await db.journal_entries.delete_many({"id": je_id,
                                            "company_id": company_id})

    # 1) Compute current signed-balance map (post all imports, minus
    # the previous opening JE we just cleared).
    by = await _R._signed_balances(company_id, start=None,
                                    end="2099-12-31",
                                    include_pre_period=True)

    # 2) Find OBE. Auto-create if missing so newer QBO companies that
    # never had one at connect time still get plugged correctly.
    opening_eq = await db.accounts.find_one(
        {"company_id": company_id,
          "$or": [{"code": "3900"},
                   {"name": {"$regex": "^Opening Balance Equity$",
                              "$options": "i"}}]})
    if not opening_eq:
        from pfc_resolver import _ensure_transfer_clearing_account
        opening_eq = await _ensure_transfer_clearing_account(company_id)
    if not opening_eq:
        return {"posted_je_id": None, "line_count": 0,
                "gross_debits": 0.0, "gross_credits": 0.0}

    # 3) Collect accounts that need an opening balance line. Skip
    # AR/AP (computed off-ledger via `_open_ar_ap`) and OBE itself
    # (it IS the offset). Distinguish AR/AP *strictly* by QBO's own
    # `AccountType` string — our internal `detail_type` taxonomy maps
    # both real Accounts Payable and generic Long-Term / Other Current
    # Liabilities to `expected_payments_to_vendors`, so filtering on
    # detail_type wrongly excludes Notes Payable, Loan Payable, and
    # Board of Equalization Payable (bug in first cut, Feb 26 2026).
    _AR_AP_QBO_TYPES = {"Accounts Receivable", "Accounts Payable"}
    # Sales-tax liabilities (Board of Equalization Payable et al.)
    # are auto-populated by QBO whenever an Invoice or SalesReceipt
    # includes tax lines; they should never carry an "opening
    # balance" in the OBE plug. Excluding them prevents inflating
    # OBE by the accumulated sales-tax liability on a fresh
    # migration (Craig's Landscaping: $370.94 extra on OBE without
    # this filter). Once we start extracting invoice `TxnTaxDetail`
    # into a proper sales-tax posting, the account populates
    # naturally. Feb 28 2026.
    _SALES_TAX_SUBTYPES = {"GlobalTaxPayable", "SalesTaxPayable"}

    lines: list[dict] = []
    dr_total = 0.0
    cr_total = 0.0

    async for acc in db.accounts.find({"company_id": company_id,
                                        "source": "qbo"}):
        if acc["id"] == opening_eq["id"]:
            continue
        raw = acc.get("raw") or {}
        qcb = float(raw.get("CurrentBalance") or 0)
        if abs(qcb) < 0.005:
            continue
        # Strict AR/AP skip — use QBO's AccountType, not detail_type.
        if str(raw.get("AccountType") or "") in _AR_AP_QBO_TYPES:
            continue
        # Sales-tax payable — plug not applicable (see comment above).
        if str(raw.get("AccountSubType") or "") in _SALES_TAX_SUBTYPES:
            continue

        current_raw = float(by.get(acc["id"], 0.0) or 0.0)

        # ONLY plug accounts that carry ZERO imported ledger activity.
        # QBO's `CurrentBalance` reflects opening balance PLUS all
        # subsequent transactions; if we've already imported activity
        # (Checking accumulates from Deposit/Purchase txns, Inventory
        # Asset accumulates from InventoryAdjustment JEs, etc.), the
        # delta doesn't cleanly separate "opening" from "import gap".
        # Plugging in that case double-counts (or masks) real import
        # bugs — the opening JE would silently swallow a $76.90
        # missing-deposit and quietly bake it into OBE.
        #
        # By contrast, Fixed Assets (Truck.Original Cost), Long-Term
        # Liabilities (Loan Payable, Notes Payable), and initial-
        # capital equity carry no through-line activity on the QBO
        # API — QBO tracks their balances via a hidden "opening
        # balance" system JE that the standard endpoints don't
        # expose. Those are the only accounts we plug here.
        # Feb 28 2026 — Craig's Landscaping OBE drift ($419.09).
        if abs(current_raw) >= 0.005:
            continue

        # Delta collapses to `qcb` since `current_raw` is ~0.
        delta = round(qcb - current_raw, 2)
        if abs(delta) < 0.005:
            continue

        # `delta` is signed like our raw ledger:
        #   positive delta → we need MORE DEBIT (or less credit)
        #   negative delta → we need MORE CREDIT (or less debit)
        if delta > 0:
            debit = delta; credit = 0.0
        else:
            debit = 0.0; credit = -delta

        # If we ended up with a negative debit or credit, the account
        # has an unusual (contra) balance — flip to the other side.
        if debit < 0:
            credit = -debit; debit = 0.0
        if credit < 0:
            debit = -credit; credit = 0.0

        if debit > 0:
            dr_total += debit
        if credit > 0:
            cr_total += credit

        lines.append({
            "account_id": acc["id"],
            "account_code": acc.get("code"),
            "account_name": acc.get("name"),
            "debit": round(debit, 2),
            "credit": round(credit, 2),
            "description": f"Opening balance from QBO CurrentBalance",
        })

    if not lines:
        return {"posted_je_id": None, "line_count": 0,
                "gross_debits": 0.0, "gross_credits": 0.0}

    # 4) Balance the JE with a single OBE line for the net delta.
    net = round(dr_total - cr_total, 2)
    if abs(net) >= 0.005:
        if net > 0:
            # More debits than credits — OBE takes the credit side.
            lines.append({
                "account_id": opening_eq["id"],
                "account_code": opening_eq.get("code"),
                "account_name": opening_eq.get("name"),
                "debit": 0.0, "credit": abs(net),
                "description": "Opening Balance Equity — balancing entry",
            })
            cr_total += abs(net)
        else:
            lines.append({
                "account_id": opening_eq["id"],
                "account_code": opening_eq.get("code"),
                "account_name": opening_eq.get("name"),
                "debit": abs(net), "credit": 0.0,
                "description": "Opening Balance Equity — balancing entry",
            })
            dr_total += abs(net)

    je_id_check = f"qbo-opening-balances-{company_id[:8]}"
    assert je_id_check == je_id, "je_id must match the pre-clear key"
    now = now_iso()
    je_doc = {
        "id": je_id,
        "company_id": company_id,
        "date": "2000-01-01",  # well before any real activity
        "description": "QBO migration — opening balances (Fixed Assets, "
                        "Long-Term Liabilities, Other Current Liabilities)",
        "source": "qbo_migration",
        "posted": True,
        "human_reviewed": True,
        "lines": lines,
        "total": round(max(dr_total, cr_total), 2),
        "created_at": now, "updated_at": now,
    }
    await db.journal_entries.update_one(
        {"id": je_id, "company_id": company_id},
        {"$set": je_doc}, upsert=True,
    )
    return {"posted_je_id": je_id,
             "line_count": len(lines),
             "gross_debits": round(sum(l.get("debit", 0.0) for l in lines), 2),
             "gross_credits": round(sum(l.get("credit", 0.0) for l in lines), 2)}


async def resolve_tax_rates(company_id: str) -> dict:
    """Fetch QBO's `TaxRate` + `TaxAgency` and cache each rate's
    agency-name mapping in `db.tax_rates` so `compute_balance_sheet`
    can route Invoice `TxnTaxDetail.TaxLine` amounts to the correct
    sales-tax-payable account. Idempotent — upserts by
    `(company_id, qbo_id)`. Feb 28 2026 — sales-tax parity.
    """
    conn = await db.qbo_connections.find_one({"company_id": company_id})
    if not conn:
        return {"rates_upserted": 0, "reason": "no_connection"}
    realm = conn["realm_id"]
    try:
        rr = await _get(company_id, realm, f"/company/{realm}/query",
                          {"query": "select * from TaxRate"})
        ar = await _get(company_id, realm, f"/company/{realm}/query",
                          {"query": "select * from TaxAgency"})
    except Exception:  # noqa: BLE001 — transient QBO error
        return {"rates_upserted": 0, "reason": "qbo_fetch_failed"}
    agencies = {str(a.get("Id")): a.get("DisplayName") or ""
                for a in (ar.get("QueryResponse") or {}).get("TaxAgency", [])}
    upserted = 0
    for tr in (rr.get("QueryResponse") or {}).get("TaxRate", []):
        qid = str(tr.get("Id") or "")
        if not qid:
            continue
        agency_id = str((tr.get("AgencyRef") or {}).get("value") or "")
        agency_name = agencies.get(agency_id, "")
        await db.tax_rates.update_one(
            {"company_id": company_id, "qbo_id": qid},
            {"$set": {
                "company_id": company_id,
                "qbo_id": qid,
                "name": tr.get("Name") or "",
                "rate": float(tr.get("RateValue") or 0),
                "agency_qbo_id": agency_id,
                "agency_name": agency_name,
                "source": "qbo",
                "updated_at": now_iso(),
            }},
            upsert=True,
        )
        upserted += 1
    return {"rates_upserted": upserted}


async def resolve_item_accounts_and_tracking(company_id: str) -> dict:
    """Post-import resolver — for QBO-imported items, translate the
    stored `*_account_qbo_id` fields into local `*_account_id`s and
    flip `track_inventory=True` for real inventory items.

    Why this exists
    ---------------
    The migration pipeline runs `map_item` which stores QBO's account
    IDs and Type enum, but the *_account_id resolution and internal
    `track_inventory` flag are only set by `_pull_items` in the
    ongoing mirror pull — so companies that finished migrating but
    never triggered a subsequent mirror have items with `type=
    'inventory'` yet `track_inventory=None`, making the Inventory
    Management page look empty even though QBO tracked qty-on-hand
    for those items. Sandbox 358d Craig's Landscaping: 4 real
    Inventory items (Pump, Rock Fountain, Sprinkler Heads,
    Sprinkler Pipes) all silent on the Inventory page.

    Idempotent — writes only when a field is missing/wrong.

    Aug 21 2026 — QBO inventory visibility fix.
    """
    # Cache accounts by qbo_id for fast lookup.
    acct_by_qbo: dict[str, dict] = {}
    async for a in db.accounts.find(
        {"company_id": company_id, "source": "qbo",
          "qbo_id": {"$ne": None}}):
        acct_by_qbo[str(a.get("qbo_id"))] = a

    resolved = 0
    flipped = 0
    async for it in db.items.find({"company_id": company_id,
                                     "source": "qbo"}):
        patch: dict = {}
        asset_qid = str(it.get("asset_account_qbo_id") or "")
        exp_qid   = str(it.get("expense_account_qbo_id") or "")
        inc_qid   = str(it.get("income_account_qbo_id") or "")

        if asset_qid and not it.get("inventory_account_id"):
            a = acct_by_qbo.get(asset_qid)
            if a:
                patch["inventory_account_id"] = a["id"]
                patch["inventory_account_name"] = a.get("name")
        if exp_qid and (not it.get("cogs_account_id")
                          or not it.get("expense_account_id")):
            a = acct_by_qbo.get(exp_qid)
            if a:
                patch["cogs_account_id"] = a["id"]
                patch["expense_account_id"] = a["id"]
        if inc_qid and not it.get("income_account_id"):
            a = acct_by_qbo.get(inc_qid)
            if a:
                patch["income_account_id"] = a["id"]

        # Flip on `track_inventory` for real inventory items.
        want_track = (
            (it.get("item_type") or "").lower() == "inventory"
            or bool(it.get("track_qty_on_hand"))
        )
        if want_track and not it.get("track_inventory"):
            patch["track_inventory"] = True
            flipped += 1

        # Seed `cost_basis` from QBO's `PurchaseCost` (stored as
        # `cost`) so the Inventory Valuation report shows a starting
        # value on migration. `cost_basis` maintains the weighted-
        # average unit cost via subsequent inventory movements, so
        # only seed when it's empty.
        if want_track and not it.get("cost_basis"):
            qbo_cost = float(it.get("cost") or 0)
            if qbo_cost > 0.005:
                patch["cost_basis"] = qbo_cost

        if patch:
            patch["updated_at"] = now_iso()
            await db.items.update_one({"id": it["id"]},
                                        {"$set": patch})
            resolved += 1

    return {"items_resolved": resolved,
             "tracking_flipped": flipped}




async def resolve_qbo_sales_tax_payments(company_id: str) -> dict:
    """Synthesize the "Sales Tax Payment" QBO txns that reduce a
    sales-tax-payable account and its funding bank. QBO's REST API
    doesn't expose `SalesTaxPayment` as a queryable entity
    (returns 400), and its "Purchase" endpoint doesn't include
    them either — but the GeneralLedger report DOES surface them
    per-account. We walk the GL for each `GlobalTaxPayable`
    account, find every DR posting (payment to the tax agency),
    and post a matching JE that DR's the payable / CR's the
    funding Checking account.

    Fixes two drifts at once on Craig's Landscaping:
      - Checking is $76.90 too high because two Sales Tax Payments
        ($38.50 + $38.40) never CR'd Checking on our side.
      - BoE Payable is $38.50 and AZ Payable is $38.40 too high
        because their DR postings weren't captured.

    Idempotent — deletes then re-posts a single "sales-tax-
    payments" JE keyed by company. Feb 28 2026.
    """
    conn = await db.qbo_connections.find_one({"company_id": company_id})
    if not conn:
        return {"lines_added": 0, "reason": "no_connection"}
    realm = conn["realm_id"]

    # Sales-tax-payable accounts.
    payables: list[dict] = []
    async for a in db.accounts.find({
        "company_id": company_id,
        "raw.AccountSubType": "GlobalTaxPayable",
    }):
        if a.get("qbo_id"):
            payables.append(a)
    if not payables:
        return {"lines_added": 0, "reason": "no_tax_payables"}

    # Fund-side bank accounts. We walk each bank's GL for the CR side
    # of the Sales Tax Payment so we can match date + amount to the
    # payable's DR side. QBO's `split_account` column shows "-Split-"
    # for any STP that also carries a bank-fee expense line, so the
    # naive `split → bank name` lookup misses everything but the
    # single-line cases. Two-sided GL match handles both.
    banks: list[dict] = []
    async for a in db.accounts.find({
        "company_id": company_id,
        "detail_type": "cash_and_bank",
    }):
        if a.get("qbo_id"):
            banks.append(a)

    # bank_credits[(date, abs_amount)] = [bank_acct_id, ...]
    bank_credits: dict[tuple, list[str]] = {}
    for bank in banks:
        try:
            gl = await fetch_report(
                company_id, realm, "GeneralLedger",
                {"start_date": "2000-01-01",
                 "end_date": now_iso()[:10],
                 "account": str(bank["qbo_id"]),
                 "accounting_method": "Accrual"},
            )
        except Exception:  # noqa: BLE001
            continue
        for p in _flatten_gl_rows((gl.get("Rows") or {}).get("Row") or []):
            if p.get("txn_type") != "Sales Tax Payment":
                continue
            amt = p.get("amount", 0)
            # CR on a bank = negative signed amount (cash out).
            if amt >= -0.005:
                continue
            key = (p.get("date") or "", round(abs(amt), 2))
            bank_credits.setdefault(key, []).append(bank["id"])

    lines: list[dict] = []
    for pay_acct in payables:
        try:
            gl = await fetch_report(
                company_id, realm, "GeneralLedger",
                {"start_date": "2000-01-01",
                 "end_date": now_iso()[:10],
                 "account": str(pay_acct["qbo_id"]),
                 "accounting_method": "Accrual"},
            )
        except Exception:  # noqa: BLE001
            continue
        for p in _flatten_gl_rows((gl.get("Rows") or {}).get("Row") or []):
            # DR postings on a tax-payable = a payment TO the agency
            # (reduces the natural credit balance). QBO's `amount`
            # is signed toward the account's natural side, so a
            # payment reads as NEGATIVE on a credit-normal liability.
            amt = p.get("amount", 0)
            if amt >= -0.005:
                continue  # skip credits (accrued tax from invoices)
            if p.get("txn_type") != "Sales Tax Payment":
                continue
            abs_amt = round(abs(amt), 2)
            date = p.get("date") or ""
            # Two-sided match: find the bank whose GL has a CR of the
            # same amount on the same date.
            key = (date, abs_amt)
            candidates = bank_credits.get(key) or []
            if not candidates:
                # Fallback (single-line split case) — resolve via the
                # `split` column when it names a real bank account.
                bank_id = next(
                    (b["id"] for b in banks
                      if (b.get("name") or "").lower()
                          == (p.get("split") or "").lower()),
                    None,
                )
                if not bank_id:
                    continue
            else:
                # Consume one candidate so a repeated same-day/same-amt
                # payment routes to a different bank if applicable.
                bank_id = candidates.pop(0)
            # DR the payable, CR the bank.
            lines.append({"account_id": pay_acct["id"],
                            "account_qbo_id": pay_acct.get("qbo_id"),
                            "debit": abs_amt, "credit": 0.0,
                            "date": date,
                            "memo": "QBO Sales Tax Payment"})
            lines.append({"account_id": bank_id,
                            "debit": 0.0, "credit": abs_amt,
                            "date": date,
                            "memo": "QBO Sales Tax Payment"})

    je_id = f"qbo-sales-tax-payments-{company_id[:8]}"
    await db.journal_entries.delete_many({"id": je_id,
                                            "company_id": company_id})
    if not lines:
        return {"lines_added": 0}
    await db.journal_entries.insert_one({
        "id": je_id, "company_id": company_id, "source": "qbo",
        "posted": True,
        "date": max(l["date"] for l in lines if l.get("date")),
        "memo": "Synthesized Sales Tax Payments from QBO GL",
        "lines": lines,
        "created_at": now_iso(), "updated_at": now_iso(),
    })
    return {"lines_added": len(lines),
             "payables_scanned": len(payables)}


async def resolve_payment_undeposited(company_id: str) -> dict:
    """Stamp `deposit_to_account_id` (native) and `deposit_account_qbo_id`
    (QBO) on customer payments (direction='in') that lack a resolvable
    cash-side account. QBO's default behaviour is to hold such receipts
    in the Undeposited Funds account until a Bank Deposit sweeps them
    into a bank; Axiom mirrors that so the Balance Sheet asset column
    reflects the held cash.

    Two-part backfill:
      1. QBO payments — if `deposit_account_qbo_id` is None and the
         raw payload's CheckPayment/CreditCardPayment refs are also
         empty, stamp the QBO Undeposited Funds account's `qbo_id`.
      2. Native payments — if `deposit_to_account_id` is None and there
         is no `source_transaction_id` linking it to a bank txn, stamp
         the local Undeposited Funds account id.

    Idempotent — payments already carrying a deposit reference are
    left untouched. Returns
    ``{"qbo_stamped": N, "native_stamped": M, "undep_found": bool}``.
    """
    undep = await db.accounts.find_one({
        "company_id": company_id,
        "$or": [{"detail_type": "money_in_transit"},
                {"name": {"$regex": "^Undeposited Funds$",
                          "$options": "i"}}],
    })
    if not undep:
        return {"qbo_stamped": 0, "native_stamped": 0,
                "undep_found": False}
    undep_id = undep["id"]
    undep_qbo_id = undep.get("qbo_id")

    qbo_stamped = 0
    if undep_qbo_id:
        async for p in db.payments.find({
            "company_id": company_id,
            "source": "qbo",
            "direction": "in",
            "$or": [{"deposit_account_qbo_id": None},
                    {"deposit_account_qbo_id": ""},
                    {"deposit_account_qbo_id": {"$exists": False}}],
        }):
            # Double-check the raw payload isn't hiding a valid ref —
            # only stamp UF when the QBO doc genuinely omits the field.
            raw = p.get("raw") or {}
            cp = raw.get("CheckPayment") or {}
            cc = raw.get("CreditCardPayment") or {}
            if ((cp.get("BankAccountRef") or {}).get("value")
                    or (cc.get("CCAccountRef") or {}).get("value")
                    or (raw.get("DepositToAccountRef") or {}).get("value")):
                continue
            await db.payments.update_one(
                {"id": p["id"]},
                {"$set": {"deposit_account_qbo_id": str(undep_qbo_id),
                          "held_in_undeposited": True,
                          "updated_at": now_iso()}},
            )
            qbo_stamped += 1

    native_stamped = 0
    async for p in db.payments.find({
        "company_id": company_id,
        "source": {"$ne": "qbo"},
        "direction": "in",
        "$and": [
            {"$or": [{"deposit_to_account_id": None},
                     {"deposit_to_account_id": ""},
                     {"deposit_to_account_id": {"$exists": False}}]},
            {"$or": [{"source_transaction_id": None},
                     {"source_transaction_id": ""},
                     {"source_transaction_id": {"$exists": False}}]},
        ],
    }):
        await db.payments.update_one(
            {"id": p["id"]},
            {"$set": {"deposit_to_account_id": undep_id,
                      "held_in_undeposited": True,
                      "updated_at": now_iso()}},
        )
        native_stamped += 1

    return {"qbo_stamped": qbo_stamped,
            "native_stamped": native_stamped,
            "undep_found": True}




async def resolve_deposit_splits(company_id: str) -> dict:
    """Populate `splits[]` on QBO-imported Deposit transactions so the
    credit-side of each Deposit line hits the correct source account.

    Why this exists
    ---------------
    A QBO Deposit is a bank-side inflow that can group multiple sources.
    Each `Line` on the Deposit is either:
      A. `DepositLineDetail.AccountRef` — direct income posted straight
         to the bank (e.g. an interest deposit → CR Interest Income).
      B. `LinkedTxn` (Payment / SalesReceipt) — a sweep from Undep to
         the destination bank. QBO doesn't spell out the source account
         because "everything with a LinkedTxn is coming from Undep."

    Without this resolver, our ledger only records the DR-to-bank side
    of every Deposit — the offsetting credit (either to Undep or to the
    direct-income account) is silently dropped. Result: Checking and
    Undeposited Funds are BOTH inflated on the BS by the total swept
    amount, because Deposits DR Checking without CRing Undep, and the
    upstream Payment IN sits in Undep with no offset. Regression seen
    on both Craig's-Design realms (a026 and 2457): Checking +$1,876.90
    and Undep +$1,694.90 in identical amounts. Feb 26 2026.

    What we write
    -------------
    For each Deposit txn with line_items and no existing splits, we
    build a `splits[]` list with one entry per line:
      - `account_id`: local account id of the credit side
      - `amount`: line amount (positive)
    `_signed_balances` then subtracts each split from the source
    account (CR side), balancing the DR to the bank account already
    posted from `bank_account_id`.

    Returns {"txns_updated": N, "splits_added": M, "undep_fallbacks": K}.
    Idempotent — re-running is safe; transactions with existing
    `splits` are skipped.
    """
    # Cache the company's Undeposited Funds and account-by-qbo_id map.
    undep = await db.accounts.find_one({
        "company_id": company_id,
        "$or": [{"detail_type": "money_in_transit"},
                {"name": {"$regex": "^Undeposited Funds$",
                          "$options": "i"}}],
    })
    undep_id = undep["id"] if undep else None
    acct_by_qbo_id: dict[str, str] = {}
    async for a in db.accounts.find({"company_id": company_id,
                                       "qbo_id": {"$ne": None}}):
        acct_by_qbo_id[str(a["qbo_id"])] = a["id"]

    txns_updated = 0
    splits_added = 0
    undep_fallbacks = 0
    cashback_captured = 0

    async for t in db.transactions.find({"company_id": company_id,
                                           "source": "qbo",
                                           "txn_type": "Deposit"}):
        if t.get("splits"):
            continue
        lines = t.get("line_items") or []
        if not lines:
            continue
        splits: list[dict] = []
        for ln in lines:
            amt = float(ln.get("amount") or 0)
            if abs(amt) < 0.005:
                continue
            src_qbo = ln.get("account_qbo_id")
            src_id = acct_by_qbo_id.get(str(src_qbo)) if src_qbo else None
            if not src_id:
                # LinkedTxn-only line → sweep from Undep. Fall back to
                # the company's Undeposited Funds account.
                if not undep_id:
                    continue  # nothing sane we can do without an Undep
                src_id = undep_id
                undep_fallbacks += 1
            splits.append({
                "account_id": src_id,
                "category_account_id": src_id,  # legacy alias
                "amount": round(amt, 2),
                "source": "qbo_deposit_line",
            })
        # QBO's Deposit form has a "Cash back goes to" section that
        # routes part of the deposit total straight into a second bank
        # account (e.g. clerk pockets $200 of cash into Savings while
        # the rest lands in Checking). QBO models this as a top-level
        # `CashBack` object on the raw doc, NOT as a Line row — so it
        # never shows up in `line_items`. Without capturing it, the
        # ledger only DRs the primary bank (Checking) while the source
        # CRs (via splits) reflect the FULL line-sum, leaving the
        # CashBack amount stuck on `category_account_id` as
        # Uncategorized Income. On QBO Test 553 LLC, Deposit 121
        # dropped $200 into Savings — we were showing that as -$200
        # revenue on the P&L until this fix. Feb 28 2026.
        raw = t.get("raw") or {}
        cashback = raw.get("CashBack") or {}
        cb_amt = float(cashback.get("Amount") or 0)
        cb_qbo = ((cashback.get("AccountRef") or {}).get("value"))
        if abs(cb_amt) >= 0.005 and cb_qbo:
            cb_local = acct_by_qbo_id.get(str(cb_qbo))
            if cb_local:
                # Negative-amount split → `_signed_balances` computes
                # `by[cb_local] += -(-cb_amt) = +cb_amt` → DR to the
                # cashback destination bank. Pairs with the primary
                # bank DR (`bank_account_id`) so total DRs equal total
                # line-sum CRs, keeping the entry balanced.
                splits.append({
                    "account_id": cb_local,
                    "category_account_id": cb_local,
                    "amount": -round(cb_amt, 2),
                    "source": "qbo_deposit_cashback",
                })
                cashback_captured += 1
        if not splits:
            continue
        await db.transactions.update_one(
            {"_id": t["_id"]},
            {"$set": {"splits": splits,
                       "updated_at": now_iso()}},
        )
        txns_updated += 1
        splits_added += len(splits)

    return {"txns_updated": txns_updated,
             "splits_added": splits_added,
             "undep_fallbacks": undep_fallbacks,
             "cashback_captured": cashback_captured}







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

        # ---- Resolve each line to its own account ---------------------
        # If the transaction has multiple lines resolving to DIFFERENT
        # accounts, we build splits so the P&L breaks the revenue out
        # per child account (Beverages vs Takeout vs …) instead of
        # lumping everything into the first-line's parent bucket.
        line_accts: list[tuple[dict, float]] = []
        # New Feb 27 2026 — also collect the resolved local id per
        # line so we can write it back onto `line_items[i].account_id`.
        # `_signed_balances` doesn't read line_items directly for
        # transactions (it uses the top-level `category_account_id` +
        # `splits`), but the Transactions page filters and the P&L
        # drill-down DO — leaving `line_items[].account_id = None`
        # after import breaks both.
        resolved_line_ids: list[str | None] = []
        for ln in t.get("line_items") or []:
            amt = float(ln.get("amount") or 0)
            resolved = None
            aqid = ln.get("account_qbo_id")
            if aqid:
                resolved = qbo_to_local.get(str(aqid))
            if not resolved:
                iqid = ln.get("item_qbo_id")
                if iqid:
                    inc, exp = item_to_accts.get(str(iqid), ("", ""))
                    candidate_qid = exp if outbound else inc
                    if not candidate_qid:
                        candidate_qid = inc or exp
                    if candidate_qid:
                        resolved = qbo_to_local.get(candidate_qid)
            resolved_line_ids.append(resolved["id"] if resolved else None)
            if resolved and abs(amt) >= 0.005:
                line_accts.append((resolved, amt))

        picked = line_accts[0][0] if line_accts else None
        # If two or more lines resolve to different local accounts,
        # emit them as splits so `_signed_balances` posts each amount
        # to its own bucket. Single-account (or single-line) txns keep
        # the flat `category_account_id` path.
        distinct_accts = {a["id"] for a, _ in line_accts}
        splits_payload: list[dict] | None = None
        if len(distinct_accts) > 1:
            agg: dict[str, dict] = {}
            for a, amt in line_accts:
                s = agg.setdefault(a["id"], {
                    "category_account_id": a["id"],
                    "category_account_code": a.get("code") or "",
                    "category_account_name": a.get("name") or "",
                    "amount": 0.0,
                })
                s["amount"] += amt
            splits_payload = [
                {**s, "amount": round(s["amount"], 2)} for s in agg.values()
            ]

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
        update_doc = {
            "category_account_id": picked["id"],
            "category_account_code": picked.get("code") or "",
            "category_account_name": picked.get("name") or "",
            "updated_at": now_iso(),
        }
        if splits_payload:
            update_doc["splits"] = splits_payload
        # Also stamp `account_id` on each line_item so drill-downs
        # from the P&L / BS / Transactions page can filter by GL
        # account. Purely additive — the field wasn't there before,
        # so no risk of overwriting.
        raw_lines = t.get("line_items") or []
        if raw_lines and any(rid for rid in resolved_line_ids):
            new_lines = []
            for i, ln in enumerate(raw_lines):
                rid = resolved_line_ids[i] if i < len(resolved_line_ids) else None
                new_lines.append({**ln, "account_id": rid} if rid else ln)
            update_doc["line_items"] = new_lines
        await db.transactions.update_one(
            {"id": t["id"]},
            {"$set": update_doc},
        )
        updated += 1
    return updated



async def resolve_journal_entry_line_accounts(company_id: str) -> int:
    """Backfill `journal_entries.lines[i].account_id` from each line's
    `account_qbo_id` using the local QBO account map.

    QBO's JE payload only carries `AccountRef.value` (the QBO id) on
    each line. `map_journal_entry` stores it as `account_qbo_id` — but
    `_signed_balances` (reports.py) reads `line.account_id` (our local
    id), so unless we translate the qbo_id here, every JE line's ledger
    impact silently disappears from the BS and P&L. BM QBO 2 LLC
    (Feb 27 2026) had 293 of 299 lines dropped for exactly this
    reason, hiding ~$154k of income and ~$90k of expense.

    Idempotent — only touches lines whose `account_id` is currently
    empty. Deleted-account lines (`Partners Clearing (deleted)`, etc.)
    resolve too once `query_all` starts pulling inactive accounts.
    """
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
    async for j in db.journal_entries.find(
        {"company_id": company_id, "source": "qbo"},
        {"id": 1, "lines": 1},
    ):
        raw_lines = j.get("lines") or []
        if not raw_lines:
            continue
        changed = False
        new_lines = []
        for ln in raw_lines:
            if ln.get("account_id"):
                new_lines.append(ln)
                continue
            aqid = ln.get("account_qbo_id")
            local_id = qbo_to_local.get(str(aqid)) if aqid else None
            if local_id:
                new_lines.append({**ln, "account_id": local_id})
                changed = True
            else:
                new_lines.append(ln)
        if changed:
            await db.journal_entries.update_one(
                {"id": j["id"]},
                {"$set": {"lines": new_lines, "updated_at": now_iso()}},
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



# ----------------------------------------------------------------------
# QBO General Ledger — source-of-truth line-account resolver
# ----------------------------------------------------------------------

def _flatten_gl_rows(rows: list) -> list[dict]:
    """Walk QBO GeneralLedger nested Row tree and yield each data row
    as `{txn_type, doc_num, name, memo, amount}`. GL rows are grouped
    by account under nested `Header` sections — we don't care about
    the grouping here because the caller pins the fetch to one
    account at a time."""
    out: list[dict] = []
    def walk(rs):
        for r in rs or []:
            inner = (r.get("Rows") or {}).get("Row") or []
            if inner:
                walk(inner)
            cd = r.get("ColData")
            if cd:
                # Column shape: [tx_date, txn_type, doc_num, name,
                #                memo, split_account, amount, balance]
                v = [c.get("value", "") for c in cd]
                if len(v) < 7:
                    continue
                try:
                    amt = float(v[6] or 0)
                except (ValueError, TypeError):
                    continue
                out.append({
                    "date": v[0],
                    "txn_type": v[1],
                    "doc_num": v[2],
                    "name": v[3],
                    "memo": v[4],
                    "split": v[5],
                    "amount": amt,
                })
    walk(rows)
    return out


async def resolve_qbo_gl_line_accounts(
    company_id: str,
    start_date: str = "2020-01-01",
    end_date: str | None = None,
) -> dict:
    """Use QBO's General Ledger as source-of-truth to stamp
    line-level `account_qbo_id` on QBO-imported invoices, bills,
    sales receipts, and refund receipts.

    Why this exists
    ---------------
    Historical postings in QBO can diverge from an Item's CURRENT
    `IncomeAccountRef` / `ExpenseAccountRef` — QBO users routinely
    reassign items to new accounts over time, but past invoices
    retain the account in effect at the moment of posting. Our line
    mapper resolves via the CURRENT item mapping, so per-account
    totals drift from QBO's actual GL by the amount of any
    reassigned item's historical activity. On QBO Test 553 LLC this
    was ~$3.5k of P&L drift (Beverages -$1,695, Sales of Product
    Income +$1,833, Catering missing $138).

    What we do
    ----------
    For every revenue / expense / COGS account, pull QBO's
    GeneralLedger and iterate its postings. Match each posting to
    our stored invoice/bill/SR line by `(doc_num, txn_type, amount,
    memo)` and stamp `account_qbo_id` on that line. Then re-run
    `resolve_transaction_categories` so the stamped accounts flow
    through to `category_account_id` / `splits[]`.

    Match strategy
    --------------
    - Primary: `(doc_num, amount, memo)` — the memo column contains
      the item name for SalesItemLineDetail lines, so it's usually
      distinctive enough within a single invoice.
    - Fallback: `(doc_num, amount)` — safe when only one line in
      the doc has that amount.
    - We DO NOT match by amount alone across docs — false positives
      would silently misroute revenue.

    Returns `{"lines_stamped": N, "accounts_scanned": M,
              "docs_touched": K, "skipped_ambiguous": S}`.
    Idempotent: re-running only overwrites `account_qbo_id` when
    the GL disagrees with the stored value.
    """
    conn = await db.qbo_connections.find_one({"company_id": company_id})
    if not conn:
        return {"lines_stamped": 0, "accounts_scanned": 0,
                "docs_touched": 0, "skipped_ambiguous": 0,
                "reason": "no_qbo_connection"}
    realm_id = conn["realm_id"]
    if not end_date:
        from datetime import date
        end_date = date.today().isoformat()

    # Pull all revenue/expense/cogs accounts with a QBO id — those
    # are the ones the GL will surface line-item postings for.
    #
    # ORDER MATTERS: QBO's GeneralLedger for a parent account rolls
    # up child activity (e.g. fetching GL for `Food & Supplies` also
    # lists postings that actually hit its child `Beverages`). If we
    # stamp parents before children, the parent's rollup overwrites
    # the child's leaf-level stamp — every Wine Bottle line ends up
    # on `Food & Supplies` instead of `Beverages`. Process leaves
    # first (deepest child → shallow parent) so leaves win, and skip
    # any line already marked `gl_verified`.
    all_accts_map: dict[str, dict] = {}
    async for a in db.accounts.find(
        {"company_id": company_id, "source": "qbo", "qbo_id": {"$ne": None}},
        {"id": 1, "qbo_id": 1, "name": 1, "type": 1, "parent_qbo_id": 1, "_id": 0},
    ):
        all_accts_map[str(a["qbo_id"])] = a
    # Depth = length of parent chain up to the root.
    def _depth(a: dict) -> int:
        d, cur = 0, a
        seen: set[str] = set()
        while cur and cur.get("parent_qbo_id"):
            key = str(cur["parent_qbo_id"])
            if key in seen:
                break  # defensive: cyclic chain
            seen.add(key)
            cur = all_accts_map.get(key)
            d += 1
        return d
    scan_accts = [
        a for a in all_accts_map.values()
        if a.get("type") in ("revenue", "expense", "cogs")
    ]
    scan_accts.sort(key=lambda a: -_depth(a))  # leaves first

    if not scan_accts:
        return {"lines_stamped": 0, "accounts_scanned": 0,
                "docs_touched": 0, "skipped_ambiguous": 0}

    # (doc_num, txn_type) → doc summary so we can match GL rows back
    # to our stored line items. `txn_type` alignment: QBO's GL uses
    # "Sales Receipt" (with space), our stored `txn_type` is
    # "SalesReceipt" (no space). Normalize both to compare.
    def _norm_type(s: str) -> str:
        return (s or "").replace(" ", "").lower()

    # Preload every QBO invoice / bill / SR / RR keyed by (doc_num,
    # normalized txn_type).
    #
    # Invoice/Bill live in dedicated collections; SR/RR live in
    # `db.transactions` under their own txn_type.
    docs_by_key: dict[tuple[str, str], dict] = {}
    async for inv in db.invoices.find({"company_id": company_id, "source": "qbo"}):
        num = (inv.get("number") or "").strip()
        if num:
            docs_by_key[(num, "invoice")] = {
                "coll": "invoices",
                "doc": inv,
            }
    async for bill in db.bills.find({"company_id": company_id, "source": "qbo"}):
        num = (bill.get("number") or "").strip()
        if num:
            docs_by_key[(num, "bill")] = {
                "coll": "bills",
                "doc": bill,
            }
    async for txn in db.transactions.find({
        "company_id": company_id, "source": "qbo",
        "txn_type": {"$in": ["SalesReceipt", "RefundReceipt", "CreditMemo"]},
    }):
        num = (txn.get("number") or "").strip()
        tt = _norm_type(txn.get("txn_type") or "")
        if num and tt:
            docs_by_key[(num, tt)] = {
                "coll": "transactions",
                "doc": txn,
            }

    lines_stamped = 0
    docs_touched: set[str] = set()
    skipped_ambiguous = 0

    for acct in scan_accts:
        try:
            gl = await fetch_report(
                company_id, realm_id, "GeneralLedger",
                {"start_date": start_date, "end_date": end_date,
                 "account": str(acct["qbo_id"]),
                 "accounting_method": "Accrual"},
            )
        except Exception:  # noqa: BLE001
            # Skip on transient QBO API errors — resolver is retry-safe.
            continue
        rows = (gl.get("Rows") or {}).get("Row") or []
        postings = _flatten_gl_rows(rows)
        if not postings:
            continue

        for p in postings:
            num = (p.get("doc_num") or "").strip()
            tt = _norm_type(p.get("txn_type") or "")
            if not num or not tt:
                continue
            entry = docs_by_key.get((num, tt))
            if not entry:
                continue
            doc = entry["doc"]
            lines = doc.get("line_items") or []
            if not lines:
                continue

            # Match by (amount + memo/description) first — memo often
            # carries the item name so it disambiguates same-amount
            # lines. Fall back to amount-only when unique.
            gl_amt = round(p["amount"], 2)
            gl_memo = (p.get("memo") or "").strip().lower()

            candidates: list[int] = []
            for i, ln in enumerate(lines):
                if abs(round(float(ln.get("amount") or 0), 2) - gl_amt) > 0.01:
                    continue
                candidates.append(i)
            if not candidates:
                continue

            # Prefer the candidate whose memo/description or item_name
            # matches the GL memo.
            picked_i: int | None = None
            if len(candidates) == 1:
                picked_i = candidates[0]
            else:
                for i in candidates:
                    ln = lines[i]
                    hay = " ".join([
                        (ln.get("description") or "").lower(),
                        (ln.get("item_name") or "").lower(),
                    ])
                    if gl_memo and gl_memo in hay:
                        picked_i = i
                        break
                if picked_i is None:
                    # Ambiguous — leave alone rather than misroute.
                    skipped_ambiguous += 1
                    continue

            ln = lines[picked_i]
            # Once a line is `gl_verified`, we trust the leaf-level
            # stamp — do NOT overwrite even if a parent's rollup GL
            # tries to reroute it. Leaves scanned first (see the
            # depth sort above); parents come later and are skipped
            # here.
            if ln.get("gl_verified"):
                continue

            existing = str(ln.get("account_qbo_id") or "")
            wanted = str(acct["qbo_id"])

            # Stamp the correct account onto this line. Update the
            # in-memory `lines` list too so subsequent postings in
            # the same doc don't re-match this line.
            ln["account_qbo_id"] = wanted
            ln["account_name"] = acct.get("name") or ln.get("account_name")
            ln["gl_verified"] = True
            lines[picked_i] = ln

            # Persist. Small-write pattern: update the individual
            # line via array index so we don't rewrite the whole
            # doc every posting.
            await db[entry["coll"]].update_one(
                {"id": doc["id"]},
                {"$set": {f"line_items.{picked_i}.account_qbo_id": wanted,
                          f"line_items.{picked_i}.account_name": ln.get("account_name"),
                          f"line_items.{picked_i}.gl_verified": True,
                          "updated_at": now_iso()}},
            )
            lines_stamped += 1
            docs_touched.add(doc["id"])

    # Re-resolve categories/splits so the newly-stamped account_qbo_id
    # values propagate into `category_account_id` and `splits[]` on
    # any SR/RR/CM transactions we touched. Invoices/bills are read
    # directly by `_signed_balances`' accrual layer, so they pick up
    # the new account_qbo_id on the next report run — no separate
    # resolver pass needed.
    if docs_touched:
        # Clear existing category on touched SR/RR/CM docs so the
        # resolver re-picks with the new line accounts.
        await db.transactions.update_many(
            {"company_id": company_id,
             "id": {"$in": list(docs_touched)},
             "source": "qbo",
             "txn_type": {"$in": ["SalesReceipt", "RefundReceipt", "CreditMemo"]}},
            {"$unset": {"category_account_id": "",
                        "category_account_code": "",
                        "category_account_name": "",
                        "splits": ""}},
        )
        await resolve_transaction_categories(company_id)

    return {"lines_stamped": lines_stamped,
            "accounts_scanned": len(scan_accts),
            "docs_touched": len(docs_touched),
            "skipped_ambiguous": skipped_ambiguous}
