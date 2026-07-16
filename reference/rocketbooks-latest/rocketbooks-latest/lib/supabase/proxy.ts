import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { SUPABASE_AUTH_TIMEOUT_MS } from './auth-timeout';
import {
  attachObservationHeaders,
  edgeOutcome,
  emitEdgePerformanceEvent,
  type EdgeRequestObservation,
} from '@/lib/perf/request-observability-edge';

const PUBLIC_PATHS = [
  '/login', '/signup', '/forgot-password', '/reset',
  '/api/health', '/api/readiness', '/api/performance/beacon',
  '/api/plaid/webhook', '/api/stripe/webhook', '/api/qbo/webhook',
  '/api/twilio/inbound', '/api/twilio/status',
  '/api/crm/webhook', '/api/recorder/bot/webhook', '/api/inbox/ingest',
  '/api/email/inbound', '/api/inngest', '/api/video/join',
  '/api/video/transcript-webhook', '/api/digest/unsubscribe',
];

const PUBLIC_PATH_PREFIXES = ['/legal/', '/api/cron/', '/api/public/', '/book/', '/video/join/'];

async function boundedSupabaseFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const upstreamSignal = init?.signal;
  const timeout = setTimeout(() => controller.abort(), SUPABASE_AUTH_TIMEOUT_MS);
  const abortFromUpstream = () => controller.abort();
  if (upstreamSignal) {
    if (upstreamSignal.aborted) controller.abort();
    else upstreamSignal.addEventListener('abort', abortFromUpstream, { once: true });
  }
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
    if (upstreamSignal) upstreamSignal.removeEventListener('abort', abortFromUpstream);
  }
}

export function isPublicPath(path: string) {
  return PUBLIC_PATHS.includes(path) || PUBLIC_PATH_PREFIXES.some((prefix) => path.startsWith(prefix));
}

export type AuthSessionClient = {
  auth: {
    getClaims: () => Promise<{ data: { claims: { sub?: unknown } } | null; error?: unknown }>;
  };
};
type UpdateSessionDependencies = { createClient?: (response: NextResponse) => AuthSessionClient };

export async function updateSession(
  request: NextRequest,
  deps: UpdateSessionDependencies = {},
  observation?: EdgeRequestObservation,
) {
  const nextResponse = () => observation
    ? NextResponse.next({ request: { headers: observation.requestHeaders } })
    : NextResponse.next({ request });
  let response = nextResponse();
  const path = request.nextUrl.pathname;

  if (isPublicPath(path)) return observation ? attachObservationHeaders(response, observation) : response;

  const createClient = deps.createClient ?? (() => createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      global: { fetch: boundedSupabaseFetch },
      cookies: {
        getAll() { return request.cookies.getAll(); },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = nextResponse();
          cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        },
      },
    },
  ) as AuthSessionClient);
  const supabase = createClient(response);

  let verifiedSubject: unknown = null;
  let authError: unknown;
  const authStartedAt = performance.now();
  try {
    const result = await supabase.auth.getClaims();
    verifiedSubject = result.data?.claims?.sub ?? null;
  } catch (error) {
    authError = error;
  }
  const authDurationMs = performance.now() - authStartedAt;
  if (observation) {
    emitEdgePerformanceEvent(
      observation,
      'middleware_auth',
      authDurationMs,
      authError ? edgeOutcome(authError) : (verifiedSubject ? 'ok' : 'unauthenticated'),
    );
  }

  if (!verifiedSubject) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    url.searchParams.set('next', path);
    const redirect = NextResponse.redirect(url);
    return observation ? attachObservationHeaders(redirect, observation, authDurationMs) : redirect;
  }

  if (verifiedSubject && (path === '/login' || path === '/signup')) {
    const url = request.nextUrl.clone();
    url.pathname = '/dashboard';
    const redirect = NextResponse.redirect(url);
    return observation ? attachObservationHeaders(redirect, observation, authDurationMs) : redirect;
  }

  return observation ? attachObservationHeaders(response, observation, authDurationMs) : response;
}
