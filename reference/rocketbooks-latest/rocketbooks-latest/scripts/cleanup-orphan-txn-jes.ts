/**
 * Reverse orphan JEs of type sourceType='transaction' where:
 *   - the JE is not itself a reversal (reversal_of_id IS NULL)
 *   - no other JE reverses it
 *   - the transaction it claims to source from no longer points at it
 *     (transactions.journal_entry_id != this JE id, or null)
 *
 * These show up when splitTransaction / unsplitTransaction /
 * categorizeTransaction ran on a receipt-matched txn before
 * undo-match was wired to also reverse the txn's current JE — the
 * intermediate JE got stranded in the GL.
 *
 * Defaults to dry-run. Pass --apply to commit.
 *
 * Run:
 *   npx tsx scripts/cleanup-orphan-txn-jes.ts                # dry-run
 *   npx tsx scripts/cleanup-orphan-txn-jes.ts --apply        # commit
 *   npx tsx scripts/cleanup-orphan-txn-jes.ts --org "Acme"   # scope to org
 */
import { config } from 'dotenv';
import { eq, and, isNull, sql, ne, or } from 'drizzle-orm';
config({ path: '.env.local' });

async function main() {
  const apply = process.argv.includes('--apply');
  const orgArgIdx = process.argv.indexOf('--org');
  const orgName = orgArgIdx >= 0 ? process.argv[orgArgIdx + 1] : null;

  const { db } = await import('../db/client');
  const { journalEntries, transactions, organizations } = await import('../db/schema/schema');
  const { reverseJournalEntry } = await import('../lib/accounting/posting');

  const orgFilter = orgName
    ? (await db.select({ id: organizations.id }).from(organizations).where(eq(organizations.name, orgName)).limit(1))[0]
    : null;
  if (orgName && !orgFilter) { console.log(`Org "${orgName}" not found`); process.exit(0); }

  const candidates = await db
    .select({
      jeId: journalEntries.id,
      orgId: journalEntries.organizationId,
      orgName: organizations.name,
      sourceId: journalEntries.sourceId,
      memo: journalEntries.memo,
      date: journalEntries.date,
      txnJe: transactions.journalEntryId,
    })
    .from(journalEntries)
    .leftJoin(transactions, eq(journalEntries.sourceId, transactions.id))
    .leftJoin(organizations, eq(journalEntries.organizationId, organizations.id))
    .where(
      and(
        eq(journalEntries.sourceType, 'transaction'),
        isNull(journalEntries.reversalOfId),
        sql`NOT EXISTS (
          SELECT 1 FROM journal_entries jr WHERE jr.reversal_of_id = ${journalEntries.id}
        )`,
        or(
          isNull(transactions.journalEntryId),
          ne(transactions.journalEntryId, journalEntries.id),
        )!,
        ...(orgFilter ? [eq(journalEntries.organizationId, orgFilter.id)] : []),
      ),
    );

  console.log(`Found ${candidates.length} orphan JE(s) ${apply ? '— applying' : '(dry-run — pass --apply to commit)'}`);
  for (const c of candidates) {
    console.log(`  ${c.jeId.slice(0, 8)} | org=${c.orgName} | date=${c.date} | txn=${c.sourceId?.slice(0, 8)} (txn.je=${c.txnJe?.slice(0, 8) ?? 'null'}) | "${c.memo}"`);
    if (apply) {
      try {
        await reverseJournalEntry(
          {
            organizationId: c.orgId,
            journalEntryId: c.jeId,
            reversalMemo: `Cleanup: orphan JE from receipt-match cycle`,
          },
        );
      } catch (err) {
        console.log(`    ! reverse failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  if (!apply) console.log('\nNo DB writes performed — re-run with --apply to commit.');
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
