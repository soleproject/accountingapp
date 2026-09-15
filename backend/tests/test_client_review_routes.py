"""Milestone C tests — client review page API + handlers.

Mocks the Haiku engine so the tests don't hit an LLM. Real
conversation-quality validation happens in the QA/testing-agent
sweep.
"""
import sys, os, uuid
from datetime import datetime, timezone, timedelta

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from httpx import AsyncClient, ASGITransport

from tests._shared_loop import run
from deps import db
import client_review as cr
import client_review_engine as engine
import client_review_handlers as handlers
from server import app


def _client() -> AsyncClient:
    return AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://testserver",
    )


def _iso_days_ago(days: int) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()


async def _mk_company(cid: str, email: str = "owner@fx.example") -> dict:
    pro_id = f"pro-{cid[:8]}"
    doc = {"id": cid, "name": f"Co-{cid[:6]}",
           "created_at": _iso_days_ago(60),
           "client_email": email, "primary_pro_id": pro_id}
    await db.companies.insert_one(doc)
    await db.users.insert_one({"id": pro_id,
                               "email": f"{pro_id}@fx.example",
                               "branding": {"firm_name": "Fixture CPA"}})
    return doc


async def _mk_agent_finding(cid: str, kind: str) -> dict:
    doc = {"id": str(uuid.uuid4()), "company_id": cid, "kind": kind,
           "status": "open", "batch_id": None,
           "title": f"{kind} title", "detail": f"{kind} detail",
           "meta": {}, "severity": "amber",
           "created_at": _iso_days_ago(0)}
    await db.agent_findings.insert_one(doc)
    return doc


async def _cleanup(cid: str) -> None:
    await db.companies.delete_many({"id": cid})
    await db.users.delete_many({"id": f"pro-{cid[:8]}"})
    await db.agent_findings.delete_many({"company_id": cid})
    await db.transactions.delete_many({"company_id": cid})
    await db.contacts.delete_many({"company_id": cid})
    await db.client_review_batches.delete_many({"company_id": cid})


async def _seed_three_findings(cid: str) -> None:
    """Give the aggregator ≥3 items so a batch can mint."""
    await _mk_agent_finding(cid, "missing_receipt")
    await _mk_agent_finding(cid, "w9_needed")
    await _mk_agent_finding(cid, "contact_mismatch")


# --------------------------------------------------------------------------
# GET session
# --------------------------------------------------------------------------

async def _e2e_get_session():
    cid = f"test-{uuid.uuid4()}"
    await _mk_company(cid)
    await _seed_three_findings(cid)
    items = await cr.collect_batch_items(cid)
    batch = await cr.create_batch(cid, "owner@fx.example", items)
    token = batch["client_token"]

    async with _client() as c:
        r = await c.get(f"/api/client-review/{token}")
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["batch_id"] == batch["id"]
        assert body["status"] == "open"
        assert len(body["items"]) == 3
        assert body["firm_name"] == "Fixture CPA"

        # Bad token → 404
        r = await c.get("/api/client-review/does-not-exist-token-12345678")
        assert r.status_code == 404

        # Expired → 410
        await db.client_review_batches.update_one(
            {"id": batch["id"]}, {"$set": {"status": "expired"}},
        )
        r = await c.get(f"/api/client-review/{token}")
        assert r.status_code == 410

    await _cleanup(cid)


def test_get_session():
    run(_e2e_get_session())


# --------------------------------------------------------------------------
# POST /turn — engine mocked
# --------------------------------------------------------------------------

async def _e2e_turn_records_history():
    cid = f"test-{uuid.uuid4()}"
    await _mk_company(cid)
    await _seed_three_findings(cid)
    items = await cr.collect_batch_items(cid)
    batch = await cr.create_batch(cid, "owner@fx.example", items)
    token = batch["client_token"]
    item = batch["items"][0]

    orig = engine.run_turn
    async def fake_turn(**kw):
        return {"assistant_reply": "Got it — was this business or personal?",
                "action": {"type": "quick_replies", "payload": {}},
                "quick_replies": ["Business", "Personal"],
                "raw": "", "model": "mock"}
    engine.run_turn = fake_turn  # type: ignore[assignment]
    try:
        async with _client() as c:
            r = await c.post(
                f"/api/client-review/{token}/turn",
                json={"item_id": item["item_id"], "message": "Hi"},
            )
            assert r.status_code == 200, r.text
            j = r.json()
            assert "business or personal" in j["assistant_reply"]
            assert j["quick_replies"] == ["Business", "Personal"]

        fresh = await db.client_review_batches.find_one({"id": batch["id"]})
        msgs = fresh["items"][0].get("messages") or []
        assert len(msgs) == 2
        assert msgs[0]["role"] == "user"
        assert msgs[1]["role"] == "assistant"
    finally:
        engine.run_turn = orig
        await _cleanup(cid)


