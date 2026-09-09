"""Phase 2 — Client Portal & Cockpit Requests HTTP-level e2e tests.

Runs against REACT_APP_BACKEND_URL to catch routing + integration bugs
(not just python-level logic). Covers:
- Firm-side portal CRUD (idempotent create, list, revoke → 410)
- Public portal GET/answer/upload (incl. cross-portal 403, size 413, empty 400)
- Cockpit requests list + resend + cancel
- Auto-unblock loop: answer via public → cockpit sees status flip
"""
import os
import io
import uuid
import time
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/")
assert BASE_URL, "REACT_APP_BACKEND_URL required"

PRO_EMAIL = "pro@axiom.ai"
PRO_PASS = "pro123"


# ---------- fixtures ----------
@pytest.fixture(scope="module")
def pro_token():
    r = requests.post(f"{BASE_URL}/api/auth/login",
                      json={"email": PRO_EMAIL, "password": PRO_PASS}, timeout=30)
    assert r.status_code == 200, f"login failed: {r.status_code} {r.text}"
    return r.json()["token"]


@pytest.fixture(scope="module")
def pro_client(pro_token):
    s = requests.Session()
    s.headers.update({"Authorization": f"Bearer {pro_token}", "Content-Type": "application/json"})
    return s


@pytest.fixture(scope="module")
def company_id(pro_client):
    r = pro_client.get(f"{BASE_URL}/api/companies", timeout=30)
    assert r.status_code == 200, r.text
    data = r.json()
    comps = data if isinstance(data, list) else data.get("companies") or data.get("items") or []
    assert comps, f"no accessible companies: {data}"
    return comps[0]["id"]


@pytest.fixture(scope="module")
def test_email():
    return f"test_portal_{uuid.uuid4().hex[:8]}@example.com"


# ---------- helpers ----------
def _seed_question_via_ask_client(pro_client, cid, to_email, question):
    """Grab any txn on the company and call ask-client to insert a real
    client_questions doc. Returns the qid (token) or None."""
    # Try common txn list endpoints.
    for path in [f"/api/companies/{cid}/transactions?limit=5",
                 f"/api/transactions?company_id={cid}&limit=5"]:
        r = pro_client.get(f"{BASE_URL}{path}", timeout=30)
        if r.status_code == 200:
            body = r.json()
            items = body if isinstance(body, list) else body.get("transactions") or body.get("items") or []
            if items:
                tid = items[0].get("id")
                if not tid:
                    continue
                seed = pro_client.post(
                    f"{BASE_URL}/api/companies/{cid}/transactions/{tid}/ask-client",
                    json={"txn_id": tid, "question": question, "to": to_email}, timeout=30,
                )
                if seed.status_code == 200:
                    j = seed.json()
                    return (j.get("question_id") or j.get("id")
                            or (j.get("question") or {}).get("id") or j.get("token"))
                else:
                    print(f"ask-client failed: {seed.status_code} {seed.text[:200]}")
                    return None
    return None



class TestFirmPortalCRUD:
    def test_create_portal(self, pro_client, company_id, test_email):
        r = pro_client.post(
            f"{BASE_URL}/api/companies/{company_id}/client-portals",
            json={"client_email": test_email, "client_name": "Test Client"}, timeout=30,
        )
        assert r.status_code == 200, r.text
        j = r.json()
        assert "portal" in j and "url" in j
        assert j["portal"]["client_email"] == test_email.lower()
        assert "/portal/" in j["url"]
        pytest.portal_token = j["portal"]["id"]
        pytest.portal_url = j["url"]

    def test_create_is_idempotent(self, pro_client, company_id, test_email):
        r = pro_client.post(
            f"{BASE_URL}/api/companies/{company_id}/client-portals",
            json={"client_email": test_email, "client_name": "Test Client"}, timeout=30,
        )
        assert r.status_code == 200
        assert r.json()["portal"]["id"] == pytest.portal_token, "idempotent create must return same token"

    def test_list_portals(self, pro_client, company_id, test_email):
        r = pro_client.get(f"{BASE_URL}/api/companies/{company_id}/client-portals", timeout=30)
        assert r.status_code == 200
        portals = r.json().get("portals", [])
        assert any(p["client_email"] == test_email.lower() for p in portals)


