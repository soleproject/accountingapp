"""Per-account Plaid connect flow: maps a Plaid account to a ledger bank account,
posts an opening-balance JE from the earliest-txn snapshot, imports full Plaid
history, and enforces source-of-truth dedup (QBO > Plaid > Veryfi).

Called from server.py. All DB access goes through the shared `db` motor client.
"""
from __future__ import annotations
import uuid
from datetime import date, timedelta, datetime, timezone
from typing import Optional

from db import db, now_iso
import plaid_service


# Higher-precedence sources always win. Lower number = higher priority.
SOURCE_PRIORITY = {
    "qbo": 1,
    "plaid": 2, "plaid_mock": 2,
    "veryfi": 3, "veryfi_mock": 3,
    "manual": 5,
}


# Plaid subtype (as returned by Plaid, string) → (ledger code, ledger name, type, subtype)
SUBTYPE_MAP = {
    "AccountSubtype('checking')":     ("1010", "Business Checking", "asset", "current_asset"),
    "checking":                       ("1010", "Business Checking", "asset", "current_asset"),
    "AccountSubtype('savings')":      ("1020", "Business Savings", "asset", "current_asset"),
    "savings":                        ("1020", "Business Savings", "asset", "current_asset"),
    "AccountSubtype('money market')": ("1030", "Money Market", "asset", "current_asset"),
    "money market":                   ("1030", "Money Market", "asset", "current_asset"),
    "money_market":                   ("1030", "Money Market", "asset", "current_asset"),
    "AccountSubtype('cd')":           ("1040", "Certificate of Deposit", "asset", "current_asset"),
    "cd":                             ("1040", "Certificate of Deposit", "asset", "current_asset"),
    "AccountSubtype('credit card')":  ("2100", "Credit Card Payable", "liability", "current_liability"),
    "credit card":                    ("2100", "Credit Card Payable", "liability", "current_liability"),
    "credit_card":                    ("2100", "Credit Card Payable", "liability", "current_liability"),
    "AccountSubtype('paypal')":       ("1050", "PayPal Wallet", "asset", "current_asset"),
    "paypal":                         ("1050", "PayPal Wallet", "asset", "current_asset"),
}


async def _ensure_account(cid: str, code: str, name: str, acct_type: str, subtype: str) -> dict:
    """Look up ledger account by code within company; create it if missing."""
    a = await db.accounts.find_one({"company_id": cid, "code": code})
    if a:
        return a
    doc = {
        "id": str(uuid.uuid4()), "company_id": cid,
        "code": code, "name": name, "type": acct_type, "subtype": subtype,
        "created_at": now_iso(), "updated_at": now_iso(),
    }
    await db.accounts.insert_one(doc)
    return doc


async def ensure_opening_balance_equity(cid: str) -> dict:
    """3050 Opening Balance Equity — auto-created per company on first use."""
    return await _ensure_account(cid, "3050", "Opening Balance Equity", "equity", "equity")


def resolve_ledger_for_plaid(plaid_account: dict) -> tuple[str, str, str, str]:
    """Return (code, name, type, subtype) for the ledger account that should back
    a given Plaid account. Falls back to a generic Other Bank Account (1090) when
    the subtype is unknown.
    """
    key = (plaid_account.get("subtype") or "").lower().strip()
    if key in SUBTYPE_MAP:
        return SUBTYPE_MAP[key]
    ptype = (plaid_account.get("type") or "").lower()
    if "credit" in ptype:
        return ("2100", "Credit Card Payable", "liability", "current_liability")
    return ("1090", "Other Bank Account", "asset", "current_asset")


async def get_ledger_for_plaid_account(cid: str, plaid_account: dict) -> dict:
    code, name, t, st = resolve_ledger_for_plaid(plaid_account)
    return await _ensure_account(cid, code, name, t, st)


# ---------- Source-of-truth dedup ----------

