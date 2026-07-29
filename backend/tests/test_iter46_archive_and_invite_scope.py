"""Iter 46 — Archive/Unarchive pro staff + role-scoped pending invites.

Covers:
  * GET /api/pro/team returns members, archived_members, pending_invites
  * POST /api/pro/staff/{uid}/archive + /unarchive — idempotent
  * Superadmin can archive/unarchive
  * /api/companies/{cid}/team filters out role='pro' invites; /api/pro/team returns them
  * Persistence: pending invites visible to all pro members regardless of who created them
"""
import os
import uuid
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/")
assert BASE_URL, "REACT_APP_BACKEND_URL must be set"

CLIENT_CID = "540fbc73-66fd-432f-a357-39db6c84c5bd"


def _login(email, password):
    r = requests.post(f"{BASE_URL}/api/auth/login", json={"email": email, "password": password}, timeout=15)
    assert r.status_code == 200, f"login {email}: {r.status_code} {r.text[:200]}"
    return r.json()["token"]


@pytest.fixture(scope="module")
def pro_token():
    return _login("pro@axiom.ai", "pro123")


@pytest.fixture(scope="module")
def admin_token():
    return _login("admin@axiom.ai", "admin123")


@pytest.fixture(scope="module")
def client_token():
    return _login("client@axiom.ai", "client123")


def H(tok):
    return {"Authorization": f"Bearer {tok}", "Content-Type": "application/json"}


# ---------- pro/team structural response ----------
def test_pro_team_shape(pro_token):
    r = requests.get(f"{BASE_URL}/api/pro/team", headers=H(pro_token), timeout=15)
    assert r.status_code == 200, r.text
    data = r.json()
    for k in ("members", "archived_members", "pending_invites"):
        assert k in data, f"missing key {k}"
    assert isinstance(data["archived_members"], list)
    assert isinstance(data["members"], list)


# ---------- helper: create a real pro staff via invite+accept ----------
def _create_staff_via_invite(pro_token, email):
    # get pro company_ids
    r = requests.get(f"{BASE_URL}/api/pro/team", headers=H(pro_token))
    r.raise_for_status()
    # invite
    inv = requests.post(f"{BASE_URL}/api/pro/invites", headers=H(pro_token),
                        json={"email": email, "company_ids": [CLIENT_CID], "name": "TEST Staff"})
    assert inv.status_code == 200, inv.text
    token = inv.json()["token"]
    # accept
    acc = requests.post(f"{BASE_URL}/api/invites/{token}/accept",
                        json={"password": "staffpass123", "name": "TEST Staff"})
    assert acc.status_code == 200, acc.text
    return acc.json()["user"]["id"]


@pytest.fixture(scope="module")
def staff_uid(pro_token):
    email = f"TEST_staff_{uuid.uuid4().hex[:8]}@example.com"
    uid = _create_staff_via_invite(pro_token, email)
    yield uid
    # cleanup: hard remove
    requests.delete(f"{BASE_URL}/api/pro/staff/{uid}", headers=H(pro_token))


def _get_team(tok):
    r = requests.get(f"{BASE_URL}/api/pro/team", headers=H(tok), timeout=15)
    assert r.status_code == 200, r.text
    return r.json()


def test_archive_moves_to_archived(pro_token, staff_uid):
    team = _get_team(pro_token)
    assert any(m["user_id"] == staff_uid for m in team["members"]), "staff should start Active"

    r = requests.post(f"{BASE_URL}/api/pro/staff/{staff_uid}/archive", headers=H(pro_token))
    assert r.status_code == 200, r.text
    body = r.json()
    assert "archived" in body and body["archived"] >= 1

    team2 = _get_team(pro_token)
    assert not any(m["user_id"] == staff_uid for m in team2["members"])
    assert any(m["user_id"] == staff_uid for m in team2["archived_members"])


def test_archive_idempotent(pro_token, staff_uid):
    # second call should not error, modified_count may be 0
    r = requests.post(f"{BASE_URL}/api/pro/staff/{staff_uid}/archive", headers=H(pro_token))
    assert r.status_code == 200
    team = _get_team(pro_token)
    assert any(m["user_id"] == staff_uid for m in team["archived_members"])
    assert not any(m["user_id"] == staff_uid for m in team["members"])


