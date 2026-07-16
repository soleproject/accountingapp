/**
 * Clear all transactional data for an org (transactions, JEs, GL,
 * receipts, invoices, bills, payments, imports). Keeps structural data
 * (chart_of_accounts, contacts, qbo_connection, pfc_org_overrides, plaid
 * connections) untouched.
 *
 * Usage:
 *   npx tsx scripts/clear-org-transactional-data.ts "Acme Corp"            # dry-run
 *   npx tsx scripts/clear-org-transactional-data.ts "Acme Corp" --apply    # actually delete
 *
 * Deletion happens inside one transaction in FK-safe order. Tables that
 * fail their delete (typically because something else in the schema FKs
 * to them and isn't in the list) will rollback the whole transaction so
 * partial-state is impossible.
 */
import { config } from 'dotenv';
import postgres from 'postgres';

config({ path: '.env.local' });

const DB_URL = process.env.POSTGRES_URL_NON_POOLING ?? process.env.POSTGRES_URL;
if (!DB_URL) throw new Error('POSTGRES_URL_NON_POOLING (or POSTGRES_URL) is required');

const orgName = process.argv[2];
if (!orgName) throw new Error('usage: tsx scripts/clear-org-transactional-data.ts "<org name>" [--apply]');
const apply = process.argv.includes('--apply');

const sql = postgres(DB_URL, { prepare: false, max: 1 });

// Order matters: dependents (lines, applications, splits) first, parents
// last. Each entry is (label, sql to count, sql to delete) — the count
// and delete share the same WHERE clause so dry-run numbers match what
// the apply pass would touch.
interface Table {
  label: string;
  count: (orgId: string) => Promise<number>;
  del: (orgId: string, tx: postgres.TransactionSql) => Promise<number>;
}

const tables: Table[] = [
  // Splits & line tables first (FK to parent txns/invoices/bills/JEs).
  { label: 'transaction_splits', count: async (org) => one(await sql`SELECT COUNT(*)::int AS n FROM transaction_splits WHERE organization_id = ${org}`),
    del: async (org, tx) => (await tx`DELETE FROM transaction_splits WHERE organization_id = ${org}`).count },
  { label: 'invoice_payment_applications', count: async (org) => one(await sql`SELECT COUNT(*)::int AS n FROM invoice_payment_applications ipa JOIN invoices i ON i.id = ipa.invoice_id WHERE i.organization_id = ${org}`),
    del: async (org, tx) => (await tx`DELETE FROM invoice_payment_applications WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id = ${org})`).count },
  { label: 'invoice_lines', count: async (org) => one(await sql`SELECT COUNT(*)::int AS n FROM invoice_lines il JOIN invoices i ON i.id = il.invoice_id WHERE i.organization_id = ${org}`),
    del: async (org, tx) => (await tx`DELETE FROM invoice_lines WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id = ${org})`).count },
  { label: 'bill_payment_applications', count: async (org) => one(await sql`SELECT COUNT(*)::int AS n FROM bill_payment_applications bpa JOIN bills b ON b.id = bpa.bill_id WHERE b.organization_id = ${org}`),
    del: async (org, tx) => (await tx`DELETE FROM bill_payment_applications WHERE bill_id IN (SELECT id FROM bills WHERE organization_id = ${org})`).count },
  { label: 'bill_lines', count: async (org) => one(await sql`SELECT COUNT(*)::int AS n FROM bill_lines bl JOIN bills b ON b.id = bl.bill_id WHERE b.organization_id = ${org}`),
    del: async (org, tx) => (await tx`DELETE FROM bill_lines WHERE bill_id IN (SELECT id FROM bills WHERE organization_id = ${org})`).count },
  { label: 'general_ledger', count: async (org) => one(await sql`SELECT COUNT(*)::int AS n FROM general_ledger WHERE organization_id = ${org}`),
    del: async (org, tx) => (await tx`DELETE FROM general_ledger WHERE organization_id = ${org}`).count },
  { label: 'journal_entry_lines', count: async (org) => one(await sql`SELECT COUNT(*)::int AS n FROM journal_entry_lines jel JOIN journal_entries je ON je.id = jel.journal_entry_id WHERE je.organization_id = ${org}`),
    del: async (org, tx) => (await tx`DELETE FROM journal_entry_lines WHERE journal_entry_id IN (SELECT id FROM journal_entries WHERE organization_id = ${org})`).count },
  { label: 'ai_recommendations', count: async (org) => one(await sql`SELECT COUNT(*)::int AS n FROM ai_recommendations WHERE organization_id = ${org}`),
    del: async (org, tx) => (await tx`DELETE FROM ai_recommendations WHERE organization_id = ${org}`).count },
  { label: 'categorization_feedback', count: async (org) => one(await sql`SELECT COUNT(*)::int AS n FROM categorization_feedback WHERE organization_id = ${org}`),
    del: async (org, tx) => (await tx`DELETE FROM categorization_feedback WHERE organization_id = ${org}`).count },
  { label: 'imported_transactions', count: async (org) => one(await sql`SELECT COUNT(*)::int AS n FROM imported_transactions WHERE organization_id = ${org}`),
    del: async (org, tx) => (await tx`DELETE FROM imported_transactions WHERE organization_id = ${org}`).count },
  { label: 'receipts', count: async (org) => one(await sql`SELECT COUNT(*)::int AS n FROM receipts WHERE organization_id = ${org}`),
    del: async (org, tx) => (await tx`DELETE FROM receipts WHERE organization_id = ${org}`).count },
  // Reconciliation tables — matches reference statement_lines + transactions,
  // so they must go before either. statement_lines.matched_transaction_id
  // also references transactions, so lines go before transactions too.
  // reconciliation_periods is referenced by both matches and lines so it
  // goes last among the three.
  { label: 'reconciliation_matches', count: async (org) => one(await sql`SELECT COUNT(*)::int AS n FROM reconciliation_matches rm JOIN reconciliation_periods rp ON rp.id = rm.reconciliation_period_id WHERE rp.organization_id = ${org}`),
    del: async (org, tx) => (await tx`DELETE FROM reconciliation_matches WHERE reconciliation_period_id IN (SELECT id FROM reconciliation_periods WHERE organization_id = ${org})`).count },
  { label: 'statement_lines', count: async (org) => one(await sql`SELECT COUNT(*)::int AS n FROM statement_lines WHERE organization_id = ${org}`),
    del: async (org, tx) => (await tx`DELETE FROM statement_lines WHERE organization_id = ${org}`).count },
  { label: 'reconciliation_periods', count: async (org) => one(await sql`SELECT COUNT(*)::int AS n FROM reconciliation_periods WHERE organization_id = ${org}`),
    del: async (org, tx) => (await tx`DELETE FROM reconciliation_periods WHERE organization_id = ${org}`).count },

  // Now the parent transactional tables.
  { label: 'invoice_payments', count: async (org) => one(await sql`SELECT COUNT(*)::int AS n FROM invoice_payments WHERE organization_id = ${org}`),
    del: async (org, tx) => (await tx`DELETE FROM invoice_payments WHERE organization_id = ${org}`).count },
  { label: 'bill_payments', count: async (org) => one(await sql`SELECT COUNT(*)::int AS n FROM bill_payments WHERE organization_id = ${org}`),
    del: async (org, tx) => (await tx`DELETE FROM bill_payments WHERE organization_id = ${org}`).count },
  { label: 'payments', count: async (org) => one(await sql`SELECT COUNT(*)::int AS n FROM payments WHERE organization_id = ${org}`),
    del: async (org, tx) => (await tx`DELETE FROM payments WHERE organization_id = ${org}`).count },
  { label: 'invoices', count: async (org) => one(await sql`SELECT COUNT(*)::int AS n FROM invoices WHERE organization_id = ${org}`),
    del: async (org, tx) => (await tx`DELETE FROM invoices WHERE organization_id = ${org}`).count },
  { label: 'bills', count: async (org) => one(await sql`SELECT COUNT(*)::int AS n FROM bills WHERE organization_id = ${org}`),
    del: async (org, tx) => (await tx`DELETE FROM bills WHERE organization_id = ${org}`).count },
  { label: 'transactions', count: async (org) => one(await sql`SELECT COUNT(*)::int AS n FROM transactions WHERE organization_id = ${org}`),
    del: async (org, tx) => (await tx`DELETE FROM transactions WHERE organization_id = ${org}`).count },
  { label: 'imports', count: async (org) => one(await sql`SELECT COUNT(*)::int AS n FROM imports WHERE organization_id = ${org}`),
    del: async (org, tx) => (await tx`DELETE FROM imports WHERE organization_id = ${org}`).count },
  { label: 'journal_entries', count: async (org) => one(await sql`SELECT COUNT(*)::int AS n FROM journal_entries WHERE organization_id = ${org}`),
    del: async (org, tx) => (await tx`DELETE FROM journal_entries WHERE organization_id = ${org}`).count },
];

