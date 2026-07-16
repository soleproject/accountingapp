import 'server-only';

import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { currentRequestPerformanceContext, observeServerPhase } from '@/lib/perf/request-observability';
import { getRequestScopedPromise } from '@/lib/auth/request-dedupe';

/**
 * Load the authenticated user once. The public wrapper below deduplicates this
 * promise by middleware-generated request ID across server module instances.
 */
async function loadSession() {
  return observeServerPhase('page_session_validation', async () => {
    const supabase = await createClient();
    const { data: { user } } = await observeServerPhase('supabase_auth', () => supabase.auth.getUser());

    if (!user) {
      redirect('/login');
    }

    return user;
  });
}

export async function requireSession() {
  const context = await currentRequestPerformanceContext();
  return getRequestScopedPromise(context?.requestId, 'session', loadSession);
}

/** Alias retained for callers that only need the current authenticated user. */
export const getSession = requireSession;
