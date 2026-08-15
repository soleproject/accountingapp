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

_WRAP_CLOSE_TMPL = """
    </table>
    <div style="max-width:560px;margin:16px auto 0;color:#94a3b8;font-size:11px;line-height:1.5;text-align:center;">
      Sent by {brand}{platform_ref}
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
_BTN_SECONDARY = (
    "display:inline-block;padding:10px 18px;background:#ffffff;color:#0e7490;"
    "border:1px solid #0e7490;border-radius:8px;text-decoration:none;font-weight:600;"
    "font-size:14px;margin:8px 0 4px;"
)
_TABLE_KEY = "font-size:13px;color:#64748b;padding:4px 12px 4px 0;white-space:nowrap;"
_TABLE_VAL = "font-size:13px;color:#0f172a;padding:4px 0;font-weight:500;"


def _wrap(inner: str, *, brand_name: Optional[str] = None) -> str:
    """Wrap an email body with the standard slate/cyan chrome.

    When a Pro has set a Private Label Name on their branding, callers
    pass it as ``brand_name`` and the footer swaps "Sent by SmartBooks
    · smartbookssoftware.ai" for a bare "Sent by {firm}" — the platform
    reference is dropped so the branding stays fully white-labelled.
    Non-branded emails keep the SmartBooks + domain footer.
    """
    private_label = bool(brand_name and brand_name.strip())
    brand = escape(brand_name.strip()) if private_label else "SmartBooks"
    platform_ref = (
        "" if private_label
        else ' · <span style="font-family:monospace;">smartbookssoftware.ai</span>'
    )
    close = _WRAP_CLOSE_TMPL.format(brand=brand, platform_ref=platform_ref)
    return f"{_WRAP_OPEN}<tr><td>{inner}</td></tr>{close}"


# --------------------------------------------------------------------------
# Password reset (self-service forgot-password magic link).
# One-time token, valid for 24 hours, minted only when the address is
# actually registered — but the endpoint returns 200 either way to
# prevent enumeration attacks.
# --------------------------------------------------------------------------
def password_reset(*, name: str, magic_url: str) -> tuple[str, str]:
    inner = f"""
      <div style="{_H1}">Reset your password</div>
      <div style="{_P}">
        Hi {escape(name)},<br><br>
        Someone (hopefully you) asked to reset the password on your Axiom
        Ledger account. Tap below and pick a new one.
      </div>
      <div style="padding:14px 0 6px;">
        <a href="{magic_url}" style="{_BTN}">Set a new password →</a>
      </div>
      <div style="{_MUTE}">
        This link is unique to you and expires in 24 hours. If you
        didn't request this, just ignore the email — your existing
        password still works.
      </div>
    """
    return "Reset your SmartBooks password", _wrap(inner)


# --------------------------------------------------------------------------
# Team invite — unified template for the 4 invite flavours (company teammate,
# firm-staff pro, superadmin, new-pro bootstrap). Body content adapts to the
# role via ``role_label`` + ``role_description`` from the caller.
# --------------------------------------------------------------------------
def team_invite(*, invitee_name: str, inviter_name: str,
                role_label: str, role_description: str,
                company_names: list[str], magic_url: str,
                brand_name: Optional[str] = None) -> tuple[str, str]:
    """Team-invite email. When `brand_name` is provided (i.e. the
    inviter has an unlocked private label), every hardcoded
    "SmartBooks" swaps for the label's name and the footer strips the
    platform disclaimer via `_wrap(brand_name=...)`. The magic-link
    URL is expected to already be on the correct label host — the
    caller builds it with `public_base_url(firm_slug=...)`."""
    brand = (brand_name or "").strip() or "SmartBooks"
    if company_names:
        row_lines = "".join(
            f"<div style='padding:4px 0;color:#0f172a;font-size:13px;'>· {escape(n)}</div>"
            for n in company_names
        )
        companies_html = (
            "<div style='margin:12px 0;background:#f8fafc;border:1px solid #e2e8f0;"
            "border-radius:8px;padding:12px 14px;'>"
            "<div style='font-size:11px;text-transform:uppercase;letter-spacing:0.06em;color:#64748b;padding-bottom:4px;'>"
            f"Access to {len(company_names)} {'company' if len(company_names) == 1 else 'companies'}"
            "</div>"
            f"{row_lines}"
            "</div>"
        )
    else:
        companies_html = ""

    inner = f"""
      <div style="{_H1}">You've been invited to {escape(brand)}</div>
      <div style="{_P}">
        Hi {escape(invitee_name)},<br><br>
        <b>{escape(inviter_name)}</b> invited you to join {escape(brand)} as an
        <b>{escape(role_label)}</b> — {escape(role_description)}
      </div>
      {companies_html}
      <div style="{_P}">
        Set a password and you'll be in — this magic link is unique to you.
      </div>
      <div style="padding:14px 0 6px;">
        <a href="{magic_url}" style="{_BTN}">Accept invitation →</a>
      </div>
      <div style="{_MUTE}">
        This invitation expires in 14 days. If it does, ask
        {escape(inviter_name)} to re-send it.
      </div>
    """
    return (
        f"You're invited to {brand} — {role_label}",
        _wrap(inner, brand_name=brand_name),
    )


# --------------------------------------------------------------------------
# Client welcome — first company (magic-link password set).
# Sent by `pro_create_client` when the client's email is brand-new to the
# platform. The client hasn't chosen a password yet — clicking the button
# lands them on `/set-password/{token}` where they pick one and are
# immediately logged in.
# --------------------------------------------------------------------------
def client_welcome_first_time(*, client_name: str, pro_name: str,
                              firm_name: Optional[str], company_name: str,
                              set_password_url: str,
                              payment_url: Optional[str] = None,
                              brand_name: Optional[str] = None) -> tuple[str, str]:
    """First-time client welcome. If ``payment_url`` is supplied (i.e.
    the Pro selected "Client — Email bill" as the payer), the email
    surfaces a "Pay & activate" CTA — but for a first-time client that
    button routes to the ``set_password_url`` because a password is
    prerequisite for anything to work. After the user picks a password
    the app auto-logs them in and the ``BillingLockedModal`` immediately
    prompts for the Stripe checkout. Copy is written to make that
    two-step flow obvious.

    ``payment_url`` is still accepted (and stored in the token's client
    context via the ``next`` query param if the caller wants), even
    though the primary button leads to set-password — so returning-
    client callers don't have to branch.
    """
    firm = firm_name or pro_name
    brand = (brand_name or "").strip() or "SmartBooks"
    brand_e = escape(brand)
    # For first-time clients we always route through set-password. The
    # welcome email carries a single primary CTA reflecting the payer
    # intent so the client knows the outcome ("activate subscription"),
    # even though the URL is the password-set link.
    if payment_url:
        primary_url = set_password_url  # password comes first
        primary_label = "Set password &amp; activate →"
        activation_hint = (
            f"<b>Two quick steps:</b> pick a password, then a single Stripe "
            f"checkout to activate <b>{escape(company_name)}</b>. No card "
            f"details are shared with your bookkeeper."
        )
    else:
        primary_url = set_password_url
        primary_label = "Set your password →"
        activation_hint = (
            "Pick a password. It takes about 20 seconds and this link is "
            "unique to you."
        )
    inner = f"""
      <div style="{_H1}">Welcome to {brand_e} 👋</div>
      <div style="{_P}">
        Hi {escape(client_name)},<br><br>
        <b>{escape(pro_name)}</b> at {escape(firm)} just set up
        <b>{escape(company_name)}</b>'s books here on {brand_e} — a modern,
        AI-assisted accounting platform.
      </div>
      <div style="{_P}">{activation_hint}</div>
      <div style="padding:14px 0 6px;">
        <a href="{escape(primary_url)}" style="{_BTN}">{primary_label}</a>
      </div>
      <div style="{_MUTE}">
        {"After you set your password, we'll unlock the Stripe checkout automatically — no extra login needed." if payment_url else f"Once you're in you'll see a short onboarding tour, your bank connections, and the questions {escape(pro_name)} needs your help with."}<br><br>
        This link expires in 7 days. If it does, ask {escape(pro_name)} to
        re-send it.
      </div>
    """
    return f"Welcome to {brand} — set your password", _wrap(inner, brand_name=brand_name)


# --------------------------------------------------------------------------
# Client welcome — additional company (already has a login).
# Sent when a Pro creates a new company for a client email that already
# owns at least one company on the platform. No magic link — they use
# their existing password and switch companies from the top-left dropdown.
# --------------------------------------------------------------------------
def client_welcome_returning(*, client_name: str, pro_name: str,
                             firm_name: Optional[str], company_name: str,
                             other_company_count: int,
                             dashboard_url: str,
                             payment_url: Optional[str] = None,
                             brand_name: Optional[str] = None) -> tuple[str, str]:
    """Returning-client welcome. When ``payment_url`` is provided the
    email leads with a "Pay & activate" CTA — the client's existing
    password still works, but they can't open the new company until
    the invoice is settled."""
    firm = firm_name or pro_name
    brand = (brand_name or "").strip() or "SmartBooks"
    brand_e = escape(brand)
    others = (
        f"You now have <b>{other_company_count + 1}</b> companies on your {brand_e} login — "
        "switch between them from the dropdown at the top-left."
    )
    if payment_url:
        pay_block = f"""
      <div style="{_P}"><b>Activate <em>{escape(company_name)}</em>'s books.</b>
        {escape(pro_name)} set this company to pay directly. Once the
        subscription is active, the books will unlock automatically.</div>
      <div style="padding:14px 0 6px;">
        <a href="{escape(payment_url)}" style="{_BTN}">Pay &amp; activate {escape(company_name)} →</a>
      </div>
      <div style="border-top:1px solid #e2e8f0;margin:22px 0 4px;"></div>
        """
        primary_btn_html = f'<a href="{escape(dashboard_url)}" style="{_BTN_SECONDARY}">Open my books</a>'
    else:
        pay_block = ""
        primary_btn_html = f'<a href="{escape(dashboard_url)}" style="{_BTN}">Open {escape(company_name)} →</a>'
    inner = f"""
      <div style="{_H1}">A new company was added to your {brand_e} login</div>
      <div style="{_P}">
        Hi {escape(client_name)},<br><br>
        <b>{escape(pro_name)}</b> at {escape(firm)} just added
        <b>{escape(company_name)}</b> to your existing {brand_e} account.
      </div>
      <div style="{_P}">{others}</div>
      {pay_block}
      <div style="padding:14px 0 6px;">
        {primary_btn_html}
      </div>
      <div style="{_MUTE}">
        Your existing password still works — no need to reset anything.
      </div>
    """
    return f"{company_name} is now on your {brand} login", _wrap(inner, brand_name=brand_name)


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
    inner = f"""
      <div style="{_P}">Hi — quick one on <b>{escape(company_name)}</b>:</div>
      <div style="font-size:16px;color:#0f172a;line-height:1.55;padding:6px 0 10px;">
        {escape(question)}
      </div>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0"
             style="margin:4px 0 12px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:10px 14px;width:100%;">
        <tr>
          <td style="{_TABLE_KEY}">{escape(date)}</td>
          <td style="{_TABLE_VAL}">{escape(desc)}</td>
          <td style="{_TABLE_VAL};text-align:right;font-family:monospace;">{escape(amt_str)}</td>
        </tr>
      </table>
      <div style="padding:6px 0 4px;">
        <a href="{magic_url}" style="{_BTN}">Reply →</a>
      </div>
      <div style="{_MUTE}">Takes ~20 seconds. Private link for {escape(company_name)}.</div>
    """
    return f"Quick one — {desc[:40]}", _wrap(inner)


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
# Stripe checkout welcome — sent by the Stripe webhook when a brand-new
# email pays for a subscription. Includes a magic link to set the
# password (the account was auto-created with a random one they never
# see). Purposefully lighter tone than the pro-invited flow — the buyer
# knows they signed up because *they* just paid Stripe.
# --------------------------------------------------------------------------
def stripe_welcome(
    *,
    name: str,
    magic_url: str,
    brand: Optional[dict] = None,
) -> tuple[str, str]:
    """Post-Stripe-checkout welcome + set-password magic link.

    When ``brand`` is passed (from ``private_labels.resolve_brand``), the
    subject, heading, product name, and footer swap to the private label
    (e.g. CypherPro) — including a clean footer that DROPS the
    smartbookssoftware.ai reference so the email reads as purely
    CypherPro branded. Falls back to SmartBooks copy when brand is None
    or the flagship key.
    """
    brand = brand or {}
    product = brand.get("product_name") or "SmartBooks"
    display = brand.get("display_name") or product
    tagline = brand.get("tagline") or ""
    tagline_html = (
        f'<div style="font-size:13px;color:#64748b;padding:0 0 12px;">{escape(tagline)}</div>'
        if tagline else ""
    )
    is_private_label = bool(brand.get("key") and brand["key"] != "smartbooks")
    inner = f"""
      <div style="{_H1}">Payment received — welcome to {escape(product)}</div>
      {tagline_html}
      <div style="{_P}">
        Hi {escape(name)},<br><br>
        Thanks for subscribing to {escape(product)}. Your account is created and
        ready — pick a password and you're in.
      </div>
      <div style="padding:14px 0 6px;">
        <a href="{magic_url}" style="{_BTN}">Set your password →</a>
      </div>
      <div style="{_MUTE}">
        This link is unique to you and expires in 14 days. If it does,
        head to <b>Forgot password</b> on the sign-in page to get a fresh
        one. Have questions about your subscription? Just reply to this
        email.
      </div>
    """
    subject = f"Welcome to {product} — set your password"
    # Pass brand_name only for private labels — flagship SmartBooks
    # keeps its historical footer with the smartbookssoftware.ai link.
    return subject, _wrap(inner, brand_name=display if is_private_label else None)


# --------------------------------------------------------------------------
# Affiliate welcome — fired right after an ``/api/auth/signup`` where the
# role is ``affiliate``. The goal is *day-0 activation*: give the new
# affiliate everything they need (unique link, QR code, payout tier
# reference) inside the very first inbox touch so they don't lose the
# thread waiting to find "how do I share?" in the app.
#
# Note on QR embedding — PNG data URI is the widest-compatible option
# (SVG breaks in Outlook). `segno` generates a compact monochrome PNG
# with no PIL/pillow dependency; the resulting base64 is ~800B so total
# email size stays well under the Gmail-clip-warning 102KB threshold.
# --------------------------------------------------------------------------
def _qr_png_data_uri(payload: str, scale: int = 5) -> str:
    """Return a ``data:image/png;base64,…`` string for ``payload`` at the
    given per-module scale. Falls back to ``""`` if ``segno`` isn't
    importable so callers don't have to defensively try/except.
    """
    try:
        import io, base64, segno
        buf = io.BytesIO()
        segno.make(payload, error="M").save(buf, kind="png", scale=scale, border=2)
        b64 = base64.b64encode(buf.getvalue()).decode("ascii")
        return f"data:image/png;base64,{b64}"
    except Exception:
        return ""


def affiliate_welcome(
    *, name: str, share_link: str, slug: str,
    dashboard_url: str, referrer_name: Optional[str] = None,
) -> tuple[str, str]:
    """Welcome an affiliate + hand them their toolkit inline.

    * ``name`` — the affiliate's own display name (used in salutation).
    * ``share_link`` — the buy-page / signup URL with ?ref=<slug>
      already baked in.
    * ``slug`` — for display below the QR.
    * ``dashboard_url`` — deep-link to /share so they can see live stats.
    * ``referrer_name`` — if the affiliate was themselves referred, we
      thank the upstream affiliate in the sign-off (optional).
    """
    qr = _qr_png_data_uri(share_link, scale=6)
    qr_block = f"""
      <div style="text-align:center;padding:20px 0 4px;">
        <img src="{qr}" alt="Referral QR"
             style="width:180px;height:180px;border:1px solid #e2e8f0;border-radius:8px;padding:8px;background:#ffffff;" />
        <div style="{_MUTE};padding-top:6px;">
          <span style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">
            {escape(slug)}
          </span>
        </div>
      </div>
    """ if qr else ""
    tier_rows = "".join([
        f"""<tr>
          <td style="{_TABLE_KEY}">{svc} plan</td>
          <td style="{_TABLE_VAL}">→ {payout}/mo payout</td>
        </tr>"""
        for svc, payout in [("$38", "$7"), ("$79", "$15"), ("$95", "$20"), ("$149", "$30")]
    ])
    thank_line = (
        f"<br><br>Big thanks to <b>{escape(referrer_name)}</b> for pointing you our way "
        "— you're on their team."
        if referrer_name else ""
    )
    inner = f"""
      <div style="{_H1}">Welcome — you're officially earning</div>
      <div style="{_P}">
        Hi {escape(name)},<br><br>
        Your affiliate link is live. Every signup that comes through it
        is permanently attributed to you, and every invoice they pay
        (this month, next month, every month) earns you a fixed payout.
        No cost to you, no cost to them.{thank_line}
      </div>
      <div style="text-align:center;padding:14px 0 4px;">
        <a href="{share_link}" style="{_BTN}">Grab your link →</a>
      </div>
      <div style="{_MUTE};text-align:center;padding:4px 0 12px;">
        <span style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:#334155;">
          {escape(share_link)}
        </span>
      </div>
      {qr_block}
      <div style="{_P};padding-top:16px;">
        <b>Payouts, at a glance:</b>
      </div>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0"
             style="margin:4px 0 4px;border-collapse:collapse;">
        {tier_rows}
      </table>
      <div style="{_P};padding-top:16px;">
        <b>Quick win:</b> share this with 5 friends this week. If just
        one of them subscribes to any plan, you've hit your first payout
        — and every renewal after keeps stacking.
      </div>
      <div style="padding:14px 0 4px;">
        <a href="{dashboard_url}" style="{_BTN_SECONDARY}">Open your dashboard</a>
      </div>
      <div style="{_MUTE}">
        See live signups, mark a custom vanity slug, or upgrade to a
        full account any time from your Refer &amp; earn page.
      </div>
    """
    return "Your affiliate link is live — let's earn.", _wrap(inner)


# --------------------------------------------------------------------------
# Enterprise welcome — fired right after ``/api/auth/signup`` with
# ``role='pro'`` + ``enterprise_name``. Sends the new firm owner the 3
# links they need on day 0 (invite staff, add first client, review
# billing) plus a note that the private-label subdomain unlocks with the
# paid tier so they know what's coming next.
# --------------------------------------------------------------------------
def enterprise_welcome(
    *, name: str, enterprise_name: str,
    enterprise_slug: Optional[str],
    dashboard_url: str, invite_url: str, billing_url: str,
) -> tuple[str, str]:
    """Welcome a new firm owner with the toolkit they need on day 0.

    ``enterprise_slug`` is displayed as an FYI-only value — the firm's
    reserved private-label handle. Full private-label branding (custom
    subdomain, hero image, tagline) is a paid upgrade in a subsequent
    iteration; this email flags that so the owner knows to expect it.
    """
    slug_hint = (
        f"""<div style="{_MUTE};padding-top:8px;">
              Your reserved firm handle:
              <span style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:#334155;">
                {escape(enterprise_slug)}
              </span> — the private-label subdomain unlocks on the paid tier.
            </div>"""
        if enterprise_slug else ""
    )
    inner = f"""
      <div style="{_H1}">Welcome to your firm dashboard</div>
      <div style="{_P}">
        Hi {escape(name)},<br><br>
        <b>{escape(enterprise_name)}</b> is live on SmartBooks. Your
        client list is empty and quiet — let's fix that.
      </div>
      <div style="text-align:center;padding:14px 0 4px;">
        <a href="{dashboard_url}" style="{_BTN}">Open your firm dashboard →</a>
      </div>
      {slug_hint}
      <div style="{_P};padding-top:16px;">
        <b>Three things to do this week:</b>
      </div>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0"
             style="margin:6px 0 4px;border-collapse:collapse;width:100%;">
        <tr>
          <td style="{_TABLE_KEY};vertical-align:top;width:32px;">1.</td>
          <td style="{_TABLE_VAL}">
            <b>Invite your team.</b> Add bookkeepers, reviewers, and
            partners — assign them to specific clients.<br>
            <a href="{invite_url}" style="color:#0891b2;">Invite staff →</a>
          </td>
        </tr>
        <tr>
          <td style="{_TABLE_KEY};vertical-align:top;">2.</td>
          <td style="{_TABLE_VAL}">
            <b>Add your first client.</b> Kick off onboarding with
            Plaid, Veryfi, and an AI-assisted chart of accounts.<br>
            <a href="{dashboard_url}" style="color:#0891b2;">Go to
            My Clients →</a>
          </td>
        </tr>
        <tr>
          <td style="{_TABLE_KEY};vertical-align:top;">3.</td>
          <td style="{_TABLE_VAL}">
            <b>Pick your billing plan.</b> Bill your firm centrally,
            or pass Stripe subscriptions through to each client.<br>
            <a href="{billing_url}" style="color:#0891b2;">Review
            billing →</a>
          </td>
        </tr>
      </table>
      <div style="{_MUTE};padding-top:16px;">
        Questions along the way? Reply to this email — a human at
        SmartBooks reads every one.
      </div>
    """
    return f"{enterprise_name} is live on SmartBooks — welcome.", _wrap(
        inner, brand_name=enterprise_name,
    )






# --------------------------------------------------------------------------
# Payment failed — sent when Stripe fires ``invoice.payment_failed``.
# Two variants: one to the paying client (call-to-action to update their
# card), and one to the accounting Pro (heads-up so they can nudge the
# client personally). Both templates re-use the firm's private-label
# name in the footer so the emails feel branded end-to-end.
# --------------------------------------------------------------------------
def payment_failed_client(
    *, client_name: str, company_name: str, amount_usd: float,
    update_url: str, brand_name: Optional[str] = None,
) -> tuple[str, str]:
    inner = f"""
      <div style="{_H1}">Your card was declined</div>
      <div style="{_P}">
        Hi {escape(client_name)},<br><br>
        We tried to process your subscription payment for
        <b>{escape(company_name)}</b> — <b>${amount_usd:,.2f}</b> — and
        your card issuer declined it.
      </div>
      <div style="{_P}">
        Your books stay locked until the balance is settled. Update your
        card and we'll retry automatically:
      </div>
      <div style="padding:14px 0 6px;">
        <a href="{escape(update_url)}" style="{_BTN}">Update payment method →</a>
      </div>
      <div style="{_MUTE}">
        If you think this is a mistake, reply to this email and we'll
        get your accounting team on it right away.
      </div>
    """
    return (
        f"Action required — payment declined for {company_name}",
        _wrap(inner, brand_name=brand_name),
    )


def payment_failed_pro(
    *, pro_name: str, client_name: str, company_name: str, amount_usd: float,
    app_url: str, brand_name: Optional[str] = None,
) -> tuple[str, str]:
    inner = f"""
      <div style="{_H1}">Heads up — {escape(client_name)}'s payment failed</div>
      <div style="{_P}">
        Hi {escape(pro_name)},<br><br>
        Stripe just tried to charge <b>${amount_usd:,.2f}</b> for
        <b>{escape(company_name)}</b> and the card was declined. We've
        emailed the client with a link to update their card, but a
        personal nudge from you usually gets it resolved faster.
      </div>
      <div style="padding:14px 0 6px;">
        <a href="{escape(app_url)}" style="{_BTN}">Open client →</a>
      </div>
      <div style="{_MUTE}">
        The client's books are locked until the balance clears. You'll
        get another email once Stripe successfully retries.
      </div>
    """
    return (
        f"Payment declined — {client_name} ({company_name})",
        _wrap(inner, brand_name=brand_name),
    )



# --------------------------------------------------------------------------
# QuickBooks migration completion / failure — sent when a
# `qbo_service.run_migration` background task lands. Brand cascade
# comes from the initiating user's white-label (via email_dispatcher),
# so partners / enterprises see their own footer.
# --------------------------------------------------------------------------
def qbo_migration_complete(
    *, name: str, company_name: str, dashboard_url: str,
    stats: dict, brand_name: Optional[str] = None,
) -> tuple[str, str]:
    """Migration finished successfully. `stats` may contain any of:
        transactions_posted, payments_linked, transactions_categorized,
        mirror_estimates_pulled, mirror_pos_pulled,
        mirror_inv_adj_pulled, opening_inventory_value.
    Missing keys are quietly skipped — the template just renders what
    was actually captured on the job doc."""
    def _row(label: str, val) -> str:
        if val in (None, 0, 0.0, ""):
            return ""
        return (f'<tr><td style="{_TABLE_KEY}">{escape(label)}</td>'
                f'<td style="{_TABLE_VAL}">{escape(val)}</td></tr>')

    rows = "".join([
        _row("Transactions posted",       stats.get("transactions_posted")),
        _row("Transactions categorized",  stats.get("transactions_categorized")),
        _row("Payments linked",           stats.get("payments_linked")),
        _row("Estimates pulled",          stats.get("mirror_estimates_pulled")),
        _row("Purchase orders pulled",    stats.get("mirror_pos_pulled")),
        _row("Inventory adjustments",     stats.get("mirror_inv_adj_pulled")),
        _row("Opening inventory value ($)",
             (f"{stats.get('opening_inventory_value'):,.2f}"
              if stats.get("opening_inventory_value") else None)),
    ])
    stats_table = (
        f'<table role="presentation" cellpadding="0" cellspacing="0" '
        f'border="0" style="margin:8px 0 4px;border-collapse:collapse;">'
        f'{rows}</table>'
    ) if rows else ""

    inner = f"""
      <div style="{_H1}">Your QuickBooks migration is done</div>
      <div style="{_P}">
        Hi {escape(name)},<br><br>
        Great news — we just finished importing every account,
        contact, item, and transaction from
        <b>{escape(company_name)}</b>'s QuickBooks Online company into
        your ledger. Everything is ready to review.
      </div>
      {stats_table}
      <div style="text-align:center;padding:14px 0 4px;">
        <a href="{dashboard_url}" style="{_BTN}">Open your books →</a>
      </div>
      <div style="{_MUTE};padding-top:16px;">
        Have questions or something looks off? Reply to this email —
        we read every one.
      </div>
    """
    subject_brand = brand_name or "your books"
    return (
        f"QuickBooks migration complete — {company_name}",
        _wrap(inner, brand_name=brand_name),
    )


def qbo_migration_failed(
    *, name: str, company_name: str, error: str, dashboard_url: str,
    brand_name: Optional[str] = None,
) -> tuple[str, str]:
    """Migration failed mid-flight. Keeps the message calm — most
    failures are transient (Intuit 5xx, rate-limit) and re-running is
    the fix. We include the raw error string so support can grep the
    dispatch log if the user forwards the email."""
    inner = f"""
      <div style="{_H1}">Your QuickBooks migration hit a snag</div>
      <div style="{_P}">
        Hi {escape(name)},<br><br>
        We ran into an error while importing
        <b>{escape(company_name)}</b>'s QuickBooks data. Most of these
        are transient — re-running the migration usually clears it.
      </div>
      <div style="{_MUTE};background:#fef2f2;border:1px solid #fecaca;
                   padding:10px 12px;border-radius:8px;margin:8px 0;
                   font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
                   font-size:12px;color:#991b1b;">
        {escape(error)[:400]}
      </div>
      <div style="text-align:center;padding:14px 0 4px;">
        <a href="{dashboard_url}" style="{_BTN}">Retry migration →</a>
      </div>
      <div style="{_MUTE};padding-top:16px;">
        Still stuck after a retry? Reply to this email and we'll dig
        in with you.
      </div>
    """
    return (
        f"QuickBooks migration needs attention — {company_name}",
        _wrap(inner, brand_name=brand_name),
    )


# --------------------------------------------------------------------------
# Feedback / bug-report intake — internal notification to superadmins
# when a user submits a bug or product recommendation via the in-app
# feedback widget. Kept intentionally spartan — this is a triage tool,
# not a customer-facing email — but still uses `_wrap` so branded logos
# and footer stay consistent.
# --------------------------------------------------------------------------
def feedback_new_submission(
    *,
    fb_type: str,          # "bug" | "recommendation"
    title: str,
    description: str,
    submitter_name: str,
    submitter_email: str,
    submitter_role: str,
    route: str,
    company_name: str,
    partner_name: str = "",
    enterprise_name: str = "",
    inbox_url: str,
) -> tuple[str, str]:
    is_bug = fb_type == "bug"
    label = "Bug report" if is_bug else "Product recommendation"
    icon = "🐞" if is_bug else "💡"
    accent = "#dc2626" if is_bug else "#0891b2"

    ctx_rows = ""
    context_pairs = [
        ("From", f"{submitter_name} &lt;{submitter_email}&gt;"),
        ("Role", submitter_role or "—"),
        ("Partner", partner_name or "—"),
        ("Enterprise", enterprise_name or "—"),
        ("Company", company_name or "—"),
        ("Page", route or "—"),
    ]
    for k, v in context_pairs:
        ctx_rows += (
            f'<tr><td style="{_TABLE_KEY}">{escape(k)}</td>'
            f'<td style="{_TABLE_VAL}">{v}</td></tr>'
        )

    desc_block = ""
    if (description or "").strip():
        # Preserve line breaks the reporter used
        safe = escape(description).replace("\n", "<br>")
        desc_block = (
            f'<div style="{_P};margin-top:14px;'
            f'padding:12px 14px;background:#f8fafc;border-left:3px solid {accent};'
            f'border-radius:6px;white-space:pre-wrap;">{safe}</div>'
        )

    inner = f"""
      <div style="{_H1}">{icon} {escape(label)}</div>
      <div style="{_P};font-size:15px;color:#0f172a;font-weight:600;">
        {escape(title)}
      </div>
      {desc_block}
      <table style="width:100%;border-collapse:collapse;margin-top:16px;">
        {ctx_rows}
      </table>
      <div style="padding:18px 0 6px;">
        <a href="{escape(inbox_url)}" style="{_BTN}">Open feedback inbox →</a>
      </div>
      <div style="{_MUTE}">
        You're receiving this because you're a superadmin on this
        instance. Manage status and reply in the inbox.
      </div>
    """
    return (
        f"[{'Bug' if is_bug else 'Idea'}] {title}",
        _wrap(inner, brand_name=None),
    )



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
