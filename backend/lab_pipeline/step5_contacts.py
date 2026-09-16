"""Step 5 — deterministic contact resolution for lab rows.

Priority order (Feb-2026 spec, item #1):
    1. Plaid ``merchant_entity_id``           → contacts.merchant_entity_id lookup
    2. Plaid ``counterparties[]``             → first non-payment-app entry name
    3. Parsed description                     → Zelle / Venmo / Cash App / PayPal-BofA-ID
    4. Live contacts + descriptor aliases     → read-only lookup on live ``contacts`` collection
    5. Normalized-name match                  → business-suffix strip + person-name match
    6. Enrich merchant_name                   → cached Plaid /transactions/enrich
    7. LLM fallback (Claude Haiku 4.5)        → prefer matching an existing contact
    8. Blank                                  → contact = null, contact_source = "unresolved"

Skip conditions (item #3): if the row's Step-4 ``movement_type`` is one of
``internal_transfer``, ``card_payment``, ``credit_line_payment``, or
``outside_transfer``, contact resolution is bypassed entirely.

Never mints INDN-derived contacts (item #6).
"""
from __future__ import annotations
import logging
import re
import uuid
from datetime import datetime, timezone
from typing import Optional

from db import db
from .collections import (
    LAB_TRANSACTIONS, LAB_CONTACTS, LAB_MERGE_SUGGESTIONS,
)
from .enrich import get_cached as get_enrich_cached

# Read-only reuse of live helpers (pure functions).
from contact_resolver import (
    normalize_contact_name,
    normalize_descriptor,
    extract_p2p_counterparty,
    _P2P_PAYMENT_APPS,
    _INDN_RX,
)

log = logging.getLogger("axiom.lab.step5")

SKIP_MOVEMENT_TYPES = frozenset({
    "internal_transfer", "card_payment",
    "credit_line_payment", "outside_transfer",
})

# --- name normalization utilities ------------------------------------------

_PUNCT_RX      = re.compile(r"[^a-z0-9\s]")
_SPACE_RX      = re.compile(r"\s+")


def _person_tokens(name: str) -> list[str]:
    """Lowercased name tokens with middle-initial dot stripping.
    Empty tokens are dropped."""
    s = _PUNCT_RX.sub(" ", (name or "").lower())
    return [t for t in _SPACE_RX.split(s) if t]


def _run_together(tokens: list[str]) -> str:
    return "".join(tokens)


def _matches_person_name(a: str, b: str) -> bool:
    """True when two strings likely refer to the same person.

    Rules (spec):
      * Same tokens (order-independent) match.
      * Middle initial ignored (e.g., "John F Kennedy" == "John Kennedy").
      * First/last order swap matches ("Doe Jane" == "Jane Doe").
      * Run-together matches ("janedoe" == "jane doe").
      * Same last name alone is NOT a match.
    """
    ta, tb = _person_tokens(a), _person_tokens(b)
    if not ta or not tb:
        return False
    # Drop 1-char "middle initial" tokens for comparison.
    ta = [t for t in ta if len(t) > 1]
    tb = [t for t in tb if len(t) > 1]
    if not ta or not tb:
        return False
    sa, sb = set(ta), set(tb)
    if len(sa & sb) >= 2:
        return True
    # Run-together forms — try both orders on either side to catch
    # first/last swaps.
    rta, rtb = _run_together(ta), _run_together(tb)
    rta_r, rtb_r = _run_together(ta[::-1]), _run_together(tb[::-1])
    if rta and (rta in (rtb, rtb_r)):
        return True
    if rta_r and rta_r == rtb:
        return True
    # Single-token strings: allow only if the run-together check matched
    # above. Same last name alone (len==1 overlap) is NOT enough.
    return False


def _is_business_name(name: str) -> bool:
    """Heuristic: contains a corp-suffix token OR >= 3 tokens with mixed
    types (e.g. "Kevin Petersen Construction Co")."""
    low = (name or "").lower()
    suffixes = ("llc", "inc", "corp", "co", "ltd", "company",
                "services", "group", "holdings", "capital",
                "partners", "enterprises", "consulting")
    return any(f" {s}" in f" {low} " for s in suffixes)


