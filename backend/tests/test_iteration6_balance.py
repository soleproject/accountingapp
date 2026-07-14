"""Iteration 6: Balance Sheet / Trial Balance / GL integrity tests + A/R aging."""
import os
import pytest
import requests

BASE = os.environ.get("REACT_APP_BACKEND_URL") or open("/app/frontend/.env").read().split("REACT_APP_BACKEND_URL=")[1].split()[0]
BASE = BASE.rstrip("/")
API = f"{BASE}/api"

CENT = 0.02  # tolerance


def _login(e, p):
    r = requests.post(f"{API}/auth/login", json={"email": e, "password": p}, timeout=30)
    assert r.status_code == 200, r.text
    return r.json()


@pytest.fixture(scope="module")
def auth():
    return _login("client@axiom.ai", "client123")


@pytest.fixture(scope="module")
def hdr(auth):
    return {"Authorization": f"Bearer {auth['token']}"}


@pytest.fixture(scope="module")
def cid(hdr):
    r = requests.get(f"{API}/companies", headers=hdr, timeout=15).json()
    comps = r.get("companies", r) if isinstance(r, dict) else r
    return next(c for c in comps if "Skyward" in c["name"])["id"]


def _tb(hdr, cid):
    return requests.get(f"{API}/companies/{cid}/reports/trial-balance", headers=hdr, timeout=30).json()


def _bs(hdr, cid):
    return requests.get(f"{API}/companies/{cid}/reports/balance-sheet", headers=hdr, timeout=30).json()


def _is(hdr, cid):
    return requests.get(f"{API}/companies/{cid}/reports/income-statement", headers=hdr, timeout=30).json()


def _accounts(hdr, cid):
    r = requests.get(f"{API}/companies/{cid}/accounts", headers=hdr, timeout=15).json()
    return r.get("accounts", r.get("items", r if isinstance(r, list) else []))


# ---- Baseline integrity ----
class TestBaselineIntegrity:
    def test_trial_balance_balanced(self, hdr, cid):
        tb = _tb(hdr, cid)
        assert "total_debit" in tb and "total_credit" in tb, tb
        td, tc = float(tb["total_debit"]), float(tb["total_credit"])
        assert abs(td - tc) < CENT, f"TB imbalance: debit={td} credit={tc}"
        assert tb.get("balanced") is True, f"balanced flag: {tb.get('balanced')}"

    def test_balance_sheet_balanced(self, hdr, cid):
        bs = _bs(hdr, cid)
        a = float(bs.get("total_assets", 0))
        l = float(bs.get("total_liabilities", 0))
        e = float(bs.get("total_equity", 0))
        imb = float(bs.get("imbalance", a - (l + e)))
        assert abs(imb) < CENT, f"BS imbalance {imb}: A={a} L={l} E={e}"
        assert bs.get("balanced") is True, f"balanced={bs.get('balanced')}"

    def test_net_income_matches_equity_line(self, hdr, cid):
        bs = _bs(hdr, cid)
        inc = _is(hdr, cid)
        ni = float(inc.get("net_income", 0))
        # find Current Period Net Income line in equity
        equity_lines = bs.get("equity", bs.get("equity_lines", []))
        # sections may be list of dicts
        found = None
        def _search(node):
            nonlocal found
            if isinstance(node, dict):
                name = (node.get("name") or node.get("label") or "").lower()
                if "net income" in name and "current" in name:
                    found = node.get("amount") or node.get("balance") or node.get("value")
                for v in node.values():
                    _search(v)
            elif isinstance(node, list):
                for x in node:
                    _search(x)
        _search(bs)
        if found is None:
            pytest.skip(f"Could not find 'Current Period Net Income' line in BS; bs keys={list(bs.keys())}")
        assert abs(float(found) - ni) < CENT, f"NI mismatch: IS={ni} BS_line={found}"


# ---- After manual journal entry ----
class TestAfterJournalEntry:
    def test_post_je_and_reports_still_balance(self, hdr, cid):
        accts = _accounts(hdr, cid)
        cash = next(a for a in accts if a["code"] == "1010")
        rev = next(a for a in accts if a["type"] == "revenue")
        r = requests.post(f"{API}/companies/{cid}/journal-entries", headers=hdr,
                          json={"date": "2025-06-30", "memo": "TEST_iter6_JE",
                                "lines": [
                                    {"account_code": cash["code"], "debit": 250, "credit": 0},
                                    {"account_code": rev["code"], "debit": 0, "credit": 250},
                                ]}, timeout=30)
        assert r.status_code in (200, 201), r.text
        # verify
        tb = _tb(hdr, cid)
        bs = _bs(hdr, cid)
        assert abs(float(tb["total_debit"]) - float(tb["total_credit"])) < CENT, f"TB unbalanced after JE: {tb}"
        assert bs.get("balanced") is True, f"BS unbalanced after JE: imb={bs.get('imbalance')}"


