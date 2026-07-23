"""Per-user referral slug + `?ref=` capture helpers.

Every user has a stable 8-char referral slug that acts as their affiliate
handle. Slugs use a non-confusable alphabet (no `0/O/1/I/l`) so users can
speak them out loud or type them from a printed QR code without ambiguity.

The slug is minted lazily on first `/api/share` request — most users never
need one, so we don't waste an insert at signup for the majority.

Sign-ups that pass `?ref=<slug>` (or a cookie set by the marketing site)
get their `referred_by_user_id` set to that slug's owner. That link is
immutable: it survives plan changes, subdomain moves, and even email
changes on the referrer. It's what a future Stripe webhook uses to credit
revenue share.
"""
from __future__ import annotations
import secrets
from db import db

# No 0/O/1/I/l — safer for printed links, QR codes, and voice sharing.
_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz"
_SLUG_LEN = 8


def _new_slug() -> str:
    return "".join(secrets.choice(_ALPHABET) for _ in range(_SLUG_LEN))


async def mint_slug_for_user(user_id: str) -> str:
    """Return this user's referral_slug, minting it if missing.

    Collision-safe: on the (astronomically unlikely) chance the generated
    slug is already in use, retries with a fresh one. We cap retries to
    avoid a runaway loop if the alphabet ever shrinks or the collection
    is polluted.
    """
    user = await db.users.find_one({"id": user_id}, {"referral_slug": 1})
    if not user:
        raise ValueError(f"User {user_id!r} not found")
    if user.get("referral_slug"):
        return user["referral_slug"]
    for _ in range(5):
        slug = _new_slug()
        clash = await db.users.find_one({"referral_slug": slug}, {"_id": 1})
        if clash:
            continue
        await db.users.update_one(
            {"id": user_id},
            {"$set": {"referral_slug": slug}},
        )
        return slug
    # Extremely unlikely; surfaces as a 500 so ops notices, doesn't retry.
    raise RuntimeError("Could not mint a unique referral slug after 5 tries")


async def resolve_referrer_id(ref_slug: str | None) -> str | None:
    """Look up the user ID behind a `?ref=<slug>` param. Returns None
    when the slug is missing, empty, or doesn't match any user — the
    caller should treat that as an organic (non-referred) signup."""
    if not ref_slug:
        return None
    s = ref_slug.strip()
    if not s or len(s) != _SLUG_LEN:
        return None
    doc = await db.users.find_one({"referral_slug": s}, {"id": 1})
    return doc["id"] if doc else None
