import { sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { requireSession } from '@/lib/auth/session';
import { getCurrentOrgId, isSuperAdmin } from '@/lib/auth/org';
import { ACCOUNTING_TIER_KEYS, ACCOUNTING_TIERS, maybeGetAccountingTier } from '@/lib/accounting/tiers';
import { timeDb } from '@/lib/perf/db-timing';

export type BillingTab = 'accounting' | 'partner';
export interface BillingSummaryParams { tab?: string | null }

export async function loadBillingSummary(params: BillingSummaryParams) {
  const sessionUser = await requireSession();
  const orgId = await getCurrentOrgId();
  const [billingBundle] = await timeDb('billing.summaryBundle', () => db.execute(sql`
    select
      (select row_to_json(org_row) from (select o.name as "name", o.owner_user_id as "ownerUserId", o.paying_party_user_id as "payingPartyUserId", o.accounting_tier as "accountingTier", ob.paying_party_user_id as "billingPayingPartyUserId", ob.stripe_customer_id as "stripeCustomerId", ob.status as "billingStatus", ob.current_period_end as "billingCurrentPeriodEnd" from organizations o left join organization_billing ob on ob.organization_id = o.id where o.id = ${orgId} limit 1) org_row) as "orgBilling",
      coalesce((select json_agg(member_row order by member_row."email" asc) from (select u.id as "id", u.email as "email", u.full_name as "fullName" from users u where u.is_active = true and (u.organization_id = ${orgId} or u.id = (select o.owner_user_id from organizations o where o.id = ${orgId} limit 1))) member_row), '[]'::json) as "memberRows",
      (select row_to_json(payer_row) from (select u.id as "id", u.email as "email", u.full_name as "fullName" from users u where u.id = (select coalesce(o.paying_party_user_id, ob.paying_party_user_id, o.owner_user_id) from organizations o left join organization_billing ob on ob.organization_id = o.id where o.id = ${orgId} limit 1) limit 1) payer_row) as "payingParty",
      coalesce((select (coalesce(ec.client_billing_mode, case when ent.client_billing_mode = 'varies' then 'client_pays' else ent.client_billing_mode end) = 'firm_pays') from organizations o left join enterprise_clients ec on ec.client_user_id = o.owner_user_id left join organizations ent on ent.id = ec.enterprise_id where o.id = ${orgId} limit 1), false) as "firmPaidClient",
      coalesce((select json_agg(sub_row order by sub_row."createdAt" desc) from (select os.id as "id", os.stripe_subscription_id as "stripeSubscriptionId", os.status as "status", os.current_period_end as "currentPeriodEnd", os.cancel_at_period_end as "cancelAtPeriodEnd", os.created_at as "createdAt", bp.name as "productName", bp.feature_key as "productFeatureKey", bp.unit_amount_cents as "productUnitAmount", bp.currency as "productCurrency" from organization_subscriptions os left join billing_products bp on bp.id = os.billing_product_id where os.organization_id = ${orgId}) sub_row), '[]'::json) as "subs"
  `)) as unknown as [{ orgBilling: { name: string; ownerUserId: string | null; payingPartyUserId: string | null; accountingTier: string | null; billingPayingPartyUserId: string | null; stripeCustomerId: string | null; billingStatus: string | null; billingCurrentPeriodEnd: string | null } | null; memberRows: Array<{ id: string; email: string; fullName: string | null }>; payingParty: { id: string; email: string; fullName: string | null } | null; firmPaidClient: boolean; subs: Array<{ id: string; stripeSubscriptionId: string | null; status: string; currentPeriodEnd: string | null; cancelAtPeriodEnd: boolean; productName: string | null; productFeatureKey: string | null; productUnitAmount: number | null; productCurrency: string | null }> }];

  const orgBilling = billingBundle?.orgBilling ?? null;
  const org = orgBilling ? { name: orgBilling.name, ownerUserId: orgBilling.ownerUserId, payingPartyUserId: orgBilling.payingPartyUserId, accountingTier: orgBilling.accountingTier } : null;
  const billing = orgBilling ? { payingPartyUserId: orgBilling.billingPayingPartyUserId, stripeCustomerId: orgBilling.stripeCustomerId, status: orgBilling.billingStatus, currentPeriodEnd: orgBilling.billingCurrentPeriodEnd } : null;
  const superAdmin = org && sessionUser.id !== org.ownerUserId ? await isSuperAdmin() : false;
  const canEditPayer = org ? sessionUser.id === org.ownerUserId || superAdmin : false;
  const memberRows = canEditPayer ? (billingBundle?.memberRows ?? []) : [];
  const payingPartyUserId = org?.payingPartyUserId ?? billing?.payingPartyUserId ?? org?.ownerUserId ?? null;
  const payingParty = memberRows.find((m) => m.id === payingPartyUserId) ?? billingBundle?.payingParty ?? null;
  const subs = billingBundle?.subs ?? [];
  const hasActiveBaseSub = subs.some((s) => s.productFeatureKey !== 'demo_full' && (s.status === 'active' || s.status === 'past_due'));
  const currentTier = maybeGetAccountingTier(org?.accountingTier ?? null);
  const activeSubFeatureKeys = subs.filter((s) => s.status === 'active' || s.status === 'trialing' || s.status === 'past_due').map((s) => s.productFeatureKey).filter((k): k is string => !!k);
  const firmPaidClient = hasActiveBaseSub ? false : Boolean(billingBundle?.firmPaidClient);
  return { tab: params.tab === 'partner' ? 'partner' as const : 'accounting' as const, org, billing, memberRows, payingPartyUserId, payingParty, canEditPayer, subs, hasActiveBaseSub, hasStripeCustomer: Boolean(billing?.stripeCustomerId), currentTierKey: currentTier?.key ?? null, activeSubFeatureKeys, firmPaidClient, accountingTierKeys: ACCOUNTING_TIER_KEYS, accountingTiers: ACCOUNTING_TIERS };
}
