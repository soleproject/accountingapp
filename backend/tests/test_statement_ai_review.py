# AI Review (GPT-4o) statement engine: upload → poll → detail → xlsx export → approve/reject gate
# Live GPT-4o upload is cached in /tmp/ai_review_state.json to avoid re-running (costs money).
# RUN SERIALLY: pytest -p no:xdist tests/test_statement_ai_review.py  (xdist workers each trigger an upload)
# Cleanup: DELETE /api/companies/{cid}?confirm=<name> for the TEST_AIReview company afterwards.
import io
import json
import os
import time
import uuid

import pytest
import requests
from pymongo import MongoClient

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL").rstrip("/")
MONGO_URL = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
DB_NAME = os.environ.get("DB_NAME", "test_database")
FIXTURE = "/app/backend/tests/fixtures/mercury_2024-10-06.pdf"
STATE = "/tmp/ai_review_state.json"


@pytest.fixture(scope="module")
def client():
    s = requests.Session()
    r = s.post(f"{BASE_URL}/api/auth/login", json={"email": "pro@axiom.ai", "password": "pro123"})
    if r.status_code != 200:
        pytest.skip("login failed")
    s.headers.update({"Authorization": f"Bearer {r.json()['token']}"})
    return s


@pytest.fixture(scope="module")
def mdb():
    return MongoClient(MONGO_URL)[DB_NAME]


@pytest.fixture(scope="module")
def completed(client):
    """Upload once (cached), poll until terminal."""
    if os.path.exists(STATE):
        st = json.load(open(STATE))
    else:
        r = client.post(f"{BASE_URL}/api/companies", json={"name": f"TEST_AIReview {uuid.uuid4().hex[:6]}"})
        assert r.status_code in (200, 201), r.text
        cid = r.json().get("company_id") or r.json().get("id")
        with open(FIXTURE, "rb") as f:
            up = client.post(f"{BASE_URL}/api/companies/{cid}/statements/upload",
                             files={"file": ("mercury_2024-10-06.pdf", f, "application/pdf")},
                             data={"engine": "ai_review", "account_kind_hint": "liability"})
        assert up.status_code == 200, up.text
        body = up.json()
        assert body["status"] == "processing" and body["method"] == "ai_review" and body["import_id"]
        st = {"cid": cid, "iid": body["import_id"], "stages": []}
        json.dump(st, open(STATE, "w"))
    cid, iid = st["cid"], st["iid"]
    deadline = time.time() + 200
    row = None
    while time.time() < deadline:
        rows = client.get(f"{BASE_URL}/api/companies/{cid}/statements/imports").json()
        rows = rows.get("items", rows.get("imports", rows)) if isinstance(rows, dict) else rows
        row = next((x for x in rows if x["id"] == iid), None)
        if row:
            stg = row.get("ai_stage")
            if stg and (not st["stages"] or st["stages"][-1] != stg):
                st["stages"].append(stg)
            if row["status"] in ("completed", "failed", "needs_review"):
                break
        time.sleep(6)
    json.dump(st, open(STATE, "w"))
    print("stages:", st["stages"], "row:", {k: row.get(k) for k in ("status", "transaction_count", "account_name", "period_start", "period_end", "error")} if row else None)
    return {**st, "row": row}


