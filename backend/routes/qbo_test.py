"""Test QBO Migration — completely isolated raw-data mirror.

Purpose
-------
An experimental sandbox for exercising the QBO migration without
touching the production migration pipeline OR any of the downstream
collections (`accounts`, `items`, `invoices`, `bills`, `payments`,
`transactions`, `journal_entries`, etc.). Every entity is stored
verbatim from QBO's API into a single isolated collection —
`qbo_test_raw` — keyed by (company_id, entity_type, qbo_id). Nothing
else is stamped, resolved, or synthesised.

Test QBO uses its OWN OAuth connection stored in the isolated
`qbo_test_connections` collection — production `qbo_connections` is
never touched by any Test QBO action. Users can connect BOTH (running
the same QBO realm through two separate token sets) without either
affecting the other. The OAuth callback dispatches on the state row's
`mode` field.

Endpoints
---------
- POST /api/companies/{cid}/qbo-test/oauth/start — Start Test QBO OAuth
- POST /api/companies/{cid}/qbo-test/disconnect  — Drop the test conn.
- POST /api/companies/{cid}/qbo-test/migrate     — Wipe + fresh entity pull
- POST /api/companies/{cid}/qbo-test/reports/refresh — Pull BS + P&L
- GET  /api/companies/{cid}/qbo-test/preview     — Counts per entity
- GET  /api/companies/{cid}/qbo-test/entity/{type} — Raw entity rows
- GET  /api/companies/{cid}/qbo-test/reports/{name} — Formatted report
- POST /api/companies/{cid}/qbo-test/reset       — Wipe all test data
"""
from __future__ import annotations

import secrets
from datetime import datetime, timezone, timedelta
from typing import Optional
from urllib.parse import urlparse

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel

from auth import get_current_user
from deps import require_company
from db import db
from db import now_iso
import qbo_service as Q


router = APIRouter(prefix="/api")


# The ContextVar in qbo_service is set to this string for the duration
# of every Test QBO request so the shared auth/HTTP helpers write to
# `qbo_test_connections` instead of the production `qbo_connections`.
_TEST_CONN_COLL = "qbo_test_connections"


def _use_test_conn():
    """Set the connection-collection ContextVar for the current
    request so Q.get_access_token, Q._get, etc. route through
    `qbo_test_connections`."""
    Q._conn_coll_var.set(_TEST_CONN_COLL)


# Entities from the Test QBO tile grid (matches the Connect QBO
# "Preview scope" panel 1:1). Order matches the UI grid: 3-column
# reading order left-to-right, top-to-bottom.
_ENTITIES: list[str] = [
    "Account",           # Chart of Accounts
    "Customer",
    "Vendor",
    "Item",
    "Invoice",
    "Bill",
    "Payment",           # Payments (received)
    "BillPayment",
    "JournalEntry",
    "Deposit",
    "Transfer",
    "CreditMemo",
    "SalesReceipt",
    "RefundReceipt",
    "Purchase",          # Purchases / Expenses
    "InventoryAdjustment",
    "Attachable",        # Attachments
]


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


async def _wipe_test_data(company_id: str) -> int:
    """Wipe entity rows + report snapshots. Leaves the test OAuth
    connection intact — use `disconnect` for that."""
    r1 = await db.qbo_test_raw.delete_many({"company_id": company_id})
    r2 = await db.qbo_test_reports.delete_many({"company_id": company_id})
    return r1.deleted_count + r2.deleted_count


async def _pull_entity(company_id: str, realm_id: str,
                       entity: str) -> tuple[int, Optional[str]]:
    """Pull every row of `entity` from QBO into `qbo_test_raw`. Uses
    the existing `Q.query_all` helper so environment routing, OAuth
    refresh, and pagination all work as in production — but the write
    lands in the isolated test collection only.

    Returns (row_count, error_message_or_None).
    """
    fetched_at = _now_iso()
    count = 0
    try:
        async for obj in Q.query_all(company_id, realm_id, entity):
            qbo_id = str(obj.get("Id") or "")
            if not qbo_id:
                continue
            await db.qbo_test_raw.insert_one({
                "company_id": company_id,
                "realm_id": realm_id,
                "entity_type": entity,
                "qbo_id": qbo_id,
                "fetched_at": fetched_at,
                "raw": obj,
            })
            count += 1
    except Exception as e:  # noqa: BLE001
        return count, str(e)[:400]
    return count, None


class MigrateResponse(BaseModel):
    ok: bool
    realm_id: str
    environment: str
    started_at: str
    finished_at: str
    wiped: int
    counts: dict
    errors: dict


