"""E2E test of the internal-transfer batch detector."""
import json, uuid, datetime, sys
from pymongo import MongoClient
import requests

env = open("/app/frontend/.env").read()
API = [l.split("=",1)[1].strip() for l in env.splitlines() if l.startswith("REACT_APP_BACKEND_URL=")][0]
menv = open("/app/backend/.env").read()
MURL = [l.split("=",1)[1].strip().strip('"') for l in menv.splitlines() if l.startswith("MONGO_URL=")][0]
DB   = [l.split("=",1)[1].strip().strip('"') for l in menv.splitlines() if l.startswith("DB_NAME=")][0]
db = MongoClient(MURL)[DB]
CID = "65c43432-305d-4419-8037-bfbcfa7de748"  # 704 LLC

s = requests.Session(); s.headers["User-Agent"] = "curl/8.0"
def req(m, p, body=None, tok=None):
    h = {}
    if tok: h["Authorization"] = "Bearer " + tok
    r = s.request(m, API + p, json=body, headers=h)
    r.raise_for_status()
    return r.json()

tok = req("POST", "/api/auth/login", {"email":"pro@axiom.ai","password":"pro123"})["token"]

# ─── Clean test artifacts ────────────────────────────────────────────
db.transactions.delete_many({"company_id":CID, "description": {"$regex":"^__XFER_TEST"}})
db.accounts.delete_many({"company_id":CID, "code": {"$in": ["1099","1098"]}})

# ─── Create two synthetic bank accounts (owned by this company) ─────
now = datetime.datetime.now(datetime.timezone.utc).isoformat()
BANK_A = {"id": str(uuid.uuid4()), "company_id": CID, "code":"1099",
          "name":"__XFER_TEST Checking A", "type":"asset", "subtype":"Bank",
          "active": True, "balance": 0.0, "created_at": now, "updated_at": now}
BANK_B = {"id": str(uuid.uuid4()), "company_id": CID, "code":"1098",
          "name":"__XFER_TEST Checking B", "type":"asset", "subtype":"Bank",
          "active": True, "balance": 0.0, "created_at": now, "updated_at": now}
db.accounts.insert_many([BANK_A, BANK_B])

# ─── Seed transactions ─────────────────────────────────────────────
def mk(bank, amount, date, desc):
    return {
        "id": str(uuid.uuid4()), "company_id": CID,
        "bank_account_id": bank["id"], "bank_account_name": bank["name"],
        "amount": amount, "date": date, "description": desc,
        "human_reviewed": False, "posted": False, "needs_review": True,
    }

# Perfect pair on same date
p1_a = mk(BANK_A, -1000.00, "2026-02-10", "__XFER_TEST out A→B")
p1_b = mk(BANK_B,  1000.00, "2026-02-10", "__XFER_TEST in from A")
# Off-by-1-day pair
p2_a = mk(BANK_A, -500.00, "2026-02-11", "__XFER_TEST transfer to savings")
p2_b = mk(BANK_B,  500.00, "2026-02-12", "__XFER_TEST arrived from checking")
# Same amount but same bank (should NOT match)
same_bank_a = mk(BANK_A, -250.00, "2026-02-13", "__XFER_TEST fee")
same_bank_b = mk(BANK_A,  250.00, "2026-02-13", "__XFER_TEST refund")
# Same amount but too far apart (>3 days, should NOT match)
far_a = mk(BANK_A, -777.00, "2026-02-01", "__XFER_TEST far payment")
far_b = mk(BANK_B,  777.00, "2026-02-10", "__XFER_TEST far arrival")
# Unpaired expense (should NOT match)
solo = mk(BANK_A, -333.00, "2026-02-14", "__XFER_TEST Amazon purchase")
# Already reviewed pair (should be skipped by detector)
skip_a = mk(BANK_A, -100.00, "2026-02-15", "__XFER_TEST previously reviewed a")
skip_b = mk(BANK_B,  100.00, "2026-02-15", "__XFER_TEST previously reviewed b")
skip_a["human_reviewed"] = True
skip_b["human_reviewed"] = True

txns = [p1_a, p1_b, p2_a, p2_b, same_bank_a, same_bank_b, far_a, far_b, solo, skip_a, skip_b]
db.transactions.insert_many(txns)
print(f"seeded {len(txns)} txns")

