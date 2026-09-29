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
import re
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
    """Client tells us what a transaction was for. Three paths:

    * GROUPED card (Phase 2) — `item.context.grouped == True` OR the
      draft/payload carries `txn_ids` (a list). Books ALL txns in the
      group to a single `category_account_id` via `update_many`,
      identical to Review Chat's `chat-review-book` behaviour. Reuses
      Review Chat's brain, guarantees identical GL outcomes.
    * `flow == "receipt_categorization"` — client tapped "Use this split"
      after the AI ran GPT-4o vision on the uploaded receipt. Post a
      proper multi-line SPLIT on the transaction so the ledger shows
      one row per Chart-of-Accounts bucket without a bookkeeper touch.
    * Otherwise — if the AI mapped the plain-text answer to a concrete
      account_id, single-category it; else stash the answer as
      `ai_comment` and keep `needs_review=True` for the pro.
    """
    payload = payload or {}
    company_id = batch["company_id"]

    # ── Phase 2: grouped (Review-Chat-style) bulk categorize ──────
    ctx = item.get("context") or {}
    txn_ids = payload.get("txn_ids") or (ctx.get("txn_ids") if ctx.get("grouped") else None)
    category_account_id = payload.get("category_account_id")
    contact_id_override = payload.get("contact_id")
    if txn_ids and category_account_id:
        acct = await db.accounts.find_one(
            {"id": category_account_id, "company_id": company_id},
            {"id": 1, "name": 1, "code": 1},
        )
        if not acct:
            return {"action_taken": "noop",
                    "detail": f"Category account {category_account_id} not found"}
        set_doc: dict = {
            "category_account_id":   acct["id"],
            "category_account_name": acct.get("name") or "",
            "category_account_code": acct.get("code") or "",
            "needs_review":          False,
            "human_reviewed":        True,
            "posted":                True,
            "client_answer":         answer,
            "client_answered_at":    _now_iso(),
            "ai_source":             "client_review_grouped",
            "ai_comment":            (f"[Client answered {_now_iso()[:10]}]: {answer}"
                                       if answer else "Booked via Quick Check-in group"),
            "updated_at":            _now_iso(),
        }
        if contact_id_override:
            c = await db.contacts.find_one(
                {"id": contact_id_override, "company_id": company_id},
                {"id": 1, "name": 1},
            )
            if c:
                set_doc["contact_id"]   = c["id"]
                set_doc["contact_name"] = c.get("name") or ""
        res = await db.transactions.update_many(
            {"id": {"$in": txn_ids}, "company_id": company_id},
            {"$set": set_doc},
        )
        # Optional: save a contact-direction auto-rule if the client
        # opted in ("always do this"). Mirrors Review Chat's behaviour.
        if payload.get("save_as_rule") and ctx.get("contact_id"):
            try:
                await db.rules.update_one(
                    {"company_id": company_id,
                     "kind": "contact_direction",
                     "contact_id": ctx["contact_id"],
                     "direction": ctx.get("direction") or "out"},
                    {"$set": {
                        "company_id": company_id,
                        "kind": "contact_direction",
                        "contact_id": ctx["contact_id"],
                        "direction": ctx.get("direction") or "out",
                        "category_account_id": acct["id"],
                        "category_account_name": acct.get("name"),
                        "created_by": "client_review",
                        "created_at": _now_iso(),
                    }},
                    upsert=True,
                )
            except Exception:  # noqa: BLE001
                pass
        try:
            from routes.transactions import _invalidate_dash
            await _invalidate_dash(company_id)
        except Exception:  # noqa: BLE001
            pass
        return {"action_taken": "grouped_categorized",
                "detail": (f"Booked {res.modified_count} transaction"
                           f"{'s' if res.modified_count != 1 else ''} "
                           f"to {acct.get('name')}"
                           + (" · auto-rule saved" if payload.get("save_as_rule") else ""))}

    # ── Legacy single-txn path continues below ─────────────────────
    txn_id = item["source_id"]
    flow = payload.get("flow")
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


async def _handle_irs_substantiation(item: dict, batch: dict, *,
                                     answer: str, payload: dict) -> dict:
    """Meals (§274) and Travel (§274) compliance items.

    Beyond the generic "close finding + stash payload" path, we also
    stamp the source transaction with a durable `irs_substantiation`
    sub-doc so the audit trail lives with the txn forever — the
    Transactions detail view surfaces it as a "Compliance" section
    regardless of which batch or bookkeeper touched it.
    """
    payload = payload or {}
    company_id = batch["company_id"]

    # Try to find the underlying transaction id — for IRS items sourced
    # from `agent_findings`, the txn is on the finding's `meta.txn_id`
    # (Sep 2026 detector convention) or `transaction_id` (older).
    txn_id = None
    if item.get("source_collection") == "agent_findings":
        f = await db.agent_findings.find_one({"id": item["source_id"]})
        if f:
            f_meta = (f.get("meta") or {})
            txn_id = f_meta.get("txn_id") or f_meta.get("transaction_id")
    # Fallback: context.meta.txn_id set at batch-mint time.
    if not txn_id:
        ctx_meta = ((item.get("context") or {}).get("meta") or {})
        txn_id = ctx_meta.get("txn_id") or ctx_meta.get("transaction_id")

    if txn_id:
        sub = {
            "answered_at":        _now_iso(),
            "answered_by_pro":    bool(payload.get("answered_by_pro")),
            "answered_by_email":  payload.get("pro_email")
                                   or payload.get("client_email"),
            "attendees":          payload.get("attendees"),
            "business_purpose":   payload.get("business_purpose"),
            "destination":        payload.get("destination"),
            "trip_start":         payload.get("trip_start"),
            "trip_end":           payload.get("trip_end"),
            "notes":              answer or None,
            "item_type":          item.get("item_type"),
            "kind":               "meals" if item.get("item_type") == cr.ITEM_IRS_MEALS
                                   else "travel",
        }
        sub = {k: v for k, v in sub.items() if v not in (None, "")}
        await db.transactions.update_one(
            {"id": txn_id, "company_id": company_id},
            {"$set": {"irs_substantiation": sub,
                      "updated_at": _now_iso()}},
        )
    return await _handle_generic_finding(item, batch, answer=answer, payload=payload)


# --------------------------------------------------------------------------
# Item 11 — Owner's Draw check confirmation (+ reclassification)
# --------------------------------------------------------------------------

# Semantic → account_id resolver map for the four reclassification
# categories (all lowercased for match). Keys mirror what the LLM prompt
# instructs the model to put in `payload.reclassified_as`.
_RECLASSIFY_SEMANTIC = {
    "payroll":          "payroll_expense",
    "reimbursement":    None,   # sub-routed by follow_up free text below
    "business expense": None,   # sub-routed by follow_up free text below
    "loan repayment":   "loan_payment",
}

