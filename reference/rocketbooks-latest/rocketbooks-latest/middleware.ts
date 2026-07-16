import { NextResponse, type NextRequest } from 'next/server';
import { updateSession } from '@/lib/supabase/proxy';
import { createRequestObservation, emitEdgePerformanceEvent } from '@/lib/perf/request-observability-edge';

// Cookie names duplicated from lib/auth/impersonate.ts + lib/auth/org.ts — those
// modules are 'server-only' and can't be imported into edge middleware.
const IMPERSONATE_COOKIE = 'rs_impersonate';
const ORG_COOKIE = 'rs_org_id';
const OPEN_BOOKS_COOKIE = 'rs_open_books';

export async function middleware(request: NextRequest) {
  const observation = createRequestObservation(request);
  emitEdgePerformanceEvent(observation, 'request_start', 0, 'ok');
  // Leaving a client's books (Open books / impersonation) back into the
  // enterprise area auto-ends the session here, at the edge. Doing it in
  // middleware (vs a layout redirect to a route handler) means soft/back
  // navigations resolve cleanly instead of rendering a blank RSC payload that
  // needed a manual refresh.
  const { pathname } = request.nextUrl;
  // CRITICAL: only auto-stop on a genuine TOP-LEVEL navigation — clicking a link
  // to the enterprise area, typing the URL, reload, or back. Those send
  // `Sec-Fetch-Mode: navigate`. Background prefetches AND RSC soft-fetches send
  // `cors`; clearing the session on one of those (e.g. a prefetch of an
  // /enterprise link from the workspace switcher) silently ended impersonation
  // mid-session, so the AI route then resolved the firm user's own org. Gating
  // on `navigate` is the reliable signal (prior next-router-prefetch/sec-purpose
  // checks missed the offending request).
  const isTopLevelNav = request.headers.get('sec-fetch-mode') === 'navigate';
  // Only auto-stop "Open books" sessions (they set rs_open_books). Regular
  // super-admin impersonation has no rs_open_books and is ended via the banner's
  // "Stop impersonating" button — middleware must not touch it. Note: enterprise
  // "Open client" now also sets rs_open_books (see startImpersonationAction), so it
  // is auto-ended here too when the firm admin navigates back to /enterprise.
  if (
    isTopLevelNav &&
    pathname.startsWith('/enterprise') &&
    request.cookies.get(OPEN_BOOKS_COOKIE)?.value &&
    request.cookies.get(IMPERSONATE_COOKIE)?.value
  ) {
    // Redirect to the same /enterprise page they were heading to (minus the
    // impersonation cookies) so a Back-nav lands where expected (e.g. the firm
    // dashboard) rather than a forced /enterprise/businesses.
    const url = request.nextUrl.clone();
    url.search = '';
    const res = NextResponse.redirect(url);
    res.cookies.set(IMPERSONATE_COOKIE, '', { path: '/', maxAge: 0 });
    res.cookies.set(ORG_COOKIE, '', { path: '/', maxAge: 0 });
    res.cookies.set(OPEN_BOOKS_COOKIE, '', { path: '/', maxAge: 0 });
    res.headers.set('X-RocketSuite-Request-Id', observation.requestId);
    return res;
  }

  return updateSession(request, {}, observation);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|svg|gif|webp|ico)$).*)'],
};
