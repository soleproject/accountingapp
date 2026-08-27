"""QBO Class Read-Sync (Feb 2026 Phase 2).

Verifies:
  1. `sync_qbo_classes()` creates Axiom `classes` rows from every
     unique `qbo_class_id` on imported lines.
  2. Existing local classes get their `qbo_id` stamped when a case-
     insensitive name match is found (no dupes).
  3. Parent docs (invoices / bills / txns) get `class_id` from the
     first line that carried a QBO class ref.
  4. Journal-entry lines get per-line `class_id`.
  5. The sync is idempotent — re-running is a no-op.
"""
from __future__ import annotations

import sys
import uuid

sys.path.insert(0, "/app/backend")

from db import db  # noqa: E402
from qbo_class_sync import sync_qbo_classes  # noqa: E402
from tests._shared_loop import run as _run  # noqa: E402


async def _mk_company() -> str:
    cid = str(uuid.uuid4())
    await db.companies.insert_one({
        "id": cid, "name": "QBO Class Sync Co",
        "reporting_basis": "accrual",
    })
    return cid


async def _cleanup(cid: str):
    for coll in ("classes", "invoices", "bills", "transactions",
                 "journal_entries", "payments", "receipts", "estimates"):
        await db[coll].delete_many({"company_id": cid})
    await db.companies.delete_one({"id": cid})


def test_sync_creates_classes_from_qbo_ids():
    async def _t():
        cid = await _mk_company()
        try:
            # Import an invoice with two lines under two different QBO classes.
            await db.invoices.insert_one({
                "id": str(uuid.uuid4()), "company_id": cid, "source": "qbo",
                "date": "2026-02-10",
                "lines": [
                    {"amount": 100, "qbo_class_id": "1",
                     "qbo_class_name": "West Coast"},
                    {"amount":  50, "qbo_class_id": "2",
                     "qbo_class_name": "East Coast"},
                ],
            })
            # Import a bill under the same "West Coast" class → must
            # reuse the row created for the invoice.
            await db.bills.insert_one({
                "id": str(uuid.uuid4()), "company_id": cid, "source": "qbo",
                "date": "2026-02-11",
                "lines": [
                    {"amount": 25, "qbo_class_id": "1",
                     "qbo_class_name": "West Coast"},
                ],
            })

            stats = await sync_qbo_classes(cid)
            assert stats["classes_touched"] == 2
            assert stats["invoices"] == 1
            assert stats["bills"] == 1

            classes = await db.classes.find({"company_id": cid}).to_list(20)
            assert len(classes) == 2
            names = sorted(c["name"] for c in classes)
            assert names == ["East Coast", "West Coast"]
            # Every synced class carries its QBO ref + source stamp.
            for c in classes:
                assert c["source"] == "qbo"
                assert c["qbo_id"] in {"1", "2"}
                assert c["active"] is True
        finally:
            await _cleanup(cid)

    _run(_t())


def test_sync_adopts_existing_local_class_by_name():
    """A user manually creating "Sales" then connecting QBO where the
    same-named class exists should MERGE — one row, both refs."""
    async def _t():
        cid = await _mk_company()
        try:
            # Preexisting manual class (no qbo_id yet).
            local_id = str(uuid.uuid4())
            await db.classes.insert_one({
                "id": local_id, "company_id": cid,
                "name": "Sales", "active": True,
            })
            await db.invoices.insert_one({
                "id": str(uuid.uuid4()), "company_id": cid, "source": "qbo",
                "date": "2026-02-10",
                "lines": [{"amount": 100, "qbo_class_id": "42",
                            "qbo_class_name": "sales"}],  # case diff
            })
            await sync_qbo_classes(cid)
            # No dup — still one row.
            rows = await db.classes.find({"company_id": cid}).to_list(20)
            assert len(rows) == 1
            # Same id (adopted, not replaced).
            assert rows[0]["id"] == local_id
            # qbo_id stamped for future runs.
            assert rows[0]["qbo_id"] == "42"
        finally:
            await _cleanup(cid)

    _run(_t())


def test_sync_stamps_class_id_on_parent_and_je_lines():
    async def _t():
        cid = await _mk_company()
        try:
            inv_id = str(uuid.uuid4())
            await db.invoices.insert_one({
                "id": inv_id, "company_id": cid, "source": "qbo",
                "date": "2026-02-10",
                "lines": [
                    {"amount": 100, "qbo_class_id": "1",
                     "qbo_class_name": "West"},
                ],
            })
            # JE with two lines under two different classes.
            je_id = str(uuid.uuid4())
            await db.journal_entries.insert_one({
                "id": je_id, "company_id": cid, "source": "qbo",
                "date": "2026-02-15",
                "lines": [
                    {"account_id": "a1", "debit": 100, "credit": 0,
                     "qbo_class_id": "1", "qbo_class_name": "West"},
                    {"account_id": "a2", "debit": 0,   "credit": 100,
                     "qbo_class_id": "2", "qbo_class_name": "East"},
                ],
            })
            await sync_qbo_classes(cid)

            classes = await db.classes.find({"company_id": cid}).to_list(20)
            by_qbo = {c["qbo_id"]: c["id"] for c in classes}

            # Invoice header carries class_id from first ref.
            inv = await db.invoices.find_one({"id": inv_id})
            assert inv["class_id"] == by_qbo["1"]

            # JE lines each carry their own class_id.
            je = await db.journal_entries.find_one({"id": je_id})
            assert je["lines"][0]["class_id"] == by_qbo["1"]
            assert je["lines"][1]["class_id"] == by_qbo["2"]
        finally:
            await _cleanup(cid)

    _run(_t())


def test_sync_is_idempotent():
    async def _t():
        cid = await _mk_company()
        try:
            await db.invoices.insert_one({
                "id": str(uuid.uuid4()), "company_id": cid, "source": "qbo",
                "date": "2026-02-10",
                "lines": [{"amount": 100, "qbo_class_id": "1",
                            "qbo_class_name": "West"}],
            })
            first = await sync_qbo_classes(cid)
            second = await sync_qbo_classes(cid)
            # Second run finds the class already stamped everywhere,
            # so no updates fire (invoices=0 on the re-run).
            assert first["invoices"] == 1
            assert second.get("invoices", 0) == 0
            # And still exactly one class row.
            rows = await db.classes.count_documents({"company_id": cid})
            assert rows == 1
        finally:
            await _cleanup(cid)

    _run(_t())