# Follow-up free-text keyword → canonical semantic for reimbursement /
# business-expense sub-routing. Cheap keyword-match; unmatched falls
# through to `needs_review=True` so the pro sees it.
_FOLLOWUP_KEYWORD_SEMANTIC = [
    ("fuel",         "fuel"),
    ("gas",          "fuel"),
    ("mile",         "fuel"),
    ("meal",         "meals_entertainment"),
    ("food",         "meals_entertainment"),
    ("lunch",        "meals_entertainment"),
    ("dinner",       "meals_entertainment"),
    ("office",       "office_supplies"),
    ("supplies",     "office_supplies"),
    ("job supplies", "job_supplies"),
    ("materials",    "job_supplies"),
    ("travel",       "travel"),
    ("hotel",        "travel"),
    ("flight",       "travel"),
    ("airline",      "travel"),
    ("equipment",    "equipment"),
    ("tool",         "equipment"),
]

_PRINCIPAL_INTEREST_RE = re.compile(
    r"(?:\$?\s*(?P<p>[\d,]+(?:\.\d+)?)\s*(?:principal|principle))"
    r"(?:[^\d]+\$?\s*(?P<i>[\d,]+(?:\.\d+)?)\s*interest)?"
    r"|(?:\$?\s*(?P<i2>[\d,]+(?:\.\d+)?)\s*interest"
    r"[^\d]+\$?\s*(?P<p2>[\d,]+(?:\.\d+)?)\s*(?:principal|principle))",
    re.IGNORECASE,
)


def _parse_principal_interest(text: str) -> tuple[float, float] | None:
    """Extract principal + interest amounts from a free-text reply like
    '$800 principal, $200 interest' or '200 interest and 800 principal'.
    Returns (principal, interest) or None if no valid pair found."""
    if not text:
        return None
    m = _PRINCIPAL_INTEREST_RE.search(text)
    if not m:
        return None
    p = m.group("p") or m.group("p2")
    i = m.group("i") or m.group("i2") or "0"
    try:
        principal = float((p or "0").replace(",", ""))
        interest  = float((i or "0").replace(",", ""))
    except ValueError:
        return None
    if principal <= 0 and interest <= 0:
        return None
    return (principal, interest)


async def _resolve_txn_id_for_item(item: dict) -> str | None:
    """Same rule set as the routes-layer helper: prefer
    `agent_findings.meta.txn_id`, fall back to `context.meta.txn_id`."""
    if item.get("source_collection") == "transactions":
        return item.get("source_id")
    if item.get("source_collection") == "agent_findings":
        f = await db.agent_findings.find_one({"id": item.get("source_id")})
        if f:
            fm = f.get("meta") or {}
            tid = fm.get("txn_id") or fm.get("transaction_id")
            if tid:
                return tid
    ctx_meta = ((item.get("context") or {}).get("meta") or {})
    return ctx_meta.get("txn_id") or ctx_meta.get("transaction_id")


async def _apply_category_by_semantic(txn_id: str, company_id: str,
                                       semantic: str, *,
                                       ai_comment: str,
                                       contact_id: str | None = None,
                                       contact_name: str | None = None) -> dict | None:
    """Resolve a canonical semantic → CoA account (auto-creating on
    first use for this company), then post the txn to that account.
    Returns the resolved account dict (or None if the semantic couldn't
    be resolved)."""
    import canonical_semantic_accounts as csa
    acct = await csa.ensure_semantic_account(db, company_id, semantic)
    if not acct:
        return None
    updates = {
        "category_account_id":   acct["id"],
        "category_account_name": acct.get("name") or "",
        "needs_review":          False,
        "human_reviewed":        True,
        "ai_source":             "client_owner_draw_reclassify",
        "ai_comment":            ai_comment,
        "updated_at":            _now_iso(),
    }
    if contact_id:
        updates["contact_id"]   = contact_id
        updates["contact_name"] = contact_name or ""
    await db.transactions.update_one(
        {"id": txn_id, "company_id": company_id}, {"$set": updates},
    )
    return acct


