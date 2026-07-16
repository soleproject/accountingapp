import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { organizations } from '@/db/schema/schema';
import { SignupForm } from './_components/SignupForm';
import { LegalFooter } from '@/components/legal/LegalFooter';
import { subdomainFromHost } from '@/lib/enterprise/subdomain';
import { isAccountingTierKey, maybeGetAccountingTier } from '@/lib/accounting/tiers';

export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: Promise<{ ref?: string; plan?: string }>;
}

export default async function SignupPage({ searchParams }: PageProps) {
  const { ref, plan } = await searchParams;
  // Plan deep-linked from the marketing pricing page (/signup?plan=plus). The
  // signup action re-validates; the page just carries it + shows the chosen plan.
  const planKey = isAccountingTierKey(plan) ? plan : null;
  const tier = planKey ? maybeGetAccountingTier(planKey) : null;
  // Slug attribution takes priority over host attribution: a partner who
  // hands out https://app.example.com/signup?ref=abcd1234 wants the
  // signup attached to the abcd1234 enterprise even if the host happens
  // to map to a different one. Host fallback covers custom-domain
  // partners who don't bother with ref links.
  const enterprise = (ref ? await resolveEnterpriseFromSlug(ref) : null)
    ?? (await resolveEnterpriseFromHost());
  if (!enterprise) notFound();

  return (
    <>
      <header className="flex flex-col gap-1 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">{enterprise.name}</h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          {tier
            ? `Start your free 7-day trial on the ${tier.label} plan (${tier.shortLabel})`
            : 'Start your free 7-day trial'}
        </p>
      </header>
      <SignupForm
        enterpriseId={enterprise.id}
        inviteSlug={enterprise.inviteSlug ?? null}
        plan={planKey}
      />
      <LegalFooter agreementVerb="signing up" />
    </>
  );
}

interface ResolvedEnterprise {
  id: string;
  name: string;
  inviteSlug: string | null;
}

/**
 * Resolve the referrer org from the ?ref=<slug> query param. The slug is
 * the value handed out on the Share page; the trial action re-verifies it
 * server-side so a tampered hidden field can't impersonate a different
 * referrer. Any org can be a referrer (every user is a 20% affiliate), so
 * this is NOT gated to planType 'enterprise'; the unique inviteSlug index
 * guarantees at most one match. Returns null when the slug doesn't match —
 * caller falls back to host resolution before 404-ing.
 */
async function resolveEnterpriseFromSlug(slug: string): Promise<ResolvedEnterprise | null> {
  const cleaned = slug.trim().toLowerCase();
  if (!cleaned) return null;
  const [row] = await db
    .select({
      id: organizations.id,
      name: organizations.name,
      inviteSlug: organizations.inviteSlug,
    })
    .from(organizations)
    .where(eq(organizations.inviteSlug, cleaned))
    .limit(1);
  return row ?? null;
}

/**
 * Resolve which enterprise the visitor is signing up under by matching the
 * incoming Host header against organizations.domain. Strips a leading
 * `app.` or `www.` so app.rocketbooks.ai and rocketbooks.ai both resolve to
 * the org with domain=rocketbooks.ai. Returns null when no enterprise
 * claims this host, which the caller turns into a 404 — we don't want this
 * route to render generic copy when it isn't reachable via a configured
 * enterprise domain.
 */
async function resolveEnterpriseFromHost(): Promise<ResolvedEnterprise | null> {
  const h = await headers();
  const rawHost = h.get('x-forwarded-host') ?? h.get('host') ?? '';
  const host = rawHost.split(':')[0]?.toLowerCase().trim();
  if (!host) return null;

  const fields = {
    id: organizations.id,
    name: organizations.name,
    inviteSlug: organizations.inviteSlug,
  };

  // White-label subdomain (acme.accountingapp.ai → subdomain='acme').
  const label = subdomainFromHost(host);
  if (label) {
    const [row] = await db
      .select(fields)
      .from(organizations)
      .where(and(eq(organizations.planType, 'enterprise'), eq(organizations.subdomain, label)))
      .limit(1);
    if (row) return row;
  }

  // Custom domain (app./www. stripped).
  const candidates = [host];
  if (host.startsWith('app.')) candidates.push(host.slice(4));
  else if (host.startsWith('www.')) candidates.push(host.slice(4));
  if (candidates.includes('rocketsuite.ai')) candidates.push('rocketbooks.ai');

  for (const candidate of candidates) {
    const [row] = await db
      .select(fields)
      .from(organizations)
      .where(and(eq(organizations.planType, 'enterprise'), eq(organizations.domain, candidate)))
      .limit(1);
    if (row) return row;
  }
  return null;
}
