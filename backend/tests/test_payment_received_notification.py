"""Merchant "you got paid" notification (Feb 2026).

Verifies `_notify_merchant_of_payment` fires three channels:
- inserts a `payment_received` row into `db.notifications` for the owner
- attempts a celebratory email via `email_service.send_email`
- surfaces the payment in `_recent_activity()` ribbon
- dedupes so the webhook + Direct Post response can't double-notify
"""
from __future__ import annotations
import sys
import uuid
from decimal import Decimal
from unittest.mock import AsyncMock, patch

sys.path.insert(0, "/app/backend")

from db import db  # noqa
from auth import hash_password  # noqa
from tests._shared_loop import run as _run  # noqa


async def _mk_env():
    uid = str(uuid.uuid4())
    cid = str(uuid.uuid4())
    inv_id = str(uuid.uuid4())
    await db.users.insert_one({
        "id": uid,
        "email": f"m_{uid[:6]}@example.com",
        "password": hash_password("x"),
        "role": "client",
        "name": "Merchant Owner",
    })
    await db.companies.insert_one({
        "id": cid, "name": "Cha-Ching Co.",
        "owner_user_id": uid, "reporting_basis": "accrual",
    })
    await db.memberships.insert_one({
        "company_id": cid, "user_id": uid, "role": "owner",
    })
    await db.invoices.insert_one({
        "id": inv_id, "company_id": cid,
        "number": "INV-9001",
        "customer_name": "Acme Roasters",
        "customer_email": "buyer@acme.test",
        "currency": "USD",
    })
    return uid, cid, inv_id


async def _cleanup(uid, cid):
    for c in (
        "notifications", "invoices", "nmi_transactions",
        "memberships",
    ):
        if c == "memberships":
            await db[c].delete_many({"user_id": uid})
        else:
            await db[c].delete_many({"company_id": cid})
    await db.companies.delete_one({"id": cid})
    await db.users.delete_one({"id": uid})


def test_notify_merchant_of_payment_fires_all_channels():
    async def _t():
        uid, cid, inv_id = await _mk_env()
        try:
            from routes.payments_gateway import _notify_merchant_of_payment

            nmi_txn_id = "nmitxn_" + uuid.uuid4().hex[:10]
            # Seed the txn row so the dedupe update has something to hit.
            await db.nmi_transactions.insert_one({
                "id": str(uuid.uuid4()),
                "company_id": cid,
                "invoice_id": inv_id,
                "nmi_transaction_id": nmi_txn_id,
                "amount": 1250.00,
                "status": "approved",
                "method": "card",
                "created_at": "2026-09-23T12:00:00+00:00",
            })
            inv = await db.invoices.find_one({"id": inv_id}, {"_id": 0})

            with patch(
                "routes.payments_gateway.send_email",
                new_callable=AsyncMock,
                create=True,
            ) as mock_send:
                # Re-target: `send_email` is imported *inside* the helper,
                # so patch the source module instead.
                pass
            with patch("email_service.send_email", new_callable=AsyncMock) as mock_send:
                await _notify_merchant_of_payment(
                    cid=cid, inv=inv, amount=Decimal("1250.00"),
                    method="card", nmi_txn_id=nmi_txn_id,
                    customer_email="buyer@acme.test",
                )
                # Email fired once.
                assert mock_send.await_count == 1, mock_send.await_args_list
                kwargs = mock_send.await_args.kwargs
                assert "1,250.00" in kwargs["subject"]
                assert "Acme Roasters" in kwargs["subject"]

            # In-app bell row for the owner.
            n_rows = await db.notifications.find(
                {"company_id": cid, "user_id": uid, "kind": "payment_received"}
            ).to_list(10)
            assert len(n_rows) == 1
            row = n_rows[0]
            assert "1,250.00" in row["title"]
            assert "Acme Roasters" in row["body"]
            assert row["link"] == f"/invoices/{inv_id}"

            # Dedupe: firing again must be a no-op (no new email, no new row).
            with patch("email_service.send_email", new_callable=AsyncMock) as mock_send2:
                await _notify_merchant_of_payment(
                    cid=cid, inv=inv, amount=Decimal("1250.00"),
                    method="card", nmi_txn_id=nmi_txn_id,
                )
                assert mock_send2.await_count == 0
            n_rows2 = await db.notifications.count_documents(
                {"company_id": cid, "user_id": uid, "kind": "payment_received"}
            )
            assert n_rows2 == 1

            # Activity ribbon surfaces the payment.
            from routes.home_dashboard import _recent_activity
            items = await _recent_activity(cid, limit=20)
            pay_rows = [i for i in items if i["kind"] == "payment_received"]
            assert len(pay_rows) == 1
            assert "Acme Roasters" in pay_rows[0]["body"]
            assert "1,250.00" in pay_rows[0]["body"]
            assert "#INV-9001" in pay_rows[0]["body"]
        finally:
            await _cleanup(uid, cid)

    _run(_t())


def test_notify_kind_registered():
    """`payment_received` must be in the accepted kinds set or notify()
    silently drops it."""
    from routes.notifications import _KINDS
    assert "payment_received" in _KINDS
