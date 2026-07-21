"""HTML email templates.

Every template is a plain function that returns `(subject, html_body)`.
Style is inline (deliverability-safe) and uses the same slate/cyan palette
as the app so branded emails feel continuous with the dashboard.

No preview text hacks, no dark-mode workarounds — keep it simple and
render-consistent across Gmail / Outlook / Apple Mail.
"""
from __future__ import annotations

from typing import Optional

_WRAP_OPEN = """
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
       style="background:#f8fafc;padding:32px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <tr><td align="center">
    <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0"
           style="background:#ffffff;border-radius:12px;padding:36px;border:1px solid #e2e8f0;">
"""

_WRAP_CLOSE = """
    </table>
    <div style="max-width:560px;margin:16px auto 0;color:#94a3b8;font-size:11px;line-height:1.5;text-align:center;">
      Sent by Axiom Ledger · <span style="font-family:monospace;">accountingapp.ai</span>
    </div>
  </td></tr>
</table>
"""

_H1 = "font-size:22px;font-weight:700;color:#0f172a;padding-bottom:8px;"
_P  = "font-size:14px;color:#334155;line-height:1.6;padding:8px 0;"
_MUTE = "font-size:12px;color:#64748b;line-height:1.5;padding-top:24px;"
_BTN = (
    "display:inline-block;padding:10px 18px;background:#0e7490;color:#ffffff;"
    "border-radius:8px;text-decoration:none;font-weight:600;font-size:14px;"
    "margin:8px 0 4px;"
)
_TABLE_KEY = "font-size:13px;color:#64748b;padding:4px 12px 4px 0;white-space:nowrap;"
_TABLE_VAL = "font-size:13px;color:#0f172a;padding:4px 0;font-weight:500;"


def _wrap(inner: str) -> str:
    return f"{_WRAP_OPEN}<tr><td>{inner}</td></tr>{_WRAP_CLOSE}"


# --------------------------------------------------------------------------
# 1c. AI Ask-client — fully-automated, ONE focused transaction per email.
# Sent by the hourly scheduler (see ai_ask_client_scheduler.py). Tone is
# on behalf of the accountant ("your accountant") but attributes the
# question to the AI so the client understands the workflow.
# --------------------------------------------------------------------------
def ai_ask_client(*, pro_name: str, company_name: str, txn: dict, question: str, magic_url: str) -> tuple[str, str]:
    date = txn.get("date") or ""
    desc = txn.get("description") or "(no description)"
    amt = float(txn.get("amount") or 0)
    amt_str = f"${abs(amt):,.2f}" + (" out" if amt < 0 else " in")
    from_line = (
        f"{escape(pro_name)}'s AI assistant is helping keep your books for "
        f"<b>{escape(company_name)}</b> on track, and needs a hand identifying "
        f"this recent transaction:"
    )
    inner = f"""
      <div style="{_H1}">Quick question about a transaction</div>
      <div style="{_P}">{from_line}</div>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0"
             style="margin:12px 0 8px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:14px 18px;width:100%;">
        <tr><td style="{_TABLE_KEY}">Date</td><td style="{_TABLE_VAL}">{escape(date)}</td></tr>
        <tr><td style="{_TABLE_KEY}">Description</td><td style="{_TABLE_VAL}">{escape(desc)}</td></tr>
        <tr><td style="{_TABLE_KEY}">Amount</td><td style="{_TABLE_VAL}">{escape(amt_str)}</td></tr>
      </table>
      <div style="{_P}">{escape(question)}</div>
      <div style="padding:16px 0 8px;">
        <a href="{magic_url}" style="{_BTN}">Chat with our AI →</a>
      </div>
      <div style="{_MUTE}">
        Takes ~30 seconds. Once you're done, the AI will offer to walk you
        through any other transactions that still need clarifying — one at a
        time, only if you have a moment.
      </div>
    """
    return f"Quick question — {desc[:40]}", _wrap(inner)


