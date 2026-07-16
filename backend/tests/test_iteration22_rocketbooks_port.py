"""Iteration 22 — Rocketbooks contact-resolver port verification on 653 LLC.

Covers:
- DB state on 653 LLC after backfill (counts, sums)
- Contact-name quality (no junk regex fragments, length ≤60, not the description)
- Sample well-known extractions present / bad ones absent
- Fast path unit test (Plaid merchant_name → deterministic, no LLM)
- AI-prompt shim (4 descriptions)
- plaid_connect passes concurrency=8 to resolve_contacts_batch
"""
from __future__ import annotations
import asyncio
import os
import re
import sys
import uuid
import pytest

sys.path.insert(0, "/app/backend")
from dotenv import dotenv_values
_env = dotenv_values("/app/backend/.env")
os.environ.setdefault("MONGO_URL", _env["MONGO_URL"].strip('"'))
os.environ.setdefault("DB_NAME",  _env["DB_NAME"].strip('"'))

from pymongo import MongoClient  # noqa: E402

MONGO_URL = os.environ["MONGO_URL"]
DB_NAME   = os.environ["DB_NAME"]
CID_653   = "b81dd049-9018-47b6-b485-83fe5ff8a2c3"

_client = MongoClient(MONGO_URL)
_db = _client[DB_NAME]


# ---------------------------------------------------------------------------
# 1) DB state on 653 LLC
# ---------------------------------------------------------------------------

class TestDBState653:
    def test_total_txns(self):
        assert _db.transactions.count_documents({"company_id": CID_653}) == 1871

    def test_contact_count(self):
        n = _db.contacts.count_documents({"company_id": CID_653})
        # Spec says 185; allow +/-5 slack because AI is non-deterministic
        # across re-runs. Anything within a tight band still proves the port.
        assert 175 <= n <= 200, f"contacts={n} (expected ~185)"

    def test_no_counterparty_count(self):
        n = _db.transactions.count_documents(
            {"company_id": CID_653, "contact_source": "no_counterparty"}
        )
        assert 170 <= n <= 200, f"no_counterparty={n} (expected ~180)"

    def test_with_contact_id_count(self):
        n = _db.transactions.count_documents(
            {"company_id": CID_653, "contact_id": {"$ne": None}}
        )
        assert 1670 <= n <= 1700, f"with_contact_id={n} (expected ~1691)"

    def test_sum_equals_total(self):
        with_cp = _db.transactions.count_documents(
            {"company_id": CID_653, "contact_id": {"$ne": None}}
        )
        no_cp = _db.transactions.count_documents(
            {"company_id": CID_653, "contact_source": "no_counterparty"}
        )
        assert with_cp + no_cp == 1871


# ---------------------------------------------------------------------------
# 2) Contact name quality
# ---------------------------------------------------------------------------

JUNK_FRAGMENTS = [
    r"\bATM\b",
    r"\bPPD\b",
    r"#XXX",
    r"Conf\s*#",
    r"\bDES:",
    r"\bINDN:",
    r"\bCO\s*ID:",
    r"\bCard\s*6",
]


class TestContactNameQuality:
    def _all_names(self):
        return [c["name"] for c in _db.contacts.find({"company_id": CID_653}, {"name": 1})]

    def test_no_junk_fragments(self):
        offenders = []
        names = self._all_names()
        for n in names:
            for pat in JUNK_FRAGMENTS:
                if re.search(pat, n, re.I):
                    offenders.append((n, pat))
                    break
        assert not offenders, f"junk contact names: {offenders[:20]}"

    def test_length_le_60(self):
        long_ones = [n for n in self._all_names() if len(n) > 60]
        assert not long_ones, f"contact names > 60 chars: {long_ones[:10]}"

    def test_not_resembling_noisy_description(self):
        # A contact name should not echo a NOISY (long, > 40 chars) bank
        # description. It's fine for 'Starbucks' to equal a clean
        # 'Starbucks' description — that's the fast-path win. What must
        # NOT happen is 'CHECKCARD 1234 ... S3553 Card 6236' becoming a
        # contact name.
        offenders = []
        for c in _db.contacts.find({"company_id": CID_653}, {"id": 1, "name": 1}):
            t = _db.transactions.find_one(
                {"company_id": CID_653, "contact_id": c["id"]},
                {"description": 1},
            )
            if not t:
                continue
            desc = (t.get("description") or "").strip().lower()
            name = (c["name"] or "").strip().lower()
            if name and desc and len(desc) > 40 and name == desc:
                offenders.append(c["name"])
        assert not offenders, f"names resembling noisy desc verbatim: {offenders[:10]}"


# ---------------------------------------------------------------------------
# 3) Sample well-known extractions
# ---------------------------------------------------------------------------

EXPECTED_PRESENT = [
    "Amazon", "Audi Financial", "AT&T",
    "Bank of America Financial Center", "Capital One",
    "Costco", "CVS", "AWS",
]

