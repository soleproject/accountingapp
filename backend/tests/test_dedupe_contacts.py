"""Unit test for the contact dedup script — proves it correctly identifies
duplicate groups and (in --apply mode) repoints FKs + deletes losers without
touching prod data. Uses ephemeral company_ids per test.
"""
import asyncio
import sys
import uuid

sys.path.insert(0, "/app/backend")

from db import db, now_iso  # noqa: E402
from tests.dedupe_contacts import _find_dupes, _repoint_and_delete, _count_fks  # noqa: E402
from tests._shared_loop import run  # noqa: E402


async def _mk_contact(cid: str, name: str, normalized: str, created_at: str) -> str:
    xid = str(uuid.uuid4())
    await db.contacts.insert_one({
        "id": xid, "company_id": cid, "name": name,
        "normalized_name": normalized,
        "created_at": created_at, "updated_at": created_at,
    })
    return xid


async def _drop_uniq_index_if_present():
    """Temporarily drop the unique index so we can seed pre-fix legacy dupes.
    Restored via `_restore_uniq_index` at teardown.
    """
    try:
        await db.contacts.drop_index("company_contact_uniq")
    except Exception:
        pass  # not present — test setup didn't add it yet


async def _restore_uniq_index():
    from contact_resolver import ensure_contact_index
    await ensure_contact_index()


async def _mk_txn(cid: str, contact_id: str) -> str:
    xid = str(uuid.uuid4())
    await db.transactions.insert_one({
        "id": xid, "company_id": cid, "contact_id": contact_id,
        "amount": -10.0, "date": "2026-01-01",
        "created_at": now_iso(), "updated_at": now_iso(),
    })
    return xid


async def _cleanup(cid: str):
    await db.contacts.delete_many({"company_id": cid})
    await db.transactions.delete_many({"company_id": cid})
    await db.invoices.delete_many({"company_id": cid})
    await db.bills.delete_many({"company_id": cid})


def test_find_dupes_groups_by_normalized_name():
    """Two contacts with the same normalized_name in the same company are grouped."""
    async def go():
        cid = f"dedup-find-{uuid.uuid4().hex[:8]}"
        await _drop_uniq_index_if_present()
        try:
            k1 = await _mk_contact(cid, "GitHub", "github", "2026-01-01")
            k2 = await _mk_contact(cid, "GitHub, Inc.", "github", "2026-01-02")
            _ = await _mk_contact(cid, "Stripe", "stripe", "2026-01-01")  # not a dupe

            groups = await _find_dupes(cid)
            # Only the github group should appear (only one with ≥2 docs)
            assert len(groups) == 1
            docs = groups[(cid, "github")]
            assert len(docs) == 2
            # Oldest first — k1 comes before k2 by created_at
            assert docs[0]["id"] == k1
            assert docs[1]["id"] == k2
        finally:
            await _cleanup(cid)
            await _restore_uniq_index()
    run(go())


def test_apply_repoints_and_deletes():
    """--apply mode: FKs get repointed and losers deleted; keeper survives."""
    async def go():
        cid = f"dedup-apply-{uuid.uuid4().hex[:8]}"
        await _drop_uniq_index_if_present()
        try:
            keeper_id = await _mk_contact(cid, "Stripe", "stripe", "2026-01-01")
            loser_id  = await _mk_contact(cid, "Stripe, Inc.", "stripe", "2026-01-02")

            # 3 txns on the loser — should be repointed to keeper
            _ = await _mk_txn(cid, loser_id)
            _ = await _mk_txn(cid, loser_id)
            _ = await _mk_txn(cid, loser_id)
            # 1 txn on the keeper — should stay untouched
            _ = await _mk_txn(cid, keeper_id)

            # Sanity: count FKs before
            fk_before = await _count_fks({loser_id}, cid)
            assert fk_before["transactions"] == 3

            # Apply
            result = await _repoint_and_delete(keeper_id, {loser_id}, cid)
            assert result["transactions"] == 3, result
            assert result["contacts_deleted"] == 1, result

            # Verify: loser is gone
            gone = await db.contacts.find_one({"id": loser_id, "company_id": cid})
            assert gone is None

            # Verify: keeper survives
            surv = await db.contacts.find_one({"id": keeper_id, "company_id": cid})
            assert surv is not None

            # Verify: all 4 txns now point at keeper
            all_txns = await db.transactions.find({"company_id": cid}).to_list(None)
            assert len(all_txns) == 4
            for t in all_txns:
                assert t["contact_id"] == keeper_id, (
                    f"txn {t['id']} still points at old contact: {t['contact_id']}"
                )
        finally:
            await _cleanup(cid)
            await _restore_uniq_index()
    run(go())


def test_dry_run_ignores_singletons_and_empty_keys():
    """Contacts without dupes or without normalized_name are ignored."""
    async def go():
        cid = f"dedup-empty-{uuid.uuid4().hex[:8]}"
        await _drop_uniq_index_if_present()
        try:
            await _mk_contact(cid, "Solo", "solo", "2026-01-01")  # singleton
            # Contact with empty normalized_name — should be skipped
            xid = str(uuid.uuid4())
            await db.contacts.insert_one({
                "id": xid, "company_id": cid, "name": "",
                "normalized_name": "",
                "created_at": now_iso(), "updated_at": now_iso(),
            })

            groups = await _find_dupes(cid)
            assert groups == {}, f"expected no groups, got {list(groups.keys())}"
        finally:
            await _cleanup(cid)
            await _restore_uniq_index()
    run(go())
