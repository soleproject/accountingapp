"""Reset all Quick Check-in items for a given company back to `gathering`.

Full GL reversal is performed by re-using the exact logic from
`routes.client_review.reopen_review_item`, so bill/invoice balances,
db.payments docs, transaction category snapshots, and agent_findings
rows are all restored identically to a client-initiated Undo.

Bypasses the token/expired checks so expired batches can also be reset.

Usage:
    cd /app/backend && python3 scripts/reset_quick_checkins.py "Test 519 LLC"
"""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

# Make backend package importable
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from dotenv import load_dotenv  # noqa: E402
load_dotenv("/app/backend/.env")

from routes import client_review as cr  # noqa: E402
from routes.client_review import db  # noqa: E402


async def _reset_one(batch: dict, item: dict) -> dict:
    """Invoke the reopen logic directly, bypassing _resolve_batch."""
    # Monkey-patch _resolve_batch just for this call so expired batches
    # can still be reset.
    async def _fake_resolve(_token):  # noqa: ARG001
        return batch

    original = cr._resolve_batch
    cr._resolve_batch = _fake_resolve
    try:
        return await cr.reopen_review_item(
            batch.get("client_token") or "x" * 32,
            item["item_id"],
        )
    finally:
        cr._resolve_batch = original


async def main(company_name: str) -> None:
    co = await db.companies.find_one({"name": company_name}, {"id": 1, "name": 1})
    if not co:
        print(f"[!] Company not found: {company_name}")
        return
    cid = co["id"]
    print(f"[+] Company: {co['name']}  id={cid}")

    batches = await db.client_review_batches.find(
        {"company_id": cid}
    ).to_list(length=None)
    print(f"[+] Batches found: {len(batches)}")

    reset_ok = 0
    reset_skipped = 0
    reset_failed = 0
    orphan_cleaned = 0
    now = cr._now_iso()

    for b in batches:
        items = b.get("items") or []
        for it in items:
            has_answered_at = bool(it.get("answered_at"))
            has_deferred = bool(it.get("deferred"))
            has_action = bool(it.get("action_taken"))
            has_payload = bool(it.get("answered_payload"))
            not_gathering = (it.get("state") not in (None, "gathering"))

            if not any(
                (has_answered_at, has_deferred, has_action,
                 has_payload, not_gathering)
            ):
                continue  # already clean

            iid = it.get("item_id")
            action = it.get("action_taken") or "—"

            # If the item lacks answered_at/deferred, the endpoint would
            # 409. But it may still carry stale action_taken / GL
            # side-effects. Force the reversal path by temporarily
            # setting answered_at so the endpoint proceeds.
            if not (has_answered_at or has_deferred):
                await db.client_review_batches.update_one(
                    {"id": b["id"], "items.item_id": iid},
                    {"$set": {"items.$.answered_at": now}},
                )
                # Refresh in-memory copy so _fake_resolve returns the
                # freshly-mutated batch.
                b = await db.client_review_batches.find_one({"id": b["id"]})
                it_fresh = next(
                    (x for x in (b.get("items") or []) if x.get("item_id") == iid),
                    None,
                ) or it

            try:
                res = await _reset_one(b, it)
                bits = ", ".join(res.get("reversed_bits") or []) or "no side effects"
                print(f"    ✓ batch {b['id'][:8]}  item {iid[:8]}  "
                      f"action={action}  →  {bits}")
                reset_ok += 1
            except Exception as exc:  # noqa: BLE001
                print(f"    ✗ batch {b['id'][:8]}  item {iid[:8]}  "
                      f"action={action}  FAILED: {exc}")
                reset_failed += 1
                # Best-effort DB fallback so the item still shows up
                # in the queue.
                await db.client_review_batches.update_one(
                    {"id": b["id"], "items.item_id": iid},
                    {"$set": {"items.$.state": "gathering",
                              "items.$.status": "open",
                              "updated_at": now},
                     "$unset": {"items.$.answered_at": "",
                                "items.$.answer": "",
                                "items.$.action_taken": "",
                                "items.$.action_detail": "",
                                "items.$.answered_payload": "",
                                "items.$.answered_by_client": "",
                                "items.$.deferred": "",
                                "items.$.result": ""}},
                )
                orphan_cleaned += 1

    print()
    print(f"[✓] Reset complete: {reset_ok} reset, "
          f"{reset_failed} recovered via DB fallback, "
          f"{reset_skipped} skipped (already clean).")

    # Also invalidate dashboard cache one more time
    try:
        from routes.transactions import _invalidate_dash
        await _invalidate_dash(cid)
    except Exception:  # noqa: BLE001
        pass


if __name__ == "__main__":
    name = " ".join(sys.argv[1:]).strip() or "Test 519 LLC"
    asyncio.run(main(name))
