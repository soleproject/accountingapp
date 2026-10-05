"""Receipt policy — "does this bank transaction need a receipt?"

Shared by compliance_watcher (live), cleanup_scan (historical) and the
agent rollup. Never keys off chart-of-accounts names: signals are
Plaid PFC → bank descriptor tokens → cached merchant profile (LLM) →
cached account profile (LLM). Unknown → don't flag (under-ask).
"""
from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass

from db import db, now_iso

logger = logging.getLogger(__name__)

RECEIPT_FLOOR = 75.0

FLAG_LABELS = {
    "pos_retail": "In-store purchase — the receipt shows what was bought",
    "meals": "Meal — the receipt shows who, what and where",
    "fuel": "Fuel — keep the pump receipt",
    "parking_transport": "Parking or transportation — the receipt documents the trip",
    "supplies_equipment": "Supplies, materials or equipment — the receipt lists the items",
    "cash_withdrawal": "Cash withdrawal — receipts show what the cash paid for",
    "online_unknown_items": "Online order — the bank line doesn't say what was bought; forward the order confirmation",
    "in_person_other": "In-person purchase — a receipt would normally be issued",
}

# Plaid personal-finance categories.
_PFC_FLAG_PRIMARY = {"GENERAL_MERCHANDISE": "pos_retail", "FOOD_AND_DRINK": "meals", "HOME_IMPROVEMENT": "supplies_equipment"}
_PFC_FLAG_DETAILED = {
    "TRANSPORTATION_GAS": "fuel", "TRANSPORTATION_PARKING": "parking_transport", "TRANSPORTATION_TOLLS": "parking_transport",
    "TRANSPORTATION_TAXIS_AND_RIDE_SHARES": "parking_transport", "TRANSPORTATION_PUBLIC_TRANSIT": "parking_transport",
    "TRANSFER_OUT_WITHDRAWAL": "cash_withdrawal", "GENERAL_SERVICES_AUTOMOTIVE": "in_person_other",
    "GENERAL_MERCHANDISE_ONLINE_MARKETPLACES": "online",
    "FOOD_AND_DRINK_GROCERIES": "pos_retail", "MEDICAL_PHARMACIES_AND_SUPPLEMENTS": "pos_retail",
}
_PFC_SKIP_PRIMARY = {"LOAN_PAYMENTS", "TRANSFER_IN", "TRANSFER_OUT", "BANK_FEES", "RENT_AND_UTILITIES", "INCOME", "GOVERNMENT_AND_NON_PROFIT"}
_PFC_SKIP_DETAILED = {"GENERAL_SERVICES_INSURANCE", "ENTERTAINMENT_TV_AND_MOVIES", "ENTERTAINMENT_MUSIC_AND_AUDIO",
                      "GENERAL_SERVICES_ACCOUNTING_AND_FINANCIAL_PLANNING", "GENERAL_SERVICES_CONSULTING_AND_LEGAL",
                      "GENERAL_SERVICES_POSTAGE_AND_SHIPPING"}

# Standardized bank descriptor tokens (not user-named) that mark bills, transfers, payroll, taxes.
_P2P_RE = re.compile(r"\b(zelle|venmo|cash ?app|paypal|apple cash)\b", re.I)
_BILL_RE = re.compile(
    r"\b(recurring|bill ?pay(ment)?|autopay|auto ?pay|online pmt|mobile pmt|card payment|crcardpmt|"
    r"des:(ins|loan|mortgage|payroll|tax|prem)|ins\.? prem|mortgage|loan pmt|loan payment|eftps|usataxpymt|"
    r"irs\b|franchise tax|dept of revenue|payroll|direct dep|gusto|adp\b|paychex|service charge|overdraft|"
    r"interest charge|wire (out|transfer)|xfer|transfer to|subscription)\b", re.I)

MERCHANT_PROFILES = ["retail_store", "restaurant", "fuel", "parking_transport", "hardware_supplies", "online_marketplace",
                     "utility_telecom", "insurer", "lender", "saas_subscription", "government_tax", "payroll_provider",
                     "p2p_payment", "professional_service", "financial_institution", "unknown"]
_MERCHANT_FLAG = {"retail_store": "pos_retail", "restaurant": "meals", "fuel": "fuel", "parking_transport": "parking_transport",
                  "hardware_supplies": "supplies_equipment", "online_marketplace": "online"}
_MERCHANT_SKIP = {"utility_telecom", "insurer", "lender", "saas_subscription", "government_tax", "payroll_provider",
                  "p2p_payment", "professional_service", "financial_institution"}

ACCOUNT_PROFILES = ["point_of_sale", "recurring_bill", "financing", "payroll", "tax", "fees", "professional_services", "other"]


@dataclass
class Decision:
    flag: bool
    reason: str
    label: str = ""
    stage: str = "pre"   # pre = decided before merchant/account profiles were consulted


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9 ]+", " ", (s or "").lower()).strip()[:60]


