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


# review_reason → stage bucket.
_LABV3_STAGE_BY_REASON = {
    "unknown_account":                1,
    "account_personal_use":           1,
    "affiliate_transfer_reason":      1,  # 2-step follow-up after "Another business"
    "sensitive_first_time":           2,
    "taxable_or_business_expense":    2,
    "uncategorized":                  3,
    "unidentified_counterparty":      3,
}

# Options each stage/reason card offers the client.
_LABV3_OPTIONS_BY_REASON = {
    "unknown_account": [
        {"key": "business",       "label": "Business account"},
        {"key": "personal",       "label": "Personal account"},
        {"key": "another_biz",    "label": "Another business"},
    ],
    "account_personal_use": [
        {"key": "business_only",  "label": "Business only — no personal charges"},
        {"key": "mixed_use",      "label": "Mixed — I use it for both"},
    ],
    # Second-step card after "Another business" — categorizes the
    # related-party transfer so the correct GAAP account is booked.
    "affiliate_transfer_reason": [
        {"key": "loan",            "label": "Loan / cash advance — will be paid back"},
        {"key": "owner_transfer",  "label": "Owner's money moving between entities"},
        {"key": "services",        "label": "Payment for services or goods"},
        {"key": "reimbursement",   "label": "Expense reimbursement / shared bill"},
        {"key": "other",           "label": "Something else — flag for accountant"},
    ],
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
    if reason == "unknown_account":
        return f"Is this account yours?"
    if reason == "account_personal_use":
        return f"Is this account used for personal charges too?"
    if reason == "affiliate_transfer_reason":
        # extra carries `unknown_label` from the group (e.g. "External
        # account ···7984"). Amount is the total across all rows in the
        # group, not the biggest row, so the CPA sees full exposure.
        amt = abs(float((extra or {}).get("total_dollars") or 0))
        label = (extra or {}).get("unknown_label") or "the other account"
        return f"What was this ${amt:,.2f} transfer with {label} for?"
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
            # Fallback: derive from the key pattern (outside_chk_7984 → "···7984").
            if key.startswith("outside_chk_"):
                return f"External account ···{key.split('_')[-1]}"
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
        if not r.get("needs_review"):
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
        # Fallback card_key: bucket by bank account for stage-1 reasons,
        # by contact+reason for stage-2, else by txn id (singletons).
        stage = _LABV3_STAGE_BY_REASON.get(reason, 3)
        card_key = lab.get("review_card_key")
        if not card_key:
            if stage == 1:
                card_key = f"labv3::acct::{r.get('bank_account_id') or 'unknown'}::{reason}"
            elif stage == 2:
                cid_ = lab.get("contact_id_lab") or r.get("contact_id") or "unknown"
                pfc = ((lab.get("raw") or {}).get("pfc_detailed") or "")
                card_key = f"labv3::pat::{cid_}::{pfc}::{reason}"
            else:
                card_key = f"labv3::one::{r['id']}"

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
            unknown_label = (
                _lab_acct_label(unknown_key)
                if reason in ("unknown_account", "affiliate_transfer_reason")
                and unknown_key
                else _acct_label(g.get("bank_account_id"))
            )
            # Rewrite headline for account-side questions so the CPA/
            # owner is unambiguously asked about the destination side.
            if reason == "unknown_account" and unknown_key:
                base_item["question"] = f"Is {unknown_label} yours?"
            elif reason == "affiliate_transfer_reason":
                base_item["question"] = _labv3_question(
                    reason, sample_ctx,
                    {**g, "unknown_label": unknown_label, "total_dollars": group_total},
                )

            stage1.append({
                **base_item,
                "pair_id":       card_key,
                "from":          unknown_label,
                "to":            "(needs your answer)",
                "unknown_account_key": unknown_key,
                "source_account": _acct_label(g.get("bank_account_id")),
                "transfer_count": len(rows_g),
                # Two-step "Another business" flow: this second-step
                # card needs a free-text affiliate-name input to build
                # accounts like "Due from Northgate LLC".
                "needs_affiliate_name": reason == "affiliate_transfer_reason",
                "samples":       [
                    {"date": r.get("date"),
                     "from": _acct_label(r.get("bank_account_id")),
                     "to":   r.get("description") or r.get("merchant") or "—",
                     "amount": abs(float(r.get("amount") or 0))}
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
            stage3.append({
                **base_item,
                "one_off_id":  card_key,
                "kind":        "singleton",
                "merchant":    top.get("merchant") or top.get("description") or "—",
                "description": top.get("description"),
                "amount":      abs(float(top.get("amount") or 0)),
                "date":        top.get("date"),
                "direction":   _labv3_direction(top.get("amount")),
                "context":     sample_ctx,
                "raw_item":    {"context": sample_ctx},
                "prompt":      question,
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
    # Follow-up card answered: user picked WHY the affiliate transfer
    # happened. Auto-create the correct GAAP account (or reuse an
    # existing one), stamp each row with it, and remember the mapping
    # for future rows on the same linked_lab_account.
    # ------------------------------------------------------------------
    if reason == "affiliate_transfer_reason":
        affiliate = (payload.get("affiliate_name") or "").strip() or "Related Party"
        # "Something else" → punt to accountant (same as flag).
        if choice == "other":
            await db.transactions.update_many(
                {"company_id": cid, "id": {"$in": txn_ids}},
                {"$set": {"flagged_for_accountant": True,
                           "flagged_reason": "affiliate_transfer_other",
                           "flagged_note":   f"Affiliate: {affiliate}. {note or ''}".strip(),
                           "flagged_at":     now,
                           "updated_at":     now}},
            )
            return {"ok": True, "action": "flag", "reason": "affiliate_other",
                    "affiliate": affiliate}

        rows = [r async for r in db.transactions.find(
            {"company_id": cid, "id": {"$in": txn_ids}},
            {"id": 1, "amount": 1},
        )]
        acct_cache: dict[tuple[str, str], dict] = {}
        posted = 0
        for r in rows:
            direction = "out" if float(r.get("amount") or 0) < 0 else "in"
            template = _AFFILIATE_ACCOUNT_MAP.get((direction, choice))
            if not template:
                continue
            cache_key = (direction, template["name"].format(affiliate=affiliate))
            acct = acct_cache.get(cache_key)
            if not acct:
                acct = await _resolve_or_create_account(
                    cid, template=template, affiliate=affiliate, source_row=r,
                )
                acct_cache[cache_key] = acct or {}
            if not acct:
                continue
            await db.transactions.update_one(
                {"company_id": cid, "id": r["id"]},
                {"$set": {
                    "category_account_id":   acct["id"],
                    "category_account_name": acct["name"],
                    "category_source":       "reviewv2::related_party",
                    "needs_review":          False,
                    "posted":                True,
                    "reviewed_at":           now,
                    "reviewed_by":           user.get("id"),
                    "review_choice":         f"affiliate:{choice}",
                    "affiliate_name":        affiliate,
                    "awaiting_affiliate_reason": False,
                    "updated_at":            now,
                }},
            )
            posted += 1

        await db[_LAB_TXNS].update_many(
            {"company_id": cid, "txn_id": {"$in": txn_ids}},
            {"$set": {"verified": True, "review_reason": None,
                       "reviewed_at": now, "review_choice": f"affiliate:{choice}"}},
        )

        # Learn-many: remember (linked_lab_account → affiliate + reason)
        # so every future transfer on that outside account auto-books.
        if payload.get("unknown_account_key"):
            await db.lab_feedback.update_one(
                {"company_id":         cid,
                 "scope":              "affiliate_transfer",
                 "linked_lab_account": payload["unknown_account_key"]},
                {"$set": {
                    "company_id":         cid,
                    "scope":              "affiliate_transfer",
                    "learn":              True,
                    "linked_lab_account": payload["unknown_account_key"],
                    "affiliate_name":     affiliate,
                    "choice":             choice,
                    "created_by":         user.get("id"),
                    "updated_at":         now,
                }, "$setOnInsert": {"created_at": now}},
                upsert=True,
            )

        return {"ok": True, "action": "affiliate_transfer_booked",
                "choice": choice, "affiliate": affiliate, "affected": posted}

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
         "bank_account_id": 1, "contact_id": 1, "review_reason": 1},
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
                key = f"labv3::one::{r['id']}"
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
