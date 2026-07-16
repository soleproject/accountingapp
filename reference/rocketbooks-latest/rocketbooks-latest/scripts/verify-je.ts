import { config } from 'dotenv';
import postgres from 'postgres';

config({ path: '.env.local' });

const sql = postgres(process.env.POSTGRES_URL_NON_POOLING!, { prepare: false, max: 1 });

async function main() {
  const orgId = process.argv[2];
  if (!orgId) {
    console.error('Usage: tsx scripts/verify-je.ts <organization_id>');
    process.exit(1);
  }

  // Pick the most recent JE for this org
  const recent = await sql<{ id: string; date: string; memo: string | null; posted: boolean }[]>`
    SELECT id, date::text AS date, memo, posted
    FROM journal_entries
    WHERE organization_id = ${orgId}
    ORDER BY created_at DESC
    LIMIT 1
  `;

  if (!recent.length) {
    console.log('No journal entries found for this org');
    await sql.end();
    return;
  }

  const je = recent[0];
  console.log('Most recent JE:');
  console.log('  id:    ', je.id);
  console.log('  date:  ', je.date);
  console.log('  memo:  ', je.memo);
  console.log('  posted:', je.posted);

  const lines = await sql<{ account_id: string; debit: string; credit: string; memo: string | null }[]>`
    SELECT account_id, debit::text, credit::text, memo
    FROM journal_entry_lines
    WHERE journal_entry_id = ${je.id}
    ORDER BY created_at
  `;

  console.log(`  lines: ${lines.length}`);
  let totalDebit = 0;
  let totalCredit = 0;
  for (const l of lines) {
    totalDebit += Number(l.debit);
    totalCredit += Number(l.credit);
    console.log(`    ${l.account_id} · D=${l.debit} C=${l.credit} ${l.memo ?? ''}`);
  }
  console.log(`  totals: D=${totalDebit.toFixed(2)} C=${totalCredit.toFixed(2)} balanced=${totalDebit === totalCredit}`);

  const gl = await sql<{ count: string }[]>`
    SELECT COUNT(*)::text AS count FROM general_ledger WHERE journal_entry_id = ${je.id}
  `;
  console.log(`  general_ledger rows: ${gl[0].count}`);

  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
