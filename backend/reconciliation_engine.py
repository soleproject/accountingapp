"""Axiom Ledger — Reconciliation engine.

Powers three flows:

R1  Plaid auto-clear     Called from the Plaid sync path. Posted txns older
                          than a provisional window get `cleared_at` set to
                          their transaction date so they contribute to
                          "already reconciled" status without user input.

R2  Manual matching      /preview + /complete endpoints backing the interactive
                          reconciliation UI (pick account/date/balance → tick
                          items → watch the diff hit $0 → finish).

R3  Statement matcher    /match-statement runs Veryfi OCR on an uploaded PDF,
                          fuzzy-scores each extracted line against uncleared
                          ledger txns, and returns candidates grouped by
                          confidence tier.

Runs entirely in-process, no external services beyond the existing Veryfi hit.
Kept transparent — every automated clear stores its `cleared_source` so audit
logs can distinguish Plaid-auto from statement-match from user-tick.
"""
from __future__ import annotations
import re
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone, timedelta, date as dt_date
from typing import Optional

from db import db, now_iso


PROVISIONAL_DAYS = 5  # Match Plaid's typical repost window.

# Words we strip when computing description similarity — pure bank noise.
_DESC_NOISE = re.compile(
    r"\b(pos|purchase|debit|credit|payment|transfer|xfer|ach|deposit|withdrawal|"
    r"web|ppd|ccd|pmt|from|to|ref|id|check|chk|no|nbr|number|#|inst|online|"
    r"mobile|banking|card|ending|in|on|@)\b",
    re.IGNORECASE,
)
_NUMERIC_TOKENS = re.compile(r"\b\d{2,}\b")
_PUNCT = re.compile(r"[^\w\s]")


def _normalize_desc(s: str) -> set[str]:
    """Turn a raw description into a bag-of-tokens for Jaccard scoring."""
    if not s:
        return set()
    s = s.lower()
    s = _NUMERIC_TOKENS.sub(" ", s)   # store numbers, POS ids, etc.
    s = _DESC_NOISE.sub(" ", s)
    s = _PUNCT.sub(" ", s)
    return {tok for tok in s.split() if len(tok) >= 2}


def _jaccard(a: set, b: set) -> float:
    if not a or not b:
        return 0.0
    inter = len(a & b)
    union = len(a | b)
    return inter / union if union else 0.0


def _parse_date(d: str) -> Optional[dt_date]:
    try:
        return datetime.fromisoformat(str(d)[:10]).date()
    except Exception:
        return None


# ---------------------------------------------------------------------------
# R1 — Plaid auto-clear
# ---------------------------------------------------------------------------

async def auto_clear_settled_plaid_txns(cid: str) -> dict:
    """Set `cleared_at` on posted Plaid txns older than the provisional window.

    Idempotent — only touches rows that don't already have a cleared timestamp.
    Called after every Plaid sync AND once from the recon UI on demand.
    """
    cutoff = (datetime.now(timezone.utc) - timedelta(days=PROVISIONAL_DAYS)).date().isoformat()
    result = await db.transactions.update_many(
        {
            "company_id": cid,
            "source": {"$regex": "^plaid"},   # includes both `plaid` and `plaid_mock`
            "posted": True,
            "cleared_at": {"$in": [None, "", False]},
            "date": {"$lte": cutoff},
            # Never auto-clear items Plaid flagged pending.
            "plaid_pending": {"$ne": True},
        },
        # `$currentDate` isn't quite right here — we want the txn's own date,
        # not "now" — so we set the source flag and do a follow-up update per
        # doc if needed. For MVP we set cleared_at = date directly via aggregation.
        [
            {"$set": {
                "cleared_at": "$date",
                "cleared_source": "plaid_auto",
                "updated_at": now_iso(),
            }},
        ],
    )
    return {"cleared": result.modified_count}


# ---------------------------------------------------------------------------
# R2 — Manual matching preview / complete
# ---------------------------------------------------------------------------

