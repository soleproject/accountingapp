'use server';

import { revalidatePath } from 'next/cache';
import { requireSession } from '@/lib/auth/session';
import { getEffectiveUserId } from '@/lib/auth/impersonate';
import { recordSpecReview } from '@/lib/tax/review';
import type { SpecTrustStatus } from '@/lib/tax/spec';

export interface ReviewSpecState {
  error?: string;
  ok?: boolean;
  newStatus?: string;
}

const VALID: SpecTrustStatus[] = ['learned', 'verified', 'locked', 'deprecated'];

/**
 * Promote/demote a FormSpec on the trust ladder from its review page. Specs are global
 * knowledge, so there's no org scoping here — but it's gated by requireSession and writes
 * an audit row tagged with the acting user. recordSpecReview validates the transition.
 */
export async function reviewSpecAction(
  _prev: ReviewSpecState | undefined,
  formData: FormData,
): Promise<ReviewSpecState> {
  await requireSession();
  const userId = await getEffectiveUserId();

  const specId = String(formData.get('spec_id') ?? '');
  const toStatus = String(formData.get('to_status') ?? '') as SpecTrustStatus;
  const notes = (formData.get('notes') as string | null)?.trim() || null;

  if (!specId) return { error: 'Missing spec id.' };
  if (!VALID.includes(toStatus)) return { error: 'Invalid target status.' };

  const result = await recordSpecReview(specId, userId, toStatus, notes);
  if (!result.ok) return { error: result.error };

  revalidatePath(`/taxes/specs/${specId}`);
  return { ok: true, newStatus: result.newStatus };
}