async def higher_source_ranges(cid: str, bank_account_id: str, incoming_source: str) -> list[tuple[str, str]]:
    """Return date ranges (min, max) for any higher-priority source already
    covering this bank_account. Used to skip incoming txns that fall inside a
    superior source's window.
    """
    if not bank_account_id:
        return []
    incoming_prio = SOURCE_PRIORITY.get(incoming_source, 99)
    higher_sources = [s for s, p in SOURCE_PRIORITY.items() if p < incoming_prio]
    if not higher_sources:
        return []
    pipeline = [
        {"$match": {
            "company_id": cid,
            "bank_account_id": bank_account_id,
            "source": {"$in": higher_sources},
        }},
        {"$group": {"_id": "$source", "min": {"$min": "$date"}, "max": {"$max": "$date"}}},
    ]
    ranges: list[tuple[str, str]] = []
    async for row in db.transactions.aggregate(pipeline):
        if row.get("min") and row.get("max"):
            ranges.append((row["min"], row["max"]))
    return ranges


def in_any_range(d: str, ranges: list[tuple[str, str]]) -> bool:
    return any(a <= d <= b for a, b in ranges)


# ---------- Opening balance JE ----------

def _yesterday_iso(d: str) -> str:
    try:
        dd = date.fromisoformat(d)
        return (dd - timedelta(days=1)).isoformat()
    except Exception:
        return d


async def post_opening_balance_je(
    cid: str, ledger_bank: dict, opening_amount: float, as_of: str, memo: str,
) -> str | None:
    """Post a two-line JE recording the opening balance for the given ledger
    bank account. Returns the JE id (or None if amount is negligible).

    - Asset accounts (checking/savings): Dr bank, Cr Opening Balance Equity
    - Liability accounts (credit card): Dr OBE, Cr liability
    - The sign of `opening_amount` is treated as the display balance:
      positive = normal balance (debit for assets, credit for liabilities).
    """
    if abs(opening_amount) < 0.005:
        return None
    obe = await ensure_opening_balance_equity(cid)
    is_asset = ledger_bank["type"] == "asset"
    if is_asset:
        lines = [
            {"account_id": ledger_bank["id"], "account_code": ledger_bank["code"],
             "account_name": ledger_bank["name"],
             "debit": round(opening_amount, 2), "credit": 0.0,
             "description": memo},
            {"account_id": obe["id"], "account_code": obe["code"],
             "account_name": obe["name"],
             "debit": 0.0, "credit": round(opening_amount, 2),
             "description": memo},
        ]
    else:
        # Liability normal-balance is credit
        lines = [
            {"account_id": obe["id"], "account_code": obe["code"],
             "account_name": obe["name"],
             "debit": round(opening_amount, 2), "credit": 0.0,
             "description": memo},
            {"account_id": ledger_bank["id"], "account_code": ledger_bank["code"],
             "account_name": ledger_bank["name"],
             "debit": 0.0, "credit": round(opening_amount, 2),
             "description": memo},
        ]
    je_id = str(uuid.uuid4())
    await db.journal_entries.insert_one({
        "id": je_id, "company_id": cid,
        "date": as_of,
        "memo": memo,
        "lines": lines,
        "source": "opening_balance",
        "created_at": now_iso(), "updated_at": now_iso(),
    })
    return je_id


# ---------- Full history sync for a single Plaid account ----------

