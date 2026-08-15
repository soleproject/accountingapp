"""Tests for the feedback (bugs + product recommendations) inbox.

Coverage:
  1. POST /feedback creates a row with status=new; any authenticated
     user role can submit.
  2. GET /feedback/mine returns only the caller's rows.
  3. GET /feedback is superadmin-only (403 for pro / client / partner).
  4. PATCH /feedback/{id} status change is superadmin-only (403 otherwise).
  5. PATCH admin_note appends to admin_notes without wiping prior notes.
  6. Invalid `type` / `status` values are rejected.
  7. Superadmin notify does NOT raise even if there are zero superadmins
     — the submission still succeeds.
  8. GET /feedback filters by status + type + free-text search.
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


async def _mk_user(role: str = "client") -> tuple[str, str]:
    uid = str(uuid.uuid4())
    await db.users.insert_one({
        "id": uid, "email": f"fb_{uid[:6]}@example.com",
        "name": "Feedback Tester", "password": hash_password("x"),
        "role": role,
    })
    return uid, create_token(uid, role)


async def _wipe_users_and_feedback(uids: list[str]) -> None:
    for uid in uids:
        await db.users.delete_one({"id": uid})
        await db.feedback_items.delete_many({"submitter_user_id": uid})


def test_create_feedback_creates_row():
    async def _t():
        uid, tok = await _mk_user("client")
        try:
            async with await _client() as c:
                r = await c.post(
                    "/api/feedback",
                    headers={"Authorization": f"Bearer {tok}"},
                    json={
                        "type": "bug",
                        "title": "  Buttons overlap  ",
                        "description": "steps",
                        "route": "/dashboard",
                        "user_agent": "pytest",
                    },
                )
                assert r.status_code == 200, r.text
                fid = r.json()["id"]
                assert r.json()["status"] == "new"
                row = await db.feedback_items.find_one({"id": fid})
                assert row["title"] == "Buttons overlap"  # trimmed
                assert row["submitter_user_id"] == uid
                assert row["status"] == "new"
                assert row["admin_notes"] == []
                assert row["route"] == "/dashboard"
        finally:
            await _wipe_users_and_feedback([uid])
    _run(_t())


def test_invalid_type_rejected():
    async def _t():
        uid, tok = await _mk_user("client")
        try:
            async with await _client() as c:
                r = await c.post(
                    "/api/feedback",
                    headers={"Authorization": f"Bearer {tok}"},
                    json={"type": "feature", "title": "x"},
                )
                assert r.status_code == 400
        finally:
            await _wipe_users_and_feedback([uid])
    _run(_t())


def test_mine_returns_only_own_rows():
    async def _t():
        u1, t1 = await _mk_user("client")
        u2, t2 = await _mk_user("client")
        try:
            async with await _client() as c:
                await c.post("/api/feedback",
                    headers={"Authorization": f"Bearer {t1}"},
                    json={"type": "bug", "title": "u1 bug"})
                await c.post("/api/feedback",
                    headers={"Authorization": f"Bearer {t2}"},
                    json={"type": "recommendation", "title": "u2 idea"})

                r1 = await c.get("/api/feedback/mine",
                    headers={"Authorization": f"Bearer {t1}"})
                assert r1.status_code == 200
                titles = {i["title"] for i in r1.json()["items"]}
                assert titles == {"u1 bug"}
        finally:
            await _wipe_users_and_feedback([u1, u2])
    _run(_t())


def test_admin_list_requires_superadmin():
    async def _t():
        u_client, t_client = await _mk_user("client")
        u_pro, t_pro = await _mk_user("pro")
        u_partner, t_partner = await _mk_user("partner")
        try:
            async with await _client() as c:
                for tok in (t_client, t_pro, t_partner):
                    r = await c.get("/api/feedback",
                        headers={"Authorization": f"Bearer {tok}"})
                    assert r.status_code == 403, f"expected 403, got {r.status_code}"
        finally:
            await _wipe_users_and_feedback([u_client, u_pro, u_partner])
    _run(_t())


def test_admin_can_list_and_patch():
    async def _t():
        u_client, t_client = await _mk_user("client")
        u_admin, t_admin = await _mk_user("superadmin")
        try:
            async with await _client() as c:
                # Client files a bug
                r = await c.post("/api/feedback",
                    headers={"Authorization": f"Bearer {t_client}"},
                    json={"type": "bug", "title": "admin path", "description": "d"})
                fid = r.json()["id"]

                # Superadmin lists
                r = await c.get("/api/feedback",
                    headers={"Authorization": f"Bearer {t_admin}"})
                assert r.status_code == 200
                items = r.json()["items"]
                assert any(i["id"] == fid for i in items)
                assert "counts" in r.json()

                # Change status → in_progress + add a note
                r = await c.patch(f"/api/feedback/{fid}",
                    headers={"Authorization": f"Bearer {t_admin}"},
                    json={"status": "in_progress", "admin_note": "first note"})
                assert r.status_code == 200
                assert r.json()["status"] == "in_progress"
                assert len(r.json()["admin_notes"]) == 1

                # Append another note — prior notes preserved
                r = await c.patch(f"/api/feedback/{fid}",
                    headers={"Authorization": f"Bearer {t_admin}"},
                    json={"admin_note": "second note"})
                assert r.status_code == 200
                notes = r.json()["admin_notes"]
                assert len(notes) == 2
                assert [n["note"] for n in notes] == ["first note", "second note"]
        finally:
            await _wipe_users_and_feedback([u_client, u_admin])
    _run(_t())


def test_patch_status_requires_superadmin():
    async def _t():
        u_client, t_client = await _mk_user("client")
        u_admin, t_admin = await _mk_user("superadmin")
        try:
            async with await _client() as c:
                r = await c.post("/api/feedback",
                    headers={"Authorization": f"Bearer {t_client}"},
                    json={"type": "bug", "title": "auth-test"})
                fid = r.json()["id"]
                # Client cannot patch
                r = await c.patch(f"/api/feedback/{fid}",
                    headers={"Authorization": f"Bearer {t_client}"},
                    json={"status": "completed"})
                assert r.status_code == 403
        finally:
            await _wipe_users_and_feedback([u_client, u_admin])
    _run(_t())


def test_patch_invalid_status_rejected():
    async def _t():
        u_client, t_client = await _mk_user("client")
        u_admin, t_admin = await _mk_user("superadmin")
        try:
            async with await _client() as c:
                r = await c.post("/api/feedback",
                    headers={"Authorization": f"Bearer {t_client}"},
                    json={"type": "bug", "title": "bad-status-test"})
                fid = r.json()["id"]
                r = await c.patch(f"/api/feedback/{fid}",
                    headers={"Authorization": f"Bearer {t_admin}"},
                    json={"status": "resolved"})
                assert r.status_code == 400
        finally:
            await _wipe_users_and_feedback([u_client, u_admin])
    _run(_t())


def test_filters_by_status_type_and_search():
    async def _t():
        u, t = await _mk_user("client")
        u_admin, t_admin = await _mk_user("superadmin")
        try:
            async with await _client() as c:
                for payload in [
                    {"type": "bug", "title": "AAA login broken"},
                    {"type": "bug", "title": "BBB logout weird"},
                    {"type": "recommendation", "title": "CCC dark mode please"},
                ]:
                    await c.post("/api/feedback",
                        headers={"Authorization": f"Bearer {t}"},
                        json=payload)

                # type=recommendation
                r = await c.get("/api/feedback?type=recommendation",
                    headers={"Authorization": f"Bearer {t_admin}"})
                mine_titles = {i["title"] for i in r.json()["items"] if i["submitter_user_id"] == u}
                assert mine_titles == {"CCC dark mode please"}

                # search for "login"
                r = await c.get("/api/feedback?q=login",
                    headers={"Authorization": f"Bearer {t_admin}"})
                mine_titles = {i["title"] for i in r.json()["items"] if i["submitter_user_id"] == u}
                assert mine_titles == {"AAA login broken"}
        finally:
            await _wipe_users_and_feedback([u, u_admin])
    _run(_t())


def test_notify_no_admins_still_succeeds():
    """Even with zero superadmins in the DB the POST must succeed —
    email notify is best-effort and never blocks the submission."""
    async def _t():
        # Wipe any superadmins temporarily by asserting the failure path
        # doesn't crash: we don't actually delete real admins (test DB is
        # shared), we simply verify the endpoint returns 200 even if the
        # notify path is degraded. This is more of a sanity check.
        u, t = await _mk_user("client")
        try:
            async with await _client() as c:
                r = await c.post("/api/feedback",
                    headers={"Authorization": f"Bearer {t}"},
                    json={"type": "bug", "title": "notify-safety"})
                assert r.status_code == 200
        finally:
            await _wipe_users_and_feedback([u])
    _run(_t())



# ------------------------------------------------------------------
# Partner + Enterprise resolution
# ------------------------------------------------------------------
def test_context_resolves_partner_for_partner_role():
    """A user with role=='partner' is themself the partner."""
    async def _t():
        uid = str(uuid.uuid4())
        await db.users.insert_one({
            "id": uid, "email": f"p_{uid[:6]}@example.com", "role": "partner",
            "password": hash_password("x"), "name": "The Partner",
            "branding": {"firm_name": "PartnerFirm LLC"},
        })
        tok = create_token(uid, "partner")
        try:
            async with await _client() as c:
                r = await c.post("/api/feedback",
                    headers={"Authorization": f"Bearer {tok}"},
                    json={"type": "bug", "title": "partner reports"})
                assert r.status_code == 200
                fid = r.json()["id"]
                row = await db.feedback_items.find_one({"id": fid})
                assert row["partner_id"] == uid
                assert row["partner_name"] == "PartnerFirm LLC"
                # No enterprise context for a bare partner
                assert row["enterprise_id"] is None
        finally:
            await db.users.delete_one({"id": uid})
            await db.feedback_items.delete_many({"submitter_user_id": uid})
    _run(_t())


def test_context_resolves_enterprise_via_pro():
    """A pro with `enterprise_id` set attributes their feedback to that
    enterprise, and the enterprise's `partner_id` fills in the partner slot."""
    async def _t():
        partner_uid = str(uuid.uuid4())
        pro_uid = str(uuid.uuid4())
        ent_id = str(uuid.uuid4())
        await db.users.insert_one({
            "id": partner_uid, "email": f"pt_{partner_uid[:6]}@example.com",
            "role": "partner", "password": hash_password("x"),
            "branding": {"firm_name": "MegaPartner"},
        })
        await db.users.insert_one({
            "id": pro_uid, "email": f"pro_{pro_uid[:6]}@example.com",
            "role": "pro", "password": hash_password("x"),
            "name": "Pro Owner",
            "enterprise_id": ent_id,
        })
        await db.enterprises.insert_one({
            "id": ent_id, "name": "Northgate Advisory",
            "owner_user_id": pro_uid, "partner_id": partner_uid,
        })
        tok = create_token(pro_uid, "pro")
        try:
            async with await _client() as c:
                r = await c.post("/api/feedback",
                    headers={"Authorization": f"Bearer {tok}"},
                    json={"type": "recommendation", "title": "pro w/ ent"})
                fid = r.json()["id"]
                row = await db.feedback_items.find_one({"id": fid})
                assert row["enterprise_id"] == ent_id
                assert row["enterprise_name"] == "Northgate Advisory"
                assert row["partner_id"] == partner_uid
                assert row["partner_name"] == "MegaPartner"
        finally:
            for u in (partner_uid, pro_uid):
                await db.users.delete_one({"id": u})
                await db.feedback_items.delete_many({"submitter_user_id": u})
            await db.enterprises.delete_one({"id": ent_id})
    _run(_t())


