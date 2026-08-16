"""STT collision guard — "credit invoice" ≈ "create an invoice".

Feb 25 2026 fix — user reported that when the voice-input STT
mis-transcribed "create an invoice" as "credit invoice", the intent
classifier silently routed the utterance to the categorize-transaction
flow and returned "On it — categorizing to Uncategorized Income" without
actually creating the invoice OR the categorize action taking effect
where the user expected.

The fix intercepts any utterance containing "credit invoice" and
returns a `disambiguate_credit_or_create` intent. The frontend then
shows a two-button clarification instead of guessing.
"""
from __future__ import annotations

import sys
import uuid

sys.path.insert(0, "/app/backend")

from server import app  # noqa: E402
from db import db  # noqa: E402
from auth import create_token, hash_password  # noqa: E402
from tests._shared_loop import run as _run  # noqa: E402


async def _client():
    from httpx import AsyncClient, ASGITransport
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _mk_env():
    uid = str(uuid.uuid4())
    cid = str(uuid.uuid4())
    await db.users.insert_one({
        "id": uid, "email": f"pro_{uid[:6]}@fbtest-real.io",
        "password": hash_password("x"), "role": "pro",
    })
    await db.companies.insert_one({"id": cid, "name": "STT Test Co"})
    await db.memberships.insert_one({
        "user_id": uid, "company_id": cid, "role": "pro",
    })
    return create_token(uid, "pro"), cid, uid


async def _cleanup(uid, cid):
    await db.users.delete_one({"id": uid})
    await db.companies.delete_one({"id": cid})
    await db.memberships.delete_many({"user_id": uid})


def test_credit_invoice_returns_disambiguate_intent():
    """The utterance 'credit invoice for John Melton for $1,000' must
    trigger the STT collision guard and return the disambig intent —
    NOT silently route to categorize/JE/anything else."""
    async def _t():
        tok, cid, uid = await _mk_env()
        try:
            async with await _client() as c:
                r = await c.post(
                    f"/api/companies/{cid}/ai/parse-intent",
                    headers={"Authorization": f"Bearer {tok}"},
                    json={"text": "credit invoice for John Melton for $1,000"},
                )
            assert r.status_code == 200, r.text
            body = r.json()
            assert body["intent"] == "disambiguate_credit_or_create"
            assert len(body["options"]) == 2
            keys = {o["key"] for o in body["options"]}
            assert "create_invoice" in keys
            assert "credit_memo_unsupported" in keys
            assert body["original_utterance"] == "credit invoice for John Melton for $1,000"
        finally:
            await _cleanup(uid, cid)
    _run(_t())


def test_credit_invoice_variations_all_caught():
    """The guard should fire on 'credit an invoice', 'credit the
    invoice', 'crediting an invoice', and mixed case."""
    async def _t():
        tok, cid, uid = await _mk_env()
        try:
            for utter in [
                "Credit invoice for John",
                "credit an invoice for Mary Smith for 500",
                "credit the invoice for ABC Corp",
                "crediting an invoice for Bob",
                "CREDIT INVOICE FOR JANE",
            ]:
                async with await _client() as c:
                    r = await c.post(
                        f"/api/companies/{cid}/ai/parse-intent",
                        headers={"Authorization": f"Bearer {tok}"},
                        json={"text": utter},
                    )
                assert r.status_code == 200
                assert r.json()["intent"] == "disambiguate_credit_or_create", (
                    f"Guard missed: {utter!r}"
                )
        finally:
            await _cleanup(uid, cid)
    _run(_t())


def test_create_invoice_still_works_no_disambig():
    """Sanity: legitimate 'create an invoice' utterances must NOT be
    caught by the guard — they should route to create_invoice as before."""
    async def _t():
        tok, cid, uid = await _mk_env()
        try:
            async with await _client() as c:
                r = await c.post(
                    f"/api/companies/{cid}/ai/parse-intent",
                    headers={"Authorization": f"Bearer {tok}"},
                    json={"text": "create an invoice for John Melton for $2,500"},
                )
            assert r.status_code == 200, r.text
            body = r.json()
            assert body["intent"] != "disambiguate_credit_or_create", (
                f"Guard fired on legit utterance: {body}"
            )
        finally:
            await _cleanup(uid, cid)
    _run(_t())


def test_credit_alone_does_not_trigger_guard():
    """The guard requires 'credit' AND 'invoice' to be adjacent.
    Utterances that mention 'credit' in other contexts (e.g. 'credit
    the account', 'credit card fee') must NOT be caught."""
    async def _t():
        tok, cid, uid = await _mk_env()
        try:
            for utter in [
                "categorize this as credit card fee",
                "credit the equity account for 5000",
            ]:
                async with await _client() as c:
                    r = await c.post(
                        f"/api/companies/{cid}/ai/parse-intent",
                        headers={"Authorization": f"Bearer {tok}"},
                        json={"text": utter},
                    )
                assert r.status_code == 200
                assert r.json()["intent"] != "disambiguate_credit_or_create", (
                    f"Guard incorrectly fired on: {utter!r}"
                )
        finally:
            await _cleanup(uid, cid)
    _run(_t())
