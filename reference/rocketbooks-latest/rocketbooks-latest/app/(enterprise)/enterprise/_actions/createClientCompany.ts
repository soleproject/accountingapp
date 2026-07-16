'use server';

import { randomUUID } from 'crypto';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { requestOrigin } from '@/lib/http/origin';
import { users, organizations, enterpriseClients, adminAuditLog, onboardingState } from '@/db/schema/schema';
import { requireSession } from '@/lib/auth/session';
import { listAccessibleEnterprises } from '@/lib/auth/enterprise';
import { createServiceClient } from '@/lib/supabase/service';
import { inviteEnterpriseClient } from '@/lib/enterprise/client-invite';
import { toOrgEntityType } from '@/lib/orgs/entity-type';
import { applyFirmClientInteractionPrefs } from '@/lib/enterprise/client-interaction-prefs';
import { recordInitialClientRevenueShare } from '@/lib/enterprise/revenue-share';
import { firmHasPaymentMethod } from '@/lib/stripe/firm-billing';
import { createFirmBillingSetupSession } from '@/lib/stripe/checkout';
import { isAccountingTierKey } from '@/lib/accounting/tiers';
import { setOrgAccountingTier } from '@/lib/accounting/assign-tier';
import { pruneEmptyPlaceholderOrgs } from '@/lib/accounting/prune-placeholders';
import type { WelcomeEmailConfig } from '@/lib/enterprise/onboarding';

function parseEmailConfig(raw: string): WelcomeEmailConfig | null {
  const s = raw.trim();
  if (!s) return null;
  try {
    const o = JSON.parse(s) as Partial<WelcomeEmailConfig>;
    if (o && typeof o.subject === 'string' && typeof o.body === 'string' && typeof o.cta === 'string') {
      return { subject: o.subject, body: o.body, cta: o.cta };
    }
  } catch {
    /* fall through to null */
  }
  return null;
}

/**
 * Add a company (organization) for an existing OR brand-new client owner. The
 * unified flow from the Add a Company wizard: identify/create the owner, then
 * stand up one new `pro` org with its billing, plan, "who does the books", and
 * client-experience choices — mirroring createEnterpriseUserAction's side
 * effects but scoped to a single additional company.
 */
