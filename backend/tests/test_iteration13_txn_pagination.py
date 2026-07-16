"""Iteration 13: Verify paginated GET /api/companies/{cid}/transactions."""
import os
import requests
import pytest

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "https://aifinance-hub-6.preview.emergentagent.com").rstrip("/")
CID = "dea036e7-1b29-4589-bc7a-482e9771c22d"  # 254, LLC


@pytest.fixture(scope="module")
def token():
    r = requests.post(f"{BASE_URL}/api/auth/login", json={"email": "pro@axiom.ai", "password": "pro123"})
    assert r.status_code == 200, r.text
    return r.json()["token"]


@pytest.fixture(scope="module")
def headers(token):
    return {"Authorization": f"Bearer {token}"}


def test_default_pagination_page1(headers):
    r = requests.get(f"{BASE_URL}/api/companies/{CID}/transactions?page=1&limit=250", headers=headers)
    assert r.status_code == 200
    j = r.json()
    assert "transactions" in j and "pagination" in j
    p = j["pagination"]
    assert p["total"] >= 1800, f"expected ~1871 total, got {p['total']}"
    assert p["limit"] == 250
    assert p["page"] == 1
    assert p["pages"] == (p["total"] + 249) // 250
    assert len(j["transactions"]) == 250


def test_last_page_partial(headers):
    r = requests.get(f"{BASE_URL}/api/companies/{CID}/transactions?page=1&limit=250", headers=headers)
    total = r.json()["pagination"]["total"]
    pages = (total + 249) // 250
    r2 = requests.get(f"{BASE_URL}/api/companies/{CID}/transactions?page={pages}&limit=250", headers=headers)
    j2 = r2.json()
    expected_last = total - (pages - 1) * 250
    assert len(j2["transactions"]) == expected_last
    assert j2["pagination"]["page"] == pages


def test_beyond_last_page_empty(headers):
    r = requests.get(f"{BASE_URL}/api/companies/{CID}/transactions?page=999&limit=250", headers=headers)
    assert r.status_code == 200
    assert r.json()["transactions"] == []


def test_limit_zero_returns_all(headers):
    r = requests.get(f"{BASE_URL}/api/companies/{CID}/transactions?limit=0", headers=headers)
    j = r.json()
    total = j["pagination"]["total"]
    assert len(j["transactions"]) == total
    assert j["pagination"]["pages"] == 1


def test_needs_review_filter_pagination(headers):
    r = requests.get(
        f"{BASE_URL}/api/companies/{CID}/transactions?needs_review=true&page=1&limit=250",
        headers=headers,
    )
    j = r.json()
    p = j["pagination"]
    # 254,LLC has ~198 needs_review per prior iteration
    assert 100 <= p["total"] <= 300, f"unexpected needs_review total {p['total']}"
    assert len(j["transactions"]) == p["total"]
    # Ensure every row is needs_review true
    assert all(t.get("needs_review") for t in j["transactions"])


def test_page_size_50_navigation(headers):
    r = requests.get(f"{BASE_URL}/api/companies/{CID}/transactions?page=1&limit=50", headers=headers)
    j = r.json()
    assert len(j["transactions"]) == 50
    assert j["pagination"]["limit"] == 50
    r2 = requests.get(f"{BASE_URL}/api/companies/{CID}/transactions?page=2&limit=50", headers=headers)
    j2 = r2.json()
    assert len(j2["transactions"]) == 50
    # Different rows on page 2
    ids1 = {t["id"] for t in j["transactions"]}
    ids2 = {t["id"] for t in j2["transactions"]}
    assert ids1.isdisjoint(ids2)
