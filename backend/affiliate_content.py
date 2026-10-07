"""Affiliate Sales Center content + settings.

Defaults live here; superadmins can override any section via
``app_settings {key: "affiliate_toolkit"}`` / ``{key: "affiliate_settings"}``
without a deploy. ``render()`` fills merge fields like {first_name}.
"""
from __future__ import annotations

import re
from typing import Any

from db import db

TOOLKIT_KEY = "affiliate_toolkit"
SETTINGS_KEY = "affiliate_settings"

MERGE_FIELDS = [
    "first_name", "company", "my_link", "my_link_owner", "my_link_pro", "my_link_enterprise",
    "affiliate_name", "trial_end_day", "bank_count", "firm_name",
]

DEFAULT_SETTINGS: dict[str, Any] = {
    "walkthrough_booking_slug": "",          # /book/{slug} calendar for accounting-pro leads
    "admin_notify_emails": "",               # comma list; empty = all superadmins
    "owner_signup_cta": "Create my account",
    "program_share_pct": 20,                 # fallback % shown on /affiliates when no tier matches
}

DEFAULT_TOOLKIT: dict[str, Any] = {
    "pitches": [
        {
            "id": "owner_30s", "audience": "owner", "title": "30-second pitch · business owner",
            "body": (
                "You know how you end up with a shoebox of receipts and a panic in March? "
                "SmartBooks connects to your bank, reads your receipts, and asks you maybe six "
                "questions a week on your phone. The books close themselves. It's $38 to $149 a month "
                "depending on how much you want it to do, and your accountant can log in free. "
                "Want me to text you my link? There's a free trial, no card."
            ),
        },
        {
            "id": "pro_30s", "audience": "pro", "title": "30-second pitch · accountant / bookkeeper",
            "body": (
                "What do you pay QuickBooks per client? … Right. SmartBooks is $349 flat for the firm "
                "and $15 a client, white-label included — your logo, your domain. The AI does the first "
                "pass on every client and your clients answer questions in a 2-minute check-in on their "
                "phone instead of ignoring your emails. Give me 20 minutes to show you a sandbox firm."
            ),
        },
        {
            "id": "ent_30s", "audience": "enterprise", "title": "30-second pitch · multi-entity owner",
            "body": (
                "How many entities are you running? … And how do you see cash across all of them today? "
                "SmartBooks puts every entity in one portfolio — one login, one bill, consolidated cash "
                "and P&L — with AI doing the first pass on each set of books. I can get someone to call "
                "you tomorrow; it's a 15-minute conversation."
            ),
        },
        {
            "id": "elevator_10s", "audience": "owner", "title": "10-second version (hallway)",
            "body": (
                "It's bookkeeping software that does the bookkeeping. You connect a bank, it asks you "
                "a few questions a week, done. I'll text you the link."
            ),
        },
    ],
    "who_first": [
        {"title": "People who've complained about their books",
         "body": "“My bookkeeper is always behind”, “I hate QuickBooks”, “I do it in a spreadsheet”. They're pre-sold — you're just handing them the fix."},
        {"title": "Your own accountant",
         "body": "One firm = 10–50 clients downstream. A firm referral pays you $125/month on the $349 plan. Use the accountant link; offer to join the walkthrough."},
        {"title": "Trades & services under 10 staff",
         "body": "Plumbers, salons, landscapers, tutors, cleaners — bank-feed heavy, receipt heavy, nobody on staff doing finance. Strongest owner conversion."},
        {"title": "Anyone who just started a business",
         "body": "New LLCs have no system yet. Core at $38 is an easy yes, and they upgrade as they grow — you earn on every tier."},
        {"title": "Owners with 2+ companies",
         "body": "Rental LLC plus an operating business, franchisees, holding companies. The Portfolio view sells itself. Use the enterprise link."},
    ],
    "templates": [
        {"id": "sms_first_owner", "channel": "sms", "stage": "first_touch", "audience": "owner", "title": "SMS · first touch · owner",
         "body": "Hey {first_name} — remember you said your books were a mess? I've been using SmartBooks; it reads my receipts and I answer like 6 questions a week on my phone. Try it, free trial, no card: {my_link_owner}"},
        {"id": "sms_first_soft", "channel": "sms", "stage": "first_touch", "audience": "owner", "title": "SMS · first touch · zero-pitch opener",
         "body": "Random question — who does your books, and do you like them?"},
        {"id": "email_first_owner", "channel": "email", "stage": "first_touch", "audience": "owner", "title": "Email · first touch · owner",
         "subject": "The thing I mentioned for your books",
         "body": "Hi {first_name},\n\nYou mentioned the books were eating your Sundays. The thing I use is SmartBooks — it connects to the bank, reads receipts from a photo, and sends me a short check-in on my phone once a week with whatever it couldn't figure out. That's genuinely the whole workflow.\n\nFree trial, no card: {my_link_owner}\n\nIf you'd rather I walk you through it, I can do 10 minutes on a call.\n\n{affiliate_name}"},
        {"id": "sms_first_pro", "channel": "sms", "stage": "first_touch", "audience": "pro", "title": "SMS · first touch · accountant",
         "body": "Hi {first_name} — quick one. What are you paying QBO per client these days? There's a flat-fee alternative ($349/firm + $15/client, white-label) with AI first-pass categorization I think you'd want to see. 20-min walkthrough? {my_link_pro}"},
        {"id": "email_first_pro", "channel": "email", "stage": "first_touch", "audience": "pro", "title": "Email · first touch · accountant",
         "subject": "$15/client instead of QBO tiers",
         "body": "Hi {first_name},\n\nI know you're on QuickBooks Online Accountant. SmartBooks is $349/month flat for the firm plus $15 per client — white-label included (your logo, your domain), AI does first-pass categorization on every client, and clients answer open questions in a 2-minute check-in on their phone instead of ignoring your emails.\n\nThe math flips in your favour at about 20 clients. Would a 20-minute walkthrough be worth it? Book here and they'll pre-load a sandbox firm with sample clients: {my_link_pro}\n\n{affiliate_name}"},
        {"id": "sms_followup", "channel": "sms", "stage": "follow_up", "audience": "owner", "title": "SMS · follow-up · no reply after 3 days",
         "body": "Hey {first_name}, no pressure on the SmartBooks thing — just didn't want it to get buried. Honest question: what's the one thing about your books you'd pay to never do again?"},
        {"id": "email_followup_pro", "channel": "email", "stage": "follow_up", "audience": "pro", "title": "Email · follow-up · accountant after walkthrough",
         "subject": "After the walkthrough — the QBO comparison",
         "body": "Hi {first_name},\n\nThanks for taking the walkthrough. The one-pager comparing SmartBooks to QBO Accountant on a 30-client practice is attached in the link below — total cost, white-label, and what the client check-in replaces.\n\nIf it's useful, the next step is a sandbox firm with two of your real (anonymised) clients so you can see the AI findings on your own data. Say the word and I'll get it set up.\n\n{affiliate_name}"},
        {"id": "sms_trial_ending", "channel": "sms", "stage": "trial_ending", "audience": "owner", "title": "SMS · trial ending",
         "body": "{first_name}, your SmartBooks trial ends {trial_end_day}. You've already got {bank_count} bank(s) connected — adding a card keeps everything you've done. Anything holding you back? Happy to jump on a call."},
        {"id": "sms_signed_up_no_bank", "channel": "sms", "stage": "signed_up", "audience": "owner", "title": "SMS · signed up but no bank yet",
         "body": "Saw you got set up on SmartBooks 👍 Did the bank connection go through? That's the step that makes it click — 90 seconds, read-only. Shout if it fights you."},
        {"id": "email_intro_ask", "channel": "email", "stage": "ask_intro", "audience": "owner", "title": "Email · ask a paying customer for an intro",
         "subject": "One favour",
         "body": "Hi {first_name} — glad SmartBooks is working for {company}.\n\nWho's one owner you know who still hates their books? If you forward them this link they get a free trial and I'll owe you a coffee: {my_link_owner}\n\n{affiliate_name}"},
        {"id": "sms_winback", "channel": "sms", "stage": "win_back", "audience": "owner", "title": "SMS · win-back · canceled 90 days ago",
         "body": "Hey {first_name} — it's been a few months since you tried SmartBooks. A lot changed (the phone check-in especially). If the timing's better now, your old data is still there: {my_link_owner}"},
    ],
    "objections": [
        {"q": "“I already have QuickBooks.”",
         "a": "Keep it if you love it. Most people don't love it — they tolerate it. SmartBooks imports your QBO chart of accounts and history in one click, so you can run both for a month and compare. The difference is who does the work: QuickBooks waits for you; SmartBooks asks you."},
        {"q": "“My accountant does my books.”",
         "a": "Perfect — invite them, it's free for them. Your accountant still reviews everything, they just stop doing data entry and chasing you for answers. Most accountants are relieved. If yours isn't, I'd ask why they want you dependent on them for categorizing a Home Depot receipt."},
        {"q": "“I don't trust AI with my money.”",
         "a": "It never moves money — it's read-only on the bank. All it does is suggest categories and ask you when it isn't sure, and every suggestion shows its confidence and why. You or your accountant approve. It's the same as a junior bookkeeper, except it shows its work."},
        {"q": "“$99 a month is a lot.”",
         "a": "Compared to what — the $0 you spend doing it yourself at 11pm, or the $300–600/month a bookkeeper charges? Start on Core at $38; it's bank feed, receipts and reconciliation. Upgrade when you want the AI doing more. Most people's time is worth more than $1.30 a day."},
        {"q": "“I'm too small for this.”",
         "a": "Small is exactly who it's for. Big companies have a finance team. You have a phone. If you have a business bank account and more than ten transactions a month, it pays for itself the first time you don't have to rebuild a year in March."},
        {"q": "“I'll look at it later / after tax season.”",
         "a": "Totally fair. The thing is, 'later' is when you'll be rebuilding the months you skipped. Connect the bank now and let it pull history in the background — you don't have to touch it until you're ready. Takes 90 seconds."},
        {"q": "(Accountant) “My clients will never use an app.”",
         "a": "They don't need to — it's a text with a link. They tap Yes / No / take a photo. We see about 70% of check-ins answered within 48 hours, versus email threads that die. And the clients who won't do even that? Now you have a record that you asked."},
        {"q": "(Accountant) “I don't want to migrate 30 clients.”",
         "a": "Don't. Start with the two clients who annoy you most — the ones who never answer email. QBO import is one click per client. If it works for them, move the rest at your pace; the flat fee doesn't care how many you've moved."},
        {"q": "(Accountant) “What about white-label — my clients know me, not you.”",
         "a": "That's the point. Your logo, your colours, your domain, your name on every email. Your clients never see SmartBooks. The Practice Partner plan includes it."},
        {"q": "“Is my data safe?”",
         "a": "Bank connections are read-only via Plaid — the same rails your bank's own app uses. Data is encrypted in transit and at rest, we never sell it, and you can export or delete everything any time."},
    ],
    "social": [
        {"title": "LinkedIn · story post",
         "body": "I used to lose two Sundays a month to bookkeeping.\n\nNow I connect a bank, snap a receipt when I remember, and once a week my phone asks me 5–6 questions: “Was this $240 at Costco supplies or personal?” Tap. Done.\n\nThe month closes itself. My accountant logs in and says “looks fine.”\n\nIt's called SmartBooks. If your books are a shoebox, here's a free trial (no card): {my_link_owner}"},
        {"title": "LinkedIn · for accountants",
         "body": "Accountants: what's your real QBO bill across all clients?\n\nI've been looking at SmartBooks — $349/mo flat for the firm, $15/client, white-label included, AI does first-pass categorization and your clients answer questions from a text instead of your email.\n\nThe math flips at ~20 clients. Walkthrough link if you want to see a sandbox firm: {my_link_pro}"},
        {"title": "Instagram / Facebook · short",
         "body": "Small business owners: stop doing your books at 11pm. This reads your receipts and asks you a few questions a week on your phone. Free trial, no card 👉 {my_link_owner}"},
    ],
    "faq": [
        {"q": "Do I need to be a SmartBooks customer?",
         "a": "No. Affiliates get a free Sales Center login. If you later want your own books on SmartBooks, Upgrade converts your account and keeps your link and earnings."},
        {"q": "How long does attribution last?",
         "a": "Forever for anyone who signs up through your link. Earnings accrue on every invoice they pay, first month and every renewal, for as long as they stay a customer."},
        {"q": "When do I get paid?",
         "a": "Payouts run monthly for everything that accrued the previous month once the referral's invoice has settled. The Payouts tab shows accrued vs paid."},
        {"q": "Can I refer my own accountant?",
         "a": "Yes — that's one of the best referrals you can make. Firm plans pay $125/month to you and bring their clients with them."},
        {"q": "What if a referral cancels?",
         "a": "Earnings stop when they stop paying, and resume if they come back. No clawbacks on invoices already paid."},
    ],
}

