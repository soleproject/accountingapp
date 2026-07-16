/**
 * Inspect the firm-billing state for an enterprise — use after running the
 * onboarding/billing flow (test mode or live) to confirm everything wired up.
 *
 *   npx tsx scripts/verify-firm-billing.ts <enterpriseId>
 *
 * Read-only: reads the DB + Stripe (customer, payment method, subscriptions)
 * and the revenue-share ledger. Uses STRIPE_SECRET_KEY + POSTGRES_URL_NON_POOLING
 * from .env.local — so it reports whichever Stripe mode (test/live) is configured.
 */
import { readFileSync } from 'fs';
import postgres from 'postgres';
import Stripe from 'stripe';

function env(k: string): string {
  for (const l of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
    const m = l.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m && m[1] === k) return m[2].replace(/^["']|["']$/g, '');
  }
  throw new Error(`${k} not found in .env.local`);
}

async function main() {
  const enterpriseId = process.argv[2];
  if (!enterpriseId) {
    console.error('Usage: npx tsx scripts/verify-firm-billing.ts <enterpriseId>');
    process.exit(1);
  }
  const sql = postgres(env('POSTGRES_URL_NON_POOLING'), { prepare: false, max: 1, connect_timeout: 8 });
  const stripeKey = env('STRIPE_SECRET_KEY');
  const stripe = new Stripe(stripeKey);
  const mode = stripeKey.startsWith('sk_live_') ? 'LIVE' : 'TEST';

  try {
    const [ent] = await sql`select name, private_label_enabled, client_billing_mode, client_price_mode from organizations where id = ${enterpriseId}`;
    if (!ent) {
      console.log('No organization with id', enterpriseId);
      return;
    }
    console.log(`\nStripe mode: ${mode}`);
    console.log(`Enterprise: ${ent.name}`);
    console.log(`  private label: ${ent.private_label_enabled} | who pays: ${ent.client_billing_mode} | price mode: ${ent.client_price_mode}`);

    const [billing] = await sql`select stripe_customer_id, status from organization_billing where organization_id = ${enterpriseId}`;
    console.log(`\nFirm Stripe customer: ${billing?.stripe_customer_id ?? '(none)'} | billing status: ${billing?.status ?? '—'}`);

    if (billing?.stripe_customer_id) {
      const customer = await stripe.customers.retrieve(billing.stripe_customer_id);
      const defPm = !(customer as Stripe.DeletedCustomer).deleted
        ? (customer as Stripe.Customer).invoice_settings?.default_payment_method
        : null;
      console.log(`  default payment method: ${defPm ? '✓ on file' : '✗ none'}`);

      const subs = await stripe.subscriptions.list({ customer: billing.stripe_customer_id, status: 'all', limit: 100 });
      console.log(`\n  Subscriptions on the firm customer (${subs.data.length}):`);
      for (const s of subs.data) {
        const item = s.items.data[0];
        const amt = item?.price.unit_amount != null ? `$${(item.price.unit_amount / 100).toFixed(2)}` : '?';
        const clientOrg = s.metadata?.organization_id ?? '';
        const tag = s.metadata?.firm_paid === 'true' ? `firm-paid client=${clientOrg}` : (s.metadata?.feature_key ?? '');
        console.log(`    - ${s.status.padEnd(10)} ${amt.padEnd(8)} ${item?.price.id}  ${tag}`);
      }
    }

    const rev = await sql`
      select client_organization_id, enterprise_tier, client_price_cents, partner_share_cents, is_within_cap, billing_period_start
      from enterprise_client_revenue_share where enterprise_id = ${enterpriseId}
      order by billing_period_start desc limit 50`;
    console.log(`\n  Revenue-share ledger rows (${rev.length}):`);
    for (const r of rev as any[]) {
      console.log(`    - client=${r.client_organization_id.slice(0, 8)} tier=${r.enterprise_tier} client=$${(r.client_price_cents / 100).toFixed(2)} partner=$${(r.partner_share_cents / 100).toFixed(2)} cap=${r.is_within_cap}`);
    }
    console.log('');
  } finally {
    await sql.end();
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e.message); process.exit(1); });
