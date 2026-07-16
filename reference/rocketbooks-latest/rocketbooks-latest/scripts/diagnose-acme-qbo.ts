import { config } from 'dotenv';
import { eq, desc } from 'drizzle-orm';
config({ path: '.env.local' });

async function main() {
  const { db } = await import('../db/client');
  const { organizations, qboConnections, qboMigrationJobs } = await import('../db/schema/schema');

  const [acme] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.name, 'Acme Corp'))
    .limit(1);
  if (!acme) { console.log('Acme Corp not found'); process.exit(0); }
  console.log(`Acme Corp orgId: ${acme.id}`);

  const conns = await db
    .select()
    .from(qboConnections)
    .where(eq(qboConnections.orgId, acme.id));
  console.log(`\nqbo_connections rows for Acme: ${conns.length}`);
  for (const c of conns) {
    const expired = c.accessTokenExpiresAt ? new Date(c.accessTokenExpiresAt).getTime() < Date.now() : null;
    console.log(`  realmId=${c.realmId} | accessTokenExpiresAt=${c.accessTokenExpiresAt} (${expired ? 'EXPIRED' : 'valid'}) | refreshTokenExpiresAt=${c.refreshTokenExpiresAt} | created=${c.createdAt} | updated=${c.updatedAt}`);
  }

  const jobs = await db
    .select()
    .from(qboMigrationJobs)
    .where(eq(qboMigrationJobs.orgId, acme.id))
    .orderBy(desc(qboMigrationJobs.createdAt));
  console.log(`\nqbo_migration_jobs for Acme: ${jobs.length}`);
  for (const j of jobs) {
    console.log(`  ${j.id.slice(0, 8)} | status=${j.status} | progress=${j.progress} | created=${j.createdAt} | completed=${j.completedAt} | error=${j.errorMessage ?? '—'}`);
  }

  // Look across ALL connections to see if any other org has a connection that
  // could have been mislinked.
  const allConns = await db.select().from(qboConnections);
  console.log(`\nAll qbo_connections in system: ${allConns.length}`);
  for (const c of allConns) {
    if (!c.orgId) {
      console.log(`  org=(null) realm=${c.realmId} created=${c.createdAt}`);
      continue;
    }
    const [org] = await db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, c.orgId)).limit(1);
    console.log(`  org=${org?.name ?? c.orgId.slice(0, 8)} realm=${c.realmId} created=${c.createdAt}`);
  }

  process.exit(0);
}
main().catch(console.error);
