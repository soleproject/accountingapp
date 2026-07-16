'use server';

import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { signatureRequests } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { requireSession } from '@/lib/auth/session';
import { remindRecipient } from '@/lib/signatures/route';

/** Owner action: re-send a pending recipient's signing invite. Org-scoped. */
export async function resendInviteAction(requestId: string, recipientId: string): Promise<{ ok: boolean; error?: string }> {
  await requireSession();
  const orgId = await getCurrentOrgId();

  const [req] = await db
    .select({ id: signatureRequests.id })
    .from(signatureRequests)
    .where(and(eq(signatureRequests.id, requestId), eq(signatureRequests.organizationId, orgId)))
    .limit(1);
  if (!req) return { ok: false, error: 'Request not found.' };

  return remindRecipient(requestId, recipientId);
}
