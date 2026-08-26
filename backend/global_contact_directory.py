"""Global Contact Directory — 5,221 well-known merchants indexed by
normalized name.

Purpose
    Speed up first-time contact resolution and pre-tag transactions
    with a category hint. When a merchant appears on a company's
    ledger for the first time and the tenant has no matching contact
    yet, we look up the memo/merchant name here. On a hit we:

      1. Create the tenant contact using the canonical name + logo
      2. Stamp `category_hint_semantic` on the transaction so the
         Standard+ post-hook can resolve it to the tenant's actual
         CoA via the existing name-first resolver.

Data source
    `/app/data/global_directory/merged/global_contact_directory.json`
    Curated in 15 vertical batches (Food, Retail, SaaS, Fuel, etc.)
    then merged with specificity-wins conflict resolution.

Runtime cost
    Loaded once at module import into a Python dict. ~5,221 entries
    at ~300 bytes each ≈ 1.5 MB RAM. Lookup is O(1) hash.

Match strategy
    Two-stage:
      1. Exact-alias hit — normalized merchant string is one of the
         entry's aliases → return immediately.
      2. Fuzzy match — character-trigram similarity ≥ 0.75 against
         the alias set. Optional; caller decides via `fuzzy=True`.

    We deliberately do NOT match on `canonical_name` verbatim — the
    aliases list already contains its normalized form, and normalized
    matching is cheaper.
"""
from __future__ import annotations
import json
import logging
import os
import re
import threading
from typing import Optional

logger = logging.getLogger("axiom.global_directory")


# ---------------------------------------------------------------------------
# Data location & lazy load
# ---------------------------------------------------------------------------
_DIRECTORY_PATH = os.environ.get(
    "GLOBAL_DIRECTORY_JSON",
    "/app/data/global_directory/merged/global_contact_directory.json",
)

# alias (lowercased, punctuation-stripped) -> directory entry dict
_BY_ALIAS: dict[str, dict] = {}
# For fuzzy fallback — set of all aliases for trigram scanning
_ALL_ALIASES: list[tuple[str, dict]] = []
_LOAD_LOCK = threading.Lock()
_LOADED = False


_PUNCT = re.compile(r"[^\w\s]")
_WS = re.compile(r"\s+")


def _normalize(s: str | None) -> str:
    """Match the normalization contact_resolver uses for consistency."""
    if not s:
        return ""
    s = s.lower()
    s = _PUNCT.sub(" ", s)
    s = _WS.sub(" ", s).strip()
    return s


def _load() -> None:
    """One-time boot load. Idempotent + thread-safe."""
    global _LOADED
    if _LOADED:
        return
    with _LOAD_LOCK:
        if _LOADED:
            return
        try:
            with open(_DIRECTORY_PATH) as f:
                entries = json.load(f)
        except FileNotFoundError:
            logger.warning(
                "Global contact directory not found at %s — running with"
                " empty directory. Lookups will always miss until the"
                " file is generated.", _DIRECTORY_PATH,
            )
            _LOADED = True
            return
        for entry in entries:
            for alias in entry.get("aliases", []):
                key = _normalize(alias)
                if not key:
                    continue
                # First entry to claim an alias wins (rare — dedupe
                # already ran at merge time, but be defensive).
                if key not in _BY_ALIAS:
                    _BY_ALIAS[key] = entry
                    _ALL_ALIASES.append((key, entry))
        logger.info(
            "Global contact directory loaded: %s unique aliases → %s entries",
            len(_BY_ALIAS), len({id(v) for v in _BY_ALIAS.values()}),
        )
        _LOADED = True


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def lookup(merchant_or_memo: str | None) -> Optional[dict]:
    """Exact-normalized-alias lookup. Returns the directory entry or None.

    Entry shape:
        {
          "canonical_name": "Starbucks",
          "aliases": [...],
          "semantic": "meals",
          "logo_domain": "starbucks.com",
          "confidence": "high",
          "notes": "..."
        }
    """
    _load()
    key = _normalize(merchant_or_memo)
    if not key:
        return None
    # Try exact first
    hit = _BY_ALIAS.get(key)
    if hit:
        return hit
    # Try startswith on the aliases — handles bank-memo suffix noise like
    # "STARBUCKS #1234 SEATTLE WA" where the raw string carries a
    # store number after the brand name.
    for alias in _BY_ALIAS.keys():
        if key.startswith(alias + " ") or (len(alias) >= 4 and key.startswith(alias)):
            return _BY_ALIAS[alias]
    return None


def logo_url_for(entry: dict) -> Optional[str]:
    """Build a logo URL from the entry's logo_domain via Clearbit."""
    dom = (entry or {}).get("logo_domain")
    if not dom:
        return None
    return f"https://logo.clearbit.com/{dom}"


def stats() -> dict:
    """For diagnostics: how big is the loaded directory?"""
    _load()
    return {
        "loaded": _LOADED,
        "unique_aliases": len(_BY_ALIAS),
        "unique_entries": len({id(v) for v in _BY_ALIAS.values()}),
        "source_path": _DIRECTORY_PATH,
    }
