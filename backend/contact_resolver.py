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

from db import db, now_iso


CORP_SUFFIXES = re.compile(
    r"\s*,?\s*\b(incorporated|corporation|limited|inc|llc|l\.l\.c\.|co|ltd|corp|"
    r"n\.a\.|na|plc|gmbh|s\.a\.|s\.a|sa|s\.r\.l\.?|srl)\.?$"
)


# PFC classifications that have no real counterparty. These MUST short-circuit
# BEFORE the fast path — otherwise a raw ATM/transfer description like
# "BKOFAMERICA ATM 07/16 #XXXXX3176" (fed in as merchant_name fallback) would
# scrub down to "BofA ATM" and create a contact even though there's no vendor
# to track for a self-transfer.
NO_COUNTERPARTY_PFC = frozenset({
    "TRANSFER_IN", "TRANSFER_OUT",     # inter-account movements
    "BANK_FEES",                       # bank / overdraft / ATM fees
    "INTEREST",                        # interest income / expense
    "LOAN_PAYMENTS",                   # loan principal / self-owned liability
})


# Per-row noise patterns. When we fall back to Plaid's raw `name` field
# because `merchant_name` is null, that string typically carries dates, PPD
# IDs, ref numbers, and ATM location codes — one per transaction. Without
# stripping, every "BofA ATM 07/16 #XXXXX3176" becomes its own contact.
# These are conservative — anything that doesn't match passes through.
_NOISE_PATTERNS = [
    re.compile(r"\s*\b\d{1,2}/\d{1,2}(?:/\d{2,4})?\b\s*"),      # dates 07/16 / 07/16/26
    re.compile(r"\s*#\s*[A-Za-z0-9]{3,}\s*"),                    # #XXXXX3176, #x3x3y0o2p, #12345
    re.compile(r"\s+PPD\s+ID\s*:?\s*\d+", re.I),                 # ACH PPD ID:12345
    re.compile(r"\s+CO\s+ID\s*:?\s*\d+", re.I),                  # CO ID 12345
    re.compile(r"\s+(?:CONF|REF|TRACE)\s*#?\s*[A-Za-z0-9]+", re.I),  # CONF# / REF# / TRACE# — alphanumeric
    re.compile(r"\s+\d{8,}\s*"),                                 # bare 8+ digit runs
]


def clean_merchant_name(raw: str | None) -> str:
    """Strip noisy per-row artefacts so different-looking rows for the same
    vendor collapse into one contact. Idempotent."""
    if not raw:
        return ""
    s = raw
    for p in _NOISE_PATTERNS:
        s = p.sub(" ", s)
    return " ".join(s.split()).rstrip(",.;: -").strip()


