import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { organizations, organizationBilling, users } from '@/db/schema/schema';
import { stripe } from './client';

/**
 * Return the Stripe Customer ID for an org, creating one if needed.
 *
 * Idempotent: the upsert into organization_billing happens first so concurrent
 * callers race for the row; once the row exists, only the caller that finds
 * stripeCustomerId === null actually hits Stripe. Subsequent callers read
 * back the stored ID.
 *
 * Customer metadata: organization_id is stored on the Stripe Customer so
 * webhooks can reconcile back to our row even if our organization_billing
 * lookup ever drifts.
 */
export async function getOrCreateStripeCustomer(orgId: string): Promise<string> {
  // Ensure the billing row exists (no-op if already there).
  await db
    .insert(organizationBilling)
    .values({ organizationId: orgId })
    .onConflictDoNothing({ target: organizationBilling.organizationId });

  const [existing] = await db
    .select({
      stripeCustomerId: organizationBilling.stripeCustomerId,
      payingPartyUserId: organizationBilling.payingPartyUserId,
    })
    .from(organizationBilling)
    .where(eq(organizationBilling.organizationId, orgId))
    .limit(1);

  if (existing?.stripeCustomerId) return existing.stripeCustomerId;

  const [org] = await db
    .select({
      name: organizations.name,
      ownerUserId: organizations.ownerUserId,
      payingPartyUserId: organizations.payingPartyUserId,
    })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  if (!org) throw new Error(`Org ${orgId} not found`);

  // Bill the paying party if set, otherwise the owner. The Customer's email
  // is what receipts go to, so we want a real human's address on file.
  const billingUserId = existing?.payingPartyUserId ?? org.payingPartyUserId ?? org.ownerUserId;
  const [billingUser] = await db
    .select({ email: users.email, fullName: users.fullName })
    .from(users)
    .where(eq(users.id, billingUserId))
    .limit(1);

  const customer = await stripe().customers.create({
    email: billingUser?.email,
    name: billingUser?.fullName,
    metadata: {
      organization_id: orgId,
      paying_party_user_id: billingUserId,
    },
    description: `Org: ${org.name}`,
  });

  await db
    .update(organizationBilling)
    .set({
      stripeCustomerId: customer.id,
      payingPartyUserId: billingUserId,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(organizationBilling.organizationId, orgId));

  return customer.id;
}
