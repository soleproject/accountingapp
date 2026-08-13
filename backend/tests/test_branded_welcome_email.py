"""Tests for the partner-branded enterprise-owner welcome email.

Feb 2026 — when a partner with an unlocked private label creates an
enterprise with an owner email, the welcome / magic-link email that
goes out MUST be branded under the partner's firm name (subject, H1,
body, footer) instead of "SmartBooks". Falls back to "SmartBooks" for
superadmin callers or partners without an unlocked WL.
"""
from __future__ import annotations

import sys
import uuid
from unittest.mock import patch, AsyncMock

sys.path.insert(0, "/app/backend")

from server import app  # noqa: E402
from db import db  # noqa: E402
from auth import create_token, hash_password  # noqa: E402
from tests._shared_loop import run as _run  # noqa: E402


async def _client():
    from httpx import AsyncClient, ASGITransport
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _mk_partner(*, wl: bool, firm_name: str = "AxiomPartners") -> str:
    uid = str(uuid.uuid4())
    branding = {"firm_name": firm_name}
    if wl:
        branding["whitelabel_comp"] = True
    await db.users.insert_one({
        "id": uid, "email": f"p_{uid[:6]}@example.com",
        "name": firm_name, "password": hash_password("x"),
        "role": "partner", "branding": branding,
    })
    return uid


async def _wipe(uids):
    for u in uids:
        await db.users.delete_one({"id": u})
        await db.users.delete_many({"partner_id": u})
        await db.enterprises.delete_many({"partner_id": u})


def test_branded_partner_gets_branded_welcome_email():
    async def _t():
        pid = await _mk_partner(wl=True, firm_name="AxiomPartners")
        try:
            captured: dict = {}

            async def fake_dispatch(*, kind, to, subject, html, **kwargs):
                captured["subject"] = subject
                captured["html"] = html
                captured["to"] = to
                return {"status": "sent"}

            with patch("email_dispatcher.dispatch", new=fake_dispatch):
                tok = create_token(pid, "partner")
                async with await _client() as c:
                    r = await c.post(
                        "/api/admin/enterprises",
                        headers={"Authorization": f"Bearer {tok}"},
                        json={
                            "name": "Big Retail Corp",
                            "owner_email": f"owner-{uuid.uuid4().hex[:6]}@example.com",
                            "owner_name": "Priya Patel",
                        },
                    )
            assert r.status_code == 200, r.text
            assert r.json()["email_status"] == "sent"
            # Subject + body + footer should read "AxiomPartners"
            # instead of "SmartBooks".
            subj = captured.get("subject", "")
            html = captured.get("html", "")
            assert "AxiomPartners" in subj, f"subject missing brand: {subj!r}"
            assert "SmartBooks" not in subj, f"subject leaked platform: {subj!r}"
            assert "You've been invited to AxiomPartners" in html
            assert "invited you to join AxiomPartners as" in html
            assert "on AxiomPartners" in html  # role blurb
        finally:
            await _wipe([pid])
    _run(_t())


def test_unbranded_partner_falls_back_to_smartbooks():
    """When the partner has NO WL, the welcome email uses the
    platform default so the invitee doesn't get a confusing
    'AxiomPartners' email from a partner who can't actually deliver
    a white-labeled experience."""
    async def _t():
        pid = await _mk_partner(wl=False, firm_name="LockedPartner")
        try:
            captured: dict = {}

            async def fake_dispatch(*, kind, to, subject, html, **kwargs):
                captured["subject"] = subject
                captured["html"] = html
                return {"status": "sent"}

            with patch("email_dispatcher.dispatch", new=fake_dispatch):
                tok = create_token(pid, "partner")
                async with await _client() as c:
                    r = await c.post(
                        "/api/admin/enterprises",
                        headers={"Authorization": f"Bearer {tok}"},
                        json={
                            "name": "Client Corp",
                            "owner_email": f"o-{uuid.uuid4().hex[:6]}@example.com",
                            "owner_name": "Owner",
                        },
                    )
            assert r.status_code == 200
            subj = captured.get("subject", "")
            html = captured.get("html", "")
            assert "SmartBooks" in subj
            assert "LockedPartner" not in subj
            assert "You've been invited to SmartBooks" in html
        finally:
            await _wipe([pid])
    _run(_t())


