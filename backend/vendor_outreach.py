"""Milestone G — AI Vendor Follow-Up for W-9 collection.

When the client's answer during a batch review says "please reach out
to the vendor for the W-9" (`flow=follow_up` in `client_review_handlers._handle_w9_needed`),
the contact is stamped `w9_follow_up_requested=True`. This module picks
those up and runs the actual outreach loop:

  1. Find a vendor email (from `contacts.email` or from the
     `agent_findings.meta.contact_email` if the resolver stashed one).
  2. If no email → skip send, emit an `agent_findings` task
     (`vendor_email_missing`) so the pro/client fills it in.
  3. Email vendor via Resend with a unique per-outreach reply-to token.
     Reply-To: `w9-reply+<outreach_id>@<VENDOR_INBOUND_DOMAIN>`.
  4. Weekly follow-ups until vendor replies OR client/pro says stop.
     No expiry — the loop continues indefinitely per spec.
  5. When vendor replies (Resend Inbound → `/api/vendor-outreach/inbound`),
     Haiku parses the message. If a W-9 PDF is attached:
       - Attach to `contacts.attachments`
       - Set `contacts.w9_on_file=True`
       - Emit `agent_findings` audit card (`w9_auto_captured`) for pro
         verification — surfaces in Cockpit V2 Judgment section.
     If the vendor asks us to stop → mark stopped + notify pro.
     If Haiku can't classify → escalate to pro without another follow-up.

Guardrails
----------
* Doc-kind is hard-coded to `w9` for this milestone. The `doc_kind`
  field on the outreach doc is future-proofed for `receipt`.
* Test-recipient guard in `email_dispatcher.dispatch` still applies —
  outreach to `@example.com` never actually hits Resend.
* Nothing sends the pro's real email to the vendor; From is the firm's
  Resend-branded sender, Reply-To is our routing address.
"""
from __future__ import annotations
import logging
import os
import secrets
import uuid
from datetime import datetime, timezone, timedelta
from typing import Any

from deps import db

logger = logging.getLogger("axiom.vendor_outreach")


DOC_KIND_W9 = "w9"

# 7-day gap between follow-up sends. Unlimited count per user spec —
# outreach only ends when vendor replies or someone explicitly stops it.
FOLLOWUP_INTERVAL_DAYS = 7


# --------------------------------------------------------------------------
# Time helpers
# --------------------------------------------------------------------------

def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _days_from_now(days: int) -> str:
    return (datetime.now(timezone.utc) + timedelta(days=days)).isoformat()


# --------------------------------------------------------------------------
# Reply-To routing token
# --------------------------------------------------------------------------

def _inbound_domain() -> str:
    """The domain Resend Inbound listens on. Defaults to a placeholder
    so that reply-to values in emails are always well-formed even in
    envs where the DNS isn't wired up yet.
    """
    return os.environ.get(
        "VENDOR_INBOUND_DOMAIN",
        "reply.accountingapp.ai",
    )


def build_reply_to(outreach_id: str) -> str:
    """Compose the per-outreach Reply-To. Resend Inbound will forward
    anything sent to this address into our `/api/vendor-outreach/inbound`
    webhook (once the mailbox route is registered in Resend). We parse
    the `+<outreach_id>` piece to look up the state.
    """
    return f"w9-reply+{outreach_id}@{_inbound_domain()}"


def parse_reply_to(addr: str) -> str | None:
    """Return the outreach id embedded in an inbound `to` address, or
    None if the address doesn't match our routing convention.
    """
    if not addr:
        return None
    local, sep, _domain = addr.partition("@")
    if not sep:
        return None
    if not local.startswith("w9-reply+"):
        return None
    tail = local[len("w9-reply+"):].strip()
    return tail or None


# --------------------------------------------------------------------------
# Outreach doc CRUD
# --------------------------------------------------------------------------

async def _ensure_indexes() -> None:
    """Idempotent — safe to call on every module import."""
    try:
        await db.vendor_outreaches.create_index(
            [("company_id", 1), ("contact_id", 1), ("doc_kind", 1)],
        )
        await db.vendor_outreaches.create_index("status")
        await db.vendor_outreaches.create_index("next_send_at")
    except Exception:  # noqa: BLE001 — never fail import over indexing
        pass


