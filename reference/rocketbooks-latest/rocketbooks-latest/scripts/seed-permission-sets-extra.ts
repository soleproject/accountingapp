/**
 * Idempotently inserts the "Investor" and "Free Account" permission sets so
 * they appear in the Super Admin > User Type / permission-set dropdowns.
 *
 * Run: npx tsx scripts/seed-permission-sets-extra.ts
 *
 * Safe to run multiple times — checks for existing rows by unique name first.
 */
import { config } from 'dotenv';
import { randomUUID } from 'crypto';
import postgres from 'postgres';

config({ path: '.env.local' });

const DB_URL = process.env.POSTGRES_URL_NON_POOLING ?? process.env.POSTGRES_URL;
if (!DB_URL) throw new Error('POSTGRES_URL_NON_POOLING (or POSTGRES_URL) is required');

const sql = postgres(DB_URL, { prepare: false, max: 1 });

const EXTRA_SETS = [
  {
    name: 'Investor',
    description: 'Read-only access for investors — dashboards and reports, no transactional rights.',
  },
  {
    name: 'Free Account',
    description: 'Limited free-tier user — basic dashboard access; no exports, no integrations.',
  },
] as const;

async function main() {
  let inserted = 0;
  let existed = 0;
  for (const set of EXTRA_SETS) {
    const hits = await sql<{ id: string }[]>`
      SELECT id FROM permission_sets WHERE name = ${set.name} LIMIT 1
    `;
    if (hits.length > 0) {
      existed++;
      console.log(`exists  ${set.name}  (id=${hits[0].id})`);
      continue;
    }
    const id = randomUUID();
    await sql`
      INSERT INTO permission_sets (id, name, description, created_at, updated_at)
      VALUES (${id}, ${set.name}, ${set.description}, NOW(), NOW())
    `;
    inserted++;
    console.log(`created ${set.name}  (id=${id})`);
  }
  console.log(`\nDone — inserted: ${inserted}, already existed: ${existed}`);
  await sql.end();
  process.exit(0);
}

main().catch(async (e) => {
  console.error('seed-permission-sets-extra failed:', e);
  try {
    await sql.end();
  } catch {
    // ignore
  }
  process.exit(1);
});
