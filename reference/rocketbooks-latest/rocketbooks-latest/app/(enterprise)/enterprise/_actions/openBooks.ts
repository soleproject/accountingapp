'use server';

import { redirect } from 'next/navigation';
import { asc, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { organizations } from '@/db/schema/schema';
import { requireSession } from '@/lib/auth/session';
import { openClientBooksSession } from '@/lib/enterprise/open-books';

/**
 * Open a client COMPANY's books as the firm: impersonate the client owner, set the
 * active organization to that company, and drop into the client workspace. This is
 * the "blue pill" (Working in <Company>) treatment — openClientBooksSession sets
 * rs_open_books + dismisses the impersonation banner, so it works regardless of the
 * acting user's role (unlike plain impersonation, which shows the red banner).
 *
 * `orgId` is optional: when a button knows the exact company (e.g. a Needs-Attention
 * row) it passes it; otherwise we resolve the client's primary company (their `pro`
 * workspace, else their oldest org). `next` is a same-origin path to land on after.
 */
export async function openClientBooksAction(formData: FormData): Promise<void> {
  const real = await requireSession();
  const targetUserId = String(formData.get('targetUserId') ?? '').trim();
  if (!targetUserId) redirect('/enterprise/clients');

  const nextRaw = String(formData.get('next') ?? '').trim();
  const next = nextRaw.startsWith('/') && !nextRaw.startsWith('//') ? nextRaw : '/dashboard';

  let orgId = String(formData.get('orgId') ?? '').trim();
  if (!orgId) {
    // Resolve the client's primary company: a `pro` workspace wins, else the oldest.
    const orgs = await db
      .select({ id: organizations.id, planType: organizations.planType })
      .from(organizations)
      .where(eq(organizations.ownerUserId, targetUserId))
      .orderBy(asc(organizations.createdAt));
    orgId = orgs.find((o) => o.planType === 'pro')?.id ?? orgs[0]?.id ?? '';
  }
  // No company to open (org-less client) — nothing to "work in"; send the firm to
  // the client's record instead of starting a bare impersonation (which would be
  // the red banner we're moving away from).
  if (!orgId) redirect(`/enterprise/clients/${targetUserId}`);

  await openClientBooksSession(real.id, targetUserId, orgId);
  redirect(next);
}
