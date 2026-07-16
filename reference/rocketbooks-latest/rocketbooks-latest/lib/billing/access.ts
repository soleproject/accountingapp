import 'server-only';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@/db/client';
import { organizations, organizationBilling, organizationSubscriptions, users } from '@/db/schema/schema';
import { isDemoOrg } from '@/lib/auth/demo';
import { hasActiveDemoTrial } from '@/lib/billing/demo-trial';
import { getClientBillingPlan } from '@/lib/enterprise/client-billing';

/**
 * Per-company payment enforcement — the single source of truth for whether a
 * company can be edited ('full') or is limited to viewing until its bill is
 * settled ('readonly').
 *
 * ── GRANDFATHER / ACTIVATION SWITCH ──────────────────────────────────────────
 * Companies created BEFORE this instant are grandfathered: they keep full access
 * for free regardless of subscription (their pay schedule is flipped separately,
 * later). Companies created ON/AFTER it are subject to enforcement.
 *
 * It is set FAR IN THE FUTURE on purpose: while the payment flows are still being
 * built (self-serve card + 7-day trial, per-company checkout, firm 5th-of-month
 * billing), EVERY existing company is "before the cutoff" → grandfathered → the
 * gate is INERT and nothing is blocked. To turn enforcement on, move this to the
 * real activation date. Nothing before it is ever affected.
 */
export const BILLING_ENFORCEMENT_START = new Date('2099-01-01T00:00:00Z');

export type OrgAccessLevel = 'full' | 'readonly';

/**
 * A company has 'full' access when ANY of these hold, else 'readonly':
 *  - it's the demo sandbox;
 *  - it was created before the enforcement cutoff (grandfathered);
 *  - it has an active/trialing subscription — client- OR firm-paid (a self-serve
 *    7-day trial is a 'trialing' sub);
 *  - it's on an active demo trial;
 *  - it's a firm-pays client (the firm covers it — billed on the 5th — so it's
 *    covered without its own sub; creating a firm-pays client is already gated on
 *    the firm having a card on file).
 *
 * Fails OPEN: any uncertainty (no org row, null created_at, lookup error) returns
 * 'full' so a billing-check hiccup never wrongly locks a real company out.
 */
export async function orgAccessLevel(orgId: string): Promise<OrgAccessLevel> {
  try {
    if (isDemoOrg(orgId)) return 'full';

    const [org] = await db
      .select({ createdAt: organizations.createdAt, ownerUserId: organizations.ownerUserId, planType: organizations.planType })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);
    if (!org) return 'full';

    // Enforcement applies to CLIENT WORKSPACES only. Firm (enterprise) orgs, demo,
    // archived, etc. are never gated.
    if (org.planType !== 'pro') return 'full';

    // Grandfathered (or unknown creation time → treat as grandfathered).
    if (!org.createdAt || new Date(org.createdAt) < BILLING_ENFORCEMENT_START) return 'full';

    // Only PAYING USERS are gated. An org owned by an enterprise owner/staff, super
    // admin, etc. (e.g. a personal/test workspace) is never held to the per-company
    // bill — this keeps enforcement strictly to paying-user client workspaces.
    const [owner] = await db
      .select({ role: users.role })
      .from(users)
      .where(eq(users.id, org.ownerUserId))
      .limit(1);
    if (owner?.role !== 'paying_user') return 'full';

    // Active/trialing subscription — check the aggregate billing row first, then
    // any live subscription row (covers the window before the billing row syncs).
    const [billing] = await db
      .select({ status: organizationBilling.status })
      .from(organizationBilling)
      .where(eq(organizationBilling.organizationId, orgId))
      .limit(1);
    if (billing?.status === 'active' || billing?.status === 'trialing') return 'full';

    const [sub] = await db
      .select({ id: organizationSubscriptions.id })
      .from(organizationSubscriptions)
      .where(
        and(
          eq(organizationSubscriptions.organizationId, orgId),
          inArray(organizationSubscriptions.status, ['active', 'trialing']),
        ),
      )
      .limit(1);
    if (sub) return 'full';

    // Active demo trial.
    if (await hasActiveDemoTrial(orgId)) return 'full';

    // Firm-pays client: the firm covers this company (billed on the 5th), so it's
    // covered without its own subscription. (firm-pays creation is gated on a card.)
    const plan = await getClientBillingPlan(orgId);
    if (plan.firmPaid) return 'full';

    return 'readonly';
  } catch (err) {
    console.error('orgAccessLevel check failed; failing open to full', orgId, err);
    return 'full';
  }
}

/** Thrown by requireOrgFullAccess when a company is read-only (no active billing). */
export class BillingRequiredError extends Error {
  readonly code = 'BILLING_REQUIRED';
  constructor() {
    super('This company needs an active subscription to make changes. Set up billing to continue.');
  }
}

/** Guard for write actions: throw BillingRequiredError when the company is read-only. */
export async function requireOrgFullAccess(orgId: string): Promise<void> {
  if ((await orgAccessLevel(orgId)) === 'readonly') throw new BillingRequiredError();
}
