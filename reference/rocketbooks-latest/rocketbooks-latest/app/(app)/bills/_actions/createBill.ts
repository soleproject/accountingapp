'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { eq, and } from 'drizzle-orm';
import { db } from '@/db/client';
import { bills, billLines, contacts, chartOfAccounts } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { createJournalEntry, JournalEntryError } from '@/lib/accounting/posting';
import { requireOrgWritable, BillingLockedError } from '@/lib/billing/lockout';
import { requireDateCovered, DateNotCoveredError, buildUnlockCta } from '@/lib/billing/entitlements';
import { enqueueOutbound, fireOutboundDrain, resolveQboId } from '@/lib/qbo/mirror/outbound';
import { serializeBillToQbo, type BillLineInput } from '@/lib/qbo/mirror/serializers';
import { ensureSalesTaxExpenseAccount } from '@/lib/qbo/mirror/tax-account';
import { logger } from '@/lib/logger';

const LineSchema = z.object({
  description: z.string().max(500).optional(),
  quantity: z.coerce.number().positive(),
  unitPrice: z.coerce.number().nonnegative(),
  expenseAccountId: z.string().min(1),
});

const InputSchema = z.object({
  contactId: z.string().min(1),
  billNumber: z.string().max(60).optional(),
  billDate: z.iso.date(),
  dueDate: z.iso.date().optional(),
  memo: z.string().max(500).optional(),
  apAccountId: z.string().min(1),
  postNow: z.coerce.boolean().optional(),
  taxAmount: z.coerce.number().min(0).default(0),
  lines: z.array(LineSchema).min(1),
});

export interface CreateBillState {
  error?: string;
  unlockProductId?: string;
  unlockLabel?: string;
}

