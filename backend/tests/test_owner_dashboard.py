"""Owner Dashboard aggregator + regression tests."""
import os
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "https://aifinance-hub-6.preview.emergentagent.com").rstrip("/")
CID = "63f872ac-33be-4f5d-bc78-8b3be5130cbd"  # Michael Co LLC
EMPTY_CID = "9a955c33-aeb7-48af-8393-88fb524846db"  # Michael Co 3


@pytest.fixture(scope="module")
def pro_token():
    r = requests.post(f"{BASE_URL}/api/auth/login", json={"email": "pro@axiom.ai", "password": "pro123"})
    assert r.status_code == 200, r.text
    return r.json()["token"]


@pytest.fixture(scope="module")
def client_token():
    r = requests.post(f"{BASE_URL}/api/auth/login", json={"email": "client@axiom.ai", "password": "client123"})
    assert r.status_code == 200, r.text
    return r.json()["token"]


@pytest.fixture
def pro_headers(pro_token):
    return {"Authorization": f"Bearer {pro_token}"}


def test_owner_dashboard_default_period(pro_headers):
    r = requests.get(f"{BASE_URL}/api/companies/{CID}/owner-dashboard", headers=pro_headers, timeout=15)
    assert r.status_code == 200, r.text
    d = r.json()
    # Top-level keys
    for k in ["as_of", "company", "user", "period", "banner", "books", "profit", "cash",
              "attention", "team", "money", "documents"]:
        assert k in d, f"missing {k}"

    # period defaults to 2026-09 (last complete month)
    assert d["period"]["ym"] == "2026-09", d["period"]
    # profit sanity
    p = d["profit"]
    assert abs(p["revenue"] - 28184.34) < 50, p["revenue"]
    assert abs(p["net"] - 24149.03) < 50, p["net"]
    assert len(p.get("months", [])) == 6
    # cash
    c = d["cash"]
    assert "cash_today" in c
    assert isinstance(c.get("timeline", []), list) and len(c["timeline"]) == 31
    for pt in c["timeline"][:3]:
        assert "date" in pt and "cash" in pt and "conservative" in pt
    # money.ar
    ar = d["money"]["ar"]
    assert abs(ar["total"] - 42637.43) < 100, ar
    assert ar["overdue_count"] == 4, ar
    # team
    tm = d["team"]
    assert tm["booking_url"] == "/book/priya-patel-cpa"
    names = [m.get("name", "") for m in tm["members"]]
    assert any("Priya" in n for n in names), names
    assert any(m.get("is_ai") for m in tm["members"]), tm["members"]
    # attention includes a checkin with /q/
    checkin = next((a for a in d["attention"] if a.get("id") == "checkin"), None)
    assert checkin is not None, d["attention"]
    assert checkin.get("href", "").startswith("/q/"), checkin


def test_owner_dashboard_period_august(pro_headers):
    r = requests.get(f"{BASE_URL}/api/companies/{CID}/owner-dashboard?period=2026-08", headers=pro_headers, timeout=15)
    assert r.status_code == 200
    d = r.json()
    assert d["period"]["ym"] == "2026-08"
    assert abs(d["profit"]["revenue"] - 30428) < 200, d["profit"]["revenue"]


def test_owner_dashboard_invalid_period_fallback(pro_headers):
    r = requests.get(f"{BASE_URL}/api/companies/{CID}/owner-dashboard?period=abc", headers=pro_headers, timeout=15)
    assert r.status_code == 200
    assert r.json()["period"]["ym"] == "2026-09"


def test_owner_dashboard_unauth():
    r = requests.get(f"{BASE_URL}/api/companies/{CID}/owner-dashboard", timeout=10)
    assert r.status_code in (401, 403)


def test_owner_dashboard_forbidden_company(client_token):
    # client user doesn't own Michael Co LLC
    r = requests.get(f"{BASE_URL}/api/companies/{CID}/owner-dashboard",
                     headers={"Authorization": f"Bearer {client_token}"}, timeout=10)
    assert r.status_code in (403, 404), r.status_code


def test_owner_dashboard_empty_company(pro_headers):
    r = requests.get(f"{BASE_URL}/api/companies/{EMPTY_CID}/owner-dashboard", headers=pro_headers, timeout=15)
    assert r.status_code == 200, r.text
    d = r.json()
    # should not 500 and have core keys
    assert "profit" in d and "cash" in d
    assert d["profit"]["revenue"] in (0, 0.0)


def test_projections_cashflow_regression(pro_headers):
    r = requests.get(f"{BASE_URL}/api/companies/{CID}/projections/cashflow?days=30", headers=pro_headers, timeout=15)
    assert r.status_code == 200
    data = r.json()
    events = data.get("events") or data.get("timeline") or []
    # look for bill labels
    labels = []
    def _collect(obj):
        if isinstance(obj, dict):
            lbl = obj.get("label") or obj.get("name")
            if lbl and isinstance(lbl, str) and lbl.startswith("Bill"):
                labels.append(lbl)
            for v in obj.values():
                _collect(v)
        elif isinstance(obj, list):
            for v in obj:
                _collect(v)
    _collect(data)
    # If any Bill labels found, they must not be blank 'Bill ' or 'Bill  ·'
    for lbl in labels:
        assert lbl.strip() != "Bill", lbl
        assert "Bill  ·" not in lbl, f"Blank bill number: {lbl}"
    print(f"Found {len(labels)} bill labels, samples: {labels[:3]}")
