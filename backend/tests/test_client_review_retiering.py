"""Retiering + grey Clean Up + owner-paced catch-up (2026-10).

Covers: current vs older tiering, 48h ingest grace, >30d / 2-skip
graduation to cleanup, W-9 never ages out, has_open_batch ignoring
cleanup/catchup, expire_stale_batches incrementing checkin_skips,
and the POST /owner-dashboard/catchup API idempotency.
"""
import os, sys, uuid
from datetime import datetime, timezone, timedelta

import pytest
import requests

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from tests._shared_loop import run
from deps import db
import client_review as cr


BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/")


# --- helpers ----------------------------------------------------------------

def _iso_days_ago(days: int) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()


def _date_days_ago(days: int) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=days)).date().isoformat()


async def _mk_company(cid, created_days_ago=90):
    await db.companies.insert_one({
        "id": cid, "name": "RT " + cid[-6:],
        "created_at": _iso_days_ago(created_days_ago),
        "owner_email": "owner@test.local",
    })


async def _mk_txn(cid, *, date_days, created_days, needs_review=True,
                  human_reviewed=False, client_question_id=None):
    doc = {
        "id": str(uuid.uuid4()), "company_id": cid,
        "date": _date_days_ago(date_days), "amount": -42.0,
        "description": "SQ *FOO", "merchant": "SQ *FOO",
        "needs_review": needs_review, "human_reviewed": human_reviewed,
        "client_question_id": client_question_id,
        "created_at": _iso_days_ago(created_days),
        "updated_at": _iso_days_ago(created_days),
    }
    await db.transactions.insert_one(doc)
    return doc


async def _mk_finding(cid, *, kind, txn_days_ago, checkin_skips=0, status="open"):
    doc = {
        "id": str(uuid.uuid4()), "company_id": cid,
        "kind": kind, "status": status, "batch_id": None,
        "title": kind, "detail": f"{kind} detail",
        "meta": {"txn_date": _date_days_ago(txn_days_ago)},
        "severity": "amber",
        "created_at": _iso_days_ago(min(txn_days_ago, 2)),
        "updated_at": _iso_days_ago(min(txn_days_ago, 2)),
        "checkin_skips": checkin_skips,
    }
    await db.agent_findings.insert_one(doc)
    return doc


async def _cleanup_cid(cid):
    await db.companies.delete_many({"id": cid})
    await db.transactions.delete_many({"company_id": cid})
    await db.agent_findings.delete_many({"company_id": cid})
    await db.client_review_batches.delete_many({"company_id": cid})


# ======== BACKEND UNIT ======================================================

