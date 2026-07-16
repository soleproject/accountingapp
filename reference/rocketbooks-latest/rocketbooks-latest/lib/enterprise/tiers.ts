// Enterprise tier registry — single source of truth for private-label /
// certified-partner pricing, included-company caps, and revenue-share
// splits. The tier key is persisted on `organizations.enterprise_tier` for
// enterprise-type orgs (planType='enterprise') and on
// `billing_products.feature_key` as `enterprise_seat_<tier>`.
//
// Client companies under any tier pay the standard $89/mo (8900¢). Of that,
// $50 (5000¢) is the partner's gross share. Pre-cap, the partner keeps all
// $50; post-cap, partner and platform split the $50 evenly ($25/$25).

import { type AccountingTierKey, ACCOUNTING_TIERS } from '@/lib/accounting/tiers';

export type EnterpriseTierKey = 'pl_495' | 'pl_995' | 'cp1';

export type EnterpriseTierInterval = 'month' | 'year';

export interface EnterpriseTier {
  key: EnterpriseTierKey;
  label: string;
  shortLabel: string;
  description: string;
  priceCents: number;
  interval: EnterpriseTierInterval;
  /** Companies the partner can host before the 50/50 split kicks in. */
  includedCompaniesCap: number;
  /** Partner's share per client/month for companies within the cap. */
  partnerShareCentsPreCap: number;
  /** Partner's share per client/month after the cap. */
  partnerShareCentsPostCap: number;
  /** Per-client/month price the client is billed. */
  clientPriceCents: number;
  /** All current tiers private-label by default. */
  privateLabel: true;
  /** featureKey used in billing_products. */
  billingFeatureKey: string;
}

const CLIENT_PRICE_CENTS = 8900;
const CLIENT_DISCOUNT_PRICE_CENTS = 6900; // acc_pro_69_client_pay
const PARTNER_SHARE_FULL_CENTS = 5000;
const PARTNER_SHARE_SPLIT_CENTS = 2500;

// Referral share — the default for enterprise-type orgs that have NOT been
// assigned a paid tier (pl_495 / pl_995 / cp1). They pay no monthly platform
// fee and there's no included-company cap; instead they earn a flat 20% of
// each client's gross ($89/mo) for as long as the client pays. This lets any
// enterprise share an invite link + QR and start earning without committing
// to a Private Label / Certified Partner plan.
export const REFERRAL_GROSS_SHARE_PCT = 20;
export const REFERRAL_SHARE_CENTS = Math.round(
  (CLIENT_PRICE_CENTS * REFERRAL_GROSS_SHARE_PCT) / 100,
);
// Client price for a referral-model client (same $89/mo as everyone else).
export const REFERRAL_CLIENT_PRICE_CENTS = CLIENT_PRICE_CENTS;
// Sentinel stored in enterprise_client_revenue_share.enterprise_tier for
// referral-model rows. NOT a valid organizations.enterprise_tier value (that
// column's CHECK only permits the paid tier keys) — it lives only in the
// ledger to distinguish referral payouts from tier'd ones.
export const REFERRAL_TIER_KEY = 'referral';

