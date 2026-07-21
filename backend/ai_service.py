"""AI service: categorization + chat via Claude Sonnet 4.5 (emergentintegrations)."""
from __future__ import annotations
import os
import json
import re
import hashlib
from typing import AsyncGenerator, Optional
from emergentintegrations.llm.chat import LlmChat, UserMessage, TextDelta, StreamDone

EMERGENT_LLM_KEY = os.environ["EMERGENT_LLM_KEY"]
MODEL_PROVIDER = "anthropic"
MODEL_NAME = "claude-sonnet-4-5-20250929"
MODEL_HAIKU = "claude-haiku-4-5-20251001"  # cheap + fast — used for contact extraction

CATEGORIZATION_SYSTEM = (
    "You are an expert US-GAAP bookkeeper categorizing bank transactions for a small business.\n\n"
    "Output STRICT JSON with keys: account_code (string), confidence (0.0-1.0 float), reasoning (one short sentence).\n\n"
    "Decision rules:\n"
    "- Pick exactly ONE account_code from the chart-of-accounts list.\n"
    "- Positive amount (money in) → income, refund of expense, or asset. Customer payments → revenue; refunds → reverse the original expense; loan proceeds → liability; interest received → interest income.\n"
    "- Negative amount (money out) → expense or asset.\n\n"
    "Merchant disambiguation (READ CAREFULLY):\n"
    "- 'Uber' alone or 'Uber [reference]' → Travel/Transportation (NOT Meals).\n"
    "- 'Uber Eats', 'DoorDash', 'Grubhub', 'Postmates' → food delivery → Meals & Entertainment.\n"
    "- 'Lyft', taxi, public transit → Travel.\n"
    "- Airfare (United/Delta/Southwest/American), hotels, car rental → Travel.\n"
    "- Restaurants, cafes (Starbucks, Peet's), fast food (McDonald's, Chipotle) → Meals.\n"
    "- Gas stations (Shell, Chevron, Exxon, BP, 76) → Auto/Vehicle expense.\n"
    "- Office supply stores (Staples, Office Depot), SaaS subscriptions → Office/Software.\n"
    "- Hardware stores, building materials → Supplies.\n"
    "- 'INTRST PYMNT', 'INTEREST CREDIT' deposits → Interest Income.\n"
    "- Zelle/Venmo: the recipient (or sender) IS the counterparty, not the app.\n"
    "- 'CREDIT CARD ... PAYMENT' outgoing → Credit Card liability paydown (NOT an expense).\n"
    "- 'AUTOMATIC PAYMENT' without other context → ambiguous, confidence < 0.5.\n"
    "- Payroll provider names (Gusto, ADP, Paychex) → Payroll Expenses.\n\n"
    "Confidence calibration:\n"
    "- 0.95+ : merchant unambiguous, perfect-fit account exists.\n"
    "- 0.80-0.94 : likely correct, minor ambiguity.\n"
    "- 0.50-0.79 : reasonable guess, reviewer should verify.\n"
    "- < 0.50 : truly ambiguous, flag for human review.\n\n"
    "When Plaid Personal Finance Category (PFC) is provided, treat it as a strong hint (esp. VERY_HIGH/HIGH confidence)."
)

CONTACT_EXTRACTION_SYSTEM = (
    "You identify counterparty names from US bank-transaction descriptions and match them against an existing contact list.\n\n"
    "Output STRICT JSON only: {\"has_counterparty\": bool, \"extracted_name\": string|null, \"match_existing_id\": string|null, \"reason\": string}.\n\n"
    "Rules:\n"
    "- DEFAULT to has_counterparty=true and try to extract a name. Transfer phrasing ('Online Banking transfer', 'Online Transfer to/from', 'TRANSFER', 'WIRE TYPE', 'WT Fed#…') does NOT by itself mean there is no counterparty — examine the rest of the description for a real entity (person, business, trust, fund, government, attorney).\n"
    "  • 'Online Transfer to Psg Spendthrift Trust Ref #lb0W2Bphy4 …' → has_counterparty=true, extracted_name='Psg Spendthrift Trust'.\n"
    "  • 'WT Fed#02M04 Jpmorgan Chase Ban /Org=Grace&Love Trust Roman Gonzalez Srf# …' → has_counterparty=true, extracted_name='Grace&Love Trust'.\n"
    "  • 'WIRE TYPE:WIRE OUT ORIG:ACME LLC ID:…' → has_counterparty=true, extracted_name='Acme LLC'.\n"
    "  • 'Online Transfer From Nexxess Everyday Checking xxxxxx7776 Ref #…' → has_counterparty=true, extracted_name='Nexxess'.\n"
    "  • 'Zelle payment to Romeo Ugali Conf# xxxx' → has_counterparty=true, extracted_name='Romeo Ugali' (the RECIPIENT, not the app).\n"
    "- has_counterparty=false ONLY when the description is genuinely internal — it references only the user's own bank account identifiers and contains no third-party entity name. Signals: just an account number after TO/FROM ('TRANSFER TO ACCT 6084', 'TO CHK 1234', 'TO SAV ####'), book/internal markers with no named entity ('WELLS FARGO IFI DDA TO DDA', 'WIRE TYPE BOOK' with no ORIG:/Bnf= name), bank fees ('Monthly Maintenance Fee', 'Wire Transfer Fee', 'Wire Trans Svc Charge'), interest ('Interest Earned', 'INTRST PYMNT', 'Interest Payment'). For these set extracted_name=null and match_existing_id=null.\n"
    "- has_counterparty=true for real merchants, billers (Capital One, Citi Card, Healthy Paws Pet), Zelle/Venmo recipients (the PERSON, not the app), and wire originators (the ORIG: or /Bnf= or /Org= field, not the bank).\n"
    "- extracted_name must be the CLEAN counterparty — strip every authorization code, transaction id, card number, location, and memo.\n"
    "  • 'Romeo Ugali' not 'Zelle payment to Romeo Ugali Conf# xxxx'.\n"
    "  • 'Capital One' not 'CAPITAL ONE DES:MOBILE PMT ID:XXXXX44380 WEB'.\n"
    "  • 'Healthy Paws Pet' not 'Healthy Paws Pet DES:claimpymt ID:XXXXX…'.\n"
    "  • 'Zoom' not 'Recurring Payment authorized on 12/26 Zoom.Com 888-799-9 Zoom.US CA S355360700932398 Card 6236'.\n"
    "  • 'GitHub' not 'Recurring Payment authorized on 12/27 Github, Inc. Github.Com CA S355361673115061 Card 6236'.\n"
    "  • 'Adobe' not 'Recurring Payment authorized on 12/14 Adobe Inc San Jose CA S305348580878822 Card 6236'.\n"
    "- 'Recurring Payment authorized on <date> <MERCHANT> [city/state] [auth code] Card #####' pattern: extract just the merchant name from the middle. Drop the date prefix and everything after the merchant (location, S###, Card #).\n"
    "- 'WIRE TYPE:… ORIG:<NAME> ID:…' or 'WT Fed#… /Org=<NAME>' or 'WT Fed#… /Bnf=<NAME>': extract the entity name only.\n"
    "- For Zelle/Venmo: the recipient (or sender) IS the counterparty. The app name is not.\n"
    "- Drop trailing memos like 'For \"birthday Pizza ;)\"' — those are notes, not part of the name.\n"
    "- Strip middle initials when matching against existing contacts ('Romeo G Ugali' should match an existing 'Romeo Ugali').\n"
    "- Match semantically: 'PayPal' matches 'PayPal Inc.', 'Capital One' matches 'Capital One, NA' or 'Capital One Bank', 'AT&T' matches 'AT&T Inc'. Use match_existing_id only when confident it's the same entity. When uncertain, return null and let a new contact be created.\n"
    "- NEVER return the raw bank description as extracted_name. If you can't confidently extract a clean name (≤ 60 chars, no Card/auth codes), set has_counterparty=false so a human reviews it."
)

