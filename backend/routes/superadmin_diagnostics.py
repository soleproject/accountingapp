"""Superadmin diagnostic — Step 1/2/3 breakdown for any company.

Built Feb 2026 after "The Fireplace Place Branson LLC" reported
"Flagged for review: 497" that appeared to never clear despite the
CPA approving Step 1 to zero. Also returns cache backend + pod
hostname so we can diagnose whether the multi-pod stale-cache theory
is what the user is actually hitting.

Usage:
    GET /api/superadmin/diagnostics/step-breakdown/{cid}
    Authorization: Bearer <superadmin_token>

Returns:
    {
      "company": {"id": "...", "name": "..."},
      "totals": {
          "transactions": 875,
          "auto_posted": 875,
          "flagged_for_review_dashboard": 497
      },
      "step1": {
          "buckets": 0,
          "txn_count": 0,
          "notes": "(contact × account) buckets where !human_reviewed
                    AND has contact AND category_account_id AND code
                    NOT in {6999,4999,9999}"
      },
      "step2": {
          "vendor_groups": 12,
          "txn_count": 84,
          "notes": "contacts with 1+ uncategorized rows"
      },
      "step3": {
          "no_contact": 47,
          "txn_count": 47,
          "notes": "no-contact + uncategorized rows"
      },
      "coverage": {
          "flagged_covered_by_a_step":  X,
          "flagged_orphans_no_step":    Y,
          "orphan_sample_ids":         [...],
          "note": "If flagged_orphans_no_step > 0, those rows show
                   in the '497 Flagged' tile but no step-page can
                   surface them for the CPA to clear — classic
                   count-never-clears trap."
      },
      "cache_backend": "RedisReportCache" | "ReportCache",
      "pod_hostname": "backend-xyz-abc123",
      "redis_reachable": true|false
    }
"""
from __future__ import annotations
import os
import socket
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException

from auth import get_current_user
from db import db
from infra import get_cache

router = APIRouter(prefix="/api", tags=["superadmin-diagnostics"])


def _require_superadmin(user: dict) -> None:
    if (user or {}).get("role") != "superadmin":
        raise HTTPException(403, "Superadmin only.")


_UNCAT_CODES = {"6999", "4999", "9999"}


async def _redis_reachable() -> bool:
    """Best-effort ping of the currently-configured Redis. Returns
    False if the URL is unset OR the round-trip fails."""
    url = os.environ.get("REDIS_URL", "").strip()
    if not url or url == "memory://":
        return False
    try:
        import redis.asyncio as aioredis
        client = aioredis.from_url(
            url, socket_connect_timeout=1.0, socket_timeout=1.0,
        )
        try:
            pong = await client.ping()
        finally:
            await client.aclose()
        return bool(pong)
    except Exception:
        return False