async def _handle_owner_draw(item: dict, batch: dict, *,
                              answer: str, payload: dict) -> dict:
    """Client confirms (or reclassifies) an Owner's Draw check.

    payload contract:
      * confirmed: bool                — true → book to Owner's Draw equity
      * reclassified_as: str           — 'Payroll' | 'Reimbursement' |
                                         'Business expense' | 'Loan repayment'
      * follow_up: str (free text)     — 'Priya Patel', 'Fuel for the truck',
                                         '$800 principal, $200 interest', …
    """
    payload = payload or {}
    company_id = batch["company_id"]
    txn_id = await _resolve_txn_id_for_item(item)

    confirmed = bool(payload.get("confirmed"))
    reclassified_as = (payload.get("reclassified_as") or "").strip().lower()
    follow_up = (payload.get("follow_up") or "").strip()

    action_detail: str = ""

    if not txn_id:
        # Nothing to post — fall through to the generic answer path.
        action_detail = "No underlying transaction to update"
    elif confirmed:
        acct = await _apply_category_by_semantic(
            txn_id, company_id, "owner_draw",
            ai_comment="Client confirmed this is an Owner's Draw via Quick Check-in",
        )
        if acct:
            action_detail = f"Booked to {acct.get('name')} (equity)"
        else:
            action_detail = "Owner's Draw account could not be resolved"
    elif reclassified_as == "payroll":
        acct = await _apply_category_by_semantic(
            txn_id, company_id, "payroll_expense",
            ai_comment=f"Reclassified from Owner's Draw → Payroll ({follow_up or 'no note'})",
        )
        action_detail = f"Booked to {acct.get('name')}" if acct else "Payroll expense account missing"
    elif reclassified_as == "loan repayment":
        # Try to split principal / interest if the client typed it in
        # the follow-up free text.
        split = _parse_principal_interest(follow_up)
        import canonical_semantic_accounts as csa
        loan_acct = await csa.ensure_semantic_account(db, company_id, "loan_payment")
        int_acct  = await csa.ensure_semantic_account(db, company_id, "interest_expense")
        if split and loan_acct and int_acct:
            principal, interest = split
            # Sign follows the transaction amount (money-out check → negative).
            txn = await db.transactions.find_one({"id": txn_id, "company_id": company_id})
            sign = -1.0 if float(txn.get("amount") or 0) < 0 else 1.0
            splits = [
                {"amount": round(sign * principal, 2),
                 "category_account_id":   loan_acct["id"],
                 "category_account_name": loan_acct.get("name") or "",
                 "description":           "Loan principal"},
                {"amount": round(sign * interest, 2),
                 "category_account_id":   int_acct["id"],
                 "category_account_name": int_acct.get("name") or "",
                 "description":           "Loan interest"},
            ]
            # Snap to exact amount if there's rounding drift.
            total = round(sum(s["amount"] for s in splits), 2)
            drift = round(float(txn.get("amount") or 0) - total, 2)
            if abs(drift) > 0.005:
                splits[0]["amount"] = round(splits[0]["amount"] + drift, 2)
            await db.transactions.update_one(
                {"id": txn_id, "company_id": company_id},
                {"$set": {
                    "splits":                splits,
                    "category_account_id":   None,
                    "category_account_name": "",
                    "needs_review":          False,
                    "human_reviewed":        True,
                    "ai_source":             "client_owner_draw_reclassify",
                    "ai_comment":            f"Loan repayment split ({follow_up})",
                    "updated_at":            _now_iso(),
                }},
            )
            action_detail = (f"Split: ${principal:,.2f} principal → "
                             f"{loan_acct.get('name')}, "
                             f"${interest:,.2f} interest → "
                             f"{int_acct.get('name')}")
        elif loan_acct:
            await _apply_category_by_semantic(
                txn_id, company_id, "loan_payment",
                ai_comment=f"Booked to loan principal (no split given) — {follow_up or 'note'}",
            )
            action_detail = f"Booked to {loan_acct.get('name')} (full amount as principal)"
        else:
            action_detail = "Loan payment account could not be resolved"
    elif reclassified_as in ("reimbursement", "business expense"):
        # Try to sub-route by keyword hit on the free-text follow_up.
        semantic = None
        low = follow_up.lower()
        for kw, sem in _FOLLOWUP_KEYWORD_SEMANTIC:
            if kw in low:
                semantic = sem
                break
        if semantic:
            acct = await _apply_category_by_semantic(
                txn_id, company_id, semantic,
                ai_comment=(f"Reclassified from Owner's Draw → "
                            f"{reclassified_as.title()} ({follow_up})"),
            )
            action_detail = f"Booked to {acct.get('name')}" if acct else "Category account missing"
        else:
            # Ambiguous — keep needs_review=True and pass to bookkeeper.
            await db.transactions.update_one(
                {"id": txn_id, "company_id": company_id},
                {"$set": {
                    "needs_review": True,
                    "ai_source":    "client_owner_draw_reclassify_ambiguous",
                    "ai_comment":   (f"Client reclassified as "
                                     f"{reclassified_as.title()}: '{follow_up}' "
                                     "— bookkeeper to pick the exact category"),
                    "updated_at":   _now_iso(),
                }},
            )
            action_detail = "Flagged for bookkeeper — category needs a call"
    else:
        # Unknown reclassified_as (or the client said "send to bookkeeper")
        # → stamp the answer, keep needs_review=True.
        if txn_id:
            await db.transactions.update_one(
                {"id": txn_id, "company_id": company_id},
                {"$set": {
                    "needs_review": True,
                    "ai_source":    "client_owner_draw_deferred",
                    "ai_comment":   f"Client reply: {answer}",
                    "updated_at":   _now_iso(),
                }},
            )
        action_detail = "Handed to bookkeeper"

    # Common finding close + stamp
    generic = await _handle_generic_finding(item, batch, answer=answer, payload=payload)
    return {"action_taken": generic.get("action_taken", "answered"),
            "detail": action_detail or generic.get("detail")}


# --------------------------------------------------------------------------
# Item 3 — missing receipt
# --------------------------------------------------------------------------

async def _handle_missing_receipt(item: dict, batch: dict, *,
                                   answer: str, payload: dict) -> dict:
    """When the client uploads a receipt on a Missing-Receipt item and
    the AI vision proposal comes back, tapping "Use this split" fires
    `flow="receipt_categorization"` and we must **book that split onto
    the underlying transaction** — same behaviour as Uncategorized.

    Missing Receipt items are backed by `agent_findings`; the txn id
    is not on the item directly, so we resolve it by matching the
    finding's `meta.txn_amount` + `meta.txn_date` (+ optional
    description contains) against `db.transactions`. Once resolved, we
    stuff that txn id into `item["source_id"]` and delegate to
    `_handle_uncategorized`, which already implements the full split-
    posting + contact-resolution + account-auto-create pipeline.

    Any other flow (plain text answer, deferral, W-9-style follow-up)
    falls through to `_handle_generic_finding` — same as before.
    """
    payload = payload or {}
    flow = payload.get("flow")
    if flow != "receipt_categorization":
        return await _handle_generic_finding(item, batch,
                                             answer=answer, payload=payload)

    company_id = batch["company_id"]
    meta = (item.get("context") or {}).get("meta") or {}
    txn_amount = meta.get("txn_amount") or meta.get("amount")
    txn_date = meta.get("txn_date")
    txn_desc = (meta.get("txn_desc") or "").strip()

    # If the finding was built with an explicit `meta.txn_id` (real
    # detectors + our seed both do this), skip the fuzzy match.
    txn = None
    if meta.get("txn_id"):
        txn = await db.transactions.find_one(
            {"id": meta["txn_id"], "company_id": company_id}, {"id": 1},
        )
    if not txn:
        # Match by amount (abs), date, and — if description carries a
        # unique-ish token — description contains. Amount + date alone
        # is usually enough; the extra token filter handles the rare
        # same-day multi-charge collision.
        q: dict = {"company_id": company_id}
        if txn_amount is not None:
            try:
                amt = round(abs(float(txn_amount)), 2)
                q["$expr"] = {"$eq": [{"$round": [{"$abs": "$amount"}, 2]}, amt]}
            except (TypeError, ValueError):
                pass
        if txn_date:
            q["date"] = txn_date
        txn = await db.transactions.find_one(q, {"id": 1})
    if not txn and txn_desc:
        # Fallback: relax the amount clause, filter by desc token.
        first_tok = txn_desc.split()[0] if txn_desc else ""
        if first_tok:
            q_relax = {"company_id": company_id,
                       "description": {"$regex": first_tok, "$options": "i"}}
            if txn_date:
                q_relax["date"] = txn_date
            txn = await db.transactions.find_one(q_relax, {"id": 1})
    if not txn:
        # Nothing to book onto — stash the split on the finding and
        # let the pro finalize. Client still sees "answered" so they
        # don't get stuck on the same card.
        return await _handle_generic_finding(item, batch,
                                             answer=answer, payload=payload)

    # Swap `source_id` to the real txn id and delegate. Also flip
    # `source_collection` so any downstream code that keys off it
    # (e.g. attachment mirroring) sees a real transaction.
    proxied = {**item,
               "source_id":         txn["id"],
               "source_collection": "transactions",
               # `_handle_uncategorized`'s grouped path fires only when
               # `ctx.grouped == True`; a Missing Receipt finding never
               # sets that, so the single-txn split branch is what runs.
               "context":           item.get("context") or {}}
    result = await _handle_uncategorized(proxied, batch,
                                          answer=answer, payload=payload)
    # Close the underlying agent_finding so the pro sees the receipt
    # is now filed AND the missing-receipt flag is resolved.
    await _close_source_finding(item, resolved_by="client:receipt_uploaded")
    await db.agent_findings.update_one(
        {"id": item["source_id"]},
        {"$set": {"client_answer":       answer,
                  "client_answered_at":  _now_iso(),
                  "meta.matched_txn_id": txn["id"],
                  "meta.client_payload": payload}},
    )

    # ── Cascade to sibling Uncategorized items (same batch, same
    # vendor). If the receipt just booked to (say) "Job Supplies" for
    # The Home Depot, stamp every OTHER open Uncategorized card for
    # The Home Depot in this batch with a `suggested_category_*`
    # hint. The Uncategorized card renders a green "Same as the
    # receipt — Job Supplies?" quick-apply banner so the client can
    # close each sibling in one tap.
    try:
        await _cascade_category_to_siblings(batch, item, txn["id"], payload)
    except Exception:  # noqa: BLE001
        # Cascade is a nice-to-have — a failure here must never
        # roll back the primary booking that just succeeded.
        pass
    return result


