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
import re as _re
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


# ---------- Veryfi OCR sanity guards (Aug 23 2026) ----------
# Bank-statement OCR is Veryfi's hardest problem — 4,000+ US banks
# render statements differently. Three known failure modes leak
# phantom or bogus rows into the ledger unless we defend upstream:
#
#   1) "Recent Deposits" / YTD summary sidebars get read as a single
#      transaction. Signature: description is a chain of `MM-DD
#      amount MM-DD amount ...` with 3+ pairs. Killed the exact bug
#      on 30A Landscaping LLC where a $1,100 phantom duplicated the
#      real $1,100 deposit already booked elsewhere in the same PDF.
#   2) Descriptions with no alpha content. A legit txn has letters
#      ("VENMO", "POINT OF SALE", "External Withdrawal"). If the
#      description is 100% digits/punctuation/spaces, it's OCR of a
#      balance column, ad footer, or YTD summary that got sliced
#      into a row.
#   3) Self-consistency check against Veryfi's OWN extracted summary
#      totals (`beginning_balance + Σ deposits − Σ withdrawals`
#      should equal `ending_balance`). If it drifts we flag the
#      whole import for review. DIFFERENT from Axiom's monthly auto-
#      reconciliation (which compares the ledger to Plaid feeds);
#      this check compares Veryfi's line items to Veryfi's summary
#      totals from the SAME PDF, before the rows enter the ledger.
_REFNUM_RX = _re.compile(r"\bL\d{5,}\b|Trace\s*#\s*\d{5,}|#\s*\d{5,}")
_SUMMARY_SIDEBAR_RX = _re.compile(r"\b\d{1,2}-\d{1,2}\s+[\d,]+\.\d{2}\b")
_ALPHA_RX = _re.compile(r"[A-Za-z]")


def _extract_ref_number(desc: str) -> str | None:
    """Pull a stable reference number out of a Veryfi txn description
    (Square "L82936", check trace numbers, POS #). Used by Layer 4 to
    detect duplicate rows that Veryfi split across a page boundary.
    """
    m = _REFNUM_RX.search(desc or "")
    return m.group(0).strip() if m else None


def _apply_veryfi_dup_guard(lines: list[dict]) -> tuple[list[dict], int]:
    """Layer 4 (Aug 24 2026 → softened Aug 25 2026): flag Veryfi-emitted
    likely-duplicate rows instead of hard-dropping them. Two signals:

    (a) Same reference number + same date → cross-page duplicate
        candidate.
    (b) Same date + same amount + same merchant prefix (first 8 chars)
        → multi-line merge candidate.

    A row is kept but tagged ``probable_duplicate=True`` with a
    ``dup_reason``. Downstream UI surfaces a soft badge so the CPA can
    review; hard-dropping burned three legit rows on 30A Landscaping
    and threw off previously-reconciled periods, so we never drop.

    Returns ``(lines, flagged_count)`` — signature kept for backward
    compatibility with call sites (dropped_count == flagged_count for
    banner/log purposes).
    """
    seen_refs: set[tuple[str, str]] = set()
    seen_shape: set[tuple[str, float, str]] = set()
    flagged = 0
    for ln in lines:
        desc = str(ln.get("description") or ln.get("merchant") or "").strip()
        date = str(ln.get("date") or "")[:10]
        try:
            amt = round(float(ln.get("amount") or 0), 2)
        except (TypeError, ValueError):
            amt = 0.0
        ref = _extract_ref_number(desc)
        dup_reason: str | None = None
        if ref and date:
            key_ref = (date, ref)
            if key_ref in seen_refs:
                dup_reason = "same_ref_same_date"
            else:
                seen_refs.add(key_ref)
        if not dup_reason and amt and date:
            shape = (date, amt, desc[:8].upper())
            if shape in seen_shape:
                dup_reason = "same_shape_same_date"
            else:
                seen_shape.add(shape)
        if dup_reason:
            ln["probable_duplicate"] = True
            ln["dup_reason"] = dup_reason
            flagged += 1
    return lines, flagged


def _looks_like_summary_sidebar(desc: str) -> bool:
    """3+ date-amount pairs strung together = "Recent Deposits" box."""
    return len(_SUMMARY_SIDEBAR_RX.findall(desc or "")) >= 3


def _has_alpha_content(desc: str) -> bool:
    """Real txn descriptions carry merchant / verb text."""
    return bool(_ALPHA_RX.search(desc or ""))


