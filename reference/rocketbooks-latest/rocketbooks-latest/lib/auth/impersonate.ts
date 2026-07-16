import 'server-only';
import { cache } from 'react';
import { cookies } from 'next/headers';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { users, organizations, enterpriseStaff, enterpriseClients } from '@/db/schema/schema';
import { getSession, requireSession } from './session';

/**
 * Super-admin "act as another user" plumbing.
 *
 * Design: the super admin's real Supabase session stays untouched. Instead,
 * an httpOnly `rs_impersonate` cookie carries the target user's id. The
 * effective user (returned by getEffectiveUser) is the impersonated user
 * when this cookie is present AND the real session is a super admin —
 * any other combination falls back to the real session user.
 *
 * Stopping impersonation just clears the cookie; the super admin lands
 * back in their own context with no auth fragility.
 */

export const IMPERSONATE_COOKIE = 'rs_impersonate';
// Marker set when the impersonation was started via the enterprise "Open books"
// flow, so the in-app banner/pill frame it as "working in <company>'s books"
// (blue, "Close … Books") rather than the generic red "Impersonating <user>".
export const OPEN_BOOKS_COOKIE = 'rs_open_books';

/**
 * Decide whether `realUserId` may act as `targetUserId`. Two paths are
 * allowed: (a) real user is a super admin and target isn't another super
 * admin, or (b) real user owns or staffs an enterprise that has target
 * recorded as a client. Used by both startImpersonationAction and the
 * cookie validator below.
 */
export async function canImpersonate(realUserId: string, targetUserId: string): Promise<boolean> {
  if (!realUserId || !targetUserId) return false;
  if (realUserId === targetUserId) return false;

  const profiles = await db
    .select({ id: users.id, role: users.role })
    .from(users)
    .where(inArray(users.id, [realUserId, targetUserId]));
  const realRole = profiles.find((p) => p.id === realUserId)?.role ?? null;
  const targetRole = profiles.find((p) => p.id === targetUserId)?.role ?? null;
  if (!realRole || !targetRole) return false;

  // Never let anyone impersonate a super admin — keeps the audit trail honest.
  if (targetRole === 'super_admin' || targetRole === 'superadmin') return false;

  if (realRole === 'super_admin' || realRole === 'superadmin') return true;

  const [owned, staffed] = await Promise.all([
    db.select({ id: organizations.id }).from(organizations).where(eq(organizations.ownerUserId, realUserId)),
    db.select({ id: enterpriseStaff.enterpriseId }).from(enterpriseStaff).where(and(eq(enterpriseStaff.staffUserId, realUserId), isNull(enterpriseStaff.archivedAt))),
  ]);
  const enterpriseIds = Array.from(new Set([...owned.map((o) => o.id), ...staffed.map((s) => s.id)]));
  if (enterpriseIds.length === 0) return false;

  const [link] = await db
    .select({ id: enterpriseClients.id })
    .from(enterpriseClients)
    .where(
      and(
        eq(enterpriseClients.clientUserId, targetUserId),
        inArray(enterpriseClients.enterpriseId, enterpriseIds),
      ),
    )
    .limit(1);
  return !!link;
}

/**
 * Returns the id from the impersonate cookie, but ONLY if the real signed-in
 * user is still authorized (super admin, or enterprise owner/staff acting on
 * one of their clients). Anyone else with a stale cookie gets null and the
 * cookie is best-effort cleared.
 */
export const getImpersonatedUserId = cache(async (): Promise<string | null> => {
  const cookieStore = await cookies();
  const targetId = cookieStore.get(IMPERSONATE_COOKIE)?.value;
  if (!targetId) return null;

  const realUser = await getSession();
  if (!realUser) return null;

  if (!(await canImpersonate(realUser.id, targetId))) {
    try {
      cookieStore.set(IMPERSONATE_COOKIE, '', { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 0 });
    } catch {
      // ignore — Server Components can't always set cookies
    }
    return null;
  }
  return targetId;
});

/**
 * Convenience wrapper returning the user row for the currently impersonated
 * user, or null. Used by the layout banner.
 */
/**
 * The id of whichever user the rest of the app should "act as" for this
 * request. While a super admin is impersonating, that's the target user;
 * otherwise it's the real signed-in user. Almost every data lookup (org,
 * permissions, branding, etc.) should use this — only the
 * stop-impersonation action and the audit log should use the real session.
 */
export async function getEffectiveUserId(): Promise<string> {
  const impersonated = await getImpersonatedUserId();
  if (impersonated) return impersonated;
  const real = await requireSession();
  return real.id;
}

export const getImpersonatedUser = cache(async () => {
  const id = await getImpersonatedUserId();
  if (!id) return null;
  const [row] = await db
    .select({
      id: users.id,
      email: users.email,
      fullName: users.fullName,
      role: users.role,
    })
    .from(users)
    .where(eq(users.id, id))
    .limit(1);
  return row ?? null;
});
