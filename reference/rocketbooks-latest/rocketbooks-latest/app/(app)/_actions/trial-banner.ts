'use server';

import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { TRIAL_BANNER_DISMISSED_COOKIE } from './trial-banner-constants';

/**
 * Hide the in-app demo-trial banner for the rest of this session. The
 * cookie is a plain session cookie (no Max-Age), so it auto-clears when
 * the browser closes; the login action also clears it on every sign-in
 * so the banner always returns for a fresh session.
 *
 * Active-state only — the expired-state banner is non-dismissible since
 * the user is in read-only mode and needs to act.
 */
export async function dismissTrialBannerAction(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set(TRIAL_BANNER_DISMISSED_COOKIE, '1', {
    path: '/',
    sameSite: 'lax',
    httpOnly: false,
  });
  revalidatePath('/', 'layout');
}
