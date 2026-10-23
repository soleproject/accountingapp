# Affiliate custom pricing (SmartTally) — eligibility, CRUD, public invite, signup E2E, checkout
import os
import time
import uuid
import subprocess
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL").rstrip("/")
MONGO = "mongodb://localhost:27017/test_database"
STATE = {}


def _login(email, pw):
    r = requests.post(f"{BASE_URL}/api/auth/login", json={"email": email, "password": pw})
    assert r.status_code == 200, r.text[:200]
    return r.json()["token"]


def _h(t):
    return {"Authorization": f"Bearer {t}"}


def _mongo(js):
    return subprocess.run(["mongosh", MONGO, "--quiet", "--eval", js], capture_output=True, text=True).stdout.strip()


@pytest.fixture(scope="module")
def aff():
    return _login("affiliate.smarttally@axiom.ai", "affiliate123")


@pytest.fixture(scope="module")
def pro():
    return _login("pro@axiom.ai", "pro123")


# --- eligibility
def test_eligibility_affiliate(aff):
    r = requests.get(f"{BASE_URL}/api/affiliate/custom-pricing/eligibility", headers=_h(aff))
    assert r.status_code == 200 and r.json()["enabled"] is True
    assert r.json()["floor_cents"] == 13000


def test_eligibility_pro_partner(pro):
    r = requests.get(f"{BASE_URL}/api/affiliate/custom-pricing/eligibility", headers=_h(pro))
    assert r.status_code == 200 and r.json()["enabled"] is False
    p = _login("partner@axiom.ai", "partner123")
    r = requests.get(f"{BASE_URL}/api/affiliate/custom-pricing/eligibility", headers=_h(p))
    assert r.status_code == 200 and r.json()["enabled"] is False


# --- create validations
def test_create_below_floor(aff):
    r = requests.post(f"{BASE_URL}/api/affiliate/custom-pricing/clients", headers=_h(aff),
                      json={"name": "QA Low", "email": f"qa.custom.{uuid.uuid4().hex[:8]}@example.com", "monthly_cents": 12999})
    assert r.status_code == 400


def test_create_valid(aff):
    email = f"qa.custom.{uuid.uuid4().hex[:8]}@example.com"
    r = requests.post(f"{BASE_URL}/api/affiliate/custom-pricing/clients", headers=_h(aff),
                      json={"name": "QA Custom", "email": email, "monthly_cents": 18000, "cadence": "monthly", "trial": True})
    assert r.status_code == 200, r.text
    c = r.json()["client"]
    assert c["margin_cents"] == 5000 and c["annual_cents"] == 180000 and c["status"] == "invited"
    assert "invite_token" not in c
    STATE["pid"], STATE["email"] = c["id"], email


def test_create_duplicate(aff):
    r = requests.post(f"{BASE_URL}/api/affiliate/custom-pricing/clients", headers=_h(aff),
                      json={"name": "QA Custom", "email": STATE["email"], "monthly_cents": 18000})
    assert r.status_code == 409


def test_create_existing_user(aff):
    r = requests.post(f"{BASE_URL}/api/affiliate/custom-pricing/clients", headers=_h(aff),
                      json={"name": "Client", "email": "client@axiom.ai", "monthly_cents": 18000})
    assert r.status_code == 409


# --- list
def test_list(aff, pro):
    r = requests.get(f"{BASE_URL}/api/affiliate/custom-pricing/clients", headers=_h(aff))
    assert r.status_code == 200
    d = r.json()
    row = next(x for x in d["clients"] if x["id"] == STATE["pid"])
    assert row["status"] == "invited"
    assert d["summary"]["count"] == len(d["clients"])
    r = requests.get(f"{BASE_URL}/api/affiliate/custom-pricing/clients", headers=_h(pro))
    assert r.status_code == 403


# --- resend / patch
def test_resend_and_patch(aff):
    pid = STATE["pid"]
    r = requests.post(f"{BASE_URL}/api/affiliate/custom-pricing/clients/{pid}/resend", headers=_h(aff))
    assert r.status_code == 200
    r = requests.patch(f"{BASE_URL}/api/affiliate/custom-pricing/clients/{pid}", headers=_h(aff), json={"monthly_cents": 17000})
    assert r.status_code == 200 and r.json()["client"]["monthly_cents"] == 17000
    assert r.json()["client"]["margin_cents"] == 4000
    r = requests.patch(f"{BASE_URL}/api/affiliate/custom-pricing/clients/{pid}", headers=_h(aff), json={"monthly_cents": 12000})
    assert r.status_code == 400
    r = requests.patch(f"{BASE_URL}/api/affiliate/custom-pricing/clients/nonexistent", headers=_h(aff), json={"monthly_cents": 15000})
    assert r.status_code == 404


