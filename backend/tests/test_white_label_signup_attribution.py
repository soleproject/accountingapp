"""Tests for white-label signup -> enterprise attribution on companies & /pro/clients."""
import os
import time
import pytest
import requests

def _load_frontend_env():
    try:
        with open("/app/frontend/.env") as f:
            for line in f:
                if "=" in line and not line.strip().startswith("#"):
                    k, v = line.strip().split("=", 1)
                    os.environ.setdefault(k, v)
    except Exception:
        pass

_load_frontend_env()
BASE_URL = (os.environ.get("REACT_APP_BACKEND_URL") or "").rstrip("/")
assert BASE_URL, "REACT_APP_BACKEND_URL missing"

SUPERADMIN = {"email": "admin@axiom.ai", "password": "admin123"}
PRO = {"email": "pro@axiom.ai", "password": "pro123"}
BRAND_SLUG = "cypherpro"
EXPECTED_ENTERPRISE = "Northgate Advisory"


def _login(email, password):
    r = requests.post(f"{BASE_URL}/api/auth/login", json={"email": email, "password": password})
    assert r.status_code == 200, f"login failed: {r.status_code} {r.text}"
    return r.json()["token"]


def _signup_client(email, password="test1234", name="QA Tester"):
    r = requests.post(
        f"{BASE_URL}/api/auth/signup",
        json={"name": name, "email": email, "password": password, "role": "client"},
    )
    assert r.status_code == 200, f"signup failed: {r.status_code} {r.text}"
    return r.json()["token"]


def _create_company(token, name, firm_slug=None):
    body = {"name": name}
    if firm_slug is not None:
        body["firm_slug"] = firm_slug
    r = requests.post(
        f"{BASE_URL}/api/companies",
        json=body,
        headers={"Authorization": f"Bearer {token}"},
    )
    return r


def _get_pro_clients(token):
    r = requests.get(
        f"{BASE_URL}/api/pro/clients",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 200, f"pro/clients failed: {r.status_code} {r.text}"
    data = r.json()
    return data.get("clients") or data.get("companies") or data


# ---------- Test 1: signup WITH firm_slug=cypherpro -> enterprise attributed ----------
def test_signup_with_firm_slug_attributes_enterprise():
    ts = int(time.time() * 1000)
    email = f"qa+wlyes{ts}@example.com"
    name = f"QA Firm Signup {ts}"
    token = _signup_client(email)
    r = _create_company(token, name, firm_slug=BRAND_SLUG)
    assert r.status_code in (200, 201), f"create company failed: {r.status_code} {r.text}"
    company = r.json()
    cid = company.get("id") or company.get("company_id") or company.get("company", {}).get("id")
    assert cid, f"no company id in response: {company}"

    admin_tok = _login(**SUPERADMIN)
    clients = _get_pro_clients(admin_tok)
    assert isinstance(clients, list), f"unexpected pro/clients shape: {type(clients)}"
    row = next((c for c in clients if c.get("id") == cid or c.get("company_id") == cid), None)
    assert row, f"new company {cid} not in /pro/clients list"
    assert row.get("enterprise_name") == EXPECTED_ENTERPRISE, (
        f"enterprise_name={row.get('enterprise_name')!r} expected {EXPECTED_ENTERPRISE!r}; row={row}"
    )
    assert row.get("enterprise_id"), f"enterprise_id missing on row: {row}"

    # Also verify this pro now sees the company in their own /pro/clients
    pro_tok = _login(**PRO)
    pro_clients = _get_pro_clients(pro_tok)
    assert any((c.get("id") or c.get("company_id")) == cid for c in pro_clients), (
        f"company {cid} not visible to pro@axiom.ai after white-label signup"
    )
    print(f"[WL+] created company {cid} ({name}) email={email}")


# ---------- Test 2: signup WITHOUT firm_slug -> no attribution ----------
def test_signup_without_firm_slug_direct():
    ts = int(time.time() * 1000)
    email = f"qa+wlno{ts}@example.com"
    name = f"QA Direct Signup {ts}"
    token = _signup_client(email)
    r = _create_company(token, name)
    assert r.status_code in (200, 201), f"create company failed: {r.status_code} {r.text}"
    cid = r.json().get("id") or r.json().get("company_id")

    admin_tok = _login(**SUPERADMIN)
    clients = _get_pro_clients(admin_tok)
    row = next((c for c in clients if c.get("id") == cid or c.get("company_id") == cid), None)
    assert row, f"company {cid} not found in /pro/clients"
    ent_name = row.get("enterprise_name")
    assert ent_name in (None, "", "SmartBooks direct"), (
        f"expected no enterprise_name for direct signup, got {ent_name!r}"
    )
    print(f"[WL-] created direct company {cid} ({name}) email={email}")


# ---------- Test 3: unknown firm_slug -> no error, no attribution ----------
def test_signup_unknown_firm_slug_no_error():
    ts = int(time.time() * 1000)
    email = f"qa+wlbad{ts}@example.com"
    name = f"QA Unknown Slug {ts}"
    token = _signup_client(email)
    r = _create_company(token, name, firm_slug="nosuchfirm")
    assert r.status_code in (200, 201), (
        f"unknown firm_slug should not error, got {r.status_code}: {r.text}"
    )
    cid = r.json().get("id") or r.json().get("company_id")

    admin_tok = _login(**SUPERADMIN)
    clients = _get_pro_clients(admin_tok)
    row = next((c for c in clients if c.get("id") == cid or c.get("company_id") == cid), None)
    assert row, f"company {cid} missing from /pro/clients"
    assert row.get("enterprise_name") in (None, "", "SmartBooks direct"), (
        f"unknown slug produced attribution: {row.get('enterprise_name')!r}"
    )
    print(f"[WL?] created unknown-slug company {cid} ({name}) email={email}")


# ---------- Test 5 (regression): existing seeded companies kept correct ----------
def test_existing_seed_rows_attribution():
    admin_tok = _login(**SUPERADMIN)
    clients = _get_pro_clients(admin_tok)
    by_name = {c.get("name"): c for c in clients}
    mc2 = by_name.get("Michael Co 2, LLC")
    nal = by_name.get("Northgate Advisory Ltd")
    if mc2:
        assert mc2.get("enterprise_name") == "Northgate Advisory", (
            f"Michael Co 2 enterprise={mc2.get('enterprise_name')!r}"
        )
    if nal:
        assert nal.get("enterprise_name") in (None, "", "SmartBooks direct"), (
            f"Northgate Advisory Ltd enterprise={nal.get('enterprise_name')!r}"
        )
    print(f"[REG] mc2={mc2 and mc2.get('enterprise_name')} nal={nal and nal.get('enterprise_name')}")


if __name__ == "__main__":
    pytest.main([__file__, "-v", "-s"])
