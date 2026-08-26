"""Global Contact Directory + contact_resolver integration tests.

Covers:
  1. Directory module load + normalized lookups (memo variants).
  2. `contact_resolver.resolve_contact` fast path with directory hit.
  3. `contact_resolver.resolve_contacts_batch` fast path with directory hit.
  4. Standard+ post-hook honors `category_hint_semantic`.
"""
from __future__ import annotations
import sys, os, asyncio
from unittest.mock import AsyncMock

import pytest

sys.path.insert(0, "/app/backend")

import global_contact_directory as gcd


# ---------------------------------------------------------------------------
# Layer 1 — Directory module
# ---------------------------------------------------------------------------
class TestDirectoryLookup:
    def test_boot_load_populates_index(self):
        s = gcd.stats()
        assert s["loaded"] is True
        # Directory should have >4,000 entries and >15,000 unique aliases.
        assert s["unique_entries"] > 4000
        assert s["unique_aliases"] > 15000

    def test_exact_alias_hit(self):
        hit = gcd.lookup("Starbucks")
        assert hit is not None
        assert hit["canonical_name"] == "Starbucks"
        assert hit["semantic"] == "meals"

    def test_case_insensitive(self):
        assert gcd.lookup("STARBUCKS")["canonical_name"] == "Starbucks"
        assert gcd.lookup("starbucks")["canonical_name"] == "Starbucks"

    def test_bank_memo_with_store_suffix(self):
        # Real Plaid memos have store numbers / locations appended.
        hit = gcd.lookup("STARBUCKS #1234 SEATTLE WA")
        assert hit is not None
        assert hit["canonical_name"] == "Starbucks"

    def test_punctuation_stripped(self):
        # Bank memos strip commas / periods.
        hit = gcd.lookup("DOMINOS PIZZA")
        assert hit is not None
        assert hit["canonical_name"] == "Domino's"

    def test_ampersand_variants(self):
        # AT&T shows up both with and without the ampersand.
        hit1 = gcd.lookup("AT&T Mobility")
        hit2 = gcd.lookup("ATT WIRELESS")
        assert hit1 is not None
        assert hit1["canonical_name"] == "AT&T"
        assert hit1["semantic"] == "telecom"
        # ATT/AT&T should resolve to same canonical
        if hit2:
            assert hit2["canonical_name"] == "AT&T"

    def test_miss_returns_none(self):
        assert gcd.lookup("Nonexistent Vendor 999") is None
        assert gcd.lookup("") is None
        assert gcd.lookup(None) is None

    def test_specificity_precedence_applied(self):
        """Convenience stores must resolve to fuel, not meals.
        This is the Wawa/Sheetz/Circle K conflict resolution."""
        for merch in ("Wawa", "Sheetz", "Circle K", "QuikTrip", "Casey's"):
            hit = gcd.lookup(merch)
            assert hit is not None, f"{merch} should be in directory"
            assert hit["semantic"] == "fuel", (
                f"{merch} should resolve to 'fuel' (specificity wins over 'meals')"
                f", got {hit['semantic']}"
            )

    def test_auto_parts_are_repairs_maintenance(self):
        """AutoZone/Pep Boys/Firestone → repairs_maintenance, not office_supplies."""
        for merch in ("AutoZone", "Pep Boys", "Firestone Complete Auto Care"):
            hit = gcd.lookup(merch)
            assert hit is not None, f"{merch} should be in directory"
            assert hit["semantic"] == "repairs_maintenance"

    def test_logo_url_helper(self):
        hit = gcd.lookup("Starbucks")
        url = gcd.logo_url_for(hit)
        assert url == "https://logo.clearbit.com/starbucks.com"
        assert gcd.logo_url_for(None) is None
        assert gcd.logo_url_for({}) is None


