"""End-to-end regression: writes on the four newly-instrumented
entities land in `audit_events`.

Covers the Feb 2026 audit expansion (Phase 2): invoices, bills,
journal entries, and chart-of-accounts.

We do everything inside a single event loop (`asyncio.run` per test)
because pytest-asyncio spawns a fresh loop per test but our shared
`motor` client is bound to whichever loop touched it first — running
each test in its own top-level `asyncio.run` sidesteps the "Event loop
is closed" cross-contamination.
"""
import asyncio

import audit


AUDIT_CID = "co-audit-instr-test"


async def _wipe(db):
    await db.audit_events.delete_many({"company_id": AUDIT_CID})


def test_all_entity_instrumentation_writes():
    """Single top-level `asyncio.run` because our motor client is
    module-scoped and binds itself to the first event loop it sees —
    running multiple `@pytest.mark.asyncio` tests trips "Event loop is
    closed" on the second one. Consolidating all assertions into one
    coroutine keeps the loop alive for the whole check.
    """
    async def go():
        from db import db
        await _wipe(db)

        # ── Invoice: create + delete ───────────────────────────────
        audit.log_create(
            "invoice", "inv-1", {"id": "inv-1", "number": "INV-100", "total": 250.0},
            actor={"id": "u1", "email": "u@x", "role": "pro"},
            company_id=AUDIT_CID,
            summary="Invoice INV-100 · Acme · $250.00",
        )
        audit.log_delete(
            "invoice", "inv-1",
            {"id": "inv-1", "number": "INV-100", "total": 250.0,
             "line_items": [{"desc": "x", "amount": 250}]},
            actor={"id": "u1", "email": "u@x", "role": "pro"},
            company_id=AUDIT_CID,
            summary="Deleted invoice INV-100",
        )

        # ── Bill: routine update — diff-only path ──────────────────
        audit.log_update(
            "bill", "bill-1",
            {"id": "bill-1", "number": "BILL-1", "total": 100, "notes": "old"},
            {"id": "bill-1", "number": "BILL-1", "total": 100, "notes": "new"},
            actor={"id": "u1", "email": "u@x", "role": "pro"},
            company_id=AUDIT_CID,
            summary="Bill BILL-1 updated",
        )

        # ── Account (CoA) update — full-snapshot path ──────────────
        audit.log_update(
            "account", "acct-1",
            {"id": "acct-1", "code": "6000", "name": "Meals", "type": "expense"},
            {"id": "acct-1", "code": "6000", "name": "Meals & Entertainment", "type": "expense"},
            actor={"id": "u1", "email": "u@x", "role": "pro"},
            company_id=AUDIT_CID,
            summary="CoA edit",
        )

        # ── Journal entry delete — full snapshot preserves lines ───
        audit.log_delete(
            "journal_entry", "je-1",
            {
                "id": "je-1", "date": "2026-01-15", "memo": "March rent",
                "lines": [
                    {"account_id": "6700", "debit": 5000, "credit": 0},
                    {"account_id": "1010", "debit": 0, "credit": 5000},
                ],
                "total_debit": 5000, "total_credit": 5000,
            },
            actor={"id": "u1", "email": "u@x", "role": "pro"},
            company_id=AUDIT_CID,
        )

        # Drain fire-and-forget writes scheduled on this loop.
        await asyncio.sleep(0.2)

        # ── Assertions ─────────────────────────────────────────────
        # Invoice
        inv_rows = await db.audit_events.find(
            {"entity_type": "invoice", "company_id": AUDIT_CID}
        ).to_list(10)
        assert sorted(r["event_type"] for r in inv_rows) == ["create", "delete"]
        inv_del = next(r for r in inv_rows if r["event_type"] == "delete")
        hy = audit.hydrate_event(inv_del)
        assert hy["before"]["line_items"][0]["desc"] == "x"

        # Bill — diff-only shape
        bill_row = await db.audit_events.find_one(
            {"entity_type": "bill", "event_type": "update", "company_id": AUDIT_CID}
        )
        assert bill_row is not None
        assert bill_row.get("before_z") is None
        assert bill_row.get("after_z") is None
        assert bill_row.get("diff_z") is not None
        assert audit.hydrate_event(bill_row)["diff"] == {"notes": ["old", "new"]}

        # Account — full-snapshot shape (before + after; diff derived)
        acct_row = await db.audit_events.find_one(
            {"entity_type": "account", "event_type": "update", "company_id": AUDIT_CID}
        )
        assert acct_row is not None
        assert acct_row.get("before_z") is not None
        assert acct_row.get("after_z") is not None
        assert audit.hydrate_event(acct_row)["diff"] == {
            "name": ["Meals", "Meals & Entertainment"]
        }

        # JE — every debit/credit leg survived the snapshot round-trip
        je_row = await db.audit_events.find_one(
            {"entity_type": "journal_entry", "event_type": "delete", "company_id": AUDIT_CID}
        )
        hy = audit.hydrate_event(je_row)
        assert len(hy["before"]["lines"]) == 2
        assert hy["before"]["lines"][0]["debit"] == 5000

        await _wipe(db)
    asyncio.run(go())