async def _cascade_category_to_siblings(
    batch: dict, source_item: dict, booked_txn_id: str, payload: dict,
) -> int:
    """Stamp `context.suggested_category_*` on sibling Uncategorized
    items (in the same batch) whose transaction shares the same
    contact/merchant as the transaction we just booked. Uses the
    dominant bucket (largest $) from the receipt split so the AI's
    suggestion mirrors what the pro would guess.
    Returns the number of items updated.
    """
    company_id = batch["company_id"]
    booked_txn = await db.transactions.find_one(
        {"id": booked_txn_id, "company_id": company_id},
        {"contact_id": 1, "merchant": 1, "contact_name": 1, "splits": 1,
         "category_account_id": 1, "category_account_name": 1,
         "category_account_code": 1},
    )
    if not booked_txn:
        return 0

    # Pick the dominant account on the booked txn.
    splits = booked_txn.get("splits") or []
    if splits:
        top = max(splits, key=lambda s: abs(float(s.get("amount") or 0)))
        cat_id   = top.get("category_account_id")
        cat_code = top.get("category_account_code")
        cat_name = top.get("category_account_name")
    else:
        cat_id   = booked_txn.get("category_account_id")
        cat_code = booked_txn.get("category_account_code")
        cat_name = booked_txn.get("category_account_name")
    if not cat_id:
        return 0

    # Match key: prefer contact_id, fall back to merchant name
    # (case-insensitive) since a Missing-Receipt finding pointing at
    # a not-yet-resolved contact can still cascade by descriptor.
    contact_id   = booked_txn.get("contact_id")
    merchant_key = ((booked_txn.get("merchant")
                    or booked_txn.get("contact_name") or "")
                    .strip().lower())

    updated = 0
    for it in (batch.get("items") or []):
        if it.get("item_id") == source_item.get("item_id"):
            continue
        if it.get("item_type") != cr.ITEM_UNCATEGORIZED:
            continue
        if it.get("answered_at") or it.get("deferred"):
            continue
        ctx = it.get("context") or {}
        it_contact = ctx.get("contact_id")
        it_merchant = ((ctx.get("merchant")
                        or ctx.get("contact_name") or "")
                        .strip().lower())
        matches = (
            (contact_id and it_contact and contact_id == it_contact)
            or (merchant_key and it_merchant
                and merchant_key == it_merchant)
        )
        if not matches:
            continue
        # Skip if this sibling already has a suggestion (don't
        # overwrite an earlier cascade's guess).
        if ctx.get("suggested_category_account_id"):
            continue
        await db.client_review_batches.update_one(
            {"id": batch["id"], "items.item_id": it["item_id"]},
            {"$set": {
                "items.$.context.suggested_category_account_id":   cat_id,
                "items.$.context.suggested_category_account_code": cat_code or "",
                "items.$.context.suggested_category_account_name": cat_name or "",
                "items.$.context.suggested_from":                  "receipt",
                "items.$.context.suggested_from_txn_id":           booked_txn_id,
                "updated_at":                                       _now_iso(),
            }},
        )
        updated += 1
    return updated


# --------------------------------------------------------------------------
# Router
# --------------------------------------------------------------------------

# --------------------------------------------------------------------------
# Item 12 — deposit classification
# --------------------------------------------------------------------------

_DEPOSIT_FLOW_TO_SEMANTIC = {
    "customer_payment":   "revenue_generic",
    "owner_contribution": "owner_contribution",
    "loan_received":      "loan_payment",     # Loans Payable — same account
    "refund":             "sales_refunds",    # Refunds & Returns (income-contra)
}
_DEPOSIT_FLOW_LABELS = {
    "customer_payment":   "Customer payment (revenue)",
    "owner_contribution": "Owner contribution (equity)",
    "loan_received":      "Loan received (liability)",
    "refund":             "Vendor refund",
}


