"""Regression tests for the Feb 2026 contact-identity harden."""
import sys, os, asyncio, uuid
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from tests._shared_loop import run
from contact_identity import (
    is_pseudo_contact_name,
    entry_source_from_resolution_source,
    record_identity_event,
    undo_identity_event,
    detect_false_merges,
)
from deps import db


# --------------------------------------------------------------------------
# Pure helpers — no DB
# --------------------------------------------------------------------------

def test_pseudo_contact_detection():
    """Bank / payment-rail placeholder rows must be identifiable so
    they're excluded from all merge / split proposals."""
    for name in ["Wells Fargo", "Chase Bank", "Bank of America",
                 "Venmo", "Zelle", "PayPal", "Cash App"]:
        assert is_pseudo_contact_name(name), f"expected pseudo: {name!r}"
    for name in ["Amazon", "Costco", "Kevin Petersen",
                 "Wells Fargo Home Mortgage", "Chase Sapphire Preferred"]:
        # These extend the bank name — they DO refer to real products
        # but the normalized form matches "wells fargo home mortgage" etc.
        # Only the exact bank names should flag. "Wells Fargo Home Mortgage"
        # normalizes to itself which is NOT in the pseudo set.
        assert not is_pseudo_contact_name(name), f"expected NOT pseudo: {name!r}"


def test_entry_source_mapping():
    assert entry_source_from_resolution_source("merchant_name") == "plaid"
    assert entry_source_from_resolution_source("global_directory") == "plaid"
    assert entry_source_from_resolution_source("p2p_enriched") == "plaid"
    assert entry_source_from_resolution_source("veryfi") == "veryfi"
    assert entry_source_from_resolution_source("manual") == "manual"
    assert entry_source_from_resolution_source(None) == "unknown"
    assert entry_source_from_resolution_source("not_a_real_source") == "unknown"


# --------------------------------------------------------------------------
# End-to-end: merge → audit event → undo restores state
# --------------------------------------------------------------------------

async def _make_contact(cid, name, **kw):
    doc = {
        "id": str(uuid.uuid4()), "company_id": cid, "name": name,
        "normalized_name": name.lower().replace(",", "").replace(".", ""),
        "type": None, "created_at": "2026-01-01T00:00:00+00:00",
        "updated_at": "2026-01-01T00:00:00+00:00",
        **kw,
    }
    await db.contacts.insert_one(doc)
    return doc


async def _make_txn(cid, contact_id, contact_name, amount=-10.0):
    doc = {
        "id": str(uuid.uuid4()), "company_id": cid,
        "date": "2026-02-01",
        "description": "test", "merchant": contact_name,
        "amount": amount, "contact_id": contact_id, "contact_name": contact_name,
        "bank_account_id": "x", "bank_account_name": "x",
    }
    await db.transactions.insert_one(doc)
    return doc


async def _e2e_merge_and_undo():
    """Merge two contacts, assert audit event captured everything, undo
    the merge, assert the DB is bit-identical to pre-merge state
    (except for `original_contact_id` on transactions — which is
    intentional and idempotent)."""
    cid = f"test-{uuid.uuid4()}"
    keeper = await _make_contact(cid, "Amazon Marketplace")
    loser  = await _make_contact(cid, "AMZN MKTP")
    txn_k  = await _make_txn(cid, keeper["id"], keeper["name"])
    txn_l1 = await _make_txn(cid, loser["id"], loser["name"], amount=-25)
    txn_l2 = await _make_txn(cid, loser["id"], loser["name"], amount=-50)

    # Simulate the merge — stamp original_contact_id, reassign, record event.
    for r in [txn_l1, txn_l2]:
        await db.transactions.update_one(
            {"id": r["id"]},
            {"$set": {"original_contact_id": r["contact_id"]}},
        )
    await db.transactions.update_many(
        {"company_id": cid, "contact_id": loser["id"]},
        {"$set": {"contact_id": keeper["id"], "contact_name": keeper["name"]}},
    )
    event = await record_identity_event(
        company_id=cid, kind="merge", actor="test",
        keeper_id=keeper["id"], loser_ids=[loser["id"]],
        affected_docs={"transactions": [txn_l1["id"], txn_l2["id"]]},
        affected_txn_ids=[txn_l1["id"], txn_l2["id"]],
        before={"contacts": [loser]},
    )
    await db.contacts.delete_one({"id": loser["id"]})

    # Assert post-merge state
    assert await db.contacts.count_documents({"company_id": cid}) == 1
    assert await db.transactions.count_documents(
        {"company_id": cid, "contact_id": keeper["id"]}
    ) == 3

    # Undo
    result = await undo_identity_event(event["id"], actor="test")
    assert result["restored_contacts"] == 1
    assert result["reassigned"]["transactions"] == 2

    # Assert pre-merge state restored
    assert await db.contacts.count_documents({"company_id": cid}) == 2
    assert await db.transactions.count_documents(
        {"company_id": cid, "contact_id": loser["id"]}
    ) == 2, "loser txns must be re-assigned back"
    assert await db.transactions.count_documents(
        {"company_id": cid, "contact_id": keeper["id"]}
    ) == 1, "keeper txn must NOT have moved"

    # Event marked undone
    fresh = await db.contact_identity_events.find_one({"id": event["id"]})
    assert fresh.get("undone_at")

    # Cleanup
    await db.contacts.delete_many({"company_id": cid})
    await db.transactions.delete_many({"company_id": cid})
    await db.contact_identity_events.delete_many({"company_id": cid})


