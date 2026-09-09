"""E2E API tests for Advisor Reports Pack (Phase 4A) + adjust_drafts blocker."""
import os
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "http://localhost:8001").rstrip("/")
PRO_EMAIL = "pro@axiom.ai"
PRO_PASS = "pro123"
CLIENT_EMAIL = "client@axiom.ai"
CLIENT_PASS = "client123"
BB_CID = "1829a9eb-7df2-4a31-afcf-7e50a514da7e"
PERIOD = "2026-01"


def _login(email, pw):
    r = requests.post(f"{BASE_URL}/api/auth/login",
                      json={"email": email, "password": pw}, timeout=30)
    assert r.status_code == 200, f"login failed: {r.status_code} {r.text}"
    return r.json().get("token") or r.json().get("access_token")


@pytest.fixture(scope="module")
def pro_headers():
    return {"Authorization": f"Bearer {_login(PRO_EMAIL, PRO_PASS)}"}


@pytest.fixture(scope="module")
def client_headers():
    return {"Authorization": f"Bearer {_login(CLIENT_EMAIL, CLIENT_PASS)}"}


# --- cross rollup ---------------------------------------------------------

def test_cross_rollup_pro(pro_headers):
    r = requests.get(f"{BASE_URL}/api/cockpit/reports",
                     params={"period": PERIOD}, headers=pro_headers, timeout=30)
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["period"] == PERIOD
    assert "totals" in j and all(k in j["totals"] for k in ("companies", "generated", "sent", "pending"))
    assert isinstance(j["per_company"], list)
    assert len(j["per_company"]) >= 1
    # sort order: not-generated first, then generated-not-sent, then sent
    prev_rank = -1
    for row in j["per_company"]:
        rank = 0 if not row["has_target_report"] else (1 if not row["target_sent_at"] else 2)
        assert rank >= prev_rank, f"sort broken at {row['company_name']}"
        prev_rank = rank


def test_cross_rollup_client_403(client_headers):
    r = requests.get(f"{BASE_URL}/api/cockpit/reports",
                     params={"period": PERIOD}, headers=client_headers, timeout=30)
    assert r.status_code == 403, f"expected 403, got {r.status_code}: {r.text}"


# --- generate / list / pdf / send ----------------------------------------

@pytest.fixture(scope="module")
def generated_report(pro_headers):
    r = requests.post(f"{BASE_URL}/api/companies/{BB_CID}/advisor-reports/generate",
                      params={"ym": PERIOD}, headers=pro_headers, timeout=120)
    assert r.status_code == 200, r.text
    return r.json()


def test_generate_report_shape(generated_report):
    j = generated_report
    assert j["period"] == PERIOD
    assert "id" in j
    for k in ("revenue", "revenue_prev", "revenue_pct_change",
              "gross_profit", "gross_margin_pct", "opex", "net_income", "cash"):
        assert k in j["kpis"], f"missing kpi {k}"
    for k in ("revenue", "expenses", "position"):
        assert k in j["narrative"]
    assert j["size_bytes"] > 1000


def test_generate_replaces_prior(pro_headers, generated_report):
    old_id = generated_report["id"]
    r = requests.post(f"{BASE_URL}/api/companies/{BB_CID}/advisor-reports/generate",
                      params={"ym": PERIOD}, headers=pro_headers, timeout=120)
    assert r.status_code == 200
    new_id = r.json()["id"]
    assert new_id != old_id
    # only one report should exist for this period
    lst = requests.get(f"{BASE_URL}/api/companies/{BB_CID}/advisor-reports",
                       headers=pro_headers, timeout=30).json()["reports"]
    matching = [x for x in lst if x["period"] == PERIOD]
    assert len(matching) == 1, f"expected 1, got {len(matching)}"


def test_list_reports_no_pdf_base64(pro_headers):
    r = requests.get(f"{BASE_URL}/api/companies/{BB_CID}/advisor-reports",
                     headers=pro_headers, timeout=30)
    assert r.status_code == 200
    reports = r.json()["reports"]
    assert len(reports) >= 1
    for rep in reports:
        assert "pdf_base64" not in rep
    # sorted period desc
    periods = [r["period"] for r in reports]
    assert periods == sorted(periods, reverse=True)


def test_pdf_download(pro_headers):
    lst = requests.get(f"{BASE_URL}/api/companies/{BB_CID}/advisor-reports",
                       headers=pro_headers, timeout=30).json()["reports"]
    rid = [r for r in lst if r["period"] == PERIOD][0]["id"]
    r = requests.get(f"{BASE_URL}/api/companies/{BB_CID}/advisor-reports/{rid}/pdf",
                     headers=pro_headers, timeout=60)
    assert r.status_code == 200
    assert r.headers.get("content-type", "").startswith("application/pdf")
    assert "attachment" in r.headers.get("content-disposition", "")
    assert len(r.content) > 1000
    assert r.content[:4] == b"%PDF"


def test_send_to_portal(pro_headers):
    lst = requests.get(f"{BASE_URL}/api/companies/{BB_CID}/advisor-reports",
                       headers=pro_headers, timeout=30).json()["reports"]
    rid = [r for r in lst if r["period"] == PERIOD][0]["id"]
    r = requests.post(
        f"{BASE_URL}/api/companies/{BB_CID}/advisor-reports/{rid}/send-to-portal",
        params={"to_email": "TEST_client@example.com"}, headers=pro_headers, timeout=30)
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["ok"] is True
    assert "question_id" in j
    # verify sent_to_client_at now populated
    lst2 = requests.get(f"{BASE_URL}/api/companies/{BB_CID}/advisor-reports",
                        headers=pro_headers, timeout=30).json()["reports"]
    target = [r for r in lst2 if r["id"] == rid][0]
    assert target["sent_to_client_at"] is not None


# --- Phase 1 debt: adjust_drafts blocker ---------------------------------

def test_close_board_shows_adjust_drafts_blocker(pro_headers):
    r = requests.get(f"{BASE_URL}/api/cockpit/close-board",
                     params={"period": "2026-02"}, headers=pro_headers, timeout=60)
    assert r.status_code == 200, r.text
    j = r.json()
    # find Bright Beans card
    companies = j.get("cards") or j.get("companies") or j.get("per_company") or []
    bb = next((c for c in companies if c.get("company_id") == BB_CID or c.get("id") == BB_CID), None)
    assert bb is not None, f"Bright Beans not found in close-board. Keys: {list(j.keys())}"
    blockers = bb.get("top_blockers") or []
    adjust = [b for b in blockers if b.get("kind") == "adjust_drafts"]
    assert len(adjust) >= 1, f"adjust_drafts blocker missing. blockers={blockers}"
    assert adjust[0]["count"] >= 1
    assert "adjust draft" in adjust[0]["label"].lower()
