"""Per-item-type answer handlers for the batch client review flow.

Each of the 9 item types has a small handler that takes the client's
answer and applies it — closing the source finding, categorizing the
transaction, marking a W-9 as requested, etc. All handlers share a
common contract:

    async def handle(item: dict, batch: dict, *,
                     answer: str, payload: dict) -> dict

  * `item`     — the item dict from `batch.items`
  * `batch`    — the parent batch (for company_id / actor context)
  * `answer`   — the client's plain-language reply
  * `payload`  — structured data extracted by the AI (category id,
                 split percentages, uploaded doc id, etc.)

Handlers return `{"action_taken": "...", "detail": "..."}` — that
string is stamped onto the item and shown in the end-screen summary.

Deferral has a single generic handler regardless of type: mark the
item deferred, mark the source finding `status="dismissed"` with a
`client_deferred` tag, so the Today V2 "Judgment" section picks it up
with the `CLIENT DEFERRED` badge (Milestone F).
"""
from __future__ import annotations
import logging
import uuid
from datetime import datetime, timezone

from deps import db
import client_review as cr

logger = logging.getLogger("axiom.client_review.handlers")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


async def _close_source_finding(item: dict, *, resolved_by: str) -> None:
    """Mark a source `agent_findings` row resolved. Idempotent — a
    finding already resolved by another actor stays resolved."""
    if item.get("source_collection") != "agent_findings":
        return
    await db.agent_findings.update_one(
        {"id": item["source_id"]},
        {"$set": {"status":       "resolved",
                  "resolved_at":  _now_iso(),
                  "resolved_by":  resolved_by,
                  "updated_at":   _now_iso()}},
    )


async def _defer_source_finding(item: dict, *, note: str | None = None) -> None:
    """Mark the source finding as `dismissed` with the `client_deferred`
    tag. The pro-side Today V2 picks these up in the Judgment section
    with a special badge (Milestone F).
    """
    if item.get("source_collection") != "agent_findings":
        return
    await db.agent_findings.update_one(
        {"id": item["source_id"]},
        {"$set": {
            "status":              "dismissed",
            "dismissed_at":        _now_iso(),
            "dismissed_by":        "client:deferred",
            "client_deferred":     True,
            "client_deferred_at":  _now_iso(),
            "client_deferred_note": note or "",
            "updated_at":          _now_iso(),
        }},
    )


# --------------------------------------------------------------------------
# Item 1 — uncategorized transaction
# --------------------------------------------------------------------------