# --- public invite
def test_public_invite():
    tok = _mongo(f'print(db.affiliate_priced_clients.findOne({{id:"{STATE["pid"]}"}}).invite_token)')
    assert len(tok) == 32, tok
    STATE["token"] = tok
    r = requests.get(f"{BASE_URL}/api/public/custom-pricing/invite/{tok}")
    assert r.status_code == 200
    d = r.json()
    assert d["email"] == STATE["email"] and d["monthly_cents"] == 17000
    assert d["affiliate_name"] == "Sam Seller" and d["ref"] == "samseller" and d["already_used"] is False
    assert requests.get(f"{BASE_URL}/api/public/custom-pricing/invite/badtoken123").status_code == 404


# --- signup E2E + billing state + checkout
def test_signup_e2e(aff):
    r = requests.post(f"{BASE_URL}/api/auth/signup", json={"name": "QA Custom", "email": STATE["email"],
                                                          "password": "Test1234!", "role": "client", "invite": STATE["token"]})
    assert r.status_code in (200, 201), r.text[:300]
    tok = r.json()["token"]
    STATE["ctok"] = tok
    aff_id = _mongo('print(db.users.findOne({email:"affiliate.smarttally@axiom.ai"}).id)')
    u = _mongo(f'const u=db.users.findOne({{email:"{STATE["email"]}"}}); print(u.referred_by_user_id+"|"+u.signup_firm_slug+"|"+u.id)')
    ref, slug, uid = u.split("|")
    assert ref == aff_id and slug == "smarttally"
    p = _mongo(f'const p=db.affiliate_priced_clients.findOne({{id:"{STATE["pid"]}"}}); print(p.status+"|"+p.user_id)')
    assert p == f"signed_up|{uid}"
    r = requests.get(f"{BASE_URL}/api/public/custom-pricing/invite/{STATE['token']}")
    assert r.json()["already_used"] is True
    # resend after signup -> 400
    r = requests.post(f"{BASE_URL}/api/affiliate/custom-pricing/clients/{STATE['pid']}/resend", headers=_h(aff))
    assert r.status_code == 400


def test_company_billing_state_and_checkout():
    tok = STATE["ctok"]
    r = requests.post(f"{BASE_URL}/api/companies", headers=_h(tok), json={"name": "TEST_QA Custom Co"})
    assert r.status_code in (200, 201), r.text[:300]
    d = r.json()
    cid = d.get("company_id") or d.get("id") or (d.get("company") or {}).get("id")
    assert cid
    STATE["cid"] = cid
    r = requests.get(f"{BASE_URL}/api/companies/{cid}/billing/state", headers=_h(tok))
    assert r.status_code == 200
    cp = r.json().get("custom_pricing")
    assert cp and cp["monthly_cents"] == 17000 and cp["annual_cents"] == 170000
    assert cp["tier_label"] == "Advanced" and cp["affiliate_name"] == "Sam Seller" and cp["trial"] is True
    for cad in ("monthly", "annual"):
        r = requests.post(f"{BASE_URL}/api/companies/{cid}/billing/checkout-session", headers=_h(tok),
                          json={"product": "advanced", "cadence": cad, "custom_pricing": True,
                                "trial_period_days": 7, "origin_url": "https://example.com"})
        assert r.status_code == 200, r.text[:300]
        assert r.json()["checkout_url"].startswith("https://checkout.stripe.com")


def test_checkout_custom_without_priced_doc():
    # A non-invited client asking for custom_pricing -> 400
    tok = _login("client@axiom.ai", "client123")
    cos = requests.get(f"{BASE_URL}/api/companies", headers=_h(tok)).json()
    lst = cos if isinstance(cos, list) else cos.get("companies", [])
    if not lst:
        pytest.skip("no companies")
    cid = lst[0]["id"]
    r = requests.post(f"{BASE_URL}/api/companies/{cid}/billing/checkout-session", headers=_h(tok),
                      json={"product": "advanced", "cadence": "monthly", "custom_pricing": True, "origin_url": "https://example.com"})
    assert r.status_code in (400, 403), r.text[:200]
