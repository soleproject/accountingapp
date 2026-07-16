/**
 * Second pass for the self-referential-JE repair: the first pass deleted the
 * no-op JEs but couldn't repost rows in orgs whose "Uncategorized" accounts are
 * typed other_misc_income/expense (not the exact uncategorized_* slot), leaving
 * them category=null / reviewed=false / no JE. This reposts those to the org's
 * Uncategorized Income/Expense (found by name + direction) so the bank balance
 * finally moves; they stay reviewed=false for proper categorization.
 *
 *   npx tsx scripts/repost-uncategorized-bank-txns.ts --dry-run
 *   npx tsx scripts/repost-uncategorized-bank-txns.ts
 */
import { readFileSync } from 'fs';
function readEnvLocal(k: string): string | null {
  try { for (const l of readFileSync('.env.local', 'utf8').split(/\r?\n/)) { const m = l.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/); if (m && m[1] === k) return m[2].replace(/^["']|["']$/g, ''); } } catch { /* */ }
  return null;
}

// The orgs touched by the first repair pass (6 real orgs with leftover nulls).
const ORGS = [
  'bed9ab65-271a-430e-8c39-b5b6e4e710a5', // Provisions of Providence Business Trust
  '27cbe2c7-b817-4d7a-8d34-084b64b01501', // Malachi Three Proof Family Trust
  '467379e9-00f6-4cf6-9fe7-e4c095f55e88', // Arizona Property 1, LLC
  '511e89c8-549c-4051-a6fa-92c964790acf', // Kingdom Adventures Foundation
  'fd23c2c8-9b36-4dea-80a3-75d5c5fa48c7', // Peterson Cabinets and Trim LLC
  'b0676281-22af-4521-8b2e-1cb4a614a191', // CPICA, LLC
];

async function main() {
  if (!process.env.POSTGRES_URL) {
    const u = readEnvLocal('POSTGRES_URL_NON_POOLING') ?? readEnvLocal('POSTGRES_URL');
    if (!u) throw new Error('Set POSTGRES_URL'); process.env.POSTGRES_URL = u;
  }
  const dry = process.argv.includes('--dry-run');
  const { db } = await import('@/db/client');
  const { transactions, chartOfAccounts, journalEntries } = await import('@/db/schema/schema');
  const { and, eq, sql, isNull } = await import('drizzle-orm');
  const { createJournalEntryFromTransaction } = await import('@/lib/accounting/auto-post');

  let total = 0, posted = 0, noAcct = 0, hadJe = 0, failed = 0;
  for (const org of ORGS) {
    // Candidate rows: category null + not reviewed, on a bank/credit account.
    // In these orgs every null+reviewed=false row is one the first repair pass
    // nulled (verified: per-org null count == original self-ref count), so no
    // account-type filter is needed — and the trust orgs type their bank
    // accounts in ways the bank/credit_card filter would wrongly exclude.
    const rows = await db
      .select({
        id: transactions.id, accountId: transactions.accountId, type: transactions.type,
        amount: transactions.amount, date: transactions.date, description: transactions.description,
        bankDescription: transactions.bankDescription, contactId: transactions.contactId,
      })
      .from(transactions)
      .where(and(
        eq(transactions.organizationId, org),
        isNull(transactions.categoryAccountId),
        eq(transactions.reviewed, false),
      ));
    if (rows.length === 0) continue;
    total += rows.length;
    console.log(`${org.slice(0, 8)}: ${rows.length} null bank txns`);
    if (dry) continue;

    for (const r of rows) {
      try {
        const isDep = r.type?.toLowerCase() === 'deposit';
        const [uncat] = await db
          .select({ id: chartOfAccounts.id })
          .from(chartOfAccounts)
          .where(and(
            eq(chartOfAccounts.organizationId, org),
            eq(chartOfAccounts.isActive, true),
            sql`${chartOfAccounts.accountName} ilike '%uncategor%'`,
            isDep ? sql`${chartOfAccounts.accountType} ilike '%income%'` : sql`${chartOfAccounts.accountType} ilike '%expense%'`,
          ))
          .limit(1);
        if (!uncat?.id) { noAcct++; continue; }
        // Skip if a JE already exists (shouldn't, but be safe — avoid double-post).
        const [je] = await db.select({ id: journalEntries.id }).from(journalEntries)
          .where(and(eq(journalEntries.organizationId, org), eq(journalEntries.sourceType, 'transaction'), eq(journalEntries.sourceId, r.id))).limit(1);
        if (je) { hadJe++; continue; }
        await db.transaction(async (tx) => {
          await tx.update(transactions).set({ categoryAccountId: uncat.id }).where(eq(transactions.id, r.id));
          await createJournalEntryFromTransaction({
            id: r.id, organizationId: org, date: r.date, accountId: r.accountId,
            categoryAccountId: uncat.id, amount: Number(r.amount), type: r.type,
            userDescription: r.description, bankDescription: r.bankDescription, contactId: r.contactId,
          } as Parameters<typeof createJournalEntryFromTransaction>[0], tx);
        });
        posted++;
      } catch (e) {
        failed++;
        console.error(`  ! ${org.slice(0, 8)} ${r.date} ${r.amount}:`, e instanceof Error ? e.message : e);
      }
    }
  }
  console.log(`\n${dry ? '[DRY RUN] ' : ''}total null bank txns: ${total}` + (dry ? '' : ` — reposted ${posted}, no uncat acct ${noAcct}, already had JE ${hadJe}, failed ${failed}`));
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e); process.exit(1); });