async def _handle_uncategorized(item: dict, batch: dict, *,
                                answer: str, payload: dict) -> dict:
    """Client tells us what a transaction was for. Two paths:

    * `flow == "receipt_categorization"` — client tapped "Use this split"
      after the AI ran GPT-4o vision on the uploaded receipt. Post a
      proper multi-line SPLIT on the transaction so the ledger shows
      one row per Chart-of-Accounts bucket (Materials · Lumber $221.78,
      Small Tools $99.00, Materials · Concrete $69.80, …) without a
      bookkeeper touch.
    * Otherwise — if the AI mapped the plain-text answer to a concrete
      account_id, single-category it; else stash the answer as
      `ai_comment` and keep `needs_review=True` for the pro.
    """
    txn_id = item["source_id"]
    payload = payload or {}
    flow = payload.get("flow")
    company_id = batch["company_id"]

    base_updates: dict = {
        "client_answer":       answer,
        "client_answered_at":  _now_iso(),
        "ai_comment":          f"[Client answered {_now_iso()[:10]}]: {answer}",
        "updated_at":          _now_iso(),
    }

    # ── Multi-line split from the AI's receipt categorization ──────
    if flow == "receipt_categorization":
        # Prefer per-line-item splits (one ledger row per receipt item)
        # so the pro sees the FULL receipt detail on the transaction,
        # not just per-account subtotals. Falls back to the grouped
        # `suggested_categories` if line_items are missing.
        lines = payload.get("line_items") or []
        cats  = payload.get("suggested_categories") or []
        source_rows = lines if lines else cats
        if source_rows:
            txn = await db.transactions.find_one(
                {"id": txn_id, "company_id": company_id},
                {"amount": 1, "date": 1, "merchant": 1, "description": 1,
                 "contact_id": 1, "contact_name": 1},
            )
            if not txn:
                return {"action_taken": "noop",
                        "detail": "Transaction not found — nothing to split"}
            # Resolve every proposed account to a real chart-of-accounts row.
            #   1. Exact code match  (AI's "5100" wins if the client has 5100).
            #   2. Exact case-insensitive name match.
            #   3. Semantic contains-match ("Materials · Lumber"
            #      matches "Lumber" or "Materials").
            #   4. Auto-create a new expense account using the AI's
            #      proposed code + name (marked `auto_created_by:
            #      "client_review_vision"` so pros can review or rename
            #      later without losing history).
            accts = await db.accounts.find(
                {"company_id": company_id},
                {"id": 1, "code": 1, "name": 1, "type": 1,
                 "parent_id": 1, "is_active": 1},
            ).to_list(2000)
            by_code = {a.get("code"): a for a in accts if a.get("code")}
            by_name = {(a.get("name") or "").strip().lower(): a for a in accts}

            def _semantic_match(proposed_name: str):
                """Fuzzy: return an account whose name shares any 4+ character
                token with `proposed_name`. Cheap approximation of a real
                embedding match — good enough to catch "Materials · Lumber"
                → "Materials", "Small Tools" → "Tools Expense", etc."""
                if not proposed_name:
                    return None
                tokens = [t.strip().lower() for t in
                          proposed_name.replace("·", " ")
                                       .replace("&", " ")
                                       .replace("/", " ").split()
                          if len(t.strip()) >= 4]
                best = None
                for a in accts:
                    if a.get("type") not in ("expense", "cogs",
                                             "cost of goods sold",
                                             "other expense"):
                        continue
                    nm = (a.get("name") or "").lower()
                    hits = sum(1 for t in tokens if t in nm)
                    if hits and (not best or hits > best[0]):
                        best = (hits, a)
                return best[1] if best else None

            auto_created: dict[str, dict] = {}   # code → newly-created acct doc
            async def _get_or_create_account(code: str | None, name: str | None):
                """Return an account doc; auto-create an expense account if
                nothing sensible matches. Never returns None (would
                otherwise force a fallback dump into Uncategorized)."""
                # (1) Exact code match
                if code and code in by_code:
                    return by_code[code]
                # (2) Exact name match
                nm_key = (name or "").strip().lower()
                if nm_key and nm_key in by_name:
                    return by_name[nm_key]
                # (3) Semantic contains-match
                sem = _semantic_match(name or "")
                if sem:
                    return sem
                # (4) Auto-create. Use the AI's code if it's not
                # already taken; otherwise mint a fresh code in the
                # 5000-5999 expense range that doesn't collide.
                if not name:
                    return None
                if code in auto_created:
                    return auto_created[code]
                use_code = code if code and code not in by_code else None
                if not use_code:
                    # find next free 5xxx code
                    used = {int(a.get("code")) for a in accts
                            if (a.get("code") or "").isdigit()}
                    for k in range(5000, 5999):
                        if k not in used:
                            use_code = str(k); break
                acct_id = str(uuid.uuid4())
                new_acct = {
                    "id":          acct_id,
                    "company_id":  company_id,
                    "code":        use_code,
                    "name":        name,
                    "type":        "expense",
                    "is_active":   True,
                    "auto_created_by": "client_review_vision",
                    "created_at":  _now_iso(),
                    "updated_at":  _now_iso(),
                }
                await db.accounts.insert_one(new_acct)
                by_code[use_code] = new_acct
                by_name[name.strip().lower()] = new_acct
                accts.append(new_acct)
                auto_created[use_code] = new_acct
                return new_acct

            txn_amount = float(txn["amount"] or 0)
            # Expense receipts land as NEGATIVE txn amounts. The AI
            # returns positive bucket amounts, so we mirror the sign.
            sign = -1.0 if txn_amount < 0 else 1.0

            resolved: list[dict] = []
            for row in source_rows:
                amt = round(abs(float(row.get("amount") or 0)), 2)
                if amt <= 0:
                    continue
                code = row.get("account_code")
                nm   = row.get("account_name")
                acct = await _get_or_create_account(code, nm)
                if not acct:
                    return await _annotate_only(txn_id, company_id, answer,
                                                base_updates)
                # description: prefer the line's own text (e.g.
                # "4X4X8 PT POST") — fall back to the account name.
                desc = str(row.get("description") or nm or "")[:80]
                resolved.append({
                    "amount":                round(sign * amt, 2),
                    "category_account_id":   acct["id"],
                    "category_account_code": acct.get("code") or "",
                    "category_account_name": acct.get("name") or "",
                    "description":           desc,
                })
            if not resolved:
                return await _annotate_only(txn_id, company_id, answer,
                                            base_updates)

            # Reconcile to the penny. Vision can drift $0.01-0.02 on
            # sales-tax rounding; push the drift onto the LARGEST bucket
            # so the split totals match the bank-feed amount exactly.
            total = round(sum(s["amount"] for s in resolved), 2)
            drift = round(txn_amount - total, 2)
            if abs(drift) > 0.005:
                biggest = max(resolved, key=lambda s: abs(s["amount"]))
                biggest["amount"] = round(biggest["amount"] + drift, 2)

            # Semantic-resolve the contact off the txn's merchant/description
            # so posting a Q1 split ALSO stamps the counterparty on the
            # ledger row — mirrors the edit-modal auto-fill and eliminates
            # the "?" contact chip on the transactions list after a client
            # confirms a categorization via the magic link.
            contact_updates: dict = {}
            if not txn.get("contact_id"):
                try:
                    import contact_resolver
                    from ai_service import resolve_contact_ai
                    resolved_c = await contact_resolver.resolve_contact(
                        company_id=company_id,
                        merchant_name=(txn.get("merchant") or "").strip() or None,
                        description=txn.get("description") or None,
                        ai_fallback_fn=resolve_contact_ai,
                        original_description=txn.get("description") or None,
                        entry_source="client_review",
                    )
                    if resolved_c.get("contact_id"):
                        contact_updates = {
                            "contact_id":   resolved_c["contact_id"],
                            "contact_name": resolved_c.get("contact_name") or "",
                        }
                except Exception:  # noqa: BLE001
                    # Contact stamping is best-effort — the split itself
                    # must always post regardless.
                    contact_updates = {}

            await db.transactions.update_one(
                {"id": txn_id, "company_id": company_id},
                {"$set": {**base_updates,
                          **contact_updates,
                          "splits":              resolved,
                          "human_reviewed":      True,
                          "needs_review":        False,
                          "posted":              True,
                          # Clear any prior single category — splits win.
                          "category_account_id": None,
                          "category_account_code": None,
                          "category_account_name": None,
                          "split_source":       "client_review_vision",
                          "split_narrative":    payload.get("narrative") or ""}},
            )
            # Invalidate dashboard cache so the CPA sees the new split
            # immediately without a manual refresh.
            try:
                from routes.transactions import _invalidate_dash
                await _invalidate_dash(company_id)
            except Exception:  # noqa: BLE001
                pass
            summary_bits: list[str] = []
            for s in resolved:
                summary_bits.append(
                    f"{s['category_account_name']} ${abs(s['amount']):.2f}"
                )
            detail = f"Posted split: {', '.join(summary_bits)}"
            if auto_created:
                detail += (f" · auto-created "
                           f"{len(auto_created)} new account"
                           f"{'s' if len(auto_created) != 1 else ''}: "
                           + ", ".join(f"{a.get('code')} · {a.get('name')}"
                                       for a in auto_created.values()))
            return {"action_taken": "split_categorized",
                    "detail":       detail,
                    "auto_created_accounts": [
                        {"id": a["id"], "code": a["code"], "name": a["name"]}
                        for a in auto_created.values()
                    ]}

    # ── Fallback: single-category answer from AI mapping ───────────
    account_id   = payload.get("account_id")
    account_name = payload.get("account_name")
    updates = dict(base_updates)
    if account_id:
        updates.update({
            "category_account_id":   account_id,
            "category_account_name": account_name or "",
            "needs_review":          False,
            "human_reviewed":        True,
        })
    await db.transactions.update_one(
        {"id": txn_id, "company_id": company_id}, {"$set": updates},
    )
    if account_id:
        return {"action_taken": "categorized",
                "detail": f"Categorized as {account_name or account_id}"}
    return {"action_taken": "annotated",
            "detail": "Saved your note — your bookkeeper will finalize"}


