import 'server-only';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { aiClientOutreach, organizations, users, arCollectionReminders } from '@/db/schema/schema';
import { chatCompletion } from '@/lib/ai/openai';
import { sendTransactionalEmail } from '@/lib/email/resend';

/** Public approve link the client clicks to authorize the customer reminders. */
export function arApproveUrl(origin: string, token: string): string {
  return `${origin.replace(/\/+$/, '')}/ar/approve/${encodeURIComponent(token)}`;
}

export interface OverdueCustomer {
  contactId: string;
  name: string;
  email: string;
  invoices: { invoiceId: string; number: string | null; dueDate: string | null; amountCents: number }[];
  totalCents: number;
}

/**
 * The client's overdue invoices grouped by customer — only customers that are
 * active and have an email (sendable). Amount per invoice = lines + tax −
 * discount − payments received; only positive balances are dunned.
 */
export async function overdueInvoicesByCustomer(orgId: string): Promise<OverdueCustomer[]> {
  const rows = (await db.execute(sql`
    select
      i.id                as invoice_id,
      i.invoice_number    as invoice_number,
      i.due_date          as due_date,
      c.id                as contact_id,
      coalesce(nullif(trim(c.company_name), ''), c.contact_name) as name,
      c.email             as email,
      (
        coalesce((select sum(il.amount) from invoice_lines il where il.invoice_id = i.id), 0)
        + coalesce(i.tax_amount, 0) - coalesce(i.discount_amount, 0)
        - coalesce((select sum(p.amount) from payments p where p.invoice_id = i.id and p.type = 'received'), 0)
      ) as amount_due
    from invoices i
    join contacts c on c.id = i.contact_id
    where i.organization_id = ${orgId}
      and i.status <> 'paid'
      and i.posted is true
      and i.due_date < current_date
      and c.email is not null
      and c.is_active is true
    order by c.id, i.due_date asc
  `)) as unknown as Array<Record<string, unknown>>;

  const byContact = new Map<string, OverdueCustomer>();
  for (const r of rows) {
    const amountCents = Math.round(Number(r.amount_due ?? 0) * 100);
    if (amountCents <= 0) continue; // credits / fully paid — nothing to dun
    const contactId = String(r.contact_id);
    let cust = byContact.get(contactId);
    if (!cust) {
      cust = {
        contactId,
        name: String(r.name ?? 'there'),
        email: String(r.email),
        invoices: [],
        totalCents: 0,
      };
      byContact.set(contactId, cust);
    }
    cust.invoices.push({
      invoiceId: String(r.invoice_id),
      number: r.invoice_number ? String(r.invoice_number) : null,
      dueDate: r.due_date ? String(r.due_date) : null,
      amountCents,
    });
    cust.totalCents += amountCents;
  }
  return [...byContact.values()];
}

/**
 * Overdue invoices grouped by customer for ACTIVE contacts that exist but have
 * a BLANK email — i.e. the ones excluded from {@link overdueInvoicesByCustomer}
 * only because we can't reach them. The follow-up page lists these with a
 * fillable email field so the user can add an address and immediately chase
 * them. (Invoices with no contact at all aren't included — there's nothing to
 * fill; they need a contact assigned first.)
 */
export async function overdueInvoicesMissingEmail(orgId: string): Promise<OverdueCustomer[]> {
  const rows = (await db.execute(sql`
    select
      i.id                as invoice_id,
      i.invoice_number    as invoice_number,
      i.due_date          as due_date,
      c.id                as contact_id,
      coalesce(nullif(trim(c.company_name), ''), c.contact_name) as name,
      (
        coalesce((select sum(il.amount) from invoice_lines il where il.invoice_id = i.id), 0)
        + coalesce(i.tax_amount, 0) - coalesce(i.discount_amount, 0)
        - coalesce((select sum(p.amount) from payments p where p.invoice_id = i.id and p.type = 'received'), 0)
      ) as amount_due
    from invoices i
    join contacts c on c.id = i.contact_id
    where i.organization_id = ${orgId}
      and i.status <> 'paid'
      and i.posted is true
      and i.due_date < current_date
      and (c.email is null or trim(c.email) = '')
      and c.is_active is true
    order by c.id, i.due_date asc
  `)) as unknown as Array<Record<string, unknown>>;

  const byContact = new Map<string, OverdueCustomer>();
  for (const r of rows) {
    const amountCents = Math.round(Number(r.amount_due ?? 0) * 100);
    if (amountCents <= 0) continue;
    const contactId = String(r.contact_id);
    let cust = byContact.get(contactId);
    if (!cust) {
      cust = { contactId, name: String(r.name ?? 'there'), email: '', invoices: [], totalCents: 0 };
      byContact.set(contactId, cust);
    }
    cust.invoices.push({
      invoiceId: String(r.invoice_id),
      number: r.invoice_number ? String(r.invoice_number) : null,
      dueDate: r.due_date ? String(r.due_date) : null,
      amountCents,
    });
    cust.totalCents += amountCents;
  }
  return [...byContact.values()];
}

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** Days since each contact was last reminded (status='sent') — for the soft note. */
export async function lastRemindedDays(orgId: string, contactIds: string[]): Promise<Record<string, number>> {
  if (contactIds.length === 0) return {};
  const rows = await db
    .select({ contactId: arCollectionReminders.contactId, last: sql<string>`max(${arCollectionReminders.sentAt})` })
    .from(arCollectionReminders)
    .where(
      and(
        eq(arCollectionReminders.organizationId, orgId),
        eq(arCollectionReminders.status, 'sent'),
        inArray(arCollectionReminders.contactId, contactIds),
      ),
    )
    .groupBy(arCollectionReminders.contactId);
  const out: Record<string, number> = {};
  for (const r of rows) {
    if (r.last) out[r.contactId] = Math.floor((Date.now() - new Date(r.last).getTime()) / 86_400_000);
  }
  return out;
}

