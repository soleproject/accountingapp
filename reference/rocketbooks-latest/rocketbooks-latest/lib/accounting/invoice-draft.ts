import 'server-only';
import { randomUUID } from 'crypto';
import { eq, and, asc, inArray } from 'drizzle-orm';
import { db } from '@/db/client';
import { invoices, invoiceLines, contacts, chartOfAccounts } from '@/db/schema/schema';
import { createJournalEntry, JournalEntryError } from './posting';
import { resolveAccount } from './resolve-account';
import { logger } from '@/lib/logger';

export interface InvoiceLineInput {
  description: string;
  quantity: number;
  unitPrice: number;
  revenueAccountId: string;
}

export interface SaveDraftInput {
  organizationId: string;
  draftId?: string;
  contactId: string;
  invoiceDate: string;
  dueDate?: string;
  invoiceNumber?: string;
  memo?: string;
  arAccountId?: string;
  lines: InvoiceLineInput[];
}

export interface DraftSnapshot {
  draftId: string;
  status: string;
  posted: boolean;
  invoiceNumber: string | null;
  invoiceDate: string;
  dueDate: string | null;
  memo: string | null;
  contact: { id: string; name: string };
  arAccount: { id: string; accountNumber: string; accountName: string } | null;
  lines: Array<{
    id: string;
    description: string;
    quantity: number;
    unitPrice: number;
    amount: number;
    revenueAccountId: string;
    revenueAccountLabel: string;
  }>;
  total: number;
  journalEntryId: string | null;
}

async function pickDefaultArAccount(orgId: string): Promise<string | null> {
  const accounts = await db
    .select({
      id: chartOfAccounts.id,
      name: chartOfAccounts.accountName,
      gaapType: chartOfAccounts.gaapType,
    })
    .from(chartOfAccounts)
    .where(and(eq(chartOfAccounts.organizationId, orgId), eq(chartOfAccounts.isActive, true)))
    .orderBy(asc(chartOfAccounts.accountNumber));
  const ar = accounts.find((a) => {
    const n = a.name.toLowerCase();
    return ['asset', 'current_asset'].includes((a.gaapType ?? '').toLowerCase()) && (n.includes('receivable') || n.includes('a/r'));
  });
  return ar?.id ?? accounts.find((a) => ['asset', 'current_asset'].includes((a.gaapType ?? '').toLowerCase()))?.id ?? null;
}

async function snapshot(orgId: string, draftId: string): Promise<DraftSnapshot | null> {
  const [inv] = await db
    .select({
      id: invoices.id,
      status: invoices.status,
      posted: invoices.posted,
      invoiceNumber: invoices.invoiceNumber,
      invoiceDate: invoices.invoiceDate,
      dueDate: invoices.dueDate,
      memo: invoices.memo,
      arAccountId: invoices.arAccountId,
      contactId: invoices.contactId,
      contactName: contacts.contactName,
      journalEntryId: invoices.journalEntryId,
    })
    .from(invoices)
    .leftJoin(contacts, eq(invoices.contactId, contacts.id))
    .where(and(eq(invoices.id, draftId), eq(invoices.organizationId, orgId)))
    .limit(1);
  if (!inv) return null;

  const [arAcct] = inv.arAccountId
    ? await db
        .select({ id: chartOfAccounts.id, accountNumber: chartOfAccounts.accountNumber, accountName: chartOfAccounts.accountName })
        .from(chartOfAccounts)
        .where(eq(chartOfAccounts.id, inv.arAccountId))
        .limit(1)
    : [];

  const lineRows = await db
    .select({
      id: invoiceLines.id,
      description: invoiceLines.description,
      quantity: invoiceLines.quantity,
      unitPrice: invoiceLines.unitPrice,
      amount: invoiceLines.amount,
      itemId: invoiceLines.itemId,
    })
    .from(invoiceLines)
    .where(eq(invoiceLines.invoiceId, inv.id))
    .orderBy(asc(invoiceLines.id));

  // line.itemId is repurposed to store the revenue account id (no FK in schema)
  const revAcctIds = Array.from(new Set(lineRows.map((l) => l.itemId).filter((x): x is string => !!x)));
  const revAccts = revAcctIds.length === 0 ? [] : await db
    .select({ id: chartOfAccounts.id, accountNumber: chartOfAccounts.accountNumber, accountName: chartOfAccounts.accountName })
    .from(chartOfAccounts)
    .where(and(eq(chartOfAccounts.organizationId, orgId), inArray(chartOfAccounts.id, revAcctIds)));
  const revMap = new Map(revAccts.map((a) => [a.id, `${a.accountNumber} · ${a.accountName}`]));

  const lines = lineRows.map((l) => ({
    id: l.id,
    description: l.description ?? '',
    quantity: Number(l.quantity),
    unitPrice: Number(l.unitPrice),
    amount: Number(l.amount),
    revenueAccountId: l.itemId ?? '',
    revenueAccountLabel: l.itemId ? (revMap.get(l.itemId) ?? '') : '',
  }));
  const total = lines.reduce((s, l) => s + l.amount, 0);

  return {
    draftId: inv.id,
    status: inv.status,
    posted: inv.posted,
    invoiceNumber: inv.invoiceNumber,
    invoiceDate: inv.invoiceDate,
    dueDate: inv.dueDate,
    memo: inv.memo,
    contact: { id: inv.contactId, name: inv.contactName ?? '' },
    arAccount: arAcct ? { id: arAcct.id, accountNumber: arAcct.accountNumber, accountName: arAcct.accountName } : null,
    lines,
    total,
    journalEntryId: inv.journalEntryId,
  };
}

