/**
 * Test-send the monthly report email for one org to a chosen address only.
 * Run: npx tsx scripts/test-monthly-report.ts "1134, LLC" michael@bigsaas.ai
 * Uses force + overrideRecipients so it sends the real email to just that
 * address (no client gets it) regardless of dedup/opt-in.
 */
import { existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from 'dotenv';
config({ path: '.env.local' });

// tsx can't resolve `import 'server-only'` — copy Next's empty stub in.
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
  const orgName = process.argv[2] ?? '1134, LLC';
  const to = process.argv[3] ?? 'michael@bigsaas.ai';

  const { ilike } = await import('drizzle-orm');
  const { db } = await import('../db/client');
  const { organizations } = await import('../db/schema/schema');
  const { sendMonthlyReport, priorMonthRange } = await import('../lib/reports/monthly-report');

  const [org] = await db
    .select({ id: organizations.id, name: organizations.name })
    .from(organizations)
    .where(ilike(organizations.name, `%${orgName}%`))
    .limit(1);
  if (!org) { console.error(`✗ no org matching "${orgName}"`); process.exit(1); }

  const range = priorMonthRange();
  console.log(`Org: ${org.name} (${org.id}) · period ${range.from} → ${range.to} · sending to ${to}`);

  const res = await sendMonthlyReport({ orgId: org.id, force: true, overrideRecipients: [to] });
  console.log('Result:', JSON.stringify(res));
  process.exit(0);
}
main().catch((err) => { console.error('✗ test send failed:', err); process.exit(1); });
