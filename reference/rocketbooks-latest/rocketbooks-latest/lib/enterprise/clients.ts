import 'server-only';
import { sql } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  billingProducts,
  enterpriseClients,
  organizations,
  organizationSubscriptions,
} from '@/db/schema/schema';

export interface EnterpriseClientCounts {
  /**
   * Clients with at least one client-owned org on a non-demo subscription
   * (real Stripe sub). Drives partner earnings projection.
   */
  paying: number;
  /**
   * Clients on the 7-day demo_full trial. Counted toward the cap (they
   * occupy a slot) but contribute $0 to projected earnings until they
   * convert to a real subscription.
   */
  trial: number;
  /**
   * Clients with no subscription at all — typically created via the
   * super-admin Create User flow with orgMode='later'. Counted toward the
   * cap; also contributes $0.
   */
  none: number;
  /**
   * Acquisition source breakdown — orthogonal to paying/trial/none.
   * Counts of how each client got attached to the enterprise.
   */
  source: {
    /** Self-serve via /signup (host- or invite-slug-resolved). */
    inviteLink: number;
    /** Admin-created via super-admin or enterprise app. */
    manual: number;
    /** Legacy rows pre-migration 0052 — source not recorded. */
    unknown: number;
  };
  /** paying + trial + none. Also = source.inviteLink + manual + unknown. */
  total: number;
}

/**
 * Classify the clients of an enterprise by subscription state. A client
 * is "paying" when they have at least one org with an unexpired
 * subscription on a non-demo product. "Trial" means an unexpired demo_full
 * sub. "None" means no subscription at all (e.g. invited-but-deferred).
 *
 * Subscription expiry rule: current_period_end > now() OR null. Stripe
 * webhook handlers keep current_period_end fresh; we don't talk to Stripe
 * here.
 *
 * For partner earnings projection, callers should pass `.paying` into
 * `projectedPartnerMonthlyCents()` — trial/none clients fill cap slots
 * but contribute $0 until they convert.
 */
export async function classifyEnterpriseClients(enterpriseId: string): Promise<EnterpriseClientCounts> {
  const now = new Date().toISOString();

  // One pass: for every distinct client of the enterprise, derive a single
  // status based on the strongest subscription on any org they own. "Paid"
  // wins over "trial" wins over "none" — a client with both a paid sub on
  // one org and a trial sub on another counts as paying. Source is
  // orthogonal — carried through the CTE and aggregated separately.
  const rows = await db.execute(sql`
    with client_status as (
      select
        ec.client_user_id,
        max(ec.acquisition_source) as acquisition_source,
        bool_or(
          bp.feature_key <> 'demo_full'
          and (os.current_period_end is null or os.current_period_end > ${now})
        ) as has_paid,
        bool_or(
          bp.feature_key = 'demo_full'
          and (os.current_period_end is null or os.current_period_end > ${now})
        ) as has_trial
      from ${enterpriseClients} ec
      left join ${organizations} o on o.owner_user_id = ec.client_user_id
      left join ${organizationSubscriptions} os on os.organization_id = o.id
      left join ${billingProducts} bp on bp.id = os.billing_product_id
      where ec.enterprise_id = ${enterpriseId}
      group by ec.client_user_id
    )
    select
      count(*) filter (where has_paid)::int as paying,
      count(*) filter (where not has_paid and has_trial)::int as trial,
      count(*) filter (where not has_paid and not has_trial)::int as none,
      count(*) filter (where acquisition_source = 'invite_link')::int as source_invite_link,
      count(*) filter (where acquisition_source = 'manual')::int as source_manual,
      count(*) filter (where acquisition_source is null)::int as source_unknown,
      count(*)::int as total
    from client_status
  `);

  // drizzle .execute returns the raw driver result; treat the first row as
  // the totals (the SQL always produces exactly one row).
  const row = (rows as unknown as Array<Record<string, unknown>>)[0] ?? {};
  return {
    paying: toInt(row.paying),
    trial: toInt(row.trial),
    none: toInt(row.none),
    source: {
      inviteLink: toInt(row.source_invite_link),
      manual: toInt(row.source_manual),
      unknown: toInt(row.source_unknown),
    },
    total: toInt(row.total),
  };
}

function toInt(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return parseInt(value, 10) || 0;
  return 0;
}

