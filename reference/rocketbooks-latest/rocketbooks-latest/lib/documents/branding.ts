import 'server-only';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { organizations } from '@/db/schema/schema';
import type { DocBranding } from './layout';

/**
 * Loads the branding used to dress up generated documents (the Task/Create
 * workspace canvas) with a letterhead. Pulled from the org profile so there's
 * no new config surface — everything here already lives on the organizations
 * row. The DocBranding shape + pure helpers live in ./layout (client-safe).
 */

const ENTITY_LABEL: Record<string, string> = {
  llc: 'LLC',
  c_corp: 'C-Corporation',
  s_corp: 'S-Corporation',
  partnership: 'Partnership',
  sole_prop: 'Sole Proprietorship',
  beneficial_trust: 'Trust',
  business_trust: 'Business Trust',
  nonprofit: 'Nonprofit',
  other: null as unknown as string,
};

/** Flatten the org's address jsonb (line1/line2/city/state/postal[Code]) into
 *  display lines. Tolerant of the key variations seen across the codebase. */
function formatAddressLines(raw: unknown): string[] {
  if (!raw || typeof raw !== 'object') return [];
  const a = raw as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : '');
  const line1 = str(a.line1) || str(a.street) || str(a.address1);
  const line2 = str(a.line2) || str(a.suite) || str(a.unit);
  const city = str(a.city);
  const state = str(a.state) || str(a.region);
  const postal = str(a.postal) || str(a.postalCode) || str(a.zip);
  const cityLine = [city, [state, postal].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  return [line1, line2, cityLine].filter(Boolean);
}

export async function getOrgBranding(orgId: string): Promise<DocBranding> {
  const [org] = await db
    .select({
      name: organizations.name,
      logoUrl: organizations.logoUrl,
      address: organizations.address,
      phone: organizations.phone,
      email: organizations.email,
      website: organizations.website,
      entityType: organizations.entityType,
      signatoryName: organizations.letterheadSignatoryName,
      signatoryTitle: organizations.letterheadSignatoryTitle,
      letterheadEnabled: organizations.letterheadEnabled,
    })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);

  return {
    orgName: org?.name ?? '',
    logoUrl: org?.logoUrl ?? null,
    addressLines: formatAddressLines(org?.address),
    phone: org?.phone ?? null,
    email: org?.email ?? null,
    website: org?.website ?? null,
    entityLabel: org?.entityType ? ENTITY_LABEL[org.entityType] ?? null : null,
    signatoryName: org?.signatoryName ?? null,
    signatoryTitle: org?.signatoryTitle ?? null,
    showLetterhead: org?.letterheadEnabled ?? true,
  };
}
