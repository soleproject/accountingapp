import { randomUUID, randomBytes } from 'crypto';
import { redirect } from 'next/navigation';
import { db } from '@/db/client';
import { qboOauthStates } from '@/db/schema/schema';
import { requireSession } from '@/lib/auth/session';
import { getCurrentOrgId } from '@/lib/auth/org';
import { isDemoOrg } from '@/lib/auth/demo';
import { QBO_OAUTH_AUTHORIZE_URL, QBO_OAUTH_SCOPE } from '@/lib/qbo/client';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const STATE_TTL_MS = 10 * 60 * 1000;

export async function GET() {
  const user = await requireSession();
  const orgId = await getCurrentOrgId();
  if (isDemoOrg(orgId)) {
    redirect('/integrations/qbo?error=demo_workspace');
  }

  const clientId = process.env.QBO_CLIENT_ID;
  const redirectUri = process.env.QBO_REDIRECT_URI;
  if (!clientId || !redirectUri) {
    redirect('/integrations/qbo?error=not_configured');
  }

  const state = randomBytes(32).toString('base64url');
  const now = Date.now();
  await db.insert(qboOauthStates).values({
    id: randomUUID(),
    state,
    userId: user.id,
    orgId,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + STATE_TTL_MS).toISOString(),
    returnContext: 'integrations_qbo',
  });

  const url = new URL(QBO_OAUTH_AUTHORIZE_URL);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('scope', QBO_OAUTH_SCOPE);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state', state);
  redirect(url.toString());
}
