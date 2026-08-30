"""Live-URL smoke tests for Contact CRM endpoints (iteration_82)."""
import os
import uuid
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "https://aifinance-hub-6.preview.emergentagent.com").rstrip("/")
ACME_CONTACT_ID = "461528bc-c115-4fbf-913e-22ce15117ef9"


@pytest.fixture(scope="module")
def auth():
    r = requests.post(f"{BASE_URL}/api/auth/login",
                      json={"email": "pro@axiom.ai", "password": "pro123"},
                      timeout=30)
    assert r.status_code == 200, r.text
    tok = r.json()["token"]
    h = {"Authorization": f"Bearer {tok}", "Content-Type": "application/json"}
    # Find Bright Beans Coffee Co.
    r = requests.get(f"{BASE_URL}/api/companies", headers=h, timeout=30)
    assert r.status_code == 200
    cos = r.json().get("companies") or r.json()
    bright = next(c for c in cos if "Bright Beans" in c.get("name", ""))
    return {"h": h, "cid": bright["id"]}


def test_crm_summary_shape(auth):
    r = requests.get(
        f"{BASE_URL}/api/companies/{auth['cid']}/contacts/{ACME_CONTACT_ID}/crm-summary",
        headers=auth["h"], timeout=30)
    assert r.status_code == 200, r.text
    d = r.json()
    for k in ("contact", "deals", "stats", "activity_feed", "valid_stages"):
        assert k in d
    for k in ("open_count", "open_value", "won_count", "won_value",
              "lost_count", "lost_value", "last_activity_at"):
        assert k in d["stats"]
    assert set(d["valid_stages"]) == {"lead", "prospect", "active_customer",
                                       "past_customer", "inactive"}


def test_activity_validation_and_add(auth):
    url = f"{BASE_URL}/api/companies/{auth['cid']}/contacts/{ACME_CONTACT_ID}/activities"
    # blank body
    r = requests.post(url, headers=auth["h"], json={"kind": "note", "body": "   "}, timeout=30)
    assert r.status_code == 400
    # bad kind
    r = requests.post(url, headers=auth["h"], json={"kind": "smoke", "body": "hi"}, timeout=30)
    assert r.status_code == 400
    # missing contact
    r = requests.post(
        f"{BASE_URL}/api/companies/{auth['cid']}/contacts/does-not-exist-xyz/activities",
        headers=auth["h"], json={"kind": "note", "body": "hi"}, timeout=30)
    assert r.status_code == 404
    # happy path
    body_txt = f"TEST_iter82 {uuid.uuid4().hex[:6]}"
    r = requests.post(url, headers=auth["h"], json={"kind": "call", "body": body_txt}, timeout=30)
    assert r.status_code == 200
    act = r.json()["activity"]
    for k in ("id", "at", "kind", "body", "by_user_id", "by_name"):
        assert k in act
    assert act["kind"] == "call" and act["body"] == body_txt
    # confirm shows in feed
    r = requests.get(
        f"{BASE_URL}/api/companies/{auth['cid']}/contacts/{ACME_CONTACT_ID}/crm-summary",
        headers=auth["h"], timeout=30)
    assert any(a.get("body") == body_txt and a.get("source") == "contact"
               for a in r.json()["activity_feed"])


def test_patch_stage_and_lead_source(auth):
    src = f"TEST_ref_{uuid.uuid4().hex[:5]}"
    r = requests.patch(
        f"{BASE_URL}/api/companies/{auth['cid']}/contacts/{ACME_CONTACT_ID}",
        headers=auth["h"],
        json={"stage": "active_customer", "lead_source": src}, timeout=30)
    assert r.status_code == 200
    r = requests.get(
        f"{BASE_URL}/api/companies/{auth['cid']}/contacts/{ACME_CONTACT_ID}/crm-summary",
        headers=auth["h"], timeout=30)
    c = r.json()["contact"]
    assert c["stage"] == "active_customer"
    assert c["lead_source"] == src


def test_deal_activity_merges_into_feed(auth):
    # Find or create a deal linked to Acme contact
    cid = auth["cid"]
    # try list deals
    r = requests.get(f"{BASE_URL}/api/companies/{cid}/deals",
                     headers=auth["h"], params={"contact_id": ACME_CONTACT_ID},
                     timeout=30)
    deal_id = None
    if r.status_code == 200:
        deals = r.json().get("deals", [])
        if deals:
            deal_id = deals[0]["id"]
    if not deal_id:
        r = requests.post(f"{BASE_URL}/api/companies/{cid}/deals",
                          headers=auth["h"],
                          json={"title": "TEST_iter82 deal",
                                "contact_id": ACME_CONTACT_ID,
                                "value": 100, "stage": "proposal"}, timeout=30)
        assert r.status_code in (200, 201), r.text
        deal_id = r.json()["deal"]["id"]
    marker = f"TEST_deal_activity {uuid.uuid4().hex[:6]}"
    r = requests.post(f"{BASE_URL}/api/companies/{cid}/deals/{deal_id}/activities",
                      headers=auth["h"],
                      json={"kind": "meeting", "body": marker}, timeout=30)
    assert r.status_code == 200, r.text
    r = requests.get(
        f"{BASE_URL}/api/companies/{cid}/contacts/{ACME_CONTACT_ID}/crm-summary",
        headers=auth["h"], timeout=30)
    feed = r.json()["activity_feed"]
    found = [a for a in feed if a.get("body") == marker]
    assert found and found[0]["source"] == "deal"
    assert found[0].get("deal_id") == deal_id
    assert found[0].get("deal_title")
    # sorted desc
    ats = [a["at"] for a in feed]
    assert ats == sorted(ats, reverse=True)
