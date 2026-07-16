'use server';

import { revalidatePath } from 'next/cache';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { onboardingState } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';

/**
 * Records a per-org timestamp marking when the user explicitly reviewed
 * their Plaid accounts and decided which to scope in. Banner re-appears
 * later if NEW accounts are linked after this timestamp.
 */
export async function dismissPlaidReview(): Promise<{ ok: boolean }> {
  const orgId = await getCurrentOrgId();
  const now = new Date().toISOString();

  const [existing] = await db
    .select({ context: onboardingState.context, phase: onboardingState.phase, completed: onboardingState.completed })
    .from(onboardingState)
    .where(eq(onboardingState.orgId, orgId))
    .limit(1);

  const prevContext = (existing?.context as Record<string, unknown> | null) ?? {};
  const nextContext = { ...prevContext, plaidReviewDismissedAt: now };

  if (existing) {
    await db
      .update(onboardingState)
      .set({ context: nextContext, updatedAt: now })
      .where(eq(onboardingState.orgId, orgId));
  } else {
    // No onboarding row yet — create a minimal one just to hold the dismiss flag
    await db.insert(onboardingState).values({
      orgId,
      phase: 'business_info',
      step: 'business_info',
      context: nextContext,
      completed: false,
      updatedAt: now,
    });
  }

  revalidatePath('/integrations/plaid');
  return { ok: true };
}