async def categorize_and_insert_plaid_txns(
    cid: str, plaid_txns: list[dict], ledger_bank: dict, coa: list[dict],
    accts: list[dict], categorize_fn, is_period_closed_fn,
    higher_ranges: Optional[list[tuple[str, str]]] = None,
) -> tuple[list[dict], list[dict]]:
    """Categorize + insert a set of already-fetched Plaid txns through the full
    Rocketbooks pipeline (PFC resolver → contact resolution → merchant rules →
    merchant cache → LLM → Uncategorized).

    Shared between:
      - the initial per-account history import (`sync_plaid_history_for_account`)
      - webhook/manual re-syncs from `server._sync_and_import`
    so both paths get identical PFC-primary categorization.
    """
    import merchant_cache  # noqa: F401 — kept for parity/log symmetry
    import categorizer
    import contact_resolver
    import pfc_resolver
    from ai_service import resolve_contact_ai

    if higher_ranges is None:
        higher_ranges = await higher_source_ranges(cid, ledger_bank["id"], "plaid")

    now = now_iso()
    candidates: list[dict] = []
    skipped: list[dict] = []
    for t in plaid_txns:
        if await db.transactions.find_one({
            "company_id": cid, "plaid_transaction_id": t["transaction_id"],
        }):
            continue
        if await is_period_closed_fn(cid, t["date"]):
            skipped.append({"reason": "closed_period", "txn": t})
            continue
        if in_any_range(t["date"], higher_ranges):
            skipped.append({"reason": "superseded_by_higher_source", "txn": t})
            continue
        merchant = t.get("merchant_name") or t.get("name") or "Unknown"
        pfc = t.get("personal_finance_category") if isinstance(t, dict) else None
        pfc_detailed = (pfc or {}).get("detailed")
        candidates.append({
            "plaid_txn": t, "merchant": merchant, "description": t["name"],
            "amount": t["amount"], "merchant_name": t.get("merchant_name"),
            "pfc": pfc, "pfc_primary": (pfc or {}).get("primary"),
            "pfc_detailed": pfc_detailed,
            "date": t["date"],
        })

    if not candidates:
        return [], skipped

    await categorizer.ensure_pfc_support_accounts(cid)
    uncat_exp, uncat_inc = await categorizer.ensure_uncategorized_accounts(cid)

    # ------ Stage 1: PFC resolver (Rocketbooks' resolvePfcCoa) ------
    pfc_results: dict[int, dict] = {}
    for cand in candidates:
        resolved = await pfc_resolver.resolve_pfc_coa(
            cid, cand.get("pfc_detailed"), bank_account_id=ledger_bank["id"],
        )
        cand["pfc_resolved"] = resolved
        # useResolved gate: PFC is treated as final when source is primary or
        # override AND category_account_id is non-null. Additionally, when the
        # classification itself signals a transfer or an inherently unresolvable
        # row (asset_movement / transfer_review / uncategorized), we always
        # honour the resolver's fallback_uncategorized target rather than
        # deferring to the LLM — which would otherwise be tempted to categorize
        # "Online Banking transfer to CHK 6278" as bank account 1010 and create
        # a self-cancelling JE.
        if resolved and resolved.get("category_account_id"):
            take_it = resolved["source"] in ("primary", "override") or (
                resolved.get("classification") in
                ("asset_movement", "transfer_review", "uncategorized")
                and resolved["source"] == "fallback_uncategorized"
            )
            if take_it:
                pfc_results[id(cand)] = resolved

    deferred = [c for c in candidates if id(c) not in pfc_results]

    if deferred:
        contact_results = await contact_resolver.resolve_contacts_batch(
            cid, deferred, ai_fallback_fn=resolve_contact_ai, concurrency=5,
        )
        for cand, cr in zip(deferred, contact_results):
            cand["contact_id"] = cr.get("contact_id")
            cand["contact_name"] = cr.get("contact_name")
            cand["contact_source"] = cr.get("source")

    per_item_result = await categorizer.categorize_batch_grouped(
        cid, deferred, coa, categorize_fn, concurrency=10,
    ) if deferred else []
    result_by_id = {id(c): r for c, r in zip(deferred, per_item_result)}

    accts = await db.accounts.find({"company_id": cid}).to_list(2000)  # refresh
    threshold = await categorizer.get_auto_post_threshold(cid)

    inserted: list[dict] = []
    for cand in candidates:
        t = cand["plaid_txn"]
        pfc_res = pfc_results.get(id(cand))
        if pfc_res:
            post = {
                "category_account_id":   pfc_res["category_account_id"],
                "category_account_code": pfc_res["category_account_code"],
                "category_account_name": pfc_res["category_account_name"],
                "ai_confidence": 0.95,
                "ai_reasoning": f"Plaid PFC {cand['pfc_detailed']} → "
                                f"{pfc_res['category_account_name']} "
                                f"(classification={pfc_res['classification']}, source={pfc_res['source']})",
                "needs_review": not pfc_res["reviewed_by_default"],
                "posted": True,
                "ai_source": f"pfc_{pfc_res['source']}",
            }
            r = {"cache_hit": False}
        else:
            r = result_by_id[id(cand)]
            post = categorizer.decide_posting(
                r, threshold, uncat_exp, uncat_inc, accts, cand["amount"],
            )
        inserted.append({
            "id": str(__import__("uuid").uuid4()), "company_id": cid, "date": t["date"],
            "description": t["name"], "merchant": cand["merchant"], "amount": t["amount"],
            "bank_account_id": ledger_bank["id"],
            "bank_account_name": ledger_bank["name"],
            "contact_id": cand.get("contact_id"),
            "contact_name": cand.get("contact_name"),
            "pfc_detailed": cand.get("pfc_detailed"),
            "pfc_primary": cand.get("pfc_primary"),
            "pfc_classification": (pfc_res or {}).get("classification") if pfc_res
                                  else (cand.get("pfc_resolved") or {}).get("classification"),
            **post,
            "human_reviewed": False,
            "source": "plaid",
            "plaid_transaction_id": t["transaction_id"],
            "plaid_account_id": t["account_id"],
            "pending": t.get("pending", False), "splits": [], "linked_invoice_id": None,
            "linked_bill_id": None, "linked_payment_id": None, "tags": [],
            "cache_hit": r.get("cache_hit", False),
            "created_at": now, "updated_at": now,
        })

    # ------ Compute running bank balance ("bank_balance_after") ---------
    # Merges each newly-inserted row with any already-posted rows for the
    # same bank account, then computes a running balance seeded by the
    # opening-balance JE. This is what powers the "Bank Balance" column
    # on the Transactions page.
    if inserted:
        try:
            await db.transactions.insert_many(inserted, ordered=False)
        except Exception:  # noqa: BLE001 — DuplicateKeyError under race
            pass
        await _refresh_bank_balances_for_account(cid, ledger_bank["id"])
    return inserted, skipped