export const ENTERPRISE_TIERS: Record<EnterpriseTierKey, EnterpriseTier> = {
  pl_495: {
    key: 'pl_495',
    label: 'Private Label Enterprise (Starter)',
    shortLabel: 'PL $495/mo',
    description: 'Private-label, 30 companies included before 50/50 split.',
    priceCents: 49500,
    interval: 'month',
    includedCompaniesCap: 30,
    partnerShareCentsPreCap: PARTNER_SHARE_FULL_CENTS,
    partnerShareCentsPostCap: PARTNER_SHARE_SPLIT_CENTS,
    clientPriceCents: CLIENT_PRICE_CENTS,
    privateLabel: true,
    billingFeatureKey: 'enterprise_seat_pl_495',
  },
  pl_995: {
    key: 'pl_995',
    label: 'Private Label Enterprise (Pro)',
    shortLabel: 'PL $995/mo',
    description: 'Private-label, 60 companies included before 50/50 split.',
    priceCents: 99500,
    interval: 'month',
    includedCompaniesCap: 60,
    partnerShareCentsPreCap: PARTNER_SHARE_FULL_CENTS,
    partnerShareCentsPostCap: PARTNER_SHARE_SPLIT_CENTS,
    clientPriceCents: CLIENT_PRICE_CENTS,
    privateLabel: true,
    billingFeatureKey: 'enterprise_seat_pl_995',
  },
  cp1: {
    key: 'cp1',
    label: 'Certified Partner Level 1',
    shortLabel: 'CP1 $29k/yr',
    description: 'Private-label, 200 companies included before 50/50 split.',
    priceCents: 2_900_000,
    interval: 'year',
    includedCompaniesCap: 200,
    partnerShareCentsPreCap: PARTNER_SHARE_FULL_CENTS,
    partnerShareCentsPostCap: PARTNER_SHARE_SPLIT_CENTS,
    clientPriceCents: CLIENT_PRICE_CENTS,
    privateLabel: true,
    billingFeatureKey: 'enterprise_seat_cp1',
  },
};

export const ENTERPRISE_TIER_KEYS: readonly EnterpriseTierKey[] = [
  'pl_495',
  'pl_995',
  'cp1',
] as const;

export function isEnterpriseTierKey(value: unknown): value is EnterpriseTierKey {
  return typeof value === 'string' && (ENTERPRISE_TIER_KEYS as readonly string[]).includes(value);
}

export function getEnterpriseTier(key: EnterpriseTierKey): EnterpriseTier {
  return ENTERPRISE_TIERS[key];
}

export function maybeGetEnterpriseTier(key: string | null | undefined): EnterpriseTier | null {
  if (!key) return null;
  return isEnterpriseTierKey(key) ? ENTERPRISE_TIERS[key] : null;
}

/**
 * Partner's share for the Nth client (1-indexed). Pre-cap = full $50;
 * post-cap = $25. Platform's share is `clientPriceCents - partnerShareCents`.
 */
export function partnerShareForClientIndex(
  tier: EnterpriseTier,
  clientIndex: number,
): { partnerShareCents: number; isWithinCap: boolean } {
  const isWithinCap = clientIndex <= tier.includedCompaniesCap;
  return {
    partnerShareCents: isWithinCap ? tier.partnerShareCentsPreCap : tier.partnerShareCentsPostCap,
    isWithinCap,
  };
}

/**
 * Closed-form projection of the partner's monthly gross from `clientCount`
 * active clients. Assumes every client is billing this period — trials and
 * churned subs inflate the number; the dashboard surfaces this as
 * "projected", not "owed". Useful for the cap meter and the Share page.
 */
export function projectedPartnerMonthlyCents(
  tier: EnterpriseTier,
  clientCount: number,
): {
  totalCents: number;
  preCapClients: number;
  postCapClients: number;
} {
  const preCapClients = Math.min(clientCount, tier.includedCompaniesCap);
  const postCapClients = Math.max(0, clientCount - tier.includedCompaniesCap);
  const totalCents =
    preCapClients * tier.partnerShareCentsPreCap +
    postCapClients * tier.partnerShareCentsPostCap;
  return { totalCents, preCapClients, postCapClients };
}

/**
 * Resolve the revenue-share ledger line for a client given the enterprise's
 * `enterprise_tier` value and the client's 1-indexed signup position.
 *
 * - A valid paid-tier key (pl_495 / pl_995 / cp1) → tier math: full $50
 *   pre-cap, $25 post-cap, with the tier's billing interval.
 * - Anything else (NULL / unknown — an untiered enterprise) → the referral
 *   model: flat 20% of the $89 gross, no cap (always "within cap"), billed
 *   monthly. Stored under the `referral` sentinel tier.
 *
 * Single source of truth for the payout engine so the share/QR page and the
 * ledger never disagree on what an untiered partner earns.
 */
