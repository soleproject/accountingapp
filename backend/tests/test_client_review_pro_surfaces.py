"""Milestone F tests — pro-side surfaces for the batch client review.

Exercises:
  * `/api/cockpit/client-review-status` summary counts (pending,
    scheduled, deferred, missed).
  * `/api/cockpit/today` surfaces client-deferred items as source
    `client_deferred` with risk_bucket=high_risk.
  * `/resolve` endpoint stamps `pro_resolved_at` and removes the item
    from the Judgment section on the next `/today` call.
"""
import sys, os, uuid
from datetime import datetime, timezone, timedelta

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from httpx import AsyncClient, ASGITransport

from tests._shared_loop import run
from deps import db
import client_review as cr
from server import app
from auth import create_token


def _client() -> AsyncClient:
    return AsyncClient(transport=ASGITransport(app=app),
                       base_url="http://testserver")


def _iso_days_ago(days: int) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()


async def _mk_pro_and_company(cid: str, pro_email: str | None = None) -> str:
    """Create a fresh pro user + one company they own. Returns JWT."""
    uid = f"p-{cid[:8]}"
    email = pro_email or f"pro-{uid}@fx.example"
    await db.users.insert_one({
        "id": uid, "email": email, "role": "pro",
        "created_at": _iso_days_ago(1),
    })
    await db.companies.insert_one({
        "id": cid, "name": f"Co-{cid[:6]}",
        "owner_id": uid, "primary_pro_id": uid,
        "client_email": "owner@fx.example",
        "created_at": _iso_days_ago(60),
    })
    # Grant firm-staff access via memberships so cockpit accessible-
    # companies works.
    await db.memberships.insert_one({
        "id": str(uuid.uuid4()),
        "user_id": uid, "company_id": cid, "role": "pro",
        "created_at": _iso_days_ago(1),
    })
    return create_token(uid, "pro")


async def _seed_findings(cid: str, count: int = 3) -> None:
    kinds = ["missing_receipt", "w9_needed", "contact_mismatch"]
    for i in range(count):
        await db.agent_findings.insert_one({
            "id": str(uuid.uuid4()), "company_id": cid,
            "kind": kinds[i % len(kinds)],
            "status": "open", "batch_id": None,
            "title": f"finding-{i}", "detail": f"detail-{i}",
            "meta": {}, "severity": "amber",
            "created_at": _iso_days_ago(0),
        })


async def _cleanup(cid: str, uid: str) -> None:
    await db.companies.delete_many({"id": cid})
    await db.users.delete_many({"id": uid})
    await db.memberships.delete_many({"user_id": uid})
    await db.agent_findings.delete_many({"company_id": cid})
    await db.client_review_batches.delete_many({"company_id": cid})


# ---------------------------------------------------------------------------
# /client-review-status — summary counts
# ---------------------------------------------------------------------------

async def _e2e_review_status_empty():
    cid = f"test-{uuid.uuid4()}"
    jwt = await _mk_pro_and_company(cid)
    async with _client() as c:
        r = await c.get("/api/cockpit/client-review-status",
                        headers={"Authorization": f"Bearer {jwt}"})
        assert r.status_code == 200, r.text
        j = r.json()
        assert j["pending_batches"] == 0
        assert j["scheduled_sessions"] == []
        assert j["deferred_item_count"] == 0
        assert j["missed_batch_count"] == 0
    await _cleanup(cid, f"p-{cid[:8]}")


def test_review_status_empty():
    run(_e2e_review_status_empty())


