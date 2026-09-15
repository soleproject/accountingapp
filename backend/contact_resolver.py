"""Per-company contact (customer/vendor) resolver — auto-creates a contact
for every Plaid/Veryfi transaction so ledger rows carry a `contact_id`.

Adopts the Rocketbooks pattern (2-path pipeline):
  Fast path: Plaid `merchant_name` is present → normalize + match existing OR
             insert new. No AI call. Handles ~90% of Plaid txns.
  AI path:   `merchant_name` missing (Zelle/wires/checks) → Claude Haiku
             extracts the counterparty from `description`, with junk-name
             guards baked in. Only called on the ~10% of rows that need it.
"""
from __future__ import annotations
import asyncio
import re
import uuid
from typing import Awaitable, Callable

from pymongo import UpdateOne
from db import db, now_iso


CORP_SUFFIXES = re.compile(
    r"\s*,?\s*\b(incorporated|corporation|limited|inc|llc|l\.l\.c\.|co|ltd|corp|"
    r"n\.a\.|na|plc|gmbh|s\.a\.|s\.a|sa|s\.r\.l\.?|srl)\.?$"
)


# Signals that the "merchant" field is really a raw ACH/wire/Zelle/CHECKCARD
# memo carrying per-row noise. When any of these hit we route to the AI path
# so it can extract the clean counterparty ("Citi Card" from
# "CITI CARD ONLINE DES:PAYMENT ID:… INDN:… CO ID:CITICTP WEB"). Rows that
# don't match take the fast path — no LLM call, sub-millisecond.
_NOISY_MERCHANT = re.compile(
    r"\b(DES:|INDN:|CO ID|WT Fed#|WIRE TYPE|Recurring Payment authorized|"
    r"CHECKCARD\b|Zelle payment.*Conf#|Online Banking transfer|"
    r"ATM.*#[X\d]{3,}|#XXXXX\d)",
    re.I,
)


# Generic payment-channel merchant names that Plaid returns for P2P /
# money-transfer flows where the ACTUAL counterparty lives in the
# description (Zelle → "Zelle payment to Kevin Petersen Conf# …", PayPal
# → "PAYPAL DES:INST XFER … INDN:EIMORLAIN UGALI …", etc.). Fast-pathing
# these would tag every row with the channel name (or, worse, latch onto
# the first-seen counterparty and misroute the rest) — so we force the AI
# resolver to parse the description and pick the real payee.
_PAYMENT_CHANNEL_MERCHANTS: set[str] = {
    "zelle", "zelle payment", "zelle transfer",
    "paypal", "paypal transfer", "paypal payment",
    "venmo", "venmo payment", "venmo cashout",
    "cash app", "cashapp", "square cash",
    "apple pay", "apple cash", "google pay",
    "wire", "wire transfer", "ach", "ach transfer",
    "check", "checks", "e-check", "echeck",
    "atm", "atm withdrawal", "atm deposit",
    "internal transfer", "online transfer", "bank transfer",
}


# Bank-statement rows almost always start with an operation word
# (`PMNT SENT`, `PURCHASE 0113`, `POS DEBIT`, `ACH DEBIT`, …). When
# any of these lead the string we know the row came from a raw memo
# and route it to the AI extractor even when the total length is
# below the 45-char length gate. Complements the Veryfi-side scrub
# in `veryfi_memo.clean_bank_memo` — if the scrub misses one, this
# catches it.
_MEMO_PREFIX = re.compile(
    r"^\s*(pmnt\s*sent|pmnt\s*rcvd|payment\s*sent|payment\s*rcvd|"
    r"purchase\s+\d|pos\s*debit|pos\s*purchase|debit\s*card\s*purchase|"
    r"credit\s*card\s*purchase|ach\s*debit|ach\s*credit|preauth|"
    r"preauthorized|card\s*purchase|electronic\s*payment)\b",
    re.I,
)


# ---------------------------------------------------------------------------
# Digit-density + fee-word guards (Feb 2026, added after Larissa 5 LLC ran
# 858 Veryfi rows and produced hundreds of junk "contacts" like
# "110 Nov. 21 350.00 111 Nov. 24 378.00" and
# "39763343 TRAN FEE 5247719998897619215986202"):
#
#   * Digit-density gate: real merchant names don't contain more than
#     three digits. Check-register OCR fragments and bank-issued
#     transaction IDs (Fedwire, ACH trace #s) are ALL digits with a
#     word or two mixed in. If the string has >3 digits, or >30% of
#     characters are digits, we treat it as noise and defer to the AI
#     resolver — which, for bank-fee rows, will correctly answer
#     "no counterparty".
#   * Fee-word gate: rows containing bank-fee vocabulary ("TRAN FEE",
#     "SERVICE CHARGE", "MAINTENANCE FEE", "INTEREST PAID", "WIRE FEE")
#     always represent a charge from the bank itself. They should NOT
#     mint a per-transaction contact — Stage 0.4 / Stage 0.5 already
#     book them to Bank Fees / Interest correctly. The
#     `is_bank_fee_row` helper is exposed so the ingest pipeline can
#     stamp the bank's own name as the contact instead.
#   * Check-register OCR row: `128 Dec. 24 187.00 129 Jan. 04 234.00`
#     — repeated `(#) (MMM.) (DD) (amount)` groups. Never a merchant.
# ---------------------------------------------------------------------------

_DIGIT_RX = re.compile(r"\d")
_BANK_FEE_MEMO = re.compile(
    r"\b(tran(saction)?\s*fee|service\s*charge|maintenance\s*fee|"
    r"monthly\s*fee|analysis\s*charge|overdraft(\s*fee)?|nsf(\s*fee)?|"
    r"wire\s*fee|foreign\s*(txn|transaction)?\s*fee|atm\s*fee|"
    r"paper\s*statement\s*fee|stop\s*payment(\s*fee)?|"
    r"insufficient\s*funds|returned\s*item(\s*fee)?|"
    r"interest\s*paid|interest\s*charged|finance\s*charge|"
    r"intl\s*(txn|transaction)?\s*fee|internatl\s*tx\s*fee|"
    r"processing\s*fee|convenience\s*fee)\b",
    re.I,
)
_CHECK_REGISTER_OCR = re.compile(
    r"\b\d{2,5}\s+"                                    # check#
    r"(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\.?\s+\d{1,2}\s+"
    r"[\d,]+\.\d{2}",
    re.I,
)

# Maximum count and share of digits allowed inside a "real" merchant.
# 3 is empirical: "7-Eleven" has 1, "Store #4231" has 4 but gets
# stripped by `clean_bank_memo` upstream, "AT&T" has 0, "GTM 3.0" has
# 1. Bank-fee IDs typically carry ≥10 digits.
_MAX_DIGITS = 3
_MAX_DIGIT_SHARE = 0.30


def is_bank_fee_row(text: str | None) -> bool:
    """True when a memo/description matches known bank-fee vocabulary.
    Callers (e.g. Veryfi ingest) use this to stamp the row's contact
    as the bank's own account name instead of minting a per-row junk
    contact. Kept as a public helper because two paths need it —
    `looks_noisy` (to force AI path) and the ingest routing code."""
    return bool(text and _BANK_FEE_MEMO.search(text))


# ---------------------------------------------------------------------------
# P2P counterparty extraction — reads Plaid Enrichment metadata FIRST
# ---------------------------------------------------------------------------
# For payment-channel rows (Venmo / Zelle / PayPal / Cash App / Apple
# Cash / Google Pay / Wire / Check / ACH), the actual counterparty is
# rarely in `merchant_name` — it's buried in:
#   1. Plaid Enrichment v2 `counterparties[]` (typed: payment_app,
#      merchant, financial_institution). The FIRST non-payment_app
#      entry with a name is the real recipient.
#   2. `original_description` — the pre-cleaned bank memo, still
#      carrying `INDN:<person>` on ACH, "Payment to <name>" on Zelle,
#      "Venmo *<username> …" on Venmo debit-card rows.
# When neither is present we return None so the caller keeps the
# generic "Venmo" contact rather than mint a garbage placeholder.

