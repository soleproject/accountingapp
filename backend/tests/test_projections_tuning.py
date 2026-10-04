"""Cash-flow projections engine tuning tests (Plaid patterns, AR exclusion, conservative band, confidence)."""
import os
import pytest
import requests
from datetime import date, datetime

BASE_URL = (os.environ.get('REACT_APP_BACKEND_URL') or 'https://aifinance-hub-6.preview.emergentagent.com').rstrip('/')
CID = "63f872ac-33be-4f5d-bc78-8b3be5130cbd"  # Michael Co LLC
EMPTY_CID = "9a955c33-aeb7-48af-8393-88fb524846db"  # Michael Co 3, LLC


@pytest.fixture(scope="module")
def token():
    r = requests.post(f"{BASE_URL}/api/auth/login",
                      json={"email": "pro@axiom.ai", "password": "pro123"}, timeout=30)
    assert r.status_code == 200, r.text
    return r.json()["token"]


@pytest.fixture(scope="module")
def h(token):
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


def test_detect_patterns(h):
    r = requests.post(f"{BASE_URL}/api/companies/{CID}/projections/detect-patterns", headers=h, timeout=120)
    assert r.status_code == 200, r.text
    d = r.json()
    print("detect-patterns:", d)
    for k in ["scanned_txns", "excluded_internal", "plaid_streams", "detected", "high", "medium", "low", "stale_dropped"]:
        assert k in d, f"missing key {k}"
    assert d["plaid_streams"] == 14, f"plaid_streams={d['plaid_streams']}"
    assert d["detected"] == 14, f"detected={d['detected']}"
    assert d["excluded_internal"] > 200, f"excluded_internal={d['excluded_internal']}"


def test_patterns_list(h):
    r = requests.get(f"{BASE_URL}/api/companies/{CID}/projections/patterns", headers=h, timeout=60)
    assert r.status_code == 200, r.text
    data = r.json()
    patterns = data if isinstance(data, list) else data.get("patterns", [])
    assert len(patterns) > 0
    today = date.today().isoformat()
    valid_cad = {"weekly", "biweekly", "semimonthly", "monthly", "annual"}
    plaid_found = 0
    for p in patterns:
        assert "source" in p, f"no source: {p}"
        assert p["source"] in ("plaid", "local"), p["source"]
        if p["source"] == "plaid":
            plaid_found += 1
            assert str(p.get("pattern_key", "")).startswith("plaid|"), p.get("pattern_key")
            assert p.get("cadence") in valid_cad, p.get("cadence")
            ned = p.get("next_expected_date")
            assert ned and ned >= today, f"next_expected_date {ned} < today {today}"
    assert plaid_found >= 14, f"plaid patterns found: {plaid_found}"


def test_cashflow_structure(h):
    r = requests.get(f"{BASE_URL}/api/companies/{CID}/projections/cashflow?days=90", headers=h, timeout=120)
    assert r.status_code == 200, r.text
    d = r.json()
    # new fields
    assert "timeline" in d and "timeline_conservative" in d
    assert len(d["timeline"]) == len(d["timeline_conservative"]), f"{len(d['timeline'])} vs {len(d['timeline_conservative'])}"
    for a, b in zip(d["timeline"], d["timeline_conservative"]):
        assert "date" in a and "cash" in a
        assert "date" in b and "cash" in b
        assert b["cash"] <= a["cash"] + 1e-6, f"conservative cash > base on {b['date']}: {b['cash']} > {a['cash']}"
    assert "conservative" in d
    c = d["conservative"]
    for k in ["ending_cash", "low_30d", "assumptions"]:
        assert k in c, f"conservative missing {k}"
    # excluded_ar
    assert "excluded_ar" in d
    for e in d["excluded_ar"]:
        assert "invoice_id" in e
        assert "gross" in e
        assert "due_date" in e
        assert e.get("days_overdue", 0) > 60, e
        assert "label" in e
        assert e.get("reason") == "overdue_no_expected_date"
    # confidence
    assert "confidence" in d
    cf = d["confidence"]
    assert cf.get("level") in ("high", "medium", "low")
    assert 0 <= cf.get("score", -1) <= 100
    assert isinstance(cf.get("reasons", []), list)
    # pattern_summary
    assert "pattern_summary" in d and "plaid" in d["pattern_summary"]
    # settings_summary.sales_tax
    assert "settings_summary" in d
    st = d["settings_summary"].get("sales_tax")
    assert st is not None and "frequency" in st and "due_day" in st
    # burn_reconciliation
    br = d["burn_reconciliation"]
    assert br.get("lookback_days") == 90
    assert isinstance(br.get("residual_capped"), bool)
    # events weights
    for ev in d.get("events", []):
        if ev.get("kind") == "pattern":
            assert "weight" in ev and "gross" in ev
            conf = ev.get("confidence")
            if conf == "high":
                assert abs(ev["weight"] - 1.0) < 1e-6, ev
            elif conf == "medium":
                assert abs(ev["weight"] - 0.85) < 1e-6, ev
            elif conf == "low":
                assert ev.get("user_confirmed") is True, f"low-confidence pattern without user_confirm: {ev}"


