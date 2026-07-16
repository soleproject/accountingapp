'use server';

import { cookies } from 'next/headers';
import { ACTIVE_ENTERPRISE_COOKIE, listAccessibleEnterprises } from '@/lib/auth/enterprise';
import { DEMO_ENTERPRISE_ID } from '@/lib/enterprise/demo';

/**
 * Switch the user's active enterprise. Validates that the user actually
 * has access to the requested enterprise before writing the cookie — never
 * trust the form's enterpriseId on its own. Doesn't navigate; the caller
 * router.refresh()es (or push()es to /enterprise/dashboard) so server
 * components re-read the cookie.
 */
export async function switchEnterpriseAction(formData: FormData): Promise<void> {
  const id = String(formData.get('enterpriseId') ?? '').trim();
  if (!id) throw new Error('enterpriseId is required');

  // The virtual demo enterprise is always selectable (it exposes no real data).
  if (id !== DEMO_ENTERPRISE_ID) {
    const accessible = await listAccessibleEnterprises();
    if (!accessible.some((e) => e.id === id)) {
      throw new Error('You do not have access to this enterprise');
    }
  }

  const cookieStore = await cookies();
  cookieStore.set(ACTIVE_ENTERPRISE_COOKIE, id, {
    path: '/',
    sameSite: 'lax',
    httpOnly: false,
    maxAge: 60 * 60 * 24 * 365,
  });
}
