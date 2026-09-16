"""Step 7 — Category classification (deterministic-first).

Precedence (highest wins; earlier rule terminates the pipeline):
    1. Movement-derived category (from Step 4)
       * internal_transfer / outside_transfer   → contra transfer account
       * card_payment / credit_line_payment     → the linked credit account
       These are stamped as ``category_source = "movement"``.
    2. Live ``contacts.default_category`` (read-only carry-through).
    3. Directory ``category_hint`` (Phase 3.5 — placeholder for now).
    4. Plaid PFC.detailed override on ``db.pfc_org_overrides`` (READ-ONLY).
    5. LLM ``category_fits`` — Claude Haiku 4.5, CoA-only, cached.
    6. Blank → ``category_source = "unresolved"`` (routed to
       ``uncategorized`` by Step 8).

Owner's Draw protection: NEVER auto-assign Owner's Draw unless the
bank account is flagged ``used_for_personal=true`` in the company's
``lab_settings.account_used_for_personal``.
"""
from __future__ import annotations
import hashlib, json, logging, re, uuid
from datetime import datetime, timezone
from typing import Optional

from db import db
from llm_client import LlmChat, UserMessage
from contact_resolver import normalize_descriptor

from .collections import LAB_TRANSACTIONS, LAB_LLM_CACHE
from .pfc_coa_defaults import PFC_COA_MAP

log = logging.getLogger("axiom.lab.step7")

_ELIGIBLE_ACCOUNT_TYPES = frozenset({
    "expense", "cogs", "cost of goods sold", "cost of sales",
    "other expense", "other-expense",
})

_OWNERS_DRAW_MARKERS = ("owner's draw", "owners draw", "owner draw",
                        "owner distribution", "distributions to owner")


def _is_owners_draw(acct: dict) -> bool:
    n = (acct.get("name") or "").lower()
    return any(m in n for m in _OWNERS_DRAW_MARKERS)


async def _load_coa(company_id: str) -> list[dict]:
    """CoA rows the lab may post to (expense/COGS + Owner's Draw for
    the personal-use path). Read-only."""
    accts: list[dict] = []
    async for a in db.accounts.find(
        {"company_id": company_id, "is_active": {"$ne": False}},
        {"_id": 0, "id": 1, "name": 1, "type": 1, "subtype": 1},
    ):
        t = (a.get("type") or "").lower()
        if t in _ELIGIBLE_ACCOUNT_TYPES or _is_owners_draw(a):
            accts.append(a)
    return accts


async def _load_pfc_overrides(company_id: str) -> dict[str, str]:
    """{ pfc_detailed → category_account_id } — never modified."""
    out: dict[str, str] = {}
    async for r in db.pfc_org_overrides.find(
        {"company_id": company_id},
        {"pfc_detailed": 1, "category_account_id": 1},
    ):
        pfc = (r.get("pfc_detailed") or "").strip()
        acct = r.get("category_account_id")
        if pfc and acct:
            out[pfc] = acct
    return out


async def _load_contact_defaults(company_id: str) -> dict[str, str]:
    """{ contact_id → default_category_account_id } from live contacts."""
    out: dict[str, str] = {}
    async for c in db.contacts.find(
        {"company_id": company_id, "default_category": {"$exists": True, "$ne": None}},
        {"id": 1, "default_category": 1},
    ):
        if c.get("default_category"):
            out[c["id"]] = c["default_category"]
    return out


async def _load_bank_fees_account(company_id: str) -> Optional[dict]:
    """Find the CoA account for bank fees, if one exists. Matched by
    name pattern (case-insensitive). Read-only."""
    return await db.accounts.find_one(
        {"company_id": company_id, "is_active": {"$ne": False},
         "name": {"$regex": r"(?i)^(bank\s*(fees|charges|service)|service\s*charges?|banking\s*fees?)$"}},
        {"_id": 0, "id": 1, "name": 1},
    )


async def _load_transfer_contra(company_id: str) -> Optional[str]:
    """The company's canonical internal-transfer contra account id, if
    one exists. Used for Step 4 movement rows."""
    doc = await db.accounts.find_one(
        {"company_id": company_id, "type": "equity",
         "name": {"$regex": r"(?i)transfer|clearing|due to|due from"}},
        {"id": 1},
    )
    return (doc or {}).get("id")


# --- LLM category_fits fallback ------------------------------------------

