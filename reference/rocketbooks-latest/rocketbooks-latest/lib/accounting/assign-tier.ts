import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  organizations,
  users,
  permissionSets,
  userPermissionSets,
} from '@/db/schema/schema';
import {
  type AccountingTierKey,
  isAccountingTierKey,
  ACCOUNTING_TIERS,
} from './tiers';

/**
 * Assign-set-on-tier-change — the single integration point for putting a client
 * org (and its owner) onto a self-serve accounting tier. Everything that sets a
 * tier (self-serve signup, the accounting-pro bulk import + per-client edit in
 * Phase 4, super-admin) funnels through here so the THREE side effects always
 * happen together and never drift:
 *
 *   1. stamp organizations.accounting_tier
 *   2. assign the matching permission set to the org owner (replace semantics,
 *      mirroring setUserPermissionSetAction)
 *   3. (Phase 5) swap the Stripe subscription to the tier's price — NOT done
 *      here yet; callers handle billing separately until Phase 5 lands.
 *
 * Passing `tier = null` reverts the org to the grandfathered flat $89 state:
 * accounting_tier → NULL and the owner's permission set is CLEARED, which drops
 * them back to allow_all (legacy full access) per getUserPermissions().
 */

/** Resolve the permission-set id for a tier by its canonical name. Null when
 *  the sets haven't been seeded yet (run seed-accounting-tier-permission-sets). */
export async function resolveTierPermissionSetId(
  tier: AccountingTierKey,
): Promise<string | null> {
  const [row] = await db
    .select({ id: permissionSets.id })
    .from(permissionSets)
    .where(eq(permissionSets.name, ACCOUNTING_TIERS[tier].permissionSetName))
    .limit(1);
  return row?.id ?? null;
}

/** Replace (or clear, when tier is null) a user's permission-set assignment to
 *  match an accounting tier. Used directly when a client has no org yet. */
export async function assignTierPermissionSet(
  userId: string,
  tier: AccountingTierKey | null,
): Promise<{ permissionSetId: string | null }> {
  // Replace semantics: one set per user (see getUserPermissions / admin.ts).
  await db.delete(userPermissionSets).where(eq(userPermissionSets.userId, userId));
  if (!tier) return { permissionSetId: null };

  const permissionSetId = await resolveTierPermissionSetId(tier);
  if (!permissionSetId) {
    throw new Error(
      `No permission set found for tier "${tier}" (${ACCOUNTING_TIERS[tier].permissionSetName}). ` +
        'Run: npx tsx scripts/seed-accounting-tier-permission-sets.ts',
    );
  }
  await db.insert(userPermissionSets).values({
    id: randomUUID(),
    userId,
    permissionSetId,
  });
  return { permissionSetId };
}

export interface SetOrgAccountingTierResult {
  orgId: string;
  ownerUserId: string;
  tier: AccountingTierKey | null;
  permissionSetId: string | null;
}

/**
 * Put a client org onto a tier: stamp the column and assign the owner's
 * permission set. `tier = null` → revert to the grandfathered flat $89 plan.
 */
export async function setOrgAccountingTier(
  orgId: string,
  tier: AccountingTierKey | null,
): Promise<SetOrgAccountingTierResult> {
  if (tier !== null && !isAccountingTierKey(tier)) {
    throw new Error(`Invalid accounting tier: ${String(tier)}`);
  }

  const [org] = await db
    .select({ id: organizations.id, ownerUserId: organizations.ownerUserId })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  if (!org) throw new Error(`Organization not found: ${orgId}`);

  await db
    .update(organizations)
    .set({ accountingTier: tier })
    .where(eq(organizations.id, orgId));

  const { permissionSetId } = await assignTierPermissionSet(org.ownerUserId, tier);

  // Best-effort: align the client's live Stripe subscription with the new tier
  // price. Self-contained + never throws (no-ops when they have no sub yet or
  // the tier isn't linked to Stripe). Dynamic import keeps the Stripe client
  // out of the module graph for callers that only need the permission side.
  try {
    const { syncClientSubscriptionToTier } = await import('@/lib/stripe/client-subscription');
    await syncClientSubscriptionToTier(orgId);
  } catch {
    /* never block tier assignment on billing */
  }

  return { orgId, ownerUserId: org.ownerUserId, tier, permissionSetId };
}

/**
 * Convenience for user-centric callers (e.g. super-admin user edit): resolve
 * the user's owned client org (planType='pro') and set its tier. When the user
 * owns no client org yet, falls back to assigning the permission set directly
 * so feature gating is correct before an org exists; the tier is then stamped
 * on the org at creation time.
 */
export async function setUserAccountingTier(
  userId: string,
  tier: AccountingTierKey | null,
): Promise<SetOrgAccountingTierResult | { ownerUserId: string; tier: AccountingTierKey | null; permissionSetId: string | null; orgId: null }> {
  const [ownedOrg] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(and(eq(organizations.ownerUserId, userId), eq(organizations.planType, 'pro')))
    .limit(1);

  if (ownedOrg) return setOrgAccountingTier(ownedOrg.id, tier);

  const { permissionSetId } = await assignTierPermissionSet(userId, tier);
  return { ownerUserId: userId, tier, permissionSetId, orgId: null };
}
