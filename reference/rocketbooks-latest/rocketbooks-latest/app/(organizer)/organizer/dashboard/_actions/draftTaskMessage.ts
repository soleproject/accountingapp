'use server';

import { requireSession } from '@/lib/auth/session';
import { getCurrentOrgId } from '@/lib/auth/org';
import { getEffectiveUserId } from '@/lib/auth/impersonate';
import { generateStepDraft } from '@/lib/organizer/draft-step';

export interface DraftTaskMessageInput {
  taskId: string;
  channel: 'email' | 'text';
  tone: string;
  /** Optional: the specific step this draft is for. */
  stepTitle?: string;
}

export interface DraftTaskMessageResult {
  ok: boolean;
  text?: string;
  error?: string;
}

/**
 * Draft a brand-new email/text for an outbound task step, grounded in the
 * task's context pack. Thin wrapper over the shared generator. Nothing is
 * persisted; the text drops into the compose box for review.
 */
export async function draftTaskMessageAction(input: DraftTaskMessageInput): Promise<DraftTaskMessageResult> {
  try {
    await requireSession();
    const userId = await getEffectiveUserId();
    const orgId = await getCurrentOrgId();
    return await generateStepDraft({
      userId,
      orgId,
      taskId: input.taskId,
      channel: input.channel,
      tone: input.tone,
      stepTitle: input.stepTitle,
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Draft failed' };
  }
}