export async function createBill(_prev: CreateBillState | undefined, formData: FormData): Promise<CreateBillState | undefined> {
  const orgId = await getCurrentOrgId();
  try {
    await requireOrgWritable(orgId);
  } catch (e) {
    if (e instanceof BillingLockedError) return { error: e.message };
    throw e;
  }
  const lines: unknown[] = [];
  for (let i = 0; ; i++) {
    const desc = formData.get(`lines[${i}].description`);
    const qty = formData.get(`lines[${i}].quantity`);
    if (qty === null && desc === null) break;
    if (qty === null) continue;
    lines.push({
      description: desc ?? '',
      quantity: qty,
      unitPrice: formData.get(`lines[${i}].unitPrice`) ?? 0,
      expenseAccountId: formData.get(`lines[${i}].expenseAccountId`) ?? '',
    });
  }

  const parsed = InputSchema.safeParse({
    contactId: formData.get('contactId'),
    billNumber: formData.get('billNumber') || undefined,
    billDate: formData.get('billDate'),
    dueDate: formData.get('dueDate') || undefined,
    memo: formData.get('memo') || undefined,
    apAccountId: formData.get('apAccountId'),
    postNow: formData.get('postNow'),
    taxAmount: formData.get('taxAmount') || 0,
    lines,
  });
  if (!parsed.success) return { error: 'Invalid input — each line needs quantity, unit price, and an expense account.' };

  try {
    await requireDateCovered(orgId, parsed.data.billDate);
  } catch (e) {
    if (e instanceof DateNotCoveredError) {
      return { error: e.message, ...(await buildUnlockCta(e)) };
    }
    throw e;
  }

  const [contact] = await db.select({ id: contacts.id }).from(contacts).where(and(eq(contacts.id, parsed.data.contactId), eq(contacts.organizationId, orgId))).limit(1);
  if (!contact) return { error: 'Vendor not in this organization' };

  const accountIds = [parsed.data.apAccountId, ...parsed.data.lines.map((l) => l.expenseAccountId)];
  const orgAccounts = await db.select({ id: chartOfAccounts.id }).from(chartOfAccounts).where(eq(chartOfAccounts.organizationId, orgId));
  const orgAccountIds = new Set(orgAccounts.map((a) => a.id));
  if (accountIds.some((id) => !orgAccountIds.has(id))) return { error: 'One or more accounts not in this organization' };

  const billId = randomUUID();
  const now = new Date().toISOString();
  const lineRows = parsed.data.lines.map((l) => ({
    id: randomUUID(),
    description: l.description ?? null,
    quantity: l.quantity,
    unitPrice: l.unitPrice,
    amount: Math.round(l.quantity * l.unitPrice * 100) / 100,
    expenseAccountId: l.expenseAccountId,
  }));
  const subtotal = lineRows.reduce((s, l) => s + l.amount, 0);
  if (subtotal <= 0) return { error: 'Bill line subtotal must be positive' };
  const tax = parsed.data.taxAmount;
  const total = Math.round((subtotal + tax) * 100) / 100;

  const postNow = !!parsed.data.postNow;

  // Critical: write the bill row + the JE inside ONE transaction. If the JE
  // commits but the bill insert fails, the GL has a posted entry pointing at
  // a sourceId that doesn't exist anywhere — silent corruption.
  let queueIds: string[] = [];
  try {
    queueIds = await db.transaction(async (tx) => {
      await tx.insert(bills).values({
        id: billId,
        organizationId: orgId,
        contactId: parsed.data.contactId,
        billNumber: parsed.data.billNumber ?? null,
        billDate: parsed.data.billDate,
        dueDate: parsed.data.dueDate ?? null,
        status: postNow ? 'posted' : 'draft',
        memo: parsed.data.memo ?? null,
        taxAmount: String(tax),
        createdAt: now,
        updatedAt: now,
      });
      for (const l of lineRows) {
        await tx.insert(billLines).values({
          id: l.id,
          billId,
          description: l.description,
          quantity: String(l.quantity),
          unitPrice: String(l.unitPrice),
          amount: String(l.amount),
        });
      }

      if (postNow) {
        // JE: each expense account debited per-line; sales tax debited to
        // Sales Tax Expense (auto-created); AP credited for the gross
        // total. Mirrors the bill-inbound shape so push <-> pull round-
        // trips look the same in the books.
        const byAccount = new Map<string, number>();
        for (const l of lineRows) byAccount.set(l.expenseAccountId, (byAccount.get(l.expenseAccountId) ?? 0) + l.amount);

        const jeLines = [
          ...Array.from(byAccount.entries()).map(([accountId, amount]) => ({
            accountId,
            debit: amount,
            credit: 0,
            contactId: parsed.data.contactId,
            memo: parsed.data.memo ?? null,
          })),
        ];
        if (tax > 0) {
          const taxExpenseId = await ensureSalesTaxExpenseAccount(orgId, tx);
          jeLines.push({ accountId: taxExpenseId, debit: tax, credit: 0, contactId: parsed.data.contactId, memo: 'Sales tax (paid)' });
        }
        jeLines.push({ accountId: parsed.data.apAccountId, debit: 0, credit: total, contactId: parsed.data.contactId, memo: `Bill ${parsed.data.billNumber ?? ''}`.trim() });
        await createJournalEntry({
          organizationId: orgId,
          date: parsed.data.billDate,
          memo: parsed.data.memo ?? `Bill ${parsed.data.billNumber ?? ''}`.trim(),
          posted: true,
          sourceType: 'bill',
          sourceId: billId,
          lines: jeLines,
        }, tx);
      }

      // QBO outbound. Resolve the vendor + per-line account QBO ids from
      // entity_map. If any required ref is unmapped, log and skip the
      // enqueue — local bill still saves, user retries after the vendor /
      // accounts sync to QBO. We DELIBERATELY don't fail the bill save on
      // a missing ref: the user's local books shouldn't depend on QBO
      // mapping completeness.
      const vendorQboId = await resolveQboId(tx, orgId, 'vendor', parsed.data.contactId);
      if (!vendorQboId) {
        logger.warn({ billId, vendorLocalId: parsed.data.contactId }, 'qbo outbound skip: vendor not yet mapped');
        return [];
      }
      const lineInputs: BillLineInput[] = [];
      let allLinesMapped = true;
      for (const l of lineRows) {
        const accountQboId = await resolveQboId(tx, orgId, 'account', l.expenseAccountId);
        if (!accountQboId) {
          logger.warn({ billId, accountLocalId: l.expenseAccountId }, 'qbo outbound skip: expense account not yet mapped');
          allLinesMapped = false;
          break;
        }
        lineInputs.push({
          description: l.description,
          amount: l.amount,
          expenseAccountQboId: accountQboId,
        });
      }
      if (!allLinesMapped) return [];

      const qid = await enqueueOutbound(tx, {
        organizationId: orgId,
        entityType: 'bill',
        localId: billId,
        operation: 'create',
        payload: serializeBillToQbo({
          vendorQboId,
          txnDate: parsed.data.billDate,
          dueDate: parsed.data.dueDate ?? null,
          memo: parsed.data.memo ?? null,
          lines: lineInputs,
          taxAmount: tax,
        }) as unknown as Record<string, unknown>,
      });
      return qid ? [qid] : [];
    });
  } catch (err) {
    if (err instanceof JournalEntryError) return { error: err.message };
    throw err;
  }

  await fireOutboundDrain(queueIds);

  revalidatePath('/bills');
  redirect(`/bills/${billId}`);
}
