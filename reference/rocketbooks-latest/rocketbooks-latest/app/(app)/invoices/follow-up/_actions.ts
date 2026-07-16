'use server';

import { and, eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { db } from '@/db/client';
import { contacts, organizations, users } from '@/db/schema/schema';
import { requireSession } from '@/lib/auth/session';
import { getCurrentOrgId } from '@/lib/auth/org';
import {
  overdueInvoicesByCustomer,
  draftCustomerReminder,
  recordAndSendReminder,
  lastRemindedDays,
  type OverdueCustomer,
} from '@/lib/enterprise/ar-collections';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface SetEmailResult {
  ok: boolean;
  error?: string;
}

/**
 * Save an email address onto a customer contact so its overdue invoices become
 * chaseable. Org-scoped: the contact must belong to the active org, so a
 * tampered id can't write another org's contact.
 */
export async function setCustomerEmailAction(contactId: string, email: string): Promise<SetEmailResult> {
  await requireSession();
  const orgId = await getCurrentOrgId();
  if (!orgId) return { ok: false, error: 'No active organization.' };

  const id = String(contactId ?? '').trim();
  const addr = String(email ?? '').trim();
  if (!id) return { ok: false, error: 'Missing contact.' };
  if (!EMAIL_RE.test(addr)) return { ok: false, error: 'Enter a valid email address.' };

  const [existing] = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(and(eq(contacts.id, id), eq(contacts.organizationId, orgId)))
    .limit(1);
  if (!existing) return { ok: false, error: 'Contact not found.' };

  await db.update(contacts).set({ email: addr }).where(and(eq(contacts.id, id), eq(contacts.organizationId, orgId)));
  revalidatePath('/invoices/follow-up');
  return { ok: true };
}

export interface ReminderDraft {
  contactId: string;
  name: string;
  email: string;
  invoiceCount: number;
  totalCents: number;
  body: string;
  lastRemindedDays: number | null;
}

export interface DraftResult {
  ok: boolean;
  drafts?: ReminderDraft[];
  error?: string;
}

/** Run async work with a bounded number of concurrent workers. */
async function pool<T>(items: T[], limit: number, fn: (item: T, i: number) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
}

/** Restrict each customer to the selected invoices; drop customers with none. */
function filterToSelected(customers: OverdueCustomer[], invoiceIds: Set<string>): OverdueCustomer[] {
  const out: OverdueCustomer[] = [];
  for (const c of customers) {
    const invoices = c.invoices.filter((inv) => invoiceIds.has(inv.invoiceId));
    if (invoices.length === 0) continue;
    out.push({ ...c, invoices, totalCents: invoices.reduce((s, inv) => s + inv.amountCents, 0) });
  }
  return out;
}

const MAX_DRAFTS = 25;

/** Draft one reminder per customer for the selected overdue invoices. */
export async function draftRemindersAction(invoiceIds: string[]): Promise<DraftResult> {
  const session = await requireSession();
  const orgId = await getCurrentOrgId();
  if (!orgId) return { ok: false, error: 'No active organization.' };

  const selected = new Set(invoiceIds.filter(Boolean));
  if (selected.size === 0) return { ok: false, error: 'Select at least one invoice.' };

  const customers = filterToSelected(await overdueInvoicesByCustomer(orgId), selected).slice(0, MAX_DRAFTS);
  if (customers.length === 0) return { ok: false, error: 'Nothing selected to remind.' };

  const [org] = await db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, orgId)).limit(1);
  const business = org?.name?.trim() || 'our business';
  const remindedDays = await lastRemindedDays(orgId, customers.map((c) => c.contactId));

  const drafts: ReminderDraft[] = new Array(customers.length);
  await pool(customers, 5, async (cust, idx) => {
    let body: string;
    try {
      body = await draftCustomerReminder({ business, customerName: cust.name, customer: cust, ownerUserId: session.id, orgId });
    } catch {
      body = `Hi ${cust.name},\n\nThis is a friendly reminder that you have ${cust.invoices.length} past-due invoice(s) totaling $${(cust.totalCents / 100).toFixed(2)}. Please reply if you have any questions.\n\nThank you!`;
    }
    drafts[idx] = {
      contactId: cust.contactId,
      name: cust.name,
      email: cust.email,
      invoiceCount: cust.invoices.length,
      totalCents: cust.totalCents,
      body,
      lastRemindedDays: remindedDays[cust.contactId] ?? null,
    };
  });

  return { ok: true, drafts };
}

export interface SendResult {
  ok: boolean;
  sent: number;
  skipped: number;
  failed: number;
  error?: string;
}

/**
 * Send the (possibly edited) reminders. Recipients are re-resolved server-side
 * from the contact id against this org's overdue invoices — a tampered email
 * can't redirect a send.
 */
export async function sendRemindersAction(items: { contactId: string; body: string }[]): Promise<SendResult> {
  const session = await requireSession();
  const orgId = await getCurrentOrgId();
  if (!orgId) return { ok: false, sent: 0, skipped: 0, failed: 0, error: 'No active organization.' };
  if (!items?.length) return { ok: false, sent: 0, skipped: 0, failed: 0, error: 'Nothing to send.' };

  const byContact = new Map<string, OverdueCustomer>();
  for (const c of await overdueInvoicesByCustomer(orgId)) byContact.set(c.contactId, c);

  const [org] = await db
    .select({ name: organizations.name, ownerUserId: organizations.ownerUserId })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  const business = org?.name?.trim() || 'our business';
  const [owner] = org?.ownerUserId
    ? await db.select({ email: users.email }).from(users).where(eq(users.id, org.ownerUserId)).limit(1)
    : [undefined];
  const replyTo = owner?.email ?? undefined;

  const result: SendResult = { ok: true, sent: 0, skipped: 0, failed: 0 };
  await pool(items, 5, async (item) => {
    const cust = byContact.get(item.contactId);
    const body = (item.body ?? '').trim();
    if (!cust || !body) {
      result.skipped += 1;
      return;
    }
    const r = await recordAndSendReminder({
      orgId,
      contactId: cust.contactId,
      email: cust.email,
      business,
      replyTo,
      body,
      invoiceCount: cust.invoices.length,
      totalCents: cust.totalCents,
      userId: session.id,
    });
    if (r === 'sent') result.sent += 1;
    else if (r === 'skipped') result.skipped += 1;
    else result.failed += 1;
  });

  return result;
}
