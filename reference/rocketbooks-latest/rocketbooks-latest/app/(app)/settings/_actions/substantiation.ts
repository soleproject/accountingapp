'use server';

import { revalidatePath } from 'next/cache';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { organizations } from '@/db/schema/schema';
import { requireSession } from '@/lib/auth/session';
import { getCurrentOrgId } from '@/lib/auth/org';
import { hasAnyPermission } from '@/lib/auth/permissions';

export interface SetSubstantiationResult {
  ok: boolean;
  error?: string;
}

/** Org-level opt-in for the weekly IRS-documentation request cron (migration 0124). Accountant-gated. */
export async function setSubstantiation(enabled: boolean): Promise<SetSubstantiationResult> {
  await requireSession();
  const orgId = await getCurrentOrgId();
  const can = await hasAnyPermission([
    'accounting.transactions.accountant_review',
    'enterprise.dashboard.view',
    'enterprise.clients.view',
  ]);
  if (!can) return { ok: false, error: 'Not allowed' };

  await db.update(organizations).set({ substantiationEnabled: enabled }).where(eq(organizations.id, orgId));
  revalidatePath('/settings');
  return { ok: true };
}
