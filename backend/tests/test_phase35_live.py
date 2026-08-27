"""Phase 3.5 live-HTTP smoke against the deployed backend.

Uses REACT_APP_BACKEND_URL, logs in as pro@axiom.ai (manages Bright Beans
Coffee Co.), then exercises the new /documents endpoint + doc-linking
against the existing seed project.
"""
from __future__ import annotations

import os
import uuid
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/")
if not BASE_URL:
    # fall back to reading the frontend .env directly
    try:
        with open("/app/frontend/.env") as fh:
            for line in fh:
                if line.startswith("REACT_APP_BACKEND_URL="):
                    BASE_URL = line.split("=", 1)[1].strip().rstrip("/")
                    break
    except FileNotFoundError:
        pass

CID = "1829a9eb-7df2-4a31-afcf-7e50a514da7e"  # Bright Beans Coffee Co.
PID = "a0c6f251-ada5-4006-bd42-1af1269889e3"  # Project #1

EMAIL = "pro@axiom.ai"
PASSWORD = "pro123"


@pytest.fixture(scope="module")
def token() -> str:
    assert BASE_URL, "REACT_APP_BACKEND_URL missing"
    r = requests.post(
        f"{BASE_URL}/api/auth/login",
        json={"email": EMAIL, "password": PASSWORD},
        timeout=30,
    )
    assert r.status_code == 200, r.text
    return r.json()["token"]


def _h(t: str) -> dict:
    return {"Authorization": f"Bearer {t}", "Content-Type": "application/json"}


def _fetch_project(token: str) -> dict:
    r = requests.get(
        f"{BASE_URL}/api/companies/{CID}/projects",
        headers=_h(token), timeout=30)
    assert r.status_code == 200, r.text
    for p in (r.json().get("projects") or r.json() or []):
        if p.get("id") == PID:
            return p
    raise AssertionError(f"Project {PID} not found in list")


def test_project_exists(token):
    p = _fetch_project(token)
    assert p["id"] == PID


def test_project_documents_endpoint_shape(token):
    r = requests.get(
        f"{BASE_URL}/api/companies/{CID}/projects/{PID}/documents",
        headers=_h(token), timeout=30)
    assert r.status_code == 200, r.text
    body = r.json()
    assert "documents" in body and "count" in body
    assert isinstance(body["documents"], list)
    assert body["count"] == len(body["documents"])
    for d in body["documents"]:
        assert {"id", "kind", "number", "date", "contact_name",
                "total", "balance_due", "status", "phase_id"} <= set(d.keys())
        assert d["kind"] in ("estimate", "invoice", "bill", "receipt")
    # sorted by date desc
    dates = [d["date"] for d in body["documents"] if d["date"]]
    assert dates == sorted(dates, reverse=True)


def test_project_documents_unknown_project_404(token):
    r = requests.get(
        f"{BASE_URL}/api/companies/{CID}/projects/does-not-exist/documents",
        headers=_h(token), timeout=30)
    assert r.status_code == 404


def test_patch_project_dates(token):
    r = requests.patch(
        f"{BASE_URL}/api/companies/{CID}/projects/{PID}",
        headers=_h(token),
        json={"start_date": "2026-01-15", "end_date": "2026-12-31"},
        timeout=30)
    assert r.status_code == 200, r.text
    proj = r.json().get("project") or r.json()
    assert proj.get("start_date") == "2026-01-15"
    assert proj.get("end_date") == "2026-12-31"
    # Confirm via list.
    p = _fetch_project(token)
    assert p.get("start_date") == "2026-01-15"
    assert p.get("end_date") == "2026-12-31"


def _get_or_create_contact(token: str, proj: dict) -> tuple[str, str]:
    cid_ = proj.get("contact_id")
    name = proj.get("contact_name")
    if cid_:
        return cid_, name or "Acme Corp"
    # fall back to first customer contact.
    r = requests.get(
        f"{BASE_URL}/api/companies/{CID}/contacts",
        headers=_h(token), timeout=30)
    if r.status_code == 200:
        for c in (r.json().get("contacts") or r.json() or []):
            if (c.get("type") or "customer") in ("customer", None):
                return c["id"], c.get("name") or "Test"
    # create one.
    r = requests.post(
        f"{BASE_URL}/api/companies/{CID}/contacts",
        headers=_h(token),
        json={"name": f"TEST_p35_{uuid.uuid4().hex[:6]}",
              "type": "customer"}, timeout=30)
    assert r.status_code == 200, r.text
    body = r.json()
    c = body.get("contact") or body
    return c["id"], c["name"]


