import { createBrowserClient } from '@supabase/ssr';
import { SUPABASE_AUTH_TIMEOUT_MS } from './auth-timeout';

async function boundedBrowserFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const upstreamSignal = init?.signal;
  const timeout = window.setTimeout(() => controller.abort(), SUPABASE_AUTH_TIMEOUT_MS);
  const abortFromUpstream = () => controller.abort();
  if (upstreamSignal) {
    if (upstreamSignal.aborted) controller.abort();
    else upstreamSignal.addEventListener('abort', abortFromUpstream, { once: true });
  }
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    window.clearTimeout(timeout);
    if (upstreamSignal) upstreamSignal.removeEventListener('abort', abortFromUpstream);
  }
}

export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { global: { fetch: boundedBrowserFetch } },
  );
}