async def preview_recon(
    cid: str, bank_account_id: str, as_of: str,
    opening_balance: float = 0.0, closing_balance: float = 0.0,
) -> dict:
    """Return everything the reconciliation UI needs to render the interactive
    matcher: uncleared txns through `as_of`, book balance, and the starting
    difference. Diff = closing − opening − cleared_sum (classic recon math,
    reduces to 0 when the pro has ticked exactly the right items)."""
    # Book balance: sum of every posted txn for the bank account through as_of.
    pipe = [
        {"$match": {
            "company_id": cid,
            "bank_account_id": bank_account_id,
            "posted": True,
            "date": {"$lte": as_of},
        }},
        {"$group": {"_id": None, "total": {"$sum": "$amount"}}},
    ]
    agg = await db.transactions.aggregate(pipe).to_list(1)
    book_balance = round(float(agg[0]["total"]) if agg else 0.0, 2)

    uncleared_docs = await db.transactions.find({
        "company_id": cid,
        "bank_account_id": bank_account_id,
        "posted": True,
        "date": {"$lte": as_of},
        "$or": [
            {"cleared_at": None},
            {"cleared_at": {"$exists": False}},
            {"cleared_at": ""},
        ],
    }).sort("date", 1).to_list(1000)

    uncleared = [{
        "id": t["id"], "date": t.get("date"), "amount": t.get("amount"),
        "description": t.get("description") or t.get("merchant"),
        "merchant": t.get("merchant"),
        "category_account_name": t.get("category_account_name"),
    } for t in uncleared_docs]

    op = round(float(opening_balance), 2)
    cl = round(float(closing_balance), 2)
    # No cleared items yet on preview (client tracks the ticks locally).
    diff = round(cl - op - 0.0, 2)
    return {
        "book_balance": book_balance,
        "opening_balance": op,
        "closing_balance": cl,
        "statement_balance": cl,
        "difference": diff,
        "uncleared": uncleared,
    }


async def complete_recon(
    cid: str, bank_account_id: str, period_end: str, period_start: Optional[str],
    opening_balance: float, closing_balance: float, cleared_txn_ids: list[str],
    user_email: str,
) -> dict:
    """Snapshot the reconciliation. If the range spans multiple calendar
    months, split the input into ONE reconciliation doc per month (each with
    its own opening/closing derived from a rolling sum), so the history list
    shows a per-month report even when the pro reconciles a large backfill
    in one go."""
    if not cleared_txn_ids:
        raise ValueError("Nothing selected to clear.")
    if not period_start:
        period_start = period_end
    now = now_iso()

    # Fetch the cleared txns so we can group by month.
    txns = await db.transactions.find(
        {"company_id": cid, "id": {"$in": cleared_txn_ids}}
    ).to_list(len(cleared_txn_ids) + 1)
    if not txns:
        raise ValueError("Selected transactions not found.")

    # Group by (year, month) and compute per-month sums.
    from collections import OrderedDict
    buckets: "OrderedDict[tuple[int,int], list[dict]]" = OrderedDict()
    def _key(t):
        d = _parse_date(t.get("date")) or _parse_date(period_end)
        return (d.year, d.month) if d else (0, 0)
    for t in sorted(txns, key=lambda t: t.get("date") or ""):
        buckets.setdefault(_key(t), []).append(t)

    open_bal = round(float(opening_balance), 2)
    close_bal = round(float(closing_balance), 2)
    running = open_bal
    created = []

    # For each month in the range, create a reconciliation snapshot whose
    # opening = the running balance at the start of that month and whose
    # closing = opening + sum-of-that-month's cleared amounts.
    for (yy, mm), rows in buckets.items():
        last_day = _month_last_day(yy, mm)
        p_start = f"{yy:04d}-{mm:02d}-01"
        p_end = f"{yy:04d}-{mm:02d}-{last_day:02d}"
        # Clamp to the user-provided range.
        if period_start and p_start < period_start: p_start = period_start
        if period_end and p_end > period_end: p_end = period_end
        month_sum = round(sum(float(t.get("amount") or 0) for t in rows), 2)
        month_open = running
        month_close = round(running + month_sum, 2)
        # For a partial-range last month, honor the user's stated closing.
        is_last = (yy, mm) == next(reversed(buckets))
        if is_last:
            month_close = close_bal
        rec_id = str(uuid.uuid4())
        rec_txn_ids = [t["id"] for t in rows]
        doc = {
            "id": rec_id, "company_id": cid, "bank_account_id": bank_account_id,
            "as_of": p_end,
            "period_start": p_start,
            "period_end": p_end,
            "opening_balance": month_open,
            "closing_balance": month_close,
            "statement_balance": month_close,  # kept for legacy readers
            "cleared_sum": month_sum,
            "difference": round(month_close - month_open - month_sum, 2),
            "cleared_txn_ids": rec_txn_ids,
            "matched_count": len(rec_txn_ids),
            "source": "manual",
            "status": "reconciled",
            "completed_at": now, "completed_by": user_email,
            "created_at": now, "updated_at": now,
        }
        await db.reconciliations.insert_one(doc)
        await db.transactions.update_many(
            {"company_id": cid, "id": {"$in": rec_txn_ids}},
            {"$set": {
                "cleared_at": p_end,
                "cleared_source": "manual",
                "cleared_reconciliation_id": rec_id,
                "updated_at": now,
            }},
        )
        created.append(rec_id)
        running = month_close

    return {"created": created, "count": len(created), "total_cleared": len(cleared_txn_ids)}


