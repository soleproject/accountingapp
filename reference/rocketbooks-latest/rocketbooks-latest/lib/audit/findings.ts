import 'server-only';
import { randomUUID } from 'crypto';
import { sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { bookReviewFindings } from '@/db/schema/schema';

/**
 * The audit layer's shared "finding" shape and the single idempotent write
 * path into book_review_findings. Detection modules (duplicates.ts,
 * integrity.ts) return AuditFinding[] descriptors; writeFindings persists them.
 *
 * Idempotency: detection re-runs every nightly sweep (and at import), so we
 * upsert on the partial unique index (org, code, subject_key) WHERE
 * status='open'. A repeat of an already-open finding just refreshes its
 * message/metadata; it never stacks duplicates-of-findings. Once a finding is
 * resolved/dismissed it leaves the partial index, so a genuinely recurring
 * issue can open a fresh row later.
 */

export type FindingKind = 'duplicate' | 'integrity' | 'anomaly';
export type FindingSeverity = 'warn' | 'info';

export interface AuditFinding {
  kind: FindingKind;
  code: string;
  severity: FindingSeverity;
  /** Canonical dedupe key within (org, code). See schema comment. */
  subjectKey: string;
  message: string;
  transactionId?: string | null;
  journalEntryId?: string | null;
  relatedTransactionId?: string | null;
  metadata?: Record<string, unknown> | null;
}

// Drizzle's tx callback param has no clean exported type, so we infer it (same
// approach as lib/accounting/posting.ts). Either the root db or a tx works.
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type Executor = typeof db | Tx;

export function formatAmount(amount: number): string {
  return '$' + Math.abs(amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Persist findings idempotently. Returns the number of rows upserted. */
export async function writeFindings(
  organizationId: string,
  findings: AuditFinding[],
  exec: Executor = db,
): Promise<number> {
  if (findings.length === 0) return 0;

  const rows = findings.map((f) => ({
    id: randomUUID(),
    organizationId,
    kind: f.kind,
    code: f.code,
    severity: f.severity,
    subjectKey: f.subjectKey,
    message: f.message,
    transactionId: f.transactionId ?? null,
    journalEntryId: f.journalEntryId ?? null,
    relatedTransactionId: f.relatedTransactionId ?? null,
    metadata: f.metadata ?? null,
  }));

  await exec
    .insert(bookReviewFindings)
    .values(rows)
    .onConflictDoUpdate({
      target: [
        bookReviewFindings.organizationId,
        bookReviewFindings.code,
        bookReviewFindings.subjectKey,
      ],
      targetWhere: sql`status = 'open'`,
      set: {
        message: sql`excluded.message`,
        metadata: sql`excluded.metadata`,
        transactionId: sql`excluded.transaction_id`,
        relatedTransactionId: sql`excluded.related_transaction_id`,
        journalEntryId: sql`excluded.journal_entry_id`,
        severity: sql`excluded.severity`,
        updatedAt: sql`now()`,
      },
    });

  return rows.length;
}
