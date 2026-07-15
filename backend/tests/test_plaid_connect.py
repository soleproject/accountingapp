"""Standalone test for plaid_connect module: dedup logic + opening balance JE."""
import asyncio
import sys
import uuid
sys.path.insert(0, "/app/backend")

from db import db, now_iso
import plaid_connect


async def _fake_categorize(merchant, amount, desc, coa):
    return {"account_code": "9999", "confidence": 0.9,
            "reasoning": "test-fake", "needs_review": False}


async def _fake_period_closed(cid, d):
    return False


async def setup_test_company():
    cid = f"test-{uuid.uuid4()}"
    now = now_iso()
    # Minimal CoA
    for code, name, t, st in [
        ("1010", "Business Checking", "asset", "current_asset"),
        ("1020", "Business Savings", "asset", "current_asset"),
        ("2100", "Credit Card Payable", "liability", "current_liability"),
        ("9999", "Uncategorized", "expense", "operating_expense"),
    ]:
        await db.accounts.insert_one({
            "id": str(uuid.uuid4()), "company_id": cid,
            "code": code, "name": name, "type": t, "subtype": st,
            "created_at": now, "updated_at": now,
        })
    await db.companies.insert_one({
        "id": cid, "name": "TestCo", "created_at": now, "updated_at": now,
    })
    return cid


async def teardown(cid):
    await db.accounts.delete_many({"company_id": cid})
    await db.transactions.delete_many({"company_id": cid})
    await db.journal_entries.delete_many({"company_id": cid})
    await db.plaid_items.delete_many({"company_id": cid})
    await db.companies.delete_one({"id": cid})


