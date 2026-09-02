"""
Regression: `/rules/related` must collapse rules that share the same
ACTION fingerprint (account_code + class_id + tag_ids + posting_mode)
into a single sibling chip with `aliases` populated.

Bug context (Feb 2026): CPA had 5 saved Walmart rules — 4 routed to
"6300 Office Supplies" (as merchant aliases WALMART/walmart/Walmart
plus a contact-keyed one with direction=out) and 1 routed to "6120
Transportation". The popup showed 5 chips. Expected: 2 chips (one per
destination account) with the extras rolled into `aliases`.
"""
from __future__ import annotations
import sys
sys.path.insert(0, "/app/backend")

from db import db  # noqa: E402
from tests._shared_loop import run  # noqa: E402
from routes.rules import rules_related  # noqa: E402


def _fake_user(cid: str) -> dict:
    return {"id": "u", "role": "superadmin", "company_ids": [cid]}


def test_related_collapses_walmart_action_aliases():
    cid = "test-related-collapse-walmart"

    async def prepare():
        await db.rules.delete_many({"company_id": cid})
        await db.transactions.delete_many({"company_id": cid})
        await db.companies.update_one(
            {"id": cid}, {"$set": {"id": cid, "name": "Test"}}, upsert=True,
        )
        contact_id = "contact-walmart"
        # 4 rules to 6300 (differing in match variant & direction),
        # 1 rule to 6120.
        await db.rules.insert_many([
            {"id": "r1", "company_id": cid, "match_value": "Walmart",
             "account_code": "6300"},   # legacy, no match_field
            {"id": "r2", "company_id": cid, "match_field": "merchant",
             "match_value": "walmart", "account_code": "6120"},
            {"id": "r3", "company_id": cid, "match_field": "contact",
             "match_value": contact_id, "account_code": "6300",
             "direction": "out"},
            {"id": "r4", "company_id": cid, "match_field": "merchant",
             "match_value": "WALMART", "account_code": "6300"},
            {"id": "r5", "company_id": cid, "match_field": "merchant",
             "match_value": "Walmart", "account_code": "6300"},
        ])
        # History so cross-key contact→merchant aliasing works.
        await db.transactions.insert_many([
            {"company_id": cid, "contact_id": contact_id, "merchant": "WALMART"},
            {"company_id": cid, "contact_id": contact_id, "merchant": "Walmart"},
            {"company_id": cid, "contact_id": contact_id, "merchant": "walmart"},
        ])
        return contact_id

    async def act(contact_id):
        return await rules_related(
            cid=cid, match_field="contact",
            match_value=contact_id, user=_fake_user(cid),
        )

    async def cleanup():
        await db.rules.delete_many({"company_id": cid})
        await db.transactions.delete_many({"company_id": cid})

    contact_id = run(prepare())
    try:
        result = run(act(contact_id))
    finally:
        run(cleanup())

    rules = result["rules"]
    # 2 chips total — one per destination account.
    assert len(rules) == 2, f"expected 2 deduped rules, got {len(rules)}: {rules}"

    by_code = {r["account_code"]: r for r in rules}
    assert set(by_code) == {"6300", "6120"}

    # The 6300 chip should have 3 aliases (r1, r4, r5 collapse into the
    # contact-keyed r3, or the reverse ordering — any of the 4 can be
    # the leader; total member count must be 4).
    office = by_code["6300"]
    aliases_count = office.get("aliases_count", 0)
    assert aliases_count == 3, (
        f"expected 6300 chip to represent 4 rules (leader + 3 aliases), "
        f"got aliases_count={aliases_count}: {office}"
    )
    assert len(office.get("aliases", [])) == 3

    transport = by_code["6120"]
    assert transport.get("aliases_count", 0) == 0


def test_related_does_not_collapse_different_actions():
    """Class differences should NOT collapse — they change the posting."""
    cid = "test-related-no-collapse-different-class"

    async def prepare():
        await db.rules.delete_many({"company_id": cid})
        await db.transactions.delete_many({"company_id": cid})
        await db.companies.update_one(
            {"id": cid}, {"$set": {"id": cid, "name": "Test"}}, upsert=True,
        )
        await db.rules.insert_many([
            {"id": "x1", "company_id": cid, "match_field": "merchant",
             "match_value": "Shell", "account_code": "6120",
             "class_id": "cls-fleet"},
            {"id": "x2", "company_id": cid, "match_field": "merchant",
             "match_value": "Shell", "account_code": "6120",
             "class_id": "cls-admin"},
        ])

    async def act():
        return await rules_related(
            cid=cid, match_field="merchant",
            match_value="Shell", user=_fake_user(cid),
        )

    async def cleanup():
        await db.rules.delete_many({"company_id": cid})

    run(prepare())
    try:
        result = run(act())
    finally:
        run(cleanup())

    rules = result["rules"]
    # Different class_id → different action → 2 separate chips.
    assert len(rules) == 2
    assert all(r.get("aliases_count", 0) == 0 for r in rules)