def _apply_veryfi_row_guards(lines: list[dict]) -> tuple[list[dict], dict[str, int]]:
    """Layer 1 (hard-drop) + Layer 2 (soft-flag) row-shape guards.

    • Layer 1 — "Recent Deposits" summary sidebars (3+ `MM-DD amount`
      pairs strung together). This pattern is essentially never a real
      transaction. HARD DROP. Killed the 30A $1,100 phantom.
    • Layer 2 — descriptions with zero alpha content. Usually OCR
      noise (balance columns, ad footers) BUT sometimes a legit
      check-only row Veryfi mangled to bare digits. SOFT FLAG
      (Aug 25 2026 change) — keep the row, tag
      ``probable_ocr_noise=True`` so the CPA can verify. Prevents the
      $95 check-row miss that broke 30A Landscaping 3's reconciliation.

    Returns ``(lines, {reason: count})`` where counts include
    drops AND flags for banner/log surfacing.
    """
    counts: dict[str, int] = {}
    kept: list[dict] = []
    for ln in lines:
        desc = str(ln.get("description") or ln.get("merchant") or "").strip()
        if _looks_like_summary_sidebar(desc):
            counts["summary_sidebar"] = counts.get("summary_sidebar", 0) + 1
            continue
        if not _has_alpha_content(desc):
            ln["probable_ocr_noise"] = True
            ln["ocr_noise_reason"] = "no_alpha_content"
            counts["no_alpha_flagged"] = counts.get("no_alpha_flagged", 0) + 1
        kept.append(ln)
    return kept, counts


def _statement_ocr_reconcile(
    veryfi_data: dict, lines: list[dict], dropped: dict[str, int],
) -> dict | None:
    """Layer 3: reconcile Veryfi's line items against its OWN summary
    totals extracted from the same PDF. Advisory only — MUST NEVER
    raise or block an upload. On any shape drift (list-vs-dict,
    missing fields, malformed numerics) returns ``None`` and lets
    the import proceed. Aug 24 2026.
    """
    try:
        return _statement_ocr_reconcile_impl(veryfi_data, lines, dropped)
    except Exception as e:  # noqa: BLE001
        logging.getLogger(__name__).warning(
            "Layer 3 reconcile skipped (shape drift): %s", e)
        return None


def _statement_ocr_reconcile_impl(
    veryfi_data: dict, lines: list[dict], dropped: dict[str, int],
) -> dict | None:
    if not isinstance(veryfi_data, dict):
        return None
    _fields = statement_account_resolver._statement_fields(veryfi_data)
    # `_statement_fields` returns `starting_balance` (not
    # `beginning_balance`) after normalizing across Veryfi's two doc
    # shapes. `total_deposits` / `total_withdrawals` aren't normalized
    # there — pull them opportunistically from the raw doc / accounts.
    # Veryfi sometimes returns the whole doc as a list-of-accounts
    # (multi-account statement); tolerate both shapes so this guard
    # can't 500 the upload. Aug 24 2026.
    bb = _fields.get("starting_balance")
    eb = _fields.get("ending_balance")
    _root = veryfi_data if isinstance(veryfi_data, dict) else {}
    _acct_list = _root.get("accounts") if _root else None
    if not _acct_list and isinstance(veryfi_data, list):
        _acct_list = veryfi_data
    _acct_list = _acct_list or [{}]
    _acct0 = _acct_list[0] if _acct_list and isinstance(_acct_list[0], dict) else {}
    _summaries_raw = _acct0.get("summaries")
    # Veryfi returns `summaries` as either a dict or a list-of-dicts
    # depending on account type — normalize to dict-lookup.
    if isinstance(_summaries_raw, dict):
        _summaries = _summaries_raw
    elif isinstance(_summaries_raw, list) and _summaries_raw and isinstance(_summaries_raw[0], dict):
        _summaries = _summaries_raw[0]
    else:
        _summaries = {}
    v_dep = (
        _root.get("total_deposits")
        or _acct0.get("total_deposits")
        or _summaries.get("total_deposits")
    )
    v_wd = (
        _root.get("total_withdrawals")
        or _acct0.get("total_withdrawals")
        or _summaries.get("total_withdrawals")
    )
    if bb is None or eb is None:
        return None
    try:
        bb_f = float(bb); eb_f = float(eb)
    except (TypeError, ValueError):
        return None
    actual_dep = round(sum(float(ln.get("amount") or 0) for ln in lines
                           if float(ln.get("amount") or 0) > 0), 2)
    actual_wd = round(-sum(float(ln.get("amount") or 0) for ln in lines
                           if float(ln.get("amount") or 0) < 0), 2)
    computed_ending = round(bb_f + actual_dep - actual_wd, 2)
    drift = round(computed_ending - eb_f, 2)
    if abs(drift) <= 0.01:
        return None
    return {
        "beginning_balance": bb_f,
        "ending_balance": eb_f,
        "extracted_deposits": actual_dep,
        "extracted_withdrawals": actual_wd,
        "veryfi_reported_deposits": (
            float(v_dep) if v_dep is not None else None),
        "veryfi_reported_withdrawals": (
            float(v_wd) if v_wd is not None else None),
        "computed_ending": computed_ending,
        "drift": drift,
        "dropped_rows": dict(dropped),
    }


