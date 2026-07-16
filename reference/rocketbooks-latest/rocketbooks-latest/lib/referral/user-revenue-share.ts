import 'server-only';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { organizations, userReferralRevenueShare } from '@/db/schema/schema';
import { REFERRAL_CLIENT_PRICE_CENTS, REFERRAL_SHARE_CENTS } from '@/lib/enterprise/tiers';

// Postgres unique_violation. drizzle wraps the driver error in a
// DrizzleQueryError, so the pg code can sit on `err.cause.code` rather than
// `err.code` depending on the path — check both.
function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  const causeCode = (err as { cause?: { code?: unknown } }).cause?.code;
  return code === '23505' || causeCode === '23505';
}

/**
 * Record the initial revenue-share row for a freshly-referred org. Called at
 * signup once organizations.referred_by_user_id is set. Flat referral share
 * (REFERRAL_SHARE_CENTS) — the user referral model has no cap, so every paying
 * referral earns the full share.
 *
 * Idempotent: the unique index on (referred_organization_id,
 * billing_period_start) makes a re-run for the same org + period a harmless
 * no-op. Unblocks /share earnings reporting until the Stripe webhook starts
 * writing per-period rows.
 */
export async function recordInitialUserReferralRevenueShare(args: {
  referrerUserId: string;
  referredOrganizationId: string;
  referredSubscriptionId?: string | null;
  /** Defaults to now. */
  periodStart?: Date;
}): Promise<{ inserted: boolean; reason?: string }> {
  const periodStart = args.periodStart ?? new Date();
  const periodEnd = new Date(periodStart);
  periodEnd.setMonth(periodEnd.getMonth() + 1);

  try {
    await db.insert(userReferralRevenueShare).values({
      id: randomUUID(),
      referrerUserId: args.referrerUserId,
      referredOrganizationId: args.referredOrganizationId,
      referredSubscriptionId: args.referredSubscriptionId ?? null,
      billingPeriodStart: periodStart.toISOString(),
      billingPeriodEnd: periodEnd.toISOString(),
      clientPriceCents: REFERRAL_CLIENT_PRICE_CENTS,
      referrerShareCents: REFERRAL_SHARE_CENTS,
      currency: 'usd',
    });
    return { inserted: true };
  } catch (err) {
    if (isUniqueViolation(err)) return { inserted: false, reason: 'duplicate' };
    throw err;
  }
}

/**
 * Called by the Stripe subscription webhook when a non-demo subscription
 * becomes active/trialing for an org. If that org was referred by a user
 * (organizations.referred_by_user_id is set), ensure a revenue-share row
 * exists for the current billing period at the flat referral share. No-ops
 * (`reason: 'no_referrer'`) for the common case where the org has no user
 * referrer.
 *
 * Idempotent via the unique (referred_organization_id, billing_period_start)
 * index — Stripe retries the same event and we tolerate it.
 */
export async function recordPaidBillingPeriodForUserReferral(args: {
  referredOrganizationId: string;
  referredSubscriptionId?: string | null;
  billingPeriodStart: Date;
  billingPeriodEnd: Date;
}): Promise<{ inserted: boolean; reason?: string }> {
  const [org] = await db
    .select({ referredBy: organizations.referredByUserId })
    .from(organizations)
    .where(eq(organizations.id, args.referredOrganizationId))
    .limit(1);
  if (!org || !org.referredBy) return { inserted: false, reason: 'no_referrer' };

  try {
    await db.insert(userReferralRevenueShare).values({
      id: randomUUID(),
      referrerUserId: org.referredBy,
      referredOrganizationId: args.referredOrganizationId,
      referredSubscriptionId: args.referredSubscriptionId ?? null,
      billingPeriodStart: args.billingPeriodStart.toISOString(),
      billingPeriodEnd: args.billingPeriodEnd.toISOString(),
      clientPriceCents: REFERRAL_CLIENT_PRICE_CENTS,
      referrerShareCents: REFERRAL_SHARE_CENTS,
      currency: 'usd',
    });
    return { inserted: true };
  } catch (err) {
    if (isUniqueViolation(err)) return { inserted: false, reason: 'duplicate' };
    throw err;
  }
}
