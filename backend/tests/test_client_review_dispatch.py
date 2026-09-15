"""Milestone B tests — batch email rendering and dispatch orchestration.

We monkey-patch `email_dispatcher.dispatch` so tests never hit Resend.
Real deliverability is validated in the QA sweep, not here.
"""
import sys, os, uuid
from datetime import datetime, timezone, timedelta

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from tests._shared_loop import run
from deps import db
import client_review as cr
import email_dispatcher as ed


def _iso_days_ago(days: int) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()


async def _mk_company(cid: str, *, email: str | None = None,
                      pause: bool = False, firm_name: str | None = None,
                      created_days_ago: int = 60) -> dict:
    doc = {
        "id":               cid,
        "name":             f"Co-{cid[:6]}",
        "created_at":       _iso_days_ago(created_days_ago),
        "client_email":     email,
        "pause_review_batches": pause,
        "primary_pro_id":   "pro-fixture-1",
    }
    await db.companies.insert_one(doc)
    if firm_name:
        await db.users.insert_one({
            "id": "pro-fixture-1",
            "email": "pro@fixture.example",
            "full_name": "Fixture Pro",
            "branding": {"firm_name": firm_name},
        })
    return doc


async def _mk_finding(cid: str, kind: str = "missing_receipt") -> dict:
    doc = {
        "id":         str(uuid.uuid4()),
        "company_id": cid,
        "kind":       kind,
        "status":     "open",
        "batch_id":   None,
        "title":      f"{kind} title",
        "detail":     f"{kind} detail",
        "meta":       {},
        "severity":   "amber",
        "created_at": _iso_days_ago(0),
    }
    await db.agent_findings.insert_one(doc)
    return doc


async def _cleanup(cid: str) -> None:
    await db.companies.delete_many({"id": cid})
    await db.agent_findings.delete_many({"company_id": cid})
    await db.client_review_batches.delete_many({"company_id": cid})
    await db.users.delete_many({"id": "pro-fixture-1"})


# --------------------------------------------------------------------------
# Pure rendering — no DB
# --------------------------------------------------------------------------

def test_first_name_from_contact():
    assert cr._first_name("owner@x.com", "Sarah Johnson") == "Sarah"
    assert cr._first_name("owner@x.com", "Sarah") == "Sarah"


def test_first_name_from_email():
    assert cr._first_name("john.doe@x.com") == "John"
    assert cr._first_name("j_smith@x.com") == "J"
    assert cr._first_name("nomatch") == "Nomatch"


def test_render_email_subject_and_ctas():
    subject, html, text = cr._render_batch_email(
        first_name="Sarah", item_count=4,
        review_url="https://ex/cli/abc",
        schedule_url="https://ex/cli/abc?action=schedule",
        firm_name="Bright Books CPA",
    )
    assert "4 questions" in subject
    assert "Sarah" in html and "Sarah" in text
    assert "https://ex/cli/abc" in html
    assert "https://ex/cli/abc?action=schedule" in html
    assert "Bright Books CPA" in html
    # Singular grammar
    s1, _, _ = cr._render_batch_email(
        first_name="Sarah", item_count=1,
        review_url="u", schedule_url="s", firm_name=None,
    )
    assert "1 question " in s1 and "questions" not in s1


def test_est_minutes_floor():
    assert cr._est_minutes(1) == "about 2 minutes"  # floor
    assert cr._est_minutes(4) == "about 2 minutes"
    assert cr._est_minutes(20) == "about 10 minutes"


# --------------------------------------------------------------------------
# Dispatch orchestration — with monkey-patched Resend
# --------------------------------------------------------------------------

async def _e2e_dispatch_marks_batch_sent():
    """Successful dispatch stamps email_sent_at, id, resend_id."""
    cid = f"test-{uuid.uuid4()}"
    email = "owner@abc.example.com"
    await _mk_company(cid, email=email, firm_name="Bright Books CPA")

    for _ in range(3):
        await _mk_finding(cid)

    calls: list[dict] = []
    async def fake_dispatch(**kw):
        calls.append(kw)
        return {"status": "sent", "id": "log-1", "resend_id": "re_xyz"}
    orig = ed.dispatch
    ed.dispatch = fake_dispatch  # type: ignore[assignment]

    try:
        result = await cr.trigger_and_dispatch_batches(only_company_id=cid)
        assert result["fired"] == 1, result
        assert result["skipped"] == 0

        batch = await db.client_review_batches.find_one({"company_id": cid})
        assert batch["email_sent_at"]
        assert batch["email_dispatch_id"] == "log-1"
        assert batch["email_resend_id"] == "re_xyz"
        assert batch["status"] == "open"

        # Real Resend was called once, with our kind + correct fields
        assert len(calls) == 1
        call = calls[0]
        assert call["kind"] == "client_review_batch"
        assert call["to"] == email
        assert call["company_id"] == cid
        assert "Bright Books CPA" in call["html"]

        # Cadence gate now blocks a second immediate run
        result2 = await cr.trigger_and_dispatch_batches(only_company_id=cid)
        assert result2["fired"] == 0
        # Reason should be one of the gates — either already_open_batch
        # (we didn't complete/expire) or cadence_too_soon
        assert (result2["skip_reasons"].get("already_open_batch", 0)
                + result2["skip_reasons"].get("cadence_too_soon", 0)) >= 1
    finally:
        ed.dispatch = orig
        await _cleanup(cid)