async def upload_statement_multi(
    cid: str,
    file: UploadFile,
    categorize_fn,
    is_period_closed_fn,
    account_kind_hint: str | None = None,
) -> dict:
    """Async multi-statement upload — dispatches the PDF/zip to Veryfi's
    ``bank-statements-set`` (splitter) endpoint. Returns immediately with
    a parent import row in ``status='splitting'``; when Veryfi finishes
    it fires a webhook that our
    :func:`~routes.veryfi_webhooks.bank_statement_set` handler picks up,
    creates one child :class:`statement_imports` row per split, and runs
    each child through :func:`_process_veryfi_result`.

    Kept as a dedicated function (rather than a branch inside
    :func:`upload_statement`) because the two paths have entirely
    different return contracts: this one returns immediately with a
    ``status='splitting'`` payload, while the sync path returns a full
    completed import summary. Splitting the entry points keeps that
    contract explicit at both call sites.
    """
    file_bytes = await file.read()
    if not file_bytes:
        raise HTTPException(400, "Empty file")
    # Veryfi splitter caps at 50 MB.
    if len(file_bytes) > 50 * 1024 * 1024:
        raise HTTPException(400, "File too large (max 50 MB for multi-statement)")

    import_id = str(uuid.uuid4())
    now = now_iso()
    await db.statement_imports.insert_one({
        "id": import_id,
        "company_id": cid,
        "filename": file.filename or "statement.pdf",
        "size": len(file_bytes),
        "method": "veryfi_split",
        "status": "splitting",
        "is_multi": True,
        "account_kind_hint": account_kind_hint,
        "child_import_ids": [],
        "child_document_ids": [],
        "transaction_count": None,
        "period_start": None,
        "period_end": None,
        "account_id": None,
        "account_name": None,
        "veryfi_document_set_id": None,
        "created_at": now,
        "updated_at": now,
    })

    # -------- Veryfi splitter (async, returns doc_set_id immediately) --------
    try:
        set_response = await veryfi_service.process_bank_statement_set(
            file_bytes, file.filename or "statement.pdf",
            file.content_type or "application/pdf",
        )
    except Exception as e:  # noqa: BLE001
        await db.statement_imports.update_one(
            {"id": import_id},
            {"$set": {"status": "failed", "error": f"Veryfi splitter: {e}",
                      "updated_at": now_iso()}},
        )
        raise HTTPException(502, f"Veryfi splitter error: {e}")

    doc_set_id = set_response.get("id")
    await db.statement_imports.update_one(
        {"id": import_id},
        {"$set": {"veryfi_document_set_id": doc_set_id,
                  "veryfi_set_raw": set_response,
                  "updated_at": now_iso()}},
    )
    return {
        "import_id": import_id,
        "status": "splitting",
        "veryfi_document_set_id": doc_set_id,
        "message": (
            "PDF sent to Veryfi splitter. Individual statements will "
            "appear here as they finish processing (typically 1–3 min)."
        ),
    }


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

    return await _process_veryfi_result(
        cid, import_id, veryfi_data, account_id,
        categorize_fn=categorize_fn,
        is_period_closed_fn=is_period_closed_fn,
        account_kind_hint=account_kind_hint,
    )


