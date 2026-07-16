'use server';

import { randomUUID } from 'crypto';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { and, eq, isNull, ne } from 'drizzle-orm';
import { db } from '@/db/client';
import { billingProducts, adminAuditLog } from '@/db/schema/schema';
import { requireSession } from '@/lib/auth/session';
import { isSuperAdmin } from '@/lib/auth/org';
import { stripe } from '@/lib/stripe/client';
import { ENTERPRISE_TIERS, isEnterpriseTierKey } from '@/lib/enterprise/tiers';

async function requireSuperAdmin() {
  const u = await requireSession();
  if (!(await isSuperAdmin())) throw new Error('forbidden');
  return u;
}

async function logAudit(adminUserId: string, action: string, targetId: string | null, metadata?: Record<string, unknown>) {
  await db.insert(adminAuditLog).values({
    id: randomUUID(),
    adminUserId,
    action,
    targetType: 'billing_product',
    targetId,
    auditMetadata: metadata ?? null,
  });
}

/** Returned to the form so validation/conflict errors render inline instead
 *  of throwing (which surfaces as a full-page "server error"). */
export type ProductFormState = { error?: string; ok?: boolean };

type Kind = 'subscription' | 'one_time';
type FeatureKey =
  | 'base_seat'
  | 'qbo_mirroring'
  | 'demo_full'
  | 'current_year_unlock'
  | 'prior_year'
  | 'enterprise_seat_pl_495'
  | 'enterprise_seat_pl_995'
  | 'enterprise_seat_cp1';

const SUBSCRIPTION_FEATURE_KEYS: ReadonlySet<FeatureKey> = new Set([
  'base_seat',
  'qbo_mirroring',
  'demo_full',
  'enterprise_seat_pl_495',
  'enterprise_seat_pl_995',
  'enterprise_seat_cp1',
]);
const ALL_FEATURE_KEYS: ReadonlySet<FeatureKey> = new Set([
  'base_seat',
  'qbo_mirroring',
  'demo_full',
  'current_year_unlock',
  'prior_year',
  'enterprise_seat_pl_495',
  'enterprise_seat_pl_995',
  'enterprise_seat_cp1',
]);

// Billing kind is fully determined by the feature key. Encoding the
// relationship here (instead of asking the operator to pick both) prevents
// the mismatch class we hit during PR-1 — kind=subscription with
// feature_key=prior_year would create a recurring Stripe Price that's
// immutable and can't be reused for a one-time purchase.
function kindForFeatureKey(featureKey: FeatureKey): Kind {
  return SUBSCRIPTION_FEATURE_KEYS.has(featureKey) ? 'subscription' : 'one_time';
}

// Enterprise-seat tiers can be monthly (pl_495, pl_995) or yearly (cp1).
// Everything else that's a subscription is monthly today.
function recurringIntervalForFeatureKey(featureKey: string): 'month' | 'year' {
  const tierKey = featureKey.startsWith('enterprise_seat_')
    ? featureKey.slice('enterprise_seat_'.length)
    : '';
  if (isEnterpriseTierKey(tierKey)) return ENTERPRISE_TIERS[tierKey].interval;
  return 'month';
}

// Editable fields only — Stripe IDs are managed by syncProductToStripeAction
// and are never written from form input. Lets the create/update form omit
// the Stripe fields entirely so we don't accidentally clear them on save.
function parseFields(formData: FormData) {
  const name = String(formData.get('name') ?? '').trim();
  const description = String(formData.get('description') ?? '').trim() || null;
  const featureKeyRaw = String(formData.get('featureKey') ?? '').trim();
  const periodYearRaw = String(formData.get('periodYear') ?? '').trim();
  const periodYear = periodYearRaw ? parseInt(periodYearRaw, 10) : null;
  const unitAmountCents = parseInt(String(formData.get('unitAmountCents') ?? ''), 10);
  const currency = (String(formData.get('currency') ?? 'usd').trim().toLowerCase() || 'usd');
  const active = formData.get('active') === 'on';

  if (!name) throw new Error('Name is required');

  // Known keys keep their fixed billing kind; a CUSTOM key (anything not in the
  // list) is a new SKU whose kind the operator picks explicitly. Custom
  // subscriptions price as monthly (recurringIntervalForFeatureKey defaults to
  // 'month' for non-enterprise keys) and grant base software access through the
  // generic subscription gate — no per-key entitlement code required.
  let featureKey: string;
  let kind: Kind;
  if (ALL_FEATURE_KEYS.has(featureKeyRaw as FeatureKey)) {
    featureKey = featureKeyRaw;
    kind = kindForFeatureKey(featureKeyRaw as FeatureKey);
  } else {
    if (!/^[a-z][a-z0-9_]{2,48}$/.test(featureKeyRaw)) {
      throw new Error('Custom feature key must be lowercase snake_case (letters, digits, underscore), 3–49 chars — e.g. "base_seat_49".');
    }
    kind = String(formData.get('customKind') ?? 'subscription') === 'one_time' ? 'one_time' : 'subscription';
    featureKey = featureKeyRaw;
  }

  if (featureKey === 'prior_year' && (periodYear == null || Number.isNaN(periodYear))) {
    throw new Error('Period year is required when feature key is prior_year');
  }
  if (featureKey !== 'prior_year' && periodYear != null) {
    throw new Error('Period year only applies when feature key is prior_year');
  }
  if (!Number.isFinite(unitAmountCents) || unitAmountCents < 0) throw new Error('Unit amount (cents) must be a non-negative integer');

  return { name, description, kind, featureKey, periodYear, unitAmountCents, currency, active };
}

