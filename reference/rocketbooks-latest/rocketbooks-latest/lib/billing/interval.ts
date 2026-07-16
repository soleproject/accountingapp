import { maybeGetEnterpriseTier } from '@/lib/enterprise/tiers';

/**
 * Recurring interval for a billing_products row, derived from its
 * feature_key. Enterprise tiers carry their interval in the central
 * registry (lib/enterprise/tiers.ts); everything else defaults to
 * monthly — base_seat + qbo_mirroring + future add-ons.
 *
 * The DB doesn't store interval on billing_products, so this is the
 * single source of truth shared by checkout (Stripe Price creation)
 * and the UI (price suffix).
 */
export function intervalForFeatureKey(featureKey: string): 'month' | 'year' {
  const tierKey = featureKey.startsWith('enterprise_seat_')
    ? featureKey.slice('enterprise_seat_'.length)
    : null;
  const tier = maybeGetEnterpriseTier(tierKey);
  return tier?.interval ?? 'month';
}

export function intervalSuffix(featureKey: string): '/mo' | '/yr' {
  return intervalForFeatureKey(featureKey) === 'year' ? '/yr' : '/mo';
}