async def find_active_outreach(
    company_id: str, contact_id: str, doc_kind: str = DOC_KIND_W9,
) -> dict | None:
    """Return the OPEN or awaiting_reply outreach for this vendor if
    one exists — de-dupe guard so we never open a second thread while
    the first is still live.
    """
    return await db.vendor_outreaches.find_one({
        "company_id": company_id,
        "contact_id": contact_id,
        "doc_kind":   doc_kind,
        "status":     {"$in": ["open", "awaiting_reply"]},
    })


async def create_outreach(
    *, company_id: str, contact_id: str, vendor_name: str,
    vendor_email: str | None, doc_kind: str = DOC_KIND_W9,
    agent_finding_id: str | None = None, batch_id: str | None = None,
    initiating_user_id: str | None = None,
) -> dict:
    """Insert a fresh outreach doc. Caller decides whether to also
    send the first email (see `send_next_touch`) — this only builds
    the state.
    """
    oid = str(uuid.uuid4())
    doc: dict[str, Any] = {
        "id":                 oid,
        "company_id":         company_id,
        "contact_id":         contact_id,
        "vendor_name":        vendor_name,
        "vendor_email":       (vendor_email or "").strip().lower() or None,
        "doc_kind":           doc_kind,
        "status":             "open" if vendor_email else "escalated_no_email",
        "agent_finding_id":   agent_finding_id,
        "batch_id":           batch_id,
        "initiating_user_id": initiating_user_id,
        "created_at":         now_iso(),
        "updated_at":         now_iso(),
        "last_sent_at":       None,
        "next_send_at":       None,   # set once first send lands
        "sent_count":         0,
        "reply_token":        secrets.token_urlsafe(16),
        "messages":           [],
        "completed_at":       None,
        "completed_reason":   None,
        "stopped_by":         None,
        "stopped_reason":     None,
    }
    await db.vendor_outreaches.insert_one(doc)
    return doc


# --------------------------------------------------------------------------
# Vendor email discovery
# --------------------------------------------------------------------------

async def _vendor_email_for(company_id: str, contact_id: str) -> tuple[str | None, str]:
    """Return (email, vendor_name). Email may be None if the contact
    has no `email` field on file. We do NOT fall back to Plaid
    enrichment — per Milestone G spec, missing emails become a task
    for the pro/client to fill in.
    """
    c = await db.contacts.find_one({"id": contact_id, "company_id": company_id})
    if not c:
        return None, ""
    return (c.get("email") or "").strip().lower() or None, c.get("name") or ""


# --------------------------------------------------------------------------
# Email composition — Haiku with a tight formal tone.
# --------------------------------------------------------------------------

