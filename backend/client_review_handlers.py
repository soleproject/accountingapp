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
        cats = payload.get("suggested_categories") or []
        if cats:
            txn = await db.transactions.find_one(
                {"id": txn_id, "company_id": company_id},
                {"amount": 1, "date": 1},
            )
            if not txn:
                return {"action_taken": "noop",
                        "detail": "Transaction not found — nothing to split"}
            # Resolve every proposed account to a real chart-of-accounts row.
            # Prefer the code (AI's already given us "5100 · Materials · Lumber"),
            # fall back to a case-insensitive name match, and finally to a
            # last-resort "Uncategorized Expense" if the account isn't
            # in this client's COA.
            accts = await db.accounts.find(
                {"company_id": company_id},
                {"id": 1, "code": 1, "name": 1, "type": 1},
            ).to_list(2000)
            by_code = {a.get("code"): a for a in accts if a.get("code")}
            by_name = {(a.get("name") or "").strip().lower(): a for a in accts}
            fallback = next(
                (a for a in accts if (a.get("name") or "").lower()
                 == "uncategorized expense"), None,
            ) or next(
                (a for a in accts if (a.get("code") or "") in ("9999", "6999")),
                None,
            )

            txn_amount = float(txn["amount"] or 0)
            # Expense receipts land as NEGATIVE txn amounts. The AI
            # returns positive bucket amounts, so we mirror the sign.
            sign = -1.0 if txn_amount < 0 else 1.0

            resolved: list[dict] = []
            for c in cats:
                amt = round(abs(float(c.get("amount") or 0)), 2)
                if amt <= 0:
                    continue
                acct = None
                code = c.get("account_code")
                if code and code in by_code:
                    acct = by_code[code]
                if not acct:
                    nm = (c.get("account_name") or "").strip().lower()
                    if nm and nm in by_name:
                        acct = by_name[nm]
                if not acct:
                    acct = fallback
                if not acct:
                    # No usable account at all — bail and let the pro finish.
                    return await _annotate_only(txn_id, company_id, answer,
                                                base_updates)
                resolved.append({
                    "amount":              round(sign * amt, 2),
                    "category_account_id": acct["id"],
                    "category_account_code": acct.get("code") or "",
                    "category_account_name": acct.get("name") or "",
                    "description":         (c.get("account_name") or "")[:80],
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

            await db.transactions.update_one(
                {"id": txn_id, "company_id": company_id},
                {"$set": {**base_updates,
                          "splits":              resolved,
                          "human_reviewed":      True,
                          "needs_review":        False,
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
            summary = ", ".join(
                f"{s['category_account_name']} ${abs(s['amount']):.2f}"
                for s in resolved
            )
            return {"action_taken": "split_categorized",
                    "detail":       f"Posted split: {summary}"}

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
# Router
# --------------------------------------------------------------------------

_HANDLERS = {
    cr.ITEM_UNCATEGORIZED:      _handle_uncategorized,
    cr.ITEM_VENDOR_MEMO:        _handle_generic_finding,
    cr.ITEM_MISSING_RECEIPT:    _handle_generic_finding,
    cr.ITEM_W9_NEEDED:          _handle_w9_needed,
    cr.ITEM_AMBIGUOUS_TRANSFER: _handle_generic_finding,
    cr.ITEM_RECURRING:          _handle_generic_finding,
    cr.ITEM_SETUP:              _handle_generic_finding,
    cr.ITEM_SPLIT:              _handle_generic_finding,
    cr.ITEM_LIABILITY_SPLIT:    _handle_generic_finding,
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