async def _e2e_review_status_counts_pending_scheduled_deferred():
    cid = f"test-{uuid.uuid4()}"
    jwt = await _mk_pro_and_company(cid)
    await _seed_findings(cid, 3)
    items = await cr.collect_batch_items(cid)
    batch = await cr.create_batch(cid, "owner@fx.example", items)

    # Mark one item as deferred (client punted it back)
    first = batch["items"][0]
    await db.client_review_batches.update_one(
        {"id": batch["id"], "items.item_id": first["item_id"]},
        {"$set": {
            "items.$.deferred":    True,
            "items.$.deferred_at": datetime.now(timezone.utc).isoformat(),
            "items.$.deferred_note": "not sure, please handle",
        }, "$inc": {"defer_count": 1}},
    )

    # Schedule the batch for later
    future = (datetime.now(timezone.utc) + timedelta(days=2)).isoformat()
    fresh = await db.client_review_batches.find_one({"id": batch["id"]})
    await cr.schedule_batch(fresh, future)

    async with _client() as c:
        r = await c.get("/api/cockpit/client-review-status",
                        headers={"Authorization": f"Bearer {jwt}"})
        assert r.status_code == 200, r.text
        j = r.json()
        assert j["pending_batches"] == 1
        assert len(j["scheduled_sessions"]) == 1
        s = j["scheduled_sessions"][0]
        assert s["batch_id"] == batch["id"]
        assert s["company_id"] == cid
        assert s["scheduled_for"] == future
        assert j["deferred_item_count"] == 1
    await _cleanup(cid, f"p-{cid[:8]}")


def test_review_status_counts_pending_scheduled_deferred():
    run(_e2e_review_status_counts_pending_scheduled_deferred())


async def _e2e_review_status_missed_batch_counter():
    cid = f"test-{uuid.uuid4()}"
    jwt = await _mk_pro_and_company(cid)
    await _seed_findings(cid, 3)
    items = await cr.collect_batch_items(cid)
    batch = await cr.create_batch(cid, "owner@fx.example", items)
    # Mark the batch as nudged with zero engagement — passive miss.
    await db.client_review_batches.update_one(
        {"id": batch["id"]},
        {"$set": {"nudge_sent_at": _iso_days_ago(2)}},
    )
    async with _client() as c:
        r = await c.get("/api/cockpit/client-review-status",
                        headers={"Authorization": f"Bearer {jwt}"})
        j = r.json()
        assert j["missed_batch_count"] == 1
    await _cleanup(cid, f"p-{cid[:8]}")


def test_review_status_missed_batch_counter():
    run(_e2e_review_status_missed_batch_counter())


# ---------------------------------------------------------------------------
# /client-review-status — active_by_company map for the Today v2 button
# ---------------------------------------------------------------------------

async def _e2e_review_status_active_by_company():
    cid = f"test-{uuid.uuid4()}"
    jwt = await _mk_pro_and_company(cid)
    await _seed_findings(cid, 3)
    items = await cr.collect_batch_items(cid)
    batch = await cr.create_batch(cid, "owner@fx.example", items)
    async with _client() as c:
        r = await c.get("/api/cockpit/client-review-status",
                        headers={"Authorization": f"Bearer {jwt}"})
        assert r.status_code == 200, r.text
        j = r.json()
        by_co = j.get("active_by_company") or {}
        assert cid in by_co, f"expected {cid} in active_by_company, got {list(by_co)}"
        entry = by_co[cid]
        assert entry["batch_id"] == batch["id"]
        assert entry["status"] == "open"
        assert entry["item_count"] >= 1
        # SPA URL, not an API redirect
        assert entry["review_url"].startswith("/client-review/")
        assert entry.get("client_token")
    await _cleanup(cid, f"p-{cid[:8]}")


def test_review_status_active_by_company():
    run(_e2e_review_status_active_by_company())


# ---------------------------------------------------------------------------
# /latest-for-company/{cid} — pro-scoped Quick Check-In lookup
# ---------------------------------------------------------------------------

