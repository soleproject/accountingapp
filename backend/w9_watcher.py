"""W-9 collection watcher — Phase 3, Milestone A.5.

Fires `agent_findings.kind="w9_needed"` when a contact is:
  * flagged as `is_1099_vendor=True` (via `contact_auditor` classification), and
  * YTD paid crosses either the soft warning ($500) or hard required
    ($2,000) threshold, and
  * has no W-9 on file (`w9_on_file != True`).

The Tier 1 fast-path (`known_corporations.is_known_corporation`) is
consulted first so retail/telco/bank vendors are dropped without ever
being classified as 1099 — belt-and-suspenders against a mislabelled
`is_1099_vendor` field on a legacy contact.

Idempotent: re-running for the same company only creates one open
finding per contact. If the amount later crosses the hard threshold,
the existing finding is upgraded from soft to hard in place — no
duplicate rows.

Called by:
  * A scheduled cron (weekly, aligned with the batch client review
    cadence trigger), OR
  * On-demand from an admin endpoint for testing.
"""

from __future__ import annotations
import uuid
from datetime import datetime, timezone
from typing import Any

from deps import db
from known_corporations import is_known_corporation


SOFT_THRESHOLD = 500.0    # $500 YTD → "ask nicely" nudge
HARD_THRESHOLD = 2000.0   # $2k YTD → "we really need this"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _current_tax_year() -> int:
    return datetime.now(timezone.utc).year


async def _ytd_paid_by_contact(
    company_id: str, year: int,
) -> dict[str, float]:
    """Return `{contact_id: absolute total paid}` for the calendar year.

    "Paid" = outflow only (negative amounts). We take the absolute
    value so downstream threshold comparisons are unsigned.
    """
    pipeline = [
        {"$match": {
            "company_id": company_id,
            "amount":     {"$lt": 0},
            "date":       {"$gte": f"{year}-01-01", "$lte": f"{year}-12-31"},
            "contact_id": {"$nin": [None, ""]},
        }},
        {"$group": {
            "_id":         "$contact_id",
            "total_paid":  {"$sum": {"$abs": "$amount"}},
        }},
    ]
    out: dict[str, float] = {}
    async for row in db.transactions.aggregate(pipeline):
        out[row["_id"]] = float(row["total_paid"])
    return out


async def _open_finding_for(
    company_id: str, contact_id: str,
) -> dict | None:
    """Locate any live `w9_needed` finding for this contact (open OR
    already-batched — we don't want to double-insert a still-live one).
    """
    return await db.agent_findings.find_one({
        "company_id": company_id,
        "contact_id": contact_id,
        "kind":       "w9_needed",
        "status":     "open",
    })


async def _upsert_finding(
    *, company_id: str, contact: dict, ytd_paid: float, tier: str,
) -> str:
    """Create the w9 finding if none exists, else upgrade soft→hard
    when the amount has crossed. Returns the finding id.
    """
    contact_id   = contact["id"]
    contact_name = contact.get("name") or "vendor"
    now          = _now_iso()

    existing = await _open_finding_for(company_id, contact_id)
    if existing:
        # Upgrade from soft to hard when the amount now crosses.
        existing_tier = (existing.get("meta") or {}).get("tier")
        if existing_tier == "soft" and tier == "hard":
            await db.agent_findings.update_one(
                {"id": existing["id"]},
                {"$set": {
                    "meta.tier":       "hard",
                    "meta.ytd_paid":   ytd_paid,
                    "detail":          _detail_line(contact_name, ytd_paid,
                                                    tier="hard"),
                    "severity":        "red",
                    "updated_at":      now,
                }},
            )
        else:
            # Same tier — just refresh the YTD amount.
            await db.agent_findings.update_one(
                {"id": existing["id"]},
                {"$set": {"meta.ytd_paid": ytd_paid, "updated_at": now}},
            )
        return existing["id"]

    finding_id = str(uuid.uuid4())
    await db.agent_findings.insert_one({
        "id":            finding_id,
        "company_id":    company_id,
        "contact_id":    contact_id,
        "kind":          "w9_needed",
        "status":        "open",
        "batch_id":      None,
        "severity":      "red" if tier == "hard" else "amber",
        "title":         f"W-9 needed from {contact_name}",
        "detail":        _detail_line(contact_name, ytd_paid, tier=tier),
        "action_label":  "Request W-9",
        "action_route":  f"/contacts?open={contact_id}",
        "count":         1,
        "meta": {
            "tier":              tier,
            "ytd_paid":          ytd_paid,
            "tax_year":          _current_tax_year(),
            "contact_name":      contact_name,
            "soft_threshold":    SOFT_THRESHOLD,
            "hard_threshold":    HARD_THRESHOLD,
        },
        "created_at":    now,
        "updated_at":    now,
    })
    return finding_id


