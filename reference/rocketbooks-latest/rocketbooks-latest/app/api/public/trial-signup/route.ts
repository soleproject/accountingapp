import { NextResponse, type NextRequest } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/db/client';
import { organizations } from '@/db/schema/schema';
import { createClient } from '@/lib/supabase/server';
import { coerceEntityType, performTrialSignup } from '@/lib/signup/perform-trial-signup';
import { createTrialSignupCheckoutSession } from '@/lib/stripe/checkout';
import { sendWelcomeEmail } from '@/lib/email/welcome-email';
import { resolveReferrerEnterprise, resolveUserFromReferralSlug } from '@/lib/referral/user-slug';
import { isAccountingTierKey } from '@/lib/accounting/tiers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const ALLOWED_ORIGINS = new Set<string>([
  'https://rocketbooks.ai',
  'https://www.rocketbooks.ai',
  'https://app.rocketbooks.ai',
  'https://rocketsuite.ai',
  'https://www.rocketsuite.ai',
  'https://app.rocketsuite.ai',
  'http://localhost:3000',
]);

const BodySchema = z.object({
  full_name: z.string().trim().min(1, 'Full name is required'),
  email: z.email().trim().toLowerCase(),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  company_name: z.string().trim().min(1, 'Company name is required'),
  business_type: z.string().trim().optional().nullable(),
  phone: z.string().trim().optional().nullable(),
  needs: z.string().trim().optional().nullable(),
  // Referral slug from the marketing site's ?ref=<slug> link. The form
  // submits an empty string when no ref is present, so blank is treated as
  // absent and we fall back to host-based attribution.
  ref: z.string().trim().toLowerCase().optional().nullable(),
  // Plan chosen on the marketing pricing page (starter|plus|pro). Validated
  // against the tier keys below; anything else is treated as "no plan".
  plan: z.string().trim().toLowerCase().optional().nullable(),
});

function corsHeaders(origin: string | null): Record<string, string> {
  const allowed = origin && ALLOWED_ORIGINS.has(origin) ? origin : '';
  if (!allowed) return { Vary: 'Origin' };
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Credentials': 'true',
    Vary: 'Origin',
  };
}

function appUrl(): string {
  return (process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
}

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, {
    status: 204,
    headers: corsHeaders(req.headers.get('origin')),
  });
}

export async function POST(req: NextRequest) {
  const origin = req.headers.get('origin');
  const cors = corsHeaders(origin);

  // Origin enforcement: reject requests from disallowed origins so the
  // endpoint isn't usable as a generic open signup oracle. We allow a
  // missing Origin (non-browser callers) but require an allowed value
  // when present.
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    return NextResponse.json({ ok: false, error: 'Origin not allowed' }, { status: 403, headers: cors });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON' }, { status: 400, headers: cors });
  }

  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        ok: false,
        error: 'Invalid input',
        fieldErrors: z.flattenError(parsed.error).fieldErrors,
      },
      { status: 400, headers: cors },
    );
  }
  const { full_name, email, password, company_name, business_type, phone, needs, ref, plan } = parsed.data;
  const accountingTier = isAccountingTierKey(plan) ? plan : null;

  // Referral slug wins (the partner Share-link path); custom-domain partners
  // fall back to host-based resolution. Mirrors the app /signup action.
  // Resolution order for ?ref=<slug>:
  //  1. org invite slug (enterprise/partner path) — unchanged.
  //  2. else a per-user referral slug → credit that user; the referred org
  //     attaches to the referrer's own enterprise (host-agnostic).
  //  3. else host-based enterprise resolution.
  const enterpriseFromRef = ref ? await resolveEnterpriseFromSlug(ref) : null;
  const referrer = ref && !enterpriseFromRef ? await resolveUserFromReferralSlug(ref) : null;
  const enterprise = enterpriseFromRef
    ?? (referrer ? await resolveReferrerEnterprise(referrer.id) : null)
    ?? (await resolveEnterpriseFromHost(req));
  if (!enterprise) {
    return NextResponse.json(
      { ok: false, error: 'Signup is not available on this domain' },
      { status: 400, headers: cors },
    );
  }

  const result = await performTrialSignup({
    fullName: full_name,
    email,
    password,
    companyName: company_name,
    enterpriseId: enterprise.id,
    referrerUserId: referrer?.id ?? null,
    phone: phone ?? null,
    businessType: coerceEntityType(business_type),
    businessDescription: needs ?? null,
    accountingTier,
    source: 'marketing_form',
  });
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: result.status, headers: cors });
  }

  // Fire-and-forget welcome email — sent before the auto sign-in so it goes
  // out even if the immediate sign-in fails. The user set their password on
  // the form, so the email's sign-in link works regardless. Never blocks
  // signup on Resend.
  void sendWelcomeEmail({
    to: email,
    fullName: full_name,
    companyName: company_name,
    appUrl: appUrl(),
    usage: { userId: result.userId, orgId: result.orgId, actor: 'system', feature: 'welcome-email' },
  }).catch((err) => {
    console.error('welcome email failed', err);
  });

  // Establish a session cookie on app.rocketbooks.ai. For a same-site
  // POST (rocketbooks.ai → app.rocketbooks.ai is same-site under the
  // shared eTLD+1) the browser accepts the cookie; the subsequent
  // top-level navigation to /dashboard sends it. If the browser rejects
  // the cookie for any reason, the user lands at /login and signs in
  // with the password they just chose — the marketing copy already
  // primes them for that fallback.
  const supabase = await createClient();
  const { error: signInErr } = await supabase.auth.signInWithPassword({ email, password });
  if (signInErr) {
    return NextResponse.json(
      { ok: true, redirectTo: `${appUrl()}/login?email=${encodeURIComponent(email)}` },
      { status: 200, headers: cors },
    );
  }

  // Plan chosen on the pricing page (?plan=) → straight to that plan's card form.
  // No plan (hero form) → the in-app /select-plan picker first, then checkout.
  // Fall back to the app if a chosen-plan checkout can't be built.
  let redirectTo = `${appUrl()}/select-plan`;
  if (accountingTier) {
    redirectTo = `${appUrl()}/dashboard`;
    try {
      redirectTo = await createTrialSignupCheckoutSession(result.orgId);
    } catch (e) {
      console.error('Trial signup checkout failed; redirecting to app', result.orgId, e);
    }
  }
  return NextResponse.json({ ok: true, redirectTo }, { status: 200, headers: cors });
}

// Resolve the referrer org from an invite slug. Any org can be a referrer
// (every user is a 20% affiliate), so this is NOT gated to planType
// 'enterprise' — the unique inviteSlug index still yields at most one row.
// Host-based resolution below stays enterprise-only (custom domains are an
// enterprise feature).
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

async function resolveEnterpriseFromHost(req: NextRequest): Promise<{ id: string; name: string } | null> {
  const rawHost = req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? '';
  const host = rawHost.split(':')[0]?.toLowerCase().trim();
  if (!host) return null;

  const candidates = [host];
  if (host.startsWith('app.')) candidates.push(host.slice(4));
  else if (host.startsWith('www.')) candidates.push(host.slice(4));
  if (candidates.includes('rocketsuite.ai')) candidates.push('rocketbooks.ai');

  for (const candidate of candidates) {
    const [row] = await db
      .select({ id: organizations.id, name: organizations.name })
      .from(organizations)
      .where(and(eq(organizations.planType, 'enterprise'), eq(organizations.domain, candidate)))
      .limit(1);
    if (row) return row;
  }
  return null;
}