async def _compose_email(
    *, outreach: dict, kind: str, firm_name: str | None, client_company_name: str,
) -> tuple[str, str, str]:
    """Return (subject, html, text). Uses Haiku for the body so tone
    stays natural across repeats; falls back to a fixed template if
    the LLM is unavailable.

    `kind` ∈ {"initial", "followup"}.
    """
    signer = firm_name or f"{client_company_name} bookkeeping team"
    vendor = outreach["vendor_name"] or "there"

    subject_initial = f"W-9 request for {client_company_name}"
    subject_followup = f"Following up — W-9 for {client_company_name}"
    subject = subject_initial if kind == "initial" else subject_followup

    fallback_body = (
        "Hi {vendor_greeting},\n\n"
        "I'm the bookkeeper for {client_company_name}. To close our books "
        "for the year we need a completed Form W-9 on file for your "
        "business. If you can reply to this email with the completed "
        "W-9 attached (PDF is easiest), we'll take care of the rest.\n\n"
        "If you've already sent one recently, please forgive the "
        "duplicate ask — it may have gotten lost.\n\n"
        "Thanks so much,\n{signer}"
    ).format(
        vendor_greeting=vendor,
        client_company_name=client_company_name,
        signer=signer,
    )

    text_body = fallback_body
    # Try Haiku for a more natural tone. Never fail the send on LLM error.
    try:
        api_key = os.environ.get("EMERGENT_LLM_KEY", "")
        if api_key:
            from llm_client import LlmChat, UserMessage
            chat = LlmChat(
                api_key=api_key,
                system_message=(
                    "You are a professional bookkeeper drafting a short "
                    "email to a vendor to collect a completed IRS Form "
                    "W-9. Rules:\n"
                    "  * 4 sentences max. No preamble, no signoff.\n"
                    "  * Warm but professional — never pushy.\n"
                    "  * Ask them to reply with the W-9 attached as PDF.\n"
                    "  * If this is a follow-up, acknowledge that briefly.\n"
                    "  * Never mention 'AI' or that you're an assistant.\n"
                    "  * Output the plain text body only. No subject, no salutation, no signature."
                ),
                feature="vendor_outreach_compose",
                company_id=outreach["company_id"],
            ).with_model("anthropic", "claude-haiku-4-5-20251001")
            prompt = (
                f"Draft the {'initial' if kind == 'initial' else 'follow-up'} email body.\n"
                f"Vendor name: {vendor}\n"
                f"Client company: {client_company_name}\n"
                f"Bookkeeper signature: {signer}\n"
                f"Prior emails sent: {outreach.get('sent_count', 0)}"
            )
            body = (await chat.send_message(UserMessage(content=prompt))).strip()
            if body:
                text_body = (
                    f"Hi {vendor},\n\n{body}\n\n"
                    f"Thanks,\n{signer}"
                )
    except Exception:  # noqa: BLE001
        logger.exception("vendor_outreach compose failed — using fallback body")

    paras = [p for p in text_body.split('\n\n') if p.strip()]
    body_html = ''.join(
        f'<p style="margin:0 0 14px;font-size:15px;">{para}</p>'
        for para in paras
    )
    html = f"""\
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#0f172a;line-height:1.5;max-width:560px;margin:0 auto;padding:24px 20px;">
  {body_html}
</div>"""
    return subject, html, text_body


# --------------------------------------------------------------------------
# Send a touch — initial OR follow-up. Idempotent per state.
# --------------------------------------------------------------------------

async def send_next_touch(outreach: dict) -> dict:
    """Send the next email in the sequence and update state. Returns
    the dispatch result dict.
    """
    if outreach["status"] not in ("open", "awaiting_reply"):
        return {"status": "skipped_status", "outreach_id": outreach["id"]}
    if not outreach.get("vendor_email"):
        return {"status": "skipped_no_email", "outreach_id": outreach["id"]}

    from email_dispatcher import dispatch

    company = await db.companies.find_one({"id": outreach["company_id"]}) or {}
    client_company_name = company.get("name") or "our client"
    pro_user_id = (company.get("primary_pro_id")
                   or company.get("owner_id")
                   or outreach.get("initiating_user_id"))
    pro_doc = None
    if pro_user_id:
        pro_doc = await db.users.find_one({"id": pro_user_id})
    firm_name = ((pro_doc or {}).get("branding") or {}).get("firm_name")

    kind = "initial" if outreach.get("sent_count", 0) == 0 else "followup"
    subject, html, text = await _compose_email(
        outreach=outreach, kind=kind,
        firm_name=firm_name, client_company_name=client_company_name,
    )
    reply_to = build_reply_to(outreach["id"])

    result = await dispatch(
        kind="vendor_w9_outreach",
        to=outreach["vendor_email"],
        subject=subject, html=html, text=text,
        reply_to=reply_to,
        initiating_user_id=pro_user_id,
        company_id=outreach["company_id"],
        contact_id=outreach["contact_id"],
        related={"outreach_id": outreach["id"], "doc_kind": outreach["doc_kind"],
                 "touch_kind": kind},
    )

    message_row = {
        "direction":     "out",
        "sent_at":       now_iso(),
        "subject":       subject,
        "text":          text,
        "kind":          kind,
        "resend_id":     result.get("resend_id"),
        "dispatch_id":   result.get("id"),
        "dispatch_status": result.get("status"),
    }
    updates: dict[str, Any] = {
        "$push": {"messages": message_row},
        "$set":  {"updated_at": now_iso()},
    }
    if result.get("status") == "sent":
        updates["$set"].update({
            "status":       "awaiting_reply",
            "last_sent_at": now_iso(),
            "next_send_at": _days_from_now(FOLLOWUP_INTERVAL_DAYS),
        })
        updates["$inc"] = {"sent_count": 1}
    # Non-sent statuses (skipped_pref_off, failed, skipped_test_recipient)
    # leave next_send_at alone — cron will retry on next tick.

    await db.vendor_outreaches.update_one({"id": outreach["id"]}, updates)
    return result