_P2P_PAYMENT_APPS = frozenset({
    "venmo", "zelle", "paypal", "cash app", "cashapp", "square cash",
    "apple pay", "apple cash", "google pay", "wise", "revolut",
    "chime", "sendwave", "remitly", "xoom",
})

# `INDN:JANE DOE` — the ACH "Individual Name" (accountholder or
# counterparty depending on direction). Terminated by 2+ spaces or a
# following `CO ID:` / `EED:` / `PPD` keyword.
_INDN_RX = re.compile(
    r"\bINDN\s*:\s*([A-Za-z][A-Za-z0-9'\-\.\s&,]{1,60}?)"
    r"(?:\s{2,}|\s+(?:CO\s*ID|EED|IND\s*ID|PPD|CCD|WEB|TEL)\b|$)",
    re.IGNORECASE,
)
# Zelle: "Zelle payment to Kevin Petersen Conf#XXX" / "Zelle payment
# from Jane Doe Conf#XXX"
_ZELLE_RX = re.compile(
    r"\bZelle\s+(?:payment\s+)?(?:to|from)\s+([A-Za-z][A-Za-z\-'\.\s]{1,50}?)"
    r"(?:\s+(?:Conf#|Ref#|Ref\s*Num|\d{6,}))",
    re.IGNORECASE,
)
# Venmo debit: "Venmo *KevinPetersen" / "Venmo Payment - Kevin Petersen"
_VENMO_RX = re.compile(
    r"\bVenmo[\s*\-–—]+(?:Payment\s*[-–—]\s*)?([A-Za-z][A-Za-z\-'\.\s]{1,50}?)"
    r"(?:\s{2,}|$)",
    re.IGNORECASE,
)
# Cash App: "CASH APP*JANE DOE" / "Cash App: Jane Doe"
_CASHAPP_RX = re.compile(
    r"\bCASH\s*APP[\s*:\-–—]+([A-Za-z][A-Za-z\-'\.\s]{1,50}?)"
    r"(?:\s{2,}|$)",
    re.IGNORECASE,
)


def _is_payment_app_counterparty(cp: dict) -> bool:
    """Return True when a Plaid Enrichment counterparty entry is itself
    a payment channel (not the actual recipient)."""
    if not cp:
        return True
    if (cp.get("type") or "").lower() == "payment_app":
        return True
    nm = (cp.get("name") or "").strip().lower()
    return nm in _P2P_PAYMENT_APPS


def extract_p2p_counterparty(
    merchant: str | None,
    description: str | None,
    original_description: str | None = None,
    counterparties: list[dict] | None = None,
) -> str | None:
    """Return the true recipient of a P2P payment when we can identify
    it from Plaid enrichment, or None when the memo is opaque. NEVER
    returns invented placeholder strings ("Individual", "Unnamed",
    "Anonymous", …). Callers use None as a signal to keep the generic
    payment-app contact instead of minting garbage.

    Priority:
      1. Plaid Enrichment v2 `counterparties[]` — first non-payment-app
         entry with a name.
      2. `original_description` regex (INDN / Zelle to|from / Venmo * /
         Cash App *).
      3. `description` regex fallback.
    """
    # 1. Plaid Enrichment counterparties[]
    for cp in (counterparties or []):
        if _is_payment_app_counterparty(cp):
            continue
        name = (cp.get("name") or "").strip()
        if name and len(name) >= 2:
            return name

    # 2/3. Regex over original_description (preferred) then description
    _RX_NOISE_WORDS = frozenset({
        "out", "in", "pmt", "pay", "payment", "transfer", "debit", "credit",
        "deposit", "withdrawal", "ach", "wire", "check", "cash", "atm",
        "conf", "ref", "id", "des", "co", "indn",
    })
    for source in (original_description, description):
        if not source:
            continue
        s = source.strip()
        for rx in (_INDN_RX, _ZELLE_RX, _VENMO_RX, _CASHAPP_RX):
            m = rx.search(s)
            if not m:
                continue
            name = re.sub(r"\s+", " ", m.group(1).strip(" -,")).title()
            # Reject known placeholder shapes.
            low = name.lower()
            if low in ("individual", "unnamed individual", "anonymous",
                       "customer", "payer", "payee", "recipient"):
                continue
            # Reject short single-word noise ("Out", "Pmt", "Debit", …)
            # captured because the memo had no real recipient after the
            # payment-app keyword.
            tokens = low.split()
            if len(tokens) == 1 and (tokens[0] in _RX_NOISE_WORDS or len(tokens[0]) < 3):
                continue
            # Reject if the "name" is really just the payment app.
            if low.replace(" ", "") in {a.replace(" ", "") for a in _P2P_PAYMENT_APPS}:
                continue
            if len(name) >= 2:
                return name
    return None


def _digit_stats(text: str) -> tuple[int, float]:
    """Return (digit_count, digit_share_of_non_space_chars)."""
    digits = len(_DIGIT_RX.findall(text))
    non_space = sum(1 for c in text if not c.isspace()) or 1
    return digits, digits / non_space


def looks_noisy(merchant: str | None) -> bool:
    """True when the merchant string is really a raw bank memo (or a
    generic payment-channel label like "Zelle") that the AI resolver
    should extract from — not treated as a clean vendor name.

    Feb 2026 fix: added the `_PAYMENT_CHANNEL_MERCHANTS` set. Previously
    Plaid rows where `merchant_name == "Zelle"` would take the fast path
    and every Zelle txn (regardless of counterparty) got tagged to a
    single "Zelle" contact — or worse, latched onto the first-seen
    counterparty (Kevin Petersen / Romeo Ugali mix-up on 1253 LLC).

    Feb 2026 (Larissa 5 pass): also flags anything with >3 digits or
    a check-register OCR pattern (`128 Dec. 24 187.00 …`) or bank-fee
    vocabulary. Prevents Veryfi's raw transaction IDs and OCR
    sidebars from being minted as pseudo-contacts.
    """
    if not merchant:
        return False
    if len(merchant) > 45:      # clean names are almost always short
        return True
    m_key = " ".join(merchant.lower().split())
    if m_key in _PAYMENT_CHANNEL_MERCHANTS:
        return True
    # Payment-channel PREFIX check — Plaid often gives us the whole
    # memo as merchant_name (e.g. "Zelle Andrew Chesnutt ZELLE DEBIT",
    # "Venmo *Kevin Petersen"). The real counterparty is buried in the
    # tail. Force these to the AI path so the LLM can extract the payee.
    for chan in _PAYMENT_CHANNEL_MERCHANTS:
        if m_key.startswith(chan + " ") or m_key.startswith(chan + "*"):
            return True
    if _MEMO_PREFIX.search(merchant):
        return True
    if _NOISY_MERCHANT.search(merchant):
        return True
    if _CHECK_REGISTER_OCR.search(merchant):
        return True
    if is_bank_fee_row(merchant):
        return True
    # Digit-density gate — real merchants have very few digits.
    digits, share = _digit_stats(merchant)
    if digits > _MAX_DIGITS:
        return True
    if len(merchant) >= 8 and share >= _MAX_DIGIT_SHARE:
        return True
    return False


def normalize_contact_name(name: str | None) -> str:
    """Match-key builder. Collapses corporate suffix variants so
    'GitHub' and 'GitHub, Inc.' hash to the same key.

    Rocketbooks-style: conservative-by-design — strips only well-defined
    corporate suffixes (Inc, LLC, Co, Ltd, Corp, NA, ...) plus surrounding
    punctuation. Never lemmatizes/stems, so 'Apple' and 'Apples' stay
    distinct.
    """
    if not name:
        return ""
    s = name.lower().strip()
    s = re.sub(r"\s+", " ", s)
    for _ in range(3):
        before = s
        s = re.sub(r"[\s,.]+$", "", s)
        s = CORP_SUFFIXES.sub("", s)
        s = re.sub(r"[\s,.]+$", "", s)
        if s == before:
            break
    return s.strip()


