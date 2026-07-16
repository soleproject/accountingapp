/**
 * Repair transactions whose categoryAccountId points at a BANK account (a
 * transfer's contra leg auto-resolved to an arbitrary bank account, e.g. the
 * empty "Checking" default). That dumps transfer activity into a bank account
 * and wrecks Cash on Hand. For each: delete the JE, re-point the category to the
 * org's Uncategorized Income/Expense (by direction), repost — the source-bank
 * leg is preserved (so reconciliation holds), the bad bank-counter leg is gone.
 *
 *   npx tsx scripts/repair-bank-categorized-txns.ts --org <uuid> --dry-run
 *   npx tsx scripts/repair-bank-categorized-txns.ts --org <uuid>
 *   npx tsx scripts/repair-bank-categorized-txns.ts --all
 */
import { readFileSync } from 'fs';
function readEnvLocal(k: string): string | null {
  try { for (const l of readFileSync('.env.local', 'utf8').split(/\r?\n/)) { const m = l.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/); if (m && m[1] === k) return m[2].replace(/^["']|["']$/g, ''); } } catch { /* */ }
  return null;
}

async function main() {
  if (!process.env.POSTGRES_URL) {
    const u = readEnvLocal('POSTGRES_URL_NON_POOLING') ?? readEnvLocal('POSTGRES_URL');
    if (!u) throw new Error('Set POSTGRES_URL'); process.env.POSTGRES_URL = u;
  }
  const a = process.argv.slice(2);
  const orgId = a.includes('--org') ? a[a.indexOf('--org') + 1] : null;
  const all = a.includes('--all');
  const dry = a.includes('--dry-run');
  if (!orgId && !all) { console.error('Pass --org <uuid> or --all (use --dry-run first).'); process.exit(1); }

  const { db } = await import('@/db/client');
  const { transactions, chartOfAccounts, journalEntries, journalEntryLines, generalLedger } = await import('@/db/schema/schema');
  const { and, eq, sql, inArray } = await import('drizzle-orm');
  const { createJournalEntryFromTransaction } = await import('@/lib/accounting/auto-post');

  // All bank-account ids (scoped to org if given), then txns categorized to one.
  const bankAccts = await db
    .select({ id: chartOfAccounts.id })
    .from(chartOfAccounts)
    .where(and(eq(chartOfAccounts.accountType, 'bank'), orgId ? eq(chartOfAccounts.organizationId, orgId) : sql`true`));
  const bankIds = bankAccts.map((b) => b.id);
  if (bankIds.length === 0) { console.log('no bank accounts'); process.exit(0); }

  const rows = await db
    .select({
      id: transactions.id, orgId: transactions.organizationId, accountId: transactions.accountId,
      type: transactions.type, amount: transactions.amount, date: transactions.date,
      description: transactions.description, bankDescription: transactions.bankDescription, contactId: transactions.contactId,
    })
    .from(transactions)
    .where(and(inArray(transactions.categoryAccountId, bankIds), orgId ? eq(transactions.organizationId, orgId) : sql`true`));

  console.log(`${dry ? '[DRY RUN] ' : ''}txns categorized to a bank account: ${rows.length}${orgId ? ` (org ${orgId})` : ' (all orgs)'}`);
  if (rows.length === 0) process.exit(0);
  const byOrg = new Map<string, number>();
  for (const r of rows) byOrg.set(r.orgId, (byOrg.get(r.orgId) ?? 0) + 1);
  for (const [o, n] of byOrg) console.log(`  ${o.slice(0, 8)}: ${n}`);
  if (dry) { console.log('\n[DRY RUN] no changes.'); process.exit(0); }

  let fixed = 0, noAcct = 0, failed = 0;
  for (const r of rows) {
    try {
      const isDep = r.type?.toLowerCase() === 'deposit';
      const [uncat] = await db
        .select({ id: chartOfAccounts.id })
        .from(chartOfAccounts)
        .where(and(
          eq(chartOfAccounts.organizationId, r.orgId),
          eq(chartOfAccounts.isActive, true),
          // Prefer an "Uncategorized" account; fall back to "Other Income/Expense"
          // for orgs (e.g. QBO-imported) that don't have an uncategorized bucket.
          sql`(${chartOfAccounts.accountName} ilike '%uncategor%' or ${chartOfAccounts.accountName} ilike '%other%')`,
          isDep ? sql`${chartOfAccounts.accountType} ilike '%income%'` : sql`${chartOfAccounts.accountType} ilike '%expense%'`,
        ))
        .orderBy(sql`case when ${chartOfAccounts.accountName} ilike '%uncategor%' then 0 else 1 end`)
        .limit(1);
      if (!uncat?.id) { noAcct++; continue; }
      await db.transaction(async (tx) => {
        const jes = await tx.select({ id: journalEntries.id }).from(journalEntries)
          .where(and(eq(journalEntries.organizationId, r.orgId), eq(journalEntries.sourceType, 'transaction'), eq(journalEntries.sourceId, r.id)));
        const ids = jes.map((j) => j.id);
        if (ids.length) {
          const inl = sql.join(ids.map((i) => sql`${i}`), sql`, `);
          await tx.delete(generalLedger).where(sql`journal_entry_id in (${inl})`);
          await tx.delete(journalEntryLines).where(sql`journal_entry_id in (${inl})`);
          await tx.delete(journalEntries).where(sql`id in (${inl})`);
        }
        await tx.update(transactions).set({ categoryAccountId: uncat.id, reviewed: false }).where(eq(transactions.id, r.id));
        await createJournalEntryFromTransaction({
          id: r.id, organizationId: r.orgId, date: r.date, accountId: r.accountId,
          categoryAccountId: uncat.id, amount: Number(r.amount), type: r.type,
          userDescription: r.description, bankDescription: r.bankDescription, contactId: r.contactId,
        } as Parameters<typeof createJournalEntryFromTransaction>[0], tx);
      });
      fixed++;
    } catch (e) {
      failed++;
      console.error(`  ! ${r.orgId.slice(0, 8)} ${r.date} ${r.amount}:`, e instanceof Error ? e.message : e);
    }
  }
  console.log(`\nrepaired ${fixed} — no uncat acct ${noAcct}, failed ${failed}. (re-run to retry; idempotent)`);
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e); process.exit(1); });
