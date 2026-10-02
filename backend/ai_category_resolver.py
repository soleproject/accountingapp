"""AI-first category resolver for the pro AI panel.

Turns a plain-English description of a transaction ("this was a painter",
"stuff for the office", "paid myself") into ONE recommendation: either the
closest EXISTING account on the company's chart, or a fully specified
GAAP-aligned NEW account. Nothing is created until `/apply` is called.

No keyword lists. The LLM sees the chart of accounts (filtered to types that
can hold money flowing this direction) plus the canonical GAAP library and
decides. When it proposes a new account, a second LLM check asks whether any
existing account already MEANS the same thing, so near-duplicates are caught
semantically rather than by bucket/token matching.
"""
from __future__ import annotations

import hashlib
import re
import uuid

import canonical_semantic_accounts as csa
from account_normalize import normalize_account_payload
from db import db, now_iso


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _direction(txn: dict | None) -> str:
    try:
        return "money_in" if float((txn or {}).get("amount") or 0) > 0 else "money_out"
    except Exception:  # noqa: BLE001
        return "money_out"


def _norm_name(n: str) -> str:
    n = re.sub(r"\(.*?\)", "", (n or "").lower())
    n = n.replace("&", "and").replace("'s", "").replace("-", " ")
    return " ".join(n.split())


def _proposal_from_spec(sem: str, accounts: list[dict], template: str) -> dict:
    spec = csa.CANONICAL_SEMANTIC_ACCOUNTS[sem]
    code = spec["code_by_template"].get(template) or spec["code_by_template"]["generic"]
    taken = {a.get("code") for a in accounts}
    if code in taken:
        base = int(code) if code.isdigit() else 9000
        for bump in range(1, 100):
            if str(base + bump) not in taken:
                code = str(base + bump)
                break
    return {
        "name": spec["name"], "code": code, "type": spec["type"], "subtype": spec["subtype"],
        "detail_type": spec["detail_type"], "tax_line": spec.get("tax_line"),
        "parent_account_id": None, "parent_name": None, "semantic": sem,
    }


async def _similar(cid: str, txn: dict | None) -> dict:
    """Unreviewed siblings of `txn` (same contact, else same merchant/memo)."""
    empty = {"similar_count": 0, "similar_ids": [], "similar_label": ""}
    if not txn:
        return empty
    q: dict = {"company_id": cid, "id": {"$ne": txn["id"]}, "human_reviewed": {"$ne": True}}
    label = txn.get("contact_name") or txn.get("merchant") or txn.get("description") or ""
    if txn.get("contact_id"):
        q["contact_id"] = txn["contact_id"]
    else:
        m = (txn.get("merchant") or txn.get("description") or "").strip()
        if not m:
            return empty
        q["$or"] = [{"merchant": m}, {"description": m}]
    rows = await db.transactions.find(q, {"_id": 0, "id": 1}).sort("date", -1).to_list(500)
    return {"similar_count": len(rows), "similar_ids": [r["id"] for r in rows], "similar_label": _clean_memo(label)}


_CONF_RE = re.compile(r"\b(?:conf(?:irmation)?#?\s*[:#]?\s*[a-z0-9]{5,}|ref(?:erence)?#?\s*[a-z0-9]{5,})", re.IGNORECASE)


def _clean_memo(text: str) -> str:
    """Strip bank confirmation / reference codes ('Conf# ywz25vsrm') so the
    model doesn't read 'Conf' as 'conference'."""
    return _CONF_RE.sub("", text or "").strip(" -·")


# ---------------------------------------------------------------------------
# Direction guard — structural, not semantic.
# ---------------------------------------------------------------------------
_INCOMPATIBLE = {"money_out": {"revenue"}, "money_in": {"expense", "cogs"}}
_REFUND_RE = re.compile(r"refund|reimburs|credit(?:ed)? back|returned|rebate|cash ?back|chargeback", re.IGNORECASE)


def direction_ok(acct_type: str | None, direction: str, message: str = "") -> bool:
    """Money out can't be revenue; money in can't be an expense — EXCEPT a
    vendor refund / reimbursement, which legitimately credits the original
    expense account."""
    if direction == "money_in" and _REFUND_RE.search(message or ""):
        return True
    return (acct_type or "") not in _INCOMPATIBLE.get(direction, set())