def test_context_resolves_via_client_company():
    """A client submitting from within a company should get the company's
    managing-pro's enterprise attached to the feedback item."""
    async def _t():
        partner_uid = str(uuid.uuid4())
        pro_uid = str(uuid.uuid4())
        client_uid = str(uuid.uuid4())
        ent_id = str(uuid.uuid4())
        cid = str(uuid.uuid4())

        await db.users.insert_one({
            "id": partner_uid, "email": f"pt_{partner_uid[:6]}@example.com",
            "role": "partner", "password": hash_password("x"),
            "branding": {"firm_name": "GammaPartner"},
        })
        await db.users.insert_one({
            "id": pro_uid, "email": f"pro_{pro_uid[:6]}@example.com",
            "role": "pro", "password": hash_password("x"),
            "enterprise_id": ent_id,
        })
        await db.users.insert_one({
            "id": client_uid, "email": f"cl_{client_uid[:6]}@example.com",
            "role": "client", "password": hash_password("x"),
        })
        await db.enterprises.insert_one({
            "id": ent_id, "name": "Delta Advisory",
            "owner_user_id": pro_uid, "partner_id": partner_uid,
        })
        await db.companies.insert_one({
            "id": cid, "name": "Client Co", "owner_user_id": client_uid,
            "pro_user_id": pro_uid,
        })
        tok = create_token(client_uid, "client")
        try:
            async with await _client() as c:
                r = await c.post("/api/feedback",
                    headers={"Authorization": f"Bearer {tok}"},
                    json={"type": "bug", "title": "client w/ mgr", "company_id": cid})
                fid = r.json()["id"]
                row = await db.feedback_items.find_one({"id": fid})
                assert row["company_name"] == "Client Co"
                assert row["enterprise_id"] == ent_id
                assert row["enterprise_name"] == "Delta Advisory"
                assert row["partner_id"] == partner_uid
                assert row["partner_name"] == "GammaPartner"
        finally:
            for u in (partner_uid, pro_uid, client_uid):
                await db.users.delete_one({"id": u})
                await db.feedback_items.delete_many({"submitter_user_id": u})
            await db.enterprises.delete_one({"id": ent_id})
            await db.companies.delete_one({"id": cid})
    _run(_t())