/**
 * Look up an existing product with the same (feature_key, period_year)
 * combination, optionally excluding a specific id (so update can move a
 * row's other fields without false-positive matching itself). Returns
 * null when the slot is free. The DB has a unique index on
 * (feature_key, coalesce(period_year, 0)) — this is the pre-check that
 * turns a raw PostgresError into a friendly message that names the
 * conflicting row and links to its edit page.
 */
async function findFeatureKeyConflict(
  featureKey: string,
  periodYear: number | null,
  excludeId: string | null,
): Promise<{ id: string; name: string } | null> {
  const yearMatch = periodYear == null
    ? isNull(billingProducts.periodYear)
    : eq(billingProducts.periodYear, periodYear);
  const where = excludeId
    ? and(eq(billingProducts.featureKey, featureKey), yearMatch, ne(billingProducts.id, excludeId))
    : and(eq(billingProducts.featureKey, featureKey), yearMatch);
  const [row] = await db
    .select({ id: billingProducts.id, name: billingProducts.name })
    .from(billingProducts)
    .where(where)
    .limit(1);
  return row ?? null;
}

function duplicateFeatureKeyError(
  featureKey: string,
  periodYear: number | null,
  existing: { id: string; name: string },
): Error {
  const yearPart = periodYear == null ? '' : ` (year ${periodYear})`;
  return new Error(
    `A product with feature_key "${featureKey}"${yearPart} already exists: "${existing.name}". Edit it at /super-admin/products/${existing.id}/edit instead of creating a new one.`,
  );
}

export async function createProductAction(
  _prev: ProductFormState,
  formData: FormData,
): Promise<ProductFormState> {
  let newId: string;
  try {
    const admin = await requireSuperAdmin();
    const fields = parseFields(formData);
    const conflict = await findFeatureKeyConflict(fields.featureKey, fields.periodYear, null);
    if (conflict) return { error: duplicateFeatureKeyError(fields.featureKey, fields.periodYear, conflict).message };
    const id = randomUUID();
    await db.insert(billingProducts).values({
      id,
      ...fields,
      createdByUserId: admin.id,
    });
    await logAudit(admin.id, 'billing_product.create', id, { name: fields.name, featureKey: fields.featureKey, periodYear: fields.periodYear });
    newId = id;
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Failed to create product.' };
  }
  // Outside the try so redirect()'s NEXT_REDIRECT control-flow isn't caught.
  revalidatePath('/super-admin/products');
  redirect(`/super-admin/products/${newId}/edit`);
}

export async function updateProductAction(
  _prev: ProductFormState,
  formData: FormData,
): Promise<ProductFormState> {
  try {
    const admin = await requireSuperAdmin();
    const id = String(formData.get('id') ?? '').trim();
    if (!id) return { error: 'id is required' };
    const fields = parseFields(formData);
    const conflict = await findFeatureKeyConflict(fields.featureKey, fields.periodYear, id);
    if (conflict) return { error: duplicateFeatureKeyError(fields.featureKey, fields.periodYear, conflict).message };
    await db.update(billingProducts)
      .set({ ...fields, updatedAt: new Date().toISOString() })
      .where(eq(billingProducts.id, id));
    await logAudit(admin.id, 'billing_product.update', id, { name: fields.name });
    revalidatePath('/super-admin/products');
    revalidatePath(`/super-admin/products/${id}/edit`);
    return { ok: true };
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Failed to update product.' };
  }
}

