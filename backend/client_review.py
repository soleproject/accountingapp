"""Batch client review — Phase 3, Milestone A.

Aggregates unresolved items across the nine question categories into a
single `client_review_batches` doc that the client answers in one
conversational session, on their own time.

Cadence: fire when ≥3 items are ready AND ≥5 days have passed since the
last batch email for this client. Streams-first — the per-txn
`ai_ask_client` scheduler still handles fresh uncategorized rows; batches
only pick up aged (>7d), post-initial-download stragglers plus everything
else.

Item catalog:
    1. Uncategorized transaction (>7d, non-initial-download)
    2. Vendor/memo confirmation (agent_findings: contact_mismatch,
       contact_duplicate)
    3. Missing receipt (agent_findings: missing_receipt)
    4. 1099 W-9 collection (agent_findings: w9_needed)
    5. Ambiguous P2P transfer (agent_findings: ambiguous_transfer)
    6. New recurring charge classification (agent_findings:
       new_recurring_charge)
    7. Setup detail missing (agent_findings: setup_missing)
    8. Split-transaction suggestion (agent_findings: split_suggested)
    9. Liability payment split (agent_findings: liability_split_needed)

Kinds 3–9 are consumed via `agent_findings.kind` — the source detectors
mint findings under those keys. Detectors 6, 7, 8 don't exist yet; the
aggregator returns empty for those kinds until they do. When a detector
lands, no aggregator change is needed.
"""

from __future__ import annotations
import uuid
import secrets
import logging
from datetime import datetime, timezone, timedelta
from typing import Any

from deps import db

logger = logging.getLogger("axiom.client_review")


ITEM_UNCATEGORIZED         = 1
ITEM_VENDOR_MEMO           = 2
ITEM_MISSING_RECEIPT       = 3
ITEM_W9_NEEDED             = 4
ITEM_AMBIGUOUS_TRANSFER    = 5
ITEM_RECURRING             = 6
ITEM_SETUP                 = 7
ITEM_SPLIT                 = 8
ITEM_LIABILITY_SPLIT       = 9

# Map an item type → the `agent_findings.kind` values it consumes.
# Item 1 is special-cased (queries transactions directly).
_KIND_MAP: dict[int, list[str]] = {
    ITEM_VENDOR_MEMO:         ["contact_mismatch", "contact_duplicate"],
    ITEM_MISSING_RECEIPT:     ["missing_receipt"],
    ITEM_W9_NEEDED:           ["w9_needed"],
    ITEM_AMBIGUOUS_TRANSFER:  ["ambiguous_transfer"],
    ITEM_RECURRING:           ["new_recurring_charge"],
    ITEM_SETUP:               ["setup_missing"],
    ITEM_SPLIT:               ["split_suggested"],
    ITEM_LIABILITY_SPLIT:     ["liability_split_needed"],
}

BATCH_MIN_ITEMS         = 3
BATCH_MIN_DAYS_BETWEEN  = 5
BATCH_EXPIRY_DAYS       = 14
AGED_UNCATEGORIZED_DAYS = 7
INITIAL_DOWNLOAD_HOURS  = 24   # skip anything ingested < 24h post company create


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _days_ago(days: int) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()


def _hours_after(iso: str | datetime, hours: int) -> str:
    """Return `iso + hours` as ISO string, robust to str or datetime input."""
    if isinstance(iso, str):
        # Strip trailing Z if present, parse.
        cleaned = iso.replace("Z", "+00:00")
        dt = datetime.fromisoformat(cleaned)
    else:
        dt = iso
    return (dt + timedelta(hours=hours)).isoformat()


# --------------------------------------------------------------------------
# Item collection — one small async fn per item type keeps testing surgical.
# --------------------------------------------------------------------------

