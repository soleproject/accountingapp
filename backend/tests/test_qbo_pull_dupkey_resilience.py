"""Regression — QBO permits duplicate DocNumbers on Estimates and
Purchase Orders. Our pull must not crash the batch if a legacy local
unique index blocks the insert, and must adopt orphaned pre-mirror
rows sharing the same natural key."""
from __future__ import annotations
import asyncio
import sys
import inspect
import pytest

sys.path.insert(0, "/app/backend")


def test_pull_estimates_wraps_insert_in_dupkey_handler():
    """Regression — if we ever add a unique index on
    (company_id, number) for estimates (or one exists in the wild),
    the pull must degrade gracefully: try orphan-adoption first,
    else skip-with-log. It MUST NOT let a DuplicateKeyError bubble
    up and crash the whole batch."""
    from qbo_mirror import pull
    src = inspect.getsource(pull._pull_estimates)
    assert "DuplicateKeyError" in src, (
        "_pull_estimates must import + catch DuplicateKeyError so "
        "duplicate DocNumbers from QBO don't crash the batch")
    assert "except DuplicateKeyError" in src, (
        "insert_one must be wrapped in try/except DuplicateKeyError")
    assert "orphan" in src.lower() and "Duplicate estimate number" in src, (
        "on DuplicateKeyError, try orphan-adoption (qbo_id-less row "
        "sharing the natural key) before logging the warning")
    assert '"skipped_dupkey"' in src, (
        "return value must expose skipped_dupkey so the migration "
        "summary can surface how many rows couldn't be pulled")


def test_pull_purchase_orders_wraps_insert_in_dupkey_handler():
    """Same defensive pattern for POs."""
    from qbo_mirror import pull
    src = inspect.getsource(pull._pull_purchase_orders)
    assert "DuplicateKeyError" in src
    assert "except DuplicateKeyError" in src
    assert "orphan" in src.lower() and "Duplicate PO number" in src
    assert '"skipped_dupkey"' in src


def test_dupkey_orphan_adoption_stamps_qbo_id():
    """When an orphan row exists (same company_id + number, no qbo_id),
    the DuplicateKeyError handler must UPDATE it with the qbo_id
    instead of skipping — so the next dry-run reads `In sync` for
    that pair."""
    from qbo_mirror import pull
    for fn in (pull._pull_estimates, pull._pull_purchase_orders):
        src = inspect.getsource(fn)
        # The update statement must set qbo_id + source=qbo + realm_id
        # + _sync_origin so the orphan is fully adopted, not just
        # tagged.
        assert '"qbo_id": qid' in src
        assert '"source": "qbo"' in src
        assert '"_sync_origin": "mirror_pull"' in src


class _FakeColl:
    def __init__(self, orphan_by_key=None):
        self._orphans = orphan_by_key or {}
        self.inserted = []
        self.updated = []

    async def insert_one(self, doc):
        from pymongo.errors import DuplicateKeyError
        # Simulate a duplicate on the (company_id, number) key.
        raise DuplicateKeyError("simulated")

    async def find_one(self, q, proj=None):
        # Look up orphan by number.
        return self._orphans.get(q.get("number"))

    async def update_one(self, q, upd):
        self.updated.append((q, upd))


def test_orphan_adoption_reclaims_qbo_id_end_to_end(monkeypatch):
    """Full-flow: a local estimate exists with number='1001' + no
    qbo_id. QBO returns an Estimate with DocNumber='1001' and Id=42.
    After pull, the orphan should be stamped with qbo_id=42."""
    from qbo_mirror import pull as pull_mod
    from pymongo.errors import DuplicateKeyError

    # Stub the estimates collection to (a) refuse inserts (DuplicateKeyError)
    # and (b) return an orphan for number='1001'.
    orphan = {"id": "local-est-orphan"}
    fake_est = _FakeColl(orphan_by_key={"1001": orphan})

    class _Contacts:
        async def find_one(self, q, proj=None): return None
    class _Accounts:
        async def find_one(self, q, proj=None): return None
    class _Items:
        async def find_one(self, q, proj=None): return None

    class _FakeDB:
        estimates = fake_est
        contacts = _Contacts()
        accounts = _Accounts()
        items = _Items()
        async def qbo_connections_find_one(self, *a, **kw): return None
        def __getitem__(self, k):
            return getattr(self, k)

    monkeypatch.setattr(pull_mod, "db", _FakeDB())

    # Stub the existing-qbo_ids lookup so the QBO row is treated as new.
    async def _fake_existing(cid, coll, extra_q=None, any_source=False):
        return set()
    monkeypatch.setattr(pull_mod, "_existing_qbo_ids", _fake_existing)

    # Stub the QBO query iterator to return one Estimate.
    class _FakeQ:
        @staticmethod
        async def query_all(cid, realm, entity):
            yield {"Id": "42", "DocNumber": "1001", "TxnDate": "2026-08-10",
                    "TotalAmt": 500, "TxnStatus": "Pending",
                    "CustomerRef": {"value": "77", "name": "AutoPush"},
                    "Line": []}
    monkeypatch.setattr(pull_mod, "Q", _FakeQ())

    # Stub append_log so it's a no-op.
    async def _noop_append_log(*a, **kw): pass
    from qbo_mirror import settings as _settings
    monkeypatch.setattr(_settings, "append_log", _noop_append_log)

    r = asyncio.new_event_loop().run_until_complete(
        pull_mod._pull_estimates("cid", "realm"))
    # Orphan was adopted → skipped_dupkey should count it, and the
    # update should have set qbo_id=42.
    assert r["skipped_dupkey"] == 1
    assert len(fake_est.updated) == 1
    q, upd = fake_est.updated[0]
    assert q == {"id": "local-est-orphan"}
    assert upd["$set"]["qbo_id"] == "42"
    assert upd["$set"]["source"] == "qbo"