# --------------------------------------------------------------------------
# 1. Ask-client-about-a-transaction (Pro-initiated)
# --------------------------------------------------------------------------
def ask_client(*, pro_name: str, company_name: str, txn: dict, question: str, magic_url: str) -> tuple[str, str]:
    date = txn.get("date") or ""
    desc = txn.get("description") or "(no description)"
    amt = txn.get("amount") or 0
    amt_str = f"${abs(amt):,.2f}" + (" out" if amt < 0 else " in")
    inner = f"""
      <div style="{_H1}">Quick question about a transaction</div>
      <div style="{_P}">
        {escape(pro_name)} is reviewing your books for <b>{escape(company_name)}</b>
        and needs a hand identifying this one:
      </div>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0"
             style="margin:12px 0 8px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:14px 18px;width:100%;">
        <tr><td style="{_TABLE_KEY}">Date</td><td style="{_TABLE_VAL}">{escape(date)}</td></tr>
        <tr><td style="{_TABLE_KEY}">Description</td><td style="{_TABLE_VAL}">{escape(desc)}</td></tr>
        <tr><td style="{_TABLE_KEY}">Amount</td><td style="{_TABLE_VAL}">{escape(amt_str)}</td></tr>
      </table>
      <div style="{_P}"><b>{escape(pro_name)} asks:</b><br>{escape(question)}</div>
      <div style="padding:16px 0 8px;">
        <a href="{magic_url}" style="{_BTN}">Chat with our AI →</a>
      </div>
      <div style="{_MUTE}">
        This link is private to you and stays valid for 30 days. Our AI will
        walk you through it — you can just type like you're texting a friend.
      </div>
    """
    return f"Quick question — {desc[:40]}", _wrap(inner)


# --------------------------------------------------------------------------
# 1b. Ask-client — BATCHED (one email covering multiple txns from same
# counterparty). Client sees a table of every txn; their single answer is
# applied to all of them by the answer endpoint.
# --------------------------------------------------------------------------
def ask_client_batch(*, pro_name: str, company_name: str, counterparty: str, txns: list[dict], question: str, magic_url: str) -> tuple[str, str]:
    rows = ""
    total = 0.0
    for t in txns[:25]:  # cap the visible list; full list still in the app
        amt = float(t.get("amount") or 0)
        total += amt
        rows += f"""
          <tr>
            <td style="padding:5px 8px 5px 0;font-size:12px;color:#64748b;font-family:monospace;">{escape(t.get('date', ''))}</td>
            <td style="padding:5px 8px;font-size:12px;color:#0f172a;">{escape((t.get('description') or '')[:60])}</td>
            <td style="padding:5px 8px;font-size:12px;color:#0f172a;text-align:right;font-family:monospace;white-space:nowrap;">${abs(amt):,.2f}{' out' if amt < 0 else ' in'}</td>
          </tr>
        """
    more = f"<tr><td colspan=3 style='padding:6px 0;font-size:11px;color:#94a3b8;font-style:italic;'>… plus {len(txns) - 25} more (see the ledger for the full list)</td></tr>" if len(txns) > 25 else ""
    inner = f"""
      <div style="{_H1}">{len(txns)} questions about {escape(counterparty)}</div>
      <div style="{_P}">
        {escape(pro_name)} is reviewing your books for <b>{escape(company_name)}</b>
        and needs a hand identifying these {escape(counterparty)} transactions:
      </div>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0"
             style="margin:12px 0 8px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:8px 14px;width:100%;">
        <tr style="color:#64748b;font-size:11px;text-transform:uppercase;letter-spacing:.06em;">
          <td style="padding:6px 8px 6px 0;">Date</td>
          <td style="padding:6px 8px;">Description</td>
          <td style="padding:6px 8px;text-align:right;">Amount</td>
        </tr>
        {rows}
        {more}
        <tr><td colspan=3 style="border-top:1px solid #e2e8f0;padding:8px 0 4px;font-size:12px;color:#0f172a;font-weight:600;text-align:right;">
          Combined: ${abs(total):,.2f}{' out' if total < 0 else ' in'}
        </td></tr>
      </table>
      <div style="{_P}"><b>{escape(pro_name)} asks:</b><br>{escape(question)}</div>
      <div style="padding:16px 0 8px;">
        <a href="{magic_url}" style="{_BTN}">Chat with our AI → </a>
      </div>
      <div style="{_MUTE}">
        One quick chat covers every transaction listed above. Link stays valid 30 days.
      </div>
    """
    return f"{len(txns)} questions about {counterparty}", _wrap(inner)


