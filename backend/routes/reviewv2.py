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
from fastapi import APIRouter, Depends, HTTPException, Body
from collections import defaultdict

from db import db
from auth import get_current_user
from deps import require_company
from ai_service import _new_chat
from llm_client import UserMessage, TextDelta, StreamDone
import json, re

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
    txns = [t async for t in db.transactions.find({
        "company_id": cid,
        "date":       {"$gte": since},
    }).limit(2000)]

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
    shadow_diffs = await _shadow_summarize(cid, since_iso=since)

    # LLM usage stats — take the more expensive pass (candidates) if run.
    llm_usage = primary_cls.stats.as_dict()

    return {
        "gated":             False,
        "include":           include,
        "window_days":       config["window_days"],
        "scanned":           len(txns),
        "connected_account_count": len(connected_ids),
        "buckets_by_include": buckets_by_include,
        "sample_verified":   sample_verified,
        "sample_fits_false": sample_fits_false,
        "top_review_reasons": top_review_reasons,
        "new_candidates":    primary_cls.new_candidates[:200],
        "paypal_ids":        paypal_ids,
        "other_bank_paypal_rows": primary_cls.other_bank_paypal_rows[:20],
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
