/**
 * Backfill invite_slug for every enterprise org that has a tier set but
 * no slug yet. Run after applying 0051_enterprise_invite_slug.sql.
 *
 *   npx tsx scripts/backfill-enterprise-invite-slugs.ts
 *
 * Idempotent — re-running only touches orgs that are still NULL. Safe to
 * run repeatedly; the per-org call is wrapped in ensureInviteSlug() which
 * is itself a no-op on an already-populated row.
 */
import { config } from 'dotenv';
import { isNotNull, isNull, and } from 'drizzle-orm';

config({ path: '.env.local' });

async function main() {
  const { db } = await import('../db/client');
  const { organizations } = await import('../db/schema/schema');
  const { ensureInviteSlug } = await import('../lib/enterprise/invite-slug');

  // Target: orgs with a tier set but no slug. Skip tier-less enterprises
  // and client orgs — they don't hand out invite links.
  const targets = await db
    .select({ id: organizations.id, name: organizations.name })
    .from(organizations)
    .where(and(isNotNull(organizations.enterpriseTier), isNull(organizations.inviteSlug)));

  if (targets.length === 0) {
    console.log('· nothing to backfill — every tier\'d enterprise already has a slug.');
    process.exit(0);
  }

  console.log(`backfilling ${targets.length} enterprise${targets.length === 1 ? '' : 's'}…`);
  for (const org of targets) {
    const slug = await ensureInviteSlug(org.id);
    console.log(`  ✓ ${org.name} (${org.id}) → ${slug}`);
  }
  console.log('done.');
  process.exit(0);
}

main().catch((err) => {
  console.error('✗ backfill failed:', err);
  process.exit(1);
});