# ---------- Public portal endpoints ----------
class TestPublicPortal:
    def test_portal_home_public_no_auth(self, company_id, test_email, pro_client):
        # public GET must work with NO auth header
        r = requests.get(f"{BASE_URL}/api/portal/{pytest.portal_token}", timeout=30)
        assert r.status_code == 200, r.text
        j = r.json()
        assert j["allow_upload"] is True
        assert "brand" in j and "open_questions" in j and "recent_questions" in j
        pytest.open_qs = j["open_questions"]

    def test_portal_answer_flow(self, pro_client, company_id, test_email):
        # Seed a client_question via direct DB is not available here — instead
        # we use ai_ops or check-review path is complex. Simulate by creating
        # a question through the "ask client" endpoint if available, else we
        # skip if none exist.
        # Try the known route: /api/companies/{cid}/client-questions
        qid = _seed_question_via_ask_client(pro_client, company_id, test_email, "TEST_e2e — meal?")
        if not qid:
            pytest.skip("could not seed a client_question")
        pytest.qid = qid

        # Refresh portal home — new question should appear
        r = requests.get(f"{BASE_URL}/api/portal/{pytest.portal_token}", timeout=30)
        assert r.status_code == 200
        assert any(q["id"] == qid for q in r.json()["open_questions"]), \
            "seeded question not visible in portal open_questions"

        # Answer as public
        r = requests.post(f"{BASE_URL}/api/portal/{pytest.portal_token}/answer/{qid}",
                          json={"answer": "Yes, business meal with client X."}, timeout=30)
        assert r.status_code == 200, r.text
        assert r.json()["status"] == "answered"

        # Confirm double-answer rejected
        r2 = requests.post(f"{BASE_URL}/api/portal/{pytest.portal_token}/answer/{qid}",
                           json={"answer": "again"}, timeout=30)
        assert r2.status_code == 400

    def test_answer_cross_portal_forbidden(self, pro_client, company_id):
        """A question addressed to a different email must NOT be answerable
        through this portal (403)."""
        other_email = f"TEST_other_{uuid.uuid4().hex[:6]}@example.com"
        qid = _seed_question_via_ask_client(pro_client, company_id, other_email, "TEST_cross")
        if not qid:
            pytest.skip("cannot seed cross question")
        r = requests.post(f"{BASE_URL}/api/portal/{pytest.portal_token}/answer/{qid}",
                          json={"answer": "hijack"}, timeout=30)
        assert r.status_code == 403, f"expected 403, got {r.status_code}: {r.text}"

    def test_upload_empty_rejected(self):
        files = {"file": ("empty.txt", b"", "text/plain")}
        r = requests.post(f"{BASE_URL}/api/portal/{pytest.portal_token}/upload",
                          files=files, timeout=30)
        assert r.status_code == 400, f"expected 400 empty, got {r.status_code}: {r.text}"

    def test_upload_too_large_rejected(self):
        big = b"x" * (15 * 1024 * 1024 + 100)
        files = {"file": ("big.bin", big, "application/octet-stream")}
        r = requests.post(f"{BASE_URL}/api/portal/{pytest.portal_token}/upload",
                          files=files, timeout=60)
        assert r.status_code == 413, f"expected 413, got {r.status_code}"

    def test_upload_happy_path(self):
        files = {"file": ("receipt.jpg", b"fake-jpg-bytes", "image/jpeg")}
        r = requests.post(f"{BASE_URL}/api/portal/{pytest.portal_token}/upload",
                          files=files, data={"note": "TEST receipt"}, timeout=30)
        assert r.status_code == 200, r.text
        j = r.json()
        assert j["status"] == "uploaded"
        assert "upload_id" in j and "linked_txn_count" in j


# ---------- Cockpit requests ----------
class TestCockpitRequests:
    def test_list_requests(self, pro_client):
        r = pro_client.get(f"{BASE_URL}/api/cockpit/requests?status=all&limit=200", timeout=30)
        assert r.status_code == 200, r.text
        j = r.json()
        assert "items" in j and "counts" in j
        assert isinstance(j["items"], list)

    def test_status_filter_open(self, pro_client):
        r = pro_client.get(f"{BASE_URL}/api/cockpit/requests?status=open", timeout=30)
        assert r.status_code == 200
        for it in r.json()["items"]:
            assert it["status"] in ("pending", "sent")

    def test_auto_unblock_answered_visible(self, pro_client):
        """The question answered via public portal must now appear when
        status=answered — this is the polling loop that the frontend uses."""
        if not getattr(pytest, "qid", None):
            pytest.skip("no seeded qid")
        r = pro_client.get(f"{BASE_URL}/api/cockpit/requests?status=answered&limit=500", timeout=30)
        assert r.status_code == 200
        assert any(it["id"] == pytest.qid for it in r.json()["items"]), \
            "answered question not present in cockpit answered list — auto-unblock BROKEN"

    def test_resend(self, pro_client, company_id):
        other_email = f"TEST_resend_{uuid.uuid4().hex[:6]}@example.com"
        qid = _seed_question_via_ask_client(pro_client, company_id, other_email, "TEST_resend")
        if not qid:
            pytest.skip("cannot seed")
        r = pro_client.post(f"{BASE_URL}/api/cockpit/requests/{qid}/resend", timeout=30)
        assert r.status_code == 200, r.text
        assert r.json()["resent_count"] >= 1

    def test_cancel(self, pro_client, company_id):
        other_email = f"TEST_cancel_{uuid.uuid4().hex[:6]}@example.com"
        qid = _seed_question_via_ask_client(pro_client, company_id, other_email, "TEST_cancel")
        if not qid:
            pytest.skip("cannot seed")
        r = pro_client.post(f"{BASE_URL}/api/cockpit/requests/{qid}/cancel", timeout=30)
        assert r.status_code == 200

        # Verify status via list
        lst = pro_client.get(f"{BASE_URL}/api/cockpit/requests?status=cancelled&limit=500", timeout=30)
        assert any(it["id"] == qid for it in lst.json()["items"])


# ---------- Revoke → 410 ----------
class TestRevoke:
    def test_revoke_then_public_410(self, pro_client, company_id):
        # Create a fresh portal to revoke
        email = f"TEST_revoke_{uuid.uuid4().hex[:6]}@example.com"
        r = pro_client.post(
            f"{BASE_URL}/api/companies/{company_id}/client-portals",
            json={"client_email": email}, timeout=30,
        )
        assert r.status_code == 200
        pid = r.json()["portal"]["id"]
        # Revoke
        r2 = pro_client.post(
            f"{BASE_URL}/api/companies/{company_id}/client-portals/{pid}/revoke", timeout=30
        )
        assert r2.status_code == 200
        # Public GET → 410
        r3 = requests.get(f"{BASE_URL}/api/portal/{pid}", timeout=30)
        assert r3.status_code == 410, f"expected 410, got {r3.status_code}"
