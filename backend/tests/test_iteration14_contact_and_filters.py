"""Iteration 14 tests:
- Unit test: `categorize_and_insert_plaid_txns` now runs contact resolution on
  ALL candidates (both PFC-primary and LLM-deferred paths), and every inserted
  document carries a non-null contact_id/contact_name.
- Live checks: /api/companies/{cid}/transactions new query params q, date_from,
  date_to (with regex-special safety), combined with needs_review + pagination.
- Live check: at least 90% of Plaid rows for 254, LLC now have contact_id.
"""
import os
import sys
import uuid
import asyncio
import pytest
import requests

sys.path.insert(0, "/app/backend")

BASE_URL = (os.environ.get("REACT_APP_BACKEND_URL")
            or open("/app/frontend/.env").read().split("REACT_APP_BACKEND_URL=")[1].split("\n")[0].strip()
            ).rstrip("/")
CID = "dea036e7-1b29-4589-bc7a-482e9771c22d"  # 254, LLC


# ---------------- Live API fixtures ----------------

@pytest.fixture(scope="module")
def headers():
    r = requests.post(f"{BASE_URL}/api/auth/login",
                      json={"email": "pro@axiom.ai", "password": "pro123"})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['token']}"}


# ---------------- Live: contact_id coverage after backfill ----------------

def test_plaid_contact_id_coverage_after_backfill(headers):
    """After the backfill+fix, at least 90% of Plaid rows must have contact_id."""
    r = requests.get(
        f"{BASE_URL}/api/companies/{CID}/transactions?limit=500&page=1",
        headers=headers,
    )
    assert r.status_code == 200, r.text
    txns = r.json()["transactions"]
    plaid = [t for t in txns if t.get("source") == "plaid"]
    assert plaid, "expected some plaid txns in 254, LLC"
    with_contact = [t for t in plaid if t.get("contact_id")]
    pct = 100.0 * len(with_contact) / len(plaid)
    print(f"contact_id coverage on Plaid rows: {len(with_contact)}/{len(plaid)} = {pct:.1f}%")
    assert pct >= 90.0, f"expected >=90% contact_id coverage, got {pct:.1f}%"


# ---------------- Live: q / date_from / date_to filters ----------------

def test_free_text_search_q_param(headers):
    # Pick a merchant that likely exists — starbucks per problem statement.
    r = requests.get(
        f"{BASE_URL}/api/companies/{CID}/transactions?q=starbucks&limit=250",
        headers=headers,
    )
    assert r.status_code == 200
    j = r.json()
    total = j["pagination"]["total"]
    assert total > 0, "expected some starbucks rows in 254, LLC"
    # every returned row should case-insensitively include 'starbucks' in one
    # of merchant / description / contact_name
    for t in j["transactions"]:
        blob = " ".join([
            (t.get("merchant") or ""),
            (t.get("description") or ""),
            (t.get("contact_name") or ""),
        ]).lower()
        assert "starbucks" in blob, f"row {t.get('id')} missing 'starbucks': {blob!r}"
    # Pagination total reflects the filtered set
    assert total == len(j["transactions"]) or total > 250


def test_regex_special_chars_do_not_error(headers):
    """User input like '$5.00' or 'AT&T' must not blow up the regex."""
    for special in ["AT&T", "$5.00", "(*", "[abc]", ".*", "\\d+"]:
        r = requests.get(
            f"{BASE_URL}/api/companies/{CID}/transactions",
            params={"q": special, "limit": 10},
            headers=headers,
        )
        assert r.status_code == 200, f"q={special!r} returned {r.status_code}: {r.text}"
        # Just verify shape
        assert "transactions" in r.json() and "pagination" in r.json()


def test_date_range_filter(headers):
    date_from, date_to = "2024-06-01", "2024-06-30"
    r = requests.get(
        f"{BASE_URL}/api/companies/{CID}/transactions",
        params={"date_from": date_from, "date_to": date_to, "limit": 500},
        headers=headers,
    )
    assert r.status_code == 200
    j = r.json()
    for t in j["transactions"]:
        assert date_from <= t["date"] <= date_to, f"row date {t['date']} out of range"
    # Sanity: total should be strictly less than full company total
    r_all = requests.get(
        f"{BASE_URL}/api/companies/{CID}/transactions?limit=1",
        headers=headers,
    )
    assert j["pagination"]["total"] < r_all.json()["pagination"]["total"]


