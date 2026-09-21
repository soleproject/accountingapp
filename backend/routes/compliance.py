"""IRS Compliance Documentation library.

Consolidates every compliance-relevant `agent_findings` record (Meals
per §274, plus placeholders for Travel / Vehicle / Business Gifts /
Charitable Contributions ≥ $250 per §170 that ship in later phases)
into a single per-company hub the client + CPA can browse.

Ships with `meals_compliance` live — the other categories return an
empty list until their detectors land, but the sidebar page still
renders section placeholders so users know what's coming.
"""
from __future__ import annotations
from datetime import datetime, timezone

from fastapi import APIRouter, Depends

from deps import db, require_company
from auth import get_current_user


router = APIRouter(prefix="/api")


# Category → matching `agent_findings.kind` values. Keeps the frontend
# from having to know backend implementation details.
CATEGORY_KINDS: dict[str, list[str]] = {
    "meals":       ["meals_compliance"],
    "travel":      ["travel_compliance"],
    "vehicle":     ["vehicle_mileage"],
    "gifts":       ["gift_compliance"],
    "charitable":  ["charitable_contribution"],
}


CATEGORY_LABELS: dict[str, str] = {
    "meals":      "Meals & Entertainment (§274)",
    "travel":     "Travel (§274)",
    "vehicle":    "Vehicle & Mileage (§274d)",
    "gifts":      "Business Gifts (§274b — $25/recipient/year cap)",
    "charitable": "Charitable Contributions ≥ $250 (§170)",
}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


async def _lookup_txn(cid: str, txn_id: str | None) -> dict | None:
    if not txn_id:
        return None
    t = await db.transactions.find_one(
        {"company_id": cid, "id": txn_id},
        {"_id": 0, "id": 1, "date": 1, "amount": 1, "merchant": 1,
         "description": 1, "attachments": 1, "bank_account_name": 1,
         "irs_substantiation": 1},
    )
    return t


async def _lookup_batch_answer(cid: str, finding_id: str) -> dict | None:
    """The client's answered / deferred state lives on the batch item.
    Return `{answer, answered_at, deferred, defer_note, attachments,
    answered_payload}` for the finding, or None if it's not in any
    batch yet.
    """
    b = await db.client_review_batches.find_one(
        {"company_id": cid, "items.source_id": finding_id},
        {"_id": 0, "items.$": 1},
    )
    if not b or not b.get("items"):
        return None
    it = b["items"][0]
    return {
        "answer":            it.get("answer"),
        "answered_at":       it.get("answered_at"),
        "deferred":          bool(it.get("deferred")),
        "defer_note":        it.get("defer_note"),
        "attachments":       it.get("attachments") or [],
        "item_type":         it.get("item_type"),
        "answered_payload":  it.get("answered_payload") or {},
        "answered_by_pro":   bool(it.get("answered_by_pro")),
        "answered_by_email": it.get("answered_by_email"),
    }


@router.get("/companies/{cid}/compliance/entries")
async def list_compliance_entries(
    cid: str,
    category: str | None = None,
    user: dict = Depends(get_current_user),
):
    """Return every compliance finding for the company, keyed by
    category. If `category` is passed we only return that bucket;
    otherwise we return the full map + summary counts.
    """
    await require_company(user, cid)

    if category and category not in CATEGORY_KINDS:
        return {"categories": {}, "summary": {}}

    wanted = {category: CATEGORY_KINDS[category]} if category \
             else CATEGORY_KINDS

    out: dict[str, dict] = {}
    for cat, kinds in wanted.items():
        entries = []
        async for f in db.agent_findings.find({
            "company_id": cid,
            "kind":       {"$in": kinds},
        }).sort("created_at", -1).limit(200):
            meta   = f.get("meta") or {}
            txn_id = meta.get("txn_id")
            txn    = await _lookup_txn(cid, txn_id)
            batch  = await _lookup_batch_answer(cid, f["id"])
            # Merge substantiation fields from all three sources, with
            # the transaction's `irs_substantiation` as the source of
            # truth (it's the durable, post-close record). Falls back
            # to the batch item's `answered_payload`, then the
            # finding's `meta.client_payload` for older records.
            substantiation: dict = {}
            for src in (
                (meta or {}).get("client_payload"),
                (batch or {}).get("answered_payload"),
                (txn or {}).get("irs_substantiation"),
            ):
                if isinstance(src, dict):
                    for k in ("attendees", "business_purpose", "destination",
                              "trip_start", "trip_end"):
                        v = src.get(k)
                        if v and not substantiation.get(k):
                            substantiation[k] = v
            entries.append({
                "id":              f["id"],
                "kind":            f.get("kind"),
                "title":           f.get("title"),
                "detail":          f.get("detail"),
                "severity":        f.get("severity"),
                "status":          f.get("status"),
                "created_at":      f.get("created_at"),
                "merchant":        meta.get("merchant"),
                "txn_amount":      meta.get("txn_amount"),
                "txn_date":        meta.get("txn_date"),
                "txn_id":          txn_id,
                "txn":             txn,
                "answer":          (batch or {}).get("answer"),
                "answered_at":     (batch or {}).get("answered_at"),
                "deferred":        (batch or {}).get("deferred") or False,
                "defer_note":      (batch or {}).get("defer_note"),
                "attachments":     (batch or {}).get("attachments") or [],
                "substantiation":  substantiation or None,
                "answered_by_pro": (batch or {}).get("answered_by_pro") or False,
                "answered_by_email": (batch or {}).get("answered_by_email"),
            })
        out[cat] = {
            "label":   CATEGORY_LABELS[cat],
            "entries": entries,
            "count":   len(entries),
            # For categories whose detectors haven't shipped yet the
            # frontend renders a "coming soon" banner. The presence of
            # `implemented=False` is the signal.
            "implemented": bool(entries) or cat in {"meals", "travel"},
        }

    summary = {
        cat: {"count": data["count"], "implemented": data["implemented"]}
        for cat, data in out.items()
    }
    return {"categories": out, "summary": summary,
            "fetched_at": _now_iso()}
