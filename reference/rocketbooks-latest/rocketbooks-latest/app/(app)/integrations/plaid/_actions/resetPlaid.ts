'use server';

import { revalidatePath } from 'next/cache';
import { eq, and, inArray, sql, like } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  plaidAccounts,
  plaidRawTransactions,
  plaidSyncBatches,
  importedTransactions,
  transactions,
  journalEntries,
  journalEntryLines,
  generalLedger,
  organizations,
  adminAuditLog,
} from '@/db/schema/schema';
import { getCurrentOrgId, isSuperAdmin } from '@/lib/auth/org';
import { requireSession } from '@/lib/auth/session';
import { logger } from '@/lib/logger';
import { randomUUID } from 'crypto';

export interface ResetCounts {
  plaidAccounts: number;
  plaidRawTransactions: number;
  plaidSyncBatches: number;
  importedTransactions: number;
  transactions: number;
  journalEntries: number;
  journalEntryLines: number;
  generalLedger: number;
}

async function computeCounts(orgId: string): Promise<ResetCounts> {
  const accounts = await db.select({ id: plaidAccounts.id }).from(plaidAccounts).where(eq(plaidAccounts.linkedOrganizationId, orgId));
  const accountIds = accounts.map((a) => a.id);

  const txns = await db
    .select({ id: transactions.id, jeId: transactions.journalEntryId })
    .from(transactions)
    .where(and(eq(transactions.organizationId, orgId), like(transactions.reference, 'plaid:%')));
  const jeIds = Array.from(new Set(txns.map((t) => t.jeId).filter((x): x is string => !!x)));

  const empty = [{ n: 0 }];
  const [rawCount] = accountIds.length === 0 ? empty
    : await db.select({ n: sql<number>`COUNT(*)::int` }).from(plaidRawTransactions).where(inArray(plaidRawTransactions.plaidAccountId, accountIds));
  const [batchCount] = accountIds.length === 0 ? empty
    : await db.select({ n: sql<number>`COUNT(*)::int` }).from(plaidSyncBatches).where(inArray(plaidSyncBatches.plaidAccountId, accountIds));
  const [importedCount] = accountIds.length === 0 ? empty
    : await db.select({ n: sql<number>`COUNT(*)::int` }).from(importedTransactions).where(inArray(importedTransactions.plaidAccountId, accountIds));
  const [lineCount] = jeIds.length === 0 ? empty
    : await db.select({ n: sql<number>`COUNT(*)::int` }).from(journalEntryLines).where(inArray(journalEntryLines.journalEntryId, jeIds));
  const [glCount] = jeIds.length === 0 ? empty
    : await db.select({ n: sql<number>`COUNT(*)::int` }).from(generalLedger).where(inArray(generalLedger.journalEntryId, jeIds));

  return {
    plaidAccounts: accountIds.length,
    plaidRawTransactions: rawCount?.n ?? 0,
    plaidSyncBatches: batchCount?.n ?? 0,
    importedTransactions: importedCount?.n ?? 0,
    transactions: txns.length,
    journalEntries: jeIds.length,
    journalEntryLines: lineCount?.n ?? 0,
    generalLedger: glCount?.n ?? 0,
  };
}

export interface ResetState {
  counts?: ResetCounts;
  error?: string;
  ok?: boolean;
}

export async function previewReset(): Promise<ResetState> {
  const orgId = await getCurrentOrgId();
  return { counts: await computeCounts(orgId) };
}

export async function resetPlaidDataAction(_prev: ResetState | undefined, formData: FormData): Promise<ResetState | undefined> {
  const user = await requireSession();
  const orgId = await getCurrentOrgId();
  const confirm = String(formData.get('confirm') ?? '');
  if (confirm !== 'RESET') return { error: 'Type RESET to confirm' };

  const [org] = await db.select({ ownerUserId: organizations.ownerUserId }).from(organizations).where(eq(organizations.id, orgId)).limit(1);
  const isOwner = org?.ownerUserId === user.id;
  const isAdmin = await isSuperAdmin();
  if (!isOwner && !isAdmin) return { error: 'Only organization owner or super-admin can reset' };

  const counts = await computeCounts(orgId);

  await db.transaction(async (tx) => {
    const accounts = await tx.select({ id: plaidAccounts.id }).from(plaidAccounts).where(eq(plaidAccounts.linkedOrganizationId, orgId));
    const accountIds = accounts.map((a) => a.id);

    const txns = await tx
      .select({ id: transactions.id, jeId: transactions.journalEntryId })
      .from(transactions)
      .where(and(eq(transactions.organizationId, orgId), like(transactions.reference, 'plaid:%')));
    const txnIds = txns.map((t) => t.id);
    const jeIds = Array.from(new Set(txns.map((t) => t.jeId).filter((x): x is string => !!x)));

    if (jeIds.length > 0) {
      await tx.delete(generalLedger).where(inArray(generalLedger.journalEntryId, jeIds));
      await tx.delete(journalEntryLines).where(inArray(journalEntryLines.journalEntryId, jeIds));
      await tx.delete(journalEntries).where(inArray(journalEntries.id, jeIds));
    }
    if (txnIds.length > 0) {
      await tx.delete(transactions).where(inArray(transactions.id, txnIds));
    }
    if (accountIds.length > 0) {
      // FK order: rows that reference plaid_accounts must go before plaid_accounts itself
      await tx.delete(importedTransactions).where(inArray(importedTransactions.plaidAccountId, accountIds));
      await tx.delete(plaidSyncBatches).where(inArray(plaidSyncBatches.plaidAccountId, accountIds));
      await tx.delete(plaidRawTransactions).where(inArray(plaidRawTransactions.plaidAccountId, accountIds));
      await tx.delete(plaidAccounts).where(inArray(plaidAccounts.id, accountIds));
    }

    await tx.insert(adminAuditLog).values({
      id: randomUUID(),
      adminUserId: user.id,
      action: 'plaid_data_reset',
      targetType: 'organization',
      targetId: orgId,
      auditMetadata: counts,
    });
  });

  logger.warn({ orgId, userId: user.id, counts }, 'plaid data reset');
  revalidatePath('/integrations/plaid');
  revalidatePath('/transactions');
  revalidatePath('/journal-entries');
  return { ok: true, counts };
}
