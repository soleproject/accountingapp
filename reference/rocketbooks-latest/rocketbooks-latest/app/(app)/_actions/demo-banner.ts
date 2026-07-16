'use server';

import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { DEMO_BANNER_DISMISSED_COOKIE } from './demo-banner-constants';

/**
 * Hide the "you're in the demo workspace" banner for the rest of this
 * session. The cookie is a plain session cookie (no Max-Age), so it
 * auto-clears when the browser closes; the login action also clears it
 * on every sign-in so the banner always returns for a fresh session.
 */
export async function dismissDemoBannerAction(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set(DEMO_BANNER_DISMISSED_COOKIE, '1', {
    path: '/',
    sameSite: 'lax',
    httpOnly: false,
  });
  revalidatePath('/', 'layout');
}