/** Draft a single polite, accurate reminder for one customer (server-side LLM). */
export async function draftCustomerReminder(args: {
  business: string;
  customerName: string;
  customer: OverdueCustomer;
  ownerUserId: string;
  orgId: string;
}): Promise<string> {
  const lines = args.customer.invoices
    .map((inv) => `- Invoice ${inv.number ?? '(no #)'}${inv.dueDate ? `, due ${inv.dueDate}` : ''}: ${money(inv.amountCents)}`)
    .join('\n');
  const system = [
    `You are writing a brief, courteous payment reminder on behalf of ${args.business} to their customer.`,
    'Be warm, professional, and non-aggressive. Never invent amounts, invoice numbers, or dates beyond what you are given.',
    `Reference the specific invoice(s) and the total, thank them, and offer to help if they have questions. Sign off as the ${args.business} team. Plain text, no subject line.`,
  ].join(' ');
  const user = [
    `Customer: ${args.customerName}.`,
    `Overdue invoices:\n${lines}`,
    `Total past due: ${money(args.customer.totalCents)}.`,
    'Return only the email body.',
  ].join('\n');

  const res = await chatCompletion(
    { userId: args.ownerUserId, orgId: args.orgId, actor: 'enterprise', feature: 'ar_collections_draft' },
    {
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0.5,
      max_tokens: 320,
    },
  );
  const body = res.choices[0]?.message?.content?.trim();
  if (body) return body;
  // Deterministic fallback if the model returns nothing.
  return [
    `Hi ${args.customerName},`,
    '',
    `This is a friendly reminder that the following ${args.business} invoice(s) are past due:`,
    lines,
    '',
    `Total past due: ${money(args.customer.totalCents)}.`,
    '',
    'If you have any questions or have already sent payment, just reply to this email and let us know. Thank you!',
    '',
    `— The ${args.business} team`,
  ].join('\n');
}

export interface ArSendSummary {
  sent: number;
  skipped: number;
  failed: number;
  customers: number;
}

/**
 * Send one customer reminder + log it to ar_collection_reminders. Branded with
 * the client's business name, reply-to the client. Shared by the firm approve
 * flow and the client-side follow-up flow. Never throws.
 */
export async function recordAndSendReminder(args: {
  orgId: string;
  enterpriseId?: string | null;
  outreachId?: string | null;
  contactId: string;
  email: string;
  business: string;
  replyTo?: string | null;
  body: string;
  invoiceCount: number;
  totalCents: number;
  userId?: string;
}): Promise<'sent' | 'skipped' | 'failed'> {
  const footer = `\n\nThis reminder was sent on behalf of ${args.business}. Please reply with any questions.`;
  let result: 'sent' | 'skipped' | 'failed' = 'failed';
  let error: string | null = null;
  try {
    const r = await sendTransactionalEmail({
      to: args.email,
      subject: `Payment reminder from ${args.business}`,
      text: args.body + footer,
      fromName: args.business,
      ...(args.replyTo ? { replyTo: args.replyTo } : {}),
      usage: { userId: args.userId ?? '', orgId: args.orgId, actor: 'enterprise', feature: 'ar_collections_email' },
    });
    if (r.sent) result = 'sent';
    else {
      result = 'skipped';
      error = r.error ?? 'email skipped';
    }
  } catch (e) {
    result = 'failed';
    error = e instanceof Error ? e.message : 'send failed';
  }
  try {
    await db.insert(arCollectionReminders).values({
      id: randomUUID(),
      organizationId: args.orgId,
      enterpriseId: args.enterpriseId ?? null,
      outreachId: args.outreachId ?? null,
      contactId: args.contactId,
      customerEmail: args.email,
      invoiceCount: args.invoiceCount,
      totalCents: args.totalCents,
      status: result,
      error,
    });
  } catch (logErr) {
    console.error('ar-collections: failed to log reminder', args.contactId, logErr);
  }
  return result;
}