@router.post("/companies/{cid}/qbo-test/migrate",
              response_model=MigrateResponse)
async def qbo_test_migrate(cid: str,
                            user: dict = Depends(get_current_user)):
    """Wipe existing test data then pull every supported entity fresh
    from QBO into `qbo_test_raw`. Uses the isolated `qbo_test_connections`
    OAuth connection.
    """
    await require_company(user, cid)
    _use_test_conn()
    conn = await db.qbo_test_connections.find_one({"company_id": cid})
    if not conn:
        raise HTTPException(400, "Test QBO is not connected — click "
                                   "Connect to QuickBooks Online first")
    realm_id = conn["realm_id"]
    environment = (conn.get("env")
                    or conn.get("environment")
                    or "sandbox")

    started_at = _now_iso()
    wiped = await _wipe_test_data(cid)
    counts: dict[str, int] = {}
    errors: dict[str, str] = {}
    for entity in _ENTITIES:
        n, err = await _pull_entity(cid, realm_id, entity)
        counts[entity] = n
        if err:
            errors[entity] = err
    finished_at = _now_iso()
    return MigrateResponse(
        ok=(not errors),
        realm_id=realm_id,
        environment=environment,
        started_at=started_at,
        finished_at=finished_at,
        wiped=wiped,
        counts=counts,
        errors=errors,
    )


@router.get("/companies/{cid}/qbo-test/preview")
async def qbo_test_preview(cid: str,
                            user: dict = Depends(get_current_user)):
    """Return {entity_type: count} for every supported entity. Powers
    the tile grid on the Test QBO page. Also includes the last
    fetched_at + environment when data is present."""
    await require_company(user, cid)
    conn = await db.qbo_test_connections.find_one({"company_id": cid})
    counts: dict[str, int] = {}
    for entity in _ENTITIES:
        counts[entity] = await db.qbo_test_raw.count_documents({
            "company_id": cid, "entity_type": entity,
        })
    last = await db.qbo_test_raw.find_one(
        {"company_id": cid}, sort=[("fetched_at", -1)])
    reports_available: dict[str, dict] = {}
    async for r in db.qbo_test_reports.find({"company_id": cid}):
        reports_available.setdefault(r["report_name"], {})[r["basis"]] = {
            "fetched_at": r.get("fetched_at"),
        }
    return {
        "entities": _ENTITIES,
        "counts": counts,
        "total": sum(counts.values()),
        "last_fetched_at": (last or {}).get("fetched_at"),
        "connected": bool(conn),
        "realm_id": (conn or {}).get("realm_id"),
        "environment": (conn or {}).get("env")
                        or (conn or {}).get("environment")
                        or "sandbox",
        "reports_available": reports_available,
    }


@router.get("/companies/{cid}/qbo-test/entity/{entity_type}")
async def qbo_test_entity(cid: str, entity_type: str,
                           limit: int = Query(50, ge=1, le=500),
                           skip: int = Query(0, ge=0),
                           user: dict = Depends(get_current_user)):
    """Return raw docs for the given entity type. Used by the tile
    drill-down modal to inspect exactly what QBO returned."""
    await require_company(user, cid)
    if entity_type not in _ENTITIES:
        raise HTTPException(400, f"Unsupported entity: {entity_type}")
    rows: list[dict] = []
    cursor = db.qbo_test_raw.find(
        {"company_id": cid, "entity_type": entity_type},
        {"_id": 0},
    ).skip(skip).limit(limit)
    async for r in cursor:
        rows.append(r)
    total = await db.qbo_test_raw.count_documents({
        "company_id": cid, "entity_type": entity_type,
    })
    return {"entity_type": entity_type, "total": total,
             "rows": rows, "skip": skip, "limit": limit}


@router.post("/companies/{cid}/qbo-test/reset")
async def qbo_test_reset(cid: str,
                          user: dict = Depends(get_current_user)):
    """Wipe test data only — leaves the QBO connection intact."""
    await require_company(user, cid)
    wiped = await _wipe_test_data(cid)
    return {"ok": True, "wiped": wiped}


# ------------------------------------------------------------------
# OAuth — isolated Test QBO connection
# ------------------------------------------------------------------

class OAuthStartIn(BaseModel):
    return_path: Optional[str] = "/test-qbo"


class OAuthStartOut(BaseModel):
    url: str