async def _refresh_bank_balances_for_account(company_id: str, bank_id: str) -> None:
    """Recompute `bank_balance_after` for every txn on this bank account.

    Order: `date` ascending, then `created_at` ascending as tie-breaker.
    Seed: sum of journal-entry lines hitting this account (opening balance,
    manual reclassifications). This matches how Cash-on-Hand is calculated in
    `dashboard_metrics`, so the running balance on the last row equals the
    Cash-on-Hand card. Idempotent — safe to re-run.
    """
    # Seed from JEs (opening balance + any manual adjustments)
    seed = 0.0
    async for j in db.journal_entries.find({"company_id": company_id}):
        for l in j.get("lines", []):
            if l.get("account_id") == bank_id:
                seed += float(l.get("debit", 0) or 0) - float(l.get("credit", 0) or 0)

    # Order + accumulate
    running = seed
    async for t in db.transactions.find(
        {"company_id": company_id, "bank_account_id": bank_id, "posted": True},
    ).sort([("date", 1), ("created_at", 1)]):
        running += float(t.get("amount", 0) or 0)
        await db.transactions.update_one(
            {"id": t["id"]},
            {"$set": {"bank_balance_after": round(running, 2)}},
        )


async def sync_plaid_history_for_account(
    cid: str, item: dict, plaid_account_id: str, ledger_bank: dict,
    coa: list[dict], accts: list[dict], categorize_fn, is_period_closed_fn,
) -> tuple[list[dict], list[dict]]:
    """Pull all Plaid txns for the given account_id, dedup, batch-categorize
    with merchant grouping + contact resolution, and insert survivors.
    """
    try:
        synced = plaid_service.sync_transactions(item["access_token"], None)
    except Exception as e:  # noqa: BLE001
        raise RuntimeError(f"Plaid sync error: {e}") from e

    await db.plaid_items.update_one({"id": item["id"]}, {"$set": {
        "cursor": synced["next_cursor"], "updated_at": now_iso(),
    }})

    # Filter to just this account's txns
    account_txns = [t for t in synced["added"] if t["account_id"] == plaid_account_id]
    return await categorize_and_insert_plaid_txns(
        cid, account_txns, ledger_bank, coa, accts,
        categorize_fn, is_period_closed_fn,
    )


# ---------- Whole flow: connect a single Plaid account ----------