class TestAIUpload:
    def test_completed_row(self, completed):
        row = completed["row"]
        assert row is not None
        assert row["status"] == "completed", row
        assert row["method"] == "ai_review"
        assert row["transaction_count"] == 166
        assert "Mercury" in (row.get("account_name") or "")
        assert row["period_start"] == "2024-09-07"
        assert row["period_end"] == "2024-10-06"

    def test_detail(self, client, completed):
        r = client.get(f"{BASE_URL}/api/companies/{completed['cid']}/statements/imports/{completed['iid']}")
        assert r.status_code == 200
        d = r.json()
        assert "ai_doc" not in d
        tx = d["transactions"]
        assert len(tx) == 166
        amts = [float(t["amount"]) for t in tx]
        print("sum", round(sum(amts), 2), "neg", sum(a < 0 for a in amts), "pos", sum(a > 0 for a in amts))
        assert abs(sum(amts) - 79.91) < 0.02
        assert sum(a < 0 for a in amts) == 155 and sum(a > 0 for a in amts) == 11
        assert d["ai_review"]["reconciliation"]["ties"] is True
        assert len(d["ai_rows"]) == 166
        refs = [t.get("reference") for t in tx if t.get("reference")]
        print("refs sample", refs[:5], "sources", {t.get("source") for t in tx})
        assert refs, "no transactions carry reference"
        assert any(t.get("source") == "ai_review" for t in tx)

    def test_export_xlsx(self, client, completed):
        from openpyxl import load_workbook
        r = client.get(f"{BASE_URL}/api/companies/{completed['cid']}/statements/imports/{completed['iid']}/export.xlsx")
        assert r.status_code == 200
        assert "spreadsheetml" in r.headers["content-type"]
        wb = load_workbook(io.BytesIO(r.content))
        assert wb.sheetnames == ["Summary", "All Transactions", "Withdrawals", "Deposits"]
        assert wb["All Transactions"].max_row == 167
        assert wb["Withdrawals"].max_row == 156
        assert wb["Deposits"].max_row == 12

    def test_export_404(self, client, completed):
        r = client.get(f"{BASE_URL}/api/companies/{completed['cid']}/statements/imports/nope/export.xlsx")
        assert r.status_code == 404


def _clone(mdb, completed):
    src = mdb.statement_imports.find_one({"id": completed["iid"]})
    assert src and src.get("ai_doc")
    src.pop("_id")
    nid = f"TEST_held_{uuid.uuid4().hex[:8]}"
    src.update({"id": nid, "status": "needs_review", "ai_stage": "needs_review", "filename": f"{nid}.pdf"})
    src["ai_review"]["reconciliation"]["ties"] = False
    mdb.statement_imports.insert_one(src)
    return nid


class TestReviewGate:
    created = []

    def test_approve_completed_400(self, client, completed):
        r = client.post(f"{BASE_URL}/api/companies/{completed['cid']}/statements/imports/{completed['iid']}/approve")
        assert r.status_code == 400

    def test_approve_held(self, client, mdb, completed):
        cid = completed["cid"]
        # delete the original's txns so dedupe guards don't skip the clone's rows
        nid = _clone(mdb, completed)
        TestReviewGate.created.append(nid)
        r = client.post(f"{BASE_URL}/api/companies/{cid}/statements/imports/{nid}/approve")
        print("approve", r.status_code, r.text[:300])
        assert r.status_code == 200
        row = mdb.statement_imports.find_one({"id": nid})
        print("after approve", row["status"], row.get("transaction_count"), row.get("ai_stage"))
        assert row["status"] == "completed"
        assert row["transaction_count"] == 166
        r2 = client.post(f"{BASE_URL}/api/companies/{cid}/statements/imports/{nid}/approve")
        assert r2.status_code == 400
        assert "not waiting for review" in r2.text

    def test_reject_held(self, client, mdb, completed):
        cid = completed["cid"]
        nid = _clone(mdb, completed)
        TestReviewGate.created.append(nid)
        r = client.post(f"{BASE_URL}/api/companies/{cid}/statements/imports/{nid}/reject")
        assert r.status_code == 200
        assert r.json()["status"] == "rejected"
        assert mdb.transactions.count_documents({"statement_import_id": nid}) == 0
        r2 = client.post(f"{BASE_URL}/api/companies/{cid}/statements/imports/{nid}/reject")
        assert r2.status_code == 400

    def test_cleanup(self, client, completed):
        for nid in TestReviewGate.created:
            r = client.delete(f"{BASE_URL}/api/companies/{completed['cid']}/statements/imports/{nid}?cascade=true")
            assert r.status_code == 200


class TestVeryfiRouting:
    def test_veryfi_default(self, client, completed):
        with open(FIXTURE, "rb") as f:
            r = client.post(f"{BASE_URL}/api/companies/{completed['cid']}/statements/upload",
                            files={"file": ("veryfi_route.pdf", f, "application/pdf")},
                            data={"engine": "veryfi", "account_kind_hint": "liability"}, timeout=180)
        print("veryfi", r.status_code, r.text[:300])
        assert r.status_code in (200, 502, 400, 409)
        if r.status_code == 200:
            assert r.json().get("method") != "ai_review"
