"""Clean up synthetic seed data on Test 519 LLC and rebuild the Quick
Check-In (client_review_batch) using REAL uncategorized transactions
+ REAL open agent_findings.

Why this exists:
  * `seed_test519_batch_demo.py` planted 4 `demo1-*` transactions and
    13 demo-tagged findings so we could exercise the grouped batch UI
    before the client actually had aging uncategorized txns. Real data
    is now on the books, so the demo is misleading.

  * The stock `_collect_aged_uncategorized` filter is 7d — real
    uncategorized txns on this company are all created_at 2026-09-13
    (fresh imports), which the streaming per-txn asker is designed to
    own first. For the client-facing check-in we bypass that gate and
    seed a batch off the top-N highest-|amount| real uncategorized rows.
    Real `agent_findings` (contact_duplicate, missing_receipt, etc.)
    flow through the standard `_collect_agent_findings` collector
    untouched.

Idempotent — cleanup phase always runs first, so you can invoke this
whenever the batch drifts out of sync with ledger reality.

Run with `PYTHONPATH=/app/backend python scripts/rebuild_test519_real_batch.py`.
"""
from __future__ import annotations
import asyncio
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from deps import db
import client_review as cr


COMPANY_NAME    = "Test 519 LLC"
CLIENT_EMAIL    = "michael+test519@bigsaas.ai"
LEGACY_DEMO_TAG = "seed_test519_multi_demo_v1"
REAL_DEMO_TAG   = "seed_test519_real_v1"
MAX_UNCAT_ITEMS = 12   # top-N by |amount|; the client sees a manageable list


async def _cleanup_legacy_demo(cid: str) -> dict:
    """Purge every synthetic row planted by the legacy seed."""
    # 1. Legacy demo transactions (demo1-* prefix + demo_tag).
    txns_by_tag = await db.transactions.delete_many(
        {"company_id": cid, "demo_tag": LEGACY_DEMO_TAG},
    )
    txns_by_prefix = await db.transactions.delete_many(
        {"company_id": cid, "id": {"$regex": r"^demo1-"}},
    )
    # 2. Legacy demo findings.
    findings = await db.agent_findings.delete_many(
        {"company_id": cid, "demo_tag": LEGACY_DEMO_TAG},
    )
    # 3. Any previously-issued demo batches (legacy or previous real seed).
    #    Un-stamp the batch_id on any source rows so live collectors
    #    can re-pick them next tick.
    batches_to_kill = []
    async for b in db.client_review_batches.find({
        "company_id": cid,
        "demo_tag":   {"$in": [LEGACY_DEMO_TAG, REAL_DEMO_TAG]},
    }, {"id": 1, "items": 1}):
        batches_to_kill.append(b)
    for b in batches_to_kill:
        by_coll: dict[str, list[str]] = {}
        for it in b.get("items") or []:
            by_coll.setdefault(it["source_collection"], []).append(it["source_id"])
        for coll, ids in by_coll.items():
            try:
                await db[coll].update_many(
                    {"id": {"$in": ids}, "company_id": cid,
                     "batch_id": b["id"]},
                    {"$unset": {"batch_id": ""},
                     "$set":   {"updated_at": cr.now_iso()}},
                )
            except Exception:
                pass
    batches_result = await db.client_review_batches.delete_many({
        "company_id": cid,
        "demo_tag":   {"$in": [LEGACY_DEMO_TAG, REAL_DEMO_TAG]},
    })
    # 4. Also collapse any *other* open batches on this company —
    #    otherwise `has_open_batch` blocks the new one.
    other_open = []
    async for b in db.client_review_batches.find({
        "company_id":   cid,
        "client_email": CLIENT_EMAIL,
        "status":       {"$in": ["open", "scheduled"]},
    }, {"id": 1, "items": 1}):
        other_open.append(b)
    for b in other_open:
        by_coll = {}
        for it in b.get("items") or []:
            by_coll.setdefault(it["source_collection"], []).append(it["source_id"])
        for coll, ids in by_coll.items():
            try:
                await db[coll].update_many(
                    {"id": {"$in": ids}, "company_id": cid,
                     "batch_id": b["id"]},
                    {"$unset": {"batch_id": ""},
                     "$set":   {"updated_at": cr.now_iso()}},
                )
            except Exception:
                pass
        await db.client_review_batches.update_one(
            {"id": b["id"]},
            {"$set": {"status":        "expired",
                      "expired_at":    cr.now_iso(),
                      "expire_reason": "superseded_by_real_rebuild"}},
        )
    return {
        "txns_demo_tag":   txns_by_tag.deleted_count,
        "txns_demo_prefix": txns_by_prefix.deleted_count,
        "findings":         findings.deleted_count,
        "batches_deleted":  batches_result.deleted_count,
        "other_open_expired": len(other_open),
    }


