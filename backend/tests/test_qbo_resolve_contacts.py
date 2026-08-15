"""Tests for `resolve_transaction_contacts` — the missing resolver that
was leaving Purchase/Deposit/Transfer QBO imports with `contact_qbo_id`
but no `contact_id`, causing the "?" placeholder in the Transactions UI.
"""
from __future__ import annotations

import sys
import uuid

sys.path.insert(0, "/app/backend")

from db import db  # noqa: E402
from qbo_service import resolve_transaction_contacts  # noqa: E402
from tests._shared_loop import run as _run  # noqa: E402


async def _seed(cid: str, contacts: list[dict], txns: list[dict]) -> None:
    for c in contacts:
        c["company_id"] = cid
        await db.contacts.insert_one(c)
    for t in txns:
        t["company_id"] = cid
        t["source"] = "qbo"
        await db.transactions.insert_one(t)


async def _wipe(cid: str) -> None:
    await db.contacts.delete_many({"company_id": cid})
    await db.transactions.delete_many({"company_id": cid})


def test_resolves_only_matching_qbo_ids():
    """A txn whose `contact_qbo_id` matches a local contact gets a
    `contact_id`. Txns with no `contact_qbo_id` (bank-feed without
    payee) or an orphan qbo id are left alone."""
    async def _t():
        cid = f"c-{uuid.uuid4()}"
        try:
            await _seed(cid,
                contacts=[
                    {"id": "local-atmos", "qbo_id": "42",
                     "display_name": "Atmos Energy", "kind": "vendor",
                     "normalized_name": "atmos energy"},
                    {"id": "local-costco", "qbo_id": "77",
                     "display_name": "Costco", "kind": "vendor",
                     "normalized_name": "costco"},
                ],
                txns=[
                    # Matches Atmos
                    {"id": "t-match", "txn_type": "Purchase",
                     "contact_qbo_id": "42"},
                    # QBO gave us no entity — leave contact_id null
                    {"id": "t-no-qbo", "txn_type": "Purchase",
                     "contact_qbo_id": None},
                    # Orphan qbo_id (contact never imported / deleted) — skip
                    {"id": "t-orphan", "txn_type": "Deposit",
                     "contact_qbo_id": "999"},
                    # Already has contact_id — leave alone (idempotency)
                    {"id": "t-already", "txn_type": "Purchase",
                     "contact_qbo_id": "77",
                     "contact_id": "some-manual-id"},
                ],
            )
            updated = await resolve_transaction_contacts(cid)
            assert updated == 1

            def _cid(tid: str):
                async def _q():
                    r = await db.transactions.find_one({"id": tid})
                    return (r or {}).get("contact_id")
                return _q()

            assert (await db.transactions.find_one({"id": "t-match"}))["contact_id"] == "local-atmos"
            assert "contact_id" not in (await db.transactions.find_one({"id": "t-no-qbo"})) or \
                   (await db.transactions.find_one({"id": "t-no-qbo"})).get("contact_id") in (None, "")
            assert (await db.transactions.find_one({"id": "t-orphan"})).get("contact_id") in (None, "")
            # Untouched idempotency case
            assert (await db.transactions.find_one({"id": "t-already"}))["contact_id"] == "some-manual-id"

            # Re-run → 0 (idempotent)
            again = await resolve_transaction_contacts(cid)
            assert again == 0
        finally:
            await _wipe(cid)
    _run(_t())


def test_no_contacts_returns_zero_early():
    """Companies with no imported QBO contacts should return 0 without
    scanning transactions — cheap early-exit."""
    async def _t():
        cid = f"c-{uuid.uuid4()}"
        try:
            await _seed(cid, contacts=[], txns=[
                {"id": "t-orphan", "txn_type": "Purchase",
                 "contact_qbo_id": "42"},
            ])
            updated = await resolve_transaction_contacts(cid)
            assert updated == 0
        finally:
            await _wipe(cid)
    _run(_t())


def test_ignores_non_qbo_sources():
    """A Plaid / manual transaction with the same qbo_id shape must not
    be touched — the resolver is scoped to `source: "qbo"` only."""
    async def _t():
        cid = f"c-{uuid.uuid4()}"
        try:
            await db.contacts.insert_one({
                "company_id": cid, "id": "local-atmos",
                "qbo_id": "42", "display_name": "Atmos Energy",
                "normalized_name": "atmos energy",
            })
            await db.transactions.insert_one({
                "company_id": cid, "id": "t-plaid",
                "source": "plaid", "contact_qbo_id": "42",
            })
            updated = await resolve_transaction_contacts(cid)
            assert updated == 0
            row = await db.transactions.find_one({"id": "t-plaid"})
            assert row.get("contact_id") in (None, "")
        finally:
            await _wipe(cid)
    _run(_t())
