"""Regression test — QBO Sales Tax Payment synthesizer (Feb 28 2026).

QBO's REST API doesn't expose `SalesTaxPayment` as a queryable entity,
so those postings never make it into our `payments` / `transactions`
collections during import. Result on Craig's Landscaping sandbox:
Checking was $76.90 too high and BoE + AZ Payables were also inflated
by the un-CR'd $38.50 and $38.40 payment postings.

`resolve_qbo_sales_tax_payments` walks the GL for each
`GlobalTaxPayable` account, picks up every "Sales Tax Payment" DR
posting, and posts a matching JE that DR's the payable / CR's the
funding bank.

This test monkey-patches `fetch_report` to return a canned GL payload
so we can verify the JE is produced with the right shape and idempotency.
"""
from __future__ import annotations

import sys
import uuid
from datetime import datetime, timezone

sys.path.insert(0, "/app/backend")

from db import db  # noqa: E402
from tests._shared_loop import run as _run  # noqa: E402


async def _seed(cid, aid, qbo_id, name, _type, detail_type="",
                 sub_type=None):
    now = datetime.now(timezone.utc).isoformat()
    doc = {
        "id": aid, "company_id": cid, "qbo_id": qbo_id, "source": "qbo",
        "code": "", "name": name, "type": _type,
        "detail_type": detail_type, "active": True,
        "balance": 0.0, "created_at": now, "updated_at": now,
    }
    if sub_type:
        doc["raw"] = {"AccountSubType": sub_type}
    await db.accounts.insert_one(doc)


async def _cleanup(cid):
    for coll in (db.companies, db.accounts, db.journal_entries,
                 db.qbo_connections):
        await coll.delete_many({"company_id": cid})


def _fake_gl(rows):
    return {"Rows": {"Row": rows}}


def _make_gl_data_row(date, split, amount, txn_type="Sales Tax Payment"):
    return {"ColData": [
        {"value": date},           # date
        {"value": txn_type},       # txn_type
        {"value": "STP-1"},        # doc_num
        {"value": ""},             # name
        {"value": "Sales Tax"},    # memo
        {"value": split},          # split_account
        {"value": str(amount)},    # amount
        {"value": "0"},            # balance
    ]}


def test_sales_tax_payment_synthesizer_posts_matched_je():
    """GL contains a Sales Tax Payment DR of $38.50 (amount = -38.50
    on a credit-normal liability). Synthesizer should post a JE that
    DR's the tax payable $38.50 / CR's Checking $38.50."""
    async def go():
        cid = str(uuid.uuid4())
        await db.companies.insert_one({"id": cid, "name": "STP Co"})
        await db.qbo_connections.insert_one({
            "company_id": cid, "realm_id": "test-realm-1",
        })
        await _seed(cid, "acct-boe", "90",
                     "Board of Equalization Payable",
                     "liability", sub_type="GlobalTaxPayable")
        await _seed(cid, "acct-check", "35", "Checking",
                     "asset", detail_type="cash_and_bank")

        import qbo_service

        async def fake_fetch_report(company_id, realm, report_name,
                                      params):
            # Only return data on the BoE account query.
            if params.get("account") == "90":
                return _fake_gl([
                    _make_gl_data_row("2026-02-15", "Checking", -38.50),
                ])
            return _fake_gl([])

        orig = qbo_service.fetch_report
        qbo_service.fetch_report = fake_fetch_report
        try:
            result = await qbo_service.resolve_qbo_sales_tax_payments(cid)
            assert result.get("lines_added") == 2, result
            # Confirm JE exists with correct DR/CR shape.
            je = await db.journal_entries.find_one({
                "company_id": cid,
                "id": {"$regex": "^qbo-sales-tax-payments-"},
            })
            assert je is not None, "expected synthesized JE"
            lines = je["lines"]
            dr = next(l for l in lines if l["debit"] > 0)
            cr = next(l for l in lines if l["credit"] > 0)
            assert dr["account_id"] == "acct-boe", dr
            assert abs(dr["debit"] - 38.50) < 0.01
            assert cr["account_id"] == "acct-check", cr
            assert abs(cr["credit"] - 38.50) < 0.01
        finally:
            qbo_service.fetch_report = orig
            await _cleanup(cid)

    _run(go())


def test_sales_tax_payment_synthesizer_is_idempotent():
    """Running the resolver twice must NOT double-post the JE."""
    async def go():
        cid = str(uuid.uuid4())
        await db.companies.insert_one({"id": cid, "name": "STP Idem Co"})
        await db.qbo_connections.insert_one({
            "company_id": cid, "realm_id": "test-realm-2",
        })
        await _seed(cid, "acct-boe2", "90",
                     "Board of Equalization Payable",
                     "liability", sub_type="GlobalTaxPayable")
        await _seed(cid, "acct-check2", "35", "Checking",
                     "asset", detail_type="cash_and_bank")

        import qbo_service

        async def fake_fetch_report(company_id, realm, report_name,
                                      params):
            if params.get("account") == "90":
                return _fake_gl([
                    _make_gl_data_row("2026-02-15", "Checking", -38.50),
                ])
            return _fake_gl([])

        orig = qbo_service.fetch_report
        qbo_service.fetch_report = fake_fetch_report
        try:
            await qbo_service.resolve_qbo_sales_tax_payments(cid)
            await qbo_service.resolve_qbo_sales_tax_payments(cid)
            count = await db.journal_entries.count_documents({
                "company_id": cid,
                "id": {"$regex": "^qbo-sales-tax-payments-"},
            })
            assert count == 1, f"expected 1 JE, got {count}"
        finally:
            qbo_service.fetch_report = orig
            await _cleanup(cid)

    _run(go())


