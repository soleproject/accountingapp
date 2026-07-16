/**
 * End-to-end verification for the month-end close ladder, against RocketBooks.
 * Drives the REAL posting chokepoint (createJournalEntry/reverseJournalEntry) to
 * prove a closed month blocks posting + reversal and reopen restores it. Uses a
 * far-future test month (2098-01/02) + throwaway accounts so it can't touch real
 * data. Self-cleaning.
 *   npx tsx scripts/verify-period-close.ts
 */
import { config } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, like } from 'drizzle-orm';
config({ path: '.env.local' });

const TAG = 'PERIOD_TEST';
const Y = 2098;

async function main() {
  const { db } = await import('../db/client');
  const { organizations, users, chartOfAccounts, accountingPeriods, journalEntries, journalEntryLines, generalLedger } = await import('../db/schema/schema');
  const { createJournalEntry, reverseJournalEntry, JournalEntryError } = await import('../lib/accounting/posting');
  const { assertPeriodOpen } = await import('../lib/accounting/period-close');

  const [org] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .innerJoin(users, eq(users.id, organizations.ownerUserId))
    .where(and(eq(organizations.name, 'RocketBooks'), eq(users.email, 'michael@bigsaas.ai')))
    .limit(1);
  if (!org) throw new Error('RocketBooks org not found');
  const orgId = org.id;

  const cleanup = async () => {
    const jes = (await db.select({ id: journalEntries.id }).from(journalEntries)
      .where(and(eq(journalEntries.organizationId, orgId), like(journalEntries.memo, `${TAG}%`)))).map((r) => r.id);
    if (jes.length) {
      await db.delete(generalLedger).where(inArray(generalLedger.journalEntryId, jes));
      await db.delete(journalEntryLines).where(inArray(journalEntryLines.journalEntryId, jes));
      await db.delete(journalEntries).where(inArray(journalEntries.id, jes));
    }
    await db.delete(chartOfAccounts).where(and(eq(chartOfAccounts.organizationId, orgId), like(chartOfAccounts.accountName, `${TAG}%`)));
    await db.delete(accountingPeriods).where(and(eq(accountingPeriods.organizationId, orgId), eq(accountingPeriods.year, Y)));
  };
  await cleanup();

  // throwaway accounts (distinct gaap_type to dodge UNIQUE(org,gaap_type,detail_type)).
  const acctA = randomUUID(), acctB = randomUUID();
  await db.insert(chartOfAccounts).values([
    { id: acctA, organizationId: orgId, accountNumber: 'PT1', accountName: `${TAG} Expense`, gaapType: 'expense', normalBalance: 'debit', isActive: true, passedNameContactCheck: true },
    { id: acctB, organizationId: orgId, accountNumber: 'PT2', accountName: `${TAG} Bank`, gaapType: 'asset', normalBalance: 'debit', isActive: true, passedNameContactCheck: true },
  ]);
  const lines = [{ accountId: acctA, debit: 100, credit: 0 }, { accountId: acctB, debit: 0, credit: 100 }];
  const post = (date: string) => createJournalEntry({ organizationId: orgId, date, memo: `${TAG} ${date}`, posted: true, lines });
  const isBlocked = async (fn: () => Promise<unknown>) => { try { await fn(); return false; } catch (e) { if (e instanceof JournalEntryError) return true; throw e; } };

  const janDate = `${Y}-01-15`, febDate = `${Y}-02-15`;

  // 1. open month: assert + real post succeed
  await assertPeriodOpen(orgId, janDate);
  const je1 = await post(janDate);
  console.log('✓ open month: assertPeriodOpen ok, createJournalEntry ok');

  // 2. close Jan
  await db.insert(accountingPeriods).values({ id: randomUUID(), organizationId: orgId, year: Y, month: 1, status: 'closed', closedAt: new Date().toISOString() });

  // 3/4/5. closed month blocks assert, new post, and reversal of the existing JE
  const assertBlocked = await isBlocked(() => assertPeriodOpen(orgId, janDate));
  const postBlocked = await isBlocked(() => post(janDate));
  const revBlocked = await isBlocked(() => reverseJournalEntry({ organizationId: orgId, journalEntryId: je1.id }));
  console.log(`✓ closed month blocks: assert=${assertBlocked}, post=${postBlocked}, reversal=${revBlocked}`);
  if (!assertBlocked || !postBlocked || !revBlocked) throw new Error('FAIL: closed month did not block');

  // 6. a different open month still posts
  const je2 = await post(febDate);
  console.log(`✓ other month (Feb) still open: post ok (${je2.id.slice(0, 8)})`);

  // 7. reopen Jan → posting works again
  await db.update(accountingPeriods).set({ status: 'open', closedAt: null, closedByUserId: null }).where(and(eq(accountingPeriods.organizationId, orgId), eq(accountingPeriods.year, Y), eq(accountingPeriods.month, 1)));
  const reopenedOk = !(await isBlocked(() => post(janDate)));
  console.log(`✓ after reopen: post ok = ${reopenedOk}`);
  if (!reopenedOk) throw new Error('FAIL: reopen did not restore posting');

  await cleanup();
  console.log('\nALL PERIOD-CLOSE CHECKS PASSED');
  process.exit(0);
}
main().catch((e) => { console.error('✗ failed:', e); process.exit(1); });
