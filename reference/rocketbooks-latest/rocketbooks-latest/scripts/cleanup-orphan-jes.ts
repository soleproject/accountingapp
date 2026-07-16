/**
 * Cleanup orphaned and stale net-zero journal entries + their general ledger rows.
 *
 * Two categories handled:
 *
 * 1. ORPHANS — JEs with source_type='transaction' whose source_id no longer
 *    exists in the transactions table. Created by the prior delete-import
 *    cascade bug that only collected the latest journal_entry_id from
 *    transactions and left re-categorization residue (originals + reversers)
 *    behind. Always safe to delete: the underlying transaction is already gone.
 *
 * 2. STALE REVERSAL PAIRS — original A + reverser B where the underlying
 *    transaction T still exists but points at a different replacement JE C
 *    (i.e. T.journal_entry_id is not A.id and not B.id). Net-zero noise from
 *    re-categorization. Removed by default since they distort JE counts and
 *    GL listings; pass --keep-history to preserve them as an audit trail.
 *
 * Always safe to dry-run (default). Pass --apply to actually delete.
 * Scope to one org with --org=<orgId>; required.
 *
 * Usage:
 *   npx tsx scripts/cleanup-orphan-jes.ts --org=<orgId>             # dry run
 *   npx tsx scripts/cleanup-orphan-jes.ts --org=<orgId> --apply     # delete
 *   npx tsx scripts/cleanup-orphan-jes.ts --org=<orgId> --apply --keep-history
 */
import { config } from 'dotenv';
import postgres from 'postgres';

config({ path: '.env.local' });

interface Flags {
  org: string | null;
  apply: boolean;
  keepHistory: boolean;
}

function parseFlags(): Flags {
  const flags: Flags = { org: null, apply: false, keepHistory: false };
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--org=')) flags.org = arg.slice('--org='.length);
    else if (arg === '--apply') flags.apply = true;
    else if (arg === '--keep-history') flags.keepHistory = true;
    else if (arg === '--help' || arg === '-h') {
      console.log(
        'Usage: tsx scripts/cleanup-orphan-jes.ts --org=<orgId> [--apply] [--keep-history]',
      );
      process.exit(0);
    } else {
      console.error(`Unknown flag: ${arg}`);
      process.exit(1);
    }
  }
  return flags;
}

async function main() {
  const flags = parseFlags();
  if (!flags.org) {
    console.error('Missing --org=<orgId>');
    process.exit(1);
  }
  if (!process.env.POSTGRES_URL_NON_POOLING) {
    console.error('POSTGRES_URL_NON_POOLING not set');
    process.exit(1);
  }

  const sql = postgres(process.env.POSTGRES_URL_NON_POOLING, { prepare: false, max: 1 });
  const mode = flags.apply ? 'APPLY' : 'DRY-RUN';
  console.log(`[${mode}] org=${flags.org} keepHistory=${flags.keepHistory}`);

  try {
    // ── Category 1: orphans (source transaction is gone) ──────────────────
    const orphans = await sql<{ id: string; date: string; memo: string | null; source_id: string }[]>`
      SELECT je.id, je.date::text AS date, je.memo, je.source_id
      FROM journal_entries je
      WHERE je.organization_id = ${flags.org}
        AND je.source_type = 'transaction'
        AND je.source_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM transactions t WHERE t.id = je.source_id
        )
    `;
    console.log(`Orphans (source txn missing): ${orphans.length}`);

    // ── Category 2: stale reversal pairs (txn exists but points elsewhere) ─
    interface StalePair {
      original_id: string;
      reverser_id: string;
      txn_id: string;
      txn_journal_entry_id: string | null;
      original_memo: string | null;
      original_date: string;
    }
    const stalePairs = flags.keepHistory
      ? []
      : await sql<StalePair[]>`
          SELECT
            a.id AS original_id,
            b.id AS reverser_id,
            t.id AS txn_id,
            t.journal_entry_id AS txn_journal_entry_id,
            a.memo AS original_memo,
            a.date::text AS original_date
          FROM journal_entries a
          JOIN journal_entries b ON b.reversal_of_id = a.id AND b.organization_id = a.organization_id
          JOIN transactions t ON t.id = a.source_id AND t.organization_id = a.organization_id
          WHERE a.organization_id = ${flags.org}
            AND a.source_type = 'transaction'
            AND a.source_id IS NOT NULL
            AND (t.journal_entry_id IS NULL OR (t.journal_entry_id <> a.id AND t.journal_entry_id <> b.id))
        `;
    console.log(`Stale reversal pairs (txn exists, points elsewhere): ${stalePairs.length}`);

    const orphanIds = orphans.map((o) => o.id);
    const pairIds = stalePairs.flatMap((p) => [p.original_id, p.reverser_id]);
    const allJeIds = [...new Set([...orphanIds, ...pairIds])];

    if (allJeIds.length === 0) {
      console.log('Nothing to clean. Books look healthy.');
      return;
    }

    // Sample print
    if (orphans.length > 0) {
      console.log('\nFirst 5 orphans:');
      for (const o of orphans.slice(0, 5)) {
        console.log(`  ${o.date}  ${o.id}  ${o.memo ?? ''}`);
      }
    }
    if (stalePairs.length > 0) {
      console.log('\nFirst 5 stale reversal pairs:');
      for (const p of stalePairs.slice(0, 5)) {
        console.log(`  ${p.original_date}  A=${p.original_id} B=${p.reverser_id}  ${p.original_memo ?? ''}`);
      }
    }

    // Count GL rows + JE lines that would be deleted (for the report)
    const [{ gl_count, line_count }] = await sql<{ gl_count: number; line_count: number }[]>`
      SELECT
        (SELECT COUNT(*)::int FROM general_ledger WHERE journal_entry_id = ANY(${allJeIds})) AS gl_count,
        (SELECT COUNT(*)::int FROM journal_entry_lines WHERE journal_entry_id = ANY(${allJeIds})) AS line_count
    `;
    console.log(
      `\nWould delete: ${allJeIds.length} JEs · ${line_count} JE lines · ${gl_count} GL rows`,
    );

    if (!flags.apply) {
      console.log('\nDry run — no changes made. Re-run with --apply to execute.');
      return;
    }

    // Apply: deepest leaves first, in a single transaction.
    await sql.begin(async (tx) => {
      await tx`DELETE FROM general_ledger WHERE journal_entry_id = ANY(${allJeIds})`;
      await tx`DELETE FROM journal_entry_lines WHERE journal_entry_id = ANY(${allJeIds})`;
      // Null out transactions.journal_entry_id pointing at any deleted JE
      // (FK to journal_entries forces this before the JE delete).
      await tx`
        UPDATE transactions
        SET journal_entry_id = NULL
        WHERE organization_id = ${flags.org!}
          AND journal_entry_id = ANY(${allJeIds})
      `;
      await tx`DELETE FROM journal_entries WHERE id = ANY(${allJeIds})`;
    });
    console.log('\nDone.');
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