async def _e2e_latest_for_company_has_pending():
    cid = f"test-{uuid.uuid4()}"
    jwt = await _mk_pro_and_company(cid)
    await _seed_findings(cid, 3)
    items = await cr.collect_batch_items(cid)
    batch = await cr.create_batch(cid, "owner@fx.example", items)
    async with _client() as c:
        r = await c.get(f"/api/client-review/latest-for-company/{cid}",
                        headers={"Authorization": f"Bearer {jwt}"})
        assert r.status_code == 200, r.text
        j = r.json()
        assert j["has_pending"] is True
        assert j["batch_id"] == batch["id"]
        assert j["client_token"] == batch["client_token"]
        assert j["review_url"] == f"/client-review/{batch['client_token']}"
        assert j["status"] == "open"
        assert j["item_count"] >= 1
    await _cleanup(cid, f"p-{cid[:8]}")


def test_latest_for_company_has_pending():
    run(_e2e_latest_for_company_has_pending())


async def _e2e_latest_for_company_none_when_no_batch():
    cid = f"test-{uuid.uuid4()}"
    jwt = await _mk_pro_and_company(cid)
    async with _client() as c:
        r = await c.get(f"/api/client-review/latest-for-company/{cid}",
                        headers={"Authorization": f"Bearer {jwt}"})
        assert r.status_code == 200, r.text
        assert r.json() == {"has_pending": False}
    await _cleanup(cid, f"p-{cid[:8]}")


def test_latest_for_company_none_when_no_batch():
    run(_e2e_latest_for_company_none_when_no_batch())


async def _e2e_latest_for_company_forbids_cross_tenant():
    cid = f"test-{uuid.uuid4()}"
    other_cid = f"test-{uuid.uuid4()}"
    jwt = await _mk_pro_and_company(cid)
    # Second company that our pro has no access to.
    await db.companies.insert_one({
        "id": other_cid, "name": "Other Co", "owner_id": "someone-else",
        "created_at": _iso_days_ago(1),
    })
    async with _client() as c:
        r = await c.get(f"/api/client-review/latest-for-company/{other_cid}",
                        headers={"Authorization": f"Bearer {jwt}"})
        assert r.status_code in (403, 404), r.text
    await db.companies.delete_many({"id": other_cid})
    await _cleanup(cid, f"p-{cid[:8]}")


def test_latest_for_company_forbids_cross_tenant():
    run(_e2e_latest_for_company_forbids_cross_tenant())


# ---------------------------------------------------------------------------
# /cockpit/today — deferred items surface with CLIENT DEFERRED source
# ---------------------------------------------------------------------------

async def _e2e_today_surfaces_deferred_items():
    cid = f"test-{uuid.uuid4()}"
    jwt = await _mk_pro_and_company(cid)
    await _seed_findings(cid, 3)
    items = await cr.collect_batch_items(cid)
    batch = await cr.create_batch(cid, "owner@fx.example", items)

    # Defer TWO items on this batch.
    for i in (0, 1):
        it = batch["items"][i]
        await db.client_review_batches.update_one(
            {"id": batch["id"], "items.item_id": it["item_id"]},
            {"$set": {
                "items.$.deferred": True,
                "items.$.deferred_at": datetime.now(timezone.utc).isoformat(),
                "items.$.deferred_note": f"defer-{i}",
            }, "$inc": {"defer_count": 1}},
        )

    async with _client() as c:
        r = await c.get("/api/cockpit/today",
                        headers={"Authorization": f"Bearer {jwt}"},
                        params={"limit": 500})
        assert r.status_code == 200, r.text
        j = r.json()
        deferred = [x for x in j["items"] if x.get("source") == "client_deferred"]
        assert len(deferred) == 2, f"expected 2 deferred, got {len(deferred)}"
        for d in deferred:
            assert d["risk_bucket"] == "high_risk"
            assert d["needs_decision"] is True
            assert d["company_id"] == cid
            assert d["batch_id"] == batch["id"]
            assert d["item_id"]
    await _cleanup(cid, f"p-{cid[:8]}")


def test_today_surfaces_deferred_items():
    run(_e2e_today_surfaces_deferred_items())


# ---------------------------------------------------------------------------
# resolve endpoint
# ---------------------------------------------------------------------------

