"""Axiom Ledger — Check Register Review (Step 4 of AI Cleanup Copilot).

For Plaid-imported checks that arrive with no payee (the real-world
default — see /app/memory/CHECK_REGISTER_ROADMAP.md). Lets the pro
assign payee + category (with optional multi-line splits) in a
compact table. Distinct concern from `routes/checks.py` which is for
PRINTING outbound checks.

Endpoints (all prefixed `/api/companies/{cid}/check-review`):
  GET  /unassigned          — paginated list of check-like rows w/o payee
  POST /{txn_id}/assign     — assign payee + line_items (validates sum)
  POST /{txn_id}/not-a-check — flag row so future scans skip it
"""
from __future__ import annotations

import re
import uuid
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from db import db, now_iso
from auth import get_current_user
from deps import require_company

router = APIRouter(prefix="/api")


# ---------------------------------------------------------------------------
# Check detection — the six identification signals from the spec, most
# authoritative first. Callable from both the review endpoints AND the
# frontend badge count.
# ---------------------------------------------------------------------------

_CHECK_DESC_RE = re.compile(
    r"^\s*(?:check|chk)\s*#?\s*\d+\b|\bck\s*#?\s*\d+\b",
    re.IGNORECASE,
)


def is_check_transaction(txn: dict) -> tuple[bool, str]:
    """Return (is_check, detection_signal).

    The signal string is preserved on the row's response so the frontend
    can show "detected via Plaid" vs "detected via description regex" —
    useful when a bookkeeper wants to know why a row landed in this
    queue. See spec at /app/memory/CHECK_REGISTER_ROADMAP.md.
    """
    if txn.get("not_a_check_reviewed"):
        return False, "flagged_not_a_check"
    pm = txn.get("plaid_metadata") or {}
    if pm.get("transaction_code") == "check":
        return True, "plaid_transaction_code"
    if pm.get("payment_meta") and pm["payment_meta"].get("reference_number"):
        # Reference number on an outgoing Plaid row is a very strong
        # check signal (Plaid uses this field for check numbers).
        if (txn.get("amount") or 0) < 0:
            return True, "plaid_reference_number"
    raw = txn.get("raw") or {}
    if isinstance(raw, dict) and raw.get("PaymentType") == "Check":
        return True, "qbo_payment_type"
    desc = (txn.get("description") or "").strip()
    if _CHECK_DESC_RE.search(desc):
        return True, "description_regex"
    if txn.get("check_number"):
        return True, "check_number_field"
    if txn.get("txn_type") == "Purchase" and txn.get("number"):
        return True, "qbo_purchase_number"
    return False, ""


# ---------------------------------------------------------------------------
# GET /check-review/unassigned
# ---------------------------------------------------------------------------

@router.get("/companies/{cid}/check-review/unassigned")
async def list_unassigned_checks(
    cid: str,
    limit: int = Query(100, ge=1, le=500),
    skip: int = Query(0, ge=0),
    user: dict = Depends(get_current_user),
):
    """Paginated list of check-like rows without a payee. Idempotent."""
    await require_company(user, cid)
    # Broad Mongo pre-filter — anything that COULD be a check, missing
    # a payee, and hasn't been flagged as "not a check". Final check-
    # detection runs in Python via `is_check_transaction()` which
    # applies the full six-signal cascade.
    q = {
        "company_id": cid,
        "amount": {"$lt": 0},  # checks are outgoing
        "$or": [
            {"contact_id": None},
            {"contact_id": ""},
            {"contact_name": ""},
            {"contact_name": None},
        ],
        "not_a_check_reviewed": {"$ne": True},
    }
    # Sort by check number (desc) via the `number` field, falling back
    # to date (desc). Since `number` is a string in some ingest paths,
    # we sort by date at the DB level and re-sort in Python for the
    # subset that has numeric check numbers.
    cursor = db.transactions.find(q).sort([("date", -1), ("created_at", -1)])
    checks: list[dict] = []
    scanned = 0
    total_amount = 0.0
    async for t in cursor:
        scanned += 1
        ok, signal = is_check_transaction(t)
        if not ok:
            continue
        checks.append({
            "id": t["id"],
            "date": t.get("date"),
            "number": t.get("number") or t.get("check_number") or "",
            "amount": t.get("amount"),
            "memo": t.get("memo") or "",
            "description": t.get("description") or "",
            "contact_id": t.get("contact_id"),
            "contact_name": t.get("contact_name") or "",
            "line_items": t.get("line_items") or [],
            "category_account_id": t.get("category_account_id"),
            "category_account_name": t.get("category_account_name") or "",
            "detection_signal": signal,
        })
        total_amount += float(t.get("amount") or 0)
    # Re-sort so numeric-check-number rows come first, then by date.
    def _num_key(row):
        try:
            return (0, -int(str(row.get("number") or 0).strip("#")))
        except (ValueError, TypeError):
            return (1, row.get("date") or "")
    checks.sort(key=_num_key)
    return {
        "total": len(checks),
        "total_amount": round(total_amount, 2),
        "scanned": scanned,
        "checks": checks[skip:skip + limit],
        "skip": skip,
        "limit": limit,
    }


