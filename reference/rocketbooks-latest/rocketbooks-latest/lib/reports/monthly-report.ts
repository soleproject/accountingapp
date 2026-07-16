import 'server-only';
import { randomUUID } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { organizations, users, aiClientOutreach } from '@/db/schema/schema';
import { loadIncomeStatement } from './income-statement-data';
import { loadBalanceSheet } from './balance-sheet-data';
import { resolveBasis } from './basis-filter';
import { sendTransactionalEmail } from '@/lib/email/resend';
import { getFirmBaseUrlForOrg, getPoweredByFooter } from '@/lib/enterprise/firm-branding';

/**
 * Monthly financial-statement snapshot emailed to the client (org owner + any
 * configured recipients): prior month's P&L summary + month-end balance-sheet
 * summary, with a link to the full statements in-app. Opt-in per org
 * (organizations.monthly_report_enabled). Logged to ai_client_outreach
 * (issueType='monthly_report') with a 25-day dedup. Best-effort, never throws.
 *
 * Link-based, not PDF — the report PDF routes are currently disabled; this uses
 * the (working) data builders. PDF attachments are a later enhancement.
 */

const money = (n: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);

/** Prior calendar month [from, to] as ISO dates, relative to `asOf` (default now). */
export function priorMonthRange(asOf?: Date): { from: string; to: string; label: string } {
  const d = asOf ?? new Date();
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth(); // 0-based; "this" month
  const from = new Date(Date.UTC(y, m - 1, 1));
  const to = new Date(Date.UTC(y, m, 0)); // day 0 of this month = last day of prior month
  const iso = (x: Date) => x.toISOString().slice(0, 10);
  const label = from.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  return { from: iso(from), to: iso(to), label };
}

function parseRecipients(raw: string | null): string[] {
  if (!raw) return [];
  return raw
    .split(/[,;\n]/)
    .map((s) => s.trim())
    .filter((s) => s.includes('@'));
}

export interface MonthlyReportResult {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  recipients?: number;
  error?: string;
}

export async function sendMonthlyReport(args: {
  orgId: string;
  asOf?: Date;
  force?: boolean;
  /** Send to these addresses instead of the owner + configured recipients (test sends). */
  overrideRecipients?: string[];
}): Promise<MonthlyReportResult> {
  const { orgId } = args;
  const { from, to, label } = priorMonthRange(args.asOf);

  // 25-day dedup so a re-run (or hourly cron overlap) can't double-send.
  if (!args.force) {
    const [recent] = await db
      .select({ last: aiClientOutreach.lastContactAt })
      .from(aiClientOutreach)
      .where(
        and(
          eq(aiClientOutreach.organizationId, orgId),
          eq(aiClientOutreach.issueType, 'monthly_report'),
          eq(aiClientOutreach.status, 'sent'),
          sql`${aiClientOutreach.lastContactAt} > now() - interval '25 days'`,
        ),
      )
      .orderBy(desc(aiClientOutreach.lastContactAt))
      .limit(1);
    if (recent?.last) return { ok: true, skipped: true, reason: 'already_sent_this_period' };
  }

  const [org] = await db
    .select({ name: organizations.name, ownerUserId: organizations.ownerUserId, recipients: organizations.monthlyReportRecipients })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  if (!org) return { ok: false, error: 'Org not found' };

  const [owner] = org.ownerUserId
    ? await db.select({ email: users.email }).from(users).where(eq(users.id, org.ownerUserId)).limit(1)
    : [undefined];

  const recipients = args.overrideRecipients?.length
    ? [...new Set(args.overrideRecipients.map((e) => e.toLowerCase()))]
    : [...new Set([owner?.email, ...parseRecipients(org.recipients)].filter((e): e is string => !!e).map((e) => e.toLowerCase()))];
  if (recipients.length === 0) return { ok: false, error: 'No recipients (owner has no email)' };

  const basis = await resolveBasis(orgId, undefined);
  const [is, bs] = await Promise.all([
    loadIncomeStatement(orgId, from, to, basis),
    loadBalanceSheet(orgId, to, basis),
  ]);

  // Skip genuinely empty months (brand-new org with no activity).
  const empty =
    is.totals.revenue === 0 && is.totals.operatingExpenses === 0 && is.totals.cogs === 0 && bs.totals.totalAssets === 0;
  if (empty && !args.force) return { ok: true, skipped: true, reason: 'no_activity' };

  const business = org.name?.trim() || 'your bookkeeper';
  const base = await getFirmBaseUrlForOrg(orgId);
  const footer = await getPoweredByFooter(orgId);
  const link = `${base}/reports/income-statement?start=${from}&end=${to}`;
  const subject = `${business} — your ${label} financials`;
  const row = (k: string, v: number, bold = false) =>
    `<tr><td style="padding:4px 12px 4px 0;${bold ? 'font-weight:600;' : ''}">${k}</td><td style="padding:4px 0;text-align:right;${bold ? 'font-weight:600;' : ''}">${money(v)}</td></tr>`;
  const html = `
    <div style="font-family:system-ui,Arial,sans-serif;max-width:560px;color:#18181b">
      <h2 style="margin:0 0 4px">${label} financials</h2>
      <p style="color:#71717a;margin:0 0 16px">${business} · ${from} → ${to} (${basis} basis)</p>
      <h3 style="margin:16px 0 4px">Profit &amp; Loss</h3>
      <table style="border-collapse:collapse;width:100%;font-size:14px">
        ${row('Revenue', is.totals.revenue)}
        ${row('Cost of goods sold', is.totals.cogs)}
        ${row('Gross profit', is.totals.grossProfit, true)}
        ${row('Operating expenses', is.totals.operatingExpenses)}
        ${row('Net income', is.totals.netIncome, true)}
      </table>
      <h3 style="margin:20px 0 4px">Balance Sheet (as of ${to})</h3>
      <table style="border-collapse:collapse;width:100%;font-size:14px">
        ${row('Total assets', bs.totals.totalAssets, true)}
        ${row('Total liabilities', bs.totals.totalLiabilities)}
        ${row('Total equity', bs.totals.totalLiabilitiesAndEquity - bs.totals.totalLiabilities, true)}
      </table>
      <p style="margin:24px 0">
        <a href="${link}" style="background:#2563eb;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:600">View full statements</a>
      </p>
      <p style="color:#a1a1aa;font-size:12px">Sent by ${business}${footer ? ` ${footer}` : ''}.</p>
    </div>`;

  let sent = false;
  try {
    const r = await sendTransactionalEmail({
      to: recipients,
      subject,
      html,
      brandForOrgId: orgId,
      fromName: business,
      usage: { userId: org.ownerUserId ?? '', orgId, actor: 'system', feature: 'monthly_report' },
    });
    sent = r.sent;
  } catch (e) {
    console.error('monthly-report: send failed', orgId, e);
  }

  try {
    await db.insert(aiClientOutreach).values({
      id: randomUUID(),
      organizationId: orgId,
      issueType: 'monthly_report',
      channel: 'email',
      status: sent ? 'sent' : 'failed',
      targetType: 'client_owner',
      lastMessageSubject: subject,
      lastContactAt: new Date().toISOString(),
      attempts: 1,
    });
  } catch (e) {
    console.error('monthly-report: log failed', orgId, e);
  }

  if (!sent) return { ok: false, error: 'Email send failed/skipped', recipients: recipients.length };
  return { ok: true, recipients: recipients.length };
}