# ---- After manual transaction w/o bank_account_id -> auto default to 1010 ----
class TestAutoDefaultBank:
    def test_txn_without_bank_defaults_to_1010(self, hdr, cid):
        payload = {"date": "2025-06-20", "merchant": "TEST_iter6_NoBank",
                   "amount": -42.10, "description": "no bank id supplied"}
        r = requests.post(f"{API}/companies/{cid}/transactions", headers=hdr, json=payload, timeout=60)
        assert r.status_code in (200, 201), r.text
        txn = r.json().get("transaction", r.json())
        # look up bank account
        accts = _accounts(hdr, cid)
        code_1010 = next(a for a in accts if a["code"] == "1010")
        ba_id = txn.get("bank_account_id")
        # accept either the id matches 1010 account id OR bank_account_code == 1010
        assert ba_id == code_1010.get("id") or txn.get("bank_account_code") == "1010", \
            f"Expected auto-default bank 1010, got {txn}"
        # books still balanced
        tb = _tb(hdr, cid)
        assert abs(float(tb["total_debit"]) - float(tb["total_credit"])) < CENT


# ---- Split transaction preserves balance ----
class TestSplit:
    def test_split_preserves_balance(self, hdr, cid):
        # create parent txn
        r = requests.post(f"{API}/companies/{cid}/transactions", headers=hdr,
                          json={"date": "2025-06-22", "merchant": "TEST_iter6_split",
                                "amount": -100.00, "description": "to split"}, timeout=60)
        assert r.status_code in (200, 201), r.text
        tid = r.json().get("transaction", r.json())["id"]
        accts = _accounts(hdr, cid)
        exps = [a for a in accts if a["type"] == "expense"][:2]
        splits = [{"account_code": exps[0]["code"], "amount": -60.00, "memo": "p1"},
                  {"account_code": exps[1]["code"], "amount": -40.00, "memo": "p2"}]
        s = requests.post(f"{API}/companies/{cid}/transactions/{tid}/split",
                          headers=hdr, json={"splits": splits}, timeout=30)
        assert s.status_code in (200, 201), s.text
        tb = _tb(hdr, cid)
        assert abs(float(tb["total_debit"]) - float(tb["total_credit"])) < CENT, tb
        bs = _bs(hdr, cid)
        assert bs.get("balanced") is True, bs.get("imbalance")


# ---- GL integrity: sum of GL == TB signed balances ----
class TestGLIntegrity:
    def test_gl_matches_tb(self, hdr, cid):
        gl = requests.get(f"{API}/companies/{cid}/reports/general-ledger", headers=hdr, timeout=60).json()
        tb = _tb(hdr, cid)
        # tb rows have account_code, debit, credit
        tb_rows = tb.get("rows") or tb.get("accounts") or tb.get("lines") or []
        tb_by_code = {}
        for row in tb_rows:
            code = row.get("account_code") or row.get("code")
            d = float(row.get("debit", 0) or 0)
            c = float(row.get("credit", 0) or 0)
            tb_by_code[code] = d - c  # debit-normal signed
        # gl structure
        gl_accts = gl.get("accounts") or gl.get("groups") or gl.get("rows") or []
        mismatches = []
        for entry in gl_accts:
            code = entry.get("account_code") or entry.get("code")
            postings = entry.get("postings") or entry.get("lines") or entry.get("entries") or []
            total = 0.0
            for p in postings:
                d = float(p.get("debit", 0) or 0)
                c = float(p.get("credit", 0) or 0)
                total += d - c
            if code in tb_by_code:
                if abs(total - tb_by_code[code]) > CENT:
                    mismatches.append((code, total, tb_by_code[code]))
        assert not mismatches, f"GL/TB mismatches: {mismatches[:10]}"


# ---- A/R Aging endpoint ----
class TestARAging:
    def test_ar_aging_shape(self, hdr, cid):
        r = requests.get(f"{API}/companies/{cid}/reports/ar-aging", headers=hdr, timeout=30)
        assert r.status_code == 200, r.text
        j = r.json()
        assert "buckets" in j, j
        b = j["buckets"]
        for k in ("current", "1_30", "31_60", "61_90", "over_90"):
            assert k in b, f"missing bucket {k}: {b}"
        assert "lines" in j and isinstance(j["lines"], list)
        assert "total" in j
        # buckets sum ~= total
        s = sum(float(b[k]) for k in ("current", "1_30", "31_60", "61_90", "over_90"))
        assert abs(s - float(j["total"])) < CENT, f"bucket sum {s} != total {j['total']}"
