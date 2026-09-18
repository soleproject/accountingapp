"""Review v2 backend — endpoints that power `/accounting/lab/review-v2`.

Two POST/GET routes:

  • GET  /companies/{cid}/reviewv2/account-pairs
        Pulls confirmed transfer pairs directly from the ledger so
        stage 1 doesn't depend on the batch surfacing type-5
        (Ambiguous Transfer) items. A transfer pair is any set of
        matched transactions where txn_type == "Transfer" and both
        `bank_account_id` and `transfer_pair_id` (or similar) tie
        two accounts together. Groups by (from_account, to_account),
        returns dollar totals + samples.

  • POST /companies/{cid}/reviewv2/ai-propose
        Given transaction context + a free-text user answer,
        proposes a booking using the company's entity/tax setup.
        For pass-through entities (Sole Prop, LLC-Partnership,
        LLC-Solo-Proprietor) the mapping enforces "business income
        tax on owner → Owner Draw + flag for accountant"; for
        C-Corp / S-Corp it stays "Income Tax Expense". Also detects
        when the typed answer conflicts with the bank description
        (e.g. "office rent" typed on a transaction descriptioned
        "AMAZON MKTPL").
"""
from __future__ import annotations
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, Body, UploadFile, File
from collections import defaultdict

from db import db
from auth import get_current_user
from deps import require_company
from ai_service import _new_chat
from llm_client import UserMessage, TextDelta, StreamDone
import json, re, os, io
import logging as _log
_logger = _log.getLogger("axiom.reviewv2")

router = APIRouter(prefix="/api")


# ---------------------------------------------------------------- stage 1

@router.get("/companies/{cid}/reviewv2/account-pairs")
async def list_transfer_pairs(cid: str, user: dict = Depends(get_current_user)):
    """Group confirmed transfer transactions by (from_account, to_account).

    Only surfaces pairs with ≥1 matched transfer so the client is asked
    "are these both yours?" once per pair. The response drives Stage 1
    of the v2 review flow.
    """
    await require_company(user, cid)

    # Load account name lookup once.
    accts = {a["id"]: a async for a in db.accounts.find({"company_id": cid},
             {"id": 1, "name": 1, "code": 1, "type": 1, "bank_last4": 1})}

    # Group by transfer_pair_id (canonical field emitted by the transfer
    # matcher). Each pair produces two ledger rows — one debit, one
    # credit — that carry the same pair id.
    pair_map: dict[str, dict] = {}
    async for t in db.transactions.find({
        "company_id": cid,
        "txn_type": "Transfer",
        "transfer_pair_id": {"$exists": True, "$nin": [None, ""]},
    }, {
        "id": 1, "date": 1, "amount": 1, "transfer_pair_id": 1,
        "bank_account_id": 1, "category_account_id": 1,
    }):
        pid = t["transfer_pair_id"]
        p = pair_map.setdefault(pid, {"legs": []})
        p["legs"].append(t)

    # Roll pair rows up to (from, to) account groupings.
    groups: dict[tuple, dict] = {}
    for pid, p in pair_map.items():
        legs = p["legs"]
        if len(legs) < 2:
            continue
        # Debit side = destination (money in), credit side = source.
        src = next((l for l in legs if (l.get("amount") or 0) < 0), legs[0])
        dst = next((l for l in legs if (l.get("amount") or 0) > 0), legs[-1])
        src_id = src.get("bank_account_id") or src.get("category_account_id")
        dst_id = dst.get("bank_account_id") or dst.get("category_account_id")
        if not src_id or not dst_id:
            continue
        key = (src_id, dst_id)
        g = groups.setdefault(key, {
            "src_id": src_id, "dst_id": dst_id,
            "count": 0, "total_dollars": 0.0,
            "samples": [],
        })
        g["count"] += 1
        amt = abs(float(src.get("amount") or 0))
        g["total_dollars"] += amt
        if len(g["samples"]) < 3:
            g["samples"].append({"date": src.get("date"), "amount": amt})

    def _label(a: dict | None) -> str:
        if not a:
            return "—"
        last4 = a.get("bank_last4") or ""
        base = a.get("name") or a.get("code") or "account"
        return f"{base} ···{last4}" if last4 else base

    pairs = []
    for (src_id, dst_id), g in groups.items():
        src_acct = accts.get(src_id)
        dst_acct = accts.get(dst_id)
        pairs.append({
            "pair_id":       f"{src_id}::{dst_id}",
            "from":          _label(src_acct),
            "to":            _label(dst_acct),
            "from_id":       src_id,
            "to_id":         dst_id,
            "transfer_count": g["count"],
            "total_dollars": round(g["total_dollars"], 2),
            "samples":       g["samples"],
        })
    pairs.sort(key=lambda p: p["total_dollars"], reverse=True)
    return {"pairs": pairs}


# ---------------------------------------------------------------- ai propose

PASS_THROUGH_ENTITIES = {
    "Sole Proprietor",
    "LLC – Solo Proprietor",
    "LLC – Partnership",
    "Limited Partnership",
    'LLC – "S" Elected',
    '"S" Corporation',
}


def _entity_hint(business_type: str | None) -> str:
    """Compose an entity-aware bookkeeping rules block for the LLM."""
    bt = (business_type or "").strip()
    if bt in PASS_THROUGH_ENTITIES:
        return (
            f"The business is a PASS-THROUGH entity ({bt or 'unknown pass-through'}).\n"
            "  • Business income tax paid on the owner's personal Form 1040 (or K-1) "
            "is NOT a business expense — book to 3200 Owner's Draw and FLAG for CPA.\n"
            "  • Owner health insurance premiums paid personally → Owner's Draw.\n"
            "  • Owner salary via Zelle/Venmo → Owner's Draw (never Payroll).\n"
            "  • Personal charges on business cards → Owner's Draw.\n"
            "  • Loans between owner and business → separate `Due to/from Owner` account."
        )
    return (
        f"The business is a TAXABLE ENTITY ({bt or 'C-Corp assumed'}).\n"
        "  • Federal / state corporate income tax → 6900 Income Tax Expense.\n"
        "  • Owner salary → Payroll (not Draw). Confirm W-2 is being issued.\n"
        "  • Dividends / distributions to shareholders → Retained Earnings, flag CPA."
    )


_PROPOSE_SYSTEM = (
    "You are the SmartBooks bookkeeping assistant helping a business owner "
    "categorize a single transaction. You must:\n"
    "1. Read the transaction's bank description and the owner's plain-language answer.\n"
    "2. Propose a single ledger account (name + code from the provided CoA).\n"
    "3. Apply the company's entity/tax rules (below) before choosing the account.\n"
    "4. Compare the owner's answer to the bank description. If they conflict "
    "(e.g. owner says 'office rent' but description says 'AMAZON MKTPL'), "
    "flag `conflict=true` and explain briefly.\n"
    "5. If the transaction requires accountant judgment (loans, tax payments on a "
    "pass-through, owner reimbursements, ambiguous splits), set `flag_for_cpa=true`.\n"
    "6. NEVER book anything yourself. Your output is a proposal only.\n\n"
    "Reply ONLY with strict JSON, no prose:\n"
    "{\n"
    '  "account_code":    "6100",\n'
    '  "account_name":    "Travel",\n'
    '  "reason":          "Owner said this was a client trip; bank shows an airline.",\n'
    '  "confidence":      0.86,\n'
    '  "conflict":        false,\n'
    '  "flag_for_cpa":    false,\n'
    '  "direction_note":  "money_out"\n'
    "}"
)


@router.post("/companies/{cid}/reviewv2/ai-propose")
async def ai_propose(
    cid: str,
    payload: dict = Body(...),
    user: dict = Depends(get_current_user),
):
    """Given `{context, user_answer}` return an AI proposal (JSON).

    Never touches the ledger — the client always shows Confirm / Change
    before booking. The Confirm write goes through the existing
    /client-review answer handlers so ledger writes flow through the
    normalizer + audit trail.
    """
    await require_company(user, cid)
    ctx = payload.get("context") or {}
    user_answer = (payload.get("user_answer") or "").strip()
    if not user_answer:
        raise HTTPException(400, "user_answer is required")

    company = await db.companies.find_one({"id": cid}) or {}
    business_type = company.get("business_type") or ""

    # Load the company's Chart of Accounts (top 120 rows — same cap as
    # ai_service.categorize_transaction).
    coa = []
    async for a in db.accounts.find({"company_id": cid, "active": True},
            {"code": 1, "name": 1, "type": 1}).limit(120):
        coa.append(a)

    coa_lines = "\n".join(
        f"- {a.get('code','')} {a.get('name','')} ({a.get('type','')})"
        for a in coa if a.get("code") and a.get("name")
    )

    amount = float(ctx.get("amount") or 0)
    direction = "money_in" if amount > 0 else "money_out"

    prompt = (
        f"Entity rules:\n{_entity_hint(business_type)}\n\n"
        f"Chart of accounts:\n{coa_lines}\n\n"
        f"Transaction:\n"
        f"  Date:        {ctx.get('date') or '—'}\n"
        f"  Description: {ctx.get('description') or ctx.get('merchant') or '—'}\n"
        f"  Merchant:    {ctx.get('merchant') or '—'}\n"
        f"  Amount:      {amount} ({direction})\n"
        f"  Account:     {ctx.get('account') or '—'}\n\n"
        f"Owner's plain-language answer:\n  \"{user_answer}\"\n\n"
        "Return the JSON now."
    )

    chat = _new_chat(_PROPOSE_SYSTEM, f"rv2-{cid}", feature="reviewv2-propose", company_id=cid)
    text = ""
    try:
        async for ev in chat.stream_message(UserMessage(text=prompt)):
            if isinstance(ev, TextDelta):
                text += ev.content
            elif isinstance(ev, StreamDone):
                break
    except Exception as e:
        raise HTTPException(500, f"AI proposal failed: {e}")

    m = re.search(r"\{[\s\S]*\}", text)
    if not m:
        return {
            "ok": False,
            "raw": text,
            "reason": "The AI didn't return a parseable JSON proposal — try again or use 'Ask my accountant'.",
        }
    try:
        parsed = json.loads(m.group(0))
    except Exception:
        return {"ok": False, "raw": text, "reason": "AI response was not valid JSON."}

    parsed.setdefault("direction_note", direction)
    parsed["ok"] = True
    parsed["business_type"] = business_type
    return parsed


# =========================================================================
# Verification-based audit — replaces confidence-based auto-handling on the
# Review v2 Lab. A row skips review only when it is verifiably safe:
#   (a) inter-account transfer with BOTH sides matched between accounts
#       connected to this company, OR
#   (b) recognized merchant/vendor whose assigned category fits the
#       merchant type (per-direction rules confirmed by this client).
# Always-review escape hatches (regardless of recognition):
#   • Multi-purpose retailers (Amazon, Costco, Walmart, Target, Apple,
#     Sam's Club — configurable list stored in `reviewv2_config`).
#   • Payment apps (PayPal, Venmo, Cash App, Square, Stripe).
#   • Taxes, loans, owner equity, payroll categories.
#   • Amounts >3× that vendor's rolling 90-day average.
#   • Transfers where one leg isn't a connected account.
# =========================================================================

from datetime import datetime, timezone, timedelta
import random
import statistics


# ------- Default config (persisted per-company on first POST) ------------
DEFAULT_MULTI_PURPOSE_MERCHANTS = [
    "AMAZON", "AMZN", "COSTCO", "WALMART", "WAL-MART", "TARGET",
    "APPLE", "SAM'S CLUB", "SAMS CLUB", "BJ'S WHOLESALE", "MEIJER",
]
PAYMENT_APP_MERCHANTS = [
    "PAYPAL", "VENMO", "CASH APP", "CASHAPP", "SQUARE", "SQ ",
    "STRIPE", "ZELLE",
]
# Category name fragments (lowercased) that force review regardless of rule.
ALWAYS_REVIEW_CATEGORY_HINTS = [
    "tax", "irs", "payroll", "owner draw", "owner's draw",
    "owner contribution", "opening balance", "retained earnings",
    "loan payable", "note payable", "line of credit",
]


async def _load_connected_account_ids(cid: str) -> set[str]:
    """A "connected" account is any CoA account that is the ledger
    target of a bank/card feed. We resolve this three ways so no
    connection path is missed:

      1. `plaid_items.account_mappings[aid].ledger_account_id` — every
         Plaid account mapped to a CoA entry by the connect flow.
      2. `transactions.bank_account_id` where the txn carries a
         `plaid_account_id` (or a statement-import `source_kind`).
         Catches accounts synced BEFORE the mapping doc was saved.
      3. `accounts` with `plaid_account_id` / `bank_last4` populated
         directly on the doc (older seed path).
    """
    ids: set[str] = set()
    async for item in db.plaid_items.find({"company_id": cid}):
        for _plaid_aid, m in (item.get("account_mappings") or {}).items():
            lid = (m or {}).get("ledger_account_id")
            if lid:
                ids.add(lid)
    # Anything a Plaid or statement-fed txn ever touched.
    cur = db.transactions.aggregate([
        {"$match": {"company_id": cid,
                     "$or": [
                        {"plaid_account_id": {"$exists": True, "$nin": [None, ""]}},
                        {"source_kind": {"$in": ["plaid", "statement_pdf",
                                                    "statement_upload", "veryfi"]}},
                     ]}},
        {"$group": {"_id": "$bank_account_id"}},
    ])
    async for row in cur:
        if row.get("_id"):
            ids.add(row["_id"])
    return ids


def _is_connected_asset(a: dict | None) -> bool:
    """Fast path — asset accounts stamped with `plaid_account_id` or
    `bank_last4` directly on the doc. Kept as a fallback for the
    older seed path; the primary resolver is
    `_load_connected_account_ids`."""
    if not a:
        return False
    if a.get("plaid_account_id"):
        return True
    if a.get("bank_last4"):
        return True
    return False


def _uc(s: str | None) -> str:
    return (s or "").upper()


def _canonical_merchant(desc: str, merchant: str) -> str:
    """Loose canonical merchant key for rule/rolling-average lookups.
    Prefers the enriched `merchant` field; falls back to a truncated
    description with bank-feed noise stripped."""
    if merchant:
        return merchant.strip().upper()[:40]
    d = _uc(desc)
    for token in (" DES:", " ID:", " INDN:", " WEB", " PPD", " ACH", " REF:"):
        i = d.find(token)
        if i > 0:
            d = d[:i]
    return d.strip()[:40]


def _matches_any(hay: str, needles: list[str]) -> bool:
    return any(n in hay for n in needles)


async def _load_reviewv2_config(cid: str) -> dict:
    doc = await db.reviewv2_config.find_one({"company_id": cid}) or {}
    return {
        "multi_purpose_merchants":
            doc.get("multi_purpose_merchants") or list(DEFAULT_MULTI_PURPOSE_MERCHANTS),
        "outlier_multiple": doc.get("outlier_multiple", 3.0),
        "window_days":      doc.get("window_days", 90),
    }


async def _load_merchant_rules(cid: str) -> dict:
    """Per-direction confirmed rules — `{(merchant, direction): category_id}`.
    Populated by POST /reviewv2/rules/confirm after each client
    confirmation on Stage 2."""
    rules = {}
    async for r in db.reviewv2_merchant_rules.find({"company_id": cid}):
        m = _uc(r.get("merchant"))
        d = r.get("direction") or "out"
        if m and r.get("category_account_id"):
            rules[(m, d)] = {
                "category_account_id": r["category_account_id"],
                "category_type":       r.get("category_type"),
                "category_name":       r.get("category_name"),
            }
    return rules