export async function saveInvoiceDraft(input: SaveDraftInput): Promise<DraftSnapshot> {
  // Validate contact + accounts belong to org
  const [contact] = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(and(eq(contacts.id, input.contactId), eq(contacts.organizationId, input.organizationId)))
    .limit(1);
  if (!contact) throw new Error('Contact not in this organization');

  const arCandidate = input.arAccountId ?? (await pickDefaultArAccount(input.organizationId));
  if (!arCandidate) throw new Error('No AR account configured for this organization');

  // Tolerant resolution: UUID → accountNumber → accountName. The chat AI
  // sometimes passes an accountNumber ("4010") here despite the UUID
  // contract. Same fallback as categorize_transaction(s).
  const resolvedAr = await resolveAccount(input.organizationId, arCandidate);
  if (!resolvedAr) throw new Error('AR account not in this organization');
  if (resolvedAr.resolvedVia !== 'id') {
    logger.info(
      {
        tool: 'save_invoice_draft',
        field: 'arAccountId',
        providedAccountId: arCandidate,
        resolvedVia: resolvedAr.resolvedVia,
        resolvedToId: resolvedAr.id,
      },
      'account resolved via fallback',
    );
  }
  const arId = resolvedAr.id;

  const resolvedLines: InvoiceLineInput[] = [];
  for (const l of input.lines) {
    const resolved = await resolveAccount(input.organizationId, l.revenueAccountId);
    if (!resolved) throw new Error('One or more accounts not in this organization');
    if (resolved.resolvedVia !== 'id') {
      logger.info(
        {
          tool: 'save_invoice_draft',
          field: 'revenueAccountId',
          providedAccountId: l.revenueAccountId,
          resolvedVia: resolved.resolvedVia,
          resolvedToId: resolved.id,
        },
        'account resolved via fallback',
      );
    }
    resolvedLines.push({ ...l, revenueAccountId: resolved.id });
  }

  const now = new Date().toISOString();
  let id = input.draftId;

  await db.transaction(async (tx) => {
    if (!id) {
      id = randomUUID();
      await tx.insert(invoices).values({
        id,
        organizationId: input.organizationId,
        contactId: input.contactId,
        invoiceNumber: input.invoiceNumber ?? null,
        invoiceDate: input.invoiceDate,
        dueDate: input.dueDate ?? null,
        memo: input.memo ?? null,
        status: 'draft',
        posted: false,
        arAccountId: arId,
        createdAt: now,
        updatedAt: now,
      });
    } else {
      const [existing] = await tx
        .select({ posted: invoices.posted })
        .from(invoices)
        .where(and(eq(invoices.id, id), eq(invoices.organizationId, input.organizationId)))
        .limit(1);
      if (!existing) throw new Error('Draft invoice not found');
      if (existing.posted) throw new Error('Cannot edit a posted invoice');
      await tx
        .update(invoices)
        .set({
          contactId: input.contactId,
          invoiceNumber: input.invoiceNumber ?? null,
          invoiceDate: input.invoiceDate,
          dueDate: input.dueDate ?? null,
          memo: input.memo ?? null,
          arAccountId: arId,
          updatedAt: now,
        })
        .where(eq(invoices.id, id));
      await tx.delete(invoiceLines).where(eq(invoiceLines.invoiceId, id));
    }

    for (const line of resolvedLines) {
      const amount = Math.round(line.quantity * line.unitPrice * 100) / 100;
      await tx.insert(invoiceLines).values({
        id: randomUUID(),
        invoiceId: id!,
        description: line.description,
        quantity: String(line.quantity),
        unitPrice: String(line.unitPrice),
        amount: String(amount),
        itemId: line.revenueAccountId, // repurposing item_id to remember the revenue account
      });
    }
  });

  const snap = await snapshot(input.organizationId, id!);
  if (!snap) throw new Error('Failed to read draft after save');
  return snap;
}

