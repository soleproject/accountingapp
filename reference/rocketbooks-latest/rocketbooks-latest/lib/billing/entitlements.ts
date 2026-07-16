import 'server-only';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { organizationSubscriptions, organizationEntitlements, billingProducts } from '@/db/schema/schema';
import { isDemoOrg } from '@/lib/auth/demo';
import { hasActiveDemoTrial } from './demo-trial';

/**
 * Decide whether an org may write a transaction (or any financial entry)
 * with the given date. The covered window is:
 *
 *   - any date ≥ the org's earliest subscription_start (covered by base
 *     sub),
 *   - any year for which the org owns a year-unlock entitlement
 *     (current_year_unlock purchase OR prior_year purchase — both produce
 *     an organization_entitlements row keyed by period_year).
 *
 * Future dates are allowed — bookkeeping software has many legitimate
 * reasons to enter forward-dated entries (scheduled payments, recurring
 * accruals). The lockout helper handles past-due states separately.
 *
 * Unsubscribed orgs (no organization_subscriptions row at all) are
 * allowed for now — write-blocking unsubscribed orgs is a future toggle,
 * not part of PR-3's scope.
 *
 * Demo org always allowed — it's a sandbox, not a customer.
 */
export interface DateGateResult {
  allowed: boolean;
  reason?: string;
  /** Year that needs to be unlocked when allowed=false. */
  requiredPeriodYear?: number;
  /**
   * Which SKU to point the user at — 'current_year_unlock' if the year
   * matches today's calendar year, 'prior_year' otherwise. UI uses this
   * to drive the buy button label/price.
   */
  requiredFeatureKey?: 'current_year_unlock' | 'prior_year';
}

export async function canWriteForDate(orgId: string, isoDate: string): Promise<DateGateResult> {
  if (isDemoOrg(orgId)) return { allowed: true };
  // Active 7-day demo trial: skip the subscription-window check entirely.
  // When the trial expires this returns false and the standard gate runs,
  // which finds no active sub and drops the org to read-only.
  if (await hasActiveDemoTrial(orgId)) return { allowed: true };

  const txnDate = new Date(isoDate);
  if (Number.isNaN(txnDate.getTime())) {
    // Bad date input — let the calling validator handle it; nothing to gate.
    return { allowed: true };
  }
  const txnYear = txnDate.getUTCFullYear();
  const currentYear = new Date().getUTCFullYear();

  // Earliest subscription start = when this org first started paying. We
  // pull the smallest current_period_start across all subs (handles the
  // simple PR-2 case of one sub today and future add-ons later). Canceled
  // subs are still considered for coverage of their historical window —
  // an org that paid for March shouldn't lose ability to edit March entries
  // just because they later canceled.
  const [earliest] = await db
    .select({ start: organizationSubscriptions.currentPeriodStart })
    .from(organizationSubscriptions)
    .where(eq(organizationSubscriptions.organizationId, orgId))
    .orderBy(asc(organizationSubscriptions.currentPeriodStart))
    .limit(1);

  if (earliest?.start) {
    const subStart = new Date(earliest.start);
    if (txnDate.getTime() >= subStart.getTime()) return { allowed: true };
  } else {
    // No subscription anywhere — treat as unsubscribed (allow). Once we
    // require all orgs to subscribe, this branch should flip to a hard
    // 'subscription required' error.
    return { allowed: true };
  }

  // The base sub doesn't cover this date. Look for an entitlement for the
  // exact year.
  const [entitlement] = await db
    .select({ id: organizationEntitlements.id })
    .from(organizationEntitlements)
    .where(and(
      eq(organizationEntitlements.organizationId, orgId),
      eq(organizationEntitlements.periodYear, txnYear),
      isNull(organizationEntitlements.revokedAt),
    ))
    .limit(1);

  if (entitlement) return { allowed: true };

  return {
    allowed: false,
    requiredPeriodYear: txnYear,
    requiredFeatureKey: txnYear === currentYear ? 'current_year_unlock' : 'prior_year',
    reason: txnYear === currentYear
      ? `This date is before your subscription started. Purchase the ${txnYear} current-year unlock to enter transactions for the full year.`
      : `Entering ${txnYear} transactions requires the prior-year unlock for ${txnYear}.`,
  };
}