def _classify(
    t: dict,
    connected_ids: set[str],
    rules: dict,
    config: dict,
    accts_by_id: dict,
    merchant_norms: dict[str, float],
) -> tuple[str, str]:
    """Return (bucket, reason). Buckets:
        AUTO_TRANSFER          — both legs connected
        AUTO_RECOGNIZED        — per-direction rule matches
        REVIEW_STAGE1          — transfer, one leg unconnected
        REVIEW_ALWAYS_REVIEW   — multi-purpose / payment-app / tax etc.
        REVIEW_STAGE2          — unrecognized contact-linked pattern
        REVIEW_STAGE3          — no-contact / singleton / outlier
    """
    txn_type   = (t.get("txn_type") or "").strip()
    merch_raw  = _uc(t.get("merchant"))
    desc_raw   = _uc(t.get("description"))
    hay        = f"{merch_raw} {desc_raw}"
    amount     = float(t.get("amount") or 0)
    cat_id     = t.get("category_account_id")
    cat        = accts_by_id.get(cat_id) if cat_id else None
    cat_type   = (cat or {}).get("type", "")
    cat_name   = _uc((cat or {}).get("name", ""))

    # ---- Transfers (deferred to pair analysis by caller) --------------
    # A row is a transfer whenever we see a `transfer_pair_id` — Plaid
    # imports and manual transfer pairs both stamp it. `txn_type` is
    # unreliable (None on most Plaid-imported rows).
    pair_id = t.get("transfer_pair_id")
    if pair_id or txn_type == "Transfer":
        return ("_TRANSFER_LEG", pair_id or "")

    # ---- Payment apps: ALWAYS review -----------------------------------
    if _matches_any(hay, PAYMENT_APP_MERCHANTS):
        return ("REVIEW_ALWAYS_REVIEW", "payment_app")

    # ---- Multi-purpose retailers: ALWAYS review ------------------------
    if _matches_any(hay, [m.upper() for m in config["multi_purpose_merchants"]]):
        return ("REVIEW_ALWAYS_REVIEW", "multi_purpose")

    # ---- Taxes / loans / owner equity / payroll: ALWAYS review ---------
    lower_cat = cat_name.lower()
    if any(h in lower_cat for h in ALWAYS_REVIEW_CATEGORY_HINTS):
        return ("REVIEW_ALWAYS_REVIEW", "sensitive_category")
    if cat_type in ("liability", "equity"):
        return ("REVIEW_ALWAYS_REVIEW", "balance_sheet_category")

    # ---- Amount far above vendor norm ---------------------------------
    key = _canonical_merchant(desc_raw, merch_raw)
    norm = merchant_norms.get(key)
    if norm and abs(amount) > norm * config["outlier_multiple"] and abs(amount) > 100:
        return ("REVIEW_ALWAYS_REVIEW", "outlier_vs_norm")

    # ---- Recognized vendor with per-direction rule --------------------
    direction = "in" if amount > 0 else "out"
    rule = rules.get((key, direction))
    if rule and cat_id and rule["category_account_id"] == cat_id:
        return ("AUTO_RECOGNIZED", direction)
    if rule and not cat_id:
        return ("AUTO_RECOGNIZED_APPLYING", direction)  # rule can fill

    # ---- Unrecognized: route to Stage 2 (contact-linked) or 3 ---------
    if t.get("contact_id"):
        return ("REVIEW_STAGE2", "unrecognized_contact")
    return ("REVIEW_STAGE3", "singleton_no_contact")


@router.get("/companies/{cid}/reviewv2/audit-preview")
async def audit_preview(cid: str, user: dict = Depends(get_current_user)):
    """Verification-based classifier for the Review v2 Lab.

    Reads the ledger window, classifies every transaction, and returns:
      • auto_handled counts + dollars + breakdown + random spot-check sample
      • always_review rows
      • rows destined for stages 1/2/3 (as raw txns — the frontend
        transform handles grouping)
    """
    await require_company(user, cid)
    config = await _load_reviewv2_config(cid)
    rules  = await _load_merchant_rules(cid)

    accts_by_id = {a["id"]: a async for a in db.accounts.find({"company_id": cid})}
    # Primary: mappings + Plaid-touched txns. Fallback: fields on the
    # account doc itself. Union covers every connection path.
    connected_ids = await _load_connected_account_ids(cid)
    for aid, a in accts_by_id.items():
        if _is_connected_asset(a):
            connected_ids.add(aid)

    since = (datetime.now(timezone.utc) - timedelta(days=config["window_days"])).isoformat()
    txns = [t async for t in db.transactions.find({
        "company_id": cid,
        "date":       {"$gte": since},
    }).limit(2000)]

    # Rolling per-merchant averages for outlier detection.
    per_merchant_amounts: dict[str, list[float]] = {}
    for t in txns:
        k = _canonical_merchant(t.get("description", ""), t.get("merchant", ""))
        if k:
            per_merchant_amounts.setdefault(k, []).append(abs(float(t.get("amount") or 0)))
    merchant_norms = {
        k: statistics.median(v) for k, v in per_merchant_amounts.items() if len(v) >= 3
    }

    buckets: dict[str, list[dict]] = {}
    transfer_legs: dict[str, list[dict]] = {}
    for t in txns:
        bucket, reason = _classify(t, connected_ids, rules, config, accts_by_id, merchant_norms)
        if bucket == "_TRANSFER_LEG":
            if reason:
                transfer_legs.setdefault(reason, []).append(t)
            else:
                buckets.setdefault("REVIEW_STAGE1", []).append({**t, "_reason": "no_pair_id"})
            continue
        row = {
            "id":            t.get("id"),
            "date":          t.get("date"),
            "amount":        t.get("amount"),
            "merchant":      t.get("merchant"),
            "description":   t.get("description"),
            "contact_id":    t.get("contact_id"),
            "category":      accts_by_id.get(t.get("category_account_id"), {}).get("name"),
            "_reason":       reason,
        }
        buckets.setdefault(bucket, []).append(row)

    # Analyze transfer pairs — both legs connected → AUTO, else Stage 1.
    for pair_id, legs in transfer_legs.items():
        if len(legs) < 2:
            for l in legs:
                buckets.setdefault("REVIEW_STAGE1", []).append({
                    **{k: l.get(k) for k in ("id","date","amount","merchant","description","contact_id")},
                    "_reason": "orphan_leg",
                })
            continue
        both_connected = all(l.get("bank_account_id") in connected_ids for l in legs)
        target = "AUTO_TRANSFER" if both_connected else "REVIEW_STAGE1"
        for l in legs:
            buckets.setdefault(target, []).append({
                "id":         l.get("id"),
                "date":       l.get("date"),
                "amount":     l.get("amount"),
                "merchant":   l.get("merchant"),
                "description": l.get("description"),
                "pair_id":    pair_id,
                "_reason":    "both_connected" if both_connected else "one_unconnected",
            })

    def _sum_abs(rows: list[dict]) -> float:
        return round(sum(abs(float(r.get("amount") or 0)) for r in rows), 2)

    auto_rows = [
        *buckets.get("AUTO_TRANSFER", []),
        *buckets.get("AUTO_RECOGNIZED", []),
        *buckets.get("AUTO_RECOGNIZED_APPLYING", []),
    ]
    # Random spot-check sample (up to 8 rows). Deterministic-ish for
    # a given call so the CPA can walk through it.
    sample = random.sample(auto_rows, min(len(auto_rows), 8)) if auto_rows else []

    breakdown = {
        "auto_transfer_pairs":    _sum_abs(buckets.get("AUTO_TRANSFER", [])),
        "auto_recognized_vendor": _sum_abs(buckets.get("AUTO_RECOGNIZED", [])),
        "always_review":          _sum_abs(buckets.get("REVIEW_ALWAYS_REVIEW", [])),
        "stage1":                 _sum_abs(buckets.get("REVIEW_STAGE1", [])),
        "stage2":                 _sum_abs(buckets.get("REVIEW_STAGE2", [])),
        "stage3":                 _sum_abs(buckets.get("REVIEW_STAGE3", [])),
    }

    return {
        "window_days": config["window_days"],
        "scanned":     len(txns),
        "connected_account_count": len(connected_ids),
        "auto_handled": {
            "count":        len(auto_rows),
            "dollars":      _sum_abs(auto_rows),
            "by_reason": {
                "transfer_both_connected": len(buckets.get("AUTO_TRANSFER", [])),
                "recognized_vendor":       len(buckets.get("AUTO_RECOGNIZED", []))
                                            + len(buckets.get("AUTO_RECOGNIZED_APPLYING", [])),
            },
            "spot_check_sample": sample,
        },
        "always_review":  buckets.get("REVIEW_ALWAYS_REVIEW", []),
        "stage1_rows":    buckets.get("REVIEW_STAGE1", []),
        "stage2_rows":    buckets.get("REVIEW_STAGE2", []),
        "stage3_rows":    buckets.get("REVIEW_STAGE3", []),
        "totals_by_reason": breakdown,
        "config":         config,
        "rules_count":    len(rules),
    }