async def _retier_flow():
    cid = f"test-{uuid.uuid4()}"
    await _mk_company(cid, 90)
    try:
        # Transactions
        txn_a = await _mk_txn(cid, date_days=3, created_days=3)   # current
        txn_b = await _mk_txn(cid, date_days=2, created_days=1)   # EXCLUDED (<48h)
        txn_c = await _mk_txn(cid, date_days=40, created_days=40) # EXCLUDED, graduates

        # Findings
        current_missing = [await _mk_finding(cid, kind="missing_receipt", txn_days_ago=4) for _ in range(5)]
        older_missing   = [await _mk_finding(cid, kind="missing_receipt", txn_days_ago=20) for _ in range(4)]
        aged_missing    = await _mk_finding(cid, kind="missing_receipt", txn_days_ago=45)
        aged_w9         = await _mk_finding(cid, kind="w9_needed",       txn_days_ago=120)
        skipped_missing = await _mk_finding(cid, kind="missing_receipt", txn_days_ago=10, checkin_skips=2)

        items = await cr.collect_batch_items(cid)
        by_src = {i["source_id"]: i for i in items}

        # Txn A in, B/C out
        assert txn_a["id"] in by_src, "txn A (3 days, 3 days ago created) should be current"
        assert by_src[txn_a["id"]].get("tier") == "current"
        assert txn_b["id"] not in by_src, "txn B within 48h grace excluded"
        assert txn_c["id"] not in by_src, "txn C >30d excluded (graduates)"

        # All 5 current missing_receipt collected (no cap on current)
        current_hit = [f for f in current_missing if f["id"] in by_src]
        assert len(current_hit) == 5, f"expected 5 current missing_receipt, got {len(current_hit)}"
        assert all(by_src[f["id"]]["tier"] == "current" for f in current_hit)

        # Older: only 2 of 4 collected, tier older
        older_hit = [f for f in older_missing if f["id"] in by_src]
        assert len(older_hit) == 2, f"expected older cap=2, got {len(older_hit)}"
        assert all(by_src[f["id"]]["tier"] == "older" for f in older_hit)

        # Aged missing (>30d) NOT collected before graduation
        assert aged_missing["id"] not in by_src

        # W-9 at 120d still collected (W-9 exception)
        assert aged_w9["id"] in by_src, "w9_needed must never age out"

        # Skipped twice -> excluded from collect
        assert skipped_missing["id"] not in by_src

        # ----- graduate ----
        moved = await cr.graduate_company_to_cleanup(cid)
        assert moved >= 3, f"expected >=3 grads (txn_c, aged_missing, skipped_missing), got {moved}"

        cleanup = await db.client_review_batches.find_one({"company_id": cid, "kind": "cleanup"})
        assert cleanup is not None
        src_ids = {i["source_id"] for i in cleanup.get("items") or []}
        assert txn_c["id"] in src_ids
        assert aged_missing["id"] in src_ids
        assert skipped_missing["id"] in src_ids
        # W-9 does NOT graduate
        assert aged_w9["id"] not in src_ids, "W-9 must not graduate"
        assert cleanup.get("graduated_total") == len(cleanup.get("items") or [])

        # Source batch_id set
        txn_c_fresh = await db.transactions.find_one({"id": txn_c["id"]})
        assert txn_c_fresh.get("batch_id") == cleanup["id"]
        aged_fresh = await db.agent_findings.find_one({"id": aged_missing["id"]})
        assert aged_fresh.get("batch_id") == cleanup["id"]
    finally:
        await _cleanup_cid(cid)


def test_retiering_and_graduate_flow():
    run(_retier_flow())


async def _has_open_batch_non_forward():
    cid = f"test-{uuid.uuid4()}"
    email = "owner@foo"
    await _mk_company(cid)
    try:
        # cleanup batch only -> False
        await db.client_review_batches.insert_one({
            "id": str(uuid.uuid4()), "company_id": cid, "client_email": email,
            "kind": "cleanup", "status": "open", "items": [], "created_at": _iso_days_ago(1),
        })
        assert await cr.has_open_batch(cid, email) is False

        await db.client_review_batches.insert_one({
            "id": str(uuid.uuid4()), "company_id": cid, "client_email": email,
            "kind": "catchup", "status": "open", "items": [], "created_at": _iso_days_ago(1),
        })
        assert await cr.has_open_batch(cid, email) is False

        # normal batch -> True
        await db.client_review_batches.insert_one({
            "id": str(uuid.uuid4()), "company_id": cid, "client_email": email,
            "status": "open", "items": [], "created_at": _iso_days_ago(1),
        })
        assert await cr.has_open_batch(cid, email) is True
    finally:
        await _cleanup_cid(cid)


def test_has_open_batch_ignores_cleanup_and_catchup():
    run(_has_open_batch_non_forward())


async def _expire_increments_skips():
    cid = f"test-{uuid.uuid4()}"
    email = "x@y"
    await _mk_company(cid)
    try:
        f = await _mk_finding(cid, kind="missing_receipt", txn_days_ago=3)
        items = await cr.collect_batch_items(cid)
        assert any(i["source_id"] == f["id"] for i in items)
        batch = await cr.create_batch(cid, email, items)
        await db.client_review_batches.update_one(
            {"id": batch["id"]}, {"$set": {"expires_at": _iso_days_ago(1)}})
        summary = await cr.expire_stale_batches()
        assert summary["expired_batches"] >= 1
        fresh = await db.agent_findings.find_one({"id": f["id"]})
        assert fresh.get("checkin_skips", 0) >= 1, f"skips not incremented: {fresh.get('checkin_skips')}"
        assert not fresh.get("batch_id"), "batch_id must be unset after expiry"
    finally:
        await _cleanup_cid(cid)


