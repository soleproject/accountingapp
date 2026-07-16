import 'server-only';
import { cache } from 'react';
import { headers } from 'next/headers';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { organizations } from '@/db/schema/schema';
import { PRIVATE_LABEL_ROOT, PRIMARY_HOST, subdomainFromHost } from '@/lib/enterprise/subdomain';
import { themeCssVars } from '@/lib/enterprise/theme';

/**
 * Brand to render on UNAUTHENTICATED surfaces (the login/signup/reset gate),
 * resolved purely from the request host — no session required. Mirrors the
 * EnterpriseBranding field set so the gate themes exactly like the in-app shell.
 */
export interface HostBrand {
  enterpriseId: string | null;
  name: string;
  logoUrl: string | null;
  logoUrlDark: string | null;
  logoIconUrl: string | null;
  poweredByEnabled: boolean;
  poweredByText: string | null;
  privateLabelEnabled: boolean;
  brandColorHex: string | null;
  themeConfig: Record<string, string> | null;
  /** Platform image to show when no firm logo applies (null → text wordmark). */
  platformLogo: string | null;
}

const ROCKETBOOKS: HostBrand = {
  enterpriseId: null, name: 'RocketBooks',
  logoUrl: null, logoUrlDark: null, logoIconUrl: null,
  poweredByEnabled: false, poweredByText: null,
  privateLabelEnabled: false, brandColorHex: null, themeConfig: null,
  platformLogo: '/rocketbooks-logo.png',
};

// Bare accountingapp.ai / unknown subdomain → neutral, never RocketBooks.
const NEUTRAL: HostBrand = {
  enterpriseId: null, name: 'AccountingApp',
  logoUrl: null, logoUrlDark: null, logoIconUrl: null,
  poweredByEnabled: false, poweredByText: null,
  privateLabelEnabled: false, brandColorHex: null, themeConfig: null,
  platformLogo: null,
};

const FIELDS = {
  id: organizations.id,
  name: organizations.name,
  logoUrl: organizations.logoUrl,
  logoUrlDark: organizations.logoUrlDark,
  logoIconUrl: organizations.logoIconUrl,
  poweredByEnabled: organizations.poweredByEnabled,
  poweredByText: organizations.poweredByText,
  privateLabelEnabled: organizations.privateLabelEnabled,
  brandColorHex: organizations.brandColorHex,
  themeConfig: organizations.themeConfig,
} as const;

function toBrand(row: NonNullable<Awaited<ReturnType<typeof loadBy>>>): HostBrand {
  return {
    enterpriseId: row.id,
    name: row.name,
    logoUrl: row.logoUrl ?? null,
    logoUrlDark: row.logoUrlDark ?? null,
    logoIconUrl: row.logoIconUrl ?? null,
    poweredByEnabled: row.poweredByEnabled ?? false,
    poweredByText: row.poweredByText ?? null,
    privateLabelEnabled: row.privateLabelEnabled ?? false,
    brandColorHex: row.brandColorHex ?? null,
    themeConfig: (row.themeConfig as Record<string, string> | null) ?? null,
    platformLogo: null,
  };
}

async function loadBy(where: ReturnType<typeof eq>) {
  const [row] = await db
    .select(FIELDS)
    .from(organizations)
    .where(and(eq(organizations.planType, 'enterprise'), where))
    .limit(1);
  return row;
}

/**
 * Resolve the gate brand from the request host:
 *  1. <label>.accountingapp.ai → enterprise with that subdomain (else neutral)
 *  2. host == organizations.domain → that enterprise (future BYO custom domains)
 *  3. bare accountingapp.ai / unknown → neutral; everything else → RocketBooks
 */
export const resolveHostBrand = cache(async (): Promise<HostBrand> => {
  const h = await headers();
  const host = (h.get('x-forwarded-host') ?? h.get('host') ?? '').split(':')[0]?.toLowerCase().trim() ?? '';
  if (!host) return ROCKETBOOKS;

  // First-party RocketSuite/RocketBooks hosts are not white-label domains and
  // must not depend on a database lookup before auth. When the DB connection is
  // stale, making /login?next=... wait on branding can hang the Worker before a
  // user can sign in or recover.
  if (host === PRIMARY_HOST || host === 'app.rocketsuite.ai' || host === 'rocketsuite.ai' || host === 'rocketbooks.ai') {
    return ROCKETBOOKS;
  }

  const label = subdomainFromHost(host);
  if (label) {
    const row = await loadBy(eq(organizations.subdomain, label));
    return row ? toBrand(row) : NEUTRAL;
  }

  const candidates = [host];
  if (host.startsWith('app.')) candidates.push(host.slice(4));
  else if (host.startsWith('www.')) candidates.push(host.slice(4));
  for (const c of candidates) {
    const row = await loadBy(eq(organizations.domain, c));
    if (row) return toBrand(row);
  }

  if (host === PRIVATE_LABEL_ROOT || host.endsWith(`.${PRIVATE_LABEL_ROOT}`)) return NEUTRAL;
  return ROCKETBOOKS;
});

/**
 * CSS variables (`--th-*`) for the gate wrapper — only when the firm is
 * private-label. Mirrors app/(app)/layout.tsx: the brand color drives the
 * accent tokens, then Theme Studio overrides layer on top.
 */
export function hostBrandThemeVars(brand: HostBrand): Record<string, string> {
  if (!brand.privateLabelEnabled) return {};
  const accent = brand.brandColorHex;
  const effective = {
    ...(accent ? { accentBtn: accent, accentLink: accent, accentCheckbox: accent, accentRing: accent } : {}),
    ...(brand.themeConfig ?? {}),
  };
  return themeCssVars(effective);
}
