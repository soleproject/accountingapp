'use server';

import { randomUUID } from 'crypto';
import { revalidatePath } from 'next/cache';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { requestOrigin } from '@/lib/http/origin';
import { users, organizations, enterpriseClients, adminAuditLog } from '@/db/schema/schema';
import { requireSession } from '@/lib/auth/session';
import { getCurrentEnterprise } from '@/lib/auth/enterprise';
import { createServiceClient } from '@/lib/supabase/service';
import { recordInitialClientRevenueShare } from '@/lib/enterprise/revenue-share';
import { firmHasPaymentMethod } from '@/lib/stripe/firm-billing';
import { inviteEnterpriseClient } from '@/lib/enterprise/client-invite';
import { applyFirmClientInteractionPrefs } from '@/lib/enterprise/client-interaction-prefs';
import type { WelcomeEmailConfig } from '@/lib/enterprise/onboarding';
import { DEMO_ENTERPRISE_ID } from '@/lib/enterprise/demo';
import { isAccountingTierKey } from '@/lib/accounting/tiers';
import { setUserAccountingTier } from '@/lib/accounting/assign-tier';

export interface BulkImportRow {
  fullName: string;
  email: string;
  companyName?: string;
}
export interface BulkImportRowResult {
  email: string;
  status: 'created' | 'skipped' | 'failed';
  message?: string;
}
export interface BulkImportResult {
  created: number;
  skipped: number;
  failed: number;
  results: BulkImportRowResult[];
  /** True when the firm covers these clients but has no card on file yet — the UI
   *  then prompts the firm to add its card so the deferred firm-paid subs can bill. */
  needsFirmCardSetup?: boolean;
}

const MAX_ROWS = 200;

/**
 * Bulk-create paying-user clients for the current enterprise via emailed
 * invites. Mirrors the single createEnterpriseUserAction path (Supabase invite
 * → users + enterprise_clients [+ org] in one tx → revenue-share ledger), run
 * sequentially so we don't trip Supabase invite rate limits. Each row is
 * isolated: one failure never aborts the batch.
 */
