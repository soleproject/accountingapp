"""Iteration 11 backend tests — verifies the three concurrent-webhook / dedup fixes:
  1. UNIQUE partial index (company_id, plaid_transaction_id) → 2nd insert raises E11000
  2. merchant_cache.upsert rejects low-confidence LLM writes (insert AND update paths)
  3. server._sync_and_import processes synced['removed'] to delete stale pending txns
  4. server._categorize_and_insert swallows DuplicateKeyError so partial batches land
Plus regression on 355 LLC + core endpoints.

Async tests are wrapped with a single shared event loop because motor's
AsyncIOMotorClient in db.py is bound to the loop at import time.
"""
import asyncio
import os
import sys
import uuid
import pytest
import requests

sys.path.insert(0, "/app/backend")

from db import db  # noqa: E402
import merchant_cache as mc  # noqa: E402
import server as srv  # noqa: E402
import plaid_service  # noqa: E402
from pymongo.errors import DuplicateKeyError  # noqa: E402


def _load_backend_url():
    v = os.environ.get("REACT_APP_BACKEND_URL")
    if v:
        return v.rstrip("/")
    try:
        with open("/app/frontend/.env") as f:
            for line in f:
                if line.startswith("REACT_APP_BACKEND_URL="):
                    return line.split("=", 1)[1].strip().rstrip("/")
    except FileNotFoundError:
        pass
    raise RuntimeError("REACT_APP_BACKEND_URL not set")


BASE_URL = _load_backend_url()
COMPANY_355 = "5f744222-ac09-4724-b48a-733e09952c36"

# One shared event loop bound to motor's client (which was created at import time
# in db.py against whatever loop was current then). Reusing it avoids the
# "Event loop is closed" error that pytest-asyncio's per-test loop causes.
_LOOP = asyncio.new_event_loop()
asyncio.set_event_loop(_LOOP)


def run(coro):
    return _LOOP.run_until_complete(coro)


# ============ 1. Unique partial index =========================================
def test_unique_partial_index_exists_and_enforces():
    async def go():
        info = await db.transactions.index_information()
        assert "company_plaid_txn_uniq" in info, f"missing index; have: {list(info.keys())}"
        spec = info["company_plaid_txn_uniq"]
        assert spec.get("unique") is True, spec
        pfe = spec.get("partialFilterExpression")
        assert pfe == {"plaid_transaction_id": {"$type": "string"}}, pfe

        cid = f"test-idx-{uuid.uuid4()}"
        pid = f"pid-{uuid.uuid4()}"
        d1 = {"id": str(uuid.uuid4()), "company_id": cid,
              "plaid_transaction_id": pid, "amount": 1.0, "date": "2025-01-01"}
        d2 = {"id": str(uuid.uuid4()), "company_id": cid,
              "plaid_transaction_id": pid, "amount": 2.0, "date": "2025-01-02"}
        try:
            await db.transactions.insert_one(d1)
            raised = False
            try:
                await db.transactions.insert_one(d2)
            except DuplicateKeyError as e:
                raised = True
                assert "E11000" in str(e) or "duplicate" in str(e).lower()
            assert raised, "second insert should have raised DuplicateKeyError"
        finally:
            await db.transactions.delete_many({"company_id": cid})
    run(go())


# ============ 2. merchant_cache low-confidence LLM guard ======================
def test_merchant_cache_rejects_low_conf_llm_on_insert():
    async def go():
        cid = f"test-mc-lowconf-{uuid.uuid4()}"
        try:
            await mc.upsert(cid, "FooBar", "6800", "X", 0.75, source="llm")
            hit = await mc.lookup(cid, "FooBar")
            assert hit is None, f"low-conf LLM should NOT seed cache, got: {hit}"
        finally:
            await db.merchant_cache.delete_many({"company_id": cid})
    run(go())


