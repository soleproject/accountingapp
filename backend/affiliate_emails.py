"""Affiliate Sales Center emails: transactional trio on lead submit, Loop A
(prospect nurture) and Loop B (affiliate activation). All return (subject, html)."""
from __future__ import annotations

from email_templates import _wrap, escape, _qr_png_data_uri

_BTN = ('<a href="{href}" style="display:inline-block;background:#0f172a;color:#fff;padding:12px 22px;'
        'border-radius:999px;font-weight:600;font-size:14px;text-decoration:none;margin:6px 0 18px;">{label}</a>')
_BOX = ('<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:14px 16px;'
        'font-size:14px;line-height:1.55;margin:10px 0;">{body}</div>')
_P = '<p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:#1f2937;">{t}</p>'
_H = '<h2 style="margin:0 0 14px;font-size:22px;line-height:1.25;color:#0f172a;">{t}</h2>'
_SMALL = '<p style="margin:0 0 10px;font-size:13px;line-height:1.5;color:#64748b;">{t}</p>'


def _body(*parts: str, brand: str | None = None, footer: str | None = None) -> str:
    inner = '<div style="padding:28px 32px;max-width:640px;">' + "".join(parts)
    if footer:
        inner += f'<div style="font-size:12px;color:#94a3b8;border-top:1px solid #e2e8f0;padding-top:14px;margin-top:20px;">{footer}</div>'
    inner += "</div>"
    return _wrap(inner, brand_name=brand)


def p(t: str) -> str: return _P.format(t=t)
def h(t: str) -> str: return _H.format(t=t)
def small(t: str) -> str: return _SMALL.format(t=t)
def btn(label: str, href: str) -> str: return _BTN.format(label=escape(label), href=href)
def box(body: str) -> str: return _BOX.format(body=body)


def _nl(text: str) -> str:
    return escape(text).replace("\n", "<br>")


# ---------------------------------------------------------------- transactional
def prospect_confirmation(*, role: str, first_name: str, email: str, referrer: str | None,
                          signup_url: str, booking_url: str | None, brand: str | None,
                          firm_name: str | None) -> tuple[str, str]:
    via = f" {escape(referrer)} pointed you here —" if referrer else ""
    if role == "accounting_pro":
        subject = f"{first_name}, your walkthrough — pick a time"
        cta = btn("Pick a time for the walkthrough", booking_url) if booking_url else small("We'll email you within one business day to schedule it.")
        html = _body(
            h(f"Thanks, {escape(first_name)}."),
            p(f"You asked for a 20-minute walkthrough of SmartBooks for your practice.{via} Here's what we cover: the per-client AI review queue, the client Quick Check-in your clients answer from a text, and white-label setup (your logo, your domain)."),
            cta,
            p("Before the call we'll pre-load a sandbox firm with two sample clients so you can see real findings, not slides."),
            small(f"Prefer to poke around first? <a href=\"{signup_url}\">Start a sandbox firm</a> — no card."),
            brand=brand, footer=f"Sent because you requested a walkthrough at {escape(email)}.")
    elif role == "enterprise":
        subject = f"Got it, {first_name} — we'll call you"
        html = _body(
            h("Got it — we'll call you."),
            p(f"A SmartBooks specialist will call within one business day to talk through your entities.{via} If a particular time works better, just reply to this email."),
            p("What we'll ask: how many entities, which banks, who closes the books today. What you'll get: a portfolio structure mapped to your group and a 30-day pilot on two entities."),
            brand=brand, footer=f"Sent because you requested a call at {escape(email)}.")
    elif firm_name:
        subject = f"Sent to {firm_name}"
        html = _body(
            h(f"You're on {escape(firm_name)}'s list, {escape(first_name)}."),
            p(f"{escape(firm_name)} will reach out within one business day to set up your books. You can connect a bank now so they have something to look at — 90 seconds, read-only."),
            btn("Create my account", signup_url),
            brand=brand, footer=f"Sent because you asked {escape(firm_name)} about bookkeeping at {escape(email)}.")
    else:
        subject = f"You're in, {first_name} — finish setting up SmartBooks"
        html = _body(
            h(f"You're in, {escape(first_name)}."),
            p(f"{via.strip(' —') + '. ' if via else ''}One step left: create your login, then connect a bank (about 60 seconds). We import your recent transactions, auto-categorize what we're sure about, and text you when your first Quick Check-in is ready."),
            btn("Create my account", signup_url),
            p("<b>What happens next</b><br>1 · Create your login &amp; connect a bank<br>2 · We import and auto-categorize<br>3 · You answer 5–8 quick questions on your phone"),
            brand=brand, footer=f"Sent because you started a SmartBooks trial at {escape(email)}.")
    return subject, html