export function resolveRevenueShareLine(
  tierValue: string | null | undefined,
  clientIndex: number,
  opts?: {
    billingMode?: string | null;
    priceMode?: string | null;
    /**
     * The CLIENT's accounting tier. When set, payout follows the tier-specific
     * model and the firm's enterprise-tier cap math is bypassed entirely:
     *   - standard (client pays full): client = tier price; partner = tier
     *     referral payout ($7 / $15 / $25).
     *   - discount (client gets the reduced rate): client = reduced price; partner = $0.
     *   - firm_pays (firm covers the client): client = $0; partner = $0 (the
     *     firm gets the lower wholesale price instead of a payout).
     * When omitted (grandfathered $89 client) the legacy cap/referral math runs.
     */
    clientTier?: AccountingTierKey | null;
  },
): {
  enterpriseTier: string;
  clientPriceCents: number;
  partnerShareCents: number;
  isWithinCap: boolean;
  interval: EnterpriseTierInterval;
} {
  // Base line by tier (cap-aware $50/$25) or referral (flat 20% of gross).
  let base: {
    enterpriseTier: string;
    clientPriceCents: number;
    partnerShareCents: number;
    isWithinCap: boolean;
    interval: EnterpriseTierInterval;
  };
  // Tier-priced client: bypass the firm's enterprise-tier cap math entirely and
  // use the per-tier payout model. The recorded enterpriseTier stays the firm's
  // value (or 'referral') for ledger continuity.
  const ct = opts?.clientTier ? ACCOUNTING_TIERS[opts.clientTier] : null;
  if (ct) {
    const enterpriseTier = isEnterpriseTierKey(tierValue) ? tierValue : REFERRAL_TIER_KEY;
    // Firm covers the client → client pays $0, no partner payout (firm took the
    // lower wholesale price instead).
    if (opts?.billingMode === 'firm_pays') {
      return { enterpriseTier, clientPriceCents: 0, partnerShareCents: 0, isWithinCap: true, interval: 'month' };
    }
    // Client gets the reduced rate → reduced price, no partner payout.
    if (opts?.priceMode === 'discount_69') {
      return { enterpriseTier, clientPriceCents: ct.reducedPriceCents, partnerShareCents: 0, isWithinCap: true, interval: 'month' };
    }
    // Standard: client pays full tier price, partner earns the tier referral.
    return { enterpriseTier, clientPriceCents: ct.priceCents, partnerShareCents: ct.referralShareCents, isWithinCap: true, interval: 'month' };
  }

  if (isEnterpriseTierKey(tierValue)) {
    const tier = ENTERPRISE_TIERS[tierValue];
    const { partnerShareCents, isWithinCap } = partnerShareForClientIndex(tier, clientIndex);
    base = {
      enterpriseTier: tier.key,
      clientPriceCents: tier.clientPriceCents,
      partnerShareCents,
      isWithinCap,
      interval: tier.interval,
    };
  } else {
    base = {
      enterpriseTier: REFERRAL_TIER_KEY,
      clientPriceCents: REFERRAL_CLIENT_PRICE_CENTS,
      partnerShareCents: REFERRAL_SHARE_CENTS,
      // Referral has no cap — every paying client earns the full referral share.
      isWithinCap: true,
      interval: 'month',
    };
  }

  // Firm covers the client: the firm pays the platform directly, the client
  // pays $0, and no partner payout is owed to the firm for this client.
  if (opts?.billingMode === 'firm_pays') {
    return { ...base, clientPriceCents: 0, partnerShareCents: 0 };
  }
  // Client pays the discounted $69: the firm traded its share/referral for the
  // lower client price, so the partner payout is $0.
  if (opts?.priceMode === 'discount_69') {
    return { ...base, clientPriceCents: CLIENT_DISCOUNT_PRICE_CENTS, partnerShareCents: 0 };
  }
  return base;
}

/**
 * Closed-form projection of an untiered (referral) enterprise's monthly gross
 * from `clientCount` paying clients — a flat 20% of each client's $89/mo with
 * no cap. Pass the count of paying clients only; trials and no-sub clients
 * earn $0 until they convert.
 */
export function projectedReferralMonthlyCents(payingClients: number): {
  totalCents: number;
} {
  return { totalCents: Math.max(0, payingClients) * REFERRAL_SHARE_CENTS };
}
