import 'server-only';
import { cache } from 'react';
import { cookies } from 'next/headers';
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { enterpriseStaff, organizations, users } from '@/db/schema/schema';
import { requireSession } from './session';
import { getEffectiveUserId } from './impersonate';
import { DEMO_ENTERPRISE_ID, DEMO_ENTERPRISE_NAME } from '@/lib/enterprise/demo';

export const ACTIVE_ENTERPRISE_COOKIE = 'rs_active_enterprise_id';

export interface AccessibleEnterprise {
  id: string;
  name: string;
  role: 'owner' | 'staff' | 'super_admin';
}

/**
 * Virtual showcase enterprise (no DB rows). Offered to anyone already in the
 * enterprise area so they can preview every dashboard capability with rich
 * sample data. Resolvable only via the cookie — never added to the DB-backed
 * access list, so it can't grant access to users who have no real enterprise.
 */
export const DEMO_ENTERPRISE: AccessibleEnterprise = {
  id: DEMO_ENTERPRISE_ID,
  name: DEMO_ENTERPRISE_NAME,
  role: 'owner',
};

export const listAccessibleEnterprises = cache(async (): Promise<AccessibleEnterprise[]> => {
  await requireSession();
  const userId = await getEffectiveUserId();

  const [profile] = await db
    .select({ role: users.role })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const isSuper = profile?.role === 'super_admin' || profile?.role === 'superadmin';

  if (isSuper) {
    const all = await db
      .select({ id: organizations.id, name: organizations.name })
      .from(organizations)
      .where(
        or(
          eq(organizations.planType, 'enterprise'),
          sql`${organizations.id} in (select enterprise_id from enterprise_staff)`,
          sql`${organizations.id} in (select enterprise_id from enterprise_clients)`,
        )!,
      );
    return all.map((o) => ({ id: o.id, name: o.name, role: 'super_admin' as const }));
  }

  const owned = await db
    .select({ id: organizations.id, name: organizations.name })
    .from(organizations)
    .where(eq(organizations.ownerUserId, userId));

  const staffed = await db
    .select({ id: organizations.id, name: organizations.name })
    .from(enterpriseStaff)
    .innerJoin(organizations, eq(organizations.id, enterpriseStaff.enterpriseId))
    .where(and(eq(enterpriseStaff.staffUserId, userId), isNull(enterpriseStaff.archivedAt)));

  const seen = new Set<string>();
  const out: AccessibleEnterprise[] = [];
  for (const o of owned) if (!seen.has(o.id)) { seen.add(o.id); out.push({ ...o, role: 'owner' }); }
  for (const o of staffed) if (!seen.has(o.id)) { seen.add(o.id); out.push({ ...o, role: 'staff' }); }
  return out;
});

/**
 * Pick the enterprise the user is "currently in" for the enterprise area.
 * Honors the rs_active_enterprise_id cookie when it points to an enterprise
 * the user still has access to; otherwise falls back to the first
 * accessible one. Returns null when the user has access to zero
 * enterprises — callers should treat that as a hard "no access" signal.
 */
export async function getCurrentEnterprise(): Promise<AccessibleEnterprise | null> {
  const list = await listAccessibleEnterprises();
  if (list.length === 0) return null;
  const cookieStore = await cookies();
  const selected = cookieStore.get(ACTIVE_ENTERPRISE_COOKIE)?.value;
  // The demo enterprise isn't in the DB list, but a user already in the
  // enterprise area (list.length > 0) may select it via the switcher.
  if (selected === DEMO_ENTERPRISE_ID) return DEMO_ENTERPRISE;
  if (selected) {
    const match = list.find((e) => e.id === selected);
    if (match) return match;
  }
  return list[0];
}

export async function getCurrentEnterpriseId(): Promise<string | null> {
  return (await getCurrentEnterprise())?.id ?? null;
}

/**
 * Enterprises the signed-in user is an actual member of — owner of the
 * enterprise org or in enterprise_staff. No super-admin shortcut: a super
 * admin who isn't owner/staff of an enterprise gets an empty list here.
 *
 * This is the right list for the sidebar switcher (the user wants to see
 * "their" enterprises, not everything they could view via super-admin
 * powers). For cross-enterprise access checks, use listAccessibleEnterprises.
 */
export const listMemberEnterprises = cache(async (): Promise<AccessibleEnterprise[]> => {
  await requireSession();
  const userId = await getEffectiveUserId();

  const owned = await db
    .select({ id: organizations.id, name: organizations.name })
    .from(organizations)
    .where(and(eq(organizations.ownerUserId, userId), eq(organizations.planType, 'enterprise')));

  const staffed = await db
    .select({ id: organizations.id, name: organizations.name })
    .from(enterpriseStaff)
    .innerJoin(organizations, eq(organizations.id, enterpriseStaff.enterpriseId))
    .where(and(eq(enterpriseStaff.staffUserId, userId), isNull(enterpriseStaff.archivedAt)));

  const seen = new Set<string>();
  const out: AccessibleEnterprise[] = [];
  for (const o of owned) if (!seen.has(o.id)) { seen.add(o.id); out.push({ ...o, role: 'owner' }); }
  for (const o of staffed) if (!seen.has(o.id)) { seen.add(o.id); out.push({ ...o, role: 'staff' }); }
  // Always offer the virtual demo enterprise at the bottom of the switcher.
  out.push(DEMO_ENTERPRISE);
  return out;
});