async def _annotate_only(txn_id: str, company_id: str,
                          answer: str, base_updates: dict) -> dict:
    """Fallback path when we can't resolve any COA account: stash the
    client's note on the txn and leave it for the pro to finish."""
    await db.transactions.update_one(
        {"id": txn_id, "company_id": company_id}, {"$set": base_updates},
    )
    return {"action_taken": "annotated",
            "detail": "Saved your note — your bookkeeper will finalize"}


# --------------------------------------------------------------------------
# Items 2–8 — generic finding closer with a stored answer
# --------------------------------------------------------------------------

async def _handle_generic_finding(item: dict, batch: dict, *,
                                  answer: str, payload: dict) -> dict:
    """For most agent-findings-backed items, the workflow is: close the
    finding, stash the client's answer, and let the pro-side pick up
    any downstream action (creating a merchant rule, attaching a W-9
    PDF, etc.).

    Structured payload (`payload`) is stored on the finding's `meta`
    so the pro sees what was proposed alongside the raw answer.
    """
    await _close_source_finding(item, resolved_by="client:answered")
    if item.get("source_collection") == "agent_findings":
        await db.agent_findings.update_one(
            {"id": item["source_id"]},
            {"$set": {
                "client_answer":       answer,
                "client_answered_at":  _now_iso(),
                "meta.client_payload": payload or {},
            }},
        )
    return {"action_taken": "answered",
            "detail": (answer[:120] + "…") if len(answer) > 120 else answer}


