/**
 * End-to-end verification for the anomaly/duplicate detection feature.
 * Runs against the RocketBooks test org. Self-cleaning.
 *   npx tsx scripts/verify-book-review.ts
 */
import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import { and, eq, inArray, like, or, sql } from 'drizzle-orm';

config({ path: '.env.local' });

const TEST_DESC = 'AUDIT_TEST_VENDOR_ZZ';

async function main() {
  const { db } = await import('../db/client');
  const { transactions, bookReviewFindings, organizations, users } = await import('../db/schema/schema');
  const { detectDuplicates, detectDuplicatesBatch } = await import('../lib/audit/duplicates');
  const { runIntegritySweep } = await import('../lib/audit/integrity');
  const { writeFindings } = await import('../lib/audit/findings');

  const orgRows = await db
    .select({ id: organizations.id, name: organizations.name })
    .from(organizations)
    .innerJoin(users, eq(users.id, organizations.ownerUserId))
    .where(and(eq(organizations.name, 'RocketBooks'), eq(users.email, 'michael@bigsaas.ai')))
    .limit(1);
  if (orgRows.length === 0) throw new Error('RocketBooks test org not found');
  const orgId = orgRows[0].id;
  console.log(`✓ org: ${orgRows[0].name} (${orgId})`);

  // Clean any prior test rows: findings first (FK is SET NULL, so deleting
  // txns first would orphan the findings), then the test transactions.
  const cleanup = async () => {
    const ids = (
      await db.select({ id: transactions.id }).from(transactions)
        .where(and(eq(transactions.organizationId, orgId), like(transactions.description, `${TEST_DESC}%`)))
    ).map((r) => r.id);
    if (ids.length > 0) {
      await db.delete(bookReviewFindings).where(
        and(
          eq(bookReviewFindings.organizationId, orgId),
          or(inArray(bookReviewFindings.transactionId, ids), inArray(bookReviewFindings.relatedTransactionId, ids)),
        ),
      );
      await db.delete(transactions).where(inArray(transactions.id, ids));
    }
    return ids.length;
  };
  console.log(`✓ pre-clean removed ${await cleanup()} prior test txn(s)`);

  const today = new Date().toISOString().slice(0, 10);
  const idA = randomUUID();
  const idB = randomUUID();
  const pair = [idA, idB];
  await db.insert(transactions).values([
    { id: idA, organizationId: orgId, date: today, amount: 123.45, type: 'withdrawal', description: TEST_DESC, reference: `audit-test:${idA}`, createdAt: new Date().toISOString() },
    { id: idB, organizationId: orgId, date: today, amount: 123.45, type: 'withdrawal', description: TEST_DESC, reference: `audit-test:${idB}`, createdAt: new Date().toISOString() },
  ]);
  console.log('✓ seeded 2 duplicate transactions');

  const countOpenDup = async () =>
    (await db.select({ n: sql<number>`count(*)::int` }).from(bookReviewFindings)
      .where(and(
        eq(bookReviewFindings.organizationId, orgId),
        eq(bookReviewFindings.code, 'DUP_EXACT'),
        eq(bookReviewFindings.status, 'open'),
        inArray(bookReviewFindings.transactionId, pair),
      )))[0].n;

  // 1. Real-time detection.
  const rt = await detectDuplicates(orgId, { id: idB, date: today, amount: 123.45, type: 'withdrawal', contactId: null, description: TEST_DESC });
  console.log(`  detectDuplicates → ${rt.length} finding(s): ${rt.map((f) => f.code).join(', ')}`);
  if (!rt.some((f) => f.code === 'DUP_EXACT')) throw new Error('FAIL: expected DUP_EXACT from real-time detection');
  await writeFindings(orgId, rt);
  const open1 = await countOpenDup();
  console.log(`✓ open DUP_EXACT after real-time write: ${open1}`);
  if (open1 !== 1) throw new Error(`FAIL: expected 1 open finding, got ${open1}`);

  // 2. Idempotency — batch re-scan + re-write must NOT create a second row.
  const batch = await detectDuplicatesBatch(orgId);
  const batchPair = batch.filter((f) => f.transactionId && pair.includes(f.transactionId));
  console.log(`  detectDuplicatesBatch → ${batchPair.length} finding(s) for the seeded pair`);
  if (!batchPair.some((f) => f.code === 'DUP_EXACT')) throw new Error('FAIL: batch did not re-find the pair');
  await writeFindings(orgId, batch);
  const open2 = await countOpenDup();
  console.log(`✓ open DUP_EXACT after batch re-write (idempotency): ${open2}`);
  if (open2 !== 1) throw new Error(`FAIL: idempotency broken, got ${open2}`);

  // 3. Integrity sweep.
  const integrity = await runIntegritySweep(orgId);
  const unbalanced = integrity.find((f) => f.code === 'BAL_UNBALANCED');
  const byCode = integrity.reduce<Record<string, number>>((a, f) => ((a[f.code] = (a[f.code] ?? 0) + 1), a), {});
  console.log(`✓ integrity sweep → ${integrity.length} finding(s) ${JSON.stringify(byCode)}; trial balance: ${unbalanced ? 'OFF — ' + unbalanced.message : 'balanced ✓'}`);

  // 4. Action-card surfacing aggregate (mirrors lib/server/action-cards.ts).
  const cardAgg = await db.select({ kind: bookReviewFindings.kind, count: sql<number>`count(*)::int`, hasUnbalanced: sql<boolean>`bool_or(${bookReviewFindings.code} = 'BAL_UNBALANCED')` })
    .from(bookReviewFindings)
    .where(and(eq(bookReviewFindings.organizationId, orgId), eq(bookReviewFindings.status, 'open')))
    .groupBy(bookReviewFindings.kind);
  console.log(`✓ open findings by kind: ${cardAgg.map((r) => `${r.kind}=${r.count}${r.hasUnbalanced ? '(unbalanced)' : ''}`).join(', ') || 'none'}`);

  console.log(`✓ post-clean removed ${await cleanup()} test txn(s)`);
  console.log('\nALL CHECKS PASSED');
  process.exit(0);
}
main().catch((err) => { console.error('✗ verify failed:', err); process.exit(1); });