_LLM_PROVIDER = "anthropic"
_LLM_MODEL    = "claude-haiku-4-5-20251001"

_SYSTEM = (
    "You match a merchant description to ONE account name from a "
    "chart-of-accounts list. Rules: pick verbatim from the list, never "
    "invent. Never pick Owner's Draw / Owner Distribution unless the "
    "description clearly indicates a personal-use purchase. If nothing "
    "fits, return null. Output STRICT JSON: "
    '{"account_name": "..." or null, "confidence": "high|medium|low", '
    '"reason": "..."}'
)


def _llm_cache_key(description: str, contact: str, coa_names: list[str]) -> str:
    d = normalize_descriptor(description or "")
    payload = json.dumps({"d": d, "c": (contact or "").lower(),
                          "coa": sorted(coa_names)},
                         sort_keys=True, ensure_ascii=False)
    return "step7::" + hashlib.sha1(payload.encode("utf-8")).hexdigest()


async def _llm_pick_category(company_id: str, description: str,
                              contact: str, coa: list[dict]) -> dict:
    """Ask Claude Haiku to pick one CoA account by name. Cached."""
    names = [a["name"] for a in coa]
    cache_key = _llm_cache_key(description, contact, names)
    cached = await db[LAB_LLM_CACHE].find_one({"cache_key": cache_key}, {"_id": 0})
    if cached:
        return {"payload": cached.get("output") or {},
                "cache_hit": True, "cache_key": cache_key}
    chat = LlmChat(
        api_key=None, session_id=str(uuid.uuid4()),
        system_message=_SYSTEM, company_id=company_id,
    ).with_model(_LLM_PROVIDER, _LLM_MODEL)
    prompt = json.dumps({
        "description": (description or "")[:400],
        "merchant":    (contact or "")[:200],
        "candidates":  names,
    }, ensure_ascii=False)
    try:
        reply = await chat.send_message(UserMessage(text=prompt))
    except Exception as ex:                          # noqa: BLE001
        log.warning("lab.step7 llm failed: %s", ex)
        return {"payload": {"account_name": None, "reason": f"llm_error:{type(ex).__name__}"},
                "cache_hit": False, "cache_key": cache_key}
    text = (reply or "").strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text, flags=re.S)
    try:
        payload = json.loads(text)
    except Exception:
        m = re.search(r"\{.*\}", text, re.S)
        payload = json.loads(m.group(0)) if m else \
                  {"account_name": None, "reason": "unparseable_llm_reply"}
    await db[LAB_LLM_CACHE].update_one(
        {"cache_key": cache_key},
        {"$set": {
            "cache_key":  cache_key,
            "company_id": company_id,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "model":      _LLM_MODEL,
            "input":      {"description": description, "merchant": contact,
                            "coa_size": len(names)},
            "output":     payload,
        }},
        upsert=True,
    )
    return {"payload": payload, "cache_hit": False, "cache_key": cache_key}


# --- main pass ------------------------------------------------------------