_INTERNAL_TRANSFER_PATTERNS = (
    "online banking transfer",
    "internet transfer",
    "transfer from chk",
    "transfer to chk",
    "transfer from sav",
    "transfer to sav",
    "bank transfer",
)


def _is_internal_transfer(t: dict) -> bool:
    """Bank-to-own-bank transfers aren't useful client questions."""
    haystack = " ".join([
        (t.get("merchant")    or ""),
        (t.get("description") or ""),
    ]).lower()
    return any(p in haystack for p in _INTERNAL_TRANSFER_PATTERNS)


async def _collect_real_uncategorized(cid: str, limit: int) -> list[dict]:
    """Highest-|amount| real uncategorized txns — bypasses the 7d aged
    filter used in production so a freshly-imported ledger can still
    seed a client-facing check-in. Filters out internal bank transfers
    since asking the client "what was this transfer between your own
    accounts for" is noise.
    """
    q = {
        "company_id":     cid,
        "needs_review":   True,
        "human_reviewed": {"$ne": True},
        # Not already in a live batch.
        "batch_id":       {"$in": [None, ""]},
        # Not already asked via the per-txn streaming path.
        "client_question_id": {"$in": [None, ""]},
        # Exclude anything the legacy seed left behind.
        "demo_tag":       {"$exists": False},
    }
    # Sort by absolute value descending — Mongo can't sort on an
    # aggregate directly, so we fetch a bigger window and sort in
    # Python. limit*8 keeps the memory bounded while giving us headroom
    # to drop internal transfers.
    candidates = []
    async for t in db.transactions.find(q).limit(limit * 8):
        if _is_internal_transfer(t):
            continue
        candidates.append(t)
    candidates.sort(key=lambda t: -abs(float(t.get("amount") or 0)))
    items: list[dict] = []
    for t in candidates[:limit]:
        items.append({
            "item_id":           str(uuid.uuid4()),
            "item_type":         cr.ITEM_UNCATEGORIZED,
            "source_id":         t["id"],
            "source_collection": "transactions",
            "prompt":            cr._prompt_for_uncategorized(t),
            "context": {
                "date":        t.get("date"),
                "amount":      t.get("amount"),
                "description": t.get("description"),
                "merchant":    t.get("merchant"),
                "account":     t.get("bank_account_name"),
            },
            "answered_at":  None,
            "answer":       None,
            "deferred":     False,
            "action_taken": None,
        })
    return items


async def _collect_real_findings(cid: str) -> list[dict]:
    """Every non-demo open finding of a kind the client can help with.

    Kinds included match `_KIND_MAP`: contact_mismatch, contact_duplicate,
    missing_receipt, w9_needed, ambiguous_transfer, new_recurring_charge,
    setup_missing, split_suggested, liability_split_needed. We rely on
    the same shape `_collect_agent_findings` produces so downstream
    rendering (grouped progress bars, type-specific transitions) works.

    category_mismatch is intentionally excluded — its details are
    CPA-facing ("hard_wrong_signals list") and live in the pro-side
    cockpit cleanup queue.
    """
    items: list[dict] = []
    for item_type in (
        cr.ITEM_VENDOR_MEMO,
        cr.ITEM_MISSING_RECEIPT,
        cr.ITEM_W9_NEEDED,
        cr.ITEM_AMBIGUOUS_TRANSFER,
        cr.ITEM_RECURRING,
        cr.ITEM_SETUP,
        cr.ITEM_SPLIT,
        cr.ITEM_LIABILITY_SPLIT,
    ):
        kinds = cr._KIND_MAP.get(item_type) or []
        if not kinds:
            continue
        async for f in db.agent_findings.find({
            "company_id": cid,
            "kind":       {"$in": kinds},
            "status":     "open",
            "batch_id":   {"$in": [None, ""]},
            "demo_tag":   {"$exists": False},
        }).sort("created_at", -1).limit(10):
            items.append({
                "item_id":           str(uuid.uuid4()),
                "item_type":         item_type,
                "source_id":         f["id"],
                "source_collection": "agent_findings",
                "prompt":            f.get("detail") or f.get("title") or "",
                "context": {
                    "kind":     f.get("kind"),
                    "title":    f.get("title"),
                    "severity": f.get("severity"),
                    "meta":     f.get("meta") or {},
                },
                "answered_at":  None,
                "answer":       None,
                "deferred":     False,
                "action_taken": None,
            })
    return items


