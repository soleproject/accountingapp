/**
 * One-time backfill for the new product-access permission keys
 * (`accounting.access`, `organizer.access`).
 *
 * What it does:
 *   1. Ensures both keys exist in the `permissions` table.
 *   2. Links BOTH keys to EVERY permission_set, so existing user types keep
 *      seeing Accounting/Organizer in the product switcher. You then go uncheck
 *      "Show Accounting…" / "Show Organizer…" on the sets that shouldn't have
 *      access.
 *
 * Run: npx tsx scripts/backfill-product-access.ts
 *
 * Safe to run multiple times — permission rows are select-then-insert and join
 * rows use ON CONFLICT DO NOTHING against uq_permission_set_permission.
 */
import { config } from 'dotenv';
import { randomUUID } from 'crypto';
import postgres from 'postgres';

config({ path: '.env.local' });

const DB_URL = process.env.POSTGRES_URL_NON_POOLING ?? process.env.POSTGRES_URL;
if (!DB_URL) throw new Error('POSTGRES_URL_NON_POOLING (or POSTGRES_URL) is required');

const sql = postgres(DB_URL, { prepare: false, max: 1 });

// Descriptions mirror the catalog's `${section} › ${group} › ${item}` format
// (see allPermissionKeys() in lib/permissions/structure.ts).
const ACCESS_KEYS = [
  { key: 'accounting.access', description: 'Accounting › Product Access › Show Accounting in product switcher' },
  { key: 'organizer.access', description: 'Organizer › Product Access › Show Organizer in product switcher' },
] as const;

async function main() {
  // 1. Ensure each permission row exists; capture its id.
  const permId = new Map<string, string>();
  for (const p of ACCESS_KEYS) {
    const existing = await sql<{ id: string }[]>`
      SELECT id FROM permissions WHERE key = ${p.key} LIMIT 1
    `;
    if (existing.length > 0) {
      permId.set(p.key, existing[0].id);
      console.log(`permission exists  ${p.key}  (id=${existing[0].id})`);
    } else {
      const id = randomUUID();
      await sql`
        INSERT INTO permissions (id, key, description)
        VALUES (${id}, ${p.key}, ${p.description})
      `;
      permId.set(p.key, id);
      console.log(`permission created ${p.key}  (id=${id})`);
    }
  }

  // 2. Link both keys to every permission set (idempotent).
  const sets = await sql<{ id: string; name: string }[]>`
    SELECT id, name FROM permission_sets ORDER BY name
  `;
  let newLinks = 0;
  for (const set of sets) {
    let added = 0;
    for (const p of ACCESS_KEYS) {
      const res = await sql`
        INSERT INTO permission_set_permissions (id, permission_set_id, permission_id)
        VALUES (${randomUUID()}, ${set.id}, ${permId.get(p.key)!})
        ON CONFLICT ON CONSTRAINT uq_permission_set_permission DO NOTHING
      `;
      added += res.count;
    }
    newLinks += added;
    console.log(`set ${set.name.padEnd(20)} +${added} link(s)`);
  }

  console.log(`\nDone — ${sets.length} permission set(s) processed, ${newLinks} new link(s) added.`);
  await sql.end();
  process.exit(0);
}

main().catch(async (e) => {
  console.error('backfill-product-access failed:', e);
  try {
    await sql.end();
  } catch {
    // ignore
  }
  process.exit(1);
});
