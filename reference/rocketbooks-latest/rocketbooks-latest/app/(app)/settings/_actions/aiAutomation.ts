'use server';

import { revalidatePath } from 'next/cache';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { organizations } from '@/db/schema/schema';
import { requireSession } from '@/lib/auth/session';
import { getCurrentOrgId } from '@/lib/auth/org';
import { hasAnyPermission } from '@/lib/auth/permissions';
import { AUTOMATION_LEVELS, levelToSettings, type AutomationLevel } from '@/lib/accounting/automation-levels';

export interface SetAiAutomationResult {
  ok: boolean;
  error?: string;
}

/**
 * Org-level AI categorization automation (migration 0119). Maps a friendly
 * level to (aiAutoPostEnabled, aiAutoPostThreshold); the auto-categorize job
 * reads these on its next run. Gated to accounting professionals — the same
 * audience as the accountant review lens.
 */
export async function setAiAutomationLevel(level: AutomationLevel): Promise<SetAiAutomationResult> {
  await requireSession();
  const orgId = await getCurrentOrgId();

  const canManage = await hasAnyPermission([
    'accounting.transactions.accountant_review',
    'enterprise.dashboard.view',
    'enterprise.clients.view',
  ]);
  if (!canManage) return { ok: false, error: 'Not allowed' };

  if (!AUTOMATION_LEVELS.some((l) => l.value === level)) {
    return { ok: false, error: 'Invalid automation level' };
  }
  const { enabled, threshold } = levelToSettings(level);

  await db
    .update(organizations)
    .set({ aiAutoPostEnabled: enabled, aiAutoPostThreshold: threshold })
    .where(eq(organizations.id, orgId));
  revalidatePath('/settings');
  revalidatePath('/transactions');
  return { ok: true };
}
