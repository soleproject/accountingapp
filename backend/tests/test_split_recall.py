"""Tests for split-suggestion endpoint recall (previous_below/previous_above)."""
import os
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "https://aifinance-hub-6.preview.emergentagent.com").rstrip("/")
CID = "4a972b56-c1bb-4f77-a20b-0cc3a31b821d"
CONTACT_ID = "72da725e-970b-463d-b22e-b169ff3352d2"


@pytest.fixture(scope="module")
def token():
    r = requests.post(f"{BASE_URL}/api/auth/login", json={"email": "pro@axiom.ai", "password": "pro123"})
    assert r.status_code == 200, r.text
    return r.json()["token"]


@pytest.fixture(scope="module")
def headers(token):
    return {"Authorization": f"Bearer {token}"}


def test_split_suggestion_with_recall(headers):
    """SplitDemo has 2 seeded rules — response should include previous_below='Meals' & previous_above='Office Supplies'."""
    r = requests.get(
        f"{BASE_URL}/api/companies/{CID}/transactions/split-suggestion",
        params={"contact_id": CONTACT_ID},
        headers=headers,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    print("Response:", body)
    s = body.get("suggestion")
    assert s is not None, f"No suggestion: {body}"
    assert s.get("threshold") == 100.0 or abs(s["threshold"] - 100) < 5
    assert s.get("previous_below") == "Meals", f"Expected previous_below='Meals', got {s.get('previous_below')}"
    assert s.get("previous_above") == "Office Supplies", f"Expected previous_above='Office Supplies', got {s.get('previous_above')}"


def test_split_suggestion_no_rules_other_contact(headers):
    """For a random uncat contact with no rules, previous_below/above must be None if a suggestion is returned."""
    # Fetch cleanup-suggestions to find another uncat contact.
    r = requests.get(f"{BASE_URL}/api/companies/{CID}/transactions/cleanup-suggestions", headers=headers)
    assert r.status_code == 200, r.text
    suggestions = r.json().get("top_actions", [])
    other_cid = None
    for a in suggestions:
        if a.get("contact_id") and a["contact_id"] != CONTACT_ID and a.get("kind") == "contact_in_uncat":
            other_cid = a["contact_id"]
            break
    if not other_cid:
        pytest.skip("No other uncat contact found")
    r2 = requests.get(
        f"{BASE_URL}/api/companies/{CID}/transactions/split-suggestion",
        params={"contact_id": other_cid},
        headers=headers,
    )
    assert r2.status_code == 200, r2.text
    body = r2.json()
    s = body.get("suggestion")
    if s:
        assert s.get("previous_below") in (None, ""), f"Expected null previous_below for contact w/o rules, got {s.get('previous_below')}"
        assert s.get("previous_above") in (None, ""), f"Expected null previous_above, got {s.get('previous_above')}"


def test_split_suggestion_invalid_contact(headers):
    """Non-existent contact should not crash — returns 200 with null suggestion or similar."""
    r = requests.get(
        f"{BASE_URL}/api/companies/{CID}/transactions/split-suggestion",
        params={"contact_id": "00000000-0000-0000-0000-000000000000"},
        headers=headers,
    )
    assert r.status_code in (200, 404), r.text
