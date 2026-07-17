"""One-off reprocessor: rerun the extract + pipeline for any statement_imports
that have `veryfi_raw` persisted but `transaction_count == 0`.

Used after the Feb 17, 2026 fix that taught `veryfi_service.extract_transactions`
to look inside `accounts[i].transactions` (Veryfi's current bank-statement
API nests txns there, unlike the older top-level shape).

Idempotent: uses the same `statement_import_id` tag so re-runs just update
counts if the pipeline is invoked again after a partial run.
"""
from __future__ import annotations
import asyncio
import os
import sys

sys.path.insert(0, "/app/backend")
from dotenv import dotenv_values
_env = dotenv_values("/app/backend/.env")
os.environ.setdefault("MONGO_URL", _env["MONGO_URL"].strip('"'))
os.environ.setdefault("DB_NAME",  _env["DB_NAME"].strip('"'))

from datetime import datetime, timezone
from db import db, now_iso
import plaid_connect
import veryfi_service
import statements as _stmts
from ai_activity import log_ai_event
from ai_service import categorize_transaction


async def _is_period_closed(company_id: str, txn_date: str) -> bool:
    doc = await db.fiscal_periods.find_one({
        "company_id": company_id, "status": "closed",
        "start_date": {"$lte": txn_date}, "end_date": {"$gte": txn_date},
    })
    return doc is not None


async def reprocess_one(imp: dict) -> int:
    cid = imp["company_id"]
    veryfi_data = imp.get("veryfi_raw") or {}
    lines = veryfi_service.extract_transactions(veryfi_data)
    if not lines:
        print(f"  → still 0 lines after re-extract (veryfi_raw genuinely empty). Skipping.")
        return 0

    bank_account_id = imp.get("account_id")
    if not bank_account_id:
        print(f"  → no account_id on import, skipping")
        return 0

    higher_ranges = await plaid_connect.higher_source_ranges(cid, bank_account_id, "veryfi")
    accts = await db.accounts.find({"company_id": cid}).to_list(2000)
    coa = [{"code": a["code"], "name": a["name"], "type": a["type"]} for a in accts]
    bank_acct = next((a for a in accts if a["id"] == bank_account_id), None)
    if not bank_acct:
        print(f"  → account {bank_account_id} not found, skipping")
        return 0

    candidates: list[dict] = []
    skipped_dupes = 0
    for ln in lines:
        ln_date = ln["date"] or datetime.now(timezone.utc).date().isoformat()
        if plaid_connect.in_any_range(ln_date, higher_ranges):
            skipped_dupes += 1
            continue
        candidates.append({
            "date": ln_date,
            "description": f"{ln['description']} (Veryfi)",
            "merchant": ln["merchant"],
            "merchant_name": ln["merchant"],
            "amount": ln["amount"],
            "bank_account_id": bank_account_id,
            "bank_account_name": bank_acct["name"],
        })

    if not candidates:
        print(f"  → {len(lines)} extracted but all superseded by Plaid overlap")
        await db.statement_imports.update_one(
            {"id": imp["id"]},
            {"$set": {"transaction_count": 0, "skipped_duplicates": skipped_dupes,
                      "updated_at": now_iso()}},
        )
        return 0

    imported, _skipped_closed = await _stmts._categorize_and_insert_veryfi_lines(
        cid, candidates, bank_acct, coa, accts,
        categorize_fn=categorize_transaction,
        is_period_closed_fn=_is_period_closed,
        import_id=imp["id"],
    )
    await log_ai_event(cid, "veryfi_ocr", imported)

    await db.statement_imports.update_one(
        {"id": imp["id"]},
        {"$set": {"transaction_count": imported, "skipped_duplicates": skipped_dupes,
                  "updated_at": now_iso()}},
    )
    try:
        from infra import get_cache
        await get_cache().ainvalidate(cid)
    except Exception:  # noqa: BLE001
        pass
    return imported


async def main():
    zero_count = db.statement_imports.find({
        "$or": [{"transaction_count": 0}, {"transaction_count": None}],
        "veryfi_raw": {"$exists": True, "$ne": None},
    })
    n = 0
    async for imp in zero_count:
        n += 1
        print(f"[{n}] {imp['id']} · {imp.get('filename')} · company={imp['company_id']}")
        imported = await reprocess_one(imp)
        print(f"  → imported {imported} transactions")
    print(f"\nDone. Processed {n} imports.")


if __name__ == "__main__":
    asyncio.run(main())