def test_merchant_cache_rejects_low_conf_llm_on_update_and_user_authoritative():
    async def go():
        cid = f"test-mc-upd-{uuid.uuid4()}"
        try:
            # 1) High-conf LLM seeds cache
            await mc.upsert(cid, "FooBar", "6800", "Office", 0.92, source="llm")
            hit = await mc.lookup(cid, "FooBar")
            assert hit and hit["account_code"] == "6800"
            assert abs(hit["confidence"] - 0.92) < 0.001

            # 2) Low-conf LLM must NOT overwrite
            await mc.upsert(cid, "FooBar", "9999", "Ask", 0.70, source="llm")
            hit = await mc.lookup(cid, "FooBar")
            assert hit["account_code"] == "6800", "low-conf LLM overwrote existing"

            # 3) User @ 1.0 overwrites (authoritative)
            await mc.upsert(cid, "FooBar", "6110", "Meals", 1.0, source="user")
            hit = await mc.lookup(cid, "FooBar")
            assert hit["account_code"] == "6110"
            assert hit["cache_source"] == "user"

            # 4) LLM @ 0.99 cannot override user
            await mc.upsert(cid, "FooBar", "8888", "Other", 0.99, source="llm")
            hit = await mc.lookup(cid, "FooBar")
            assert hit["account_code"] == "6110", "user override was overwritten"
        finally:
            await db.merchant_cache.delete_many({"company_id": cid})
    run(go())


# ============ 3. _sync_and_import processes `removed` =========================
def test_sync_and_import_deletes_removed_txns(monkeypatch):
    async def go():
        cid = f"test-remove-{uuid.uuid4()}"
        acct = {"id": str(uuid.uuid4()), "company_id": cid, "code": "1010",
                "name": "Test Bank", "type": "asset"}
        await db.accounts.insert_one(acct)

        pre_txn = {"id": str(uuid.uuid4()), "company_id": cid,
                   "plaid_transaction_id": "pid-x", "amount": 10.0,
                   "date": "2025-06-01", "description": "old pending"}
        await db.transactions.insert_one(pre_txn)

        item = {"id": str(uuid.uuid4()), "company_id": cid,
                "access_token": "fake", "cursor": None, "account_mappings": {}}
        await db.plaid_items.insert_one(item)

        def fake_sync(access_token, cursor):
            return {"added": [], "modified": [],
                    "removed": [{"transaction_id": "pid-x"}],
                    "next_cursor": "c1"}

        monkeypatch.setattr(plaid_service, "sync_transactions", fake_sync)
        monkeypatch.setattr(srv.plaid_service, "sync_transactions", fake_sync)

        try:
            imported = await srv._sync_and_import(cid, item)
            assert imported == 0
            gone = await db.transactions.find_one(
                {"company_id": cid, "plaid_transaction_id": "pid-x"})
            assert gone is None, "removed txn was not deleted"
        finally:
            await db.transactions.delete_many({"company_id": cid})
            await db.accounts.delete_many({"company_id": cid})
            await db.plaid_items.delete_many({"company_id": cid})
    run(go())


