"""Iteration 20 tests:
 1) Webhook dedup on concurrent SYNC_UPDATES_AVAILABLE for same item_id
 2) plaid_connect.categorize_and_insert_plaid_txns merchant_name fallback
    → all inserted docs get contact_id, contacts collection grows
 3) Regression: 535 LLC data spot check via API
"""
import asyncio
import os
import uuid
import time
import pytest
import requests
from concurrent.futures import ThreadPoolExecutor

from pymongo import MongoClient

from dotenv import load_dotenv
load_dotenv("/app/backend/.env")
load_dotenv("/app/frontend/.env")

BASE_URL = os.environ["REACT_APP_BACKEND_URL"].rstrip("/")
MONGO_URL = os.environ["MONGO_URL"]
DB_NAME = os.environ["DB_NAME"]

CID_535 = "d566590e-0224-4fb3-a1dd-41add444309b"
ITEM_ID_535 = "z13yxXar1XhdaXdzQ17Jc1aObOj8KOHAK36mP"


@pytest.fixture(scope="module")
def mdb():
    c = MongoClient(MONGO_URL)
    yield c[DB_NAME]
    c.close()


@pytest.fixture(scope="module")
def token():
    r = requests.post(f"{BASE_URL}/api/auth/login",
                      json={"email": "pro@axiom.ai", "password": "pro123"}, timeout=10)
    assert r.status_code == 200, r.text
    return r.json()["token"]


# ---------------- 1) Concurrent webhook dedup ----------------

def _fire_webhook(item_id):
    return requests.post(
        f"{BASE_URL}/api/plaid/webhook",
        json={"webhook_type": "TRANSACTIONS",
              "webhook_code": "SYNC_UPDATES_AVAILABLE",
              "item_id": item_id},
        timeout=10,
    )


def test_concurrent_webhook_dedups_to_one_job(mdb):
    item_id = ITEM_ID_535
    # Ensure no running job blocks us — but we WANT one queued/running to
    # dedup against; the first hit will insert it. Snapshot before.
    # Clear any lingering active jobs from prior tests for a clean baseline.
    mdb.sync_jobs.update_many(
        {"company_id": CID_535, "kind": "plaid_manual_sync",
         "status": {"$in": ["queued", "running"]}},
        {"$set": {"status": "completed"}},
    )
    before = mdb.sync_jobs.count_documents({
        "company_id": CID_535, "kind": "plaid_manual_sync",
    })

    N = 5
    with ThreadPoolExecutor(max_workers=N) as ex:
        futs = [ex.submit(_fire_webhook, item_id) for _ in range(N)]
        responses = [f.result() for f in futs]

    for r in responses:
        assert r.status_code == 200, r.text
    bodies = [r.json() for r in responses]
    for b in bodies:
        assert b.get("ok") is True
        assert b.get("webhook_code") == "SYNC_UPDATES_AVAILABLE"
        assert "queued_job" in b, b

    job_ids = {b["queued_job"] for b in bodies}
    dedup_flags = [b.get("dedup") for b in bodies]

    # All should point at the same job id
    assert len(job_ids) == 1, f"expected 1 unique queued_job id, got {job_ids}"
    # At least N-1 should carry dedup:true (one may slip through the ~1ms race)
    assert sum(1 for d in dedup_flags if d is True) >= N - 1, dedup_flags

    time.sleep(0.4)
    after = mdb.sync_jobs.count_documents({
        "company_id": CID_535, "kind": "plaid_manual_sync",
    })
    # Exactly ONE new sync_jobs row inserted despite N concurrent webhooks
    assert after - before == 1, (
        f"expected exactly 1 new sync_jobs row, got {after - before} "
        f"(before={before}, after={after})"
    )


# ---------------- 2) merchant_name fallback unit test ----------------

