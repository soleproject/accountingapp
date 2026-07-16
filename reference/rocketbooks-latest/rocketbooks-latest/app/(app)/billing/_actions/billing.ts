'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { organizations, organizationBilling, users } from '@/db/schema/schema';
import { requireSession } from '@/lib/auth/session';
import { getCurrentOrgId, isSuperAdmin } from '@/lib/auth/org';

/**
 * Start the $89/mo base subscription. Creates (or reuses) a Stripe Customer
 * for the org, opens a Checkout Session, and redirects the browser to the
 * Stripe-hosted payment page. On return the customer lands at
 * /billing?checkout=success|cancel.
 */
export async function startSubscriptionCheckoutAction(): Promise<void> {
  await requireSession();
  const orgId = await getCurrentOrgId();
  const { createSubscriptionCheckoutSession } = await import('@/lib/stripe/checkout');
  const url = await createSubscriptionCheckoutSession(orgId);
  redirect(url);
}

/**
 * Self-serve plan selection: set the org's accounting tier, then send the user
 * straight to Stripe checkout at that tier's price ("set tier + checkout
 * immediately"). setOrgAccountingTier stamps the tier + assigns the matching
 * permission set; createSubscriptionCheckoutSession then resolves the price via
 * getClientBillingPlan, which now returns the tier product. Owner/super-admin
 * only — picking a plan changes what the org is billed.
 */
export async function selectPlanAndCheckoutAction(formData: FormData): Promise<void> {
  const sessionUser = await requireSession();
  const orgId = await getCurrentOrgId();

  const tierRaw = String(formData.get('tier') ?? '').trim();
  const { isAccountingTierKey } = await import('@/lib/accounting/tiers');
  if (!isAccountingTierKey(tierRaw)) throw new Error('Pick a valid plan');

  const [org] = await db
    .select({ ownerUserId: organizations.ownerUserId })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  if (!org) throw new Error('Organization not found');
  const canEdit = sessionUser.id === org.ownerUserId || (await isSuperAdmin());
  if (!canEdit) throw new Error('Only the org owner or a super-admin can change the plan');

  const { setOrgAccountingTier } = await import('@/lib/accounting/assign-tier');
  const { createSubscriptionCheckoutSession } = await import('@/lib/stripe/checkout');
  await setOrgAccountingTier(orgId, tierRaw);
  const url = await createSubscriptionCheckoutSession(orgId);
  redirect(url);
}

/**
 * Open the Stripe-hosted Customer Portal in a new tab via redirect. The
 * portal handles card updates, invoice history, and cancellation — Stripe
 * is the source of truth and our webhook reconciles state back.
 */
export async function openCustomerPortalAction(): Promise<void> {
  await requireSession();
  const orgId = await getCurrentOrgId();
  const { createCustomerPortalSession } = await import('@/lib/stripe/portal');
  const url = await createCustomerPortalSession(orgId);
  redirect(url);
}

/**
 * Change the org's paying party. Permitted by org owner or a super-admin.
 * Mirrors the new user's email + name to the Stripe Customer so receipts
 * go to the right person.
 */
export async function setPayingPartyAction(formData: FormData): Promise<void> {
  const sessionUser = await requireSession();
  const orgId = await getCurrentOrgId();
  const newPayingPartyId = String(formData.get('payingPartyUserId') ?? '').trim();
  if (!newPayingPartyId) throw new Error('Paying party is required');

  const [org] = await db
    .select({ ownerUserId: organizations.ownerUserId })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  if (!org) throw new Error('Organization not found');

  // Owner or super-admin only — staff/paying users below the owner
  // shouldn't be able to redirect who gets the bill.
  const canEdit = sessionUser.id === org.ownerUserId || (await isSuperAdmin());
  if (!canEdit) throw new Error('Only the org owner or a super-admin can change the paying party');

  const [newUser] = await db
    .select({ id: users.id, email: users.email, fullName: users.fullName, organizationId: users.organizationId })
    .from(users)
    .where(eq(users.id, newPayingPartyId))
    .limit(1);
  if (!newUser) throw new Error('Selected user not found');
  if (newUser.organizationId !== orgId && newUser.id !== org.ownerUserId) {
    // Defensive: don't let an arbitrary user-id be wired up as the payer.
    // The dropdown only offers in-org users + owner, so this is just a
    // belt-and-suspenders check against tampered form submissions.
    throw new Error('Selected user is not a member of this organization');
  }

  await db
    .update(organizations)
    .set({ payingPartyUserId: newUser.id })
    .where(eq(organizations.id, orgId));

  // Mirror to organization_billing.paying_party_user_id and push the new
  // contact info to the Stripe Customer. If no customer exists yet (no
  // sub started), skip the Stripe side — it'll be created with the right
  // identity on first Checkout.
  const [billing] = await db
    .select({ stripeCustomerId: organizationBilling.stripeCustomerId })
    .from(organizationBilling)
    .where(eq(organizationBilling.organizationId, orgId))
    .limit(1);

  await db
    .insert(organizationBilling)
    .values({
      organizationId: orgId,
      payingPartyUserId: newUser.id,
    })
    .onConflictDoUpdate({
      target: organizationBilling.organizationId,
      set: {
        payingPartyUserId: newUser.id,
        updatedAt: new Date().toISOString(),
      },
    });

  if (billing?.stripeCustomerId) {
    const { stripe } = await import('@/lib/stripe/client');
    await stripe().customers.update(billing.stripeCustomerId, {
      email: newUser.email,
      name: newUser.fullName,
      metadata: {
        organization_id: orgId,
        paying_party_user_id: newUser.id,
      },
    });
  }

  revalidatePath('/billing');
}

/**
 * Start a one-time Checkout for a year unlock (current_year_unlock or
 * prior_year). The product id is the rocketsuite billing_products row;
 * the checkout helper validates the product and resolves the period_year.
 */
export async function startUnlockCheckoutAction(formData: FormData): Promise<void> {
  await requireSession();
  const orgId = await getCurrentOrgId();
  const billingProductId = String(formData.get('billingProductId') ?? '').trim();
  if (!billingProductId) throw new Error('billingProductId is required');
  const { createOneTimeCheckoutSession } = await import('@/lib/stripe/checkout');
  const url = await createOneTimeCheckoutSession(orgId, billingProductId);
  redirect(url);
}

/**
 * Start a subscription Checkout for an add-on product (e.g. qbo_mirroring).
 * The product id is the rocketsuite billing_products row; the checkout
 * helper validates it's subscription-kind, active, and Stripe-linked.
 */
export async function startAddOnSubscriptionCheckoutAction(formData: FormData): Promise<void> {
  await requireSession();
  const orgId = await getCurrentOrgId();
  const billingProductId = String(formData.get('billingProductId') ?? '').trim();
  if (!billingProductId) throw new Error('billingProductId is required');
  const { createAddOnSubscriptionCheckoutSession } = await import('@/lib/stripe/checkout');
  const url = await createAddOnSubscriptionCheckoutSession(orgId, billingProductId);
  redirect(url);
}