export async function postInvoiceDraft(args: { organizationId: string; draftId: string }): Promise<DraftSnapshot> {
  const snap = await snapshot(args.organizationId, args.draftId);
  if (!snap) throw new Error('Draft invoice not found');
  if (snap.posted) return snap;
  if (!snap.arAccount) throw new Error('Draft has no AR account');
  if (snap.lines.length === 0) throw new Error('Draft has no lines');
  if (snap.total <= 0) throw new Error('Invoice total must be positive');
  if (snap.lines.some((l) => !l.revenueAccountId)) throw new Error('All lines must have a revenue account');

  const byAccount = new Map<string, number>();
  for (const l of snap.lines) {
    byAccount.set(l.revenueAccountId, (byAccount.get(l.revenueAccountId) ?? 0) + l.amount);
  }
  const memo = snap.memo ?? `Invoice ${snap.invoiceNumber ?? ''}`.trim();

  try {
    const result = await createJournalEntry({
      organizationId: args.organizationId,
      date: snap.invoiceDate,
      memo,
      posted: true,
      sourceType: 'invoice',
      sourceId: snap.draftId,
      lines: [
        {
          accountId: snap.arAccount.id,
          debit: snap.total,
          credit: 0,
          contactId: snap.contact.id,
          memo: `Invoice ${snap.invoiceNumber ?? ''}`.trim(),
        },
        ...Array.from(byAccount.entries()).map(([accountId, amount]) => ({
          accountId,
          debit: 0,
          credit: amount,
          contactId: snap.contact.id,
          memo: snap.memo ?? null,
        })),
      ],
    });

    const now = new Date().toISOString();
    await db
      .update(invoices)
      .set({ status: 'open', posted: true, postedAt: now, journalEntryId: result.id, updatedAt: now })
      .where(eq(invoices.id, snap.draftId));

    const final = await snapshot(args.organizationId, snap.draftId);
    if (!final) throw new Error('Failed to read invoice after posting');
    return final;
  } catch (err) {
    if (err instanceof JournalEntryError) throw err;
    throw err;
  }
}

export async function cancelInvoiceDraft(args: { organizationId: string; draftId: string }): Promise<{ ok: boolean }> {
  const snap = await snapshot(args.organizationId, args.draftId);
  if (!snap) return { ok: false };
  if (snap.posted) throw new Error('Cannot cancel a posted invoice');
  await db.transaction(async (tx) => {
    await tx.delete(invoiceLines).where(eq(invoiceLines.invoiceId, snap.draftId));
    await tx.delete(invoices).where(eq(invoices.id, snap.draftId));
  });
  return { ok: true };
}