# --------------------------------------------------------------------------
# Item 4 — W-9 collection
# --------------------------------------------------------------------------

async def _handle_w9_needed(item: dict, batch: dict, *,
                            answer: str, payload: dict) -> dict:
    """Three sub-flows:
      * `follow_up`: client asked us to reach out to the vendor — flag
        the contact for the Milestone G outbound flow, keep the
        finding open so the CPA sees the state.
      * `attached`: W-9 PDF was uploaded — stamp `w9_on_file=True`
        on the contact and close the finding.
      * `provided_fields`: client typed the vendor's info inline — same
        as `attached` (stamp + close).
    """
    payload   = payload or {}
    flow      = payload.get("flow")
    contact_id = ((item.get("context") or {}).get("meta") or {}).get("contact_id") \
                 or payload.get("contact_id")
    if not contact_id:
        # Fallback: look up on the source finding
        f = await db.agent_findings.find_one({"id": item["source_id"]})
        if f:
            contact_id = f.get("contact_id")

    if flow == "follow_up" and contact_id:
        await db.contacts.update_one(
            {"id": contact_id, "company_id": batch["company_id"]},
            {"$set": {
                "w9_follow_up_requested":    True,
                "w9_follow_up_requested_at": _now_iso(),
                "w9_follow_up_note":         answer,
                "updated_at":                _now_iso(),
            }},
        )
        # Do NOT close the finding — the pending state is visible until
        # the outbound follow-up completes (built in Milestone G).
        if item.get("source_collection") == "agent_findings":
            await db.agent_findings.update_one(
                {"id": item["source_id"]},
                {"$set": {
                    "meta.follow_up_requested": True,
                    "meta.follow_up_note":      answer,
                    "client_answer":            answer,
                    "client_answered_at":       _now_iso(),
                }},
            )
        # Milestone G — kick off the vendor outreach engine immediately.
        # Autonomous: first email fires right now if we have a vendor
        # email on file; otherwise the engine emits a
        # `vendor_email_missing` task for the pro/client to fill in.
        try:
            import vendor_outreach as vo
            await vo.start_outreach_for_contact(
                company_id=batch["company_id"],
                contact_id=contact_id,
                agent_finding_id=item.get("source_id"),
                batch_id=batch.get("id"),
            )
        except Exception:  # noqa: BLE001 — never fail the client-facing action
            logger.exception("vendor_outreach kickoff failed for contact %s",
                             contact_id)
        return {"action_taken": "follow_up_requested",
                "detail": "We'll reach out to the vendor directly"}

    # W-9 attached OR provided inline → mark on file, close finding.
    if contact_id:
        await db.contacts.update_one(
            {"id": contact_id, "company_id": batch["company_id"]},
            {"$set": {"w9_on_file":  True,
                      "w9_added_at": _now_iso(),
                      "updated_at":  _now_iso()}},
        )
    return await _handle_generic_finding(item, batch, answer=answer,
                                         payload=payload)