export async function createClientCompanyAction(formData: FormData): Promise<void> {
  const sessionUser = await requireSession();
  const accessible = await listAccessibleEnterprises();
  if (accessible.length === 0) throw new Error('forbidden');

  const enterpriseId = String(formData.get('enterpriseId') ?? '').trim();
  if (!accessible.find((e) => e.id === enterpriseId)) {
    throw new Error('You do not have access to this enterprise');
  }

  const ownerMode = String(formData.get('ownerMode') ?? 'existing');
  const companyName = String(formData.get('companyName') ?? '').trim();
  const companyType = String(formData.get('companyType') ?? '').trim() || null;
  const tierRaw = String(formData.get('accountingTier') ?? '').trim();
  const accountingTier = isAccountingTierKey(tierRaw) ? tierRaw : null;
  const clientType: 'new' | 'switching' =
    String(formData.get('clientType') ?? 'new') === 'switching' ? 'switching' : 'new';
  const booksManagedBy = String(formData.get('booksManagedBy') ?? '').trim() === 'firm' ? 'firm' : 'client';
  const handoff = String(formData.get('clientOnboardingHandoff') ?? '').trim() || null;
  const aiAssistantName = String(formData.get('aiAssistantName') ?? '').trim() || null;
  const clientBookingUrl = String(formData.get('clientBookingUrl') ?? '').trim() || null;
  const welcomeEmailConfig = parseEmailConfig(String(formData.get('welcomeEmailConfig') ?? ''));
  const welcomeEmailConfigSwitching = parseEmailConfig(String(formData.get('welcomeEmailConfigSwitching') ?? ''));

  if (!companyName) throw new Error('Company name is required');

  // Per-company billing. firm_pays requires the firm to be Private Label.
  const [firm] = await db
    .select({ privateLabel: organizations.privateLabelEnabled })
    .from(organizations)
    .where(eq(organizations.id, enterpriseId))
    .limit(1);
  const billingMode =
    String(formData.get('clientBillingMode') ?? '') === 'firm_pays' && !!firm?.privateLabel ? 'firm_pays' : 'client_pays';
  const priceMode =
    billingMode === 'client_pays'
      ? String(formData.get('clientPriceMode') ?? '') === 'discount_69'
        ? 'discount_69'
        : 'standard_referral'
      : null;

  // GATE: the firm chose to cover this client but has NO card on file → send them to
  // add a card FIRST (nothing created yet), otherwise the client would get full app
  // access with nothing billable. Before any side effect; redirect throws NEXT_REDIRECT.
  if (billingMode === 'firm_pays' && !(await firmHasPaymentMethod(enterpriseId))) {
    redirect(await createFirmBillingSetupSession(enterpriseId, '/enterprise/clients/add-company'));
  }

  // ── Resolve / create the owner ──────────────────────────────────────────
  const supabase = createServiceClient();
  let ownerUserId: string;
  let isNewOwner = false;
  let newOwnerName = '';
  let newOwnerEmail = '';

  if (ownerMode === 'new') {
    newOwnerName = String(formData.get('newOwnerFullName') ?? '').trim();
    newOwnerEmail = String(formData.get('newOwnerEmail') ?? '').trim().toLowerCase();
    if (!newOwnerName) throw new Error('Owner name is required');
    if (!newOwnerEmail || !newOwnerEmail.includes('@')) throw new Error('A valid owner email is required');
    const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, newOwnerEmail)).limit(1);
    if (existing) throw new Error(`A user with email ${newOwnerEmail} already exists — pick them from the dropdown instead.`);

    const invite = await inviteEnterpriseClient({
      supabase,
      email: newOwnerEmail,
      fullName: newOwnerName,
      redirectTo: await requestOrigin(),
      enterpriseId,
      brandEligible: true,
      clientType,
      usage: { userId: sessionUser.id, orgId: enterpriseId, actor: 'enterprise', feature: 'client-invite-email' },
      emailOverride: {
        config: clientType === 'switching' ? welcomeEmailConfigSwitching : welcomeEmailConfig,
        handoff,
        bookingUrl: clientBookingUrl,
        aiName: aiAssistantName,
      },
    });
    if (invite.error || !invite.userId) throw new Error(`Invite failed: ${invite.error}`);
    ownerUserId = invite.userId;
    isNewOwner = true;
  } else {
    ownerUserId = String(formData.get('ownerUserId') ?? '').trim();
    if (!ownerUserId) throw new Error('Pick an owner for the company');
    const [link] = await db
      .select({ id: enterpriseClients.id })
      .from(enterpriseClients)
      .where(and(eq(enterpriseClients.clientUserId, ownerUserId), eq(enterpriseClients.enterpriseId, enterpriseId)))
      .limit(1);
    if (!link) throw new Error('That owner is not a client of this enterprise.');
  }

  // ── Create the company + side effects atomically ────────────────────────
  const orgId = randomUUID();
  try {
    await db.transaction(async (tx) => {
      if (isNewOwner) {
        await tx.insert(users).values({
          id: ownerUserId,
          email: newOwnerEmail,
          fullName: newOwnerName,
          passwordHash: 'supabase',
          isActive: true,
          role: 'paying_user',
        });
        await tx.insert(enterpriseClients).values({
          id: randomUUID(),
          enterpriseId,
          clientUserId: ownerUserId,
          status: 'active',
          acquisitionSource: 'manual',
          clientBillingMode: billingMode,
          clientPriceMode: priceMode,
          clientType,
        });
      }

      await tx.insert(organizations).values({
        id: orgId,
        name: companyName,
        ownerUserId,
        planType: 'pro',
        entityType: toOrgEntityType(companyType),
        booksManagedBy,
        clientOnboardingHandoff: handoff,
        clientBookingUrl,
        ...(aiAssistantName ? { aiAssistantName } : {}),
        ...(welcomeEmailConfig ? { welcomeEmailConfig } : {}),
        ...(welcomeEmailConfigSwitching ? { welcomeEmailConfigSwitching } : {}),
      });

      // Seed onboarding so the "Finish setting up <company>" card surfaces on
      // the client's dashboard from minute one. action-cards.ts requires an
      // onboarding row with completed=false; a fresh org with no row never
      // shows the card. 'business_info' is the canonical first phase.
      await tx.insert(onboardingState).values({
        orgId,
        phase: 'business_info',
        step: 'business_info',
        context: {},
        completed: false,
      });

      await tx.insert(adminAuditLog).values({
        id: randomUUID(),
        adminUserId: sessionUser.id,
        action: 'organization.create',
        targetType: 'organization',
        targetId: orgId,
        auditMetadata: { for: ownerUserId, name: companyName, enterpriseId, via: 'add_company_wizard' },
      });

      // A brand-new owner has no prior org — make this their active workspace.
      if (isNewOwner) {
        await tx.update(users).set({ organizationId: orgId, activeOrganizationId: orgId }).where(eq(users.id, ownerUserId));
      }

      // Seed the firm's Client Interaction defaults onto the new company.
      await applyFirmClientInteractionPrefs(tx, { enterpriseId, clientOrgId: orgId, ownerUserId });
    });
  } catch (err) {
    // Roll back the Supabase auth account for a brand-new owner so a retry
    // isn't blocked by an orphan auth row.
    if (isNewOwner) {
      try {
        await supabase.auth.admin.deleteUser(ownerUserId);
      } catch (delErr) {
        console.error('Failed to roll back Supabase auth user', ownerUserId, delErr);
      }
    }
    throw err;
  }

  // Plan/tier on the new org (per-org — multi-company safe). Non-fatal.
  if (accountingTier) {
    try {
      await setOrgAccountingTier(orgId, accountingTier);
    } catch (tierErr) {
      console.error('Failed to set accounting tier for new company', orgId, tierErr);
    }
  }

  // Billing for this company. Firm pays → NO per-client sub; the firm-billing cron
  // invoices the firm monthly IN ARREARS for every client it covers. Client pays →
  // stamp the revenue-share ledger.
  if (billingMode === 'firm_pays') {
    // No per-client sub; the arrears cron bills the firm.
  } else {
    try {
      await recordInitialClientRevenueShare({ enterpriseId, clientOrganizationId: orgId });
    } catch (rsErr) {
      console.error('Failed to record initial revenue share for new company', orgId, rsErr);
    }
  }

  // An EXISTING owner may carry a leftover empty "My Business" shell from an
  // earlier signup — they now have a real, named company, so prune it. New
  // owners are minted here with no prior orgs, so there's nothing to clean.
  // Best-effort; excludes the company we just created and never blocks.
  if (!isNewOwner) {
    try {
      await pruneEmptyPlaceholderOrgs(ownerUserId, orgId);
    } catch (pruneErr) {
      console.error('Failed to prune placeholder orgs for new-company owner', ownerUserId, pruneErr);
    }
  }

  revalidatePath('/enterprise/clients');
  revalidatePath('/enterprise/businesses');
  revalidatePath('/enterprise/dashboard');

  const booksHref = `/enterprise/clients/${ownerUserId}/bookkeeping`;
  redirect(booksHref);
}