def _matches_business_name(a: str, b: str) -> bool:
    """Business match uses ``normalize_contact_name`` (strips LLC/Inc/etc.)."""
    na = normalize_contact_name(a)
    nb = normalize_contact_name(b)
    return bool(na) and na == nb


def _match_name(a: str, b: str) -> bool:
    """Business path first (strip suffixes), else person-name rules."""
    if not a or not b:
        return False
    if a.strip().lower() == b.strip().lower():
        return True
    if _is_business_name(a) or _is_business_name(b):
        if _matches_business_name(a, b):
            return True
    return _matches_person_name(a, b)


def _payment_app_only(counterparties: list[dict] | None) -> bool:
    if not counterparties:
        return False
    non_app = [c for c in counterparties if (c or {}).get("type", "").lower() != "payment_app"
               and (c or {}).get("name", "").strip().lower() not in _P2P_PAYMENT_APPS]
    return not non_app


def _first_non_app_counterparty(counterparties: list[dict] | None) -> Optional[dict]:
    for c in (counterparties or []):
        if not c:
            continue
        if (c.get("type") or "").lower() == "payment_app":
            continue
        if (c.get("name") or "").strip().lower() in _P2P_PAYMENT_APPS:
            continue
        if c.get("name"):
            return c
    return None


def _looks_indn_only(description: str | None, candidate: str | None) -> bool:
    """True when the candidate is nothing but the INDN capture from the
    description. Guard against minting INDN-derived contacts (spec #6)."""
    if not description or not candidate:
        return False
    m = _INDN_RX.search(description)
    if not m:
        return False
    indn = re.sub(r"\s+", " ", m.group(1)).strip().title()
    return indn.lower() == candidate.strip().lower()


# --- main resolver ---------------------------------------------------------

async def resolve_for_company(company_id: str) -> dict:
    """Resolve contact for every ``lab_transactions`` row of the company.

    Returns diagnostics: source distribution + unresolved list. Actual
    Enrich calls are performed by ``enrich.enrich_non_plaid_rows`` before
    this step runs; here we only READ the cache.
    """
    contacts_live = await _load_live_contacts(company_id)
    aliases       = _build_alias_index(contacts_live)
    by_entity     = _build_entity_index(contacts_live)
    by_normname   = _build_name_index(contacts_live)

    unresolved: list[dict] = []
    source_counts: dict[str, int] = {}
    lab_new: list[dict] = []           # contacts the lab would create (not in live yet)
    contact_diffs: list[dict] = []      # rows where live.contact != lab.contact

    async for row in db[LAB_TRANSACTIONS].find({"company_id": company_id}):
        result = await _resolve_one(
            row, contacts_live, aliases, by_entity, by_normname,
        )
        source_counts[result["source"]] = source_counts.get(result["source"], 0) + 1

        set_doc = {
            "contact":         result.get("contact"),
            "contact_source":  result["source"],
            "contact_reason":  result.get("reason"),
            "contact_id_lab":  result.get("contact_id"),
            "lab_contact_new": bool(result.get("mint")),
        }
        await db[LAB_TRANSACTIONS].update_one(
            {"_id": row["_id"]}, {"$set": set_doc},
        )

        # Track "contact would be MINTED" candidates for lab_contacts.
        if result.get("mint") and result.get("contact"):
            lab_new.append({
                "name":            result["contact"],
                "normalized_name": normalize_contact_name(result["contact"]),
                "source":          result["source"],
                "txn_id":          row.get("txn_id"),
            })

        # Live vs lab diff — for the compare page + report.
        live_name = (row.get("contact_name_live") or "").strip()
        lab_name  = (result.get("contact") or "").strip()
        if live_name.lower() != lab_name.lower():
            contact_diffs.append({
                "txn_id":      row.get("txn_id"),
                "date":        row.get("date"),
                "description": row.get("description_live"),
                "live":        live_name or None,
                "lab":         lab_name or None,
                "source":      result["source"],
                "reason":      result.get("reason"),
            })

        if result["source"] == "unresolved":
            unresolved.append({
                "txn_id":      row.get("txn_id"),
                "date":        row.get("date"),
                "description": row.get("description_live"),
                "channel":     row.get("channel"),
            })

    # Persist lab-minted contacts (idempotent on normalized_name).
    await _persist_lab_contacts(company_id, lab_new)

    # Compute merge suggestions (spec #7).
    merge_suggestions = await _compute_merge_suggestions(company_id, contacts_live)

    return {
        "source_distribution":  source_counts,
        "unresolved":           unresolved,
        "contact_diffs":        contact_diffs,
        "lab_new_contacts":     lab_new,
        "merge_suggestions":    merge_suggestions,
    }


