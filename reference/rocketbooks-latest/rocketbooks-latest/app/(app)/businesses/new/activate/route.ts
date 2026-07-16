import { type NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { organizations, users } from '@/db/schema/schema';
import { requireSession } from '@/lib/auth/session';
import { getEffectiveUserId } from '@/lib/auth/impersonate';
import { stripe } from '@/lib/stripe/client';
import { handleSubscriptionUpsert } from '@/lib/stripe/handlers';
import { logger } from '@/lib/logger';

const ORG_COOKIE = 'rs_org_id';

/**
 * Stripe success_url lands here after the user pays $89/mo for a new
 * business. Swap the active org to the newly-paid-for one and forward
 * into /ai-chat?onboarding=start so the existing onboarding flow takes
 * over for naming + the rest. Implemented as a Route Handler (not a
 * page) because Next.js only allows cookies().set() inside Server
 * Actions or Route Handlers — page components can read cookies but not
 * write.
 *
 * We don't wait for the webhook: the org row already exists (created
 * pre-checkout) and the subscription row will be written by
 * handleSubscriptionUpsert when Stripe fires customer.subscription.created.
 * If the user reaches a write-gated action before that webhook lands,
 * the gate retries cleanly.
 *
 * We re-verify ownership against the URL param so a tampered ?org=
 * can't swap the user onto someone else's workspace.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  await requireSession();
  const userId = await getEffectiveUserId();
  const orgId = req.nextUrl.searchParams.get('org');
  if (!orgId) {
    return NextResponse.redirect(new URL('/dashboard', req.url));
  }

  const [row] = await db
    .select({ id: organizations.id, ownerUserId: organizations.ownerUserId })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  if (!row || row.ownerUserId !== userId) {
    return NextResponse.redirect(new URL('/dashboard', req.url));
  }

  await db
    .update(users)
    .set({ activeOrganizationId: row.id })
    .where(eq(users.id, userId));

  const cookieStore = await cookies();
  cookieStore.set(ORG_COOKIE, row.id, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 30,
  });

  // Reconcile the subscription inline rather than waiting on the webhook —
  // local dev typically doesn't have stripe listen running, and even in
  // prod the success redirect can beat the webhook. handleSubscriptionUpsert
  // is idempotent (onConflictDoUpdate on stripe_subscription_id), so a
  // later webhook firing for the same sub is a safe no-op.
  const sessionId = req.nextUrl.searchParams.get('session_id');
  if (sessionId) {
    try {
      const session = await stripe().checkout.sessions.retrieve(sessionId, { expand: ['subscription'] });
      const sub = typeof session.subscription === 'string'
        ? await stripe().subscriptions.retrieve(session.subscription)
        : session.subscription;
      if (sub) await handleSubscriptionUpsert(sub);
    } catch (err) {
      logger.warn(
        { orgId: row.id, sessionId, err: err instanceof Error ? err.message : String(err) },
        'inline subscription reconcile failed — webhook will fill in later',
      );
    }
  }

  logger.info({ orgId: row.id, userId }, 'new business activated post-checkout');
  return NextResponse.redirect(new URL('/ai-chat?onboarding=start', req.url));
}