async def _collect_aged_uncategorized(company_id: str) -> list[dict]:
    """Item 1. Aged uncategorized transactions.

    Rules:
      * `needs_review == True`
      * `human_reviewed != True` — CPA hasn't touched it
      * `created_at < now - 7d` — the per-txn asker had first crack
      * `created_at > company.created_at + 24h` — never anything from the
        initial Plaid backfill
      * `client_question_id` empty — no per-txn ask pending or answered
        for this row (the streaming scheduler owns those)
      * Not already in any open/scheduled batch (dedupe below)
    """
    company = await db.companies.find_one({"id": company_id}, {"created_at": 1})
    if not company:
        return []
    initial_download_end = _hours_after(
        company["created_at"], INITIAL_DOWNLOAD_HOURS,
    )
    cutoff_aged = _days_ago(AGED_UNCATEGORIZED_DAYS)
    query = {
        "company_id":         company_id,
        "needs_review":       True,
        "human_reviewed":     {"$ne": True},
        "created_at":         {"$lt": cutoff_aged, "$gt": initial_download_end},
        "client_question_id": {"$in": [None, ""]},
    }
    items: list[dict] = []
    async for t in db.transactions.find(query).sort("date", -1).limit(20):
        items.append({
            "item_id":           str(uuid.uuid4()),
            "item_type":         ITEM_UNCATEGORIZED,
            "source_id":         t["id"],
            "source_collection": "transactions",
            "prompt":            _prompt_for_uncategorized(t),
            "context": {
                "date":        t.get("date"),
                "amount":      t.get("amount"),
                "description": t.get("description"),
                "merchant":    t.get("merchant"),
                "account":     t.get("bank_account_name"),
            },
            "answered_at": None,
            "answer":      None,
            "deferred":    False,
            "action_taken": None,
        })
    return items


async def _collect_agent_findings(company_id: str, item_type: int) -> list[dict]:
    kinds = _KIND_MAP.get(item_type)
    if not kinds:
        return []
    items: list[dict] = []
    async for f in db.agent_findings.find({
        "company_id": company_id,
        "kind":       {"$in": kinds},
        "status":     "open",
        # Not already picked up by a live batch
        "batch_id":   {"$in": [None, ""]},
    }).sort("created_at", -1).limit(20):
        items.append({
            "item_id":           str(uuid.uuid4()),
            "item_type":         item_type,
            "source_id":         f["id"],
            "source_collection": "agent_findings",
            "prompt":            f.get("detail") or f.get("title") or "",
            "context": {
                "kind":     f.get("kind"),
                "title":    f.get("title"),
                "severity": f.get("severity"),
                "meta":     f.get("meta") or {},
            },
            "answered_at": None,
            "answer":      None,
            "deferred":    False,
            "action_taken": None,
        })
    return items


def _prompt_for_uncategorized(t: dict) -> str:
    amount = t.get("amount") or 0
    date = t.get("date") or ""
    who = t.get("merchant") or t.get("description") or "an unknown vendor"
    direction = "to" if amount < 0 else "from"
    return (f"Could you tell us what this ${abs(amount):,.2f} transaction "
            f"on {date} {direction} {who} was for?")


async def collect_batch_items(company_id: str) -> list[dict]:
    """Walk all 9 sources, return the deduped item list ready for batching.

    Deduplication has two layers:
      1. Source-level: each `_collect_*` helper already excludes rows
         with a live `batch_id` or `client_question_id`.
      2. Cross-source: within this call, items with the same
         (source_collection, source_id) pair are collapsed — a single
         finding can only surface once even if two callers race.
    """
    items: list[dict] = []
    items.extend(await _collect_aged_uncategorized(company_id))
    for item_type in (
        ITEM_VENDOR_MEMO,
        ITEM_MISSING_RECEIPT,
        ITEM_W9_NEEDED,
        ITEM_AMBIGUOUS_TRANSFER,
        ITEM_RECURRING,
        ITEM_SETUP,
        ITEM_SPLIT,
        ITEM_LIABILITY_SPLIT,
    ):
        items.extend(await _collect_agent_findings(company_id, item_type))

    seen: set[tuple[str, str]] = set()
    deduped: list[dict] = []
    for it in items:
        key = (it["source_collection"], it["source_id"])
        if key in seen:
            continue
        seen.add(key)
        deduped.append(it)

    # Group by item_type + sort within each group so same-type items
    # sit adjacent in the client's review flow — the UI groups them
    # under section headers and shows a "3 of 4 in Uncategorized" style
    # progress bar (Sep 2026). Canonical type order matters: dollars-
    # first item types come before accountability-only types so the
    # highest-value questions land at the top of the batch.
    _TYPE_ORDER = {
        ITEM_UNCATEGORIZED:      1,   # money already spent (biggest volume)
        ITEM_LIABILITY_SPLIT:    2,   # real money into balance-sheet accounts
        ITEM_MISSING_RECEIPT:    3,   # audit-trail / IRS >$75 rule
        ITEM_VENDOR_MEMO:        4,   # contact identity (dormant post-Sep-14 2026)
        ITEM_SPLIT:              5,   # rare — pre-classified txn that needs splitting
        ITEM_AMBIGUOUS_TRANSFER: 6,   # needs owner intent
        ITEM_RECURRING:          7,   # new-recurring gate
        ITEM_SETUP:              8,   # org-config placeholder
        ITEM_W9_NEEDED:          9,   # year-end / threshold-triggered
    }

    def _sort_key(it: dict) -> tuple:
        # Primary: canonical type order (huge blocks stay contiguous).
        prim = _TYPE_ORDER.get(it.get("item_type") or 0, 99)
        # Secondary: dollar-weight desc for money items, age for the rest.
        # Uncategorized items carry the amount at `context.amount`;
        # agent_findings items carry it at `context.meta.txn_amount`.
        ctx = it.get("context") or {}
        meta = ctx.get("meta") or {}
        amt = meta.get("txn_amount")
        if amt is None:
            amt = ctx.get("amount")
        try:
            amt_key = -abs(float(amt)) if amt is not None else 0
        except (TypeError, ValueError):
            amt_key = 0
        # Fallback: created_at asc so oldest surfaces first within a type.
        created = it.get("created_at") or ""
        return (prim, amt_key, created)

    deduped.sort(key=_sort_key)
    return deduped