async def _handle_deposit(item: dict, batch: dict, *,
                           answer: str, payload: dict) -> dict:
    """Classifies a deposit into one of 4 buckets and books it to
    the right CoA account:

      * ``customer_payment``   → Sales Revenue (income)
      * ``owner_contribution`` → Owner's Contribution (equity)
      * ``loan_received``      → Loans Payable (liability)
      * ``refund``             → Refunds & Returns (income-contra)

    Payload shape:  ``{"flow": "<one of above>"}`` — matches the
    Deposit tile row on the client. Falls through to
    ``_handle_generic_finding`` if the flow key is missing / unknown
    so the finding still closes with a stashed answer for the pro.
    """
    import canonical_semantic_accounts as csa

    payload = payload or {}
    flow = (payload.get("flow") or "").strip().lower()
    semantic = _DEPOSIT_FLOW_TO_SEMANTIC.get(flow)
    if not semantic:
        return await _handle_generic_finding(item, batch,
                                              answer=answer, payload=payload)

    company_id = batch["company_id"]
    meta = (item.get("context") or {}).get("meta") or {}
    txn_id = meta.get("txn_id")

    # Resolve the underlying deposit transaction — prefer explicit
    # meta.txn_id; fall back to amount + date match. Mirrors the
    # Missing-Receipt resolver.
    txn = None
    if txn_id:
        txn = await db.transactions.find_one(
            {"id": txn_id, "company_id": company_id},
            {"id": 1, "amount": 1, "date": 1, "description": 1, "contact_id": 1},
        )
    if not txn:
        amt = meta.get("txn_amount") or meta.get("amount")
        date = meta.get("txn_date")
        q: dict = {"company_id": company_id}
        if amt is not None:
            try:
                a = round(abs(float(amt)), 2)
                q["$expr"] = {"$eq": [{"$round": [{"$abs": "$amount"}, 2]}, a]}
            except (TypeError, ValueError):
                pass
        if date:
            q["date"] = date
        txn = await db.transactions.find_one(
            q, {"id": 1, "amount": 1, "date": 1, "description": 1, "contact_id": 1},
        )
    if not txn:
        return await _handle_generic_finding(item, batch,
                                              answer=answer, payload=payload)

    # Resolve / auto-create the target CoA account.
    # An explicit `payload.category_account_id` overrides the semantic
    # default — used by the Refund → "against a bill" / "to a category"
    # flows so the client can pick the exact expense account to
    # credit back to, instead of dumping every refund into
    # "Refunds & Returns".
    override_id = (payload.get("category_account_id") or "").strip() or None
    acct = None
    if override_id:
        acct = await db.accounts.find_one(
            {"id": override_id, "company_id": company_id},
            {"id": 1, "name": 1, "code": 1, "type": 1},
        )
    if not acct:
        acct = await csa.ensure_semantic_account(db, company_id, semantic)
    if not acct or not acct.get("id"):
        return await _handle_generic_finding(item, batch,
                                              answer=answer, payload=payload)

    label = _DEPOSIT_FLOW_LABELS.get(flow, flow)
    now = _now_iso()
    memo = (payload.get("memo") or "").strip()

    # Optional contact tagging — used by the Deposit → Customer
    # payment → Link to customer flow. If the client selected an
    # existing contact, `contact_id` is passed straight through. If
    # they typed a brand-new name, `create_contact=True` + a
    # `contact_name` string arrives instead → we mint the contact
    # first, then stamp its id on the txn.
    contact_id = (payload.get("contact_id") or "").strip() or None
    contact_name = (payload.get("contact_name") or "").strip() or None
    if not contact_id and contact_name and payload.get("create_contact"):
        try:
            import uuid as _uuid
            new_c = {
                "id":         str(_uuid.uuid4()),
                "company_id": company_id,
                "name":       contact_name,
                "type":       "customer",
                "created_at": now,
                "updated_at": now,
                "created_via": "client_review:deposit_customer_payment",
            }
            await db.contacts.insert_one(new_c)
            contact_id = new_c["id"]
        except Exception:  # noqa: BLE001
            contact_id = None

    # Book the deposit to the classified account. Deposits post at
    # face value (positive amount stays positive on income/equity/
    # liability accounts — the sign convention is preserved by the
    # journal-entry layer at post time).
    upd = {
        "category_account_id":   acct["id"],
        "category_account_name": acct.get("name"),
        "category_account_code": acct.get("code"),
        "needs_review":          False,
        "human_reviewed":        True,
        "posted":                True,
        "ai_source":             f"client_deposit_{flow}",
        "ai_comment":            (f"Client classified deposit as {label}."
                                  + (f" Note: {memo}" if memo else "")),
        "deposit_classification": flow,
        "updated_at":            now,
    }
    if contact_id:
        upd["contact_id"] = contact_id
    if contact_name:
        upd["contact_name"] = contact_name
        upd["merchant"] = contact_name
    # If this refund is being credited against a specific bill, track
    # the linkage on the txn so the pro can see which bill it
    # relates to during Reconciliation.
    bill_id = (payload.get("bill_id") or "").strip() or None
    if bill_id:
        upd["linked_bill_id"] = bill_id
    await db.transactions.update_one(
        {"id": txn["id"], "company_id": company_id}, {"$set": upd},
    )

    # Re-open a fully-paid bill when this refund reverses it. Keeps
    # A/P accurate: after the vendor sends money back, the client
    # effectively owes it again (or the bill should be voided). We
    # take the "increase balance_due" path so a pro can decide
    # whether to void, re-pay, or leave it open.
    if flow == "refund" and bill_id:
        try:
            bill = await db.bills.find_one(
                {"id": bill_id, "company_id": company_id},
                {"total": 1, "balance_due": 1, "status": 1, "history": 1},
            )
        except Exception:  # noqa: BLE001
            bill = None
        if bill:
            total   = float(bill.get("total") or 0)
            cur_bal = float(bill.get("balance_due") or 0)
            refund_amt = abs(float(txn.get("amount") or 0))
            # Cap the re-open so balance_due never exceeds the original
            # bill total (edge case: vendor over-refunds).
            new_bal = min(cur_bal + refund_amt, total) if total > 0 else cur_bal + refund_amt
            # Only flip status if we actually raised the balance above
            # the zero threshold — a partial-refund on a partially-open
            # bill should stay "open"/"partial" without a status flip.
            new_status = ("open" if new_bal > 0.005 and cur_bal <= 0.005
                          else (bill.get("status") or "open"))
            entry = {
                "at":         now,
                "by":         "client_review:refund_reopen",
                "action":     "balance_reopened_by_refund",
                "delta":      round(new_bal - cur_bal, 2),
                "refund_txn": txn["id"],
                "note":       f"Vendor refund of ${refund_amt:,.2f} reversed part of this bill.",
            }
            await db.bills.update_one(
                {"id": bill_id, "company_id": company_id},
                {"$set": {
                    "balance_due": round(new_bal, 2),
                    "status":      new_status,
                    "updated_at":  now,
                    "reopened_at": now,
                }, "$push": {"history": entry}},
            )

    # Close the source finding so the pro Cockpit reflects the answer.
    await _close_source_finding(item, resolved_by="client:deposit_classified")
    if item.get("source_collection") == "agent_findings" and item.get("source_id"):
        await db.agent_findings.update_one(
            {"id": item["source_id"], "company_id": company_id},
            {"$set": {"client_answer":       answer or label,
                      "client_answered_at":  now,
                      "meta.matched_txn_id": txn["id"],
                      "meta.client_payload": payload,
                      "meta.deposit_flow":   flow}},
        )

    return {
        "action_taken": "deposit_classified",
        "detail":       f"Booked ${abs(float(txn.get('amount') or 0)):,.2f} as {label} → {acct.get('name')}.",
        "txn_id":       txn["id"],
        "flow":         flow,
        "account_id":   acct["id"],
        "account_name": acct.get("name"),
    }


# --------------------------------------------------------------------------
# Item 9 — liability payment split (mortgage / credit card / auto loan)
# --------------------------------------------------------------------------
#
# Vision-analyzed statement OR client-typed split arrives as
#   payload = {
#     "flow": "liability_split",
#     "statement_type": "mortgage" | "credit_card" | "auto_loan" | "generic_loan",
#     "lender_name":    "...",
#     "buckets": [{"label": "Principal", "amount": 812.45}, ...],
#     "totals":  {"grand_total": 2145.67},
#     "payment_amount": 2145.67,
#     "narrative":      "...",
#     # optional overrides:
#     "principal_account_id": "<liability sub-account id — e.g. specific
#                              Vehicle Loan the client picked>",
#   }
#
# We turn each bucket into a `db.transactions.splits[]` row pointing at
# the right canonical semantic account:
#   Principal → liability paydown (statement-type aware)
#   Interest  → Interest Expense
#   Escrow    → Escrow (Prepaid) asset
#   Fees      → Bank & Merchant Fees
# The transaction gets `posted=True`, `human_reviewed=True`, its prior
# single-category fields cleared (splits win), and the source finding
# is closed.
# --------------------------------------------------------------------------

