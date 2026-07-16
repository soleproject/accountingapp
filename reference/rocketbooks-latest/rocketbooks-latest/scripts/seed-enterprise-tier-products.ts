/**
 * Idempotent: ensures a billing_products row + linked Stripe product/price
 * exists for each of the 3 enterprise tiers in lib/enterprise/tiers.ts.
 *
 * Run with: npx tsx scripts/seed-enterprise-tier-products.ts
 *
 * - Skips Stripe entirely when STRIPE_SECRET_KEY isn't set (DB-only mode,
 *   useful in CI / local). Re-run later once the key is wired up to fill in
 *   the Stripe IDs.
 * - Per-tier: skips the INSERT if a row with the same feature_key already
 *   exists; skips the Stripe product creation if stripe_product_id is set;
 *   skips the Stripe price creation if stripe_price_id is set. Partial
 *   sync (product created but no price) is supported — useful for recovery
 *   after a Stripe rate-limit blip.
 */
import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import { eq } from 'drizzle-orm';

config({ path: '.env.local' });

async function main() {
  const { db } = await import('../db/client');
  const { billingProducts } = await import('../db/schema/schema');
  const { ENTERPRISE_TIERS, ENTERPRISE_TIER_KEYS } = await import('../lib/enterprise/tiers');

  const haveStripe = !!process.env.STRIPE_SECRET_KEY;
  const stripeClient = haveStripe ? (await import('../lib/stripe/client')).stripe() : null;

  for (const tierKey of ENTERPRISE_TIER_KEYS) {
    const tier = ENTERPRISE_TIERS[tierKey];

    let [row] = await db
      .select()
      .from(billingProducts)
      .where(eq(billingProducts.featureKey, tier.billingFeatureKey))
      .limit(1);

    if (!row) {
      const id = randomUUID();
      await db.insert(billingProducts).values({
        id,
        name: tier.label,
        description: tier.description,
        kind: 'subscription',
        featureKey: tier.billingFeatureKey,
        periodYear: null,
        unitAmountCents: tier.priceCents,
        currency: 'usd',
        active: true,
      });
      [row] = await db
        .select()
        .from(billingProducts)
        .where(eq(billingProducts.id, id))
        .limit(1);
      console.log(`✓ billing_products row created for ${tierKey}`);
    } else {
      console.log(`· billing_products row already present for ${tierKey} (${row.id})`);
    }

    if (!stripeClient) {
      console.log(`  skipping Stripe sync for ${tierKey} — STRIPE_SECRET_KEY not set`);
      continue;
    }

    let stripeProductId = row.stripeProductId;
    if (!stripeProductId) {
      const product = await stripeClient.products.create({
        name: tier.label,
        description: tier.description,
        active: true,
        metadata: { rocketsuite_tier: tierKey },
      });
      stripeProductId = product.id;
      console.log(`  ✓ Stripe product created: ${stripeProductId}`);
    }

    let stripePriceId = row.stripePriceId;
    if (!stripePriceId) {
      const price = await stripeClient.prices.create({
        product: stripeProductId,
        unit_amount: tier.priceCents,
        currency: 'usd',
        recurring: { interval: tier.interval },
        metadata: { rocketsuite_tier: tierKey },
      });
      stripePriceId = price.id;
      console.log(`  ✓ Stripe price created: ${stripePriceId} (${tier.interval}ly)`);
    }

    if (stripeProductId !== row.stripeProductId || stripePriceId !== row.stripePriceId) {
      await db
        .update(billingProducts)
        .set({
          stripeProductId,
          stripePriceId,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(billingProducts.id, row.id));
      console.log(`  ✓ persisted Stripe IDs back to billing_products`);
    }
  }

  console.log('done.');
  process.exit(0);
}

main().catch((err) => {
  console.error('✗ seed failed:', err);
  process.exit(1);
});