# ============ 4. _categorize_and_insert survives DuplicateKeyError ============
def test_categorize_and_insert_survives_duplicate(monkeypatch):
    async def go():
        cid = f"test-dup-{uuid.uuid4()}"
        acct = {"id": str(uuid.uuid4()), "company_id": cid, "code": "1010",
                "name": "Test Bank", "type": "asset"}
        uncat_exp = {"id": str(uuid.uuid4()), "company_id": cid, "code": "6999",
                     "name": "Uncategorized Expense", "type": "expense"}
        uncat_inc = {"id": str(uuid.uuid4()), "company_id": cid, "code": "4999",
                     "name": "Uncategorized Income", "type": "revenue"}
        await db.accounts.insert_many([acct, uncat_exp, uncat_inc])

        # Pre-insert X so it collides with the batch
        pre = {"id": str(uuid.uuid4()), "company_id": cid,
               "plaid_transaction_id": "X", "amount": 5.0,
               "date": "2025-06-01", "description": "prior",
               "bank_account_id": acct["id"]}
        await db.transactions.insert_one(pre)

        accts = await db.accounts.find({"company_id": cid}).to_list(100)
        coa = [{"code": a["code"], "name": a["name"], "type": a["type"]} for a in accts]

        import categorizer
        import contact_resolver

        async def fake_cat(cid_, cands, coa_, llm_fn, concurrency=10):
            return [{"account_code": "6999", "confidence": 0.9, "reasoning": "t",
                     "needs_review": False, "cache_hit": False} for _ in cands]

        async def fake_contacts(cid_, cands, ai_fallback_fn, concurrency=5):
            return [{"contact_id": None, "contact_name": None} for _ in cands]

        monkeypatch.setattr(categorizer, "categorize_batch_grouped", fake_cat)
        monkeypatch.setattr(contact_resolver, "resolve_contacts_batch", fake_contacts)
        monkeypatch.setattr(srv.contact_resolver, "resolve_contacts_batch", fake_contacts)

        candidates = [
            {"date": "2025-06-02", "description": "Dup", "merchant": "Dup",
             "amount": 3.0, "bank_account_id": acct["id"], "bank_account_name": "Test Bank",
             "plaid_transaction_id": "X", "plaid_account_id": "ax", "pending": False},
            {"date": "2025-06-03", "description": "New", "merchant": "New",
             "amount": 4.0, "bank_account_id": acct["id"], "bank_account_name": "Test Bank",
             "plaid_transaction_id": "Y", "plaid_account_id": "ax", "pending": False},
        ]

        try:
            # Should NOT raise — try/except swallows the BulkWriteError
            await srv._categorize_and_insert(cid, candidates, accts, coa, source="plaid")

            x_docs = await db.transactions.find(
                {"company_id": cid, "plaid_transaction_id": "X"}).to_list(10)
            y_docs = await db.transactions.find(
                {"company_id": cid, "plaid_transaction_id": "Y"}).to_list(10)
            assert len(x_docs) == 1, f"expected 1 X (original only), got {len(x_docs)}"
            assert len(y_docs) == 1, f"expected 1 Y (new insert survived), got {len(y_docs)}"
        finally:
            await db.transactions.delete_many({"company_id": cid})
            await db.accounts.delete_many({"company_id": cid})
    run(go())


# ============ 5. Regression via HTTP + Mongo ==================================
@pytest.fixture(scope="module")
def auth_token():
    r = requests.post(f"{BASE_URL}/api/auth/login",
                      json={"email": "pro@axiom.ai", "password": "pro123"}, timeout=30)
    assert r.status_code == 200, r.text
    data = r.json()
    tok = data.get("token") or data.get("access_token")
    assert tok, f"no token in {data}"
    return tok


def _hdr(t): return {"Authorization": f"Bearer {t}"}


def test_regression_355_txn_count(auth_token):
    r = requests.get(f"{BASE_URL}/api/companies/{COMPANY_355}/transactions?limit=5000",
                     headers=_hdr(auth_token), timeout=60)
    assert r.status_code == 200, r.text
    body = r.json()
    txns = body.get("transactions", body) if isinstance(body, dict) else body
    assert 1870 <= len(txns) <= 1890, f"355 LLC txn count = {len(txns)} (expected ~1878)"


def test_regression_355_balance_sheet_balanced(auth_token):
    r = requests.get(
        f"{BASE_URL}/api/companies/{COMPANY_355}/reports/balance-sheet?basis=accrual",
        headers=_hdr(auth_token), timeout=60)
    assert r.status_code == 200, r.text
    bs = r.json()
    imb = bs.get("imbalance", bs.get("difference", 0)) or 0
    assert abs(float(imb)) < 0.01, f"355 LLC BS imbalance = {imb}"


def test_regression_core_endpoints(auth_token):
    for path in ["/api/companies", f"/api/companies/{COMPANY_355}/accounts"]:
        r = requests.get(f"{BASE_URL}{path}", headers=_hdr(auth_token), timeout=30)
        assert r.status_code == 200, f"{path} → {r.status_code} {r.text[:200]}"


def test_regression_355_has_plaid_item_and_obe():
    async def go():
        item = await db.plaid_items.find_one({"company_id": COMPANY_355})
        assert item is not None, "355 LLC missing plaid_item"
        obe = await db.accounts.find_one({"company_id": COMPANY_355,
                                          "$or": [{"code": "3050"}, {"code": "3900"},
                                                  {"name": {"$regex": "opening balance", "$options": "i"}}]})
        je = await db.journal_entries.find_one({
            "company_id": COMPANY_355,
            "$or": [{"is_opening": True},
                    {"description": {"$regex": "opening", "$options": "i"}}],
        })
        assert obe is not None or je is not None, "355 LLC missing OBE mechanism"
    run(go())