ASSISTANT_SYSTEM = (
    "You are Axiom, an AI accounting assistant embedded in an enterprise SaaS accounting product. "
    "You help accounting pros and business owners understand their books. "
    "Be direct and brief — voice replies are read aloud in real time.\n\n"
    "WHAT YOU CAN DO (never deny these capabilities):\n"
    "- Navigate the app: when the user says 'take me to X', 'open X', 'go to X', 'show me X', the app AUTO-navigates for them. NEVER say 'I can't navigate pages' — you can, and the router already handles it.\n"
    "- Filter/search: 'transactions for Walmart', 'filter by meals', 'overdue invoices' all apply URL filters automatically.\n"
    "- Read reports aloud: 'read my P&L', 'read my P&L vs last quarter' — you summarize and speak the numbers.\n"
    "- Create records by voice: 'create an invoice for John Doe for $500', 'new vendor Acme' — you open the modal prefilled and wait for 'confirm'.\n"
    "- Open specific records: 'open the July 15 McDonald's transaction', 'open contact Acme'.\n"
    "So when a user asks you to do any of those things, acknowledge it briefly (e.g. 'Opening reports') — don't lecture them on how to find it in menus.\n\n"
    "GROUNDING:\n"
    "- You receive a 'Context.books' block with revenue, expenses, net income, top expense categories, top vendors, recent transactions, flagged transactions, and A/R + A/P aging. USE THIS DATA when the user asks about their books. Do not say you don't have visibility — the context lists real numbers, top categories, and up to 10 recent + flagged rows.\n"
    "- When the user asks about a specific category ('what about meals'), scan Context.books.top_expense_categories and Context.books.recent_transactions for that category, and cite the actual $ amount and transaction count.\n"
    "- Context.books.anomalies contains data-entry pathologies detected on the balance sheet (negative liabilities, uncleared OBE, unbalanced BS, etc). When the user asks 'why is X negative', 'what's wrong', 'why doesn't this add up', or asks you to diagnose the books, LEAD with the specific anomaly (name the account and dollar amount) and give the professional accounting fix from the anomaly's explanation field. Do NOT give a generic answer if a matching anomaly exists.\n"
    "- If genuinely nothing matches in the context, say so briefly ('Nothing in Meals & Entertainment yet') and stop.\n\n"
    "STRICT RESPONSE RULES:\n"
    "1. Default reply is 1-3 short sentences. Never open with a greeting when responding to a follow-up. "
    "   Say 'Hi' only when the user greeted you first.\n"
    "2. Do NOT restate the user's question, describe the current company's state (e.g. transaction counts, "
    "   zero balances, accrual/cash basis) unless they specifically asked. That context is visible to them.\n"
    "3. If the user asks a yes/no question, lead with 'Yes' or 'No', then one sentence of reasoning, "
    "   then one optional sentence of GAAP/tax nuance. Stop.\n"
    "4. Do NOT list your own capabilities or offer a menu of options unless the user asked what you can do.\n"
    "5. Format numbers as US currency ($1,234.56). No emoji. No markdown headings. Bullet lists are okay "
    "   only when the user asks for a list.\n"
    "6. When a 'Context' block is provided with a focused transaction, ground the reply in it.\n"
    "7. Detailed analysis or explanations up to ~6 sentences are only when the user explicitly asks for "
    "   more depth ('explain more', 'walk me through', 'why', etc).\n\n"
    "ACT LIKE A BOOKKEEPER, NOT AN INFORMATION DESK:\n"
    "When a user describes a transaction (\"this is an internal transfer\", \"that's a personal charge\", "
    "\"this should be Meals\", \"all the 6278 transfers are distributions\"), you already know what to do — "
    "DO NOT tell them what phrase to type. Instead: state your understanding, propose the fix, and end with "
    "a plain-English yes/no question. When the user answers 'yes' / 'do it' / 'go ahead' / 'categorize it', "
    "the app executes the proposal automatically.\n"
    "\n"
    "PROPOSAL FORMAT — REQUIRED whenever you're offering to categorize / reclassify / mark-as-transfer:\n"
    "  1. Restate your understanding in ONE short sentence.\n"
    "  2. Ask ONE closing yes/no question naming the exact category and scope.\n"
    "  3. On its OWN LINE at the very end, emit a machine-readable proposal tag:\n"
    "     [[PROPOSAL:action=<action>|category=<Category Name>|scope=<focused|selected|contact:<name>>]]\n"
    "     Actions: `categorize` (recategorize one/many txns) or `transfer` (mark as internal transfer).\n"
    "     The user never sees this tag — the UI strips it and executes on 'yes'.\n"
    "\n"
    "EXAMPLES\n"
    "User: \"so this is an internal transfer between bank accounts\"\n"
    "You:  \"Got it — that's a bank-to-bank transfer, not revenue. Mark it as an internal transfer and find the matching leg?\\n[[PROPOSAL:action=transfer|scope=focused]]\"\n"
    "\n"
    "User: \"all the transfers to checking 6278 are owner distributions\"\n"
    "You:  \"Owner draws, then — not expenses. Bulk-recategorize all the 6278 transfers to Owner's Draw?\\n[[PROPOSAL:action=categorize|category=Owner's Draw|scope=selected]]\"\n"
    "\n"
    "User: \"this Starbucks is a client meeting\"\n"
    "You:  \"Client coffee — that's Meals & Entertainment. Book this one to Meals & Entertainment?\\n[[PROPOSAL:action=categorize|category=Meals & Entertainment|scope=focused]]\"\n"
    "\n"
    "NEVER say phrases like 'Say \"categorize this as X\"', 'Just tell me…', 'Say yes and I'll…' — the yes/no "
    "question itself is the confirmation. Do not instruct the user what verbatim command to speak."
)


def _new_chat(system: str, session_id: str, model_name: str = MODEL_NAME) -> LlmChat:
    return LlmChat(
        api_key=EMERGENT_LLM_KEY,
        session_id=session_id,
        system_message=system,
    ).with_model(MODEL_PROVIDER, model_name)


def _extract_json(text: str) -> dict | None:
    m = re.search(r"\{[\s\S]*\}", text)
    if not m:
        return None
    try:
        return json.loads(m.group(0))
    except Exception:
        return None


