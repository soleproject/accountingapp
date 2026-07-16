import { NextRequest } from 'next/server';
import { redirect } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { ghlOauthStates } from '@/db/schema/schema';
import { exchangeCodeForTokens, type GhlTokenResponse } from '@/lib/ghl/client';
import { saveConnection } from '@/lib/ghl/connection';
import { safeSend } from '@/lib/inngest';
import { logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// GHL redirects here after the user picks a location. We validate the
// one-shot CSRF state, exchange the code for tokens, persist the connection,
// and trigger the initial backfill. Mirrors app/api/qbo/oauth/callback.
//
// redirect() throws NEXT_REDIRECT, so it must stay OUT of try/catch —
// failures are captured as a flag and redirected on afterwards.
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const code = sp.get('code');
  const state = sp.get('state');
  const errorParam = sp.get('error');

  if (errorParam) {
    logger.warn({ error: errorParam, state }, 'ghl oauth callback returned error');
    redirect(`/integrations/ghl?error=${encodeURIComponent(errorParam)}`);
  }
  if (!code || !state) {
    redirect('/integrations/ghl?error=missing_params');
  }

  const redirectUri = process.env.GHL_REDIRECT_URI;
  if (!redirectUri) {
    redirect('/integrations/ghl?error=not_configured');
  }

  // Resolve + one-shot consume the state row.
  const [stateRow] = await db
    .select()
    .from(ghlOauthStates)
    .where(eq(ghlOauthStates.state, state!))
    .limit(1);
  if (!stateRow) {
    redirect('/integrations/ghl?error=bad_state');
  }
  if (new Date(stateRow!.expiresAt).getTime() < Date.now()) {
    await db.delete(ghlOauthStates).where(eq(ghlOauthStates.id, stateRow!.id));
    redirect('/integrations/ghl?error=state_expired');
  }
  const { userId, orgId } = stateRow!;
  if (!orgId) {
    await db.delete(ghlOauthStates).where(eq(ghlOauthStates.id, stateRow!.id));
    redirect('/integrations/ghl?error=no_org_in_state');
  }

  // Exchange + persist. Any failure → clean up state and bounce with an error.
  let connectionId: string | null = null;
  let failed = false;
  try {
    const tokens: GhlTokenResponse = await exchangeCodeForTokens({
      code: code!,
      redirectUri: redirectUri!,
    });
    connectionId = await saveConnection({ userId, organizationId: orgId!, tokens });
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err), orgId },
      'ghl token exchange / save failed',
    );
    failed = true;
  }
  if (failed || !connectionId) {
    await db.delete(ghlOauthStates).where(eq(ghlOauthStates.id, stateRow!.id));
    redirect('/integrations/ghl?error=token_exchange_failed');
  }

  await db.delete(ghlOauthStates).where(eq(ghlOauthStates.id, stateRow!.id));
  logger.info({ orgId, connectionId }, 'ghl connection established');

  // Kick off the historical backfill. safeSend swallows queue outages so the
  // user lands on the connected page regardless; they can re-trigger a sync
  // from the connection page if Inngest was down. (Handler: server/jobs/ghl-sync.)
  await safeSend({
    name: 'ghl/sync.requested',
    data: { connectionId: connectionId!, trigger: 'oauth_connect' },
  });

  redirect('/integrations/ghl?connected=1');
}
