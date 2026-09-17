"""Lab-v3 → live commit step (Feb-2026).

When a company is on ``categorization_mode == "lab_v3"``, every Plaid
ingest fires ``run_lab_and_commit(company_id, new_txn_ids)`` right
after the raw rows land in ``db.transactions`` (via the ordinary
Standard categorizer). This module:

  1. Runs the full Lab pipeline (Phase 1 + 2 + 3) against the whole
     company (idempotent — the lab pipeline itself is deterministic
     over the current ``db.transactions`` snapshot).
  2. Promotes every ``lab_pending_accounts`` proposal into a real
     ``db.accounts`` doc, deduped by ``(company_id, normalized_name)``.
  3. Overwrites the category / contact / movement fields on each of
     the newly-inserted ``db.transactions`` rows with the Lab's
     decision — preserving Standard's original write shape so the
     rest of the app (Reports, Rules, Insights) doesn't care.

Standard-mode companies never invoke this module. Rollback is safe:
if the CPA flips ``categorization_mode`` back to ``standard``, the
auto-created accounts stay (they're real GAAP accounts now) and
future ingests use ``decide_posting()`` as before.
"""
from __future__ import annotations
import logging
import uuid
from datetime import datetime, timezone

from db import db
from lab_pipeline.collections import LAB_PENDING_ACCOUNTS, LAB_TRANSACTIONS
from lab_pipeline.runner import run_phase1, run_phase2, run_phase3

log = logging.getLogger("axiom.lab.commit")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


async def _promote_pending_accounts(company_id: str) -> dict[str, str]:
    """Promote every ``lab_pending_accounts`` doc with ``status=proposed``
    into a real ``db.accounts`` row. Idempotent: dedupes against live
    accounts by ``normalized_name`` + company_id, so re-runs and manual
    CoA insertions never produce duplicates.

    Returns ``{pending_id → live_account_id}`` so the caller can rewire
    ``lab_transactions.linked_lab_pending`` → ``db.transactions.category_account_id``.
    """
    id_map: dict[str, str] = {}

    # 1. Build normalized-name → live-account index once.
    live_by_nname: dict[str, str] = {}
    async for a in db.accounts.find(
        {"company_id": company_id}, {"id": 1, "name": 1, "_id": 0},
    ):
        nname = (a.get("name") or "").strip().lower()
        if nname:
            live_by_nname[nname] = a["id"]

    # 2. Walk proposed pending docs, promote or dedupe.
    #    Order: parent buckets first so children can link parent_account_id.
    proposed = [p async for p in db[LAB_PENDING_ACCOUNTS].find(
        {"company_id": company_id, "status": "proposed"},
    )]
    proposed.sort(key=lambda p: (not p.get("is_parent_bucket"), p.get("code") or ""))

    pending_id_to_live: dict[str, str] = {}
    for p in proposed:
        nname = p.get("normalized_name") or ""

        # Already exists in the live CoA? Just remap.
        if nname in live_by_nname:
            live_id = live_by_nname[nname]
            id_map[p["id"]] = live_id
            pending_id_to_live[p["id"]] = live_id
            await db[LAB_PENDING_ACCOUNTS].update_one(
                {"id": p["id"]},
                {"$set": {"status": "accepted",
                          "promoted_to_account_id": live_id,
                          "updated_at": _now_iso()}},
            )
            continue

        # Resolve parent_account_id — could point at a live doc or at a
        # parent that we JUST promoted in this same run.
        parent_id = p.get("parent_account_id")
        if not parent_id and p.get("parent_pending_id"):
            parent_id = pending_id_to_live.get(p["parent_pending_id"])

        new_id = str(uuid.uuid4())
        doc = {
            "id":                new_id,
            "company_id":        company_id,
            "code":              p.get("code"),
            "name":              p.get("name"),
            "type":              p.get("type"),
            "subtype":           p.get("subtype"),
            "detail_type":       p.get("detail_type"),
            "parent_account_id": parent_id,
            "active":            True,
            "balance":           0.0,
            "created_by_ai":     True,
            "system_generated":  True,
            "source":            f"lab_v3::{p.get('source', 'lab_auto')}",
            "created_at":        _now_iso(),
            "updated_at":        _now_iso(),
        }
        await db.accounts.insert_one(doc)
        live_by_nname[nname] = new_id
        id_map[p["id"]] = new_id
        pending_id_to_live[p["id"]] = new_id
        await db[LAB_PENDING_ACCOUNTS].update_one(
            {"id": p["id"]},
            {"$set": {"status": "accepted",
                      "promoted_to_account_id": new_id,
                      "updated_at": _now_iso()}},
        )
        log.info("lab_v3.commit: created live account %s (%s / %s) for company %s",
                  new_id, doc["code"], doc["name"], company_id)

    return id_map