# ---------------------------------------------------------------------------
# Descriptor normalization — the "who is this really?" key.
#
# Bank feeds append per-transaction junk to every descriptor: terminal IDs
# (AMZN MKTP US*RT4KL8), timestamps (POS 09/03), city/state (HOME DEPOT
# #6234 RENO NV), auth refs (SQ *BLUEBIRD REF 4A7B). Two transactions to
# the SAME vendor almost never share a byte-for-byte descriptor. This
# helper strips the noise so that "AMZN MKTP US*RT4KL8" and "AMZN MKTP
# US*B21K9Q" both normalize to `amzn mktp us*` — a stable alias key.
#
# Conservative-by-design (mirrors the contact-name helper): only strips
# well-defined patterns that we've seen bank feeds emit. Never lemmatizes
# or does fuzzy comparison — that's what the semantic AI fallback is for.
# ---------------------------------------------------------------------------

# US state abbreviations — trailing " CITY ST" gets sheared off.
_US_STATES = ("AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME "
              "MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA "
              "RI SC SD TN TX UT VT VA WA WV WI WY").split()
_STATE_TAIL_RE = re.compile(
    r"\s+(?:#\d+\s+)?[A-Z][A-Z\-'.\s]+\s+(?:%s)\s*$" % "|".join(_US_STATES),
    re.IGNORECASE,
)
# Terminal / auth junk: `*RT4KL8`, `#6234`, `- REF 7A2X`, etc.
_TERMINAL_TAIL_RE  = re.compile(r"[*#\-]\s*[A-Z0-9]{3,}\s*$", re.IGNORECASE)
_REF_TAIL_RE       = re.compile(r"\s+(?:REF|AUTH|ID)[:\s#]*[A-Z0-9\-]+\s*$", re.IGNORECASE)
# Date-shaped junk (09/03, 09-03-2026, 2026/09/03).
_DATE_TAIL_RE      = re.compile(r"\s+\d{1,4}[/\-]\d{1,2}(?:[/\-]\d{1,4})?\s*$")
# Leading generic markers.
_LEADING_PREFIXES  = re.compile(
    r"^(?:pos\s+purchase|pos\s+debit|debit\s+card\s+purchase|purchase\s+authorized\s+on\s+\d+/\d+\s+|check\s?card\s+|card\s+purchase\s+|ach\s+(?:deposit|debit|payment)\s+|external\s+withdrawal\s+|external\s+deposit\s+)+",
    re.IGNORECASE,
)


def normalize_descriptor(desc: str | None) -> str:
    """Return the stable alias key for a bank-feed descriptor.

    Empty / None input yields "". Output is lowercase, whitespace-normalized,
    with terminal IDs / city+state / dates / ref numbers / boilerplate
    prefixes shaved off. Safe to store on a transaction as `descriptor_key`
    and to look up on `contacts.descriptor_aliases`.
    """
    if not desc:
        return ""
    s = str(desc).strip()
    # Strip common leading noise BEFORE trailing regexes so state/ref
    # patterns near the front don't get anchored wrong.
    s = _LEADING_PREFIXES.sub("", s).strip()
    # Iterate trailing shavers — a descriptor may have more than one
    # kind of junk (e.g. "HOME DEPOT #6234 RENO NV" has both a store
    # number AND a city+state).
    for _ in range(4):
        before = s
        s = _STATE_TAIL_RE.sub("", s).strip()
        s = _DATE_TAIL_RE.sub("", s).strip()
        s = _REF_TAIL_RE.sub("", s).strip()
        s = _TERMINAL_TAIL_RE.sub("", s).strip()
        if s == before:
            break
    # Collapse whitespace and lowercase.
    s = re.sub(r"\s+", " ", s).lower().strip()
    return s


async def ensure_contact_index() -> None:
    """Idempotent — compound unique index on (company_id, normalized_name).
    Backfills `normalized_name` on any existing contacts first so we don't
    trip on legacy rows.
    """
    # Backfill normalized_name for any contacts that don't have it yet
    async for doc in db.contacts.find(
        {"$or": [{"normalized_name": {"$exists": False}}, {"normalized_name": None}]}
    ):
        key = normalize_contact_name(doc.get("name") or doc.get("display_name") or "")
        # Fall back to a stable placeholder derived from the id so the unique
        # index doesn't collide with other legacy rows that also had no name
        if not key:
            key = f"__legacy__{doc.get('id') or doc.get('_id')}"
        await db.contacts.update_one(
            {"_id": doc["_id"]},
            {"$set": {"normalized_name": key}},
        )
    try:
        await db.contacts.create_index(
            [("company_id", 1), ("normalized_name", 1)],
            unique=True, name="company_contact_uniq",
        )
    except Exception:  # noqa: BLE001 — likely already exists with same spec
        pass
    # Multi-key index on (company_id, descriptor_aliases) — fast alias
    # lookups in `resolve_contact`. Non-unique because multiple contacts
    # in the same company COULD have overlapping aliases in theory (we
    # dedupe on write, but the index shouldn't reject).
    try:
        await db.contacts.create_index(
            [("company_id", 1), ("descriptor_aliases", 1)],
            name="company_contact_descriptor_aliases",
            sparse=True,
        )
    except Exception:  # noqa: BLE001
        pass
    # Learning cache — every AI extraction gets remembered by a signature so
    # future rows with the same shape skip the LLM. Unique per (company, sig).
    try:
        await db.contact_learning_cache.create_index(
            [("company_id", 1), ("signature", 1)],
            unique=True, name="learning_cache_uniq",
        )
    except Exception:  # noqa: BLE001
        pass


def _cache_signature(text: str | None) -> str:
    """Stable key for the learning cache.

    Strips digits + per-row punctuation so identical bank memos with
    different ref numbers hash to the same key. E.g.
        'CITI CARD ONLINE DES:PAYMENT ID:XXX INDN:X CO ID:CITICTP WEB'
        'CITI CARD ONLINE DES:PAYMENT ID:YYY INDN:Y CO ID:CITICTP WEB'
    both → 'citi card online despayment indn x co id citictp web'.

    Cap at ~120 chars so we retain the counterparty portion of long ACH
    memos (INDN: / ORIG: / /Org= / /Bnf= fields that name the actual payee)
    — the old 4-token / 40-char cap dropped that data, causing every
    'PAYPAL DES:INST XFER …' row to false-collide regardless of who the
    real counterparty was (bug repro Feb 2026: Romeo Ugali cache hit
    hijacked Eimorlain Ugali, Dad & Babe, and Larry Brown rows).
    """
    if not text:
        return ""
    s = re.sub(r"\d+", "", text.lower())
    s = re.sub(r"[^a-z\s]+", " ", s)
    return " ".join(s.split())[:120]


async def _lookup_learning_cache(company_id: str, signature: str) -> dict | None:
    if not signature:
        return None
    doc = await db.contact_learning_cache.find_one(
        {"company_id": company_id, "signature": signature},
    )
    if not doc:
        return None
    cid = doc.get("contact_id")
    # Sentinel for "AI decided no counterparty" — cache it too so repeat rows
    # don't burn LLM calls (e.g. "Monthly Maintenance Fee" seen 24 times/yr).
    if cid == "__none__":
        return {"contact_id": None, "contact_name": None}
    contact = await db.contacts.find_one({"id": cid, "company_id": company_id})
    if not contact:
        return None
    return {"contact_id": contact["id"], "contact_name": contact["name"]}


async def _save_to_learning_cache(company_id: str, signature: str,
                                  contact_id: str, contact_name: str) -> None:
    if not signature or not contact_id:
        return
    now = now_iso()
    try:
        await db.contact_learning_cache.update_one(
            {"company_id": company_id, "signature": signature},
            {"$set": {
                "contact_id": contact_id, "contact_name": contact_name,
                "updated_at": now,
             },
             "$inc": {"hit_count": 1},
             "$setOnInsert": {"created_at": now},
            },
            upsert=True,
        )
    except Exception:  # noqa: BLE001 — cache miss is safe, don't kill the sync
        pass


