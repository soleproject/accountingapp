import 'server-only';
import { eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { organizations } from '@/db/schema/schema';
import { effectiveClientBilling } from './client-billing';

export interface ClientBillingRow {
  clientUserId: string;
  clientOrgId: string | null;
  clientName: string;
  /** 'firm' = the firm pays; 'client' = the client pays directly; null = no arrangement. */
  whoPays: 'firm' | 'client' | null;
  /** Monthly price in cents for this client's arrangement (null when unknown). */
  priceCents: number | null;
  /** Day of the month the client is billed (1–31), or null when not billed yet. */
  billingDayOfMonth: number | null;
  /** Subscription status: active | trialing | past_due | canceled | none … */
  status: string;
  /** Next bill date (ISO), or null. */
  nextBillAt: string | null;
  /** The client's current Stripe subscription id, if any. */
  stripeSubscriptionId: string | null;
}

/** $69 in cents — discounted client price + firm-paid price. */
const PRICE_69 = 6900;
/** $89 in cents — standard client price. */
const PRICE_89 = 8900;

/**
 * One billing row per client of a firm, for the enterprise Billing list.
 * Pure DB (no Stripe): the per-client arrangement comes from effectiveClientBilling,
 * and the billing day / status / next bill come from the client's current
 * subscription row. The drill-down pulls the actual charges from Stripe.
 */
export async function listClientBilling(enterpriseId: string): Promise<ClientBillingRow[]> {
  const [firm] = await db
    .select({ mode: organizations.clientBillingMode, price: organizations.clientPriceMode })
    .from(organizations)
    .where(eq(organizations.id, enterpriseId))
    .limit(1);

  // One row per client: their owned org + that org's strongest subscription
  // (prefer a real non-demo sub, then the latest period). DISTINCT ON keeps a
  // single row per client even when they own multiple orgs.
  const rows = (await db.execute(sql`
    select distinct on (ec.client_user_id)
      ec.client_user_id           as client_user_id,
      ec.client_billing_mode      as client_mode,
      ec.client_price_mode        as client_price,
      o.id                        as org_id,
      o.name                      as org_name,
      u.full_name                 as full_name,
      u.email                     as email,
      os.status                   as sub_status,
      os.current_period_start     as period_start,
      os.current_period_end       as period_end,
      os.stripe_subscription_id   as stripe_subscription_id,
      bp.feature_key              as feature_key
    from enterprise_clients ec
    join users u on u.id = ec.client_user_id
    left join organizations o on o.owner_user_id = ec.client_user_id
    left join organization_subscriptions os on os.organization_id = o.id
    left join billing_products bp on bp.id = os.billing_product_id
    where ec.enterprise_id = ${enterpriseId}
    order by
      ec.client_user_id,
      (bp.feature_key is not null and bp.feature_key <> 'demo_full') desc nulls last,
      os.current_period_start desc nulls last
  `)) as unknown as Array<Record<string, unknown>>;

  return rows.map((r) => {
    const { billingMode, priceMode } = effectiveClientBilling({
      enterpriseMode: (firm?.mode as string) ?? null,
      enterprisePrice: (firm?.price as string) ?? null,
      clientMode: (r.client_mode as string) ?? null,
      clientPrice: (r.client_price as string) ?? null,
    });
    const whoPays = billingMode === 'firm_pays' ? 'firm' : billingMode === 'client_pays' ? 'client' : null;
    const priceCents =
      billingMode === 'firm_pays'
        ? PRICE_69
        : billingMode === 'client_pays'
          ? priceMode === 'discount_69'
            ? PRICE_69
            : PRICE_89
          : null;

    // Billing day = the day of the month they actually get charged, i.e. the
    // next-bill (period end) day. For active monthly subs that equals the
    // period-start day; for trialing subs it's the first real charge day (the
    // period-start day would wrongly show the trial-start date).
    const periodEnd = r.period_end ? String(r.period_end) : null;
    const periodStart = r.period_start ? String(r.period_start) : null;
    const billingDaySource = periodEnd ?? periodStart;
    const featureKey = (r.feature_key as string) ?? null;
    const rawStatus = (r.sub_status as string) ?? null;
    const status = !rawStatus ? 'none' : featureKey === 'demo_full' ? 'trial' : rawStatus;

    return {
      clientUserId: String(r.client_user_id),
      clientOrgId: r.org_id ? String(r.org_id) : null,
      clientName: (r.org_name as string)?.trim() || (r.full_name as string)?.trim() || String(r.email),
      whoPays,
      priceCents,
      billingDayOfMonth: billingDaySource ? new Date(billingDaySource).getUTCDate() : null,
      status,
      nextBillAt: periodEnd,
      stripeSubscriptionId: r.stripe_subscription_id ? String(r.stripe_subscription_id) : null,
    };
  });
}
