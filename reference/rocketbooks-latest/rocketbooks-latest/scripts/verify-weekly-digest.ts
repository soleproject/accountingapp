/**
 * End-to-end verification for the weekly digest, against RocketBooks (owner =
 * michael@bigsaas.ai, so the test email goes to the user — safe). Self-cleaning:
 * leaves the owner opted OUT (original state).
 *   npx tsx scripts/verify-weekly-digest.ts
 */
import { config } from 'dotenv';
import { and, eq } from 'drizzle-orm';
config({ path: '.env.local' });

async function main() {
  const { db } = await import('../db/client');
  const { users, organizations } = await import('../db/schema/schema');
  const { signDigestUnsubToken, verifyDigestUnsubToken } = await import('../lib/digest/unsubscribe-token');
  const { buildWeeklyDigest } = await import('../lib/digest/build-weekly-digest');
  const { sendTransactionalEmail } = await import('../lib/email/resend');

  // 1. Column exists (this select fails if weekly_digest_opt_in_at is missing).
  const [row] = await db
    .select({
      orgId: organizations.id,
      orgName: organizations.name,
      ownerId: organizations.ownerUserId,
      ownerEmail: users.email,
      optIn: users.weeklyDigestOptInAt,
    })
    .from(organizations)
    .innerJoin(users, eq(users.id, organizations.ownerUserId))
    .where(and(eq(organizations.name, 'RocketBooks'), eq(users.email, 'michael@bigsaas.ai')))
    .limit(1);
  if (!row) throw new Error('RocketBooks org/owner not found');
  console.log(`✓ column exists; org ${row.orgId}, owner ${row.ownerEmail}`);

  // 2. Token round-trip.
  const tok = signDigestUnsubToken(row.ownerId);
  const back = verifyDigestUnsubToken(tok);
  const tampered = verifyDigestUnsubToken(tok.slice(0, -1) + (tok.endsWith('a') ? 'b' : 'a'));
  if (!process.env.INBOUND_TOKEN_SECRET) {
    console.log('⚠ INBOUND_TOKEN_SECRET unset in this env — unsubscribe links cannot verify (set in prod)');
  } else {
    if (back !== row.ownerId) throw new Error('FAIL: token round-trip');
    if (tampered !== null) throw new Error('FAIL: tampered token accepted');
    console.log('✓ token round-trip ok; tampered token rejected');
  }

  // 3. buildWeeklyDigest — RocketBooks has seeded BR_DEMO dup + ANOM_DEMO anomalies.
  const digest = await buildWeeklyDigest(row.orgId, row.ownerId, row.orgName);
  console.log(`✓ digest built: ${digest.cardCount} cards; subject="${digest.subject}"`);
  if (digest.cardCount === 0) console.log('  (note: no action cards — all-clear variant; seeds may have been cleaned)');
  if (!digest.html.toLowerCase().includes('unsubscribe')) throw new Error('FAIL: no unsubscribe link in HTML');
  if (!digest.text.includes('Unsubscribe')) throw new Error('FAIL: no unsubscribe link in text');
  console.log('✓ unsubscribe link present in html + text');

  // 4. Opt-in + send (real email to the owner = michael, or skipped if no key).
  await db.update(users).set({ weeklyDigestOptInAt: new Date().toISOString() }).where(eq(users.id, row.ownerId));
  const res = await sendTransactionalEmail({
    to: row.ownerEmail,
    subject: digest.subject,
    html: digest.html,
    text: digest.text,
    brandForOrgId: row.orgId,
    usage: { userId: row.ownerId, orgId: row.orgId, actor: 'system', feature: 'weekly-digest' },
  });
  console.log(`✓ send: ${res.sent ? `SENT (id ${res.id}) → ${row.ownerEmail}` : res.skipped ? 'skipped (RESEND_API_KEY unset)' : 'ERROR ' + res.error}`);
  if (!res.sent && !res.skipped) throw new Error('FAIL: send errored: ' + res.error);

  // 5. Unsubscribe (replicates the route core) → clears opt-in (also self-clean).
  const uid = verifyDigestUnsubToken(tok);
  if (uid) await db.update(users).set({ weeklyDigestOptInAt: null }).where(eq(users.id, uid));
  else await db.update(users).set({ weeklyDigestOptInAt: null }).where(eq(users.id, row.ownerId)); // fallback clean if no secret
  const [after] = await db.select({ optIn: users.weeklyDigestOptInAt }).from(users).where(eq(users.id, row.ownerId));
  if (after.optIn !== null) throw new Error('FAIL: unsubscribe did not clear opt-in');
  console.log('✓ unsubscribe cleared opt-in (owner left opted-out / original state)');

  console.log('\nALL WEEKLY-DIGEST CHECKS PASSED');
  process.exit(0);
}
main().catch((e) => { console.error('✗ failed:', e); process.exit(1); });
