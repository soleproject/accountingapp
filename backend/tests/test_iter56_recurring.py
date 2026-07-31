"""Iteration 56: recurring invoice/bill templates + soft duplicate-number warn."""
import os
import time
import pytest
import requests
from datetime import date, timedelta

def _get_base():
    v = os.environ.get("REACT_APP_BACKEND_URL")
    if v:
        return v.rstrip("/")
    for p in ("/app/frontend/.env",):
        try:
            for line in open(p):
                if line.startswith("REACT_APP_BACKEND_URL="):
                    return line.split("=", 1)[1].strip().rstrip("/")
        except FileNotFoundError:
            pass
    raise RuntimeError("REACT_APP_BACKEND_URL not found")

BASE = _get_base()


@pytest.fixture(scope="module")
def sess():
    s = requests.Session()
    r = s.post(f"{BASE}/api/auth/login", json={"email": "client@axiom.ai", "password": "client123"})
    assert r.status_code == 200, r.text
    tok = r.json().get("access_token") or r.json().get("token")
    if tok:
        s.headers.update({"Authorization": f"Bearer {tok}"})
    return s


@pytest.fixture(scope="module")
def cid(sess):
    r = sess.get(f"{BASE}/api/companies")
    assert r.status_code == 200
    data = r.json()
    comps = data.get("companies") or data
    for c in comps:
        if "Skyward" in (c.get("name") or ""):
            return c["id"]
    return comps[0]["id"]


@pytest.fixture(scope="module")
def contact_id(sess, cid):
    r = sess.get(f"{BASE}/api/companies/{cid}/contacts")
    assert r.status_code == 200, r.text
    data = r.json()
    contacts = data.get("contacts") or data
    return contacts[0]["id"] if contacts else None


# ---------------- Recurring templates ----------------

def _payload(kind, freq="monthly", start=None, contact_id=None, contact_name=""):
    return {
        "kind": kind,
        "frequency": freq,
        "start_date": start or date.today().isoformat(),
        "contact_id": contact_id,
        "contact_name": contact_name or "TEST_Recurring",
        "line_items": [{"description": "Monthly retainer", "amount": 500}],
        "tax": 0,
        "net_days": 15,
        "name": f"TEST_{kind}_{freq}",
    }


class TestRecurringInvoice:
    tid = None

    def test_create_bad_frequency(self, sess, cid):
        p = _payload("invoice", freq="daily")
        r = sess.post(f"{BASE}/api/companies/{cid}/recurring", json=p)
        assert r.status_code == 400
        assert "frequency" in r.text.lower()

    def test_create_bad_kind(self, sess, cid):
        p = _payload("random")
        r = sess.post(f"{BASE}/api/companies/{cid}/recurring", json=p)
        assert r.status_code == 400

    def test_create_monthly_invoice_template(self, sess, cid, contact_id):
        p = _payload("invoice", "monthly", start="2026-01-31", contact_id=contact_id)
        r = sess.post(f"{BASE}/api/companies/{cid}/recurring", json=p)
        assert r.status_code == 200, r.text
        doc = r.json()["template"]
        assert doc["kind"] == "invoice"
        assert doc["frequency"] == "monthly"
        assert doc["next_run_date"] == "2026-01-31"
        assert doc["paused"] is False
        assert doc["runs_count"] == 0
        TestRecurringInvoice.tid = doc["id"]

    def test_list_only_invoice_kind(self, sess, cid):
        r = sess.get(f"{BASE}/api/companies/{cid}/recurring?kind=invoice")
        assert r.status_code == 200
        tpls = r.json()["templates"]
        assert all(t["kind"] == "invoice" for t in tpls)
        # sorted by next_run_date ascending
        dates = [t["next_run_date"] for t in tpls]
        assert dates == sorted(dates)

    def test_run_now_generates_draft_invoice(self, sess, cid):
        tid = TestRecurringInvoice.tid
        assert tid
        r = sess.post(f"{BASE}/api/companies/{cid}/recurring/{tid}/run-now")
        assert r.status_code == 200, r.text
        j = r.json()
        assert j["kind"] == "invoice"
        inv_id = j["id"]
        # Fetch invoice via list to verify draft + back-pointer
        r2 = sess.get(f"{BASE}/api/companies/{cid}/invoices")
        invs = r2.json().get("invoices") or r2.json()
        inv = next((i for i in invs if i["id"] == inv_id), None)
        assert inv is not None, f"generated invoice {inv_id} not found"
        assert inv["status"] == "draft"
        assert inv.get("recurring_template_id") == tid
        # Template advanced by monthly frequency; runs_count == 1
        r3 = sess.get(f"{BASE}/api/companies/{cid}/recurring")
        tpl = next(t for t in r3.json()["templates"] if t["id"] == tid)
        assert tpl["runs_count"] == 1
        # next_run_date is a valid future date string (not the original start)
        from datetime import date, datetime
        nd = datetime.strptime(tpl["next_run_date"], "%Y-%m-%d").date()
        assert nd > date.today()

    def test_month_end_capping_pure(self):
        """Verify Jan 31 + 1 month → Feb 28/29 via pure helper."""
        import sys
        sys.path.insert(0, "/app/backend")
        from recurring_service import next_run_after
        from datetime import date
        assert next_run_after(date(2026, 1, 31), "monthly") == date(2026, 2, 28)
        assert next_run_after(date(2024, 1, 31), "monthly") == date(2024, 2, 29)  # leap
        assert next_run_after(date(2026, 1, 15), "weekly") == date(2026, 1, 22)
        assert next_run_after(date(2026, 1, 31), "quarterly") == date(2026, 4, 30)
        assert next_run_after(date(2024, 2, 29), "annual") == date(2025, 2, 28)

    def test_pause_resume_idempotent(self, sess, cid):
        tid = TestRecurringInvoice.tid
        r = sess.post(f"{BASE}/api/companies/{cid}/recurring/{tid}/pause")
        assert r.status_code == 200
        assert r.json()["template"]["paused"] is True
        # Idempotent
        r = sess.post(f"{BASE}/api/companies/{cid}/recurring/{tid}/pause")
        assert r.status_code == 200
        assert r.json()["template"]["paused"] is True
        r = sess.post(f"{BASE}/api/companies/{cid}/recurring/{tid}/resume")
        assert r.status_code == 200
        assert r.json()["template"]["paused"] is False

    def test_patch_template(self, sess, cid):
        tid = TestRecurringInvoice.tid
        r = sess.patch(f"{BASE}/api/companies/{cid}/recurring/{tid}", json={"frequency": "weekly", "net_days": 45, "name": "TEST_renamed"})
        assert r.status_code == 200, r.text
        t = r.json()["template"]
        assert t["frequency"] == "weekly"
        assert t["net_days"] == 45
        assert t["name"] == "TEST_renamed"

    def test_patch_bad_frequency(self, sess, cid):
        tid = TestRecurringInvoice.tid
        r = sess.patch(f"{BASE}/api/companies/{cid}/recurring/{tid}", json={"frequency": "hourly"})
        assert r.status_code == 400

    def test_delete_template(self, sess, cid):
        tid = TestRecurringInvoice.tid
        r = sess.delete(f"{BASE}/api/companies/{cid}/recurring/{tid}")
        assert r.status_code == 200
        r = sess.get(f"{BASE}/api/companies/{cid}/recurring")
        assert not any(t["id"] == tid for t in r.json()["templates"])


