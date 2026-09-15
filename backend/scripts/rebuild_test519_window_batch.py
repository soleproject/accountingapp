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
]
NEW_TAG         = "seed_test519_window_v1"


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
             "demo_txns": 0}
    # Any lingering synthetic transactions from the original seed.
    res = await db.transactions.delete_many({
        "company_id": cid,
        "$or": [
            {"demo_tag": {"$in": STALE_TAGS}},
            {"id": {"$regex": r"^demo1-"}},
        ],
    })
    stats["demo_txns"] = res.deleted_count

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
        cr.ITEM_MISSING_RECEIPT:    6,
        cr.ITEM_AMBIGUOUS_TRANSFER: 7,
        cr.ITEM_IRS_MEALS:          8,
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