async def run_step7(company_id: str, *, run_llm: bool = True,
                     llm_cap: int = 800) -> dict:
    """Assign a lab category to every row. Returns diagnostics."""
    coa      = await _load_coa(company_id)
    coa_by_name = {a["name"].lower(): a for a in coa}
    coa_by_id   = {a["id"]: a for a in coa}
    pfc_over = await _load_pfc_overrides(company_id)
    contact_defaults = await _load_contact_defaults(company_id)
    contra   = await _load_transfer_contra(company_id)
    bank_fees_acct = await _load_bank_fees_account(company_id)

    # Personal-use flags per bank account.
    lab_settings = (await db.companies.find_one(
        {"id": company_id}, {"lab_settings": 1})) or {}
    personal_use = ((lab_settings.get("lab_settings") or {})
                    .get("account_used_for_personal") or {})

    stats = {
        "by_source":  {},
        "llm_calls":  0,
        "llm_cache_hits": 0,
        "llm_capped": False,
        "owners_draw_blocked": 0,
    }
    llm_used = 0

    async for row in db[LAB_TRANSACTIONS].find({"company_id": company_id}):
        source, acct_id, reason = None, None, None
        mt = row.get("movement_type")

        # 1. Movement-derived
        if mt in ("internal_transfer", "outside_transfer", "unpaired_transfer"):
            acct_id, source, reason = contra, "movement", f"movement={mt}"
        elif mt in ("card_payment", "credit_line_payment"):
            acct_id = row.get("linked_lab_account")
            source, reason = "movement", f"movement={mt} → linked_lab_account"

        # 1a. Bank-fee auto-book (Feb-2026 fix #3).
        if not acct_id and row.get("merchant_type") == "bank_fee":
            if bank_fees_acct:
                acct_id = bank_fees_acct["id"]
                source, reason = "bank_fee", "merchant_type=bank_fee → Bank Fees CoA"
            else:
                source, reason = "bank_fee_no_coa", "no matching Bank Fees account in CoA"

        # 2. Contact default_category
        if not acct_id:
            cid = row.get("contact_id_lab")
            if cid and cid in contact_defaults:
                acct_id, source = contact_defaults[cid], "contact_default"
                reason = f"contact.default_category={acct_id}"

        # 3. PFC override (per-company)
        if not acct_id:
            pfc_detailed = ((row.get("raw") or {}).get("pfc_detailed") or "").strip()
            if pfc_detailed and pfc_detailed in pfc_over:
                acct_id = pfc_over[pfc_detailed]
                source, reason = "pfc_override", f"pfc.detailed={pfc_detailed}"

        # 3b. PFC → CoA default mapping (Feb-2026). Falls back BEFORE
        # the LLM so 89% of PFCs auto-book at zero LLM cost. Rows whose
        # default target is "Uncategorized Expense/Income" are left for
        # the LLM to try a better match before Step 8 flags them.
        if not acct_id:
            pfc_detailed = ((row.get("raw") or {}).get("pfc_detailed") or "").strip()
            default = PFC_COA_MAP.get(pfc_detailed) if pfc_detailed else None
            if default and default.get("coa"):
                target = default["coa"]
                # Uncategorized targets don't count as a real hit —
                # let the LLM try before Step 8 reviews.
                if not target.lower().startswith("uncategorized"):
                    match = coa_by_name.get(target.lower())
                    if match:
                        bank_id = row.get("bank_account_id")
                        if _is_owners_draw(match) and not personal_use.get(bank_id, False):
                            stats["owners_draw_blocked"] += 1
                        else:
                            acct_id = match["id"]
                            source  = "pfc_default"
                            reason  = f"pfc.detailed={pfc_detailed} → default map → '{match['name']}'"

        # 4. LLM category_fits — cache is always consulted (idempotent);
        # only the network call is guarded by run_llm.
        if not acct_id:
            desc = row.get("description_live") or ""
            cn   = row.get("contact") or (row.get("merchant_live") or "")
            coa_names = [a["name"] for a in coa]
            cache_key = _llm_cache_key(desc, cn, coa_names)
            cached = await db[LAB_LLM_CACHE].find_one(
                {"cache_key": cache_key}, {"_id": 0})
            if cached:
                stats["llm_cache_hits"] += 1
                picked = ((cached.get("output") or {}).get("account_name") or "").strip()
            elif run_llm and llm_used < llm_cap:
                r_llm = await _llm_pick_category(company_id, desc, cn, coa)
                stats["llm_calls"] += 1
                llm_used += 1
                picked = ((r_llm["payload"] or {}).get("account_name") or "").strip()
            else:
                picked = ""
                if run_llm and llm_used >= llm_cap:
                    stats["llm_capped"] = True
            if picked:
                match = coa_by_name.get(picked.lower())
                if match:
                    # Owner's Draw protection
                    bank_id = row.get("bank_account_id")
                    if _is_owners_draw(match) and not personal_use.get(bank_id, False):
                        stats["owners_draw_blocked"] += 1
                    else:
                        acct_id = match["id"]
                        source  = "llm_fits"
                        reason  = f"llm picked '{match['name']}'"

        # 5. Blank → unresolved
        if not acct_id:
            source = source or "unresolved"
            reason = reason or "no deterministic or llm match"

        set_doc = {
            "category": ({
                "account_id":   acct_id,
                "account_name": (coa_by_id.get(acct_id) or {}).get("name")
                                 if acct_id else None,
                "source":       source,
                "reason":       reason,
            } if acct_id or source else None),
            "category_source": source,
        }
        await db[LAB_TRANSACTIONS].update_one(
            {"_id": row["_id"]}, {"$set": set_doc},
        )
        stats["by_source"][source or "none"] = stats["by_source"].get(source or "none", 0) + 1
    return stats