def _month_last_day(y: int, m: int) -> int:
    from calendar import monthrange
    return monthrange(y, m)[1]


# ---------------------------------------------------------------------------
# R3 — Statement fuzzy matcher
# ---------------------------------------------------------------------------

@dataclass
class MatchScore:
    txn_id: str
    score: float
    amount_component: float
    date_component: float
    desc_component: float


def _score_candidate(stmt: dict, txn: dict) -> MatchScore:
    # Amount: exact wins big, ±$0.01 fine, otherwise 0.
    try:
        da = abs(float(stmt.get("amount", 0)) - float(txn.get("amount", 0)))
    except Exception:
        da = 999
    if da < 0.005:      amt = 1.0
    elif da < 0.02:     amt = 0.85
    else:               amt = 0.0

    # Date: ±3 days linear falloff.
    sd = _parse_date(stmt.get("date"))
    td = _parse_date(txn.get("date"))
    if sd and td:
        delta = abs((sd - td).days)
        dt_score = max(0.0, 1.0 - (delta * 0.2))  # -0.2 per day; 0 at ≥5 days
    else:
        dt_score = 0.0

    # Description: Jaccard on normalized tokens.
    stmt_toks = _normalize_desc(stmt.get("description") or stmt.get("merchant", ""))
    txn_toks = _normalize_desc(f"{txn.get('description', '')} {txn.get('merchant', '')}")
    desc = _jaccard(stmt_toks, txn_toks)

    combined = round(0.5 * amt + 0.2 * dt_score + 0.3 * desc, 3)
    return MatchScore(
        txn_id=txn["id"], score=combined,
        amount_component=amt, date_component=dt_score, desc_component=desc,
    )


