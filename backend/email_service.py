"""Resend-backed transactional email sender.

Async-friendly wrapper around the (sync) Resend SDK. Every call runs on a
thread so the FastAPI event loop stays non-blocking.

Configuration lives in `/app/backend/.env`:
  RESEND_API_KEY        = re_...
  RESEND_FROM           = "SmartBooks <no-reply@smartbookssoftware.ai>"
    ^ default sender — used for platform-branded emails (invites, password
      resets sent from the SmartBooks app host).
  RESEND_FROM_FIRM      = "{firm} <no-reply@accountingapp.ai>"  (optional)
    ^ sender used when a firm private-label context is set. `{firm}` is
      substituted with the firm's display name so a client receiving the
      email sees "Acme CPAs <no-reply@accountingapp.ai>" instead of
      SmartBooks. Without this env var, all sends use RESEND_FROM.

Both from-address domains MUST be verified in the Resend dashboard.
"""
from __future__ import annotations

import asyncio
import logging
import os
from typing import Optional

import resend

logger = logging.getLogger(__name__)


class EmailError(RuntimeError):
    """Raised when Resend refuses a send or returns an unexpected shape."""


def _configure() -> str:
    """Ensure the SDK is configured and return the platform-default From
    address. Fails fast when a required env var is missing so mis-config
    surfaces at the call site (not silently in a webhook worker)."""
    api_key = os.environ.get("RESEND_API_KEY")
    from_addr = os.environ.get("RESEND_FROM")
    if not api_key:
        raise EmailError("RESEND_API_KEY missing from backend environment.")
    if not from_addr:
        raise EmailError("RESEND_FROM missing from backend environment.")
    resend.api_key = api_key
    return from_addr


import re

_FROM_RE = re.compile(
    r"^(?:.*<)?[^<>@\s]+@[^<>@\s]+\.[^<>@\s]+>?$"
)


def _validate_from(from_addr: str) -> None:
    """Fail fast if the composed From header doesn't look like a valid
    RFC 5322 mailbox (bare ``a@b.c`` or ``Name <a@b.c>``). Resend would
    reject it with a cryptic error otherwise — this raises early with a
    clear message that surfaces to the caller (and into the Communications
    log)."""
    s = from_addr.strip()
    if not _FROM_RE.match(s):
        raise EmailError(
            f"From address {s!r} is not a valid mailbox. Expected "
            f"'user@example.com' or 'Name <user@example.com>'. Check "
            f"the RESEND_FROM / RESEND_FROM_FIRM env vars on the server."
        )


def _quote_display_name(name: str) -> str:
    """Return a display name safe to drop into ``Name <email@x.com>``.

    RFC 5322 says a display-name that contains any of these "specials"
    ``( ) < > @ , ; : \\ " . [ ]`` must be a quoted-string. We use a
    conservative rule: if the name is not pure ASCII alnum + space +
    hyphen + underscore, wrap it in double quotes and escape embedded
    quotes / backslashes. Otherwise leave it bare.
    """
    safe = all(c.isalnum() or c in " -_&" for c in name)
    if safe:
        return name
    escaped = name.replace("\\", "\\\\").replace('"', '\\"')
    return f'"{escaped}"'


def _firm_sender(firm_name: str | None) -> str | None:
    """Build the firm-branded From address from the RESEND_FROM_FIRM template.

    `RESEND_FROM_FIRM` should look like: `{firm} <no-reply@accountingapp.ai>`
    — the `{firm}` marker is replaced with the firm's display name. If the
    template is not configured, or no firm_name is provided, we return None
    so the caller falls back to the platform default.

    Firm names may contain commas, dots, apostrophes, non-ASCII, etc.
    We strip whitespace / control characters and quote the display name
    when RFC 5322 would otherwise reject it (so ``Acme, Inc.`` becomes
    ``"Acme, Inc." <no-reply@accountingapp.ai>`` — a valid From).
    """
    template = os.environ.get("RESEND_FROM_FIRM")
    if not template or not firm_name:
        return None
    # Strip whitespace + control chars (newlines/tabs would corrupt the
    # SMTP header and cause Resend to reject with "Invalid `from` field").
    cleaned = "".join(c for c in firm_name if c.isprintable()).strip()
    if not cleaned:
        return None
    return template.replace("{firm}", _quote_display_name(cleaned))


async def send_email(
    to: str | list[str],
    subject: str,
    html: str,
    *,
    text: Optional[str] = None,
    reply_to: Optional[str] = None,
    firm_name: Optional[str] = None,
) -> dict:
    """Send one transactional email. Returns the Resend response dict
    (`{"id": "..."}` on success). Raises `EmailError` on any failure — the
    caller decides whether to swallow or bubble up.

    Pass `firm_name` when the email originates from a firm's private-label
    context (e.g. an invite triggered on `acme.accountingapp.ai`) — the
    From header will show the firm instead of SmartBooks.
    """
    platform_from = _configure()
    from_addr = _firm_sender(firm_name) or platform_from
    _validate_from(from_addr)
    recipients = [to] if isinstance(to, str) else list(to)
    params: dict = {
        "from": from_addr,
        "to": recipients,
        "subject": subject,
        "html": html,
    }
    if text:
        params["text"] = text
    if reply_to:
        params["reply_to"] = reply_to
    try:
        resp = await asyncio.to_thread(resend.Emails.send, params)
    except Exception as e:  # noqa: BLE001 — Resend surfaces auth/domain/rate errors here
        logger.exception("Resend send failed (from=%r subject=%r)", from_addr, subject)
        raise EmailError(f"Resend refused the send: {e} (from={from_addr!r})") from e
    if not resp or not resp.get("id"):
        raise EmailError(f"Resend returned unexpected shape: {resp!r}")
    logger.info("Resend accepted email id=%s to=%s from=%s subject=%r", resp["id"], recipients, from_addr, subject)
    # Log cost — one email per recipient (Resend bills per-message).
    try:
        from ai_usage import record_service
        await record_service(
            feature="resend-email",
            service="resend_email",
            quantity=len(recipients),
            unit="email",
        )
    except Exception:
        pass
    return resp