/** Thrown by transaction-write actions when canWriteForDate denies. */
export class DateNotCoveredError extends Error {
  readonly code = 'DATE_NOT_COVERED';
  readonly requiredPeriodYear: number;
  readonly requiredFeatureKey: 'current_year_unlock' | 'prior_year';
  constructor(result: DateGateResult) {
    super(result.reason ?? 'Date is not covered by your subscription');
    this.requiredPeriodYear = result.requiredPeriodYear!;
    this.requiredFeatureKey = result.requiredFeatureKey!;
  }
}

/** Convenience: throws if the date isn't covered. */
export async function requireDateCovered(orgId: string, isoDate: string): Promise<void> {
  const result = await canWriteForDate(orgId, isoDate);
  if (!result.allowed) throw new DateNotCoveredError(result);
}

/**
 * Display-friendly info for a year-unlock SKU. Returned so forms can build
 * a "Buy <year> unlock — $<price>" button without re-querying the catalog.
 *
 * stripeReady is false when the catalog has the SKU but it hasn't been
 * synced to Stripe yet (no stripe_price_id) — calling code should hide
 * the Buy button in that case since Checkout would fail.
 */
export interface UnlockProductInfo {
  id: string;
  name: string;
  unitAmountCents: number;
  currency: string;
  stripeReady: boolean;
}

/**
 * Look up the active billing_product that fulfills a year-unlock request.
 *
 *   featureKey='prior_year'   → matches (feature_key='prior_year', period_year=Y)
 *   featureKey='current_year' → matches feature_key='current_year_unlock'
 *
 * Returns null when no active matching SKU is configured (e.g. super-admin
 * hasn't added "Prior year 2022 unlock" yet). The caller can fall back to
 * a plain error message in that case — the customer can't buy what doesn't
 * exist.
 */
export async function resolveUnlockProduct(
  featureKey: 'current_year_unlock' | 'prior_year',
  periodYear: number,
): Promise<UnlockProductInfo | null> {
  const where = featureKey === 'prior_year'
    ? and(
        eq(billingProducts.featureKey, 'prior_year'),
        eq(billingProducts.periodYear, periodYear),
        eq(billingProducts.active, true),
      )
    : and(
        eq(billingProducts.featureKey, 'current_year_unlock'),
        eq(billingProducts.active, true),
      );

  const [row] = await db
    .select({
      id: billingProducts.id,
      name: billingProducts.name,
      unitAmountCents: billingProducts.unitAmountCents,
      currency: billingProducts.currency,
      stripePriceId: billingProducts.stripePriceId,
    })
    .from(billingProducts)
    .where(where)
    .limit(1);

  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    unitAmountCents: row.unitAmountCents,
    currency: row.currency,
    stripeReady: Boolean(row.stripePriceId),
  };
}

/**
 * Pull the org's full coverage window in one round-trip so callers can
 * decide per-row coverage without N more DB hits. Use this when checking
 * many dates (e.g. the Plaid promote loop). For a single check prefer
 * canWriteForDate.
 */
export interface OrgCoverageWindow {
  /** When the org's earliest subscription period began. Null if unsubscribed. */
  subscriptionStart: Date | null;
  /** Years for which an active (non-revoked) entitlement exists. */
  unlockedYears: Set<number>;
  /**
   * True when the org has an unexpired demo_full trial. Captured here so
   * the sync dateIsCovered() can honor demo without an async call inside
   * tight per-row loops (plaid-promote, imported-promote).
   */
  isDemoTrialActive: boolean;
}

export async function getOrgCoverageWindow(orgId: string): Promise<OrgCoverageWindow> {
  const [sub] = await db
    .select({ start: organizationSubscriptions.currentPeriodStart })
    .from(organizationSubscriptions)
    .where(eq(organizationSubscriptions.organizationId, orgId))
    .orderBy(asc(organizationSubscriptions.currentPeriodStart))
    .limit(1);

  const ents = await db
    .select({ year: organizationEntitlements.periodYear })
    .from(organizationEntitlements)
    .where(and(
      eq(organizationEntitlements.organizationId, orgId),
      isNull(organizationEntitlements.revokedAt),
    ));

  const isDemoTrialActive = await hasActiveDemoTrial(orgId);

  return {
    subscriptionStart: sub?.start ? new Date(sub.start) : null,
    unlockedYears: new Set(ents.map((e) => e.year)),
    isDemoTrialActive,
  };
}

