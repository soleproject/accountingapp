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
    "stripe_welcome":           True,   # Post-Stripe-checkout welcome + set-password magic link
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
    write one row to the audit log. Never raises.

    When `initiating_user_id` is a pro with a firm_name set in their
    branding, the outbound email uses the firm's white-label sender
    (`{firm} <no-reply@accountingapp.ai>`). This keeps clients' inboxes
    free of "SmartBooks" branding when they signed up under a firm.
    """
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
    firm_name: Optional[str] = None
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
        # Look up the initiator's firm branding once — used to pick the
        # firm-white-label From address in send_email.
        u = await db.users.find_one({"id": initiating_user_id})
        if u and (u.get("branding") or {}).get("firm_name"):
            firm_name = u["branding"]["firm_name"]

    try:
        resp = await send_email(
            to=to, subject=subject, html=html, text=text, reply_to=reply_to,
            firm_name=firm_name,
        )
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

def public_base_url(firm_slug: str | None = None) -> str:
    """Best-effort public **frontend** base URL for magic-link emails.

    Resolution order:
      1. If ``firm_slug`` is given and ``PRIVATE_LABEL_HOST_TEMPLATE`` is
         set (e.g. ``https://{slug}.accountingapp.ai``), build the
         firm-branded URL so a client onboarded via a private-label pro
         gets a magic link on their firm's subdomain (not the platform).
      2. ``PUBLIC_APP_URL`` — the platform frontend (e.g.
         ``https://app.smartbookssoftware.ai``). This is the one that
         MUST be set in prod — it's the host where the React SPA lives
         and knows how to render ``/set-password/{token}``.
      3. ``PRIMARY_HOST`` — bare hostname, we add ``https://``.
      4. ``PUBLIC_BACKEND_URL`` — LAST resort. Only correct in preview
         environments where the backend and frontend share a host. In
         production this returns the API domain which has no SPA
         routes, so magic links 404. Kept here purely as a legacy
         fallback; production must set ``PUBLIC_APP_URL``.
    """
    if firm_slug:
        template = os.environ.get("PRIVATE_LABEL_HOST_TEMPLATE")
        if template:
            return template.replace("{slug}", firm_slug).rstrip("/")
    for env_key in ("PUBLIC_APP_URL",):
        v = os.environ.get(env_key)
        if v:
            return v.rstrip("/")
    primary = os.environ.get("PRIMARY_HOST")
    if primary:
        # PRIMARY_HOST is a bare hostname; make it a full URL.
        return f"https://{primary.strip().lstrip('https://').lstrip('http://').rstrip('/')}"
    fallback = os.environ.get("PUBLIC_BACKEND_URL")
    if fallback:
        import logging as _lg
        _lg.getLogger(__name__).warning(
            "public_base_url falling back to PUBLIC_BACKEND_URL — set PUBLIC_APP_URL "
            "on the backend env or magic-link emails will 404 in production."
        )
        return fallback.rstrip("/")
    return ""
