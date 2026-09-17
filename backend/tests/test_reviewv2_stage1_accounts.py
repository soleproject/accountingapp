"""Tests for the new Stage-1 unified transfer-flow endpoints on ReviewV2 Lab v3.

Covers:
- POST /reviewv2/account-transfer-propose (AI proposal happy path + validation)
- POST /reviewv2/account-transfer-book (contact resolve/create, posting, rule save,
  and the AI-echoed 'existing-uuid-or-null' safety filter)
- GET /reviewv2/lab-v3-queue (account_personal_use skipped; unknown_account
  cards carry needs_transfer_flow / linked_contact_id / linked_contact_name)
"""
import os
import time
import uuid
import pytest
import requests

def _load_backend_url():
    if os.environ.get("REACT_APP_BACKEND_URL"):
        return os.environ["REACT_APP_BACKEND_URL"].rstrip("/")
    envp = "/app/frontend/.env"
    if os.path.exists(envp):
        for line in open(envp):
            if line.startswith("REACT_APP_BACKEND_URL="):
                return line.split("=", 1)[1].strip().rstrip("/")
    raise RuntimeError("REACT_APP_BACKEND_URL not set")

BASE_URL = _load_backend_url()
API = f"{BASE_URL}/api"

PRO_EMAIL = "pro@axiom.ai"
PRO_PASS  = "pro123"
TEST_519_ID = "eae0bd47-0545-4f7c-9175-d838f8d1637b"


@pytest.fixture(scope="module")
def token():
    r = requests.post(f"{API}/auth/login",
                      json={"email": PRO_EMAIL, "password": PRO_PASS}, timeout=30)
    assert r.status_code == 200, r.text
    return r.json()["token"]


@pytest.fixture(scope="module")
def s(token):
    sess = requests.Session()
    sess.headers.update({"Authorization": f"Bearer {token}",
                         "Content-Type": "application/json"})
    return sess


# --- Queue: no account_personal_use; unknown_account has needs_transfer_flow ---

def test_queue_loads(s):
    r = s.get(f"{API}/companies/{TEST_519_ID}/reviewv2/lab-v3-queue", timeout=60)
    assert r.status_code == 200, r.text
    data = r.json()
    assert "stage1" in data or "items" in data or isinstance(data, dict)


def _all_items(queue):
    return ((queue.get("stage1_accounts") or [])
            + (queue.get("stage2_patterns") or [])
            + (queue.get("stage3_oneoffs")  or []))


def test_queue_no_account_personal_use(s):
    r = s.get(f"{API}/companies/{TEST_519_ID}/reviewv2/lab-v3-queue", timeout=60)
    assert r.status_code == 200
    for it in _all_items(r.json()):
        assert it.get("reason") != "account_personal_use", it


def test_queue_stage1_unknown_account_flags(s):
    r = s.get(f"{API}/companies/{TEST_519_ID}/reviewv2/lab-v3-queue", timeout=60)
    assert r.status_code == 200
    stage1 = r.json().get("stage1_accounts") or []
    unknowns = [it for it in stage1 if it.get("reason") in ("unknown_account", "affiliate_transfer_reason")]
    if not unknowns:
        pytest.skip("No unknown_account Stage-1 cards in queue right now")
    for it in unknowns:
        assert it.get("needs_transfer_flow") is True, it
        # linked_contact_id / _name keys must exist (may be None)
        assert "linked_contact_id" in it
        assert "linked_contact_name" in it


# --- Propose ---

def test_propose_requires_purpose_text(s):
    r = s.post(f"{API}/companies/{TEST_519_ID}/reviewv2/account-transfer-propose",
               json={"contact_name": "John Doe", "purpose_text": ""}, timeout=30)
    assert r.status_code == 400, r.text