# Bucket label (case-insensitive, whitespace-tolerant) → semantic key.
# Escrow is only valid for mortgages; for CC/auto/generic_loan the AI
# should not emit an Escrow bucket, but if it does we still book it to
# the escrow asset (safest — the pro can move it later).
_LIABILITY_LABEL_TO_SEMANTIC = {
    "principal":            None,        # resolved dynamically from statement_type
    "principal_payment":    None,
    "loan principal":       None,
    "curtailment":          None,        # extra principal paydown → same acct
    "principal curtailment": None,
    "payoff adjustment":    None,        # servicer's final principal true-up
    "interest":             "interest_expense",
    "mortgage interest":    "interest_expense",
    "finance charges":      "interest_expense",
    "finance charge":       "interest_expense",
    "escrow":               "escrow_prepaid",
    "escrow deposit":       "escrow_prepaid",
    "escrow shortage":      "escrow_prepaid",
    "taxes & insurance":    "escrow_prepaid",
    "property tax":         "property_tax_expense",
    "property taxes":       "property_tax_expense",
    "real estate tax":      "property_tax_expense",
    "real estate taxes":    "property_tax_expense",
    "county tax":           "property_tax_expense",
    "county taxes":         "property_tax_expense",
    "school tax":           "property_tax_expense",
    "homeowners insurance": "insurance_expense",
    "homeowner's insurance": "insurance_expense",
    "hazard insurance":     "insurance_expense",
    "flood insurance":      "insurance_expense",
    "wind insurance":       "insurance_expense",
    "pmi":                  "insurance_expense",
    "pmi premium":          "insurance_expense",
    "mortgage insurance":   "insurance_expense",
    "mortgage insurance premium": "insurance_expense",
    "mip":                  "insurance_expense",
    "insurance":            "insurance_expense",
    "insurance premium":    "insurance_expense",
    "hoa":                  "hoa_dues",
    "hoa dues":             "hoa_dues",
    "hoa fees":             "hoa_dues",
    "condo dues":           "hoa_dues",
    "condo fees":           "hoa_dues",
    "association dues":     "hoa_dues",
    "association fees":     "hoa_dues",
    "master association dues": "hoa_dues",
    "fees":                 "bank_fees",
    "fee":                  "bank_fees",
    "late fee":             "bank_fees",
    "late fees":            "bank_fees",
    "late payment charge":  "bank_fees",
    "nsf fee":              "bank_fees",
    "nsf":                  "bank_fees",
    "return fee":           "bank_fees",
    "service charge":       "bank_fees",
    "service fee":          "bank_fees",
    "other":                "bank_fees",
}


async def _semantic_classify_liability_bucket(
    label: str, statement_type: str,
) -> str | None:
    """Ask Claude Haiku to classify a novel bucket label (one that
    doesn't match any exact key or keyword substring in
    `_LIABILITY_LABEL_TO_SEMANTIC`) into a canonical semantic account.
    Returns the semantic key on high confidence, else None (caller
    falls through to `unresolved`). This is the safety net so weird
    servicer labels like "Late Payment Charge - Grace Period" or
    "Deferred Interest" or "Modification Fee" don't silently drop.

    We deliberately KEEP this behind the exact-match/keyword table
    so the fast path stays synchronous and costs zero LLM calls in
    the common case."""
    label = (label or "").strip()
    if not label:
        return None
    valid_keys = [
        "interest_expense", "escrow_prepaid", "insurance_expense",
        "property_tax_expense", "hoa_dues", "bank_fees",
        # "loan_payment" == principal — caller handles via
        # `_principal_semantic_for(statement_type)` when we return
        # "principal".
        "principal",
    ]
    try:
        from ai_service import _new_chat, _extract_json, MODEL_HAIKU
        from llm_client import UserMessage
        system = (
            "You are a bookkeeping classifier. A liability-payment "
            "statement has a line-item bucket labeled `{LABEL}` on a "
            "{STMT_TYPE} statement. Pick which canonical semantic "
            "account should receive that dollar amount. Reply STRICT "
            "JSON only: {\"key\": \"<one of: interest_expense | "
            "escrow_prepaid | insurance_expense | property_tax_expense "
            "| hoa_dues | bank_fees | principal>\", \"confidence\": "
            "<0.0-1.0>}. Return null key when unsure. No prose, no "
            "code fences."
        )
        prompt = system.replace("{LABEL}", label).replace(
            "{STMT_TYPE}", statement_type or "generic_loan"
        )
        chat = _new_chat(prompt, f"liab-bucket-classify",
                          model_name=MODEL_HAIKU,
                          feature="liability-bucket-classify")
        text = await chat.send_message(UserMessage(text=label))
    except Exception:  # noqa: BLE001
        return None
    parsed = _extract_json(text or "") or {}
    key = (parsed.get("key") or "").strip()
    try:
        conf = float(parsed.get("confidence") or 0.0)
    except (TypeError, ValueError):
        conf = 0.0
    if key not in valid_keys:
        return None
    if conf < 0.65:
        return None
    return key


def _principal_semantic_for(statement_type: str) -> str:
    """Which canonical liability account gets DR'd for the principal
    portion of the payment. Credit cards use the contra `credit_card_payment`
    account; everything else uses generic `loan_payment`."""
    st = (statement_type or "").strip().lower()
    if st == "credit_card":
        return "credit_card_payment"
    return "loan_payment"


