'use server';

import { revalidatePath } from 'next/cache';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { organizations } from '@/db/schema/schema';
import { requireSession } from '@/lib/auth/session';
import { getCurrentOrgId } from '@/lib/auth/org';
import { hasAnyPermission } from '@/lib/auth/permissions';

export interface SetPayerTinResult { ok: boolean; error?: string }

/** Set the payer (filing business) TIN/EIN used on generated 1099-NEC forms. */
export async function setPayerTin(value: string): Promise<SetPayerTinResult> {
  await requireSession();
  const orgId = await getCurrentOrgId();
  const can = await hasAnyPermission([
    'accounting.transactions.accountant_review',
    'enterprise.dashboard.view',
    'enterprise.clients.view',
  ]);
  if (!can) return { ok: false, error: 'Not allowed' };

  const tin = value.trim();
  await db.update(organizations).set({ payerTin: tin === '' ? null : tin }).where(eq(organizations.id, orgId));
  revalidatePath('/settings');
  return { ok: true };
}
