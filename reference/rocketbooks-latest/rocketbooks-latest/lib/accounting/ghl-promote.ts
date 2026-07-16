import 'server-only';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { db } from '@/db/client';
import { ghlRawPayments, transactions } from '@/db/schema/schema';
import { findOrCreateContact } from './ensure-contact';
import { logger } from '@/lib/logger';

// Promote raw GHL payments → transactions, REVIEW-ONLY (Phase 1).
//
// Deliberately unlike plaid-promote: NO categorization and NO journal entry.
// A GHL payment is a revenue *event*, and the same money also arrives in the
// Plaid bank feed a day or two later. Auto-posting revenue here would
// double-count against that deposit (the bug scripts/cleanup-plaid-duplicates
// had to undo). So we land each payment as an unreviewed transaction tagged
// reference='ghl:<id>'; a human categorizes it and the reconciliation step
// matches it to the bank deposit before anything hits the ledger. Auto-post
// via an undeposited-funds clearing account is Phase 2.
//
// Dedup: reuses the transactions (organization_id, reference) partial unique
// index — same guard as Plaid, just a 'ghl:' prefix instead of 'plaid:'.

export interface PromoteGhlResult {
  promoted: number;
  skipped: number;
  newTransactionIds: string[];
}

export async function promoteGhlConnection(args: {
  organizationId: string;
  ghlConnectionId: string;
}): Promise<PromoteGhlResult> {
  const { organizationId, ghlConnectionId } = args;

  const rawRows = await db
    .select()
    .from(ghlRawPayments)
    .where(eq(ghlRawPayments.ghlConnectionId, ghlConnectionId));
  if (rawRows.length === 0) {
    return { promoted: 0, skipped: 0, newTransactionIds: [] };
  }

  // Cost guard: skip refs already promoted so we don't re-run contact
  // resolution for them. The unique index + onConflictDoNothing is the real
  // correctness guard (handles concurrent runs).
  const refs = rawRows.map((r) => `ghl:${r.ghlPaymentId}`);
  const existing = await db
    .select({ reference: transactions.reference })
    .from(transactions)
    .where(
      and(
        eq(transactions.organizationId, organizationId),
        inArray(transactions.reference, refs),
      ),
    );
  const existingRefs = new Set(existing.map((e) => e.reference));

  const newTransactionIds: string[] = [];
  let promoted = 0;
  let skipped = 0;

  for (const r of rawRows) {
    const reference = `ghl:${r.ghlPaymentId}`;
    if (existingRefs.has(reference)) {
      skipped++;
      continue;
    }

    // Money IN → revenue, so 'deposit'. typeTags on the contact infer
    // 'customer' from this.
    const contactId = await findOrCreateContact({
      organizationId,
      merchantName: r.contactName,
      type: 'deposit',
    });

    // NOTE: amount unit (dollars vs cents) is UNVERIFIED against live GHL
    // payloads — see ghl-sync toAmount(). The stored value is assumed to be
    // dollars. Review-only means a wrong unit can never auto-post; this is the
    // single place to correct it once confirmed.
    const amount = Math.abs(Number(r.amount) || 0);
    const id = randomUUID();
    const now = new Date().toISOString();

    const inserted = await db
      .insert(transactions)
      .values({
        id,
        organizationId,
        date: r.date,
        description: r.description ?? r.contactName ?? 'GHL payment',
        bankDescription: r.description ?? null,
        reference,
        amount,
        type: 'deposit',
        // No accountId: GHL is not a bank account. No categoryAccountId / no
        // journalEntryId: review-only, nothing posted.
        contactId,
        reviewed: false,
        createdAt: now,
      })
      .onConflictDoNothing({
        target: [transactions.organizationId, transactions.reference],
        where: sql`${transactions.reference} IS NOT NULL`,
      })
      .returning({ id: transactions.id });

    if (inserted.length > 0) {
      promoted++;
      newTransactionIds.push(id);
    } else {
      skipped++;
    }
  }

  logger.info({ organizationId, ghlConnectionId, promoted, skipped }, 'ghl promote done');
  return { promoted, skipped, newTransactionIds };
}
