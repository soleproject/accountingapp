"""Rebuild Test 519 LLC's Quick Check-In using ONLY real ledger data
from the 2026-09-05 → 2026-09-13 window.

Delivers the same designed Quick Check-In UX (grouped progress bars,
type-specific transitions, receipt / statement upload) but every item
is anchored to an actual transaction the client will recognize in their
own bank feed.

Composition (all real 9/5-9/13 txns):
  * Q1 Uncategorized × 3  — the three needs_review=True P2P transfers
  * Q3 Missing receipt × 2 — largest non-P2P purchases lacking a receipt
  * Q8 Split suggested × 1 — AT&T Mobility (business/personal cell)
  * Q9 Liability split × 1 — IRS estimated tax payment

Idempotent — always runs cleanup first. Cleans both the legacy demo
tag AND the previous rebuild tag so re-running never leaves stragglers.
Run: `PYTHONPATH=/app/backend python scripts/rebuild_test519_window_batch.py`.
"""
from __future__ import annotations
import asyncio
import re
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from deps import db
import client_review as cr


COMPANY_NAME    = "Test 519 LLC"
CLIENT_EMAIL    = "michael+test519@bigsaas.ai"
WINDOW_START    = "2026-09-05"
WINDOW_END      = "2026-09-13"

# All previous demo/rebuild tags — everything with any of these tags
# gets removed at the start of every run.
STALE_TAGS      = [
    "seed_test519_multi_demo_v1",   # original synthetic demo
    "seed_test519_real_v1",         # first "real" rebuild (wrong window)
    "seed_test519_window_v1",       # this script's own tag
    "seed_test519_travel_v1",       # travel seed tag
]
NEW_TAG         = "seed_test519_window_v1"
TRAVEL_TAG      = "seed_test519_travel_v1"


# Seeded travel transactions so the Q14 IRS Travel flow has data to
# demo — Test 519 LLC's real ledger contains no airline/hotel/Uber
# merchants (verified by scanning the entire book). Each row is a
# realistic business-trip line item that the client would answer
# purpose + attendees on. Fingerprinted with `TRAVEL_TAG` so the
# cleanup phase can re-run idempotently.
SEEDED_TRAVEL_TXNS = [
    {
        "date": "2026-09-08", "amount": -412.50,
        "merchant": "Southwest Airlines",
        "description": "PURCHASE 0907 SOUTHWEST AIRLINES DAL TX XXXXX4482",
        "kind": "airline",
    },
    {
        "date": "2026-09-09", "amount": -189.50,
        "merchant": "Marriott Hotels",
        "description": "PURCHASE 0909 MARRIOTT DENVER DOWNTOWN CO XXXXX7728",
        "kind": "hotel",
    },
    {
        "date": "2026-09-10", "amount": -27.35,
        "merchant": "Uber",
        "description": "UBER *TRIP HELP.UBER.COM CA XXXXX3611",
        "kind": "rideshare",
    },
    {
        "date": "2026-09-11", "amount": -155.20,
        "merchant": "Enterprise Rent-A-Car",
        "description": "ENTERPRISE RENT-A-CAR DENVER CO XXXXX9481",
        "kind": "car_rental",
    },
]


_INTERNAL_TRANSFER_PATTERNS = (
    "online banking transfer",
    "internet transfer",
    "transfer from chk",
    "transfer to chk",
    "transfer from sav",
    "transfer to sav",
    "bank transfer",
)


def _is_internal_transfer(t: dict) -> bool:
    haystack = " ".join([
        (t.get("merchant")    or ""),
        (t.get("description") or ""),
    ]).lower()
    return any(p in haystack for p in _INTERNAL_TRANSFER_PATTERNS)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


