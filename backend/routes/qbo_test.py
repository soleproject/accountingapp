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

Follows the QBO environment (sandbox / production) selected in the
company's Settings; whichever environment the current QBO connection
lives in is what we pull from.

Endpoints
---------
- POST /api/companies/{cid}/qbo-test/migrate   — Wipe + fresh pull.
- GET  /api/companies/{cid}/qbo-test/preview   — Counts per entity.
- GET  /api/companies/{cid}/qbo-test/entity/{type} — Raw rows.
- POST /api/companies/{cid}/qbo-test/reset     — Wipe test data only.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from auth import get_current_user
from deps import require_company
from db import db
import qbo_service as Q


router = APIRouter(prefix="/api")


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
    r = await db.qbo_test_raw.delete_many({"company_id": company_id})
    return r.deleted_count


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
    from QBO into `qbo_test_raw`. Follows the connection's current
    environment (sandbox / production).
    """
    await require_company(user, cid)
    conn = await db.qbo_connections.find_one({"company_id": cid})
    if not conn:
        raise HTTPException(400, "QBO is not connected on this company")
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
    conn = await db.qbo_connections.find_one({"company_id": cid})
    counts: dict[str, int] = {}
    for entity in _ENTITIES:
        counts[entity] = await db.qbo_test_raw.count_documents({
            "company_id": cid, "entity_type": entity,
        })
    last = await db.qbo_test_raw.find_one(
        {"company_id": cid}, sort=[("fetched_at", -1)])
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
