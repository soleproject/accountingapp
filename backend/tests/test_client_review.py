"""Regression tests for the batch client review aggregator.

Verifies aged-uncategorized filtering, initial-download exclusion,
agent-findings pickup, dedup, cadence gate, batch mint + source
stamping, and expiry sweep.
"""
import sys, os, uuid
from datetime import datetime, timezone, timedelta

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from tests._shared_loop import run
from deps import db
import client_review as cr


def _iso_days_ago(days: int) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()


def _iso_hours_ago(hours: int) -> str:
    return (datetime.now(timezone.utc) - timedelta(hours=hours)).isoformat()


async def _mk_company(cid: str, name: str, created_days_ago: int = 60) -> dict:
    doc = {
        "id":         cid,
        "name":       name,
        "created_at": _iso_days_ago(created_days_ago),
    }
    await db.companies.insert_one(doc)
    return doc


async def _mk_txn(cid: str, *, created_days_ago: int, needs_review: bool = True,
                  human_reviewed: bool = False, client_question_id=None,
                  amount: float = -42.0, description: str = "SQ *COFFEE"):
    doc = {
        "id":                  str(uuid.uuid4()),
        "company_id":          cid,
        "date":                (datetime.now(timezone.utc) -
                                timedelta(days=created_days_ago)).date().isoformat(),
        "amount":              amount,
        "description":         description,
        "merchant":            description,
        "needs_review":        needs_review,
        "human_reviewed":      human_reviewed,
        "client_question_id":  client_question_id,
        "created_at":          _iso_days_ago(created_days_ago),
        "updated_at":          _iso_days_ago(created_days_ago),
    }
    await db.transactions.insert_one(doc)
    return doc


async def _mk_finding(cid: str, *, kind: str, status: str = "open",
                      batch_id=None) -> dict:
    doc = {
        "id":         str(uuid.uuid4()),
        "company_id": cid,
        "kind":       kind,
        "status":     status,
        "batch_id":   batch_id,
        "title":      f"{kind} finding",
        "detail":     f"detail for {kind}",
        "meta":       {},
        "severity":   "amber",
        "created_at": _iso_hours_ago(2),
        "updated_at": _iso_hours_ago(2),
    }
    await db.agent_findings.insert_one(doc)
    return doc


# --------------------------------------------------------------------------
# Item collection
# --------------------------------------------------------------------------

async def _e2e_aged_uncategorized_filter():
    cid = f"test-{uuid.uuid4()}"
    await _mk_company(cid, "Aged Test LLC", created_days_ago=90)
    # Row A: 30 days old, needs_review, not reviewed, no per-txn question
    #        → should be included.
    a = await _mk_txn(cid, created_days_ago=30)
    # Row B: 3 days old (< AGED_UNCATEGORIZED_DAYS) → excluded.
    b = await _mk_txn(cid, created_days_ago=3)
    # Row C: 30 days old but has a per-txn question already → excluded.
    c = await _mk_txn(cid, created_days_ago=30,
                      client_question_id="qid-existing")
    # Row D: 30 days old but CPA-reviewed → excluded.
    d = await _mk_txn(cid, created_days_ago=30, human_reviewed=True)
    # Row E: 30 days old but needs_review=False → excluded.
    e = await _mk_txn(cid, created_days_ago=30, needs_review=False)

    items = await cr._collect_aged_uncategorized(cid)
    ids = {i["source_id"] for i in items}
    assert a["id"] in ids, "aged uncategorized txn must be picked up"
    assert b["id"] not in ids, "fresh txn must be excluded (per-txn owns it)"
    assert c["id"] not in ids, "txn with pending per-txn question excluded"
    assert d["id"] not in ids, "human-reviewed txn excluded"
    assert e["id"] not in ids, "needs_review=false excluded"

    await db.companies.delete_many({"id": cid})
    await db.transactions.delete_many({"company_id": cid})


def test_aged_uncategorized_filter():
    run(_e2e_aged_uncategorized_filter())