@pytest.mark.asyncio
async def test_merchant_name_fallback_creates_contacts(mdb):
    """Emulate Plaid txns with merchant_name=None but name='AT&T' etc.
    After pipeline: every inserted txn carries a contact_id and contacts
    collection grew by the number of unique merchants.
    """
    import sys
    sys.path.insert(0, "/app/backend")
    from db import db, now_iso
    import plaid_connect

    cid = f"test-iter20-{uuid.uuid4()}"
    now = now_iso()
    # minimal CoA
    for code, name, t, st in [
        ("1010", "Business Checking", "asset", "current_asset"),
        ("9999", "Uncategorized", "expense", "operating_expense"),
    ]:
        await db.accounts.insert_one({
            "id": str(uuid.uuid4()), "company_id": cid,
            "code": code, "name": name, "type": t, "subtype": st,
            "created_at": now, "updated_at": now,
        })
    await db.companies.insert_one({
        "id": cid, "name": "TestCo20", "created_at": now, "updated_at": now,
    })
    ledger_bank = await db.accounts.find_one({"company_id": cid, "code": "1010"})

    unique_merchants = ["AT&T", "Audi", "Costco", "Starbucks", "Uber"]
    plaid_txns = []
    for i, m in enumerate(unique_merchants * 2):  # 10 txns, 5 unique merchants
        plaid_txns.append({
            "transaction_id": f"t20-{i}-{uuid.uuid4().hex[:8]}",
            "account_id": "pl_chk_20",
            "date": "2026-01-05",
            "name": m,
            "merchant_name": None,     # <- the bug scenario
            "amount": -12.34 - i,
            "pending": False,
            "personal_finance_category": None,
        })

    async def _fake_categorize(merchant, amount, desc, coa, pfc=None):
        return {"account_code": "9999", "confidence": 0.5,
                "reasoning": "test", "needs_review": True}

    async def _period_closed(cid_, d):
        return False

    async def _ai_should_not_be_called(*a, **kw):
        raise AssertionError("AI contact resolver should not be invoked when "
                             "merchant fallback is in place")

    # Patch resolve_contact_ai to detect regression
    import ai_service
    original_ai = ai_service.resolve_contact_ai
    ai_service.resolve_contact_ai = _ai_should_not_be_called
    try:
        contacts_before = await db.contacts.count_documents({"company_id": cid})
        inserted, skipped = await plaid_connect.categorize_and_insert_plaid_txns(
            cid, plaid_txns, ledger_bank,
            coa=[{"code": "9999", "name": "Uncategorized", "type": "expense"}],
            accts=[ledger_bank],
            categorize_fn=_fake_categorize,
            is_period_closed_fn=_period_closed,
        )
        assert len(inserted) == len(plaid_txns), f"expected {len(plaid_txns)}, got {len(inserted)}"
        missing_contact = [d for d in inserted if not d.get("contact_id")]
        assert not missing_contact, (
            f"{len(missing_contact)}/{len(inserted)} inserted docs missing contact_id "
            f"(sample: {missing_contact[:2]})"
        )
        # Contact_name should match the merchant name (from fallback)
        merchants_in_docs = {d["merchant"] for d in inserted}
        assert merchants_in_docs == set(unique_merchants), merchants_in_docs

        contacts_after = await db.contacts.count_documents({"company_id": cid})
        assert contacts_after - contacts_before == len(unique_merchants), (
            f"expected {len(unique_merchants)} new contacts, "
            f"got {contacts_after - contacts_before}"
        )
    finally:
        ai_service.resolve_contact_ai = original_ai
        await db.contacts.delete_many({"company_id": cid})
        await db.transactions.delete_many({"company_id": cid})
        await db.accounts.delete_many({"company_id": cid})
        await db.companies.delete_one({"id": cid})


# ---------------- 3) 535 LLC backfill regression via API ----------------

def test_535_llc_backfill_and_dashboard(token, mdb):
    h = {"Authorization": f"Bearer {token}"}
    # Contacts count
    r = requests.get(f"{BASE_URL}/api/companies/{CID_535}/contacts",
                     headers=h, timeout=15)
    assert r.status_code == 200, r.text
    body = r.json()
    contacts = body if isinstance(body, list) else body.get("contacts") or body
    if isinstance(contacts, dict):
        contacts = contacts.get("contacts") or []
    assert len(contacts) == 501, f"expected 501 contacts, got {len(contacts)}"

    # Transaction spot check: >=95% have contact_id + contact_name
    r = requests.get(f"{BASE_URL}/api/companies/{CID_535}/transactions?page=1&limit=20",
                     headers=h, timeout=20)
    assert r.status_code == 200, r.text
    body = r.json()
    txns = body.get("transactions") if isinstance(body, dict) else body
    if not isinstance(txns, list):
        txns = body.get("items") or []
    assert len(txns) >= 15, f"expected >=15 rows, got {len(txns)}"
    with_cid = sum(1 for t in txns if t.get("contact_id"))
    with_name = sum(1 for t in txns if t.get("contact_name"))
    assert with_cid / len(txns) >= 0.95, f"contact_id coverage {with_cid}/{len(txns)}"
    assert with_name / len(txns) >= 0.95, f"contact_name coverage {with_name}/{len(txns)}"

    # Dashboard sync status regression: idle
    r = requests.get(f"{BASE_URL}/api/companies/{CID_535}/sync-status",
                     headers=h, timeout=10)
    assert r.status_code == 200, r.text
    ss = r.json()
    assert ss.get("status") in ("idle", "completed", None), f"unexpected: {ss}"

    # Dashboard tiles endpoint (cash on hand + txn counts) — verify non-zero
    # Use financials/summary or transactions?limit=1 to confirm txn count
    r = requests.get(f"{BASE_URL}/api/companies/{CID_535}/transactions?page=1&limit=1",
                     headers=h, timeout=20)
    assert r.status_code == 200
    body = r.json()
    total = body.get("total") if isinstance(body, dict) else None
    if total is not None:
        assert total == 1871, f"expected 1871 total txns, got {total}"
