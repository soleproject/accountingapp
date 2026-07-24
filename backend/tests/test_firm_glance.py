"""Smoke tests for the /dashboard/firm-glance endpoint (Firm at a Glance view)."""
import os
import requests

BASE = os.environ.get("BASE_URL", "https://aifinance-hub-6.preview.emergentagent.com")
EMAIL = "pro@axiom.ai"
PASSWORD = "pro123"
CID = "1829a9eb-7df2-4a31-afcf-7e50a514da7e"  # Bright Beans Coffee Co.


def _auth():
    r = requests.post(f"{BASE}/api/auth/login",
                      json={"email": EMAIL, "password": PASSWORD}, timeout=15)
    r.raise_for_status()
    return r.json()["token"]


def _headers():
    return {"Authorization": f"Bearer {_auth()}"}


def test_firm_glance_default_month():
    r = requests.get(f"{BASE}/api/companies/{CID}/dashboard/firm-glance",
                     headers=_headers(), timeout=20)
    assert r.status_code == 200, r.text
    body = r.json()
    for k in ("month", "month_label", "sales_funnel", "bank_accounts",
              "profit_loss", "expenses"):
        assert k in body, f"missing key {k} in response"
    # sales funnel shape
    for bucket in ("not_paid", "paid", "deposited"):
        b = body["sales_funnel"][bucket]
        assert "amount" in b and isinstance(b["amount"], (int, float))
        assert "count" in b and isinstance(b["count"], int)
    # bank accounts shape
    assert "total_balance" in body["bank_accounts"]
    assert isinstance(body["bank_accounts"]["accounts"], list)
    # profit_loss shape
    for k in ("net_profit", "income", "expense", "income_to_review", "expense_to_review"):
        assert k in body["profit_loss"], k
    # expenses shape
    assert "total" in body["expenses"]
    assert isinstance(body["expenses"]["categories"], list)


def test_firm_glance_specific_month():
    r = requests.get(f"{BASE}/api/companies/{CID}/dashboard/firm-glance",
                     params={"month": "2026-02"},
                     headers=_headers(), timeout=20)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["month"] == "2026-02"
    assert "February 2026" in body["month_label"]


def test_firm_glance_bank_accounts_have_review_field():
    r = requests.get(f"{BASE}/api/companies/{CID}/dashboard/firm-glance",
                     headers=_headers(), timeout=20)
    r.raise_for_status()
    for a in r.json()["bank_accounts"]["accounts"]:
        assert "to_review" in a and isinstance(a["to_review"], int)
        assert "balance" in a


def test_firm_glance_expense_categories_have_colors():
    r = requests.get(f"{BASE}/api/companies/{CID}/dashboard/firm-glance",
                     headers=_headers(), timeout=20)
    r.raise_for_status()
    cats = r.json()["expenses"]["categories"]
    for c in cats:
        assert "name" in c and "amount" in c and "color" in c
        assert c["color"].startswith("#")