def normalize_contact_name(name: str | None) -> str:
    """Match-key builder. Collapses corporate suffix variants so
    'GitHub' and 'GitHub, Inc.' hash to the same key.
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


async def _insert_contact(company_id: str, contact_name: str, source: str) -> dict:
    """Insert or, on unique-conflict, return whichever won the race."""
    key = normalize_contact_name(contact_name)
    doc = {
        "id": str(uuid.uuid4()),
        "company_id": company_id,
        "name": contact_name,
        "normalized_name": key,
        "type": None,  # user tags manually — per user's preference
        "created_by_ai": True,
        "needs_review": True,
        "source": source,       # 'merchant_name' | 'ai_new'
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
            return existing
        raise


async def _find_by_normalized(company_id: str, contact_name: str) -> dict | None:
    key = normalize_contact_name(contact_name)
    if not key:
        return None
    return await db.contacts.find_one(
        {"company_id": company_id, "normalized_name": key},
    )


async def resolve_contact(
    company_id: str,
    merchant_name: str | None,
    description: str | None,
    ai_fallback_fn: Callable[..., Awaitable[dict]] | None = None,
    pfc_primary: str | None = None,
) -> dict:
    """Return {'contact_id': str|None, 'contact_name': str|None, 'source': str}.

    - source ∈ {'merchant_name' | 'ai_match' | 'ai_new' | 'no_counterparty'}
    - contact_id is None when the transaction has no real counterparty
      (internal transfer, bank fee, interest).
    """
    # ---- Gate 1: no-counterparty PFCs always short-circuit ----------------
    # This MUST come before the fast path — otherwise the raw description
    # for a transfer/ATM/fee (which we now scrub and use as a merchant name
    # fallback) would create a bogus contact for a self-transfer.
    if pfc_primary in NO_COUNTERPARTY_PFC:
        return {"contact_id": None, "contact_name": None, "source": "no_counterparty"}

    # ---- Fast path: Plaid gave us a clean merchant_name (or scrubbed desc) --
    # Scrub noisy artefacts (dates, ref#, PPD IDs) BEFORE normalization so
    # "BofA ATM 07/16 #XXXXX3176" and "BofA ATM 07/21 #XXXXX9821" collapse
    # into one contact instead of one per row.
    merch = clean_merchant_name(merchant_name)
    if merch:
        existing = await _find_by_normalized(company_id, merch)
        if existing:
            return {"contact_id": existing["id"], "contact_name": existing["name"],
                    "source": "merchant_name"}
        created = await _insert_contact(company_id, merch, source="merchant_name")
        return {"contact_id": created["id"], "contact_name": created["name"],
                "source": "merchant_name"}

    # ---- AI path: extract counterparty from description --------------------
    desc = (description or "").strip()
    if not desc or ai_fallback_fn is None:
        return {"contact_id": None, "contact_name": None, "source": "no_counterparty"}

    existing_contacts = await db.contacts.find(
        {"company_id": company_id},
    ).to_list(5000)
    ctx = [{"id": c["id"], "name": c["name"]} for c in existing_contacts]

    try:
        ai = await ai_fallback_fn(desc, ctx, pfc_primary)
    except Exception:  # noqa: BLE001
        return {"contact_id": None, "contact_name": None, "source": "no_counterparty"}

    if not ai.get("has_counterparty"):
        return {"contact_id": None, "contact_name": None, "source": "no_counterparty"}

    # AI matched an existing contact by id
    if ai.get("match_existing_id"):
        matched = next((c for c in existing_contacts if c["id"] == ai["match_existing_id"]), None)
        if matched:
            return {"contact_id": matched["id"], "contact_name": matched["name"],
                    "source": "ai_match"}

    extracted = ai.get("extracted_name")
    if not extracted:
        return {"contact_id": None, "contact_name": None, "source": "no_counterparty"}

    # Deterministic normalized-key match BEFORE inserting (defense against
    # AI returning null match_existing_id when the strings are literally
    # identical). This is the single source of truth for "same vendor?".
    existing = await _find_by_normalized(company_id, extracted)
    if existing:
        return {"contact_id": existing["id"], "contact_name": existing["name"],
                "source": "ai_match"}

    created = await _insert_contact(company_id, extracted, source="ai_new")
    return {"contact_id": created["id"], "contact_name": created["name"],
            "source": "ai_new"}


# ---------------------------------------------------------------------------
# Batch helpers
# ---------------------------------------------------------------------------

async def resolve_contacts_batch(
    company_id: str,
    items: list[dict],  # each: {merchant_name, description, pfc_primary?}
    ai_fallback_fn: Callable[..., Awaitable[dict]],
    concurrency: int = 5,
) -> list[dict]:
    """Resolve contacts for many txns in parallel. Fast-path hits skip the
    semaphore altogether. Same-order output.
    """
    sem = asyncio.Semaphore(concurrency)

    async def one(idx: int, it: dict) -> tuple[int, dict]:
        pfc = it.get("pfc_primary")
        # Fast path never contends for the semaphore. We route through
        # resolve_contact so the PFC no-counterparty gate + description
        # scrubbing apply uniformly (they only exist in one place).
        merch_raw = it.get("merchant_name")
        if pfc in NO_COUNTERPARTY_PFC or clean_merchant_name(merch_raw):
            r = await resolve_contact(
                company_id, merch_raw, it.get("description"),
                ai_fallback_fn=None, pfc_primary=pfc,
            )
            return idx, r
        # AI path — bounded concurrency for cost + Anthropic rate limits
        async with sem:
            r = await resolve_contact(
                company_id, None, it.get("description"),
                ai_fallback_fn=ai_fallback_fn,
                pfc_primary=pfc,
            )
            return idx, r

    tasks = [asyncio.create_task(one(i, it)) for i, it in enumerate(items)]
    out: list[dict | None] = [None] * len(items)
    for coro in asyncio.as_completed(tasks):
        idx, res = await coro
        out[idx] = res
    return [r or {"contact_id": None, "contact_name": None, "source": "no_counterparty"}
            for r in out]
