'use server';

import { revalidatePath } from 'next/cache';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { inboxMessages } from '@/db/schema/schema';
import { requireSession } from '@/lib/auth/session';
import { getCurrentOrgId } from '@/lib/auth/org';
import { isDemoOrg } from '@/lib/auth/demo';

export interface DismissInboxResult {
  ok: boolean;
  error?: string;
}

/**
 * "Mark reviewed" for the dashboard Inbox card: triages an email so it drops
 * off the dashboard (the card shows status='open'). Same effect as replying or
 * triaging from the inbox detail, but one click from the dashboard. No-op in
 * the shared Demo Co org — its dashboard never clears.
 */
export async function dismissInboxAction(input: { messageId: string }): Promise<DismissInboxResult> {
  const user = await requireSession();
  const orgId = await getCurrentOrgId();

  // Demo Co is the global example org — never clear its dashboard messages.
  if (isDemoOrg(orgId)) return { ok: true };

  const [m] = await db
    .select({ id: inboxMessages.id })
    .from(inboxMessages)
    .where(
      and(
        eq(inboxMessages.id, input.messageId),
        eq(inboxMessages.organizationId, orgId),
        eq(inboxMessages.userId, user.id),
      ),
    )
    .limit(1);
  if (!m) return { ok: false, error: 'Message not found' };

  await db
    .update(inboxMessages)
    .set({ status: 'triaged', triagedAt: new Date().toISOString() })
    .where(eq(inboxMessages.id, input.messageId));

  revalidatePath('/organizer/dashboard');
  revalidatePath('/inbox');
  revalidatePath('/organizer/inbox');
  return { ok: true };
}
