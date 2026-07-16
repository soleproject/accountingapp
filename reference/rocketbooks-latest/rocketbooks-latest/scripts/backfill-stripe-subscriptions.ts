import { config } from 'dotenv';
config({ path: '.env.local' });

import { isNotNull, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { organizationBilling, organizations } from '@/db/schema/schema';
import { stripe } from '@/lib/stripe/client';
import { handleSubscriptionUpsert } from '@/lib/stripe/handlers';

/**
 * Backfill organization_subscriptions / organization_billing.status from
 * Stripe for orgs whose local state is missing or stale. Runs through
 * every org with a Stripe customer ID, lists all subscriptions on that
 * customer, and pipes each into handleSubscriptionUpsert — the same code
 * the webhook uses. Idempotent (the underlying upsert keys on
 * stripe_subscription_id), so safe to re-run.
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/backfill-stripe-subscriptions.ts
 *   npx tsx --env-file=.env.local scripts/backfill-stripe-subscriptions.ts --org-id=<uuid>
 */
async function main() {
  const args = process.argv.slice(2);
  const orgFilter = args
    .find((a) => a.startsWith('--org-id='))
    ?.slice('--org-id='.length);

  const baseQuery = db
    .select({
      organizationId: organizationBilling.organizationId,
      stripeCustomerId: organizationBilling.stripeCustomerId,
      orgName: organizations.name,
    })
    .from(organizationBilling)
    .innerJoin(organizations, eq(organizations.id, organizationBilling.organizationId))
    .where(isNotNull(organizationBilling.stripeCustomerId));

  const billingRows = orgFilter
    ? await baseQuery.where(eq(organizationBilling.organizationId, orgFilter))
    : await baseQuery;

  if (billingRows.length === 0) {
    console.log(orgFilter
      ? `No org_billing row with Stripe customer for org ${orgFilter}`
      : 'No orgs with a Stripe customer ID — nothing to backfill.');
    process.exit(0);
  }

  console.log(`Scanning ${billingRows.length} org${billingRows.length === 1 ? '' : 's'} with a Stripe customer...`);
  let reconciled = 0;
  let skipped = 0;

  for (const row of billingRows) {
    const customerId = row.stripeCustomerId!;
    let subs;
    try {
      subs = await stripe().subscriptions.list({ customer: customerId, status: 'all', limit: 100 });
    } catch (err) {
      console.warn(`  ${row.orgName} (${row.organizationId}): Stripe list failed — ${err instanceof Error ? err.message : err}`);
      continue;
    }

    if (subs.data.length === 0) {
      console.log(`  ${row.orgName} (${row.organizationId}): no Stripe subscriptions on customer ${customerId}`);
      skipped++;
      continue;
    }

    for (const sub of subs.data) {
      try {
        await handleSubscriptionUpsert(sub);
        console.log(`  ${row.orgName}: reconciled ${sub.id} (${sub.status})`);
        reconciled++;
      } catch (err) {
        console.warn(`  ${row.orgName}: upsert failed for ${sub.id} — ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  console.log(`\nDone. Reconciled ${reconciled} subscription${reconciled === 1 ? '' : 's'}; skipped ${skipped} org${skipped === 1 ? '' : 's'} with no Stripe subs.`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
