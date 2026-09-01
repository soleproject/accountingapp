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
from fastapi import APIRouter, Depends, HTTPException, Body

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
    trace_txn_id: Optional[str] = None,
    user: dict = Depends(get_current_user),
):
    """Return a per-step scope breakdown so we can pinpoint rows in
    the "Flagged for review" tile that no step-page can surface.

    If `trace_txn_id` is supplied, ALSO returns a per-check diagnosis
    for that single row — which step-scope predicate excluded it, so
    we can see the exact field mismatch responsible for the orphan.
    """
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

    # ---------- Optional per-txn trace ----------
    trace: Optional[dict] = None
    if trace_txn_id:
        t = await db.transactions.find_one(
            {"id": trace_txn_id, "company_id": cid},
        )
        if not t:
            trace = {"error": f"Transaction {trace_txn_id} not found"}
        else:
            contact  = t.get("contact_id")
            code     = t.get("category_account_code")
            cat_id   = t.get("category_account_id")
            has_cat  = bool(cat_id)
            is_uncat = (not has_cat) or (code in _UNCAT_CODES)

            # Reason each step-scope predicate would EXCLUDE this row.
            reasons: dict[str, str] = {}
            if t.get("human_reviewed"):
                reasons["all_steps"] = (
                    "human_reviewed=True → the counter's very first "
                    "gate (`if t.get('human_reviewed'): continue`) "
                    "excludes this row from every step scope"
                )
            else:
                if not (contact and not is_uncat):
                    reasons["step1"] = (
                        f"step1 requires: contact_id set ({bool(contact)}) "
                        f"AND has category_account_id ({has_cat}) "
                        f"AND code not in {{6999,4999,9999}} "
                        f"(code={code!r})"
                    )
                if not (contact and is_uncat):
                    reasons["step2"] = (
                        f"step2 requires: contact_id set ({bool(contact)}) "
                        f"AND is_uncategorized ({is_uncat})"
                    )
                if not ((not contact) and is_uncat):
                    reasons["step3"] = (
                        f"step3 requires: NO contact_id "
                        f"(contact={bool(contact)}) AND is_uncategorized "
                        f"({is_uncat})"
                    )

            # Every field that could conceivably matter for
            # categorization/scope, plus a raw dump.
            trace = {
                "txn_id": trace_txn_id,
                "field_snapshot": {
                    "id":                     t.get("id"),
                    "date":                   t.get("date"),
                    "amount":                 t.get("amount"),
                    "merchant":               t.get("merchant"),
                    "description":            t.get("description"),
                    "contact_id":             contact,
                    "contact_name":           t.get("contact_name"),
                    "contact_source":         t.get("contact_source"),
                    "category_account_id":    cat_id,
                    "category_account_code":  code,
                    "category_account_name":  t.get("category_account_name"),
                    "posted":                 t.get("posted"),
                    "needs_review":           t.get("needs_review"),
                    "human_reviewed":         t.get("human_reviewed"),
                    "ai_source":              t.get("ai_source"),
                    "ai_confidence":          t.get("ai_confidence"),
                    "source":                 t.get("source"),
                    "external_source":        t.get("external_source"),
                    "qbo_id":                 t.get("qbo_id"),
                    "qbo_txn_type":           t.get("qbo_txn_type"),
                    "imported_at":            t.get("imported_at"),
                    "created_at":             t.get("created_at"),
                    "updated_at":             t.get("updated_at"),
                    "bank_account_id":        t.get("bank_account_id"),
                    "statement_import_id":    t.get("statement_import_id"),
                    "plaid_txn_id":           t.get("plaid_txn_id"),
                    "pfc_detailed":           t.get("pfc_detailed"),
                    "veryfi_category":        t.get("veryfi_category"),
                },
                "why_no_step_surfaces_this_row": reasons,
                "verdict": (
                    "TRUE ORPHAN — flagged=True BUT every step-scope "
                    "excludes it. The CPA cannot clear this row from "
                    "any UI."
                    if (t.get("needs_review") and len(reasons) == 3)
                    else "This row IS surfaceable by at least one step."
                ),
            }

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
            "note": ("If flagged_orphans_no_step > 0 (after the Feb "
                     "2026 counter widening), those rows still lack "
                     "a working approve path in the UI — use "
                     "POST /api/superadmin/diagnostics/clear-orphans/"
                     "{cid}?dry_run=false to bulk-clear them "
                     "(sets human_reviewed=True, needs_review=False, "
                     "ai_source='superadmin_orphan_clear')."),
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
        "trace": trace,
    }