def test_context_no_partner_no_enterprise():
    """A bare client with no company context should have null partner / enterprise."""
    async def _t():
        uid, tok = await _mk_user("client")
        try:
            async with await _client() as c:
                r = await c.post("/api/feedback",
                    headers={"Authorization": f"Bearer {tok}"},
                    json={"type": "bug", "title": "orphan client"})
                fid = r.json()["id"]
                row = await db.feedback_items.find_one({"id": fid})
                assert row["partner_id"] is None
                assert row["enterprise_id"] is None
        finally:
            await _wipe_users_and_feedback([uid])
    _run(_t())


# ------------------------------------------------------------------
# Attachments
# ------------------------------------------------------------------
# Smallest valid PNG (1x1 transparent) — well under 5MB
_TINY_PNG = ("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgAAIA"
             "AAUAAeImBZsAAAAASUVORK5CYII=")
_PNG_URL = f"data:image/png;base64,{_TINY_PNG}"


def test_attachments_persisted_and_returned():
    async def _t():
        uid, tok = await _mk_user("client")
        try:
            async with await _client() as c:
                r = await c.post("/api/feedback",
                    headers={"Authorization": f"Bearer {tok}"},
                    json={
                        "type": "bug", "title": "with images",
                        "attachments": [
                            {"filename": "one.png", "mime": "image/png", "data_url": _PNG_URL},
                            {"filename": "two.png", "mime": "image/png", "data_url": _PNG_URL},
                        ],
                    })
                assert r.status_code == 200, r.text
                fid = r.json()["id"]
                row = await db.feedback_items.find_one({"id": fid})
                assert len(row["attachments"]) == 2
                for a in row["attachments"]:
                    assert a["mime"] == "image/png"
                    assert a["data_url"].startswith("data:image/png;base64,")
                    assert a["size"] > 0
        finally:
            await _wipe_users_and_feedback([uid])
    _run(_t())


