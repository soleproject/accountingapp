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


def looks_noisy(merchant: str | None) -> bool:
    """True when the merchant string is really a raw bank memo (or a
    generic payment-channel label like "Zelle") that the AI resolver
    should extract from — not treated as a clean vendor name.

    Feb 2026 fix: added the `_PAYMENT_CHANNEL_MERCHANTS` set. Previously
    Plaid rows where `merchant_name == "Zelle"` would take the fast path
    and every Zelle txn (regardless of counterparty) got tagged to a
    single "Zelle" contact — or worse, latched onto the first-seen
    counterparty (Kevin Petersen / Romeo Ugali mix-up on 1253 LLC).
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
    return bool(_NOISY_MERCHANT.search(merchant))


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
) -> dict:
    """Insert or, on unique-conflict, return whichever won the race.

    Optional extras (`logo_url`, `linked_semantic`) let the caller
    attach global-directory metadata at creation time — e.g., when
    we identify a new contact via the well-known-companies list we
    want the ledger row to remember which merchant this maps to.
    """
    key = normalize_contact_name(contact_name)
    doc = {
        "id": str(uuid.uuid4()),
        "company_id": company_id,
        "name": contact_name,
        "normalized_name": key,
        "type": None,  # user tags manually — per user's preference
        "created_by_ai": True,
        "needs_review": True,
        "source": source,       # 'merchant_name' | 'ai_new' | 'global_directory'
        "logo_url": logo_url,
        "linked_semantic": linked_semantic,
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
    existing_snapshot: list[dict] | None = None,
) -> dict:
    """Return {'contact_id': str|None, 'contact_name': str|None, 'source': str}.

    - source ∈ {'merchant_name' | 'ai_match' | 'ai_new' | 'no_counterparty'}
    - contact_id is None when the transaction has no real counterparty
      (internal transfer, bank fee, interest).
    - `existing_snapshot` — when caller has already loaded the full contacts
      list (batch resolver does this once per batch), pass it in to avoid a
      per-row Mongo scan. Reads only; freshly-inserted rows during this same
      batch may not appear in the snapshot but will still dedupe via the
      unique index + `_find_by_normalized`.
    """
    # ---- Fast path: merchant is a clean name we can trust ---------------
    # Any Plaid `merchant_name` OR a `name`-derived merchant that doesn't
    # match the raw-memo signature (`looks_noisy`). ~70% of rows on our
    # data hit this path — instant lookup, zero LLM calls.
    merch = (merchant_name or "").strip()
    if merch and not looks_noisy(merch):
        existing = await _find_by_normalized(company_id, merch)
        if existing:
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
            )
            return {"contact_id": created["id"], "contact_name": created["name"],
                    "source": "global_directory",
                    "linked_semantic": linked_sem,
                    "linked_semantic_confidence": gd_hit["confidence"]
                                                   if not identity_only else None}
        # No global hit — mint a bare tenant contact under the raw name.
        created = await _insert_contact(company_id, merch, source="merchant_name")
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

    # ------ Classify rows into fast-path / ai-path ---------------------------
    fast_rows: list[tuple[int, str, dict]] = []   # (idx, merch, item)
    ai_rows:   list[tuple[int, str, str, dict]] = []  # (idx, desc, signature, item)
    out: list[dict | None] = [None] * len(items)

    for i, it in enumerate(items):
        merch = (it.get("merchant_name") or "").strip()
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

    # Lazy import — module loads its JSON on first call.
    try:
        import global_contact_directory as gcd
    except Exception:  # noqa: BLE001 — never fail contact resolution
        gcd = None

    for idx, merch, _it in fast_rows:
        key = normalize_contact_name(merch)
        if not key:
            out[idx] = {"contact_id": None, "contact_name": None,
                        "source": "no_counterparty"}
            continue
        existing = by_key.get(key)
        if existing:
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
                )
                new_by_key[canonical_key] = stub
                # Also alias the merchant's raw key so a second row in
                # THIS batch under the raw string still dedupes.
                new_by_key.setdefault(key, stub)
            out[idx] = {"contact_id": stub["id"], "contact_name": stub["name"],
                        "source": "global_directory",
                        "linked_semantic": linked_sem,
                        "linked_semantic_confidence": gd_hit["confidence"]
                                                       if not identity_only else None}
            continue
        # No global hit — mint a bare tenant contact under the raw name.
        stub = new_by_key.get(key)
        if stub is None:
            stub = _new_contact_doc(company_id, merch, source="merchant_name")
            new_by_key[key] = stub
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

    return [r or {"contact_id": None, "contact_name": None, "source": "no_counterparty"}
            for r in out]


def _new_contact_doc(
    company_id: str,
    name: str,
    source: str,
    logo_url: str | None = None,
    linked_semantic: str | None = None,
) -> dict:
    """Build (but do not insert) a contact doc. Used by the batch resolver
    to defer inserts to a single `insert_many` call at the end.

    Optional `logo_url` + `linked_semantic` are attached when the
    contact was minted via a global-directory hit — see
    `global_contact_directory` for how they're populated.
    """
    return {
        "id": str(uuid.uuid4()),
        "company_id": company_id,
        "name": name,
        "normalized_name": normalize_contact_name(name),
        "type": None,
        "created_by_ai": True,
        "needs_review": True,
        "source": source,
        "logo_url": logo_url,
        "linked_semantic": linked_semantic,
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
