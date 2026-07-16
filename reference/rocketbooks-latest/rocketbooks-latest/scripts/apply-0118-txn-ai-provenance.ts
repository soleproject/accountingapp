/**
 * One-off: apply migration 0118_txn_ai_provenance.sql.
 * Run with: npx tsx scripts/apply-0118-txn-ai-provenance.ts
 * Idempotent (ADD COLUMN IF NOT EXISTS).
 *
 * Connects directly via postgres (NON_POOLING, max:1) instead of importing
 * db/client — db/client pulls in '@opennextjs/cloudflare', which isn't
 * resolvable under tsx, and a single-shot DDL doesn't need the pooled client.
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
    const ddl = readFileSync(join(process.cwd(), 'db/migrations/0118_txn_ai_provenance.sql'), 'utf8');
    await sql.unsafe(ddl);
    console.log('✓ 0118_txn_ai_provenance applied.');
  } finally {
    await sql.end({ timeout: 5 });
  }
  process.exit(0);
}
main().catch((err) => { console.error('✗ migration failed:', err); process.exit(1); });