# --------------------------------------------------------------------------
# 2. Daily Pro digest
# --------------------------------------------------------------------------
def daily_pro_digest(*, pro_name: str, companies: list[dict], firm_totals: dict, app_url: str) -> tuple[str, str]:
    rows = ""
    for c in companies:
        rows += f"""
          <tr>
            <td style="padding:8px 8px 8px 0;font-size:13px;color:#0f172a;font-weight:500;">{escape(c.get('name') or '')}</td>
            <td style="padding:8px 8px;font-size:13px;color:{'#b91c1c' if c.get('flagged_count') else '#64748b'};">{c.get('flagged_count', 0)} flagged</td>
            <td style="padding:8px 8px;font-size:13px;color:{'#b91c1c' if c.get('overdue_invoices_count') else '#64748b'};">{c.get('overdue_invoices_count', 0)} inv</td>
            <td style="padding:8px 8px;font-size:13px;color:{'#b91c1c' if c.get('overdue_bills_count') else '#64748b'};">{c.get('overdue_bills_count', 0)} bills</td>
            <td style="padding:8px 8px;font-size:13px;color:{'#b91c1c' if c.get('unreconciled_accounts_count') else '#64748b'};">{c.get('unreconciled_accounts_count', 0)} unrecon</td>
          </tr>
        """
    inner = f"""
      <div style="{_H1}">Good morning, {escape(pro_name)}</div>
      <div style="{_P}">
        Here's what needs your attention across your firm today.
      </div>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0"
             style="margin:12px 0 4px;width:100%;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:8px 16px;">
        <tr style="color:#64748b;font-size:11px;text-transform:uppercase;letter-spacing:.06em;">
          <td style="padding:8px 8px 8px 0;">Client</td>
          <td style="padding:8px 8px;">Flagged</td>
          <td style="padding:8px 8px;">Overdue A/R</td>
          <td style="padding:8px 8px;">Overdue A/P</td>
          <td style="padding:8px 8px;">Unrecon</td>
        </tr>
        {rows or '<tr><td colspan=5 style="padding:16px;color:#64748b;font-size:13px;">Nothing needs your attention today. 🌤</td></tr>'}
      </table>
      <div style="padding:16px 0 4px;">
        <a href="{app_url}/pro/dashboard" style="{_BTN}">Open dashboard →</a>
      </div>
      <div style="{_MUTE}">
        Firm totals — {firm_totals.get('flagged_count', 0)} flagged ·
        {firm_totals.get('overdue_invoices_count', 0)} overdue invoices ·
        {firm_totals.get('overdue_bills_count', 0)} overdue bills ·
        {firm_totals.get('unreconciled_accounts_count', 0)} unreconciled accounts.
      </div>
    """
    return f"Axiom digest — {sum(c.get('flagged_count', 0) for c in companies)} items need review", _wrap(inner)


# --------------------------------------------------------------------------
# 3. Overdue invoice dunning (customer-facing)
# --------------------------------------------------------------------------
def dunning(*, contact_name: str, company_name: str, invoice: dict, days_late: int, app_url: str) -> tuple[str, str]:
    inv_num = invoice.get("number") or invoice.get("id", "")[:8]
    total = invoice.get("balance_due") or invoice.get("total") or 0
    due = invoice.get("due_date") or ""
    inner = f"""
      <div style="{_H1}">Friendly reminder — invoice {escape(inv_num)}</div>
      <div style="{_P}">Hi {escape(contact_name)},</div>
      <div style="{_P}">
        This is a quick reminder from <b>{escape(company_name)}</b> that invoice
        <b>{escape(inv_num)}</b> for <b>${total:,.2f}</b> was due on
        <b>{escape(due)}</b> — {days_late} day{'s' if days_late != 1 else ''} ago.
      </div>
      <div style="{_P}">
        If you've already sent payment, please disregard this email.
        Otherwise, we'd appreciate settling this at your earliest convenience.
      </div>
      <div style="{_MUTE}">
        This message was sent on behalf of {escape(company_name)}. Reply
        directly to reach them.
      </div>
    """
    return f"Reminder: invoice {inv_num} is {days_late} day{'s' if days_late != 1 else ''} past due", _wrap(inner)


