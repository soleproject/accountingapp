"""Milestone D tests — schedule / reschedule / reminder / passive-miss.

We monkey-patch `email_dispatcher.dispatch` so tests never hit Resend.
"""
import sys, os, uuid
from datetime import datetime, timezone, timedelta

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from httpx import AsyncClient, ASGITransport

from tests._shared_loop import run
from deps import db
import client_review as cr
import email_dispatcher as ed
from server import app


def _client() -> AsyncClient:
    return AsyncClient(transport=ASGITransport(app=app),
                       base_url="http://testserver")


def _iso(dt: datetime) -> str:
    return dt.isoformat()


def _now() -> datetime:
    return datetime.now(timezone.utc)


async def _mk_company(cid: str, email: str = "owner@sched.example") -> dict:
    pro_id = f"pro-{cid[:8]}"
    await db.companies.insert_one({
        "id": cid, "name": f"Co-{cid[:6]}",
        "created_at": _iso(_now() - timedelta(days=60)),
        "client_email": email, "primary_pro_id": pro_id,
    })
    await db.users.insert_one({
        "id": pro_id, "email": f"{pro_id}@fx.example",
        "branding": {"firm_name": "Fixture CPA"},
    })


async def _seed_findings(cid: str) -> None:
    for kind in ("missing_receipt", "w9_needed", "contact_mismatch"):
        await db.agent_findings.insert_one({
            "id": str(uuid.uuid4()), "company_id": cid, "kind": kind,
            "status": "open", "batch_id": None,
            "title": kind, "detail": f"{kind} detail",
            "meta": {}, "severity": "amber",
            "created_at": _iso(_now()),
        })


async def _cleanup(cid: str) -> None:
    await db.companies.delete_many({"id": cid})
    await db.users.delete_many({"id": f"pro-{cid[:8]}"})
    await db.agent_findings.delete_many({"company_id": cid})
    await db.client_review_batches.delete_many({"company_id": cid})


# --------------------------------------------------------------------------
# schedule_batch — accept / reject cases
# --------------------------------------------------------------------------

async def _e2e_schedule_valid_stores_and_flips_status():
    cid = f"test-{uuid.uuid4()}"
    await _mk_company(cid)
    await _seed_findings(cid)
    items = await cr.collect_batch_items(cid)
    batch = await cr.create_batch(cid, "owner@sched.example", items)

    future = (_now() + timedelta(days=2)).isoformat()
    result = await cr.schedule_batch(batch, future)
    assert result["ok"] is True
    assert result["scheduled_for"] == future

    fresh = await db.client_review_batches.find_one({"id": batch["id"]})
    assert fresh["status"] == "scheduled"
    assert fresh["scheduled_for"] == future
    assert fresh["reminder_sent_at"] is None

    await _cleanup(cid)


def test_schedule_valid_stores_and_flips_status():
    run(_e2e_schedule_valid_stores_and_flips_status())


async def _e2e_schedule_past_rejected():
    cid = f"test-{uuid.uuid4()}"
    await _mk_company(cid)
    await _seed_findings(cid)
    items = await cr.collect_batch_items(cid)
    batch = await cr.create_batch(cid, "owner@sched.example", items)

    past = (_now() - timedelta(hours=1)).isoformat()
    try:
        await cr.schedule_batch(batch, past)
        assert False, "expected ValueError"
    except ValueError as e:
        assert "future" in str(e)

    await _cleanup(cid)


def test_schedule_past_rejected():
    run(_e2e_schedule_past_rejected())


async def _e2e_schedule_after_expiry_rejected():
    cid = f"test-{uuid.uuid4()}"
    await _mk_company(cid)
    await _seed_findings(cid)
    items = await cr.collect_batch_items(cid)
    batch = await cr.create_batch(cid, "owner@sched.example", items)

    beyond = (_now() + timedelta(days=30)).isoformat()
    try:
        await cr.schedule_batch(batch, beyond)
        assert False, "expected ValueError"
    except ValueError as e:
        assert "expiry" in str(e)

    await _cleanup(cid)


def test_schedule_after_expiry_rejected():
    run(_e2e_schedule_after_expiry_rejected())