async def _e2e_initial_download_excluded():
    """Rows created inside company.created_at + 24h are always excluded,
    no matter how old they are today.
    """
    cid = f"test-{uuid.uuid4()}"
    await _mk_company(cid, "Fresh Onboard LLC", created_days_ago=60)

    # Rig a txn whose created_at is 12h AFTER company creation but many
    # days old — the initial-download window covers it.
    txn_id = str(uuid.uuid4())
    company_created = _iso_days_ago(60)
    initial_download_time = (datetime.fromisoformat(company_created) +
                             timedelta(hours=12)).isoformat()
    await db.transactions.insert_one({
        "id":                 txn_id,
        "company_id":         cid,
        "date":               "2026-06-01",
        "amount":             -50.0,
        "description":        "OLD BACKFILL",
        "merchant":           "OLD BACKFILL",
        "needs_review":       True,
        "human_reviewed":     False,
        "client_question_id": None,
        "created_at":         initial_download_time,
        "updated_at":         initial_download_time,
    })

    items = await cr._collect_aged_uncategorized(cid)
    ids = {i["source_id"] for i in items}
    assert txn_id not in ids, "initial-download txns must never batch"

    await db.companies.delete_many({"id": cid})
    await db.transactions.delete_many({"company_id": cid})


def test_initial_download_excluded():
    run(_e2e_initial_download_excluded())


async def _e2e_agent_findings_pickup_and_dedup():
    cid = f"test-{uuid.uuid4()}"
    await _mk_company(cid, "Findings Test LLC")
    # Open findings across the mapped kinds.
    f_vm  = await _mk_finding(cid, kind="contact_mismatch")
    f_rec = await _mk_finding(cid, kind="missing_receipt")
    f_w9  = await _mk_finding(cid, kind="w9_needed")
    # Already-batched → excluded
    f_batched = await _mk_finding(cid, kind="w9_needed",
                                  batch_id="prev-batch-xyz")
    # Resolved / dismissed → excluded
    f_done = await _mk_finding(cid, kind="w9_needed", status="resolved")
    # Kind not in our map → excluded (advisor_report_send exists on prod
    # but isn't a client-facing question)
    f_other = await _mk_finding(cid, kind="advisor_report_send")

    items = await cr.collect_batch_items(cid)
    ids = {i["source_id"] for i in items}
    assert f_vm["id"]  in ids
    assert f_rec["id"] in ids
    assert f_w9["id"]  in ids
    assert f_batched["id"] not in ids, "already-batched finding excluded"
    assert f_done["id"]    not in ids, "resolved finding excluded"
    assert f_other["id"]   not in ids, "unmapped kind excluded"

    await db.companies.delete_many({"id": cid})
    await db.agent_findings.delete_many({"company_id": cid})


def test_agent_findings_pickup_and_dedup():
    run(_e2e_agent_findings_pickup_and_dedup())


# --------------------------------------------------------------------------
# Cadence gate
# --------------------------------------------------------------------------

async def _e2e_cadence_gate():
    cid = f"test-{uuid.uuid4()}"
    email = "owner@example.com"
    await _mk_company(cid, "Cadence LLC")

    # Below min items → no fire, reason = below_min_items
    await _mk_finding(cid, kind="missing_receipt")
    ok, reason, _ = await cr.should_fire_batch(cid, email)
    assert not ok
    assert reason == "below_min_items"

    # Add enough findings → fire
    await _mk_finding(cid, kind="w9_needed")
    await _mk_finding(cid, kind="contact_mismatch")
    ok, reason, items = await cr.should_fire_batch(cid, email)
    assert ok, f"expected fire, got reason={reason}"
    assert reason == "ready"
    assert len(items) >= cr.BATCH_MIN_ITEMS

    # Rig a prior batch email 2 days ago → cadence blocks
    await db.client_review_batches.insert_one({
        "id":            str(uuid.uuid4()),
        "company_id":    cid,
        "client_email":  email,
        "email_sent_at": _iso_days_ago(2),
        "status":        "completed",
        "items":         [],
        "created_at":    _iso_days_ago(2),
    })
    ok, reason, _ = await cr.should_fire_batch(cid, email)
    assert not ok
    assert reason == "cadence_too_soon"

    # Push it back to 10 days ago → cadence opens again
    await db.client_review_batches.update_many(
        {"company_id": cid, "email_sent_at": {"$ne": None}},
        {"$set": {"email_sent_at": _iso_days_ago(10)}},
    )
    ok, reason, _ = await cr.should_fire_batch(cid, email)
    assert ok, f"cadence should be open, got reason={reason}"

    # Open batch already present → hard block regardless of cadence
    await db.client_review_batches.insert_one({
        "id":           str(uuid.uuid4()),
        "company_id":   cid,
        "client_email": email,
        "status":       "open",
        "items":        [],
        "created_at":   _iso_days_ago(1),
    })
    ok, reason, _ = await cr.should_fire_batch(cid, email)
    assert not ok
    assert reason == "already_open_batch"

    await db.companies.delete_many({"id": cid})
    await db.agent_findings.delete_many({"company_id": cid})
    await db.client_review_batches.delete_many({"company_id": cid})


