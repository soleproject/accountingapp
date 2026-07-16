// Accounting tier registry — single source of truth for the self-serve
// accounting plans that REPLACE the flat $89 plan: Starter $39, Plus $79,
// Pro $149. The tier key is persisted on `organizations.accounting_tier` for
// CLIENT orgs (planType='pro') and on `billing_products.feature_key` as
// `accounting_<tier>`.
//
// Each tier maps 1:1 to a canonical permission set (seeded in Phase 1) so the
// existing per-user permission gating (lib/auth/permissions.ts) "just works"
// once a tier is assigned. Numeric caps (bank connections, seats) and the
// inventory flag are enforced in Phase 2 from the `limits` / `capabilities`
// here — keep this file the ONLY place those numbers live.
//
// IMPORTANT — grandfathering: existing $89 clients are NOT migrated. They keep
// the legacy `base_seat` product and have `accounting_tier = NULL`. NULL means
// "legacy $89", never "no plan". Treat NULL as a real, billable state. The
// three keys below only apply to new clients or ones a firm explicitly moves.
//
// This is a CLIENT-org concept and is entirely separate from the firm-level
// enterprise tiers in lib/enterprise/tiers.ts (pl_495 / pl_995 / cp1), which
// govern the accounting PRO's private-label plan + revenue share.

export type AccountingTierKey = 'starter' | 'plus' | 'pro';

export type AccountingTierInterval = 'month';

/** Capability flags surfaced by a tier. Phase 2 wires each flag to its gate;
 *  Phase 1 derives the permission-set contents from these + the catalog. */
export interface AccountingTierCapabilities {
  /** AI-assisted bank & credit-card reconciliation (lib/reconciliation). */
  reconciliation: boolean;
  /** AP / bill management (remind-only — never moves money). */
  apBills: boolean;
  /** Consent-gated AI AR collections. */
  aiCollections: boolean;
  /** Full AI assistant (voice mode + document drafting), beyond categorization. */
  fullAiAssistant: boolean;
  /** Tags & dimensions on journal entries. */
  tagsDimensions: boolean;
  /** Recurring transactions & invoices. */
  recurring: boolean;
  /** Inventory module (Pro only). Net-new feature — gated now, built later. */
  inventory: boolean;
  /** Entity-type-aware accounting feature packs (trust/nonprofit/etc.). */
  entityPacks: boolean;
  /** Advanced & custom reporting. */
  advancedReporting: boolean;
  /** Multi-location / multi-entity support. */
  multiEntity: boolean;
  // NOTE: QBO one-time migration is intentionally NOT a capability — it's
  // available on every tier (onboarding/acquisition tool). Ongoing QBO *Mirror*
  // (continuous sync) is a separate paid add-on, entitled outside the tier map.
}

export interface AccountingTier {
  key: AccountingTierKey;
  label: string;
  shortLabel: string;
  description: string;
  /** Per-month price the client is billed, in cents. */
  priceCents: number;
  interval: AccountingTierInterval;
  /** featureKey used in billing_products (Stripe product/price link) for the
   *  STANDARD price (client pays full). */
  billingFeatureKey: string;
  /** featureKey for the REDUCED price — charged when the firm covers the client
   *  (firm_pays) OR the firm passes the client the lower rate (discount). Same
   *  amount in both cases, so one product serves both paths. */
  reducedBillingFeatureKey: string;
  /** Reduced monthly price in cents (firm-paid / client-discount). */
  reducedPriceCents: number;
  /** Partner referral payout per month when the client pays the STANDARD rate.
   *  $0 when the firm pays or the client gets the reduced rate. */
  referralShareCents: number;
  /** Canonical permission set name assigned to the org owner (Phase 1). */
  permissionSetName: string;
  /** Numeric caps. `null` = unlimited. */
  limits: {
    /** Connected bank/credit-card feeds (Plaid). */
    bankConnections: number | null;
    /** User seats on the client org. */
    seats: number | null;
  };
  capabilities: AccountingTierCapabilities;
  /** Convenience alias for capabilities.inventory (the headline Pro fence). */
  hasInventory: boolean;
}

