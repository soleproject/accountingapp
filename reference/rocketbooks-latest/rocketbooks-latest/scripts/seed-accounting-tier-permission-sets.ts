/**
 * Idempotent: ensures a permission_set exists for each accounting tier
 * (Accounting — Starter / Plus / Pro) with exactly the keys mapped in
 * lib/accounting/tier-permissions.ts, auto-creating any missing rows in the
 * `permissions` catalog table (using the catalog descriptions).
 *
 * Run with: npx tsx scripts/seed-accounting-tier-permission-sets.ts
 *
 * Re-running is safe: it matches sets by name, ensures permission rows exist,
 * then REPLACES the set's join rows to match the current mapping — so editing
 * a tier's key list in code + re-running keeps the sets in sync. Mirrors the
 * replace semantics of setPermissionSetPermissionsAction.
 */
import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import { eq, inArray } from 'drizzle-orm';

config({ path: '.env.local' });

async function main() {
  const { db } = await import('../db/client');
  const { permissions, permissionSets, permissionSetPermissions } = await import(
    '../db/schema/schema'
  );
  const { ACCOUNTING_TIER_KEYS, ACCOUNTING_TIERS } = await import('../lib/accounting/tiers');
  const { getTierPermissionKeys, findUnknownTierPermissionKeys } = await import(
    '../lib/accounting/tier-permissions'
  );
  const { allPermissionKeys } = await import('../lib/permissions/structure');

  // Fail fast on a typo'd key — a missing catalog key would create a set that
  // silently grants nothing.
  const unknown = findUnknownTierPermissionKeys();
  if (unknown.length > 0) {
    throw new Error(`Tier permission keys not in catalog: ${unknown.join(', ')}`);
  }
  const catalogDesc = new Map(allPermissionKeys().map((p) => [p.key, p.description]));

  for (const tierKey of ACCOUNTING_TIER_KEYS) {
    const tier = ACCOUNTING_TIERS[tierKey];
    const keys = getTierPermissionKeys(tierKey);

    // 1. Upsert the permission_set by name.
    let [set] = await db
      .select({ id: permissionSets.id })
      .from(permissionSets)
      .where(eq(permissionSets.name, tier.permissionSetName))
      .limit(1);
    if (!set) {
      const id = randomUUID();
      await db.insert(permissionSets).values({
        id,
        name: tier.permissionSetName,
        description: `${tier.label} ($${tier.priceCents / 100}/mo) accounting plan — auto-managed by seed-accounting-tier-permission-sets.ts`,
      });
      set = { id };
      console.log(`✓ permission_set created: ${tier.permissionSetName}`);
    } else {
      console.log(`· permission_set present: ${tier.permissionSetName} (${set.id})`);
    }

    // 2. Ensure each key exists in the permissions catalog table.
    const existing = await db
      .select({ id: permissions.id, key: permissions.key })
      .from(permissions)
      .where(inArray(permissions.key, keys));
    const haveKeys = new Set(existing.map((r) => r.key));
    const missing = keys.filter((k) => !haveKeys.has(k));
    if (missing.length > 0) {
      await db.insert(permissions).values(
        missing.map((k) => ({ id: randomUUID(), key: k, description: catalogDesc.get(k) ?? null })),
      );
      console.log(`  ✓ created ${missing.length} permission row(s): ${missing.join(', ')}`);
    }

    // 3. Re-read for ids (incl. the just-created ones), then REPLACE join rows.
    const all = await db
      .select({ id: permissions.id, key: permissions.key })
      .from(permissions)
      .where(inArray(permissions.key, keys));
    const keyToId = new Map(all.map((r) => [r.key, r.id]));

    await db
      .delete(permissionSetPermissions)
      .where(eq(permissionSetPermissions.permissionSetId, set.id));
    await db.insert(permissionSetPermissions).values(
      keys.map((k) => ({
        id: randomUUID(),
        permissionSetId: set!.id,
        permissionId: keyToId.get(k)!,
      })),
    );
    console.log(`  ✓ ${tier.permissionSetName}: ${keys.length} permission(s) synced`);
  }

  console.log('done.');
  process.exit(0);
}

main().catch((err) => {
  console.error('✗ seed failed:', err);
  process.exit(1);
});