async def _handle_liability_payment(item: dict, batch: dict, *,
                                     answer: str, payload: dict) -> dict:
    """Split a mortgage / credit-card / auto-loan payment transaction
    into its principal / interest / escrow / fees buckets and post
    each to the right GL account. This is the ONLY handler that turns
    Quick Check-in liability-statement uploads into real ledger rows.
    """
    import canonical_semantic_accounts as csa

    payload = payload or {}
    flow = (payload.get("flow") or "").strip().lower()
    # We accept both "liability_split" (post-vision confirm) and
    # the older "liability_categorize" naming just in case older UI
    # payloads leak through.
    if flow not in ("liability_split", "liability_categorize"):
        return await _handle_generic_finding(item, batch,
                                              answer=answer, payload=payload)

    buckets = payload.get("buckets") or []
    if not isinstance(buckets, list) or not buckets:
        return await _handle_generic_finding(item, batch,
                                              answer=answer, payload=payload)

    statement_type = (payload.get("statement_type") or "generic_loan").strip().lower()
    principal_semantic_default = _principal_semantic_for(statement_type)
    principal_override = (payload.get("principal_account_id") or "").strip() or None

    company_id = batch["company_id"]
    meta = (item.get("context") or {}).get("meta") or {}
    txn_id = meta.get("txn_id")

    # Resolve the underlying transaction — same pattern used by
    # `_handle_deposit`: prefer explicit txn_id, fall back to amount +
    # date match on the batch's company.
    txn = None
    if txn_id:
        txn = await db.transactions.find_one(
            {"id": txn_id, "company_id": company_id},
            {"id": 1, "amount": 1, "date": 1, "description": 1, "contact_id": 1},
        )
    if not txn:
        amt = meta.get("txn_amount") or meta.get("amount")
        date = meta.get("txn_date")
        q: dict = {"company_id": company_id}
        if amt is not None:
            try:
                a = round(abs(float(amt)), 2)
                q["$expr"] = {"$eq": [{"$round": [{"$abs": "$amount"}, 2]}, a]}
            except (TypeError, ValueError):
                pass
            if date:
                q["date"] = date
        txn = await db.transactions.find_one(
            q, {"id": 1, "amount": 1, "date": 1, "description": 1, "contact_id": 1},
        )
    if not txn:
        return await _handle_generic_finding(item, batch,
                                              answer=answer, payload=payload)

    txn_amount_abs = abs(float(txn.get("amount") or 0))
    txn_sign = 1.0 if float(txn.get("amount") or 0) >= 0 else -1.0

    # Resolve each bucket → account. Skip zero / non-numeric entries so
    # the splits don't include garbage rows. Auto-create the target
    # account via csa.ensure_semantic_account when it doesn't exist.
    splits: list[dict] = []
    auto_created: list[dict] = []
    unresolved: list[str] = []

    async def _resolve_semantic(sem_key: str):
        """ensure_semantic_account with a small memo of what was minted
        this call so we can surface it in the response summary."""
        acct = await csa.ensure_semantic_account(db, company_id, sem_key)
        if acct and acct.get("id") and acct.get("__auto_created__"):
            auto_created.append({
                "id":   acct["id"],
                "code": acct.get("code"),
                "name": acct.get("name"),
            })
        return acct

    for b in buckets:
        try:
            amt = round(float(b.get("amount") or 0), 2)
        except (TypeError, ValueError):
            amt = 0.0
        if amt <= 0:
            continue
        label = (b.get("label") or "").strip()
        key = label.lower()

        # Per-bucket account override (from the "Change" affordance
        # on the LiabilityBreakdown UI). Highest priority — if the
        # client picked a specific CoA row for THIS bucket, use it.
        # We accept a few field names since different UI paths stamp
        # different keys onto the bucket.
        bucket_override = (
            (b.get("account_id") or "").strip()
            or (b.get("category_account_id") or "").strip()
            or (b.get("principal_account_id") or "").strip()
            or None
        )
        if bucket_override:
            override_acct = await db.accounts.find_one(
                {"id": bucket_override, "company_id": company_id},
                {"id": 1, "name": 1, "code": 1, "type": 1},
            )
            if override_acct and override_acct.get("id"):
                splits.append({
                    "amount":                amt * txn_sign,
                    "category_account_id":   override_acct["id"],
                    "category_account_name": override_acct.get("name") or "",
                    "category_account_code": override_acct.get("code") or "",
                    "description":           label or override_acct.get("name") or "",
                    "bucket":                key,
                    "user_overridden":       True,
                })
                continue
            # If the override id doesn't exist / retired, fall through
            # to the semantic-default resolver below so the split
            # still posts.

        semantic = _LIABILITY_LABEL_TO_SEMANTIC.get(key)
        # Loose match: "principal" appears in "Principal Payment", etc.
        # Ordering matters: check more-specific keywords BEFORE the
        # generic "tax"/"fee"/"charge" so "property tax" → property
        # tax expense (not escrow), "hoa fees" → HOA dues (not bank
        # fees), etc.
        if semantic is None:
            if ("principal" in key or "curtailment" in key
                    or "payoff adjustment" in key):
                semantic = None  # sentinel: use principal_semantic_default
                is_principal = True
            elif "interest" in key or "finance" in key:
                semantic = "interest_expense"
                is_principal = False
            elif ("hoa" in key or "association" in key or "condo" in key):
                semantic = "hoa_dues"
                is_principal = False
            elif ("property tax" in key or "real estate tax" in key
                    or "county tax" in key or "school tax" in key):
                semantic = "property_tax_expense"
                is_principal = False
            elif ("pmi" in key or "mip" in key
                    or "mortgage insurance" in key
                    or "homeowner" in key or "hazard" in key
                    or "flood insurance" in key or "wind insurance" in key
                    or key == "insurance" or "insurance premium" in key):
                semantic = "insurance_expense"
                is_principal = False
            elif "escrow" in key:
                semantic = "escrow_prepaid"
                is_principal = False
            elif "fee" in key or "charge" in key or "penalt" in key or "nsf" in key:
                semantic = "bank_fees"
                is_principal = False
            else:
                # Ask Haiku to classify novel labels ("Deferred
                # Interest", "Modification Fee", "Rate Buy-down",
                # etc.) rather than silently dropping to unresolved.
                try:
                    ai_key = await _semantic_classify_liability_bucket(
                        label, statement_type,
                    )
                except Exception:  # noqa: BLE001
                    ai_key = None
                if ai_key == "principal":
                    semantic = None
                    is_principal = True
                elif ai_key:
                    semantic = ai_key
                    is_principal = False
                else:
                    unresolved.append(f"{label or '(unlabeled)'} ${amt:.2f}")
                    continue
        else:
            is_principal = False

        # Principal is statement-type-aware; allow explicit override
        # so a client who paid down a specific Vehicle Loan sub-account
        # gets THAT account credited (not the generic Loans Payable).
        if semantic is None:
            if principal_override:
                acct = await db.accounts.find_one(
                    {"id": principal_override, "company_id": company_id,
                     "type": "liability"},
                    {"id": 1, "name": 1, "code": 1, "type": 1},
                )
                if not acct:
                    # Override doesn't exist / wrong type — fall through
                    # to the canonical default so the split still posts.
                    acct = await _resolve_semantic(principal_semantic_default)
            else:
                acct = await _resolve_semantic(principal_semantic_default)
        else:
            acct = await _resolve_semantic(semantic)

        if not acct or not acct.get("id"):
            unresolved.append(f"{label or '(unlabeled)'} ${amt:.2f}")
            continue

        splits.append({
            "amount":                amt * txn_sign,
            "category_account_id":   acct["id"],
            "category_account_name": acct.get("name") or "",
            "category_account_code": acct.get("code") or "",
            "description":           label or acct.get("name") or "",
            "bucket":                key,  # for reporting/audit
        })

    if not splits:
        # Nothing resolved — fall back to the stash-only path so the
        # bookkeeper can pick it up on the pro side.
        return await _handle_generic_finding(item, batch,
                                              answer=answer, payload=payload)

    # Sanity: buckets must sum (roughly) to the transaction amount. A
    # small (<0.02) rounding delta is acceptable; anything bigger, we
    # log and continue — the client's split is what they explicitly
    # confirmed, so we don't refuse to post.
    split_sum = round(sum(abs(s["amount"]) for s in splits), 2)
    if abs(split_sum - txn_amount_abs) > 0.02:
        logger.warning(
            "liability_split: sum of buckets (%.2f) does not match txn "
            "amount (%.2f) on txn %s — posting anyway per client confirm",
            split_sum, txn_amount_abs, txn.get("id"),
        )

    now = _now_iso()
    lender_name = (payload.get("lender_name") or "").strip()
    narrative = (payload.get("narrative") or "").strip()

    update_set = {
        "splits":                 splits,
        "posted":                 True,
        "human_reviewed":         True,
        "needs_review":           False,
        # Splits win — clear any prior single-category stamp so the
        # ledger doesn't double-count.
        "category_account_id":    None,
        "category_account_code":  None,
        "category_account_name":  None,
        "split_source":           "client_review_liability",
        "split_narrative":        narrative,
        "liability_statement_type": statement_type,
        "liability_lender_name":  lender_name,
        "updated_at":             now,
    }
    await db.transactions.update_one(
        {"id": txn["id"], "company_id": company_id},
        {"$set": update_set},
    )

    # Invalidate dashboard cache so the CPA sees the new split
    # immediately without a manual refresh.
    try:
        from routes.transactions import _invalidate_dash
        await _invalidate_dash(company_id)
    except Exception:  # noqa: BLE001
        pass

    await _close_source_finding(item, resolved_by="client:answered")
    if item.get("source_collection") == "agent_findings":
        await db.agent_findings.update_one(
            {"id": item["source_id"]},
            {"$set": {
                "client_answer":       answer,
                "client_answered_at":  now,
                "meta.client_payload": payload or {},
            }},
        )

    # Detail line for the summary bubble — the client sees the exact
    # posting so there's zero ambiguity.
    bit_parts = [
        f"{s['description']} ${abs(s['amount']):,.2f} → {s['category_account_name']}"
        for s in splits
    ]
    detail = f"Split ${txn_amount_abs:,.2f} into: {', '.join(bit_parts)}."
    if unresolved:
        detail += (f" (Skipped {len(unresolved)} unresolved bucket"
                   f"{'s' if len(unresolved) != 1 else ''}: "
                   + ", ".join(unresolved) + ")")

    return {
        "action_taken":  "liability_split",
        "detail":        detail,
        "txn_id":        txn["id"],
        "statement_type": statement_type,
        "splits":        [{"amount":        s["amount"],
                            "account_id":    s["category_account_id"],
                            "account_name":  s["category_account_name"],
                            "account_code":  s["category_account_code"],
                            "bucket":        s["bucket"]}
                           for s in splits],
        "auto_created":  auto_created,
        "unresolved":    unresolved,
    }


