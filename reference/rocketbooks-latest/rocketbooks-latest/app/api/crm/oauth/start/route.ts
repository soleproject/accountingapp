import { randomUUID, randomBytes } from 'crypto';
import { redirect } from 'next/navigation';
import { db } from '@/db/client';
import { ghlOauthStates } from '@/db/schema/schema';
import { requireSession } from '@/lib/auth/session';
import { getCurrentOrgId } from '@/lib/auth/org';
import { isDemoOrg } from '@/lib/auth/demo';
import { GHL_OAUTH_AUTHORIZE_URL, GHL_OAUTH_SCOPE } from '@/lib/ghl/client';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const STATE_TTL_MS = 10 * 60 * 1000;

// Kicks off the GHL OAuth round-trip: mint a one-shot CSRF state tied to the
// current user+org, then redirect to GHL's location picker. Mirrors
// app/api/qbo/oauth/start. redirect() throws NEXT_REDIRECT, so every guard
// below intentionally redirects rather than returns.
export async function GET() {
  const user = await requireSession();
  const orgId = await getCurrentOrgId();
  if (isDemoOrg(orgId)) {
    redirect('/integrations/ghl?error=demo_workspace');
  }

  const clientId = process.env.GHL_CLIENT_ID;
  const redirectUri = process.env.GHL_REDIRECT_URI;
  if (!clientId || !redirectUri) {
    redirect('/integrations/ghl?error=not_configured');
  }

  const state = randomBytes(32).toString('base64url');
  const now = Date.now();
  await db.insert(ghlOauthStates).values({
    id: randomUUID(),
    state,
    userId: user.id,
    orgId,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + STATE_TTL_MS).toISOString(),
    returnContext: 'integrations_ghl',
  });

  const url = new URL(GHL_OAUTH_AUTHORIZE_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId!);
  url.searchParams.set('redirect_uri', redirectUri!);
  url.searchParams.set('scope', GHL_OAUTH_SCOPE);
  url.searchParams.set('state', state);
  redirect(url.toString());
}
