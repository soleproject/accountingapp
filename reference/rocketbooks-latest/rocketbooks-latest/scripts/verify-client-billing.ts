/**
 * Inspect the billing arrangement for a single enterprise CLIENT org — use to
 * confirm "varies"-firm per-client billing (and any firm) wired up correctly.
 *
 *   npx tsx scripts/verify-client-billing.ts <clientOrgId>
 *
 * Read-only. Shows the firm's setting, the per-client override on
 * enterprise_clients, the EFFECTIVE billing (override wins, else firm; a
 * 'varies' firm with no override falls back to client-pays standard), what the
 * client/firm is charged, the revenue-share ledger rows, and any firm-paid
 * Stripe subscription tagged to this client. Mirrors verify-firm-billing.ts —
 * uses POSTGRES_URL_NON_POOLING + STRIPE_SECRET_KEY from .env.local.
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

/** Mirrors lib/enterprise/client-billing.ts:effectiveClientBilling. */
function effectiveClientBilling(enterpriseMode: string | null, enterprisePrice: string | null, clientMode: string | null, clientPrice: string | null) {
  const rawMode = clientMode ?? (enterpriseMode === 'varies' ? 'client_pays' : enterpriseMode);
  const billingMode = rawMode === 'firm_pays' || rawMode === 'client_pays' ? rawMode : null;
  const rawPrice = clientPrice ?? enterprisePrice;
  const priceMode = rawPrice === 'discount_69' || rawPrice === 'standard_referral' ? rawPrice : null;
  return { billingMode, priceMode };
}

function chargeSummary(billingMode: string | null, priceMode: string | null): string {
  if (billingMode === 'firm_pays') return 'client pays $0 — firm billed $69/mo';
  if (billingMode === 'client_pays' && priceMode === 'discount_69') return 'client pays $69/mo (discounted) — no partner payout';
  if (billingMode === 'client_pays') return 'client pays $89/mo (standard) — firm earns the referral/partner share';
  return 'standard $89/mo (no enterprise)';
}

async function main() {
  const clientOrgId = process.argv[2];
  if (!clientOrgId) {
    console.error('Usage: npx tsx scripts/verify-client-billing.ts <clientOrgId>');
    process.exit(1);
  }
  const sql = postgres(env('POSTGRES_URL_NON_POOLING'), { prepare: false, max: 1, connect_timeout: 8 });
  const stripeKey = env('STRIPE_SECRET_KEY');
  const stripe = new Stripe(stripeKey);
  const mode = stripeKey.startsWith('sk_live_') ? 'LIVE' : 'TEST';

  try {
    const [org] = await sql`select name, owner_user_id from organizations where id = ${clientOrgId}`;
    if (!org) {
      console.log('No organization with id', clientOrgId);
      return;
    }
    console.log(`\nStripe mode: ${mode}`);
    console.log(`Client org: ${org.name} (${clientOrgId.slice(0, 8)})  owner=${String(org.owner_user_id).slice(0, 8)}`);

    const [link] = await sql`
      select enterprise_id, status, client_billing_mode, client_price_mode
      from enterprise_clients where client_user_id = ${org.owner_user_id} limit 1`;
    if (!link) {
      console.log('\nNot a client of any enterprise → standard $89/mo direct billing.');
      return;
    }

    const [ent] = await sql`
      select name, private_label_enabled, client_billing_mode, client_price_mode, enterprise_tier
      from organizations where id = ${link.enterprise_id}`;
    console.log(`\nEnterprise: ${ent?.name ?? '(missing)'} (${String(link.enterprise_id).slice(0, 8)})  tier=${ent?.enterprise_tier ?? '—'}  PL=${ent?.private_label_enabled}`);
    console.log(`  firm setting:      who pays=${ent?.client_billing_mode ?? '—'}  price=${ent?.client_price_mode ?? '—'}`);
    console.log(`  per-client override: who pays=${link.client_billing_mode ?? '(none)'}  price=${link.client_price_mode ?? '(none)'}`);

    const eff = effectiveClientBilling(ent?.client_billing_mode ?? null, ent?.client_price_mode ?? null, link.client_billing_mode, link.client_price_mode);
    console.log(`\n  EFFECTIVE:  who pays=${eff.billingMode}  price=${eff.priceMode ?? '(standard)'}`);
    console.log(`  → ${chargeSummary(eff.billingMode, eff.priceMode)}`);

    const rev = await sql`
      select enterprise_tier, client_price_cents, partner_share_cents, is_within_cap, client_index_at_write, billing_period_start, paid_out_at
      from enterprise_client_revenue_share where client_organization_id = ${clientOrgId}
      order by billing_period_start desc limit 24`;
    console.log(`\n  Revenue-share rows (${rev.length}):`);
    for (const r of rev as Array<Record<string, unknown>>) {
      const start = String(r.billing_period_start).slice(0, 10);
      console.log(`    - ${start}  client=$${(Number(r.client_price_cents) / 100).toFixed(2)}  partner=$${(Number(r.partner_share_cents) / 100).toFixed(2)}  cap=${r.is_within_cap}  idx=${r.client_index_at_write}  ${r.paid_out_at ? 'paid' : 'unpaid'}`);
    }

    // Firm-paid Stripe subscription tagged to this client (if the firm has a customer).
    const [billing] = await sql`select stripe_customer_id from organization_billing where organization_id = ${link.enterprise_id}`;
    if (billing?.stripe_customer_id) {
      const subs = await stripe.subscriptions.list({ customer: billing.stripe_customer_id, status: 'all', limit: 100 });
      const forThis = subs.data.filter((s) => s.metadata?.organization_id === clientOrgId);
      console.log(`\n  Firm-paid Stripe subscriptions for this client (${forThis.length}):`);
      for (const s of forThis) {
        const item = s.items.data[0];
        const amt = item?.price.unit_amount != null ? `$${(item.price.unit_amount / 100).toFixed(2)}` : '?';
        console.log(`    - ${s.status.padEnd(10)} ${amt.padEnd(8)} ${item?.price.id}  firm_paid=${s.metadata?.firm_paid ?? 'false'}`);
      }
    }
    console.log('');
  } finally {
    await sql.end();
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e.message); process.exit(1); });