def affiliate_lead_notice(*, affiliate_first: str, lead_name: str, company: str | None, role_label: str,
                          variant: str, pipeline_url: str, suggested_text: str, is_first: bool) -> tuple[str, str]:
    subject = f"🎉 {lead_name}{' (' + company + ')' if company else ''} just came in from your link"
    what = {
        "Business owner": "we've sent them a login link and will nudge them to connect a bank (day 2) and share a case study (day 5).",
        "Accounting pro": "we've sent them a link to book a 20-minute walkthrough. You'll see it in your pipeline when they pick a time.",
        "Enterprise": "a SmartBooks specialist will call them within one business day. We'll update the pipeline after the call.",
    }.get(role_label, "we've sent them a confirmation.")
    html = _body(
        h("Your first referral." if is_first else "A new referral just came in."),
        p(f"<b>{escape(lead_name)}</b>{' · ' + escape(company) if company else ''} · {escape(role_label)} · via your <i>{escape(variant)}</i> link."),
        p(f"<b>What we'll do:</b> {what}"),
        p("<b>What you should do:</b> one text in about two days referencing whatever you talked about. Referrals that hear from the person who referred them convert at roughly twice the rate."),
        box(_nl(suggested_text)),
        btn("Open them in my pipeline", pipeline_url),
        small("You earn once they pay their first invoice. We'll email you when that happens."),
        footer="SmartBooks Affiliates")
    return subject, html


def admin_lead_notice(*, lead: dict, affiliate_name: str | None, admin_url: str, booking_url: str | None) -> tuple[str, str]:
    role = lead.get("role")
    label = {"accounting_pro": "Accounting pro", "enterprise": "Enterprise"}.get(role, "Business owner")
    subject = f"New {label.lower()} lead{(' via ' + affiliate_name) if affiliate_name else ''}: {lead.get('company_name') or lead.get('name')}"
    rows = "".join(
        f'<tr><td style="padding:4px 10px 4px 0;color:#64748b;">{k}</td><td style="padding:4px 0;">{escape(str(v))}</td></tr>'
        for k, v in [("Name", lead.get("name")), ("Email", lead.get("email")), ("Phone", lead.get("phone") or "—"),
                     ("Company", lead.get("company_name") or "—"), ("Role", label), ("Notes", lead.get("notes") or "—"),
                     ("Affiliate", affiliate_name or "direct"), ("Variant", lead.get("variant") or "—")] if v is not None)
    next_step = ("They were sent the booking link — follow up if no booking in 2 days." if (role == "accounting_pro" and booking_url)
                 else "They were told you'd reach out within one business day. Please call or email them." if role == "business_owner"
                 else "They were told someone will reach out within one business day. Please call.")
    html = _body(h(subject), f'<table style="font-size:14px;margin:0 0 14px;">{rows}</table>',
                 p(f"<b>Next step:</b> {next_step}"), btn("Open in Admin → Leads", admin_url))
    return subject, html