/** Was this customer already reminded within the last 7 days? */
async function recentlyReminded(orgId: string, contactId: string): Promise<boolean> {
  const [hit] = (await db.execute(sql`
    select 1 from ar_collection_reminders
    where organization_id = ${orgId} and contact_id = ${contactId}
      and status = 'sent' and sent_at > now() - interval '7 days'
    limit 1
  `)) as unknown as Array<unknown>;
  return !!hit;
}

/** Run async work with a bounded number of concurrent workers. */
async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  });
  await Promise.all(workers);
}

/**
 * Email each overdue customer a polite reminder on the client's behalf. Branded
 * with the client's business name, reply-to the client (disputes go to them).
 * Best-effort, idempotent (7-day per-customer cooldown + the single-use approve
 * gate on the calling action). Never throws.
 */
export async function sendArRemindersForOutreach(outreachId: string): Promise<ArSendSummary> {
  const empty: ArSendSummary = { sent: 0, skipped: 0, failed: 0, customers: 0 };

  const [outreach] = await db
    .select({ orgId: aiClientOutreach.organizationId, enterpriseId: aiClientOutreach.enterpriseId })
    .from(aiClientOutreach)
    .where(eq(aiClientOutreach.id, outreachId))
    .limit(1);
  if (!outreach) return empty;

  const [org] = await db
    .select({ name: organizations.name, ownerUserId: organizations.ownerUserId })
    .from(organizations)
    .where(eq(organizations.id, outreach.orgId))
    .limit(1);
  if (!org) return empty;

  const [owner] = org.ownerUserId
    ? await db.select({ email: users.email }).from(users).where(eq(users.id, org.ownerUserId)).limit(1)
    : [undefined];

  const business = org.name?.trim() || 'your bookkeeper';
  const replyTo = owner?.email ?? undefined;

  const customers = await overdueInvoicesByCustomer(outreach.orgId);
  const summary: ArSendSummary = { sent: 0, skipped: 0, failed: 0, customers: customers.length };

  await pool(customers, 5, async (cust) => {
    if (await recentlyReminded(outreach.orgId, cust.contactId)) {
      summary.skipped += 1;
      return;
    }
    let body: string;
    try {
      body = await draftCustomerReminder({
        business,
        customerName: cust.name,
        customer: cust,
        ownerUserId: org.ownerUserId ?? '',
        orgId: outreach.orgId,
      });
    } catch (e) {
      summary.failed += 1;
      console.error('ar-collections: draft failed', cust.contactId, e);
      return;
    }
    const result = await recordAndSendReminder({
      orgId: outreach.orgId,
      enterpriseId: outreach.enterpriseId,
      outreachId,
      contactId: cust.contactId,
      email: cust.email,
      business,
      replyTo,
      body,
      invoiceCount: cust.invoices.length,
      totalCents: cust.totalCents,
      userId: org.ownerUserId ?? '',
    });
    if (result === 'sent') summary.sent += 1;
    else if (result === 'skipped') summary.skipped += 1;
    else summary.failed += 1;
  });

  return summary;
}

/** Mark the outreach approved (single-use) + resolved. Returns false if already approved. */
export async function markOutreachApproved(outreachId: string): Promise<boolean> {
  const now = new Date().toISOString();
  const updated = await db
    .update(aiClientOutreach)
    .set({ approvedAt: now, status: 'resolved', updatedAt: now })
    .where(and(eq(aiClientOutreach.id, outreachId), sql`${aiClientOutreach.approvedAt} is null`))
    .returning({ id: aiClientOutreach.id });
  return updated.length > 0;
}

export interface ApproveLookup {
  outreachId: string;
  orgId: string;
  alreadyApproved: boolean;
  approvedAt: string | null;
  customerCount: number;
}

/** Resolve an approve token → the outreach + a count of dunnable customers (for the confirm page). */
export async function lookupArApprove(token: string): Promise<ApproveLookup | null> {
  const [row] = await db
    .select({ id: aiClientOutreach.id, orgId: aiClientOutreach.organizationId, approvedAt: aiClientOutreach.approvedAt })
    .from(aiClientOutreach)
    .where(eq(aiClientOutreach.approveToken, token))
    .limit(1);
  if (!row) return null;
  const customers = row.approvedAt ? [] : await overdueInvoicesByCustomer(row.orgId);
  return {
    outreachId: row.id,
    orgId: row.orgId,
    alreadyApproved: !!row.approvedAt,
    approvedAt: row.approvedAt,
    customerCount: customers.length,
  };
}
