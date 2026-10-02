"""Meaning-first category resolver for the pro AI panel.

Turns a plain-English description of a transaction ("stuff for the office",
"this is a consulting company", "paid myself") into ONE recommendation:
either the closest EXISTING account on the company's chart, or a fully
specified GAAP-aligned NEW account (type / subtype / detail type / tax line /
code / optional parent). Nothing is created until `/apply` is called.

Order of resolution:
  1. canonical semantic library (deterministic, direction-aware aliases)
  2. LLM with the chart of accounts in context (closest existing account,
     else a complete new-account proposal)
"""
from __future__ import annotations

import hashlib
import re
import uuid

import canonical_semantic_accounts as csa
from account_normalize import normalize_account_payload
from db import db, now_iso

# ---------------------------------------------------------------------------
# 1. Canonical pre-pass — phrase cues → semantic key. `dir` restricts a cue
#    to money_out / money_in when the meaning flips with direction.
# ---------------------------------------------------------------------------
_CUES: list[tuple[str, str, str | None]] = [
    # (regex, semantic, direction or None)
    (r"\boffice\b|\bstationery\b|\bprinter (?:paper|ink)\b|\bsupplies for the office\b", "office_supplies", "money_out"),
    (r"\b(?:lunch|dinner|breakfast|coffee|meal|meals|food with|took .* to eat|restaurant)\b", "meals", "money_out"),
    (r"\b(?:software|subscription|saas|app|zoom|slack|adobe|microsoft 365|google workspace|quickbooks|license(?:s)? for software)\b", "software_saas", "money_out"),
    (r"\b(?:flight|airfare|hotel|airbnb|lodging|travel|uber to the airport|rental car)\b", "travel", "money_out"),
    (r"\b(?:gas|fuel|diesel|filled up)\b", "fuel", "money_out"),
    (r"\b(?:electric|electricity|water bill|power bill|utilities|utility)\b", "utilities", "money_out"),
    (r"\b(?:phone|cell|internet|wifi|telecom|verizon|at&t|comcast)\b", "telecom", "money_out"),
    (r"\b(?:rent|lease payment|landlord)\b", "rent", "money_out"),
    (r"\b(?:insurance|premium)\b", "insurance_expense", "money_out"),
    (r"\b(?:ads?|advertising|marketing|promo|facebook ads|google ads|sponsorship)\b", "marketing", "money_out"),
    (r"\b(?:repair|repairs|fixed the|maintenance|plumber|hvac)\b", "repairs_maintenance", "money_out"),
    (r"\b(?:lawyer|attorney|legal|cpa|accountant|bookkeeper|consultant we hired|consulting firm we use|professional fees?)\b", "professional_fees", "money_out"),
    (r"\b(?:bank fee|service charge|overdraft|wire fee|monthly fee)\b", "bank_fees", "money_out"),
    (r"\b(?:payroll|wages|salary|salaries|paid (?:my|our) (?:employees?|staff))\b", "payroll_expense", "money_out"),
    (r"\b(?:contractor|freelancer|1099|subcontractor|gig worker|contract labor)\b", "contract_labor", "money_out"),
    (r"\b(?:clean(?:ing|er)|janitor(?:ial)?|housekeeping)\b", "cleaning_janitorial", "money_out"),
    (r"\b(?:donation|donations|donated|charity|charitable|tithe|tithes|tithing|giving to)\b", "charitable_contributions", "money_out"),
    (r"\b(?:donation|donations|donated|grant)\b", "donation_income", "money_in"),
    (r"\b(?:paid myself|owner(?:'s)? draw|took money out for (?:me|myself)|personal|my own use|not (?:a )?business)\b", "owner_draw", "money_out"),
    (r"\b(?:put (?:my own )?money in|owner (?:contribution|investment)|i funded|capital contribution)\b", "owner_contribution", "money_in"),
    (r"\b(?:transfer|moved money|to savings|from savings|between (?:my|our) accounts|internal transfer)\b", "inter_account_transfer", None),
    (r"\b(?:credit card payment|paid (?:the|my|our) (?:credit )?card|card payment)\b", "credit_card_payment", "money_out"),
    (r"\b(?:loan payment|paid (?:the|our) loan|mortgage payment)\b", "loan_payment", "money_out"),
    (r"\b(?:sales tax (?:payment|remittance)|paid sales tax)\b", "sales_tax_payment", "money_out"),
    (r"\b(?:refund(?:ed)?|returned (?:it|the item)|chargeback)\b", "sales_refunds", "money_out"),
    (r"\b(?:consulting|consultant|advisory|we consult|my consulting)\b", "consulting_revenue", "money_in"),
    (r"\b(?:customer paid|client paid|payment from a (?:customer|client)|invoice (?:payment|paid)|sale|sales|revenue|income from)\b", "revenue_generic", "money_in"),
    (r"\b(?:interest)\b", "interest_income", "money_in"),
    (r"\b(?:interest)\b", "interest_expense", "money_out"),
    (r"\b(?:tools?|equipment|machine|laptop|computer|camera)\b", "equipment", "money_out"),
    (r"\b(?:materials|job supplies|lumber|parts for (?:a|the) job)\b", "job_supplies", "money_out"),
    (r"\b(?:permit|license|licence|registration fee|dues)\b", "licenses_permits", "money_out"),
    (r"\b(?:stripe fee|square fee|paypal fee|processing fee|merchant fee)\b", "payment_processing_fees", "money_out"),
]