# ---------------------------------------------------------------- Loop A (prospects)
def loop_a(step: str, *, first_name: str, referrer: str | None, link: str, brand: str | None,
           unsubscribe_url: str, ctx: dict) -> tuple[str, str] | None:
    ref_line = small(f"— {escape(referrer)} pointed you here. Reply to this email and it goes to them.") if referrer else ""
    foot = f'You\'re getting this because you started with SmartBooks{" via " + escape(referrer) if referrer else ""}. <a href="{unsubscribe_url}">Unsubscribe</a> from tips.'
    fn = escape(first_name)
    if step == "a2_signup":
        return (f"{first_name} — your SmartBooks account is one click away", _body(
            h("Your account is waiting."),
            p(f"Hi {fn} — you asked for SmartBooks two days ago but didn't finish creating your login. It takes a minute, and nothing happens until you connect a bank."),
            btn("Finish creating my account", link), ref_line, brand=brand, footer=foot))
    if step == "a2_bank":
        return (f"{first_name} — 90 seconds to connect a bank (then we do the rest)", _body(
            h("The whole thing starts with one bank."),
            p(f"Hi {fn} — you created your SmartBooks account two days ago but haven't connected a bank yet, so there's nothing for the AI to work on."),
            p("Connecting takes about 90 seconds (Plaid, read-only). We pull your recent transactions, categorize what we're confident about, and send your first <b>Quick Check-in</b> to your phone — usually 5–8 questions."),
            btn("Connect a bank", link),
            small("Not sure which account? Start with the one you pay most bills from. You can add more later."),
            ref_line, brand=brand, footer=foot))
    if step == "a5_case":
        return ("How Jamie closed September in 11 minutes", _body(
            h("Eleven minutes. From her phone."),
            p(f"Hi {fn} — Jamie runs a landscaping company with two crews and a shoebox problem. Here's what her September looked like on SmartBooks:"),
            p("• 212 bank transactions imported. 194 auto-categorized.<br>• 18 questions in two Quick Check-ins — ‘Was this Home Depot run supplies or equipment?’ Tap, tap.<br>• 6 receipts snapped in the truck.<br>• Month closed on the 3rd. Her accountant reviewed it in 20 minutes."),
            p("She didn't open a laptop once."),
            btn("Pick up where I left off", link), ref_line, brand=brand, footer=foot))
    if step == "a9_checkin":
        who = escape(referrer) if referrer else "We"
        return (f"{who} asked us to check in" if referrer else "Still want this?", _body(
            p(f"Hi {fn},"),
            p(f"{escape(referrer) + ' mentioned you were' if referrer else 'You were'} thinking about getting the books sorted. Your account's been quiet — totally fine, just checking whether something got in the way."),
            p("Three things people usually tell us at this point:<br>• <b>“I don't have time.”</b> — Connecting a bank is 90 seconds; after that we only ask you questions.<br>• <b>“My accountant handles it.”</b> — Invite them free; they'll see everything.<br>• <b>“Not now.”</b> — Reply “later” and we'll pause until next quarter."),
            btn("Pick up where I left off", link), ref_line, brand=brand, footer=foot))
    if step == "a_trial3":
        return (f"{first_name}, your trial ends in 3 days — keep what you've built", _body(
            h("Three days left."),
            p(f"Hi {fn} — your SmartBooks trial ends {escape(ctx.get('trial_end_day') or 'in 3 days')}. You've connected {ctx.get('bank_count') or 'your'} bank account(s) and the books are in motion; adding a card keeps everything exactly as it is."),
            btn("Add a card", link),
            small("Plans start at $38/month. Change or cancel any time from Billing."), ref_line, brand=brand, footer=foot))
    if step == "a_trial1":
        return ("Last day of your SmartBooks trial", _body(
            h("Today's the last day."),
            p(f"Hi {fn} — your trial ends tomorrow. If SmartBooks isn't for you, no hard feelings and nothing is charged. If it is, add a card and nothing changes."),
            btn("Keep my books going", link), ref_line, brand=brand, footer=foot))
    if step == "a_lapsed7":
        return ("Come back for $19", _body(
            h("Your data's still here."),
            p(f"Hi {fn} — your SmartBooks trial lapsed a week ago. Everything you connected and answered is still there. If it was timing, come back on Core for $19/month for your first three months."),
            btn("Reactivate", link), ref_line, brand=brand, footer=foot))
    if step == "a2_pro":
        return ("What the 20-minute walkthrough covers", _body(
            h("What we'll show you (and what we won't)."),
            p(f"Hi {fn} — you asked for a walkthrough but haven't picked a time yet. Here's exactly what it is: a sandbox firm with two sample clients, the AI review queue with real findings, the client Quick Check-in, and white-label setup. No slides, no pricing dance — it's $349/firm + $15/client."),
            btn("Pick a time", link), ref_line, brand=brand, footer=foot))
    if step == "a5_pro":
        return ("SmartBooks vs QBO Accountant on a 30-client practice", _body(
            h("The 30-client math."),
            p(f"Hi {fn} — the question we get most from firms is cost, so here it is for 30 clients across tiers:"),
            p("• QBO Accountant: wholesale tiers, roughly $450–$1,800/month depending on mix, QuickBooks-branded.<br>• SmartBooks: $349 + 30 × $15 = <b>$799/month flat</b>, white-label, AI first pass, client check-ins included."),
            p("Above ~20 clients it's cheaper, and the per-client cost never jumps when a client needs more features."),
            btn("Book the walkthrough", link), ref_line, brand=brand, footer=foot))
    if step == "a3_ent":
        return ("Did we reach you?", _body(
            p(f"Hi {fn} — we tried to reach you about your group's books. If we missed each other, reply with a good time or two and we'll call then. If you've decided it's not for now, a one-line reply saves us both the chase."),
            ref_line, brand=brand, footer=foot))
    return None


