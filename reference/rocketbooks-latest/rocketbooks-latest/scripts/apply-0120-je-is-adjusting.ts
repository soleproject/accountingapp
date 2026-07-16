/**
 * One-off: apply migration 0120_je_is_adjusting.sql.
 * Run with: npx tsx scripts/apply-0120-je-is-adjusting.ts
 * Idempotent. Direct connection (NON_POOLING, max:1) — avoids importing
 * db/client (pulls in @opennextjs/cloudflare under tsx).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from 'dotenv';
import postgres from 'postgres';

config({ path: '.env.local' });

async function main() {
  const url = process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL;
  if (!url) throw new Error('POSTGRES_URL_NON_POOLING / POSTGRES_URL not set');
  const sql = postgres(url, { max: 1, prepare: false });
  try {
    const ddl = readFileSync(join(process.cwd(), 'db/migrations/0120_je_is_adjusting.sql'), 'utf8');
    await sql.unsafe(ddl);
    console.log('✓ 0120_je_is_adjusting applied.');
  } finally {
    await sql.end({ timeout: 5 });
  }
  process.exit(0);
}
main().catch((err) => { console.error('✗ migration failed:', err); process.exit(1); });
