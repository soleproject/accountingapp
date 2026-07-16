"""AI service: categorization + chat via Claude Sonnet 4.5 (emergentintegrations)."""
from __future__ import annotations
import os
import json
import re
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
    "You are concise, precise, and reference GAAP where relevant. "
    "When the user's message includes a 'Context' block with a focused transaction, ground your reply in that transaction. "
    "Format numbers as US currency. Avoid emoji. Keep replies under 6 sentences unless deep analysis is requested."
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
    chat = _new_chat(CONTACT_EXTRACTION_SYSTEM, f"contact-{hash(description)}", model_name=MODEL_HAIKU)
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


async def chat_stream(
    session_id: str, user_text: str, context: Optional[dict] = None
) -> AsyncGenerator[str, None]:
    prompt = user_text
    if context:
        prompt = f"Context (focused transaction):\n{json.dumps(context, indent=2)}\n\nUser: {user_text}"
    chat = _new_chat(ASSISTANT_SYSTEM, session_id)
    try:
        async for ev in chat.stream_message(UserMessage(text=prompt)):
            if isinstance(ev, TextDelta):
                yield ev.content
            elif isinstance(ev, StreamDone):
                break
    except Exception as e:
        yield f"[AI error: {e}]"


async def suggest_chart_of_accounts(business_type: str, description: str) -> list[dict]:
    """Ask AI to suggest additional industry-specific accounts on top of defaults."""
    prompt = (
        f"For a US small business of type: {business_type}\n"
        f"Description: {description}\n\n"
        "Suggest 4-8 ADDITIONAL industry-specific GAAP accounts (beyond a standard baseline) "
        "as a JSON array. Each item: {\"code\": \"6xxx or 4xxx\", \"name\": \"Account Name\", "
        "\"type\": \"asset|liability|equity|revenue|expense\", \"subtype\": \"operating_expense|...\"}. "
        "Return ONLY the JSON array."
    )
    chat = _new_chat(
        "You are a CPA designing a GAAP chart of accounts. Return ONLY valid JSON array.",
        f"coa-{business_type}",
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
        return [x for x in arr if isinstance(x, dict) and "code" in x and "name" in x]
    except Exception:
        return []