def test_merge_and_undo():
    run(_e2e_merge_and_undo())


# --------------------------------------------------------------------------
# Entity-ID adopt: existing null-eid contact + new row with eid → stamp +
# audit event + undo unsets. Verifies the "identity strengthening" path
# added Feb 2026 (post-Phase-2 pivot away from split proposals).
# --------------------------------------------------------------------------

async def _e2e_adopt_entity_id():
    from contact_resolver import _insert_contact
    cid = f"test-{uuid.uuid4()}"
    # Existing contact with NO entity_id (legacy — created before we
    # tracked eid). Same-name Plaid row arrives with an eid.
    existing = await _make_contact(cid, "Microsoft", merchant_entity_id=None)
    assert existing.get("merchant_entity_id") is None

    result = await _insert_contact(
        cid, "Microsoft", source="merchant_name",
        merchant_entity_id="ent_msbill_xxx",
    )
    # Must return the SAME contact (adopted, not fractured).
    assert result["id"] == existing["id"], "expected adopt, not new contact"
    # DB row now has the eid stamped.
    fresh = await db.contacts.find_one({"id": existing["id"]})
    assert fresh["merchant_entity_id"] == "ent_msbill_xxx", \
        "eid should have been stamped onto existing contact"

    # Audit event was written.
    ev = await db.contact_identity_events.find_one(
        {"company_id": cid, "kind": "stamp_entity_id"},
    )
    assert ev is not None, "stamp_entity_id event must be recorded"
    assert ev["keeper_id"] == existing["id"]
    assert ev["evidence"]["merchant_entity_id"] == "ent_msbill_xxx"

    # Undo — unsets the eid, marks event undone.
    from contact_identity import undo_identity_event
    undo = await undo_identity_event(ev["id"], actor="test")
    assert undo["ok"] and undo["unset"]
    fresh = await db.contacts.find_one({"id": existing["id"]})
    assert fresh.get("merchant_entity_id") is None, "undo must unset eid"
    ev_after = await db.contact_identity_events.find_one({"id": ev["id"]})
    assert ev_after["undone_at"] is not None

    # Cleanup
    await db.contacts.delete_many({"company_id": cid})
    await db.contact_identity_events.delete_many({"company_id": cid})


def test_adopt_entity_id():
    run(_e2e_adopt_entity_id())


# --------------------------------------------------------------------------
# Entity-ID fracture: existing non-null eid + new row with DIFFERENT eid →
# disambiguated child ("Microsoft (#2)") + auto_split event + undo restores
# by deleting the child and reassigning its txns back to the keeper.
# --------------------------------------------------------------------------

async def _e2e_fracture_entity_id():
    from contact_resolver import _insert_contact
    cid = f"test-{uuid.uuid4()}"
    keeper = await _make_contact(
        cid, "Microsoft", merchant_entity_id="ent_msbill_A",
    )
    # Different eid arrives with the same name — must FRACTURE, not merge.
    child = await _insert_contact(
        cid, "Microsoft", source="merchant_name",
        merchant_entity_id="ent_xbox_B",
    )
    assert child["id"] != keeper["id"], "must not merge across different eids"
    assert child["name"] == "Microsoft (#2)"
    assert child["merchant_entity_id"] == "ent_xbox_B"

    # Audit event recorded.
    ev = await db.contact_identity_events.find_one(
        {"company_id": cid, "kind": "auto_split"},
    )
    assert ev is not None, "auto_split event must be recorded"
    assert ev["keeper_id"] == keeper["id"]
    assert ev["split_child_ids"] == [child["id"]]
    assert ev["evidence"]["keeper_entity_id"] == "ent_msbill_A"
    assert ev["evidence"]["child_entity_id"] == "ent_xbox_B"

    # Attach a txn to the child so we can verify reassignment on undo.
    txn = await _make_txn(cid, child["id"], child["name"], amount=-99)

    # Undo — delete child + reassign txn back to keeper.
    from contact_identity import undo_identity_event
    undo = await undo_identity_event(ev["id"], actor="test")
    assert undo["ok"]
    assert undo["deleted_children"] == 1
    assert undo["reassigned"]["transactions"] == 1

    # Child gone; txn on keeper.
    assert await db.contacts.find_one({"id": child["id"]}) is None
    fresh_txn = await db.transactions.find_one({"id": txn["id"]})
    assert fresh_txn["contact_id"] == keeper["id"]
    assert fresh_txn["contact_name"] == keeper["name"]

    # Cleanup
    await db.contacts.delete_many({"company_id": cid})
    await db.transactions.delete_many({"company_id": cid})
    await db.contact_identity_events.delete_many({"company_id": cid})


def test_fracture_entity_id():
    run(_e2e_fracture_entity_id())


if __name__ == "__main__":
    import traceback
    ns = dict(globals())
    tests = [(k, v) for k, v in ns.items() if k.startswith("test_") and callable(v)]
    passed, failed = 0, 0
    for name, fn in tests:
        try:
            fn()
            print(f"ok   {name}")
            passed += 1
        except AssertionError as e:
            print(f"FAIL {name}: {e or 'assertion'}")
            traceback.print_exc()
            failed += 1
        except Exception as e:  # noqa: BLE001
            print(f"ERR  {name}: {type(e).__name__}: {e}")
            traceback.print_exc()
            failed += 1
    print(f"\n{passed} passed, {failed} failed")
    sys.exit(0 if failed == 0 else 1)