def test_invoice_events_lateness(h):
    r = requests.get(f"{BASE_URL}/api/companies/{CID}/projections/cashflow?days=90", headers=h, timeout=120)
    assert r.status_code == 200
    d = r.json()
    today = date.today()
    for ev in d.get("events", []):
        if ev.get("kind") == "invoice":
            assert ev.get("days_overdue", 0) <= 60, ev
            assert "lateness_days" in ev
            assert "due_date" in ev
            # not-yet-due => date >= due_date
            try:
                due = datetime.fromisoformat(ev["due_date"]).date()
                evd = datetime.fromisoformat(ev["date"]).date()
                if ev.get("days_overdue", 0) <= 0:
                    assert evd >= due, f"not-yet-due invoice scheduled before due_date: {ev}"
            except Exception:
                pass


def test_set_invoice_expected_date_flow(h):
    r = requests.get(f"{BASE_URL}/api/companies/{CID}/projections/cashflow?days=180", headers=h, timeout=120)
    assert r.status_code == 200
    d = r.json()
    excluded = d.get("excluded_ar", [])
    if not excluded:
        pytest.skip("No excluded AR to test with")
    iid = excluded[0]["invoice_id"]

    # Set expected date
    r1 = requests.post(f"{BASE_URL}/api/companies/{CID}/projections/invoices/{iid}/expected-date",
                       headers=h, json={"expected_payment_date": "2026-11-15"}, timeout=30)
    assert r1.status_code == 200, r1.text
    assert r1.json().get("ok") is True

    # Re-fetch cashflow
    r2 = requests.get(f"{BASE_URL}/api/companies/{CID}/projections/cashflow?days=400", headers=h, timeout=120)
    assert r2.status_code == 200
    d2 = r2.json()
    excluded_ids = {e["invoice_id"] for e in d2.get("excluded_ar", [])}
    assert iid not in excluded_ids, "invoice still in excluded_ar after setting expected_payment_date"
    found = False
    for ev in d2.get("events", []):
        if ev.get("kind") == "invoice" and ev.get("invoice_id") == iid:
            found = True
            assert ev.get("date", "").startswith("2026-11-15"), ev
            assert ev.get("expected_payment_date") is not None
    assert found, "Invoice not found in events after expected-date set"

    # Clear expected date
    r3 = requests.post(f"{BASE_URL}/api/companies/{CID}/projections/invoices/{iid}/expected-date",
                       headers=h, json={"expected_payment_date": None}, timeout=30)
    assert r3.status_code == 200, r3.text

    r4 = requests.get(f"{BASE_URL}/api/companies/{CID}/projections/cashflow?days=180", headers=h, timeout=120)
    excluded_ids2 = {e["invoice_id"] for e in r4.json().get("excluded_ar", [])}
    assert iid in excluded_ids2, "invoice did not return to excluded_ar after clearing"

    # Invalid date
    r5 = requests.post(f"{BASE_URL}/api/companies/{CID}/projections/invoices/{iid}/expected-date",
                       headers=h, json={"expected_payment_date": "not-a-date"}, timeout=30)
    assert r5.status_code == 400, r5.text
    # Unknown invoice
    r6 = requests.post(f"{BASE_URL}/api/companies/{CID}/projections/invoices/nope-xxx/expected-date",
                       headers=h, json={"expected_payment_date": "2026-11-15"}, timeout=30)
    assert r6.status_code == 404, r6.text


