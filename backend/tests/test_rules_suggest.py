"""Regression — POST /companies/{cid}/rules/suggest-from-txns (Mar 2026).

Locks in the dedupe rules for the "Make these rules" guided flow:
  * Contact-keyed grouping when contact_id is set.
  * Merchant-keyed grouping otherwise (exact string).
  * Same signature collapses to a single proposal.
  * Parked / uncategorized accounts (6999, 4999) are skipped.
  * Existing rules for the same (match_field, match_value, account_code)
    are skipped from the proposal list.
  * Contact-first ordering.
"""
from __future__ import annotations
import sys, uuid
import pytest

sys.path.insert(0, "/app/backend")

from db import db, now_iso  # noqa: E402
from tests._shared_loop import run  # noqa: E402


async def _seed(cid: str):
    await db.companies.insert_one({"id": cid, "name": "S LLC"})
    accts = [
        {"id": str(uuid.uuid4()), "company_id": cid, "code": "6000",
         "name": "Office", "type": "expense"},
        {"id": str(uuid.uuid4()), "company_id": cid, "code": "6300",
         "name": "Meals",  "type": "expense"},
        {"id": str(uuid.uuid4()), "company_id": cid, "code": "6999",
         "name": "Uncategorized", "type": "expense"},
    ]
    await db.accounts.insert_many(accts)
    contact = {"id": str(uuid.uuid4()), "company_id": cid,
               "name": "Staples", "normalized_name": "staples",
               "created_at": now_iso(), "updated_at": now_iso()}
    await db.contacts.insert_one(contact)
    return {"contact": contact}


async def _cleanup(cid: str):
    for coll in ("accounts", "contacts", "transactions",
                  "rules", "companies"):
        await db[coll].delete_many({"company_id": cid} if coll != "companies"
                                    else {"id": cid})


def _stub(monkeypatch):
    import routes.rules as m
    async def _ok(user, cid): return None
    monkeypatch.setattr(m, "require_company", _ok)


def test_dedupes_contact_and_merchant_signatures(monkeypatch):
    from routes.rules import suggest_rules_from_txns
    _stub(monkeypatch)

    async def go():
        cid = f"sug-{uuid.uuid4().hex[:8]}"
        try:
            s = await _seed(cid)
            # 3 STAPLES rows all with contact + Office → 1 proposal.
            # 2 UBER rows without contact, both → Meals → 1 proposal.
            # 1 orphan row → 6999 Uncategorized → dropped.
            docs = []
            for merch in ("STAPLES 1", "STAPLES 2", "STAPLES 3"):
                docs.append({"id": str(uuid.uuid4()), "company_id": cid,
                             "merchant": merch, "amount": -10.0,
                             "category_account_code": "6000",
                             "category_account_name": "Office",
                             "contact_id": s["contact"]["id"],
                             "contact_name": "Staples",
                             "posted": True, "needs_review": False,
                             "created_at": now_iso(), "updated_at": now_iso()})
            for merch in ("UBER TRIP 1", "UBER TRIP 1"):
                docs.append({"id": str(uuid.uuid4()), "company_id": cid,
                             "merchant": merch, "amount": -20.0,
                             "category_account_code": "6300",
                             "category_account_name": "Meals",
                             "contact_id": None, "contact_name": None,
                             "posted": False, "needs_review": True,
                             "created_at": now_iso(), "updated_at": now_iso()})
            docs.append({"id": str(uuid.uuid4()), "company_id": cid,
                         "merchant": "??? ORPHAN", "amount": -5.0,
                         "category_account_code": "6999",
                         "category_account_name": "Uncategorized",
                         "created_at": now_iso(), "updated_at": now_iso()})
            await db.transactions.insert_many(docs)
            ids = [d["id"] for d in docs]

            res = await suggest_rules_from_txns(cid, {"transaction_ids": ids},
                user={"role": "pro"})
            assert res["uncategorized_skipped"] == 1
            assert res["duplicates_skipped"] == 0
            props = res["proposals"]
            assert len(props) == 2
            # Contact-keyed proposal appears first.
            assert props[0]["match_field"] == "contact"
            assert props[0]["covered_txn_count"] == 3
            assert props[0]["priority"] == 10
            assert props[0]["posting_mode"] == "auto"      # majority posted
            # Merchant proposal second.
            assert props[1]["match_field"] == "merchant"
            assert props[1]["covered_txn_count"] == 2
            assert props[1]["priority"] == 0
            assert props[1]["posting_mode"] == "review"    # majority review
        finally:
            await _cleanup(cid)
    run(go())


def test_skips_signatures_that_match_existing_rules(monkeypatch):
    from routes.rules import suggest_rules_from_txns
    _stub(monkeypatch)

    async def go():
        cid = f"sug-{uuid.uuid4().hex[:8]}"
        try:
            s = await _seed(cid)
            # Existing rule already covers STAPLES → Office (merchant-keyed).
            await db.rules.insert_one({
                "id": str(uuid.uuid4()), "company_id": cid,
                "match_type":  "merchant_contains",
                "match_field": "merchant",
                "match_value": "STAPLES CANADA",
                "account_code": "6000",
                "created_at": now_iso(), "updated_at": now_iso(),
            })
            tid = str(uuid.uuid4())
            await db.transactions.insert_one({
                "id": tid, "company_id": cid,
                "merchant": "STAPLES CANADA", "amount": -10.0,
                "category_account_code": "6000",
                "category_account_name": "Office",
                "contact_id": None,
                "created_at": now_iso(), "updated_at": now_iso(),
            })
            res = await suggest_rules_from_txns(cid, {"transaction_ids": [tid]},
                user={"role": "pro"})
            assert res["proposals"] == []
            assert res["duplicates_skipped"] == 1
        finally:
            await _cleanup(cid)
    run(go())
