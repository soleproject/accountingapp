import 'server-only';
import { cache } from 'react';
import { cookies } from 'next/headers';
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db } from '@/db/client';
import { users, organizations, enterpriseStaff } from '@/db/schema/schema';
import { requireSession } from './session';
import { DEMO_ORG_ID, isDemoOrg } from './demo';
import { getEffectiveUserId } from './impersonate';
import { observeServerPhase } from '@/lib/perf/request-observability';

const ORG_COOKIE = 'rs_org_id';
const activeOrganizations = alias(organizations, 'active_organizations');
const primaryOrganizations = alias(organizations, 'primary_organizations');

export interface CurrentOrgContext {
  id: string;
  entityType: string | null;
}

const resolveCurrentOrgContext = async (): Promise<CurrentOrgContext> => {
  await requireSession();
  const userId = await getEffectiveUserId();
  const cookieStore = await cookies();
  const fromCookie = cookieStore.get(ORG_COOKIE)?.value;

  // Resolve the active/primary org and both entity types in the same authorized
  // profile round trip. The app shell consumes this context directly, avoiding
  // a second sequential organizations query on every authenticated document.
  const [profile] = await db
    .select({
      activeOrgId: users.activeOrganizationId,
      orgId: users.organizationId,
      activeEntityType: activeOrganizations.entityType,
      primaryEntityType: primaryOrganizations.entityType,
    })
    .from(users)
    .leftJoin(activeOrganizations, eq(activeOrganizations.id, users.activeOrganizationId))
    .leftJoin(primaryOrganizations, eq(primaryOrganizations.id, users.organizationId))
    .where(eq(users.id, userId))
    .limit(1);
  const dbOrgId = profile?.activeOrgId ?? profile?.orgId ?? null;
  const dbEntityType = profile?.activeOrgId
    ? (profile.activeEntityType ?? null)
    : (profile?.primaryEntityType ?? null);

  if (fromCookie) {
    if (isDemoOrg(fromCookie)) return { id: fromCookie, entityType: null };
    if (fromCookie === dbOrgId) return { id: fromCookie, entityType: dbEntityType };
    const accessible = await listAccessibleOrgs();
    const selected = accessible.find((org) => org.id === fromCookie);
    if (selected) return { id: selected.id, entityType: selected.entityType ?? null };
    try {
      cookieStore.set(ORG_COOKIE, dbOrgId ?? '', {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        maxAge: dbOrgId ? 60 * 60 * 24 * 30 : 0,
      });
    } catch {
      // Server Component contexts do not always permit cookie writes.
    }
  }

  if (!dbOrgId) {
    const accessible = await listAccessibleOrgs();
    if (accessible.length > 0) {
      const resolved = accessible[0];
      try {
        await db
          .update(users)
          .set({ organizationId: resolved.id, activeOrganizationId: resolved.id })
          .where(eq(users.id, userId));
      } catch {
        // The authorized fallback remains valid without the best-effort backfill.
      }
      return { id: resolved.id, entityType: resolved.entityType ?? null };
    }
    return { id: DEMO_ORG_ID, entityType: null };
  }

  return { id: dbOrgId, entityType: dbEntityType };
};

export const getCurrentOrgContext = cache(() =>
  observeServerPhase('organization_resolution', resolveCurrentOrgContext),
);

export const getCurrentOrgId = cache(async () => (await getCurrentOrgContext()).id);

export interface AccessibleOrg {
  id: string;
  name: string;
  entityType?: string | null;
  role: 'owner' | 'enterprise-staff' | 'primary';
}

export const listAccessibleOrgs = cache(async (): Promise<AccessibleOrg[]> => {
  await requireSession();
  const userId = await getEffectiveUserId();

  const owned = await db
    .select({ id: organizations.id, name: organizations.name, entityType: organizations.entityType })
    .from(organizations)
    .where(eq(organizations.ownerUserId, userId));

  const staffOrgs = await db
    .select({ id: organizations.id, name: organizations.name, entityType: organizations.entityType })
    .from(enterpriseStaff)
    .innerJoin(organizations, eq(enterpriseStaff.enterpriseId, organizations.id))
    .where(and(eq(enterpriseStaff.staffUserId, userId), isNull(enterpriseStaff.archivedAt)));

  const [profile] = await db
    .select({ orgId: users.organizationId, activeOrgId: users.activeOrganizationId })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  const seen = new Set<string>();
  const result: AccessibleOrg[] = [];
  // Defense in depth: never expose the demo org as something a user can
  // "switch to". It's auto-assigned by getCurrentOrgId when the user has
  // nothing else.
  const push = (o: { id: string; name: string; entityType: string | null }, role: AccessibleOrg['role']) => {
    if (isDemoOrg(o.id) || seen.has(o.id)) return;
    seen.add(o.id);
    result.push({ ...o, role });
  };
  for (const o of owned) push(o, 'owner');
  for (const o of staffOrgs) push(o, 'enterprise-staff');
  if (profile?.orgId && !seen.has(profile.orgId) && !isDemoOrg(profile.orgId)) {
    const [primary] = await db
      .select({ id: organizations.id, name: organizations.name, entityType: organizations.entityType })
      .from(organizations)
      .where(eq(organizations.id, profile.orgId))
      .limit(1);
    if (primary) push(primary, 'primary');
  }
  return result;
});

export class OrgAccessDeniedError extends Error {
  readonly code = 'org_access_denied';
  constructor() {
    super('You do not have access to that organization');
  }
}

export async function setActiveOrg(orgId: string) {
  await requireSession();
  // Persist the active org on the EFFECTIVE user's row so a super admin
  // switching orgs while impersonating updates the target user's default,
  // not their own. listAccessibleOrgs is also keyed off the effective user,
  // so the access check below matches what we'll persist.
  const userId = await getEffectiveUserId();
  // The demo workspace is intentionally not in listAccessibleOrgs, but any
  // signed-in user is allowed to switch INTO it (so they can show it off).
  // The demo banner + write guards keep it harmless.
  if (!isDemoOrg(orgId)) {
    const accessible = await listAccessibleOrgs();
    if (!accessible.some((o) => o.id === orgId)) {
      throw new OrgAccessDeniedError();
    }
  }
  const cookieStore = await cookies();
  cookieStore.set(ORG_COOKIE, orgId, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 30,
  });
  // Don't persist the demo as the user's active org — the cookie alone is
  // enough for the current session, and we don't want them stuck in demo
  // after they sign out and back in.
  if (!isDemoOrg(orgId)) {
    await db.update(users).set({ activeOrganizationId: orgId }).where(eq(users.id, userId));
  }
}

export async function isSuperAdmin(): Promise<boolean> {
  // While impersonating a non-super user, this returns false on purpose —
  // we want the super admin to truly experience the impersonated user's
  // access. The /super-admin route layout uses this to gate entry. The
  // "Stop impersonating" action separately requires only requireSession()
  // so it still works while impersonation is active.
  await requireSession();
  const userId = await getEffectiveUserId();
  const [profile] = await db.select({ role: users.role }).from(users).where(eq(users.id, userId)).limit(1);
  return profile?.role === 'super_admin' || profile?.role === 'superadmin';
}

// Suppress unused import warning
void or;
void sql;