# --------------------------------------------------------------------------
# Kickoff — called immediately after the client picks "follow_up" in the
# batch review chat, and from the cron sweep for any contacts stamped
# `w9_follow_up_requested` that don't yet have an outreach doc.
# --------------------------------------------------------------------------

async def start_outreach_for_contact(
    *, company_id: str, contact_id: str,
    agent_finding_id: str | None = None,
    batch_id: str | None = None,
    initiating_user_id: str | None = None,
) -> dict:
    """Idempotent entrypoint. If there's already an open outreach for
    this vendor+doc_kind, return it. Otherwise create one and (if we
    have an email) fire the first email.

    Returns the outreach doc (post-send).
    """
    await _ensure_indexes()

    existing = await find_active_outreach(company_id, contact_id, DOC_KIND_W9)
    if existing:
        return existing

    email, vendor_name = await _vendor_email_for(company_id, contact_id)
    outreach = await create_outreach(
        company_id=company_id, contact_id=contact_id,
        vendor_name=vendor_name or "vendor",
        vendor_email=email,
        agent_finding_id=agent_finding_id,
        batch_id=batch_id,
        initiating_user_id=initiating_user_id,
    )

    if not email:
        # Emit a task so the pro/client can fill the email in. Once
        # they do, the cron sweep picks the outreach up on the next
        # tick (see `vendor_outreach_tick`).
        await _emit_missing_email_task(
            company_id=company_id, contact_id=contact_id,
            vendor_name=vendor_name or "vendor",
            outreach_id=outreach["id"],
        )
        return outreach

    # Fire the first email immediately (autonomous per spec).
    await send_next_touch(outreach)
    return await db.vendor_outreaches.find_one({"id": outreach["id"]}) or outreach


async def _emit_missing_email_task(
    *, company_id: str, contact_id: str, vendor_name: str, outreach_id: str,
) -> None:
    """Surface a `vendor_email_missing` agent finding so the CPA has a
    place to add the vendor's email address. Idempotent per contact.
    """
    existing = await db.agent_findings.find_one({
        "company_id": company_id,
        "kind":       "vendor_email_missing",
        "contact_id": contact_id,
        "status":     "open",
    })
    if existing:
        return
    await db.agent_findings.insert_one({
        "id":         str(uuid.uuid4()),
        "company_id": company_id,
        "contact_id": contact_id,
        "kind":       "vendor_email_missing",
        "status":     "open",
        "severity":   "amber",
        "title":      f"Add an email for {vendor_name} so we can request their W-9",
        "detail":     "The client asked us to email this vendor for a W-9, but we "
                      "don't have an email on file. Add one on the contact record "
                      "and we'll take it from there.",
        "action_label": "Add vendor email",
        "action_route": f"/company/{company_id}/contacts?cid={contact_id}",
        "meta":       {"outreach_id": outreach_id},
        "created_at": now_iso(),
    })


# --------------------------------------------------------------------------
# Inbound processing — Resend inbound webhook posts here.
# --------------------------------------------------------------------------

_STOP_SIGNALS = (
    "stop", "unsubscribe", "not our vendor", "wrong address",
    "not us", "no longer", "please stop", "remove me", "do not contact",
)


def _looks_like_stop(text: str) -> bool:
    t = (text or "").lower()
    return any(s in t for s in _STOP_SIGNALS)