class TestRecurringBill:
    def test_create_and_run_bill(self, sess, cid, contact_id):
        p = _payload("bill", "quarterly", contact_id=contact_id)
        r = sess.post(f"{BASE}/api/companies/{cid}/recurring", json=p)
        assert r.status_code == 200, r.text
        tid = r.json()["template"]["id"]
        r = sess.post(f"{BASE}/api/companies/{cid}/recurring/{tid}/run-now")
        assert r.status_code == 200
        bill_id = r.json()["id"]
        r2 = sess.get(f"{BASE}/api/companies/{cid}/bills")
        bills = r2.json().get("bills") or r2.json()
        bill = next((b for b in bills if b["id"] == bill_id), None)
        assert bill is not None
        assert bill["status"] == "draft"
        assert bill.get("recurring_template_id") == tid
        # cleanup
        sess.delete(f"{BASE}/api/companies/{cid}/recurring/{tid}")


# ---------------- Soft duplicate number warn ----------------

class TestSoftDuplicateNumber:
    def _ensure_two_invoices(self, sess, cid):
        r = sess.get(f"{BASE}/api/companies/{cid}/invoices")
        invs = r.json().get("invoices") or []
        while len(invs) < 2:
            payload = {"contact_name": "TEST_dupctx", "issue_date": "2026-01-15",
                       "due_date": "2026-02-15", "line_items": [{"description": "x", "amount": 100}]}
            rc = sess.post(f"{BASE}/api/companies/{cid}/invoices", json=payload)
            assert rc.status_code == 200, rc.text
            r = sess.get(f"{BASE}/api/companies/{cid}/invoices")
            invs = r.json().get("invoices") or []
        return invs

    def test_invoice_duplicate_number_warn(self, sess, cid):
        invs = self._ensure_two_invoices(sess, cid)
        n1, n2 = invs[0]["number"], invs[1]["number"]
        i2 = invs[1]["id"]
        r = sess.patch(f"{BASE}/api/companies/{cid}/invoices/{i2}", json={"number": n1})
        assert r.status_code == 200, r.text
        j = r.json()
        assert j.get("ok") is True
        assert j.get("number_conflict") is True
        fresh = f"TEST-{int(time.time())}"
        r = sess.patch(f"{BASE}/api/companies/{cid}/invoices/{i2}", json={"number": fresh})
        assert r.status_code == 200
        assert r.json().get("number_conflict") is False
        sess.patch(f"{BASE}/api/companies/{cid}/invoices/{i2}", json={"number": n2})

    def test_bill_duplicate_number_warn(self, sess, cid):
        r = sess.get(f"{BASE}/api/companies/{cid}/bills")
        bills = r.json().get("bills") or []
        while len(bills) < 2:
            payload = {"contact_name": "TEST_dupctx", "issue_date": "2026-01-15",
                       "due_date": "2026-02-15", "line_items": [{"description": "x", "amount": 100}]}
            rc = sess.post(f"{BASE}/api/companies/{cid}/bills", json=payload)
            assert rc.status_code == 200, rc.text
            r = sess.get(f"{BASE}/api/companies/{cid}/bills")
            bills = r.json().get("bills") or []
        n1, n2 = bills[0]["number"], bills[1]["number"]
        b2 = bills[1]["id"]
        r = sess.patch(f"{BASE}/api/companies/{cid}/bills/{b2}", json={"number": n1})
        assert r.status_code == 200, r.text
        assert r.json().get("number_conflict") is True
        fresh = f"TESTBILL-{int(time.time())}"
        r = sess.patch(f"{BASE}/api/companies/{cid}/bills/{b2}", json={"number": fresh})
        assert r.json().get("number_conflict") is False
        sess.patch(f"{BASE}/api/companies/{cid}/bills/{b2}", json={"number": n2})