export async function deleteProductAction(formData: FormData): Promise<void> {
  const admin = await requireSuperAdmin();
  const id = String(formData.get('id') ?? '').trim();
  if (!id) throw new Error('id is required');
  await db.delete(billingProducts).where(eq(billingProducts.id, id));
  await logAudit(admin.id, 'billing_product.delete', id);
  revalidatePath('/super-admin/products');
}

/**
 * Create the matching Stripe Product + Price for a local billing_products
 * row and store the returned IDs back on the row. If either ID is already
 * set we skip the corresponding Stripe call — lets you finish a partial
 * sync (e.g. product was created manually in the dashboard and pasted in,
 * but no price yet) without creating duplicates.
 *
 * For kind='subscription' the price is created as recurring monthly. The
 * recurring interval is hardcoded here because the schema doesn't carry
 * one yet — when we need yearly / weekly we'll add a column.
 */
export async function syncProductToStripeAction(
  _prev: ProductFormState,
  formData: FormData,
): Promise<ProductFormState> {
  try {
    const admin = await requireSuperAdmin();
    const id = String(formData.get('id') ?? '').trim();
    if (!id) return { error: 'id is required' };

    const [row] = await db.select().from(billingProducts).where(eq(billingProducts.id, id)).limit(1);
    if (!row) return { error: 'Product not found' };
    if (row.stripeProductId && row.stripePriceId) {
      return { error: 'Already fully linked to Stripe' };
    }

    const s = stripe();

    let productId = row.stripeProductId;
    if (!productId) {
      const product = await s.products.create({
        name: row.name,
        description: row.description ?? undefined,
        active: row.active,
      });
      productId = product.id;
    }

    let priceId = row.stripePriceId;
    if (!priceId) {
      const price = await s.prices.create({
        product: productId,
        unit_amount: row.unitAmountCents,
        currency: row.currency,
        ...(row.kind === 'subscription'
          ? { recurring: { interval: recurringIntervalForFeatureKey(row.featureKey) } }
          : {}),
      });
      priceId = price.id;
    }

    await db.update(billingProducts)
      .set({
        stripeProductId: productId,
        stripePriceId: priceId,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(billingProducts.id, id));

    await logAudit(admin.id, 'billing_product.stripe_sync', id, { stripeProductId: productId, stripePriceId: priceId });
    revalidatePath('/super-admin/products');
    revalidatePath(`/super-admin/products/${id}/edit`);
    return { ok: true };
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Stripe sync failed.' };
  }
}

/**
 * Replace the linked Stripe Price for an already-linked billing_products row.
 * Stripe Prices are immutable, so changing the displayed amount requires
 * creating a new Price on the existing Stripe Product and re-pointing this
 * row. The previous Price is archived so it can't be used for new Checkout
 * sessions; in-flight sessions already holding the old Price still complete
 * at the old amount.
 *
 * Reads unit_amount_cents / currency from the row, so the operator's flow is
 * "edit the form, save, then click Sync price to Stripe".
 */
export async function updateStripePriceAction(
  _prev: ProductFormState,
  formData: FormData,
): Promise<ProductFormState> {
  try {
    const admin = await requireSuperAdmin();
    const id = String(formData.get('id') ?? '').trim();
    if (!id) return { error: 'id is required' };

    const [row] = await db.select().from(billingProducts).where(eq(billingProducts.id, id)).limit(1);
    if (!row) return { error: 'Product not found' };
    if (!row.stripeProductId) return { error: 'Product is not linked to Stripe yet — use Create in Stripe first' };

    const s = stripe();

    const price = await s.prices.create({
      product: row.stripeProductId,
      unit_amount: row.unitAmountCents,
      currency: row.currency,
      ...(row.kind === 'subscription'
        ? { recurring: { interval: recurringIntervalForFeatureKey(row.featureKey) } }
        : {}),
    });

    const previousPriceId = row.stripePriceId;
    if (previousPriceId && previousPriceId !== price.id) {
      await s.prices.update(previousPriceId, { active: false });
    }

    await db.update(billingProducts)
      .set({
        stripePriceId: price.id,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(billingProducts.id, id));

    await logAudit(admin.id, 'billing_product.stripe_price_update', id, {
      previousStripePriceId: previousPriceId,
      stripePriceId: price.id,
      unitAmountCents: row.unitAmountCents,
    });
    revalidatePath('/super-admin/products');
    revalidatePath(`/super-admin/products/${id}/edit`);
    return { ok: true };
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Stripe price update failed.' };
  }
}
