'use server';

import { revalidatePath } from 'next/cache';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { organizations } from '@/db/schema/schema';
import { requireSession } from '@/lib/auth/session';
import { getCurrentOrgId } from '@/lib/auth/org';

export interface SetVideoTranscriptionResult {
  ok: boolean;
  error?: string;
}

/**
 * Org-level toggle for Organizer Video auto-transcription (migration 0088).
 * When on, video calls auto-start Daily transcription and email the host a copy
 * when the call ends.
 */
export async function setVideoTranscriptionAction(enabled: boolean): Promise<SetVideoTranscriptionResult> {
  await requireSession();
  const orgId = await getCurrentOrgId();
  await db
    .update(organizations)
    .set({ videoTranscriptionEnabled: enabled })
    .where(eq(organizations.id, orgId));
  revalidatePath('/settings');
  revalidatePath('/organizer/settings');
  return { ok: true };
}
