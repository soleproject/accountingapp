/**
 * One-off: apply migration 0119_org_ai_automation.sql.
 * Run with: npx tsx scripts/apply-0119-org-ai-automation.ts
 * Idempotent (ADD COLUMN IF NOT EXISTS). Connects directly (NON_POOLING, max:1)
 * to avoid importing db/client (pulls in @opennextjs/cloudflare under tsx).
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
    const ddl = readFileSync(join(process.cwd(), 'db/migrations/0119_org_ai_automation.sql'), 'utf8');
    await sql.unsafe(ddl);
    console.log('✓ 0119_org_ai_automation applied.');
  } finally {
    await sql.end({ timeout: 5 });
  }
  process.exit(0);
}
main().catch((err) => { console.error('✗ migration failed:', err); process.exit(1); });