export const ACCOUNTING_TIER_KEYS: readonly AccountingTierKey[] = [
  'starter',
  'plus',
  'pro',
] as const;

export const ACCOUNTING_TIERS: Record<AccountingTierKey, AccountingTier> = {
  starter: {
    key: 'starter',
    label: 'Starter',
    shortLabel: '$39/mo',
    description: 'Clean books on autopilot for freelancers & solopreneurs.',
    priceCents: 3900,
    interval: 'month',
    billingFeatureKey: 'accounting_starter',
    reducedBillingFeatureKey: 'accounting_starter_reduced',
    reducedPriceCents: 2900,
    referralShareCents: 700,
    permissionSetName: 'Accounting — Starter',
    limits: { bankConnections: 1, seats: 1 },
    capabilities: {
      reconciliation: false,
      apBills: false,
      aiCollections: false,
      fullAiAssistant: false,
      tagsDimensions: false,
      recurring: false,
      inventory: false,
      entityPacks: false,
      advancedReporting: false,
      multiEntity: false,
    },
    hasInventory: false,
  },
  plus: {
    key: 'plus',
    label: 'Plus',
    shortLabel: '$79/mo',
    description: 'Automate the busywork and bring your team in.',
    priceCents: 7900,
    interval: 'month',
    billingFeatureKey: 'accounting_plus',
    reducedBillingFeatureKey: 'accounting_plus_reduced',
    reducedPriceCents: 6500,
    referralShareCents: 1500,
    permissionSetName: 'Accounting — Plus',
    limits: { bankConnections: null, seats: 5 },
    capabilities: {
      reconciliation: true,
      apBills: true,
      aiCollections: true,
      fullAiAssistant: true,
      tagsDimensions: true,
      recurring: true,
      inventory: false,
      entityPacks: false,
      advancedReporting: false,
      multiEntity: false,
    },
    hasInventory: false,
  },
  pro: {
    key: 'pro',
    label: 'Pro',
    shortLabel: '$149/mo',
    description: 'For businesses that sell product and need accounting that keeps up.',
    priceCents: 14900,
    interval: 'month',
    billingFeatureKey: 'accounting_pro',
    reducedBillingFeatureKey: 'accounting_pro_reduced',
    reducedPriceCents: 11900,
    referralShareCents: 2500,
    permissionSetName: 'Accounting — Pro',
    limits: { bankConnections: null, seats: null },
    capabilities: {
      reconciliation: true,
      apBills: true,
      aiCollections: true,
      fullAiAssistant: true,
      tagsDimensions: true,
      recurring: true,
      inventory: true,
      entityPacks: true,
      advancedReporting: true,
      multiEntity: true,
    },
    hasInventory: true,
  },
};

// Legacy flat plan ($89/mo). Grandfathered clients keep this billing product
// and carry `accounting_tier = NULL`. Kept here so callers have one name for
// "the old plan" instead of sprinkling the magic string/price around.
export const LEGACY_FLAT_FEATURE_KEY = 'base_seat';
export const LEGACY_FLAT_PRICE_CENTS = 8900;

export function isAccountingTierKey(value: unknown): value is AccountingTierKey {
  return (
    typeof value === 'string' &&
    (ACCOUNTING_TIER_KEYS as readonly string[]).includes(value)
  );
}

export function getAccountingTier(key: AccountingTierKey): AccountingTier {
  return ACCOUNTING_TIERS[key];
}

/** Resolve a stored tier value, tolerating NULL/legacy/unknown by returning
 *  null. NULL = grandfathered $89 client — callers decide how to treat that. */
export function maybeGetAccountingTier(
  key: string | null | undefined,
): AccountingTier | null {
  if (!key) return null;
  return isAccountingTierKey(key) ? ACCOUNTING_TIERS[key] : null;
}

/** True when the org is on the grandfathered flat $89 plan (no tier set). */
export function isLegacyFlatClient(tierValue: string | null | undefined): boolean {
  return !tierValue;
}