def test_turn_records_history():
    run(_e2e_turn_records_history())


# --------------------------------------------------------------------------
# POST /answer — closes source, increments count, 409 on repeat
# --------------------------------------------------------------------------

async def _e2e_answer_closes_source():
    cid = f"test-{uuid.uuid4()}"
    await _mk_company(cid)
    f = await _mk_agent_finding(cid, "missing_receipt")
    await _mk_agent_finding(cid, "w9_needed")
    await _mk_agent_finding(cid, "contact_mismatch")
    items = await cr.collect_batch_items(cid)
    batch = await cr.create_batch(cid, "owner@fx.example", items)
    token = batch["client_token"]
    target = next(i for i in batch["items"] if i["source_id"] == f["id"])

    async with _client() as c:
        r = await c.post(
            f"/api/client-review/{token}/items/{target['item_id']}/answer",
            json={"answer": "It was office supplies from Staples",
                  "payload": {"account_id": None}},
        )
        assert r.status_code == 200, r.text
        assert r.json()["action_taken"] == "answered"

        fresh_finding = await db.agent_findings.find_one({"id": f["id"]})
        assert fresh_finding["status"] == "resolved"
        assert fresh_finding["client_answer"].startswith("It was office")

        fresh_batch = await db.client_review_batches.find_one({"id": batch["id"]})
        assert fresh_batch["answer_count"] == 1

        # Second call on same item → 409
        r = await c.post(
            f"/api/client-review/{token}/items/{target['item_id']}/answer",
            json={"answer": "duplicate", "payload": {}},
        )
        assert r.status_code == 409

    await _cleanup(cid)


def test_answer_closes_source():
    run(_e2e_answer_closes_source())


# --------------------------------------------------------------------------
# POST /defer — client-deferred tagging
# --------------------------------------------------------------------------

async def _e2e_defer_tags_source():
    cid = f"test-{uuid.uuid4()}"
    await _mk_company(cid)
    f = await _mk_agent_finding(cid, "missing_receipt")
    await _mk_agent_finding(cid, "w9_needed")
    await _mk_agent_finding(cid, "contact_mismatch")
    items = await cr.collect_batch_items(cid)
    batch = await cr.create_batch(cid, "owner@fx.example", items)
    token = batch["client_token"]
    target = next(i for i in batch["items"] if i["source_id"] == f["id"])

    async with _client() as c:
        r = await c.post(
            f"/api/client-review/{token}/items/{target['item_id']}/defer",
            json={"note": "Need to check with my partner"},
        )
        assert r.status_code == 200, r.text
    fresh = await db.agent_findings.find_one({"id": f["id"]})
    assert fresh["status"] == "dismissed"
    assert fresh["client_deferred"] is True
    assert fresh["client_deferred_note"] == "Need to check with my partner"
    fresh_batch = await db.client_review_batches.find_one({"id": batch["id"]})
    assert fresh_batch["defer_count"] == 1

    await _cleanup(cid)


def test_defer_tags_source():
    run(_e2e_defer_tags_source())


# --------------------------------------------------------------------------
# POST /upload — attaches to source + batch item
# --------------------------------------------------------------------------

async def _e2e_upload_attaches_document():
    cid = f"test-{uuid.uuid4()}"
    await _mk_company(cid)
    f = await _mk_agent_finding(cid, "missing_receipt")
    await _mk_agent_finding(cid, "w9_needed")
    await _mk_agent_finding(cid, "contact_mismatch")
    items = await cr.collect_batch_items(cid)
    batch = await cr.create_batch(cid, "owner@fx.example", items)
    token = batch["client_token"]
    target = next(i for i in batch["items"] if i["source_id"] == f["id"])

    fake_pdf = b"%PDF-1.4 fake content"
    async with _client() as c:
        r = await c.post(
            f"/api/client-review/{token}/items/{target['item_id']}/upload",
            files={"file": ("receipt.pdf", fake_pdf, "application/pdf")},
            data={"kind": "receipt"},
        )
        assert r.status_code == 200, r.text
        j = r.json()
        assert j["attachment"]["filename"] == "receipt.pdf"
        assert j["attachment"]["kind"] == "receipt"
        assert "data_url" not in j["attachment"], "base64 must not leak back"

    fresh_finding = await db.agent_findings.find_one({"id": f["id"]})
    assert len(fresh_finding.get("attachments") or []) == 1

    await _cleanup(cid)


def test_upload_attaches_document():
    run(_e2e_upload_attaches_document())


# --------------------------------------------------------------------------
# Complete — finalizes and idempotent
# --------------------------------------------------------------------------

