"""Field-level AES-256-GCM encryption for the small, high-risk set of
sensitive fields we hold in Mongo.

Scope (matches the marketing copy on the landing page):
  • `plaid_items.access_token`         — bank-linking OAuth token
  • `bank_accounts.account_number`     — account numbers / masks
  • `companies.tax_id` / `companies.ein` — EIN / SSN-shaped identifiers

Why not encrypt everything? Encrypting fields we search/filter on kills
queries (`LIKE '%acme%'`, indexed lookups, etc). We only encrypt fields
that are read whole and never filtered.

Ciphertext format: `enc_v1:{base64-of(nonce||ciphertext||tag)}` — the
`enc_v1:` sentinel lets `decrypt()` be a safe passthrough when it sees
a plaintext value (which is true for every document in the DB until the
one-shot migration runs).

Key management:
  • Master key lives in `backend/.env` as `FIELD_ENCRYPTION_KEY`
    (base64-encoded 32 bytes = 256 bits).
  • Losing the key = losing the ability to decrypt. Keep it in Emergent's
    env vault AND a password manager. Rotation is out of scope for v1.
"""
from __future__ import annotations
import base64
import os
from typing import Iterable, Optional

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

_SENTINEL = "enc_v1:"


def _load_key() -> Optional[bytes]:
    raw = os.environ.get("FIELD_ENCRYPTION_KEY")
    if not raw:
        return None
    try:
        key = base64.b64decode(raw)
    except Exception:  # noqa: BLE001
        return None
    if len(key) != 32:
        # Mis-configured key length — fail closed by treating as absent.
        return None
    return key


_KEY = _load_key()


def encryption_available() -> bool:
    """True when a valid 32-byte key is loaded. Callers use this to
    gate encryption at write time; when False, values are stored as
    plaintext (dev mode / missing env)."""
    return _KEY is not None


def is_encrypted(v) -> bool:
    return isinstance(v, str) and v.startswith(_SENTINEL)


def encrypt(plaintext: Optional[str]) -> Optional[str]:
    """Return `enc_v1:<b64>` — passthrough for None, empty strings, and
    values that are already encrypted."""
    if plaintext is None or plaintext == "":
        return plaintext
    if not isinstance(plaintext, str):
        plaintext = str(plaintext)
    if is_encrypted(plaintext):
        return plaintext
    if _KEY is None:
        return plaintext  # fail-open in dev; migration re-runs pick this up
    aes = AESGCM(_KEY)
    nonce = os.urandom(12)
    ct = aes.encrypt(nonce, plaintext.encode("utf-8"), None)
    return _SENTINEL + base64.b64encode(nonce + ct).decode("ascii")


def decrypt(value: Optional[str]) -> Optional[str]:
    """Reverse of `encrypt`. Silently passes through anything that
    doesn't carry the sentinel — this keeps legacy plaintext values
    working before the migration runs."""
    if value is None or not isinstance(value, str):
        return value
    if not value.startswith(_SENTINEL):
        return value
    if _KEY is None:
        # Key is missing; we can't decrypt — return sentinel so callers
        # notice rather than silently getting garbage.
        return value
    try:
        blob = base64.b64decode(value[len(_SENTINEL):])
        nonce, ct = blob[:12], blob[12:]
        return AESGCM(_KEY).decrypt(nonce, ct, None).decode("utf-8")
    except Exception:  # noqa: BLE001
        # Corrupt / wrong-key ciphertext — best effort, return the raw
        # value so the caller can log rather than crash.
        return value


# ── Per-collection sensitive-field map ───────────────────────────────
# Kept explicit rather than derived from models: it forces a code review
# whenever a new sensitive field is added anywhere in the codebase.
SENSITIVE_FIELDS: dict[str, tuple[str, ...]] = {
    "plaid_items":   ("access_token",),
    # Bank / credit card account numbers live on the chart-of-accounts
    # rows themselves (the app doesn't have a separate `bank_accounts`
    # collection — Plaid + Veryfi both write onto `accounts`).
    "accounts":      ("account_number",),
    "companies":     ("tax_id", "ein"),
}


def _paths_for(collection: str) -> Iterable[str]:
    return SENSITIVE_FIELDS.get(collection, ())


def encrypt_doc(collection: str, doc: dict) -> dict:
    """Encrypt every sensitive field on the document in place. Returns
    the same dict for convenience so callers can write:
        `await db.plaid_items.insert_one(encrypt_doc("plaid_items", d))`
    """
    if not isinstance(doc, dict):
        return doc
    for key in _paths_for(collection):
        if key in doc and doc[key] not in (None, ""):
            doc[key] = encrypt(doc[key])
    return doc


def decrypt_doc(collection: str, doc: Optional[dict]) -> Optional[dict]:
    """Return a **new** dict with sensitive fields decrypted. Never
    mutates the input — safe to call on cursors we don't own."""
    if not isinstance(doc, dict):
        return doc
    out = dict(doc)
    for key in _paths_for(collection):
        if key in out and out[key] not in (None, ""):
            out[key] = decrypt(out[key])
    return out


def encrypt_update(collection: str, update: dict) -> dict:
    """Encrypt sensitive fields inside a Mongo update expression such as
    `{"$set": {"access_token": "...", "cursor": "..."}}`. Anything not
    in the sensitive-field set for that collection is left alone.
    """
    if not isinstance(update, dict):
        return update
    fields = set(_paths_for(collection))
    if not fields:
        return update
    for op in ("$set", "$setOnInsert"):
        section = update.get(op)
        if isinstance(section, dict):
            for k in list(section.keys()):
                if k in fields and section[k] not in (None, ""):
                    section[k] = encrypt(section[k])
    return update