# --------------------------------------------------------------------------
# Cadence gate + batch mint
# --------------------------------------------------------------------------

async def last_batch_email_sent_at(
    company_id: str, client_email: str,
) -> str | None:
    """Timestamp of the most recent batch email dispatched to this
    client — from any batch state (open, expired, completed).
    """
    doc = await db.client_review_batches.find_one(
        {"company_id": company_id, "client_email": client_email,
         "email_sent_at": {"$ne": None}},
        sort=[("email_sent_at", -1)],
    )
    return doc.get("email_sent_at") if doc else None


async def has_open_batch(company_id: str, client_email: str) -> bool:
    """A client with an open/scheduled batch never gets a second one —
    they finish or expire before we send anything new.
    """
    doc = await db.client_review_batches.find_one({
        "company_id":   company_id,
        "client_email": client_email,
        "status":       {"$in": ["open", "scheduled"]},
    })
    return doc is not None


async def should_fire_batch(
    company_id: str, client_email: str,
) -> tuple[bool, str, list[dict]]:
    """Return (should_fire, reason, ready_items).

    The `reason` is diagnostic — surface it on the pro-side "why isn't
    this client getting emails" panel. Never returns a truthy first
    element while there's already an open batch — that's a hard gate.
    """
    if await has_open_batch(company_id, client_email):
        return False, "already_open_batch", []

    last_sent = await last_batch_email_sent_at(company_id, client_email)
    if last_sent:
        cutoff = _days_ago(BATCH_MIN_DAYS_BETWEEN)
        if last_sent > cutoff:
            return False, "cadence_too_soon", []

    items = await collect_batch_items(company_id)
    if len(items) < BATCH_MIN_ITEMS:
        return False, "below_min_items", items
    return True, "ready", items


async def create_batch(
    company_id: str, client_email: str, items: list[dict],
) -> dict:
    """Persist the batch and stamp source items with `batch_id` so a
    concurrent aggregator run can't re-pick them.

    The email dispatch itself lives in Milestone B — this only builds
    the doc, marks the sources, and returns it. Caller decides when to
    send.
    """
    batch_id   = str(uuid.uuid4())
    # 32-byte URL-safe token — unguessable, no server-side signing
    # required. Same posture as `ai_ask_client_scheduler` magic links.
    client_token = secrets.token_urlsafe(32)
    created_at = now_iso()
    expires_at = (datetime.now(timezone.utc)
                  + timedelta(days=BATCH_EXPIRY_DAYS)).isoformat()

    doc: dict[str, Any] = {
        "id":                          batch_id,
        "company_id":                  company_id,
        "client_email":                client_email,
        "client_token":                client_token,
        "items":                       items,
        "status":                      "open",
        "created_at":                  created_at,
        "expires_at":                  expires_at,
        "email_sent_at":               None,
        "scheduled_for":               None,
        "reminder_sent_at":            None,
        "nudge_sent_at":               None,
        "completed_at":                None,
        "answer_count":                0,
        "defer_count":                 0,
        # Pro-side info counter (no auto-pause — pro decides).
        "consecutive_missed_batches":  0,
    }
    await db.client_review_batches.insert_one(doc)

    # Stamp source items with batch_id so the aggregator won't re-see
    # them. Split by collection because `transactions` and
    # `agent_findings` may have different indexes.
    by_coll: dict[str, list[str]] = {}
    for it in items:
        by_coll.setdefault(it["source_collection"], []).append(it["source_id"])
    for coll, ids in by_coll.items():
        try:
            await db[coll].update_many(
                {"id": {"$in": ids}, "company_id": company_id},
                {"$set": {"batch_id": batch_id, "updated_at": now_iso()}},
            )
        except Exception:  # noqa: BLE001 — never fail batch creation on stamp
            pass
    return doc