async def _resolve_one(row: dict,
                        contacts_live: list[dict],
                        aliases: dict[str, dict],
                        by_entity: dict[str, dict],
                        by_normname: dict[str, dict]) -> dict:
    """Return {source, contact, reason, contact_id?, mint?}."""

    # (0) Skip based on movement type — no counterparty needed.
    mt = row.get("movement_type")
    if mt in SKIP_MOVEMENT_TYPES:
        return {"source": "skip_movement", "contact": None,
                "reason": f"skipped by movement_type={mt}"}

    raw       = row.get("raw") or {}
    parsed    = row.get("parsed") or {}
    paypal    = row.get("paypal") or {}
    counterparties = raw.get("counterparties") or []
    description    = row.get("description_live") or ""
    merchant_live  = row.get("merchant_live") or raw.get("merchant_name")
    entity_id      = raw.get("merchant_entity_id")

    # (1) Plaid merchant_entity_id ------------------------------------------
    if entity_id and entity_id in by_entity:
        c = by_entity[entity_id]
        return {"source": "plaid_entity_id", "contact": c["name"],
                "contact_id": c["id"],
                "reason": f"matched entity_id={entity_id}"}

    # (2) Plaid counterparties[] (skip if only the payment app) -------------
    if not _payment_app_only(counterparties):
        cp = _first_non_app_counterparty(counterparties)
        if cp:
            name = cp["name"]
            # Try to match to a live contact first.
            match = _match_live(name, contacts_live, by_normname)
            if match:
                return {"source": "plaid_counterparties",
                        "contact": match["name"], "contact_id": match["id"],
                        "reason": f"counterparty '{name}' → live contact"}
            # Otherwise mint a new lab contact (unless INDN-only).
            if not _looks_indn_only(description, name):
                return {"source": "plaid_counterparties",
                        "contact": name, "mint": True,
                        "reason": "counterparty from Plaid — not in live"}

    # (3) Parsed description (P2P + PayPal BofA ID) --------------------------
    parsed_name = _parsed_description_name(row, parsed, paypal, description)
    if parsed_name:
        if _looks_indn_only(description, parsed_name):
            # INDN never becomes a contact.
            pass
        else:
            match = _match_live(parsed_name, contacts_live, by_normname)
            if match:
                return {"source": "parsed_description",
                        "contact": match["name"], "contact_id": match["id"],
                        "reason": f"parsed name '{parsed_name}' → live contact"}
            return {"source": "parsed_description",
                    "contact": parsed_name, "mint": True,
                    "reason": f"parsed name '{parsed_name}' — not in live"}

    # (4) Live descriptor aliases -------------------------------------------
    key = normalize_descriptor(description)
    if key and key in aliases:
        c = aliases[key]
        return {"source": "descriptor_alias",
                "contact": c["name"], "contact_id": c["id"],
                "reason": f"descriptor_alias='{key}'"}

    # (5) Normalized name match against live contacts -----------------------
    for candidate in _name_candidates(row, merchant_live, parsed, paypal):
        if not candidate:
            continue
        if _looks_indn_only(description, candidate):
            continue
        match = _match_live(candidate, contacts_live, by_normname)
        if match:
            return {"source": "normalized_name",
                    "contact": match["name"], "contact_id": match["id"],
                    "reason": f"'{candidate}' == '{match['name']}' (normalized)"}

    # (6) Enrich merchant_name (cached) — non-Plaid rows --------------------
    cache_key = row.get("enrich_cache_key")
    if cache_key:
        cached = await get_enrich_cached(cache_key)
        if cached and cached.get("enrich_available"):
            enrich_name = cached.get("merchant_name")
            if enrich_name:
                match = _match_live(enrich_name, contacts_live, by_normname)
                if match:
                    return {"source": "enrich_merchant",
                            "contact": match["name"], "contact_id": match["id"],
                            "reason": f"enrich merchant_name '{enrich_name}' → live"}
                return {"source": "enrich_merchant",
                        "contact": enrich_name, "mint": True,
                        "reason": "enrich merchant_name — not in live"}

    # (7) LLM fallback — deferred to a second pass so we can batch and cap.
    return {"source": "llm_pending", "contact": None,
            "reason": "unresolved after deterministic steps"}


