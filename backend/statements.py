"""Bank-statement (Veryfi) import module.

Exposes the endpoints backing the "Load bank statements" tab on the
Connections page:

  POST   /companies/{cid}/statements/upload
  GET    /companies/{cid}/statements/imports
  GET    /companies/{cid}/statements/imports/{import_id}
  DELETE /companies/{cid}/statements/imports/{import_id}

Auto-promote flow (Rocketsuite-style):
  1. Client posts a PDF/JPG/PNG (up to 25 MB).
  2. Veryfi OCR extracts the statement → normalized rows.
  3. `resolve_statement_account` matches (or creates) the target CoA asset
     row using bank name + last-4 heuristics.
  4. `statement_imports` row is persisted with the full veryfi payload + a
     summary of the batch.
  5. Every extracted line is run through the same PFC + AI pipeline as
     Plaid and inserted into `transactions` (auto-promoted).
  6. Response returns the import id + summary so the UI can navigate to
     the detail view.
"""
from __future__ import annotations
import uuid
from datetime import datetime, timezone

from fastapi import UploadFile, HTTPException
from pymongo import DESCENDING

from db import db, now_iso, coerce
import plaid_connect
import veryfi_service
import statement_account_resolver
from ai_activity import log_ai_event


MAX_BYTES = 25 * 1024 * 1024


async def upload_statement(
    cid: str,
    file: UploadFile,
    account_id: str | None,
    categorize_fn,
    is_period_closed_fn,
) -> dict:
    """Handle a bank-statement upload end-to-end. Called from server.py
    inside its route decorator so we inherit auth + rate limiting.
    """
    file_bytes = await file.read()
    if not file_bytes:
        raise HTTPException(400, "Empty file")
    if len(file_bytes) > MAX_BYTES:
        raise HTTPException(400, "File too large (max 25 MB)")

    # Insert the import row up front in "processing" state so the UI has
    # something to poll (Veryfi calls can take 30-60 s).
    import_id = str(uuid.uuid4())
    now = now_iso()
    await db.statement_imports.insert_one({
        "id": import_id,
        "company_id": cid,
        "filename": file.filename or "statement.pdf",
        "size": len(file_bytes),
        "method": "veryfi",
        "status": "processing",
        "transaction_count": None,
        "period_start": None,
        "period_end": None,
        "account_id": account_id,
        "account_name": None,
        "veryfi_document_id": None,
        "created_at": now,
        "updated_at": now,
    })

    # -------- Veryfi OCR --------
    try:
        veryfi_data = await veryfi_service.process_bank_statement(
            file_bytes, file.filename or "statement.pdf",
            file.content_type or "application/pdf",
        )
    except Exception as e:  # noqa: BLE001
        await db.statement_imports.update_one(
            {"id": import_id},
            {"$set": {"status": "failed", "error": f"Veryfi: {e}",
                      "updated_at": now_iso()}},
        )
        raise HTTPException(502, f"Veryfi error: {e}")

    # -------- Resolve/create the target CoA account --------
    if account_id:
        acct = await db.accounts.find_one({"id": account_id, "company_id": cid})
        if not acct:
            raise HTTPException(400, "Account not in this company")
        resolved = {
            "account_id": acct["id"], "account_name": acct["name"],
            "account_code": acct["code"], "matched": True,
            "bank_name": None, "last4": None,
            "starting_balance": statement_account_resolver
                ._statement_fields(veryfi_data).get("starting_balance"),
        }
    else:
        resolved = await statement_account_resolver.resolve_statement_account(
            cid, veryfi_data,
        )

    lines = veryfi_service.extract_transactions(veryfi_data)

    # -------- Period extraction --------
    dates = sorted([ln["date"] for ln in lines if ln.get("date")])
    period_start = (veryfi_data.get("period_start_date")
                    or veryfi_data.get("start_date")
                    or (dates[0] if dates else None))
    period_end = (veryfi_data.get("period_end_date")
                  or veryfi_data.get("end_date")
                  or veryfi_data.get("statement_date")
                  or (dates[-1] if dates else None))

    # -------- Dedupe against higher-priority sources (Plaid) --------
    bank_account_id = resolved["account_id"]
    higher_ranges = await plaid_connect.higher_source_ranges(cid, bank_account_id, "veryfi")

    accts = await db.accounts.find({"company_id": cid}).to_list(2000)
    coa = [{"code": a["code"], "name": a["name"], "type": a["type"]} for a in accts]
    bank_acct = next(a for a in accts if a["id"] == bank_account_id)

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

    # -------- Auto-promote via the shared PFC + AI pipeline --------
    inserted_count, skipped_closed = await _categorize_and_insert_veryfi_lines(
        cid, candidates, bank_acct, coa, accts,
        categorize_fn=categorize_fn,
        is_period_closed_fn=is_period_closed_fn,
        import_id=import_id,
    )
    imported = inserted_count
    await log_ai_event(cid, "veryfi_ocr", imported)

    # -------- Finalize the import row --------
    await db.statement_imports.update_one(
        {"id": import_id},
        {"$set": {
            "status": "completed",
            "transaction_count": imported,
            "skipped_duplicates": skipped_dupes,
            "skipped_closed": skipped_closed,
            "period_start": period_start,
            "period_end": period_end,
            "account_id": bank_account_id,
            "account_name": bank_acct["name"],
            "account_code": bank_acct["code"],
            "account_matched": resolved["matched"],
            "bank_name": resolved.get("bank_name"),
            "last4": resolved.get("last4"),
            "starting_balance": resolved.get("starting_balance"),
            "veryfi_document_id": (
                str(veryfi_data.get("id")) if veryfi_data.get("id") else None
            ),
            "veryfi_raw": veryfi_data,
            "updated_at": now_iso(),
        }},
    )

    # -------- Invalidate report cache for immediate dashboard refresh --------
    try:
        from infra import get_cache
        await get_cache().ainvalidate(cid)
    except Exception:  # noqa: BLE001
        pass

    return {
        "import_id": import_id,
        "status": "completed",
        "transaction_count": imported,
        "skipped_duplicates": skipped_dupes,
        "period_start": period_start,
        "period_end": period_end,
        "account": {
            "id": bank_account_id,
            "name": bank_acct["name"],
            "code": bank_acct["code"],
            "matched": resolved["matched"],
        },
        "bank_name": resolved.get("bank_name"),
        "last4": resolved.get("last4"),
    }