def test_dispatch_marks_batch_sent():
    run(_e2e_dispatch_marks_batch_sent())


async def _e2e_pause_skips_send():
    cid = f"test-{uuid.uuid4()}"
    await _mk_company(cid, email="owner@paused.example", pause=True)
    for _ in range(3):
        await _mk_finding(cid)

    calls: list[dict] = []
    async def fake_dispatch(**kw):
        calls.append(kw)
        return {"status": "sent", "id": "log-x", "resend_id": "re_x"}
    orig = ed.dispatch
    ed.dispatch = fake_dispatch  # type: ignore[assignment]

    try:
        result = await cr.trigger_and_dispatch_batches(only_company_id=cid)
        assert result["fired"] == 0
        assert result["skip_reasons"].get("paused_by_pro") == 1
        assert len(calls) == 0, "paused pro must not fire Resend"
        # No batch created
        assert await db.client_review_batches.find_one(
            {"company_id": cid}) is None
    finally:
        ed.dispatch = orig
        await _cleanup(cid)


def test_pause_skips_send():
    run(_e2e_pause_skips_send())


async def _e2e_pref_off_expires_batch():
    """When the pro has `client_review_batch` pref = false, dispatch
    returns `skipped_pref_off`. The batch must be expired so we don't
    retry every cron tick — items released, next batch fires fresh.
    """
    cid = f"test-{uuid.uuid4()}"
    await _mk_company(cid, email="owner@prefoff.example")
    findings = [await _mk_finding(cid) for _ in range(3)]

    async def fake_dispatch(**kw):
        return {"status": "skipped_pref_off", "id": "log-p"}
    orig = ed.dispatch
    ed.dispatch = fake_dispatch  # type: ignore[assignment]

    try:
        result = await cr.trigger_and_dispatch_batches(only_company_id=cid)
        assert result["fired"] == 0
        assert result["skip_reasons"].get("skipped_pref_off") == 1

        batch = await db.client_review_batches.find_one({"company_id": cid})
        assert batch is not None
        assert batch["status"] == "expired"
        assert batch.get("expire_reason") == "pref_off"
    finally:
        ed.dispatch = orig
        await _cleanup(cid)


def test_pref_off_expires_batch():
    run(_e2e_pref_off_expires_batch())


async def _e2e_no_client_email_skipped():
    cid = f"test-{uuid.uuid4()}"
    await _mk_company(cid, email=None)   # no email at all
    for _ in range(3):
        await _mk_finding(cid)

    calls: list[dict] = []
    async def fake_dispatch(**kw):
        calls.append(kw)
        return {"status": "sent", "id": "no"}
    orig = ed.dispatch
    ed.dispatch = fake_dispatch  # type: ignore[assignment]
    try:
        result = await cr.trigger_and_dispatch_batches(only_company_id=cid)
        assert result["fired"] == 0
        assert result["skip_reasons"].get("no_client_email") == 1
        assert not calls
    finally:
        ed.dispatch = orig
        await _cleanup(cid)


def test_no_client_email_skipped():
    run(_e2e_no_client_email_skipped())


async def _e2e_batch_carries_token():
    cid = f"test-{uuid.uuid4()}"
    email = "owner@token.example"
    await _mk_company(cid, email=email)
    for _ in range(3):
        await _mk_finding(cid)

    async def fake_dispatch(**kw):
        return {"status": "sent", "id": "log", "resend_id": "re"}
    orig = ed.dispatch
    ed.dispatch = fake_dispatch  # type: ignore[assignment]
    try:
        await cr.trigger_and_dispatch_batches(only_company_id=cid)
        batch = await db.client_review_batches.find_one({"company_id": cid})
        token = batch.get("client_token")
        assert token and isinstance(token, str)
        assert len(token) >= 32, "token too short — replay-vulnerable"
        # Never equal to the batch id — different secret spaces
        assert token != batch["id"]
    finally:
        ed.dispatch = orig
        await _cleanup(cid)


def test_batch_carries_token():
    run(_e2e_batch_carries_token())


if __name__ == "__main__":
    tests = [
        ("test_first_name_from_contact",     test_first_name_from_contact),
        ("test_first_name_from_email",       test_first_name_from_email),
        ("test_render_email_subject_ctas",   test_render_email_subject_and_ctas),
        ("test_est_minutes_floor",           test_est_minutes_floor),
        ("test_dispatch_marks_batch_sent",   test_dispatch_marks_batch_sent),
        ("test_pause_skips_send",            test_pause_skips_send),
        ("test_pref_off_expires_batch",      test_pref_off_expires_batch),
        ("test_no_client_email_skipped",     test_no_client_email_skipped),
        ("test_batch_carries_token",         test_batch_carries_token),
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
