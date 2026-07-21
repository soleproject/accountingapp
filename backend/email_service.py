"""Resend-backed transactional email sender.

Async-friendly wrapper around the (sync) Resend SDK. Every call runs on a
thread so the FastAPI event loop stays non-blocking.

Configuration lives in `/app/backend/.env`:
  RESEND_API_KEY = re_...
  RESEND_FROM    = "Axiom Ledger <no-reply@accountingapp.ai>"

The `from` address MUST use a domain that has been verified in the Resend
dashboard (accountingapp.ai already is). Without that, Resend rejects sends
with `403 The domain is not verified` — surface that verbatim so the pro
knows exactly which record is missing.
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


def _configure() -> tuple[str, str]:
    """Return `(api_key, from_addr)`, ensure the SDK is configured, and fail
    fast when a required env var is missing so mis-config surfaces at the
    call site (not silently in a webhook worker)."""
    api_key = os.environ.get("RESEND_API_KEY")
    from_addr = os.environ.get("RESEND_FROM")
    if not api_key:
        raise EmailError("RESEND_API_KEY missing from backend environment.")
    if not from_addr:
        raise EmailError("RESEND_FROM missing from backend environment.")
    resend.api_key = api_key
    return api_key, from_addr


async def send_email(
    to: str | list[str],
    subject: str,
    html: str,
    *,
    text: Optional[str] = None,
    reply_to: Optional[str] = None,
) -> dict:
    """Send one transactional email. Returns the Resend response dict
    (`{"id": "..."}` on success). Raises `EmailError` on any failure — the
    caller decides whether to swallow or bubble up."""
    _, from_addr = _configure()
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
        logger.exception("Resend send failed")
        raise EmailError(f"Resend refused the send: {e}") from e
    if not resp or not resp.get("id"):
        raise EmailError(f"Resend returned unexpected shape: {resp!r}")
    logger.info("Resend accepted email id=%s to=%s subject=%r", resp["id"], recipients, subject)
    return resp