def _is_documented(t: dict) -> bool:
    return bool(t.get("receipt_id") or t.get("matched_receipt_id") or t.get("veryfi_receipt_id")
                or t.get("linked_bill_id") or t.get("linked_invoice_id") or t.get("attachments"))


def _is_uncategorized(t: dict, acct: dict | None) -> bool:
    if not t.get("category_account_id") or not acct:
        return True
    name = _norm(acct.get("name"))
    return str(acct.get("code")) in ("6999", "9999", "4999") or "uncategorized" in name or "ask my accountant" in name


def evaluate(t: dict, acct: dict | None, merchant_profile: str, account_profile: str) -> Decision:
    amt = float(t.get("amount") or 0)
    if amt >= 0:
        return Decision(False, "not_outflow")
    if abs(amt) < RECEIPT_FLOOR:
        return Decision(False, "below_floor")
    if _is_documented(t):
        return Decision(False, "documented")
    if t.get("transfer_pair_id"):
        return Decision(False, "transfer")
    if _is_uncategorized(t, acct):
        return Decision(False, "uncategorized_first")
    if (acct or {}).get("type") not in ("expense", "cogs", "other_expense"):
        return Decision(False, "not_expense")
    text = f"{t.get('description') or ''} {t.get('original_description') or ''} {t.get('merchant') or ''}"
    if _P2P_RE.search(text) or t.get("pfc_detailed") == "TRANSFER_OUT_TRANSFER_OUT_FROM_APPS":
        return Decision(False, "p2p")
    if _BILL_RE.search(text):
        return Decision(False, "bank_descriptor_bill")
    pfc_p, pfc_d = t.get("pfc_primary") or "", t.get("pfc_detailed") or ""
    pos_account = account_profile == "point_of_sale"

    def _online() -> Decision:
        if pos_account:
            return Decision(True, "online_unknown_items", FLAG_LABELS["online_unknown_items"])
        return Decision(False, "online_documented_elsewhere")

    if pfc_d in _PFC_SKIP_DETAILED:
        return Decision(False, f"pfc:{pfc_d}")
    if pfc_d in _PFC_FLAG_DETAILED:
        r = _PFC_FLAG_DETAILED[pfc_d]
        return _online() if r == "online" else Decision(True, r, FLAG_LABELS[r])
    if pfc_p in _PFC_SKIP_PRIMARY:
        return Decision(False, f"pfc:{pfc_p}")
    if pfc_p in _PFC_FLAG_PRIMARY:
        r = _PFC_FLAG_PRIMARY[pfc_p]
        return Decision(True, r, FLAG_LABELS[r])
    if merchant_profile in _MERCHANT_SKIP:
        return Decision(False, f"merchant:{merchant_profile}", stage="merchant")
    if merchant_profile in _MERCHANT_FLAG:
        r = _MERCHANT_FLAG[merchant_profile]
        d = _online() if r == "online" else Decision(True, r, FLAG_LABELS[r])
        d.stage = "merchant"
        return d
    if pos_account:
        return Decision(True, "in_person_other", FLAG_LABELS["in_person_other"], stage="account")
    if account_profile in ACCOUNT_PROFILES and account_profile != "other":
        return Decision(False, f"account:{account_profile}", stage="account")
    return Decision(False, "unknown", stage="account")


# ----------------------------------------------------------------- LLM caches

async def _llm_json(system: str, prompt: str, feature: str, cid: str) -> dict:
    from llm_client import LlmChat, UserMessage
    chat = LlmChat(system_message=system, feature=feature, company_id=cid)
    raw = await chat.send_message(UserMessage(text=prompt))
    out: dict = {}
    dec = json.JSONDecoder()
    i = 0
    while True:
        j = (raw or "").find("{", i)
        if j < 0:
            break
        try:
            obj, end = dec.raw_decode(raw, j)
        except json.JSONDecodeError:
            i = j + 1
            continue
        if isinstance(obj, dict):
            out.update(obj)
        i = end
    return out


async def merchant_profiles(cid: str, merchants: list[str]) -> dict[str, str]:
    """Normalized merchant name → profile. Cached globally in merchant_receipt_profiles."""
    keys = {_norm(m): m for m in merchants if _norm(m)}
    out: dict[str, str] = {}
    async for d in db.merchant_receipt_profiles.find({"key": {"$in": list(keys)}}, {"key": 1, "profile": 1}):
        out[d["key"]] = d["profile"]
    missing = [keys[k] for k in keys if k not in out]
    if missing:
        try:
            res = await _llm_json(
                "You classify merchant names from bank transactions. Return ONLY ONE JSON object mapping every input name "
                f"to a profile: {{\"<name>\": \"<profile>\"}} using exactly one of {MERCHANT_PROFILES}. "
                "retail_store = physical stores (Target, Costco, Best Buy, Walmart); "
                "hardware_supplies = Home Depot/Lowe's/office & industrial supply; online_marketplace = Amazon/eBay/Etsy; "
                "saas_subscription = software/streaming/memberships; utility_telecom = power/water/phone/internet/TV service; "
                "p2p_payment = Zelle/Venmo/PayPal transfers; unknown when unsure.",
                json.dumps(missing[:150]), "receipt-policy-merchants", cid)
            docs = []
            for name in missing[:150]:
                p = res.get(name) if isinstance(res, dict) else None
                p = p if p in MERCHANT_PROFILES else "unknown"
                out[_norm(name)] = p
                docs.append({"key": _norm(name), "name": name, "profile": p, "source": "llm", "created_at": now_iso()})
            if docs:
                await db.merchant_receipt_profiles.insert_many(docs, ordered=False)
        except Exception:  # noqa: BLE001
            logger.exception("merchant profile classification failed")
    return out


