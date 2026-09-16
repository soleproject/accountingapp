"""Lab pipeline runner — orchestrates Steps 1-4 for one company.

Idempotent. Read-only from live collections. Writes ONLY to
``lab_*`` collections. Callable both from the report script and from
the ``POST /companies/{cid}/lab/pipeline/run`` endpoint.
"""
from __future__ import annotations
import logging
import time
from datetime import datetime, timezone
from db import db
from .collections import LAB_TRANSACTIONS
from .settings import get_settings, is_lab_enabled
from .step1_raw import upsert_raw_batch
from .step2_parse import (
    parse_bank_desc, parse_paypal_boa, classify_channel, infer_direction,
)
from .step3_accounts import load_connected_accounts, scan_and_register
from .step4_movement import apply_step4

log = logging.getLogger("axiom.lab.runner")


async def stamp_parse_batch(company_id: str, txns: list[dict],
                             accts_by_id: dict[str, dict]) -> dict:
    """Run Step 2 parsers and stamp results on every ``lab_transactions``
    row. Zero LLM."""
    channels_seen: dict[str, int] = {}
    formats_seen: dict[str, int]  = {}
    paypal_kinds: dict[str, int]  = {}
    for t in txns:
        parsed = parse_bank_desc(t.get("description"))
        acct = accts_by_id.get(t.get("bank_account_id")) or {}
        direction = infer_direction(
            amount=t.get("amount"),
            account_type=acct.get("type"),
        )
        channel = classify_channel(
            description=t.get("description"),
            merchant=t.get("merchant"),
            counterparties=t.get("counterparties"),
            transaction_code=t.get("transaction_code"),
            payment_channel=t.get("payment_channel"),
            check_number=t.get("check_number"),
            parsed=parsed,
        )
        pp = parse_paypal_boa(parsed, amount=t.get("amount"))

        channels_seen[channel] = channels_seen.get(channel, 0) + 1
        formats_seen[parsed.get("format_tag", "unknown")] = \
            formats_seen.get(parsed.get("format_tag", "unknown"), 0) + 1
        if pp:
            paypal_kinds[pp["kind"]] = paypal_kinds.get(pp["kind"], 0) + 1

        await db[LAB_TRANSACTIONS].update_one(
            {"company_id": company_id, "txn_id": t["id"]},
            {"$set": {
                "direction":  direction,
                "channel":    channel,
                "parsed":     parsed,
                "paypal":     pp,
            }},
        )
    return {
        "channels":     channels_seen,
        "formats":      formats_seen,
        "paypal_kinds": paypal_kinds,
    }


async def run_phase1(company_id: str, *, limit: int = 5000) -> dict:
    """Run Steps 1-4 for one company. Idempotent."""
    t0 = time.time()

    # Refuse to run when the flag is off (safety).
    if not await is_lab_enabled(company_id):
        return {"ok": False, "reason": "feature flag OFF"}

    settings = await get_settings(company_id)

    txns = [t async for t in db.transactions.find({"company_id": company_id}).limit(limit)]
    accts_by_id = {a["id"]: a async for a in db.accounts.find({"company_id": company_id})}
    connected = await load_connected_accounts(company_id)

    step1 = await upsert_raw_batch(company_id, txns)
    step3 = await scan_and_register(company_id, txns, connected)
    step2 = await stamp_parse_batch(company_id, txns, accts_by_id)
    step4 = await apply_step4(company_id, txns, connected, settings)

    dates = [t.get("date") for t in txns if t.get("date")]
    run_summary = {
        "ok":                True,
        "company_id":        company_id,
        "scanned":           len(txns),
        "date_range":        {"min": min(dates) if dates else None,
                              "max": max(dates) if dates else None},
        "step1":             step1,
        "step2":             step2,
        "step3":             step3,
        "step4":             step4,
        "settings":          settings,
        "duration_s":        round(time.time() - t0, 3),
        "generated_at":      datetime.now(timezone.utc).isoformat(),
    }
    log.info("lab.runner: phase1 done for %s in %.2fs (%d rows)",
             company_id, run_summary["duration_s"], len(txns))
    return run_summary
