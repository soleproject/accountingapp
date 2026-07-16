/**
 * Idempotent: ensures a billing_products row + linked Stripe product/price
 * exists for each of the 3 self-serve accounting tiers in
 * lib/accounting/tiers.ts (Starter $39 / Plus $79 / Pro $149).
 *
 * These REPLACE the flat $89 plan for new clients. The legacy base_seat
 * product is left untouched — grandfathered clients keep it.
 *
 * Run with: npx tsx scripts/seed-accounting-tier-products.ts
 *
 * Modeled on scripts/seed-enterprise-tier-products.ts:
 * - Skips Stripe entirely when STRIPE_SECRET_KEY isn't set (DB-only mode,
 *   useful in CI / local). Re-run later once the key is wired up to fill in
 *   the Stripe IDs.
 * - Per-tier: skips the INSERT if a row with the same feature_key already
 *   exists; skips Stripe product creation if stripe_product_id is set; skips
 *   Stripe price creation if stripe_price_id is set. Partial sync (product
 *   created but no price) is supported — useful for rate-limit recovery.
 */
import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import { eq } from 'drizzle-orm';

config({ path: '.env.local' });

async function main() {
  const { db } = await import('../db/client');
  const { billingProducts } = await import('../db/schema/schema');
  const { ACCOUNTING_TIERS, ACCOUNTING_TIER_KEYS } = await import('../lib/accounting/tiers');

  const haveStripe = !!process.env.STRIPE_SECRET_KEY;
  const stripeClient = haveStripe ? (await import('../lib/stripe/client')).stripe() : null;

  // Two products per tier: STANDARD (client pays full) + REDUCED (firm-paid /
  // client discount). Same Stripe product serves firm-pays and client-discount.
  const products = ACCOUNTING_TIER_KEYS.flatMap((tierKey) => {
    const tier = ACCOUNTING_TIERS[tierKey];
    return [
      {
        metaTier: tierKey,
        featureKey: tier.billingFeatureKey,
        name: `Accounting — ${tier.label}`,
        description: tier.description,
        priceCents: tier.priceCents,
        interval: tier.interval,
      },
      {
        metaTier: `${tierKey}_reduced`,
        featureKey: tier.reducedBillingFeatureKey,
        name: `Accounting — ${tier.label} (reduced)`,
        description: `${tier.label} reduced rate — firm-paid or client discount.`,
        priceCents: tier.reducedPriceCents,
        interval: tier.interval,
      },
    ];
  });

  for (const p of products) {
    let [row] = await db
      .select()
      .from(billingProducts)
      .where(eq(billingProducts.featureKey, p.featureKey))
      .limit(1);

    if (!row) {
      const id = randomUUID();
      await db.insert(billingProducts).values({
        id,
        name: p.name,
        description: p.description,
        kind: 'subscription',
        featureKey: p.featureKey,
        periodYear: null,
        unitAmountCents: p.priceCents,
        currency: 'usd',
        active: true,
      });
      [row] = await db
        .select()
        .from(billingProducts)
        .where(eq(billingProducts.id, id))
        .limit(1);
      console.log(`✓ billing_products row created for ${p.featureKey} ($${p.priceCents / 100}/mo)`);
    } else {
      console.log(`· billing_products row already present for ${p.featureKey} (${row.id})`);
    }

    if (!stripeClient) {
      console.log(`  skipping Stripe sync for ${p.featureKey} — STRIPE_SECRET_KEY not set`);
      continue;
    }

    let stripeProductId = row.stripeProductId;
    if (!stripeProductId) {
      const product = await stripeClient.products.create({
        name: p.name,
        description: p.description,
        active: true,
        metadata: { rocketsuite_accounting_tier: p.metaTier },
      });
      stripeProductId = product.id;
      console.log(`  ✓ Stripe product created: ${stripeProductId}`);
    }

    let stripePriceId = row.stripePriceId;
    if (!stripePriceId) {
      const price = await stripeClient.prices.create({
        product: stripeProductId,
        unit_amount: p.priceCents,
        currency: 'usd',
        recurring: { interval: p.interval },
        metadata: { rocketsuite_accounting_tier: p.metaTier },
      });
      stripePriceId = price.id;
      console.log(`  ✓ Stripe price created: ${stripePriceId} (${p.interval}ly)`);
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