def test_projection_settings(h):
    # Get current
    r0 = requests.get(f"{BASE_URL}/api/companies/{CID}/projections/settings", headers=h, timeout=30)
    assert r0.status_code == 200
    orig = r0.json()
    orig_st = (orig.get("sales_tax") or {}) if isinstance(orig, dict) else {}

    # Set quarterly/20
    r1 = requests.post(f"{BASE_URL}/api/companies/{CID}/projections/settings",
                       headers=h, json={"sales_tax": {"frequency": "quarterly", "due_day": 20}}, timeout=30)
    assert r1.status_code == 200, r1.text
    r2 = requests.get(f"{BASE_URL}/api/companies/{CID}/projections/settings", headers=h, timeout=30)
    st = r2.json().get("sales_tax")
    assert st and st.get("frequency") == "quarterly" and int(st.get("due_day")) == 20

    # Invalid freq
    r3 = requests.post(f"{BASE_URL}/api/companies/{CID}/projections/settings",
                       headers=h, json={"sales_tax": {"frequency": "weekly", "due_day": 20}}, timeout=30)
    assert r3.status_code == 400, r3.text
    # Invalid due_day
    r4 = requests.post(f"{BASE_URL}/api/companies/{CID}/projections/settings",
                       headers=h, json={"sales_tax": {"frequency": "monthly", "due_day": 31}}, timeout=30)
    assert r4.status_code == 400, r4.text

    # ar_haircuts still works
    r5 = requests.post(f"{BASE_URL}/api/companies/{CID}/projections/settings",
                       headers=h, json={"ar_haircuts": {"d0_30": 0.95}}, timeout=30)
    assert r5.status_code == 200, r5.text

    # Restore monthly/20
    r6 = requests.post(f"{BASE_URL}/api/companies/{CID}/projections/settings",
                       headers=h, json={"sales_tax": {"frequency": "monthly", "due_day": 20}}, timeout=30)
    assert r6.status_code == 200


def test_pattern_override(h):
    r = requests.get(f"{BASE_URL}/api/companies/{CID}/projections/patterns", headers=h, timeout=60)
    patterns = r.json() if isinstance(r.json(), list) else r.json().get("patterns", [])
    plaid_p = next((p for p in patterns if p.get("source") == "plaid"), None)
    assert plaid_p, "No plaid pattern to test override"
    pkey = plaid_p["pattern_key"]
    import urllib.parse
    pkey_enc = urllib.parse.quote(pkey, safe='')

    # Reject
    r1 = requests.post(f"{BASE_URL}/api/companies/{CID}/projections/patterns/{pkey_enc}/override",
                       headers=h, json={"status": "rejected"}, timeout=30)
    assert r1.status_code == 200, r1.text
    r2 = requests.get(f"{BASE_URL}/api/companies/{CID}/projections/cashflow?days=90", headers=h, timeout=120)
    for ev in r2.json().get("events", []):
        if ev.get("kind") == "pattern":
            assert ev.get("pattern_key") != pkey, f"rejected pattern still in events: {ev}"

    # Restore active
    r3 = requests.post(f"{BASE_URL}/api/companies/{CID}/projections/patterns/{pkey_enc}/override",
                       headers=h, json={"status": "active"}, timeout=30)
    assert r3.status_code == 200
    r4 = requests.get(f"{BASE_URL}/api/companies/{CID}/projections/patterns", headers=h, timeout=60)
    pats = r4.json() if isinstance(r4.json(), list) else r4.json().get("patterns", [])
    p = next((x for x in pats if x.get("pattern_key") == pkey), None)
    assert p and p.get("user_confirmed") is True, p

    # Cadence annual accepted
    r5 = requests.post(f"{BASE_URL}/api/companies/{CID}/projections/patterns/{pkey_enc}/override",
                       headers=h, json={"override_cadence": "annual"}, timeout=30)
    assert r5.status_code == 200, r5.text
    # Cadence daily -> 400
    r6 = requests.post(f"{BASE_URL}/api/companies/{CID}/projections/patterns/{pkey_enc}/override",
                       headers=h, json={"override_cadence": "daily"}, timeout=30)
    assert r6.status_code == 400, r6.text

    # Restore pattern cadence to its original
    requests.post(f"{BASE_URL}/api/companies/{CID}/projections/patterns/{pkey_enc}/override",
                  headers=h, json={"override_cadence": plaid_p.get("cadence"), "status": "active"}, timeout=30)


def test_cashflow_snapshot_regression(h):
    r = requests.get(f"{BASE_URL}/api/companies/{CID}/cockpit-cards/cashflow-snapshot", headers=h, timeout=60)
    assert r.status_code == 200, r.text


def test_empty_company_confidence_low(h):
    r = requests.get(f"{BASE_URL}/api/companies/{EMPTY_CID}/projections/cashflow?days=90", headers=h, timeout=60)
    assert r.status_code == 200, r.text
    d = r.json()
    cf = d.get("confidence", {})
    assert cf.get("level") == "low", cf
    reasons = cf.get("reasons", [])
    assert any("No transaction history" in str(x) for x in reasons), reasons
