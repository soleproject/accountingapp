import { NextResponse, type NextRequest } from 'next/server';
import { randomUUID } from 'crypto';
import { db } from '@/db/client';
import { adminAuditLog } from '@/db/schema/schema';
import { requireSession } from '@/lib/auth/session';
import { IMPERSONATE_COOKIE, OPEN_BOOKS_COOKIE } from '@/lib/auth/impersonate';

const ORG_COOKIE = 'rs_org_id';

/**
 * Auto-stop impersonation when the firm user leaves the client's books (the
 * "Accounting section") back into the enterprise area. The enterprise layout
 * redirects here whenever it sees an active impersonation cookie. We log the
 * stop (so the access pair start→stop is complete), clear the impersonation +
 * active-company cookies, and drop the user on the businesses list.
 */
export async function GET(req: NextRequest) {
  const real = await requireSession();
  const target = req.cookies.get(IMPERSONATE_COOKIE)?.value;
  // Distinguish an explicit "Close books" click from drifting out of the area.
  const reason = req.nextUrl.searchParams.get('reason') === 'closed_books' ? 'closed_books' : 'left_accounting_section';

  if (target) {
    try {
      await db.insert(adminAuditLog).values({
        id: randomUUID(),
        adminUserId: real.id,
        action: 'user.impersonate.stop',
        targetType: 'user',
        targetId: target,
        auditMetadata: { auto: reason !== 'closed_books', reason },
      });
    } catch {
      // best-effort audit — never block the return on a logging hiccup
    }
  }

  const res = NextResponse.redirect(new URL('/enterprise/businesses', req.url));
  res.cookies.set(IMPERSONATE_COOKIE, '', { path: '/', maxAge: 0 });
  // The active-company cookie was repointed at the client company by Open
  // books — clear it so the firm user resumes their own workspace cleanly.
  res.cookies.set(ORG_COOKIE, '', { path: '/', maxAge: 0 });
  res.cookies.set(OPEN_BOOKS_COOKIE, '', { path: '/', maxAge: 0 });
  return res;
}