# --------------------------------------------------------------------------
# Item 2 — vendor / memo confirmation (descriptor → contact aliases)
# --------------------------------------------------------------------------

async def _handle_vendor_memo(item: dict, batch: dict, *,
                              answer: str, payload: dict) -> dict:
    """New shape (Sep 2026): `flow: "descriptor_aliases"` carrying a
    list of `bindings` — one row per unique bank-feed descriptor the
    client just confirmed.

    Each binding must have `descriptor_key` (already normalized on the
    client via the resolver's helper) PLUS either:
      * `contact_id` — an existing contact this alias should attach to; OR
      * `create_name` — a new contact name to auto-create.

    For every accepted binding we:
      1. Upsert the alias onto the contact (`$addToSet`).
      2. Backfill every existing transaction in the company whose
         normalized descriptor matches → stamp `contact_id`+`contact_name`.
      3. Record the linkage on the source finding so the Communications
         thread shows exactly what was confirmed.

    Falls back to the legacy single-transaction confirm path when the
    payload doesn't carry the new `descriptor_aliases` flow — so older
    batches that still use the pre-Sep-2026 shape keep working.
    """
    payload = payload or {}
    flow    = payload.get("flow")
    if flow != "descriptor_aliases":
        return await _handle_generic_finding(item, batch, answer=answer,
                                             payload=payload)

    bindings = payload.get("bindings") or []
    company_id = batch["company_id"]
    if not bindings:
        return await _handle_generic_finding(item, batch, answer=answer,
                                             payload=payload)

    # Local import — avoids circular ref at module load.
    import contact_resolver
    from contact_resolver import normalize_descriptor, normalize_contact_name

    accepted: list[dict] = []
    total_backfilled = 0

    for b in bindings:
        raw_desc  = (b.get("descriptor") or "").strip()
        desc_key  = (b.get("descriptor_key") or "").strip().lower() \
                    or normalize_descriptor(raw_desc)
        if not desc_key:
            continue
        # Skip anything the client explicitly marked as ambiguous — no
        # alias, no backfill. Their choice is recorded on the finding
        # for auditability.
        if b.get("skip") or b.get("ambiguous"):
            accepted.append({
                "descriptor_key": desc_key,
                "descriptor":     raw_desc,
                "skipped":        True,
            })
            continue

        contact_id = b.get("contact_id")
        create_name = (b.get("create_name") or "").strip()

        # Create the contact if requested.
        if not contact_id and create_name:
            existing = await db.contacts.find_one(
                {"company_id": company_id,
                 "normalized_name": normalize_contact_name(create_name)},
                {"id": 1, "name": 1},
            )
            if existing:
                contact_id = existing["id"]
                contact_name = existing["name"]
            else:
                created = await contact_resolver._insert_contact(
                    company_id, create_name, source="client_review_alias",
                )
                contact_id = created["id"]
                contact_name = created["name"]
        elif contact_id:
            c = await db.contacts.find_one(
                {"id": contact_id, "company_id": company_id},
                {"name": 1},
            )
            contact_name = (c or {}).get("name") or ""
        else:
            # Nothing actionable — skip this row (no contact, no create).
            continue

        # 1. Upsert alias on the contact.
        await db.contacts.update_one(
            {"id": contact_id, "company_id": company_id},
            {"$addToSet": {"descriptor_aliases": desc_key},
             "$set":      {"updated_at": _now_iso()}},
        )

        # 2. Backfill matching transactions — every existing txn in this
        #    company whose (freshly normalized) descriptor matches the
        #    new alias picks up the contact stamp. We recompute on the
        #    fly because most txns don't yet have `descriptor_key`.
        cursor = db.transactions.find(
            {"company_id": company_id,
             "$or": [{"contact_id": {"$exists": False}},
                     {"contact_id": None},
                     {"contact_id": ""}]},
            {"id": 1, "description": 1, "merchant": 1},
        )
        matched_ids: list[str] = []
        async for t in cursor:
            key = normalize_descriptor(t.get("description")) \
                  or normalize_descriptor(t.get("merchant"))
            if key == desc_key:
                matched_ids.append(t["id"])
        if matched_ids:
            await db.transactions.update_many(
                {"id": {"$in": matched_ids}, "company_id": company_id},
                {"$set": {"contact_id":     contact_id,
                          "contact_name":   contact_name,
                          "descriptor_key": desc_key,
                          "updated_at":     _now_iso()}},
            )
            total_backfilled += len(matched_ids)

        accepted.append({
            "descriptor_key":   desc_key,
            "descriptor":       raw_desc,
            "contact_id":       contact_id,
            "contact_name":     contact_name,
            "backfilled_count": len(matched_ids),
        })

    # 3. Record the resolution on the source finding.
    if item.get("source_collection") == "agent_findings":
        await db.agent_findings.update_one(
            {"id": item["source_id"]},
            {"$set": {
                "status":               "resolved",
                "client_answer":        answer,
                "client_answered_at":   _now_iso(),
                "meta.bindings_resolved": accepted,
                "meta.total_backfilled":  total_backfilled,
            }},
        )
    # Cache-invalidate dash so the CPA sees the newly-linked contacts
    # on the transactions list immediately.
    try:
        from routes.transactions import _invalidate_dash
        await _invalidate_dash(company_id)
    except Exception:  # noqa: BLE001
        pass
    return {
        "action_taken":       "descriptor_aliases_applied",
        "detail":             f"Bound {len(accepted)} descriptor{'s' if len(accepted) != 1 else ''} → "
                              f"{total_backfilled} transaction{'s' if total_backfilled != 1 else ''} re-linked",
        "accepted":           accepted,
        "total_backfilled":   total_backfilled,
    }


