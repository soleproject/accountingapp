"""Tests for the split-suggestion endpoint (iteration 29)."""
import os
import requests
import pytest

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "https://aifinance-hub-6.preview.emergentagent.com").rstrip("/")
CID = "4a972b56-c1bb-4f77-a20b-0cc3a31b821d"  # 613 LLC
SPLIT_DEMO_CID = "72da725e-970b-463d-b22e-b169ff3352d2"
WALMART_CID = "5ccbd51f-e608-43d7-958a-51e3b19e0bbf"


def _login(email, password):
    r = requests.post(f"{BASE_URL}/api/auth/login", json={"email": email, "password": password}, timeout=30)
    assert r.status_code == 200, r.text
    return r.json()["token"]


@pytest.fixture(scope="module")
def pro_token():
    return _login("pro@axiom.ai", "pro123")


@pytest.fixture(scope="module")
def client2_token():
    # client2 owns Bright Beans only — no access to 613 LLC
    return _login("client2@axiom.ai", "client123")


def test_bimodal_split_demo(pro_token):
    r = requests.get(
        f"{BASE_URL}/api/companies/{CID}/transactions/split-suggestion",
        params={"contact_id": SPLIT_DEMO_CID},
        headers={"Authorization": f"Bearer {pro_token}"},
        timeout=30,
    )
    assert r.status_code == 200, r.text
    data = r.json()
    assert data.get("suggestion") is not None, data
    s = data["suggestion"]
    assert s["threshold"] == 100.0, s
    assert s["below"]["count"] == 6
    assert s["above"]["count"] == 6
    assert s["gap"] >= 112, s
    assert 5 <= s["below"]["min"] <= 40
    assert 150 <= s["above"]["min"] <= 220


def test_unimodal_walmart(pro_token):
    r = requests.get(
        f"{BASE_URL}/api/companies/{CID}/transactions/split-suggestion",
        params={"contact_id": WALMART_CID},
        headers={"Authorization": f"Bearer {pro_token}"},
        timeout=30,
    )
    assert r.status_code == 200, r.text
    data = r.json()
    assert data.get("suggestion") is None, data
    assert "reason" in data


def test_multi_tenant_forbidden(client2_token):
    r = requests.get(
        f"{BASE_URL}/api/companies/{CID}/transactions/split-suggestion",
        params={"contact_id": SPLIT_DEMO_CID},
        headers={"Authorization": f"Bearer {client2_token}"},
        timeout=30,
    )
    assert r.status_code in (403, 404), r.text