def _parsed_description_name(row: dict, parsed: dict, paypal: dict,
                              description: str) -> Optional[str]:
    """Return the counterparty name extracted from the description, or
    None. INDN filtering is applied by the caller."""
    # PayPal BofA-format merchant purchase → use the ID field.
    if paypal and paypal.get("kind") == "merchant_purchase" and paypal.get("merchant"):
        return paypal["merchant"]
    # Zelle / Venmo / Cash App / INDN — use the shared helper. It rejects
    # payment-app-only names automatically.
    counterparties = (row.get("raw") or {}).get("counterparties")
    return extract_p2p_counterparty(
        merchant=row.get("merchant_live"),
        description=description,
        original_description=(row.get("raw") or {}).get("original_description"),
        counterparties=counterparties,
    )


def _name_candidates(row: dict, merchant_live: str | None,
                      parsed: dict, paypal: dict) -> list[str]:
    """Ordered list of name candidates for the normalized-match step."""
    out: list[str] = []
    if merchant_live:
        out.append(merchant_live)
    orig = (parsed or {}).get("originator")
    if orig:
        out.append(orig.title())
    if paypal and paypal.get("kind") == "merchant_purchase":
        out.append(paypal.get("merchant") or "")
    return [c for c in out if c]


# --- live contact loading + indexes ---------------------------------------

async def _load_live_contacts(company_id: str) -> list[dict]:
    """Read-only pull of live contacts and their descriptor_aliases."""
    return [c async for c in db.contacts.find(
        {"company_id": company_id},
        {"_id": 0, "id": 1, "name": 1, "normalized_name": 1,
         "merchant_entity_id": 1, "descriptor_aliases": 1},
    )]


def _build_alias_index(contacts: list[dict]) -> dict[str, dict]:
    idx: dict[str, dict] = {}
    for c in contacts:
        for a in (c.get("descriptor_aliases") or []):
            if isinstance(a, str) and a:
                idx.setdefault(a, c)
    return idx


def _build_entity_index(contacts: list[dict]) -> dict[str, dict]:
    return {c["merchant_entity_id"]: c for c in contacts if c.get("merchant_entity_id")}


def _build_name_index(contacts: list[dict]) -> dict[str, dict]:
    """Normalized-name → contact. Falls back to name-based normalization
    when the stored field is missing."""
    idx: dict[str, dict] = {}
    for c in contacts:
        n = c.get("normalized_name") or normalize_contact_name(c.get("name") or "")
        if n:
            idx.setdefault(n, c)
    return idx


def _match_live(candidate: str, contacts: list[dict],
                 by_normname: dict[str, dict]) -> Optional[dict]:
    """Return the best live-contact match for `candidate`, or None."""
    if not candidate:
        return None
    # Fast path: exact normalized match.
    n = normalize_contact_name(candidate)
    if n and n in by_normname:
        return by_normname[n]
    # Slow path: person-name-aware match.
    for c in contacts:
        if _match_name(candidate, c.get("name") or ""):
            return c
    return None