export async function bulkImportClientsAction(
  rows: BulkImportRow[],
  batch?: {
    clientBillingMode?: string | null;
    clientPriceMode?: string | null;
    clientType?: string | null;
    clientOnboardingHandoff?: string | null;
    welcomeEmailConfig?: WelcomeEmailConfig | null;
    welcomeEmailConfigSwitching?: WelcomeEmailConfig | null;
    clientBookingUrl?: string | null;
    accountingTier?: string | null;
  },
): Promise<BulkImportResult> {
  const sessionUser = await requireSession();
  const current = await getCurrentEnterprise();
  const fail = (message: string): BulkImportResult => ({
    created: 0,
    skipped: 0,
    failed: rows.length,
    results: rows.map((r) => ({ email: r.email || '(blank)', status: 'failed' as const, message })),
  });
  if (!current || current.id === DEMO_ENTERPRISE_ID) return fail('Not available for this enterprise.');

  const [actor] = await db.select({ role: users.role }).from(users).where(eq(users.id, sessionUser.id)).limit(1);
  if (actor?.role === 'enterprise_owner_demo') return fail('Demo accounts cannot bulk import clients.');

  const enterpriseId = current.id;
  // When the firm covers its clients, every imported client needs an org to
  // attach the firm-billed subscription to (even without a company name).
  const [ent] = await db
    .select({ billingMode: organizations.clientBillingMode, privateLabel: organizations.privateLabelEnabled })
    .from(organizations)
    .where(eq(organizations.id, enterpriseId))
    .limit(1);
  // The import page chooses who-pays + pricing for this batch (its controls are
  // defaulted from the firm's own settings). Store it as each client's billing.
  // firm_pays requires Private Label; otherwise fall back to client_pays.
  const wantsFirmPays = batch?.clientBillingMode === 'firm_pays' && !!ent?.privateLabel;
  const perClientMode: string = wantsFirmPays ? 'firm_pays' : 'client_pays';
  const perClientPrice: string | null =
    perClientMode === 'client_pays'
      ? batch?.clientPriceMode === 'discount_69'
        ? 'discount_69'
        : 'standard_referral'
      : null;
  const firmPays = perClientMode === 'firm_pays';
  // Card on file? Computed once for the whole import.
  const hasCard = firmPays ? await firmHasPaymentMethod(enterpriseId) : false;
  // GATE: the firm chose to cover these clients but has NO card on file → create
  // NOTHING and tell the UI to collect a card first. Otherwise these clients would
  // get full app access with nothing billable (access is membership-based).
  if (firmPays && !hasCard) {
    return { created: 0, skipped: 0, failed: 0, results: [], needsFirmCardSetup: true };
  }
  // New vs switching → welcome-email variant for the whole import.
  const clientType: 'new' | 'switching' = batch?.clientType === 'switching' ? 'switching' : 'new';
  // New-client setup (handoff) for this import → overrides the firm default when
  // rendering each welcome email ('self' | 'meeting' | 'pro').
  const importHandoff =
    batch?.clientOnboardingHandoff === 'meeting' || batch?.clientOnboardingHandoff === 'pro' || batch?.clientOnboardingHandoff === 'self'
      ? batch.clientOnboardingHandoff
      : null;
  // Per-import welcome-email + booking overrides (null = fall back to firm default).
  const importBookingUrl = batch?.clientBookingUrl?.trim() || null;
  const importEmailConfig =
    (clientType === 'switching' ? batch?.welcomeEmailConfigSwitching : batch?.welcomeEmailConfig) ?? null;
  // Accounting plan applied to EVERY client in this upload (mass-assign).
  // Invalid/empty → null = grandfathered flat $89 (no permission set assigned).
  const accountingTier = isAccountingTierKey(batch?.accountingTier) ? batch.accountingTier : null;
  const supabase = createServiceClient();
  const results: BulkImportRowResult[] = [];
  const seen = new Set<string>();
  let created = 0;
  let skipped = 0;
  let failed = 0;

  for (const raw of rows.slice(0, MAX_ROWS)) {
    const fullName = (raw.fullName || '').trim();
    const email = (raw.email || '').trim().toLowerCase();
    const companyName = (raw.companyName || '').trim();

    if (!email || !email.includes('@')) {
      failed++;
      results.push({ email: email || '(blank)', status: 'failed', message: 'Invalid email' });
      continue;
    }
    if (!fullName) {
      failed++;
      results.push({ email, status: 'failed', message: 'Missing name' });
      continue;
    }
    if (seen.has(email)) {
      skipped++;
      results.push({ email, status: 'skipped', message: 'Duplicate in list' });
      continue;
    }
    seen.add(email);

    const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
    if (existing) {
      skipped++;
      results.push({ email, status: 'skipped', message: 'User already exists' });
      continue;
    }

    let authUserId: string;
    try {
      const invite = await inviteEnterpriseClient({
        supabase,
        email,
        fullName,
        redirectTo: await requestOrigin(),
        enterpriseId,
        brandEligible: true,
        clientType,
        usage: { userId: sessionUser.id, orgId: enterpriseId, actor: 'enterprise', feature: 'client-invite-email' },
        emailOverride: { handoff: importHandoff, config: importEmailConfig, bookingUrl: importBookingUrl },
      });
      if (invite.error || !invite.userId) throw new Error(invite.error || 'Invite failed');
      authUserId = invite.userId;
    } catch (e) {
      failed++;
      results.push({ email, status: 'failed', message: e instanceof Error ? e.message : 'Invite failed' });
      continue;
    }

    try {
      const orgId = companyName || firmPays ? randomUUID() : null;
      const orgName = companyName || fullName;
      await db.transaction(async (tx) => {
        await tx.insert(users).values({
          id: authUserId,
          email,
          fullName,
          passwordHash: 'supabase',
          isActive: true,
          role: 'paying_user',
        });
        await tx.insert(enterpriseClients).values({
          id: randomUUID(),
          enterpriseId,
          clientUserId: authUserId,
          status: 'active',
          acquisitionSource: 'manual',
          clientBillingMode: perClientMode,
          clientPriceMode: perClientPrice,
          clientType,
        });
        if (orgId) {
          await tx.insert(organizations).values({
            id: orgId,
            name: orgName,
            ownerUserId: authUserId,
            planType: 'pro',
          });
          await tx
            .update(users)
            .set({ organizationId: orgId, activeOrganizationId: orgId })
            .where(eq(users.id, authUserId));
          await tx.insert(adminAuditLog).values({
            id: randomUUID(),
            adminUserId: sessionUser.id,
            action: 'organization.create',
            targetType: 'organization',
            targetId: orgId,
            auditMetadata: { for: authUserId, name: companyName, enterpriseId, bulk: true },
          });
        }
        await tx.insert(adminAuditLog).values({
          id: randomUUID(),
          adminUserId: sessionUser.id,
          action: 'enterprise.user.create',
          targetType: 'user',
          targetId: authUserId,
          auditMetadata: { email, primaryRole: 'paying_user', passwordMode: 'invite', enterpriseId, primaryOrgId: orgId, bulk: true },
        });
        // Seed the firm's Client Interaction defaults onto the new client.
        await applyFirmClientInteractionPrefs(tx, { enterpriseId, clientOrgId: orgId, ownerUserId: authUserId });
      });

      // Apply the chosen plan FIRST: stamps the client's org tier + assigns the
      // matching permission set. Must run BEFORE billing so the firm-paid
      // subscription bills the tier's REDUCED price ($29/$65/$119) and revenue
      // share records the right amount — otherwise the tier is still null and
      // firm-pays falls back to the flat firm-paid product. Handles the org-less
      // ("create later") case by assigning the set straight to the user. Non-fatal.
      if (accountingTier) {
        try {
          await setUserAccountingTier(authUserId, accountingTier);
        } catch (tierErr) {
          console.error('Bulk import: set accounting tier failed for', authUserId, tierErr);
        }
      }

      let billingNote: string | undefined;
      if (orgId && firmPays) {
        // Firm covers this client — billed monthly IN ARREARS by the firm-billing
        // cron (one consolidated invoice on the 5th). No per-client sub here.
        billingNote = 'billed to your firm monthly';
      } else if (orgId) {
        try {
          await recordInitialClientRevenueShare({ enterpriseId, clientOrganizationId: orgId });
        } catch (rsErr) {
          console.error('Bulk import: revenue share failed for', orgId, rsErr);
        }
      }
      created++;
      results.push({ email, status: 'created', message: billingNote });
    } catch (e) {
      // Roll back the Supabase auth account so a retry isn't blocked.
      try {
        await supabase.auth.admin.deleteUser(authUserId);
      } catch {
        /* best effort */
      }
      failed++;
      results.push({ email, status: 'failed', message: e instanceof Error ? e.message : 'Create failed' });
    }
  }

  revalidatePath('/enterprise/clients');
  revalidatePath('/enterprise/dashboard');
  // Firm covers these clients but has no card yet → the subs were deferred; tell the
  // UI to prompt the firm to add its card (ensureFirmPaidSubscriptions bills them once
  // the card lands).
  return { created, skipped, failed, results, needsFirmCardSetup: firmPays && !hasCard && created > 0 };
}
