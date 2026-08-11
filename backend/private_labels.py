"""Private-label brand registry.

Every private label (Cypher Pro, Proactive Books, etc.) that resells the
SmartBooks platform under its own domain + Stripe Payment Links routes
here. Purpose: a single source of truth for the small set of things that
change per brand:

  * `display_name` — used in email subjects, headings, and the From
    display name (via the existing `RESEND_FROM_FIRM` template plumbing).
  * `product_name`  — the "product" the customer paid for. Shows up as
    "Welcome to <product_name>" and in email body copy.
  * `app_url`       — the frontend URL where the magic-link "set your
    password" page lives. Must be the actual host the customer expects
    to sign into (not the flagship SmartBooks host).
  * `tagline`       — one-line brand voice snippet used in the email
    body. Kept short so translations stay tractable later.

Brand key is what the operator stamps into `metadata.brand` on each
Stripe Payment Link (Dashboard → Payment Link → Metadata → add
`brand: cypherpro`). The webhook reads that value and looks up the
brand config here.

Missing / unrecognised metadata falls back to `smartbooks` so the
platform default is safe.

Adding a new private label:
  1. Add the entry to `_BRANDS` below.
  2. On the Stripe side, add `metadata.brand=<key>` on every Payment
     Link (and product) that should be attributed to that brand.
  3. Point the brand's frontend at the shared backend (same DB) — the
     magic link generated here embeds the brand's `app_url`.
"""
from __future__ import annotations

import os
from typing import Optional, TypedDict


class Brand(TypedDict):
    key: str
    display_name: str
    product_name: str
    app_url: str
    tagline: str


def _appurl(env_key: str, default: str) -> str:
    """Env override so ops can retarget a brand's magic-link host
    without a code change (e.g. staging → prod cutover)."""
    return (os.environ.get(env_key) or default).rstrip("/")


# Order matters only for docs; lookup is by key.
_BRANDS: dict[str, Brand] = {
    "smartbooks": {
        "key": "smartbooks",
        "display_name": "SmartBooks",
        "product_name": "SmartBooks",
        "app_url": _appurl("PUBLIC_APP_URL", "https://app.smartbookssoftware.ai"),
        "tagline": "your books, on autopilot",
    },
    "cypherpro": {
        "key": "cypherpro",
        "display_name": "CypherPro",
        "product_name": "CypherPro",
        # CypherPro's frontend host — customers pay on cypherpro.ai and
        # sign in at cypherpro.accountingapp.ai. We use the single-level
        # subdomain (NOT app.cypherpro.accountingapp.ai) so the operator's
        # existing *.accountingapp.ai wildcard SSL cert covers it — a
        # two-level subdomain would need a fresh cert. Override via
        # BRAND_CYPHERPRO_APP_URL env if the host ever moves.
        "app_url": _appurl(
            "BRAND_CYPHERPRO_APP_URL",
            "https://cypherpro.accountingapp.ai",
        ),
        "tagline": "your business, decoded",
    },
}


DEFAULT_BRAND_KEY = "smartbooks"


def resolve_brand(metadata: Optional[dict]) -> Brand:
    """Resolve a brand from a Stripe session/subscription `metadata`
    dict. Accepts `brand` OR `label` OR `private_label` as the key
    (operators use different vocabularies — we accept all three so a
    stray Payment Link doesn't get mis-attributed).

    Fallback: any unrecognised value → `smartbooks` (the safe default).
    A missing metadata dict also falls back — this preserves the
    behaviour of the flagship SmartBooks Payment Links that predate the
    brand registry.
    """
    if not isinstance(metadata, dict):
        return _BRANDS[DEFAULT_BRAND_KEY]
    raw = (
        metadata.get("brand")
        or metadata.get("label")
        or metadata.get("private_label")
        or ""
    )
    key = str(raw).strip().lower()
    return _BRANDS.get(key, _BRANDS[DEFAULT_BRAND_KEY])


def get_brand(key: str) -> Brand:
    """Look up a brand by key. Falls back to `smartbooks` on miss so
    callers never crash on a typo."""
    return _BRANDS.get((key or "").lower(), _BRANDS[DEFAULT_BRAND_KEY])


def all_brand_keys() -> list[str]:
    """List every registered brand key — used by the diagnostic
    endpoint so ops can see what values `metadata.brand` accepts."""
    return list(_BRANDS.keys())