async def categorize_transaction(
    merchant: str, amount: float, description: str, coa: list[dict],
    pfc: dict | None = None,
) -> dict:
    """Return {account_code, confidence, reasoning}.

    `pfc` is Plaid's Personal Finance Category — when present it's a strong hint
    fed into the prompt: {"primary": str, "detailed": str, "confidence_level": str}.
    """
    coa_lines = "\n".join(f"- {a['code']} {a['name']} ({a['type']})" for a in coa)
    pfc_block = ""
    if pfc:
        pfc_lines = []
        if pfc.get("primary"):    pfc_lines.append(f"  Plaid PFC primary: {pfc['primary']}")
        if pfc.get("detailed"):   pfc_lines.append(f"  Plaid PFC detailed: {pfc['detailed']}")
        if pfc.get("confidence_level"): pfc_lines.append(f"  Plaid PFC confidence: {pfc['confidence_level']}")
        if pfc_lines:
            pfc_block = "\n" + "\n".join(pfc_lines)
    prompt = (
        f"Chart of Accounts:\n{coa_lines}\n\n"
        f"Transaction:\n"
        f"  Merchant: {merchant}\n"
        f"  Description: {description}\n"
        f"  Amount: {amount} (negative = money out, positive = money in)"
        f"{pfc_block}\n\n"
        f"Return the JSON now."
    )
    chat = _new_chat(CATEGORIZATION_SYSTEM, f"cat-{merchant}")
    text = ""
    try:
        async for ev in chat.stream_message(UserMessage(text=prompt)):
            if isinstance(ev, TextDelta):
                text += ev.content
            elif isinstance(ev, StreamDone):
                break
    except Exception as e:
        return {"account_code": "9999", "confidence": 0.3, "reasoning": f"AI unavailable: {e}"}
    data = _extract_json(text) or {}
    code = str(data.get("account_code", "9999"))
    try:
        conf = float(data.get("confidence", 0.5))
    except Exception:
        conf = 0.5
    reasoning = str(data.get("reasoning", "No reasoning provided."))[:400]
    return {"account_code": code, "confidence": max(0.0, min(1.0, conf)), "reasoning": reasoning}


async def resolve_contact_ai(
    description: str, existing_contacts: list[dict], pfc_primary: str | None = None,
) -> dict:
    """Extract counterparty from a bank description using Claude Haiku (cheap+fast).
    Returns {has_counterparty, extracted_name, match_existing_id, reason}.
    Applies junk-name guards before returning.
    """
    contact_list = "\n".join(f"- {c['id']} :: {c['name']}" for c in existing_contacts) or "(none)"
    pfc_line = f"\nPlaid PFC primary: {pfc_primary}\n" if pfc_primary else ""
    user_prompt = (
        f"Description: {description}{pfc_line}\n\n"
        f"Existing contacts in this org (id :: name):\n{contact_list}\n\n"
        f"Resolve this transaction's counterparty per the rules. Output strict JSON only."
    )
    # Stable hash so identical descriptions in the same batch share a
    # session_id — lets the LLM cache reuse anything reusable, and makes
    # debugging simpler (session id maps to a specific description string).
    sid = hashlib.md5(description.encode("utf-8"), usedforsecurity=False).hexdigest()[:12]
    chat = _new_chat(CONTACT_EXTRACTION_SYSTEM, f"contact-{sid}", model_name=MODEL_HAIKU)
    text = ""
    try:
        async for ev in chat.stream_message(UserMessage(text=user_prompt)):
            if isinstance(ev, TextDelta):
                text += ev.content
            elif isinstance(ev, StreamDone):
                break
    except Exception as e:
        return {"has_counterparty": False, "extracted_name": None,
                "match_existing_id": None, "reason": f"AI unavailable: {e}"}
    data = _extract_json(text) or {}
    result = {
        "has_counterparty": bool(data.get("has_counterparty", False)),
        "extracted_name": data.get("extracted_name"),
        "match_existing_id": data.get("match_existing_id"),
        "reason": str(data.get("reason", ""))[:200],
    }
    # Junk-name guards (mirror Rocketbooks)
    name = result["extracted_name"]
    if name:
        looks_junk = (
            len(name) > 60
            or bool(re.search(r"\bCard\s*\d{4,}", name, re.I))
            or bool(re.search(r"Recurring Payment authorized on", name, re.I))
            or bool(re.search(r"[\n\r]", name))
            or bool(re.search(r"\bConf#|\bTrn#|\bSrf#|\sID:", name))
            or bool(re.search(r"\sS\d{12,}", name))
        )
        if looks_junk:
            result["extracted_name"] = None
            result["match_existing_id"] = None
            result["has_counterparty"] = False
        # Backstop: name that essentially equals description
        elif len(name) >= 40:
            norm_n = re.sub(r"\s+", " ", name.lower()).strip()
            norm_d = re.sub(r"\s+", " ", description.lower()).strip()
            if norm_n == norm_d or norm_d in norm_n or norm_n in norm_d:
                result["extracted_name"] = None
                result["match_existing_id"] = None
                result["has_counterparty"] = False
    # If model returned an unknown id, discard
    if result["match_existing_id"]:
        known_ids = {c["id"] for c in existing_contacts}
        if result["match_existing_id"] not in known_ids:
            result["match_existing_id"] = None
    return result


TERSENESS_OVERLAYS = {
    "concise": (
        "\n\nTERSENESS OVERRIDE — CONCISE:\n"
        "- Reply in 1 sentence, ≤ 25 words. No preamble, no follow-up offers.\n"
        "- For yes/no questions: 'Yes.' or 'No.' followed by one short clause.\n"
        "- Skip ALL rationale unless the user asks 'why'."
    ),
    "balanced": "",  # use default ASSISTANT_SYSTEM rules unchanged
    "detailed": (
        "\n\nTERSENESS OVERRIDE — DETAILED:\n"
        "- The user wants thorough analysis. Multi-paragraph replies are welcome.\n"
        "- Include GAAP/tax nuance, edge cases, and worked examples.\n"
        "- 4-10 sentences is fine; add bullet lists when comparing options."
    ),
}


async def chat_stream(
    session_id: str, user_text: str, context: Optional[dict] = None,
    terseness: str = "balanced",
) -> AsyncGenerator[str, None]:
    prompt = user_text
    if context:
        prompt = f"Context (focused transaction):\n{json.dumps(context, indent=2)}\n\nUser: {user_text}"
    overlay = TERSENESS_OVERLAYS.get(terseness or "balanced", "")
    chat = _new_chat(ASSISTANT_SYSTEM + overlay, session_id)
    try:
        async for ev in chat.stream_message(UserMessage(text=prompt)):
            if isinstance(ev, TextDelta):
                yield ev.content
            elif isinstance(ev, StreamDone):
                break
    except Exception as e:
        yield f"[AI error: {e}]"