async def list_imports(cid: str, limit: int = 50, offset: int = 0) -> dict:
    """List import batches for a company, newest first."""
    total = await db.statement_imports.count_documents({"company_id": cid})
    cursor = (
        db.statement_imports
        .find({"company_id": cid}, {"veryfi_raw": 0})
        .sort("created_at", DESCENDING)
        .skip(offset)
        .limit(limit)
    )
    imports = [coerce(d) async for d in cursor]
    return {"total": total, "imports": imports}


async def get_import_detail(cid: str, import_id: str) -> dict:
    """Return the import row + the transactions promoted from it."""
    doc = await db.statement_imports.find_one({"id": import_id, "company_id": cid})
    if not doc:
        raise HTTPException(404, "Import not found")
    doc = coerce(doc)

    # Pull the transactions this import produced. Every Veryfi row we insert
    # now carries a `statement_import_id` foreign-key so the join is exact.
    rows = [coerce(t) async for t in db.transactions
            .find({"company_id": cid, "statement_import_id": import_id})
            .sort("date", 1).limit(2000)]
    doc["transactions"] = rows
    return doc


async def delete_import(cid: str, import_id: str, *, cascade: bool = True) -> dict:
    """Delete an import row. When `cascade=True`, also deletes every
    transaction the import produced (best-effort match on account + period).
    Returns counts.
    """
    doc = await db.statement_imports.find_one({"id": import_id, "company_id": cid})
    if not doc:
        raise HTTPException(404, "Import not found")

    txn_deleted = 0
    if cascade:
        result = await db.transactions.delete_many({
            "company_id": cid, "statement_import_id": import_id,
        })
        txn_deleted = result.deleted_count

    await db.statement_imports.delete_one({"id": import_id})
    try:
        from infra import get_cache
        await get_cache().ainvalidate(cid)
    except Exception:  # noqa: BLE001
        pass
    return {"deleted": True, "transactions_deleted": txn_deleted}


async def ensure_indexes() -> None:
    """Idempotent index setup for statement_imports."""
    try:
        await db.statement_imports.create_index(
            "id", unique=True, name="stmt_imports_id_uniq",
        )
    except Exception:  # noqa: BLE001
        pass
    try:
        await db.statement_imports.create_index(
            [("company_id", 1), ("created_at", -1)],
            name="stmt_imports_by_company_date",
        )
    except Exception:  # noqa: BLE001
        pass
    try:
        await db.transactions.create_index(
            [("company_id", 1), ("statement_import_id", 1)],
            name="txns_by_stmt_import",
            partialFilterExpression={"statement_import_id": {"$exists": True}},
        )
    except Exception:  # noqa: BLE001
        pass


__all__ = [
    "upload_statement",
    "list_imports",
    "get_import_detail",
    "delete_import",
    "ensure_indexes",
]


# ---------------------------------------------------------------------------
# Internal: Veryfi-tailored version of `plaid_connect.categorize_and_insert_
# plaid_txns`. Kept separate from the Plaid function to avoid regression risk
# on the working bank-feed flow. Shares the exact same pipeline stages
# (PFC resolver → contact resolver → merchant cache → LLM → uncategorized
# fallback) so Veryfi rows land with identical categorization quality.
# ---------------------------------------------------------------------------

