"""Regression tests for the 1099 vendor classifier Tier 1 exclusion
list + the W-9 collection watcher.
"""
import sys, os, uuid
from datetime import datetime, timezone

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from tests._shared_loop import run
from deps import db
import w9_watcher as w9
from known_corporations import is_known_corporation, classify_tier1


# --------------------------------------------------------------------------
# Tier 1 — hardcoded exclusion list
# --------------------------------------------------------------------------

def test_tier1_catches_big_box():
    # Big-box retailers, noisy memos and all
    assert is_known_corporation("WALMART SUPERCENTER #4321 LAS VEGAS")
    assert is_known_corporation("Amazon.com*3F4G22")
    assert is_known_corporation("TARGET T-4432 LOS ANGELES")
    assert is_known_corporation("HOME DEPOT #0432")
    assert is_known_corporation("COSTCO WHSE #1234")


def test_tier1_catches_payment_rails():
    # These match when the CONTACT NAME is the rail itself (pseudo-contact).
    # Raw memos like "SQ *ANNIES DINER" are handled upstream by the
    # resolver, which extracts the real merchant name — so those don't
    # come through here and shouldn't be Tier-1 excluded.
    assert is_known_corporation("Venmo")
    assert is_known_corporation("Zelle")
    assert is_known_corporation("PayPal")
    assert is_known_corporation("Cash App")
    assert is_known_corporation("Stripe")


def test_tier1_catches_utilities_and_telcos():
    assert is_known_corporation("VERIZON WIRELESS")
    assert is_known_corporation("PG&E ELECTRIC BILL")
    assert is_known_corporation("Comcast Xfinity")
    assert is_known_corporation("AT&T Mobility")


def test_tier1_does_not_false_positive_individuals():
    # Names of actual sole proprietors / contractors — must NOT match
    assert not is_known_corporation("Jane Smith")
    assert not is_known_corporation("John Doe LLC")
    assert not is_known_corporation("Acme Consulting Group")
    assert not is_known_corporation("Priya Patel Design")
    assert not is_known_corporation("MidTown Plumbing")


def test_tier1_classify_shape():
    r = classify_tier1("WALMART SUPERCENTER #4321")
    assert r is not None
    assert r["needs_1099"] is False
    assert r["class"] == "corporation"
    assert r["source"] == "known_corporation_list"
    assert r["confidence"] == 1.0
    # Miss returns None so caller escalates to Tier 2.
    assert classify_tier1("Jane Smith Design") is None


# --------------------------------------------------------------------------
# W-9 watcher — end-to-end mint / upgrade / resolve
# --------------------------------------------------------------------------

async def _mk_company(cid: str, name: str = "W9 Test LLC") -> dict:
    doc = {"id": cid, "name": name,
           "created_at": datetime.now(timezone.utc).isoformat()}
    await db.companies.insert_one(doc)
    return doc


async def _mk_contact(cid: str, *, name: str, is_1099: bool = True,
                      w9_on_file: bool = False) -> dict:
    doc = {
        "id":             str(uuid.uuid4()),
        "company_id":     cid,
        "name":           name,
        "normalized_name": name.lower(),
        "type":           "vendor",
        "is_1099_vendor": is_1099,
        "w9_on_file":     w9_on_file,
        "created_at":     datetime.now(timezone.utc).isoformat(),
    }
    await db.contacts.insert_one(doc)
    return doc