async def _commit_categorizations(
    company_id: str,
    pending_to_live: dict[str, str],
) -> dict:
    """Overwrite category / contact / movement fields on every
    ``db.transactions`` row this company owns to match the Lab's
    decision on the paired ``lab_transactions`` doc.

    Only writes rows whose ``ai_source != "lab_v3"`` OR whose category
    changed since last commit (so re-running is cheap).
    """
    stats = {"posted": 0, "unchanged": 0, "no_lab_row": 0, "synthetic_dropped": 0}

    # SAFEGUARD (2026-02-17): make sure we never write a synthetic Step-4
    # tag (``credit_line_paypal_credit``, ``payment_app_paypal``,
    # ``acct-<cid>-<code>``, etc.) as a real GL account id on
    # ``db.transactions.category_account_id``. Root fix lives in
    # step7_category.py; this is a belt-and-braces guard so any leftover
    # bug never reaches the live ledger.
    import re as _re
    _UUID_RX = _re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-"
                           r"[0-9a-f]{4}-[0-9a-f]{12}$")

    async for lab in db[LAB_TRANSACTIONS].find(
        {"company_id": company_id},
        {"txn_id": 1, "category": 1, "category_source": 1,
         "contact": 1, "contact_id_lab": 1, "movement_type": 1,
         "verified": 1, "review_reason": 1, "linked_lab_pending": 1},
    ):
        txn_id = lab.get("txn_id")
        if not txn_id:
            continue
        cat = lab.get("category") or {}
        acct_id = cat.get("account_id")
        # If the row points at a promoted pending account, remap to
        # the live ``db.accounts`` id.
        if acct_id and lab.get("linked_lab_pending") in pending_to_live:
            acct_id = pending_to_live[lab["linked_lab_pending"]]

        # Reject anything that isn't a bona-fide UUID — force a review.
        if acct_id and not (isinstance(acct_id, str) and _UUID_RX.match(acct_id)):
            log.warning(
                "lab_v3.commit: dropping synthetic acct_id=%r on txn %s "
                "(company %s) — forcing needs_review=True",
                acct_id, txn_id, company_id,
            )
            acct_id = None
            stats["synthetic_dropped"] += 1

        needs_review = (bool(lab.get("review_reason"))
                        or not lab.get("verified")
                        or acct_id is None)
        set_doc = {
            "category_account_id":    acct_id,
            "category_account_name":  cat.get("account_name"),
            "category_account_code":  cat.get("account_code"),
            "ai_source":              "lab_v3",
            "ai_confidence":          (cat.get("source") or "").startswith("lab_") and 0.85 or 0.95,
            "ai_reasoning":           cat.get("reason") or "",
            "needs_review":           needs_review,
            "posted":                 not needs_review,
            "review_reason":          lab.get("review_reason"),
            "movement_type":          lab.get("movement_type"),
            "updated_at":             _now_iso(),
        }
        # Contact from Lab (Phase 2) — only overwrite when we have one.
        if lab.get("contact"):
            set_doc["contact_name"]   = lab.get("contact")
        if lab.get("contact_id_lab"):
            set_doc["contact_id"]     = lab.get("contact_id_lab")

        r = await db.transactions.update_one(
            {"company_id": company_id, "id": txn_id,
             "$or": [
                {"ai_source": {"$ne": "lab_v3"}},
                {"category_account_id": {"$ne": acct_id}},
             ]},
            {"$set": set_doc},
        )
        if r.matched_count:
            stats["posted"] += 1
        else:
            # Either the row is already lab_v3-current, or it doesn't exist.
            exists = await db.transactions.count_documents(
                {"company_id": company_id, "id": txn_id}, limit=1,
            )
            if exists:
                stats["unchanged"] += 1
            else:
                stats["no_lab_row"] += 1
    return stats


async def run_lab_and_commit(company_id: str) -> dict:
    """End-to-end commit. Runs Phase 1+2+3, promotes pending accounts,
    overwrites db.transactions. Returns a diagnostics dict for logs."""
    log.info("lab_v3.commit: starting for company %s", company_id)
    p1 = await run_phase1(company_id)
    p2 = await run_phase2(company_id, run_llm=True)
    p3 = await run_phase3(company_id, run_llm=True)
    pending_to_live = await _promote_pending_accounts(company_id)
    commit_stats     = await _commit_categorizations(company_id, pending_to_live)
    result = {
        "phase1":               p1,
        "phase2_contacts":      p2,
        "phase3_categories":    p3,
        "accounts_promoted":    len(pending_to_live),
        "commit":               commit_stats,
    }
    log.info("lab_v3.commit: done for company %s — %s", company_id, commit_stats)
    return result
