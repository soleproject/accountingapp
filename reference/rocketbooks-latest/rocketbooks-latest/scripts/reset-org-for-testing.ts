/**
 * Reset an org to a fresh-org baseline suitable for end-to-end testing:
 *   - All transactional data deleted (txns, JEs, GL, invoices, bills,
 *     payments, imports, receipts, reconciliation)
 *   - All QB connection state deleted (connections, jobs, staging,
 *     entity_map, conflicts, outbound queue, mirror settings)
 *   - All PFC overrides deleted
 *   - All contacts deleted
 *   - All non-seed chart_of_accounts rows deleted
 *   - All seed rows re-activated (isActive=true) and stripped of any
 *     non-seed parent links
 *
 * Untouched: the organization row itself, users/permissions, billing,
 * Plaid connections (linked_organization_id), seed CoA structure.
 *
 * Usage:
 *   npx tsx scripts/reset-org-for-testing.ts "Acme Corp"            # dry-run
 *   npx tsx scripts/reset-org-for-testing.ts "Acme Corp" --apply    # actually delete
 */
import { config } from 'dotenv';
import postgres from 'postgres';

config({ path: '.env.local' });

const DB_URL = process.env.POSTGRES_URL_NON_POOLING ?? process.env.POSTGRES_URL;
if (!DB_URL) throw new Error('POSTGRES_URL_NON_POOLING (or POSTGRES_URL) is required');

const orgName = process.argv[2];
if (!orgName) throw new Error('usage: tsx scripts/reset-org-for-testing.ts "<org name>" [--apply]');
const apply = process.argv.includes('--apply');

const sql = postgres(DB_URL, { prepare: false, max: 1 });

interface Step {
  label: string;
  count: (org: string) => Promise<number>;
  exec: (org: string, tx: postgres.TransactionSql) => Promise<number>;
}

const one = (rows: { n: number }[]) => rows[0]?.n ?? 0;