async def _e2e_reschedule_does_not_reset_expiry():
    """Two consecutive schedule calls — expires_at must be unchanged."""
    cid = f"test-{uuid.uuid4()}"
    await _mk_company(cid)
    await _seed_findings(cid)
    items = await cr.collect_batch_items(cid)
    batch = await cr.create_batch(cid, "owner@sched.example", items)
    original_expires = batch["expires_at"]

    await cr.schedule_batch(batch, (_now() + timedelta(days=2)).isoformat())
    # Refresh
    batch2 = await db.client_review_batches.find_one({"id": batch["id"]})
    assert batch2["expires_at"] == original_expires

    # Active reschedule — different time, still no reset
    await cr.schedule_batch(batch2, (_now() + timedelta(days=5)).isoformat())
    batch3 = await db.client_review_batches.find_one({"id": batch["id"]})
    assert batch3["expires_at"] == original_expires
    # And the new scheduled_for stuck
    assert batch3["scheduled_for"] != batch2["scheduled_for"]

    await _cleanup(cid)


def test_reschedule_does_not_reset_expiry():
    run(_e2e_reschedule_does_not_reset_expiry())


# --------------------------------------------------------------------------
# HTTP surface — POST /schedule via TestClient
# --------------------------------------------------------------------------

async def _e2e_schedule_via_route():
    cid = f"test-{uuid.uuid4()}"
    await _mk_company(cid)
    await _seed_findings(cid)
    items = await cr.collect_batch_items(cid)
    batch = await cr.create_batch(cid, "owner@sched.example", items)
    token = batch["client_token"]

    async with _client() as c:
        future = (_now() + timedelta(days=3)).isoformat()
        r = await c.post(f"/api/client-review/{token}/schedule",
                         json={"scheduled_for": future})
        assert r.status_code == 200, r.text

        # Bad token → 404
        r = await c.post("/api/client-review/nope-nope-16chars-atleast/schedule",
                         json={"scheduled_for": future})
        assert r.status_code == 404

        # Past time → 400
        past = (_now() - timedelta(hours=1)).isoformat()
        r = await c.post(f"/api/client-review/{token}/reschedule",
                         json={"scheduled_for": past})
        assert r.status_code == 400
        assert "future" in r.json()["detail"]

    await _cleanup(cid)


def test_schedule_via_route():
    run(_e2e_schedule_via_route())


# --------------------------------------------------------------------------
# Reminder + passive-miss cron
# --------------------------------------------------------------------------

async def _e2e_reminder_fires_at_scheduled_time():
    cid = f"test-{uuid.uuid4()}"
    await _mk_company(cid)
    await _seed_findings(cid)
    items = await cr.collect_batch_items(cid)
    batch = await cr.create_batch(cid, "owner@sched.example", items)

    # Simulate: client scheduled for 5 min ago, no engagement yet.
    past_time = _iso(_now() - timedelta(minutes=5))
    await db.client_review_batches.update_one(
        {"id": batch["id"]},
        {"$set": {"status": "scheduled", "scheduled_for": past_time,
                  "reminder_sent_at": None}},
    )

    calls: list[dict] = []
    async def fake_dispatch(**kw):
        calls.append(kw)
        return {"status": "sent", "id": "log-x", "resend_id": "re_x"}
    orig = ed.dispatch
    ed.dispatch = fake_dispatch  # type: ignore[assignment]
    try:
        summary = await cr.send_scheduled_reminders()
        assert summary["sent"] == 1

        fresh = await db.client_review_batches.find_one({"id": batch["id"]})
        assert fresh["reminder_sent_at"]
        # Reminder tone hits the 2-CTA variant
        html = calls[0]["html"]
        assert "Answer now" in html
        assert "Pick a new time" in html
        assert "Talk to my bookkeeper" not in html

        # Idempotent — second tick fires zero reminders
        summary2 = await cr.send_scheduled_reminders()
        assert summary2["sent"] == 0
    finally:
        ed.dispatch = orig
        await _cleanup(cid)


def test_reminder_fires_at_scheduled_time():
    run(_e2e_reminder_fires_at_scheduled_time())