async def account_profiles(cid: str, accounts: list[dict]) -> dict[str, str]:
    """account id → profile, cached on the account doc (receipt_profile / receipt_profile_name)."""
    out: dict[str, str] = {}
    stale = []
    for a in accounts:
        if a.get("receipt_profile") in ACCOUNT_PROFILES and a.get("receipt_profile_name") == a.get("name"):
            out[a["id"]] = a["receipt_profile"]
        else:
            stale.append(a)
    if stale:
        try:
            res = await _llm_json(
                "You classify expense accounts from a small-business chart of accounts by what kind of spending they hold. "
                f"Return ONLY JSON: {{\"<id>\": \"<profile>\"}} using exactly one of {ACCOUNT_PROFILES}. "
                "point_of_sale = anything bought in a store or at a counter: supplies, materials, job materials, office supplies, "
                "equipment, tools, small tools, meals, entertainment, fuel, auto/vehicle, parking, travel, repairs, shipping/postage, "
                "COGS purchases. ALWAYS point_of_sale for any account containing 'Supplies', 'Materials', 'Equipment' or 'Tools'. "
                "recurring_bill = rent, lease, utilities, phone, internet, insurance, subscriptions, software, dues, memberships. "
                "financing = loan/interest/mortgage. payroll = wages/salaries/benefits/contract labor. "
                "tax = taxes/licenses. fees = bank/merchant/processing fees. professional_services = legal, accounting, "
                "contractors, advertising agencies. other = depreciation, amortization, anything else.",
                json.dumps([{"id": a["id"], "code": a.get("code"), "name": a.get("name")} for a in stale[:200]]),
                "receipt-policy-accounts", cid)
            for a in stale[:200]:
                p = res.get(a["id"]) if isinstance(res, dict) else None
                p = p if p in ACCOUNT_PROFILES else "other"
                out[a["id"]] = p
                await db.accounts.update_one({"id": a["id"]}, {"$set": {"receipt_profile": p, "receipt_profile_name": a.get("name")}})
        except Exception:  # noqa: BLE001
            logger.exception("account profile classification failed")
    return out


async def decide(cid: str, txns: list[dict]) -> dict[str, Decision]:
    """Evaluate a batch of transactions → {txn_id: Decision}."""
    if not txns:
        return {}
    accts = {a["id"]: a async for a in db.accounts.find({"company_id": cid}, {"id": 1, "name": 1, "code": 1, "type": 1, "receipt_profile": 1, "receipt_profile_name": 1})}
    expense_accts = [a for a in accts.values() if a.get("type") in ("expense", "cogs", "other_expense")]
    aprof = await account_profiles(cid, expense_accts)
    out: dict[str, Decision] = {}
    pending: list[dict] = []
    for t in txns:
        acct = accts.get(t.get("category_account_id") or "")
        d = evaluate(t, acct, "unknown", aprof.get(t.get("category_account_id") or "", "other"))
        out[t["id"]] = d
        if d.stage != "pre":
            pending.append(t)
    # Only consult (and cache) merchant profiles for txns the cheap rules couldn't settle.
    mprof = await merchant_profiles(cid, [n for n in {_merchant_key(t) for t in pending} if n])
    for t in pending:
        acct = accts.get(t.get("category_account_id") or "")
        mp = mprof.get(_norm(_merchant_key(t)), "unknown")
        out[t["id"]] = evaluate(t, acct, mp, aprof.get(t.get("category_account_id") or "", "other"))
    return out


def _merchant_key(t: dict) -> str:
    return t.get("merchant") or t.get("contact_name") or t.get("description") or ""


def who_of(t: dict) -> str:
    return t.get("merchant") or t.get("contact_name") or t.get("description") or "this purchase"


def finding_text(t: dict, d: Decision) -> tuple[str, str]:
    who = who_of(t)
    return (f"Receipt needed · {who} · ${abs(float(t.get('amount') or 0)):,.2f}",
            f"{d.label} ({who}, {(t.get('date') or '')[:10]}). Snap a photo or upload it.")