@router.post("/superadmin/diagnostics/clear-orphans/{cid}")
async def clear_orphans(
    cid: str,
    dry_run: bool = True,
    user: dict = Depends(get_current_user),
):
    """Retroactive cleanup for the Feb 2026 "flagged tile never
    clears" leak (Fireplace Place Branson LLC, 497 rows).

    Marks every transaction in the "leaked shape" as reviewed:
        needs_review=True
        AND human_reviewed != True
        AND (contact_id is None OR "")
        AND category_account_id is present + code NOT in
            {6999,4999,9999}

    These are almost always QBO-imported rows that came in pre-
    categorized but were never contact-resolved. Sets
    `human_reviewed=True, needs_review=False, ai_source=
    "superadmin_orphan_clear"` so we can distinguish them from
    normal CPA-approved rows in the audit trail.

    Defaults to `dry_run=True` — returns the count that WOULD be
    cleared without touching anything. Pass `?dry_run=false` to
    actually apply.
    """
    _require_superadmin(user)
    company = await db.companies.find_one({"id": cid}, {"id": 1, "name": 1})
    if not company:
        raise HTTPException(404, f"Company {cid} not found")

    query = {
        "company_id": cid,
        "needs_review": True,
        "human_reviewed": {"$ne": True},
        "$or": [{"contact_id": None}, {"contact_id": ""}],
        "category_account_id": {"$nin": [None, ""]},
        "category_account_code": {"$nin": list(_UNCAT_CODES)},
    }
    matched = await db.transactions.count_documents(query)

    if dry_run:
        return {
            "company": {"id": cid, "name": company["name"]},
            "dry_run": True,
            "would_clear": matched,
            "note": ("Pass `?dry_run=false` to apply. Rows will "
                     "get human_reviewed=True, needs_review=False, "
                     "ai_source='superadmin_orphan_clear'."),
        }

    import datetime as _dt
    now = _dt.datetime.now(_dt.timezone.utc).isoformat()
    result = await db.transactions.update_many(query, {"$set": {
        "human_reviewed":    True,
        "needs_review":      False,
        "ai_source":         "superadmin_orphan_clear",
        "human_reviewed_at": now,
        "human_reviewed_by": user.get("email") or user.get("id"),
        "updated_at":        now,
    }})
    # Invalidate dashboard cache so the tile reflects reality
    # immediately (in-memory cache on this pod only — other pods
    # will refresh on their next TTL expiry if Redis is degraded).
    try:
        await get_cache().ainvalidate(cid)
    except Exception:
        pass
    return {
        "company":  {"id": cid, "name": company["name"]},
        "dry_run":  False,
        "cleared":  result.modified_count,
        "matched":  matched,
        "note":     ("Cache invalidated on this pod. If your prod "
                     "is multi-pod and Redis is unreachable, other "
                     "pods will serve stale counts until their "
                     "5-minute TTL expires."),
    }