async def _insert_contact(
    company_id: str,
    contact_name: str,
    source: str,
    logo_url: str | None = None,
    linked_semantic: str | None = None,
    merchant_entity_id: str | None = None,
    entry_source: str | None = None,
) -> dict:
    """Insert or, on unique-conflict, return whichever won the race.

    Optional extras:
    - `logo_url` / `linked_semantic` — global-directory metadata
      captured at creation time.
    - `merchant_entity_id` — Plaid Enrichment's stable cross-tenant
      merchant identifier. Stored so future lookups can key on entity
      identity instead of name similarity (Feb 2026 identity harden).
    - `entry_source` — which top-level product created this contact
      (`plaid` / `invoice` / `bill` / `manual` / `veryfi` / `migrated`).
      Derived from `source` when the caller doesn't supply one.
    Also stamps `is_pseudo_contact: True` when the name matches a
    known bank / P2P-rail placeholder — those rows are excluded from
    merge / split / cross-source-dedup proposals downstream.
    """
    from contact_identity import (
        is_pseudo_contact_name, entry_source_from_resolution_source,
    )
    key = normalize_contact_name(contact_name)
    doc = {
        "id": str(uuid.uuid4()),
        "company_id": company_id,
        "name": contact_name,
        "normalized_name": key,
        "type": None,  # user tags manually — per user's preference
        "created_by_ai": True,
        "needs_review": True,
        "source": source,       # legacy resolution-path source
        "entry_source": entry_source or entry_source_from_resolution_source(source),
        "logo_url": logo_url,
        "linked_semantic": linked_semantic,
        "merchant_entity_id": merchant_entity_id or None,
        "is_pseudo_contact": is_pseudo_contact_name(contact_name),
        "created_at": now_iso(),
        "updated_at": now_iso(),
    }
    try:
        await db.contacts.insert_one(doc)
        return doc
    except Exception:  # noqa: BLE001 — likely a duplicate-key race
        existing = await db.contacts.find_one(
            {"company_id": company_id, "normalized_name": key},
        )
        if existing:
            # Same-normalized-name hit. Three cases, ordered by strength
            # of the entity_id signal:
            #
            # 1. Both sides carry NON-NULL entity_ids that DIFFER →
            #    Plaid says these are different legal entities.
            #    Fracture: create a new contact with a (#N) suffix and
            #    log an `auto_split` event so the CPA can one-click undo
            #    if the fracture was wrong.
            # 2. Existing has NULL entity_id and we have one →
            #    Adopt: stamp our entity_id onto the existing contact
            #    (identity strengthening). Log a `stamp_entity_id`
            #    event so the change surfaces in the change log.
            # 3. Otherwise (same eid, both null, etc.) → return existing.
            existing_eid = existing.get("merchant_entity_id")
            if (merchant_entity_id and existing_eid and
                    merchant_entity_id != existing_eid):
                # DISAMBIGUATE — different real merchants collide on name.
                for n in range(2, 12):
                    disambig = f"{contact_name} (#{n})"
                    dk = normalize_contact_name(disambig)
                    if not await db.contacts.find_one(
                        {"company_id": company_id, "normalized_name": dk},
                    ):
                        doc["name"] = disambig
                        doc["normalized_name"] = dk
                        try:
                            await db.contacts.insert_one(doc)
                        except Exception:  # noqa: BLE001 — race, keep trying
                            continue
                        # Fire-and-forget audit event.
                        try:
                            from contact_identity import record_identity_event
                            await record_identity_event(
                                company_id=company_id,
                                kind="auto_split",
                                actor="system:contact_resolver",
                                keeper_id=existing["id"],
                                split_child_ids=[doc["id"]],
                                evidence={
                                    "reason": "different_merchant_entity_id",
                                    "keeper_entity_id": existing_eid,
                                    "child_entity_id": merchant_entity_id,
                                    "child_name": disambig,
                                    "collided_normalized_name": key,
                                },
                            )
                        except Exception:  # noqa: BLE001
                            pass
                        return doc
                raise RuntimeError(
                    "cannot disambiguate contact after 10 attempts"
                )
            if merchant_entity_id and not existing_eid:
                # ADOPT — stamp our entity_id onto the existing contact.
                await db.contacts.update_one(
                    {"_id": existing["_id"]},
                    {"$set": {"merchant_entity_id": merchant_entity_id,
                              "updated_at": now_iso()}},
                )
                existing["merchant_entity_id"] = merchant_entity_id
                try:
                    from contact_identity import record_identity_event
                    await record_identity_event(
                        company_id=company_id,
                        kind="stamp_entity_id",
                        actor="system:contact_resolver",
                        keeper_id=existing["id"],
                        evidence={
                            "merchant_entity_id": merchant_entity_id,
                            "resolution_source": source,
                        },
                    )
                except Exception:  # noqa: BLE001
                    pass
            return existing
        raise


async def _find_by_normalized(company_id: str, contact_name: str) -> dict | None:
    key = normalize_contact_name(contact_name)
    if not key:
        return None
    return await db.contacts.find_one(
        {"company_id": company_id, "normalized_name": key},
    )


async def _find_by_entity_id(
    company_id: str, merchant_entity_id: str | None,
) -> dict | None:
    """Entity-ID lookup — Feb 2026 identity harden. Plaid's
    `merchant_entity_id` is a cross-tenant stable identifier. When
    present it's a STRONGER match signal than normalized_name: two
    memos with the same entity_id are always the same real merchant,
    and two memos with different entity_ids are DIFFERENT merchants
    even if their names normalize identically (the classic 'two
    Sunrise Cafes in different cities' case).

    Returns the contact document or None. Sparse-unique index at
    (company_id, merchant_entity_id) guarantees at most one match."""
    if not merchant_entity_id:
        return None
    return await db.contacts.find_one(
        {"company_id": company_id, "merchant_entity_id": merchant_entity_id},
    )


async def get_or_create_contact(
    company_id: str, name: str, *, source: str = "auto",
) -> dict | None:
    """Return an existing contact matching `name` (normalized) or
    idempotently insert a new one. Used by the Veryfi bank-fee
    routing path to stamp the bank's own name on rows like
    "TRAN FEE 5247719998897619215986202" instead of leaving them
    contactless.
    """
    if not name or not name.strip():
        return None
    existing = await _find_by_normalized(company_id, name)
    if existing:
        return existing
    return await _insert_contact(company_id, name.strip(), source=source)