function one(rows: { n: number }[]): number { return rows[0]?.n ?? 0; }

async function main() {
  const orgs = await sql<{ id: string; name: string }[]>`
    SELECT id, name FROM organizations WHERE name = ${orgName}`;
  if (orgs.length === 0) {
    console.log(`no exact match for "${orgName}", trying ILIKE…`);
    const fuzzy = await sql<{ id: string; name: string }[]>`
      SELECT id, name FROM organizations WHERE name ILIKE ${'%' + orgName + '%'}`;
    if (fuzzy.length === 0) throw new Error('no match');
    console.log('fuzzy matches:', fuzzy);
    throw new Error('disambiguate by passing the exact org name');
  }
  if (orgs.length > 1) {
    console.log('multiple exact matches:', orgs);
    throw new Error('multiple orgs with that name — pass the id directly');
  }
  const orgId = orgs[0].id;
  console.log(`\norg: ${orgs[0].name} (id=${orgId})\n`);

  console.log(`${apply ? 'APPLY MODE — will delete' : 'DRY RUN — counts only'}\n`);

  let grand = 0;
  const beforeCounts: Record<string, number> = {};
  for (const t of tables) {
    const n = await t.count(orgId);
    beforeCounts[t.label] = n;
    grand += n;
    console.log(`  ${t.label.padEnd(32)} ${n.toLocaleString()}`);
  }
  console.log(`  ${''.padEnd(32, '-')} ${'-'.repeat(8)}`);
  console.log(`  ${'TOTAL'.padEnd(32)} ${grand.toLocaleString()}\n`);

  if (!apply) {
    console.log('Re-run with --apply to actually delete.');
    await sql.end();
    return;
  }

  console.log('Deleting in one transaction…');
  let deletedTotal = 0;
  await sql.begin(async (tx) => {
    for (const t of tables) {
      const n = await t.del(orgId, tx);
      deletedTotal += n;
      if (n > 0) console.log(`  ${t.label.padEnd(32)} deleted ${n.toLocaleString()}`);
    }
  });
  console.log(`\nDeleted ${deletedTotal.toLocaleString()} row(s) total. Done.`);
  await sql.end();
}

main().catch(async (err) => {
  console.error('clear failed:', err);
  try { await sql.end(); } catch {}
  process.exit(1);
});