async def _fan_out_multi_account(
    cid: str,
    parent_import_id: str,
    veryfi_data: dict,
    categorize_fn,
    is_period_closed_fn,
    account_kind_hint: str | None = None,
) -> dict:
    """Handle a combined multi-account statement (Wells Fargo Combined,
    Amex Blue + Gold, Chase Checking + Savings on one PDF) by promoting
    the current import row to a PARENT and running
    :func:`_process_veryfi_result` once per account against a synthetic
    single-account sub-doc.

    Contract mirrors the splitter parent/child model (same
    ``parent_import_id``/``child_import_ids`` fields on
    ``statement_imports``) so the imports table renders them the same
    way — a ``multi · N`` badge on the parent + indented children.
    """
    import uuid as _uuid
    groups = veryfi_service.iter_statement_accounts(veryfi_data)
    parent = await db.statement_imports.find_one({"id": parent_import_id})
    parent_filename = (parent or {}).get("filename") or "statement.pdf"

    # Promote current row to parent immediately so it appears in the
    # imports table as "multi · N accounts" while the children run.
    await db.statement_imports.update_one(
        {"id": parent_import_id},
        {"$set": {
            "is_multi_account": True,
            "is_multi": True,   # UI reuses the same badge as the splitter
            "status": "processing",
            "child_import_ids": [],
            "multi_account_count": len(groups),
            "veryfi_raw": veryfi_data,
            "updated_at": now_iso(),
        }},
    )

    child_import_ids: list[str] = []
    successes = 0
    failures = 0
    total_txns = 0
    for i, grp in enumerate(groups):
        child_id = str(_uuid.uuid4())
        acct_ref = grp["account_ref"]
        # Human-readable child filename hint: "statement.pdf [Checking ···6084]"
        acct_num = (
            acct_ref.get("account_number")
            or (acct_ref.get("accounts") or [{}])[0].get("account_number")
            or (acct_ref.get("accounts") or [{}])[0].get("number")
            or ""
        )
        acct_type = (
            (acct_ref.get("accounts") or [{}])[0].get("account_type")
            or acct_ref.get("account_type")
            or f"acct #{i + 1}"
        )
        last4 = str(acct_num)[-4:] if acct_num else ""
        child_label = f"{acct_type}{f' ···{last4}' if last4 else ''}".strip()
        now = now_iso()
        await db.statement_imports.insert_one({
            "id": child_id,
            "company_id": cid,
            "parent_import_id": parent_import_id,
            "filename": f"{parent_filename} [{child_label}]",
            "size": None,
            "method": "veryfi_multiacct_child",
            "status": "processing",
            "transaction_count": None,
            "period_start": None,
            "period_end": None,
            "account_id": None,
            "account_name": None,
            "veryfi_document_id": None,
            "multi_account_index": i,
            "multi_account_total": len(groups),
            "created_at": now,
            "updated_at": now,
        })
        child_import_ids.append(child_id)
        try:
            child_result = await _process_veryfi_result(
                cid, child_id, acct_ref, account_id=None,
                categorize_fn=categorize_fn,
                is_period_closed_fn=is_period_closed_fn,
                account_kind_hint=account_kind_hint,
            )
            successes += 1
            total_txns += int(child_result.get("transaction_count") or 0)
        except Exception as e:  # noqa: BLE001 — one bad account can't kill the batch
            logging.getLogger(__name__).exception(
                "Multi-account child failed cid=%s parent=%s idx=%d: %s",
                cid, parent_import_id, i, e,
            )
            failures += 1
            await db.statement_imports.update_one(
                {"id": child_id},
                {"$set": {"status": "failed",
                          "error": f"pipeline: {e}",
                          "updated_at": now_iso()}},
            )

    final_status = (
        "completed" if failures == 0 and successes > 0
        else ("failed" if successes == 0 else "partial")
    )
    await db.statement_imports.update_one(
        {"id": parent_import_id},
        {"$set": {
            "status": final_status,
            "child_import_ids": child_import_ids,
            "transaction_count": total_txns,
            "children_success": successes,
            "children_failed": failures,
            "updated_at": now_iso(),
        }},
    )
    return {
        "import_id": parent_import_id,
        "status": final_status,
        "is_multi_account": True,
        "transaction_count": total_txns,
        "children_success": successes,
        "children_failed": failures,
        "child_import_ids": child_import_ids,
    }