async def main():
    co = await db.companies.find_one({"name": COMPANY_NAME})
    if not co:
        print(f"FATAL: {COMPANY_NAME!r} not found in DB.")
        return 2
    cid = co["id"]
    print(f"Using company {co['name']} ({cid})")

    print("\n--- Cleanup phase ---")
    stats = await _cleanup_legacy_demo(cid)
    print(f"  synthetic demo1-* txns deleted: {stats['txns_demo_prefix']}")
    print(f"  demo-tagged txns deleted:       {stats['txns_demo_tag']}")
    print(f"  demo findings deleted:          {stats['findings']}")
    print(f"  demo batches deleted:           {stats['batches_deleted']}")
    print(f"  other open batches expired:     {stats['other_open_expired']}")

    print("\n--- Collect real items ---")
    uncat_items = await _collect_real_uncategorized(cid, MAX_UNCAT_ITEMS)
    finding_items = await _collect_real_findings(cid)
    items = uncat_items + finding_items
    print(f"  real uncategorized picked:  {len(uncat_items)}")
    print(f"  real agent_findings picked: {len(finding_items)}")

    if not items:
        print("\nNothing real to build a batch from. Cleanup complete; "
              "no batch was created.")
        return 0

    # Reuse the same sort key `collect_batch_items` uses so the client
    # sees Uncategorized first, then Liability, etc.
    _TYPE_ORDER = {
        cr.ITEM_UNCATEGORIZED:      1,
        cr.ITEM_LIABILITY_SPLIT:    2,
        cr.ITEM_MISSING_RECEIPT:    3,
        cr.ITEM_VENDOR_MEMO:        4,
        cr.ITEM_SPLIT:              5,
        cr.ITEM_AMBIGUOUS_TRANSFER: 6,
        cr.ITEM_RECURRING:          7,
        cr.ITEM_SETUP:              8,
        cr.ITEM_W9_NEEDED:          9,
    }
    def _key(it):
        prim = _TYPE_ORDER.get(it.get("item_type") or 0, 99)
        ctx = it.get("context") or {}
        amt = (ctx.get("meta") or {}).get("txn_amount")
        if amt is None:
            amt = ctx.get("amount")
        try:
            amt_key = -abs(float(amt)) if amt is not None else 0
        except (TypeError, ValueError):
            amt_key = 0
        return (prim, amt_key)
    items.sort(key=_key)

    print("\n--- Build batch ---")
    batch = await cr.create_batch(cid, CLIENT_EMAIL, items)
    await db.client_review_batches.update_one(
        {"id": batch["id"]},
        {"$set": {"demo_tag": REAL_DEMO_TAG}},
    )

    from email_dispatcher import public_base_url
    base = public_base_url()
    review_url = f"{base}/client-review/{batch['client_token']}"

    from collections import Counter
    LABELS = {
        1: "Uncategorized",
        2: "Vendor confirmation",
        3: "Missing receipt",
        4: "W-9 collection",
        5: "Ambiguous transfer",
        6: "New recurring",
        7: "Setup detail",
        8: "Split suggested",
        9: "Liability split",
    }
    counts = Counter(i["item_type"] for i in items)

    print()
    print("=" * 72)
    print(f"REAL BATCH — {COMPANY_NAME}")
    print("=" * 72)
    print(f"  batch_id:      {batch['id']}")
    print(f"  items:         {len(items)}")
    for it, c in sorted(counts.items()):
        print(f"    · {LABELS.get(it, it):24}  {c}")
    print(f"  review URL:    {review_url}")
    print("=" * 72)
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