async def _e2e_resolve_removes_from_today():
    cid = f"test-{uuid.uuid4()}"
    jwt = await _mk_pro_and_company(cid)
    await _seed_findings(cid, 3)
    items = await cr.collect_batch_items(cid)
    batch = await cr.create_batch(cid, "owner@fx.example", items)
    it = batch["items"][0]
    await db.client_review_batches.update_one(
        {"id": batch["id"], "items.item_id": it["item_id"]},
        {"$set": {
            "items.$.deferred": True,
            "items.$.deferred_at": datetime.now(timezone.utc).isoformat(),
        }, "$inc": {"defer_count": 1}},
    )

    async with _client() as c:
        # Present pre-resolve
        r = await c.get("/api/cockpit/today",
                        headers={"Authorization": f"Bearer {jwt}"})
        deferred = [x for x in r.json()["items"]
                    if x.get("source") == "client_deferred"]
        assert len(deferred) == 1

        # Resolve
        r = await c.post(
            f"/api/cockpit/client-review-status/deferred/"
            f"{batch['id']}/{it['item_id']}/resolve",
            headers={"Authorization": f"Bearer {jwt}"},
        )
        assert r.status_code == 200, r.text
        assert r.json()["ok"] is True

        # Missing post-resolve
        r = await c.get("/api/cockpit/today",
                        headers={"Authorization": f"Bearer {jwt}"})
        deferred = [x for x in r.json()["items"]
                    if x.get("source") == "client_deferred"]
        assert len(deferred) == 0

        # Status count also drops
        r = await c.get("/api/cockpit/client-review-status",
                        headers={"Authorization": f"Bearer {jwt}"})
        assert r.json()["deferred_item_count"] == 0

    # Confirm stamp landed on the batch item
    fresh = await db.client_review_batches.find_one({"id": batch["id"]})
    target = next(x for x in fresh["items"] if x["item_id"] == it["item_id"])
    assert target.get("pro_resolved_at")

    await _cleanup(cid, f"p-{cid[:8]}")


def test_resolve_removes_from_today():
    run(_e2e_resolve_removes_from_today())


async def _e2e_resolve_rejects_cross_tenant():
    cid_a = f"test-{uuid.uuid4()}"
    cid_b = f"test-{uuid.uuid4()}"
    jwt_a = await _mk_pro_and_company(cid_a, "proA@fx.example")
    jwt_b = await _mk_pro_and_company(cid_b, "proB@fx.example")

    # Seed a deferred item on company A only.
    await _seed_findings(cid_a, 3)
    items = await cr.collect_batch_items(cid_a)
    batch = await cr.create_batch(cid_a, "owner@fx.example", items)
    it = batch["items"][0]
    await db.client_review_batches.update_one(
        {"id": batch["id"], "items.item_id": it["item_id"]},
        {"$set": {"items.$.deferred": True,
                  "items.$.deferred_at": datetime.now(timezone.utc).isoformat()}},
    )

    async with _client() as c:
        # Pro B cannot resolve A's item
        r = await c.post(
            f"/api/cockpit/client-review-status/deferred/"
            f"{batch['id']}/{it['item_id']}/resolve",
            headers={"Authorization": f"Bearer {jwt_b}"},
        )
        assert r.status_code == 403, r.text

    await _cleanup(cid_a, f"p-{cid_a[:8]}")
    await _cleanup(cid_b, f"p-{cid_b[:8]}")


def test_resolve_rejects_cross_tenant():
    run(_e2e_resolve_rejects_cross_tenant())


# ---------------------------------------------------------------------------
# Client-review DELETE /{token}/items/{item_id}/attachments/{aid}
# ---------------------------------------------------------------------------

