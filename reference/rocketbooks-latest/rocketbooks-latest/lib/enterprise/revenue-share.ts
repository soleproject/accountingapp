import 'server-only';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  organizations,
  enterpriseClients,
  enterpriseClientRevenueShare,
} from '@/db/schema/schema';
import { resolveRevenueShareLine } from './tiers';
import { effectiveClientBilling } from './client-billing';
import { isAccountingTierKey } from '@/lib/accounting/tiers';

/**
 * Record an initial revenue-share row for a new client org under an
 * enterprise. Tier'd enterprises record the cap-aware $50/$25 share;
 * untiered enterprises record the referral share (flat 20% of gross, no
 * cap). Only no-ops when the enterprise row itself can't be found. One row
 * per client × billing period — the periodic billing job is the source of
 * truth for subsequent periods; this initial row unblocks cap reporting
 * until that job is built.
 *
 * Idempotent: the unique index on (client_organization_id,
 * billing_period_start) means re-running for the same client + period is
 * harmless. We swallow unique-violation errors so retries are safe.
 *
 * Concurrency note: the client_index derived here is a SELECT-then-INSERT,
 * so two near-simultaneous client creations against the same enterprise
 * could both pick the same index. For initial-write cap tracking that's
 * acceptable — the eventual billing job will reconcile.
 */
export async function recordInitialClientRevenueShare(args: {
  enterpriseId: string;
  clientOrganizationId: string;
  /** Optional — the Stripe subscription row this client is on, if any. */
  clientSubscriptionId?: string | null;
  /** Defaults to now. */
  periodStart?: Date;
}): Promise<{ inserted: boolean; reason?: string }> {
  const [enterprise] = await db
    .select({
      tier: organizations.enterpriseTier,
      billingMode: organizations.clientBillingMode,
      priceMode: organizations.clientPriceMode,
    })
    .from(organizations)
    .where(eq(organizations.id, args.enterpriseId))
    .limit(1);

  if (!enterprise) return { inserted: false, reason: 'enterprise_not_found' };

  // 1-indexed position of this client among the enterprise's clients. We
  // count distinct client orgs that already have a revenue-share row plus
  // this one. Counting from enterprise_client_revenue_share (not from
  // enterprise_clients) means the index reflects what we've actually
  // recorded — durable across schema rewrites of the client table.
  const [existing] = await db
    .select({ n: sql<number>`count(distinct ${enterpriseClientRevenueShare.clientOrganizationId})::int` })
    .from(enterpriseClientRevenueShare)
    .where(eq(enterpriseClientRevenueShare.enterpriseId, args.enterpriseId));
  const clientIndex = (existing?.n ?? 0) + 1;

  // Per-client billing override (varies firms): resolve via the client org's
  // owner → enterprise_clients row; falls back to the firm's setting.
  let clientMode: string | null = null;
  let clientPrice: string | null = null;
  const [clientOrg] = await db
    .select({ ownerUserId: organizations.ownerUserId, accountingTier: organizations.accountingTier })
    .from(organizations)
    .where(eq(organizations.id, args.clientOrganizationId))
    .limit(1);
  if (clientOrg?.ownerUserId) {
    const [ecRow] = await db
      .select({ m: enterpriseClients.clientBillingMode, p: enterpriseClients.clientPriceMode })
      .from(enterpriseClients)
      .where(and(eq(enterpriseClients.enterpriseId, args.enterpriseId), eq(enterpriseClients.clientUserId, clientOrg.ownerUserId)))
      .limit(1);
    clientMode = ecRow?.m ?? null;
    clientPrice = ecRow?.p ?? null;
  }
  const eff = effectiveClientBilling({
    enterpriseMode: enterprise.billingMode,
    enterprisePrice: enterprise.priceMode,
    clientMode,
    clientPrice,
  });

  // Tiered clients use the per-tier payout model ($7/$15/$25, $0 when reduced);
  // grandfathered $89 clients fall back to the firm's cap/referral math.
  const share = resolveRevenueShareLine(enterprise.tier, clientIndex, {
    billingMode: eff.billingMode,
    priceMode: eff.priceMode,
    clientTier: isAccountingTierKey(clientOrg?.accountingTier) ? clientOrg.accountingTier : null,
  });

  const periodStart = args.periodStart ?? new Date();
  const periodEnd = new Date(periodStart);
  if (share.interval === 'year') {
    periodEnd.setFullYear(periodEnd.getFullYear() + 1);
  } else {
    periodEnd.setMonth(periodEnd.getMonth() + 1);
  }

  try {
    await db.insert(enterpriseClientRevenueShare).values({
      id: randomUUID(),
      enterpriseId: args.enterpriseId,
      clientOrganizationId: args.clientOrganizationId,
      clientSubscriptionId: args.clientSubscriptionId ?? null,
      enterpriseTier: share.enterpriseTier,
      billingPeriodStart: periodStart.toISOString(),
      billingPeriodEnd: periodEnd.toISOString(),
      clientPriceCents: share.clientPriceCents,
      partnerShareCents: share.partnerShareCents,
      isWithinCap: share.isWithinCap,
      clientIndexAtWrite: clientIndex,
      currency: 'usd',
    });
    return { inserted: true };
  } catch (err) {
    // 23505 = unique_violation on (client_organization_id,
    // billing_period_start). Re-runs of the same creation are harmless.
    if (err && typeof err === 'object' && 'code' in err && (err as { code?: string }).code === '23505') {
      return { inserted: false, reason: 'duplicate' };
    }
    throw err;
  }
}