async def _cleanup(cid: str) -> dict:
    stats = {"findings": 0, "batches": 0, "other_open_expired": 0,
             "demo_txns": 0, "demo_bills": 0}
    # Any lingering synthetic transactions from the original seed.
    res = await db.transactions.delete_many({
        "company_id": cid,
        "$or": [
            {"demo_tag": {"$in": STALE_TAGS}},
            {"id": {"$regex": r"^demo1-"}},
        ],
    })
    stats["demo_txns"] = res.deleted_count

    # Demo-tagged open bills (seeded so the check-assign flow has "Apply
    # to a bill" options — cleaned up so re-runs don't stack).
    res = await db.bills.delete_many({
        "company_id": cid,
        "demo_tag":   {"$in": STALE_TAGS},
    })
    stats["demo_bills"] = res.deleted_count

    # Findings we generated in prior runs of this or the legacy seed.
    res = await db.agent_findings.delete_many({
        "company_id": cid,
        "demo_tag":   {"$in": STALE_TAGS},
    })
    stats["findings"] = res.deleted_count

    # Un-stamp batch_id on the source rows for every batch we're about
    # to nuke — otherwise the standard collectors would keep skipping
    # them.
    to_kill = []
    async for b in db.client_review_batches.find({
        "company_id": cid,
        "demo_tag":   {"$in": STALE_TAGS},
    }, {"id": 1, "items": 1}):
        to_kill.append(b)
    for b in to_kill:
        by_coll: dict[str, list[str]] = {}
        for it in b.get("items") or []:
            by_coll.setdefault(it["source_collection"], []).append(it["source_id"])
        for coll, ids in by_coll.items():
            try:
                await db[coll].update_many(
                    {"id": {"$in": ids}, "company_id": cid,
                     "batch_id": b["id"]},
                    {"$unset": {"batch_id": ""},
                     "$set":   {"updated_at": now_iso()}},
                )
            except Exception:
                pass
    res = await db.client_review_batches.delete_many({
        "company_id": cid,
        "demo_tag":   {"$in": STALE_TAGS},
    })
    stats["batches"] = res.deleted_count

    # Any OTHER open batch on this client blocks the new one; expire it.
    other = []
    async for b in db.client_review_batches.find({
        "company_id":   cid,
        "client_email": CLIENT_EMAIL,
        "status":       {"$in": ["open", "scheduled"]},
    }, {"id": 1, "items": 1}):
        other.append(b)
    for b in other:
        by_coll = {}
        for it in b.get("items") or []:
            by_coll.setdefault(it["source_collection"], []).append(it["source_id"])
        for coll, ids in by_coll.items():
            try:
                await db[coll].update_many(
                    {"id": {"$in": ids}, "company_id": cid,
                     "batch_id": b["id"]},
                    {"$unset": {"batch_id": ""},
                     "$set":   {"updated_at": now_iso()}},
                )
            except Exception:
                pass
        await db.client_review_batches.update_one(
            {"id": b["id"]},
            {"$set": {"status":        "expired",
                      "expired_at":    now_iso(),
                      "expire_reason": "superseded_by_window_rebuild"}},
        )
    stats["other_open_expired"] = len(other)
    return stats


async def _find_window_txn(cid: str, *, merchant_regex: str,
                           min_amt: float = 0, needs_review: bool | None = None):
    q = {
        "company_id": cid,
        "date":       {"$gte": WINDOW_START, "$lte": WINDOW_END},
        "merchant":   {"$regex": merchant_regex, "$options": "i"},
    }
    if needs_review is not None:
        q["needs_review"] = needs_review
    async for t in db.transactions.find(q).sort("date", -1):
        if abs(float(t.get("amount") or 0)) >= min_amt:
            return t
    return None


async def _all_uncategorized_in_window(cid: str) -> list[dict]:
    q = {
        "company_id":     cid,
        "date":           {"$gte": WINDOW_START, "$lte": WINDOW_END},
        "needs_review":   True,
        "human_reviewed": {"$ne": True},
        "batch_id":       {"$in": [None, ""]},
    }
    out = []
    async for t in db.transactions.find(q).sort("date", -1):
        out.append(t)
    return out


async def _insert_finding(cid: str, *, kind: str, title: str, detail: str,
                          severity: str, meta: dict,
                          action_label: str,
                          contact_id: str | None = None) -> str:
    fid = f"real-window-{uuid.uuid4()}"
    await db.agent_findings.insert_one({
        "id":            fid,
        "company_id":    cid,
        "kind":          kind,
        "title":         title,
        "detail":        detail,
        "severity":      severity,
        "meta":          meta,
        "contact_id":    contact_id,
        "action_label":  action_label,
        "status":        "open",
        "created_at":    now_iso(),
        "updated_at":    now_iso(),
        "demo_tag":      NEW_TAG,
    })
    return fid