def test_expire_stale_batches_increments_checkin_skips():
    run(_expire_increments_skips())


# ======== API ===============================================================

PRO_EMAIL = "pro@axiom.ai"
PRO_PASS = "pro123"
CID = "aae4ab61-5b14-4529-a38c-fef8b747fdec"
def _forward_token(session) -> str:
    """Current forward (non-catchup) check-in token, read from the owner dashboard."""
    r = session.get(f"{BASE_URL}/api/companies/{CID}/owner-dashboard")
    href = ((r.json().get("team") or {}).get("next_checkin") or {}).get("href") or ""
    return href.rsplit("/", 1)[-1]


@pytest.fixture(scope="module")
def session():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    r = s.post(f"{BASE_URL}/api/auth/login", json={"email": PRO_EMAIL, "password": PRO_PASS})
    assert r.status_code == 200, f"login failed: {r.status_code} {r.text}"
    tok = r.json().get("token") or r.json().get("access_token")
    if tok:
        s.headers["Authorization"] = f"Bearer {tok}"
    return s


def test_api_catchup_idempotent(session):
    r1 = session.post(f"{BASE_URL}/api/companies/{CID}/owner-dashboard/catchup")
    assert r1.status_code == 200, r1.text
    d1 = r1.json()
    assert d1.get("ok") is True
    assert d1.get("review_url", "").startswith("/client-review/")
    if d1.get("batch_id"):
        assert d1.get("items", 0) <= 7
    # call again - must reuse same batch
    r2 = session.post(f"{BASE_URL}/api/companies/{CID}/owner-dashboard/catchup")
    assert r2.status_code == 200
    d2 = r2.json()
    assert d2.get("batch_id") == d1.get("batch_id"), \
        f"catchup not idempotent: {d1.get('batch_id')} vs {d2.get('batch_id')}"


def test_api_owner_dashboard_books_cleanup_and_next_checkin(session):
    r = session.get(f"{BASE_URL}/api/companies/{CID}/owner-dashboard")
    assert r.status_code == 200, r.text
    data = r.json()
    books = data.get("books") or {}
    cleanup = books.get("cleanup") or {}
    for k in ("pending", "done", "total", "in_catchup", "open_catchup_token"):
        assert k in cleanup, f"missing cleanup.{k}"
    nxt = (data.get("team") or {}).get("next_checkin")
    if nxt and nxt.get("href"):
        # must be FORWARD batch, not catchup token
        assert _forward_token(session) in nxt["href"], \
            f"next_checkin.href should be forward token, got {nxt['href']}"


def test_api_client_review_catchup_token(session):
    # pull the token first
    r = session.get(f"{BASE_URL}/api/companies/{CID}/owner-dashboard")
    assert r.status_code == 200
    token = ((r.json().get("books") or {}).get("cleanup") or {}).get("open_catchup_token")
    assert token, "no open_catchup_token in cleanup payload"
    # public endpoint — call without auth header
    r2 = requests.get(f"{BASE_URL}/api/client-review/{token}")
    assert r2.status_code == 200, r2.text
    body = r2.json()
    items = body.get("items") or (body.get("batch") or {}).get("items")
    assert items and len(items) > 0


# ======== Regression ========================================================

def test_regression_responsibilities(session):
    r = session.get(f"{BASE_URL}/api/companies/{CID}/responsibilities")
    assert r.status_code == 200, r.text


def test_regression_client_review_forward_token(session):
    r = requests.get(f"{BASE_URL}/api/client-review/{_forward_token(session)}")
    assert r.status_code == 200, r.text