async def test_opening_balance_asset():
    cid = await setup_test_company()
    try:
        # Insert a Plaid item with 3 accounts (1 checking, 1 savings, 1 credit card)
        item_id = str(uuid.uuid4())
        item = {
            "id": item_id, "company_id": cid, "user_id": "test",
            "item_id": "item_test", "access_token": "access_test",
            "cursor": None,
            "accounts": [
                {"account_id": "pl_chk", "name": "Checking", "mask": "0001",
                 "type": "depository", "subtype": "checking", "balance_current": 12345.67},
                {"account_id": "pl_sav", "name": "Savings", "mask": "0002",
                 "type": "depository", "subtype": "savings", "balance_current": 50000.00},
                {"account_id": "pl_cc", "name": "Card", "mask": "0003",
                 "type": "credit", "subtype": "credit card", "balance_current": 1500.00},
            ],
            "created_at": now_iso(), "updated_at": now_iso(),
        }
        await db.plaid_items.insert_one(item)

        # === Test 1: resolve_ledger_for_plaid ===
        chk_code, _, _, _ = plaid_connect.resolve_ledger_for_plaid(item["accounts"][0])
        sav_code, _, _, _ = plaid_connect.resolve_ledger_for_plaid(item["accounts"][1])
        cc_code, _, cc_type, _ = plaid_connect.resolve_ledger_for_plaid(item["accounts"][2])
        assert chk_code == "1010", f"expected 1010, got {chk_code}"
        assert sav_code == "1020", f"expected 1020, got {sav_code}"
        assert cc_code == "2100", f"expected 2100, got {cc_code}"
        assert cc_type == "liability"
        print("✓ Test 1 pass: subtype mapping")

        # === Test 2: OBE creation ===
        obe = await plaid_connect.ensure_opening_balance_equity(cid)
        assert obe["code"] == "3050"
        assert obe["type"] == "equity"
        # idempotent
        obe2 = await plaid_connect.ensure_opening_balance_equity(cid)
        assert obe["id"] == obe2["id"]
        print("✓ Test 2 pass: OBE 3050 auto-created & idempotent")

        # === Test 3: Opening balance JE (asset) ===
        chk = await db.accounts.find_one({"company_id": cid, "code": "1010"})
        je_id = await plaid_connect.post_opening_balance_je(
            cid, chk, 10000.00, "2026-01-01", "Test opening",
        )
        assert je_id is not None
        je = await db.journal_entries.find_one({"id": je_id})
        assert len(je["lines"]) == 2
        # asset side: Dr bank
        bank_line = next(ln for ln in je["lines"] if ln["account_id"] == chk["id"])
        obe_line = next(ln for ln in je["lines"] if ln["account_id"] == obe["id"])
        assert bank_line["debit"] == 10000.0 and bank_line["credit"] == 0.0
        assert obe_line["credit"] == 10000.0 and obe_line["debit"] == 0.0
        print("✓ Test 3 pass: asset opening JE (Dr bank / Cr OBE)")

        # === Test 4: Opening balance JE (liability - credit card) ===
        cc = await db.accounts.find_one({"company_id": cid, "code": "2100"})
        je2 = await plaid_connect.post_opening_balance_je(
            cid, cc, 500.00, "2026-01-01", "Test opening CC",
        )
        je2doc = await db.journal_entries.find_one({"id": je2})
        cc_line = next(ln for ln in je2doc["lines"] if ln["account_id"] == cc["id"])
        obe_line = next(ln for ln in je2doc["lines"] if ln["account_id"] == obe["id"])
        assert cc_line["credit"] == 500.0 and cc_line["debit"] == 0.0
        assert obe_line["debit"] == 500.0 and obe_line["credit"] == 0.0
        print("✓ Test 4 pass: liability opening JE (Dr OBE / Cr CC)")

        # === Test 5: dedup — higher_source_ranges ===
        # Simulate QBO transactions on the checking account for Jan 2025
        await db.transactions.insert_many([
            {"id": str(uuid.uuid4()), "company_id": cid, "date": "2025-01-05",
             "bank_account_id": chk["id"], "source": "qbo", "amount": -100.0, "posted": True},
            {"id": str(uuid.uuid4()), "company_id": cid, "date": "2025-01-25",
             "bank_account_id": chk["id"], "source": "qbo", "amount": -50.0, "posted": True},
        ])
        ranges = await plaid_connect.higher_source_ranges(cid, chk["id"], "plaid")
        assert len(ranges) == 1, f"expected 1 range, got {ranges}"
        assert ranges[0] == ("2025-01-05", "2025-01-25")
        assert plaid_connect.in_any_range("2025-01-10", ranges) is True
        assert plaid_connect.in_any_range("2025-01-05", ranges) is True  # boundary
        assert plaid_connect.in_any_range("2025-01-25", ranges) is True  # boundary
        assert plaid_connect.in_any_range("2025-02-01", ranges) is False
        assert plaid_connect.in_any_range("2024-12-31", ranges) is False
        print("✓ Test 5 pass: source-of-truth dedup (QBO > Plaid)")

        # === Test 6: veryfi should be superseded by BOTH qbo and plaid ===
        await db.transactions.insert_one({
            "id": str(uuid.uuid4()), "company_id": cid, "date": "2025-03-15",
            "bank_account_id": chk["id"], "source": "plaid", "amount": -20.0, "posted": True,
        })
        v_ranges = await plaid_connect.higher_source_ranges(cid, chk["id"], "veryfi")
        # should include both QBO and Plaid ranges
        assert len(v_ranges) == 2, f"expected 2 ranges, got {v_ranges}"
        assert plaid_connect.in_any_range("2025-01-15", v_ranges) is True  # QBO range
        assert plaid_connect.in_any_range("2025-03-15", v_ranges) is True  # Plaid range
        assert plaid_connect.in_any_range("2025-04-01", v_ranges) is False
        print("✓ Test 6 pass: Veryfi superseded by both QBO and Plaid")

        # === Test 7: full connect_plaid_account flow ===
        # We must patch plaid_service.sync_transactions to avoid a real Plaid call
        import plaid_service
        original_sync = plaid_service.sync_transactions
        def fake_sync(access_token, cursor=None):
            return {
                "added": [
                    {"transaction_id": "t1", "account_id": "pl_sav",
                     "date": "2026-01-10", "name": "Interest", "merchant_name": "Bank",
                     "amount": 5.00, "pending": False, "category": [], "iso_currency_code": "USD"},
                    {"transaction_id": "t2", "account_id": "pl_sav",
                     "date": "2026-01-20", "name": "Deposit", "merchant_name": "Employer",
                     "amount": 1000.00, "pending": False, "category": [], "iso_currency_code": "USD"},
                    # This one is on a different plaid account and should NOT be pulled in
                    {"transaction_id": "t3", "account_id": "pl_chk",
                     "date": "2026-01-15", "name": "Rent", "merchant_name": "Landlord",
                     "amount": -1500.00, "pending": False, "category": [], "iso_currency_code": "USD"},
                ],
                "modified": [], "removed": [], "next_cursor": "cur_after",
            }
        plaid_service.sync_transactions = fake_sync
        try:
            result = await plaid_connect.connect_plaid_account(
                cid, item, "pl_sav",
                categorize_fn=_fake_categorize,
                is_period_closed_fn=_fake_period_closed,
            )
        finally:
            plaid_service.sync_transactions = original_sync
        assert result["ledger_account_code"] == "1020"
        assert result["imported"] == 2, f"expected 2 imported, got {result['imported']}"
        # Opening balance: current 50000, movement +1005; opening = 50000 - 1005 = 48995
        assert result["opening_balance"] == 48995.00, f"expected 48995.00, got {result['opening_balance']}"
        # opening date = day before oldest txn (2026-01-10) = 2026-01-09
        assert result["opening_as_of"] == "2026-01-09"
        # verify JE was posted
        obe_je = await db.journal_entries.find_one({"id": result["opening_je_id"]})
        assert obe_je is not None
        sav = await db.accounts.find_one({"company_id": cid, "code": "1020"})
        bank_line = next(ln for ln in obe_je["lines"] if ln["account_id"] == sav["id"])
        assert bank_line["debit"] == 48995.00
        # verify mapping persisted
        item_after = await db.plaid_items.find_one({"id": item["id"]})
        assert "pl_sav" in item_after["account_mappings"]
        assert item_after["account_mappings"]["pl_sav"]["ledger_account_code"] == "1020"
        # verify txns were routed to the savings account, not 1010
        sav_txns = await db.transactions.find({"company_id": cid, "bank_account_id": sav["id"]}).to_list(100)
        assert len(sav_txns) == 2
        assert all(t["source"] == "plaid" for t in sav_txns)
        print("✓ Test 7 pass: connect_plaid_account (opening $48,995.00 · 2 txns to 1020)")

        # === Test 8: connect_plaid_account for credit card with dedup ===
        # Insert QBO txns covering Feb 2026 on the CC ledger (range Feb 5..Feb 28)
        await db.transactions.insert_many([
            {"id": str(uuid.uuid4()), "company_id": cid, "date": "2026-02-05",
             "bank_account_id": cc["id"], "source": "qbo", "amount": -100.0, "posted": True},
            {"id": str(uuid.uuid4()), "company_id": cid, "date": "2026-02-28",
             "bank_account_id": cc["id"], "source": "qbo", "amount": -200.0, "posted": True},
        ])
        def fake_sync2(access_token, cursor=None):
            return {
                "added": [
                    # Feb 2026 CC txn — should be SKIPPED because QBO covers this period
                    {"transaction_id": "cc1", "account_id": "pl_cc",
                     "date": "2026-02-15", "name": "Amazon", "merchant_name": "Amazon",
                     "amount": -50.00, "pending": False, "category": [], "iso_currency_code": "USD"},
                    # Mar 2026 CC txn — should be imported
                    {"transaction_id": "cc2", "account_id": "pl_cc",
                     "date": "2026-03-05", "name": "Uber", "merchant_name": "Uber",
                     "amount": -25.00, "pending": False, "category": [], "iso_currency_code": "USD"},
                ],
                "modified": [], "removed": [], "next_cursor": "cur_z",
            }
        plaid_service.sync_transactions = fake_sync2
        try:
            r2 = await plaid_connect.connect_plaid_account(
                cid, item_after, "pl_cc",
                categorize_fn=_fake_categorize,
                is_period_closed_fn=_fake_period_closed,
            )
        finally:
            plaid_service.sync_transactions = original_sync
        assert r2["imported"] == 1, f"expected 1 imported for CC, got {r2['imported']}"
        assert r2["skipped"] == 1
        assert "superseded_by_higher_source" in r2["skipped_reasons"]
        print("✓ Test 8 pass: CC connect with QBO dedup (imported 1, skipped 1)")

        print("\n" + "="*60)
        print("ALL TESTS PASSED")
        print("="*60)
    finally:
        await teardown(cid)


if __name__ == "__main__":
    asyncio.run(test_opening_balance_asset())
