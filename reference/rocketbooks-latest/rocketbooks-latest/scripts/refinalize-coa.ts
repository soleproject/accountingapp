/**
 * Re-run finalizeCoaAfterQb for an already-migrated org. Useful after
 * changing the finalize/AI-mapping logic — picks up the new behavior
 * without forcing a full QBO disconnect/reconnect.
 *
 * Usage:
 *   npx tsx scripts/refinalize-coa.ts "QBO Test 5, LLC"
 *
 * Looks up the latest QBO migration job for the org so we can pass a
 * real migrationJobId in the context (finalize doesn't currently read
 * it but downstream changes might).
 */
import { config } from 'dotenv';
import postgres from 'postgres';

config({ path: '.env.local' });

const DB_URL = process.env.POSTGRES_URL_NON_POOLING ?? process.env.POSTGRES_URL;
if (!DB_URL) throw new Error('POSTGRES_URL_NON_POOLING (or POSTGRES_URL) is required');

const orgName = process.argv[2];
if (!orgName) throw new Error('usage: tsx scripts/refinalize-coa.ts "<org name>"');

const sql = postgres(DB_URL, { prepare: false, max: 1 });

async function main() {
  const orgs = await sql<{ id: string; name: string }[]>`
    SELECT id, name FROM organizations WHERE name = ${orgName}`;
  if (orgs.length !== 1) throw new Error(`expected exactly one org match; got ${orgs.length}`);
  const orgId = orgs[0].id;
  console.log(`org: ${orgs[0].name} (id=${orgId})`);

  const [job] = await sql<{ id: string; realm_id: string }[]>`
    SELECT id, realm_id FROM qbo_migration_jobs
    WHERE org_id = ${orgId}
    ORDER BY created_at DESC LIMIT 1`;
  if (!job) throw new Error('no qbo_migration_jobs row for this org — connect QB first');
  console.log(`latest migration job: ${job.id.slice(0, 8)} (realm=${job.realm_id})`);

  // Close raw connection before importing the app module (which sets up its own pool).
  await sql.end();

  // Dynamic import — avoids loading server-only deps before dotenv is configured.
  const { finalizeCoaAfterQb } = await import('@/lib/qbo/promote/finalize-coa-after-qb');

  console.log('\nrunning finalizeCoaAfterQb…');
  const started = Date.now();
  const result = await finalizeCoaAfterQb({
    organizationId: orgId,
    realmId: job.realm_id,
    migrationJobId: job.id,
  });
  console.log(`  done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  console.log('  result:', result);
}

main().catch((err) => {
  console.error('refinalize failed:', err);
  process.exit(1);
});
