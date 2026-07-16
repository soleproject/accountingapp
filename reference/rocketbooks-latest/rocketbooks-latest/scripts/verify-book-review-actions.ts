/**
 * Proves the /book-review action logic at the data layer — the exact operations
 * resolveDuplicateFinding (reverse the duplicate's JE) and dismissBookFinding
 * (flip status) perform, minus the auth wrapper. Then seeds ONE persistent open
 * duplicate finding for manual browser verification.
 *
 * RocketBooks is an empty test org, so PROOF 1 creates two throwaway accounts
 * (distinct gaap_type to avoid the UNIQUE(org,gaap_type,detail_type) constraint)
 * to build a real balanced JE, then removes them.
 *
 *   npx tsx scripts/verify-book-review-actions.ts
 */
import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import { and, eq, inArray, like, or, sql } from 'drizzle-orm';

config({ path: '.env.local' });

const TEST = 'AUDIT_TEST_VENDOR_ZZ';

async function main() {
  const { db } = await import('../db/client');
  const { transactions, bookReviewFindings, journalEntries, journalEntryLines, generalLedger, chartOfAccounts, organizations, users } = await import('../db/schema/schema');
  const { writeFindings } = await import('../lib/audit/findings');
  const { createJournalEntry, reverseJournalEntry } = await import('../lib/accounting/posting');

  const [org] = await db
    .select({ id: organizations.id, name: organizations.name })
    .from(organizations)
    .innerJoin(users, eq(users.id, organizations.ownerUserId))
    .where(and(eq(organizations.name, 'RocketBooks'), eq(users.email, 'michael@bigsaas.ai')))
    .limit(1);
  if (!org) throw new Error('RocketBooks test org not found');
  const orgId = org.id;
  const now = () => new Date().toISOString();
  const today = now().slice(0, 10);
  console.log(`✓ org: ${org.name} (${orgId})`);

  // Delete test transactions + their JEs/GL/findings. Keeps accounts.
  const cleanTxns = async () => {
    const rows = await db.select({ id: transactions.id, je: transactions.journalEntryId }).from(transactions)
      .where(and(eq(transactions.organizationId, orgId), like(transactions.description, `${TEST}%`)));
    const txnIds = rows.map((r) => r.id);
    const jeIds = rows.map((r) => r.je).filter((x): x is string => !!x);
    if (jeIds.length > 0) {
      const rev = await db.select({ id: journalEntries.id }).from(journalEntries)
        .where(and(eq(journalEntries.organizationId, orgId), inArray(journalEntries.reversalOfId, jeIds)));
      jeIds.push(...rev.map((r) => r.id));
    }
    if (txnIds.length > 0) {
      await db.delete(bookReviewFindings).where(and(eq(bookReviewFindings.organizationId, orgId),
        or(inArray(bookReviewFindings.transactionId, txnIds), inArray(bookReviewFindings.relatedTransactionId, txnIds))));
    }
    if (jeIds.length > 0) {
      await db.delete(generalLedger).where(inArray(generalLedger.journalEntryId, jeIds));
      await db.delete(journalEntryLines).where(inArray(journalEntryLines.journalEntryId, jeIds));
    }
    if (txnIds.length > 0) await db.delete(transactions).where(inArray(transactions.id, txnIds));
    if (jeIds.length > 0) await db.delete(journalEntries).where(inArray(journalEntries.id, jeIds));
    return txnIds.length;
  };
  const cleanAccts = async () =>
    db.delete(chartOfAccounts).where(and(eq(chartOfAccounts.organizationId, orgId), like(chartOfAccounts.accountName, `${TEST}%`)));

  await cleanTxns();
  await cleanAccts();
  console.log('✓ pre-clean done');

  // Throwaway accounts (distinct gaap_type to dodge UNIQUE(org,gaap_type,detail_type)).
  const acctDr = randomUUID();
  const acctCr = randomUUID();
  await db.insert(chartOfAccounts).values([
    { id: acctDr, organizationId: orgId, accountNumber: 'AT-9001', accountName: `${TEST} Expense`, gaapType: 'expense', normalBalance: 'debit', isActive: true, passedNameContactCheck: true },
    { id: acctCr, organizationId: orgId, accountNumber: 'AT-9002', accountName: `${TEST} Bank`, gaapType: 'asset', normalBalance: 'debit', isActive: true, passedNameContactCheck: true },
  ]);

  const seedTxnWithJe = async (suffix: string, amount: number) => {
    const txnId = randomUUID();
    const je = await createJournalEntry({
      organizationId: orgId, date: today, memo: `${TEST} ${suffix}`, posted: true,
      sourceType: 'transaction', sourceId: txnId,
      lines: [{ accountId: acctDr, debit: amount, credit: 0 }, { accountId: acctCr, debit: 0, credit: amount }],
    });
    await db.insert(transactions).values({
      id: txnId, organizationId: orgId, date: today, amount, type: 'withdrawal',
      description: `${TEST} ${suffix}`, reference: `audit-test:${txnId}`,
      accountId: acctCr, categoryAccountId: acctDr, journalEntryId: je.id, reviewed: false, createdAt: now(),
    });
    return { txnId, jeId: je.id };
  };

  const dupKey = (x: string, y: string) => (x < y ? `dup:${x}:${y}` : `dup:${y}:${x}`);

  // ── PROOF 1: merge reverses the duplicate's journal entry ──────────
  console.log('\n— PROOF 1: merge —');
  const a = await seedTxnWithJe('A', 250.0);
  const b = await seedTxnWithJe('B', 250.0);
  await writeFindings(orgId, [{
    kind: 'duplicate', code: 'DUP_EXACT', severity: 'warn', subjectKey: dupKey(a.txnId, b.txnId),
    message: `Possible duplicate: two withdrawal transactions of $250.00 on ${today}.`,
    transactionId: a.txnId < b.txnId ? a.txnId : b.txnId,
    relatedTransactionId: a.txnId < b.txnId ? b.txnId : a.txnId,
  }]);
  const [finding] = await db.select({ id: bookReviewFindings.id }).from(bookReviewFindings)
    .where(and(eq(bookReviewFindings.organizationId, orgId), eq(bookReviewFindings.status, 'open'), inArray(bookReviewFindings.transactionId, [a.txnId, b.txnId])));

  await db.transaction(async (tx) => {
    await reverseJournalEntry({ organizationId: orgId, journalEntryId: b.jeId, reversalDate: today, reversalMemo: `Reversal of duplicate ${b.txnId.slice(0, 8)}` }, tx);
    await tx.update(transactions).set({ reviewed: true, userDescription: '[duplicate]' }).where(eq(transactions.id, b.txnId));
    await tx.update(bookReviewFindings).set({ status: 'resolved', resolution: 'merged', dismissedAt: now(), updatedAt: now() }).where(eq(bookReviewFindings.id, finding.id));
  });

  const reverser = await db.select({ id: journalEntries.id }).from(journalEntries).where(and(eq(journalEntries.organizationId, orgId), eq(journalEntries.reversalOfId, b.jeId)));
  const [fAfter] = await db.select({ status: bookReviewFindings.status, resolution: bookReviewFindings.resolution }).from(bookReviewFindings).where(eq(bookReviewFindings.id, finding.id));
  const net = await db.select({ acct: generalLedger.accountId, net: sql<number>`coalesce(sum(${generalLedger.debit}),0) - coalesce(sum(${generalLedger.credit}),0)` })
    .from(generalLedger).where(inArray(generalLedger.journalEntryId, [b.jeId, reverser[0]?.id ?? ''])).groupBy(generalLedger.accountId);
  const allZero = net.length > 0 && net.every((r) => Math.abs(Number(r.net)) < 0.005);
  console.log(`  reverser JE created: ${reverser.length === 1 ? 'yes' : 'NO'}`);
  console.log(`  finding → status=${fAfter.status}, resolution=${fAfter.resolution}`);
  console.log(`  duplicate JE net impact zero per account: ${allZero ? 'yes' : 'NO'} (${net.map((r) => `${r.acct?.slice(0, 6)}=${Number(r.net).toFixed(2)}`).join(', ')})`);
  if (reverser.length !== 1 || fAfter.status !== 'resolved' || !allZero) throw new Error('FAIL: merge proof');
  console.log('  ✓ MERGE PROOF PASSED');
  await cleanTxns();

  // ── PROOF 2: dismiss flips status ─────────────────────────────────
  console.log('\n— PROOF 2: dismiss —');
  const c = await seedTxnWithJe('C', 99.0);
  await writeFindings(orgId, [{
    kind: 'integrity', code: 'BAL_ORPHAN_TXN', severity: 'warn', subjectKey: `txn:${c.txnId}`,
    message: `${TEST} C orphan test`, transactionId: c.txnId,
  }]);
  const [intF] = await db.select({ id: bookReviewFindings.id }).from(bookReviewFindings).where(and(eq(bookReviewFindings.organizationId, orgId), eq(bookReviewFindings.code, 'BAL_ORPHAN_TXN'), eq(bookReviewFindings.transactionId, c.txnId)));
  await db.update(bookReviewFindings).set({ status: 'dismissed', resolution: 'kept', dismissedAt: now(), dismissedNote: 'not a real issue', updatedAt: now() }).where(eq(bookReviewFindings.id, intF.id));
  const [intAfter] = await db.select({ status: bookReviewFindings.status }).from(bookReviewFindings).where(eq(bookReviewFindings.id, intF.id));
  console.log(`  finding → status=${intAfter.status}`);
  if (intAfter.status !== 'dismissed') throw new Error('FAIL: dismiss proof');
  console.log('  ✓ DISMISS PROOF PASSED');
  await cleanTxns();
  await cleanAccts();

  // ── Persistent seed for manual browser verification (plain txns) ──
  console.log('\n— persistent seed —');
  const pa = randomUUID();
  const pb = randomUUID();
  await db.insert(transactions).values([
    { id: pa, organizationId: orgId, date: today, amount: 412.77, type: 'withdrawal', description: `${TEST} (demo dup)`, reference: `audit-test:${pa}`, reviewed: false, createdAt: now() },
    { id: pb, organizationId: orgId, date: today, amount: 412.77, type: 'withdrawal', description: `${TEST} (demo dup)`, reference: `audit-test:${pb}`, reviewed: false, createdAt: now() },
  ]);
  await writeFindings(orgId, [{
    kind: 'duplicate', code: 'DUP_EXACT', severity: 'warn', subjectKey: dupKey(pa, pb),
    message: `Possible duplicate: two withdrawal transactions of $412.77 on ${today}.`,
    transactionId: pa < pb ? pa : pb, relatedTransactionId: pa < pb ? pb : pa,
  }]);
  console.log('✓ seeded 1 OPEN duplicate finding ($412.77) — no JE, so the UI "Reverse" will just resolve it');
  console.log('  → http://localhost:3000/book-review  (sign in as michael@bigsaas.ai, RocketBooks workspace)');

  console.log('\nALL ACTION PROOFS PASSED');
  process.exit(0);
}
main().catch((err) => { console.error('✗ failed:', err); process.exit(1); });