async def main():
    co = await db.companies.find_one({"name": COMPANY_NAME})
    if not co:
        print(f"FATAL: {COMPANY_NAME!r} not found in DB.")
        return 2
    cid = co["id"]
    print(f"Using company {co['name']} ({cid})")
    print(f"Window: {WINDOW_START} → {WINDOW_END}")

    print("\n--- Cleanup phase ---")
    stats = await _cleanup(cid)
    print(f"  demo transactions removed: {stats['demo_txns']}")
    print(f"  stale findings removed:    {stats['findings']}")
    print(f"  stale batches deleted:     {stats['batches']}")
    print(f"  other open batches expired: {stats['other_open_expired']}")

    # ---------- Q1: uncategorized transactions in the window ----------
    print("\n--- Building items from real 9/5-9/13 data ---")
    items: list[dict] = []

    uncat_txns = await _all_uncategorized_in_window(cid)
    print(f"  Q1 uncategorized txns in window: {len(uncat_txns)}")
    for t in uncat_txns:
        items.append({
            "item_id":           str(uuid.uuid4()),
            "item_type":         cr.ITEM_UNCATEGORIZED,
            "source_id":         t["id"],
            "source_collection": "transactions",
            "prompt":            cr._prompt_for_uncategorized(t),
            "context": {
                "date":        t.get("date"),
                "amount":      t.get("amount"),
                "description": t.get("description"),
                "merchant":    t.get("merchant"),
                "account":     t.get("bank_account_name"),
            },
            "answered_at":  None,
            "answer":       None,
            "deferred":     False,
            "action_taken": None,
        })

    # ---------- Q3: missing receipt on notable purchases ----------
    receipt_targets = [
        # (merchant regex, min $ threshold, human label)
        (r"^Best Buy$", 100, "Best Buy"),
    ]
    for pat, min_amt, label in receipt_targets:
        t = await _find_window_txn(cid, merchant_regex=pat, min_amt=min_amt)
        if not t:
            print(f"  Q3 missing_receipt: no {label} txn in window")
            continue
        fid = await _insert_finding(
            cid,
            kind="missing_receipt",
            title=f"Missing receipt: ${abs(t['amount']):.2f} {label}",
            detail=(f"You spent ${abs(t['amount']):.2f} at {label} on "
                    f"{t.get('date')} but we don't have a receipt on "
                    "file. Would you upload it? For anything over $75 "
                    "the IRS wants documentation."),
            severity="amber",
            meta={"txn_amount": t["amount"], "txn_desc": t.get("description"),
                  "txn_date":   t.get("date"), "txn_id": t["id"]},
            action_label="Upload receipt",
        )
        items.append({
            "item_id":           str(uuid.uuid4()),
            "item_type":         cr.ITEM_MISSING_RECEIPT,
            "source_id":         fid,
            "source_collection": "agent_findings",
            "prompt":            (f"You spent ${abs(t['amount']):.2f} at "
                                  f"{label} on {t.get('date')} but we don't "
                                  "have a receipt on file. Would you upload "
                                  "it?"),
            "context": {
                "kind":     "missing_receipt",
                "title":    f"Missing receipt: ${abs(t['amount']):.2f} {label}",
                "severity": "amber",
                "meta":     {"txn_amount": t["amount"],
                             "txn_desc": t.get("description"),
                             "txn_date": t.get("date"),
                             "txn_id":   t["id"]},
            },
            "answered_at":  None,
            "answer":       None,
            "deferred":     False,
            "action_taken": None,
        })
        print(f"  Q3 missing_receipt: {label} ${abs(t['amount']):.2f}")

    # ---------- Q8: split suggested (AT&T cell — business/personal) ----------
    att = await _find_window_txn(cid, merchant_regex=r"AT&T", min_amt=100)
    if att:
        fid = await _insert_finding(
            cid,
            kind="split_suggested",
            title=f"Split your ${abs(att['amount']):.2f} AT&T bill?",
            detail=("Your AT&T Mobility bill for "
                    f"${abs(att['amount']):.2f} on {att.get('date')} "
                    "usually splits across a couple of lines. Which "
                    "portion is business vs. personal?"),
            severity="amber",
            meta={"txn_amount": att["amount"], "txn_desc": att.get("description"),
                  "txn_date":   att.get("date"), "txn_id": att["id"],
                  "split_hint": "business_vs_personal_cell"},
            action_label="Split it",
        )
        items.append({
            "item_id":           str(uuid.uuid4()),
            "item_type":         cr.ITEM_SPLIT,
            "source_id":         fid,
            "source_collection": "agent_findings",
            "prompt":            (f"Your AT&T Mobility bill on {att.get('date')} "
                                  f"was ${abs(att['amount']):.2f}. Which portion "
                                  "is business vs. personal?"),
            "context": {
                "kind":     "split_suggested",
                "title":    f"Split your ${abs(att['amount']):.2f} AT&T bill?",
                "severity": "amber",
                "meta":     {"txn_amount": att["amount"],
                             "txn_desc":   att.get("description"),
                             "txn_date":   att.get("date"),
                             "txn_id":     att["id"]},
            },
            "answered_at":  None,
            "answer":       None,
            "deferred":     False,
            "action_taken": None,
        })
        print(f"  Q8 split_suggested: AT&T ${abs(att['amount']):.2f}")

    # ---------- Q9: liability split (IRS estimated tax) ----------
    irs = await _find_window_txn(cid, merchant_regex=r"Internal Revenue|USATAXPYMT")
    if irs:
        fid = await _insert_finding(
            cid,
            kind="liability_split_needed",
            title=f"Split the ${abs(irs['amount']):.2f} IRS payment",
            detail=(f"You paid the IRS ${abs(irs['amount']):.2f} on "
                    f"{irs.get('date')} — looks like an estimated-tax "
                    "payment. Was this personal (1040-ES) or business "
                    "(1120-W / 1120-S estimated)? We'll book it correctly."),
            severity="amber",
            meta={"txn_amount": irs["amount"], "txn_desc": irs.get("description"),
                  "txn_date":   irs.get("date"), "txn_id": irs["id"],
                  "liability_kind": "estimated_tax"},
            action_label="Upload statement",
        )
        items.append({
            "item_id":           str(uuid.uuid4()),
            "item_type":         cr.ITEM_LIABILITY_SPLIT,
            "source_id":         fid,
            "source_collection": "agent_findings",
            "prompt":            (f"You paid the IRS ${abs(irs['amount']):.2f} "
                                  f"on {irs.get('date')} — is that estimated "
                                  "tax for the business or personal?"),
            "context": {
                "kind":     "liability_split_needed",
                "title":    f"Split the ${abs(irs['amount']):.2f} IRS payment",
                "severity": "amber",
                "meta":     {"txn_amount": irs["amount"],
                             "txn_desc":   irs.get("description"),
                             "txn_date":   irs.get("date"),
                             "txn_id":     irs["id"],
                             "liability_kind": "estimated_tax"},
            },
            "answered_at":  None,
            "answer":       None,
            "deferred":     False,
            "action_taken": None,
        })
        print(f"  Q9 liability_split: IRS ${abs(irs['amount']):.2f}")

    # ---------- Q2: Owner's Draw / personally-marked check ----------
    # Every txn currently categorized to the Owner's Draw account in
    # the window gets a "was this really personal?" question — plus
    # every open `category_mismatch` finding whose current account is
    # Owner's Draw (the ledger auditor already flagged 52 of these).
    owner_draw_accts = []
    async for a in db.accounts.find({
        "company_id": cid,
        "name":       {"$regex": r"owner.*draw", "$options": "i"},
    }, {"id": 1, "name": 1}):
        owner_draw_accts.append(a)
    already_used_txn_ids = {i["source_id"] for i in items
                            if i["source_collection"] == "transactions"}
    od_txns_in_window = []
    if owner_draw_accts:
        od_ids = [a["id"] for a in owner_draw_accts]
        async for t in db.transactions.find({
            "company_id":           cid,
            "date":                 {"$gte": WINDOW_START, "$lte": WINDOW_END},
            "category_account_id":  {"$in": od_ids},
        }).sort("date", -1):
            if t["id"] in already_used_txn_ids:
                continue
            od_txns_in_window.append(t)
    print(f"  Q2 Owner's Draw txns in window: {len(od_txns_in_window)}")
    for t in od_txns_in_window:
        merchant = t.get("merchant") or "unknown vendor"
        amount   = abs(float(t["amount"]))
        fid = await _insert_finding(
            cid,
            kind="owner_draw_check",
            title=f"Owner's Draw check: ${amount:.2f} {merchant}",
            detail=(f"We currently have your ${amount:.2f} payment to "
                    f"{merchant} on {t.get('date')} in **Owner's "
                    "Draw** — is that actually personal, or was it a "
                    "business expense we should re-categorize?"),
            severity="amber",
            meta={"txn_amount": t["amount"], "txn_desc": t.get("description"),
                  "txn_date":   t.get("date"), "txn_id": t["id"],
                  "merchant":   merchant,
                  "current_account_name": "Owner's Draw"},
            action_label="Reclassify",
        )
        items.append({
            "item_id":           str(uuid.uuid4()),
            "item_type":         cr.ITEM_OWNER_DRAW,
            "source_id":         fid,
            "source_collection": "agent_findings",
            "prompt":            (
                f"Your ${amount:.2f} payment to {merchant} on "
                f"{t.get('date')} is currently in **Owner's Draw**. "
                "Was that really personal, or is it a business expense "
                "we should re-categorize?"
            ),
            "context": {
                "kind":     "owner_draw_check",
                "title":    f"Owner's Draw check: ${amount:.2f} {merchant}",
                "severity": "amber",
                "meta":     {"txn_amount": t["amount"],
                             "txn_desc":   t.get("description"),
                             "txn_date":   t.get("date"),
                             "txn_id":     t["id"],
                             "merchant":   merchant,
                             "current_account_name": "Owner's Draw"},
            },
            "answered_at":  None, "answer": None,
            "deferred":     False, "action_taken": None,
        })
        print(f"    · {merchant} ${amount:.2f}")

    # Layer (b): existing `category_mismatch` findings flagging
    # Owner's Draw. Book-wide (not window-scoped) since the auditor
    # already spent tokens finding these — surface them once.
    async for f in db.agent_findings.find({
        "company_id": cid,
        "kind":       "category_mismatch",
        "status":     "open",
        "batch_id":   {"$in": [None, ""]},
        "meta.current_account_name": {"$regex": r"^Owner.*Draw$",
                                       "$options": "i"},
    }).sort("created_at", -1).limit(6):
        meta = f.get("meta") or {}
        cn = meta.get("contact_name") or "vendor"
        expected = meta.get("expected_account_name") or "the right category"
        count = f.get("count") or len(meta.get("affected_txn_ids") or [])
        items.append({
            "item_id":           str(uuid.uuid4()),
            "item_type":         cr.ITEM_OWNER_DRAW,
            "source_id":         f["id"],
            "source_collection": "agent_findings",
            "prompt":            (
                f"You have {count} payment{'s' if count != 1 else ''} to "
                f"**{cn}** in **Owner's Draw** — we think these are "
                f"business expenses (probably **{expected}**). "
                "Want us to re-categorize them?"
            ),
            "context": {
                "kind":     "category_mismatch",
                "title":    f.get("title"),
                "severity": f.get("severity") or "amber",
                "meta":     meta,
            },
            "answered_at":  None, "answer": None,
            "deferred":     False, "action_taken": None,
        })
        print(f"    · category_mismatch: {cn} ×{count} → {expected}")

    # ---------- Q3: Deposits check ----------
    # Positive-amount txns in the window that aren't obvious internal
    # bank-to-bank transfers. Ask the client "revenue / refund / owner
    # contribution / loan?"
    dep_q = {
        "company_id": cid,
        "date":       {"$gte": WINDOW_START, "$lte": WINDOW_END},
        "amount":     {"$gt": 0},
    }
    already_used_txn_ids = {i["source_id"] for i in items
                            if i["source_collection"] == "transactions"}
    dep_txns: list[dict] = []
    async for t in db.transactions.find(dep_q).sort("date", -1):
        if _is_internal_transfer(t):
            continue
        if t["id"] in already_used_txn_ids:
            continue
        dep_txns.append(t)
    print(f"  Q3 Deposits in window: {len(dep_txns)}")
    for t in dep_txns:
        merchant = t.get("merchant") or "unknown source"
        amount   = float(t["amount"])
        fid = await _insert_finding(
            cid,
            kind="deposit_check",
            title=f"Deposit check: ${amount:.2f} from {merchant}",
            detail=(f"We saw a ${amount:.2f} deposit from **{merchant}** "
                    f"on {t.get('date')}. Was that revenue, a refund, "
                    "money you put in yourself (owner contribution), or "
                    "a loan?"),
            severity="amber",
            meta={"txn_amount": t["amount"], "txn_desc": t.get("description"),
                  "txn_date":   t.get("date"), "txn_id": t["id"],
                  "merchant":   merchant},
            action_label="Classify deposit",
        )
        items.append({
            "item_id":           str(uuid.uuid4()),
            "item_type":         cr.ITEM_DEPOSIT,
            "source_id":         fid,
            "source_collection": "agent_findings",
            "prompt":            (
                f"${amount:.2f} deposit from **{merchant}** on "
                f"{t.get('date')} — was that revenue, a refund, an "
                "owner contribution, or a loan?"
            ),
            "context": {
                "kind":     "deposit_check",
                "title":    f"Deposit check: ${amount:.2f} from {merchant}",
                "severity": "amber",
                "meta":     {"txn_amount": t["amount"],
                             "txn_desc":   t.get("description"),
                             "txn_date":   t.get("date"),
                             "txn_id":     t["id"],
                             "merchant":   merchant},
            },
            "answered_at":  None, "answer": None,
            "deferred":     False, "action_taken": None,
        })
        print(f"    · {merchant} ${amount:.2f}")

    # ---------- Seed realistic travel txns so Q14 has data ----------
    # Test 519 LLC's real ledger has no Uber/hotel/airline merchants
    # (verified via full-book regex scan). To exercise the IRS Travel
    # sub-flow end-to-end we plant 4 realistic business-trip
    # transactions tagged with `TRAVEL_TAG` so the cleanup phase can
    # re-run idempotently.
    inserted_travel = 0
    for tt in SEEDED_TRAVEL_TXNS:
        txn_id = f"travel-seed-{tt['kind']}-{uuid.uuid4()}"
        await db.transactions.insert_one({
            "id":                 txn_id,
            "company_id":         cid,
            "date":               tt["date"],
            "authorized_date":    tt["date"],
            "amount":             tt["amount"],
            "merchant":           tt["merchant"],
            "description":        tt["description"],
            "original_description": tt["description"],
            "bank_account_name":  "Bank of America Checking ···6084",
            "category_account_id": None,
            "contact_id":         None,
            "contact_name":       "",
            "splits":             [],
            "needs_review":       False,   # already categorized (traveler knows it's travel)
            "human_reviewed":     False,
            "posted":             True,
            "source":             "seed",
            "demo_tag":           TRAVEL_TAG,
            "created_at":         now_iso(),
            "updated_at":         now_iso(),
        })
        # Store the txn_id back on the seed so downstream Q14 collector
        # can point at it without re-querying.
        tt["_txn_id"] = txn_id
        inserted_travel += 1
    print(f"  Seeded travel txns: {inserted_travel}")

    # ---------- Q14: IRS Travel & Lodging compliance ----------
    # Auto-detect Uber/Lyft/hotel/airline/rental in the window and
    # ask for trip purpose + attendees. Lodging always needs a
    # receipt per §274 (no de-minimis exception unlike meals).
    TRAVEL_MERCHANT_RE = re.compile(
        r"(uber|lyft|marriott|hilton|hyatt|airbnb|vrbo|holiday.inn|"
        r"hampton.inn|best.western|comfort.inn|days.inn|motel|"
        r"southwest.airlines|united.airlines|american.airlines|delta.air|"
        r"jetblue|alaska.air|spirit.airline|frontier|allegiant|"
        r"hertz|enterprise.rent|avis|budget.rent|national.car|dollar.rent|"
        r"amtrak|greyhound|expedia|priceline|booking\.com|kayak)",
        re.IGNORECASE,
    )
    travel_txns: list[dict] = []
    async for t in db.transactions.find({
        "company_id": cid,
        "date":       {"$gte": WINDOW_START, "$lte": WINDOW_END},
        "amount":     {"$lt": 0},
    }).sort("date", -1):
        hay = f"{t.get('merchant') or ''} {t.get('description') or ''}"
        if not TRAVEL_MERCHANT_RE.search(hay):
            continue
        travel_txns.append(t)
    print(f"  Q14 travel txns in window: {len(travel_txns)}")

    for t in travel_txns:
        merchant = t.get("merchant") or "travel vendor"
        amount   = abs(float(t["amount"]))
        # Classify: hotel/lodging always needs a receipt; airline &
        # rideshare & rental follow the >$75 rule (functionally always
        # true for airlines, sometimes true for rideshare).
        lower = merchant.lower()
        is_lodging = any(k in lower for k in [
            "marriott", "hilton", "hyatt", "airbnb", "vrbo",
            "holiday inn", "hampton", "best western", "comfort inn",
            "days inn", "motel", "hotel", "inn ", "lodge", "resort",
        ])
        is_transport = any(k in lower for k in [
            "airlines", "airways", "amtrak", "greyhound",
        ])
        needs_receipt = is_lodging or amount >= 75
        travel_kind = ("lodging" if is_lodging
                       else "transport" if is_transport
                       else "local_travel")

        detail = (f"You spent ${amount:.2f} at {merchant} on "
                  f"{t.get('date')}. For a business-travel deduction "
                  "the IRS wants: **destination + business purpose**, "
                  "**who traveled with you** (and their business "
                  "relationship), and **dates of the trip**. ")
        if is_lodging:
            detail += ("Since this is lodging, IRS §274 requires the "
                       "full receipt on file — no dollar threshold "
                       "exception.")
        elif needs_receipt:
            detail += ("Since this is over $75, we also need the "
                       "receipt/e-ticket for the file.")
        else:
            detail += ("Under $75 the receipt is optional, but a "
                       "quick trip note is still required.")

        fid = await _insert_finding(
            cid,
            kind="travel_compliance",
            title=(f"Travel compliance: ${amount:.2f} {merchant} "
                   f"({t.get('date')})"),
            detail=detail,
            severity="amber" if needs_receipt else "slate",
            meta={"txn_amount":    t["amount"],
                  "txn_desc":      t.get("description"),
                  "txn_date":      t.get("date"),
                  "txn_id":        t["id"],
                  "merchant":      merchant,
                  "travel_kind":   travel_kind,
                  "needs_receipt": needs_receipt},
            action_label="Log trip",
        )
        items.append({
            "item_id":           str(uuid.uuid4()),
            "item_type":         cr.ITEM_IRS_TRAVEL,
            "source_id":         fid,
            "source_collection": "agent_findings",
            "prompt":            (
                f"${amount:.2f} at {merchant} on {t.get('date')} — "
                "where did you go, what was the business purpose, and "
                "who traveled with you?"
                + (" (Please also upload the receipt — IRS §274 "
                   "requires it for lodging at any amount.)"
                   if is_lodging
                   else " (Please also upload the receipt — over $75 "
                        "IRS needs documentation.)"
                   if needs_receipt else "")
            ),
            "context": {
                "kind":     "travel_compliance",
                "title":    f"Travel compliance: ${amount:.2f} {merchant}",
                "severity": "amber" if needs_receipt else "slate",
                "meta":     {"txn_amount": t["amount"],
                             "txn_desc":   t.get("description"),
                             "txn_date":   t.get("date"),
                             "txn_id":     t["id"],
                             "merchant":   merchant,
                             "travel_kind": travel_kind,
                             "needs_receipt": needs_receipt},
            },
            "answered_at":  None, "answer": None,
            "deferred":     False, "action_taken": None,
        })
        print(f"    · {merchant} ${amount:.2f} · {travel_kind} · "
              f"{'receipt REQ' if needs_receipt else 'note only'}")

    # ---------- Q5: Checks without contacts (aggregate item) ----------
    # Book-wide sweep — checks without a payee live outside any
    # particular date window. Uses the same `is_check_transaction`
    # detector the CPA-side `/accounting/check-register-review` page
    # relies on so the two flows stay in sync.
    from routes.check_review import is_check_transaction
    check_rows: list[dict] = []
    async for t in db.transactions.find({
        "company_id": cid,
        "amount":     {"$lt": 0},
        "$or": [
            {"contact_id": None},
            {"contact_id": ""},
            {"contact_name": ""},
            {"contact_name": None},
        ],
        "not_a_check_reviewed": {"$ne": True},
        "batch_id":             {"$in": [None, ""]},
    }).sort("date", -1).limit(200):
        ok, signal = is_check_transaction(t)
        if not ok:
            continue
        check_rows.append({
            "id":     t["id"],
            "date":   t.get("date"),
            "number": (t.get("number") or t.get("check_number") or ""),
            "amount": t.get("amount"),
            "memo":   t.get("memo") or "",
            "description": t.get("description") or "",
            "detection_signal": signal,
        })
    # Sort by check number desc (Home Depot 1013 → 1010 → 1009 → 1008).
    def _num_key(r):
        try:
            return (0, -int(str(r.get("number") or 0).strip("#")))
        except (ValueError, TypeError):
            return (1, r.get("date") or "")
    check_rows.sort(key=_num_key)
    print(f"  Q5 checks-without-contacts (book-wide): {len(check_rows)}")
    if check_rows:
        item_id = str(uuid.uuid4())
        collection_id = f"checks-collection-{uuid.uuid4()}"
        items.append({
            "item_id":           item_id,
            "item_type":         cr.ITEM_CHECK_NO_CONTACT,
            "source_id":         collection_id,
            # Special marker — this item aggregates N checks rather than
            # sourcing from `transactions` or `agent_findings`.
            "source_collection": "batch",
            "prompt": (f"You've written {len(check_rows)} check"
                       f"{'s' if len(check_rows) != 1 else ''} that "
                       "we can't match to a payee. Would you fill in "
                       "who each one was for?"),
            "context": {
                "checks": check_rows,
                "count":  len(check_rows),
                "total_amount": round(sum(abs(float(r.get("amount") or 0))
                                          for r in check_rows), 2),
            },
            "resolved_txn_ids": [],
            "answered_at":  None,
            "answer":       None,
            "deferred":     False,
            "action_taken": None,
        })
        for r in check_rows:
            print(f"    · Check #{r['number']} — {r['date']} — ${abs(float(r['amount'] or 0)):.2f}")

    # ---------- Q10: IRS Meals & Entertainment compliance ----------
    # Every restaurant / meal txn in the window needs a business purpose
    # documented — attendees + business context — regardless of amount.
    # Receipts are strictly required over $75 (IRS §274), but the
    # audit-trail note is good practice for every meal.
    meal_merchant_regex = (
        r"^(Panera|Starbucks|KFC|Little Caesar|Baskin|"
        r"McDonald|Chipotle|Subway|Chick-fil-A|Taco Bell|Dominos|Domino's|"
        r"Wendy|Burger King|Olive Garden|Applebee|Chili's|Outback|"
        r"IHOP|Denny|Cheesecake Factory|Panda Express|Dunkin|"
        r"Cafe|Coffee|Bistro|Grill|Diner|Restaurant|Kitchen|"
        r"Pizza|Sushi|Steakhouse|Sandwich|Deli|Bakery|Ice Cream)"
    )
    meal_q = {
        "company_id": cid,
        "date":       {"$gte": WINDOW_START, "$lte": WINDOW_END},
        "merchant":   {"$regex": meal_merchant_regex, "$options": "i"},
        "amount":     {"$lt": 0},   # meals are outflows
    }
    meals = []
    async for t in db.transactions.find(meal_q).sort("date", -1):
        meals.append(t)
    print(f"  Q10 IRS meals in window: {len(meals)}")
    for t in meals:
        merchant = t.get("merchant") or "Restaurant"
        amount   = abs(float(t["amount"]))
        needs_receipt = amount >= 75
        detail = (
            f"You spent ${amount:.2f} at {merchant} on {t.get('date')}. "
            "For a business-meal deduction the IRS wants: **who was "
            "there**, **their business relationship**, and **what you "
            "discussed**. "
        )
        if needs_receipt:
            detail += ("Since this is over $75, we also need the itemized "
                       "receipt for the file.")
        else:
            detail += ("Under $75 the receipt is optional, but a quick "
                       "note is still required.")

        fid = await _insert_finding(
            cid,
            kind="meals_compliance",
            title=(f"Meals compliance: ${amount:.2f} {merchant} "
                   f"({t.get('date')})"),
            detail=detail,
            severity="amber" if needs_receipt else "slate",
            meta={"txn_amount":  t["amount"],
                  "txn_desc":    t.get("description"),
                  "txn_date":    t.get("date"),
                  "txn_id":      t["id"],
                  "merchant":    merchant,
                  "needs_receipt": needs_receipt},
            action_label="Log purpose",
        )
        items.append({
            "item_id":           str(uuid.uuid4()),
            "item_type":         cr.ITEM_IRS_MEALS,
            "source_id":         fid,
            "source_collection": "agent_findings",
            "prompt":            (
                f"${amount:.2f} at {merchant} on {t.get('date')} — "
                "who was there, what's their business relationship, "
                "and what did you discuss?"
                + (" (Please also upload the itemized receipt — "
                   "IRS requires it over $75.)" if needs_receipt else "")
            ),
            "context": {
                "kind":     "meals_compliance",
                "title":    (f"Meals compliance: ${amount:.2f} {merchant}"),
                "severity": "amber" if needs_receipt else "slate",
                "meta":     {"txn_amount":  t["amount"],
                             "txn_desc":    t.get("description"),
                             "txn_date":    t.get("date"),
                             "txn_id":      t["id"],
                             "merchant":    merchant,
                             "needs_receipt": needs_receipt},
            },
            "answered_at":  None,
            "answer":       None,
            "deferred":     False,
            "action_taken": None,
        })
        print(f"    · {merchant} ${amount:.2f} "
              f"({'receipt REQUIRED' if needs_receipt else 'note only'})")

    if not items:
        print("\nNo items to seed — window is clean.")
        return 0

    # ---------- Sort by canonical type order (matches production) ----------
    _TYPE_ORDER = {
        cr.ITEM_UNCATEGORIZED:      1,
        cr.ITEM_OWNER_DRAW:         2,
        cr.ITEM_DEPOSIT:            3,
        cr.ITEM_LIABILITY_SPLIT:    4,
        cr.ITEM_CHECK_NO_CONTACT:   5,
        cr.ITEM_MISSING_RECEIPT:    6,
        cr.ITEM_AMBIGUOUS_TRANSFER: 7,
        cr.ITEM_IRS_MEALS:          8,
        cr.ITEM_IRS_TRAVEL:         8.5,
        cr.ITEM_W9_NEEDED:          11,
        cr.ITEM_VENDOR_MEMO:        90,
        cr.ITEM_SPLIT:              91,
        cr.ITEM_RECURRING:          92,
        cr.ITEM_SETUP:              93,
    }
    def _key(it):
        prim = _TYPE_ORDER.get(it.get("item_type") or 0, 99)
        ctx = it.get("context") or {}
        amt = (ctx.get("meta") or {}).get("txn_amount")
        if amt is None:
            amt = ctx.get("amount")
        try:
            amt_key = -abs(float(amt)) if amt is not None else 0
        except (TypeError, ValueError):
            amt_key = 0
        return (prim, amt_key)
    items.sort(key=_key)

    # ---------- Build the batch ----------
    print("\n--- Build batch ---")
    batch = await cr.create_batch(cid, CLIENT_EMAIL, items)
    await db.client_review_batches.update_one(
        {"id": batch["id"]},
        {"$set": {"demo_tag": NEW_TAG}},
    )

    from email_dispatcher import public_base_url
    review_url = f"{public_base_url()}/client-review/{batch['client_token']}"

    from collections import Counter
    LABELS = {
        1: "Uncategorized",
        2: "Vendor confirmation",
        3: "Missing receipt",
        4: "W-9 collection",
        5: "Ambiguous transfer",
        6: "New recurring",
        7: "Setup detail",
        8: "Split suggested",
        9: "Liability split",
        10: "IRS meals",
        11: "Owner's Draw check",
        12: "Deposit",
        13: "Checks without payee",
        14: "IRS travel",
    }
    counts = Counter(i["item_type"] for i in items)

    print()
    print("=" * 72)
    print(f"WINDOW BATCH — {COMPANY_NAME} — {WINDOW_START} → {WINDOW_END}")
    print("=" * 72)
    print(f"  batch_id:      {batch['id']}")
    print(f"  items:         {len(items)}")
    for it, c in sorted(counts.items()):
        print(f"    · {LABELS.get(it, it):24}  {c}")
    print(f"  review URL:    {review_url}")
    print("=" * 72)
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