async def resolve_contact(
    company_id: str,
    merchant_name: str | None,
    description: str | None,
    ai_fallback_fn: Callable[..., Awaitable[dict]] | None = None,
    pfc_primary: str | None = None,
    existing_snapshot: list[dict] | None = None,
    *,
    original_description: str | None = None,
    counterparties: list[dict] | None = None,
    merchant_entity_id: str | None = None,
    entry_source: str | None = None,
) -> dict:
    """Return {'contact_id': str|None, 'contact_name': str|None, 'source': str}.

    - source ∈ {'merchant_name' | 'ai_match' | 'ai_new' | 'no_counterparty'
                 | 'p2p_enriched' | 'entity_id'}.
    - `merchant_entity_id` — Plaid Enrichment's stable merchant ID. When
      present it's the strongest identity signal we have; queried FIRST
      before any name-based lookup. Feb 2026 identity harden.
    - `entry_source` — top-level product creating any new contact
      (`plaid` / `invoice` / `bill` / `manual` / `veryfi`). Defaults
      derived from `source` when None.
    - Other params documented above.
    """
    # ---- Entity-ID fast path (Feb 2026) --------------------------------
    # Sparse-unique on (company_id, merchant_entity_id) — one query, one
    # index hit. Skips every downstream heuristic.
    if merchant_entity_id:
        by_eid = await _find_by_entity_id(company_id, merchant_entity_id)
        if by_eid:
            return {"contact_id": by_eid["id"],
                    "contact_name": by_eid["name"],
                    "source": "entity_id",
                    "linked_semantic": by_eid.get("linked_semantic")}

    # ---- Descriptor-alias fast path (Sep 2026) --------------------------
    # After Q2 confirmations, contacts accumulate `descriptor_aliases`
    # — normalized descriptor keys the CPA/owner has bound to them.
    # A hit here means we've seen this bank-feed descriptor before and
    # a human already told us who it belongs to. Ranks BELOW entity_id
    # (Plaid's own stable identifier) but ABOVE every fuzzy heuristic.
    desc_key = normalize_descriptor(original_description or description)
    if desc_key:
        by_alias = await db.contacts.find_one(
            {"company_id": company_id, "descriptor_aliases": desc_key},
            {"id": 1, "name": 1, "linked_semantic": 1},
        )
        if by_alias:
            return {"contact_id": by_alias["id"],
                    "contact_name": by_alias["name"],
                    "source": "descriptor_alias",
                    "linked_semantic": by_alias.get("linked_semantic")}

    # ---- P2P counterparty enrichment ------------------------------------
    # Runs BEFORE the fast/AI split — for rows where Plaid enrichment
    # already tells us who was paid, we short-circuit and stamp that
    # person as the contact. Cheap and deterministic.
    merch = (merchant_name or "").strip()
    is_p2p_row = (
        merch.lower() in _P2P_PAYMENT_APPS
        or bool(_INDN_RX.search(original_description or ""))
        or bool(counterparties)
    )
    if is_p2p_row:
        real = extract_p2p_counterparty(
            merch, description, original_description, counterparties,
        )
        if real:
            existing = await _find_by_normalized(company_id, real)
            if existing:
                return {"contact_id": existing["id"],
                        "contact_name": existing["name"],
                        "source": "p2p_enriched",
                        "linked_semantic": existing.get("linked_semantic")}
            created = await _insert_contact(
                company_id, real, source="p2p_enriched",
            )
            return {"contact_id": created["id"],
                    "contact_name": created["name"],
                    "source": "p2p_enriched"}
        # No real recipient identifiable — keep the generic payment app
        # as the contact (Venmo / Zelle / PayPal). NEVER let the LLM
        # invent a placeholder name below.
        if merch.lower() in _P2P_PAYMENT_APPS:
            existing = await _find_by_normalized(company_id, merch)
            if existing:
                return {"contact_id": existing["id"],
                        "contact_name": existing["name"],
                        "source": "merchant_name",
                        "linked_semantic": existing.get("linked_semantic")}
            created = await _insert_contact(company_id, merch, source="merchant_name")
            return {"contact_id": created["id"],
                    "contact_name": created["name"],
                    "source": "merchant_name"}

    # ---- Fast path: merchant is a clean name we can trust ---------------
    # Any Plaid `merchant_name` OR a `name`-derived merchant that doesn't
    # match the raw-memo signature (`looks_noisy`). ~70% of rows on our
    # data hit this path — instant lookup, zero LLM calls.
    if merch and not looks_noisy(merch):
        existing = await _find_by_normalized(company_id, merch)
        if existing:
            # Adopt path: if the incoming row carries an entity_id and
            # the existing contact doesn't have one, stamp it now
            # (identity strengthening). Never overwrite a differing
            # non-null entity_id — that case fell through by_eid miss
            # and is handled by `_insert_contact`'s disambiguation.
            existing_eid = existing.get("merchant_entity_id")
            if merchant_entity_id and not existing_eid:
                await db.contacts.update_one(
                    {"_id": existing["_id"]},
                    {"$set": {"merchant_entity_id": merchant_entity_id,
                              "updated_at": now_iso()}},
                )
                existing["merchant_entity_id"] = merchant_entity_id
                try:
                    from contact_identity import record_identity_event
                    await record_identity_event(
                        company_id=company_id,
                        kind="stamp_entity_id",
                        actor="system:contact_resolver",
                        keeper_id=existing["id"],
                        evidence={"merchant_entity_id": merchant_entity_id,
                                  "resolution_source": "merchant_name"},
                    )
                except Exception:  # noqa: BLE001
                    pass
            elif (merchant_entity_id and existing_eid
                  and merchant_entity_id != existing_eid):
                # Different entity_ids under same normalized name —
                # DISAMBIGUATE by inserting a new (#N) contact.
                created = await _insert_contact(
                    company_id, merch, source="merchant_name",
                    merchant_entity_id=merchant_entity_id,
                    entry_source=entry_source,
                )
                return {"contact_id": created["id"],
                        "contact_name": created["name"],
                        "source": "merchant_name"}
            return {"contact_id": existing["id"], "contact_name": existing["name"],
                    "source": "merchant_name",
                    "linked_semantic": existing.get("linked_semantic")}
        # Tenant hasn't seen this merchant. Before minting a bare
        # tenant contact, check the global well-known-companies
        # directory. On hit we use the canonical name (so future
        # variants of the same brand normalize to the same tenant
        # contact) and stamp the linked semantic so Standard+ can
        # pre-categorize the row.
        try:
            import global_contact_directory as gcd
            gd_hit = gcd.lookup(merch)
        except Exception:  # noqa: BLE001 — directory is best-effort
            gd_hit = None
        if gd_hit:
            # Re-check tenant contacts under the canonical name too
            # (avoids duplicate "Starbucks Coffee" vs "Starbucks"
            # rows when the same tenant sees two variants).
            canonical = gd_hit["canonical_name"]
            existing_canonical = await _find_by_normalized(company_id, canonical)
            # `identity_only` entries (Zelle/Venmo/PayPal/etc.) — the
            # directory tells us WHO the vendor is but never WHAT the
            # category should be. Category cascade decides normally.
            identity_only = bool(gd_hit.get("identity_only"))
            linked_sem = None if identity_only else gd_hit["semantic"]
            if existing_canonical:
                return {"contact_id": existing_canonical["id"],
                        "contact_name": existing_canonical["name"],
                        "source": "merchant_name",
                        "linked_semantic": None if identity_only else (
                            existing_canonical.get("linked_semantic")
                            or gd_hit["semantic"])}
            created = await _insert_contact(
                company_id,
                canonical,
                source="global_directory",
                logo_url=gcd.logo_url_for(gd_hit),
                linked_semantic=linked_sem,
                merchant_entity_id=merchant_entity_id,
                entry_source=entry_source,
            )
            return {"contact_id": created["id"], "contact_name": created["name"],
                    "source": "global_directory",
                    "linked_semantic": linked_sem,
                    "linked_semantic_confidence": gd_hit["confidence"]
                                                   if not identity_only else None}
        # No global hit — mint a bare tenant contact under the raw name.
        created = await _insert_contact(
            company_id, merch, source="merchant_name",
            merchant_entity_id=merchant_entity_id,
            entry_source=entry_source,
        )
        return {"contact_id": created["id"], "contact_name": created["name"],
                "source": "merchant_name"}

    # ---- AI path: merchant looked noisy OR was absent -------------------
    # `description` is what we hand to the LLM. Fall back to the noisy
    # merchant string when description is empty (some banks put everything
    # in `merchant_name` on ACH rows).
    desc = (description or merchant_name or "").strip()
    if not desc or ai_fallback_fn is None:
        return {"contact_id": None, "contact_name": None, "source": "no_counterparty"}

    # Learning-cache lookup — every prior AI extraction for this company
    # was saved under a digit-stripped signature. Cache hit = skip LLM.
    signature = _cache_signature(desc)
    cached = await _lookup_learning_cache(company_id, signature)
    if cached is not None:
        # Bump hit counter (fire-and-forget).
        cid_val = cached["contact_id"] or "__none__"
        await _save_to_learning_cache(
            company_id, signature, cid_val, cached.get("contact_name") or "",
        )
        if cached["contact_id"]:
            return {"contact_id": cached["contact_id"],
                    "contact_name": cached["contact_name"],
                    "source": "cache"}
        return {"contact_id": None, "contact_name": None, "source": "no_counterparty"}

    # Prefer batch-scope snapshot; fall back to a fresh scan for one-off callers.
    if existing_snapshot is not None:
        existing_contacts = existing_snapshot
    else:
        existing_contacts = await db.contacts.find(
            {"company_id": company_id},
        ).to_list(5000)
    ctx = [{"id": c["id"], "name": c["name"]} for c in existing_contacts]

    try:
        ai = await ai_fallback_fn(desc, ctx, pfc_primary)
    except Exception:  # noqa: BLE001
        return {"contact_id": None, "contact_name": None, "source": "no_counterparty"}

    if not ai.get("has_counterparty"):
        # Cache the negative result too — otherwise every future
        # "Monthly Maintenance Fee" row would burn another LLM call.
        await _save_to_learning_cache(company_id, signature, "__none__", "")
        return {"contact_id": None, "contact_name": None, "source": "no_counterparty"}

    # AI matched an existing contact by id — save to learning cache too so
    # future rows with the same signature bypass the LLM.
    if ai.get("match_existing_id"):
        matched = next((c for c in existing_contacts if c["id"] == ai["match_existing_id"]), None)
        if matched:
            await _save_to_learning_cache(company_id, signature, matched["id"], matched["name"])
            return {"contact_id": matched["id"], "contact_name": matched["name"],
                    "source": "ai_match"}

    extracted = ai.get("extracted_name")
    if not extracted:
        await _save_to_learning_cache(company_id, signature, "__none__", "")
        return {"contact_id": None, "contact_name": None, "source": "no_counterparty"}

    # Deterministic normalized-key match BEFORE inserting (defense against
    # AI returning null match_existing_id when the strings are literally
    # identical). This is the single source of truth for "same vendor?".
    existing = await _find_by_normalized(company_id, extracted)
    if existing:
        await _save_to_learning_cache(company_id, signature, existing["id"], existing["name"])
        return {"contact_id": existing["id"], "contact_name": existing["name"],
                "source": "ai_match"}

    created = await _insert_contact(company_id, extracted, source="ai_new")
    await _save_to_learning_cache(company_id, signature, created["id"], created["name"])
    return {"contact_id": created["id"], "contact_name": created["name"],
            "source": "ai_new"}


