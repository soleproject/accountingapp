import { config } from 'dotenv';
import { sql, eq } from 'drizzle-orm';
config({ path: '.env.local' });

async function main() {
  const { db } = await import('../db/client');
  const { organizations } = await import('../db/schema/schema');

  const [org] = await db.select({ id: organizations.id }).from(organizations).where(eq(organizations.name, 'Acme Corp')).limit(1);
  if (!org) { console.log('Acme Corp not found'); process.exit(0); }

  // Wipe QBO staging via the migration_job_id link. After staging is
  // gone, the FK from qbo_migration_jobs is no longer blocked.
  const stagingTables = [
    'qbo_account_staging',
    'qbo_customer_staging',
    'qbo_vendor_staging',
    'qbo_invoice_staging',
    'qbo_bill_staging',
    'qbo_payment_staging',
    'qbo_bill_payment_staging',
    'qbo_purchase_staging',
    'qbo_deposit_staging',
    'qbo_transfer_staging',
    'qbo_journal_entry_staging',
  ];
  for (const t of stagingTables) {
    const res = await db.execute(
      sql`DELETE FROM ${sql.identifier(t)} WHERE migration_job_id IN (SELECT id FROM qbo_migration_jobs WHERE org_id = ${org.id})`,
    );
    console.log(`  ${t}: ${res.rowCount ?? 0} deleted`);
  }
  // Conflicts are org-scoped — check column name first.
  try {
    const r = await db.execute(sql`DELETE FROM qbo_conflicts WHERE org_id = ${org.id}`);
    console.log(`  qbo_conflicts: ${r.rowCount ?? 0} deleted`);
  } catch (e) {
    console.log(`  qbo_conflicts: skipped (${e instanceof Error ? e.message.slice(0, 80) : e})`);
  }
  const rJobs = await db.execute(sql`DELETE FROM qbo_migration_jobs WHERE org_id = ${org.id}`);
  console.log(`  qbo_migration_jobs: ${rJobs.rowCount ?? 0} deleted`);
  const rConn = await db.execute(sql`DELETE FROM qbo_connections WHERE org_id = ${org.id}`);
  console.log(`  qbo_connections: ${rConn.rowCount ?? 0} deleted`);

  process.exit(0);
}
main().catch(console.error);