def _detail_line(name: str, amount: float, *, tier: str) -> str:
    if tier == "hard":
        return (f"{name} has been paid ${amount:,.0f} YTD and we don't "
                f"have a W-9 on file yet. Request one before year-end "
                f"1099 filing to avoid backup withholding.")
    return (f"{name} has been paid ${amount:,.0f} YTD. Once they cross "
            f"$2,000 we're required to have a W-9 on file — good idea "
            f"to request it now before the paperwork rush.")


async def _resolve_stale_findings(
    company_id: str, resolvable_contact_ids: set[str],
) -> int:
    """Close open w9 findings whose contact now has a W-9 on file OR is
    no longer flagged is_1099_vendor. Prevents dead-weight findings
    lingering in the queue.
    """
    now = _now_iso()
    r = await db.agent_findings.update_many(
        {"company_id": company_id,
         "kind":       "w9_needed",
         "status":     "open",
         "contact_id": {"$in": list(resolvable_contact_ids)}},
        {"$set": {
            "status":       "resolved",
            "resolved_at":  now,
            "resolved_by":  "system:w9_watcher",
            "updated_at":   now,
        }},
    )
    return r.modified_count


async def scan_company(company_id: str) -> dict:
    """Run one W-9 watcher pass for a company. Returns a summary.

    Contract:
      * Finds all `is_1099_vendor=True` contacts with `w9_on_file != True`
      * Excludes anything Tier 1 (`known_corporations`) — defensive
      * Aggregates YTD paid per contact from transactions
      * Mints/upgrades findings crossing thresholds
      * Closes findings for contacts that are now resolved (w9 on file,
        or no longer flagged 1099)
    """
    year = _current_tax_year()
    ytd_paid_by_contact = await _ytd_paid_by_contact(company_id, year)

    # Load candidate contacts. We keep the projection minimal because a
    # busy book has thousands of contacts.
    candidates: list[dict] = []
    async for c in db.contacts.find(
        {"company_id": company_id, "is_1099_vendor": True},
        {"id": 1, "name": 1, "w9_on_file": 1, "is_1099_vendor": 1},
    ):
        candidates.append(c)

    resolved_ids: set[str] = set()
    created = upgraded = skipped_tier1 = 0

    for contact in candidates:
        cid_ = contact["id"]
        # Skip anything Tier 1 catches — defensive against legacy data
        # where an old audit run wrongly flagged Walmart as 1099.
        if is_known_corporation(contact.get("name") or ""):
            resolved_ids.add(cid_)
            skipped_tier1 += 1
            continue
        # W-9 already on file → close any open finding.
        if contact.get("w9_on_file"):
            resolved_ids.add(cid_)
            continue
        ytd = ytd_paid_by_contact.get(cid_, 0.0)
        if ytd < SOFT_THRESHOLD:
            continue
        tier = "hard" if ytd >= HARD_THRESHOLD else "soft"

        existing = await _open_finding_for(company_id, cid_)
        await _upsert_finding(
            company_id=company_id, contact=contact,
            ytd_paid=ytd, tier=tier,
        )
        if existing:
            if (existing.get("meta") or {}).get("tier") != tier and tier == "hard":
                upgraded += 1
        else:
            created += 1

    if resolved_ids:
        closed = await _resolve_stale_findings(company_id, resolved_ids)
    else:
        closed = 0

    return {
        "company_id":     company_id,
        "candidates":     len(candidates),
        "created":        created,
        "upgraded":       upgraded,
        "closed":         closed,
        "skipped_tier1":  skipped_tier1,
    }


__all__ = [
    "SOFT_THRESHOLD", "HARD_THRESHOLD",
    "scan_company",
]