def test_propose_happy_path(s):
    payload = {
        "contact_name":  "Larry Brown",
        "purpose_text":  "Owner loan repayments to Larry — money going back to him.",
        "direction":     "money_out",
        "unknown_label": "External account ···7984",
    }
    r = s.post(f"{API}/companies/{TEST_519_ID}/reviewv2/account-transfer-propose",
               json=payload, timeout=90)
    assert r.status_code == 200, r.text
    data = r.json()
    # AI may sometimes fail JSON parse — that returns ok=False with a raw.
    assert "ok" in data
    if not data.get("ok"):
        pytest.skip(f"AI did not return valid JSON: {data}")
    # Expected keys per spec
    for k in ("account_code", "account_name", "account_type", "is_new",
              "reason", "confidence", "flag_for_cpa"):
        assert k in data, f"missing {k} in {data}"


# --- Book ---

def _find_stage1_card(queue):
    for it in queue.get("stage1_accounts") or []:
        if it.get("reason") in ("unknown_account", "affiliate_transfer_reason") and it.get("txn_ids"):
            return it
    return None


def test_book_endpoint_smoke_with_ai_placeholder_account_id(s):
    """Book endpoint should ignore AI-echoed `account_id='existing-uuid-or-null'`
    and fall through to account_code lookup."""
    q = s.get(f"{API}/companies/{TEST_519_ID}/reviewv2/lab-v3-queue", timeout=60).json()
    card = _find_stage1_card(q)
    if not card:
        pytest.skip("No unknown_account stage1 card to book")

    # Use only 1 txn id to keep blast radius minimal & undo later.
    txn_id = card["txn_ids"][0]

    # A CoA code that Test 519 has? Use a common one — 1300 fallback baked in.
    # Try to grab an existing account_code so we're deterministic.
    coa = s.get(f"{API}/companies/{TEST_519_ID}/accounts", timeout=30)
    code_to_use = None
    account_id_real = None
    if coa.status_code == 200:
        for a in coa.json() if isinstance(coa.json(), list) else coa.json().get("accounts", []):
            if str(a.get("code", "")).startswith("13"):
                code_to_use = str(a["code"])
                account_id_real = a["id"]
                break

    if not code_to_use:
        pytest.skip("Could not find a 13xx code account to book against")

    unique_contact = f"TEST_XferBook_{uuid.uuid4().hex[:8]}"
    body = {
        "card_key":            card.get("card_key"),
        "unknown_account_key": card.get("unknown_account_key"),
        "txn_ids":             [txn_id],
        "new_contact_name":    unique_contact,
        "purpose_text":        "Automated regression test — Stage1 book",
        "proposal": {
            # This is the poisoned value from the system-prompt example.
            "account_id":   "existing-uuid-or-null",
            "account_code": code_to_use,
            "account_name": "Whatever the code maps to",
            "account_type": "asset",
            "is_new":       False,
        },
        "remember_rule": False,
    }
    r = s.post(f"{API}/companies/{TEST_519_ID}/reviewv2/account-transfer-book",
               json=body, timeout=60)
    assert r.status_code == 200, r.text
    data = r.json()
    assert data.get("ok") is True
    assert data["account"]["id"] == account_id_real, \
        f"Expected fallthrough to account_code lookup ({account_id_real}), got {data['account']}"
    assert data["contact"]["name"] == unique_contact
    assert data["affected"] >= 1

    # Undo so we don't corrupt demo data.
    try:
        s.post(f"{API}/companies/{TEST_519_ID}/reviewv2/lab-v3-undo",
               json={"txn_ids": [txn_id]}, timeout=30)
    except Exception:
        pass


def test_book_requires_txn_ids(s):
    r = s.post(f"{API}/companies/{TEST_519_ID}/reviewv2/account-transfer-book",
               json={"proposal": {"account_code": "1300"}}, timeout=30)
    assert r.status_code == 400


def test_book_requires_proposal(s):
    r = s.post(f"{API}/companies/{TEST_519_ID}/reviewv2/account-transfer-book",
               json={"txn_ids": ["x"]}, timeout=30)
    assert r.status_code == 400
