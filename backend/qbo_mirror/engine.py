"""Mirror engine — Phase 1a: dry-run diff only.

For each Foundation entity (accounts, customers, vendors, items):
  1. Read every local doc for the company (source='qbo' or 'seeded').
  2. Read every QBO doc via the existing `qbo_service.query_all`.
  3. Match by `qbo_id` (already-migrated) or by natural key (name+type).
  4. Emit a diff report classifying each row as:
       - `in_sync`         — both sides identical (nothing to do)
       - `push_to_qbo`     — exists locally, missing on QBO
       - `pull_from_qbo`   — exists on QBO, missing locally
       - `field_drift`     — same entity, different values
  5. Store the report in `mirror_log` with kind='dry_run'.

Nothing else. No writes to QBO, no writes to local tables.
"""
from __future__ import annotations
from typing import Any

from db import db
import qbo_service as Q
from qbo_mirror.settings import append_log, get_config


# ─── Entity normalizers ─────────────────────────────────────────────
# Each normalizer returns a comparable dict with a stable `natural_key`
# used to match a local doc to its QBO counterpart when qbo_id is
# missing (e.g. local doc created before Mirror existed).

def _norm_account_local(a: dict) -> dict:
    return {
        "qbo_id": a.get("qbo_id"),
        "natural_key": f"acct::{(a.get('name') or '').strip().lower()}::"
                       f"{a.get('type') or ''}",
        "name": (a.get("name") or "").strip(),
        "type": a.get("type") or "",
        "subtype": a.get("subtype") or "",
        "active": a.get("active", True),
        "source": a.get("source") or "seeded",
    }


def _norm_account_qbo(o: dict) -> dict:
    return {
        "qbo_id": o.get("Id"),
        "natural_key": f"acct::{(o.get('Name') or '').strip().lower()}::"
                       f"{Q._ACCOUNT_TYPE_MAP.get(o.get('AccountType') or '', 'expense')}",
        "name": (o.get("Name") or "").strip(),
        "type": Q._ACCOUNT_TYPE_MAP.get(o.get("AccountType") or "", "expense"),
        "subtype": o.get("AccountSubType") or "",
        "active": bool(o.get("Active", True)),
    }


def _norm_contact_local(c: dict, kind: str) -> dict:
    return {
        "qbo_id": c.get("qbo_id"),
        "natural_key": f"{kind}::{(c.get('display_name') or c.get('name') or '').strip().lower()}",
        "name": (c.get("display_name") or c.get("name") or "").strip(),
        "email": (c.get("email") or "").strip().lower(),
        "phone": (c.get("phone") or "").strip(),
        "active": c.get("active", True),
    }


def _norm_contact_qbo(o: dict, kind: str) -> dict:
    return {
        "qbo_id": o.get("Id"),
        "natural_key": f"{kind}::{(o.get('DisplayName') or '').strip().lower()}",
        "name": (o.get("DisplayName") or "").strip(),
        "email": ((o.get("PrimaryEmailAddr") or {}).get("Address") or "").strip().lower(),
        "phone": ((o.get("PrimaryPhone") or {}).get("FreeFormNumber") or "").strip(),
        "active": bool(o.get("Active", True)),
    }


def _norm_item_local(i: dict) -> dict:
    return {
        "qbo_id": i.get("qbo_id"),
        "natural_key": f"item::{(i.get('name') or '').strip().lower()}",
        "name": (i.get("name") or "").strip(),
        "sku": (i.get("sku") or "").strip(),
        "unit_price": round(float(i.get("unit_price") or 0), 2),
        "active": i.get("active", True),
    }


def _norm_item_qbo(o: dict) -> dict:
    return {
        "qbo_id": o.get("Id"),
        "natural_key": f"item::{(o.get('Name') or '').strip().lower()}",
        "name": (o.get("Name") or "").strip(),
        "sku": (o.get("Sku") or "").strip(),
        "unit_price": round(float(o.get("UnitPrice") or 0), 2),
        "active": bool(o.get("Active", True)),
    }


# ─── Diff builder ───────────────────────────────────────────────────
# Fields whose drift is *significant* — cosmetic-only fields (e.g.
# subtype spelling) don't count as drift to reduce noise in the report.
_DRIFT_FIELDS = {
    "accounts":  ["name", "type", "active"],
    "customers": ["name", "email", "phone", "active"],
    "vendors":   ["name", "email", "phone", "active"],
    "items":     ["name", "sku", "unit_price", "active"],
}


