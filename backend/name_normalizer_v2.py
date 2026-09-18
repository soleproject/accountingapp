"""Advanced name normalizer for MERGE-CANDIDATE detection (Step 2).

Distinct from ``contact_resolver.normalize_contact_name`` — that one
is a match key for existing-contact lookup and only strips corporate
suffixes. This module answers a different question: *"are these two
name strings likely the same person written differently?"*

Merge signals we support (per the Feb 2026 spec):
  • Run-together names — "Smithjohn" ↔ "John Smith" / "Smith John"
  • Middle initial added/dropped — "John A Smith" ↔ "John Smith"
  • First/last order swap — "Smith, John" ↔ "John Smith"

Explicit NON-signals:
  • Same last name alone — "Kevin Petersen" ≠ "Sarah Petersen"
  • Same first name alone
  • Corporate names — we don't try to merge businesses here

Every function returns SUGGESTIONS only. The caller (CPA review UI)
gets to approve or reject. Never automatic.
"""
from __future__ import annotations
import re
from itertools import permutations

_TOKEN_RX = re.compile(r"[A-Za-z]+")
_MIDDLE_INITIAL_RX = re.compile(r"^[A-Z]\.?$", re.IGNORECASE)

# Common corporate suffix / entity markers — presence of ANY of these
# short-circuits the person-name merge path (we don't merge businesses
# on this signal).
_BUSINESS_TOKENS = frozenset({
    "llc", "inc", "co", "corp", "corporation", "ltd", "limited",
    "company", "holdings", "group", "partners", "partnership", "lp",
    "llp", "trust", "foundation", "fund", "capital", "properties",
    "management", "services", "solutions", "systems", "enterprises",
    "clinic", "hospital", "store", "market", "cafe", "restaurant",
    "dental", "medical", "veterinary", "salon", "spa", "bank",
    "insurance", "realty", "estate", "financial", "consulting",
})

# Titles / suffixes we strip before comparing.
_TITLES = frozenset({"mr", "mrs", "ms", "miss", "dr", "sir", "madam"})
_NAME_SUFFIXES = frozenset({"jr", "sr", "ii", "iii", "iv", "v"})


def _tokens(name: str) -> list[str]:
    """Return lowercase alphabetic tokens with titles / suffixes / punct
    stripped. Preserves order."""
    raw = _TOKEN_RX.findall((name or ""))
    out = []
    for t in raw:
        low = t.lower()
        if low in _TITLES or low in _NAME_SUFFIXES:
            continue
        out.append(low)
    return out


def looks_like_person(name: str) -> bool:
    """Heuristic — True when a string looks like a personal name.
    Returns False for anything containing a business marker or with
    zero/one alphabetic tokens."""
    toks = _tokens(name)
    if len(toks) < 2:
        return False
    if any(t in _BUSINESS_TOKENS for t in toks):
        return False
    # Reject if any token has >2 digits appended (bank memo cruft).
    if any(any(ch.isdigit() for ch in t) for t in _TOKEN_RX.findall(name or "")):
        return False
    return True


def canonical_person_key(name: str) -> str:
    """Produce a canonical key for a personal name that survives:
      • middle initial add/drop
      • first-last order swap
      • capitalization / spacing / punctuation differences

    Rules:
      1. Drop single-letter tokens (middle initials).
      2. Sort remaining tokens alphabetically (order-independent).
      3. Join with a single space.

    Two names collapse to the same key iff their multiset of non-initial
    tokens matches — this is a NECESSARY condition for merge, not a
    sufficient one; the caller still runs sanity checks (last-name
    match, business-marker rejection, etc.)."""
    toks = _tokens(name)
    # Drop single-letter tokens (middle initials).
    toks = [t for t in toks if len(t) > 1]
    return " ".join(sorted(toks))


def _try_split_runtogether(token: str, dictionary: list[str]) -> tuple[str, str] | None:
    """Split ``token`` at any position where BOTH halves appear in
    ``dictionary``. Returns (first_half, second_half) or None. Used to
    detect "Smithjohn" ↔ tokens ["smith", "john"]."""
    if len(token) < 6:
        return None
    dl = {d.lower() for d in dictionary if len(d) >= 2}
    for i in range(3, len(token) - 2):
        left, right = token[:i], token[i:]
        if left in dl and right in dl:
            return left, right
    return None


def find_runtogether_match(name_a: str, name_b: str) -> bool:
    """True when one name is a run-together spelling of the other.
    E.g. "Smithjohn" ↔ "John Smith" or "smithjohn" ↔ "smith john".
    Only triggers when the runtogether string reconstitutes as a
    permutation of the other name's tokens."""
    a_toks = [t for t in _tokens(name_a) if len(t) > 1]
    b_toks = [t for t in _tokens(name_b) if len(t) > 1]
    if not a_toks or not b_toks:
        return False

    def _check(single_toks: list[str], multi_toks: list[str]) -> bool:
        if len(single_toks) != 1 or len(multi_toks) < 2:
            return False
        runtogether = single_toks[0]
        # Try every ordered concatenation of the multi_toks and see if
        # one equals the runtogether string.
        for perm in permutations(multi_toks):
            if "".join(perm) == runtogether:
                return True
        # Also try letting the splitter find a boundary anywhere.
        split = _try_split_runtogether(runtogether, multi_toks)
        if split and set(split) == set(multi_toks):
            return True
        return False

    return _check(a_toks, b_toks) or _check(b_toks, a_toks)


def merge_signal(name_a: str, name_b: str) -> tuple[bool, str]:
    """Return (is_candidate, reason).

    Only fires on positive signals:
      • Same canonical person key (order-independent + initial-strip)
      • Run-together spelling match
      • Comma-separated last-first equal to first-last

    Explicit rejections (return False):
      • Either input contains a business marker
      • Only shared token is a last name (canonical keys differ)
      • Fewer than 2 non-initial tokens on the shorter side
    """
    if not name_a or not name_b:
        return False, "empty input"
    if name_a.strip().lower() == name_b.strip().lower():
        return False, "identical (not a merge candidate)"

    if not (looks_like_person(name_a) and looks_like_person(name_b)):
        return False, "business marker present or not a personal name"

    key_a = canonical_person_key(name_a)
    key_b = canonical_person_key(name_b)
    if key_a and key_b and key_a == key_b:
        return True, "canonical person key match (order/middle-initial variant)"

    if find_runtogether_match(name_a, name_b):
        return True, "run-together spelling variant"

    return False, "no positive merge signal"
