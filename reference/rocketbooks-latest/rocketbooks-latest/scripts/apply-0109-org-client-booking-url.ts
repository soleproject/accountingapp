/**
 * One-off: apply migration 0109_org_client_booking_url.sql.
 * Run with: npx tsx scripts/apply-0109-org-client-booking-url.ts
 * Idempotent — ADD COLUMN IF NOT EXISTS.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from 'dotenv';
import { sql } from 'drizzle-orm';

config({ path: '.env.local' });

async function main() {
  const { db } = await import('../db/client');
  const ddl = readFileSync(join(process.cwd(), 'db/migrations/0109_org_client_booking_url.sql'), 'utf8');
  await db.execute(sql.raw(ddl));
  console.log('✓ 0109_org_client_booking_url applied.');
  process.exit(0);
}
main().catch((err) => { console.error('✗ migration failed:', err); process.exit(1); });
