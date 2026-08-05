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
import logging
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
    account_kind_hint: str | None = None,
) -> dict:
    """Handle a bank-statement upload end-to-end. Called from server.py
    inside its route decorator so we inherit auth + rate limiting.

    ``account_kind_hint`` is passed through to
    :func:`statement_account_resolver.resolve_statement_account` when the
    user picks a specific "Bank / Credit-card or loan" option in the UI.
    Ignored when ``account_id`` is supplied (the user picked a specific
    CoA row already).
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
            cid, veryfi_data, account_kind_hint=account_kind_hint,
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

    # -------- Coherence-check the opening balance (liability-side only) --------
    # Veryfi's `beginning_balance` field is reliable for bank/checking
    # statements (asset side — leave that path untouched), but on credit-
    # card / loan statements different issuers put different figures in
    # that slot: some return the previous statement's ending balance
    # (what we want), others return the current statement's new balance
    # (what we DON'T want — that's already the closing figure).
    #
    # Correct opening balance can always be derived from the identity the
    # OBE JE + running balance walks the account through. For a LIABILITY
    # (credit-normal), where `amount>0 = paydown` and `amount<0 = charge`,
    # the identity is:
    #
    #   ending_owed  =  opening_owed  -  Σ(txn amounts)     (net paydown
    #                                    reduces what's owed)
    #   ⇒  opening_owed  =  ending_owed  +  Σ(txn amounts)
    #
    # For an ASSET the identity is `opening = ending - Σ` — but that path
    # is left untouched here (asset statements currently work correctly).
    stmt_fields = statement_account_resolver._statement_fields(veryfi_data)
    ending_balance_v = stmt_fields.get("ending_balance")
    starting_balance_v = resolved.get("starting_balance")
    is_liability_acct = bank_acct.get("type") == "liability"
    if is_liability_acct and ending_balance_v is not None and lines:
        try:
            eb = float(ending_balance_v)
            movement = round(sum(float(ln.get("amount") or 0.0) for ln in lines), 2)
            # Liability-specific sign: opening_owed = ending_owed + Σ(amt).
            computed_opening = round(eb + movement, 2)
            try:
                sb_v = float(starting_balance_v) if starting_balance_v is not None else None
            except (TypeError, ValueError):
                sb_v = None
            # Per Veryfi's docs, `beginning_balance` is the correct field
            # for credit-card statements (previous statement's ending) —
            # this override only kicks in on real OCR imprecision. Tolerate
            # up to $5 of drift as normal OCR noise; only override on
            # larger disagreements (e.g. Veryfi swapped new/previous), and
            # always log both values so we can tune the threshold from
            # production telemetry.
            if sb_v is None or abs(sb_v - computed_opening) > 5.00:
                logging.getLogger(__name__).info(
                    "Statements: overriding starting_balance for liability "
                    "account %s from %r → %r (ending=%.2f, movement=%.2f, "
                    "veryfi_beginning=%r)",
                    bank_account_id, sb_v, computed_opening, eb, movement,
                    stmt_fields.get("starting_balance"),
                )
                starting_balance_v = computed_opening
        except (TypeError, ValueError):
            pass

    # -------- Finalize the import row FIRST --------
    # The auto-OBE helper's `_earliest_statement_anchor` filters on
    # `status: "completed"`, so the row for THIS upload must be flipped
    # before we call it — otherwise the helper never sees the current
    # statement as an anchor. Prior bug: on the first-ever upload no JE
    # was posted, and only the SECOND upload would create it (using the
    # first as the anchor). Reversing the order fixes both single-upload
    # and out-of-order-upload flows.
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
            "starting_balance": starting_balance_v,
            "ending_balance": ending_balance_v,
            "veryfi_document_id": (
                str(veryfi_data.get("id")) if veryfi_data.get("id") else None
            ),
            "veryfi_raw": veryfi_data,
            "updated_at": now_iso(),
        }},
    )

    # -------- Auto-post opening balance JE (delta / idempotent) --------
    # Handles out-of-order uploads via the shared helper — recomputes to
    # the earliest known statement's opening balance every time.
    opening_je_info = None
    try:
        import opening_balance_service
        opening_je_info = await opening_balance_service.ensure_opening_balance_for_account(
            cid, bank_account_id,
        )
    except Exception:  # noqa: BLE001 — never let this break the upload
        pass

    # Stash the OBE result on the row for downstream debugging + UI.
    if opening_je_info is not None:
        await db.statement_imports.update_one(
            {"id": import_id},
            {"$set": {"opening_balance_je": opening_je_info,
                      "updated_at": now_iso()}},
        )

    # -------- Auto-create reconciliation for this statement period --------
    # Every txn we just inserted came directly from the statement, so the
    # ledger is provably reconciled with the statement bookends. Turn that
    # into a `reconciliations` doc so the user sees the recon appear in
    # the history table immediately — no "Match statement PDF" click
    # required. Back-links via `statement_import_id` for cascade delete.
    auto_recon = None
    try:
        from reconciliation_engine import create_reconciliation_from_statement_import
        auto_recon = await create_reconciliation_from_statement_import(
            cid, import_id,
        )
    except Exception:  # noqa: BLE001 — never break the upload.
        pass

    # -------- Invalidate report cache for immediate dashboard refresh --------
    try:
        from infra import get_cache
        await get_cache().ainvalidate(cid)
    except Exception:  # noqa: BLE001
        pass

    # -------- Auto-classify contact types from txn direction ---------
    # Freshly created contacts (from this statement upload) land with
    # `type: None`. Now that transactions have posted with `contact_id`
    # set, we can infer type from sign of amount so Customers/Vendors
    # pages populate automatically. Best-effort — never fail the upload.
    try:
        from contact_resolver import reclassify_contact_types
        await reclassify_contact_types(cid, respect_manual=True)
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
        "opening_balance_je": opening_je_info,
        "auto_reconciliation": auto_recon,
    }


async def list_imports(cid: str, limit: int = 50, offset: int = 0) -> dict:
    """List import batches for a company, newest first.

    Piggybacks a lazy one-shot opening-balance backfill for pre-Feb-2026
    statements. This is safe to inline because:
      1. The endpoint is called only when a user opens Connections →
         Statements — not from the dashboard, balance sheet, or any hot
         path. Steady-state overhead is effectively zero.
      2. The `companies.opening_balance_backfilled_at` marker + atomic
         `$exists: false` update means the actual work happens exactly
         ONCE per company for its entire lifetime; every subsequent visit
         is a single indexed marker read that short-circuits.
      3. Wrapped in try/except so a helper failure never breaks the
         imports list from loading.
    """
    try:
        await _lazy_backfill_opening_balances(cid)
    except Exception:  # noqa: BLE001 — never block the imports list.
        pass
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


async def _lazy_backfill_opening_balances(cid: str) -> None:
    """Fire the OBE helper once per company (atomic marker on the
    `companies` doc). Handles ALL bank accounts that have completed
    statement_imports for this company."""
    result = await db.companies.update_one(
        {"id": cid, "opening_balance_backfilled_at": {"$exists": False}},
        {"$set": {"opening_balance_backfilled_at": now_iso()}},
    )
    if result.modified_count == 0:
        return  # Marker already set — never do work again for this company.
    import opening_balance_service as obs
    imported_account_ids = await db.statement_imports.distinct(
        "account_id", {"company_id": cid, "status": "completed"},
    )
    for aid in imported_account_ids:
        if aid:
            await obs.ensure_opening_balance_for_account(cid, aid)


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

    Also re-runs the auto-managed opening balance helper for the
    affected bank account. Three outcomes:
      1. Other statements remain for this account → JE date/amount
         recomputes to the next-earliest anchor.
      2. No statements remain AND an auto-managed OBE JE exists → the
         helper deletes the JE (returns `action: "deleted"`, reason
         `"no_statement_anchor_je_removed"`).
      3. No statements remain AND no auto-managed JE → no-op.
    """
    doc = await db.statement_imports.find_one({"id": import_id, "company_id": cid})
    if not doc:
        raise HTTPException(404, "Import not found")
    bank_account_id = doc.get("account_id")

    # Cascade-delete the auto-generated reconciliation FIRST so the
    # un-clear step it performs finds every txn while they still exist.
    recon_deleted = None
    try:
        from reconciliation_engine import delete_reconciliation_for_statement_import
        recon_deleted = await delete_reconciliation_for_statement_import(
            cid, import_id,
        )
    except Exception:  # noqa: BLE001
        pass

    txn_deleted = 0
    if cascade:
        result = await db.transactions.delete_many({
            "company_id": cid, "statement_import_id": import_id,
        })
        txn_deleted = result.deleted_count

    await db.statement_imports.delete_one({"id": import_id})

    # Re-anchor / tear down the auto-managed OBE JE now that this
    # statement is gone. Idempotent — never raises to the caller.
    opening_je_info = None
    if bank_account_id:
        try:
            import opening_balance_service as obs
            opening_je_info = await obs.ensure_opening_balance_for_account(
                cid, bank_account_id,
            )
        except Exception:  # noqa: BLE001
            pass

    try:
        from infra import get_cache
        await get_cache().ainvalidate(cid)
    except Exception:  # noqa: BLE001
        pass
    return {
        "deleted": True,
        "transactions_deleted": txn_deleted,
        "opening_balance_je": opening_je_info,
        "auto_reconciliation_deleted": recon_deleted,
    }


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
    # A positive amount on a liability account means "money came IN to the
    # card / loan" — i.e. a paydown or refund/rebate. Veryfi's schema does
    # NOT return the source-bank account for a credit-card payment (there's
    # simply no such field), so we can't auto-link the offsetting side. We
    # POST the paydown against the card directly (so its balance ties to
    # the statement) and route the OTHER side to a dedicated per-company
    # `Credit Card Payment Clearing` (1150) asset row — the same pattern
    # QuickBooks / Xero / Sage use for this exact scenario.
    #
    # Why NOT Opening Balance Equity: OBE semantically means "opening
    # balances carried forward from before we started tracking." Using it
    # for in-period paydowns pollutes the account, mixes real openings with
    # to-do items, and is flagged as an anti-pattern in most audits. A
    # dedicated Clearing row keeps the review queue crisp — any non-zero
    # balance IS the to-do list.
    #
    # Asset accounts are unaffected; positive amounts on Checking still
    # follow the normal deposit / revenue path.
    bank_is_liability = bank_acct.get("type") == "liability"
    clearing_row = None
    if bank_is_liability and any((c.get("amount") or 0.0) > 0 for c in candidates):
        import plaid_connect
        clearing_row = await plaid_connect.ensure_cc_payment_clearing(cid)

    for cand in candidates:
        if bank_is_liability and (cand.get("amount") or 0.0) > 0 and clearing_row:
            post = {
                "category_account_id":   clearing_row["id"],
                "category_account_code": clearing_row.get("code"),
                "category_account_name": clearing_row.get("name"),
                "ai_confidence": 0.0,
                "ai_reasoning": (
                    "Payment or credit received on a liability account — "
                    "temporarily parked in Credit Card Payment Clearing. "
                    "Please reclassify to the source bank / asset account "
                    "(e.g. checking) once you import that statement."
                ),
                "needs_review": True,
                # POST it — the ledger MUST tie to the statement.
                "posted": True,
                "ai_source": "liability_paydown_guard",
            }
            r = {"cache_hit": False}
            inserted.append({
                "id": str(uuid.uuid4()), "company_id": cid, "date": cand["date"],
                "description": cand["description"], "merchant": cand["merchant"],
                "amount": cand["amount"],
                "bank_account_id": bank_acct["id"],
                "bank_account_name": bank_acct["name"],
                "contact_id":     cand.get("contact_id"),
                "contact_name":   cand.get("contact_name"),
                "contact_source": cand.get("contact_source"),
                "pfc_detailed": None, "pfc_primary": None,
                "pfc_classification": (cand.get("pfc_resolved") or {}).get("classification"),
                **post,
                "human_reviewed": False,
                "source": "veryfi",
                "statement_import_id": import_id,
                "splits": [], "linked_invoice_id": None,
                "linked_bill_id": None, "linked_payment_id": None, "tags": [],
                "cache_hit": False,
                "created_at": now, "updated_at": now,
            })
            continue

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
