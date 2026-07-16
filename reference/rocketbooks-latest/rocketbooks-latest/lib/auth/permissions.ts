import 'server-only';
import { cache } from 'react';
import { redirect } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  users,
  userPermissionSets,
  permissionSetPermissions,
  permissions,
} from '@/db/schema/schema';
import { requireSession } from './session';
import { getEffectiveUserId } from './impersonate';

export type PermissionMode = 'allow_all' | 'set';

export interface ResolvedPermissions {
  /** Union of keys the user has via their permission set(s). */
  keys: string[];
  /**
   * 'allow_all' means treat every permission check as true. Used for super
   * admins and for users who have NOT been assigned any permission set yet
   * (so existing users keep working until you explicitly opt them in by
   * assigning a set). 'set' means strict — only `keys` are allowed.
   */
  mode: PermissionMode;
  /** True only for the actual super-admin role; unassigned users may also use allow_all. */
  isSuperAdmin: boolean;
}

/**
 * Resolve the current user's effective permissions. Cached per-request so
 * repeated checks (sidebar render + per-page guard) don't re-query the DB.
 */
export const getUserPermissions = cache(async (): Promise<ResolvedPermissions> => {
  await requireSession();
  // Permissions are resolved against the EFFECTIVE user so the super admin
  // sees exactly what their target sees while impersonating.
  const userId = await getEffectiveUserId();

  const [profile] = await db
    .select({ role: users.role })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  const isSuperAdmin = profile?.role === 'super_admin' || profile?.role === 'superadmin';
  if (isSuperAdmin) {
    return { keys: [], mode: 'allow_all', isSuperAdmin: true };
  }

  const [assignedSet] = await db
    .select({ id: userPermissionSets.id })
    .from(userPermissionSets)
    .where(eq(userPermissionSets.userId, userId))
    .limit(1);

  if (!assignedSet) {
    return { keys: [], mode: 'allow_all', isSuperAdmin: false };
  }

  const rows = await db
    .select({ key: permissions.key })
    .from(userPermissionSets)
    .innerJoin(
      permissionSetPermissions,
      eq(permissionSetPermissions.permissionSetId, userPermissionSets.permissionSetId),
    )
    .innerJoin(permissions, eq(permissions.id, permissionSetPermissions.permissionId))
    .where(eq(userPermissionSets.userId, userId));

  return { keys: rows.map((r) => r.key), mode: 'set', isSuperAdmin: false };
});

export async function hasPermission(key: string): Promise<boolean> {
  const { keys, mode } = await getUserPermissions();
  if (mode === 'allow_all') return true;
  return keys.includes(key);
}

/**
 * True if the user has at least one of the given keys. Used for the
 * workspace/product switcher — a product is visible if the user has any
 * permission in its bucket.
 */
export async function hasAnyPermission(reqKeys: string[]): Promise<boolean> {
  if (reqKeys.length === 0) return true;
  const { keys, mode } = await getUserPermissions();
  if (mode === 'allow_all') return true;
  return reqKeys.some((k) => keys.includes(k));
}

/** Redirect to /dashboard if the current user lacks the given permission. */
export async function requirePermission(key: string, redirectTo: string = '/dashboard'): Promise<void> {
  if (!(await hasPermission(key))) redirect(redirectTo);
}