# ---------------------------------------------------------------------------
# Batch helpers
# ---------------------------------------------------------------------------

async def resolve_contacts_batch(
    company_id: str,
    items: list[dict],  # each: {merchant_name, description, pfc_primary?}
    ai_fallback_fn: Callable[..., Awaitable[dict]],
    concurrency: int = 8,
) -> list[dict]:
    """Resolve contacts for many txns with fully-batched IO.

    Perf strategy (Feb 2026 rewrite):
      - Single `find` to load the company's contacts + build an in-memory
        `by_key` dict. Fast-path lookups never hit Mongo per-row.
      - Single `find` with `$in` on AI-path signatures to bulk-load the
        learning cache. Cache hits are O(1) lookups.
      - New contacts + cache upserts are collected in memory and flushed
        via `insert_many(ordered=False)` + `bulk_write` at the end.
      - Only the actual LLM calls run through the semaphore.

    On a 1,870-row sync with ~82% fast-path this cuts wall-clock from
    minutes → seconds and Mongo round trips from ~4,000 → ~4.
    """
    if not items:
        return []

    # ------ Load snapshot + build dicts --------------------------------------
    snapshot = await db.contacts.find({"company_id": company_id}).to_list(20000)
    by_key: dict[str, dict] = {}
    by_id: dict[str, dict] = {}
    for c in snapshot:
        k = c.get("normalized_name") or normalize_contact_name(c.get("name"))
        if k and k not in by_key:
            by_key[k] = c
        by_id[c["id"]] = c

    # ------ Classify rows into fast-path / ai-path / p2p-path ---------------
    fast_rows: list[tuple[int, str, dict]] = []   # (idx, merch, item)
    ai_rows:   list[tuple[int, str, str, dict]] = []  # (idx, desc, signature, item)
    out: list[dict | None] = [None] * len(items)

    for i, it in enumerate(items):
        merch  = (it.get("merchant_name") or "").strip()
        orig   = it.get("original_description") or ""
        cps    = it.get("counterparties") or []
        eid    = it.get("merchant_entity_id")

        # Entity-ID fast path (Feb 2026 identity harden) — the strongest
        # signal we have. Bypasses every string-based path when it hits.
        if eid:
            by_eid = await _find_by_entity_id(company_id, eid)
            if by_eid:
                out[i] = {"contact_id": by_eid["id"],
                          "contact_name": by_eid["name"],
                          "source": "entity_id",
                          "linked_semantic": by_eid.get("linked_semantic")}
                continue

        # P2P fast-path: try Plaid enrichment first. On hit we resolve
        # to the real recipient with zero LLM calls; on miss we KEEP
        # the payment app (Venmo/Zelle) as the contact rather than let
        # the AI-path invent "Individual Payment" / "Unnamed Individual".
        is_p2p = (
            merch.lower() in _P2P_PAYMENT_APPS
            or bool(_INDN_RX.search(orig))
            or bool(cps)
        )
        if is_p2p:
            real = extract_p2p_counterparty(
                merch, it.get("description"), orig, cps,
            )
            if real:
                real_key = normalize_contact_name(real)
                existing = by_key.get(real_key)
                if existing:
                    out[i] = {"contact_id": existing["id"],
                              "contact_name": existing["name"],
                              "source": "p2p_enriched",
                              "linked_semantic": existing.get("linked_semantic")}
                    continue
                # Queue a new contact for the enriched recipient.
                fast_rows.append((i, real, it))
                continue
            # Enrichment yielded nothing — keep the generic payment app
            # as the contact (skip AI path entirely; NO placeholders).
            if merch.lower() in _P2P_PAYMENT_APPS:
                fast_rows.append((i, merch, it))
                continue
            # Otherwise fall through to the normal fast/AI split — the
            # row wasn't really a P2P payment despite the counterparties[]
            # array being populated.

        if merch and not looks_noisy(merch):
            fast_rows.append((i, merch, it))
        else:
            desc = (it.get("description") or merch or "").strip()
            if not desc:
                out[i] = {"contact_id": None, "contact_name": None,
                          "source": "no_counterparty"}
            else:
                ai_rows.append((i, desc, _cache_signature(desc), it))

    # ------ Fast-path: in-memory dict + queue new contacts -------------------
    # Group same-key fast-path rows so we insert one contact per unique key.
    new_by_key: dict[str, dict] = {}

    # `adopt_updates` — deferred UpdateOne ops to stamp `merchant_entity_id`
    # onto existing null-eid contacts (identity strengthening). Applied
    # with a single bulk_write at the end.
    adopt_updates: list[UpdateOne] = []
    # `adopt_events` — rows to append to `contact_identity_events` after
    # the bulk update. Kept as raw docs (not `record_identity_event` calls
    # in-loop) so the LLM concurrency isn't gated on Mongo latency.
    adopt_events: list[dict] = []

    # Lazy import — module loads its JSON on first call.
    try:
        import global_contact_directory as gcd
    except Exception:  # noqa: BLE001 — never fail contact resolution
        gcd = None

    for idx, merch, _it in fast_rows:
        row_eid = _it.get("merchant_entity_id")
        key = normalize_contact_name(merch)
        if not key:
            out[idx] = {"contact_id": None, "contact_name": None,
                        "source": "no_counterparty"}
            continue
        existing = by_key.get(key)
        if existing:
            existing_eid = existing.get("merchant_entity_id")
            if row_eid and existing_eid and row_eid != existing_eid:
                # FRACTURE — different real merchants collide on name.
                # Fall through to `_insert_contact` (handles suffix +
                # logs `auto_split` event). Inline call — rare path.
                created = await _insert_contact(
                    company_id, merch, source="merchant_name",
                    merchant_entity_id=row_eid,
                )
                by_id[created["id"]] = created
                out[idx] = {"contact_id": created["id"],
                            "contact_name": created["name"],
                            "source": "merchant_name"}
                continue
            if row_eid and not existing_eid:
                # ADOPT — stamp our eid onto the existing contact.
                # Defer the DB write to a bulk_write below.
                adopt_updates.append(UpdateOne(
                    {"_id": existing["_id"]},
                    {"$set": {"merchant_entity_id": row_eid,
                              "updated_at": now_iso()}},
                ))
                existing["merchant_entity_id"] = row_eid
                adopt_events.append({
                    "keeper_id": existing["id"], "eid": row_eid,
                    "resolution_source": "merchant_name",
                })
            out[idx] = {"contact_id": existing["id"],
                        "contact_name": existing["name"],
                        "source": "merchant_name",
                        "linked_semantic": existing.get("linked_semantic")}
            continue
        # Not yet in tenant DB — check the global well-known-companies
        # directory before minting a bare tenant contact.
        gd_hit = gcd.lookup(merch) if gcd else None
        if gd_hit:
            canonical = gd_hit["canonical_name"]
            canonical_key = normalize_contact_name(canonical)
            identity_only = bool(gd_hit.get("identity_only"))
            linked_sem = None if identity_only else gd_hit["semantic"]
            # Re-check the tenant snapshot under the canonical key —
            # avoids duplicating "Starbucks Coffee" vs "Starbucks".
            existing_canonical = by_key.get(canonical_key)
            if existing_canonical:
                existing_c_eid = existing_canonical.get("merchant_entity_id")
                if (row_eid and existing_c_eid
                        and row_eid != existing_c_eid):
                    created = await _insert_contact(
                        company_id, canonical, source="global_directory",
                        logo_url=gcd.logo_url_for(gd_hit) if gcd else None,
                        linked_semantic=linked_sem,
                        merchant_entity_id=row_eid,
                    )
                    by_id[created["id"]] = created
                    out[idx] = {"contact_id": created["id"],
                                "contact_name": created["name"],
                                "source": "global_directory",
                                "linked_semantic": linked_sem}
                    continue
                if row_eid and not existing_c_eid:
                    adopt_updates.append(UpdateOne(
                        {"_id": existing_canonical["_id"]},
                        {"$set": {"merchant_entity_id": row_eid,
                                  "updated_at": now_iso()}},
                    ))
                    existing_canonical["merchant_entity_id"] = row_eid
                    adopt_events.append({
                        "keeper_id": existing_canonical["id"],
                        "eid": row_eid,
                        "resolution_source": "global_directory",
                    })
                out[idx] = {"contact_id": existing_canonical["id"],
                            "contact_name": existing_canonical["name"],
                            "source": "merchant_name",
                            "linked_semantic": None if identity_only else (
                                existing_canonical.get("linked_semantic")
                                or gd_hit["semantic"])}
                continue
            # Batch-scope dedupe against the canonical key too.
            stub = new_by_key.get(canonical_key)
            if stub is None:
                stub = _new_contact_doc(
                    company_id, canonical, source="global_directory",
                    logo_url=gcd.logo_url_for(gd_hit),
                    linked_semantic=linked_sem,
                    merchant_entity_id=row_eid,
                )
                new_by_key[canonical_key] = stub
                # Also alias the merchant's raw key so a second row in
                # THIS batch under the raw string still dedupes.
                new_by_key.setdefault(key, stub)
            elif row_eid and not stub.get("merchant_entity_id"):
                stub["merchant_entity_id"] = row_eid
            out[idx] = {"contact_id": stub["id"], "contact_name": stub["name"],
                        "source": "global_directory",
                        "linked_semantic": linked_sem,
                        "linked_semantic_confidence": gd_hit["confidence"]
                                                       if not identity_only else None}
            continue
        # No global hit — mint a bare tenant contact under the raw name.
        stub = new_by_key.get(key)
        if stub is None:
            stub = _new_contact_doc(
                company_id, merch, source="merchant_name",
                merchant_entity_id=row_eid,
            )
            new_by_key[key] = stub
        elif row_eid and not stub.get("merchant_entity_id"):
            # Batch-scope stub already exists but this row carries entity_id
            # → stamp it now so the persisted contact has it.
            stub["merchant_entity_id"] = row_eid
        out[idx] = {"contact_id": stub["id"], "contact_name": stub["name"],
                    "source": "merchant_name"}

    # ------ AI-path: bulk-load learning cache --------------------------------
    ai_cache_hits: dict[int, dict] = {}
    ai_misses: list[tuple[int, str, str, dict]] = []  # ones we must LLM

    if ai_rows:
        sigs = list({sig for _, _, sig, _ in ai_rows if sig})
        cache_map: dict[str, dict] = {}
        if sigs:
            async for doc in db.contact_learning_cache.find(
                {"company_id": company_id, "signature": {"$in": sigs}},
            ):
                cache_map[doc["signature"]] = doc

        for idx, desc, sig, it in ai_rows:
            hit = cache_map.get(sig) if sig else None
            if not hit:
                ai_misses.append((idx, desc, sig, it))
                continue
            cid_val = hit.get("contact_id")
            if cid_val == "__none__":
                ai_cache_hits[idx] = {"contact_id": None, "contact_name": None,
                                      "source": "no_counterparty"}
                continue
            contact = by_id.get(cid_val)
            if contact:
                ai_cache_hits[idx] = {"contact_id": contact["id"],
                                      "contact_name": contact["name"],
                                      "source": "cache"}
            else:
                # Cached contact was deleted → re-resolve via LLM
                ai_misses.append((idx, desc, sig, it))

    for idx, res in ai_cache_hits.items():
        out[idx] = res

    # ------ AI-path: LLM concurrently, then persist ---------------------------
    # Batch-scope context list for the LLM (names + ids only).
    ctx = [{"id": c["id"], "name": c["name"]} for c in snapshot]
    cache_upserts: list[UpdateOne] = []
    sem = asyncio.Semaphore(concurrency)

    async def call_llm(idx: int, desc: str, sig: str, it: dict) -> tuple[int, str, str, dict]:
        pfc = it.get("pfc_primary")
        async with sem:
            try:
                ai = await ai_fallback_fn(desc, ctx, pfc)
            except Exception:  # noqa: BLE001
                ai = {"has_counterparty": False}
        return idx, desc, sig, ai

    if ai_misses:
        tasks = [asyncio.create_task(call_llm(*row)) for row in ai_misses]
        for coro in asyncio.as_completed(tasks):
            idx, desc, sig, ai = await coro

            if not ai.get("has_counterparty"):
                out[idx] = {"contact_id": None, "contact_name": None,
                            "source": "no_counterparty"}
                if sig:
                    cache_upserts.append(_cache_upsert_op(company_id, sig, "__none__", ""))
                continue

            # AI matched an existing contact by id
            match_id = ai.get("match_existing_id")
            if match_id and match_id in by_id:
                m = by_id[match_id]
                out[idx] = {"contact_id": m["id"], "contact_name": m["name"],
                            "source": "ai_match"}
                if sig:
                    cache_upserts.append(_cache_upsert_op(company_id, sig, m["id"], m["name"]))
                continue

            extracted = (ai.get("extracted_name") or "").strip()
            if not extracted:
                out[idx] = {"contact_id": None, "contact_name": None,
                            "source": "no_counterparty"}
                if sig:
                    cache_upserts.append(_cache_upsert_op(company_id, sig, "__none__", ""))
                continue

            # Deterministic normalized-key match (defensive dedup)
            key = normalize_contact_name(extracted)
            if key and key in by_key:
                m = by_key[key]
                out[idx] = {"contact_id": m["id"], "contact_name": m["name"],
                            "source": "ai_match"}
                if sig:
                    cache_upserts.append(_cache_upsert_op(company_id, sig, m["id"], m["name"]))
                continue

            # New contact via AI — dedupe within batch
            if key and key in new_by_key:
                stub = new_by_key[key]
                out[idx] = {"contact_id": stub["id"], "contact_name": stub["name"],
                            "source": "ai_new"}
                if sig:
                    cache_upserts.append(_cache_upsert_op(company_id, sig, stub["id"], stub["name"]))
                continue

            stub = _new_contact_doc(company_id, extracted, source="ai_new")
            if key:
                new_by_key[key] = stub
            out[idx] = {"contact_id": stub["id"], "contact_name": stub["name"],
                        "source": "ai_new"}
            if sig:
                cache_upserts.append(_cache_upsert_op(company_id, sig, stub["id"], stub["name"]))

    # ------ Bulk-write new contacts + cache upserts ---------------------------
    if new_by_key:
        docs = list(new_by_key.values())
        try:
            await db.contacts.insert_many(docs, ordered=False)
        except Exception:  # noqa: BLE001 — dupes from a racing sync land here
            # Re-fetch any keys we couldn't insert and remap results to whichever
            # doc won the race so downstream links stay valid.
            existing = await db.contacts.find(
                {"company_id": company_id,
                 "normalized_name": {"$in": list(new_by_key.keys())}},
            ).to_list(None)
            live_by_key = {c["normalized_name"]: c for c in existing}
            for i, r in enumerate(out):
                if not r or r.get("source") not in ("merchant_name", "ai_new"):
                    continue
                # If the stub id doesn't match the live doc, remap
                cur = r.get("contact_id")
                stub_name = r.get("contact_name") or ""
                k = normalize_contact_name(stub_name)
                live = live_by_key.get(k)
                if live and live["id"] != cur:
                    out[i] = {"contact_id": live["id"], "contact_name": live["name"],
                              "source": r["source"]}

    if cache_upserts:
        try:
            await db.contact_learning_cache.bulk_write(cache_upserts, ordered=False)
        except Exception:  # noqa: BLE001 — cache miss is safe, don't kill the sync
            pass

    # Flush entity_id adopts (identity strengthening). One bulk_write for
    # the DB updates, one insert_many for the audit events. Both are
    # best-effort — a failure here loses observability but doesn't corrupt
    # transaction/contact state, so we swallow.
    if adopt_updates:
        try:
            await db.contacts.bulk_write(adopt_updates, ordered=False)
        except Exception:  # noqa: BLE001
            pass
        # Dedupe events by (keeper_id, eid) — a batch can carry many rows
        # for the same newly-adopted merchant; we only want one event.
        seen: set[tuple[str, str]] = set()
        event_docs: list[dict] = []
        for ev in adopt_events:
            k = (ev["keeper_id"], ev["eid"])
            if k in seen:
                continue
            seen.add(k)
            event_docs.append({
                "id":               str(uuid.uuid4()),
                "company_id":       company_id,
                "kind":             "stamp_entity_id",
                "created_at":       now_iso(),
                "actor":            "system:contact_resolver",
                "keeper_id":        ev["keeper_id"],
                "loser_ids":        [],
                "split_child_ids":  [],
                "affected_txn_ids": [],
                "affected_docs":    {},
                "before":           {},
                "evidence":         {
                    "merchant_entity_id": ev["eid"],
                    "resolution_source":  ev.get("resolution_source"),
                },
                "undone_at":        None,
                "undone_by":        None,
            })
        if event_docs:
            try:
                await db.contact_identity_events.insert_many(
                    event_docs, ordered=False,
                )
            except Exception:  # noqa: BLE001
                pass

    return [r or {"contact_id": None, "contact_name": None, "source": "no_counterparty"}
            for r in out]