# --------------------------------------------------------------------------
# Email dispatch — Milestone B
# --------------------------------------------------------------------------

def _est_minutes(item_count: int) -> str:
    """Human-friendly estimate for the email body. ~30 sec per item,
    rounded to the nearest minute with a floor of 2 min so the CTA
    never reads 'takes about 0 minutes.'"""
    minutes = max(2, round(item_count * 0.5))
    return f"about {minutes} minute{'s' if minutes != 1 else ''}"


def _first_name(email: str, contact_name: str | None = None) -> str:
    """Best-effort first name for the greeting. Prefers the contact's
    stored name (space-split, take first token); falls back to the
    email local-part with underscores/dots normalized.
    """
    if contact_name:
        first = contact_name.split()[0].strip()
        if first and first.isalpha():
            return first
    local = (email or "").split("@", 1)[0]
    local = local.replace(".", " ").replace("_", " ").replace("-", " ")
    first = local.split()[0] if local.split() else "there"
    return first.title() if first else "there"


def _render_batch_email(
    *, first_name: str, item_count: int, review_url: str,
    schedule_url: str, firm_name: str | None,
) -> tuple[str, str, str]:
    """Return (subject, html, text) for the batch email.

    Two CTAs (Answer now / Schedule for later). Every question in the
    review page has its own 'not sure — send to my bookkeeper' escape,
    so we don't repeat that promise here.
    """
    subject = (f"Quick check-in — {item_count} question"
               f"{'s' if item_count != 1 else ''} when you have a moment")
    est = _est_minutes(item_count)
    sig_line = firm_name or "Your bookkeeping team"

    html = f"""\
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#0f172a;line-height:1.5;max-width:560px;margin:0 auto;padding:24px 20px;">
  <p style="margin:0 0 16px;font-size:16px;">Hi {first_name},</p>

  <p style="margin:0 0 16px;font-size:15px;">
    I've got <strong>{item_count} question{'s' if item_count != 1 else ''}</strong>
    that need your input — nothing urgent, but they'll keep your books
    accurate and might save you money at tax time.
  </p>

  <div style="margin:24px 0;">
    <a href="{review_url}"
       target="_blank" rel="noopener noreferrer"
       style="display:inline-block;padding:12px 20px;background:#0f172a;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:600;font-size:14px;margin-right:12px;margin-bottom:8px;">
      Answer now →
    </a>
    <a href="{schedule_url}"
       target="_blank" rel="noopener noreferrer"
       style="display:inline-block;padding:12px 20px;background:#ffffff;color:#0f172a;text-decoration:none;border-radius:8px;font-weight:600;font-size:14px;border:1px solid #cbd5e1;">
      Schedule for later
    </a>
  </div>

  <p style="margin:0 0 8px;font-size:13px;color:#64748b;">
    Every question has a "not sure — send to my bookkeeper" option if
    you'd rather defer. Takes {est} if you knock them out in one sitting.
  </p>

  <p style="margin:32px 0 0;font-size:14px;color:#334155;">— {sig_line}</p>
</div>"""
    text = (
        f"Hi {first_name},\n\n"
        f"I've got {item_count} question{'s' if item_count != 1 else ''} "
        f"that need your input — nothing urgent, but they'll keep your "
        f"books accurate and might save you money at tax time.\n\n"
        f"Answer now:      {review_url}\n"
        f"Schedule for later: {schedule_url}\n\n"
        f"Every question has a \"not sure — send to my bookkeeper\" "
        f"option if you'd rather defer. Takes {est} if you knock them "
        f"out in one sitting.\n\n"
        f"— {sig_line}\n"
    )
    return subject, html, text


