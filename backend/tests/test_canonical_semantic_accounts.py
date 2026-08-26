"""Canonical semantic accounts — auto-create + idempotence tests."""
from __future__ import annotations
import sys, uuid
sys.path.insert(0, "/app/backend")
import pytest


class TestCanonicalSemanticAccounts:
    """Verify auto-creation of GAAP-clean accounts from the semantic
    library when the tenant's CoA lacks a matching account."""

    def test_library_covers_all_supported_semantics(self):
        """Every semantic in the resolver's allowlist must have a
        canonical entry — otherwise we'd have gaps that fall to
        Uncategorized."""
        import global_vendor_rules as gvr
        import canonical_semantic_accounts as csa
        for semantic in gvr.SEMANTIC_TO_CODE.keys():
            assert semantic in csa.CANONICAL_SEMANTIC_ACCOUNTS, (
                f"Missing canonical entry for semantic '{semantic}'"
            )

    def test_every_entry_has_required_fields(self):
        import canonical_semantic_accounts as csa
        required = {"name", "type", "subtype", "detail_type",
                    "code_by_template"}
        for sem, entry in csa.CANONICAL_SEMANTIC_ACCOUNTS.items():
            missing = required - set(entry.keys())
            assert not missing, f"{sem} missing fields: {missing}"
            assert entry["type"] in ("asset", "liability", "equity",
                                       "income", "expense")
            assert "generic" in entry["code_by_template"], (
                f"{sem}: no generic code"
            )

    @pytest.mark.asyncio
    async def test_ensure_creates_when_missing(self, monkeypatch):
        """CoA has no fuel account → auto-create should insert one."""
        import canonical_semantic_accounts as csa
        # Fake DB with empty accounts list
        accts_state = []
        class _AcctCur:
            async def to_list(self, _): return accts_state
        class _Companies:
            async def find_one(self, *a, **k): return {"id": "cid1"}
        class _Accounts:
            def find(self, *a, **kw): return _AcctCur()
            async def insert_one(self, doc):
                accts_state.append(doc)
        fake_db = type("_DB", (), {})()
        fake_db.companies = _Companies()
        fake_db.accounts = _Accounts()

        acct = await csa.ensure_semantic_account(
            fake_db, "cid1", "fuel", "generic",
        )
        assert acct is not None
        assert acct["name"] == "Fuel & Vehicle Expense"
        assert acct["type"] == "expense"
        assert acct["detail_type"] == "auto_expenses"
        assert acct["code"] == "6350"
        assert acct["created_via"] == "canonical_semantic"
        assert acct["linked_semantic"] == "fuel"

    @pytest.mark.asyncio
    async def test_ensure_is_idempotent(self, monkeypatch):
        """If a name-matching account already exists, return that one —
        never create a duplicate."""
        import canonical_semantic_accounts as csa
        existing = {"id": "a1", "code": "6350", "name": "Fuel & Vehicle Expense",
                    "type": "expense"}
        class _AcctCur:
            async def to_list(self, _): return [existing]
        insert_calls = []
        class _Accounts:
            def find(self, *a, **kw): return _AcctCur()
            async def insert_one(self, doc):
                insert_calls.append(doc)
        class _Companies:
            async def find_one(self, *a, **k): return {"id": "cid1"}
        fake_db = type("_DB", (), {})()
        fake_db.companies = _Companies()
        fake_db.accounts = _Accounts()

        acct = await csa.ensure_semantic_account(
            fake_db, "cid1", "fuel", "generic",
        )
        assert acct == existing
        assert len(insert_calls) == 0, "Must not create duplicate"

    @pytest.mark.asyncio
    async def test_ensure_respects_opt_out_flag(self, monkeypatch):
        """Company doc's `disable_canonical_auto_create` blocks
        creation."""
        import canonical_semantic_accounts as csa
        class _AcctCur:
            async def to_list(self, _): return []
        class _Companies:
            async def find_one(self, *a, **k):
                return {"id": "cid1", "disable_canonical_auto_create": True}
        insert_calls = []
        class _Accounts:
            def find(self, *a, **kw): return _AcctCur()
            async def insert_one(self, doc):
                insert_calls.append(doc)
        fake_db = type("_DB", (), {})()
        fake_db.companies = _Companies()
        fake_db.accounts = _Accounts()

        acct = await csa.ensure_semantic_account(
            fake_db, "cid1", "fuel", "generic",
        )
        assert acct is None
        assert len(insert_calls) == 0

    @pytest.mark.asyncio
    async def test_ensure_bumps_code_on_collision(self):
        """If the canonical code is already taken by another account
        with a different name, bump the code to avoid QBO sync
        collision."""
        import canonical_semantic_accounts as csa
        accts_state = [
            {"id": "existing", "code": "6350", "name": "Some Other Account", "type": "expense"},
        ]
        class _AcctCur:
            async def to_list(self, _): return accts_state
        class _Companies:
            async def find_one(self, *a, **k): return {"id": "cid1"}
        class _Accounts:
            def find(self, *a, **kw): return _AcctCur()
            async def insert_one(self, doc):
                accts_state.append(doc)
        fake_db = type("_DB", (), {})()
        fake_db.companies = _Companies()
        fake_db.accounts = _Accounts()

        acct = await csa.ensure_semantic_account(
            fake_db, "cid1", "fuel", "generic",
        )
        assert acct["code"] != "6350"
        assert acct["code"].isdigit()
        assert int(acct["code"]) > 6350
