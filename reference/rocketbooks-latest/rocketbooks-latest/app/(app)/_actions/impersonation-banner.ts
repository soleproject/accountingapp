'use server';

import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { IMPERSONATION_BANNER_DISMISSED_COOKIE } from './impersonation-banner-constants';

/**
 * Collapse the red "Impersonating …" banner into the compact TopBar pill
 * for the rest of this impersonation session. Plain session cookie (no
 * Max-Age) so it auto-clears when the browser closes; startImpersonationAction
 * also clears it whenever a new impersonation begins, so the full banner
 * always returns for a fresh target.
 */
export async function dismissImpersonationBannerAction(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set(IMPERSONATION_BANNER_DISMISSED_COOKIE, '1', {
    path: '/',
    sameSite: 'lax',
    httpOnly: false,
  });
  revalidatePath('/', 'layout');
}