async def suggest_chart_of_accounts(
    business_type: str,
    description: str,
    existing_codes: Optional[list[str]] = None,
) -> list[dict]:
    """Ask Claude Sonnet to design an industry-tailored chart of accounts.

    Args:
        business_type: e.g. "SaaS", "Restaurant", "Construction", "eCommerce".
        description: free-text description of the business activities.
        existing_codes: list of account codes already on the books — the AI
            avoids re-suggesting these so we get pure additions.

    Returns: a JSON array of accounts, each:
        {"code": "5210", "name": "Merchant Processing Fees", "type": "expense",
         "subtype": "operating_expense", "rationale": "why this fits ..."}
    """
    existing_codes = existing_codes or []
    existing_hint = (
        f"\nThese codes already exist — DO NOT re-suggest them: {sorted(existing_codes)}"
        if existing_codes else ""
    )
    prompt = (
        f"Design an industry-tailored GAAP chart-of-accounts addition for a US small business.\n"
        f"Business type: {business_type}\n"
        f"Description: {description or '(none provided)'}\n"
        f"{existing_hint}\n\n"
        "Return 15-25 NEW industry-specific accounts that will meaningfully improve reporting "
        "clarity for this exact business — not generic filler.\n\n"
        "Rules:\n"
        "- Use standard AICPA-style numbering:\n"
        "    1xxx assets · 2xxx liabilities · 3xxx equity ·\n"
        "    4xxx revenue · 5xxx COGS · 6xxx-7xxx operating expenses · 8xxx-9xxx other\n"
        "- Prefer the 4-digit range (e.g. 4110, 5210, 6220).\n"
        "- Cover at least: revenue streams, direct COGS if applicable, key operating expenses,\n"
        "  industry-specific liabilities (deferred revenue for SaaS, tips payable for restaurants,\n"
        "  retainage for construction, sales tax nexus, gift-card liabilities, etc).\n"
        "- Each rationale is one short sentence explaining WHY this account matters for THIS business.\n\n"
        "Respond with ONLY a JSON array (no prose, no markdown fence). Each item:\n"
        '  {"code": "<4-digit>", "name": "<Title Case>", '
        '"type": "asset|liability|equity|revenue|cogs|expense", '
        '"subtype": "<one_word>", "rationale": "<one sentence>"}'
    )
    chat = _new_chat(
        "You are a CPA designing a GAAP chart of accounts tailored to a specific US business. "
        "You return ONLY a valid JSON array of account objects — no wrapper, no prose.",
        f"coa-{business_type}-{hashlib.md5((description or '').encode()).hexdigest()[:6]}",
    )
    text = ""
    try:
        async for ev in chat.stream_message(UserMessage(text=prompt)):
            if isinstance(ev, TextDelta):
                text += ev.content
            elif isinstance(ev, StreamDone):
                break
    except Exception:
        return []
    m = re.search(r"\[[\s\S]*\]", text)
    if not m:
        return []
    try:
        arr = json.loads(m.group(0))
    except Exception:
        return []
    out = []
    seen_codes = set(existing_codes)
    for x in arr:
        if not isinstance(x, dict) or "code" not in x or "name" not in x:
            continue
        code = str(x["code"]).strip()
        if not code or code in seen_codes:
            continue
        seen_codes.add(code)
        out.append({
            "code": code,
            "name": str(x["name"]).strip(),
            "type": (x.get("type") or "expense").strip().lower(),
            "subtype": (x.get("subtype") or "operating_expense").strip().lower(),
            "rationale": (x.get("rationale") or "").strip(),
        })
    return out


async def onboarding_interview_questions(
    business_type: str, description: str,
) -> list[dict]:
    """Ask Claude Sonnet to design 4-5 targeted onboarding questions that will
    sharpen the CoA and seed default rules for THIS specific business.

    Returns a list of `{id, question, answer_type, options?, why}` items.
    `answer_type` is one of: "yes_no", "multi_choice", "short_text".
    """
    prompt = (
        f"You are a CPA onboarding a new small business into an accounting system.\n"
        f"Business type: {business_type}\n"
        f"Description: {description or '(none provided)'}\n\n"
        "Design 4-5 short, targeted questions whose answers will let you (a) pick "
        "the RIGHT industry-specific accounts and (b) pre-configure common "
        "categorization rules for this business's likely bank feed.\n\n"
        "Rules:\n"
        "- Each question is answerable in under 5 seconds.\n"
        "- Prefer yes_no or 3-option multi_choice; only use short_text when unavoidable.\n"
        "- Skip anything that's already obvious from the business type/description.\n"
        "- Skip generic questions (business address, EIN, etc.).\n"
        "- Focus on: revenue streams, physical inventory, gift cards, subscription "
        "  billing, payment processors used, tips/gratuity handling, contractor "
        "  vs employee split, sales-tax nexus, retainage, etc — only what's relevant.\n"
        "- `why` field: one short sentence on what the answer affects.\n\n"
        "Respond with ONLY a JSON array (no wrapper, no markdown). Item shape:\n"
        '  {"id": "<snake_case>", "question": "<one sentence>", '
        '"answer_type": "yes_no" | "multi_choice" | "short_text", '
        '"options": ["opt1","opt2","opt3"] (only for multi_choice), '
        '"why": "<affects which CoA/rule>"}'
    )
    chat = _new_chat(
        "You are a CPA designing an onboarding interview. Return ONLY a JSON array.",
        f"interview-{business_type}-{hashlib.md5((description or '').encode()).hexdigest()[:6]}",
    )
    text = ""
    try:
        async for ev in chat.stream_message(UserMessage(text=prompt)):
            if isinstance(ev, TextDelta):
                text += ev.content
            elif isinstance(ev, StreamDone):
                break
    except Exception:
        return []
    m = re.search(r"\[[\s\S]*\]", text)
    if not m:
        return []
    try:
        arr = json.loads(m.group(0))
    except Exception:
        return []
    out = []
    for x in arr:
        if not isinstance(x, dict) or "question" not in x:
            continue
        qid = str(x.get("id") or f"q{len(out)+1}").strip()
        ans_type = (x.get("answer_type") or "short_text").strip().lower()
        if ans_type not in ("yes_no", "multi_choice", "short_text"):
            ans_type = "short_text"
        item = {
            "id": qid,
            "question": str(x["question"]).strip(),
            "answer_type": ans_type,
            "why": str(x.get("why") or "").strip(),
        }
        if ans_type == "multi_choice":
            opts = x.get("options") or []
            item["options"] = [str(o).strip() for o in opts if str(o).strip()]
            if len(item["options"]) < 2:
                continue  # bad multi-choice — drop
        out.append(item)
    return out[:6]  # hard cap so we never overwhelm the user


async def onboarding_interview_synthesize(
    business_type: str, description: str,
    answers: list[dict], existing_codes: list[str],
    existing_accounts: list[dict],
) -> dict:
    """Given interview answers, ask Claude to produce (a) refined CoA additions
    and (b) suggested categorization rules (merchant → account_code).

    Args:
        answers: list of `{id, question, answer}` from the frontend.
        existing_codes: codes already on the CoA (dedup for suggestions).
        existing_accounts: `[{code, name}]` — the AI must reference codes it
            actually knows exist when proposing rules. We pass BOTH existing
            and freshly-suggested accounts (post-merge) to keep the rules valid.

    Returns `{"accounts": [...], "rules": [{merchant, account_code, why}]}`.
    """
    qa_lines = "\n".join(
        f"- {a.get('question','?')}\n    answer: {a.get('answer','(no answer)')}"
        for a in (answers or [])
    ) or "(no answers)"

    coa_lines = "\n".join(
        f"  {a['code']}  {a['name']}  ({a.get('type','?')})"
        for a in existing_accounts[:120]
    )

    prompt = (
        f"Business type: {business_type}\n"
        f"Description: {description or '(none)'}\n\n"
        f"Onboarding interview answers:\n{qa_lines}\n\n"
        f"CURRENT chart of accounts (do NOT re-suggest these codes for the accounts array):\n"
        f"{coa_lines}\n\n"
        "Return ONLY a JSON object with two top-level keys, no prose:\n"
        '{\n'
        '  "accounts": [  // 5-15 items — new industry accounts refined by the answers above\n'
        '    {"code": "<4-digit>", "name": "<Title Case>",\n'
        '     "type": "asset|liability|equity|revenue|cogs|expense",\n'
        '     "subtype": "<one_word>", "rationale": "<one sentence>"}\n'
        '  ],\n'
        '  "rules": [    // 4-12 items — starter categorization rules\n'
        '    {"merchant": "<substring the bank feed will match>",\n'
        '     "account_code": "<code from CURRENT list OR from the accounts array above>",\n'
        '     "why": "<one sentence>"}\n'
        '  ]\n'
        '}\n\n'
        "Rules for the rules array:\n"
        "- Use realistic merchant substrings ('Stripe', 'Uber Eats', 'ADP', 'Shopify', 'Costco').\n"
        "- Only propose rules that clearly fit the interview answers (e.g. don't suggest a\n"
        "  gift-card rule if the business said no to gift cards).\n"
        "- account_code MUST reference either an existing account OR one you're proposing in\n"
        "  the accounts array above — never invent a code that appears in neither."
    )
    chat = _new_chat(
        "You are a CPA refining a chart of accounts + seeding categorization rules based on "
        "onboarding interview answers. Return ONLY a JSON object with keys 'accounts' and 'rules'.",
        f"synth-{business_type}-{hashlib.md5(str(answers).encode()).hexdigest()[:6]}",
    )
    text = ""
    try:
        async for ev in chat.stream_message(UserMessage(text=prompt)):
            if isinstance(ev, TextDelta):
                text += ev.content
            elif isinstance(ev, StreamDone):
                break
    except Exception:
        return {"accounts": [], "rules": []}

    m = re.search(r"\{[\s\S]*\}", text)
    if not m:
        return {"accounts": [], "rules": []}
    try:
        data = json.loads(m.group(0))
    except Exception:
        return {"accounts": [], "rules": []}

    # Normalize accounts
    existing_set = set(existing_codes)
    accts_out = []
    for x in (data.get("accounts") or []):
        if not isinstance(x, dict) or not x.get("code") or not x.get("name"):
            continue
        code = str(x["code"]).strip()
        if not code or code in existing_set:
            continue
        existing_set.add(code)
        accts_out.append({
            "code": code, "name": str(x["name"]).strip(),
            "type": (x.get("type") or "expense").strip().lower(),
            "subtype": (x.get("subtype") or "operating_expense").strip().lower(),
            "rationale": (x.get("rationale") or "").strip(),
        })

    # Normalize rules — reference either an existing account or a freshly-proposed one
    allowed_codes = {a["code"] for a in existing_accounts} | {a["code"] for a in accts_out}
    rules_out = []
    for x in (data.get("rules") or []):
        if not isinstance(x, dict):
            continue
        merch = str(x.get("merchant") or "").strip()
        code = str(x.get("account_code") or "").strip()
        if not merch or not code or code not in allowed_codes:
            continue
        # name & type for display convenience
        acct = next((a for a in existing_accounts + accts_out if a["code"] == code), None)
        rules_out.append({
            "merchant": merch, "account_code": code,
            "account_name": (acct or {}).get("name", ""),
            "why": str(x.get("why") or "").strip(),
        })

    return {"accounts": accts_out, "rules": rules_out}



