import { NextResponse } from 'next/server';
import { and, asc, desc, eq, isNull, or } from 'drizzle-orm';
import { db } from '@/db/client';
import { requireSession } from '@/lib/auth/session';
import { getCurrentOrgId } from '@/lib/auth/org';
import { billingProducts, organizationEntitlements } from '@/db/schema/schema';
import { getEnterpriseAllowedProductIds, isGatedFeatureKey, resolveUserEnterpriseId } from '@/lib/enterprise/client-products';
import { timeDb } from '@/lib/perf/db-timing';

const HIDDEN_ADDON_FEATURE_KEYS = new Set(['base_seat', 'demo_full']);
const PARTNER_FEATURE_KEYS = new Set([
  'enterprise_seat_pl_495',
  'enterprise_seat_pl_995',
  'enterprise_seat_cp1',
]);

export async function GET() {
  const sessionUser = await requireSession();
  const orgId = await getCurrentOrgId();

  const [entitlements, activeProducts] = await timeDb('billing.deferredDetails', async () => {
    const ents = await db
      .select({
        id: organizationEntitlements.id,
        periodYear: organizationEntitlements.periodYear,
        unitAmountCents: organizationEntitlements.unitAmountCents,
        currency: organizationEntitlements.currency,
        grantedAt: organizationEntitlements.grantedAt,
        productName: billingProducts.name,
      })
      .from(organizationEntitlements)
      .leftJoin(billingProducts, eq(billingProducts.id, organizationEntitlements.billingProductId))
      .where(and(eq(organizationEntitlements.organizationId, orgId), isNull(organizationEntitlements.revokedAt)))
      .orderBy(desc(organizationEntitlements.periodYear));

    const products = await db
      .select({
        id: billingProducts.id,
        name: billingProducts.name,
        description: billingProducts.description,
        kind: billingProducts.kind,
        featureKey: billingProducts.featureKey,
        periodYear: billingProducts.periodYear,
        stripePriceId: billingProducts.stripePriceId,
        unitAmountCents: billingProducts.unitAmountCents,
        currency: billingProducts.currency,
      })
      .from(billingProducts)
      .where(and(
        eq(billingProducts.active, true),
        or(
          eq(billingProducts.kind, 'subscription'),
          eq(billingProducts.featureKey, 'current_year_unlock'),
          eq(billingProducts.featureKey, 'prior_year'),
        ),
      ))
      .orderBy(asc(billingProducts.featureKey), desc(billingProducts.periodYear), asc(billingProducts.name));
    return [ents, products] as const;
  });

  const addOnProducts = activeProducts.filter((p) => p.kind === 'subscription');
  const addOnOffers = addOnProducts.filter((p) => !HIDDEN_ADDON_FEATURE_KEYS.has(p.featureKey));
  const gatedAddOnOffers = addOnOffers.filter((p) => isGatedFeatureKey(p.featureKey));
  const viewerEnterpriseId = gatedAddOnOffers.length > 0 ? await resolveUserEnterpriseId(sessionUser.id) : null;
  const allowedGatedProductIds = viewerEnterpriseId
    ? await getEnterpriseAllowedProductIds(viewerEnterpriseId)
    : new Set<string>();
  const accountingAddOns = addOnOffers.filter(
    (p) => !PARTNER_FEATURE_KEYS.has(p.featureKey) && (!isGatedFeatureKey(p.featureKey) || allowedGatedProductIds.has(p.id)),
  );
  const partnerAddOns = addOnOffers.filter((p) => PARTNER_FEATURE_KEYS.has(p.featureKey));
  const ownedYears = new Set(entitlements.map((e) => e.periodYear));
  const currentYear = new Date().getUTCFullYear();
  const unlockOffers = activeProducts
    .filter((p) => p.stripePriceId && (p.featureKey === 'current_year_unlock' || p.featureKey === 'prior_year'))
    .map((p) => ({ ...p, displayYear: p.featureKey === 'current_year_unlock' ? currentYear : (p.periodYear ?? 0) }))
    .filter((p) => p.displayYear > 0 && !ownedYears.has(p.displayYear));

  return NextResponse.json({ entitlements, accountingAddOns, partnerAddOns, unlockOffers });
}
