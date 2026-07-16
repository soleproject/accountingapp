import 'server-only';
import { randomUUID } from 'crypto';
import { eq, or, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { organizations, billingProducts, enterpriseClientProducts } from '@/db/schema/schema';

// Built-in feature keys with defined, GLOBAL visibility on /billing. Anything
// NOT in here is a "gated" custom SKU: hidden from client billing pages unless
// the client's enterprise opts it in (an enterprise_client_products row).
export const BUILTIN_FEATURE_KEYS = new Set<string>([
  'base_seat',
  'qbo_mirroring',
  'demo_full',
  'current_year_unlock',
  'prior_year',
  'enterprise_seat_pl_495',
  'enterprise_seat_pl_995',
  'enterprise_seat_cp1',
]);

/** A custom SKU (not a built-in) — these are the per-enterprise-gated products. */
export function isGatedFeatureKey(featureKey: string | null | undefined): boolean {
  return !!featureKey && !BUILTIN_FEATURE_KEYS.has(featureKey);
}

export interface GatedProduct {
  id: string;
  name: string;
  featureKey: string;
  unitAmountCents: number;
  currency: string;
  active: boolean;
  stripeLinked: boolean;
}

/**
 * Every gated (custom-SKU) product in the catalog — the candidates an
 * enterprise can expose to its clients. Includes inactive/unlinked ones so the
 * operator sees the full set; the /billing filter still respects active +
 * Stripe linkage when deciding what's actually purchasable.
 */
export async function listGatedProducts(): Promise<GatedProduct[]> {
  const rows = await db
    .select({
      id: billingProducts.id,
      name: billingProducts.name,
      featureKey: billingProducts.featureKey,
      unitAmountCents: billingProducts.unitAmountCents,
      currency: billingProducts.currency,
      active: billingProducts.active,
      stripePriceId: billingProducts.stripePriceId,
    })
    .from(billingProducts)
    .orderBy(billingProducts.name);
  return rows
    .filter((r) => isGatedFeatureKey(r.featureKey))
    .map((r) => ({
      id: r.id,
      name: r.name,
      featureKey: r.featureKey,
      unitAmountCents: r.unitAmountCents,
      currency: r.currency,
      active: r.active,
      stripeLinked: Boolean(r.stripePriceId),
    }));
}

/** Product ids an enterprise has opted its clients into seeing. */
export async function getEnterpriseAllowedProductIds(enterpriseId: string): Promise<Set<string>> {
  const rows = await db
    .select({ pid: enterpriseClientProducts.billingProductId })
    .from(enterpriseClientProducts)
    .where(eq(enterpriseClientProducts.enterpriseId, enterpriseId));
  return new Set(rows.map((r) => r.pid));
}

/**
 * Replace an enterprise's allowlist with exactly the given product ids. Only
 * real gated products are kept (so a stale/forged id can't grant visibility to
 * a built-in or a deleted product). Delete-then-insert in one transaction.
 */
export async function setEnterpriseAllowedProducts(enterpriseId: string, productIds: string[]): Promise<void> {
  const gated = new Set((await listGatedProducts()).map((p) => p.id));
  const clean = [...new Set(productIds)].filter((id) => gated.has(id));
  await db.transaction(async (tx) => {
    await tx.delete(enterpriseClientProducts).where(eq(enterpriseClientProducts.enterpriseId, enterpriseId));
    if (clean.length > 0) {
      await tx.insert(enterpriseClientProducts).values(
        clean.map((pid) => ({ id: randomUUID(), enterpriseId, billingProductId: pid })),
      );
    }
  });
}

/**
 * The enterprise a user belongs to (as staff or client), for /billing gating.
 * Mirrors getEnterpriseBranding's ranking minus the "owns an enterprise" case —
 * a gated product is a client-facing offering, so we only resolve the
 * staff/client relationship.
 */
export async function resolveUserEnterpriseId(userId: string | null): Promise<string | null> {
  if (!userId) return null;
  const [row] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(
      or(
        sql`${organizations.id} in (select enterprise_id from enterprise_staff where staff_user_id = ${userId} and archived_at is null)`,
        sql`${organizations.id} in (select enterprise_id from enterprise_clients where client_user_id = ${userId})`,
      ),
    )
    .limit(1);
  return row?.id ?? null;
}