async def _e2e_reminder_skipped_if_engaged():
    """Client engaged (chatted or answered) → no reminder."""
    cid = f"test-{uuid.uuid4()}"
    await _mk_company(cid)
    await _seed_findings(cid)
    items = await cr.collect_batch_items(cid)
    batch = await cr.create_batch(cid, "owner@sched.example", items)

    past_time = _iso(_now() - timedelta(minutes=5))
    # Force one answer on the batch to signal engagement.
    await db.client_review_batches.update_one(
        {"id": batch["id"]},
        {"$set": {"status": "scheduled", "scheduled_for": past_time,
                  "reminder_sent_at": None, "answer_count": 1}},
    )

    calls: list[dict] = []
    async def fake_dispatch(**kw):
        calls.append(kw)
        return {"status": "sent"}
    orig = ed.dispatch
    ed.dispatch = fake_dispatch  # type: ignore[assignment]
    try:
        summary = await cr.send_scheduled_reminders()
        assert summary["sent"] == 0
        assert not calls, "must not dispatch when client already engaged"
        fresh = await db.client_review_batches.find_one({"id": batch["id"]})
        assert fresh.get("reminder_skipped_engaged") is True
    finally:
        ed.dispatch = orig
        await _cleanup(cid)


def test_reminder_skipped_if_engaged():
    run(_e2e_reminder_skipped_if_engaged())


async def _e2e_passive_miss_fires_once():
    cid = f"test-{uuid.uuid4()}"
    await _mk_company(cid)
    await _seed_findings(cid)
    items = await cr.collect_batch_items(cid)
    batch = await cr.create_batch(cid, "owner@sched.example", items)

    # Reminder sent 26h ago, still no engagement.
    await db.client_review_batches.update_one(
        {"id": batch["id"]},
        {"$set": {
            "status":            "scheduled",
            "scheduled_for":     _iso(_now() - timedelta(hours=27)),
            "reminder_sent_at":  _iso(_now() - timedelta(hours=26)),
            "nudge_sent_at":     None,
        }},
    )

    calls: list[dict] = []
    async def fake_dispatch(**kw):
        calls.append(kw)
        return {"status": "sent"}
    orig = ed.dispatch
    ed.dispatch = fake_dispatch  # type: ignore[assignment]
    try:
        summary = await cr.send_passive_miss_nudges()
        assert summary["sent"] == 1
        # Three-CTA variant
        html = calls[0]["html"]
        assert "Answer now" in html
        assert "Pick a new time" in html
        assert "Talk to my bookkeeper" in html

        fresh = await db.client_review_batches.find_one({"id": batch["id"]})
        assert fresh["nudge_sent_at"]

        # Idempotent — never fire a second nudge
        summary2 = await cr.send_passive_miss_nudges()
        assert summary2["sent"] == 0
    finally:
        ed.dispatch = orig
        await _cleanup(cid)


def test_passive_miss_fires_once():
    run(_e2e_passive_miss_fires_once())


async def _e2e_client_review_tick_orchestration():
    """Smoke test for the combined cron entrypoint — no crashes on an
    empty DB and returns the shape callers depend on.
    """
    result = await cr.client_review_tick()
    assert set(result.keys()) == {"reminders", "nudges", "expired", "triggered",
                                   "vendor_outreach"}
    assert "sent" in result["reminders"]
    assert "sent" in result["nudges"]
    assert "expired_batches" in result["expired"]
    assert "fired" in result["triggered"]


def test_client_review_tick_orchestration():
    run(_e2e_client_review_tick_orchestration())


if __name__ == "__main__":
    tests = [
        ("test_schedule_valid_stores_and_flips_status", test_schedule_valid_stores_and_flips_status),
        ("test_schedule_past_rejected",                 test_schedule_past_rejected),
        ("test_schedule_after_expiry_rejected",         test_schedule_after_expiry_rejected),
        ("test_reschedule_does_not_reset_expiry",       test_reschedule_does_not_reset_expiry),
        ("test_schedule_via_route",                     test_schedule_via_route),
        ("test_reminder_fires_at_scheduled_time",       test_reminder_fires_at_scheduled_time),
        ("test_reminder_skipped_if_engaged",            test_reminder_skipped_if_engaged),
        ("test_passive_miss_fires_once",                test_passive_miss_fires_once),
        ("test_client_review_tick_orchestration",       test_client_review_tick_orchestration),
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