def _redirect_uri_from_request(request: Request) -> Optional[str]:
    """Same helper as the production QBO route — build the same
    Intuit callback URL so token exchange stays on the redirect_uri
    the auth URL was minted with. Test QBO reuses `/api/qbo/oauth/
    callback` (already registered with Intuit) and dispatches on the
    state row's `mode` field to route the callback to Test QBO."""
    host = request.headers.get("x-forwarded-host") or request.headers.get("host")
    scheme = request.headers.get("x-forwarded-proto") or "https"
    if not host:
        return None
    return f"{scheme}://{host}/api/qbo/oauth/callback"


def _return_to_host_from_request(request: Request) -> Optional[str]:
    for h in ("referer", "origin"):
        v = request.headers.get(h)
        if not v:
            continue
        try:
            p = urlparse(v)
            if p.scheme and p.netloc:
                return f"{p.scheme}://{p.netloc}"
        except Exception:  # noqa: BLE001
            pass
    return None


@router.post("/companies/{cid}/qbo-test/oauth/start",
              response_model=OAuthStartOut)
async def qbo_test_oauth_start(cid: str, request: Request,
                                body: OAuthStartIn = OAuthStartIn(),
                                user: dict = Depends(get_current_user)):
    """Kick off the Test QBO OAuth flow. Stamps the state row with
    `mode='test_qbo'` so the shared callback at `/api/qbo/oauth/callback`
    routes the token exchange into `qbo_test_connections` (leaving
    production `qbo_connections` untouched)."""
    await require_company(user, cid)
    state = secrets.token_urlsafe(32)
    redirect_uri = _redirect_uri_from_request(request)
    return_to_host = _return_to_host_from_request(request)
    comp = await db.companies.find_one({"id": cid}) or {}
    target_env = Q._norm_env(comp.get("qbo_env") or Q.QBO_ENV_DEFAULT)
    try:
        auth_url = Q.authorization_url(state, redirect_uri=redirect_uri,
                                        env=target_env)
    except RuntimeError as e:
        raise HTTPException(500, str(e)) from e
    await db.qbo_oauth_states.insert_one({
        "state": state,
        "company_id": cid,
        "user_id": user["id"],
        "redirect_uri": redirect_uri,
        "return_to_host": return_to_host,
        "return_path": body.return_path or "/test-qbo",
        "env": target_env,
        # Dispatch key — the shared callback reads this to route the
        # save into `qbo_test_connections` instead of `qbo_connections`.
        "mode": "test_qbo",
        "expires_at": (datetime.now(timezone.utc)
                        + timedelta(minutes=15)).isoformat(),
        "created_at": now_iso(),
    })
    return {"url": auth_url}


@router.post("/companies/{cid}/qbo-test/disconnect")
async def qbo_test_disconnect(cid: str,
                                user: dict = Depends(get_current_user)):
    """Drop the isolated Test QBO connection. Test data (entity rows +
    report snapshots) stays; call /reset separately if you also want
    to wipe those."""
    await require_company(user, cid)
    r = await db.qbo_test_connections.delete_many({"company_id": cid})
    return {"ok": True, "removed": r.deleted_count}


# ------------------------------------------------------------------
# Reports — Balance Sheet + Profit & Loss (Cash + Accrual)
# ------------------------------------------------------------------

# QBO API report names we support in the Test QBO workbench. `basis`
# is passed through as `accounting_method`. Windows default to a very
# wide range so the report shows the full company history — the UI
# exposes overridable date pickers on top of this.
_TEST_REPORTS = ["BalanceSheet", "ProfitAndLoss"]
_DEFAULT_START = "2020-01-01"
_DEFAULT_END = "2099-12-31"


@router.post("/companies/{cid}/qbo-test/reports/refresh")
async def qbo_test_reports_refresh(cid: str,
                                     start_date: str = _DEFAULT_START,
                                     end_date: str = _DEFAULT_END,
                                     user: dict = Depends(get_current_user)):
    """Pull Balance Sheet + Profit & Loss (both Accrual and Cash) from
    QBO and store the raw payload in `qbo_test_reports`. Idempotent —
    re-runs replace the prior snapshot for the same (report, basis)."""
    await require_company(user, cid)
    _use_test_conn()
    conn = await db.qbo_test_connections.find_one({"company_id": cid})
    if not conn:
        raise HTTPException(400, "Test QBO is not connected")
    realm_id = conn["realm_id"]
    fetched: list[dict] = []
    errors: list[dict] = []
    for report in _TEST_REPORTS:
        for basis in ("Accrual", "Cash"):
            try:
                payload = await Q.fetch_report(
                    cid, realm_id, report,
                    {"start_date": start_date, "end_date": end_date,
                     "accounting_method": basis},
                )
            except Exception as e:  # noqa: BLE001
                errors.append({"report": report, "basis": basis,
                                "error": str(e)[:400]})
                continue
            await db.qbo_test_reports.update_one(
                {"company_id": cid, "report_name": report, "basis": basis},
                {"$set": {"company_id": cid,
                           "report_name": report,
                           "basis": basis,
                           "realm_id": realm_id,
                           "start_date": start_date,
                           "end_date": end_date,
                           "fetched_at": now_iso(),
                           "payload": payload}},
                upsert=True,
            )
            fetched.append({"report": report, "basis": basis,
                             "rows": len((payload.get("Rows") or {})
                                             .get("Row") or [])})
    return {"ok": (not errors), "fetched": fetched, "errors": errors}