def test_superadmin_creator_still_uses_smartbooks():
    """Superadmin doesn't get their branding on the invite — the
    invite is a platform email in that case."""
    async def _t():
        try:
            admin = await db.users.find_one({"email": "admin@axiom.ai"})
            assert admin is not None
            captured: dict = {}

            async def fake_dispatch(*, kind, to, subject, html, **kwargs):
                captured["subject"] = subject
                captured["html"] = html
                return {"status": "sent"}

            with patch("email_dispatcher.dispatch", new=fake_dispatch):
                tok = create_token(admin["id"], "superadmin")
                async with await _client() as c:
                    r = await c.post(
                        "/api/admin/enterprises",
                        headers={"Authorization": f"Bearer {tok}"},
                        json={
                            "name": "SA-Provisioned Corp",
                            "owner_email": f"o-{uuid.uuid4().hex[:6]}@example.com",
                            "owner_name": "Owner",
                        },
                    )
            assert r.status_code == 200
            subj = captured.get("subject", "")
            assert "SmartBooks" in subj
            # Cleanup created enterprise.
            await db.enterprises.delete_many({"name": "SA-Provisioned Corp"})
        except Exception:
            raise
    _run(_t())


def test_magic_link_uses_partner_slug_when_template_configured():
    """If `PRIVATE_LABEL_HOST_TEMPLATE` is set + the partner has a
    subdomain slug, the magic-link URL should land on that host."""
    import os

    async def _t():
        pid = str(uuid.uuid4())
        await db.users.insert_one({
            "id": pid, "email": f"p_{uid_hex()}@example.com",
            "name": "AxiomPartners", "password": hash_password("x"),
            "role": "partner",
            "branding": {
                "firm_name": "AxiomPartners",
                "whitelabel_comp": True,
                "subdomain_slug": "axiompartners",
            },
        })
        try:
            captured: dict = {}

            async def fake_dispatch(*, kind, to, subject, html, **kwargs):
                captured["html"] = html
                return {"status": "sent"}

            with patch.dict(os.environ, {
                "PRIVATE_LABEL_HOST_TEMPLATE": "https://{slug}.accountingapp.ai",
            }, clear=False), patch("email_dispatcher.dispatch", new=fake_dispatch):
                tok = create_token(pid, "partner")
                async with await _client() as c:
                    r = await c.post(
                        "/api/admin/enterprises",
                        headers={"Authorization": f"Bearer {tok}"},
                        json={
                            "name": "Slug-Corp",
                            "owner_email": f"o-{uuid.uuid4().hex[:6]}@example.com",
                            "owner_name": "Owner",
                        },
                    )
            assert r.status_code == 200
            html = captured.get("html", "")
            assert "https://axiompartners.accountingapp.ai/set-password/" in html, html[:400]
        finally:
            await _wipe([pid])
    _run(_t())


def test_magic_link_appends_firm_query_param_for_branded_setpw_page():
    """Even when `PRIVATE_LABEL_HOST_TEMPLATE` isn't configured (so
    the link lands on `app.smartbookssoftware.ai`), we append
    `?firm=<signin_subdomain>` so the set-password page can look up
    the partner's brand via `/branding/by-subdomain/{sub}` and render
    the partner's logo/name instead of the platform default."""
    async def _t():
        pid = str(uuid.uuid4())
        await db.users.insert_one({
            "id": pid, "email": f"p_{uid_hex()}@example.com",
            "name": "AxiomPartners", "password": hash_password("x"),
            "role": "partner",
            "branding": {
                "firm_name": "AxiomPartners",
                "whitelabel_comp": True,
                "signin_subdomain": "axiompartners",
                # No `subdomain_slug` — so magic link stays on flagship
                # host, but `?firm=axiompartners` should still be
                # appended so the frontend can render branded visuals.
            },
        })
        try:
            captured: dict = {}

            async def fake_dispatch(*, kind, to, subject, html, **kwargs):
                captured["html"] = html
                return {"status": "sent"}

            with patch("email_dispatcher.dispatch", new=fake_dispatch):
                tok = create_token(pid, "partner")
                async with await _client() as c:
                    r = await c.post(
                        "/api/admin/enterprises",
                        headers={"Authorization": f"Bearer {tok}"},
                        json={
                            "name": "NoTemplateCorp",
                            "owner_email": f"o-{uuid.uuid4().hex[:6]}@example.com",
                            "owner_name": "Owner",
                        },
                    )
            assert r.status_code == 200
            html = captured.get("html", "")
            assert "/set-password/" in html
            assert "?firm=axiompartners" in html, (
                "magic link should carry the ?firm= query so the "
                f"set-password page renders the partner brand. Got: {html[:500]!r}"
            )
        finally:
            await _wipe([pid])
    _run(_t())


def uid_hex() -> str:
    return uuid.uuid4().hex[:6]
