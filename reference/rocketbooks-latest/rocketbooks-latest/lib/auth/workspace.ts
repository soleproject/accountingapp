import 'server-only';
import { cache } from 'react';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { enterpriseStaff } from '@/db/schema/schema';
import { requireSession } from './session';
import { getEffectiveUserId } from './impersonate';
import { getUserPermissions } from './permissions';
import { permissionsForProduct } from '@/lib/permissions/structure';
import type { Workspace, WorkspaceKey } from './workspace-types';
import { observeServerPhase } from '@/lib/perf/request-observability';

export type { Workspace, WorkspaceKey };

export const WORKSPACE_MAIN: Workspace = { key: 'main', label: 'Accounting', href: '/dashboard' };
export const WORKSPACE_ORGANIZER: Workspace = { key: 'organizer', label: 'Organizer', href: '/organizer/dashboard' };
export const WORKSPACE_TAXES: Workspace = { key: 'taxes', label: 'Taxes', href: '/taxes' };
export const WORKSPACE_PERSONAL: Workspace = { key: 'personal', label: 'Personal', href: '/personal' };
export const WORKSPACE_SUPER_ADMIN: Workspace = { key: 'super-admin', label: 'Super Admin', href: '/super-admin/dashboard' };
export const WORKSPACE_ENTERPRISE: Workspace = { key: 'enterprise', label: 'Enterprise', href: '/enterprise/dashboard' };

const resolveAccessibleWorkspaces = async (): Promise<Workspace[]> => {
  await requireSession();
  const userId = await getEffectiveUserId();

  const [{ keys, mode, isSuperAdmin: isSuper }, staffRows] = await Promise.all([
    getUserPermissions(),
    db
      .select({ id: enterpriseStaff.id })
      .from(enterpriseStaff)
      .where(and(eq(enterpriseStaff.staffUserId, userId), isNull(enterpriseStaff.archivedAt)))
      .limit(1),
  ]);
  const [staffRow] = staffRows;
  const isEnterpriseStaff = !!staffRow;

  const hasAnyResolvedPermission = (requiredKeys: string[]) =>
    requiredKeys.length === 0 || mode === 'allow_all' || requiredKeys.some((key) => keys.includes(key));

  // Each workspace is visible only when BOTH gates pass: (1) the role/membership
  // gate that protects the underlying routes, and (2) the permission-bucket
  // gate from PRODUCT_PERMISSIONS — so admins can hide a workspace from a user
  // via permission set even if their role would otherwise grant access.
  // SuperAdmins are in allow_all mode, so the key check is a no-op for them.
  const out: Workspace[] = [];

  // Organizer leads the workspace switcher.
  if (hasAnyResolvedPermission(permissionsForProduct('organizer'))) {
    out.push(WORKSPACE_ORGANIZER);
  }
  if (hasAnyResolvedPermission(permissionsForProduct('main'))) {
    out.push(WORKSPACE_MAIN);
  }
  if (hasAnyResolvedPermission(permissionsForProduct('taxes'))) {
    out.push(WORKSPACE_TAXES);
  }
  if (hasAnyResolvedPermission(permissionsForProduct('personal'))) {
    out.push(WORKSPACE_PERSONAL);
  }
  if (isSuper && hasAnyResolvedPermission(permissionsForProduct('super-admin'))) {
    out.push(WORKSPACE_SUPER_ADMIN);
  }
  if ((isSuper || isEnterpriseStaff) && hasAnyResolvedPermission(permissionsForProduct('enterprise'))) {
    out.push(WORKSPACE_ENTERPRISE);
  }

  // Always include at least 'main' so a misconfigured user isn't stranded.
  if (out.length === 0) out.push(WORKSPACE_MAIN);
  return out;
};

export const listAccessibleWorkspaces = cache(() =>
  observeServerPhase('workspace_resolution', resolveAccessibleWorkspaces),
);

export function workspaceFromPathname(pathname: string): WorkspaceKey {
  if (pathname.startsWith('/super-admin')) return 'super-admin';
  if (pathname.startsWith('/enterprise')) return 'enterprise';
  if (pathname.startsWith('/organizer')) return 'organizer';
  if (pathname === '/taxes' || pathname.startsWith('/taxes/')) return 'taxes';
  if (pathname === '/personal' || pathname.startsWith('/personal/')) return 'personal';
  return 'main';
}