# ---------------------------------------------------------------------------
# POST /check-review/{txn_id}/assign
# ---------------------------------------------------------------------------

class CheckLineItemIn(BaseModel):
    # Either category_account_id OR bill_id must be set on each line.
    # `bill_id` lines settle an open A/P bill (creates a db.payments doc
    # and decrements bill.balance_due) mirroring the client-review
    # /check-assign endpoint so the Review Chat has feature parity with
    # Quick Check-in.
    category_account_id: Optional[str] = None
    bill_id: Optional[str] = None
    amount: float
    description: Optional[str] = None


class CheckAssignIn(BaseModel):
    contact_id: Optional[str] = None
    # When contact_id is None, inline-create via {name, type}.
    create_contact_name: Optional[str] = None
    line_items: list[CheckLineItemIn] = Field(default_factory=list)
    save_as_rule: bool = False
    mark_reviewed: bool = True


@router.post("/companies/{cid}/check-review/{txn_id}/assign")
async def assign_check(
    cid: str,
    txn_id: str,
    inp: CheckAssignIn,
    user: dict = Depends(get_current_user),
):
    """Assign payee + line splits to a check-like transaction.

    Idempotent for the same input. Sum of `line_items[*].amount` must
    equal the transaction's absolute amount (the classic check split
    validator).
    """
    await require_company(user, cid)
    txn = await db.transactions.find_one({"id": txn_id, "company_id": cid})
    if not txn:
        raise HTTPException(404, "Transaction not found")

    # Pre-load bills referenced by any bill_id line (feature parity
    # with the client-review /check-assign flow). Also lets a bill-only
    # line derive the payee from the bill's vendor when the CPA didn't
    # bother picking one.
    bill_lookup: dict[str, dict] = {}
    for li in inp.line_items:
        if li.bill_id and li.bill_id not in bill_lookup:
            b = await db.bills.find_one(
                {"id": li.bill_id, "company_id": cid},
            )
            if not b:
                raise HTTPException(400, f"Unknown bill_id {li.bill_id}")
            bill_lookup[li.bill_id] = b

    # Resolve/create the payee.
    contact_id = inp.contact_id
    contact_name = ""
    if bill_lookup and not contact_id and not inp.create_contact_name:
        # Derive from bill vendor if all bills point to the same one.
        vendors = {b.get("contact_id") for b in bill_lookup.values()
                   if b.get("contact_id")}
        if len(vendors) == 1:
            contact_id = next(iter(vendors))
            v = await db.contacts.find_one({"id": contact_id, "company_id": cid})
            contact_name = (v or {}).get("name") or ""
    if not contact_id and inp.create_contact_name:
        # Reuse the existing /contacts/ensure semantics inline (avoid an
        # extra roundtrip). Idempotent by name.
        existing = await db.contacts.find_one(
            {"company_id": cid, "name": inp.create_contact_name.strip()},
        )
        if existing:
            contact_id = existing["id"]
            contact_name = existing["name"]
        else:
            import uuid as _uuid
            contact_id = str(_uuid.uuid4())
            contact_name = inp.create_contact_name.strip()
            await db.contacts.insert_one({
                "id": contact_id,
                "company_id": cid,
                "name": contact_name,
                "type": "vendor",
                "created_at": now_iso(),
                "source": "check_review_inline",
            })
    elif contact_id:
        c = await db.contacts.find_one({"id": contact_id, "company_id": cid})
        if not c:
            raise HTTPException(400, "contact_id not found")
        contact_name = c.get("name") or ""
    else:
        raise HTTPException(400, "Provide contact_id, create_contact_name, or a bill_id")

    # Validate sum matches the check amount.
    expected = round(abs(float(txn.get("amount") or 0)), 2)
    got = round(sum(li.amount for li in inp.line_items), 2)
    if inp.line_items and abs(got - expected) > 0.005:
        raise HTTPException(
            400,
            f"Line total ${got:.2f} doesn't match check amount ${expected:.2f}",
        )
    # Each line must have either a category or a bill.
    for li in inp.line_items:
        if not li.category_account_id and not li.bill_id:
            raise HTTPException(400, "Each line needs a category or a bill.")

    # Resolve account names for the frontend display (only for
    # category-lines — bill-lines derive their category from the bill's
    # default account below).
    acct_ids = [li.category_account_id for li in inp.line_items if li.category_account_id]
    acct_docs: dict[str, dict] = {}
    if acct_ids:
        async for a in db.accounts.find(
            {"company_id": cid, "id": {"$in": acct_ids}},
        ):
            acct_docs[a["id"]] = a
    for li in inp.line_items:
        if li.category_account_id and li.category_account_id not in acct_docs:
            raise HTTPException(
                400,
                f"category_account_id {li.category_account_id} not on this company",
            )

    # ---- Bill balance-due decrement + payment doc creation --------
    # Mirrors client_review.apply_check_assign so a check applied to an
    # open bill from Review Chat updates AP aging, vendor ledger, and
    # bill status (paid/partial) exactly the same way as the client-side
    # Quick Check-in path. payment_ids are stashed on the txn so a
    # future reopen can reverse the linkage.
    payment_ids: list[str] = []
    for li in inp.line_items:
        if not li.bill_id:
            continue
        b = bill_lookup[li.bill_id]
        old_bal = float(b.get("balance_due", b.get("total", 0)) or 0)
        new_bal = round(max(0.0, old_bal - float(li.amount)), 2)
        new_status = "paid" if new_bal < 0.005 else "partial"
        await db.bills.update_one(
            {"id": li.bill_id, "company_id": cid},
            {"$set": {"balance_due": new_bal,
                      "status":      new_status,
                      "updated_at":  now_iso()},
             "$push": {"applied_check_txn_ids": txn_id}},
        )
        pid = str(uuid.uuid4())
        payment_ids.append(pid)
        await db.payments.insert_one({
            "id":                    pid,
            "company_id":            cid,
            "date":                  txn.get("date"),
            "amount":                round(float(li.amount), 2),
            "contact_id":            contact_id,
            "contact_name":          contact_name,
            "method":                "check",
            "direction":             "out",
            "bank_account_id":       txn.get("bank_account_id"),
            "memo":                  li.description or "",
            "linked_bill_id":        li.bill_id,
            "applications":          [{"bill_id": li.bill_id,
                                       "amount":  round(float(li.amount), 2)}],
            "source_transaction_id": txn_id,
            "source":                "check_review_check_assign",
            "created_at":            now_iso(),
            "updated_at":            now_iso(),
        })

    # Build the persisted splits array — one entry per line. Bill-lines
    # get their category derived from the bill's default_account_id
    # (falls back to null if the bill has none). If only one line, we
    # ALSO stamp the top-level `category_account_*` fields so the row
    # shows correctly in every non-split-aware UI surface.
    stored_lines = []
    for li in inp.line_items:
        if li.category_account_id:
            a = acct_docs.get(li.category_account_id, {})
            stored_lines.append({
                "category_account_id":   li.category_account_id,
                "category_account_code": a.get("code"),
                "category_account_name": a.get("name"),
                "bill_id":               li.bill_id,
                "amount":                li.amount,
                "description":           li.description or "",
            })
        else:
            b = bill_lookup[li.bill_id]
            default_acct = b.get("default_account_id")
            a = {}
            if default_acct:
                a = await db.accounts.find_one(
                    {"id": default_acct, "company_id": cid},
                ) or {}
            stored_lines.append({
                "category_account_id":   default_acct,
                "category_account_code": a.get("code"),
                "category_account_name": a.get("name"),
                "bill_id":               li.bill_id,
                "amount":                li.amount,
                "description":           li.description or "",
            })

    update = {
        "contact_id": contact_id,
        "contact_name": contact_name,
        "line_items": stored_lines,
        "splits":     stored_lines,
        "posted":     True,
        "updated_at": now_iso(),
    }
    if payment_ids:
        update["linked_payment_ids"] = payment_ids
    if stored_lines:
        # Top-level category = first (or only) line. Multi-line splits
        # will show all lines in split-aware views (Transactions, JE,
        # reports); non-aware views will show the first line only.
        first = stored_lines[0]
        update["category_account_id"] = first["category_account_id"]
        update["category_account_code"] = first["category_account_code"]
        update["category_account_name"] = first["category_account_name"]
    if inp.mark_reviewed:
        update["human_reviewed"] = True
        update["needs_review"] = False
        update["check_review_completed_at"] = now_iso()

    await db.transactions.update_one(
        {"id": txn_id, "company_id": cid},
        {"$set": update},
    )

    # Optional: save a payee→category rule so future checks from the
    # same payee auto-categorize. Uses the existing rules collection
    # so the miner + UI pick it up seamlessly.
    rule_created = False
    if inp.save_as_rule and len(stored_lines) == 1 and contact_id and stored_lines[0].get("category_account_id"):
        import uuid as _uuid
        existing_rule = await db.rules.find_one({
            "company_id": cid,
            "contact_id": contact_id,
            "category_account_id": stored_lines[0]["category_account_id"],
        })
        if not existing_rule:
            await db.rules.insert_one({
                "id": str(_uuid.uuid4()),
                "company_id": cid,
                "match_type": "contact",
                "contact_id": contact_id,
                "contact_name": contact_name,
                "category_account_id": stored_lines[0]["category_account_id"],
                "category_account_code": stored_lines[0]["category_account_code"],
                "category_account_name": stored_lines[0]["category_account_name"],
                "created_by": "check_review",
                "created_at": now_iso(),
                "priority": 100,
                "active": True,
            })
            rule_created = True

    return {
        "ok": True,
        "txn_id": txn_id,
        "contact_id": contact_id,
        "contact_name": contact_name,
        "line_count": len(stored_lines),
        "rule_created": rule_created,
    }


# ---------------------------------------------------------------------------
# POST /check-review/{txn_id}/not-a-check
# ---------------------------------------------------------------------------

@router.post("/companies/{cid}/check-review/{txn_id}/not-a-check")
async def flag_not_a_check(
    cid: str,
    txn_id: str,
    user: dict = Depends(get_current_user),
):
    """Flag a transaction so it no longer appears in the check-review
    queue. Idempotent — safe to call repeatedly. Doesn't touch category,
    contact, or amount. Undo by clearing the flag manually if ever
    needed (no undo endpoint in v1 — the setting is trivial).
    """
    await require_company(user, cid)
    r = await db.transactions.update_one(
        {"id": txn_id, "company_id": cid},
        {"$set": {
            "not_a_check_reviewed": True,
            "updated_at": now_iso(),
        }},
    )
    if r.matched_count == 0:
        raise HTTPException(404, "Transaction not found")
    return {"ok": True, "txn_id": txn_id}