def test_cadence_gate():
    run(_e2e_cadence_gate())


# --------------------------------------------------------------------------
# Batch mint + source stamping
# --------------------------------------------------------------------------

async def _e2e_create_batch_stamps_sources():
    cid = f"test-{uuid.uuid4()}"
    email = "owner@stamped.com"
    await _mk_company(cid, "Stamped LLC")
    f1 = await _mk_finding(cid, kind="missing_receipt")
    f2 = await _mk_finding(cid, kind="w9_needed")
    f3 = await _mk_finding(cid, kind="contact_mismatch")

    items = await cr.collect_batch_items(cid)
    assert len(items) == 3

    batch = await cr.create_batch(cid, email, items)
    assert batch["status"] == "open"
    assert batch["email_sent_at"] is None
    assert len(batch["items"]) == 3

    # Every source finding now carries the batch_id.
    for f_id in [f1["id"], f2["id"], f3["id"]]:
        fresh = await db.agent_findings.find_one({"id": f_id})
        assert fresh["batch_id"] == batch["id"], \
            f"finding {f_id} was not stamped with batch_id"

    # A second aggregator call returns nothing — everything is stamped.
    second = await cr.collect_batch_items(cid)
    assert second == [], "second collect run must return empty after stamp"

    await db.companies.delete_many({"id": cid})
    await db.agent_findings.delete_many({"company_id": cid})
    await db.client_review_batches.delete_many({"company_id": cid})


def test_create_batch_stamps_sources():
    run(_e2e_create_batch_stamps_sources())


# --------------------------------------------------------------------------
# Expiry sweep — releases items back to the pool
# --------------------------------------------------------------------------

async def _e2e_expire_stale_batches():
    cid = f"test-{uuid.uuid4()}"
    email = "owner@expire.com"
    await _mk_company(cid, "Expire LLC")
    f1 = await _mk_finding(cid, kind="missing_receipt")
    f2 = await _mk_finding(cid, kind="w9_needed")
    f3 = await _mk_finding(cid, kind="contact_mismatch")
    items = await cr.collect_batch_items(cid)
    batch = await cr.create_batch(cid, email, items)

    # Force expiry timestamp into the past.
    await db.client_review_batches.update_one(
        {"id": batch["id"]},
        {"$set": {"expires_at": _iso_days_ago(1)}},
    )

    summary = await cr.expire_stale_batches()
    assert summary["expired_batches"] >= 1
    assert summary["items_released"] == 3

    # Findings freed for re-batching.
    for f_id in [f1["id"], f2["id"], f3["id"]]:
        fresh = await db.agent_findings.find_one({"id": f_id})
        assert not fresh.get("batch_id"), \
            f"finding {f_id} still stamped after expiry"

    # Batch marked expired.
    fresh_batch = await db.client_review_batches.find_one({"id": batch["id"]})
    assert fresh_batch["status"] == "expired"
    assert fresh_batch.get("expired_at")

    # Passive-miss expiry path: nudge sent >5 days ago, zero engagement.
    #   Fresh batch → we make it "passive missed"
    f4 = await _mk_finding(cid, kind="missing_receipt")
    f5 = await _mk_finding(cid, kind="w9_needed")
    f6 = await _mk_finding(cid, kind="contact_mismatch")
    items2 = await cr.collect_batch_items(cid)
    batch2 = await cr.create_batch(cid, email, items2)
    await db.client_review_batches.update_one(
        {"id": batch2["id"]},
        {"$set": {
            "status":         "scheduled",
            "nudge_sent_at":  _iso_days_ago(7),
            "answer_count":   0,
            "defer_count":    0,
        }},
    )
    summary2 = await cr.expire_stale_batches()
    assert summary2["expired_batches"] >= 1

    await db.companies.delete_many({"id": cid})
    await db.agent_findings.delete_many({"company_id": cid})
    await db.client_review_batches.delete_many({"company_id": cid})


def test_expire_stale_batches():
    run(_e2e_expire_stale_batches())


if __name__ == "__main__":
    tests = [
        ("test_aged_uncategorized_filter",       test_aged_uncategorized_filter),
        ("test_initial_download_excluded",       test_initial_download_excluded),
        ("test_agent_findings_pickup_and_dedup", test_agent_findings_pickup_and_dedup),
        ("test_cadence_gate",                    test_cadence_gate),
        ("test_create_batch_stamps_sources",     test_create_batch_stamps_sources),
        ("test_expire_stale_batches",            test_expire_stale_batches),
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
