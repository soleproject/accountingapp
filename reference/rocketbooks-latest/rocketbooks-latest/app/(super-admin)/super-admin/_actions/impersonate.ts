'use server';

import { randomUUID } from 'crypto';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { users, adminAuditLog } from '@/db/schema/schema';
import { requireSession } from '@/lib/auth/session';
import { IMPERSONATE_COOKIE, OPEN_BOOKS_COOKIE, canImpersonate } from '@/lib/auth/impersonate';
import { IMPERSONATION_BANNER_DISMISSED_COOKIE } from '@/app/(app)/_actions/impersonation-banner-constants';

const COOKIE_OPTS = { httpOnly: true, sameSite: 'lax' as const, path: '/' };

export async function startImpersonationAction(formData: FormData): Promise<void> {
  const real = await requireSession();

  const targetUserId = String(formData.get('targetUserId') ?? '');
  if (!targetUserId) throw new Error('targetUserId required');
  if (targetUserId === real.id) throw new Error("Can't impersonate yourself");

  if (!(await canImpersonate(real.id, targetUserId))) throw new Error('forbidden');

  const [target] = await db
    .select({ id: users.id, email: users.email, role: users.role })
    .from(users)
    .where(eq(users.id, targetUserId))
    .limit(1);
  if (!target) throw new Error('Target user not found');

  // Super-admin impersonation PERSISTS (ended only via the banner — a super-admin
  // impersonating a firm owner wants /enterprise to render as that firm). An
  // enterprise owner/staff "Open client" is an enterprise→client session that must
  // auto-end when they return to /enterprise (e.g. via the browser Back button),
  // else the firm dashboard renders as the impersonated client. Mark the latter
  // with rs_open_books — the same marker "Open books" sets — so the middleware
  // cleanup catches it. Distinguished by the REAL user's role.
  const [realProfile] = await db
    .select({ role: users.role })
    .from(users)
    .where(eq(users.id, real.id))
    .limit(1);
  const realIsSuper = realProfile?.role === 'super_admin' || realProfile?.role === 'superadmin';

  const cookieStore = await cookies();
  cookieStore.set(IMPERSONATE_COOKIE, targetUserId, {
    ...COOKIE_OPTS,
    maxAge: 60 * 60 * 8, // 8 hours — long enough for a working session, short enough to expire on its own
  });
  if (!realIsSuper) {
    cookieStore.set(OPEN_BOOKS_COOKIE, '1', { ...COOKIE_OPTS, maxAge: 60 * 60 * 8 });
  }

  // Reset the banner-dismissed flag so the full impersonation banner shows
  // for each new target (it can be collapsed back into the TopBar pill).
  cookieStore.set(IMPERSONATION_BANNER_DISMISSED_COOKIE, '', { path: '/', maxAge: 0 });

  await db.insert(adminAuditLog).values({
    id: randomUUID(),
    adminUserId: real.id,
    action: 'user.impersonate.start',
    targetType: 'user',
    targetId: targetUserId,
    auditMetadata: { targetEmail: target.email },
  });

  // Drop the admin into the impersonated user's primary landing page, or
  // a caller-supplied next path (used by the "Complete Onboarding" button
  // to land directly on /ai-chat). Same-origin internal paths only --
  // anything else falls back to /dashboard.
  const rawNext = String(formData.get('next') ?? '/dashboard');
  const safeNext =
    rawNext.startsWith('/') && !rawNext.startsWith('//') && !rawNext.startsWith('/\\')
      ? rawNext
      : '/dashboard';
  revalidatePath('/', 'layout');
  redirect(safeNext);
}

export async function stopImpersonationAction(): Promise<void> {
  // Important: this action uses the REAL session, not the effective one,
  // so it still works while we're impersonating a non-super-admin (whose
  // role wouldn't pass isSuperAdmin).
  const real = await requireSession();
  const cookieStore = await cookies();
  const previousTarget = cookieStore.get(IMPERSONATE_COOKIE)?.value;

  cookieStore.set(IMPERSONATE_COOKIE, '', { ...COOKIE_OPTS, maxAge: 0 });
  cookieStore.set(OPEN_BOOKS_COOKIE, '', { ...COOKIE_OPTS, maxAge: 0 });

  if (previousTarget) {
    await db.insert(adminAuditLog).values({
      id: randomUUID(),
      adminUserId: real.id,
      action: 'user.impersonate.stop',
      targetType: 'user',
      targetId: previousTarget,
    });
  }

  // Route back to wherever the real user came from. Super admins land on
  // the directory; everyone else (enterprise owner/staff) returns to their
  // enterprise clients list.
  const [realProfile] = await db
    .select({ role: users.role })
    .from(users)
    .where(eq(users.id, real.id))
    .limit(1);
  const isSuper = realProfile?.role === 'super_admin' || realProfile?.role === 'superadmin';

  revalidatePath('/', 'layout');
  redirect(isSuper ? '/super-admin/all-users' : '/enterprise/clients');
}
