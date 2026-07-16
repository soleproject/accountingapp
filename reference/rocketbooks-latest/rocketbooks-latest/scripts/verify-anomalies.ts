/**
 * End-to-end verification for Phase 2 anomaly detection, against RocketBooks.
 * Self-cleaning. Seeds vendors with history and asserts:
 *   1. amount outlier detected   2. category drift detected
 *   3. a normal vendor produces NOTHING (false-positive guard)
 *   4. writeFindings is idempotent
 *   npx tsx scripts/verify-anomalies.ts
 */
import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import { and, eq, inArray, like, or } from 'drizzle-orm';
config({ path: '.env.local' });

const T = 'ANOM_TEST';

async function main() {
  const { db } = await import('../db/client');
  const { transactions, bookReviewFindings, chartOfAccounts, contacts, organizations, users } = await import('../db/schema/schema');
  const { runAnomalySweep } = await import('../lib/audit/anomalies');
  const { writeFindings } = await import('../lib/audit/findings');

  const [org] = await db.select({ id: organizations.id }).from(organizations)
    .innerJoin(users, eq(users.id, organizations.ownerUserId))
    .where(and(eq(organizations.name, 'RocketBooks'), eq(users.email, 'michael@bigsaas.ai'))).limit(1);
  if (!org) throw new Error('RocketBooks org not found');
  const orgId = org.id;
  const now = () => new Date().toISOString();
  const dayOffset = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

  const cleanup = async () => {
    const txns = (await db.select({ id: transactions.id }).from(transactions)
      .where(and(eq(transactions.organizationId, orgId), like(transactions.description, `${T}%`)))).map((r) => r.id);
    if (txns.length) {
      await db.delete(bookReviewFindings).where(and(eq(bookReviewFindings.organizationId, orgId),
        or(inArray(bookReviewFindings.transactionId, txns), inArray(bookReviewFindings.relatedTransactionId, txns))));
      await db.delete(transactions).where(inArray(transactions.id, txns));
    }
    await db.delete(contacts).where(and(eq(contacts.organizationId, orgId), like(contacts.contactName, `${T}%`)));
    await db.delete(chartOfAccounts).where(and(eq(chartOfAccounts.organizationId, orgId), like(chartOfAccounts.accountName, `${T}%`)));
  };
  await cleanup();

  // accounts: bank + two distinct expense categories (distinct detail_type to
  // dodge UNIQUE(org, gaap_type, detail_type)).
  const bank = randomUUID(), catA = randomUUID(), catB = randomUUID();
  await db.insert(chartOfAccounts).values([
    { id: bank, organizationId: orgId, accountNumber: 'AT1', accountName: `${T} Bank`, gaapType: 'asset', normalBalance: 'debit', isActive: true, passedNameContactCheck: true },
    { id: catA, organizationId: orgId, accountNumber: 'AT2', accountName: `${T} Office Supplies`, gaapType: 'expense', detailType: 'anom_office', normalBalance: 'debit', isActive: true, passedNameContactCheck: true },
    { id: catB, organizationId: orgId, accountNumber: 'AT3', accountName: `${T} Travel`, gaapType: 'expense', detailType: 'anom_travel', normalBalance: 'debit', isActive: true, passedNameContactCheck: true },
  ]);

  const vOut = randomUUID(), vDrift = randomUUID(), vNorm = randomUUID();
  await db.insert(contacts).values([
    { id: vOut, organizationId: orgId, contactName: `${T} Outlier Vendor`, isActive: true },
    { id: vDrift, organizationId: orgId, contactName: `${T} Drift Vendor`, isActive: true },
    { id: vNorm, organizationId: orgId, contactName: `${T} Normal Vendor`, isActive: true },
  ]);

  let n = 0;
  const tx = async (contactId: string, cat: string, amount: number, date: string) => {
    const id = randomUUID();
    await db.insert(transactions).values({
      id, organizationId: orgId, date, amount, type: 'withdrawal', description: `${T} purchase ${++n}`,
      reference: `anom-test:${id}`, accountId: bank, categoryAccountId: cat, contactId, reviewed: true, createdAt: now(),
    });
    return id;
  };

  const normals = [80, 82, 79, 81, 80, 78];
  // Outlier vendor: 6 normal (historical) + 1 huge (recent today)
  for (const a of normals) await tx(vOut, catA, a, dayOffset(60));
  const outlierTxn = await tx(vOut, catA, 5000, dayOffset(0));
  // Drift vendor: 6 in catA (historical) + 1 recent in catB
  for (const a of normals) await tx(vDrift, catA, a, dayOffset(60));
  const driftTxn = await tx(vDrift, catB, 80, dayOffset(0));
  // Normal vendor: 6 historical + 1 recent, all catA ~$80
  for (const a of normals) await tx(vNorm, catA, a, dayOffset(60));
  const normalTxn = await tx(vNorm, catA, 83, dayOffset(0));

  const findings = await runAnomalySweep(orgId);
  const mine = findings.filter((f) => f.transactionId && [outlierTxn, driftTxn, normalTxn].includes(f.transactionId));
  const codeFor = (txnId: string) => mine.filter((f) => f.transactionId === txnId).map((f) => f.code);

  console.log('outlier txn codes:', codeFor(outlierTxn));
  console.log('drift txn codes  :', codeFor(driftTxn));
  console.log('normal txn codes :', codeFor(normalTxn));

  const pass1 = codeFor(outlierTxn).includes('ANOM_AMOUNT_OUTLIER');
  const pass2 = codeFor(driftTxn).includes('ANOM_CATEGORY_DRIFT');
  const pass3 = codeFor(normalTxn).length === 0;
  if (!pass1) throw new Error('FAIL: amount outlier not detected');
  if (!pass2) throw new Error('FAIL: category drift not detected');
  if (!pass3) throw new Error('FAIL: normal vendor produced a finding (false positive)');
  console.log('✓ outlier detected, drift detected, normal vendor clean');

  // Idempotency: write twice, count open findings for my txns.
  await writeFindings(orgId, findings);
  await writeFindings(orgId, findings);
  const open = await db.select({ id: bookReviewFindings.id, code: bookReviewFindings.code, txn: bookReviewFindings.transactionId })
    .from(bookReviewFindings).where(and(eq(bookReviewFindings.organizationId, orgId), eq(bookReviewFindings.status, 'open'), inArray(bookReviewFindings.transactionId, [outlierTxn, driftTxn, normalTxn])));
  const dupKeys = open.map((r) => `${r.code}:${r.txn}`);
  const unique = new Set(dupKeys);
  console.log(`✓ idempotency: ${open.length} open rows, ${unique.size} unique (must be equal)`);
  if (open.length !== unique.size) throw new Error('FAIL: idempotency — duplicate open findings');

  await cleanup();
  console.log('\nALL ANOMALY CHECKS PASSED');
  process.exit(0);
}
main().catch((e) => { console.error('✗ failed:', e); process.exit(1); });
