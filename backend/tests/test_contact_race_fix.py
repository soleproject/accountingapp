"""Contact upsert race hardening (Feb 2026).

Two endpoints previously 500'd on the E11000 duplicate-key race:
  • POST /companies/{cid}/contacts        — manual create
  • POST /companies/{cid}/contacts/import/commit — bulk import

Both now catch `DuplicateKeyError`, re-fetch the winning doc, and either
return it (manual create) or treat it as an update (import). This test
proves both paths by racing concurrent inserts of the same normalized
name and asserting: (a) no exception surfaces, (b) exactly one contact
doc lands per (company_id, normalized_name), (c) the endpoint responses
carry the same winner's id.

Uses the shared-loop pattern (see test_iteration11_dedup_fixes.py) so
motor's client (bound at import time) stays on a live loop across tests.
"""
import asyncio
import sys
import uuid

sys.path.insert(0, "/app/backend")

from db import db  # noqa: E402
from routes.contacts import create_contact, contacts_import_commit  # noqa: E402
from routes.contacts import ContactsImportCommitIn  # noqa: E402
from models import ContactCreate  # noqa: E402
import contact_resolver  # noqa: E402


# Module-scoped loop keeps motor happy — otherwise pytest-asyncio's per-test
# loop closes and motor errors with "Event loop is closed" on the next test.
from tests._shared_loop import run  # noqa: E402


async def _seed_membership(uid: str, cid: str):
    # First-time index setup — idempotent, safe to call per test.
    await contact_resolver.ensure_contact_index()
    # `require_company` walks memberships AND checks `db.companies` exists,
    # so we seed both. Test cid is unique per-test → no cross-test bleed.
    from db import now_iso
    await db.companies.update_one(
        {"id": cid},
        {"$set": {"id": cid, "name": "TestCo", "created_at": now_iso(),
                  "updated_at": now_iso()}},
        upsert=True,
    )
    await db.memberships.update_one(
        {"user_id": uid, "company_id": cid},
        {"$set": {"user_id": uid, "company_id": cid, "role": "owner"}},
        upsert=True,
    )


async def _cleanup(cid: str, uid: str):
    await db.contacts.delete_many({"company_id": cid})
    await db.contact_imports.delete_many({"company_id": cid})
    await db.companies.delete_many({"id": cid})
    await db.memberships.delete_many({"user_id": uid})


def _fake_user(uid: str) -> dict:
    """Bypass FastAPI's Depends by hand-building the user dict shape
    that `require_company` walks. Membership check is done via memberships."""
    return {"id": uid, "email": f"{uid}@test.local", "role": "pro"}


def test_manual_create_race_does_not_500():
    """Two concurrent POSTs of the same contact name land as ONE doc, no 500."""
    async def go():
        cid = f"race-test-{uuid.uuid4().hex[:8]}"
        uid = f"user-{uuid.uuid4().hex[:8]}"
        await _seed_membership(uid, cid)
        try:
            inp = ContactCreate(name="GitHub, Inc.", type="vendor")
            user = _fake_user(uid)

            # Fire two concurrent creates.
            results = await asyncio.gather(
                create_contact(cid, inp, user=user),
                create_contact(cid, inp, user=user),
                return_exceptions=True,
            )

            # Neither call should have raised an exception (previously one 500'd).
            for r in results:
                assert not isinstance(r, Exception), f"unexpected exception: {r!r}"

            # Both responses should carry an id, and they should be the SAME id
            # (whichever insert won → the other found_and_returned it).
            ids = [r["id"] for r in results]
            assert ids[0] == ids[1], f"race produced two different ids: {ids}"

            # Exactly one contact doc landed for this normalized name.
            docs = await db.contacts.find(
                {"company_id": cid, "normalized_name": "github"},
            ).to_list(None)
            assert len(docs) == 1, f"expected 1 contact, got {len(docs)}: {docs}"
        finally:
            await _cleanup(cid, uid)
    run(go())


def test_import_commit_race_does_not_500():
    """Concurrent import commits that both contain 'Stripe' land as one doc."""
    async def go():
        cid = f"race-imp-{uuid.uuid4().hex[:8]}"
        uid = f"user-{uuid.uuid4().hex[:8]}"
        await _seed_membership(uid, cid)
        try:
            inp = ContactsImportCommitIn(
                contacts=[{"name": "Stripe, Inc.", "type": "vendor", "email": "billing@stripe.com"}],
                filename="test.csv",
                source="csv",
            )
            user = _fake_user(uid)

            # Fire two concurrent import commits with the same row.
            results = await asyncio.gather(
                contacts_import_commit(cid, inp, user=user),
                contacts_import_commit(cid, inp, user=user),
                return_exceptions=True,
            )

            # Neither should have raised.
            for r in results:
                assert not isinstance(r, Exception), f"unexpected exception: {r!r}"

            # Exactly one contact doc landed.
            docs = await db.contacts.find(
                {"company_id": cid, "normalized_name": "stripe"},
            ).to_list(None)
            assert len(docs) == 1, f"expected 1 contact, got {len(docs)}: {docs}"

            # Total (created + updated) across both calls covers both attempts.
            total_created = sum(r.get("created", 0) for r in results)
            total_updated = sum(r.get("updated", 0) for r in results)
            # One creation + one update (from the race-loser's path)
            assert total_created == 1, f"expected 1 create, got {total_created}"
            assert total_updated == 1, f"expected 1 update (race-loser), got {total_updated}"
        finally:
            await _cleanup(cid, uid)
    run(go())


def test_normalized_name_collision_returns_existing():
    """Creating 'GitHub' then 'GitHub, Inc.' returns the same id (same normalized_name)."""
    async def go():
        cid = f"norm-test-{uuid.uuid4().hex[:8]}"
        uid = f"user-{uuid.uuid4().hex[:8]}"
        await _seed_membership(uid, cid)
        try:
            user = _fake_user(uid)
            r1 = await create_contact(cid, ContactCreate(name="GitHub", type="vendor"), user=user)
            r2 = await create_contact(cid, ContactCreate(name="GitHub, Inc.", type="vendor"), user=user)

            # Both should return the SAME id — the second collides on
            # normalized_name and returns the existing doc.
            assert r1["id"] == r2["id"], f"expected same id, got {r1['id']} vs {r2['id']}"

            # Only one doc for this normalized name.
            docs = await db.contacts.find(
                {"company_id": cid, "normalized_name": "github"},
            ).to_list(None)
            assert len(docs) == 1
        finally:
            await _cleanup(cid, uid)
    run(go())