async def _e2e_delete_attachment_prunes_batch_and_source():
    cid = f"test-{uuid.uuid4()}"
    tid = f"txn-{uuid.uuid4()}"
    await db.companies.insert_one({"id": cid, "name": "T"})
    await db.transactions.insert_one({
        "id": tid, "company_id": cid,
        "amount": -483.29, "date": "2026-09-06",
        "merchant": "The Home Depot",
        "attachments": [{"id": "a-1", "filename": "r.png",
                          "mime": "image/png",
                          "data_url": "data:image/png;base64,x",
                          "uploaded_at": "2026-09-06T00:00:00Z"}],
    })
    batch = await cr.create_batch(cid, "owner@fx.example", [{
        "item_id": "it-1",
        "kind": "uncategorized_txn",
        "source_id": tid,
        "source_collection": "transactions",
        "item_type": 1,
        "prompt": "What was this for?",
        "attachments": [{"id": "a-1", "filename": "r.png",
                          "mime": "image/png",
                          "uploaded_at": "2026-09-06T00:00:00Z"}],
    }])
    async with _client() as c:
        r = await c.delete(
            f"/api/client-review/{batch['client_token']}/items/it-1/attachments/a-1",
        )
        assert r.status_code == 200, r.text
        assert r.json() == {"ok": True}
    fresh = await db.client_review_batches.find_one({"id": batch["id"]})
    assert fresh["items"][0]["attachments"] == []
    tdoc = await db.transactions.find_one({"id": tid})
    assert (tdoc.get("attachments") or []) == []
    await db.companies.delete_many({"id": cid})
    await db.transactions.delete_many({"company_id": cid})
    await db.client_review_batches.delete_many({"company_id": cid})


def test_delete_attachment_prunes_batch_and_source():
    run(_e2e_delete_attachment_prunes_batch_and_source())


async def _e2e_delete_attachment_404_when_missing():
    cid = f"test-{uuid.uuid4()}"
    tid = f"txn-{uuid.uuid4()}"
    await db.companies.insert_one({"id": cid, "name": "T"})
    await db.transactions.insert_one({
        "id": tid, "company_id": cid, "amount": -1, "date": "2026-09-06",
    })
    batch = await cr.create_batch(cid, "owner@fx.example", [{
        "item_id": "it-1",
        "kind": "uncategorized_txn",
        "source_id": tid,
        "source_collection": "transactions",
        "item_type": 1, "prompt": "x",
    }])
    async with _client() as c:
        r = await c.delete(
            f"/api/client-review/{batch['client_token']}/items/it-1/attachments/nope",
        )
        assert r.status_code == 404, r.text
    await db.companies.delete_many({"id": cid})
    await db.transactions.delete_many({"company_id": cid})
    await db.client_review_batches.delete_many({"company_id": cid})


def test_delete_attachment_404_when_missing():
    run(_e2e_delete_attachment_404_when_missing())


# ---------------------------------------------------------------------------
# Client-review Q1: "Use this split" auto-posts a multi-line txn split
# ---------------------------------------------------------------------------