async def _mk_txn(cid: str, contact_id: str, amount: float,
                  *, date: str | None = None) -> dict:
    year = datetime.now(timezone.utc).year
    doc = {
        "id":         str(uuid.uuid4()),
        "company_id": cid,
        "contact_id": contact_id,
        "amount":     amount,
        "date":       date or f"{year}-06-15",
        "description": "Contractor payment",
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    await db.transactions.insert_one(doc)
    return doc


async def _cleanup(cid: str) -> None:
    await db.companies.delete_many({"id": cid})
    await db.contacts.delete_many({"company_id": cid})
    await db.transactions.delete_many({"company_id": cid})
    await db.agent_findings.delete_many({"company_id": cid})


async def _e2e_soft_threshold_creates_amber_finding():
    cid = f"test-{uuid.uuid4()}"
    await _mk_company(cid)
    c = await _mk_contact(cid, name="Priya Patel Consulting")
    # $650 outflow — above soft, below hard
    await _mk_txn(cid, c["id"], -300)
    await _mk_txn(cid, c["id"], -350)

    summary = await w9.scan_company(cid)
    assert summary["created"] == 1
    assert summary["skipped_tier1"] == 0

    f = await db.agent_findings.find_one(
        {"company_id": cid, "kind": "w9_needed", "contact_id": c["id"]},
    )
    assert f is not None
    assert f["severity"] == "amber"
    assert f["meta"]["tier"] == "soft"
    assert 649 <= f["meta"]["ytd_paid"] <= 651

    await _cleanup(cid)


def test_soft_threshold_creates_amber_finding():
    run(_e2e_soft_threshold_creates_amber_finding())


async def _e2e_hard_threshold_creates_red_finding():
    cid = f"test-{uuid.uuid4()}"
    await _mk_company(cid)
    c = await _mk_contact(cid, name="Frank The Carpenter")
    await _mk_txn(cid, c["id"], -2500)

    summary = await w9.scan_company(cid)
    assert summary["created"] == 1

    f = await db.agent_findings.find_one(
        {"company_id": cid, "kind": "w9_needed"},
    )
    assert f["severity"] == "red"
    assert f["meta"]["tier"] == "hard"

    await _cleanup(cid)


def test_hard_threshold_creates_red_finding():
    run(_e2e_hard_threshold_creates_red_finding())


async def _e2e_soft_upgrades_to_hard():
    """Amount crosses $2k after a prior scan → same finding, tier
    flipped to hard, severity flipped to red. No duplicate row."""
    cid = f"test-{uuid.uuid4()}"
    await _mk_company(cid)
    c = await _mk_contact(cid, name="Kevin The Plumber")
    await _mk_txn(cid, c["id"], -800)  # soft

    first = await w9.scan_company(cid)
    assert first["created"] == 1

    # More work billed — now $2,500 YTD
    await _mk_txn(cid, c["id"], -1700)

    second = await w9.scan_company(cid)
    assert second["created"] == 0, "must not create a duplicate row"
    assert second["upgraded"] == 1, "soft finding should be upgraded to hard"

    findings = [f async for f in db.agent_findings.find(
        {"company_id": cid, "kind": "w9_needed"},
    )]
    assert len(findings) == 1
    f = findings[0]
    assert f["meta"]["tier"] == "hard"
    assert f["severity"] == "red"
    assert f["meta"]["ytd_paid"] == 2500.0

    await _cleanup(cid)


def test_soft_upgrades_to_hard():
    run(_e2e_soft_upgrades_to_hard())


async def _e2e_tier1_blocks_walmart():
    """A legacy contact incorrectly flagged is_1099_vendor=True for
    Walmart must NOT produce a finding — Tier 1 is defensive."""
    cid = f"test-{uuid.uuid4()}"
    await _mk_company(cid)
    c = await _mk_contact(cid, name="WALMART SUPERCENTER #4321")
    await _mk_txn(cid, c["id"], -5000)  # well over hard threshold

    summary = await w9.scan_company(cid)
    assert summary["created"] == 0
    assert summary["skipped_tier1"] == 1

    f = await db.agent_findings.find_one(
        {"company_id": cid, "kind": "w9_needed"},
    )
    assert f is None, "Tier 1 must block Walmart from becoming a w9 finding"

    await _cleanup(cid)


def test_tier1_blocks_walmart():
    run(_e2e_tier1_blocks_walmart())


async def _e2e_w9_on_file_resolves_finding():
    """When the CPA marks w9_on_file=True on the contact, the next
    scan closes the finding as resolved."""
    cid = f"test-{uuid.uuid4()}"
    await _mk_company(cid)
    c = await _mk_contact(cid, name="Lena's Landscaping")
    await _mk_txn(cid, c["id"], -2500)
    await w9.scan_company(cid)

    # CPA gets the W-9 and marks it
    await db.contacts.update_one(
        {"id": c["id"]}, {"$set": {"w9_on_file": True}},
    )
    summary = await w9.scan_company(cid)
    assert summary["closed"] >= 1

    f = await db.agent_findings.find_one(
        {"company_id": cid, "kind": "w9_needed"},
    )
    assert f["status"] == "resolved"
    assert f["resolved_by"] == "system:w9_watcher"

    await _cleanup(cid)


def test_w9_on_file_resolves_finding():
    run(_e2e_w9_on_file_resolves_finding())


async def _e2e_below_soft_creates_nothing():
    cid = f"test-{uuid.uuid4()}"
    await _mk_company(cid)
    c = await _mk_contact(cid, name="Small Vendor Guy")
    await _mk_txn(cid, c["id"], -400)  # below $500

    summary = await w9.scan_company(cid)
    assert summary["created"] == 0

    f = await db.agent_findings.find_one(
        {"company_id": cid, "kind": "w9_needed"},
    )
    assert f is None

    await _cleanup(cid)


def test_below_soft_creates_nothing():
    run(_e2e_below_soft_creates_nothing())


if __name__ == "__main__":
    tests = [
        ("test_tier1_catches_big_box",             test_tier1_catches_big_box),
        ("test_tier1_catches_payment_rails",       test_tier1_catches_payment_rails),
        ("test_tier1_catches_utilities_telcos",    test_tier1_catches_utilities_and_telcos),
        ("test_tier1_no_false_positive",           test_tier1_does_not_false_positive_individuals),
        ("test_tier1_classify_shape",              test_tier1_classify_shape),
        ("test_soft_threshold_creates_amber",      test_soft_threshold_creates_amber_finding),
        ("test_hard_threshold_creates_red",        test_hard_threshold_creates_red_finding),
        ("test_soft_upgrades_to_hard",             test_soft_upgrades_to_hard),
        ("test_tier1_blocks_walmart",              test_tier1_blocks_walmart),
        ("test_w9_on_file_resolves_finding",       test_w9_on_file_resolves_finding),
        ("test_below_soft_creates_nothing",        test_below_soft_creates_nothing),
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