def _new_contact_doc(
    company_id: str,
    name: str,
    source: str,
    logo_url: str | None = None,
    linked_semantic: str | None = None,
    merchant_entity_id: str | None = None,
    entry_source: str | None = None,
) -> dict:
    """Build (but do not insert) a contact doc. Used by the batch resolver
    to defer inserts to a single `insert_many` call at the end.

    - `logo_url` + `linked_semantic` attached when the contact was minted
      via a global-directory hit.
    - `merchant_entity_id` stamped when Plaid Enrichment identified the
      merchant. Feb 2026 identity harden.
    - `entry_source` records the top-level product creating the contact;
      derived from `source` when None.
    """
    from contact_identity import (
        is_pseudo_contact_name, entry_source_from_resolution_source,
    )
    return {
        "id": str(uuid.uuid4()),
        "company_id": company_id,
        "name": name,
        "normalized_name": normalize_contact_name(name),
        "type": None,
        "created_by_ai": True,
        "needs_review": True,
        "source": source,
        "entry_source": entry_source or entry_source_from_resolution_source(source),
        "logo_url": logo_url,
        "linked_semantic": linked_semantic,
        "merchant_entity_id": merchant_entity_id or None,
        "is_pseudo_contact": is_pseudo_contact_name(name),
        "created_at": now_iso(),
        "updated_at": now_iso(),
    }


