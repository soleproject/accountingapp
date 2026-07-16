'use server';

import { randomUUID, randomBytes } from 'crypto';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { requestOrigin } from '@/lib/http/origin';
import {
  users,
  organizations,
  enterpriseStaff,
  enterpriseClients,
  permissionSets,
  userPermissionSets,
  adminAuditLog,
  organizationSubscriptions,
  billingProducts,
  onboardingState,
} from '@/db/schema/schema';
import { requireSession } from '@/lib/auth/session';
import { inviteEnterpriseClient } from '@/lib/enterprise/client-invite';
import { listAccessibleEnterprises } from '@/lib/auth/enterprise';
import { createServiceClient } from '@/lib/supabase/service';
import { toOrgEntityType } from '@/lib/orgs/entity-type';
import { recordInitialClientRevenueShare } from '@/lib/enterprise/revenue-share';
import { applyFirmClientInteractionPrefs } from '@/lib/enterprise/client-interaction-prefs';
import { firmHasPaymentMethod } from '@/lib/stripe/firm-billing';
import { createFirmBillingSetupSession } from '@/lib/stripe/checkout';
import { isAccountingTierKey } from '@/lib/accounting/tiers';
import { setUserAccountingTier } from '@/lib/accounting/assign-tier';
import type { WelcomeEmailConfig } from '@/lib/enterprise/onboarding';

type PasswordMode = 'invite' | 'auto' | 'manual';
type OrgMode = 'now' | 'later';
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

function generatePassword(): string {
  return randomBytes(14).toString('base64url');
}

/**
 * Insert one audit row. targetType is REQUIRED -- never hardcode it, since
 * audit queries filter on it ("show me everything that happened to org X").
 * Accepts an optional tx so callers wrapping multiple writes can keep the
 * audit row atomic with the work it describes.
 */
async function logAudit(
  adminUserId: string,
  action: string,
  targetType: 'user' | 'organization' | 'enterprise',
  targetId: string | null,
  metadata: Record<string, unknown> | undefined,
  client: Tx | typeof db = db,
) {
  await client.insert(adminAuditLog).values({
    id: randomUUID(),
    adminUserId,
    action,
    targetType,
    targetId,
    auditMetadata: metadata ?? null,
  });
}

/**
 * Enterprise-scoped user creation. Mirrors the super-admin createUser flow
 * for Paying User / Enterprise Owner / Enterprise Staff roles but locks the
 * enterprise to one the signed-in user actually owns or staffs. Any other
 * role flag is rejected; Super Admin permission sets are refused.
 *
 * Ordering: validate -> Supabase auth.create -> single DB transaction. If
 * the transaction fails, the Supabase auth account is rolled back so we
 * never leak an orphan that can sign in to a non-existent local user.
 */