async def match_statement_lines(
    cid: str, bank_account_id: str, statement_lines: list[dict],
    date_window_days: int = 10,
) -> dict:
    """Score every statement line against uncleared ledger txns, return the
    top candidate per line grouped by confidence tier.

    tiers:
      ≥ 0.90 → auto        (silent bulk-apply)
      0.60 – 0.90 → suggest
      < 0.60 → manual      (statement line has no confident match — likely
                            missing from ledger)
    """
    if not statement_lines:
        return {"auto": [], "suggest": [], "manual": [], "missing_from_statement": []}

    # Pull candidate pool once: uncleared posted txns for the account,
    # within a ±window around the statement's date range.
    all_dates = [d for d in (l.get("date") for l in statement_lines) if d]
    if not all_dates:
        return {
            "auto": [], "suggest": [],
            "manual": [{"line": l, "best": None} for l in statement_lines],
            "missing_from_statement": [],
        }
    lo = min(all_dates)
    hi = max(all_dates)
    lo_d = _parse_date(lo); hi_d = _parse_date(hi)
    if lo_d and hi_d:
        lo = (lo_d - timedelta(days=date_window_days)).isoformat()
        hi = (hi_d + timedelta(days=date_window_days)).isoformat()

    candidates = await db.transactions.find({
        "company_id": cid, "bank_account_id": bank_account_id,
        "posted": True,
        "date": {"$gte": lo, "$lte": hi},
        "$or": [
            {"cleared_at": None},
            {"cleared_at": {"$exists": False}},
            {"cleared_at": ""},
        ],
    }).to_list(2000)

    used: set[str] = set()  # A ledger txn can only match one statement line.
    auto: list[dict] = []
    suggest: list[dict] = []
    manual: list[dict] = []

    for line in statement_lines:
        # Prefilter on amount tolerance to cut scoring work.
        try:
            la = float(line.get("amount", 0))
        except Exception:
            la = 0.0
        pool = [c for c in candidates
                if c["id"] not in used
                and abs(float(c.get("amount", 0)) - la) < 0.02]
        if not pool:
            manual.append({"line": line, "best": None, "score": 0.0})
            continue
        scored = [_score_candidate(line, c) for c in pool]
        scored.sort(key=lambda s: s.score, reverse=True)
        best = scored[0]
        top_txn = next(c for c in pool if c["id"] == best.txn_id)
        entry = {
            "line": line,
            "best": {
                "id": top_txn["id"], "date": top_txn.get("date"),
                "amount": top_txn.get("amount"),
                "description": top_txn.get("description") or top_txn.get("merchant"),
            },
            "score": best.score,
            "components": {
                "amount": best.amount_component,
                "date": best.date_component,
                "desc": best.desc_component,
            },
        }
        if best.score >= 0.90:
            auto.append(entry)
            used.add(best.txn_id)
        elif best.score >= 0.60:
            suggest.append(entry)
            used.add(best.txn_id)
        else:
            manual.append(entry)

    # "Missing from statement" — ledger txns in the same period+account that
    # no statement line matched. Enterprise-grade trust signal: surfaces the
    # transactions a client either forgot to send OR that hit the bank
    # without landing on the paper statement (fraud / duplicate / typo).
    missing = [
        {
            "id": c["id"], "date": c.get("date"),
            "amount": c.get("amount"),
            "description": c.get("description") or c.get("merchant"),
            "category_account_name": c.get("category_account_name"),
        }
        for c in candidates if c["id"] not in used
    ]

    return {
        "auto": auto, "suggest": suggest, "manual": manual,
        "missing_from_statement": missing,
    }


