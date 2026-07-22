"""Central email dispatcher.

Every outbound email in the platform funnels through `dispatch()`. Job:
  1. Look up the initiating user's Communication preferences.
  2. If the pref for this email `kind` is disabled → log as `skipped_pref_off`
     and return without calling Resend.
  3. Otherwise call `email_service.send_email` and record the outcome
     (`sent` or `failed`) with the Resend id / error message so the
     Communications > Inbox tab always tells the truth about what left.

Failures NEVER raise. Callers (webhooks, cron, UI actions) can fire-and-
forget knowing that a broken SMTP won't take down a request.

Kinds & their default preference key:
    daily_pro_digest            — daily Needs-Attention roll-up to a Pro
    ask_client                  — Pro asks the client about a transaction
    dunning                     — customer receives A/R chase for an
                                  overdue invoice
    overdue_bill_client         — client owner receives A/P reminder for
                                  an overdue bill
    plaid_reauth                — client owner is told to re-authorize a
                                  broken Plaid link
    onboarding_followup         — client hasn't finished onboarding
    month_close_signoff         — client is asked to sign off on a closed
                                  month

All prefs default to True (turn-off-if-you-don't-want-them, not the
opposite — a first-time pro should get the value immediately).
"""
from __future__ import annotations

import logging
import os
import uuid
from typing import Optional

from db import db, now_iso
from email_service import send_email, EmailError

logger = logging.getLogger(__name__)

DEFAULT_PREFS = {
    "daily_pro_digest":         True,
    "ask_client":               True,   # Pro-initiated ask-client (labelled "Pro Ask Client")
    "ai_ask_client":            True,   # Fully-automated AI-initiated ask-client (opt-out)
    "client_welcome":           True,   # First-time client onboarding email
    "client_welcome_returning": True,   # "We added another company to your login"
    "password_reset":           True,   # Forgot-password magic link
    "team_invite":              True,   # Team/staff/pro/superadmin invitations
    "dunning":                  True,
    "overdue_bill_client":      True,
    "plaid_reauth":             True,
    "onboarding_followup":      True,
    "month_close_signoff":      True,
}


async def get_prefs(user_id: str) -> dict:
    """Return the merged preferences for a user. Missing rows / missing
    keys default to True — new toggles ship enabled so existing pros don't
    have to opt back in every release."""
    doc = await db.comms_prefs.find_one({"user_id": user_id})
    if not doc:
        return {**DEFAULT_PREFS, "user_id": user_id, "from_name": None}
    merged = {**DEFAULT_PREFS}
    for k, v in doc.items():
        if k in DEFAULT_PREFS and isinstance(v, bool):
            merged[k] = v
    merged["user_id"] = user_id
    merged["from_name"] = doc.get("from_name")
    return merged


async def set_prefs(user_id: str, patch: dict) -> dict:
    """Upsert a partial preference patch. Only known keys are accepted."""
    clean = {k: bool(v) for k, v in patch.items() if k in DEFAULT_PREFS}
    if "from_name" in patch and isinstance(patch["from_name"], (str, type(None))):
        clean["from_name"] = patch["from_name"] or None
    clean["updated_at"] = now_iso()
    await db.comms_prefs.update_one(
        {"user_id": user_id},
        {"$set": clean, "$setOnInsert": {"user_id": user_id, "created_at": now_iso()}},
        upsert=True,
    )
    return await get_prefs(user_id)


async def _log(entry: dict) -> str:
    """Insert a row into the audit log (`communications` collection). Every
    dispatch attempt lands here so the Inbox is always in-sync with reality."""
    entry.setdefault("id", str(uuid.uuid4()))
    entry.setdefault("sent_at", now_iso())
    await db.communications.insert_one(entry)
    return entry["id"]


async def dispatch(
    *,
    kind: str,
    to: str | list[str],
    subject: str,
    html: str,
    text: Optional[str] = None,
    reply_to: Optional[str] = None,
    initiating_user_id: Optional[str] = None,
    company_id: Optional[str] = None,
    contact_id: Optional[str] = None,
    related: Optional[dict] = None,
) -> dict:
    """Send an email of a given `kind` on behalf of `initiating_user_id` and
    write one row to the audit log. Never raises."""
    if kind not in DEFAULT_PREFS:
        # Unknown kinds are a coding bug, but we still audit-log the attempt
        # rather than swallow silently.
        log_id = await _log({
            "kind": kind, "to": to, "subject": subject,
            "status": "failed", "error": f"Unknown email kind: {kind}",
            "user_id": initiating_user_id, "company_id": company_id,
            "contact_id": contact_id, "related": related or {},
        })
        return {"status": "failed", "id": log_id, "error": f"Unknown email kind: {kind}"}

    # Check pref — but only if we know who's initiating the send. System-
    # level flows (e.g. daily cron) may pass None; skip the pref check in
    # that case since there's no user to have opted out.
    if initiating_user_id:
        prefs = await get_prefs(initiating_user_id)
        if not prefs.get(kind, True):
            log_id = await _log({
                "kind": kind, "to": to, "subject": subject,
                "status": "skipped_pref_off",
                "user_id": initiating_user_id, "company_id": company_id,
                "contact_id": contact_id, "related": related or {},
            })
            return {"status": "skipped_pref_off", "id": log_id}

    try:
        resp = await send_email(to=to, subject=subject, html=html, text=text, reply_to=reply_to)
    except EmailError as e:
        log_id = await _log({
            "kind": kind, "to": to, "subject": subject,
            "status": "failed", "error": str(e),
            "user_id": initiating_user_id, "company_id": company_id,
            "contact_id": contact_id, "related": related or {},
        })
        return {"status": "failed", "id": log_id, "error": str(e)}

    log_id = await _log({
        "kind": kind, "to": to, "subject": subject,
        "status": "sent", "resend_id": resp.get("id"),
        "user_id": initiating_user_id, "company_id": company_id,
        "contact_id": contact_id, "related": related or {},
    })
    return {"status": "sent", "id": log_id, "resend_id": resp.get("id")}


# --------------------------------------------------------------------------
# Public URL builder — reused by every "here's a link to reply" email.
# --------------------------------------------------------------------------

def public_base_url() -> str:
    """Best-effort public base URL for magic-link emails. Prefers an explicit
    PUBLIC_APP_URL, falls back to PUBLIC_BACKEND_URL (works because the
    frontend and backend are served from the same host in this deployment)."""
    return (
        os.environ.get("PUBLIC_APP_URL")
        or os.environ.get("PUBLIC_BACKEND_URL")
        or ""
    ).rstrip("/")