def canonical_semantic_for_text(text: str, direction: str) -> str | None:
    t = " " + re.sub(r"\s+", " ", (text or "").lower()) + " "
    for rx, sem, d in _CUES:
        if d and d != direction:
            continue
        if re.search(rx, t) and sem in csa.CANONICAL_SEMANTIC_ACCOUNTS:
            return sem
    return None


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


def _existing_for_semantic(accounts: list[dict], sem: str) -> dict | None:
    spec = csa.CANONICAL_SEMANTIC_ACCOUNTS[sem]
    for a in accounts:
        if a.get("linked_semantic") == sem:
            return a
    want = _norm_name(spec["name"])
    for a in accounts:
        if _norm_name(a.get("name")) == want:
            return a
    # Same type + one name contains the other ("Inter-Account Transfer" vs
    # "Inter-Account Transfer (Clearing)", "Legal & Professional Fees" vs
    # "Professional Fees").
    for a in accounts:
        have = _norm_name(a.get("name"))
        if a.get("type") == spec["type"] and have and (have in want or want in have) and len(have) >= 6:
            return a
    return None


def _why_for(sem: str, direction: str, acct: dict | None = None) -> str:
    spec = csa.CANONICAL_SEMANTIC_ACCOUNTS[sem]
    t = (acct or {}).get("type") or spec["type"]
    kind = {"expense": "an ordinary operating expense", "cogs": "a direct cost of what you sell",
            "revenue": "income the business earned", "equity": "owner money, not a business expense",
            "liability": "paying down something you owe (not an expense)",
            "asset": "something the business owns, so it goes on the balance sheet"}.get(t, t)
    return f"{(acct or {}).get('name') or spec['name']} is {kind}; that matches a {direction.replace('_', '-')} transaction described this way."


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


async def _similar_count(cid: str, txn: dict | None) -> int:
    if not txn:
        return 0
    q: dict = {"company_id": cid, "id": {"$ne": txn["id"]}, "human_reviewed": {"$ne": True}}
    if txn.get("contact_id"):
        q["contact_id"] = txn["contact_id"]
    else:
        m = (txn.get("merchant") or txn.get("description") or "").strip()
        if not m:
            return 0
        q["$or"] = [{"merchant": m}, {"description": m}]
    return await db.transactions.count_documents(q)


# ---------------------------------------------------------------------------
# 2. LLM fallback — closest existing account, else complete GAAP proposal.
# ---------------------------------------------------------------------------
_RESOLVER_SYSTEM = (
    "You are a CPA helping a small-business owner who does not know accounting. They described a bank "
    "transaction in plain English. Decide where it belongs on THEIR chart of accounts.\n"
    "Rules:\n"
    "• Money OUT is normally an expense (or an asset purchase, a loan/credit-card paydown, an owner draw, "
    "or a transfer). Money IN is normally revenue (or an owner contribution, a loan received, a refund, or a transfer).\n"
    "• Prefer the closest EXISTING account. Only propose a NEW account when nothing existing reasonably fits.\n"
    "• A new account must be fully specified with standard GAAP naming (never the user's literal words), the "
    "right code range (1xxx assets, 2xxx liabilities, 3xxx equity, 4xxx revenue, 5xxx COGS, 6xxx–8xxx expenses), "
    "type, subtype, detail_type, and — when a natural parent exists on the chart (e.g. 'Software & SaaS' for a "
    "specific tool, 'Revenue' for a new revenue stream) — parent_account_id.\n"
    "• Explain in ONE plain sentence a non-accountant understands.\n"
    "Return strict JSON: {\"existing_account_id\": <id or null>, \"new_account\": {\"name\",\"code\",\"type\","
    "\"subtype\",\"detail_type\",\"parent_account_id\"} or null, \"why\": str, \"confidence\": 0-1, "
    "\"alternatives\": [<up to 2 existing ids>], \"not_business\": bool}"
)