# Fixed per-invoice payout tiers, mirrored from stripe_billing._PAYOUT_TIERS for the public page.
PAYOUT_TABLE = [
    {"plan": "Core", "audience": "Business", "price_cents": 3800, "payout_cents": 700},
    {"plan": "AI Assistant", "audience": "Business", "price_cents": 7900, "payout_cents": 1500},
    {"plan": "AI Bookkeeper", "audience": "Business", "price_cents": 9500, "payout_cents": 2000},
    {"plan": "Advanced", "audience": "Business", "price_cents": 14900, "payout_cents": 3000},
    {"plan": "Practice Partner", "audience": "Accounting firm", "price_cents": 34900, "payout_cents": 12500},
]


async def _overrides(key: str) -> dict:
    doc = await db.app_settings.find_one({"key": key}, {"_id": 0, "value": 1})
    return (doc or {}).get("value") or {}


async def get_settings() -> dict:
    return {**DEFAULT_SETTINGS, **(await _overrides(SETTINGS_KEY))}


async def get_toolkit() -> dict:
    ov = await _overrides(TOOLKIT_KEY)
    return {k: ov.get(k, v) for k, v in DEFAULT_TOOLKIT.items()}


async def save_override(key: str, value: dict, by: str | None) -> None:
    from datetime import datetime, timezone
    await db.app_settings.update_one(
        {"key": key},
        {"$set": {"key": key, "value": value, "updated_at": datetime.now(timezone.utc).isoformat(), "updated_by": by}},
        upsert=True,
    )


_FIELD_RE = re.compile(r"\{([a-z_]+)\}")


def render(text: str, ctx: dict[str, Any]) -> str:
    """Fill {merge_fields}; unknown fields are left as-is so the user sees what's missing."""
    def sub(m: re.Match) -> str:
        v = ctx.get(m.group(1))
        return str(v) if v not in (None, "") else m.group(0)
    return _FIELD_RE.sub(sub, text or "")


def link_variants(base_link: str) -> dict[str, str]:
    sep = "&" if "?" in base_link else "?"
    return {
        "my_link": base_link,
        "my_link_owner": f"{base_link}{sep}for=owner",
        "my_link_pro": f"{base_link}{sep}for=pro",
        "my_link_enterprise": f"{base_link}{sep}for=enterprise",
    }