@router.post("/superadmin/diagnostics/backfill-qbo-covered-recons/{cid}")
async def backfill_qbo_covered_recons(
    cid: str,
    dry_run: bool = True,
    user: dict = Depends(get_current_user),
):
    """Retroactive relabel: any existing `reconciliations` doc where
    (a) `cleared_sum` ≈ 0 AND (b) QBO transactions cover the same
    date range on the same bank account gets `status="qbo_covered"`.

    Motivation (Feb 2026 — Fireplace Place Branson LLC): the CPA
    uploaded Veryfi statements for periods QBO already covered.
    Ingest correctly skipped Veryfi rows (higher-priority source
    wins) but the reconciliation records were still created with
    `cleared_sum = 0`, showing as green "RECONCILED" with huge
    "diff" values in the UI. This retroactively converts those to
    "QBO VERIFIED" so the CPA sees the correct story.
    """
    _require_superadmin(user)
    company = await db.companies.find_one({"id": cid}, {"id": 1, "name": 1})
    if not company:
        raise HTTPException(404, f"Company {cid} not found")

    candidates: list[dict] = []
    async for rec in db.reconciliations.find({
        "company_id": cid,
        "status": {"$ne": "qbo_covered"},
    }):
        cleared_sum = float(rec.get("cleared_sum") or 0)
        if abs(cleared_sum) >= 0.02:
            continue
        qbo_n = await db.transactions.count_documents({
            "company_id":       cid,
            "bank_account_id":  rec.get("bank_account_id"),
            "source":           "qbo",
            "date": {"$gte": rec.get("period_start"),
                     "$lte": rec.get("period_end")},
        })
        if qbo_n <= 0:
            continue
        candidates.append({
            "recon_id":     rec.get("id"),
            "period_start": rec.get("period_start"),
            "period_end":   rec.get("period_end"),
            "qbo_txn_count": qbo_n,
        })

    if dry_run:
        return {
            "company":    {"id": cid, "name": company["name"]},
            "dry_run":    True,
            "would_relabel": len(candidates),
            "candidates": candidates[:20],
            "note": "Pass `?dry_run=false` to apply. Existing docs "
                    "get status='qbo_covered' + qbo_txn_count_in_range.",
        }

    import datetime as _dt
    now = _dt.datetime.now(_dt.timezone.utc).isoformat()
    relabeled = 0
    for c in candidates:
        r = await db.reconciliations.update_one(
            {"id": c["recon_id"], "company_id": cid},
            {"$set": {
                "status": "qbo_covered",
                "qbo_txn_count_in_range": c["qbo_txn_count"],
                "updated_at": now,
                "relabeled_by": user.get("email") or user.get("id"),
            }},
        )
        relabeled += r.modified_count
    try:
        await get_cache().ainvalidate(cid)
    except Exception:
        pass
    return {
        "company":     {"id": cid, "name": company["name"]},
        "dry_run":     False,
        "relabeled":   relabeled,
        "matched":     len(candidates),
    }