async def _e2e_categorization_posts_multiline_split():
    """Client hits 'Use this split' on the Q1 receipt-categorization
    proposal. Backend should write ONE split per line item (from
    `line_items`), keyed by resolved COA accounts, with amounts
    summing to the original txn amount (sign-preserving, penny-perfect).
    """
    import client_review_handlers as handlers
    cid = f"test-{uuid.uuid4()}"
    tid = f"txn-{uuid.uuid4()}"
    await db.companies.insert_one({"id": cid, "name": "T"})
    accts = [
        {"id": "acct-mat-lumber", "company_id": cid, "code": "5100",
         "name": "Materials · Lumber", "type": "expense"},
        {"id": "acct-tools",      "company_id": cid, "code": "5200",
         "name": "Small Tools & Equipment", "type": "expense"},
        {"id": "acct-uncat",      "company_id": cid, "code": "9999",
         "name": "Uncategorized Expense", "type": "expense"},
    ]
    await db.accounts.insert_many(accts)
    await db.transactions.insert_one({
        "id": tid, "company_id": cid,
        "amount": -483.29, "date": "2026-09-06",
        "merchant": "The Home Depot",
        "description": "HOME DEPOT #6234 RENO NV",
        "needs_review": True,
    })
    batch = await cr.create_batch(cid, "owner@fx.example", [{
        "item_id": "it-1",
        "kind": "uncategorized_txn",
        "source_id": tid,
        "source_collection": "transactions",
        "item_type": 1,
        "prompt": "What was this for?",
    }])
    item = batch["items"][0]
    # Vision returns 3 items, 2 in lumber, 1 in small tools
    payload = {
        "flow": "receipt_categorization",
        "narrative": "Home Depot run for lumber and a Milwaukee driver.",
        "line_items": [
            {"description": "4X4X8 PT POST", "amount": 119.88,
             "account_code": "5100", "account_name": "Materials · Lumber"},
            {"description": "2X4X10 KD SPF STUD", "amount": 264.41,
             "account_code": "5100", "account_name": "Materials · Lumber"},
            {"description": "MILWAUKEE M18 IMPACT", "amount": 99.00,
             "account_code": "5200", "account_name": "Small Tools & Equipment"},
        ],
    }
    result = await handlers.apply_answer(
        item, batch, answer="Approved split", payload=payload,
    )
    assert result["action_taken"] == "split_categorized", result

    doc = await db.transactions.find_one({"id": tid, "company_id": cid})
    splits = doc.get("splits") or []
    # ONE split per line item — NOT collapsed by account
    assert len(splits) == 3, [(s["description"], s["amount"]) for s in splits]
    # Descriptions preserved from line_items (not overwritten by account name)
    descs = [s["description"] for s in splits]
    assert "4X4X8 PT POST" in descs
    assert "MILWAUKEE M18 IMPACT" in descs
    # Signs mirror the txn amount
    for s in splits:
        assert s["amount"] < 0
    # Penny-perfect
    assert round(sum(s["amount"] for s in splits), 2) == -483.29
    assert doc.get("human_reviewed") is True
    assert doc.get("split_source") == "client_review_vision"
    # Cleanup
    await db.companies.delete_many({"id": cid})
    await db.transactions.delete_many({"company_id": cid})
    await db.accounts.delete_many({"company_id": cid})
    await db.client_review_batches.delete_many({"company_id": cid})


def test_categorization_posts_multiline_split():
    run(_e2e_categorization_posts_multiline_split())


async def _e2e_categorization_semantic_match_and_autocreate():
    """When the AI proposes an account_code that's missing, the
    handler should FIRST try a semantic name match on existing
    accounts, THEN auto-create a new expense account if nothing
    fits. Every line must post — never fall back to annotate.
    """
    import client_review_handlers as handlers
    cid = f"test-{uuid.uuid4()}"
    tid = f"txn-{uuid.uuid4()}"
    await db.companies.insert_one({"id": cid, "name": "T"})
    # Seed: "Supplies & Materials" (semantic match for "Materials · Lumber")
    # + NO account matching "Small Tools & Equipment" (should auto-create).
    await db.accounts.insert_one({
        "id": "acct-supplies", "company_id": cid, "code": "6800",
        "name": "Supplies & Materials", "type": "expense",
    })
    await db.transactions.insert_one({
        "id": tid, "company_id": cid,
        "amount": -218.88, "date": "2026-09-06",
    })
    batch = await cr.create_batch(cid, "owner@fx.example", [{
        "item_id": "it-1", "kind": "uncategorized_txn",
        "source_id": tid, "source_collection": "transactions",
        "item_type": 1, "prompt": "x",
    }])
    payload = {
        "flow": "receipt_categorization",
        "line_items": [
            {"description": "4X4 PT POST", "amount": 119.88,
             "account_code": "5100", "account_name": "Materials · Lumber"},
            {"description": "MILWAUKEE M18", "amount": 99.00,
             "account_code": "5200", "account_name": "Small Tools & Equipment"},
        ],
    }
    result = await handlers.apply_answer(
        batch["items"][0], batch, answer="Approved", payload=payload,
    )
    assert result["action_taken"] == "split_categorized", result
    # Should have auto-created ONE account (Small Tools) — semantic
    # match handled the Lumber line via "Supplies & Materials".
    auto = result.get("auto_created_accounts") or []
    assert len(auto) == 1, auto
    assert auto[0]["name"] == "Small Tools & Equipment"

    doc = await db.transactions.find_one({"id": tid, "company_id": cid})
    splits = doc.get("splits") or []
    assert len(splits) == 2
    # Lumber line landed on the existing "Supplies & Materials" (semantic hit)
    lumber = next(s for s in splits if s["description"] == "4X4 PT POST")
    assert lumber["category_account_code"] == "6800"
    # Small Tools got auto-created; check it's in accounts now.
    tools_acct = await db.accounts.find_one(
        {"company_id": cid, "name": "Small Tools & Equipment"},
    )
    assert tools_acct is not None
    assert tools_acct.get("auto_created_by") == "client_review_vision"

    await db.companies.delete_many({"id": cid})
    await db.transactions.delete_many({"company_id": cid})
    await db.accounts.delete_many({"company_id": cid})
    await db.client_review_batches.delete_many({"company_id": cid})


