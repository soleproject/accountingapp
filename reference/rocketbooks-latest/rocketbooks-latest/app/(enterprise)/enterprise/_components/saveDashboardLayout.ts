'use server';

import { eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { db } from '@/db/client';
import { users } from '@/db/schema/schema';
import { getSession } from '@/lib/auth/session';
import type { DashboardLayout } from '@/lib/enterprise/dashboard-widgets';

/**
 * Persist the signed-in user's Enterprise dashboard layout under the
 * `enterprise` key of users.dashboard_prefs. Per-user and private — uses the
 * real session user (not the impersonated/effective user), since the layout is
 * "my view" regardless of which client is being looked at.
 */
export async function saveEnterpriseDashboardLayout(
  layout: DashboardLayout,
): Promise<{ ok: boolean }> {
  const user = await getSession();
  if (!user) return { ok: false };

  const [row] = await db
    .select({ prefs: users.dashboardPrefs })
    .from(users)
    .where(eq(users.id, user.id))
    .limit(1);

  const prefs = (row?.prefs && typeof row.prefs === 'object' ? row.prefs : {}) as Record<string, unknown>;
  prefs.enterprise = {
    order: layout.order,
    hidden: layout.hidden,
    sizes: layout.sizes,
    tabs: layout.tabs,
    tabOf: layout.tabOf,
  };

  await db.update(users).set({ dashboardPrefs: prefs }).where(eq(users.id, user.id));
  revalidatePath('/enterprise/dashboard');
  return { ok: true };
}