async def _process_veryfi_result(
    cid: str,
    import_id: str,
    veryfi_data: dict,
    account_id: str | None,
    categorize_fn,
    is_period_closed_fn,
    account_kind_hint: str | None = None,
) -> dict:
    """Post-Veryfi pipeline: resolve account, apply OCR guards, extract
    transactions, categorize + insert, finalize the import row, auto-post
    opening-balance JE, auto-create reconciliation.

    Extracted from :func:`upload_statement` so the async splitter webhook
    (which fetches each child statement's parsed JSON via a GET) can
    reuse the exact same pipeline as the sync single-file path.

    Multi-account statements (Wells Fargo Combined, Amex Blue + Gold on
    one PDF, Chase Total Checking + Savings) fan out here: when Veryfi
    returns 2+ entries in ``accounts[]``, the current ``import_id`` is
    promoted to a parent row (``is_multi_account=True``) and one child
    ``statement_imports`` row is created per account, each running
    through this same function with a synthetic single-account sub-doc.
    """
    # -------- Multi-account fan-out (combined statements) --------
    # Detect BEFORE running the single-account path so we route Wells
    # Combined-style statements into per-account children instead of
    # flattening every transaction into one CoA row.
    _accts = veryfi_data.get("accounts") or []
    _valid_accts = [a for a in _accts if isinstance(a, dict)]
    if len(_valid_accts) > 1 and not account_id:
        return await _fan_out_multi_account(
            cid, import_id, veryfi_data,
            categorize_fn=categorize_fn,
            is_period_closed_fn=is_period_closed_fn,
            account_kind_hint=account_kind_hint,
        )

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
    # Veryfi OCR sanity guards — see module-level docstring on
    # `_apply_veryfi_row_guards` and `_statement_ocr_reconcile`. Layers
    # 1+2 drop phantom rows before insert; Layer 3 attaches an
    # `ocr_reconcile_flag` to the import row when Veryfi's line items
    # can't be reconciled to its own summary totals, so the CPA sees a
    # banner to review. Aug 23 2026.
    lines, _dropped_rows = _apply_veryfi_row_guards(lines)
    # Layer 4 — soft-flag likely duplicates (was hard-drop until Aug 25).
    # Rows stay in the ledger; a `probable_duplicate` badge lets the CPA
    # review manually. See `_apply_veryfi_dup_guard` docstring for why.
    lines, _dup_flagged = _apply_veryfi_dup_guard(lines)
    if _dup_flagged:
        _dropped_rows["duplicate_row_flagged"] = _dup_flagged
    if _dropped_rows:
        logging.getLogger(__name__).info(
            "Statements: dropped/flagged %d Veryfi rows (%s) — company=%s",
            sum(_dropped_rows.values()), _dropped_rows, cid,
        )
    _reconcile_flag = _statement_ocr_reconcile(veryfi_data, lines, _dropped_rows)
    if _reconcile_flag:
        logging.getLogger(__name__).warning(
            "Statements: OCR self-consistency FAILED — drift=$%.2f (%s)",
            _reconcile_flag["drift"], cid,
        )

    # -------- Period extraction --------
    # Veryfi's `period_start_date` / `period_end_date` come from OCR on the
    # statement header, and on multi-page credit-card statements (esp.
    # Amex) it often mis-reads the "Next Closing Date" as the current
    # period start — producing a range like Apr 1 → Apr 24 on a Feb-Mar
    # statement. That mis-parse cascades into the auto-OBE JE (which uses
    # `period_start - 1 day` as its `as_of`), causing the OBE seed to be
    # posted AFTER the imported txns and yielding a wildly wrong opening.
    #
    # Ground truth: the actual transactions ARE the period. If Veryfi's
    # header dates don't envelope the extracted transaction dates, we
    # override them with the extracted min/max. This is safe because a
    # legitimate statement always has every txn within its period.
    dates = sorted([ln["date"] for ln in lines if ln.get("date")])
    txn_min = dates[0] if dates else None
    txn_max = dates[-1] if dates else None
    veryfi_start = veryfi_data.get("period_start_date") or veryfi_data.get("start_date")
    veryfi_end = (veryfi_data.get("period_end_date")
                  or veryfi_data.get("end_date")
                  or veryfi_data.get("statement_date"))
    # Sanity-check the Veryfi period. A single monthly statement should
    # cover ~28-35 days. When Veryfi mis-reads the year (esp. on cross-
    # year Dec→Jan statements where it stamps every date with the closing
    # year), the reported range balloons to ~365 days (e.g. Jan 1 → Dec
    # 31 of the same year). If the span exceeds 45 days AND we have
    # transaction dates, trust the txn-derived boundaries instead. Also
    # prefer `statement_date` (single anchor) over `period_end_date` in
    # that pathological case since it's more reliably a real closing.
    try:
        if veryfi_start and veryfi_end:
            _span = (datetime.fromisoformat(str(veryfi_end)[:10])
                     - datetime.fromisoformat(str(veryfi_start)[:10])).days
            if _span > 45 and txn_min and txn_max:
                logging.getLogger(__name__).info(
                    "Statements: Veryfi period span %s days (%s → %s) exceeds "
                    "45-day monthly limit — falling back to txn-derived boundaries",
                    _span, veryfi_start, veryfi_end,
                )
                veryfi_start = None
                veryfi_end = veryfi_data.get("statement_date") or None
    except Exception:  # noqa: BLE001
        pass
    # Prefer Veryfi's dates when they envelope the transactions, otherwise
    # fall back to the extracted boundaries. If either is missing, use the
    # transaction-derived one directly.
    if veryfi_start and txn_min and veryfi_start > txn_min:
        logging.getLogger(__name__).info(
            "Statements: Veryfi period_start %s > earliest txn %s — "
            "falling back to txn-derived period_start",
            veryfi_start, txn_min,
        )
        period_start = txn_min
    else:
        period_start = veryfi_start or txn_min
    if veryfi_end and txn_max and veryfi_end < txn_max:
        logging.getLogger(__name__).info(
            "Statements: Veryfi period_end %s < latest txn %s — "
            "falling back to txn-derived period_end",
            veryfi_end, txn_max,
        )
        period_end = txn_max
    else:
        period_end = veryfi_end or txn_max

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
            # OCR self-consistency status (Layer 3). ``None`` → clean;
            # a dict → Veryfi's line items don't reconcile to its own
            # summary totals, and the UI should surface a review banner.
            # `dropped_rows` inside the flag shows what Layers 1+2
            # already filtered out. Aug 23 2026.
            "ocr_reconcile_flag": _reconcile_flag,
            "ocr_dropped_rows": _dropped_rows or None,
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

    # Standard+ post-hook — if the company opted in, apply Global
    # Vendor Rules override on rows Standard just inserted (statement
    # path). Mirror of the sync_tasks branch so both ingest paths
    # behave the same. Silent on failure — txns remain with their
    # standard-cascade categories.
    try:
        _co = await db.companies.find_one({"id": cid})
        _mode = (_co or {}).get("categorization_mode") or "standard"
        if imported > 0 and _mode == "standard_plus":
            import standard_plus_categorizer as _spc
            _rows = await db.transactions.find(
                {"statement_import_id": import_id, "company_id": cid},
                projection={"id": 1},
            ).to_list(imported)
            await _spc.apply_global_rules_override(
                cid, [_r["id"] for _r in _rows if _r.get("id")],
            )
    except Exception as _e:  # noqa: BLE001
        import logging as _lg
        _lg.getLogger(__name__).warning(
            "statements categorization-mode post-hook failed cid=%s import=%s: %s",
            cid, import_id, _e,
        )

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
        # Directory hint — see plaid_connect for the full explanation.
        cand["category_hint_semantic"] = cr.get("linked_semantic")
        cand["category_hint_source"] = "global_directory" if cr.get("linked_semantic") else None

    # Stage 2.5: Global Contact Directory hint — deterministic override
    # for well-known vendors. Runs on EVERY candidate carrying a hint
    # (not just deferred). Directory beats PFC because canonical merchant
    # identity is a stronger signal than Plaid's fuzzy category mapping.
    import global_vendor_rules
    _company_doc = await db.companies.find_one({"id": cid})
    _template = (_company_doc or {}).get("industry_template") or "generic"
    _accts_now = await db.accounts.find({"company_id": cid}).to_list(2000)
    directory_results: dict[int, dict] = {}
    for cand in candidates:
        hint = cand.get("category_hint_semantic")
        if not hint or cand.get("category_hint_source") != "global_directory":
            continue
        acct = global_vendor_rules.resolve_semantic_to_account(
            hint, _accts_now, _template,
        )
        if not acct:
            continue
        directory_results[id(cand)] = {
            "account_id":   acct.get("id"),
            "account_code": acct.get("code"),
            "account_name": acct.get("name"),
            "semantic":     hint,
        }
    # Rows with a directory hit skip the LLM.
    deferred = [c for c in deferred if id(c) not in directory_results]

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

        # Directory-first: canonical merchant identity beats Plaid PFC.
        dir_res = directory_results.get(id(cand))
        pfc_res = None if dir_res else pfc_results.get(id(cand))
        if dir_res:
            post = {
                "category_account_id":   dir_res["account_id"],
                "category_account_code": dir_res["account_code"],
                "category_account_name": dir_res["account_name"],
                "ai_confidence": 0.90,
                "ai_reasoning": (
                    f"Global Contact Directory → {cand.get('contact_name')} "
                    f"→ semantic '{dir_res['semantic']}' → account "
                    f"'{dir_res['account_name']}'"
                ),
                "needs_review": False,
                "posted": True,
                "ai_source": "directory",
            }
            r = {"cache_hit": False}
        elif pfc_res:
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
            "category_hint_semantic": cand.get("category_hint_semantic"),
            "category_hint_source":   cand.get("category_hint_source"),
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
            # Layer 4 soft-flag — carries through so the UI can show a
            # "possible duplicate" badge on the txn row for CPA review.
            "probable_duplicate": bool(cand.get("probable_duplicate")),
            "dup_reason": cand.get("dup_reason"),
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