def test_unarchive_restores(pro_token, staff_uid):
    r = requests.post(f"{BASE_URL}/api/pro/staff/{staff_uid}/unarchive", headers=H(pro_token))
    assert r.status_code == 200, r.text
    body = r.json()
    assert "unarchived" in body

    team = _get_team(pro_token)
    assert any(m["user_id"] == staff_uid for m in team["members"])
    assert not any(m["user_id"] == staff_uid for m in team["archived_members"])


def test_unarchive_idempotent(pro_token, staff_uid):
    r = requests.post(f"{BASE_URL}/api/pro/staff/{staff_uid}/unarchive", headers=H(pro_token))
    assert r.status_code == 200
    team = _get_team(pro_token)
    assert any(m["user_id"] == staff_uid for m in team["members"])


def test_superadmin_can_archive_unarchive(admin_token, pro_token, staff_uid):
    r = requests.post(f"{BASE_URL}/api/pro/staff/{staff_uid}/archive", headers=H(admin_token))
    assert r.status_code == 200, r.text
    assert r.json()["archived"] >= 1

    team = _get_team(pro_token)
    assert any(m["user_id"] == staff_uid for m in team["archived_members"])

    r2 = requests.post(f"{BASE_URL}/api/pro/staff/{staff_uid}/unarchive", headers=H(admin_token))
    assert r2.status_code == 200
    team2 = _get_team(pro_token)
    assert any(m["user_id"] == staff_uid for m in team2["members"])


# ---------- Pending invite role scoping ----------
def test_pending_invite_role_scoping(client_token, pro_token):
    editor_email = f"test_editor_{uuid.uuid4().hex[:8]}@example.com"
    pro_email = f"test_pro_{uuid.uuid4().hex[:8]}@example.com"

    # editor invite by client owner
    e = requests.post(f"{BASE_URL}/api/companies/{CLIENT_CID}/invites",
                      headers=H(client_token),
                      json={"email": editor_email, "role": "editor"})
    assert e.status_code == 200, e.text
    editor_invite_id = e.json()["invite_id"]

    # pro invite for same company
    p = requests.post(f"{BASE_URL}/api/pro/invites", headers=H(pro_token),
                      json={"email": pro_email, "company_ids": [CLIENT_CID]})
    assert p.status_code == 200, p.text
    pro_invite_id = p.json()["invite_id"]

    try:
        # client team should only show editor invite
        ct = requests.get(f"{BASE_URL}/api/companies/{CLIENT_CID}/team", headers=H(client_token))
        assert ct.status_code == 200
        pi = ct.json()["pending_invites"]
        emails = {i["email"] for i in pi}
        roles = {i["role"] for i in pi}
        assert editor_email in emails, f"editor invite missing from client team: {emails}"
        assert pro_email not in emails, "pro invite should be filtered from client team"
        assert "pro" not in roles, f"pro role leaked to client team: {roles}"

        # pro team scoped to company should see pro invite
        pt = requests.get(f"{BASE_URL}/api/pro/team", headers=H(pro_token),
                         params={"company_id": CLIENT_CID})
        assert pt.status_code == 200
        pi2 = pt.json()["pending_invites"]
        emails2 = {i["email"] for i in pi2}
        assert pro_email in emails2, f"pro invite missing from pro team: {emails2}"
    finally:
        requests.delete(f"{BASE_URL}/api/invites/{editor_invite_id}", headers=H(client_token))
        requests.delete(f"{BASE_URL}/api/invites/{pro_invite_id}", headers=H(pro_token))


def test_pending_invite_visible_across_users(admin_token, client_token):
    """Superadmin creates an editor invite for the client's company. Client
    owner should still see it (persistence across users)."""
    editor_email = f"test_persist_{uuid.uuid4().hex[:8]}@example.com"
    e = requests.post(f"{BASE_URL}/api/companies/{CLIENT_CID}/invites",
                      headers=H(admin_token),
                      json={"email": editor_email, "role": "reviewer"})
    assert e.status_code == 200, e.text
    inv_id = e.json()["invite_id"]
    try:
        ct = requests.get(f"{BASE_URL}/api/companies/{CLIENT_CID}/team", headers=H(client_token))
        assert ct.status_code == 200
        emails = {i["email"] for i in ct.json()["pending_invites"]}
        assert editor_email in emails, "client cannot see invite created by superadmin"
    finally:
        requests.delete(f"{BASE_URL}/api/invites/{inv_id}", headers=H(admin_token))
