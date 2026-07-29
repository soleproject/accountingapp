"""Per-user referral slug + `?ref=` capture helpers.

Every user has a stable referral slug that acts as their affiliate handle.
Slugs prefer a **vanity** form derived from the user's display name
(``priya-patel``) so the URL reveals who the referrer is at a glance. If
the name is unusable (empty, all non-ASCII, too short), we fall back to
an 8-char code drawn from a non-confusable alphabet (no ``0/O/1/I/l``).

The slug is minted lazily on first ``/api/share`` request — most users
never need one, so we don't waste an insert at signup for the majority.

Sign-ups that pass ``?ref=<slug>`` (or a cookie set by the marketing
site) get their ``referred_by_user_id`` set to that slug's owner. That
link is immutable: it survives plan changes, subdomain moves, and even
email changes on the referrer. It's what a Stripe webhook uses to credit
revenue share on every recurring invoice.
"""
from __future__ import annotations
import re
import secrets
import unicodedata

from db import db
from fastapi import HTTPException

_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz"
_RANDOM_LEN = 8
# Public slug format: 3–40 chars, lowercase ascii + digits + single dashes,
# no leading/trailing dash. Same shape whether vanity or random, so the
# UI can present a single "edit" affordance.
SLUG_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$")
SLUG_MIN, SLUG_MAX = 3, 40
_RESERVED_SLUGS = {
    "admin", "api", "app", "billing", "help", "login", "logout", "pricing",
    "public", "pro", "share", "signup", "smartbooks", "superadmin",
    "support", "www",
}


def _random_slug() -> str:
    return "".join(secrets.choice(_ALPHABET) for _ in range(_RANDOM_LEN))


def slugify_name(name: str | None) -> str:
    """Convert ``'Priya Patel, CPA'`` → ``'priya-patel-cpa'``.

    Returns "" when the input can't be reduced to at least 3 ASCII
    alphanumeric characters — caller should fall back to a random code.
    """
    if not name:
        return ""
    ascii_ = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode("ascii")
    ascii_ = re.sub(r"[^a-zA-Z0-9]+", "-", ascii_).strip("-").lower()
    ascii_ = re.sub(r"-{2,}", "-", ascii_)
    if len(ascii_) < SLUG_MIN:
        return ""
    return ascii_[:SLUG_MAX]


async def _next_free_slug(base: str) -> str:
    """Return ``base``, or ``base-2``, ``base-3`` etc — first not taken."""
    if base in _RESERVED_SLUGS:
        base = f"{base}-x"
    clash = await db.users.find_one({"referral_slug": base}, {"_id": 1})
    if not clash:
        return base
    for n in range(2, 100):
        cand = f"{base}-{n}"
        if len(cand) > SLUG_MAX:
            break
        clash = await db.users.find_one({"referral_slug": cand}, {"_id": 1})
        if not clash:
            return cand
    # Extremely unlikely — fall back to a random suffix so we always
    # return SOMETHING unique rather than raising.
    return f"{base[:SLUG_MAX - 5]}-{_random_slug()[:4]}"


async def mint_slug_for_user(user_id: str) -> str:
    """Return this user's referral_slug, minting it if missing.

    Prefers a vanity slug derived from ``user.name``; falls back to a
    random 8-char code when the name isn't usable. Non-vanity historical
    slugs are preserved as-is (never rewritten) so previously shared
    links keep working forever.
    """
    user = await db.users.find_one({"id": user_id}, {"referral_slug": 1, "name": 1})
    if not user:
        raise ValueError(f"User {user_id!r} not found")
    if user.get("referral_slug"):
        return user["referral_slug"]
    base = slugify_name(user.get("name")) or _random_slug()
    slug = await _next_free_slug(base)
    await db.users.update_one({"id": user_id}, {"$set": {"referral_slug": slug}})
    return slug


async def set_slug_for_user(user_id: str, new_slug: str) -> str:
    """Rename a user's referral slug. Validates shape + uniqueness."""
    s = (new_slug or "").strip().lower()
    if not SLUG_RE.match(s) or len(s) < SLUG_MIN or len(s) > SLUG_MAX:
        raise HTTPException(
            400,
            f"Slug must be {SLUG_MIN}–{SLUG_MAX} chars, lowercase letters, "
            "digits, and single dashes only.",
        )
    if s in _RESERVED_SLUGS:
        raise HTTPException(400, f"'{s}' is reserved. Try a different one.")
    clash = await db.users.find_one(
        {"referral_slug": s, "id": {"$ne": user_id}}, {"_id": 1},
    )
    if clash:
        raise HTTPException(409, f"'{s}' is already taken.")
    await db.users.update_one({"id": user_id}, {"$set": {"referral_slug": s}})
    return s


async def resolve_referrer_id(ref_slug: str | None) -> str | None:
    """Look up the user ID behind a ``?ref=<slug>`` param. Returns None
    when the slug is missing, empty, or doesn't match any user — the
    caller should treat that as an organic (non-referred) signup.

    Accepts BOTH the new vanity format AND the legacy 8-char random
    format, since old shared links still exist in the wild.
    """
    if not ref_slug:
        return None
    s = ref_slug.strip().lower()
    if not s or len(s) > SLUG_MAX:
        return None
    doc = await db.users.find_one({"referral_slug": s}, {"id": 1})
    return doc["id"] if doc else None