// Order matters — dependents first per FK constraints discovered in
// db/migrations/0000_tranquil_junta.sql.
const steps: Step[] = [
  // ── 1. Transactional dependents (lines, applications, splits) ──────
  { label: 'transaction_splits', count: async (o) => one(await sql`SELECT COUNT(*)::int n FROM transaction_splits WHERE organization_id = ${o}`),
    exec: async (o, tx) => (await tx`DELETE FROM transaction_splits WHERE organization_id = ${o}`).count },
  { label: 'invoice_payment_applications', count: async (o) => one(await sql`SELECT COUNT(*)::int n FROM invoice_payment_applications ipa JOIN invoices i ON i.id = ipa.invoice_id WHERE i.organization_id = ${o}`),
    exec: async (o, tx) => (await tx`DELETE FROM invoice_payment_applications WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id = ${o})`).count },
  { label: 'invoice_lines', count: async (o) => one(await sql`SELECT COUNT(*)::int n FROM invoice_lines il JOIN invoices i ON i.id = il.invoice_id WHERE i.organization_id = ${o}`),
    exec: async (o, tx) => (await tx`DELETE FROM invoice_lines WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id = ${o})`).count },
  { label: 'bill_payment_applications', count: async (o) => one(await sql`SELECT COUNT(*)::int n FROM bill_payment_applications bpa JOIN bills b ON b.id = bpa.bill_id WHERE b.organization_id = ${o}`),
    exec: async (o, tx) => (await tx`DELETE FROM bill_payment_applications WHERE bill_id IN (SELECT id FROM bills WHERE organization_id = ${o})`).count },
  { label: 'bill_lines', count: async (o) => one(await sql`SELECT COUNT(*)::int n FROM bill_lines bl JOIN bills b ON b.id = bl.bill_id WHERE b.organization_id = ${o}`),
    exec: async (o, tx) => (await tx`DELETE FROM bill_lines WHERE bill_id IN (SELECT id FROM bills WHERE organization_id = ${o})`).count },
  { label: 'general_ledger', count: async (o) => one(await sql`SELECT COUNT(*)::int n FROM general_ledger WHERE organization_id = ${o}`),
    exec: async (o, tx) => (await tx`DELETE FROM general_ledger WHERE organization_id = ${o}`).count },
  { label: 'journal_entry_lines', count: async (o) => one(await sql`SELECT COUNT(*)::int n FROM journal_entry_lines jel JOIN journal_entries je ON je.id = jel.journal_entry_id WHERE je.organization_id = ${o}`),
    exec: async (o, tx) => (await tx`DELETE FROM journal_entry_lines WHERE journal_entry_id IN (SELECT id FROM journal_entries WHERE organization_id = ${o})`).count },
  { label: 'ai_recommendations', count: async (o) => one(await sql`SELECT COUNT(*)::int n FROM ai_recommendations WHERE organization_id = ${o}`),
    exec: async (o, tx) => (await tx`DELETE FROM ai_recommendations WHERE organization_id = ${o}`).count },
  { label: 'categorization_feedback', count: async (o) => one(await sql`SELECT COUNT(*)::int n FROM categorization_feedback WHERE organization_id = ${o}`),
    exec: async (o, tx) => (await tx`DELETE FROM categorization_feedback WHERE organization_id = ${o}`).count },
  { label: 'imported_transactions', count: async (o) => one(await sql`SELECT COUNT(*)::int n FROM imported_transactions WHERE organization_id = ${o}`),
    exec: async (o, tx) => (await tx`DELETE FROM imported_transactions WHERE organization_id = ${o}`).count },
  { label: 'receipts', count: async (o) => one(await sql`SELECT COUNT(*)::int n FROM receipts WHERE organization_id = ${o}`),
    exec: async (o, tx) => (await tx`DELETE FROM receipts WHERE organization_id = ${o}`).count },
  { label: 'reconciliation_matches', count: async (o) => one(await sql`SELECT COUNT(*)::int n FROM reconciliation_matches rm JOIN reconciliation_periods rp ON rp.id = rm.reconciliation_period_id WHERE rp.organization_id = ${o}`),
    exec: async (o, tx) => (await tx`DELETE FROM reconciliation_matches WHERE reconciliation_period_id IN (SELECT id FROM reconciliation_periods WHERE organization_id = ${o})`).count },
  { label: 'statement_lines', count: async (o) => one(await sql`SELECT COUNT(*)::int n FROM statement_lines WHERE organization_id = ${o}`),
    exec: async (o, tx) => (await tx`DELETE FROM statement_lines WHERE organization_id = ${o}`).count },
  { label: 'reconciliation_periods', count: async (o) => one(await sql`SELECT COUNT(*)::int n FROM reconciliation_periods WHERE organization_id = ${o}`),
    exec: async (o, tx) => (await tx`DELETE FROM reconciliation_periods WHERE organization_id = ${o}`).count },

  // ── 2. Transactional parents ──────────────────────────────────────
  { label: 'invoice_payments', count: async (o) => one(await sql`SELECT COUNT(*)::int n FROM invoice_payments WHERE organization_id = ${o}`),
    exec: async (o, tx) => (await tx`DELETE FROM invoice_payments WHERE organization_id = ${o}`).count },
  { label: 'bill_payments', count: async (o) => one(await sql`SELECT COUNT(*)::int n FROM bill_payments WHERE organization_id = ${o}`),
    exec: async (o, tx) => (await tx`DELETE FROM bill_payments WHERE organization_id = ${o}`).count },
  { label: 'payments', count: async (o) => one(await sql`SELECT COUNT(*)::int n FROM payments WHERE organization_id = ${o}`),
    exec: async (o, tx) => (await tx`DELETE FROM payments WHERE organization_id = ${o}`).count },
  { label: 'invoices', count: async (o) => one(await sql`SELECT COUNT(*)::int n FROM invoices WHERE organization_id = ${o}`),
    exec: async (o, tx) => (await tx`DELETE FROM invoices WHERE organization_id = ${o}`).count },
  { label: 'bills', count: async (o) => one(await sql`SELECT COUNT(*)::int n FROM bills WHERE organization_id = ${o}`),
    exec: async (o, tx) => (await tx`DELETE FROM bills WHERE organization_id = ${o}`).count },
  { label: 'transactions', count: async (o) => one(await sql`SELECT COUNT(*)::int n FROM transactions WHERE organization_id = ${o}`),
    exec: async (o, tx) => (await tx`DELETE FROM transactions WHERE organization_id = ${o}`).count },
  { label: 'imports', count: async (o) => one(await sql`SELECT COUNT(*)::int n FROM imports WHERE organization_id = ${o}`),
    exec: async (o, tx) => (await tx`DELETE FROM imports WHERE organization_id = ${o}`).count },
  { label: 'journal_entries', count: async (o) => one(await sql`SELECT COUNT(*)::int n FROM journal_entries WHERE organization_id = ${o}`),
    exec: async (o, tx) => (await tx`DELETE FROM journal_entries WHERE organization_id = ${o}`).count },

  // ── 3. Per-org config that QB created ─────────────────────────────
  { label: 'pfc_org_overrides', count: async (o) => one(await sql`SELECT COUNT(*)::int n FROM pfc_org_overrides WHERE organization_id = ${o}`),
    exec: async (o, tx) => (await tx`DELETE FROM pfc_org_overrides WHERE organization_id = ${o}`).count },

  // ── 4. QB state ───────────────────────────────────────────────────
  { label: 'qbo_outbound_queue', count: async (o) => one(await sql`SELECT COUNT(*)::int n FROM qbo_outbound_queue WHERE organization_id = ${o}`),
    exec: async (o, tx) => (await tx`DELETE FROM qbo_outbound_queue WHERE organization_id = ${o}`).count },
  { label: 'qbo_conflicts', count: async (o) => one(await sql`SELECT COUNT(*)::int n FROM qbo_conflicts WHERE organization_id = ${o}`),
    exec: async (o, tx) => (await tx`DELETE FROM qbo_conflicts WHERE organization_id = ${o}`).count },
  { label: 'qbo_mirror_settings', count: async (o) => one(await sql`SELECT COUNT(*)::int n FROM qbo_mirror_settings WHERE organization_id = ${o}`),
    exec: async (o, tx) => (await tx`DELETE FROM qbo_mirror_settings WHERE organization_id = ${o}`).count },
  { label: 'qbo_entity_map', count: async (o) => one(await sql`SELECT COUNT(*)::int n FROM qbo_entity_map WHERE organization_id = ${o}`),
    exec: async (o, tx) => (await tx`DELETE FROM qbo_entity_map WHERE organization_id = ${o}`).count },
  // Staging tables all reference qbo_migration_jobs via migration_job_id.
  { label: 'qbo_account_staging', count: async (o) => one(await sql`SELECT COUNT(*)::int n FROM qbo_account_staging s JOIN qbo_migration_jobs j ON j.id = s.migration_job_id WHERE j.org_id = ${o}`),
    exec: async (o, tx) => (await tx`DELETE FROM qbo_account_staging WHERE migration_job_id IN (SELECT id FROM qbo_migration_jobs WHERE org_id = ${o})`).count },
  { label: 'qbo_customer_staging', count: async (o) => one(await sql`SELECT COUNT(*)::int n FROM qbo_customer_staging s JOIN qbo_migration_jobs j ON j.id = s.migration_job_id WHERE j.org_id = ${o}`),
    exec: async (o, tx) => (await tx`DELETE FROM qbo_customer_staging WHERE migration_job_id IN (SELECT id FROM qbo_migration_jobs WHERE org_id = ${o})`).count },
  { label: 'qbo_vendor_staging', count: async (o) => one(await sql`SELECT COUNT(*)::int n FROM qbo_vendor_staging s JOIN qbo_migration_jobs j ON j.id = s.migration_job_id WHERE j.org_id = ${o}`),
    exec: async (o, tx) => (await tx`DELETE FROM qbo_vendor_staging WHERE migration_job_id IN (SELECT id FROM qbo_migration_jobs WHERE org_id = ${o})`).count },
  { label: 'qbo_invoice_staging', count: async (o) => one(await sql`SELECT COUNT(*)::int n FROM qbo_invoice_staging s JOIN qbo_migration_jobs j ON j.id = s.migration_job_id WHERE j.org_id = ${o}`),
    exec: async (o, tx) => (await tx`DELETE FROM qbo_invoice_staging WHERE migration_job_id IN (SELECT id FROM qbo_migration_jobs WHERE org_id = ${o})`).count },
  { label: 'qbo_bill_staging', count: async (o) => one(await sql`SELECT COUNT(*)::int n FROM qbo_bill_staging s JOIN qbo_migration_jobs j ON j.id = s.migration_job_id WHERE j.org_id = ${o}`),
    exec: async (o, tx) => (await tx`DELETE FROM qbo_bill_staging WHERE migration_job_id IN (SELECT id FROM qbo_migration_jobs WHERE org_id = ${o})`).count },
  { label: 'qbo_payment_staging', count: async (o) => one(await sql`SELECT COUNT(*)::int n FROM qbo_payment_staging s JOIN qbo_migration_jobs j ON j.id = s.migration_job_id WHERE j.org_id = ${o}`),
    exec: async (o, tx) => (await tx`DELETE FROM qbo_payment_staging WHERE migration_job_id IN (SELECT id FROM qbo_migration_jobs WHERE org_id = ${o})`).count },
  { label: 'qbo_bill_payment_staging', count: async (o) => one(await sql`SELECT COUNT(*)::int n FROM qbo_bill_payment_staging s JOIN qbo_migration_jobs j ON j.id = s.migration_job_id WHERE j.org_id = ${o}`),
    exec: async (o, tx) => (await tx`DELETE FROM qbo_bill_payment_staging WHERE migration_job_id IN (SELECT id FROM qbo_migration_jobs WHERE org_id = ${o})`).count },
  { label: 'qbo_purchase_staging', count: async (o) => one(await sql`SELECT COUNT(*)::int n FROM qbo_purchase_staging s JOIN qbo_migration_jobs j ON j.id = s.migration_job_id WHERE j.org_id = ${o}`),
    exec: async (o, tx) => (await tx`DELETE FROM qbo_purchase_staging WHERE migration_job_id IN (SELECT id FROM qbo_migration_jobs WHERE org_id = ${o})`).count },
  { label: 'qbo_deposit_staging', count: async (o) => one(await sql`SELECT COUNT(*)::int n FROM qbo_deposit_staging s JOIN qbo_migration_jobs j ON j.id = s.migration_job_id WHERE j.org_id = ${o}`),
    exec: async (o, tx) => (await tx`DELETE FROM qbo_deposit_staging WHERE migration_job_id IN (SELECT id FROM qbo_migration_jobs WHERE org_id = ${o})`).count },
  { label: 'qbo_transfer_staging', count: async (o) => one(await sql`SELECT COUNT(*)::int n FROM qbo_transfer_staging s JOIN qbo_migration_jobs j ON j.id = s.migration_job_id WHERE j.org_id = ${o}`),
    exec: async (o, tx) => (await tx`DELETE FROM qbo_transfer_staging WHERE migration_job_id IN (SELECT id FROM qbo_migration_jobs WHERE org_id = ${o})`).count },
  { label: 'qbo_journal_entry_staging', count: async (o) => one(await sql`SELECT COUNT(*)::int n FROM qbo_journal_entry_staging s JOIN qbo_migration_jobs j ON j.id = s.migration_job_id WHERE j.org_id = ${o}`),
    exec: async (o, tx) => (await tx`DELETE FROM qbo_journal_entry_staging WHERE migration_job_id IN (SELECT id FROM qbo_migration_jobs WHERE org_id = ${o})`).count },
  { label: 'qbo_migration_jobs', count: async (o) => one(await sql`SELECT COUNT(*)::int n FROM qbo_migration_jobs WHERE org_id = ${o}`),
    exec: async (o, tx) => (await tx`DELETE FROM qbo_migration_jobs WHERE org_id = ${o}`).count },
  { label: 'qbo_connections', count: async (o) => one(await sql`SELECT COUNT(*)::int n FROM qbo_connections WHERE org_id = ${o}`),
    exec: async (o, tx) => (await tx`DELETE FROM qbo_connections WHERE org_id = ${o}`).count },

  // ── 5. Contacts (txn FKs are gone by now) ────────────────────────
  { label: 'contacts', count: async (o) => one(await sql`SELECT COUNT(*)::int n FROM contacts WHERE organization_id = ${o}`),
    exec: async (o, tx) => (await tx`DELETE FROM contacts WHERE organization_id = ${o}`).count },

  // ── 6. CoA: null out self-FKs on non-seed rows, then delete them ─
  { label: 'chart_of_accounts (null non-seed self-FKs)', count: async (o) => one(await sql`SELECT COUNT(*)::int n FROM chart_of_accounts WHERE organization_id = ${o} AND (system_generated IS NULL OR system_generated = false) AND (parent_account_id IS NOT NULL OR suggested_match_coa_id IS NOT NULL)`),
    exec: async (o, tx) => (await tx`UPDATE chart_of_accounts SET parent_account_id = NULL, suggested_match_coa_id = NULL WHERE organization_id = ${o} AND (system_generated IS NULL OR system_generated = false)`).count },
  { label: 'chart_of_accounts (null seed parents pointing at non-seeds)', count: async (o) => one(await sql`SELECT COUNT(*)::int n FROM chart_of_accounts c WHERE c.organization_id = ${o} AND c.system_generated = true AND (c.parent_account_id IN (SELECT id FROM chart_of_accounts WHERE organization_id = ${o} AND (system_generated IS NULL OR system_generated = false)) OR c.suggested_match_coa_id IN (SELECT id FROM chart_of_accounts WHERE organization_id = ${o} AND (system_generated IS NULL OR system_generated = false)))`),
    exec: async (o, tx) => (await tx`UPDATE chart_of_accounts SET parent_account_id = CASE WHEN parent_account_id IN (SELECT id FROM chart_of_accounts WHERE organization_id = ${o} AND (system_generated IS NULL OR system_generated = false)) THEN NULL ELSE parent_account_id END, suggested_match_coa_id = CASE WHEN suggested_match_coa_id IN (SELECT id FROM chart_of_accounts WHERE organization_id = ${o} AND (system_generated IS NULL OR system_generated = false)) THEN NULL ELSE suggested_match_coa_id END WHERE organization_id = ${o} AND system_generated = true`).count },
  { label: 'chart_of_accounts (delete non-seed)', count: async (o) => one(await sql`SELECT COUNT(*)::int n FROM chart_of_accounts WHERE organization_id = ${o} AND (system_generated IS NULL OR system_generated = false)`),
    exec: async (o, tx) => (await tx`DELETE FROM chart_of_accounts WHERE organization_id = ${o} AND (system_generated IS NULL OR system_generated = false)`).count },
  { label: 'chart_of_accounts (reactivate seeds)', count: async (o) => one(await sql`SELECT COUNT(*)::int n FROM chart_of_accounts WHERE organization_id = ${o} AND system_generated = true AND is_active = false`),
    exec: async (o, tx) => (await tx`UPDATE chart_of_accounts SET is_active = true WHERE organization_id = ${o} AND system_generated = true AND is_active = false`).count },
];