async def _e2e_complete_finalizes():
    cid = f"test-{uuid.uuid4()}"
    await _mk_company(cid)
    await _seed_three_findings(cid)
    items = await cr.collect_batch_items(cid)
    batch = await cr.create_batch(cid, "owner@fx.example", items)
    token = batch["client_token"]

    async with _client() as c:
        r = await c.post(f"/api/client-review/{token}/complete")
        assert r.status_code == 200
        j = r.json()
        assert j["ok"] is True
        assert j["answer_count"] == 0
        assert j["defer_count"] == 0

        # Idempotent
        r = await c.post(f"/api/client-review/{token}/complete")
        assert r.status_code == 200

    fresh = await db.client_review_batches.find_one({"id": batch["id"]})
    assert fresh["status"] == "completed"
    assert fresh["completed_at"]

    await _cleanup(cid)


def test_complete_finalizes():
    run(_e2e_complete_finalizes())


# --------------------------------------------------------------------------
# Handlers — item 1 uncategorized categorization applies to the txn
# --------------------------------------------------------------------------

async def _e2e_item1_categorization_applies():
    cid = f"test-{uuid.uuid4()}"
    await _mk_company(cid)
    txn_id = str(uuid.uuid4())
    await db.transactions.insert_one({
        "id": txn_id, "company_id": cid, "date": "2026-06-15",
        "amount": -47.50, "description": "SQ *COFFEE",
        "needs_review": True, "human_reviewed": False,
        "client_question_id": None,
        "created_at": _iso_days_ago(30),
    })

    item = {"item_id": str(uuid.uuid4()),
            "item_type": cr.ITEM_UNCATEGORIZED,
            "source_id": txn_id, "source_collection": "transactions",
            "prompt": "What was this for?", "context": {}}
    batch = {"id": "batch-x", "company_id": cid}
    result = await handlers.apply_answer(
        item, batch,
        answer="Client meeting coffee",
        payload={"account_id": "acc-meals",
                 "account_name": "Meals & Entertainment"},
    )
    assert result["action_taken"] == "categorized"
    fresh = await db.transactions.find_one({"id": txn_id})
    assert fresh["category_account_id"] == "acc-meals"
    assert fresh["needs_review"] is False
    assert fresh["human_reviewed"] is True
    assert "Client meeting coffee" in fresh["ai_comment"]

    await _cleanup(cid)


def test_item1_categorization_applies():
    run(_e2e_item1_categorization_applies())


# --------------------------------------------------------------------------
# Handlers — item 4 W-9 follow_up keeps the finding open
# --------------------------------------------------------------------------

async def _e2e_item4_followup_keeps_finding_open():
    cid = f"test-{uuid.uuid4()}"
    await _mk_company(cid)
    contact_id = str(uuid.uuid4())
    await db.contacts.insert_one({
        "id": contact_id, "company_id": cid,
        "name": "Priya Patel Consulting",
        "is_1099_vendor": True, "w9_on_file": False,
    })
    finding_id = str(uuid.uuid4())
    await db.agent_findings.insert_one({
        "id": finding_id, "company_id": cid, "kind": "w9_needed",
        "status": "open", "contact_id": contact_id,
        "title": "W-9 needed", "detail": "...", "meta": {},
        "severity": "amber", "created_at": _iso_days_ago(0),
    })
    item = {"item_id": "i1", "item_type": cr.ITEM_W9_NEEDED,
            "source_id": finding_id, "source_collection": "agent_findings",
            "prompt": "Can you upload their W-9?",
            "context": {"meta": {"contact_id": contact_id}}}
    batch = {"id": "b1", "company_id": cid}
    result = await handlers.apply_answer(
        item, batch, answer="Please reach out to them",
        payload={"flow": "follow_up", "contact_id": contact_id},
    )
    assert result["action_taken"] == "follow_up_requested"
    fresh_c = await db.contacts.find_one({"id": contact_id})
    assert fresh_c["w9_follow_up_requested"] is True
    fresh_f = await db.agent_findings.find_one({"id": finding_id})
    assert fresh_f["status"] == "open"
    assert fresh_f["meta"]["follow_up_requested"] is True

    await _cleanup(cid)


def test_item4_followup_keeps_finding_open():
    run(_e2e_item4_followup_keeps_finding_open())


if __name__ == "__main__":
    tests = [
        ("test_get_session",                       test_get_session),
        ("test_turn_records_history",              test_turn_records_history),
        ("test_answer_closes_source",              test_answer_closes_source),
        ("test_defer_tags_source",                 test_defer_tags_source),
        ("test_upload_attaches_document",          test_upload_attaches_document),
        ("test_complete_finalizes",                test_complete_finalizes),
        ("test_item1_categorization_applies",      test_item1_categorization_applies),
        ("test_item4_followup_keeps_finding_open", test_item4_followup_keeps_finding_open),
    ]
    passed = failed = 0
    for name, fn in tests:
        try:
            fn()
            print(f"ok   {name}")
            passed += 1
        except Exception as e:
            print(f"FAIL {name}: {type(e).__name__}: {e}")
            failed += 1
    print()
    print(f"{passed} passed, {failed} failed")
    sys.exit(0 if failed == 0 else 1)
