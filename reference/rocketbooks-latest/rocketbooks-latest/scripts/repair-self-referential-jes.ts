/**
 * Repair transactions whose categoryAccountId == their bank accountId — these
 * produced self-cancelling journal entries (debit + credit on the same account,
 * $0 net), so the bank's money never reached the ledger. For each: delete the
 * bad JE, re-point the category to the org's Uncategorized Income/Expense
 * account (reviewed=false), and re-post a correct JE so the bank balance moves.
 *
 *   $env:POSTGRES_URL = "<prod non-pooling>"   # or POSTGRES_URL_NON_POOLING in .env.local
 *   npx tsx scripts/repair-self-referential-jes.ts --org <uuid> --dry-run
 *   npx tsx scripts/repair-self-referential-jes.ts --org <uuid>
 *   npx tsx scripts/repair-self-referential-jes.ts --all
 */
import { readFileSync } from 'fs';

function readEnvLocal(k: string): string | null {
  try {
    for (const l of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
      const m = l.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (m && m[1] === k) return m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* ignore */ }
  return null;
}

async function main() {
  if (!process.env.POSTGRES_URL) {
    const u = readEnvLocal('POSTGRES_URL_NON_POOLING') ?? readEnvLocal('POSTGRES_URL');
    if (!u) throw new Error('Set POSTGRES_URL or POSTGRES_URL_NON_POOLING');
    process.env.POSTGRES_URL = u;
  }
  const a = process.argv.slice(2);
  const orgId = a.includes('--org') ? a[a.indexOf('--org') + 1] : null;
  const all = a.includes('--all');
  const dry = a.includes('--dry-run');
  if (!orgId && !all) { console.error('Pass --org <uuid> or --all (use --dry-run first).'); process.exit(1); }

  const { db } = await import('@/db/client');
  const { transactions, chartOfAccounts, journalEntries, journalEntryLines, generalLedger } = await import('@/db/schema/schema');
  const { and, eq, sql } = await import('drizzle-orm');
  const { createJournalEntryFromTransaction } = await import('@/lib/accounting/auto-post');

  // Self-referential transactions.
  const rows = await db
    .select({
      id: transactions.id, orgId: transactions.organizationId, accountId: transactions.accountId,
      type: transactions.type, amount: transactions.amount, date: transactions.date,
      description: transactions.description, bankDescription: transactions.bankDescription,
      contactId: transactions.contactId,
    })
    .from(transactions)
    .where(
      and(
        sql`${transactions.categoryAccountId} = ${transactions.accountId}`,
        orgId ? eq(transactions.organizationId, orgId) : sql`true`,
      ),
    );

  console.log(`${dry ? '[DRY RUN] ' : ''}self-referential transactions found: ${rows.length}${orgId ? ` (org ${orgId})` : ' (all orgs)'}`);
  if (rows.length === 0) { process.exit(0); }

  // Group count by org for visibility.
  const byOrg = new Map<string, number>();
  for (const r of rows) byOrg.set(r.orgId, (byOrg.get(r.orgId) ?? 0) + 1);
  for (const [o, n] of byOrg) console.log(`  org ${o}: ${n}`);

  if (dry) {
    for (const r of rows.slice(0, 10)) console.log(`  - ${r.date} ${r.type} ${r.amount} ${String(r.description ?? '').slice(0, 40)}`);
    console.log('\n[DRY RUN] no changes made.');
    process.exit(0);
  }

  let fixed = 0, posted = 0, skipped = 0, failed = 0;
  for (const r of rows) {
   try {
    // Find the org's uncategorized account for the right direction.
    const wantType = r.type?.toLowerCase() === 'deposit' ? 'other_income' : 'other_expense';
    const wantDetail = r.type?.toLowerCase() === 'deposit' ? 'uncategorized_income' : 'uncategorized_expense';
    const [uncat] = await db
      .select({ id: chartOfAccounts.id })
      .from(chartOfAccounts)
      .where(and(eq(chartOfAccounts.organizationId, r.orgId), eq(chartOfAccounts.accountType, wantType), eq(chartOfAccounts.detailType, wantDetail)))
      .limit(1);

    await db.transaction(async (tx) => {
      // Delete the bad (self-cancelling) JE for this transaction.
      const jes = await tx.select({ id: journalEntries.id }).from(journalEntries)
        .where(and(eq(journalEntries.organizationId, r.orgId), eq(journalEntries.sourceType, 'transaction'), eq(journalEntries.sourceId, r.id)));
      const ids = jes.map((j) => j.id);
      if (ids.length) {
        const inl = sql.join(ids.map((i) => sql`${i}`), sql`, `);
        await tx.delete(generalLedger).where(sql`journal_entry_id in (${inl})`);
        await tx.delete(journalEntryLines).where(sql`journal_entry_id in (${inl})`);
        await tx.delete(journalEntries).where(sql`id in (${inl})`);
      }
      // Re-point the category (or null if no uncategorized slot), force review.
      await tx.update(transactions)
        .set({ categoryAccountId: uncat?.id ?? null, reviewed: false })
        .where(eq(transactions.id, r.id));

      // Re-post a correct JE if we have a real counter account.
      if (uncat?.id) {
        await createJournalEntryFromTransaction({
          id: r.id, organizationId: r.orgId, date: r.date, accountId: r.accountId,
          categoryAccountId: uncat.id, amount: Number(r.amount), type: r.type,
          userDescription: r.description, bankDescription: r.bankDescription, contactId: r.contactId,
        } as Parameters<typeof createJournalEntryFromTransaction>[0], tx);
        posted++;
      } else {
        skipped++;
      }
    });
    fixed++;
   } catch (e) {
    failed++;
    console.error(`  ! ${r.orgId.slice(0, 8)} ${r.date} ${r.amount}:`, e instanceof Error ? e.message : e);
   }
  }
  console.log(`\nrepaired ${fixed} txns — reposted ${posted}, left uncategorized (no slot) ${skipped}, failed ${failed}`);
  console.log('(re-run to retry any failed/connection-dropped rows — idempotent)');
  process.exit(0);
}
main().catch((e) => { console.error('REPAIR FAILED:', e); process.exit(1); });