# ─── DRY RUN ────────────────────────────────────────────────────────
r = req("POST", f"/api/companies/{CID}/transactions/detect-transfers",
        {"dry_run": True, "date_since": "2026-02-01"}, tok=tok)
print(f"\n=== DRY RUN ===")
print(f"pairs found: {len(r['pairs'])}, updated: {r['updated']}, dry_run: {r['dry_run']}")
for p in r["pairs"]:
    print(f"  DEBIT  ${p['debit_leg']['amount']} on {p['debit_leg']['date']} "
          f"[{p['debit_leg']['bank_account_name']}] :: {p['debit_leg']['description']}")
    print(f"  CREDIT ${p['credit_leg']['amount']} on {p['credit_leg']['date']} "
          f"[{p['credit_leg']['bank_account_name']}] :: {p['credit_leg']['description']}")
    print(f"  Δdays: {p['date_delta_days']}")
    print()

assert len(r["pairs"]) >= 2, f"expected >=2 pairs, got {len(r['pairs'])}"
# Filter to just OUR synthetic pairs (test tolerance for pre-existing real pairs).
synth_pairs = [p for p in r["pairs"] if "__XFER_TEST" in (p["debit_leg"]["description"] or "")]
assert len(synth_pairs) == 2, f"expected 2 synthetic pairs, got {len(synth_pairs)}"
assert r["updated"] == 0, "dry_run should not mutate"

# ─── LIVE RUN ───────────────────────────────────────────────────────
r2 = req("POST", f"/api/companies/{CID}/transactions/detect-transfers",
         {"dry_run": False, "date_since": "2026-02-01"}, tok=tok)
print(f"=== LIVE RUN ===")
print(f"pairs: {len(r2['pairs'])}, updated: {r2['updated']}")
# We seeded 4 legs (2 pairs). The pre-existing real pair on 2026-07-03 would
# add 2 more legs to the sum. Assert AT LEAST 4 rows were updated.
assert r2["updated"] >= 4, f"expected >=4 legs updated, got {r2['updated']}"

# Verify DB state
for t in [p1_a, p1_b, p2_a, p2_b]:
    d = db.transactions.find_one({"id": t["id"]})
    assert d["is_internal_transfer"] is True
    assert d["human_reviewed"] is True
    assert d["category_account_code"] and d["category_account_code"].startswith("3"), \
        f"expected equity code (3xxx), got {d['category_account_code']}"
    assert d["transfer_pair_id"]
    print(f"  ✓ {t['description']}: cat={d['category_account_code']} {d['category_account_name']} pair={d['transfer_pair_id'][:8]}")

# The non-matched rows must be untouched
for t in [same_bank_a, same_bank_b, far_a, far_b, solo]:
    d = db.transactions.find_one({"id": t["id"]})
    assert not d.get("is_internal_transfer"), f"BUG: {t['description']} was incorrectly matched"
    assert not d.get("human_reviewed"), f"BUG: {t['description']} was incorrectly reviewed"
print("  ✓ non-matched rows correctly untouched")

# ─── RE-RUN idempotency ─────────────────────────────────────────────
r3 = req("POST", f"/api/companies/{CID}/transactions/detect-transfers",
         {"dry_run": False, "date_since": "2026-02-01"}, tok=tok)
print(f"=== RE-RUN (idempotency) === pairs: {len(r3['pairs'])}, updated: {r3['updated']}")
assert r3["updated"] == 0, f"expected 0 (already applied), got {r3['updated']}"
print("  ✓ idempotent — no new updates")

# ─── Cleanup ───────────────────────────────────────────────────────
db.transactions.delete_many({"company_id":CID, "description": {"$regex":"^__XFER_TEST"}})
db.accounts.delete_many({"company_id":CID, "code": {"$in": ["1099","1098"]}})
# Cleanup pair_id refs on any equity transfer account we auto-created
xfer = db.accounts.find_one({"company_id":CID, "type":"equity", "subtype":"transfer"})
if xfer: print(f"(kept Inter-Account Transfer account {xfer['code']} for future syncs)")
print("\n✅ ALL PASS")