@router.get("/companies/{cid}/qbo-test/reports/{report_name}")
async def qbo_test_report(cid: str, report_name: str,
                            basis: str = Query("Accrual",
                                                pattern="^(Accrual|Cash)$"),
                            user: dict = Depends(get_current_user)):
    """Return the stored QBO report payload flattened into a
    UI-friendly report shape (grouped rows + running section totals).
    Front-end renders this as an accountant-style report table."""
    await require_company(user, cid)
    if report_name not in _TEST_REPORTS:
        raise HTTPException(400, f"Unsupported report: {report_name}")
    doc = await db.qbo_test_reports.find_one(
        {"company_id": cid, "report_name": report_name, "basis": basis},
        {"_id": 0},
    )
    if not doc:
        return {"available": False, "report_name": report_name,
                 "basis": basis}
    rows = _flatten_report(doc["payload"])
    return {
        "available": True,
        "report_name": report_name,
        "basis": basis,
        "start_date": doc.get("start_date"),
        "end_date": doc.get("end_date"),
        "fetched_at": doc.get("fetched_at"),
        "title": _report_title(doc["payload"], report_name),
        "columns": _report_columns(doc["payload"]),
        "rows": rows,
    }


# ---------- Report flattening (QBO tree → flat rows) ----------


def _report_title(payload: dict, fallback: str) -> str:
    header = (payload or {}).get("Header") or {}
    return header.get("ReportName") or fallback


def _report_columns(payload: dict) -> list[str]:
    cols = ((payload or {}).get("Columns") or {}).get("Column") or []
    return [c.get("ColTitle") or c.get("MetaData", [{}])[0].get("Value", "")
             or "" for c in cols]


def _cd(row: dict) -> list[dict]:
    """Extract the visible ColData cells for a data or summary row."""
    return (row.get("ColData")
             or (row.get("Summary") or {}).get("ColData")
             or [])


def _flatten_report(payload: dict) -> list[dict]:
    """Convert QBO's nested Report → flat rows the frontend can render
    as an indented table. Each row is
        {kind, label, values[], depth, group_id}
    where `kind` is one of {"section_header", "data", "total",
    "spacer"} and `values` is the numeric cells (as strings, formatted
    by QBO) in column order."""
    out: list[dict] = []
    rows = ((payload or {}).get("Rows") or {}).get("Row") or []

    def walk(rs: list[dict], depth: int):
        for r in rs:
            header = r.get("Header") or {}
            summary = r.get("Summary") or {}
            hcd = header.get("ColData") or []
            scd = summary.get("ColData") or []
            data_cd = r.get("ColData") or []
            has_kids = bool((r.get("Rows") or {}).get("Row"))
            group_id = header.get("id") or hcd[0].get("id") if hcd else None

            if data_cd and not has_kids and not summary:
                # Leaf data row.
                out.append({
                    "kind": "data",
                    "label": data_cd[0].get("value", "") if data_cd else "",
                    "values": [c.get("value", "") for c in data_cd[1:]],
                    "depth": depth,
                    "group_id": group_id,
                })
                continue

            if has_kids:
                # Section header + nested rows + section total (Summary).
                if hcd:
                    out.append({
                        "kind": "section_header",
                        "label": hcd[0].get("value", ""),
                        "values": [c.get("value", "") for c in hcd[1:]],
                        "depth": depth,
                        "group_id": group_id,
                    })
                walk((r.get("Rows") or {}).get("Row") or [], depth + 1)
                if scd:
                    out.append({
                        "kind": "total",
                        "label": scd[0].get("value", ""),
                        "values": [c.get("value", "") for c in scd[1:]],
                        "depth": depth,
                        "group_id": group_id,
                    })
                continue

            # Section without kids (summary-only row like grand total).
            if scd:
                out.append({
                    "kind": "total",
                    "label": scd[0].get("value", ""),
                    "values": [c.get("value", "") for c in scd[1:]],
                    "depth": depth,
                    "group_id": group_id,
                })

    walk(rows, 0)
    return out