def test_invoice_with_project_id_persists_and_appears_in_documents(token):
    proj = _fetch_project(token)
    contact_id, contact_name = _get_or_create_contact(token, proj)

    marker = f"TEST_phase35_{uuid.uuid4().hex[:8]}"
    payload = {
        "contact_id": contact_id,
        "contact_name": contact_name,
        "issue_date": "2026-03-20",
        "due_date": "2026-04-20",
        "line_items": [{"description": marker,
                        "quantity": 1, "rate": 111.11, "amount": 111.11}],
        "project_id": PID,
    }
    r = requests.post(
        f"{BASE_URL}/api/companies/{CID}/invoices",
        headers=_h(token), json=payload, timeout=30)
    assert r.status_code == 200, r.text
    iid = r.json().get("id") or r.json().get("invoice", {}).get("id")
    assert iid

    # Should now show up in /documents.
    r = requests.get(
        f"{BASE_URL}/api/companies/{CID}/projects/{PID}/documents",
        headers=_h(token), timeout=30)
    assert r.status_code == 200
    doc_ids = {d["id"] for d in r.json()["documents"] if d["kind"] == "invoice"}
    assert iid in doc_ids

    # PATCH clears project_id.
    r = requests.patch(
        f"{BASE_URL}/api/companies/{CID}/invoices/{iid}",
        headers=_h(token), json={"project_id": None}, timeout=30)
    assert r.status_code == 200, r.text

    r = requests.get(
        f"{BASE_URL}/api/companies/{CID}/projects/{PID}/documents",
        headers=_h(token), timeout=30)
    doc_ids = {d["id"] for d in r.json()["documents"] if d["kind"] == "invoice"}
    assert iid not in doc_ids

    # PATCH re-links.
    r = requests.patch(
        f"{BASE_URL}/api/companies/{CID}/invoices/{iid}",
        headers=_h(token), json={"project_id": PID}, timeout=30)
    assert r.status_code == 200
    r = requests.get(
        f"{BASE_URL}/api/companies/{CID}/projects/{PID}/documents",
        headers=_h(token), timeout=30)
    doc_ids = {d["id"] for d in r.json()["documents"] if d["kind"] == "invoice"}
    assert iid in doc_ids


def test_bill_with_project_id_persists(token):
    proj = _fetch_project(token)
    contact_id, contact_name = _get_or_create_contact(token, proj)

    payload = {
        "contact_id": contact_id,
        "contact_name": contact_name,
        "issue_date": "2026-03-21",
        "due_date": "2026-04-21",
        "line_items": [{"description": "TEST_phase35_bill",
                        "quantity": 1, "rate": 42.42, "amount": 42.42}],
        "project_id": PID,
    }
    r = requests.post(
        f"{BASE_URL}/api/companies/{CID}/bills",
        headers=_h(token), json=payload, timeout=30)
    assert r.status_code == 200, r.text
    bid = r.json().get("id") or r.json().get("bill", {}).get("id")

    r = requests.get(
        f"{BASE_URL}/api/companies/{CID}/projects/{PID}/documents",
        headers=_h(token), timeout=30)
    bill_ids = {d["id"] for d in r.json()["documents"] if d["kind"] == "bill"}
    assert bid in bill_ids


def test_estimate_with_project_id_persists(token):
    proj = _fetch_project(token)
    contact_id, contact_name = _get_or_create_contact(token, proj)

    payload = {
        "contact_id": contact_id,
        "contact_name": contact_name,
        "issue_date": "2026-03-22",
        "line_items": [{"description": "TEST_phase35_est",
                        "quantity": 1, "rate": 999, "amount": 999}],
        "project_id": PID,
    }
    r = requests.post(
        f"{BASE_URL}/api/companies/{CID}/estimates",
        headers=_h(token), json=payload, timeout=30)
    assert r.status_code == 200, r.text
    eid = r.json().get("id") or r.json().get("estimate", {}).get("id")

    r = requests.get(
        f"{BASE_URL}/api/companies/{CID}/projects/{PID}/documents",
        headers=_h(token), timeout=30)
    est_ids = {d["id"] for d in r.json()["documents"] if d["kind"] == "estimate"}
    assert eid in est_ids


def test_phase_dates_patch(token):
    # List phases for project.
    r = requests.get(
        f"{BASE_URL}/api/companies/{CID}/projects/{PID}/phases",
        headers=_h(token), timeout=30)
    assert r.status_code == 200, r.text
    phases = r.json().get("phases") or r.json()
    assert phases, "project must have at least one phase (seed 'Test phase')"
    phid = phases[0]["id"]

    r = requests.patch(
        f"{BASE_URL}/api/companies/{CID}/projects/{PID}/phases/{phid}",
        headers=_h(token),
        json={"start_date": "2026-02-01", "end_date": "2026-03-01"},
        timeout=30)
    assert r.status_code == 200, r.text
    ph = r.json().get("phase") or r.json()
    assert ph.get("start_date") == "2026-02-01"
    assert ph.get("end_date") == "2026-03-01"
