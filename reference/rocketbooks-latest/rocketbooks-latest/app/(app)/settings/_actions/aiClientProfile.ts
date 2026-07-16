'use server';

import { revalidatePath } from 'next/cache';
import { requireSession } from '@/lib/auth/session';
import { getCurrentOrgId } from '@/lib/auth/org';
import {
  saveProfilePrefs,
  removeLearning,
  type CommunicationStyle,
} from '@/lib/ai/client-profile';

export interface SaveResult {
  ok: boolean;
  error?: string;
}

const STYLES: CommunicationStyle[] = ['brief', 'standard', 'detailed'];

/** Save the user-editable AI assistant preferences for the current org. */
export async function saveAiClientPrefs(input: {
  communicationStyle?: string;
  skipBelowAmount?: number | null;
  standingInstructions?: string;
}): Promise<SaveResult> {
  await requireSession();
  const orgId = await getCurrentOrgId();

  const style = STYLES.includes(input.communicationStyle as CommunicationStyle)
    ? (input.communicationStyle as CommunicationStyle)
    : undefined;
  const amount =
    typeof input.skipBelowAmount === 'number' && input.skipBelowAmount > 0
      ? Math.round(input.skipBelowAmount)
      : null;
  const standing = (input.standingInstructions ?? '').trim().slice(0, 1000) || undefined;

  await saveProfilePrefs(orgId, {
    communicationStyle: style,
    skipBelowAmount: amount,
    standingInstructions: standing,
  });
  revalidatePath('/settings');
  return { ok: true };
}

/** Forget a single AI-learned fact by id. */
export async function removeAiClientLearning(id: string): Promise<SaveResult> {
  await requireSession();
  const orgId = await getCurrentOrgId();
  if (!id) return { ok: false, error: 'Missing id' };
  await removeLearning(orgId, id);
  revalidatePath('/settings');
  return { ok: true };
}