async def _classify_reply(reply_text: str, attachments: list[dict]) -> dict:
    """Ask Haiku to classify an inbound reply. Returns:
        {"kind": "w9_attached|stop|confused|other",
         "confidence": float,
         "reasoning": str}

    Falls back to keyword heuristics on LLM failure.
    """
    # Cheap keyword pre-check first — a clear stop signal never needs
    # a $0.001 LLM call.
    if _looks_like_stop(reply_text):
        return {"kind": "stop", "confidence": 0.95,
                "reasoning": "matched stop keyword"}

    has_pdf_attachment = any(
        (a.get("filename") or "").lower().endswith(".pdf")
        or (a.get("mime") or "").endswith("/pdf")
        for a in (attachments or [])
    )

    api_key = os.environ.get("EMERGENT_LLM_KEY", "")
    if not api_key:
        return {
            "kind": "w9_attached" if has_pdf_attachment else "other",
            "confidence": 0.4,
            "reasoning": "no LLM available — inferring from attachment",
        }
    try:
        from llm_client import LlmChat, UserMessage
        chat = LlmChat(
            api_key=api_key,
            system_message=(
                "You classify inbound email replies from vendors to a "
                "bookkeeper's W-9 request. Return ONLY a JSON object of "
                "the shape:\n"
                "{\"kind\":\"w9_attached|stop|confused|other\","
                "\"confidence\":0.0-1.0,\"reasoning\":\"short reason\"}\n\n"
                "Definitions:\n"
                "  * w9_attached — the reply attached a completed W-9 "
                "    (PDF or similar). Even a partial or scanned W-9 "
                "    counts.\n"
                "  * stop — vendor asked us to stop / said it's the "
                "    wrong address / said they aren't our vendor.\n"
                "  * confused — vendor doesn't understand and wants a "
                "    person to reply.\n"
                "  * other — anything else."
            ),
            feature="vendor_outreach_classify",
        ).with_model("anthropic", "claude-haiku-4-5-20251001")
        prompt = (
            f"Reply text:\n---\n{reply_text[:3000]}\n---\n\n"
            f"Attachment count: {len(attachments or [])}\n"
            f"Has PDF attachment: {has_pdf_attachment}"
        )
        raw = await chat.send_message(UserMessage(content=prompt))
        import json as _json
        import re as _re
        m = _re.search(r"\{[\s\S]*\}", raw or "")
        if m:
            parsed = _json.loads(m.group(0))
            if parsed.get("kind") in ("w9_attached", "stop", "confused", "other"):
                return parsed
    except Exception:  # noqa: BLE001
        logger.exception("vendor_outreach classify failed")
    return {
        "kind": "w9_attached" if has_pdf_attachment else "other",
        "confidence": 0.3,
        "reasoning": "LLM parse failed — inferring from attachment",
    }


async def process_inbound_reply(
    *, outreach_id: str, from_email: str, subject: str,
    text: str, html: str | None, attachments: list[dict],
) -> dict:
    """Handle one inbound reply. Returns a summary dict for the
    webhook to respond with (never raises).
    """
    outreach = await db.vendor_outreaches.find_one({"id": outreach_id})
    if not outreach:
        return {"status": "unknown_outreach", "outreach_id": outreach_id}

    # Always record the raw inbound message before we do any state
    # mutation — that way even a bug in the classifier can't cost us
    # the audit trail.
    await db.vendor_outreaches.update_one(
        {"id": outreach_id},
        {"$push": {"messages": {
            "direction":   "in",
            "received_at": now_iso(),
            "from":        from_email,
            "subject":     subject,
            "text":        text,
            "attachments": [{k: v for k, v in a.items() if k != "data_url"}
                            for a in (attachments or [])],
        }}, "$set": {"updated_at": now_iso()}},
    )

    classified = await _classify_reply(text, attachments or [])
    kind = classified.get("kind", "other")

    if kind == "w9_attached":
        return await _apply_w9_captured(outreach, attachments or [], classified)
    if kind == "stop":
        return await _mark_stopped(outreach, "vendor_stopped", classified)
    if kind == "confused":
        return await _escalate(outreach, "vendor_confused", classified)
    # "other" — pause the cadence and flag for human review.
    return await _escalate(outreach, "vendor_reply_needs_review", classified)


