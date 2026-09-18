"""End-to-end API tests for Lab Pipeline v3 Phase 2 (contact identification).

Verifies /api/companies/{cid}/lab/summary, /lab/compare (with filters), /lab/pipeline/run?phase=2,
feature-flag isolation, and safety invariants (live counts unchanged).
"""
import os
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL").rstrip("/")
TEST519_CID = "eae0bd47-0545-4f7c-9175-d838f8d1637b"
PRO_EMAIL = "pro@axiom.ai"
PRO_PASSWORD = "pro123"


@pytest.fixture(scope="module")
def pro_session():
    s = requests.Session()
    # Try common auth endpoints
    r = s.post(f"{BASE_URL}/api/auth/login", json={"email": PRO_EMAIL, "password": PRO_PASSWORD})
    if r.status_code != 200:
        pytest.skip(f"login failed: {r.status_code} {r.text[:200]}")
    tok = r.json().get("access_token") or r.json().get("token")
    if tok:
        s.headers.update({"Authorization": f"Bearer {tok}"})
    return s


@pytest.fixture(scope="module")
def bright_beans_cid(pro_session):
    r = pro_session.get(f"{BASE_URL}/api/companies")
    assert r.status_code == 200, r.text[:200]
    data = r.json()
    companies = data if isinstance(data, list) else data.get("companies", data.get("items", []))
    for c in companies:
        name = (c.get("name") or "").lower()
        if "bright beans" in name:
            return c.get("id") or c.get("_id") or c.get("company_id")
    pytest.skip("Bright Beans company not found for the pro user")


def _get(session, path, **params):
    r = session.get(f"{BASE_URL}{path}", params=params or None)
    return r


# ---------- SUMMARY ----------
def test_summary_test519(pro_session):
    r = _get(pro_session, f"/api/companies/{TEST519_CID}/lab/summary")
    assert r.status_code == 200, r.text[:400]
    j = r.json()
    assert j.get("scanned") == 1966, f"scanned={j.get('scanned')}"
    bcs = j.get("by_contact_source") or {}
    assert bcs, "by_contact_source missing/empty"
    diffs = j.get("differences") or {}
    assert diffs.get("contact_changed", 0) > 0
    assert diffs.get("indn_derived_live_skipped", 0) >= 1
    assert (j.get("lab_new_contacts") or 0) > 0
    assert (j.get("merge_suggestions") or 0) > 0


# ---------- COMPARE (basic) ----------
def test_compare_basic(pro_session):
    r = _get(pro_session, f"/api/companies/{TEST519_CID}/lab/compare", page=1, page_size=50)
    assert r.status_code == 200, r.text[:400]
    j = r.json()
    rows = j.get("rows") or j.get("items") or []
    assert rows, "no rows"
    for row in rows[:5]:
        assert "lab" in row and "contact" in row["lab"] or "contact" in (row.get("lab") or {})
    sources = {(r.get("lab") or {}).get("contact_source") for r in rows}
    # Need to fetch more pages to find both sources; check summary distribution as backup
    assert any(sources), "no contact_source values on any row"


def test_compare_has_plaid_entity_and_skip_movement_sources(pro_session):
    # Filter directly for these sources
    found = {}
    for src in ("plaid_entity_id", "skip_movement"):
        r = _get(pro_session, f"/api/companies/{TEST519_CID}/lab/compare", contact_source=src, page_size=5)
        assert r.status_code == 200, r.text[:200]
        rows = r.json().get("rows") or r.json().get("items") or []
        found[src] = len(rows)
    assert found["plaid_entity_id"] > 0
    assert found["skip_movement"] > 0


# ---------- COMPARE (contact_changed filter) ----------
def test_compare_contact_changed_filter(pro_session):
    r = _get(pro_session, f"/api/companies/{TEST519_CID}/lab/compare", contact_changed="true", page_size=20)
    assert r.status_code == 200, r.text[:200]
    j = r.json()
    total = j.get("total") or j.get("count") or 0
    assert total >= 100, f"expected >=100, got {total}"
    for row in (j.get("rows") or j.get("items") or [])[:10]:
        diff = row.get("diff") or {}
        assert diff.get("contact_changed") is True


# ---------- COMPARE (llm_new filter) ----------
def test_compare_llm_new(pro_session):
    r = _get(pro_session, f"/api/companies/{TEST519_CID}/lab/compare", contact_source="llm_new", page_size=20)
    assert r.status_code == 200, r.text[:200]
    rows = r.json().get("rows") or r.json().get("items") or []
    for row in rows:
        lab = row.get("lab") or {}
        assert lab.get("contact_source") == "llm_new"
        assert lab.get("contact_new") is True


# ---------- PIPELINE RUN ----------
def test_pipeline_run_phase2(pro_session):
    r = pro_session.post(f"{BASE_URL}/api/companies/{TEST519_CID}/lab/pipeline/run", params={"phase": 2})
    assert r.status_code == 200, r.text[:400]
    j = r.json()
    assert j.get("ok") is True
    step5 = j.get("step5") or {}
    assert step5.get("source_distribution") is not None
    assert "enrich" in j or "enrich_stats" in j or step5.get("enrich") is not None
    assert "llm" in j or "llm_stats" in j or step5.get("llm") is not None


# ---------- FEATURE FLAG ISOLATION ----------
def test_feature_flag_off_for_bright_beans(pro_session, bright_beans_cid):
    r = _get(pro_session, f"/api/companies/{bright_beans_cid}/lab/summary")
    assert r.status_code == 403, f"expected 403, got {r.status_code} {r.text[:200]}"
    body = (r.text or "").lower()
    assert "lab_pipeline_v3" in body or "feature flag" in body or "flag" in body


# ---------- SAFETY: LIVE COUNTS UNCHANGED ----------
def test_live_contacts_count_unchanged(pro_session):
    # /api/contacts doesn't exist as a top-level endpoint; verify via direct DB read for safety.
    import asyncio
    from motor.motor_asyncio import AsyncIOMotorClient
    async def _check():
        c = AsyncIOMotorClient(os.environ["MONGO_URL"])
        db = c[os.environ["DB_NAME"]]
        contacts = await db.contacts.count_documents({"company_id": TEST519_CID})
        txns = await db.transactions.count_documents({"company_id": TEST519_CID})
        lab_contacts = await db.lab_contacts.count_documents({"company_id": TEST519_CID})
        enrich = await db.lab_enrich_cache.count_documents({})
        llm = await db.lab_llm_cache.count_documents({})
        return contacts, txns, lab_contacts, enrich, llm
    contacts, txns, lab_contacts, enrich, llm = asyncio.run(_check())
    assert contacts == 208, f"LIVE contacts count changed! got {contacts}"
    assert txns == 1966, f"LIVE transactions count changed! got {txns}"
    assert lab_contacts > 0, "lab_contacts empty"
    assert enrich > 0, "lab_enrich_cache empty"
    assert llm > 0, "lab_llm_cache empty"


# ---------- INDN-derived-live detection ----------
def test_indn_derived_matches_summary(pro_session):
    s = _get(pro_session, f"/api/companies/{TEST519_CID}/lab/summary")
    summary_count = ((s.json().get("differences") or {}).get("indn_derived_live_skipped") or 0)
    # Try dedicated filter first
    r = _get(pro_session, f"/api/companies/{TEST519_CID}/lab/compare",
             contact_source="indn_derived_live_skipped", page_size=1)
    if r.status_code == 200:
        total = r.json().get("total")
        if total is not None and total > 0:
            assert total == summary_count