def _cache_upsert_op(company_id: str, signature: str,
                     contact_id: str, contact_name: str) -> UpdateOne:
    """Bulk-write op for the learning cache. Idempotent."""
    now = now_iso()
    return UpdateOne(
        {"company_id": company_id, "signature": signature},
        {
            "$set": {"contact_id": contact_id, "contact_name": contact_name,
                     "updated_at": now},
            "$inc": {"hit_count": 1},
            "$setOnInsert": {"created_at": now},
        },
        upsert=True,
    )



# ---------------------------------------------------------------------------
# Auto-classify contact type from transaction direction (Feb 2026)
#
# Contacts created by Plaid syncs / Veryfi statement uploads / AI categorizer
# land with `type: None` on purpose — we don't know at the moment of creation
# whether the counterparty is a customer or a vendor. That's a real gap:
# users would connect Plaid, see 8,000 contacts, then find Customers / Vendors
# pages both empty because everyone was null.
#
# This function looks at every transaction referencing a given contact_id and
# infers `type` from the sign of the amount:
#   • all amounts > 0  (money in)   → "customer"
#   • all amounts < 0  (money out)  → "vendor"
#   • mix of signs                  → "both" (frontend already surfaces
#                                     these on BOTH the Customers and
#                                     Vendors pages)
#   • no transactions found          → leave as-is (still user-taggable)
#
# `respect_manual` (default True) skips contacts where a human has already
# set `type` to something intentional (i.e. not None and not our own
# auto-inferred value). That way this can safely re-run after every Plaid
# sync without ever stomping a manual tag.
# ---------------------------------------------------------------------------

async def reclassify_contact_types(
    company_id: str,
    respect_manual: bool = True,
    contact_ids: list[str] | None = None,
) -> dict:
    """Classify every (or a specific set of) contact into customer / vendor / both
    based on the direction of transactions that reference them.

    Returns a summary dict:
      {
        "scanned":   N,   # contacts considered
        "updated":   N,   # contacts whose type actually changed
        "customer":  N,   # contacts newly marked customer
        "vendor":    N,
        "both":      N,
        "skipped":   N,   # already had a manual type (respect_manual)
        "no_txn":    N,   # no transactions referencing this contact yet
      }
    """
    match: dict = {"company_id": company_id}
    if contact_ids is not None:
        match["id"] = {"$in": list(contact_ids)}
    if respect_manual:
        # Only touch contacts that are un-typed OR were previously
        # auto-classified by this same routine (marked via
        # `type_source: "auto"`). Manual tags survive intact.
        match["$or"] = [
            {"type": None},
            {"type": {"$exists": False}},
            {"type_source": "auto"},
        ]

    summary = {"scanned": 0, "updated": 0, "customer": 0, "vendor": 0,
               "both": 0, "skipped": 0, "no_txn": 0}
    now = now_iso()

    async for contact in db.contacts.find(match):
        summary["scanned"] += 1
        cid = contact["id"]

        # Aggregate this contact's transactions into a signs bucket.
        # $facet gives us both sums in one round-trip. `amount > 0`
        # signals customer inflow, `amount < 0` signals vendor outflow.
        pipeline = [
            {"$match": {"company_id": company_id, "contact_id": cid}},
            {"$facet": {
                "in":  [{"$match": {"amount": {"$gt": 0}}}, {"$count": "n"}],
                "out": [{"$match": {"amount": {"$lt": 0}}}, {"$count": "n"}],
            }},
        ]
        agg = await db.transactions.aggregate(pipeline).to_list(1)
        row = agg[0] if agg else {"in": [], "out": []}
        n_in = (row.get("in") or [{}])[0].get("n", 0) if row.get("in") else 0
        n_out = (row.get("out") or [{}])[0].get("n", 0) if row.get("out") else 0

        if n_in == 0 and n_out == 0:
            summary["no_txn"] += 1
            continue

        if n_in > 0 and n_out > 0:
            new_type = "both"
        elif n_in > 0:
            new_type = "customer"
        else:
            new_type = "vendor"

        # Skip write if the value hasn't changed.
        if contact.get("type") == new_type:
            summary[new_type] += 1
            continue

        await db.contacts.update_one(
            {"id": cid, "company_id": company_id},
            {"$set": {
                "type": new_type,
                "type_source": "auto",       # tag as auto so future manual
                "updated_at": now,           # edits by the user can be
            }},                              # respected on re-runs
        )
        summary["updated"] += 1
        summary[new_type] += 1

    return summary
