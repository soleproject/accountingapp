/**
 * One-off backfill: flag existing depreciation journal entries as adjusting so
 * historical depreciation shows in the Adjustments column of the adjusted trial
 * balance (going-forward runs are flagged at creation in run-asset-depreciation.ts).
 *
 * Run: npx tsx scripts/backfill-depreciation-adjusting.ts
 * Idempotent. Direct connection (NON_POOLING, max:1) — avoids importing db/client.
 */
import { config } from 'dotenv';
import postgres from 'postgres';

config({ path: '.env.local' });

async function main() {
  const url = process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL;
  if (!url) throw new Error('POSTGRES_URL_NON_POOLING / POSTGRES_URL not set');
  const sql = postgres(url, { max: 1, prepare: false });
  try {
    const updated = await sql`
      UPDATE journal_entries
      SET is_adjusting = true
      WHERE source_type = 'asset_depreciation_run' AND is_adjusting IS NOT TRUE
      RETURNING id
    `;
    console.log(`✓ flagged ${updated.length} depreciation entries as adjusting.`);
  } finally {
    await sql.end({ timeout: 5 });
  }
  process.exit(0);
}
main().catch((err) => { console.error('✗ backfill failed:', err); process.exit(1); });
