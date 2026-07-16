import 'server-only';
import { randomUUID } from 'crypto';
import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { users, organizations, adminAuditLog, activityFeed } from '@/db/schema/schema';
import { IMPERSONATE_COOKIE, OPEN_BOOKS_COOKIE, canImpersonate } from '@/lib/auth/impersonate';
import { IMPERSONATION_BANNER_DISMISSED_COOKIE } from '@/app/(app)/_actions/impersonation-banner-constants';

const ORG_COOKIE = 'rs_org_id';
const COOKIE_OPTS = { httpOnly: true, sameSite: 'lax' as const, path: '/' };

/**
 * Core of "Open books": validate firm access, set the impersonation + active-org
 * + open-books cookies, point the client's active org at this company, and
 * register the access (firm audit row + client-visible activity feed). NO redirect
 * — callers navigate afterward (the server action redirects; the AI-tool route
 * handler redirects; both must run in a fresh request, not mid-SSE-stream, so the
 * cookies land on the response). Returns the company name for confirmation.
 */
export async function openClientBooksSession(
  realUserId: string,
  targetUserId: string,
  orgId: string,
): Promise<{ orgId: string; orgName: string }> {
  if (!targetUserId || !orgId) throw new Error('Missing client or company.');
  if (targetUserId === realUserId) throw new Error("Can't open your own books here");

  // Permission: super-admin, or an enterprise owner/staff whose enterprise has
  // this user as a client.
  if (!(await canImpersonate(realUserId, targetUserId))) throw new Error('forbidden');

  // The company must actually belong to this client.
  const [org] = await db
    .select({ id: organizations.id, name: organizations.name })
    .from(organizations)
    .where(and(eq(organizations.id, orgId), eq(organizations.ownerUserId, targetUserId)))
    .limit(1);
  if (!org) throw new Error('Company not found for this client');

  const cookieStore = await cookies();
  cookieStore.set(IMPERSONATE_COOKIE, targetUserId, { ...COOKIE_OPTS, maxAge: 60 * 60 * 8 });
  cookieStore.set(ORG_COOKIE, orgId, { ...COOKIE_OPTS, maxAge: 60 * 60 * 24 * 30 });
  cookieStore.set(OPEN_BOOKS_COOKIE, '1', { ...COOKIE_OPTS, maxAge: 60 * 60 * 8 });
  cookieStore.set(IMPERSONATION_BANNER_DISMISSED_COOKIE, '1', { path: '/', sameSite: 'lax', httpOnly: false });

  await db.update(users).set({ activeOrganizationId: orgId }).where(eq(users.id, targetUserId));

  await db.insert(adminAuditLog).values({
    id: randomUUID(),
    adminUserId: realUserId,
    action: 'enterprise.open_books',
    targetType: 'organization',
    targetId: orgId,
    auditMetadata: { clientUserId: targetUserId, orgName: org.name },
  });
  try {
    await db.insert(activityFeed).values({
      id: randomUUID(),
      orgId,
      userId: realUserId,
      actor: 'firm',
      eventType: 'firm.opened_books',
      eventMetadata: { firmUserId: realUserId },
    });
  } catch {
    // Client-feed entry is best-effort — never block opening the books on it.
  }

  revalidatePath('/', 'layout');
  return { orgId, orgName: org.name };
}