# =========================================================================
#                        Voice-driven Intent Parser
# =========================================================================
# Given a raw natural-language utterance, extract a structured "create" or
# "open" intent. Runs on Claude Haiku (cheap + fast) with a strict JSON
# contract so the frontend can hydrate creation modals without a full LLM
# chat round-trip.

INTENT_SYSTEM = (
    "You are a voice-command intent parser for an accounting SaaS app. "
    "Given a spoken utterance, extract a structured JSON action.\n\n"
    "Output STRICT JSON with these keys:\n"
    "  intent: one of ['create_invoice','create_bill','create_contact','create_account',"
    "'create_payment','create_receipt','open_contact','open_invoice','open_bill','none']\n"
    "  confidence: float 0.0-1.0\n"
    "  prefill: object with fields specific to the intent (see below). MAY be empty.\n"
    "  say: a short one-sentence confirmation to read back to the user (max ~15 words).\n\n"
    "Field guides (only fill fields you can confidently extract):\n"
    "- create_invoice / create_bill: contact_name (string), amount (number, dollars), "
    "description (string), due_days (int, default 30 if 'net 30' etc mentioned).\n"
    "- create_contact: name (string), type ('customer'|'vendor'|'both'), email, phone.\n"
    "- create_account: name (string), type ('asset'|'liability'|'equity'|'revenue'|'cogs'|'expense'), code (string, optional).\n"
    "- open_contact / open_invoice / open_bill: name_or_number (string).\n\n"
    "Rules:\n"
    "1. If the user did not actually ask to create/open a business record, set intent='none' and confidence < 0.4.\n"
    "2. Extract only what the user actually said. Do NOT invent contacts, amounts, or dates.\n"
    "3. Contact names should be Title Cased and stripped of transaction-noise ('for John Doe' → 'John Doe').\n"
    "4. Amounts: '$500', 'five hundred dollars', '500 bucks' → 500.\n"
    "5. Never include markdown, prose, or code fences — ONLY the JSON object."
)


async def parse_voice_intent(text: str) -> dict:
    """Parse a voice/text utterance into a structured create/open intent.

    Returns:
      {"intent": str, "confidence": float, "prefill": dict, "say": str}
    On any error, returns {"intent": "none", "confidence": 0.0, ...} so the
    frontend can fall back to the normal chat stream.
    """
    if not text or not text.strip():
        return {"intent": "none", "confidence": 0.0, "prefill": {}, "say": ""}

    sid = hashlib.md5(text.encode("utf-8"), usedforsecurity=False).hexdigest()[:12]
    chat = _new_chat(INTENT_SYSTEM, f"intent-{sid}", model_name=MODEL_HAIKU)
    raw = ""
    try:
        async for ev in chat.stream_message(UserMessage(text=f"Utterance: {text!r}\n\nReturn the JSON now.")):
            if isinstance(ev, TextDelta):
                raw += ev.content
            elif isinstance(ev, StreamDone):
                break
    except Exception as e:
        return {"intent": "none", "confidence": 0.0, "prefill": {}, "say": f"AI unavailable: {e}"}

    data = _extract_json(raw) or {}
    intent = str(data.get("intent") or "none").strip()
    if intent not in {
        "create_invoice", "create_bill", "create_contact", "create_account",
        "create_payment", "create_receipt",
        "open_contact", "open_invoice", "open_bill", "none",
    }:
        intent = "none"
    try:
        conf = float(data.get("confidence", 0.5))
    except Exception:
        conf = 0.5
    prefill = data.get("prefill") if isinstance(data.get("prefill"), dict) else {}
    say = str(data.get("say") or "")[:200]
    return {
        "intent": intent,
        "confidence": max(0.0, min(1.0, conf)),
        "prefill": prefill,
        "say": say,
    }