def test_sales_tax_payment_synthesizer_skips_credits():
    """Only DR postings (negative amounts on the payable) are payments.
    Credit postings (invoice accruals) must be ignored."""
    async def go():
        cid = str(uuid.uuid4())
        await db.companies.insert_one({"id": cid, "name": "STP Skip Co"})
        await db.qbo_connections.insert_one({
            "company_id": cid, "realm_id": "test-realm-3",
        })
        await _seed(cid, "acct-boe3", "90",
                     "Board of Equalization Payable",
                     "liability", sub_type="GlobalTaxPayable")
        await _seed(cid, "acct-check3", "35", "Checking",
                     "asset", detail_type="cash_and_bank")

        import qbo_service

        async def fake_fetch_report(company_id, realm, report_name,
                                      params):
            if params.get("account") == "90":
                return _fake_gl([
                    # Positive amount = credit accrual from invoice → skip
                    _make_gl_data_row("2026-02-05", "Sales", 8.0,
                                       txn_type="Invoice"),
                    # Wrong txn_type but negative → still skip
                    _make_gl_data_row("2026-02-10", "Checking", -5.0,
                                       txn_type="Journal Entry"),
                    # Payment we DO want to synthesize
                    _make_gl_data_row("2026-02-15", "Checking", -38.50),
                ])
            return _fake_gl([])

        orig = qbo_service.fetch_report
        qbo_service.fetch_report = fake_fetch_report
        try:
            result = await qbo_service.resolve_qbo_sales_tax_payments(cid)
            # Only 1 real payment × 2 lines = 2 lines
            assert result.get("lines_added") == 2, result
        finally:
            qbo_service.fetch_report = orig
            await _cleanup(cid)

    _run(go())


def test_sales_tax_payment_synthesizer_no_connection_noop():
    """No QBO connection → no-op with reason."""
    async def go():
        cid = str(uuid.uuid4())
        await db.companies.insert_one({"id": cid, "name": "STP NoConn Co"})
        try:
            import qbo_service
            result = await qbo_service.resolve_qbo_sales_tax_payments(cid)
            assert result.get("lines_added") == 0
            assert result.get("reason") == "no_connection"
        finally:
            await _cleanup(cid)

    _run(go())


def test_sales_tax_payment_synthesizer_matches_split_via_bank_gl():
    """Real-world Craig's Landscaping case: QBO shows `split='-Split-'`
    on both the payable side and the bank side when the STP carries an
    additional expense line (bank fee, etc.). The synthesizer must
    two-sided match by (date, amount) between the payable GL and the
    bank GL, not rely on the `split` column."""
    async def go():
        cid = str(uuid.uuid4())
        await db.companies.insert_one({"id": cid, "name": "STP Split Co"})
        await db.qbo_connections.insert_one({
            "company_id": cid, "realm_id": "test-realm-split",
        })
        await _seed(cid, "acct-boe-sp", "90",
                     "Board of Equalization Payable",
                     "liability", sub_type="GlobalTaxPayable")
        await _seed(cid, "acct-check-sp", "35", "Checking",
                     "asset", detail_type="cash_and_bank")

        import qbo_service

        async def fake_fetch_report(company_id, realm, report_name,
                                      params):
            acct = params.get("account")
            if acct == "90":  # BoE payable — DR side, split="-Split-"
                return _fake_gl([
                    _make_gl_data_row("2026-06-07", "-Split-", -38.50),
                ])
            if acct == "35":  # Checking — CR side, also "-Split-"
                return _fake_gl([
                    _make_gl_data_row("2026-06-07", "-Split-", -38.50),
                ])
            return _fake_gl([])

        orig = qbo_service.fetch_report
        qbo_service.fetch_report = fake_fetch_report
        try:
            result = await qbo_service.resolve_qbo_sales_tax_payments(cid)
            assert result.get("lines_added") == 2, result
            je = await db.journal_entries.find_one({
                "company_id": cid,
                "id": {"$regex": "^qbo-sales-tax-payments-"},
            })
            assert je is not None
            dr = next(l for l in je["lines"] if l["debit"] > 0)
            cr = next(l for l in je["lines"] if l["credit"] > 0)
            assert dr["account_id"] == "acct-boe-sp", dr
            assert cr["account_id"] == "acct-check-sp", cr
            assert abs(dr["debit"] - 38.50) < 0.01
            assert abs(cr["credit"] - 38.50) < 0.01
        finally:
            qbo_service.fetch_report = orig
            await _cleanup(cid)

    _run(go())
