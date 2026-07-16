import 'server-only';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { organizations, users } from '@/db/schema/schema';
import { DEFAULT_CLIENT_INTERACTION_PREFS, type ClientInteractionPrefs } from './onboarding';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Apply an enterprise firm's "Client Interaction" preferences — set in the
 * firm-onboarding wizard and stored on organizations.clientInteractionPrefs —
 * to a freshly provisioned client. Four prefs map to per-org opt-in toggles on
 * the client org; the weekly digest is a per-user opt-in timestamp on the
 * client's owner user.
 *
 * A firm with no stored prefs (null) falls back to all-enabled, matching the
 * wizard's default-checked UI. Pass clientOrgId = null for user-only clients
 * (no org yet) — the per-user weekly-digest opt-in is still applied.
 *
 * Call inside the same transaction that creates the client so it rolls back
 * together. Reads the firm row by PK; cheap enough to call once per client.
 */
export async function applyFirmClientInteractionPrefs(
  client: Tx | typeof db,
  args: { enterpriseId: string; clientOrgId: string | null; ownerUserId: string },
): Promise<void> {
  const { enterpriseId, clientOrgId, ownerUserId } = args;

  const [firm] = await client
    .select({ prefs: organizations.clientInteractionPrefs })
    .from(organizations)
    .where(eq(organizations.id, enterpriseId))
    .limit(1);

  const prefs = (firm?.prefs as ClientInteractionPrefs | null) ?? DEFAULT_CLIENT_INTERACTION_PREFS;

  if (clientOrgId) {
    await client
      .update(organizations)
      .set({
        contactInquiryEnabled: prefs.askNewContacts,
        substantiationEnabled: prefs.irsDocRequests,
        reviewAutoOutreachEnabled: prefs.reviewReminders,
        monthlyReportEnabled: prefs.monthlyReport,
      })
      .where(eq(organizations.id, clientOrgId));
  }

  await client
    .update(users)
    .set({ weeklyDigestOptInAt: prefs.weeklyDigest ? new Date().toISOString() : null })
    .where(eq(users.id, ownerUserId));
}