@router.get("/companies/{cid}/reviewv2/config")
async def get_reviewv2_config(cid: str, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    return await _load_reviewv2_config(cid)


@router.post("/companies/{cid}/reviewv2/config")
async def set_reviewv2_config(
    cid: str,
    payload: dict = Body(...),
    user: dict = Depends(get_current_user),
):
    """Update the per-company config — multi-purpose merchant list,
    outlier multiple, window days. Merges with existing so partial
    payloads don't clobber unset fields."""
    await require_company(user, cid)
    existing = await db.reviewv2_config.find_one({"company_id": cid}) or {}
    updates = {"company_id": cid, "updated_at": datetime.now(timezone.utc).isoformat()}
    if "multi_purpose_merchants" in payload:
        updates["multi_purpose_merchants"] = [
            str(m).strip().upper() for m in (payload.get("multi_purpose_merchants") or [])
            if str(m).strip()
        ]
    if "outlier_multiple" in payload:
        updates["outlier_multiple"] = float(payload["outlier_multiple"])
    if "window_days" in payload:
        updates["window_days"] = int(payload["window_days"])
    merged = {**existing, **updates}
    await db.reviewv2_config.update_one(
        {"company_id": cid}, {"$set": merged}, upsert=True,
    )
    return await _load_reviewv2_config(cid)


@router.post("/companies/{cid}/reviewv2/rules/confirm")
async def save_direction_rule(
    cid: str,
    payload: dict = Body(...),
    user: dict = Depends(get_current_user),
):
    """Save a per-direction rule after a client confirms a contact on
    Stage 2. `direction` is "in" or "out". Idempotent — upserts.
    """
    await require_company(user, cid)
    merchant  = _uc(payload.get("merchant"))
    direction = (payload.get("direction") or "out").lower()
    cat_id    = payload.get("category_account_id")
    if not merchant or direction not in ("in", "out") or not cat_id:
        raise HTTPException(400, "merchant, direction, category_account_id required")
    cat = await db.accounts.find_one({"id": cat_id, "company_id": cid})
    if not cat:
        raise HTTPException(404, "category account not found")
    doc = {
        "company_id":           cid,
        "merchant":             merchant,
        "direction":            direction,
        "category_account_id":  cat_id,
        "category_name":        cat.get("name"),
        "category_type":        cat.get("type"),
        "updated_at":           datetime.now(timezone.utc).isoformat(),
    }
    await db.reviewv2_merchant_rules.update_one(
        {"company_id": cid, "merchant": merchant, "direction": direction},
        {"$set": doc}, upsert=True,
    )
    return {"ok": True, "rule": doc}


# =========================================================================
# Step 2 — Brand-registry + LLM classifier audit preview (Feb 2026 lab).
# Gated by companies.features.brand_registry_v2 (default OFF). Read-only
# preview — shows what the new pipeline WOULD book. Never writes to
# transactions, never touches live contact_resolver behavior.
# =========================================================================

from advanced_features import is_enabled as _is_feature_enabled
from brand_registry import (
    counts_by_status as _reg_counts,
    _norm as _brand_norm,
)
from reviewv2_step2 import Step2Classifier, get_settings as _get_step2_settings
import random as _rand


@router.get("/companies/{cid}/reviewv2/audit-preview-v2")
async def audit_preview_v2(
    cid: str,
    include: str = "approved",         # "approved" | "approved+candidates"
    sample_size: int = 20,
    fail_sample_size: int = 10,
    scope: str = "window",             # "window" | "all"
    user: dict = Depends(get_current_user),
):
    """Step 2 audit preview.

    Query params:
      include=approved            — use only approved brand entries
      include=approved+candidates — also treat candidate entries as matches

    Response shape (report-ready):
      {
        "gated": bool,               # False → feature flag OFF
        "window_days": int,
        "scanned": int,
        "buckets_by_include": {
            "approved": {counts + $, stage split},
            "approved+candidates": {…} (only when include == "both"),
        },
        "sample_verified": [...],    # up to sample_size random auto-handled
        "sample_fits_false": [...],  # up to fail_sample_size random category-fit=false
        "top_review_reasons": [{"reason": ..., "count": n, "amount": $}, ...],
        "new_candidates": [...],
        "paypal_ids": [{"id": ..., "count": n, "matched_to": ...}, ...],
        "other_bank_paypal_rows": [...],
        "merge_suggestions": [...],   # (skeleton for now — full pass below)
        "shadow_diffs": {counts + samples},
        "llm_usage": {calls_made, cache_hits, approx_cost_usd, model_version},
        "registry_counts": {status: n},
      }
    """
    await require_company(user, cid)
    if not await _is_feature_enabled(cid, "brand_registry_v2"):
        return {
            "gated": True,
            "reason": "features.brand_registry_v2 is OFF for this company",
        }

    settings = await _get_step2_settings(cid)
    config = await _load_reviewv2_config(cid)

    accts_by_id = {a["id"]: a async for a in db.accounts.find({"company_id": cid})}
    connected_ids = await _load_connected_account_ids(cid)
    for aid, a in accts_by_id.items():
        if _is_connected_asset(a):
            connected_ids.add(aid)

    since = (datetime.now(timezone.utc) - timedelta(days=config["window_days"])).isoformat()
    txn_query = {"company_id": cid}
    if scope != "all":
        txn_query["date"] = {"$gte": since}
    txns = [t async for t in db.transactions.find(txn_query).limit(5000)]

    # Date range actually scanned
    scanned_dates = [t.get("date") for t in txns if t.get("date")]
    date_min = min(scanned_dates) if scanned_dates else None
    date_max = max(scanned_dates) if scanned_dates else None

    # Merchant median lookup (canonical-name based — computed once).
    medians: dict[str, list[float]] = {}
    for t in txns:
        canon = _canonical_from_txn_for_median(t)
        if not canon:
            continue
        medians.setdefault(_brand_norm(canon), []).append(abs(float(t.get("amount") or 0)))
    merchant_medians = {
        k: statistics.median(v) for k, v in medians.items() if len(v) >= 3
    }

    # Transfer pair map (shared across classifications)
    transfer_pair_map: dict[str, list[dict]] = {}
    for t in txns:
        pid = t.get("transfer_pair_id")
        if pid:
            transfer_pair_map.setdefault(pid, []).append(t)

    # Load a small approved-registry sample for the LLM prompt.
    approved_sample = [
        r["canonical_name"] async for r in db.brand_registry
        .find({"status": "approved"}, {"canonical_name": 1}).limit(120)
    ]

    async def _run_pass(include_candidates: bool) -> tuple[list[dict], Step2Classifier]:
        classifier = Step2Classifier(
            company_id=cid,
            connected_ids=connected_ids,
            accts_by_id=accts_by_id,
            settings=settings,
            include_candidates=include_candidates,
            approved_sample=approved_sample,
            merchant_medians=merchant_medians,
        )
        rows: list[dict] = []
        for t in txns:
            outcome = await classifier.classify(t, transfer_pair_map=transfer_pair_map)
            rows.append(outcome)
        return rows, classifier

    passes: dict[str, list[dict]] = {}
    stats_by_pass: dict[str, Step2Classifier] = {}
    if include == "approved+candidates":
        for label, incl in (("approved", False), ("approved+candidates", True)):
            rows, cls = await _run_pass(incl)
            passes[label] = rows
            stats_by_pass[label] = cls
        primary = "approved+candidates"
    else:
        rows, cls = await _run_pass(False)
        passes["approved"] = rows
        stats_by_pass["approved"] = cls
        primary = "approved"

    def _bucket(rows: list[dict]) -> dict:
        b: dict[str, list[dict]] = {"auto": [], "always_review": [],
                                     "stage1": [], "stage2": [], "stage3": []}
        for r in rows:
            b.setdefault(r["stage"], []).append(r)
        def _sum(rs: list[dict]) -> float:
            return round(sum(abs(float(r.get("amount") or 0)) for r in rs), 2)
        return {
            "counts":  {k: len(v) for k, v in b.items()},
            "dollars": {k: _sum(v) for k, v in b.items()},
        }

    buckets_by_include = {label: _bucket(rows) for label, rows in passes.items()}

    # Samples pulled from the primary (usually approved+candidates) pass.
    primary_rows = passes[primary]
    auto_rows = [r for r in primary_rows if r["stage"] == "auto"]
    sample_verified = _rand.sample(auto_rows, min(len(auto_rows), sample_size)) if auto_rows else []
    fits_false = [
        r for r in primary_rows
        if (r.get("extras", {}).get("category_fits") or {}).get("fits") is False
        and (r.get("extras", {}).get("category_fits") or {}).get("reason") != "llm_unsure"
    ]
    sample_fits_false = _rand.sample(fits_false, min(len(fits_false), fail_sample_size)) if fits_false else []

    # Top review reasons rollup
    reason_counts: dict[str, dict] = {}
    for r in primary_rows:
        rr = r.get("review_reason")
        if not rr:
            continue
        slot = reason_counts.setdefault(rr, {"count": 0, "amount": 0.0})
        slot["count"] += 1
        slot["amount"] += abs(float(r.get("amount") or 0))
    top_review_reasons = sorted(
        [{"reason": k, "count": v["count"], "amount": round(v["amount"], 2)}
         for k, v in reason_counts.items()],
        key=lambda x: x["count"], reverse=True,
    )[:10]

    # PayPal ID diagnostics (from the primary pass)
    primary_cls = stats_by_pass[primary]
    paypal_ids = [
        {"id": k, "count": v,
         "matched_to": primary_cls.paypal_id_matched_to.get(k, "(unmatched)")}
        for k, v in sorted(primary_cls.paypal_id_seen.items(),
                            key=lambda kv: kv[1], reverse=True)
    ]

    # Shadow-mode diffs (populated by the report generator's shadow pass;
    # we surface whatever is currently present so the endpoint alone is
    # useful without the script.)
    from shadow_log import summarize as _shadow_summarize
    shadow_diffs = await _shadow_summarize(cid, since_iso=(since if scope != "all" else None))

    # LLM usage stats — take the more expensive pass (candidates) if run.
    llm_usage = primary_cls.stats.as_dict()

    return {
        "gated":             False,
        "include":           include,
        "scope":             scope,
        "window_days":       config["window_days"] if scope != "all" else None,
        "date_range":        {"min": date_min, "max": date_max},
        "scanned":           len(txns),
        "reviewed_split":    {
            "human_reviewed": sum(1 for t in txns if t.get("human_reviewed")),
            "open":           sum(1 for t in txns if not t.get("human_reviewed")),
        },
        "connected_account_count": len(connected_ids),
        "buckets_by_include": buckets_by_include,
        "sample_verified":   sample_verified,
        "sample_fits_false": sample_fits_false,
        "top_review_reasons": top_review_reasons,
        "new_candidates":    primary_cls.new_candidates[:200],
        "paypal_ids":        paypal_ids,
        "other_bank_paypal_rows": primary_cls.other_bank_paypal_rows[:20],
        "unpaired_transfer_candidates": primary_cls.unpaired_transfer_candidates[:50],
        "shadow_diffs":      shadow_diffs,
        "llm_usage":         llm_usage,
        "registry_counts":   await _reg_counts(),
        "settings":          settings,
    }


def _canonical_from_txn_for_median(t: dict) -> str:
    """Match key for merchant-median calc — mirrors Step2Classifier's
    canonical picker without needing to instantiate it."""
    m = (t.get("merchant") or "").strip()
    if m:
        return m
    for cp in (t.get("counterparties") or []):
        if (cp.get("type") or "").lower() == "payment_app":
            continue
        name = (cp.get("name") or "").strip()
        if name:
            return name
    return (t.get("description") or "").strip()[:80]


@router.post("/companies/{cid}/reviewv2/settings")
async def set_reviewv2_settings(
    cid: str,
    payload: dict = Body(...),
    user: dict = Depends(get_current_user),
):
    """Update per-company Step 2 settings. Merge-only — missing keys
    keep their previous values / defaults. Never creates chart of
    accounts (per Step 2 spec)."""
    await require_company(user, cid)
    doc = await db.companies.find_one({"id": cid}, {"review_v2_settings": 1}) or {}
    existing = (doc.get("review_v2_settings") or {})
    allowed = {
        "multi_purpose_default_category",
        "multi_purpose_flag_threshold",
        "account_used_for_personal",
        "typical_spend_multiplier",
    }
    updates = {k: v for k, v in (payload or {}).items() if k in allowed}
    merged = {**existing, **updates}
    await db.companies.update_one(
        {"id": cid}, {"$set": {"review_v2_settings": merged}},
    )
    from reviewv2_step2 import get_settings
    return await get_settings(cid)


# =========================================================================
# Lab v3 → Review v2 · Lab linkage (Feb-2026).
#
# When a company is on ``categorization_mode == "lab_v3"``, every ingested
# transaction has already been categorized by the Lab pipeline and stamped
# on ``db.transactions`` via ``lab_pipeline/commit.py``:
#     ai_source        = "lab_v3"
#     needs_review     = bool
#     posted           = bool  (inverse of needs_review)
#     review_reason    = "uncategorized" | "unidentified_counterparty" |
#                        "unknown_account" | "sensitive_first_time" |
#                        "account_personal_use" | "taxable_or_business_expense"
#
# The paired ``lab_transactions`` doc carries ``review_card_key`` so
# "one card = one question over N rows" (one-answer-teaches-many).
#
# Endpoints:
#   GET  /companies/{cid}/reviewv2/lab-v3-queue   — build 3-stage queue
#   POST /companies/{cid}/reviewv2/lab-v3-answer  — write the answer
# =========================================================================
from lab_pipeline.collections import (
    LAB_TRANSACTIONS as _LAB_TXNS,
    LAB_COMPANY_ACCOUNTS,
)
from uuid import uuid4


# ---------------------------------------------------------------------------
# Limbo-transfer detection (2026-02-17).
#
# The lab pipeline sometimes labels a row as a "transfer" (movement_type in
# {outside_transfer, unpaired_transfer, payment_app_transfer, credit_line_
# payment, internal_transfer_unpaired}) OR stamps `category_account_name=
# "Inter-Account Transfer"` via pfc_resolver's asset_movement clearing path
# WITHOUT ever booking it to a real Chart-of-Accounts entry (no
# `category_account_id`). Owner directive: those rows must land in Stage 1
# "Accounts" for owner review — the only rows eligible for a real
# "Inter-Account Transfer" booking are CoA-listed asset bank accounts WITH
# a matching leg (Step 3A's paired-transfer rule).
# ---------------------------------------------------------------------------
_LIMBO_MOVEMENT_TYPES = {
    "outside_transfer",
    "unpaired_transfer",
    "payment_app_transfer",
    # NOTE: `credit_line_payment` is handled by pfc_resolver's loan /
    # credit-card sub-account mapping (Audi #2510, Rocket Mortgage #2520,
    # Best Buy, Concora, Citi, Capital One, etc.) — those rows already
    # have a real ``category_account_id`` and MUST NOT be lumped as limbo.
}


def _is_limbo_transfer(r: dict) -> bool:
    """True when the pipeline flagged this as a transfer but the booking
    is wrong per owner rule (2026-02-17):

      "Stage 1 Accounts is ONLY for transfers that need review — rows
       currently booked to the 'Inter-Account Transfer' clearing account
       that aren't actually matched pairs, OR rows booked to Uncategorized
       Income / Uncategorized Expenses whose description matches a
       transfer pattern (CHK NNNN, PayPal, Venmo, Zelle). Anything else
       (loans, credit cards, real expense accounts) stays out of Stage 1."
    """
    name = (r.get("category_account_name") or "").lower()
    mt = (r.get("movement_type") or "").lower()
    is_clearing = "inter-account transfer" in name or "inter account transfer" in name
    is_uncategorized = "uncategorized" in name

    # Trusted matched pair on the clearing account → respect the pipeline.
    if is_clearing and mt.startswith("internal_transfer") and r.get("category_account_id"):
        return False

    # Row on the clearing account but NOT a trusted pair → limbo.
    if is_clearing:
        return True

    # Row on Uncategorized Income / Uncategorized Expenses whose
    # description looks like an external-account transfer → limbo.
    if is_uncategorized:
        if mt in _LIMBO_MOVEMENT_TYPES:
            return True
        # Only true transfer patterns (CHK NNNN / PayPal / Venmo / Zelle)
        # — no vendor-slug fallback (that would over-catch merchants).
        synth = _synthesize_outside_key(r.get("description") or "", r.get("merchant"))
        if synth and (synth.startswith("outside_") or synth.startswith("payment_app_")
                      or synth == "credit_line_paypal_credit"):
            return True
        return False

    # Row without a real category_account_id AND transfer-ish → limbo.
    if not r.get("category_account_id"):
        return mt in _LIMBO_MOVEMENT_TYPES

    # Row is booked to a real sub-account (loan, credit card, expense,
    # bank fees, etc.) → respect the pipeline. NOT limbo.
    return False


# "CHK 6278", "SAV 1234", "ACCT #5678", "Checking xxxxxx7776", "Checking
# ···7776" etc. — the last-4 style identifier banks stamp on transfer
# descriptions. Captures the numeric last-4 only so we can synthesize a
# stable `outside_chk_NNNN` grouping key.
_OUTSIDE_ACCT_RX = re.compile(
    r"\b(CHK|SAV|CHECKING|SAVINGS|ACCT|ACCOUNT)"
    r"\s*(?:[x*·•.\-#]{2,})?"
    r"\s*(\d{3,6})\b",
    re.IGNORECASE,
)


def _synthesize_outside_key(desc: str, merchant: str | None = None) -> str | None:
    """Derive a stable ``lab_company_accounts.account_key``-shaped id from
    the transaction description (or merchant) when the pipeline never
    linked one. Returns ``None`` when nothing recognizable is found.

    Recognized transfer patterns:
      - "CHK 6278" / "SAV 1234" / "ACCT #5678" → outside_chk_6278 / outside_sav_1234
      - PayPal / Venmo / Zelle → payment_app_*
      - Bank-to-bank wire descriptors (e.g. "WELLS FARGO IFI DES:DDA TO
        DDA") → outside_<institution_slug> so the Stage-1 card asks
        about the non-company-owned counterparty bank, not the source
        BoA account.
    """
    if not desc and not merchant:
        return None
    src = desc or ""
    m = _OUTSIDE_ACCT_RX.search(src)
    if m:
        prefix = m.group(1).lower()
        num = m.group(2)
        if prefix in ("sav", "savings"):
            return f"outside_sav_{num}"
        return f"outside_chk_{num}"
    dl = src.lower()
    if "paypal" in dl and "credit" in dl:
        return "credit_line_paypal_credit"
    if "paypal" in dl:
        return "payment_app_paypal"
    if "venmo" in dl:
        return "payment_app_venmo"
    if "zelle" in dl:
        return "payment_app_zelle"
    # Bank-to-bank wire (WF IFI, Chase QuickPay, BoA wire, etc.). Only
    # fires when the description looks like an inter-bank movement
    # (DDA / IFI / ACH / EFT / WIRE / BANK / CHECKING / SAVINGS) — this
    # keeps normal card charges from getting mis-slugged.
    if _INTER_BANK_HINT_RX.search(src):
        b = _INSTITUTION_RX.search(src)
        if b:
            slug = re.sub(r"[^a-z0-9]+", "_", b.group(1).lower()).strip("_")
            return f"outside_{slug}"
    return None


# Common movement descriptors that signal "this is a bank-to-bank
# transfer descriptor, not a card charge".
_INTER_BANK_HINT_RX = re.compile(
    r"\b(DDA|IFI|ACH|EFT|WIRE|BANK|CHECKING|SAVINGS|CREDIT[- ]?UNION)\b",
    re.IGNORECASE,
)

# Major US banks / brokerages that appear as counterparties on bank
# statements. Order matters — longest match first to avoid partial hits
# (e.g. "BANK OF AMERICA" before "BANK").
_INSTITUTION_RX = re.compile(
    r"\b(WELLS FARGO(?: IFI)?"
    r"|BANK OF AMERICA|BOFA|B[- ]?OF[- ]?A"
    r"|JPMORGAN CHASE|JPMCHASE|JPM|CHASE"
    r"|CITIBANK|CITIGROUP"
    r"|USAA|CAPITAL ONE|PNC|TD BANK"
    r"|SUNTRUST|TRUIST|BB&T|BB AND T|REGIONS"
    r"|ALLY BANK|ALLY|CHARLES SCHWAB|SCHWAB"
    r"|FIDELITY|VANGUARD|MERRILL|MORGAN STANLEY"
    r"|GOLDMAN SACHS|GOLDMAN|HSBC|BARCLAYS"
    r"|DISCOVER BANK"
    r"|NAVY FEDERAL|NAVY FCU"
    r"|AMEX BANK)\b",
    re.IGNORECASE,
)



# review_reason → stage bucket.
# NOTE (2026-02-17): `account_personal_use` was retired — SmartBooks now
# assumes every connected account is a business account (per owner
# directive; no inference). Rows carrying the reason are skipped from
# the queue below. `unknown_account` and `affiliate_transfer_reason`
# now share a single 3-question "Accounts" flow (Contact → Purpose →
# Remember rule) handled by the `lab-v3-account-transfer-book` endpoint.
_LABV3_STAGE_BY_REASON = {
    "unknown_account":                1,
    "affiliate_transfer_reason":      1,  # legacy alias, same UI + endpoint
    "sensitive_first_time":           2,
    "taxable_or_business_expense":    2,
    "uncategorized":                  3,
    "unidentified_counterparty":      3,
}

# Options each stage/reason card offers the client.
_LABV3_OPTIONS_BY_REASON = {
    # Stage 1 "Accounts" cards render the new 3-question flow inside
    # `Stage1AccountsCard` (contact picker → free-text purpose → remember
    # rule). No button strip. The old Business/Personal/Another business
    # pre-fork is retired.
    "unknown_account":            [],
    "affiliate_transfer_reason":  [],
    # Second-step card after "Another business" — categorizes the
    # related-party transfer via a plain-English description that the
    # AI maps to THIS company's actual Chart of Accounts (rather than
    # forcing hardcoded GAAP names/codes that may not match the CoA).
    # Options list is empty on purpose: the card renders the free-text
    # AI-propose flow instead of a button strip.
    "taxable_or_business_expense": [
        {"key": "business",       "label": "Business expense — book normally"},
        {"key": "owner_comp",     "label": "Owner's Compensation (personal / non-deductible)"},
    ],
    "sensitive_first_time": [
        {"key": "confirm",        "label": "Confirm — this contact is expected"},
        {"key": "flag",           "label": "Flag for accountant"},
    ],
    "uncategorized": [
        {"key": "confirm",        "label": "Confirm the AI's proposed category"},
        {"key": "flag",           "label": "Flag for accountant"},
    ],
    "unidentified_counterparty": [
        {"key": "flag",           "label": "Flag for accountant"},
    ],
}


def _labv3_question(reason: str, sample: dict, extra: dict) -> str:
    """Human question the client sees at the top of the card."""
    if reason in ("unknown_account", "affiliate_transfer_reason"):
        # Both reasons share the unified 3-question "Accounts" flow.
        # extra carries `unknown_label`, `total_dollars`, `direction`
        # ("money_in", "money_out", "mixed"), and `label_is_source`
        # (True → label describes the row's source bank; False → label
        # describes the outside/destination account like CHK 6278).
        amt   = abs(float((extra or {}).get("total_dollars") or 0))
        label = (extra or {}).get("unknown_label") or "the other account"
        direction = (extra or {}).get("direction") or "mixed"
        label_is_source = bool((extra or {}).get("label_is_source"))
        if direction == "money_out":
            prep = "from" if label_is_source else "to"
            return f"How should we categorize the ${amt:,.2f} in Money Out {prep} {label}?"
        if direction == "money_in":
            prep = "to" if label_is_source else "from"
            return f"How should we categorize the ${amt:,.2f} in Money In {prep} {label}?"
        return f"How should we categorize the ${amt:,.2f} moving to/from {label}?"
    if reason == "taxable_or_business_expense":
        merch = sample.get("merchant") or sample.get("description") or "this merchant"
        return f"Is {merch} a business expense or Owner's Compensation?"
    if reason == "sensitive_first_time":
        merch = sample.get("merchant") or "this contact"
        return f"First-time payment to {merch} — confirm?"
    if reason == "unidentified_counterparty":
        amt = abs(float(sample.get("amount") or 0))
        return f"Who was the ${amt:,.2f} {sample.get('channel','payment')} to / from?"
    # uncategorized
    amt = abs(float(sample.get("amount") or 0))
    merch = sample.get("merchant") or sample.get("description") or "this transaction"
    return f"What was this ${amt:,.2f} charge for? ({merch})"


# ---------------------------------------------------------------------------
# Related-party GAAP mapping. Direction is derived from each row's amount
# sign — money OUT (< 0) means this book paid the affiliate, money IN
# (> 0) means we received from the affiliate. Each tuple returns the
# canonical account (name, type, code_range_start) so the answer handler
# can dedupe against existing accounts or auto-create new ones.
#
# Rule of thumb: whoever moved cash becomes the creditor.
# ---------------------------------------------------------------------------
_AFFILIATE_ACCOUNT_MAP: dict[tuple[str, str], dict] = {
    # (direction, choice) → { name_template, type, code_start }
    ("out", "loan"):            {"name": "Due from {affiliate}", "type": "asset",     "code": 1300, "subtype": "current_receivables"},
    ("in",  "loan"):            {"name": "Due to {affiliate}",   "type": "liability", "code": 2200, "subtype": "current_payables"},
    ("out", "reimbursement"):   {"name": "Due from {affiliate}", "type": "asset",     "code": 1300, "subtype": "current_receivables"},
    ("in",  "reimbursement"):   {"name": "Due to {affiliate}",   "type": "liability", "code": 2200, "subtype": "current_payables"},
    ("out", "owner_transfer"):  {"name": "Owner's Draw",         "type": "equity",    "code": 3200, "subtype": "owner_equity"},
    ("in",  "owner_transfer"):  {"name": "Owner's Contribution", "type": "equity",    "code": 3210, "subtype": "owner_equity"},
    ("out", "services"):        {"name": "Consulting Expense",   "type": "expense",   "code": 6900, "subtype": "operating_expense"},
    ("in",  "services"):        {"name": "Consulting Revenue",   "type": "revenue",   "code": 4900, "subtype": "other_income"},
    # "other" falls through to flag-for-accountant.
}


async def _resolve_or_create_account(
    cid: str, *, template: dict, affiliate: str, source_row: dict,
) -> dict | None:
    """Find an existing account matching the template, else create it.

    Idempotent on ``(company_id, normalized_name)``. Returns the account
    doc so the answer handler can stamp its id + name on the row.
    """
    name = (template["name"] or "").format(affiliate=affiliate).strip()
    if not name:
        return None
    # Try to find an existing match (case-insensitive on name).
    existing = await db.accounts.find_one({
        "company_id": cid,
        "$expr": {"$eq": [{"$toLower": "$name"}, name.lower()]},
    })
    if existing:
        return existing

    # Find the first free code at/after template["code"] stepping by 10.
    used = set()
    async for a in db.accounts.find(
        {"company_id": cid}, {"code": 1},
    ):
        c = str(a.get("code") or "").strip()
        if c.isdigit():
            used.add(int(c))
    code = int(template["code"])
    while code in used:
        code += 10

    now = datetime.now(timezone.utc).isoformat()
    doc = {
        "id":               str(uuid4()),
        "company_id":       cid,
        "code":             str(code),
        "name":             name,
        "type":             template["type"],
        "subtype":          template.get("subtype"),
        "detail_type":      None,
        "parent_account_id": None,
        "active":           True,
        "balance":          0.0,
        "created_by_ai":    True,
        "system_generated": True,
        "source":           "reviewv2::related_party",
        "created_at":       now,
        "updated_at":       now,
    }
    await db.accounts.insert_one(doc)
    return doc


def _labv3_direction(amount: float | None) -> str:
    return "in" if (amount or 0) > 0 else "out"


@router.get("/companies/{cid}/reviewv2/lab-v3-queue")
async def lab_v3_queue(cid: str, user: dict = Depends(get_current_user)):
    """Build the Review v2 · Lab queue from lab-v3-stamped rows.

    Groups by ``review_card_key`` so one CPA/client answer resolves every
    sibling row. Returns the same top-level shape ``transformBatchToV2``
    emits so the existing UI can consume it unchanged — with per-item
    ``_labV3``, ``options``, ``question``, ``card_key`` fields added.
    """
    await require_company(user, cid)

    # 1. All lab-v3-stamped rows (both posted + needs_review, so we can
    #    compute a real "% confirmed by dollars" progress bar).
    rows = [t async for t in db.transactions.find(
        {"company_id": cid, "ai_source": "lab_v3"},
        {"id": 1, "date": 1, "amount": 1, "merchant": 1, "description": 1,
         "bank_account_id": 1, "category_account_id": 1,
         "category_account_name": 1, "needs_review": 1, "posted": 1,
         "review_reason": 1, "movement_type": 1, "contact_id": 1,
         "contact_name": 1, "channel": 1, "flagged_for_accountant": 1,
         "ai_reasoning": 1},
    )]

    # 2. Paired lab_transactions docs → card_key + PFC + owner-comp flag.
    txn_ids = [r["id"] for r in rows]
    lab_by_txn: dict[str, dict] = {}
    if txn_ids:
        async for l in db[_LAB_TXNS].find(
            {"company_id": cid, "txn_id": {"$in": txn_ids}},
            {"txn_id": 1, "review_card_key": 1, "review_reason": 1,
             "raw": 1, "contact_id_lab": 1, "owner_comp_pending": 1,
             "linked_lab_account": 1},
        ):
            lab_by_txn[l["txn_id"]] = l

    # 3. Account name lookup for stage-1 "unknown_account" labels.
    accts: dict[str, dict] = {a["id"]: a async for a in db.accounts.find(
        {"company_id": cid}, {"id": 1, "name": 1, "bank_last4": 1, "code": 1},
    )}

    # Lab-detected outside/counterparty accounts (CHK ···7984, PayPal, etc.)
    # keyed by ``account_key`` so we can label an ``unknown_account`` card
    # with the account the CPA needs to answer about, NOT the connected
    # source account the transfer left from.
    lab_accts: dict[str, dict] = {}
    async for la in db[LAB_COMPANY_ACCOUNTS].find(
        {"company_id": cid},
        {"account_key": 1, "display_name": 1, "last4": 1, "kind": 1, "status": 1},
    ):
        if la.get("account_key"):
            lab_accts[la["account_key"]] = la

    def _acct_label(aid: str | None) -> str:
        a = accts.get(aid or "")
        if not a:
            return "—"
        last4 = a.get("bank_last4") or ""
        base = a.get("name") or a.get("code") or "account"
        return f"{base} ···{last4}" if last4 else base

    def _lab_acct_label(key: str | None) -> str:
        """Human label for a ``lab_company_accounts.account_key``."""
        if not key:
            return "—"
        la = lab_accts.get(key)
        if not la:
            # Fallback: derive from the key pattern
            if key.startswith("outside_chk_"):
                return f"External account ···{key.split('_')[-1]}"
            if key.startswith("outside_sav_"):
                return f"External savings ···{key.split('_')[-1]}"
            if key.startswith("outside_"):
                # Institution-based synth key (outside_wells_fargo_ifi,
                # outside_chase, outside_bofa, …) → title-case pretty.
                pretty = key[len("outside_"):].replace("_", " ").title()
                # Special-case IFI so "Wells Fargo Ifi" reads correctly.
                pretty = pretty.replace(" Ifi", " IFI")
                return f"External account ({pretty})"
            if key.startswith("credit_line_"):
                # credit_line_paypal_credit → "Paypal Credit"
                return key[len("credit_line_"):].replace("_", " ").title()
            return key.replace("_", " ").title()
        base = la.get("display_name") or key
        last4 = la.get("last4")
        if last4 and str(last4) not in base:
            return f"{base} ···{last4}"
        return base

    # 4. Compute progress + group review rows by card_key.
    total_dollars = 0.0
    confirmed_dollars = 0.0
    posted_count = 0
    posted_transfer_legs = 0
    groups: dict[str, dict] = {}

    for r in rows:
        amt = abs(float(r.get("amount") or 0))
        total_dollars += amt
        # Limbo-transfer detection — the lab pipeline sometimes labels a
        # row as some kind of "transfer" (outside_transfer, unpaired_
        # transfer, or bare "Inter-Account Transfer" with no id) but
        # never actually booked it to a real CoA account. Owner directive
        # (2026-02-17): the only rows eligible for "Inter-Account Transfer"
        # are CoA-listed asset bank accounts WITH a matching leg. Any
        # limbo row must land in Stage 1 "Accounts" for the owner to
        # categorize, regardless of `needs_review`.
        _limbo = _is_limbo_transfer(r)
        if not r.get("needs_review") and not _limbo:
            confirmed_dollars += amt
            posted_count += 1
            if (r.get("movement_type") or "").startswith("internal_transfer"):
                posted_transfer_legs += 1
            continue
        if r.get("flagged_for_accountant"):
            # Already flagged — hide from the queue but keep it in the
            # "needs review" count so the CPA sees the backlog.
            continue

        lab = lab_by_txn.get(r["id"], {}) or {}
        reason = r.get("review_reason") or lab.get("review_reason") or "uncategorized"
        # Retired (2026-02-17): the "Is this account used for personal
        # charges too?" question. All connected accounts are assumed to
        # be business. Skip these rows from the queue entirely — no
        # inference, no question.
        if reason == "account_personal_use":
            continue
        # Limbo transfers get force-routed to Stage 1 as "unknown_account"
        # so the new Accounts 3-question flow (Contact → Purpose → Rule)
        # takes over. Synthesize the linked_lab_account key from the
        # description if the pipeline never linked one.
        if _limbo:
            reason = "unknown_account"
            if not lab.get("linked_lab_account"):
                synth = _synthesize_outside_key(
                    r.get("description") or "", r.get("merchant"))
                if synth:
                    lab = {**lab, "linked_lab_account": synth}
        # Fallback card_key: bucket by (bank_account, linked_lab_account,
        # reason) for stage-1 so rows leaving the same source bank to
        # DIFFERENT outside accounts (e.g. CHK 6278 vs PayPal) stay
        # separate cards. Fixes a bug where they were lumped by
        # bank+reason only, and the card header said "6278" while some
        # rows were actually PayPal transfers.
        stage = _LABV3_STAGE_BY_REASON.get(reason, 3)
        card_key = lab.get("review_card_key") if not _limbo else None
        if not card_key:
            if stage == 1:
                linked = lab.get("linked_lab_account") or "no_linked"
                # Split by direction so a "mixed" outside account (e.g.
                # CHK 6278 with 3 refunds coming back and 29 outbound
                # transfers) becomes TWO separate Stage 1 cards — owners
                # can pick a different contact/purpose for each side
                # (small refund reversals no longer force one blanket
                # category on the outbound transfers).
                dir_key = "in" if (r.get("amount") or 0) > 0 else "out"
                card_key = f"labv3::acct::{r.get('bank_account_id') or 'unknown'}::{linked}::{dir_key}::{reason}"
            elif stage == 2:
                cid_ = lab.get("contact_id_lab") or r.get("contact_id") or "unknown"
                pfc = ((lab.get("raw") or {}).get("pfc_detailed") or "")
                card_key = f"labv3::pat::{cid_}::{pfc}::{reason}"
            else:
                # Stage 3 "Few one-offs" — group by merchant + direction so
                # multiple charges from the same vendor collapse into ONE
                # card (e.g. 3 Amazon charges → 1 grouped card instead of
                # 3 singleton cards). Previously we keyed by `r['id']`
                # which forced 1 row = 1 card and broke grouping.
                merch_key = _canonical_merchant(
                    r.get("description") or "", r.get("merchant") or "",
                ) or "unknown"
                dir_key = "in" if (r.get("amount") or 0) > 0 else "out"
                pfc = ((lab.get("raw") or {}).get("pfc_detailed") or "")
                card_key = f"labv3::one::{merch_key}::{dir_key}::{pfc}::{reason}"

        g = groups.setdefault(card_key, {
            "card_key":     card_key,
            "reason":       reason,
            "stage":        stage,
            "rows":         [],
            "txn_ids":      [],
            "contact_id":   lab.get("contact_id_lab") or r.get("contact_id"),
            "contact_name": r.get("contact_name"),
            "pfc_detailed": ((lab.get("raw") or {}).get("pfc_detailed") or None),
            "bank_account_id": r.get("bank_account_id"),
            # For unknown_account rows, the account needing an answer is
            # the DESTINATION (linked_lab_account from step4), NOT the
            # connected source account the transfer left from.
            "linked_lab_account": lab.get("linked_lab_account"),
        })
        g["rows"].append(r)
        g["txn_ids"].append(r["id"])

    # Promote mixed-direction "who is this?" groups (uncategorized /
    # unidentified_counterparty with BOTH money-in and money-out rows
    # for the same contact) up to Stage 2, so the rich relationship-
    # pill mixed card fires instead of the plain two-option strip.
    for g in groups.values():
        if g["stage"] == 3 and g["reason"] in ("uncategorized", "unidentified_counterparty"):
            has_in  = any((r.get("amount") or 0) > 0 for r in g["rows"])
            has_out = any((r.get("amount") or 0) < 0 for r in g["rows"])
            if has_in and has_out and len(g["rows"]) >= 2:
                g["stage"] = 2

    # 5. Build the 3 stage lists in transformBatchToV2 shape.
    stage1: list[dict] = []
    stage2: list[dict] = []
    stage3: list[dict] = []

    for card_key, g in groups.items():
        rows_g = g["rows"]
        reason = g["reason"]
        rows_g.sort(key=lambda x: abs(float(x.get("amount") or 0)), reverse=True)
        top = rows_g[0]
        group_total = round(sum(abs(float(r.get("amount") or 0)) for r in rows_g), 2)
        money_in  = [r for r in rows_g if (r.get("amount") or 0) > 0]
        money_out = [r for r in rows_g if (r.get("amount") or 0) < 0]
        samples_in  = [{"date": r.get("date"), "amount": abs(float(r.get("amount") or 0)),
                        "desc": r.get("description") or r.get("merchant")}
                       for r in money_in[:3]]
        samples_out = [{"date": r.get("date"), "amount": abs(float(r.get("amount") or 0)),
                        "desc": r.get("description") or r.get("merchant")}
                       for r in money_out[:3]]
        sample_ctx = {
            "date":        top.get("date"),
            "amount":      top.get("amount"),
            "merchant":    top.get("merchant"),
            "description": top.get("description"),
            "channel":     top.get("channel"),
        }
        question = _labv3_question(reason, sample_ctx, g)
        options  = _LABV3_OPTIONS_BY_REASON.get(reason, [
            {"key": "confirm", "label": "Confirm"},
            {"key": "flag",    "label": "Flag for accountant"},
        ])

        base_item = {
            "_labV3":       True,
            "card_key":     card_key,
            "reason":       reason,
            "question":     question,
            "options":      options,
            "txn_ids":      g["txn_ids"],
            "total_dollars": group_total,
            "count":        len(rows_g),
            "contact_id":   g.get("contact_id"),
            "contact_name": g.get("contact_name"),
            "pfc_detailed": g.get("pfc_detailed"),
            "bank_account_id": g.get("bank_account_id"),
            "proposed_category": top.get("category_account_name"),
            "ai_reasoning": top.get("ai_reasoning"),
        }

        if g["stage"] == 1:
            # For unknown_account rows the ledger's bank_account_id is
            # the KNOWN source; the actual mystery is the destination
            # account extracted from the transfer descriptor (CHK 7984,
            # PayPal, etc.), stamped as `linked_lab_account` by step4.
            unknown_key = g.get("linked_lab_account")
            # When we have a linked outside account key, the label
            # describes the OUTSIDE / DESTINATION side (e.g. "External
            # account ···6278"). Otherwise the label falls back to the
            # row's own bank account, i.e. the SOURCE side ("Bank of
            # America Checking ···9917"). Drives the preposition on
            # the question ("Money Out from source" vs "Money Out to
            # destination").
            label_is_source = not (unknown_key and reason in ("unknown_account", "affiliate_transfer_reason"))
            unknown_label = (
                _lab_acct_label(unknown_key)
                if not label_is_source
                else _acct_label(g.get("bank_account_id"))
            )
            # Direction — ALWAYS from our (source-bank) perspective:
            #   money_out = money leaving our books (amount < 0)
            #   money_in  = money entering our books (amount > 0)
            if money_in and not money_out:
                direction = "money_in"
            elif money_out and not money_in:
                direction = "money_out"
            else:
                direction = "mixed"
            # Unified "Accounts" question — both reasons share it and
            # phrase it in one definite direction when possible.
            base_item["question"] = _labv3_question(
                reason, sample_ctx,
                {**g, "unknown_label": unknown_label,
                 "total_dollars": group_total,
                 "direction": direction,
                 "label_is_source": label_is_source},
            )

            # Pull the currently-linked contact (if the outside account
            # was previously classified) so the picker can pre-select.
            linked_contact_id   = None
            linked_contact_name = None
            if unknown_key:
                la = await db[LAB_COMPANY_ACCOUNTS].find_one(
                    {"company_id": cid, "account_key": unknown_key},
                    {"contact_id": 1, "contact_name": 1},
                )
                if la:
                    linked_contact_id   = la.get("contact_id")
                    linked_contact_name = la.get("contact_name")

            stage1.append({
                **base_item,
                "pair_id":       card_key,
                "from":          unknown_label,
                "to":            "(needs your answer)",
                "unknown_account_key": unknown_key,
                "source_account": _acct_label(g.get("bank_account_id")),
                "transfer_count": len(rows_g),
                # New unified 3-question flow (Contact → Purpose → Rule).
                # Frontend switches on this flag to render Stage1AccountsCard.
                "needs_transfer_flow":  True,
                "linked_contact_id":    linked_contact_id,
                "linked_contact_name":  linked_contact_name,
                # Direction summary so the front-end can render "5 Money
                # Out" / "3 Money In" / "2 In + 1 Out" instead of a
                # vague "N transfers".
                "direction":       direction,
                "money_in_count":  len(money_in),
                "money_out_count": len(money_out),
                "money_in_total":  round(sum(abs(float(r.get("amount") or 0)) for r in money_in), 2),
                "money_out_total": round(sum(abs(float(r.get("amount") or 0)) for r in money_out), 2),
                # Legacy: retained for the affiliate 2-step affiliate-name
                # input (only true when a row already carries this reason
                # from a previous run; new rows never set it).
                "needs_affiliate_name": reason == "affiliate_transfer_reason",
                "samples":       [
                    {"date": r.get("date"),
                     "from": _acct_label(r.get("bank_account_id")),
                     "to":   r.get("description") or r.get("merchant") or "—",
                     "amount": abs(float(r.get("amount") or 0)),
                     "direction": "in" if (r.get("amount") or 0) > 0 else "out"}
                    for r in rows_g[:3]
                ],
            })
        elif g["stage"] == 2:
            merch_label = g.get("contact_name") or (top.get("merchant") or top.get("description") or "this contact")
            stage2.append({
                **base_item,
                "group_id":       card_key,
                "label":          merch_label,
                "items":          [{"id": r["id"], "date": r.get("date"),
                                     "amount": r.get("amount"),
                                     "desc": r.get("description")}
                                    for r in rows_g],
                "is_mixed":       bool(money_in and money_out),
                "money_in_count": len(money_in),
                "money_out_count": len(money_out),
                "money_in_total":  round(sum(abs(float(r.get("amount") or 0)) for r in money_in), 2),
                "money_out_total": round(sum(abs(float(r.get("amount") or 0)) for r in money_out), 2),
                "samples_in":      samples_in,
                "samples_out":     samples_out,
                "ai_suggestion":   top.get("category_account_name"),
                "outliers":        [],
                "is_example":      False,
            })
        else:
            # Stage 3 "Few one-offs". Emit `kind:"singleton"` for a
            # single-row card (unchanged UX), or `kind:"group"` when we
            # collapsed N charges from the same merchant into one card
            # so the client can answer once and post them all.
            is_group = len(rows_g) > 1
            samples = [
                {"date": r.get("date"),
                 "amount": abs(float(r.get("amount") or 0)),
                 "desc": r.get("description") or r.get("merchant"),
                 "direction": "in" if (r.get("amount") or 0) > 0 else "out"}
                for r in rows_g[:5]
            ]
            stage3.append({
                **base_item,
                "one_off_id":  card_key,
                "kind":        "group" if is_group else "singleton",
                "merchant":    top.get("merchant") or top.get("description") or "—",
                "description": top.get("description"),
                "amount":      abs(float(top.get("amount") or 0)),
                "date":        top.get("date"),
                "direction":   _labv3_direction(top.get("amount")),
                "context":     sample_ctx,
                "raw_item":    {"context": sample_ctx},
                "prompt":      question,
                # Grouped-card fields (harmless on singletons).
                "samples":         samples,
                "money_in_count":  len(money_in),
                "money_out_count": len(money_out),
                "money_in_total":  round(sum(abs(float(r.get("amount") or 0)) for r in money_in), 2),
                "money_out_total": round(sum(abs(float(r.get("amount") or 0)) for r in money_out), 2),
                "is_example":  False,
            })

    # Biggest dollars first within each stage.
    stage1.sort(key=lambda x: x["total_dollars"], reverse=True)
    stage2.sort(key=lambda x: x["total_dollars"], reverse=True)
    stage3.sort(key=lambda x: x["total_dollars"], reverse=True)

    pct_confirmed = int(round(100 * confirmed_dollars / total_dollars)) if total_dollars > 0 else 0
    questions_left = len(stage1) + len(stage2) + len(stage3)

    return {
        "mode":            "lab_v3",
        "stage1_accounts": stage1,
        "stage2_patterns": stage2,
        "stage3_oneoffs":  stage3,
        "progress": {
            "pct_confirmed":     pct_confirmed,
            "questions_left":    questions_left,
            "total_dollars":     round(total_dollars, 2),
            "confirmed_dollars": round(confirmed_dollars, 2),
        },
        # Match the shape ReviewV2Lab.jsx reads via the audit obj.
        "auto_handled": {
            "count":   posted_count,
            "dollars": round(confirmed_dollars, 2),
            "by_reason": {
                "transfer_both_connected": posted_transfer_legs,
                "recognized_vendor":       posted_count - posted_transfer_legs,
            },
            "spot_check_sample": [],
        },
        "scanned":                 len(rows),
        "connected_account_count": len(accts),
        "rules_count":             0,
        "window_days":             365,
        "unsupported_flags":       [],
    }


@router.post("/companies/{cid}/reviewv2/lab-v3-answer")
async def lab_v3_answer(
    cid: str,
    payload: dict = Body(...),
    user: dict = Depends(get_current_user),
):
    """Persist a client/CPA answer for a lab-v3 review card.

    Body:
      {
        "card_key":     str,       # required
        "reason":       str,       # required — one of the 6 review_reason values
        "choice":       str,       # required — option key from _LABV3_OPTIONS_BY_REASON
        "txn_ids":      [str,...], # required — rows this answer covers
        "contact_id":   str|null,
        "pfc_detailed": str|null,
        "note":         str|null,  # optional free-text
      }

    Behavior:
      • choice ∈ (confirm, business, business_only, owner_comp, personal,
        another_biz, mixed_use):
            → mark rows posted=true, needs_review=false; write a
              lab_feedback doc (one-answer-teaches-many) keyed on
              (company_id, contact_id, pfc_detailed) for owner-comp
              reasons, or on (company_id, bank_account_id) for account
              reasons.
      • choice == "flag":
            → keep needs_review=true, stamp flagged_for_accountant=true.
    """
    await require_company(user, cid)
    card_key = (payload.get("card_key") or "").strip()
    reason   = (payload.get("reason")   or "").strip()
    choice   = (payload.get("choice")   or "").strip()
    txn_ids  = payload.get("txn_ids") or []
    if not card_key or not reason or not choice or not txn_ids:
        raise HTTPException(400, "card_key, reason, choice, txn_ids required")

    contact_id   = payload.get("contact_id")
    pfc_detailed = payload.get("pfc_detailed")
    note         = (payload.get("note") or "").strip() or None
    now = datetime.now(timezone.utc).isoformat()

    # -- Flag branch -------------------------------------------------------
    if choice == "flag":
        r = await db.transactions.update_many(
            {"company_id": cid, "id": {"$in": txn_ids}},
            {"$set": {"flagged_for_accountant": True,
                       "flagged_at":             now,
                       "flagged_reason":         reason,
                       "flagged_note":           note,
                       "updated_at":             now}},
        )
        # Feedback breadcrumb — audit-only, no auto-apply.
        await db.lab_feedback.insert_one({
            "company_id":    cid,
            "scope":         f"reviewv2_{reason}",
            "learn":         False,
            "card_key":      card_key,
            "contact_id":    contact_id,
            "pfc_detailed":  pfc_detailed,
            "choice":        "flag",
            "note":          note,
            "txn_ids":       txn_ids,
            "created_at":    now,
            "created_by":    user.get("id"),
        })
        return {"ok": True, "action": "flag", "affected": r.modified_count}

    # ------------------------------------------------------------------
    # "Another business" — do NOT post the rows yet. Transition them to
    # the follow-up ``affiliate_transfer_reason`` card so the CPA can
    # tell us WHY the transfer happened (loan, owner equity, services
    # rendered, reimbursement). The GAAP account depends on the reason.
    # ------------------------------------------------------------------
    if reason == "unknown_account" and choice == "another_biz":
        if payload.get("unknown_account_key"):
            await db[LAB_COMPANY_ACCOUNTS].update_one(
                {"company_id": cid, "account_key": payload["unknown_account_key"]},
                {"$set": {"status": "other_business",
                           "resolved_at": now,
                           "resolved_by": user.get("id")}},
            )
        # Re-flag every row on this account_key so the follow-up card
        # fires. We keep needs_review=true and swap the review_reason.
        await db.transactions.update_many(
            {"company_id": cid, "id": {"$in": txn_ids}},
            {"$set": {"review_reason": "affiliate_transfer_reason",
                       "awaiting_affiliate_reason": True,
                       "updated_at": now}},
        )
        await db[_LAB_TXNS].update_many(
            {"company_id": cid, "txn_id": {"$in": txn_ids}},
            {"$set": {"review_reason": "affiliate_transfer_reason"}},
        )
        return {"ok": True, "action": "another_business_pending_reason",
                "next_reason": "affiliate_transfer_reason"}

    # ------------------------------------------------------------------
    # Follow-up card answered: the AI proposed an account (from the
    # company's actual CoA or as a brand-new account); the user hit
    # Confirm. We look up / create the account then post the row(s)
    # and remember the mapping for the same linked_lab_account.
    # ------------------------------------------------------------------
    if reason == "affiliate_transfer_reason":
        affiliate = (payload.get("affiliate_name") or "").strip() or "Related Party"
        proposed_code = (payload.get("proposed_account_code") or "").strip()
        new_account   = payload.get("new_account") or None
        ai_reasoning  = (payload.get("ai_reasoning") or "").strip()
        description   = (payload.get("user_description") or "").strip()

        # "Something else — flag" path (unchanged semantics).
        if choice == "flag":
            await db.transactions.update_many(
                {"company_id": cid, "id": {"$in": txn_ids}},
                {"$set": {"flagged_for_accountant": True,
                           "flagged_reason": "affiliate_transfer_other",
                           "flagged_note":   f"Affiliate: {affiliate}. {description}".strip(),
                           "flagged_at":     now,
                           "updated_at":     now}},
            )
            return {"ok": True, "action": "flag", "reason": "affiliate_other"}

        # 1. Resolve the target account.
        acct = None
        if proposed_code:
            acct = await db.accounts.find_one(
                {"company_id": cid, "code": proposed_code})
        if not acct and new_account and new_account.get("name"):
            # AI proposed a brand-new account that follows this
            # company's naming style.
            template = {
                "name":    new_account["name"],
                "type":    new_account.get("type") or "asset",
                "subtype": new_account.get("subtype"),
                "code":    int(new_account.get("code") or 1300),
            }
            acct = await _resolve_or_create_account(
                cid, template=template, affiliate=affiliate,
                source_row={},
            )
        if not acct:
            raise HTTPException(
                400, "affiliate proposal needs proposed_account_code or new_account")

        # 2. Post every row to the same resolved account.
        r = await db.transactions.update_many(
            {"company_id": cid, "id": {"$in": txn_ids}},
            {"$set": {
                "category_account_id":   acct["id"],
                "category_account_name": acct["name"],
                "category_source":       "reviewv2::related_party_ai",
                "needs_review":          False,
                "posted":                True,
                "reviewed_at":           now,
                "reviewed_by":           user.get("id"),
                "review_choice":         f"affiliate:ai_book",
                "affiliate_name":        affiliate,
                "affiliate_description": description or None,
                "affiliate_reasoning":   ai_reasoning or None,
                "awaiting_affiliate_reason": False,
                "updated_at":            now,
            }},
        )
        await db[_LAB_TXNS].update_many(
            {"company_id": cid, "txn_id": {"$in": txn_ids}},
            {"$set": {"verified": True, "review_reason": None,
                       "reviewed_at": now, "review_choice": "affiliate:ai_book"}},
        )

        # 3. Learn-many: future transfers on the same outside account
        # auto-book to the same resolved account.
        if payload.get("unknown_account_key"):
            await db.lab_feedback.update_one(
                {"company_id":         cid,
                 "scope":              "affiliate_transfer",
                 "linked_lab_account": payload["unknown_account_key"]},
                {"$set": {
                    "company_id":            cid,
                    "scope":                 "affiliate_transfer",
                    "learn":                 True,
                    "linked_lab_account":    payload["unknown_account_key"],
                    "affiliate_name":        affiliate,
                    "category_account_id":   acct["id"],
                    "category_account_name": acct["name"],
                    "description":           description,
                    "ai_reasoning":          ai_reasoning,
                    "created_by":            user.get("id"),
                    "updated_at":            now,
                }, "$setOnInsert": {"created_at": now}},
                upsert=True,
            )

        return {"ok": True, "action": "affiliate_transfer_booked",
                "account_id": acct["id"], "account_name": acct["name"],
                "affiliate": affiliate, "affected": r.modified_count}

    # -- Confirm-family branches ------------------------------------------
    set_doc = {
        "needs_review":  False,
        "posted":        True,
        "reviewed_at":   now,
        "reviewed_by":   user.get("id"),
        "review_choice": choice,
        "updated_at":    now,
    }
    r = await db.transactions.update_many(
        {"company_id": cid, "id": {"$in": txn_ids}},
        {"$set": set_doc},
    )

    # Mirror onto lab_transactions so the pipeline sees the resolution
    # on next re-run (idempotency).
    await db[_LAB_TXNS].update_many(
        {"company_id": cid, "txn_id": {"$in": txn_ids}},
        {"$set": {"verified": True, "review_reason": None,
                   "reviewed_at": now, "review_choice": choice}},
    )

    # One-answer-teaches-many feedback for owner-comp questions.
    if reason == "taxable_or_business_expense" and choice in ("business", "owner_comp"):
        await db.lab_feedback.update_one(
            {"company_id":   cid,
             "scope":        "owner_comp",
             "contact_id":   contact_id or "",
             "pfc_detailed": pfc_detailed or ""},
            {"$set": {
                "company_id":    cid,
                "scope":         "owner_comp",
                "learn":         True,
                "contact_id":    contact_id or "",
                "pfc_detailed":  pfc_detailed or "",
                "choice":        choice,
                "note":          note,
                "card_key":      card_key,
                "updated_at":    now,
                "created_by":    user.get("id"),
            }, "$setOnInsert": {"created_at": now}},
            upsert=True,
        )

    # One-answer-teaches-many feedback for mixed "who is this?" groups
    # (uncategorized / unidentified_counterparty with a relationship
    # answer from the pill card — customer / contractor / owner /
    # lender / something). Keyed on contact so every future row for
    # the same contact auto-books to the right side.
    if choice in ("customer", "contractor", "owner", "lender", "something") and contact_id:
        await db.lab_feedback.update_one(
            {"company_id": cid, "scope": "relationship", "contact_id": contact_id},
            {"$set": {
                "company_id":  cid,
                "scope":       "relationship",
                "learn":       True,
                "contact_id":  contact_id,
                "choice":      choice,
                "note":        note,
                "card_key":    card_key,
                "updated_at":  now,
                "created_by":  user.get("id"),
            }, "$setOnInsert": {"created_at": now}},
            upsert=True,
        )

    # ------------------------------------------------------------------
    # Account-level flag for personal-use answers on the SOURCE bank
    # account (account_personal_use is asked about the account the row
    # was ingested on).
    if reason == "account_personal_use" and payload.get("bank_account_id"):
        acct_id = payload["bank_account_id"]
        # personal / mixed_use → true (has personal use); business_only
        # → false.
        has_personal = choice in ("personal", "mixed_use")
        await db.companies.update_one(
            {"id": cid},
            {"$set": {f"lab_settings.account_used_for_personal.{acct_id}": has_personal,
                       "updated_at": now}},
        )

    # unknown_account answers (business / personal — "another_biz" is
    # handled by the early-return transition above) write status to
    # lab_company_accounts for the DESTINATION account.
    if reason == "unknown_account" and payload.get("unknown_account_key") and choice != "another_biz":
        status_map = {
            "business":    "business_own",
            "personal":    "personal",
        }
        new_status = status_map.get(choice)
        if new_status:
            await db[LAB_COMPANY_ACCOUNTS].update_one(
                {"company_id": cid, "account_key": payload["unknown_account_key"]},
                {"$set": {"status": new_status,
                           "resolved_at": now,
                           "resolved_by": user.get("id")}},
            )

    # Breadcrumb for audit.
    await db.lab_feedback.insert_one({
        "company_id":    cid,
        "scope":         f"reviewv2_{reason}",
        "learn":         False,
        "card_key":      card_key,
        "contact_id":    contact_id,
        "pfc_detailed":  pfc_detailed,
        "choice":        choice,
        "note":          note,
        "txn_ids":       txn_ids,
        "created_at":    now,
        "created_by":    user.get("id"),
    })

    return {"ok": True, "action": "confirm", "choice": choice,
            "affected": r.modified_count}



# ---------------------------------------------------------------------------
# Stage 1 "Accounts" — new 3-question transfer-book endpoint (2026-02-17).
# Replaces the old Business/Personal/Another business pre-fork with a
# single unified flow: Contact → Purpose (free-text + AI) → Remember rule.
# ---------------------------------------------------------------------------
_TRANSFER_BOOK_SYSTEM = (
    "You are the SmartBooks bookkeeping assistant. The owner is telling "
    "you what an external-account transfer was for, and you must map it "
    "to a single ledger account from THIS company's actual Chart of "
    "Accounts. Rules:\n"
    "1. Prefer an EXISTING account when a reasonable match exists.\n"
    "2. Only propose a new account when nothing existing fits — pick a "
    "code in the appropriate numeric range for the type and follow the "
    "company's naming style.\n"
    "3. Use these GAAP defaults for common transfer purposes: money the "
    "owner takes out → Owner's Draw (equity, 3200 range). Owner puts money "
    "in → Owner's Contribution (equity, 3210 range). Loan received → "
    "Loans Payable (liability, 2500). Loan repaid → same Loans Payable. "
    "Business-to-business intercompany transfer → Due from/to {contact} "
    "(asset 1300 range / liability 2200 range depending on direction). "
    "Reimbursement to owner → Owner's Draw. Business purchase paid from "
    "outside account → the matching expense account.\n"
    "4. If the purpose is ambiguous or requires a CPA judgment call "
    "(tax payments on pass-throughs, ownership splits, unclear loans), "
    "set flag_for_cpa=true.\n\n"
    "Reply ONLY with strict JSON, no prose:\n"
    "{\n"
    '  "account_id":     "existing-uuid-or-null",\n'
    '  "account_code":   "3200",\n'
    '  "account_name":   "Owner\'s Draw",\n'
    '  "account_type":   "equity",\n'
    '  "is_new":         false,\n'
    '  "reason":         "Owner said this was a personal withdrawal.",\n'
    '  "confidence":     0.9,\n'
    '  "flag_for_cpa":   false\n'
    "}"
)


@router.post("/companies/{cid}/reviewv2/account-transfer-propose")
async def account_transfer_propose(
    cid: str, payload: dict = Body(...),
    user: dict = Depends(get_current_user),
):
    """AI proposes an account for the Stage-1 3-question transfer flow.

    Body: ``{contact_name, purpose_text, direction, unknown_label}``
    Returns the JSON shape shown in _TRANSFER_BOOK_SYSTEM.
    """
    await require_company(user, cid)
    contact_name  = (payload.get("contact_name")  or "").strip() or "the contact"
    purpose_text  = (payload.get("purpose_text")  or "").strip()
    direction     = (payload.get("direction")     or "mixed").strip()
    unknown_label = (payload.get("unknown_label") or "the outside account").strip()
    if not purpose_text:
        raise HTTPException(400, "purpose_text required")

    company = await db.companies.find_one({"id": cid}) or {}
    business_type = company.get("business_type") or ""

    coa_cur = db.accounts.find(
        {"company_id": cid, "active": True},
        {"id": 1, "code": 1, "name": 1, "type": 1, "parent_account_id": 1},
    ).sort("code", 1).limit(300)
    coa = [a async for a in coa_cur]
    coa_lines = "\n".join(
        f"- {a.get('code','')} {a.get('name','')} ({a.get('type','')})"
        f"{'  [sub-account]' if a.get('parent_account_id') else ''}"
        f"  id={a['id']}"
        for a in coa
    ) or "(no accounts defined)"

    prompt = (
        f"Entity rules:\n{_entity_hint(business_type)}\n\n"
        f"Chart of accounts:\n{coa_lines}\n\n"
        f"Transfer context:\n"
        f"  Outside account label: {unknown_label}\n"
        f"  Contact linked to that account: {contact_name}\n"
        f"  Direction: {direction} (money_in = we received, money_out = we sent)\n\n"
        f"Owner's plain-language purpose:\n  \"{purpose_text}\"\n\n"
        "Return the JSON now."
    )

    chat = _new_chat(_TRANSFER_BOOK_SYSTEM, f"rv2-xfer-{cid}",
                     feature="reviewv2-transfer-propose", company_id=cid)
    text = ""
    try:
        async for ev in chat.stream_message(UserMessage(text=prompt)):
            if isinstance(ev, TextDelta):
                text += ev.content
            elif isinstance(ev, StreamDone):
                break
    except Exception as e:
        raise HTTPException(500, f"AI proposal failed: {e}")

    m = re.search(r"\{[\s\S]*\}", text)
    if not m:
        return {"ok": False, "raw": text, "reason": "AI did not return JSON."}
    try:
        parsed = json.loads(m.group(0))
    except Exception:
        return {"ok": False, "raw": text, "reason": "AI JSON malformed."}

    parsed["ok"] = True
    parsed.setdefault("is_new", False)
    parsed.setdefault("flag_for_cpa", False)
    parsed.setdefault("direction", direction)
    return parsed


@router.post("/companies/{cid}/reviewv2/account-transfer-book")
async def account_transfer_book(
    cid: str, payload: dict = Body(...),
    user: dict = Depends(get_current_user),
):
    """Book Stage-1 transfer rows using the new 3-question flow.

    Body:
      {
        card_key, unknown_account_key, txn_ids,
        contact_id | new_contact_name,
        purpose_text,
        proposal:  {account_id, account_code, account_name, account_type, is_new, ...},
        remember_rule: bool,
      }
    """
    await require_company(user, cid)
    txn_ids             = payload.get("txn_ids") or []
    if not txn_ids:
        raise HTTPException(400, "txn_ids required")
    proposal            = payload.get("proposal") or {}
    if not proposal:
        raise HTTPException(400, "proposal required")
    purpose_text        = (payload.get("purpose_text") or "").strip()
    unknown_account_key = payload.get("unknown_account_key")
    remember_rule       = bool(payload.get("remember_rule"))
    contact_id          = payload.get("contact_id")
    new_contact_name    = (payload.get("new_contact_name") or "").strip()
    now = datetime.now(timezone.utc).isoformat()

    # 1. Resolve or create the Contact.
    contact = None
    if contact_id:
        contact = await db.contacts.find_one({"company_id": cid, "id": contact_id})
    if not contact and new_contact_name:
        # Import lazily to avoid cycle in module init.
        from contact_resolver import normalize_contact_name
        norm = normalize_contact_name(new_contact_name)
        contact = await db.contacts.find_one(
            {"company_id": cid, "normalized_name": norm})
        if not contact:
            new_id = str(uuid4())
            doc = {
                "id":              new_id,
                "company_id":      cid,
                "name":            new_contact_name,
                "normalized_name": norm,
                "type":            "vendor",
                "source":          "reviewv2::account_transfer",
                "created_at":      now,
                "updated_at":      now,
            }
            try:
                await db.contacts.insert_one(doc)
                contact = doc
            except Exception:
                # Race: another writer created it — re-read.
                contact = await db.contacts.find_one(
                    {"company_id": cid, "normalized_name": norm})
    if not contact:
        raise HTTPException(400, "contact_id or new_contact_name required")

    # 2. Resolve or create the target account.
    acct = None
    aid = proposal.get("account_id")
    # Filter out AI-echoed prompt-example placeholders and non-uuid junk.
    if aid and isinstance(aid, str) and aid not in ("", "null", "None") \
       and not aid.startswith("existing-"):
        acct = await db.accounts.find_one({"company_id": cid, "id": aid})
    if not acct and proposal.get("account_code"):
        acct = await db.accounts.find_one({
            "company_id": cid, "code": str(proposal["account_code"])})
    if not acct and (proposal.get("is_new") or proposal.get("account_name")):
        acct = await _resolve_or_create_account(
            cid,
            template={
                "name":    (proposal.get("account_name") or "").format(
                                affiliate=contact["name"]).strip() or contact["name"],
                "type":    proposal.get("account_type") or "asset",
                "subtype": None,
                "code":    int(proposal.get("account_code") or 1300),
            },
            affiliate=contact["name"],
            source_row={},
        )
    if not acct:
        raise HTTPException(400, "Could not resolve target account.")

    # 3. Stamp the outside account with the linked contact (idempotent).
    if unknown_account_key:
        await db[LAB_COMPANY_ACCOUNTS].update_one(
            {"company_id": cid, "account_key": unknown_account_key},
            {"$set": {
                "contact_id":   contact["id"],
                "contact_name": contact["name"],
                "status":       "linked_contact",
                "resolved_at":  now,
                "resolved_by":  user.get("id"),
            }},
            upsert=False,
        )

    # 4. Post every row.
    r = await db.transactions.update_many(
        {"company_id": cid, "id": {"$in": txn_ids}},
        {"$set": {
            "category_account_id":       acct["id"],
            "category_account_name":     acct["name"],
            "category_source":           "reviewv2::account_transfer_ai",
            "needs_review":              False,
            "posted":                    True,
            "reviewed_at":               now,
            "reviewed_by":               user.get("id"),
            "review_choice":             "account_transfer:ai_book",
            "contact_id":                contact["id"],
            "contact_name":              contact["name"],
            "affiliate_description":     purpose_text or None,
            "awaiting_affiliate_reason": False,
            "updated_at":                now,
        }},
    )
    await db[_LAB_TXNS].update_many(
        {"company_id": cid, "txn_id": {"$in": txn_ids}},
        {"$set": {"verified": True, "review_reason": None,
                   "reviewed_at": now,
                   "review_choice": "account_transfer:ai_book"}},
    )

    # 5. If the owner said "always the same thing", write the learn-many
    # rule keyed on the linked contact so future transfers with this
    # contact auto-book silently.
    if remember_rule:
        await db.lab_feedback.update_one(
            {"company_id": cid, "scope": "account_transfer_contact",
             "contact_id": contact["id"]},
            {"$set": {
                "company_id":            cid,
                "scope":                 "account_transfer_contact",
                "learn":                 True,
                "contact_id":            contact["id"],
                "contact_name":          contact["name"],
                "linked_lab_account":    unknown_account_key,
                "category_account_id":   acct["id"],
                "category_account_name": acct["name"],
                "purpose_text":          purpose_text,
                "created_by":            user.get("id"),
                "updated_at":            now,
            }, "$setOnInsert": {"created_at": now}},
            upsert=True,
        )

    return {
        "ok": True,
        "contact":  {"id": contact["id"], "name": contact["name"]},
        "account":  {"id": acct["id"], "code": acct.get("code"), "name": acct["name"],
                     "is_new": bool(proposal.get("is_new"))},
        "affected": r.modified_count,
        "rule_saved": remember_rule,
    }


@router.get("/companies/{cid}/reviewv2/lab-v3-count")
async def lab_v3_count(cid: str, user: dict = Depends(get_current_user)):
    """Lightweight counter for sidebar badge / cockpit tile / banners.

    ``questions_left`` counts **grouped cards** (distinct
    ``review_card_key`` values, matching the queue's one-answer-teaches-
    many grouping) — NOT raw rows. A single Larry Brown / Waystar card
    can cover many transactions, so counting rows here would over-
    report the workload the user faces. Rows without a card_key fall
    back to the same per-account / per-contact-PFC / per-txn key the
    queue endpoint uses so the two numbers always agree.
    """
    await require_company(user, cid)
    company = await db.companies.find_one(
        {"id": cid}, {"categorization_mode": 1}) or {}
    mode = company.get("categorization_mode") or "standard"

    rows = [r async for r in db.transactions.find(
        {"company_id": cid, "ai_source": "lab_v3"},
        {"id": 1, "amount": 1, "needs_review": 1, "flagged_for_accountant": 1,
         "bank_account_id": 1, "contact_id": 1, "review_reason": 1,
         "merchant": 1, "description": 1},
    )]

    review_ids = [r["id"] for r in rows
                  if r.get("needs_review") and not r.get("flagged_for_accountant")]
    lab_by_txn: dict[str, dict] = {}
    if review_ids:
        async for l in db[_LAB_TXNS].find(
            {"company_id": cid, "txn_id": {"$in": review_ids}},
            {"txn_id": 1, "review_card_key": 1, "contact_id_lab": 1,
             "raw": 1, "review_reason": 1},
        ):
            lab_by_txn[l["txn_id"]] = l

    total = 0.0
    unconfirmed = 0.0
    unconfirmed_rows = 0
    card_keys: set[str] = set()
    for r in rows:
        amt = abs(float(r.get("amount") or 0))
        total += amt
        if not r.get("needs_review") or r.get("flagged_for_accountant"):
            continue
        unconfirmed += amt
        unconfirmed_rows += 1
        lab = lab_by_txn.get(r["id"], {}) or {}
        key = lab.get("review_card_key")
        if not key:
            reason = r.get("review_reason") or lab.get("review_reason") or "uncategorized"
            stage = _LABV3_STAGE_BY_REASON.get(reason, 3)
            if stage == 1:
                key = f"labv3::acct::{r.get('bank_account_id') or 'unknown'}::{reason}"
            elif stage == 2:
                cid_ = lab.get("contact_id_lab") or r.get("contact_id") or "unknown"
                pfc  = ((lab.get("raw") or {}).get("pfc_detailed") or "")
                key = f"labv3::pat::{cid_}::{pfc}::{reason}"
            else:
                # Match the queue's stage-3 merchant+direction grouping.
                merch_key = _canonical_merchant(
                    r.get("description") or "", r.get("merchant") or "",
                ) or "unknown"
                dir_key = "in" if (r.get("amount") or 0) > 0 else "out"
                pfc = ((lab.get("raw") or {}).get("pfc_detailed") or "")
                key = f"labv3::one::{merch_key}::{dir_key}::{pfc}::{reason}"
        card_keys.add(key)

    return {
        "mode":                mode,
        "is_lab_v3":           mode == "lab_v3",
        "questions_left":      len(card_keys),
        "unconfirmed_rows":    unconfirmed_rows,
        "unconfirmed_dollars": round(unconfirmed, 2),
        "total_dollars":       round(total, 2),
        "pct_confirmed":       int(round(100 * (total - unconfirmed) / total)) if total > 0 else 0,
    }


# =========================================================================
# Lab v3 · Auto-handled log + Undo
#
# Backs the "View log to undo any of them" link. Lists every lab-v3-
# stamped row that is currently posted (both AI auto-handled and user-
# answered) so the CPA / owner can un-book any single row without
# hunting through the ledger. Undo is idempotent: sets ``needs_review``
# back to true, clears ``posted`` + review metadata, and puts the row
# back into the queue on the next refresh.
# =========================================================================
@router.get("/companies/{cid}/reviewv2/lab-v3-log")
async def lab_v3_log(cid: str, limit: int = 100, user: dict = Depends(get_current_user)):
    await require_company(user, cid)
    try:
        limit = max(1, min(int(limit), 500))
    except Exception:
        limit = 100
    rows = []
    async for r in db.transactions.find(
        {"company_id": cid, "ai_source": "lab_v3", "posted": True},
        {"id": 1, "date": 1, "amount": 1, "merchant": 1, "description": 1,
         "category_account_id": 1, "category_account_name": 1,
         "category_source": 1, "review_choice": 1, "reviewed_at": 1,
         "reviewed_by": 1, "updated_at": 1, "affiliate_name": 1},
    ).sort([("reviewed_at", -1), ("updated_at", -1)]).limit(limit):
        rows.append({
            "id":             r.get("id"),
            "date":           r.get("date"),
            "amount":         r.get("amount"),
            "merchant":       r.get("merchant"),
            "description":    r.get("description"),
            "category_id":    r.get("category_account_id"),
            "category":       r.get("category_account_name"),
            "source":         r.get("category_source"),
            "review_choice":  r.get("review_choice"),
            "affiliate_name": r.get("affiliate_name"),
            "reviewed_at":    r.get("reviewed_at"),
            # "AI auto" if there was no user review_choice — pure
            # pipeline auto-handling. Otherwise "answered".
            "kind":           "answered" if r.get("review_choice") else "auto",
        })
    return {"rows": rows, "count": len(rows)}


@router.post("/companies/{cid}/reviewv2/lab-v3-undo")
async def lab_v3_undo(
    cid: str, payload: dict = Body(...),
    user: dict = Depends(get_current_user),
):
    """Reverse a single lab_v3 row's booking. Idempotent.

    Body: ``{txn_id: str}``.
    """
    await require_company(user, cid)
    txn_id = (payload.get("txn_id") or "").strip()
    if not txn_id:
        raise HTTPException(400, "txn_id required")
    now = datetime.now(timezone.utc).isoformat()

    r = await db.transactions.update_one(
        {"company_id": cid, "id": txn_id, "ai_source": "lab_v3"},
        {"$set": {"needs_review":  True,
                   "posted":        False,
                   "updated_at":    now,
                   "undone_at":     now,
                   "undone_by":     user.get("id")},
         "$unset": {"reviewed_at":            "",
                    "reviewed_by":            "",
                    "review_choice":          "",
                    "category_account_id":    "",
                    "category_account_name":  "",
                    "category_source":        "",
                    "flagged_for_accountant": "",
                    "flagged_reason":         "",
                    "flagged_note":           "",
                    "flagged_at":             "",
                    "affiliate_name":         "",
                    "affiliate_description":  "",
                    "affiliate_reasoning":    ""}},
    )
    # Mirror onto lab_transactions so re-runs see the row as unresolved.
    await db[_LAB_TXNS].update_one(
        {"company_id": cid, "txn_id": txn_id},
        {"$set":   {"verified": False},
         "$unset": {"reviewed_at": "", "review_choice": ""}},
    )
    return {"ok": True, "modified": r.modified_count}



# =========================================================================
# Relationship → Sub-account proposal (Stage 2 mixed card)
#
# When the user picks a relationship pill (Customer / Contractor / Owner
# or family / Lender / Something else), the AI reads THIS company's
# actual CoA and picks:
#   1. The right parent bucket for the relationship (e.g. Loans Payable
#      for a lender, Accounts Receivable for a customer). Semantic match,
#      not hardcoded names — respects however this company labels the
#      account (Notes Payable, LT Debt, A/R — Trade, etc).
#   2. An existing sub-account under that parent whose name matches
#      the contact (e.g. Audi, Rocket Mortgage) — semantic, not string.
#   3. If no existing sub matches, proposes a NEW sub-account named
#      after the contact with the next-free code under the parent.
#   4. If the parent bucket itself doesn't exist, proposes creating
#      both the parent and the sub.
# =========================================================================
_RELATIONSHIP_SYSTEM = (
    "You are an experienced GAAP-aware bookkeeping AI helping categorize "
    "transactions from a specific business's Plaid feed onto their own "
    "Chart of Accounts (CoA).\n\n"
    "Your job: given a Contact (person/business), a Relationship the user "
    "just confirmed (customer, contractor, owner_or_family, lender, or "
    "something_else), a Direction (money_in / money_out / mixed), and the "
    "company's full CoA, pick the best target account.\n\n"
    "Rules:\n"
    "1. Find the PARENT bucket that fits the relationship — semantic match, "
    "not exact string. Lender → Loans Payable / Notes Payable / LT Debt. "
    "Customer → Accounts Receivable / A/R / Trade Receivables. Contractor → "
    "Contract Labor / Consulting Expense / 1099 Contractors. Owner or family → "
    "Owner's Draw / Owner's Distribution / Member Draws. Something_else → "
    "flag_for_cpa=true and skip account selection.\n"
    "2. Look at that parent's existing sub-accounts (child accounts nested "
    "under it, or accounts with codes in the parent's numeric range). Check "
    "if any of them is the SAME entity as the Contact (semantic match: "
    "'Rocket Mortgage' matches 'Rocket Mortgage LLC', 'Audi' matches 'Audi "
    "Financial Services', but a person's name 'Larry Brown' does NOT match "
    "'Rocket Mortgage'). If yes, book to that existing sub.\n"
    "3. If no sub matches, propose creating a NEW sub-account named after "
    "the Contact using the naming style of the existing subs (bare name if "
    "the pattern is 'Audi', 'Rocket Mortgage'; add suffix only if the pattern "
    "shows suffixes). Assign the next free code inside the parent's range "
    "(step 10 by default: 2510, 2520, 2530 → next 2540 or higher).\n"
    "4. If the parent bucket itself is not in the CoA, propose creating the "
    "parent too (set new_parent = true and pick a canonical name + starting "
    "code that fits the standard CoA structure).\n"
    "5. When the direction is mixed and the relationship is lender, keep "
    "it simple: book both directions to the same sub-account (principal is "
    "the netting mechanism). Flag_for_cpa=true so the accountant knows to "
    "split principal vs interest later.\n\n"
    "Return ONLY strict JSON with these keys:\n"
    "  parent_account_id     - existing account id, OR null if new\n"
    "  parent_account_code   - code of the chosen parent (existing or new)\n"
    "  parent_account_name   - name of the parent (existing or new)\n"
    "  parent_is_new         - true if you're proposing to create the parent\n"
    "  parent_type           - 'asset' | 'liability' | 'equity' | 'expense' | 'revenue' — required when parent_is_new\n"
    "  sub_account_id        - existing sub id, OR null if new\n"
    "  sub_account_code      - proposed code for the sub (existing or new)\n"
    "  sub_account_name      - bare contact name, cleaned (no ALL CAPS, no channel noise)\n"
    "  sub_is_new            - true if you're proposing to create the sub\n"
    "  reason                - one short sentence explaining why this fit\n"
    "  confidence            - 0..1\n"
    "  flag_for_cpa          - true if this needs an accountant's second look\n"
)


@router.post("/companies/{cid}/reviewv2/relationship-propose")
async def relationship_propose(
    cid: str, payload: dict = Body(...),
    user: dict = Depends(get_current_user),
):
    """Propose a target sub-account for a relationship confirmation."""
    await require_company(user, cid)
    contact_name = (payload.get("contact_name") or "").strip()
    relationship = (payload.get("relationship") or "").strip().lower()
    direction    = (payload.get("direction") or "mixed").strip().lower()
    if not contact_name or not relationship:
        raise HTTPException(400, "contact_name and relationship required")

    # something_else → skip AI; just flag for CPA.
    if relationship == "something_else":
        return {
            "ok": True, "flag_for_cpa": True,
            "reason": "Ambiguous relationship — flagged for accountant review.",
        }

    # Load the company's CoA (compact so we can pack it into the prompt).
    coa = []
    async for a in db.accounts.find(
        {"company_id": cid, "active": {"$ne": False}},
        {"id": 1, "code": 1, "name": 1, "type": 1, "subtype": 1,
         "parent_account_id": 1},
    ).limit(300):
        coa.append({
            "id":     a.get("id"),
            "code":   str(a.get("code") or ""),
            "name":   a.get("name"),
            "type":   a.get("type"),
            "subtype": a.get("subtype"),
            "parent_id": a.get("parent_account_id"),
        })
    coa.sort(key=lambda x: (x.get("code") or "zzz"))

    # Build the prompt.
    def _fmt_row(r):
        parts = [f"  {r['code'] or '—'}  {r['name']}  ({r['type']}"]
        if r.get("subtype"):
            parts.append(f"/{r['subtype']}")
        if r.get("parent_id"):
            parts.append(f", parent={r['parent_id'][:8]}")
        parts.append(")")
        return "".join(parts)
    coa_text = "\n".join(_fmt_row(r) for r in coa)
    prompt = (
        f"Company Chart of Accounts ({len(coa)} accounts):\n{coa_text}\n\n"
        f"Contact:      {contact_name}\n"
        f"Relationship: {relationship}\n"
        f"Direction:    {direction}\n\n"
        "Return the JSON now."
    )

    chat = _new_chat(_RELATIONSHIP_SYSTEM, f"rv2r-{cid}",
                     feature="reviewv2-relationship-propose", company_id=cid)
    text = ""
    try:
        async for ev in chat.stream_message(UserMessage(text=prompt)):
            if isinstance(ev, TextDelta):
                text += ev.content
            elif isinstance(ev, StreamDone):
                break
    except Exception as e:
        raise HTTPException(500, f"AI proposal failed: {e}")

    m = re.search(r"\{[\s\S]*\}", text)
    if not m:
        return {"ok": False, "raw": text,
                "reason": "AI didn't return a parseable JSON proposal."}
    try:
        parsed = json.loads(m.group(0))
    except Exception:
        return {"ok": False, "raw": text, "reason": "AI response was not valid JSON."}

    parsed["ok"] = True
    return parsed


# ------------------------------------------------------------------
# Relationship-book: user confirmed the AI's sub-account proposal.
# ------------------------------------------------------------------
@router.post("/companies/{cid}/reviewv2/relationship-book")
async def relationship_book(
    cid: str, payload: dict = Body(...),
    user: dict = Depends(get_current_user),
):
    """Book rows to the AI-proposed sub-account (create parent + sub if
    they don't exist yet)."""
    await require_company(user, cid)
    txn_ids = payload.get("txn_ids") or []
    if not txn_ids:
        raise HTTPException(400, "txn_ids required")
    proposal = payload.get("proposal") or {}
    if not proposal:
        raise HTTPException(400, "proposal required")
    contact_id   = payload.get("contact_id")
    contact_name = (payload.get("contact_name") or "").strip()
    relationship = (payload.get("relationship") or "").strip().lower()
    now = datetime.now(timezone.utc).isoformat()

    # 1. Resolve or create the parent.
    parent = None
    pid = proposal.get("parent_account_id")
    if pid:
        parent = await db.accounts.find_one({"company_id": cid, "id": pid})
        if not parent:
            # AI sometimes echoes the code as the id — fall back to
            # a code lookup so we don't create a duplicate parent.
            parent = await db.accounts.find_one({"company_id": cid, "code": str(pid)})
    if not parent and proposal.get("parent_account_code"):
        parent = await db.accounts.find_one({
            "company_id": cid, "code": str(proposal["parent_account_code"])})
    if not parent and proposal.get("parent_is_new"):
        parent = await _resolve_or_create_account(
            cid,
            template={
                "name":    proposal.get("parent_account_name") or "Loans Payable",
                "type":    proposal.get("parent_type") or "liability",
                "subtype": None,
                "code":    int(proposal.get("parent_account_code") or 2500),
            },
            affiliate="",
            source_row={},
        )
    if not parent:
        raise HTTPException(400, "Could not resolve parent account.")

    # 2. Resolve or create the sub.
    sub = None
    if proposal.get("sub_account_id"):
        sub = await db.accounts.find_one(
            {"company_id": cid, "id": proposal["sub_account_id"]})
    if not sub:
        sub_name = (proposal.get("sub_account_name") or contact_name).strip() or "New Sub"
        # Look for an existing account by name under the same parent.
        sub = await db.accounts.find_one({
            "company_id": cid,
            "parent_account_id": parent["id"],
            "$expr": {"$eq": [{"$toLower": "$name"}, sub_name.lower()]},
        })
        if not sub:
            # Compute next-free code inside the parent's numeric range.
            parent_code = str(parent.get("code") or "").strip()
            if parent_code.isdigit():
                start = int(parent_code) + 10
                used = set()
                async for a in db.accounts.find(
                    {"company_id": cid, "code": {"$regex": f"^{parent_code[:2]}"}},
                    {"code": 1},
                ):
                    c = str(a.get("code") or "").strip()
                    if c.isdigit():
                        used.add(int(c))
                code = start
                while code in used:
                    code += 10
            else:
                code = int(proposal.get("sub_account_code") or 9999)
            sub = {
                "id":               str(uuid4()),
                "company_id":       cid,
                "code":             str(code),
                "name":             sub_name,
                "type":             parent.get("type"),
                "subtype":          parent.get("subtype"),
                "parent_account_id": parent["id"],
                "active":           True,
                "balance":          0.0,
                "created_by_ai":    True,
                "system_generated": True,
                "source":           "reviewv2::relationship_sub",
                "created_at":       now,
                "updated_at":       now,
            }
            await db.accounts.insert_one(sub)

    # 3. Post every row to the sub.
    r = await db.transactions.update_many(
        {"company_id": cid, "id": {"$in": txn_ids}},
        {"$set": {
            "category_account_id":   sub["id"],
            "category_account_name": sub["name"],
            "category_source":       "reviewv2::relationship_sub_ai",
            "needs_review":          False,
            "posted":                True,
            "reviewed_at":           now,
            "reviewed_by":           user.get("id"),
            "review_choice":         f"relationship:{relationship}",
            "contact_relationship":  relationship,
            "updated_at":            now,
        }},
    )
    await db[_LAB_TXNS].update_many(
        {"company_id": cid, "txn_id": {"$in": txn_ids}},
        {"$set": {"verified": True, "review_reason": None,
                   "reviewed_at": now,
                   "review_choice": f"relationship:{relationship}"}},
    )

    # 4. Learn-many: (company, contact, relationship) → sub id.
    if contact_id:
        await db.lab_feedback.update_one(
            {"company_id": cid, "scope": "relationship_sub",
             "contact_id": contact_id, "relationship": relationship},
            {"$set": {
                "company_id":            cid,
                "scope":                 "relationship_sub",
                "learn":                 True,
                "contact_id":            contact_id,
                "relationship":          relationship,
                "sub_account_id":        sub["id"],
                "sub_account_name":      sub["name"],
                "parent_account_id":     parent["id"],
                "parent_account_name":   parent["name"],
                "created_by":            user.get("id"),
                "updated_at":            now,
            }, "$setOnInsert": {"created_at": now}},
            upsert=True,
        )

    return {
        "ok": True,
        "parent":  {"id": parent["id"], "code": parent.get("code"), "name": parent["name"]},
        "sub":     {"id": sub["id"],    "code": sub.get("code"),    "name": sub["name"],
                    "is_new": sub.get("source") == "reviewv2::relationship_sub"},
        "affected": r.modified_count,
    }


# =========================================================================
# Chat Review — light-theme companion to the 1/2/3 Set Up: Review Books
# checklist. Standard-mode only (Lab v3 companies use ReviewV2Lab).
#
# Three sections, each grouped for one-question-books-many:
#   • No Category — rows with a contact but no category. Grouped by
#     (contact_id, direction). Bidirectional contacts split into two
#     cards so the CPA can answer "Romeo's deposits" separately from
#     "payments to Romeo".
#   • Transactions — no-contact rows (not checks). Grouped by
#     `_desc_group_key(description)` + direction. Card 2 first asks if a
#     specific contact owns the group, then the AI proposes a category.
#   • Checks — one card per unassigned check (uses is_check_transaction).
#
# Endpoints:
#   GET  /reviewv2/chat-review-queue  → 3 sections + progress
#   POST /reviewv2/chat-review-book   → books rows (contact + category,
#                                        optional save-as-rule)
# =========================================================================
from routes.check_review import is_check_transaction as _is_check_txn
from routes.transactions import _desc_group_key as _desc_key


def _chat_direction(amt: float) -> str:
    return "in" if (amt or 0) > 0 else "out"


@router.get("/companies/{cid}/reviewv2/chat-review-queue")
async def chat_review_queue(cid: str, user: dict = Depends(get_current_user)):
    """Return grouped cards for the chat-style Review Books flow."""
    await require_company(user, cid)

    # Load contacts + accounts for label lookups
    contacts_by_id: dict[str, dict] = {}
    async for c in db.contacts.find({"company_id": cid},
            {"_id": 0, "id": 1, "name": 1, "display_name": 1, "type": 1}):
        contacts_by_id[c["id"]] = c

    # "Uncategorized"-shaped accounts. A row pointing here counts as
    # no-category even though technically the field is filled.
    uncat_ids: set[str] = set()
    async for a in db.accounts.find({"company_id": cid,
            "name": {"$regex": "^Uncategorized", "$options": "i"}},
            {"_id": 0, "id": 1}):
        uncat_ids.add(a["id"])

    def _is_no_category(r: dict) -> bool:
        cat = r.get("category_account_id")
        return (not cat) or (cat in uncat_ids)

    # Every row that still needs review OR has an uncategorized/empty
    # category target — the union of the Step 2/3 buckets.
    rows: list[dict] = []
    async for r in db.transactions.find({
        "company_id": cid,
        "$or": [
            {"needs_review": True},
            {"category_account_id": {"$in": [None, ""] + list(uncat_ids)}},
        ],
    }, {"_id": 0, "id": 1, "date": 1, "amount": 1, "description": 1,
         "merchant": 1, "contact_id": 1, "contact_name": 1,
         "category_account_id": 1, "bank_account_id": 1, "bank_account_name": 1,
         "plaid_metadata": 1, "raw": 1, "txn_type": 1, "check_number": 1,
         "number": 1, "memo": 1, "not_a_check_reviewed": 1, "posted": 1,
         "human_reviewed": 1, "needs_review": 1}):
        rows.append(r)

    # ---- Bucket rows into 3 sections --------------------------------------
    no_cat_groups: dict[tuple[str, str], list[dict]] = defaultdict(list)
    txn_groups:    dict[tuple[str, str], list[dict]] = defaultdict(list)
    check_rows:    list[tuple[dict, str]] = []

    for r in rows:
        # Fully-booked rows (human-reviewed with real category) → skip.
        if r.get("human_reviewed") and not _is_no_category(r) and not r.get("needs_review"):
            continue
        is_check, signal = _is_check_txn(r)
        no_cat = _is_no_category(r)
        if is_check and no_cat:
            check_rows.append((r, signal))
            continue
        direction = _chat_direction(r.get("amount"))
        contact_id = r.get("contact_id")
        if contact_id and no_cat:
            no_cat_groups[(contact_id, direction)].append(r)
        elif not contact_id and no_cat:
            key, _label = _desc_key(r.get("description") or "")
            txn_groups[(key, direction)].append(r)

    # ---- No Category cards -----------------------------------------------
    no_category: list[dict] = []
    for (contact_id, direction), grp in no_cat_groups.items():
        c = contacts_by_id.get(contact_id) or {}
        name = c.get("display_name") or c.get("name") or "Unnamed contact"
        total = round(sum(abs(float(r.get("amount") or 0)) for r in grp), 2)
        no_category.append({
            "card_key":      f"chat::nocat::{contact_id}::{direction}",
            "kind":          "no_category",
            "contact_id":    contact_id,
            "contact_name":  name,
            "direction":     direction,
            "count":         len(grp),
            "total_dollars": total,
            "txn_ids":       [r["id"] for r in grp],
            "prompt": (
                f"Tell me about {name}'s deposits"
                if direction == "in"
                else f"Tell me about payments to {name}"
            ),
            "samples": [{"id":     r["id"],
                          "date":   r.get("date"),
                          "amount": abs(float(r.get("amount") or 0)),
                          "amount_raw": float(r.get("amount") or 0),
                          "contact_id": r.get("contact_id") or contact_id,
                          "desc":   r.get("description") or r.get("merchant")}
                        for r in sorted(grp, key=lambda x: (x.get("date") or ""),
                                        reverse=True)[:200]],
            "context_row": {
                "date":        grp[0].get("date"),
                "amount":      grp[0].get("amount"),
                "description": grp[0].get("description"),
                "merchant":    grp[0].get("merchant"),
                "account":     grp[0].get("bank_account_name"),
            },
        })
    no_category.sort(key=lambda x: x["total_dollars"], reverse=True)

    # ---- Transactions cards ----------------------------------------------
    transactions: list[dict] = []
    for (group_key, direction), grp in txn_groups.items():
        _k, label = _desc_key(grp[0].get("description") or "")
        total = round(sum(abs(float(r.get("amount") or 0)) for r in grp), 2)
        transactions.append({
            "card_key":      f"chat::txn::{group_key}::{direction}",
            "kind":          "transactions",
            "group_key":     group_key,
            "group_label":   label,
            "direction":     direction,
            "count":         len(grp),
            "total_dollars": total,
            "txn_ids":       [r["id"] for r in grp],
            "prompt": (
                f"Tell me about deposits from {label}"
                if direction == "in"
                else f"Tell me about payments to {label}"
            ),
            "contact_question": f"Is there one specific contact for {label}?",
            "samples": [{"id":     r["id"],
                          "date":   r.get("date"),
                          "amount": abs(float(r.get("amount") or 0)),
                          "amount_raw": float(r.get("amount") or 0),
                          "contact_id": r.get("contact_id"),
                          "desc":   r.get("description") or r.get("merchant")}
                        for r in sorted(grp, key=lambda x: (x.get("date") or ""),
                                        reverse=True)[:200]],
            "context_row": {
                "date":        grp[0].get("date"),
                "amount":      grp[0].get("amount"),
                "description": grp[0].get("description"),
                "merchant":    grp[0].get("merchant"),
                "account":     grp[0].get("bank_account_name"),
            },
        })
    transactions.sort(key=lambda x: x["total_dollars"], reverse=True)

    # ---- Check cards ------------------------------------------------------
    checks: list[dict] = []
    for r, signal in check_rows:
        amt = abs(float(r.get("amount") or 0))
        pm = r.get("plaid_metadata") or {}
        number = (r.get("check_number") or r.get("number")
                   or (pm.get("payment_meta") or {}).get("reference_number") or "")
        # Extract from description if empty (e.g. "check#1042 …")
        if not number:
            m = re.search(r"(?:check|ck)\s*#?\s*(\d+)", r.get("description") or "", re.I)
            if m:
                number = m.group(1)
        checks.append({
            "card_key":       f"chat::chk::{r['id']}",
            "kind":           "checks",
            "txn_id":         r["id"],
            "check_number":   str(number) if number else "",
            "date":           r.get("date"),
            "amount":         amt,
            "description":    r.get("description"),
            "memo":           r.get("memo") or "",
            "detection_signal": signal,
            "prompt":         "Who was the payee and what was the check for?",
            "context_row": {
                "date":        r.get("date"),
                "amount":      r.get("amount"),
                "description": r.get("description"),
                "merchant":    r.get("merchant"),
                "account":     r.get("bank_account_name"),
            },
        })
    checks.sort(key=lambda x: x["amount"], reverse=True)

    # ---- Progress ---------------------------------------------------------
    all_rows_count = await db.transactions.count_documents({"company_id": cid})
    total_dollars = 0.0
    unconfirmed_dollars = 0.0
    async for r in db.transactions.find({"company_id": cid},
            {"amount": 1, "posted": 1, "needs_review": 1,
             "category_account_id": 1}):
        amt = abs(float(r.get("amount") or 0))
        total_dollars += amt
        cat = r.get("category_account_id")
        if (not cat) or (cat in uncat_ids) or r.get("needs_review"):
            unconfirmed_dollars += amt
    pct = int(round(100 * (total_dollars - unconfirmed_dollars) / total_dollars)) \
        if total_dollars > 0 else 100

    return {
        "mode": "chat_review",
        "no_category": no_category,
        "transactions": transactions,
        "checks": checks,
        "progress": {
            "pct_confirmed":       pct,
            "questions_left":      len(no_category) + len(transactions) + len(checks),
            "total_dollars":       round(total_dollars, 2),
            "unconfirmed_dollars": round(unconfirmed_dollars, 2),
        },
        "scanned":         all_rows_count,
    }


@router.post("/companies/{cid}/reviewv2/chat-review-book")
async def chat_review_book(
    cid: str,
    payload: dict = Body(...),
    user: dict = Depends(get_current_user),
):
    """Book all rows in a chat-review card. Body:
      {
        "card_kind":            "no_category" | "transactions" | "checks",
        "card_key":             str,
        "txn_ids":              [str, ...],
        "category_account_id":  str,
        "contact_id":           str | null,        # Transactions cards
        "save_as_rule":         bool,              # optional
        "note":                 str | null,        # optional
      }
    """
    await require_company(user, cid)
    kind = (payload.get("card_kind") or "").strip()
    txn_ids = payload.get("txn_ids") or []
    category_account_id = payload.get("category_account_id")
    contact_id = payload.get("contact_id")
    save_rule = bool(payload.get("save_as_rule"))
    if not kind or not txn_ids or not category_account_id:
        raise HTTPException(400, "card_kind, txn_ids, category_account_id required")

    now = datetime.now(timezone.utc).isoformat()

    # Fetch category account for stamped name/code + validation.
    acct = await db.accounts.find_one(
        {"id": category_account_id, "company_id": cid},
        {"_id": 0, "id": 1, "name": 1, "code": 1})
    if not acct:
        raise HTTPException(400, f"Unknown category_account_id {category_account_id}")

    set_doc: dict = {
        "category_account_id":   acct["id"],
        "category_account_name": acct.get("name"),
        "category_account_code": acct.get("code"),
        "ai_source":             "chat_review",
        "human_reviewed":        True,
        "needs_review":          False,
        "posted":                True,
        "updated_at":            now,
    }
    if contact_id:
        c = await db.contacts.find_one(
            {"id": contact_id, "company_id": cid},
            {"_id": 0, "id": 1, "name": 1, "display_name": 1})
        if not c:
            raise HTTPException(400, f"Unknown contact_id {contact_id}")
        set_doc["contact_id"]   = c["id"]
        set_doc["contact_name"] = c.get("display_name") or c.get("name")

    r = await db.transactions.update_many(
        {"company_id": cid, "id": {"$in": txn_ids}},
        {"$set": set_doc},
    )

    # Optional rule save — per-contact-direction for no_category, per-group
    # for transactions cards. Reuse the reviewv2 rules collection.
    rule_saved = False
    if save_rule:
        if kind == "no_category" and contact_id:
            await db.rules.update_one(
                {"company_id": cid, "kind": "contact_direction",
                 "contact_id": contact_id,
                 "direction": ("in" if payload.get("direction") == "in" else "out")},
                {"$set": {"category_account_id": acct["id"],
                          "updated_at": now, "source": "chat_review"},
                 "$setOnInsert": {"created_at": now, "created_by": user.get("id")}},
                upsert=True,
            )
            rule_saved = True
        elif kind == "transactions" and payload.get("group_key"):
            await db.rules.update_one(
                {"company_id": cid, "kind": "desc_group_direction",
                 "group_key": payload["group_key"],
                 "direction": ("in" if payload.get("direction") == "in" else "out")},
                {"$set": {"category_account_id": acct["id"],
                          "contact_id": contact_id,
                          "updated_at": now, "source": "chat_review"},
                 "$setOnInsert": {"created_at": now, "created_by": user.get("id")}},
                upsert=True,
            )
            rule_saved = True

    return {
        "ok":         True,
        "affected":   r.modified_count,
        "rule_saved": rule_saved,
        "card_kind":  kind,
    }

# =========================================================================
# Voice dictation — Whisper transcription for the Chat Review mic button
# and any other reviewv2 chat input. Accepts a multipart audio blob
# (webm/opus from browser MediaRecorder is the common case) and returns
# `{ok, text}`. Uses the OpenAI whisper-1 model via emergentintegrations
# so it works with EMERGENT_LLM_KEY out of the box.
# =========================================================================
@router.post("/reviewv2/transcribe")
async def reviewv2_transcribe(
    audio: UploadFile = File(...),
    user: dict = Depends(get_current_user),
):
    """Transcribe a short audio clip to plain text."""
    key = os.getenv("EMERGENT_LLM_KEY") or os.getenv("OPENAI_API_KEY")
    if not key:
        raise HTTPException(500, "EMERGENT_LLM_KEY not configured")

    raw = await audio.read()
    if not raw:
        raise HTTPException(400, "empty audio upload")
    if len(raw) > 24 * 1024 * 1024:                   # Whisper cap is 25 MB
        raise HTTPException(413, "audio too large — please keep clips under 24 MB")

    # Wrap in a BytesIO so the SDK can stream it. The filename we give
    # the SDK sets the perceived container — the browser sends webm/opus
    # by default, so we advertise ".webm" unless a caller overrode it.
    name = audio.filename or "clip.webm"
    if "." not in name:
        name += ".webm"
    buf = io.BytesIO(raw)
    buf.name = name

    try:
        from emergentintegrations.llm.openai import OpenAISpeechToText
        stt = OpenAISpeechToText(api_key=key)
        resp = await stt.transcribe(file=buf, model="whisper-1",
                                     response_format="text", language="en")
    except Exception as e:
        _logger.exception("reviewv2_transcribe: whisper call failed")
        raise HTTPException(502, f"transcription failed: {e}")

    # `response_format="text"` returns a plain string (or an object whose
    # str() is the text) depending on the SDK version — normalize.
    text = getattr(resp, "text", None) or (resp if isinstance(resp, str) else str(resp))
    return {"ok": True, "text": (text or "").strip()}