async def _apply_w9_captured(
    outreach: dict, attachments: list[dict], classified: dict,
) -> dict:
    """Store W-9 attachment on the contact, stamp `w9_on_file=True`,
    resolve the source finding, emit an audit card for the pro.
    """
    # Attach the first PDF-shaped file. If there are none but the
    # classifier still said w9_attached (rare), keep the outreach
    # completed but skip the attach step.
    doc = next(
        (a for a in attachments
         if (a.get("filename") or "").lower().endswith(".pdf")
         or (a.get("mime") or "").endswith("/pdf")),
        None,
    ) or (attachments[0] if attachments else None)

    updates: dict[str, Any] = {
        "$set": {
            "w9_on_file":  True,
            "w9_added_at": now_iso(),
            "w9_captured_via_vendor_outreach": True,
            "updated_at":  now_iso(),
        },
    }
    if doc:
        stored = {
            "filename":    doc.get("filename") or "w9.pdf",
            "size":        doc.get("size"),
            "mime":        doc.get("mime") or "application/pdf",
            "data_url":    doc.get("data_url"),
            "kind":        "w9",
            "uploaded_at": now_iso(),
            "uploaded_by": "vendor:reply",
        }
        updates["$push"] = {"attachments": stored}

    await db.contacts.update_one(
        {"id": outreach["contact_id"], "company_id": outreach["company_id"]},
        updates,
    )

    # Close the original W-9 agent finding if we have its id.
    if outreach.get("agent_finding_id"):
        await db.agent_findings.update_one(
            {"id": outreach["agent_finding_id"]},
            {"$set": {"status": "resolved",
                      "resolved_at": now_iso(),
                      "resolved_by": "vendor:reply",
                      "meta.captured_via_vendor_outreach": True,
                      "updated_at": now_iso()}},
        )

    # Audit card for the pro's Judgment section — spec: "every
    # auto-action still surfaces a Verify auto-action card".
    await db.agent_findings.insert_one({
        "id":           str(uuid.uuid4()),
        "company_id":   outreach["company_id"],
        "contact_id":   outreach["contact_id"],
        "kind":         "w9_auto_captured",
        "status":       "open",
        "severity":     "blue",
        "title":        f"Verify W-9 auto-captured for {outreach.get('vendor_name') or 'vendor'}",
        "detail":       "The vendor replied with what looks like a W-9. "
                        "It's attached to the contact and marked on file. "
                        "Open the contact to double-check.",
        "action_label": "Verify",
        "action_route": f"/company/{outreach['company_id']}/contacts?cid={outreach['contact_id']}",
        "meta": {
            "outreach_id":       outreach["id"],
            "classifier_conf":   classified.get("confidence"),
            "classifier_reason": classified.get("reasoning"),
        },
        "created_at": now_iso(),
    })

    await db.vendor_outreaches.update_one(
        {"id": outreach["id"]},
        {"$set": {
            "status":            "completed",
            "completed_at":      now_iso(),
            "completed_reason":  "w9_captured",
            "next_send_at":      None,
            "updated_at":        now_iso(),
        }},
    )
    return {"status": "w9_captured", "outreach_id": outreach["id"]}


async def _mark_stopped(outreach: dict, reason: str, classified: dict) -> dict:
    await db.vendor_outreaches.update_one(
        {"id": outreach["id"]},
        {"$set": {
            "status":         "stopped",
            "stopped_by":     "vendor",
            "stopped_reason": reason,
            "next_send_at":   None,
            "updated_at":     now_iso(),
        }},
    )
    # Notify the pro so they know we've stopped chasing.
    await db.agent_findings.insert_one({
        "id":           str(uuid.uuid4()),
        "company_id":   outreach["company_id"],
        "contact_id":   outreach["contact_id"],
        "kind":         "vendor_outreach_stopped",
        "status":       "open",
        "severity":     "amber",
        "title":        f"{outreach.get('vendor_name') or 'Vendor'} asked us to stop the W-9 emails",
        "detail":       "The AI paused the follow-up loop. Reach out "
                        "manually if the W-9 is still needed.",
        "action_label": "Open contact",
        "action_route": f"/company/{outreach['company_id']}/contacts?cid={outreach['contact_id']}",
        "meta": {"outreach_id": outreach["id"],
                 "classifier_reason": classified.get("reasoning")},
        "created_at": now_iso(),
    })
    return {"status": "stopped_by_vendor", "outreach_id": outreach["id"]}