# ---------------------------------------------------------------------------
# LLM calls
# ---------------------------------------------------------------------------
_RESOLVER_SYSTEM = (
    "You are a CPA helping a small-business owner who does not know accounting. They described a bank "
    "transaction in plain English — it may be a single word, a trade ('a painter', 'the plumber'), a vendor, "
    "or a story. Work out what the money was FOR and where it belongs on THEIR chart of accounts.\n"
    "Rules:\n"
    "• Money OUT is normally an expense (or an asset purchase, a loan/credit-card paydown, an owner draw, "
    "or a transfer). Money IN is normally revenue (or an owner contribution, a loan received, a refund, or a transfer).\n"
    "• STRONGLY prefer an EXISTING account whose MEANING matches, even if its name is worded differently "
    "(a painter → an existing 'Repairs & Maintenance' or 'Contract Labor' account; 'facebook ads' → an existing "
    "'Advertising & Marketing'). Never pick an existing account just because it is the same type — 'Food Cost' is "
    "NOT where a painter goes. Read each account's PURPOSE from its name: 'Food Cost (COGS)' is food a restaurant "
    "sells, not generic job cost; '(COGS)' in a name does not make it a catch-all for direct costs.\n"
    "• A big-ticket item the business will use for more than a year (vehicle, forklift, machine, computer over ~$2,500) "
    "is a FIXED ASSET (1xxx), not an expense.\n"
    "• Only when nothing existing reasonably fits, propose a NEW account. First look in the STANDARD LIBRARY below "
    "and return its key as `semantic`; only if the library has nothing suitable, return a fully specified "
    "`new_account` with standard GAAP naming (never the user's literal words), the right code range (1xxx assets, "
    "2xxx liabilities, 3xxx equity, 4xxx revenue, 5xxx COGS, 6xxx–8xxx expenses), type, subtype, detail_type, and — "
    "when a natural parent exists on the chart — parent_account_id.\n"
    "• If the description is genuinely too vague to decide ('stuff', 'things', 'misc') or contradicts the direction "
    "('sales' for money going out), do NOT guess: return existing_account_id=null, semantic=null, new_account=null, "
    "confidence=0 and put ONE short, friendly clarifying question in `ask`.\n"
    "• `why` is ONE plain sentence a non-accountant understands.\n"
    "Return strict JSON: {\"existing_account_id\": <id or null>, \"semantic\": <library key or null>, "
    "\"new_account\": {\"name\",\"code\",\"type\",\"subtype\",\"detail_type\",\"parent_account_id\"} or null, "
    "\"why\": str, \"ask\": str or null, \"confidence\": 0-1, \"alternatives\": [<up to 2 existing ids>], "
    "\"not_business\": bool}"
)

_DEDUPE_SYSTEM = (
    "You are a CPA reviewing a chart of accounts. The owner is about to ADD a new account. Decide whether one of "
    "the EXISTING accounts listed already means the same thing (same economic purpose), so the new one would be a "
    "near-duplicate. Be strict: 'Advertising & Marketing' ≡ 'Marketing', 'Legal & Professional Fees' ⊇ "
    "'Professional Fees', but 'Food Cost' ≠ 'Contract Labor' and 'Meals' ≠ 'Travel'. Same type alone is NOT a match, and a "
    "broad catch-all ('Supplies & Materials', 'Other Expense', 'Miscellaneous') is NOT the same as a specific account "
    "('Equipment & Tools', 'Software & SaaS'). Only answer same_as when a CPA would consider the two names interchangeable.\n"
    "Return strict JSON: {\"same_as\": <existing id or null>, \"why\": str}"
)


async def _chat_json(system: str, prompt: str, sid: str, model: str | None = None) -> dict:
    import os

    from ai_service import MODEL_NAME, _extract_json, _new_chat
    from llm_client import StreamDone, TextDelta, UserMessage
    chat = _new_chat(system, sid, model_name=model or os.environ.get("LLM_MODEL_RESOLVER") or MODEL_NAME, feature="ai-review")
    raw = ""
    try:
        async for ev in chat.stream_message(UserMessage(text=prompt)):
            if isinstance(ev, TextDelta):
                raw += ev.content
            elif isinstance(ev, StreamDone):
                break
    except Exception:  # noqa: BLE001
        return {}
    return _extract_json(raw) or {}


def _acct_lines(accounts: list[dict]) -> str:
    return "\n".join(
        f"  - id={a.get('id')} code={a.get('code')} name={a.get('name')} type={a.get('type')} subtype={a.get('subtype', '')}"
        for a in accounts[:220])


