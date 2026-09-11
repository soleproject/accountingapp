"""Manual Payroll Ledger regression tests.

Covers the two recent architectural fixes:
  1. Asymmetric contact sourcing (w2 → employee_id, 1099 → contact_id).
  2. Semantic payroll account resolution (name+type, never CoA code).
Plus liability aging, pay-liability with overpayment guard, pay-stub PDF,
and tax-code catalog.
"""

import io
import os
import time
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/")
API = f"{BASE_URL}/api"

PRO_EMAIL = "pro@axiom.ai"
PRO_PASSWORD = "pro123"


# ── Fixtures ────────────────────────────────────────────────────────

@pytest.fixture(scope="module")
def session():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    # Try common auth endpoints
    for path in ("/auth/login", "/login"):
        r = s.post(f"{API}{path}", json={"email": PRO_EMAIL, "password": PRO_PASSWORD})
        if r.status_code == 200:
            data = r.json()
            tok = data.get("token") or data.get("access_token")
            if tok:
                s.headers["Authorization"] = f"Bearer {tok}"
            return s
    pytest.skip(f"Cannot auth as {PRO_EMAIL}: last status {r.status_code} body {r.text[:200]}")


@pytest.fixture(scope="module")
def bright_beans_cid(session):
    r = session.get(f"{API}/companies")
    assert r.status_code == 200, r.text
    body = r.json()
    companies = body if isinstance(body, list) else (body.get("companies") or body.get("items") or [])
    for c in companies:
        if "bright beans" in (c.get("name") or "").lower():
            return c.get("id") or c.get("_id")
    pytest.skip("Bright Beans Coffee Co. not found for pro user")


# ── Basic surfaces ─────────────────────────────────────────────────

def test_payroll_summary(session, bright_beans_cid):
    r = session.get(f"{API}/companies/{bright_beans_cid}/payroll/summary")
    assert r.status_code == 200, r.text
    d = r.json()
    assert "runs_finalized" in d and "mtd" in d and "ytd" in d


def test_payroll_liabilities(session, bright_beans_cid):
    r = session.get(f"{API}/companies/{bright_beans_cid}/payroll/liabilities")
    assert r.status_code == 200, r.text
    d = r.json()
    assert "rows" in d and "totals" in d
    assert "by_state" in d and "by_agency" in d
    # Bright Beans should show ~$800 outstanding total per problem statement
    outstanding = d["totals"].get("outstanding") or 0
    assert outstanding > 0, f"Expected outstanding > 0 on Bright Beans, got {outstanding}"


def test_tax_codes_ca(session, bright_beans_cid):
    r = session.get(f"{API}/companies/{bright_beans_cid}/payroll/tax-codes?state=CA")
    assert r.status_code == 200, r.text
    d = r.json()
    assert "combined" in d and "all_states" in d
    codes = {c.get("code") for c in d["combined"] if isinstance(c, dict)}
    # Expect at least one federal and one CA code
    fed_present = any(str(c or "").startswith("FED") or "FICA" in str(c or "") for c in codes)
    ca_present  = any(str(c or "").startswith("CA_") for c in codes)
    assert fed_present, f"No federal codes in combined: {codes}"
    assert ca_present,  f"No CA codes in combined: {codes}"


# ── Semantic account resolution — check the pre-existing finalized JE ─

def test_balance_sheet_has_2350_payroll_liabilities_not_2200(session, bright_beans_cid):
    """The critical fix: payroll liab should show as 'Payroll Liabilities'
    with a non-zero balance, NOT credited to 'Sales Tax Payable' / 2200."""
    r = session.get(f"{API}/companies/{bright_beans_cid}/reports/balance-sheet")
    assert r.status_code == 200, r.text
    body = r.json()
    text = str(body).lower()
    assert "payroll liabilities" in text, "Balance sheet is missing 'Payroll Liabilities' account"

    # Recursively find the Payroll Liabilities row
    found = []
    def walk(node):
        if isinstance(node, dict):
            name = (node.get("name") or node.get("account_name") or "").lower()
            if "payroll" in name and "liab" in name:
                found.append(node)
            for v in node.values():
                walk(v)
        elif isinstance(node, list):
            for v in node:
                walk(v)
    walk(body)
    assert found, "Could not find Payroll Liabilities row on Balance Sheet"
    # Check code != 2200 (which is Sales Tax in the industry template)
    for row in found:
        code = str(row.get("code") or row.get("account_code") or "")
        if code:
            assert code != "2200", f"Payroll Liabilities incorrectly using code 2200 (Sales Tax range): {row}"


