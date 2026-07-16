'use server';

import { revalidatePath } from 'next/cache';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { textMessages } from '@/db/schema/schema';
import { requireSession } from '@/lib/auth/session';
import { getCurrentOrgId } from '@/lib/auth/org';
import { isDemoOrg } from '@/lib/auth/demo';

export interface DismissTextResult {
  ok: boolean;
  error?: string;
}

/**
 * "Mark reviewed" for the dashboard Texts card: clears a still-unanswered text
 * thread from the dashboard without sending a reply. Sets dashboard_dismissed_at
 * on the given (latest inbound) message; a newer inbound message brings the
 * thread back. No-op in the shared Demo Co org — its dashboard never clears.
 */
export async function dismissTextAction(input: { messageId: string }): Promise<DismissTextResult> {
  await requireSession();
  const orgId = await getCurrentOrgId();

  // Demo Co is the global example org — never clear its dashboard messages.
  if (isDemoOrg(orgId)) return { ok: true };

  const [m] = await db
    .select({ id: textMessages.id })
    .from(textMessages)
    .where(and(eq(textMessages.id, input.messageId), eq(textMessages.organizationId, orgId)))
    .limit(1);
  if (!m) return { ok: false, error: 'Message not found' };

  await db
    .update(textMessages)
    .set({ dashboardDismissedAt: new Date().toISOString() })
    .where(eq(textMessages.id, input.messageId));

  revalidatePath('/organizer/dashboard');
  return { ok: true };
}
