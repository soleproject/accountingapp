"""reclassify_contact_types — auto-classify contacts as customer / vendor /
both based on the direction of transactions that reference them.

Uses the shared-loop pattern so motor stays on one event loop across tests.
"""
import sys, uuid
sys.path.insert(0, "/app/backend")

from db import db, now_iso  # noqa: E402
from contact_resolver import reclassify_contact_types  # noqa: E402
from tests._shared_loop import run  # noqa: E402


async def _mk_contact(cid: str, name: str, type_val=None, type_source=None) -> str:
    xid = str(uuid.uuid4())
    doc = {
        "id": xid, "company_id": cid, "name": name,
        "normalized_name": name.lower().strip(),
        "created_at": now_iso(), "updated_at": now_iso(),
    }
    if type_val is not None: doc["type"] = type_val
    if type_source is not None: doc["type_source"] = type_source
    await db.contacts.insert_one(doc)
    return xid


async def _mk_txn(cid: str, contact_id: str, amount: float):
    await db.transactions.insert_one({
        "id": str(uuid.uuid4()), "company_id": cid, "contact_id": contact_id,
        "amount": amount, "date": "2026-01-01",
        "created_at": now_iso(), "updated_at": now_iso(),
    })


async def _cleanup(cid: str):
    await db.contacts.delete_many({"company_id": cid})
    await db.transactions.delete_many({"company_id": cid})


def test_customer_only_gets_customer_type():
    async def go():
        cid = f"rc-cust-{uuid.uuid4().hex[:8]}"
        try:
            xid = await _mk_contact(cid, "Alice")
            await _mk_txn(cid, xid, 500)  # money in only
            await _mk_txn(cid, xid, 250)
            summary = await reclassify_contact_types(cid)
            assert summary["updated"] == 1
            assert summary["customer"] == 1
            doc = await db.contacts.find_one({"id": xid})
            assert doc["type"] == "customer"
            assert doc["type_source"] == "auto"
        finally:
            await _cleanup(cid)
    run(go())


def test_vendor_only_gets_vendor_type():
    async def go():
        cid = f"rc-vend-{uuid.uuid4().hex[:8]}"
        try:
            xid = await _mk_contact(cid, "Bob")
            await _mk_txn(cid, xid, -100)  # money out only
            await _mk_txn(cid, xid, -50)
            summary = await reclassify_contact_types(cid)
            assert summary["vendor"] == 1
            doc = await db.contacts.find_one({"id": xid})
            assert doc["type"] == "vendor"
        finally:
            await _cleanup(cid)
    run(go())


def test_mixed_signs_gets_both():
    async def go():
        cid = f"rc-both-{uuid.uuid4().hex[:8]}"
        try:
            xid = await _mk_contact(cid, "Carol")
            await _mk_txn(cid, xid, 200)   # money in
            await _mk_txn(cid, xid, -75)   # money out
            summary = await reclassify_contact_types(cid)
            assert summary["both"] == 1
            doc = await db.contacts.find_one({"id": xid})
            assert doc["type"] == "both"
        finally:
            await _cleanup(cid)
    run(go())


def test_manual_tag_is_preserved():
    async def go():
        cid = f"rc-manl-{uuid.uuid4().hex[:8]}"
        try:
            # Contact was manually tagged as vendor. Even though all
            # transactions are inflows, we must NOT flip it to customer.
            xid = await _mk_contact(cid, "Dave", type_val="vendor")  # no type_source → manual
            await _mk_txn(cid, xid, 500)
            summary = await reclassify_contact_types(cid, respect_manual=True)
            assert summary["updated"] == 0
            doc = await db.contacts.find_one({"id": xid})
            assert doc["type"] == "vendor"   # unchanged
        finally:
            await _cleanup(cid)
    run(go())


def test_previously_auto_gets_reclassified():
    async def go():
        cid = f"rc-auto-{uuid.uuid4().hex[:8]}"
        try:
            # Previously auto-classified as vendor. New refund inflow
            # should promote it to "both".
            xid = await _mk_contact(cid, "Eve", type_val="vendor", type_source="auto")
            await _mk_txn(cid, xid, -300)   # original outflow
            await _mk_txn(cid, xid, 50)     # new refund inflow
            summary = await reclassify_contact_types(cid, respect_manual=True)
            assert summary["updated"] == 1
            doc = await db.contacts.find_one({"id": xid})
            assert doc["type"] == "both"
        finally:
            await _cleanup(cid)
    run(go())


def test_no_transactions_leaves_alone():
    async def go():
        cid = f"rc-none-{uuid.uuid4().hex[:8]}"
        try:
            xid = await _mk_contact(cid, "Frank")  # untyped, no txns
            summary = await reclassify_contact_types(cid)
            assert summary["no_txn"] == 1
            assert summary["updated"] == 0
            doc = await db.contacts.find_one({"id": xid})
            assert doc.get("type") in (None, "")   # still untyped
        finally:
            await _cleanup(cid)
    run(go())
