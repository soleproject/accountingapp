import 'server-only';
import { eq, inArray } from 'drizzle-orm';
import { db } from '@/db/client';
import { organizations, enterpriseClients } from '@/db/schema/schema';
import { maybeGetAccountingTier, ACCOUNTING_TIERS } from '@/lib/accounting/tiers';

/** Stripe feature keys for the client subscription prices. */
export const CLIENT_STANDARD_FEATURE_KEY = 'base_seat'; // $89 (legacy / grandfathered)
export const CLIENT_DISCOUNT_FEATURE_KEY = 'acc_pro_69_client_pay'; // $69, client pays (legacy)
export const FIRM_PAID_FEATURE_KEY = 'private_label_69_monthly'; // $69, firm pays

export interface ClientBillingPlan {
  /** The firm this org's owner is a client of, if any. */
  enterpriseId: string | null;
  billingMode: 'client_pays' | 'firm_pays' | null;
  priceMode: 'discount_69' | 'standard_referral' | null;
  /** When the firm covers this client, the client is never charged. */
  firmPaid: boolean;
  /**
   * feature_key of the price the CLIENT should be charged (client_pays path).
   * When the org is on an accounting tier this is the tier's product
   * (accounting_starter/plus/pro = $39/$79/$149); a NULL tier (grandfathered)
   * falls back to the legacy $89/$69 keys.
   */
  clientPriceFeatureKey: string;
}

const DEFAULT_PLAN: ClientBillingPlan = {
  enterpriseId: null,
  billingMode: null,
  priceMode: null,
  firmPaid: false,
  clientPriceFeatureKey: CLIENT_STANDARD_FEATURE_KEY,
};

/**
 * Resolve a client's effective billing arrangement: a per-client override
 * (set when the firm is on "varies") wins; otherwise inherit the firm's
 * setting. A firm on 'varies' with no per-client value falls back to
 * client-pays standard.
 */
export function effectiveClientBilling(args: {
  enterpriseMode: string | null;
  enterprisePrice: string | null;
  clientMode?: string | null;
  clientPrice?: string | null;
}): { billingMode: 'client_pays' | 'firm_pays' | null; priceMode: 'discount_69' | 'standard_referral' | null } {
  const rawMode = args.clientMode ?? (args.enterpriseMode === 'varies' ? 'client_pays' : args.enterpriseMode);
  const billingMode = rawMode === 'firm_pays' || rawMode === 'client_pays' ? rawMode : null;
  const rawPrice = args.clientPrice ?? args.enterprisePrice;
  const priceMode = rawPrice === 'discount_69' || rawPrice === 'standard_referral' ? rawPrice : null;
  return { billingMode, priceMode };
}

/**
 * The client ORG ids a firm effectively pays for ($69/mo each). For a
 * 'firm_pays' firm that's every client; for a 'varies' firm only the clients
 * whose per-client override resolves to firm_pays. Resolves each client user
 * to the org they own. Pure DB — no Stripe.
 */
export async function firmPaidClientOrgIds(enterpriseId: string): Promise<string[]> {
  const [ent] = await db
    .select({ mode: organizations.clientBillingMode, price: organizations.clientPriceMode })
    .from(organizations)
    .where(eq(organizations.id, enterpriseId))
    .limit(1);

  const links = await db
    .select({
      clientUserId: enterpriseClients.clientUserId,
      clientMode: enterpriseClients.clientBillingMode,
      clientPrice: enterpriseClients.clientPriceMode,
    })
    .from(enterpriseClients)
    .where(eq(enterpriseClients.enterpriseId, enterpriseId));

  const firmPaidUserIds = links
    .filter(
      (l) =>
        effectiveClientBilling({
          enterpriseMode: ent?.mode ?? null,
          enterprisePrice: ent?.price ?? null,
          clientMode: l.clientMode,
          clientPrice: l.clientPrice,
        }).billingMode === 'firm_pays',
    )
    .map((l) => l.clientUserId);
  if (firmPaidUserIds.length === 0) return [];

  const orgs = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(inArray(organizations.ownerUserId, firmPaidUserIds));
  return orgs.map((o) => o.id);
}

/** Count of clients the firm effectively pays for ($69/mo each). */
export async function countFirmPaidClients(enterpriseId: string): Promise<number> {
  return (await firmPaidClientOrgIds(enterpriseId)).length;
}

/**
 * Resolve how a client org should be billed, based on the firm (enterprise)
 * it belongs to. Drives both the client checkout price ($89 vs $69) and
 * whether the firm covers the bill instead of the client.
 *
 * Non-enterprise orgs (direct signups) get the standard $89 base seat.
 */
export async function getClientBillingPlan(orgId: string): Promise<ClientBillingPlan> {
  const [org] = await db
    .select({ ownerUserId: organizations.ownerUserId, accountingTier: organizations.accountingTier })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);

  // The org's accounting tier sets the client's base price regardless of how they
  // signed up (firm client or direct). The legacy $89 base-seat fallback is RETIRED:
  // an org with no tier now defaults to the Plus tier ($79) rather than $89, so the
  // retired base_seat price never shows at checkout.
  const tier = maybeGetAccountingTier(org?.accountingTier) ?? ACCOUNTING_TIERS.plus;
  const tierFeatureKey = tier?.billingFeatureKey ?? null;
  const legacyOrTier = (legacy: string) => tierFeatureKey ?? legacy;

  if (!org?.ownerUserId) {
    return { ...DEFAULT_PLAN, clientPriceFeatureKey: legacyOrTier(CLIENT_STANDARD_FEATURE_KEY) };
  }

  const [client] = await db
    .select({
      enterpriseId: enterpriseClients.enterpriseId,
      clientMode: enterpriseClients.clientBillingMode,
      clientPrice: enterpriseClients.clientPriceMode,
    })
    .from(enterpriseClients)
    .where(eq(enterpriseClients.clientUserId, org.ownerUserId))
    .limit(1);
  if (!client?.enterpriseId) {
    return { ...DEFAULT_PLAN, clientPriceFeatureKey: legacyOrTier(CLIENT_STANDARD_FEATURE_KEY) };
  }

  const [ent] = await db
    .select({
      billingMode: organizations.clientBillingMode,
      priceMode: organizations.clientPriceMode,
    })
    .from(organizations)
    .where(eq(organizations.id, client.enterpriseId))
    .limit(1);

  // Per-client override (varies firms) wins over the firm's setting.
  const { billingMode, priceMode } = effectiveClientBilling({
    enterpriseMode: ent?.billingMode ?? null,
    enterprisePrice: ent?.priceMode ?? null,
    clientMode: client.clientMode,
    clientPrice: client.clientPrice,
  });
  const firmPaid = billingMode === 'firm_pays';
  // The firm passing the client the lower rate = the tier's REDUCED price.
  const wantsReduced = billingMode === 'client_pays' && priceMode === 'discount_69';
  let clientPriceFeatureKey: string;
  if (tier) {
    clientPriceFeatureKey = wantsReduced ? tier.reducedBillingFeatureKey : tier.billingFeatureKey;
  } else {
    // Grandfathered $89 client: legacy products.
    clientPriceFeatureKey = wantsReduced ? CLIENT_DISCOUNT_FEATURE_KEY : CLIENT_STANDARD_FEATURE_KEY;
  }

  return { enterpriseId: client.enterpriseId, billingMode, priceMode, firmPaid, clientPriceFeatureKey };
}
