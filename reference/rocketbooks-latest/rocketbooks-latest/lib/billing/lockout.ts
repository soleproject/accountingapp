import 'server-only';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { organizationBilling } from '@/db/schema/schema';
import { isDemoOrg } from '@/lib/auth/demo';
import { requireOrgFullAccess } from '@/lib/billing/access';

/**
 * Throw if the org is locked out of writes. Called by transaction-write
 * server actions before they touch financial data.
 *
 * Lockout policy (decided up-front in the planning round):
 *  - status='locked'   → block writes (Stripe retries exhausted)
 *  - all other states  → allow (including 'past_due' — we want users to
 *                        fix payment, not lose access immediately)
 *  - no row in org_billing → allow (org hasn't opted into billing yet, or
 *                            isn't subject to the new platform-subscription
 *                            requirement; current free orgs stay free)
 *  - demo org → always allow (it's a read-only sandbox; if anyone manages
 *               to trigger a write there, blocking on billing isn't the
 *               concern)
 *
 * Throws BillingLockedError on lock so callers can catch and present a
 * specific UX instead of a generic 500.
 */
export class BillingLockedError extends Error {
  readonly code = 'BILLING_LOCKED';
  constructor() {
    super('This organization\'s subscription is past due and writes are locked. Update payment in Billing to continue.');
  }
}

export async function requireOrgWritable(orgId: string): Promise<void> {
  if (isDemoOrg(orgId)) return;
  const [row] = await db
    .select({ status: organizationBilling.status })
    .from(organizationBilling)
    .where(eq(organizationBilling.organizationId, orgId))
    .limit(1);
  if (row?.status === 'locked') throw new BillingLockedError();
  // Per-company payment enforcement (read-only when a company isn't covered by an
  // active/trialing sub / grandfather / firm-pays). INERT until
  // BILLING_ENFORCEMENT_START is moved to a real date — grandfathered orgs (all of
  // them, today) pass straight through.
  await requireOrgFullAccess(orgId);
}
