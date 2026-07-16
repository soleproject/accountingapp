import { randomUUID } from 'crypto';
import { NextRequest } from 'next/server';
import { redirect } from 'next/navigation';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { qboConnections, qboOauthStates } from '@/db/schema/schema';
import { safeSend } from '@/lib/inngest';
import { logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const QBO_TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  x_refresh_token_expires_in: number;
  token_type: 'bearer';
}

function basicAuthHeader(): string {
  const id = process.env.QBO_CLIENT_ID ?? '';
  const secret = process.env.QBO_CLIENT_SECRET ?? '';
  return `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`;
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const code = sp.get('code');
  const state = sp.get('state');
  const realmId = sp.get('realmId');
  const errorParam = sp.get('error');

  if (errorParam) {
    logger.warn({ error: errorParam, state }, 'qbo oauth callback returned error');
    redirect(`/integrations/qbo?error=${encodeURIComponent(errorParam)}`);
  }
  if (!code || !state || !realmId) {
    redirect('/integrations/qbo?error=missing_params');
  }

  const redirectUri = process.env.QBO_REDIRECT_URI;
  const clientId = process.env.QBO_CLIENT_ID;
  const clientSecret = process.env.QBO_CLIENT_SECRET;
  if (!redirectUri || !clientId || !clientSecret) {
    redirect('/integrations/qbo?error=not_configured');
  }

  // Resolve and consume the state row. Treat use as one-shot — delete on
  // both success and failure paths so a leaked code can't be replayed.
  const [stateRow] = await db
    .select()
    .from(qboOauthStates)
    .where(eq(qboOauthStates.state, state!))
    .limit(1);
  if (!stateRow) {
    redirect('/integrations/qbo?error=bad_state');
  }
  if (new Date(stateRow!.expiresAt).getTime() < Date.now()) {
    await db.delete(qboOauthStates).where(eq(qboOauthStates.id, stateRow!.id));
    redirect('/integrations/qbo?error=state_expired');
  }
  const { userId, orgId } = stateRow!;
  if (!orgId) {
    await db.delete(qboOauthStates).where(eq(qboOauthStates.id, stateRow!.id));
    redirect('/integrations/qbo?error=no_org_in_state');
  }

  // Exchange the authorization code for tokens. redirect() throws
  // NEXT_REDIRECT so it must live outside try/catch — otherwise the catch
  // swallows the redirect signal. Capture failure as a flag instead.
  let tokens: TokenResponse | null = null;
  let exchangeFailed = false;
  try {
    const res = await fetch(QBO_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Authorization': basicAuthHeader(),
        'Accept': 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code!,
        redirect_uri: redirectUri!,
      }).toString(),
    });
    const body = await res.text();
    if (!res.ok) {
      logger.error({ status: res.status, body, orgId, intuitTid: res.headers.get('intuit_tid') }, 'qbo token exchange failed');
      exchangeFailed = true;
    } else {
      tokens = JSON.parse(body) as TokenResponse;
    }
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err), orgId }, 'qbo token exchange threw');
    exchangeFailed = true;
  }
  if (exchangeFailed || !tokens) {
    await db.delete(qboOauthStates).where(eq(qboOauthStates.id, stateRow!.id));
    redirect('/integrations/qbo?error=token_exchange_failed');
  }

  const now = Date.now();
  const accessExpiresAt = new Date(now + tokens.expires_in * 1000).toISOString();
  const refreshExpiresAt = new Date(now + tokens.x_refresh_token_expires_in * 1000).toISOString();

  // A user reconnecting to the same realm should get the new tokens, not a
  // duplicate row. There is no unique constraint on (orgId, realmId) yet,
  // so do an explicit delete-then-insert under a single connection.
  await db.transaction(async (tx) => {
    await tx
      .delete(qboConnections)
      .where(and(eq(qboConnections.orgId, orgId!), eq(qboConnections.realmId, realmId!)));
    await tx.insert(qboConnections).values({
      id: randomUUID(),
      userId,
      orgId,
      realmId: realmId!,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      accessTokenExpiresAt: accessExpiresAt,
      refreshTokenExpiresAt: refreshExpiresAt,
    });
    await tx.delete(qboOauthStates).where(eq(qboOauthStates.id, stateRow!.id));
  });

  logger.info({ orgId, realmId }, 'qbo connection established');

  // Kick off the historical migration. safeSend swallows queue outages so
  // the user lands on the connected page either way; if Inngest is down,
  // they can re-trigger from the "Start migration" button on the QBO page.
  // Branch on the result: a swallowed send failure must NOT masquerade as a
  // clean connect, or the user sits on a green screen while nothing imports
  // (which is exactly how Bob McKay's migration silently never ran).
  const queued = await safeSend({
    name: 'qbo/migration.requested',
    data: { organizationId: orgId!, realmId: realmId!, userId },
  });
  if (!queued) {
    logger.error(
      { orgId, realmId },
      'qbo connection saved but migration event failed to queue; user can retry from the QBO page',
    );
  }

  redirect(queued ? '/integrations/qbo?connected=1' : '/integrations/qbo?connected=1&import=not_queued');
}
