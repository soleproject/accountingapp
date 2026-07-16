'use server';

import { revalidatePath } from 'next/cache';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { organizations } from '@/db/schema/schema';
import { requireSession } from '@/lib/auth/session';
import { getCurrentOrgId } from '@/lib/auth/org';
import { hasAnyPermission } from '@/lib/auth/permissions';

export interface SetMonthlyReportResult {
  ok: boolean;
  error?: string;
}

/**
 * Org-level monthly report email config (migration 0121). Gated to accounting
 * professionals (same audience as the accountant lens). The cron reads these
 * on the 1st of each month.
 */
export async function setMonthlyReport(input: {
  enabled?: boolean;
  recipients?: string;
}): Promise<SetMonthlyReportResult> {
  await requireSession();
  const orgId = await getCurrentOrgId();
  const can = await hasAnyPermission([
    'accounting.transactions.accountant_review',
    'enterprise.dashboard.view',
    'enterprise.clients.view',
  ]);
  if (!can) return { ok: false, error: 'Not allowed' };

  const patch: { monthlyReportEnabled?: boolean; monthlyReportRecipients?: string | null } = {};
  if (typeof input.enabled === 'boolean') patch.monthlyReportEnabled = input.enabled;
  if (typeof input.recipients === 'string') {
    const cleaned = input.recipients.trim();
    patch.monthlyReportRecipients = cleaned.length ? cleaned.slice(0, 2000) : null;
  }
  if (Object.keys(patch).length === 0) return { ok: true };

  await db.update(organizations).set(patch).where(eq(organizations.id, orgId));
  revalidatePath('/settings');
  return { ok: true };
}
