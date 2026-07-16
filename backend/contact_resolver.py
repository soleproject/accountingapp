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


def looks_noisy(merchant: str | None) -> bool:
    """True when the merchant string is really a raw bank memo that the AI
    resolver should extract from (not treated as a clean name)."""
    if not merchant:
        return False
    if len(merchant) > 45:      # clean names are almost always short
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

    Strips digits + per-row punctuation so identical bank memos with different
    ref numbers hash to the same key. E.g.
        'CITI CARD ONLINE DES:PAYMENT ID:XXX INDN:X CO ID:CITICTP WEB'
        'CITI CARD ONLINE DES:PAYMENT ID:YYY INDN:Y CO ID:CITICTP WEB'
    both → 'citi card online despayment'
    """
    if not text:
        return ""
    s = re.sub(r"\d+", "", text.lower())
    s = re.sub(r"[^a-z\s]+", " ", s)
    return " ".join(s.split()[:4])[:40]


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
                    "source": "merchant_name"}
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

    for idx, merch, _it in fast_rows:
        key = normalize_contact_name(merch)
        if not key:
            out[idx] = {"contact_id": None, "contact_name": None,
                        "source": "no_counterparty"}
            continue
        existing = by_key.get(key)
        if existing:
            out[idx] = {"contact_id": existing["id"], "contact_name": existing["name"],
                        "source": "merchant_name"}
            continue
        # Not yet in DB — dedupe within batch
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


def _new_contact_doc(company_id: str, name: str, source: str) -> dict:
    """Build (but do not insert) a contact doc. Used by the batch resolver
    to defer inserts to a single `insert_many` call at the end.
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