async def _llm_resolve(message: str, txn: dict | None, accounts: list[dict], direction: str) -> dict:
    from ai_service import MODEL_NAME, _extract_json, _new_chat
    from llm_client import StreamDone, TextDelta, UserMessage
    acct_lines = "\n".join(
        f"  - id={a.get('id')} code={a.get('code')} name={a.get('name')} type={a.get('type')} subtype={a.get('subtype','')}"
        for a in accounts[:220])
    tline = ""
    if txn:
        tline = (f"Transaction: {txn.get('merchant') or txn.get('description')} · amount {txn.get('amount')} "
                 f"({direction.replace('_', ' ')}) · date {txn.get('date')} · memo {(txn.get('description') or '')[:80]}\n")
    prompt = f"{tline}User's description: {message!r}\n\nChart of accounts:\n{acct_lines}\n\nReturn the JSON."
    sid = hashlib.md5(f"rc-{message}-{(txn or {}).get('id')}".encode(), usedforsecurity=False).hexdigest()[:12]
    chat = _new_chat(_RESOLVER_SYSTEM, f"resolve-cat-{sid}", model_name=MODEL_NAME, feature="ai-review")
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


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------
async def resolve_category(cid: str, message: str, txn_id: str | None) -> dict:
    txn = await db.transactions.find_one({"id": txn_id, "company_id": cid}, {"_id": 0}) if txn_id else None
    direction = _direction(txn)
    accounts = await db.accounts.find({"company_id": cid, "active": {"$ne": False}}, {"_id": 0}).to_list(600)
    by_id = {a["id"]: a for a in accounts}
    company = await db.companies.find_one({"id": cid}, {"_id": 0, "industry_template": 1})
    template = (company or {}).get("industry_template") or "generic"
    similar = await _similar_count(cid, txn)

    def _pack(a: dict) -> dict:
        p = by_id.get(a.get("parent_account_id") or "")
        return {"id": a.get("id"), "code": a.get("code"), "name": a.get("name"), "type": a.get("type"),
                "subtype": a.get("subtype"), "detail_type": a.get("detail_type"),
                "parent_account_id": a.get("parent_account_id"), "parent_name": p.get("name") if p else None}

    sem = canonical_semantic_for_text(message, direction)
    if sem:
        hit = _existing_for_semantic(accounts, sem)
        rec = {"kind": "existing", "account": _pack(hit), "why": _why_for(sem, direction, hit),
               "confidence": 0.9, "source": "canonical"} if hit else \
              {"kind": "new", "account": _proposal_from_spec(sem, accounts, template), "why": _why_for(sem, direction),
               "confidence": 0.85, "source": "canonical"}
        rec["semantic"] = sem
        return {"recommendation": rec, "alternatives": [], "direction": direction,
                "similar_count": similar, "txn": _txn_brief(txn), "not_business": sem == "owner_draw"}

    data = await _llm_resolve(message, txn, accounts, direction)
    ex = by_id.get(str(data.get("existing_account_id") or ""))
    alts = [_pack(by_id[i]) for i in (data.get("alternatives") or []) if i in by_id][:2]
    if ex:
        rec = {"kind": "existing", "account": _pack(ex), "why": data.get("why") or "", "source": "llm",
               "confidence": float(data.get("confidence") or 0.6)}
    elif isinstance(data.get("new_account"), dict) and data["new_account"].get("name"):
        na = data["new_account"]
        parent = by_id.get(str(na.get("parent_account_id") or ""))
        taken = {a.get("code") for a in accounts}
        code = str(na.get("code") or "")
        if not code or code in taken:
            base = {"asset": 1500, "liability": 2500, "equity": 3500, "revenue": 4500, "cogs": 5500}.get(na.get("type"), 6900)
            code = next(str(c) for c in range(base, base + 400) if str(c) not in taken)
        acct = {"name": na.get("name"), "code": code, "type": na.get("type") or ("revenue" if direction == "money_in" else "expense"),
                "subtype": na.get("subtype") or "", "detail_type": na.get("detail_type") or "",
                "parent_account_id": parent["id"] if parent else None, "parent_name": parent.get("name") if parent else None,
                "tax_line": None, "semantic": None}
        normalize_account_payload(acct)
        rec = {"kind": "new", "account": acct, "why": data.get("why") or "", "source": "llm",
               "confidence": float(data.get("confidence") or 0.6)}
    else:
        rec = None
    return {"recommendation": rec, "alternatives": alts, "direction": direction, "similar_count": similar,
            "txn": _txn_brief(txn), "not_business": bool(data.get("not_business"))}


def _txn_brief(txn: dict | None) -> dict | None:
    if not txn:
        return None
    return {"id": txn.get("id"), "merchant": txn.get("merchant") or txn.get("description"), "amount": txn.get("amount"),
            "date": txn.get("date"), "contact_id": txn.get("contact_id"), "contact_name": txn.get("contact_name")}


async def create_account_from_proposal(cid: str, proposal: dict, template: str = "generic") -> dict:
    """Create the proposed account with every field. Canonical proposals go
    through ensure_semantic_account (idempotent); LLM proposals are inserted
    directly with normalized subtype/detail_type and optional parent."""
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