# --------------------------------------------------------------------------
# 4. Overdue bill reminder (to the client owner)
# --------------------------------------------------------------------------
def overdue_bill_client(*, client_name: str, company_name: str, bills: list[dict], app_url: str) -> tuple[str, str]:
    rows = ""
    total = 0.0
    for b in bills:
        amt = b.get("balance_due") or b.get("total") or 0
        total += amt
        rows += f"""
          <tr>
            <td style="padding:6px 8px 6px 0;font-size:13px;color:#0f172a;">{escape(b.get('vendor_name') or b.get('contact_name') or 'Unknown vendor')}</td>
            <td style="padding:6px 8px;font-size:13px;color:#0f172a;">{escape(b.get('number') or '')}</td>
            <td style="padding:6px 8px;font-size:13px;color:#b91c1c;font-weight:600;">${amt:,.2f}</td>
            <td style="padding:6px 8px;font-size:13px;color:#64748b;">{escape(b.get('due_date') or '')}</td>
          </tr>
        """
    inner = f"""
      <div style="{_H1}">You have {len(bills)} overdue bill{'s' if len(bills) != 1 else ''}</div>
      <div style="{_P}">Hi {escape(client_name)},</div>
      <div style="{_P}">
        The following bills for <b>{escape(company_name)}</b> are past their due date:
      </div>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0"
             style="margin:12px 0;width:100%;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:8px 16px;">
        <tr style="color:#64748b;font-size:11px;text-transform:uppercase;letter-spacing:.06em;">
          <td style="padding:6px 8px 6px 0;">Vendor</td>
          <td style="padding:6px 8px;">Bill #</td>
          <td style="padding:6px 8px;">Amount</td>
          <td style="padding:6px 8px;">Due</td>
        </tr>
        {rows}
        <tr><td colspan=4 style="border-top:1px solid #e2e8f0;padding:10px 0 4px;font-size:13px;color:#0f172a;font-weight:700;">
          Total outstanding: ${total:,.2f}
        </td></tr>
      </table>
      <div style="padding:12px 0 0;">
        <a href="{app_url}/bills" style="{_BTN}">Open bills →</a>
      </div>
    """
    return f"{len(bills)} overdue bill{'s' if len(bills) != 1 else ''} — ${total:,.2f}", _wrap(inner)


# --------------------------------------------------------------------------
# 5. Plaid re-auth needed
# --------------------------------------------------------------------------
def plaid_reauth(*, client_name: str, company_name: str, institution: str, app_url: str) -> tuple[str, str]:
    inner = f"""
      <div style="{_H1}">Reconnect {escape(institution)}</div>
      <div style="{_P}">Hi {escape(client_name)},</div>
      <div style="{_P}">
        Your <b>{escape(institution)}</b> connection for <b>{escape(company_name)}</b>
        needs to be re-authorized — banks periodically require you to sign
        in again for security. Until you do, we can't pull new transactions.
      </div>
      <div style="padding:8px 0 4px;">
        <a href="{app_url}/onboarding" style="{_BTN}">Reconnect now →</a>
      </div>
      <div style="{_MUTE}">Takes about 30 seconds. Your data isn't lost — the reconnect just refreshes the token.</div>
    """
    return f"Reconnect {institution} to keep books in sync", _wrap(inner)


# --------------------------------------------------------------------------
# 6. Onboarding follow-up
# --------------------------------------------------------------------------
def onboarding_followup(*, client_name: str, company_name: str, next_step_label: str, app_url: str) -> tuple[str, str]:
    inner = f"""
      <div style="{_H1}">Let's finish setting up {escape(company_name)}</div>
      <div style="{_P}">Hi {escape(client_name)},</div>
      <div style="{_P}">
        You're almost done onboarding. Your next step is:
        <b>{escape(next_step_label)}</b>.
      </div>
      <div style="padding:8px 0 4px;">
        <a href="{app_url}/onboarding" style="{_BTN}">Continue onboarding →</a>
      </div>
      <div style="{_MUTE}">Reply to this email if you got stuck or have questions.</div>
    """
    return f"Finish setting up {company_name}", _wrap(inner)


# --------------------------------------------------------------------------
# 7. Month Close signoff request
# --------------------------------------------------------------------------
def month_close_signoff(*, client_name: str, company_name: str, month_label: str, app_url: str) -> tuple[str, str]:
    inner = f"""
      <div style="{_H1}">{escape(month_label)} books are ready — please sign off</div>
      <div style="{_P}">Hi {escape(client_name)},</div>
      <div style="{_P}">
        The {escape(month_label)} books for <b>{escape(company_name)}</b>
        are complete and reconciled. When you're happy with them, please
        sign off — this locks the period so nothing changes retroactively.
      </div>
      <div style="padding:8px 0 4px;">
        <a href="{app_url}/accounting/month-close" style="{_BTN}">Review & sign off →</a>
      </div>
    """
    return f"Sign off requested: {month_label} — {company_name}", _wrap(inner)


# --------------------------------------------------------------------------
# Tiny local escape (avoid pulling markupsafe just for these).
# --------------------------------------------------------------------------
def escape(s) -> str:
    if s is None:
        return ""
    return (
        str(s)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )
