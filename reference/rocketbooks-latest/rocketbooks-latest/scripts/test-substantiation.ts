/**
 * Test-send the IRS substantiation request email for one org to a chosen
 * address only, scoped to a single transaction.
 * Run: npx tsx scripts/test-substantiation.ts "RocketBooks" michael@bigsaas.ai [days] [--reset]
 *
 * --reset deletes existing transaction_substantiation rows for the org first so
 * already-tracked txns re-qualify (lets you re-run the test repeatedly).
 * Uses force + overrideRecipients so the real email goes only to that address.
 */
import { existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from 'dotenv';
config({ path: '.env.local' });

function bootstrapServerOnlyStub() {
  const stubDir = join(process.cwd(), 'node_modules', 'server-only');
  const nextEmpty = join(process.cwd(), 'node_modules', 'next', 'dist', 'compiled', 'server-only', 'empty.js');
  const nextPkg = join(process.cwd(), 'node_modules', 'next', 'dist', 'compiled', 'server-only', 'package.json');
  if (!existsSync(nextEmpty)) return;
  if (!existsSync(stubDir)) mkdirSync(stubDir, { recursive: true });
  if (!existsSync(join(stubDir, 'package.json'))) copyFileSync(nextPkg, join(stubDir, 'package.json'));
  copyFileSync(nextEmpty, join(stubDir, 'index.js'));
}

async function main() {
  bootstrapServerOnlyStub();
  const orgName = process.argv[2] ?? 'RocketBooks';
  const to = process.argv[3] ?? 'michael@bigsaas.ai';
  const daysArg = process.argv.find((a) => /^\d+$/.test(a));
  const days = daysArg ? Number(daysArg) : 7;
  const reset = process.argv.includes('--reset');

  const { ilike, eq } = await import('drizzle-orm');
  const { db } = await import('../db/client');
  const { organizations, transactionSubstantiation } = await import('../db/schema/schema');
  const { findTxnsNeedingSubstantiation } = await import('../lib/accounting/substantiation');
  const { sendSubstantiationRequest } = await import('../lib/accounting/substantiation-outreach');
  const { specFor, askText } = await import('../lib/accounting/substantiation-types');

  const [org] = await db
    .select({ id: organizations.id, name: organizations.name })
    .from(organizations)
    .where(ilike(organizations.name, `%${orgName}%`))
    .limit(1);
  if (!org) { console.error(`✗ no org matching "${orgName}"`); process.exit(1); }

  if (reset) {
    const del = await db.delete(transactionSubstantiation).where(eq(transactionSubstantiation.organizationId, org.id)).returning({ id: transactionSubstantiation.id });
    console.log(`Reset: deleted ${del.length} existing substantiation row(s).`);
  }

  console.log(`Org: ${org.name} (${org.id}) · window ${days}d · sending to ${to}`);
  const needing = await findTxnsNeedingSubstantiation(org.id, days);
  console.log(`Detected ${needing.length} txn(s) needing substantiation:`);
  for (const n of needing) {
    console.log(`  • [${n.docType}] ${n.date} $${Math.abs(Number(n.amount ?? 0)).toFixed(2)} ${n.description}`);
    console.log(`      will ask: ${askText(specFor(n.docType))}`);
  }
  if (needing.length === 0) { console.error('✗ nothing to send — no qualifying txns in window'); process.exit(1); }

  const res = await sendSubstantiationRequest({ orgId: org.id, days, force: true, overrideRecipients: [to] });
  console.log('Result:', JSON.stringify(res));
  process.exit(0);
}
main().catch((err) => { console.error('✗ test send failed:', err); process.exit(1); });
