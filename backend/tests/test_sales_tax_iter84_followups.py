"""Iter-84 review-comment follow-ups.

* `/tax-liability` must include liability accounts referenced via
  `taxes.payable_account_id` even when they don't match the STP
  name/detail-type filter.
* Deleting an invoice must be blocked with 409 when a tax-payment
  dated on/after that invoice's issue_date exists, so the STP
  balance can't be pushed negative by an orphan DR.
"""
import os
import uuid
import pytest
from tests._shared_loop import run as _run
from db import db
from datetime import datetime, timezone

import requests

BASE = os.environ.get("REACT_APP_BACKEND_URL").rstrip("/")


def _now():
    return datetime.now(timezone.utc).isoformat()


@pytest.fixture(scope="module")
def session():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    r = s.post(f"{BASE}/api/auth/login",
               json={"email": "client@axiom.ai", "password": "client123"})
    tok = r.json().get("token") or r.json().get("access_token")
    s.headers.update({"Authorization": f"Bearer {tok}"})
    return s


@pytest.fixture(scope="module")
def cid(session):
    r = session.get(f"{BASE}/api/companies")
    return (r.json().get("companies") or [])[0]["id"]


def test_liability_includes_custom_payable_link(session, cid):
    """After linking a custom liability account to a tax rate, that
    account's balance should appear in /tax-liability even without
    an STP-shaped name/detail_type."""
    # Create a custom liability account WITHOUT a tax-payable name so
    # the STP regex won't match on its own.
    r = session.get(f"{BASE}/api/companies/{cid}/accounts")
    existing_names = {a["name"] for a in r.json().get("accounts") or []}
    custom_name = "State Franchise Board Payable · iter84"
    if custom_name not in existing_names:
        # Direct DB insert — no public route for creating an account.
        async def _mk():
            await db.accounts.insert_one({
                "id": f"acct-iter84-{uuid.uuid4().hex[:8]}",
                "company_id": cid, "name": custom_name,
                "type": "liability", "subtype": "current_liability",
                "created_at": _now(),
            })
        _run(_mk())
    r = session.get(f"{BASE}/api/companies/{cid}/accounts")
    liab_id = next(a["id"] for a in r.json()["accounts"] if a["name"] == custom_name)

    # Create a tax rate linked to that account.
    tname = f"State FB · iter84 · {uuid.uuid4().hex[:4]}"
    r = session.post(f"{BASE}/api/companies/{cid}/taxes",
                     json={"name": tname, "rate": 7.5,
                            "payable_account_id": liab_id})
    assert r.status_code == 200, r.text

    # Even with zero balance, the account should appear in liability.
    r = session.get(f"{BASE}/api/companies/{cid}/tax-liability")
    assert r.status_code == 200
    ids = [a["id"] for a in r.json().get("accounts", [])]
    assert liab_id in ids, (
        f"custom payable {liab_id} missing from /tax-liability. "
        f"Present: {ids}"
    )


def test_delete_blocks_when_tax_payment_exists(session, cid):
    """Invoice DELETE returns 409 when a tax-payment dated on/after
    the invoice's issue_date has already been recorded."""
    # Ensure at least one tax payment exists dated 2026-02-28.
    r = session.get(f"{BASE}/api/companies/{cid}/tax-payments")
    if not r.json().get("payments"):
        lib = session.get(f"{BASE}/api/companies/{cid}/tax-liability").json()
        stp_id = lib["accounts"][0]["id"] if lib.get("accounts") else None
        accts = session.get(f"{BASE}/api/companies/{cid}/accounts").json()
        bank_id = next(a["id"] for a in accts["accounts"] if a["type"] == "asset")
        if stp_id:
            session.post(
                f"{BASE}/api/companies/{cid}/tax-payments",
                json={"payable_account_id": stp_id, "bank_account_id": bank_id,
                       "amount": 1.00, "date": "2026-02-28",
                       "memo": "iter84 payment"},
            )
    # Create an invoice on 2026-02-01 (before the payment) with tax.
    r = session.get(f"{BASE}/api/companies/{cid}/taxes")
    tax_id = (r.json().get("taxes") or [])[0]["id"]
    r = session.post(
        f"{BASE}/api/companies/{cid}/invoices",
        json={
            "contact_name": "iter84 delete guard",
            "issue_date": "2026-02-01", "due_date": "2026-03-01",
            "line_items": [{"description": "d", "quantity": 1,
                             "rate": 100, "amount": 100,
                             "tax_id": tax_id, "tax_rate": 10}],
            "tax": 0, "shipping": 0, "discount": 0,
            "status": "draft",
        },
    )
    assert r.status_code == 200, r.text
    iid = r.json()["invoice"]["id"]
    r = session.delete(f"{BASE}/api/companies/{cid}/invoices/{iid}")
    # Expect 409 because a later tax-payment exists.
    assert r.status_code == 409, (
        f"expected 409 (blocked delete), got {r.status_code}: {r.text}"
    )
