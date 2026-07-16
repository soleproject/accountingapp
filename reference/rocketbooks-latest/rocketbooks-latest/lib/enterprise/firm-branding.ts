import 'server-only';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { organizations, enterpriseClients } from '@/db/schema/schema';
import { PRIVATE_LABEL_ROOT } from './subdomain';

/**
 * White-label resolution for client-facing outreach. A client org belongs to an
 * enterprise (firm) via enterprise_clients; when that firm is private-label we
 * route links to its branded host and honor its powered-by footer setting.
 */

const DEFAULT_BASE = (process.env.NEXT_PUBLIC_APP_URL || 'https://app.rocketbooks.ai').replace(/\/$/, '');

interface FirmBrand {
  privateLabelEnabled: boolean | null;
  subdomain: string | null;
  domain: string | null;
  poweredByEnabled: boolean | null;
  poweredByText: string | null;
}

async function resolveFirmBrand(orgId: string): Promise<FirmBrand | null> {
  const [org] = await db
    .select({ ownerUserId: organizations.ownerUserId })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  if (!org?.ownerUserId) return null;
  const [client] = await db
    .select({ enterpriseId: enterpriseClients.enterpriseId })
    .from(enterpriseClients)
    .where(eq(enterpriseClients.clientUserId, org.ownerUserId))
    .limit(1);
  if (!client?.enterpriseId) return null;
  const [ent] = await db
    .select({
      privateLabelEnabled: organizations.privateLabelEnabled,
      subdomain: organizations.subdomain,
      domain: organizations.domain,
      poweredByEnabled: organizations.poweredByEnabled,
      poweredByText: organizations.poweredByText,
    })
    .from(organizations)
    .where(eq(organizations.id, client.enterpriseId))
    .limit(1);
  return ent ?? null;
}

/**
 * The public base URL a client of this org should be linked to — the firm's
 * white-label host when private-label, otherwise the default app host.
 */
export async function getFirmBaseUrlForOrg(orgId: string): Promise<string> {
  const firm = await resolveFirmBrand(orgId);
  if (firm?.privateLabelEnabled) {
    if (firm.domain) return `https://${firm.domain.replace(/^https?:\/\//, '').replace(/\/+$/, '')}`;
    if (firm.subdomain) return `https://${firm.subdomain}.${PRIVATE_LABEL_ROOT}`;
  }
  return DEFAULT_BASE;
}

/**
 * The footer suffix for a client-facing email ("via Rocketbooks", a firm's
 * custom text, or null to suppress). A private-label firm controls it via its
 * powered-by settings; self-serve orgs get the default.
 */
export async function getPoweredByFooter(orgId: string): Promise<string | null> {
  const firm = await resolveFirmBrand(orgId);
  if (firm?.privateLabelEnabled) {
    if (firm.poweredByEnabled === false) return null;
    return firm.poweredByText?.trim() || 'via Rocketbooks';
  }
  return 'via Rocketbooks';
}