export async function createEnterpriseUserAction(formData: FormData): Promise<void> {
  const sessionUser = await requireSession();

  const accessible = await listAccessibleEnterprises();
  if (accessible.length === 0) throw new Error('forbidden');

  // Lock the action to one of the admin's accessible enterprises. If the
  // form posted an id that isn't in the allowed set, REJECT rather than
  // silently using a different enterprise -- an admin meaning to create
  // in enterprise A shouldn't accidentally create in B.
  const submittedEnterpriseId = String(formData.get('enterpriseId') ?? '').trim();
  if (!submittedEnterpriseId) throw new Error('enterpriseId is required');
  const lockedEnterprise = accessible.find((e) => e.id === submittedEnterpriseId);
  if (!lockedEnterprise) {
    throw new Error('You do not have access to this enterprise');
  }
  const enterpriseId = lockedEnterprise.id;

  const fullName = String(formData.get('fullName') ?? '').trim();
  const email = String(formData.get('email') ?? '').trim().toLowerCase();
  const permissionSetId = String(formData.get('permissionSetId') ?? '').trim() || null;
  const passwordMode = String(formData.get('passwordMode') ?? 'invite') as PasswordMode;
  const explicitPassword = String(formData.get('password') ?? '');

  const enterpriseOwner = formData.get('role_enterpriseOwner') === 'on';
  const enterpriseStaffRole = formData.get('role_enterpriseStaff') === 'on';
  const payingUser = formData.get('role_payingUser') === 'on';

  const orgMode = String(formData.get('orgMode') ?? 'now') as OrgMode;
  const companyName = String(formData.get('companyName') ?? '').trim();
  const companyType = String(formData.get('companyType') ?? '').trim() || null;
  // Per-client billing choice — only honored when the firm is on "varies".
  const submittedBillingMode = String(formData.get('clientBillingMode') ?? '').trim() || null;
  const submittedPriceMode = String(formData.get('clientPriceMode') ?? '').trim() || null;
  // New vs switching client → which welcome-email variant is sent.
  const clientType: 'new' | 'switching' = String(formData.get('clientType') ?? 'new') === 'switching' ? 'switching' : 'new';
  // Per-client onboarding handoff + welcome-email/booking overrides (paying users).
  const handoffRaw = String(formData.get('clientOnboardingHandoff') ?? '').trim();
  const clientOnboardingHandoff =
    handoffRaw === 'meeting' || handoffRaw === 'pro' || handoffRaw === 'self' ? handoffRaw : null;
  const submittedBookingUrl = String(formData.get('clientBookingUrl') ?? '').trim() || null;
  const parseWelcomeCfg = (raw: string): WelcomeEmailConfig | null => {
    if (!raw) return null;
    try {
      const o = JSON.parse(raw) as Partial<WelcomeEmailConfig>;
      return o && typeof o.subject === 'string' && typeof o.body === 'string' && typeof o.cta === 'string'
        ? { subject: o.subject, body: o.body, cta: o.cta }
        : null;
    } catch {
      return null;
    }
  };
  const submittedWelcomeCfg = parseWelcomeCfg(String(formData.get('welcomeEmailConfig') ?? ''));
  const submittedWelcomeCfgSwitching = parseWelcomeCfg(String(formData.get('welcomeEmailConfigSwitching') ?? ''));
  const importEmailConfig = clientType === 'switching' ? submittedWelcomeCfgSwitching : submittedWelcomeCfg;
  // Accounting plan for this client (paying users). Empty/invalid → grandfathered $89.
  const accountingTierRaw = String(formData.get('accountingTier') ?? '').trim();
  const accountingTier = isAccountingTierKey(accountingTierRaw) ? accountingTierRaw : null;
  // NOTE: the form has an "industry" input ("Technology, Healthcare, ...")
  // but organizations has no industry column. We intentionally drop the
  // value here -- it used to be miscoerced into business_description,
  // which is a free-form description field, not a category. Add a real
  // industry column to organizations if you need to capture this.

  if (!fullName) throw new Error('Full name is required');
  if (!email) throw new Error('Email is required');
  if (!email.includes('@')) throw new Error('Email is not valid');
  if (passwordMode === 'manual' && explicitPassword.length < 8) {
    throw new Error('Manual password must be at least 8 characters');
  }
  if (!enterpriseOwner && !enterpriseStaffRole && !payingUser) {
    throw new Error('Pick at least one role');
  }
  if (payingUser && orgMode === 'now' && !companyName) {
    throw new Error('Company name is required when creating organization now');
  }

  if (permissionSetId) {
    const [ps] = await db
      .select({ name: permissionSets.name })
      .from(permissionSets)
      .where(eq(permissionSets.id, permissionSetId))
      .limit(1);
    if (!ps) throw new Error('Permission set not found');
    const ALLOWED = new Set(['paying user', 'enterprise owner', 'enterprise staff']);
    if (!ALLOWED.has(ps.name.toLowerCase())) {
      throw new Error(`Enterprise users can only assign Paying User, Enterprise Owner, or Enterprise Staff (got "${ps.name}")`);
    }
  }

  // Demo cap. An enterprise_owner_demo user gets exactly one paying-user
  // client (which becomes their demo company), and only via "create org
  // now". Reject anything else here, before we leak a Supabase auth
  // account. The role check is the cheapest guard — if the actor isn't a
  // demo owner, this whole block is skipped.
  const [actorProfile] = await db
    .select({ role: users.role })
    .from(users)
    .where(eq(users.id, sessionUser.id))
    .limit(1);
  const isDemoOwner = actorProfile?.role === 'enterprise_owner_demo';
  if (isDemoOwner) {
    if (!payingUser || enterpriseOwner || enterpriseStaffRole) {
      throw new Error('Demo accounts can only create one Paying User client.');
    }
    if (orgMode !== 'now') {
      throw new Error('Demo accounts must create the client with an organization now.');
    }
    const [existingClient] = await db
      .select({ id: enterpriseClients.id })
      .from(enterpriseClients)
      .where(eq(enterpriseClients.enterpriseId, enterpriseId))
      .limit(1);
    if (existingClient) {
      throw new Error('Demo is limited to 1 client. Upgrade to add more.');
    }
  }

  // Fast-path duplicate check: if we already have a local users row with
  // this email, bail BEFORE creating a Supabase auth account. The DB
  // unique constraint inside the tx below is the real guard against
  // races; this just avoids the common case of a leaked auth account
  // when an admin re-submits a form for a known-existing user.
  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  if (existing) throw new Error(`A user with email ${email} already exists`);

  // Resolve the per-client billing choice up front (firm_pays requires Private Label).
  // GATE: if the firm chose to cover this client but has NO card on file, block
  // creation and send them to add a card first — otherwise a firm-paid client would
  // get full app access with nothing billable (access is membership-based; the
  // deferred sub never fires without a card). Done BEFORE any side effect
  // (invite/insert); redirect() throws NEXT_REDIRECT so it's outside any try.
  const [firmBilling] = await db
    .select({ mode: organizations.clientBillingMode, privateLabel: organizations.privateLabelEnabled })
    .from(organizations)
    .where(eq(organizations.id, enterpriseId))
    .limit(1);
  const wantsFirmPays = submittedBillingMode === 'firm_pays' && !!firmBilling?.privateLabel;
  const perClientMode: string = wantsFirmPays ? 'firm_pays' : 'client_pays';
  const perClientPrice: string | null =
    perClientMode === 'client_pays'
      ? submittedPriceMode === 'discount_69'
        ? 'discount_69'
        : 'standard_referral'
      : null;
  if (wantsFirmPays && !(await firmHasPaymentMethod(enterpriseId))) {
    redirect(await createFirmBillingSetupSession(enterpriseId, '/enterprise/clients/new'));
  }

  const supabase = createServiceClient();
  const tempPassword = passwordMode === 'auto' ? generatePassword() : null;

  let authUserId: string;
  if (passwordMode === 'invite') {
    // Land the invite on the host the firm admin is using (their white-label
    // subdomain), not the fixed Supabase Site URL. For actual clients of a
    // private-label firm this sends a firm-branded welcome email; otherwise it
    // falls back to Supabase's standard invite.
    const invite = await inviteEnterpriseClient({
      supabase,
      email,
      fullName,
      redirectTo: await requestOrigin(),
      enterpriseId,
      brandEligible: !enterpriseOwner && !enterpriseStaffRole,
      clientType,
      usage: { userId: sessionUser.id, orgId: enterpriseId, actor: 'enterprise', feature: 'client-invite-email' },
      emailOverride: { handoff: clientOnboardingHandoff, config: importEmailConfig, bookingUrl: submittedBookingUrl },
    });
    if (invite.error || !invite.userId) throw new Error(`Auth invite failed: ${invite.error}`);
    authUserId = invite.userId;
  } else {
    const password = passwordMode === 'auto' ? tempPassword! : explicitPassword;
    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: fullName },
    });
    if (error) throw new Error(`Auth create failed: ${error.message}`);
    authUserId = data.user!.id;
  }

  const primaryRole = enterpriseOwner
    ? 'enterprise_owner'
    : enterpriseStaffRole
      ? 'enterprise_staff'
      : 'paying_user';

  // All DB writes in one transaction. If anything fails (FK violation,
  // unique-on-email race, FK to a permission set that just got deleted,
  // ...) we roll back the entire local state AND delete the Supabase
  // auth account in the catch so the user can re-try cleanly without an
  // orphan auth row blocking the email.
  let primaryOrgId: string | null = null;
  try {
    primaryOrgId = await db.transaction(async (tx) => {
      await tx.insert(users).values({
        id: authUserId,
        email,
        fullName,
        passwordHash: 'supabase',
        isActive: true,
        role: primaryRole,
      });

      if (permissionSetId) {
        await tx.insert(userPermissionSets).values({
          id: randomUUID(),
          userId: authUserId,
          permissionSetId,
        });
      }

      let orgIdLocal: string | null = null;

      if (enterpriseOwner) {
        await tx.insert(enterpriseStaff).values({
          id: randomUUID(),
          enterpriseId,
          staffUserId: authUserId,
          role: 'owner',
        });
        orgIdLocal = enterpriseId;
      }
      if (enterpriseStaffRole) {
        await tx.insert(enterpriseStaff).values({
          id: randomUUID(),
          enterpriseId,
          staffUserId: authUserId,
          role: 'staff',
        });
        if (!orgIdLocal) orgIdLocal = enterpriseId;
      }
      let clientOrgId: string | null = null;
      if (payingUser) {
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
        if (orgMode === 'now') {
          const orgId = randomUUID();
          clientOrgId = orgId;
          await tx.insert(organizations).values({
            id: orgId,
            name: companyName,
            ownerUserId: authUserId,
            planType: 'pro',
            entityType: toOrgEntityType(companyType),
          });
          // Seed onboarding (completed=false) so the "Finish setting up <company>"
          // card surfaces immediately — action-cards.ts requires a row; a fresh
          // org with none never shows it. 'business_info' is the first phase.
          await tx.insert(onboardingState).values({
            orgId,
            phase: 'business_info',
            step: 'business_info',
            context: {},
            completed: false,
          });
          await logAudit(sessionUser.id, 'organization.create', 'organization', orgId, {
            for: authUserId,
            name: companyName,
            enterpriseId,
          }, tx);
          orgIdLocal = orgId;

          // Demo orgs get a 7-day trialing subscription on the demo_full
          // product. Entitlement checks (canMirrorQbo, canWriteForDate)
          // will short-circuit on this row; after current_period_end the
          // row is still here but inactive, dropping the org to read-only.
          if (isDemoOwner) {
            const [demoProduct] = await tx
              .select({ id: billingProducts.id })
              .from(billingProducts)
              .where(eq(billingProducts.featureKey, 'demo_full'))
              .limit(1);
            if (!demoProduct) {
              throw new Error('Demo billing product missing. Run scripts/apply-demo-billing-product.ts');
            }
            const periodStart = new Date();
            const periodEnd = new Date(periodStart.getTime() + 7 * 24 * 60 * 60 * 1000);
            await tx.insert(organizationSubscriptions).values({
              id: randomUUID(),
              organizationId: orgId,
              billingProductId: demoProduct.id,
              stripeSubscriptionId: `demo_${randomUUID()}`,
              status: 'trialing',
              currentPeriodStart: periodStart.toISOString(),
              currentPeriodEnd: periodEnd.toISOString(),
            });
          }
        }
        // Seed the firm's Client Interaction defaults onto the new client
        // (per-org toggles when an org exists now; per-user weekly digest always).
        await applyFirmClientInteractionPrefs(tx, { enterpriseId, clientOrgId, ownerUserId: authUserId });
      }

      if (orgIdLocal) {
        await tx
          .update(users)
          .set({ organizationId: orgIdLocal, activeOrganizationId: orgIdLocal })
          .where(eq(users.id, authUserId));
      }

      await logAudit(sessionUser.id, 'enterprise.user.create', 'user', authUserId, {
        email,
        primaryRole,
        passwordMode,
        enterpriseId,
        primaryOrgId: orgIdLocal,
      }, tx);

      return orgIdLocal;
    });
  } catch (err) {
    // Roll back the Supabase auth account too -- otherwise re-trying with
    // the same email hits "user already exists" on Supabase forever even
    // though there's no local row.
    try {
      await supabase.auth.admin.deleteUser(authUserId);
    } catch (deleteErr) {
      console.error('Failed to roll back Supabase auth user', authUserId, deleteErr);
    }
    throw err;
  }

  // Apply the chosen accounting plan FIRST — stamps the client's org tier so the
  // firm-paid subscription (below) bills the tier's reduced price and revenue
  // share records the right amount. Assigns the matching permission set (or the
  // set directly when the org is created later). Non-fatal; skips when no tier.
  if (payingUser && accountingTier) {
    try {
      await setUserAccountingTier(authUserId, accountingTier);
    } catch (tierErr) {
      console.error('Failed to set accounting tier for client', authUserId, tierErr);
    }
  }

  // Stamp the revenue-share ledger row for client-pays. Firm-pays clients are NOT
  // subscribed per-client — the firm-billing cron invoices the firm monthly IN
  // ARREARS (one consolidated invoice on the 5th) for every client it covers.
  if (payingUser && perClientMode === 'firm_pays') {
    // No per-client sub; the arrears cron bills the firm.
  } else if (payingUser && orgMode === 'now' && primaryOrgId) {
    try {
      await recordInitialClientRevenueShare({
        enterpriseId,
        clientOrganizationId: primaryOrgId,
      });
    } catch (rsErr) {
      console.error('Failed to record initial revenue share for client', primaryOrgId, rsErr);
    }
  }

  // The dashboard's "Client Businesses" panel reads from organizations +
  // enterprise_clients, so when a paying-user-with-org is created it
  // needs a refresh too. Revalidate both.
  revalidatePath('/enterprise/clients');
  revalidatePath('/enterprise/dashboard');

  if (tempPassword) {
    redirect(`/enterprise/clients?created=${authUserId}&temp=${encodeURIComponent(tempPassword)}`);
  }
  redirect(`/enterprise/clients?created=${authUserId}&primaryOrgId=${primaryOrgId ?? ''}`);
}