def _library_lines(direction: str, message: str) -> str:
    return "\n".join(
        f"  - {k}: {s['name']} ({s['type']})"
        for k, s in csa.CANONICAL_SEMANTIC_ACCOUNTS.items() if direction_ok(s["type"], direction, message))


async def _llm_resolve(message: str, txn: dict | None, accounts: list[dict], direction: str) -> dict:
    accounts = [a for a in accounts if direction_ok(a.get("type"), direction, message)]
    tline = ""
    if txn:
        tline = (f"Transaction: {_clean_memo(txn.get('merchant') or txn.get('description'))} · amount {txn.get('amount')} "
                 f"({direction.replace('_', ' ')}) · date {txn.get('date')} · memo {_clean_memo(txn.get('description') or '')[:80]}\n")
    hint = ("Money is going OUT (a payment). It cannot be revenue." if direction == "money_out" else
            "Money is coming IN (a deposit). It cannot be an expense — unless the user describes a refund or "
            "reimbursement, which credits the ORIGINAL expense account.")
    prompt = (f"{tline}{hint}\nUser's description: {message!r}\n\n"
              f"Chart of accounts (already filtered to types valid for this direction):\n{_acct_lines(accounts)}\n\n"
              f"STANDARD LIBRARY (use a key as `semantic` when proposing new):\n{_library_lines(direction, message)}\n\nReturn the JSON.")
    sid = hashlib.md5(f"rc-{message}-{(txn or {}).get('id')}".encode(), usedforsecurity=False).hexdigest()[:12]
    return await _chat_json(_RESOLVER_SYSTEM, prompt, f"resolve-cat-{sid}")