_HANDLERS = {
    cr.ITEM_UNCATEGORIZED:      _handle_uncategorized,
    cr.ITEM_VENDOR_MEMO:        _handle_vendor_memo,
    cr.ITEM_MISSING_RECEIPT:    _handle_missing_receipt,
    cr.ITEM_W9_NEEDED:          _handle_w9_needed,
    cr.ITEM_AMBIGUOUS_TRANSFER: _handle_generic_finding,
    cr.ITEM_RECURRING:          _handle_generic_finding,
    cr.ITEM_SETUP:              _handle_generic_finding,
    cr.ITEM_SPLIT:              _handle_generic_finding,
    cr.ITEM_LIABILITY_SPLIT:    _handle_liability_payment,
    cr.ITEM_IRS_MEALS:          _handle_irs_substantiation,
    cr.ITEM_IRS_TRAVEL:         _handle_irs_substantiation,
    cr.ITEM_OWNER_DRAW:         _handle_owner_draw,
    cr.ITEM_DEPOSIT:            _handle_deposit,
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


# --------------------------------------------------------------------------
# BOOKABLE CHECKS — Phase 1 state model
# --------------------------------------------------------------------------
# Every item_type has a check that inspects `item.draft` and returns True
# when the draft has enough structured data to be POSTed to the type's
# handler successfully. Types that haven't been wired to a real GL-booking
# handler yet return False + a `reason` so `/book` can 501 cleanly instead
# of silently no-op'ing the way `apply_answer` does today.


def _bookable_uncategorized(draft: dict) -> tuple[bool, str]:
    if not (draft.get("txn_ids") or draft.get("txn_id")):
        return False, "Need txn_ids to book"
    if not draft.get("category_account_id"):
        return False, "Need category_account_id"
    return True, ""


def _bookable_owner_draw(draft: dict) -> tuple[bool, str]:
    if draft.get("confirmed") is True:
        return True, ""
    if draft.get("confirmed") is False:
        if not draft.get("reclassified_as"):
            return False, "Need reclassified_as when confirmed=false"
        return True, ""
    return False, "Need confirmed:true|false"


def _bookable_check_assign(draft: dict) -> tuple[bool, str]:
    # Item 13 already routes through /check-assign — draft path is a
    # transparent forward. We accept any draft with contact_id set.
    if not draft.get("contact_id"):
        return False, "Need contact_id (the payee)"
    return True, ""


def _bookable_not_ready(_reason: str):
    async def _f(draft):
        return False, _reason
    return _f


# Phase-1 real bookable checks: only the three item types that already
# have end-to-end GL-writing handlers today. Every other item_type
# returns False with a clear reason so the frontend / curl can see
# exactly which flows are still on the answer-only path.
_BOOKABLE_CHECKS = {
    cr.ITEM_UNCATEGORIZED:      _bookable_uncategorized,
    cr.ITEM_OWNER_DRAW:         _bookable_owner_draw,
    cr.ITEM_CHECK_NO_CONTACT:   _bookable_check_assign,
}


def check_bookable(item: dict) -> tuple[bool, str]:
    """Public helper for the routes layer."""
    checker = _BOOKABLE_CHECKS.get(item.get("item_type"))
    if not checker:
        return False, (f"item_type={item.get('item_type')!r} has no bookable "
                       "handler yet (Phase 1 only wires Uncategorized, "
                       "Owner's Draw, Check-payee)")
    return checker(item.get("draft") or {})


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
