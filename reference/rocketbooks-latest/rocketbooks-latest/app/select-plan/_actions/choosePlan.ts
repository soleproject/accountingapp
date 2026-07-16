'use server';

import { redirect } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { organizations } from '@/db/schema/schema';
import { requireSession } from '@/lib/auth/session';
import { getEffectiveUserId } from '@/lib/auth/impersonate';
import { getCurrentOrgId } from '@/lib/auth/org';
import { setOrgAccountingTier } from '@/lib/accounting/assign-tier';
import { createTrialSignupCheckoutSession, createNewBusinessCheckoutSession } from '@/lib/stripe/checkout';
import { isAccountingTierKey } from '@/lib/accounting/tiers';

/**
 * Stamp an org with the chosen tier (+ its permission set) and open that plan's
 * Stripe checkout. Two modes, driven by the hidden fields on the /select-plan form:
 *
 *  - Signup (no org/add): the user's current org gets a 7-DAY TRIAL checkout
 *    (createTrialSignupCheckoutSession) — first company, card on file, no charge 7d.
 *  - Add-company (org=<newOrgId> & add=1): that NEW org gets an IMMEDIATE checkout
 *    (createNewBusinessCheckoutSession, no trial) — each additional company is paid
 *    for right away, per the per-company billing model.
 */
export async function chooseSignupPlanAction(formData: FormData): Promise<void> {
  await requireSession();
  const userId = await getEffectiveUserId();

  const tier = String(formData.get('tier') ?? '');
  if (!isAccountingTierKey(tier)) throw new Error('Pick a plan to continue.');

  const targetOrgParam = String(formData.get('org') ?? '').trim() || null;
  const isAdd = String(formData.get('add') ?? '') === '1' && !!targetOrgParam;

  let orgId: string | null;
  if (isAdd) {
    // Verify the user owns the target org before stamping/charging it (defeats a
    // tampered ?org=).
    const [row] = await db
      .select({ id: organizations.id, ownerUserId: organizations.ownerUserId })
      .from(organizations)
      .where(eq(organizations.id, targetOrgParam!))
      .limit(1);
    if (!row || row.ownerUserId !== userId) throw new Error('That company was not found on your account.');
    orgId = row.id;
  } else {
    orgId = await getCurrentOrgId();
  }
  if (!orgId) throw new Error('No company found for your account.');

  // Stamp the org tier + assign the matching permission set (features) + sync any
  // live sub to the tier price.
  await setOrgAccountingTier(orgId, tier);

  // Build the checkout URL before redirect() (which throws NEXT_REDIRECT). Fall back
  // to the app if it can't be built rather than dead-ending on the picker.
  let checkoutUrl: string | null = null;
  try {
    checkoutUrl = isAdd
      ? await createNewBusinessCheckoutSession(orgId) // immediate pay → /businesses/new/activate
      : await createTrialSignupCheckoutSession(orgId); // 7-day trial → /dashboard
  } catch (e) {
    console.error('Plan-picker checkout failed; landing in app', orgId, e);
  }
  redirect(checkoutUrl ?? '/dashboard');
}