async function main() {
  const orgs = await sql<{ id: string; name: string }[]>`
    SELECT id, name FROM organizations WHERE name = ${orgName}`;
  if (orgs.length !== 1) throw new Error(`expected 1 match for "${orgName}"; got ${orgs.length}`);
  const orgId = orgs[0].id;
  console.log(`\norg: ${orgs[0].name} (id=${orgId})`);
  console.log(`${apply ? 'APPLY MODE — will modify' : 'DRY RUN — counts only'}\n`);

  let total = 0;
  for (const s of steps) {
    const n = await s.count(orgId);
    total += n;
    if (n > 0 || apply) {
      console.log(`  ${s.label.padEnd(55)} ${n.toLocaleString()}`);
    }
  }
  console.log(`  ${''.padEnd(55, '-')} ${'-'.repeat(8)}`);
  console.log(`  ${'TOTAL touched rows'.padEnd(55)} ${total.toLocaleString()}\n`);

  if (!apply) {
    console.log('Re-run with --apply to execute.');
    await sql.end();
    return;
  }

  console.log('Applying in one transaction…');
  let touched = 0;
  await sql.begin(async (tx) => {
    for (const s of steps) {
      const n = await s.exec(orgId, tx);
      if (n > 0) console.log(`  ${s.label.padEnd(55)} ${n.toLocaleString()}`);
      touched += n;
    }
  });
  console.log(`\nTouched ${touched.toLocaleString()} row(s) total. Done.`);
  await sql.end();
}

main().catch(async (err) => {
  console.error('reset failed:', err);
  try { await sql.end(); } catch {}
  process.exit(1);
});