def test_finalized_je_credits_payroll_liabilities_not_sales_tax(session, bright_beans_cid):
    """Pull the finalized payroll run JE(s) for Bright Beans and confirm
    the CR line is against an account named Payroll Liabilities and type=liability,
    and DR wages is against a payroll-named expense (not 'Travel')."""
    r = session.get(f"{API}/companies/{bright_beans_cid}/payroll/runs")
    assert r.status_code == 200, r.text
    runs = r.json().get("runs") or []
    finalized = [x for x in runs if x.get("status") == "finalized" and x.get("je_ids")]
    assert finalized, "No finalized payroll runs on Bright Beans (fixture expectation)"

    # Fetch all JEs and filter by id
    rr = session.get(f"{API}/companies/{bright_beans_cid}/journal-entries")
    assert rr.status_code == 200, rr.text[:300]
    entries_by_id = {e.get("id"): e for e in (rr.json().get("entries") or [])}
    checked_any = False
    for run in finalized[:2]:
        for je_id in (run.get("je_ids") or []):
            je = entries_by_id.get(je_id)
            if not je:
                continue
            checked_any = True
            lines = je.get("lines") or je.get("je", {}).get("lines") or []
            cr_liab_lines = [l for l in lines if float(l.get("credit") or 0) > 0]
            for l in cr_liab_lines:
                name = (l.get("account_name") or "").lower()
                if "payroll" in name and "liab" in name:
                    # Confirm the underlying account type is liability
                    aid = l.get("account_id")
                    ra = session.get(f"{API}/companies/{bright_beans_cid}/accounts/{aid}")
                    if ra.status_code == 200:
                        a = ra.json()
                        acct = a.get("account") or a
                        atype = (acct.get("type") or "").lower()
                        assert atype in ("liability", "other_current_liability", "current_liability"), \
                            f"Payroll Liabilities account has wrong type: {atype}"
                # Critical negative check
                assert "sales tax" not in name, \
                    f"JE credits 'Sales Tax Payable' instead of Payroll Liabilities: {l}"
            dr_lines = [l for l in lines if float(l.get("debit") or 0) > 0]
            for l in dr_lines:
                name = (l.get("account_name") or "").lower()
                # DR wages line should NOT be 'Travel' or unrelated
                if name == "travel":
                    pytest.fail(f"DR line points at 'Travel' expense (semantic resolver failure): {l}")
    if not checked_any:
        pytest.skip("Could not fetch any JE for finalized payroll runs (no JE endpoint hit)")


# ── Asymmetric validator via API ────────────────────────────────────

@pytest.fixture(scope="module")
def draft_run(session, bright_beans_cid):
    r = session.post(f"{API}/companies/{bright_beans_cid}/payroll/runs",
                     json={"period_start": "2026-03-01",
                           "period_end":   "2026-03-15",
                           "pay_date":     "2026-03-16",
                           "memo": "TEST_QA regression"})
    assert r.status_code == 200, r.text
    run = r.json()["run"]
    yield run
    # Cleanup best-effort
    try:
        session.delete(f"{API}/companies/{bright_beans_cid}/payroll/runs/{run['id']}")
    except Exception:
        pass


def test_w2_without_employee_id_400(session, bright_beans_cid, draft_run):
    r = session.post(
        f"{API}/companies/{bright_beans_cid}/payroll/runs/{draft_run['id']}/stubs",
        json={"employee_name": "Ghost", "kind": "w2", "mode": "simple",
              "gross": 1000, "net": 800})
    assert r.status_code == 400, r.text
    assert "employee_id" in r.text.lower()


def test_1099_without_contact_id_400(session, bright_beans_cid, draft_run):
    r = session.post(
        f"{API}/companies/{bright_beans_cid}/payroll/runs/{draft_run['id']}/stubs",
        json={"employee_name": "Ghost Vendor", "kind": "1099", "mode": "simple",
              "gross": 500})
    assert r.status_code == 400, r.text
    assert "contact_id" in r.text.lower() or "1099" in r.text.lower()


