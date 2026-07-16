'use server';

import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { users } from '@/db/schema/schema';
import { requireSession } from '@/lib/auth/session';
import { getEffectiveUserId } from '@/lib/auth/impersonate';

/**
 * Mark the dashboard welcome takeover as dismissed for the current user.
 * Called when the user picks any chip on the takeover or closes it. Uses
 * the effective user id so an impersonating admin "dismisses as the user"
 * (matches addBusinessAction's convention -- the takeover, like onboarding,
 * is the impersonated user's experience).
 */
export async function dismissWelcomeAction(): Promise<{ ok: true }> {
  await requireSession();
  const userId = await getEffectiveUserId();
  await db
    .update(users)
    .set({ welcomeDismissedAt: new Date().toISOString() })
    .where(eq(users.id, userId));
  return { ok: true };
}

/**
 * Clear the dashboard welcome takeover dismissal so the takeover re-fires
 * on the next dashboard visit. Wired to the "Tour" button in TopBar.
 */
export async function resetWelcomeAction(): Promise<{ ok: true }> {
  await requireSession();
  const userId = await getEffectiveUserId();
  await db
    .update(users)
    .set({ welcomeDismissedAt: null })
    .where(eq(users.id, userId));
  return { ok: true };
}