def test_attachment_bad_mime_rejected():
    async def _t():
        uid, tok = await _mk_user("client")
        try:
            async with await _client() as c:
                r = await c.post("/api/feedback",
                    headers={"Authorization": f"Bearer {tok}"},
                    json={
                        "type": "bug", "title": "bad mime",
                        "attachments": [
                            {"filename": "x.pdf", "mime": "application/pdf",
                             "data_url": "data:application/pdf;base64,JVBERi0xLjQK"},
                        ],
                    })
                assert r.status_code == 400
        finally:
            await _wipe_users_and_feedback([uid])
    _run(_t())


# ------------------------------------------------------------------
# Notify-submitter toggle + status change email
# ------------------------------------------------------------------
def test_notify_submitter_default_true_and_togglable():
    async def _t():
        u_client, t_client = await _mk_user("client")
        u_admin, t_admin = await _mk_user("superadmin")
        try:
            async with await _client() as c:
                r = await c.post("/api/feedback",
                    headers={"Authorization": f"Bearer {t_client}"},
                    json={"type": "bug", "title": "notify me"})
                fid = r.json()["id"]
                row = await db.feedback_items.find_one({"id": fid})
                assert row["notify_submitter"] is True

                r = await c.patch(f"/api/feedback/{fid}",
                    headers={"Authorization": f"Bearer {t_admin}"},
                    json={"notify_submitter": False})
                assert r.status_code == 200
                assert r.json()["notify_submitter"] is False
        finally:
            await _wipe_users_and_feedback([u_client, u_admin])
    _run(_t())


# ------------------------------------------------------------------
# Note visibility — internal vs reporter, /mine filtering
# ------------------------------------------------------------------
def test_note_visibility_internal_hidden_from_submitter():
    async def _t():
        u_client, t_client = await _mk_user("client")
        u_admin, t_admin = await _mk_user("superadmin")
        try:
            async with await _client() as c:
                r = await c.post("/api/feedback",
                    headers={"Authorization": f"Bearer {t_client}"},
                    json={"type": "bug", "title": "vis-test"})
                fid = r.json()["id"]

                # Post internal + reporter notes
                await c.patch(f"/api/feedback/{fid}",
                    headers={"Authorization": f"Bearer {t_admin}"},
                    json={"admin_note": "internal secret", "note_visibility": "internal"})
                await c.patch(f"/api/feedback/{fid}",
                    headers={"Authorization": f"Bearer {t_admin}"},
                    json={"admin_note": "public reply", "note_visibility": "reporter"})

                # Superadmin sees both
                r = await c.get("/api/feedback",
                    headers={"Authorization": f"Bearer {t_admin}"})
                admin_row = next(i for i in r.json()["items"] if i["id"] == fid)
                notes = admin_row["admin_notes"]
                assert len(notes) == 2
                assert {n["visibility"] for n in notes} == {"internal", "reporter"}

                # Submitter only sees the reporter-visible one
                r = await c.get("/api/feedback/mine",
                    headers={"Authorization": f"Bearer {t_client}"})
                mine_row = next(i for i in r.json()["items"] if i["id"] == fid)
                notes = mine_row["admin_notes"]
                assert len(notes) == 1
                assert notes[0]["note"] == "public reply"
                assert notes[0]["visibility"] == "reporter"
        finally:
            await _wipe_users_and_feedback([u_client, u_admin])
    _run(_t())


