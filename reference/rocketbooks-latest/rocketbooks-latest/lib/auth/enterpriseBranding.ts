import 'server-only';
import { cache } from 'react';
import { cookies } from 'next/headers';
import { and, eq, or, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { organizations } from '@/db/schema/schema';
import { requireSession } from './session';
import { getEffectiveUserId } from './impersonate';
import { ACTIVE_ENTERPRISE_COOKIE } from './enterprise';
import { DEMO_ENTERPRISE_ID, DEMO_ENTERPRISE_NAME } from '@/lib/enterprise/demo';

export interface EnterpriseBranding {
  enterpriseId: string;
  name: string;
  logoUrl: string | null;
  /** Theme/collapse-aware variants. Null → fall back to logoUrl, then default. */
  logoUrlDark: string | null;
  logoIconUrl: string | null;
  logoIconDarkUrl: string | null;
  poweredByEnabled: boolean;
  poweredByText: string | null;
  /** White-label gate — only apply firm branding/theming when true. */
  privateLabelEnabled: boolean;
  /** Captured in enterprise onboarding; applied to the app theme + AI identity. */
  brandColorHex: string | null;
  aiAssistantName: string | null;
  /** Theme Studio token overrides (token key → hex). */
  themeConfig: Record<string, string> | null;
}

/** The virtual demo enterprise's branding (no DB row) — themes the whole app
 *  when a user has switched their active enterprise to the demo. */
const DEMO_BRANDING: EnterpriseBranding = {
  enterpriseId: DEMO_ENTERPRISE_ID,
  name: DEMO_ENTERPRISE_NAME,
  logoUrl: null,
  logoUrlDark: null,
  logoIconUrl: null,
  logoIconDarkUrl: null,
  poweredByEnabled: true,
  poweredByText: null,
  privateLabelEnabled: true,
  brandColorHex: '#7c3aed',
  aiAssistantName: 'Scotty',
  themeConfig: { sidebarIcon: '#7c3aed', sidebarActiveBg: '#ede9fe', sidebarActiveText: '#5b21b6' },
};

const BRANDING_FIELDS = {
  id: organizations.id,
  name: organizations.name,
  logoUrl: organizations.logoUrl,
  logoUrlDark: organizations.logoUrlDark,
  logoIconUrl: organizations.logoIconUrl,
  logoIconDarkUrl: organizations.logoIconDarkUrl,
  poweredByEnabled: organizations.poweredByEnabled,
  poweredByText: organizations.poweredByText,
  privateLabelEnabled: organizations.privateLabelEnabled,
  brandColorHex: organizations.brandColorHex,
  aiAssistantName: organizations.aiAssistantName,
  themeConfig: organizations.themeConfig,
} as const;

/**
 * Resolve the enterprise branding/theme that applies to the current user,
 * across BOTH the enterprise area and the accounting app. Returns null when the
 * user isn't connected to an enterprise.
 *
 * Resolution:
 *   1. If the user has switched their active enterprise (cookie), use THAT
 *      enterprise — so the theme follows them everywhere (incl. the virtual
 *      Demo Enterprise). Owner/staff/client access is verified.
 *   2. Otherwise the most relevant enterprise by relationship: staff > client
 *      > owner. Reads the effective user so impersonation surfaces the target's
 *      branding.
 */
export const getEnterpriseBranding = cache(async (): Promise<EnterpriseBranding | null> => {
  await requireSession();
  const userId = await getEffectiveUserId();

  const cookieStore = await cookies();
  const active = cookieStore.get(ACTIVE_ENTERPRISE_COOKIE)?.value;
  if (active === DEMO_ENTERPRISE_ID) return DEMO_BRANDING;

  // User's relationship to an enterprise (staff > client > owner).
  const accessCond = or(
    sql`${organizations.id} in (select enterprise_id from enterprise_staff where staff_user_id = ${userId} and archived_at is null)`,
    sql`${organizations.id} in (select enterprise_id from enterprise_clients where client_user_id = ${userId})`,
    sql`${organizations.ownerUserId} = ${userId} and ${organizations.planType} = 'enterprise'`,
  );

  // Prefer the cookie-selected enterprise (if the user can access it), so the
  // theme follows the active enterprise into the accounting app.
  let row = active ? await loadOne(and(eq(organizations.id, active), accessCond)) : undefined;
  if (!row) row = await loadOne(accessCond);
  if (!row) return null;

  return {
    enterpriseId: row.id,
    name: row.name,
    logoUrl: row.logoUrl ?? null,
    logoUrlDark: row.logoUrlDark ?? null,
    logoIconUrl: row.logoIconUrl ?? null,
    logoIconDarkUrl: row.logoIconDarkUrl ?? null,
    poweredByEnabled: row.poweredByEnabled ?? true,
    poweredByText: row.poweredByText ?? null,
    privateLabelEnabled: row.privateLabelEnabled ?? false,
    brandColorHex: row.brandColorHex ?? null,
    aiAssistantName: row.aiAssistantName ?? null,
    themeConfig: (row.themeConfig as Record<string, string> | null) ?? null,
  };
});

async function loadOne(where: ReturnType<typeof and> | ReturnType<typeof or>) {
  const [row] = await db.select(BRANDING_FIELDS).from(organizations).where(where).limit(1);
  return row;
}
