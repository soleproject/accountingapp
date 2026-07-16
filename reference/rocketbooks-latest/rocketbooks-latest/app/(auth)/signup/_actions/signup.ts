'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/db/client';
import { organizations } from '@/db/schema/schema';
import { createClient } from '@/lib/supabase/server';
import { performTrialSignup } from '@/lib/signup/perform-trial-signup';
import { createTrialSignupCheckoutSession } from '@/lib/stripe/checkout';
import { isAccountingTierKey } from '@/lib/accounting/tiers';

export type SignupState =
  | { error: string; fieldErrors?: Record<string, string[]> }
  | undefined;

const SignupSchema = z.object({
  fullName: z.string().trim().min(1, 'Full name is required'),
  email: z.email().trim().toLowerCase(),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  companyName: z.string().trim().min(1, 'Company name is required'),
  enterpriseId: z.string().trim().min(1),
  inviteSlug: z.string().trim().toLowerCase().optional(),
  // Self-serve plan picked on the marketing pricing page (/signup?plan=…).
  // Free-form here; validated against the tier keys below.
  plan: z.string().trim().toLowerCase().optional(),
});

/**
 * Public self-serve trial signup. The visitor lands on /signup at an
 * enterprise's domain (e.g. app.rocketbooks.ai); the page resolves that
 * host to organizations.domain and passes the enterprise id into the form.
 * Here we re-resolve from the request host to make sure the hidden field
 * wasn't swapped out — never trust the client-submitted enterpriseId on
 * its own.
 *
 * The new user becomes a paying_user attached as a client of that
 * enterprise, with a fresh "pro" org and a synthetic 7-day trialing
 * subscription on the demo_full product (same shape the enterprise-creates-
 * client demo flow uses, so entitlement checks already understand it).
 */
export async function trialSignup(_prev: SignupState, formData: FormData): Promise<SignupState> {
  const parsed = SignupSchema.safeParse({
    fullName: formData.get('fullName'),
    email: formData.get('email'),
    password: formData.get('password'),
    companyName: formData.get('companyName'),
    enterpriseId: formData.get('enterpriseId'),
    inviteSlug: formData.get('inviteSlug') ?? undefined,
    plan: formData.get('plan') ?? undefined,
  });
  if (!parsed.success) {
    return {
      error: 'Invalid input',
      fieldErrors: z.flattenError(parsed.error).fieldErrors as Record<string, string[]>,
    };
  }
  const { fullName, email, password, companyName, enterpriseId, inviteSlug, plan } = parsed.data;
  const accountingTier = isAccountingTierKey(plan) ? plan : null;

  // Re-verify the enterprise server-side to defeat a tampered hidden field.
  // Slug-attributed signups (the partner Share link path) are the priority:
  // when a slug is submitted it must resolve and match the enterpriseId.
  // Fallback for custom-domain partners: re-resolve from the request Host.
  // Never trust enterpriseId on its own.
  const resolved = inviteSlug
    ? await resolveEnterpriseFromSlug(inviteSlug)
    : await resolveEnterpriseFromHost();
  if (!resolved || resolved.id !== enterpriseId) {
    return {
      error: inviteSlug
        ? 'This invite link is no longer valid'
        : 'Signup is not available on this domain',
    };
  }

  const result = await performTrialSignup({
    fullName,
    email,
    password,
    companyName,
    enterpriseId,
    accountingTier,
    source: 'app_signup',
  });
  if (!result.ok) return { error: result.error };

  // Establish a session for the just-created user. Without this they'd be
  // bounced to /login by middleware on the redirect below.
  const supabase = await createClient();
  const { error: signInErr } = await supabase.auth.signInWithPassword({ email, password });
  if (signInErr) {
    return { error: `Account created, but sign-in failed: ${signInErr.message}. Try logging in.` };
  }

  // Plan chosen on the pricing page (?plan=) → straight to that plan's card form.
  // No plan (hero form) → the in-app /select-plan picker first, then checkout.
  if (!accountingTier) {
    redirect('/select-plan');
  }
  let checkoutUrl: string | null = null;
  try {
    checkoutUrl = await createTrialSignupCheckoutSession(result.orgId);
  } catch (e) {
    console.error('Trial signup checkout failed; landing in app', result.orgId, e);
  }
  redirect(checkoutUrl ?? '/dashboard');
}

// Any org can be a referrer (every user is a 20% affiliate), so resolution
// by slug is NOT gated to planType 'enterprise'. The unique inviteSlug index
// guarantees at most one match. The tamper check at the call site still
// requires the resolved id to match the submitted enterpriseId.
async function resolveEnterpriseFromSlug(slug: string): Promise<{ id: string; name: string } | null> {
  const cleaned = slug.trim().toLowerCase();
  if (!cleaned) return null;
  const [row] = await db
    .select({ id: organizations.id, name: organizations.name })
    .from(organizations)
    .where(eq(organizations.inviteSlug, cleaned))
    .limit(1);
  return row ?? null;
}

async function resolveEnterpriseFromHost(): Promise<{ id: string; name: string } | null> {
  const h = await headers();
  const rawHost = h.get('x-forwarded-host') ?? h.get('host') ?? '';
  const host = rawHost.split(':')[0]?.toLowerCase().trim();
  if (!host) return null;

  const candidates = [host];
  if (host.startsWith('app.')) candidates.push(host.slice(4));
  else if (host.startsWith('www.')) candidates.push(host.slice(4));

  for (const candidate of candidates) {
    const [row] = await db
      .select({ id: organizations.id, name: organizations.name })
      .from(organizations)
      .where(
        and(eq(organizations.planType, 'enterprise'), eq(organizations.domain, candidate)),
      )
      .limit(1);
    if (row) return row;
  }
  return null;
}
