import 'server-only';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { generalLedger, journalEntries, transactions } from '@/db/schema/schema';
import { formatAmount, type AuditFinding, type Executor } from './findings';

/**
 * Double-entry / trial-balance integrity sweep for an org. Nightly-only —
 * these are aggregate scans, too heavy for the import hot path.
 *
 * validateLines() in lib/accounting/posting.ts already blocks an unbalanced JE
 * at post time, so BAL_UNBALANCED here is a drift backstop: it catches anything
 * that wrote to the GL outside that path, or rounding accumulation.
 *
 *   BAL_UNBALANCED  — org-wide GL debits ≠ credits (one finding per org).
 *   BAL_ORPHAN_TXN  — transaction categorized but never posted to a JE, past
 *                     the 15-min stuck-pending-fallback window.
 *   BAL_ORPHAN_GL   — posted JE with no general-ledger rows.
 */

const ORPHAN_SCAN_LIMIT = 500;

export async function runIntegritySweep(
  organizationId: string,
  exec: Executor = db,
): Promise<AuditFinding[]> {
  const findings: AuditFinding[] = [];

  // 1. Trial balance — total debits must equal total credits across the GL.
  const balRows = await exec
    .select({
      debits: sql<number>`coalesce(sum(${generalLedger.debit}), 0)::float`,
      credits: sql<number>`coalesce(sum(${generalLedger.credit}), 0)::float`,
    })
    .from(generalLedger)
    .where(eq(generalLedger.organizationId, organizationId));

  const debits = balRows[0]?.debits ?? 0;
  const credits = balRows[0]?.credits ?? 0;
  const diff = Math.round((debits - credits) * 100) / 100;
  if (Math.abs(diff) >= 0.01) {
    findings.push({
      kind: 'integrity',
      code: 'BAL_UNBALANCED',
      severity: 'warn',
      subjectKey: 'org',
      message: `Books don't tie out: trial balance is off by ${formatAmount(diff)} (debits ${formatAmount(debits)} vs credits ${formatAmount(credits)}).`,
      metadata: { debits, credits, difference: diff },
    });
  }

  // 2. Orphaned transactions — categorized but no JE, older than the
  //    stuck-pending-fallback window (so genuinely orphaned, not in-flight).
  const orphanTxns = await exec
    .select({
      id: transactions.id,
      date: transactions.date,
      amount: transactions.amount,
      description: transactions.description,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.organizationId, organizationId),
        sql`${transactions.categoryAccountId} IS NOT NULL`,
        sql`${transactions.journalEntryId} IS NULL`,
        sql`${transactions.createdAt} < now() - interval '15 minutes'`,
      ),
    )
    .limit(ORPHAN_SCAN_LIMIT);

  for (const t of orphanTxns) {
    findings.push({
      kind: 'integrity',
      code: 'BAL_ORPHAN_TXN',
      severity: 'warn',
      subjectKey: `txn:${t.id}`,
      message: `Transaction is categorized but has no journal entry: ${formatAmount(t.amount ?? 0)} on ${t.date}${t.description ? ` (${t.description})` : ''}.`,
      transactionId: t.id,
      metadata: { amount: t.amount, date: t.date },
    });
  }

  // 3. Orphaned posted JEs — posted but missing general-ledger rows.
  const orphanJes = await exec
    .select({ id: journalEntries.id, date: journalEntries.date })
    .from(journalEntries)
    .leftJoin(generalLedger, eq(generalLedger.journalEntryId, journalEntries.id))
    .where(
      and(
        eq(journalEntries.organizationId, organizationId),
        eq(journalEntries.posted, true),
        sql`${generalLedger.id} IS NULL`,
      ),
    )
    .limit(ORPHAN_SCAN_LIMIT);

  for (const je of orphanJes) {
    findings.push({
      kind: 'integrity',
      code: 'BAL_ORPHAN_GL',
      severity: 'warn',
      subjectKey: `je:${je.id}`,
      message: `Posted journal entry has no general-ledger rows (dated ${je.date}).`,
      journalEntryId: je.id,
      metadata: { date: je.date },
    });
  }

  return findings;
}
