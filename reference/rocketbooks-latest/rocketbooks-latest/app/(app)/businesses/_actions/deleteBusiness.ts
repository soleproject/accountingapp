'use server';

import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { users } from '@/db/schema/schema';
import { requireSession } from '@/lib/auth/session';
import { listAccessibleOrgs, getCurrentOrgId } from '@/lib/auth/org';
import { deleteOrganizationCascade } from '@/lib/accounting/delete-organization';
import { logger } from '@/lib/logger';

export interface DeleteBusinessState {
  ok?: boolean;
  error?: string;
  totalRowsDeleted?: number;
  redirectTo?: string;
}

const ORG_COOKIE = 'rs_org_id';

export async function deleteBusinessAction(args: {
  orgId: string;
  confirmName: string;
}): Promise<DeleteBusinessState> {
  const user = await requireSession();

  try {
    const accessible = await listAccessibleOrgs();
    const target = accessible.find((o) => o.id === args.orgId);
    if (!target) return { ok: false, error: 'Business not found or you do not have access' };
    if (target.role !== 'owner') {
      return { ok: false, error: 'Only the owner can delete a business' };
    }

    if (args.confirmName.trim() !== target.name) {
      return { ok: false, error: 'Confirmation text does not match the business name' };
    }

    const wasOnlyOrg = accessible.length <= 1;
    const currentOrgId = await getCurrentOrgId();
    const wasCurrentOrg = currentOrgId === args.orgId;

    // If deleting the currently-active business AND there are other businesses,
    // ask the user to switch first. (We don't auto-switch here because the user
    // should pick which one to land on.)
    if (wasCurrentOrg && !wasOnlyOrg) {
      return {
        ok: false,
        error: 'Switch to a different business before deleting this one (top-left dropdown)',
      };
    }

    const result = await deleteOrganizationCascade(args.orgId);
    logger.warn(
      { orgId: args.orgId, name: result.organizationName, totalRowsDeleted: result.totalRowsDeleted },
      'organization deleted (cascade)',
    );

    // If they just deleted their only business, leave them org-less and
    // clear the org cookie + columns. getCurrentOrgId then routes them
    // into the read-only demo workspace (with a banner prompting them to
    // create a workspace from /businesses). Previously this path auto-
    // created a fresh "My Business" — we don't want that anymore.
    let redirectTo: string | undefined;
    if (wasOnlyOrg) {
      await db
        .update(users)
        .set({ activeOrganizationId: null, organizationId: null })
        .where(eq(users.id, user.id));
      const cookieStore = await cookies();
      cookieStore.set(ORG_COOKIE, '', {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        maxAge: 0,
      });
      redirectTo = '/dashboard';
    }

    revalidatePath('/businesses');
    revalidatePath('/dashboard');
    return { ok: true, totalRowsDeleted: result.totalRowsDeleted, redirectTo };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Delete failed' };
  }
}