CPA_REVIEWER_SYSTEM = (
    "You are a senior CPA reviewing a bookkeeper's answer to a categorization prompt. "
    "You have full context on the client's chart of accounts and the vendor being cleaned up. "
    "Your job is to classify the user's intent and, when they ARE giving a categorization, "
    "resolve their answer to real accounts (existing OR a new GAAP-compliant one) so the "
    "downstream code doesn't have to guess.\n\n"
    "OUTPUT: strict JSON only. Schema:\n"
    "{\n"
    "  \"intent\": \"categorize\" | \"approve_existing\" | \"redirect\" | \"skip\" | \"question\" | \"unclear\",\n"
    "  \"confidence\": 0.0-1.0,\n"
    "  \"reasoning\": \"one sentence — why this intent\",\n"
    "  \"say\": \"one short sentence to speak back to the user\",\n"
    "  \"resolution\": { ...intent-specific... }\n"
    "}\n\n"
    "INTENTS — pick the ONE that best fits:\n\n"
    "1. categorize — user is telling you what account(s) the transactions belong in.\n"
    "   Examples: 'these are all office supplies', 'meals', 'under $50 is Meals, above is Office Supplies',\n"
    "   'utilities except for the $150 that was actually a meal', 'aggressive Q4 marketing spend'.\n"
    "   Resolution:\n"
    "   {\n"
    "     \"buckets\": [\n"
    "       {\n"
    "         \"predicate\": { \"min\": number|null, \"max\": number|null, \"exactAmount\": number|null } | null,\n"
    "         \"label\": \"human-readable bucket name\",\n"
    "         \"account\": {\n"
    "           \"existing_account_id\": \"<uuid>\" | null,   // set if maps to an existing account\n"
    "           \"code\": \"6300\",\n"
    "           \"name\": \"Office Supplies\",\n"
    "           \"type\": \"expense\" | \"revenue\" | \"asset\" | \"liability\" | \"equity\",\n"
    "           \"gaap_rationale\": \"one sentence — why this account fits GAAP\"\n"
    "         }\n"
    "       }, ...\n"
    "     ]\n"
    "   }\n"
    "   ACCOUNT-RESOLUTION RULES:\n"
    "   • Prefer an EXISTING account from the provided chart. Use fuzzy matching — 'office supplies' matches\n"
    "     '6300 Office Supplies', 'meals' matches '6000 Meals', 'utilities' matches '6600 Utilities'.\n"
    "   • Only propose a NEW account when nothing in the chart reasonably fits. Follow GAAP code ranges:\n"
    "       - 1000-1999 = Assets, 2000-2999 = Liabilities, 3000-3999 = Equity,\n"
    "         4000-4999 = Revenue, 5000-5999 = COGS, 6000-9999 = Expenses.\n"
    "   • Name new accounts with STANDARD accounting terminology — never vendor-specific, never colloquial.\n"
    "     'Marketing - Q4 Campaign' is fine. 'Aggressive Marketing Spend' is NOT. 'they look good' is NEVER.\n"
    "   • If the user's phrasing looks like filler ('these are okay', 'looks fine', 'good'), that's NOT a\n"
    "     categorization — return intent=approve_existing instead.\n\n"
    "2. approve_existing — user is telling you to leave the transactions with their current categories\n"
    "   (just mark them reviewed). Examples: 'they look good the way they are', 'looks fine', 'these are ok',\n"
    "   'keep them as-is', 'accept the current categories', 'approve them all'.\n"
    "   Resolution: { \"note\": \"why user chose to approve existing\" }\n\n"
    "3. redirect — user wants to switch to a different contact. Examples: 'let's look at Healthy Paws',\n"
    "   'actually can we do AT&T first', 'jump to Amazon', 'show me Walmart instead'.\n"
    "   Resolution: { \"target_contact_name\": \"Healthy Paws\" }\n\n"
    "4. skip — user wants to defer this contact. Examples: 'skip', 'skip this', 'move on', 'next one',\n"
    "   'come back later', 'not now', 'pass'.\n"
    "   Resolution: {}\n\n"
    "5. question — user is asking you a question about the transactions, not categorizing them.\n"
    "   Examples: 'what should these usually be?', 'is this an expense or asset?', 'why are they flagged?'.\n"
    "   Resolution: {}   (the frontend will hand off to the normal chat stream)\n\n"
    "6. unclear — the message is genuinely ambiguous and you need to ask the user a clarifying question.\n"
    "   Resolution: { \"clarifying_question\": \"...\" }\n\n"
    "CRITICAL SAFEGUARDS:\n"
    "- NEVER create an account whose name contains filler phrases: 'they look', 'looks good', 'let's', 'ok',\n"
    "  'fine', 'yes', 'no', 'maybe', 'these are', 'this is', 'that was', 'we should', 'i think', 'like'.\n"
    "- NEVER return intent=categorize if the user's message is < 3 letters AND doesn't match a common\n"
    "  category shorthand ('rent', 'gas', 'food' are OK; 'ok', 'yes' are approve_existing / question).\n"
    "- When in doubt between categorize and approve_existing, prefer approve_existing — recategorizing\n"
    "  based on a bad interpretation is far more damaging than approving in place.\n"
    "- When in doubt between categorize and unclear, prefer unclear — a clarifying question is cheap."
)


async def cpa_review(
    user_message: str,
    contact_name: str,
    contact_id: str | None,
    accounts: list[dict],
    txn_sample: list[dict] | None = None,
    current_categories: list[dict] | None = None,
) -> dict:
    """LLM-backed CPA gate for cleanup-inquiry answers.

    Args:
      user_message: raw text the user typed / spoke back to the AI.
      contact_name: the vendor/contact under cleanup.
      contact_id: optional contact UUID for context.
      accounts: [{id, code, name, type, subtype}] — chart of accounts.
      txn_sample: optional [{amount, date, description}] — up to 5 recent txns.
      current_categories: optional [{code, name, count}] — what the rows are
        currently categorized as (used by approve_existing intent).

    Returns dict matching the CPA_REVIEWER_SYSTEM schema. On error, returns a
    conservative {"intent": "unclear", ...} so the caller falls back to a
    clarifying prompt (never to the regex parser).
    """
    if not user_message or not user_message.strip():
        return {
            "intent": "unclear",
            "confidence": 0.0,
            "reasoning": "empty message",
            "say": "I didn't catch that — could you say it again?",
            "resolution": {"clarifying_question": "Could you tell me what these transactions are?"},
        }

    # Compact the chart-of-accounts payload so the prompt stays lean.
    acct_lines = []
    for a in accounts[:200]:  # cap at 200 accounts to keep tokens sane
        acct_lines.append(f"  - id={a.get('id')} code={a.get('code','')} name={a.get('name','')} type={a.get('type','')}")
    acct_block = "\n".join(acct_lines) if acct_lines else "  (no accounts yet)"

    txn_lines = []
    for t in (txn_sample or [])[:5]:
        txn_lines.append(f"  - ${t.get('amount')} on {t.get('date','?')}: {t.get('description','')[:80]}")
    txn_block = "\n".join(txn_lines) if txn_lines else "  (no sample)"

    cat_lines = []
    for c in (current_categories or [])[:10]:
        cat_lines.append(f"  - {c.get('code','')} {c.get('name','')}: {c.get('count',0)} rows")
    cat_block = "\n".join(cat_lines) if cat_lines else "  (uncategorized)"

    user_prompt = (
        f"Contact under cleanup: {contact_name!r}\n"
        f"How rows are currently categorized:\n{cat_block}\n\n"
        f"Sample transactions:\n{txn_block}\n\n"
        f"Chart of accounts:\n{acct_block}\n\n"
        f"USER'S ANSWER (verbatim): {user_message!r}\n\n"
        "Classify the intent and return the strict JSON described in the system prompt."
    )

    sid = hashlib.md5(f"cpa-{contact_name}-{user_message}".encode("utf-8"), usedforsecurity=False).hexdigest()[:12]
    chat = _new_chat(CPA_REVIEWER_SYSTEM, f"cpa-review-{sid}", model_name=MODEL_NAME)
    raw = ""
    try:
        async for ev in chat.stream_message(UserMessage(text=user_prompt)):
            if isinstance(ev, TextDelta):
                raw += ev.content
            elif isinstance(ev, StreamDone):
                break
    except Exception as e:
        return {
            "intent": "unclear",
            "confidence": 0.0,
            "reasoning": f"CPA reviewer unavailable: {e}",
            "say": "I'm having trouble reviewing that — could you rephrase?",
            "resolution": {"clarifying_question": "Could you tell me what these transactions are?"},
        }

    data = _extract_json(raw) or {}
    intent = str(data.get("intent") or "unclear").strip()
    if intent not in {"categorize", "approve_existing", "redirect", "skip", "question", "unclear"}:
        intent = "unclear"
    try:
        conf = float(data.get("confidence", 0.5))
    except Exception:
        conf = 0.5

    # Server-side safety net: even if the LLM returned intent=categorize with
    # a filler-phrase account name, downgrade to approve_existing. We check
    # for names whose ENTIRE stripped content is filler (whole-name match), or
    # names that are absurdly short and lack any accounting vocabulary — this
    # avoids false positives like "fine dining meals" (contains "fine") or
    # legitimate short names like "IT" or "HR".
    resolution = data.get("resolution") if isinstance(data.get("resolution"), dict) else {}
    if intent == "categorize":
        buckets = resolution.get("buckets") if isinstance(resolution.get("buckets"), list) else []
        # Whole-name filler phrases (case-insensitive, exact match after
        # punctuation strip). Legitimate accounts never look like these.
        _whole_filler = {
            "they look good", "they look good the way they are",
            "looks good", "looks fine", "let's", "let us", "same",
            "okay", "ok", "fine", "yes", "no", "maybe", "these are",
            "this is", "that was", "we should", "i think", "good",
            "leave it", "keep it", "as is", "as-is", "approve", "accept",
            "they're fine", "these are fine", "all good", "sounds good",
            "same again", "same as before", "correct", "right",
        }
        for b in buckets:
            acct = b.get("account", {}) if isinstance(b, dict) else {}
            raw_name = str(acct.get("name") or "").strip()
            normalized = raw_name.lower().rstrip(".!?").strip()
            # Trigger downgrade only when the entire account name IS a filler
            # phrase, or when the name is empty/single-char.
            if normalized in _whole_filler or len(normalized) < 2:
                intent = "unclear"
                data["say"] = "That didn't sound like a category name — could you tell me which account these belong in?"
                resolution = {"clarifying_question": "Which account should these post to (e.g. Meals, Office Supplies, Utilities)?"}
                break

    return {
        "intent": intent,
        "confidence": max(0.0, min(1.0, conf)),
        "reasoning": str(data.get("reasoning") or "")[:300],
        "say": str(data.get("say") or "")[:280],
        "resolution": resolution,
    }