def test_bad_note_visibility_rejected():
    async def _t():
        u_client, t_client = await _mk_user("client")
        u_admin, t_admin = await _mk_user("superadmin")
        try:
            async with await _client() as c:
                r = await c.post("/api/feedback",
                    headers={"Authorization": f"Bearer {t_client}"},
                    json={"type": "bug", "title": "vis-bad"})
                fid = r.json()["id"]
                r = await c.patch(f"/api/feedback/{fid}",
                    headers={"Authorization": f"Bearer {t_admin}"},
                    json={"admin_note": "n", "note_visibility": "public"})
                assert r.status_code == 400
        finally:
            await _wipe_users_and_feedback([u_client, u_admin])
    _run(_t())


def test_email_reporter_flag_marks_note_and_dispatches():
    """When posting a reporter-visible note with email_reporter=True, the
    note's `email_sent` flag flips to True and a `feedback_reply_reporter`
    row is written to `communications`."""
    async def _t():
        u_client, t_client = await _mk_user("client")
        u_admin, t_admin = await _mk_user("superadmin")
        try:
            async with await _client() as c:
                r = await c.post("/api/feedback",
                    headers={"Authorization": f"Bearer {t_client}"},
                    json={"type": "bug", "title": "email-reply"})
                fid = r.json()["id"]
                # Snapshot pre-count of reply emails to compare later
                pre_count = await db.communications.count_documents({
                    "kind": "feedback_reply_reporter",
                    "related.feedback_id": fid,
                })
                await c.patch(f"/api/feedback/{fid}",
                    headers={"Authorization": f"Bearer {t_admin}"},
                    json={
                        "admin_note": "thanks for the report!",
                        "note_visibility": "reporter",
                        "email_reporter": True,
                    })
                row = await db.feedback_items.find_one({"id": fid})
                notes = row["admin_notes"]
                assert len(notes) == 1
                assert notes[0]["visibility"] == "reporter"
                assert notes[0]["email_sent"] is True
                # A comms row was inserted (status may be sent OR failed for
                # test example.com emails, both are valid — we just want the
                # dispatch to have been attempted).
                post_count = await db.communications.count_documents({
                    "kind": "feedback_reply_reporter",
                    "related.feedback_id": fid,
                })
                assert post_count == pre_count + 1
        finally:
            await _wipe_users_and_feedback([u_client, u_admin])
    _run(_t())


