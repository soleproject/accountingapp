/**
 * Diagnostic: for an org's bank/credit accounts, break down the transactions
 * by SOURCE (reference prefix — plaid / veryfi / qbo / manual) so you can see
 * whether non-bank-feed postings (e.g. QBO-migration duplicates, manual entries)
 * are inflating the ledger vs what the bank feed actually shows. Read-only.
 *
 *   $env:POSTGRES_URL = "<prod non-pooling>"   # or POSTGRES_URL_NON_POOLING in .env.local
 *   npx tsx scripts/diag-nonplaid-bank-txns.ts --org <uuid> [--account <uuid>]
 */
import { readFileSync } from 'fs';
import postgres from 'postgres';

function readEnvLocal(k: string): string | null {
  try {
    for (const l of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
      const m = l.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (m && m[1] === k) return m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* ignore */ }
  return null;
}

async function main() {
  const url = process.env.POSTGRES_URL ?? readEnvLocal('POSTGRES_URL_NON_POOLING') ?? readEnvLocal('POSTGRES_URL');
  if (!url) throw new Error('Set POSTGRES_URL or POSTGRES_URL_NON_POOLING');
  const a = process.argv.slice(2);
  const orgId = a[a.indexOf('--org') + 1];
  const acctFilter = a.includes('--account') ? a[a.indexOf('--account') + 1] : null;
  if (!orgId || orgId.startsWith('--')) { console.error('Usage: --org <uuid> [--account <uuid>]'); process.exit(1); }

  const sql = postgres(url, { prepare: false, max: 1, connect_timeout: 8 });
  try {
    const accts = await sql`
      select id, account_name, normal_balance
      from chart_of_accounts
      where organization_id = ${orgId}
        and (account_type in ('bank','credit_card')
             or id in (select chart_of_account_id from plaid_accounts
                        where linked_organization_id = ${orgId} and chart_of_account_id is not null))
        ${acctFilter ? sql`and id = ${acctFilter}` : sql``}
      order by account_name`;

    for (const acc of accts) {
      console.log(`\n=== ${acc.account_name} [${acc.normal_balance}] ===`);
      // Breakdown by reference source-prefix.
      const groups = await sql`
        select
          case when reference is null or reference = '' then '(manual/none)'
               else split_part(reference, ':', 1) end as src,
          count(*)::int n,
          min(date) mn, max(date) mx
        from transactions
        where organization_id = ${orgId} and account_id = ${acc.id}
        group by 1 order by n desc`;
      if (groups.length === 0) { console.log('  (no transactions)'); continue; }
      for (const g of groups) console.log(`  ${String(g.src).padEnd(16)} ${String(g.n).padStart(5)} txns   ${g.mn} → ${g.mx}`);

      // Sample the NON-plaid ones so we can eyeball whether they're dupes.
      const samples = await sql`
        select date, amount, type, description, reference
        from transactions
        where organization_id = ${orgId} and account_id = ${acc.id}
          and (reference is null or reference not like 'plaid:%')
        order by date desc limit 8`;
      if (samples.length) {
        console.log('  — sample non-Plaid txns —');
        for (const s of samples) {
          console.log(`    ${s.date}  ${String(s.type ?? '').padEnd(7)} ${String(s.amount).padStart(12)}  ${String(s.reference ?? '(manual)').slice(0, 22).padEnd(22)} ${String(s.description ?? '').slice(0, 40)}`);
        }
      }
    }
  } finally {
    await sql.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
