"""Iter 33 — LLM-backed CPA gate for cleanup-inquiry answers.

Validates POST /api/companies/{cid}/ai/cpa-review against the 15 scenarios
described in the main agent context note. Uses live Claude Sonnet 4.5 via
Emergent Universal Key, so responses vary — assertions are loose on wording
but strict on intent/schema.
"""
import os
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "https://aifinance-hub-6.preview.emergentagent.com").rstrip("/")
CID = "4a972b56-c1bb-4f77-a20b-0cc3a31b821d"

VALID_INTENTS = {"categorize", "approve_existing", "redirect", "skip", "question", "unclear"}


@pytest.fixture(scope="module")
def token():
    r = requests.post(f"{BASE_URL}/api/auth/login",
                      json={"email": "pro@axiom.ai", "password": "pro123"}, timeout=15)
    assert r.status_code == 200, r.text
    return r.json()["token"]


@pytest.fixture(scope="module")
def headers(token):
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


@pytest.fixture(scope="module")
def amazon_contact(headers):
    r = requests.get(f"{BASE_URL}/api/companies/{CID}/contacts?q=Amazon",
                     headers=headers, timeout=15)
    assert r.status_code == 200, r.text
    items = r.json() if isinstance(r.json(), list) else r.json().get("items") or r.json().get("contacts") or []
    assert items, "No Amazon contact found"
    return items[0]


def _cpa(headers, message, contact_name="Amazon", contact_id=None):
    body = {"message": message, "contact_name": contact_name}
    if contact_id:
        body["contact_id"] = contact_id
    r = requests.post(f"{BASE_URL}/api/companies/{CID}/ai/cpa-review",
                      json=body, headers=headers, timeout=45)
    assert r.status_code == 200, f"{r.status_code}: {r.text}"
    j = r.json()
    assert j.get("intent") in VALID_INTENTS, f"Bad intent: {j}"
    assert "resolution" in j
    assert "confidence" in j
    return j


class TestCpaReview:
    def test_1_approve_existing_they_look_good(self, headers, amazon_contact):
        j = _cpa(headers, "they look good the way they are", "Amazon", amazon_contact["id"])
        assert j["intent"] == "approve_existing", j

    def test_2_redirect_healthy_paws(self, headers, amazon_contact):
        j = _cpa(headers, "let's look at Healthy Paws", "Amazon", amazon_contact["id"])
        assert j["intent"] == "redirect", j
        target = (j.get("resolution") or {}).get("target_contact_name", "").lower()
        assert "healthy paws" in target

    def test_3_skip_plain(self, headers):
        j = _cpa(headers, "skip", "Amazon")
        assert j["intent"] == "skip", j

    def test_4_skip_come_back_later(self, headers):
        j = _cpa(headers, "come back later", "Amazon")
        assert j["intent"] == "skip", j

    def test_5_skip_next(self, headers):
        j = _cpa(headers, "next", "Amazon")
        assert j["intent"] == "skip", j

    def test_6_categorize_office_supplies(self, headers, amazon_contact):
        j = _cpa(headers, "these are all office supplies", "Amazon", amazon_contact["id"])
        assert j["intent"] == "categorize", j
        buckets = (j.get("resolution") or {}).get("buckets") or []
        assert buckets
        acct = buckets[0].get("account") or {}
        # Should map to existing account
        assert acct.get("existing_account_id"), f"expected existing account, got {acct}"

    def test_7_categorize_meals(self, headers, amazon_contact):
        j = _cpa(headers, "these are all meals", "Amazon", amazon_contact["id"])
        assert j["intent"] == "categorize", j
        buckets = (j.get("resolution") or {}).get("buckets") or []
        assert buckets and buckets[0].get("account", {}).get("existing_account_id")

    def test_8_categorize_utilities(self, headers, amazon_contact):
        j = _cpa(headers, "utilities", "Amazon", amazon_contact["id"])
        assert j["intent"] == "categorize", j

    def test_9_categorize_range_split(self, headers, amazon_contact):
        j = _cpa(headers, "under $50 is Meals, above is Office Supplies", "Amazon", amazon_contact["id"])
        assert j["intent"] == "categorize", j
        buckets = (j.get("resolution") or {}).get("buckets") or []
        assert len(buckets) >= 2, f"expected 2 buckets, got {len(buckets)}"

    def test_10_categorize_exception(self, headers, amazon_contact):
        j = _cpa(headers, "Meals except for the $127.28 that was actually Travel", "Amazon", amazon_contact["id"])
        assert j["intent"] == "categorize", j
        buckets = (j.get("resolution") or {}).get("buckets") or []
        assert len(buckets) >= 2

    def test_11_categorize_aggressive_marketing_maps_to_existing(self, headers, amazon_contact):
        j = _cpa(headers, "aggressive Q4 marketing spend", "Amazon", amazon_contact["id"])
        assert j["intent"] == "categorize", j
        buckets = (j.get("resolution") or {}).get("buckets") or []
        assert buckets
        acct = buckets[0].get("account") or {}
        # Should prefer existing Advertising & Marketing over creating new
        name = (acct.get("name") or "").lower()
        assert acct.get("existing_account_id") or "market" in name or "advertis" in name, f"{acct}"

    def test_12_question(self, headers, amazon_contact):
        j = _cpa(headers, "what should these usually be?", "Amazon", amazon_contact["id"])
        assert j["intent"] == "question", j

    def test_13_unclear_hmm(self, headers, amazon_contact):
        j = _cpa(headers, "hmm", "Amazon", amazon_contact["id"])
        assert j["intent"] == "unclear", j
        assert (j.get("resolution") or {}).get("clarifying_question")

    def test_14_safeguard_filler_downgrade(self, headers, amazon_contact):
        # 'good' by itself should NOT produce a categorize bucket named 'good'
        j = _cpa(headers, "good", "Amazon", amazon_contact["id"])
        assert j["intent"] != "categorize" or all(
            "good" not in ((b.get("account") or {}).get("name") or "").lower()
            for b in (j.get("resolution") or {}).get("buckets") or []
        ), j

    def test_15_safeguard_no_filler_account_created_they_look(self, headers, amazon_contact):
        j = _cpa(headers, "they look good the way they are", "Amazon", amazon_contact["id"])
        # Verify: no bucket has an account name containing filler phrase
        buckets = (j.get("resolution") or {}).get("buckets") or []
        for b in buckets:
            name = ((b.get("account") or {}).get("name") or "").lower()
            for bad in ("they look", "looks good", "let's", "good the way"):
                assert bad not in name, f"filler-named account leaked: {name}"

    def test_16_no_leaked_account_in_db(self, headers):
        """After all prior calls, verify no garbage account was created."""
        r = requests.get(f"{BASE_URL}/api/companies/{CID}/accounts",
                         headers=headers, timeout=15)
        assert r.status_code == 200
        accts = r.json() if isinstance(r.json(), list) else r.json().get("accounts", [])
        for a in accts:
            n = (a.get("name") or "").lower()
            for bad in ("they look", "let's look", "looks good the way", "the way they are"):
                assert bad not in n, f"Garbage account exists in DB: {a}"
