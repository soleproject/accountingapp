import type { NextRequest } from 'next/server';
import { redirect } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { organizations } from '@/db/schema/schema';
import { requireSession } from '@/lib/auth/session';
import { openClientBooksSession } from '@/lib/enterprise/open-books';

/**
 * Open a client company's books from the firm AI assistant. The open_client_books
 * page-tool returns a navigate to here (a full browser navigation, since setting
 * impersonation cookies mid-SSE-stream is impossible and a new session needs a full
 * load). Sets the session on this request's response, then redirects into the books.
 * openClientBooksSession re-checks firm access (canImpersonate + org ownership).
 */
export async function GET(req: NextRequest): Promise<Response> {
  const real = await requireSession();
  const orgId = new URL(req.url).searchParams.get('org') ?? '';
  if (!orgId) redirect('/enterprise/dashboard');

  const [org] = await db
    .select({ ownerUserId: organizations.ownerUserId })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  if (!org?.ownerUserId) redirect('/enterprise/dashboard');

  await openClientBooksSession(real.id, org.ownerUserId, orgId);
  redirect('/dashboard');
}
