import 'server-only';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { organizations, enterpriseClients } from '@/db/schema/schema';

export interface FirmSenderIdentity {
  /** Display name to show as the email sender (the firm's name). */
  fromName: string | null;
  /** Reply-to address so client replies reach the firm. */
  replyTo: string | null;
  /**
   * Per-firm white-label from-address (e.g. scarlett@accountingapp.ai), derived
   * from the firm's subdomain — but ONLY when a verified white-label sending
   * domain is configured via RESEND_WHITELABEL_DOMAIN. Null otherwise, so the
   * sender keeps the default verified address until that DNS/Resend setup is done.
   */
  fromAddress: string | null;
}

const EMPTY: FirmSenderIdentity = { fromName: null, replyTo: null, fromAddress: null };

/**
 * How a private-label firm's outbound client emails should be branded.
 * Emails still send from the platform's verified RESEND_FROM address (no DNS
 * setup), but show the firm's NAME as the sender and route replies to the
 * firm's chosen address. Returns empty for non-private-label firms so their
 * mail keeps the RocketBooks identity.
 */
export async function getEnterpriseSenderIdentity(enterpriseId: string): Promise<FirmSenderIdentity> {
  const [org] = await db
    .select({
      name: organizations.name,
      sendingFromEmail: organizations.sendingFromEmail,
      privateLabel: organizations.privateLabelEnabled,
      subdomain: organizations.subdomain,
    })
    .from(organizations)
    .where(eq(organizations.id, enterpriseId))
    .limit(1);
  if (!org || !org.privateLabel) return EMPTY;
  // Per-firm from-address only when a verified white-label sending domain is
  // configured (RESEND_WHITELABEL_DOMAIN, e.g. accountingapp.ai) AND the firm
  // has a subdomain → scarlett@accountingapp.ai. Else null → default address.
  const wlDomain = process.env.RESEND_WHITELABEL_DOMAIN;
  const fromAddress = wlDomain && org.subdomain ? `${org.subdomain}@${wlDomain}` : null;
  return {
    fromName: org.name?.trim() || null,
    replyTo: org.sendingFromEmail?.trim() || null,
    fromAddress,
  };
}

/**
 * Sender identity for an email concerning a given org — if that org's owner is
 * a client of a private-label firm, brand the mail with that firm. Returns
 * empty for direct (non-enterprise) orgs, so their mail keeps the RocketBooks
 * identity. This is the entry point used to brand emails app-wide.
 */
export async function getFirmSenderForOrg(orgId: string): Promise<FirmSenderIdentity> {
  const [org] = await db
    .select({ ownerUserId: organizations.ownerUserId })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  if (!org?.ownerUserId) return EMPTY;
  const [client] = await db
    .select({ enterpriseId: enterpriseClients.enterpriseId })
    .from(enterpriseClients)
    .where(eq(enterpriseClients.clientUserId, org.ownerUserId))
    .limit(1);
  if (!client?.enterpriseId) return EMPTY;
  return getEnterpriseSenderIdentity(client.enterpriseId);
}
