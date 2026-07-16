/**
 * One-off backfill: turn ALL five automatic client-interaction emails ON for
 * every existing organization and user, and set every firm's onboarding
 * preference (clientInteractionPrefs) to all-enabled.
 *
 * Run with: npx tsx scripts/backfill-client-interactions-on.ts
 *
 * Idempotent — re-running just re-sets the same values. Cron jobs that send
 * these emails already skip demo orgs and gate on their own thresholds
 * (inbound-email configured, 3+ pending review items, owner-only digest, etc.),
 * so setting the flags here only opts everyone IN; it does not bypass those
 * gates. Users can opt back out anytime (Settings, unsubscribe link, or by
 * asking the AI assistant).
 */
import { config } from 'dotenv';
import postgres from 'postgres';

config({ path: '.env.local' });

const DB_URL = process.env.POSTGRES_URL_NON_POOLING ?? process.env.POSTGRES_URL;
if (!DB_URL) throw new Error('POSTGRES_URL_NON_POOLING (or POSTGRES_URL) is required');

const sql = postgres(DB_URL, { prepare: false, max: 1 });

const ALL_ON = JSON.stringify({
  askNewContacts: true,
  irsDocRequests: true,
  reviewReminders: true,
  weeklyDigest: true,
  monthlyReport: true,
});

async function main() {
  // 1) Firm-level onboarding preference → all enabled (every org; unused on
  //    non-enterprise orgs but harmless, and guarantees all firms are covered).
  const prefs = await sql`
    UPDATE organizations SET client_interaction_prefs = ${ALL_ON}::jsonb`;
  console.log(`clientInteractionPrefs set on ${prefs.count} organizations`);

  // 2) Per-org opt-in toggles → on for every org.
  const orgs = await sql`
    UPDATE organizations SET
      contact_inquiry_enabled = true,
      substantiation_enabled = true,
      review_auto_outreach_enabled = true,
      monthly_report_enabled = true`;
  console.log(`per-org email toggles enabled on ${orgs.count} organizations`);

  // 3) Per-user weekly digest → opt in everyone not already opted in.
  const usersRes = await sql`
    UPDATE users SET weekly_digest_opt_in_at = now()
    WHERE weekly_digest_opt_in_at IS NULL`;
  console.log(`weekly digest opted in for ${usersRes.count} users (previously off)`);

  console.log('backfill done.');
  await sql.end();
}

main().catch(async (err) => {
  console.error('backfill failed:', err);
  try { await sql.end(); } catch {}
  process.exit(1);
});