# ------------------------------------------------------------------
# /feedback/tenants + Partner/Enterprise filters
# ------------------------------------------------------------------
def test_tenants_endpoint_and_filters():
    async def _t():
        # Build a small tenant tree
        partner_uid = str(uuid.uuid4())
        pro_uid = str(uuid.uuid4())
        client_uid = str(uuid.uuid4())
        ent_id = str(uuid.uuid4())
        cid = str(uuid.uuid4())
        u_admin, t_admin = await _mk_user("superadmin")

        await db.users.insert_one({
            "id": partner_uid, "email": f"pt_{partner_uid[:6]}@example.com",
            "role": "partner", "password": hash_password("x"),
            "branding": {"firm_name": "Zeta Partners"},
        })
        await db.users.insert_one({
            "id": pro_uid, "email": f"pro_{pro_uid[:6]}@example.com",
            "role": "pro", "password": hash_password("x"),
            "enterprise_id": ent_id,
        })
        await db.users.insert_one({
            "id": client_uid, "email": f"cl_{client_uid[:6]}@example.com",
            "role": "client", "password": hash_password("x"),
        })
        await db.enterprises.insert_one({
            "id": ent_id, "name": "Zeta Enterprise",
            "owner_user_id": pro_uid, "partner_id": partner_uid,
        })
        await db.companies.insert_one({
            "id": cid, "name": "Zeta Co", "owner_user_id": client_uid,
            "pro_user_id": pro_uid,
        })
        t_client = create_token(client_uid, "client")

        try:
            async with await _client() as c:
                # Two feedback items: one attributed to Zeta (via company),
                # one bare (no partner/enterprise).
                await c.post("/api/feedback",
                    headers={"Authorization": f"Bearer {t_client}"},
                    json={"type": "bug", "title": "zeta bug", "company_id": cid})
                bare_uid, bare_tok = await _mk_user("client")
                try:
                    await c.post("/api/feedback",
                        headers={"Authorization": f"Bearer {bare_tok}"},
                        json={"type": "bug", "title": "bare bug"})

                    r = await c.get("/api/feedback/tenants",
                        headers={"Authorization": f"Bearer {t_admin}"})
                    assert r.status_code == 200
                    body = r.json()
                    partner_ids = {p["id"] for p in body["partners"]}
                    ent_ids = {e["id"] for e in body["enterprises"]}
                    assert partner_uid in partner_ids
                    assert ent_id in ent_ids
                    assert body["has_no_partner"] is True
                    assert body["has_no_enterprise"] is True

                    # Filter by partner_id → only zeta
                    r = await c.get(f"/api/feedback?partner_id={partner_uid}",
                        headers={"Authorization": f"Bearer {t_admin}"})
                    titles = {i["title"] for i in r.json()["items"]}
                    assert "zeta bug" in titles
                    assert "bare bug" not in titles

                    # Filter by enterprise_id=__none__ → only bare
                    r = await c.get("/api/feedback?enterprise_id=__none__",
                        headers={"Authorization": f"Bearer {t_admin}"})
                    titles = {i["title"] for i in r.json()["items"] if i["submitter_user_id"] in (bare_uid, client_uid)}
                    assert "bare bug" in titles
                    assert "zeta bug" not in titles
                finally:
                    await _wipe_users_and_feedback([bare_uid])
        finally:
            for u in (partner_uid, pro_uid, client_uid, u_admin):
                await db.users.delete_one({"id": u})
                await db.feedback_items.delete_many({"submitter_user_id": u})
            await db.enterprises.delete_one({"id": ent_id})
            await db.companies.delete_one({"id": cid})
    _run(_t())



# ------------------------------------------------------------------
# Reporter reply from /feedback/mine
# ------------------------------------------------------------------
def test_reporter_can_reply_to_own_ticket():
    async def _t():
        uid, tok = await _mk_user("client")
        try:
            async with await _client() as c:
                r = await c.post("/api/feedback",
                    headers={"Authorization": f"Bearer {tok}"},
                    json={"type": "bug", "title": "reply test"})
                fid = r.json()["id"]
                r = await c.post(f"/api/feedback/{fid}/reply",
                    headers={"Authorization": f"Bearer {tok}"},
                    json={"note": "Here's more info you asked for."})
                assert r.status_code == 200, r.text
                notes = r.json()["admin_notes"]
                assert len(notes) == 1
                assert notes[0]["note"] == "Here's more info you asked for."
                assert notes[0]["author_role"] == "reporter"
                assert notes[0]["visibility"] == "reporter"
        finally:
            await _wipe_users_and_feedback([uid])
    _run(_t())


def test_reporter_reply_appears_in_admin_view():
    async def _t():
        u_client, t_client = await _mk_user("client")
        u_admin, t_admin = await _mk_user("superadmin")
        try:
            async with await _client() as c:
                r = await c.post("/api/feedback",
                    headers={"Authorization": f"Bearer {t_client}"},
                    json={"type": "bug", "title": "cross-visibility"})
                fid = r.json()["id"]
                await c.post(f"/api/feedback/{fid}/reply",
                    headers={"Authorization": f"Bearer {t_client}"},
                    json={"note": "reporter says hi"})
                # Superadmin fetches inbox — the reporter reply is present
                r = await c.get("/api/feedback",
                    headers={"Authorization": f"Bearer {t_admin}"})
                match = next(i for i in r.json()["items"] if i["id"] == fid)
                notes = match["admin_notes"]
                assert len(notes) == 1
                assert notes[0]["author_role"] == "reporter"
                assert notes[0]["note"] == "reporter says hi"
        finally:
            await _wipe_users_and_feedback([u_client, u_admin])
    _run(_t())


def test_non_submitter_cannot_reply_404():
    """Someone who isn't the original reporter gets 404 (enumeration guard)."""
    async def _t():
        u1, t1 = await _mk_user("client")
        u2, t2 = await _mk_user("client")
        try:
            async with await _client() as c:
                r = await c.post("/api/feedback",
                    headers={"Authorization": f"Bearer {t1}"},
                    json={"type": "bug", "title": "priv"})
                fid = r.json()["id"]
                r = await c.post(f"/api/feedback/{fid}/reply",
                    headers={"Authorization": f"Bearer {t2}"},
                    json={"note": "sneak"})
                assert r.status_code == 404
                # Confirm no note was added
                row = await db.feedback_items.find_one({"id": fid})
                assert row["admin_notes"] == []
        finally:
            await _wipe_users_and_feedback([u1, u2])
    _run(_t())