async def _escalate(outreach: dict, kind: str, classified: dict) -> dict:
    """Pause the cadence and drop a task in the pro's queue."""
    await db.vendor_outreaches.update_one(
        {"id": outreach["id"]},
        {"$set": {
            "status":         "escalated",
            "next_send_at":   None,
            "updated_at":     now_iso(),
        }},
    )
    await db.agent_findings.insert_one({
        "id":           str(uuid.uuid4()),
        "company_id":   outreach["company_id"],
        "contact_id":   outreach["contact_id"],
        "kind":         kind,
        "status":       "open",
        "severity":     "amber",
        "title":        f"Vendor {outreach.get('vendor_name') or ''} replied — needs a human",
        "detail":       "The AI couldn't tell if this reply had a W-9. "
                        "Take a look and either forward the doc or "
                        "mark the outreach complete manually.",
        "action_label": "Open outreach",
        "action_route": f"/cockpit/agents?outreach={outreach['id']}",
        "meta": {"outreach_id": outreach["id"],
                 "classifier_reason": classified.get("reasoning")},
        "created_at": now_iso(),
    })
    return {"status": "escalated", "outreach_id": outreach["id"]}


# --------------------------------------------------------------------------
# Manual stop from the pro-side
# --------------------------------------------------------------------------

async def stop_outreach(outreach_id: str, *, stopped_by: str,
                        reason: str | None = None) -> dict:
    r = await db.vendor_outreaches.update_one(
        {"id": outreach_id, "status": {"$in": ["open", "awaiting_reply", "escalated"]}},
        {"$set": {
            "status":         "stopped",
            "stopped_by":     stopped_by,
            "stopped_reason": reason or "manual_stop",
            "next_send_at":   None,
            "updated_at":     now_iso(),
        }},
    )
    return {"stopped": bool(r.modified_count), "outreach_id": outreach_id}


# --------------------------------------------------------------------------
# Cron entrypoint
# --------------------------------------------------------------------------

async def vendor_outreach_tick() -> dict:
    """Combined tick called from the parent scheduler. Two passes:
      1. Send scheduled follow-ups for outreaches whose `next_send_at`
         has arrived and status is `awaiting_reply` (unlimited count).
      2. Kick off outreaches for contacts stamped
         `w9_follow_up_requested=True` that don't yet have a live
         outreach doc. Handles the case where the client's answer
         landed but the immediate send happened to fail (e.g. because
         the vendor email was blank and someone has since filled it in).
    """
    await _ensure_indexes()
    now = now_iso()
    sent = 0
    started = 0
    errored = 0

    cursor = db.vendor_outreaches.find({
        "status":       "awaiting_reply",
        "next_send_at": {"$ne": None, "$lte": now},
    })
    async for outreach in cursor:
        try:
            result = await send_next_touch(outreach)
            if result.get("status") == "sent":
                sent += 1
        except Exception:  # noqa: BLE001
            errored += 1
            logger.exception("vendor_outreach followup failed for %s",
                             outreach.get("id"))

    # Contacts newly stamped for follow-up that don't yet have a doc.
    async for c in db.contacts.find({
        "w9_follow_up_requested": True,
        "w9_on_file": {"$ne": True},
    }, {"id": 1, "company_id": 1, "email": 1, "name": 1}):
        # Skip if a live outreach already exists.
        active = await find_active_outreach(
            c["company_id"], c["id"], DOC_KIND_W9,
        )
        if active:
            continue
        # Also skip if there's already a completed outreach — the
        # client asked once, we finished the loop.
        done = await db.vendor_outreaches.find_one({
            "company_id": c["company_id"],
            "contact_id": c["id"],
            "doc_kind":   DOC_KIND_W9,
            "status":     "completed",
        })
        if done:
            continue
        try:
            await start_outreach_for_contact(
                company_id=c["company_id"], contact_id=c["id"],
            )
            started += 1
        except Exception:  # noqa: BLE001
            errored += 1
            logger.exception("vendor_outreach kickoff failed for %s",
                             c.get("id"))
    return {"sent": sent, "started": started, "errored": errored}


__all__ = [
    "DOC_KIND_W9", "FOLLOWUP_INTERVAL_DAYS",
    "build_reply_to", "parse_reply_to",
    "find_active_outreach", "create_outreach",
    "start_outreach_for_contact", "send_next_touch",
    "process_inbound_reply", "stop_outreach",
    "vendor_outreach_tick",
]
