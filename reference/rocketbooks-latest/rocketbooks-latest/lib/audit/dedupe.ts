import 'server-only';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { transactions } from '@/db/schema/schema';
import { reverseJournalEntry } from '@/lib/accounting/posting';
import { logger } from '@/lib/logger';

/**
 * Cross-source de-duplication engine.
 *
 * The same real-world charge can enter the ledger from more than one source with
 * DIFFERENT reference prefixes, so the (org, reference) unique index never catches
 * it: e.g. a Plaid feed row (`plaid:…`) and the same line from an uploaded bank
 * statement (`veryfi:…`). This module decides which row SURVIVES and quarantines
 * the other so the charge is never double-posted to the GL.
 *
 * Source of truth (higher precedence survives):  QBO > Plaid > Veryfi statement > CSV.
 * Manual / unknown-source rows are precedence -1 and are NEVER auto-quarantined —
 * a human-entered transaction is only ever flagged for review, never auto-removed.
 *
 * "Exact" match (the only tier this module auto-acts on) = SAME bank account,
 * SAME direction (deposit/withdrawal), SAME amount (to the cent), SAME calendar
 * day. Anything looser (different account, ±days) is left to the flag-only
 * review path (lib/audit/duplicates.ts) and the cross-account sweep.
 */

// transactions.amount is double precision; compare cents, never raw floats.
const AMOUNT_EPSILON = 0.01;

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Source precedence for cross-source dedup. Higher wins (survives). -1 means
 * "not an auto-dedupable source" (manual entry, unknown prefix) — protected.
 */
export function sourcePrecedence(reference: string | null | undefined): number {
  if (!reference) return -1;
  if (reference.startsWith('qbo:')) return 3;
  if (reference.startsWith('plaid:')) return 2;
  if (reference.startsWith('veryfi:')) return 1;
  if (reference.startsWith('csv:')) return 0;
  return -1;
}

/** Exact same-day twin key: account + direction + amount(cents) + date. */
export function twinKey(
  accountId: string | null,
  type: string | null,
  amount: number | null,
  date: string,
): string | null {
  if (amount == null || !type) return null;
  return `${accountId ?? ''}|${type}|${Math.round(Math.abs(amount) * 100)}|${date}`;
}

export interface TwinRow {
  id: string;
  accountId: string | null;
  type: string | null;
  amount: number | null;
  date: string;
  reference: string | null;
}

/**
 * Greedy 1:1 index over existing rows so a single survivor can't be claimed as the
 * twin of two different candidates (mirrors the existing QBO-dedup claim logic).
 */
export function buildTwinIndex(rows: TwinRow[]) {
  const map = new Map<string, { id: string; reference: string | null; used: boolean }[]>();
  for (const r of rows) {
    const key = twinKey(r.accountId, r.type, r.amount == null ? null : Number(r.amount), r.date);
    if (!key) continue;
    const list = map.get(key) ?? map.set(key, []).get(key)!;
    list.push({ id: r.id, reference: r.reference, used: false });
  }
  return {
    /** Claim the first unused twin for this key, or null. Marks it used. */
    claim(key: string | null): { id: string; reference: string | null } | null {
      if (!key) return null;
      const list = map.get(key);
      if (!list) return null;
      for (const c of list) {
        if (!c.used) {
          c.used = true;
          return { id: c.id, reference: c.reference };
        }
      }
      return null;
    },
  };
}

/** Amount-equal within the cent epsilon. Exported for callers that pre-match. */
export function amountsEqual(a: number, b: number): boolean {
  return Math.abs(a - b) < AMOUNT_EPSILON;
}

function tagDuplicate(userDescription: string | null): string {
  if (!userDescription) return '[duplicate]';
  return userDescription.startsWith('[duplicate]') ? userDescription : `[duplicate] ${userDescription}`;
}

/**
 * Quarantine an EXISTING ledger row as a duplicate of `survivorId`: reverse its
 * journal entry (idempotent — nets its GL impact to zero) and mark it
 * dedupe_state='duplicate' + link + "[duplicate]" tag. Never deletes the row
 * (FK-safe). No-ops if already quarantined. Safe inside or outside a db tx.
 */
export async function quarantineDuplicate(args: {
  organizationId: string;
  loserId: string;
  survivorId: string;
  tx?: Tx;
}): Promise<boolean> {
  const exec = args.tx ?? db;
  const [loser] = await exec
    .select({
      id: transactions.id,
      journalEntryId: transactions.journalEntryId,
      userDescription: transactions.userDescription,
      dedupeState: transactions.dedupeState,
    })
    .from(transactions)
    .where(and(eq(transactions.id, args.loserId), eq(transactions.organizationId, args.organizationId)))
    .limit(1);
  if (!loser || loser.dedupeState === 'duplicate') return false;

  if (loser.journalEntryId) {
    await reverseJournalEntry(
      {
        organizationId: args.organizationId,
        journalEntryId: loser.journalEntryId,
        reversalDate: new Date().toISOString().slice(0, 10),
        reversalMemo: `Reversal of duplicate transaction ${loser.id.slice(0, 8)}`,
      },
      args.tx,
    );
  }
  await exec
    .update(transactions)
    .set({
      dedupeState: 'duplicate',
      duplicateOfId: args.survivorId,
      reviewed: true,
      userDescription: tagDuplicate(loser.userDescription),
    })
    .where(eq(transactions.id, args.loserId));

  logger.info(
    { orgId: args.organizationId, loserId: args.loserId, survivorId: args.survivorId },
    'dedupe: quarantined duplicate (JE reversed)',
  );
  return true;
}

/**
 * Restore a quarantined duplicate back to the active ledger. Clears the dedupe
 * marker + link and strips the "[duplicate]" tag. Does NOT auto-repost the
 * reversed JE — the row returns UNPOSTED so the normal categorize/post flow (or
 * the user) re-books it deliberately.
 */
export async function restoreDuplicate(args: {
  organizationId: string;
  transactionId: string;
  tx?: Tx;
}): Promise<boolean> {
  const exec = args.tx ?? db;
  const [row] = await exec
    .select({ id: transactions.id, userDescription: transactions.userDescription, dedupeState: transactions.dedupeState })
    .from(transactions)
    .where(and(eq(transactions.id, args.transactionId), eq(transactions.organizationId, args.organizationId)))
    .limit(1);
  if (!row || row.dedupeState !== 'duplicate') return false;

  const ud = row.userDescription?.startsWith('[duplicate] ')
    ? row.userDescription.slice('[duplicate] '.length)
    : row.userDescription === '[duplicate]'
      ? null
      : row.userDescription ?? null;

  await exec
    .update(transactions)
    .set({ dedupeState: 'active', duplicateOfId: null, userDescription: ud })
    .where(eq(transactions.id, args.transactionId));
  logger.info({ orgId: args.organizationId, transactionId: args.transactionId }, 'dedupe: restored duplicate to active');
  return true;
}
