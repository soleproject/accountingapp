import 'server-only';
import { and, eq, gt, isNull, or } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  organizationSubscriptions,
  billingProducts,
  users,
  enterpriseStaff,
  enterpriseClients,
  organizations,
} from '@/db/schema/schema';

/**
 * True when this org has an unexpired demo_full subscription -- i.e. the
 * self-serve 7-day Enterprise demo is still in its trial window. After the
 * window passes the row is left in place but current_period_end is in the
 * past, so this returns false and the org naturally drops to read-only via
 * the standard entitlement gates.
 *
 * Distinct from the hardcoded `isDemoOrg` view-only demo in @/lib/auth/demo
 * -- that's a sandbox; this is a trial-with-real-data.
 */
export type DemoTrialStatus = 'no_client' | 'active' | 'expired';

export interface DemoTrialState {
  status: DemoTrialStatus;
  /** Whole days remaining, rounded up. Null when no trial sub exists yet. */
  daysLeft: number | null;
  endsAt: Date | null;
  /** Demo client's org id once they've created it. Null pre-client. */
  clientOrgId: string | null;
}

/**
 * Trial state for a demo-owner user, used by the in-app banner. Returns
 * null when the user isn't an enterprise_owner_demo at all -- callers
 * short-circuit and render nothing for everyone else.
 *
 * Three states:
 *   no_client -- demo owner who hasn't created their one client yet
 *   active    -- client exists, trial sub's current_period_end is in the future
 *   expired   -- client exists, current_period_end is past (or sub missing)
 */
export async function getDemoTrialState(userId: string): Promise<DemoTrialState | null> {
  // Cheapest guard first: skip everyone who isn't a demo owner.
  const [profile] = await db
    .select({ role: users.role })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (profile?.role !== 'enterprise_owner_demo') return null;

  // Find their demo enterprise via the owner row in enterprise_staff.
  const [staff] = await db
    .select({ enterpriseId: enterpriseStaff.enterpriseId })
    .from(enterpriseStaff)
    .where(and(
      eq(enterpriseStaff.staffUserId, userId),
      eq(enterpriseStaff.role, 'owner'),
    ))
    .limit(1);
  if (!staff) return { status: 'no_client', daysLeft: null, endsAt: null, clientOrgId: null };

  // Single query: find the demo_full subscription belonging to any org
  // owned by this enterprise's client. Returns at most one row by design
  // (the demo cap enforces one client, one trial).
  const [row] = await db
    .select({
      orgId: organizationSubscriptions.organizationId,
      endsAt: organizationSubscriptions.currentPeriodEnd,
    })
    .from(organizationSubscriptions)
    .innerJoin(billingProducts, eq(organizationSubscriptions.billingProductId, billingProducts.id))
    .innerJoin(organizations, eq(organizations.id, organizationSubscriptions.organizationId))
    .innerJoin(enterpriseClients, eq(enterpriseClients.clientUserId, organizations.ownerUserId))
    .where(and(
      eq(enterpriseClients.enterpriseId, staff.enterpriseId),
      eq(billingProducts.featureKey, 'demo_full'),
    ))
    .limit(1);

  if (!row) {
    return { status: 'no_client', daysLeft: null, endsAt: null, clientOrgId: null };
  }

  const endsAt = row.endsAt ? new Date(row.endsAt) : null;
  if (!endsAt) {
    // Sub exists but no period end set -- treat defensively as active.
    return { status: 'active', daysLeft: null, endsAt: null, clientOrgId: row.orgId };
  }

  const now = Date.now();
  if (endsAt.getTime() <= now) {
    return { status: 'expired', daysLeft: 0, endsAt, clientOrgId: row.orgId };
  }
  const msPerDay = 24 * 60 * 60 * 1000;
  const daysLeft = Math.ceil((endsAt.getTime() - now) / msPerDay);
  return { status: 'active', daysLeft, endsAt, clientOrgId: row.orgId };
}

/**
 * Trial state by org id, for the self-serve trial signup where the user IS
 * the paying_user (not the demo enterprise owner). Looks for any demo_full
 * subscription on the org and returns active/expired with daysLeft. The
 * 'no_client' state from getDemoTrialState doesn't apply here — the org IS
 * the client.
 *
 * Returns null when the org has no demo_full subscription, so callers
 * render nothing for non-trial orgs.
 */
export async function getOrgTrialState(orgId: string): Promise<DemoTrialState | null> {
  // Any 'trialing' subscription = an active trial: the self-serve 7-day Stripe
  // trial (trial_period_days) OR the legacy demo_full row. We read its period end
  // for the countdown; once the trial converts, the sub flips to 'active' (no
  // 'trialing' row remains) so this returns null and the banner disappears.
  const [row] = await db
    .select({
      endsAt: organizationSubscriptions.currentPeriodEnd,
    })
    .from(organizationSubscriptions)
    .where(and(
      eq(organizationSubscriptions.organizationId, orgId),
      eq(organizationSubscriptions.status, 'trialing'),
    ))
    .limit(1);
  if (!row) return null;

  const endsAt = row.endsAt ? new Date(row.endsAt) : null;
  if (!endsAt) {
    return { status: 'active', daysLeft: null, endsAt: null, clientOrgId: orgId };
  }

  const now = Date.now();
  if (endsAt.getTime() <= now) {
    return { status: 'expired', daysLeft: 0, endsAt, clientOrgId: orgId };
  }
  const msPerDay = 24 * 60 * 60 * 1000;
  const daysLeft = Math.ceil((endsAt.getTime() - now) / msPerDay);
  return { status: 'active', daysLeft, endsAt, clientOrgId: orgId };
}

export async function hasActiveDemoTrial(orgId: string): Promise<boolean> {
  const now = new Date().toISOString();
  const [row] = await db
    .select({ id: organizationSubscriptions.id })
    .from(organizationSubscriptions)
    .innerJoin(billingProducts, eq(organizationSubscriptions.billingProductId, billingProducts.id))
    .where(and(
      eq(organizationSubscriptions.organizationId, orgId),
      eq(billingProducts.featureKey, 'demo_full'),
      eq(billingProducts.active, true),
      // Null period_end would mean "no expiry set" -- not a state we emit,
      // but treat defensively as still-active rather than instantly-expired.
      or(
        isNull(organizationSubscriptions.currentPeriodEnd),
        gt(organizationSubscriptions.currentPeriodEnd, now),
      ),
    ))
    .limit(1);
  return Boolean(row);
}