# ---------------------------------------------------------------------------
# Utility — is a bank account fully reconciled for a given month?
# Used by month_close.py to auto-satisfy the `recon` checkpoint.
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# R4 — Plaid bootstrap (auto-reconcile from the Plaid feed itself)
# ---------------------------------------------------------------------------
#
# When Plaid ships a full transaction history + a `current` balance + an
# `opening_balance` anchor, the ledger is already provably in sync with the
# bank feed *if and only if*  opening + Σ(txns) == current.
#
# This function walks every mapped Plaid account, verifies that invariant
# holds end-to-end, then generates ONE `status="reconciled"` doc per fully
# completed calendar month between opening_as_of and (today − PROVISIONAL_DAYS).
#
# Zero fabrication rules:
#   • If the end-to-end invariant fails for an account → the entire account is
#     skipped with a clear reason. No partial fake data.
#   • If a period contains any non-Plaid txn (manual/CSV) for the same bank
#     account → skip that period. Bootstrap only knows about the Plaid feed.
#   • If a real reconciliation already overlaps a period → skip.
#   • `overwrite_placeholders=True` deletes prior "empty" recons for the
#     company (no bank_account_id OR no cleared_txn_ids) before bootstrapping.
#
# What "reconciled" asserts here (be honest with the pro): the ledger matches
# the Plaid transaction feed for the period. It does NOT assert the Plaid feed
# matches the paper statement — that still needs Veryfi (R3).
#
async def bootstrap_from_plaid(
    cid: str,
    plaid_item_id: Optional[str] = None,
    overwrite_placeholders: bool = False,
) -> dict:
    from calendar import monthrange
    now = now_iso()
    today = datetime.now(timezone.utc).date()
    cutoff = (today - timedelta(days=PROVISIONAL_DAYS))  # last day we consider "fully settled"

    purged = 0
    if overwrite_placeholders:
        # Placeholder = an existing recon with no bank account and no cleared
        # txn ids. These are almost always seed/demo artifacts (see the 429
        # LLC audit) that would otherwise block bootstrap for the whole year.
        placeholder_ids = [
            d["id"] for d in await db.reconciliations.find({
                "company_id": cid,
                "$or": [
                    {"bank_account_id": {"$in": [None, ""]}},
                    {"bank_account_id": {"$exists": False}},
                    {"cleared_txn_ids": {"$in": [None, []]}},
                    {"cleared_txn_ids": {"$exists": False}},
                ],
            }, {"id": 1, "cleared_txn_ids": 1}).to_list(1000)
        ]
        if placeholder_ids:
            r = await db.reconciliations.delete_many({
                "company_id": cid, "id": {"$in": placeholder_ids},
            })
            purged = r.deleted_count
            # Nothing to un-clear on transactions: placeholders by definition
            # had no cleared_txn_ids to attach.

    q = {"company_id": cid}
    if plaid_item_id:
        q["id"] = plaid_item_id
    items = await db.plaid_items.find(q).to_list(20)
    if not items:
        return {"created": [], "skipped": [], "errors": ["No Plaid items linked."], "purged": purged}

    created: list[dict] = []
    skipped: list[dict] = []
    errors: list[str] = []
    rerouted_total = 0

    for item in items:
        item_id = item.get("id")
        acct_snapshots = {a.get("account_id"): a for a in (item.get("accounts") or [])}
        mappings = item.get("account_mappings") or {}

        # ---- Self-heal: sweep any Plaid txns for a mapped account that
        # somehow landed on the wrong ledger row (webhook races during
        # initial connect can drop txns onto the default fallback checking
        # account BEFORE the mapping exists). Only re-routes txns whose
        # `plaid_account_id` is EXPLICITLY listed in this item's mapping,
        # so nothing else in the ledger can be touched.
        for plaid_account_id, mapping in mappings.items():
            ledger_id = mapping.get("ledger_account_id")
            if not ledger_id:
                continue
            fresh_ledger = await db.accounts.find_one({"id": ledger_id, "company_id": cid})
            r = await db.transactions.update_many(
                {
                    "company_id": cid,
                    "plaid_account_id": plaid_account_id,
                    "bank_account_id": {"$ne": ledger_id},
                },
                {"$set": {
                    "bank_account_id": ledger_id,
                    "bank_account_name": (fresh_ledger or {}).get("name") or mapping.get("ledger_account_name"),
                    "updated_at": now,
                }},
            )
            rerouted_total += r.modified_count

        for plaid_account_id, mapping in mappings.items():
            ledger_account_id = mapping.get("ledger_account_id")
            opening_balance = float(mapping.get("opening_balance") or 0.0)
            opening_as_of = mapping.get("opening_as_of")
            snap = acct_snapshots.get(plaid_account_id) or {}
            plaid_current = snap.get("balance_current")
            if plaid_current is None:
                errors.append(f"{mapping.get('ledger_account_name') or plaid_account_id}: no Plaid current balance snapshot yet — sync first.")
                continue
            plaid_current = float(plaid_current)
            if not ledger_account_id or not opening_as_of:
                errors.append(f"{plaid_account_id}: mapping missing ledger_account_id/opening_as_of.")
                continue

            # Pull the account's full Plaid txn stream from the ledger.
            txns = await db.transactions.find({
                "company_id": cid,
                "bank_account_id": ledger_account_id,
                "source": {"$regex": "^plaid"},
                "posted": True,
            }).sort("date", 1).to_list(20000)

            # The invariant that matters:  opening + Σ(txns STRICTLY AFTER
            # opening_as_of) == plaid_current.  Pre-opening txns are already
            # baked into the ledger by way of prior periods and are none of
            # bootstrap's business — the ledger owner is expected to have
            # reconciled them (or intentionally left them alone) already.
            opening_d = _parse_date(opening_as_of)
            if not opening_d:
                errors.append(f"{ledger_account_id}: unparseable opening_as_of '{opening_as_of}'.")
                continue
            post_txns = [
                t for t in txns
                if (_parse_date(t.get("date")) or opening_d) > opening_d
            ]

            # Integrity check #1 — end-to-end invariant.
            plaid_sum = round(sum(float(t.get("amount") or 0) for t in post_txns), 2)
            derived_current = round(opening_balance + plaid_sum, 2)
            if abs(derived_current - plaid_current) > 0.01:
                errors.append(
                    f"{mapping.get('ledger_account_name') or ledger_account_id}: "
                    f"ledger disagrees with Plaid — opening {opening_balance:.2f} + txns {plaid_sum:.2f} "
                    f"= {derived_current:.2f}, Plaid current {plaid_current:.2f}. "
                    f"Nothing reconciled for this account."
                )
                continue

            # Integrity check #2 — refuse if the ledger has non-Plaid txns on
            # this bank account (they'd throw off any bootstrap math).
            has_foreign = await db.transactions.find_one({
                "company_id": cid,
                "bank_account_id": ledger_account_id,
                "source": {"$not": {"$regex": "^plaid"}},
                "posted": True,
            })
            if has_foreign:
                errors.append(
                    f"{mapping.get('ledger_account_name') or ledger_account_id}: "
                    f"non-Plaid transactions found on this bank account — reconcile manually."
                )
                continue

            # Determine window: strictly after opening_as_of, up to cutoff.
            window_start = opening_d + timedelta(days=1)
            window_end = cutoff
            if window_start > window_end:
                continue  # not enough history to reconcile a completed month yet.

            # Load existing recons for this account so we can skip overlaps.
            existing = await db.reconciliations.find({
                "company_id": cid, "bank_account_id": ledger_account_id,
            }).to_list(1000)

            def _overlaps(p_start: str, p_end: str) -> bool:
                for e in existing:
                    es = e.get("period_start") or e.get("as_of")
                    ee = e.get("period_end") or e.get("as_of")
                    if not es or not ee:
                        continue
                    if p_start <= ee and p_end >= es:
                        return True
                return False

            # Bucket post-opening Plaid txns by (year, month) for O(1) period sums.
            from collections import defaultdict
            by_month: dict[tuple[int, int], list[dict]] = defaultdict(list)
            for t in post_txns:
                d = _parse_date(t.get("date"))
                if d:
                    by_month[(d.year, d.month)].append(t)

            # Walk month-by-month.
            running = opening_balance
            # Bring `running` forward through months that fall entirely before window_start.
            def _month_iter(start: dt_date, end: dt_date):
                y, m = start.year, start.month
                while (y, m) <= (end.year, end.month):
                    yield y, m
                    m += 1
                    if m == 13: y, m = y + 1, 1

            for y, m in _month_iter(opening_d, window_end):
                last = monthrange(y, m)[1]
                m_first = dt_date(y, m, 1)
                m_last = dt_date(y, m, last)
                # Clamp to bootstrap window.
                p_start = max(m_first, window_start)
                p_end = min(m_last, window_end)

                # Sum THIS month's txns strictly (opening_d falls inside the
                # month it was created — its own txns before opening are not
                # ours to reconcile).
                m_txns = [
                    t for t in by_month.get((y, m), [])
                    if _parse_date(t.get("date")) and _parse_date(t.get("date")) >= p_start
                    and _parse_date(t.get("date")) <= p_end
                ]

                # Advance `running` with any txns that fall in this calendar
                # month but BEFORE our clamped window (won't happen with the
                # +1-day rule but keep for safety).
                pre_window_in_month = [
                    t for t in by_month.get((y, m), [])
                    if _parse_date(t.get("date")) and _parse_date(t.get("date")) < p_start
                ]
                running = round(running + sum(float(t.get("amount") or 0) for t in pre_window_in_month), 2)

                if p_start > p_end:
                    continue  # window doesn't touch this month.
                # Skip months with zero activity — a "reconciliation" of
                # nothing isn't useful noise in the history table.
                if not m_txns:
                    continue

                p_start_iso = p_start.isoformat()
                p_end_iso = p_end.isoformat()
                if _overlaps(p_start_iso, p_end_iso):
                    skipped.append({
                        "account_id": ledger_account_id,
                        "period": f"{p_start_iso}→{p_end_iso}",
                        "reason": "already reconciled",
                    })
                    # Still advance running so subsequent months are correct.
                    running = round(running + sum(float(t.get("amount") or 0) for t in m_txns), 2)
                    continue

                cleared_sum = round(sum(float(t.get("amount") or 0) for t in m_txns), 2)
                period_open = running
                period_close = round(period_open + cleared_sum, 2)
                rec_id = str(uuid.uuid4())
                txn_ids = [t["id"] for t in m_txns]
                doc = {
                    "id": rec_id,
                    "company_id": cid,
                    "bank_account_id": ledger_account_id,
                    "as_of": p_end_iso,
                    "period_start": p_start_iso,
                    "period_end": p_end_iso,
                    "opening_balance": period_open,
                    "closing_balance": period_close,
                    "statement_balance": period_close,
                    "cleared_sum": cleared_sum,
                    "difference": 0.0,
                    "cleared_txn_ids": txn_ids,
                    "matched_count": len(txn_ids),
                    "source": "plaid_bootstrap",
                    "status": "reconciled",
                    "auto_generated": True,
                    "plaid_item_id": item_id,
                    "completed_at": now,
                    "completed_by": "auto:plaid_bootstrap",
                    "created_at": now,
                    "updated_at": now,
                }
                await db.reconciliations.insert_one(doc)
                if txn_ids:
                    await db.transactions.update_many(
                        {"company_id": cid, "id": {"$in": txn_ids}},
                        {"$set": {
                            "cleared_at": p_end_iso,
                            "cleared_source": "plaid_bootstrap",
                            "cleared_reconciliation_id": rec_id,
                            "updated_at": now,
                        }},
                    )
                created.append({
                    "id": rec_id,
                    "account_id": ledger_account_id,
                    "period": f"{p_start_iso}→{p_end_iso}",
                    "cleared_count": len(txn_ids),
                    "cleared_sum": cleared_sum,
                    "opening_balance": period_open,
                    "closing_balance": period_close,
                })
                running = period_close

    return {
        "created": created,
        "skipped": skipped,
        "errors": errors,
        "purged": purged,
        "rerouted": rerouted_total,
    }