def test_1099_with_contact_id_persists_employee_id_null(session, bright_beans_cid, draft_run):
    # Create a 1099 vendor contact
    r = session.post(f"{API}/companies/{bright_beans_cid}/contacts",
                     json={"name": "TEST_QA 1099 Vendor",
                           "type": "vendor", "is_1099_vendor": True})
    assert r.status_code in (200, 201), r.text
    body = r.json()
    contact = body.get("contact") or body
    contact_id = contact.get("id") or contact.get("_id")
    assert contact_id
    assert contact.get("is_1099_vendor") is True

    # Post 1099 stub
    r = session.post(
        f"{API}/companies/{bright_beans_cid}/payroll/runs/{draft_run['id']}/stubs",
        json={"employee_name": "TEST_QA 1099 Vendor", "kind": "1099", "mode": "simple",
              "contact_id": contact_id, "gross": 500})
    assert r.status_code == 200, r.text
    stub = r.json()["stub"]
    assert stub["kind"] == "1099"
    assert stub["contact_id"] == contact_id
    assert stub["employee_id"] is None
    assert stub["gross"] == 500.0
    assert stub["net"] == 500.0     # 1099 net==gross rule
    assert stub["ee_tax"] == 0.0


# ── Overpayment guard on pay_liability ──────────────────────────────

def test_overpayment_guard(session, bright_beans_cid):
    r = session.get(f"{API}/companies/{bright_beans_cid}/payroll/runs")
    runs = r.json().get("runs") or []
    finalized = [x for x in runs if x.get("status") == "finalized"]
    if not finalized:
        pytest.skip("No finalized runs to test overpayment against")
    run = finalized[0]
    # Pick any bank account
    ra = session.get(f"{API}/companies/{bright_beans_cid}/accounts")
    assert ra.status_code == 200
    accts_body = ra.json()
    accts = accts_body if isinstance(accts_body, list) else (accts_body.get("accounts") or [])
    bank = next((a for a in accts if (a.get("type") or "").lower() in ("bank", "asset")
                 and "bank" in ((a.get("subtype") or a.get("type") or "").lower())), None)
    if not bank:
        bank = next((a for a in accts if (a.get("type") or "").lower() in ("bank", "asset")), None)
    if not bank:
        pytest.skip("No bank/asset account available")
    r = session.post(f"{API}/companies/{bright_beans_cid}/payroll/liabilities/pay",
                     json={"run_id": run["id"],
                           "bank_account_id": bank.get("id"),
                           "ee_tax": 999999.99,
                           "agency": "TEST_QA overpay"})
    assert r.status_code == 400, r.text
    assert "overpay" in r.text.lower()


# ── Pay stub PDF ─────────────────────────────────────────────────────

def test_stub_pdf_valid(session, bright_beans_cid):
    r = session.get(f"{API}/companies/{bright_beans_cid}/payroll/runs")
    runs = r.json().get("runs") or []
    stub_id = None
    for run in runs:
        rr = session.get(f"{API}/companies/{bright_beans_cid}/payroll/runs/{run['id']}")
        if rr.status_code == 200:
            stubs = rr.json().get("stubs") or []
            if stubs:
                stub_id = stubs[0]["id"]
                break
    if not stub_id:
        pytest.skip("No stub available for PDF test")
    r = session.get(f"{API}/companies/{bright_beans_cid}/payroll/stubs/{stub_id}/pdf")
    assert r.status_code == 200, r.text[:300]
    assert "application/pdf" in r.headers.get("content-type", "").lower()
    assert r.content[:4] == b"%PDF", "PDF magic bytes missing"
    assert len(r.content) > 500


# ── Contacts 1099 flag round-trip ───────────────────────────────────

def test_contacts_returns_is_1099_vendor_field(session, bright_beans_cid):
    r = session.get(f"{API}/companies/{bright_beans_cid}/contacts")
    assert r.status_code == 200, r.text
    body = r.json()
    contacts = body if isinstance(body, list) else (body.get("contacts") or body.get("items") or [])
    assert isinstance(contacts, list) and len(contacts) > 0
    # At least one contact should have the field even if False
    has_field = any("is_1099_vendor" in c for c in contacts)
    assert has_field, "is_1099_vendor field not returned in contacts list"