async def _llm_dedupe(proposal: dict, accounts: list[dict], direction: str, message: str) -> dict | None:
    """Does an existing account already MEAN the same thing as `proposal`?
    Exact normalized-name match is identity; anything looser is decided by
    the model, never by bucket or token overlap."""
    want = _norm_name(proposal.get("name"))
    for a in accounts:
        if _norm_name(a.get("name")) == want and a.get("type") == proposal.get("type"):
            return a
    pool = [a for a in accounts if a.get("type") == proposal.get("type") and direction_ok(a.get("type"), direction, message)]
    if not pool:
        return None
    prompt = (f"Proposed new account: name={proposal.get('name')!r} type={proposal.get('type')} "
              f"subtype={proposal.get('subtype', '')} detail_type={proposal.get('detail_type', '')}\n"
              f"Existing accounts of the same type:\n{_acct_lines(pool)}\n\nReturn the JSON.")
    sid = hashlib.md5(f"dd-{want}-{len(pool)}".encode(), usedforsecurity=False).hexdigest()[:12]
    data = await _chat_json(_DEDUPE_SYSTEM, prompt, f"dedupe-cat-{sid}")
    by_id = {a["id"]: a for a in pool}
    return by_id.get(str(data.get("same_as") or ""))


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------
async def resolve_category(cid: str, message: str, txn_id: str | None) -> dict:
    txn = await db.transactions.find_one({"id": txn_id, "company_id": cid}, {"_id": 0}) if txn_id else None
    direction = _direction(txn)
    accounts = await db.accounts.find({"company_id": cid, "active": {"$ne": False}}, {"_id": 0}).to_list(600)
    by_id = {a["id"]: a for a in accounts}
    by_code = {str(a.get("code")): a for a in accounts if a.get("code")}
    company = await db.companies.find_one({"id": cid}, {"_id": 0, "industry_template": 1})
    template = (company or {}).get("industry_template") or "generic"
    similar = await _similar(cid, txn)

    def _pack(a: dict) -> dict:
        p = by_id.get(a.get("parent_account_id") or "")
        return {"id": a.get("id"), "code": a.get("code"), "name": a.get("name"), "type": a.get("type"),
                "subtype": a.get("subtype"), "detail_type": a.get("detail_type"),
                "parent_account_id": a.get("parent_account_id"), "parent_name": p.get("name") if p else None}

    def _lookup(ref) -> dict | None:
        ref = str(ref or "")
        return by_id.get(ref) or by_code.get(ref)

    base = {"direction": direction, **similar, "txn": _txn_brief(txn)}
    data = await _llm_resolve(message, txn, accounts, direction)
    try:
        conf = float(data.get("confidence") or 0)
    except (TypeError, ValueError):
        conf = 0.0
    why = data.get("why") or ""
    alts = [_pack(a) for a in (_lookup(i) for i in (data.get("alternatives") or []))
            if a and direction_ok(a.get("type"), direction, message)][:2]
    not_business = bool(data.get("not_business")) or data.get("semantic") == "owner_draw"

    ex = _lookup(data.get("existing_account_id"))
    if conf < 0.5 or (ex and not direction_ok(ex.get("type"), direction, message)):
        ex = None
    if ex:
        rec = {"kind": "existing", "account": _pack(ex), "why": why, "source": "llm", "confidence": conf}
        return {**base, "recommendation": rec, "alternatives": alts, "not_business": not_business}

    if conf < 0.5:
        return {**base, "recommendation": None, "alternatives": alts, "not_business": not_business,
                "too_vague": True, "ask": data.get("ask") or why or None}

    sem = data.get("semantic") if data.get("semantic") in csa.CANONICAL_SEMANTIC_ACCOUNTS else None
    if sem and direction_ok(csa.CANONICAL_SEMANTIC_ACCOUNTS[sem]["type"], direction, message):
        linked = next((a for a in accounts if a.get("linked_semantic") == sem), None)
        if linked:
            rec = {"kind": "existing", "account": _pack(linked), "why": why, "source": "llm+library", "confidence": conf}
            return {**base, "recommendation": rec, "alternatives": alts, "not_business": not_business}
        acct = _proposal_from_spec(sem, accounts, template)
    elif isinstance(data.get("new_account"), dict) and data["new_account"].get("name") \
            and direction_ok(data["new_account"].get("type"), direction, message):
        na = data["new_account"]
        parent = _lookup(na.get("parent_account_id"))
        taken = {a.get("code") for a in accounts}
        code = str(na.get("code") or "")
        if not code or code in taken:
            start = {"asset": 1500, "liability": 2500, "equity": 3500, "revenue": 4500, "cogs": 5500}.get(na.get("type"), 6900)
            code = next(str(c) for c in range(start, start + 400) if str(c) not in taken)
        acct = {"name": na.get("name"), "code": code, "type": na.get("type") or ("revenue" if direction == "money_in" else "expense"),
                "subtype": na.get("subtype") or "", "detail_type": na.get("detail_type") or "",
                "parent_account_id": parent["id"] if parent else None, "parent_name": parent.get("name") if parent else None,
                "tax_line": None, "semantic": None}
        normalize_account_payload(acct)
    else:
        return {**base, "recommendation": None, "alternatives": alts, "not_business": not_business,
                "ask": data.get("ask") or None}

    dup = await _llm_dedupe(acct, accounts, direction, message)
    if dup:
        rec = {"kind": "existing", "account": _pack(dup), "source": "llm+dedupe", "confidence": conf,
               "why": f"{why} Your chart already has “{dup.get('name')}” for this, so I'd use it rather than add a near-duplicate."}
    else:
        rec = {"kind": "new", "account": acct, "why": why, "source": "llm", "confidence": conf}
        if acct.get("semantic"):
            rec["semantic"] = acct["semantic"]
    return {**base, "recommendation": rec, "alternatives": alts, "not_business": not_business}


_CARD_INTENT_SYSTEM = (
    "A user is looking at a recommendation card in an accounting app. The card has buttons (listed with an id, "
    "the visible label, and what pressing it does). Decide whether the user's message is asking to press ONE of "
    "those buttons — by name, by meaning, by number ('the three similar ones' → Show 3 similar), or by intent "
    "('yes do it' → the primary button; 'no' / 'wrong' → Not this; 'that was personal' → Owner's Draw).\n"
    "If the message is instead a NEW description of what the transaction was, a question, or anything that is not "
    "a button press, return action_id=null.\n"
    "Return strict JSON: {\"action_id\": <id or null>, \"confidence\": 0-1}"
)


async def classify_card_intent(message: str, actions: list[dict]) -> dict:
    import os
    lines = "\n".join(f"  - id={a.get('id')} label={a.get('label')!r} does: {a.get('hint', '')}" for a in actions)
    prompt = f"Buttons:\n{lines}\n\nUser said: {message!r}\n\nReturn the JSON."
    sid = hashlib.md5(f"ci-{message}-{len(actions)}".encode(), usedforsecurity=False).hexdigest()[:12]
    data = await _chat_json(_CARD_INTENT_SYSTEM, prompt, f"card-intent-{sid}", model=os.environ.get("LLM_MODEL_FAST"))
    valid = {a.get("id") for a in actions}
    aid = data.get("action_id")
    try:
        conf = float(data.get("confidence") or 0)
    except (TypeError, ValueError):
        conf = 0.0
    return {"action_id": aid if aid in valid else None, "confidence": conf}