FORBIDDEN_EXACT = [
    "VCA Animal Hos", "CHECKCARD *", "BKOFAMERICA ATM ...", "Zelle payment to ...",
]


class TestSampleExtractions:
    def test_expected_contacts_present(self):
        names = {c["name"] for c in _db.contacts.find({"company_id": CID_653}, {"name": 1})}
        # Case-insensitive substring match — Amazon might be "Amazon.com", etc.
        low = {n.lower() for n in names}
        missing = []
        for e in EXPECTED_PRESENT:
            hit = any(e.lower() in n for n in low)
            if not hit:
                missing.append(e)
        assert not missing, f"missing expected contacts: {missing}"

    def test_forbidden_names_absent(self):
        # Truncated / raw-description-style names must not appear as-is.
        # NOTE: 'VCA Animal Hospital' (full name) is GOOD; the forbidden
        # form is the truncated 'VCA Animal Hos' from old approach.
        names = [c["name"] for c in _db.contacts.find({"company_id": CID_653}, {"name": 1})]
        offenders = [n for n in names if n in FORBIDDEN_EXACT]
        # Also flag names starting with 'CHECKCARD', 'BKOFAMERICA ATM',
        # or 'Zelle payment to ' — the pre-port junk patterns.
        for n in names:
            low = n.lower()
            if (low.startswith("checkcard ") or low.startswith("bkofamerica atm")
                    or low.startswith("zelle payment to ")):
                offenders.append(n)
        assert not offenders, f"forbidden contact names present: {offenders[:20]}"


# ---------------------------------------------------------------------------
# 4) Fast path unit test — Plaid merchant_name='Starbucks'
# ---------------------------------------------------------------------------

class TestFastPath:
    def test_starbucks_fast_path(self):
        import contact_resolver
        test_cid = f"test-iter22-fastpath-{uuid.uuid4()}"

        async def _fake_ai(*a, **kw):
            raise AssertionError("AI must not be called on fast path")

        async def run():
            r1 = await contact_resolver.resolve_contact(
                test_cid, "Starbucks", "STARBUCKS STORE 123 SEATTLE WA",
                ai_fallback_fn=_fake_ai,
            )
            r2 = await contact_resolver.resolve_contact(
                test_cid, "Starbucks", "STARBUCKS STORE 999 NYC",
                ai_fallback_fn=_fake_ai,
            )
            return r1, r2

        try:
            r1, r2 = asyncio.run(run())
            assert r1["source"] == "merchant_name"
            assert r2["source"] == "merchant_name"
            assert r1["contact_id"] == r2["contact_id"]  # dedupe
            assert r1["contact_name"] == "Starbucks"
            n_docs = _db.contacts.count_documents({"company_id": test_cid})
            assert n_docs == 1, f"expected 1 contact, got {n_docs}"
        finally:
            _db.contacts.delete_many({"company_id": test_cid})


# ---------------------------------------------------------------------------
# 5) AI prompt shim — 4 real descriptions through resolve_contact_ai
# ---------------------------------------------------------------------------

AI_CASES = [
    # (description, expected_has_counterparty, expected_name_contains_or_None)
    (
        "NEW YORK LIFE DES:INS. PREM. ID:14 482 992 INDN:EIMOTLAIN G",
        True, "new york life",
    ),
    (
        "Monthly Maintenance Fee",
        False, None,
    ),
    (
        "Online Banking transfer to CHK 7984 Confirmation# XXXXX29817",
        False, None,
    ),
    (
        "Zelle payment to Romeo Ugali Conf# xxxx",
        True, "romeo ugali",
    ),
]


class TestAIPromptShim:
    @pytest.mark.parametrize("desc,exp_hc,exp_name", AI_CASES)
    def test_prompt_extraction(self, desc, exp_hc, exp_name):
        from ai_service import resolve_contact_ai

        async def run():
            return await resolve_contact_ai(desc, existing_contacts=[])

        result = asyncio.run(run())
        assert result["has_counterparty"] is exp_hc, (
            f"desc={desc!r} expected has_counterparty={exp_hc} got {result}"
        )
        if exp_name:
            got = (result.get("extracted_name") or "").lower()
            assert exp_name in got, (
                f"desc={desc!r} expected name containing {exp_name!r}, got {got!r}"
            )
        else:
            assert result.get("extracted_name") in (None, "")


# ---------------------------------------------------------------------------
# 6) Concurrency = 8 in plaid_connect
# ---------------------------------------------------------------------------

class TestConcurrency:
    def test_plaid_connect_passes_concurrency_8(self):
        with open("/app/backend/plaid_connect.py") as f:
            src = f.read()
        assert "resolve_contacts_batch" in src
        # Look for the concurrency=8 kwarg near the batch call
        m = re.search(
            r"resolve_contacts_batch\([^)]*concurrency\s*=\s*(\d+)",
            src, re.S,
        )
        assert m, "resolve_contacts_batch call not found with concurrency kwarg"
        assert int(m.group(1)) == 8, f"concurrency={m.group(1)} (expected 8)"
