"""
Signed magic-link tokens for the underwriter's info-request flow.

Payload:  { "cid": ..., "rid": ..., "exp": <unix ts>, "nonce": <hex> }
Format:   base64url(json_payload) + "." + base64url(hmac_sha256_of_payload)

Verification checks:
  1. HMAC signature valid (rules out tampering / forgery).
  2. Payload not expired.
  3. Nonce hasn't been marked used (single-use enforcement — up to
     the caller to consult the DB after `decode` succeeds).

Key material: reuses `FIELD_ENCRYPTION_KEY` from crypto_service so
we don't add another env-var surface area. Distinct HMAC key is
derived via HKDF (a domain-separated salt) so a compromise of the
signing key doesn't compromise field encryption.
"""
from __future__ import annotations
import base64
import hashlib
import hmac
import json
import os
import secrets
import time
from typing import Optional, Tuple

import crypto_service as _cs

_HKDF_SALT = b"axiom-info-request-link-v1"
_DEFAULT_TTL_SECONDS = 7 * 24 * 3600   # 7 days


def _signing_key() -> bytes:
    """Derive a 32-byte HMAC key from the field-encryption key via
    HKDF-Extract-and-Expand. Cached-per-call is fine — this runs
    once per token op which is cheap."""
    raw = _cs._KEY   # noqa: SLF001 — internal but stable
    if raw is None:
        # Fallback: use a hex-decoded env var, then fail loudly if
        # nothing is available so we never sign with an empty key.
        raise RuntimeError("FIELD_ENCRYPTION_KEY missing — magic links unavailable.")
    # HKDF-Extract
    prk = hmac.new(_HKDF_SALT, raw, hashlib.sha256).digest()
    # HKDF-Expand (single block, 32 bytes needed)
    okm = hmac.new(prk, b"info-request-link-v1\x01", hashlib.sha256).digest()
    return okm


def _b64url(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode("ascii")


def _b64url_decode(s: str) -> bytes:
    pad = "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode(s + pad)


def encode(cid: str, rid: str, *, ttl_seconds: int = _DEFAULT_TTL_SECONDS) -> str:
    """Mint a fresh signed token for {cid, rid}. Nonce ties this
    specific link to a specific issuance so single-use tracking
    can distinguish it from a re-issued link for the same request."""
    payload = {
        "cid":   cid,
        "rid":   rid,
        "exp":   int(time.time()) + int(ttl_seconds),
        "nonce": secrets.token_hex(8),
    }
    body = _b64url(json.dumps(payload, separators=(",", ":")).encode("utf-8"))
    sig = _b64url(hmac.new(_signing_key(), body.encode("ascii"), hashlib.sha256).digest())
    return f"{body}.{sig}"


class InvalidToken(Exception):
    """Raised for any token-verification failure — bad sig, expired,
    malformed, wrong shape. Caller should surface a friendly error
    to the merchant without leaking which check failed."""


def decode(token: str) -> dict:
    """Verify signature + expiry and return the decoded payload dict
    (`cid`, `rid`, `exp`, `nonce`). Raises `InvalidToken` on any
    failure. Does NOT check single-use — that's a DB concern the
    caller handles after decode succeeds."""
    if not token or "." not in token:
        raise InvalidToken("malformed")
    try:
        body, sig = token.split(".", 1)
    except ValueError as e:
        raise InvalidToken("malformed") from e

    expected = _b64url(hmac.new(_signing_key(), body.encode("ascii"), hashlib.sha256).digest())
    # constant-time compare
    if not hmac.compare_digest(expected, sig):
        raise InvalidToken("signature")

    try:
        payload = json.loads(_b64url_decode(body).decode("utf-8"))
    except Exception as e:  # noqa: BLE001
        raise InvalidToken("payload") from e

    for k in ("cid", "rid", "exp", "nonce"):
        if k not in payload:
            raise InvalidToken("payload")
    if int(payload["exp"]) < int(time.time()):
        raise InvalidToken("expired")
    return payload