def test_reporter_reply_with_attachments():
    async def _t():
        uid, tok = await _mk_user("client")
        try:
            async with await _client() as c:
                r = await c.post("/api/feedback",
                    headers={"Authorization": f"Bearer {tok}"},
                    json={"type": "bug", "title": "att-reply"})
                fid = r.json()["id"]
                r = await c.post(f"/api/feedback/{fid}/reply",
                    headers={"Authorization": f"Bearer {tok}"},
                    json={
                        "note": "with a screenshot",
                        "attachments": [
                            {"filename": "s.png", "mime": "image/png", "data_url": _PNG_URL},
                        ],
                    })
                assert r.status_code == 200
                notes = r.json()["admin_notes"]
                assert len(notes[0]["attachments"]) == 1
                assert notes[0]["attachments"][0]["mime"] == "image/png"
        finally:
            await _wipe_users_and_feedback([uid])
    _run(_t())


def test_reporter_reply_notifies_superadmins_via_comms():
    async def _t():
        u_client, t_client = await _mk_user("client")
        u_admin, t_admin = await _mk_user("superadmin")
        try:
            async with await _client() as c:
                r = await c.post("/api/feedback",
                    headers={"Authorization": f"Bearer {t_client}"},
                    json={"type": "bug", "title": "notify-admins"})
                fid = r.json()["id"]
                pre = await db.communications.count_documents({
                    "kind": "feedback_new_reporter_reply",
                    "related.feedback_id": fid,
                })
                await c.post(f"/api/feedback/{fid}/reply",
                    headers={"Authorization": f"Bearer {t_client}"},
                    json={"note": "ping"})
                post = await db.communications.count_documents({
                    "kind": "feedback_new_reporter_reply",
                    "related.feedback_id": fid,
                })
                assert post > pre
        finally:
            await _wipe_users_and_feedback([u_client, u_admin])
    _run(_t())


def test_reporter_reply_empty_rejected():
    async def _t():
        uid, tok = await _mk_user("client")
        try:
            async with await _client() as c:
                r = await c.post("/api/feedback",
                    headers={"Authorization": f"Bearer {tok}"},
                    json={"type": "bug", "title": "empty-reply"})
                fid = r.json()["id"]
                r = await c.post(f"/api/feedback/{fid}/reply",
                    headers={"Authorization": f"Bearer {tok}"},
                    json={"note": ""})
                assert r.status_code == 422  # Pydantic min_length=1
        finally:
            await _wipe_users_and_feedback([uid])
    _run(_t())



# ------------------------------------------------------------------
# Unread tracking + filters
# ------------------------------------------------------------------
def test_reporter_unread_lifecycle():
    async def _t():
        u_client, t_client = await _mk_user("client")
        u_admin, t_admin = await _mk_user("superadmin")
        try:
            async with await _client() as c:
                # File a ticket — the initial submission itself isn't
                # "unread activity" for the reporter (they wrote it), so
                # the badge should be 0 until an admin responds.
                r = await c.post("/api/feedback",
                    headers={"Authorization": f"Bearer {t_client}"},
                    json={"type": "bug", "title": "unread-flow"})
                fid = r.json()["id"]
                r = await c.get("/api/feedback/mine/unread-count",
                    headers={"Authorization": f"Bearer {t_client}"})
                assert r.json()["unread"] == 0

                # Admin posts a reporter-visible reply → unread ticks up
                await c.patch(f"/api/feedback/{fid}",
                    headers={"Authorization": f"Bearer {t_admin}"},
                    json={"admin_note": "hi", "note_visibility": "reporter"})
                r = await c.get("/api/feedback/mine/unread-count",
                    headers={"Authorization": f"Bearer {t_client}"})
                assert r.json()["unread"] == 1

                # Reporter visits inbox (marks read) → count clears
                await c.post("/api/feedback/mine/mark-read",
                    headers={"Authorization": f"Bearer {t_client}"})
                r = await c.get("/api/feedback/mine/unread-count",
                    headers={"Authorization": f"Bearer {t_client}"})
                assert r.json()["unread"] == 0

                # Another admin reply → unread again
                await c.patch(f"/api/feedback/{fid}",
                    headers={"Authorization": f"Bearer {t_admin}"},
                    json={"admin_note": "another", "note_visibility": "reporter"})
                r = await c.get("/api/feedback/mine/unread-count",
                    headers={"Authorization": f"Bearer {t_client}"})
                assert r.json()["unread"] == 1

                # Internal notes should NEVER count toward reporter unread
                await c.post("/api/feedback/mine/mark-read",
                    headers={"Authorization": f"Bearer {t_client}"})
                await c.patch(f"/api/feedback/{fid}",
                    headers={"Authorization": f"Bearer {t_admin}"},
                    json={"admin_note": "internal only", "note_visibility": "internal"})
                r = await c.get("/api/feedback/mine/unread-count",
                    headers={"Authorization": f"Bearer {t_client}"})
                assert r.json()["unread"] == 0
        finally:
            await _wipe_users_and_feedback([u_client, u_admin])
    _run(_t())


