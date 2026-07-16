import { config } from 'dotenv';
import { eq, desc, sql } from 'drizzle-orm';
config({ path: '.env.local' });
async function main() {
  const { db } = await import('../db/client');
  const { receipts, receiptLines, organizations, chartOfAccounts } = await import('../db/schema/schema');
  const [acme] = await db.select({ id: organizations.id }).from(organizations).where(eq(organizations.name, 'Acme Corp')).limit(1);
  if (!acme) { console.log('Acme not found'); process.exit(0); }

  const [r] = await db.select({ id: receipts.id, total: receipts.totalAmount, raw: receipts.veryfiRawJson, source: receipts.sourceAccountId }).from(receipts).where(eq(receipts.organizationId, acme.id)).orderBy(desc(receipts.id)).limit(1);
  if (!r) { console.log('no receipt'); process.exit(0); }
  console.log(`Receipt ${r.id.slice(0, 8)} total=$${r.total} source=${r.source ?? 'NULL'}`);

  const lines = await db
    .select({ desc: receiptLines.description, amt: receiptLines.amount, exp: receiptLines.expenseAccountId, sug: receiptLines.suggestedAccountId, expName: chartOfAccounts.accountName })
    .from(receiptLines)
    .leftJoin(chartOfAccounts, eq(receiptLines.suggestedAccountId, chartOfAccounts.id))
    .where(eq(receiptLines.receiptId, r.id));
  let lineSum = 0;
  let withAccount = 0;
  for (const l of lines) {
    lineSum += Number(l.amt);
    const acct = l.exp ?? l.sug;
    if (acct) withAccount += 1;
    console.log(`  ${l.desc?.slice(0, 18).padEnd(18)} | $${l.amt} | exp=${l.exp?.slice(0,8) ?? '—'} | sug=${l.sug?.slice(0,8) ?? '—'} ${l.expName ? `(${l.expName})` : ''}`);
  }
  console.log(`\n  lines: ${lines.length} | with account: ${withAccount} | sum: $${lineSum.toFixed(2)}`);

  if (r.raw) {
    const p = JSON.parse(r.raw) as { tax?: number; subtotal?: number; total?: number };
    console.log(`\n  Veryfi: subtotal=${p.subtotal} tax=${p.tax} total=${p.total}`);
    console.log(`  Expected for apply: lineSum (${lineSum.toFixed(2)}) + tax (${p.tax ?? 0}) = ${(lineSum + (p.tax ?? 0)).toFixed(2)}`);
  }
  process.exit(0);
}
main().catch(console.error);