/**
 * Synchronous coverage check against a pre-fetched OrgCoverageWindow.
 * Mirrors canWriteForDate's semantics — unsubscribed orgs are allowed
 * (back-compat), demo handling is the caller's responsibility, future
 * dates always pass.
 */
export function dateIsCovered(date: Date, window: OrgCoverageWindow): boolean {
  if (Number.isNaN(date.getTime())) return true;
  if (window.isDemoTrialActive) return true;
  if (!window.subscriptionStart) return true; // unsubscribed → allow
  if (date.getTime() >= window.subscriptionStart.getTime()) return true;
  return window.unlockedYears.has(date.getUTCFullYear());
}

/**
 * Build the unlock CTA fields a server action returns alongside its error
 * message when the date gate fails. Centralizes the resolveUnlockProduct
 * + price formatting so each gated action's catch is a one-liner.
 *
 * Returns an empty object when the matching SKU isn't configured or isn't
 * synced to Stripe — calling code spreads the result, so the form shows
 * the plain error without a (broken) Buy button.
 */
export interface UnlockCta {
  unlockProductId?: string;
  unlockLabel?: string;
}

export async function buildUnlockCta(error: DateNotCoveredError): Promise<UnlockCta> {
  const sku = await resolveUnlockProduct(error.requiredFeatureKey, error.requiredPeriodYear);
  if (!sku?.stripeReady) return {};
  const price = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: sku.currency.toUpperCase(),
  }).format(sku.unitAmountCents / 100);
  return {
    unlockProductId: sku.id,
    unlockLabel: `Buy ${error.requiredPeriodYear} unlock — ${price}`,
  };
}

/**
 * Whether this org has an active QBO mirroring subscription. A row in
 * organization_subscriptions in status 'active' or 'trialing', referencing
 * a billing_products row whose feature_key='qbo_mirroring', counts as
 * unlocked. Demo orgs are always denied — mirroring writes to a live QBO
 * realm and demo state must never escape.
 *
 * Migration jobs do NOT call this — initial historical pull is free. Only
 * the webhook handler, CDC poller, and outbound queue worker should gate
 * on this.
 */
export async function canMirrorQbo(orgId: string): Promise<boolean> {
  if (isDemoOrg(orgId)) return false;
  // Active 7-day demo trial unlocks mirroring without a qbo_mirroring SKU
  // purchase. Demo orgs intentionally write to a real connected QBO realm
  // (that's the whole point of the trial), unlike isDemoOrg sandboxes.
  if (await hasActiveDemoTrial(orgId)) return true;
  const [row] = await db
    .select({ id: organizationSubscriptions.id })
    .from(organizationSubscriptions)
    .innerJoin(billingProducts, eq(organizationSubscriptions.billingProductId, billingProducts.id))
    .where(and(
      eq(organizationSubscriptions.organizationId, orgId),
      eq(billingProducts.featureKey, 'qbo_mirroring'),
      eq(billingProducts.active, true),
    ))
    .limit(1);
  return Boolean(row);
}

/**
 * Display info for the QBO mirroring SKU so the unlock CTA on
 * /integrations/qbo can render a "Buy" button without re-querying. Returns
 * null when the SKU isn't configured yet (super-admin hasn't seeded it) or
 * when stripePriceId is missing — UI should fall back to a plain
 * "Mirroring not yet available" message in that case.
 */
export async function resolveQboMirroringProduct(): Promise<UnlockProductInfo | null> {
  const [row] = await db
    .select({
      id: billingProducts.id,
      name: billingProducts.name,
      unitAmountCents: billingProducts.unitAmountCents,
      currency: billingProducts.currency,
      stripePriceId: billingProducts.stripePriceId,
    })
    .from(billingProducts)
    .where(and(
      eq(billingProducts.featureKey, 'qbo_mirroring'),
      eq(billingProducts.active, true),
    ))
    .limit(1);
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    unitAmountCents: row.unitAmountCents,
    currency: row.currency,
    stripeReady: Boolean(row.stripePriceId),
  };
}