@router.get("/superadmin/diagnostics/step-breakdown/{cid}")
async def step_breakdown(
    cid: str,
    user: dict = Depends(get_current_user),
):
    """Return a per-step scope breakdown so we can pinpoint rows in
    the "Flagged for review" tile that no step-page can surface."""
    _require_superadmin(user)

    company = await db.companies.find_one(
        {"id": cid}, {"id": 1, "name": 1},
    )
    if not company:
        raise HTTPException(404, f"Company {cid} not found")

    # ---------- Load every txn once (single scan) ----------
    txns = await db.transactions.find({"company_id": cid}).to_list(200_000)

    total_txns = len(txns)
    posted = sum(1 for t in txns if t.get("posted"))
    flagged_dashboard = sum(1 for t in txns if t.get("needs_review"))

    # Step 1 — (contact, account) buckets not yet human_reviewed
    step1_ids: list[str] = []
    step1_buckets: set[tuple[str, str]] = set()
    # Step 2 — contacts with 1+ uncategorized rows
    step2_contact_ids: set[str] = set()
    step2_ids: list[str] = []
    # Step 3 — no-contact uncategorized rows
    step3_ids: list[str] = []
    # For orphan analysis
    flagged_ids_covered: set[str] = set()

    per_contact_uncat: dict[str, int] = {}

    for t in txns:
        if t.get("human_reviewed"):
            continue
        contact  = t.get("contact_id")
        code     = t.get("category_account_code")
        cat_id   = t.get("category_account_id")
        has_cat  = bool(cat_id)
        is_uncat = (not has_cat) or (code in _UNCAT_CODES)
        tid      = t.get("id")

        if contact and not is_uncat:
            # Step 1 territory
            key = (contact, cat_id)
            step1_buckets.add(key)
            step1_ids.append(tid)
            if t.get("needs_review"):
                flagged_ids_covered.add(tid)
        elif contact and is_uncat:
            # Step 2 territory
            per_contact_uncat[contact] = per_contact_uncat.get(contact, 0) + 1
            step2_contact_ids.add(contact)
            step2_ids.append(tid)
            if t.get("needs_review"):
                flagged_ids_covered.add(tid)
        elif not contact and is_uncat:
            # Step 3 territory
            step3_ids.append(tid)
            if t.get("needs_review"):
                flagged_ids_covered.add(tid)
        else:
            # not-contact + categorized (rare) — nothing routes here
            # today; skip for coverage accounting
            pass

    # Orphans: rows where needs_review=True but NO step can surface
    # them. Common cause: no contact + categorized + still flagged.
    orphan_ids: list[str] = []
    for t in txns:
        if not t.get("needs_review"):
            continue
        if t.get("human_reviewed"):
            continue                                      # already cleared
        tid = t.get("id")
        if tid in flagged_ids_covered:
            continue
        orphan_ids.append(tid)

    # ---------- Cache + pod diagnostics ----------
    cache = get_cache()
    cache_backend = type(cache).__name__
    pod_hostname = os.environ.get("HOSTNAME") or socket.gethostname()
    redis_url_present = bool(os.environ.get("REDIS_URL", "").strip())
    redis_ok = await _redis_reachable()

    return {
        "company": {"id": company["id"], "name": company["name"]},
        "totals": {
            "transactions": total_txns,
            "posted": posted,
            "flagged_for_review_dashboard": flagged_dashboard,
        },
        "step1": {
            "buckets": len(step1_buckets),
            "txn_count": len(step1_ids),
            "sample_txn_ids": step1_ids[:10],
            "notes": ("(contact × account) buckets where not "
                       "human_reviewed AND has contact AND has "
                       "category_account_id AND code not in "
                       "{6999,4999,9999}"),
        },
        "step2": {
            "vendor_groups": len(step2_contact_ids),
            "txn_count": len(step2_ids),
            "sample_txn_ids": step2_ids[:10],
            "notes": "contacts with 1+ uncategorized rows",
        },
        "step3": {
            "no_contact": len(step3_ids),
            "txn_count": len(step3_ids),
            "sample_txn_ids": step3_ids[:10],
            "notes": "no-contact + uncategorized rows",
        },
        "coverage": {
            "flagged_covered_by_a_step": len(flagged_ids_covered),
            "flagged_orphans_no_step":    len(orphan_ids),
            "orphan_sample_ids":          orphan_ids[:20],
            "note": ("If flagged_orphans_no_step > 0, those rows "
                     "show in the 'Flagged for review' tile but no "
                     "step-page can surface them — the CPA has no "
                     "way to clear them, so the count never drops."),
        },
        "cache": {
            "backend":          cache_backend,
            "pod_hostname":     pod_hostname,
            "redis_url_set":    redis_url_present,
            "redis_reachable":  redis_ok,
            "is_multi_pod_safe": cache_backend == "RedisReportCache",
            "note": ("If backend is 'ReportCache' AND redis_url_set "
                     "is True, the pod fell back to in-memory cache "
                     "at boot — invalidations WON'T propagate across "
                     "pods. This is the classic 'count doesn't clear' "
                     "root cause."),
        },
    }