def _diff_rows(local_rows: list[dict], qbo_rows: list[dict],
               entity: str) -> dict:
    by_qbo_id = {q["qbo_id"]: q for q in qbo_rows if q.get("qbo_id")}
    by_natural = {q["natural_key"]: q for q in qbo_rows}
    used_qbo_ids: set[str] = set()

    in_sync: list[dict] = []
    field_drift: list[dict] = []
    push_to_qbo: list[dict] = []

    for local in local_rows:
        # Match strategy: qbo_id (strongest) → natural key (fallback).
        remote = None
        if local.get("qbo_id") and local["qbo_id"] in by_qbo_id:
            remote = by_qbo_id[local["qbo_id"]]
        elif local["natural_key"] in by_natural:
            remote = by_natural[local["natural_key"]]

        if not remote:
            push_to_qbo.append(local)
            continue

        used_qbo_ids.add(remote["qbo_id"])
        drift = [f for f in _DRIFT_FIELDS[entity]
                 if local.get(f) != remote.get(f)]
        if drift:
            field_drift.append({"local": local, "remote": remote,
                                "fields": drift})
        else:
            in_sync.append(local)

    pull_from_qbo = [q for q in qbo_rows
                     if q.get("qbo_id") and q["qbo_id"] not in used_qbo_ids
                     and q["natural_key"] not in {r["natural_key"] for r in local_rows}]

    return {
        "entity": entity,
        "totals": {
            "in_sync": len(in_sync),
            "field_drift": len(field_drift),
            "push_to_qbo": len(push_to_qbo),
            "pull_from_qbo": len(pull_from_qbo),
        },
        # Cap samples at 25 per bucket to keep the log doc small — the
        # dashboard uses these only for a preview table. Full-table
        # diff will get its own paginated endpoint in Phase 1b.
        "samples": {
            "field_drift": field_drift[:25],
            "push_to_qbo": push_to_qbo[:25],
            "pull_from_qbo": pull_from_qbo[:25],
        },
    }


# ─── Fetchers per entity ────────────────────────────────────────────

async def _fetch_local(company_id: str, entity: str) -> list[dict]:
    if entity == "accounts":
        return [_norm_account_local(a) async for a in db.accounts.find(
            {"company_id": company_id})]
    if entity == "customers":
        return [_norm_contact_local(c, "customer")
                async for c in db.contacts.find(
                    {"company_id": company_id, "kind": "customer"})]
    if entity == "vendors":
        return [_norm_contact_local(c, "vendor")
                async for c in db.contacts.find(
                    {"company_id": company_id, "kind": "vendor"})]
    if entity == "items":
        return [_norm_item_local(i) async for i in db.items.find(
            {"company_id": company_id})]
    return []


async def _fetch_qbo(company_id: str, realm_id: str,
                     entity: str) -> list[dict]:
    if entity == "accounts":
        return [_norm_account_qbo(o)
                async for o in Q.query_all(company_id, realm_id, "Account")]
    if entity == "customers":
        return [_norm_contact_qbo(o, "customer")
                async for o in Q.query_all(company_id, realm_id, "Customer")]
    if entity == "vendors":
        return [_norm_contact_qbo(o, "vendor")
                async for o in Q.query_all(company_id, realm_id, "Vendor")]
    if entity == "items":
        return [_norm_item_qbo(o)
                async for o in Q.query_all(company_id, realm_id, "Item")]
    return []


# ─── Public entry point ─────────────────────────────────────────────

async def run_dry_run(company_id: str, user_email: str) -> dict:
    """Compute the diff report for every enabled Foundation entity.
    NEVER writes to QBO. NEVER writes to existing local collections.
    Only writes are: a single `mirror_log` insert with the report."""
    cfg = await get_config(company_id)
    conn = await db.qbo_connections.find_one(
        {"company_id": company_id, "status": "connected"},
        {"realm_id": 1, "_id": 0},
    )
    if not conn:
        return {"error": "QBO is not connected for this company.",
                "reports": []}
    realm_id = conn["realm_id"]

    reports: list[dict] = []
    entities_cfg = cfg.get("entities") or {}
    # Only Foundation entities are wired in Phase 1a — later entity
    # flags in the config are silently ignored.
    for entity in ("accounts", "customers", "vendors", "items"):
        if not entities_cfg.get(entity, True):
            continue
        try:
            local = await _fetch_local(company_id, entity)
            remote = await _fetch_qbo(company_id, realm_id, entity)
            reports.append(_diff_rows(local, remote, entity))
        except Exception as e:  # noqa: BLE001
            reports.append({"entity": entity, "error": str(e),
                            "totals": {}, "samples": {}})

    summary = {
        "entities_checked": len(reports),
        "total_in_sync": sum((r.get("totals") or {}).get("in_sync", 0) for r in reports),
        "total_drift":   sum((r.get("totals") or {}).get("field_drift", 0) for r in reports),
        "total_push":    sum((r.get("totals") or {}).get("push_to_qbo", 0) for r in reports),
        "total_pull":    sum((r.get("totals") or {}).get("pull_from_qbo", 0) for r in reports),
    }
    await append_log(company_id, "dry_run",
                     f"Dry-run by {user_email}: {summary}",
                     {"summary": summary, "reports": reports})
    return {"summary": summary, "reports": reports, "realm_id": realm_id}
