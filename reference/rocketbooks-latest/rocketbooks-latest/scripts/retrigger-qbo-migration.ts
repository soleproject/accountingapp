/**
 * One-off: (re)trigger the QBO historical migration for a single org by
 * emitting the `qbo/migration.requested` Inngest event the OAuth callback
 * normally sends. Use when a connection exists but no migration job ran
 * (e.g. the callback's safeSend swallowed a queue outage).
 *
 *   npx tsx scripts/retrigger-qbo-migration.ts                 # defaults to Bob McKay / Skyward Sparks
 *   npx tsx scripts/retrigger-qbo-migration.ts <orgId> <realmId> <userId>
 *
 * NOTE: this sends to whatever Inngest environment INNGEST_EVENT_KEY in
 * .env.local points at. To trigger the PRODUCTION migration function, that
 * key must be the prod event key. The function auto-refreshes the (expired)
 * access token via the still-valid refresh token, so no reconnect is needed.
 */
import { config } from 'dotenv';
import { eq } from 'drizzle-orm';
config({ path: '.env.local' });

// Bob McKay <bmckay@skywardsparks.com> / Skyward Sparks, LLC — the org whose
// migration silently never ran after connecting on 2026-06-14.
const DEFAULTS = {
  orgId: 'cc83d40a-9817-4a42-96bf-972a1823ad18',
  realmId: '9341452279649363',
  userId: '261d907e-d022-42fa-8b38-53758f1e3c2f',
};

async function main() {
  const [orgId = DEFAULTS.orgId, realmIdArg, userIdArg] = process.argv.slice(2);
  const { db } = await import('../db/client');
  const { qboConnections, qboMigrationJobs } = await import('../db/schema/schema');
  const { inngest } = await import('../lib/inngest');

  // Verify a connection exists and resolve realm/user from it when not given,
  // so we never trigger against a stale/wrong realm.
  const [conn] = await db
    .select()
    .from(qboConnections)
    .where(eq(qboConnections.orgId, orgId))
    .limit(1);
  if (!conn) {
    console.error(`No qbo_connections row for org ${orgId}. Aborting — connect QBO first.`);
    process.exit(1);
  }
  const realmId = realmIdArg ?? conn.realmId;
  const userId = userIdArg ?? conn.userId;

  const existing = await db
    .select({ id: qboMigrationJobs.id, status: qboMigrationJobs.status, createdAt: qboMigrationJobs.createdAt })
    .from(qboMigrationJobs)
    .where(eq(qboMigrationJobs.orgId, orgId));
  console.log(`org=${orgId} realm=${realmId} user=${userId}`);
  console.log(`existing migration jobs for this org: ${existing.length}`);
  for (const j of existing) console.log(`  ${j.id} status=${j.status} created=${j.createdAt}`);

  const res = await inngest.send({
    name: 'qbo/migration.requested',
    data: { organizationId: orgId, realmId, userId },
  });
  console.log('\nEvent sent. Inngest ids:', JSON.stringify(res.ids ?? res));
  console.log('Watch app/(app)/integrations/qbo (or qbo_migration_jobs) for the new running job.');
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