# ---------------------------------------------------------------------------
# Utility — is a bank account fully reconciled for a given month?
# Used by month_close.py to auto-satisfy the `recon` checkpoint.
# ---------------------------------------------------------------------------

async def month_recon_state(cid: str, start: str, end: str) -> dict:
    """Return `{green, total, cleared, sources}` — used by Month Close to
    decide whether to auto-flip the `recon` checkpoint."""
    base = {
        "company_id": cid,
        "posted": True,
        "date": {"$gte": start, "$lte": end},
    }
    # Only look at real bank/CC posts. Bank_account_id present means it hit
    # a cash-like account (as opposed to internal journal entries).
    base["bank_account_id"] = {"$exists": True, "$ne": None}
    total = await db.transactions.count_documents(base)
    if total == 0:
        # Vacuous green — no bank activity to reconcile.
        return {"green": True, "auto": True, "total": 0, "cleared": 0, "sources": {}}
    cleared = await db.transactions.count_documents({
        **base, "cleared_at": {"$nin": [None, "", False], "$exists": True},
    })
    # Source breakdown for UI hint ("100% Plaid-auto" etc.)
    src_pipe = [
        {"$match": {**base, "cleared_at": {"$nin": [None, "", False]}}},
        {"$group": {"_id": "$cleared_source", "count": {"$sum": 1}}},
    ]
    src_docs = await db.transactions.aggregate(src_pipe).to_list(10)
    sources = {d["_id"] or "unknown": d["count"] for d in src_docs}
    return {
        "green": cleared == total,
        "auto": cleared == total,
        "total": total, "cleared": cleared,
        "sources": sources,
    }