async def connect_plaid_account(
    cid: str, item: dict, plaid_account_id: str,
    categorize_fn, is_period_closed_fn,
) -> dict:
    """1) Resolve/create ledger bank account
    2) Re-route any already-imported Plaid txns for this account_id (from a
       legacy bulk-import) onto the correct ledger account
    3) Pull full Plaid history via /transactions/sync (with dedup)
    4) Compute opening balance from the union of pre-existing + newly imported
       txns, then post OBE JE dated the day before the oldest one
    5) Persist mapping on plaid_item
    """
    plaid_accts = item.get("accounts") or []
    plaid_acct = next((a for a in plaid_accts if a.get("account_id") == plaid_account_id), None)
    if not plaid_acct:
        raise ValueError("Plaid account not found on the linked item")

    # Ledger side
    ledger_bank = await get_ledger_for_plaid_account(cid, plaid_acct)

    # --- Re-route pre-existing legacy txns for this Plaid account_id --------
    reroute_res = await db.transactions.update_many(
        {"company_id": cid, "plaid_account_id": plaid_account_id,
         "bank_account_id": {"$ne": ledger_bank["id"]}},
        {"$set": {
            "bank_account_id": ledger_bank["id"],
            "bank_account_name": ledger_bank["name"],
            "updated_at": now_iso(),
        }},
    )
    rerouted = reroute_res.modified_count

    # Preload CoA (after any auto-create)
    accts = await db.accounts.find({"company_id": cid}).to_list(2000)
    coa = [{"code": a["code"], "name": a["name"], "type": a["type"]} for a in accts]

    inserted, skipped = await sync_plaid_history_for_account(
        cid, item, plaid_account_id, ledger_bank, coa, accts,
        categorize_fn, is_period_closed_fn,
    )

    # --- Opening balance -----------------------------------------------------
    # Consider ALL current txns for this Plaid account (rerouted legacy + freshly imported)
    all_for_acct = await db.transactions.find(
        {"company_id": cid, "plaid_account_id": plaid_account_id}
    ).to_list(10000)
    net_movement = sum(float(t.get("amount") or 0) for t in all_for_acct)
    plaid_current = float(plaid_acct.get("balance_current") or 0.0)

    is_liability = ledger_bank["type"] == "liability"
    if is_liability:
        opening = plaid_current + net_movement
    else:
        opening = plaid_current - net_movement
    opening = round(opening, 2)

    # As-of date = day before the oldest txn (any source) for this Plaid account
    if all_for_acct:
        oldest_date = min(t["date"] for t in all_for_acct)
        opening_as_of = _yesterday_iso(oldest_date)
    else:
        opening_as_of = datetime.now(timezone.utc).date().isoformat()

    # Do not double-post opening if one already exists for this ledger account
    existing = await db.journal_entries.find_one({
        "company_id": cid, "source": "opening_balance",
        "lines.account_id": ledger_bank["id"],
    })
    je_id = None
    if not existing:
        memo = f"Opening balance — {plaid_acct.get('name') or ledger_bank['name']}"
        je_id = await post_opening_balance_je(
            cid, ledger_bank, opening, opening_as_of, memo,
        )

    # Persist mapping on the plaid_item document
    mappings = item.get("account_mappings") or {}
    mappings[plaid_account_id] = {
        "ledger_account_id": ledger_bank["id"],
        "ledger_account_code": ledger_bank["code"],
        "ledger_account_name": ledger_bank["name"],
        "opening_balance": opening,
        "opening_as_of": opening_as_of,
        "opening_je_id": je_id or (existing["id"] if existing else None),
        "connected_at": now_iso(),
    }
    await db.plaid_items.update_one(
        {"id": item["id"]},
        {"$set": {"account_mappings": mappings, "updated_at": now_iso()}},
    )

    return {
        "ledger_account_id": ledger_bank["id"],
        "ledger_account_code": ledger_bank["code"],
        "ledger_account_name": ledger_bank["name"],
        "opening_balance": opening,
        "opening_as_of": opening_as_of,
        "opening_je_id": je_id,
        "imported": len(inserted),
        "rerouted": rerouted,
        "skipped": len(skipped),
        "skipped_reasons": [s["reason"] for s in skipped],
    }