# --- lab-mint persistence -------------------------------------------------

async def _persist_lab_contacts(company_id: str, lab_new: list[dict]) -> None:
    """Write ``lab_contacts`` rows for names the lab would create but
    that don't exist in live. Idempotent on (company_id, normalized_name).
    Never touches ``contacts``."""
    if not lab_new:
        return
    now = datetime.now(timezone.utc).isoformat()
    seen: set[str] = set()
    for item in lab_new:
        norm = item.get("normalized_name")
        if not norm or norm in seen:
            continue
        seen.add(norm)
        await db[LAB_CONTACTS].update_one(
            {"company_id": company_id, "normalized_name": norm},
            {"$setOnInsert": {
                "id":              str(uuid.uuid4()),
                "company_id":      company_id,
                "name":            item.get("name"),
                "normalized_name": norm,
                "source":          item.get("source"),
                "created_at":      now,
             },
             "$inc": {"txn_count": 1},
             "$set": {"last_txn_id": item.get("txn_id"),
                      "last_updated": now}},
            upsert=True,
        )


# --- merge suggestions (spec #7) ------------------------------------------

async def _compute_merge_suggestions(company_id: str,
                                      contacts_live: list[dict]) -> list[dict]:
    """Group live contacts by normalized name and by person-name rules.
    Emit one merge suggestion per group with >1 member. Writes to
    ``lab_merge_suggestions`` (idempotent per group key)."""
    by_norm: dict[str, list[dict]] = {}
    for c in contacts_live:
        n = c.get("normalized_name") or normalize_contact_name(c.get("name") or "")
        if not n:
            continue
        by_norm.setdefault(n, []).append(c)
    suggestions: list[dict] = []
    now = datetime.now(timezone.utc).isoformat()
    for norm, members in by_norm.items():
        if len(members) <= 1:
            continue
        names = sorted({m["name"] for m in members if m.get("name")})
        key = "norm::" + norm
        doc = {
            "id":          str(uuid.uuid4()),
            "company_id":  company_id,
            "key":         key,
            "kind":        "normalized_name",
            "reason":      f"{len(members)} live contacts normalize to '{norm}'",
            "names":       names,
            "contact_ids": [m["id"] for m in members],
            "created_at":  now,
        }
        await db[LAB_MERGE_SUGGESTIONS].update_one(
            {"company_id": company_id, "key": key},
            {"$setOnInsert": doc, "$set": {"last_updated": now}},
            upsert=True,
        )
        suggestions.append({"key": key, "reason": doc["reason"], "names": names})

    # Person-name variants (middle-initial / order swap / run-together)
    # not caught by normalized_name alone.
    handled = set()
    for i, a in enumerate(contacts_live):
        an = a.get("name") or ""
        if _is_business_name(an):
            continue
        for b in contacts_live[i + 1:]:
            bn = b.get("name") or ""
            if _is_business_name(bn):
                continue
            if a["id"] == b["id"]:
                continue
            if _matches_person_name(an, bn):
                key = "person::" + "::".join(sorted([a["id"], b["id"]]))
                if key in handled:
                    continue
                handled.add(key)
                doc = {
                    "id":          str(uuid.uuid4()),
                    "company_id":  company_id,
                    "key":         key,
                    "kind":        "person_variant",
                    "reason":      f"person-name variants: '{an}' vs '{bn}'",
                    "names":       [an, bn],
                    "contact_ids": [a["id"], b["id"]],
                    "created_at":  now,
                }
                await db[LAB_MERGE_SUGGESTIONS].update_one(
                    {"company_id": company_id, "key": key},
                    {"$setOnInsert": doc, "$set": {"last_updated": now}},
                    upsert=True,
                )
                suggestions.append({"key": key, "reason": doc["reason"],
                                    "names": [an, bn]})
    return suggestions