# ---------------------------------------------------------------------------
# Ask-client question drafter
# ---------------------------------------------------------------------------
# Given a cluster of flagged transactions from the same counterparty, ask
# Claude to draft ONE concise, friendly question the pro can send to the
# client. The question should reference the shared counterparty and the
# ambiguity (e.g. "several $12–$45 Amazon charges — business or personal?").
#
# Fails soft: on any error returns a sensible fallback string so the UI
# never blocks on this.
ASK_CLIENT_DRAFTER_SYSTEM = (
    "You are helping an accountant write a short, friendly, professional "
    "question to send to their small-business client about ambiguous "
    "transactions on the bank feed.\n\n"
    "Rules:\n"
    "- ONE question, 1-3 sentences max. No greeting or sign-off (the email "
    "template wraps that).\n"
    "- Reference the counterparty and the ambiguity concretely (e.g. amount "
    "range, count, common possibilities).\n"
    "- Never accuse or imply fraud. Assume good faith.\n"
    "- Never mention that you're an AI or that the accountant used AI.\n"
    "- Output STRICT JSON: {\"question\": \"...\"}."
)


async def draft_ask_client_question(
    *, counterparty: str, txns: list[dict], company_name: str = ""
) -> str:
    """Return a single question string for the pro to send. `txns` is a
    list of dicts with at least `date`, `amount`, `description` keys."""
    if not txns:
        return f"Can you tell us what these {counterparty} charges were for?"
    sample = txns[: min(6, len(txns))]
    total = round(sum(float(t.get("amount") or 0) for t in sample), 2)
    lines = "\n".join(
        f"- {t.get('date', '')}  ${float(t.get('amount', 0)):,.2f}  {t.get('description', '')[:80]}"
        for t in sample
    )
    prompt = (
        f"Client business: {company_name or 'the client'}\n"
        f"Counterparty on the bank feed: {counterparty}\n"
        f"{len(txns)} transaction(s) total (showing first {len(sample)}, "
        f"combined ${total:,.2f}):\n{lines}\n\n"
        "Draft the question."
    )
    try:
        chat = _new_chat(ASK_CLIENT_DRAFTER_SYSTEM, f"ask-client-drafter-{counterparty[:20]}")
        resp = await chat.send_message(UserMessage(text=prompt))
        raw = resp if isinstance(resp, str) else str(resp)
        data = _extract_json(raw)
        q = (data or {}).get("question")
        if isinstance(q, str) and q.strip():
            return q.strip()
    except Exception:
        pass
    # Deterministic fallback so the UI never blocks.
    if len(txns) == 1:
        return (
            f"What was the ${abs(float(txns[0].get('amount') or 0)):,.2f} "
            f"charge from {counterparty} on {txns[0].get('date', '')} for?"
        )
    return (
        f"We noticed {len(txns)} recent transactions from {counterparty} "
        f"totaling ${abs(total):,.2f}. Can you tell us what these were for so "
        f"we can categorize them correctly?"
    )


# ---------------------------------------------------------------------------
# Client-answer interpreter — closes the loop from ask-client → auto-categorize
# ---------------------------------------------------------------------------
# When a client answers a magic-link question, this parses their free-text
# response against the Chart of Accounts to propose a category the pro can
# accept with one click. Returns the same shape as `categorize_transaction`
# plus an `applies_to_all` flag so the caller can decide whether to apply
# the same category to every txn in the batch or hold for split-review.
ANSWER_INTERPRETER_SYSTEM = (
    "You are a US-GAAP bookkeeping AI. A small-business client just answered "
    "an accountant's question about one or more bank transactions. Your job "
    "is to turn their free-text answer into a categorization decision.\n\n"
    "Output STRICT JSON: {\n"
    "  \"account_code\": string,   // ONE code from the CoA below (choose the best fit)\n"
    "  \"confidence\": float,       // 0.0-1.0\n"
    "  \"reasoning\": string,       // one sentence explaining the choice\n"
    "  \"applies_to_all\": bool,    // true if the answer covers every listed txn uniformly\n"
    "  \"requires_split\": bool     // true only if the client explicitly says some are business, others personal\n"
    "}\n\n"
    "Rules:\n"
    "- If the client says 'personal / owner draw / not business' → the account is Owner Draws (equity).\n"
    "- If the client says 'payroll / employee / contractor payment' → Payroll Expense or Contractor Expense.\n"
    "- If the client says 'loan / paid myself back / member contribution' → the equity or liability account.\n"
    "- If the client says 'refund' → offset against the original expense category.\n"
    "- Confidence rules:\n"
    "  0.9+ : unambiguous mapping (e.g. \"office supplies\" → Office Expense).\n"
    "  0.7-0.89 : likely correct.\n"
    "  0.5-0.69 : reasonable guess.\n"
    "  <0.5 : answer is vague / unclear — pro must decide.\n"
    "- Never invent an account_code that isn't in the provided CoA."
)


