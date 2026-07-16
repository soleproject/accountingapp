import 'server-only';
import { sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { billingProducts, organizations, organizationSubscriptions } from '@/db/schema/schema';
import type { EnterpriseClientCounts } from '@/lib/enterprise/clients';

/**
 * Classify a referrer's referred orgs by subscription state. Mirrors
 * classifyEnterpriseClients (lib/enterprise/clients.ts) but keyed on
 * organizations.referred_by_user_id instead of enterprise_clients, so it
 * returns the same `EnterpriseClientCounts` shape and drops straight into
 * <ShareView />.
 *
 * "paying" = the referred org has a current (unexpired) non-demo subscription;
 * "trial" = its strongest current sub is demo_full; "none" = no current sub.
 * Every referred org was attributed via a ?ref link, so the whole `source`
 * count is `inviteLink`.
 */
export async function classifyUserReferrals(referrerUserId: string): Promise<EnterpriseClientCounts> {
  const now = new Date().toISOString();

  const rows = await db.execute(sql`
    with referral_status as (
      select
        o.id as org_id,
        bool_or(
          bp.feature_key <> 'demo_full'
          and (os.current_period_end is null or os.current_period_end > ${now})
        ) as has_paid,
        bool_or(
          bp.feature_key = 'demo_full'
          and (os.current_period_end is null or os.current_period_end > ${now})
        ) as has_trial
      from ${organizations} o
      left join ${organizationSubscriptions} os on os.organization_id = o.id
      left join ${billingProducts} bp on bp.id = os.billing_product_id
      where o.referred_by_user_id = ${referrerUserId}
      group by o.id
    )
    select
      count(*) filter (where has_paid)::int as paying,
      count(*) filter (where not has_paid and has_trial)::int as trial,
      count(*) filter (where not has_paid and not has_trial)::int as none,
      count(*)::int as total
    from referral_status
  `);

  const row = (rows as unknown as Array<Record<string, unknown>>)[0] ?? {};
  const total = toInt(row.total);
  return {
    paying: toInt(row.paying),
    trial: toInt(row.trial),
    none: toInt(row.none),
    // Every referred org came via the referral link; no manual/legacy rows.
    source: { inviteLink: total, manual: 0, unknown: 0 },
    total,
  };
}

function toInt(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return parseInt(value, 10) || 0;
  return 0;
}