# --------------------------------------------------------------------------
# Item 15 — AI auto-cleanup confirmation
# --------------------------------------------------------------------------

async def _handle_ai_cleanup(item: dict, batch: dict, *,
                             answer: str, payload: dict) -> dict:
    """Client confirms whether the AI's auto-relabel was correct.

    Answer semantics (interpreted case-insensitively):
      • 'yes' / 'correct' / 'looks right'  → acknowledge the pattern(s)
      • 'no' / 'wrong' / 'undo' / 'incorrect' → undo the pattern(s)
      • anything else → store as a plain answer for the CPA to review

    Bundled cards (see `_collect_ai_cleanup`) carry many `applied_ids`;
    we fan the same yes/no across all of them so the client confirms
    12 rows in one tap. Solo cards behave as before.
    """
    ctx = item.get("context") or {}
    applied_ids = ctx.get("applied_ids") or (
        [ctx.get("applied_id") or item.get("source_id")]
        if (ctx.get("applied_id") or item.get("source_id")) else [])
    applied_ids = [a for a in applied_ids if a]
    if not applied_ids:
        return {"action_taken": "noop",
                "detail": "No applied_ids on item"}

    now = _now_iso()
    positive = {"yes", "correct", "looks right", "right", "confirm",
                "confirmed", "ok", "okay", "yes, that's right"}
    negative = {"no", "wrong", "undo", "not right", "not correct",
                "incorrect", "revert", "no, that's wrong"}
    a_norm = (answer or "").strip().lower()

    async def _handle_one(applied_id: str, mode: str) -> int:
        rec = await db.contact_cleanup_applied.find_one({"id": applied_id})
        if not rec:
            return 0
        if mode == "undo":
            prev = rec.get("previous_labels") or {}
            for txn_id, snap in prev.items():
                await db.transactions.update_one(
                    {"company_id": rec["company_id"], "id": txn_id},
                    {"$set": {"contact_id":   snap.get("contact_id"),
                              "contact_name": snap.get("contact_name"),
                              "updated_at":   now}},
                )
            await db.contact_cleanup_dismissed.update_one(
                {"company_id":     rec["company_id"],
                 "contact_id":     rec.get("contact_id"),
                 "descriptor_key": rec.get("descriptor_key")},
                {"$set": {"updated_at": now,
                          "reason": "client_rejected_via_checkin"},
                 "$setOnInsert": {"created_at": now}},
                upsert=True,
            )
            await db.contact_cleanup_applied.update_one(
                {"id": applied_id},
                {"$set": {"status": "undone", "undone_at": now,
                          "undone_via": "client_checkin"}},
            )
            return int(rec.get("count") or 0)
        # positive path
        await db.contact_cleanup_applied.update_one(
            {"id": applied_id},
            {"$set": {"status": "acknowledged",
                      "acknowledged_at": now,
                      "acknowledged_via": "client_checkin"}},
        )
        return int(rec.get("count") or 0)

    if a_norm in negative:
        total = 0
        for aid in applied_ids:
            total += await _handle_one(aid, "undo")
        return {"action_taken": "undone",
                "detail": (f"Reverted {total} row(s) across "
                           f"{len(applied_ids)} pattern"
                           f"{'' if len(applied_ids) == 1 else 's'}")}

    if a_norm in positive:
        total = 0
        for aid in applied_ids:
            total += await _handle_one(aid, "ack")
        return {"action_taken": "acknowledged",
                "detail": (f"Confirmed {total} row(s) across "
                           f"{len(applied_ids)} pattern"
                           f"{'' if len(applied_ids) == 1 else 's'} "
                           f"as {ctx.get('contact_name')}")}

    # Free-text response — store as an answer, leave statuses untouched
    # so the CPA can decide from the Cockpit dropdown.
    for aid in applied_ids:
        await db.contact_cleanup_applied.update_one(
            {"id": aid},
            {"$set": {"client_note": answer, "client_note_at": now}},
        )
    return {"action_taken": "answered",
            "detail": (answer[:120] + "…") if len(answer) > 120 else answer}