def test_categorization_semantic_match_and_autocreate():
    run(_e2e_categorization_semantic_match_and_autocreate())


async def _e2e_categorization_falls_back_when_no_coa_match():
    """If the AI proposes an account with NO code AND NO name at all
    (broken vision output), degrade to annotating so the client
    doesn't lose their answer."""
    import client_review_handlers as handlers
    cid = f"test-{uuid.uuid4()}"
    tid = f"txn-{uuid.uuid4()}"
    await db.companies.insert_one({"id": cid, "name": "T"})
    await db.transactions.insert_one({
        "id": tid, "company_id": cid,
        "amount": -483.29, "date": "2026-09-06",
    })
    batch = await cr.create_batch(cid, "owner@fx.example", [{
        "item_id": "it-1", "kind": "uncategorized_txn",
        "source_id": tid, "source_collection": "transactions",
        "item_type": 1, "prompt": "x",
    }])
    item = batch["items"][0]
    payload = {
        "flow": "receipt_categorization",
        "line_items": [
            {"description": "??", "amount": 483.29,
             "account_code": None, "account_name": None},
        ],
    }
    result = await handlers.apply_answer(
        item, batch, answer="Approved", payload=payload,
    )
    assert result["action_taken"] == "annotated", result
    doc = await db.transactions.find_one({"id": tid, "company_id": cid})
    assert (doc.get("splits") or []) == []
    assert doc.get("client_answer") == "Approved"
    await db.companies.delete_many({"id": cid})
    await db.transactions.delete_many({"company_id": cid})
    await db.client_review_batches.delete_many({"company_id": cid})


def test_categorization_falls_back_when_no_coa_match():
    run(_e2e_categorization_falls_back_when_no_coa_match())





if __name__ == "__main__":
    tests = [
        ("test_review_status_empty",                      test_review_status_empty),
        ("test_review_status_counts_pending_scheduled_deferred",
         test_review_status_counts_pending_scheduled_deferred),
        ("test_review_status_missed_batch_counter",       test_review_status_missed_batch_counter),
        ("test_today_surfaces_deferred_items",            test_today_surfaces_deferred_items),
        ("test_resolve_removes_from_today",               test_resolve_removes_from_today),
        ("test_resolve_rejects_cross_tenant",             test_resolve_rejects_cross_tenant),
    ]
    passed = failed = 0
    for name, fn in tests:
        try:
            fn()
            print(f"ok   {name}")
            passed += 1
        except Exception as e:
            import traceback
            traceback.print_exc()
            print(f"FAIL {name}: {type(e).__name__}: {e}")
            failed += 1
    print()
    print(f"{passed} passed, {failed} failed")
    sys.exit(0 if failed == 0 else 1)