async def _categorize_and_insert_veryfi_lines(
    cid: str,
    lines: list[dict],  # {date, description, merchant, merchant_name, amount, bank_account_id, bank_account_name}
    bank_acct: dict,
    coa: list[dict],
    accts: list[dict],
    *,
    categorize_fn,
    is_period_closed_fn,
    import_id: str,
) -> tuple[int, list[dict]]:
    """Run Veryfi-extracted lines through the shared PFC + AI pipeline and
    insert the resulting `transactions` rows. Returns (imported_count,
    skipped_by_closed_period).
    """
    import categorizer
    import contact_resolver
    import pfc_resolver
    from ai_service import resolve_contact_ai

    if not lines:
        return 0, []

    now = now_iso()

    # Filter out closed-period rows up front so they never hit the resolvers.
    candidates: list[dict] = []
    skipped_closed: list[dict] = []
    for ln in lines:
        if await is_period_closed_fn(cid, ln["date"]):
            skipped_closed.append({"reason": "closed_period", "line": ln})
            continue
        # Enrich with the fields the shared resolvers expect. Veryfi has no
        # personal_finance_category → pfc_* fields stay None, resolver falls
        # back to keyword/AI.
        candidates.append({
            **ln,
            "pfc": None,
            "pfc_primary": None,
            "pfc_detailed": None,
        })

    if not candidates:
        return 0, skipped_closed

    await categorizer.ensure_pfc_support_accounts(cid)
    uncat_exp, uncat_inc = await categorizer.ensure_uncategorized_accounts(cid)

    # Stage 1: PFC resolver — always fallback for Veryfi (no pfc_detailed)
    pfc_results: dict[int, dict] = {}
    for cand in candidates:
        resolved = await pfc_resolver.resolve_pfc_coa(
            cid, cand.get("pfc_detailed"), bank_account_id=bank_acct["id"],
        )
        cand["pfc_resolved"] = resolved
        if resolved and resolved.get("category_account_id") and resolved["source"] in (
            "primary", "override",
        ):
            pfc_results[id(cand)] = resolved

    deferred = [c for c in candidates if id(c) not in pfc_results]

    # Stage 2: contact resolution (every row, same as Plaid path)
    contact_results = await contact_resolver.resolve_contacts_batch(
        cid, candidates, ai_fallback_fn=resolve_contact_ai, concurrency=8,
    )
    for cand, cr in zip(candidates, contact_results):
        cand["contact_id"] = cr.get("contact_id")
        cand["contact_name"] = cr.get("contact_name")
        cand["contact_source"] = cr.get("source")

    # Stage 3: AI categorization for rows that PFC deferred
    per_item = await categorizer.categorize_batch_grouped(
        cid, deferred, coa, categorize_fn, concurrency=10,
    ) if deferred else []
    result_by_id = {id(c): r for c, r in zip(deferred, per_item)}

    accts_fresh = await db.accounts.find({"company_id": cid}).to_list(2000)
    accts_by_id_fresh = {a["id"]: a for a in accts_fresh}
    threshold = await categorizer.get_auto_post_threshold(cid)
    from liability_subaccounts import maybe_route_to_liability_subaccount

    inserted: list[dict] = []
    for cand in candidates:
        pfc_res = pfc_results.get(id(cand))
        if pfc_res:
            post = {
                "category_account_id":   pfc_res["category_account_id"],
                "category_account_code": pfc_res["category_account_code"],
                "category_account_name": pfc_res["category_account_name"],
                "ai_confidence": 0.95,
                "ai_reasoning": f"PFC → {pfc_res['category_account_name']} "
                                f"(source={pfc_res['source']})",
                "needs_review": not pfc_res["reviewed_by_default"],
                "posted": True,
                "ai_source": f"pfc_{pfc_res['source']}",
            }
            r = {"cache_hit": False}
        else:
            r = result_by_id[id(cand)]
            post = categorizer.decide_posting(
                r, threshold, uncat_exp, uncat_inc, accts_fresh, cand["amount"],
            )
        # Fan out to per-payee liability sub-account when the resolved
        # category is a generic parent bucket.
        post = await maybe_route_to_liability_subaccount(
            cid, post,
            merchant=cand.get("merchant"),
            contact_name=cand.get("contact_name"),
            accts_by_id=accts_by_id_fresh,
        )
        inserted.append({
            "id": str(uuid.uuid4()), "company_id": cid, "date": cand["date"],
            "description": cand["description"], "merchant": cand["merchant"],
            "amount": cand["amount"],
            "bank_account_id": bank_acct["id"],
            "bank_account_name": bank_acct["name"],
            "contact_id":     cand.get("contact_id"),
            "contact_name":   cand.get("contact_name"),
            "contact_source": cand.get("contact_source"),
            "pfc_detailed": None,
            "pfc_primary": None,
            "pfc_classification": (cand.get("pfc_resolved") or {}).get("classification"),
            **post,
            "human_reviewed": False,
            "source": "veryfi",
            "statement_import_id": import_id,
            "splits": [], "linked_invoice_id": None,
            "linked_bill_id": None, "linked_payment_id": None, "tags": [],
            "cache_hit": r.get("cache_hit", False),
            "created_at": now, "updated_at": now,
        })

    if inserted:
        try:
            await db.transactions.insert_many(inserted, ordered=False)
        except Exception:  # noqa: BLE001 — duplicate-key under race
            pass
        posted_count = sum(1 for r in inserted if r.get("posted"))
        flagged_count = sum(1 for r in inserted if r.get("needs_review"))
        if posted_count:
            await log_ai_event(cid, "post_je", posted_count)
        if flagged_count:
            await log_ai_event(cid, "flag_review", flagged_count)

    return len(inserted), skipped_closed