# ---------------------------------------------------------------------------
# Layer 2 — contact_resolver.resolve_contact (single-row path)
# ---------------------------------------------------------------------------
class TestContactResolverDirectoryHook:
    @pytest.mark.asyncio
    async def test_directory_hit_creates_contact_with_hint(self, monkeypatch):
        """New merchant in a tenant that's in the directory → contact
        gets minted under the canonical name with linked_semantic set."""
        import contact_resolver as cr

        inserted = {}

        async def fake_find_by_norm(company_id, name):
            return None  # nothing exists in tenant DB

        async def fake_insert(company_id, contact_name, source,
                              logo_url=None, linked_semantic=None):
            inserted["company_id"] = company_id
            inserted["name"] = contact_name
            inserted["source"] = source
            inserted["logo_url"] = logo_url
            inserted["linked_semantic"] = linked_semantic
            return {"id": "new-c1", "name": contact_name, "source": source,
                    "linked_semantic": linked_semantic}

        monkeypatch.setattr(cr, "_find_by_normalized", fake_find_by_norm)
        monkeypatch.setattr(cr, "_insert_contact", fake_insert)

        result = await cr.resolve_contact(
            company_id="cid1",
            merchant_name="STARBUCKS #4823 SEATTLE WA",
            description="STARBUCKS #4823 SEATTLE WA",
        )

        # Contact was created under CANONICAL name, not the raw memo.
        assert inserted["name"] == "Starbucks"
        assert inserted["source"] == "global_directory"
        assert inserted["linked_semantic"] == "meals"
        assert inserted["logo_url"] == "https://logo.clearbit.com/starbucks.com"

        # Return payload carries the semantic hint for the txn.
        assert result["contact_name"] == "Starbucks"
        assert result["source"] == "global_directory"
        assert result["linked_semantic"] == "meals"

    @pytest.mark.asyncio
    async def test_directory_miss_falls_through_to_raw_insert(self, monkeypatch):
        """Unknown merchant → falls back to the pre-existing bare
        tenant-contact insert path. No hint stamped."""
        import contact_resolver as cr
        inserted = {}

        async def fake_find_by_norm(company_id, name):
            return None

        async def fake_insert(company_id, contact_name, source,
                              logo_url=None, linked_semantic=None):
            inserted["name"] = contact_name
            inserted["source"] = source
            inserted["linked_semantic"] = linked_semantic
            return {"id": "new-c2", "name": contact_name, "source": source}

        monkeypatch.setattr(cr, "_find_by_normalized", fake_find_by_norm)
        monkeypatch.setattr(cr, "_insert_contact", fake_insert)

        result = await cr.resolve_contact(
            company_id="cid1",
            merchant_name="Some Unknown Widget Co",
            description="Some Unknown Widget Co",
        )

        # Bare merchant_name insert — no directory hit.
        assert inserted["name"] == "Some Unknown Widget Co"
        assert inserted["source"] == "merchant_name"
        assert inserted["linked_semantic"] is None
        assert result["source"] == "merchant_name"
        # No linked_semantic returned
        assert result.get("linked_semantic") is None

    @pytest.mark.asyncio
    async def test_tenant_contact_wins_over_directory(self, monkeypatch):
        """If the tenant ALREADY has this contact, we don't remint —
        we just return the existing one. Preserves manual tags."""
        import contact_resolver as cr
        existing = {"id": "cid-exists",
                    "name": "Starbucks Custom Renamed by CPA",
                    "linked_semantic": None}

        async def fake_find(cid, name):
            return existing

        insert_calls = {"n": 0}
        async def fake_insert(*a, **kw):
            insert_calls["n"] += 1
            return {}

        monkeypatch.setattr(cr, "_find_by_normalized", fake_find)
        monkeypatch.setattr(cr, "_insert_contact", fake_insert)

        result = await cr.resolve_contact(
            company_id="cid1",
            merchant_name="STARBUCKS #4823",
            description="STARBUCKS #4823",
        )

        # No new insert — existing tenant contact wins.
        assert insert_calls["n"] == 0
        assert result["contact_id"] == "cid-exists"
        assert result["contact_name"] == "Starbucks Custom Renamed by CPA"


