"""Global search — powers the ⌘K command palette (Feb 2026, Phase B-3
polish). One endpoint that scans customers, projects, invoices, bills,
tasks, and employees in a single company, ranks by prefix match, and
returns a unified list of `{kind, id, label, sublabel, url}` items
the palette can navigate to directly.

Route: GET /api/companies/{cid}/search?q=…&limit=8
"""
from __future__ import annotations

import re
from typing import List

from fastapi import APIRouter, Depends, Query

from auth import get_current_user
from db import db
from deps import require_company

router = APIRouter(prefix="/api")


def _escape(q: str) -> str:
    """Escape user query so we can drop it into a Mongo $regex safely."""
    return re.escape(q or "")


async def _hits(coll, q_regex: str, base_filter: dict, projection: dict,
                limit: int, search_fields: set) -> list:
    return await db[coll].find(
        {**base_filter, "$or": [{k: {"$regex": q_regex, "$options": "i"}}
                                for k in search_fields
                                if k in projection]},
        projection).limit(limit).to_list(limit)


def _fmt(kind: str, doc: dict, label: str, sublabel: str, url: str) -> dict:
    return {"kind": kind, "id": doc.get("id"),
            "label": label, "sublabel": sublabel, "url": url}


@router.get("/companies/{cid}/search")
async def search(
    cid: str,
    q: str = Query("", description="Free-text query"),
    limit: int = Query(8, ge=1, le=20),
    user: dict = Depends(get_current_user),
) -> dict:
    await require_company(user, cid)
    q = (q or "").strip()
    if len(q) < 2:
        return {"results": [], "count": 0, "q": q}
    rx = _escape(q)
    base = {"company_id": cid}
    per_kind = max(2, limit)

    results: List[dict] = []
    # Only text-y fields participate in the fuzzy match — this keeps a
    # query like "active" or "open" from matching every row that has
    # that word in a status/kind field.
    TEXT_FIELDS = {"name", "title", "number", "email", "entity_label"}

    # ---- Contacts (customers/vendors) ----
    for c in await _hits("contacts", rx, base,
                          {"id": 1, "name": 1, "kind": 1, "email": 1}, per_kind,
                          TEXT_FIELDS):
        kind = "customer" if (c.get("kind") == "customer") else "contact"
        url = f"/contacts/{c['id']}" if c.get("id") else "/contacts"
        results.append(_fmt(kind, c,
            c.get("name") or "(unnamed)",
            (c.get("email") or c.get("kind") or "").title(),
            url))

    # ---- Projects ----
    for p in await _hits("projects", rx, base,
                          {"id": 1, "name": 1, "contact_name": 1, "status": 1},
                          per_kind, TEXT_FIELDS | {"contact_name"}):
        results.append(_fmt("project", p,
            p.get("name") or "(untitled)",
            f"{(p.get('contact_name') or '')}".strip() or (p.get("status") or "").title(),
            f"/accounting/projects/{p['id']}"))

    # ---- Invoices ----
    for inv in await _hits("invoices", rx, base,
                            {"id": 1, "number": 1, "contact_name": 1, "status": 1, "date": 1},
                            per_kind, TEXT_FIELDS | {"contact_name"}):
        results.append(_fmt("invoice", inv,
            f"Invoice {inv.get('number') or inv.get('id')[:8]}",
            f"{inv.get('contact_name') or ''} · {(inv.get('status') or '').title()}",
            f"/invoices/{inv['id']}/edit"))

    # ---- Bills ----
    for b in await _hits("bills", rx, base,
                          {"id": 1, "number": 1, "contact_name": 1, "status": 1, "date": 1},
                          per_kind, TEXT_FIELDS | {"contact_name"}):
        results.append(_fmt("bill", b,
            f"Bill {b.get('number') or b.get('id')[:8]}",
            f"{b.get('contact_name') or ''} · {(b.get('status') or '').title()}",
            f"/bills/{b['id']}/edit"))

    # ---- Tasks ----
    for t in await _hits("tasks", rx, base,
                          {"id": 1, "title": 1, "status": 1, "priority": 1,
                           "entity_label": 1, "due_date": 1},
                          per_kind, TEXT_FIELDS):
        results.append(_fmt("task", t,
            t.get("title") or "(untitled)",
            f"{(t.get('priority') or '').title()}"
            f"{' · Due ' + t['due_date'] if t.get('due_date') else ''}"
            f"{' · ' + t.get('entity_label') if t.get('entity_label') else ''}",
            "/team"))

    # ---- Employees ----
    for e in await _hits("employees", rx, base,
                          {"id": 1, "name": 1, "role": 1, "title": 1, "email": 1},
                          per_kind, TEXT_FIELDS):
        results.append(_fmt("employee", e,
            e.get("name") or "(unnamed)",
            f"{(e.get('title') or e.get('role') or '').replace('_', ' ').title()}"
            f"{' · ' + e['email'] if e.get('email') else ''}",
            "/team"))

    # Rank: exact/prefix on label wins.
    ql = q.lower()
    def _score(r: dict) -> int:
        lb = (r["label"] or "").lower()
        if lb == ql: return 0
        if lb.startswith(ql): return 1
        if ql in lb: return 2
        return 3
    results.sort(key=_score)
    results = results[:limit]
    return {"results": results, "count": len(results), "q": q}