_RECEIPT_LINES_SYSTEM = (
    "You are a CPA categorizing the line items of ONE business receipt (money OUT) onto the client's chart of "
    "accounts. For every line decide where it belongs.\n"
    "Rules:\n"
    "• STRONGLY prefer an EXISTING account whose MEANING matches, even if worded differently. Never pick an account "
    "just because it is the same type — 'Food Cost (COGS)' is NOT where lumber or a drill goes. Read each account's "
    "PURPOSE from its name.\n"
    "• Sales tax PAID on this purchase is an EXPENSE line (Taxes & Licenses / Sales Tax Paid…), never lumped with the "
    "goods and NEVER 'Sales Tax Payable' or any liability (that is tax the business collected from its own customers). "
    "If no tax expense account exists, propose new_account 'Sales Tax Paid' (expense, 6xxx). Shipping/freight goes to a "
    "shipping account if one exists, else with the goods.\n"
    "• Only when nothing existing fits, propose NEW: first a key from the STANDARD LIBRARY as `semantic`; only if the "
    "library has nothing suitable, a fully specified `new_account` (GAAP name, code 5xxx COGS / 6xxx–8xxx expense / "
    "1xxx asset for durable equipment, type, subtype, detail_type).\n"
    "• A durable item used for more than a year and costing over ~$2,500 is a FIXED ASSET, not an expense.\n"
    "Return strict JSON: {\"lines\": [{\"idx\": int, \"existing_account_code\": <code of an existing account or null>, \"semantic\": <key or null>, "
    "\"new_account\": {\"name\",\"code\",\"type\",\"subtype\",\"detail_type\"} or null, \"confidence\": 0-1}]}"
)


async def _uncategorized_expense(cid: str, accounts: list[dict]) -> dict:
    hit = next((a for a in accounts if str(a.get("code")) in ("6999", "9999") or _norm_name(a.get("name")) == "uncategorized expense"), None)
    if hit:
        return hit
    return await create_account_from_proposal(cid, {"name": "Uncategorized Expense", "code": "6999", "type": "expense",
                                                    "subtype": "operating_expense", "detail_type": "operating_expense"})


async def categorize_receipt_lines(cid: str, lines: list[dict], vendor: str = "", industry: str = "") -> list[dict | None]:
    """AI-first: vision's exact CoA picks are trusted; everything else goes
    through one batched LLM call (CoA + library), then semantic dedupe and
    account creation. Returns account docs aligned to `lines`."""
    accounts = await db.accounts.find({"company_id": cid, "active": {"$ne": False}}, {"_id": 0}).to_list(600)
    company = await db.companies.find_one({"id": cid}, {"_id": 0, "industry_template": 1})
    template = (company or {}).get("industry_template") or "generic"
    by_id = {a["id"]: a for a in accounts}
    by_code = {str(a.get("code")): a for a in accounts if a.get("code")}
    by_name = {_norm_name(a.get("name")): a for a in accounts}
    out: list[dict | None] = [None] * len(lines)

    pending = []
    for i, ln in enumerate(lines):
        code, name = str(ln.get("account_code") or ""), _norm_name(ln.get("account_name") or "")
        hit = by_code.get(code) if code else None
        if hit and name and _norm_name(hit.get("name")) != name:
            hit = by_name.get(name) or hit
        hit = hit or (by_name.get(name) if name else None)
        if hit and direction_ok(hit.get("type"), "money_out"):
            out[i] = hit
        else:
            pending.append(i)
    if not pending:
        return out

    pool = [a for a in accounts if direction_ok(a.get("type"), "money_out")]
    line_txt = "\n".join(
        f"  - idx={i} description={lines[i].get('description')!r} amount={lines[i].get('amount')}"
        + (f" hint={lines[i].get('category_hint')!r}" if lines[i].get("category_hint") else "")
        + (f" vision_suggested={lines[i].get('account_name')!r}" if lines[i].get("account_name") else "")
        for i in pending)
    prompt = (f"Receipt from: {vendor or 'unknown vendor'}" + (f" · buyer industry: {industry}" if industry else "") +
              f"\nLines to categorize:\n{line_txt}\n\nChart of accounts:\n{_acct_lines(pool)}\n\n"
              f"STANDARD LIBRARY (use a key as `semantic` when proposing new):\n{_library_lines('money_out', '')}\n\nReturn the JSON.")
    sid = hashlib.md5(f"rl-{cid}-{line_txt}".encode(), usedforsecurity=False).hexdigest()[:12]
    data = await _chat_json(_RECEIPT_LINES_SYSTEM, prompt, f"receipt-lines-{sid}")
    results = {int(r.get("idx")): r for r in (data.get("lines") or []) if isinstance(r, dict) and str(r.get("idx", "")).lstrip("-").isdigit()}

    created: dict[str, dict] = {}  # proposal key → account
    for i in pending:
        r = results.get(i) or {}
        ref = str(r.get("existing_account_code") or r.get("existing_account_id") or "")
        ex = by_code.get(ref) or by_id.get(ref)
        if ex and direction_ok(ex.get("type"), "money_out"):
            out[i] = ex
            continue
        sem = r.get("semantic") if r.get("semantic") in csa.CANONICAL_SEMANTIC_ACCOUNTS else None
        na = r.get("new_account") if isinstance(r.get("new_account"), dict) and r["new_account"].get("name") else None
        if sem:
            key, proposal = f"sem:{sem}", _proposal_from_spec(sem, accounts, template)
        elif na and direction_ok(na.get("type") or "expense", "money_out"):
            proposal = {"name": na["name"], "code": str(na.get("code") or ""), "type": na.get("type") or "expense",
                        "subtype": na.get("subtype") or "", "detail_type": na.get("detail_type") or "", "semantic": None}
            normalize_account_payload(proposal)
            key = f"new:{_norm_name(proposal['name'])}"
        else:
            out[i] = await _uncategorized_expense(cid, accounts)
            continue
        if key not in created:
            linked = next((a for a in accounts if sem and a.get("linked_semantic") == sem), None)
            dup = linked or await _llm_dedupe(proposal, accounts, "money_out", "")
            if dup:
                created[key] = dup
            else:
                acct = await create_account_from_proposal(cid, proposal, template=template)
                created[key] = acct
                accounts.append(acct)
        out[i] = created[key]
    return out


