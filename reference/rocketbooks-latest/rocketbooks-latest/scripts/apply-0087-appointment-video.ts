/**
 * One-off: apply migration 0087_appointment_video_meeting.sql.
 * Run with: npx tsx scripts/apply-0087-appointment-video.ts
 *
 * Idempotent — ADD COLUMN IF NOT EXISTS.
 */
import { config } from 'dotenv';
import postgres from 'postgres';

config({ path: '.env.local' });

const DB_URL = process.env.POSTGRES_URL_NON_POOLING ?? process.env.POSTGRES_URL;
if (!DB_URL) throw new Error('POSTGRES_URL_NON_POOLING (or POSTGRES_URL) is required');

const sql = postgres(DB_URL, { prepare: false, max: 1 });

async function main() {
  await sql`
    ALTER TABLE public.appointments
      ADD COLUMN IF NOT EXISTS video_enabled boolean,
      ADD COLUMN IF NOT EXISTS guest_emails  text`;
  console.log('  columns added (or already present)');

  const cols = await sql<{ column_name: string }[]>`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'appointments'
      AND column_name IN ('video_enabled', 'guest_emails')
    ORDER BY column_name`;
  console.log('  present now:', cols.map((c) => c.column_name).join(', '));

  console.log('done.');
  await sql.end();
}

main().catch(async (err) => {
  console.error('migration failed:', err);
  try { await sql.end(); } catch {}
  process.exit(1);
});