# ---------------------------------------------------------------- Loop B (affiliates)
def loop_b(step: str, *, first_name: str, link: str, center_url: str, slug: str, ctx: dict) -> tuple[str, str] | None:
    fn = escape(first_name)
    code = f'<span style="font-family:monospace;background:#f1f5f9;padding:2px 6px;border-radius:4px;">{escape(link)}</span>'
    foot = f'SmartBooks Affiliates · <a href="{center_url}">Manage emails</a>'
    if step == "b0_welcome":
        qr = _qr_png_data_uri(link)
        qr_html = f'<img src="{qr}" alt="QR" width="140" height="140" style="display:block;margin:8px 0;"/>' if qr else ""
        return ("Your link is live — here are the first 3 people to text", _body(
            h(f"Welcome, {fn}. Let's get you your first referral this week."),
            p(f"Your link: {code} — it works for business owners, accountants and multi-entity groups (the page adapts). Add <b>?for=pro</b> for the accountant version."),
            qr_html,
            p("<b>Don't post it yet.</b> Affiliates who text three people they already know in the first 48 hours earn several times more in year one than those who start on social. So:"),
            p("1. Someone who's complained about their books or their bookkeeper.<br>2. Your own accountant (firm referrals pay $125/month each).<br>3. A trades or services owner with under 10 staff."),
            p("Here's the text — copy, change the name, send:"),
            box(f"Hey ___ — remember you said your books were a mess? I've started working with SmartBooks; it reads receipts and asks ~6 questions a week on your phone. Free trial, no card: {escape(link)}"),
            btn("Open my Sales Center", center_url),
            small("Tomorrow: a short note on who converts best. Reply to this email any time — it's a real inbox."), footer=foot))
    if step == "b1_whofirst":
        return ("Who converts (and who wastes your time)", _body(
            h("Who to talk to first."),
            p(f"Hi {fn} — one day in. Here's what the data says about who actually becomes a paying customer:"),
            p("<b>Converts:</b> owners who've already complained about their books · trades/services under 10 staff · brand-new LLCs · your own accountant.<br><b>Wastes your time:</b> anyone with an in-house finance person · people who ‘love’ their current setup · cold strangers on social (yet)."),
            p("The zero-pitch opener that works on everyone: <i>“Random question — who does your books, and do you like them?”</i>"),
            btn("See the full Toolkit", center_url + "?tab=toolkit"), footer=foot))
    if step == "b3_accountant":
        return ("The accountant play ($125/month per firm)", _body(
            h("One accountant = ten clients."),
            p(f"Hi {fn} — the single highest-value referral you can make is an accounting or bookkeeping firm. The Practice Partner plan is $349/month, and <b>you earn $125/month</b> for every firm you bring, for as long as they stay."),
            p("Start with your own accountant. The pitch is one question: <i>“What do you pay QuickBooks per client?”</i> Then: flat $349 for the firm, $15 a client, white-label, AI first pass, clients answer from a text."),
            p(f"Send them the accountant version of your link — it opens a walkthrough booking page: {escape(link)}?for=pro"),
            btn("Copy the accountant email", center_url + "?tab=toolkit"), footer=foot))
    if step == "b7_noclicks":
        return ("No clicks yet — send one text today?", _body(
            p(f"Hi {fn} — your link hasn't been clicked yet. That's normal for week one, and it's also the only thing that predicts whether this works for you."),
            p("One text. Today. Here's the lowest-effort version — it doesn't even pitch, it just asks:"),
            box("Random question — who does your books, and do you like them?"),
            p("Whatever they answer, you'll know whether to send the link."),
            btn("Open my Sales Center", center_url),
            small("Rather talk it through? Reply to this email and we'll find 15 minutes."), footer=foot))
    if step == "b14_noleads":
        return ("Two weeks in — want 15 minutes with us?", _body(
            p(f"Hi {fn} — two weeks in, {ctx.get('clicks', 0)} clicks and no sign-ups yet. Sometimes it's the audience, sometimes it's the message; either way it's fixable in a short call."),
            p("Reply to this email with a couple of times that work and we'll go through who you've talked to and what to say next. No pitch — we only earn when you do."),
            btn("Open my Sales Center", center_url), footer=foot))
    return None