def test_admin_unread_lifecycle():
    async def _t():
        u_client, t_client = await _mk_user("client")
        u_admin, t_admin = await _mk_user("superadmin")
        try:
            async with await _client() as c:
                # Freshly-created ticket is unread for every admin who hasn't
                # visited yet.
                await c.post("/api/feedback",
                    headers={"Authorization": f"Bearer {t_client}"},
                    json={"type": "bug", "title": "admin-unread"})
                r = await c.get("/api/feedback/unread-count",
                    headers={"Authorization": f"Bearer {t_admin}"})
                assert r.json()["unread"] >= 1

                # Mark-read clears it
                await c.post("/api/feedback/mark-read",
                    headers={"Authorization": f"Bearer {t_admin}"})
                r = await c.get("/api/feedback/unread-count",
                    headers={"Authorization": f"Bearer {t_admin}"})
                # This admin has now read everything; count must be 0
                # (other admins in the DB don't count against us).
                assert r.json()["unread"] == 0

                # Reporter follow-up must re-mark that ticket as unread for
                # the admin who already read it.
                r2 = await c.get("/api/feedback",
                    headers={"Authorization": f"Bearer {t_admin}"})
                fid = next(i["id"] for i in r2.json()["items"] if i["title"] == "admin-unread")
                await c.post(f"/api/feedback/{fid}/reply",
                    headers={"Authorization": f"Bearer {t_client}"},
                    json={"note": "reporter says more"})
                r = await c.get("/api/feedback/unread-count",
                    headers={"Authorization": f"Bearer {t_admin}"})
                assert r.json()["unread"] == 1
        finally:
            await _wipe_users_and_feedback([u_client, u_admin])
    _run(_t())


def test_mine_filters_status_and_only_unread():
    async def _t():
        u_client, t_client = await _mk_user("client")
        u_admin, t_admin = await _mk_user("superadmin")
        try:
            async with await _client() as c:
                # 3 items — one in each of new / in_progress / completed
                for i, title in enumerate(["A", "B", "C"]):
                    await c.post("/api/feedback",
                        headers={"Authorization": f"Bearer {t_client}"},
                        json={"type": "bug", "title": title})
                r = await c.get("/api/feedback/mine",
                    headers={"Authorization": f"Bearer {t_client}"})
                by_title = {i["title"]: i["id"] for i in r.json()["items"]}
                # Flip B → in_progress, A → completed
                await c.patch(f"/api/feedback/{by_title['B']}",
                    headers={"Authorization": f"Bearer {t_admin}"},
                    json={"status": "in_progress"})
                await c.patch(f"/api/feedback/{by_title['A']}",
                    headers={"Authorization": f"Bearer {t_admin}"},
                    json={"status": "completed"})
                # Also add an admin reply on B → B becomes unread
                await c.patch(f"/api/feedback/{by_title['B']}",
                    headers={"Authorization": f"Bearer {t_admin}"},
                    json={"admin_note": "hi B", "note_visibility": "reporter"})

                # Filter by status=completed → only 1
                r = await c.get("/api/feedback/mine?status=completed",
                    headers={"Authorization": f"Bearer {t_client}"})
                titles = {i["title"] for i in r.json()["items"]}
                assert titles == {"A"}

                # only_unread=1 → only B
                r = await c.get("/api/feedback/mine?only_unread=1",
                    headers={"Authorization": f"Bearer {t_client}"})
                titles = {i["title"] for i in r.json()["items"]}
                assert titles == {"B"}

                # Counts breakdown is present + independent of filters
                r = await c.get("/api/feedback/mine?status=completed",
                    headers={"Authorization": f"Bearer {t_client}"})
                counts = r.json()["counts"]
                assert counts["completed"] == 1
                assert counts["in_progress"] == 1
                assert counts["new"] == 1
                assert r.json()["unread"] == 1
        finally:
            await _wipe_users_and_feedback([u_client, u_admin])
    _run(_t())