async def categorize_receipt_analysis(cid: str, analysis: dict, vendor: str = "", industry: str = "") -> dict:
    """Stamp real account id/code/name onto every analysis line and rebuild
    the per-account rollup. Mutates and returns `analysis`."""
    from client_review_engine import rollup_suggested_categories
    for key in ("line_items",):
        lines = analysis.get(key) or []
        if not lines:
            continue
        accts = await categorize_receipt_lines(cid, lines, vendor, industry)
        for ln, a in zip(lines, accts):
            if a:
                ln["account_id"], ln["account_code"], ln["account_name"] = a.get("id"), a.get("code"), a.get("name")
        if "suggested_categories" in analysis:
            analysis["suggested_categories"] = rollup_suggested_categories(lines)
    return analysis


def _txn_brief(txn: dict | None) -> dict | None:
    if not txn:
        return None
    return {"id": txn.get("id"), "merchant": txn.get("merchant") or txn.get("description"), "amount": txn.get("amount"),
            "date": txn.get("date"), "contact_id": txn.get("contact_id"), "contact_name": txn.get("contact_name")}


async def create_account_from_proposal(cid: str, proposal: dict, template: str = "generic") -> dict:
    """Create the proposed account with every field. Library proposals go
    through ensure_semantic_account (idempotent); custom LLM proposals are
    inserted directly with normalized subtype/detail_type and optional parent."""
    if proposal.get("semantic"):
        acct = await csa.ensure_semantic_account(db, cid, proposal["semantic"], template=template)
        if acct:
            return acct
    existing = await db.accounts.find_one({"company_id": cid, "name": {"$regex": f"^{re.escape(proposal['name'])}$", "$options": "i"}}, {"_id": 0})
    if existing:
        return existing
    doc = {
        "id": str(uuid.uuid4()), "company_id": cid, "code": str(proposal.get("code") or ""),
        "name": proposal["name"], "type": proposal.get("type") or "expense",
        "subtype": proposal.get("subtype") or "", "detail_type": proposal.get("detail_type") or "",
        "parent_account_id": proposal.get("parent_account_id") or None,
        "tax_line": proposal.get("tax_line"), "active": True, "balance": 0.0,
        "created_via": "ai_panel_resolver", "created_at": now_iso(), "updated_at": now_iso(),
    }
    normalize_account_payload(doc)
    await db.accounts.insert_one(doc)
    doc.pop("_id", None)
    return doc