async def interpret_client_answer(
    *, answer: str, txns: list[dict], coa: list[dict],
) -> dict:
    """Given the client's free-text answer + the batch of txns it applies to
    + the CoA, propose the best category. Fails soft — returns a low-
    confidence placeholder that the pro can still see and act on."""
    if not answer or not answer.strip():
        return {
            "account_code": "9999", "confidence": 0.0,
            "reasoning": "No answer text.", "applies_to_all": True,
            "requires_split": False,
        }
    coa_lines = "\n".join(f"- {a['code']} {a['name']} ({a.get('type', '')})" for a in coa)
    txn_lines = "\n".join(
        f"- {t.get('date', '')}  {float(t.get('amount', 0)):>10.2f}  {(t.get('description') or '')[:80]}"
        for t in txns[:12]
    )
    prompt = (
        f"Chart of Accounts:\n{coa_lines}\n\n"
        f"Transactions the client's answer covers ({len(txns)} total, showing first {min(12, len(txns))}):\n{txn_lines}\n\n"
        f"Client's answer (verbatim):\n\"\"\"{answer.strip()}\"\"\"\n\n"
        f"Return the JSON now."
    )
    try:
        chat = _new_chat(ANSWER_INTERPRETER_SYSTEM, f"answer-interp-{txns[0].get('id', 'x')[:8]}")
        resp = await chat.send_message(UserMessage(text=prompt))
        raw = resp if isinstance(resp, str) else str(resp)
    except Exception as e:
        return {
            "account_code": "9999", "confidence": 0.0,
            "reasoning": f"AI unavailable: {e}",
            "applies_to_all": True, "requires_split": False,
        }
    data = _extract_json(raw) or {}
    code = str(data.get("account_code") or "9999")
    # Guard: only allow codes that actually exist in the CoA.
    valid_codes = {a.get("code") for a in coa}
    if code not in valid_codes:
        code = "9999"
    try:
        conf = float(data.get("confidence", 0.5))
    except (TypeError, ValueError):
        conf = 0.5
    return {
        "account_code": code,
        "confidence": max(0.0, min(1.0, conf)),
        "reasoning": str(data.get("reasoning") or "")[:400],
        "applies_to_all": bool(data.get("applies_to_all", True)),
        "requires_split": bool(data.get("requires_split", False)),
    }



# ---------------------------------------------------------------------------
# Client-side chat for the ask-client magic-link page
# ---------------------------------------------------------------------------
# The client lands here from a batched ask-client email and chats with the
# AI in plain language. When the AI has enough to categorize, it emits a
# structured PLAN block — the frontend renders that as an interactive card
# with a green "Yes, categorize all N + create rule" button and a grey
# "No thanks" button (same UX as the internal 'Let's review' pane).
CLIENT_CHAT_SYSTEM = (
    "You are a bookkeeping assistant chatting with a small-business owner "
    "about specific bank transactions their accountant flagged.\n\n"
    "CONVERSATION STYLE:\n"
    "- Short. Colleague-tone. First person. No jargon.\n"
    "- Trust clear answers. If the client says 'office supplies', that IS "
    "the answer — do NOT invent hypothetical follow-ups. Only ask a follow-up "
    "if the answer is genuinely ambiguous or contradictory.\n"
    "- Max ONE clarifying follow-up total. After that, commit.\n"
    "- Never accuse. Never claim to be an AI.\n\n"
    "TWO WAYS TO FINISH — YOU choose based on how obvious the answer is:\n\n"
    "PATH A — Simple, obvious answer (fast path):\n"
    "  When the client's answer is clear-cut and the mapping is unambiguous "
    "  (e.g. 'office supplies' → Office Expense; 'my rent' → Rent Expense; "
    "  'personal' → Owner Draws), respond with a brief thank-you and emit:\n"
    "    [[DONE:{\"account_code\":\"7000\",\"account_name\":\"Office Expense\","
    "\"summary\":\"office supplies\",\"confidence\":0.95,\"create_rule\":true,"
    "\"rule_pattern\":\"COSTCO\"}]]\n"
    "  This will auto-apply everything — no button click needed.\n"
    "  USE FAST PATH WHEN: confidence >= 0.85, no split, single account, "
    "  the mapping wouldn't surprise the client.\n\n"
    "PATH B — Needs confirmation (plan card):\n"
    "  When it's a bigger judgment call — split business/personal, unusual "
    "  category, big money (>$1000), or the mapping might surprise them — "
    "  emit a plan for the client to approve. Prose lead-in with markdown, "
    "  then on new lines:\n"
    "    Here's the plan for **Costco**:\n"
    "    • **2** rows totaling **$825.10** → **Office Expense** (7000)\n"
    "    • Also create a rule so future Costco charges auto-categorize.\n"
    "    [[PLAN:{\"account_code\":\"7000\",\"account_name\":\"Office Expense\","
    "\"summary\":\"office supplies\",\"confidence\":0.85,\"create_rule\":true,"
    "\"rule_pattern\":\"COSTCO\"}]]\n"
    "  The frontend will render a green 'Yes, apply' / grey 'No thanks' card.\n\n"
    "COMMON JSON FIELDS (both markers):\n"
    "- account_code: one code from the CoA the caller supplies. Never invent.\n"
    "- account_name: exact name for that code.\n"
    "- summary: 3-8 word plain-English label.\n"
    "- confidence: 0.0-1.0.\n"
    "- create_rule: true if the counterparty is a repeat name (Costco, Zelle to Roberto). "
    "  false for one-off vendors, personal-use classifications, or Owner Draws.\n"
    "- rule_pattern: uppercase substring to match on future txns (only when create_rule=true).\n\n"
    "NEVER emit either marker on turn 1 — the client always answers first. "
    "If you're still uncertain after a follow-up, emit a PLAN with confidence <0.6 "
    "so the accountant makes the call — don't loop asking questions."
)


async def client_chat_reply(
    *, question: str, counterparty: str, company_name: str,
    txns: list[dict], history: list[dict], coa: list[dict] | None = None,
) -> str:
    """Return Claude's next message in the client-side chat.
    `history` is the ordered list of prior turns: [{role: 'ai'|'client', content: '...'}, ...]
    The caller is responsible for appending both the client's incoming
    message and the returned AI message to the transcript.
    """
    total = round(sum(float(t.get("amount") or 0) for t in txns), 2)
    txn_lines = "\n".join(
        f"- {t.get('date', '')}  ${float(t.get('amount', 0)):>10,.2f}  {(t.get('description') or '')[:80]}"
        for t in txns[:12]
    )
    coa_block = ""
    if coa:
        coa_lines = "\n".join(
            f"- {a.get('code', '')} {a.get('name', '')} ({a.get('type', '')})"
            for a in coa if a.get("type") in ("expense", "equity", "liability", "revenue")
        )
        coa_block = f"Chart of Accounts (pick account_code from THIS list only):\n{coa_lines}\n\n"
    header = (
        f"Business: {company_name or 'the client'}\n"
        f"Counterparty on the bank feed: {counterparty or 'multiple'}\n"
        f"Transactions in question ({len(txns)} total, ${abs(total):,.2f} combined, showing first "
        f"{min(12, len(txns))}):\n{txn_lines}\n\n"
        f"{coa_block}"
        f"Accountant's original question: {question}\n\n"
    )
    # Fold the history into the user turn so a single stateless Claude call
    # sees the full context. Cheaper than maintaining sessions and gives us
    # deterministic behavior on retry.
    convo = "\n".join(
        f"{'YOU' if m['role'] == 'ai' else 'CLIENT'}: {m['content']}"
        for m in history
    )
    prompt = header + "Conversation so far:\n" + (convo or "(none yet — the client just opened the link)") + "\n\nWrite your next message now."
    try:
        chat = _new_chat(CLIENT_CHAT_SYSTEM, f"client-chat-{txns[0].get('id', 'x')[:8]}")
        resp = await chat.send_message(UserMessage(text=prompt))
        return resp if isinstance(resp, str) else str(resp)
    except Exception as e:
        return (
            "Sorry — I'm having trouble reaching our AI right now. "
            "Please just type what you can and hit send; your accountant will pick it up. "
            f"({e.__class__.__name__})"
        )