/**
 * Read-only: how many client orgs has this enterprise hosted (per the
 * revenue-share ledger). Used by the detail page to render the cap meter
 * without joining through enterprise_clients.
 */
export async function countClientsForEnterprise(enterpriseId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(distinct ${enterpriseClientRevenueShare.clientOrganizationId})::int` })
    .from(enterpriseClientRevenueShare)
    .where(eq(enterpriseClientRevenueShare.enterpriseId, enterpriseId));
  return row?.n ?? 0;
}

/**
 * Called by the Stripe subscription webhook when a non-demo subscription
 * becomes active or trialing for an org. If the org belongs to an
 * enterprise, ensures a revenue-share row exists for the current billing
 * period at the correct partner share — $50 pre-cap / $25 post-cap for a
 * tier'd enterprise, or a flat 20%-of-gross referral share for an untiered
 * one.
 *
 * Idempotent via the unique (client_organization_id, billing_period_start)
 * index — Stripe retries the same event multiple times and the webhook
 * handler must tolerate it. Returns `{ inserted: false, reason: 'duplicate' }`
 * on retry; returns `{ inserted: false, reason: 'no_enterprise' }` for
 * orgs that aren't a client of any enterprise (regular paying customers).
 *
 * Client index — for the partner-share math, this client's pre/post-cap
 * standing is fixed by signup order on enterprise_clients (not by ledger
 * write order, which can interleave across periods). Earliest enterprise_clients
 * row for this enterprise determines the index.
 */
export async function recordPaidBillingPeriodForClient(args: {
  clientOrganizationId: string;
  /** Optional FK to organization_subscriptions.id. Omit when the upsert
   *  path makes the actual row id ambiguous; the org + period_start are
   *  enough to identify the row anyway. */
  clientSubscriptionId?: string | null;
  billingPeriodStart: Date;
  billingPeriodEnd: Date;
}): Promise<{ inserted: boolean; reason?: string }> {
  // 1. Find the org's owner.
  const [org] = await db
    .select({ id: organizations.id, ownerUserId: organizations.ownerUserId, accountingTier: organizations.accountingTier })
    .from(organizations)
    .where(eq(organizations.id, args.clientOrganizationId))
    .limit(1);
  if (!org) return { inserted: false, reason: 'org_not_found' };

  // 2. Is the owner a client of any enterprise?
  const [clientRow] = await db
    .select({
      enterpriseId: enterpriseClients.enterpriseId,
      createdAt: enterpriseClients.createdAt,
      clientMode: enterpriseClients.clientBillingMode,
      clientPrice: enterpriseClients.clientPriceMode,
    })
    .from(enterpriseClients)
    .where(eq(enterpriseClients.clientUserId, org.ownerUserId))
    .limit(1);
  if (!clientRow) return { inserted: false, reason: 'no_enterprise' };

  // 3. Load the enterprise. A tier (pl_495/pl_995/cp1) gets the cap-aware
  // $50/$25 share; an untiered enterprise gets the flat 20%-of-gross
  // referral share. Only bail if the enterprise row is gone.
  const [enterprise] = await db
    .select({
      tier: organizations.enterpriseTier,
      billingMode: organizations.clientBillingMode,
      priceMode: organizations.clientPriceMode,
    })
    .from(organizations)
    .where(eq(organizations.id, clientRow.enterpriseId))
    .limit(1);
  if (!enterprise) {
    return { inserted: false, reason: 'enterprise_not_found' };
  }

  // 4. Determine this client's enterprise-relative signup index — the
  // partner-share math uses 1-indexed signup order on enterprise_clients.
  // Counting clients that signed up before this one (inclusive) gives us
  // the client's position in the cap.
  const [{ idx }] = await db
    .select({
      idx: sql<number>`count(*)::int`,
    })
    .from(enterpriseClients)
    .where(and(
      eq(enterpriseClients.enterpriseId, clientRow.enterpriseId),
      sql`${enterpriseClients.createdAt} <= ${clientRow.createdAt}`,
    ));
  const clientIndex = idx ?? 1;
  const effPaid = effectiveClientBilling({
    enterpriseMode: enterprise.billingMode,
    enterprisePrice: enterprise.priceMode,
    clientMode: clientRow.clientMode,
    clientPrice: clientRow.clientPrice,
  });
  const share = resolveRevenueShareLine(enterprise.tier, clientIndex, {
    billingMode: effPaid.billingMode,
    priceMode: effPaid.priceMode,
    clientTier: isAccountingTierKey(org.accountingTier) ? org.accountingTier : null,
  });

  // 5. Insert the row. Unique index on (client_org, period_start) handles
  // retried webhooks — duplicate insert returns 23505 and we treat it as a
  // successful no-op.
  try {
    await db.insert(enterpriseClientRevenueShare).values({
      id: randomUUID(),
      enterpriseId: clientRow.enterpriseId,
      clientOrganizationId: args.clientOrganizationId,
      clientSubscriptionId: args.clientSubscriptionId ?? null,
      enterpriseTier: share.enterpriseTier,
      billingPeriodStart: args.billingPeriodStart.toISOString(),
      billingPeriodEnd: args.billingPeriodEnd.toISOString(),
      clientPriceCents: share.clientPriceCents,
      partnerShareCents: share.partnerShareCents,
      isWithinCap: share.isWithinCap,
      clientIndexAtWrite: clientIndex,
      currency: 'usd',
    });
    return { inserted: true };
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && (err as { code?: string }).code === '23505') {
      return { inserted: false, reason: 'duplicate' };
    }
    throw err;
  }
}

