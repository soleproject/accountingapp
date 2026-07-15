"""Iteration 7: GL 'source' field enhancement tests."""
import os
import io
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL")
if not BASE_URL:
    with open("/app/frontend/.env") as f:
        for line in f:
            if line.startswith("REACT_APP_BACKEND_URL="):
                BASE_URL = line.split("=", 1)[1].strip(); break
API = f"{BASE_URL.rstrip('/')}/api"


def _hdr(t): return {"Authorization": f"Bearer {t}"}


@pytest.fixture(scope="module")
def auth():
    r = requests.post(f"{API}/auth/login",
                      json={"email": "client@axiom.ai", "password": "client123"}, timeout=30)
    assert r.status_code == 200, r.text
    return r.json()["token"]


@pytest.fixture(scope="module")
def cid(auth):
    r = requests.get(f"{API}/companies", headers=_hdr(auth), timeout=15)
    j = r.json(); comps = j.get("companies", j) if isinstance(j, dict) else j
    sky = next((c for c in comps if "Skyward" in c.get("name", "")), comps[0])
    return sky["id"]


@pytest.fixture(scope="module")
def accts_map(auth, cid):
    r = requests.get(f"{API}/companies/{cid}/accounts", headers=_hdr(auth), timeout=15)
    j = r.json(); accts = j.get("accounts", j.get("items", j))
    return {a["code"]: a for a in accts}


def test_post_je_and_split_then_verify_gl_sources(auth, cid, accts_map):
    # 1. Post a JE dated 2026-06-15 (per hint)
    legal = accts_map.get("6500"); checking = accts_map.get("1010")
    assert legal and checking, "Expected accounts 6500 and 1010 in COA"
    je_payload = {
        "date": "2026-06-15",
        "memo": "TEST_iter7 JE legal fee",
        "lines": [
            {"account_code": "6500", "debit": 150, "credit": 0},
            {"account_code": "1010", "debit": 0, "credit": 150},
        ],
    }
    r = requests.post(f"{API}/companies/{cid}/journal-entries",
                      headers=_hdr(auth), json=je_payload, timeout=15)
    assert r.status_code in (200, 201), r.text

    # 2. Find a transaction in 2026 open period (July) to split
    tr = requests.get(f"{API}/companies/{cid}/transactions", headers=_hdr(auth), timeout=30)
    txns = tr.json().get("transactions", tr.json().get("items", tr.json()))
    candidates = [t for t in txns if str(t.get("date", "")).startswith("2026-07")
                  or str(t.get("date", "")).startswith("2026-08")
                  or str(t.get("date", "")).startswith("2026-09")]
    assert candidates, "No open-period 2026 transactions available to split"
    target = candidates[0]
    amt = float(target["amount"])
    half = round(amt / 2, 2); other = round(amt - half, 2)
    meals = accts_map.get("6000"); travel = accts_map.get("6100")
    assert meals and travel
    sp = requests.post(f"{API}/companies/{cid}/transactions/{target['id']}/split",
                       headers=_hdr(auth),
                       json={"splits": [
                           {"account_code": "6000", "amount": half, "memo": "TEST_iter7 split half meals"},
                           {"account_code": "6100", "amount": other, "memo": "TEST_iter7 split half travel"},
                       ]}, timeout=15)
    assert sp.status_code in (200, 201), sp.text

    # 3. Fetch GL and inspect sources
    gl = requests.get(f"{API}/companies/{cid}/reports/general-ledger",
                      headers=_hdr(auth), timeout=30)
    assert gl.status_code == 200, gl.text
    data = gl.json()
    sections = data.get("sections", [])
    all_sources = set()
    for sec in sections:
        for e in sec.get("entries", []):
            assert "source" in e, f"missing 'source' in entry {e}"
            assert e["source"] in ("Txn", "Split", "JE"), f"bad source {e['source']}"
            all_sources.add(e["source"])
    # Given a fresh JE + a split were posted in 2026, and there are plain txns
    assert "Txn" in all_sources, f"Expected 'Txn' sources, got {all_sources}"
    assert "JE" in all_sources, f"Expected 'JE' after posting one, got {all_sources}"
    assert "Split" in all_sources, f"Expected 'Split' after splitting, got {all_sources}"


def test_trial_balance_still_balanced(auth, cid):
    r = requests.get(f"{API}/companies/{cid}/reports/trial-balance",
                     headers=_hdr(auth), timeout=30)
    assert r.status_code == 200
    j = r.json()
    # balanced field
    if "balanced" in j:
        assert j["balanced"] is True, f"trial balance not balanced: {j}"
    else:
        # fall back to totals comparison
        td = float(j.get("total_debit", 0)); tc = float(j.get("total_credit", 0))
        assert abs(td - tc) < 0.01, f"TB unbalanced {td} vs {tc}"


def test_balance_sheet_still_balanced(auth, cid):
    r = requests.get(f"{API}/companies/{cid}/reports/balance-sheet",
                     headers=_hdr(auth), timeout=30)
    assert r.status_code == 200
    j = r.json()
    if "balanced" in j:
        assert j["balanced"] is True, f"BS not balanced: {j.get('imbalance')}"
    if "imbalance" in j:
        assert abs(float(j["imbalance"])) < 0.01, f"BS imbalance {j['imbalance']}"


def test_gl_pdf_returns_pdf(auth, cid):
    r = requests.get(f"{API}/companies/{cid}/reports/general-ledger/pdf",
                     headers=_hdr(auth), timeout=60)
    assert r.status_code == 200
    assert "pdf" in r.headers.get("content-type", "").lower()
    assert r.content[:4] == b"%PDF"
    # crude check: PDFs contain compressed streams so 'Source' won't be literal in bytes;
    # ensure size is reasonable (>2KB)
    assert len(r.content) > 2000


def test_gl_json_shape_all_entries_have_source(auth, cid):
    r = requests.get(f"{API}/companies/{cid}/reports/general-ledger",
                     headers=_hdr(auth), timeout=30)
    assert r.status_code == 200
    for sec in r.json().get("sections", []):
        for e in sec.get("entries", []):
            assert e.get("source") in ("Txn", "Split", "JE")
            for k in ("date", "description", "debit", "credit", "balance"):
                assert k in e, f"entry missing {k}: {e}"