@router.post("/superadmin/diagnostics/rescue-bulk-contact/{cid}")
async def rescue_bulk_contact(
    cid: str,
    payload: dict,
    user: dict = Depends(get_current_user),
):
    """Emergency rescue for accidental bulk-set-contact operations.

    Built March 2026 after a superadmin accidentally applied the wrong
    contact to 25 rows on a live company. Since the old bulk-set-contact
    endpoint didn't snapshot prior values, exact restoration isn't
    guaranteed — but for Plaid-sourced rows the original `merchant`
    field is UNTOUCHED, so we can look each merchant back up in the
    company's contacts table (`normalized_name` match) and put the row
    back onto the contact it originally mapped to.

    Body:
        {
          "contact_id":    "<uuid>",       # the wrongly-applied contact
          "since_minutes": 15,             # look-back window (default 15)
          "mode":          "re-resolve",    # or "clear"
          "execute":       false,          # default preview-only
          "limit":         200
        }

    mode="re-resolve" (default):
        For each affected row, look up `contacts.normalized_name` by
        the row's `merchant` field. If a match exists, restore
        contact_id/contact_name to that. If no match, fall through to
        clear (contact_id/contact_name → null). Preview response
        shows the proposed restoration per row.

    mode="clear":
        Unconditionally clear contact_id / contact_name on affected
        rows. Cheaper, no guessing. Useful when merchant names are
        garbage (raw ACH memos) or contacts have been deleted.
    """
    _require_superadmin(user)
    company = await db.companies.find_one({"id": cid}, {"id": 1, "name": 1})
    if not company:
        raise HTTPException(404, f"Company {cid} not found")

    contact_id = (payload.get("contact_id") or "").strip()
    if not contact_id:
        raise HTTPException(400, "contact_id is required")
    since_minutes = int(payload.get("since_minutes") or 15)
    execute       = bool(payload.get("execute") or False)
    limit         = int(payload.get("limit") or 200)
    mode          = (payload.get("mode") or "re-resolve").strip().lower()
    if mode not in ("re-resolve", "clear"):
        raise HTTPException(400, "mode must be 're-resolve' or 'clear'")

    import datetime as _dt
    since = _dt.datetime.now(_dt.timezone.utc) - _dt.timedelta(minutes=since_minutes)
    since_iso = since.isoformat()

    contact = await db.contacts.find_one({"id": contact_id, "company_id": cid})
    if not contact:
        raise HTTPException(404, "Contact not found in this company")

    query = {
        "company_id": cid,
        "contact_id": contact_id,
        "updated_at": {"$gte": since_iso},
    }
    matched = await db.transactions.count_documents(query)
    rows = await db.transactions.find(query).sort("updated_at", -1).limit(min(matched, limit + 50)).to_list(limit + 50)

    # Build a per-row restoration plan. In re-resolve mode we look up the
    # row's `merchant` against the company's contacts.normalized_name.
    from contact_resolver import _find_by_normalized  # type: ignore

    plan: list[dict] = []
    for t in rows:
        merch = (t.get("merchant") or t.get("description") or "").strip()
        target_contact = None
        source = "clear"
        if mode == "re-resolve" and merch:
            hit = await _find_by_normalized(cid, merch)
            # Skip the wrongly-applied contact itself so we don't
            # "restore" back to the accident.
            if hit and hit.get("id") != contact_id:
                target_contact = hit
                source = "merchant_match"
        plan.append({
            "id":            t["id"],
            "date":          t.get("date"),
            "merchant":      merch,
            "amount":        t.get("amount"),
            "target_contact_id":   target_contact["id"] if target_contact else None,
            "target_contact_name": target_contact.get("name") if target_contact else None,
            "restore_source": source,
        })

    stats = {
        "matched":         matched,
        "resolved_to_contact": sum(1 for p in plan if p["target_contact_id"]),
        "will_clear":      sum(1 for p in plan if not p["target_contact_id"]),
    }

    if not execute:
        return {
            "company":    {"id": cid, "name": company["name"]},
            "contact":    {"id": contact["id"], "name": contact.get("name")},
            "since":      since_iso,
            "mode":       mode,
            "stats":      stats,
            "sample":     plan[:50],
            "dry_run":    True,
            "note":       ("Preview only. Re-POST with execute=true to "
                            "apply. Category, amounts, dates untouched."),
        }

    if matched > limit:
        raise HTTPException(400,
            f"{matched} rows match — exceeds safety limit of {limit}. "
            f"Narrow with `since_minutes` or raise `limit`.")

    now_iso_str = _dt.datetime.now(_dt.timezone.utc).isoformat()
    restored = 0
    cleared = 0
    for p in plan:
        set_doc = {
            "updated_at": now_iso_str,
            "ai_source":  "superadmin_rescue_bulk_contact",
        }
        if p["target_contact_id"]:
            set_doc["contact_id"]   = p["target_contact_id"]
            set_doc["contact_name"] = p["target_contact_name"]
            restored += 1
        else:
            set_doc["contact_id"]   = None
            set_doc["contact_name"] = None
            cleared += 1
        await db.transactions.update_one(
            {"id": p["id"], "company_id": cid, "contact_id": contact_id},
            {"$set": set_doc},
        )

    try:
        await get_cache().ainvalidate(cid)
    except Exception:
        pass
    return {
        "company":    {"id": cid, "name": company["name"]},
        "contact":    {"id": contact["id"], "name": contact.get("name")},
        "mode":       mode,
        "restored_to_original_contact": restored,
        "cleared_no_match":             cleared,
        "matched":    matched,
        "dry_run":    False,
    }