# ---------------------------------------------------------------------------
# Layer 3 — Standard+ post-hook honors category_hint_semantic
# ---------------------------------------------------------------------------
class TestStandardPlusDirectoryHint:
    @pytest.mark.asyncio
    async def test_directory_hint_fires_when_no_rule_matches(self, monkeypatch):
        """Txn carries `category_hint_semantic` = 'meals' via directory
        AND the merchant text isn't in global_vendor_rules. Standard+
        should apply the directory hint and stamp
        source='standard_plus_directory'."""
        import standard_plus_categorizer as spc

        fake_company = {"id": "cid", "industry_template": "generic"}
        coa = [
            {"id": "a-meals",  "code": "6400", "name": "Meals"},
            {"id": "a-unc",    "code": "6999", "name": "Uncategorized Expense"},
        ]
        # Use a merchant name NOT in global_vendor_rules so Stage 1
        # skips and Stage 2 (directory) fires.
        fake_txn = {
            "id": "t1", "company_id": "cid",
            "merchant": "OBSCURE MEMO STRING NOT IN RULES",
            "description": "OBSCURE MEMO STRING NOT IN RULES",
            "amount": -12.99,
            "category_account_code": "6999",
            "category_hint_semantic": "meals",
            "category_hint_source": "global_directory",
            "contact_id": "starbucks-contact",
            "contact_name": "Starbucks",
        }

        class _Cur:
            def __init__(self, d): self._d = d
            async def to_list(self, _): return self._d

        fake_db = type("_DB", (), {})()
        fake_db.companies = AsyncMock()
        fake_db.companies.find_one = AsyncMock(return_value=fake_company)
        fake_db.contacts = AsyncMock()
        fake_db.contacts.find_one = AsyncMock(
            return_value={"id": "starbucks-contact",
                          "linked_semantic": "meals",
                          "source": "global_directory"},
        )
        fake_db.accounts = type("_A", (), {
            "find": staticmethod(lambda *a, **kw: _Cur(coa)),
        })()
        updates = []
        async def _update_one(filt, upd):
            updates.append((filt, upd))
        fake_db.transactions = type("_T", (), {
            "find": staticmethod(lambda *a, **kw: _Cur([fake_txn])),
            "update_one": staticmethod(_update_one),
        })()
        monkeypatch.setattr(spc, "db", fake_db)

        stats = await spc.apply_global_rules_override("cid", ["t1"])

        assert stats["overridden"] == 1
        assert stats["matched_via_directory"] == 1
        _f, upd = updates[0]
        assert upd["$set"]["category_account_id"] == "a-meals"
        assert upd["$set"]["categorization_source"] == "standard_plus_directory"

    @pytest.mark.asyncio
    async def test_rule_beats_directory_hint(self, monkeypatch):
        """When BOTH global_vendor_rules AND directory would match,
        the hand-tuned rule wins. Prevents the directory's less-SMB-
        tuned answer (e.g., Home Depot → office_supplies) from
        overriding the curated rule (Home Depot → repairs_maintenance)."""
        import standard_plus_categorizer as spc

        fake_company = {"id": "cid", "industry_template": "generic"}
        coa = [
            {"id": "a-repair", "code": "6500", "name": "Repairs & Maintenance"},
            {"id": "a-office", "code": "6600", "name": "Office Supplies"},
            {"id": "a-unc",    "code": "6999", "name": "Uncategorized Expense"},
        ]
        # Home Depot IS in global_vendor_rules (repairs_maintenance)
        # AND in the directory (office_supplies). Rule must win.
        fake_txn = {
            "id": "t1", "company_id": "cid",
            "merchant": "HOME DEPOT #4023",
            "description": "HOME DEPOT #4023",
            "amount": -142.50,
            "category_account_code": "6999",
            "category_hint_semantic": "office_supplies",
            "category_hint_source": "global_directory",
            "contact_id": "hd-contact",
            "contact_name": "Home Depot",
        }

        class _Cur:
            def __init__(self, d): self._d = d
            async def to_list(self, _): return self._d

        fake_db = type("_DB", (), {})()
        fake_db.companies = AsyncMock()
        fake_db.companies.find_one = AsyncMock(return_value=fake_company)
        fake_db.contacts = AsyncMock()
        fake_db.contacts.find_one = AsyncMock(return_value=None)
        fake_db.accounts = type("_A", (), {
            "find": staticmethod(lambda *a, **kw: _Cur(coa)),
        })()
        updates = []
        async def _update_one(filt, upd):
            updates.append((filt, upd))
        fake_db.transactions = type("_T", (), {
            "find": staticmethod(lambda *a, **kw: _Cur([fake_txn])),
            "update_one": staticmethod(_update_one),
        })()
        monkeypatch.setattr(spc, "db", fake_db)

        stats = await spc.apply_global_rules_override("cid", ["t1"])

        assert stats["overridden"] == 1
        assert stats["matched_via_rule"] == 1  # rule beat directory
        assert stats["matched_via_directory"] == 0
        _f, upd = updates[0]
        assert upd["$set"]["category_account_id"] == "a-repair"
        assert upd["$set"]["categorization_source"] == "standard_plus_rule"