def test_combined_filters_pagination(headers):
    """q + needs_review + limit — pagination.total must reflect the filtered set."""
    r = requests.get(
        f"{BASE_URL}/api/companies/{CID}/transactions",
        params={"q": "starbucks", "needs_review": "true", "limit": 5, "page": 1},
        headers=headers,
    )
    assert r.status_code == 200
    j = r.json()
    total = j["pagination"]["total"]
    # limit=5 but total is filtered aggregate
    assert len(j["transactions"]) <= 5
    if total > 5:
        r2 = requests.get(
            f"{BASE_URL}/api/companies/{CID}/transactions",
            params={"q": "starbucks", "needs_review": "true", "limit": 5, "page": 2},
            headers=headers,
        )
        j2 = r2.json()
        assert j2["pagination"]["total"] == total  # stable across pages
        ids1 = {t["id"] for t in j["transactions"]}
        ids2 = {t["id"] for t in j2["transactions"]}
        assert ids1.isdisjoint(ids2)


# ---------------- Unit test: contact resolution runs on ALL candidates ----------------

@pytest.mark.asyncio
async def test_contact_resolution_runs_on_all_candidates(monkeypatch):
    """Regression guard for the 95%-contact-missing bug: even PFC-primary rows
    must be passed through contact_resolver.resolve_contacts_batch, and every
    inserted document must carry a contact_id + contact_name.
    """
    from db import db, now_iso
    import plaid_connect
    import contact_resolver
    import categorizer
    import pfc_resolver

    cid = f"test-{uuid.uuid4()}"
    now = now_iso()
    # seed minimal accounts (uncategorized + one PFC target)
    accts_seed = [
        ("9990", "Uncategorized Expenses", "expense", "operating_expense"),
        ("9991", "Uncategorized Income", "revenue", "operating_revenue"),
        ("6100", "Meals & Entertainment", "expense", "operating_expense"),
        ("1010", "Business Checking", "asset", "current_asset"),
    ]
    for code, name, t, st in accts_seed:
        await db.accounts.insert_one({
            "id": str(uuid.uuid4()), "company_id": cid,
            "code": code, "name": name, "type": t, "subtype": st,
            "created_at": now, "updated_at": now,
        })
    chk = await db.accounts.find_one({"company_id": cid, "code": "1010"})
    meals = await db.accounts.find_one({"company_id": cid, "code": "6100"})

    # --- monkeypatch surrounding pipeline pieces ---
    # PFC resolver: first two txns are PFC-primary (Starbucks meals); third is
    # deferred (returns None → LLM path).
    async def fake_pfc(company_id, pfc_detailed, bank_account_id=None):
        if pfc_detailed == "FOOD_AND_DRINK_COFFEE":
            return {
                "category_account_id": meals["id"],
                "category_account_code": meals["code"],
                "category_account_name": meals["name"],
                "classification": "expense",
                "source": "primary",
                "reviewed_by_default": True,
            }
        return None
    monkeypatch.setattr(pfc_resolver, "resolve_pfc_coa", fake_pfc)

    async def fake_ensure_pfc(cid):
        return None
    monkeypatch.setattr(categorizer, "ensure_pfc_support_accounts", fake_ensure_pfc)

    async def fake_ensure_uncat(cid):
        u_exp = await db.accounts.find_one({"company_id": cid, "code": "9990"})
        u_inc = await db.accounts.find_one({"company_id": cid, "code": "9991"})
        return u_exp, u_inc
    monkeypatch.setattr(categorizer, "ensure_uncategorized_accounts", fake_ensure_uncat)

    async def fake_get_threshold(cid):
        return 0.85
    monkeypatch.setattr(categorizer, "get_auto_post_threshold", fake_get_threshold)

    async def fake_categorize_batch(cid, items, coa, categorize_fn, concurrency=10):
        return [
            {"account_code": "9990", "confidence": 0.4,
             "reasoning": "fake", "needs_review": True, "cache_hit": False}
            for _ in items
        ]
    monkeypatch.setattr(categorizer, "categorize_batch_grouped", fake_categorize_batch)

    def fake_decide_posting(r, threshold, uexp, uinc, accts, amount):
        return {
            "category_account_id": uexp["id"],
            "category_account_code": uexp["code"],
            "category_account_name": uexp["name"],
            "ai_confidence": 0.4,
            "ai_reasoning": "fallback",
            "needs_review": True,
            "posted": False,
            "ai_source": "llm",
        }
    monkeypatch.setattr(categorizer, "decide_posting", fake_decide_posting)

    # Spy on resolve_contacts_batch — assert it is called ONCE with all candidates
    call_log = {"count": 0, "n_items": 0}
    real_resolve = contact_resolver.resolve_contacts_batch

    async def spy_resolve(company_id, items, ai_fallback_fn, concurrency=5):
        call_log["count"] += 1
        call_log["n_items"] = len(items)
        # Return a deterministic non-null contact per row
        return [
            {"contact_id": f"c-{i}", "contact_name": f"Vendor {i}", "source": "spy"}
            for i, _ in enumerate(items)
        ]
    monkeypatch.setattr(contact_resolver, "resolve_contacts_batch", spy_resolve)

    async def fake_categorize_fn(*a, **kw):
        return {"account_code": "9990", "confidence": 0.4,
                "reasoning": "x", "needs_review": True}
    async def fake_period_closed(cid, d):
        return False

    plaid_txns = [
        # PFC-primary rows (previously would skip contact resolution)
        {"transaction_id": "p1", "account_id": "acct1", "date": "2026-01-05",
         "name": "STARBUCKS #1234", "merchant_name": "Starbucks", "amount": 4.50,
         "personal_finance_category": {"primary": "FOOD_AND_DRINK",
                                        "detailed": "FOOD_AND_DRINK_COFFEE"},
         "pending": False},
        {"transaction_id": "p2", "account_id": "acct1", "date": "2026-01-06",
         "name": "STARBUCKS #999", "merchant_name": "Starbucks", "amount": 5.25,
         "personal_finance_category": {"primary": "FOOD_AND_DRINK",
                                        "detailed": "FOOD_AND_DRINK_COFFEE"},
         "pending": False},
        # LLM-deferred row (unknown PFC)
        {"transaction_id": "p3", "account_id": "acct1", "date": "2026-01-07",
         "name": "MYSTERY BILLER", "merchant_name": "Mystery",
         "amount": 20.00,
         "personal_finance_category": {"primary": "GENERAL_MERCHANDISE",
                                        "detailed": "GENERAL_MERCHANDISE_OTHER"},
         "pending": False},
    ]

    try:
        inserted, skipped = await plaid_connect.categorize_and_insert_plaid_txns(
            cid, plaid_txns, chk, coa=[], accts=[],
            categorize_fn=fake_categorize_fn,
            is_period_closed_fn=fake_period_closed,
            higher_ranges=[],
        )
        # Regression assertions
        assert call_log["count"] == 1, "resolve_contacts_batch must be called exactly once"
        assert call_log["n_items"] == 3, (
            f"resolve_contacts_batch must receive ALL 3 candidates, got {call_log['n_items']}"
        )
        assert len(inserted) == 3
        for row in inserted:
            assert row["contact_id"] is not None, f"missing contact_id: {row}"
            assert row["contact_name"] is not None, f"missing contact_name: {row}"
        # Both PFC-primary rows must land in Meals (6100)
        pfc_rows = [r for r in inserted if r["plaid_transaction_id"] in ("p1", "p2")]
        assert all(r["category_account_code"] == "6100" for r in pfc_rows)
        # LLM row -> uncategorized fallback
        llm_row = next(r for r in inserted if r["plaid_transaction_id"] == "p3")
        assert llm_row["category_account_code"] == "9990"
    finally:
        # cleanup
        await db.accounts.delete_many({"company_id": cid})
        await db.transactions.delete_many({"company_id": cid})
        # restore spy target
        contact_resolver.resolve_contacts_batch = real_resolve