# --------------------------------------------------------------------------
# Router
# --------------------------------------------------------------------------

_HANDLERS = {
    cr.ITEM_UNCATEGORIZED:      _handle_uncategorized,
    cr.ITEM_VENDOR_MEMO:        _handle_vendor_memo,
    cr.ITEM_MISSING_RECEIPT:    _handle_generic_finding,
    cr.ITEM_W9_NEEDED:          _handle_w9_needed,
    cr.ITEM_AMBIGUOUS_TRANSFER: _handle_generic_finding,
    cr.ITEM_RECURRING:          _handle_generic_finding,
    cr.ITEM_SETUP:              _handle_generic_finding,
    cr.ITEM_SPLIT:              _handle_generic_finding,
    cr.ITEM_LIABILITY_SPLIT:    _handle_generic_finding,
    cr.ITEM_AI_CLEANUP:         _handle_ai_cleanup,
}


async def apply_answer(item: dict, batch: dict, *,
                       answer: str, payload: dict | None = None) -> dict:
    """Route to the right handler by item type. Callers get back the
    same `{action_taken, detail}` shape regardless of item type.
    """
    handler = _HANDLERS.get(item.get("item_type"))
    if not handler:
        return {"action_taken": "noop",
                "detail": f"No handler for item_type={item.get('item_type')!r}"}
    return await handler(item, batch, answer=answer, payload=payload or {})


async def apply_deferral(item: dict, batch: dict, *,
                         note: str | None = None) -> dict:
    """Client hit 'not sure — send to my bookkeeper'. Same for every
    item type: close the source with `client_deferred` so it surfaces
    in Today V2 (Milestone F), stamp the item.
    """
    if item.get("source_collection") == "transactions":
        # Item 1 — uncategorized transaction. Leave `needs_review=True`
        # so the pro's queue keeps it; add a comment so context isn't
        # lost.
        await db.transactions.update_one(
            {"id": item["source_id"], "company_id": batch["company_id"]},
            {"$set": {
                "client_deferred":     True,
                "client_deferred_at":  _now_iso(),
                "client_deferred_note": note or "",
                "ai_comment":          "[Client deferred — needs bookkeeper]",
                "updated_at":          _now_iso(),
            }},
        )
    else:
        await _defer_source_finding(item, note=note)
    return {"action_taken": "deferred",
            "detail": "Sent to your bookkeeper for a closer look"}


__all__ = ["apply_answer", "apply_deferral"]