async def dispatch_batch_email(batch: dict) -> dict:
    """Render + send the batch email. Idempotent: refuses to re-send
    a batch whose `email_sent_at` is already set.

    Returns the dispatch result dict from `email_dispatcher.dispatch`,
    OR a `skipped` dict if we bailed before hitting Resend.
    """
    from email_dispatcher import dispatch, public_base_url

    if batch.get("email_sent_at"):
        return {"status": "skipped_already_sent", "batch_id": batch["id"]}

    company = await db.companies.find_one({"id": batch["company_id"]})
    if not company:
        return {"status": "skipped_no_company", "batch_id": batch["id"]}

    # Assigned pro drives branding + the `client_review_batch` pref
    # check (a pro can turn these off for a specific client).
    pro_user_id = (
        company.get("primary_pro_id")
        or company.get("owner_id")
        or company.get("created_by")
    )
    pro = None
    if pro_user_id:
        pro = await db.users.find_one({"id": pro_user_id})

    # Firm name for the sender + email signature. Same cascade the
    # existing dispatcher uses — no bespoke handling.
    firm_name = None
    if pro:
        firm_name = ((pro.get("branding") or {}).get("firm_name")
                     or pro.get("firm_name"))

    # Best-effort first name — prefer the contact record for this email
    # over the email local-part.
    contact = await db.contacts.find_one({
        "company_id": batch["company_id"],
        "email":      batch["client_email"],
    })
    first = _first_name(
        batch["client_email"],
        contact_name=(contact or {}).get("name"),
    )

    base = public_base_url()
    token = batch["client_token"]
    review_url   = f"{base}/client-review/{token}"
    schedule_url = f"{base}/client-review/{token}?action=schedule"

    subject, html, text = _render_batch_email(
        first_name=first,
        item_count=len(batch.get("items") or []),
        review_url=review_url,
        schedule_url=schedule_url,
        firm_name=firm_name,
    )

    result = await dispatch(
        kind="client_review_batch",
        to=batch["client_email"],
        subject=subject,
        html=html,
        text=text,
        initiating_user_id=pro_user_id,
        company_id=batch["company_id"],
        related={"batch_id": batch["id"],
                 "item_count": len(batch.get("items") or [])},
    )

    # Only stamp `email_sent_at` when Resend actually accepted it. A
    # `skipped_pref_off` or `failed` result leaves the batch open so a
    # future run can retry once the pref flips back on / SMTP heals.
    if result.get("status") == "sent":
        await db.client_review_batches.update_one(
            {"id": batch["id"]},
            {"$set": {"email_sent_at":         now_iso(),
                      "email_dispatch_id":     result.get("id"),
                      "email_resend_id":       result.get("resend_id")}},
        )
    elif result.get("status") == "skipped_pref_off":
        # No retry — pro opted out. Mark the batch dead so we don't
        # try again on every cron tick. Items go back to the pool via
        # `expire_stale_batches` on the next sweep.
        await db.client_review_batches.update_one(
            {"id": batch["id"]},
            {"$set": {"status":              "expired",
                      "expired_at":          now_iso(),
                      "expire_reason":       "pref_off"}},
        )
    return result


async def _pick_client_email(company: dict) -> str | None:
    """Return the email to send the batch to. Preference order:
      1. `company.client_email` — the owner-facing address the pro
         explicitly set for this book.
      2. `owner_email` — set at company create time.
      3. The user record for `company.owner_id`.
    """
    email = (company.get("client_email")
             or company.get("owner_email"))
    if email:
        return email
    owner_id = company.get("owner_id")
    if owner_id:
        u = await db.users.find_one({"id": owner_id}, {"email": 1})
        if u:
            return u.get("email")
    return None


async def trigger_and_dispatch_batches(*, only_company_id: str | None = None) -> dict:
    """Cron entrypoint. Iterates companies (or one), evaluates the
    cadence gate, mints a batch + dispatches the email when ready.

    Contract:
      * Never raises. A single-company failure logs + continues.
      * Returns a summary keyed for the scheduler-log JSON.
    """
    q: dict[str, Any] = {}
    if only_company_id:
        q["id"] = only_company_id

    evaluated = fired = skipped = errored = 0
    reasons: dict[str, int] = {}

    async for company in db.companies.find(q, {"id": 1, "name": 1,
                                               "client_email": 1,
                                               "owner_email": 1,
                                               "owner_id": 1,
                                               "primary_pro_id": 1,
                                               "created_by": 1,
                                               "created_at": 1,
                                               "pause_review_batches": 1}):
        evaluated += 1
        try:
            if company.get("pause_review_batches"):
                skipped += 1
                reasons["paused_by_pro"] = reasons.get("paused_by_pro", 0) + 1
                continue

            client_email = await _pick_client_email(company)
            if not client_email:
                skipped += 1
                reasons["no_client_email"] = reasons.get("no_client_email", 0) + 1
                continue

            ok, reason, items = await should_fire_batch(
                company["id"], client_email,
            )
            if not ok:
                skipped += 1
                reasons[reason] = reasons.get(reason, 0) + 1
                continue

            batch = await create_batch(company["id"], client_email, items)
            result = await dispatch_batch_email(batch)
            if result.get("status") == "sent":
                fired += 1
            else:
                skipped += 1
                dispatch_status = result.get("status", "dispatch_failed")
                reasons[dispatch_status] = reasons.get(dispatch_status, 0) + 1
        except Exception as e:  # noqa: BLE001 — one bad tenant can't kill the sweep
            errored += 1
            logger.exception("client_review batch failed for %s: %s",
                             company.get("id"), e)
    return {
        "evaluated": evaluated, "fired": fired,
        "skipped": skipped, "errored": errored,
        "skip_reasons": reasons,
    }


