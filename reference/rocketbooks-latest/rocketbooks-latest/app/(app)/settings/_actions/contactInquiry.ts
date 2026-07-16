'use server';

import { revalidatePath } from 'next/cache';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { organizations } from '@/db/schema/schema';
import { requireSession } from '@/lib/auth/session';
import { getCurrentOrgId } from '@/lib/auth/org';
import { hasAnyPermission } from '@/lib/auth/permissions';

export interface SetContactInquiryResult {
  ok: boolean;
  error?: string;
}

/** Org-level opt-in for the daily "what's this?" contact-inquiry email (migration 0123). Accountant-gated. */
export async function setContactInquiry(enabled: boolean): Promise<SetContactInquiryResult> {
  await requireSession();
  const orgId = await getCurrentOrgId();
  const can = await hasAnyPermission([
    'accounting.transactions.accountant_review',
    'enterprise.dashboard.view',
    'enterprise.clients.view',
  ]);
  if (!can) return { ok: false, error: 'Not allowed' };

  await db.update(organizations).set({ contactInquiryEnabled: enabled }).where(eq(organizations.id, orgId));
  revalidatePath('/settings');
  return { ok: true };
}
