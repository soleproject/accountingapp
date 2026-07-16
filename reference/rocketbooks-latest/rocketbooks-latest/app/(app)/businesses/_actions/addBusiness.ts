'use server';

import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { organizations, users } from '@/db/schema/schema';
import { requireSession } from '@/lib/auth/session';
import { getEffectiveUserId } from '@/lib/auth/impersonate';
import { createFreshOrganization } from '@/lib/accounting/create-organization';
import { findEmptyPlaceholderOrg } from '@/lib/accounting/prune-placeholders';
import { logger } from '@/lib/logger';

const ORG_COOKIE = 'rs_org_id';

export interface AddBusinessState {
  ok?: boolean;
  error?: string;
  redirectTo?: string;
}

/**
 * Creates a brand new "My Business" org owned by the current user and
 * routes them into the onboarding flow. For paying users who already
 * own one or more orgs, this is a pay-first flow: the org row is created
 * immediately (placeholder name), then the user is redirected to Stripe
 * Checkout for the $89/mo base subscription. On success they land on
 * /businesses/new/activate which swaps the active org and forwards to
 * /ai-chat?onboarding=start — same onboarding path as the free flow.
 *
 * The free path (no Stripe Checkout) only runs when the user has NO
 * owned pro orgs yet — that's the demo-sandbox → first-real-workspace
 * path, plus the auto-replace path after deleting the last business.
 * Roles other than paying_user (super admin, enterprise staff during
 * impersonation, etc.) also keep the free path; they're not the audience
 * for the per-org billing gate.
 *
 * During impersonation, "current user" means the impersonated target -- the
 * admin acting as a Paying User needs the new workspace owned by THAT user
 * (and their activeOrganizationId updated), otherwise the workspace ends up
 * on the admin's account and the impersonated session stays on the demo.
 * Hence getEffectiveUserId, matching the convention in lib/auth/impersonate.
 */
export async function addBusinessAction(): Promise<AddBusinessState> {
  await requireSession();
  const ownerUserId = await getEffectiveUserId();

  // Paying users are gated to one trial org + paid subs on every
  // additional org. Other roles bypass the gate.
  const [profile] = await db
    .select({ role: users.role })
    .from(users)
    .where(eq(users.id, ownerUserId))
    .limit(1);
  const isPayingUser = profile?.role === 'paying_user';

  // Count how many "business" orgs the user already owns. planType='pro'
  // is the user-facing workspace tier; enterprise-tier orgs are partner
  // workspaces and shouldn't count toward the gate.
  const [{ n: ownedCount } = { n: 0 }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(organizations)
    .where(and(eq(organizations.ownerUserId, ownerUserId), eq(organizations.planType, 'pro')));

  const needsPayment = isPayingUser && ownedCount >= 1;

  try {
    // On the free path, reuse an existing empty "My Business" placeholder
    // instead of stacking another one — repeated "Add business" clicks were a
    // main source of leftover shells. The paid path always mints a new org so
    // the per-org subscription maps cleanly (canceled checkout cleans it up).
    const reusable = needsPayment ? null : await findEmptyPlaceholderOrg(ownerUserId);
    const fresh = reusable ?? (await createFreshOrganization({ ownerUserId }));

    if (needsPayment) {
      // Route to the plan picker for the NEW company: pick a plan → immediate
      // checkout for it (no trial — additional companies are paid for right away).
      // Don't switch the active org yet; the user keeps seeing their current
      // workspace until payment succeeds (activate swaps it, the canceled page
      // cleans up the placeholder if they bail).
      logger.info({ orgId: fresh.id, ownerUserId }, 'new business pending plan + payment');
      return { ok: true, redirectTo: `/select-plan?org=${encodeURIComponent(fresh.id)}&add=1` };
    }

    await db
      .update(users)
      .set({ activeOrganizationId: fresh.id })
      .where(eq(users.id, ownerUserId));

    const cookieStore = await cookies();
    cookieStore.set(ORG_COOKIE, fresh.id, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 24 * 30,
    });

    logger.info({ orgId: fresh.id, ownerUserId }, 'fresh business created from org switcher');
    revalidatePath('/businesses');
    revalidatePath('/ai-chat');
    return { ok: true, redirectTo: '/ai-chat?onboarding=start' };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Could not create business' };
  }
}
