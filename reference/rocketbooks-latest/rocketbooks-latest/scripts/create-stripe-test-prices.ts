/**
 * Create TEST-mode Stripe prices for the enterprise billing test pass, and
 * print the STRIPE_TEST_PRICE_OVERRIDES JSON to paste into .env.local.
 *
 *   npx tsx scripts/create-stripe-test-prices.ts
 *
 * Requires STRIPE_SECRET_KEY in .env.local to be a TEST key (sk_test_…).
 * Safe to re-run (creates fresh prices each time; harmless in test mode).
 */
import { readFileSync } from 'fs';
import Stripe from 'stripe';

function env(k: string): string {
  for (const l of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
    const m = l.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m && m[1] === k) return m[2].replace(/^["']|["']$/g, '');
  }
  throw new Error(`${k} not found in .env.local`);
}

const PRODUCTS: { featureKey: string; name: string; cents: number }[] = [
  { featureKey: 'base_seat', name: 'Base monthly subscription (TEST)', cents: 8900 },
  { featureKey: 'acc_pro_69_client_pay', name: 'Accounting Pro $69 Client Pays (TEST)', cents: 6900 },
  { featureKey: 'private_label_69_monthly', name: 'Private Label $69 Pro Pays (TEST)', cents: 6900 },
  { featureKey: 'private_label_95_mo', name: 'Private Label Enterprise (TEST)', cents: 9500 },
];

async function main() {
  const key = env('STRIPE_SECRET_KEY');
  if (!key.startsWith('sk_test_')) {
    console.error('Refusing to run: STRIPE_SECRET_KEY in .env.local is not a sk_test_ key.');
    process.exit(1);
  }
  const stripe = new Stripe(key);
  const overrides: Record<string, string> = {};
  for (const p of PRODUCTS) {
    const price = await stripe.prices.create({
      currency: 'usd',
      unit_amount: p.cents,
      recurring: { interval: 'month' },
      product_data: { name: p.name },
      metadata: { feature_key: p.featureKey },
    });
    overrides[p.featureKey] = price.id;
    console.log(`  ${p.featureKey.padEnd(26)} $${(p.cents / 100).toFixed(2).padEnd(7)} ${price.id}`);
  }
  console.log('\nPaste this into .env.local (single line):\n');
  console.log(`STRIPE_TEST_PRICE_OVERRIDES=${JSON.stringify(overrides)}`);
  console.log('');
}

main().then(() => process.exit(0)).catch((e) => { console.error(e.message); process.exit(1); });