async def reprocess_import(
    cid: str,
    import_id: str,
    account_kind_hint: str | None,
    *,
    categorize_fn,
    is_period_closed_fn,
) -> dict:
    """Re-run the CoA-resolver + txn-insertion for an already-completed
    import, this time with the user-provided `account_kind_hint`
    ("asset" | "liability" | "auto").

    Used by the Uploads-table "Reprocess" button when the initial
    auto-detect misfired (e.g. an Amex Business card mis-classified as
    Checking). We keep the cached Veryfi payload so we don't burn another
    OCR call — just delete the current txns, clean up any auto-created
    CoA row that has no other references, then re-run the resolver +
    insertion loop with the corrected hint.

    Returns counts of what was deleted / reinserted so the UI can show a
    "cleaned up 123 txns, re-imported as Credit Card" toast.
    """
    doc = await db.statement_imports.find_one({"id": import_id, "company_id": cid})
    if not doc:
        raise HTTPException(404, "Import not found")
    veryfi_data = doc.get("veryfi_raw")
    if not veryfi_data:
        raise HTTPException(
            400,
            "This import doesn't have its OCR payload cached — reprocess "
            "requires the raw Veryfi response, which was only added to new "
            "imports recently. Please delete and re-upload the file.",
        )

    prior_account_id = doc.get("account_id")
    prior_import_id = import_id

    # 1) Cascade-delete the reconciliation + txns from this import BEFORE
    #    we re-run so `_signed_balances` doesn't count them against the
    #    resolver's re-decision.
    try:
        from reconciliation_engine import delete_reconciliation_for_statement_import
        await delete_reconciliation_for_statement_import(cid, prior_import_id)
    except Exception:  # noqa: BLE001
        pass
    await db.transactions.delete_many({
        "company_id": cid, "statement_import_id": prior_import_id,
    })

    # 2) If the prior auto-created CoA row is now orphaned (no other
    #    imports, no journal entries, no manual txns), remove it — this
    #    is what turns "Amex Checking" into a phantom that clutters the
    #    CoA forever otherwise.
    coa_row_deleted = None
    if prior_account_id:
        acct = await db.accounts.find_one({"id": prior_account_id, "company_id": cid})
        was_auto = bool(acct and (acct.get("created_by_ai") or acct.get("source") in
                                  ("veryfi_statement", "plaid_link")))
        if was_auto:
            other_txn = await db.transactions.count_documents({
                "company_id": cid, "bank_account_id": prior_account_id,
            })
            other_txn2 = await db.transactions.count_documents({
                "company_id": cid, "category_account_id": prior_account_id,
            })
            other_je = await db.journal_entries.count_documents({
                "company_id": cid, "lines.account_id": prior_account_id,
            })
            other_imports = await db.statement_imports.count_documents({
                "company_id": cid, "account_id": prior_account_id,
                "id": {"$ne": prior_import_id},
            })
            if other_txn + other_txn2 + other_je + other_imports == 0:
                await db.accounts.delete_one({"id": prior_account_id})
                coa_row_deleted = f"{acct.get('code')} {acct.get('name')}"

    # 3) Flip the import row back to "processing" and re-run the resolver
    #    with the new hint. Same code path the initial upload uses.
    await db.statement_imports.update_one(
        {"id": prior_import_id},
        {"$set": {"status": "processing", "account_id": None, "account_name": None,
                  "updated_at": now_iso()}},
    )

    resolved = await statement_account_resolver.resolve_statement_account(
        cid, veryfi_data, account_kind_hint=account_kind_hint,
    )
    bank_account_id = resolved["account_id"]
    bank_acct = await db.accounts.find_one({"id": bank_account_id})

    # 4) Re-run the categorize+insert loop on the cached candidates.
    lines = veryfi_service.extract_transactions(veryfi_data)
    # Apply the same OCR sanity guards on re-run so a bank-hint fix
    # never smuggles phantom rows back in. Aug 23 2026.
    lines, _dropped_rows2 = _apply_veryfi_row_guards(lines)
    lines, _dup_flagged2 = _apply_veryfi_dup_guard(lines)
    if _dup_flagged2:
        _dropped_rows2["duplicate_row_flagged"] = _dup_flagged2
    _reconcile_flag2 = _statement_ocr_reconcile(veryfi_data, lines, _dropped_rows2)

    # Recompute the statement period from the (now year-corrected) txn
    # dates, applying the same sanity check as the initial upload path:
    # if Veryfi's header range is > 45 days (year-wrap symptom), trust
    # the transaction-derived boundaries instead.
    _txn_dates = sorted([ln["date"] for ln in lines if ln.get("date")])
    _txn_min = _txn_dates[0] if _txn_dates else None
    _txn_max = _txn_dates[-1] if _txn_dates else None
    _v_start = veryfi_data.get("period_start_date") or veryfi_data.get("start_date")
    _v_end = (veryfi_data.get("period_end_date")
              or veryfi_data.get("end_date")
              or veryfi_data.get("statement_date"))
    try:
        if _v_start and _v_end:
            _span = (datetime.fromisoformat(str(_v_end)[:10])
                     - datetime.fromisoformat(str(_v_start)[:10])).days
            if _span > 45 and _txn_min and _txn_max:
                _v_start = None
                _v_end = veryfi_data.get("statement_date") or None
    except Exception:  # noqa: BLE001
        pass
    if _v_start and _txn_min and _v_start > _txn_min:
        _period_start = _txn_min
    else:
        _period_start = _v_start or _txn_min
    if _v_end and _txn_max and _v_end < _txn_max:
        _period_end = _txn_max
    else:
        _period_end = _v_end or _txn_max

    # Build coa + accts for the shared insertion pipeline.
    _accts = await db.accounts.find({"company_id": cid}).to_list(2000)
    _coa = [{"code": a["code"], "name": a["name"], "type": a["type"]} for a in _accts]

    # Re-shape lines with the fields _categorize_and_insert_veryfi_lines
    # expects (matching the enrichment done in upload_statement).
    _candidates = [{
        "date": ln["date"] or datetime.now(timezone.utc).date().isoformat(),
        "description": f"{ln['description']} (Veryfi)"
                       if not ln.get("description", "").endswith("(Veryfi)")
                       else ln["description"],
        "merchant": ln["merchant"],
        "merchant_name": ln["merchant"],
        "amount": ln["amount"],
        "bank_account_id": bank_account_id,
        "bank_account_name": bank_acct["name"],
    } for ln in lines]

    imported, skipped_closed = await _categorize_and_insert_veryfi_lines(
        cid, _candidates, bank_acct, _coa, _accts,
        categorize_fn=categorize_fn,
        is_period_closed_fn=is_period_closed_fn,
        import_id=prior_import_id,
    )

    # 5) Finalize the import row — mirror the same update the initial
    #    upload does so the Uploads table shows the corrected metadata.
    await db.statement_imports.update_one(
        {"id": prior_import_id},
        {"$set": {
            "status": "completed",
            "transaction_count": imported,
            "skipped_closed": skipped_closed,
            "account_id": bank_account_id,
            "account_name": bank_acct["name"],
            "account_code": bank_acct["code"],
            "account_matched": resolved["matched"],
            "period_start": _period_start,
            "period_end": _period_end,
            "reprocessed_at": now_iso(),
            "reprocess_hint": account_kind_hint,
            "ocr_reconcile_flag": _reconcile_flag2,
            "ocr_dropped_rows": _dropped_rows2 or None,
            "updated_at": now_iso(),
        }},
    )

    # 6) Re-anchor the OBE JE for the freshly-linked account.
    try:
        import opening_balance_service as obs
        await obs.ensure_opening_balance_for_account(cid, bank_account_id)
    except Exception:  # noqa: BLE001
        pass

    # 7) Re-run the auto-reconciliation. The initial-upload path does this
    #    at end of `upload_statement`, but reprocess also deletes the prior
    #    recon (step 1) so we must recreate it — otherwise the user is left
    #    with an "unreconciled" liability card after a reprocess even though
    #    the ledger and statement tie perfectly. Fire-and-forget: any recon
    #    failure must NOT block the reprocess flow, we log and move on.
    try:
        from reconciliation_engine import create_reconciliation_from_statement_import
        await create_reconciliation_from_statement_import(cid, prior_import_id)
    except Exception:  # noqa: BLE001
        import logging as _log
        _log.getLogger(__name__).exception(
            "Reprocess: auto-reconciliation regeneration failed for import %s",
            prior_import_id,
        )

    return {
        "import_id": prior_import_id,
        "reinserted": imported,
        "coa_row_deleted": coa_row_deleted,
        "new_account_id": bank_account_id,
        "new_account_name": bank_acct["name"],
        "new_account_type": bank_acct.get("type"),
    }