# --------------------------------------------------------------------------
# Scheduling + reminder flow — Milestone D
# --------------------------------------------------------------------------

async def schedule_batch(batch: dict, scheduled_for_iso: str) -> dict:
    """Attach a scheduled follow-up time. Accepts any valid ISO
    datetime; caller resolves timezone before passing. Cannot
    schedule past the batch's own expiry. Idempotent: setting the
    same time again is a no-op.
    """
    if batch.get("status") not in ("open", "scheduled"):
        raise ValueError(f"batch is {batch.get('status')}, cannot schedule")
    dt = datetime.fromisoformat(scheduled_for_iso.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    now = datetime.now(timezone.utc)
    if dt <= now:
        raise ValueError("scheduled_for must be in the future")
    expires_at = datetime.fromisoformat(
        batch["expires_at"].replace("Z", "+00:00"),
    )
    if dt >= expires_at:
        raise ValueError("scheduled_for must be before batch expiry")

    await db.client_review_batches.update_one(
        {"id": batch["id"]},
        {"$set": {"scheduled_for": dt.isoformat(),
                  "status":        "scheduled",
                  # Clear any prior reminder marker so the cron will fire
                  # the new time (this covers reschedules too — active
                  # reschedule replaces the prior schedule outright).
                  "reminder_sent_at": None,
                  "updated_at":       now.isoformat()}},
    )
    return {"ok": True, "scheduled_for": dt.isoformat()}


def _batch_has_engagement(batch: dict) -> bool:
    """True if the client has interacted with the batch in any way —
    answered an item, deferred one, or exchanged even one AI turn.
    Used to gate the passive-miss nudge (we only nudge silent clients).
    """
    if batch.get("answer_count", 0) or batch.get("defer_count", 0):
        return True
    for it in batch.get("items") or []:
        if it.get("answered_at") or it.get("deferred"):
            return True
        if it.get("messages"):
            return True
    return False


async def _dispatch_reminder(batch: dict, *, kind: str) -> dict:
    """Send one of the two reminder emails.

      * `kind = "reminder"`     — client picked a time, that time
                                  arrived, they haven't engaged yet.
                                  Same tone as the original batch email.
      * `kind = "passive_miss"` — the reminder went out >24h ago and
                                  they still haven't engaged. Adds a
                                  third CTA ("talk to your bookkeeper").
    """
    from email_dispatcher import dispatch, public_base_url

    company = await db.companies.find_one({"id": batch["company_id"]})
    if not company:
        return {"status": "skipped_no_company"}

    pro_user_id = (company.get("primary_pro_id") or company.get("owner_id"))
    pro = await db.users.find_one({"id": pro_user_id}) if pro_user_id else None
    firm_name = ((pro or {}).get("branding") or {}).get("firm_name")

    contact = await db.contacts.find_one({
        "company_id": batch["company_id"], "email": batch["client_email"],
    })
    first = _first_name(batch["client_email"],
                        contact_name=(contact or {}).get("name"))
    base = public_base_url()
    token = batch["client_token"]
    review_url    = f"{base}/client-review/{token}"
    schedule_url  = f"{base}/client-review/{token}?action=schedule"

    item_count = len([i for i in (batch.get("items") or [])
                      if not i.get("answered_at") and not i.get("deferred")])
    sig = firm_name or "Your bookkeeping team"

    if kind == "reminder":
        subject = f"Ready when you are — {item_count} quick question{'s' if item_count != 1 else ''}"
        opening = ("You scheduled a moment to answer some quick "
                   "questions about your books. Whenever you're ready:")
        cta_row = f"""
  <div style="margin:24px 0;">
    <a href="{review_url}"
       target="_blank" rel="noopener noreferrer"
       style="display:inline-block;padding:12px 20px;background:#0f172a;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:600;font-size:14px;margin-right:12px;margin-bottom:8px;">Answer now →</a>
    <a href="{schedule_url}"
       target="_blank" rel="noopener noreferrer"
       style="display:inline-block;padding:12px 20px;background:#ffffff;color:#0f172a;text-decoration:none;border-radius:8px;font-weight:600;font-size:14px;border:1px solid #cbd5e1;">Pick a new time</a>
  </div>"""
        text_ctas = (f"Answer now:      {review_url}\n"
                     f"Pick a new time: {schedule_url}\n")
    else:  # passive_miss
        subject = f"Still here when you have a minute — {item_count} quick question{'s' if item_count != 1 else ''}"
        opening = ("We missed our scheduled time earlier. No worries — "
                   "pick whatever works, or hop on a call with your "
                   "bookkeeper if that's easier.")
        cta_row = f"""
  <div style="margin:24px 0;">
    <a href="{review_url}"
       target="_blank" rel="noopener noreferrer"
       style="display:inline-block;padding:12px 20px;background:#0f172a;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:600;font-size:14px;margin-right:12px;margin-bottom:8px;">Answer now →</a>
    <a href="{schedule_url}"
       target="_blank" rel="noopener noreferrer"
       style="display:inline-block;padding:12px 20px;background:#ffffff;color:#0f172a;text-decoration:none;border-radius:8px;font-weight:600;font-size:14px;border:1px solid #cbd5e1;margin-right:12px;margin-bottom:8px;">Pick a new time</a>
    <a href="mailto:{(pro or {}).get('email') or 'your bookkeeper'}"
       target="_blank" rel="noopener noreferrer"
       style="display:inline-block;padding:12px 20px;background:#ffffff;color:#0f172a;text-decoration:none;border-radius:8px;font-weight:600;font-size:14px;border:1px solid #cbd5e1;">Talk to my bookkeeper</a>
  </div>"""
        text_ctas = (f"Answer now:            {review_url}\n"
                     f"Pick a new time:       {schedule_url}\n"
                     f"Talk to my bookkeeper: {(pro or {}).get('email') or ''}\n")

    html = f"""\
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#0f172a;line-height:1.5;max-width:560px;margin:0 auto;padding:24px 20px;">
  <p style="margin:0 0 16px;font-size:16px;">Hi {first},</p>
  <p style="margin:0 0 16px;font-size:15px;">{opening}</p>
  {cta_row}
  <p style="margin:32px 0 0;font-size:14px;color:#334155;">— {sig}</p>
</div>"""
    text = (f"Hi {first},\n\n{opening}\n\n{text_ctas}\n"
            f"— {sig}\n")

    return await dispatch(
        kind="client_review_batch",
        to=batch["client_email"],
        subject=subject,
        html=html, text=text,
        initiating_user_id=pro_user_id,
        company_id=batch["company_id"],
        related={"batch_id": batch["id"], "reminder_kind": kind},
    )


async def send_scheduled_reminders() -> dict:
    """Cron tick: find scheduled batches whose time has arrived and
    fire the reminder email. Idempotent — stamps `reminder_sent_at`
    so a batch is nudged once, not once per tick.
    """
    now = datetime.now(timezone.utc)
    sent = errored = 0

    cursor = db.client_review_batches.find({
        "status":           "scheduled",
        "scheduled_for":    {"$ne": None, "$lte": now.isoformat()},
        "reminder_sent_at": None,
    })
    async for batch in cursor:
        if _batch_has_engagement(batch):
            # Already answered / deferred / chatted → don't nag.
            await db.client_review_batches.update_one(
                {"id": batch["id"]},
                {"$set": {"reminder_skipped_engaged": True,
                          "updated_at": now.isoformat()}},
            )
            continue
        try:
            result = await _dispatch_reminder(batch, kind="reminder")
            if result.get("status") == "sent":
                sent += 1
                await db.client_review_batches.update_one(
                    {"id": batch["id"]},
                    {"$set": {"reminder_sent_at": now_iso(),
                              "updated_at":       now_iso()}},
                )
        except Exception:  # noqa: BLE001
            errored += 1
            logger.exception("scheduled reminder failed for batch %s",
                             batch.get("id"))
    return {"sent": sent, "errored": errored}


async def send_passive_miss_nudges() -> dict:
    """Cron tick: batches where the reminder went out >24h ago and the
    client still hasn't engaged. Fire ONE nudge with the three-CTA
    variant, then stamp `nudge_sent_at` so we never nudge again.
    """
    cutoff = (datetime.now(timezone.utc) - timedelta(hours=24)).isoformat()
    sent = errored = 0

    cursor = db.client_review_batches.find({
        "status":            "scheduled",
        "reminder_sent_at":  {"$ne": None, "$lt": cutoff},
        "nudge_sent_at":     None,
    })
    async for batch in cursor:
        if _batch_has_engagement(batch):
            await db.client_review_batches.update_one(
                {"id": batch["id"]},
                {"$set": {"nudge_skipped_engaged": True,
                          "updated_at": now_iso()}},
            )
            continue
        try:
            result = await _dispatch_reminder(batch, kind="passive_miss")
            if result.get("status") == "sent":
                sent += 1
                await db.client_review_batches.update_one(
                    {"id": batch["id"]},
                    {"$set": {"nudge_sent_at": now_iso(),
                              "updated_at":    now_iso()}},
                )
        except Exception:  # noqa: BLE001
            errored += 1
            logger.exception("passive-miss nudge failed for batch %s",
                             batch.get("id"))
    return {"sent": sent, "errored": errored}


async def client_review_tick() -> dict:
    """One combined cron tick for the whole batch flow. The parent
    scheduler calls this every N minutes; internally we sequence:
      1. Send scheduled reminders whose time has arrived
      2. Send passive-miss nudges (reminder + 24h, still silent)
      3. Expire stale batches (14d hard, or 5d post-nudge silence)
      4. Trigger fresh batches for companies that pass the cadence gate
      5. Vendor outreach — send scheduled follow-ups + kick off new
         outreaches for contacts stamped `w9_follow_up_requested`.

    Order matters: we expire BEFORE triggering so items released from
    an expiring batch are immediately eligible for the next one.
    """
    r = await send_scheduled_reminders()
    n = await send_passive_miss_nudges()
    e = await expire_stale_batches()
    t = await trigger_and_dispatch_batches()
    # Vendor outreach follow-up sweep (Milestone G).
    try:
        from vendor_outreach import vendor_outreach_tick
        v = await vendor_outreach_tick()
    except Exception:  # noqa: BLE001
        v = {"error": "vendor_outreach_tick_failed"}
        logger.exception("vendor_outreach_tick failed")
    return {"reminders": r, "nudges": n, "expired": e, "triggered": t,
            "vendor_outreach": v}


# --------------------------------------------------------------------------
# Expiry sweep — run from the scheduler cron
# --------------------------------------------------------------------------

async def expire_stale_batches() -> dict:
    """Mark batches as `expired` when either:
      * `expires_at < now` (14 days elapsed), OR
      * a passive-miss nudge was sent >5 days ago with zero engagement.
    Release items back to the pool by unsetting `batch_id` on sources.
    Returns a summary for the caller to log.
    """
    now = now_iso()
    nudge_cutoff = _days_ago(5)
    expired = 0
    items_released = 0

    cursor = db.client_review_batches.find({
        "status": {"$in": ["open", "scheduled"]},
        "$or": [
            {"expires_at": {"$lt": now}},
            {"$and": [
                {"nudge_sent_at": {"$ne": None, "$lt": nudge_cutoff}},
                {"answer_count": 0},
                {"defer_count": 0},
            ]},
        ],
    })
    async for batch in cursor:
        by_coll: dict[str, list[str]] = {}
        for it in batch.get("items") or []:
            if it.get("answered_at"):
                continue
            by_coll.setdefault(it["source_collection"], []).append(it["source_id"])
        for coll, ids in by_coll.items():
            try:
                r = await db[coll].update_many(
                    {"id": {"$in": ids}, "company_id": batch["company_id"]},
                    {"$unset": {"batch_id": ""}, "$set": {"updated_at": now}},
                )
                items_released += r.modified_count
            except Exception:  # noqa: BLE001
                pass
        await db.client_review_batches.update_one(
            {"id": batch["id"]},
            {"$set": {"status": "expired", "expired_at": now}},
        )
        expired += 1
    return {"expired_batches": expired, "items_released": items_released}


__all__ = [
    "ITEM_UNCATEGORIZED", "ITEM_VENDOR_MEMO", "ITEM_MISSING_RECEIPT",
    "ITEM_W9_NEEDED", "ITEM_AMBIGUOUS_TRANSFER", "ITEM_RECURRING",
    "ITEM_SETUP", "ITEM_SPLIT", "ITEM_LIABILITY_SPLIT",
    "BATCH_MIN_ITEMS", "BATCH_MIN_DAYS_BETWEEN", "BATCH_EXPIRY_DAYS",
    "collect_batch_items", "should_fire_batch", "create_batch",
    "expire_stale_batches", "has_open_batch", "last_batch_email_sent_at",
    "dispatch_batch_email", "trigger_and_dispatch_batches",
    "schedule_batch", "send_scheduled_reminders",
    "send_passive_miss_nudges", "client_review_tick",
]
